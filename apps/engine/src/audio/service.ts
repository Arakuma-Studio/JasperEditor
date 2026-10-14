// Audio analysis and loudness normalisation jobs (audio-mix).
// * `analysis` jobs (`POST /api/audio/analyze`): BS.1770-4 / R128 loudness, sample and true peak of a sequence, a
//   range, soloed tracks or single clips, rendered by the offline mixer (`renderMixdown`, the export's mixer), plus
//   the activity regions of the measured audio for auto-ducking.
// * `analysis` jobs too (`POST /api/media/:key/loudness-normalize`): a loudness-normalised version of a media's audio
//   stream (two-pass: measure, then gain + look-ahead true-peak limiter), written as a 24-bit WAV and registered as a
//   derived media (the client commits `media.derive {recipe: {op: 'loudness-normalize'}}`).
import { createHash } from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	AudioAnalyzeRequest,
	AudioAnalyzeResult,
	EngineJob,
	ExportSettings,
	LoudnessMeasure,
	LoudnessNormalizeRequest,
	LoudnessNormalizeResult,
} from '@jasper/api';
import {
	activeRegions,
	DUCK_BRIDGE_S,
	DUCK_HOP_S,
	DUCK_MIN_ON_S,
	DUCK_WINDOW_S,
	defaultChannelWeights,
	FLOOR_DB,
	LoudnessMeter,
	type LoudnessSummary,
	sensitivityThresholdDb,
	TruePeakLimiter,
} from '@jasper/audio-dsp';
import { type AudioStream, FLICKS_PER_SECOND, frameToSample, mixFingerprint } from '@jasper/project';
import { PlanError, type PlannedExport } from '../export/planner.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { CoreServices } from '../tools/services.ts';
import { hasSoxr, PcmStreamReader, resamplerArgs } from './decode.ts';
import { layoutOf, type MixdownResult, renderMixdown } from './mixdown.ts';
import { publishNormalizedAudio } from './publish.ts';

export const LOUDNESS_RECIPE_VERSION = 1;

/** A summary as the API's nullable measure. */
export function measureOf(s: LoudnessSummary, durationSec: number): LoudnessMeasure {
	const f = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
	return {
		integratedLufs: f(s.integrated),
		lra: f(s.lra),
		truePeakDbtp: f(s.truePeakDb),
		samplePeakDb: f(s.samplePeakDb),
		maxMomentaryLufs: f(s.maxMomentary),
		maxShortTermLufs: f(s.maxShortTerm),
		durationSec: Math.round(durationSec * 1000) / 1000,
	};
}

/**
 * Streaming activity envelope: per-sample channel-averaged power summed into 1 ms buckets; the RMS of hop `k` is the
 * mean power over the `windowS` window centred on `k · hopS` (bucket resolution), like `envelopeDb`.
 */
export class ActivityEnvelope {
	private readonly buckets: number[] = [];
	private readonly counts: number[] = [];
	private acc = 0;
	private n = 0;
	private readonly bucketLen: number;

	constructor(readonly sampleRate: number) {
		this.bucketLen = Math.max(1, Math.round(sampleRate / 1000));
	}

	push(planar: Float32Array[], frames: number): void {
		const nch = Math.max(1, planar.length);
		for (let i = 0; i < frames; i++) {
			let p = 0;
			for (const c of planar) p += c[i]! * c[i]!;
			this.acc += p / nch;
			if (++this.n === this.bucketLen) this.flush();
		}
	}

	private flush(): void {
		if (this.n === 0) return;
		this.buckets.push(this.acc);
		this.counts.push(this.n);
		this.acc = 0;
		this.n = 0;
	}

	/** Envelope in dBFS per hop (one value per `hopS` of audio). */
	envelope(hopS = DUCK_HOP_S, windowS = DUCK_WINDOW_S): Float32Array {
		this.flush();
		const B = this.buckets.length;
		const pre = new Float64Array(B + 1);
		const cnt = new Float64Array(B + 1);
		for (let i = 0; i < B; i++) {
			pre[i + 1] = pre[i]! + this.buckets[i]!;
			cnt[i + 1] = cnt[i]! + this.counts[i]!;
		}
		const hop = Math.max(1, Math.round(hopS * 1000));
		const half = Math.max(1, Math.round((windowS * 1000) / 2));
		const out = new Float32Array(Math.ceil(B / hop));
		for (let k = 0; k < out.length; k++) {
			const c = k * hop;
			const a = Math.max(0, c - half);
			const b = Math.min(B, c + half);
			const ms = (pre[b]! - pre[a]!) / Math.max(1, cnt[b]! - cnt[a]!);
			out[k] = ms <= 1e-12 ? FLOOR_DB : Math.max(FLOOR_DB, 10 * Math.log10(ms));
		}
		return out;
	}
}

export class AudioService {
	constructor(private readonly core: CoreServices) {}

	registerRunners(): void {
		// One runner for both: loudness normalisation jobs carry `loudnessNormalize` in their input.
		this.core.queue.registerRunner('analysis', (ctx) =>
			(ctx.input as { loudnessNormalize?: unknown }).loudnessNormalize
				? this.runNormalize(ctx)
				: this.runAnalysis(ctx),
		);
	}

	/** Validates by planning (synchronous errors) and submits the job. */
	async submitAnalysis(
		req: AudioAnalyzeRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		await this.plan(req); // PlanErrors surface synchronously
		const doc = req.envelope.document as { projectId?: string };
		const projectId = req.projectId ?? (typeof doc.projectId === 'string' ? doc.projectId : undefined);
		return this.core.queue.submit({
			kind: 'analysis',
			title: `Analyze audio – ${req.scope.type}`,
			priority: 'interactive',
			cpuSlots: 1,
			minSlots: 1,
			origin,
			...(projectId ? { projectId } : {}),
			input: { request: req },
		});
	}

	private async plan(req: AudioAnalyzeRequest): Promise<PlannedExport> {
		const doc = req.envelope.document as {
			sequences?: Record<
				string,
				{ inPoint: number | null; outPoint: number | null; clips: Record<string, unknown> }
			>;
		};
		const seq = doc.sequences?.[req.sequenceId];
		if (!seq) throw new PlanError('NOT_FOUND', 404, `Sequence ${req.sequenceId} not found`);
		let range: ExportSettings['range'] = { type: 'entire' };
		const s = req.scope;
		if (s.type === 'range') {
			if (s.inOut) range = { type: 'in-out' };
			else if (s.startFrame !== undefined || s.endFrame !== undefined) {
				let end = 0;
				for (const c of Object.values(seq.clips) as { start: number; duration: number }[])
					end = Math.max(end, c.start + c.duration);
				range = { type: 'custom', startFrame: s.startFrame ?? 0, endFrame: s.endFrame ?? end };
			}
		}
		if (req.activity?.startFrame !== undefined && req.activity.endFrame !== undefined && s.type !== 'range')
			range = { type: 'custom', startFrame: req.activity.startFrame, endFrame: req.activity.endFrame };
		return this.core.exports.plan({
			envelope: req.envelope as never,
			sequenceId: req.sequenceId,
			settings: {
				sequenceId: req.sequenceId,
				range,
				container: 'mp4',
				engine: 'auto',
				destination: { type: 'download' },
			},
		});
	}

	private media(planned: PlannedExport) {
		return (id: string) => {
			const m = planned.media[id];
			if (!m) return null;
			return {
				path: m.path,
				streams: m.record.probe.streams.filter((x) => x.type === 'audio') as AudioStream[],
			};
		};
	}

	private async runAnalysis(ctx: JobContext): Promise<AudioAnalyzeResult> {
		const req = (ctx.input as { request: AudioAnalyzeRequest }).request;
		let planned: PlannedExport;
		try {
			planned = await this.plan(req);
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
		const snap = planned.snapshot;
		const sr = snap.audioMix?.sampleRate ?? 48000;
		const fps = snap.settings.fps;
		const scratch = await ctx.scratchDir();
		const scope = req.scope;
		const base = {
			ff: this.core.ffmpeg,
			snapshot: snap,
			media: this.media(planned),
			scratchDir: scratch,
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			measureOnly: true,
			withoutLoudness: true,
		};
		const env = req.activity ? new ActivityEnvelope(sr) : null;
		let range = planned.range;
		let mix: MixdownResult;
		const clips: Record<string, LoudnessMeasure> = {};
		if (scope.type === 'clips') {
			const wanted = new Set(scope.clipIds);
			const found = snap.audioClips.filter((c) => wanted.has(c.clipId));
			const missing = scope.clipIds.filter((id) => !found.some((c) => c.clipId === id));
			if (missing.length)
				throw new JobError(
					'NOT_FOUND',
					`Not audible audio clips of the sequence: ${missing.join(', ')}`,
					false,
				);
			const levels = req.levels ?? 'mix';
			for (const [i, c] of found.entries()) {
				ctx.progress(i / (found.length + 1), { stage: `Measuring clip ${i + 1}/${found.length}` });
				const r = await renderMixdown({
					...base,
					range: { start: c.start, end: c.start + c.duration },
					onlyClips: new Set([c.clipId]),
					clipLevels: levels,
					tap: 'track-inputs',
				});
				clips[c.clipId] = measureOf(r.loudness, r.samples / sr);
			}
			// The clips together (activity triggers), over the activity window or their union.
			const start = req.activity?.startFrame ?? Math.min(...found.map((c) => c.start));
			const end = req.activity?.endFrame ?? Math.max(...found.map((c) => c.start + c.duration));
			range = { start, end: Math.max(start + 1, end) };
			ctx.progress(found.length / (found.length + 1), { stage: 'Measuring the clips together' });
			mix = await renderMixdown({
				...base,
				range,
				onlyClips: wanted,
				clipLevels: levels,
				tap: 'track-inputs',
				...(env ? { onBlock: (p: Float32Array[], n: number) => env.push(p, n) } : {}),
			});
		} else {
			if (
				req.activity?.startFrame !== undefined &&
				req.activity.endFrame !== undefined &&
				scope.type !== 'range'
			)
				range = { start: req.activity.startFrame, end: req.activity.endFrame };
			mix = await renderMixdown({
				...base,
				range,
				...(scope.type === 'tracks' ? { onlyTracks: new Set(this.trackIds(planned, scope.trackIds)) } : {}),
				...(env ? { onBlock: (p: Float32Array[], n: number) => env.push(p, n) } : {}),
				onProgress: (f, stage) => ctx.progress(f * 0.95, { stage }),
			});
		}
		let activity: AudioAnalyzeResult['activity'];
		if (env && req.activity) {
			const thresholdDb = sensitivityThresholdDb(req.activity.sensitivity);
			const rel = activeRegions(
				env.envelope(),
				DUCK_HOP_S,
				thresholdDb,
				(req.activity.bridgeMs ?? DUCK_BRIDGE_S * 1000) / 1000,
				(req.activity.minOnMs ?? DUCK_MIN_ON_S * 1000) / 1000,
			);
			const t0 = (frameToSample(range.start, fps, sr) / sr) * FLICKS_PER_SECOND;
			activity = {
				thresholdDb,
				regions: rel.map(([a, b]) => [
					Math.round(t0 + a * FLICKS_PER_SECOND),
					Math.round(t0 + b * FLICKS_PER_SECOND),
				]),
			};
		}
		return {
			sampleRate: sr,
			range: { startFrame: range.start, endFrame: range.end },
			loudness: measureOf(mix.loudness, mix.samples / sr),
			...(scope.type === 'clips' ? { clips } : {}),
			...(activity ? { activity } : {}),
			mixHash: mixFingerprint(planned.document, planned.sequenceId),
		};
	}

	private trackIds(planned: PlannedExport, refs: string[]): string[] {
		const seq = planned.document.sequences[planned.sequenceId]!;
		return refs.map((r) => {
			const m = /^A(\d+)$/i.exec(r);
			const id = m ? seq.audioTracks[Number(m[1]) - 1]?.id : seq.audioTracks.find((t) => t.id === r)?.id;
			if (!id) throw new JobError('NOT_FOUND', `Audio track not found: ${r}`, false);
			return id;
		});
	}

	submitNormalize(mediaKey: string, req: LoudnessNormalizeRequest): EngineJob {
		const record = this.core.registry.get(mediaKey);
		if (!record) throw new JobError('ASSET_NOT_FOUND', 'Unknown media key', false);
		const streams = record.probe.streams.filter((s) => s.type === 'audio');
		const stream =
			req.streamIndex !== undefined ? streams.find((s) => s.index === req.streamIndex) : streams[0];
		if (!stream) throw new JobError('NO_AUDIO', 'The media has no such audio stream', false);
		return this.core.queue.submit({
			kind: 'analysis',
			title: `Normalize loudness – ${record.originalName}`,
			priority: 'user',
			cpuSlots: 1,
			minSlots: 1,
			origin: { type: 'user' },
			...(req.projectId ? { projectId: req.projectId } : {}),
			input: { loudnessNormalize: { mediaKey, req: { ...req, streamIndex: stream.index } } },
		});
	}

	/** Runs a normalisation job created by `submitNormalize`. */
	async runNormalize(ctx: JobContext): Promise<LoudnessNormalizeResult> {
		const { mediaKey, req } = (
			ctx.input as { loudnessNormalize: { mediaKey: string; req: LoudnessNormalizeRequest } }
		).loudnessNormalize;
		const record = this.core.registry.get(mediaKey);
		const path = record ? await this.core.registry.resolvePath(mediaKey) : null;
		if (!record || !path) throw new JobError('ASSET_NOT_FOUND', 'The media is offline', false);
		const stream = record.probe.streams.find((s) => s.type === 'audio' && s.index === req.streamIndex) as
			| AudioStream
			| undefined;
		if (!stream) throw new JobError('NO_AUDIO', 'The media has no such audio stream', false);
		const sr = Math.max(8000, Math.min(192_000, stream.sampleRate || 48000));
		const channels = stream.channels === 1 || stream.channels === 6 ? stream.channels : 2;
		const recipe = {
			op: 'loudness-normalize',
			targetLufs: req.targetLufs,
			truePeakDb: req.truePeakDb,
			stream: stream.index,
		};
		const recipeHash = createHash('sha256')
			.update(JSON.stringify({ v: LOUDNESS_RECIPE_VERSION, recipe }))
			.digest('hex')
			.slice(0, 16);
		const decode = () =>
			this.core.ffmpeg.spawnRaw(
				[
					'-i',
					path,
					'-map',
					`0:${stream.index}`,
					'-ac',
					String(channels),
					'-ar',
					String(sr),
					'-f',
					'f32le',
					'pipe:1',
				],
				{ signal: ctx.signal, onSpawn: ctx.trackChild },
			);
		const BLOCK = 65536;
		const buf = Array.from({ length: channels }, () => new Float32Array(BLOCK));
		// pass 1: measure
		ctx.progress(0, { stage: 'Measuring loudness' });
		const m1 = new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
		let total = 0;
		{
			const r = new PcmStreamReader(channels, decode());
			for (;;) {
				const n = await r.read(buf, BLOCK);
				if (n <= 0) break;
				m1.process(buf, 0, n);
				total += n;
			}
			r.close();
		}
		const before = m1.summary();
		if (!Number.isFinite(before.integrated)) {
			// BS.1770 integrated loudness needs at least one complete 400 ms gating block: shorter audio is not "silent".
			if (total < Math.round(sr * 0.4))
				throw new JobError(
					'TOO_SHORT',
					`The audio is ${Math.round((total / sr) * 1000)} ms long: integrated loudness (BS.1770) needs at least 400 ms`,
					false,
					{
						durationSec: total / sr,
						truePeakDbtp: Number.isFinite(before.truePeakDb) ? before.truePeakDb : null,
					},
				);
			throw new JobError(
				'SILENT',
				'The audio is silent (below the −70 LUFS gate): nothing to normalise',
				false,
			);
		}
		const gainDb = req.targetLufs - before.integrated;
		const g = 10 ** (gainDb / 20);
		// pass 2: gain + true-peak limiter → 24-bit WAV (via ffmpeg from a float WAV)
		ctx.progress(0.5, { stage: 'Normalizing loudness' });
		const scratch = await ctx.scratchDir();
		const tmp = join(scratch, 'normalized.f32.wav');
		const { wavHeaderF32 } = await import('./mixdown.ts');
		const fh = await open(tmp, 'w');
		const lim = new TruePeakLimiter(sr, channels, {
			ceilingDb: req.truePeakDb,
			lookaheadMs: 5,
			releaseMs: 100,
		});
		const m2 = new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
		let written = 0;
		let skip = lim.latency;
		const emit = async (n: number) => {
			lim.process(buf, 0, n);
			const from = Math.min(n, skip);
			skip -= from;
			const m = Math.min(n - from, total - written);
			if (m <= 0) return;
			const view = buf.map((c) => c.subarray(from, from + m));
			m2.process(view, 0, m);
			const out = Buffer.alloc(m * channels * 4);
			for (let i = 0; i < m; i++)
				for (let c = 0; c < channels; c++) out.writeFloatLE(view[c]![i]!, (i * channels + c) * 4);
			await fh.write(out);
			written += m;
		};
		try {
			await fh.write(wavHeaderF32(channels, sr, total));
			const r = new PcmStreamReader(channels, decode());
			for (;;) {
				const n = await r.read(buf, BLOCK);
				if (n <= 0) break;
				for (const c of buf) for (let i = 0; i < n; i++) c[i]! *= g;
				await emit(n);
				ctx.progress(0.5 + 0.4 * (written / Math.max(1, total)), { stage: 'Normalizing loudness' });
			}
			r.close();
			while (written < total) {
				const n = Math.min(BLOCK, lim.latency + 1);
				for (const c of buf) c.fill(0, 0, n);
				await emit(n);
			}
		} finally {
			await fh.close();
		}
		const after = m2.summary();
		const outDir = join(
			this.core.config.paths.root,
			'media',
			'processed',
			record.fingerprint.replace(/[^\w-]/g, '_'),
			recipeHash,
		);
		await mkdir(outDir, { recursive: true });
		const name = `${(record.originalName || 'audio').replace(/\.[^.]+$/, '')} [Normalized ${req.targetLufs} LUFS].wav`;
		const finalTmp = join(scratch, 'normalized.wav');
		await this.core.ffmpeg.run(['-i', tmp, '-c:a', 'pcm_s24le', '-f', 'wav', finalTmp], {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
		});
		const final = join(outDir, name.replace(/[/\\:*?"<>|]/g, '_'));
		await publishNormalizedAudio(finalTmp, final);
		await rm(tmp, { force: true });
		await stat(final);
		const registered = await this.core.media.registerDerived(final, {
			fromMediaKey: mediaKey,
			recipeHash,
			name,
			...(req.projectId ? { projectId: req.projectId } : {}),
		});
		ctx.progress(1, { stage: 'Done' });
		return {
			registered,
			fromMediaKey: mediaKey,
			recipeVersion: LOUDNESS_RECIPE_VERSION,
			recipeHash,
			streamIndex: stream.index,
			before: measureOf(before, total / sr),
			after: measureOf(after, total / sr),
			gainDb: Math.round(gainDb * 1000) / 1000,
		};
	}
}

export { hasSoxr, layoutOf, resamplerArgs };

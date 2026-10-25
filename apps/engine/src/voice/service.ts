// Voice analysis of a media's audio stream (spec 14 TC-001; docs/wp-notes/transcript-cleanup.md "Voice analysis"): the
// `voice-analysis` job decodes the stream with the engine's FFmpeg from its first sample (no seek: sample n of the
// decode is sample n of the stream, the transcripts' timeline) to 16 kHz mono float, streams it in 10 s blocks to
// worker threads (pool.ts) that compute the 10 ms frame features, then classifies the frames against the whole
// stream's levels (`buildVoiceAnalysis` of @jasper/project) and caches the result as a media derivative:
// `<cache>/<fingerprint>/voice-analysis-<hash>.bin`, the hash covering the analysis version and the stream, written
// atomically. A job whose analysis exists finishes at once without decoding. Reads validate the whole file
// (`decodeVoiceAnalysis`); a damaged or foreign file is a miss that the next job overwrites.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineJob, VoiceAnalysisJobResult } from '@jasper/api';
import {
	VOICE_HOP,
	VOICE_SAMPLE_RATE,
	VOICE_WINDOW_LEAD,
	VOICE_WINDOW_TAIL,
	voiceFrameCount,
} from '@jasper/audio-dsp';
import {
	buildVoiceAnalysis,
	decodeVoiceAnalysis,
	encodeVoiceAnalysis,
	summarizeVoiceAnalysis,
	VOICE_ANALYSIS_MAX_FILE_BYTES,
	VOICE_ANALYSIS_MAX_FRAMES,
	VOICE_ANALYSIS_VERSION,
	type VoiceAnalysis,
} from '@jasper/project';
import { hasSoxr, PcmStreamReader, resamplerArgs } from '../audio/decode.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { fingerprintHex } from '../media/fingerprint.ts';
import type { MediaRecord } from '../media/registry.ts';
import { atomicWriteFile } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { type FeatureBlock, resolveVoiceWorker, VoiceFeatureRunner } from './pool.ts';

/** Frames per block handed to a worker (10 s). */
export const VOICE_BLOCK_FRAMES = 1000;
/** Worker threads per job (at most; the job's CPU slots decide): 2 analyse an hour in ≈ 9 s on the build VM. */
const MAX_THREADS = 2;

type VoiceJobInput = { mediaKey: string; streamIndex: number };

type Core = Pick<CoreServices, 'queue' | 'ffmpeg' | 'registry'>;

export class VoiceAnalysisService {
	private readonly workerUrl: URL | null;

	constructor(
		private readonly core: Core,
		private readonly cacheDir: string,
		opts: { workerUrl?: URL | null; log?: (m: string) => void } = {},
	) {
		this.workerUrl = opts.workerUrl === undefined ? resolveVoiceWorker(process.env) : opts.workerUrl;
		this.log = opts.log ?? (() => {});
	}

	private readonly log: (m: string) => void;

	registerRunner(): void {
		this.core.queue.registerRunner('voice-analysis', (ctx) => this.run(ctx));
	}

	/** The media and its audio stream (default: the first audio stream); HTTP errors for the routes. */
	target(mediaKey: string, streamIndex?: number): { rec: MediaRecord; streamIndex: number } {
		const rec = this.core.registry.get(mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
		const audio = rec.probe.streams.filter((s) => s.type === 'audio');
		if (audio.length === 0)
			throw new HttpError(422, 'UNSUPPORTED_MEDIA', `${rec.originalName} has no audio stream`);
		if (streamIndex === undefined) return { rec, streamIndex: audio[0]!.index };
		if (!audio.some((s) => s.index === streamIndex))
			throw new HttpError(
				400,
				'VALIDATION_FAILED',
				`Stream ${streamIndex} of ${rec.originalName} is not an audio stream (audio streams: ${audio.map((s) => s.index).join(', ')})`,
			);
		return { rec, streamIndex };
	}

	/** The cache file of a stream's analysis. */
	path(rec: Pick<MediaRecord, 'fingerprint'>, streamIndex: number): string {
		const hash = createHash('sha256')
			.update(
				JSON.stringify({
					kind: 'voice-analysis',
					v: VOICE_ANALYSIS_VERSION,
					stream: streamIndex,
					rate: VOICE_SAMPLE_RATE,
				}),
			)
			.digest('hex')
			.slice(0, 12);
		return join(this.cacheDir, fingerprintHex(rec.fingerprint), `voice-analysis-${hash}.bin`);
	}

	/** The cached analysis file (validated), or null. Never throws for a missing or damaged file. */
	async readBytes(rec: MediaRecord, streamIndex: number): Promise<Uint8Array | null> {
		const file = this.path(rec, streamIndex);
		let bytes: Uint8Array;
		try {
			const st = await stat(file);
			if (!st.isFile() || st.size > VOICE_ANALYSIS_MAX_FILE_BYTES) return null;
			bytes = new Uint8Array(await readFile(file));
		} catch {
			return null;
		}
		const r = decodeVoiceAnalysis(bytes, {
			fingerprint: rec.fingerprint,
			stream: streamIndex,
			analysisVersion: VOICE_ANALYSIS_VERSION,
		});
		if (!r.ok) {
			this.log(`voice analysis: ignoring ${file}: ${r.error}`);
			return null;
		}
		return bytes;
	}

	async read(rec: MediaRecord, streamIndex: number): Promise<VoiceAnalysis | null> {
		const bytes = await this.readBytes(rec, streamIndex);
		if (!bytes) return null;
		const r = decodeVoiceAnalysis(bytes);
		return r.ok ? r.analysis : null;
	}

	url(mediaKey: string, streamIndex: number): string {
		return `/api/media/${encodeURIComponent(mediaKey)}/voice-analysis?streamIndex=${streamIndex}`;
	}

	submit(
		mediaKey: string,
		req: { streamIndex?: number; projectId?: string },
		origin?: EngineJob['origin'],
	): EngineJob {
		const { rec, streamIndex } = this.target(mediaKey, req.streamIndex);
		return this.core.queue.submit({
			kind: 'voice-analysis',
			title: `Voice analysis – ${rec.originalName}`,
			priority: 'user',
			cpuSlots: MAX_THREADS,
			minSlots: 1,
			...(origin ? { origin } : {}),
			assetId: rec.mediaKey,
			...(req.projectId ? { projectId: req.projectId } : {}),
			dedupeKey: `voice-analysis:${fingerprintHex(rec.fingerprint)}:${streamIndex}`,
			input: { mediaKey: rec.mediaKey, streamIndex } satisfies VoiceJobInput,
			stage: 'Waiting',
		});
	}

	private resultOf(
		rec: MediaRecord,
		a: VoiceAnalysis,
		bytes: number,
		cached: boolean,
		elapsedMs: number,
	): VoiceAnalysisJobResult {
		const s = summarizeVoiceAnalysis(a);
		return {
			mediaKey: rec.mediaKey,
			streamIndex: a.stream,
			analysisVersion: a.analysisVersion,
			cached,
			frameCount: a.frameCount,
			durationSeconds: s.durationSeconds,
			floorDb: a.levels.floorDb,
			speechDb: a.levels.speechDb,
			speechThresholdDb: a.levels.speechThresholdDb,
			seconds: s.seconds,
			bytes,
			url: this.url(rec.mediaKey, a.stream),
			elapsedMs,
		};
	}

	private async run(ctx: JobContext): Promise<VoiceAnalysisJobResult> {
		const input = ctx.input as Partial<VoiceJobInput> | null;
		if (!input || typeof input.mediaKey !== 'string' || !Number.isSafeInteger(input.streamIndex))
			throw new JobError('INVALID_SPEC', 'Invalid voice analysis job input', false);
		const rec = this.core.registry.get(input.mediaKey);
		if (!rec) throw new JobError('ASSET_NOT_FOUND', `Unknown media ${input.mediaKey}`, false);
		const streamIndex = input.streamIndex!;
		const cachedBytes = await this.readBytes(rec, streamIndex);
		if (cachedBytes) {
			const r = decodeVoiceAnalysis(cachedBytes);
			if (r.ok) return this.resultOf(rec, r.analysis, cachedBytes.length, true, 0);
		}
		const src = await this.core.registry.resolvePath(rec.mediaKey);
		if (!src) throw new JobError('ASSET_NOT_FOUND', `Media ${rec.originalName} is offline`, true);
		const started = Date.now();
		const analysis = await this.analyze(ctx, rec, src, streamIndex);
		ctx.progress(null, { stage: 'Saving' });
		const bytes = encodeVoiceAnalysis(analysis);
		await atomicWriteFile(this.path(rec, streamIndex), bytes);
		const elapsedMs = Date.now() - started;
		ctx.log(
			`voice-analysis: ${analysis.frameCount} frames (${(analysis.samples / VOICE_SAMPLE_RATE).toFixed(1)} s) in ${(elapsedMs / 1000).toFixed(1)} s`,
		);
		return this.resultOf(rec, analysis, bytes.length, false, elapsedMs);
	}

	/** Decodes and analyses one stream (the job's work; exported behaviour is `run`). */
	private async analyze(
		ctx: JobContext,
		rec: MediaRecord,
		src: string,
		streamIndex: number,
	): Promise<VoiceAnalysis> {
		const cancelled = () => new JobError('JOB_CANCELLED', 'Voice analysis cancelled');
		const threads = Math.max(1, Math.min(MAX_THREADS, ctx.slots));
		const runner = new VoiceFeatureRunner(this.workerUrl, threads, (m) => {
			ctx.log(m);
			this.log(m);
		});
		const soxr = await hasSoxr(this.core.ffmpeg);
		const args = [
			'-i',
			src,
			...['-map', `0:${streamIndex}`, '-vn', '-sn', '-dn'],
			...['-af', `aresample=${VOICE_SAMPLE_RATE}:${resamplerArgs(soxr)}`],
			...['-ac', '1', '-f', 'f32le', 'pipe:1'],
		];
		ctx.log(`voice-analysis: ffmpeg ${args.join(' ')}`);
		ctx.progress(0, { stage: 'Analysing voice' });
		const child = this.core.ffmpeg.spawnRaw(args, { signal: ctx.signal });
		ctx.trackChild(child);
		const reader = new PcmStreamReader(1, child);
		const t0 = Date.now();
		const expected = Math.max(1, Math.round((rec.durationSec ?? 0) * VOICE_SAMPLE_RATE));
		const maxSamples = VOICE_ANALYSIS_MAX_FRAMES * VOICE_HOP;
		// output planes, grown as frames arrive
		let cap = Math.min(VOICE_ANALYSIS_MAX_FRAMES, voiceFrameCount(expected) + VOICE_BLOCK_FRAMES);
		let planes = { level: new Uint8Array(cap), voicing: new Uint8Array(cap), flatness: new Uint8Array(cap) };
		const ensure = (frames: number) => {
			if (frames <= cap) return;
			const next = Math.min(VOICE_ANALYSIS_MAX_FRAMES, Math.max(frames, cap * 2));
			const grow = (p: Uint8Array) => {
				const q = new Uint8Array(next);
				q.set(p);
				return q;
			};
			planes = { level: grow(planes.level), voicing: grow(planes.voicing), flatness: grow(planes.flatness) };
			cap = next;
		};
		// decoded samples not yet handed out: [tailStart, tailStart + tail.length)
		let tail = new Float32Array(0);
		let tailStart = 0;
		let decoded = 0;
		let nextFrame = 0;
		const inflight: Promise<void>[] = [];
		const dispatch = async (firstFrame: number, count: number) => {
			const s0 = Math.max(0, firstFrame * VOICE_HOP - VOICE_WINDOW_LEAD);
			const s1 = Math.min(decoded, (firstFrame + count) * VOICE_HOP + VOICE_WINDOW_TAIL);
			const block: FeatureBlock = {
				signal: tail.slice(s0 - tailStart, s1 - tailStart),
				signalStart: s0,
				firstFrame,
				count,
			};
			const p = runner.run(block).then((r) => {
				ensure(firstFrame + count);
				planes.level.set(r.level, firstFrame);
				planes.voicing.set(r.voicing, firstFrame);
				planes.flatness.set(r.flatness, firstFrame);
			});
			// handled at once (a rejection is awaited below; never an unhandled one)
			p.catch(() => {});
			inflight.push(p);
			while (inflight.length >= 2 * threads) await inflight.shift();
		};
		const READ = VOICE_BLOCK_FRAMES * VOICE_HOP;
		const buf = [new Float32Array(READ)];
		try {
			for (;;) {
				if (ctx.signal.aborted) throw cancelled();
				const got = await reader.read(buf, READ);
				if (got === 0) break;
				decoded += got;
				if (decoded > maxSamples)
					throw new JobError(
						'VOICE_ANALYSIS_TOO_LONG',
						`The audio is longer than ${VOICE_ANALYSIS_MAX_FRAMES / 360_000} hours`,
						false,
					);
				const joined = new Float32Array(tail.length + got);
				joined.set(tail);
				joined.set(buf[0]!.subarray(0, got), tail.length);
				tail = joined;
				while ((nextFrame + VOICE_BLOCK_FRAMES) * VOICE_HOP + VOICE_WINDOW_TAIL <= decoded) {
					await dispatch(nextFrame, VOICE_BLOCK_FRAMES);
					nextFrame += VOICE_BLOCK_FRAMES;
					const keepFrom = Math.max(0, nextFrame * VOICE_HOP - VOICE_WINDOW_LEAD);
					if (keepFrom > tailStart) {
						tail = tail.slice(keepFrom - tailStart);
						tailStart = keepFrom;
					}
				}
				const elapsed = Math.max(1e-3, (Date.now() - t0) / 1000);
				ctx.progress(rec.durationSec ? Math.min(0.99, decoded / expected) : null, {
					stage: 'Analysing voice',
					// × real time
					speed: Math.round((decoded / VOICE_SAMPLE_RATE / elapsed) * 10) / 10,
				});
			}
			if (ctx.signal.aborted) throw cancelled();
			const frameCount = voiceFrameCount(decoded);
			if (nextFrame < frameCount) await dispatch(nextFrame, frameCount - nextFrame);
			for (const p of inflight.splice(0)) await p;
			if (ctx.signal.aborted) throw cancelled();
			return buildVoiceAnalysis({
				fingerprint: rec.fingerprint,
				stream: streamIndex,
				samples: decoded,
				planes: {
					level: planes.level.subarray(0, frameCount),
					voicing: planes.voicing.subarray(0, frameCount),
					flatness: planes.flatness.subarray(0, frameCount),
				},
			});
		} catch (e) {
			if (ctx.signal.aborted) throw cancelled();
			throw e;
		} finally {
			reader.close();
			await runner.close();
		}
	}
}

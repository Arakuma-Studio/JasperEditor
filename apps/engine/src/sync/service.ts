// Audio sync service (wp-multicam): decodes the recordings with ffmpeg and runs the two-pass GCC-PHAT of
// gcc-phat.ts. Memory stays small for long recordings: the coarse pass runs on an 8 kHz mono decode (ffmpeg's
// windowed-sinc resampler is the anti-alias low-pass of the decimation; gcc-phat decimates further for recordings
// that would exceed the 4 M-point transform), and the fine pass decodes only the two full-rate windows it needs
// (≤ 2.7 s each at 48 kHz) around the coarse lag, chosen as the loudest stretch both recordings share.
import type { ChildProcess } from 'node:child_process';
import type { SyncAudioClip, SyncAudioRequest, SyncAudioResponse, SyncAudioResult } from '@jasper/api';
import {
	coarseOffset,
	isReliable,
	loudestCommonWindow,
	refineMargin,
	refineOffset,
	SYNC_DEFAULTS,
} from '@jasper/audio-dsp';
import { FLICKS_PER_SECOND } from '@jasper/project';
import type { MediaRegistry } from '../media/registry.ts';
import { HttpError } from '../tools/reply.ts';

export const ANALYSIS_RATE = 48_000;
export const COARSE_RATE = 8_000;
/** Longest stretch of a recording analysed (from its start), as FilmCraft. */
export const MAX_ANALYSIS_SECONDS = 30 * 60;

type Spawner = { spawnRaw(args: readonly string[], opts?: { signal?: AbortSignal }): ChildProcess };

/** Collects a child's f32le stdout into one Float32Array. */
export function readF32(child: ChildProcess, signal?: AbortSignal): Promise<Float32Array> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let stderr = '';
		child.stdout!.on('data', (c: Buffer) => chunks.push(c));
		child.stderr?.setEncoding('utf8').on('data', (c: string) => {
			stderr = (stderr + c).slice(-4000);
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }));
			if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
			const buf = Buffer.concat(chunks);
			const n = Math.floor(buf.length / 4);
			const out = new Float32Array(n);
			for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
			resolve(out);
		});
	});
}

/** Mono f32 decode of `[startSec, startSec + durSec)` of one audio stream at `rate`. */
export function decodeMono(
	ff: Spawner,
	path: string,
	opts: { streamIndex?: number; startSec: number; durSec: number; rate: number; signal?: AbortSignal },
): Promise<Float32Array> {
	const map = opts.streamIndex !== undefined ? `0:${opts.streamIndex}` : '0:a:0';
	const child = ff.spawnRaw(
		[
			...(opts.startSec > 0 ? ['-ss', opts.startSec.toFixed(6)] : []),
			'-t',
			Math.max(0.001, opts.durSec).toFixed(6),
			'-i',
			path,
			'-map',
			map,
			'-vn',
			'-ac',
			'1',
			'-ar',
			String(opts.rate),
			'-f',
			'f32le',
			'pipe:1',
		],
		{ ...(opts.signal ? { signal: opts.signal } : {}) },
	);
	return readF32(child, opts.signal);
}

type Prepared = {
	clip: SyncAudioClip;
	path: string;
	startSec: number;
	durSec: number;
	coarse: Float32Array;
};

export class SyncService {
	private busy = 0;
	constructor(private readonly deps: { ffmpeg: Spawner; registry: MediaRegistry; maxConcurrent?: number }) {}

	private async prepare(c: SyncAudioClip, signal?: AbortSignal): Promise<Prepared> {
		const rec = this.deps.registry.get(c.mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${c.mediaKey}`);
		const audio = rec.probe.streams.filter((s) => s.type === 'audio');
		if (audio.length === 0) throw new HttpError(415, 'UNSUPPORTED_MEDIA', `${rec.originalName} has no audio`);
		if (c.streamIndex !== undefined && !audio.some((s) => s.index === c.streamIndex))
			throw new HttpError(
				400,
				'VALIDATION_FAILED',
				`${rec.originalName} has no audio stream ${c.streamIndex}`,
			);
		const path = await this.deps.registry.resolvePath(c.mediaKey);
		if (!path) throw new HttpError(409, 'MEDIA_OFFLINE', `${rec.originalName} is offline`);
		const mediaSec = rec.probe.durationFlicks !== null ? rec.probe.durationFlicks / FLICKS_PER_SECOND : null;
		const startSec = (c.startFlicks ?? 0) / FLICKS_PER_SECOND;
		let durSec =
			c.durationFlicks !== undefined
				? c.durationFlicks / FLICKS_PER_SECOND
				: (mediaSec ?? MAX_ANALYSIS_SECONDS) - startSec;
		if (mediaSec !== null) durSec = Math.min(durSec, mediaSec - startSec);
		durSec = Math.min(durSec, MAX_ANALYSIS_SECONDS);
		if (!(durSec > 0))
			throw new HttpError(
				400,
				'VALIDATION_FAILED',
				`${rec.originalName}: nothing to analyse after the start`,
			);
		const coarse = await decodeMono(this.deps.ffmpeg, path, {
			...(c.streamIndex !== undefined ? { streamIndex: c.streamIndex } : {}),
			startSec,
			durSec,
			rate: COARSE_RATE,
			...(signal ? { signal } : {}),
		});
		return { clip: c, path, startSec, durSec, coarse };
	}

	private window(
		p: Prepared,
		startSample: number,
		length: number,
		signal?: AbortSignal,
	): Promise<Float32Array> {
		// Samples outside the analysed stretch read as silence.
		const total = Math.floor(p.durSec * ANALYSIS_RATE);
		const a = Math.max(0, startSample);
		const b = Math.min(total, startSample + length);
		const out = new Float32Array(length);
		if (b <= a) return Promise.resolve(out);
		return decodeMono(this.deps.ffmpeg, p.path, {
			...(p.clip.streamIndex !== undefined ? { streamIndex: p.clip.streamIndex } : {}),
			startSec: p.startSec + a / ANALYSIS_RATE,
			durSec: (b - a) / ANALYSIS_RATE,
			rate: ANALYSIS_RATE,
			...(signal ? { signal } : {}),
		}).then((x) => {
			out.set(x.subarray(0, Math.min(x.length, b - a)), a - startSample);
			return out;
		});
	}

	/** One clip against the reference. */
	private async match(
		ref: Prepared,
		p: Prepared,
		maxLagSec: number | undefined,
		signal?: AbortSignal,
	): Promise<SyncAudioResult> {
		const fail = (error: string): SyncAudioResult => ({
			key: p.clip.key,
			offsetFlicks: 0,
			lagSamples: 0,
			lagFine: 0,
			confidence: null,
			distinct: null,
			reliable: false,
			inverted: false,
			error,
		});
		const k = ANALYSIS_RATE / COARSE_RATE;
		const c = coarseOffset(ref.coarse, p.coarse, COARSE_RATE, {
			...(maxLagSec !== undefined ? { maxLag: Math.round(maxLagSec * COARSE_RATE) } : {}),
		});
		if (!c) return fail('no common audio (silent, too short, or no overlap)');
		const factor = c.factor * k;
		const coarse = c.lag * k;
		const margin = refineMargin(factor);
		const la = Math.floor(ref.durSec * ANALYSIS_RATE);
		const lb = Math.floor(p.durSec * ANALYSIS_RATE);
		const ov0 = Math.max(-coarse, 0);
		const ov1 = Math.min(lb, la - coarse);
		let lag = coarse;
		let frac = 0;
		if (ov1 - ov0 >= 16) {
			const w = Math.min(ov1 - ov0, SYNC_DEFAULTS.refineWindow);
			const w8 = Math.max(1, Math.ceil(w / k));
			const start8 = loudestCommonWindow(ref.coarse, p.coarse, c.lag, Math.min(w8, p.coarse.length));
			const start = Math.max(ov0, Math.min(ov1 - w, start8 * k));
			const [aw, bw] = await Promise.all([
				this.window(ref, start + coarse - margin, w + 2 * margin, signal),
				this.window(p, start, w, signal),
			]);
			const r = refineOffset(aw, bw, margin, ANALYSIS_RATE, c.inverted);
			lag = coarse + r.delta;
			frac = r.frac;
		}
		const lagFine = lag + frac;
		// clip sample n (media startB + n) ↔ reference sample n + lag (media startA + n + lag):
		// at reference media time 0 the clip shows startB − startA − lag.
		const offsetSec = p.startSec - ref.startSec - lagFine / ANALYSIS_RATE;
		return {
			key: p.clip.key,
			offsetFlicks: Math.round(offsetSec * FLICKS_PER_SECOND),
			lagSamples: lag,
			lagFine,
			confidence: c.confidence,
			distinct: Number.isFinite(c.distinct) ? c.distinct : 1e9,
			reliable: isReliable(c.confidence, c.distinct),
			inverted: c.inverted,
		};
	}

	async analyse(req: SyncAudioRequest, signal?: AbortSignal): Promise<SyncAudioResponse> {
		const max = this.deps.maxConcurrent ?? 2;
		if (this.busy >= max) throw new HttpError(503, 'BUSY', 'Audio sync is busy; try again shortly');
		this.busy++;
		const t0 = Date.now();
		try {
			const keys = new Set<string>();
			for (const c of req.clips) {
				if (keys.has(c.key)) throw new HttpError(400, 'VALIDATION_FAILED', `Duplicate key ${c.key}`);
				keys.add(c.key);
			}
			const refKey = req.reference ?? req.clips[0]!.key;
			const refClip = req.clips.find((c) => c.key === refKey);
			if (!refClip)
				throw new HttpError(400, 'VALIDATION_FAILED', `Reference ${refKey} is not among the clips`);
			const ref = await this.prepare(refClip, signal);
			const results: SyncAudioResult[] = [];
			for (const c of req.clips) {
				if (c.key === refKey) {
					results.push({
						key: c.key,
						offsetFlicks: 0,
						lagSamples: 0,
						lagFine: 0,
						confidence: null,
						distinct: null,
						reliable: true,
						inverted: false,
					});
					continue;
				}
				let p: Prepared;
				try {
					p = await this.prepare(c, signal);
				} catch (e) {
					if (e instanceof HttpError && e.status !== 404) {
						results.push({
							key: c.key,
							offsetFlicks: 0,
							lagSamples: 0,
							lagFine: 0,
							confidence: null,
							distinct: null,
							reliable: false,
							inverted: false,
							error: e.message,
						});
						continue;
					}
					throw e;
				}
				results.push(await this.match(ref, p, req.maxOffsetSeconds, signal));
			}
			return { reference: refKey, sampleRate: ANALYSIS_RATE, results, elapsedMs: Date.now() - t0 };
		} finally {
			this.busy--;
		}
	}
}

// Beats of a media's audio (`POST /api/audio/beats`; spec 12 §2.2 "beats (engine)", §2.8; wp-note "Phase 6 → WP6.2"):
// the range is decoded to mono 22.05 kHz (the Remix analysis rate) and `analyzeBeats` (@jasper/audio-fx: the Remix
// tool's tempo and beat tracker, each beat moved onto its attack, downbeats when one beat per bar is accented — 3 or 4
// beats per bar detected, or the request's `timeSignature`) gives
// tempo, beats and downbeats in media seconds. Results are cached on disk by the file's fingerprint and the range, so
// asking again (the cue route on every Suggest Cues…, the plan job) is instant. At most two analyses run at once.
import { createHash } from 'node:crypto';
import type { BeatsRequest, BeatsResult } from '@jasper/api';
import { BeatsResultSchema } from '@jasper/api';
import { analyzeBeats, beatsPerBarOf, RemixError } from '@jasper/audio-fx';
import type { MediaRegistry } from '../media/registry.ts';
import { AnalysisCache } from '../sound-design/analysis-cache.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';
import { REMIX_ANALYSIS_RATE } from './remix.ts';

/** Bump when the analysis changes (cached results of older versions are not reused). */
export const BEATS_VERSION = 2;
const CONCURRENT = 2;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Mono samples of `[start, start + duration)` seconds of a media's audio at `rate` (ffmpeg). */
export function decodeMono(
	ff: Ffmpeg,
	path: string,
	stream: number | undefined,
	start: number,
	duration: number,
	rate: number,
	signal?: AbortSignal,
): Promise<Float32Array> {
	const args = [
		'-ss',
		start.toFixed(6),
		'-t',
		duration.toFixed(6),
		'-i',
		path,
		...['-map', stream === undefined ? '0:a:0' : `0:${stream}`],
		...['-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'],
	];
	return new Promise((resolve, reject) => {
		const child = ff.spawnRaw(args, signal ? { signal } : {});
		const chunks: Buffer[] = [];
		let size = 0;
		let err = '';
		const cap = Math.ceil((duration + 1) * rate) * 4;
		child.stdout!.on('data', (c: Buffer) => {
			if (size + c.length <= cap) {
				chunks.push(c);
				size += c.length;
			}
		});
		child.stderr!.setEncoding('utf8').on('data', (c: string) => {
			err = (err + c).slice(-4000);
		});
		child.on('error', (e) => reject(new HttpError(500, 'DECODE_FAILED', e.message)));
		child.on('close', (code) => {
			if (signal?.aborted) return reject(new HttpError(409, 'CANCELLED', 'The analysis was cancelled'));
			if (code !== 0)
				return reject(
					new HttpError(422, 'DECODE_FAILED', `ffmpeg exited ${code}: ${err.trim().slice(-800)}`),
				);
			const b = Buffer.concat(chunks, size);
			const out = new Float32Array(Math.floor(b.byteLength / 4));
			Buffer.from(out.buffer).set(b.subarray(0, out.length * 4));
			resolve(out);
		});
	});
}

export class BeatService {
	private readonly cache: AnalysisCache<Omit<BeatsResult, 'cached'>>;
	private running = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(
		private readonly ff: Ffmpeg,
		private readonly registry: MediaRegistry,
		cacheDir: string,
	) {
		this.cache = new AnalysisCache(cacheDir, BeatsResultSchema.omit({ cached: true }), {
			max: 2000,
			memory: 64,
		});
	}

	/** The cache key of a request for a registered media (null for an unknown key). */
	keyOf(req: BeatsRequest): string | null {
		const rec = this.registry.get(req.mediaKey);
		if (!rec) return null;
		return createHash('sha256')
			.update(
				JSON.stringify([
					BEATS_VERSION,
					rec.fingerprint,
					rec.sizeBytes,
					rec.mtimeMs,
					req.streamIndex ?? null,
					Math.round(req.startSeconds * 1000),
					Math.round(req.durationSeconds * 1000),
					beatsPerBarOf(req.timeSignature) ?? 'auto',
				]),
			)
			.digest('hex')
			.slice(0, 40);
	}

	/** A cached result, or null (nothing decoded). */
	async cached(req: BeatsRequest): Promise<BeatsResult | null> {
		const key = this.keyOf(req);
		const hit = key ? await this.cache.get(key) : null;
		return hit ? { ...hit, cached: true } : null;
	}

	async analyze(req: BeatsRequest, signal?: AbortSignal): Promise<BeatsResult> {
		const rec = this.registry.get(req.mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
		if (!rec.probe.streams.some((s) => s.type === 'audio'))
			throw new HttpError(400, 'VALIDATION_FAILED', 'The media has no audio stream');
		const hit = await this.cached(req);
		if (hit) return hit;
		const path = await this.registry.resolvePath(req.mediaKey);
		if (!path) throw new HttpError(409, 'MEDIA_OFFLINE', 'The media is offline');
		await this.slot();
		try {
			const again = await this.cached(req);
			if (again) return again;
			const sr = REMIX_ANALYSIS_RATE;
			const mono = await decodeMono(
				this.ff,
				path,
				req.streamIndex,
				req.startSeconds,
				req.durationSeconds,
				sr,
				signal,
			);
			const base = {
				startSeconds: req.startSeconds,
				durationSeconds: req.durationSeconds,
				analysedSeconds: round4(mono.length / sr),
			};
			let out: Omit<BeatsResult, 'cached'>;
			try {
				const a = analyzeBeats([mono], sr, { timeSignature: req.timeSignature ?? 'auto' });
				const sec = (s: number) => round4(req.startSeconds + s / sr);
				out = {
					...base,
					bpm: Math.round(a.bpm * 100) / 100,
					beats: a.beats.map(sec),
					downbeats: a.downbeats ? a.downbeats.map((i) => sec(a.beats[i]!)) : null,
					beatsPerBar: a.beatsPerBar,
					downbeatConfidence: Math.round(a.downbeatConfidence * 1000) / 1000,
				};
			} catch (e) {
				if (!(e instanceof RemixError)) throw e;
				out = {
					...base,
					bpm: null,
					beats: [],
					downbeats: null,
					beatsPerBar: null,
					downbeatConfidence: 0,
					reason: 'NO_BEAT',
				};
			}
			const key = this.keyOf(req);
			if (key) await this.cache.put(key, out).catch(() => undefined);
			return { ...out, cached: false };
		} finally {
			this.release();
		}
	}

	private slot(): Promise<void> {
		if (this.running < CONCURRENT) {
			this.running++;
			return Promise.resolve();
		}
		return new Promise<void>((r) => this.waiting.push(() => r()));
	}

	private release(): void {
		const next = this.waiting.shift();
		if (next) next();
		else this.running--;
	}
}

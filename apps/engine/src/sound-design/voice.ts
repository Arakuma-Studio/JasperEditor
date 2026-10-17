// Voice activity of Essential Sound dialogue clips (spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): the engine half of the
// one dialogue definition (`dialogueSpans` in @jasper/project). For each dialogue clip without transcript words
// (`dialogueVadClips`) the media range it plays is decoded by ffmpeg to 16 kHz mono and streamed into 10 ms levels
// (no PCM is held: hours of dialogue cost 100 floats a second); voiced frames are those at or over the speech module's
// threshold (`vadThreshold`: 30 % between the noise floor and the speech level, ≥ 6 dB over the floor) and at least
// −50 dBFS (`VAD_FLOOR_DBFS`, the bed render's and Sound Check's rule); runs closer than 0.3 s are joined (pauses
// between syllables) and runs under 30 ms dropped (clicks). Regions are media seconds, cached on disk per file
// fingerprint and range (on a half-second grid, so a trim of a few frames reuses them). Every consumer — the cue
// route, the plan job, the solver's bed measurement, Sound Check — reads them through `VoiceActivityService`.
import { createHash } from 'node:crypto';
import {
	type DialogueVadClip,
	dialogueVadClips,
	type MediaAsset,
	type ProjectDocument,
	type Sequence,
	type VoiceActivity,
} from '@jasper/project';
import { z } from 'zod';
import type { MediaRegistry } from '../media/registry.ts';
import { vadThreshold } from '../speech/core/vad.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { AnalysisCache } from './analysis-cache.ts';

/** Bump when the measurement changes (cached results of older versions are not reused). */
export const VOICE_VERSION = 1;
export const VOICE_RATE = 16_000;
/** Voiced frames are at least this loud (the bed render's and Sound Check's floor). */
export const VOICE_FLOOR_DBFS = -50;
/** Pauses shorter than this join two voiced runs; runs shorter than VOICE_MIN_RUN_SEC are dropped. */
export const VOICE_BRIDGE_SEC = 0.3;
export const VOICE_MIN_RUN_SEC = 0.03;
/** Longest media range measured per clip (s), and per call over all clips. */
export const VOICE_MAX_CLIP_SECONDS = 4 * 3600;
export const VOICE_MAX_TOTAL_SECONDS = 8 * 3600;
/** Most dialogue clips measured per call. */
export const VOICE_MAX_CLIPS = 64;
const CONCURRENT = 2;
const HOP = VOICE_RATE / 100;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

const VoiceEntrySchema = z.object({
	voiced: z.array(z.tuple([z.number(), z.number()])),
	analysedSeconds: z.number(),
	thresholdDb: z.number(),
});
export type VoiceEntry = z.infer<typeof VoiceEntrySchema>;

/** Voiced regions (seconds from `startSec`) of 10 ms levels (dBFS). Pure. */
export function voiceRegions(
	levels: ArrayLike<number>,
	startSec = 0,
): { voiced: [number, number][]; thresholdDb: number } {
	const th = Math.max(vadThreshold(levels), VOICE_FLOOR_DBFS);
	const runs: [number, number][] = [];
	let run = -1;
	for (let f = 0; f <= levels.length; f++) {
		const on = f < levels.length && levels[f]! >= th;
		if (on && run < 0) run = f;
		else if (!on && run >= 0) {
			const last = runs[runs.length - 1];
			if (last && run - last[1] < VOICE_BRIDGE_SEC * 100) last[1] = f;
			else runs.push([run, f]);
			run = -1;
		}
	}
	return {
		voiced: runs
			.filter(([a, b]) => b - a >= VOICE_MIN_RUN_SEC * 100)
			.map(([a, b]) => [r3(startSec + a / 100), r3(startSec + b / 100)]),
		thresholdDb: Math.round(th * 100) / 100,
	};
}

/** The engine-store key of a media asset (null: not in the engine's store). */
export function engineMediaKey(asset: MediaAsset | undefined): string | null {
	const l = asset?.locators?.find((x) => x.type === 'engine-store') as { key?: unknown } | undefined;
	return typeof l?.key === 'string' ? l.key : null;
}

export type VoiceRequest = {
	mediaKey: string;
	streamIndex: number | null;
	startSeconds: number;
	durationSeconds: number;
};

export type SequenceVoice = {
	voice: VoiceActivity;
	state: 'ready' | 'partial' | 'none' | 'failed';
	measured: number;
	missing: number;
	/** Of `measured`: served by the caller's `memo`, or not (decoded now or read from this service's caches). */
	fromCache: number;
	decoded: number;
	message?: string;
};

export class VoiceActivityService {
	private readonly cache: AnalysisCache<VoiceEntry> | null;
	private readonly memory = new Map<string, VoiceEntry>();
	private running = 0;
	private readonly waiting: (() => void)[] = [];
	private readonly inflight = new Map<string, Promise<VoiceEntry>>();

	constructor(
		private readonly ff: Ffmpeg,
		private readonly registry: Pick<MediaRegistry, 'get' | 'resolvePath'>,
		cacheDir: string | null,
	) {
		this.cache = cacheDir ? new AnalysisCache(cacheDir, VoiceEntrySchema, { max: 2000, memory: 128 }) : null;
	}

	keyOf(req: VoiceRequest): string | null {
		const rec = this.registry.get(req.mediaKey);
		if (!rec) return null;
		return createHash('sha256')
			.update(
				JSON.stringify([
					VOICE_VERSION,
					rec.fingerprint,
					rec.sizeBytes,
					rec.mtimeMs,
					req.streamIndex,
					Math.round(req.startSeconds * 1000),
					Math.round(req.durationSeconds * 1000),
				]),
			)
			.digest('hex')
			.slice(0, 40);
	}

	async cached(req: VoiceRequest): Promise<VoiceEntry | null> {
		const key = this.keyOf(req);
		if (!key) return null;
		const m = this.memory.get(key);
		if (m) return m;
		const hit = this.cache ? await this.cache.get(key) : null;
		if (hit) this.remember(key, hit);
		return hit;
	}

	private remember(key: string, v: VoiceEntry): void {
		this.memory.delete(key);
		this.memory.set(key, v);
		while (this.memory.size > 512) this.memory.delete(this.memory.keys().next().value as string);
	}

	/** Voiced media seconds of a range (cached; at most two decodes at once; the same range measured once). */
	async measure(req: VoiceRequest, signal?: AbortSignal): Promise<VoiceEntry> {
		const hit = await this.cached(req);
		if (hit) return hit;
		const key = this.keyOf(req);
		if (!key) throw new Error('Unknown media key');
		const running = this.inflight.get(key);
		if (running) return running;
		const p = (async () => {
			await this.slot();
			try {
				const again = await this.cached(req);
				if (again) return again;
				const path = await this.registry.resolvePath(req.mediaKey);
				if (!path) throw new Error('The media is offline');
				const levels = await this.levels(path, req, signal);
				const r = voiceRegions(levels, req.startSeconds);
				const entry: VoiceEntry = { ...r, analysedSeconds: r3(levels.length / 100) };
				this.remember(key, entry);
				if (this.cache) await this.cache.put(key, entry).catch(() => undefined);
				return entry;
			} finally {
				this.release();
			}
		})();
		this.inflight.set(key, p);
		try {
			return await p;
		} finally {
			this.inflight.delete(key);
		}
	}

	/** 10 ms levels (dBFS) of the range: ffmpeg's 16 kHz mono stream folded on the fly. */
	private levels(path: string, req: VoiceRequest, signal?: AbortSignal): Promise<Float32Array> {
		const args = [
			'-ss',
			req.startSeconds.toFixed(6),
			'-t',
			req.durationSeconds.toFixed(6),
			'-i',
			path,
			...['-map', req.streamIndex === null ? '0:a:0' : `0:${req.streamIndex}`],
			...['-ac', '1', '-ar', String(VOICE_RATE), '-f', 'f32le', 'pipe:1'],
		];
		return new Promise((resolve, reject) => {
			const child = this.ff.spawnRaw(args, signal ? { signal } : {});
			const cap = Math.ceil((req.durationSeconds + 1) * 100);
			const out = new Float32Array(cap);
			let n = 0;
			let acc = 0;
			let count = 0;
			let carry = Buffer.alloc(0);
			let err = '';
			child.stdout!.on('data', (chunk: Buffer) => {
				const b = carry.length ? Buffer.concat([carry, chunk]) : chunk;
				const whole = b.length - (b.length % 4);
				for (let o = 0; o < whole; o += 4) {
					const v = b.readFloatLE(o);
					acc += Number.isFinite(v) ? v * v : 0;
					if (++count === HOP) {
						if (n < cap) out[n++] = 10 * Math.log10(acc / HOP + 1e-12);
						acc = 0;
						count = 0;
					}
				}
				carry = Buffer.from(b.subarray(whole));
			});
			child.stderr!.setEncoding('utf8').on('data', (c: string) => {
				err = (err + c).slice(-4000);
			});
			child.on('error', (e) => reject(e));
			child.on('close', (code) => {
				if (signal?.aborted) return reject(new Error('cancelled'));
				if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-400)}`));
				resolve(out.subarray(0, n));
			});
		});
	}

	/** The range a dialogue clip needs measured (half-second grid, ±0.5 s), or null when it cannot be measured. */
	requestOf(doc: ProjectDocument, c: DialogueVadClip): VoiceRequest | null {
		const key = engineMediaKey(doc.media?.[c.mediaId]);
		if (!key || !this.registry.get(key)) return null;
		const lo = Math.max(0, Math.floor((c.mediaStartSec - 0.5) * 2) / 2);
		const hi = Math.ceil((c.mediaEndSec + 0.5) * 2) / 2;
		return {
			mediaKey: key,
			streamIndex: c.streamIndex,
			startSeconds: lo,
			durationSeconds: Math.min(VOICE_MAX_CLIP_SECONDS, Math.max(0.5, hi - lo)),
		};
	}

	/**
	 * Voice activity of the sequence's dialogue clips without transcript words. `mode: 'cached'` decodes nothing.
	 * A clip that cannot be measured (offline, not in the store, over the limits, a decode error) is left out: the
	 * pure rule then uses its whole span. Never throws except on abort.
	 */
	async forSequence(
		doc: ProjectDocument,
		seq: Sequence,
		opts: {
			mode?: 'compute' | 'cached';
			signal?: AbortSignal;
			/** A caller's own cache of entries by request key (the solver's `MeasureCache`): its hits count as `fromCache`. */
			memo?: { get(key: string): VoiceEntry | undefined; put(key: string, v: VoiceEntry): void };
		} = {},
	): Promise<SequenceVoice> {
		const clips = dialogueVadClips(doc, seq);
		const voice: Record<string, [number, number][]> = {};
		if (!clips.length) return { voice, state: 'none', measured: 0, missing: 0, decoded: 0, fromCache: 0 };
		let total = 0;
		let measured = 0;
		let decoded = 0;
		let fromCache = 0;
		const problems: string[] = [];
		for (const [i, c] of clips.entries()) {
			if (opts.signal?.aborted) throw new Error('cancelled');
			const req = this.requestOf(doc, c);
			if (!req) {
				problems.push(`${c.clipId}: not in the engine's media store`);
				continue;
			}
			if (i >= VOICE_MAX_CLIPS || total + req.durationSeconds > VOICE_MAX_TOTAL_SECONDS) {
				problems.push(`${c.clipId}: over the per-call limit`);
				continue;
			}
			total += req.durationSeconds;
			try {
				const key = this.keyOf(req)!;
				let e: VoiceEntry | null = opts.memo?.get(key) ?? null;
				if (e) fromCache++;
				else {
					e = opts.mode === 'cached' ? await this.cached(req) : await this.measure(req, opts.signal);
					if (e) {
						decoded++;
						opts.memo?.put(key, e);
					}
				}
				if (!e) {
					problems.push(`${c.clipId}: not measured yet`);
					continue;
				}
				const lo = c.mediaStartSec - 0.05;
				const hi = c.mediaEndSec + 0.05;
				voice[c.clipId] = e.voiced.filter(([a, b]) => b > lo && a < hi);
				measured++;
			} catch (err) {
				if (opts.signal?.aborted) throw err;
				problems.push(`${c.clipId}: ${(err as Error).message}`.slice(0, 200));
			}
		}
		const missing = clips.length - measured;
		return {
			voice,
			state: missing === 0 ? 'ready' : measured === 0 ? 'failed' : 'partial',
			measured,
			missing,
			decoded,
			fromCache,
			...(problems.length ? { message: problems.slice(0, 5).join('; ') } : {}),
		};
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

// One service per engine (the route registers the disk-cached one); callers holding only ffmpeg and the registry
// (the solver's bed measurement, Sound Check) get it, or a memory-only one for that ffmpeg.
const services = new WeakMap<object, VoiceActivityService>();

export function registerVoiceService(ff: Ffmpeg, svc: VoiceActivityService): void {
	services.set(ff, svc);
}

export function voiceServiceFor(
	ff: Ffmpeg,
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>,
): VoiceActivityService {
	let s = services.get(ff);
	if (!s) {
		s = new VoiceActivityService(ff, registry, null);
		services.set(ff, s);
	}
	return s;
}

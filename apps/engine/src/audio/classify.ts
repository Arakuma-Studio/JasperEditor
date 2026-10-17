// Essential Sound Auto Tag on the engine (`POST /api/audio/classify`, spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): an
// `audio-classify` job classifies clips (over the media range each plays) or whole media as dialogue, music, SFX or
// ambience with `audioCategoryFeatures` + `classifyAudio` (@jasper/audio-fx). Each range is decoded by ffmpeg to 16 kHz
// mono (the classifier's analysis rate): ranges up to 60 s whole, longer ones as four 15 s windows spread over them
// (start, ⅓, ⅔, end). Results are cached on disk by the file's fingerprint, the stream and the range (ms), so asking
// again — the same clip, another clip of the same take, the MCP tool after the editor — decodes nothing.
import { createHash } from 'node:crypto';
import type {
	AudioClassification,
	AudioClassifyItem,
	AudioClassifyRequest,
	AudioClassifyResult,
	EngineJob,
} from '@jasper/api';
import { AudioClassificationSchema } from '@jasper/api';
import {
	AUDIO_CATEGORY_VERSION,
	type AudioWindow,
	audioCategoryFeatures,
	CATEGORY_ANALYSIS_RATE,
	classifyAudio,
	LOW_CATEGORY_CONFIDENCE,
	MAX_CATEGORY_WINDOW_SECONDS,
} from '@jasper/audio-fx';
import {
	type AudioClip,
	type Clip,
	clipMediaTimeFn,
	essentialAutoTag,
	FLICKS_PER_SECOND,
	type ProjectDocument,
	type Rational,
	readEssentialSound,
	type Sequence,
	type TimedClip,
} from '@jasper/project';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import { AnalysisCache } from '../sound-design/analysis-cache.ts';
import { engineMediaKey } from '../sound-design/voice.ts';
import type { CoreServices } from '../tools/services.ts';
import { decodeMono } from './beats.ts';

/** Windows (s) of a long range; ranges up to MAX_CATEGORY_WINDOW_SECONDS are classified whole. */
export const CLASSIFY_LONG_WINDOW_SECONDS = 15;
export const CLASSIFY_LONG_WINDOWS = 4;
const CONCURRENT = 2;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** One range to classify. */
export type ClassifyTarget = {
	clipId?: string;
	mediaKey: string | null;
	name: string;
	streamIndex: number | null;
	startSeconds: number;
	durationSeconds: number;
	currentType?: AudioClassifyItem['currentType'];
	autoTagged?: boolean;
	error?: { code: string; message: string };
};

export type ClassifyJobInput = {
	projectId: string | null;
	sequenceId: string | null;
	targets: ClassifyTarget[];
};

/** The media range an audio clip plays (seconds), through speed, reverse and time remap. */
export function clipMediaRange(c: Clip, rate: Rational): { start: number; end: number } | null {
	if (!Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.duration) || c.duration <= 0) return null;
	const at = clipMediaTimeFn(c as unknown as TimedClip, rate);
	const n = c.duration;
	const stride = Math.max(1, Math.ceil(n / 20_000));
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (let k = 0; k <= n; k += stride) {
		const m = at(c.start + Math.min(k, n - 1));
		if (m < lo) lo = m;
		if (m > hi) hi = m;
	}
	const last = at(c.start + n - 1);
	lo = Math.min(lo, last);
	hi = Math.max(hi, last);
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
	// the last frame plays one frame's worth of media
	const frameMedia = (c.speed?.rate ?? 1) * (rate.den / rate.num);
	return {
		start: Math.max(0, lo / FLICKS_PER_SECOND),
		end: Math.max(0, hi / FLICKS_PER_SECOND + frameMedia),
	};
}

/** The targets of a request over a document (clips) — unknown / non-audio clips become error items. */
export function clipTargets(
	doc: ProjectDocument,
	seq: Sequence,
	clipIds: readonly string[],
): ClassifyTarget[] {
	const rate = seq.settings.frameRate as Rational;
	return clipIds.map((id): ClassifyTarget => {
		const c = Object.hasOwn(seq.clips, id) ? seq.clips[id] : undefined;
		const base = {
			clipId: id,
			mediaKey: null,
			name: c?.name ?? id,
			streamIndex: null,
			startSeconds: 0,
			durationSeconds: 0,
		};
		if (!c) return { ...base, error: { code: 'CLIP_NOT_FOUND', message: `No clip ${id} in the sequence` } };
		if (c.kind !== 'audio')
			return { ...base, error: { code: 'NOT_AUDIO', message: `${c.name} is not an audio clip` } };
		const a = c as AudioClip;
		const es = readEssentialSound(a.essential);
		const cur = { currentType: es?.type ?? null, autoTagged: !!essentialAutoTag(a.essential) };
		const asset = doc.media?.[a.mediaId];
		const key = engineMediaKey(asset);
		const span = clipMediaRange(c, rate);
		if (!key)
			return {
				...base,
				...cur,
				error: { code: 'NOT_IN_ENGINE', message: `${c.name}: its media is not in the engine's media store` },
			};
		if (!span)
			return { ...base, ...cur, error: { code: 'DECODE_FAILED', message: `${c.name}: no media range` } };
		return {
			...base,
			...cur,
			mediaKey: key,
			streamIndex: Number.isSafeInteger(a.channels?.streamIndex) ? a.channels.streamIndex : null,
			startSeconds: r3(span.start),
			durationSeconds: r3(Math.max(0.001, span.end - span.start)),
		};
	});
}

/** Windows `[start, length]` (s) analysed for a range. */
export function classifyWindows(start: number, dur: number): [number, number][] {
	if (dur <= MAX_CATEGORY_WINDOW_SECONDS) return [[start, dur]];
	const w = CLASSIFY_LONG_WINDOW_SECONDS;
	return Array.from({ length: CLASSIFY_LONG_WINDOWS }, (_, k): [number, number] => [
		r3(start + (k * (dur - w)) / (CLASSIFY_LONG_WINDOWS - 1)),
		w,
	]);
}

export class ClassifyService {
	private readonly cache: AnalysisCache<AudioClassification>;
	private running = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(
		private readonly core: Pick<CoreServices, 'queue' | 'ffmpeg'> & {
			registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
		},
		cacheDir: string,
	) {
		this.cache = new AnalysisCache(cacheDir, AudioClassificationSchema, { max: 5000, memory: 256 });
	}

	registerRunner(): void {
		this.core.queue.registerRunner('audio-classify', (ctx) => this.run(ctx));
	}

	keyOf(t: ClassifyTarget): string | null {
		const rec = t.mediaKey ? this.core.registry.get(t.mediaKey) : undefined;
		if (!rec) return null;
		return createHash('sha256')
			.update(
				JSON.stringify([
					AUDIO_CATEGORY_VERSION,
					rec.fingerprint,
					rec.sizeBytes,
					rec.mtimeMs,
					t.streamIndex,
					Math.round(t.startSeconds * 1000),
					Math.round(t.durationSeconds * 1000),
				]),
			)
			.digest('hex')
			.slice(0, 40);
	}

	/** Starts a classification job. */
	submit(input: ClassifyJobInput, origin?: EngineJob['origin']): EngineJob {
		const n = input.targets.length;
		return this.core.queue.submit({
			kind: 'audio-classify',
			title: `Auto Tag audio (${n} ${n === 1 ? 'item' : 'items'})`,
			priority: 'interactive',
			cpuSlots: 1,
			minSlots: 1,
			...(origin ? { origin } : {}),
			...(input.projectId ? { projectId: input.projectId } : {}),
			input,
			stage: 'Waiting',
		});
	}

	private async run(ctx: JobContext): Promise<AudioClassifyResult> {
		const input = ctx.input as ClassifyJobInput;
		if (!input || !Array.isArray(input.targets))
			throw new JobError('BAD_REQUEST', 'Not a classify request', false);
		const t0 = Date.now();
		const n = input.targets.length;
		const items = new Array<AudioClassifyItem>(n);
		let next = 0;
		let done = 0;
		// two at once (the decode slots); results in request order
		const worker = async () => {
			while (next < n) {
				const i = next++;
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Auto Tag cancelled');
				const t = input.targets[i]!;
				items[i] = await this.item(t, ctx.signal);
				done++;
				ctx.progress(done / Math.max(1, n), {
					stage: `Listened to ${done} of ${n}: ${t.name}`.slice(0, 120),
				});
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENT, Math.max(1, n)) }, worker));
		ctx.progress(1, { stage: 'Done' });
		const counts = { dialogue: 0, music: 0, sfx: 0, ambience: 0, silent: 0, failed: 0, low: 0 };
		for (const it of items) {
			if (!it.result) counts.failed++;
			else if (it.result.silent || !it.result.category) counts.silent++;
			else {
				counts[it.result.category]++;
				if (it.result.confidence < LOW_CATEGORY_CONFIDENCE) counts.low++;
			}
		}
		return {
			projectId: input.projectId,
			sequenceId: input.sequenceId,
			items,
			lowConfidence: LOW_CATEGORY_CONFIDENCE,
			counts,
			version: AUDIO_CATEGORY_VERSION,
			ms: Date.now() - t0,
		};
	}

	/** One target classified (cached), or its error. Never throws except on abort. */
	async item(t: ClassifyTarget, signal?: AbortSignal): Promise<AudioClassifyItem> {
		const base: AudioClassifyItem = {
			...(t.clipId ? { clipId: t.clipId } : {}),
			...(t.mediaKey ? { mediaKey: t.mediaKey } : {}),
			name: t.name,
			...(t.currentType !== undefined ? { currentType: t.currentType } : {}),
			...(t.autoTagged !== undefined ? { autoTagged: t.autoTagged } : {}),
			startSeconds: t.startSeconds,
			durationSeconds: t.durationSeconds,
			result: null,
			cached: false,
		};
		if (t.error) return { ...base, error: t.error };
		const key = this.keyOf(t);
		if (!key || !t.mediaKey) return { ...base, error: { code: 'NOT_IN_ENGINE', message: 'Unknown media' } };
		const hit = await this.cache.get(key);
		if (hit) return { ...base, result: hit, cached: true };
		const rec = this.core.registry.get(t.mediaKey)!;
		if (!rec.probe?.streams?.some((s) => s.type === 'audio'))
			return { ...base, error: { code: 'NO_AUDIO_STREAM', message: `${t.name} has no audio` } };
		const path = await this.core.registry.resolvePath(t.mediaKey);
		if (!path) return { ...base, error: { code: 'MEDIA_OFFLINE', message: `${t.name} is offline` } };
		await this.slot();
		try {
			const again = await this.cache.get(key);
			if (again) return { ...base, result: again, cached: true };
			const windows: AudioWindow[] = [];
			for (const [s, d] of classifyWindows(t.startSeconds, t.durationSeconds)) {
				const mono = await decodeMono(
					this.core.ffmpeg,
					path,
					t.streamIndex ?? undefined,
					s,
					d,
					CATEGORY_ANALYSIS_RATE,
					signal,
				);
				windows.push({ channels: [mono], sampleRate: CATEGORY_ANALYSIS_RATE });
			}
			const f = audioCategoryFeatures(windows, t.durationSeconds);
			const r = classifyAudio(f);
			const result: AudioClassification = {
				category: r.silent ? null : r.category,
				confidence: r.confidence,
				scores: r.scores,
				reasons: r.reasons,
				silent: r.silent,
				durationSec: f.durationSec,
				analysedSec: f.analysedSec,
				features: { ...f },
			};
			await this.cache.put(key, result).catch(() => undefined);
			return { ...base, result };
		} catch (e) {
			if (signal?.aborted) throw new JobError('JOB_CANCELLED', 'Auto Tag cancelled');
			return { ...base, error: { code: 'DECODE_FAILED', message: (e as Error).message.slice(0, 300) } };
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

/** Targets of a request (validated by the route): clips of a document, or registered media (whole files). */
export function requestTargets(
	req: AudioClassifyRequest,
	doc: ProjectDocument | null,
	seq: Sequence | null,
	registry: Pick<MediaRegistry, 'get'>,
): ClassifyTarget[] {
	if (req.clipIds && doc && seq) return clipTargets(doc, seq, req.clipIds);
	return (req.mediaKeys ?? []).map((key): ClassifyTarget => {
		const rec = registry.get(key);
		const base = {
			mediaKey: key,
			name: key,
			streamIndex: req.streamIndex ?? null,
			startSeconds: 0,
			durationSeconds: 0,
		};
		if (!rec)
			return {
				...base,
				mediaKey: null,
				error: { code: 'ASSET_NOT_FOUND', message: `Unknown media key ${key}` },
			};
		const audio = rec.probe?.streams?.find(
			(s) => s.type === 'audio' && (req.streamIndex === undefined || s.index === req.streamIndex),
		);
		const dur = rec.durationSec ?? 0;
		return {
			...base,
			name: rec.originalName,
			...(audio ? {} : { error: { code: 'NO_AUDIO_STREAM', message: `${rec.originalName} has no audio` } }),
			durationSeconds: r3(Number.isFinite(dur) && dur > 0 ? dur : 0.001),
		};
	});
}

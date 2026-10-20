// The engine's cue sources (spec 12 §2.2 "Scene cuts (engine), beats (engine), pixel motion curve (engine, P6)", §2.8;
// P6-R2; wp-note "Phase 6 → WP6.2"): measures what the edit does not say and returns `ExtraCue`s for `deriveCues`.
//
//   scene  shot changes inside footage: Scene Edit Detection (`scene-detect` jobs, sensitivity 50, shots ≥ 2 frames) of
//          the media range each footage clip shows; cached per file / settings / range by SceneService.
//   beat   beats of Essential Sound music clips (`/api/audio/beats`: fast, run inline, cached per file and range); also
//          the beat frames `snapToBeats` snaps to.
//   pixel  the rendered picture's motion (`motion-analysis` jobs over 10-minute windows of the sequence, cached by the
//          picture's fingerprint); only analysed when the range shows footage (graphics have their own sources).
//
// Modes: `submit` (the cue route) starts the jobs that are missing and reports them as pending — their cues are NOT
// silently left out: the answer says `W_ANALYSIS_PENDING` with the job ids; `inline` (the plan job) runs every analysis
// inside the calling job; `cached` (Sound Check) uses only what is already measured.
import type {
	BeatsResult,
	EngineJob,
	MotionAnalysisResult,
	SceneDetectRequest,
	TimeSignature,
} from '@jasper/api';
import {
	type BeatData,
	beatCues,
	type ENGINE_CUE_SOURCES,
	type ExtraCue,
	footageClips,
	type MediaAsset,
	musicBeatRequest,
	musicClips,
	type PixelMotionEvent,
	type ProjectDocument,
	pixelMotionCues,
	type Rational,
	type SceneCutData,
	type Sequence,
	sceneAnchorAt,
	sceneCutCues,
	sequenceDuration,
} from '@jasper/project';
import type { BeatService } from '../audio/beats.ts';
import type { JobQueue } from '../jobs/queue.ts';
import type { JobContext } from '../jobs/types.ts';
import type { SceneService } from '../time/scenes.ts';
import { HttpError } from '../tools/reply.ts';
import { MotionInputError, type MotionService, maxMotionFrames, planMotion, subContext } from './motion.ts';

export type EngineCueSource = (typeof ENGINE_CUE_SOURCES)[number];

export type EngineSourceState = {
	state: 'ready' | 'pending' | 'missing' | 'none' | 'failed';
	jobIds: string[];
	found: number;
	message?: string;
};

export type EngineCueWarning = { code: string; message: string; source?: string; jobIds?: string[] };

export type EngineCueResult = {
	extraCues: ExtraCue[];
	/** Beat frames for `snapToBeats` (null when not asked). */
	beatFrames: number[] | null;
	analysis: Partial<Record<EngineCueSource, EngineSourceState>>;
	warnings: EngineCueWarning[];
	/** The measured picture-motion speed per frame (screen diagonals per second) of the analysed windows. */
	pixelCurves: { startFrame: number; speed: number[] }[];
};

export type EngineCueMode =
	| { kind: 'submit'; projectId: string | null; origin?: EngineJob['origin']; revision?: number }
	| { kind: 'inline'; ctx: JobContext; projectId: string | null; from?: number; to?: number }
	| { kind: 'cached' };

/** Scene Edit Detection settings of the scene source. */
export const SCENE_SOURCE_SETTINGS = { sensitivity: 50, minShotFrames: 2 } as const;
/** Most music clips analysed for beats in one call. */
export const MAX_BEAT_CLIPS = 32;
/** Most footage media analysed for shot changes in one call. */
export const MAX_SCENE_MEDIA = 64;
/** A failed analysis is reported (not retried) for this long. */
const FAILED_MEMORY_MS = 5 * 60_000;

const engineKey = (asset: MediaAsset | undefined): string | null => {
	const l = asset?.locators?.find((x) => x.type === 'engine-store') as { key?: unknown } | undefined;
	return typeof l?.key === 'string' ? l.key : null;
};

/** Merged media intervals `[lo, hi]` (seconds), widened by `pad`, on a half-second grid (stable cache keys). */
function intervals(
	spans: { lo: number; hi: number }[],
	pad: number,
	maxSec: number | null,
): { lo: number; hi: number }[] {
	const q = spans
		.map((s) => ({ lo: Math.max(0, Math.floor((s.lo - pad) * 2) / 2), hi: Math.ceil((s.hi + pad) * 2) / 2 }))
		.map((s) => (maxSec !== null ? { lo: Math.min(s.lo, maxSec), hi: Math.min(s.hi, maxSec) } : s))
		.filter((s) => s.hi > s.lo)
		.sort((a, b) => a.lo - b.lo);
	const out: { lo: number; hi: number }[] = [];
	for (const s of q) {
		const last = out[out.length - 1];
		if (last && s.lo <= last.hi) last.hi = Math.max(last.hi, s.hi);
		else out.push({ ...s });
	}
	return out;
}

/** The `/api/audio/beats` request of a music clip's media range (`musicBeatRequest`: the cue menu finds it cached). */
const beatRequestOf = (
	mediaKey: string,
	c: { mediaStartSec: number; mediaEndSec: number },
	timeSignature: TimeSignature | undefined,
) => musicBeatRequest(mediaKey, c, timeSignature);

export class EngineCueSources {
	/** Analyses started per request key: a failed one is reported instead of being started again and again. */
	private readonly started = new Map<string, string>();

	constructor(
		private readonly deps: {
			queue: JobQueue;
			scenes: () => SceneService | undefined;
			beats: () => BeatService | undefined;
			motion: () => MotionService | undefined;
		},
	) {}

	/** A recent failure of the job started for `key` (null when none or when it is older than a few minutes). */
	private failure(key: string): string | null {
		const id = this.started.get(key);
		const job = id ? this.deps.queue.get(id) : undefined;
		if (job?.state !== 'failed') return null;
		const at = job.finishedAt ? Date.parse(job.finishedAt) : 0;
		if (Date.now() - at > FAILED_MEMORY_MS) {
			this.started.delete(key);
			return null;
		}
		return job.error?.message ?? 'the analysis failed';
	}

	private remember(key: string, job: EngineJob): void {
		this.started.set(key, job.id);
		if (this.started.size > 2000) this.started.delete(this.started.keys().next().value!);
	}

	async collect(
		doc: ProjectDocument,
		seq: Sequence,
		opts: {
			sources: readonly EngineCueSource[];
			snapToBeats?: boolean;
			/** Metre of the music's downbeats (`POST /api/audio/beats` `timeSignature`; default auto). */
			timeSignature?: TimeSignature;
			range?: { start: number; end: number };
			mode: EngineCueMode;
			signal?: AbortSignal;
		},
	): Promise<EngineCueResult> {
		const want = new Set(opts.sources);
		const out: EngineCueResult = {
			extraCues: [],
			beatFrames: null,
			analysis: {},
			warnings: [],
			pixelCurves: [],
		};
		// inline progress: scene, beat, pixel in turn over the caller's span
		const steps = [want.has('scene'), want.has('beat') || !!opts.snapToBeats, want.has('pixel')].filter(
			Boolean,
		).length;
		let step = 0;
		const sub = (label: string): EngineCueMode => {
			if (opts.mode.kind !== 'inline') return opts.mode;
			const from = opts.mode.from ?? 0;
			const to = opts.mode.to ?? 1;
			const a = from + ((to - from) * step) / Math.max(1, steps);
			const b = from + ((to - from) * (step + 1)) / Math.max(1, steps);
			step++;
			return { ...opts.mode, ctx: subContext(opts.mode.ctx, a, b, label) };
		};
		if (want.has('scene')) await this.scene(doc, seq, opts.range, sub('Shot changes'), out);
		if (want.has('beat') || opts.snapToBeats)
			await this.beat(
				doc,
				seq,
				opts.range,
				sub('Beats'),
				out,
				want.has('beat'),
				!!opts.snapToBeats,
				opts.signal,
				opts.timeSignature,
			);
		if (want.has('pixel')) await this.pixel(doc, seq, opts.range, sub('Picture motion'), out);
		return out;
	}

	private async scene(
		doc: ProjectDocument,
		seq: Sequence,
		range: { start: number; end: number } | undefined,
		mode: EngineCueMode,
		out: EngineCueResult,
	): Promise<void> {
		const st: EngineSourceState = { state: 'ready', jobIds: [], found: 0 };
		out.analysis.scene = st;
		const scenes = this.deps.scenes();
		const clips = footageClips(doc, seq, range);
		if (!clips.length) {
			st.state = 'none';
			st.message = 'No footage in the range';
			return;
		}
		if (!scenes) {
			st.state = 'failed';
			st.message = 'Scene Edit Detection is not available';
			return;
		}
		const byMedia = new Map<string, { lo: number; hi: number }[]>();
		for (const c of clips) {
			const list = byMedia.get(c.mediaId) ?? [];
			list.push({ lo: c.mediaStartSec, hi: c.mediaEndSec });
			byMedia.set(c.mediaId, list);
		}
		const results = new Map<string, SceneCutData>();
		const failed: string[] = [];
		let missing = 0;
		let n = 0;
		for (const [mediaId, spans] of byMedia) {
			if (++n > MAX_SCENE_MEDIA) {
				out.warnings.push({
					code: 'W_ANALYSIS_TRUNCATED',
					message: `Shot changes were measured in the first ${MAX_SCENE_MEDIA} media only`,
					source: 'scene',
				});
				break;
			}
			const asset = doc.media[mediaId];
			const key = engineKey(asset);
			if (!key) {
				out.warnings.push({
					code: 'W_MEDIA_UNAVAILABLE',
					message: `${asset?.originalName ?? mediaId} is not in the engine's media store: no shot changes measured`,
					source: 'scene',
				});
				continue;
			}
			const dur = asset?.probe?.durationFlicks ? asset.probe.durationFlicks / 705_600_000 : null;
			const fpsOf = asset?.probe?.streams?.find((s) => s.type === 'video') as
				| { frameRate?: Rational }
				| undefined;
			const frameSec = fpsOf?.frameRate?.num ? fpsOf.frameRate.den / fpsOf.frameRate.num : 1 / 30;
			const data: SceneCutData & { cuts: number[]; times: number[]; scores: number[] } = {
				cuts: [],
				times: [],
				scores: [],
			};
			for (const iv of intervals(spans, 0.5 + frameSec, dur)) {
				const req: SceneDetectRequest = {
					...(mode.kind !== 'cached' && mode.projectId ? { projectId: mode.projectId } : {}),
					mediaKey: key,
					startSec: iv.lo,
					endSec: iv.hi,
					...SCENE_SOURCE_SETTINGS,
				};
				const reqKey = `scene:${key}:${iv.lo}:${iv.hi}`;
				let r = await scenes.cachedCovering(req);
				if (!r && mode.kind === 'inline') {
					try {
						r = await scenes.detectInline(req, mode.ctx);
					} catch (e) {
						failed.push(e instanceof Error ? e.message : String(e));
						continue;
					}
				}
				if (!r && mode.kind === 'submit') {
					const why = this.failure(reqKey);
					if (why) {
						failed.push(why);
						continue;
					}
					try {
						const job = await scenes.submit(req);
						this.remember(reqKey, job);
						st.jobIds.push(job.id);
					} catch (e) {
						failed.push(e instanceof HttpError ? e.message : String(e));
					}
					continue;
				}
				if (!r) {
					missing++;
					continue;
				}
				data.cuts.push(...r.cuts);
				data.times.push(...r.times);
				data.scores.push(...r.scores);
				data.threshold = r.threshold;
			}
			if (data.cuts.length || data.times.length) results.set(mediaId, data);
		}
		const cues = sceneCutCues(doc, seq, results, range ? { range } : {});
		out.extraCues.push(...cues);
		st.found = cues.length;
		if (missing) st.state = 'missing';
		this.finish(st, 'scene', 'Shot changes in the footage', failed, out);
	}

	/**
	 * P6-E11 (wp-note "Phase 6 → WP-E7"): the beat analysis (beats, downbeats, drops, key) of every Essential Sound music
	 * clip in the range, by clip id — analysed inline (or only `cached`), at most `MAX_BEAT_CLIPS` clips. Media not in the
	 * engine, failures and missing cache entries are left out (with a warning).
	 */
	async musicInfo(
		doc: ProjectDocument,
		seq: Sequence,
		opts: {
			range?: { start: number; end: number };
			timeSignature?: TimeSignature;
			cachedOnly?: boolean;
			signal?: AbortSignal;
		} = {},
	): Promise<{ results: Map<string, BeatsResult>; warnings: EngineCueWarning[] }> {
		const results = new Map<string, BeatsResult>();
		const warnings: EngineCueWarning[] = [];
		const beats = this.deps.beats();
		if (!beats) return { results, warnings };
		for (const [i, c] of musicClips(doc, seq, opts.range).entries()) {
			if (i >= MAX_BEAT_CLIPS) {
				warnings.push({
					code: 'W_ANALYSIS_TRUNCATED',
					message: `Beats and keys were measured in the first ${MAX_BEAT_CLIPS} music clips only`,
					source: 'beat',
				});
				break;
			}
			const asset = doc.media[c.mediaId];
			const key = engineKey(asset);
			if (!key) {
				warnings.push({
					code: 'W_MEDIA_UNAVAILABLE',
					message: `${asset?.originalName ?? c.mediaId} is not in the engine's media store: its beats and key are unknown`,
					source: 'beat',
				});
				continue;
			}
			const req = beatRequestOf(key, c, opts.timeSignature);
			try {
				const r = opts.cachedOnly ? await beats.cached(req) : await beats.analyze(req, opts.signal);
				if (r) results.set(c.clipId, r);
			} catch (e) {
				if (opts.signal?.aborted) throw e;
				warnings.push({
					code: 'W_ANALYSIS_FAILED',
					message: `${asset?.originalName ?? 'A music clip'}: ${e instanceof Error ? e.message : String(e)}`,
					source: 'beat',
				});
			}
		}
		return { results, warnings };
	}

	private async beat(
		doc: ProjectDocument,
		seq: Sequence,
		range: { start: number; end: number } | undefined,
		mode: EngineCueMode,
		out: EngineCueResult,
		asCues: boolean,
		snap: boolean,
		signal?: AbortSignal,
		timeSignature?: TimeSignature,
	): Promise<void> {
		const st: EngineSourceState = { state: 'ready', jobIds: [], found: 0 };
		if (asCues) out.analysis.beat = st;
		const beats = this.deps.beats();
		const clips = musicClips(doc, seq, range);
		if (!clips.length) {
			st.state = 'none';
			st.message = 'No Essential Sound music clip in the range';
			if (snap) out.beatFrames = [];
			return;
		}
		if (!beats) {
			st.state = 'failed';
			st.message = 'Beat analysis is not available';
			if (snap) out.beatFrames = [];
			return;
		}
		const results = new Map<string, BeatData>();
		const failed: string[] = [];
		let missing = 0;
		for (const [i, c] of clips.entries()) {
			if (i >= MAX_BEAT_CLIPS) {
				out.warnings.push({
					code: 'W_ANALYSIS_TRUNCATED',
					message: `Beats were measured in the first ${MAX_BEAT_CLIPS} music clips only`,
					source: 'beat',
				});
				break;
			}
			const asset = doc.media[c.mediaId];
			const key = engineKey(asset);
			if (!key) {
				out.warnings.push({
					code: 'W_MEDIA_UNAVAILABLE',
					message: `${asset?.originalName ?? c.mediaId} is not in the engine's media store: no beats measured`,
					source: 'beat',
				});
				continue;
			}
			const req = beatRequestOf(key, c, timeSignature);
			try {
				const r =
					mode.kind === 'cached'
						? await beats.cached(req)
						: await beats.analyze(req, mode.kind === 'inline' ? mode.ctx.signal : signal);
				if (!r) {
					missing++;
					continue;
				}
				if (r.reason === 'NO_BEAT')
					out.warnings.push({
						code: 'W_NO_BEAT',
						message: `No steady beat found in ${asset?.originalName ?? 'a music clip'}`,
						source: 'beat',
					});
				results.set(c.clipId, { beats: r.beats, downbeats: r.downbeats, bpm: r.bpm });
			} catch (e) {
				failed.push(e instanceof Error ? e.message : String(e));
			}
		}
		const cues = beatCues(doc, seq, results, range ? { range } : {});
		if (asCues) out.extraCues.push(...cues);
		if (snap) out.beatFrames = [...new Set(cues.map((c) => c.frame))].sort((a, b) => a - b);
		st.found = cues.length;
		if (missing) st.state = 'missing';
		if (asCues) this.finish(st, 'beat', 'Beats of the music', failed, out);
	}

	private async pixel(
		doc: ProjectDocument,
		seq: Sequence,
		range: { start: number; end: number } | undefined,
		mode: EngineCueMode,
		out: EngineCueResult,
	): Promise<void> {
		const st: EngineSourceState = { state: 'ready', jobIds: [], found: 0 };
		out.analysis.pixel = st;
		const motion = this.deps.motion();
		if (!footageClips(doc, seq, range).length) {
			st.state = 'none';
			st.message = 'No footage in the range (graphics and keyframed layers have their own sources)';
			return;
		}
		if (!motion) {
			st.state = 'failed';
			st.message = 'Picture motion analysis is not available';
			return;
		}
		const rate = seq.settings.frameRate as Rational;
		const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
		const r = { start: Math.max(0, range?.start ?? 0), end: Math.min(duration, range?.end ?? duration) };
		const win = maxMotionFrames(rate);
		const anchorAt = sceneAnchorAt(doc, seq);
		const failed: string[] = [];
		const cues: ExtraCue[] = [];
		let missing = 0;
		for (let k = Math.floor(r.start / win); k * win < r.end; k++) {
			let plan: ReturnType<typeof planMotion>;
			try {
				plan = planMotion(doc, seq, { start: k * win, end: Math.min(duration, (k + 1) * win) });
			} catch (e) {
				if (e instanceof MotionInputError) continue;
				throw e;
			}
			const projectId = mode.kind === 'cached' ? null : mode.projectId;
			let res: MotionAnalysisResult | null = await motion.cached(plan, projectId);
			if (!res && mode.kind === 'inline') {
				try {
					res = await motion.analyzeInline(mode.ctx, doc, plan, projectId);
				} catch (e) {
					failed.push(e instanceof Error ? e.message : String(e));
					continue;
				}
			}
			if (!res && mode.kind === 'submit') {
				const key = `pixel:${plan.fingerprint}`;
				const why = this.failure(key);
				if (why) {
					failed.push(why);
					continue;
				}
				const job = motion.submit(doc, plan, {
					projectId: mode.projectId,
					...(mode.origin ? { origin: mode.origin } : {}),
					...(mode.revision !== undefined ? { revision: mode.revision } : {}),
				});
				this.remember(key, job);
				st.jobIds.push(job.id);
				continue;
			}
			if (!res) {
				missing++;
				continue;
			}
			out.pixelCurves.push({ startFrame: res.curve.startFrame, speed: res.curve.speed });
			const events = res.events as unknown as PixelMotionEvent[];
			const made = pixelMotionCues(res.curve, events, anchorAt).cues.filter(
				(c) => c.frame >= r.start && c.frame < r.end,
			);
			cues.push(...made);
		}
		out.extraCues.push(...cues);
		st.found = cues.length;
		if (missing) st.state = 'missing';
		this.finish(st, 'pixel', 'Picture motion', failed, out);
	}

	private finish(
		st: EngineSourceState,
		source: EngineCueSource,
		what: string,
		failed: string[],
		out: EngineCueResult,
	): void {
		if (st.jobIds.length) {
			st.state = 'pending';
			out.warnings.push({
				code: 'W_ANALYSIS_PENDING',
				message: `${what}: being analysed (${st.jobIds.length} job${st.jobIds.length > 1 ? 's' : ''}); ask again when ${st.jobIds.length > 1 ? 'they finish' : 'it finishes'} for its cues`,
				source,
				jobIds: [...st.jobIds],
			});
		}
		if (failed.length) {
			if (!st.jobIds.length && !st.found) st.state = 'failed';
			st.message = failed[0]!.slice(0, 300);
			out.warnings.push({
				code: 'W_ANALYSIS_FAILED',
				message: `${what}: the analysis failed (${failed[0]!.slice(0, 200)})`,
				source,
			});
		}
	}
}

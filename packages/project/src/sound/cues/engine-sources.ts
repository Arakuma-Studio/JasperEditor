// Engine cue sources (spec 12 §2.2 "Scene cuts (engine), beats (engine), pixel motion curve (engine, P6)", P6-R2):
// the engine measures media — shot changes inside footage (`scene-detect`), the beats of music (`/api/audio/beats`),
// the motion of the rendered picture (`motion-analysis`) — and these pure functions say what to measure (which clips,
// which media ranges) and turn the measurements into `ExtraCue`s for `deriveCues`:
//
// - scene: a shot change at media time c inside a footage clip is a `cut` at the first sequence frame whose shown media
//   time crosses c — through the clip's speed, reverse, time remap and frame hold (`clipMediaTimeFn`, the frame the
//   renderers show), the same rule as Scene Edit Detection's `clip.applySceneEdits`. A change whose neighbouring frames
//   also differ (a whip, a smear: the detector's score stays high around it) is a `move` instead. Anchor
//   `{type:'scene', mediaId, mediaSec, clipId}` with `mediaSec` = the media time shown at the cue frame, so
//   `resolveCueAnchor` finds that frame again and follows the clip.
// - beat: each beat of an Essential Sound music clip is a `beat` cue (downbeats support, the others ambient: beats are
//   never heroes) at the frame that plays it; anchor `{type:'beat', clipId, beatIndex, mediaSec}`.
// - pixel: `sceneAnchorAt` ties a picture-motion event to the topmost footage clip shown at its frame.
import { clipEnd } from '../../derive/index.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import type { CueAnchor, CueKind } from '../../schema/sound.ts';
import { FLICKS_PER_SECOND, type Rational } from '../../time.ts';
import { clipMediaTimeFn, frameAtContent, type TimedClip } from '../../time-remap/model.ts';
import { typesForVisualKind } from '../taxonomy.ts';
import type { DerivedCue, ExtraCue } from './types.ts';
import { clipName } from './util.ts';

/** Most frames scanned per clip when mapping shot changes (≈ 1.8 h at 30 fps). */
export const MAX_SCENE_SCAN_FRAMES = 200_000;
/** Most beats mapped per music clip. */
export const MAX_BEATS_PER_CLIP = 5_000;
/** A shot change counts from this far before its media time (seconds): frame timestamps are rounded to 1 µs. */
const SHOT_TOLERANCE_SEC = 0.001;
/** Neighbouring frames scoring this share of the detector's threshold make a change soft (a `move`). */
const SOFT_SCORE_SHARE = 0.6;

/** Beat snapping (`deriveCues` `snapToBeats`): the kinds that tolerate it, at most this many frames. */
export const BEAT_SNAP_FRAMES = 2;
export const BEAT_SNAP_KINDS: ReadonlySet<string> = new Set<CueKind>([
	'move',
	'transition',
	'emphasis',
	'reveal',
]);

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function rateOf(seq: Sequence): Rational | null {
	const r = seq?.settings?.frameRate as Rational | undefined;
	return r && Number.isSafeInteger(r.num) && Number.isSafeInteger(r.den) && r.num > 0 && r.den > 0 ? r : null;
}

function validClip(c: unknown): c is Clip {
	const x = c as Clip;
	return (
		!!x &&
		typeof x === 'object' &&
		typeof x.id === 'string' &&
		Number.isInteger(x.start) &&
		Number.isInteger(x.duration) &&
		x.duration > 0 &&
		!!x.speed &&
		fin(x.speed.rate) &&
		x.speed.rate > 0 &&
		fin(x.sourceIn)
	);
}

export type EngineSourceClip = {
	clipId: string;
	mediaId: string;
	trackId: string;
	/** Sequence frames `[start, end)` of the clip inside the range. */
	start: number;
	end: number;
	/** Media seconds the clip shows (or plays) there, smallest … largest. */
	mediaStartSec: number;
	mediaEndSec: number;
};

/** Media seconds a clip shows over sequence frames `[a, b)` (sampled at its frames; exact for linear clips). */
function mediaSpan(c: Clip, rate: Rational, a: number, b: number): { lo: number; hi: number } {
	const at = clipMediaTimeFn(c as unknown as TimedClip, rate);
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	const n = b - a;
	const stride = Math.max(1, Math.ceil(n / 20_000));
	for (let f = a; f < b; f += stride) {
		const m = at(f);
		if (m < lo) lo = m;
		if (m > hi) hi = m;
	}
	const last = at(b - 1);
	lo = Math.min(lo, last);
	hi = Math.max(hi, last);
	return { lo: lo / FLICKS_PER_SECOND, hi: hi / FLICKS_PER_SECOND };
}

function rangeOf(seq: Sequence, range?: { start: number; end: number }): { start: number; end: number } {
	let end = 0;
	for (const c of Object.values(seq.clips ?? {})) if (validClip(c)) end = Math.max(end, clipEnd(c));
	const s = fin(range?.start) ? Math.max(0, Math.floor(range!.start)) : 0;
	const e = fin(range?.end) ? Math.min(end, Math.ceil(range!.end)) : end;
	return { start: s, end: Math.max(s, e) };
}

/** Enabled footage (video clips of a media) on shown video tracks, intersecting the range: what scene / pixel analyse. */
export function footageClips(
	doc: ProjectDocument,
	seq: Sequence,
	range?: { start: number; end: number },
): EngineSourceClip[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const r = rangeOf(seq, range);
		const shown = new Set(
			(Array.isArray(seq.videoTracks) ? seq.videoTracks : [])
				.filter((t) => t && t.output !== false)
				.map((t) => t.id),
		);
		const out: EngineSourceClip[] = [];
		for (const c of Object.values(seq.clips ?? {})) {
			if (!validClip(c) || c.kind !== 'video' || c.enabled === false || !shown.has(c.trackId)) continue;
			const mediaId = (c as { mediaId?: unknown }).mediaId;
			if (typeof mediaId !== 'string' || !doc?.media || !Object.hasOwn(doc.media, mediaId)) continue;
			const a = Math.max(c.start, r.start);
			const b = Math.min(clipEnd(c), r.end);
			if (b <= a) continue;
			const span = mediaSpan(c, rate, a, b);
			if (!fin(span.lo) || !fin(span.hi)) continue;
			out.push({
				clipId: c.id,
				mediaId,
				trackId: c.trackId,
				start: a,
				end: b,
				mediaStartSec: Math.max(0, span.lo),
				mediaEndSec: Math.max(0, span.hi),
			});
		}
		return out.sort((x, y) => x.start - y.start || (x.clipId < y.clipId ? -1 : 1));
	} catch {
		return [];
	}
}

/** Enabled Essential Sound music clips on unmuted audio tracks, intersecting the range: what the beat source analyses. */
export function musicClips(
	doc: ProjectDocument,
	seq: Sequence,
	range?: { start: number; end: number },
): EngineSourceClip[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const r = rangeOf(seq, range);
		const live = new Set(
			(Array.isArray(seq.audioTracks) ? seq.audioTracks : []).filter((t) => t && !t.mute).map((t) => t.id),
		);
		const out: EngineSourceClip[] = [];
		for (const c of Object.values(seq.clips ?? {})) {
			if (!validClip(c) || c.kind !== 'audio' || c.enabled === false || !live.has(c.trackId)) continue;
			const ess = (c as { essential?: { type?: unknown } }).essential;
			if (!ess || typeof ess !== 'object' || ess.type !== 'music') continue;
			const mediaId = (c as { mediaId?: unknown }).mediaId;
			if (typeof mediaId !== 'string' || !doc?.media || !Object.hasOwn(doc.media, mediaId)) continue;
			const a = Math.max(c.start, r.start);
			const b = Math.min(clipEnd(c), r.end);
			if (b <= a) continue;
			const span = mediaSpan(c, rate, a, b);
			if (!fin(span.lo) || !fin(span.hi)) continue;
			out.push({
				clipId: c.id,
				mediaId,
				trackId: c.trackId,
				start: a,
				end: b,
				mediaStartSec: Math.max(0, span.lo),
				mediaEndSec: Math.max(0, span.hi),
			});
		}
		return out.sort((x, y) => x.start - y.start || (x.clipId < y.clipId ? -1 : 1));
	} catch {
		return [];
	}
}

/** The shot changes of a media (scene detection): media seconds of each new shot's first frame. */
export type SceneCutData = {
	cuts: readonly number[];
	/** Per analysed frame: its media time and dissimilarity to the previous frame (optional; soft changes). */
	times?: readonly number[];
	scores?: readonly number[];
	threshold?: number;
};

function lowerBound(xs: readonly number[], v: number): number {
	let lo = 0;
	let hi = xs.length;
	while (lo < hi) {
		const m = (lo + hi) >> 1;
		if (xs[m]! < v) lo = m + 1;
		else hi = m;
	}
	return lo;
}

/** Whether the detector's scores stay high around the change at media time `t` (a soft, smeared change). */
function softChange(d: SceneCutData, t: number): boolean {
	const times = d.times;
	const scores = d.scores;
	if (!times || !scores || !fin(d.threshold) || d.threshold <= 0 || times.length !== scores.length)
		return false;
	const i = lowerBound(times, t - SHOT_TOLERANCE_SEC);
	if (i <= 0 || i >= times.length) return false;
	const lim = SOFT_SCORE_SHARE * d.threshold;
	return (
		fin(scores[i - 1]) &&
		scores[i - 1]! >= lim &&
		i + 1 < scores.length &&
		fin(scores[i + 1]) &&
		scores[i + 1]! >= lim
	);
}

/**
 * Cues of the shot changes inside footage clips. `results` maps a media id to its scene detection (the cuts must cover
 * the media the clips show; cuts outside their analysed span simply do not occur).
 */
export function sceneCutCues(
	doc: ProjectDocument,
	seq: Sequence,
	results: ReadonlyMap<string, SceneCutData>,
	opts: { range?: { start: number; end: number } } = {},
): ExtraCue[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const out: ExtraCue[] = [];
		for (const fc of footageClips(doc, seq, opts.range)) {
			const data = results.get(fc.mediaId);
			if (!data || !Array.isArray(data.cuts) || data.cuts.length === 0) continue;
			const c = seq.clips[fc.clipId]!;
			const cuts = [...data.cuts].filter(fin).sort((a, b) => a - b);
			const at = clipMediaTimeFn(c as unknown as TimedClip, rate);
			const shot = (mFlicks: number) =>
				lowerBound(cuts, mFlicks / FLICKS_PER_SECOND + SHOT_TOLERANCE_SEC + 1e-12);
			// The clip's first frame is an edit point (the edits source), not a change inside the footage.
			const from = Math.max(c.start + 1, fc.start);
			const to = Math.min(fc.end, from + MAX_SCENE_SCAN_FRAMES);
			if (to <= from) continue;
			let prev = shot(at(from - 1));
			const where = `${clipName(c)}`;
			for (let f = from; f < to; f++) {
				const m = at(f);
				const s = shot(m);
				if (s === prev) continue;
				// The change the picture crosses (forward: the new shot's first frame; reverse: the old one's last).
				const k = Math.min(s, prev);
				const t = cuts[k] ?? cuts[cuts.length - 1]!;
				prev = s;
				const mediaSec = m / FLICKS_PER_SECOND;
				const soft = softChange(data, t);
				const anchor: CueAnchor = { type: 'scene', mediaId: fc.mediaId, mediaSec, clipId: c.id };
				out.push({
					key: `scene:${c.id}:${Math.round(t * 1000)}`,
					frame: f,
					kind: soft ? 'move' : 'cut',
					weight: 'support',
					types: soft ? ['whoosh', 'swish', 'transition'] : ['hit', 'thump', 'transition', 'glitch', 'click'],
					align: 'peak',
					anchor,
					confidence: soft ? 0.4 : 0.45,
					reason: `${soft ? 'Fast shot change' : 'Shot change'} inside ${where} (media ${t.toFixed(2)} s)`,
					from: 'scene',
					size: 1,
				});
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** The beats of one music clip's range (`/api/audio/beats`): media seconds, optional downbeats, tempo. */
export type BeatData = {
	beats: readonly number[];
	downbeats?: readonly number[] | null;
	bpm?: number | null;
};

/** The sequence frame that plays media time `sec` of a clip (rounded like `resolveCueAnchor`), or null. */
export function clipFrameOfMediaSec(c: Clip, sec: number, rate: Rational): number | null {
	if (!validClip(c) || !fin(sec)) return null;
	const f = frameAtContent(c, sec * FLICKS_PER_SECOND, rate);
	if (f < c.start - 0.5 || f >= c.start + c.duration - 0.5 + 1e-9) return null;
	return Math.round(f);
}

/** Beat cues of Essential music clips; `results` maps a clip id to the beats of its media range. */
export function beatCues(
	doc: ProjectDocument,
	seq: Sequence,
	results: ReadonlyMap<string, BeatData>,
	opts: { range?: { start: number; end: number } } = {},
): ExtraCue[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const types = typesForVisualKind('beat').slice(0, 5);
		const out: ExtraCue[] = [];
		for (const mc of musicClips(doc, seq, opts.range)) {
			const data = results.get(mc.clipId);
			if (!data || !Array.isArray(data.beats)) continue;
			const c = seq.clips[mc.clipId]!;
			const down = new Set((data.downbeats ?? []).filter(fin).map((x) => Math.round(x * 1000)));
			const bpm = fin(data.bpm) ? ` at ${Math.round(data.bpm)} BPM` : '';
			let n = 0;
			data.beats.forEach((sec, beatIndex) => {
				if (n >= MAX_BEATS_PER_CLIP || !fin(sec)) return;
				const frame = clipFrameOfMediaSec(c, sec, rate);
				if (frame === null || frame < mc.start || frame >= mc.end) return;
				n++;
				const isDown = down.has(Math.round(sec * 1000));
				out.push({
					key: `beat:${c.id}:${beatIndex}`,
					frame,
					kind: 'beat',
					weight: isDown ? 'support' : 'ambient',
					types,
					align: 'peak',
					anchor: { type: 'beat', clipId: c.id, beatIndex, mediaSec: sec },
					confidence: isDown ? 0.35 : 0.25,
					reason: `${isDown ? 'Downbeat' : 'Beat'} ${beatIndex + 1} of ${clipName(c)}${bpm}`,
					from: 'beat',
					size: 1,
				});
			});
		}
		return out;
	} catch {
		return [];
	}
}

/** Sorted, unique sequence frames of beats (for `snapToBeats`). */
export function beatFramesOf(cues: readonly ExtraCue[]): number[] {
	return [...new Set(cues.filter((c) => c.from === 'beat').map((c) => c.frame))].sort((a, b) => a - b);
}

/**
 * Moves cues of the kinds that tolerate it (move, transition, emphasis, reveal; not cuts, lands, appearances, exits,
 * markers or beats) onto the nearest beat within `BEAT_SNAP_FRAMES`, recording the shift as `anchorOffset` so the cue
 * keeps following its picture event. Returns the cues (new objects for snapped ones) and how many moved.
 */
export function snapCuesToBeats(
	cues: readonly DerivedCue[],
	beatFrames: readonly number[],
	maxFrames = BEAT_SNAP_FRAMES,
): { cues: DerivedCue[]; snapped: number } {
	if (!Array.isArray(cues)) return { cues: [], snapped: 0 };
	const beats = (Array.isArray(beatFrames) ? beatFrames : [])
		.filter((f) => Number.isInteger(f))
		.sort((a, b) => a - b);
	const lim = Math.max(0, Math.min(BEAT_SNAP_FRAMES, Math.floor(fin(maxFrames) ? maxFrames : 0)));
	if (!beats.length || lim === 0) return { cues: [...cues], snapped: 0 };
	let snapped = 0;
	const out = cues.map((c) => {
		if (!BEAT_SNAP_KINDS.has(c.kind) || c.source === 'marker' || c.from === 'beat') return c;
		const i = lowerBound(beats, c.frame);
		let best: number | null = null;
		for (const j of [i - 1, i]) {
			const b = beats[j];
			if (b === undefined) continue;
			if (best === null || Math.abs(b - c.frame) < Math.abs(best - c.frame)) best = b;
		}
		if (best === null || best === c.frame || Math.abs(best - c.frame) > lim) return c;
		const shift = best - c.frame;
		snapped++;
		return {
			...c,
			frame: best,
			anchorOffset: (c.anchorOffset ?? 0) + shift,
			reason: `${c.reason}; on the beat (${shift > 0 ? '+' : ''}${shift} frame${Math.abs(shift) === 1 ? '' : 's'})`,
		};
	});
	return { cues: out, snapped };
}

/**
 * The anchor of a picture-motion event at a sequence frame: the topmost enabled footage clip shown there (a `scene`
 * anchor at the media time it shows), with a name for reasons; null when no footage is shown there.
 */
export function sceneAnchorAt(
	doc: ProjectDocument,
	seq: Sequence,
): (frame: number) => { anchor: CueAnchor; where: string } | null {
	const rate = rateOf(seq);
	const tracks = (Array.isArray(seq?.videoTracks) ? seq.videoTracks : [])
		.map((t, index) => ({ t, index }))
		.filter(({ t }) => t && t.output !== false);
	const index = new Map(tracks.map(({ t, index }) => [t.id, index]));
	const clips: Clip[] = [];
	for (const c of Object.values(seq?.clips ?? {}))
		if (validClip(c) && c.kind === 'video' && c.enabled !== false && index.has(c.trackId)) {
			const mediaId = (c as { mediaId?: unknown }).mediaId;
			if (typeof mediaId === 'string' && doc?.media && Object.hasOwn(doc.media, mediaId)) clips.push(c);
		}
	return (frame: number) => {
		if (!rate || !Number.isInteger(frame)) return null;
		let best: Clip | null = null;
		for (const c of clips)
			if (
				frame >= c.start &&
				frame < clipEnd(c) &&
				(!best || index.get(c.trackId)! > index.get(best.trackId)!)
			)
				best = c;
		if (!best) return null;
		const m = clipMediaTimeFn(best as unknown as TimedClip, rate)(frame);
		if (!fin(m) || m < 0) return null;
		const label = tracks.find((x) => x.t.id === best!.trackId);
		return {
			anchor: {
				type: 'scene',
				mediaId: (best as { mediaId: string }).mediaId,
				mediaSec: m / FLICKS_PER_SECOND,
				clipId: best.id,
			},
			where: `${clipName(best)} on V${(label?.index ?? 0) + 1}`,
		};
	};
}

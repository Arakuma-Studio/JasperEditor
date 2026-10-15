// Cue anchors (spec 12 §2.2): where in the edit a sound cue's picture event is now. `resolveCueAnchor` maps every
// `CueAnchor` variant to a sequence frame (or null when the event no longer exists or cannot be located); the cue
// deriver (`sound/cues/`) and `soundCue.resync` both use it, so a derived cue and a resynced one agree. Pure; never
// throws on hostile documents (bounded loops, every lookup guarded).
//
// | Anchor | Frame |
// |---|---|
// | `edit` | the incoming clip's first frame (else the outgoing clip's end) |
// | `transition` | the visual centre of the transition's span: `start + ⌊duration / 2⌋` |
// | `keyframe` | `start` / `end`: the run's first / last key (or `keyframeId`); `peak-speed`: the middle of the fastest
// |   | stretch of the run, sampled per frame; `settle`: the first frame after the peak at which the value reaches its
// |   | rest value (within 1 % of the travel) — the first arrival of an overshoot. With `keyframeId` the run is the
// |   | segment that ends at that key. |
// | `text` | In: the clip's first frame (typewriter `unit` i: the frame it is typed on); Out: the Out window's first
// |   | frame (`unit` i: the frame the i-th deleted unit goes) |
// | `mg` | intro end / outro start of the template (its frames are written at 30 fps and scaled like the renderer) |
// | `clip` | the clip's first frame or its end (the first frame after it) |
// | `scene` | the first frame (earliest clip) that shows `mediaSec` of the media |
// | `beat` | the frame of the clip that shows `mediaSec` (when known) |
// | `marker` | the sequence marker's frame (or a clip marker's frame) |
import { evaluateKeyframes } from '../keyframes.ts';
import type { MgTemplateRegistry } from '../registry/mg.ts';
import type { Animatable } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { type CueAnchor, SOUND_DESIGN_LIMITS } from '../schema/sound.ts';
import { resolveTextAnimationWindows } from '../text-animations.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { activeRemap, clipMediaTimeFn, frameAtContent } from '../time-remap/model.ts';
import { transitionStartFrame } from '../transitions.ts';

export type AnchorResolveOptions = {
	/** Motion-graphic templates (intro/outro lengths of `mg` anchors); without it `mg` anchors resolve to null. */
	mgTemplates?: Pick<MgTemplateRegistry, 'get'>;
};

/** The parts of a document anchors read. */
export type AnchorDocument = Pick<ProjectDocument, 'media'>;
/** The parts of a sequence anchors read. */
export type AnchorSequence = Pick<Sequence, 'clips' | 'transitions' | 'markers' | 'settings'>;

/** Reference rate of motion-graphic `introFrames` / `outroFrames` (the anime layer's `ANIME_REFERENCE_FPS`). */
export const MG_REFERENCE_FPS = 30;
/** Most frames a keyframe run is sampled at (longer runs are sampled with a stride). */
const MAX_SAMPLES = 50_000;
/** Most clips a `scene` anchor inspects. */
const MAX_SCENE_CLIPS = 10_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function rateOf(seq: AnchorSequence): Rational | null {
	const r = seq.settings?.frameRate as Rational | undefined;
	if (!r || !Number.isSafeInteger(r.num) || !Number.isSafeInteger(r.den) || r.num <= 0 || r.den <= 0)
		return null;
	return r;
}

/** A clip of the sequence by id (own property only), or null. */
function clipOf(seq: AnchorSequence, id: string): Clip | null {
	if (!isRecord(seq.clips) || !Object.hasOwn(seq.clips, id)) return null;
	const c = seq.clips[id] as Clip | undefined;
	return c && fin(c.start) && fin(c.duration) ? c : null;
}

/** A frame inside the sequence's range of frames, or null. */
function frameOrNull(f: number): number | null {
	if (!Number.isFinite(f)) return null;
	const r = Math.round(f);
	return r >= 0 && r <= SOUND_DESIGN_LIMITS.maxFrame ? r : null;
}

/** Whether frame `f` is within the clip (its first frame … its end inclusive, half a frame of tolerance). */
const withinClip = (c: Clip, f: number) => f >= c.start - 0.5 && f <= c.start + c.duration + 0.5;

/**
 * The sequence frame an anchor's picture event is on now, or null (the clip, transition, marker or keyframe is gone,
 * or the event cannot be located). `opts.mgTemplates` resolves `mg` anchors.
 */
export function resolveCueAnchor(
	doc: AnchorDocument,
	seq: AnchorSequence,
	anchor: CueAnchor | null | undefined,
	opts: AnchorResolveOptions = {},
): number | null {
	try {
		return resolve(doc, seq, anchor, opts);
	} catch {
		// A damaged document (never a valid one) must not take the caller down.
		return null;
	}
}

function resolve(
	doc: AnchorDocument,
	seq: AnchorSequence,
	anchor: CueAnchor | null | undefined,
	opts: AnchorResolveOptions,
): number | null {
	if (!isRecord(anchor) || !seq || !isRecord(seq.clips)) return null;
	switch (anchor.type) {
		case 'edit': {
			const out = clipOf(seq, anchor.outgoingClipId);
			const inc = clipOf(seq, anchor.incomingClipId);
			if (inc) return frameOrNull(inc.start);
			if (out) return frameOrNull(out.start + out.duration);
			return null;
		}
		case 'transition': {
			const t =
				isRecord(seq.transitions) && Object.hasOwn(seq.transitions, anchor.transitionId)
					? seq.transitions[anchor.transitionId]
					: undefined;
			if (!t || !fin(t.duration)) return null;
			const start = transitionStartFrame(seq, t);
			return start === null ? null : frameOrNull(start + Math.floor(t.duration / 2));
		}
		case 'clip': {
			const c = clipOf(seq, anchor.clipId);
			if (!c) return null;
			return frameOrNull(anchor.edge === 'end' ? c.start + c.duration : c.start);
		}
		case 'marker':
			return markerFrame(seq, anchor.markerId);
		case 'keyframe':
			return keyframeAnchorFrame(seq, anchor);
		case 'text':
			return textAnchorFrame(seq, anchor);
		case 'mg':
			return mgAnchorFrame(seq, anchor, opts);
		case 'scene': {
			if (!isRecord(doc?.media) || !Object.hasOwn(doc.media, anchor.mediaId)) return null;
			const rate = rateOf(seq);
			if (!rate || !fin(anchor.mediaSec)) return null;
			const m = anchor.mediaSec * FLICKS_PER_SECOND;
			let best: number | null = null;
			let n = 0;
			for (const c of Object.values(seq.clips)) {
				if (++n > MAX_SCENE_CLIPS) break;
				if ((c as { mediaId?: unknown }).mediaId !== anchor.mediaId) continue;
				const f = mediaTimeFrame(c, m, rate);
				if (f !== null && (best === null || f < best)) best = f;
			}
			return best;
		}
		case 'beat': {
			const c = clipOf(seq, anchor.clipId);
			const rate = rateOf(seq);
			if (!c || !rate || !fin(anchor.mediaSec)) return null;
			return mediaTimeFrame(c, anchor.mediaSec * FLICKS_PER_SECOND, rate);
		}
		default:
			return null;
	}
}

/** The frame a sequence marker (or a clip marker, through its clip) is on. */
function markerFrame(seq: AnchorSequence, markerId: string): number | null {
	if (Array.isArray(seq.markers))
		for (const m of seq.markers) if (m?.id === markerId && fin(m.frame)) return frameOrNull(m.frame);
	const rate = rateOf(seq);
	if (!rate) return null;
	for (const c of Object.values(seq.clips)) {
		const list = (c as { markers?: unknown }).markers;
		if (!Array.isArray(list)) continue;
		for (const m of list)
			if (isRecord(m) && m.id === markerId && fin(m.flicks)) {
				const f = frameAtContent(c, m.flicks, rate);
				return withinClip(c, f) ? frameOrNull(f) : null;
			}
	}
	return null;
}

/** The first frame of a clip that shows media time `m` (flicks), or null when the clip never shows it. */
function mediaTimeFrame(c: Clip, m: number, rate: Rational): number | null {
	if (!fin(c.start) || !fin(c.duration) || c.duration < 1 || !c.speed) return null;
	if (!c.frameHold && !activeRemap(c)) {
		const f = frameAtContent(c, m, rate);
		if (f < c.start - 0.5 || f >= c.start + c.duration - 0.5 + 1e-9) return null;
		return frameOrNull(f);
	}
	// Time-remapped or held: scan the clip's frames for the first one that reaches `m` (bounded).
	const at = clipMediaTimeFn(c, rate);
	const half = flicksPerFrame(rate) / 2;
	const n = Math.min(c.duration, MAX_SAMPLES);
	let prev = at(c.start);
	if (Math.abs(prev - m) <= half) return frameOrNull(c.start);
	for (let i = 1; i < n; i++) {
		const v = at(c.start + i);
		if (Math.abs(v - m) <= half || (prev - m) * (v - m) < 0) return frameOrNull(c.start + i);
		prev = v;
	}
	return null;
}

/** The animatable at a property path of a clip (`transform.position`, `opacity`, `effects.<fxId>.params.<name>`). */
export function anchorAnimatable(clip: unknown, property: string): Animatable<unknown> | null {
	if (typeof property !== 'string' || property.length === 0 || property.length > SOUND_DESIGN_LIMITS.property)
		return null;
	let cur: unknown = clip;
	for (const seg of property.split('.')) {
		if (Array.isArray(cur)) cur = cur.find((x) => isRecord(x) && x.id === seg);
		else if (isRecord(cur) && Object.hasOwn(cur, seg)) cur = cur[seg];
		else return null;
		if (cur === undefined || cur === null) return null;
	}
	if (!isRecord(cur) || !Array.isArray(cur.keyframes) || !('value' in cur)) return null;
	return cur as unknown as Animatable<unknown>;
}

/** Distance between two values of a property (numbers, numeric tuples), or null when they are not comparable. */
function valueDistance(a: unknown, b: unknown): number | null {
	if (fin(a) && fin(b)) return Math.abs(a - b);
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.length > 0 && a.length <= 16) {
		let s = 0;
		for (let i = 0; i < a.length; i++) {
			if (!fin(a[i]) || !fin(b[i])) return null;
			s += (a[i] - b[i]) ** 2;
		}
		return Math.sqrt(s);
	}
	return null;
}

function keyframeAnchorFrame(
	seq: AnchorSequence,
	a: Extract<CueAnchor, { type: 'keyframe' }>,
): number | null {
	const c = clipOf(seq, a.clipId);
	const rate = rateOf(seq);
	if (!c || !rate || !c.speed) return null;
	const anim = anchorAnimatable(c, a.property);
	if (!anim) return null;
	const kfs = anim.keyframes.filter((k) => isRecord(k) && fin(k.time));
	if (kfs.length === 0) return null;
	let i0 = 0;
	let i1 = kfs.length - 1;
	if (a.keyframeId !== undefined) {
		const i = kfs.findIndex((k) => k.id === a.keyframeId);
		if (i < 0) return null;
		i1 = i;
		i0 = Math.max(0, i - 1);
	}
	const frameOfTime = (t: number): number | null => {
		const f = frameAtContent(c, t, rate);
		return withinClip(c, f) ? frameOrNull(f) : null;
	};
	if (a.event === 'start') return frameOfTime(kfs[a.keyframeId !== undefined ? i1 : i0]!.time);
	if (a.event === 'end') return frameOfTime(kfs[i1]!.time);
	if (i1 <= i0) return a.event === 'settle' ? frameOfTime(kfs[i1]!.time) : null;
	// Sample the run per sequence frame (stride for very long runs), clipped to the clip's frames.
	const fa0 = frameAtContent(c, kfs[i0]!.time, rate);
	const fb0 = frameAtContent(c, kfs[i1]!.time, rate);
	const fa = Math.max(c.start, Math.ceil(Math.min(fa0, fb0) - 1e-9));
	const fb = Math.min(c.start + c.duration, Math.floor(Math.max(fa0, fb0) + 1e-9));
	if (!(fb > fa)) return null;
	const stride = Math.max(1, Math.ceil((fb - fa) / MAX_SAMPLES));
	const frames: number[] = [];
	for (let f = fa; f <= fb; f += stride) frames.push(f);
	if (frames[frames.length - 1] !== fb) frames.push(fb);
	const values = frames.map((f) => evaluateKeyframes(anim, contentAt(c, f, rate)));
	const speeds: number[] = [];
	for (let k = 0; k + 1 < values.length; k++) {
		const d = valueDistance(values[k], values[k + 1]);
		if (d === null) return null;
		speeds.push(d / (frames[k + 1]! - frames[k]!));
	}
	const max = Math.max(...speeds);
	if (!(max > 0)) return null;
	const tol = max * 1e-6;
	const runStart = speeds.findIndex((s) => s >= max - tol);
	let runEnd = runStart;
	while (runEnd + 1 < speeds.length && speeds[runEnd + 1]! >= max - tol) runEnd++;
	if (a.event === 'peak-speed') {
		// Middle of the fastest stretch (a linear move: its middle; an eased one: its fastest frame).
		const lo = frames[runStart]!;
		const hi = frames[runEnd + 1]!;
		return frameOrNull(Math.floor((lo + hi) / 2 + 1e-9));
	}
	// settle: the first frame after the peak at which the value reaches its rest (last) value within 1 % of the travel.
	const rest = values[values.length - 1];
	let travel = 0;
	for (const v of values) travel = Math.max(travel, valueDistance(v, rest) ?? 0);
	const near = Math.max(travel * 0.01, 1e-9);
	for (let k = runStart + 1; k < values.length; k++)
		if ((valueDistance(values[k], rest) ?? Number.POSITIVE_INFINITY) <= near) return frameOrNull(frames[k]!);
	return frameOrNull(frames[frames.length - 1]!);
}

/** Content time (flicks) shown at frame `f` (the inverse of `frameAtContent`). */
function contentAt(c: Clip, f: number, rate: Rational): number {
	const step = flicksPerFrame(rate) * c.speed.rate;
	const i = c.speed.reverse ? c.start + c.duration - 1 - f : f - c.start;
	return c.sourceIn + i * step;
}

/** Typed units of a text (`char`: every non-space character; `word`: whitespace-separated words). */
export function textUnitCount(text: string, unit: 'char' | 'word'): number {
	if (typeof text !== 'string' || text.length === 0) return 0;
	if (unit === 'word') return text.split(/\s+/).filter(Boolean).length;
	const Seg = (globalThis as { Intl?: { Segmenter?: new (l?: string, o?: object) => unknown } }).Intl
		?.Segmenter;
	if (Seg) {
		const seg = new Seg(undefined, { granularity: 'grapheme' }) as {
			segment(s: string): Iterable<{ segment: string }>;
		};
		let n = 0;
		for (const s of seg.segment(text)) if (!/^\s+$/.test(s.segment)) n++;
		return n;
	}
	return Array.from(text).filter((ch) => !/\s/.test(ch)).length;
}

/**
 * Keystroke schedule of a typewriter window (the renderer's `typewriterSchedule`, `@jasper/motion`): unit `i` is typed
 * at `start + slot·i` ms; `delay` / `typing` are fractions of the window (typewriter@1 has neither).
 */
export function typewriterScheduleMs(
	units: number,
	durationMs: number,
	params: Record<string, unknown>,
): { start: number; slot: number } {
	const num = (v: unknown, d: number) => (fin(v) ? v : d);
	const total = Math.max(1, durationMs);
	const delay = Math.min(0.9, Math.max(0, num(params.delay, 0)));
	const typing = Math.min(1 - delay, Math.max(0.05, num(params.typing, 1)));
	return { start: total * delay, slot: (total * typing) / Math.max(1, Math.floor(units)) };
}

function textAnchorFrame(seq: AnchorSequence, a: Extract<CueAnchor, { type: 'text' }>): number | null {
	const c = clipOf(seq, a.clipId);
	const rate = rateOf(seq);
	if (c?.kind !== 'text' || !rate) return null;
	const w = resolveTextAnimationWindows(c);
	const win = a.side === 'in' ? w.in : w.out;
	const base = a.side === 'in' ? c.start : c.start + c.duration - (w.out?.frames ?? 0);
	if (a.unit === undefined) return frameOrNull(base);
	if (win?.preset !== 'typewriter' || win.frames < 1) return null;
	const unit = win.params.unit === 'word' ? 'word' : 'char';
	const n = textUnitCount((c as { content?: { text?: unknown } }).content?.text as string, unit);
	if (a.unit >= n) return null;
	const fps = rate.num / rate.den;
	const D = (win.frames * 1000) / fps;
	const s = typewriterScheduleMs(n, D, win.params);
	// In: unit i is shown from the first frame at or after its keystroke. Out plays the In timeline backwards: the
	// i-th deleted unit (the (n−1−i)-th typed) goes when the reversed time passes its keystroke.
	const ms = a.side === 'in' ? s.start + s.slot * a.unit : D - (s.start + s.slot * (n - 1 - a.unit));
	const off = Math.min(win.frames, Math.max(0, Math.ceil((ms * fps) / 1000 - 1e-9)));
	return frameOrNull(base + off);
}

function mgAnchorFrame(
	seq: AnchorSequence,
	a: Extract<CueAnchor, { type: 'mg' }>,
	opts: AnchorResolveOptions,
): number | null {
	const c = clipOf(seq, a.clipId);
	const rate = rateOf(seq);
	if (c?.kind !== 'motion-graphic' || !rate || !opts.mgTemplates) return null;
	const tpl = (c as { template?: { id?: unknown; version?: unknown } }).template;
	if (!tpl || typeof tpl.id !== 'string' || !fin(tpl.version)) return null;
	const info = opts.mgTemplates.get(tpl.id, tpl.version);
	if (!info) return null;
	const fps = rate.num / rate.den;
	const at = (ref: number) => (fin(ref) ? Math.max(0, Math.round((ref * fps) / MG_REFERENCE_FPS)) : 0);
	const sourceIn = Math.max(0, Math.round((fin(c.sourceIn) ? c.sourceIn : 0) / flicksPerFrame(rate)));
	const total = Math.max(1, sourceIn + Math.max(1, c.duration));
	let intro = at(info.introFrames);
	let outro = at(info.outroFrames);
	if (intro + outro > total) {
		const sum = intro + outro;
		intro = Math.floor((total * intro) / sum);
		outro = total - intro;
	}
	const local = a.event === 'intro-end' ? intro - sourceIn : total - outro - sourceIn;
	if (local < 0 || local > c.duration) return null;
	return frameOrNull(c.start + local);
}

/** Ids an anchor refers to (clips, transition, marker, media). */
export function cueAnchorRefs(anchor: CueAnchor | null | undefined): string[] {
	if (!isRecord(anchor)) return [];
	switch (anchor.type) {
		case 'edit':
			return [anchor.outgoingClipId, anchor.incomingClipId];
		case 'transition':
			return [anchor.transitionId];
		case 'marker':
			return [anchor.markerId];
		case 'scene':
			return [anchor.mediaId];
		case 'keyframe':
		case 'text':
		case 'mg':
		case 'clip':
		case 'beat':
			return [anchor.clipId];
		default:
			return [];
	}
}

/**
 * Whether an anchor's target still exists (repair: an anchor whose clip, transition, marker or media is gone is
 * dangling; `edit` needs both clips, `keyframe` its keyframe when it names one). Says nothing about resolvability.
 */
export function cueAnchorTargetExists(
	doc: AnchorDocument,
	seq: AnchorSequence,
	anchor: CueAnchor | null | undefined,
): boolean {
	if (!isRecord(anchor)) return true;
	switch (anchor.type) {
		case 'edit':
			return !!clipOf(seq, anchor.outgoingClipId) && !!clipOf(seq, anchor.incomingClipId);
		case 'transition':
			return isRecord(seq.transitions) && Object.hasOwn(seq.transitions, anchor.transitionId);
		case 'marker':
			return markerExists(seq, anchor.markerId);
		case 'scene':
			return isRecord(doc?.media) && Object.hasOwn(doc.media, anchor.mediaId);
		case 'keyframe': {
			const c = clipOf(seq, anchor.clipId);
			if (!c) return false;
			if (anchor.keyframeId === undefined) return true;
			const anim = anchorAnimatable(c, anchor.property);
			return !!anim && anim.keyframes.some((k) => isRecord(k) && k.id === anchor.keyframeId);
		}
		case 'text':
		case 'mg':
		case 'clip':
		case 'beat':
			return !!clipOf(seq, anchor.clipId);
		default:
			return true;
	}
}

function markerExists(seq: AnchorSequence, markerId: string): boolean {
	if (Array.isArray(seq.markers) && seq.markers.some((m) => m?.id === markerId)) return true;
	for (const c of Object.values(seq.clips ?? {})) {
		const list = (c as { markers?: unknown }).markers;
		if (Array.isArray(list) && list.some((m) => isRecord(m) && m.id === markerId)) return true;
	}
	return false;
}

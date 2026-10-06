// Time Remapping (workstream `time`, docs/wp-notes/time.md): evaluation of a clip's remap curve.
//
// A clip has two time axes:
// - content time `c` (flicks): the keyframe axis. `contentTimeAt(clip, frame)` = sourceIn + i·F·rate (or reversed);
//   Motion, Opacity and effect keyframes are evaluated there, so a remap never moves them;
// - media time `m` (flicks from the start of the media): which picture is shown. Without a remap m = c.
//
// The remap `R: c → m` is piecewise linear through its keyframes (c_k, m_k) — a constant speed between two
// keyframes: forward, reverse (m decreasing) or a freeze (m constant) — extended before the first and after the last
// keyframe with the slopes `speedBefore` / `speedAfter` (default 1). A keyframe with `ramp = r > 0` replaces the
// corner by a speed transition over [c_k − r, c_k + r] whose speed goes from the left slope v1 to the right slope v2
// along E(x) = (1 − e)·x + e·(3x² − 2x³) (e = `ease`). Both shapes have mean ½, so the media positions of the
// transition's ends — and of every keyframe — stay exactly where the corner put them (a ramp never shifts content).
//
// The timeline speed (Premiere's percentage, 1 = 100 %) at a frame is `R'(c) · speed.rate` (remapped clips are never
// `speed.reverse`, see invariants).
import { contentTimeAt } from '../derive/index.ts';
import type { RemapKeyframe, TimeInterpolation, TimeRemap } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';

/** Largest timeline speed of a remap segment (Premiere Pro 14.0+: 20,000 %). */
export const MAX_REMAP_SPEED = 200;
/** Smallest non-zero timeline speed of a remap segment (0.01 %; 0 % is a freeze). */
export const MIN_REMAP_SPEED = 0.0001;
/** Default `ease` of a speed transition (a smooth S-curve, like Premiere's split keyframe). */
export const DEFAULT_RAMP_EASE = 1;
/** Premiere's palindrome reverse plays backward and forward "at full speed". */
export const REVERSE_SEGMENT_SPEED = 1;
/** Default length of Insert Frame Hold Segment (Premiere: 2 seconds, not configurable). */
export const FRAME_HOLD_SEGMENT_SECONDS = 2;

/** Fields of a clip the time mapping reads. `timeRemap` is only honoured on video clips. */
export type TimedClip = {
	start: number;
	duration: number;
	sourceIn: number;
	speed: { rate: number; reverse: boolean };
	kind?: string;
	timeRemap?: TimeRemap | null;
	timeInterpolation?: TimeInterpolation | null;
};

/** The remap that applies to a clip, or null (absent, disabled, or not a video clip). */
export function activeRemap(clip: Pick<TimedClip, 'timeRemap' | 'kind'>): TimeRemap | null {
	const r = clip.timeRemap;
	if (!r || !r.enabled) return null;
	if (clip.kind !== undefined && clip.kind !== 'video') return null;
	return r;
}

/** True when the clip's picture follows a time remap. */
export function isRemapped(clip: Pick<TimedClip, 'timeRemap' | 'kind'>): boolean {
	return activeRemap(clip) !== null;
}

/** Time Interpolation of a clip (default Frame Sampling). */
export function timeInterpolationOf(clip: Pick<TimedClip, 'timeInterpolation'>): TimeInterpolation {
	return clip.timeInterpolation ?? 'frame-sampling';
}

// ---------------------------------------------------------------- curve evaluation

const finite = (x: number | undefined, d: number): number => (x !== undefined && Number.isFinite(x) ? x : d);

/** Slopes of the remap's segments: `[before, k0→k1, …, after]` (length n + 1), media flicks per content flick. */
export function remapSlopes(remap: Pick<TimeRemap, 'keyframes' | 'speedBefore' | 'speedAfter'>): number[] {
	const k = remap.keyframes;
	// Without keyframes the media time is the content time (the edge slopes have no anchor).
	if (k.length === 0) return [1];
	const out = [finite(remap.speedBefore, 1)];
	for (let i = 0; i + 1 < k.length; i++) {
		const dc = k[i + 1]!.time - k[i]!.time;
		out.push(dc > 0 ? (k[i + 1]!.source - k[i]!.source) / dc : 0);
	}
	out.push(finite(remap.speedAfter, 1));
	return out;
}

/**
 * Effective ramp half-width of keyframe `i`: never more than half of either adjacent segment, so neighbouring
 * transitions never overlap (edge segments are unbounded).
 */
export function effectiveRamp(keys: readonly RemapKeyframe[], i: number): number {
	const r = finite(keys[i]?.ramp, 0);
	if (!(r > 0)) return 0;
	let lim = r;
	if (i > 0) lim = Math.min(lim, (keys[i]!.time - keys[i - 1]!.time) / 2);
	if (i + 1 < keys.length) lim = Math.min(lim, (keys[i + 1]!.time - keys[i]!.time) / 2);
	return Math.max(0, lim);
}

/** Speed transition shape: E(x) for x ∈ [0, 1]. */
export function rampShape(x: number, ease: number): number {
	return (1 - ease) * x + ease * (3 * x * x - 2 * x * x * x);
}

/** ∫₀ˣ E. */
function rampShapeIntegral(x: number, ease: number): number {
	return ((1 - ease) * x * x) / 2 + ease * (x * x * x - (x * x * x * x) / 2);
}

/** Index of the last keyframe with time ≤ c, or −1. */
function keyIndexAt(keys: readonly RemapKeyframe[], c: number): number {
	let lo = 0;
	let hi = keys.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (keys[mid]!.time <= c) {
			ans = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
}

type Eval = { m: number; slope: number };

function evalRemap(remap: Pick<TimeRemap, 'keyframes' | 'speedBefore' | 'speedAfter'>, c: number, s: number[]): Eval {
	const keys = remap.keyframes;
	if (keys.length === 0) return { m: c, slope: 1 };
	const k = keyIndexAt(keys, c);
	// Inside the speed transition of keyframe k (right half) or k + 1 (left half)?
	for (const j of [k, k + 1]) {
		if (j < 0 || j >= keys.length) continue;
		const r = effectiveRamp(keys, j);
		if (r <= 0) continue;
		const kj = keys[j]!;
		if (c <= kj.time - r || c >= kj.time + r) continue;
		const v1 = s[j]!;
		const v2 = s[j + 1]!;
		const e = finite(kj.ease, DEFAULT_RAMP_EASE);
		const x = (c - (kj.time - r)) / (2 * r);
		return {
			m: kj.source - r * v1 + 2 * r * (v1 * x + (v2 - v1) * rampShapeIntegral(x, e)),
			slope: v1 + (v2 - v1) * rampShape(x, e),
		};
	}
	if (k < 0) {
		const k0 = keys[0]!;
		return { m: k0.source + (c - k0.time) * s[0]!, slope: s[0]! };
	}
	const kk = keys[k]!;
	return { m: kk.source + (c - kk.time) * s[k + 1]!, slope: s[k + 1]! };
}

/** Media time (flicks) of content time `c`. */
export function remapSourceAt(remap: Pick<TimeRemap, 'keyframes' | 'speedBefore' | 'speedAfter'>, c: number): number {
	return evalRemap(remap, c, remapSlopes(remap)).m;
}

/** dm/dc at content time `c` (media flicks per content flick). */
export function remapSlopeAt(remap: Pick<TimeRemap, 'keyframes' | 'speedBefore' | 'speedAfter'>, c: number): number {
	return evalRemap(remap, c, remapSlopes(remap)).slope;
}

/**
 * Evaluator bound to one remap (slopes computed once): media time and slope at many content times (render loops,
 * the timeline band, the native sampler).
 */
export function remapEvaluator(
	remap: Pick<TimeRemap, 'keyframes' | 'speedBefore' | 'speedAfter'>,
): (c: number) => Eval {
	const s = remapSlopes(remap);
	return (c) => evalRemap(remap, c, s);
}

// ---------------------------------------------------------------- clip-level mapping

/**
 * Media time (flicks) shown at sequence frame `frame` (fractional frames allowed): the content time, through the
 * clip's time remap when it has one.
 */
export function clipMediaTimeAt(clip: TimedClip, frame: number, rate: Rational): number {
	const c = contentTimeAt(clip, frame, rate);
	const remap = activeRemap(clip);
	return remap ? remapSourceAt(remap, c) : c;
}

/** A per-frame media-time function for a clip (the remap evaluator is built once). */
export function clipMediaTimeFn(clip: TimedClip, rate: Rational): (frame: number) => number {
	const remap = activeRemap(clip);
	if (!remap) return (f) => contentTimeAt(clip, f, rate);
	const ev = remapEvaluator(remap);
	return (f) => ev(contentTimeAt(clip, f, rate)).m;
}

/**
 * Signed timeline speed at sequence frame `frame` (1 = 100 %, negative = reverse, 0 = freeze): Premiere's
 * Time Remapping ▸ Speed value at that frame.
 */
export function clipSpeedAt(clip: TimedClip, frame: number, rate: Rational): number {
	const remap = activeRemap(clip);
	const sign = clip.speed.reverse ? -1 : 1;
	if (!remap) return sign * clip.speed.rate;
	return remapSlopeAt(remap, contentTimeAt(clip, frame, rate)) * clip.speed.rate * sign;
}

/** Sequence frame (fractional) at which a content time is shown (the inverse of `contentTimeAt`). */
export function frameAtContent(clip: Pick<TimedClip, 'start' | 'duration' | 'sourceIn' | 'speed'>, c: number, rate: Rational): number {
	const step = flicksPerFrame(rate) * clip.speed.rate;
	const i = (c - clip.sourceIn) / step;
	return clip.speed.reverse ? clip.start + clip.duration - 1 - i : clip.start + i;
}

/** Content flicks per sequence frame of a clip. */
export function contentStep(clip: Pick<TimedClip, 'speed'>, rate: Rational): number {
	return flicksPerFrame(rate) * clip.speed.rate;
}

/**
 * Smallest and largest media time (flicks) shown over sequence frames [f0, f1] (inclusive, fractional allowed) —
 * exact for remaps (segment ends, keyframes, transition ends and the zero-speed point inside a transition between
 * opposite speeds are all candidates).
 */
export function clipMediaExtent(
	clip: TimedClip,
	f0: number,
	f1: number,
	rate: Rational,
): { min: number; max: number } {
	const remap = activeRemap(clip);
	const ca = contentTimeAt(clip, f0, rate);
	const cb = contentTimeAt(clip, f1, rate);
	const lo = Math.min(ca, cb);
	const hi = Math.max(ca, cb);
	if (!remap) return { min: lo, max: hi };
	const ev = remapEvaluator(remap);
	const s = remapSlopes(remap);
	const cands = [lo, hi];
	const keys = remap.keyframes;
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i]!;
		const r = effectiveRamp(keys, i);
		for (const t of r > 0 ? [k.time - r, k.time + r] : [k.time]) if (t > lo && t < hi) cands.push(t);
		if (r > 0) {
			const v1 = s[i]!;
			const v2 = s[i + 1]!;
			if (v1 * v2 < 0) {
				// Speed crosses zero inside the transition: bisection on the monotone shape.
				const target = -v1 / (v2 - v1);
				const e = finite(k.ease, DEFAULT_RAMP_EASE);
				let a = 0;
				let b = 1;
				for (let it = 0; it < 60; it++) {
					const mid = (a + b) / 2;
					if (rampShape(mid, e) < target) a = mid;
					else b = mid;
				}
				const t = k.time - r + 2 * r * ((a + b) / 2);
				if (t > lo && t < hi) cands.push(t);
			}
		}
	}
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const c of cands) {
		const m = ev(c).m;
		if (m < min) min = m;
		if (m > max) max = m;
	}
	return { min, max };
}

/** Media extent of the clip's visible frames (first to last frame). */
export function clipMediaRange(clip: TimedClip, rate: Rational): { min: number; max: number } {
	return clipMediaExtent(clip, clip.start, clip.start + clip.duration - 1, rate);
}

// ---------------------------------------------------------------- what needs retiming

/**
 * The clip's picture needs the retimed (frame-exact, media-time driven) pipeline rather than a linear decode:
 * reverse, a time remap, or Frame Blending / Optical Flow where frames fall between source frames (speed ≠ 100 %, a
 * remap, or a media frame rate that differs from the sequence).
 */
export function needsRetime(
	clip: TimedClip,
	opts: { sequenceRate: Rational; mediaRate?: Rational | null; vfr?: boolean },
): boolean {
	if (clip.kind !== undefined && clip.kind !== 'video') return false;
	if (clip.speed.reverse || isRemapped(clip)) return true;
	if (timeInterpolationOf(clip) !== 'frame-sampling') {
		if (clip.speed.rate !== 1) return true;
		const mr = opts.mediaRate;
		if (opts.vfr) return true;
		if (mr && mr.num * opts.sequenceRate.den !== opts.sequenceRate.num * mr.den) return true;
	}
	return false;
}

// ---------------------------------------------------------------- views for UI and agents

export type RemapSegmentKind = 'forward' | 'reverse' | 'hold';

/** A constant-speed part of a remapped clip between two keyframes (or a keyframe and a clip edge). */
export type RemapSegmentView = {
	/** 0-based in timeline order over the whole curve (−1 = before the first keyframe). */
	index: number;
	/** Sequence frames (fractional) where the segment starts and ends (unbounded edges are clipped to the clip). */
	fromFrame: number;
	toFrame: number;
	/** Signed timeline speed (1 = 100 %). */
	speed: number;
	kind: RemapSegmentKind;
	/** Media seconds at both ends. */
	mediaFrom: number;
	mediaTo: number;
	leftKeyId: string | null;
	rightKeyId: string | null;
};

export type RemapKeyView = {
	id: string;
	/** Sequence frame (fractional) of the keyframe. */
	frame: number;
	/** Media seconds it anchors. */
	mediaSeconds: number;
	/** Speed transition half-width in sequence frames (0 = instantaneous). */
	rampFrames: number;
	ease: number;
	/** Whether the keyframe lies inside the clip's visible frames. */
	visible: boolean;
};

const kindOfSlope = (s: number): RemapSegmentKind => (Math.abs(s) < 1e-12 ? 'hold' : s < 0 ? 'reverse' : 'forward');

/** Keyframes of a clip's remap in sequence frames. */
export function remapKeyViews(clip: TimedClip, rate: Rational): RemapKeyView[] {
	const remap = activeRemap(clip);
	if (!remap) return [];
	const step = contentStep(clip, rate);
	return remap.keyframes.map((k, i) => {
		const frame = frameAtContent(clip, k.time, rate);
		return {
			id: k.id,
			frame,
			mediaSeconds: k.source / FLICKS_PER_SECOND,
			rampFrames: effectiveRamp(remap.keyframes, i) / step,
			ease: finite(k.ease, DEFAULT_RAMP_EASE),
			visible: frame >= clip.start - 1e-9 && frame <= clip.start + clip.duration + 1e-9,
		};
	});
}

/** The constant-speed segments of a remapped clip that overlap its visible frames, in timeline order. */
export function remapSegmentViews(clip: TimedClip, rate: Rational): RemapSegmentView[] {
	const remap = activeRemap(clip);
	if (!remap) return [];
	const s = remapSlopes(remap);
	const keys = remap.keyframes;
	const ev = remapEvaluator(remap);
	const step = contentStep(clip, rate);
	const c0 = clip.sourceIn;
	const c1 = clip.sourceIn + clip.duration * step;
	const out: RemapSegmentView[] = [];
	for (let i = -1; i < keys.length; i++) {
		const a = i < 0 ? Number.NEGATIVE_INFINITY : keys[i]!.time;
		const b = i + 1 < keys.length ? keys[i + 1]!.time : Number.POSITIVE_INFINITY;
		const lo = Math.max(a, c0);
		const hi = Math.min(b, c1);
		if (!(hi > lo)) continue;
		const slope = s[i + 1]!;
		out.push({
			index: i,
			fromFrame: frameAtContent(clip, lo, rate),
			toFrame: frameAtContent(clip, hi, rate),
			speed: slope * clip.speed.rate,
			kind: kindOfSlope(slope),
			mediaFrom: ev(lo).m / FLICKS_PER_SECOND,
			mediaTo: ev(hi).m / FLICKS_PER_SECOND,
			leftKeyId: i >= 0 ? keys[i]!.id : null,
			rightKeyId: i + 1 < keys.length ? keys[i + 1]!.id : null,
		});
	}
	return out;
}

/** Segment index (`-1 … n − 1`) containing content time `c` (a keyframe belongs to the segment it starts). */
export function remapSegmentIndexAt(remap: Pick<TimeRemap, 'keyframes'>, c: number): number {
	return keyIndexAt(remap.keyframes, c);
}

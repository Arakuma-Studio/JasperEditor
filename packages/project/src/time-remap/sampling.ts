// Source frame selection: which media frames make the picture at a media time — shared by the
// preview decoder (compositions/retime), the native retime producer (engine/export/retime) and scene detection, so
// every path picks the same frames.
//
// Media time is measured from the start of the media (ffmpeg's `start_time`, mediabunny's first timestamp). A frame
// is shown from its timestamp until the next frame's: the frame at media time m is the last one whose timestamp is
// ≤ m (Premiere's Frame Sampling "repeats or removes frames as needed"). Variable-frame-rate media use their real
// timestamps (Premiere's VFR "Preserve Audio Sync"); constant-rate media `i / fps`.
//
// Frame Blending and Optical Flow mix that frame (a) with the next one (b) at w = (m − tₐ) / (t_b − tₐ).
import type { TimeInterpolation } from '../schema/sequence.ts';
import type { Rational } from '../time.ts';

/** Seconds of tolerance when comparing a media time with a frame timestamp (well under 1 µs of rounding). */
export const FRAME_TIME_EPS = 2e-6;
/**
 * Shot changes (Scene Edit Detection's `clip.applySceneEdits`, the sound-design scene source): a change at media time
 * c is shown from the first frame whose media time m reaches it with the renderers' own tolerance (c ≤ m + this), the
 * frame pick of `frameIndexAt` — so an edit, a marker and a cue land on the frame where the new shot is drawn, whether
 * the detector's timestamp (printed to 1 µs) rounded up or down.
 */
export const SHOT_TIME_EPS = FRAME_TIME_EPS;

/** How many of the ascending shot-change times (seconds) are reached at media time `sec` (0 for a non-finite time). */
export function shotIndexAt(cutsSec: ArrayLike<number>, sec: number): number {
	if (!Number.isFinite(sec)) return 0;
	const lim = sec + SHOT_TIME_EPS;
	let lo = 0;
	let hi = cutsSec.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (cutsSec[mid]! <= lim) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
/** Fractions closer than this to a frame are that frame (no interpolation). */
export const INTERP_EPS = 1e-3;

/** Media frame timestamps: explicit (seconds, ascending) or constant rate (`i·den/num`) with a frame count. */
export type FrameTimes =
	| { kind: 'cfr'; rate: Rational; count: number }
	| { kind: 'list'; times: ArrayLike<number> };

export function frameCount(t: FrameTimes): number {
	return t.kind === 'cfr' ? t.count : t.times.length;
}

export function frameTime(t: FrameTimes, i: number): number {
	return t.kind === 'cfr' ? (i * t.rate.den) / t.rate.num : t.times[i]!;
}

/** Index of the frame shown at media time `sec` (clamped to the first / last frame). */
export function frameIndexAt(t: FrameTimes, sec: number): number {
	const n = frameCount(t);
	if (n <= 0) return 0;
	if (t.kind === 'cfr') {
		const q = (sec * t.rate.num) / t.rate.den;
		return Math.max(0, Math.min(n - 1, Math.floor(q + FRAME_TIME_EPS * (t.rate.num / t.rate.den))));
	}
	const times = t.times;
	let lo = 0;
	let hi = n - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid]! <= sec + FRAME_TIME_EPS) {
			ans = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
}

/** Frames of a picture: `a` alone (w = 0) or `a`·(1 − w) + `b`·w (b = a + 1). */
export type FramePick = { a: number; b: number; w: number };

/** The frames that make the picture at media time `sec` under a Time Interpolation mode. */
export function pickFrames(t: FrameTimes, sec: number, mode: TimeInterpolation): FramePick {
	const a = frameIndexAt(t, sec);
	const n = frameCount(t);
	if (mode === 'frame-sampling' || a + 1 >= n) return { a, b: a, w: 0 };
	const ta = frameTime(t, a);
	const tb = frameTime(t, a + 1);
	const w = tb > ta ? (sec - ta) / (tb - ta) : 0;
	if (!(w > INTERP_EPS)) return { a, b: a, w: 0 };
	if (w >= 1 - INTERP_EPS) return { a: a + 1, b: a + 1, w: 0 };
	return { a, b: a + 1, w };
}

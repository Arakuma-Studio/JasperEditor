// Time model (S01:TIME-001…007). Sequence time = integer frames; content time = integer flicks.

import type { RationalT } from './schema/common.ts';

export const FLICKS_PER_SECOND = 705_600_000;

export type Rational = RationalT;

export const RATES = {
	r23_976: { num: 24000, den: 1001 },
	r24: { num: 24, den: 1 },
	r25: { num: 25, den: 1 },
	r29_97: { num: 30000, den: 1001 },
	r30: { num: 30, den: 1 },
	r50: { num: 50, den: 1 },
	r59_94: { num: 60000, den: 1001 },
	r60: { num: 60, den: 1 },
} as const satisfies Record<string, Rational>;

/** Allowed sequence frame rates in v1 (S01:TIME-003). */
export const ALLOWED_SEQUENCE_RATES: readonly Rational[] = Object.values(RATES);

export function rationalEquals(a: Rational, b: Rational): boolean {
	return a.num * b.den === b.num * a.den;
}

export function isAllowedSequenceRate(r: Rational): boolean {
	return ALLOWED_SEQUENCE_RATES.some((a) => rationalEquals(a, r));
}

/** Rate as a number (Remotion `fps`). */
export function fpsOf(r: Rational): number {
	return r.num / r.den;
}

/** Nominal integer rate used by timecode (30 for 29.97, 60 for 59.94). */
export function nominalFps(r: Rational): number {
	return Math.round(r.num / r.den);
}

/** Whether drop-frame timecode is possible at this rate (29.97 and 59.94). */
export function supportsDropFrame(r: Rational): boolean {
	return rationalEquals(r, RATES.r29_97) || rationalEquals(r, RATES.r59_94);
}

/** Nearest allowed sequence rate for an arbitrary media rate (S01:SEQ-004). */
export function nearestAllowedRate(r: Rational | number): Rational {
	const fps = typeof r === 'number' ? r : fpsOf(r);
	let best = ALLOWED_SEQUENCE_RATES[0]!;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const a of ALLOWED_SEQUENCE_RATES) {
		const d = Math.abs(fpsOf(a) - fps);
		if (d < bestDist - 1e-9) {
			best = a;
			bestDist = d;
		}
	}
	return { num: best.num, den: best.den };
}

/** Flicks per frame `F(r) = 705,600,000 × den / num` (integer for every allowed sequence rate). */
export function flicksPerFrame(r: Rational): number {
	return (FLICKS_PER_SECOND * r.den) / r.num;
}

export function framesToFlicks(frames: number, r: Rational): number {
	return frames * flicksPerFrame(r);
}

/**
 * Flicks → frame index. `floor` = the frame containing `t`; `round` = snap to the nearest grid
 * frame (S01:TIME-004). Exact for integer inputs below 2^53.
 */
export function flicksToFrames(flicks: number, r: Rational, mode: 'floor' | 'round' = 'floor'): number {
	const F = flicksPerFrame(r);
	if (Number.isInteger(F) && Number.isInteger(flicks)) {
		return mode === 'floor' ? Math.floor(flicks / F) : Math.round(flicks / F);
	}
	const q = flicks / F;
	return mode === 'floor' ? Math.floor(q + 1e-9) : Math.round(q);
}

/**
 * Tolerance (in frames) for frame counts derived from probed durations. ffprobe prints durations in
 * microseconds, so an exact 58-frame 30 fps file reads 1.933333 s = 57.99999 frames; without a tolerance
 * `floor` drops its last frame.
 */
export const FRAME_EPS = 1e-3;

export function secondsToFlicks(seconds: number): number {
	return Math.round(seconds * FLICKS_PER_SECOND);
}

export function flicksToSeconds(flicks: number): number {
	return flicks / FLICKS_PER_SECOND;
}

export function framesToSeconds(frames: number, r: Rational): number {
	return (frames * r.den) / r.num;
}

/** Seconds → frames, snapped with `round` (S01:TIME-006) unless `floor` is asked for. */
export function secondsToFrames(seconds: number, r: Rational, mode: 'floor' | 'round' = 'round'): number {
	const q = (seconds * r.num) / r.den;
	return mode === 'floor' ? Math.floor(q + 1e-9) : Math.round(q);
}

/** Symmetric rounding (half away from zero) so that `+d` then `-d` returns to the start. */
export function roundSym(x: number): number {
	return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Flicks of content consumed by `frames` sequence frames at `speed` (S01:CLP-004), rounded to whole
 * flicks with symmetric rounding. All split/trim/bounds math goes through this so that through edits
 * stay exact (S02 AC-1a).
 */
export function contentSpanFlicks(frames: number, r: Rational, speed: number): number {
	return roundSym(frames * flicksPerFrame(r) * speed);
}

/** Frame index mapping between rates: `map(f) = round(f × r2 / r1)` (S01:SEQ-006). */
export function mapFrameBetweenRates(frame: number, from: Rational, to: Rational): number {
	return roundSym((frame * to.num * from.den) / (to.den * from.num));
}

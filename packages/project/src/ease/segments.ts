// Ease segments (keyframe assistant): reading and writing the temporal shape of one keyframe segment without
// disturbing its neighbours. The model stores one interpolation per key (the segment it leaves) plus an in and an out
// ease (schema/common.ts); `keyframes.ts` evaluates the segment A → B as
//   hold                     when A holds (or the value only steps),
//   linear (progress = u)     when A is `linear` (B's in ease is then ignored),
//   bezier(out(A), in(B))     otherwise, where a `linear` B arrives with the linear ease and an `auto-bezier` key's eases
//                             are derived from its neighbours on every evaluation.
// A run of roving keys between two fixed keys moves as ONE segment shaped by the fixed keys (`rovingProgress`), so a
// segment that touches a roving key is addressed as its enclosing run.
//
// These helpers work on plain key arrays (sorted by time) and mutate the keys in place; callers re-run the command
// layer's `finish` afterwards (auto-bezier refresh, roving re-timing).
import { incomingEase, isHoldOnlyValue, outgoingEase, rovingRuns } from '../keyframes.ts';
import { isVec2Value, spatialSegmentLength } from '../keyframes-spatial.ts';
import { pathValueDistance } from '../path/interp.ts';
import { isBezierPath } from '../path/model.ts';
import type { Ease, Keyframe } from '../schema/common.ts';
import { FLICKS_PER_SECOND } from '../time.ts';

type Keys = Keyframe<unknown>[];

/** The evaluator's linear ease (influence ⅓, slope 1): a Bézier segment with it on both sides is exactly linear. */
export const LINEAR_EASE: Ease = { influence: 1 / 3, slope: 1 };

/** True when the ease is (to 1e-12) the linear ease. */
export function isLinearEase(e: Ease): boolean {
	return Math.abs(e.influence - 1 / 3) < 1e-12 && Math.abs(e.slope - 1) < 1e-12;
}

/** One eased span: a key segment `a → a + 1`, or a roving run `a → b` between two fixed keys. */
export type EaseSpan = { a: number; b: number; roving: boolean };

/**
 * The span containing the segment that leaves key `i` (the enclosing roving run when the segment touches a roving
 * key), or null past the last key. `runs` = `rovingRuns` of the array (pass it when calling repeatedly).
 */
export function spanLeaving(kfs: Keys, i: number, runs = rovingRuns([...kfs])): EaseSpan | null {
	if (i < 0 || i >= kfs.length - 1) return null;
	const run = runs.find((r) => i >= r.a && i < r.b);
	return run ? { a: run.a, b: run.b, roving: true } : { a: i, b: i + 1, roving: false };
}

/** The effective shape of span a → b as the evaluator draws it: a hold, or the two eases (linear = linear eases). */
export function spanEases(
	kfs: Keys,
	a: number,
	b: number,
): { hold: true } | { hold: false; out: Ease; in: Ease } {
	const A = kfs[a]!;
	if (A.interpolation === 'hold' || isHoldOnlyValue(A.value)) return { hold: true };
	if (A.interpolation === 'linear') return { hold: false, out: { ...LINEAR_EASE }, in: { ...LINEAR_EASE } };
	const out = outgoingEase(kfs, a);
	const inn = incomingEase(kfs, b);
	return { hold: false, out: { ...out }, in: { ...inn } };
}

/** Effective eases captured before an edit (auto-bezier eases depend on neighbours an edit may remove). */
export type CapturedEases = { aIn?: Ease; bOut?: Ease; cOut?: Ease };

/** Captures the effective eases `writeSpan` keeps for span a → b. */
export function captureEases(kfs: Keys, a: number, b: number): CapturedEases {
	return {
		...(a > 0 ? { aIn: { ...incomingEase(kfs, a) } } : {}),
		bOut: { ...outgoingEase(kfs, b) },
		...(b + 1 < kfs.length ? { cOut: { ...outgoingEase(kfs, b + 1) } } : {}),
	};
}

/**
 * Makes span a → b evaluate exactly as bezier(out, inn), keeping every other segment as it evaluated before:
 * - A becomes `bezier` (from linear / hold / auto / continuous), its in ease set to the ease it effectively arrived with;
 * - B keeps `bezier` / `hold`; an `auto-bezier` or `continuous-bezier` B becomes `bezier` with its effective out ease
 *   (so `finish` cannot re-derive the in ease just set); a `linear` B becomes `bezier` with the linear out ease, and
 *   the key after it then arrives linearly (as it did behind a linear B).
 * `captured` = eases measured on the array before keys were removed (multi-point rebuilds); default = measured now.
 */
export function writeSpan(
	kfs: Keys,
	a: number,
	b: number,
	out: Ease,
	inn: Ease,
	captured: CapturedEases = captureEases(kfs, a, b),
): void {
	const A = kfs[a]!;
	const B = kfs[b]!;
	const C = kfs[b + 1];
	if (A.interpolation === 'linear' && isLinearEase(out) && isLinearEase(inn)) return; // already exactly linear
	if (A.interpolation !== 'bezier') {
		A.interpolation = 'bezier';
		if (captured.aIn) A.easeIn = { ...captured.aIn };
	}
	A.easeOut = { influence: out.influence, slope: out.slope };
	if (B.interpolation === 'linear' && isLinearEase(inn)) return; // a linear B already arrives linearly
	if (B.interpolation === 'linear') {
		B.interpolation = 'bezier';
		B.easeOut = { ...LINEAR_EASE };
		if (C && C.interpolation !== 'linear') {
			if (C.interpolation === 'auto-bezier') {
				C.interpolation = 'bezier';
				if (captured.cOut) C.easeOut = { ...captured.cOut };
			}
			C.easeIn = { ...LINEAR_EASE };
		}
	} else if (B.interpolation === 'auto-bezier' || B.interpolation === 'continuous-bezier') {
		B.interpolation = 'bezier';
		if (captured.bOut) B.easeOut = { ...captured.bOut };
	}
	B.easeIn = { influence: inn.influence, slope: inn.slope };
}

/** Magnitude of a value change as the evaluator measures speeds (absolute, Euclidean, RMS vertex shift). */
export function valueDistance(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') return Math.abs(b - a);
	if (isBezierPath(a) && isBezierPath(b)) return pathValueDistance(a, b);
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
		let s = 0;
		for (let i = 0; i < a.length; i++) s += ((b[i] as number) - (a[i] as number)) ** 2;
		return Math.sqrt(s);
	}
	return 0;
}

/** Distance travelled over span a → b: arc length along curved spatial segments, the value distance otherwise. */
export function spanDistance(kfs: Keys, a: number, b: number): number {
	let d = 0;
	for (let i = a; i < b; i++) {
		const u = kfs[i]!.value;
		const v = kfs[i + 1]!.value;
		d += isVec2Value(u) && isVec2Value(v) ? spatialSegmentLength(kfs, i) : valueDistance(u, v);
	}
	return d;
}

/**
 * Average velocity of span a → b in value units per second: signed for numbers (an ease slope multiplies it), the
 * speed along the value / path otherwise. 0 for a span of zero duration.
 */
export function spanAverageVelocity(kfs: Keys, a: number, b: number): number {
	const A = kfs[a]!;
	const B = kfs[b]!;
	const seconds = (B.time - A.time) / FLICKS_PER_SECOND;
	if (!(seconds > 0)) return 0;
	if (typeof A.value === 'number' && typeof B.value === 'number' && b === a + 1)
		return (B.value - A.value) / seconds;
	if (typeof A.value === 'number' && typeof B.value === 'number') {
		// A roving run of numbers: the distance travelled, signed by the overall direction.
		const d = spanDistance(kfs, a, b);
		return (B.value >= A.value ? d : -d) / seconds;
	}
	return spanDistance(kfs, a, b) / seconds;
}

/** Highest and lowest progress a Bézier ease pair reaches inside the segment (sampled; ends are 0 and 1). */
export function easeProgressRange(out: Ease, inn: Ease): [number, number] {
	// The progress is the y of a cubic with control ys 0, x1·s1, 1 − x2'·s2, 1: its extremes over t ∈ [0, 1].
	const y1 = out.influence * out.slope;
	const y2 = 1 - inn.influence * inn.slope;
	let lo = 0;
	let hi = 1;
	for (let k = 1; k < 256; k++) {
		const t = k / 256;
		const s = 1 - t;
		const y = 3 * s * s * t * y1 + 3 * s * t * t * y2 + t * t * t;
		if (y < lo) lo = y;
		if (y > hi) hi = y;
	}
	return [lo, hi];
}

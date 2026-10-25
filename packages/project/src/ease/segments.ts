// Ease segments (keyframe assistant): reading and writing the temporal shape of one keyframe segment without
// disturbing its neighbours. A key stores an outgoing `interpolation`, an optional incoming `inInterpolation`
// (keyframe-sides) and an in and an out ease (schema/common.ts). The ONE rule of how a segment A → B evaluates is
// `segmentShape` in keyframes.ts (After Effects: A's outgoing side and B's incoming side; Hold decided by A; linear
// only when both sides are Linear, a Linear side of a curved segment is influence ⅙ at the average speed; the legacy
// reading when B has no `inInterpolation`: linear whenever A is Linear, a Linear B contributes ⅓·1). These helpers
// read through it and write keys so that it returns what was asked.
// A run of roving keys between two fixed keys moves as ONE segment shaped by the fixed keys (`rovingProgress`), so a
// segment that touches a roving key is addressed as its enclosing run.
// spatial-points: `metric` = the spatial metric of effect point values (temporal auto-bezier speeds, path lengths and
// speeds are measured in its pixels, as the evaluator does).
//
// These helpers work on plain key arrays (sorted by time) and mutate the keys in place; callers re-run the command
// layer's `finish` afterwards (auto-bezier refresh, roving re-timing).
import {
	explicitInSide,
	incomingEase,
	isBothSided,
	isHoldOnlyValue,
	outgoingEase,
	rovingRuns,
	segmentShape,
} from '../keyframes.ts';
import { isVec2Value, type SpatialMetric, spatialSegmentLength } from '../keyframes-spatial.ts';
import { pathValueDistance } from '../path/interp.ts';
import { isBezierPath } from '../path/model.ts';
import type { Ease, InInterpolation, Interpolation, Keyframe } from '../schema/common.ts';
import { FLICKS_PER_SECOND } from '../time.ts';

type Keys = Keyframe<unknown>[];
type Metric = SpatialMetric | null | undefined;

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

/** The two side types of a span: A's outgoing type and the incoming type that shapes the span at B. */
export type SpanSides = {
	outInterpolation: Interpolation;
	/**
	 * The type B's incoming side acts as: `hold` after a Hold key (overridden, as After Effects draws it), else the
	 * explicit incoming side that reproduces the span (`explicitInSide`: a key read the legacy way is Linear after a
	 * Linear key, Bezier for a Hold key or a Linear key after a curving one — they arrive with their stored / the ⅓·1
	 * ease —, its own type otherwise).
	 */
	inInterpolation: Interpolation;
};

/**
 * The effective shape of span a → b exactly as the evaluator draws it (`segmentShape`): a hold, or the two eases —
 * `linear` (progress = time) is reported with the linear ease on both sides — plus the sides' types.
 */
export type SpanShape = SpanSides & ({ hold: true } | { hold: false; linear: boolean; out: Ease; in: Ease });

export function spanEases(kfs: Keys, a: number, b: number, metric?: Metric): SpanShape {
	const A = kfs[a]!;
	const sides: SpanSides = {
		outInterpolation: A.interpolation,
		inInterpolation: A.interpolation === 'hold' ? 'hold' : explicitInSide(kfs, b, metric, a).type,
	};
	if (isHoldOnlyValue(A.value)) return { ...sides, hold: true };
	const shape = segmentShape(kfs, a, b, metric);
	if (shape === 'hold') return { ...sides, hold: true };
	if (shape === 'linear')
		return { ...sides, hold: false, linear: true, out: { ...LINEAR_EASE }, in: { ...LINEAR_EASE } };
	return { ...sides, hold: false, linear: false, out: { ...shape.out }, in: { ...shape.in } };
}

/** Effective eases / sides captured before an edit (auto-bezier eases depend on neighbours an edit may remove). */
export type CapturedEases = {
	/** The ease A's incoming side contributes, and the explicit incoming side reproducing it (`explicitInSide`). */
	aIn?: Ease;
	aSide?: { type: InInterpolation; ease: Ease };
	/** The ease B's outgoing side contributes. */
	bOut?: Ease;
};

/** Captures the effective eases `writeSpan` keeps for span a → b. */
export function captureEases(kfs: Keys, a: number, b: number, metric?: Metric): CapturedEases {
	return {
		...(a > 0
			? {
					aIn: { ...incomingEase(kfs, a, metric) },
					aSide: (({ type, ease }) => ({ type, ease: { ...ease } }))(explicitInSide(kfs, a, metric)),
				}
			: {}),
		bOut: { ...outgoingEase(kfs, b, metric) },
	};
}

const cloneEase = (e: Ease): Ease => ({ influence: e.influence, slope: e.slope });

/**
 * Lets key `i`'s outgoing type become `out` without changing the segment arriving at it (keyframe-sides):
 * - with an explicit incoming side: Auto / Continuous Bezier there (they shape both sides) becomes Bezier frozen at
 *   the ease it contributed; other incoming types are independent of the outgoing one;
 * - read the legacy way: a Bezier / Hold / Continuous key arrives with its stored ease, which takes the contributed
 *   one; becoming Linear or Auto would change the reading, so the incoming side is made explicit (`explicitInSide`).
 */
export function keepIncoming(kfs: Keys, i: number, out: Interpolation, captured: CapturedEases): void {
	const k = kfs[i]!;
	if (k.inInterpolation !== undefined) {
		if (isBothSided(k.inInterpolation) && k.inInterpolation !== out) {
			k.inInterpolation = 'bezier';
			if (captured.aIn) k.easeIn = cloneEase(captured.aIn);
		}
		return;
	}
	if (i === 0 || k.interpolation === out) return;
	if (out === 'bezier' || out === 'hold' || out === 'continuous-bezier') {
		if (captured.aIn) k.easeIn = cloneEase(captured.aIn);
		return;
	}
	const side = captured.aSide;
	if (!side) return;
	const both = isBothSided(side.type) && side.type !== out;
	k.inInterpolation = both ? 'bezier' : side.type;
	if (k.inInterpolation === 'bezier') k.easeIn = cloneEase(side.ease);
}

/**
 * Lets key `i`'s incoming side become `inType` without changing the segment leaving it: an Auto / Continuous Bezier
 * outgoing side (they shape both sides) becomes Bezier frozen at the ease it contributed (`bOut`).
 */
export function keepOutgoing(kfs: Keys, i: number, inType: InInterpolation, bOut: Ease | undefined): void {
	const k = kfs[i]!;
	if (isBothSided(k.interpolation) && k.interpolation !== inType) {
		k.interpolation = 'bezier';
		if (bOut) k.easeOut = cloneEase(bOut);
	}
}

/**
 * Makes span a → b evaluate exactly as bezier(out, inn), keeping every other segment evaluating as before:
 * - A's outgoing side becomes Bezier with `out` (`keepIncoming` keeps the segment arriving at A);
 * - B's incoming side becomes Bezier with `inn`: a legacy Bezier / Hold B just takes the ease, a legacy Auto /
 *   Continuous B becomes Bezier with its effective out ease (so `finish` cannot re-derive the in ease just set), a
 *   legacy Linear B gets an explicit Bezier incoming side (its Linear outgoing side, and the segment after it, stay),
 *   a per-side B gets `inInterpolation: 'bezier'` (`keepOutgoing` for a both-sided outgoing type).
 * A span that already is exactly linear stays as it is for the linear ease.
 * `captured` = eases measured on the array before keys were removed (multi-point rebuilds); default = measured now.
 */
export function writeSpan(
	kfs: Keys,
	a: number,
	b: number,
	out: Ease,
	inn: Ease,
	captured?: CapturedEases,
	metric?: Metric,
): void {
	if (isLinearEase(out) && isLinearEase(inn) && segmentShape(kfs, a, b, metric) === 'linear') return;
	const cap = captured ?? captureEases(kfs, a, b, metric);
	const A = kfs[a]!;
	const B = kfs[b]!;
	keepIncoming(kfs, a, 'bezier', cap);
	A.interpolation = 'bezier';
	A.easeOut = cloneEase(out);
	if (B.inInterpolation === undefined) {
		if (B.interpolation === 'linear') {
			if (isLinearEase(inn)) return; // a legacy Linear B already arrives with the linear ease
			B.inInterpolation = 'bezier';
		} else if (isBothSided(B.interpolation)) {
			B.interpolation = 'bezier';
			if (cap.bOut) B.easeOut = cloneEase(cap.bOut);
		}
	} else {
		keepOutgoing(kfs, b, 'bezier', cap.bOut);
		B.inInterpolation = 'bezier';
	}
	B.easeIn = cloneEase(inn);
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

/**
 * Distance travelled over span a → b: arc length along curved spatial segments (in the metric's pixels for effect
 * points), the value distance otherwise.
 */
export function spanDistance(kfs: Keys, a: number, b: number, metric?: Metric): number {
	let d = 0;
	for (let i = a; i < b; i++) {
		const u = kfs[i]!.value;
		const v = kfs[i + 1]!.value;
		d += isVec2Value(u) && isVec2Value(v) ? spatialSegmentLength(kfs, i, metric) : valueDistance(u, v);
	}
	return d;
}

/**
 * Average velocity of span a → b in value units per second: signed for numbers (an ease slope multiplies it), the
 * speed along the value / path otherwise (layer px per second for effect points with a `metric`). 0 for a span of
 * zero duration.
 */
export function spanAverageVelocity(kfs: Keys, a: number, b: number, metric?: Metric): number {
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
	return spanDistance(kfs, a, b, metric) / seconds;
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

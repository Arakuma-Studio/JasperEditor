// Keyframe evaluation (S01:KF-003, KF-004, KF-007). The single evaluator shared by the Player, the
// overlay, Effect Controls and the native planner (S01:KF-009). vec2 point keys with a curved spatial
// path (S03:KF-030/031) are evaluated along the path by `keyframes-spatial.ts`.
import { isVec2Value, pathPointAt, spatialSegment, spatialSegmentLength } from './keyframes-spatial.ts';
import type { Animatable, Ease, Keyframe } from './schema/common.ts';

const LINEAR_EASE: Ease = { influence: 1 / 3, slope: 1 };
const AUTO_INFLUENCE = 1 / 3;
/** Newton stops when its step in the curve parameter is below this (a parameter criterion, not an x residual). */
const STEP_TOLERANCE = 1e-15;

/**
 * Solves x(t) = u for the time curve of an ease, x(t) = 3(1−t)²t·x1 + 3(1−t)t²·x2 + t³ with x1, x2 ∈ [0, 1] (monotone,
 * so the root is unique). Influences are NOT normalised when they overlap (x1 > x2): After Effects keeps both
 * (effectcraft docs/fidelity: normalising was off by up to 12.46° against live AE samples).
 * - x1 = 1, x2 = 0 (100 % / 100 %): x = ½ + 4(t − ½)³ exactly, whose flat midpoint (dx/dt = 0) defeats Newton on a
 *   residual criterion — the closed-form inverse t = ½ + ∛((u − ½) / 4) is used (effectcraft `solve_u`).
 * - otherwise Newton safeguarded by a bisection bracket: a step leaving the bracket (or a flat derivative) is replaced
 *   by a bisection step; it stops when the step in t is below 1e-15 or the bracket collapsed.
 */
function solveEaseTime(u: number, x1: number, x2: number): number {
	if (x1 === 1 && x2 === 0) return 0.5 + Math.cbrt((u - 0.5) / 4);
	// x(½ + w) − u = d0 + w·(c1 + w·(c2 + c3·w)), expanded about the midpoint where dx/dt is smallest. d0 = x(½) − u is
	// a cancellation; it is kept in double-double so a nearly flat curve (influences near 100 % / 100 %) still has an
	// accurate root (the time curve's root moves like ∛(error) there).
	const [s, se] = twoSum(x1, x2);
	const [p, pe] = twoProd(0.375, s);
	const [q, qe] = twoSum(p, 0.125);
	const [d, de] = twoSum(q, -u);
	const d0 = d;
	const d0lo = de + qe + pe + 0.375 * se;
	const c1 = 0.75 * (1 - x1 + x2);
	const c2 = 1.5 * (1 - x1 - x2);
	const c3 = 3 * x1 - 3 * x2 + 1;
	const f = (w: number) => d0 + w * (c1 + w * (c2 + c3 * w)) + d0lo;
	const df = (w: number) => c1 + w * (2 * c2 + 3 * c3 * w);
	let lo = -0.5;
	let hi = 0.5;
	let w = u - 0.5;
	for (let i = 0; i < 200; i++) {
		const fw = f(w);
		if (fw === 0) return 0.5 + w;
		if (fw > 0) hi = w;
		else lo = w;
		const dw = df(w);
		let next = dw > 0 ? w - fw / dw : Number.NaN;
		if (!(next > lo && next < hi)) next = (lo + hi) / 2;
		if (Math.abs(next - w) <= STEP_TOLERANCE || hi - lo <= STEP_TOLERANCE) return 0.5 + next;
		w = next;
	}
	return 0.5 + w;
}

/** Error-free sum (Knuth TwoSum): a + b = s + e exactly. */
function twoSum(a: number, b: number): [number, number] {
	const s = a + b;
	const bb = s - a;
	return [s, a - (s - bb) + (b - bb)];
}

const SPLIT = 134217729; // 2^27 + 1 (Dekker)
/** Error-free product (Dekker TwoProduct): a · b = p + e exactly (no FMA in JS). */
function twoProd(a: number, b: number): [number, number] {
	const p = a * b;
	const ca = SPLIT * a;
	const ah = ca - (ca - a);
	const al = a - ah;
	const cb = SPLIT * b;
	const bh = cb - (cb - b);
	const bl = b - bh;
	return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}

/**
 * Cubic Bézier progress p(u) through (0,0), (a1, a1·s1), (1−a2, 1−a2·s2), (1,1) (S01:KF-003 step 5). Slopes may be
 * negative or steep (overshoot): only the time curve has to be monotone, which influences in (0, 1] guarantee.
 */
export function bezierProgress(u: number, out: Ease, inn: Ease): number {
	if (u <= 0) return 0;
	if (u >= 1) return 1;
	const x1 = Math.min(1, Math.max(0, out.influence));
	const x2 = 1 - Math.min(1, Math.max(0, inn.influence));
	const y1 = x1 * out.slope;
	const y2 = 1 - (1 - x2) * inn.slope;
	const t = solveEaseTime(u, x1, x2);
	const s = 1 - t;
	return 3 * s * s * t * y1 + 3 * s * t * t * y2 + t * t * t;
}

/** Magnitude of a value difference: absolute for numbers, Euclidean for vectors (S01:KF-004). */
function distance(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') return Math.abs(b - a);
	if (Array.isArray(a) && Array.isArray(b)) {
		let s = 0;
		for (let i = 0; i < a.length; i++) {
			const d = (b[i] as number) - (a[i] as number);
			s += d * d;
		}
		return Math.sqrt(s);
	}
	return 0;
}

function isLocalExtremum(prev: unknown, cur: unknown, next: unknown): boolean {
	if (typeof prev === 'number' && typeof cur === 'number' && typeof next === 'number') {
		return (cur - prev) * (next - cur) <= 0;
	}
	return false;
}

/** Auto-bezier slope on one side of keyframe i (S01:KF-004). */
export function autoSlope<T>(kfs: readonly Keyframe<T>[], i: number, side: 'in' | 'out'): number {
	const k = kfs[i]!;
	const prev = kfs[i - 1];
	const next = kfs[i + 1];
	if (!prev || !next) return 0; // first/last keyframe: 0 on the inner side
	if (isLocalExtremum(prev.value, k.value, next.value)) return 0;
	let across = distance(prev.value, next.value) / (next.time - prev.time);
	let seg =
		side === 'out'
			? distance(k.value, next.value) / (next.time - k.time)
			: distance(prev.value, k.value) / (k.time - prev.time);
	// Curved spatial paths (S03 §12.2 step 5: Δ is the arc length): speeds are measured along the path.
	const ks = kfs as readonly Keyframe<unknown>[];
	if (isVec2Value(k.value) && (spatialSegment(ks, i - 1) || spatialSegment(ks, i))) {
		const lin = spatialSegmentLength(ks, i - 1);
		const lout = spatialSegmentLength(ks, i);
		across = (lin + lout) / (next.time - prev.time);
		seg = side === 'out' ? lout / (next.time - k.time) : lin / (k.time - prev.time);
	}
	if (seg === 0 || !Number.isFinite(across / seg)) return 0;
	return Math.min(3, Math.max(0, across / seg));
}

/** Effective ease leaving key i as the evaluator uses it (linear → 1/3·1, auto-bezier → computed). */
export function outgoingEase<T>(kfs: readonly Keyframe<T>[], i: number): Ease {
	const k = kfs[i]!;
	if (k.interpolation === 'auto-bezier')
		return { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'out') };
	if (k.interpolation === 'linear') return LINEAR_EASE;
	return k.easeOut;
}

/** Effective ease arriving at key i as the evaluator uses it. */
export function incomingEase<T>(kfs: readonly Keyframe<T>[], i: number): Ease {
	const k = kfs[i]!;
	if (k.interpolation === 'auto-bezier') return { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'in') };
	if (k.interpolation === 'linear') return LINEAR_EASE;
	return k.easeIn;
}

/** True for value types that only step (booleans, strings, enums, font ids, media refs; S01:KF-007). */
export function isHoldOnlyValue(v: unknown): boolean {
	if (typeof v === 'number') return false;
	if (Array.isArray(v)) return !v.every((x) => typeof x === 'number');
	return true;
}

function lerpValue<T>(a: T, b: T, p: number): T {
	if (typeof a === 'number' && typeof b === 'number') return (a + p * (b - a)) as T;
	if (Array.isArray(a) && Array.isArray(b)) {
		// Per component; colors interpolate in straight sRGB in v1.
		return a.map((x: number, i) => x + p * ((b[i] as number) - x)) as T;
	}
	return a;
}

export type EvaluateOptions = {
	/** Force step behaviour (hold-only parameter types). */
	holdOnly?: boolean;
	/** Clamp numeric results (and every vector component) to the parameter range. */
	clamp?: { min?: number; max?: number };
};

function clampValue<T>(v: T, c?: { min?: number; max?: number }): T {
	if (!c) return v;
	const f = (x: number) =>
		Math.min(c.max ?? Number.POSITIVE_INFINITY, Math.max(c.min ?? Number.NEGATIVE_INFINITY, x));
	if (typeof v === 'number') return f(v) as T;
	if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? f(x) : x)) as T;
	return v;
}

/** Index of the last keyframe with time ≤ t (binary search), or -1. */
function keyframeIndexAt<T>(kfs: readonly Keyframe<T>[], t: number): number {
	let lo = 0;
	let hi = kfs.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (kfs[mid]!.time <= t) {
			ans = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
}

/** Evaluates an animatable property at content time `t` (flicks) per S01:KF-003. */
export function evaluate<T>(anim: Animatable<T>, t: number, opts?: EvaluateOptions): T {
	const kfs = anim.keyframes;
	if (kfs.length === 0) return clampValue(anim.value, opts?.clamp);
	const first = kfs[0]!;
	const last = kfs[kfs.length - 1]!;
	if (t <= first.time) return clampValue(first.value, opts?.clamp);
	if (t >= last.time) return clampValue(last.value, opts?.clamp);
	const i = keyframeIndexAt(kfs, t);
	const a = kfs[i]!;
	const b = kfs[i + 1]!;
	if (a.interpolation === 'hold' || opts?.holdOnly || isHoldOnlyValue(a.value)) {
		return clampValue(a.value, opts?.clamp);
	}
	const u = (t - a.time) / (b.time - a.time);
	const p =
		a.interpolation === 'linear' ? u : bezierProgress(u, outgoingEase(kfs, i), incomingEase(kfs, i + 1));
	// S03:KF-031: along a curved spatial path the progress is an arc-length fraction.
	const path = spatialSegment(kfs as readonly Keyframe<unknown>[], i);
	return clampValue(path ? (pathPointAt(path, p) as T) : lerpValue(a.value, b.value, p), opts?.clamp);
}

/** True when the property has at least one keyframe (stopwatch on). */
export function isAnimated(anim: { keyframes: readonly unknown[] } | undefined | null): boolean {
	return !!anim && anim.keyframes.length > 0;
}

export const EASE_PRESETS = {
	linear: LINEAR_EASE,
	/** "Ease In" / "Ease Out" / "Easy Ease" (S01:KF-004). */
	easy: { influence: 1 / 3, slope: 0 } satisfies Ease,
} as const;

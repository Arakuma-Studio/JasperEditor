// Keyframe evaluation (S01:KF-003, KF-004, KF-007). The single evaluator shared by the Player, the
// overlay, Effect Controls and the native planner (S01:KF-009).
import type { Animatable, Ease, Keyframe } from './schema/common.ts';

const LINEAR_EASE: Ease = { influence: 1 / 3, slope: 1 };
const AUTO_INFLUENCE = 1 / 3;
const TOLERANCE = 1e-6;

/** Cubic Bézier progress p(u) through (0,0), (a1, a1·s1), (1−a2, 1−a2·s2), (1,1) (S01:KF-003 step 5). */
export function bezierProgress(u: number, out: Ease, inn: Ease): number {
	if (u <= 0) return 0;
	if (u >= 1) return 1;
	const x1 = out.influence;
	const y1 = out.influence * out.slope;
	const x2 = 1 - inn.influence;
	const y2 = 1 - inn.influence * inn.slope;
	const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
	const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
	const dbx = (t: number) => 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
	// Newton iterations with bisection fallback.
	let t = u;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 12; i++) {
		const x = bx(t) - u;
		if (Math.abs(x) < TOLERANCE) return by(t);
		if (x > 0) hi = t;
		else lo = t;
		const d = dbx(t);
		if (Math.abs(d) < 1e-9) break;
		const next = t - x / d;
		if (next <= lo || next >= hi) break;
		t = next;
	}
	for (let i = 0; i < 60; i++) {
		t = (lo + hi) / 2;
		const x = bx(t) - u;
		if (Math.abs(x) < TOLERANCE) break;
		if (x > 0) hi = t;
		else lo = t;
	}
	return by(t);
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
	const across = distance(prev.value, next.value) / (next.time - prev.time);
	const seg =
		side === 'out'
			? distance(k.value, next.value) / (next.time - k.time)
			: distance(prev.value, k.value) / (k.time - prev.time);
	if (seg === 0 || !Number.isFinite(across / seg)) return 0;
	return Math.min(3, Math.max(0, across / seg));
}

function outgoingEase<T>(kfs: readonly Keyframe<T>[], i: number): Ease {
	const k = kfs[i]!;
	if (k.interpolation === 'auto-bezier')
		return { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'out') };
	if (k.interpolation === 'linear') return LINEAR_EASE;
	return k.easeOut;
}

function incomingEase<T>(kfs: readonly Keyframe<T>[], i: number): Ease {
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
export function keyframeIndexAt<T>(kfs: readonly Keyframe<T>[], t: number): number {
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
	return clampValue(lerpValue(a.value, b.value, p), opts?.clamp);
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

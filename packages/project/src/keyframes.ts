// Keyframe evaluation (S01:KF-003, KF-004, KF-007). The single evaluator shared by the Player, the
// overlay, Effect Controls and the native planner (S01:KF-009). vec2 point keys with a curved spatial
// path (S03:KF-030/031) are evaluated along the path by `keyframes-spatial.ts`.
import {
	activeMetric,
	fromMetric,
	isVec2Value,
	keysInMetric,
	metricWindow,
	pathPointAt,
	type SpatialMetric,
	spatialSegment,
	spatialSegmentLength,
} from './keyframes-spatial.ts';
import { lerpPathValues, pathValueDistance } from './path/interp.ts';
import { type BezierPath, isBezierPath } from './path/model.ts';
import {
	type Animatable,
	type Ease,
	IN_INTERPOLATIONS,
	type InInterpolation,
	type Interpolation,
	type Keyframe,
} from './schema/common.ts';
import { isShapeValue, lerpShapeValue } from './vector/values.ts';

const LINEAR_EASE: Ease = { influence: 1 / 3, slope: 1 };
/**
 * keyframe-sides: the ease a Linear side contributes to a per-side segment whose other side curves — After Effects'
 * linear temporal ease, influence ⅙ (16.67 %) at the segment's average speed (slope 1). After Effects reports it for
 * linear keys (`keyInTemporalEase` / `keyOutTemporalEase`, consumed as such by Lottie's exporter) and Premiere stores
 * exactly these numbers on linear sides (docs/wp-notes/keyframe-sides.md).
 */
const AE_LINEAR_SIDE: Ease = { influence: 1 / 6, slope: 1 };
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
	// wp masks: Bézier path values (Mask Path) — RMS vertex displacement.
	if (isBezierPath(a) && isBezierPath(b)) return pathValueDistance(a, b);
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

/**
 * Auto-bezier slope on one side of keyframe i (S01:KF-004). spatial-points: vec2 values with a `metric` measure their
 * speeds in its units (pixels).
 */
export function autoSlope<T>(
	kfs: readonly Keyframe<T>[],
	i: number,
	side: 'in' | 'out',
	metric?: SpatialMetric | null,
): number {
	const m = activeMetric(metric);
	if (m && isVec2Value(kfs[i]?.value)) {
		const w = metricWindow(kfs as readonly Keyframe<unknown>[], i, m);
		return autoSlope(w.keys, w.j, side);
	}
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

/**
 * keyframe-sides: the incoming temporal type of key `k` — its `inInterpolation`, else (documents written before) its
 * `interpolation`. Note that without `inInterpolation` a segment leaving a Linear key is linear whatever this says
 * (`segmentShape`); `effectiveInInterpolation` gives the type that actually shapes the arriving segment.
 */
export function inInterpolationOf<T>(k: Keyframe<T>): Interpolation {
	return k.inInterpolation ?? k.interpolation;
}

/** True when the segment arriving at key `i` is evaluated per side (the key has an explicit incoming type). */
export function isPerSideSegmentEnd<T>(kfs: readonly Keyframe<T>[], i: number): boolean {
	return kfs[i]?.inInterpolation !== undefined;
}

/** The ease of one side of key `i`, given its temporal type, in a per-side segment (After Effects' rules). */
function perSideEase<T>(
	kfs: readonly Keyframe<T>[],
	i: number,
	side: 'in' | 'out',
	type: Interpolation,
): Ease {
	const k = kfs[i]!;
	if (type === 'auto-bezier') return { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, side) };
	if (type === 'linear') return AE_LINEAR_SIDE;
	return side === 'in' ? k.easeIn : k.easeOut;
}

/**
 * Effective ease leaving key i as the evaluator uses it (auto-bezier → computed). Linear: ⅓·1 when the next key is
 * read the legacy way (the segment is then linear anyway), After Effects' ⅙·1 when it is per side (keyframe-sides).
 * spatial-points: `metric` = the metric of vec2 values (temporal auto-bezier speeds are measured in it).
 */
export function outgoingEase<T>(kfs: readonly Keyframe<T>[], i: number, metric?: SpatialMetric | null): Ease {
	const m = activeMetric(metric);
	if (m && isVec2Value(kfs[i]?.value)) {
		const w = metricWindow(kfs as readonly Keyframe<unknown>[], i, m);
		return outgoingEase(w.keys, w.j);
	}
	const k = kfs[i]!;
	if (isPerSideSegmentEnd(kfs, i + 1)) return perSideEase(kfs, i, 'out', k.interpolation);
	if (k.interpolation === 'auto-bezier')
		return { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'out') };
	if (k.interpolation === 'linear') return LINEAR_EASE;
	return k.easeOut;
}

/**
 * Effective ease arriving at key i as the evaluator uses it (per side when the key has `inInterpolation`).
 * spatial-points: `metric` as for `outgoingEase`.
 */
export function incomingEase<T>(kfs: readonly Keyframe<T>[], i: number, metric?: SpatialMetric | null): Ease {
	const m = activeMetric(metric);
	if (m && isVec2Value(kfs[i]?.value)) {
		const w = metricWindow(kfs as readonly Keyframe<unknown>[], i, m);
		return incomingEase(w.keys, w.j);
	}
	const k = kfs[i]!;
	if (k.inInterpolation !== undefined) return perSideEase(kfs, i, 'in', k.inInterpolation);
	if (k.interpolation === 'auto-bezier') return { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'in') };
	if (k.interpolation === 'linear') return LINEAR_EASE;
	return k.easeIn;
}

/**
 * How a span from key `ia` to key `ib` (adjacent keys, or the fixed ends of a roving run) interpolates
 * (keyframe-sides; S01:KF-003):
 * - `hold`: key `ia` leaves with Hold (After Effects: Hold is decided by the key the segment leaves);
 * - `linear`: progress = u. Legacy rule (key `ib` has no `inInterpolation`): whenever key `ia` leaves Linear.
 *   Per-side rule: when both sides are Linear;
 * - otherwise the cubic Bézier of `ia`'s outgoing ease and `ib`'s incoming ease (`bezierProgress`), where a Linear side
 *   of a per-side segment is After Effects' linear ease (influence ⅙ at the average speed).
 * Hold-only values and `holdOnly` parameters are the caller's business (they step whatever the keys say).
 */
export type SegmentShape = 'hold' | 'linear' | { out: Ease; in: Ease };
export function segmentShape<T>(
	kfs: readonly Keyframe<T>[],
	ia: number,
	ib = ia + 1,
	/** spatial-points: the metric of vec2 values (temporal auto-bezier speeds are measured in it). */
	metric?: SpatialMetric | null,
): SegmentShape {
	const m = activeMetric(metric);
	if (m && isVec2Value(kfs[ia]?.value)) {
		const lo = Math.max(0, ia - 2);
		return segmentShape(keysInMetric(kfs as readonly Keyframe<unknown>[], m, lo, ib + 4), ia - lo, ib - lo);
	}
	const a = kfs[ia]!;
	const b = kfs[ib]!;
	if (a.interpolation === 'hold') return 'hold';
	if (b.inInterpolation === undefined) {
		if (a.interpolation === 'linear') return 'linear';
		return { out: legacyOutgoingEase(kfs, ia), in: incomingEase(kfs, ib) };
	}
	if (a.interpolation === 'linear' && b.inInterpolation === 'linear') return 'linear';
	return {
		out: perSideEase(kfs, ia, 'out', a.interpolation),
		in: perSideEase(kfs, ib, 'in', b.inInterpolation),
	};
}

/** The legacy outgoing ease of key i (its next key read without `inInterpolation`). */
function legacyOutgoingEase<T>(kfs: readonly Keyframe<T>[], i: number): Ease {
	const k = kfs[i]!;
	if (k.interpolation === 'auto-bezier')
		return { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'out') };
	if (k.interpolation === 'linear') return LINEAR_EASE;
	return k.easeOut;
}

/** Progress (0 … 1, may overshoot) of a span's shape at normalised time u (hold → 0 before the end). */
export function shapeProgress(shape: SegmentShape, u: number): number {
	if (shape === 'hold') return u >= 1 ? 1 : 0;
	if (shape === 'linear') return u;
	return bezierProgress(u, shape.out, shape.in);
}

/** Progress of the segment leaving key i at normalised time u (`segmentShape` + `shapeProgress`). */
export function segmentProgress<T>(kfs: readonly Keyframe<T>[], i: number, u: number): number {
	return shapeProgress(segmentShape(kfs, i), u);
}

/**
 * The incoming type that actually shapes the segment arriving at key `i` — what the UI shows on the key's left
 * half: `hold` after a Hold key (After Effects draws it overridden), `linear` after a Linear key when the key is read
 * the legacy way, else `inInterpolationOf`. Null for the first key.
 */
export function effectiveInInterpolation<T>(kfs: readonly Keyframe<T>[], i: number): Interpolation | null {
	const prev = kfs[i - 1];
	if (!prev) return null;
	if (prev.interpolation === 'hold') return 'hold';
	const k = kfs[i]!;
	if (k.inInterpolation === undefined && prev.interpolation === 'linear') return 'linear';
	return inInterpolationOf(k);
}

/**
 * keyframe-sides: the explicit incoming side (type and ease) that reproduces exactly how the segment arriving at key
 * `i` evaluates now, so the key's outgoing type can change without touching that segment (the rule of
 * `keyframe.setInterpolation {side: 'out'}`, also used by the ease commands and the ease clipboard):
 * - a key with `inInterpolation` keeps it (ease = the one it contributes: computed for Auto Bezier, ⅙·1 for Linear);
 * - read the legacy way: after a Linear key the segment is linear → Linear; a Hold key arrives with its stored ease →
 *   Bezier; a Linear key after a curving key contributed ⅓·1 → Bezier {⅓, 1} (an explicit Linear side is After
 *   Effects' ⅙·1); a Linear first key, or one after a Hold, → Linear; otherwise its own type.
 */
export function explicitInSide<T>(
	kfs: readonly Keyframe<T>[],
	i: number,
	metric?: SpatialMetric | null,
	/** The key the arriving segment leaves (the fixed start of a roving run ending at `i`; default the previous key). */
	from = i - 1,
): { type: InInterpolation; ease: Ease } {
	const k = kfs[i]!;
	if (k.inInterpolation !== undefined) return { type: k.inInterpolation, ease: incomingEase(kfs, i, metric) };
	const prev = from >= 0 && from < i ? kfs[from] : undefined;
	const own = k.interpolation;
	if (prev?.interpolation === 'linear') return { type: 'linear', ease: AE_LINEAR_SIDE };
	if (own === 'hold') return { type: 'bezier', ease: k.easeIn };
	if (own === 'linear')
		return prev && prev.interpolation !== 'hold'
			? { type: 'bezier', ease: LINEAR_EASE }
			: { type: 'linear', ease: AE_LINEAR_SIDE };
	return { type: own, ease: incomingEase(kfs, i, metric) };
}

/** True for the interpolations that shape both sides of a key (After Effects: only when both sides are Bezier). */
export function isBothSided(t: Interpolation | InInterpolation | undefined): boolean {
	return t === 'auto-bezier' || t === 'continuous-bezier';
}

/**
 * Why key `k`'s incoming side is unreadable (INV-011), or null: `inInterpolation` must be one of
 * `IN_INTERPOLATIONS`, and a key whose two sides differ cannot use Auto / Continuous Bezier on either.
 */
export function keySidesIssue(k: { interpolation?: unknown; inInterpolation?: unknown }): string | null {
	const t = k.inInterpolation;
	if (t === undefined) return null;
	if (!(IN_INTERPOLATIONS as readonly unknown[]).includes(t)) return 'unknown incoming interpolation';
	if (
		t !== k.interpolation &&
		(isBothSided(t as InInterpolation) || isBothSided(k.interpolation as Interpolation))
	)
		return 'Auto Bezier and Continuous Bezier shape both sides of a key';
	return null;
}

/**
 * keyframe-sides, lenient document reading: walks a raw (migrated, not yet validated) document and deletes every
 * `inInterpolation` that is not one of `IN_INTERPOLATIONS` from objects inside a `keyframes` list (or a motion-graphic
 * `paramKeyframes` list), so a damaged value never fails a load; the key is then read the legacy way. Returns the ids
 * of the keys changed (for the repair report). Iterative with a depth bound (hostile nesting cannot overflow).
 */
export function dropUnreadableKeySides(raw: unknown): string[] {
	const changed: string[] = [];
	const stack: [unknown, number][] = [[raw, 0]];
	const MAX_DEPTH = 64;
	while (stack.length) {
		const [v, depth] = stack.pop()!;
		if (!v || typeof v !== 'object' || depth > MAX_DEPTH) continue;
		if (Array.isArray(v)) {
			for (const x of v) stack.push([x, depth + 1]);
			continue;
		}
		const o = v as Record<string, unknown>;
		if (
			'inInterpolation' in o &&
			'interpolation' in o &&
			'time' in o &&
			!(IN_INTERPOLATIONS as readonly unknown[]).includes(o.inInterpolation)
		) {
			if (o.inInterpolation !== undefined) changed.push(typeof o.id === 'string' ? o.id : '?');
			delete o.inInterpolation;
		}
		for (const x of Object.values(o)) if (x && typeof x === 'object') stack.push([x, depth + 1]);
	}
	return changed;
}

/**
 * Makes key `k`'s sides readable in place (repairDocument, pastes, presets): an unknown incoming type is dropped (the
 * key is read the legacy way), and Auto / Continuous Bezier on a key whose sides differ becomes Bezier with the
 * stored ease of that side. Returns true when something changed.
 */
export function normalizeKeySides(k: { interpolation: Interpolation; inInterpolation?: unknown }): boolean {
	if (k.inInterpolation === undefined) {
		if ('inInterpolation' in k) delete k.inInterpolation;
		return false;
	}
	if (!(IN_INTERPOLATIONS as readonly unknown[]).includes(k.inInterpolation)) {
		delete k.inInterpolation;
		return true;
	}
	const t = k.inInterpolation as InInterpolation;
	if (t === k.interpolation || (!isBothSided(t) && !isBothSided(k.interpolation))) return false;
	if (isBothSided(t)) k.inInterpolation = 'bezier';
	if (isBothSided(k.interpolation)) k.interpolation = 'bezier';
	return true;
}

/** True for value types that only step (booleans, strings, enums, font ids, media refs; S01:KF-007). */
export function isHoldOnlyValue(v: unknown): boolean {
	if (typeof v === 'number') return false;
	// wp shapes: Bézier paths and gradients interpolate (vector/values.ts).
	if (isShapeValue(v)) return false;
	// wp masks: Bézier path values interpolate (vertex-wise / smart vertex matching, path/interp.ts).
	if (isBezierPath(v)) return false;
	if (Array.isArray(v)) return !v.every((x) => typeof x === 'number');
	return true;
}

function lerpValue<T>(a: T, b: T, p: number): T {
	if (typeof a === 'number' && typeof b === 'number') return (a + p * (b - a)) as T;
	if (isShapeValue(a) && isShapeValue(b)) return lerpShapeValue(a, b, p);
	if (isBezierPath(a) && isBezierPath(b)) return lerpPathValues(a as BezierPath, b as BezierPath, p) as T;
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
	/**
	 * spatial-points: pixels per value unit of a vec2 point whose units are not isotropic (effect points normalised to
	 * the layer box: [box width, box height]). Arc length, Auto Bezier handles, temporal auto-bezier speeds and roving
	 * distances are measured in pixels; absent = value units (`activeMetric`).
	 */
	metric?: SpatialMetric | null;
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

/**
 * Expressions (wave expressions): an Animatable whose enabled expression has been *bound* to its place in a
 * document (`@jasper/expressions` `bindDocumentExpressions` / `bindSnapshotExpressions`) carries its evaluator
 * under this symbol (non-enumerable: JSON, structuredClone and Immer never see it). `evaluate()` delegates to it,
 * so every consumer of the shared evaluator (preview, overlays, native sampling, graphs, agents) renders the
 * post-expression value. Unbound Animatables (command handlers, the raw document) evaluate their keyframes.
 */
export const EXPRESSION_BINDING: unique symbol = Symbol.for('jasper.expressionBinding');

export type ExpressionBinding = {
	/** Post-expression value at content time `t` (falls back to the keyframed value on errors). */
	evaluate(t: number, opts?: EvaluateOptions): unknown;
	/** As `evaluate`, with the error message of a failed evaluation (`null` = the expression ran). */
	evaluateWithStatus(t: number, opts?: EvaluateOptions): { value: unknown; error: string | null };
};

/** The binding of an Animatable, if any. */
export function expressionBindingOf(anim: unknown): ExpressionBinding | undefined {
	return anim && typeof anim === 'object'
		? ((anim as { [EXPRESSION_BINDING]?: ExpressionBinding })[EXPRESSION_BINDING] ?? undefined)
		: undefined;
}

/** True when the property has an expression that renders (non-empty text, enabled). */
export function hasActiveExpression(
	anim: { expression?: { text: string; enabled: boolean } } | null | undefined,
): boolean {
	return !!anim?.expression?.enabled && anim.expression.text.trim().length > 0;
}

/**
 * Evaluates an animatable property at content time `t` (flicks) per S01:KF-003. A bound expression (see
 * `EXPRESSION_BINDING`) replaces the keyframed value with the expression's result.
 */
export function evaluate<T>(anim: Animatable<T>, t: number, opts?: EvaluateOptions): T {
	const bound = (anim as { [EXPRESSION_BINDING]?: ExpressionBinding })[EXPRESSION_BINDING];
	if (bound) return bound.evaluate(t, opts) as T;
	return evaluateKeyframes(anim, t, opts);
}

/** The keyframed (pre-expression) value of an animatable property at content time `t` (S01:KF-003). */
export function evaluateKeyframes<T>(anim: Animatable<T>, t: number, opts?: EvaluateOptions): T {
	const kfs = anim.keyframes;
	if (kfs.length === 0) return clampValue(anim.value, opts?.clamp);
	const first = kfs[0]!;
	const last = kfs[kfs.length - 1]!;
	if (t <= first.time) return clampValue(first.value, opts?.clamp);
	if (t >= last.time) return clampValue(last.value, opts?.clamp);
	const i = keyframeIndexAt(kfs, t);
	const a = kfs[i]!;
	const b = kfs[i + 1]!;
	// spatial-points: a point in non-isotropic units is evaluated with its lengths measured in pixels.
	const m = activeMetric(opts?.metric);
	if (m && isVec2Value(a.value) && isVec2Value(b.value))
		return clampValue(evaluateInMetric(kfs as readonly Keyframe<unknown>[], i, t, m, opts) as T, opts?.clamp);
	// keyframes-blend: inside a run of roving keys the whole run is one segment (Rove Across Time).
	if (!opts?.holdOnly) {
		const run = rovingRunAt(kfs as readonly Keyframe<unknown>[], i);
		if (run) return clampValue(rovingValue(kfs as readonly Keyframe<unknown>[], run, t) as T, opts?.clamp);
	}
	if (a.interpolation === 'hold' || opts?.holdOnly || isHoldOnlyValue(a.value)) {
		return clampValue(a.value, opts?.clamp);
	}
	const u = (t - a.time) / (b.time - a.time);
	// keyframe-sides: a's outgoing side and b's incoming side (legacy rule when b has no `inInterpolation`).
	const p = segmentProgress(kfs, i, u);
	// S03:KF-031: along a curved spatial path the progress is an arc-length fraction.
	const path = spatialSegment(kfs as readonly Keyframe<unknown>[], i);
	return clampValue(path ? (pathPointAt(path, p) as T) : lerpValue(a.value, b.value, p), opts?.clamp);
}

const metricKeysCache = new WeakMap<
	readonly Keyframe<unknown>[],
	{ m: SpatialMetric; keys: Keyframe<unknown>[] }
>();

/** Every key in metric units, cached per array and metric (documents are immutable between edits, as `rovingRuns`). */
function allKeysInMetric(kfs: readonly Keyframe<unknown>[], m: SpatialMetric): Keyframe<unknown>[] {
	const hit = metricKeysCache.get(kfs);
	if (hit && hit.m[0] === m[0] && hit.m[1] === m[1] && hit.keys.length === kfs.length) return hit.keys;
	const keys = keysInMetric(kfs, m);
	metricKeysCache.set(kfs, { m: [m[0], m[1]], keys });
	return keys;
}

/**
 * spatial-points: the value of the segment leaving vec2 key `i` (kfs[i].time ≤ t < kfs[i + 1].time) with lengths in
 * metric units. The progress comes from the keys in pixels (temporal auto-bezier speeds, roving distances), a curved
 * segment is walked by arc length in pixels (the point mapped back to value units: the same Bézier), and a straight
 * one is the plain lerp of the stored values at that progress.
 */
function evaluateInMetric(
	kfs: readonly Keyframe<unknown>[],
	i: number,
	t: number,
	m: SpatialMetric,
	opts: EvaluateOptions | undefined,
): unknown {
	const a = kfs[i]!;
	const b = kfs[i + 1]!;
	if (!opts?.holdOnly && kfs.some((k) => k.roving)) {
		const all = allKeysInMetric(kfs, m);
		const run = rovingRunAt(all, i);
		if (run) return fromMetric(rovingValue(all, run, t) as [number, number], m);
	}
	if (a.interpolation === 'hold' || opts?.holdOnly) return a.value;
	const w = metricWindow(kfs, i, m);
	const u = (t - a.time) / (b.time - a.time);
	const p = segmentProgress(w.keys, w.j, u);
	const path = spatialSegment(w.keys, w.j);
	return path ? fromMetric(pathPointAt(path, p), m) : lerpValue(a.value, b.value, p);
}

/**
 * A run of roving keys: fixed key `a`, roving keys a+1 … b−1, fixed key `b`. `cum[j]` = distance travelled from key a
 * to key a + j (arc length along curved spatial segments, value distance otherwise), `cum[b − a]` = the total.
 */
export type RovingRun = { a: number; b: number; cum: number[] };

/** A key that actually roves: flagged, not first / last, not hold, an interpolating value. */
export function isRovingKey(kfs: readonly Keyframe<unknown>[], i: number): boolean {
	const k = kfs[i];
	return (
		!!k?.roving &&
		i > 0 &&
		i < kfs.length - 1 &&
		k.interpolation !== 'hold' &&
		!isHoldOnlyValue(k.value) &&
		kfs[i - 1]!.interpolation !== 'hold'
	);
}

const runCache = new WeakMap<readonly Keyframe<unknown>[], RovingRun[]>();

/** Distance of the segment leaving key i (arc length on curved spatial segments). */
function segmentDistance(kfs: readonly Keyframe<unknown>[], i: number): number {
	const a = kfs[i]!.value;
	const b = kfs[i + 1]!.value;
	if (isVec2Value(a) && isVec2Value(b)) return spatialSegmentLength(kfs, i);
	return distance(a, b);
}

/** The roving runs of a key list (cached per array: documents are immutable between edits). */
export function rovingRuns(kfs: readonly Keyframe<unknown>[]): RovingRun[] {
	const hit = runCache.get(kfs);
	if (hit) return hit;
	const runs: RovingRun[] = [];
	if (kfs.some((k) => k.roving)) {
		let i = 1;
		while (i < kfs.length - 1) {
			if (!isRovingKey(kfs, i)) {
				i++;
				continue;
			}
			const a = i - 1;
			let b = i;
			while (b < kfs.length - 1 && isRovingKey(kfs, b)) b++;
			const cum = [0];
			for (let j = a; j < b; j++) cum.push(cum[cum.length - 1]! + segmentDistance(kfs, j));
			runs.push({ a, b, cum });
			i = b + 1;
		}
	}
	runCache.set(kfs, runs);
	return runs;
}

/** The run whose segments include the one leaving key i, or null. */
export function rovingRunAt(kfs: readonly Keyframe<unknown>[], i: number): RovingRun | null {
	for (const r of rovingRuns(kfs)) if (i >= r.a && i < r.b) return r;
	return null;
}

/** Progress (0 … 1, may overshoot) of a run at normalised time u: the fixed keys' eases, as for one segment. */
export function rovingProgress(kfs: readonly Keyframe<unknown>[], run: RovingRun, u: number): number {
	// keyframe-sides: the fixed keys' sides, as for one segment (`segmentShape` over the run). The fixed start key
	// never holds (isRovingKey).
	return shapeProgress(segmentShape(kfs, run.a, run.b), u);
}

/** Value of a run at time t: the point at the run's progress along its cumulative distance. */
function rovingValue(kfs: readonly Keyframe<unknown>[], run: RovingRun, t: number): unknown {
	const A = kfs[run.a]!;
	const B = kfs[run.b]!;
	const u = B.time > A.time ? (t - A.time) / (B.time - A.time) : 0;
	const p = rovingProgress(kfs, run, Math.min(1, Math.max(0, u)));
	const total = run.cum[run.cum.length - 1]!;
	const m = run.b - run.a;
	if (!(total > 0)) return A.value;
	const s = p * total;
	// The segment holding s (the first / last one extrapolate an overshoot).
	let j = 0;
	while (j < m - 1 && run.cum[j + 1]! <= s) j++;
	while (j < m - 1 && run.cum[j + 1]! - run.cum[j]! <= 0) j++;
	const len = run.cum[j + 1]! - run.cum[j]!;
	const q = len > 0 ? (s - run.cum[j]!) / len : 0;
	const i = run.a + j;
	const path = spatialSegment(kfs, i);
	return path ? pathPointAt(path, q) : lerpValue(kfs[i]!.value, kfs[i + 1]!.value, q);
}

/** The normalised time (0 … 1) at which a run's progress reaches `f` (bisection; eases are monotone in practice). */
function rovingTimeOf(kfs: readonly Keyframe<unknown>[], run: RovingRun, f: number): number {
	let lo = 0;
	let hi = 1;
	for (let k = 0; k < 64; k++) {
		const mid = (lo + hi) / 2;
		if (rovingProgress(kfs, run, mid) < f) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/**
 * Stores the times of roving keys (Rove Across Time): each roving key sits where the run's motion passes it, rounded
 * to whole flicks and kept strictly between its neighbours. Clears the flag of keys that cannot rove (first, last,
 * hold). Returns true when a time changed. Called by every command that edits keys (evaluation does not need the
 * stored times: they place the keys on the timeline).
 */
export function retimeRoving(kfs: Keyframe<unknown>[], metric?: SpatialMetric | null): boolean {
	if (!kfs.some((k) => k.roving)) return false;
	const m = activeMetric(metric);
	if (m && kfs.some((k) => isVec2Value(k.value))) {
		// spatial-points: the run's distances in pixels; the times (and cleared flags) are copied back.
		const keys = keysInMetric(kfs, m);
		const changed = retimeRoving(keys);
		keys.forEach((k, i) => {
			const o = kfs[i]!;
			if (o.time !== k.time) o.time = k.time;
			if (o.roving && !k.roving) delete o.roving;
		});
		return changed;
	}
	kfs.forEach((k, i) => {
		if (k.roving && !isRovingKey(kfs, i)) delete k.roving;
	});
	let changed = false;
	for (const run of rovingRuns([...kfs])) {
		const A = kfs[run.a]!;
		const B = kfs[run.b]!;
		const m = run.b - run.a;
		const total = run.cum[m]!;
		let prev = A.time;
		for (let r = 1; r < m; r++) {
			const f = total > 0 ? run.cum[r]! / total : r / m;
			const u = rovingTimeOf(kfs, run, f);
			let time = Math.round(A.time + u * (B.time - A.time));
			// Strictly increasing, leaving room for the remaining roving keys before B.
			time = Math.max(prev + 1, Math.min(B.time - (m - r), time));
			if (kfs[run.a + r]!.time !== time) {
				kfs[run.a + r]!.time = time;
				changed = true;
			}
			prev = time;
		}
	}
	return changed;
}

/**
 * Speed of the motion at roving key i (value units per flick, along the path), from the run's progress curve: used
 * when the key stops roving so its eases keep the speed through it.
 */
export function rovingSpeedAt(kfs: readonly Keyframe<unknown>[], i: number): number | null {
	const run = rovingRuns(kfs).find((r) => i > r.a && i < r.b);
	if (!run) return null;
	const A = kfs[run.a]!;
	const B = kfs[run.b]!;
	const T = B.time - A.time;
	const total = run.cum[run.b - run.a]!;
	if (!(T > 0) || !(total > 0)) return 0;
	const u = rovingTimeOf(kfs, run, run.cum[i - run.a]! / total);
	const h = 1e-4;
	const dp =
		(rovingProgress(kfs, run, Math.min(1, u + h)) - rovingProgress(kfs, run, Math.max(0, u - h))) /
		(Math.min(1, u + h) - Math.max(0, u - h));
	return (dp * total) / T;
}

/** Distance of the segment leaving key i (arc length for curved spatial segments). */
function frozenSegDistance(kfs: readonly Keyframe<unknown>[], i: number): number {
	const a = kfs[i]?.value;
	const b = kfs[i + 1]?.value;
	if (a === undefined || b === undefined) return 0;
	if (typeof a === 'number' && typeof b === 'number') return Math.abs(b - a);
	if (Array.isArray(a) && Array.isArray(b) && a.length === 2) return spatialSegmentLength(kfs, i);
	if (Array.isArray(a) && Array.isArray(b))
		return Math.sqrt(a.reduce((s: number, x, k) => s + ((b[k] as number) - (x as number)) ** 2, 0));
	return 0;
}

/**
 * Freezes a roving key (it stops roving): Continuous Bezier with the run's speed at the key on both sides, expressed
 * as the normalised slopes of its two segments (slope = speed / segment average speed).
 */
export function stopRoving(kfs: Keyframe<unknown>[], i: number, metric?: SpatialMetric | null): void {
	const k = kfs[i]!;
	if (!k.roving) return;
	const m = activeMetric(metric);
	if (m && isVec2Value(k.value)) {
		// spatial-points: the run's speed and the segments' average speeds in pixels (their ratios are the slopes).
		const keys = keysInMetric(kfs, m);
		stopRoving(keys, i);
		const f = keys[i]!;
		delete k.roving;
		k.interpolation = f.interpolation;
		if (f.inInterpolation !== undefined) k.inInterpolation = f.inInterpolation;
		k.easeIn = f.easeIn;
		k.easeOut = f.easeOut;
		return;
	}
	const v = isRovingKey(kfs, i) ? rovingSpeedAt(kfs, i) : null;
	delete k.roving;
	if (v === null) return;
	const avg = (j: number) => {
		const T = kfs[j + 1]!.time - kfs[j]!.time;
		const d = frozenSegDistance(kfs, j);
		return T > 0 && d > 0 ? d / T : 0;
	};
	const vin = avg(i - 1);
	const vout = avg(i);
	k.interpolation = 'continuous-bezier';
	// keyframe-sides: a key with an explicit incoming type keeps it consistent (Continuous shapes both sides).
	if (k.inInterpolation !== undefined) k.inInterpolation = 'continuous-bezier';
	k.easeIn = { influence: AUTO_INFLUENCE, slope: vin > 0 ? v / vin : 1 };
	k.easeOut = { influence: AUTO_INFLUENCE, slope: vout > 0 ? v / vout : 1 };
}

/**
 * The temporal fields key `i` of `kfs` (time order) needs when the keys are traversed backwards (pasted / re-timed
 * onto a clip running the other way): each segment mirrored, so the motion plays exactly in reverse. A segment's
 * shape is its left key's out-ease and its right key's in-ease (a Linear left key makes it linear), so after the
 * reversal key i is a Bezier key with easeOut = its old effective arriving ease and easeIn = its old effective
 * leaving ease (a Bézier ease mirrored about (½, ½) swaps its two controls). A Hold segment cannot be mirrored (a hold
 * shows its left key): it becomes a hold of the key it now starts from. Hold-only values keep holding.
 */
export function reversedKeyTiming(
	kfs: readonly Keyframe<unknown>[],
	i: number,
): Pick<Keyframe<unknown>, 'interpolation' | 'easeIn' | 'easeOut'> {
	const k = kfs[i]!;
	if (isHoldOnlyValue(k.value)) return { interpolation: 'hold', easeIn: k.easeIn, easeOut: k.easeOut };
	const prev = kfs[i - 1];
	const next = kfs[i + 1];
	// keyframe-sides: each old segment's actual shape (per side or legacy): a linear segment mirrors to a
	// linear-equivalent one, a curved one swaps its two eases. The result keys are read the legacy way (the callers
	// drop `inInterpolation`), where Bezier keys use exactly their stored eases.
	const inShape = prev ? segmentShape(kfs, i - 1) : 'linear';
	const outShape = next ? segmentShape(kfs, i) : 'linear';
	// Arriving side of the old segment (prev, k) → leaving side now (a Hold segment keeps the stored arriving ease).
	const arriving =
		inShape === 'linear' ? LINEAR_EASE : inShape === 'hold' ? incomingEase(kfs, i) : inShape.in;
	// Leaving side of the old segment (k, next) → arriving side now.
	const leaving =
		outShape === 'linear' ? LINEAR_EASE : outShape === 'hold' ? outgoingEase(kfs, i) : outShape.out;
	const interpolation = prev?.interpolation === 'hold' ? 'hold' : 'bezier';
	return {
		interpolation,
		easeIn: { influence: leaving.influence, slope: leaving.slope },
		easeOut: { influence: arriving.influence, slope: arriving.slope },
	};
}

/**
 * True when the property may change over time: it has keyframes (stopwatch on) or an active expression (which is
 * a function of time; renderers sample it per frame like keyframes).
 */
export function isAnimated(
	anim: { keyframes: readonly unknown[]; expression?: { text: string; enabled: boolean } } | undefined | null,
): boolean {
	return !!anim && (anim.keyframes.length > 0 || hasActiveExpression(anim));
}

/** True when the property has at least one keyframe (the stopwatch state; expressions ignored). */
export function hasKeyframes(anim: { keyframes: readonly unknown[] } | undefined | null): boolean {
	return !!anim && anim.keyframes.length > 0;
}

export const EASE_PRESETS = {
	linear: LINEAR_EASE,
	/** "Ease In" / "Ease Out" / "Easy Ease" (S01:KF-004). */
	easy: { influence: 1 / 3, slope: 0 } satisfies Ease,
} as const;

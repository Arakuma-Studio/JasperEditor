// Spatial (curved) interpolation of vec2 point keyframes (S03:KF-021, KF-030, KF-031). Part of the single
// keyframe evaluator (`keyframes.ts`, S03:KF-010): the composition, the monitor overlays, the panels, the MCP tools
// and the engine all reach these functions through `evaluate()`.
//
// - A segment a → b is the cubic Bézier `a.v, a.v + out(a), b.v + in(b), b.v` with the *effective* tangents of the
//   two keys: zero for `linear` (and for keys without `spatial`), the stored ones for `bezier` /
//   `continuous-bezier`, and Catmull-Rom tangents `±(next − prev) / 6` for `auto-bezier` (a missing neighbour is
//   the key itself), derived from the neighbours on every evaluation so moving a neighbour reshapes the path.
// - Temporal progress is mapped to arc length (KF-031) through a 64-sample table cached by the segment's control
//   points, so the temporal ease controls the speed along the path: Linear temporal = constant speed.
// - Segments whose control points lie on the chord (all-linear keys, two auto keys) are straight: the evaluator
//   then uses the plain component lerp, bit-identical to documents written before spatial interpolation existed.
// - spatial-points: values whose units are not isotropic (effect points normalised to the layer box) carry a
//   `SpatialMetric`, the size of one value unit along x and y in pixels. Lengths (arc length, the proportional Auto
//   Bezier handles, Continuous handle lengths, temporal auto-bezier speeds, roving distances) are measured in pixels;
//   the curve itself is the same Bézier (an affine map of a Bézier is the Bézier of the mapped control points), so
//   tangents stay in value units (docs/wp-notes/spatial-points.md).
import type { Keyframe, Spatial, SpatialInterpolation, Vec2 } from './schema/common.ts';

/** Arc-length samples per segment (S03:KF-031). */
const ARC_LENGTH_SAMPLES = 64;
/** Cached tables before the cache is reset (results never depend on the cache). */
const ARC_CACHE_LIMIT = 4096;

export type BezierSegment = readonly [Vec2, Vec2, Vec2, Vec2];
export type Tangents = { inTangent: Vec2; outTangent: Vec2 };

export function isVec2Value(v: unknown): v is Vec2 {
	return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
}

/**
 * spatial-points: pixels per value unit along x and y (an effect point normalised to a W × H layer box: [W, H]).
 * Absent = the value units are isotropic (Motion position in sequence px, Point Control in layer px).
 */
export type SpatialMetric = readonly [number, number];

/**
 * The metric when it changes anything, else null: absent, invalid (non-finite or ≤ 0 — a degenerate box) and
 * isotropic metrics ([s, s]: every length scales alike, so arc-length fractions, handle ratios and speed ratios are
 * unchanged) evaluate in value units, bit-identical to documents without a metric.
 */
export function activeMetric(m: SpatialMetric | null | undefined): SpatialMetric | null {
	if (!m) return null;
	const [sx, sy] = m;
	if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) return null;
	return sx === sy ? null : m;
}

const scaleVec = (v: Vec2, sx: number, sy: number): Vec2 => [v[0] * sx, v[1] * sy];

function keyInMetric(k: Keyframe<unknown>, sx: number, sy: number): Keyframe<unknown> {
	if (!isVec2Value(k.value)) return { ...k };
	const s = k.spatial;
	return {
		...k,
		value: scaleVec(k.value, sx, sy),
		...(s
			? {
					spatial: {
						...s,
						inTangent: isVec2Value(s.inTangent) ? scaleVec(s.inTangent, sx, sy) : [0, 0],
						outTangent: isVec2Value(s.outTangent) ? scaleVec(s.outTangent, sx, sy) : [0, 0],
					},
				}
			: {}),
	};
}

/**
 * Copies of keys `lo … hi − 1` in metric units (values and tangents × metric): every evaluator rule run on them measures
 * in pixels. Fresh objects, so editing helpers may mutate them.
 */
export function keysInMetric(
	kfs: readonly Keyframe<unknown>[],
	m: SpatialMetric,
	lo = 0,
	hi = kfs.length,
): Keyframe<unknown>[] {
	const out: Keyframe<unknown>[] = [];
	for (let i = Math.max(0, lo); i < Math.min(kfs.length, hi); i++) out.push(keyInMetric(kfs[i]!, m[0], m[1]));
	return out;
}

/** A metric-unit point or vector back in value units. */
export function fromMetric(v: Vec2, m: SpatialMetric): Vec2 {
	return [v[0] / m[0], v[1] / m[1]];
}

function spatialFromMetric(s: Spatial, m: SpatialMetric): Spatial {
	return { ...s, inTangent: fromMetric(s.inTangent, m), outTangent: fromMetric(s.outTangent, m) };
}

/**
 * The keys whose values and tangents decide the segments around key `i` (`i − 2 … i + 3`: the tangents of keys
 * i − 1 … i + 2 and their neighbours, and whether each of them is first / last), in metric units, with key `i` at
 * index `j`.
 */
export function metricWindow(
	kfs: readonly Keyframe<unknown>[],
	i: number,
	m: SpatialMetric,
): { keys: Keyframe<unknown>[]; j: number } {
	const lo = Math.max(0, i - 2);
	return { keys: keysInMetric(kfs, m, lo, i + 4), j: i - lo };
}

/** Spatial mode of a key; keys without `spatial` are linear. */
export function spatialModeOf(k: Pick<Keyframe<unknown>, 'spatial'>): SpatialInterpolation {
	return k.spatial?.mode ?? 'linear';
}

/**
 * Auto Bezier tangents of key `i` (S03:KF-030). keyframes-blend: keys with `spatial.auto: 'proportional'` (every key
 * made Auto Bezier now) use After Effects' rule — direction (next − prev), each handle ⅓ of its neighbouring chord,
 * none on the first / last key (EffectCraft `auto_spatial`); others keep the Catmull-Rom rule `out = (next − prev) / 6`,
 * `in = −out` they were written with.
 */
export function autoTangents(kfs: readonly Keyframe<unknown>[], i: number): Tangents {
	const k = kfs[i]!;
	if (k.spatial?.auto === 'proportional') return proportionalTangents(kfs, i);
	const prev = kfs[i - 1] ?? k;
	const next = kfs[i + 1] ?? k;
	if (!isVec2Value(k.value) || !isVec2Value(prev.value) || !isVec2Value(next.value))
		return { inTangent: [0, 0], outTangent: [0, 0] };
	const dx = (next.value[0] - prev.value[0]) / 6;
	const dy = (next.value[1] - prev.value[1]) / 6;
	return { inTangent: [0 - dx, 0 - dy], outTangent: [dx, dy] };
}

function proportionalTangents(kfs: readonly Keyframe<unknown>[], i: number): Tangents {
	const k = kfs[i]!;
	const prev = kfs[i - 1];
	const next = kfs[i + 1];
	const none: Tangents = { inTangent: [0, 0], outTangent: [0, 0] };
	if (!prev || !next || !isVec2Value(k.value) || !isVec2Value(prev.value) || !isVec2Value(next.value))
		return none;
	const dx = next.value[0] - prev.value[0];
	const dy = next.value[1] - prev.value[1];
	const dl = Math.hypot(dx, dy);
	if (!(dl > 1e-12)) return none;
	const lin = Math.hypot(k.value[0] - prev.value[0], k.value[1] - prev.value[1]) / 3;
	const lout = Math.hypot(next.value[0] - k.value[0], next.value[1] - k.value[1]) / 3;
	const nx = dx / dl;
	const ny = dy / dl;
	return { inTangent: [0 - nx * lin, 0 - ny * lin], outTangent: [nx * lout, ny * lout] };
}

/**
 * Tangents of key `i` as the evaluator uses them (zero for linear, derived for auto, stored otherwise), in value
 * units. spatial-points: `metric` = the value units' metric (Auto Bezier handle lengths are measured in it).
 */
export function effectiveTangents(
	kfs: readonly Keyframe<unknown>[],
	i: number,
	metric?: SpatialMetric | null,
): Tangents {
	const m = activeMetric(metric);
	if (m && kfs[i]?.spatial?.mode === 'auto-bezier') {
		const w = metricWindow(kfs, i, m);
		const t = effectiveTangents(w.keys, w.j);
		return { inTangent: fromMetric(t.inTangent, m), outTangent: fromMetric(t.outTangent, m) };
	}
	const k = kfs[i];
	if (!k?.spatial || !isVec2Value(k.value)) return { inTangent: [0, 0], outTangent: [0, 0] };
	switch (k.spatial.mode) {
		case 'linear':
			return { inTangent: [0, 0], outTangent: [0, 0] };
		case 'auto-bezier':
			return autoTangents(kfs, i);
		default: {
			const { inTangent: a, outTangent: b } = k.spatial;
			return { inTangent: [a[0], a[1]], outTangent: [b[0], b[1]] };
		}
	}
}

/** True when every control point lies on the chord p0 → p3 (the cubic then runs along it monotonically). */
function isStraight(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): boolean {
	const dx = p3[0] - p0[0];
	const dy = p3[1] - p0[1];
	const L2 = dx * dx + dy * dy;
	const onChord = (q: Vec2) => {
		const qx = q[0] - p0[0];
		const qy = q[1] - p0[1];
		if (L2 === 0) return qx === 0 && qy === 0;
		const eps = 1e-9 * L2;
		const cross = qx * dy - qy * dx;
		const dot = qx * dx + qy * dy;
		return Math.abs(cross) <= eps && dot >= -eps && dot <= L2 + eps;
	};
	return onChord(p1) && onChord(p2);
}

/**
 * The curved path segment leaving key `i` (control points in value units), or null when the segment is
 * straight (plain lerp) or not a vec2 segment.
 */
export function spatialSegment(kfs: readonly Keyframe<unknown>[], i: number): BezierSegment | null {
	const a = kfs[i];
	const b = kfs[i + 1];
	if (!a || !b || !isVec2Value(a.value) || !isVec2Value(b.value)) return null;
	if (spatialModeOf(a) === 'linear' && spatialModeOf(b) === 'linear') return null;
	const out = effectiveTangents(kfs, i).outTangent;
	const inn = effectiveTangents(kfs, i + 1).inTangent;
	const p0: Vec2 = [a.value[0], a.value[1]];
	const p1: Vec2 = [a.value[0] + out[0], a.value[1] + out[1]];
	const p2: Vec2 = [b.value[0] + inn[0], b.value[1] + inn[1]];
	const p3: Vec2 = [b.value[0], b.value[1]];
	return isStraight(p0, p1, p2, p3) ? null : [p0, p1, p2, p3];
}

/** Point of the cubic at parameter `t` ∈ [0, 1]. */
export function bezierPoint(seg: BezierSegment, t: number): Vec2 {
	const [p0, p1, p2, p3] = seg;
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const c = 3 * u * t * t;
	const d = t * t * t;
	return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

const arcCache = new Map<string, Float64Array>();

/** Cumulative arc length at t = j / 64 (j = 0…64), cached by segment content (S03:KF-031). */
export function arcLengthTable(seg: BezierSegment): Float64Array {
	const key = `${seg[0][0]},${seg[0][1]},${seg[1][0]},${seg[1][1]},${seg[2][0]},${seg[2][1]},${seg[3][0]},${seg[3][1]}`;
	const hit = arcCache.get(key);
	if (hit) return hit;
	const table = new Float64Array(ARC_LENGTH_SAMPLES + 1);
	let prev = seg[0];
	for (let j = 1; j <= ARC_LENGTH_SAMPLES; j++) {
		const p = bezierPoint(seg, j / ARC_LENGTH_SAMPLES);
		table[j] = table[j - 1]! + Math.hypot(p[0] - prev[0], p[1] - prev[1]);
		prev = p;
	}
	if (arcCache.size >= ARC_CACHE_LIMIT) arcCache.clear();
	arcCache.set(key, table);
	return table;
}

function unit(v: Vec2): Vec2 | null {
	const l = Math.hypot(v[0], v[1]);
	return l > 0 ? [v[0] / l, v[1] / l] : null;
}
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];

/**
 * Point at arc-length fraction `s` of the segment (S03:KF-031 `pathPointAt`). Temporal overshoot (`s` outside
 * [0, 1], Bézier eases with steep slopes) continues along the end tangent.
 */
export function pathPointAt(seg: BezierSegment, s: number): Vec2 {
	const table = arcLengthTable(seg);
	const total = table[ARC_LENGTH_SAMPLES]!;
	const [p0, p1, p2, p3] = seg;
	if (s <= 0 || s >= 1) {
		const atEnd = s >= 1;
		const base = atEnd ? p3 : p0;
		const extra = (atEnd ? s - 1 : s) * total;
		if (extra === 0) return [base[0], base[1]];
		const dir = atEnd
			? (unit(sub(p3, p2)) ?? unit(sub(p3, p1)) ?? unit(sub(p3, p0)))
			: (unit(sub(p1, p0)) ?? unit(sub(p2, p0)) ?? unit(sub(p3, p0)));
		return dir ? [base[0] + dir[0] * extra, base[1] + dir[1] * extra] : [base[0], base[1]];
	}
	if (total <= 0) return [p0[0], p0[1]];
	const target = s * total;
	let lo = 0;
	let hi = ARC_LENGTH_SAMPLES;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (table[mid]! <= target) lo = mid;
		else hi = mid;
	}
	const l0 = table[lo]!;
	const l1 = table[hi]!;
	const f = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
	return bezierPoint(seg, (lo + f) / ARC_LENGTH_SAMPLES);
}

/**
 * Value distance of the segment leaving key `i`: the path length when curved, else the chord. spatial-points: with a
 * `metric` the length is in its units (pixels).
 */
export function spatialSegmentLength(
	kfs: readonly Keyframe<unknown>[],
	i: number,
	metric?: SpatialMetric | null,
): number {
	const m = activeMetric(metric);
	if (m) {
		const w = metricWindow(kfs, i, m);
		return spatialSegmentLength(w.keys, w.j);
	}
	const seg = spatialSegment(kfs, i);
	if (seg) return arcLengthTable(seg)[ARC_LENGTH_SAMPLES]!;
	const a = kfs[i]?.value;
	const b = kfs[i + 1]?.value;
	return isVec2Value(a) && isVec2Value(b) ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
}

/** Spatial input of the keyframe commands: tangents omitted = keep the key's current ones. */
type SpatialInput = { mode: SpatialInterpolation; inTangent?: Vec2; outTangent?: Vec2 };

/** `other` turned to point opposite `lead`, keeping its length (mirrored when it has none). */
function opposite(lead: Vec2, other: Vec2): Vec2 {
	const l = Math.hypot(lead[0], lead[1]);
	if (l === 0) return [other[0], other[1]];
	const k = Math.hypot(other[0], other[1]);
	const s = (k > 0 ? k : l) / l;
	return [0 - lead[0] * s, 0 - lead[1] * s];
}

function isOpposite(a: Vec2, b: Vec2): boolean {
	const la = Math.hypot(a[0], a[1]);
	const lb = Math.hypot(b[0], b[1]);
	if (la === 0 || lb === 0) return true;
	const cross = a[0] * b[1] - a[1] * b[0];
	const dot = a[0] * b[0] + a[1] * b[1];
	return Math.abs(cross) <= 1e-9 * la * lb && dot < 0;
}

/** Spatial data of a NEW key of a point property whose default mode is `mode` (S03:KF-021). */
export function newKeySpatial(mode: SpatialInterpolation | undefined, value: unknown): Spatial | undefined {
	if (!mode || mode === 'linear' || !isVec2Value(value)) return undefined;
	return {
		mode,
		inTangent: [0, 0],
		outTangent: [0, 0],
		...(mode === 'auto-bezier' ? { auto: 'proportional' as const } : {}),
	};
}

/**
 * Sets the spatial interpolation of key `i` in place (right-click ▸ Spatial Interpolation): Linear zeroes the
 * tangents, Auto Bezier derives them, Bezier / Continuous Bezier keep the current ones (a Linear key starts from
 * its Auto Bezier tangents) and Continuous turns the in tangent opposite the out tangent.
 */
export function setSpatialMode(
	kfs: Keyframe<unknown>[],
	i: number,
	input: SpatialInput,
	metric?: SpatialMetric | null,
): void {
	const m = activeMetric(metric);
	if (m) {
		// spatial-points: the rule runs in pixels (handle lengths), the result is stored in value units.
		const keys = keysInMetric(kfs, m);
		setSpatialMode(keys, i, {
			mode: input.mode,
			...(input.inTangent ? { inTangent: scaleVec(input.inTangent, m[0], m[1]) } : {}),
			...(input.outTangent ? { outTangent: scaleVec(input.outTangent, m[0], m[1]) } : {}),
		});
		kfs[i]!.spatial = spatialFromMetric(keys[i]!.spatial!, m);
		return;
	}
	const k = kfs[i]!;
	const mode = input.mode;
	if (mode === 'linear') {
		k.spatial = { mode, inTangent: [0, 0], outTangent: [0, 0] };
		return;
	}
	if (mode === 'auto-bezier') {
		// keyframes-blend: (re-)applying Auto Bezier uses After Effects' proportional rule.
		k.spatial = { mode, inTangent: [0, 0], outTangent: [0, 0], auto: 'proportional' };
		k.spatial = { ...k.spatial, ...autoTangents(kfs, i) };
		return;
	}
	const base = spatialModeOf(k) === 'linear' ? proportionalTangents(kfs, i) : effectiveTangents(kfs, i);
	let inTangent: Vec2 = input.inTangent ? [input.inTangent[0], input.inTangent[1]] : base.inTangent;
	let outTangent: Vec2 = input.outTangent ? [input.outTangent[0], input.outTangent[1]] : base.outTangent;
	if (mode === 'continuous-bezier') {
		if (input.inTangent && !input.outTangent) outTangent = opposite(inTangent, outTangent);
		else inTangent = opposite(outTangent, inTangent);
	}
	k.spatial = { mode, inTangent, outTangent };
}

/**
 * Edits the tangents of key `i` in place (motion-path handle drag, S03:OVL-020). Bezier keys keep independent
 * sides; any other key becomes Continuous Bezier with the other side turned opposite (keeping its length), unless
 * `breakContinuity` (Alt) makes it Bezier. Both sides given and not opposite → Bezier.
 */
export function setTangents(
	kfs: Keyframe<unknown>[],
	i: number,
	edit: { inTangent?: Vec2; outTangent?: Vec2; breakContinuity?: boolean },
	metric?: SpatialMetric | null,
): void {
	const m = activeMetric(metric);
	if (m) {
		// spatial-points: Continuous keeps the other handle's length in pixels.
		const keys = keysInMetric(kfs, m);
		setTangents(keys, i, {
			...(edit.inTangent ? { inTangent: scaleVec(edit.inTangent, m[0], m[1]) } : {}),
			...(edit.outTangent ? { outTangent: scaleVec(edit.outTangent, m[0], m[1]) } : {}),
			...(edit.breakContinuity ? { breakContinuity: true } : {}),
		});
		kfs[i]!.spatial = spatialFromMetric(keys[i]!.spatial!, m);
		return;
	}
	const k = kfs[i]!;
	const cur = effectiveTangents(kfs, i);
	let inTangent: Vec2 = edit.inTangent ? [edit.inTangent[0], edit.inTangent[1]] : cur.inTangent;
	let outTangent: Vec2 = edit.outTangent ? [edit.outTangent[0], edit.outTangent[1]] : cur.outTangent;
	let mode: SpatialInterpolation;
	if (edit.breakContinuity || spatialModeOf(k) === 'bezier') mode = 'bezier';
	else if (edit.inTangent && edit.outTangent)
		mode = isOpposite(inTangent, outTangent) ? 'continuous-bezier' : 'bezier';
	else {
		mode = 'continuous-bezier';
		if (edit.outTangent) inTangent = opposite(outTangent, inTangent);
		else outTangent = opposite(inTangent, outTangent);
	}
	k.spatial = { mode, inTangent, outTangent };
}

/**
 * Stores the derived tangents of every Auto Bezier key (a cache for the UI and agents; evaluation derives them).
 * spatial-points: `metric` = the value units' metric.
 */
export function refreshAutoTangents(kfs: Keyframe<unknown>[], metric?: SpatialMetric | null): void {
	const m = activeMetric(metric);
	const keys = m ? keysInMetric(kfs, m) : kfs;
	kfs.forEach((k, i) => {
		if (k.spatial?.mode !== 'auto-bezier') return;
		const a = autoTangents(keys, i);
		const t = m ? { inTangent: fromMetric(a.inTangent, m), outTangent: fromMetric(a.outTangent, m) } : a;
		k.spatial.inTangent = t.inTangent;
		k.spatial.outTangent = t.outTangent;
	});
}

/** The key traversed backwards (pasted or re-timed onto a clip running the other way): in and out swap. */
export function reversedSpatial(s: Spatial | undefined): Spatial | undefined {
	return s
		? { ...s, inTangent: [s.outTangent[0], s.outTangent[1]], outTangent: [s.inTangent[0], s.inTangent[1]] }
		: undefined;
}

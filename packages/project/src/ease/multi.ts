// Multi-point ease curves laid over a keyframe span (keyframe assistant): the keys strictly inside the span go, new
// keys are created at the curve's interior points, and every piece of the curve becomes one keyframe segment whose
// eases are the piece normalised to it, so the motion follows the curve exactly:
//   key m time  = tA + x_m · (tB − tA)            (whole flicks, no frame rounding)
//   key m value = vA + y_m · (vB − vA)            (numbers / vectors / colours componentwise)
//   piece m     = cubic-bezier of the piece in its own unit square → (easeOut of key m, easeIn of key m + 1).
// A piece whose two ends have the same y cannot hold a shaped ease (its value does not change, so the model draws a
// constant): it becomes linear and is reported (`flat`).
//
// Point properties (vec2 with spatial interpolation) keep their drawn motion path: y is the fraction of the path's
// arc length from A to B (through the removed keys), y outside [0, 1] continues along the start / end tangent by
// y·L / (y − 1)·L. Each new key sits on the path and the path's Bézier segments are split there (de Casteljau), so
// the drawn path is unchanged. Where a piece would run across a corner of the path (an original key, or a span end
// next to a curved segment) the curve piece itself is split at that y (de Casteljau in the curve's (x, y) plane) and
// a key is added there; pieces are also split where their y turns (an apex inside a piece), so each piece is
// monotone. Every piece then lies on one original path segment (or on a straight extension) and the evaluator's
// arc-length progress along it, which stays in [0, 1], is the curve's y. Arc lengths use the evaluator's 64-sample tables
// (`keyframes-spatial.ts`), so positions match `pathPointAt` of the original segments exactly and the timing to the
// table's accuracy. spatial-points: an effect point (values normalised to the layer box) is laid out with the
// evaluator's metric — the path's arc lengths, corners and splits are measured on the keys in the box's pixels
// (`keysInMetric`), the points and handles mapped back to value units (the same Béziers) — so the rebuilt keys
// follow the curve in the pixels that render.
import {
	activeMetric,
	arcLengthTable,
	type BezierSegment,
	bezierPoint,
	effectiveTangents,
	fromMetric,
	isVec2Value,
	keysInMetric,
	type SpatialMetric,
	spatialSegment,
} from '../keyframes-spatial.ts';
import type { Ease, Keyframe, Spatial, SpatialInterpolation, Vec2 } from '../schema/common.ts';
import { cubicToEases, type EaseSegment, easeCurveSegments, type MultiEase } from './curve.ts';
import { captureEases, LINEAR_EASE, writeSpan } from './segments.ts';

type Keys = Keyframe<unknown>[];
type Pt = readonly [number, number];
type Piece = [Pt, Pt, Pt, Pt];

const ARC_SAMPLES = 64;
/** Pieces whose y changes by less than this are flat (no shaped ease possible). */
const FLAT_EPS = 1e-12;
/** Splits closer than this (in the piece parameter) to a piece end are skipped. */
const SPLIT_EPS = 1e-9;

export class MultiEaseError extends Error {}

export type MultiEaseInput = {
	/** Keys of one property, sorted by time (mutated: the result reuses the span's end keys). */
	kfs: Keys;
	/** Span: first and last key index (both fixed keys). */
	a: number;
	b: number;
	curve: MultiEase;
	/** True for point properties: keep the drawn motion path (arc-length placement). */
	spatial: boolean;
	/** spatial-points: the evaluator's metric of the point values (effect points: [box width, box height]). */
	metric?: SpatialMetric | null;
	newId: () => string;
	/** Validates and clamps a new key value to the property's range. */
	validate: (v: unknown) => { value: unknown; clamped: boolean };
};

export type MultiEaseResult = {
	keys: Keys;
	created: string[];
	removed: string[];
	/** Pieces that had a shape but equal end values (made linear). */
	flat: number;
	/** A new value was clamped to the property's range. */
	clamped: boolean;
	/** Extra keys inserted where the curve crosses a corner of the motion path. */
	pathSplits: number;
	/** The eases written per new segment, in order (for clamped-progress checks). */
	eases: { out: Ease; in: Ease }[];
};

// ---- Bézier helpers in 2D -------------------------------------------------------------------------------------

const lerp2 = (p: Pt, q: Pt, t: number): [number, number] => [
	p[0] + (q[0] - p[0]) * t,
	p[1] + (q[1] - p[1]) * t,
];

/** de Casteljau split of a cubic at t: [left, right]. */
function splitCubic(c: readonly [Pt, Pt, Pt, Pt], t: number): [Piece, Piece] {
	const [p0, p1, p2, p3] = c;
	const a = lerp2(p0, p1, t);
	const b = lerp2(p1, p2, t);
	const d = lerp2(p2, p3, t);
	const e = lerp2(a, b, t);
	const f = lerp2(b, d, t);
	const m = lerp2(e, f, t);
	return [
		[p0, a, e, m],
		[m, f, d, p3],
	];
}

/** The part of a cubic between parameters t0 and t1 (reversed when t1 < t0). */
function subCubic(c: readonly [Pt, Pt, Pt, Pt], t0: number, t1: number): Piece {
	const lo = Math.min(t0, t1);
	const hi = Math.max(t0, t1);
	let part: Piece = [c[0], c[1], c[2], c[3]];
	if (hi < 1) part = splitCubic(part, hi)[0];
	if (lo > 0) part = splitCubic(part, hi > 0 ? lo / hi : 0)[1];
	return t1 < t0 ? [part[3], part[2], part[1], part[0]] : part;
}

const cubicY = (c: Piece, t: number) => {
	const s = 1 - t;
	return s * s * s * c[0][1] + 3 * s * s * t * c[1][1] + 3 * s * t * t * c[2][1] + t * t * t * c[3][1];
};

/**
 * Parameters in (0, 1) where the piece's y turns (dy/dτ changes sign). Splitting there makes every piece monotone in
 * y, so its progress never leaves [0, 1] and the evaluator never extends it along a tangent off the path.
 */
function extrema(c: Piece): number[] {
	const d0 = c[1][1] - c[0][1];
	const d1 = c[2][1] - c[1][1];
	const d2 = c[3][1] - c[2][1];
	const a = d0 - 2 * d1 + d2;
	const b = 2 * (d1 - d0);
	const roots: number[] = [];
	if (Math.abs(a) < 1e-12) {
		if (Math.abs(b) > 1e-12) roots.push(-d0 / b);
	} else {
		const disc = b * b - 4 * a * d0;
		if (disc > 0) {
			const q = Math.sqrt(disc);
			roots.push((-b - q) / (2 * a), (-b + q) / (2 * a));
		}
	}
	return roots.filter((r) => r > SPLIT_EPS && r < 1 - SPLIT_EPS);
}

/** Parameters in (0, 1) where the piece's y crosses `level` (sign changes; touches are not crossings). */
function crossings(c: Piece, level: number): number[] {
	const N = 128;
	const out: number[] = [];
	let t0 = 0;
	let f0 = cubicY(c, 0) - level;
	for (let k = 1; k <= N; k++) {
		const t1 = k / N;
		const f1 = cubicY(c, t1) - level;
		if ((f0 < 0 && f1 > 0) || (f0 > 0 && f1 < 0)) {
			let lo = t0;
			let hi = t1;
			const sLo = Math.sign(f0);
			for (let i = 0; i < 64; i++) {
				const mid = (lo + hi) / 2;
				if (Math.sign(cubicY(c, mid) - level) === sLo) lo = mid;
				else hi = mid;
			}
			const r = (lo + hi) / 2;
			if (r > SPLIT_EPS && r < 1 - SPLIT_EPS) out.push(r);
		}
		if (f1 !== 0) {
			t0 = t1;
			f0 = f1;
		}
	}
	return out;
}

// ---- The motion path of a span --------------------------------------------------------------------------------

type Cell = {
	/** Curved segment, or null for a straight one (p0 → p3). */
	seg: BezierSegment | null;
	p0: Vec2;
	p3: Vec2;
	len: number;
	/** Fractions of the total length where the cell starts / ends. */
	f0: number;
	f1: number;
};

type SpanPath = {
	cells: Cell[];
	total: number;
	A: Vec2;
	B: Vec2;
	startDir: Vec2 | null;
	endDir: Vec2 | null;
	/** Fractions where a piece must not run across (path corners, span ends next to curved segments). */
	breaks: number[];
};

function unit(v: readonly [number, number]): Vec2 | null {
	const l = Math.hypot(v[0], v[1]);
	return l > 0 ? [v[0] / l, v[1] / l] : null;
}
const sub = (a: Pt, b: Pt): Vec2 => [a[0] - b[0], a[1] - b[1]];

function startDirection(c: Cell): Vec2 | null {
	if (!c.seg) return unit(sub(c.p3, c.p0));
	const [p0, p1, p2, p3] = c.seg;
	return unit(sub(p1, p0)) ?? unit(sub(p2, p0)) ?? unit(sub(p3, p0));
}
function endDirection(c: Cell): Vec2 | null {
	if (!c.seg) return unit(sub(c.p3, c.p0));
	const [p0, p1, p2, p3] = c.seg;
	return unit(sub(p3, p2)) ?? unit(sub(p3, p1)) ?? unit(sub(p3, p0));
}

function spanPath(kfs: Keys, a: number, b: number): SpanPath {
	const cells: Cell[] = [];
	let total = 0;
	for (let i = a; i < b; i++) {
		const p0 = kfs[i]!.value as Vec2;
		const p3 = kfs[i + 1]!.value as Vec2;
		const seg = spatialSegment(kfs, i);
		const len = seg ? arcLengthTable(seg)[ARC_SAMPLES]! : Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
		cells.push({ seg, p0: [p0[0], p0[1]], p3: [p3[0], p3[1]], len, f0: total, f1: total + len });
		total += len;
	}
	for (const c of cells) {
		c.f0 = total > 0 ? c.f0 / total : 0;
		c.f1 = total > 0 ? c.f1 / total : 0;
	}
	const moving = cells.filter((c) => c.len > 0);
	const first = moving[0];
	const last = moving[moving.length - 1];
	const breaks: number[] = [];
	if (first?.seg) breaks.push(0);
	for (let k = 0; k + 1 < moving.length; k++) {
		const l = moving[k]!;
		const r = moving[k + 1]!;
		const dl = endDirection(l);
		const dr = startDirection(r);
		const straightOn =
			!l.seg &&
			!r.seg &&
			!!dl &&
			!!dr &&
			Math.abs(dl[0] * dr[1] - dl[1] * dr[0]) < 1e-9 &&
			dl[0] * dr[0] + dl[1] * dr[1] > 0;
		if (!straightOn) breaks.push(l.f1);
	}
	if (last?.seg) breaks.push(1);
	return {
		cells,
		total,
		A: [...(kfs[a]!.value as Vec2)] as Vec2,
		B: [...(kfs[b]!.value as Vec2)] as Vec2,
		startDir: first ? startDirection(first) : null,
		endDir: last ? endDirection(last) : null,
		breaks,
	};
}

/** Parameter of a segment at arc-length fraction f, inverting the 64-sample table as `pathPointAt` does. */
function paramAtFraction(seg: BezierSegment, f: number): number {
	const table = arcLengthTable(seg);
	const total = table[ARC_SAMPLES]!;
	if (f <= 0 || total <= 0) return 0;
	if (f >= 1) return 1;
	const target = f * total;
	let lo = 0;
	let hi = ARC_SAMPLES;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (table[mid]! <= target) lo = mid;
		else hi = mid;
	}
	const l0 = table[lo]!;
	const l1 = table[hi]!;
	return (lo + (l1 > l0 ? (target - l0) / (l1 - l0) : 0)) / ARC_SAMPLES;
}

/** Where fraction y of the path is: the point, and the cell / parameter when it lies on a curved segment. */
function locateOnPath(p: SpanPath, y: number): { point: Vec2; cell: number; t: number } {
	if (y <= 0) {
		const d = p.startDir ?? [0, 0];
		return { point: [p.A[0] + d[0] * y * p.total, p.A[1] + d[1] * y * p.total], cell: -1, t: 0 };
	}
	if (y >= 1) {
		const d = p.endDir ?? [0, 0];
		const e = (y - 1) * p.total;
		return { point: [p.B[0] + d[0] * e, p.B[1] + d[1] * e], cell: p.cells.length, t: 1 };
	}
	let k = p.cells.findIndex((c) => c.len > 0 && y < c.f1);
	if (k < 0) k = p.cells.length - 1;
	const c = p.cells[k]!;
	const f = c.len > 0 ? (y * p.total - c.f0 * p.total) / c.len : 0;
	if (!c.seg) return { point: lerp2(c.p0, c.p3, f) as Vec2, cell: k, t: f };
	const t = paramAtFraction(c.seg, f);
	return { point: bezierPoint(c.seg, t), cell: k, t };
}

// ---- The rebuild ------------------------------------------------------------------------------------------------

function isNumeric(v: unknown): v is number | number[] {
	return typeof v === 'number' || (Array.isArray(v) && v.every((x) => typeof x === 'number'));
}

function lerpValue(a: number | number[], b: number | number[], y: number): number | number[] {
	if (typeof a === 'number') return a + y * ((b as number) - a);
	return a.map((x, i) => x + y * ((b as number[])[i]! - x));
}

const isZero = (v: Vec2) => v[0] === 0 && v[1] === 0;
function isOpposite(a: Vec2, b: Vec2): boolean {
	const la = Math.hypot(a[0], a[1]);
	const lb = Math.hypot(b[0], b[1]);
	if (la === 0 || lb === 0) return false;
	return Math.abs(a[0] * b[1] - a[1] * b[0]) <= 1e-9 * la * lb && a[0] * b[0] + a[1] * b[1] < 0;
}

/** Spatial data for given tangents: linear when both are zero, continuous when opposite, else Bezier. */
export function spatialFor(inTangent: Vec2, outTangent: Vec2): Spatial {
	const mode: SpatialInterpolation =
		isZero(inTangent) && isZero(outTangent)
			? 'linear'
			: isOpposite(inTangent, outTangent)
				? 'continuous-bezier'
				: 'bezier';
	return { mode, inTangent: [inTangent[0], inTangent[1]], outTangent: [outTangent[0], outTangent[1]] };
}

/**
 * Rebuilds span a → b of `kfs` along a multi-point curve. Throws `MultiEaseError` (with a user-facing message) when
 * the values cannot be scaled (equal ends, non-numeric values) or the span is too short for the curve's points.
 */
export function applyMultiEase(input: MultiEaseInput): MultiEaseResult {
	const { kfs, a, b, curve } = input;
	const A = kfs[a]!;
	const B = kfs[b]!;
	const T = B.time - A.time;
	if (!(T > 0)) throw new MultiEaseError('the span has no duration');
	const vA = A.value;
	const vB = B.value;
	if (!isNumeric(vA) || !isNumeric(vB) || (Array.isArray(vA) && (vB as number[]).length !== vA.length))
		throw new MultiEaseError('its values cannot be scaled along a multi-point curve');
	const spatial = input.spatial && isVec2Value(vA) && isVec2Value(vB);
	const metric = spatial ? activeMetric(input.metric) : null;
	// Lengths in the evaluator's units: the keys in the metric's pixels (points mapped back with `toValue`).
	const toValue = (p: Pt): Vec2 => (metric ? fromMetric([p[0], p[1]], metric) : [p[0], p[1]]);
	const path = spatial ? spanPath(metric ? keysInMetric(kfs, metric) : kfs, a, b) : null;
	if (path ? !(path.total > 0) : JSON.stringify(vA) === JSON.stringify(vB))
		throw new MultiEaseError('its first and last values are equal, so the curve cannot be scaled to them');

	// Curve pieces, split where they cross a corner of the motion path.
	const pieces: Piece[] = [];
	let pathSplits = 0;
	for (const s of easeCurveSegments(curve) as EaseSegment[]) {
		let rest: Piece = [s[0], s[1], s[2], s[3]];
		const params = path
			? [...new Set([...extrema(rest), ...path.breaks.flatMap((lv) => crossings(rest, lv))])].sort(
					(x, y) => x - y,
				)
			: [];
		let done = 0;
		for (const t of params) {
			const local = (t - done) / (1 - done);
			if (!(local > SPLIT_EPS && local < 1 - SPLIT_EPS)) continue;
			const [left, right] = splitCubic(rest, local);
			pieces.push(left);
			rest = right;
			done = t;
			pathSplits++;
		}
		pieces.push(rest);
	}

	// Times and values of the new keys (interior points of the pieces).
	const xs = [0, ...pieces.map((p) => p[3][0])];
	const ys = [0, ...pieces.map((p) => p[3][1])];
	xs[xs.length - 1] = 1;
	ys[ys.length - 1] = 1;
	const times = xs.map((x, m) =>
		m === 0 ? A.time : m === xs.length - 1 ? B.time : A.time + Math.round(x * T),
	);
	for (let m = 1; m < times.length; m++)
		if (!(times[m]! > times[m - 1]!))
			throw new MultiEaseError('the span is too short for the curve’s points');
	const located = path ? ys.map((y) => locateOnPath(path, y)) : null;
	let clamped = false;
	const values: unknown[] = ys.map((y, m) => {
		if (m === 0) return vA;
		if (m === ys.length - 1) return vB;
		const raw = located ? toValue(located[m]!.point) : lerpValue(vA, vB as number | number[], y);
		const v = input.validate(raw);
		if (v.clamped) clamped = true;
		return v.value;
	});

	// Eases per piece (normalised to the piece).
	let flat = 0;
	const eases = pieces.map((p) => {
		const dx = p[3][0] - p[0][0];
		const dy = p[3][1] - p[0][1];
		if (Math.abs(dy) <= FLAT_EPS) {
			if (Math.abs(p[1][1] - p[0][1]) > 1e-9 || Math.abs(p[2][1] - p[0][1]) > 1e-9) flat++;
			return { out: { ...LINEAR_EASE }, in: { ...LINEAR_EASE } };
		}
		const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
		const e = cubicToEases({
			kind: 'cubic',
			x1: clamp01((p[1][0] - p[0][0]) / dx),
			y1: (p[1][1] - p[0][1]) / dy,
			x2: clamp01((p[2][0] - p[0][0]) / dx),
			y2: (p[2][1] - p[0][1]) / dy,
		});
		return { out: e.easeOut, in: e.easeIn };
	});

	// Spatial tangents per piece: the sub-curve of the original segment it lies on, or straight.
	const tangents: { out: Vec2; in: Vec2 }[] = pieces.map(() => ({ out: [0, 0], in: [0, 0] }));
	if (path && located) {
		pieces.forEach((_, m) => {
			const y0 = ys[m]!;
			const y1 = ys[m + 1]!;
			if (Math.abs(y1 - y0) <= FLAT_EPS) return;
			const mid = locateOnPath(path, (y0 + y1) / 2);
			const cell = path.cells[mid.cell];
			if (!cell?.seg) return; // straight cell or extension ray
			const at = (y: number, l: { cell: number; t: number }) =>
				l.cell === mid.cell ? l.t : y <= cell.f0 ? 0 : 1;
			const sc = subCubic(cell.seg, at(y0, located[m]!), at(y1, located[m + 1]!));
			const p0 = values[m] as Vec2;
			const p3 = values[m + 1] as Vec2;
			tangents[m] = { out: sub(toValue(sc[1]), p0), in: sub(toValue(sc[2]), p3) };
		});
	}

	// Effective eases / tangents of the span ends, measured before the inner keys go.
	const captured = captureEases(kfs, a, b, metric);
	const aTan = spatial ? effectiveTangents(kfs, a, metric) : null;
	const bTan = spatial ? effectiveTangents(kfs, b, metric) : null;
	const removed = kfs.slice(a + 1, b).map((k) => k.id);
	const created: string[] = [];
	const inner: Keys = [];
	for (let m = 1; m < times.length - 1; m++) {
		const id = input.newId();
		created.push(id);
		inner.push({
			id,
			time: times[m]!,
			value: values[m],
			interpolation: 'bezier',
			easeIn: { ...eases[m - 1]!.in },
			easeOut: { ...eases[m]!.out },
			...(spatial ? { spatial: spatialFor(tangents[m - 1]!.in, tangents[m]!.out) } : {}),
		});
	}
	const keys: Keys = [...kfs.slice(0, a + 1), ...inner, ...kfs.slice(b)];
	const ia = a;
	const ib = a + inner.length + 1;
	// Span ends: A's out ease = the first piece, B's in ease = the last piece (other sides kept).
	writeSpan(
		keys,
		ia,
		ia + 1,
		eases[0]!.out,
		inner.length ? eases[0]!.in : eases[eases.length - 1]!.in,
		captured,
		metric,
	);
	if (inner.length)
		writeSpan(
			keys,
			ib - 1,
			ib,
			eases[eases.length - 1]!.out,
			eases[eases.length - 1]!.in,
			{ ...captured, aIn: eases[eases.length - 2]!.in },
			metric,
		);
	if (spatial && aTan && bTan) {
		keys[ia]!.spatial = spatialFor(aTan.inTangent, tangents[0]!.out);
		keys[ib]!.spatial = spatialFor(tangents[tangents.length - 1]!.in, bTan.outTangent);
	}
	return { keys, created, removed, flat, clamped, pathSplits, eases };
}

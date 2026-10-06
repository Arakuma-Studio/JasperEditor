// Text on a path (workstream text-animators, AE Path Options): arc-length parameterisation of a Bezier path and
// character placement along it (Reverse Path, Perpendicular To Path, Force Alignment, First / Last Margin).
//
// Ported from EffectCraft `crates/text/src/path_text.rs` (MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and
// the EffectCraft contributors; see licenses/ported/text-animators.md). The path is flattened to a polyline with a
// 0.05 px tolerance (kurbo's `flatten` tolerance there) by adaptive subdivision of each cubic segment.
import type { TextPathGeometry } from '../schema/text-animators.ts';

type P = [number, number];

const dist = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function cubicAt(p0: P, p1: P, p2: P, p3: P, t: number): P {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const c = 3 * u * t * t;
	const d = t * t * t;
	return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/**
 * Number of line segments that keep a cubic within `tol` of its chords: the second-difference bound
 * `n = ceil(sqrt(sqrt(dd) · 3 / (4·tol)))` with `dd` the largest squared second difference of the control points.
 */
function cubicSegments(p0: P, p1: P, p2: P, p3: P, tol: number): number {
	const ddx = Math.max(Math.abs(p0[0] - 2 * p1[0] + p2[0]), Math.abs(p1[0] - 2 * p2[0] + p3[0]));
	const ddy = Math.max(Math.abs(p0[1] - 2 * p1[1] + p2[1]), Math.abs(p1[1] - 2 * p2[1] + p3[1]));
	const dd = Math.hypot(ddx, ddy);
	return Math.max(1, Math.min(4096, Math.ceil(Math.sqrt((dd * 3) / (4 * tol)))));
}

/** The flattened points of a path (closed paths end on their first point). */
export function flattenTextPath(path: TextPathGeometry, tol = 0.05): { pts: P[]; closed: boolean } {
	const v = path.vertices;
	const pts: P[] = [];
	if (v.length === 0) return { pts, closed: false };
	const push = (p: P) => {
		const last = pts[pts.length - 1];
		if (!last || dist(last, p) > 1e-9) pts.push(p);
	};
	push([v[0]!.point[0], v[0]!.point[1]]);
	const segs = path.closed ? v.length : v.length - 1;
	for (let i = 0; i < segs; i++) {
		const a = v[i]!;
		const b = v[(i + 1) % v.length]!;
		const p0: P = [a.point[0], a.point[1]];
		const p1: P = [a.point[0] + a.outTangent[0], a.point[1] + a.outTangent[1]];
		const p2: P = [b.point[0] + b.inTangent[0], b.point[1] + b.inTangent[1]];
		const p3: P = [b.point[0], b.point[1]];
		const straight =
			a.outTangent[0] === 0 && a.outTangent[1] === 0 && b.inTangent[0] === 0 && b.inTangent[1] === 0;
		const n = straight ? 1 : cubicSegments(p0, p1, p2, p3, tol);
		for (let k = 1; k <= n; k++) push(k === n ? p3 : cubicAt(p0, p1, p2, p3, k / n));
	}
	const closed = path.closed && v.length > 1;
	if (closed && pts.length > 1 && dist(pts[0]!, pts[pts.length - 1]!) > 1e-9) pts.push(pts[0]!);
	return { pts, closed };
}

/** A flattened path measured by arc length. */
export class PathMeasure {
	readonly pts: P[];
	/** Cumulative length at each point. */
	readonly cum: number[];
	readonly closed: boolean;

	constructor(path: TextPathGeometry, reverse: boolean) {
		const f = flattenTextPath(path);
		this.pts = reverse ? [...f.pts].reverse() : f.pts;
		this.closed = f.closed;
		this.cum = [];
		let acc = 0;
		this.pts.forEach((p, i) => {
			if (i > 0) acc += dist(this.pts[i - 1]!, p);
			this.cum.push(acc);
		});
	}

	get length(): number {
		return this.cum[this.cum.length - 1] ?? 0;
	}

	get isEmpty(): boolean {
		return this.pts.length < 2 || this.length <= 1e-9;
	}

	/** Point and unit tangent at arc length `s`. Closed paths wrap; open paths continue straight beyond either end. */
	at(s: number): { point: P; tangent: P } {
		if (this.isEmpty) return { point: this.pts[0] ?? [0, 0], tangent: [1, 0] };
		const len = this.length;
		const t = this.closed ? ((s % len) + len) % len : s;
		// Binary search like Rust `binary_search_by(total_cmp)`.
		let lo = 0;
		let hi = this.cum.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const c = this.cum[mid]!;
			if (c === t) {
				found = mid;
				break;
			}
			if (c < t) lo = mid + 1;
			else hi = mid - 1;
		}
		const n = this.pts.length;
		const k = found >= 0 ? Math.min(found, n - 2) : Math.min(Math.max(lo, 1), n - 1) - 1;
		const a = this.pts[k]!;
		const b = this.pts[k + 1]!;
		const seg = this.cum[k + 1]! - this.cum[k]!;
		const tan: P = seg > 0 ? [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg] : [1, 0];
		const d = t - this.cum[k]!;
		return { point: [a[0] + tan[0] * d, a[1] + tan[1] * d], tangent: tan };
	}
}

/** Where a character pivot lands on the path: the point and the tangent angle in degrees. */
export function placeOnPath(
	pm: PathMeasure,
	s: number,
	baselineOffset: number,
	perpendicular: boolean,
): { point: P; angle: number } {
	const { point, tangent: t } = pm.at(s);
	// y down: the normal pointing "below" the baseline is the tangent turned clockwise.
	const n: P = [-t[1], t[0]];
	const angle = perpendicular ? (Math.atan2(t[1], t[0]) * 180) / Math.PI : 0;
	const off: P = perpendicular ? [n[0] * baselineOffset, n[1] * baselineOffset] : [0, baselineOffset];
	return { point: [point[0] + off[0], point[1] + off[1]], angle };
}

/**
 * Arc-length positions for the character pivots of one line, given each pivot's x along the line, the line's
 * [x0, x1] extent and alignment (0 = left, 1 = centre, 2 = right).
 */
export function arcPositions(
	xs: readonly number[],
	line: readonly [number, number],
	align: 0 | 1 | 2,
	length: number,
	firstMargin: number,
	lastMargin: number,
	force: boolean,
): number[] {
	if (xs.length === 0) return [];
	if (force) {
		const a = firstMargin;
		const b = length - lastMargin;
		const x0 = xs[0]!;
		const x1 = xs[xs.length - 1]!;
		if (Math.abs(x1 - x0) < 1e-9) return xs.map(() => a);
		return xs.map((x) => a + ((b - a) * (x - x0)) / (x1 - x0));
	}
	if (align === 1) {
		const mid = (firstMargin + length - lastMargin) * 0.5;
		const c = (line[0] + line[1]) * 0.5;
		return xs.map((x) => mid + x - c);
	}
	if (align === 2) return xs.map((x) => length - lastMargin - (line[1] - x));
	return xs.map((x) => firstMargin + x - line[0]);
}

/** SVG path data of a text path (for overlays and previews). */
export function textPathSvg(path: TextPathGeometry): string {
	const v = path.vertices;
	if (v.length === 0) return '';
	const f = (n: number) => Number(n.toFixed(3));
	let d = `M${f(v[0]!.point[0])} ${f(v[0]!.point[1])}`;
	const segs = path.closed ? v.length : v.length - 1;
	for (let i = 0; i < segs; i++) {
		const a = v[i]!;
		const b = v[(i + 1) % v.length]!;
		d += ` C${f(a.point[0] + a.outTangent[0])} ${f(a.point[1] + a.outTangent[1])} ${f(b.point[0] + b.inTangent[0])} ${f(b.point[1] + b.inTangent[1])} ${f(b.point[0])} ${f(b.point[1])}`;
	}
	return path.closed ? `${d} Z` : d;
}

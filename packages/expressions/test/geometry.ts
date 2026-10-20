// Reference geometry for the path tests, independent of the vector kernel: cubic Béziers sampled densely, arc
// length by summed chords (error far below 0.001 px at these sizes), affine maps written out by hand.
export type Pt = [number, number];
export type Cub = [Pt, Pt, Pt, Pt];

export const line = (a: Pt, b: Pt): Cub => [a, a, b, b];

export function bez(c: Cub, t: number): Pt {
	const s = 1 - t;
	const a = s * s * s;
	const b = 3 * s * s * t;
	const d = 3 * s * t * t;
	const e = t * t * t;
	return [
		a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
		a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
	];
}

const N = 4000;

/** Point and unit tangent at fraction `u` (clamped) of the arc length of the segments laid end to end. */
export function measure(segs: readonly Cub[]): ((u: number) => { p: Pt; tan: Pt }) & { total: number } {
	// Separate subpaths (a segment not starting where the previous one ends) are joined by a zero-length step.
	const pts: Pt[] = [];
	const cum: number[] = [];
	segs.forEach((c) => {
		for (let i = 0; i <= N; i++) {
			const p = bez(c, i / N);
			const q = pts[pts.length - 1];
			pts.push(p);
			cum.push(q === undefined ? 0 : cum[cum.length - 1]! + (i === 0 ? 0 : Math.hypot(p[0] - q[0], p[1] - q[1])));
		}
	});
	const total = cum[cum.length - 1]!;
	const at = (u: number) => {
		const s = Math.min(1, Math.max(0, u)) * total;
		let lo = 1;
		let hi = cum.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cum[mid]! < s) lo = mid + 1;
			else hi = mid;
		}
		const a = pts[lo - 1]!;
		const b = pts[lo]!;
		const seg = cum[lo]! - cum[lo - 1]!;
		const f = seg > 0 ? (s - cum[lo - 1]!) / seg : 0;
		const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
		return {
			p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] as Pt,
			tan: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] as Pt,
		};
	};
	return Object.assign(at, { total });
}

export const along = (segs: readonly Cub[], u: number) => measure(segs)(u);

/** 2D affine as [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Aff = [number, number, number, number, number, number];
export const mulA = (m: Aff, n: Aff): Aff => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5],
];
export const applyA = (m: Aff, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const applyVec = (m: Aff, v: Pt): Pt => [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
export const T = (x: number, y: number): Aff => [1, 0, 0, 1, x, y];
export const S = (x: number, y: number): Aff => [x, 0, 0, y, 0, 0];
/** Clockwise on screen (y down) for positive degrees. */
export const R = (deg: number): Aff => {
	const r = (deg * Math.PI) / 180;
	return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
/** A shape group (or Motion) transform: translate(position) · rotate · scale · translate(−anchor). */
export const groupMatrix = (g: { position: Pt; rotation: number; scale: Pt; anchor: Pt }): Aff =>
	mulA(T(...g.position), mulA(R(g.rotation), mulA(S(g.scale[0] / 100, g.scale[1] / 100), T(-g.anchor[0], -g.anchor[1]))));
export const mapCub = (m: Aff, c: Cub): Cub => c.map((p) => applyA(m, p)) as Cub;
export const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

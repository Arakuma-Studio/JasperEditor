// Projective (3×3) layer math (M2, ARCHITECTURE §19.5, S09:TRK-050): corner pin and tracked screen
// replacement. `Mat3` is row-major: [x', y', w'] = M·[x, y, 1], x = x'/w', y = y'/w'. The same matrices drive
// the CSS `matrix3d` preview, the Program overlay handles and the engine's native warp stage.
import type { Vec2 } from '../schema/common.ts';
import type { Mat2D } from './transform.ts';

export type Mat3 = [number, number, number, number, number, number, number, number, number];
/** Corners in the order TL, TR, BR, BL (the S03 layer-quad order). */
export type Quad = [Vec2, Vec2, Vec2, Vec2];

export function mat3FromMat2D(m: Mat2D): Mat3 {
	return [m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1];
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
	const o = new Array(9).fill(0) as Mat3;
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			o[3 * r + c] = a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]!;
	return o;
}

export function invertMat3(m: Mat3): Mat3 | null {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (Math.abs(det) < 1e-12) return null;
	const k = 1 / det;
	return [
		A * k,
		-(b * i - c * h) * k,
		(b * f - c * e) * k,
		B * k,
		(a * i - c * g) * k,
		-(a * f - c * d) * k,
		C * k,
		-(a * h - b * g) * k,
		(a * e - b * d) * k,
	];
}

export function applyMat3(m: Mat3, p: Vec2): Vec2 {
	const w = m[6] * p[0] + m[7] * p[1] + m[8];
	return [(m[0] * p[0] + m[1] * p[1] + m[2]) / w, (m[3] * p[0] + m[4] * p[1] + m[5]) / w];
}

/** Homography mapping the unit square (0,0),(1,0),(1,1),(0,1) onto `q` (TL, TR, BR, BL). Null if degenerate. */
export function unitSquareToQuad(q: Quad): Mat3 | null {
	const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
	const dx1 = x1 - x2;
	const dx2 = x3 - x2;
	const dy1 = y1 - y2;
	const dy2 = y3 - y2;
	const sx = x0 - x1 + x2 - x3;
	const sy = y0 - y1 + y2 - y3;
	let g = 0;
	let h = 0;
	if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
		const den = dx1 * dy2 - dx2 * dy1;
		if (Math.abs(den) < 1e-12) return null;
		g = (sx * dy2 - dx2 * sy) / den;
		h = (dx1 * sy - sx * dy1) / den;
	}
	const m: Mat3 = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
	return invertMat3(m) ? m : null;
}

/** Homography mapping quad `from` onto quad `to` (both TL, TR, BR, BL). Null if either is degenerate. */
export function quadToQuad(from: Quad, to: Quad): Mat3 | null {
	const a = unitSquareToQuad(from);
	const b = unitSquareToQuad(to);
	if (!a || !b) return null;
	const ai = invertMat3(a);
	return ai ? multiplyMat3(b, ai) : null;
}

/** Homography mapping the rect `(0,0)-(w,h)` onto `q`. */
export function boxToQuad(w: number, h: number, q: Quad): Mat3 | null {
	return quadToQuad(
		[
			[0, 0],
			[w, 0],
			[w, h],
			[0, h],
		],
		q,
	);
}

/** A convex, non-self-intersecting quad (what a corner pin can realize without folding). */
export function isConvexQuad(q: Quad): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const [ax, ay] = q[i]!;
		const [bx, by] = q[(i + 1) % 4]!;
		const [cx, cy] = q[(i + 2) % 4]!;
		const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
		if (Math.abs(z) < 1e-9) return false;
		const s = Math.sign(z);
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return true;
}

/**
 * CSS `matrix3d(...)` realizing `m` for an element with `transform-origin: 0 0` (column-major 4×4 with the
 * projective row mapped to the w column).
 */
export function mat3ToCss(m: Mat3): string {
	const [a, b, c, d, e, f, g, h, i] = m;
	const v = [a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, i].map((x) => (Object.is(x, -0) ? 0 : x));
	return `matrix3d(${v.join(', ')})`;
}

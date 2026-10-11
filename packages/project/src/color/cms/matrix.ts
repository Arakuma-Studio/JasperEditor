// 3×3 colour matrices (workstream color-mgmt): row-major `[m00 m01 m02 m10 … m22]`, applied as `M · [r g b]ᵀ`.
// The normalised primary matrix follows SMPTE RP 177-1993 §3.3 (RGB → XYZ from the xy chromaticities of the
// primaries and the white point); chromatic adaptation is the linearised Bradford transform (Lam 1985, as used by
// ICC v4 and the ACES/OCIO configurations). Ported from FilmCraft `crates/color/src/spaces.rs` and EffectCraft
// `crates/color/src/space.rs` (MIT OR Apache-2.0, see licenses/ported/color-mgmt.md). Pure, f64.

export type ColorMatrix = readonly [number, number, number, number, number, number, number, number, number];
export type ColorVec = readonly [number, number, number];
/** CIE 1931 xy chromaticity. */
export type Xy = readonly [number, number];

export const IDENTITY3: ColorMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** `a · b` (b is applied first). */
export function mul3(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
	const o = new Array<number>(9);
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			o[3 * r + c] = a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]!;
	return o as unknown as ColorMatrix;
}

export function det3(m: ColorMatrix): number {
	const [a, b, c, d, e, f, g, h, i] = m;
	return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** Inverse; throws `RangeError` on a singular matrix (callers validate untrusted matrices with `det3` first). */
export function inv3(m: ColorMatrix): ColorMatrix {
	const [a, b, c, d, e, f, g, h, i] = m;
	const det = det3(m);
	if (!Number.isFinite(det) || Math.abs(det) < 1e-14) throw new RangeError('Singular colour matrix');
	const k = 1 / det;
	return [
		(e * i - f * h) * k,
		(c * h - b * i) * k,
		(b * f - c * e) * k,
		(f * g - d * i) * k,
		(a * i - c * g) * k,
		(c * d - a * f) * k,
		(d * h - e * g) * k,
		(b * g - a * h) * k,
		(a * e - b * d) * k,
	];
}

export function apply3(m: ColorMatrix, v: ColorVec): [number, number, number] {
	return [
		m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
		m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
		m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
	];
}

/** In place, allocation-free (hot paths: LUT bakes). */
export function apply3InPlace(m: ColorMatrix, c: [number, number, number]): void {
	const r = c[0];
	const g = c[1];
	const b = c[2];
	c[0] = m[0] * r + m[1] * g + m[2] * b;
	c[1] = m[3] * r + m[4] * g + m[5] * b;
	c[2] = m[6] * r + m[7] * g + m[8] * b;
}

export function isIdentity3(m: ColorMatrix, eps = 1e-12): boolean {
	for (let k = 0; k < 9; k++) if (Math.abs(m[k]! - IDENTITY3[k]!) > eps) return false;
	return true;
}

/** XYZ (Y = 1) of an xy chromaticity. */
export function xyToXyz([x, y]: Xy): ColorVec {
	return [x / y, 1, (1 - x - y) / y];
}

/** Normalised primary matrix (SMPTE RP 177): linear RGB → CIE XYZ with the white's Y = 1. */
export function npm(primaries: readonly [Xy, Xy, Xy], white: Xy): ColorMatrix {
	const [r, g, b] = primaries.map(xyToXyz) as [ColorVec, ColorVec, ColorVec];
	const p: ColorMatrix = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
	const s = apply3(inv3(p), xyToXyz(white));
	return [
		p[0] * s[0],
		p[1] * s[1],
		p[2] * s[2],
		p[3] * s[0],
		p[4] * s[1],
		p[5] * s[2],
		p[6] * s[0],
		p[7] * s[1],
		p[8] * s[2],
	];
}

/** The Bradford cone-response matrix (Lam 1985; ICC.1:2010 Annex E). */
export const BRADFORD: ColorMatrix = [
	0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296,
];

/** XYZ under white `src` → XYZ under white `dst` (linearised Bradford, von Kries scaling in the cone space). */
export function bradford(src: Xy, dst: Xy): ColorMatrix {
	if (src[0] === dst[0] && src[1] === dst[1]) return IDENTITY3;
	const s = apply3(BRADFORD, xyToXyz(src));
	const d = apply3(BRADFORD, xyToXyz(dst));
	const diag: ColorMatrix = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
	return mul3(inv3(BRADFORD), mul3(diag, BRADFORD));
}

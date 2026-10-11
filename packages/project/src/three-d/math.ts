// three-d: 3D vector / matrix math (ported from EffectCraft `crates/geom` Matrix4 and `render/three_d/camera.rs`,
// MIT OR Apache-2.0; licenses/ported/three-d.md). World space = sequence pixels, x right, y down, z away from the
// viewer. `Matrix4` is row-major on column vectors (x, y, z, 1): m[4·r + c].
import type { Mat3 } from '../render/homography.ts';
import type { Vec3 } from '../schema/common.ts';

export type { Vec3 };
export type Matrix4 = number[];

const RAD = Math.PI / 180;

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function norm3(a: Vec3): Vec3 {
	const l = len3(a);
	return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export const MAT4_IDENTITY: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mat4Mul(a: Matrix4, b: Matrix4): Matrix4 {
	const o = new Array<number>(16);
	for (let r = 0; r < 4; r++)
		for (let c = 0; c < 4; c++)
			o[4 * r + c] =
				a[4 * r]! * b[c]! +
				a[4 * r + 1]! * b[4 + c]! +
				a[4 * r + 2]! * b[8 + c]! +
				a[4 * r + 3]! * b[12 + c]!;
	return o;
}

/** Product of several matrices, left to right (`mat4MulAll(a, b, c)` = a·b·c). */
export function mat4MulAll(...ms: Matrix4[]): Matrix4 {
	let out = ms[0] ?? MAT4_IDENTITY;
	for (let i = 1; i < ms.length; i++) out = mat4Mul(out, ms[i]!);
	return out;
}

export function mat4Translate(t: Vec3): Matrix4 {
	return [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1];
}

export function mat4Scale(s: Vec3): Matrix4 {
	return [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
}

export function mat4RotateX(deg: number): Matrix4 {
	const s = Math.sin(deg * RAD);
	const c = Math.cos(deg * RAD);
	return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}

export function mat4RotateY(deg: number): Matrix4 {
	const s = Math.sin(deg * RAD);
	const c = Math.cos(deg * RAD);
	return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

/** Clockwise on screen for positive angles (y down), as the 2D Rotation. */
export function mat4RotateZ(deg: number): Matrix4 {
	const s = Math.sin(deg * RAD);
	const c = Math.cos(deg * RAD);
	return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Orientation (degrees): X, then Y, then Z applied to the vector (After Effects' order). */
export function mat4Orientation(o: Vec3): Matrix4 {
	return mat4MulAll(mat4RotateZ(o[2]), mat4RotateY(o[1]), mat4RotateX(o[0]));
}

/** The 3D layer transform (layer space → world): T(p) · O · Rz · Ry · Rx · S · T(−anchor). */
export function layerMatrix3D(v: {
	anchor: Vec3;
	position: Vec3;
	/** Fractions (1 = 100 %), flips as negative factors. */
	scale: Vec3;
	orientation: Vec3;
	rotation: Vec3;
}): Matrix4 {
	return mat4MulAll(
		mat4Translate(v.position),
		mat4Orientation(v.orientation),
		mat4RotateZ(v.rotation[2]),
		mat4RotateY(v.rotation[1]),
		mat4RotateX(v.rotation[0]),
		mat4Scale(v.scale),
		mat4Translate([-v.anchor[0], -v.anchor[1], -v.anchor[2]]),
	);
}

/** Applies a matrix to a point (with the perspective divide when w ≠ 1). */
export function mat4Apply(m: Matrix4, p: Vec3): Vec3 {
	const x = m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!;
	const y = m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!;
	const z = m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!;
	const w = m[12]! * p[0] + m[13]! * p[1] + m[14]! * p[2] + m[15]!;
	return w !== 1 && w !== 0 ? [x / w, y / w, z / w] : [x, y, z];
}

/** Applies the linear part of a matrix to a direction. */
export function mat4ApplyVec(m: Matrix4, v: Vec3): Vec3 {
	return [
		m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
		m[4]! * v[0] + m[5]! * v[1] + m[6]! * v[2],
		m[8]! * v[0] + m[9]! * v[1] + m[10]! * v[2],
	];
}

/** General inverse (Gauss-Jordan with partial pivoting); null when singular. */
export function mat4Invert(m: Matrix4): Matrix4 | null {
	const a = m.slice();
	const inv = MAT4_IDENTITY.slice();
	for (let col = 0; col < 4; col++) {
		let piv = col;
		for (let i = col + 1; i < 4; i++) if (Math.abs(a[4 * i + col]!) > Math.abs(a[4 * piv + col]!)) piv = i;
		if (!(Math.abs(a[4 * piv + col]!) > 1e-300)) return null;
		if (piv !== col)
			for (let j = 0; j < 4; j++) {
				[a[4 * col + j], a[4 * piv + j]] = [a[4 * piv + j]!, a[4 * col + j]!];
				[inv[4 * col + j], inv[4 * piv + j]] = [inv[4 * piv + j]!, inv[4 * col + j]!];
			}
		const d = a[4 * col + col]!;
		for (let j = 0; j < 4; j++) {
			a[4 * col + j] = a[4 * col + j]! / d;
			inv[4 * col + j] = inv[4 * col + j]! / d;
		}
		for (let i = 0; i < 4; i++) {
			if (i === col) continue;
			const f = a[4 * i + col]!;
			if (f === 0) continue;
			for (let j = 0; j < 4; j++) {
				a[4 * i + j] = a[4 * i + j]! - f * a[4 * col + j]!;
				inv[4 * i + j] = inv[4 * i + j]! - f * inv[4 * col + j]!;
			}
		}
	}
	return inv.every(Number.isFinite) ? inv : null;
}

/**
 * The projective 3×3 map of the z = 0 plane through a matrix that already includes the projection: (u, v) →
 * (x', y', w') = rows 0, 1 and 3 of `m` restricted to the x, y and translation columns.
 */
export function planeToMat3(m: Matrix4): Mat3 {
	return [m[0]!, m[1]!, m[3]!, m[4]!, m[5]!, m[7]!, m[12]!, m[13]!, m[15]!];
}

/** View matrix (world → camera: x right, y down, z forward) from an eye, a forward direction and a down hint. */
export function basisView(eye: Vec3, forward: Vec3, downHint: Vec3): Matrix4 {
	let f = norm3(forward);
	if (len3(f) === 0) f = [0, 0, 1];
	let d = sub3(downHint, scale3(f, dot3(downHint, f)));
	if (len3(d) < 1e-9) {
		d = Math.abs(f[1]) < 0.99 ? [0, 1, 0] : [0, 0, -1];
		d = sub3(d, scale3(f, dot3(d, f)));
	}
	d = norm3(d);
	const r = norm3(cross3(d, f));
	return mat4Mul(
		[r[0], r[1], r[2], 0, d[0], d[1], d[2], 0, f[0], f[1], f[2], 0, 0, 0, 0, 1],
		mat4Translate(scale3(eye, -1)),
	);
}

/** Rotation (local → parent) of a frame whose +z is `fwd` and whose +y is as close to `downHint` as possible. */
export function basisRotation(fwd: Vec3, downHint: Vec3): Matrix4 {
	const m = basisView([0, 0, 0], fwd, downHint);
	return [m[0]!, m[4]!, m[8]!, 0, m[1]!, m[5]!, m[9]!, 0, m[2]!, m[6]!, m[10]!, 0, 0, 0, 0, 1];
}

/** Orientation angles (degrees, X→Y order, Z = 0) that point +z along `dir`. */
export function orientationFor(dir: Vec3): Vec3 {
	const d = norm3(dir);
	const x = (Math.asin(Math.min(1, Math.max(-1, -d[1]))) * 180) / Math.PI;
	const y = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
	return [norm360(x), norm360(y), 0];
}

export function norm360(a: number): number {
	const r = ((a % 360) + 360) % 360;
	return Math.abs(r - 360) < 1e-9 ? 0 : r;
}

export type Quat = [number, number, number, number];

/** Rotation matrix → unit quaternion [w, x, y, z]. */
export function quatFromMat4(m: Matrix4): Quat {
	const [m00, m01, m02, , m10, m11, m12, , m20, m21, m22] = m as number[] as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const tr = m00 + m11 + m22;
	let q: Quat;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
	} else if (m00 > m11 && m00 > m22) {
		const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
		q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
	} else if (m11 > m22) {
		const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
		q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
	} else {
		const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
		q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
	}
	const l = Math.hypot(...q) || 1;
	return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function mat4FromQuat(q: Quat): Matrix4 {
	const [w, x, y, z] = q;
	return [
		1 - 2 * (y * y + z * z),
		2 * (x * y - w * z),
		2 * (x * z + w * y),
		0,
		2 * (x * y + w * z),
		1 - 2 * (x * x + z * z),
		2 * (y * z - w * x),
		0,
		2 * (x * z - w * y),
		2 * (y * z + w * x),
		1 - 2 * (x * x + y * y),
		0,
		0,
		0,
		0,
		1,
	];
}

/** Spherical interpolation along the shortest rotation. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
	let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
	let bb = b;
	if (d < 0) {
		d = -d;
		bb = [-b[0], -b[1], -b[2], -b[3]];
	}
	if (d > 0.9995) {
		const q: Quat = [
			a[0] + t * (bb[0] - a[0]),
			a[1] + t * (bb[1] - a[1]),
			a[2] + t * (bb[2] - a[2]),
			a[3] + t * (bb[3] - a[3]),
		];
		const l = Math.hypot(...q) || 1;
		return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
	}
	const th = Math.acos(Math.min(1, d));
	const s = Math.sin(th);
	const ka = Math.sin((1 - t) * th) / s;
	const kb = Math.sin(t * th) / s;
	return [ka * a[0] + kb * bb[0], ka * a[1] + kb * bb[1], ka * a[2] + kb * bb[2], ka * a[3] + kb * bb[3]];
}

/**
 * Euler angles (degrees, X→Y→Z as `mat4Orientation`) of a rotation matrix, each in [0, 360). Gimbal-locked matrices
 * (Y = ±90°) put the whole remaining turn in X.
 */
export function orientationOfMat4(m: Matrix4): Vec3 {
	// R = Rz·Ry·Rx: m20 = −sin y, m21 = cos y·sin x, m22 = cos y·cos x, m10 = cos y·sin z, m00 = cos y·cos z.
	const sy = Math.min(1, Math.max(-1, -m[8]!));
	const y = Math.asin(sy);
	let x: number;
	let z: number;
	if (Math.abs(Math.cos(y)) > 1e-9) {
		x = Math.atan2(m[9]!, m[10]!);
		z = Math.atan2(m[4]!, m[0]!);
	} else {
		z = 0;
		x = Math.atan2(-m[6]!, m[5]!);
	}
	return [norm360((x * 180) / Math.PI), norm360((y * 180) / Math.PI), norm360((z * 180) / Math.PI)];
}

/** Finite-number guard for values that reach matrices (NaN/∞ from hostile documents become `fallback`). */
export function finiteOr(v: unknown, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

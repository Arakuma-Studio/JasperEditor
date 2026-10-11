/** Row-major 3×3 matrix. */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

/** `a · b`, applying `b` first. */
export function multiplyMatrix3(a: Readonly<Matrix3>, b: Readonly<Matrix3>): Matrix3 {
	const out: Matrix3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			out[3 * r + c] = a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]!;
	return out;
}

// Lumetri ▸ Curves ▸ Hue Saturation Curves (color-grade): Hue vs Sat, Hue vs Hue, Hue vs Luma, Luma vs Sat and
// Sat vs Sat. Each is a `{curve: [x, y][]}` param like the RGB curves, but y = 0.5 is neutral (the curve is an
// offset from "no change"): flat at 0.5 by default (`[[0, 0.5], [1, 0.5]]`). Hue curves are periodic (x = 0 and
// x = 1 are the same hue, red); Luma vs Sat and Sat vs Sat are flat outside their first and last point.
//
// Interpolation is the same monotone cubic (PCHIP) as the tone curves; a periodic curve is evaluated on its points
// repeated one period to the left and right (FilmCraft `hue_lut`, MIT OR Apache-2.0, see
// licenses/ported/color-grade.md), so the curve is smooth across red. Curves are tabulated once (`OFFSET_TABLE`
// entries + linear interpolation) so a LUT bake does no spline evaluation per lattice point.
import { curveFn, MAX_CURVE_POINTS } from './curves.ts';

/** Table size of a tabulated offset curve (x step 1/1024). */
const OFFSET_TABLE = 1024;

/** The neutral (flat) value of a hue/saturation curve. */
export const HUE_CURVE_NEUTRAL = 0.5;

/** Default value of a hue/saturation curve param: flat at 0.5 (no change). */
export const NEUTRAL_HUE_CURVE: [number, number][] = [
	[0, HUE_CURVE_NEUTRAL],
	[1, HUE_CURVE_NEUTRAL],
];

const finitePoint = (p: unknown): p is [number, number] =>
	Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));

/** Finite points clamped to 0..1, sorted by x, one per x (last wins), at most 64. */
function cleanPoints(points: readonly (readonly number[])[] | null | undefined): [number, number][] {
	if (!Array.isArray(points)) return [];
	const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
	const pts = points
		.filter(finitePoint)
		.map((p) => [c01(Number(p[0])), c01(Number(p[1]))] as [number, number])
		.sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (last && Math.abs(last[0] - p[0]) < 1e-9) out[out.length - 1] = p;
		else out.push(p);
	}
	if (out.length > MAX_CURVE_POINTS) out.length = MAX_CURVE_POINTS;
	return out;
}

/** True when every point is at the neutral 0.5 (or there are none): the curve changes nothing. */
export function isNeutralHueCurve(points: readonly (readonly number[])[] | null | undefined): boolean {
	return cleanPoints(points).every((p) => Math.abs(p[1] - HUE_CURVE_NEUTRAL) < 1e-9);
}

/**
 * The curve's offset from neutral (`y − 0.5`, −0.5…0.5) as a function of x in 0..1 (clamped; periodic curves wrap),
 * or null when the curve is neutral. One point = a constant offset.
 */
export function offsetCurveFn(
	points: readonly (readonly number[])[] | null | undefined,
	periodic: boolean,
): ((x: number) => number) | null {
	let pts = cleanPoints(points);
	if (pts.length === 0 || pts.every((p) => Math.abs(p[1] - HUE_CURVE_NEUTRAL) < 1e-9)) return null;
	if (pts.length === 1) {
		const k = pts[0]![1] - HUE_CURVE_NEUTRAL;
		return () => k;
	}
	let f: (x: number) => number;
	if (periodic) {
		// x = 1 is the same hue as x = 0: a point at 1 stands for 0 unless 0 has its own point.
		if (pts[pts.length - 1]![0] >= 1 - 1e-9) {
			const last = pts.pop()!;
			if (!(pts[0] && pts[0][0] <= 1e-9)) pts = [[0, last[1]], ...pts];
		}
		if (pts.length === 1) {
			const k = pts[0]![1] - HUE_CURVE_NEUTRAL;
			return () => k;
		}
		// One period to each side, squeezed into 0..1 for the PCHIP (x' = (x + 1) / 3).
		const ext: [number, number][] = [];
		for (const off of [-1, 0, 1]) for (const p of pts) ext.push([(p[0] + off + 1) / 3, p[1]]);
		const g = curveFn(ext);
		f = g ? (x) => g((x + 1) / 3) : (x) => (x + 1) / 3;
	} else {
		const g = curveFn(pts);
		f = g ?? ((x) => x);
	}
	const table = new Float64Array(OFFSET_TABLE + 1);
	for (let i = 0; i <= OFFSET_TABLE; i++) table[i] = f(i / OFFSET_TABLE) - HUE_CURVE_NEUTRAL;
	return periodic
		? (x) => {
				let u = x - Math.floor(x);
				if (!(u >= 0)) u = 0;
				const p = u * OFFSET_TABLE;
				const i = p | 0;
				const t = p - i;
				return table[i]! + (table[i < OFFSET_TABLE ? i + 1 : i]! - table[i]!) * t;
			}
		: (x) => {
				const u = x > 0 ? (x < 1 ? x : 1) : 0;
				const p = u * OFFSET_TABLE;
				const i = p | 0;
				const t = p - i;
				return table[i]! + (table[i < OFFSET_TABLE ? i + 1 : i]! - table[i]!) * t;
			};
}

/** Samples an offset curve as y values (0..1, neutral 0.5) at `n` evenly spaced x (UI drawing, tests). */
export function sampleHueCurve(
	points: readonly (readonly number[])[] | null | undefined,
	periodic: boolean,
	n = 256,
): number[] {
	const f = offsetCurveFn(points, periodic);
	const out: number[] = [];
	for (let i = 0; i < n; i++) out.push(HUE_CURVE_NEUTRAL + (f ? f(i / (n - 1)) : 0));
	return out;
}

/**
 * The eyedropper of a hue curve (Premiere: click a colour in the Program monitor to add three points around its
 * hue): a control point at the picked hue keeps its current value, and two anchors `width` away on each side pin
 * the curve so dragging the centre affects only that hue range. Existing points closer than `width / 2` to the
 * new ones are replaced. Returns the new points and the index of the centre point.
 */
export function hueCurveEyedropper(
	points: readonly (readonly number[])[] | null | undefined,
	hue: number,
	width = 1 / 12,
): { points: [number, number][]; index: number } {
	const f = offsetCurveFn(points, true);
	const at = (x: number) => HUE_CURVE_NEUTRAL + (f ? f(x) : 0);
	const wrap = (x: number) => x - Math.floor(x);
	const h = wrap(hue);
	const add = [wrap(h - width), h, wrap(h + width)];
	const keep = cleanPoints(points).filter((p) => {
		// x = 1 duplicates x = 0 on a periodic curve.
		const x = p[0] >= 1 - 1e-9 ? 0 : p[0];
		return add.every((a) => {
			const d = Math.abs(a - x);
			return Math.min(d, 1 - d) >= width / 2;
		});
	});
	const merged = [...keep.map((p) => [p[0] >= 1 - 1e-9 ? 0 : p[0], p[1]] as [number, number])];
	for (const a of add) merged.push([a, at(a)]);
	merged.sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const p of merged) {
		const last = out[out.length - 1];
		if (last && Math.abs(last[0] - p[0]) < 1e-6) out[out.length - 1] = p;
		else out.push([Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]);
	}
	while (out.length > MAX_CURVE_POINTS) out.splice(out.length - 1, 1);
	// A curve param needs at least two points.
	if (out.length < 2) out.push([out[0]![0] < 0.5 ? 1 : 0, out[0]![1]]);
	out.sort((a, b) => a[0] - b[0]);
	const index = out.findIndex((p) => Math.abs(p[0] - Math.round(h * 1e4) / 1e4) < 1e-6);
	return { points: out, index };
}

/**
 * The eyedropper of Luma vs Sat / Sat vs Sat: a point at the picked input value (luma or saturation) on the curve,
 * with anchors `width` away; same rules as `hueCurveEyedropper` but not periodic (anchors are clamped to 0..1).
 */
export function linearCurveEyedropper(
	points: readonly (readonly number[])[] | null | undefined,
	x: number,
	width = 0.1,
): { points: [number, number][]; index: number } {
	const f = offsetCurveFn(points, false);
	const at = (v: number) => HUE_CURVE_NEUTRAL + (f ? f(v) : 0);
	const c = Math.min(1, Math.max(0, x));
	const add = [...new Set([Math.max(0, c - width), c, Math.min(1, c + width)])];
	const keep = cleanPoints(points).filter((p) => add.every((a) => Math.abs(a - p[0]) >= width / 2));
	const merged: [number, number][] = [...keep];
	for (const a of add) merged.push([a, at(a)]);
	merged.sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const p of merged) {
		const last = out[out.length - 1];
		if (last && Math.abs(last[0] - p[0]) < 1e-6) out[out.length - 1] = p;
		else out.push([Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]);
	}
	while (out.length > MAX_CURVE_POINTS) out.splice(out.length - 1, 1);
	if (out.length < 2) out.push([out[0]![0] < 0.5 ? 1 : 0, out[0]![1]]);
	out.sort((a, b) => a[0] - b[0]);
	const index = out.findIndex((p) => Math.abs(p[0] - Math.round(c * 1e4) / 1e4) < 1e-6);
	return { points: out, index };
}

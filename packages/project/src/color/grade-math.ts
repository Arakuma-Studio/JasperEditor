// Small colour helpers of the Lumetri completion (color-grade): HSL conversions, Rec.709 luma, the colour-wheel
// direction and Hermite smoothstep. Pure and allocation-free (outputs are written into caller-owned arrays) so
// they run inside LUT bakes. The GLSL twins live in `registry/lumetri-spatial.ts` (`GLSL_LUMETRI`).
import type { Rgb } from './lut.ts';

export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

export const luma709 = (r: number, g: number, b: number) => LUMA_R * r + LUMA_G * g + LUMA_B * b;

/** Hermite smoothstep with the usual clamp of `t`; `a > b` gives the falling edge. */
export function smoothstep(a: number, b: number, x: number): number {
	let t = (x - a) / (b - a);
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return t * t * (3 - 2 * t);
}

/**
 * RGB (0..1, clamped first) → HSL into `out`: hue 0..1 (0 = red, 1/3 = green, 2/3 = blue), saturation and
 * lightness 0..1. Greys have hue 0 and saturation 0.
 */
export function rgbToHsl(r: number, g: number, b: number, out: Rgb): Rgb {
	r = r < 0 ? 0 : r > 1 ? 1 : r;
	g = g < 0 ? 0 : g > 1 ? 1 : g;
	b = b < 0 ? 0 : b > 1 ? 1 : b;
	const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
	const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
	const l = (mx + mn) / 2;
	const d = mx - mn;
	if (d < 1e-12) {
		out[0] = 0;
		out[1] = 0;
		out[2] = l;
		return out;
	}
	const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
	let h: number;
	if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
	else if (mx === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	out[0] = h / 6;
	out[1] = s;
	out[2] = l;
	return out;
}

function hue2rgb(p: number, q: number, t: number): number {
	if (t < 0) t += 1;
	if (t > 1) t -= 1;
	if (t < 1 / 6) return p + (q - p) * 6 * t;
	if (t < 1 / 2) return q;
	if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
	return p;
}

/** HSL (hue wraps, saturation/lightness clamped to 0..1) → RGB into `out`. */
export function hslToRgb(h: number, s: number, l: number, out: Rgb): Rgb {
	h -= Math.floor(h);
	s = s < 0 ? 0 : s > 1 ? 1 : s;
	l = l < 0 ? 0 : l > 1 ? 1 : l;
	if (s === 0) {
		out[0] = l;
		out[1] = l;
		out[2] = l;
		return out;
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	out[0] = hue2rgb(p, q, h + 1 / 3);
	out[1] = hue2rgb(p, q, h);
	out[2] = hue2rgb(p, q, h - 1 / 3);
	return out;
}

/**
 * RGB direction of a colour wheel position (S06 §3.1 step 11): hue `θ = atan2(y, x)`, amount `m = min(1, |(x, y)|)`,
 * `d_k = m·cos(θ − φ_k)` with `φ = (0°, 120°, 240°)`. Written into `out`.
 */
export function wheelRgb(x: number, y: number, out: Rgb): Rgb {
	const m = Math.min(1, Math.hypot(x, y));
	if (!(m > 0)) {
		out[0] = 0;
		out[1] = 0;
		out[2] = 0;
		return out;
	}
	const th = Math.atan2(y, x);
	out[0] = m * Math.cos(th);
	out[1] = m * Math.cos(th - (2 * Math.PI) / 3);
	out[2] = m * Math.cos(th - (4 * Math.PI) / 3);
	return out;
}

/**
 * The wheel position whose direction points at a colour (inverse of `wheelRgb` for the chroma of `rgb`): used by
 * the eyedroppers and Colour Match to express a colour cast as a wheel. Length = the cast's strength (0..1).
 */
export function wheelOfRgb(r: number, g: number, b: number): [number, number] {
	const m = (r + g + b) / 3;
	const dr = r - m;
	const dg = g - m;
	const db = b - m;
	// Projection onto the wheel basis (cos 0°, cos 120°, cos 240°): x = Σ d_k cos φ_k · 2/3, y = Σ d_k sin φ_k · 2/3.
	const x = (2 / 3) * (dr - 0.5 * dg - 0.5 * db);
	const y = (2 / 3) * ((Math.sqrt(3) / 2) * dg - (Math.sqrt(3) / 2) * db);
	return [x, y];
}

// The spatial part of Lumetri Color (color-grade): Creative ▸ Sharpen, HSL Secondary (key on H/S/L with soft edges,
// Refine ▸ Denoise / Blur of the key, Invert, Show Mask, Correction inside the key) and Vignette. Unlike the other
// Lumetri steps they depend on neighbouring pixels or on the pixel position, so they cannot bake into the colour
// run's 3D LUT: the render snapshot gives a Lumetri instance that uses them a companion GPU stage
// (`jasper.lumetri-spatial`, registry/lumetri-spatial.ts) right after the instance's LUT step. This module holds the
// pure maths shared by that stage's uniforms and the CPU reference used by the tests: the settings read from the
// params, the key of a colour, the correction inside the key and the vignette factor.
//
// Formulas: the HSL key, the correction gains and the vignette shape follow EffectCraft's Lumetri (crates/effects/
// src/color3.rs `HslKey`, `lumetri`); Denoise is FilmCraft's median of the key mixed by the amount and Blur its
// Gaussian of up to 20 px (crates/render/src/effects.rs `hsl_secondary`). Both MIT OR Apache-2.0, recorded in
// licenses/ported/color-grade.md. The 3-way correction reuses Lumetri's own lift/gamma/gain wheel maths.
import type { EffectParams } from '../registry/effects.ts';
import { LUMA_B, LUMA_G, LUMA_R, rgbToHsl, smoothstep, wheelRgb } from './grade-math.ts';
import type { Rgb } from './lut.ts';

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const num = (p: EffectParams, k: string, d: number, lo: number, hi: number) => {
	const v = p[k];
	return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d;
};
const bool = (p: EffectParams, k: string, d: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);
const vec = (p: EffectParams, k: string): [number, number] => {
	const v = p[k];
	if (!Array.isArray(v) || v.length < 2) return [0, 0];
	const x = Number(v[0]);
	const y = Number(v[1]);
	return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
};
const zero2 = (v: readonly [number, number]) => v[0] === 0 && v[1] === 0;

/** Names of the Lumetri params the spatial stage reads (the companion instance carries exactly these). */
export const LUMETRI_SPATIAL_PARAMS: readonly string[] = [
	'creativeOn',
	'sharpen',
	'secondaryOn',
	'secHueOn',
	'secHueCenter',
	'secHueRange',
	'secHueSoft',
	'secSatOn',
	'secSatLow',
	'secSatHigh',
	'secSatSoft',
	'secLumaOn',
	'secLumaLow',
	'secLumaHigh',
	'secLumaSoft',
	'secShowMask',
	'secMaskStyle',
	'secInvert',
	'secDenoise',
	'secBlur',
	'secWheelMode',
	'secWheel',
	'secWheelLevel',
	'secShadowsWheel',
	'secShadowsLevel',
	'secMidtonesWheel',
	'secMidtonesLevel',
	'secHighlightsWheel',
	'secHighlightsLevel',
	'secTemperature',
	'secTint',
	'secContrast',
	'secSharpen',
	'secSaturation',
	'vignetteOn',
	'vignetteAmount',
	'vignetteMidpoint',
	'vignetteRoundness',
	'vignetteFeather',
];

/** HSL Secondary key of one axis: `on`, then centre/range/softness (hue, turns) or low/high/softness (0..1). */
export type KeyAxis = { on: boolean; a: number; b: number; soft: number };

export type LumetriSpatialSettings = {
	/** Creative ▸ Sharpen, −1..1 (negative softens). */
	sharpen: number;
	/** HSL Secondary does something (a correction or Show Mask). */
	secondary: boolean;
	/** 0 = off, 1 = Color/Gray, 2 = Color/Black, 3 = White/Black. */
	showMask: 0 | 1 | 2 | 3;
	invert: boolean;
	hue: KeyAxis;
	sat: KeyAxis;
	luma: KeyAxis;
	/** Refine, 0..1. */
	denoise: number;
	blur: number;
	/** Correction (inside the key). */
	temperature: number;
	tint: number;
	contrast: number;
	saturation: number;
	secSharpen: number;
	threeWay: boolean;
	/** 1-way: RGB offset. */
	offset: Rgb;
	/** 3-way: lift (added towards 1), gamma exponents, gain. */
	lift: Rgb;
	gamma: Rgb;
	gain: Rgb;
	/** Vignette: amount −5..5, midpoint / feather 0..1, roundness −1..1. */
	vignette: { amount: number; midpoint: number; roundness: number; feather: number };
};

function wheelVec(p: EffectParams, wheel: string, level: string): { d: Rgb; l: number; on: boolean } {
	const v = vec(p, wheel);
	const l = num(p, level, 0, -100, 100) / 100;
	return { d: wheelRgb(v[0], v[1], [0, 0, 0]), l, on: !zero2(v) || l !== 0 };
}

/** The spatial settings of a Lumetri instance's (evaluated) params; section switches applied. */
export function lumetriSpatialSettings(p: EffectParams): LumetriSpatialSettings {
	const creativeOn = bool(p, 'creativeOn', true);
	const secondaryOn = bool(p, 'secondaryOn', true);
	const vignetteOn = bool(p, 'vignetteOn', true);
	const style = p.secMaskStyle === 'colorBlack' ? 2 : p.secMaskStyle === 'whiteBlack' ? 3 : 1;
	const showMask = (secondaryOn && bool(p, 'secShowMask', false) ? style : 0) as 0 | 1 | 2 | 3;
	const threeWay = p.secWheelMode === 'three';
	const one = wheelVec(p, 'secWheel', 'secWheelLevel');
	const sh = wheelVec(p, 'secShadowsWheel', 'secShadowsLevel');
	const mid = wheelVec(p, 'secMidtonesWheel', 'secMidtonesLevel');
	const hi = wheelVec(p, 'secHighlightsWheel', 'secHighlightsLevel');
	const offset: Rgb = [0, 0, 0];
	const lift: Rgb = [0, 0, 0];
	const gamma: Rgb = [1, 1, 1];
	const gain: Rgb = [1, 1, 1];
	for (let k = 0; k < 3; k++) {
		offset[k] = 0.25 * one.d[k]! + 0.25 * one.l;
		// Lumetri's wheel maths (lumetri.ts step 11).
		lift[k] = 0.1 * sh.l + 0.1 * sh.d[k]!;
		gamma[k] = 1 / Math.max(0.05, 1 + 0.5 * mid.l + 0.25 * mid.d[k]!);
		gain[k] = 1 + 0.5 * hi.l + 0.25 * hi.d[k]!;
	}
	const temperature = num(p, 'secTemperature', 0, -100, 100) / 100;
	const tint = num(p, 'secTint', 0, -100, 100) / 100;
	const contrast = num(p, 'secContrast', 0, -100, 100) / 100;
	const saturation = num(p, 'secSaturation', 100, 0, 200) / 100;
	const secSharpen = num(p, 'secSharpen', 0, -100, 100) / 100;
	const wheelsOn = threeWay ? sh.on || mid.on || hi.on : one.on;
	const correction =
		temperature !== 0 || tint !== 0 || contrast !== 0 || saturation !== 1 || secSharpen !== 0 || wheelsOn;
	const axis = (on: string, a: string, b: string, soft: string, scale: number, defs: [number, number]) => ({
		on: bool(p, on, true),
		a: num(p, a, defs[0], 0, scale === 360 ? 360 : 100) / scale,
		b: num(p, b, defs[1], 0, scale === 360 ? 180 : 100) / scale,
		soft: num(p, soft, 0, 0, scale === 360 ? 180 : 100) / scale,
	});
	return {
		sharpen: creativeOn ? num(p, 'sharpen', 0, -100, 100) / 100 : 0,
		secondary: secondaryOn && (showMask !== 0 || correction),
		showMask,
		invert: bool(p, 'secInvert', false),
		hue: axis('secHueOn', 'secHueCenter', 'secHueRange', 'secHueSoft', 360, [0, 180]),
		sat: axis('secSatOn', 'secSatLow', 'secSatHigh', 'secSatSoft', 100, [0, 100]),
		luma: axis('secLumaOn', 'secLumaLow', 'secLumaHigh', 'secLumaSoft', 100, [0, 100]),
		denoise: num(p, 'secDenoise', 0, 0, 100) / 100,
		blur: num(p, 'secBlur', 0, 0, 100) / 100,
		temperature,
		tint,
		contrast,
		saturation,
		secSharpen,
		threeWay,
		offset,
		lift,
		gamma,
		gain,
		vignette: {
			amount: vignetteOn ? num(p, 'vignetteAmount', 0, -5, 5) : 0,
			midpoint: num(p, 'vignetteMidpoint', 50, 0, 100) / 100,
			roundness: num(p, 'vignetteRoundness', 0, -100, 100) / 100,
			feather: num(p, 'vignetteFeather', 50, 0, 100) / 100,
		},
	};
}

/** True when the settings change any pixel (the companion stage is needed). */
export function lumetriSpatialActive(s: LumetriSpatialSettings): boolean {
	return s.sharpen !== 0 || s.secondary || s.vignette.amount !== 0;
}

/** Soft band membership: 1 inside [lo, hi], falling linearly to 0 over `soft` outside it. */
function band(v: number, lo: number, hi: number, soft: number): number {
	const a = Math.min(lo, hi);
	const b = Math.max(lo, hi);
	const d = v < a ? a - v : v > b ? v - b : 0;
	if (d <= 0) return 1;
	return soft > 0 ? Math.max(0, 1 - d / soft) : 0;
}

const hslTmp: Rgb = [0, 0, 0];

/**
 * The HSL Secondary key (0..1) of a straight RGB colour (before Refine and Invert). Hue: circular distance to the
 * centre within the range (half-width) is 1, falling over the softness; greys belong to a hue key only as far as
 * they are saturated (×min(1, 20·S)). A hue range of 180° selects every hue.
 */
export function secondaryKey(s: LumetriSpatialSettings, r: number, g: number, b: number): number {
	const [h, sat, l] = rgbToHsl(r, g, b, hslTmp);
	let w = 1;
	if (s.hue.on && s.hue.b < 0.5 - 1e-9) {
		const dd = Math.abs(h - s.hue.a);
		const d = Math.min(dd - Math.floor(dd), 1 - (dd - Math.floor(dd)));
		const hw = d <= s.hue.b ? 1 : s.hue.soft > 0 ? Math.max(0, 1 - (d - s.hue.b) / s.hue.soft) : 0;
		w *= hw * Math.min(1, sat * 20);
	}
	if (s.sat.on) w *= band(sat, s.sat.a, s.sat.b, s.sat.soft);
	if (s.luma.on) w *= band(l, s.luma.a, s.luma.b, s.luma.soft);
	return w;
}

/** The correction of HSL Secondary applied to `c` (straight RGB) at full strength, in place. */
export function secondaryCorrect(s: LumetriSpatialSettings, c: Rgb): Rgb {
	if (s.temperature !== 0 || s.tint !== 0) {
		c[0] *= 1 + 0.25 * s.temperature;
		c[1] *= 1 - 0.25 * s.tint;
		c[2] *= 1 - 0.25 * s.temperature;
	}
	if (s.contrast !== 0) for (let k = 0; k < 3; k++) c[k] = 0.5 + (c[k]! - 0.5) * (1 + s.contrast);
	if (s.saturation !== 1) {
		const y = LUMA_R * c[0] + LUMA_G * c[1] + LUMA_B * c[2];
		for (let k = 0; k < 3; k++) c[k] = y + (c[k]! - y) * s.saturation;
	}
	if (s.threeWay) {
		for (let k = 0; k < 3; k++) {
			let v = c[k]! + s.lift[k]! * (1 - c[k]!);
			if (v > 0) v = v ** s.gamma[k]!;
			c[k] = v * s.gain[k]!;
		}
	} else for (let k = 0; k < 3; k++) c[k] = c[k]! + s.offset[k]!;
	return c;
}

/**
 * Vignette factor inputs at a layer-normalised position (0..1 over the clip frame): returns the edge weight `f` in
 * 0..1 (0 inside the midpoint, 1 at the corners for feather 0). Roundness 0 follows the frame's aspect, +1 a
 * circle, −1 a rounded rectangle; Feather widens the transition.
 */
export function vignetteWeight(
	v: LumetriSpatialSettings['vignette'],
	nxIn: number,
	nyIn: number,
	aspect: number,
): number {
	let nx = nxIn * 2 - 1;
	let ny = nyIn * 2 - 1;
	if (v.roundness > 0) {
		nx *= 1 + (Math.max(aspect, 1) - 1) * v.roundness;
		ny *= 1 + (Math.max(1 / aspect, 1) - 1) * v.roundness;
	}
	const pw = 2 + Math.max(0, -v.roundness) * 6;
	const r = (Math.abs(nx) ** pw + Math.abs(ny) ** pw) ** (1 / pw) / Math.SQRT2;
	const start = v.midpoint * 0.9;
	return smoothstep(start, start + 0.05 + v.feather * (1.05 - start), r);
}

/** Applies the vignette with edge weight `f` to `c` in place (negative amounts darken, positive lighten). */
export function applyVignette(amount: number, f: number, c: Rgb): Rgb {
	if (amount < 0) {
		const k = Math.max(0, 1 + amount * 0.2 * f);
		for (let i = 0; i < 3; i++) c[i] = c[i]! * k;
	} else if (amount > 0) {
		const k = Math.min(1, amount * 0.2 * f);
		for (let i = 0; i < 3; i++) c[i] = c[i]! + (1 - c[i]!) * k;
	}
	return c;
}

/**
 * CPU reference of the stage's last pass for one pixel (no Refine, no sharpen detail): straight RGB in, straight
 * RGB out (clamped 0..1), at layer-normalised position (nx, ny). Used by the GL tests and documentation examples.
 */
export function lumetriSpatialPixel(
	s: LumetriSpatialSettings,
	c: Rgb,
	nx: number,
	ny: number,
	aspect: number,
	keyOverride?: number,
): Rgb {
	let k = keyOverride ?? (s.secondary ? secondaryKey(s, c[0], c[1], c[2]) : 0);
	if (s.secondary && keyOverride === undefined && s.invert) k = 1 - k;
	if (s.secondary && s.showMask !== 0) {
		if (s.showMask === 1) {
			const g = clamp(LUMA_R * c[0] + LUMA_G * c[1] + LUMA_B * c[2], 0, 1) * 0.2 + 0.4;
			for (let i = 0; i < 3; i++) c[i] = g + (c[i]! - g) * k;
		} else if (s.showMask === 2) for (let i = 0; i < 3; i++) c[i] = c[i]! * k;
		else for (let i = 0; i < 3; i++) c[i] = k;
		for (let i = 0; i < 3; i++) c[i] = clamp(c[i]!, 0, 1);
		return c;
	}
	if (s.secondary && k > 0) {
		const d: Rgb = [c[0], c[1], c[2]];
		secondaryCorrect(s, d);
		for (let i = 0; i < 3; i++) c[i] = c[i]! + (d[i]! - c[i]!) * k;
	}
	if (s.vignette.amount !== 0)
		applyVignette(s.vignette.amount, vignetteWeight(s.vignette, nx, ny, aspect), c);
	for (let i = 0; i < 3; i++) c[i] = clamp(c[i]!, 0, 1);
	return c;
}

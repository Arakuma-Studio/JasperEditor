// Colour effects (M2, S06 §2–§3, ARCHITECTURE §19.2 / D-21): the `jasper.lumetri@1` spec and the colour ops of
// the M1 colour effects (Brightness & Contrast, Hue/Saturation, Black & White). Colour ops are pure RGB → RGB
// functions that consecutive colour effects fuse into ONE baked 3D LUT per run: the WebGL preview samples it and
// the native export applies it with `lut3d`, so the three renderers agree to the LUT's precision.
// This module imports only types from `effects.ts` (which imports the values from here), so there is no
// evaluation-order cycle.
import { lumetriFn } from '../color/lumetri.ts';
import type { ColorFn, ColorOp, EffectParams, EffectSpec, ParamSpec } from './effects.ts';

const num = (p: EffectParams, k: string, d = 0) =>
	typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- M1 colour effect maths (S03:FX-040)

/**
 * Brightness & Contrast (S03:FX-040). With `b, c ∈ [−100, 100]` every sRGB-encoded channel maps as
 * `out = k·(in − ½) + ½ + b/200` with `k = 1 + c/100`.
 */
export function brightnessContrastLinear(p: EffectParams): { slope: number; intercept: number } {
	const b = clamp(num(p, 'brightness'), -100, 100);
	const c = clamp(num(p, 'contrast'), -100, 100);
	const k = 1 + c / 100;
	return { slope: k, intercept: 0.5 - 0.5 * k + b / 200 };
}

/** Hue/Saturation: hue rotation in degrees and a saturation multiplier `1 + s/100` (0..2). */
export function hueSaturationValues(p: EffectParams): { hueDeg: number; saturation: number } {
	return {
		hueDeg: clamp(num(p, 'hue'), -180, 180),
		saturation: 1 + clamp(num(p, 'saturation'), -100, 100) / 100,
	};
}

/** Black & White: fraction of desaturation (0..1). */
export function blackWhiteAmount(p: EffectParams): number {
	return clamp(num(p, 'amount', 100), 0, 100) / 100;
}

/** Row-major 3×3 colour matrix. */
export type Mat3x3 = [number, number, number, number, number, number, number, number, number];

/**
 * The CSS / SVG `hueRotate` matrix (Filter Effects §feColorMatrix): a rotation of the chroma plane around the
 * luma axis with the 0.213/0.715/0.072 weights. This is exactly what the M1 preview (`hue-rotate()`) drew.
 */
export function hueRotateMatrix(deg: number): Mat3x3 {
	const a = (deg * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	return [
		0.213 + c * 0.787 - s * 0.213,
		0.715 - c * 0.715 - s * 0.715,
		0.072 - c * 0.072 + s * 0.928,
		0.213 - c * 0.213 + s * 0.143,
		0.715 + c * 0.285 + s * 0.14,
		0.072 - c * 0.072 - s * 0.283,
		0.213 - c * 0.213 - s * 0.787,
		0.715 - c * 0.715 + s * 0.715,
		0.072 + c * 0.928 + s * 0.072,
	];
}

/** The CSS / SVG `saturate` matrix (Filter Effects §feColorMatrix): scaling around luma. */
export function saturateMatrix(s: number): Mat3x3 {
	return [
		0.213 + 0.787 * s,
		0.715 - 0.715 * s,
		0.072 - 0.072 * s,
		0.213 - 0.213 * s,
		0.715 + 0.285 * s,
		0.072 - 0.072 * s,
		0.213 - 0.213 * s,
		0.715 - 0.715 * s,
		0.072 + 0.928 * s,
	];
}

/** `a · b` (apply `b` first, then `a`). */
export function mulMat3x3(a: Mat3x3, b: Mat3x3): Mat3x3 {
	const o = new Array<number>(9) as Mat3x3;
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			o[3 * r + c] = a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]!;
	return o;
}

const clampRgb: ColorFn = (c) => {
	c[0] = c[0] < 0 ? 0 : c[0] > 1 ? 1 : c[0];
	c[1] = c[1] < 0 ? 0 : c[1] > 1 ? 1 : c[1];
	c[2] = c[2] < 0 ? 0 : c[2] > 1 ? 1 : c[2];
};

function matrixFn(m: Mat3x3): ColorFn {
	const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m;
	return (c) => {
		const r = c[0];
		const g = c[1];
		const b = c[2];
		c[0] = m0 * r + m1 * g + m2 * b;
		c[1] = m3 * r + m4 * g + m5 * b;
		c[2] = m6 * r + m7 * g + m8 * b;
		clampRgb(c);
	};
}

/** Brightness & Contrast colour op: `out = k(in − ½) + ½ + b/200` per channel (S06:CG-023). */
export const BRIGHTNESS_CONTRAST_OP: ColorOp = {
	build(p) {
		const { slope, intercept } = brightnessContrastLinear(p);
		if (slope === 1 && intercept === 0) return null;
		return (c) => {
			c[0] = slope * c[0] + intercept;
			c[1] = slope * c[1] + intercept;
			c[2] = slope * c[2] + intercept;
			clampRgb(c);
		};
	},
};

/** Hue/Saturation colour op: `saturate(s) · hueRotate(θ)` exactly as the M1 CSS preview (S06:CG-023). */
export const HUE_SATURATION_OP: ColorOp = {
	build(p) {
		const { hueDeg, saturation } = hueSaturationValues(p);
		if (hueDeg === 0 && saturation === 1) return null;
		return matrixFn(mulMat3x3(saturateMatrix(saturation), hueRotateMatrix(hueDeg)));
	},
};

/** Black & White colour op: `lerp(v, Y(v), amount)` with Rec.709 luma (the CSS `grayscale()` matrix). */
export const BLACK_WHITE_OP: ColorOp = {
	build(p) {
		const a = blackWhiteAmount(p);
		if (a === 0) return null;
		return (c) => {
			const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
			c[0] += (y - c[0]) * a;
			c[1] += (y - c[1]) * a;
			c[2] += (y - c[2]) * a;
		};
	},
};

// ---------------------------------------------------------------- jasper.lumetri@1 (S06:CG-001/002)

export const LUMETRI_EFFECT_ID = 'jasper.lumetri';

const bipolar = (name: string, label: string, group: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({
	name,
	label,
	type: 'number',
	default: 0,
	range: { min: -100, max: 100, step: 0.1 },
	animatable: true,
	group,
	ui: { control: 'slider', bipolar: true },
	...extra,
});

const lutParam = (name: string, label: string, group: string): ParamSpec => ({
	name,
	label,
	type: 'media',
	// "None" is the empty id (ParamValue has no null); an unknown / offline id is skipped (S06:CG-004).
	default: { mediaId: '' },
	mediaKinds: ['lut'],
	animatable: false,
	group,
	ui: { control: 'media' },
});

const curveParam = (name: string, label: string): ParamSpec => ({
	name,
	label,
	type: 'curve',
	default: {
		curve: [
			[0, 0],
			[1, 1],
		],
	},
	animatable: false,
	group: 'curves',
	ui: { control: 'curve' },
});

const wheelParam = (name: string, label: string): ParamSpec => ({
	name,
	label,
	type: 'vec2',
	default: [0, 0],
	range: { min: -1, max: 1, step: 0.001 },
	animatable: true,
	group: 'wheels',
	ui: { control: 'wheel' },
});

/** Param names of the Lumetri effect, in editor order (S06:CG-002 is the contract). */
export const LUMETRI_PARAMS: readonly ParamSpec[] = [
	lutParam('inputLut', 'Input LUT', 'basic'),
	bipolar('temperature', 'Temperature', 'basic'),
	bipolar('tint', 'Tint', 'basic'),
	{
		name: 'exposure',
		label: 'Exposure',
		type: 'number',
		default: 0,
		range: { min: -5, max: 5, step: 0.01 },
		animatable: true,
		group: 'basic',
		ui: { control: 'slider', bipolar: true },
	},
	bipolar('contrast', 'Contrast', 'basic'),
	bipolar('highlights', 'Highlights', 'basic'),
	bipolar('shadows', 'Shadows', 'basic'),
	bipolar('whites', 'Whites', 'basic'),
	bipolar('blacks', 'Blacks', 'basic'),
	{
		name: 'saturation',
		label: 'Saturation',
		type: 'number',
		default: 100,
		range: { min: 0, max: 200, step: 0.1 },
		unit: '%',
		animatable: true,
		group: 'basic',
		ui: { control: 'slider' },
	},
	lutParam('look', 'Look', 'creative'),
	{
		name: 'lookIntensity',
		label: 'Intensity',
		type: 'number',
		default: 100,
		range: { min: 0, max: 100, step: 0.1 },
		unit: '%',
		animatable: true,
		group: 'creative',
		ui: { control: 'slider' },
	},
	bipolar('vibrance', 'Vibrance', 'creative'),
	curveParam('curveMaster', 'Master Curve'),
	curveParam('curveRed', 'Red Curve'),
	curveParam('curveGreen', 'Green Curve'),
	curveParam('curveBlue', 'Blue Curve'),
	wheelParam('shadowsWheel', 'Shadows'),
	wheelParam('midtonesWheel', 'Midtones'),
	wheelParam('highlightsWheel', 'Highlights'),
	bipolar('shadowsLevel', 'Shadows Level', 'wheels'),
	bipolar('midtonesLevel', 'Midtones Level', 'wheels'),
	bipolar('highlightsLevel', 'Highlights Level', 'wheels'),
];

/** Params the Lumetri editor draws itself (Effect Controls hides their generic rows, S06:CGU-002). */
export const LUMETRI_EDITOR_PARAMS: readonly string[] = [
	'curveMaster',
	'curveRed',
	'curveGreen',
	'curveBlue',
	'shadowsWheel',
	'midtonesWheel',
	'highlightsWheel',
];

export const LUMETRI_OP: ColorOp = { build: (p, ctx) => lumetriFn(p, ctx) };

export const LUMETRI_EFFECT: EffectSpec = {
	id: LUMETRI_EFFECT_ID,
	version: 1,
	label: 'Lumetri Color',
	category: 'Color Correction',
	appliesTo: 'video',
	description:
		'Colour grade: input LUT, white balance, exposure, contrast, highlights/shadows, whites/blacks, saturation, ' +
		'creative look LUT with intensity, vibrance, RGB curves and lift/gamma/gain wheels (one baked LUT, native export).',
	keywords: ['grade', 'color', 'colour', 'lut', 'curves', 'wheels', 'white balance', 'exposure', 'look'],
	params: [...LUMETRI_PARAMS],
	// The colour stage (WebGL LUT) realizes it; there is no CSS approximation.
	preview: {},
	native: null,
	color: LUMETRI_OP,
	capabilities: { preview: 'webgl', export: ['remotion', 'native'] },
};

/** Colour ops of the M1 colour effects, by effect id (S06:CG-003). */
export const M1_COLOR_OPS: Readonly<Record<string, ColorOp>> = {
	'jasper.brightness-contrast': BRIGHTNESS_CONTRAST_OP,
	'jasper.hue-saturation': HUE_SATURATION_OP,
	'jasper.black-white': BLACK_WHITE_OP,
};

/** The colour effects added by M2 (registered by default through `M2_EFFECTS`). */
export const COLOR_EFFECTS: readonly EffectSpec[] = [LUMETRI_EFFECT];

/** True when an effect spec is realized through a colour op (fused into a LUT run). */
export function isColorEffect(spec: Pick<EffectSpec, 'color'> | undefined | null): boolean {
	return !!spec?.color;
}

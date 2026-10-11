// Colour effects (M2, S06 §2–§3, ARCHITECTURE §19.2 / D-21): the `jasper.lumetri@1` spec and the colour ops of
// the M1 colour effects (Brightness & Contrast, Hue/Saturation, Black & White). Colour ops are pure RGB → RGB
// functions that consecutive colour effects fuse into ONE baked 3D LUT per run: the WebGL preview samples it and
// the native export applies it with `lut3d`, so the three renderers agree to the LUT's precision.
// This module imports only types from `effects.ts` (which imports the values from here), so there is no
// evaluation-order cycle.

import { gamutToXyzD65 } from '../color/cms/gamut.ts';
import { apply3InPlace, inv3 } from '../color/cms/matrix.ts';
import { colorSpace } from '../color/cms/spaces.ts';
import {
	DEFAULT_HDR_WHITE_NITS,
	defaultWorkingSettings,
	gradeSpace,
	inputTransformFn,
} from '../color/cms/transform.ts';
import { NEUTRAL_HUE_CURVE } from '../color/hue-curves.ts';
import { CREATIVE_LOOKS } from '../color/looks.ts';
import { lumetriFn } from '../color/lumetri.ts';
import { applyLut, type Rgb } from '../color/lut.ts';
import type { ColorFn, ColorOp, ColorOpContext, EffectParams, EffectSpec, ParamSpec } from './effects.ts';
import { clamp, mediaParamId } from './param-values.ts';

const num = (p: EffectParams, k: string, d = 0) =>
	typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d;

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
type Mat3x3 = [number, number, number, number, number, number, number, number, number];

/**
 * The CSS / SVG `hueRotate` matrix (Filter Effects §feColorMatrix): a rotation of the chroma plane around the
 * luma axis with the 0.213/0.715/0.072 weights. This is exactly what the M1 preview (`hue-rotate()`) drew.
 */
function hueRotateMatrix(deg: number): Mat3x3 {
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
function saturateMatrix(s: number): Mat3x3 {
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
function mulMat3x3(a: Mat3x3, b: Mat3x3): Mat3x3 {
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

export const LUMETRI_EFFECT_ID = 'jasper.lumetri';

const bipolar = (name: string, label: string, group: string): ParamSpec => ({
	name,
	label,
	type: 'number',
	default: 0,
	range: { min: -100, max: 100, step: 0.1 },
	animatable: true,
	group,
	ui: { control: 'slider', bipolar: true },
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

const wheelParam = (name: string, label: string, group = 'wheels'): ParamSpec => ({
	name,
	label,
	type: 'vec2',
	default: [0, 0],
	range: { min: -1, max: 1, step: 0.001 },
	animatable: true,
	group,
	ui: { control: 'wheel' },
});

const toggle = (name: string, label: string, group: string, def: boolean): ParamSpec => ({
	name,
	label,
	type: 'boolean',
	default: def,
	animatable: false,
	group,
	ui: { control: 'toggle' },
});
/** The checkbox in a Lumetri section header (on by default). */
const sectionToggle = (name: string, label: string, group: string): ParamSpec =>
	toggle(name, label, group, true);

const percentParam = (name: string, label: string, group: string): ParamSpec => ({
	name,
	label,
	type: 'number',
	default: 0,
	range: { min: 0, max: 100, step: 0.1 },
	animatable: true,
	group,
	ui: { control: 'slider' },
});

const saturationParam = (name: string, label: string, group: string): ParamSpec => ({
	name,
	label,
	type: 'number',
	default: 100,
	range: { min: 0, max: 200, step: 0.1 },
	unit: '%',
	animatable: true,
	group,
	ui: { control: 'slider' },
});

const rangeParam = (
	name: string,
	label: string,
	group: string,
	def: number,
	min: number,
	max: number,
	unit?: '%' | 'deg',
): ParamSpec => ({
	name,
	label,
	type: 'number',
	default: def,
	range: { min, max, step: 0.1 },
	...(unit ? { unit } : {}),
	animatable: true,
	group,
	ui: { control: unit === 'deg' && name === 'secHueCenter' ? 'angle' : 'slider' },
});

/** A hue/saturation curve (`hue-curves.ts`): y = 0.5 is neutral; flat by default. */
const hueCurveParam = (name: string, label: string): ParamSpec => ({
	name,
	label,
	type: 'curve',
	default: { curve: NEUTRAL_HUE_CURVE.map((p) => [...p]) },
	animatable: false,
	group: 'curves',
	ui: { control: 'curve' },
});

/** Param names of the Lumetri effect, in editor order (S06:CG-002 is the contract). */
export const LUMETRI_PARAMS: readonly ParamSpec[] = [
	lutParam('inputLut', 'Input LUT', 'basic'),
	// color-mgmt: HDR White (Basic Correction): in an HDR working space the sliders and curves span 0 … HDR White.
	{
		name: 'hdrWhite',
		label: 'HDR White',
		type: 'number',
		default: DEFAULT_HDR_WHITE_NITS,
		range: { min: 100, max: 10000, step: 1 },
		unit: 'nits',
		animatable: true,
		group: 'basic',
		ui: { control: 'slider', scale: 'log' },
	},
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
	// color-mgmt: HDR Specular: brightness of the highlights above HDR White (HDR working spaces).
	bipolar('hdrSpecular', 'HDR Specular', 'basic'),
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

	// Parameter order matches the Lumetri panel; LUMETRI_GROUPS defines its sections.
	sectionToggle('basicOn', 'Basic Correction', 'basic'),
	sectionToggle('creativeOn', 'Creative', 'creative'),
	{
		name: 'creativeLook',
		label: 'Built-in Look',
		type: 'enum',
		default: 'none',
		options: CREATIVE_LOOKS.map((l) => l.id),
		optionLabels: CREATIVE_LOOKS.map((l) => l.label),
		animatable: false,
		group: 'creative',
		ui: { control: 'select' },
	},
	percentParam('fadedFilm', 'Faded Film', 'creative'),
	bipolar('sharpen', 'Sharpen', 'creative'),
	saturationParam('creativeSaturation', 'Saturation', 'creative'),
	wheelParam('shadowTint', 'Shadow Tint', 'creative'),
	wheelParam('highlightTint', 'Highlight Tint', 'creative'),
	bipolar('tintBalance', 'Tint Balance', 'creative'),
	sectionToggle('curvesOn', 'Curves', 'curves'),
	hueCurveParam('hueVsSat', 'Hue vs Sat'),
	hueCurveParam('hueVsHue', 'Hue vs Hue'),
	hueCurveParam('hueVsLuma', 'Hue vs Luma'),
	hueCurveParam('lumaVsSat', 'Luma vs Sat'),
	hueCurveParam('satVsSat', 'Sat vs Sat'),
	sectionToggle('wheelsOn', 'Color Wheels & Match', 'wheels'),
	// HSL Secondary: Key (H, S, L ranges with soft edges), Refine (Denoise, Blur), Correction.
	sectionToggle('secondaryOn', 'HSL Secondary', 'secondary'),
	toggle('secHueOn', 'Hue Key', 'secondary', true),
	rangeParam('secHueCenter', 'Hue Center', 'secondary', 0, 0, 360, 'deg'),
	rangeParam('secHueRange', 'Hue Range', 'secondary', 180, 0, 180, 'deg'),
	rangeParam('secHueSoft', 'Hue Softness', 'secondary', 0, 0, 180, 'deg'),
	toggle('secSatOn', 'Saturation Key', 'secondary', true),
	rangeParam('secSatLow', 'Saturation Low', 'secondary', 0, 0, 100, '%'),
	rangeParam('secSatHigh', 'Saturation High', 'secondary', 100, 0, 100, '%'),
	rangeParam('secSatSoft', 'Saturation Softness', 'secondary', 0, 0, 100, '%'),
	toggle('secLumaOn', 'Lightness Key', 'secondary', true),
	rangeParam('secLumaLow', 'Lightness Low', 'secondary', 0, 0, 100, '%'),
	rangeParam('secLumaHigh', 'Lightness High', 'secondary', 100, 0, 100, '%'),
	rangeParam('secLumaSoft', 'Lightness Softness', 'secondary', 0, 0, 100, '%'),
	toggle('secShowMask', 'Show Mask', 'secondary', false),
	{
		name: 'secMaskStyle',
		label: 'Mask Style',
		type: 'enum',
		default: 'colorGray',
		options: ['colorGray', 'colorBlack', 'whiteBlack'],
		optionLabels: ['Color/Gray', 'Color/Black', 'White/Black'],
		animatable: false,
		group: 'secondary',
		ui: { control: 'select' },
	},
	toggle('secInvert', 'Invert Mask', 'secondary', false),
	percentParam('secDenoise', 'Denoise', 'secondary'),
	percentParam('secBlur', 'Blur', 'secondary'),
	{
		name: 'secWheelMode',
		label: 'Correction Wheels',
		type: 'enum',
		default: 'one',
		options: ['one', 'three'],
		optionLabels: ['1-way', '3-way'],
		animatable: false,
		group: 'secondary',
		ui: { control: 'select' },
	},
	wheelParam('secWheel', 'Correction', 'secondary'),
	bipolar('secWheelLevel', 'Correction Level', 'secondary'),
	wheelParam('secShadowsWheel', 'Shadows', 'secondary'),
	bipolar('secShadowsLevel', 'Shadows Level', 'secondary'),
	wheelParam('secMidtonesWheel', 'Midtones', 'secondary'),
	bipolar('secMidtonesLevel', 'Midtones Level', 'secondary'),
	wheelParam('secHighlightsWheel', 'Highlights', 'secondary'),
	bipolar('secHighlightsLevel', 'Highlights Level', 'secondary'),
	bipolar('secTemperature', 'Temperature', 'secondary'),
	bipolar('secTint', 'Tint', 'secondary'),
	bipolar('secContrast', 'Contrast', 'secondary'),
	bipolar('secSharpen', 'Sharpen', 'secondary'),
	saturationParam('secSaturation', 'Saturation', 'secondary'),
	// Vignette.
	sectionToggle('vignetteOn', 'Vignette', 'vignette'),
	{
		name: 'vignetteAmount',
		label: 'Amount',
		type: 'number',
		default: 0,
		range: { min: -5, max: 5, step: 0.01 },
		animatable: true,
		group: 'vignette',
		ui: { control: 'slider', bipolar: true },
	},
	rangeParam('vignetteMidpoint', 'Midpoint', 'vignette', 50, 0, 100),
	bipolar('vignetteRoundness', 'Roundness', 'vignette'),
	rangeParam('vignetteFeather', 'Feather', 'vignette', 50, 0, 100),
];

/** Sections of the Lumetri editor in Premiere's order (group id, title, section switch param). */
export const LUMETRI_GROUPS: readonly { group: string; title: string; toggle: string }[] = [
	{ group: 'basic', title: 'Basic Correction', toggle: 'basicOn' },
	{ group: 'creative', title: 'Creative', toggle: 'creativeOn' },
	{ group: 'curves', title: 'Curves', toggle: 'curvesOn' },
	{ group: 'wheels', title: 'Color Wheels & Match', toggle: 'wheelsOn' },
	{ group: 'secondary', title: 'HSL Secondary', toggle: 'secondaryOn' },
	{ group: 'vignette', title: 'Vignette', toggle: 'vignetteOn' },
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
	// color-grade
	'hueVsSat',
	'hueVsHue',
	'hueVsLuma',
	'lumaVsSat',
	'satVsSat',
	'shadowTint',
	'highlightTint',
	'secWheel',
	'secShadowsWheel',
	'secMidtonesWheel',
	'secHighlightsWheel',
];

export const LUMETRI_EFFECT: EffectSpec = {
	id: LUMETRI_EFFECT_ID,
	version: 1,
	label: 'Lumetri Color',
	category: 'Color Correction',
	appliesTo: 'video',
	description:
		'Colour grade: input LUT, white balance, exposure, contrast, highlights/shadows, whites/blacks, saturation, ' +
		'creative look (LUT or built-in) with intensity, faded film, sharpen, vibrance, saturation, shadow/highlight tint, ' +
		'RGB and hue/saturation curves, lift/gamma/gain wheels, HSL Secondary (key, refine, correction) and vignette. ' +
		'Pointwise steps bake into one LUT (native export); vignette, sharpen and HSL Secondary run as a GPU stage.',
	keywords: [
		'grade',
		'color',
		'colour',
		'lut',
		'curves',
		'wheels',
		'white balance',
		'exposure',
		'look',
		'vignette',
		'hsl secondary',
		'hue curves',
		'match',
	],
	params: [...LUMETRI_PARAMS],
	// The colour stage (WebGL LUT) realizes it; there is no CSS approximation.
	preview: {},
	native: null,
	color: { build: lumetriHdrFn },
	capabilities: { preview: 'webgl', export: ['remotion', 'native'] },
};

/**
 * color-mgmt: Lumetri in the working space. SDR working spaces grade the working signal directly (the M2 maths). In
 * an HDR working space (Rec. 2100 PQ / HLG) the maths run on the grading signal normalised to HDR White
 * (`gradeSpace`, FilmCraft grade.rs): 1 = HDR White, highlights above it (speculars) are graded like their colour at
 * HDR White (scaled into the unit range and back, so they keep their hue and ratio) and then scaled by HDR Specular
 * (1 + (q − 1)·(1 + specular/100)), instead of clipping.
 */
export function lumetriHdrFn(p: EffectParams, ctx: ColorOpContext): ColorFn | null {
	const base = lumetriFn(p, ctx);
	const w = ctx.working;
	if (!w) return base;
	const white =
		typeof p.hdrWhite === 'number' && Number.isFinite(p.hdrWhite) ? p.hdrWhite : DEFAULT_HDR_WHITE_NITS;
	const gs = gradeSpace(w.space, white);
	if (!gs) return base;
	const specular =
		typeof p.hdrSpecular === 'number' && Number.isFinite(p.hdrSpecular) ? p.hdrSpecular / 100 : 0;
	if (!base && Math.abs(specular) < 1e-9) return null;
	const k = Math.max(0, 1 + Math.max(-1, Math.min(1, specular)));
	return (c) => {
		gs.toGrade(c);
		const m = Math.max(1, c[0], c[1], c[2]);
		if (base) {
			if (m > 1) {
				c[0] /= m;
				c[1] /= m;
				c[2] /= m;
				base(c);
				c[0] *= m;
				c[1] *= m;
				c[2] *= m;
			} else base(c);
		}
		if (k !== 1) for (let i = 0; i < 3; i++) if (c[i]! > 1) c[i] = 1 + (c[i]! - 1) * k;
		gs.fromGrade(c);
	};
}

export const COLOR_INPUT_EFFECT_ID = 'jasper.color-input';

/**
 * The colour input transform of a source (render-only, added by the snapshot): source signal → the working space's
 * signal (Interpret Footage ▸ Colour, the clip override, or graphics in a non-Rec.709 working space). Fused with the
 * colour runs after it, so preview and native export bake it into the same LUT.
 */
export function colorInputFn(p: EffectParams, ctx: ColorOpContext): ColorFn | null {
	const working = ctx.working ?? {
		...defaultWorkingSettings('rec709'),
		linearize: false,
		blendLinear: false,
	};
	const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
	const mediaOf = (k: string) => mediaParamId(p[k]) || null;
	const range = str('range') === 'pc' ? 'pc' : 'tv';
	const tm = str('toneMap');
	const toneMap = tm === 'on' ? true : tm === 'off' ? false : undefined;
	const peak = typeof p.peakNits === 'number' && p.peakNits > 0 ? p.peakNits : null;
	const lutId = mediaOf('inputLut');
	const lut = lutId ? ctx.lut(lutId) : null;
	const ocioId = mediaOf('ocioConfig');
	let pre: ((c: Rgb) => void) | null = null;
	let space = str('space') || 'rec709';
	if (ocioId) {
		const cfg = ctx.colorConfig?.(ocioId) ?? null;
		if (!cfg) return null; // offline / unreadable: the planner blocks exports, the preview shows a chip
		try {
			const ic = cfg.interchange(str('ocioSpace'));
			if (ic.space === 'aces2065') {
				pre = ic.fn;
				space = 'aces2065';
			} else {
				// display-referred CIE XYZ (OCIO: 1 = 100 cd/m², SDR white) → BT.709 linear → BT.1886 Rec. 709
				const m = inv3(gamutToXyzD65('bt709'));
				pre = (c) => {
					ic.fn(c);
					apply3InPlace(m, c);
					for (let k = 0; k < 3; k++) c[k] = Math.max(0, c[k]!) ** (1 / 2.4);
				};
				space = 'rec709';
			}
		} catch {
			return null;
		}
	}
	if (!colorSpace(space)) return null;
	const xf = inputTransformFn(
		{ space, range, peakNits: peak, ...(toneMap !== undefined ? { toneMap } : {}) },
		working,
	);
	if (!lut && !pre && !xf) return null;
	return (c) => {
		if (lut) applyLut(lut, c);
		if (pre) pre(c);
		if (xf) xf(c);
	};
}

const strParam = (name: string, label: string, def = ''): ParamSpec => ({
	name,
	label,
	type: 'string',
	default: def,
	animatable: false,
});

export const COLOR_INPUT_EFFECT: EffectSpec = {
	id: COLOR_INPUT_EFFECT_ID,
	version: 1,
	label: 'Colour Input Transform',
	category: 'Color Correction',
	appliesTo: 'video',
	description: 'Source colour space → working space (added by colour management; not an effect you apply).',
	internal: true,
	params: [
		strParam('space', 'Source Space', 'rec709'),
		strParam('range', 'Range', 'tv'),
		strParam('toneMap', 'Tone Map', 'auto'),
		{ name: 'peakNits', label: 'Peak', type: 'number', default: 0, animatable: false },
		lutParam('inputLut', 'Input LUT', 'basic'),
		{ ...lutParam('ocioConfig', 'OCIO Config', 'basic'), mediaKinds: ['color-config'] },
		strParam('ocioSpace', 'OCIO Space'),
	],
	preview: {},
	native: null,
	color: { build: colorInputFn },
	capabilities: { preview: 'webgl', export: ['remotion', 'native'] },
};

/** The colour effects added by M2 (registered by default through `M2_EFFECTS`). */
export const COLOR_EFFECTS: readonly EffectSpec[] = [LUMETRI_EFFECT];

/** True when an effect spec is realized through a colour op (fused into a LUT run). */
export function isColorEffect(spec: Pick<EffectSpec, 'color'> | undefined | null): boolean {
	return !!spec?.color;
}

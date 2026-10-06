// Clip blend modes (keyframes-blend): metadata (labels, Premiere's menu groups, CSS keywords) and the reference
// compositing formulas shared by every renderer:
// - preview / Remotion: CSS `mix-blend-mode` where Chrome's implementation is exact for the formula (the W3C
//   Compositing and Blending Level 1 modes, measured bit-exact on opaque pixels), the GL compositor stage
//   (`packages/compositions/src/fx/composite.tsx`, GLSL `fx_layerBlend` in `registry/fx/glsl/blend.ts`) for the rest;
// - native export: the blend-composite kernel (`apps/engine/src/export/blend/`) runs `blendPixel` below.
// The formulas are ported from EffectCraft (crates/color/src/blend.rs `blend_pixel`, MIT OR Apache-2.0): separable
// modes per the W3C spec / PDF 1.7 (Photoshop's), non-separable Hue / Saturation / Color / Luminosity with the
// Lum = 0.3 R + 0.59 G + 0.11 B weights, Darker / Lighter Color and the luma stencils on Rec. 709 luminance, Hard Mix
// as the threshold of Cb + Cs, Dissolve as a per-pixel hash test against the layer's alpha. Compositing is the W3C
// model on premultiplied colour: co = (1 − αb)·cs + (1 − αs)·cb + αs·αb·B(Cb, Cs), αo = αs + αb − αs·αb.
// Layers composite onto a TRANSPARENT stack (the sequence background colour is drawn behind the result): a blend
// mode over nothing shows the layer as it is, as in Premiere Pro and After Effects.
import { hashString } from './registry/fx/shader.ts';
import { BLEND_MODES, type BlendMode } from './schema/sequence.ts';

export type BlendModeGroup =
	| 'normal'
	| 'subtractive'
	| 'additive'
	| 'complex'
	| 'difference'
	| 'hsl'
	| 'utility';

export type BlendModeInfo = {
	id: BlendMode;
	/** Menu label (Premiere Pro / After Effects wording). */
	label: string;
	group: BlendModeGroup;
	/**
	 * CSS `mix-blend-mode` keyword when Chrome's implementation equals the formula; null = the GL compositor. Measured
	 * in Chrome 150 (packages/compositions/test/blend-gl.test.ts): every W3C mode is bit-exact on opaque layers, but
	 * with layer opacity Color Burn, Color Dodge and Saturation drift up to 8 code values (Chrome unpremultiplies the
	 * 8-bit premultiplied layer before these steep formulas), so those three use the compositor too.
	 */
	css: string | null;
	description: string;
};

export const BLEND_MODE_GROUP_LABELS: Readonly<Record<BlendModeGroup, string>> = {
	normal: 'Normal',
	subtractive: 'Subtractive',
	additive: 'Additive',
	complex: 'Complex',
	difference: 'Difference',
	hsl: 'HSL',
	utility: 'Utility',
};

const info = (
	id: BlendMode,
	label: string,
	group: BlendModeGroup,
	css: string | null,
	description: string,
): BlendModeInfo => ({ id, label, group, css, description });

/** Every blend mode in menu order (= `BLEND_MODES` order; the index is the GLSL mode number). */
export const BLEND_MODE_INFO: readonly BlendModeInfo[] = [
	info('normal', 'Normal', 'normal', null, 'The layer covers what is below (alpha compositing).'),
	info(
		'dissolve',
		'Dissolve',
		'normal',
		null,
		'Each pixel is either the layer (fully opaque) or what is below, chosen at random with the layer opacity as probability (deterministic per clip and frame).',
	),
	info('darken', 'Darken', 'subtractive', 'darken', 'Per channel, the darker of the layer and the base.'),
	info(
		'multiply',
		'Multiply',
		'subtractive',
		'multiply',
		'Multiplies the colours: always darker; white is neutral.',
	),
	info(
		'color-burn',
		'Color Burn',
		'subtractive',
		null,
		'Darkens the base by increasing contrast; white is neutral.',
	),
	info('linear-burn', 'Linear Burn', 'subtractive', null, 'Base + layer − 1 per channel (clamped at 0).'),
	info(
		'darker-color',
		'Darker Color',
		'subtractive',
		null,
		'Whole pixel of the layer or the base, whichever has the lower luminance.',
	),
	info('lighten', 'Lighten', 'additive', 'lighten', 'Per channel, the lighter of the layer and the base.'),
	info('screen', 'Screen', 'additive', 'screen', 'Inverse multiply: always lighter; black is neutral.'),
	info(
		'color-dodge',
		'Color Dodge',
		'additive',
		null,
		'Brightens the base by decreasing contrast; black is neutral.',
	),
	info('add', 'Linear Dodge (Add)', 'additive', null, 'Adds the colours (light adds up); black is neutral.'),
	info(
		'lighter-color',
		'Lighter Color',
		'additive',
		null,
		'Whole pixel of the layer or the base, whichever has the higher luminance.',
	),
	info(
		'overlay',
		'Overlay',
		'complex',
		'overlay',
		'Multiply or Screen depending on the base; keeps highlights and shadows of the base.',
	),
	info(
		'soft-light',
		'Soft Light',
		'complex',
		'soft-light',
		'Darkens or lightens depending on the layer, softly.',
	),
	info('hard-light', 'Hard Light', 'complex', 'hard-light', 'Multiply or Screen depending on the layer.'),
	info('vivid-light', 'Vivid Light', 'complex', null, 'Color Burn or Color Dodge depending on the layer.'),
	info(
		'linear-light',
		'Linear Light',
		'complex',
		null,
		'Linear Burn or Linear Dodge depending on the layer.',
	),
	info('pin-light', 'Pin Light', 'complex', null, 'Darken or Lighten depending on the layer.'),
	info('hard-mix', 'Hard Mix', 'complex', null, 'Each channel becomes 0 or 1: 1 where base + layer ≥ 1.'),
	info('difference', 'Difference', 'difference', 'difference', 'Absolute difference of the colours.'),
	info('exclusion', 'Exclusion', 'difference', 'exclusion', 'Like Difference with lower contrast.'),
	info('subtract', 'Subtract', 'difference', null, 'Base − layer per channel (clamped at 0).'),
	info('divide', 'Divide', 'difference', null, 'Base ÷ layer per channel.'),
	info('hue', 'Hue', 'hsl', 'hue', 'Hue of the layer with the saturation and luminosity of the base.'),
	info(
		'saturation',
		'Saturation',
		'hsl',
		null,
		'Saturation of the layer with the hue and luminosity of the base.',
	),
	info('color', 'Color', 'hsl', 'color', 'Hue and saturation of the layer with the luminosity of the base.'),
	info(
		'luminosity',
		'Luminosity',
		'hsl',
		'luminosity',
		'Luminosity of the layer with the hue and saturation of the base.',
	),
	info(
		'stencil-alpha',
		'Stencil Alpha',
		'utility',
		null,
		'Everything below shows only where the layer is opaque (the layer itself is not drawn).',
	),
	info(
		'stencil-luma',
		'Stencil Luma',
		'utility',
		null,
		'Everything below shows only where the layer is bright (the layer itself is not drawn).',
	),
	info(
		'silhouette-alpha',
		'Silhouette Alpha',
		'utility',
		null,
		'Cuts a hole in everything below where the layer is opaque (the layer itself is not drawn).',
	),
	info(
		'silhouette-luma',
		'Silhouette Luma',
		'utility',
		null,
		'Cuts a hole in everything below where the layer is bright (the layer itself is not drawn).',
	),
	info(
		'alpha-add',
		'Alpha Add',
		'utility',
		null,
		'Normal colour with added alphas (αs + αb, clamped), so complementary edges join without a seam.',
	),
];

const BY_ID = new Map(BLEND_MODE_INFO.map((m) => [m.id, m]));

export function blendModeInfo(mode: string): BlendModeInfo | undefined {
	return BY_ID.get(mode as BlendMode);
}

/** Menu labels in `BLEND_MODES` order. */
export const BLEND_MODE_LABELS: readonly string[] = BLEND_MODES.map((m) => BY_ID.get(m)!.label);
/** Menu group label of each mode in `BLEND_MODES` order (consecutive runs = the menu's sections). */
export const BLEND_MODE_GROUPS: readonly string[] = BLEND_MODES.map(
	(m) => BLEND_MODE_GROUP_LABELS[BY_ID.get(m)!.group],
);

/** GLSL mode number of a blend mode (its index in `BLEND_MODES`). */
export function blendModeIndex(mode: string): number {
	const i = (BLEND_MODES as readonly string[]).indexOf(mode);
	return i < 0 ? 0 : i;
}

/**
 * Resolves a blend mode name an agent or a preset wrote: the id (`linear-burn`), the label (`Linear Burn`,
 * `Linear Dodge (Add)`), a camel/snake/space variant (`linearBurn`, `linear_burn`), or `linear-dodge`.
 */
export function parseBlendMode(name: string): BlendMode | null {
	const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
	const k = key(name);
	if (k === 'lineardodge' || k === 'lineardodgeadd') return 'add';
	for (const m of BLEND_MODE_INFO) if (key(m.id) === k || key(m.label) === k) return m.id;
	return null;
}

/** Modes that act on the stack below instead of compositing the layer onto it (After Effects' utility modes). */
export function isStencilBlend(mode: string): boolean {
	return (
		mode === 'stencil-alpha' ||
		mode === 'stencil-luma' ||
		mode === 'silhouette-alpha' ||
		mode === 'silhouette-luma'
	);
}

/** True when a mode draws through CSS `mix-blend-mode` exactly (normal included: plain compositing). */
export function isCssBlend(mode: string): boolean {
	return mode === 'normal' || !!BY_ID.get(mode as BlendMode)?.css;
}

// ---------------------------------------------------------------- formulas (premultiplied RGBA, 0..1)

/** Modes whose inputs are not clamped to 0..1 (defined for over-range values). */
const HDR = new Set<string>([
	'normal',
	'dissolve',
	'darken',
	'multiply',
	'linear-burn',
	'darker-color',
	'lighten',
	'screen',
	'add',
	'lighter-color',
	'difference',
	'subtract',
	'divide',
	'stencil-alpha',
	'stencil-luma',
	'silhouette-alpha',
	'silhouette-luma',
	'alpha-add',
]);

/** Rec. 709 luminance (Darker / Lighter Color, the luma stencils). */
export function luminance709(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Hard Mix threshold: 1 minus a quarter code value, so sums of 8-bit values that are exactly 1 count as 1 on the GPU. */
export const HARD_MIX_THRESHOLD = 1 - 0.25 / 255;

/** Luminance difference below which Darker / Lighter Color keep the base (float rounding of unpremultiplied colour). */
const LUMA_TIE = 1e-5;

const burn = (cb: number, cs: number) => (cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min((1 - cb) / cs, 1));
const dodge = (cb: number, cs: number) => (cb <= 0 ? 0 : cs >= 1 ? 1 : Math.min(cb / (1 - cs), 1));
const hardLight = (cb: number, cs: number) => {
	if (cs <= 0.5) return cb * 2 * cs;
	const s = 2 * cs - 1;
	return cb + s - cb * s;
};
const softLight = (cb: number, cs: number) => {
	if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
	const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(Math.max(cb, 0));
	return cb + (2 * cs - 1) * (d - cb);
};

/** B(Cb, Cs) of a separable mode on one straight channel. */
export function blendChannel(mode: string, cb: number, cs: number): number {
	switch (mode) {
		case 'darken':
			return Math.min(cb, cs);
		case 'multiply':
			return cb * cs;
		case 'color-burn':
			return burn(cb, cs);
		case 'linear-burn':
			return Math.max(cb + cs - 1, 0);
		case 'lighten':
			return Math.max(cb, cs);
		case 'screen':
			return cb + cs - cb * cs;
		case 'color-dodge':
			return dodge(cb, cs);
		case 'add':
			return cb + cs;
		case 'overlay':
			return hardLight(cs, cb);
		case 'soft-light':
			return softLight(cb, cs);
		case 'hard-light':
			return hardLight(cb, cs);
		case 'vivid-light':
			return cs <= 0.5 ? burn(cb, 2 * cs) : dodge(cb, 2 * (cs - 0.5));
		case 'linear-light':
			return Math.min(1, Math.max(0, cb + 2 * cs - 1));
		case 'pin-light':
			return cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1);
		case 'hard-mix':
			// cb + cs ≥ 1, with ties on the 8-bit grid (k/255 + (255 − k)/255) resolved to 1 whatever the float rounding.
			return cb + cs >= HARD_MIX_THRESHOLD ? 1 : 0;
		case 'difference':
			return Math.abs(cb - cs);
		case 'exclusion':
			return cb + cs - 2 * cb * cs;
		case 'subtract':
			return Math.max(cb - cs, 0);
		case 'divide':
			return cs <= 0 ? (cb > 0 ? 1 : 0) : cb / cs;
		default:
			return cs;
	}
}

type Rgb = [number, number, number];
const lum = (c: Rgb) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c: Rgb): Rgb {
	const l = lum(c);
	const n = Math.min(c[0], c[1], c[2]);
	const x = Math.max(c[0], c[1], c[2]);
	let o: Rgb = [c[0], c[1], c[2]];
	if (n < 0) {
		const k = l / Math.max(l - n, 1e-9);
		o = [l + (o[0] - l) * k, l + (o[1] - l) * k, l + (o[2] - l) * k];
	}
	if (x > 1) {
		const k = (1 - l) / Math.max(x - l, 1e-9);
		o = [l + (o[0] - l) * k, l + (o[1] - l) * k, l + (o[2] - l) * k];
	}
	return o;
}
const setLum = (c: Rgb, l: number): Rgb => {
	const d = l - lum(c);
	return clipColor([c[0] + d, c[1] + d, c[2] + d]);
};
const sat = (c: Rgb) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: Rgb, s: number): Rgb {
	const mx = Math.max(c[0], c[1], c[2]);
	const mn = Math.min(c[0], c[1], c[2]);
	if (mx - mn <= 1e-9) return [0, 0, 0];
	const k = s / (mx - mn);
	return [(c[0] - mn) * k, (c[1] - mn) * k, (c[2] - mn) * k];
}

/** B(Cb, Cs) on straight RGB (non-separable modes, Darker / Lighter Color, else per channel). */
export function blendRgb(mode: string, cb: Rgb, cs: Rgb): Rgb {
	switch (mode) {
		case 'hue':
			return setLum(setSat(cs, sat(cb)), lum(cb));
		case 'saturation':
			return setLum(setSat(cb, sat(cs)), lum(cb));
		case 'color':
			return setLum(cs, lum(cb));
		case 'luminosity':
			return setLum(cb, lum(cs));
		// Ties (equal luminance within float rounding) keep the base, on the GPU as here.
		case 'darker-color':
			return luminance709(cs[0], cs[1], cs[2]) < luminance709(cb[0], cb[1], cb[2]) - LUMA_TIE ? cs : cb;
		case 'lighter-color':
			return luminance709(cs[0], cs[1], cs[2]) > luminance709(cb[0], cb[1], cb[2]) + LUMA_TIE ? cs : cb;
		default:
			return [
				blendChannel(mode, cb[0], cs[0]),
				blendChannel(mode, cb[1], cs[1]),
				blendChannel(mode, cb[2], cs[2]),
			];
	}
}

export type Rgba = [number, number, number, number];

/**
 * Composites a premultiplied source pixel (layer opacity included) onto a premultiplied destination pixel (the stack
 * below). `noise` (0..1, `dissolveNoise`) is Dissolve's per-pixel random value. Stencil / Silhouette modes return
 * the destination masked by the source.
 */
export function blendPixel(mode: string, dst: Rgba, src: Rgba, noise: number): Rgba {
	const sa = src[3];
	const da = dst[3];
	switch (mode) {
		case 'dissolve': {
			if (sa <= 0 || noise >= sa) return [dst[0], dst[1], dst[2], dst[3]];
			const inv = 1 / sa;
			return [src[0] * inv, src[1] * inv, src[2] * inv, 1];
		}
		case 'stencil-alpha':
			return [dst[0] * sa, dst[1] * sa, dst[2] * sa, dst[3] * sa];
		case 'silhouette-alpha': {
			const k = 1 - sa;
			return [dst[0] * k, dst[1] * k, dst[2] * k, dst[3] * k];
		}
		case 'stencil-luma':
		case 'silhouette-luma': {
			const l = luminance709(src[0], src[1], src[2]);
			const k = mode === 'stencil-luma' ? l : 1 - l;
			return [dst[0] * k, dst[1] * k, dst[2] * k, dst[3] * k];
		}
		case 'alpha-add': {
			const k = 1 - sa;
			return [src[0] + dst[0] * k, src[1] + dst[1] * k, src[2] + dst[2] * k, Math.min(sa + da, 1)];
		}
		case 'normal': {
			const k = 1 - sa;
			return [src[0] + dst[0] * k, src[1] + dst[1] * k, src[2] + dst[2] * k, sa + da * k];
		}
	}
	if (sa <= 0) return [dst[0], dst[1], dst[2], dst[3]];
	if (da <= 0) return [src[0], src[1], src[2], src[3]];
	let cs: Rgb = [src[0] / sa, src[1] / sa, src[2] / sa];
	let cb: Rgb = [dst[0] / da, dst[1] / da, dst[2] / da];
	if (!HDR.has(mode)) {
		const c = (v: number) => Math.min(1, Math.max(0, v));
		cs = [c(cs[0]), c(cs[1]), c(cs[2])];
		cb = [c(cb[0]), c(cb[1]), c(cb[2])];
	}
	const b = blendRgb(mode, cb, cs);
	const k = sa * da;
	return [
		(1 - da) * src[0] + (1 - sa) * dst[0] + k * b[0],
		(1 - da) * src[1] + (1 - sa) * dst[1] + k * b[1],
		(1 - da) * src[2] + (1 - sa) * dst[2] + k * b[2],
		sa + da - k,
	];
}

/**
 * A composited pixel as stored between layers: alpha in 0..1 and colour in 0..alpha (a valid premultiplied colour).
 * Both compositors (GL, native kernel) clamp after every layer, like an 8-bit render pipeline.
 */
export function clampPremul(p: Rgba): Rgba {
	const a = Math.min(1, Math.max(0, p[3]));
	const c = (v: number) => Math.min(a, Math.max(0, v));
	return [c(p[0]), c(p[1]), c(p[2]), a];
}

/**
 * `clampPremul`, then each channel rounded to the 8-bit grid: the accumulated stack between layers, as the GL
 * compositor stores it (an RGBA8 premultiplied target) and the native kernel reproduces it, so a blend's inputs are
 * the same numbers on both paths (thresholds and luminance comparisons decide alike).
 */
export function storePremul8(p: Rgba): Rgba {
	const c = clampPremul(p);
	return [
		Math.round(c[0] * 255) / 255,
		Math.round(c[1] * 255) / 255,
		Math.round(c[2] * 255) / 255,
		Math.round(c[3] * 255) / 255,
	];
}

// ---------------------------------------------------------------- Dissolve noise (deterministic)

/**
 * Dissolve's per-pixel random value in [0, 1) at integer pixel (x, y) of the sequence frame (EffectCraft
 * `raster::hash_noise`, the same integer hash in GLSL `fx_blendNoise`). 24 bits, so the GPU's float holds it exactly.
 */
export function dissolveNoise(x: number, y: number, seed: number): number {
	let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(seed, 0xcb1ab31f)) >>> 0;
	h = (h ^ (h >>> 13)) >>> 0;
	h = Math.imul(h, 0x5bd1e995) >>> 0;
	h = (h ^ (h >>> 15)) >>> 0;
	return (h & 0xffffff) / 16777216;
}

/** Dissolve seed of a layer (clip id, or `transition:<id>` for a transition span) at a clip-local frame: 31 bits. */
export function dissolveSeed(key: string, localFrame: number): number {
	return (hashString(key) ^ Math.imul((localFrame | 0) + 1, 0x9e3779b1)) & 0x7fffffff;
}

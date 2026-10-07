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

/** Hard Mix threshold: 1 minus a quarter code value, so sums of 8-bit values that are exactly 1 count as 1 on the GPU. */
export const HARD_MIX_THRESHOLD = 1 - 0.25 / 255;

/** Rec. 709 luminance (Darker / Lighter Color, the luma stencils). */
export function luminance709(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export type BlendKernel = {
	/**
	 * Composites premultiplied `s` (layer opacity included) onto premultiplied `d` IN PLACE with mode number `mode`
	 * (index in BLEND_MODES). `noise` = Dissolve's per-pixel value (`noise(x, y, seed)`).
	 */
	blend(mode: number, d: Float64Array, s: Float64Array, noise: number): void;
	/** Dissolve's per-pixel random value in [0, 1) at integer pixel (x, y). */
	noise(x: number, y: number, seed: number): number;
};

/**
 * The blend formulas as a SELF-CONTAINED factory (no reference to module scope): `blendPixel` uses it here and the
 * native export's worker threads run its source text (`makeBlendKernel.toString()`), so both share one
 * implementation. Mode numbers are BLEND_MODES indexes (checked by a test).
 */
export function makeBlendKernel(): BlendKernel {
	const NORMAL = 0;
	const DISSOLVE = 1;
	const DARKER_COLOR = 6;
	const LIGHTER_COLOR = 11;
	const HUE = 23;
	const SATURATION = 24;
	const COLOR = 25;
	const LUMINOSITY = 26;
	const STENCIL_ALPHA = 27;
	const STENCIL_LUMA = 28;
	const SILHOUETTE_ALPHA = 29;
	const SILHOUETTE_LUMA = 30;
	const ALPHA_ADD = 31;
	// Modes defined for over-range values (inputs not clamped to 0..1): normal, dissolve, darken, multiply, linear
	// burn, darker color, lighten, screen, add, lighter color, difference, subtract, divide, the utility modes.
	const HDR = new Set([0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 19, 21, 22, 27, 28, 29, 30, 31]);
	const HARD_MIX = 1 - 0.25 / 255;
	// Darker / Lighter Color: luminance differences below this keep the base (float rounding of unpremultiplied
	// colour must not decide; the GLSL uses the same tie).
	const LUMA_TIE = 1e-5;
	const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
	const burn = (cb: number, cs: number) => (cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min((1 - cb) / cs, 1));
	const dodge = (cb: number, cs: number) => (cb <= 0 ? 0 : cs >= 1 ? 1 : Math.min(cb / (1 - cs), 1));
	const hardLight = (cb: number, cs: number) => {
		if (cs <= 0.5) return cb * 2 * cs;
		const t = 2 * cs - 1;
		return cb + t - cb * t;
	};
	const softLight = (cb: number, cs: number) => {
		if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
		const dd = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(Math.max(cb, 0));
		return cb + (2 * cs - 1) * (dd - cb);
	};
	// B(Cb, Cs) of a separable mode on one straight channel.
	const sep = (mode: number, cb: number, cs: number): number => {
		switch (mode) {
			case 2: // darken
				return Math.min(cb, cs);
			case 3: // multiply
				return cb * cs;
			case 4: // color burn
				return burn(cb, cs);
			case 5: // linear burn
				return Math.max(cb + cs - 1, 0);
			case 7: // lighten
				return Math.max(cb, cs);
			case 8: // screen
				return cb + cs - cb * cs;
			case 9: // color dodge
				return dodge(cb, cs);
			case 10: // linear dodge (add)
				return cb + cs;
			case 12: // overlay
				return hardLight(cs, cb);
			case 13: // soft light
				return softLight(cb, cs);
			case 14: // hard light
				return hardLight(cb, cs);
			case 15: // vivid light
				return cs <= 0.5 ? burn(cb, 2 * cs) : dodge(cb, 2 * (cs - 0.5));
			case 16: // linear light
				return Math.min(1, Math.max(0, cb + 2 * cs - 1));
			case 17: // pin light
				return cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1);
			case 18: // hard mix: cb + cs ≥ 1 (8-bit-grid ties count as 1)
				return cb + cs >= HARD_MIX ? 1 : 0;
			case 19: // difference
				return Math.abs(cb - cs);
			case 20: // exclusion
				return cb + cs - 2 * cb * cs;
			case 21: // subtract
				return Math.max(cb - cs, 0);
			case 22: // divide
				return cs <= 0 ? (cb > 0 ? 1 : 0) : cb / cs;
			default:
				return cs;
		}
	};
	// Non-separable helpers (W3C / PDF: Lum = 0.3 R + 0.59 G + 0.11 B).
	const o = new Float64Array(3);
	const lum = (c: Float64Array) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
	const clipColor = (c: Float64Array) => {
		const l = lum(c);
		const n = Math.min(c[0]!, c[1]!, c[2]!);
		const x = Math.max(c[0]!, c[1]!, c[2]!);
		if (n < 0) {
			const k = l / Math.max(l - n, 1e-9);
			for (let i = 0; i < 3; i++) c[i] = l + (c[i]! - l) * k;
		}
		if (x > 1) {
			const k = (1 - l) / Math.max(x - l, 1e-9);
			for (let i = 0; i < 3; i++) c[i] = l + (c[i]! - l) * k;
		}
	};
	const setLum = (c: Float64Array, l: number) => {
		const dl = l - lum(c);
		for (let i = 0; i < 3; i++) c[i] = c[i]! + dl;
		clipColor(c);
	};
	const sat = (c: Float64Array) => Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!);
	const setSat = (c: Float64Array, t: number) => {
		const mx = Math.max(c[0]!, c[1]!, c[2]!);
		const mn = Math.min(c[0]!, c[1]!, c[2]!);
		if (mx - mn <= 1e-9) {
			c.fill(0);
			return;
		}
		const k = t / (mx - mn);
		for (let i = 0; i < 3; i++) c[i] = (c[i]! - mn) * k;
	};
	const cb = new Float64Array(3);
	const cs = new Float64Array(3);
	const blend = (mode: number, d: Float64Array, s: Float64Array, noise: number): void => {
		const sa = s[3]!;
		const da = d[3]!;
		switch (mode) {
			case NORMAL: {
				const k = 1 - sa;
				for (let i = 0; i < 3; i++) d[i] = s[i]! + d[i]! * k;
				d[3] = sa + da * k;
				return;
			}
			case DISSOLVE: {
				if (sa <= 0 || noise >= sa) return;
				for (let i = 0; i < 3; i++) d[i] = s[i]! / sa;
				d[3] = 1;
				return;
			}
			case STENCIL_ALPHA:
			case SILHOUETTE_ALPHA:
			case STENCIL_LUMA:
			case SILHOUETTE_LUMA: {
				const l = mode === STENCIL_LUMA || mode === SILHOUETTE_LUMA ? luma(s[0]!, s[1]!, s[2]!) : sa;
				const k = mode === STENCIL_ALPHA || mode === STENCIL_LUMA ? l : 1 - l;
				for (let i = 0; i < 4; i++) d[i] = d[i]! * k;
				return;
			}
			case ALPHA_ADD: {
				const k = 1 - sa;
				for (let i = 0; i < 3; i++) d[i] = s[i]! + d[i]! * k;
				d[3] = Math.min(sa + da, 1);
				return;
			}
		}
		if (sa <= 0) return;
		if (da <= 0) {
			for (let i = 0; i < 4; i++) d[i] = s[i]!;
			return;
		}
		const clampIn = !HDR.has(mode);
		for (let i = 0; i < 3; i++) {
			const a = s[i]! / sa;
			const b = d[i]! / da;
			cs[i] = clampIn ? Math.min(1, Math.max(0, a)) : a;
			cb[i] = clampIn ? Math.min(1, Math.max(0, b)) : b;
		}
		switch (mode) {
			case HUE:
				o.set(cs);
				setSat(o, sat(cb));
				setLum(o, lum(cb));
				break;
			case SATURATION:
				o.set(cb);
				setSat(o, sat(cs));
				setLum(o, lum(cb));
				break;
			case COLOR:
				o.set(cs);
				setLum(o, lum(cb));
				break;
			case LUMINOSITY:
				o.set(cb);
				setLum(o, lum(cs));
				break;
			case DARKER_COLOR:
				o.set(luma(cs[0]!, cs[1]!, cs[2]!) < luma(cb[0]!, cb[1]!, cb[2]!) - LUMA_TIE ? cs : cb);
				break;
			case LIGHTER_COLOR:
				o.set(luma(cs[0]!, cs[1]!, cs[2]!) > luma(cb[0]!, cb[1]!, cb[2]!) + LUMA_TIE ? cs : cb);
				break;
			default:
				for (let i = 0; i < 3; i++) o[i] = sep(mode, cb[i]!, cs[i]!);
		}
		const k = sa * da;
		for (let i = 0; i < 3; i++) d[i] = (1 - da) * s[i]! + (1 - sa) * d[i]! + k * o[i]!;
		d[3] = sa + da - k;
	};
	// EffectCraft `raster::hash_noise`: an integer hash (24 bits, exact as a GPU float).
	const noise = (x: number, y: number, seed: number): number => {
		let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(seed, 0xcb1ab31f)) >>> 0;
		h = (h ^ (h >>> 13)) >>> 0;
		h = Math.imul(h, 0x5bd1e995) >>> 0;
		h = (h ^ (h >>> 15)) >>> 0;
		return (h & 0xffffff) / 16777216;
	};
	return { blend, noise };
}

const KERNEL = makeBlendKernel();

export type Rgba = [number, number, number, number];

/**
 * Composites a premultiplied source pixel (layer opacity included) onto a premultiplied destination pixel (the stack
 * below). `noise` (0..1, `dissolveNoise`) is Dissolve's per-pixel random value. Stencil / Silhouette modes return
 * the destination masked by the source.
 */
export function blendPixel(mode: string, dst: Rgba, src: Rgba, noise: number): Rgba {
	const d = Float64Array.from(dst);
	KERNEL.blend(blendModeIndex(mode), d, Float64Array.from(src), noise);
	return [d[0]!, d[1]!, d[2]!, d[3]!];
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
	return KERNEL.noise(x, y, seed);
}

/** Dissolve seed of a layer (clip id, or `transition:<id>` for a transition span) at a clip-local frame: 31 bits. */
export function dissolveSeed(key: string, localFrame: number): number {
	return (hashString(key) ^ Math.imul((localFrame | 0) + 1, 0x9e3779b1)) & 0x7fffffff;
}

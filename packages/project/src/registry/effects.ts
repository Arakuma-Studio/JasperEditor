// Unknown effect ids are preserved in project documents and bypassed by renderers.

import type { Lut, Rgb } from '../color/lut.ts';
import type { SequenceColorInfo } from '../color/model.ts';
import type { OcioConfig } from '../color/ocio/config.ts';
import { evaluate, expressionBindingOf } from '../keyframes.ts';
import type { SpatialMetric } from '../keyframes-spatial.ts';
import type { Animatable, ParamValue, SpatialInterpolation } from '../schema/common.ts';
import type { MediaKind } from '../schema/media.ts';
import { AUDIO_EFFECTS } from './audio/index.ts';
import {
	BLACK_WHITE_OP,
	BRIGHTNESS_CONTRAST_OP,
	blackWhiteAmount,
	brightnessContrastLinear,
	COLOR_EFFECTS,
	COLOR_INPUT_EFFECT,
	HUE_SATURATION_OP,
	hueSaturationValues,
} from './color-effects.ts';
import { EXPRESSION_CONTROL_EFFECTS } from './expression-controls.ts';
import { FX_EFFECTS } from './fx/index.ts';
import type { GpuEffect } from './fx/shader.ts';
import { LUMETRI_SPATIAL_EFFECT } from './lumetri-spatial.ts';

export { blackWhiteAmount, brightnessContrastLinear, hueSaturationValues };

export type EffectCategory =
	| 'Adjust'
	| 'Blur & Sharpen'
	| 'Color Correction'
	| 'Distort'
	| 'Generate'
	| 'Keying'
	| 'Stylize'
	| 'Time'
	| 'Transform'
	| 'Utility'
	| 'Channel'
	| 'Image Control'
	| 'Perspective'
	| 'Amplitude'
	| 'Filter'
	| 'Noise Reduction'
	| 'Time and Pitch'
	| 'Noise & Grain'
	| 'Transition'
	| 'Video'
	// sim-warp: After Effects' Simulation category (particles, shatter, cards, foam, waves, caustics, weather).
	| 'Simulation'
	// Audio effects (audio-fx): Premiere's Audio Effects folders (Premiere Pro 2020+, helpx "Audio effects and
	// transitions"); the folder is the category.
	| 'Amplitude and Compression'
	| 'Delay and Echo'
	| 'Filter and EQ'
	| 'Modulation'
	| 'Noise Reduction/Restoration'
	| 'Reverb'
	| 'Special'
	| 'Stereo Imagery'
	| 'Expression Controls';

export type ParamSpec = {
	name: string;
	label: string;
	/**
	 * `curve` = `{curve: [x, y][]}` tone curve (M2); `media` = `{mediaId}` (LUT assets: `mediaKinds: ['lut']`);
	 * `mesh` (sim-warp) = a keyframable distortion mesh, a flat number list whose layout the effect defines (Mesh Warp,
	 * Liquify) — edited on the Program monitor and by commands, keys interpolate number by number.
	 */
	type: 'number' | 'boolean' | 'enum' | 'string' | 'vec2' | 'vec3' | 'color' | 'media' | 'curve' | 'mesh';
	default: ParamValue;
	range?: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number };
	/**
	 * Display unit. Audio effects (audio-fx) add `ms`, `Q` (filter quality), `ratio` (`x:1`), `st` (semitones),
	 * `cents`, `LUFS`, `dBTP` and `bpm`.
	 */
	unit?:
		| 'px'
		| '%'
		| 'deg'
		| 'dB'
		| 'frames'
		| 's'
		| 'Hz'
		| 'ms'
		| 'Q'
		| 'ratio'
		| 'st'
		| 'cents'
		| 'LUFS'
		| 'dBTP'
		| 'bpm'
		/** color-mgmt: luminance in cd/m² (Lumetri HDR White). */
		| 'nits';
	/** Enums, booleans, strings and media refs are hold-only (S01:KF-007). */
	animatable: boolean;
	/**
	 * Animatable vec2 *points* (S03:KF-021): the spatial interpolation new keys get; their keys may carry curved
	 * spatial paths. Absent = not a point (component-wise lerp only, e.g. colour wheels).
	 */
	spatial?: SpatialInterpolation;
	/**
	 * spatial-points: the units of a point's spatial path. `layer-box` = normalised to the layer box (x · box width,
	 * y · box height pixels; `fxParam.point`, Corner Pin), so arc length, Auto Bezier handles and speeds are measured
	 * with the metric [width, height] (`paramSpatialMetric`). Absent = isotropic value units (layer px).
	 */
	spatialMetric?: 'layer-box';
	options?: readonly string[];
	/** Human labels for `options` (same order). */
	optionLabels?: readonly string[];
	/**
	 * UI hint for the inspector rows (defaults derive from `type`). `wheel` = a colour wheel over a vec2 (M2).
	 * `point` (fx framework) = a vec2 normalised to the layer box, edited as x/y fields and dragged on the canvas.
	 */
	ui?: {
		control?:
			| 'scrub'
			| 'slider'
			| 'angle'
			| 'select'
			| 'toggle'
			| 'color'
			| 'wheel'
			| 'curve'
			| 'media'
			| 'point'
			/** wp masks: a `string` param holding a video track id ('' = none), picked from the sequence's tracks. */
			| 'track'
			/** Wave expressions: Layer Control (a clip of the sequence; the value is its id, '' = none). */
			| 'layer'
			/** Wave expressions: Dropdown Menu Control (1-based index into the instance's `items` param lines). */
			| 'menu'
			// parity (roto): a string param naming a roto object of the clip (picker of the clip's objects).
			| 'roto-object';
		bipolar?: boolean;
		/** audio-fx: a logarithmic control (frequencies, times, Q). */
		scale?: 'log';
		/** Wave expressions: a multi-line text field (Dropdown Menu Control's items, one per line). */
		multiline?: boolean;
	};
	/** `media` params: asset kinds the picker offers (e.g. `['lut']`). */
	mediaKinds?: readonly MediaKind[];
	/** Section inside a multi-section effect editor (e.g. Lumetri `basic`, `creative`, `curves`, `wheels`). */
	group?: string;
};

/**
 * A per-pixel colour operation (M2, ARCHITECTURE §19.2, S06:CG-010). Every effect that has one is a pure
 * function RGB → RGB on display-referred (Rec.709/sRGB-encoded) values in 0..1 without spatial or temporal
 * context, so consecutive colour effects of a layer fuse into ONE baked 3D LUT: the WebGL preview samples it
 * as a 3D texture and the native export applies it with `lut3d` (tetrahedral), which keeps both paths equal to
 * the LUT's precision. Alpha is never touched.
 */
export type ColorOpContext = {
	/** A parsed LUT asset (`{mediaId}` params), or null when missing/offline (the op then skips it). */
	lut(mediaId: string): Lut | null;
	/**
	 * color-mgmt: the sequence's working space and colour settings (absent = Rec. 709 defaults). Colour ops whose maths
	 * depend on it (input transforms, Lumetri's HDR grading signal) read it; run keys include it (`colorRunKey` extra).
	 */
	working?: SequenceColorInfo;
	/** color-mgmt: a parsed custom OCIO config (`color-config` media), or null when missing/offline/unreadable. */
	colorConfig?(mediaId: string): OcioConfig | null;
};
/** Transforms `c` in place. Must be deterministic and must not allocate per call in hot paths. */
export type ColorFn = (c: Rgb) => void;
export type ColorOp = {
	/** The pixel function for evaluated params, or null when the params are the identity. */
	build(p: EffectParams, ctx: ColorOpContext): ColorFn | null;
};

export type EffectParams = Record<string, ParamValue>;

export type NativeFilterContext = {
	/** Intrinsic layer size in pixels. */
	width: number;
	height: number;
	fps: number;
};

export type EffectSpec = {
	id: string;
	version: number;
	label: string;
	category: EffectCategory;
	/**
	 * Effects-panel folder under Video Effects (e.g. 'Sapphire Glows'); absent = the category folder. Third-party
	 * style packs show up this way in Premiere (R-PUI §12).
	 */
	bin?: string;
	appliesTo: 'video' | 'audio';
	params: ParamSpec[];
	/**
	 * Browser preview. `css` returns a style fragment merged onto the layer wrapper (`{filter}`,
	 * `{clipPath}`, `{transform}`) or `null` when the current params need the SVG path. `svgFilter` returns
	 * the markup of one `<filter id={uid}>` element to be referenced with `filter: url(#uid)`.
	 */
	preview: {
		css?(p: EffectParams): Record<string, string> | null;
		svgFilter?(p: EffectParams, uid: string): string;
	};
	/**
	 * ffmpeg filter text for the native export path, or null when the effect is Remotion-only or realized
	 * through `color` (colour ops are baked to a LUT by the engine's colour extension, ARCHITECTURE §19.6).
	 * Filters must exist in the shipped LGPL FFmpeg (D-13): `eq`, `hqdn3d`, `perspective`, `boxblur` do NOT.
	 */
	native: { filter(p: EffectParams, ctx: NativeFilterContext): string } | null;
	/** Pointwise colour operation (M2); when present the preview and native paths use the fused LUT. */
	color?: ColorOp;
	/**
	 * GPU realization (fx framework, wave 1): GLSL ES 3.00 fragment passes run through Remotion's canvas effect chain
	 * in the Player and on the Remotion export path (`native: null` routes clips there). See registry/fx/shader.ts
	 * and docs/wp-notes/fx-shader-framework.md.
	 */
	gpu?: GpuEffect;
	/**
	 * audio-fx: the effect is realized by the shared TypeScript DSP (`@jasper/audio-fx`): an AudioWorklet chain in
	 * the preview and the same code streamed into ffmpeg on the native path (and in the Remotion path's native audio
	 * mix). `editor` selects a graphical editor in Effect Controls; `meters` the live meters it shows.
	 */
	audio?: AudioEffectInfo;
	/** Engine capability flags driving badges, render bar and planner (S01:FX-021). */
	capabilities: { preview: 'css' | 'webgl' | 'webaudio' | 'none'; export: ('remotion' | 'native')[] };
	expensive?: boolean;
	/**
	 * Wave expressions: the effect draws nothing (Expression Controls hold values for expressions). Render snapshots
	 * leave it out, so no renderer or export path sees it; expressions still read its params from the document.
	 */
	passthrough?: boolean;
	/**
	 * color-mgmt: a render-only effect the snapshot adds (the colour input transform of a source; color-grade:
	 * `jasper.lumetri-spatial` after a Lumetri instance): never listed in the Effects panel or the agent catalogue,
	 * refused by `effect.add`, removed from documents by `repairDocument`.
	 */
	internal?: boolean;
	/**
	 * Wave expressions: defaults that depend on the clip the effect is applied to (Point Control starts at the
	 * clip's centre). Applied by `effect.add` on clips for params the command does not set.
	 */
	instanceDefaults?(ctx: { box: { width: number; height: number } }): Record<string, ParamValue>;
	/** color-grade: bypassed together with the colour effects by the before/after toggle (`colorBypass`). */
	gradeBypass?: boolean;
	/** One line for the Effects panel tooltip and the agent catalogue. */
	description?: string;
	/** Extra search terms for the Effects panel. */
	keywords?: readonly string[];
	/** Upgrades params from an older version of this effect. */
	migrate?(fromVersion: number, params: Record<string, unknown>): Record<string, unknown>;
};

/** audio-fx: how Effect Controls draws an audio effect (besides its parameter rows). */
export type AudioEffectEditor =
	| 'parametric-eq'
	| 'graphic-eq'
	| 'filter-response'
	| 'compressor'
	| 'multiband-compressor'
	| 'dynamics'
	| 'limiter';

export type AudioEffectInfo = {
	dsp: true;
	editor?: AudioEffectEditor;
	/** Live meters the editor shows (gain reduction per band, input/output level). */
	meters?: readonly ('gain-reduction' | 'level' | 'loudness')[];
};

export interface EffectRegistry {
	get(effectId: string, version?: number): EffectSpec | undefined;
	has(effectId: string): boolean;
	list(): EffectSpec[];
}

export function createEffectRegistry(specs: readonly EffectSpec[]): EffectRegistry {
	const byId = new Map<string, EffectSpec>();
	for (const s of specs) byId.set(s.id, s);
	return {
		get(effectId, version) {
			const s = byId.get(effectId);
			if (!s) return undefined;
			if (version !== undefined && version > s.version) return undefined; // newer than we know
			return s;
		},
		has: (effectId) => byId.has(effectId),
		list: () => [...byId.values()],
	};
}

/**
 * spatial-points: the spatial metric of a param's keys (pixels per value unit along x and y), or undefined when its
 * value units are isotropic or it is not a point: `[box.width, box.height]` for points normalised to the layer box.
 * `box` = the layer box of the owner (a clip's intrinsic box; the sequence frame for track and master effects).
 */
export function paramSpatialMetric(
	p: Pick<ParamSpec, 'type' | 'spatial' | 'spatialMetric'> | undefined,
	box: { width: number; height: number } | null | undefined,
): SpatialMetric | undefined {
	if (p?.type !== 'vec2' || !p.spatial || p.spatialMetric !== 'layer-box' || !box) return undefined;
	return [box.width, box.height];
}

const paramIndex = new WeakMap<EffectSpec, Map<string, ParamSpec>>();

/** The param spec `name` of an effect spec (indexed once per spec). */
export function effectParamSpec(spec: EffectSpec, name: string): ParamSpec | undefined {
	let m = paramIndex.get(spec);
	if (!m) {
		m = new Map(spec.params.map((p) => [p.name, p]));
		paramIndex.set(spec, m);
	}
	return m.get(name);
}

/**
 * spatial-points: the spatial metric of param `name` of an effect instance in a layer box (the default registry, which
 * the render snapshot, the resolver and the engine share); undefined for unknown effects and non-point params.
 */
export function effectParamMetric(
	fx: { effectId: string; effectVersion?: number },
	name: string,
	box: { width: number; height: number } | null | undefined,
	registry: Pick<EffectRegistry, 'get'> = defaultEffectRegistry,
): SpatialMetric | undefined {
	if (!box) return undefined;
	const spec = registry.get(fx.effectId, fx.effectVersion);
	return spec ? paramSpatialMetric(effectParamSpec(spec, name), box) : undefined;
}

/**
 * spatial-points: an effect param's value at content time `t` with its spatial metric (points normalised to the layer
 * box walk their paths by arc length in the box's pixels). The one call every renderer uses (`resolveLayerProps`,
 * the shader effects' sub-frame sampling through `fxParamsAtFn`'s metrics), so preview and every export path agree.
 * Bound expressions keep their property's own options (which carry the same metric).
 */
export function evaluateEffectParam(
	fx: { effectId: string; effectVersion?: number },
	name: string,
	anim: Animatable<ParamValue>,
	t: number,
	box: { width: number; height: number } | null | undefined,
): ParamValue {
	const metric =
		anim.keyframes.length > 1 && !expressionBindingOf(anim) ? effectParamMetric(fx, name, box) : undefined;
	return evaluate(anim, t, metric ? { metric } : undefined);
}

/** Effects panel badges (S05:EFX-001, R-PUI §12): "Real-time" = previewable, "Native" = ffmpeg export. */
export function effectBadges(spec: EffectSpec): { realtime: boolean; native: boolean } {
	return {
		realtime: spec.capabilities.preview !== 'none',
		native:
			(spec.native !== null || spec.color !== undefined || spec.audio !== undefined) &&
			spec.capabilities.export.includes('native'),
	};
}

/** The "GPU" badge (fx framework): a shader effect — Premiere's "Accelerated Effects" badge (R-PUI §12). */
export function effectIsGpu(spec: EffectSpec): boolean {
	return spec.gpu !== undefined;
}

const num = (p: EffectParams, k: string, d = 0) =>
	typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d;
const str = (p: EffectParams, k: string, d: string) => (typeof p[k] === 'string' ? (p[k] as string) : d);
const bool = (p: EffectParams, k: string, d: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);
const IDENTITY_STYLE: Record<string, string> = {};

/** Deterministic number text for filter strings and CSS (≤ 4 decimals, no trailing zeros, no `-0`). */
export function fmtNum(x: number): string {
	const r = Math.round(x * 10000) / 10000;
	return Object.is(r, -0) || r === 0 ? '0' : String(r);
}

/** Gaussian blur: standard deviations (px) per axis. CSS `blur(r)` and ffmpeg `gblur sigma` agree. */
export function gaussianBlurSigmas(p: EffectParams): { x: number; y: number; repeatEdge: boolean } {
	const r = Math.max(0, num(p, 'radius'));
	const dims = str(p, 'dimensions', 'both');
	return {
		x: dims === 'vertical' ? 0 : r,
		y: dims === 'horizontal' ? 0 : r,
		repeatEdge: bool(p, 'repeatEdge', false),
	};
}

const pct = (name: string, label: string, def = 0): ParamSpec => ({
	name,
	label,
	type: 'number',
	default: def,
	range: { min: 0, max: 100, step: 0.1 },
	unit: '%',
	animatable: true,
});

/** Crop (S01:FX-003): insets in percent of the intrinsic box, feather in pixels. */
export const CROP_EFFECT: EffectSpec = {
	id: 'jasper.crop',
	version: 1,
	label: 'Crop',
	category: 'Transform',
	appliesTo: 'video',
	description: 'Hides the edges of the layer (percent of its box) without moving it.',
	keywords: ['trim', 'mask', 'inset'],
	params: [
		pct('left', 'Left'),
		pct('top', 'Top'),
		pct('right', 'Right'),
		pct('bottom', 'Bottom'),
		{
			name: 'feather',
			label: 'Edge Feather',
			type: 'number',
			default: 0,
			range: { min: 0, max: 1000, step: 1 },
			unit: 'px',
			animatable: true,
		},
	],
	preview: {
		css: (p) => ({
			clipPath: `inset(${fmtNum(num(p, 'top'))}% ${fmtNum(num(p, 'right'))}% ${fmtNum(num(p, 'bottom'))}% ${fmtNum(num(p, 'left'))}%)`,
		}),
	},
	native: {
		filter(p, ctx) {
			const l = Math.round((num(p, 'left') / 100) * ctx.width);
			const r = Math.round((num(p, 'right') / 100) * ctx.width);
			const t = Math.round((num(p, 'top') / 100) * ctx.height);
			const b = Math.round((num(p, 'bottom') / 100) * ctx.height);
			const w = Math.max(1, ctx.width - l - r);
			const h = Math.max(1, ctx.height - t - b);
			// Crop keeps the layer box (content is hidden, not moved): pad back to full size.
			return `crop=${w}:${h}:${l}:${t},pad=${ctx.width}:${ctx.height}:${l}:${t}:color=black@0`;
		},
	},
	capabilities: { preview: 'css', export: ['remotion', 'native'] },
};

export const GAUSSIAN_BLUR_EFFECT: EffectSpec = {
	id: 'jasper.gaussian-blur',
	version: 1,
	label: 'Gaussian Blur',
	category: 'Blur & Sharpen',
	appliesTo: 'video',
	description: 'Softens the layer with a Gaussian kernel (radius = standard deviation in pixels).',
	keywords: ['soften', 'defocus'],
	expensive: true,
	params: [
		{
			name: 'radius',
			label: 'Blurriness',
			type: 'number',
			default: 10,
			range: { min: 0, max: 500, softMax: 100, step: 0.1 },
			unit: 'px',
			animatable: true,
		},
		{
			name: 'dimensions',
			label: 'Blur Dimensions',
			type: 'enum',
			default: 'both',
			options: ['both', 'horizontal', 'vertical'],
			optionLabels: ['Horizontal and Vertical', 'Horizontal', 'Vertical'],
			animatable: false,
		},
		{ name: 'repeatEdge', label: 'Repeat Edge Pixels', type: 'boolean', default: false, animatable: false },
	],
	preview: {
		css(p) {
			const s = gaussianBlurSigmas(p);
			if (s.x === 0 && s.y === 0) return IDENTITY_STYLE;
			if (s.x !== s.y || s.repeatEdge) return null; // needs the SVG filter
			return { filter: `blur(${fmtNum(s.x)}px)` };
		},
		svgFilter(p, uid) {
			const s = gaussianBlurSigmas(p);
			return (
				`<filter id="${uid}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">` +
				`<feGaussianBlur stdDeviation="${fmtNum(s.x)} ${fmtNum(s.y)}" edgeMode="${s.repeatEdge ? 'duplicate' : 'none'}"/>` +
				'</filter>'
			);
		},
	},
	native: {
		filter(p) {
			const s = gaussianBlurSigmas(p);
			if (s.x === 0 && s.y === 0) return 'null';
			return `gblur=sigma=${fmtNum(s.x)}:sigmaV=${fmtNum(s.y)}`;
		},
	},
	capabilities: { preview: 'css', export: ['remotion', 'native'] },
};

const bipolar100 = (name: string, label: string): ParamSpec => ({
	name,
	label,
	type: 'number',
	default: 0,
	range: { min: -100, max: 100, step: 0.1 },
	animatable: true,
	ui: { control: 'slider', bipolar: true },
});

export const BRIGHTNESS_CONTRAST_EFFECT: EffectSpec = {
	id: 'jasper.brightness-contrast',
	version: 1,
	label: 'Brightness & Contrast',
	category: 'Color Correction',
	appliesTo: 'video',
	description: 'Adds brightness and scales contrast around mid-gray (identical math in preview and export).',
	keywords: ['exposure', 'levels'],
	params: [bipolar100('brightness', 'Brightness'), bipolar100('contrast', 'Contrast')],
	preview: {
		css: (p) => (num(p, 'brightness') === 0 && num(p, 'contrast') === 0 ? IDENTITY_STYLE : null),
		svgFilter(p, uid) {
			const { slope, intercept } = brightnessContrastLinear(p);
			const fn = (c: 'R' | 'G' | 'B') =>
				`<feFunc${c} type="linear" slope="${fmtNum(slope)}" intercept="${fmtNum(intercept)}"/>`;
			return `<filter id="${uid}" color-interpolation-filters="sRGB"><feComponentTransfer>${fn('R')}${fn('G')}${fn('B')}</feComponentTransfer></filter>`;
		},
	},
	// M2 (S06:CG-003): realized by the fused colour LUT (`lut3d`); the M1 `eq` mapping is gone (GPL, D-13).
	native: null,
	color: BRIGHTNESS_CONTRAST_OP,
	capabilities: { preview: 'css', export: ['remotion', 'native'] },
};

export const HUE_SATURATION_EFFECT: EffectSpec = {
	id: 'jasper.hue-saturation',
	version: 1,
	label: 'Hue/Saturation',
	category: 'Color Correction',
	appliesTo: 'video',
	description: 'Rotates hues and scales saturation.',
	keywords: ['color', 'vibrance', 'tint'],
	params: [
		{
			name: 'hue',
			label: 'Hue',
			type: 'number',
			default: 0,
			range: { min: -180, max: 180, step: 0.1 },
			unit: 'deg',
			animatable: true,
			ui: { control: 'angle', bipolar: true },
		},
		{
			name: 'saturation',
			label: 'Saturation',
			type: 'number',
			default: 0,
			range: { min: -100, max: 100, step: 0.1 },
			animatable: true,
			ui: { control: 'slider', bipolar: true },
		},
	],
	preview: {
		css(p) {
			const { hueDeg, saturation } = hueSaturationValues(p);
			const parts: string[] = [];
			if (hueDeg !== 0) parts.push(`hue-rotate(${fmtNum(hueDeg)}deg)`);
			if (saturation !== 1) parts.push(`saturate(${fmtNum(saturation)})`);
			return parts.length ? { filter: parts.join(' ') } : IDENTITY_STYLE;
		},
	},
	// M2 (S06:CG-003): the fused colour LUT reproduces the preview matrices (`hue` did not).
	native: null,
	color: HUE_SATURATION_OP,
	capabilities: { preview: 'css', export: ['remotion', 'native'] },
};

export const BLACK_WHITE_EFFECT: EffectSpec = {
	id: 'jasper.black-white',
	version: 1,
	label: 'Black & White',
	category: 'Color Correction',
	appliesTo: 'video',
	description: 'Desaturates the layer (amount 100 % = grayscale).',
	keywords: ['grayscale', 'monochrome', 'desaturate'],
	params: [
		{
			name: 'amount',
			label: 'Amount',
			type: 'number',
			default: 100,
			range: { min: 0, max: 100, step: 0.1 },
			unit: '%',
			animatable: true,
			ui: { control: 'slider' },
		},
	],
	preview: {
		css(p) {
			const a = blackWhiteAmount(p);
			return a === 0 ? IDENTITY_STYLE : { filter: `grayscale(${fmtNum(a * 100)}%)` };
		},
	},
	native: null,
	color: BLACK_WHITE_OP,
	capabilities: { preview: 'css', export: ['remotion', 'native'] },
};

export const FLIP_HORIZONTAL_EFFECT: EffectSpec = {
	id: 'jasper.flip-horizontal',
	version: 1,
	label: 'Horizontal Flip',
	category: 'Transform',
	appliesTo: 'video',
	description: 'Mirrors the layer left to right inside its box (S03:FX-051).',
	keywords: ['mirror', 'flip'],
	params: [],
	preview: { css: () => ({ transform: 'scale(-1, 1)' }) },
	native: { filter: () => 'hflip' },
	capabilities: { preview: 'css', export: ['remotion', 'native'] },
};

export const FLIP_VERTICAL_EFFECT: EffectSpec = {
	id: 'jasper.flip-vertical',
	version: 1,
	label: 'Vertical Flip',
	category: 'Transform',
	appliesTo: 'video',
	description: 'Mirrors the layer top to bottom inside its box (S03:FX-051).',
	keywords: ['mirror', 'flip', 'upside down'],
	params: [],
	preview: { css: () => ({ transform: 'scale(1, -1)' }) },
	native: { filter: () => 'vflip' },
	capabilities: { preview: 'css', export: ['remotion', 'native'] },
};

const pinCorner = (name: string, label: string, def: [number, number]): ParamSpec => ({
	name,
	label,
	type: 'vec2',
	default: def,
	range: { softMin: -1, softMax: 2, step: 0.001 },
	animatable: true,
	// Points (spatial paths available); new keys stay straight like the tracker's (S09).
	spatial: 'linear',
	spatialMetric: 'layer-box',
});

/**
 * Corner Pin (M2, ARCHITECTURE §19.5, S09:TRK-050): pins the layer's four corners (normalized to its box,
 * TL/TR/BR/BL) before Motion. Rendered by the scene resolver as a projective layer map (`projective`):
 * CSS `matrix3d` in the preview, the engine warp stage on the native path. A non-convex quad is ignored
 * (the layer draws unpinned).
 */
export const CORNER_PIN_EFFECT: EffectSpec = {
	id: 'jasper.corner-pin',
	version: 1,
	label: 'Corner Pin',
	category: 'Distort',
	appliesTo: 'video',
	description: 'Moves the four corners of the layer independently (perspective); driven by planar tracking.',
	keywords: ['perspective', 'screen replacement', 'track', 'four corner'],
	params: [
		pinCorner('topLeft', 'Upper Left', [0, 0]),
		pinCorner('topRight', 'Upper Right', [1, 0]),
		pinCorner('bottomRight', 'Lower Right', [1, 1]),
		pinCorner('bottomLeft', 'Lower Left', [0, 1]),
	],
	// Realized by the layer matrix (LayerBox matrix3d), not by a CSS/SVG filter stage.
	preview: {},
	native: null,
	capabilities: { preview: 'css', export: ['remotion', 'native'] },
};

/** The M1 catalogue in Effects-panel order. */
export const M1_EFFECTS: readonly EffectSpec[] = [
	CROP_EFFECT,
	GAUSSIAN_BLUR_EFFECT,
	BRIGHTNESS_CONTRAST_EFFECT,
	HUE_SATURATION_EFFECT,
	BLACK_WHITE_EFFECT,
	FLIP_HORIZONTAL_EFFECT,
	FLIP_VERTICAL_EFFECT,
];

/** M2 additions registered by default (the colour effects come from `registry/color-effects.ts`). */
export const M2_EFFECTS: readonly EffectSpec[] = [...COLOR_EFFECTS, CORNER_PIN_EFFECT, COLOR_INPUT_EFFECT];

/** color-grade: internal render stages (never listed; inserted by render snapshots). */
export const INTERNAL_EFFECTS: readonly EffectSpec[] = [LUMETRI_SPATIAL_EFFECT];

export const defaultEffectRegistry: EffectRegistry = createEffectRegistry([
	...M1_EFFECTS,
	...M2_EFFECTS,
	...FX_EFFECTS,
	...AUDIO_EFFECTS,
	...EXPRESSION_CONTROL_EFFECTS,
	...INTERNAL_EFFECTS,
]);

export type EffectLike = {
	id: string;
	effectId: string;
	effectVersion: number;
	enabled: boolean;
	/** Parameter values already evaluated at the frame (or raw values for static params). */
	params: EffectParams;
};

/** Params with registry defaults filled in for missing or null values. */
export function effectiveParams(
	spec: EffectSpec,
	params: Readonly<Partial<Record<string, ParamValue | null>>>,
): EffectParams {
	const out: EffectParams = {};
	for (const p of spec.params) {
		const v = params[p.name];
		out[p.name] = v ?? p.default;
	}
	return out;
}

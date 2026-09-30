// Effect registry (S01:FX-020…024, S03 §15, ARCHITECTURE §5.4). App code, never document data.
// M1 catalogue (WP-2D): crop, gaussian blur, brightness & contrast, hue/saturation, black & white,
// horizontal and vertical flip. Each entry carries its canonical parameter math (S03:FX-040) and both
// realizations: a browser preview (CSS style fragment or inline SVG filter) and an ffmpeg filter string
// for the native export path. Unknown ids are preserved and bypassed by the renderers (S01:FX-022).
import type { ParamValue } from '../schema/common.ts';

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
	| 'Amplitude'
	| 'Filter'
	| 'Noise Reduction'
	| 'Time and Pitch';

export type ParamSpec = {
	name: string;
	label: string;
	type: 'number' | 'boolean' | 'enum' | 'string' | 'vec2' | 'color' | 'media';
	default: ParamValue;
	range?: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number };
	unit?: 'px' | '%' | 'deg' | 'dB' | 'frames' | 's' | 'Hz';
	/** Enums, booleans, strings and media refs are hold-only (S01:KF-007). */
	animatable: boolean;
	options?: readonly string[];
	/** Human labels for `options` (same order). */
	optionLabels?: readonly string[];
	/** UI hint for the inspector rows (defaults derive from `type`). */
	ui?: { control?: 'scrub' | 'slider' | 'angle' | 'select' | 'toggle' | 'color'; bipolar?: boolean };
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
	/** ffmpeg filter text for the native export path, or null when the effect is Remotion-only. */
	native: { filter(p: EffectParams, ctx: NativeFilterContext): string } | null;
	/** Engine capability flags driving badges, render bar and planner (S01:FX-021). */
	capabilities: { preview: 'css' | 'webgl' | 'webaudio' | 'none'; export: ('remotion' | 'native')[] };
	expensive?: boolean;
	/** One line for the Effects panel tooltip and the agent catalogue. */
	description?: string;
	/** Extra search terms for the Effects panel. */
	keywords?: readonly string[];
	/** Upgrades params from an older version of this effect. */
	migrate?(fromVersion: number, params: Record<string, unknown>): Record<string, unknown>;
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

/** Returns a new registry with extra (or replacing) specs. */
export function extendEffectRegistry(base: EffectRegistry, specs: readonly EffectSpec[]): EffectRegistry {
	return createEffectRegistry([...base.list().filter((b) => !specs.some((s) => s.id === b.id)), ...specs]);
}

export function defaultParams(spec: EffectSpec): EffectParams {
	const out: EffectParams = {};
	for (const p of spec.params) out[p.name] = p.default;
	return out;
}

/** Effects panel badges (S05:EFX-001, R-PUI §12): "Real-time" = previewable, "Native" = ffmpeg export. */
export function effectBadges(spec: EffectSpec): { realtime: boolean; native: boolean } {
	return {
		realtime: spec.capabilities.preview !== 'none',
		native: spec.native !== null && spec.capabilities.export.includes('native'),
	};
}

// ---------------------------------------------------------------- canonical parameter math (S03:FX-040)

const num = (p: EffectParams, k: string, d = 0) =>
	typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d;
const str = (p: EffectParams, k: string, d: string) => (typeof p[k] === 'string' ? (p[k] as string) : d);
const bool = (p: EffectParams, k: string, d: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const IDENTITY_STYLE: Record<string, string> = {};

/** Deterministic number text for filter strings and CSS (≤ 4 decimals, no trailing zeros, no `-0`). */
export function fmtNum(x: number): string {
	const r = Math.round(x * 10000) / 10000;
	return Object.is(r, -0) || r === 0 ? '0' : String(r);
}

/**
 * Brightness & Contrast (S03:FX-040). With `b, c ∈ [−100, 100]` every sRGB-encoded channel maps as
 * `out = k·(in − ½) + ½ + b/200` with `k = 1 + c/100`: brightness adds `b/100 · 0.5`, contrast scales
 * around mid-gray. The preview uses an SVG `feComponentTransfer` linear function (not CSS
 * `brightness()`, which multiplies); ffmpeg gets `eq` with the same offset and gain (saturation = k so
 * chroma scales with the RGB gain, which is what a per-channel gain around gray does in YCbCr).
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

/** Black & White: fraction of desaturation (0..1); native uses `hue=s=1−amount`. */
export function blackWhiteAmount(p: EffectParams): number {
	return clamp(num(p, 'amount', 100), 0, 100) / 100;
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

// ---------------------------------------------------------------- M1 catalogue

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
	native: {
		filter(p) {
			const b = clamp(num(p, 'brightness'), -100, 100);
			const { slope } = brightnessContrastLinear(p);
			if (b === 0 && slope === 1) return 'null';
			return `eq=brightness=${fmtNum(b / 200)}:contrast=${fmtNum(slope)}:saturation=${fmtNum(slope)}`;
		},
	},
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
	native: {
		filter(p) {
			const { hueDeg, saturation } = hueSaturationValues(p);
			if (hueDeg === 0 && saturation === 1) return 'null';
			return `hue=h=${fmtNum(hueDeg)}:s=${fmtNum(saturation)}`;
		},
	},
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
	native: {
		filter(p) {
			const a = blackWhiteAmount(p);
			return a === 0 ? 'null' : `hue=s=${fmtNum(1 - a)}`;
		},
	},
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

export const defaultEffectRegistry: EffectRegistry = createEffectRegistry(M1_EFFECTS);

// ---------------------------------------------------------------- realization helpers (shared by engines)

export type EffectLike = {
	id: string;
	effectId: string;
	effectVersion: number;
	enabled: boolean;
	/** Parameter values already evaluated at the frame (or raw values for static params). */
	params: Record<string, unknown>;
};

/** Params with registry defaults filled in (missing or mistyped values fall back to the default). */
export function effectiveParams(spec: EffectSpec, params: Record<string, unknown>): EffectParams {
	const out: EffectParams = {};
	for (const p of spec.params) {
		const v = params[p.name];
		out[p.name] = v === undefined || v === null ? p.default : (v as ParamValue);
	}
	return out;
}

/**
 * Preview segments for an effect stack (S03:FX-002): consecutive CSS-expressible effects merge into one
 * `filter` chain; an SVG filter, a transform or a clip path starts a new wrapper so order is preserved.
 * Disabled and unknown effects are skipped (S01:FX-022, S03:FX-003).
 */
export type PreviewSegment =
	| { kind: 'css'; style: Record<string, string>; effectIds: string[] }
	| { kind: 'svg'; filterId: string; markup: string; effectIds: string[] };

export function buildPreviewChain(
	effects: readonly EffectLike[],
	registry: EffectRegistry,
	uidPrefix: string,
): { segments: PreviewSegment[]; skipped: string[] } {
	const segments: PreviewSegment[] = [];
	const skipped: string[] = [];
	for (const fx of effects) {
		if (!fx.enabled) continue;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (!spec) {
			skipped.push(fx.id);
			continue;
		}
		if (spec.appliesTo !== 'video') continue;
		const p = effectiveParams(spec, fx.params);
		const css = spec.preview.css?.(p);
		if (css && Object.keys(css).length === 0) continue; // identity
		if (css) {
			const last = segments[segments.length - 1];
			const onlyFilter = Object.keys(css).length === 1 && css.filter !== undefined;
			if (last?.kind === 'css' && onlyFilter && Object.keys(last.style).every((k) => k === 'filter')) {
				last.style.filter = last.style.filter ? `${last.style.filter} ${css.filter}` : css.filter!;
				last.effectIds.push(fx.id);
			} else segments.push({ kind: 'css', style: { ...css }, effectIds: [fx.id] });
			continue;
		}
		if (spec.preview.svgFilter) {
			const filterId = `${uidPrefix}-${fx.id}`;
			segments.push({
				kind: 'svg',
				filterId,
				markup: spec.preview.svgFilter(p, filterId),
				effectIds: [fx.id],
			});
		} else skipped.push(fx.id);
	}
	return { segments, skipped };
}

/**
 * ffmpeg filter chain for an effect stack on the native path (comma-joined, in stack order). Returns
 * `blockers` for enabled effects with no native realization so the planner can route to Remotion.
 */
export function buildNativeFilterChain(
	effects: readonly EffectLike[],
	registry: EffectRegistry,
	ctx: NativeFilterContext,
): { filter: string; blockers: string[]; skipped: string[] } {
	const parts: string[] = [];
	const blockers: string[] = [];
	const skipped: string[] = [];
	for (const fx of effects) {
		if (!fx.enabled) continue;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (!spec) {
			skipped.push(fx.id);
			continue;
		}
		if (spec.appliesTo !== 'video') continue;
		if (!spec.native) {
			blockers.push(fx.id);
			continue;
		}
		const f = spec.native.filter(effectiveParams(spec, fx.params), ctx);
		if (f && f !== 'null') parts.push(f);
	}
	return { filter: parts.length ? parts.join(',') : 'null', blockers, skipped };
}

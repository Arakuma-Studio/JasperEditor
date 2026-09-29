// Effect registry (S01:FX-020…022, S03 §15, ARCHITECTURE §5.4). App code, never document data.
// WP-00 ships the registry API and `jasper.crop`; WP-2D registers the rest of the M1 catalog.
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
	/** Browser preview. `css` returns a style fragment merged onto the layer (e.g. `{filter}`, `{clipPath}`). */
	preview: { css?(p: EffectParams): Record<string, string>; svgFilter?(p: EffectParams, uid: string): string };
	/** ffmpeg filter text for the native export path, or null when the effect is Remotion-only. */
	native: { filter(p: EffectParams, ctx: NativeFilterContext): string } | null;
	/** Engine capability flags driving badges, render bar and planner (S01:FX-021). */
	capabilities: { preview: 'css' | 'webgl' | 'webaudio' | 'none'; export: ('remotion' | 'native')[] };
	expensive?: boolean;
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

const num = (p: EffectParams, k: string, d = 0) => (typeof p[k] === 'number' ? (p[k] as number) : d);

/** Crop (S01:FX-003): insets in percent of the intrinsic box, feather in pixels. */
export const CROP_EFFECT: EffectSpec = {
	id: 'jasper.crop',
	version: 1,
	label: 'Crop',
	category: 'Transform',
	appliesTo: 'video',
	params: [
		{ name: 'left', label: 'Left', type: 'number', default: 0, range: { min: 0, max: 100, step: 0.1 }, unit: '%', animatable: true },
		{ name: 'top', label: 'Top', type: 'number', default: 0, range: { min: 0, max: 100, step: 0.1 }, unit: '%', animatable: true },
		{ name: 'right', label: 'Right', type: 'number', default: 0, range: { min: 0, max: 100, step: 0.1 }, unit: '%', animatable: true },
		{ name: 'bottom', label: 'Bottom', type: 'number', default: 0, range: { min: 0, max: 100, step: 0.1 }, unit: '%', animatable: true },
		{ name: 'feather', label: 'Edge Feather', type: 'number', default: 0, range: { min: 0, max: 1000, step: 1 }, unit: 'px', animatable: true },
	],
	preview: {
		css: (p) => ({
			clipPath: `inset(${num(p, 'top')}% ${num(p, 'right')}% ${num(p, 'bottom')}% ${num(p, 'left')}%)`,
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

export const defaultEffectRegistry: EffectRegistry = createEffectRegistry([CROP_EFFECT]);

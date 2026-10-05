// Parameter builders of the fx framework (wave 1): concise `ParamSpec`s with the framework's conventions, and the
// Sapphire-style common params ("Mix with Orig", "Show", "Seed"). Conventions (normative, see the authoring guide):
// - point params are vec2 NORMALISED to the layer box ([0,0] top-left, [1,1] bottom-right; may leave it), with
//   `ui.control: 'point'` (on-canvas handle in the Program monitor); shaders map them with `fx_uvOfLayerNorm`;
// - sizes/radii/distances are layer pixels (`unit: 'px'`); multiply by `u_pxScale` in shaders;
// - angles are degrees (0° = right, clockwise on screen); percentages are 0..100 (divide in the shader);
// - colours are straight RGBA 0..1.
import type { ParamValue, RGBA, Vec2 } from '../../schema/common.ts';
import type { ParamSpec } from '../effects.ts';
import { FX_BLEND_MODE_LABELS, FX_BLEND_MODES } from './glsl/blend.ts';
import { FX_EDGE_MODE_LABELS, FX_EDGE_MODES } from './glsl/sample.ts';

type Range = NonNullable<ParamSpec['range']>;
type Extra = { group?: string; animatable?: boolean; ui?: ParamSpec['ui']; range?: Range };

const merge = (p: ParamSpec, extra?: Extra): ParamSpec => ({
	...p,
	...(extra?.group ? { group: extra.group } : {}),
	...(extra?.animatable !== undefined ? { animatable: extra.animatable } : {}),
	...(extra?.ui ? { ui: { ...p.ui, ...extra.ui } } : {}),
	...(extra?.range ? { range: { ...p.range, ...extra.range } } : {}),
});

export const fxParam = {
	/** A plain number (`u_<name>` float). */
	number(
		name: string,
		label: string,
		def: number,
		range: Range,
		extra?: Extra & { unit?: ParamSpec['unit'] },
	) {
		return merge(
			{
				name,
				label,
				type: 'number',
				default: def,
				range,
				animatable: true,
				...(extra?.unit ? { unit: extra.unit } : {}),
			},
			extra,
		);
	},
	/** 0..100 % (slider). The uniform holds the percentage: divide by 100 in GLSL. */
	percent(name: string, label: string, def: number, extra?: Extra) {
		return merge(
			{
				name,
				label,
				type: 'number',
				default: def,
				range: { min: 0, max: 100, step: 0.1 },
				unit: '%',
				animatable: true,
				ui: { control: 'slider' },
			},
			extra,
		);
	},
	/** A size in layer pixels (`unit: 'px'`; scale by u_pxScale in GLSL). */
	pixels(name: string, label: string, def: number, max = 1000, extra?: Extra) {
		return merge(
			{
				name,
				label,
				type: 'number',
				default: def,
				range: { min: 0, max: max * 10, softMax: max, step: 0.1 },
				unit: 'px',
				animatable: true,
			},
			extra,
		);
	},
	/** An angle in degrees (angle dial). */
	angle(name: string, label: string, def: number, extra?: Extra) {
		return merge(
			{
				name,
				label,
				type: 'number',
				default: def,
				range: { step: 0.1 },
				unit: 'deg',
				animatable: true,
				ui: { control: 'angle' },
			},
			extra,
		);
	},
	/** A point normalised to the layer box (vec2; on-canvas handle). */
	point(name: string, label: string, def: Vec2 = [0.5, 0.5], extra?: Extra) {
		return merge(
			{
				name,
				label,
				type: 'vec2',
				default: def,
				range: { softMin: -1, softMax: 2, step: 0.001 },
				animatable: true,
				ui: { control: 'point' },
			},
			extra,
		);
	},
	/** A two-component value that is not a position (scale x/y, offsets in px). */
	vec2(name: string, label: string, def: Vec2, range: Range = { step: 0.1 }, extra?: Extra) {
		return merge({ name, label, type: 'vec2', default: def, range, animatable: true }, extra);
	},
	/** A colour (straight RGBA 0..1; `u_<name>` vec4). */
	color(name: string, label: string, def: RGBA, extra?: Extra) {
		return merge({ name, label, type: 'color', default: def, animatable: true }, extra);
	},
	/** A checkbox (`u_<name>` bool; hold-only). */
	toggle(name: string, label: string, def: boolean, extra?: Extra) {
		return merge({ name, label, type: 'boolean', default: def, animatable: false }, extra);
	},
	/** A popup (`u_<name>` int = index of the option; hold-only). */
	choice(
		name: string,
		label: string,
		options: readonly string[],
		labels: readonly string[],
		def: string,
		extra?: Extra,
	) {
		return merge(
			{
				name,
				label,
				type: 'enum',
				default: def,
				options,
				optionLabels: labels,
				animatable: false,
				ui: { control: 'select' },
			},
			extra,
		);
	},
	/**
	 * A picture input (`media` param: `sampler2D u_<name>` + `vec2 u_<name>_size`, (0,0) when none): an image or a
	 * video of the project, sampled at the same clip-local time (depth/displacement maps, textures, mattes).
	 */
	media(
		name: string,
		label: string,
		kinds: readonly ('image' | 'video')[] = ['image', 'video'],
		extra?: Extra,
	) {
		return merge(
			{
				name,
				label,
				type: 'media',
				default: { mediaId: '' } as ParamValue,
				mediaKinds: kinds,
				animatable: false,
				ui: { control: 'media' },
			},
			extra,
		);
	},
};

// ---------------------------------------------------------------- Sapphire-style common params

/** "Mix with Orig" 0..1 (`u_mixWithOriginal`; use `fx_finish` / `fx_mixOriginal`). */
export function mixWithOriginalParam(def = 0): ParamSpec {
	return {
		name: 'mixWithOriginal',
		label: 'Mix with Orig',
		type: 'number',
		default: def,
		range: { min: 0, max: 1, step: 0.01 },
		animatable: true,
		ui: { control: 'slider' },
	};
}

/**
 * "Show" popup (`u_show` int: 0 = Result, 1 = Matte, then `extra` options in order, e.g. 'glowOnly').
 * Use `fx_finish(result, original, matte, u_mixWithOriginal, u_show)`.
 */
export function showParam(extra: readonly { value: string; label: string }[] = []): ParamSpec {
	return {
		name: 'show',
		label: 'Show',
		type: 'enum',
		default: 'result',
		options: ['result', 'matte', ...extra.map((e) => e.value)],
		optionLabels: ['Result', 'Matte', ...extra.map((e) => e.label)],
		animatable: false,
		ui: { control: 'select' },
	};
}

/** "Seed" (integer-valued number). Mixed into `u_seed` by the framework, so shaders just use `u_seed`. */
export function seedParam(def = 0): ParamSpec {
	return {
		name: 'seed',
		label: 'Seed',
		type: 'number',
		default: def,
		range: { min: 0, max: 100000, softMax: 1000, step: 1 },
		animatable: false,
	};
}

/** Blend mode popup in FX_BLEND_MODES order (`u_<name>` int → `fx_blend(u_<name>, …)`). */
export function blendModeParam(
	name = 'blendMode',
	label = 'Blend Mode',
	def: (typeof FX_BLEND_MODES)[number] = 'normal',
) {
	return fxParam.choice(name, label, FX_BLEND_MODES, FX_BLEND_MODE_LABELS, def);
}

/** Edge mode popup in FX_EDGE_MODES order (`u_<name>` int → `fx_sampleEdge(t, uv, u_<name>)`). */
export function edgeModeParam(
	name = 'edgeMode',
	label = 'Edge Mode',
	def: (typeof FX_EDGE_MODES)[number] = 'transparent',
) {
	return fxParam.choice(name, label, FX_EDGE_MODES, FX_EDGE_MODE_LABELS, def);
}

/** The trailing params most Sapphire effects share: Show, Mix with Orig (+ Seed when random). */
export function sapphireCommonParams(
	opts: { seed?: boolean; show?: readonly { value: string; label: string }[] } = {},
) {
	return [...(opts.seed ? [seedParam()] : []), showParam(opts.show), mixWithOriginalParam()];
}

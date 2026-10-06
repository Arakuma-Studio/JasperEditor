// `defineShaderTransition` (wave-2 transition framework): the one way transition family files declare GPU
// transitions, so every entry gets the same defaults — version 1, video, `preview: 'webgl'`, Remotion export, the
// Effects-panel bin — and Premiere's standard transition options as params: Start / End (%), Reverse, and on request
// Border Width / Border Color, Anti-aliasing Quality and a Center point. Bins mirror Premiere's Video Transitions
// folders (R-PUI §12); the Sapphire-style families sit in "Sapphire Transitions" with sub-bins.
// Authoring guide: docs/wp-notes/fx-transition-framework.md.

import type { RGBA, Vec2 } from '../../schema/common.ts';
import type { TransitionSpec } from '../../transitions.ts';
import type { ParamSpec } from '../effects.ts';
import { fxParam } from '../fx/params.ts';
import { TR_AA_LABELS, TR_AA_OPTIONS } from './glsl.ts';
import type { GpuTransition } from './shader.ts';

/** Effects-panel folders under Video Transitions (Premiere's bins, then the Sapphire-style pack). */
export const TRANSITION_BINS = {
	motion3d: '3D Motion',
	animation: 'Animation',
	dissolve: 'Dissolve',
	grungeDistort: 'Grunge & Distort',
	immersive: 'Immersive Video',
	iris: 'Iris',
	lightsBlurs: 'Lights & Blurs',
	pagePeel: 'Page Peel',
	slide: 'Slide',
	transformers: 'Transformers',
	wipe: 'Wipe',
	zoom: 'Zoom',
	sapphire: 'Sapphire Transitions',
} as const;

/** Sub-folders of Video Transitions ▸ Sapphire Transitions. */
export const SAPPHIRE_TRANSITION_SUBBINS = {
	dissolves: 'Dissolves',
	wipes: 'Wipes',
	other: 'Other',
} as const;

/** Names of the standard params (their uniforms: `u_startPercent`, `u_endPercent`, `u_reverse`, …). */
export const STANDARD_TRANSITION_PARAMS = [
	'startPercent',
	'endPercent',
	'reverse',
	'borderWidth',
	'borderColor',
	'antiAliasing',
	'center',
] as const;

/** Builders of Premiere's standard transition options (also usable one by one). */
export const trParam = {
	/** Start (%): the progress the transition starts at (Premiere's A slider). Hold-only. */
	start(def = 0): ParamSpec {
		return fxParam.percent('startPercent', 'Start', def, { animatable: false });
	},
	/** End (%): the progress the transition ends at (Premiere's B slider). Hold-only. */
	end(def = 100): ParamSpec {
		return fxParam.percent('endPercent', 'End', def, { animatable: false });
	},
	/** Reverse: plays the transition backwards (see `GpuTransition.reverse`). `u_reverse` (bool). */
	reverse(def = false): ParamSpec {
		return fxParam.toggle('reverse', 'Reverse', def);
	},
	/** Border Width (sequence px). `u_borderWidth`. */
	borderWidth(def = 0): ParamSpec {
		return fxParam.pixels('borderWidth', 'Border Width', def, 100);
	},
	/** Border Color (straight RGBA). `u_borderColor` (vec4). */
	borderColor(def: RGBA = [0, 0, 0, 1]): ParamSpec {
		return fxParam.color('borderColor', 'Border Color', def);
	},
	/** Anti-aliasing Quality (Off / Low / Medium / High) → `u_antiAliasing` (int) → `tr_aaWidth(u_antiAliasing)` px. */
	antiAliasing(def: (typeof TR_AA_OPTIONS)[number] = 'low'): ParamSpec {
		return fxParam.choice('antiAliasing', 'Anti-aliasing Quality', TR_AA_OPTIONS, TR_AA_LABELS, def);
	},
	/** Center: a point normalised to the FRAME ([0,0] top-left … [1,1]); in GLSL `u_center * u_compSize` = px. */
	center(def: Vec2 = [0.5, 0.5]): ParamSpec {
		return fxParam.point('center', 'Center', def);
	},
};

export type ShaderTransitionInit = {
	/** `jasper.<kebab>` (Premiere-standard family) or `jasper.s.<kebab>` (Sapphire-style families). */
	id: string;
	/** Effects-panel name (Premiere: "Push"; Sapphire style: "S_DissolveLuma"). */
	label: string;
	/** Effects-panel folder under Video Transitions: one of `TRANSITION_BINS`. */
	bin: string;
	/** Sub-folder (Sapphire families: one of `SAPPHIRE_TRANSITION_SUBBINS`). */
	subBin?: string;
	description: string;
	keywords?: readonly string[];
	/** The transition's own params, shown after Start / End (fxParam builders; names = letters and digits). */
	params?: readonly ParamSpec[];
	/**
	 * Premiere's optional standard options, appended after the own params in Premiere's order: Border Width + Border
	 * Color (`border`), Reverse (on by default), Anti-aliasing Quality (`antiAliasing`), Center (`center`: true or the
	 * default point). Start / End are always there (first).
	 */
	options?: { border?: boolean; reverse?: boolean; antiAliasing?: boolean; center?: boolean | Vec2 };
	gpu: GpuTransition;
	/** Heavy in the preview (`TransitionSpec.expensive`): marked in Effect Controls like expensive effects. */
	expensive?: boolean;
	version?: number;
	migrate?: TransitionSpec['migrate'];
};

/** The full param list of a shader transition: Start, End, own params, then the requested standard options. */
export function shaderTransitionParams(init: Pick<ShaderTransitionInit, 'params' | 'options'>): ParamSpec[] {
	const o = init.options ?? {};
	return [
		trParam.start(),
		trParam.end(),
		...(init.params ?? []),
		...(o.border ? [trParam.borderWidth(), trParam.borderColor()] : []),
		...(o.reverse === false ? [] : [trParam.reverse()]),
		...(o.antiAliasing ? [trParam.antiAliasing()] : []),
		...(o.center ? [trParam.center(Array.isArray(o.center) ? o.center : undefined)] : []),
	];
}

export function defineShaderTransition(init: ShaderTransitionInit): TransitionSpec {
	return {
		id: init.id,
		version: init.version ?? 1,
		label: init.label,
		appliesTo: 'video',
		description: init.description,
		bin: init.bin,
		...(init.subBin ? { subBin: init.subBin } : {}),
		...(init.keywords ? { keywords: init.keywords } : {}),
		params: shaderTransitionParams(init),
		gpu: init.gpu,
		capabilities: { preview: 'webgl', export: ['remotion'] },
		...(init.expensive ? { expensive: true } : {}),
		...(init.migrate ? { migrate: init.migrate } : {}),
	};
}

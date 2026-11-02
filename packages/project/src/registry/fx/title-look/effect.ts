// `jasper.title-look` (TL-010, TL-030): a look is one internal effect instance. It has no params of its own: what it
// draws is `EffectInstance.appearance`, resolved at the frame and given to the planner through `FxStructures`
// (the Puppet precedent), in the same code for the Player and for Remotion.
import { TITLE_LOOK_EFFECT_ID } from '../../../title-looks/model.ts';
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import {
	appearanceTimeInvariant,
	planTitleLook,
	titleLookPadding,
	titleLookTextures,
	titleLookUniforms,
} from './plan.ts';

/** TL-032: compositing in linear light needs float targets; a look never falls back to 8 bits. */
export const TITLE_LOOK_NEEDS_FLOAT = 'TITLE_LOOK_NEEDS_FLOAT';

export const TITLE_LOOK_EFFECT: EffectSpec = {
	...defineShaderEffect({
		id: TITLE_LOOK_EFFECT_ID,
		label: 'Title Look',
		category: 'Stylize',
		description: 'A look: an ordered stack of layers applied to the clip (Appearance).',
		params: [],
		gpu: {
			passes: (_p, ctx) => planTitleLook(ctx),
			padding: (_p, ctx) => titleLookPadding(ctx),
			uniforms: (_p, ctx) => titleLookUniforms(ctx),
			textures: (_p, ctx) => titleLookTextures(ctx),
			requiresFloat: TITLE_LOOK_NEEDS_FLOAT,
			timeInvariant: (instance) => appearanceTimeInvariant(instance?.appearance),
		},
	}),
	internal: true,
};

// `jasper.title-look` (TL-010, TL-030): a look is one internal effect instance. What it draws is
// `EffectInstance.appearance`, resolved at the frame and given to the planner through `FxStructures` (the Puppet
// precedent), in the same code for the Player and for Remotion. Its one param is the look's Intensity (TL-089): how much
// of the look covers the clip's own picture, a plain effect param, so it keyframes and pastes like any other.
import { TITLE_LOOK_EFFECT_ID, TITLE_LOOK_INTENSITY } from '../../../title-looks/model.ts';
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { lp } from './contract.ts';
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
		params: [lp.percent(TITLE_LOOK_INTENSITY, 'Intensity', 100)],
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

// Spec 19 §8: Title Material, the look finishes as an ordinary effect on any alpha: bevel, chrome, glass, satin. Like
// Pachislop's Material effect it runs the very same shading as a title's face (effects/b/material.ts): here a one-layer look
// over the clip's own picture, planned by `planTitleLook`, so nothing is shaded twice. Sizes are percent of `Size`, in layer
// px, so a logo and a title can share a setting and the material does not breathe as animated text changes its bounds.
import { DEFAULT_PALETTE, TITLE_LOOK_INTENSITY } from '../../../title-looks/model.ts';
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { seedParam } from '../params.ts';
import type { FxPlanContext, ShaderPass } from '../shader.ts';
import { lp, type TitleParamSpec } from './contract.ts';
import { TITLE_LOOK_NEEDS_FLOAT } from './effect.ts';
import { FINISH_BEVEL } from './finishes/bevel.ts';
import { FINISH_GLASS } from './finishes/glass.ts';
import { FINISH_METAL } from './finishes/metal.ts';
import { FINISH_SATIN } from './finishes/satin.ts';
import { type FxTitleLook, planTitleLook, titleLookUniforms } from './plan.ts';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const FINISH_OF: Record<string, string> = { bevel: 'bevel', chrome: 'metal', glass: 'glass', satin: 'satin' };

const group = (ps: readonly TitleParamSpec[], name: string): ParamSpec[] =>
	ps.map((p) => ({ ...(p as ParamSpec), group: name }));

/** The one-layer look of a set of params. */
export function materialLook(
	p: EffectParams,
	ctx: Pick<FxPlanContext, 'pxScale'> & { seed?: number },
): FxTitleLook {
	return {
		appearance: {
			seed: Math.floor(num(ctx.seed, 0) * 4294967296),
			palette: DEFAULT_PALETTE,
			light: { angle: num(p.lightAngle, 225), altitude: num(p.lightAltitude, 45) },
			layers: [
				{
					id: 'material',
					type: 'face',
					params: { ...p, paint: { kind: 'source' }, finish: FINISH_OF[String(p.material)] ?? 'bevel' },
				},
			],
		},
		unitPx: Math.max(1, num(p.size, 200)),
		contentSeconds: 0,
	};
}

const withLook = <T extends FxPlanContext>(p: EffectParams, ctx: T & { seed?: number }): T => ({
	...ctx,
	structures: { ...ctx.structures, titleLook: materialLook(p, ctx) },
});

/** A look's layer values are pass uniforms; here they are this effect's params, which every pass already gets. */
function planMaterial(
	p: EffectParams,
	ctx: FxPlanContext,
	params: ReadonlySet<string>,
): readonly ShaderPass[] {
	return planTitleLook(withLook(p, ctx)).map((pass) => {
		if (!pass.uniforms) return pass;
		const own = Object.entries(pass.uniforms).filter(([k]) => !params.has(k));
		return { ...pass, uniforms: Object.fromEntries(own) };
	});
}

const MATERIAL_PARAMS: ParamSpec[] = [
	lp.choice(
		'material',
		'Material',
		['bevel', 'chrome', 'glass', 'satin'],
		['Bevel', 'Chrome', 'Glass', 'Satin'],
		'bevel',
	),
	lp.pixels('size', 'Size (100 %)', 200, 2000),
	lp.angle('lightAngle', 'Light Angle', 225),
	lp.number('lightAltitude', 'Light Altitude', 45, { min: 0, max: 90, step: 0.1 }, { unit: 'deg' }),
	...group(FINISH_BEVEL.params, 'bevel'),
	...group(FINISH_METAL.params, 'chrome'),
	...group(FINISH_GLASS.params, 'glass'),
	...group(FINISH_SATIN.params, 'satin'),
	seedParam(),
];

const MATERIAL_UNIFORMS = new Set(MATERIAL_PARAMS.map((p) => `u_${p.name}`));

export const TITLE_MATERIAL_EFFECT: EffectSpec = defineShaderEffect({
	id: 'jasper.title-material',
	label: 'Title Material',
	category: 'Stylize',
	description:
		'Bevel, chrome, glass or satin on the shape of any clip: the materials of a title’s face and rims.',
	keywords: ['bevel', 'emboss', 'chrome', 'metal', 'gold', 'glass', 'satin', 'title', 'material'],
	params: MATERIAL_PARAMS,
	gpu: {
		passes: (p, ctx) => planMaterial(p, ctx, MATERIAL_UNIFORMS),
		// The look's output pass mixes by `u_lookIntensity` (TL-089), a param of the look effect only: a material shows in full.
		uniforms: (p, ctx) => ({ ...titleLookUniforms(withLook(p, ctx)), [`u_${TITLE_LOOK_INTENSITY}`]: 100 }),
		requiresFloat: TITLE_LOOK_NEEDS_FLOAT,
		timeInvariant: true,
	},
});

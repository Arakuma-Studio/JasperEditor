// Sapphire Blur+Sharpen — S_RackDfComp: defocuses the clip (Foreground, with its Matte), an optional Middle plate
// (with its own alpha) and a Background plate by independent iris widths, then composites front over middle over
// back — a rack focus between planes of a composite. Plates are `media` params stretched over the layer box; the
// Matte is a media param (Luma/Alpha) or the clip's own alpha. Iris, units and tone as S_RackDefocus.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { fxParam } from '../params.ts';
import type { ShaderPass } from '../shader.ts';
import {
	bool,
	edgeOf,
	GLSL_SBS_COMMON,
	levelFor,
	num,
	px,
	SbsPlan,
	sEdgeMode,
	sNum,
	sSoftBorders,
	unitLayerPx,
} from './common.ts';
import { DEFOCUS_TONE, defocusToneUniforms } from './defocus.ts';
import {
	DEFOCUS_RADIUS_PER_UNIT,
	defocusWidthParam,
	GLSL_SBS_IRIS,
	gatherPass,
	IRIS_SHAPE_VIEW,
	irisFromParams,
	irisLookParams,
	irisShapeParam,
	irisSides,
	lensNoiseParams,
	shapeViewPassParts,
} from './iris.ts';

const MATTE_USE = ['luma', 'alpha'] as const;
const hasMedia = (v: unknown) =>
	typeof (v as { mediaId?: unknown })?.mediaId === 'string' && !!(v as { mediaId: string }).mediaId;

/**
 * A plate prepared for the gather: straight colour × matte (premultiplied), boost + gamma, matte gamma on alpha —
 * rendered directly at the gather's pyramid level (`level`) with a 4×4 supersampled footprint, so three plates need
 * no pyramids (texture budget: 3 media + 2 textures per plate).
 */
function platePrep(
	output: string,
	read: string,
	matte: string,
	level: number,
	color = 'fx_unpremultiply(s).rgb',
): ShaderPass {
	return {
		output,
		include: [GLSL_SBS_COMMON],
		format: 'rgba16f',
		scale: 1 / 2 ** level,
		frag: /* glsl */ `
vec4 plate(vec2 uv) {
  vec2 n = sbs_layerNorm(uv);
  vec4 s = ${read};
  float m = ${matte};
  vec3 c = ${color};
  c = sbs_gammaIn(sbs_boost(c, u_dBoost, u_dThreshold), u_dGamma);
  float a = pow(clamp(m, 0.0, 1.0), u_matteGamma);
  return vec4(c * a, a);
}
void main() {
${
	level === 0
		? '  fragColor = plate(v_uv);'
		: `  vec4 sum = vec4(0.0);
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) sum += plate(v_uv + (vec2(float(i), float(j)) - 1.5) * 0.25 * u_texel);
  fragColor = sum / 16.0;`
}
}`,
	};
}

/** Pyramid level of a plate's gather (same rule as `gatherPass`). */
const plateLevel = (radius: number, rel: number) => levelFor(radius * Math.max(1, rel), 10, 6);

export const S_RACK_DF_COMP = defineShaderEffect({
	id: 'jasper.s.rack-df-comp',
	label: 'S_RackDfComp',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Defocuses the clip (foreground, with its matte), a middle plate and a background plate by separate amounts with a real lens iris, and composites them — rack focus between layers.',
	keywords: ['rack focus', 'defocus', 'composite', 'foreground', 'background', 'bokeh', 'sapphire'],
	expensive: true,
	params: [
		fxParam.media('background', 'Background', ['image', 'video']),
		fxParam.media('matte', 'Matte', ['image', 'video']),
		fxParam.media('middle', 'Middle', ['image', 'video']),
		defocusWidthParam(0.088, 'defocusForeground', 'Defocus Foreground'),
		defocusWidthParam(0, 'defocusBackground', 'Defocus Background'),
		defocusWidthParam(0, 'defocusMiddle', 'Defocus Middle'),
		sNum('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		irisShapeParam(),
		fxParam.toggle('showShape', 'Show Shape', false),
		...irisLookParams(),
		...lensNoiseParams(),
		sNum('useGamma', 'Use Gamma', 1, { min: 0.1, softMax: 4, step: 0.01 }),
		sNum('matteGamma', 'Matte Gamma', 1, { min: 0.1, softMax: 4, step: 0.01 }),
		sNum('boostHighlights', 'Boost Highlights', 0, { min: 0, softMax: 4, step: 0.01 }),
		sNum('hilightThreshold', 'Hilight Threshold', 0.9, { min: 0, softMax: 1, step: 0.01 }),
		fxParam.toggle('compPremult', 'Comp Premult', true),
		fxParam.choice('matteUse', 'Matte Use', MATTE_USE, ['Luma', 'Alpha'], 'alpha'),
		fxParam.toggle('invertMatte', 'Invert Matte', false),
		sEdgeMode('reflect'),
		sSoftBorders(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) =>
			bool(p.softBorders)
				? Math.max(num(p.defocusForeground, 0.088), num(p.defocusBackground), num(p.defocusMiddle)) *
					DEFOCUS_RADIUS_PER_UNIT *
					unitLayerPx(ctx) *
					Math.max(1, num(p.relHeight, 1))
				: 0,
		uniforms: (p) =>
			defocusToneUniforms({
				edge: edgeOf(p),
				chroma: 0,
				mono: false,
				boost: num(p.boostHighlights),
				threshold: num(p.hilightThreshold, 0.9),
				gamma: num(p.useGamma, 1),
				brightness: 1,
				offsetDarks: 0,
			}),
		passes: (p: EffectParams, ctx) => {
			const plan = new SbsPlan(ctx);
			const iris = irisFromParams(p, irisSides(p.shape));
			const rel = Math.max(0.01, num(p.relHeight, 1));
			const plateMatte = /* glsl */ `u_matte_size.x > 0.0 ? (u_matteUse == 1 ? texture(u_matte, clamp(n, 0.0, 1.0)).a : fx_luma(fx_unpremultiply(texture(u_matte, clamp(n, 0.0, 1.0))).rgb) * texture(u_matte, clamp(n, 0.0, 1.0)).a) : (u_matteUse == 1 ? s.a : fx_luma(fx_unpremultiply(s).rgb) * s.a)`;
			const plates: { name: string; radius: number; level: number }[] = [];
			const addPlate = (name: string, radius: number) => {
				const level = plateLevel(radius, rel);
				plates.push({ name, radius, level });
				return level;
			};
			// Foreground: the clip with its matte.
			const fgR = px(ctx, num(p.defocusForeground, 0.088), DEFOCUS_RADIUS_PER_UNIT);
			plan.pass(
				platePrep(
					'fg',
					'sbs_tex(u_source, uv, u_sbsEdge)',
					`u_invertMatte ? 1.0 - (${plateMatte}) : (${plateMatte})`,
					addPlate('fg', fgR),
					// Comp Premult: with a separate Matte the clip's colour is premultiplied by it (divide it out).
					'u_compPremult && u_matte_size.x > 0.0 ? clamp(s.rgb / max(m, 1.0e-4), 0.0, 64.0) : fx_unpremultiply(s).rgb',
				),
			);
			if (hasMedia(p.middle)) {
				const r = px(ctx, num(p.defocusMiddle), DEFOCUS_RADIUS_PER_UNIT);
				plan.pass(
					platePrep(
						'mid',
						'u_middle_size.x > 0.0 ? texture(u_middle, clamp(n, 0.0, 1.0)) : vec4(0.0)',
						's.a',
						addPlate('mid', r),
					),
				);
			}
			if (hasMedia(p.background)) {
				const r = px(ctx, num(p.defocusBackground), DEFOCUS_RADIUS_PER_UNIT);
				plan.pass(
					platePrep(
						'bg',
						'u_background_size.x > 0.0 ? texture(u_background, clamp(n, 0.0, 1.0)) : vec4(0.0)',
						's.a',
						addPlate('bg', r),
					),
				);
			}
			const outs = plates.map(
				(pl) =>
					gatherPass(plan, {
						input: pl.name,
						output: `${pl.name}D`,
						radiusX: pl.radius,
						radiusY: pl.radius * rel,
						iris,
						edge: edgeOf(p),
						inputLevel: pl.level,
					}).output,
			);
			const shape = bool(p.showShape) ? shapeViewPassParts(iris) : null;
			const over = outs
				.slice(1)
				.map(
					(o) =>
						`  { vec4 b = sbs_defocusTone(texture(u_${o}, v_uv)); acc += vec4(b.rgb * b.a, b.a) * (1.0 - acc.a); }`,
				)
				.join('\n');
			plan.pass({
				include: shape ? [shape.defines, GLSL_SBS_IRIS] : [GLSL_SBS_COMMON],
				uniforms: { ...(shape?.uniforms ?? {}), u_shapeRel: rel },
				frag: /* glsl */ `${DEFOCUS_TONE}
${shape ? IRIS_SHAPE_VIEW : ''}
void main() {
${shape ? '  fragColor = sbs_shapeView(u_shapeRel, 0.8); return;' : ''}
  vec4 f = sbs_defocusTone(texture(u_${outs[0]}, v_uv));
  vec4 acc = vec4(f.rgb * f.a, f.a);
${over}
  if (!sbs_keep(v_uv, u_sbsEdge)) acc = vec4(0.0);
  fragColor = acc;
}`,
			});
			return plan.passes;
		},
	},
});

export const SBS_COMP: readonly EffectSpec[] = [S_RACK_DF_COMP];

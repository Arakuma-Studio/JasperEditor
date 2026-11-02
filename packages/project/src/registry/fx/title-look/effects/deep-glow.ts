// Deep Glow (spec 19 §8): the picture becomes a light source. The same scatter and over-exposure response as the look
// layer (`../deep-glow.ts`), with its own passes rather than a look: it needs no shape field, and on footage that field
// would be a quarter of its cost.
import type { RGBA } from '../../../../schema/common.ts';
import type { EffectParams } from '../../../effects.ts';
import { defineShaderEffect } from '../../define.ts';
import { fxParam } from '../../params.ts';
import type { FxPlanContext, ShaderPass } from '../../shader.ts';
import { deepGlowPasses, dgReach, GLSL_TL_DEEP_GLOW } from '../deep-glow.ts';
import { GLSL_TL_UNIT_KNOWN } from '../glsl.ts';
import { LOOK_EFFECT_UNIT } from '../look-effect.ts';
import { linearPremultiplied } from '../paint.ts';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Largest radius: its reach at full scatter stays inside `FX_MAX_PADDING`. */
const MAX_RADIUS = 1700;
/** Padding guard around the reach, layer px: an antialiased edge and a sampled tail. */
const GUARD = 4;
/** Frames of a clip sampled for its padding; the current frame always counts. */
const REACH_SAMPLES = 32;

const linear = (v: unknown, d: RGBA): [number, number, number] => {
	const c = linearPremultiplied(Array.isArray(v) && v.length === 4 ? ([v[0], v[1], v[2], 1] as RGBA) : d);
	return [c[0], c[1], c[2]];
};

const FRAG_EMIT = /* glsl */ `
void main() {
  vec4 L = tl_inputLinear(v_uv);
  vec3 e = L.rgb * dg_emitFraction(L) * pow(2.0, u_exposure);
  if (u_colorMode == 1) {
    vec3 t = tl_linear(u_color.rgb);
    e = max(e.r, max(e.g, e.b)) * t / max(max(t.r, max(t.g, t.b)), 1.0e-4);
  }
  fragColor = vec4(e, 0.0);
}`;

const FRAG_COMPOSE = /* glsl */ `
void main() {
  fragColor = tl_encode(dg_result(tl_inputLinear(v_uv), texture(u_tlDgAcc, v_uv).rgb, true));
}`;

function reachAt(p: EffectParams): number {
	return dgReach(Math.min(MAX_RADIUS, num(p.radius)), num(p.chroma));
}

/** TL-033: the reach across the clip, so the canvas keeps its size while Radius animates; this frame always counts. */
function padding(p: EffectParams, ctx: FxPlanContext): number {
	let r = reachAt(p);
	const n = ctx.clip?.duration ?? 0;
	if (ctx.paramsAt && n > 1)
		for (let i = 0; i < REACH_SAMPLES; i++)
			r = Math.max(r, reachAt(ctx.paramsAt(Math.round((i * (n - 1)) / (REACH_SAMPLES - 1)))));
	return r > 0 ? Math.ceil(r) + GUARD : 0;
}

export const DEEP_GLOW = defineShaderEffect({
	id: 'jasper.deep-glow',
	label: 'Deep Glow',
	category: 'Stylize',
	description:
		'Physically scaled light: the picture becomes a light source whose light scatters like lens bloom and burns towards white where it is over-bright. Exposure brightens the light, Threshold keeps its brightest part, Radius and Falloff shape the halo without changing how much light there is.',
	keywords: ['glow', 'bloom', 'light', 'halo', 'neon', 'exposure', 'title'],
	expensive: true,
	params: [
		fxParam.number('exposure', 'Exposure', 1, { min: -10, max: 10, softMin: -4, softMax: 6, step: 0.01 }),
		fxParam.number('threshold', 'Threshold', 0, { min: 0, max: 10, softMax: 2, step: 0.01 }),
		fxParam.number('knee', 'Threshold Knee', 0.25, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('radius', 'Radius', 200, { min: 0, max: MAX_RADIUS, softMax: 1000, step: 0.1 }, { unit: 'px' }),
		fxParam.percent('falloff', 'Falloff', 50),
		fxParam.number('intensity', 'Intensity', 1, { min: 0, max: 100, softMax: 8, step: 0.01 }),
		fxParam.number('chroma', 'Chromatic Scatter', 0, { min: -100, max: 100, step: 1 }, { unit: '%' }),
		fxParam.choice('colorMode', 'Glow Color', ['layer', 'custom'], ['From Layer', 'Custom'], 'layer'),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.percent('tintAmount', 'Tint Amount', 0),
		fxParam.color('tintInner', 'Tint Inner', [1, 1, 1, 1]),
		fxParam.color('tintOuter', 'Tint Outer', [1, 0.54, 0.16, 1]),
		fxParam.percent('highlightShift', 'Highlight Shift', 60),
		fxParam.percent('coreWhite', 'Core Whiteness', 20),
		fxParam.percent('onFace', 'Glow Over Picture', 100),
	],
	gpu: {
		timeInvariant: true,
		requiresFloat: true,
		padding,
		uniforms: (_p, ctx) => ({ u_tlUnit: LOOK_EFFECT_UNIT * ctx.pxScale }),
		passes: (p, ctx) => {
			const inner = linear(p.tintInner, [1, 1, 1, 1]);
			const outer = linear(p.tintOuter, [1, 0.54, 0.16, 1]);
			const passes: ShaderPass[] = [
				{ output: 'tlDgPyr', format: 'rgba16f', include: [GLSL_TL_DEEP_GLOW], frag: FRAG_EMIT },
				...deepGlowPasses({
					radius: Math.min(MAX_RADIUS, num(p.radius)),
					falloff: num(p.falloff),
					chroma: num(p.chroma),
					intensity: num(p.intensity),
					tintAmount: Math.min(1, Math.max(0, num(p.tintAmount) / 100)),
					tintAt: (t) => [0, 1, 2].map((k) => inner[k]! + (outer[k]! - inner[k]!) * t) as [number, number, number],
					pxPerPercent: ctx.pxScale,
					unitKnown: true,
					unit: GLSL_TL_UNIT_KNOWN,
					again: false,
				}),
				{ include: [GLSL_TL_DEEP_GLOW], frag: FRAG_COMPOSE },
			];
			return passes;
		},
	},
});

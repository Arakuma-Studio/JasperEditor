// "Sapphire other stylize" family — S_ZFogExponential and S_ZFogLinear: a fog colour mixed into the picture by depth
// from a ZBuffer input (Z Buffer Type: White/Black is Near; Z Buffer Use: Luma/Alpha), as in Boris FX's public Sapphire
// documentation. The ZBuffer is a `media` param (a depth pass/matte of the project, stretched over the layer box).
//
// Without a ZBuffer, Sapphire's input is solid black (the effect then does nothing useful). Here "Depth Fallback"
// chooses what stands in for it: a vertical gradient (default: top of the layer far, bottom near — a horizon fog),
// the source's own luminance/alpha read through Z Buffer Type/Use, or Sapphire's literal black.
import type { EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam, mixWithOriginalParam, showParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import { sNum } from './common.ts';

export const ZFOG_FALLBACKS = ['verticalGradient', 'sourceLuma', 'black'] as const;

const zParams = (): ParamSpec[] => [
	fxParam.choice(
		'zBufferType',
		'Z Buffer Type',
		['blackIsNear', 'whiteIsNear'],
		['Black is Near', 'White is Near'],
		'whiteIsNear',
	),
	fxParam.choice('zBufferUse', 'Z Buffer Use', ['luma', 'alpha'], ['Luma', 'Alpha'], 'luma'),
	fxParam.media('zBuffer', 'ZBuffer'),
	fxParam.choice(
		'depthFallback',
		'Depth Fallback',
		ZFOG_FALLBACKS,
		['Vertical Gradient (top far)', 'Source Luma', 'Black (Sapphire)'],
		'verticalGradient',
	),
	showParam([{ value: 'depth', label: 'Depth' }]),
	mixWithOriginalParam(),
];

/** `zf_far()`: 0 = near … 1 = far at this pixel, from the ZBuffer or the fallback. */
const GLSL_ZFOG: GlslChunk = {
	name: 'sapphire-stylize-other/zfog',
	deps: [GLSL_COMPOSITE],
	source: /* glsl */ `
float zf_value(vec4 premult) {
  return u_zBufferUse == 1 ? premult.a : fx_luma(fx_unpremultiply(premult).rgb) * premult.a;
}
float zf_far() {
  vec2 n = clamp(fx_layerNorm(), vec2(0.0), vec2(1.0));
  float z;
  if (u_zBuffer_size.x > 0.0) z = zf_value(texture(u_zBuffer, n));
  else if (u_depthFallback == 0) return clamp(1.0 - n.y, 0.0, 1.0);
  else if (u_depthFallback == 1) z = zf_value(texture(u_source, v_uv));
  else z = 0.0;
  // z is the buffer value: White is Near → white = near (far = 1 − z); Black is Near → far = z.
  return u_zBufferType == 1 ? 1.0 - z : z;
}
vec4 zf_apply(float fog) {
  vec4 src = texture(u_source, v_uv);
  vec4 fogged = vec4(mix(fx_unpremultiply(src).rgb, u_fogColor.rgb, clamp(fog, 0.0, 1.0)) * src.a, src.a);
  if (u_show == 2) return fx_matteView(zf_far());
  return fx_finish(fogged, src, fog, u_mixWithOriginal, u_show);
}
`,
};

export const S_ZFOG_EXPONENTIAL: EffectSpec = defineShaderEffect({
	id: 'jasper.s.z-fog-exponential',
	label: 'S_ZFogExponential',
	category: 'Stylize',
	bin: SAPPHIRE_BINS.stylize,
	description:
		'Mixes a fog colour into the picture by depth from a ZBuffer: the fog grows exponentially with distance (Fog Density = the fog at the far plane). Without a ZBuffer, Depth Fallback stands in (vertical gradient by default).',
	keywords: ['fog', 'depth', 'z depth', 'zbuffer', 'haze', 'mist', 'atmosphere'],
	params: [
		sNum('fogDensity', 'Fog Density', 0.7, { min: 0, max: 1 }),
		fxParam.color('fogColor', 'Fog Color', [0.5, 0.5, 0.5, 1]),
		...zParams(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_ZFOG],
				frag: /* glsl */ `
void main() {
  // Exponential fog: 0 at the near plane, rising as 1 − (1 − density)^far, = Fog Density at the far plane.
  float far = zf_far();
  float d = clamp(u_fogDensity, 0.0, 1.0);
  float fog = d >= 1.0 ? step(1.0e-4, far) : 1.0 - pow(1.0 - d, far);
  fragColor = zf_apply(fog);
}`,
			},
		],
	},
});

export const S_ZFOG_LINEAR: EffectSpec = defineShaderEffect({
	id: 'jasper.s.z-fog-linear',
	label: 'S_ZFogLinear',
	category: 'Stylize',
	bin: SAPPHIRE_BINS.stylize,
	description:
		'Mixes a fog colour into the picture by depth from a ZBuffer: the fog varies linearly from Fog Near to Fog Far. Without a ZBuffer, Depth Fallback stands in (vertical gradient by default).',
	keywords: ['fog', 'depth', 'z depth', 'zbuffer', 'haze', 'mist', 'atmosphere'],
	params: [
		sNum('fogNear', 'Fog Near', 0, { min: 0, max: 1 }),
		sNum('fogFar', 'Fog Far', 0.8, { min: 0, max: 1 }),
		fxParam.color('fogColor', 'Fog Color', [0.5, 0.5, 0.5, 1]),
		...zParams(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_ZFOG],
				frag: /* glsl */ `
void main() {
  fragColor = zf_apply(mix(u_fogNear, u_fogFar, zf_far()));
}`,
			},
		],
	},
});

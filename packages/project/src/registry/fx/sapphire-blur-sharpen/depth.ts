// Sapphire Blur+Sharpen — depth layering shared by S_ZDefocus, S_ZBlur and S_ZConvolve. The ZBuffer input is a
// `media` param stretched over the layer box (luma or alpha; White/Black is Near). The amount of defocus at depth z
// (0 near … 1 far) is max(0, |z − Focal Depth| − Depth Of Field / 2) × Width Rel Near/Far. Like Sapphire, the picture
// is split into "Layers":
// - Interp: the whole picture is defocused at K evenly spaced amounts and every pixel interpolates between the two
//   levels around its own amount (smooth, fast);
// - Comp: K depth slices (tent partition of unity in z) are defocused separately — each slice gathers only its own
//   pixels (`sbs_sliceW`) — and composited far to near, so blurred near objects spill over the sharp background.
// K is clamped to 6 (texture budget of an effect: 12 intermediates).
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { fxParam } from '../params.ts';
import type { FxUniformValue, GlslChunk } from '../shader.ts';
import { choiceIndex, clamp, GLSL_SBS_COMMON, num, sColor, sNum, sUnit } from './common.ts';

export const Z_MAX_LAYERS = 6;
const LAYER_MODES = ['comp', 'interp'] as const;
const ZB_TYPES = ['blackIsNear', 'whiteIsNear'] as const;
const ZB_USE = ['luma', 'alpha'] as const;

export const zBufferParam = () => fxParam.media('zBuffer', 'ZBuffer', ['image', 'video']);
export const zFocusParams = (): ParamSpec[] => [
	sNum('focalDepth', 'Focal Depth', 0, { softMin: 0, softMax: 1, step: 0.001 }),
	fxParam.number('depthOfField', 'Depth Of Field', 0.1, { min: 0, max: 1, step: 0.001 }, { ui: { control: 'slider' } }),
];
export const zTypeParam = () =>
	fxParam.choice('zbufferType', 'Zbuffer Type', ZB_TYPES, ['Black is Near', 'White is Near'], 'whiteIsNear');
export const zLayerParams = (): ParamSpec[] => [
	sNum('layers', 'Layers', 5, { min: 2, max: 50, step: 1, int: true }),
	fxParam.choice('layerMode', 'Layer Mode', LAYER_MODES, ['Comp', 'Interp'], 'interp'),
];
export const zRelParams = (label = 'Width'): ParamSpec[] => [
	sNum('widthRelNear', `${label} Rel Near`, 1, { min: 0, softMax: 4, step: 0.01 }),
	sNum('widthRelFar', `${label} Rel Far`, 1, { min: 0, softMax: 4, step: 0.01 }),
];
export const zFogParams = (): ParamSpec[] => [
	sUnit('fogNear', 'Fog Near', 0),
	sUnit('fogFar', 'Fog Far', 0),
	sColor('fogColor', 'Fog Color', [0.5, 0.5, 0.5]),
];
export const zUseParam = () => fxParam.choice('zbufferUse', 'Zbuffer Use', ZB_USE, ['Luma', 'Alpha'], 'luma');

/** Largest defocus amount over depths 0…1 (for the level spacing). */
export function zMaxAmount(p: EffectParams): number {
	const f = clamp(num(p.focalDepth), 0, 1);
	const h = num(p.depthOfField, 0.1) / 2;
	return Math.max(
		Math.max(0, num(p.widthRelNear, 1)) * Math.max(0, f - h),
		Math.max(0, num(p.widthRelFar, 1)) * Math.max(0, 1 - f - h),
	);
}
export const zLayerCount = (p: EffectParams) => clamp(Math.round(num(p.layers, 5)), 2, Z_MAX_LAYERS);
export const zIsComp = (p: EffectParams) => choiceIndex(p.layerMode, LAYER_MODES, 'interp') === 0;

/** Depth, defocus amount and slice membership (uses the Z params' uniforms and the pass uniform u_slice). */
export const GLSL_SBS_DEPTH: GlslChunk = {
	name: 'sapphire-blur-sharpen/depth',
	deps: [GLSL_SBS_COMMON],
	source: /* glsl */ `
// Depth 0 (near) … 1 (far) at canvas uv; without a ZBuffer everything sits at the focal depth (in focus).
float sbs_depth(vec2 uv) {
  if (u_zBuffer_size.x <= 0.0) return clamp(u_focalDepth, 0.0, 1.0);
  vec4 d = texture(u_zBuffer, clamp(sbs_layerNorm(uv), 0.0, 1.0));
  float v = u_zbufferUse == 1 ? d.a : fx_luma(fx_unpremultiply(d).rgb) * d.a;
  return u_zbufferType == 1 ? 1.0 - v : v;
}
float sbs_zAmount(float z) {
  float d = z - u_focalDepth;
  float a = max(0.0, abs(d) - 0.5 * u_depthOfField);
  return a * (d < 0.0 ? u_widthRelNear : u_widthRelFar);
}
#ifdef SBS_SLICE
float sbs_sliceW(vec2 uv) { return max(0.0, 1.0 - abs(sbs_depth(uv) - u_slice.x) / u_slice.y); }
#endif
// Fog by depth.
vec3 sbs_fog(vec3 c, float z) { return mix(c, u_fogColor.rgb, clamp(mix(u_fogNear, u_fogFar, z), 0.0, 1.0)); }
// Show: In Focus Zone — in-focus pixels keep their colour, the rest is darkened and tinted.
vec4 sbs_focusZone(vec4 srcPremul, float amount) {
  vec4 s = fx_unpremultiply(srcPremul);
  float inFocus = 1.0 - smoothstep(0.0, 0.02, amount);
  vec3 c = mix(fx_luma(s.rgb) * vec3(0.35, 0.3, 0.45), mix(s.rgb, vec3(0.2, 1.0, 0.3), 0.35), inFocus);
  return vec4(c * s.a, s.a);
}
`,
};

/** A layer's gather: `scale01` of the maximum radius; `slice` = (centre z, half width) in Comp mode. */
export type ZGather = (o: {
	output: string;
	scale01: number;
	slice: [number, number] | null;
}) => void;

/**
 * Plans the layer gathers and returns a GLSL function `vec4 sbs_zLayered(vec2 uv)` that reconstructs the layered
 * (still gamma-space, premultiplied) result from them and the prepared picture `prep`.
 */
export function zLayers(p: EffectParams, prep: string, gather: ZGather): { glsl: string; uniforms: Record<string, FxUniformValue> } {
	const k = zLayerCount(p);
	const amax = zMaxAmount(p);
	if (zIsComp(p)) {
		const names: string[] = [];
		for (let i = 0; i < k; i++) {
			const z = i / (k - 1);
			const d = z - clamp(num(p.focalDepth), 0, 1);
			const a = Math.max(0, Math.abs(d) - num(p.depthOfField, 0.1) / 2) * (d < 0 ? num(p.widthRelNear, 1) : num(p.widthRelFar, 1));
			const name = `zs${i}`;
			gather({ output: name, scale01: amax > 0 ? a / amax : 0, slice: [z, 1 / (k - 1)] });
			names.push(name);
		}
		const lines = names
			.slice()
			.reverse()
			.map((n, j) => (j === 0 ? `  vec4 acc = texture(u_${n}, uv);` : `  { vec4 s = texture(u_${n}, uv); acc = s + acc * (1.0 - s.a); }`));
		return {
			glsl: /* glsl */ `
vec4 sbs_zLayered(vec2 uv) {
${lines.join('\n')}
  float a = texture(u_${prep}, uv).a;
  return acc.a > 1.0e-4 ? acc * (a / acc.a) : texture(u_${prep}, uv);
}`,
			uniforms: { u_zAmax: amax },
		};
	}
	const names = [prep];
	for (let i = 1; i < k; i++) {
		const name = `zl${i}`;
		gather({ output: name, scale01: i / (k - 1), slice: null });
		names.push(name);
	}
	const branches = names
		.slice(1)
		.map((n, j) => `  if (t <= ${(j + 1).toFixed(1)}) return mix(texture(u_${names[j]}, uv), texture(u_${n}, uv), t - ${j.toFixed(1)});`)
		.join('\n');
	return {
		glsl: /* glsl */ `
vec4 sbs_zLayered(vec2 uv) {
  float t = u_zAmax > 0.0 ? clamp(sbs_zAmount(sbs_depth(uv)) / u_zAmax, 0.0, 1.0) * ${(k - 1).toFixed(1)} : 0.0;
${branches}
  return texture(u_${names[names.length - 1]}, uv);
}`,
		uniforms: { u_zAmax: amax },
	};
}

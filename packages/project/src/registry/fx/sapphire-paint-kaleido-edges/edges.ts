// Sapphire Edges (Stylize): S_EdgeDetect, S_EdgeDetectDouble, S_EdgesInDirection, S_EdgeColorize. A Gaussian
// pre-smooth (Edge Smooth, in Sapphire units = 1 % of the layer width) followed by per-channel Sobel gradients.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam, mixWithOriginalParam } from '../params.ts';
import type { FxPlanContext } from '../shader.ts';
import { blurPasses, PKE_COMMON, PKE_SOBEL, rgbParam, sNum, sUnitsPx, xyParam } from './common.ts';

/** Pre-smoothing sigma in canvas px (Subpixel Smooth off → whole pixels, like Sapphire). */
function edgeSmoothSigma(p: EffectParams, name: string, ctx: Pick<FxPlanContext, 'width' | 'pxScale'>) {
	const s = sUnitsPx(p[name], ctx);
	return p.subpixelSmooth === false ? Math.round(s) : s;
}

/**
 * Gain of the Sobel edges: a half-contrast step reads as a full-brightness edge, and smoothed pictures keep about the
 * brightness of unsmoothed ones (a blurred step has a lower slope): constant below one pixel, growing like the blur
 * width above.
 */
function edgeGain(sigma: number): number {
	return 2 * Math.sqrt(1 + (1.5 * Math.max(0, sigma)) ** 2);
}

const edgeSmoothParam = (def: number, name = 'edgeSmooth', label = 'Edge Smooth') =>
	sNum(name, label, def, { min: 0, softMax: 1 });
const subpixelParam = () => fxParam.toggle('subpixelSmooth', 'Subpixel Smooth', true);
const brightnessParam = (def = 1, name = 'brightness', label = 'Brightness') =>
	sNum(name, label, def, { min: 0, softMax: 10, step: 0.01 });
const saturationParam = (min = -2) => sNum('saturation', 'Saturation', 1, { min, max: 10, step: 0.01 });

const bin = SAPPHIRE_BINS.stylize;

export const S_EDGE_DETECT = defineShaderEffect({
	id: 'jasper.s.edge-detect',
	label: 'S_EdgeDetect',
	category: 'Stylize',
	bin,
	description:
		'Finds the edges within the source: coloured edge lines on black. Increase Edge Smooth for thicker edges; weight the channels for luma- or chroma-only edges.',
	keywords: ['edges', 'outline', 'sobel', 'find edges', 'sapphire'],
	params: [
		edgeSmoothParam(0.0224),
		subpixelParam(),
		brightnessParam(),
		saturationParam(),
		sNum('threshold', 'Threshold', 0, { min: 0, softMax: 1 }),
		sNum('weightRed', 'Weight Red', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('weightGreen', 'Weight Green', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('weightBlue', 'Weight Blue', 1, { min: 0, softMax: 4, step: 0.01 }),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_edgeGain: edgeGain(edgeSmoothSigma(p, 'edgeSmooth', ctx)) }),
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth', edgeSmoothSigma(p, 'edgeSmooth', ctx)),
			{
				include: [PKE_SOBEL, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 gx, gy;
  pke_sobelRgb(u_smooth, v_uv, u_texel, gx, gy);
  vec3 e = sqrt(gx * gx + gy * gy) * u_edgeGain * vec3(u_weightRed, u_weightGreen, u_weightBlue) * u_brightness;
  e = max(fx_saturate(max(e - u_threshold, 0.0), u_saturation), 0.0);
  e = min(e, vec3(1.0));
  float a = max(src.a, max(e.r, max(e.g, e.b)));
  fragColor = fx_mixOriginal(vec4(e, a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_EDGE_DETECT_DOUBLE = defineShaderEffect({
	id: 'jasper.s.edge-detect-double',
	label: 'S_EdgeDetectDouble',
	category: 'Stylize',
	bin,
	description:
		'Runs an edge detect twice for a double-stranded edge look (the edges of the edges). Show Edges1 Only to tune the first pass.',
	keywords: ['edges', 'outline', 'double', 'neon', 'sapphire'],
	params: [
		edgeSmoothParam(0.088, 'edgeSmooth1', 'Edge Smooth1'),
		edgeSmoothParam(0, 'edgeSmooth2', 'Edge Smooth2'),
		subpixelParam(),
		brightnessParam(1, 'brightness1', 'Brightness1'),
		brightnessParam(1.5, 'brightness2', 'Brightness2'),
		sNum('saturation', 'Saturation', 1, { min: 0, softMax: 10, step: 0.01 }),
		sNum('threshold1', 'Threshold1', 0, { min: 0, softMax: 1 }),
		sNum('threshold2', 'Threshold2', 0, { min: 0, softMax: 1 }),
		fxParam.choice('show', 'Show', ['result', 'edges1'], ['Result', 'Edges1 Only'], 'result'),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({
			u_edgeGain1: edgeGain(edgeSmoothSigma(p, 'edgeSmooth1', ctx)),
			u_edgeGain2: edgeGain(edgeSmoothSigma(p, 'edgeSmooth2', ctx)),
		}),
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth1', edgeSmoothSigma(p, 'edgeSmooth1', ctx)),
			{
				output: 'edges1',
				include: [PKE_SOBEL],
				frag: /* glsl */ `
void main() {
  vec3 gx, gy;
  pke_sobelRgb(u_smooth1, v_uv, u_texel, gx, gy);
  vec3 e = max(sqrt(gx * gx + gy * gy) * u_edgeGain1 * u_brightness1 - u_threshold1, 0.0);
  fragColor = vec4(min(e, vec3(1.0)), 1.0);
}`,
			},
			...blurPasses('edges1', 'smooth2', edgeSmoothSigma(p, 'edgeSmooth2', ctx)),
			{
				include: [PKE_SOBEL, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 e;
  if (u_show == 1) {
    e = texture(u_edges1, v_uv).rgb;
  } else {
    vec3 gx, gy;
    pke_sobelRgb(u_smooth2, v_uv, u_texel, gx, gy);
    e = max(sqrt(gx * gx + gy * gy) * u_edgeGain2 * u_brightness2 - u_threshold2, 0.0);
  }
  e = min(max(fx_saturate(e, u_saturation), 0.0), vec3(1.0));
  float a = max(src.a, max(e.r, max(e.g, e.b)));
  fragColor = fx_mixOriginal(vec4(e, a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_EDGES_IN_DIRECTION = defineShaderEffect({
	id: 'jasper.s.edges-in-direction',
	label: 'S_EdgesInDirection',
	category: 'Stylize',
	bin,
	description:
		'Finds only the edges facing a direction (an embossed, side-lit edge look). Direction is a y-up vector; Bidirectional keeps both sides.',
	keywords: ['edges', 'directional', 'emboss', 'relief', 'sapphire'],
	params: [
		edgeSmoothParam(0.0224),
		subpixelParam(),
		brightnessParam(),
		saturationParam(),
		rgbParam('offsetColor', 'Offset Color', [0, 0, 0]),
		xyParam('direction', 'Direction', [0.389, 0.361]),
		fxParam.toggle('bidirectional', 'Bidirectional', false),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_edgeGain: edgeGain(edgeSmoothSigma(p, 'edgeSmooth', ctx)) }),
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth', edgeSmoothSigma(p, 'edgeSmooth', ctx)),
			{
				include: [PKE_SOBEL, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 gx, gy;
  pke_sobelRgb(u_smooth, v_uv, u_texel, gx, gy);
  vec2 d = vec2(u_direction.x, -u_direction.y);
  d = dot(d, d) > 1.0e-12 ? normalize(d) : vec2(1.0, 0.0);
  vec3 e = (gx * d.x + gy * d.y) * u_edgeGain;
  e = u_bidirectional ? abs(e) : max(e, 0.0);
  e = e * u_brightness + u_offsetColor.rgb;
  e = min(max(fx_saturate(e, u_saturation), 0.0), vec3(1.0));
  float a = max(src.a, max(e.r, max(e.g, e.b)));
  fragColor = fx_mixOriginal(vec4(e, a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_EDGE_COLORIZE = defineShaderEffect({
	id: 'jasper.s.edge-colorize',
	label: 'S_EdgeColorize',
	category: 'Stylize',
	bin,
	description:
		'Colours the edges by the direction they face (Top, Right, Bottom, Left colours over a Background colour).',
	keywords: ['edges', 'colorize', 'outline', 'direction', 'sapphire'],
	params: [
		edgeSmoothParam(0.0224),
		subpixelParam(),
		brightnessParam(),
		fxParam.angle('rotateColors', 'Rotate Colors', 0),
		rgbParam('background', 'Background', [0, 0, 0]),
		rgbParam('top', 'Top', [1, 0.85, 0.5]),
		rgbParam('right', 'Right', [0, 0.1, 0.5]),
		rgbParam('bottom', 'Bottom', [0.3, 0.3, 0.3]),
		rgbParam('left', 'Left', [0.5, 0, 0]),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_edgeGain: edgeGain(edgeSmoothSigma(p, 'edgeSmooth', ctx)) }),
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth', edgeSmoothSigma(p, 'edgeSmooth', ctx)),
			{
				include: [PKE_SOBEL, PKE_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
vec3 edgeColor(float deg) {
  // 0° = right, 90° = top, 180° = left, 270° = bottom (y up), interpolated between neighbours.
  float a = mod(deg, 360.0) / 90.0;
  float k = floor(a);
  float f = a - k;
  vec3 c0 = k < 0.5 ? u_right.rgb : k < 1.5 ? u_top.rgb : k < 2.5 ? u_left.rgb : u_bottom.rgb;
  vec3 c1 = k < 0.5 ? u_top.rgb : k < 1.5 ? u_left.rgb : k < 2.5 ? u_bottom.rgb : u_right.rgb;
  return mix(c0, c1, f);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 gx, gy;
  pke_sobelRgb(u_smooth, v_uv, u_texel, gx, gy);
  vec2 g = vec2(dot(gx, vec3(1.0)), dot(gy, vec3(1.0))) / 3.0;
  float m = sqrt(dot(gx, gx) + dot(gy, gy)) * u_edgeGain;
  // An edge faces from the bright side to the dark side: −gradient, converted to y-up for the angle.
  vec2 face = -vec2(g.x, -g.y);
  float deg = degrees(atan(face.y, face.x)) - u_rotateColors;
  float k = clamp(m, 0.0, 1.0);
  vec3 c = mix(u_background.rgb, edgeColor(deg) * u_brightness, k);
  float a = max(src.a, k);
  fragColor = fx_mixOriginal(vec4(clamp(c, 0.0, 1.0) * a, a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const EDGES_EFFECTS: readonly EffectSpec[] = [
	S_EDGE_DETECT,
	S_EDGE_DETECT_DOUBLE,
	S_EDGES_IN_DIRECTION,
	S_EDGE_COLORIZE,
];

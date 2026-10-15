// Sapphire-style blurring dissolves: S_DissolveBlur (the outgoing clip blurs away while the incoming one sharpens
// in; Box / Triangle / Gauss filters) and S_DissolveDefocus (the same with a lens defocus: iris shapes, bokeh,
// highlight boost). Parameters follow Boris FX's public Sapphire documentation; clean-room implementations.
//
// Both blur the two sides separately at a reduced resolution chosen from the largest blur the params can reach
// (σ / radius ≤ ~16 texels), so the preview stays interactive; the final pass upsamples bicubically and fades back to
// the sharp side where the blur is small (exactly the sharp side at the ends of the transition).
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { fxParam } from '../../fx/params.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import {
	blurPasses,
	blurPx,
	check,
	clamp,
	defineDissolve,
	dissolveTiming,
	GLSL_SD,
	num,
	seed,
	slider,
	vec2,
} from './common.ts';

/** Timing t (re-timed eased progress) of a frame — the value behind `u_sdT`. */
const timingT = (p: EffectParams, progress: number): number => dissolveTiming(p, progress).t;

/** Pass resolution for blurs reaching `maxPx` frame px: a power of two keeping them ≤ `target` texels. */
function blurScale(maxPx: number, target = 16): number {
	if (!(maxPx > target)) return 1;
	const s = 2 ** Math.floor(Math.log2(target / maxPx));
	return clamp(s, 0.125, 1);
}

export const BLUR_FILTERS = ['box', 'triangle', 'gauss'] as const;

/** σ (frame px, x / y) of each side at timing t: A blurs in as it fades out, B sharpens as it fades in. */
function dissolveBlurSigmas(p: EffectParams, t: number, width: number) {
	const base = blurPx(p.blurAmount ?? 2, width);
	const rel = vec2(p.blurRel, [1, 1]);
	const a = base * clamp(t, 0, 1) * Math.max(0, num(p.blurRelFrom, 1));
	const b = base * (1 - clamp(t, 0, 1)) * Math.max(0, num(p.blurRelTo, 1));
	return {
		from: [a * Math.max(0, rel[0]), a * Math.max(0, rel[1])] as [number, number],
		to: [b * Math.max(0, rel[0]), b * Math.max(0, rel[1])] as [number, number],
		max: base * Math.max(0, rel[0], rel[1]) * Math.max(0, num(p.blurRelFrom, 1), num(p.blurRelTo, 1)),
	};
}

export const S_DISSOLVE_BLUR: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-blur',
	label: 'S_DissolveBlur',
	description:
		'The outgoing clip is blurred and faded out while the incoming clip fades in from blurred to sharp (Box, Triangle or Gauss filter; separate horizontal / vertical widths).',
	keywords: ['blur', 'dissolve', 'soft', 'focus', 'smear'],
	timing: {},
	params: [
		slider('blurAmount', 'Blur Amount', 2, { min: 0, softMax: 10 }),
		fxParam.vec2('blurRel', 'Blur Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		slider('blurRelFrom', 'Blur Rel From', 1, { min: 0, softMax: 4 }),
		slider('blurRelTo', 'Blur Rel To', 1, { min: 0, softMax: 4 }),
		fxParam.choice('blurFilter', 'Blur Filter', BLUR_FILTERS, ['Box', 'Triangle', 'Gauss'], 'gauss'),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const s = dissolveBlurSigmas(p, timingT(p, ctx.progress), ctx.width);
			return { u_sigFrom: s.from, u_sigTo: s.to };
		},
		passes: (p, ctx): ShaderPass[] => {
			const scale = blurScale(dissolveBlurSigmas(p, 1, ctx.width).max);
			const kernel = 'u_blurFilter';
			return [
				...blurPasses({ input: 'from', output: 'bFrom', scale, sigma: 'u_sigFrom', kernel }),
				...blurPasses({ input: 'to', output: 'bTo', scale, sigma: 'u_sigTo', kernel }),
				{
					include: [GLSL_SD],
					frag: /* glsl */ `
vec4 side(vec4 sharp, sampler2D blurred, vec2 sigma) {
  float px = max(sigma.x, sigma.y);
  float k = clamp(px * ${scale.toFixed(4)} / 1.5, 0.0, 1.0);
  return k <= 0.0 ? sharp : mix(sharp, sd_bicubic(blurred, v_uv), k);
}
void main() {
  vec4 a = side(tr_from(v_uv), u_bFrom, u_sigFrom);
  vec4 b = side(tr_to(v_uv), u_bTo, u_sigTo);
  fragColor = mix(mix(a, b, u_sdMix), sd_dissolve(), u_mixWithDissolve);
}`,
				},
			];
		},
	},
});

export const DEFOCUS_SHAPES = ['circle', '3', '4', '5', '6', '7', '8'] as const;
const DEFOCUS_SHAPE_LABELS = [
	'Circle',
	'3 sides',
	'4 sides',
	'5 sides',
	'6 sides',
	'7 sides',
	'8 sides',
] as const;
export const DEFOCUS_EDGE_MODES = ['transparent', 'repeat', 'reflect'] as const;

/** Defocus radius (frame px) of a Defocus Width of 1.0, as a fraction of the frame width. */
export const DEFOCUS_UNIT = 0.05;

/** Defocus radii (frame px) of each side at timing t. */
function defocusRadii(p: EffectParams, t: number, width: number) {
	const base = Math.max(0, num(p.defocusWidth, 0.8)) * DEFOCUS_UNIT * width;
	const tt = clamp(t, 0, 1);
	return {
		from: base * tt * Math.max(0, num(p.defocusRelFrom, 1)),
		to: base * (1 - tt) * Math.max(0, num(p.defocusRelTo, 1)),
		max:
			base * Math.max(0, num(p.defocusRelFrom, 1), num(p.defocusRelTo, 1)) * Math.max(1, num(p.relHeight, 1)),
	};
}

const DEFOCUS_GLSL = /* glsl */ `
// Iris radius (fraction of the full radius) in direction ang (radians): circle, or a polygon with Roundness.
float df_iris(float ang) {
  if (u_shape == 0) return 1.0;
  float n = float(u_shape + 2);
  float seg = 6.28318530718 / n;
  float a = mod(ang - radians(u_rotate), seg) - 0.5 * seg;
  float poly = cos(0.5 * seg) / cos(a);
  return max(0.05, 1.0 + (poly - 1.0) * (1.0 - u_roundness));
}
// Kernel weight of a tap at offset o (texels, y down) for a radius R texels; 0 outside the iris.
float df_weight(vec2 o, float R) {
  vec2 q = vec2(o.x, o.y / max(u_relHeight, 0.01));
  float rho = length(q) / max(R, 1e-3);
  float ir = df_iris(atan(q.y, q.x));
  float rn = rho / ir;
  float w = clamp((1.0 - rn) * R * ir + 0.5, 0.0, 1.0);
  if (u_bokeh > 0.0) w *= 1.0 - smoothstep(1.0 - min(u_bokeh, 1.0), 1.0001, rn) * 0.85;
  else if (u_bokeh < 0.0) w *= max(0.0, 1.0 + u_bokeh * (1.0 - rn));
  if (u_lensNoise > 0.0) {
    vec2 nq = q / max(R, 1e-3) * u_noiseFreq * 0.1 * vec2(u_noiseFreqRelX, 1.0);
    w *= max(0.0, 1.0 + u_lensNoise * fx_valueNoise(nq, u_seed));
  }
  return w;
}
vec4 df_tap(sampler2D t, vec2 uv) {
  if (u_edgeMode == 0 && !tr_inFrame(uv)) return vec4(0.0);
  if (u_edgeMode == 2) uv = vec2(sd_wrap1(uv.x, 2), sd_wrap1(uv.y, 2));
  return texture(t, uv);
}
// Bokeh gather: up to 160 taps on a golden-angle spiral (rotated per pixel to turn patterns into fine noise).
vec4 df_defocus(sampler2D t, float radiusPx) {
  vec2 res = vec2(textureSize(t, 0));
  float R = radiusPx * res.x / u_compSize.x;
  vec2 rr = vec2(R, R * u_relHeight);
  if (max(rr.x, rr.y) < 0.5) return texture(t, v_uv);
  int n = int(clamp(max(rr.x, rr.y) * max(rr.x, rr.y) * 0.9, 12.0, 160.0));
  float rot = fx_hash2(ivec2(v_uv * res), 0.37) * 6.28318530718;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 160; i++) {
    if (i >= n) break;
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(n));
    float a = fi * 2.39996323 + rot;
    vec2 o = vec2(cos(a), sin(a)) * r * vec2(R, R * u_relHeight);
    float w = df_weight(o, R);
    if (w <= 0.0) continue;
    sum += df_tap(t, v_uv + o / res) * w;
    wsum += w;
  }
  return wsum > 0.0 ? sum / wsum : texture(t, v_uv);
}`;

/** Prep pass of one side: box-downsample, gamma (Use Gamma) and Boost Highlights, as light (rgba16f). */
function defocusPrep(side: 'from' | 'to', output: string, scale: number): ShaderPass {
	return {
		output,
		scale,
		format: 'rgba16f',
		include: [GLSL_SD],
		frag: /* glsl */ `
void main() {
  vec2 isz = u_compSize;
  int n = int(clamp(ceil(isz.x / u_resolution.x - 0.01), 1.0, 8.0));
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    if (j >= n) break;
    for (int i = 0; i < 8; i++) {
      if (i >= n) break;
      vec2 o = (vec2(float(i), float(j)) + 0.5) / float(n) - 0.5;
      acc += tr_${side}(v_uv + o / u_resolution);
    }
  }
  vec4 c = acc / float(n * n);
  vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  s = pow(max(s, 0.0), vec3(max(u_useGamma, 0.1)));
  float l = fx_luma(s);
  s *= 1.0 + u_boostHighlights * 4.0 * max(l - u_hilightThreshold, 0.0) / max(1.0 - u_hilightThreshold, 0.05);
  fragColor = vec4(s * c.a, c.a);
}`,
	};
}

export const S_DISSOLVE_DEFOCUS: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-defocus',
	expensive: true,
	label: 'S_DissolveDefocus',
	description:
		'The outgoing clip is defocused and faded out while the incoming clip comes into focus: a lens defocus with iris shapes (circle or polygons), roundness, bokeh rings and boosted highlights.',
	keywords: ['defocus', 'bokeh', 'lens blur', 'focus', 'dissolve', 'iris'],
	timing: {},
	params: [
		slider('defocusWidth', 'Defocus Width', 0.8, { min: 0, softMax: 4 }),
		slider('defocusRelFrom', 'Defocus Rel From', 1, { min: 0, softMax: 4 }),
		slider('defocusRelTo', 'Defocus Rel To', 1, { min: 0, softMax: 4 }),
		slider('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4 }),
		fxParam.choice('shape', 'Shape', DEFOCUS_SHAPES, DEFOCUS_SHAPE_LABELS, 'circle'),
		check('showShape', 'Show Shape', false),
		slider('roundness', 'Roundness', 0, { softMin: -2, softMax: 2 }),
		fxParam.angle('rotate', 'Rotate', 0),
		slider('bokeh', 'Bokeh', 0, { softMin: -1, softMax: 1 }),
		slider('lensNoise', 'Lens Noise', 0, { min: 0, softMax: 2 }),
		slider('noiseFreq', 'Noise Freq', 40, { min: 0.01, softMax: 200, step: 0.1 }),
		slider('noiseFreqRelX', 'Noise Freq Rel X', 1, { min: 0.01, softMax: 4 }),
		seed('Noise Seed'),
		slider('useGamma', 'Use Gamma', 1, { min: 0.1, softMax: 4 }),
		slider('boostHighlights', 'Boost Highlights', 0, { min: 0, softMax: 4 }),
		slider('hilightThreshold', 'Hilight Threshold', 0.9, { min: 0, softMax: 1 }),
		slider('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		fxParam.choice(
			'edgeMode',
			'Edge Mode',
			DEFOCUS_EDGE_MODES,
			['Transparent', 'Repeat', 'Reflect'],
			'reflect',
		),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const r = defocusRadii(p, timingT(p, ctx.progress), ctx.width);
			return { u_radFrom: r.from, u_radTo: r.to };
		},
		passes: (p, ctx): ShaderPass[] => {
			const scale = blurScale(defocusRadii(p, 1, ctx.width).max, 14);
			const k = scale.toFixed(4);
			return [
				defocusPrep('from', 'pFrom', scale),
				defocusPrep('to', 'pTo', scale),
				{
					output: 'dFrom',
					scale,
					format: 'rgba16f',
					include: [GLSL_SD, GLSL_NOISE],
					frag: `${DEFOCUS_GLSL}
void main() { fragColor = df_defocus(u_pFrom, u_radFrom); }`,
				},
				{
					output: 'dTo',
					scale,
					format: 'rgba16f',
					include: [GLSL_SD, GLSL_NOISE],
					frag: `${DEFOCUS_GLSL}
void main() { fragColor = df_defocus(u_pTo, u_radTo); }`,
				},
				{
					include: [GLSL_SD, GLSL_NOISE],
					frag: `${DEFOCUS_GLSL}
vec4 side(vec4 sharp, sampler2D d, float radiusPx) {
  float k = clamp(radiusPx * ${k} / 1.2, 0.0, 1.0);
  if (k <= 0.0) return sharp;
  vec4 c = sd_bicubic(d, v_uv);
  vec3 s = c.a > 0.0 ? max(c.rgb / c.a, 0.0) : vec3(0.0);
  s = pow(s, vec3(1.0 / max(u_useGamma, 0.1))) * u_brightness;
  vec4 blurred = vec4(min(s, vec3(1.0)) * clamp(c.a, 0.0, 1.0), clamp(c.a, 0.0, 1.0));
  return mix(sharp, blurred, k);
}
void main() {
  if (u_showShape) {
    // The iris kernel, centred, 40 % of the frame height across.
    vec2 o = (tr_px() - 0.5 * u_compSize) / (0.2 * u_compSize.y) * 40.0;
    float w = df_weight(o, 40.0);
    fragColor = vec4(vec3(w), 1.0);
    return;
  }
  vec4 a = side(tr_from(v_uv), u_dFrom, u_radFrom);
  vec4 b = side(tr_to(v_uv), u_dTo, u_radTo);
  fragColor = mix(mix(a, b, u_sdMix), sd_dissolve(), u_mixWithDissolve);
}`,
				},
			];
		},
	},
});

export const BLUR_DISSOLVES = [S_DISSOLVE_BLUR, S_DISSOLVE_DEFOCUS] as const;

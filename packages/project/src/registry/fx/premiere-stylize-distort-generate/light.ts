// Premiere Pro standard effects — Vignette and Glow (family "premiere-stylize-distort-generate").
// Vignette = the Lumetri Color vignette as a standalone effect (same four controls, ranges and defaults); Glow = a
// modern multi-scale bloom (threshold with a soft knee → three Gaussian scales at ½, ¼ and ⅛ resolution → tinted
// light added over the layer), padded so the light spills past the layer edges.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import { num } from './common.ts';

export const VIGNETTE = defineShaderEffect({
	id: 'jasper.vignette',
	label: 'Vignette',
	category: 'Stylize',
	description:
		'Darkens (negative Amount) or lightens (positive) the edges of the frame — the Lumetri Color vignette as a standalone effect.',
	keywords: ['lumetri', 'edge', 'darken', 'frame', 'falloff'],
	params: [
		fxParam.number(
			'amount',
			'Amount',
			0,
			{ min: -5, max: 5, step: 0.1 },
			{ ui: { control: 'slider', bipolar: true } },
		),
		fxParam.number(
			'midpoint',
			'Midpoint',
			50,
			{ min: 0, max: 100, step: 0.1 },
			{ ui: { control: 'slider' } },
		),
		fxParam.number(
			'roundness',
			'Roundness',
			0,
			{ min: -100, max: 100, step: 0.1 },
			{ ui: { control: 'slider', bipolar: true } },
		),
		fxParam.number('feather', 'Feather', 50, { min: 0, max: 100, step: 0.1 }, { ui: { control: 'slider' } }),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
// Superellipse distance: 1 on the vignette's reference outline (the frame's inscribed ellipse at roundness 0).
float vignetteDistance(vec2 n) {
  vec2 p = (n - 0.5) * 2.0;
  float r = u_roundness / 100.0;
  float aspect = max(u_box.z, 1.0) / max(u_box.w, 1.0);
  // Positive roundness → towards a circle (isotropic units, sized by the geometric mean of the sides).
  if (r > 0.0) p = mix(p, p * vec2(aspect, 1.0) / sqrt(aspect), r);
  // Negative roundness → towards the frame's rectangle (higher superellipse exponent).
  float e = r < 0.0 ? 2.0 + (-r) * 10.0 : 2.0;
  vec2 a = abs(p);
  return pow(pow(a.x, e) + pow(a.y, e), 1.0 / e);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_amount == 0.0 || src.a <= 0.0) { fragColor = src; return; }
  vec3 c = src.rgb / src.a;
  float d = vignetteDistance(fx_layerNorm());
  // Midpoint: where the falloff is half way (0 → near the centre, 100 → the corners); Feather: its width.
  float mid = mix(0.25, 1.55, u_midpoint / 100.0);
  float f = max(u_feather / 100.0, 0.002) * 1.1;
  float t = smoothstep(mid - f, mid + f, d);
  // Strength rises quickly then saturates (Lumetri-like: −3 is already a strong vignette, ±5 the maximum).
  float k = clamp((1.0 - exp(-0.65 * abs(u_amount))) / (1.0 - exp(-3.25)), 0.0, 1.0) * t;
  c = u_amount < 0.0 ? c * (1.0 - k) : c + (1.0 - c) * k;
  fragColor = vec4(clamp(c, 0.0, 1.0) * src.a, src.a);
}`,
			},
		],
	},
});

export const GLOW = defineShaderEffect({
	id: 'jasper.glow',
	label: 'Glow',
	category: 'Stylize',
	description:
		'Bright areas bloom with soft light that spills beyond the layer: threshold, radius, intensity and colour of the glow.',
	keywords: ['bloom', 'light', 'halo', 'diffuse', 'dreamy'],
	expensive: true,
	params: [
		fxParam.percent('threshold', 'Threshold', 60),
		fxParam.pixels('radius', 'Radius', 40, 500),
		fxParam.number('intensity', 'Intensity', 1, { min: 0, max: 20, softMax: 5, step: 0.01 }),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.toggle('glowOnly', 'Glow Only', false),
	],
	gpu: {
		padding: (p) => 2.5 * Math.max(0, num(p.radius, 40)),
		passes: (p, ctx) => {
			const r = Math.max(0, num(p.radius, 40)) * ctx.pxScale;
			return [
				{
					// Soft-knee threshold on the brightest channel, premultiplied, half resolution, HDR.
					output: 'bright',
					scale: 0.5,
					format: 'rgba16f',
					include: [GLSL_BLUR],
					frag: /* glsl */ `
void main() {
  vec4 c = fx_blur9(u_source, v_uv, u_texel * 0.5);
  vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  float b = max(s.r, max(s.g, s.b));
  float th = u_threshold / 100.0;
  float knee = 0.1 + 0.15 * th;
  float x = clamp(b - th + knee, 0.0, 2.0 * knee);
  float soft = x * x / (4.0 * knee + 1.0e-5);
  float w = max(soft, b - th) / max(b, 1.0e-4);
  fragColor = vec4(s * clamp(w, 0.0, 1.0) * c.a, c.a * clamp(w, 0.0, 1.0));
}`,
				},
				{
					output: 'down1',
					scale: 0.25,
					format: 'rgba16f',
					include: [GLSL_BLUR],
					frag: 'void main() { fragColor = fx_blur9(u_bright, v_uv, u_texel * 0.5); }',
				},
				{
					output: 'down2',
					scale: 0.125,
					format: 'rgba16f',
					include: [GLSL_BLUR],
					frag: 'void main() { fragColor = fx_blur9(u_down1, v_uv, u_texel * 0.5); }',
				},
				...gaussianBlurPasses({
					input: 'bright',
					output: 'g1',
					sigma: r * 0.2,
					scale: 0.5,
					format: 'rgba16f',
				}),
				...gaussianBlurPasses({
					input: 'down1',
					output: 'g2',
					sigma: r * 0.45,
					scale: 0.25,
					format: 'rgba16f',
				}),
				...gaussianBlurPasses({ input: 'down2', output: 'g3', sigma: r, scale: 0.125, format: 'rgba16f' }),
				{
					include: [GLSL_BLEND, GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 g = texture(u_g1, v_uv) * 0.3 + texture(u_g2, v_uv) * 0.35 + texture(u_g3, v_uv) * 0.35;
  vec3 light = g.rgb * u_color.rgb * u_intensity * 2.5;
  if (u_glowOnly) { fragColor = fx_addLight(vec4(0.0), light); return; }
  fragColor = fx_addLight(src, light);
}`,
				},
			];
		},
	},
});

export const PSDG_LIGHT_EFFECTS: readonly EffectSpec[] = [VIGNETTE, GLOW];

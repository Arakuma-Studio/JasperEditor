// Effect family "sapphire-glows-lighting" (fx catalogue, wave 2). Sapphire-style glows and lighting: glows, lens flares, rays, glints, light leaks.
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.s.`; Effects-panel bins: SAPPHIRE_BINS.glows / SAPPHIRE_BINS.lighting.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from './define.ts';
import { GLSL_BLEND } from './glsl/blend.ts';
import { GLSL_COMPOSITE } from './glsl/composite.ts';
import { fxParam, sapphireCommonParams } from './params.ts';
import {
	brightDownscale,
	GLSL_SGL_CORE,
	glowCascade,
	glowSumGlsl,
	glowWeights,
	num,
} from './sapphire-glows-lighting/glow.ts';
import { FLARE_LENSES, flareChunk } from './sapphire-glows-lighting/flare.ts';

const LEVELS = 5;

export const S_GLOW = defineShaderEffect({
	id: 'jasper.s.glow',
	label: 'S_Glow',
	category: 'Stylize',
	bin: SAPPHIRE_BINS.glows,
	description: 'Bright areas bleed soft light around them.',
	keywords: ['bloom', 'light', 'halo'],
	params: [
		fxParam.number('brightness', 'Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('threshold', 'Threshold', 0.25, { min: 0, max: 1, step: 0.01 }),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.number('width', 'Width', 0.3, { min: 0, softMax: 2, step: 0.01 }),
		fxParam.number('widthX', 'Width X', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('widthY', 'Width Y', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('falloff', 'Falloff', 0, { min: -1, max: 1, step: 0.01 }),
		...sapphireCommonParams({ show: [{ value: 'glowOnly', label: 'Glow Only' }] }),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => 2.5 * num(p.width) * 0.25 * ctx.width * Math.max(num(p.widthX, 1), num(p.widthY, 1)),
		uniforms: (p) => ({ u_w: { floats: glowWeights(LEVELS, num(p.falloff)) } }),
		passes: (p, ctx) => {
			const sigma = num(p.width) * 0.25 * ctx.width * ctx.pxScale;
			const sx = sigma * num(p.widthX, 1);
			const sy = sigma * num(p.widthY, 1);
			const dB = brightDownscale(Math.min(sx, sy) || Math.max(sx, sy), LEVELS);
			const c = glowCascade({ input: 'bright', prefix: 'g', sigmaX: sx, sigmaY: sy, levels: LEVELS, inputDown: dB });
			return [
				{
					output: 'bright',
					scale: 1 / dB,
					format: 'rgba16f',
					include: [GLSL_SGL_CORE, GLSL_COMPOSITE],
					uniforms: { u_dB: dB },
					frag: /* glsl */ `
void main() {
  vec4 s = sgl_boxRead(u_source, v_uv, u_dB);
  vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  float m = sgl_soft(fx_luma(c), u_threshold, 0.25 * (1.0 - u_threshold) + 0.02);
  fragColor = vec4(c * m * s.a, m * s.a);
}`,
				},
				...c.passes,
				{
					include: [GLSL_COMPOSITE, GLSL_BLEND],
					frag: /* glsl */ `
${glowSumGlsl('glowAt', c.levels, 'u_w')}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 g = glowAt(v_uv);
  vec3 light = g.rgb * u_color.rgb * u_brightness * 2.0;
  if (u_show == 2) { fragColor = fx_addLight(vec4(0.0), light); return; }
  fragColor = fx_finish(fx_addLight(src, light), src, g.a, u_mixWithOriginal, u_show);
}`,
				},
			];
		},
	},
});

export const S_LENS_FLARE = defineShaderEffect({
	id: 'jasper.s.lens-flare',
	label: 'S_LensFlare',
	category: 'Generate',
	bin: SAPPHIRE_BINS.lighting,
	description: 'draft',
	params: [
		fxParam.choice('lens', 'Lens', FLARE_LENSES.map((l) => l.value), FLARE_LENSES.map((l) => l.label), 'prime35'),
		fxParam.point('lightPos', 'Light Pos', [0.25, 0.25]),
		fxParam.point('flareCenter', 'Flare Center', [0.5, 0.5]),
		fxParam.number('brightness', 'Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('scale', 'Scale', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.angle('rotate', 'Rotate', 0),
		...sapphireCommonParams(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: (p) => {
			const lens = FLARE_LENSES.find((l) => l.value === p.lens) ?? FLARE_LENSES[0]!;
			return [
				{
					include: [flareChunk(lens.value, lens.elements), GLSL_COMPOSITE, GLSL_BLEND],
					frag: /* glsl */ `
void main() {
  vec2 px = fx_canvasPx();
  vec2 light = fx_uvOfLayerNorm(u_lightPos) * u_canvasSize;
  vec2 center = fx_uvOfLayerNorm(u_flareCenter) * u_canvasSize;
  float unit = length(u_box.zw);
  vec3 f = sgl_flare(px, light, center, unit, u_scale, radians(u_rotate), u_color.rgb) * u_brightness;
  vec4 src = texture(u_source, v_uv);
  fragColor = fx_finish(fx_addLight(src, f), src, fx_luma(f), u_mixWithOriginal, u_show);
}`,
				},
			];
		},
	},
});

export const SAPPHIRE_GLOWS_LIGHTING_EFFECTS: readonly EffectSpec[] = [S_GLOW, S_LENS_FLARE];

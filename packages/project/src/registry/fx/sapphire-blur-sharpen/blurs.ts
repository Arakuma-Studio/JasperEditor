// Sapphire Blur+Sharpen — plain blurs: S_Blur, S_BlurChannels, S_BlurChroma, S_SoftFocus. Separable box/triangle/
// gaussian kernels on a downscaled pyramid for large widths (SbsPlan.blur2d), Sapphire tone tails (Brightness,
// Offset Darks, Scale Opacity) and Mix With Source.
// Scale: gaussian-equivalent σ = width × U / 24 (U = half the layer width), so Blur Amount 0.4 ≈ σ 16 px at 1920.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam } from '../params.ts';
import {
	bool,
	edgeOf,
	filterIndex,
	GLSL_SBS_COMMON,
	num,
	px,
	SBS_EDGE_REPEAT,
	SbsPlan,
	sFilter,
	sMix,
	sNum,
	sSize,
	sSoftBorders,
	unitLayerPx,
	vec2,
} from './common.ts';

/** σ (canvas px) per Sapphire blur-width unit. */
export const BLUR_SIGMA_PER_UNIT = 1 / 24;

const blurRel = (name = 'blurRel', label = 'Blur Rel') =>
	fxParam.vec2(name, label, [1, 1], { min: 0, softMax: 4, step: 0.01 });

/** Padding of a soft-bordered blur: 3σ of the largest axis (layer px). */
const softPad = (on: boolean, sigmaUnits: number, ctx: { width: number }) =>
	on ? 3 * sigmaUnits * BLUR_SIGMA_PER_UNIT * unitLayerPx(ctx) : 0;

const EFFECT_MODES = ['color', 'mono'] as const;

export const S_BLUR = defineShaderEffect({
	id: 'jasper.s.blur',
	label: 'S_Blur',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Blurs the clip with a gaussian, triangle or box filter, fast even for very large widths; Blur Rel X/Y give horizontal or vertical blurs.',
	keywords: ['blur', 'gaussian', 'box', 'soften', 'sapphire'],
	params: [
		fxParam.choice('effect', 'Effect', EFFECT_MODES, ['Blur Color', 'Blur Mono'], 'color'),
		sSize('blurAmount', 'Blur Amount', 0.4, 4),
		blurRel(),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('scaleOpacity', 'Scale Opacity', 1, { min: 0, softMax: 2 }),
		sNum('offsetDarks', 'Offset Darks', 0, { softMin: -1, softMax: 1 }),
		sMix(),
		sFilter('gauss'),
		sSoftBorders(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => {
			const rel = vec2(p.blurRel, [1, 1]);
			return softPad(bool(p.softBorders), num(p.blurAmount, 0.4) * Math.max(rel[0], rel[1]), ctx);
		},
		uniforms: (p) => ({ u_sbsEdge: { int: edgeOf(p, SBS_EDGE_REPEAT) } }),
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const rel = vec2(p.blurRel, [1, 1]);
			const s = px(ctx, num(p.blurAmount, 0.4), BLUR_SIGMA_PER_UNIT);
			plan.blur2d({
				input: 'source',
				output: 'blur',
				sigmaX: s * Math.max(0, rel[0]),
				sigmaY: s * Math.max(0, rel[1]),
				filter: filterIndex(p),
				edge: edgeOf(p, SBS_EDGE_REPEAT),
			});
			plan.pass({
				include: [GLSL_SBS_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 b = fx_unpremultiply(texture(u_blur, v_uv));
  vec3 c = u_effect == 1 ? vec3(fx_luma(b.rgb)) : b.rgb;
  c = sbs_offsetDarks(c * u_brightness, u_offsetDarks);
  float a = clamp(b.a * u_scaleOpacity, 0.0, 1.0);
  vec4 result = vec4(max(c, 0.0) * a, a);
  if (!sbs_keep(v_uv, u_sbsEdge)) result = vec4(0.0);
  fragColor = fx_mixOriginal(result, src, u_mixWithOriginal);
}`,
			});
			return plan.passes;
		},
	},
});

export const S_BLUR_CHANNELS = defineShaderEffect({
	id: 'jasper.s.blur-channels',
	label: 'S_BlurChannels',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Blurs the red, green, blue and alpha channels by different amounts, then scales and offsets each channel.',
	keywords: ['blur', 'channels', 'rgb', 'chromatic', 'sapphire'],
	params: [
		sSize('blurAmount', 'Blur Amount', 0.4, 4),
		sSize('blurRed', 'Blur Red', 0, 4),
		sSize('blurGreen', 'Blur Green', 0.5, 4),
		sSize('blurBlue', 'Blur Blue', 1, 4),
		sSize('blurAlpha', 'Blur Alpha', 0, 4),
		blurRel(),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('scaleRed', 'Scale Red', 1, { min: 0, softMax: 4 }),
		sNum('scaleGreen', 'Scale Green', 1, { min: 0, softMax: 4 }),
		sNum('scaleBlue', 'Scale Blue', 1, { min: 0, softMax: 4 }),
		sNum('scaleAlpha', 'Scale Alpha', 1, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2 }),
		sNum('offsetRed', 'Offset Red', 0, { min: -8, max: 2 }),
		sNum('offsetGreen', 'Offset Green', 0, { min: -8, max: 2 }),
		sNum('offsetBlue', 'Offset Blue', 0, { min: -8, max: 2 }),
		sNum('offsetAlpha', 'Offset Alpha', 0, { min: -8, max: 2 }),
		sMix(),
		sFilter('gauss'),
		sSoftBorders(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => {
			const rel = vec2(p.blurRel, [1, 1]);
			const m = Math.max(num(p.blurRed), num(p.blurGreen, 0.5), num(p.blurBlue, 1), num(p.blurAlpha));
			return softPad(bool(p.softBorders), num(p.blurAmount, 0.4) * m * Math.max(rel[0], rel[1]), ctx);
		},
		uniforms: (p) => ({ u_sbsEdge: { int: edgeOf(p, SBS_EDGE_REPEAT) } }),
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const rel = vec2(p.blurRel, [1, 1]);
			const s = px(ctx, num(p.blurAmount, 0.4), BLUR_SIGMA_PER_UNIT);
			const ch = [num(p.blurRed), num(p.blurGreen, 0.5), num(p.blurBlue, 1), num(p.blurAlpha)].map((x) =>
				Math.max(0, x),
			) as [number, number, number, number];
			const m = Math.max(...ch, 1e-6);
			// Straight colour per channel (premultiplied blur would leak alpha blur into colour): blur un-premultiplied
			// colour weighted by alpha in rgb and alpha separately is what the premultiplied path does when the alpha
			// sigma equals the colour sigma; with different sigmas, blur straight RGB + alpha independently.
			plan.pass({
				output: 'straight',
				include: [GLSL_SBS_COMMON],
				format: 'rgba16f',
				frag: 'void main() { fragColor = fx_unpremultiply(sbs_tex(u_source, v_uv, u_sbsEdge)); }',
			});
			plan.blur2d({
				input: 'straight',
				output: 'blur',
				sigmaX: s * m * Math.max(0, rel[0]),
				sigmaY: s * m * Math.max(0, rel[1]),
				filter: filterIndex(p),
				edge: edgeOf(p, SBS_EDGE_REPEAT),
				channels: ch.map((c) => c / m) as [number, number, number, number],
				maxLevel: 0,
			});
			plan.pass({
				include: [GLSL_SBS_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 b = texture(u_blur, v_uv);
  vec4 c = b * vec4(u_scaleRed, u_scaleGreen, u_scaleBlue, u_scaleAlpha) + vec4(u_offsetRed, u_offsetGreen, u_offsetBlue, u_offsetAlpha);
  c.rgb = sbs_offsetDarks(c.rgb * u_brightness, u_offsetDarks);
  float a = clamp(c.a, 0.0, 1.0);
  vec4 result = vec4(clamp(c.rgb, 0.0, 1.0) * a, a);
  if (!sbs_keep(v_uv, u_sbsEdge)) result = vec4(0.0);
  fragColor = fx_mixOriginal(result, src, u_mixWithOriginal);
}`,
			});
			return plan.passes;
		},
	},
});

export const S_BLUR_CHROMA = defineShaderEffect({
	id: 'jasper.s.blur-chroma',
	label: 'S_BlurChroma',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Splits the clip into luminance and chrominance, blurs them independently and recombines them; scale either to enhance or remove it.',
	keywords: ['blur', 'chroma', 'chrominance', 'luminance', 'color noise', 'sapphire'],
	params: [
		sSize('blurChroma', 'Blur Chroma', 0.4, 4),
		sSize('blurLuminance', 'Blur Luminance', 0, 4),
		blurRel(),
		sNum('scaleChroma', 'Scale Chroma', 1, { min: 0, softMax: 4 }),
		sNum('scaleLuminance', 'Scale Luminance', 1, { min: 0, softMax: 4 }),
		sNum('offsetResult', 'Offset Result', 0, { softMin: -1, softMax: 1 }),
		sMix(),
		sFilter('gauss'),
	],
	gpu: {
		timeInvariant: true,
		uniforms: () => ({ u_sbsEdge: { int: SBS_EDGE_REPEAT } }),
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const rel = vec2(p.blurRel, [1, 1]);
			const sc = px(ctx, num(p.blurChroma, 0.4), BLUR_SIGMA_PER_UNIT);
			const sl = px(ctx, num(p.blurLuminance), BLUR_SIGMA_PER_UNIT);
			const m = Math.max(sc, sl, 1e-6);
			// Y, I, Q (offset to 0..1 so rgba8 fallbacks keep them), alpha.
			plan.pass({
				output: 'yiq',
				include: [GLSL_SBS_COMMON],
				format: 'rgba16f',
				frag: /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(sbs_tex(u_source, v_uv, u_sbsEdge));
  fragColor = vec4(sbs_rgb2yiq(c.rgb) + vec3(0.0, 0.5, 0.5), c.a);
}`,
			});
			plan.blur2d({
				input: 'yiq',
				output: 'blur',
				sigmaX: m * Math.max(0, rel[0]),
				sigmaY: m * Math.max(0, rel[1]),
				filter: filterIndex(p),
				edge: SBS_EDGE_REPEAT,
				channels: [sl / m, sc / m, sc / m, 0],
				maxLevel: 0,
			});
			plan.pass({
				include: [GLSL_SBS_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 b = texture(u_blur, v_uv);
  vec3 yiq = b.rgb - vec3(0.0, 0.5, 0.5);
  yiq *= vec3(u_scaleLuminance, u_scaleChroma, u_scaleChroma);
  vec3 c = sbs_yiq2rgb(yiq) + u_offsetResult;
  float a = src.a;
  vec4 result = vec4(clamp(c, 0.0, 1.0) * a, a);
  fragColor = fx_mixOriginal(result, src, u_mixWithOriginal);
}`,
			});
			return plan.passes;
		},
	},
});

export const S_SOFT_FOCUS = defineShaderEffect({
	id: 'jasper.s.soft-focus',
	label: 'S_SoftFocus',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Combines a blurred copy of the clip with the original for a dreamy soft-focus look: highlights bloom into the darks while detail stays.',
	keywords: ['soft focus', 'diffusion', 'dreamy', 'glow', 'pro-mist', 'sapphire'],
	params: [
		sSize('softWidth', 'Soft Width', 0.224, 4),
		fxParam.vec2('widthRel', 'Width Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number(
			'mixWithBlurred',
			'Mix With Blurred',
			0,
			{ min: 0, max: 1, step: 0.01 },
			{ ui: { control: 'slider' } },
		),
		sMix(),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2 }),
	],
	gpu: {
		timeInvariant: true,
		uniforms: () => ({ u_sbsEdge: { int: SBS_EDGE_REPEAT } }),
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const rel = vec2(p.widthRel, [1, 1]);
			const s = px(ctx, num(p.softWidth, 0.224), BLUR_SIGMA_PER_UNIT);
			plan.blur2d({
				input: 'source',
				output: 'blur',
				sigmaX: s * Math.max(0, rel[0]),
				sigmaY: s * Math.max(0, rel[1]),
				edge: SBS_EDGE_REPEAT,
			});
			plan.pass({
				include: [GLSL_SBS_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 s = fx_unpremultiply(src);
  vec4 b = fx_unpremultiply(texture(u_blur, v_uv));
  // Soft focus: the lighter of source and blur (highlights spill into the darks), softened by the average.
  vec3 soft = mix(max(s.rgb, b.rgb), (s.rgb + b.rgb) * 0.5, 0.5);
  soft = mix(soft, b.rgb, clamp(u_mixWithBlurred, 0.0, 1.0));
  vec3 c = sbs_offsetDarks(soft * u_brightness, u_offsetDarks);
  vec4 result = vec4(clamp(c, 0.0, 1.0) * src.a, src.a);
  fragColor = fx_mixOriginal(result, src, u_mixWithOriginal);
}`,
			});
			return plan.passes;
		},
	},
});

export const SBS_BLURS: readonly EffectSpec[] = [S_BLUR, S_BLUR_CHANNELS, S_BLUR_CHROMA, S_SOFT_FOCUS];

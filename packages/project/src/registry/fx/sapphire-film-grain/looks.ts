// Sapphire film / grain family — the "looks": S_Vignette, S_BleachBypass, S_Grain, S_GrainStatic, S_UltraGrain,
// S_Diffuse, S_VintageColor2Strip, S_VintageColor3Strip, S_ScanLines, S_ScanLinesMono. Parameter names, order and
// defaults follow Boris FX's public Sapphire reference; Sapphire's Mask input is replaced by "Mix with Orig".
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { ShaderPass } from '../shader.ts';
import {
	check,
	color,
	filmGrainParams,
	filmGrainUniforms,
	hdPx,
	intSlider,
	mixParam,
	num,
	sapphireSeed,
	slider,
} from './common.ts';
import { GLSL_FILM } from './glsl.ts';

const STYLIZE = SAPPHIRE_BINS.stylize;

/** Blur passes of `source` into `output` (sigma in canvas px), downscaled for wide blurs. */
function sourceBlur(output: string, sigma: number): ShaderPass[] {
	const scale = sigma > 24 ? 0.25 : sigma > 8 ? 0.5 : 1;
	return gaussianBlurPasses({ input: 'source', output, sigma, scale });
}

// ---------------------------------------------------------------- S_Vignette

const VIGNETTE_COMBINE = ['composite', 'mult', 'add', 'screen', 'subtractInv', 'vignetteOnly', 'vignetteOnlyInv'] as const;

const vignetteFrag = (blur: boolean) => /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  vec2 box = sfg_boxPx();
  vec2 s = sfg_sapph(fx_layerPx()) - sfg_sapph(u_center * box);
  s = fx_rot(fx_deg(u_rotate)) * s;
  vec2 radii = max(vec2(u_radius * u_relWidth, u_radius * u_relHeight), vec2(1.0e-4));
  vec2 q = abs(s) / radii;
  float sq = clamp(u_squareness, 0.0, 1.0);
  float P = 2.0 + 38.0 * sq * sq;
  float d = q.x + q.y < 1.0e-6 ? 0.0 : pow(pow(q.x, P) + pow(q.y, P), 1.0 / P);
  float t = clamp((d - 1.0) / max(u_edgeSoftness, 1.0e-3) + 0.5, 0.0, 1.0);
  if (u_edgeSoftness <= 1.0e-3) t = step(1.0, d);
  float m = mix(t, t * t * (3.0 - 2.0 * t), clamp(u_smoothCurve, 0.0, 1.0));
  ${
		blur
			? `vec3 b = fx_unpremultiply(texture(u_vigBlur, v_uv)).rgb;
  c = mix(c, b, u_blurInside ? 1.0 - m : m);`
			: ''
	}
  vec3 base = c * u_sourceBrightness;
  float k = m * max(u_opacity, 0.0);
  vec3 col = u_color.rgb;
  vec3 o;
  if (u_combine == 0) o = mix(base, col, clamp(k, 0.0, 1.0));
  else if (u_combine == 1) o = base * mix(vec3(1.0), col, k);
  else if (u_combine == 2) o = base + col * k;
  else if (u_combine == 3) o = 1.0 - (1.0 - base) * (1.0 - clamp(col * k, 0.0, 1.0));
  else if (u_combine == 4) o = base - (1.0 - col) * k;
  else if (u_combine == 5) o = vec3(k);
  else o = vec3(1.0 - k);
  fragColor = sfg_out(o, src, u_mixWithOriginal);
}`;

export const S_VIGNETTE = defineShaderEffect({
	id: 'jasper.s.vignette',
	label: 'S_Vignette',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Darkens, colourises or blurs the border of the frame with an elliptical to rectangular shape (Squareness), soft edge and S-curve falloff.',
	keywords: ['vignette', 'edge', 'darken', 'border', 'film'],
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		slider('squareness', 'Squareness', 0, 0, 1),
		slider('radius', 'Radius', 0.9, 0, 10, { softMax: 3 }),
		slider('relHeight', 'Rel Height', 0.75, 0.05, 10, { softMax: 3 }),
		slider('relWidth', 'Rel Width', 1, 0.05, 10, { softMax: 3 }),
		fxParam.angle('rotate', 'Rotate', 0),
		slider('edgeSoftness', 'Edge Softness', 1, 0, 10, { softMax: 3 }),
		slider('smoothCurve', 'Smooth Curve', 0.4, 0, 1),
		color('color', 'Color', [0, 0, 0]),
		slider('opacity', 'Opacity', 1, 0, 10, { softMax: 2 }),
		slider('blurAmount', 'Blur Amount', 0, 0, 10, { softMax: 2 }),
		check('blurInside', 'Blur Inside', false),
		slider('sourceBrightness', 'Source Brightness', 1, 0, 10, { softMax: 2 }),
		fxParam.choice(
			'combine',
			'Combine',
			VIGNETTE_COMBINE,
			['Composite', 'Mult', 'Add', 'Screen', 'Subtract Inv', 'Vignette Only', 'Vignette Only Inv'],
			'composite',
		),
		mixParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const blur = num(p.blurAmount) > 0;
			const final: ShaderPass = { include: [GLSL_FILM, GLSL_UV], frag: vignetteFrag(blur) };
			if (!blur) return [final];
			const sigma = num(p.blurAmount) * 0.05 * ctx.width * ctx.pxScale;
			return [...sourceBlur('vigBlur', sigma), final];
		},
	},
});

// ---------------------------------------------------------------- S_BleachBypass

const BLEACH_FRAG = (blur: boolean) => /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  ${
		blur
			? `vec3 b = fx_unpremultiply(texture(u_bbBlur, v_uv)).rgb;
  c = c + u_sharpen * (c - b);
  c = mix(c, b, clamp(u_softFocus, 0.0, 1.0));`
			: ''
	}
  // silver retained: the black-and-white image overlaid on the colour one
  float l = fx_luma(clamp(c, 0.0, 1.0));
  vec3 r1 = 2.0 * c * l;
  vec3 r2 = 1.0 - 2.0 * (1.0 - l) * (1.0 - c);
  vec3 bb = mix(r1, r2, clamp(10.0 * (l - 0.45), 0.0, 1.0));
  bb = mix(vec3(fx_luma(bb)), bb, 0.82 * u_saturation);
  bb = sfg_lights(bb, u_scaleLights, u_offsetDarks);
  vec3 o = mix(fx_unpremultiply(src).rgb, bb, u_amount);
  if (u_grainAmp > 0.0) {
    vec2 p = fx_layerPx();
    vec3 n = sfg_grainNoise(p, u_grainSizePx, u_grainMono, sfg_frameSeed(u_seed, u_grainFrame, 1.0));
    vec3 amp = u_grainAmp * vec3(u_grainAmpRed, u_grainAmpGreen, u_grainAmpBlue)
      * sfg_grainCurve(o, u_grainAmpDarks, 1.0, u_grainAmpBrights, vec3(0.5));
    o += n * amp * 0.035;
  }
  o *= u_scaleColors.rgb;
  fragColor = sfg_out(o, src, u_mixWithOriginal);
}`;

export const S_BLEACH_BYPASS = defineShaderEffect({
	id: 'jasper.s.bleach-bypass',
	label: 'S_BleachBypass',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Skip-bleach film processing: the retained silver adds contrast and removes saturation for a gritty, metallic look, with optional soft focus, sharpening and film grain.',
	keywords: ['bleach bypass', 'skip bleach', 'silver retention', 'desaturate', 'contrast', 'film'],
	params: [
		slider('amount', 'Amount', 1, 0, 10, { softMax: 2 }),
		slider('softFocus', 'Soft Focus', 0, 0, 10, { softMax: 1 }),
		slider('sharpen', 'Sharpen', 0, -10, 10, { softMin: -2, softMax: 4 }),
		slider('saturation', 'Saturation', 1, 0, 10, { softMax: 3 }),
		slider('scaleLights', 'Scale Lights', 1, 0, 10, { softMax: 3 }),
		slider('offsetDarks', 'Offset Darks', 0, -8, 2),
		...filmGrainParams({ amp: 0, group: 'Grain Parameters' }),
		sapphireSeed('Grain Seed'),
		color('scaleColors', 'Scale Colors', [1, 1, 1]),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => filmGrainUniforms(p, ctx),
		passes: (p, ctx) => {
			const blur = num(p.softFocus) !== 0 || num(p.sharpen) !== 0;
			const final: ShaderPass = { include: [GLSL_FILM], frag: BLEACH_FRAG(blur) };
			return blur ? [...sourceBlur('bbBlur', 0.004 * ctx.width * ctx.pxScale), final] : [final];
		},
	},
});

// ---------------------------------------------------------------- S_Grain

/** Grain presets (the Load Preset factory looks of film stocks): base values, scaled by the sliders. */
export const GRAIN_PRESETS: Record<
	string,
	{ label: string; amp: number; freq: number; oct: number; rgb: [number, number, number]; bw: number; bwFreq: number }
> = {
	custom: { label: 'Custom', amp: 0.1, freq: 100, oct: 1, rgb: [1, 1, 1], bw: 0, bwFreq: 100 },
	k5245: { label: 'Kodak 5245 (EXR 50D)', amp: 0.025, freq: 620, oct: 2, rgb: [1, 1, 0.85], bw: 0.012, bwFreq: 760 },
	k5246: { label: 'Kodak 5246 (Vision 250D)', amp: 0.04, freq: 500, oct: 2, rgb: [1, 1, 0.8], bw: 0.018, bwFreq: 620 },
	k5274: { label: 'Kodak 5274 (Vision 200T)', amp: 0.045, freq: 480, oct: 2, rgb: [1, 0.95, 0.8], bw: 0.02, bwFreq: 600 },
	k5279: { label: 'Kodak 5279 (Vision 500T)', amp: 0.065, freq: 400, oct: 2, rgb: [1, 0.95, 0.75], bw: 0.028, bwFreq: 500 },
	k5289: { label: 'Kodak 5289 (Vision 800T)', amp: 0.085, freq: 340, oct: 2, rgb: [1, 0.92, 0.72], bw: 0.035, bwFreq: 430 },
	k5218: { label: 'Kodak 5218 (Vision2 500T)', amp: 0.055, freq: 440, oct: 2, rgb: [1, 0.95, 0.78], bw: 0.024, bwFreq: 560 },
	fuji8573: { label: 'Fuji Eterna 500T', amp: 0.06, freq: 420, oct: 2, rgb: [0.95, 1, 0.8], bw: 0.026, bwFreq: 540 },
	s16mm: { label: '16mm', amp: 0.1, freq: 260, oct: 3, rgb: [1, 0.92, 0.75], bw: 0.04, bwFreq: 320 },
	s8mm: { label: 'Super 8', amp: 0.14, freq: 170, oct: 3, rgb: [1, 0.9, 0.7], bw: 0.06, bwFreq: 210 },
	triX: { label: 'Kodak Tri-X (B&W)', amp: 0, freq: 300, oct: 1, rgb: [1, 1, 1], bw: 0.13, bwFreq: 330 },
	plusX: { label: 'Kodak Plus-X (B&W)', amp: 0, freq: 300, oct: 1, rgb: [1, 1, 1], bw: 0.07, bwFreq: 480 },
};
const GRAIN_PRESET_KEYS = Object.keys(GRAIN_PRESETS);

/** Effective S_Grain values: Custom = the sliders; a preset = its base values scaled by the sliders' ratios. */
export function grainSettings(p: Record<string, unknown>) {
	const key = typeof p.filmStock === 'string' && GRAIN_PRESETS[p.filmStock] ? p.filmStock : 'custom';
	const pr = GRAIN_PRESETS[key]!;
	const amp = Math.max(0, num(p.colorAmplitude, 0.1));
	const freq = Math.max(0.1, num(p.colorFrequency, 100));
	const bw = Math.max(0, num(p.bwAmplitude, 0));
	const bwFreq = Math.max(0.1, num(p.bwFrequency, 100));
	const rgbF: [number, number, number] = [
		Math.max(0.01, num(p.redFreq, 1)),
		Math.max(0.01, num(p.greenFreq, 1)),
		Math.max(0.01, num(p.blueFreq, 1)),
	];
	const oct = Math.round(num(p.colorOctaves, 1));
	const bwOct = Math.round(num(p.bwOctaves, 1));
	if (key === 'custom') return { amp, freq, oct, rgb: rgbF, bw, bwFreq, bwOct };
	return {
		amp: pr.amp * (amp / 0.1),
		freq: pr.freq * (freq / 100),
		oct: pr.oct + oct - 1,
		rgb: [pr.rgb[0] * rgbF[0], pr.rgb[1] * rgbF[1], pr.rgb[2] * rgbF[2]] as [number, number, number],
		bw: pr.bw + bw,
		bwFreq: pr.bwFreq * (bwFreq / 100),
		bwOct: pr.oct + bwOct - 1,
	};
}

const GRAIN_FRAG = /* glsl */ `
// Coherent grain: octaves of gradient noise at 'freq' cycles per frame width, amplitude halving per octave.
float sgr_noise(vec2 q, float freq, int octaves, float seed) {
  float sum = 0.0, amp = 1.0;
  for (int k = 0; k < 10; k++) {
    if (k >= octaves) break;
    sum += amp * fx_gradientNoise(q * freq, fract(seed + float(k) * 0.1271));
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  vec2 q = fx_layerPx() / sfg_boxPx().x;
  float fs = sfg_frameSeed(u_seed, u_grainFrame, 2.0);
  vec3 g = vec3(
    sgr_noise(q + vec2(0.0, 0.0), u_gFreq * u_gRgb.r, u_gOct, fs),
    sgr_noise(q + vec2(17.3, 5.1), u_gFreq * u_gRgb.g, u_gOct, fract(fs + 0.31)),
    sgr_noise(q + vec2(41.7, 9.9), u_gFreq * u_gRgb.b, u_gOct, fract(fs + 0.62))) * u_gAmp;
  g += sgr_noise(q + vec2(3.7, 77.1), u_gBwFreq, u_gBwOct, fract(fs + 0.83)) * u_gBw;
  fragColor = sfg_out(c + g * u_colorScale.rgb, src, u_mixWithOriginal);
}`;

export const S_GRAIN = defineShaderEffect({
	id: 'jasper.s.grain',
	label: 'S_Grain',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Adds coherent colour and/or black-and-white grain: amplitude, frequency (cycles per frame width) and octaves per kind, per-channel frequency, a new pattern every Jitter Frames. Film Stock presets set the base grain of a stock; the sliders then scale it.',
	keywords: ['grain', 'noise', 'film grain', 'film stock', 'texture'],
	params: [
		fxParam.choice(
			'filmStock',
			'Film Stock',
			GRAIN_PRESET_KEYS,
			GRAIN_PRESET_KEYS.map((k) => GRAIN_PRESETS[k]!.label),
			'custom',
		),
		color('colorScale', 'Color Scale', [1, 1, 1]),
		slider('colorAmplitude', 'Color Amplitude', 0.1, 0, 10, { softMax: 1 }),
		slider('colorFrequency', 'Color Frequency', 100, 0.1, 10000, { softMax: 1000, step: 1 }),
		intSlider('colorOctaves', 'Color Octaves', 1, 1, 10),
		slider('redFreq', 'Red Freq', 1, 0.01, 100, { softMax: 4 }),
		slider('greenFreq', 'Green Freq', 1, 0.01, 100, { softMax: 4 }),
		slider('blueFreq', 'Blue Freq', 1, 0.01, 100, { softMax: 4 }),
		slider('bwAmplitude', 'Bw Amplitude', 0, 0, 10, { softMax: 1 }),
		slider('bwFrequency', 'Bw Frequency', 100, 0.1, 10000, { softMax: 1000, step: 1 }),
		intSlider('bwOctaves', 'Bw Octaves', 1, 1, 10),
		sapphireSeed('Seed'),
		intSlider('jitterFrames', 'Jitter Frames', 1, 0, 1000, 30),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const g = grainSettings(p);
			const jit = Math.max(0, Math.round(num(p.jitterFrames, 1)));
			return {
				u_gAmp: g.amp,
				u_gFreq: g.freq,
				u_gOct: { int: Math.max(1, Math.min(10, g.oct)) },
				u_gRgb: g.rgb,
				u_gBw: g.bw,
				u_gBwFreq: g.bwFreq,
				u_gBwOct: { int: Math.max(1, Math.min(10, g.bwOct)) },
				u_grainFrame: jit === 0 ? 0 : Math.floor(ctx.frame / jit),
			};
		},
		passes: [{ include: [GLSL_FILM], frag: GRAIN_FRAG }],
	},
});

// ---------------------------------------------------------------- S_GrainStatic

export const S_GRAIN_STATIC = defineShaderEffect({
	id: 'jasper.s.grain-static',
	label: 'S_GrainStatic',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Per-pixel random colour and black-and-white noise with no spatial coherence (a new pattern every frame); the look depends on the resolution.',
	keywords: ['grain', 'static', 'noise', 'snow', 'dither'],
	params: [
		color('colorScale', 'Color Scale', [1, 1, 1]),
		slider('colorAmplitude', 'Color Amplitude', 0.1, 0, 10, { softMax: 1 }),
		slider('bwAmplitude', 'Bw Amplitude', 0, 0, 10, { softMax: 1 }),
		mixParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_FILM],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  ivec3 q = ivec3(ivec2(floor(fx_canvasPx())), int(floor(u_frame)));
  vec3 n = vec3(fx_hash3(q, u_seed), fx_hash3(q + ivec3(0, 0, 7919), u_seed), fx_hash3(q + ivec3(0, 0, 15485), u_seed)) * 2.0 - 1.0;
  float bw = fx_hash3(q + ivec3(0, 0, 32452), u_seed) * 2.0 - 1.0;
  vec3 g = (n * u_colorAmplitude + bw * u_bwAmplitude) * u_colorScale.rgb;
  fragColor = sfg_out(c + g, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_UltraGrain

export const S_ULTRA_GRAIN = defineShaderEffect({
	id: 'jasper.s.ultra-grain',
	label: 'S_UltraGrain',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Simulated digital-camera grain: per-channel amplitude and blur, amplitude following a Darks → Mids (at the per-channel midtone position) → Brights curve.',
	keywords: ['grain', 'noise', 'sensor noise', 'digital', 'camera'],
	params: [
		slider('grainAmp', 'Grain Amp', 1, 0, 2),
		slider('grainSize', 'Grain Size', 1, 0.001, 20, { softMax: 4 }),
		slider('grainBlur', 'Grain Blur', 0.00567, 0, 1, { softMax: 0.05, step: 0.0001 }),
		slider('grainAmpRed', 'Grain Amp Red', 3.29, 0, 20, { softMax: 6 }),
		slider('grainAmpGreen', 'Grain Amp Green', 3, 0, 20, { softMax: 6 }),
		slider('grainAmpBlue', 'Grain Amp Blue', 3.52, 0, 20, { softMax: 6 }),
		slider('grainBlurRed', 'Grain Blur Red', 0.572, 0, 10, { softMax: 3 }),
		slider('grainBlurGreen', 'Grain Blur Green', 0.561, 0, 10, { softMax: 3 }),
		slider('grainBlurBlue', 'Grain Blur Blue', 0.528, 0, 10, { softMax: 3 }),
		slider('grainAmpDarks', 'Grain Amp Darks', 0.37, 0, 2),
		slider('grainAmpMids', 'Grain Amp Mids', 1, 0, 2),
		slider('grainAmpBrights', 'Grain Amp Brights', 0, 0, 2),
		slider('midtonePosRed', 'Midtone Pos Red', 0.27, 0, 1),
		slider('midtonePosGreen', 'Midtone Pos Green', 0.3, 0, 1),
		slider('midtonePosBlue', 'Midtone Pos Blue', 0.31, 0, 1),
		check('grainMono', 'Grain Mono', false),
		sapphireSeed('Grain Seed'),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const hd = hdPx(ctx);
			const size = Math.max(0.001, num(p.grainSize, 1));
			const blur = Math.max(0, num(p.grainBlur, 0.00567)) * 230;
			const px = (b: unknown, d: number) => Math.max(0.5, size * hd * (1 + blur * Math.max(0, num(b, d))));
			return {
				u_sizePx: [px(p.grainBlurRed, 0.572), px(p.grainBlurGreen, 0.561), px(p.grainBlurBlue, 0.528)],
			};
		},
		passes: [
			{
				include: [GLSL_FILM],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  vec3 n = sfg_grainNoise(fx_layerPx(), u_sizePx, u_grainMono, sfg_frameSeed(u_seed, u_frame, 3.0));
  vec3 curve = sfg_grainCurve(c, u_grainAmpDarks, u_grainAmpMids, u_grainAmpBrights,
                              vec3(u_midtonePosRed, u_midtonePosGreen, u_midtonePosBlue));
  vec3 amp = u_grainAmp * vec3(u_grainAmpRed, u_grainAmpGreen, u_grainAmpBlue) * curve * 0.018;
  fragColor = sfg_out(c + n * amp, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_Diffuse

const WRAP = ['no', 'tile', 'reflect'] as const;
const WRAP_LABELS = ['No', 'Tile', 'Reflect'];

export const S_DIFFUSE = defineShaderEffect({
	id: 'jasper.s.diffuse',
	label: 'S_Diffuse',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Scrambles pixels within a radius (Diffuse Amount, stretched by Rel Amount) for a frosted, dithered look; the scatter changes every frame and depends on the resolution.',
	keywords: ['diffuse', 'scatter', 'frosted glass', 'dither', 'scramble'],
	params: [
		slider('diffuseAmount', 'Diffuse Amount', 0.2, 0, 100, { softMax: 2 }),
		fxParam.vec2('relAmount', 'Rel Amount', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		fxParam.choice('wrapX', 'Wrap X', WRAP, WRAP_LABELS, 'reflect'),
		fxParam.choice('wrapY', 'Wrap Y', WRAP, WRAP_LABELS, 'reflect'),
		mixParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_FILM],
				frag: /* glsl */ `
float sdf_wrap(float x, int mode) {
  if (mode == 1) return fract(x);
  if (mode == 2) { float m = mod(x, 2.0); return m > 1.0 ? 2.0 - m : m; }
  return x;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  ivec3 q = ivec3(ivec2(floor(fx_canvasPx())), int(floor(u_frame)));
  float a = fx_hash3(q, u_seed) * 6.2831853;
  float r = sqrt(fx_hash3(q + ivec3(0, 0, 7919), u_seed));
  vec2 off = vec2(cos(a), sin(a)) * r * u_diffuseAmount * 20.0 * u_pxScale * max(u_relAmount, vec2(0.0));
  vec2 n = fx_layerNorm() + off / u_box.zw;
  n = vec2(sdf_wrap(n.x, u_wrapX), sdf_wrap(n.y, u_wrapY));
  vec4 s = (n.x < 0.0 || n.x > 1.0 || n.y < 0.0 || n.y > 1.0) ? vec4(0.0) : texture(u_source, fx_uvOfLayerNorm(n));
  fragColor = mix(s, src, clamp(u_mixWithOriginal, 0.0, 1.0));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_VintageColor2Strip / 3Strip

const VINTAGE_GRAIN = /* glsl */ `
vec3 svc_grain(vec3 rec, float amp, float blur) {
  if (amp <= 0.0) return rec;
  vec2 p = fx_layerPx();
  float sz = max(0.6, (1.0 + blur * 25.0) * sfg_boxPx().x / 1920.0);
  float fs = sfg_frameSeed(u_seed, u_frame, 4.0);
  vec3 n = vec3(sfg_grain(p, sz, fs), sfg_grain(p, sz, fract(fs + 0.29)), sfg_grain(p, sz, fract(fs + 0.57)));
  return rec + n * amp * 0.05 * (0.4 + 0.6 * sqrt(clamp(rec * (1.0 - rec) * 4.0, 0.0, 1.0)));
}
`;

export const S_VINTAGE_COLOR_2STRIP = defineShaderEffect({
	id: 'jasper.s.vintage-color-2strip',
	label: 'S_VintageColor2Strip',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'1920s two-strip colour: the scene is recorded through red and blue-green filters and printed with red and cyan dyes — reds, oranges and cyan-greens, almost no true blue.',
	keywords: ['technicolor', 'two strip', 'vintage', 'retro', 'film', 'color'],
	params: [
		slider('amount', 'Amount', 1, 0, 10, { softMax: 2 }),
		color('redFilter', 'Red Filter', [1, 0, 0]),
		color('bluegreenFilter', 'Bluegreen Filter', [0, 1, 0.5]),
		color('redDye', 'Red Dye', [1, 0, 0]),
		color('cyanDye', 'Cyan Dye', [0.02, 1, 0.91]),
		slider('brightness', 'Brightness', 1, 0, 10, { softMax: 3 }),
		slider('saturation', 'Saturation', 1, -2, 8),
		slider('offsetDarks', 'Offset Darks', 0, -8, 2),
		slider('grainAmp', 'Grain Amp', 0, 0, 10, { softMax: 2 }),
		slider('grainBlur', 'Grain Blur', 0, 0, 0.4, { step: 0.001 }),
		fxParam.choice(
			'show',
			'Show',
			['result', 'redStrip', 'bluegreenStrip', 'redDye', 'cyanDye'],
			['Result', 'Red Strip', 'BlueGreen Strip', 'Red Dye', 'Cyan Dye'],
			'result',
		),
		mixParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_FILM],
				frag: /* glsl */ `${VINTAGE_GRAIN}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  // the filters see narrow bands (less cross-talk than the camera's RGB)
  mat3 sep = mat3(1.45, -0.15, 0.0,  -0.5, 1.3, -0.3,  0.0, -0.15, 1.3);
  vec3 lin = clamp(sep * fx_srgbToLinear(clamp(c, 0.0, 1.0)), 0.0, 1.0);
  float red = dot(lin, u_redFilter.rgb) / max(dot(u_redFilter.rgb, vec3(1.0)), 1.0e-4);
  float bg = dot(lin, u_bluegreenFilter.rgb) / max(dot(u_bluegreenFilter.rgb, vec3(1.0)), 1.0e-4);
  vec3 rec = svc_grain(vec3(red, bg, 0.0), u_grainAmp, u_grainBlur);
  rec = clamp(rec, 0.0, 1.0);
  // the red record controls the cyan dye (no red → cyan), the blue-green record the red dye
  vec3 cyanLayer = mix(vec3(1.0), fx_srgbToLinear(u_cyanDye.rgb), 1.0 - rec.x);
  vec3 redLayer = mix(vec3(1.0), fx_srgbToLinear(u_redDye.rgb), 1.0 - rec.y);
  vec3 o;
  if (u_show == 1) o = vec3(fx_linearToSrgb(vec3(rec.x)));
  else if (u_show == 2) o = vec3(fx_linearToSrgb(vec3(rec.y)));
  else if (u_show == 3) o = fx_linearToSrgb(redLayer);
  else if (u_show == 4) o = fx_linearToSrgb(cyanLayer);
  else {
    o = fx_linearToSrgb(cyanLayer * redLayer);
    o = mix(vec3(fx_luma(o)), o, u_saturation) * u_brightness;
    o = sfg_lights(o, 1.0, u_offsetDarks);
    o = mix(c, o, u_amount);
  }
  fragColor = sfg_out(o, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_VINTAGE_COLOR_3STRIP = defineShaderEffect({
	id: 'jasper.s.vintage-color-3strip',
	label: 'S_VintageColor3Strip',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Three-strip Technicolor (1935–55): narrow-band separations printed with saturated cyan, magenta and yellow dyes, with an optional black-and-white key layer.',
	keywords: ['technicolor', 'three strip', 'vintage', 'saturated', 'dye transfer', 'film'],
	params: [
		slider('amount', 'Amount', 1, 0, 10, { softMax: 2 }),
		slider('keyLayerDensity', 'Key Layer Density', 0, 0, 1),
		slider('brightness', 'Brightness', 1, 0, 10, { softMax: 3 }),
		color('tint', 'Tint', [1, 1, 1]),
		slider('saturation', 'Saturation', 1, -2, 8),
		slider('offsetDarks', 'Offset Darks', 0, -8, 2),
		slider('grainAmp', 'Grain Amp', 0, 0, 10, { softMax: 2 }),
		slider('grainBlur', 'Grain Blur', 0, 0, 0.4, { step: 0.001 }),
		fxParam.choice(
			'show',
			'Show',
			['result', 'pureColors', 'complementaryMasks'],
			['Result', 'Pure Colors', 'Complementary Masks'],
			'result',
		),
		mixParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_FILM],
				frag: /* glsl */ `${VINTAGE_GRAIN}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  vec3 lin = fx_srgbToLinear(clamp(c, 0.0, 1.0));
  // narrow-band separations: each record rejects the neighbouring bands (more saturated than the camera's RGB)
  mat3 sep = mat3(1.32, -0.2, -0.06,  -0.22, 1.36, -0.22,  -0.1, -0.16, 1.3);
  vec3 rec = clamp(svc_grain(clamp(sep * lin, 0.0, 1.0), u_grainAmp, u_grainBlur), 0.0, 1.0);
  // dye densities (complementary masks) and the dyes' transmissions (slightly impure, like real dyes)
  vec3 dens = 1.0 - rec;
  vec3 cyan = vec3(0.04, 0.86, 0.96), magenta = vec3(0.95, 0.05, 0.62), yellow = vec3(1.0, 0.93, 0.04);
  vec3 t = mix(vec3(1.0), cyan, dens.r) * mix(vec3(1.0), magenta, dens.g) * mix(vec3(1.0), yellow, dens.b);
  // key layer: a black-and-white silver image printed under the dyes (deeper blacks, darker overall)
  float key = pow(clamp(fx_luma(lin), 0.0, 1.0), 0.7);
  t *= mix(1.0, key, clamp(u_keyLayerDensity, 0.0, 1.0));
  vec3 o;
  if (u_show == 1) o = fx_linearToSrgb(rec);
  else if (u_show == 2) o = fx_linearToSrgb(dens);
  else {
    o = fx_linearToSrgb(t) * u_tint.rgb;
    o = mix(vec3(fx_luma(o)), o, u_saturation) * u_brightness;
    o = sfg_lights(o, 1.0, u_offsetDarks);
    o = mix(c, o, u_amount);
  }
  fragColor = sfg_out(o, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_ScanLines / S_ScanLinesMono

const SCANLINES_COMMON = /* glsl */ `
// Scan-line profile (1 on the line centre, 0 between lines) for a phase offset, sharpened by Lines Sharpness
// (0 = flat: no lines; 1 = sinusoidal; higher = thinner lines).
float ssl_line(vec2 p, float shift) {
  vec2 box = sfg_boxPx();
  vec2 r = fx_rot(-fx_deg(u_linesAngle)) * (p - box * 0.5);
  float ph = r.y / box.y * u_linesFrequency + shift;
  float l = 0.5 + 0.5 * cos(6.2831853 * ph);
  float s = max(u_linesSharpness, 0.0);
  // normalised to a mean of 1 (≈ 1/mean of cos^s), so the lines keep the average brightness
  return pow(max(l, 0.0), s) * sqrt(1.0 + 3.14159 * s);
}
// Lines applied in light (gamma-decoded) like a CRT beam, re-encoded: line = 1 keeps the value.
vec3 ssl_apply(vec3 v, vec3 line) {
  float g = max(u_gamma, 0.1);
  return pow(pow(max(v, vec3(0.0)), vec3(g)) * line, vec3(1.0 / g));
}
vec3 ssl_source() {
  vec4 s = texture(u_source, v_uv);
  if (u_smoothSource > 0.0) {
    float r = u_smoothSource * u_box.w * 0.02;
    vec4 acc = s * 2.0; float w = 2.0;
    for (int i = 1; i <= 3; i++) {
      float k = float(4 - i);
      vec2 o = vec2(0.0, r * float(i) / 3.0) / u_canvasSize;
      acc += (texture(u_source, v_uv + o) + texture(u_source, v_uv - o)) * k; w += 2.0 * k;
    }
    s = acc / w;
  }
  return fx_unpremultiply(s).rgb;
}
float ssl_noise(vec2 p, float seed) {
  vec2 box = sfg_boxPx();
  float f = max(u_noiseFreqRel, 0.01) * u_linesFrequency * 4.0 / box.y;
  return fx_gradientNoise(p * f, seed);
}
`;

const scanLinesParams = (mono: boolean) => [
	slider('linesFrequency', 'Lines Frequency', 50, 1, 2000, { softMax: 300, step: 0.1 }),
	slider('linesSharpness', 'Lines Sharpness', 1, 0, 100, { softMax: 5 }),
	fxParam.angle('linesAngle', 'Lines Angle', 0),
	slider('linesShift', 'Lines Shift', 0, undefined, undefined, { softMin: -2, softMax: 2 }),
	...(mono
		? []
		: [
				slider('shiftRed', 'Shift Red', 0, undefined, undefined, { softMin: -1, softMax: 1 }),
				slider('shiftGreen', 'Shift Green', 0, undefined, undefined, { softMin: -1, softMax: 1 }),
				slider('shiftBlue', 'Shift Blue', 0, undefined, undefined, { softMin: -1, softMax: 1 }),
			]),
	slider('addNoise', 'Add Noise', 0, 0, 10, { softMax: 1 }),
	slider('noiseFreqRel', 'Noise Freq Rel', 1, 0.01, 100, { softMax: 4 }),
	slider('brightness', 'Brightness', 1, 0, 10, { softMax: 3 }),
	...(mono
		? [color('color1', 'Color1', [1, 1, 1]), color('color0', 'Color0', [0, 0, 0])]
		: [color('scaleColor', 'Scale Color', [1, 1, 1])]),
	slider('offset', 'Offset', 0, mono ? -8 : undefined, mono ? 2 : undefined, { softMin: -1, softMax: 1 }),
	slider('gamma', 'Gamma', 1.5, 0.1, 10, { softMax: 4 }),
	...(mono ? [] : [slider('saturation', 'Saturation', 1, 0, 10, { softMax: 3 })]),
	slider('smoothSource', 'Smooth Source', 0, 0, 10, { softMax: 1 }),
	mixParam(),
];

export const S_SCAN_LINES = defineShaderEffect({
	id: 'jasper.s.scan-lines',
	label: 'S_ScanLines',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Colour-TV scan lines whose thickness follows the picture brightness, with per-channel line offsets (misconvergence) and optional colour noise.',
	keywords: ['scan lines', 'scanlines', 'crt', 'tv', 'video', 'retro'],
	params: scanLinesParams(false),
	gpu: {
		passes: [
			{
				include: [GLSL_FILM, GLSL_UV],
				frag: /* glsl */ `${SCANLINES_COMMON}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = ssl_source();
  vec2 p = fx_layerPx();
  vec3 line = vec3(
    ssl_line(p, u_linesShift + u_shiftRed),
    ssl_line(p, u_linesShift + u_shiftGreen),
    ssl_line(p, u_linesShift + u_shiftBlue));
  if (u_addNoise > 0.0) {
    float fs = sfg_frameSeed(u_seed, u_frame, 5.0);
    c += u_addNoise * 0.25 * vec3(ssl_noise(p, fs), ssl_noise(p, fract(fs + 0.3)), ssl_noise(p, fract(fs + 0.6)));
  }
  vec3 o = ssl_apply(c, line) * u_brightness * u_scaleColor.rgb + u_offset;
  o = mix(vec3(fx_luma(o)), o, u_saturation);
  fragColor = sfg_out(o, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_SCAN_LINES_MONO = defineShaderEffect({
	id: 'jasper.s.scan-lines-mono',
	label: 'S_ScanLinesMono',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Black-and-white scan lines: the picture brightness sets the line thickness, mapped through two colours (Color0 → Color1), with optional noise.',
	keywords: ['scan lines', 'scanlines', 'monochrome', 'crt', 'halftone', 'retro'],
	params: scanLinesParams(true),
	gpu: {
		passes: [
			{
				include: [GLSL_FILM, GLSL_UV],
				frag: /* glsl */ `${SCANLINES_COMMON}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = ssl_source();
  vec2 p = fx_layerPx();
  float v = fx_luma(c);
  if (u_addNoise > 0.0) v += u_addNoise * 0.25 * ssl_noise(p, sfg_frameSeed(u_seed, u_frame, 5.0));
  float lit = clamp(ssl_apply(vec3(v), vec3(ssl_line(p, u_linesShift))).r * u_brightness + u_offset, 0.0, 1.0);
  vec3 o = mix(u_color0.rgb, u_color1.rgb, lit);
  fragColor = sfg_out(o, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const LOOKS_EFFECTS: readonly EffectSpec[] = [
	S_VIGNETTE,
	S_BLEACH_BYPASS,
	S_GRAIN,
	S_GRAIN_STATIC,
	S_ULTRA_GRAIN,
	S_DIFFUSE,
	S_VINTAGE_COLOR_2STRIP,
	S_VINTAGE_COLOR_3STRIP,
	S_SCAN_LINES,
	S_SCAN_LINES_MONO,
];

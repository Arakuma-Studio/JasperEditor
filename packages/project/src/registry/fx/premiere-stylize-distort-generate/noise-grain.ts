// Premiere Pro standard effects — Noise & Grain (family "premiere-stylize-distort-generate", wave 2): Dust &
// Scratches, Median, Noise, Noise Alpha, Noise HLS, Noise HLS Auto.
// Median machinery: per-channel median of a 7×7 tap grid spread over the radius (exact 7×7 window up to radius 3,
// sparser — linearly filtered — taps beyond), found by bisection on the tap values (no sorting network). For radii
// above 3 px it is an approximation of the full-window median (fine detail between taps is not considered).
// Noise phases: "Random Seed" of Noise Alpha and "Noise Phase" of Noise HLS are smooth phases (animate them and the
// noise morphs), so they are plain params (`randomSeed`, `noisePhase`) mixed with the instance's `u_seed` in GLSL.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { fxParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import { num } from './common.ts';

/** Median of a 7×7 grid of taps `stride` texels apart around uv: per channel, 10 bisection steps. */
export const GLSL_PSDG_MEDIAN: GlslChunk = {
	name: 'psdg/median',
	source: /* glsl */ `
vec4 psdg_median49(sampler2D t, vec2 uv, vec2 texel, float stride) {
  vec4 v[49];
  int k = 0;
  for (int y = -3; y <= 3; y++)
    for (int x = -3; x <= 3; x++) {
      v[k] = texture(t, uv + vec2(float(x), float(y)) * texel * stride);
      k++;
    }
  vec4 lo = vec4(0.0);
  vec4 hi = vec4(1.0);
  for (int it = 0; it < 10; it++) {
    vec4 mid = (lo + hi) * 0.5;
    vec4 below = vec4(0.0);
    for (int i = 0; i < 49; i++) below += step(v[i], mid);
    // below[c] ≥ 25 → the median is ≤ mid
    vec4 le = step(25.0, below);
    hi = mix(hi, mid, le);
    lo = mix(mid, lo, le);
  }
  return (lo + hi) * 0.5;
}
`,
};

const medianStride = (radius: number) => Math.max(radius, 0) / 3;

export const DUST_AND_SCRATCHES = defineShaderEffect({
	id: 'jasper.dust-and-scratches',
	label: 'Dust & Scratches',
	category: 'Noise & Grain',
	description:
		'Removes specks and scratches: pixels that differ from the median of their neighbourhood by more than Threshold take the median value.',
	keywords: ['despeckle', 'clean', 'restore', 'median', 'denoise'],
	expensive: true,
	params: [
		fxParam.number('radius', 'Radius', 1, { min: 0, max: 100, softMax: 20, step: 1 }, { unit: 'px' }),
		fxParam.number('threshold', 'Threshold', 0, { min: 0, max: 255, step: 1 }),
		fxParam.toggle('useOnAlpha', 'Use on Alpha Channel', false),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_stride: medianStride(num(p.radius, 1) * ctx.pxScale) }),
		passes: [
			{
				include: [GLSL_PSDG_MEDIAN],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_stride <= 0.0) { fragColor = src; return; }
  // The median works on straight colour (alpha separately) so semi-transparent edges keep their colour.
  vec4 m = psdg_median49(u_source, v_uv, u_texel, u_stride);
  vec3 sc = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 mc = m.a > 0.0 ? m.rgb / m.a : sc;
  float t = u_threshold / 255.0;
  vec3 diff = abs(sc - mc);
  vec3 outc = mix(sc, mc, step(t + 1.0e-4, diff));
  float a = u_useOnAlpha && abs(src.a - m.a) > t ? m.a : src.a;
  fragColor = vec4(clamp(outc, 0.0, 1.0) * a, a);
}`,
			},
		],
	},
});

export const MEDIAN = defineShaderEffect({
	id: 'jasper.median',
	label: 'Median',
	category: 'Noise & Grain',
	description:
		'Replaces each pixel by the median of its neighbourhood: removes noise and, at large radii, gives a painted look.',
	keywords: ['denoise', 'smooth', 'paint', 'despeckle'],
	expensive: true,
	params: [
		fxParam.number('radius', 'Radius', 0, { min: 0, max: 255, softMax: 20, step: 1 }, { unit: 'px' }),
		fxParam.toggle('operateOnAlpha', 'Operate on Alpha Channel', false),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_stride: medianStride(num(p.radius) * ctx.pxScale) }),
		passes: [
			{
				include: [GLSL_PSDG_MEDIAN],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_stride <= 0.0) { fragColor = src; return; }
  vec4 m = psdg_median49(u_source, v_uv, u_texel, u_stride);
  vec3 mc = m.a > 0.0 ? m.rgb / m.a : (src.a > 0.0 ? src.rgb / src.a : vec3(0.0));
  float a = u_operateOnAlpha ? m.a : src.a;
  fragColor = vec4(clamp(mc, 0.0, 1.0) * a, a);
}`,
			},
		],
	},
});

export const NOISE = defineShaderEffect({
	id: 'jasper.noise',
	label: 'Noise',
	category: 'Noise & Grain',
	description: 'Adds random pixel noise that changes every frame (colour or monochrome).',
	keywords: ['grain', 'static', 'film', 'dither'],
	params: [
		fxParam.percent('amount', 'Amount of Noise', 0),
		fxParam.toggle('colorNoise', 'Use Color Noise', true),
		fxParam.toggle('clip', 'Clip Result Values', true),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_HASH],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float amt = u_amount / 100.0;
  if (amt <= 0.0 || src.a <= 0.0) { fragColor = src; return; }
  ivec3 p = ivec3(floor(fx_layerPx()), int(u_frame));
  vec3 n = u_colorNoise
    ? vec3(fx_hash3(p, u_seed), fx_hash3(p + ivec3(0, 0, 7919), u_seed), fx_hash3(p + ivec3(0, 0, 15881), u_seed))
    : vec3(fx_hash3(p, u_seed));
  vec3 c = src.rgb / src.a + (n - 0.5) * 2.0 * amt;
  c = u_clip ? clamp(c, 0.0, 1.0) : fract(c);
  fragColor = vec4(c * src.a, src.a);
}`,
			},
		],
	},
});

/** Smooth seeded noise along a phase axis: value at lattice point floor(phase) blended to the next (0..1). */
const GLSL_PSDG_PHASE_NOISE: GlslChunk = {
	name: 'psdg/phase-noise',
	deps: [GLSL_HASH],
	source: /* glsl */ `
// Per-pixel 0..1 noise for a phase; integer phases are independent patterns, fractions morph smoothly.
// cycle > 0: the phase wraps every cycle units (loops seamlessly).
float psdg_phaseNoise(ivec2 p, float phase, float cycle, float seed, int channel) {
  float f = floor(phase);
  float t = phase - f;
  float a = f;
  float b = f + 1.0;
  if (cycle > 0.0) { a = mod(a, cycle); b = mod(b, cycle); }
  ivec3 q = ivec3(p, channel * 104729);
  float va = fx_hash3(q + ivec3(0, 0, int(a) * 7), seed);
  float vb = fx_hash3(q + ivec3(0, 0, int(b) * 7), seed);
  return mix(va, vb, t * t * (3.0 - 2.0 * t));
}
`,
};

export const NOISE_ALPHA = defineShaderEffect({
	id: 'jasper.noise-alpha',
	label: 'Noise Alpha',
	category: 'Noise & Grain',
	description:
		'Adds noise to the alpha channel (static or smoothly animated, combined with the original alpha in several ways).',
	keywords: ['transparency', 'grain', 'speckle', 'dissolve'],
	params: [
		fxParam.choice(
			'noise',
			'Noise',
			['uniformRandom', 'squaredRandom', 'uniformAnimation', 'squaredAnimation'],
			['Uniform Random', 'Squared Random', 'Uniform Animation', 'Squared Animation'],
			'uniformRandom',
		),
		fxParam.percent('amount', 'Amount', 0),
		fxParam.choice('originalAlpha', 'Original Alpha', ['add', 'clamp', 'scale', 'edges'], ['Add', 'Clamp', 'Scale', 'Edges'], 'clamp'),
		fxParam.choice('overflow', 'Overflow', ['clip', 'wrapBack', 'wrap'], ['Clip', 'Wrap Back', 'Wrap'], 'clip'),
		fxParam.number('randomSeed', 'Random Seed', 0, { min: -100000, max: 100000, softMin: -360, softMax: 360, step: 0.1 }),
		fxParam.toggle('cycleNoise', 'Cycle Noise', false, { group: 'Noise Options (Animation)' }),
		fxParam.number('cycle', 'Cycle (in Revolutions)', 1, { min: 1, max: 1000, softMax: 50, step: 1 }, { group: 'Noise Options (Animation)' }),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_PHASE_NOISE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float amt = u_amount / 100.0;
  if (amt <= 0.0 || !fx_inBox(v_uv)) { fragColor = src; return; }
  ivec2 p = ivec2(floor(fx_layerPx()));
  bool animated = u_noise >= 2;
  // Random types: each integer seed is a new static pattern. Animation types: the seed is a phase in turns (360 =
  // one revolution: every pixel cycles through its noise), optionally looping every Cycle revolutions.
  float phase = animated ? u_randomSeed / 360.0 * 4.0 : floor(u_randomSeed);
  float cycle = animated && u_cycleNoise ? max(1.0, floor(u_cycle)) * 4.0 : 0.0;
  float n = psdg_phaseNoise(p, phase, cycle, u_seed, 0);
  if (u_noise == 1 || u_noise == 3) n = n * n;
  n *= amt;
  float a0 = src.a;
  float a;
  if (u_originalAlpha == 0) a = a0 + n;                                  // Add
  else if (u_originalAlpha == 1) a = min(a0, a0 * (1.0 - amt) + n);         // Clamp: noise inside the shape only
  else if (u_originalAlpha == 2) a = a0 * (1.0 - amt + n);                  // Scale
  else a = a0 + (n - amt * 0.5) * 4.0 * a0 * (1.0 - a0);                  // Edges: only where alpha is partial
  if (u_overflow == 0) a = clamp(a, 0.0, 1.0);
  else if (u_overflow == 1) { a = mod(a, 2.0); a = a > 1.0 ? 2.0 - a : a; a = clamp(a, 0.0, 1.0); }
  else if (a < 0.0 || a > 1.0) a = fract(a);
  vec3 c = a0 > 0.0 ? src.rgb / a0 : vec3(0.0);
  // Pixels that were fully transparent have no colour: added alpha shows black there (AE behaviour).
  fragColor = vec4(c * a, a);
}`,
			},
		],
	},
});

/** Shared GLSL of Noise HLS / Noise HLS Auto: HLS noise at a phase. */
const noiseHlsFrag = (phaseExpr: string) => /* glsl */ `
float hlsNoise(vec2 lp, float phase, int channel) {
  if (u_noise == 2) {
    // Grain: clumps of Grain Size pixels (bilinear between lattice values).
    float g = max(u_grainSize, 0.5);
    vec2 q = lp / g;
    ivec2 i = ivec2(floor(q));
    vec2 f = fract(q);
    f = f * f * (3.0 - 2.0 * f);
    float a = psdg_phaseNoise(i, phase, 0.0, u_seed, channel);
    float b = psdg_phaseNoise(i + ivec2(1, 0), phase, 0.0, u_seed, channel);
    float c = psdg_phaseNoise(i + ivec2(0, 1), phase, 0.0, u_seed, channel);
    float d = psdg_phaseNoise(i + ivec2(1, 1), phase, 0.0, u_seed, channel);
    return (mix(mix(a, b, f.x), mix(c, d, f.x), f.y) - 0.5) * 2.6;
  }
  float n = psdg_phaseNoise(ivec2(floor(lp)), phase, 0.0, u_seed, channel) * 2.0 - 1.0;
  if (u_noise == 1) n = n * abs(n);
  return n;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  if ((u_hue == 0.0 && u_lightness == 0.0 && u_saturation == 0.0) || src.a <= 0.0) { fragColor = src; return; }
  vec2 lp = fx_layerPx();
  float phase = ${phaseExpr};
  vec3 hsl = fx_rgb2hsl(src.rgb / src.a);
  hsl.x = fract(hsl.x + hlsNoise(lp, phase, 0) * u_hue / 100.0 * 0.5);
  hsl.y = clamp(hsl.y + hlsNoise(lp, phase, 1) * u_saturation / 100.0, 0.0, 1.0);
  hsl.z = clamp(hsl.z + hlsNoise(lp, phase, 2) * u_lightness / 100.0, 0.0, 1.0);
  fragColor = vec4(fx_hsl2rgb(hsl) * src.a, src.a);
}`;

const hlsParams = () => [
	fxParam.choice('noise', 'Noise', ['uniform', 'squared', 'grain'], ['Uniform', 'Squared', 'Grain'], 'uniform'),
	fxParam.percent('hue', 'Hue', 0),
	fxParam.percent('lightness', 'Lightness', 0),
	fxParam.percent('saturation', 'Saturation', 0),
	fxParam.number('grainSize', 'Grain Size', 1, { min: 0.5, max: 100, softMax: 10, step: 0.1 }),
];

export const NOISE_HLS = defineShaderEffect({
	id: 'jasper.noise-hls',
	label: 'Noise HLS',
	category: 'Noise & Grain',
	description:
		'Adds noise to hue, lightness and saturation (uniform, squared or clumped film grain); animate Noise Phase to change it.',
	keywords: ['grain', 'film', 'color noise', 'texture'],
	params: [
		...hlsParams(),
		fxParam.number('noisePhase', 'Noise Phase', 0, { min: -100000, max: 100000, softMin: -360, softMax: 360, step: 0.1 }),
	],
	gpu: {
		timeInvariant: true,
		passes: [{ include: [GLSL_PSDG_PHASE_NOISE, GLSL_COLOR], frag: noiseHlsFrag('u_noisePhase / 36.0') }],
	},
});

export const NOISE_HLS_AUTO = defineShaderEffect({
	id: 'jasper.noise-hls-auto',
	label: 'Noise HLS Auto',
	category: 'Noise & Grain',
	description: 'Noise HLS that animates by itself: hue, lightness and saturation noise changing at Noise Animation Speed.',
	keywords: ['grain', 'film', 'animated noise', 'texture'],
	params: [
		...hlsParams(),
		fxParam.number('speed', 'Noise Animation Speed', 10, { min: 0, max: 1000, softMax: 50, step: 0.1 }),
	],
	gpu: {
		passes: [{ include: [GLSL_PSDG_PHASE_NOISE, GLSL_COLOR], frag: noiseHlsFrag('u_time * u_speed') }],
	},
});

export const PSDG_NOISE_GRAIN_EFFECTS: readonly EffectSpec[] = [
	DUST_AND_SCRATCHES,
	MEDIAN,
	NOISE,
	NOISE_ALPHA,
	NOISE_HLS,
	NOISE_HLS_AUTO,
];

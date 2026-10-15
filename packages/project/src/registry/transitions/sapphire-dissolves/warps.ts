// Sapphire-style warping dissolves: the outgoing clip is warped away while the incoming one is unwarped into place
// (S_DissolveBubble, S_DissolveVortex, S_DissolveWaves, S_DissolvePuddle, S_DissolveDistort), scrambled
// (S_DissolveDiffuse, S_DissolveTiles) or shaken (S_DissolveShake). Parameters follow Boris FX's public Sapphire
// documentation; clean-room implementations.
//
// Warp units follow the Sapphire distort family (registry/fx/sapphire-distort-warp): "frame units" with the origin at
// the frame centre, 1 = the frame width, y down; radii in units of half the smaller frame side. A warp amount ramps
// with the timing t: A by t (0 → full), B by 1 − t (full → 0), so both ends are unwarped. Filter: adaptive 2×2
// supersampling where the warp minifies (folds, vortex centres).
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { GLSL_MB_POSES } from '../../fx/glsl/motion-blur.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { fxParam } from '../../fx/params.ts';
import { DW_WAVE_UNIT, SHAKE_RENDER_GLSL, shakeUniforms } from '../../fx/sapphire-distort-warp.ts';
import type { GlslChunk, ShaderPass } from '../../fx/shader.ts';
import {
	blurPasses,
	check,
	defineDissolve,
	dissolveTiming,
	GLSL_SD,
	GLSL_SD_NOISE,
	grp,
	intSlider,
	num,
	sapphirePoint,
	seed,
	slider,
	wrapParams,
} from './common.ts';

/** Frame-unit helpers and the warp-dissolve renderer (`sdw_*`). */
export const GLSL_SDW: GlslChunk = {
	name: 'sapphire-dissolves/warp',
	deps: [GLSL_SD],
	source: /* glsl */ `
const float SDW_TAU = 6.28318530718;
vec2 sdw_frameOfPx(vec2 px) { return (px - 0.5 * u_compSize) / u_compSize.x; }
vec2 sdw_uvOfFrame(vec2 f) { return (f * u_compSize.x + 0.5 * u_compSize) / u_compSize; }
vec2 sdw_frameOfNorm(vec2 n) { return (n - 0.5) * u_compSize / u_compSize.x; }
// Radius unit: half the smaller frame side, in frame units.
float sdw_unit() { return 0.5 * min(1.0, u_compSize.y / u_compSize.x); }
// Rotation by degrees, clockwise on screen (y down).
mat2 sdw_rot(float deg) { float a = radians(deg); float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
`,
};

/**
 * The renderer of a two-sided warp dissolve: the shader defines `vec2 warpA(vec2 f)` / `vec2 warpB(vec2 f)` (output
 * frame position → source frame position of each side); A and B are mixed by u_sdMix, then Mix with Dissolve.
 */
function warpMain(body: string): string {
	return `${body}
vec4 sdw_mixAt(vec2 fa, vec2 fb, ivec2 w) {
  vec4 a = u_sdMix >= 1.0 ? vec4(0.0) : sd_fromW(sdw_uvOfFrame(fa), w);
  vec4 b = u_sdMix <= 0.0 ? vec4(0.0) : sd_toW(sdw_uvOfFrame(fb), w);
  return mix(a, b, u_sdMix);
}
void main() {
  vec2 f = sdw_frameOfPx(tr_px());
  ivec2 w = ivec2(u_wrapX, u_wrapY);
  float px = 1.0 / u_compSize.x;
  // The warps are evaluated in loops with uniform-driven trip counts, so each has two call sites only (software GL
  // compiles every inlined copy). First the warps at f, f + 1 px in x and in y (the footprint, Filter only).
  vec2 wa[3] = vec2[3](f, f, f);
  vec2 wb[3] = vec2[3](f, f, f);
  int nf = u_filter ? 3 : 1;
  for (int i = 0; i < nf; i++) {
    vec2 g = f + (i == 1 ? vec2(px, 0.0) : i == 2 ? vec2(0.0, px) : vec2(0.0));
    wa[i] = warpA(g);
    wb[i] = warpB(g);
  }
  // Filter: supersample 2×2 where one output pixel covers more than 1.5 source pixels.
  int n = 1;
  if (u_filter) {
    float fp = max(max(length(wa[1] - wa[0]), length(wa[2] - wa[0])), max(length(wb[1] - wb[0]), length(wb[2] - wb[0])));
    if (fp > 1.5 * px) n = 4;
  }
  vec4 acc = vec4(0.0);
  for (int i = 0; i < n; i++) {
    vec2 a = wa[0], b = wb[0];
    if (n > 1) {
      vec2 g = f + (vec2(float(i % 2), float(i / 2)) - 0.5) * 0.5 * px;
      a = warpA(g);
      b = warpB(g);
    }
    acc += sdw_mixAt(a, b, w);
  }
  fragColor = mix(acc / float(n), sd_dissolve(), u_mixWithDissolve);
}`;
}

const filterParam = () => check('filter', 'Filter', true);
const relAmp2 = (label = 'Rel Amp2') => slider('relAmp2', label, -1, { softMin: -2, softMax: 2 });

/** Warp amounts of A (∝ t) and B (∝ 1 − t) as uniforms. */
const rampUniforms = (p: EffectParams, progress: number) => {
	const t = dissolveTiming(p, progress).t;
	return { u_rampA: t, u_rampB: 1 - t };
};

export const S_DISSOLVE_BUBBLE: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-bubble',
	label: 'S_DissolveBubble',
	description:
		'The outgoing clip is warped away by bubbly noise and faded out while the incoming clip is unwarped into place.',
	keywords: ['bubble', 'warp', 'noise', 'liquid', 'wobble', 'dissolve'],
	timing: { slow: [0.5, 0.5] },
	params: [
		slider('frequency', 'Frequency', 8, { min: 0.01, softMax: 50, step: 0.1 }),
		slider('frequencyRelY', 'Frequency Rel Y', 1, { min: 0.01, softMax: 4 }),
		intSlider('octaves', 'Octaves', 1, 1, 10),
		seed(),
		slider('amplitude', 'Amplitude', 1, { softMin: -4, softMax: 4 }),
		relAmp2(),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		uniforms: (p, ctx) => rampUniforms(p, ctx.progress),
		passes: [
			{
				include: [GLSL_SDW, GLSL_SD_NOISE],
				frag: warpMain(/* glsl */ `
// Bubble noise: two fbm fields → a displacement of about ±amp / freq frame widths.
vec2 bubble(vec2 f) {
  vec2 q = f * u_frequency * vec2(1.0, u_frequencyRelY);
  int o = int(clamp(floor(u_octaves + 0.5), 1.0, 10.0));
  return vec2(sd_fbm(q, o, 0.5, u_seed), sd_fbm(q + vec2(37.3, 11.9), o, 0.5, fract(u_seed + 0.5))) * 1.4
       / max(u_frequency, 0.01);
}
vec2 warpA(vec2 f) { return f + bubble(f) * u_amplitude * u_rampA; }
vec2 warpB(vec2 f) { return f + bubble(f) * u_amplitude * u_relAmp2 * u_rampB; }`),
			},
		],
	},
});

export const S_DISSOLVE_VORTEX: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-vortex',
	label: 'S_DissolveVortex',
	description:
		'The outgoing clip is twisted away into a vortex and faded out while the incoming clip untwists into place.',
	keywords: ['vortex', 'twirl', 'swirl', 'whirlpool', 'spiral', 'dissolve'],
	timing: { slow: [0.5, 0.5] },
	params: [
		fxParam.point('center', 'Center', sapphirePoint(0, 0)),
		slider('vortexAmount', 'Vortex Amount', 72, { softMin: -720, softMax: 720, step: 0.1 }),
		slider('relAmount2', 'Rel Amount2', -1, { softMin: -2, softMax: 2 }),
		slider('rotateAmount', 'Rotate Amount', 0, { softMin: -360, softMax: 360, step: 0.1 }),
		slider('innerRadius', 'Inner Radius', 0.04, { min: 0, softMax: 1, step: 0.001 }),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		uniforms: (p, ctx) => rampUniforms(p, ctx.progress),
		passes: [
			{
				include: [GLSL_SDW],
				frag: warpMain(/* glsl */ `
// Twist (degrees) = Vortex Amount at the frame edge (half a frame width away), growing as 1/r towards the centre;
// inside Inner Radius it fades back to no twist. Rotate Amount adds a rigid rotation.
vec2 vortex(vec2 f, float k) {
  vec2 c = sdw_frameOfNorm(u_center);
  vec2 d = f - c;
  float r = length(d);
  float ri = max(u_innerRadius * 0.5, 1e-4);
  float twist = u_vortexAmount * 0.5 / max(r, ri) * smoothstep(0.0, ri, r);
  return c + sdw_rot(-(twist + u_rotateAmount) * k) * d;
}
vec2 warpA(vec2 f) { return vortex(f, u_rampA); }
vec2 warpB(vec2 f) { return vortex(f, u_relAmount2 * u_rampB); }`),
			},
		],
	},
});

export const S_DISSOLVE_WAVES: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-waves',
	label: 'S_DissolveWaves',
	description:
		'The outgoing clip is warped away by straight waves and faded out while the incoming clip is unwarped into place.',
	keywords: ['waves', 'wave', 'ripple', 'sine', 'wavy', 'dissolve'],
	timing: { slow: [0.5, 0.5] },
	params: [
		slider('frequency', 'Frequency', 3, { min: 0.01, softMax: 50, step: 0.1 }),
		slider('amplitude', 'Amplitude', 0.3, { softMin: -2, softMax: 2 }),
		relAmp2(),
		fxParam.angle('angle', 'Angle', 45),
		fxParam.angle('displaceAngle', 'Displace Angle', 90),
		slider('phaseStart', 'Phase Start', 0, { softMin: -10, softMax: 10 }),
		slider('phaseSpeed', 'Phase Speed', 0, { softMin: -10, softMax: 10 }),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		uniforms: (p, ctx) => rampUniforms(p, ctx.progress),
		passes: [
			{
				include: [GLSL_SDW],
				frag: warpMain(/* glsl */ `
// Straight waves along Angle (0 = vertical crests), pushing along Angle + Displace Angle; the displacement keeps the
// wave's steepness independent of the frequency (as the Sapphire distort family's waves).
vec2 waves(vec2 f) {
  vec2 k = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
  vec2 dir = sdw_rot(u_displaceAngle) * k;
  float phase = u_phaseStart + u_phaseSpeed * u_time;
  return dir * u_amplitude * ${DW_WAVE_UNIT.toFixed(3)} / max(u_frequency, 0.01) * sin(SDW_TAU * (u_frequency * dot(f, k) - phase));
}
vec2 warpA(vec2 f) { return f + waves(f) * u_rampA; }
vec2 warpB(vec2 f) { return f + waves(f) * u_relAmp2 * u_rampB; }`),
			},
		],
	},
});

export const S_DISSOLVE_PUDDLE: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-puddle',
	label: 'S_DissolvePuddle',
	description:
		'The outgoing clip is warped away by circular ripples, like a stone dropped in a puddle, while the incoming clip settles into place.',
	keywords: ['puddle', 'ripple', 'water', 'rings', 'pond', 'dissolve'],
	timing: { slow: [0.2, 0.2] },
	params: [
		fxParam.point('center', 'Center', sapphirePoint(0, 0)),
		slider('frequency', 'Frequency', 5, { min: 0.01, softMax: 50, step: 0.1 }),
		slider('relHeight', 'Rel Height', 0.75, { min: 0.01, softMax: 4 }),
		slider('amplitude', 'Amplitude', 0.2, { softMin: -2, softMax: 2 }),
		relAmp2(),
		fxParam.angle('rotatePuddle', 'Rotate Puddle', 0),
		slider('phaseStart', 'Phase Start', 0, { softMin: -10, softMax: 10 }),
		slider('phaseSpeed', 'Phase Speed', 1, { softMin: -10, softMax: 10 }),
		slider('innerRadius', 'Inner Radius', 0, { softMin: 0, softMax: 2, step: 0.001 }),
		slider('innerSoftness', 'Inner Softness', 0.1, { min: 0.0056, softMax: 2, step: 0.001 }),
		slider('outerRadius', 'Outer Radius', 1.4, { min: 0, softMax: 4, step: 0.001 }),
		slider('outerSoftness', 'Outer Softness', 0.42, { min: 0.0056, softMax: 2, step: 0.001 }),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		uniforms: (p, ctx) => rampUniforms(p, ctx.progress),
		passes: [
			{
				include: [GLSL_SDW],
				frag: warpMain(/* glsl */ `
// The dissolve's ripples are 3× the S_WarpPuddle amplitude unit (a dissolve has to carry the picture away).
const float PUDDLE_GAIN = 3.0;
// Radial ripple displacement (frame units) around Center: Frequency waves per radius unit, between Inner and Outer
// Radius (soft edges), Rel Height squashes the rings, which travel outwards at Phase Speed (cycles per second).
vec2 puddle(vec2 f) {
  vec2 c = sdw_frameOfNorm(u_center);
  vec2 e = sdw_rot(-u_rotatePuddle) * (f - c);
  e.y /= max(u_relHeight, 0.01);
  float r = length(e) / sdw_unit();
  if (r < 1e-6) return vec2(0.0);
  float env = smoothstep(u_innerRadius, u_innerRadius + max(u_innerSoftness, 1e-4), r)
            * (1.0 - smoothstep(u_outerRadius - max(u_outerSoftness, 1e-4), u_outerRadius, r));
  vec2 dir = normalize(sdw_rot(u_rotatePuddle) * vec2(e.x, e.y * max(u_relHeight, 0.01)));
  float phase = u_phaseStart + u_phaseSpeed * u_time;
  return dir * u_amplitude * PUDDLE_GAIN * ${DW_WAVE_UNIT.toFixed(3)} * sdw_unit() / max(u_frequency, 0.01)
       * sin(SDW_TAU * (u_frequency * r - phase)) * env;
}
vec2 warpA(vec2 f) { return f + puddle(f) * u_rampA; }
vec2 warpB(vec2 f) { return f + puddle(f) * u_relAmp2 * u_rampB; }`),
			},
		],
	},
});

/** Smoothness → σ (frame px) of the luma before its gradient is taken. */
export const distortSmoothPx = (p: EffectParams, width: number) =>
	Math.max(0, num(p.smoothness, 0.25)) * 0.06 * width;

export const S_DISSOLVE_DISTORT: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-distort',
	label: 'S_DissolveDistort',
	description:
		'Each clip is distorted by the brightness gradient of the other: the outgoing clip warps away along the shapes of the incoming one, which unwarps into place.',
	keywords: ['distort', 'displace', 'gradient', 'warp', 'morph', 'dissolve'],
	timing: { slow: [0.2, 0.2] },
	params: [
		slider('amplitude', 'Amplitude', 1, { softMin: -4, softMax: 4 }),
		slider('relAmpFrom', 'Rel Amp From', 1, { softMin: -2, softMax: 2 }),
		slider('relAmpTo', 'Rel Amp To', -1, { softMin: -2, softMax: 2 }),
		slider('smoothness', 'Smoothness', 0.25, { min: 0, softMax: 2 }),
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		uniforms: (p, ctx) => ({ ...rampUniforms(p, ctx.progress), u_smoothPx: distortSmoothPx(p, ctx.width) }),
		passes: (): ShaderPass[] => [
			{
				// r = luma of A, g = luma of B (half resolution).
				output: 'lumas',
				scale: 0.5,
				include: [GLSL_SD],
				frag: /* glsl */ `
float lumaOf(vec4 c) { return c.a > 0.0 ? fx_luma(clamp(c.rgb / c.a, 0.0, 1.0)) * c.a : 0.0; }
void main() { fragColor = vec4(lumaOf(tr_from(v_uv)), lumaOf(tr_to(v_uv)), 0.0, 1.0); }`,
			},
			...blurPasses({ input: 'lumas', output: 'lumasBlur', scale: 0.5, sigma: 'vec2(u_smoothPx)' }),
			{
				include: [GLSL_SDW],
				frag: warpMain(/* glsl */ `
// Luma gradient (difference across ±h, h ≈ the smoothing width) of the blurred lumas, in frame units.
vec4 grads(vec2 f) {
  vec2 uv = sdw_uvOfFrame(f);
  vec2 h = vec2(max(u_smoothPx, 2.0)) / u_compSize;
  vec4 gx = texture(u_lumasBlur, uv + vec2(h.x, 0.0)) - texture(u_lumasBlur, uv - vec2(h.x, 0.0));
  vec4 gy = texture(u_lumasBlur, uv + vec2(0.0, h.y)) - texture(u_lumasBlur, uv - vec2(0.0, h.y));
  return vec4(gx.r, gy.r, gx.g, gy.g) * 0.5;
}
const float DISTORT_UNIT = 0.5;
vec2 warpA(vec2 f) {
  vec4 g = grads(f);
  return f + sdw_rot(u_rotateWarpDir) * g.zw * u_amplitude * u_relAmpFrom * DISTORT_UNIT * u_rampA;
}
vec2 warpB(vec2 f) {
  vec4 g = grads(f);
  return f + sdw_rot(u_rotateWarpDir) * g.xy * u_amplitude * u_relAmpTo * DISTORT_UNIT * u_rampB;
}`),
			},
		],
	},
});

export const S_DISSOLVE_DIFFUSE: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-diffuse',
	label: 'S_DissolveDiffuse',
	description:
		'The pixels of the outgoing clip scatter away (diffuse) while those of the incoming clip gather into place, within Max Amount.',
	keywords: ['diffuse', 'scatter', 'scramble', 'pixels', 'dither', 'dissolve'],
	timing: {},
	params: [
		slider('maxAmount', 'Max Amount', 0.2, { min: 0, softMax: 2 }),
		fxParam.vec2('relAmount', 'Rel Amount', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		...wrapParams('reflect'),
	],
	gpu: {
		uniforms: (p, ctx) => rampUniforms(p, ctx.progress),
		passes: [
			{
				include: [GLSL_SDW, GLSL_HASH],
				frag: /* glsl */ `
// A random offset per pixel and frame, up to Max Amount × Rel Amount (1.0 = an eighth of the frame width).
vec2 jitter(float k, int salt) {
  vec2 h = fx_hash22(ivec2(floor(tr_px())) + ivec2(salt * 7919, int(u_frame) * 104729), u_seed);
  return (h * 2.0 - 1.0) * u_maxAmount * u_relAmount * 0.125 * u_compSize.x * k / u_compSize;
}
void main() {
  ivec2 w = ivec2(u_wrapX, u_wrapY);
  vec4 a = sd_fromW(v_uv + jitter(u_rampA, 1), w);
  vec4 b = sd_toW(v_uv + jitter(u_rampB, 2), w);
  fragColor = mix(mix(a, b, u_sdMix), sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

const shakeAxis = (axis: 'x' | 'y' | 'z' | 'tilt', label: string, randAmp: number) =>
	grp(`${label} Shake`, [
		slider(`${axis}RandAmp`, `${label} Rand Amp`, randAmp, { min: 0, softMax: 2 }),
		slider(`${axis}RandFreq`, `${label} Rand Freq`, 1, { min: 0, softMax: 10 }),
		slider(`${axis}WaveAmp`, `${label} Wave Amp`, 0, { min: 0, softMax: 2 }),
		slider(`${axis}WaveFreq`, `${label} Wave Freq`, 0.5, { min: 0, softMax: 10 }),
		slider(`${axis}Phase`, `${label} Phase`, 0, { softMin: -1, softMax: 1 }),
	]);

/**
 * The shake poses of a frame (the S_Shake model of the distort family, `shakeUniforms`), with the amplitude scaled
 * by the envelope so the shake builds up to the peak and settles at both ends.
 */
function dissolveShakeUniforms(
	p: EffectParams,
	ctx: { frame: number; fps: number; seed: number; progress: number; width?: number; height?: number },
) {
	const env = dissolveTiming(p, ctx.progress).env;
	return shakeUniforms({ ...p, style: 'normal', amplitude: Math.max(0, num(p.amplitude, 3)) * env }, ctx);
}

export const S_DISSOLVE_SHAKE: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-shake',
	label: 'S_DissolveShake',
	description:
		'Shakes both clips (random, repeatable translation, zoom and rotation with motion blur) around a quick dissolve; the shake builds up to the cut and settles.',
	keywords: ['shake', 'camera shake', 'impact', 'earthquake', 'jitter', 'dissolve'],
	timing: { speed: 3 },
	params: [
		slider('amplitude', 'Amplitude', 3, { min: 0, softMax: 10 }),
		slider('frequency', 'Frequency', 10, { min: 0, softMax: 30, step: 0.1 }),
		check('motionBlur', 'Motion Blur', true),
		slider('moBlurLength', 'Mo Blur Length', 0.5, { min: 0, softMax: 2 }),
		seed(),
		...wrapParams('reflect'),
		...shakeAxis('x', 'X', 0.2),
		...shakeAxis('y', 'Y', 0.1),
		...shakeAxis('z', 'Z', 0),
		...shakeAxis('tilt', 'Tilt', 0),
		...grp('Channels', [
			slider('redAmplitude', 'Red Amplitude', 1, { min: 0, softMax: 2 }),
			slider('greenAmplitude', 'Green Amplitude', 1, { min: 0, softMax: 2 }),
			slider('blueAmplitude', 'Blue Amplitude', 1, { min: 0, softMax: 2 }),
			slider('redPhase', 'Red Phase', 0, { softMin: -1, softMax: 1 }),
			slider('greenPhase', 'Green Phase', 0, { softMin: -1, softMax: 1 }),
			slider('bluePhase', 'Blue Phase', 0, { softMin: -1, softMax: 1 }),
			slider('rgbRandomness', 'RGB Randomness', 0, { min: 0, softMax: 2 }),
			slider('rgbFrequency', 'RGB Frequency', 2, { min: 0, softMax: 10 }),
		]),
	],
	gpu: {
		uniforms: (p, ctx) => dissolveShakeUniforms(p, ctx),
		passes: [
			{
				include: [GLSL_SDW, GLSL_MB_POSES],
				frag: /* glsl */ `
// The picture at output f (frame units) under shake pose q = (dx, dy, cos θ / zoom, sin θ / zoom).
vec4 sh_src(vec2 f, vec4 q, ivec2 w) {
  vec2 d = f - q.xy;
  vec2 src = vec2(q.z * d.x + q.w * d.y, -q.w * d.x + q.z * d.y);
  vec2 uv = sdw_uvOfFrame(src);
  return mix(sd_fromW(uv, w), sd_toW(uv, w), u_sdMix);
}
${SHAKE_RENDER_GLSL}
void main() {
  vec2 f = sdw_frameOfPx(tr_px());
  fragColor = mix(sh_render(f, ivec2(u_wrapX, u_wrapY)), sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

export const TILE_COMBINES = ['fromOverTo', 'toOverFrom'] as const;

export const S_DISSOLVE_TILES: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-tiles',
	label: 'S_DissolveTiles',
	description:
		'The outgoing clip breaks into tiles whose pieces scramble and drift apart, then (after Dissolve Delay) dissolves away over the incoming clip, whose tiles unscramble into place (or on top: To Over From).',
	keywords: ['tiles', 'scramble', 'shatter', 'blocks', 'mosaic', 'break apart', 'dissolve'],
	timing: { slow: [0.2, 0.2] },
	params: [
		slider('scrambleSpeed', 'Scramble Speed', 2, { softMin: -5, softMax: 5 }),
		fxParam.vec2('scrambleRel', 'Scramble Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		slider('scrambleRelFrom', 'Scramble Rel From', 1, { softMin: -2, softMax: 2 }),
		slider('scrambleRelTo', 'Scramble Rel To', -1, { softMin: -2, softMax: 2 }),
		slider('tiles', 'Tiles', 10, { min: 1, softMax: 60, step: 0.1 }),
		slider('tileRelWidth', 'Tile Rel Width', 1, { min: 0.01, softMax: 4 }),
		slider('tileRelHeight', 'Tile Rel Height', 1, { min: 0.01, softMax: 4 }),
		slider('dissolveDelay', 'Dissolve Delay', 0.6, { min: 0, max: 1 }),
		fxParam.choice('combine', 'Combine', TILE_COMBINES, ['From Over To', 'To Over From'], 'fromOverTo'),
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		seed(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const t = dissolveTiming(p, ctx.progress).t;
			const delay = Math.min(0.99, Math.max(0, num(p.dissolveDelay, 0.6)));
			const fade = Math.min(1, Math.max(0, (t - delay) / (1 - delay)));
			const into = Math.min(1, Math.max(0, t / (1 - delay)));
			return { u_rampA: t, u_rampB: 1 - t, u_fadeFrom: fade, u_fadeTo: into };
		},
		passes: [
			{
				include: [GLSL_SDW, GLSL_NOISE],
				frag: /* glsl */ `
vec2 tileSize() { float s = u_compSize.x / max(u_tiles, 1.0); return vec2(s * u_tileRelWidth, s * u_tileRelHeight); }
// Offset (px) of the picture inside tile cell c for a scramble amount k: a smooth flow (neighbouring tiles carry
// similar offsets, so the picture appears to spread apart) plus a per-tile jitter.
vec2 tileMove(ivec2 c, float k, float salt) {
  vec2 q = vec2(c) * 0.3;
  vec2 flow = vec2(fx_simplex(q, fract(u_seed + salt)), fx_simplex(q + vec2(19.7, 7.3), fract(u_seed + salt + 0.5)));
  vec2 jit = fx_hash22(c, fract(u_seed + salt + 0.25)) - 0.5;
  vec2 d = (flow * 0.2 + jit * 0.15) * u_compSize.x * u_scrambleRel * k;
  return sdw_rot(u_rotateWarpDir) * d;
}
// The scrambled picture of one side: every tile of the grid shows its part of the picture moved by its offset
// (reflected at the frame edges), so the tiles always cover the frame.
vec4 scrambled(bool fromSide, float k, float salt) {
  if (abs(k) < 1e-5) return fromSide ? tr_from(v_uv) : tr_to(v_uv);
  vec2 px = tr_px();
  ivec2 c = ivec2(floor(px / tileSize()));
  vec2 uv = sd_wrapUv((px - tileMove(c, k, salt)) / u_compSize, ivec2(2));
  return fromSide ? tr_from(uv) : tr_to(uv);
}
void main() {
  float ka = u_scrambleSpeed * u_scrambleRelFrom * u_rampA;
  float kb = u_scrambleSpeed * u_scrambleRelTo * u_rampB;
  vec4 a = scrambled(true, ka, 0.13);
  vec4 b = scrambled(false, kb, 0.61);
  // The layer underneath fades in (out) over the first (last) tenth, so a missing side stays missing at the ends.
  vec4 c = u_combine == 0 ? tr_over(a * (1.0 - u_fadeFrom), b * clamp(u_sdT * 10.0, 0.0, 1.0))
                          : tr_over(b * u_fadeTo, a * clamp((1.0 - u_sdT) * 10.0, 0.0, 1.0));
  fragColor = mix(c, sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

export const WARP_DISSOLVES = [
	S_DISSOLVE_BUBBLE,
	S_DISSOLVE_DIFFUSE,
	S_DISSOLVE_DISTORT,
	S_DISSOLVE_PUDDLE,
	S_DISSOLVE_SHAKE,
	S_DISSOLVE_TILES,
	S_DISSOLVE_VORTEX,
	S_DISSOLVE_WAVES,
] as const;

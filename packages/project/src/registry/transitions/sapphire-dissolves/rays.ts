// Sapphire-style ray dissolves: S_DissolveRays (light — or dark — beams streaming out of the bright — or dark —
// areas) and S_DissolveEdgeRays (beams streaming out of the edges). The rays beam outwards from a centre that travels
// across the frame along a line (Rays Center Speed / Angle), ramping up to the peak and back while the clips dissolve.
// Parameters follow Boris FX's public Sapphire documentation; clean-room implementations.
//
// Compact version of the (not yet merged) Sapphire rays family: the ray source (threshold or edges of the dissolve,
// modulated by shimmer noise) at a reduced resolution (Rays Res), then three cascaded radial blurs towards the
// centre (each covers a third of the length in log scale, 16 jittered taps: a smooth streak of 16³ effective taps),
// per-channel lengths, reverse rays; atmosphere noise and the composite at full resolution.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import {
	blurPx,
	check,
	clamp,
	color,
	defineDissolve,
	dissolveTiming,
	GLSL_SD,
	GLSL_SD_NOISE,
	grp,
	num,
	sapphirePoint,
	seed,
	slider,
	vec2,
} from './common.ts';

export const RAYS_RES = ['full', 'half', 'quarter'] as const;

/** Rays Res → pass resolution (the rays are always computed at ≤ ½ resolution; Full = ½, Half = ¼, Quarter = ⅛). */
const raysScale = (p: EffectParams): number =>
	p.raysRes === 'quarter' ? 0.125 : p.raysRes === 'half' ? 0.25 : 0.5;

/**
 * Per-frame ray geometry: the centre (uv) on its path, and per channel the per-pass scale towards the centre
 * (outward rays: (1 + L)^(−1/3)) and away from it (Reverse Rays: (1 + L·rev)^(1/3)).
 */
function raysGeometry(p: EffectParams, ctx: { width: number; height: number; t: number; env: number }) {
	const c = vec2(p.raysCenter, [0.5, 0.5]);
	const a = (num(p.raysCenterAngle, 0) * Math.PI) / 180;
	const travel = clamp(num(p.raysCenterSpeed, 0.2), 0, 2) * (ctx.t - 0.5) * 2;
	// Sapphire units: half widths, y up.
	const cx = c[0] + (Math.cos(a) * travel) / 2;
	const cy = c[1] - (Math.sin(a) * travel * ctx.width) / ctx.height / 2;
	const shrink = clamp(num(p.raysShrink, 0), 0, 1);
	const L = Math.min(2, num(p.raysLength, 0.75)) * (1 - shrink + shrink * ctx.env);
	const rel = [num(p.lengthRed, 1), num(p.lengthGreen, 1), num(p.lengthBlue, 1)].map((x) => Math.max(0, x));
	const rev = Math.max(0, num(p.reverseRays, 0));
	// A negative length points the rays inwards (towards the centre).
	const inward = (x: number) => (x >= 0 ? (1 + x) ** (-1 / 3) : (1 - x) ** (1 / 3));
	const sMin = rel.map((r) => inward(L * r)) as [number, number, number];
	const sMax = rel.map((r) => (1 + Math.abs(L) * r * rev) ** (1 / 3)) as [number, number, number];
	const fade = clamp(num(p.raysFade, 1), 0, 1);
	return {
		u_raysCenterUv: [cx, cy] as [number, number],
		u_sMin: sMin,
		u_sMax: sMax,
		u_rgbSplit: rel[0] !== rel[1] || rel[1] !== rel[2],
		u_revRays: rev > 0,
		u_raysEnv: 1 - fade + fade * ctx.env,
	};
}

const commonRayParams = (): ParamSpec[] => [
	fxParam.point('raysCenter', 'Rays Center', sapphirePoint(0, 0)),
	slider('raysCenterSpeed', 'Rays Center Speed', 0.2, { min: 0, max: 2 }),
	fxParam.angle('raysCenterAngle', 'Rays Center Angle', 0),
	slider('raysLength', 'Rays Length', 0.75, { min: -1, max: 2 }),
	slider('lengthRed', 'Length Red', 1, { min: 0, softMax: 2 }),
	slider('lengthGreen', 'Length Green', 1, { min: 0, softMax: 2 }),
	slider('lengthBlue', 'Length Blue', 1, { min: 0, softMax: 2 }),
	slider('reverseRays', 'Reverse Rays', 0, { min: 0, softMax: 2 }),
	slider('raysShrink', 'Rays Shrink', 0, { min: 0, max: 1 }),
	slider('raysBrightness', 'Rays Brightness', 8, { min: 0, softMax: 20 }),
];

const shimmerAtmosphereParams = (shimmerFreqMin: number): ParamSpec[] => [
	...grp('Shimmer', [
		slider('shimmerAmp', 'Shimmer Amp', 0.5, { min: 0, softMax: 2 }),
		slider('shimmerFreq', 'Shimmer Freq', 40, { min: shimmerFreqMin, softMax: 200, step: 0.1 }),
		seed('Shimmer Seed'),
		fxParam.vec2('shimmerShift', 'Shimmer Shift', [0, 0], { softMin: -2, softMax: 2, step: 0.001 }),
		fxParam.vec2('shimmerSpeed', 'Shimmer Speed', [0, 0], { softMin: -2, softMax: 2, step: 0.001 }),
	]),
	...grp('Atmosphere', [
		slider('atmosphereAmp', 'Atmosphere Amp', 0, { min: 0, softMax: 4 }),
		slider('atmosphereFreq', 'Atmosphere Freq', 1, { min: 0.1, max: 20 }),
		slider('atmosphereDetail', 'Atmosphere Detail', 0.6, { min: 0, max: 1 }),
		slider('atmosphereSpeed', 'Atmosphere Speed', 1, { softMin: -4, softMax: 4 }),
	]),
	slider('affectAlpha', 'Affect Alpha', 1, { min: 0, softMax: 2 }),
	slider('raysFromAlpha', 'Rays From Alpha', 0, { min: 0, max: 1 }),
	slider('sourceOpacity', 'Source Opacity', 1, { min: 0, max: 1 }),
];

/** Shimmer: the ray source modulated by noise (Amp, Freq per frame width, Shift + Speed × time). */
const SHIMMER_GLSL = /* glsl */ `
float shimmer() {
  if (u_shimmerAmp <= 0.0) return 1.0;
  vec2 q = (tr_px() / u_compSize.x - u_shimmerShift - u_shimmerSpeed * u_time) * u_shimmerFreq;
  float n = sd_fbm(q, 2, 0.5, u_seed);
  return max(0.0, 1.0 + u_shimmerAmp * n * 1.5);
}`;

/** One cascaded radial blur pass towards (and, with Reverse Rays, away from) the rays centre. */
function radialPass(input: string, output: string, scale: number): ShaderPass {
	return {
		output,
		scale,
		format: 'rgba16f',
		include: [GLSL_SD, GLSL_SD_NOISE],
		frag: /* glsl */ `
float rw(float u) { return mix(1.0 - u, u, clamp(u_biasOuterBright, 0.0, 1.0)) + 0.02; }
vec3 tap(vec2 c, vec2 d, vec3 s) {
  if (!u_rgbSplit) return texture(u_${input}, c + d * s.g).rgb;
  return vec3(texture(u_${input}, c + d * s.r).r, texture(u_${input}, c + d * s.g).g, texture(u_${input}, c + d * s.b).b);
}
void main() {
  vec2 res = vec2(textureSize(u_${input}, 0));
  vec2 c = u_raysCenterUv;
  vec2 d = v_uv - c;
  float jit = sd_h2(ivec2(v_uv * res), ${output.length * 131}u);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  int n = 16;
  for (int j = 0; j < n; j++) {
    float u = (float(j) + jit) / float(n);
    float w = rw(u);
    acc += tap(c, d, mix(vec3(1.0), u_sMin, u)) * w;
    wsum += w;
  }
  if (u_revRays) {
    for (int j = 0; j < n; j++) {
      float u = (float(j) + jit) / float(n);
      float w = rw(u);
      acc += tap(c, d, mix(vec3(1.0), u_sMax, u)) * w;
      wsum += w;
    }
  }
  fragColor = vec4(acc / wsum, 1.0);
}`,
	};
}

/** The final composite of both ray dissolves: atmosphere, Blur Rays, Source Opacity, light / dark rays. */
const RAYS_FINAL = /* glsl */ `
vec3 raysAt(vec2 uv) { return sd_bicubic(u_r3, uv).rgb; }
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec3 rays = raysAt(v_uv);
  if (u_blurRaysPx > 0.0) {
    vec2 o = u_blurRaysPx * u_blurRaysRel / u_compSize;
    rays = rays * 0.4 + 0.15 * (raysAt(v_uv + vec2(o.x, 0.0)) + raysAt(v_uv - vec2(o.x, 0.0)) + raysAt(v_uv + vec2(0.0, o.y)) + raysAt(v_uv - vec2(0.0, o.y)));
  }
  if (u_atmosphereAmp > 0.0) {
    vec2 q = tr_px() / u_compSize.x * u_atmosphereFreq * 4.0;
    int oct = 1 + int(u_atmosphereDetail * 5.0);
    float n = sd_fbm3(vec3(q, u_time * u_atmosphereSpeed * 0.5), oct, 0.5 + 0.2 * u_atmosphereDetail, fract(u_seed + 0.37));
    rays *= max(0.0, 1.0 + u_atmosphereAmp * n * 1.5);
  }
  rays *= u_raysEnv * u_sdEnv;
  base *= mix(1.0, u_sourceOpacity, u_sdEnv);
  fragColor = mix(raysComposite(base, rays), sd_dissolve(), u_mixWithDissolve);
}`;

function rayUniforms(p: EffectParams, ctx: { width: number; height: number; progress: number }) {
	const d = dissolveTiming(p, ctx.progress);
	return {
		...raysGeometry(p, { width: ctx.width, height: ctx.height, t: d.t, env: d.env }),
		u_blurRaysPx: blurPx(p.blurRays, ctx.width),
	};
}

export const S_DISSOLVE_RAYS: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-rays',
	expensive: true,
	label: 'S_DissolveRays',
	description:
		'Dissolves through beams of light streaming out of the bright areas (or beams of darkness out of the dark areas) from a centre that drifts across the frame; the rays peak mid-way.',
	keywords: ['rays', 'god rays', 'light rays', 'beams', 'volumetric', 'dissolve'],
	timing: { speed: 3 },
	params: [
		fxParam.choice('mode', 'Mode', ['light', 'dark'], ['Light Rays', 'Dark Rays'], 'light'),
		...commonRayParams(),
		slider('raysDarkness', 'Rays Darkness', 8, { min: 0, softMax: 20 }),
		slider('raysFade', 'Rays Fade', 1, { min: 0, max: 1 }),
		slider('blurRays', 'Blur Rays', 0, { min: 0, softMax: 2 }),
		fxParam.vec2('blurRaysRel', 'Blur Rays Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		color('raysColor', 'Rays Color', [1, 1, 1]),
		color('darkRaysColor', 'Dark Rays Color', [0, 0, 0]),
		slider('biasOuterBright', 'Bias Outer Bright', 0, { min: 0, max: 1 }),
		fxParam.choice('raysRes', 'Rays Res', RAYS_RES, ['Full', 'Half', 'Quarter'], 'full'),
		slider('threshold', 'Threshold', 0.5, { min: 0, softMax: 1 }),
		color('thresholdAddColor', 'Threshold Add Color', [0, 0, 0]),
		...shimmerAtmosphereParams(0.1),
		slider('useSourceChroma', 'Use Source Chroma', 1, { min: 0, softMax: 1 }),
	],
	gpu: {
		uniforms: (p, ctx) => rayUniforms(p, ctx),
		passes: (p): ShaderPass[] => {
			const s = raysScale(p);
			return [
				{
					// Ray source: the bright (Light) or dark (Dark) parts of the dissolve, shimmer-modulated.
					output: 'raySrc',
					scale: s,
					format: 'rgba16f',
					include: [GLSL_SD, GLSL_SD_NOISE],
					frag: /* glsl */ `
${SHIMMER_GLSL}
void main() {
  vec4 c = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec3 st = c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
  vec3 thr = vec3(u_threshold) + u_thresholdAddColor.rgb;
  vec3 src;
  if (u_mode == 0) {
    src = max(st - thr, 0.0) / max(1.0 - thr, vec3(0.05)) * c.a;
    float l = fx_luma(src);
    src = mix(vec3(l), src, clamp(u_useSourceChroma, 0.0, 1.0));
    src = mix(src, vec3(smoothstep(u_threshold, 1.0, c.a)), u_raysFromAlpha);
  } else {
    float l = fx_luma(st);
    src = vec3(max(u_threshold - l, 0.0) / max(u_threshold, 0.05) * c.a);
    src = mix(src, vec3(1.0 - c.a), u_raysFromAlpha);
  }
  fragColor = vec4(src * shimmer(), 1.0);
}`,
				},
				radialPass('raySrc', 'r1', s),
				radialPass('r1', 'r2', s),
				radialPass('r2', 'r3', s),
				{
					include: [GLSL_SD, GLSL_SD_NOISE],
					frag: /* glsl */ `
vec4 raysComposite(vec4 base, vec3 rays) {
  if (u_mode == 1) {
    float k = clamp(fx_luma(rays) * u_raysDarkness * 0.4, 0.0, 1.0);
    return vec4(mix(base.rgb, u_darkRaysColor.rgb * base.a, k), base.a);
  }
  return sd_lightOver(base, rays * u_raysColor.rgb * u_raysBrightness * 0.4, u_affectAlpha, false);
}
${RAYS_FINAL}`,
				},
			];
		},
	},
});

/** Edge Thickness (Sapphire units) → sampling offset in frame px (1.0 = 5 % of the frame width). */
export const edgeThicknessPx = (p: EffectParams, width: number) =>
	Math.max(0.5, num(p.edgeThickness, 0.022) * 0.05 * width);

export const S_DISSOLVE_EDGE_RAYS: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-edge-rays',
	label: 'S_DissolveEdgeRays',
	description:
		'Dissolves through rays of light streaming out of the edges of the pictures from a centre that drifts across the frame (shimmer, atmosphere, colour fringing); the rays peak mid-way.',
	keywords: ['edge rays', 'rays', 'edges', 'light beams', 'outline', 'dissolve'],
	timing: { speed: 3 },
	params: [
		...commonRayParams(),
		slider('raysFade', 'Rays Fade', 1, { min: 0, max: 1 }),
		slider('blurRays', 'Blur Rays', 0, { min: 0, softMax: 2 }),
		fxParam.vec2('blurRaysRel', 'Blur Rays Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		color('raysColor', 'Rays Color', [1, 1, 1]),
		check('enableDarkRays', 'Enable Dark Rays', false),
		slider('biasOuterBright', 'Bias Outer Bright', 0, { min: 0, max: 1 }),
		fxParam.choice('raysRes', 'Rays Res', RAYS_RES, ['Full', 'Half', 'Quarter'], 'full'),
		fxParam.choice('show', 'Show', ['result', 'edges'], ['Result', 'Edges'], 'result'),
		slider('edgeThickness', 'Edge Thickness', 0.022, { min: 0, softMax: 0.2, step: 0.001 }),
		slider('edgeBrightness', 'Edge Brightness', 1, { min: 0, softMax: 4 }),
		...shimmerAtmosphereParams(0.01),
	],
	gpu: {
		uniforms: (p, ctx) => ({ ...rayUniforms(p, ctx), u_edgePx: edgeThicknessPx(p, ctx.width) }),
		passes: (p): ShaderPass[] => {
			const s = raysScale(p);
			return [
				{
					// Ray source: the edges of the dissolve (colour gradient at Edge Thickness), shimmer-modulated.
					output: 'raySrc',
					scale: s,
					format: 'rgba16f',
					include: [GLSL_SD, GLSL_SD_NOISE],
					frag: /* glsl */ `
${SHIMMER_GLSL}
vec4 at(vec2 uv) { return mix(tr_from(uv), tr_to(uv), u_sdMix); }
void main() {
  vec2 h = vec2(max(u_edgePx, 0.5 / ${s.toFixed(4)})) / u_compSize;
  vec4 l = at(v_uv - vec2(h.x, 0.0)), r = at(v_uv + vec2(h.x, 0.0));
  vec4 t = at(v_uv - vec2(0.0, h.y)), b = at(v_uv + vec2(0.0, h.y));
  vec4 gx = r - l, gy = b - t;
  vec4 e = sqrt(gx * gx + gy * gy);
  vec3 src = mix(e.rgb, vec3(e.a), u_raysFromAlpha) * u_edgeBrightness * 1.5;
  fragColor = vec4(src * shimmer(), 1.0);
}`,
				},
				radialPass('raySrc', 'r1', s),
				radialPass('r1', 'r2', s),
				radialPass('r2', 'r3', s),
				{
					include: [GLSL_SD, GLSL_SD_NOISE],
					frag: /* glsl */ `
vec4 raysComposite(vec4 base, vec3 rays) {
  if (u_show == 1) return vec4(min(sd_bicubic(u_raySrc, v_uv).rgb, vec3(1.0)), 1.0);
  vec3 col = u_enableDarkRays ? 2.0 * u_raysColor.rgb - 1.0 : u_raysColor.rgb;
  vec3 delta = rays * col * u_raysBrightness * 0.4;
  if (!u_enableDarkRays) return sd_lightOver(base, delta, u_affectAlpha, false);
  float a = clamp(max(base.a, sd_maxc(max(delta, 0.0)) * u_affectAlpha), 0.0, 1.0);
  return vec4(clamp(base.rgb + delta, 0.0, a), a);
}
${RAYS_FINAL}`,
				},
			];
		},
	},
});

export const RAYS_DISSOLVES = [S_DISSOLVE_EDGE_RAYS, S_DISSOLVE_RAYS] as const;

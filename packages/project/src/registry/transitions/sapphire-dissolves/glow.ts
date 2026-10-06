// Sapphire-style glowing dissolves: S_DissolveGlow (both clips glow up to a bright flash at the peak),
// S_DissolveUltraGlow (glow + after-glow + streaks, optional edge detection and atmosphere) and S_DissolveLightLeak
// (moving coloured light-leak blobs screened over the dissolve, plus a glow). Parameters follow Boris FX's public
// Sapphire documentation; clean-room implementations.
//
// The glows here are compact versions of the (not yet merged) Sapphire glows family: threshold → a two-scale blur
// (σ/5 at ½ resolution + σ at ¼ resolution, rgba16f, per-channel widths) → added as light. Light amounts scale with
// the envelope (0 at both ends), so the ends are exactly A and B.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';

import { fxParam } from '../../fx/params.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import {
	blurPasses,
	check,
	clamp,
	color,
	defineDissolve,
	dissolveTiming,
	GLSL_SD,
	GLSL_SD_BLUR,
	GLSL_SD_GLOW,
	GLSL_SD_NOISE,
	glowPasses,
	grp,
	num,
	rgb,
	SAPPHIRE_GLOW_UNIT,
	sapphirePoint,
	seed,
	slider,
	vec2,
} from './common.ts';

/** Light gain of the glows (Sapphire's brightness numbers → this family's two-scale glow). */
export const GLOW_GAIN = 0.1;

/** Glow σ (frame px, x / y) of the wide component for a Sapphire glow width, mixed between the two sides' widths. */
export function glowSigma(p: EffectParams, width: number, mix: number, widthName = 'glowWidth', def = 0.4) {
	const w = Math.max(0, num(p[widthName], def)) * SAPPHIRE_GLOW_UNIT * width;
	const rel = num(p.relFromWidth, 1) * (1 - mix) + num(p.relToWidth, 1) * mix;
	return [w * Math.max(0, num(p.widthX, 1)) * rel, w * Math.max(0, num(p.widthY, 1)) * rel] as [
		number,
		number,
	];
}

// ---------------------------------------------------------------- S_DissolveGlow

export const relSideParams = (side: 'From' | 'To', what = 'Width') =>
	grp(`Rel ${side}`, [
		slider(`rel${side}Brightness`, `Rel ${side} Brightness`, 1, { min: 0, softMax: 4 }),
		slider(`rel${side}${what}`, `Rel ${side} ${what}`, 1, { min: 0, softMax: 4 }),
		slider(`${side.toLowerCase()}OffsetThreshold`, `${side} Offset Threshold`, 0, {
			softMin: -1,
			softMax: 1,
		}),
		color(`rel${side}Color`, `Rel ${side} Color`, [1, 1, 1]),
	]);

/** The thresholded light of both sides, each weighted by its share of the dissolve (½ resolution, rgba16f). */
export const brightPass = (thresholdExpr: string): ShaderPass => ({
	output: 'bright',
	scale: 0.5,
	format: 'rgba16f',
	include: [GLSL_SD],
	frag: /* glsl */ `
vec3 lightOf(vec4 c, float thr) { return c.a > 0.0 ? sd_threshold(clamp(c.rgb / c.a, 0.0, 1.0), thr) * c.a : vec3(0.0); }
void main() {
  // Box-average the 2×2 full-resolution pixels under this texel.
  vec2 o = 0.25 / u_resolution;
  vec4 a = 0.25 * (tr_from(v_uv + vec2(-o.x, -o.y)) + tr_from(v_uv + vec2(o.x, -o.y)) + tr_from(v_uv + vec2(-o.x, o.y)) + tr_from(v_uv + o));
  vec4 b = 0.25 * (tr_to(v_uv + vec2(-o.x, -o.y)) + tr_to(v_uv + vec2(o.x, -o.y)) + tr_to(v_uv + vec2(-o.x, o.y)) + tr_to(v_uv + o));
  vec3 la = lightOf(a, ${thresholdExpr} + u_fromOffsetThreshold) * u_relFromBrightness * u_relFromColor.rgb;
  vec3 lb = lightOf(b, ${thresholdExpr} + u_toOffsetThreshold) * u_relToBrightness * u_relToColor.rgb;
  fragColor = vec4(la * (1.0 - u_sdMix) + lb * u_sdMix, 1.0);
}`,
});

export const S_DISSOLVE_GLOW: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-glow',
	label: 'S_DissolveGlow',
	description:
		'Dissolves through a bright glowing flash: both clips glow (threshold, width, per-channel widths, colours) more and more towards the peak while they cross-fade.',
	keywords: ['glow', 'flash', 'bloom', 'dissolve', 'light', 'white flash'],
	timing: { speed: 3 },
	params: [
		slider('glowBrightness', 'Glow Brightness', 6, { min: 0, softMax: 20 }),
		slider('glowThreshold', 'Glow Threshold', 0.2, { min: 0, softMax: 1 }),
		color('glowColor', 'Glow Color', [1, 1, 1]),
		slider('glowWidth', 'Glow Width', 0.4, { min: 0, softMax: 4 }),
		slider('widthX', 'Width X', 1, { min: 0, softMax: 4 }),
		slider('widthY', 'Width Y', 1, { min: 0, softMax: 4 }),
		slider('widthRed', 'Width Red', 1, { min: 0, softMax: 4 }),
		slider('widthGreen', 'Width Green', 1.2, { min: 0, softMax: 4 }),
		slider('widthBlue', 'Width Blue', 1.4, { min: 0, softMax: 4 }),
		...relSideParams('From'),
		...relSideParams('To'),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const d = dissolveTiming(p, ctx.progress);
			return { u_glowSigma: glowSigma(p, ctx.width, d.mix) };
		},
		passes: [
			brightPass('u_glowThreshold'),
			...glowPasses({
				input: 'bright',
				prefix: 'glow',
				sigma: 'u_glowSigma',
				rgb: 'vec3(u_widthRed, u_widthGreen, u_widthBlue)',
			}),
			{
				include: [GLSL_SD_GLOW],
				frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  // A zero width still enhances the bright areas (the unblurred light).
  vec3 g = sd_glow(u_glowNear, u_glowFar, 0.0) + 0.5 * sd_bicubic(u_bright, v_uv).rgb;
  vec3 light = g * u_glowColor.rgb * u_glowBrightness * ${GLOW_GAIN} * u_sdEnv;
  fragColor = mix(sd_lightOver(base, light, 1.0, false), sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_DissolveUltraGlow

export const S_DISSOLVE_ULTRA_GLOW: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-ultra-glow',
	label: 'S_DissolveUltraGlow',
	description:
		'Dissolves through glowing flashes with Sapphire UltraGlow controls: glow falloff and bias, a stretched after-glow, horizontal / vertical streaks, optional edge detection and atmospheric noise.',
	keywords: ['ultra glow', 'glow', 'after glow', 'streaks', 'flash', 'bloom', 'dissolve'],
	timing: { speed: 3 },
	params: [
		slider('brightness', 'Brightness', 1.7, { min: 0, softMax: 10 }),
		color('glowColor', 'Color', [1, 1, 1]),
		slider('threshold', 'Threshold', 0.2, { min: 0, softMax: 1 }),
		color('thresholdAddColor', 'Threshold Add Color', [0, 0, 0]),
		slider('glowWidth', 'Glow Width', 0.371, { min: 0, softMax: 4 }),
		slider('glowFalloff', 'Glow Falloff', 0.35, { min: -2, max: 2 }),
		slider('glowBias', 'Glow Bias', 0, { min: -3, max: 3 }),
		slider('glowFromAlpha', 'Glow From Alpha', 0, { min: 0, max: 1 }),
		slider('widthX', 'Width X', 1, { min: 0, softMax: 4 }),
		slider('widthY', 'Width Y', 1, { min: 0, softMax: 4 }),
		slider('widthRed', 'Width Red', 1, { min: 0, softMax: 4 }),
		slider('widthGreen', 'Width Green', 1, { min: 0, softMax: 4 }),
		slider('widthBlue', 'Width Blue', 1, { min: 0, softMax: 4 }),
		fxParam.choice('show', 'Show', ['result', 'threshold'], ['Result', 'Threshold'], 'result'),
		...grp('After Glow', [
			slider('afterGlowWidth', 'After Glow Width', 1.8, { min: 0, softMax: 6 }),
			color('afterGlowColor', 'After Glow Color', [1, 1, 1]),
			slider('afterGlowStretchX', 'After Glow Stretch X', 0.3, { min: 0, softMax: 4 }),
			slider('afterGlowStretchY', 'After Glow Stretch Y', 0.1, { min: 0, softMax: 4 }),
		]),
		...grp('Streaks', [
			slider('horizontalStreaks', 'Horizontal Streaks', 0, { min: 0, softMax: 4 }),
			slider('verticalStreaks', 'Vertical Streaks', 0, { min: 0, softMax: 4 }),
		]),
		...grp('Edges', [
			check('edgeDetect', 'Edge Detect', false),
			fxParam.choice(
				'edgeCombine',
				'Edge Combine',
				['screen', 'add', 'edgesOnly'],
				['Screen', 'Add', 'Edges Only'],
				'edgesOnly',
			),
			slider('edgeSmooth', 'Edge Smooth', 0, { min: 0, softMax: 4 }),
			slider('edgeThin', 'Edge Thin', 0.1, { min: 0, softMax: 1 }),
		]),
		...grp('Atmosphere', [
			check('atmosphere', 'Atmosphere', false),
			slider('atmosphereAmp', 'Atmosphere Amp', 1, { min: 0, softMax: 4 }),
			slider('atmosphereFreq', 'Atmosphere Freq', 11.6, { min: 0.1, max: 20 }),
			slider('atmosphereDetail', 'Atmosphere Detail', 0.506, { min: 0, max: 1 }),
			slider('atmosphereSpeed', 'Atmosphere Speed', 1, { softMin: -4, softMax: 4 }),
			slider('atmosphereLights', 'Atmosphere Lights', 0.5, { min: 0, softMax: 4 }),
			slider('atmosphereDarks', 'Atmosphere Darks', 0, { softMin: -1, softMax: 1 }),
			seed('Atmosphere Seed'),
			check('applyPreGlow', 'Apply Pre-Glow', false),
		]),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const w = Math.max(0, num(p.glowWidth, 0.371)) * SAPPHIRE_GLOW_UNIT * ctx.width;
			const after = w * Math.max(0, num(p.afterGlowWidth, 1.8));
			return {
				u_glowSigma: [w * Math.max(0, num(p.widthX, 1)), w * Math.max(0, num(p.widthY, 1))],
				u_afterSigma: [
					after * Math.max(0, num(p.afterGlowStretchX, 0.3)),
					after * Math.max(0, num(p.afterGlowStretchY, 0.1)),
				],
				u_streakPx: 0.25 * ctx.width,
			};
		},
		passes: [
			{
				// Threshold (+ optional edges and pre-glow atmosphere) of both sides, weighted by the dissolve.
				output: 'bright',
				scale: 0.5,
				format: 'rgba16f',
				include: [GLSL_SD, GLSL_SD_NOISE],
				frag: /* glsl */ `
float atmos(vec2 uv) {
  vec2 q = uv * vec2(u_compSize.x / u_compSize.y, 1.0) * u_atmosphereFreq * 0.5;
  int oct = 1 + int(u_atmosphereDetail * 6.0);
  float n = 0.5 + 0.5 * sd_fbm3(vec3(q, u_time * u_atmosphereSpeed * 0.5), oct, 0.5 + 0.2 * u_atmosphereDetail, u_seed);
  return max(0.0, mix(1.0, n * 2.0, clamp(u_atmosphereAmp, 0.0, 4.0) * 0.5) * (u_atmosphereLights * 2.0) + u_atmosphereDarks);
}
vec3 edges(bool fromSide, vec2 uv) {
  vec2 h = (1.0 + u_edgeSmooth * 6.0) / u_compSize;
  vec4 l = fromSide ? tr_from(uv - vec2(h.x, 0.0)) : tr_to(uv - vec2(h.x, 0.0));
  vec4 r = fromSide ? tr_from(uv + vec2(h.x, 0.0)) : tr_to(uv + vec2(h.x, 0.0));
  vec4 t = fromSide ? tr_from(uv - vec2(0.0, h.y)) : tr_to(uv - vec2(0.0, h.y));
  vec4 b = fromSide ? tr_from(uv + vec2(0.0, h.y)) : tr_to(uv + vec2(0.0, h.y));
  vec3 e = sqrt((r.rgb - l.rgb) * (r.rgb - l.rgb) + (b.rgb - t.rgb) * (b.rgb - t.rgb));
  return max(e * 2.0 - u_edgeThin, 0.0);
}
vec3 lightOf(bool fromSide) {
  vec4 c = fromSide ? tr_from(v_uv) : tr_to(v_uv);
  vec3 s = c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
  if (u_edgeDetect) {
    vec3 e = edges(fromSide, v_uv);
    s = u_edgeCombine == 0 ? 1.0 - (1.0 - s) * (1.0 - min(e, 1.0)) : u_edgeCombine == 1 ? s + e : e;
  }
  vec3 thr = vec3(u_threshold) + u_thresholdAddColor.rgb;
  vec3 l = max(s - thr, 0.0) / max(1.0 - thr, vec3(0.05));
  l = pow(l, vec3(exp2(-u_glowBias)));
  l = mix(l * c.a, vec3(smoothstep(u_threshold, 1.0, c.a)), u_glowFromAlpha);
  return l;
}
void main() {
  vec3 l = lightOf(true) * (1.0 - u_sdMix) + lightOf(false) * u_sdMix;
  if (u_atmosphere && u_applyPreGlow) l *= atmos(v_uv);
  fragColor = vec4(l, 1.0);
}`,
			},
			...glowPasses({
				input: 'bright',
				prefix: 'glow',
				sigma: 'u_glowSigma',
				rgb: 'vec3(u_widthRed, u_widthGreen, u_widthBlue)',
			}),
			// The after-glow: the wide glow blurred again, stretched (Stretch X / Y).
			...blurPasses({
				input: 'glowFar',
				output: 'after',
				scale: 0.25,
				sigma: 'u_afterSigma',
				format: 'rgba16f',
			}),
			{
				// Horizontal and vertical streaks: long 1D blurs of the threshold (r,g,b = H, alpha unused; V summed in).
				output: 'streaks',
				scale: 0.25,
				format: 'rgba16f',
				include: [GLSL_SD_BLUR],
				frag: /* glsl */ `
void main() {
  vec2 isz = vec2(textureSize(u_bright, 0));
  float s = u_streakPx * isz.x / u_compSize.x;
  vec4 h = u_horizontalStreaks > 0.0 ? sd_blur1(u_bright, v_uv, vec2(1.0 / isz.x, 0.0), vec3(s), 2) : vec4(0.0);
  vec4 v = u_verticalStreaks > 0.0 ? sd_blur1(u_bright, v_uv, vec2(0.0, 1.0 / isz.y), vec3(s * 0.5), 2) : vec4(0.0);
  fragColor = vec4(h.rgb * u_horizontalStreaks + v.rgb * u_verticalStreaks, 1.0);
}`,
			},
			{
				include: [GLSL_SD_GLOW, GLSL_SD_NOISE],
				frag: /* glsl */ `
float atmos(vec2 uv) {
  vec2 q = uv * vec2(u_compSize.x / u_compSize.y, 1.0) * u_atmosphereFreq * 0.5;
  int oct = 1 + int(u_atmosphereDetail * 6.0);
  float n = 0.5 + 0.5 * sd_fbm3(vec3(q, u_time * u_atmosphereSpeed * 0.5), oct, 0.5 + 0.2 * u_atmosphereDetail, u_seed);
  return max(0.0, mix(1.0, n * 2.0, clamp(u_atmosphereAmp, 0.0, 4.0) * 0.5) * (u_atmosphereLights * 2.0) + u_atmosphereDarks);
}
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  if (u_show == 1) {
    vec3 t = sd_bicubic(u_bright, v_uv).rgb;
    fragColor = vec4(min(t, vec3(1.0)), 1.0);
    return;
  }
  vec3 g = sd_glow(u_glowNear, u_glowFar, u_glowFalloff) * u_glowColor.rgb
         + sd_bicubic(u_after, v_uv).rgb * u_afterGlowColor.rgb * 0.75
         + sd_bicubic(u_streaks, v_uv).rgb * 2.0
         + 0.5 * sd_bicubic(u_bright, v_uv).rgb;
  if (u_atmosphere && !u_applyPreGlow) g *= atmos(v_uv);
  vec3 light = g * u_brightness * ${GLOW_GAIN * 2} * u_sdEnv;
  fragColor = mix(sd_lightOver(base, light, 1.0, false), sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_DissolveLightLeak

export const LEAK_SCALE_MODES = ['no', 'sizeUpDown', 'sizeUp', 'sizeDown'] as const;
export const LEAK_COMBINES = ['screen', 'add', 'leaksOnly'] as const;

type LeakDefaults = {
	enable: boolean;
	size: number;
	relHeight: number;
	brightness: number;
	speed: number;
	angle: number;
	center: [number, number];
	outer: [number, number, number];
	mid: [number, number, number];
	inner: [number, number, number];
	midpoint: number;
	softness: number;
	noiseAmp: number;
	noiseFreq: number;
	noiseBoil: number;
};

const LEAK_ELEMENTS: LeakDefaults[] = [
	{
		enable: true,
		size: 2,
		relHeight: 2,
		brightness: 2.4,
		speed: 1,
		angle: -30,
		center: [0, -0.1],
		outer: [1, 1, 1],
		mid: [0, 0.15, 1],
		inner: [1, 0.1, 0],
		midpoint: 0.5,
		softness: 0.4,
		noiseAmp: 2,
		noiseFreq: 1.5,
		noiseBoil: 1,
	},
	{
		enable: true,
		size: 2,
		relHeight: 2,
		brightness: 1,
		speed: 1,
		angle: 0,
		center: [0, 0],
		outer: [0.25, 0.15, 0.1],
		mid: [0.7, 0.12, 0.22],
		inner: [1, 1, 1],
		midpoint: 0.5,
		softness: 0.4,
		noiseAmp: 1,
		noiseFreq: 3,
		noiseBoil: 0,
	},
	{
		enable: false,
		size: 0.4,
		relHeight: 0.1,
		brightness: 1.6,
		speed: 4.4,
		angle: 173,
		center: [-0.1, -0.4],
		outer: [1, 1, 1],
		mid: [1, 0, 0],
		inner: [0.05, 0, 1],
		midpoint: 0.5,
		softness: 1.8,
		noiseAmp: 0.5,
		noiseFreq: 1,
		noiseBoil: 0,
	},
];

const leakElementParams = (i: number, d: LeakDefaults) =>
	grp(`Element${i}`, [
		check(`element${i}Enable`, `Element${i} Enable`, d.enable),
		slider(`size${i}`, `Size${i}`, d.size, { min: 0, softMax: 10 }),
		slider(`relHeight${i}`, `Rel Height${i}`, d.relHeight, { min: 0, softMax: 4 }),
		slider(`brightness${i}`, `Brightness${i}`, d.brightness, { min: 0, softMax: 10 }),
		slider(`speed${i}`, `Speed${i}`, d.speed, { min: 0, softMax: 10 }),
		fxParam.angle(`angle${i}`, `Angle${i}`, d.angle),
		fxParam.point(`center${i}`, `Center${i}`, sapphirePoint(d.center[0], d.center[1])),
		color(`outerColor${i}`, `Outer Color${i}`, d.outer),
		color(`midColor${i}`, `Mid Color${i}`, d.mid),
		color(`centerColor${i}`, `Center Color${i}`, d.inner),
		slider(`midpoint${i}`, `Midpoint${i}`, d.midpoint, { min: 0, max: 1 }),
		slider(`softness${i}`, `Softness${i}`, d.softness, { min: 0, softMax: 4 }),
		slider(`noiseAmp${i}`, `Noise Amp${i}`, d.noiseAmp, { min: 0, softMax: 4 }),
		slider(`noiseFreq${i}`, `Noise Freq${i}`, d.noiseFreq, { min: 0, softMax: 10 }),
		slider(`noiseFreqRelY${i}`, `Noise Freq Rel Y${i}`, 1, { min: 0, softMax: 4 }),
		slider(`noiseDetail${i}`, `Noise Detail${i}`, 0, { min: 0, max: 1 }),
		slider(`noiseBoilSpeed${i}`, `Noise Boil Speed${i}`, d.noiseBoil, { min: 0, softMax: 4 }),
	]);

/** Size factor of the light-leak elements at timing t (Transition Scale Mode between Elements Min / Max Size). */
export function leakScale(p: EffectParams, t: number, env: number): number {
	const lo = Math.max(0, num(p.elementsMinSize, 1));
	const hi = Math.max(0, num(p.elementsMaxSize, 4.9));
	switch (p.transitionScaleMode) {
		case 'no':
			return 1;
		case 'sizeUpDown':
			return lo + (hi - lo) * env;
		case 'sizeDown':
			return hi + (lo - hi) * t;
		default:
			return lo + (hi - lo) * t;
	}
}

/** Per-element uniforms of a frame: position (frame px), radii (px), brightness, colours, noise. */
export function leakUniforms(
	p: EffectParams,
	ctx: { width: number; height: number; time: number; t: number; env: number; seed: number },
) {
	const scale = leakScale(p, ctx.t, ctx.env);
	const speedAll = Math.max(0, num(p.speed, 0));
	const shift = vec2(p.shift, [0, 0]);
	const unit = ctx.width / 2;
	const data: number[] = [];
	for (let i = 1; i <= 3; i++) {
		const d = LEAK_ELEMENTS[i - 1]!;
		const on = p[`element${i}Enable`] === undefined ? d.enable : p[`element${i}Enable`] === true;
		const c = vec2(p[`center${i}`], sapphirePoint(d.center[0], d.center[1]));
		const a = (num(p[`angle${i}`], d.angle) * Math.PI) / 180;
		// Moves along its angle through its centre at the midpoint; Speed × Speed_i half-widths over the transition.
		const travel = speedAll * Math.max(0, num(p[`speed${i}`], d.speed)) * (ctx.t - 0.5) * unit;
		const rm = Math.max(0, num(p.randomMotion, 0));
		const rf = Math.max(0, num(p.randomFrequency, 0));
		const wob = (k: number) =>
			rm > 0 ? rm * 0.2 * unit * Math.sin(ctx.time * rf * 6.283 + ctx.seed * 40 + k * 2.1 + i) : 0;
		const x = c[0] * ctx.width + Math.cos(a) * travel + shift[0] * unit + wob(0);
		const y = c[1] * ctx.height + Math.sin(a) * travel - shift[1] * unit + wob(1);
		const r = Math.max(1, num(p[`size${i}`], d.size) * scale * 0.25 * unit);
		data.push(
			x,
			y,
			r,
			r * Math.max(0.01, num(p[`relHeight${i}`], d.relHeight)),
			on ? Math.max(0, num(p[`brightness${i}`], d.brightness)) : 0,
			...rgb(p[`centerColor${i}`], d.inner),
			...rgb(p[`midColor${i}`], d.mid),
			...rgb(p[`outerColor${i}`], d.outer),
			clamp(num(p[`midpoint${i}`], d.midpoint), 0.001, 0.999),
			Math.max(0.02, num(p[`softness${i}`], d.softness)) * 0.5,
			Math.max(0, num(p[`noiseAmp${i}`], d.noiseAmp)),
			Math.max(0, num(p[`noiseFreq${i}`], d.noiseFreq)),
			Math.max(0, num(p[`noiseFreqRelY${i}`], 1)),
			1 + Math.floor(clamp(num(p[`noiseDetail${i}`], 0), 0, 1) * 4),
			Math.max(0, num(p[`noiseBoilSpeed${i}`], d.noiseBoil)),
			i,
			0,
			0,
		);
	}
	return { u_leakData: { floats: data }, u_leakCount: 3 };
}

/** Floats per element in `u_leakData`. */
export const LEAK_STRIDE = 24;

export const S_DISSOLVE_LIGHT_LEAK: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-light-leak',
	label: 'S_DissolveLightLeak',
	description:
		'Dissolves under drifting, flickering light leaks: up to three noisy coloured blobs (centre / mid / outer colours) that grow over the transition, screened over the cut, plus a glow.',
	keywords: ['light leak', 'film', 'flare', 'burn', 'glow', 'dissolve', 'vintage'],
	timing: { slow: [0.2, 0.2], speed: 11 },
	params: [
		slider('transitionBrightness', 'Transition Brightness', 1.5, { min: 0, softMax: 6 }),
		fxParam.choice(
			'transitionScaleMode',
			'Transition Scale Mode',
			LEAK_SCALE_MODES,
			['No', 'Size Up Down', 'Size Up', 'Size Down'],
			'sizeUp',
		),
		slider('elementsMinSize', 'Elements Min Size', 1, { min: 0, softMax: 10 }),
		slider('elementsMaxSize', 'Elements Max Size', 4.9, { min: 0, softMax: 10 }),
		slider('scaleLights', 'Scale Lights', 1.1, { min: 0, softMax: 4 }),
		slider('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2 }),
		color('leakColor', 'Color', [1, 1, 1]),
		slider('hueShift', 'Hue Shift', 0, { softMin: -1, softMax: 1 }),
		slider('saturation', 'Saturation', 1, { min: -2, max: 8 }),
		slider('gamma', 'Gamma', 1, { min: 0.1, softMax: 4 }),
		slider('speed', 'Speed', 0, { min: 0, softMax: 4 }),
		fxParam.vec2('shift', 'Shift', [0, 0], { softMin: -2, softMax: 2, step: 0.001 }),
		slider('flickerAmp', 'Flicker Amp', 0.2, { min: 0, softMax: 2 }),
		slider('flickerFreq', 'Flicker Freq', 4, { min: 0, softMax: 30 }),
		slider('randomMotion', 'Random Motion', 0, { min: 0, softMax: 4 }),
		slider('randomFrequency', 'Random Frequency', 0, { min: 0, softMax: 10 }),
		seed(),
		slider('bgBrightness', 'Bg Brightness', 1, { min: 0, softMax: 2 }),
		fxParam.choice('combine', 'Combine', LEAK_COMBINES, ['Screen', 'Add', 'Leaks Only'], 'screen'),
		slider('affectAlpha', 'Affect Alpha', 1, { min: 0, softMax: 2 }),
		slider('glowBrightness', 'Glow Brightness', 0.5, { min: 0, softMax: 4 }),
		slider('glowWidth', 'Glow Width', 0.4, { min: 0, softMax: 4 }),
		slider('glowThreshold', 'Glow Threshold', 0.8, { min: 0, softMax: 1 }),
		...LEAK_ELEMENTS.flatMap((d, i) => leakElementParams(i + 1, d)),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const d = dissolveTiming(p, ctx.progress);
			const w = Math.max(0, num(p.glowWidth, 0.4)) * SAPPHIRE_GLOW_UNIT * ctx.width;
			return {
				...leakUniforms(p, {
					width: ctx.width,
					height: ctx.height,
					time: ctx.frame / Math.max(1, ctx.fps),
					t: d.t,
					env: d.env,
					seed: ctx.seed,
				}),
				u_glowSigma: [w, w],
			};
		},
		passes: (): ShaderPass[] => {
			return [
				{
					// The light leak (½ resolution, rgba16f): enveloped, flickered and colour-graded.
					output: 'leak',
					scale: 0.5,
					format: 'rgba16f',
					include: [GLSL_SD, GLSL_SD_NOISE],
					frag: /* glsl */ `
float ld(int i, int k) { return u_leakData[i * ${LEAK_STRIDE} + k]; }
vec3 ld3(int i, int k) { return vec3(ld(i, k), ld(i, k + 1), ld(i, k + 2)); }
void main() {
  vec2 px = tr_px();
  vec3 leak = vec3(0.0);
  // One element per iteration (u_leakData, see leakUniforms): a noisy elliptical blob with centre / mid / outer
  // colours, fading out at its edge.
  int n = int(u_leakCount);
  for (int i = 0; i < n; i++) {
    float bright = ld(i, 4);
    if (bright <= 0.0) continue;
    vec2 d = (px - vec2(ld(i, 0), ld(i, 1))) / vec2(ld(i, 2), ld(i, 3));
    vec2 q = px / u_compSize.x * ld(i, 17) * vec2(1.0, ld(i, 18)) * 2.0;
    float nz = sd_fbm3(vec3(q, u_time * ld(i, 20) * 0.5 + ld(i, 21) * 3.1), int(ld(i, 19)), 0.5, fract(u_seed + ld(i, 21) * 0.217));
    float r = length(d) + ld(i, 16) * 0.25 * nz;
    float s = ld(i, 15);
    float mp = ld(i, 14);
    vec3 col = r < mp ? mix(ld3(i, 5), ld3(i, 8), smoothstep(-s * mp, mp + s * mp, r))
                      : mix(ld3(i, 8), ld3(i, 11), smoothstep(mp - s * (1.0 - mp), 1.0 + s * (1.0 - mp), r));
    leak += col * (1.0 - smoothstep(1.0 - s, 1.0 + s, r)) * bright;
  }
  float flick = 1.0 + u_flickerAmp * sd_vnoise(vec2(u_time * u_flickerFreq, 0.5), u_seed);
  leak *= u_leakColor.rgb * u_transitionBrightness * 0.35 * max(flick, 0.0);
  leak = pow(max(leak, 0.0), vec3(1.0 / max(u_gamma, 0.1)));
  float l = fx_luma(leak);
  leak = fx_hueShift(clamp(leak, 0.0, 64.0), u_hueShift);
  leak = max(mix(vec3(l), leak, u_saturation), 0.0);
  leak = leak * u_scaleLights + u_offsetDarks * 0.1 * (1.0 - clamp(l, 0.0, 1.0));
  fragColor = vec4(max(leak, 0.0) * u_sdEnv, 1.0);
}`,
				},
				{
					// The combined picture's highlights for the glow.
					output: 'bright',
					scale: 0.5,
					format: 'rgba16f',
					include: [GLSL_SD],
					frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec4 c = sd_lightOver(base, texture(u_leak, v_uv).rgb, 1.0, u_combine == 0);
  vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  fragColor = vec4(sd_threshold(s, u_glowThreshold) * c.a, 1.0);
}`,
				},
				...glowPasses({ input: 'bright', prefix: 'glow', sigma: 'u_glowSigma' }),
				{
					include: [GLSL_SD_GLOW],
					frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  // Bg Brightness and Leaks Only act with the envelope (the ends stay exactly A and B).
  float bg = mix(1.0, u_combine == 2 ? 0.0 : u_bgBrightness, u_sdEnv);
  base.rgb *= bg;
  vec3 leak = sd_bicubic(u_leak, v_uv).rgb;
  vec4 c = sd_lightOver(base, leak, u_affectAlpha, u_combine == 0);
  vec3 g = sd_glow(u_glowNear, u_glowFar, 0.0) * u_glowBrightness * ${GLOW_GAIN} * u_sdEnv;
  fragColor = mix(sd_lightOver(c, g, u_affectAlpha, false), sd_dissolve(), u_mixWithDissolve);
}`,
				},
			];
		},
	},
});

export const GLOW_DISSOLVES = [S_DISSOLVE_GLOW, S_DISSOLVE_LIGHT_LEAK, S_DISSOLVE_ULTRA_GLOW] as const;

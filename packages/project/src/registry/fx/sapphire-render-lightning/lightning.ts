// Sapphire Render ▸ lightning: S_Zap (bolts along a spline), S_UltraZap (spline bolts with colour ramps, branches,
// secondary bolts and a two-stage glow), S_ZapTo (bolts from a point to the edges of objects), S_ZapFrom (bolts
// outwards from the edges of objects). Pipeline: a core pass draws the bolts (HDR), a downsample + per-channel
// Gaussian chain makes the glow (multi-pass), the last pass adds bolt + glow and combines with the source.
// Determinism: shapes are hashes of (u_seed, Jitter Frames period, branch/bolt ids); Wiggle moves the noise along a
// time axis — every frame is a pure function of params and frame.

import type { EffectParams, EffectSpec } from '../../effects.ts';
import { mediaParamId } from '../../param-values.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam, sapphireCommonParams } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxFrameContext, FxPlanContext, ShaderPass } from '../shader.ts';
import {
	clamp,
	combineParam,
	combineUniforms,
	GLSL_SRT_ATMOS,
	GLSL_SRT_COMMON,
	glowPasses,
	int,
	lightCombine,
	n,
	num,
	rgb,
	splinePoints,
	splineUniform,
	unitPx,
} from './common.ts';
import { GLSL_ZAP_BOLT_SPLINE, GLSL_ZAP_BOLT_STRAIGHT } from './zap-glsl.ts';

const ZAP_COMBINE = lightCombine('Zap');

/** Wiggle time axis of the bolt noise. */
const zapTau = (p: EffectParams, ctx: Pick<FxFrameContext, 'frame' | 'fps'>) =>
	num(p.wiggleStart) + (ctx.frame / Math.max(1, ctx.fps)) * num(p.wiggleSpeed, 1) * 2;

/** Bolt seed: u_seed, re-drawn every `Jitter Frames` frames (0 = the same lightning on every frame). */
function zapSeed(seed: number, frame: number, jitterFrames: number): number {
	const j = Math.max(0, Math.floor(jitterFrames));
	const k = j > 0 ? Math.floor(frame / j) : 0;
	const s = seed + k * 0.6180339887;
	return s - Math.floor(s);
}

/** Bolt half width (canvas px) per unit of "Bolt Width" and Sapphire unit. */
const BOLT_K = 0.045;
/** Glow sigma (canvas px) per unit of "Glow Width" and Sapphire unit. */
const GLOW_K = 0.14;

/** Brightness gain making the glow of a thin bolt visible (a blurred line's peak falls with sigma / width). */
const glowGain = (glowWidth: number, boltWidth: number) =>
	clamp((0.9 * (Math.max(0, glowWidth) * GLOW_K)) / (2 * Math.max(0.005, boltWidth) * BOLT_K), 1, 40);

const glowSigma = (p: EffectParams, ctx: FxPlanContext, name = 'glowWidth', def = 0.224) =>
	Math.max(0.5, num(p[name], def) * unitPx(ctx) * GLOW_K);

const wiggleParams = () => [
	n('wiggleStart', 'Wiggle Start', 0, 0, undefined, { softMax: 10, step: 0.01 }),
	n('wiggleSpeed', 'Wiggle Speed', 1, 0, undefined, { softMax: 10, step: 0.01 }),
	int('jitterFrames', 'Jitter Frames', 0, 0, undefined, 10),
];
const shapeParams = (branchMax = 20) => [
	n('wrinkleAmp', 'Wrinkle Amp', 1, 0, undefined, { softMax: 4, step: 0.01 }),
	n('curveAmp', 'Curve Amp', 0.5, 0, undefined, { softMax: 3, step: 0.01 }),
	n('branchiness', 'Branchiness', 1, 0, branchMax, { step: 0.01 }),
	n('branchAngle', 'Branch Angle', 65, 0, 180, { step: 0.1, unit: 'deg' }),
	n('branchLength', 'Branch Length', 0.5, 0, 3, { step: 0.01 }),
];
const glowParams = () => [
	n('glowBright', 'Glow Bright', 2, 0, undefined, { softMax: 10, step: 0.01 }),
	rgb('glowColor', 'Glow Color', [0.5, 0.5, 1]),
	n('glowWidth', 'Glow Width', 0.224, 0, undefined, { softMax: 2, step: 0.001 }),
	n('glowWidthRed', 'Glow Width Red', 0.5, 0, undefined, { softMax: 4, step: 0.01 }),
	n('glowWidthGrn', 'Glow Width Grn', 1, 0, undefined, { softMax: 4, step: 0.01 }),
	n('glowWidthBlue', 'Glow Width Blue', 1.5, 0, undefined, { softMax: 4, step: 0.01 }),
	n('affectAlpha', 'Affect Alpha', 1, 0, undefined, { softMax: 2, step: 0.01 }),
];
const zapOutParams = () => [
	n('zapBright', 'Zap Bright', 1, 0, undefined, { softMax: 5, step: 0.01 }),
	rgb('zapColor', 'Zap Color', [1, 1, 1]),
	n('startOffset', 'Start Offset', 0, 0, 1, { step: 0.001 }),
	n('length', 'Length', 1, 0, 1, { step: 0.001 }),
	n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
	combineParam(ZAP_COMBINE, 'screen'),
];
const atmosphereParams = (freq = 2, detail = 0.7) => [
	n('atmosphereAmp', 'Atmosphere Amp', 0, 0, undefined, { softMax: 2, step: 0.01 }),
	n('atmosphereFreq', 'Atmosphere Freq', freq, 0.1, 20, { step: 0.01 }),
	n('atmosphereDetail', 'Atmosphere Detail', detail, 0, 1, { step: 0.01 }),
	n('atmosphereSpeed', 'Atmosphere Speed', 1, undefined, undefined, { softMin: -5, softMax: 5, step: 0.01 }),
];

/** Glow + finish passes shared by S_Zap / S_ZapTo / S_ZapFrom (core → glow chain → light → combine). */
function zapTail(p: EffectParams, ctx: FxPlanContext, maxLevels: number, edges: boolean): ShaderPass[] {
	const rel = [num(p.glowWidthRed, 0.5), num(p.glowWidthGrn, 1), num(p.glowWidthBlue, 1.5)] as const;
	return [
		...glowPasses({ input: 'core', out: 'glow', sigma: glowSigma(p, ctx), rel, wide: 2.8, maxLevels }),
		{
			include: [GLSL_SRT_COMMON, GLSL_SRT_ATMOS, GLSL_COMPOSITE],
			frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 core = texture(u_core, v_uv);
  vec3 glow = texture(u_glowA, v_uv).rgb * 0.6 + texture(u_glowB, v_uv).rgb * 0.4;
  float atm = srt_atmosphere(srt_sapphire(srt_here()), u_atmosphereAmp, u_atmosphereFreq, u_atmosphereDetail,
    u_atmosphereSpeed, fract(u_seed + 0.31));
  vec3 light = core.rgb * u_zapColor.rgb * u_zapBright + glow * u_glowColor.rgb * u_glowBright * u_glowGain * atm;
  float matte = clamp(srt_max3(light), 0.0, 1.0);
  vec4 res = srt_light(u_combineOp, src, light, u_bgBrightness, u_affectAlpha);
  ${
		edges
			? `if (u_show == 2) {
    float m = texture(u_objB, v_uv).r;
    float e = 1.0 - smoothstep(0.0, fwidth(m) * 1.5 + 1.0e-3, abs(m - u_threshold));
    fragColor = vec4(vec3(e), 1.0);
    return;
  }`
			: ''
	}
  fragColor = fx_finish(res, src, matte, u_mixWithOriginal, u_show);
}`,
		},
	];
}

const commonZapUniforms = (p: EffectParams, ctx: FxFrameContext) => ({
	u_tau: zapTau(p, ctx),
	u_zseed: zapSeed(ctx.seed, ctx.frame, num(p.jitterFrames)),
	u_glowGain: glowGain(num(p.glowWidth, 0.224), num(p.boltWidth, 0.07)),
	...combineUniforms(p, ZAP_COMBINE, 'screen'),
});

const ZAP_POINTS = {
	start: [0.25, -0.03],
	controlPoint1: [0.335, 0.144],
	controlPoint2: [0.55, 0.278],
	controlPoint3: [0.7, 0.5],
	controlPoint4: [0.725, 0.793],
	end: [0.75, 1.03],
} as const;
const ZAP_ENABLES = { point1Enable: false, point2Enable: false, point3Enable: true, point4Enable: false };
const SPLINE_NAMES = {
	start: 'start',
	end: 'end',
	points: [
		['point1Enable', 'controlPoint1'],
		['point2Enable', 'controlPoint2'],
		['point3Enable', 'controlPoint3'],
		['point4Enable', 'controlPoint4'],
	],
} as const;

const controlPointParams = (
	pts: Record<string, readonly [number, number]>,
	enables: Record<string, boolean>,
) => [
	fxParam.toggle('point1Enable', 'Point 1 Enable', enables.point1Enable!),
	fxParam.point('controlPoint1', 'Control Point 1', [...pts.controlPoint1!] as [number, number]),
	fxParam.toggle('point2Enable', 'Point 2 Enable', enables.point2Enable!),
	fxParam.point('controlPoint2', 'Control Point 2', [...pts.controlPoint2!] as [number, number]),
	fxParam.toggle('point3Enable', 'Point 3 Enable', enables.point3Enable!),
	fxParam.point('controlPoint3', 'Control Point 3', [...pts.controlPoint3!] as [number, number]),
	fxParam.toggle('point4Enable', 'Point 4 Enable', enables.point4Enable!),
	fxParam.point('controlPoint4', 'Control Point 4', [...pts.controlPoint4!] as [number, number]),
];

export const S_ZAP = defineShaderEffect({
	id: 'jasper.s.zap',
	label: 'S_Zap',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'Lightning bolts between a Start and an End point (optionally through control points), with branches and a coloured glow, rendered over the clip. More Bolts give an electric plasma; Wiggle Speed makes them undulate.',
	keywords: ['lightning', 'electricity', 'bolt', 'zap', 'plasma', 'energy', 'spark'],
	expensive: true,
	params: [
		int('bolts', 'Bolts', 1, 1, 500, 64),
		fxParam.point('start', 'Start', [...ZAP_POINTS.start]),
		...controlPointParams(ZAP_POINTS, ZAP_ENABLES),
		fxParam.point('end', 'End', [...ZAP_POINTS.end]),
		n('varyEndpoint', 'Vary Endpoint', 0, 0, undefined, { softMax: 1, step: 0.001 }),
		n('boltWidth', 'Bolt Width', 0.07, 0, undefined, { softMax: 1, step: 0.001 }),
		n('varyWidth', 'Vary Width', 0, 0, 1, { step: 0.01 }),
		n('endPointiness', 'End Pointiness', 0.1, 0, 1, { step: 0.01 }),
		...wiggleParams(),
		...shapeParams(),
		...glowParams(),
		...zapOutParams(),
		...atmosphereParams(),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => ({
			...commonZapUniforms(p, ctx),
			u_spline: splineUniform(splinePoints(p, ctx, SPLINE_NAMES, ZAP_POINTS, ZAP_ENABLES)),
		}),
		passes: (p, ctx) => [
			{
				output: 'core',
				format: 'rgba16f',
				include: [GLSL_ZAP_BOLT_SPLINE],
				frag: /* glsl */ `
void main() {
  vec2 p = srt_here();
  float U = srt_unit();
  float hw = u_boltWidth * U * ${BOLT_K};
  float halo = hw * 3.0 + 2.0;
  ZapStyle st = ZapStyle(u_curveAmp, u_wrinkleAmp, u_tau, u_zseed, vec2(1.0));
  ZapBranches br = ZapBranches(int(clamp(floor(u_branchiness * 3.0 + 0.5), 0.0, 24.0)), u_branchAngle, u_branchLength,
    0.6, 0.0, u_endPointiness, u_startOffset, u_length);
  int bolts = int(clamp(u_bolts, 1.0, 64.0));
  float cov = 0.0;
  for (int b = 0; b < 64; b++) {
    if (b >= bolts) break;
    ZapStyle sb = st;
    sb.seed = fract(st.seed + float(b) * 0.1373);
    float ea = zap_h(b, 0, 900, st.seed) * SRT_TAU;
    vec2 endOff = vec2(cos(ea), sin(ea)) * sqrt(zap_h(b, 0, 901, st.seed)) * u_varyEndpoint * U;
    ZapBase B = ZapBase(true, vec2(0.0), vec2(1.0, 0.0), 0.0, endOff);
    vec2 r = zap_bolt(p, B, b, sb, halo);
    float w = hw * zap_taper(r.y, 0.0, u_endPointiness) * zap_vary(r.y, b, sb, u_varyWidth);
    cov = max(cov, zap_cov(r.x, w, 0.0) * zap_window(r.y, u_startOffset, u_length));
    if (br.count > 0) cov = max(cov, zap_branches(p, B, b, sb, hw, br, halo).x);
  }
  fragColor = vec4(vec3(cov), cov);
}`,
			},
			...zapTail(p, ctx, 4, false),
		],
	},
});

const ULTRA_POINTS = {
	startPoint: [0.25, 0.056],
	controlPoint1: [0.33, 0.23],
	controlPoint2: [0.55, 0.322],
	controlPoint3: [0.7, 0.5],
	controlPoint4: [0.725, 0.722],
	endPoint: [0.75, 0.944],
} as const;
const ULTRA_NAMES = { ...SPLINE_NAMES, start: 'startPoint', end: 'endPoint' } as const;
const ZAP_DIRECTIONS = ['allSame', 'allReverse', 'evenReverse', 'oddReverse', 'randomReverse'] as const;
const ZAP_DIRECTION_LABELS = [
	'all same',
	'all reverse',
	'even reverse',
	'odd reverse',
	'random reverse',
] as const;

export const S_ULTRA_ZAP = defineShaderEffect({
	id: 'jasper.s.ultra-zap',
	label: 'S_UltraZap',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'Lightning bolts along a spline with start/end colour ramps, coloured branches, independent secondary bolts, looping and a two-stage glow with optional plasma highlights and atmosphere.',
	keywords: ['lightning', 'electricity', 'bolt', 'zap', 'plasma', 'energy', 'spline', 'arc'],
	expensive: true,
	params: [
		fxParam.point('startPoint', 'Start Point', [...ULTRA_POINTS.startPoint]),
		...controlPointParams(ULTRA_POINTS, ZAP_ENABLES),
		fxParam.point('endPoint', 'End Point', [...ULTRA_POINTS.endPoint]),
		int('bolts', 'Bolts', 1, 0, 500, 32),
		n('boltWidth', 'Bolt Width', 0.06, 0, undefined, { softMax: 1, step: 0.001 }),
		n('boltLength', 'Bolt Length', 1, 0, 1, { step: 0.001 }),
		n('wrinkleAmp', 'Wrinkle Amp', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('curveAmp', 'Curve Amp', 0.5, 0, undefined, { softMax: 3, step: 0.01 }),
		n('taperStart', 'Taper Start', 0.025, 0, 1, { step: 0.001 }),
		n('taperEnd', 'Taper End', 0.25, 0, 1, { step: 0.001 }),
		n('featherBolt', 'Feather Bolt', 0, 0, undefined, { softMax: 1, step: 0.001 }),
		n('zapBrightness', 'Zap Brightness', 1, 0, undefined, { softMax: 5, step: 0.01 }),
		rgb('startColor', 'Start Color', [0.87, 0.969, 1]),
		rgb('endColor', 'End Color', [0, 0.333, 1]),
		n('varyBoltHue', 'Vary Bolt Hue', 0, -1, 1, { step: 0.01 }),
		n('varyWidth', 'Vary Width', 0, 0, 1, { step: 0.01 }),
		n('varyEndpoint', 'Vary Endpoint', 0, 0, undefined, { softMax: 1, step: 0.001 }),
		n('startOffset', 'Start Offset', 0, 0, 1, { step: 0.001 }),
		n('loopSpeed', 'Loop Speed', 0, undefined, undefined, { softMin: -2, softMax: 2, step: 0.001 }),
		n('loopStart', 'Loop Start', 0, undefined, undefined, { softMin: -1, softMax: 1, step: 0.001 }),
		n('varyLoopStart', 'Vary Loop Start', 0, -1, 1, { step: 0.01 }),
		fxParam.choice('zapDirection', 'Zap Direction', ZAP_DIRECTIONS, ZAP_DIRECTION_LABELS, 'allSame'),
		...wiggleParams(),
		n('boltNoise', 'Bolt Noise', 0.25, 0, undefined, { softMax: 1, step: 0.01 }),
		n('boltNoiseFreq', 'Bolt Noise Freq', 0.05, 0.01, undefined, { softMax: 1, step: 0.001 }),
		n('boltNoiseSpeed', 'Bolt Noise Speed', 1, undefined, undefined, { softMin: -5, softMax: 5, step: 0.01 }),
		fxParam.toggle('branchesOnly', 'Branches Only', false),
		n('branchiness', 'Branchiness', 4, 0, 20, { step: 0.01 }),
		n('branchAngle', 'Branch Angle', 45, 0, 180, { step: 0.1, unit: 'deg' }),
		n('branchLength', 'Branch Length', 0.5, 0, 3, { step: 0.01 }),
		rgb('branchColor', 'Branch Color', [0.8, 0.867, 1]),
		n('varyBranchHue', 'Vary Branch Hue', 0, -1, 1, { step: 0.01 }),
		n('branchWidth', 'Branch Width', 0.5, 0, undefined, { softMax: 2, step: 0.01 }),
		int('secondaryBolts', 'Secondary Bolts', 0, 0, undefined, 16),
		n('secondaryBoltWidth', 'Secondary Bolt Width', 0.05, 0, undefined, { softMax: 1, step: 0.001 }),
		n('secondaryLength', 'Secondary Length', 0.5, 0, 1, { step: 0.001 }),
		n('secondaryWrinkleAmp', 'Secondary Wrinkle Amp', 0.75, 0, undefined, { softMax: 4, step: 0.01 }),
		n('secondaryCurveAmp', 'Secondary Curve Amp', 0.35, 0, undefined, { softMax: 3, step: 0.01 }),
		n('secondaryTaperStart', 'Secondary Taper Start', 0, 0, 1, { step: 0.001 }),
		n('secondaryTaperEnd', 'Secondary Taper End', 0.25, 0, 1, { step: 0.001 }),
		n('secondaryBrightness', 'Secondary Brightness', 1, 0, undefined, { softMax: 5, step: 0.01 }),
		rgb('secondaryStartColor', 'Secondary Start Color', [1, 1, 1]),
		rgb('secondaryEndColor', 'Secondary End Color', [0.557, 0, 0.557]),
		n('secondaryStartOffset', 'Secondary Start Offset', 0, 0, 1, { step: 0.001 }),
		n('secondaryBranchiness', 'Secondary Branchiness', 4, 0, 20, { step: 0.01 }),
		n('secondaryBranchAngle', 'Secondary Branch Angle', 45, 0, 180, { step: 0.1, unit: 'deg' }),
		n('secondaryBranchWidth', 'Secondary Branch Width', 0.5, 0, undefined, { softMax: 2, step: 0.01 }),
		n('secondaryBranchLength', 'Secondary Branch Length', 0.7, 0, 3, { step: 0.01 }),
		rgb('secondaryBranchColor', 'Secondary Branch Color', [1, 0.8, 1]),
		n('glowBrightness', 'Glow Brightness', 1.5, 0, undefined, { softMax: 10, step: 0.01 }),
		n('glowThreshold', 'Glow Threshold', 0, 0, undefined, { softMax: 1, step: 0.001 }),
		rgb('glowColor', 'Glow Color', [0.97, 0.87, 1]),
		n('glowWidth', 'Glow Width', 0.3, 0, undefined, { softMax: 2, step: 0.001 }),
		n('glowWidthRed', 'Glow Width Red', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('glowWidthGreen', 'Glow Width Green', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('glowWidthBlue', 'Glow Width Blue', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('glowFalloff', 'Glow Falloff', 0.05, -2, 2, { step: 0.01 }),
		n('glowBias', 'Glow Bias', 0.5, -3, 3, { step: 0.01 }),
		n('afterGlowWidth', 'After Glow Width', 0.6, 0, undefined, { softMax: 3, step: 0.01 }),
		rgb('afterGlowColor', 'After Glow Color', [1, 1, 1]),
		fxParam.toggle('glowHighlights', 'Glow Highlights', false),
		n('glowHighlightsFrequency', 'Glow Highlights Frequency', 1.2, 0.01, undefined, {
			softMax: 10,
			step: 0.01,
		}),
		n('glowHighlightsSpeed', 'Glow Highlights Speed', 1, undefined, undefined, {
			softMin: -5,
			softMax: 5,
			step: 0.01,
		}),
		fxParam.toggle('glowAtmosphere', 'Glow Atmosphere', false),
		n('glowAtmosphereAmp', 'Glow Atmosphere Amp', 1, 0, undefined, { softMax: 3, step: 0.01 }),
		n('glowAtmosphereFreq', 'Glow Atmosphere Freq', 0.5, 0.1, undefined, { softMax: 10, step: 0.01 }),
		n('glowAtmosphereSpeed', 'Glow Atmosphere Speed', 1, undefined, undefined, {
			softMin: -5,
			softMax: 5,
			step: 0.01,
		}),
		n('affectAlpha', 'Affect Alpha', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		combineParam(ZAP_COMBINE, 'screen'),
		n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => ({
			u_tau: zapTau(p, ctx),
			u_zseed: zapSeed(ctx.seed, ctx.frame, num(p.jitterFrames)),
			u_glowGain: glowGain(num(p.glowWidth, 0.3), num(p.boltWidth, 0.06)),
			u_loop: num(p.loopStart) + (ctx.frame / Math.max(1, ctx.fps)) * num(p.loopSpeed),
			...combineUniforms(p, ZAP_COMBINE, 'screen'),
			u_spline: splineUniform(splinePoints(p, ctx, ULTRA_NAMES, ULTRA_POINTS, ZAP_ENABLES)),
		}),
		passes: (p, ctx) => {
			const rel = [num(p.glowWidthRed, 1), num(p.glowWidthGreen, 1), num(p.glowWidthBlue, 1)] as const;
			return [
				{
					output: 'core',
					format: 'rgba16f',
					include: [GLSL_ZAP_BOLT_SPLINE, GLSL_COLOR],
					frag: /* glsl */ `
bool uz_reversed(int b, float seed) {
  if (u_zapDirection == 1) return true;
  if (u_zapDirection == 2) return b % 2 == 0;
  if (u_zapDirection == 3) return b % 2 == 1;
  if (u_zapDirection == 4) return zap_h(b, 0, 910, seed) < 0.5;
  return false;
}
// Position of t inside the visible (looping) window → (window t 0..1, visibility).
vec2 uz_window(float t, float ws, float len) {
  if (len >= 0.999 && abs(ws) < 1.0e-5) return vec2(t, 1.0);
  float x = fract(t - ws);
  float l = max(len, 1.0e-3);
  return vec2(clamp(x / l, 0.0, 1.0), smoothstep(0.0, 0.006, x) * smoothstep(l + 0.006, l - 0.006, x));
}
void main() {
  vec2 p = srt_here();
  float U = srt_unit();
  float feather = u_featherBolt * U * 0.05;
  vec4 acc = vec4(0.0);
  for (int pass = 0; pass < 2; pass++) {
    bool sec = pass == 1;
    int count = sec ? int(clamp(u_secondaryBolts, 0.0, 16.0)) : int(clamp(u_bolts, 0.0, 32.0));
    float hw = (sec ? u_secondaryBoltWidth : u_boltWidth) * U * ${BOLT_K};
    float halo = hw * 3.0 + feather + 2.0;
    float seed0 = sec ? fract(u_zseed + 0.456) : u_zseed;
    ZapStyle st = ZapStyle(sec ? u_secondaryCurveAmp : u_curveAmp, sec ? u_secondaryWrinkleAmp : u_wrinkleAmp,
      u_tau, seed0, vec2(1.0));
    float ts = sec ? u_secondaryTaperStart : u_taperStart;
    float te = sec ? u_secondaryTaperEnd : u_taperEnd;
    float len = sec ? u_secondaryLength : u_boltLength;
    float bright = sec ? u_secondaryBrightness : 1.0;
    vec3 c0 = sec ? u_secondaryStartColor.rgb : u_startColor.rgb;
    vec3 c1 = sec ? u_secondaryEndColor.rgb : u_endColor.rgb;
    vec3 cb = sec ? u_secondaryBranchColor.rgb : u_branchColor.rgb;
    float branchiness = sec ? u_secondaryBranchiness : u_branchiness;
    float bAngle = sec ? u_secondaryBranchAngle : u_branchAngle;
    float bLen = sec ? u_secondaryBranchLength : u_branchLength;
    float bWidth = sec ? u_secondaryBranchWidth : u_branchWidth;
    float off = sec ? u_secondaryStartOffset : u_startOffset;
    for (int b = 0; b < 32; b++) {
      if (b >= count) break;
      ZapStyle sb = st;
      sb.seed = fract(seed0 + float(b) * 0.1373);
      int id = sec ? 40 + b : b;
      float ea = zap_h(id, 0, 900, seed0) * SRT_TAU;
      vec2 endOff = vec2(cos(ea), sin(ea)) * sqrt(zap_h(id, 0, 901, seed0)) * u_varyEndpoint * U;
      ZapBase B = ZapBase(true, vec2(0.0), vec2(1.0, 0.0), 0.0, endOff);
      bool rev = uz_reversed(b, seed0);
      float ws = off + u_loop + u_varyLoopStart * (zap_h(id, 0, 902, seed0) - 0.5);
      float hue = (sec ? 0.0 : u_varyBoltHue) * (zap_h(id, 0, 903, seed0) - 0.5);
      vec2 r = zap_bolt(p, B, id, sb, halo);
      float tr = rev ? 1.0 - r.y : r.y;
      vec2 win = uz_window(tr, ws, len);
      if (!(u_branchesOnly && !sec)) {
        float w = hw * zap_taper(win.x, ts, te) * zap_vary(r.y, id, sb, u_varyWidth);
        float nz = 1.0 - u_boltNoise * (0.5 + 0.5 * zap_noise(r.y * srt_splineLen() / U * u_boltNoiseFreq * 40.0
          + u_time * u_boltNoiseSpeed * 2.0, 0.0, id * 16 + 12, sb.seed, true).x);
        float cov = zap_cov(r.x, w, feather) * win.y * nz;
        vec3 col = mix(c0, c1, win.x);
        if (hue != 0.0) col = fx_hueShift(col, hue);
        vec4 c = vec4(col * cov * bright, cov);
        acc = max(acc, c);
      }
      int nb = int(clamp(floor(branchiness * 3.0 + 0.5), 0.0, 24.0));
      if (nb > 0) {
        // every root is evaluated; the visibility of its root in the (looping) window hides the branch
        ZapBranches br = ZapBranches(nb, bAngle, bLen, bWidth, ts, te, 0.0, 1.0);
        vec3 bc = zap_branches(p, B, id, sb, hw, br, halo);
        float troot = rev ? 1.0 - bc.z : bc.z;
        float vis = uz_window(troot, ws, len).y;
        float bhue = u_varyBranchHue * (zap_h(id, int(bc.z * 997.0), 904, seed0) - 0.5);
        vec3 rootCol = mix(c0, c1, uz_window(troot, ws, len).x);
        vec3 col = mix(rootCol, cb, bc.y);
        if (bhue != 0.0) col = fx_hueShift(col, bhue);
        if (hue != 0.0) col = fx_hueShift(col, hue);
        float cov = bc.x * vis;
        acc = max(acc, vec4(col * cov * bright, cov));
      }
    }
  }
  fragColor = acc;
}`,
				},
				...glowPasses({
					input: 'core',
					out: 'glow',
					sigma: glowSigma(p, ctx, 'glowWidth', 0.3),
					rel,
					wide: 1 + 3 * Math.max(0, num(p.afterGlowWidth, 0.6)),
					threshold: num(p.glowThreshold),
					maxLevels: 4,
				}),
				{
					include: [GLSL_SRT_COMMON, GLSL_SRT_ATMOS, GLSL_COMPOSITE],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 core = texture(u_core, v_uv);
  float wB = 0.4 * exp2(u_glowFalloff * 2.0);
  vec3 g = texture(u_glowA, v_uv).rgb * 0.6 + texture(u_glowB, v_uv).rgb * u_afterGlowColor.rgb * wB;
  g *= u_glowGain;
  float bias = u_glowBias;
  g = max(g, vec3(0.0));
  g = bias >= 0.0 ? g * (1.0 + bias) / (1.0 + bias * min(g, vec3(4.0))) : g * (1.0 + bias * 0.3 * (1.0 - min(g, vec3(1.0))));
  vec2 sap = srt_sapphire(srt_here());
  if (u_glowHighlights) {
    float h = 1.0 - abs(srt_fbm3(vec3(sap * u_glowHighlightsFrequency * 2.0, u_time * u_glowHighlightsSpeed * 0.5), 3, 0.5, srt_seed(u_seed + 0.71)));
    g *= 0.35 + 1.6 * h * h;
  }
  if (u_glowAtmosphere) g *= srt_atmosphere(sap, u_glowAtmosphereAmp * 0.6, u_glowAtmosphereFreq * 2.0, 0.7, u_glowAtmosphereSpeed, fract(u_seed + 0.53));
  vec3 light = core.rgb * u_zapBrightness + g * u_glowColor.rgb * u_glowBrightness;
  float matte = clamp(srt_max3(light), 0.0, 1.0);
  vec4 res = srt_light(u_combineOp, src, light, u_bgBrightness, u_affectAlpha);
  fragColor = fx_finish(res, src, matte, u_mixWithOriginal, u_show);
}`,
				},
			];
		},
	},
});

/** Edge points texture capacity: the `pts` pass is at least 64 texels wide. */
const PTS_W = 64;
const ptsScale = (ctx: FxPlanContext) => Math.min(1, PTS_W / Math.max(1, ctx.width * ctx.pxScale));

/** Object matte (luma/alpha of the object clip or the layer itself), blurred: outputs `obj`, `objBH`, `objB`. */
function objectPasses(p: EffectParams, ctx: FxPlanContext, media: string, blurName: string, blurDef: number) {
	const has = !!mediaParamId(p[media]);
	const sigma = Math.max(0, num(p[blurName], blurDef)) * unitPx(ctx) * 0.5;
	const passes: ShaderPass[] = [
		{
			output: 'obj',
			scale: 0.5,
			frag: /* glsl */ `
void main() {
  // clamped to the layer box: the box border itself is not an object edge
  vec2 ln = clamp(fx_layerNorm(), vec2(0.5) / u_box.zw, vec2(1.0) - vec2(0.5) / u_box.zw);
  vec4 c = ${has ? `u_${media}_size.x > 0.0 ? texture(u_${media}, ln) : vec4(0.0)` : 'texture(u_source, fx_uvOfLayerNorm(ln))'};
  float m = ${'u_objUse'} == 1 ? c.a : dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  fragColor = vec4(m, m, m, 1.0);
}`,
		},
		...gaussianBlurPasses({ input: 'obj', output: 'objB', sigma, scale: 0.25 }),
	];
	return passes;
}

/**
 * The edge points pass (`pts`, rgba8, nearest): texel k = surface point k, found by marching rays through the blurred
 * object matte to a crossing of Threshold (then bisection). Encodes x, y (12 bits each, layer-normalised) and the
 * outward normal angle (8 bits); all-ones = no point. `rays`: 'fromStart' (S_ZapTo: rays from u_start, within Max
 * Dist) or 'stratified' (S_ZapFrom: rays from stratified origins, Vary Spacing).
 */
function pointsPass(ctx: FxPlanContext, count: string, rays: 'fromStart' | 'stratified'): ShaderPass {
	return {
		output: 'pts',
		scale: ptsScale(ctx),
		filter: 'nearest',
		include: [GLSL_ZAP_BOLT_STRAIGHT],
		frag: /* glsl */ `
float zt_m(vec2 n) { return texture(u_objB, fx_uvOfLayerNorm(n)).r; }
vec4 zt_encode(vec2 n, float ang) {
  float qx = floor(clamp(n.x, 0.0, 1.0) * 4094.0 + 0.5);
  float qy = floor(clamp(n.y, 0.0, 1.0) * 4094.0 + 0.5);
  float qa = mod(floor(fract(ang / SRT_TAU) * 256.0 + 0.5), 256.0);
  float hx = floor(qx / 16.0);
  float hy = floor(qy / 256.0);
  return vec4(hx, (qx - hx * 16.0) * 16.0 + hy, qy - hy * 256.0, qa) / 255.0;
}
void main() {
  ivec2 tc = ivec2(floor(v_uv * u_resolution));
  int k = tc.y * int(u_resolution.x) + tc.x;
  int count = int(clamp(${count}, 0.0, 256.0));
  if (k >= count) { fragColor = vec4(1.0); return; }
  float seed = fract(u_zseed + 0.77);
  vec2 aspect = vec2(1.0, u_box.w / u_box.z);
  float th = u_threshold;
  for (int attempt = 0; attempt < 12; attempt++) {
    float h1 = zap_h(k, attempt, 300, seed), h2 = zap_h(k, attempt, 301, seed), h3 = zap_h(k, attempt, 302, seed);
    vec2 o;
    vec2 dir;
    float span;
    ${
			rays === 'fromStart'
				? `o = u_start;
    float a = (float(k) + h1 * 0.999) / float(max(count, 1)) * SRT_TAU + float(attempt) * 2.39996;
    dir = vec2(cos(a), sin(a)) / aspect;
    span = u_maxDist * 0.5;`
				: `int g = int(ceil(sqrt(float(max(count, 1)))));
    vec2 cell = (vec2(float(k % g), float(k / g)) + 0.5) / float(g);
    o = mix(cell, vec2(h1, h2), clamp(u_varySpacing, 0.0, 1.0));
    if (attempt > 0) o = vec2(h1, h2);
    float a = h3 * SRT_TAU;
    dir = vec2(cos(a), sin(a)) / aspect;
    o -= dir * 0.75;
    span = 1.5;`
		}
    float prev = zt_m(o) - th;
    float stepLen = span / 40.0;
    for (int i = 1; i <= 40; i++) {
      vec2 q = o + dir * stepLen * float(i);
      float cur = zt_m(q) - th;
      bool inBox = all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0)));
      if (inBox && (prev < 0.0) != (cur < 0.0)) {
        vec2 lo = q - dir * stepLen, hi = q;
        float flo = prev;
        for (int r = 0; r < 6; r++) {
          vec2 mid = 0.5 * (lo + hi);
          float fm = zt_m(mid) - th;
          if ((fm < 0.0) == (flo < 0.0)) { lo = mid; flo = fm; } else { hi = mid; }
        }
        vec2 e = 0.5 * (lo + hi);
        vec2 eps = 1.5 / u_box.zw;
        vec2 grad = vec2(zt_m(e + vec2(eps.x, 0.0)) - zt_m(e - vec2(eps.x, 0.0)),
                         zt_m(e + vec2(0.0, eps.y)) - zt_m(e - vec2(0.0, eps.y))) / (2.0 * eps);
        vec2 outward = -grad * vec2(1.0, aspect.y);
        float ang = length(outward) > 1.0e-6 ? atan(outward.y, outward.x) : atan(-dir.y, -dir.x);
        fragColor = zt_encode(e, ang < 0.0 ? ang + SRT_TAU : ang);
        return;
      }
      prev = cur;
    }
  }
  fragColor = vec4(1.0);
}`,
	};
}

/** GLSL decoding a surface point: (layer-normalised position, outward angle), valid flag in w. */
const DECODE = /* glsl */ `
vec4 zt_point(int k) {
  ivec2 sz = textureSize(u_pts, 0);
  vec2 uv = (vec2(float(k % sz.x), float(k / sz.x)) + 0.5) / vec2(sz);
  vec4 c = floor(texture(u_pts, uv) * 255.0 + 0.5);
  if (all(greaterThan(c, vec4(254.5)))) return vec4(0.0);
  float qx = c.r * 16.0 + floor(c.g / 16.0);
  float qy = mod(c.g, 16.0) * 256.0 + c.b;
  return vec4(qx / 4094.0, qy / 4094.0, c.a / 256.0 * SRT_TAU, 1.0);
}
`;

const objUseParam = (name: string, label: string) =>
	fxParam.choice(name, label, ['luma', 'alpha'], ['Luma', 'Alpha'], 'luma');

const objUniform = (p: EffectParams, name: string) => ({ u_objUse: { int: p[name] === 'alpha' ? 1 : 0 } });

export const S_ZAP_TO = defineShaderEffect({
	id: 'jasper.s.zap-to',
	label: 'S_ZapTo',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'Forked lightning from a Start point to points on the edges of objects in the ToObject clip (the layer itself when none is chosen), rendered over the clip with a coloured glow. Show ▸ Edges displays the detected edges.',
	keywords: ['lightning', 'electricity', 'bolt', 'zap', 'edges', 'strike', 'object'],
	expensive: true,
	params: [
		fxParam.media('toObject', 'ToObject', ['image', 'video']),
		int('surfacePoints', 'Surface Points', 10, 1, 500, 64),
		int('bolts', 'Bolts', 1, 1, 200, 8),
		fxParam.point('start', 'Start', [0.5, 0.5]),
		n('maxDist', 'Max Dist', 2, 0, undefined, { softMax: 4, step: 0.001 }),
		n('threshold', 'Threshold', 0.5, 0, undefined, { softMax: 1, step: 0.001 }),
		n('blurToObj', 'Blur ToObj', 0.0224, 0, undefined, { softMax: 0.5, step: 0.0001 }),
		objUseParam('toObjUse', 'ToObj Use'),
		n('boltWidth', 'Bolt Width', 0.07, 0, undefined, { softMax: 1, step: 0.001 }),
		n('varyWidth', 'Vary Width', 0, 0, 1, { step: 0.01 }),
		n('endPointiness', 'End Pointiness', 0.25, 0, 1, { step: 0.01 }),
		...wiggleParams(),
		n('wrinkleAmp', 'Wrinkle Amp', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('branchiness', 'Branchiness', 1, 0, 20, { step: 0.01 }),
		n('branchAngle', 'Branch Angle', 65, 0, 180, { step: 0.1, unit: 'deg' }),
		n('branchLength', 'Branch Length', 0.5, 0, 3, { step: 0.01 }),
		...glowParams(),
		...zapOutParams(),
		...atmosphereParams(),
		...sapphireCommonParams({ seed: true, show: [{ value: 'edges', label: 'Edges' }] }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => ({ ...commonZapUniforms(p, ctx), ...objUniform(p, 'toObjUse') }),
		passes: (p, ctx) => [
			...objectPasses(p, ctx, 'toObject', 'blurToObj', 0.0224),
			pointsPass(ctx, 'u_surfacePoints', 'fromStart'),
			{
				output: 'core',
				format: 'rgba16f',
				include: [GLSL_ZAP_BOLT_STRAIGHT],
				frag: /* glsl */ `
${DECODE}
void main() {
  vec2 p = srt_here();
  float U = srt_unit();
  float hw = u_boltWidth * U * ${BOLT_K};
  float halo = hw * 3.0 + 2.0;
  vec2 a = srt_pt(u_start);
  int pts = int(clamp(u_surfacePoints, 0.0, 256.0));
  int bolts = int(clamp(u_bolts, 1.0, 8.0));
  ZapBranches br = ZapBranches(int(clamp(floor(u_branchiness * 3.0 + 0.5), 0.0, 24.0)), u_branchAngle, u_branchLength,
    0.6, 0.0, u_endPointiness, u_startOffset, u_length);
  float cov = 0.0;
  for (int k = 0; k < 256; k++) {
    if (k >= pts) break;
    vec4 e = zt_point(k);
    if (e.w < 0.5) continue;
    vec2 b = srt_pt(e.xy);
    float L = distance(a, b);
    if (L < 1.0) continue;
    vec2 d = (b - a) / L;
    ZapStyle st = ZapStyle(0.35, u_wrinkleAmp, u_tau, u_zseed, vec2(1.0));
    float reach = zap_amp(L, st) + halo + (br.count > 0 ? L * u_branchLength * 1.6 : 0.0);
    vec2 q = p - a;
    float u = clamp(dot(q, d), 0.0, L);
    if (distance(p, a + d * u) > reach) continue;
    for (int bb = 0; bb < 8; bb++) {
      if (bb >= bolts) break;
      ZapStyle sb = st;
      sb.seed = fract(u_zseed + float(bb) * 0.1373);
      int id = k * 8 + bb;
      ZapBase B = ZapBase(false, a, d, L, vec2(0.0));
      vec2 r = zap_bolt(p, B, id, sb, halo);
      float w = hw * zap_taper(r.y, 0.0, u_endPointiness) * zap_vary(r.y, id, sb, u_varyWidth);
      cov = max(cov, zap_cov(r.x, w, 0.0) * zap_window(r.y, u_startOffset, u_length));
      if (br.count > 0) cov = max(cov, zap_branches(p, B, id, sb, hw, br, halo).x);
    }
  }
  fragColor = vec4(vec3(cov), cov);
}`,
			},
			...zapTail(p, ctx, 2, true),
		],
	},
});

export const S_ZAP_FROM = defineShaderEffect({
	id: 'jasper.s.zap-from',
	label: 'S_ZapFrom',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'Many lightning bolts shooting outwards from the edges of objects in the FromObject clip (the layer itself when none is chosen), with branches and a coloured glow. Show ▸ Edges displays the detected edges.',
	keywords: ['lightning', 'electricity', 'bolt', 'zap', 'edges', 'aura', 'electrified', 'object'],
	expensive: true,
	params: [
		fxParam.media('fromObject', 'FromObject', ['image', 'video']),
		int('surfaceBolts', 'Surface Bolts', 25, 1, 2000, 256),
		n('threshold', 'Threshold', 0.5, 0, undefined, { softMax: 1, step: 0.001 }),
		n('blurFromObj', 'Blur FromObj', 0.088, 0, undefined, { softMax: 0.5, step: 0.0001 }),
		objUseParam('fromObjUse', 'FromObj Use'),
		n('maxLength', 'Max Length', 0.2, 0, undefined, { softMax: 1, step: 0.001 }),
		n('varyLength', 'Vary Length', 0.5, 0, 1, { step: 0.01 }),
		n('varySpacing', 'Vary Spacing', 0.5, 0, undefined, { softMax: 1, step: 0.01 }),
		n('boltWidth', 'Bolt Width', 0.07, 0, undefined, { softMax: 1, step: 0.001 }),
		n('varyWidth', 'Vary Width', 0, 0, 1, { step: 0.01 }),
		n('endPointiness', 'End Pointiness', 1, 0, 1, { step: 0.01 }),
		...wiggleParams(),
		n('wrinkleAmp', 'Wrinkle Amp', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('curveAmp', 'Curve Amp', 0.5, 0, undefined, { softMax: 3, step: 0.01 }),
		n('branchiness', 'Branchiness', 1, 0, 10, { step: 0.01 }),
		n('branchAngle', 'Branch Angle', 65, 0, 180, { step: 0.1, unit: 'deg' }),
		n('branchLength', 'Branch Length', 0.5, 0, 3, { step: 0.01 }),
		...glowParams(),
		...zapOutParams(),
		...atmosphereParams(),
		...sapphireCommonParams({ seed: true, show: [{ value: 'edges', label: 'Edges' }] }),
	],
	gpu: {
		kind: 'generator',
		padding: (p, ctx) => {
			// bolts leave the object outwards: they may reach Max Length beyond the layer box (+ glow)
			const u = 0.5 * ctx.width;
			return Math.min(1024, num(p.maxLength, 0.2) * u * 1.2 + num(p.glowWidth, 0.224) * u * GLOW_K * 3);
		},
		uniforms: (p, ctx) => ({ ...commonZapUniforms(p, ctx), ...objUniform(p, 'fromObjUse') }),
		passes: (p, ctx) => [
			...objectPasses(p, ctx, 'fromObject', 'blurFromObj', 0.088),
			pointsPass(ctx, 'u_surfaceBolts', 'stratified'),
			{
				output: 'core',
				format: 'rgba16f',
				include: [GLSL_ZAP_BOLT_STRAIGHT],
				frag: /* glsl */ `
${DECODE}
void main() {
  vec2 p = srt_here();
  float U = srt_unit();
  float hw = u_boltWidth * U * ${BOLT_K};
  float halo = hw * 3.0 + 2.0;
  int pts = int(clamp(u_surfaceBolts, 0.0, 256.0));
  ZapBranches br = ZapBranches(int(clamp(floor(u_branchiness * 3.0 + 0.5), 0.0, 24.0)), u_branchAngle, u_branchLength,
    0.6, 0.0, u_endPointiness, u_startOffset, u_length);
  float cov = 0.0;
  for (int k = 0; k < 256; k++) {
    if (k >= pts) break;
    vec4 e = zt_point(k);
    if (e.w < 0.5) continue;
    vec2 a = srt_pt(e.xy);
    float hL = zap_h(k, 0, 310, u_zseed);
    float L = u_maxLength * U * (1.0 - clamp(u_varyLength, 0.0, 1.0) * hL);
    if (L < 1.0) continue;
    vec2 d = vec2(cos(e.z), sin(e.z));
    d = srt_rot(d, (zap_h(k, 0, 311, u_zseed) - 0.5) * 0.6);
    ZapStyle st = ZapStyle(u_curveAmp, u_wrinkleAmp, u_tau, u_zseed, vec2(1.0, 0.0));
    float reach = zap_amp(L, st) + halo + (br.count > 0 ? L * u_branchLength * 1.6 : 0.0);
    vec2 q = p - a;
    float u = clamp(dot(q, d), 0.0, L);
    if (distance(p, a + d * u) > reach) continue;
    ZapBase B = ZapBase(false, a, d, L, vec2(0.0));
    vec2 r = zap_bolt(p, B, k, st, halo);
    float w = hw * zap_taper(r.y, 0.0, u_endPointiness) * zap_vary(r.y, k, st, u_varyWidth);
    cov = max(cov, zap_cov(r.x, w, 0.0) * zap_window(r.y, u_startOffset, u_length));
    if (br.count > 0) cov = max(cov, zap_branches(p, B, k, st, hw, br, halo).x);
  }
  fragColor = vec4(vec3(cov), cov);
}`,
			},
			...zapTail(p, ctx, 2, true),
		],
	},
});

export const SAPPHIRE_LIGHTNING_EFFECTS: readonly EffectSpec[] = [S_ULTRA_ZAP, S_ZAP, S_ZAP_TO, S_ZAP_FROM];

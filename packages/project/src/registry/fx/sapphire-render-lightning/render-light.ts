// Sapphire Render ▸ light generators: S_Aurora (curtains of light swirling along a spline), S_LaserBeam (a sci-fi
// blaster beam flying from a source to a target, optionally driven by time) and S_MuzzleFlash (gun flash with
// primary/secondary lobes, timed flashes and a glow). Each draws an HDR picture, blurs/glows it in extra passes and
// combines the light with the source.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam, sapphireCommonParams } from '../params.ts';
import type { FxFrameContext } from '../shader.ts';
import {
	blurXYPasses,
	combineParam,
	combineUniforms,
	flag,
	GLSL_SRT_ATMOS,
	GLSL_SRT_COMMON,
	GLSL_SRT_NOISE,
	GLSL_SRT_SPLINE,
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

const atmosphere = (freq: number, detail: number) => [
	n('atmosphereAmp', 'Atmosphere Amp', 0, 0, undefined, { softMax: 2, step: 0.01 }),
	n('atmosphereFreq', 'Atmosphere Freq', freq, 0.1, 20, { step: 0.01 }),
	n('atmosphereDetail', 'Atmosphere Detail', detail, 0, 1, { step: 0.01 }),
	n('atmosphereSpeed', 'Atmosphere Speed', 1, undefined, undefined, { softMin: -5, softMax: 5, step: 0.01 }),
];

// ---------------------------------------------------------------- S_Aurora

const AURORA_COMBINE = lightCombine('Aurora');
const AURORA_POINTS = {
	start: [0.15, 0.144],
	controlPoint1: [0.335, 0.144],
	controlPoint2: [0.52, 0.322],
	controlPoint3: [0.45, 0.856],
	controlPoint4: [0.725, 0.793],
	end: [0.9, 0.944],
} as const;
const AURORA_ENABLES = { point1Enable: false, point2Enable: true, point3Enable: true, point4Enable: false };
const AURORA_NAMES = {
	start: 'start',
	end: 'end',
	points: [
		['point1Enable', 'controlPoint1'],
		['point2Enable', 'controlPoint2'],
		['point3Enable', 'controlPoint3'],
		['point4Enable', 'controlPoint4'],
	],
} as const;

export const S_AURORA = defineShaderEffect({
	id: 'jasper.s.aurora',
	label: 'S_Aurora',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'A two-coloured swirl of light along a spline, like the Aurora Borealis: swirling curtains with vertical rays, a soft vertical spread and an optional circular light.',
	keywords: ['aurora', 'northern lights', 'borealis', 'sky', 'curtain', 'glow'],
	expensive: true,
	params: [
		fxParam.point('start', 'Start', [...AURORA_POINTS.start]),
		fxParam.toggle('point1Enable', 'Point 1 Enable', false),
		fxParam.point('controlPoint1', 'Control Point 1', [...AURORA_POINTS.controlPoint1]),
		fxParam.toggle('point2Enable', 'Point 2 Enable', true),
		fxParam.point('controlPoint2', 'Control Point 2', [...AURORA_POINTS.controlPoint2]),
		fxParam.toggle('point3Enable', 'Point 3 Enable', true),
		fxParam.point('controlPoint3', 'Control Point 3', [...AURORA_POINTS.controlPoint3]),
		fxParam.toggle('point4Enable', 'Point 4 Enable', false),
		fxParam.point('controlPoint4', 'Control Point 4', [...AURORA_POINTS.controlPoint4]),
		fxParam.point('end', 'End', [...AURORA_POINTS.end]),
		rgb('startColor', 'Start Color', [0, 0.8, 0.3]),
		rgb('endColor', 'End Color', [0.6, 0.2, 0.8]),
		n('colorPhase', 'Color Phase', 0, 0, undefined, { softMax: 4, step: 0.001 }),
		n('strokeSize', 'Stroke Size', 0.25, 0, undefined, { softMax: 2, step: 0.001 }),
		n('brightness', 'Brightness', 0.3, 0, undefined, { softMax: 2, step: 0.001 }),
		n('softness', 'Softness', 0.075, 0, undefined, { softMax: 0.5, step: 0.001 }),
		n('softnessRelY', 'Softness Rel Y', 10, 0, undefined, { softMax: 20, step: 0.01 }),
		int('swirlComplexity', 'Swirl Complexity', 3, 1, undefined, 6),
		n('swirlMagnitude', 'Swirl Magnitude', 0.7, 0, undefined, { softMax: 3, step: 0.001 }),
		n('magnitudeRelY', 'Magnitude Rel Y', 1.25, 0, undefined, { softMax: 5, step: 0.01 }),
		n('swirlFrequency', 'Swirl Frequency', 2, 0, 50, { step: 0.01 }),
		n('frequencyRelY', 'Frequency Rel Y', 10, 0, undefined, { softMax: 30, step: 0.01 }),
		n('swirlSpeedX', 'Swirl Speed X', 0.1, undefined, undefined, { softMin: -2, softMax: 2, step: 0.001 }),
		n('swirlSpeedY', 'Swirl Speed Y', 0, undefined, undefined, { softMin: -2, softMax: 2, step: 0.001 }),
		n('lightBrightness', 'Light Brightness', 1, 0, undefined, { softMax: 5, step: 0.01 }),
		fxParam.point('lightPos', 'Light Pos', [0.35, 0.944]),
		rgb('lightColor', 'Light Color', [1, 1, 1]),
		n('ambientLight', 'Ambient Light', 1, 0, undefined, { softMax: 3, step: 0.01 }),
		n('lightRadius', 'Light Radius', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('lightSoftness', 'Light Softness', 2, 0, undefined, { softMax: 5, step: 0.01 }),
		n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		combineParam(AURORA_COMBINE, 'screen'),
		n('affectAlpha', 'Affect Alpha', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => ({
			...combineUniforms(p, AURORA_COMBINE, 'screen'),
			u_spline: splineUniform(splinePoints(p, ctx, AURORA_NAMES, AURORA_POINTS, AURORA_ENABLES)),
		}),
		passes: (p, ctx) => {
			const sx = num(p.softness, 0.075) * unitPx(ctx) * 0.25 + 1;
			const sy = sx * Math.max(0, num(p.softnessRelY, 10));
			return [
				{
					output: 'aur',
					scale: 0.5,
					format: 'rgba16f',
					include: [GLSL_SRT_COMMON, GLSL_SRT_NOISE, GLSL_SRT_SPLINE],
					frag: /* glsl */ `
void main() {
  vec2 p = srt_here();
  float U = srt_unit();
  float L = srt_splineLen();
  uint s0 = srt_seed(u_seed);
  int layers = int(clamp(u_swirlComplexity, 1.0, 6.0));
  vec3 acc = vec3(0.0);
  vec2 sap = (p - u_box.xy) / U;
  for (int l = 0; l < 6; l++) {
    if (l >= layers) break;
    float fl = float(l);
    uint sl = s0 + uint(l) * 0x9e3779b9u;
    vec3 np = vec3(sap.x * u_swirlFrequency * 0.5 - u_time * u_swirlSpeedX, sap.y * u_swirlFrequency * 0.25, fl * 3.7 + u_time * u_swirlSpeedY);
    vec2 sw = vec2(srt_gnoise3(np, sl), srt_gnoise3(np + vec3(19.1, 7.3, 0.0), sl));
    vec2 q = p + sw * vec2(1.0, u_magnitudeRelY) * u_swirlMagnitude * U * 0.25;
    vec2 sv = srt_splineNearest(q);
    float width = max(u_strokeSize * U * 0.5 * (0.6 + 0.25 * fl), 1.0);
    float band = exp(-(sv.y * sv.y) / (width * width));
    float rays = 0.5 + 0.5 * srt_gnoise3(vec3(sv.x / U * u_swirlFrequency * u_frequencyRelY * 0.5 + u_time * u_swirlSpeedX * 3.0,
      fl * 5.3, u_time * 0.15), sl ^ 0x5bd1e995u);
    rays = rays * rays * 1.8;
    float tc = clamp(sv.x / L, 0.0, 1.0);
    float tcol = 0.5 - 0.5 * cos(SRT_PI * (tc + u_colorPhase));
    acc += mix(u_startColor.rgb, u_endColor.rgb, tcol) * band * rays / (1.0 + fl * 0.6);
  }
  fragColor = vec4(acc, clamp(srt_max3(acc), 0.0, 1.0));
}`,
				},
				...blurXYPasses({ input: 'aur', output: 'soft', sigmaX: sx, sigmaY: sy, scale: 0.25 }),
				{
					include: [GLSL_SRT_COMMON, GLSL_COMPOSITE],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float U = srt_unit();
  vec3 a = texture(u_soft, v_uv).rgb * 0.75 + texture(u_aur, v_uv).rgb * 0.25;
  float dl = distance(srt_here(), srt_pt(u_lightPos)) / U;
  float fall = 1.0 - smoothstep(u_lightRadius, u_lightRadius + max(u_lightSoftness, 1.0e-3), dl);
  vec3 illum = mix(vec3(u_ambientLight), u_lightColor.rgb * u_lightBrightness, fall);
  vec3 light = a * u_brightness * illum * 4.0;
  vec4 res = srt_light(u_combineOp, src, light, u_bgBrightness, u_affectAlpha);
  fragColor = fx_finish(res, src, clamp(srt_max3(light), 0.0, 1.0), u_mixWithOriginal, u_show);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- S_LaserBeam

const BEAM_COMBINE = lightCombine('Beam');
const LASER_SHAPES = ['smooth', 'spear', 'forward', 'backward'] as const;

/** Head position of the beam along the Start → Stop trajectory (0..1 + Length); Use Time flies it over Duration. */
export function laserHead(p: EffectParams, ctx: Pick<FxFrameContext, 'frame'>): number {
	if (!flag(p.useTime)) return num(p.position, 0.5);
	const dur = Math.max(1e-3, num(p.flightDuration, 10));
	return ((ctx.frame - num(p.startTime)) / dur) * (1 + num(p.length, 0.5));
}

export const S_LASER_BEAM = defineShaderEffect({
	id: 'jasper.s.laser-beam',
	label: 'S_LaserBeam',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'A sci-fi laser blaster beam: a glowing bolt of light between Start and Stop with a core/edge colour, shaped ends and ragged edges; Use Time flies it from source to target over Duration frames.',
	keywords: ['laser', 'beam', 'blaster', 'phaser', 'sci-fi', 'ray', 'shot'],
	params: [
		fxParam.point('start', 'Start', [0.278, 0.755]),
		fxParam.point('stop', 'Stop', [0.556, 0.207]),
		fxParam.vec2('shift', 'Shift', [0, 0], { step: 0.001, softMin: -1, softMax: 1 }),
		n('position', 'Position', 0.5, 0, undefined, { softMax: 2, step: 0.001 }),
		n('length', 'Length', 0.5, 0.001, undefined, { softMax: 2, step: 0.001 }),
		n('width', 'Width', 0.01, 0.001, undefined, { softMax: 0.1, step: 0.0001 }),
		rgb('coreColor', 'Core Color', [1, 1, 0]),
		rgb('edgeColor', 'Edge Color', [1, 0, 0]),
		n('colorBalance', 'Color Balance', 0.5, 0, 1, { step: 0.01 }),
		n('brightness', 'Brightness', 1, 0, undefined, { softMax: 5, step: 0.01 }),
		n('softness', 'Softness', 1, 0, undefined, { softMax: 5, step: 0.01 }),
		n('fadeBack', 'Fade Back', 0, 0, undefined, { softMax: 1, step: 0.01 }),
		n('fadeFront', 'Fade Front', 0, 0, undefined, { softMax: 1, step: 0.01 }),
		n('startTime', 'Start Time', 0, 0, undefined, { softMax: 300, step: 1, unit: 'frames' }),
		n('flightDuration', 'Duration', 10, 0, 500, { step: 1, unit: 'frames' }),
		fxParam.choice('laserShape', 'Laser Shape', LASER_SHAPES, ['Smooth', 'Spear', 'Forward', 'Backward'], 'forward'),
		n('perspective', 'Perspective', 0, -1, 1, { step: 0.01 }),
		fxParam.toggle('useTime', 'Use Time', false),
		n('breakup', 'Breakup', 0.05, 0, 1, { step: 0.001 }),
		n('smooth', 'Smooth', 0, 0, undefined, { softMax: 2, step: 0.01 }),
		...atmosphere(4, 0.8),
		n('affectAlpha', 'Affect Alpha', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		combineParam(BEAM_COMBINE, 'screen'),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => ({ ...combineUniforms(p, BEAM_COMBINE, 'screen'), u_head: laserHead(p, ctx) }),
		passes: (p, ctx) => [
			{
				output: 'core',
				format: 'rgba16f',
				include: [GLSL_SRT_COMMON, GLSL_SRT_NOISE],
				frag: /* glsl */ `
float lb_profile(float u) {
  if (u < 0.0 || u > 1.0) return 0.0;
  if (u_laserShape == 0) return sqrt(sin(SRT_PI * u));
  if (u_laserShape == 1) return 1.0 - abs(2.0 * u - 1.0);
  if (u_laserShape == 2) return sqrt(u) * sqrt(clamp((1.0 - u) * 10.0, 0.0, 1.0));
  return sqrt(1.0 - u) * sqrt(clamp(u * 10.0, 0.0, 1.0));
}
void main() {
  vec2 a = srt_pt(u_start + u_shift), b = srt_pt(u_stop + u_shift);
  vec2 p = srt_here();
  float U = srt_unit();
  vec2 e = b - a;
  float L = max(length(e), 1.0e-3);
  vec2 d = e / L;
  float x = dot(p - a, d) / L;
  float y = dot(p - a, vec2(-d.y, d.x));
  float len = max(u_length, 1.0e-3);
  float u = (x - (u_head - len)) / len;
  float traj = smoothstep(-1.0 / L, 1.0 / L, x) * smoothstep(1.0 + 1.0 / L, 1.0 - 1.0 / L, x);
  float w = u_width * U * max(0.05, 1.0 + u_perspective * (2.0 * x - 1.0));
  float nz = srt_vnoise2(vec2(x * L / max(w, 1.0) * 0.5 - u_time * 6.0, y / max(w, 1.0) * 0.7), srt_seed(u_seed + 0.13));
  float wu = w * lb_profile(u) * max(0.0, 1.0 + u_breakup * 3.0 * nz);
  float soft = max(u_softness, 0.02) * (1.0 + u_smooth);
  float r = abs(y) / max(wu, 0.35);
  float I = exp(-r * r * 2.0 / soft) * smoothstep(0.0, 0.6, wu);
  float coreMix = exp(-r * r * 5.0 / soft);
  vec3 col = mix(u_edgeColor.rgb, u_coreColor.rgb, clamp(coreMix * 2.0 * u_colorBalance, 0.0, 1.0));
  float fb = max(0.0, 1.0 - u_fadeBack * (1.0 - smoothstep(0.0, 0.5, u)));
  float ff = max(0.0, 1.0 - u_fadeFront * smoothstep(0.5, 1.0, u));
  vec3 light = col * I * fb * ff * traj * u_brightness * 1.5;
  fragColor = vec4(light, clamp(srt_max3(light), 0.0, 1.0));
}`,
			},
			...glowPasses({
				input: 'core',
				out: 'glow',
				sigma: Math.max(1, num(p.width, 0.01) * unitPx(ctx) * 3),
				rel: [1, 1, 1],
				wide: 3,
				maxLevels: 4,
			}),
			{
				include: [GLSL_SRT_COMMON, GLSL_SRT_ATMOS, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 g = texture(u_glowA, v_uv).rgb * 0.7 + texture(u_glowB, v_uv).rgb * 0.5;
  float atm = srt_atmosphere(srt_sapphire(srt_here()), u_atmosphereAmp, u_atmosphereFreq, u_atmosphereDetail,
    u_atmosphereSpeed, fract(u_seed + 0.31));
  vec3 light = texture(u_core, v_uv).rgb + g * 1.5 * atm;
  vec4 res = srt_light(u_combineOp, src, light, 1.0, u_affectAlpha);
  fragColor = fx_finish(res, src, clamp(srt_max3(light), 0.0, 1.0), u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_MuzzleFlash

const FLASH_COMBINE = lightCombine('MuzzleFlash');
const GUNS = ['ak47', 'beretta', 'colt45', 'm16', 'gauge12'] as const;
/** Per gun: primary length, primary width, secondary count factor, fireball size. */
const GUN_SHAPE: Record<(typeof GUNS)[number], [number, number, number, number]> = {
	ak47: [1.35, 1.15, 0.5, 1.1],
	beretta: [0.6, 0.8, 0, 0.7],
	colt45: [0.5, 1.25, 0, 0.85],
	m16: [1, 1, 1, 1],
	gauge12: [1.1, 2.1, 0, 1.6],
};
const VARIANTS = ['one', 'two', 'three', 'random'] as const;
const TIME_MODES = ['always', 'repeat', 'repeatFade'] as const;

/** Flash visibility (0..1) and the flash index at a frame for the Time Mode params (pure). */
export function muzzleTiming(p: EffectParams, frame: number): { vis: number; index: number } {
	const mode = typeof p.timeMode === 'string' ? p.timeMode : 'always';
	if (mode === 'always') return { vis: 1, index: frame };
	const start = Math.round(num(p.startTime));
	const dur = Math.round(num(p.flashDuration, 10));
	const gap = Math.max(1, Math.round(num(p.gapTime, 3)));
	const rel = frame - start;
	if (rel < 0 || rel >= dur) return { vis: 0, index: 0 };
	const index = Math.floor(rel / gap);
	const age = rel - index * gap;
	if (mode === 'repeat') return { vis: age === 0 ? 1 : 0, index };
	const fade = Math.max(1, Math.round(num(p.fadeTime, 1)));
	return { vis: age < fade ? 1 - age / fade : 0, index };
}

export const S_MUZZLE_FLASH = defineShaderEffect({
	id: 'jasper.s.muzzle-flash',
	label: 'S_MuzzleFlash',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'The flash of a gun being fired: a fireball with a primary flame and secondary (suppressor) jets for several gun types, timed flashes (Always / Repeat / Repeat+Fade, in frames) and a coloured glow.',
	keywords: ['muzzle', 'flash', 'gun', 'shot', 'fire', 'blast', 'weapon'],
	params: [
		fxParam.point('location', 'Location', [0.5, 0.5]),
		n('elevation', 'Elevation', 0, -360, 360, { step: 0.1, unit: 'deg' }),
		n('rotation', 'Rotation', 0, -360, 360, { step: 0.1, unit: 'deg' }),
		n('radius', 'Radius', 0.2, 0.05, undefined, { softMax: 1, step: 0.001 }),
		n('brightness', 'Brightness', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('shiftOut', 'Shift Out', 0, 0, undefined, { softMax: 1, step: 0.001 }),
		fxParam.choice('gun', 'Gun', GUNS, ['AK47', 'Beretta', 'Colt45', 'M16', '12Gauge'], 'm16'),
		fxParam.choice('variant', 'Variant', VARIANTS, ['One', 'Two', 'Three', 'Random'], 'two'),
		fxParam.toggle('animateSeed', 'Animate Seed', false),
		int('octaves', 'Octaves', 3, 1, 6),
		n('blur', 'Blur', 0.0015, 0, undefined, { softMax: 0.05, step: 0.0001 }),
		n('midDensity', 'Mid Density', 0.4, 0.01, 0.99, { step: 0.01 }),
		rgb('midColor', 'Mid Color', [1, 0.792, 0.6]),
		n('affectAlpha', 'Affect Alpha', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		combineParam(FLASH_COMBINE, 'screen'),
		n('primaryLength', 'Primary Length', 0.21, 0, undefined, { softMax: 1, step: 0.001 }),
		n('primaryWidth', 'Primary Width', 0.035, 0, undefined, { softMax: 0.3, step: 0.001 }),
		n('primaryBrightness', 'Primary Brightness', 0.6, 0, undefined, { softMax: 2, step: 0.01 }),
		n('primaryPuff', 'Primary Puff', 0.8, 0, undefined, { softMax: 2, step: 0.01 }),
		n('primaryDetail', 'Primary Detail', 0.5, 0, undefined, { softMax: 2, step: 0.01 }),
		int('secondaryNumber', 'Secondary Number', 6, 0, 10),
		n('secondaryAngle', 'Secondary Angle', 66, 0, 89, { step: 0.1, unit: 'deg' }),
		n('secondaryLength', 'Secondary Length', 0.11, 0, undefined, { softMax: 1, step: 0.001 }),
		n('secondaryWidth', 'Secondary Width', 0.02, 0, undefined, { softMax: 0.3, step: 0.001 }),
		n('secondaryBrightness', 'Secondary Brightness', 0.6, 0, undefined, { softMax: 2, step: 0.01 }),
		n('secondaryPuff', 'Secondary Puff', 0.7, 0, undefined, { softMax: 2, step: 0.01 }),
		n('secondaryDetail', 'Secondary Detail', 0.8, 0, undefined, { softMax: 2, step: 0.01 }),
		fxParam.choice('timeMode', 'Time Mode', TIME_MODES, ['Always', 'Repeat', 'Repeat+Fade'], 'always'),
		int('startTime', 'Start Time', 0, 0, undefined, 300),
		int('flashDuration', 'Duration', 10, 0, 500),
		int('gapTime', 'Gap Time', 3, 1, 50),
		int('fadeTime', 'Fade Time', 1, 1, 5),
		rgb('glowColor', 'Glow Color', [0.1, 0.1, 1]),
		n('glowBright', 'Glow Bright', 3, 0, 8, { step: 0.01 }),
		n('glowWidth', 'Glow Width', 1, 0, 2, { step: 0.01 }),
		n('glowThreshold', 'Glow Threshold', 0.1, 0.01, 1, { step: 0.001 }),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		padding: (p, ctx) => {
			// the flame may leave the layer when the gun sits near an edge
			const u = 0.5 * ctx.width * (num(p.radius, 0.2) / 0.2);
			return Math.min(512, u * (num(p.primaryLength, 0.21) * 1.4 + num(p.glowWidth, 1) * 0.1));
		},
		uniforms: (p, ctx) => {
			const t = muzzleTiming(p, ctx.frame);
			const gun = GUN_SHAPE[(GUNS as readonly string[]).includes(p.gun as string) ? (p.gun as (typeof GUNS)[number]) : 'm16'];
			const variant = (VARIANTS as readonly string[]).indexOf(String(p.variant));
			let k = variant < 0 ? 1 : variant;
			if (variant === 3) k = 3 + t.index;
			if (flag(p.animateSeed)) k += ctx.frame * 7;
			const s = ctx.seed + k * 0.6180339887;
			return {
				...combineUniforms(p, FLASH_COMBINE, 'screen'),
				u_vis: t.vis,
				u_mseed: s - Math.floor(s),
				u_gunShape: gun,
			};
		},
		passes: (p, ctx) => [
			{
				output: 'core',
				format: 'rgba16f',
				include: [GLSL_SRT_COMMON, GLSL_SRT_NOISE],
				frag: /* glsl */ `
// Density of one flame lobe along a 3D direction (projected; foreshortened lobes get shorter and rounder).
float mf_lobe(vec2 q, vec3 dir, float len, float width, float puff, float detail, uint s, int id) {
  float fl = length(dir.xy);
  vec2 dd = fl > 1.0e-3 ? dir.xy / fl : vec2(1.0, 0.0);
  float Lp = max(len * max(fl, 0.12), 1.0e-4);
  float a = dot(q, dd), b = dot(q, vec2(-dd.y, dd.x));
  float sN = a / Lp;
  float sc = clamp(sN, 0.0, 1.0);
  float wN = max(width, 1.0e-4) * (0.35 + 1.9 * sc * exp(-2.2 * sc)) * (1.0 + (1.0 - fl) * 2.5);
  float env = smoothstep(-0.15, 0.05, sN) * (1.0 - smoothstep(0.5, 1.0, sN));
  float k = 0.6 + detail * 1.4;
  float nz = srt_fbm3(vec3(a / max(width, 1.0e-4) * k * 0.5, b / max(width, 1.0e-4) * k, float(id) * 7.1), int(clamp(u_octaves, 1.0, 5.0)), 0.55, s + uint(id) * 977u);
  return exp(-(b * b) / (wN * wN)) * env * max(0.0, 1.0 + puff * nz * 1.3);
}
void main() {
  float U = srt_unit();
  uint s = srt_seed(u_mseed);
  float sc = u_radius / 0.2;
  float rot = radians(u_rotation), el = radians(u_elevation);
  vec3 A = vec3(cos(el) * cos(rot), cos(el) * sin(rot), sin(el));
  vec2 o = srt_pt(u_location) + A.xy * u_shiftOut * U;
  vec2 q = (srt_here() - o) / U;
  float soft = 1.0 + u_blur * 400.0;
  float rb = 0.05 * sc * u_gunShape.w;
  float nb = srt_fbm3(vec3(q / max(rb, 1.0e-4) * 1.2, 3.3), int(clamp(u_octaves, 1.0, 5.0)), 0.5, s);
  float D = exp(-dot(q, q) / (rb * rb * soft)) * max(0.0, 1.0 + 0.6 * nb);
  D += mf_lobe(q, A, u_primaryLength * sc * u_gunShape.x, u_primaryWidth * sc * u_gunShape.y * soft, u_primaryPuff,
    u_primaryDetail, s, 0) * u_primaryBrightness / 0.6;
  vec3 B1 = abs(A.z) < 0.99 ? normalize(cross(A, vec3(0.0, 0.0, 1.0))) : vec3(1.0, 0.0, 0.0);
  vec3 B2 = cross(A, B1);
  int ns = int(clamp(floor(u_secondaryNumber * u_gunShape.z + 0.5), 0.0, 10.0));
  float al = radians(u_secondaryAngle);
  for (int k = 0; k < 10; k++) {
    if (k >= ns) break;
    float th = SRT_TAU * (float(k) + 0.5) / float(ns) + 0.3;
    vec3 dir = cos(al) * A + sin(al) * (cos(th) * B1 + sin(th) * B2);
    float jitter = 0.75 + 0.5 * srt_h1(k, s);
    D += mf_lobe(q, dir, u_secondaryLength * sc * jitter, u_secondaryWidth * sc * soft, u_secondaryPuff,
      u_secondaryDetail, s, k + 1) * u_secondaryBrightness / 0.6;
  }
  D = clamp(D, 0.0, 2.0);
  float m = clamp(u_midDensity, 0.01, 0.99);
  vec3 col = D < m ? u_midColor.rgb * pow(D / m, 1.5) * 0.85 : mix(u_midColor.rgb * 0.85, vec3(1.25, 1.2, 1.1), clamp((D - m) / (1.0 - m), 0.0, 1.0));
  vec3 light = col * u_brightness * u_vis * smoothstep(0.0, 0.08, D);
  fragColor = vec4(light, clamp(srt_max3(light), 0.0, 1.0));
}`,
			},
			...glowPasses({
				input: 'core',
				out: 'glow',
				sigma: Math.max(1, num(p.glowWidth, 1) * num(p.radius, 0.2) * unitPx(ctx) * 0.35),
				rel: [1, 1, 1],
				wide: 3,
				threshold: num(p.glowThreshold, 0.1),
				maxLevels: 4,
			}),
			{
				include: [GLSL_SRT_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 g = texture(u_glowA, v_uv).rgb * 0.6 + texture(u_glowB, v_uv).rgb * 0.4;
  vec3 light = texture(u_core, v_uv).rgb + g * u_glowColor.rgb * u_glowBright;
  vec4 res = srt_light(u_combineOp, src, light, 1.0, u_affectAlpha);
  fragColor = fx_finish(res, src, clamp(srt_max3(light), 0.0, 1.0), u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

export const SAPPHIRE_RENDER_LIGHT_EFFECTS: readonly EffectSpec[] = [S_AURORA, S_LASER_BEAM, S_MUZZLE_FLASH];

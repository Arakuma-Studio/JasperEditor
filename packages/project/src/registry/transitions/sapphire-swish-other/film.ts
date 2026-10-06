// Film transitions of the family: S_FilmBurnTransition (a fast dissolve hidden by drifting light-leak flashes, with
// sprocket edges and film dirt) and S_FilmRoll (the film slips in the gate: the clips roll vertically with a frame
// line between them, shake, flicker, dirt). The film look reuses the Sapphire film/grain family's GLSL (grain,
// dust, hairs, scratches, stains, element combine) by import, so the transitions match S_FilmBurn / S_FilmDamage.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { GLSL_UV } from '../../fx/glsl/sample.ts';
import { fxParam } from '../../fx/params.ts';
import { GLSL_COMBINE, GLSL_DIRT, GLSL_FILM } from '../../fx/sapphire-film-grain/glsl.ts';
import type { FxUniformValue } from '../../fx/shader.ts';
import { defineShaderTransition, SAPPHIRE_TRANSITION_SUBBINS, TRANSITION_BINS } from '../define.ts';
import {
	bool,
	check,
	choice,
	GLSL_SW,
	GLSL_SW_SHUTTER,
	hash01,
	num,
	rgbParam,
	sapphirePoint,
	sapphireSeed,
	shakeOffset,
	shutterUniforms,
	sInt,
	slowParams,
	smoothNoise,
	sNum,
} from './common.ts';

const BIN = TRANSITION_BINS.sapphire;
const OTHER = SAPPHIRE_TRANSITION_SUBBINS.other;

/** Dust cell size (px) and per-cell probability for an average `density` specks per frame on a w × h frame. */
export function dustCells(density: number, w: number, h: number): { cell: number; prob: number } {
	const n = Math.max(0, density);
	if (n <= 0) return { cell: 64, prob: 0 };
	const cell = Math.max(4, Math.sqrt((w * h) / (2 * n)));
	return { cell, prob: Math.min(1, (n * cell * cell) / (w * h)) };
}

// ---------------------------------------------------------------- S_FilmBurnTransition

type Flash = {
	size: number;
	stretch: number;
	rotation: number;
	brightness: number;
	center: [number, number];
	outer: [number, number, number];
	inner: [number, number, number];
	midpoint: number;
	softness: number;
	shape: 'circle' | 'polygon';
	sides: number;
	noiseAmp: number;
	flickerAmp: number;
	flickerFreq: number;
	motionAmount: number;
	motionAngle: number;
	motionDelay: number;
};

/**
 * Sapphire's defaults of the three flashes (centres in Sapphire units, converted to frame points; angles converted
 * to the editor's clockwise convention: Sapphire's Rotation −59° CCW = 59° CW, Motion Angle 90° (up) = −90°).
 */
const FLASHES: Flash[] = [
	{
		size: 1.4,
		stretch: 2.23,
		rotation: 59,
		brightness: 0.4,
		center: [-0.371, -2.97],
		outer: [1, 0.259, 0],
		inner: [0.741, 0.298, 0.349],
		midpoint: 0.4,
		softness: 1,
		shape: 'circle',
		sides: 6,
		noiseAmp: 0,
		flickerAmp: 2.9,
		flickerFreq: 5,
		motionAmount: 1,
		motionAngle: -90,
		motionDelay: 0,
	},
	{
		size: 2,
		stretch: 0.5,
		rotation: 0,
		brightness: 1,
		center: [3.03, -1.1],
		outer: [0.271, 0.271, 0.431],
		inner: [0.922, 0.0275, 0.902],
		midpoint: 0.8,
		softness: 1,
		shape: 'circle',
		sides: 5,
		noiseAmp: 1,
		flickerAmp: 0,
		flickerFreq: 0,
		motionAmount: 1.7,
		motionAngle: -145,
		motionDelay: 0,
	},
	{
		size: 1.4,
		stretch: 1,
		rotation: 0,
		brightness: 0.9,
		center: [0, -3.53],
		outer: [0.969, 0.969, 0.969],
		inner: [0.992, 0.208, 1],
		midpoint: 0.9,
		softness: 0.7,
		shape: 'polygon',
		sides: 4,
		noiseAmp: 1,
		flickerAmp: 1,
		flickerFreq: 5,
		motionAmount: 2,
		motionAngle: -90,
		motionDelay: 0.4,
	},
];

function flashParams(i: number, d: Flash): ParamSpec[] {
	const g = `Flash ${i}`;
	const n = (s: string) => `${s}${i}`;
	return [
		sNum(n('size'), `Size${i}`, d.size, { min: 0, softMax: 5 }, g),
		sNum(n('stretch'), `Stretch${i}`, d.stretch, { min: 0, softMax: 8 }, g),
		fxParam.angle(n('rotation'), `Rotation${i}`, d.rotation, { group: g }),
		sNum(n('brightness'), `Brightness${i}`, d.brightness, { softMin: 0, softMax: 4 }, g),
		fxParam.point(n('center'), `Center${i}`, sapphirePoint(d.center[0], d.center[1]), { group: g }),
		rgbParam(n('outerColor'), `Outer Color${i}`, d.outer, g),
		rgbParam(n('innerColor'), `Inner Color${i}`, d.inner, g),
		sNum(n('midpoint'), `Midpoint${i}`, d.midpoint, { min: 0, max: 1 }, g),
		sNum(n('softness'), `Softness${i}`, d.softness, { min: 0, softMax: 5 }, g),
		choice(n('shape'), `Shape${i}`, ['circle', 'polygon'], ['Circle', 'Polygon'], d.shape, g),
		sInt(n('numSides'), `Num Sides${i}`, d.sides, 3, 16, undefined, g),
		sNum(n('noiseAmp'), `Noise Amp${i}`, d.noiseAmp, { min: 0, softMax: 4 }, g),
		sNum(n('flickerAmp'), `Flicker Amp${i}`, d.flickerAmp, { min: 0, softMax: 5 }, g),
		sNum(n('flickerFreq'), `Flicker Freq${i}`, d.flickerFreq, { min: 0, softMax: 30 }, g),
		sNum(n('motionAmount'), `Motion Amount${i}`, d.motionAmount, { min: 0, softMax: 10 }, g),
		fxParam.angle(n('motionAngle'), `Motion Angle${i}`, d.motionAngle, { group: g }),
		sNum(n('motionDelay'), `Motion Delay${i}`, d.motionDelay, { min: 0, max: 1 }, g),
	];
}

/**
 * Per-frame flash state (TS): the drift of flash i in Sapphire units over the transition (Motion Amount along Motion
 * Angle after Motion Delay, ~1.5 units per unit of amount over the span) and its flicker gain.
 */
export function flashState(p: EffectParams, i: number, e: number, t: number, seed: number) {
	const k = Math.max(0, e - num(p[`motionDelay${i}`])) / Math.max(1e-3, 1 - num(p[`motionDelay${i}`]));
	const amt = num(p[`motionAmount${i}`], 1) * 1.5 * k;
	const a = (num(p[`motionAngle${i}`]) * Math.PI) / 180;
	// Editor angles are clockwise on screen (y down); Sapphire units are y up.
	const move: [number, number] = [amt * Math.cos(a), -amt * Math.sin(a)];
	const flicker = Math.max(
		0,
		1 + 0.5 * num(p[`flickerAmp${i}`]) * smoothNoise(seed, 30 + i, t * num(p[`flickerFreq${i}`], 5)),
	);
	return { move, flicker };
}

const FLASH_GLSL = /* glsl */ `
// Sapphire units of a frame px: x −1..1 over the width, y up (same unit).
vec2 fb_s(vec2 px) { return vec2(px.x - 0.5 * u_compSize.x, 0.5 * u_compSize.y - px.y) / (0.5 * u_compSize.x); }
// One light-leak flash at Sapphire position s: a stretched circle/polygon, inner → outer colour, soft falloff.
vec3 fb_flash(vec2 s, vec2 c, float size, float stretch, float rotDeg, vec3 outer, vec3 inner, float midpoint,
              float softness, int shape, float sides, float noiseAmp, float t, float seed) {
  vec2 d = s - c;
  float a = radians(rotDeg);
  d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;          // clockwise on screen = y-up counter-rotation
  d.x /= max(stretch, 1e-3);
  float r = length(d);
  if (shape == 1) {
    float n = max(sides, 3.0), seg = 6.2831853 / n;
    float m = mod(atan(d.y, d.x), seg) - 0.5 * seg;
    r *= cos(m) / cos(0.5 * seg);
  }
  r /= max(size, 1e-3);
  if (noiseAmp > 0.0) r *= 1.0 + 0.25 * noiseAmp * fx_simplex(d * 2.5 + t * 0.4, seed);
  float fall = pow(clamp(1.0 - r, 0.0, 1.0), max(softness, 0.05));
  vec3 col = mix(inner, outer, smoothstep(0.0, 1.0, clamp(r / max(midpoint, 0.02), 0.0, 1.0)));
  return col * fall;
}
// Sprocket holes down both sides (10 per frame height): (outline, hole) coverage.
vec2 fb_edges(vec2 px, float size) {
  vec2 s = fb_s(px) / max(size, 1e-3);
  float h = u_compSize.y / u_compSize.x * 2.0 / max(size, 1e-3);
  float pitch = h / 10.0;
  float x = abs(s.x) - 0.93;
  float y = mod(s.y + 0.5 * h, pitch) - 0.5 * pitch;
  vec2 q = abs(vec2(x, y)) - vec2(0.035, pitch * 0.32) + 0.012;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.012;
  float w = 2.0 / u_compSize.x;
  float hole = 1.0 - smoothstep(-w, w, sd);
  float outline = (1.0 - smoothstep(w, 3.0 * w, abs(sd))) * (1.0 - 0.5 * hole);
  return vec2(outline, hole);
}`;

/** Dirt layer A: (scratches 1, scratches 2, hairs, 0). */
const BURN_DIRT_A = /* glsl */ `
void main() {
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  float hd = box.x / 1920.0;
  float env = u_fbEnv;
  float s1 = 0.0, s2 = 0.0, hc = 0.0;
  if (u_scratches && env > 0.0) {
    float sw = max(0.6, u_scratchesWidth * 40.0 * hd);
    s1 = sfd_scratches(p, box, u_scratches1Amount * 4.0 * env, 3.0, sw, 1.0, 0.0, 1.5 * hd, 150.0, 0.11, 150.0, 0.0, 1.15, 0.0, 0.01, u_frame, fract(u_seed + 0.41));
    s2 = sfd_scratches(p, box, u_scratches2Amount * 4.0 * env, 9.0, sw, 1.0, 0.0, 1.5 * hd, 150.0, 0.11, 150.0, 0.0, 1.15, 0.0, 0.01, u_frame, fract(u_seed + 0.53));
  }
  if (u_hairsAndStains && env > 0.0)
    hc = sfd_hairs(p, box, u_hairsAmount * env, 4.5, 0.0, 1.0, 0.07 * box.x, max(0.8, 1.4 * hd), 1.0, u_frame, u_fps, fract(u_seed + 0.27));
  fragColor = vec4(s1, s2, hc, 0.0);
}`;

/** Dirt layer B: (stain coverage, stain random, dust coverage, dust random). */
const BURN_DIRT_B = /* glsl */ `
void main() {
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  float fr = floor(u_frame);
  vec2 st = u_hairsAndStains && u_fbEnv > 0.0 ? sfd_stains(p, box, u_stainsDensity * u_fbEnv, 0.06 * box.x, 0.0, fr, fract(u_seed + 0.11)) : vec2(0.0);
  vec2 du = u_dust ? sfd_dust(p, u_dustCellPx, u_dustProb, 0.0018 * box.x, 0.2, fract(u_seed + fr * 0.6180339)) : vec2(0.0);
  fragColor = vec4(st, du);
}`;

const FLASH_UNIFORMS = (p: EffectParams, e: number, t: number, seed: number) => {
	const out: Record<string, FxUniformValue> = {};
	for (const i of [1, 2, 3]) {
		const s = flashState(p, i, e, t, seed);
		out[`u_move${i}`] = s.move;
		out[`u_flicker${i}`] = s.flicker;
	}
	return out;
};

export const S_FILM_BURN_TRANSITION = defineShaderTransition({
	id: 'jasper.s.film-burn-transition',
	label: 'S_FilmBurnTransition',
	bin: BIN,
	subBin: OTHER,
	description:
		'A fast dissolve hidden by film burning in the gate: drifting coloured light-leak flashes, optional sprocket edges, scratches, hairs, stains, dust and grain peak at the cut.',
	keywords: ['film burn', 'light leak', 'flash', 'film', 'sprocket', 'vintage', 'burn'],
	params: [
		sNum('dissolveSpeed', 'Dissolve Speed', 50, { min: 1, softMax: 100 }),
		...slowParams(0.5),
		check('flash1', 'Flash1', true),
		check('flash2', 'Flash2', true),
		check('flash3', 'Flash3', true),
		check('edges', 'Edges', false),
		check('scratches', 'Scratches', true),
		check('hairsAndStains', 'Hairs And Stains', true),
		check('dust', 'Dust', true),
		check('grain', 'Grain', true),
		...FLASHES.flatMap((d, i) => flashParams(i + 1, d)),
		choice(
			'flashesCombine',
			'Flashes Combine',
			['normal', 'add', 'screen', 'mult', 'overlay'],
			['Normal', 'Add', 'Screen', 'Mult', 'Overlay'],
			'add',
		),
		sNum('edgesSize', 'Edges Size', 1.13, { min: 0, softMax: 3 }, 'Edges'),
		rgbParam('edgesOutlineColor', 'Edges Outline Color', [1, 1, 1], 'Edges'),
		rgbParam('edgesCenterColor', 'Edges Center Color', [0, 0, 0], 'Edges'),
		sNum('scratches1Amount', 'Scratches1 Amount', 0.5, { min: 0, softMax: 4 }, 'Scratches'),
		sNum('scratches2Amount', 'Scratches2 Amount', 0.5, { min: 0, softMax: 4 }, 'Scratches'),
		sNum('scratchesWidth', 'Scratches Width', 0.03, { min: 0, softMax: 0.2, step: 0.001 }, 'Scratches'),
		sNum('scratchesOpacity', 'Scratches Opacity', 1, { min: 0, max: 1 }, 'Scratches'),
		rgbParam('scratches1Color', 'Scratches1 Color', [0, 0, 0], 'Scratches'),
		rgbParam('scratches2Color', 'Scratches2 Color', [0.4, 0.4, 0.4], 'Scratches'),
		sNum('hairsAmount', 'Hairs Amount', 1.5, { min: 0, max: 6 }, 'Hairs And Stains'),
		sNum('hairsOpacity', 'Hairs Opacity', 0.3, { min: 0, max: 1 }, 'Hairs And Stains'),
		sNum('stainsDensity', 'Stains Density', 0.5, { min: 0, max: 4 }, 'Hairs And Stains'),
		sNum('stainsOpacity', 'Stains Opacity', 0.5, { min: 0, max: 1 }, 'Hairs And Stains'),
		sNum('dustDensity', 'Dust Density', 140, { min: 0, softMax: 600, step: 1 }, 'Dust'),
		sNum('dustOpacity', 'Dust Opacity', 0.5, { min: 0, max: 1 }, 'Dust'),
		sNum('grainAmp', 'Grain Amp', 1, { min: 0, max: 2 }, 'Grain'),
		sNum('grainSize', 'Grain Size', 1, { min: 0.001, softMax: 4 }, 'Grain'),
		sapphireSeed(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const e = ctx.progress;
			const t = ctx.frame / Math.max(1, ctx.fps);
			const dust = dustCells(num(p.dustDensity, 140), ctx.width, ctx.height);
			const env = Math.sin(Math.PI * Math.min(1, Math.max(0, e)));
			return {
				...FLASH_UNIFORMS(p, e, t, ctx.seed),
				u_fbEnv: env,
				u_dustCellPx: dust.cell,
				u_dustProb: bool(p.dust, true) ? dust.prob * env : 0,
				u_grainPx: Math.max(0.6, num(p.grainSize, 1) * (ctx.width / 1920) * 1.3),
			};
		},
		passes: [
			{ output: 'dirtA', include: [GLSL_DIRT], frag: BURN_DIRT_A, filter: 'nearest', scale: 1 },
			{ output: 'dirtB', include: [GLSL_DIRT], frag: BURN_DIRT_B, filter: 'nearest', scale: 1 },
			{
				include: [GLSL_SW, GLSL_COMBINE, GLSL_UV],
				frag: /* glsl */ `${FLASH_GLSL}
void main() {
  float p = tr_progress();
  float e = sw_slow(p, u_slowIn, u_slowOut);
  float w = clamp((e - 0.5) * max(u_dissolveSpeed, 1.0) * 0.5 + 0.5, 0.0, 1.0);
  if (e <= 0.0) w = 0.0;
  if (e >= 1.0) w = 1.0;
  vec4 src = mix(tr_from(v_uv), tr_to(v_uv), w);
  float env = u_fbEnv;
  if (env <= 0.0) { fragColor = src; return; }
  vec3 c = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec2 px = tr_px();
  vec2 s = fb_s(px);
  float t = u_frame / max(u_fps, 1.0);
  float le = pow(env, 0.6);
  vec3 light = vec3(0.0);
  if (u_flash1) light += le * u_brightness1 * u_flicker1 * fb_flash(s, fb_s(u_center1 * u_compSize) + u_move1, u_size1, u_stretch1, u_rotation1,
    u_outerColor1.rgb, u_innerColor1.rgb, u_midpoint1, u_softness1, u_shape1, u_numSides1, u_noiseAmp1, t, u_seed);
  if (u_flash2) light += le * u_brightness2 * u_flicker2 * fb_flash(s, fb_s(u_center2 * u_compSize) + u_move2, u_size2, u_stretch2, u_rotation2,
    u_outerColor2.rgb, u_innerColor2.rgb, u_midpoint2, u_softness2, u_shape2, u_numSides2, u_noiseAmp2, t, fract(u_seed + 0.3));
  if (u_flash3) light += le * u_brightness3 * u_flicker3 * fb_flash(s, fb_s(u_center3 * u_compSize) + u_move3, u_size3, u_stretch3, u_rotation3,
    u_outerColor3.rgb, u_innerColor3.rgb, u_midpoint3, u_softness3, u_shape3, u_numSides3, u_noiseAmp3, t, fract(u_seed + 0.6));
  // The cut hides in a burst of light at the switch.
  light += vec3(1.0, 0.85, 0.6) * 0.6 * exp(-pow((e - 0.5) * max(u_dissolveSpeed, 1.0) * 0.25, 2.0)) * le;
  if (u_flashesCombine == 0) c = mix(c, light, clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0));
  else if (u_flashesCombine == 1) c = c + light;
  else if (u_flashesCombine == 2) c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - clamp(light, 0.0, 1.0));
  else if (u_flashesCombine == 3) c = mix(c, c * light, env);
  else c = mix(c, fx_blendRgb(FX_BLEND_OVERLAY, clamp(c, 0.0, 1.0), clamp(light, 0.0, 1.0)), env);
  if (u_edges) {
    vec2 ed = fb_edges(px, u_edgesSize);
    c = mix(c, u_edgesCenterColor.rgb, ed.y * env);
    c = mix(c, u_edgesOutlineColor.rgb, ed.x * env);
  }
  vec4 dA = texture(u_dirtA, v_uv);
  vec4 dB = texture(u_dirtB, v_uv);
  if (u_scratches) {
    c = sfd_combine(0, c, u_scratches1Color.rgb, dA.x * u_scratchesOpacity);
    c = sfd_combine(0, c, u_scratches2Color.rgb, dA.y * u_scratchesOpacity);
  }
  if (u_hairsAndStains) {
    c = sfd_combine(0, c, vec3(0.0), dA.z * u_hairsOpacity);
    c = sfd_combine(4, c, mix(vec3(0.0), vec3(0.376), fract(dB.y * 7.31)), dB.x * u_stainsOpacity);
  }
  if (u_dust) c = sfd_combine(0, c, mix(vec3(1.0), vec3(0.553), fract(dB.w * 7.31)), dB.z * u_dustOpacity);
  if (u_grain && u_grainAmp > 0.0) {
    vec3 gn = sfg_grainNoise(px, vec3(u_grainPx), false, sfg_frameSeed(u_seed, u_frame, 1.0));
    c += gn * u_grainAmp * sfg_grainCurve(c, 2.0, 1.0, 0.5, vec3(0.5)) * 0.03 * env;
  }
  float a = max(src.a, clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0));
  fragColor = vec4(max(c, 0.0) * a, a);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_FilmRoll

/** Whole film frames S_FilmRoll rolls through (Roll Speed rounded, ≥ 1) and the direction (+1 up, −1 down). */
export function rollFrames(rollSpeed: unknown): { frames: number; dir: number } {
	const v = num(rollSpeed, 1);
	return { frames: Math.max(1, Math.round(Math.abs(v))), dir: v < 0 ? -1 : 1 };
}

/** Per-frame film signals of S_FilmRoll (TS): shake offset/velocity, flicker and defocus. */
export function filmRollSignals(p: EffectParams, ctx: { frame: number; fps: number; seed: number }) {
	const fps = Math.max(1, ctx.fps);
	const o = {
		amplitude: num(p.shakeAmplitude, 0.2) * 10,
		frequency: num(p.shakeFrequency, 1),
		jumpiness: num(p.shakeJumpiness, 1),
		random: num(p.shakeRandom, 0.1),
	};
	const at = (f: number) => shakeOffset(ctx.seed, f / fps, o);
	const now = at(ctx.frame);
	const prev = at(ctx.frame - 1);
	const flicker =
		num(p.flicker, 1) *
		(0.6 * smoothNoise(ctx.seed, 51, (ctx.frame / fps) * 10) + 0.4 * (2 * hash01(ctx.seed, ctx.frame) - 1));
	const defocus = num(p.defocus, 0.5) * (0.5 + 0.5 * smoothNoise(ctx.seed, 61, (ctx.frame / fps) * 10));
	return { shake: now, shakeVel: [now[0] - prev[0], now[1] - prev[1]] as [number, number], flicker, defocus };
}

export const S_FILM_ROLL = defineShaderTransition({
	id: 'jasper.s.film-roll',
	label: 'S_FilmRoll',
	bin: BIN,
	subBin: OTHER,
	description:
		'The film slips in the projector gate: the outgoing clip rolls off vertically and the incoming one rolls on, with a glowing frame line between them, shake, flicker, defocus, scratches, dust, hairs and stains.',
	keywords: ['film', 'roll', 'gate', 'frame line', 'projector', 'vintage', 'damage'],
	params: [
		...slowParams(0.5),
		sNum('rollSpeed', 'Roll Speed', 1, { softMin: -4, softMax: 4 }),
		sNum('motionBlur', 'Motion Blur', 0.5, { min: 0, softMax: 4 }),
		sNum('borderHeight', 'Border Height', 0.1, { min: 0, softMax: 0.5, step: 0.001 }),
		sNum('glowBrightness', 'Glow Brightness', 0.5, { min: 0, softMax: 4 }),
		sNum('glowWidth', 'Glow Width', 0.224, { min: 0, softMax: 1, step: 0.001 }),
		sNum('damageAmount', 'Damage Amount', 2, { min: 0, softMax: 5 }),
		sNum('stainDensity', 'Stain Density', 2, { min: 0, softMax: 8 }, 'Damage'),
		sNum('stainOpacity', 'Stain Opacity', 0.5, { min: 0, max: 1 }, 'Damage'),
		sNum('dustDensity', 'Dust Density', 60, { min: 0, softMax: 600, step: 1 }, 'Damage'),
		sNum('dustOpacity', 'Dust Opacity', 0.8, { min: 0, max: 1 }, 'Damage'),
		sNum('hairs', 'Hairs', 2, { min: 0, max: 6 }, 'Damage'),
		sNum('hairOpacity', 'Hair Opacity', 1, { min: 0, max: 1 }, 'Damage'),
		sNum('scratches', 'Scratches', 5, { min: 0, softMax: 10 }, 'Damage'),
		sNum('scratchOpacity', 'Scratch Opacity', 1, { min: 0, max: 1 }, 'Damage'),
		sNum('shakeAmplitude', 'Shake Amplitude', 0.2, { min: 0, softMax: 2 }, 'Shake'),
		sNum('shakeFrequency', 'Shake Frequency', 1, { min: 0, softMax: 5 }, 'Shake'),
		sNum('shakeJumpiness', 'Shake Jumpiness', 1, { min: 0, softMax: 4 }, 'Shake'),
		sNum('shakeRandom', 'Shake Random', 0.1, { min: 0, softMax: 2 }, 'Shake'),
		sNum('vignetteDarkness', 'Vignette Darkness', 0.5, { min: 0, max: 1 }, 'Vignette'),
		sNum('flicker', 'Flicker', 1, { min: 0, softMax: 4 }, 'Flicker'),
		sNum('defocus', 'Defocus', 0.5, { min: 0, softMax: 4 }, 'Defocus'),
		sapphireSeed(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const r = rollFrames(p.rollSpeed);
			const s = filmRollSignals(p, ctx);
			const env = Math.sin(Math.PI * Math.min(1, Math.max(0, ctx.progress)));
			const dust = dustCells(num(p.dustDensity, 60), ctx.width, ctx.height);
			return {
				...shutterUniforms(p, ctx),
				u_frN: r.frames,
				u_frDir: r.dir,
				u_frShake: s.shake,
				u_frShakeVel: s.shakeVel,
				u_frFlicker: s.flicker,
				u_frDefocus: s.defocus,
				u_frEnv: env * (num(p.damageAmount, 2) / 2),
				u_dustCellPx: dust.cell,
				u_dustProb: dust.prob * Math.min(1, env * (num(p.damageAmount, 2) / 2)),
			};
		},
		passes: [
			{
				output: 'dirt',
				include: [GLSL_DIRT],
				filter: 'nearest',
				frag: /* glsl */ `
void main() {
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  float hd = box.x / 1920.0;
  float env = min(u_frEnv, 2.0);
  float s = 0.0, hc = 0.0;
  vec2 st = vec2(0.0), du = vec2(0.0);
  if (env > 0.0) {
    s = sfd_scratches(p, box, u_scratches * 0.6 * env, 10.0, max(0.6, 0.15 * 6.0 * hd * 2.0), 1.0, 0.1, 3.0 * hd, 150.0, 0.28, 120.0, 0.0, 1.0, box.x * 0.004, 0.1, u_frame, fract(u_seed + 0.41));
    hc = sfd_hairs(p, box, min(6.0, u_hairs * env * 0.5), 3.0, 0.1, 1.0, 0.07 * box.x, max(0.8, 1.4 * hd), 1.0, u_frame, u_fps, fract(u_seed + 0.27));
    st = sfd_stains(p, box, min(4.0, u_stainDensity * env * 0.5), 0.05 * box.x, 0.5, floor(u_frame), fract(u_seed + 0.11));
    du = sfd_dust(p, u_dustCellPx, u_dustProb, 0.0025 * box.x, 0.5, fract(u_seed + floor(u_frame) * 0.6180339));
  }
  fragColor = vec4(s, hc, st.x, du.x);
}`,
			},
			{
				include: [GLSL_SW_SHUTTER, GLSL_FILM],
				frag: /* glsl */ `
// Strip position (screen heights) of frame row y at progress q: whole film frames of height 1 + border.
float fr_roll(float q) { return sw_slow(q, u_slowIn, u_slowOut) * u_frN * (1.0 + u_borderHeight); }
// The film at strip position Y (screen heights from the top of A's frame) and screen x: (colour, frame-line flag).
vec4 fr_film(float Y, float x, out float line) {
  float P = 1.0 + u_borderHeight;
  float k = floor(Y / P);
  float yc = Y - k * P;
  line = yc > 1.0 ? 1.0 : 0.0;
  if (yc > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  bool isA = u_frDir > 0.0 ? k < u_frN : k > -u_frN;
  vec2 uv = vec2(x, yc);
  return isA ? tr_from(uv) : tr_to(uv);
}
void main() {
  float p = tr_progress();
  float env = u_frEnv;
  float h = sw_shutter(p, u_motionBlur * 2.0);
  float r0 = fr_roll(p - h), r1 = fr_roll(p + h);
  vec2 sh = u_frShake * min(env, 2.0);
  vec2 shv = u_frShakeVel * min(env, 2.0) * u_motionBlur;
  float s0 = sh.y - 0.5 * shv.y, s1 = sh.y + 0.5 * shv.y;
  // Strip offset of screen row 0 at the shutter ends (roll along the direction + vertical shake).
  float y0 = u_frDir * r0 + s0, y1 = u_frDir * r1 + s1;
  float extent = abs(y1 - y0) * u_compSize.y;
  float defo = u_frDefocus * env * 0.0025 * u_compSize.y;
  float ext2 = max(extent, defo * 3.0);
  int n = sw_taps(ext2, 48);
  float j = ext2 / float(n) > 1.5 ? sw_jitter() : 0.5;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    if (i >= n) break;
    float t = (float(i) + j) / float(n);
    vec2 disc = defo > 0.0 ? sqrt(t) * defo * vec2(cos(float(i) * 2.39996), sin(float(i) * 2.39996)) / u_compSize : vec2(0.0);
    float ln;
    acc += fr_film(v_uv.y + disc.y + mix(y0, y1, t), v_uv.x - sh.x + disc.x, ln);
  }
  vec4 col = acc / float(n);
  vec3 c = col.a > 0.0 ? col.rgb / col.a : vec3(0.0);
  // Glow of the projector light around the frame line (distance to the nearest line, in frame heights).
  float P = 1.0 + u_borderHeight;
  float Yc = v_uv.y + 0.5 * (y0 + y1);
  float yc = Yc - floor(Yc / P) * P;
  float dl = yc > 1.0 ? 0.0 : min(yc, 1.0 - yc);
  float glow = u_glowBrightness * exp(-dl / max(u_glowWidth * 0.15, 1e-3)) * sw_bell(p);
  c += vec3(1.0, 0.82, 0.55) * glow;
  // Damage: flicker, vignette, dirt.
  c *= 1.0 + 0.2 * u_frFlicker * min(env, 2.0);
  c *= sfg_filmVignette(tr_px(), clamp(u_vignetteDarkness * min(env, 1.0), 0.0, 1.0), 1.0, 0.5, 0.75);
  vec4 d = texture(u_dirt, v_uv);
  c = mix(c, vec3(0.0), clamp(d.x * u_scratchOpacity, 0.0, 1.0));
  c = mix(c, vec3(0.0), clamp(d.y * u_hairOpacity, 0.0, 1.0));
  c = mix(c, c * vec3(0.55, 0.45, 0.3), clamp(d.z * u_stainOpacity, 0.0, 1.0));
  c = mix(c, vec3(0.0), clamp(d.w * u_dustOpacity, 0.0, 1.0));
  float a = max(col.a, clamp(glow, 0.0, 1.0));
  fragColor = vec4(max(c, 0.0) * a, a);
}`,
			},
		],
	},
});

export const FILM_TRANSITIONS: readonly TransitionSpec[] = [S_FILM_BURN_TRANSITION, S_FILM_ROLL];

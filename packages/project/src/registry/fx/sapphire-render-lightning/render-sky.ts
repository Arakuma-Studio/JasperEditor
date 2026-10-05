// Sapphire Render ▸ sky, light and particles: S_Luna (the moon with phase, craters, glow and halo), S_NightSky (a
// procedural star field on the celestial sphere, oriented from latitude/longitude/date/time), S_Caustics (refracted
// light patterns), S_Dust (specks drifting in a pseudo-3D box) and S_Sparkles / S_SparklesColor (twinkling glints).
// Approximations (no data sets shipped): the moon surface and the stars are procedural, not photographic/catalogue
// data; their geometry (phase lighting, sidereal rotation) follows the real formulas.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam, sapphireCommonParams } from '../params.ts';
import {
	blurXYPasses,
	type CombineOption,
	combineParam,
	combineUniforms,
	GLSL_SRT_ATMOS,
	GLSL_SRT_COMMON,
	GLSL_SRT_NOISE,
	glowPasses,
	int,
	n,
	num,
	outputOpacityParam,
	pictureCombine,
	rgb,
	unitPx,
} from './common.ts';

const D2R = Math.PI / 180;

/** Julian day (UT) of a civil date/time (Meeus, Gregorian calendar). */
export function julianDay(year: number, month: number, day: number, hourUT: number): number {
	let y = Math.round(year);
	let m = Math.round(month);
	if (m <= 2) {
		y -= 1;
		m += 12;
	}
	const a = Math.floor(y / 100);
	const b = 2 - a + Math.floor(a / 4);
	return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + Math.round(day) + b - 1524.5 + hourUT / 24;
}

const dateJD = (p: EffectParams, def: { year: number; month: number; day: number; hour: number }) =>
	julianDay(
		num(p.year, def.year),
		num(p.month, def.month),
		num(p.day, def.day),
		num(p.hour, def.hour) + num(p.minute) / 60 - num(p.gmtOffset, -5),
	);

// ---------------------------------------------------------------- S_Luna

/** Lunar phase in degrees (0 new, 90 first quarter, 180 full, 270 last quarter) at a Julian day (mean synodic month). */
export function lunarPhaseDeg(jd: number): number {
	const k = (jd - 2451550.1) / 29.530588853;
	return (k - Math.floor(k)) * 360;
}

const LUNA_COMBINE: CombineOption[] = [
	{ value: 'moonOnly', label: 'Moon Only', op: 'only' },
	{ value: 'overlay', label: 'Overlay', op: 'over' },
	{ value: 'add', label: 'Add', op: 'add' },
	{ value: 'screen', label: 'Screen', op: 'screen' },
	{ value: 'max', label: 'Max', op: 'max' },
	{ value: 'transparentShadow', label: 'Transparent Shadow', op: 'transparentShadow' },
];

export const S_LUNA = defineShaderEffect({
	id: 'jasper.s.luna',
	label: 'S_Luna',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		"Renders the Moon with an adjustable (or date-computed) phase, crater bumpiness, colour, glow and a rainbow halo in a hazy atmosphere. Mode ▸ LunaDate computes the phase from the date and time.",
	keywords: ['moon', 'luna', 'night', 'sky', 'phase', 'halo', 'full moon'],
	params: [
		fxParam.choice('mode', 'Mode', ['luna', 'lunaDate'], ['Luna', 'LunaDate'], 'luna'),
		fxParam.point('center', 'Center', [0.28, 0.349]),
		n('size', 'Size', 0.3, 0, undefined, { softMax: 2, step: 0.001 }),
		n('lunarPhase', 'Lunar Phase', 65, undefined, undefined, { softMin: 0, softMax: 360, step: 0.1, unit: 'deg' }),
		int('year', 'Year', 2020, 1900, 2295),
		int('month', 'Month', 3, 1, 12),
		int('day', 'Day', 16, 1, 31),
		int('hour', 'Hour', 16, 0, 23),
		n('minute', 'Minute', 0, undefined, undefined, { softMin: 0, softMax: 60, step: 0.01 }),
		n('gmtOffset', 'GMT Offset', -5, -12, 12, { step: 0.5 }),
		fxParam.angle('rotation', 'Rotation', 30),
		n('bumpiness', 'Bumpiness', 0.3, 0, 1, { step: 0.01 }),
		n('contrast', 'Contrast', 1, 0, 1, { step: 0.01 }),
		n('brightness', 'Brightness', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		rgb('color', 'Color', [1, 1, 1]),
		rgb('earthGlow', 'Earth Glow', [0, 0, 0]),
		n('gamma', 'Gamma', 1.6, 0.1, undefined, { softMax: 4, step: 0.01 }),
		rgb('skyColor', 'Sky Color', [0, 0, 0]),
		n('glowBrightness', 'Glow Brightness', 0.5, 0, undefined, { softMax: 4, step: 0.01 }),
		n('threshold', 'Threshold', 0.01, 0, undefined, { softMax: 1, step: 0.001 }),
		n('glowSize', 'Glow Size', 0.75, 0, undefined, { softMax: 4, step: 0.01 }),
		n('haloBrightness', 'Halo Brightness', 0, 0, undefined, { softMax: 2, step: 0.01 }),
		n('haloRelSize', 'Halo Rel Size', 1.5, 0, undefined, { softMax: 6, step: 0.01 }),
		n('colorFringing', 'Color Fringing', 0.05, 0, 1, { step: 0.001 }),
		n('innerSoftness', 'Inner Softness', 0.15, 0, undefined, { softMax: 2, step: 0.01 }),
		n('outerSoftness', 'Outer Softness', 0.3, 0, undefined, { softMax: 2, step: 0.01 }),
		n('haloSaturation', 'Halo Saturation', 0.5, 0, undefined, { softMax: 2, step: 0.01 }),
		rgb('haloTint', 'Halo Tint', [1, 1, 1]),
		n('atmosphereAmp', 'Atmosphere Amp', 0.3, 0, undefined, { softMax: 2, step: 0.01 }),
		n('atmosphereFreq', 'Atmosphere Freq', 2, 0.1, undefined, { softMax: 20, step: 0.01 }),
		n('atmosphereTurbulence', 'Atmosphere Turbulence', 0.6, 0, 1, { step: 0.01 }),
		n('atmosphereSpeed', 'Atmosphere Speed', 1, undefined, undefined, { softMin: -5, softMax: 5, step: 0.01 }),
		combineParam(LUNA_COMBINE, 'overlay'),
		n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		n('affectAlpha', 'Affect Alpha', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p) => ({
			...combineUniforms(p, LUNA_COMBINE, 'overlay'),
			u_phase:
				p.mode === 'lunaDate'
					? lunarPhaseDeg(dateJD(p, { year: 2020, month: 3, day: 16, hour: 16 }))
					: num(p.lunarPhase, 65),
		}),
		padding: (p, ctx) => {
			const r = num(p.size, 0.3) * 0.25 * ctx.width;
			return Math.min(1024, r * Math.max(num(p.glowSize, 0.75) * 1.5, num(p.haloRelSize, 1.5) + num(p.outerSoftness, 0.3) * 3));
		},
		passes: (p, ctx) => [
			{
				output: 'moon',
				format: 'rgba16f',
				include: [GLSL_SRT_COMMON, GLSL_SRT_NOISE, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float U = srt_unit();
  float R = max(u_size * U * 0.5, 1.0);
  vec2 q = srt_rot(srt_here() - srt_pt(u_center), -radians(u_rotation)) / R;
  q.y = -q.y;
  float r = length(q);
  float cov = clamp((1.0 - r) * R + 0.5, 0.0, 1.0);
  if (cov <= 0.0) { fragColor = vec4(0.0); return; }
  vec3 nrm = vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));
  uint s = srt_seed(0.4217);
  // maria (dark plains) and highlands
  float mar = srt_fbm3(nrm * 1.7 + vec3(3.1, 1.7, 0.4), 4, 0.5, s);
  float albedo = 0.66 - 0.3 * smoothstep(-0.05, 0.3, mar);
  // craters: bowls with rims at two scales (analytic height gradient)
  vec3 grad = vec3(0.0);
  float rimLight = 0.0;
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 6.0 : 17.0;
    vec3 g = nrm * sc;
    ivec3 base = ivec3(floor(g - 0.5));
    for (int c = 0; c < 8; c++) {
      ivec3 cell = base + ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
      vec3 h = srt_h33(cell, s + uint(k) * 0x2545f491u);
      vec3 pt = vec3(cell) + h;
      float rad = 0.18 + 0.3 * fract(h.x * 7.13 + h.z * 3.7);
      vec3 dv = g - pt;
      float d = length(dv);
      if (d < rad * 1.4) {
        float x = d / rad;
        float w = (k == 0 ? 1.0 : 0.6);
        grad += (x < 1.0 ? 2.0 * dv / (rad * rad) : -dv / max(d, 1.0e-4) * exp(-pow((x - 1.0) * 5.0, 2.0)) * 10.0 * (x - 1.0) / rad) * w;
        rimLight += exp(-pow((x - 1.0) * 6.0, 2.0)) * 0.08 * w;
      }
    }
  }
  vec3 gt = grad - dot(grad, nrm) * nrm;
  vec3 nb = normalize(nrm - u_bumpiness * 0.5 * gt);
  float ph = radians(u_phase);
  vec3 L = vec3(sin(ph), 0.0, -cos(ph));
  float mu0 = max(dot(nb, L), 0.0);
  float mu = max(nrm.z, 1.0e-3);
  float I = 2.0 * mu0 / (mu0 + mu);
  float terminator = smoothstep(-0.02, 0.06, dot(nrm, L));
  albedo = mix(0.55, albedo + rimLight, u_contrast);
  vec3 c = vec3(albedo * I * terminator) + u_earthGlow.rgb * albedo * mu * 0.6;
  c = pow(max(c, vec3(0.0)), vec3(1.0 / max(u_gamma, 0.1)));
  c *= u_brightness * u_color.rgb;
  c += u_skyColor.rgb * (1.0 - clamp(c, 0.0, 1.0)) * 0.6;
  fragColor = vec4(c * cov, cov);
}`,
			},
			...glowPasses({
				input: 'moon',
				out: 'glow',
				sigma: Math.max(1, num(p.glowSize, 0.75) * num(p.size, 0.3) * unitPx(ctx) * 0.5),
				rel: [1, 1, 1],
				wide: 3,
				threshold: num(p.threshold, 0.01),
				maxLevels: 4,
			}),
			{
				include: [GLSL_SRT_COMMON, GLSL_SRT_ATMOS, GLSL_COMPOSITE],
				frag: /* glsl */ `
float lu_ring(float d, float rh, float inner, float outer) {
  float x = d < rh ? (rh - d) / max(inner, 1.0e-3) : (d - rh) / max(outer, 1.0e-3);
  return exp(-x * x);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 moon = texture(u_moon, v_uv);
  float U = srt_unit();
  float R = max(u_size * U * 0.5, 1.0);
  float d = distance(srt_here(), srt_pt(u_center)) / R;
  vec3 glow = (texture(u_glowA, v_uv).rgb * 0.6 + texture(u_glowB, v_uv).rgb * 0.4) * u_glowBrightness * 2.0;
  vec3 halo = vec3(0.0);
  if (u_haloBrightness > 0.0) {
    float rh = u_haloRelSize;
    float f = u_colorFringing * rh;
    vec3 ring = vec3(lu_ring(d, rh - f, u_innerSoftness * rh, u_outerSoftness * rh),
                     lu_ring(d, rh, u_innerSoftness * rh, u_outerSoftness * rh),
                     lu_ring(d, rh + f, u_innerSoftness * rh, u_outerSoftness * rh));
    float l = dot(ring, vec3(0.2126, 0.7152, 0.0722));
    halo = max(mix(vec3(l), ring, u_haloSaturation * 2.0), 0.0) * u_haloTint.rgb * u_haloBrightness;
  }
  float atm = srt_atmosphere(srt_sapphire(srt_here()), u_atmosphereAmp, u_atmosphereFreq, u_atmosphereTurbulence,
    u_atmosphereSpeed, fract(u_seed + 0.29));
  vec3 light = (glow + halo) * atm;
  vec4 bg = vec4(src.rgb * u_bgBrightness, src.a);
  vec4 res;
  if (u_combineOp == SRT_OVER) {
    vec4 o = moon + bg * (1.0 - moon.a);
    res = srt_light(SRT_SCREEN, o, light, 1.0, u_affectAlpha);
  } else if (u_combineOp == SRT_TRANSPARENT_SHADOW) {
    vec3 mc = moon.a > 0.0 ? moon.rgb / moon.a : vec3(0.0);
    float a2 = moon.a * clamp(srt_max3(mc) * 2.5, 0.0, 1.0);
    vec4 o = vec4(moon.rgb * (a2 > 0.0 ? 1.0 : 0.0), a2) + bg * (1.0 - a2);
    res = srt_light(SRT_SCREEN, o, light, 1.0, u_affectAlpha);
  } else {
    res = srt_light(u_combineOp, src, moon.rgb + light, u_bgBrightness, u_affectAlpha);
    if (u_combineOp != SRT_ONLY) res.a = max(res.a, moon.a);
    else res = vec4(moon.rgb + light * (1.0 - moon.a), max(moon.a, res.a));
    res.rgb = min(res.rgb, vec3(res.a));
  }
  fragColor = fx_finish(res, src, clamp(moon.a + srt_max3(light), 0.0, 1.0), u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_NightSky

/** Column-major mat3: camera (x right, y up, z forward, in tan units) → equatorial (J2000-ish) directions. */
export function nightSkyMatrix(p: EffectParams): number[] {
	const jd = dateJD(p, { year: 2020, month: 12, day: 1, hour: 16 });
	const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0);
	const lst = (gmst + num(p.longitude, -71.1)) * D2R;
	const lat = num(p.latitude, 42.3) * D2R;
	const alt = num(p.altitude, 30) * D2R;
	const az = num(p.azimuth, -12) * D2R;
	// equatorial → hour frame (x: meridian, y: east, z: pole) → horizon (N, E, Up)
	const c = Math.cos(lst);
	const s = Math.sin(lst);
	const Rz = [
		[c, s, 0],
		[-s, c, 0],
		[0, 0, 1],
	];
	const Q = [-Math.sin(lat), 0, Math.cos(lat)];
	const E = [0, 1, 0];
	const P = [Math.cos(lat), 0, Math.sin(lat)];
	const Mh = [0, 1, 2].map((r) => [Q[r]!, E[r]!, P[r]!]);
	const T = [0, 1, 2].map((r) => [0, 1, 2].map((k) => Mh[r]!.reduce((acc, v, j) => acc + v * Rz[j]![k]!, 0)));
	const F = [Math.cos(alt) * Math.cos(az), Math.cos(alt) * Math.sin(az), Math.sin(alt)];
	const Rt = [-Math.sin(az), Math.cos(az), 0];
	const Up = [F[1]! * Rt[2]! - F[2]! * Rt[1]!, F[2]! * Rt[0]! - F[0]! * Rt[2]!, F[0]! * Rt[1]! - F[1]! * Rt[0]!];
	const toEq = (v: number[]) => [0, 1, 2].map((k) => T[0]![k]! * v[0]! + T[1]![k]! * v[1]! + T[2]![k]! * v[2]!);
	return [...toEq(Rt), ...toEq(Up), ...toEq(F)];
}

export const S_NIGHT_SKY = defineShaderEffect({
	id: 'jasper.s.night-sky',
	label: 'S_NightSky',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'A starry night sky seen from a latitude/longitude at a date and time: stars by magnitude with colours, twinkle and flicker, glare and streaks on the brightest. Animate Minute for the sky rotation. (Procedural star field, not a catalogue.)',
	keywords: ['stars', 'night', 'sky', 'starfield', 'space', 'twinkle', 'astronomy'],
	params: [
		n('latitude', 'Latitude', 42.3, -90, 90, { step: 0.01, unit: 'deg' }),
		n('longitude', 'Longitude', -71.1, -180, 180, { step: 0.01, unit: 'deg' }),
		n('gmtOffset', 'GMT Offset', -5, -12, 12, { step: 0.5 }),
		n('starSize', 'Star Size', 0.05, 0, undefined, { softMax: 1, step: 0.001 }),
		n('starBrightness', 'Star Brightness', 1, 0, undefined, { softMax: 5, step: 0.01 }),
		n('altitude', 'Altitude', 30, undefined, undefined, { softMin: -90, softMax: 90, step: 0.1, unit: 'deg' }),
		n('azimuth', 'Azimuth', -12, undefined, undefined, { softMin: -180, softMax: 360, step: 0.1, unit: 'deg' }),
		n('fieldOfView', 'Field Of View', 90, 0.5, 179, { step: 0.1, unit: 'deg' }),
		int('year', 'Year', 2020, 1900, 2295),
		int('month', 'Month', 12, 1, 12),
		int('day', 'Day', 1, 1, 31),
		int('hour', 'Hour', 16, 0, 23),
		n('minute', 'Minute', 0, undefined, undefined, { softMin: 0, softMax: 60, step: 0.01 }),
		n('magnitudeLimit', 'Magnitude Limit', 6.5, -2, 10, { step: 0.01 }),
		n('varySizeByMag', 'Vary Size By Mag', 0.2, 0, 1, { step: 0.01 }),
		n('starSaturation', 'Star Saturation', 1, 0, undefined, { softMax: 3, step: 0.01 }),
		n('glare', 'Glare', 0, 0, undefined, { softMax: 2, step: 0.01 }),
		n('glareBrightness', 'Glare Brightness', 0.5, 0, undefined, { softMax: 3, step: 0.01 }),
		n('glareSize', 'Glare Size', 0.12, 0, undefined, { softMax: 1, step: 0.001 }),
		n('relHeight', 'Rel Height', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		rgb('glareColor', 'Glare Color', [1, 1, 1]),
		fxParam.angle('glareRotate', 'Glare Rotate', 0),
		n('raysLength', 'Rays Length', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		n('glareStarMag', 'Glare Star Mag', 1.8, -2, 10, { step: 0.01 }),
		n('streakLength', 'Streak Length', 0.02, 0, undefined, { softMax: 0.3, step: 0.001 }),
		n('streakBrightness', 'Streak Brightness', 0.1, 0, undefined, { softMax: 2, step: 0.01 }),
		n('streakNumber', 'Streak Number', 8, 0, 8, { step: 1 }),
		fxParam.angle('streakRotation', 'Streak Rotation', 0),
		n('streakSymmetry', 'Streak Symmetry', 0.8, 0, 1, { step: 0.01 }),
		n('streakStarMag', 'Streak Star Mag', 3, -2, 10, { step: 0.01 }),
		n('twinkleAmount', 'Twinkle Amount', 1, 0, 1, { step: 0.01 }),
		n('twinkleFrequency', 'Twinkle Frequency', 5, 0.01, undefined, { softMax: 30, step: 0.01 }),
		n('twinkleAlways', 'Twinkle Always', 0.3, 0, 1, { step: 0.01 }),
		n('flickerAmount', 'Flicker Amount', 0.3, 0, 1, { step: 0.01 }),
		n('flickerFrequency', 'Flicker Frequency', 30, 0.01, undefined, { softMax: 60, step: 0.01 }),
		n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		combineParam(pictureCombine('Stars'), 'screen'),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p) => ({
			...combineUniforms(p, pictureCombine('Stars'), 'screen'),
			u_skyRot: { mat3: nightSkyMatrix(p) },
		}),
		passes: [
			{
				include: [GLSL_SRT_COMMON, GLSL_SRT_NOISE, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float U = srt_unit();
  vec2 sap = srt_sapphire(srt_here());
  float tanH = tan(radians(clamp(u_fieldOfView, 0.5, 179.0)) * 0.5);
  vec3 dir = normalize(u_skyRot * vec3(sap * tanH, 1.0));
  float pxPerRad = U / tanH;
  float pxScale = U / 960.0;
  uint s = srt_seed(u_seed);
  vec3 acc = vec3(0.0);
  for (int b = 0; b < 8; b++) {
    float m0 = -1.5 + float(b);
    if (m0 > u_magnitudeLimit) break;
    float count = 4.0 * pow(3.0, float(b));
    float c = sqrt(18.85 / count);
    vec3 g = dir / c;
    ivec3 base = ivec3(floor(g - 0.5));
    uint sb = s + uint(b) * 0x51ed27u;
    for (int k = 0; k < 8; k++) {
      ivec3 cell = base + ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
      vec3 h = srt_h33(cell, sb);
      vec3 sp = (vec3(cell) + h) * c;
      float r = length(sp);
      if (abs(r - 1.0) > c * 0.5) continue;
      vec3 sd = sp / r;
      if (dot(sd, dir) < 0.5) continue;
      float h4 = fract(h.x * 13.17 + h.y * 7.31 + h.z * 3.77);
      float mag = m0 + h4;
      if (mag > u_magnitudeLimit) continue;
      float dpx = length(sd - dir) * pxPerRad;
      float flux = pow(10.0, -0.4 * (mag - 1.0));
      float sig = (0.55 + u_starSize * 6.0 * pow(flux, 0.5 * u_varySizeByMag)) * max(pxScale, 0.35);
      float tw = 1.0;
      float id = float(b * 977) + h.x * 1000.0;
      if (fract(h4 * 17.3) < u_twinkleAlways)
        tw -= u_twinkleAmount * 0.6 * (0.5 + 0.5 * srt_vnoise2(vec2(u_time * u_twinkleFrequency * 0.3, id), s));
      tw -= u_flickerAmount * 0.5 * (0.5 + 0.5 * srt_vnoise2(vec2(u_time * u_flickerFrequency, id + 0.5), s ^ 0x77u));
      float temp = fract(h.y * 5.71 + h.z * 2.3);
      vec3 col = mix(vec3(0.66, 0.78, 1.0), vec3(1.0, 0.8, 0.58), temp * temp);
      col = max(mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, u_starSaturation), 0.0);
      float I = pow(flux, 0.45) * u_starBrightness * max(tw, 0.0);
      acc += col * I * exp(-dpx * dpx / (2.0 * sig * sig));
      if (mag < u_glareStarMag && u_glare > 0.0) {
        vec2 sv = vec2(dot(sd - dir, normalize(u_skyRot[0])), dot(sd - dir, normalize(u_skyRot[1]))) * pxPerRad;
        vec2 e = srt_rot(sv, -radians(u_glareRotate)) / vec2(1.0, max(u_relHeight, 0.05));
        float gs = max(u_glareSize * U * 0.1, 0.5);
        float halo = exp(-length(e) / gs);
        float rays = exp(-abs(e.x) / (gs * 4.0 * u_raysLength)) * exp(-abs(e.y) / 0.8) + exp(-abs(e.y) / (gs * 4.0 * u_raysLength)) * exp(-abs(e.x) / 0.8);
        acc += u_glareColor.rgb * col * I * u_glare * u_glareBrightness * (halo + 0.5 * rays);
      }
      if (mag < u_streakStarMag && u_streakBrightness > 0.0 && u_streakNumber >= 1.0) {
        vec2 sv = vec2(dot(dir - sd, normalize(u_skyRot[0])), dot(dir - sd, normalize(u_skyRot[1]))) * pxPerRad;
        float len = max(u_streakLength * U, 1.0);
        if (length(sv) < len * 3.0) {
          float ang = atan(sv.y, sv.x) - radians(u_streakRotation);
          float nS = floor(u_streakNumber + 0.5);
          float sec = SRT_TAU / nS;
          float kk = floor(ang / sec + 0.5);
          float da = ang - kk * sec;
          float lk = len * mix(0.3 + 0.7 * srt_h3(ivec3(int(mod(kk, nS)), cell.x, cell.y + cell.z * 7), sb), 1.0, u_streakSymmetry);
          float along = length(sv);
          float across = along * abs(sin(da));
          acc += col * I * u_streakBrightness * 4.0 * exp(-along / lk) * exp(-across * across / 0.8);
        }
      }
    }
  }
  vec4 res = srt_light(u_combineOp, src, acc, u_bgBrightness, 1.0);
  fragColor = fx_finish(res, src, clamp(srt_max3(acc), 0.0, 1.0), u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_Caustics

const CAUSTIC_COMBINE = pictureCombine('Caustic');

export const S_CAUSTICS = defineShaderEffect({
	id: 'jasper.s.caustics',
	label: 'S_Caustics',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'Caustics: the bright, moving web of light rays refracted by a wavy surface (a pool bottom, underwater objects). Ray Focus sharpens the pattern; an optional Bumps clip supplies the height map.',
	keywords: ['caustics', 'water', 'pool', 'underwater', 'light', 'refraction', 'ripples'],
	expensive: true,
	params: [
		fxParam.media('bumps', 'Bumps', ['image', 'video']),
		n('rayFocus', 'Ray Focus', 15, 0, 50, { step: 0.01 }),
		int('rayDensity', 'Ray Density', 2, 1, 5),
		n('rayBlur', 'Ray Blur', 0.02, 0, 0.2, { step: 0.0001 }),
		n('frequency', 'Frequency', 3, 0.1, 20, { step: 0.01 }),
		n('complexity', 'Complexity', 2.5, 0, 5, { step: 0.01 }),
		fxParam.vec2('shift', 'Shift', [0, 0], { step: 0.001, softMin: -2, softMax: 2 }),
		n('speed', 'Speed', 1, 0, 10, { step: 0.01 }),
		n('blurBumpImage', 'Blur Bump Image', 0, 0, 1, { step: 0.001 }),
		n('brightness1', 'Brightness1', 0.5, 0, undefined, { softMax: 3, step: 0.01 }),
		rgb('color1', 'Color1', [1, 1, 1]),
		rgb('color0', 'Color0', [0, 0.05, 1]),
		n('offset0', 'Offset0', 0, undefined, undefined, { softMin: -1, softMax: 1, step: 0.01 }),
		n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		combineParam(CAUSTIC_COMBINE, 'screen', 'bgCombine', 'Bg Combine'),
		outputOpacityParam(),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p) => combineUniforms(p, CAUSTIC_COMBINE, 'screen', 'bgCombine'),
		passes: (p, ctx) => [
			{
				output: 'caus',
				scale: 0.5,
				format: 'rgba16f',
				include: [GLSL_SRT_COMMON, GLSL_SRT_NOISE],
				frag: /* glsl */ `
float ca_h(vec2 x, float t, int oct, float gain, uint s) {
  if (u_bumps_size.x > 0.0) {
    vec2 n = x / (u_frequency * 0.5) * srt_unit() / u_box.zw;
    float r = u_blurBumpImage * 0.25;
    vec3 w = vec3(0.2126, 0.7152, 0.0722);
    float hb = dot(texture(u_bumps, n).rgb, w) * 2.0;
    if (r > 0.0) {
      hb += dot(texture(u_bumps, n + vec2(r, 0.0)).rgb + texture(u_bumps, n - vec2(r, 0.0)).rgb
        + texture(u_bumps, n + vec2(0.0, r)).rgb + texture(u_bumps, n - vec2(0.0, r)).rgb, w) * 2.0;
      hb /= 5.0;
    }
    return hb * 0.35;
  }
  return srt_fbm3(vec3(x, t), oct, gain, s) * 0.5;
}
void main() {
  float U = srt_unit();
  vec2 base = (srt_here() - u_box.xy) / U - vec2(u_shift.x, -u_shift.y);
  float f = u_frequency * 0.5;
  vec2 x0 = base * f;
  float t = u_time * u_speed * 0.35;
  int oct = int(clamp(1.0 + ceil(u_complexity), 1.0, 5.0));
  float gain = clamp(0.25 + 0.1 * u_complexity, 0.2, 0.75);
  uint s = srt_seed(u_seed);
  int dens = int(clamp(u_rayDensity, 1.0, 5.0));
  float tx = f / U * 2.0;
  float e = 0.06 / pow(1.6, float(oct - 1));
  float k = u_rayFocus * 0.0045 / (1.0 + 0.6 * float(oct - 1));
  float I = 0.0;
  for (int j = 0; j < 5; j++) {
    if (j >= dens) break;
    for (int i = 0; i < 5; i++) {
      if (i >= dens) break;
      vec2 x = x0 + tx * ((vec2(float(i), float(j)) + 0.5) / float(dens) - 0.5);
      float hs[9];
      for (int q = 0; q < 9; q++) hs[q] = ca_h(x + vec2(float(q % 3 - 1), float(q / 3 - 1)) * e, t, oct, gain, s);
      float hxx = (hs[5] - 2.0 * hs[4] + hs[3]) / (e * e);
      float hyy = (hs[7] - 2.0 * hs[4] + hs[1]) / (e * e);
      float hxy = (hs[8] - hs[6] - hs[2] + hs[0]) / (4.0 * e * e);
      float det = (1.0 + k * hxx) * (1.0 + k * hyy) - k * k * hxy * hxy;
      I += 1.0 / max(abs(det), 0.06);
    }
  }
  I /= float(dens * dens);
  fragColor = vec4(vec3(I * 0.125), 1.0);
}`,
			},
			...blurXYPasses({
				input: 'caus',
				output: 'cb',
				sigmaX: num(p.rayBlur, 0.02) * unitPx(ctx) * 0.5 + 0.75,
				sigmaY: num(p.rayBlur, 0.02) * unitPx(ctx) * 0.5 + 0.75,
				scale: 0.5,
			}),
			{
				include: [GLSL_SRT_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float I = texture(u_cb, v_uv).r * 8.0;
  vec3 pic = max(u_color0.rgb + u_offset0 + u_color1.rgb * u_brightness1 * I * 0.5, vec3(0.0));
  vec4 res = srt_picture(u_bgCombineOp, src, pic, 1.0, u_bgBrightness, u_outputOpacity == 0);
  fragColor = fx_finish(res, src, clamp(I * 0.25, 0.0, 1.0), u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_Dust

const DUST_COMBINE = pictureCombine('Dust');

export const S_DUST = defineShaderEffect({
	id: 'jasper.s.dust',
	label: 'S_Dust',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'Random specks of dust drifting through a pseudo-3D box in front of the camera: parallax, turbulence, flicker, depth of field and colour variation.',
	keywords: ['dust', 'particles', 'specks', 'motes', 'floating', 'atmosphere', 'snow'],
	expensive: true,
	params: [
		int('numberOfPoints', 'Number Of Points', 200, 1, undefined, 2000),
		n('size', 'Size', 3.12, 0, undefined, { softMax: 20, step: 0.01 }),
		n('brightness', 'Brightness', 0.75, 0, undefined, { softMax: 4, step: 0.01 }),
		rgb('color', 'Color', [0.5, 0.5, 0.5]),
		n('varyHue', 'Vary Hue', 0, 0, 1, { step: 0.01 }),
		n('varySaturation', 'Vary Saturation', 0, 0, 1, { step: 0.01 }),
		n('varyBrightness', 'Vary Brightness', 0.5, 0, 1, { step: 0.01 }),
		n('softness', 'Softness', 0.1, 0, undefined, { softMax: 1, step: 0.01 }),
		n('nearPlane', 'Near Plane', 30, 0, undefined, { softMax: 500, step: 0.1 }),
		n('boxDepth', 'Box Depth', 500, 0, undefined, { softMax: 2000, step: 1 }),
		n('fieldOfView', 'Field Of View', 90, 0, 179, { step: 0.1, unit: 'deg' }),
		n('nearPlaneFade', 'Near Plane Fade', 20, 0, 100, { step: 0.1 }),
		n('scaleDrift', 'Scale Drift', 2, 0, undefined, { softMax: 10, step: 0.01 }),
		n('driftSpeed', 'Drift Speed', 30, 0, undefined, { softMax: 200, step: 0.1 }),
		n('varyDriftSpeed', 'Vary Drift Speed', 10, 0, undefined, { softMax: 100, step: 0.1 }),
		n('driftAngle', 'Drift Angle', 0, 0, 360, { step: 0.1, unit: 'deg' }),
		n('varyDriftAngle', 'Vary Drift Angle', 20, 0, 360, { step: 0.1, unit: 'deg' }),
		n('driftZ', 'Drift Z', 0, undefined, undefined, { softMin: -200, softMax: 200, step: 0.1 }),
		n('varyDriftZ', 'Vary Drift Z', 0, undefined, undefined, { softMin: 0, softMax: 100, step: 0.1 }),
		n('scaleTurbulence', 'Scale Turbulence', 10, 0, undefined, { softMax: 50, step: 0.01 }),
		n('turbulenceSpeed', 'Turbulence Speed', 0.2, undefined, undefined, { softMin: -2, softMax: 2, step: 0.001 }),
		n('turbulenceX', 'Turbulence X', 25, 0, undefined, { softMax: 100, step: 0.1 }),
		n('varyTurbulenceX', 'Vary Turbulence X', 15, 0, undefined, { softMax: 100, step: 0.1 }),
		n('turbulenceY', 'Turbulence Y', 25, 0, undefined, { softMax: 100, step: 0.1 }),
		n('varyTurbulenceY', 'Vary Turbulence Y', 15, 0, undefined, { softMax: 100, step: 0.1 }),
		n('turbulenceZ', 'Turbulence Z', 0, 0, undefined, { softMax: 100, step: 0.1 }),
		n('varyTurbulenceZ', 'Vary Turbulence Z', 5, 0, undefined, { softMax: 100, step: 0.1 }),
		int('turbOctaves', 'Turb Octaves', 2, 1, 10),
		n('flickerAmp', 'Flicker Amp', 0, 0, undefined, { softMax: 2, step: 0.01 }),
		n('flickerSpeed', 'Flicker Speed', 40, 0, undefined, { softMax: 200, step: 0.1 }),
		n('flickerRandomness', 'Flicker Randomness', 0.5, 0, 1, { step: 0.01 }),
		int('flickerOctaves', 'Flicker Octaves', 2, 1, 10),
		n('coveragePercent', 'Coverage Percent', 30, 0, 100, { step: 0.1, unit: '%' }),
		n('depthBlurAmount', 'Depth Blur Amount', 0, 0, undefined, { softMax: 5, step: 0.01 }),
		n('focusDepth', 'Focus Depth', 50, 0, 100, { step: 0.1 }),
		n('depthOfField', 'Depth Of Field', 10, 0, 100, { step: 0.1 }),
		combineParam(DUST_COMBINE, 'screen'),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p) => combineUniforms(p, DUST_COMBINE, 'screen'),
		passes: [
			{
				include: [GLSL_SRT_COMMON, GLSL_SRT_NOISE, GLSL_COLOR, GLSL_COMPOSITE],
				frag: /* glsl */ `
// Smooth 1D noise in time (≈ −1..1) with a few octaves (turbulence, flicker).
float du_n1(float t, float id, int oct, uint s) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int k = 0; k < 4; k++) {
    if (k >= oct) break;
    sum += amp * srt_vnoise2(vec2(t, id), s + uint(k) * 0x27d4eb2du);
    norm += amp;
    amp *= 0.5;
    t *= 2.0;
  }
  return sum / norm;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 p = srt_here();
  float U = srt_unit();
  vec2 c0 = u_box.xy + 0.5 * u_box.zw;
  float tanH = tan(radians(clamp(u_fieldOfView, 1.0, 179.0)) * 0.5);
  float f = U / tanH;
  float aspect = u_box.w / u_box.z;
  float N = max(u_numberOfPoints, 1.0);
  float depth = max(u_boxDepth, 1.0);
  float nearP = max(u_nearPlane, 0.5);
  uint s = srt_seed(u_seed);
  int toct = int(clamp(u_turbOctaves, 1.0, 4.0));
  int foct = int(clamp(u_flickerOctaves, 1.0, 4.0));
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 12; k++) {
    vec3 hk = srt_h33(ivec3(k, 7, 3), s);
    float spd = max(0.0, u_driftSpeed + u_varyDriftSpeed * (hk.x * 2.0 - 1.0)) * u_scaleDrift;
    float ang = radians(u_driftAngle + u_varyDriftAngle * (hk.y * 2.0 - 1.0));
    vec2 vel = vec2(cos(ang), -sin(ang)) * spd;
    float vz = (u_driftZ + u_varyDriftZ * (hk.z * 2.0 - 1.0)) * u_scaleDrift;
    float z = nearP + mod((float(k) + 0.5) / 12.0 * depth - vz * u_time, depth);
    vec2 w = (p - c0) / f * z;
    float cell = sqrt(4.0 * z * z * tanH * tanH * aspect / (N / 12.0));
    vec2 gw = (w - vel * u_time) / cell;
    ivec2 base = ivec2(floor(gw - 0.5));
    for (int c = 0; c < 4; c++) {
      ivec2 ci = base + ivec2(c & 1, c >> 1);
      vec3 h = srt_h33(ivec3(ci, k), s);
      float id = h.x * 911.0 + float(k) * 13.0;
      vec2 pos = (vec2(ci) + h.xy) * cell + vel * u_time;
      vec2 amp = vec2(u_turbulenceX + u_varyTurbulenceX * (h.z * 2.0 - 1.0), u_turbulenceY + u_varyTurbulenceY * (fract(h.z * 7.7) * 2.0 - 1.0))
        * u_scaleTurbulence * 0.004 * z / 100.0;
      float tt = u_time * u_turbulenceSpeed * 2.0;
      pos += vec2(du_n1(tt, id, toct, s), du_n1(tt, id + 37.0, toct, s)) * min(amp, vec2(cell * 0.45));
      float zz = z + (fract(h.y * 5.3) - 0.5) * depth / 12.0
        + du_n1(tt, id + 71.0, toct, s) * (u_turbulenceZ + u_varyTurbulenceZ * (fract(h.x * 3.1) * 2.0 - 1.0)) * u_scaleTurbulence * 0.05;
      zz = max(zz, 0.1);
      vec2 sp = c0 + pos / zz * f;
      float r = u_size * max(U / 960.0, 0.15) * 1.5 * (100.0 / zz);
      float focus = nearP + depth * u_focusDepth / 100.0;
      float dof = depth * u_depthOfField / 100.0;
      float blur = u_depthBlurAmount * max(0.0, abs(zz - focus) - dof) / depth * 30.0 * max(U / 960.0, 0.15);
      float rr = r + blur;
      float d = distance(p, sp);
      if (d > rr + 2.0) continue;
      float edge = max(rr * u_softness, 0.0) + 0.6;
      float a = (1.0 - smoothstep(rr - edge, rr + 0.6, d)) * min(1.0, (r * r + 0.5) / (rr * rr + 0.5));
      float fade = smoothstep(nearP, nearP + max(u_nearPlaneFade, 0.01), zz) * smoothstep(nearP + depth, nearP + depth * 0.85, zz);
      float br = u_brightness * (1.0 - u_varyBrightness * fract(h.y * 11.3));
      if (u_flickerAmp > 0.0 && fract(h.x * 23.1) * 100.0 < u_coveragePercent) {
        float fl = du_n1(u_time * u_flickerSpeed * 0.1 * mix(1.0, 0.3 + 1.4 * h.z, u_flickerRandomness), id + 101.0, foct, s);
        br *= max(0.0, 1.0 - u_flickerAmp * (0.5 + 0.5 * fl));
      }
      vec3 col = u_color.rgb;
      if (u_varyHue > 0.0 || u_varySaturation > 0.0) {
        vec3 hsv = fx_rgb2hsv(col);
        hsv.x = fract(hsv.x + (fract(h.z * 3.7) - 0.5) * u_varyHue);
        hsv.y = clamp(hsv.y + (fract(h.x * 9.1) - 0.5) * 2.0 * u_varySaturation, 0.0, 1.0);
        col = fx_hsv2rgb(hsv);
      }
      acc += col * br * a * fade * 2.0;
    }
  }
  vec4 res = srt_light(u_combineOp, src, acc, 1.0, 1.0);
  fragColor = fx_finish(res, src, clamp(srt_max3(acc), 0.0, 1.0), u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_Sparkles / S_SparklesColor

const sparkleParams = (color: boolean) => [
	n('frequency', 'Frequency', 25, 0.01, undefined, { softMax: 100, step: 0.01 }),
	n('density', 'Density', 0.65, 0, 1, { step: 0.01 }),
	n('brightness', 'Brightness', 1, 0, undefined, { softMax: 5, step: 0.01 }),
	rgb('color', 'Color', [1, 1, 1]),
	...(color ? [n('colorVariation', 'Color Variation', 1, 0, undefined, { softMax: 2, step: 0.01 })] : []),
	n('brightnessX', 'Brightness X', 1, 0, undefined, { softMax: 4, step: 0.01 }),
	n('brightnessY', 'Brightness Y', 1, 0, undefined, { softMax: 4, step: 0.01 }),
	n('brightnessDiag1', 'Brightness Diag1', 1, 0, undefined, { softMax: 4, step: 0.01 }),
	n('brightnessDiag2', 'Brightness Diag2', 1, 0, undefined, { softMax: 4, step: 0.01 }),
	n('size', 'Size', 1, 0, undefined, { softMax: 5, step: 0.01 }),
	n('sizeX', 'Size X', 1, 0, undefined, { softMax: 5, step: 0.01 }),
	n('sizeY', 'Size Y', 1, 0, undefined, { softMax: 5, step: 0.01 }),
	n('sizeDiag1', 'Size Diag1', 0.5, 0, undefined, { softMax: 5, step: 0.01 }),
	n('sizeDiag2', 'Size Diag2', 0.5, 0, undefined, { softMax: 5, step: 0.01 }),
	n('sizeRed', 'Size Red', 0.6, 0, undefined, { softMax: 3, step: 0.01 }),
	n('sizeGreen', 'Size Green', 0.8, 0, undefined, { softMax: 3, step: 0.01 }),
	n('sizeBlue', 'Size Blue', 1, 0, undefined, { softMax: 3, step: 0.01 }),
	fxParam.vec2('shiftStart', 'Shift Start', [0, 0], { step: 0.001, softMin: -2, softMax: 2 }),
	fxParam.vec2('shiftSpeed', 'Shift Speed', [0, 0], { step: 0.0001, softMin: -0.1, softMax: 0.1 }),
	fxParam.vec2('sparkleSpeed', 'Sparkle Speed', [0.1, 0], { step: 0.001, softMin: -1, softMax: 1 }),
	n('affectAlpha', 'Affect Alpha', 1, 0, undefined, { softMax: 2, step: 0.01 }),
	n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
	fxParam.toggle('smoothAnim', 'Smooth Anim', false),
	fxParam.toggle('swapDiagonals', 'Swap Diagonals', false),
	...sapphireCommonParams({ seed: true }),
];

function sparkles(id: string, label: string, color: boolean) {
	return defineShaderEffect({
		id,
		label,
		category: 'Generate',
		bin: SAPPHIRE_BINS.render,
		description: color
			? 'A field of twinkling star-shaped glints in varying colours; Frequency, Density and Size shape the pattern, Sparkle Speed makes them twinkle.'
			: 'A field of twinkling star-shaped glints (four-way rays with per-channel lengths); Frequency, Density and Size shape the pattern, Sparkle Speed makes them twinkle.',
		keywords: ['sparkles', 'glint', 'twinkle', 'glitter', 'stars', 'shine', 'magic'],
		params: sparkleParams(color),
		gpu: {
			kind: 'generator',
			passes: [
				{
					include: [GLSL_SRT_COMMON, GLSL_SRT_NOISE, GLSL_COLOR, GLSL_COMPOSITE],
					frag: /* glsl */ `
vec3 sp_ray(vec2 d, vec2 dir, float len, vec3 rgbLen, float thick) {
  float a = abs(dot(d, dir));
  float b = dot(d, vec2(-dir.y, dir.x));
  vec3 L = max(len * rgbLen, vec3(1.0e-3));
  return exp(-a / L) * exp(-(b * b) / (thick * thick));
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 p = srt_here();
  float U = srt_unit();
  float cell = 2.0 * U / max(u_frequency, 0.01);
  vec2 shift = (u_shiftStart + u_shiftSpeed * u_frame) * vec2(1.0, -1.0) * U;
  vec2 g = (p - u_box.xy - shift) / cell;
  uint s = srt_seed(u_seed);
  vec3 rgbLen = vec3(u_sizeRed, u_sizeGreen, u_sizeBlue);
  float base = u_size * cell * 0.22;
  float lx = base * u_sizeX, ly = base * u_sizeY;
  float d1 = base * (u_swapDiagonals ? u_sizeDiag2 : u_sizeDiag1);
  float d2 = base * (u_swapDiagonals ? u_sizeDiag1 : u_sizeDiag2);
  float b1 = u_swapDiagonals ? u_brightnessDiag2 : u_brightnessDiag1;
  float b2 = u_swapDiagonals ? u_brightnessDiag1 : u_brightnessDiag2;
  float reach = max(max(lx, ly), max(d1, d2)) * max(rgbLen.r, max(rgbLen.g, rgbLen.b)) * 4.0;
  int R = int(clamp(ceil(reach / cell), 1.0, 2.0));
  float thick = 0.7 * max(U / 960.0, 0.5) + base * 0.02;
  float sig = 0.9 * max(U / 960.0, 0.5) + base * 0.04;
  vec3 acc = vec3(0.0);
  ivec2 c0 = ivec2(floor(g));
  float epoch = u_frame * u_sparkleSpeed.y;
  for (int dy = -2; dy <= 2; dy++) {
    if (abs(dy) > R) continue;
    for (int dx = -2; dx <= 2; dx++) {
      if (abs(dx) > R) continue;
      ivec2 c = c0 + ivec2(dx, dy);
      vec3 h = srt_h33(ivec3(c, 0), s);
      float ep = floor(epoch + h.z);
      if (srt_h3(ivec3(c, int(ep) + 11), s) >= u_density) continue;
      float ph = fract(h.z * 7.77 + u_frame * u_sparkleSpeed.x * 0.5 + ep * 0.37);
      float tw = 0.5 - 0.5 * cos(SRT_TAU * ph);
      tw = u_smoothAnim ? tw * tw : pow(tw, 4.0);
      float br = tw * (0.35 + 0.65 * fract(h.x * 13.1 + h.y * 5.3));
      if (br < 0.004) continue;
      vec2 d = p - (u_box.xy + shift + (vec2(c) + h.xy) * cell);
      vec3 rays = sp_ray(d, vec2(1.0, 0.0), lx, rgbLen, thick) * u_brightnessX
        + sp_ray(d, vec2(0.0, 1.0), ly, rgbLen, thick) * u_brightnessY
        + sp_ray(d, vec2(0.70710678, 0.70710678), d1, rgbLen, thick) * b1
        + sp_ray(d, vec2(0.70710678, -0.70710678), d2, rgbLen, thick) * b2;
      vec3 col = u_color.rgb;
      ${
				color
					? `col *= fx_hsv2rgb(vec3(fract(h.x * 3.17 + h.y * 1.31), clamp(0.75 * u_colorVariation, 0.0, 1.0), 1.0));`
					: ''
			}
      acc += col * br * (rays * 0.8 + exp(-dot(d, d) / (2.0 * sig * sig)) * 1.5);
    }
  }
  vec3 light = acc * u_brightness;
  vec4 res = srt_light(SRT_ADD, src, light, u_bgBrightness, u_affectAlpha);
  fragColor = fx_finish(res, src, clamp(srt_max3(light), 0.0, 1.0), u_mixWithOriginal, u_show);
}`,
				},
			],
		},
	});
}

export const S_SPARKLES = sparkles('jasper.s.sparkles', 'S_Sparkles', false);
export const S_SPARKLES_COLOR = sparkles('jasper.s.sparkles-color', 'S_SparklesColor', true);

export const SAPPHIRE_RENDER_SKY_EFFECTS: readonly EffectSpec[] = [
	S_CAUSTICS,
	S_DUST,
	S_LUNA,
	S_NIGHT_SKY,
	S_SPARKLES,
	S_SPARKLES_COLOR,
];

// Premiere Pro "Color Correction" video effects (fx family premiere-adjust-color-keying): Change Color, Change to
// Color, Channel Mixer, Color Balance, Color Balance (HLS), Equalize (./analysis.ts), Leave Color, Tint, Video
// Limiter. (Brightness & Contrast, Hue/Saturation, Black & White and Lumetri Color already exist.) All work on straight
// colour; alpha is kept.
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { fxParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import { EQUALIZE } from './analysis.ts';
import { GLSL_PACG, num, popup, slider } from './common.ts';

/** Colour matching helpers (Change Color, Leave Color, Color Pass, Color Replace). */
export const GLSL_PACG_MATCH: GlslChunk = {
	name: 'pacg/match',
	deps: [GLSL_PACG],
	source: /* glsl */ `
// Distance 0..1 between two colours: 0 = RGB (Euclidean), 1 = hue (circular, weighted down for greys),
// 2 = chroma (YIQ chrominance, ignoring luminance).
float pacg_colorDistance(vec3 c, vec3 k, int mode) {
  if (mode == 1) {
    vec3 a = fx_rgb2hsl(c), b = fx_rgb2hsl(k);
    float dh = abs(a.x - b.x);
    dh = min(dh, 1.0 - dh) * 2.0;
    // greys (low chroma) have no defined hue: count them as far away
    float ca = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float cb = max(k.r, max(k.g, k.b)) - min(k.r, min(k.g, k.b));
    return mix(1.0, dh, clamp(min(ca, cb) * 8.0, 0.0, 1.0));
  }
  if (mode == 2) {
    vec2 a = pacg_rgb2yiq(c).yz, b = pacg_rgb2yiq(k).yz;
    return clamp(distance(a, b) / 1.1, 0.0, 1.0);
  }
  return distance(c, k) / 1.7320508;
}
// 1 inside the tolerance, falling to 0 over the softness (both 0..1).
float pacg_matchMask(float d, float tolerance, float softness) {
  if (softness <= 0.0) return d <= tolerance ? 1.0 : 0.0;
  return 1.0 - smoothstep(tolerance, tolerance + softness, d);
}
`,
};

// ---------------------------------------------------------------- Change Color

export const CHANGE_COLOR = defineShaderEffect({
	id: 'jasper.change-color',
	label: 'Change Color',
	category: 'Color Correction',
	description:
		'Adjusts hue, lightness and saturation of a range of colours (those matching Color To Change within a tolerance).',
	keywords: ['replace color', 'selective color', 'hue shift', 'recolor'],
	params: [
		popup('view', 'View', [
			['correctedLayer', 'Corrected Layer'],
			['colorCorrectionMask', 'Color Correction Mask'],
		]),
		fxParam.angle('hueTransform', 'Hue Transform', 0),
		slider('lightnessTransform', 'Lightness Transform', 0, -100, 100),
		slider('saturationTransform', 'Saturation Transform', 0, -100, 100),
		fxParam.color('colorToChange', 'Color To Change', [0.85, 0.15, 0.15, 1]),
		fxParam.percent('matchingTolerance', 'Matching Tolerance', 15),
		fxParam.percent('matchingSoftness', 'Matching Softness', 0),
		popup('matchColors', 'Match Colors', [
			['rgb', 'Using RGB'],
			['hue', 'Using Hue'],
			['chroma', 'Using Chroma'],
		]),
		fxParam.toggle('invertColorCorrectionMask', 'Invert Color Correction Mask', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG_MATCH],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  float m = pacg_matchMask(pacg_colorDistance(c, u_colorToChange.rgb, u_matchColors),
                           u_matchingTolerance / 100.0, u_matchingSoftness / 100.0);
  if (u_invertColorCorrectionMask) m = 1.0 - m;
  if (u_view == 1) { fragColor = vec4(vec3(m) * src.a, src.a); return; }
  vec3 hsl = fx_rgb2hsl(c);
  hsl.x = fract(hsl.x + u_hueTransform / 360.0);
  hsl.z = clamp(hsl.z + u_lightnessTransform / 100.0 * (u_lightnessTransform > 0.0 ? 1.0 - hsl.z : hsl.z), 0.0, 1.0);
  hsl.y = clamp(hsl.y + u_saturationTransform / 100.0 * (u_saturationTransform > 0.0 ? 1.0 - hsl.y : hsl.y), 0.0, 1.0);
  vec3 r = mix(c, fx_hsl2rgb(hsl), m);
  fragColor = fx_premultiply(vec4(r, src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Change to Color

export const CHANGE_TO_COLOR = defineShaderEffect({
	id: 'jasper.change-to-color',
	label: 'Change to Color',
	category: 'Color Correction',
	description:
		'Changes a selected colour (From) to another colour (To) using hue, lightness and saturation, with HLS tolerances.',
	keywords: ['replace color', 'recolor', 'swap color', 'selective color'],
	params: [
		fxParam.color('from', 'From', [0.85, 0.15, 0.15, 1]),
		fxParam.color('to', 'To', [0.15, 0.35, 0.9, 1]),
		popup('change', 'Change', [
			['hue', 'Hue'],
			['hueLightness', 'Hue & Lightness'],
			['hueSaturation', 'Hue & Saturation'],
			['hueLightnessSaturation', 'Hue, Lightness & Saturation'],
		]),
		popup('changeBy', 'Change By', [
			['settingToColor', 'Setting To Color'],
			['transformingToColor', 'Transforming To Color'],
		]),
		fxParam.percent('toleranceHue', 'Hue', 5, { group: 'Tolerance' }),
		fxParam.percent('toleranceLightness', 'Lightness', 50, { group: 'Tolerance' }),
		fxParam.percent('toleranceSaturation', 'Saturation', 50, { group: 'Tolerance' }),
		fxParam.percent('softness', 'Softness', 50),
		fxParam.toggle('viewCorrectionMatte', 'View Correction Matte', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  vec3 p = fx_rgb2hsl(c);
  vec3 f = fx_rgb2hsl(u_from.rgb);
  vec3 t = fx_rgb2hsl(u_to.rgb);
  float dh = abs(p.x - f.x);
  dh = min(dh, 1.0 - dh) * 2.0;
  vec3 d = vec3(dh, abs(p.z - f.z), abs(p.y - f.y));
  vec3 tol = vec3(u_toleranceHue, u_toleranceLightness, u_toleranceSaturation) / 100.0;
  float soft = u_softness / 100.0;
  // Outside each tolerance the match falls off over a softness proportional to it.
  vec3 k = 1.0 - smoothstep(tol, tol + max(tol * soft * 2.0, vec3(soft * 0.05)) + 1.0e-4, d);
  float m = k.x * k.y * k.z;
  if (p.y < 0.02) m *= p.y / 0.02;
  if (u_viewCorrectionMatte) { fragColor = vec4(vec3(m) * src.a, src.a); return; }
  vec3 q = p;
  bool doL = u_change == 1 || u_change == 3;
  bool doS = u_change == 2 || u_change == 3;
  if (u_changeBy == 0) {
    q.x = t.x;
    if (doL) q.z = t.z;
    if (doS) q.y = t.y;
  } else {
    q.x = fract(p.x + t.x - f.x + 1.0);
    if (doL) q.z = clamp(p.z + t.z - f.z, 0.0, 1.0);
    if (doS) q.y = clamp(p.y + t.y - f.y, 0.0, 1.0);
  }
  fragColor = fx_premultiply(vec4(mix(c, fx_hsl2rgb(q), m), src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Channel Mixer

const MIX_ROWS = ['Red', 'Green', 'Blue'] as const;
const MIX_COLS = ['Red', 'Green', 'Blue', 'Const'] as const;

function channelMixerParams(): ParamSpec[] {
	const out: ParamSpec[] = [];
	for (const r of MIX_ROWS)
		for (const c of MIX_COLS)
			out.push(slider(`${r.toLowerCase()}${c}`, `${r}-${c}`, r === c ? 100 : 0, -200, 200, { step: 1 }));
	out.push(fxParam.toggle('monochrome', 'Monochrome', false));
	return out;
}

/** The mixer as a column-major mat3 (inputs → outputs, /100) and the constant column. */
export function channelMixerUniforms(p: EffectParams) {
	const v = (r: string, c: string) => num(p[`${r.toLowerCase()}${c}`], r === c ? 100 : 0) / 100;
	const mono = p.monochrome === true;
	const row = (r: (typeof MIX_ROWS)[number]) => (mono ? 'Red' : r);
	// out_r = M[0][0] in_r + M[1][0] in_g + M[2][0] in_b (GLSL m[col][row]).
	const mat: number[] = [];
	for (const inp of ['Red', 'Green', 'Blue']) for (const out of MIX_ROWS) mat.push(v(row(out), inp));
	return {
		u_mix: { mat3: mat },
		u_mixConst: MIX_ROWS.map((r) => v(row(r), 'Const')) as [number, number, number],
	};
}

export const CHANNEL_MIXER = defineShaderEffect({
	id: 'jasper.channel-mixer',
	label: 'Channel Mixer',
	category: 'Color Correction',
	description:
		'Builds each output channel from a mix of the red, green and blue input channels plus a constant (or monochrome).',
	keywords: ['mixer', 'swap channels', 'monochrome', 'black and white', 'color grading'],
	params: channelMixerParams(),
	gpu: {
		timeInvariant: true,
		uniforms: (p) => channelMixerUniforms(p),
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  fragColor = fx_premultiply(vec4(clamp(u_mix * c + u_mixConst, 0.0, 1.0), src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Color Balance

const TONES = ['shadow', 'midtone', 'highlight'] as const;
const TONE_LABELS = { shadow: 'Shadow', midtone: 'Midtone', highlight: 'Highlight' } as const;

export const COLOR_BALANCE = defineShaderEffect({
	id: 'jasper.color-balance',
	label: 'Color Balance',
	category: 'Color Correction',
	description: 'Shifts the red, green and blue balance separately in the shadows, midtones and highlights.',
	keywords: ['color grading', 'tint', 'shadows', 'midtones', 'highlights', 'cast'],
	params: [
		...TONES.flatMap((t) =>
			(['Red', 'Green', 'Blue'] as const).map((c) =>
				slider(`${t}${c}Balance`, `${TONE_LABELS[t]} ${c} Balance`, 0, -100, 100),
			),
		),
		fxParam.toggle('preserveLuminosity', 'Preserve Luminosity', false),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => {
			const v = (t: string): [number, number, number] =>
				(['Red', 'Green', 'Blue'] as const).map((c) => num(p[`${t}${c}Balance`]) / 100) as [
					number,
					number,
					number,
				];
			return { u_cbShadow: v('shadow'), u_cbMid: v('midtone'), u_cbHigh: v('highlight') };
		},
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  float l = fx_luma(c);
  // Tonal weights (sum ≤ 1): shadows below ~⅓, highlights above ~⅔, midtones in between.
  float ws = 1.0 - smoothstep(0.0, 0.5, l);
  float wh = smoothstep(0.5, 1.0, l);
  float wm = 1.0 - ws - wh;
  vec3 shift = (u_cbShadow * ws + u_cbMid * wm + u_cbHigh * wh) * 0.5;
  // Push channels towards 1 for positive values and towards 0 for negative ones.
  vec3 r = c + shift * mix(c, 1.0 - c, step(0.0, shift));
  r = clamp(r, 0.0, 1.0);
  if (u_preserveLuminosity) {
    float l2 = fx_luma(r);
    r = l2 > 1.0e-4 ? clamp(r * (l / l2), 0.0, 1.0) : vec3(l);
  }
  fragColor = fx_premultiply(vec4(r, src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Color Balance (HLS)

export const COLOR_BALANCE_HLS = defineShaderEffect({
	id: 'jasper.color-balance-hls',
	label: 'Color Balance (HLS)',
	category: 'Color Correction',
	description: 'Adjusts hue (rotation), lightness and saturation of the whole picture.',
	keywords: ['hls', 'hue', 'lightness', 'saturation', 'color balance'],
	params: [
		fxParam.angle('hue', 'Hue', 0),
		slider('lightness', 'Lightness', 0, -100, 100),
		slider('saturation', 'Saturation', 0, -100, 100),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 hsl = fx_rgb2hsl(pacg_straight(src));
  hsl.x = fract(hsl.x + u_hue / 360.0);
  float L = u_lightness / 100.0, S = u_saturation / 100.0;
  hsl.z = clamp(L >= 0.0 ? hsl.z + (1.0 - hsl.z) * L : hsl.z * (1.0 + L), 0.0, 1.0);
  hsl.y = clamp(S >= 0.0 ? hsl.y + (1.0 - hsl.y) * S : hsl.y * (1.0 + S), 0.0, 1.0);
  fragColor = fx_premultiply(vec4(fx_hsl2rgb(hsl), src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Leave Color

export const LEAVE_COLOR = defineShaderEffect({
	id: 'jasper.leave-color',
	label: 'Leave Color',
	category: 'Color Correction',
	description:
		'Removes colour from everything except the colours close to Color To Leave (selective desaturation).',
	keywords: ['color pass', 'selective color', 'desaturate', 'sin city', 'isolate color'],
	params: [
		fxParam.percent('amountToDecolor', 'Amount to Decolor', 0),
		fxParam.color('colorToLeave', 'Color To Leave', [0.85, 0.15, 0.15, 1]),
		fxParam.percent('tolerance', 'Tolerance', 15),
		fxParam.percent('edgeSoftness', 'Edge Softness', 0),
		popup('matchColors', 'Match Colors', [
			['rgb', 'Using RGB'],
			['hue', 'Using Hue'],
		]),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG_MATCH],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  float keep = pacg_matchMask(pacg_colorDistance(c, u_colorToLeave.rgb, u_matchColors),
                              u_tolerance / 100.0, u_edgeSoftness / 100.0);
  float d = u_amountToDecolor / 100.0 * (1.0 - keep);
  fragColor = fx_premultiply(vec4(mix(c, vec3(fx_luma(c)), d), src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Tint

export const TINT = defineShaderEffect({
	id: 'jasper.tint',
	label: 'Tint',
	category: 'Color Correction',
	description:
		'Maps the dark pixels to one colour and the bright pixels to another (a two-colour gradient map).',
	keywords: ['duotone', 'gradient map', 'colorize', 'monochrome', 'sepia'],
	params: [
		fxParam.color('mapBlackTo', 'Map Black To', [0, 0, 0, 1]),
		fxParam.color('mapWhiteTo', 'Map White To', [1, 1, 1, 1]),
		fxParam.percent('amountToTint', 'Amount to Tint', 100),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  vec3 r = fx_tint(c, u_mapBlackTo.rgb, u_mapWhiteTo.rgb, u_amountToTint / 100.0);
  fragColor = fx_premultiply(vec4(clamp(r, 0.0, 1.0), src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Video Limiter

/** Video Limiter's Compression Before Clip options (fraction of the range below the clip level). */
export const VIDEO_LIMITER_COMPRESSION = { none: 0, '3': 0.03, '5': 0.05, '10': 0.1, '20': 0.2 } as const;

export const VIDEO_LIMITER = defineShaderEffect({
	id: 'jasper.video-limiter',
	label: 'Video Limiter',
	category: 'Color Correction',
	description:
		'Keeps luminance and colour within broadcast-safe limits (clip level in IRE, soft compression before the clip, gamut warning).',
	keywords: ['broadcast safe', 'legalize', 'clip', 'ire', 'gamut', 'limiter'],
	params: [
		slider('clipLevel', 'Clip Level', 100, 90, 109, { step: 0.1 }),
		popup(
			'compressionBeforeClip',
			'Compression Before Clip',
			[
				['none', 'None'],
				['3', '3%'],
				['5', '5%'],
				['10', '10%'],
				['20', '20%'],
			],
			'5',
		),
		fxParam.toggle('gamutWarning', 'Gamut Warning', false),
		fxParam.color('gamutWarningColor', 'Gamut Warning Color', [1, 0, 0, 1]),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => ({
			u_vlKnee:
				VIDEO_LIMITER_COMPRESSION[
					String(p.compressionBeforeClip ?? '5') as keyof typeof VIDEO_LIMITER_COMPRESSION
				] ?? 0.05,
		}),
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
// Soft knee: identity below clip·(1 − knee), then compresses smoothly to reach exactly clip.
float limit(float v, float clip, float knee) {
  float k0 = clip * (1.0 - knee);
  if (v <= k0 || knee <= 0.0) return min(v, clip);
  float over = v - k0;
  float room = clip - k0;
  return k0 + room * (1.0 - exp(-over / room));
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  // 100 IRE = full white (1.0); 109 IRE allows super-whites (≥ 1 here: nothing to clip in 0..1 RGB).
  float clip = u_clipLevel / 100.0;
  vec3 r = vec3(limit(c.r, clip, u_vlKnee), limit(c.g, clip, u_vlKnee), limit(c.b, clip, u_vlKnee));
  float y = fx_luma(r);
  float yl = limit(y, clip, u_vlKnee);
  if (y > 1.0e-4) r *= yl / y;
  bool out_ = any(greaterThan(c, vec3(clip + 0.5 / 255.0)));
  if (u_gamutWarning && out_) r = u_gamutWarningColor.rgb;
  fragColor = fx_premultiply(vec4(clamp(r, 0.0, 1.0), src.a));
}`,
			},
		],
	},
});

export const COLOR_CORRECTION_EFFECTS: readonly EffectSpec[] = [
	CHANGE_COLOR,
	CHANGE_TO_COLOR,
	CHANNEL_MIXER,
	COLOR_BALANCE,
	COLOR_BALANCE_HLS,
	EQUALIZE,
	LEAVE_COLOR,
	TINT,
	VIDEO_LIMITER,
];

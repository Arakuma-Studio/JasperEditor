// Sapphire damage looks — analog video: S_TVDamage (bad reception: static, interference, ghosts, horizontal and
// vertical hold, hum bars, colour stripes, fast-forward bands, dropouts, scan lines, orthicon halos, colour
// correction, fish eye, TV turn-off) and S_VHSDamage (tape: downsampling, interlace combing, VHS colour looks,
// chroma downsampling / shift / bleed, luma softening and sharpening, tape wiggle, fast-forward tears, scan lines,
// rolling dropout "streaks" and "sparkles"). Parameter names, order and defaults follow Boris FX's public Sapphire
// reference; the Mask block is replaced by "Mix with Orig" (S_VHSDamage keeps its own "Mix With Source").
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_LUT } from '../glsl/lut.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam, lutParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxUniformValue, ShaderPass } from '../shader.ts';
import {
	check,
	color,
	grp,
	intSlider,
	mixParam,
	num,
	sapphireSeed,
	slider,
	smoothNoise1,
	stepNoise1,
} from './common.ts';
import { GLSL_FILM } from './glsl.ts';

const STYLIZE = SAPPHIRE_BINS.stylize;

/** Vertical-hold state per frame: whether the picture rolls and its roll offset (frame heights). */
export function tvRoll(p: EffectParams, ctx: { frame: number; fps: number; seed: number }) {
	const t = ctx.frame / Math.max(1, ctx.fps);
	const R = Math.max(0, num(p.receptionMaster, 0.4));
	const vFreq = Math.max(0.01, num(p.vFrequency, 2));
	const slot = t * vFreq * 0.25;
	const rolling = stepNoise1(ctx.seed, 60, slot) < Math.min(1, num(p.verticalHold, 0.8) * R);
	const speed = num(p.vSpeed, 2) * (0.5 + stepNoise1(ctx.seed, 61, slot));
	const roll = rolling
		? (t - Math.floor(slot) / (vFreq * 0.25)) * speed * 0.5 +
			num(p.vRandom, 0.1) * smoothNoise1(ctx.seed, 62, t * 3)
		: 0;
	return { rolling, roll };
}

const TV_FRAG = (orthicon: boolean) => /* glsl */ `
float stv_fbm1(float x, float t, int oct, uint s) {
  float sum = 0.0, a = 0.5, f = 1.0;
  for (int k = 0; k < 10; k++) {
    if (k >= oct) break;
    sum += a * sfd_noise2(vec2(x * f, t), s ^ sfd_uu(k * 977));
    f *= 2.0; a *= 0.5;
  }
  return sum;
}
vec3 stv_sample(vec2 n) {
  if (n.x < 0.0 || n.x > 1.0) return vec3(0.0);
  return fx_unpremultiply(texture(u_source, fx_uvOfLayerNorm(clamp(n, vec2(0.0), vec2(1.0))))).rgb;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 box = sfg_boxPx();
  vec2 n = fx_layerNorm();
  float R = max(u_receptionMaster, 0.0);
  float t = u_time;
  float fr = floor(u_frame);
  uint s = sfg_seedU(u_seed);
  float tvx = max(u_tvPixels, 1.0);
  float lines = max(1.0, tvx * box.y / box.x);
  // turn off: the picture collapses vertically, then to a dot
  float to = clamp(u_turnOff, 0.0, 1.0);
  float sy = mix(1.0, 0.004, smoothstep(0.0, 0.55, to));
  float sx = mix(1.0, 0.004, smoothstep(0.5, 1.0, to));
  vec2 q = (n - 0.5) / vec2(sx, sy) + 0.5;
  bool off = to > 0.0 && (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0);
  // fish eye (CRT bulge)
  if (u_fishEye != 0.0) {
    vec2 d = (q - 0.5) * vec2(box.x / box.y, 1.0);
    q = 0.5 + (q - 0.5) * (1.0 + u_fishEye * 0.25 * dot(d, d));
  }
  // vertical hold: rolling picture with the black border (and its VBI data) between frames
  float bh = max(u_borderHeight, 0.0) * 0.5;
  float y = mod(q.y + u_rollY, 1.0 + bh);
  bool vBorder = u_rolling > 0.5 && y > 1.0;
  float line = floor(y * lines);
  // horizontal hold + line jitter
  float hh = u_horizontalHold * R * 0.12 * stv_fbm1(y * u_hFrequency * 3.0, t * u_hTimeVary * 2.0, int(u_hOctaves + 0.5), s);
  float jit = u_jitterAmount * 0.00025 * R * (sfd_u8(sfd_h(ivec3(int(line), int(fr), 3), s)).x - 0.5);
  float x = q.x + hh + jit;
  // fast forward: torn bands shifted sideways
  float ff = 0.0;
  if (u_fastForwardAmount > 0.0) {
    float ph = fract(y * u_ffBandFrequency * 0.5 - t * 0.7);
    ff = step(ph, u_ffBandHeight) * u_fastForwardAmount;
    x += ff * u_ffBandShift * (0.5 + sfd_noise1(y * 40.0 + t * 9.0, s));
  }
  if (u_downsample) x = (floor(x * tvx) + 0.5) / tvx;
  // horizontal blanking: a black strip shows at the side when the lines slip
  bool blank = q.x < u_borderWidth * 0.5 * clamp(abs(hh) * 20.0, 0.0, 1.0);
  vec3 c = vBorder || blank ? vec3(0.0) : stv_sample(vec2(x, y));
  // ghosts (multipath echoes, some inverted)
  if (!vBorder && u_numGhosts > 0.5 && u_ghostAmp > 0.0) {
    vec3 acc = vec3(0.0);
    for (int k = 1; k <= 30; k++) {
      if (float(k) > u_numGhosts + 0.5) break;
      vec4 r = sfd_u8(sfd_h(ivec3(k, 0, 9), s));
      float go = float(k) * u_spacing * 0.06 * (1.0 + u_varyPosition * (r.x - 0.5) * 2.0) * sign(u_shift + 1.0e-4) * (0.5 + abs(u_shift));
      vec3 g = stv_sample(vec2(x - go, y));
      if (r.y < u_negativeGhosts) g = 1.0 - g;
      acc += (g - c) * (0.45 / float(k));
    }
    c += acc * u_ghostAmp * R;
  }
  // static (snow) at TV pixel resolution
  vec2 cell = vec2(floor(x * tvx), line);
  vec4 st = sfd_u8(sfd_h(ivec3(ivec2(cell), int(fr)), s ^ 0x1234567u));
  float staticMask = step(st.x, u_staticDensity);
  c = mix(c, vec3(st.y), clamp(u_staticAmplitude * R * 0.55 * staticMask, 0.0, 1.0));
  // interference: herring-bone moiré and travelling dots
  if (u_interferenceAmp > 0.0) {
    float hb = sin(6.2831853 * (x * tvx * u_interferenceFrequency * 0.125 + line * u_interferenceFrequency * 0.37 + t * 7.0));
    vec2 dp = (n * box + u_dotsSpeed * vec2(1.0, -1.0) * t) / max(2.0, box.x / tvx * 2.0);
    float dots = step(0.985, sfd_u8(sfd_h(ivec3(ivec2(floor(dp)), 0), s ^ 0x55aa55u)).x);
    c += (hb * 0.12 + dots * 0.6) * u_interferenceAmp * R;
  }
  // hum bars rolling up the picture
  if (u_barsBrightness > 0.0) {
    float ph = n.y * u_barFrequency + t * u_barRollSpeed * 0.25;
    float d1 = abs(fract(ph) - 0.5) * 2.0;
    float bar1 = 1.0 - smoothstep(0.0, max(u_bar1Width, 1.0e-3), pow(d1, max(u_barSharpness, 0.1)));
    float bar2 = pow(0.5 + 0.5 * cos(6.2831853 * ph * u_bar2RelFrequency), 1.0 / max(u_bar2Sharpness, 0.01));
    c *= 1.0 + u_barsBrightness * R * (bar1 * 0.9 + bar2 * 0.3 - 0.45);
  }
  // colour stripes
  if (u_colorStripesAmplitude > 0.0) {
    vec2 dir = fx_dir(u_colorAngle);
    float hue = fract(dot(n * vec2(box.x / box.y, 1.0), dir) * u_colorFrequency * 0.25 + t * u_rollSpeed * 0.1);
    c += (fx_hsv2rgb(vec3(hue, 1.0, 1.0)) - 0.5) * u_colorStripesAmplitude * R * 0.5;
  }
  if (ff > 0.0) c = mix(c, vec3(sfd_u8(sfd_h(ivec3(ivec2(cell), int(fr)), s ^ 0x777u)).x), 0.35 * min(ff, 1.0));
  // tape dropouts: short white streaks on some lines
  if (u_tapeDropoutBrightness > 0.0 && sfd_u8(sfd_h(ivec3(int(fr), 0, 41), s)).x < u_dropoutsAlways) {
    float yl = floor(n.y * u_dropoutYFreq * 12.0);
    vec4 r = sfd_u8(sfd_h(ivec3(int(yl), int(fr), 42), s));
    if (r.x > u_dropoutYThreshold) {
      float seg = max(u_dropoutLength + u_dropoutGapLength, 0.01);
      float xx = fract((n.x + r.y) / seg) * seg;
      float on = step(xx, u_dropoutLength) * (1.0 - xx / max(u_dropoutLength, 1.0e-3));
      c = mix(c, vec3(1.0), clamp(on * u_tapeDropoutBrightness, 0.0, 1.0));
    }
  }
  // scan lines
  c *= 1.0 - clamp(u_scanlines, 0.0, 1.0) * (0.5 - 0.5 * cos(6.2831853 * y * lines * max(u_scanlinesRelFreq, 0.01)));
  ${
		orthicon
			? `// orthicon: dark halos around the highlights
  float halo = texture(u_halo, v_uv).a;
  float hl = smoothstep(u_threshold, u_threshold + 0.1, fx_luma(c));
  c *= 1.0 - clamp(u_orthicon * halo * (1.0 - hl) * 1.5, 0.0, 0.95);`
			: ''
	}
  // colour correction
  c = fx_hueShift(clamp(c, 0.0, 1.0), u_hueShift / 360.0);
  c = mix(vec3(fx_luma(c)), c, u_saturation);
  c = sfg_lights(c, u_scaleLights, u_offsetDarks);
  c = c * u_tintLights.rgb + u_tintDarks.rgb * (1.0 - clamp(c, 0.0, 1.0));
  c *= sfg_filmVignette(fx_layerPx(), u_vignetteDarkness, u_vignetteRadius, u_vignetteEdgeSoftness, u_vignetteRelHeight);
  // VBI data in the rolling border: dashes on a couple of lines
  if (vBorder && u_borderData > 0.0) {
    float bl = (y - 1.0) / max(bh, 1.0e-3);
    float dash = step(0.5, fract(x * 24.0 + floor(bl * 6.0) * 0.37)) * step(0.3, bl) * step(bl, 0.6);
    c += vec3(dash) * min(u_borderData, 1.0) * 0.8;
  }
  // turn off: brighten while collapsing, flare at the centre, then fade out
  if (to > 0.0) {
    c = off ? vec3(0.0) : c * (1.0 + to * 3.0);
    vec2 d = (n - 0.5) * vec2(box.x / box.y, 1.0);
    float flare = u_flareBrightness * exp(-dot(d, d) / pow(max(u_flareWidth, 0.01) * 0.04, 2.0)) * smoothstep(0.4, 0.9, to);
    float fade = 1.0 - smoothstep(max(u_fadeOutTime, 0.0), 1.0, to);
    c = (c + vec3(flare)) * fade;
  }
  fragColor = sfg_out(c, src, u_mixWithOriginal);
}`;

export const S_TV_DAMAGE = defineShaderEffect({
	id: 'jasper.s.tv-damage',
	label: 'S_TVDamage',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'A faulty TV: static, interference dots, ghosting, horizontal and vertical hold failure (rolling picture), hum bars, colour stripes, fast-forward bands, tape dropouts, scan lines, orthicon halos, colour correction, fish eye and the turn-off collapse to a dot.',
	keywords: ['tv damage', 'bad reception', 'static', 'snow', 'ghosting', 'vertical hold', 'crt', 'analog'],
	expensive: true,
	params: [
		...grp('Master', [
			slider('receptionMaster', 'Reception Master', 0.4, 0, 10, { softMax: 2 }),
			slider('interferenceAmp', 'Interference Amp', 0.6, 0, 10, { softMax: 2 }),
			slider('ghostAmp', 'Ghost Amp', 0.6, 0, 10, { softMax: 2 }),
			slider('horizontalHold', 'Horizontal Hold', 0.5, 0, 10, { softMax: 2 }),
			slider('verticalHold', 'Vertical Hold', 0.8, 0, 1),
			slider('barsBrightness', 'Bars Brightness', 0.3, 0, 10, { softMax: 2 }),
			slider('colorStripesAmplitude', 'Color Stripes Amplitude', 0.2, 0, 10, { softMax: 2 }),
			slider('fastForwardAmount', 'Fast Forward Amount', 0, 0, 10, { softMax: 2 }),
			slider('tapeDropoutBrightness', 'Tape Dropout Brightness', 0, 0, 10, { softMax: 2 }),
			slider('vignetteDarkness', 'Vignette Darkness', 0, 0, 1),
		]),
		...grp('Static and Interference', [
			slider('staticAmplitude', 'Static Amplitude', 0.8, 0, 10, { softMax: 2 }),
			slider('staticDensity', 'Static Density', 0.7, 0.01, 1),
			slider('interferenceFrequency', 'Interference Frequency', 1.28, 0, 500, { softMax: 10 }),
			fxParam.vec2('dotsSpeed', 'Dots Speed', [100, -10], { softMin: -500, softMax: 500, step: 1 }),
			slider('jitterAmount', 'Jitter Amount', 10, 0, 1000, { softMax: 100 }),
		]),
		...grp('Ghosts', [
			intSlider('numGhosts', 'Num Ghosts', 5, 0, 30),
			slider('negativeGhosts', 'Negative Ghosts', 0.5, 0, 1),
			slider('spacing', 'Spacing', 0.2, 0, 10, { softMax: 2 }),
			slider('varyPosition', 'Vary Position', 0.3, 0, 1),
			slider('shift', 'Shift', 0.5, -1, 1),
		]),
		...grp('Horizontal Hold', [
			slider('hFrequency', 'H Frequency', 1.25, 0, 100, { softMax: 10 }),
			slider('hTimeVary', 'H Time Vary', 0.5, 0, 100, { softMax: 5 }),
			intSlider('hOctaves', 'H Octaves', 3, 1, 10),
			slider('borderWidth', 'Border Width', 0.05, 0, 1),
		]),
		...grp('Vertical Hold', [
			slider('vFrequency', 'V Frequency', 2, 0, 100, { softMax: 10 }),
			slider('vSpeed', 'V Speed', 2, 0, 100, { softMax: 10 }),
			slider('vRandom', 'V Random', 0.1, 0, 10, { softMax: 1 }),
			slider('borderHeight', 'Border Height', 0.1, 0, 1),
			slider('borderData', 'Border Data', 1, 0, 10),
		]),
		...grp('Hum Bars', [
			slider('barRollSpeed', 'Bar Roll Speed', 0.5, -10, 10),
			slider('barSharpness', 'Bar Sharpness', 0.5, 0.1, 10),
			slider('barFrequency', 'Bar Frequency', 1, 0.1, 100, { softMax: 10 }),
			slider('bar1Width', 'Bar1 Width', 0.35, 0, 1),
			slider('bar2RelFrequency', 'Bar2 Rel Frequency', 6, 1, 100, { softMax: 20 }),
			slider('bar2Sharpness', 'Bar2 Sharpness', 0.5, 0.01, 10),
		]),
		...grp('Color Stripes', [
			slider('colorFrequency', 'Color Frequency', 10, 1, 40),
			fxParam.angle('colorAngle', 'Color Angle', 160),
			slider('rollSpeed', 'Roll Speed', 3, -100, 100, { softMin: -10, softMax: 10 }),
		]),
		...grp('Fast Forward', [
			slider('ffBandFrequency', 'FF Band Frequency', 4, 0, 100, { softMax: 20 }),
			slider('ffBandShift', 'FF Band Shift', 0.1, -2, 2),
			slider('ffBandHeight', 'FF Band Height', 0.16, 0, 1),
		]),
		...grp('Dropouts', [
			slider('dropoutLength', 'Dropout Length', 0.25, 0, 1),
			slider('dropoutGapLength', 'Dropout Gap Length', 0.2, 0, 2),
			slider('dropoutYFreq', 'Dropout Y Freq', 5, 0, 50),
			slider('dropoutYThreshold', 'Dropout Y Threshold', 0.75, 0, 1),
			slider('dropoutsAlways', 'Dropouts Always', 1, 0, 1),
		]),
		...grp('Vignette', [
			slider('vignetteRadius', 'Vignette Radius', 1, 0, 10, { softMax: 3 }),
			slider('vignetteEdgeSoftness', 'Vignette Edge Softness', 0.5, 0, 10, { softMax: 3 }),
			slider('vignetteRelHeight', 'Vignette Rel Height', 0.75, 0.1, 10, { softMax: 3 }),
		]),
		...grp('Scanlines', [
			slider('scanlines', 'Scanlines', 0.1, 0, 1),
			slider('scanlinesRelFreq', 'Scanlines Rel Freq', 1, 0.01, 10, { softMax: 4 }),
		]),
		...grp('Orthicon', [
			slider('orthicon', 'Orthicon', 0, 0, 10, { softMax: 2 }),
			slider('threshold', 'Threshold', 0.7, 0, 1),
			slider('darksWidth', 'Darks Width', 0.2, 0, 10, { softMax: 1 }),
		]),
		...grp('Color Correct Parameters', [
			fxParam.angle('hueShift', 'Hue Shift', 0),
			slider('saturation', 'Saturation', 1, undefined, undefined, { softMin: 0, softMax: 3 }),
			slider('scaleLights', 'Scale Lights', 1, 0, 10, { softMax: 3 }),
			slider('offsetDarks', 'Offset Darks', 0, undefined, undefined, { softMin: -8, softMax: 2 }),
			color('tintLights', 'Tint Lights', [1, 1, 1]),
			color('tintDarks', 'Tint Darks', [0, 0, 0]),
		]),
		...grp('Turn Off', [
			slider('turnOff', 'Turn Off', 0, 0, 1),
			slider('flareWidth', 'Flare Width', 1, 0, 10, { softMax: 3 }),
			slider('flareBrightness', 'Flare Brightness', 2, 0, 10, { softMax: 5 }),
			slider('fadeOutTime', 'Fade Out Time', 0.7, 0, 1),
		]),
		slider('fishEye', 'Fish Eye', 0, undefined, undefined, { softMin: -2, softMax: 2 }),
		slider('tvPixels', 'Tv Pixels', 720, 1, 8000, { softMax: 2000, step: 1 }),
		check('downsample', 'Downsample', true),
		sapphireSeed('Seed'),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx): Record<string, FxUniformValue> => {
			const r = tvRoll(p, ctx);
			return { u_rolling: r.rolling ? 1 : 0, u_rollY: r.roll };
		},
		passes: (p, ctx) => {
			const orth = num(p.orthicon) > 0;
			const final: ShaderPass = { include: [GLSL_FILM, GLSL_UV, GLSL_COLOR], frag: TV_FRAG(orth) };
			if (!orth) return [final];
			const sigma = Math.max(0.5, num(p.darksWidth, 0.2) * 0.05 * ctx.width * ctx.pxScale);
			return [
				{
					output: 'hlMask',
					scale: 0.5,
					include: [GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(texture(u_source, v_uv));
  float m = smoothstep(u_threshold, u_threshold + 0.1, fx_luma(c.rgb)) * c.a;
  fragColor = vec4(0.0, 0.0, 0.0, m);
}`,
				},
				...gaussianBlurPasses({ input: 'hlMask', output: 'halo', sigma, scale: 0.25 }),
				final,
			];
		},
	},
});

const VHS_LUTS = ['none', 'vhs1', 'vhs2', 'vhs3', 'vhs4'] as const;
const VHS_LUT_LABELS = ['None', 'VHS color 01', 'VHS color 02', 'VHS color 03', 'VHS color 04'];

/** Pass A: tape geometry (wiggle, fast-forward tears), horizontal downsampling, interlaced combing → RGB. */
const VHS_TAPE = /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 box = sfg_boxPx();
  vec2 n = fx_layerNorm();
  float t = u_time;
  uint s = sfg_seedU(u_seed);
  float lineH = 1.0 / max(box.y, 1.0);
  float line = floor(n.y * box.y);
  vec2 off = vec2(0.0);
  if (u_tapeNoise) {
    // coarse wiggle (slow, along the picture height, clumped by Dampen Coarseness) + fine per-line jitter
    float coarse = sfd_noise2(vec2(n.y * 6.0, t * 2.0), s) * 0.6 + sfd_noise2(vec2(n.y * 23.0, t * 5.0), s ^ 0x3c6ef372u) * 0.4;
    coarse *= u_coarseness * (1.0 - clamp(u_dampenCoarseness * 50.0, 0.0, 0.9) * (1.0 - abs(coarse)));
    float fine = (sfd_u8(sfd_h(ivec3(int(line), int(u_frame), 5), s)).x - 0.5) * u_fineNoise;
    off += vec2(u_displaceX, -u_displaceY) * (coarse * 0.06 + fine * 0.5);
  }
  if (u_fastForwardAmount > 0.0) {
    float ph = n.y * u_bandFrequency + t * 0.9 + u_bandFrequencyVary * 0.1 * sfd_noise1(t * 0.7, s);
    float band = step(fract(ph), u_bandHeight);
    float sh = u_bandShift * (1.0 + u_bandShiftVary * sfd_noise1(floor(ph) * 3.1 + t, s ^ 0x9u));
    off.x += band * sh * 0.25 * u_fastForwardAmount;
    off.y += band * 0.02 * u_fastForwardAmount * sfd_noise1(n.x * 30.0 + t * 20.0, s);
  }
  vec2 m = n + off;
  if (u_downsample) {
    float cw = 1.0 / max(u_downsampleResolution, 1.0);
    m.x = (floor(m.x / cw) + 0.5) * cw;
  }
  vec2 uv = fx_uvOfLayerNorm(clamp(m, vec2(0.0), vec2(1.0)));
  vec4 c = texture(u_source, uv);
  if (u_interlacedCombing && u_sampleCount > 0 && mod(line, 2.0) > 0.5) {
    vec4 nx = fx_sample(0, uv);
    if (nx.a > 0.0) c = nx;
  }
  fragColor = src.a > 0.0 ? c : vec4(0.0);
}`;

/** Pass B: horizontal luma blur/sharpen and chroma downsampling, shift and bleed → (Y, I, Q) encoded. */
const VHS_CHROMA = /* glsl */ `
vec3 svh_yiq(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
}
vec3 svh_at(vec2 n) { return fx_unpremultiply(texture(u_tape, fx_uvOfLayerNorm(n))).rgb; }
void main() {
  vec4 here = texture(u_tape, v_uv);
  vec2 box = sfg_boxPx();
  vec2 n = fx_layerNorm();
  // luma: horizontal blur (Blur Luma × Blur Rel X) and sharpening (edge enhancement with ringing)
  float bl = u_lumaAdjust ? u_blurLuma * u_blurRel.x : 0.0;
  float yb = 0.0, ys = 0.0, wb = 0.0;
  for (int i = -4; i <= 4; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 8.0);
    yb += svh_yiq(svh_at(n + vec2(fi * max(bl, 1.0 / box.x) * 0.15, 0.0))).x * w;
    wb += w;
  }
  yb /= wb;
  float ynear = svh_yiq(svh_at(n)).x;
  float ywide = (svh_yiq(svh_at(n + vec2(3.0 / box.x, 0.0))).x + svh_yiq(svh_at(n - vec2(3.0 / box.x, 0.0))).x) * 0.5;
  float y = bl > 0.0 ? yb : ynear;
  if (u_colorAberration) {
    y += u_sharpenAmount * 0.15 * (ynear - ywide);
    y = mix(y, ywide, clamp(u_softenAmount, 0.0, 1.0));
  }
  // chroma: sampled at a lower horizontal resolution, each channel shifted, then bled sideways
  float cw = u_colorDownsample ? max(u_downsampleScale, 1.0) * box.x / 1920.0 / box.x * 2.0 : 0.0;
  vec2 iq = vec2(0.0);
  float wsum = 0.0;
  vec2 shA = u_colorAberration ? u_shiftAmount * vec2(1.0, -box.x / box.y) * 0.5 : vec2(0.0);
  vec3 blurC = u_colorAberration ? u_blurAmount * vec3(u_blurRed, u_blurGreen, u_blurBlue) : vec3(0.0);
  for (int i = -6; i <= 6; i++) {
    float fi = float(i) / 6.0;
    float w = exp(-fi * fi * 2.0);
    float spread = max(cw, 0.0) + max(max(blurC.r, blurC.g), blurC.b) * 0.05;
    vec2 base = n + vec2(fi * spread, 0.0);
    vec3 c;
    if (u_colorAberration) {
      vec2 sr = shA + u_shiftRed * vec2(1.0, -box.x / box.y) * 0.5;
      vec2 sg = shA + u_shiftGreen * vec2(1.0, -box.x / box.y) * 0.5;
      vec2 sb = shA + u_shiftBlue * vec2(1.0, -box.x / box.y) * 0.5;
      c = vec3(svh_at(base - sr).r, svh_at(base - sg).g, svh_at(base - sb).b);
    } else c = svh_at(base);
    iq += svh_yiq(c).yz * w;
    wsum += w;
  }
  iq /= wsum;
  if (u_colorAberration) iq *= u_saturation;
  fragColor = vec4(y, iq * 0.5 + 0.5, here.a);
}`;

/** Pass C: vertical chroma resolution, back to RGB, colour style, bloom, luma adjust, scan lines, streaks. */
const VHS_FINAL = /* glsl */ `
vec3 svh_rgb(vec3 yiq) {
  return vec3(yiq.x + 0.956 * yiq.y + 0.621 * yiq.z, yiq.x - 0.272 * yiq.y - 0.647 * yiq.z, yiq.x - 1.106 * yiq.y + 1.703 * yiq.z);
}
// The four "VHS color" looks (lift, gamma, gain per channel + saturation).
vec3 svh_lut(int k, vec3 c) {
  vec3 lift = vec3(0.0), gam = vec3(1.0), gain = vec3(1.0); float sat = 1.0;
  if (k == 1) { lift = vec3(0.05, 0.06, 0.03); gam = vec3(0.95, 1.0, 1.08); gain = vec3(1.0, 0.97, 0.88); sat = 0.85; }
  else if (k == 2) { lift = vec3(0.04, 0.025, 0.05); gam = vec3(0.96, 1.02, 0.98); gain = vec3(1.0, 0.97, 0.98); sat = 1.05; }
  else if (k == 3) { lift = vec3(0.03, 0.05, 0.09); gam = vec3(1.05, 1.0, 0.92); gain = vec3(0.9, 0.97, 1.05); sat = 0.75; }
  else if (k == 4) { lift = vec3(0.02, 0.04, 0.0); gam = vec3(1.02, 0.94, 1.1); gain = vec3(1.04, 1.02, 0.85); sat = 1.1; }
  else return c;
  vec3 o = lift + (gain - lift) * pow(clamp(c, 0.0, 1.0), gam);
  return mix(vec3(fx_luma(o)), o, sat);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 box = sfg_boxPx();
  vec2 n = fx_layerNorm();
  float t = u_time;
  uint s = sfg_seedU(u_seed);
  vec4 e = texture(u_yiq, v_uv);
  float y = e.x;
  vec2 iq = e.yz - 0.5;
  // vertical chroma resolution (Rel Height) and the vertical part of the luma blur
  if (u_colorDownsample && u_relHeight > 0.0) {
    float dy = u_relHeight * 2.0 / box.y;
    iq = (iq * 2.0 + texture(u_yiq, fx_uvOfLayerNorm(n + vec2(0.0, dy))).yz - 0.5 + texture(u_yiq, fx_uvOfLayerNorm(n - vec2(0.0, dy))).yz - 0.5) * 0.25;
  }
  if (u_lumaAdjust && u_blurLuma * u_blurRel.y > 0.0) {
    float dy = u_blurLuma * u_blurRel.y;
    y = (y * 2.0 + texture(u_yiq, fx_uvOfLayerNorm(n + vec2(0.0, dy))).x + texture(u_yiq, fx_uvOfLayerNorm(n - vec2(0.0, dy))).x) * 0.25;
  }
  vec3 c = svh_rgb(vec3(y, iq));
  // colour style
  if (u_colorStyle) {
    // A .cube file replaces the slot's built-in VHS look.
    c = mix(c, u_lut1File_size.x > 0.0 ? fx_lut3d(u_lut1File, u_lut1File_size, c) : svh_lut(u_lut1, c), clamp(u_lut1Strength, 0.0, 1.0));
    c = mix(c, u_lut2File_size.x > 0.0 ? fx_lut3d(u_lut2File, u_lut2File_size, c) : svh_lut(u_lut2, c), clamp(u_lut2Strength, 0.0, 1.0));
    c += vec3(0.5, -1.0, 0.5) * u_tint * 0.08;
  }
  // colour bloom: saturated chroma bleeding (a 3-strip-like boost of the colour)
  if (u_colorBloom) {
    float l = fx_luma(c);
    vec3 v = clamp(c + (c - l) * 0.6, 0.0, 1.0);
    c = mix(c, mix(vec3(fx_luma(v)), v, u_bloomSaturation + 0.3), clamp(u_bloomVintageAmount, 0.0, 1.0));
  }
  if (u_lumaAdjust) {
    c = pow(max(c, vec3(0.0)), vec3(1.0 / max(u_boostMids, 0.1)));
    c = sfg_lights(c, u_scaleLights, u_offsetDarks);
  }
  // scan lines (scrolling), with optional noise
  if (u_scanlines) {
    float ph = n.y * u_linesFrequency + t * u_shiftSpeed + u_linesShift;
    vec3 l = 0.5 - 0.5 * cos(6.2831853 * (ph + vec3(u_linesShiftRed, u_linesShiftGreen, u_linesShiftBlue)));
    c *= 1.0 - u_linesIntensity * 4.0 * l;
    if (u_addNoise > 0.0) c += (sfd_noise2(n * box * max(u_noiseFreq, 1.0e-4) * 10.0 + t * 37.0, s) * 0.5) * u_addNoise;
  }
  // streaks and sparkles: rolling bands of dropouts with fading tails
  for (int k = 0; k < 2; k++) {
    bool on = k == 0 ? u_streaks : u_sparkles;
    if (!on) continue;
    float amount = k == 0 ? u_streaksAmount : u_sparklesAmount;
    float opac = k == 0 ? u_streaksOpacity : u_sparklesOpacity;
    float freq = k == 0 ? u_streaksFrequency : u_sparklesFrequency;
    float len = (k == 0 ? u_streaksLength : u_sparklesLength) * box.x / 1920.0;
    float blk = k == 0 ? u_blackStreaks : u_blackSparkles;
    float bf = k == 0 ? u_streaksBandFreq : u_sparklesBandFreq;
    float bfv = k == 0 ? u_streaksBandFreqVary : u_sparklesBandFreqVary;
    float bsz = k == 0 ? u_streaksBandSize : u_sparklesBandSize;
    float bsh = k == 0 ? u_streaksBandShift : u_sparklesBandShift;
    float bshv = k == 0 ? u_streaksBandShiftVary : u_sparklesBandShiftVary;
    float roll = k == 0 ? u_streaksBandRollSpeed : u_sparklesBandRollSpeed;
    uint sk = s ^ sfd_uu(k * 7717 + 3);
    float ph = n.y * (bf + bfv * 0.3 * sfd_noise1(t * 0.5, sk)) + t * roll + bsh + bshv * sfd_noise1(t * 0.9 + 3.0, sk);
    float band = 1.0 - smoothstep(bsz * 0.8, bsz, abs(fract(ph) - 0.5) * 2.0);
    if (band <= 0.0) continue;
    float lineY = floor(n.y * box.y / max(1.0, box.y / 480.0));
    float cell = max(len * 1.5, 2.0);
    float cx = floor(n.x * box.x / cell);
    vec4 r = sfd_u8(sfd_h(ivec3(int(cx), int(lineY), int(u_frame)), sk));
    float density = amount * freq / 960.0 * 0.02;
    if (r.x < density) {
      float tt = fract(n.x * box.x / cell) * cell / max(len, 1.0);
      float tail = tt < 1.0 ? pow(1.0 - tt, 2.0) : 0.0;
      float head = step(tt, 0.06);
      bool black = r.y < blk;
      vec3 col = u_streaksColor == 1 ? clamp(c * 2.2, 0.0, 1.0) : (black ? vec3(0.0) : vec3(1.0));
      vec3 headC = black ? vec3(1.0) : vec3(0.0);
      c = mix(c, col, clamp(tail * opac * band, 0.0, 1.0));
      c = mix(c, headC, clamp(head * opac * band * 0.8, 0.0, 1.0));
    }
  }
  fragColor = sfg_out(c, src, u_mixWithOriginal);
}`;

const bandParams = (k: 'streaks' | 'sparkles', d: number[]) => {
	const L = k === 'streaks' ? 'Streaks' : 'Sparkles';
	return grp(L, [
		check(k, L, true),
		slider(`${k}Amount`, `${L} Amount`, d[0]!, 0, 10),
		slider(`${k}Opacity`, `${L} Opacity`, d[1]!, 0, 10),
		slider(`${k}Frequency`, `${L} Frequency`, d[2]!, 0, 10000, { softMax: 3000, step: 1 }),
		slider(`${k}Length`, `${L} Length`, d[3]!, 0, 2000, { softMax: 200 }),
		slider(k === 'streaks' ? 'blackStreaks' : 'blackSparkles', `Black ${L}`, d[4]!, 0, 1),
		slider(`${k}BandFreq`, `${L} Band Freq`, d[5]!, 0, 100, { softMax: 10 }),
		slider(`${k}BandFreqVary`, `${L} Band Freq Vary`, d[6]!, undefined, undefined, {
			softMin: 0,
			softMax: 10,
		}),
		slider(`${k}BandSize`, `${L} Band Size`, d[7]!, 0, 1),
		slider(`${k}BandShift`, `${L} Band Shift`, d[8]!, undefined, undefined, { softMin: -2, softMax: 2 }),
		slider(`${k}BandShiftVary`, `${L} Band Shift Vary`, d[9]!, 0, 10, { softMax: 2 }),
		slider(`${k}BandRollSpeed`, `${L} Band Roll Speed`, d[10]!, -10, 10),
	]);
};

export const S_VHS_DAMAGE = defineShaderEffect({
	id: 'jasper.s.vhs-damage',
	label: 'S_VHSDamage',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Analog tape playback: downsampled, softened luma with edge ringing, low-resolution shifted and bleeding chroma, VHS colour looks, tape wiggle, fast-forward tears, scrolling scan lines and rolling bands of dropout streaks and sparkles.',
	keywords: ['vhs', 'tape', 'vcr', 'analog', 'chroma bleed', 'tracking', 'retro', '80s', '90s'],
	expensive: true,
	params: [
		...grp('Resolution', [
			check('downsample', 'Downsample', true),
			slider('downsampleResolution', 'Downsample Resolution', 720, 1, 8000, { softMax: 1920, step: 1 }),
			check('interlacedCombing', 'Interlaced Combing', false),
		]),
		...grp('Color Style', [
			check('colorStyle', 'Color Style', true),
			fxParam.choice('lut1', 'Lut1', VHS_LUTS, VHS_LUT_LABELS, 'vhs1'),
			lutParam('lut1File', 'Lut1 File (.cube)'),
			slider('lut1Strength', 'Lut1 Strength', 0.45, 0, 1),
			fxParam.choice('lut2', 'Lut2', VHS_LUTS, VHS_LUT_LABELS, 'vhs2'),
			lutParam('lut2File', 'Lut2 File (.cube)'),
			slider('lut2Strength', 'Lut2 Strength', 1, 0, 1),
			slider('tint', 'Tint', 0, -1, 1),
		]),
		...grp('Color Downsample', [
			check('colorDownsample', 'Color Downsample', true),
			slider('downsampleScale', 'Downsample Scale', 6.67, 0, 100, { softMax: 30 }),
			slider('relHeight', 'Rel Height', 0.6, 0, 100, { softMax: 4 }),
		]),
		...grp('Color Aberration', [
			check('colorAberration', 'Color Aberration', true),
			fxParam.vec2('shiftAmount', 'Shift Amount', [0.00469, 0], {
				softMin: -0.05,
				softMax: 0.05,
				step: 0.0001,
			}),
			fxParam.vec2('shiftRed', 'Shift Red', [-0.00208, 0], { softMin: -0.05, softMax: 0.05, step: 0.0001 }),
			fxParam.vec2('shiftGreen', 'Shift Green', [0, 0], { softMin: -0.05, softMax: 0.05, step: 0.0001 }),
			fxParam.vec2('shiftBlue', 'Shift Blue', [0, 0], { softMin: -0.05, softMax: 0.05, step: 0.0001 }),
			slider('blurAmount', 'Blur Amount', 0, 0, 10, { softMax: 1 }),
			slider('blurRed', 'Blur Red', 0.84, 0, 10, { softMax: 3 }),
			slider('blurGreen', 'Blur Green', 0.55, 0, 10, { softMax: 3 }),
			slider('blurBlue', 'Blur Blue', 1, 0, 10, { softMax: 3 }),
			slider('saturation', 'Saturation', 1, 0, 10, { softMax: 3 }),
			slider('sharpenAmount', 'Sharpen Amount', 2, -10, 20, { softMax: 6 }),
			slider('softenAmount', 'Soften Amount', 0, 0, 1),
		]),
		...grp('Color Bloom', [
			check('colorBloom', 'Color Bloom', true),
			slider('bloomVintageAmount', 'Bloom Vintage Amount', 0.5, 0, 1),
			slider('bloomSaturation', 'Bloom Saturation', 0.73, 0, 4),
		]),
		...grp('Luma Adjust', [
			check('lumaAdjust', 'Luma Adjust', true),
			slider('offsetDarks', 'Offset Darks', 0, undefined, undefined, { softMin: -8, softMax: 2 }),
			slider('boostMids', 'Boost Mids', 1, 0.1, 10, { softMax: 3 }),
			slider('scaleLights', 'Scale Lights', 1, undefined, undefined, { softMin: 0, softMax: 3 }),
			slider('blurLuma', 'Blur Luma', 0.0115, 0, 1, { softMax: 0.05, step: 0.0001 }),
			// Sapphire's default reads [0.05, 1]; here X is the horizontal softness (VHS luma is soft sideways)
			fxParam.vec2('blurRel', 'Blur Rel', [1, 0.05], { min: 0, softMax: 4, step: 0.01 }),
		]),
		...grp('Tape Noise', [
			check('tapeNoise', 'Tape Noise', true),
			slider('coarseness', 'Coarseness', 0.16, 0, 1),
			slider('dampenCoarseness', 'Dampen Coarseness', 0.00429, 0, 1, { softMax: 0.05, step: 0.0001 }),
			slider('fineNoise', 'Fine Noise', 0.01, 0, 0.1, { step: 0.0001 }),
			slider('displaceX', 'Displace X', 0.33, -1, 1),
			slider('displaceY', 'Displace Y', -0.04, -1, 1),
		]),
		...grp('Fast Forward', [
			slider('fastForwardAmount', 'Fast Forward Amount', 0, 0, 10, { softMax: 2 }),
			slider('bandFrequency', 'Band Frequency', 1, 0, 100, { softMax: 10 }),
			slider('bandFrequencyVary', 'Band Frequency Vary', 2, undefined, undefined, {
				softMin: 0,
				softMax: 10,
			}),
			slider('bandHeight', 'Band Height', 0.1, 0, 1),
			slider('bandShift', 'Band Shift', 1.03, undefined, undefined, { softMin: -3, softMax: 3 }),
			slider('bandShiftVary', 'Band Shift Vary', 0.7, 0, 10, { softMax: 2 }),
		]),
		...grp('Scanlines', [
			check('scanlines', 'Scanlines', true),
			slider('linesFrequency', 'Lines Frequency', 120, 1, 2000, { softMax: 600 }),
			slider('linesIntensity', 'Lines Intensity', 0.02, 0, 1),
			slider('addNoise', 'Add Noise', 0, 0, 1),
			slider('noiseFreq', 'Noise Freq', 0.006, 0, 1, { softMax: 0.05, step: 0.0001 }),
			slider('linesShift', 'Lines Shift', 0, undefined, undefined, { softMin: -1, softMax: 1 }),
			slider('linesShiftRed', 'Lines Shift Red', 0, undefined, undefined, { softMin: -1, softMax: 1 }),
			slider('linesShiftGreen', 'Lines Shift Green', 0, undefined, undefined, { softMin: -1, softMax: 1 }),
			slider('linesShiftBlue', 'Lines Shift Blue', 0, undefined, undefined, { softMin: -1, softMax: 1 }),
			slider('shiftSpeed', 'Shift Speed', 1.5, -10, 10),
			fxParam.choice(
				'streaksColor',
				'Streaks Color',
				['generate', 'amplify'],
				['Generate', 'Amplify'],
				'generate',
			),
		]),
		...bandParams('streaks', [0.8, 0.9, 960, 50, 0.25, 1, 3, 0.23, 0.15, 0.12, 0.43]),
		...bandParams('sparkles', [1.2, 1.2, 1200, 5, 0, 2, 3, 0.6, 0.4, 0.6, 0]),
		sapphireSeed('Random Seed'),
		mixParam('Mix With Source'),
	],
	gpu: {
		time: { samples: (p) => (p.interlacedCombing === true ? [1] : []) },
		passes: [
			{ output: 'tape', include: [GLSL_FILM], frag: VHS_TAPE },
			{ output: 'yiq', include: [GLSL_FILM], frag: VHS_CHROMA, format: 'rgba16f' },
			{ include: [GLSL_FILM, GLSL_LUT], frag: VHS_FINAL },
		],
	},
});

export const VIDEO_EFFECTS: readonly EffectSpec[] = [S_VHS_DAMAGE, S_TV_DAMAGE];

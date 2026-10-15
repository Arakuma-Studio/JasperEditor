// Cutting transitions of the family: S_FlutterCut (rapid cuts between the clips, optional colour and inverted
// frames; the frame pattern is computed in TS, a pure function of the params and the span) and S_TVChannelChange
// (bad reception into black/static and out of it on the other channel).
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams } from '../../effects.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition, SAPPHIRE_TRANSITION_SUBBINS, TRANSITION_BINS } from '../define.ts';
import { check, choice, GLSL_SW, num, rgbParam, sapphireSeed, sInt, sNum, str } from './common.ts';

const BIN = TRANSITION_BINS.sapphire;
const OTHER = SAPPHIRE_TRANSITION_SUBBINS.other;

export type FlutterShow = 'from' | 'to' | 'color1' | 'color2';
export type FlutterFrame = { show: FlutterShow; invert: boolean };

const COLOR_POSITIONS = ['beforeFrom', 'afterFrom', 'afterTo', 'afterBoth'] as const;
const INVERT_OPTIONS = ['none', 'from', 'to', 'both', 'custom'] as const;

/**
 * The frame pattern of S_FlutterCut over a `duration`-frame span: cycles of From frames then To frames whose lengths
 * go from the Start to the End frame counts (Acceleration ≥ 1 keeps the start lengths longer), Color1/Color2 frames
 * inserted at their positions, and inverted frames (Invert Length after Normal Before, then Normal After, repeating;
 * within the chosen clip's runs, or over every frame for Custom Pattern). The last frame is always the To clip.
 */
export function flutterPattern(p: EffectParams, duration: number): FlutterFrame[] {
	const d = Math.max(1, Math.floor(duration));
	const int = (v: ParamValue | undefined, def: number, min: number) => Math.max(min, Math.round(num(v, def)));
	const len = (s: string, t: number) => {
		const a = int(p[`${s}StartFrames`], 2, 1);
		const b = int(p[`${s}EndFrames`], 2, 1);
		const acc = Math.max(1, num(p[`${s}Acceleration`], 1));
		return Math.max(1, Math.round(a + (b - a) * t ** acc));
	};
	const colors = ([1, 2] as const).map((i) => ({
		show: `color${i}` as FlutterShow,
		frames: int(p[`color${i}Frames`], 0, 0),
		pos: str(p[`color${i}Position`], 'afterFrom'),
	}));
	const invert = str(p.invert, 'none');
	const nb = int(p.normalBefore, 1, 0);
	const il = int(p.invertLength, 1, 0);
	const na = int(p.normalAfter, 0, 0);
	const period = Math.max(1, nb + il + na);
	const inv = (j: number) => il > 0 && j % period >= nb && j % period < nb + il;
	const out: FlutterFrame[] = [];
	const push = (show: FlutterShow, n: number) => {
		for (let j = 0; j < n && out.length < d; j++) {
			const clip = show === 'from' ? 'from' : show === 'to' ? 'to' : null;
			const invertHere =
				invert === 'custom'
					? inv(out.length)
					: clip !== null && (invert === 'both' || invert === clip) && inv(j);
			out.push({ show, invert: invertHere });
		}
	};
	const colorsAt = (where: string) => {
		for (const c of colors)
			if (
				c.frames > 0 &&
				(c.pos === where || (c.pos === 'afterBoth' && (where === 'afterFrom' || where === 'afterTo')))
			)
				push(c.show, c.frames);
	};
	while (out.length < d) {
		const t = d > 1 ? out.length / (d - 1) : 1;
		colorsAt('beforeFrom');
		push('from', len('from', t));
		colorsAt('afterFrom');
		push('to', len('to', t));
		colorsAt('afterTo');
	}
	out[d - 1] = { show: 'to', invert: false };
	return out;
}

/** The S_FlutterCut frame shown at a progress (exact A at 0 and B at 1; otherwise frame ⌊p·d⌋ of the pattern). */
export function flutterAt(p: EffectParams, progress: number, duration: number): FlutterFrame {
	if (progress <= 0) return { show: 'from', invert: false };
	if (progress >= 1) return { show: 'to', invert: false };
	const pat = flutterPattern(p, duration);
	return pat[Math.min(pat.length - 1, Math.floor(progress * pat.length))]!;
}

const SHOW_INDEX: Record<FlutterShow, number> = { from: 0, to: 1, color1: 2, color2: 3 };

export const S_FLUTTER_CUT = defineShaderTransition({
	id: 'jasper.s.flutter-cut',
	label: 'S_FlutterCut',
	bin: BIN,
	subBin: OTHER,
	description:
		'Cuts rapidly back and forth between the clips (frame counts change from the start to the end of the transition), optionally inserting solid-colour or inverted frames.',
	keywords: ['flutter', 'flicker', 'strobe', 'cut', 'flash', 'invert'],
	params: [
		sInt('fromStartFrames', 'From Start Frames', 2, 1, 1000, 12),
		sInt('fromEndFrames', 'From End Frames', 2, 1, 1000, 12),
		sNum('fromAcceleration', 'From Acceleration', 1, { min: 1, softMax: 5 }),
		sInt('toStartFrames', 'To Start Frames', 2, 1, 1000, 12),
		sInt('toEndFrames', 'To End Frames', 2, 1, 1000, 12),
		sNum('toAcceleration', 'To Acceleration', 1, { min: 1, softMax: 5 }),
		rgbParam('color1', 'Color1', [0, 0, 0]),
		sInt('color1Frames', 'Color1 Frames', 0, 0, 100, 6),
		choice(
			'color1Position',
			'Color1 Position',
			COLOR_POSITIONS,
			['Before From', 'After From', 'After To', 'After Both'],
			'afterFrom',
		),
		rgbParam('color2', 'Color2', [1, 1, 1]),
		sInt('color2Frames', 'Color2 Frames', 0, 0, 100, 6),
		choice(
			'color2Position',
			'Color2 Position',
			COLOR_POSITIONS,
			['Before From', 'After From', 'After To', 'After Both'],
			'afterTo',
		),
		choice(
			'invert',
			'Invert',
			INVERT_OPTIONS,
			['None', 'From Clip', 'To Clip', 'Both Clips', 'Custom Pattern'],
			'none',
		),
		sInt('invertLength', 'Invert Length', 1, 0, 100, 10),
		sInt('normalBefore', 'Normal Before', 1, 0, 100, 10),
		sInt('normalAfter', 'Normal After', 0, 0, 100, 10),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const f = flutterAt(p, ctx.progress, ctx.duration);
			return { u_fcShow: { int: SHOW_INDEX[f.show] }, u_fcInvert: f.invert };
		},
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 c = u_fcShow == 0 ? tr_from(v_uv) : u_fcShow == 1 ? tr_to(v_uv)
         : u_fcShow == 2 ? vec4(u_color1.rgb, 1.0) : vec4(u_color2.rgb, 1.0);
  if (u_fcInvert) c.rgb = c.a - c.rgb;
  fragColor = c;
}`,
			},
		],
	},
});

/** The dead-time window [start, end] of S_TVChannelChange in progress. */
function deadWindow(p: EffectParams): [number, number] {
	const dur = Math.min(1, Math.max(0, num(p.deadTimeDuration, 0.2)));
	const start = (1 - dur) * Math.min(1, Math.max(0, 0.5 + 0.5 * num(p.deadTimeStart, 0)));
	return [start, start + dur];
}

export const S_TV_CHANNEL_CHANGE = defineShaderTransition({
	id: 'jasper.s.tv-channel-change',
	label: 'S_TVChannelChange',
	bin: BIN,
	subBin: OTHER,
	description:
		'An old TV changing channels: the outgoing picture loses reception (rolling, tearing, ghosts, hum bars, static) into black or static, then the incoming one comes in with bad reception that settles.',
	keywords: ['tv', 'channel', 'static', 'noise', 'analog', 'vhs', 'interference', 'glitch'],
	params: [
		sNum('reception', 'Reception', 1.6, { min: 0, softMax: 4 }),
		choice(
			'deadTimeStyle',
			'Dead Time Style',
			['black', 'staticOverBlack', 'staticOverDissolve'],
			['Black', 'Static Over Black', 'Static Over Dissolve'],
			'staticOverBlack',
		),
		sNum('deadTimeDuration', 'Dead Time Duration', 0.2, { min: 0, max: 1 }),
		sNum('deadTimeStart', 'Dead Time Start', 0, { min: 0, max: 1 }),
		sNum('interferenceAmplitude', 'Interference Amplitude', 0.6, { min: 0, softMax: 3 }),
		sNum('ghosting', 'Ghosting', 0.6, { min: 0, softMax: 3 }),
		sNum('horizontalHold', 'Horizontal Hold', 0.5, { min: 0, softMax: 3 }),
		sNum('verticalHold', 'Vertical Hold', 0.8, { min: 0, softMax: 3 }),
		sNum('barsBrightness', 'Bars Brightness', 0.3, { min: 0, softMax: 2 }),
		sNum('colorStripesAmplitude', 'Color Stripes Amplitude', 0.2, { min: 0, softMax: 2 }),
		sNum('staticAmplitude', 'Static Amplitude', 0.8, { min: 0, softMax: 3 }),
		sNum('staticDensity', 'Static Density', 0.7, { min: 0.01, max: 1 }),
		sNum('interferenceFrequency', 'Interference Frequency', 1.28, { min: 0, max: 500, softMax: 10 }),
		fxParam.vec2('dotsSpeed', 'Dots Speed', [100, -10], { softMin: -500, softMax: 500, step: 0.1 }),
		sNum('hFrequency', 'H Frequency', 1.25, { min: 0, softMax: 10 }),
		sNum('hTimeVary', 'H Time Vary', 0.5, { min: 0, softMax: 4 }),
		sInt('hOctaves', 'H Octaves', 3, 1, 10),
		sNum('borderWidth', 'Border Width', 0.05, { min: 0, softMax: 0.5, step: 0.001 }),
		sNum('vSpeed', 'V Speed', 1, { softMin: -4, softMax: 4 }),
		sNum('borderHeight', 'Border Height', 0.1, { min: 0, softMax: 0.5, step: 0.001 }),
		sNum('borderData', 'Border Data', 1, { min: 0, max: 10 }),
		sNum('saturation', 'Saturation', 1, { softMin: 0, softMax: 3 }),
		sNum('tvPixels', 'TV Pixels', 720, { min: 1, softMax: 2000, step: 1 }),
		check('downsample', 'Downsample', true),
		sapphireSeed(),
	],
	gpu: {
		uniforms: (p) => {
			const [a, b] = deadWindow(p);
			return { u_tvDead: [a, b] };
		},
		passes: [
			{
				include: [GLSL_SW, GLSL_HASH, GLSL_NOISE, GLSL_COLOR],
				frag: /* glsl */ `
// Reception badness 0..1 (× Reception / 1.6): grows into the dead time, decays after it.
float tv_bad(float e) {
  float a = u_tvDead.x, b = u_tvDead.y;
  float r = e < a ? pow(sw_lstep(0.0, a, e), 1.6) : e > b ? pow(1.0 - sw_lstep(b, 1.0, e), 1.6) : 1.0;
  if (e <= 0.0 || e >= 1.0) r = 0.0;
  return r * u_reception / 1.6;
}
// The picture of the current channel at uv (opaque black outside the tube).
vec4 tv_pic(vec2 uv, int ch, float dissolve) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0, 0.0, 0.0, 1.0);
  if (ch == 0) return tr_from(uv);
  if (ch == 1) return tr_to(uv);
  if (ch == 3) return mix(tr_from(uv), tr_to(uv), dissolve);
  return vec4(0.0, 0.0, 0.0, 1.0);
}
void main() {
  float e = tr_progress();
  float r = tv_bad(e);
  float t = u_frame / max(u_fps, 1.0);
  bool dead = e >= u_tvDead.x && e <= u_tvDead.y && e > 0.0 && e < 1.0;
  int ch = e < u_tvDead.x ? 0 : e > u_tvDead.y ? 1 : (u_deadTimeStyle == 2 ? 3 : 2);
  if (e <= 0.0) ch = 0;
  if (e >= 1.0) ch = 1;
  float dissolve = sw_lstep(u_tvDead.x, u_tvDead.y, e);
  if (r <= 0.0) { fragColor = tv_pic(v_uv, ch, dissolve); return; }
  vec2 uv = v_uv;
  // Downsample to the TV's resolution (columns = TV Pixels, square pixels), faded in with the bad reception.
  if (u_downsample) {
    vec2 grid = vec2(max(u_tvPixels, 1.0), max(u_tvPixels, 1.0) / tr_aspect());
    vec2 q = (floor(uv * grid) + 0.5) / grid;
    uv = mix(uv, q, smoothstep(0.0, 0.15, r));
  }
  // Vertical hold: the picture rolls, with the blanking bar at the seam.
  float roll = u_verticalHold * r * r * (u_vSpeed * t * 1.3 + 0.35 * fx_simplex(vec2(t * 2.0, 3.7), u_seed));
  float y = uv.y + roll;
  float yf = fract(y);
  float bh = clamp(u_borderHeight * min(1.0, r * 3.0), 0.0, 0.9);
  bool blank = yf > 1.0 - bh;
  // Horizontal hold: lines tear sideways (fBm along y), black border on the left as the picture slides.
  int oct = int(clamp(u_hOctaves, 1.0, 10.0));
  float tear = fx_fbm(vec2(yf * u_hFrequency * 6.0, t * (0.5 + u_hTimeVary * 3.0)), oct, 2.0, 0.5, fract(u_seed + 0.21));
  float hx = u_horizontalHold * r * (0.06 * tear + 0.02 * sin(yf * 40.0 + t * 30.0) * r);
  vec2 suv = vec2(uv.x - hx, yf / max(1.0 - bh, 0.1));
  vec4 c = tv_pic(suv, ch, dissolve);
  // Ghosting: delayed echoes of the signal to the right.
  float g = clamp(u_ghosting * r * 0.35, 0.0, 0.8);
  c = mix(c, 0.6 * tv_pic(suv - vec2(0.03, 0.0), ch, dissolve) + 0.4 * tv_pic(suv - vec2(0.065, 0.0), ch, dissolve), g);
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  // Colour stripes: the chroma phase drifts line by line.
  float hue = u_colorStripesAmplitude * r * sin(yf * 90.0 + t * 7.0) * 0.5;
  rgb = fx_hueShift(rgb, hue);
  rgb = fx_saturate(rgb, mix(1.0, u_saturation, r));
  // Hum bars rolling up the screen.
  rgb *= 1.0 - u_barsBrightness * r * (0.5 + 0.5 * sin(6.2831853 * (yf * 1.4 - t * 0.6)));
  // Interference: fine moving diagonal dot pattern.
  vec2 px = tr_px();
  float iv = sin(6.2831853 * (u_interferenceFrequency * (px.x * 0.05 + px.y * 0.21) + (u_dotsSpeed.x + u_dotsSpeed.y) * t * 0.05));
  rgb += u_interferenceAmplitude * r * 0.35 * pow(max(iv, 0.0), 6.0);
  // Static snow.
  float cell = max(1.0, u_compSize.x / max(u_tvPixels, 1.0));
  float sn = fx_random(floor(px / cell), u_frame, u_seed);
  float lit = step(1.0 - clamp(u_staticDensity, 0.01, 1.0), fx_random(floor(px / cell) + 17.0, u_frame, fract(u_seed + 0.5)));
  float snow = sn * lit;
  float sAmt = clamp(u_staticAmplitude * r * 0.45, 0.0, 1.0);
  if (dead) sAmt = u_deadTimeStyle == 0 ? 0.0 : clamp(u_staticAmplitude, 0.0, 1.0);
  rgb = mix(rgb, vec3(snow), sAmt);
  // Blanking bar: black with the data dashes of the vertical interval.
  if (blank) {
    float dash = step(0.5, fract(px.x / 24.0 + floor(yf * 60.0) * 0.37)) * step(0.5, fract(yf * 60.0));
    rgb = vec3(dash * 0.1 * u_borderData);
  }
  // Black border on the left edge while the hold slips.
  if (v_uv.x < u_borderWidth * r * clamp(0.6 + 1.5 * tear, 0.0, 2.0)) rgb = vec3(0.0);
  float a = max(c.a, (blank || dead || sAmt > 0.0) ? 1.0 : 0.0);
  fragColor = vec4(clamp(rgb, 0.0, 1.0) * a, a);
}`,
			},
		],
	},
});

// The motion transitions of the family: S_SwishPan, S_Swish3D (Sapphire's Wipe Transitions), S_WhipLash and
// S_MochaWhip (Other). All of them motion-blur along the actual path of the move (shutter taps in progress space,
// see common.ts), so blur follows speed curves, overshoots and rotations.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition, SAPPHIRE_TRANSITION_SUBBINS, TRANSITION_BINS } from '../define.ts';
import type { TrFrameContext } from '../shader.ts';
import {
	check,
	choice,
	DIRECTION_LABELS,
	DIRECTION_OPTIONS,
	directionVector,
	edgeModeParam,
	GLSL_SW_SHUTTER,
	rgbParam,
	shutterUniforms,
	slowParams,
	sNum,
	whipParam,
	wrapParam,
} from './common.ts';

const BIN = TRANSITION_BINS.sapphire;

// ---------------------------------------------------------------- S_SwishPan

/** S_SwishPan: one clip slides off, the other on, with a directional motion blur — a fast camera pan. */
export const S_SWISH_PAN = defineShaderTransition({
	id: 'jasper.s.swish-pan',
	label: 'S_SwishPan',
	bin: BIN,
	subBin: SAPPHIRE_TRANSITION_SUBBINS.wipes,
	description:
		'Slides the outgoing clip off the frame and the incoming clip on, with heavy motion blur along the move — a quick whip pan. Works best on short transitions.',
	keywords: ['swish', 'pan', 'whip', 'slide', 'push', 'motion blur'],
	params: [
		choice('direction', 'Direction', DIRECTION_OPTIONS, DIRECTION_LABELS, 'left'),
		sNum('blurAmount', 'Blur Amount', 2, { min: 0, softMax: 10 }),
		sNum('overlap', 'Overlap', 0, { min: 0, max: 0.95 }),
		...slowParams(0.5),
	],
	gpu: {
		uniforms: (p, ctx) => ({ ...shutterUniforms(p, ctx), u_swDir: directionVector(p.direction) }),
		passes: [
			{
				include: [GLSL_SW_SHUTTER],
				frag: /* glsl */ `
// Offsets (frame extents along the move) of A and B at progress q.
vec2 sp_offsets(float q) {
  float e = sw_slow(q, u_slowIn, u_slowOut);
  float o = clamp(u_overlap, 0.0, 0.95) * 4.0 * e * (1.0 - e);   // overlap only mid-way: exact ends
  return vec2(e * (1.0 - o), (e - 1.0) * (1.0 - o));
}
vec4 sp_at(float q) {
  vec2 o = sp_offsets(q);
  return sw_screen(tr_from(v_uv - u_swDir * o.x), tr_to(v_uv - u_swDir * o.y));
}
void main() {
  float p = tr_progress();
  float h = sw_shutter(p, u_blurAmount);
  float lo = p - h, hi = p + h;
  float ext = abs(dot(u_compSize, u_swDir));
  float extent = abs(sp_offsets(hi).x - sp_offsets(lo).x) * ext;
  int n = sw_taps(extent, 64);
  float j = extent / float(n) > 1.5 ? sw_jitter() : 0.5;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    acc += sp_at(sw_tapAt(i, n, lo, hi, j));
  }
  fragColor = acc / float(n);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_Swish3D

/**
 * S_Swish3D: both clips perform a 3D move (Z distance, rotate, swivel, tilt, shift, scale) while dissolving — the
 * outgoing clip moves by the transform × Rel Amp From, the incoming one arrives from the transform × Rel Amp To —
 * with motion blur along the 3D path (Blur Warp) or a spectral smear (Chroma Warp).
 */
export const S_SWISH_3D = defineShaderTransition({
	id: 'jasper.s.swish-3d',
	expensive: true,
	label: 'S_Swish3D',
	bin: BIN,
	subBin: SAPPHIRE_TRANSITION_SUBBINS.wipes,
	description:
		'Dissolves between the clips while both perform a 3D move (Z distance, rotate, swivel, tilt, shift, scale) in perspective, with motion blur along the path or a chroma-warp smear.',
	keywords: ['swish', '3d', 'zoom', 'spin', 'perspective', 'motion blur', 'chroma'],
	params: [
		choice('effect', 'Effect', ['blurWarp', 'chromaWarp'], ['Blur Warp', 'Chroma Warp'], 'blurWarp'),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		sNum('motionBlur', 'Motion Blur', 1, { min: 0, softMax: 5 }),
		sNum('zDist', 'Z Dist', 0.5, { min: 0.001, softMax: 4 }),
		fxParam.angle('rotate', 'Rotate', 0),
		fxParam.angle('swivel', 'Swivel', 0),
		fxParam.angle('tilt', 'Tilt', 0),
		sNum('perspective', 'Perspective Amount', 1, { min: 0.25, max: 4 }),
		fxParam.vec2('shift', 'Shift', [0, 0], { softMin: -4, softMax: 4, step: 0.01 }),
		sNum('scale', 'Scale', 1, { min: 0.01, max: 2 }),
		fxParam.vec2('scaleRel', 'Scale Rel', [1, 1], { min: 0.01, max: 2, step: 0.01 }),
		sNum('relAmpFrom', 'Rel Amp From', 1, { softMin: -2, softMax: 2 }),
		sNum('relAmpTo', 'Rel Amp To', -1, { softMin: -2, softMax: 2 }),
		choice('fade', 'Fade', ['fromAndTo', 'from', 'to'], ['From and To', 'From Only', 'To Only'], 'fromAndTo'),
		sNum('fadeMidTime', 'Fade Mid Time', 0.5, { min: 0, max: 1 }),
		...slowParams(0.5),
		wrapParam('wrapFrom', 'Wrap From'),
		wrapParam('wrapTo', 'Wrap To'),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('midBrightness', 'Mid Brightness', 1, { min: 0, softMax: 4 }),
		fxParam.number('steps', 'Steps', 8, { min: 3, max: 100, softMax: 32, step: 1 }),
		rgbParam('color1', 'Color1', [1, 0, 0]),
		rgbParam('color2', 'Color2', [0, 1, 0]),
		rgbParam('color3', 'Color3', [0, 0, 1]),
	],
	gpu: {
		uniforms: shutterUniforms,
		passes: [
			{
				include: [GLSL_SW_SHUTTER],
				frag: /* glsl */ `
// The source uv seen at frame position f for the transform of amplitude s (0 = identity); z = 0 when the ray misses
// the plane (behind the camera).
vec3 s3_map(vec2 f, float s) {
  float zd = pow(max(u_zDist, 1e-3), s);
  vec2 sc = pow(max(vec2(u_scale) * u_scaleRel, vec2(1e-3)), vec2(s));
  float F = 2.0 / clamp(u_perspective, 0.25, 4.0);
  vec2 c = sw_f(u_center);
  vec2 sh = sw_sapph(u_shift) * s;
  float a = radians(u_swivel * s), b = radians(u_tilt * s);
  // R3 = Ry(swivel) · Rx(tilt): the plane's axes in camera space.
  vec3 ex = vec3(cos(a), 0.0, -sin(a));
  vec3 ey = vec3(sin(a) * sin(b), cos(b), cos(a) * sin(b));
  vec3 n = vec3(sin(a) * cos(b), -sin(b), cos(a) * cos(b));
  vec3 q = vec3((c + sh) * zd, F * zd);
  vec3 d = vec3(f, F);
  float den = dot(n, d);
  if (abs(den) < 1e-6) return vec3(0.0);
  float t = dot(n, q) / den;
  if (t <= 0.0) return vec3(0.0);
  vec3 pr = t * d - q;
  vec2 v = vec2(dot(pr, ex), dot(pr, ey));
  vec2 u = (sw_rot(-u_rotate * s) * v) / sc;
  return vec3(sw_uv(c + u), 1.0);
}
float s3_fade(float e) {
  if (e <= 0.0) return 0.0;
  if (e >= 1.0) return 1.0;
  float m = clamp(u_fadeMidTime, 0.0, 1.0);
  float w = min(0.25, min(m, 1.0 - m));
  return w <= 1e-4 ? step(m, e) : smoothstep(m - w, m + w, e);
}
vec4 s3_at(vec2 f, float q) {
  float e = sw_slow(q, u_slowIn, u_slowOut);
  vec3 ma = s3_map(f, e * u_relAmpFrom);
  vec3 mb = s3_map(f, (1.0 - e) * u_relAmpTo);
  vec4 a = ma.z > 0.0 ? sw_fromW(ma.xy, u_wrapFrom) : vec4(0.0);
  vec4 b = mb.z > 0.0 ? sw_toW(mb.xy, u_wrapTo) : vec4(0.0);
  float w = s3_fade(e);
  if (u_fade == 1) return a * (1.0 - w) + b * (1.0 - a.a * (1.0 - w));      // From fades out over To
  if (u_fade == 2) return b * w + a * (1.0 - b.a * w);                        // To fades in over From
  return mix(a, b, w);
}
void main() {
  float p = tr_progress();
  vec2 f = sw_f(v_uv);
  float h = sw_shutter(p, u_motionBlur * 2.0);
  float lo = p - h, hi = p + h;
  // On-screen extent of the move over the shutter (both sides), in px.
  float el = sw_slow(lo, u_slowIn, u_slowOut), eh = sw_slow(hi, u_slowIn, u_slowOut);
  vec2 da = (s3_map(f, eh * u_relAmpFrom).xy - s3_map(f, el * u_relAmpFrom).xy) * u_compSize;
  vec2 db = (s3_map(f, (1.0 - eh) * u_relAmpTo).xy - s3_map(f, (1.0 - el) * u_relAmpTo).xy) * u_compSize;
  float extent = min(max(length(da), length(db)), 4096.0);
  bool chroma = u_effect == 1;
  int n = sw_taps(extent, 48);
  if (chroma && h > 0.0) n = max(n, int(clamp(u_steps, 3.0, 100.0)));
  n = min(n, 100);
  float j = extent / float(n) > 1.5 ? sw_jitter() : 0.5;
  vec4 acc = vec4(0.0);
  vec3 wsum = vec3(0.0);
  for (int i = 0; i < 100; i++) {
    if (i >= n) break;
    float t = (float(i) + j) / float(n);
    vec4 c = s3_at(f, mix(lo, hi, t));
    vec3 w = chroma && n > 1 ? sw_spectrum(t, u_color1.rgb, u_color2.rgb, u_color3.rgb) : vec3(1.0);
    acc += vec4(c.rgb * w, c.a);
    wsum += w;
  }
  vec4 col = vec4(acc.rgb / max(wsum, vec3(1e-4)), acc.a / float(n));
  col.rgb = min(col.rgb, vec3(max(col.a, 1e-4)) * 4.0);
  float bell = sw_bell(sw_slow(p, u_slowIn, u_slowOut));
  float gain = mix(1.0, u_brightness, bell) * mix(1.0, u_midBrightness, bell);
  fragColor = vec4(min(col.rgb * gain, vec3(col.a)), col.a);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_WhipLash + S_MochaWhip

/** RGB split / blur params of WhipLash (and MochaWhip's Cutout / Background sets, with a prefix). */
function rgbSplitParams(prefix = '', labelPrefix = '') {
	const n = (s: string) => (prefix ? `${prefix}${s[0]!.toUpperCase()}${s.slice(1)}` : s);
	const l = (s: string) => `${labelPrefix}${s}`;
	return [
		sNum(n('mixRgb'), l('Mix RGB'), 0, { min: 0, max: 1 }),
		sNum(n('blurAmount'), l('Blur Amount'), 1.25, { min: 0, softMax: 5 }),
		fxParam.angle(n('angle'), l('Angle'), 0),
		sNum(n('shiftRgb'), l('Shift RGB'), 2, { softMin: -10, softMax: 10 }),
		sNum(n('blurRed'), l('Blur Red'), 1, { min: 0, softMax: 4 }),
		sNum(n('blurGreen'), l('Blur Green'), 0.5, { min: 0, softMax: 4 }),
		sNum(n('blurBlue'), l('Blur Blue'), 0, { min: 0, softMax: 4 }),
		sNum(n('shiftRed'), l('Shift Red'), 0.5, { softMin: -4, softMax: 4 }),
		sNum(n('shiftGreen'), l('Shift Green'), 0.25, { softMin: -4, softMax: 4 }),
		sNum(n('shiftBlue'), l('Shift Blue'), 0, { softMin: -4, softMax: 4 }),
	];
}

/**
 * GLSL of one whip side, parameterised by uniform names (so WhipLash and MochaWhip's background share it). The
 * whip position W (0 → 1, 0.5 at the cut) drives: shift × W (From) or × (W − 1) (To), rotate likewise, and Scale
 * towards the middle. RGB split: per-channel offsets along Angle, scaled by the whip speed.
 */
const whipGlsl = (u: (s: string) => string) => /* glsl */ `
// Source uv of side (0 From, 1 To) at whip position W, for frame position f.
vec2 wl_map${u('')}(vec2 f, float W, int side) {
  float k = side == 0 ? W : W - 1.0;
  vec2 c = sw_f(${u('center')});
  float sc = mix(1.0, max(${u('scale')}, 0.01), sin(SW_PI * clamp(W, 0.0, 1.0)));
  vec2 g = f - c - sw_sapph(${u('shift')}) * k;
  g = sw_rot(-${u('rotate')} * k) * g / sc;
  return sw_uv(c + g);
}
vec4 wl_side${u('')}(vec2 uv, int side, int mode) { return side == 0 ? sw_fromW(uv, mode) : sw_toW(uv, mode); }
// The picture at whip position W with the RGB split of tap t (0..1 across the shutter) at speed v (0..1).
vec4 wl_tap${u('')}(vec2 f, float W, float t, float v, int sideMask, int mode) {
  int side = W < 0.5 ? 0 : 1;
  if ((sideMask == 1 && side == 1) || (sideMask == 2 && side == 0)) {
    // Background Whip Side: the other side stays still (a plain cut at the middle).
    return wl_side${u('')}(sw_uv(f), side, mode);
  }
  vec2 uv = wl_map${u('')}(f, W, side);
  vec4 base = wl_side${u('')}(uv, side, mode);
  float mixRgb = clamp(${u('mixRgb')}, 0.0, 1.0);
  if (mixRgb <= 0.0 || v <= 0.0) return base;
  vec2 dir = vec2(cos(radians(${u('angle')})), sin(radians(${u('angle')}))) / vec2(tr_aspect(), 1.0);
  float unit = 0.02 * tr_aspect() * v;
  vec3 sh = ${u('shiftRgb')} * vec3(${u('shiftRed')}, ${u('shiftGreen')}, ${u('shiftBlue')});
  vec3 bl = ${u('blurAmount')} * vec3(${u('blurRed')}, ${u('blurGreen')}, ${u('blurBlue')}) * (t - ${u('bias')});
  vec3 o = (sh + bl) * unit;
  vec4 r = wl_side${u('')}(uv + dir * o.r, side, mode);
  vec4 gg = wl_side${u('')}(uv + dir * o.g, side, mode);
  vec4 b = wl_side${u('')}(uv + dir * o.b, side, mode);
  vec4 split = vec4(r.r, gg.g, b.b, (r.a + gg.a + b.a) / 3.0);
  return mix(base, split, mixRgb);
}
// Motion-blurred whip of both sides at progress p.
vec4 wl_render${u('')}(vec2 f, float p, float blurFrames, int whipOut, int sideMask, int mode) {
  float h = sw_shutter(p, blurFrames);
  float lo = p - h, hi = p + h;
  float Wl = sw_whip(lo, whipOut), Wh = sw_whip(hi, whipOut);
  // Extent (px): the travel of the picture over the shutter — shift, plus the arc of the rotation at the corners.
  float travel = abs(Wh - Wl) * (length(sw_sapph(${u('shift')})) * u_compSize.y
    + abs(radians(${u('rotate')})) * tr_halfDiagonal() + abs(1.0 - ${u('scale')}) * tr_halfDiagonal());
  float extent = min(travel, 8192.0);
  int n = sw_taps(extent, 64);
  float j = extent / float(n) > 1.5 ? sw_jitter() : 0.5;
  // Speed 0..1 of the whip (peak = 3 per unit of progress): scales the RGB split.
  float v = clamp(abs(sw_whip(min(p + 0.01, 1.0), whipOut) - sw_whip(max(p - 0.01, 0.0), whipOut)) / (0.02 * 3.0), 0.0, 1.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    float t = (float(i) + j) / float(n);
    float q = mix(lo, hi, t);
    acc += wl_tap${u('')}(f, sw_whip(q, whipOut), n > 1 ? t : 0.5, v, sideMask, mode);
  }
  return acc / float(n);
}
`;

const WHIP_FINISH = /* glsl */ `
// Brightness / Offset Darks, faded in and out with the whip so the ends stay exact.
vec4 wl_finish(vec4 c, float k, float brightness, float offsetDarks) {
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  rgb = rgb * mix(1.0, brightness, k) + offsetDarks * k * 0.1 * (1.0 - clamp(rgb, 0.0, 1.0));
  rgb = max(rgb, 0.0);
  return vec4(rgb * c.a, c.a);
}`;

/** S_WhipLash: a 2D whip of both clips (cut in the middle), Whip Out styles, RGB split blur. */
export const S_WHIP_LASH = defineShaderTransition({
	id: 'jasper.s.whip-lash',
	label: 'S_WhipLash',
	bin: BIN,
	subBin: SAPPHIRE_TRANSITION_SUBBINS.other,
	description:
		'A 2D-only Swish3D: both clips whip by a shift / rotation / scale with motion blur and cut in the middle; Whip Out (Smooth, Bounce, Snap) shapes the landing; optional RGB split blur.',
	keywords: ['whip', 'lash', 'whip pan', 'swish', 'motion blur', 'rgb split', 'bounce'],
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		sNum('motionBlur', 'Motion Blur', 1, { min: 0, softMax: 4 }),
		fxParam.angle('rotate', 'Rotate', 0),
		fxParam.vec2('shift', 'Shift', [-4, 0], { softMin: -10, softMax: 10, step: 0.01 }),
		sNum('scale', 'Scale', 1, { min: 0.01, max: 2 }),
		whipParam('whipOut', 'Whip Out'),
		...rgbSplitParams(),
		sNum('bias', 'Bias', 0.5, { min: 0, max: 1 }),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2 }),
		edgeModeParam(),
	],
	gpu: {
		uniforms: shutterUniforms,
		passes: [
			{
				include: [GLSL_SW_SHUTTER],
				frag: /* glsl */ `${whipGlsl((s) => (s ? `u_${s}` : ''))}${WHIP_FINISH}
void main() {
  float p = tr_progress();
  vec4 c = wl_render(sw_f(v_uv), p, u_motionBlur, u_whipOut, 0, u_edgeMode);
  fragColor = wl_finish(c, sw_bell(p), u_brightness, u_offsetDarks);
}`,
			},
		],
	},
});

/**
 * The tracker uniforms of S_MochaWhip (Mocha mode): the incoming side's track at this frame (`ctx.tracks.to`, sequence
 * px). `u_mwTrack` 0 = none / Track Mode Off, 1 = planar (`u_mwQuad` = TL, TR, BR, BL), 2 = point; `u_mwTrackAt` =
 * the tracked centre.
 */
export function mochaTrackUniforms(p: EffectParams, ctx: TrFrameContext) {
	const tr = p.trackMode === 'off' ? null : (ctx.tracks?.to ?? null);
	const quad = tr?.corners?.length === 4 ? tr.corners : null;
	const at = tr?.point ?? [0, 0];
	return {
		u_mwTrack: { int: !tr ? 0 : quad ? 1 : 2 },
		u_mwQuad: { vec4s: quad ? quad.flat() : [0, 0, 0, 0, 0, 0, 0, 0] },
		u_mwTrackAt: [at[0], at[1]] as [number, number],
	};
}

/**
 * S_MochaWhip: a WhipLash-style background whip with a cut-out of the incoming clip whipping in front and landing
 * at its place in the incoming clip. Sapphire defines the cut-out with a Mocha track; here, when the incoming clip has
 * a tracker (Track Mode = Follow Clip Track, the default), the cut-out follows it frame by frame: a planar track's
 * quad is the cut-out region, a point track centres the mask (Mask Size / Rotation; an ellipse when Cutout Mask is
 * None) on the tracked point, and the cut-out lands around the tracked centre. Without a track the region is the
 * Cutout Mask (rectangle or ellipse, keyframable centre/size); with Cutout Mask = None (default) and no track the
 * cut-out is bypassed and the transition is a plain whip pan (Sapphire's Bypass Mocha).
 */
export const S_MOCHA_WHIP = defineShaderTransition({
	id: 'jasper.s.mocha-whip',
	label: 'S_MochaWhip',
	bin: BIN,
	subBin: SAPPHIRE_TRANSITION_SUBBINS.other,
	description:
		'A whip pan in which a cut-out region of the incoming clip whips around in front and settles at its place. The region is a keyframable rectangle/ellipse mask; with no mask it is a plain whip pan.',
	keywords: ['whip', 'mocha', 'cutout', 'whip pan', 'swish', 'motion blur'],
	params: [
		choice(
			'cutoutMask',
			'Cutout Mask',
			['none', 'rectangle', 'ellipse'],
			['None (Bypass)', 'Rectangle', 'Ellipse'],
			'none',
		),
		choice(
			'trackMode',
			'Track Mode',
			['auto', 'off'],
			['Follow Clip Track (when present)', 'Off (Cutout Mask only)'],
			'auto',
		),
		fxParam.point('maskCenter', 'Mask Center', [0.5, 0.5], { group: 'Mask' }),
		fxParam.vec2('maskSize', 'Mask Size', [0.4, 0.5], { min: 0, softMax: 1, step: 0.001 }, { group: 'Mask' }),
		fxParam.angle('maskRotation', 'Mask Rotation', 0, { group: 'Mask' }),
		fxParam.pixels('blurMocha', 'Blur Mocha', 0, 200, { group: 'Mask' }),
		check('invertMocha', 'Invert Mocha', false, 'Mask'),
		fxParam.vec2(
			'cutoutOffsetStart',
			'Cutout Offset Start',
			[0, 0],
			{ min: -3, max: 3, step: 0.01 },
			{ group: 'Cutout' },
		),
		fxParam.vec2(
			'cutoutShift',
			'Cutout Shift',
			[2, 0],
			{ softMin: -10, softMax: 10, step: 0.01 },
			{ group: 'Cutout' },
		),
		sNum('cutoutFadeinTime', 'Cutout Fadein Time', 0.5, { min: 0, max: 1 }, 'Cutout'),
		fxParam.point('cutoutCenter', 'Cutout Center', [0.5, 0.5], { group: 'Cutout' }),
		fxParam.angle('cutoutRotate', 'Cutout Rotate', 0, { group: 'Cutout' }),
		sNum('cutoutMotionBlur', 'Cutout Motion Blur', 0.3, { min: 0, softMax: 4 }, 'Cutout'),
		sNum('cutoutScale', 'Cutout Scale', 1.2, { min: 1, max: 100, softMax: 4 }, 'Cutout'),
		whipParam('cutoutWhipOut', 'Cutout Whip Out'),
		sNum('cutoutBrightness', 'Cutout Brightness', 1, { min: 0, softMax: 4 }, 'Cutout'),
		choice(
			'bgWhipSide',
			'Background Whip Side',
			['both', 'from', 'to'],
			['Both', 'From', 'To'],
			'both',
			'Background',
		),
		fxParam.point('bgCenter', 'Background Center', [0.5, 0.5], { group: 'Background' }),
		sNum('bgMotionBlur', 'Background Motion Blur', 1, { min: 0, softMax: 4 }, 'Background'),
		fxParam.angle('bgRotate', 'Background Rotate', 0, { group: 'Background' }),
		fxParam.vec2(
			'bgShift',
			'Background Shift',
			[-2, 0],
			{ softMin: -10, softMax: 10, step: 0.01 },
			{ group: 'Background' },
		),
		sNum('bgScale', 'Background Scale', 1, { min: 0.01, max: 2 }, 'Background'),
		whipParam('bgWhipOut', 'Background Whip Out'),
		...rgbSplitParams('bg', 'Background ').map((p) => ({ ...p, group: 'Background' })),
		sNum('bgBias', 'Background Bias', 0.5, { min: 0, max: 1 }, 'Background'),
		sNum('bgBrightness', 'Background Brightness', 1, { min: 0, softMax: 4 }, 'Background'),
		sNum('bgOffsetDarks', 'Background Offset Darks', 0, { min: -8, max: 2 }, 'Background'),
		edgeModeParam('bgEdgeMode', 'Background Edge Mode'),
	],
	gpu: {
		uniforms: (p, ctx) => ({ ...shutterUniforms(p, ctx), ...mochaTrackUniforms(p, ctx) }),
		passes: [
			{
				include: [GLSL_SW_SHUTTER],
				frag: /* glsl */ `${whipGlsl((s) => (s ? `u_bg${s[0]!.toUpperCase()}${s.slice(1)}` : 'Bg'))}${WHIP_FINISH}
// The cut-out is on: a Cutout Mask shape, or a track of the incoming clip.
bool mw_active() { return u_cutoutMask != 0 || u_mwTrack != 0; }
// Signed distance (px, < 0 inside) to the tracked quad (convex; either winding).
float mw_quadDist(vec2 q) {
  vec2 v[4];
  v[0] = u_mwQuad[0].xy; v[1] = u_mwQuad[0].zw; v[2] = u_mwQuad[1].xy; v[3] = u_mwQuad[1].zw;
  float area = 0.0;
  for (int i = 0; i < 4; i++) { vec2 a = v[i], b = v[(i + 1) % 4]; area += a.x * b.y - b.x * a.y; }
  float o = area >= 0.0 ? 1.0 : -1.0;
  float inside = 1e9;
  for (int i = 0; i < 4; i++) {
    vec2 a = v[i], e = v[(i + 1) % 4] - a;
    float len = max(length(e), 1e-3);
    inside = min(inside, o * (e.x * (q.y - a.y) - e.y * (q.x - a.x)) / len);
  }
  return -inside;
}
// Coverage of the cut-out mask at a uv of the incoming clip.
float mw_mask(vec2 uv) {
  if (!mw_active()) return 0.0;
  float soft = max(u_blurMocha, 1.0);
  if (u_mwTrack == 1) {
    float m = 1.0 - smoothstep(-0.5 * soft, 0.5 * soft, mw_quadDist(uv * u_compSize));
    return u_invertMocha ? 1.0 - m : m;
  }
  vec2 c = u_mwTrack == 2 ? u_mwTrackAt : u_maskCenter * u_compSize;
  vec2 hs = max(u_maskSize * u_compSize * 0.5, vec2(1.0));
  vec2 d = sw_rot(-u_maskRotation) * (uv * u_compSize - c);
  float sd;
  if (u_cutoutMask == 2 || u_cutoutMask == 0) sd = (length(d / hs) - 1.0) * min(hs.x, hs.y);
  else { vec2 q = abs(d) - hs; sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
  float m = 1.0 - smoothstep(-0.5 * soft, 0.5 * soft, sd);
  return u_invertMocha ? 1.0 - m : m;
}
// The cut-out position k (0 = start, 1 = landed): offset, shift, rotation and scale fade out as it lands.
vec2 mw_map(vec2 f, float k) {
  // Tracked: the cut-out pivots (and lands) around the tracked centre.
  vec2 c = u_mwTrack != 0 ? sw_f(u_mwTrackAt / u_compSize) : sw_f(u_cutoutCenter);
  vec2 off = sw_sapph(u_cutoutOffsetStart + u_cutoutShift) * (1.0 - k);
  float sc = mix(max(u_cutoutScale, 0.01), 1.0, clamp(k, 0.0, 1.5));
  vec2 g = sw_rot(-u_cutoutRotate * (1.0 - k)) * (f - c - off) / max(sc, 0.01);
  return sw_uv(c + g);
}
vec4 mw_cutAt(vec2 f, float q) {
  float k = sw_whip(q, u_cutoutWhipOut);
  vec2 uv = mw_map(f, k);
  vec4 b = tr_to(uv);
  float op = smoothstep(u_cutoutFadeinTime - 0.1, u_cutoutFadeinTime + 0.1, q);
  if (q >= 1.0) op = 1.0;
  return b * mw_mask(uv) * op;
}
void main() {
  float p = tr_progress();
  vec2 f = sw_f(v_uv);
  vec4 bg = wl_renderBg(f, p, u_bgMotionBlur, u_bgWhipOut, u_bgWhipSide, u_bgEdgeMode);
  bg = wl_finish(bg, sw_bell(p), u_bgBrightness, u_bgOffsetDarks);
  if (!mw_active()) { fragColor = bg; return; }
  float h = sw_shutter(p, u_cutoutMotionBlur * 3.0);
  float lo = p - h, hi = p + h;
  float extent = length((mw_map(f, sw_whip(hi, u_cutoutWhipOut)) - mw_map(f, sw_whip(lo, u_cutoutWhipOut))) * u_compSize);
  int n = sw_taps(min(extent, 8192.0), 48);
  float j = extent / float(n) > 1.5 ? sw_jitter() : 0.5;
  vec4 cut = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    if (i >= n) break;
    cut += mw_cutAt(f, sw_tapAt(i, n, lo, hi, j));
  }
  cut /= float(n);
  cut.rgb *= mix(1.0, u_cutoutBrightness, sw_bell(p));
  fragColor = tr_over(cut, bg);
}`,
			},
		],
	},
});

export const SWISH_TRANSITIONS: readonly TransitionSpec[] = [
	S_SWISH_PAN,
	S_SWISH_3D,
	S_WHIP_LASH,
	S_MOCHA_WHIP,
];

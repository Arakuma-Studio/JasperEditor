// Sapphire Blur+Sharpen — motion blurs: S_BlurDirectional (a 1D blur along an angle with Shift, Bias and per-channel
// widths/shifts), S_BlurMotion (blur along the path between a From and a To transformation — zoom, rotate, shift —
// about a Center: radial/zoom, spin and directional blurs), S_BlurMoCurves (the same path taken from the animation of
// its Z Dist / Rotate / Shift params around the current frame, within Shutter Duration).
// Scales (U = half the layer width): Directional Blur Amount/Shift: half-length = value × U / 8. Shift params of
// the transformations are Sapphire screen units (x: U, y: U, y down); Center is a point (layer box 0…1).
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { centredShutter, FX_MB_KEYS, mbKeyTimes } from '../motion-blur.ts';
import { fxParam } from '../params.ts';
import type { FxFrameContext, FxPlanContext, FxUniformValue, GlslChunk } from '../shader.ts';
import {
	bool,
	choiceIndex,
	edgeOf,
	GLSL_SBS_COMMON,
	num,
	SBS_WRAPS,
	SbsPlan,
	sEdgeMode,
	sFilter,
	sMix,
	sNum,
	sSize,
	sSoftBorders,
	sWrap,
	unitLayerPx,
	unitPx,
	vec2,
} from './common.ts';

const DIR_PER_UNIT = 1 / 8;

// ---------------------------------------------------------------- S_BlurDirectional

const GLSL_SBS_DIRECTIONAL: GlslChunk = {
	name: 'sapphire-blur-sharpen/directional',
	deps: [GLSL_SBS_COMMON],
	source: /* glsl */ `
// 1D blur along dir (unit, canvas px) of half-lengths len (px, per channel) with per-channel shifts, Bias weighting.
vec4 sbs_dirBlur(sampler2D t, vec2 uv, vec2 dir, vec4 len, vec4 shift, int filt, float bias, int mode, bool perChannel) {
  vec2 px = dir / u_canvasSize;
  vec4 sig = max(len, vec4(1.0e-3)) / 1.7320508;
  float smax = max(max(sig.r, sig.g), max(sig.b, sig.a));
  float reach = sbs_reach(smax, filt);
  float n = min(ceil(reach), 64.0);
  float stride = max(reach / max(n, 1.0), 1.0e-3);
  vec4 sum = vec4(0.0);
  vec4 wsum = vec4(0.0);
  for (int i = -64; i <= 64; i++) {
    if (abs(float(i)) > n) continue;
    float x = float(i) * stride;
    vec4 w = vec4(sbs_kernel(abs(x), sig.r, filt, stride), sbs_kernel(abs(x), sig.g, filt, stride),
                  sbs_kernel(abs(x), sig.b, filt, stride), sbs_kernel(abs(x), sig.a, filt, stride));
    w = mix(w, vec4(i == 0 ? 1.0 : 0.0), step(len, vec4(0.15)));
    w *= max(0.0, 1.0 + (bias - 0.5) * 2.0 * x / max(reach, 1.0e-3));
    vec4 c;
    if (perChannel) {
      vec4 cr = sbs_tex(t, uv + px * (x + shift.r), mode);
      vec4 cg = sbs_tex(t, uv + px * (x + shift.g), mode);
      vec4 cb = sbs_tex(t, uv + px * (x + shift.b), mode);
      c = vec4(cr.r, cg.g, cb.b, cg.a);
    } else {
      c = sbs_tex(t, uv + px * (x + shift.g), mode);
    }
    sum += c * w;
    wsum += w;
  }
  return sum / max(wsum, vec4(1.0e-6));
}
`,
};

export const S_BLUR_DIRECTIONAL = defineShaderEffect({
	id: 'jasper.s.blur-directional',
	label: 'S_BlurDirectional',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Blurs along an angle with a box, triangle or gaussian filter; Shift moves the image along the blur, Bias makes streaks trail in one direction, and each colour channel can blur and shift by its own amount.',
	keywords: ['directional blur', 'motion blur', 'streak', 'smear', 'linear blur', 'sapphire'],
	params: [
		sSize('blurAmount', 'Blur Amount', 0.4, 4),
		fxParam.angle('angle', 'Angle', 45),
		sNum('shift', 'Shift', 0, { softMin: -2, softMax: 2, step: 0.001 }),
		fxParam.number('bias', 'Bias', 0.5, { min: 0, max: 1, step: 0.01 }, { ui: { control: 'slider' } }),
		sSize('blurRed', 'Blur Red', 1, 4),
		sSize('blurGreen', 'Blur Green', 1, 4),
		sSize('blurBlue', 'Blur Blue', 1, 4),
		sNum('shiftRed', 'Shift Red', 0, { softMin: -2, softMax: 2, step: 0.001 }),
		sNum('shiftGreen', 'Shift Green', 0, { softMin: -2, softMax: 2, step: 0.001 }),
		sNum('shiftBlue', 'Shift Blue', 0, { softMin: -2, softMax: 2, step: 0.001 }),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2 }),
		sMix(),
		sFilter('box'),
		sEdgeMode('reflect'),
		sSoftBorders(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => {
			if (!bool(p.softBorders)) return 0;
			const m = Math.max(num(p.blurRed, 1), num(p.blurGreen, 1), num(p.blurBlue, 1));
			const sh = Math.max(Math.abs(num(p.shiftRed)), Math.abs(num(p.shiftGreen)), Math.abs(num(p.shiftBlue)));
			return (
				(num(p.blurAmount, 0.4) * m * 1.8 + Math.abs(num(p.shift)) + sh) * DIR_PER_UNIT * unitLayerPx(ctx)
			);
		},
		uniforms: (p, ctx) => {
			const u = unitPx(ctx) * DIR_PER_UNIT;
			const a = (num(p.angle, 45) * Math.PI) / 180;
			const amt = Math.max(0, num(p.blurAmount, 0.4));
			const len = [num(p.blurRed, 1), num(p.blurGreen, 1), num(p.blurBlue, 1)].map(
				(x) => Math.max(0, x) * amt * u,
			);
			const sh = num(p.shift);
			const shifts = [num(p.shiftRed), num(p.shiftGreen), num(p.shiftBlue)].map((x) => (x + sh) * u);
			const per =
				len[0] !== len[1] || len[1] !== len[2] || shifts[0] !== shifts[1] || shifts[1] !== shifts[2];
			return {
				u_sbsEdge: { int: edgeOf(p) },
				u_dDir: [Math.cos(a), Math.sin(a)],
				u_dLen: [len[0]!, len[1]!, len[2]!, len[1]!],
				u_dShift: [shifts[0]!, shifts[1]!, shifts[2]!, shifts[1]!],
				u_dPer: per,
			} as Record<string, FxUniformValue>;
		},
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const lmax =
				Math.max(0, num(p.blurAmount, 0.4)) *
				Math.max(num(p.blurRed, 1), num(p.blurGreen, 1), num(p.blurBlue, 1)) *
				unitPx(ctx) *
				DIR_PER_UNIT;
			// Long blurs: a short gaussian along the direction first fills the gaps between the strided taps.
			const stride = (lmax * 1.8) / 64;
			let tex = 'source';
			if (stride > 1.2) {
				plan.pass({
					output: 'pre',
					include: [GLSL_SBS_COMMON],
					format: 'rgba16f',
					uniforms: { u_preSigma: stride * 0.6 },
					frag: 'void main() { fragColor = sbs_blur1d(u_source, v_uv, u_dDir, u_preSigma, 2, u_sbsEdge); }',
				});
				tex = 'pre';
			}
			plan.pass({
				include: [GLSL_SBS_DIRECTIONAL, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 b = fx_unpremultiply(sbs_dirBlur(u_${tex}, v_uv, u_dDir, u_dLen, u_dShift, u_filter, u_bias, u_sbsEdge, u_dPer));
  vec3 c = sbs_offsetDarks(b.rgb * u_brightness, u_offsetDarks);
  vec4 result = vec4(max(c, 0.0) * b.a, b.a);
  if (!sbs_keep(v_uv, u_sbsEdge)) result = vec4(0.0);
  fragColor = fx_mixOriginal(result, src, u_mixWithOriginal);
}`,
			});
			return plan.passes;
		},
	},
});

// ---------------------------------------------------------------- transform path (BlurMotion, BlurMoCurves)

/** One Sapphire transformation: Z Dist (zoom about the centre), Rotate (deg), Shift (Sapphire units). */
export type MoTransform = { zDist: number; rotate: number; shift: readonly [number, number] };

/** GLSL: inverse transform of a layer-px point; sampling with per-axis wrap; the path gather. */
const GLSL_SBS_MOTION: GlslChunk = {
	name: 'sapphire-blur-sharpen/motion',
	deps: [GLSL_SBS_COMMON],
	source: /* glsl */ `
// T(x) = c + R(rot) (x - c) / z + shift  →  T^-1(y) = c + z R(-rot) (y - c - shift). p = (log z, rot rad, shift px).
vec2 sbs_moInverse(vec4 p, vec2 y) {
  vec2 d = y - u_moCenter - p.zw;
  float c = cos(-p.y), s = sin(-p.y);
  return u_moCenter + exp(p.x) * vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}
vec2 sbs_moForward(vec4 p, vec2 x) {
  vec2 d = (x - u_moCenter) / exp(p.x);
  float c = cos(p.y), s = sin(p.y);
  return u_moCenter + vec2(c * d.x - s * d.y, s * d.x + c * d.y) + p.zw;
}
float sbs_wrap1(float v, int mode, out bool outside) {
  outside = false;
  if (mode == 1) return fract(v);
  if (mode == 2) { float m = mod(v, 2.0); return m > 1.0 ? 2.0 - m : m; }
  outside = v < 0.0 || v > 1.0;
  return v;
}
vec4 sbs_moSample(sampler2D t, vec2 layerPx) {
  vec2 n = layerPx * u_pxScale / u_box.zw;
  bool ox, oy;
  n.x = sbs_wrap1(n.x, int(u_moWrap.x), ox);
  n.y = sbs_wrap1(n.y, int(u_moWrap.y), oy);
  if (ox || oy) return vec4(0.0);
  return texture(t, sbs_uvOfNorm(n));
}
// S_BlurMoCurves: the transform at shutter time s (0..1) between the key transforms of its animation curves at exact
// sub-frame times (u_moKeys: ${FX_MB_KEYS} keys over the shutter), so eases and curved paths blur along their real path.
vec4 sbs_moKey(float s) {
  float u = clamp(s, 0.0, 1.0) * ${(FX_MB_KEYS - 1).toFixed(1)};
  int k = min(int(u), ${FX_MB_KEYS - 2});
  return mix(u_moKeys[k], u_moKeys[k + 1], u - float(k));
}
// Exposure-weighted average of the source along the path From → To (n samples), optionally re-applying the
// current transform (Blur Only keeps the picture in place).
vec4 sbs_moPath(sampler2D t, vec2 y) {
  int n = int(clamp(u_moCount, 1.0, 128.0));
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 128; i++) {
    if (i >= n) break;
    float s = n == 1 ? 0.5 : float(i) / float(n - 1);
    vec4 p = u_moSpline ? sbs_moKey(s) : mix(u_moFrom, u_moTo, s);
    vec2 x = sbs_moInverse(p, y);
    if (u_moBlurOnly) x = sbs_moForward(u_moNow, x);
    float w = max(0.0, 1.0 + (u_moBias - 0.5) * 2.0 * (2.0 * s - 1.0));
    sum += sbs_moSample(t, x) * w;
    wsum += w;
  }
  return sum / max(wsum, 1.0e-6);
}
`,
};

const toVec = (t: MoTransform, ctx: FxPlanContext): [number, number, number, number] => {
	const u = unitLayerPx(ctx);
	return [Math.log(Math.max(0.001, t.zDist)), (t.rotate * Math.PI) / 180, t.shift[0] * u, t.shift[1] * u];
};

/** Longest displacement (layer px) of the box corners and centre between From and To (sample count). */
export function moPathLength(
	from: MoTransform,
	to: MoTransform,
	center: readonly [number, number],
	ctx: FxPlanContext,
): number {
	const c: [number, number] = [center[0] * ctx.width, center[1] * ctx.height];
	const inv = (t: MoTransform, y: [number, number]): [number, number] => {
		const [lz, r, sx, sy] = toVec(t, ctx);
		const dx = y[0] - c[0] - sx;
		const dy = y[1] - c[1] - sy;
		const z = Math.exp(lz);
		return [
			c[0] + z * (Math.cos(-r) * dx - Math.sin(-r) * dy),
			c[1] + z * (Math.sin(-r) * dx + Math.cos(-r) * dy),
		];
	};
	const lerp = (s: number): MoTransform => ({
		zDist: Math.exp(
			(1 - s) * Math.log(Math.max(0.001, from.zDist)) + s * Math.log(Math.max(0.001, to.zDist)),
		),
		rotate: from.rotate + (to.rotate - from.rotate) * s,
		shift: [
			from.shift[0] + (to.shift[0] - from.shift[0]) * s,
			from.shift[1] + (to.shift[1] - from.shift[1]) * s,
		],
	});
	let best = 0;
	const pts: [number, number][] = [
		[0, 0],
		[ctx.width, 0],
		[0, ctx.height],
		[ctx.width, ctx.height],
		[ctx.width / 2, ctx.height / 2],
	];
	for (const y of pts) {
		let len = 0;
		let prev = inv(lerp(0), y);
		for (let k = 1; k <= 8; k++) {
			const q = inv(lerp(k / 8), y);
			len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
			prev = q;
		}
		best = Math.max(best, len);
	}
	return best;
}

const BLUR_RES = ['full', 'half', 'quarter'] as const;
const MONO = ['color', 'mono'] as const;

/** Passes of a transform-path motion blur (Blur Res → pass scale). */
function moPasses(p: EffectParams, mono: boolean) {
	const k = choiceIndex(p.blurRes, BLUR_RES, 'full');
	const scale = 1 / 2 ** k;
	const passes = [];
	const body = (tex: string) => `sbs_moPath(${tex}, fx_layerPx())`;
	if (k > 0)
		passes.push({
			output: 'mo',
			include: [GLSL_SBS_MOTION],
			scale,
			format: 'rgba16f' as const,
			frag: `void main() { fragColor = ${body('u_source')}; }`,
		});
	passes.push({
		include: [GLSL_SBS_MOTION, GLSL_COMPOSITE],
		frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 b = ${k > 0 ? 'texture(u_mo, v_uv)' : body('u_source')};
  vec4 s = fx_unpremultiply(b);
  vec3 c = ${mono ? 'vec3(fx_luma(s.rgb))' : 's.rgb'} * u_brightness;
  vec4 result = vec4(max(c, 0.0) * s.a, s.a);
  if (sbs_outside(sbs_layerNorm(v_uv))) result = vec4(0.0);
  fragColor = fx_mixOriginal(result, src, u_mixWithOriginal);
}`,
	});
	return passes;
}

function moUniforms(
	p: EffectParams,
	ctx: FxFrameContext,
	from: MoTransform,
	to: MoTransform,
	now: MoTransform,
	blurOnly: boolean,
	/** Key transforms at `mbKeyTimes` (S_BlurMoCurves' animation over the shutter), or none: From → To linearly. */
	keys?: readonly MoTransform[],
): Record<string, FxUniformValue> {
	const center = vec2(p.center, [0.5, 0.5]);
	const k = choiceIndex(p.blurRes, BLUR_RES, 'full');
	const moving = keys?.some((t) => JSON.stringify(t) !== JSON.stringify(keys[0]));
	let path = moPathLength(from, to, center, ctx);
	if (keys && moving) {
		path = 0;
		for (let i = 0; i + 1 < keys.length; i++) path += moPathLength(keys[i]!, keys[i + 1]!, center, ctx);
	}
	const len = (path * ctx.pxScale) / 2 ** k;
	return {
		u_moSpline: !!(keys && moving),
		u_moKeys: { vec4s: keys && moving ? keys.flatMap((t) => toVec(t, ctx)) : new Array<number>(FX_MB_KEYS * 4).fill(0) },
		u_moCenter: [center[0] * ctx.width, center[1] * ctx.height],
		u_moFrom: toVec(from, ctx),
		u_moTo: toVec(to, ctx),
		u_moNow: toVec(now, ctx),
		u_moBlurOnly: blurOnly,
		u_moCount: Math.min(128, Math.max(1, Math.ceil(len / (bool(p.subpixel, true) ? 1 : 1.5)) + 1)),
		u_moBias: num(p.exposureBias, 0.5),
		u_moWrap: [choiceIndex(p.wrapX, SBS_WRAPS, 'no'), choiceIndex(p.wrapY, SBS_WRAPS, 'no')],
	};
}

const transformOf = (p: EffectParams, prefix: string, zDef: number): MoTransform => ({
	zDist: num(p[prefix ? `${prefix}ZDist` : 'zDist'], zDef),
	rotate: num(p[prefix ? `${prefix}Rotate` : 'rotate']),
	shift: vec2(p[prefix ? `${prefix}Shift` : 'shift'], [0, 0]),
});

const commonTail = [
	fxParam.number(
		'exposureBias',
		'Exposure Bias',
		0.5,
		{ min: 0, max: 1, step: 0.01 },
		{ ui: { control: 'slider' } },
	),
	sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
	sWrap('wrapX', 'Wrap X', 'no'),
	sWrap('wrapY', 'Wrap Y', 'no'),
	fxParam.choice('blurRes', 'Blur Res', BLUR_RES, ['Full', 'Half', 'Quarter'], 'full'),
	fxParam.toggle('subpixel', 'Subpixel', true),
];

// ---------------------------------------------------------------- S_BlurMotion

export const S_BLUR_MOTION = defineShaderEffect({
	id: 'jasper.s.blur-motion',
	label: 'S_BlurMotion',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Blurs along the path between a From and a To transformation (zoom, rotation, shift about a Center): radial zoom blurs, spin blurs, directional blurs or any mix.',
	keywords: ['motion blur', 'zoom blur', 'radial blur', 'spin blur', 'rotate blur', 'sapphire'],
	params: [
		fxParam.choice('effect', 'Effect', MONO, ['Blur Color', 'Blur Mono'], 'color'),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		sNum('fromZDist', 'From Z Dist', 1, { min: 0.001, softMax: 4, step: 0.001 }),
		fxParam.angle('fromRotate', 'From Rotate', 0),
		fxParam.vec2('fromShift', 'From Shift', [0, 0], { softMin: -2, softMax: 2, step: 0.001 }),
		sNum('toZDist', 'To Z Dist', 0.8, { min: 0.001, softMax: 4, step: 0.001 }),
		fxParam.angle('toRotate', 'To Rotate', 0),
		fxParam.vec2('toShift', 'To Shift', [0, 0], { softMin: -2, softMax: 2, step: 0.001 }),
		...commonTail,
		sMix(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => {
			const from = transformOf(p, 'from', 1);
			return moUniforms(p, ctx, from, transformOf(p, 'to', 0.8), from, false);
		},
		passes: (p) => moPasses(p, p.effect === 'mono'),
	},
});

// ---------------------------------------------------------------- S_BlurMoCurves

const MOC_EFFECT = ['transformAndBlur', 'blurOnly'] as const;

/**
 * Params of the instance at another clip-local frame: `FxFrameContext.paramsAt(frame)` (the framework evaluates the
 * clip's keyframes at fractional frames) lets S_BlurMoCurves read its animation curves over the shutter. Without it
 * (tests, catalogue checks) the path collapses to the current transform (no blur, the transform is still applied).
 */
type ParamsAtContext = FxFrameContext & { paramsAt?: (frame: number) => EffectParams };

export const S_BLUR_MO_CURVES = defineShaderEffect({
	id: 'jasper.s.blur-mo-curves',
	label: 'S_BlurMoCurves',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Transforms the clip with animated Z Dist, Rotate and Shift and motion-blurs it along that animation over the shutter interval (no blur when the curves are constant).',
	keywords: ['motion blur', 'curves', 'animated', 'shutter', 'transform', 'sapphire'],
	params: [
		fxParam.choice('effect', 'Effect', MOC_EFFECT, ['Transform and Blur', 'Blur Only'], 'transformAndBlur'),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		sNum('zDist', 'Z Dist', 1, { min: 0.001, softMax: 4, step: 0.001 }),
		fxParam.angle('rotate', 'Rotate', 0),
		fxParam.vec2('shift', 'Shift', [0, 0], { softMin: -2, softMax: 2, step: 0.001 }),
		sNum('shutterDuration', 'Shutter Duration', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('shutterShift', 'Shutter Shift', 0, { softMin: -2, softMax: 2, step: 0.01 }),
		...commonTail,
	],
	gpu: {
		uniforms: (p, ctx) => {
			const c = ctx as ParamsAtContext;
			const now = transformOf(p, '', 1);
			const dur = Math.max(0, num(p.shutterDuration, 1));
			const mid = ctx.frame + num(p.shutterShift);
			const at = (f: number): MoTransform => (c.paramsAt ? transformOf(c.paramsAt(f), '', 1) : now);
			const blurOnly = p.effect === 'blurOnly';
			// The animation curves at exact sub-frame times over the shutter (32 keys).
			const keys = dur > 0 ? mbKeyTimes(ctx.frame, centredShutter(dur, num(p.shutterShift))).map(at) : undefined;
			return {
				...moUniforms(p, ctx, at(mid - dur / 2), at(mid + dur / 2), now, blurOnly, keys),
				u_mixWithOriginal: 0,
			};
		},
		passes: (p) => moPasses(p, false),
	},
});

export const SBS_MOTION: readonly EffectSpec[] = [S_BLUR_DIRECTIONAL, S_BLUR_MOTION, S_BLUR_MO_CURVES];

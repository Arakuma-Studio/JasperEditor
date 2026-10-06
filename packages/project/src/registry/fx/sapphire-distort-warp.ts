// Effect family "sapphire-distort-warp" (fx catalogue, wave 2). Sapphire-style distortions: warps, ripples,
// displacement, lens distortion, shake. Video Effects ▸ Sapphire Distort ▸ S_*.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. Family-private GLSL and maths: ./sapphire-distort-warp/.
//
// Conventions shared by the whole family (see sapphire-distort-warp/glsl.ts):
// - Parameter names, order, ranges and defaults follow Boris FX Sapphire's documentation. Sapphire's Mocha, Mask
//   and Crop blocks and its on-screen-widget toggles are not reproduced (Premiere masks and Crop do that job here).
// - Positions are `point` params normalised to the layer box (the editor's convention, draggable in the Program
//   monitor); Sapphire's centre-relative [0 0] becomes [0.5 0.5]. Shifts are in frame widths, y down. Angles are
//   degrees, clockwise on screen (the editor's convention; Sapphire's turn counter-clockwise).
// - Radii are in units of half the smaller layer side (`dw_unit`); frequencies in waves per frame width.
// - "Wrap" (No / Tile / Reflect) is a pair of popups (Wrap X, Wrap Y) where Sapphire has one x/y popup.
// - "Filter" switches the adaptive supersampling (antialiased minifying warps, folds and hard edges).
import type { EffectParams, EffectSpec, ParamSpec } from '../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS, type ShaderEffectInit } from './define.ts';
import { GLSL_HASH } from './glsl/hash.ts';
import { GLSL_MB_POSES } from './glsl/motion-blur.ts';
import { GLSL_NOISE } from './glsl/noise.ts';
import {
	centredShutter,
	type MbPlan,
	mbKeyTimes,
	mbQualityParam,
	mbStaticPlan,
	mbUniforms,
	planMotionBlur,
} from './motion-blur.ts';
import { fxParam, seedParam } from './params.ts';
import { gaussianBlurPasses } from './passes.ts';
import {
	DW_WRAP_LABELS,
	DW_WRAP_OPTIONS,
	GLSL_DW,
	GLSL_DW_LENS,
	GLSL_DW_RENDER,
	GLSL_DW_SPECTRAL,
} from './sapphire-distort-warp/glsl.ts';
import {
	boundsPadding,
	cornerPinInverse,
	MAT3_IDENTITY,
	mat3Invert,
	mat3ToGlsl,
	normToFrame,
	type ShakeParams,
	type ShakePose,
	type ShakeStyle,
	shakePose,
	transformedBounds,
	warpTransformForward,
} from './sapphire-distort-warp/math.ts';
import type { FxPlanContext, ShaderPass } from './shader.ts';

// ---------------------------------------------------------------- helpers

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d = false) => (typeof v === 'boolean' ? v : d);
const vec2 = (v: unknown, d: readonly [number, number]): [number, number] =>
	Array.isArray(v) && v.length === 2 ? [num(v[0], d[0]), num(v[1], d[1])] : [d[0], d[1]];
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

/** Displacement (frame widths) per unit of Amount × lens gradient (luminance per frame width). */
export const DW_DISTORT_UNIT = 0.0025;
/** Blur length (frame widths) per unit of Blur Amount × lens gradient (S_DistortBlur). */
export const DW_DISTORT_BLUR_UNIT = 0.004;
/** Lens blur sigma (frame widths) per unit of Blur Lens / Smoothness. */
export const DW_LENS_BLUR_UNIT = 0.02;
/** Wave displacement (frame widths) = Amplitude × DW_WAVE_UNIT / Frequency (constant steepness across frequencies). */
export const DW_WAVE_UNIT = 0.8;

type Wrap = (typeof DW_WRAP_OPTIONS)[number];
const wrapParams = (defX: Wrap = 'reflect', defY: Wrap = defX): ParamSpec[] => [
	fxParam.choice('wrapX', 'Wrap X', DW_WRAP_OPTIONS, DW_WRAP_LABELS, defX),
	fxParam.choice('wrapY', 'Wrap Y', DW_WRAP_OPTIONS, DW_WRAP_LABELS, defY),
];
const wrapParam = (def: Wrap) => fxParam.choice('wrap', 'Wrap', DW_WRAP_OPTIONS, DW_WRAP_LABELS, def);
const filterParam = (def = true) => fxParam.toggle('filter', 'Filter', def);
const zDistParam = (def = 1, name = 'zDist', label = 'Z Dist') =>
	fxParam.number(name, label, def, { min: 0.001, softMax: 5, step: 0.01 });
const amountParam = (name: string, label: string, def: number, softMax = 5, min?: number) =>
	fxParam.number(name, label, def, {
		...(min === undefined ? { softMin: -softMax } : { min }),
		softMax,
		step: 0.01,
	});
const shiftParam = (name: string, label: string, def: [number, number] = [0, 0]) =>
	fxParam.vec2(name, label, def, { softMin: -1, softMax: 1, step: 0.001 });
const relParam = (name: string, label: string, def: [number, number] = [1, 1]) =>
	fxParam.vec2(name, label, def, { min: 0, softMax: 2, step: 0.01 });
const radiusParam = (name: string, label: string, def: number, min?: number) =>
	fxParam.number(name, label, def, {
		...(min === undefined ? { softMin: 0 } : { min }),
		softMax: 2,
		step: 0.001,
	});
const countParam = (name: string, label: string, def: number, min: number, max: number) =>
	fxParam.number(name, label, def, { min, max, step: 1 });
const colorParams = (): ParamSpec[] => [
	fxParam.color('color1', 'Color1', [1, 0, 0, 1]),
	fxParam.color('color2', 'Color2', [0, 1, 0, 1]),
	fxParam.color('color3', 'Color3', [0, 0, 1, 1]),
];

const WRAP = 'ivec2(u_wrapX, u_wrapY)';
const WRAP1 = 'ivec2(u_wrap, u_wrap)';

/** A warp whose shade is one tap of the source at dw_warp(f). `body` defines dw_warp. */
function simpleWarp(body: string, opts: { wrap?: string; filter?: string; maxN?: number } = {}): string {
	return `${body}
vec4 dw_shade(vec2 f, ivec2 w) { return dw_tap(dw_warp(f), w); }
void main() { fragColor = dw_render(${opts.wrap ?? WRAP}, ${opts.filter ?? 'u_filter'}, ${opts.maxN ?? 4}); }`;
}

const distortEffect = (init: Omit<ShaderEffectInit, 'category' | 'bin'>) =>
	defineShaderEffect({ ...init, category: 'Distort', bin: SAPPHIRE_BINS.distort });

// ---------------------------------------------------------------- lens (S_Distort, S_DistortBlur, …, S_WarpPuff)

/**
 * Passes producing the blurred lens luminance `lensB` (half-float): the Lens media (stretched over the layer box)
 * when one is chosen, else the source's own luminance (premultiplied: transparent areas are dark).
 */
export function lensPasses(blur: number, ctx: FxPlanContext, media: boolean): ShaderPass[] {
	const sigma = Math.max(0, blur) * DW_LENS_BLUR_UNIT * ctx.width * ctx.pxScale;
	const pick = media
		? 'u_lens_size.x > 0.0 ? texture(u_lens, clamp(fx_layerNorm(), vec2(0.0), vec2(1.0))) : texture(u_source, v_uv)'
		: 'texture(u_source, v_uv)';
	return [
		{
			output: 'lensL',
			format: 'rgba16f',
			frag: `
void main() {
  vec4 c = ${pick};
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  fragColor = vec4(l, l, l, 1.0);
}`,
		},
		...gaussianBlurPasses({
			input: 'lensL',
			output: 'lensB',
			sigma,
			scale: sigma > 8 ? 0.5 : 1,
			format: 'rgba16f',
		}),
	];
}

const lensParam = () => fxParam.media('lens', 'Lens');
const blurLensParam = (name = 'blurLens', label = 'Blur Lens') =>
	fxParam.number(name, label, 0.4, { min: 0, softMax: 3, step: 0.01 });

// ---------------------------------------------------------------- S_Distort

export const S_DISTORT = distortEffect({
	id: 'jasper.s.distort',
	label: 'S_Distort',
	description:
		'Warps the clip by the brightness gradient of a Lens clip (or of its own luminance), like looking through glass shaped like the lens image.',
	keywords: ['displacement', 'displace', 'refraction', 'glass', 'lens', 'map'],
	params: [
		lensParam(),
		amountParam('amount', 'Amount', 1),
		fxParam.toggle('fine', 'Fine', false),
		blurLensParam(),
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		relParam('amountRel', 'Amount Rel'),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		uniforms: (p) => ({
			u_dispScale: num(p.amount, 1) * (bool(p.fine) ? 0.01 : 1) * DW_DISTORT_UNIT,
		}),
		passes: (p, ctx) => [
			...lensPasses(num(p.blurLens, 0.4), ctx, true),
			{
				include: [GLSL_DW_RENDER, GLSL_DW_LENS],
				frag: simpleWarp(`
vec2 dw_warp(vec2 f) { return f + u_dispScale * (dw_rot(u_rotateWarpDir) * dw_lensGrad(f)) * u_amountRel; }`),
			},
		],
	},
});

// ---------------------------------------------------------------- S_DistortBlur

export const S_DISTORT_BLUR = distortEffect({
	id: 'jasper.s.distort-blur',
	label: 'S_DistortBlur',
	description: 'Blurs the clip along the brightness gradient of a Lens clip (or of its own luminance).',
	keywords: ['directional blur', 'displacement', 'lens', 'smear'],
	expensive: true,
	params: [
		lensParam(),
		amountParam('blurAmount', 'Blur Amount', 1, 5, 0),
		amountParam('warpAmount', 'Warp Amount', 0),
		blurLensParam(),
		fxParam.angle('rotateBlurDir', 'Rotate Blur Dir', 0),
		relParam('amountRel', 'Amount Rel'),
		...wrapParams('reflect'),
		fxParam.toggle('subpixel', 'Subpixel', true),
	],
	gpu: {
		uniforms: (p) => ({
			u_blurScale: Math.max(0, num(p.blurAmount, 1)) * DW_DISTORT_BLUR_UNIT,
			u_warpScale: num(p.warpAmount) * DW_DISTORT_UNIT,
		}),
		passes: (p, ctx) => [
			...lensPasses(num(p.blurLens, 0.4), ctx, true),
			{
				include: [GLSL_DW_RENDER, GLSL_DW_LENS],
				frag: /* glsl */ `
vec2 db_dir(vec2 f) { return (dw_rot(u_rotateBlurDir) * dw_lensGrad(f)) * u_amountRel; }
vec2 dw_warp(vec2 f) { return f + u_warpScale * db_dir(f); }
vec4 dw_shade(vec2 f, ivec2 w) {
  vec2 g = db_dir(f);
  vec2 c = f + u_warpScale * g;
  vec2 len = u_blurScale * g;
  float n = clamp(ceil(length(len) / dw_px()), 1.0, 48.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    if (float(i) >= n) break;
    float t = n > 1.0 ? float(i) / (n - 1.0) - 0.5 : 0.0;
    acc += dw_tap(c + len * t, w);
  }
  return acc / n;
}
void main() { fragColor = dw_render(${WRAP}, u_subpixel, 2); }`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_DistortChroma

export const S_DISTORT_CHROMA = distortEffect({
	id: 'jasper.s.distort-chroma',
	label: 'S_DistortChroma',
	description:
		'Warps the clip by different amounts across a colour spectrum using the Lens gradient: prism-like colour fringes.',
	keywords: ['prism', 'chromatic aberration', 'dispersion', 'rainbow', 'lens'],
	expensive: true,
	params: [
		lensParam(),
		amountParam('amount', 'Amount', 1),
		blurLensParam(),
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		amountParam('warpRed', 'Warp Red', 0.5),
		amountParam('warpBlue', 'Warp Blue', 1),
		countParam('steps', 'Steps', 8, 3, 100),
		...colorParams(),
		fxParam.toggle('whiteBalance', 'White Balance', false),
		relParam('amountRel', 'Amount Rel'),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		uniforms: (p) => ({ u_dispScale: num(p.amount, 1) * DW_DISTORT_UNIT }),
		passes: (p, ctx) => [
			...lensPasses(num(p.blurLens, 0.4), ctx, true),
			{
				include: [GLSL_DW_RENDER, GLSL_DW_LENS, GLSL_DW_SPECTRAL],
				frag: /* glsl */ `
vec2 dc_disp(vec2 f) { return u_dispScale * (dw_rot(u_rotateWarpDir) * dw_lensGrad(f)) * u_amountRel; }
vec2 dw_warp(vec2 f) { return f + dc_disp(f) * max(abs(u_warpRed), abs(u_warpBlue)); }
vec4 dw_spectralTap(vec2 f, float t, ivec2 w) { return dw_tap(f + dc_disp(f) * mix(u_warpRed, u_warpBlue, t), w); }
vec4 dw_shade(vec2 f, ivec2 w) {
  int n = int(clamp(floor(u_steps + 0.5), 3.0, 100.0));
  vec4 c = dw_spectral(f, w, n, u_color1.rgb, u_color2.rgb, u_color3.rgb, u_whiteBalance);
  return vec4(min(c.rgb, vec3(c.a)), c.a);
}
void main() { fragColor = dw_render(${WRAP}, u_filter, 2); }`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_DistortRGB

export const S_DISTORT_RGB = distortEffect({
	id: 'jasper.s.distort-rgb',
	label: 'S_DistortRGB',
	description:
		'Warps the red, green and blue channels by different amounts using the Lens gradient, separating them into an RGB fringe.',
	keywords: ['rgb split', 'chromatic aberration', 'channel', 'displacement', 'lens'],
	params: [
		lensParam(),
		amountParam('amount', 'Amount', 1),
		blurLensParam(),
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		amountParam('warpRed', 'Warp Red', 0.5),
		amountParam('warpGreen', 'Warp Green', 0.75),
		amountParam('warpBlue', 'Warp Blue', 1),
		relParam('amountRel', 'Amount Rel'),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		uniforms: (p) => ({ u_dispScale: num(p.amount, 1) * DW_DISTORT_UNIT }),
		passes: (p, ctx) => [
			...lensPasses(num(p.blurLens, 0.4), ctx, true),
			{
				include: [GLSL_DW_RENDER, GLSL_DW_LENS],
				frag: /* glsl */ `
vec2 dr_disp(vec2 f) { return u_dispScale * (dw_rot(u_rotateWarpDir) * dw_lensGrad(f)) * u_amountRel; }
vec2 dw_warp(vec2 f) { return f + dr_disp(f) * max(abs(u_warpRed), max(abs(u_warpGreen), abs(u_warpBlue))); }
vec4 dw_shade(vec2 f, ivec2 w) {
  vec2 d = dr_disp(f);
  vec4 r = dw_tap(f + d * u_warpRed, w);
  vec4 g = dw_tap(f + d * u_warpGreen, w);
  vec4 b = dw_tap(f + d * u_warpBlue, w);
  return vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a)));
}
void main() { fragColor = dw_render(${WRAP}, u_filter, 3); }`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_InfiniteZoom

const SPIRAL_OPTIONS = ['none', 'cw1', 'ccw1', 'cw2', 'ccw2'] as const;
const SPIRAL_STRANDS: Record<string, number> = { none: 0, cw1: -1, ccw1: 1, cw2: -2, ccw2: 2 };

export const S_INFINITE_ZOOM = distortEffect({
	id: 'jasper.s.infinite-zoom',
	label: 'S_InfiniteZoom',
	description:
		'Zooms endlessly into nested copies of the clip (Droste effect); transparent areas show the next copy. Animate Zoom.',
	keywords: ['droste', 'escher', 'recursive', 'spiral', 'zoom', 'loop'],
	expensive: true,
	params: [
		fxParam.choice(
			'transparentArea',
			'Transparent Area',
			['inside', 'outside'],
			['Inside', 'Outside'],
			'outside',
		),
		fxParam.number('shrinkPerLevel', 'Shrink Per Level', 0.5, { min: 0.001, max: 0.9, step: 0.001 }),
		fxParam.number('zoom', 'Zoom', 1, { min: 0.001, softMax: 16, step: 0.01 }),
		fxParam.point('zoomCenter', 'Zoom Center', [0.5, 0.5]),
		fxParam.number('twist', 'Twist', 0, { min: -5, softMax: 5, step: 0.01 }),
		fxParam.choice(
			'spiralStrands',
			'Spiral Strands',
			SPIRAL_OPTIONS,
			['No Spiral', '1 Clockwise', '1 Counterclockwise', '2 Clockwise', '2 Counterclockwise'],
			'ccw1',
		),
		fxParam.angle('rotate', 'Rotate', 0),
		shiftParam('shift', 'Shift'),
		wrapParam('no'),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => {
			const s = Math.min(0.9, Math.max(0.001, num(p.shrinkPerLevel, 0.5)));
			const L = -Math.log(s);
			const m = Math.log(Math.max(1e-3, num(p.zoom, 1))) / L;
			return {
				u_izL: L,
				u_izLevel: Math.floor(m),
				u_izFrac: m - Math.floor(m),
				u_izStrands: SPIRAL_STRANDS[str(p.spiralStrands, 'ccw1')] ?? 1,
			};
		},
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: /* glsl */ `
// The straight (non-spiral) Droste coordinate of output f, relative to the zoom centre, for level index 0 at the
// fractional zoom (the integer part of the zoom is the level offset u_izLevel).
vec2 iz_q(vec2 f) {
  vec2 c = dw_frameOfNorm(u_zoomCenter);
  vec2 p = dw_rot(-u_rotate) * (f - c - u_shift);
  if (u_izStrands != 0.0) {
    // Escher/Droste spiral: log-polar shear so that one turn joins |n| levels.
    vec2 w = vec2(log(max(length(p), 1e-12)), atan(p.y, p.x));
    float g = -u_izStrands * u_izL / DW_TAU;
    vec2 ws = vec2(w.x - w.y * g, w.x * g + w.y);
    p = exp(ws.x) * vec2(cos(ws.y), sin(ws.y));
  }
  return p * exp(-u_izFrac * u_izL);
}
float iz_reach(vec2 c) {
  vec2 h = vec2(0.5, 0.5 * dw_aspect());
  return length(abs(c) + h);
}
vec2 iz_src(vec2 q, float k) {
  vec2 c = dw_frameOfNorm(u_zoomCenter);
  return c + dw_rot(-degrees((k + u_izLevel) * u_twist)) * q * exp(k * u_izL);
}
// Footprint estimate: the front level's mapping.
vec2 dw_warp(vec2 f) {
  vec2 q = iz_q(f);
  float r = max(length(q), 1e-12);
  float kf = u_transparentArea == 1 ? floor(log(iz_reach(dw_frameOfNorm(u_zoomCenter)) / r) / u_izL) : 0.0;
  return iz_src(q, kf);
}
vec4 dw_shade(vec2 f, ivec2 w) {
  vec2 q = iz_q(f);
  float r = max(length(q), 1e-12);
  float kf = floor(log(iz_reach(dw_frameOfNorm(u_zoomCenter)) / r) / u_izL);
  vec4 acc = vec4(0.0);
  if (u_transparentArea == 1) {
    // Outside: smaller copies sit in front. Start at the smallest copy that can still cover f.
    for (int i = 0; i < 48; i++) {
      vec4 c = dw_tap(iz_src(q, kf - float(i)), w);
      acc += (1.0 - acc.a) * c;
      if (acc.a > 0.996) break;
    }
  } else {
    // Inside: the copies go inside the transparent centre, larger copies in front.
    for (int i = 0; i < 48; i++) {
      float k = float(i);
      if (k > kf) break;
      vec4 c = dw_tap(iz_src(q, k), w);
      acc += (1.0 - acc.a) * c;
      if (acc.a > 0.996) break;
    }
  }
  return acc;
}
void main() { fragColor = dw_render(${WRAP1}, true, 3); }`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_ParallaxStrips

export const S_PARALLAX_STRIPS = distortEffect({
	id: 'jasper.s.parallax-strips',
	label: 'S_ParallaxStrips',
	description:
		'Cuts the clip into sliding 3D glass strips that offset the image inside them, then fades to the clean source.',
	keywords: ['strips', 'slices', 'glass', 'parallax', 'transition', 'glitch'],
	expensive: true,
	params: [
		fxParam.choice('mode', 'Mode', ['automatic', 'manual'], ['Automatic', 'Manual'], 'automatic'),
		fxParam.number('manualAmount', 'Manual Amount', 1, { min: 0, softMax: 2, step: 0.01 }),
		countParam('nStrips', 'N Strips', 50, 1, 1000),
		fxParam.number('size', 'Size', 0.35, { min: 0, softMax: 2, step: 0.001 }),
		fxParam.number('relHeight', 'Rel Height', 0.3, { min: 0.001, softMax: 2, step: 0.001 }),
		fxParam.vec2('sizeVary', 'Size Vary', [0.1, 0.1], { min: 0, max: 1, step: 0.01 }),
		fxParam.angle('angle', 'Angle', 0),
		fxParam.number('depth', 'Depth', 2, { min: 0, softMax: 10, step: 0.01 }),
		amountParam('stripSpeed', 'Strip Speed', 0.4, 2),
		fxParam.number('stripSpeedVary', 'Strip Speed Vary', 0, { min: 0, softMax: 2, step: 0.01 }),
		amountParam('shiftAmount', 'Shift Amount', 0.6, 2),
		fxParam.number('shiftVary', 'Shift Vary', 0, { min: 0, softMax: 2, step: 0.01 }),
		shiftParam('allStripsShift', 'All Strips Shift'),
		zDistParam(),
		fxParam.choice(
			'show',
			'Show',
			['result', 'stripsOverSource', 'stripsOverBlack'],
			['Result', 'Strips Over Source', 'Strips Over Black'],
			'result',
		),
		fxParam.number('slowFade', 'Slow Fade', 0.9, { min: 0, max: 2, step: 0.01 }),
		fxParam.toggle('fullHeight', 'Full Height', false),
		fxParam.choice('fade', 'Fade', ['start', 'end'], ['Start', 'End'], 'end'),
		wrapParam('reflect'),
		{ ...seedParam(0.123), range: { min: 0, softMax: 10, step: 0.001 } },
	],
	gpu: {
		uniforms: (p, ctx) => ({ u_psAmount: parallaxAmount(p, ctx.frame, ctx.duration) }),
		passes: [
			{
				include: [GLSL_DW, GLSL_HASH],
				frag: /* glsl */ `
// Per-strip random numbers: a PCG chain seeded by (strip, u_seed) — cheaper than independent lattice hashes.
float ps_next(inout uint st) { st = fx_pcg(st); return float(st >> 8u) * (1.0 / 16777216.0); }
// The front-most strip covering f: its index (−1 = none), the source position, the strip depth (0 far, 1 near),
// the distance from f to that strip's border (frame units) and the border's outward normal.
int ps_front(vec2 f, out vec2 src, out float depth, out float edge, out vec2 nrm) {
  float ang = radians(u_angle);
  vec2 ax = vec2(cos(ang), sin(ang));
  vec2 nx = vec2(-ax.y, ax.x);
  // The frame's extent along and across the strips (strips are scattered over it and wrap around along it).
  float extA = abs(ax.x) + abs(ax.y) * dw_aspect();
  float extN = abs(nx.x) + abs(nx.y) * dw_aspect();
  vec2 all2 = vec2(dot(u_allStripsShift, ax), dot(u_allStripsShift, nx));
  vec2 g = vec2(dot(f, ax), dot(f, nx));
  int best = -1;
  depth = -1.0;
  edge = 1.0e3;
  nrm = ax;
  src = f;
  int n = int(clamp(floor(u_nStrips + 0.5), 1.0, 1000.0));
  uint seedBits = fx_pcg(fx_seedBits(u_seed));
  for (int i = 0; i < 1000; i++) {
    if (i >= n) break;
    uint st = fx_pcg(uint(i) * 2654435761u ^ seedBits);
    float z = ps_next(st);
    if (z <= depth) continue;
    vec3 h = vec3(z, ps_next(st), ps_next(st));
    float sc = (1.0 + u_depth * z) / (1.0 + 0.5 * u_depth);
    vec3 v = vec3(ps_next(st), ps_next(st), ps_next(st)) * 2.0 - 1.0;
    float wdt = u_size * sc * max(0.0, 1.0 + u_sizeVary.x * v.x);
    float hgt = u_fullHeight ? 1.0e3 : wdt * u_relHeight * max(0.0, 1.0 + u_sizeVary.y * v.y);
    float speed = u_stripSpeed * sc * (1.0 + u_stripSpeedVary * v.z);
    float period = extA + wdt;
    float along = (h.y - 0.5) * period + speed * u_time + all2.x;
    along = mod(along + 0.5 * period, period) - 0.5 * period;
    float across = (h.z - 0.5) * (extN + min(hgt, extN)) + all2.y;
    vec2 q = g - vec2(along, across);
    vec2 inside = vec2(0.5 * wdt, 0.5 * hgt) - abs(q);
    if (inside.x >= 0.0 && inside.y >= 0.0) {
      best = i;
      depth = z;
      edge = min(inside.x, inside.y);
      nrm = inside.x < inside.y ? ax * sign(q.x + 1e-9) : nx * sign(q.y + 1e-9);
      vec2 r = vec2(ps_next(st), ps_next(st));
      float sgn = r.x < 0.5 ? -1.0 : 1.0;
      float shift = u_shiftAmount * wdt * max(0.0, 1.0 + u_shiftVary * (2.0 * r.y - 1.0)) * u_psAmount * sgn;
      src = f + ax * shift;
    }
  }
  src *= u_zDist;
  return best;
}
vec4 ps_color(int i, vec2 f, vec2 s, float d, ivec2 w) {
  if (u_show == 0) return dw_tap(s, w);
  vec4 under = u_show == 1 ? dw_tap(f * u_zDist, w) : vec4(0.0, 0.0, 0.0, 1.0);
  return i < 0 ? under : vec4(vec3(0.25 + 0.75 * d), 1.0);
}
void main() {
  // Analytic antialiasing: one strip search per pixel; a second one just across the border for border pixels
  // (a loop, so the search is compiled once).
  vec2 f = dw_frame();
  ivec2 w = dw_wrapAt(f, ${WRAP1});
  float px = dw_px();
  vec2 at = f;
  vec4 c = vec4(0.0);
  float cov = 1.0;
  for (int k = 0; k < 2; k++) {
    vec2 s, nrm;
    float d, e;
    int i = ps_front(at, s, d, e, nrm);
    if (k == 0) {
      c = ps_color(i, f, s, d, w);
      if (i < 0 || e >= 0.5 * px) break;
      cov = clamp(0.5 + e / px, 0.0, 1.0);
      at = f + nrm * (e + 0.75 * px);
    } else {
      // The neighbour's content at this pixel's own position (its image shifts with it).
      vec4 c2 = u_show == 0 ? dw_tap(i < 0 ? f * u_zDist : s + (f - at) * u_zDist, w) : ps_color(i, at, s, d, w);
      c = mix(c2, c, cov);
    }
  }
  fragColor = c;
}`,
			},
		],
	},
});

/** S_ParallaxStrips strength at a frame: Manual Amount, or the automatic fade (Start: in, End: out). */
export function parallaxAmount(p: EffectParams, frame: number, duration: number): number {
	if (str(p.mode, 'automatic') === 'manual') return Math.max(0, num(p.manualAmount, 1));
	const t = duration > 1 ? Math.min(1, Math.max(0, frame / (duration - 1))) : 0;
	const ease = (x: number) => x ** (1 + 2 * Math.max(0, num(p.slowFade, 0.9)));
	return str(p.fade, 'end') === 'start' ? 1 - ease(1 - t) : 1 - ease(t);
}

// ---------------------------------------------------------------- S_WarpBubble / S_WarpBubble2

const BUBBLE_GLSL = /* glsl */ `
// Bubble noise: two fbm fields → a displacement of about ±amp / freq frame widths.
vec2 wb_bubble(vec2 f, float amp, float freq, float relX, float octaves, vec2 shift, float seed) {
  vec2 q = (f - shift) * freq * vec2(relX, 1.0);
  int o = int(clamp(floor(octaves + 0.5), 1.0, 10.0));
  vec2 n = vec2(fx_fbm(q, o, 2.0, 0.5, seed), fx_fbm(q + vec2(37.3, 11.9), o, 2.0, 0.5, fract(seed + 0.5)));
  return n * amp / max(freq, 0.01);
}`;

export const S_WARP_BUBBLE = distortEffect({
	id: 'jasper.s.warp-bubble',
	label: 'S_WarpBubble',
	description: 'Warps the clip with smooth, drifting noise: heat haze or underwater wobble.',
	keywords: ['noise', 'heat haze', 'wobble', 'underwater', 'turbulent displace'],
	params: [
		amountParam('amplitude', 'Amplitude', 0.25, 2),
		fxParam.number('frequency', 'Frequency', 16, { min: 0.01, softMax: 100, step: 0.1 }),
		fxParam.number('frequencyRelX', 'Frequency Rel X', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		countParam('octaves', 'Octaves', 1, 1, 10),
		{ ...seedParam(0.23), range: { min: 0, softMax: 10, step: 0.001 } },
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		shiftParam('shiftStart', 'Shift Start'),
		shiftParam('shiftSpeed', 'Shift Speed', [0.1, 0]),
		zDistParam(),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_DW_RENDER, GLSL_NOISE],
				frag: simpleWarp(`${BUBBLE_GLSL}
vec2 dw_warp(vec2 f) {
  vec2 fz = f * u_zDist;
  vec2 d = wb_bubble(fz, u_amplitude, u_frequency, u_frequencyRelX, u_octaves, u_shiftStart + u_shiftSpeed * u_time, u_seed);
  return fz + dw_rot(u_rotateWarpDir) * d;
}`),
			},
		],
	},
});

export const S_WARP_BUBBLE2 = distortEffect({
	id: 'jasper.s.warp-bubble2',
	label: 'S_WarpBubble2',
	description: 'Two overlapping bubble-noise warps (A and B), by default drifting in opposite directions.',
	keywords: ['noise', 'heat haze', 'wobble', 'underwater', 'turbulent displace'],
	params: [
		amountParam('aAmplitude', 'A Amplitude', 0.25, 2),
		fxParam.number('aFrequency', 'A Frequency', 4, { min: 0.01, softMax: 100, step: 0.1 }),
		countParam('aOctaves', 'A Octaves', 1, 1, 10),
		fxParam.number('aSeed', 'A Seed', 0.23, { min: 0, softMax: 10, step: 0.001 }, { animatable: false }),
		shiftParam('aShiftStart', 'A Shift Start'),
		shiftParam('aSpeed', 'A Speed', [0.1, 0]),
		amountParam('bAmplitude', 'B Amplitude', 0.25, 2),
		fxParam.number('bFrequency', 'B Frequency', 4, { min: 0.01, softMax: 100, step: 0.1 }),
		countParam('bOctaves', 'B Octaves', 1, 1, 10),
		fxParam.number('bSeed', 'B Seed', 0.34, { min: 0, softMax: 10, step: 0.001 }, { animatable: false }),
		shiftParam('bShiftStart', 'B Shift Start'),
		shiftParam('bSpeed', 'B Speed', [-0.1, 0]),
		zDistParam(),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_DW_RENDER, GLSL_NOISE],
				frag: simpleWarp(`${BUBBLE_GLSL}
vec2 dw_warp(vec2 f) {
  vec2 fz = f * u_zDist;
  vec2 a = wb_bubble(fz, u_aAmplitude, u_aFrequency, 1.0, u_aOctaves, u_aShiftStart + u_aSpeed * u_time, fract(u_seed + u_aSeed * 0.6180339887));
  vec2 b = wb_bubble(fz, u_bAmplitude, u_bFrequency, 1.0, u_bOctaves, u_bShiftStart + u_bSpeed * u_time, fract(u_seed + u_bSeed * 0.6180339887));
  return fz + a + b;
}`),
			},
		],
	},
});

// ---------------------------------------------------------------- S_WarpChroma / S_WarpRepeat (transform paths)

const PATH_GLSL = /* glsl */ `
// The transform at t (0 = From, 1 = To), scaled by Warp Amount: source frame position of output f.
vec2 wp_at(vec2 f, float t) {
  vec2 c = dw_frameOfNorm(u_center);
  float z = 1.0 + (mix(u_fromZDist, u_toZDist, t) - 1.0) * u_warpAmount;
  float r = mix(u_fromRotate, u_toRotate, t) * u_warpAmount;
  vec2 s = mix(u_fromShift, u_toShift, t) * u_warpAmount;
  return c + dw_rot(-r) * (f - c - s) * z;
}`;

const pathParams = (fromZ: number, steps: number, stepsMin: number): ParamSpec[] => [
	countParam('steps', 'Steps', steps, stepsMin, 100),
	fxParam.point('center', 'Center', [0.5, 0.5]),
	zDistParam(fromZ, 'fromZDist', 'From Z Dist'),
	fxParam.angle('fromRotate', 'From Rotate', 0),
	shiftParam('fromShift', 'From Shift'),
	zDistParam(1, 'toZDist', 'To Z Dist'),
	fxParam.angle('toRotate', 'To Rotate', 0),
	shiftParam('toShift', 'To Shift'),
];

export const S_WARP_CHROMA = distortEffect({
	id: 'jasper.s.warp-chroma',
	label: 'S_WarpChroma',
	description:
		'Splits the clip into spectral colour bands, each transformed between a From (red) and a To (blue) zoom/rotate/shift: a rainbow smear.',
	keywords: ['chromatic aberration', 'rainbow', 'prism', 'spectral', 'zoom'],
	expensive: true,
	params: [
		...pathParams(0.85, 15, 3),
		fxParam.number('warpAmount', 'Warp Amount', 0.5, { min: 0, softMax: 2, step: 0.01 }),
		fxParam.number('brightness', 'Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		...colorParams(),
		fxParam.toggle('whiteBalance', 'White Balance', false),
		...wrapParams('no'),
		filterParam(false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_DW_RENDER, GLSL_DW_SPECTRAL],
				frag: /* glsl */ `${PATH_GLSL}
vec2 dw_warp(vec2 f) { return wp_at(f, 0.0); }
vec4 dw_spectralTap(vec2 f, float t, ivec2 w) { return dw_tap(wp_at(f, t), w); }
vec4 dw_shade(vec2 f, ivec2 w) {
  int n = int(clamp(floor(u_steps + 0.5), 3.0, 100.0));
  vec4 c = dw_spectral(f, w, n, u_color1.rgb, u_color2.rgb, u_color3.rgb, u_whiteBalance);
  return vec4(min(c.rgb * u_brightness, vec3(c.a)), c.a);
}
void main() { fragColor = dw_render(${WRAP}, u_filter, 2); }`,
			},
		],
	},
});

export const S_WARP_REPEAT = distortEffect({
	id: 'jasper.s.warp-repeat',
	label: 'S_WarpRepeat',
	description:
		'Averages copies of the clip transformed along a path from a From to a To transform: zoom, rotate or streak trails.',
	keywords: ['echo', 'trail', 'zoom blur', 'repeat', 'streak'],
	params: [
		...pathParams(1.5, 3, 2),
		fxParam.number('warpAmount', 'Warp Amount', 1, { min: 0, softMax: 2, step: 0.01 }),
		fxParam.number('exposureBias', 'Exposure Bias', 0.5, { min: 0, max: 1, step: 0.01 }),
		...wrapParams('no'),
		filterParam(false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: /* glsl */ `${PATH_GLSL}
vec2 dw_warp(vec2 f) { return wp_at(f, 0.0); }
vec4 dw_shade(vec2 f, ivec2 w) {
  int n = int(clamp(floor(u_steps + 0.5), 2.0, 100.0));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 100; i++) {
    if (i >= n) break;
    float t = float(i) / float(n - 1);
    // Exposure Bias 0.5 = even weights; 0 favours the From end, 1 the To end.
    float wt = max(1e-4, 2.0 * mix(1.0 - t, t, u_exposureBias));
    acc += dw_tap(wp_at(f, t), w) * wt;
    wsum += wt;
  }
  return acc / wsum;
}
void main() { fragColor = dw_render(${WRAP}, u_filter, 2); }`,
			},
		],
	},
});

// ---------------------------------------------------------------- motion blur of keyframed warps

/** Motion Blur + Mo Blur Length (frames of shutter, centred on the frame) of the keyframed warps. */
const motionBlurParams = () => [
	fxParam.toggle('motionBlur', 'Motion Blur', false),
	fxParam.number('moBlurLength', 'Mo Blur Length', 1, { min: 0, softMax: 2, step: 0.01 }),
];

/**
 * The params at the key times of the keyframed-warp shutter (`mbKeyTimes`: FX_MB_KEYS over Mo Blur Length centred on
 * the frame), or null when there is no blur: Motion Blur off, a zero length, no `paramsAt`
 * (the host cannot evaluate other times) or `key` (the values that move the warp) identical at every key.
 */
export function warpShutterParams(
	p: EffectParams,
	ctx: { frame?: number; paramsAt?: (f: number) => EffectParams },
	key: (q: EffectParams) => string,
): EffectParams[] | null {
	const len = Math.max(0, num(p.moBlurLength, 1));
	if (!bool(p.motionBlur) || !(len > 0) || !ctx.paramsAt || ctx.frame === undefined) return null;
	const at = ctx.paramsAt;
	const qs = mbKeyTimes(ctx.frame, centredShutter(len)).map((f) => at(f));
	const k0 = key(qs[0]!);
	return qs.every((q) => key(q) === k0) ? null : qs;
}

/**
 * The adaptive shutter of a keyframed warp (S_WarpCornerPin, S_WarpPerspective): `planMotionBlur` over the params at
 * exact sub-frame times, with the warp's tracked points (canvas px) and pose packing.
 */
function warpShutterPlan(
	p: EffectParams,
	ctx: { frame?: number; paramsAt?: (f: number) => EffectParams },
	points: (q: EffectParams) => [number, number][],
	pack: (q: EffectParams) => number[],
	stride: number,
): MbPlan {
	const len = Math.max(0, num(p.moBlurLength, 1));
	const at = ctx.paramsAt;
	if (!bool(p.motionBlur) || !(len > 0) || !at || ctx.frame === undefined) return mbStaticPlan(stride);
	return planMotionBlur({
		frame: ctx.frame,
		window: centredShutter(len),
		poseAt: at,
		points,
		pack,
		stride,
		quality: p.mbQuality,
	});
}

// ---------------------------------------------------------------- S_WarpCornerPin

const cornerPoints = (p: EffectParams) => ({
	tl: vec2(p.topLeft, [0.1, 0.38]),
	tr: vec2(p.topRight, [0.69, 0]),
	bl: vec2(p.bottomLeft, [0.22, 0.89]),
	br: vec2(p.bottomRight, [0.81, 0.93]),
});
const cornerKey = (q: EffectParams) => JSON.stringify(cornerPoints(q));

/** Padding of the pinned quad (+ bulge) in layer px. */
function cornerPinPadding(p: EffectParams, ctx: { width: number; height: number }) {
	const c = cornerPoints(p);
	const xs = [c.tl[0], c.tr[0], c.bl[0], c.br[0]];
	const ys = [c.tl[1], c.tr[1], c.bl[1], c.br[1]];
	const b = vec2(p.bulge, [0, 0]);
	const bx = 0.25 * Math.abs(b[0]) * (Math.max(...xs) - Math.min(...xs));
	const by = 0.25 * Math.abs(b[1]) * (Math.max(...ys) - Math.min(...ys));
	return {
		left: Math.ceil(Math.max(0, -Math.min(...xs) + bx) * ctx.width),
		right: Math.ceil(Math.max(0, Math.max(...xs) - 1 + bx) * ctx.width),
		top: Math.ceil(Math.max(0, -Math.min(...ys) + by) * ctx.height),
		bottom: Math.ceil(Math.max(0, Math.max(...ys) - 1 + by) * ctx.height),
	};
}

export const S_WARP_CORNER_PIN = distortEffect({
	id: 'jasper.s.warp-corner-pin',
	label: 'S_WarpCornerPin',
	description:
		"A perspective warp that places the clip's four corners on four points (screens, billboards), with an optional bulge and motion blur of keyframed corners.",
	keywords: ['corner pin', 'perspective', 'four point', 'screen replacement', 'billboard'],
	params: [
		fxParam.point('topLeft', 'Top Left', [0.1, 0.38]),
		fxParam.point('topRight', 'Top Right', [0.69, 0]),
		fxParam.point('bottomLeft', 'Bottom Left', [0.22, 0.89]),
		fxParam.point('bottomRight', 'Bottom Right', [0.81, 0.93]),
		filterParam(),
		fxParam.vec2('bulge', 'Bulge', [0, 0], { min: -1, max: 1, step: 0.01 }),
		...wrapParams('no'),
		...motionBlurParams(),
		mbQualityParam(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => {
			// With motion blur: the union of the pinned quads over the shutter.
			const pads = (warpShutterParams(p, ctx, cornerKey) ?? [p]).map((q) => cornerPinPadding(q, ctx));
			return {
				left: Math.max(...pads.map((x) => x.left)),
				right: Math.max(...pads.map((x) => x.right)),
				top: Math.max(...pads.map((x) => x.top)),
				bottom: Math.max(...pads.map((x) => x.bottom)),
			};
		},
		uniforms: (p, ctx) => {
			const aspect = ctx.height / Math.max(1, ctx.width);
			const inv = cornerPinInverse(cornerPoints(p), aspect);
			// Motion blur: the inverse pins at the shutter's key times (3 vec4: column-major mat3 normalised so that
			// h.z = 1 at the quad's centre — consistent scales to interpolate — and a valid flag); taps from the travel
			// of the pinned corners and centre (canvas px).
			const px = ctx.pxScale;
			const plan = warpShutterPlan(
				p,
				ctx,
				(q) => {
					const c = cornerPoints(q);
					const pts = [c.tl, c.tr, c.br, c.bl];
					const m: [number, number] = [
						pts.reduce((sum, v) => sum + v[0], 0) / 4,
						pts.reduce((sum, v) => sum + v[1], 0) / 4,
					];
					return [...pts, m].map(([x, y]): [number, number] => [x * ctx.width * px, y * ctx.height * px]);
				},
				(q) => {
					const c = cornerPoints(q);
					const m = cornerPinInverse(c, aspect);
					if (!m) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
					const fc = [c.tl, c.tr, c.br, c.bl].map((v) => normToFrame(v, aspect));
					const cx = fc.reduce((sum, v) => sum + v[0], 0) / 4;
					const cy = fc.reduce((sum, v) => sum + v[1], 0) / 4;
					const w = m[6] * cx + m[7] * cy + m[8];
					const k = Math.abs(w) > 1e-9 ? 1 / w : 1;
					return [...mat3ToGlsl(m).map((v) => v * k), 1, 0, 0];
				},
				3,
			);
			return {
				u_cpInv: { mat3: mat3ToGlsl(inv ?? MAT3_IDENTITY) },
				u_cpValid: inv !== null,
				...mbUniforms(plan),
			};
		},
		passes: [
			{
				include: [GLSL_DW_RENDER, GLSL_MB_POSES],
				frag: /* glsl */ `
// Normalised source position (0..1 over the layer) of output f under inverse pin M; z < 0 = behind the plane.
vec3 cp_uvM(mat3 M, vec2 f) {
  vec3 h = M * vec3(f, 1.0);
  if (h.z <= 1e-6) return vec3(0.0, 0.0, -1.0);
  vec2 uv = h.xy / h.z;
  // Bulge: bows the edges outward (positive) or inward along each axis.
  uv.x = 0.5 + (uv.x - 0.5) / max(0.05, 1.0 + u_bulge.x * 2.0 * clamp(uv.y, 0.0, 1.0) * (1.0 - clamp(uv.y, 0.0, 1.0)));
  uv.y = 0.5 + (uv.y - 0.5) / max(0.05, 1.0 + u_bulge.y * 2.0 * clamp(uv.x, 0.0, 1.0) * (1.0 - clamp(uv.x, 0.0, 1.0)));
  return vec3(uv, 1.0);
}
vec3 cp_uv(vec2 f) { return cp_uvM(u_cpInv, f); }
vec2 dw_warp(vec2 f) { vec3 s = cp_uv(f); return dw_frameOfNorm(s.xy); }
vec4 dw_shade(vec2 f, ivec2 w) {
  vec3 s = cp_uv(f);
  if (!u_cpValid || s.z < 0.0) return vec4(0.0);
  // The pinned picture is the layer box only (not the padding of earlier effects).
  return dw_tap(dw_frameOfNorm(s.xy), w == ivec2(DW_NO) ? ivec2(DW_NO, DW_NO) : w);
}
// The pinned picture at output f under inverse pin M (n × n supersampling).
vec4 cp_pinned(mat3 M, bool ok, vec2 f, ivec2 w, int n) {
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    if (j >= n) break;
    for (int i = 0; i < 4; i++) {
      if (i >= n) break;
      vec2 o = ((vec2(float(i), float(j)) + 0.5) / float(n) - 0.5) * dw_px();
      vec3 s = cp_uvM(M, f + o);
      if (!ok || s.z < 0.0) continue;
      vec2 uv = s.xy;
      float cov = 1.0;
      if (w.x == DW_NO) cov *= dw_cov1(uv.x, u_box.z); else uv.x = dw_wrap1(uv.x, w.x);
      if (w.y == DW_NO) cov *= dw_cov1(uv.y, u_box.w); else uv.y = dw_wrap1(uv.y, w.y);
      vec2 lim = 0.5 / u_box.zw;
      if (cov > 0.0) acc += texture(u_source, fx_uvOfLayerNorm(clamp(uv, lim, 1.0 - lim))) * cov;
    }
  }
  return acc / float(n * n);
}
void main() {
  // No → the quad only (transparent around it); Tile/Reflect repeat the picture over the whole canvas.
  vec2 f = dw_frame();
  ivec2 w = ivec2(u_wrapX, u_wrapY);
  int n = u_filter ? int(clamp(ceil(dw_footprint(f) - 0.25), 1.0, 4.0)) : 1;
  if (fx_mbOn()) {
    // Motion Blur: the pinned picture along the keyframed corners' path over the shutter (adaptive taps between the
    // key pins), each keeping the supersampling of minified areas with fewer samples per axis as the
    // taps multiply (they average along the motion already).
    int taps = fx_mbTaps();
    float j = fx_mbPlanJitter();
    int ss = min(n, taps >= 32 ? 2 : (taps >= 8 ? 3 : 4));
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int k = 0; k < fx_mbDyn(FX_MB_TAP_LIMIT); k++) {
      if (k >= taps) break;
      vec2 t = fx_mbTap(k, taps, j);
      vec4 a = fx_mbPose(0, t.x), b = fx_mbPose(1, t.x), c = fx_mbPose(2, t.x);
      sum += cp_pinned(mat3(a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, c.x), c.y > 0.5, f, w, ss) * t.y;
      wsum += t.y;
    }
    fragColor = sum / max(wsum, 1e-6);
    return;
  }
  fragColor = cp_pinned(u_cpInv, u_cpValid, f, w, n);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- ripples: S_WarpDrops, S_WarpPuddle

const RIPPLE_GLSL = /* glsl */ `
// Envelope of a ripple at radius r (dw_unit radii): fades in after Inner Radius, out before Outer Radius.
float rp_envelope(float r, float inner, float innerSoft, float outer, float outerSoft) {
  float a = smoothstep(inner, inner + max(innerSoft, 1e-4), r);
  float b = 1.0 - smoothstep(outer - max(outerSoft, 1e-4), outer, r);
  return a * b;
}
// Radial ripple displacement (frame units) at offset d (frame units) from a centre.
vec2 rp_wave(vec2 d, float relH, float rotDeg, float freq, float phase, float amp,
             float inner, float innerSoft, float outer, float outerSoft) {
  vec2 e = dw_rot(-rotDeg) * d;
  e.y /= max(relH, 0.01);
  float r = length(e) / dw_unit();
  if (r < 1e-7) return vec2(0.0);
  float env = rp_envelope(r, inner, innerSoft, outer, outerSoft);
  if (env <= 0.0) return vec2(0.0);
  vec2 dir = normalize(dw_rot(rotDeg) * vec2(e.x, e.y * max(relH, 0.01)));
  // Frequency = waves per radius unit; the displacement keeps the wave's steepness independent of it.
  return dir * amp * ${DW_WAVE_UNIT.toFixed(3)} * dw_unit() / max(freq, 0.01) * sin(DW_TAU * (freq * r - phase)) * env;
}`;

export const S_WARP_PUDDLE = distortEffect({
	id: 'jasper.s.warp-puddle',
	label: 'S_WarpPuddle',
	description: 'Concentric ripples spreading from a centre, like a pebble dropped in a puddle.',
	keywords: ['ripple', 'water', 'rings', 'pond', 'concentric'],
	params: [
		amountParam('amplitude', 'Amplitude', 0.1, 2),
		fxParam.number('frequency', 'Frequency', 8, { min: 0.01, softMax: 50, step: 0.1 }),
		fxParam.number('relHeight', 'Rel Height', 0.75, { min: 0.01, softMax: 4, step: 0.01 }),
		fxParam.angle('rotatePuddle', 'Rotate Puddle', 0),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		amountParam('phaseStart', 'Phase Start', 0, 10),
		amountParam('phaseSpeed', 'Phase Speed', 1, 10),
		radiusParam('innerRadius', 'Inner Radius', 0),
		radiusParam('innerSoftness', 'Inner Softness', 0.1, 0.0056),
		radiusParam('outerRadius', 'Outer Radius', 1.4, 0),
		radiusParam('outerSoftness', 'Outer Softness', 0.42, 0.0056),
		zDistParam(),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: simpleWarp(`${RIPPLE_GLSL}
vec2 dw_warp(vec2 f) {
  vec2 c = dw_frameOfNorm(u_center);
  vec2 fz = c + (f - c) * u_zDist;
  return fz + rp_wave(fz - c, u_relHeight, u_rotatePuddle, u_frequency, u_phaseStart + u_phaseSpeed * u_time,
                      u_amplitude, u_innerRadius, u_innerSoftness, u_outerRadius, u_outerSoftness);
}`),
			},
		],
	},
});

/** Cells across the layer for S_WarpDrops' centre search (≈ 192 cells in all). */
export function dropGrid(width: number, height: number): number {
	return Math.max(4, Math.min(32, Math.round(Math.sqrt((192 * width) / Math.max(1, height)))));
}

export const S_WARP_DROPS = distortEffect({
	id: 'jasper.s.warp-drops',
	label: 'S_WarpDrops',
	description:
		'Concentric ripples radiating from many centres — the bright spots of a Centers clip (or of the clip itself) — like raindrops on a puddle.',
	keywords: ['raindrops', 'ripple', 'water', 'rings', 'rain'],
	expensive: true,
	params: [
		fxParam.media('centers', 'Centers'),
		amountParam('amplitude', 'Amplitude', 1, 4),
		fxParam.number('frequency', 'Frequency', 8, { min: 0.01, softMax: 50, step: 0.1 }),
		fxParam.number('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		fxParam.angle('rotateRelH', 'Rotate Rel H', 0),
		fxParam.number('thresholdCntrs', 'Threshold Cntrs', 0.6, { min: 0, max: 1, step: 0.01 }),
		countParam('maxCenters', 'Max Centers', 20, 1, 64),
		amountParam('phaseStart', 'Phase Start', 0, 10),
		amountParam('phaseSpeed', 'Phase Speed', 0, 10),
		radiusParam('innerRadius', 'Inner Radius', 0),
		radiusParam('innerSoftness', 'Inner Softness', 0.1, 0.0028),
		radiusParam('outerRadius', 'Outer Radius', 0.5, 0),
		radiusParam('outerSoftness', 'Outer Softness', 0.5, 0.0056),
		zDistParam(),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		passes: (_p, ctx) => {
			const g = dropGrid(ctx.width, ctx.height);
			const canvasW = Math.max(1, ctx.width * ctx.pxScale);
			return [
				{
					// Each texel = one cell: centroid (cell-relative) of the samples brighter than the threshold,
					// their peak brightness and a weight (coverage × mean brightness above the threshold).
					output: 'dropCells',
					scale: Math.min(1, g / canvasW),
					filter: 'nearest',
					include: [GLSL_DW],
					frag: /* glsl */ `
void main() {
  vec2 cell = floor(v_uv * u_resolution);
  vec2 lo = cell / u_resolution, hi = (cell + 1.0) / u_resolution;
  vec2 csum = vec2(0.0);
  float wsum = 0.0, peak = 0.0;
  for (int j = 0; j < 8; j++)
    for (int i = 0; i < 8; i++) {
      vec2 t = (vec2(float(i), float(j)) + 0.5) / 8.0;
      vec2 uv = mix(lo, hi, t);
      vec4 c = u_centers_size.x > 0.0 ? texture(u_centers, clamp((uv * u_canvasSize - u_box.xy) / u_box.zw, 0.0, 1.0))
                                      : texture(u_source, uv);
      float l = dot(c.rgb, DW_LUMA);
      if (l > u_thresholdCntrs) {
        float w = (l - u_thresholdCntrs) / max(1.0 - u_thresholdCntrs, 1e-3);
        csum += t * w;
        wsum += w;
        peak = max(peak, l);
      }
    }
  fragColor = wsum > 0.0 ? vec4(csum / wsum, peak, wsum / 64.0) : vec4(0.0);
}`,
				},
				{
					// Peaks: a cell is a centre when its weight is a local maximum (ties broken by index), so one
					// bright area larger than a cell gives one centre.
					output: 'dropPeaks',
					scale: Math.min(1, g / canvasW),
					filter: 'nearest',
					frag: /* glsl */ `
void main() {
  ivec2 sz = textureSize(u_dropCells, 0);
  ivec2 me = ivec2(floor(v_uv * u_resolution));
  vec4 c = texelFetch(u_dropCells, me, 0);
  if (c.a <= 0.0) { fragColor = vec4(0.0); return; }
  int idx = me.y * sz.x + me.x;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      ivec2 o = me + ivec2(i, j);
      if ((i == 0 && j == 0) || any(lessThan(o, ivec2(0))) || any(greaterThanEqual(o, sz))) continue;
      float a = texelFetch(u_dropCells, o, 0).a;
      int oi = o.y * sz.x + o.x;
      if (a > c.a || (a == c.a && oi < idx)) { fragColor = vec4(0.0); return; }
    }
  fragColor = c;
}`,
				},
				{
					// The list of the Max Centers strongest peaks: texel k of row 0 = the k-th strongest (canvas uv,
					// strength), sorted by weight; other texels are unused.
					output: 'dropList',
					scale: Math.min(1, 64 / canvasW),
					filter: 'nearest',
					format: 'rgba16f',
					frag: /* glsl */ `
void main() {
  ivec2 me = ivec2(floor(v_uv * u_resolution));
  int maxC = int(clamp(floor(u_maxCenters + 0.5), 1.0, 64.0));
  if (me.y != 0 || me.x >= maxC) { fragColor = vec4(0.0); return; }
  ivec2 sz = textureSize(u_dropPeaks, 0);
  for (int j = 0; j < 32; j++) {
    if (j >= sz.y) break;
    for (int i = 0; i < 32; i++) {
      if (i >= sz.x) break;
      vec4 c = texelFetch(u_dropPeaks, ivec2(i, j), 0);
      if (c.a <= 0.0) continue;
      int idx = j * sz.x + i;
      int rank = 0;
      for (int jj = 0; jj < 32; jj++) {
        if (jj >= sz.y) break;
        for (int ii = 0; ii < 32; ii++) {
          if (ii >= sz.x) break;
          float a = texelFetch(u_dropPeaks, ivec2(ii, jj), 0).a;
          int oi = jj * sz.x + ii;
          if (a > c.a || (a == c.a && a > 0.0 && oi < idx)) rank++;
        }
      }
      if (rank == me.x) {
        vec2 uv = (vec2(float(i), float(j)) + c.xy) / vec2(sz);
        fragColor = vec4(uv, c.z, 1.0);
        return;
      }
    }
  }
  fragColor = vec4(0.0);
}`,
				},
				{
					// Displacement field (frame units, encoded 0.5 + 4·d so it survives an rgba8 fallback).
					output: 'dropDisp',
					format: 'rgba16f',
					include: [GLSL_DW],
					frag: /* glsl */ `${RIPPLE_GLSL}
void main() {
  vec2 f = dw_frame() * u_zDist;
  int maxC = int(clamp(floor(u_maxCenters + 0.5), 1.0, 64.0));
  vec2 d = vec2(0.0);
  for (int k = 0; k < 64; k++) {
    if (k >= maxC) break;
    vec4 c = texelFetch(u_dropList, ivec2(k, 0), 0);
    if (c.a <= 0.0) break;
    vec2 cf = dw_frameOfUv(c.xy);
    d += c.z * rp_wave(f - cf, u_relHeight, u_rotateRelH, u_frequency, u_phaseStart + u_phaseSpeed * u_time,
                       u_amplitude * 0.3, u_innerRadius, u_innerSoftness, u_outerRadius, u_outerSoftness);
  }
  fragColor = vec4(clamp(0.5 + 4.0 * d, 0.0, 1.0), 0.5, 1.0);
}`,
				},
				{
					include: [GLSL_DW_RENDER],
					frag: simpleWarp(`
vec2 dw_warp(vec2 f) { return f * u_zDist + (texture(u_dropDisp, dw_uvOfFrame(f)).rg - 0.5) / 4.0; }`),
				},
			];
		},
	},
});

// ---------------------------------------------------------------- S_WarpFishEye

export const S_WARP_FISH_EYE = distortEffect({
	id: 'jasper.s.warp-fish-eye',
	label: 'S_WarpFishEye',
	description: 'Expands the centre of the clip as if seen through a fish-eye lens; negative amounts pinch.',
	keywords: ['fisheye', 'barrel', 'pincushion', 'lens distortion', 'bulge', 'spherize'],
	params: [
		amountParam('amount', 'Amount', 1, 4),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		zDistParam(),
		fxParam.angle('rotate', 'Rotate', 0),
		shiftParam('shiftOrig', 'Shift Orig'),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: simpleWarp(`
vec2 dw_warp(vec2 f) {
  vec2 c = dw_frameOfNorm(u_center);
  vec2 d = dw_rot(-u_rotate) * ((f - c) * u_zDist);
  float r = length(d);
  const float R0 = 0.5;
  float rs = r;
  if (u_amount > 0.0) {
    // Fish-eye: r_src = R0 tan(θ0 r / R0) / tan θ0 — magnifies the centre, keeps the half-width ring.
    float th0 = 1.5707963 * (1.0 - exp(-0.9 * u_amount));
    rs = R0 * tan(min(r / R0 * th0, 1.5697963)) / tan(th0);
  } else if (u_amount < 0.0) {
    // Pinch: r_src = R0 atan(k r / R0) / atan k.
    float k = 1.5 * -u_amount;
    rs = R0 * atan(r / R0 * k) / atan(k);
  }
  return c + d * (r > 1e-9 ? rs / r : 1.0) - u_shiftOrig;
}`),
			},
		],
	},
});

// ---------------------------------------------------------------- S_WarpMagnify

export const S_WARP_MAGNIFY = distortEffect({
	id: 'jasper.s.warp-magnify',
	label: 'S_WarpMagnify',
	description: 'Magnifies an elliptical region of the clip like a glass lens, with a smooth falloff ring.',
	keywords: ['magnifier', 'loupe', 'zoom lens', 'bulge', 'magnifying glass'],
	params: [
		fxParam.number('magnifyAmount', 'Magnify Amount', 2, { softMin: 0, softMax: 8, step: 0.01 }),
		relParam('magnifyRel', 'Magnify Rel'),
		fxParam.point('lensCenter', 'Lens Center', [0.5, 0.5]),
		radiusParam('lensRadius', 'Lens Radius', 0.4, 0),
		fxParam.number('lensEdgeWidth', 'Lens Edge Width', 0.5, { min: 0, softMax: 2, step: 0.01 }),
		fxParam.number('lensRelHeight', 'Lens Rel Height', 1, { min: 0.1, softMax: 4, step: 0.01 }),
		fxParam.number('lensRelWidth', 'Lens Rel Width', 1, { min: 0.1, softMax: 4, step: 0.01 }),
		fxParam.angle('lensRotate', 'Lens Rotate', 0),
		fxParam.number('lensEdgeShape', 'Lens Edge Shape', 1, { min: -1, max: 1, step: 0.01 }),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: simpleWarp(`
vec2 dw_warp(vec2 f) {
  vec2 c = dw_frameOfNorm(u_lensCenter);
  vec2 d = f - c;
  vec2 e = (dw_rot(-u_lensRotate) * d) / vec2(u_lensRelWidth, u_lensRelHeight);
  float r = length(e) / dw_unit();
  float R = max(u_lensRadius, 0.0);
  float E = R * max(u_lensEdgeWidth, 0.0);
  float t = E > 1e-6 ? clamp((r - R) / E, 0.0, 1.0) : step(R, r);
  // Edge Shape: 0 linear, 1 smooth (S-curve), −1 ease-out.
  float sh = clamp(u_lensEdgeShape, -1.0, 1.0);
  float s = sh >= 0.0 ? mix(t, t * t * (3.0 - 2.0 * t), sh) : mix(t, t * (2.0 - t), -sh);
  vec2 m = 1.0 / max(u_magnifyAmount * u_magnifyRel, vec2(1e-3));
  return c + d * mix(m, vec2(1.0), s);
}`),
			},
		],
	},
});

// ---------------------------------------------------------------- S_WarpPerspective

/** The plane pose of S_WarpPerspective's params, packed as its motion-blur samples (2 vec4). */
function perspectivePose(q: EffectParams): number[] {
	const sh = vec2(q.shiftOrig, [0, 0]);
	return [
		num(q.roll),
		num(q.teleLensWidth, 1),
		num(q.latitude, 35),
		num(q.zDist, 3),
		num(q.swing),
		sh[0],
		sh[1],
		0,
	];
}

/** The plane point (source frame units) seen at output f under a pose (`wp_hit` of the shader), null on a miss. */
export function perspectiveHit(pose: readonly number[], fx: number, fy: number): [number, number] | null {
	const [roll, F, lat, zd, swing, sx, sy] = pose as [number, number, number, number, number, number, number];
	const r = (roll * Math.PI) / 180;
	const gx = Math.cos(r) * fx + Math.sin(r) * fy;
	const gy = -Math.sin(r) * fx + Math.cos(r) * fy;
	const L = (Math.min(89, Math.max(-89, lat)) * Math.PI) / 180;
	const n = [0, Math.sin(L), Math.cos(L)];
	const den = gy * n[1]! + F * n[2]!;
	const Cz = zd * F;
	const t = Math.abs(den) > 1e-9 ? (Cz * n[2]!) / den : -1;
	if (!(t > 0)) return null;
	const P = [t * gx, t * gy, t * F - Cz];
	const lx = P[0]!;
	const ly = P[1]! * Math.cos(L) - P[2]! * Math.sin(L);
	const w = (swing * Math.PI) / 180;
	return [Math.cos(w) * lx + Math.sin(w) * ly - sx, -Math.sin(w) * lx + Math.cos(w) * ly - sy];
}

/** Where a plane point (source frame units) appears on the output under a pose (inverse of `perspectiveHit`). */
export function perspectiveProject(pose: readonly number[], ux: number, uy: number): [number, number] | null {
	const [roll, F, lat, zd, swing, sx, sy] = pose as [number, number, number, number, number, number, number];
	const w = (swing * Math.PI) / 180;
	const lx = Math.cos(w) * (ux + sx) - Math.sin(w) * (uy + sy);
	const ly = Math.sin(w) * (ux + sx) + Math.cos(w) * (uy + sy);
	const L = (Math.min(89, Math.max(-89, lat)) * Math.PI) / 180;
	// P = lx·(1, 0, 0) + ly·v with v = (0, cos L, −sin L); the ray point P + C = t·(g, F).
	const Q = [lx, ly * Math.cos(L), -ly * Math.sin(L) + zd * F];
	if (!(Q[2]! > 1e-9)) return null;
	const gx = (Q[0]! * F) / Q[2]!;
	const gy = (Q[1]! * F) / Q[2]!;
	const r = (roll * Math.PI) / 180;
	return [Math.cos(r) * gx - Math.sin(r) * gy, Math.sin(r) * gx + Math.cos(r) * gy];
}

export const S_WARP_PERSPECTIVE = distortEffect({
	id: 'jasper.s.warp-perspective',
	label: 'S_WarpPerspective',
	description:
		'Maps the clip onto an endless 3D plane seen in perspective (tilt, swing, roll, distance, lens), tiled by default.',
	keywords: ['3d', 'plane', 'floor', 'tilt', 'perspective', 'infinite plane'],
	params: [
		fxParam.number(
			'latitude',
			'Latitude',
			35,
			{ min: -89, max: 89, step: 0.1 },
			{ unit: 'deg', ui: { control: 'angle' } },
		),
		fxParam.angle('swing', 'Swing', 0),
		fxParam.angle('roll', 'Roll', 0),
		zDistParam(3),
		fxParam.number('teleLensWidth', 'Tele Lens Width', 1, { min: 0.2, max: 3, step: 0.01 }),
		shiftParam('shiftOrig', 'Shift Orig'),
		...wrapParams('tile'),
		fxParam.toggle('wrapAboveHorizon', 'Wrap Above Horizon', false),
		filterParam(),
		...motionBlurParams(),
		mbQualityParam(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => {
			// Motion blur: the plane pose at the shutter's key times, 2 vec4 each ((roll, lens, latitude, zDist),
			// (swing, shift x, shift y, 0)); taps from the screen travel of the plane points seen at the layer box
			// corners and centre at the frame.
			const pxW = ctx.width * ctx.pxScale;
			const aspect = ctx.height / Math.max(1, ctx.width);
			const anchors: ([number, number] | null)[] = [
				[-0.5, -aspect / 2],
				[0.5, -aspect / 2],
				[0.5, aspect / 2],
				[-0.5, aspect / 2],
				[0, 0],
			].map(([x, y]) => perspectiveHit(perspectivePose(p), x!, y!));
			const plan = warpShutterPlan(
				p,
				ctx,
				(q) =>
					anchors.map((a): [number, number] => {
						const f = a ? perspectiveProject(perspectivePose(q), a[0], a[1]) : null;
						return f ? [f[0] * pxW, f[1] * pxW] : [Number.NaN, Number.NaN];
					}),
				perspectivePose,
				2,
			);
			return mbUniforms(plan);
		},
		passes: [
			{
				include: [GLSL_DW_RENDER, GLSL_MB_POSES],
				frag: /* glsl */ `
// The pose of the current motion-blur tap (g_wpMb), or the params.
bool g_wpMb = false;
vec4 g_wpA = vec4(0.0), g_wpB = vec4(0.0);
vec4 wp_a() { return g_wpMb ? g_wpA : vec4(u_roll, u_teleLensWidth, u_latitude, u_zDist); }
vec4 wp_b() { return g_wpMb ? g_wpB : vec4(u_swing, u_shiftOrig, 0.0); }
// Ray from the eye through output f onto the plane; x = source frame position, z = 0 when the ray misses.
vec3 wp_hit(vec2 f) {
  vec4 A = wp_a(), B = wp_b();
  vec2 g = dw_rot(-A.x) * f;
  float F = A.y;
  float L = radians(clamp(A.z, -89.0, 89.0));
  vec3 d = vec3(g, F);
  vec3 C = vec3(0.0, 0.0, A.w * F);
  vec3 n = vec3(0.0, sin(L), cos(L));
  vec3 v = vec3(0.0, cos(L), -sin(L));
  float den = dot(d, n);
  float t = abs(den) > 1e-9 ? dot(C, n) / den : -1.0;
  float hit = 1.0;
  if (t <= 0.0) {
    if (!u_wrapAboveHorizon) return vec3(0.0);
    t = -t;
  }
  vec3 P = t * d - C;
  vec2 local = vec2(P.x, dot(P, v));
  return vec3(dw_rot(-B.x) * local - B.yz, hit);
}
vec2 dw_warp(vec2 f) { vec3 h = wp_hit(f); return h.z > 0.0 ? h.xy : f * 1.0e4; }
vec4 dw_shade(vec2 f, ivec2 w) {
  vec3 h = wp_hit(f);
  return h.z > 0.0 ? dw_tap(h.xy, w) : vec4(0.0);
}
void main() {
  if (fx_mbOn()) {
    // Motion Blur: the plane along the keyframed pose's path over the shutter (adaptive taps between the key poses). Each tap keeps the adaptive supersampling of minified areas, with fewer samples per axis as the
    // taps multiply (they average along the motion already).
    int taps = fx_mbTaps();
    float j = fx_mbPlanJitter();
    int maxN = taps >= 32 ? 2 : (taps >= 8 ? 3 : 4);
    g_wpMb = true;
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int k = 0; k < fx_mbDyn(FX_MB_TAP_LIMIT); k++) {
      if (k >= taps) break;
      vec2 t = fx_mbTap(k, taps, j);
      g_wpA = fx_mbPose(0, t.x);
      g_wpB = fx_mbPose(1, t.x);
      sum += dw_render(${WRAP}, u_filter, maxN) * t.y;
      wsum += t.y;
    }
    fragColor = sum / max(wsum, 1e-6);
    return;
  }
  fragColor = dw_render(${WRAP}, u_filter, 4);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_WarpPolar

export const S_WARP_POLAR = distortEffect({
	id: 'jasper.s.warp-polar',
	label: 'S_WarpPolar',
	description:
		'Wraps the clip into a disk: its bottom edge at the Inner Radius, its top at the Outer Radius, its width around the centre.',
	keywords: ['polar coordinates', 'tiny planet', 'disk', 'circle', 'little planet'],
	params: [
		fxParam.angle('angle', 'Angle', 0),
		fxParam.number('angleRepeats', 'Angle Repeats', 1, { min: 0.01, softMax: 12, step: 0.01 }),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		fxParam.vec2('stretch', 'Stretch', [1, 1], { min: 0.01, softMax: 4, step: 0.01 }),
		radiusParam('innerRadius', 'Inner Radius', 0.028),
		radiusParam('outerRadius', 'Outer Radius', 0.84),
		...wrapParams('no'),
		filterParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: /* glsl */ `
vec2 dw_warp(vec2 f) {
  vec2 c = dw_frameOfNorm(u_center);
  vec2 d = (dw_rot(-u_angle) * (f - c)) / max(u_stretch, vec2(0.01));
  float r = length(d) / dw_unit();
  // Angle from 12 o'clock, clockwise, 0..1 per turn.
  float a = atan(d.x, -d.y) / DW_TAU;
  a = a < 0.0 ? a + 1.0 : a;
  float x = a * u_angleRepeats;
  float y = (u_outerRadius - r) / (u_outerRadius - u_innerRadius + (abs(u_outerRadius - u_innerRadius) < 1e-6 ? 1e-6 : 0.0));
  return dw_frameOfNorm(vec2(x, y));
}
vec4 dw_shade(vec2 f, ivec2 w) {
  // Around the circle the copies always repeat (mirrored with Wrap X = Reflect).
  ivec2 ww = ivec2(u_wrapX == DW_REFLECT ? DW_REFLECT : DW_TILE, w.y);
  if (!dw_inBoxF(f)) ww = ivec2(DW_TILE, DW_NO);
  return dw_tap(dw_warp(f), ww);
}
void main() { fragColor = dw_render(${WRAP}, u_filter, 4); }`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_WarpPuff

export const S_WARP_PUFF = distortEffect({
	id: 'jasper.s.warp-puff',
	label: 'S_WarpPuff',
	description: 'Warps the clip along its own brightness gradient: bright areas puff outward (or shrivel).',
	keywords: ['inflate', 'emboss warp', 'puff', 'shrivel', 'luminance displacement'],
	params: [
		fxParam.choice('direction', 'Direction', ['puff', 'shrivel'], ['Puff', 'Shrivel'], 'puff'),
		amountParam('amount', 'Amount', 0.5),
		blurLensParam('smoothness', 'Smoothness'),
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => ({
			u_dispScale: num(p.amount, 0.5) * (str(p.direction, 'puff') === 'shrivel' ? -1 : 1) * DW_DISTORT_UNIT,
		}),
		passes: (p, ctx) => [
			...lensPasses(num(p.smoothness, 0.4), ctx, false),
			{
				include: [GLSL_DW_RENDER, GLSL_DW_LENS],
				frag: simpleWarp(`
vec2 dw_warp(vec2 f) { return f + u_dispScale * (dw_rot(u_rotateWarpDir) * dw_lensGrad(f)); }`),
			},
		],
	},
});

// ---------------------------------------------------------------- S_WarpTransform

const transformParams = (p: EffectParams) => ({
	scale: vec2(p.scale, [1, 1]),
	shift: vec2(p.shift, [0, 0]),
	zDist: num(p.zDist, 1),
	rotate: num(p.rotate),
	swivel: num(p.swivel),
	tilt: num(p.tilt),
	perspectiveAmount: num(p.perspectiveAmount, 1),
	shear: vec2(p.shear, [0, 0]),
});

export const S_WARP_TRANSFORM = distortEffect({
	id: 'jasper.s.warp-transform',
	label: 'S_WarpTransform',
	description:
		'Scales, shears, rotates and moves the clip, with 3D swivel and tilt in perspective; edges wrap as chosen.',
	keywords: ['transform', 'scale', 'rotate', 'shear', 'skew', '3d', 'swivel', 'tilt'],
	params: [
		fxParam.vec2('scale', 'Scale', [1, 1], { softMin: -4, softMax: 4, step: 0.01 }),
		shiftParam('shift', 'Shift'),
		zDistParam(),
		fxParam.angle('rotate', 'Rotate', 0),
		fxParam.angle('swivel', 'Swivel', 0),
		fxParam.angle('tilt', 'Tilt', 0),
		fxParam.number('perspectiveAmount', 'Perspective Amount', 1, { min: 0.25, max: 4, step: 0.01 }),
		fxParam.vec2('shear', 'Shear', [0, 0], { softMin: -2, softMax: 2, step: 0.01 }),
		...wrapParams('no'),
		filterParam(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => {
			const b = transformedBounds(
				warpTransformForward(transformParams(p)),
				ctx.height / Math.max(1, ctx.width),
			);
			return b ? boundsPadding(b, ctx.width, ctx.height) : 0;
		},
		uniforms: (p) => {
			const inv = mat3Invert(warpTransformForward(transformParams(p)));
			return { u_wtInv: { mat3: mat3ToGlsl(inv ?? MAT3_IDENTITY) }, u_wtValid: inv !== null };
		},
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: /* glsl */ `
vec3 wt_src(vec2 f) {
  vec3 h = u_wtInv * vec3(f, 1.0);
  return h.z > 1e-7 ? vec3(h.xy / h.z, 1.0) : vec3(0.0);
}
vec2 dw_warp(vec2 f) { vec3 s = wt_src(f); return s.z > 0.0 ? s.xy : f * 1.0e4; }
vec4 dw_shade(vec2 f, ivec2 w) {
  vec3 s = wt_src(f);
  return (u_wtValid && s.z > 0.0) ? dw_tap(s.xy, w) : vec4(0.0);
}
void main() { fragColor = dw_render(${WRAP}, u_filter, 4); }`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_WarpVortex

export const S_WARP_VORTEX = distortEffect({
	id: 'jasper.s.warp-vortex',
	label: 'S_WarpVortex',
	description: 'Twists the clip into a whirlpool around a centre; Vortex Speed animates the twist.',
	keywords: ['twirl', 'swirl', 'whirlpool', 'twist', 'spiral'],
	params: [
		amountParam('vortexStart', 'Vortex Start', 36, 360),
		amountParam('vortexSpeed', 'Vortex Speed', 0, 360),
		fxParam.angle('angleOffset', 'Angle Offset', 0),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		zDistParam(),
		fxParam.number('innerRadius', 'Inner Radius', 0.042, { min: 0, softMax: 1, step: 0.001 }),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: simpleWarp(`
vec2 dw_warp(vec2 f) {
  vec2 c = dw_frameOfNorm(u_center);
  vec2 d = (f - c) * u_zDist;
  float r = length(d);
  // Twist (degrees) = Vortex Start at the frame edge (half a frame width away), growing as 1/r towards the
  // centre; inside Inner Radius it fades back to the plain rotation.
  float ri = max(u_innerRadius, 1e-4);
  float twist = (u_vortexStart + u_vortexSpeed * u_time) * 0.5 / max(r, ri) * smoothstep(0.0, ri, r);
  return c + dw_rot(-(twist + u_angleOffset)) * d;
}`),
			},
		],
	},
});

// ---------------------------------------------------------------- S_WarpWaves / S_WarpWaves2

const WAVES_GLSL = /* glsl */ `
// Straight waves travelling along angle (0 = vertical crests moving right), pushing along angle + displaceAngle.
vec2 ww_wave(vec2 f, float amp, float freq, float angle, float displaceAngle, float phase) {
  vec2 k = vec2(cos(radians(angle)), sin(radians(angle)));
  vec2 dir = dw_rot(displaceAngle) * k;
  return dir * amp * ${DW_WAVE_UNIT.toFixed(3)} / max(freq, 0.01) * sin(DW_TAU * (freq * dot(f, k) - phase));
}`;

const waveParams = (prefix: '' | 'a' | 'b', label: string, d: [number, number, number, number, number]) => {
	const n = (s: string) => (prefix ? `${prefix}${s}` : s.charAt(0).toLowerCase() + s.slice(1));
	return [
		amountParam(n('Amplitude'), `${label}Amplitude`, d[0], 2),
		fxParam.number(n('Frequency'), `${label}Frequency`, d[1], {
			min: prefix ? 0.01 : 0.1,
			softMax: 50,
			step: 0.1,
		}),
		fxParam.angle(n('Angle'), `${label}Angle`, d[2]),
		fxParam.angle(n('DisplaceAngle'), `${label}Displace Angle`, d[3]),
		amountParam(n('PhaseStart'), `${label}Phase Start`, 0, 10),
		amountParam(n('PhaseSpeed'), `${label}Phase Speed`, d[4], 10),
	];
};

export const S_WARP_WAVES = distortEffect({
	id: 'jasper.s.warp-waves',
	label: 'S_WarpWaves',
	description: 'Warps the clip with one set of straight waves; animate with Phase Speed or Phase Start.',
	keywords: ['wave', 'sine', 'ripple', 'wavy', 'flag'],
	params: [...waveParams('', '', [0.1, 8, 45, 90, 0]), zDistParam(), ...wrapParams('reflect'), filterParam()],
	gpu: {
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: simpleWarp(`${WAVES_GLSL}
vec2 dw_warp(vec2 f) {
  vec2 fz = f * u_zDist;
  return fz + ww_wave(fz, u_amplitude, u_frequency, u_angle, u_displaceAngle, u_phaseStart + u_phaseSpeed * u_time);
}`),
			},
		],
	},
});

export const S_WARP_WAVES2 = distortEffect({
	id: 'jasper.s.warp-waves2',
	label: 'S_WarpWaves2',
	description: 'Warps the clip with two overlapping sets of straight waves (A and B).',
	keywords: ['wave', 'sine', 'ripple', 'wavy', 'water'],
	params: [
		...waveParams('a', 'A ', [0.06, 6, 45, 0, 1]),
		...waveParams('b', 'B ', [0.12, 3, 15, 0, -1]),
		zDistParam(),
		...wrapParams('reflect'),
		filterParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: simpleWarp(`${WAVES_GLSL}
vec2 dw_warp(vec2 f) {
  vec2 fz = f * u_zDist;
  return fz
    + ww_wave(fz, u_aAmplitude, u_aFrequency, u_aAngle, u_aDisplaceAngle, u_aPhaseStart + u_aPhaseSpeed * u_time)
    + ww_wave(fz, u_bAmplitude, u_bFrequency, u_bAngle, u_bDisplaceAngle, u_bPhaseStart + u_bPhaseSpeed * u_time);
}`),
			},
		],
	},
});

// ---------------------------------------------------------------- S_Shake

const shakeAxisParams = (axis: 'x' | 'y' | 'z' | 'tilt', label: string, randAmp: number): ParamSpec[] => {
	const group = `${label} Shake`;
	return [
		fxParam.number(
			`${axis}RandAmp`,
			`${label} Rand Amp`,
			randAmp,
			{ min: 0, softMax: 2, step: 0.01 },
			{ group },
		),
		fxParam.number(
			`${axis}RandFreq`,
			`${label} Rand Freq`,
			1,
			{ min: 0, softMax: 10, step: 0.01 },
			{ group },
		),
		fxParam.number(`${axis}WaveAmp`, `${label} Wave Amp`, 0, { min: 0, softMax: 2, step: 0.01 }, { group }),
		fxParam.number(
			`${axis}WaveFreq`,
			`${label} Wave Freq`,
			0.5,
			{ min: 0, softMax: 10, step: 0.01 },
			{ group },
		),
		fxParam.number(`${axis}Phase`, `${label} Phase`, 0, { softMin: -1, softMax: 1, step: 0.01 }, { group }),
	];
};

/** S_Shake params → the pure shake model (sapphire-distort-warp/math.ts). */
export function shakeParamsOf(p: EffectParams): ShakeParams {
	const axis = (a: string, randAmp: number) => ({
		randAmp: Math.max(0, num(p[`${a}RandAmp`], randAmp)),
		randFreq: Math.max(0, num(p[`${a}RandFreq`], 1)),
		waveAmp: Math.max(0, num(p[`${a}WaveAmp`], 0)),
		waveFreq: Math.max(0, num(p[`${a}WaveFreq`], 0.5)),
		phase: num(p[`${a}Phase`], 0),
	});
	return {
		style: str(p.style, 'normal') as ShakeStyle,
		amplitude: Math.max(0, num(p.amplitude, 1)),
		frequency: Math.max(0, num(p.frequency, 8)),
		phase: num(p.phase),
		stillness: Math.min(1, Math.max(0, num(p.stillness, 0.7))),
		twitchFrequency: Math.max(0, num(p.twitchFrequency, 2)),
		drift: Math.min(1, Math.max(0, num(p.drift, 0.3))),
		centerBias: Math.max(0, num(p.centerBias)),
		x: axis('x', 0.2),
		y: axis('y', 0.1),
		z: axis('z', 0),
		tilt: axis('tilt', 0),
		channelAmp: [
			Math.max(0, num(p.redAmplitude, 1)),
			Math.max(0, num(p.greenAmplitude, 1)),
			Math.max(0, num(p.blueAmplitude, 1)),
		],
		channelPhase: [num(p.redPhase), num(p.greenPhase), num(p.bluePhase)],
		rgbRandomness: Math.max(0, num(p.rgbRandomness)),
		rgbFrequency: Math.max(0, num(p.rgbFrequency, 2)),
	};
}

/** A shake pose as the shaders read it: (dx, dy, cos θ / zoom, sin θ / zoom), frame units. */
const shakeCs = (q: ShakePose) => {
	const a = (q.tilt * Math.PI) / 180;
	return [q.dx, q.dy, Math.cos(a) / q.zoom, Math.sin(a) / q.zoom];
};

/**
 * The shake uniforms of one frame: `u_shakeNow` = the pose of the frame per channel (3 vec4: dx, dy, cos θ / zoom,
 * sin θ / zoom), `u_shakeRgb` (the channels differ) and, with Motion Blur, the adaptive shutter of the framework
 * (`planMotionBlur`): 32 key poses per channel at exact sub-frame times over Mo Blur Length (centred), packed like
 * `u_shakeNow` (linear interpolation: the rotation per key segment is tiny), and a tap count from the travel of the layer box corners and centre (rotation and zoom
 * included) in canvas px. `ctx.width/height/pxScale` default to a 1920×1080 layer at full resolution.
 */
export function shakeUniforms(
	p: EffectParams,
	ctx: { frame: number; fps: number; seed: number; width?: number; height?: number; pxScale?: number },
) {
	const sp = shakeParamsOf(p);
	const fps = Math.max(1, ctx.fps);
	const rgb =
		sp.rgbRandomness > 0 ||
		sp.channelAmp[0] !== sp.channelAmp[1] ||
		sp.channelAmp[1] !== sp.channelAmp[2] ||
		sp.channelPhase[0] !== sp.channelPhase[1] ||
		sp.channelPhase[1] !== sp.channelPhase[2];
	const poseAt = (f: number) => ([0, 1, 2] as const).map((ch) => shakePose(sp, ctx.seed, f / fps, ch));
	const now = poseAt(ctx.frame);
	const len = num(p.moBlurLength, 1);
	let plan = mbStaticPlan(3);
	if (bool(p.motionBlur) && len > 0) {
		const width = Math.max(1, ctx.width ?? 1920);
		const aspect = Math.max(1, ctx.height ?? 1080) / width;
		const pxW = width * (ctx.pxScale ?? 1);
		const zDist = Math.max(1e-3, num(p.zDist, 1));
		const chans = rgb ? ([0, 1, 2] as const) : ([1] as const);
		// The picture points shown at the layer box corners and centre at the frame, tracked over the shutter.
		const outs: [number, number][] = [
			[-0.5, -aspect / 2],
			[0.5, -aspect / 2],
			[0.5, aspect / 2],
			[-0.5, aspect / 2],
			[0, 0],
		];
		const src = chans.map((ch) => {
			const q = now[ch]!;
			const a = (q.tilt * Math.PI) / 180;
			const c = Math.cos(a) / q.zoom;
			const s = Math.sin(a) / q.zoom;
			return outs.map(([fx, fy]): [number, number] => {
				const dx = fx - q.dx;
				const dy = fy - q.dy;
				return [(c * dx + s * dy) * zDist, (-s * dx + c * dy) * zDist];
			});
		});
		plan = planMotionBlur({
			frame: ctx.frame,
			window: centredShutter(len),
			poseAt,
			points: (qs) =>
				chans.flatMap((ch, i) => {
					const q = qs[ch]!;
					const a = (q.tilt * Math.PI) / 180;
					const c = Math.cos(a) * q.zoom;
					const s = Math.sin(a) * q.zoom;
					return src[i]!.map(([x, y]): [number, number] => [
						(q.dx + (c * x - s * y) / zDist) * pxW,
						(q.dy + (s * x + c * y) / zDist) * pxW,
					]);
				}),
			pack: (qs) => qs.flatMap(shakeCs),
			stride: 3,
			quality: p.mbQuality,
		});
	}
	return { u_shakeNow: { vec4s: now.flatMap(shakeCs) }, u_shakeRgb: rgb, ...mbUniforms(plan) };
}

/**
 * GLSL of the shake (S_Shake, S_DissolveShake): the caller defines `vec4 sh_src(vec2 f, vec4 q, ivec2 w)` (the
 * picture at output f under pose q = (dx, dy, cos θ / zoom, sin θ / zoom)); this adds `vec4 sh_render(vec2 f,
 * ivec2 w)`: the pose of the frame (unchanged single-tap path without blur), or the adaptive shutter taps through the
 * key poses. Include GLSL_MB_POSES.
 */
export const SHAKE_RENDER_GLSL = /* glsl */ `
vec4 sh_rgb(vec2 f, vec4 qr, vec4 qg, vec4 qb, ivec2 w) {
  vec4 r = sh_src(f, qr, w), g = sh_src(f, qg, w), b = sh_src(f, qb, w);
  return vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a)));
}
vec4 sh_render(vec2 f, ivec2 w) {
  if (!fx_mbOn()) {
    if (u_shakeRgb) return sh_rgb(f, u_shakeNow[0], u_shakeNow[1], u_shakeNow[2], w);
    return sh_src(f, u_shakeNow[1], w);
  }
  int n = fx_mbTaps();
  float j = fx_mbPlanJitter();
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < fx_mbDyn(FX_MB_TAP_LIMIT); i++) {
    if (i >= n) break;
    vec2 t = fx_mbTap(i, n, j);
    // if / else, not ?: — software GL evaluates both arms of a select.
    if (u_shakeRgb) acc += sh_rgb(f, fx_mbPose(0, t.x), fx_mbPose(1, t.x), fx_mbPose(2, t.x), w) * t.y;
    else acc += sh_src(f, fx_mbPose(1, t.x), w) * t.y;
    wsum += t.y;
  }
  return acc / max(wsum, 1e-6);
}
`;

/** Largest shake offset (frame widths) for the padding: every axis at its bound, × the largest channel amp. */
function shakeReach(p: EffectParams): number {
	const sp = shakeParamsOf(p);
	const ax = (a: ShakeParams['x']) => (a.randAmp * (1.5 + sp.rgbRandomness) + a.waveAmp) * sp.amplitude;
	const amp = Math.max(...sp.channelAmp, 1);
	const off = Math.hypot(ax(sp.x), ax(sp.y)) * 0.1 * amp;
	const zoom = ax(sp.z) * 0.1 * amp;
	const tilt = (ax(sp.tilt) * 5 * amp * Math.PI) / 180;
	return off + 0.6 * (zoom + tilt);
}

export const S_SHAKE = distortEffect({
	id: 'jasper.s.shake',
	label: 'S_Shake',
	// Motion Blur takes up to 64 taps (× 3 with RGB offsets) per pixel on fast shakes.
	expensive: true,
	description:
		'Random, repeatable camera shake (move, zoom, rotate) with Normal, Twitchy and Jumpy styles, motion blur and per-channel RGB offsets.',
	keywords: ['camera shake', 'wiggle', 'jitter', 'handheld', 'earthquake', 'impact'],
	params: [
		fxParam.choice(
			'style',
			'Style',
			['normal', 'twitchy', 'jumpy'],
			['Normal', 'Twitchy', 'Jumpy'],
			'normal',
		),
		fxParam.number('amplitude', 'Amplitude', 1, { min: 0, softMax: 5, step: 0.01 }),
		fxParam.number('frequency', 'Frequency', 8, { min: 0, softMax: 30, step: 0.1 }),
		amountParam('phase', 'Phase', 0, 10),
		fxParam.number('stillness', 'Stillness', 0.7, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('twitchFrequency', 'Twitch Frequency', 2, { min: 0, softMax: 10, step: 0.01 }),
		fxParam.number('drift', 'Drift', 0.3, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('centerBias', 'Center Bias', 0, { min: 0, softMax: 1, step: 0.01 }),
		zDistParam(),
		fxParam.toggle('motionBlur', 'Motion Blur', false),
		fxParam.number('moBlurLength', 'Mo Blur Length', 1, { min: 0, softMax: 2, step: 0.01 }),
		seedParam(0),
		...wrapParams('reflect'),
		...shakeAxisParams('x', 'X', 0.2),
		...shakeAxisParams('y', 'Y', 0.1),
		...shakeAxisParams('z', 'Z', 0),
		...shakeAxisParams('tilt', 'Tilt', 0),
		fxParam.number('redAmplitude', 'Red Amplitude', 1, { min: 0, softMax: 2, step: 0.01 }, { group: 'RGB' }),
		fxParam.number(
			'greenAmplitude',
			'Green Amplitude',
			1,
			{ min: 0, softMax: 2, step: 0.01 },
			{ group: 'RGB' },
		),
		fxParam.number(
			'blueAmplitude',
			'Blue Amplitude',
			1,
			{ min: 0, softMax: 2, step: 0.01 },
			{ group: 'RGB' },
		),
		fxParam.number('redPhase', 'Red Phase', 0, { softMin: -1, softMax: 1, step: 0.01 }, { group: 'RGB' }),
		fxParam.number('greenPhase', 'Green Phase', 0, { softMin: -1, softMax: 1, step: 0.01 }, { group: 'RGB' }),
		fxParam.number('bluePhase', 'Blue Phase', 0, { softMin: -1, softMax: 1, step: 0.01 }, { group: 'RGB' }),
		fxParam.number(
			'rgbRandomness',
			'RGB Randomness',
			0,
			{ min: 0, softMax: 2, step: 0.01 },
			{ group: 'RGB' },
		),
		fxParam.number('rgbFrequency', 'RGB Frequency', 2, { min: 0, softMax: 10, step: 0.01 }, { group: 'RGB' }),
		mbQualityParam(),
	],
	gpu: {
		padding: (p, ctx) => Math.ceil(shakeReach(p) * ctx.width * Math.max(1, num(p.zDist, 1))),
		uniforms: (p, ctx) => shakeUniforms(p, ctx),
		passes: [
			{
				include: [GLSL_DW, GLSL_MB_POSES],
				frag: /* glsl */ `
// The picture at output f under shake pose q = (dx, dy, cos θ / zoom, sin θ / zoom): the inverse of (rotate θ, zoom)
// rotates by −θ and divides by the zoom.
vec4 sh_src(vec2 f, vec4 q, ivec2 w) {
  vec2 d = f - q.xy;
  vec2 src = vec2(q.z * d.x + q.w * d.y, -q.w * d.x + q.z * d.y);
  return dw_tap(src * u_zDist, w);
}
${SHAKE_RENDER_GLSL}
void main() {
  vec2 f = dw_frame();
  fragColor = sh_render(f, dw_wrapAt(f, ${WRAP}));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_StretchFrameEdges

export const S_STRETCH_FRAME_EDGES = distortEffect({
	id: 'jasper.s.stretch-frame-edges',
	label: 'S_StretchFrameEdges',
	description:
		'Squeezes the undistorted centre and stretches the left and right edges, e.g. to fill 16:9 with 4:3 footage without pillars.',
	keywords: ['aspect ratio', '4:3', '16:9', 'pillarbox', 'stretch', 'nonlinear stretch'],
	params: [
		fxParam.number('centerSqueeze', 'Center Squeeze', 1.33, { min: 0, max: 2, step: 0.01 }),
		fxParam.number('centerWidth', 'Center Width', 0.4, { min: 0, max: 0.99, step: 0.01 }),
		fxParam.number('borderWidth', 'Border Width', 0, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('shiftX', 'Shift X', 0, { min: -1, max: 1, step: 0.001 }),
		fxParam.number('smooth', 'Smooth', 0.5, { min: 0, max: 1, step: 0.01 }),
		wrapParam('no'),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_DW_RENDER],
				frag: simpleWarp(
					`
vec2 dw_warp(vec2 f) {
  float x = abs(f.x);
  float sq = max(u_centerSqueeze, 1e-3);
  float c = 0.5 * clamp(u_centerWidth, 0.0, 0.99);
  float H = max(0.5 * (1.0 - clamp(u_borderWidth, 0.0, 1.0)), c + 1e-4);
  float sc = min(sq * c, 0.5);
  float xs;
  if (x <= c) xs = sq * x;
  else if (x <= H) {
    // Edge band: maps (c..H) onto the rest of the source (sq·c..0.5). Linear (a seam) blended with a quadratic
    // whose slope matches the centre at the seam (Smooth = 1: no seam, heavier edge stretch).
    float v = (x - c) / (H - c);
    float span = 0.5 - sc;
    float a = clamp(sq * (H - c) / max(span, 1e-4), 0.0, 2.0);
    float hq = a * v + (1.0 - a) * v * v;
    xs = sc + span * mix(v, hq, clamp(u_smooth, 0.0, 1.0));
  } else xs = 0.5 + (x - H) * 1.0e3;
  return vec2(sign(f.x) * xs + u_shiftX, f.y);
}`,
					{ wrap: WRAP1, filter: 'true', maxN: 2 },
				),
			},
		],
	},
});

// ---------------------------------------------------------------- catalogue

export const SAPPHIRE_DISTORT_WARP_EFFECTS: readonly EffectSpec[] = [
	S_DISTORT,
	S_DISTORT_BLUR,
	S_DISTORT_CHROMA,
	S_DISTORT_RGB,
	S_INFINITE_ZOOM,
	S_PARALLAX_STRIPS,
	S_SHAKE,
	S_STRETCH_FRAME_EDGES,
	S_WARP_BUBBLE,
	S_WARP_BUBBLE2,
	S_WARP_CHROMA,
	S_WARP_CORNER_PIN,
	S_WARP_DROPS,
	S_WARP_FISH_EYE,
	S_WARP_MAGNIFY,
	S_WARP_PERSPECTIVE,
	S_WARP_POLAR,
	S_WARP_PUDDLE,
	S_WARP_PUFF,
	S_WARP_REPEAT,
	S_WARP_TRANSFORM,
	S_WARP_VORTEX,
	S_WARP_WAVES,
	S_WARP_WAVES2,
];

// Slide ▸ Smooth Slide: both clips slide together (a push) in one of four directions along an eased curve, with an
// optional camera dolly during the move, an optional floor reflection below the pictures (Blurriness, Falloff,
// Aspect), multi-sample motion blur over a shutter angle and box-filtered edge smoothing. A clean-room approximation
// of a widely used third-party "Slide" transition; research, sources, parameter mapping and every assumption:
// docs/wp-notes/smooth-slide.md. Part of the premiere-transitions family (bin Slide).
//
// Model (normative; the GLSL below mirrors `smoothSlideContributions`):
// - Progress p (u_progress: Start/End, Custom Completion, Reverse applied by the framework) → eased position
//   e = ease(p) with the Animation curve (Linear, or Ease In / Out / In Out of Sine, Quad, Cubic, Quart, Quint, Expo,
//   Circ). A sits at offset dir·e and B at dir·(e − 1) in frame units: at e = 0 the frame is A, at e = 1 it is B.
// - Dolly d: the camera pulls back mid-move — scale s = 1 / (1 + d · sin(π e)) about the frame centre (1 at both
//   ends; 1 / (1 + d) at e = 0.5). What the pictures no longer cover is transparent (lower tracks show).
// - Reflection: a mirrored copy of a picture below its bottom edge (attached to the picture, Aspect = width:height
//   of the reflection, so it is 1 / Aspect picture heights tall), at SMOOTH_SLIDE_REFLECTION_OPACITY fading linearly
//   to 0 over 1 / (SMOOTH_SLIDE_FALLOFF_RATE · Falloff) picture heights, blurred by Blurriness (σ = 0.4 px × value at
//   1080 lines). Vertical moves show only the lower picture's reflection (the upper one's is behind the lower picture).
// - Motion blur: Off / Low / Medium / High = 1 / 4 / 8 / 16 poses evenly spread over a box shutter of Shutter Angle
//   / 360 frames centred on the frame (in progress space, shrunk at the ends so p = 0 is exactly A and 1 exactly B),
//   averaged — discrete instances along the real eased path, the same in the Player and in every export.
// - Edge Smoothing: None (point sampled) / Low / Medium / High = a box filter 0 / 1 / 2 / 3 px wide over each
//   picture's (and reflection's) rectangle, clipped to the frame so a picture at rest stays exact at the borders.
import type { ParamValue } from '../../../schema/common.ts';
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { angleShutter } from '../../fx/motion-blur.ts';
import { fxParam } from '../../fx/params.ts';
import { gaussianBlurPasses } from '../../fx/passes.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import { booleanParam as bool, clamp, numberParam as num, stringParam as str } from '../../param-values.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import type { TrFrameContext, TrPlanContext } from '../shader.ts';

/** Directions (the way both pictures travel; B enters from the opposite edge), in the reference's menu order. */
export const SMOOTH_SLIDE_DIRECTIONS = ['right', 'left', 'up', 'down'] as const;
export const SMOOTH_SLIDE_DIRECTION_LABELS = ['Right', 'Left', 'Up', 'Down'] as const;
const DIR_VECTORS: Record<string, [number, number]> = {
	right: [1, 0],
	left: [-1, 0],
	up: [0, -1],
	down: [0, 1],
};

const CURVES = ['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ'] as const;
type Curve = (typeof CURVES)[number];

/**
 * The Animation curves in menu order: Linear, then Ease In × 7, Ease Out × 7, Ease In Out × 7 (curves in the order
 * Sine, Quad, Cubic, Quart, Quint, Expo, Circ) — 22 entries, the reference's popup range 0…21.
 */
export const SMOOTH_SLIDE_EASINGS: readonly string[] = [
	'linear',
	...CURVES.map((c) => `easeIn${c}`),
	...CURVES.map((c) => `easeOut${c}`),
	...CURVES.map((c) => `easeInOut${c}`),
];
export const SMOOTH_SLIDE_EASING_LABELS: readonly string[] = [
	'Linear',
	...CURVES.map((c) => `Ease In ${c}`),
	...CURVES.map((c) => `Ease Out ${c}`),
	...CURVES.map((c) => `Ease In Out ${c}`),
];

export const SMOOTH_SLIDE_MOTION_BLUR = ['off', 'low', 'medium', 'high'] as const;
export const SMOOTH_SLIDE_MOTION_BLUR_LABELS = ['Off', 'Low', 'Medium', 'High'] as const;
/** Poses averaged per frame for each Motion Blur level. */
export const SMOOTH_SLIDE_SAMPLES: Record<(typeof SMOOTH_SLIDE_MOTION_BLUR)[number], number> = {
	off: 1,
	low: 4,
	medium: 8,
	high: 16,
};
/** The most poses (the size of the `u_slPoses` array). */
export const SMOOTH_SLIDE_MAX_SAMPLES = 16;

export const SMOOTH_SLIDE_EDGE_SMOOTHING = ['none', 'low', 'medium', 'high'] as const;
export const SMOOTH_SLIDE_EDGE_SMOOTHING_LABELS = ['None', 'Low', 'Medium', 'High'] as const;
/** Box-filter width (sequence px) of each Edge Smoothing level. */
export const SMOOTH_SLIDE_EDGE_WIDTH: Record<(typeof SMOOTH_SLIDE_EDGE_SMOOTHING)[number], number> = {
	none: 0,
	low: 1,
	medium: 2,
	high: 3,
};

/** Opacity of the reflection at the picture's bottom edge (estimated from the reference images, see the note). */
export const SMOOTH_SLIDE_REFLECTION_OPACITY = 0.6;
/** Falloff 1 fades the reflection out over 1 / 8 picture heights; Falloff 0 keeps it even. */
export const SMOOTH_SLIDE_FALLOFF_RATE = 8;
/** Reflection blur σ in sequence px per Blurriness unit, at 1080 lines (scaled with the sequence height). */
export const SMOOTH_SLIDE_BLUR_PX = 0.4;

const SMOOTH_SLIDE_DEFAULTS = {
	direction: 'left',
	animation: 'easeInOutQuad',
	dolly: 0,
	reflection: false,
	blurriness: 10,
	falloff: 0.1,
	aspect: 1,
	motionBlur: 'high',
	shutterAngle: 360,
	edgeSmoothing: 'none',
} as const;

const powIn = (t: number, n: number) => t ** n;
const powOut = (t: number, n: number) => 1 - (1 - t) ** n;
const powInOut = (t: number, n: number) => (t < 0.5 ? 2 ** (n - 1) * t ** n : 1 - (-2 * t + 2) ** n / 2);
const POWERS: Partial<Record<Curve, number>> = { Quad: 2, Cubic: 3, Quart: 4, Quint: 5 };

function curveIn(c: Curve, t: number): number {
	if (POWERS[c]) return powIn(t, POWERS[c]!);
	if (c === 'Sine') return 1 - Math.cos((Math.PI * t) / 2);
	if (c === 'Expo') return t <= 0 ? 0 : 2 ** (10 * t - 10);
	return 1 - Math.sqrt(Math.max(0, 1 - t * t));
}
function curveOut(c: Curve, t: number): number {
	if (POWERS[c]) return powOut(t, POWERS[c]!);
	if (c === 'Sine') return Math.sin((Math.PI * t) / 2);
	if (c === 'Expo') return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
	return Math.sqrt(Math.max(0, 1 - (t - 1) ** 2));
}
function curveInOut(c: Curve, t: number): number {
	if (POWERS[c]) return powInOut(t, POWERS[c]!);
	if (c === 'Sine') return -(Math.cos(Math.PI * t) - 1) / 2;
	if (c === 'Expo') {
		if (t <= 0) return 0;
		if (t >= 1) return 1;
		return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
	}
	return t < 0.5
		? (1 - Math.sqrt(Math.max(0, 1 - (2 * t) ** 2))) / 2
		: (Math.sqrt(Math.max(0, 1 - (-2 * t + 2) ** 2)) + 1) / 2;
}

/** The eased position (0 … 1) of an Animation curve at progress t (clamped to 0 … 1; unknown curves = default). */
export function smoothSlideEase(easing: ParamValue | undefined, t: number): number {
	const x = clamp(Number.isFinite(t) ? t : 0, 0, 1);
	const id = SMOOTH_SLIDE_EASINGS.includes(String(easing)) ? String(easing) : SMOOTH_SLIDE_DEFAULTS.animation;
	if (id === 'linear') return x;
	const m = /^ease(InOut|In|Out)(\w+)$/.exec(id)!;
	const c = m[2] as Curve;
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	return m[1] === 'In' ? curveIn(c, x) : m[1] === 'Out' ? curveOut(c, x) : curveInOut(c, x);
}

/** Unit vector (screen, y down) of a Direction value. */
export function smoothSlideDirection(v: ParamValue | undefined): [number, number] {
	const d =
		DIR_VECTORS[str(v, SMOOTH_SLIDE_DEFAULTS.direction)] ?? DIR_VECTORS[SMOOTH_SLIDE_DEFAULTS.direction]!;
	return [d[0], d[1]];
}

/** The dolly scale at eased position e: 1 / (1 + dolly · sin(π e)) (dolly clamped to 0 … 1.2). */
export function smoothSlideScale(e: number, dolly: number): number {
	const d = clamp(Number.isFinite(dolly) ? dolly : 0, 0, 1.2);
	return 1 / (1 + d * Math.sin(Math.PI * clamp(e, 0, 1)));
}

/** One pose of the move: eased position e and dolly scale s. */
export type SmoothSlidePose = { e: number; s: number };

/**
 * Progress change per frame of the span (the shutter unit): the framework's linear step — 1 / (d + 1) two-sided,
 * 1 / d at a single clip edge — times the Start → End span.
 */
export function smoothSlideFrameStep(
	p: EffectParams,
	ctx: Pick<TrFrameContext, 'duration' | 'hasFrom' | 'hasTo'>,
): number {
	const d = Math.max(1, Number.isFinite(ctx.duration) ? ctx.duration : 1);
	const linear = ctx.hasFrom && ctx.hasTo ? 1 / (d + 1) : 1 / d;
	const span = Math.abs(clamp(num(p.endPercent, 100), 0, 100) - clamp(num(p.startPercent, 0), 0, 100)) / 100;
	return linear * span;
}

/**
 * The poses averaged at a frame: as many as the Motion Blur level asks for, evenly spread (stratum centres) over
 * the shutter — Shutter Angle / 360 frames centred on the frame, in progress space, shrunk symmetrically near the
 * ends so progress 0 / 1 sample only themselves.
 */
export function smoothSlidePoses(
	p: EffectParams,
	ctx: Pick<TrFrameContext, 'progress' | 'duration' | 'hasFrom' | 'hasTo'>,
): SmoothSlidePose[] {
	const level = str(p.motionBlur, SMOOTH_SLIDE_DEFAULTS.motionBlur) as keyof typeof SMOOTH_SLIDE_SAMPLES;
	const n = SMOOTH_SLIDE_SAMPLES[level] ?? SMOOTH_SLIDE_SAMPLES[SMOOTH_SLIDE_DEFAULTS.motionBlur];
	const prog = clamp(Number.isFinite(ctx.progress) ? ctx.progress : 0, 0, 1);
	const w = angleShutter(clamp(num(p.shutterAngle, SMOOTH_SLIDE_DEFAULTS.shutterAngle), 90, 720));
	const half = n > 1 ? Math.min(((w.end - w.start) / 2) * smoothSlideFrameStep(p, ctx), prog, 1 - prog) : 0;
	const dolly = num(p.dolly, 0);
	const out: SmoothSlidePose[] = [];
	for (let k = 0; k < n; k++) {
		const t = n > 1 ? prog + half * ((2 * k + 1) / n - 1) : prog;
		const e = smoothSlideEase(p.animation, t);
		out.push({ e, s: smoothSlideScale(e, dolly) });
	}
	return out;
}

/** Edge Smoothing filter width (px) of a param value. */
export function smoothSlideEdgeWidth(v: ParamValue | undefined): number {
	return (
		SMOOTH_SLIDE_EDGE_WIDTH[str(v, 'none') as keyof typeof SMOOTH_SLIDE_EDGE_WIDTH] ??
		SMOOTH_SLIDE_EDGE_WIDTH.none
	);
}

/** Reflection blur σ (sequence px) for a sequence height. */
export function smoothSlideReflectionSigma(blurriness: number, height: number): number {
	const b = clamp(Number.isFinite(blurriness) ? blurriness : 0, 0, 100);
	return b * SMOOTH_SLIDE_BLUR_PX * (Math.max(1, height) / 1080);
}

/** Box-filter coverage of [a, b) at x over a footprint w px wide clipped to [0, F] (w = 0: point sample). */
export function smoothSlideCoverage(x: number, a: number, b: number, w: number, F: number): number {
	if (w <= 0) return x >= a && x < b ? 1 : 0;
	const lo = Math.max(x - 0.5 * w, 0);
	const hi = Math.min(x + 0.5 * w, F);
	const len = Math.max(hi - lo, 1e-6);
	return clamp((Math.min(hi, b) - Math.max(lo, a)) / len, 0, 1);
}

/** What one pose shows at a sequence pixel: picture samples (side, picture uv 0…1, weight). */
export type SmoothSlideContribution = {
	side: 'from' | 'to';
	uv: [number, number];
	weight: number;
	reflection: boolean;
};

/**
 * CPU reference of the shader for one pose at sequence pixel `px` (pixel centre, sequence px) of a W × H frame: the
 * pictures and reflections that cover it, with their sample positions and weights. The shader sums
 * `weight × side(uv)` over the contributions (reflections read the blurred sides) and averages the poses.
 */
export function smoothSlideContributions(
	px: [number, number],
	pose: SmoothSlidePose,
	p: EffectParams,
	frame: { width: number; height: number },
): SmoothSlideContribution[] {
	const [W, H] = [frame.width, frame.height];
	const dir = smoothSlideDirection(p.direction);
	const aa = smoothSlideEdgeWidth(p.edgeSmoothing);
	const s = Math.max(1e-3, pose.s);
	const uv: [number, number] = [px[0] / W, px[1] / H];
	const q: [number, number] = [(uv[0] - 0.5) / s + 0.5, (uv[1] - 0.5) / s + 0.5];
	const rectCov = (o: [number, number], y0: number, y1: number) => {
		const x0 = ((o[0] - 0.5) * s + 0.5) * W;
		const x1 = ((o[0] + 0.5) * s + 0.5) * W;
		const ya = ((o[1] + y0 - 0.5) * s + 0.5) * H;
		const yb = ((o[1] + y1 - 0.5) * s + 0.5) * H;
		return smoothSlideCoverage(px[0], x0, x1, aa, W) * smoothSlideCoverage(px[1], ya, yb, aa, H);
	};
	const c01 = (v: number) => clamp(v, 0, 1);
	const out: SmoothSlideContribution[] = [];
	const sides: ['from' | 'to', [number, number]][] = [
		['from', [dir[0] * pose.e, dir[1] * pose.e]],
		['to', [dir[0] * (pose.e - 1), dir[1] * (pose.e - 1)]],
	];
	const aspect = clamp(num(p.aspect, 1), 0.01, 20);
	const falloff = clamp(num(p.falloff, 0.1), 0, 1);
	for (const [side, o] of sides) {
		const u: [number, number] = [q[0] - o[0], q[1] - o[1]];
		const cov = rectCov(o, 0, 1);
		if (cov > 0) out.push({ side, uv: [c01(u[0]), c01(u[1])], weight: cov, reflection: false });
		// Vertical moves: only the lower picture reflects (down: A is below B; up: B is below A).
		const reflects = dir[1] === 0 || (side === 'from' ? dir[1] > 0 : dir[1] < 0);
		if (!bool(p.reflection) || !reflects) continue;
		const rc = rectCov(o, 1, 1 + 1 / aspect);
		if (rc <= 0) continue;
		const dy = Math.max(u[1] - 1, 0);
		const fade = SMOOTH_SLIDE_REFLECTION_OPACITY * clamp(1 - dy * falloff * SMOOTH_SLIDE_FALLOFF_RATE, 0, 1);
		if (fade <= 0) continue;
		out.push({ side, uv: [c01(u[0]), c01(1 - dy * aspect)], weight: rc * fade, reflection: true });
	}
	return out;
}

const n0 = (v: number) => v.toFixed(6);

/** The single compositing pass (reflections read `fromTex` / `toTex`: the blurred sides or the sides themselves). */
function slidePass(fromTex: string, toTex: string): ShaderPass {
	return {
		frag: /* glsl */ `
const float SL_PI = 3.14159265358979;
// Box-filter coverage of [a, b) at x over a footprint w px wide clipped to [0, F] (w = 0: point sample).
float sl_cov(float x, float a, float b, float w, float F) {
  if (w <= 0.0) return (x >= a && x < b) ? 1.0 : 0.0;
  float lo = max(x - 0.5 * w, 0.0), hi = min(x + 0.5 * w, F);
  return clamp((min(hi, b) - max(lo, a)) / max(hi - lo, 1e-6), 0.0, 1.0);
}
// Coverage at px of the picture at frame offset o, rows y0 … y1 (picture heights), at dolly scale s.
float sl_rect(vec2 px, vec2 o, float y0, float y1, float s) {
  float x0 = ((o.x - 0.5) * s + 0.5) * u_compSize.x, x1 = ((o.x + 0.5) * s + 0.5) * u_compSize.x;
  float ya = ((o.y + y0 - 0.5) * s + 0.5) * u_compSize.y, yb = ((o.y + y1 - 0.5) * s + 0.5) * u_compSize.y;
  return sl_cov(px.x, x0, x1, u_slAa, u_compSize.x) * sl_cov(px.y, ya, yb, u_slAa, u_compSize.y);
}
float sl_fade(float dy) {
  return ${n0(SMOOTH_SLIDE_REFLECTION_OPACITY)} * clamp(1.0 - dy * clamp(u_falloff, 0.0, 1.0) * ${n0(SMOOTH_SLIDE_FALLOFF_RATE)}, 0.0, 1.0);
}
vec4 sl_pose(vec2 px, float e, float s) {
  s = max(s, 1e-3);
  vec2 q = (v_uv - 0.5) / s + 0.5;
  vec2 oA = u_slDir * e, oB = u_slDir * (e - 1.0);
  vec2 ua = q - oA, ub = q - oB;
  vec4 col = vec4(0.0);
  float cA = sl_rect(px, oA, 0.0, 1.0, s);
  if (cA > 0.0) col += textureLod(u_from, clamp(ua, 0.0, 1.0), 0.0) * cA;
  float cB = sl_rect(px, oB, 0.0, 1.0, s);
  if (cB > 0.0) col += textureLod(u_to, clamp(ub, 0.0, 1.0), 0.0) * cB;
  if (u_reflection) {
    float asp = clamp(u_aspect, 0.01, 20.0);
    float rh = 1.0 / asp;
    bool vert = u_slDir.y != 0.0;
    if (!vert || u_slDir.y > 0.0) {
      float c = sl_rect(px, oA, 1.0, 1.0 + rh, s);
      float dy = max(ua.y - 1.0, 0.0);
      float w = c * sl_fade(dy);
      if (w > 0.0) col += textureLod(${fromTex}, vec2(clamp(ua.x, 0.0, 1.0), clamp(1.0 - dy * asp, 0.0, 1.0)), 0.0) * w;
    }
    if (!vert || u_slDir.y < 0.0) {
      float c = sl_rect(px, oB, 1.0, 1.0 + rh, s);
      float dy = max(ub.y - 1.0, 0.0);
      float w = c * sl_fade(dy);
      if (w > 0.0) col += textureLod(${toTex}, vec2(clamp(ub.x, 0.0, 1.0), clamp(1.0 - dy * asp, 0.0, 1.0)), 0.0) * w;
    }
  }
  return col;
}
void main() {
  vec2 px = tr_px();
  int n = clamp(u_slCount, 1, ${SMOOTH_SLIDE_MAX_SAMPLES});
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${SMOOTH_SLIDE_MAX_SAMPLES}; i++) {
    if (i >= n) break;
    vec4 pose = u_slPoses[i];
    acc += sl_pose(px, pose.x, pose.y);
  }
  acc /= float(n);
  fragColor = vec4(min(acc.rgb, vec3(acc.a)), min(acc.a, 1.0));
}`,
	};
}

function slidePasses(p: EffectParams, ctx: TrPlanContext): ShaderPass[] {
	const sigma = smoothSlideReflectionSigma(num(p.blurriness, SMOOTH_SLIDE_DEFAULTS.blurriness), ctx.height);
	if (!bool(p.reflection) || sigma < 0.05) return [slidePass('u_from', 'u_to')];
	return [
		...gaussianBlurPasses({ input: 'from', output: 'slFromBlur', sigma }),
		...gaussianBlurPasses({ input: 'to', output: 'slToBlur', sigma }),
		slidePass('u_slFromBlur', 'u_slToBlur'),
	];
}

function slideUniforms(p: EffectParams, ctx: TrFrameContext) {
	const poses = smoothSlidePoses(p, ctx);
	const packed: number[] = [];
	for (let i = 0; i < SMOOTH_SLIDE_MAX_SAMPLES; i++) {
		const q = poses[Math.min(i, poses.length - 1)]!;
		packed.push(q.e, q.s, 0, 0);
	}
	return {
		u_slDir: smoothSlideDirection(p.direction),
		u_slPoses: { vec4s: packed },
		u_slCount: { int: poses.length },
		u_slAa: smoothSlideEdgeWidth(p.edgeSmoothing),
	};
}

const REFLECTION = 'Reflection';

const params: ParamSpec[] = [
	fxParam.choice(
		'direction',
		'Direction',
		SMOOTH_SLIDE_DIRECTIONS,
		SMOOTH_SLIDE_DIRECTION_LABELS,
		SMOOTH_SLIDE_DEFAULTS.direction,
	),
	fxParam.choice(
		'animation',
		'Animation',
		SMOOTH_SLIDE_EASINGS,
		SMOOTH_SLIDE_EASING_LABELS,
		SMOOTH_SLIDE_DEFAULTS.animation,
	),
	fxParam.number('dolly', 'Dolly', SMOOTH_SLIDE_DEFAULTS.dolly, { min: 0, max: 1.2, step: 0.01 }),
	fxParam.toggle('reflection', 'Reflection', SMOOTH_SLIDE_DEFAULTS.reflection, { group: REFLECTION }),
	fxParam.number(
		'blurriness',
		'Blurriness',
		SMOOTH_SLIDE_DEFAULTS.blurriness,
		{ min: 0, max: 100, step: 0.1 },
		{ group: REFLECTION },
	),
	fxParam.number(
		'falloff',
		'Falloff',
		SMOOTH_SLIDE_DEFAULTS.falloff,
		{ min: 0, max: 1, step: 0.01 },
		{ group: REFLECTION },
	),
	fxParam.number(
		'aspect',
		'Aspect',
		SMOOTH_SLIDE_DEFAULTS.aspect,
		{ min: 0.01, max: 20, softMax: 4, step: 0.01 },
		{ group: REFLECTION },
	),
	fxParam.choice(
		'motionBlur',
		'Motion Blur',
		SMOOTH_SLIDE_MOTION_BLUR,
		SMOOTH_SLIDE_MOTION_BLUR_LABELS,
		SMOOTH_SLIDE_DEFAULTS.motionBlur,
	),
	fxParam.number(
		'shutterAngle',
		'Shutter Angle',
		SMOOTH_SLIDE_DEFAULTS.shutterAngle,
		{ min: 90, max: 720, step: 1 },
		{ unit: 'deg' },
	),
	fxParam.choice(
		'edgeSmoothing',
		'Edge Smoothing',
		SMOOTH_SLIDE_EDGE_SMOOTHING,
		SMOOTH_SLIDE_EDGE_SMOOTHING_LABELS,
		SMOOTH_SLIDE_DEFAULTS.edgeSmoothing,
	),
];

/** Slide ▸ Smooth Slide. */
export const SMOOTH_SLIDE: TransitionSpec = defineShaderTransition({
	id: 'jasper.smooth-slide',
	label: 'Smooth Slide',
	bin: TRANSITION_BINS.slide,
	description:
		'Both clips slide together in one direction along an eased curve, with an optional camera dolly, a floor reflection below the pictures and multi-sample motion blur.',
	keywords: ['slide', 'push', 'ease', 'easing', 'dolly', 'zoom', 'reflection', 'motion blur', 'whip', 'pan'],
	params,
	gpu: { uniforms: slideUniforms, passes: slidePasses },
});

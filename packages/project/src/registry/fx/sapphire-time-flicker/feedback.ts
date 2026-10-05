// Recursive Sapphire time effects — S_Trails, S_TrailsDiffuse, S_Feedback, S_FeedbackBubble, S_FeedbackDistort —
// emulated deterministically. Sapphire stores each output and combines it with the next frame (state carried between
// frames, reset on a non-consecutive frame); here the recursion is UNROLLED inside one frame: the last `Max Steps`
// frames are fetched as time samples (≤ 8, spread over the window) and one pass replays the recursion oldest →
// newest (out_k = combine(transform(out_{k−1}), frame_k)) along each output pixel's chain of read positions. Every
// per-step operation (fade, colour, hue shift, zoom/rotate/shift, bubble/lens distortion, blur, diffusion) is raised
// to the frame gap between consecutive samples, so a sparse window decays like `Max Steps` single steps. Frames
// before the clip's first frame do not exist (the effect builds up from the first frame, like Sapphire after a reset).
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxPlanContext, FxTimeContext, GlslChunk, ShaderPass } from '../shader.ts';
import { intParam, SAPPHIRE_BLUR_UNIT } from './common.ts';
import { historyOffsets, inSpan, int, num } from './time-math.ts';

export const COMBINE_MODES = ['ave', 'max', 'screen', 'add', 'over', 'under', 'min'] as const;
export const COMBINE_MODE_LABELS = ['Ave', 'Max', 'Screen', 'Add', 'Over', 'Under', 'Min'] as const;
export const WRAP_MODES = ['no', 'tile', 'reflect'] as const;
export const WRAP_MODE_LABELS = ['No', 'Tile', 'Reflect'] as const;

/** Most samples (= recursion steps) a feedback effect uses. */
export const FEEDBACK_MAX_SAMPLES = 8;

/** The parameters every trails/feedback effect starts with (Sapphire order). */
export function feedbackHeadParams(): ParamSpec[] {
	return [
		intParam('maxSteps', 'Max Steps', 15, { min: 2, max: 1000, softMax: 60 }, false),
		fxParam.number('prevBrightness', 'Prev Brightness', 0.8, { min: 0, softMax: 2, step: 0.01 }),
		fxParam.color('prevColor', 'Prev Color', [1, 1, 1, 1]),
		fxParam.number(
			'prevHueShift',
			'Prev Hue Shift',
			0,
			{ softMin: -180, softMax: 180, step: 0.1 },
			{ unit: 'deg' },
		),
		fxParam.choice('combineNew', 'Combine New', COMBINE_MODES, COMBINE_MODE_LABELS, 'ave'),
		fxParam.color('newColor', 'New Color', [1, 1, 1, 1]),
		fxParam.number('newOpacity', 'New Opacity', 1, { min: 0, max: 10, softMax: 2, step: 0.01 }),
	];
}

const amountParam = (name: string, label: string, def: number) =>
	fxParam.number(name, label, def, { min: 0, softMax: 1, step: 0.001 });
const relParam = (name: string, label: string) =>
	fxParam.vec2(name, label, [1, 1], { min: 0, softMax: 4, step: 0.01 });
const wrapParams = (def: (typeof WRAP_MODES)[number]): ParamSpec[] => [
	fxParam.choice('wrapX', 'Wrap X', WRAP_MODES, WRAP_MODE_LABELS, def),
	fxParam.choice('wrapY', 'Wrap Y', WRAP_MODES, WRAP_MODE_LABELS, def),
];
/** Center / Z Dist / Rotate / Shift of the Feedback effects (per-step transform of the previous output). */
const transformParams = (zDist: number, rotate: number): ParamSpec[] => [
	fxParam.point('center', 'Center', [0.5, 0.5]),
	fxParam.number('zDist', 'Z Dist', zDist, { min: 0.001, max: 10, softMin: 0.5, softMax: 1.5, step: 0.001 }),
	fxParam.angle('rotate', 'Rotate', rotate),
	fxParam.vec2('shift', 'Shift', [0, 0], { softMin: -100, softMax: 100, step: 0.1 }),
];

/** Time samples of a feedback effect: the history window, without frames outside the clip's drawn span. */
export function feedbackSamples(p: EffectParams, ctx: FxTimeContext): number[] {
	return inSpan(historyOffsets(int(p.maxSteps, 15, 1), FEEDBACK_MAX_SAMPLES), ctx.frame, ctx);
}

type FeedbackOptions = {
	/** GLSL statements transforming `vec2 px` (layer px of the output) to where the previous output is read. */
	warp?: string;
	/** Extra GLSL helpers (defined before `fb_warp`). */
	helpers?: string;
	include?: readonly GlslChunk[];
	/** Param names of the blur / diffusion amount and their X/Y relative amounts. */
	blur?: { amount: string; rel: string };
	diffuse?: { amount: string; rel: string };
	wrap?: boolean;
	/** Passes before the recursion (e.g. the blurred lens of S_FeedbackDistort). */
	pre?: (p: EffectParams, ctx: FxPlanContext) => ShaderPass[];
};

function feedbackGlsl(o: FeedbackOptions): string {
	const wrap = o.wrap ? 'n.x = fb_wrap1(n.x, u_wrapX); n.y = fb_wrap1(n.y, u_wrapY);' : '';
	const diffuse = o.diffuse
		? /* glsl */ `
  if (u_${o.diffuse.amount} > 0.0) {
    ivec3 k = ivec3(floor(px * u_pxScale), int(floor(sf)));
    vec2 r = vec2(fx_hash3(k, u_seed), fx_hash3(k + ivec3(0, 0, 7919), u_seed)) * 2.0 - 1.0;
    px += r * u_${o.diffuse.amount} * 0.5 * fb_boxPx().y * sqrt(gap) * u_${o.diffuse.rel};
  }`
		: '';
	const blur = o.blur
		? /* glsl */ `
  if (u_${o.blur.amount} > 0.0 && age > 0.0) {
    vec2 sigma = max(vec2(0.0), u_${o.blur.rel}) * u_${o.blur.amount} * ${SAPPHIRE_BLUR_UNIT.toFixed(3)} * fb_boxPx().y * sqrt(age);
    vec4 s = fb_tap(i, px);
    float w = 1.0;
    for (int k = 1; k < 16; k++) {
      float r = sqrt(float(k) / 15.0) * 2.0;
      float a = float(k) * 2.39996323;
      float g = exp(-0.5 * r * r);
      s += fb_tap(i, px + vec2(cos(a), sin(a)) * r * sigma) * g;
      w += g;
    }
    return s / w;
  }`
		: '';
	return /* glsl */ `
vec2 fb_boxPx() { return u_box.zw / u_pxScale; }
float fb_wrap1(float x, int m) {
  if (m == 1) return fract(x);
  if (m == 2) { float k = mod(x, 2.0); return k > 1.0 ? 2.0 - k : k; }
  return x;
}
// Applies the wrap modes to a layer pixel; false when it lies outside the layer box (Wrap: No).
bool fb_wrapPx(inout vec2 px) {
  vec2 n = px / fb_boxPx();
  ${wrap}
  px = n * fb_boxPx();
  return all(greaterThanEqual(n, vec2(0.0))) && all(lessThanEqual(n, vec2(1.0)));
}
// Time sample i at a layer pixel (wrapped; transparent outside the box).
vec4 fb_tap(int i, vec2 px) {
  if (!fb_wrapPx(px)) return vec4(0.0);
  return fx_sample(i, fx_uvOfLayerNorm(px / fb_boxPx()));
}
// Sample i as it reaches the output: blurred by every step since it was the new frame (age = frames ago).
vec4 fb_frame(int i, vec2 px, float age) {
${blur}
  return fb_tap(i, px);
}
${o.helpers ?? ''}
// Where one step of \`gap\` frames (new picture at frame sf) reads the previous output, for output pixel px.
vec2 fb_step(vec2 px, float gap, float sf) {
${o.warp ?? ''}
${diffuse}
  return px;
}
// Fade, colour and hue shift of the previous output for one step of \`gap\` frames.
vec4 fb_ops(vec4 c, float gap) {
  if (u_prevHueShift != 0.0 && c.a > 0.0) {
    vec3 s = fx_hueShift(clamp(c.rgb / c.a, 0.0, 1.0), u_prevHueShift * gap / 360.0);
    c.rgb = s * c.a;
  }
  c.rgb *= pow(max(u_prevColor.rgb, vec3(0.0)), vec3(gap));
  if (u_combineNew != 0) c *= pow(max(u_prevBrightness, 0.0), gap);
  c.a = min(c.a, 1.0);
  return c;
}
vec4 fb_new(vec4 c) { return vec4(c.rgb * u_newColor.rgb * u_newOpacity, min(1.0, c.a * u_newOpacity)); }
// Opaque pictures composite with their luminance as alpha (Sapphire: "if the clip has no Alpha, luma is used").
vec4 fb_keyed(vec4 c) { return c.a > 0.999 ? vec4(c.rgb, clamp(fx_luma(c.rgb), 0.0, 1.0)) : c; }
vec4 fb_combine(vec4 prev, vec4 nw, float gap) {
  if (u_combineNew == 0) {
    float w = clamp(pow(max(u_prevBrightness, 0.0), gap), 0.0, 1.0);
    return prev * w + nw * (1.0 - w);
  }
  if (u_combineNew == 1) return max(prev, nw);
  if (u_combineNew == 2) return prev + nw - prev * nw;
  if (u_combineNew == 3) return vec4(prev.rgb + nw.rgb, min(1.0, prev.a + nw.a));
  if (u_combineNew == 4) { vec4 t = fb_keyed(nw); return vec4(t.rgb + prev.rgb * (1.0 - t.a), nw.a + prev.a * (1.0 - nw.a)); }
  if (u_combineNew == 5) { vec4 t = fb_keyed(prev); return vec4(t.rgb + nw.rgb * (1.0 - t.a), prev.a + nw.a * (1.0 - prev.a)); }
  return min(prev, nw);
}
`;
}

/**
 * The passes of a feedback effect: optional pre passes, then ONE pass that replays the recursion per pixel. Every
 * per-step operation except blur is a point map, so the value of the recursion at an output pixel only depends on
 * one chain of positions: walking back from the output pixel through each step's read position (warp, diffusion,
 * wrap) gives where every earlier frame is read; walking forward combines them (fade, colour, hue, combine mode).
 * Blur is applied to each frame by its age (σ·√age), i.e. blur-then-combine instead of combine-then-blur.
 */
function feedbackPasses(o: FeedbackOptions, p: EffectParams, ctx: FxPlanContext): ShaderPass[] {
	return [
		...(o.pre?.(p, ctx) ?? []),
		{
			include: [GLSL_COLOR, GLSL_HASH, GLSL_UV, ...(o.include ?? [])],
			frag: /* glsl */ `${feedbackGlsl(o)}
void main() {
  vec4 src = texture(u_source, v_uv);
  int n = u_sampleCount;
  if (n == 0 || !fx_inBox(v_uv)) { fragColor = src; return; }
  vec2 qs[8];
  bool ok[8];
  vec2 q = fx_layerPx();
  bool alive = true;
  for (int k = 7; k >= 0; k--) {
    if (k >= n) continue;
    float later = k == n - 1 ? 0.0 : u_sampleOffsets[k + 1];
    q = fb_step(q, later - u_sampleOffsets[k], u_frame + later);
    alive = alive && fb_wrapPx(q);
    qs[k] = q;
    ok[k] = alive;
  }
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 8; k++) {
    if (k >= n) break;
    vec4 nw = ok[k] ? fb_new(fb_frame(k, qs[k], -u_sampleOffsets[k])) : vec4(0.0);
    if (k == 0) acc = nw;
    else {
      float gap = u_sampleOffsets[k] - u_sampleOffsets[k - 1];
      acc = fb_combine(fb_ops(acc, gap), nw, gap);
    }
  }
  float gap = -u_sampleOffsets[n - 1];
  vec4 r = fb_combine(fb_ops(acc, gap), fb_new(src), gap);
  fragColor = vec4(max(r.rgb, vec3(0.0)), clamp(r.a, 0.0, 1.0));
}`,
		},
	];
}

function feedbackEffect(init: {
	id: string;
	label: string;
	description: string;
	keywords: string[];
	params: ParamSpec[];
	options: FeedbackOptions;
}): EffectSpec {
	return defineShaderEffect({
		id: init.id,
		label: init.label,
		category: 'Time',
		bin: SAPPHIRE_BINS.time,
		description: init.description,
		keywords: init.keywords,
		expensive: true,
		params: [...feedbackHeadParams(), ...init.params],
		gpu: {
			time: { samples: feedbackSamples },
			passes: (p, ctx) => feedbackPasses(init.options, p, ctx),
		},
	});
}

/** The per-step zoom/rotate/shift of the Feedback effects, around Center (layer px). */
const AFFINE_WARP = /* glsl */ `
  vec2 c = u_center * fb_boxPx();
  vec2 d = px - u_shift * gap - c;
  d = fx_rot(-fx_deg(u_rotate * gap)) * d * pow(max(u_zDist, 1.0e-3), gap);
  px = c + d;`;

export const S_TRAILS = feedbackEffect({
	id: 'jasper.s.trails',
	label: 'S_Trails',
	description:
		'Previous frames are faded and combined with the current one (Ave, Max, Screen, Add, Over, Under, Min) for time trails.',
	keywords: ['trails', 'echo', 'smear', 'ghost', 'time'],
	params: [amountParam('blurAmount', 'Blur Amount', 0), relParam('blurRel', 'Blur Rel')],
	options: { blur: { amount: 'blurAmount', rel: 'blurRel' } },
});

export const S_TRAILS_DIFFUSE = feedbackEffect({
	id: 'jasper.s.trails-diffuse',
	label: 'S_TrailsDiffuse',
	description: 'Time trails whose previous frames scatter through a pixel-diffusion process at every step.',
	keywords: ['trails', 'diffuse', 'scatter', 'echo', 'time'],
	params: [
		amountParam('diffuseAmount', 'Diffuse Amount', 0.028),
		relParam('diffuseRel', 'Diffuse Rel'),
		...wrapParams('reflect'),
	],
	options: { diffuse: { amount: 'diffuseAmount', rel: 'diffuseRel' }, wrap: true },
});

export const S_FEEDBACK = feedbackEffect({
	id: 'jasper.s.feedback',
	label: 'S_Feedback',
	description:
		'Video feedback: previous frames are zoomed, rotated and shifted at every step and combined with the current frame.',
	keywords: ['feedback', 'tunnel', 'zoom', 'spiral', 'trails', 'droste'],
	params: [
		amountParam('blurAmount', 'Blur Amount', 0),
		amountParam('diffuseAmount', 'Diffuse Amount', 0),
		relParam('amountRel', 'Amount Rel'),
		...transformParams(0.95, 3),
		...wrapParams('no'),
	],
	options: {
		warp: AFFINE_WARP,
		blur: { amount: 'blurAmount', rel: 'amountRel' },
		diffuse: { amount: 'diffuseAmount', rel: 'amountRel' },
		wrap: true,
	},
});

export const S_FEEDBACK_BUBBLE = feedbackEffect({
	id: 'jasper.s.feedback-bubble',
	label: 'S_FeedbackBubble',
	description:
		'Video feedback whose previous frames are distorted by an animated bubbling noise at every step.',
	keywords: ['feedback', 'bubble', 'noise', 'liquid', 'trails'],
	params: [
		fxParam.number('bubbleAmount', 'Bubble Amount', 0.05, { softMin: -0.5, softMax: 0.5, step: 0.001 }),
		fxParam.number('bubbleFreq', 'Bubble Freq', 16, { min: 0.01, softMax: 100, step: 0.1 }),
		fxParam.number('bubbleFreqRelX', 'Bubble Freq Rel X', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		fxParam.vec2('bubbleShift', 'Bubble Shift', [0, 0], { step: 0.01 }),
		fxParam.vec2('bubbleShiftSpeed', 'Bubble Shift Speed', [0, 0.07], { step: 0.001 }),
		intParam('bubbleOctaves', 'Bubble Octaves', 1, { min: 1, max: 10 }, false),
		fxParam.number(
			'bubbleSeed',
			'Bubble Seed',
			0.123,
			{ min: 0, softMax: 10, step: 0.001 },
			{ animatable: false },
		),
		amountParam('blurAmount', 'Blur Amount', 0),
		amountParam('diffuseAmount', 'Diffuse Amount', 0),
		relParam('amountRel', 'Amount Rel'),
		...transformParams(0.95, 0),
		...wrapParams('no'),
	],
	options: {
		include: [GLSL_NOISE],
		helpers: /* glsl */ `
vec2 fb_bubble(vec2 px, float sf) {
  vec2 q = px / fb_boxPx().y * u_bubbleFreq * 0.25 * vec2(u_bubbleFreqRelX, 1.0) + u_bubbleShift + u_bubbleShiftSpeed * sf;
  int oct = int(clamp(u_bubbleOctaves, 1.0, 10.0));
  float s = fract(u_bubbleSeed * 0.6180339);
  return vec2(fx_fbm(q, oct, 2.0, 0.5, s), fx_fbm(q + vec2(31.7, 11.3), oct, 2.0, 0.5, fract(s + 0.5)));
}`,
		warp: /* glsl */ `${AFFINE_WARP}
  px += fb_bubble(px, sf) * u_bubbleAmount * 0.5 * fb_boxPx().y * gap;`,
		blur: { amount: 'blurAmount', rel: 'amountRel' },
		diffuse: { amount: 'diffuseAmount', rel: 'amountRel' },
		wrap: true,
	},
});

export const S_FEEDBACK_DISTORT = feedbackEffect({
	id: 'jasper.s.feedback-distort',
	label: 'S_FeedbackDistort',
	description:
		'Video feedback whose previous frames flow along the brightness gradients of a Lens clip (or the source) at every step.',
	keywords: ['feedback', 'distort', 'lens', 'flow', 'trails'],
	params: [
		fxParam.media('lens', 'Lens'),
		fxParam.number('distortAmount', 'Distort Amount', 0.1, { softMin: -1, softMax: 1, step: 0.001 }),
		fxParam.number('blurLens', 'Blur Lens', 0.08, { min: 0, softMax: 1, step: 0.001 }),
		fxParam.angle('rotateDistort', 'Rotate Distort', 90),
		amountParam('blurAmount', 'Blur Amount', 0),
		amountParam('diffuseAmount', 'Diffuse Amount', 0),
		relParam('amountRel', 'Amount Rel'),
		...transformParams(1, 0),
		...wrapParams('no'),
	],
	options: {
		pre: (p, ctx) => [
			{
				output: 'lensLuma',
				scale: 0.5,
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec4 c = u_lens_size.x > 0.0 ? texture(u_lens, clamp(fx_layerNorm(), 0.0, 1.0)) : texture(u_source, v_uv);
  fragColor = vec4(vec3(fx_luma(c.rgb)), 1.0);
}`,
			},
			...gaussianBlurPasses({
				input: 'lensLuma',
				output: 'lensBlur',
				sigma: Math.max(0, num(p.blurLens, 0.08)) * SAPPHIRE_BLUR_UNIT * ctx.height * ctx.pxScale,
				scale: 0.5,
			}),
		],
		helpers: /* glsl */ `
// Brightness gradient of the blurred lens at a layer pixel (luma per layer height).
vec2 fb_lensGrad(vec2 px) {
  vec2 uv = fx_uvOfLayerNorm(px / fb_boxPx());
  vec2 e = 1.5 / vec2(textureSize(u_lensBlur, 0));
  float gx = texture(u_lensBlur, uv + vec2(e.x, 0.0)).r - texture(u_lensBlur, uv - vec2(e.x, 0.0)).r;
  float gy = texture(u_lensBlur, uv + vec2(0.0, e.y)).r - texture(u_lensBlur, uv - vec2(0.0, e.y)).r;
  vec2 stepPx = 2.0 * e * u_canvasSize / u_pxScale;
  return vec2(gx, gy) / stepPx * fb_boxPx().y;
}`,
		warp: /* glsl */ `${AFFINE_WARP}
  px -= fx_rot(fx_deg(u_rotateDistort)) * fb_lensGrad(px) * u_distortAmount * 0.1 * fb_boxPx().y * gap;`,
		blur: { amount: 'blurAmount', rel: 'amountRel' },
		diffuse: { amount: 'diffuseAmount', rel: 'amountRel' },
		wrap: true,
	},
});

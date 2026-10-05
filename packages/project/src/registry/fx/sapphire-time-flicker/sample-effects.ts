// Sapphire time effects built on time samples (other frames of the layer's source, decoded for their own frame):
// S_CutToDissolve, S_MotionDetect, S_NearestColor, S_RepairFrames, S_TimeAverage, S_TimeDisplace, S_TimeSlice,
// S_TimeWarpRGB, plus the purely spatial S_FieldRemove. Windows wider than the 8-sample budget are covered by evenly
// spread samples (exact up to 8–9 frames).
import type { EffectParams } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxTimeContext } from '../shader.ts';
import { frameAtOffsets, GLSL_FRAME_AT, intParam, SAPPHIRE_BLUR_UNIT } from './common.ts';
import { FLOW_INTERP_GLSL, flowPasses, GLSL_FLOW_FINAL } from './flow.ts';
import { historyOffsets, inSpan, int, num, spreadOffsets, str } from './time-math.ts';

const time = { category: 'Time' as const, bin: SAPPHIRE_BINS.time };

// ---------------------------------------------------------------- S_CutToDissolve

/** The dissolve window of S_CutToDissolve: frames [start, end) around the cut (first incoming frame `cut`). */
export function cutDissolveWindow(p: EffectParams): {
	cut: number;
	start: number;
	end: number;
	length: number;
} {
	const cut = int(p.cutPoint, 5, 0);
	const length = int(p.dissolveLength, 6, 2);
	const start = cut - Math.floor(length / 2);
	return { cut, start, end: start + length, length };
}

/** Eased dissolve progress (0 → 1 across the window): Slow In Out 0 = linear, higher = gentler ends. */
export function cutDissolveProgress(p: EffectParams, frame: number): number {
	const w = cutDissolveWindow(p);
	const t = Math.min(1, Math.max(0, (frame - w.start + 0.5) / w.length));
	const k = 1 + Math.max(0, num(p.slowInOut, 2));
	const a = t ** k;
	const b = (1 - t) ** k;
	return a + b > 0 ? a / (a + b) : t;
}

export function cutDissolveSamples(p: EffectParams, ctx: FxTimeContext): number[] {
	const w = cutDissolveWindow(p);
	const f = ctx.frame;
	if (str(p.show, 'result') === 'cutFrames') return inSpan([w.cut - 1 - f, w.cut - f], f, ctx);
	if (f < w.start || f >= w.end) return [];
	// The other side of the cut, held at its frame next to the cut (no handles needed).
	return inSpan([f < w.cut ? w.cut - f : w.cut - 1 - f], f, ctx);
}

export const S_CUT_TO_DISSOLVE = defineShaderEffect({
	...time,
	id: 'jasper.s.cut-to-dissolve',
	label: 'S_CutToDissolve',
	description:
		'Turns a cut inside a single clip into a dissolve around Cut Point (no handles needed: the frames next to the cut are held).',
	keywords: ['dissolve', 'cut', 'crossfade', 'transition', 'mix'],
	params: [
		intParam('cutPoint', 'Cut Point', 5, { min: 2, softMax: 300 }),
		intParam('dissolveLength', 'Dissolve Length', 6, { min: 2, softMax: 60 }),
		fxParam.number('slowInOut', 'Slow In Out', 2, { min: 0, max: 10, step: 0.01 }),
		fxParam.number('gamma', 'Gamma', 1, { min: 0.1, max: 10, step: 0.01 }),
		fxParam.choice(
			'show',
			'Show',
			['result', 'cutFrames', 'a', 'b'],
			['Result', 'Cut Frames', 'A', 'B'],
			'result',
		),
		fxParam.number('splitForCut', 'Split For Cut', 0, { min: -1, max: 1, step: 0.01 }),
	],
	gpu: {
		time: { samples: cutDissolveSamples },
		uniforms: (p, ctx) => {
			const w = cutDissolveWindow(p);
			return {
				u_ct: cutDissolveProgress(p, ctx.frame),
				u_inWindow: ctx.frame >= w.start && ctx.frame < w.end,
				u_afterCut: ctx.frame >= w.cut,
			};
		},
		passes: [
			{
				frag: /* glsl */ `
vec4 cd_mix(vec4 a, vec4 b, float t) {
  float g = max(u_gamma, 0.1);
  vec3 ca = pow(max(fx_unpremultiply(a).rgb, vec3(0.0)), vec3(g));
  vec3 cb = pow(max(fx_unpremultiply(b).rgb, vec3(0.0)), vec3(g));
  float al = mix(a.a, b.a, t);
  vec3 c = pow(mix(ca * step(1.0e-6, a.a), cb * step(1.0e-6, b.a), t), vec3(1.0 / g));
  return vec4(c * al, al);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_show == 1) {
    if (u_sampleCount < 2) { fragColor = src; return; }
    fragColor = fx_layerNorm().x < 0.5 + 0.5 * u_splitForCut ? fx_sample(0, v_uv) : fx_sample(1, v_uv);
    return;
  }
  vec4 a; vec4 b; float t;
  if (u_inWindow) {
    vec4 other = u_sampleCount > 0 ? fx_sample(0, v_uv) : src;
    a = u_afterCut ? other : src;
    b = u_afterCut ? src : other;
    t = u_ct;
  } else {
    a = src; b = src; t = u_afterCut ? 1.0 : 0.0;
  }
  if (u_show == 2) b = vec4(0.0, 0.0, 0.0, b.a);
  if (u_show == 3) a = vec4(0.0, 0.0, 0.0, a.a);
  fragColor = cd_mix(a, b, t);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_FieldRemove

export const S_FIELD_REMOVE = defineShaderEffect({
	...time,
	id: 'jasper.s.field-remove',
	label: 'S_FieldRemove',
	description:
		'Removes interlacing combs where there is motion (a soft motion matte) and keeps static areas at full resolution.',
	keywords: ['deinterlace', 'fields', 'interlace', 'comb', 'repair'],
	params: [
		fxParam.number('scaleMoMatte', 'Scale Mo Matte', 4, { min: 0, softMax: 20, step: 0.01 }),
		fxParam.number('thresholdMatte', 'Threshold Matte', 0.05, { min: 0, softMax: 1, step: 0.001 }),
		fxParam.number('blurMoMatte', 'Blur Mo Matte', 0.112, { min: 0, softMax: 1, step: 0.001 }),
		fxParam.choice('show', 'Show', ['result', 'motionMatte'], ['Result', 'MotionMatte'], 'result'),
		fxParam.choice(
			'useField',
			'Use Field',
			['lower', 'upper', 'merge'],
			['Lower', 'Upper', 'Merge'],
			'lower',
		),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			{
				output: 'comb',
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec2 d = vec2(0.0, u_pxScale / u_canvasSize.y);
  float c = fx_luma(texture(u_source, v_uv).rgb);
  float u = fx_luma(texture(u_source, v_uv - d).rgb);
  float w = fx_luma(texture(u_source, v_uv + d).rgb);
  // A comb (the row differs from BOTH neighbours in the same direction) — edges and gradients give 0.
  float comb = sqrt(max((c - u) * (c - w), 0.0));
  fragColor = vec4(vec3(max(0.0, comb * u_scaleMoMatte - u_thresholdMatte)), 1.0);
}`,
			},
			...gaussianBlurPasses({
				input: 'comb',
				output: 'combBlur',
				sigma: Math.max(0, num(p.blurMoMatte, 0.112)) * SAPPHIRE_BLUR_UNIT * ctx.height * ctx.pxScale,
				scale: 0.5,
			}),
			{
				include: [GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 c = texture(u_source, v_uv);
  float m = clamp(texture(u_combBlur, v_uv).r * 2.0, 0.0, 1.0);
  if (u_show == 1) { fragColor = fx_matteView(m); return; }
  vec2 d = vec2(0.0, u_pxScale / u_canvasSize.y);
  vec4 up = texture(u_source, v_uv - d);
  vec4 dn = texture(u_source, v_uv + d);
  bool upperRow = int(mod(floor(fx_layerPx().y), 2.0)) == 0;
  vec4 fixedC;
  if (u_useField == 2) fixedC = 0.5 * c + 0.25 * (up + dn);
  else fixedC = ((u_useField == 0) != upperRow) ? c : 0.5 * (up + dn);
  fragColor = mix(c, fixedC, m);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_MotionDetect

export const MOTION_COMBINE = [
	'motionOnly',
	'mult',
	'add',
	'screen',
	'difference',
	'overlay',
	'subtract',
] as const;

export const S_MOTION_DETECT = defineShaderEffect({
	...time,
	id: 'jasper.s.motion-detect',
	label: 'S_MotionDetect',
	description: 'Shows the difference between each frame and an earlier one: moving areas light up.',
	keywords: ['motion', 'difference', 'detect', 'edges', 'movement'],
	params: [
		intParam('delayFrames', 'Delay Frames', 1, { softMin: -30, softMax: 30 }),
		fxParam.number('brightness', 'Brightness', 1, { min: 0, softMax: 10, step: 0.01 }),
		fxParam.number('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2, step: 0.01 }),
		fxParam.number('saturation', 'Saturation', 1, { min: -2, max: 10, step: 0.01 }),
		fxParam.choice('motion', 'Motion', ['all', 'brighter', 'darker'], ['All', 'Brighter', 'Darker'], 'all'),
		fxParam.choice(
			'combine',
			'Combine',
			MOTION_COMBINE,
			['Motion Only', 'Mult', 'Add', 'Screen', 'Difference', 'Overlay', 'Subtract'],
			'motionOnly',
		),
	],
	gpu: {
		time: {
			samples: (p, ctx) => {
				const d = int(p.delayFrames, 1);
				return d === 0 ? [] : inSpan([-d], ctx.frame, ctx);
			},
		},
		passes: [
			{
				include: [GLSL_COLOR, GLSL_BLEND],
				frag: /* glsl */ `
const int MD_MODES[7] = int[7](0, FX_BLEND_MULTIPLY, FX_BLEND_ADD, FX_BLEND_SCREEN, FX_BLEND_DIFFERENCE, FX_BLEND_OVERLAY, FX_BLEND_SUBTRACT);
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 prev = u_sampleCount > 0 ? fx_sample(0, v_uv) : src;
  vec3 a = fx_unpremultiply(src).rgb;
  vec3 d = a - fx_unpremultiply(prev).rgb;
  vec3 m = u_motion == 1 ? max(d, 0.0) : u_motion == 2 ? max(-d, 0.0) : abs(d);
  m *= u_brightness;
  m += u_offsetDarks * (1.0 - clamp(m, 0.0, 1.0));
  m = clamp(mix(vec3(fx_luma(m)), m, u_saturation), 0.0, 1.0);
  vec3 c = u_combine == 0 ? m : fx_blendRgb(MD_MODES[u_combine], a, m);
  float al = max(src.a, prev.a);
  fragColor = vec4(clamp(c, 0.0, 1.0) * al, al);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_NearestColor

export const S_NEAREST_COLOR = defineShaderEffect({
	...time,
	id: 'jasper.s.nearest-color',
	label: 'S_NearestColor',
	description:
		'Keeps, per pixel, the colour nearest to Match Color over the last Steps frames (e.g. a clean plate from a blue screen).',
	keywords: ['clean plate', 'background', 'accumulate', 'color', 'keep'],
	expensive: true,
	params: [
		intParam('steps', 'Steps', 15, { min: 2, softMax: 60 }, false),
		fxParam.color('matchColor', 'Match Color', [0, 0, 1, 1]),
		fxParam.number('chromaWeight', 'Chroma Weight', 1, { min: 0, softMax: 4, step: 0.01 }),
	],
	gpu: {
		time: { samples: (p, ctx) => inSpan(historyOffsets(int(p.steps, 15, 1) - 1), ctx.frame, ctx) },
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
float nc_dist(vec4 p) {
  if (p.a <= 0.0) return 1.0e9;
  vec3 c = p.rgb / p.a;
  float y = fx_luma(c); float ym = fx_luma(u_matchColor.rgb);
  vec3 dc = (c - y) - (u_matchColor.rgb - ym);
  return (y - ym) * (y - ym) + u_chromaWeight * dot(dc, dc);
}
void main() {
  vec4 best = texture(u_source, v_uv);
  float bd = nc_dist(best);
  for (int i = 0; i < 8; i++) {
    if (i >= u_sampleCount) break;
    vec4 s = fx_sample(i, v_uv);
    float d = nc_dist(s);
    if (d < bd) { bd = d; best = s; }
  }
  fragColor = best;
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_RepairFrames

export function repairRange(p: EffectParams): { first: number; count: number } {
	return { first: int(p.firstBadFrame, 5, 0), count: int(p.badFrameCount, 1, 1) };
}

export function repairSamples(p: EffectParams, ctx: FxTimeContext): number[] {
	const { first, count } = repairRange(p);
	const f = ctx.frame;
	if (str(p.show, 'result') === 'badFrame') return inSpan([first - f], f, ctx);
	if (f < first || f >= first + count) return [];
	return inSpan([first - 1 - f, first + count - f], f, ctx);
}

export const S_REPAIR_FRAMES = defineShaderEffect({
	...time,
	id: 'jasper.s.repair-frames',
	label: 'S_RepairFrames',
	description: 'Replaces bad frames with motion-compensated in-betweens of the good frames around them.',
	keywords: ['repair', 'fix', 'dropout', 'bad frame', 'interpolate', 'optical flow'],
	expensive: true,
	params: [
		intParam('firstBadFrame', 'First Bad Frame', 5, { min: 2, softMax: 300 }),
		intParam('badFrameCount', 'Bad Frame Count', 1, { min: 1, softMax: 30 }),
		fxParam.choice('show', 'Show', ['result', 'badFrame'], ['Result', 'Bad Frame'], 'result'),
	],
	gpu: {
		time: { samples: repairSamples },
		uniforms: (p, ctx) => {
			const { first, count } = repairRange(p);
			const bad = ctx.frame >= first && ctx.frame < first + count;
			return { u_t: bad ? (ctx.frame - first + 1) / (count + 1) : 0, u_bad: bad };
		},
		passes: () => {
			const defs = /* glsl */ `
vec4 flowA(vec2 uv) { return fx_sample(0, uv); }
vec4 flowB(vec2 uv) { return fx_sample(1, uv); }
bool flowActive() { return u_show == 0 && u_bad && u_sampleCount == 2; }`;
			return [
				...flowPasses(defs, [], 3e-4, 0.5),
				{
					include: [GLSL_FLOW_FINAL],
					frag: /* glsl */ `${defs}
${FLOW_INTERP_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_show == 1) { fragColor = u_sampleCount > 0 ? fx_sample(0, v_uv) : src; return; }
  if (!u_bad || u_sampleCount == 0) { fragColor = src; return; }
  if (u_sampleCount == 1) { fragColor = fx_sample(0, v_uv); return; }
  fragColor = fl_interp(v_uv, u_t, 0.0);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- S_TimeAverage

export const S_TIME_AVERAGE = defineShaderEffect({
	...time,
	id: 'jasper.s.time-average',
	label: 'S_TimeAverage',
	description:
		'Each frame is the average of the current and previous frames (equal weights: abrupt trail ends).',
	keywords: ['average', 'motion blur', 'smear', 'denoise', 'trails', 'long exposure'],
	expensive: true,
	params: [
		intParam('aveOverFrames', 'Ave Over Frames', 10, { min: 1, softMax: 60 }),
		fxParam.number('brightness', 'Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
	],
	gpu: {
		time: {
			samples: (p, ctx) => {
				const n = int(p.aveOverFrames, 10, 1);
				return n <= 1 ? [] : inSpan(historyOffsets(n - 1), ctx.frame, ctx);
			},
		},
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 s = texture(u_source, v_uv);
  for (int i = 0; i < 8; i++) {
    if (i >= u_sampleCount) break;
    s += fx_sample(i, v_uv);
  }
  s /= float(u_sampleCount + 1);
  fragColor = vec4(s.rgb * u_brightness, s.a);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_TimeDisplace

export function timeDisplaceSamples(p: EffectParams, ctx: FxTimeContext): number[] {
	const b = num(p.blackTimeShift, -10);
	const w = num(p.whiteTimeShift, 10);
	const rel = str(p.shiftRelativeTo, 'currentFrame') !== 'frame0';
	const lo = rel ? b : b - ctx.frame;
	const hi = rel ? w : w - ctx.frame;
	return inSpan(
		frameAtOffsets(Math.floor(Math.min(lo, hi)), Math.ceil(Math.max(lo, hi)), spreadOffsets),
		ctx.frame,
		ctx,
	);
}

export const S_TIME_DISPLACE = defineShaderEffect({
	...time,
	id: 'jasper.s.time-displace',
	label: 'S_TimeDisplace',
	description:
		'Shifts each pixel in time by the brightness of a Matte (or the source): black areas show earlier frames, white areas later ones.',
	keywords: ['time displacement', 'slit scan', 'echo', 'matte', 'warp'],
	expensive: true,
	params: [
		fxParam.media('matte', 'Matte'),
		fxParam.number(
			'blackTimeShift',
			'Black Time Shift',
			-10,
			{ softMin: -60, softMax: 60, step: 0.1 },
			{ unit: 'frames' },
		),
		fxParam.number(
			'whiteTimeShift',
			'White Time Shift',
			10,
			{ softMin: -60, softMax: 60, step: 0.1 },
			{ unit: 'frames' },
		),
		fxParam.choice(
			'shiftRelativeTo',
			'Shift Relative To',
			['frame0', 'currentFrame'],
			['Frame 0', 'Current Frame'],
			'currentFrame',
		),
		fxParam.toggle('interpFrames', 'Interp Frames', false),
		fxParam.choice('matteUse', 'Matte Use', ['luma', 'alpha'], ['Luma', 'Alpha'], 'luma'),
		fxParam.number('blurMatte', 'Blur Matte', 0.224, { min: 0, softMax: 2, step: 0.001 }),
	],
	gpu: {
		time: { samples: timeDisplaceSamples },
		passes: (p, ctx) => [
			{
				output: 'tdMatte',
				scale: 0.5,
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec4 c = u_matte_size.x > 0.0 ? texture(u_matte, clamp(fx_layerNorm(), 0.0, 1.0)) : texture(u_source, v_uv);
  fragColor = vec4(vec3(u_matteUse == 1 ? c.a : fx_luma(c.rgb)), 1.0);
}`,
			},
			...gaussianBlurPasses({
				input: 'tdMatte',
				output: 'tdBlur',
				sigma: Math.max(0, num(p.blurMatte, 0.224)) * SAPPHIRE_BLUR_UNIT * ctx.height * ctx.pxScale,
				scale: 0.5,
			}),
			{
				include: [GLSL_FRAME_AT],
				frag: /* glsl */ `
void main() {
  float m = clamp(texture(u_tdBlur, v_uv).r, 0.0, 1.0);
  float d = mix(u_blackTimeShift, u_whiteTimeShift, m) - (u_shiftRelativeTo == 0 ? u_frame : 0.0);
  fragColor = ts_frameAt(d, u_interpFrames, v_uv);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_TimeSlice

export function timeSliceSamples(p: EffectParams, ctx: FxTimeContext): number[] {
	const n = Math.max(1, num(p.sliceNumber, 12));
	const fo = num(p.frameOffset, 0);
	return inSpan(
		frameAtOffsets(Math.floor(-n / 2 + fo), Math.ceil(n / 2 + fo), spreadOffsets),
		ctx.frame,
		ctx,
	);
}

export const S_TIME_SLICE = defineShaderEffect({
	...time,
	id: 'jasper.s.time-slice',
	label: 'S_TimeSlice',
	description:
		'Cuts the frame into slices, each showing a different frame of the clip (twisting slit-scan look).',
	keywords: ['slit scan', 'slices', 'time', 'twist', 'helix'],
	expensive: true,
	params: [
		fxParam.angle('sliceDirection', 'Slice Direction', 90),
		fxParam.number('sliceNumber', 'Slice Number', 12, { min: 1, softMax: 64, step: 0.1 }),
		fxParam.number(
			'frameOffset',
			'Frame Offset',
			0,
			{ softMin: -30, softMax: 30, step: 0.1 },
			{ unit: 'frames' },
		),
		fxParam.toggle('interpFrames', 'Interp Frames', false),
	],
	gpu: {
		time: { samples: timeSliceSamples },
		passes: [
			{
				include: [GLSL_UV, GLSL_FRAME_AT],
				frag: /* glsl */ `
void main() {
  vec2 box = u_box.zw / u_pxScale;
  vec2 dir = fx_dir(u_sliceDirection);
  float extent = abs(dir.x) * box.x + abs(dir.y) * box.y;
  float u = clamp(dot(fx_layerPx() - 0.5 * box, dir) / max(extent, 1.0) + 0.5, 0.0, 0.99999);
  float n = max(1.0, u_sliceNumber);
  float d = (u_interpFrames ? u * n : floor(u * n)) - floor(n * 0.5) + u_frameOffset;
  fragColor = ts_frameAt(d, u_interpFrames, v_uv);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_TimeWarpRGB

export function timeWarpOffsets(p: EffectParams): [number, number, number] {
	return [-int(p.redShiftFrames, 1), -int(p.greenShiftFrames, 0), -int(p.blueShiftFrames, -1)];
}

export const S_TIME_WARP_RGB = defineShaderEffect({
	...time,
	id: 'jasper.s.time-warp-rgb',
	label: 'S_TimeWarpRGB',
	description:
		'Shifts the red, green and blue channels in time by different frame counts (temporal chroma split).',
	keywords: ['rgb', 'chroma', 'split', 'channels', 'time', 'glitch'],
	params: [
		intParam('redShiftFrames', 'Red Shift Frames', 1, { softMin: -30, softMax: 30 }),
		intParam('greenShiftFrames', 'Green Shift Frames', 0, { softMin: -30, softMax: 30 }),
		intParam('blueShiftFrames', 'Blue Shift Frames', -1, { softMin: -30, softMax: 30 }),
		fxParam.number('clampChroma', 'Clamp Chroma', 1, { min: 0, max: 1, step: 0.001 }),
	],
	gpu: {
		time: {
			samples: (p, ctx) =>
				inSpan(
					timeWarpOffsets(p).filter((o) => o !== 0),
					ctx.frame,
					ctx,
				),
		},
		uniforms: (p) => {
			const [r, g, b] = timeWarpOffsets(p);
			return { u_twOffsets: [r, g, b] };
		},
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
vec4 tw_at(float o, vec4 src) {
  if (o == 0.0) return src;
  for (int i = 0; i < 8; i++) {
    if (i >= u_sampleCount) break;
    if (u_sampleOffsets[i] == o) return fx_sample(i, v_uv);
  }
  return src;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 r = tw_at(u_twOffsets.x, src), g = tw_at(u_twOffsets.y, src), b = tw_at(u_twOffsets.z, src);
  float a = src.a;
  vec3 c = vec3(fx_unpremultiply(r).r, fx_unpremultiply(g).g, fx_unpremultiply(b).b);
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  if (chroma > u_clampChroma) { float y = fx_luma(c); c = y + (c - y) * (u_clampChroma / chroma); }
  fragColor = vec4(clamp(c, 0.0, 1.0) * a, a);
}`,
			},
		],
	},
});

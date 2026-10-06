// "Sapphire other stylize" family — glitch effects: S_PixelSort and S_PixelMosh. Parameters follow Boris FX's public
// Sapphire documentation (AE/Premiere host), minus Mocha/preset/Opacity-handling params. Clean-room implementations.
//
// S_PixelSort on the GPU (no scatter, ≤ 12 intermediates, so no bitonic network): a SPAN-BASED GATHER. Every pixel
// finds its span on its sort line (the run of above/below-threshold pixels, cut by Randomly Restart Sort breaks and
// by a 512-step cap at hashed positions, so every pixel of a span agrees on its ends), builds a 64-bin histogram of
// the span's sort values, finds the bin holding its rank, and takes the colour of that bin's n-th pixel in line
// order. Exact up to the 64-level key quantisation (ties keep line order). Lines are parallel (Linear), rays from
// Center (Radial) or rings around Circle Center (Circular).
//
// S_PixelMosh (datamosh) from time samples: an automatic (seeded Frame Interval ± Vary) or manual hold frame plays
// the dropped I-frame; block motion vectors (Block Size X/Y macroblocks, SAD block matching between this frame and
// the previous one) are applied to the held picture once per frame since the hold — so it smears and "blooms" with
// the motion of the current shot. Approximation: the current motion field stands in for the per-frame fields of the
// whole interval (only 8 time samples); Pulse and AltFlowData are not implemented.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam, sapphireCommonParams } from '../params.ts';
import { fxRandom } from '../shader.ts';
import {
	blurPasses,
	clamp,
	GLSL_SSO_COMMON,
	GLSL_SSO_MASK,
	GLSL_SSO_MASK_ONLY,
	maskParams,
	num,
	sNum,
} from './common.ts';

const BIN = SAPPHIRE_BINS.stylize;

// ---------------------------------------------------------------- S_PixelSort

export const PIXEL_SORT_TYPES = [
	'monochrome',
	'average',
	'minimum',
	'maximum',
	'red',
	'green',
	'blue',
	'hue',
	'saturation',
	'brightness',
] as const;

/** Resolution scale of the sort pass: Downsample → Sort Resolution lines (of the canvas height), else 1. */
export function pixelSortScale(p: EffectParams, canvasHeight: number): number {
	if (p.downsample !== true) return 1;
	return clamp(Math.round(num(p.sortResolution, 720)) / Math.max(1, canvasHeight), 0.05, 1);
}

const PIXEL_SORT_FRAG = /* glsl */ `
const int SORT_MAXL = 512;
const int SORT_BINS = 64;
// The current pixel's sort line: an integer line id, its step index, and pos(t) in canvas px.
int g_line;
float g_L;          // canvas px per step (one texel of this pass)
vec2 g_o, g_dir, g_perp;
float g_thetaC;     // radial: angle of the ray
float g_rr;         // circular: ring radius (canvas px)
float g_a0;         // circular: start angle of the ring (radians)
int g_n;            // circular: steps around the ring

vec2 ps_pos(int t) {
  float ft = float(t) + 0.5;
  if (u_mode == 0) return g_o + ft * g_L * g_dir + (float(g_line) + 0.5) * g_L * g_perp;
  if (u_mode == 1) return g_o + ft * g_L * vec2(cos(g_thetaC), sin(g_thetaC));
  float a = g_a0 + ft / float(g_n) * 6.28318530718;
  return g_o + g_rr * vec2(cos(a), sin(a));
}
bool ps_region(int t) {
  float unit = sso_unit();
  if (u_mode == 1) {
    float r = (float(t) + 0.5) * g_L / unit;
    float start = u_innerRadius + u_varyRadius * fx_hash1(g_line, u_seed) * u_rayLength;
    float deg = mod(degrees(g_thetaC) - u_startAngle, 360.0);
    return r >= start && r <= start + u_rayLength && deg <= u_degreesSorted;
  }
  if (u_mode == 2) {
    float r = g_rr / unit;
    float arc = (float(t) + 0.5) / float(g_n) * 360.0;
    return t >= 0 && t < g_n && r >= u_circleInnerRadius && r <= u_circleInnerRadius + u_thickness
        && arc <= u_circleDegreesSorted;
  }
  return true;
}
// Sort value of step t (or −1 when t is not sortable: outside the layer, the region or the threshold mask).
float ps_key(int t) {
  if (!ps_region(t)) return -1.0;
  vec2 p = ps_pos(t);
  if (any(lessThan(p - u_box.xy, vec2(0.0))) || any(greaterThanEqual(p - u_box.xy, u_box.zw))) return -1.0;
  vec4 k = texture(u_keys, p / u_canvasSize);
  return k.g > 0.5 ? k.r : -1.0;
}
// A span ends before step t: a seeded random restart, or the length cap at a hashed phase of the line.
bool ps_breakBefore(int t) {
  float prob = u_randomlyRestartSort / 20000.0 * g_L;
  if (fx_hash3(ivec3(g_line, t, 17), u_seed) < prob) return true;
  int phase = int(fx_hash1(g_line, fract(u_seed + 0.37)) * float(SORT_MAXL));
  return (t + phase + 1048576) % SORT_MAXL == 0;
}
int ps_bin(float k) { return clamp(int(k * float(SORT_BINS)), 0, SORT_BINS - 1); }

void main() {
  vec2 p = v_uv * u_canvasSize;
  g_L = u_canvasSize.x / u_resolution.x;
  int t0;
  if (u_mode == 0) {
    g_o = u_box.xy + u_box.zw * 0.5;
    g_dir = fx_dir(u_sortAngle);
    g_perp = vec2(-g_dir.y, g_dir.x);
    vec2 d = p - g_o;
    g_line = int(floor(dot(d, g_perp) / g_L));
    t0 = int(floor(dot(d, g_dir) / g_L));
  } else if (u_mode == 1) {
    g_o = fx_uvOfLayerNorm(u_center) * u_canvasSize;
    vec2 d = p - g_o;
    float n = ceil(6.28318530718 * length(u_canvasSize) / g_L);
    float th = atan(d.y, d.x) + 3.14159265359;
    g_line = int(floor(th / 6.28318530718 * n));
    g_thetaC = (float(g_line) + 0.5) / n * 6.28318530718 - 3.14159265359;
    t0 = int(floor(length(d) / g_L));
  } else {
    g_o = fx_uvOfLayerNorm(u_circleCenter) * u_canvasSize;
    vec2 d = p - g_o;
    g_line = int(floor(length(d) / g_L));
    g_rr = (float(g_line) + 0.5) * g_L;
    g_n = max(1, int(floor(6.28318530718 * g_rr / g_L)));
    g_a0 = radians(u_circleStartAngle + u_varyStart * 360.0 * (fx_hash1(g_line, u_seed) - 0.5));
    float rel = mod(atan(d.y, d.x) - g_a0, 6.28318530718);
    t0 = int(floor(rel / 6.28318530718 * float(g_n)));
  }
  vec4 src = texture(u_source, v_uv);
  if (ps_key(t0) < 0.0) { fragColor = src; return; }

  // The span [s, e) around t0.
  int s = t0;
  for (int i = 1; i < SORT_MAXL; i++) {
    int t = t0 - i;
    if (ps_breakBefore(t + 1) || ps_key(t) < 0.0) break;
    s = t;
  }
  float hist[SORT_BINS];
  for (int b = 0; b < SORT_BINS; b++) hist[b] = 0.0;
  int e = s;
  for (int i = 0; i < SORT_MAXL; i++) {
    int t = s + i;
    float k = ps_key(t);
    if (i > 0 && (k < 0.0 || ps_breakBefore(t))) break;
    hist[ps_bin(k)] += 1.0;
    e = t + 1;
  }
  // The bin holding this step's rank: ascending along the line, or descending (Reverse Sort Direction).
  int idx = t0 - s;
  float acc = 0.0;
  int bin = 0;
  for (int i = 0; i < SORT_BINS; i++) {
    int b = u_reverseSortDirection ? SORT_BINS - 1 - i : i;
    bin = b;
    if (acc + hist[b] > float(idx)) break;
    acc += hist[b];
  }
  // Within the bin, ties keep their line order: take the bin's (idx − acc)-th pixel of the span.
  int want = idx - int(acc);
  vec4 col = src;
  for (int i = 0; i < SORT_MAXL; i++) {
    int t = s + i;
    if (t >= e) break;
    if (ps_bin(ps_key(t)) == bin) {
      if (want == 0) { col = texture(u_source, ps_pos(t) / u_canvasSize); break; }
      want--;
    }
  }
  fragColor = col;
}`;

export const S_PIXEL_SORT: EffectSpec = defineShaderEffect({
	id: 'jasper.s.pixel-sort',
	label: 'S_PixelSort',
	category: 'Stylize',
	bin: BIN,
	description:
		'Sorts the pixels over (or under) a threshold along lines: parallel (Linear, Sort Angle 90° = downwards), rays from a centre (Radial) or concentric circles (Circular). Radii in Sapphire units (1.0 = half the width).',
	keywords: ['pixel sorting', 'glitch', 'databend', 'streaks', 'sort'],
	expensive: true,
	params: [
		fxParam.choice(
			'mode',
			'Mode',
			['linear', 'radial', 'circular'],
			['Linear', 'Radial', 'Circular'],
			'linear',
		),
		fxParam.angle('sortAngle', 'Sort Angle', 90),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		fxParam.angle('startAngle', 'Start Angle', 0),
		sNum('degreesSorted', 'Degrees Sorted', 360, { min: 0, max: 360, step: 0.1 }),
		sNum('innerRadius', 'Inner Radius', 0.1, { min: 0, softMax: 2 }),
		sNum('rayLength', 'Ray Length', 0.8, { min: 0, softMax: 3 }),
		sNum('varyRadius', 'Vary Radius', 0.1, { min: 0, max: 1 }),
		fxParam.angle('circleStartAngle', 'Circle Start Angle', 0),
		sNum('circleDegreesSorted', 'Circle Degrees Sorted', 270, { min: 0, max: 360, step: 0.1 }),
		fxParam.point('circleCenter', 'Circle Center', [0.5, 0.5]),
		sNum('varyStart', 'Vary Start', 0.15, { min: 0, max: 1 }),
		sNum('circleInnerRadius', 'Circle Inner Radius', 0, { min: 0, softMax: 2 }),
		sNum('thickness', 'Thickness', 1.1, { min: 0, softMax: 3 }),
		sNum('threshold', 'Threshold', 0.3, { softMin: 0, softMax: 1 }),
		fxParam.choice(
			'sortDirection',
			'Sort Direction',
			['above', 'below'],
			['Sort Above Threshold', 'Sort Below Threshold'],
			'above',
		),
		fxParam.toggle('reverseSortDirection', 'Reverse Sort Direction', false),
		fxParam.choice(
			'sortType',
			'Sort Type',
			PIXEL_SORT_TYPES,
			[
				'Monochrome',
				'Average',
				'Minimum',
				'Maximum',
				'Red',
				'Green',
				'Blue',
				'Hue',
				'Saturation',
				'Brightness',
			],
			'monochrome',
		),
		sNum('randomlyRestartSort', 'Randomly Restart Sort', 100, { min: 0, max: 1000, step: 1 }),
		sNum('softenThresholdMask', 'Soften Threshold Mask', 0.1, { min: 0, softMax: 1 }),
		fxParam.toggle('downsample', 'Downsample', false),
		fxParam.number(
			'sortResolution',
			'Sort Resolution',
			720,
			{ min: 16, max: 8192, step: 1 },
			{ animatable: false },
		),
		...sapphireCommonParams({ seed: true, show: [{ value: 'rawSort', label: 'Raw Sort Values' }] }),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const scale = pixelSortScale(p, ctx.height * ctx.pxScale);
			// Soften Threshold Mask: 1.0 = a sigma of 2 % of the layer width.
			const soften = Math.max(0, num(p.softenThresholdMask, 0.1)) * 0.02 * ctx.width * ctx.pxScale;
			return [
				{
					// r = sort value, g = threshold mask (× the Mask input, Sapphire's "Post-threshold").
					output: 'keys',
					filter: 'nearest',
					include: [GLSL_SSO_COMMON, GLSL_SSO_MASK_ONLY],
					frag: /* glsl */ `
void main() {
  vec4 s = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(s).rgb;
  vec3 hsv = fx_rgb2hsv(c);
  float k = u_sortType == 0 ? fx_luma(c) : u_sortType == 1 ? (c.r + c.g + c.b) / 3.0
          : u_sortType == 2 ? min(c.r, min(c.g, c.b)) : u_sortType == 3 ? max(c.r, max(c.g, c.b))
          : u_sortType == 4 ? c.r : u_sortType == 5 ? c.g : u_sortType == 6 ? c.b
          : u_sortType == 7 ? hsv.x : u_sortType == 8 ? hsv.y : hsv.z;
  bool pass = u_sortDirection == 0 ? k > u_threshold : k < u_threshold;
  float m = pass && s.a > 0.0 && fx_inBox(v_uv) ? step(0.5, sso_mask()) : 0.0;
  fragColor = vec4(clamp(k, 0.0, 1.0), m, 0.0, 1.0);
}`,
				},
				...blurPasses({ input: 'keys', output: 'soft', sigmaX: soften }),
				{
					output: 'sorted',
					scale,
					include: [GLSL_SSO_COMMON, GLSL_HASH, GLSL_UV],
					frag: PIXEL_SORT_FRAG,
				},
				{
					include: [GLSL_SSO_COMMON, GLSL_SSO_MASK_ONLY],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 k = texture(u_keys, v_uv);
  if (u_show == 2) { fragColor = fx_matteView(k.r); return; }
  float soft = clamp(texture(u_soft, v_uv).g, 0.0, 1.0);
  vec4 result = mix(src, texture(u_sorted, v_uv), soft);
  fragColor = fx_finish(result, src, k.g, u_mixWithOriginal, u_show);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- S_PixelMosh

/**
 * The hold frame ("dropped I-frame") in effect at clip-local `frame`: automatic = seeded intervals of Frame Interval
 * frames varied by ± Vary Frame Interval, from frame 0; manual = Flow Warp Hold Frame. Never after `frame`.
 */
export function pixelMoshHoldFrame(p: EffectParams, frame: number, seed: number): number {
	const f = Math.floor(frame);
	if (f <= 0) return f;
	if (p.varyHoldFrame === 'manual') return Math.min(f, Math.max(0, Math.floor(num(p.flowWarpHoldFrame))));
	const interval = Math.max(1, num(p.frameInterval, 15));
	const vary = clamp(num(p.varyFrameInterval, 0.7), 0, 1);
	let h = 0;
	for (let k = 0; k < 1_000_000; k++) {
		const len = Math.max(1, Math.round(interval * (1 + vary * (2 * fxRandom(seed, k) - 1))));
		if (h + len > f) break;
		h += len;
	}
	return h;
}

/** Time samples of S_PixelMosh: the previous frame (motion) and the hold frame (when they differ). */
export function pixelMoshSamples(p: EffectParams, frame: number, seed: number): number[] {
	if (p.useFlowWarp === false) return [];
	const elapsed = Math.floor(frame) - pixelMoshHoldFrame(p, frame, seed);
	if (elapsed < 1) return [];
	return elapsed === 1 ? [-1] : [-1, -elapsed];
}

/** Macroblock size in canvas px. */
export function pixelMoshBlockPx(p: EffectParams, pxScale: number): [number, number] {
	return [
		Math.max(4, Math.round(num(p.blockSizeX, 32))) * pxScale,
		Math.max(4, Math.round(num(p.blockSizeY, 32))) * pxScale,
	];
}

const MOSH_MAXR = 48; // encoded motion range (canvas px per frame)

export const S_PIXEL_MOSH: EffectSpec = defineShaderEffect({
	id: 'jasper.s.pixel-mosh',
	label: 'S_PixelMosh',
	category: 'Stylize',
	bin: BIN,
	description:
		'Datamosh: a held frame (the dropped I-frame) is pushed around by the macroblock motion of the following frames, so the old picture smears and blooms with the new motion. Uses earlier frames (time samples): put it first in the stack.',
	keywords: ['datamosh', 'glitch', 'compression', 'macroblock', 'i-frame', 'mosh', 'bloom'],
	expensive: true,
	params: [
		fxParam.choice(
			'varyHoldFrame',
			'Vary Hold Frame',
			['automatic', 'manual'],
			['Automatic', 'Manual'],
			'automatic',
		),
		fxParam.toggle('useFlowWarp', 'Use Flow Warp', true),
		fxParam.number(
			'frameInterval',
			'Frame Interval',
			15,
			{ min: 1, softMax: 120, step: 1 },
			{ unit: 'frames' },
		),
		sNum('varyFrameInterval', 'Vary Frame Interval', 0.7, { min: 0, max: 1 }),
		fxParam.number(
			'flowWarpHoldFrame',
			'Flow Warp Hold Frame',
			0,
			{ min: 0, softMax: 300, step: 1 },
			{ unit: 'frames' },
		),
		fxParam.number(
			'blockSizeX',
			'Block Size X',
			32,
			{ min: 4, max: 256, softMax: 128, step: 1 },
			{ unit: 'px' },
		),
		fxParam.number(
			'blockSizeY',
			'Block Size Y',
			32,
			{ min: 4, max: 256, softMax: 128, step: 1 },
			{ unit: 'px' },
		),
		sNum('flowWarpScale', 'Flow Warp Scale', 1, { softMin: -2, softMax: 4 }),
		sNum('flowFieldSmoothness', 'Flow Field Smoothness', 0.8, { min: 0, softMax: 1 }),
		...sapphireCommonParams({ seed: true, show: [{ value: 'flow', label: 'Flow Vectors' }] }),
		...maskParams(),
	],
	gpu: {
		time: { samples: (p, ctx) => pixelMoshSamples(p, ctx.frame, ctx.seed) },
		uniforms: (p, ctx) => {
			const elapsed = Math.floor(ctx.frame) - pixelMoshHoldFrame(p, ctx.frame, ctx.seed);
			return {
				u_elapsed: Math.max(0, elapsed),
				u_holdIndex: { int: elapsed === 1 ? 0 : 1 },
				u_blockPx: pixelMoshBlockPx(p, ctx.pxScale),
			};
		},
		passes: (p, ctx) => {
			const [bx, by] = pixelMoshBlockPx(p, ctx.pxScale);
			const scale = clamp(1 / Math.min(bx, by), 0.004, 1);
			const decode = `vec2 pm_decode(vec4 e) { return (e.rg - 0.5) * ${(2 * MOSH_MAXR).toFixed(1)}; }`;
			return [
				{
					// Block matching: the displacement d (canvas px) minimising the SAD between this block and the
					// previous frame at −d (coarse ±R grid, then refined); encoded in rg.
					output: 'motion',
					scale,
					filter: 'nearest',
					include: [GLSL_SSO_COMMON],
					frag: /* glsl */ `
float pm_sad(vec2 o, vec2 d) {
  float s = 0.0;
  for (int j = 0; j < 16; j++) {
    vec2 q = o + (vec2(float(j % 4), float(j / 4)) + 0.5) * u_blockPx * 0.25;
    float a = fx_luma(fx_unpremultiply(texture(u_source, sso_uvOfBoxPx(q))).rgb);
    float b = fx_luma(fx_unpremultiply(fx_sample(0, sso_uvOfBoxPx(q - d))).rgb);
    s += abs(a - b);
  }
  return s;
}
void main() {
  if (u_sampleCount == 0) { fragColor = vec4(0.5, 0.5, 0.0, 1.0); return; }
  vec2 o = floor(sso_boxPx() / u_blockPx) * u_blockPx;
  float R = min(${MOSH_MAXR.toFixed(1)} - 1.0, max(u_blockPx.x, u_blockPx.y) * 1.25);
  float step0 = R / 8.0;
  vec2 best = vec2(0.0);
  float bestCost = pm_sad(o, best);
  for (int y = -8; y <= 8; y++) for (int x = -8; x <= 8; x++) {
    vec2 d = vec2(float(x), float(y)) * step0;
    float c = pm_sad(o, d) + 0.04 * length(d) / R;
    if (c < bestCost) { bestCost = c; best = d; }
  }
  vec2 centre = best;
  float step1 = step0 / 4.0;
  for (int y = -4; y <= 4; y++) for (int x = -4; x <= 4; x++) {
    vec2 d = centre + vec2(float(x), float(y)) * step1;
    float c = pm_sad(o, d) + 0.04 * length(d) / R;
    if (c < bestCost) { bestCost = c; best = d; }
  }
  fragColor = vec4(best / ${(2 * MOSH_MAXR).toFixed(1)} + 0.5, 0.0, 1.0);
}`,
				},
				{
					// Flow Field Smoothness: mixes each block's vector with the mean of its 3×3 neighbourhood.
					output: 'flow',
					scale,
					filter: 'nearest',
					include: [GLSL_SSO_COMMON],
					frag: /* glsl */ `
${decode}
void main() {
  vec2 c = (floor(sso_boxPx() / u_blockPx) + 0.5) * u_blockPx;
  vec2 sum = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 q = clamp(c + vec2(float(x), float(y)) * u_blockPx, vec2(0.5), u_box.zw - 0.5);
    sum += pm_decode(texture(u_motion, sso_uvOfBoxPx(q)));
  }
  vec2 v = mix(pm_decode(texture(u_motion, sso_uvOfBoxPx(c))), sum / 9.0, clamp(u_flowFieldSmoothness, 0.0, 1.0));
  fragColor = vec4(v / ${(2 * MOSH_MAXR).toFixed(1)} + 0.5, 0.0, 1.0);
}`,
				},
				{
					include: [GLSL_SSO_COMMON, GLSL_SSO_MASK],
					frag: /* glsl */ `
${decode}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_show == 2) {
    vec2 v = pm_decode(texture(u_flow, v_uv)) / ${MOSH_MAXR.toFixed(1)};
    float ang = atan(v.y, v.x) / 6.28318530718 + 0.5;
    fragColor = vec4(fx_hsv2rgb(vec3(ang, clamp(length(v) * 4.0, 0.0, 1.0), 1.0)), 1.0);
    return;
  }
  if (u_sampleCount == 0 || !u_useFlowWarp || u_elapsed < 0.5) { fragColor = sso_finish(src, src, -1.0); return; }
  // The held picture advected by the block motion once per frame since the hold.
  vec2 q = sso_boxPx();
  int k = int(min(u_elapsed, 96.0));
  for (int i = 0; i < 96; i++) {
    if (i >= k) break;
    q -= pm_decode(texture(u_flow, sso_uvOfBoxPx(clamp(q, vec2(0.5), u_box.zw - 0.5)))) * u_flowWarpScale;
  }
  q = clamp(q, vec2(0.5), u_box.zw - 0.5);
  vec4 held = fx_sample(u_holdIndex, sso_uvOfBoxPx(q));
  fragColor = sso_finish(fx_inBox(v_uv) ? held : src, src, -1.0);
}`,
				},
			];
		},
	},
});

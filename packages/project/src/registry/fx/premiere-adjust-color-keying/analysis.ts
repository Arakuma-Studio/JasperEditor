// Frame-analysing Premiere effects (fx family premiere-adjust-color-keying): Auto Color, Auto Contrast, Auto Levels
// (Adjust) and Equalize (Color Correction). Each frame is reduced on the GPU: a box-averaged thumbnail of the layer
// (≈ 96 px long side, `analysisThumbPass`), then tiny statistics passes that loop over the thumbnail (percentiles by
// bisection, dark/light colours, neutral midtones, cumulative histograms), then the full-size correction pass.
// Approximations: statistics come from the thumbnail (≈ 5k samples; clip percentages below ~0.02 % act like one
// sample), and Premiere's Temporal Smoothing / Scene Detect are not offered (no state between frames: each frame is
// analysed on its own — see the family report).
import { defineShaderEffect } from '../define.ts';
import { fxParam } from '../params.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';
import { analysisThumbPass, blendWithOriginalParam, GLSL_PACG, popup, slider, statsScale } from './common.ts';

/**
 * Thumbnail statistics (loops over `u_thumb`: rgb = straight colour, a = coverage). Flat loops with dynamic bounds
 * (`u_statIters` bisection steps) keep the programs small: software GL (SwiftShader) unrolls constant loops.
 */
const GLSL_PACG_STATS: GlslChunk = {
	name: 'pacg/stats',
	source: /* glsl */ `
int pacg_thumbCount() { ivec2 s = textureSize(u_thumb, 0); return s.x * s.y; }
vec4 pacg_thumb(int i) { int w = textureSize(u_thumb, 0).x; return texelFetch(u_thumb, ivec2(i - (i / w) * w, i / w), 0); }
// The statistic's value of a thumbnail texel: mode 0 = per channel, 1 = luma (in every component).
vec3 pacg_statValue(vec4 t, int mode) { return mode == 1 ? vec3(fx_luma(t.rgb)) : t.rgb; }
// Fraction of covered texels below v (per component).
vec3 pacg_fracBelow(vec3 v, int mode) {
  int n = pacg_thumbCount();
  vec3 below = vec3(0.0);
  float cnt = 0.0;
  for (int i = 0; i < n; i++) {
    vec4 t = pacg_thumb(i);
    if (t.a < 0.5) continue;
    below += vec3(lessThan(pacg_statValue(t, mode), v));
    cnt += 1.0;
  }
  return cnt > 0.0 ? below / cnt : vec3(0.0);
}
// Value at the fraction frac of the covered texels, by bisection: per component, or pooled over R, G and B.
vec3 pacg_percentile(float frac, int mode, bool pooled) {
  vec3 lo = vec3(0.0), hi = vec3(1.0);
  for (int i = 0; i < u_statIters; i++) {
    vec3 mid = (lo + hi) * 0.5;
    vec3 f = pacg_fracBelow(mid, mode);
    if (pooled) f = vec3((f.r + f.g + f.b) / 3.0);
    vec3 up = step(f, vec3(frac));
    lo = mix(lo, mid, up);
    hi = mix(mid, hi, up);
  }
  return (lo + hi) * 0.5;
}
// Mean colour of the covered texels with luma in [a, b] (fallback: vec3(fallback)).
vec3 pacg_meanInLuma(float a, float b, float fallback) {
  int n = pacg_thumbCount();
  vec3 sum = vec3(0.0);
  float cnt = 0.0;
  for (int i = 0; i < n; i++) {
    vec4 t = pacg_thumb(i);
    float l = fx_luma(t.rgb);
    if (t.a < 0.5 || l < a || l > b) continue;
    sum += t.rgb;
    cnt += 1.0;
  }
  return cnt > 0.0 ? sum / cnt : vec3(fallback);
}
`,
};

/** Fixed clip percentage → fraction (Premiere's Black/White Clip are 0..10 %). */
const clipParams = () => [
	slider('blackClip', 'Black Clip', 0.1, 0, 10, { unit: '%', step: 0.01 }),
	slider('whiteClip', 'White Clip', 0.1, 0, 10, { unit: '%', step: 0.01 }),
];

const statsPass = (ctx: FxPlanContext, output: string, frag: string): ShaderPass => ({
	output,
	scale: statsScale(ctx),
	format: 'rgba16f',
	filter: 'nearest',
	include: [GLSL_PACG, GLSL_PACG_STATS],
	uniforms: { u_statIters: { int: 10 } },
	frag,
});

/** The correction pass: maps each channel from [lo, hi] to [0, 1] (+ optional per-channel gamma), blended. */
const levelsFrag = (gamma: boolean) => /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  vec3 lo = texelFetch(u_lo, ivec2(0), 0).rgb;
  vec3 hi = texelFetch(u_hi, ivec2(0), 0).rgb;
  vec3 r = clamp((c - lo) / max(hi - lo, vec3(1.0 / 255.0)), 0.0, 1.0);
  ${gamma ? 'r = pow(r, texelFetch(u_mid, ivec2(0), 0).rgb);' : ''}
  vec3 outc = mix(r, c, u_blendWithOriginal / 100.0);
  fragColor = fx_premultiply(vec4(outc, src.a));
}`;

export const AUTO_COLOR = defineShaderEffect({
	id: 'jasper.auto-color',
	label: 'Auto Color',
	category: 'Adjust',
	description:
		'Neutralises colour casts by mapping the darkest and lightest colours of each frame to black and white (analysed per frame).',
	keywords: ['auto', 'white balance', 'color cast', 'neutralize', 'levels'],
	params: [
		...clipParams(),
		fxParam.toggle('snapNeutralMidtones', 'Snap Neutral Midtones', false),
		blendWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: (_p, ctx) => [
			analysisThumbPass(ctx),
			statsPass(
				ctx,
				'lo',
				/* glsl */ `
void main() {
  float t = pacg_percentile(u_blackClip / 100.0, 1, false).x;
  fragColor = vec4(pacg_meanInLuma(0.0, t + 1.0 / 255.0, 0.0), 1.0);
}`,
			),
			statsPass(
				ctx,
				'hi',
				/* glsl */ `
void main() {
  float t = pacg_percentile(1.0 - u_whiteClip / 100.0, 1, false).x;
  fragColor = vec4(pacg_meanInLuma(t - 1.0 / 255.0, 1.0, 1.0), 1.0);
}`,
			),
			statsPass(
				ctx,
				'mid',
				/* glsl */ `
void main() {
  vec3 g = vec3(1.0);
  if (u_snapNeutralMidtones) {
    vec3 lo = texelFetch(u_lo, ivec2(0), 0).rgb;
    vec3 hi = texelFetch(u_hi, ivec2(0), 0).rgb;
    // Mean of the nearly neutral midtones after the levels mapping; per-channel gamma makes it grey.
    int count = pacg_thumbCount();
    vec3 sum = vec3(0.0);
    float n = 0.0;
    for (int i = 0; i < count; i++) {
        vec4 t = pacg_thumb(i);
        if (t.a < 0.5) continue;
        vec3 r = clamp((t.rgb - lo) / max(hi - lo, vec3(1.0 / 255.0)), 0.0, 1.0);
        float l = fx_luma(r);
        float sat = max(r.r, max(r.g, r.b)) - min(r.r, min(r.g, r.b));
        if (l < 0.2 || l > 0.85 || sat > 0.12) continue;
        sum += r;
        n += 1.0;
      }
    if (n > 0.0) {
      vec3 m = clamp(sum / n, 0.02, 0.98);
      float target = (m.r + m.g + m.b) / 3.0;
      g = clamp(log(vec3(target)) / log(m), 0.5, 2.0);
    }
  }
  fragColor = vec4(g, 1.0);
}`,
			),
			{ include: [GLSL_PACG], frag: levelsFrag(true) },
		],
	},
});

export const AUTO_CONTRAST = defineShaderEffect({
	id: 'jasper.auto-contrast',
	label: 'Auto Contrast',
	category: 'Adjust',
	description:
		'Stretches the overall contrast of each frame (one black and white point for all channels, so colours are not shifted).',
	keywords: ['auto', 'contrast', 'levels', 'stretch'],
	params: [...clipParams(), blendWithOriginalParam()],
	gpu: {
		timeInvariant: true,
		passes: (_p, ctx) => [
			analysisThumbPass(ctx),
			statsPass(
				ctx,
				'lo',
				'void main() { fragColor = vec4(pacg_percentile(u_blackClip / 100.0, 0, true), 1.0); }',
			),
			statsPass(
				ctx,
				'hi',
				'void main() { fragColor = vec4(pacg_percentile(1.0 - u_whiteClip / 100.0, 0, true), 1.0); }',
			),
			{ include: [GLSL_PACG], frag: levelsFrag(false) },
		],
	},
});

export const AUTO_LEVELS = defineShaderEffect({
	id: 'jasper.auto-levels',
	label: 'Auto Levels',
	category: 'Adjust',
	description:
		'Maps the lightest and darkest values of each colour channel to white and black (per channel; may shift colour casts).',
	keywords: ['auto', 'levels', 'histogram', 'stretch'],
	params: [...clipParams(), blendWithOriginalParam()],
	gpu: {
		timeInvariant: true,
		passes: (_p, ctx) => [
			analysisThumbPass(ctx),
			statsPass(
				ctx,
				'lo',
				'void main() { fragColor = vec4(pacg_percentile(u_blackClip / 100.0, 0, false), 1.0); }',
			),
			statsPass(
				ctx,
				'hi',
				'void main() { fragColor = vec4(pacg_percentile(1.0 - u_whiteClip / 100.0, 0, false), 1.0); }',
			),
			{ include: [GLSL_PACG], frag: levelsFrag(false) },
		],
	},
});

/** Scale of the cumulative-histogram pass: ≥ 256 texels (one per 8-bit level) on the canvas. */
export function equalizeLutScale(ctx: FxPlanContext): number {
	const w = Math.max(1, ctx.width * ctx.pxScale);
	const h = Math.max(1, ctx.height * ctx.pxScale);
	return Math.min(1, Math.max(1e-3, Math.sqrt(320 / (w * h))));
}

export const EQUALIZE = defineShaderEffect({
	id: 'jasper.equalize',
	label: 'Equalize',
	category: 'Color Correction',
	description:
		'Redistributes brightness or colour values so they cover the full range evenly (histogram equalisation per frame).',
	keywords: ['histogram', 'equalization', 'auto', 'contrast'],
	params: [
		popup('equalize', 'Equalize', [
			['rgb', 'RGB'],
			['brightness', 'Brightness'],
			['photoshop', 'Photoshop Style'],
		]),
		fxParam.percent('amountToEqualize', 'Amount to Equalize', 100),
	],
	gpu: {
		timeInvariant: true,
		passes: (_p, ctx) => [
			analysisThumbPass(ctx),
			{
				// Texel i (row-major) = level i/255: cumulative fraction of samples ≤ level for R, G, B and luma.
				output: 'cdf',
				scale: equalizeLutScale(ctx),
				format: 'rgba16f',
				filter: 'nearest',
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  ivec2 me = ivec2(v_uv * u_resolution);
  int level = me.y * int(u_resolution.x) + me.x;
  if (level > 255) { fragColor = vec4(1.0); return; }
  float v = (float(level) + 0.5) / 255.0;
  int count = textureSize(u_thumb, 0).x * textureSize(u_thumb, 0).y;
  int tw = textureSize(u_thumb, 0).x;
  vec4 below = vec4(0.0);
  float n = 0.0;
  for (int i = 0; i < count; i++) {
      vec4 t = texelFetch(u_thumb, ivec2(i - (i / tw) * tw, i / tw), 0);
      if (t.a < 0.5) continue;
      below += vec4(lessThan(vec4(t.rgb, fx_luma(t.rgb)), vec4(v)));
      n += 1.0;
    }
  fragColor = n > 0.0 ? below / n : vec4(float(level) / 255.0);
}`,
			},
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
vec4 cdfAt(float x) {
  int w = textureSize(u_cdf, 0).x;
  int level = int(clamp(floor(x * 255.0 + 0.5), 0.0, 255.0));
  return texelFetch(u_cdf, ivec2(level - (level / w) * w, level / w), 0);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  vec3 e;
  if (u_equalize == 0) {
    e = vec3(cdfAt(c.r).r, cdfAt(c.g).g, cdfAt(c.b).b);
  } else if (u_equalize == 1) {
    float y = fx_luma(c);
    float ye = cdfAt(y).a;
    e = y > 1.0e-4 ? c * (ye / y) : vec3(ye);
    float m = max(e.r, max(e.g, e.b));
    if (m > 1.0) e = mix(vec3(ye), e, (1.0 - ye) / max(m - ye, 1.0e-4));
  } else {
    vec4 a = cdfAt(c.r), b = cdfAt(c.g), d = cdfAt(c.b);
    e = vec3((a.r + a.g + a.b), (b.r + b.g + b.b), (d.r + d.g + d.b)) / 3.0;
  }
  vec3 outc = mix(c, clamp(e, 0.0, 1.0), u_amountToEqualize / 100.0);
  fragColor = fx_premultiply(vec4(outc, src.a));
}`,
			},
		],
	},
});

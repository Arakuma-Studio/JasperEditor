// Premiere Pro "Blur & Sharpen" video effects (fx family premiere-adjust-color-keying): Camera Blur, Channel Blur,
// Compound Blur, Directional Blur, Reduce Interlace Flicker, Sharpen, Unsharp Mask. (Gaussian Blur already exists
// as jasper.gaussian-blur.) Blur sizes are layer pixels (Gaussian σ for "Blurriness", like jasper.gaussian-blur);
// wide blurs run on downscaled passes.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxPlanContext, ShaderPass } from '../shader.ts';
import { bool, GLSL_PACG, num, popup, slider } from './common.ts';

/** Downscale factor for a blur of `sigma` canvas px (keeps ≤ ~16 px of blur per full-res texel budget). */
export const blurScale = (sigma: number) => (sigma > 48 ? 0.25 : sigma > 12 ? 0.5 : 1);

// ---------------------------------------------------------------- Camera Blur

/** Camera Blur's lens-disc radius in layer px for a Percent Blur (100 % ≈ 4 % of the layer's long side). */
export function cameraBlurRadius(p: EffectParams, ctx: Pick<FxPlanContext, 'width' | 'height'>): number {
	return (Math.max(0, num(p.percentBlur)) / 100) * 0.04 * Math.max(ctx.width, ctx.height);
}

export const CAMERA_BLUR = defineShaderEffect({
	id: 'jasper.camera-blur',
	label: 'Camera Blur',
	category: 'Blur & Sharpen',
	description:
		'Simulates an out-of-focus lens: a disc-shaped (bokeh) blur in which bright highlights bloom into round spots.',
	keywords: ['defocus', 'lens blur', 'bokeh', 'out of focus', 'depth of field'],
	expensive: true,
	params: [slider('percentBlur', 'Percent Blur', 0, 0, 100, { unit: '%' })],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_discRadius: cameraBlurRadius(p, ctx) * ctx.pxScale }),
		passes: (p, ctx) => {
			const r = cameraBlurRadius(p, ctx) * ctx.pxScale;
			const scale = r > 24 ? 0.5 : 1;
			return [
				{
					output: 'pre',
					scale,
					frag: 'void main() { fragColor = texture(u_source, v_uv); }',
				},
				{
					include: [GLSL_PACG],
					frag: /* glsl */ `
void main() {
  if (u_discRadius < 0.5) { fragColor = texture(u_source, v_uv); return; }
  // Golden-angle spiral over the lens disc (uniform area density); bright taps weigh more, so highlights bloom
  // into round bokeh spots as with a real defocused lens.
  vec2 rpx = vec2(u_discRadius) / u_canvasSize;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  const int N = 96;
  for (int i = 0; i < N; i++) {
    float k = (float(i) + 0.5) / float(N);
    float a = float(i) * 2.39996323;
    vec4 t = texture(u_pre, v_uv + sqrt(k) * vec2(cos(a), sin(a)) * rpx);
    float w = 1.0 + 6.0 * smoothstep(0.7, 1.0, fx_luma(pacg_straight(t))) * t.a;
    sum += t * w;
    wsum += w;
  }
  vec4 c = sum / wsum;
  fragColor = vec4(min(c.rgb, vec3(c.a)), c.a);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- Channel Blur

/** Channel Blur's per-channel σ (layer px) for R, G, B, A. */
export function channelBlurSigmas(p: EffectParams): [number, number, number, number] {
	const s = (n: string) => Math.max(0, num(p[n]));
	return [s('redBlurriness'), s('greenBlurriness'), s('blueBlurriness'), s('alphaBlurriness')];
}

const channelBlurFrag = (tex: string) => /* glsl */ `
vec4 tap(vec2 uv) {
  if (u_repeatEdge) {
    vec2 lo = (u_box.xy + 0.5) / u_canvasSize;
    vec2 hi = (u_box.xy + u_box.zw - 0.5) / u_canvasSize;
    return texture(${tex}, clamp(uv, lo, hi));
  }
  return texture(${tex}, uv);
}
void main() {
  vec4 sig = u_cbSigma * (u_resolution.x / u_canvasSize.x) * u_cbOn;
  float smax = max(max(sig.r, sig.g), max(sig.b, sig.a));
  vec4 c0 = tap(v_uv);
  if (smax < 0.05) { fragColor = c0; return; }
  float radius = ceil(smax * 3.0);
  float stride = max(1.0, radius / 48.0);
  vec4 sum = c0;
  vec4 wsum = vec4(1.0);
  for (int i = 1; i <= 48; i++) {
    float x = float(i) * stride;
    if (x > radius) break;
    vec4 w = exp(-0.5 * x * x / max(sig * sig, vec4(1.0e-4)));
    w = mix(vec4(0.0), w, step(vec4(0.05), sig));
    vec2 o = u_cbDir * u_texel * x;
    sum += (tap(v_uv + o) + tap(v_uv - o)) * w;
    wsum += 2.0 * w;
  }
  fragColor = sum / wsum;
}`;

export const CHANNEL_BLUR = defineShaderEffect({
	id: 'jasper.channel-blur',
	label: 'Channel Blur',
	category: 'Blur & Sharpen',
	description: 'Blurs the red, green, blue and alpha channels separately (colour fringes, soft alpha).',
	keywords: ['blur', 'rgb split', 'chromatic', 'channel'],
	expensive: true,
	params: [
		slider('redBlurriness', 'Red Blurriness', 0, 0, 500, { softMax: 100, unit: 'px' }),
		slider('greenBlurriness', 'Green Blurriness', 0, 0, 500, { softMax: 100, unit: 'px' }),
		slider('blueBlurriness', 'Blue Blurriness', 0, 0, 500, { softMax: 100, unit: 'px' }),
		slider('alphaBlurriness', 'Alpha Blurriness', 0, 0, 500, { softMax: 100, unit: 'px' }),
		fxParam.toggle('repeatEdge', 'Edge Behavior: Repeat Edge Pixels', false),
		popup('blurDimensions', 'Blur Dimensions', [
			['both', 'Horizontal and Vertical'],
			['horizontal', 'Horizontal'],
			['vertical', 'Vertical'],
		]),
	],
	gpu: {
		timeInvariant: true,
		padding: (p) => (bool(p.repeatEdge) ? 0 : 3 * Math.max(...channelBlurSigmas(p))),
		uniforms: (p, ctx) => ({
			u_cbSigma: channelBlurSigmas(p).map((s) => s * ctx.pxScale) as [number, number, number, number],
		}),
		passes: (p, ctx) => {
			const sMax = Math.max(...channelBlurSigmas(p)) * ctx.pxScale;
			const scale = blurScale(sMax);
			const dims = String(p.blurDimensions ?? 'both');
			const h = dims !== 'vertical' ? 1 : 0;
			const v = dims !== 'horizontal' ? 1 : 0;
			return [
				{
					output: 'blurH',
					scale,
					include: [GLSL_PACG],
					frag: channelBlurFrag('u_source'),
					uniforms: { u_cbDir: [1, 0], u_cbOn: h },
				},
				{
					output: 'blurV',
					scale,
					include: [GLSL_PACG],
					frag: channelBlurFrag('u_blurH'),
					uniforms: { u_cbDir: [0, 1], u_cbOn: v },
				},
				{
					frag: /* glsl */ `
void main() {
  vec4 c = texture(u_blurV, v_uv);
  fragColor = vec4(min(c.rgb, vec3(c.a)), c.a);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- Compound Blur

export const COMPOUND_BLUR = defineShaderEffect({
	id: 'jasper.compound-blur',
	label: 'Compound Blur',
	category: 'Blur & Sharpen',
	description:
		'Blurs the clip by an amount that varies per pixel with the luminance of a blur layer (white = Maximum Blur).',
	keywords: ['variable blur', 'depth of field', 'blur map', 'depth map'],
	expensive: true,
	params: [
		fxParam.media('blurLayer', 'Blur Layer'),
		slider('maximumBlur', 'Maximum Blur', 20, 0, 500, { softMax: 100, unit: 'px' }),
		fxParam.toggle('stretchMapToFit', 'If Layer Sizes Differ: Stretch Map to Fit', true),
		fxParam.toggle('invertBlur', 'Invert Blur', false),
	],
	gpu: {
		passes: (p, ctx) => {
			const m = Math.max(0, num(p.maximumBlur, 20)) * ctx.pxScale;
			const levels = [m / 4, m / 2, m];
			const passes: ShaderPass[] = levels.flatMap((s, i) =>
				gaussianBlurPasses({ input: 'source', output: `lv${i + 1}`, sigma: s, scale: blurScale(s) }),
			);
			passes.push({
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_blurLayer_size.x <= 0.0) { fragColor = src; return; }
  vec4 m = pacg_media(u_blurLayer, u_blurLayer_size, u_stretchMapToFit);
  float t = clamp(fx_luma(pacg_straight(m)) * m.a, 0.0, 1.0);
  if (u_invertBlur) t = 1.0 - t;
  // σ = t × max, interpolated between the pre-blurred levels 0, ¼, ½, 1 of the maximum.
  vec4 l1 = texture(u_lv1, v_uv), l2 = texture(u_lv2, v_uv), l3 = texture(u_lv3, v_uv);
  vec4 c = t < 0.25 ? mix(src, l1, t / 0.25) : t < 0.5 ? mix(l1, l2, (t - 0.25) / 0.25) : mix(l2, l3, (t - 0.5) / 0.5);
  fragColor = c;
}`,
			});
			return passes;
		},
	},
});

// ---------------------------------------------------------------- Directional Blur

/** Unit vector of a Premiere direction (0° = up/down axis, clockwise). */
export function premiereDirection(deg: number): [number, number] {
	const a = (deg * Math.PI) / 180;
	return [Math.sin(a), -Math.cos(a)];
}

export const DIRECTIONAL_BLUR = defineShaderEffect({
	id: 'jasper.directional-blur',
	label: 'Directional Blur',
	category: 'Blur & Sharpen',
	description: 'Motion-style blur along one direction (0° = vertical), equally on both sides of each pixel.',
	keywords: ['motion blur', 'streak', 'linear blur', 'speed'],
	expensive: true,
	params: [
		fxParam.angle('direction', 'Direction', 0),
		slider('blurLength', 'Blur Length', 0, 0, 1000, { softMax: 100, unit: 'px' }),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => {
			const [x, y] = premiereDirection(num(p.direction));
			const len = Math.max(0, num(p.blurLength)) * ctx.pxScale;
			return { u_dbStep: [x * len, y * len] };
		},
		passes: [
			{
				// Box over ±length with 32 taps, then a box over one tap spacing (fills the gaps between taps).
				output: 'coarse',
				frag: /* glsl */ `
void main() {
  vec2 d = u_dbStep / u_canvasSize;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 33; i++) sum += texture(u_source, v_uv + d * (float(i) / 16.0 - 1.0));
  fragColor = sum / 33.0;
}`,
			},
			{
				frag: /* glsl */ `
void main() {
  vec2 d = u_dbStep / u_canvasSize / 16.0;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 9; i++) sum += texture(u_coarse, v_uv + d * (float(i) / 8.0 - 0.5));
  fragColor = sum / 9.0;
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Reduce Interlace Flicker

export const REDUCE_INTERLACE_FLICKER = defineShaderEffect({
	id: 'jasper.reduce-interlace-flicker',
	label: 'Reduce Interlace Flicker',
	category: 'Blur & Sharpen',
	description:
		'Softens thin horizontal detail (a vertical-only blur) to reduce interlaced twitter on fine lines.',
	keywords: ['interlace', 'flicker', 'twitter', 'soften', 'vertical blur'],
	params: [slider('softness', 'Softness', 0, 0, 100, { softMax: 10, step: 0.01 })],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_rifSigma: Math.max(0, num(p.softness)) * ctx.pxScale }),
		passes: [
			{
				include: [GLSL_BLUR],
				frag: /* glsl */ `
void main() { fragColor = fx_gaussian1d(u_source, v_uv, vec2(0.0, 1.0), u_texel, u_rifSigma); }`,
			},
		],
	},
});

// ---------------------------------------------------------------- Sharpen

export const SHARPEN = defineShaderEffect({
	id: 'jasper.sharpen',
	label: 'Sharpen',
	category: 'Blur & Sharpen',
	description: 'Increases the contrast where colours change (edges), making detail crisper.',
	keywords: ['sharpness', 'crisp', 'detail', 'enhance'],
	params: [slider('sharpenAmount', 'Sharpen Amount', 0, 0, 4000, { softMax: 100, step: 1 })],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG, GLSL_BLUR],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  vec3 b = pacg_straight(fx_blur9(u_source, v_uv, u_texel));
  vec3 s = clamp(c + (c - b) * (u_sharpenAmount / 25.0), 0.0, 1.0);
  fragColor = fx_premultiply(vec4(s, src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Unsharp Mask

export const UNSHARP_MASK = defineShaderEffect({
	id: 'jasper.unsharp-mask',
	label: 'Unsharp Mask',
	category: 'Blur & Sharpen',
	description:
		'Classic unsharp mask: adds back the difference to a Gaussian-blurred copy (Amount, Radius) above a Threshold.',
	keywords: ['sharpen', 'usm', 'detail', 'crisp'],
	params: [
		slider('amount', 'Amount', 50, 0, 500, { unit: '%' }),
		slider('radius', 'Radius', 1, 0, 250, { softMax: 50, unit: 'px' }),
		slider('threshold', 'Threshold', 0, 0, 255, { step: 1 }),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const sigma = Math.max(0, num(p.radius, 1)) * ctx.pxScale;
			return [
				...gaussianBlurPasses({ input: 'source', output: 'blurred', sigma, scale: blurScale(sigma) }),
				{
					include: [GLSL_PACG],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  vec3 d = c - pacg_straight(texture(u_blurred, v_uv));
  float mag = max(abs(d.r), max(abs(d.g), abs(d.b))) * 255.0;
  float k = mag <= u_threshold ? 0.0 : u_amount / 100.0;
  fragColor = fx_premultiply(vec4(clamp(c + d * k, 0.0, 1.0), src.a));
}`,
				},
			];
		},
	},
});

export const BLUR_SHARPEN_EFFECTS: readonly EffectSpec[] = [
	CAMERA_BLUR,
	CHANNEL_BLUR,
	COMPOUND_BLUR,
	DIRECTIONAL_BLUR,
	REDUCE_INTERLACE_FLICKER,
	SHARPEN,
	UNSHARP_MASK,
];

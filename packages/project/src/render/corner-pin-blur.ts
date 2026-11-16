// Corner Pin motion blur (docs/wp-notes/corner-pin-motion-blur.md): the pin's movement over a box shutter, with the
// framework's adaptive shutter (`planMotionBlur`, fx-shader-framework.md §19) and Transform's settings ("Use
// Composition's Shutter Angle", "Shutter Angle" / 360 frames centred on the frame, "Mo Blur Quality").
//
// The pin stays the layer map (projective, after every effect, D-27): every renderer keeps placing the layer picture
// with the pin of the frame, P(frame). Motion blur is one more step at the end of the layer's picture chain, in the
// layer's own (pre-pin) pixels: out(y) = Σ w · src(H(s) · y) / Σ w with H(s) = P(s)⁻¹ · P(frame), so that P(frame)
// draws the pinned picture smeared over the shutter. P(s) comes from the pin's params at exact sub-frame times
// (keyframes or tracked data interpolated by the shared evaluator, `FxParamsAt`); the 32 key H are normalised to
// w = 1 at the box centre and interpolated linearly, the taps follow the travel of the pinned corners and centre (~1
// tap per pixel, capped by the quality). The picture is sampled bilinearly with texels outside it transparent (the
// native warp kernel's sampling). The same plan drives the GL step (`CORNER_PIN_BLUR_GPU`, Program preview, Remotion
// renders, layer bakes) and the native warp stage's CPU kernel (apps/engine `export/warp/kernel.ts`).
import type { EffectParams } from '../registry/effects.ts';
import { GLSL_MB_POSES } from '../registry/fx/glsl/motion-blur.ts';
import {
	centredShutter,
	type MbPlan,
	mbKeyTimes,
	mbStaticPlan,
	mbUniforms,
	planMotionBlur,
} from '../registry/fx/motion-blur.ts';
import { transformShutterFrames } from '../registry/fx/premiere-adjust-color-keying/transform.ts';
import {
	FX_MAX_PADDING,
	type FxPadding,
	type FxParamsAt,
	type GpuEffect,
	ZERO_PADDING,
} from '../registry/fx/shader.ts';
import type { Animatable, ParamValue } from '../schema/common.ts';
import { applyMat3, boxToQuad, invertMat3, type Mat3, multiplyMat3 } from './homography.ts';
import { CORNER_PIN_EFFECT_ID, cornerPinQuad, type ResolvedEffect } from './scene.ts';

/** vec4s per key pose: H row-major (9 numbers) and a valid flag. */
export const CORNER_PIN_BLUR_STRIDE = 3;

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Shutter length (frames) of a Corner Pin's params: Transform's (0 with "Use Composition's Shutter Angle"). */
export function cornerPinShutterFrames(p: EffectParams): number {
	return transformShutterFrames(p);
}

/**
 * The enabled corner pin that is the layer map (the first, `cornerPinQuad`) when it blurs at this frame, else null.
 * Layers whose pin does not blur keep the plain layer-map path (identical pixels).
 */
export function cornerPinBlurInstance(effects: readonly ResolvedEffect[]): ResolvedEffect | null {
	const fx = effects.find((e) => e.enabled && e.effectId === CORNER_PIN_EFFECT_ID);
	return fx && cornerPinShutterFrames(fx.params as EffectParams) > 0 ? fx : null;
}

/**
 * True when an enabled corner pin of the clip may blur on some frame (its shutter settings over all their keys): the
 * smear then reaches up to half a shutter beyond the quads of the clip's own frames.
 */
export function cornerPinMayBlur(c: {
	effects: readonly {
		effectId: string;
		enabled: boolean;
		params: Readonly<Record<string, Animatable<ParamValue>>>;
	}[];
}): boolean {
	const values = (a: Animatable<ParamValue> | undefined): ParamValue[] =>
		a ? [a.value, ...a.keyframes.map((k) => k.value)] : [];
	return c.effects.some((fx) => {
		if (!fx.enabled || fx.effectId !== CORNER_PIN_EFFECT_ID) return false;
		const comp = values(fx.params.useCompShutterAngle);
		if (comp.length === 0 || comp.every((v) => v !== false)) return false;
		return values(fx.params.shutterAngle).some((v) => typeof v === 'number' && v > 0);
	});
}

/** The pin of params `p` (layer px → pinned layer px); identity for a non-convex quad (drawn unpinned). */
function pinMap(p: EffectParams, box: { width: number; height: number }): Mat3 {
	const q = cornerPinQuad(
		[{ id: '', effectId: CORNER_PIN_EFFECT_ID, effectVersion: 1, enabled: true, params: p }],
		box,
	);
	return (q && boxToQuad(box.width, box.height, q)) || IDENTITY;
}

export type CornerPinBlurContext = {
	/** Layer box (layer px). */
	width: number;
	height: number;
	/** Canvas px per layer px. */
	pxScale: number;
	/** Clip-local frame being drawn; absent = no blur. */
	frame?: number;
	/** The pin's params at other clip-local frames (sub-frame shutter samples); absent = no blur. */
	paramsAt?: FxParamsAt;
	/** Padding of the picture the step receives (layer px). */
	inputPadding?: FxPadding;
};

/**
 * The shutter of a Corner Pin at a frame: key poses H(s) = P(s)⁻¹ · P(frame) packed as 3 vec4 ((h0, h1, h2, h3),
 * (h4, h5, h6, h7), (h8, valid, 0, 0)), taps from the travel of the pinned box corners and centre in canvas px.
 * `taps: 1` (the picture unchanged) without a shutter, sub-frame params or movement.
 */
export function planCornerPinBlur(p: EffectParams, ctx: CornerPinBlurContext): MbPlan {
	const shutter = cornerPinShutterFrames(p);
	const at = ctx.paramsAt;
	if (!(shutter > 0) || !at || ctx.frame === undefined) return mbStaticPlan(CORNER_PIN_BLUR_STRIDE);
	const box = { width: ctx.width, height: ctx.height };
	const W = box.width;
	const H = box.height;
	const px = ctx.pxScale;
	const cx = W / 2;
	const cy = H / 2;
	const P0 = pinMap(p, box);
	const tracked: [number, number][] = [
		[0, 0],
		[W, 0],
		[W, H],
		[0, H],
		[cx, cy],
	];
	return planMotionBlur({
		frame: ctx.frame,
		window: centredShutter(shutter),
		poseAt: (f) => pinMap(at(f), box),
		points: (P) =>
			tracked.map((v): [number, number] => {
				const w = P[6] * v[0] + P[7] * v[1] + P[8];
				if (!(w > 1e-9)) return [Number.NaN, Number.NaN];
				const [x, y] = applyMat3(P, v);
				return [x * px, y * px];
			}),
		pack: (P) => {
			const inv = invertMat3(P);
			if (!inv) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
			const h = multiplyMat3(inv, P0);
			const w = h[6] * cx + h[7] * cy + h[8];
			const k = Math.abs(w) > 1e-9 ? 1 / w : 1;
			return [...h.map((v) => v * k), 1, 0, 0];
		},
		stride: CORNER_PIN_BLUR_STRIDE,
		quality: p.mbQuality,
	});
}

/**
 * How far the smear reaches beyond the picture the step receives (layer px): the received canvas's corners pinned at
 * every key time and brought back through P(frame)⁻¹, plus a pixel of bilinear fringe; a side whose smear crosses
 * the horizon of P(frame) takes the cap.
 */
export function cornerPinBlurPadding(p: EffectParams, ctx: CornerPinBlurContext): FxPadding {
	const shutter = cornerPinShutterFrames(p);
	const at = ctx.paramsAt;
	if (!(shutter > 0) || !at || ctx.frame === undefined) return ZERO_PADDING;
	const box = { width: ctx.width, height: ctx.height };
	const back = invertMat3(pinMap(p, box));
	if (!back) return ZERO_PADDING;
	const inp = ctx.inputPadding ?? ZERO_PADDING;
	const x0 = -inp.left;
	const y0 = -inp.top;
	const x1 = box.width + inp.right;
	const y1 = box.height + inp.bottom;
	let minX = x0;
	let minY = y0;
	let maxX = x1;
	let maxY = y1;
	const capped = { left: FX_MAX_PADDING, top: FX_MAX_PADDING, right: FX_MAX_PADDING, bottom: FX_MAX_PADDING };
	for (const t of mbKeyTimes(ctx.frame, centredShutter(shutter))) {
		const m = multiplyMat3(back, pinMap(at(t), box));
		for (const v of [
			[x0, y0],
			[x1, y0],
			[x1, y1],
			[x0, y1],
		] as const) {
			const w = m[6] * v[0] + m[7] * v[1] + m[8];
			if (!(w > 1e-9)) return capped;
			const [x, y] = applyMat3(m, [v[0], v[1]]);
			if (!Number.isFinite(x) || !Number.isFinite(y)) return capped;
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}
	const side = (reach: number) => (reach > 1e-6 ? Math.min(FX_MAX_PADDING, Math.ceil(reach) + 1) : 0);
	return { left: side(x0 - minX), top: side(y0 - minY), right: side(maxX - x1), bottom: side(maxY - y1) };
}

/**
 * The GPU realization of the blur step (a stand-in of the Corner Pin in the layer's canvas chain, last). The
 * picture texels are fetched bilinearly with texels outside the canvas transparent, exactly as the native kernel.
 */
export const CORNER_PIN_BLUR_GPU: GpuEffect = {
	timeInvariant: true,
	padding: (p, ctx) => cornerPinBlurPadding(p, ctx),
	uniforms: (p, ctx) => mbUniforms(planCornerPinBlur(p, ctx)),
	passes: [
		{
			include: [GLSL_MB_POSES],
			frag: /* glsl */ `
vec4 cpb_texel(ivec2 t, ivec2 size) {
  ivec2 c = clamp(t, ivec2(0), size - 1);
  return texelFetch(u_source, c, 0) * float(t == c);
}
// Bilinear at layer px s over the texel centres, texels outside the picture transparent (premultiplied).
vec4 cpb_sample(vec2 s) {
  ivec2 size = textureSize(u_source, 0);
  vec2 q = fx_uvOfLayerPx(s) * vec2(size) - 0.5;
  vec2 q0 = floor(q);
  vec2 f = q - q0;
  ivec2 i = ivec2(q0);
  vec4 a = mix(cpb_texel(i, size), cpb_texel(i + ivec2(1, 0), size), f.x);
  vec4 b = mix(cpb_texel(i + ivec2(0, 1), size), cpb_texel(i + ivec2(1, 1), size), f.x);
  return mix(a, b, f.y);
}
void main() {
  if (!fx_mbOn()) { fragColor = texture(u_source, v_uv); return; }
  // The pinned picture over the shutter, in this frame's pre-pin pixels: H(s) = P(s)^-1 * P(frame).
  vec2 y = fx_layerPx();
  int n = fx_mbTaps();
  float j = fx_mbPlanJitter();
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < fx_mbDyn(FX_MB_TAP_LIMIT); i++) {
    if (i >= n) break;
    vec2 t = fx_mbTap(i, n, j);
    vec4 a = fx_mbPose(0, t.x), b = fx_mbPose(1, t.x), c = fx_mbPose(2, t.x);
    wsum += t.y;
    vec3 h = vec3(a.x * y.x + a.y * y.y + a.z, a.w * y.x + b.x * y.y + b.y, b.z * y.x + b.w * y.y + c.x);
    if (c.y > 0.5 && h.z > 1e-6) sum += cpb_sample(h.xy / h.z) * t.y;
  }
  fragColor = sum / max(wsum, 1e-6);
}`,
		},
	],
};

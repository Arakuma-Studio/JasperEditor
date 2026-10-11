// Premiere Pro "Transform" video effects (fx family premiere-adjust-color-keying): Edge Feather, Transform.
// (Crop, Horizontal/Vertical Flip already exist.) Transform's "Use Composition's Shutter Angle" / "Shutter Angle":
// real motion blur of the keyframed transform with the framework's adaptive shutter (`planMotionBlur`): the
// params at exact sub-frame times over the shutter interval (`ctx.paramsAt`, Shutter Angle / 360 frames centred on
// the frame) give 32 key transforms, the shader takes ~1 tap per pixel of travel of the layer box corners (rotation
// and scale included; up to 64, jittered beyond) between them. Sequences have no shutter angle of their own,
// so with "Use Composition's Shutter Angle" on (the default, as in Premiere) the angle is 0: no blur, the exact
// single-transform output.
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_MB_POSES } from '../glsl/motion-blur.ts';
import {
	centredShutter,
	type MbPlan,
	mbQualityParam,
	mbStaticPlan,
	mbUniforms,
	planMotionBlur,
} from '../motion-blur.ts';
import { fxParam } from '../params.ts';
import type { FxFrameContext } from '../shader.ts';
import { bool, num, slider } from './common.ts';

export const EDGE_FEATHER = defineShaderEffect({
	id: 'jasper.edge-feather',
	label: 'Edge Feather',
	category: 'Transform',
	description: 'Softens all four edges of the clip into transparency (a soft-edged vignette of the alpha).',
	keywords: ['feather', 'soft edges', 'vignette', 'fade edges'],
	params: [slider('amount', 'Amount', 0, 0, 100, { step: 0.1 })],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 box = u_box.zw / u_pxScale;
  vec2 p = fx_layerPx();
  float w = u_amount / 100.0 * 0.5 * min(box.x, box.y);
  float d = min(min(p.x, box.x - p.x), min(p.y, box.y - p.y));
  float k = w <= 0.0 ? 1.0 : smoothstep(0.0, w, d);
  fragColor = src * clamp(k, 0.0, 1.0);
}`,
			},
		],
	},
});

/**
 * The Transform effect as an inverse affine map (layer px → source layer px): source = A · out + b, with
 * out = position + R(rotation) · Skew(skew, axis) · S(scale) · (src − anchor). Returns [a, b, c, d, tx, ty] with
 * source.x = a·x + c·y + tx, source.y = b·x + d·y + ty, or null when the scale is zero.
 */
export function transformInverse(p: EffectParams, size: { width: number; height: number }): number[] | null {
	const pt = (v: ParamValue | undefined): [number, number] =>
		Array.isArray(v) && v.length === 2 ? [num(v[0], 0.5), num(v[1], 0.5)] : [0.5, 0.5];
	const [ax, ay] = pt(p.anchorPoint);
	const [px, py] = pt(p.position);
	const anchor = [ax * size.width, ay * size.height];
	const pos = [px * size.width, py * size.height];
	const sh = num(p.scaleHeight, 100) / 100;
	const sw = bool(p.uniformScale, true) ? sh : num(p.scaleWidth, 100) / 100;
	const rot = (num(p.rotation) * Math.PI) / 180;
	const skew = (Math.max(-70, Math.min(70, num(p.skew))) * Math.PI) / 180;
	const axis = (num(p.skewAxis) * Math.PI) / 180;
	// 2×2 matrices as [m00, m01, m10, m11] (row-major).
	const mul = (a: number[], b: number[]) => [
		a[0]! * b[0]! + a[1]! * b[2]!,
		a[0]! * b[1]! + a[1]! * b[3]!,
		a[2]! * b[0]! + a[3]! * b[2]!,
		a[2]! * b[1]! + a[3]! * b[3]!,
	];
	const R = (t: number) => [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t)];
	// Skew: shear along the skew axis (x' = x + tan(skew)·y in the axis frame).
	const K = mul(mul(R(axis), [1, Math.tan(skew), 0, 1]), R(-axis));
	const M = mul(mul(R(rot), K), [sw, 0, 0, sh]);
	const det = M[0]! * M[3]! - M[1]! * M[2]!;
	if (Math.abs(det) < 1e-9) return null;
	const I = [M[3]! / det, -M[1]! / det, -M[2]! / det, M[0]! / det];
	// src = anchor + I · (out − pos)
	const tx = anchor[0]! - (I[0]! * pos[0]! + I[1]! * pos[1]!);
	const ty = anchor[1]! - (I[2]! * pos[0]! + I[3]! * pos[1]!);
	return [I[0]!, I[2]!, I[1]!, I[3]!, tx, ty];
}

/** Shutter length in frames: (Shutter Angle / 360) unless "Use Composition's Shutter Angle" (sequences: 0). */
export function transformShutterFrames(p: EffectParams): number {
	if (bool(p.useCompShutterAngle, true)) return 0;
	return Math.min(360, Math.max(0, num(p.shutterAngle))) / 360;
}

/**
 * Motion blur of Transform at a frame (the framework's adaptive shutter): the inverse maps and opacities of the params
 * at the shutter's key times, packed as 2 vec4 per key ((a, b, c, d), (tx, ty, opacity, valid)), and the tap count
 * from the travel of the transformed layer box corners and centre in canvas px. `taps: 1` (no blur) when the shutter
 * is 0, `paramsAt` is unavailable or the transform does not change.
 */
export function transformShutterSamples(
	p: EffectParams,
	ctx: Pick<FxFrameContext, 'frame' | 'width' | 'height' | 'paramsAt'> & { pxScale?: number },
): MbPlan {
	const shutter = transformShutterFrames(p);
	const at = ctx.paramsAt;
	if (!(shutter > 0) || !at) return mbStaticPlan(2);
	const px = ctx.pxScale ?? 1;
	const W = ctx.width;
	const H = ctx.height;
	const box: [number, number][] = [
		[0, 0],
		[W, 0],
		[W, H],
		[0, H],
		[W / 2, H / 2],
	];
	return planMotionBlur({
		frame: ctx.frame,
		window: centredShutter(shutter),
		poseAt: (f) => {
			const q = at(f);
			return { inv: transformInverse(q, ctx), opacity: num(q.opacity, 100) };
		},
		points: ({ inv }) => {
			if (!inv) return box.map(() => [Number.NaN, Number.NaN] as [number, number]);
			// out = A⁻¹ · (src − T), A = [[a, c], [b, d]].
			const [a, b, c, d, tx, ty] = inv as [number, number, number, number, number, number];
			const det = a * d - b * c;
			return box.map(([x, y]): [number, number] => {
				const u = x - tx;
				const v = y - ty;
				return [((d * u - c * v) / det) * px, ((-b * u + a * v) / det) * px];
			});
		},
		pack: ({ inv, opacity }) =>
			inv ? [inv[0]!, inv[1]!, inv[2]!, inv[3]!, inv[4]!, inv[5]!, opacity, 1] : [1, 0, 0, 1, 0, 0, 0, 0],
		stride: 2,
		quality: p.mbQuality,
	});
}

export const TRANSFORM = defineShaderEffect({
	id: 'jasper.transform',
	label: 'Transform',
	category: 'Transform',
	description:
		'Moves, scales, skews and rotates the clip inside its frame with an anchor point and opacity (applied in effect order).',
	keywords: ['position', 'scale', 'rotate', 'skew', 'anchor', 'motion'],
	params: [
		fxParam.point('anchorPoint', 'Anchor Point', [0.5, 0.5]),
		fxParam.point('position', 'Position', [0.5, 0.5]),
		fxParam.toggle('uniformScale', 'Uniform Scale', true),
		slider('scaleHeight', 'Scale Height', 100, -10000, 10000, { softMin: 0, softMax: 600, unit: '%' }),
		slider('scaleWidth', 'Scale Width', 100, -10000, 10000, { softMin: 0, softMax: 600, unit: '%' }),
		slider('skew', 'Skew', 0, -70, 70, { step: 0.1 }),
		fxParam.angle('skewAxis', 'Skew Axis', 0),
		fxParam.angle('rotation', 'Rotation', 0),
		fxParam.percent('opacity', 'Opacity', 100),
		fxParam.toggle('useCompShutterAngle', "Use Composition's Shutter Angle", true),
		fxParam.number(
			'shutterAngle',
			'Shutter Angle',
			0,
			{ min: 0, max: 360, step: 0.1 },
			{ unit: 'deg', animatable: true },
		),
		mbQualityParam(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => {
			const inv = transformInverse(p, ctx);
			const mb = transformShutterSamples(p, ctx);
			return {
				...(inv
					? { u_tfA: [inv[0]!, inv[1]!, inv[2]!, inv[3]!], u_tfT: [inv[4]!, inv[5]!], u_tfValid: true }
					: { u_tfA: [1, 0, 0, 1], u_tfT: [0, 0], u_tfValid: false }),
				...mbUniforms(mb),
			};
		},
		passes: [
			{
				include: [GLSL_MB_POSES],
				frag: /* glsl */ `
vec4 tf_at(vec4 A, vec2 T, vec2 q) {
  vec2 s = vec2(A.x * q.x + A.z * q.y, A.y * q.x + A.w * q.y) + T;
  vec2 n = s / (u_box.zw / u_pxScale);
  return all(greaterThanEqual(n, vec2(0.0))) && all(lessThanEqual(n, vec2(1.0))) ? texture(u_source, fx_uvOfLayerNorm(n)) : vec4(0.0);
}
void main() {
  if (fx_mbOn()) {
    // Shutter Angle motion blur: the transformed picture along the keyframed path over the shutter (adaptive taps
    // between the key transforms), opacity included.
    vec2 q = fx_layerPx();
    int n = fx_mbTaps();
    float j = fx_mbPlanJitter();
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int i = 0; i < fx_mbDyn(FX_MB_TAP_LIMIT); i++) {
      if (i >= n) break;
      vec2 t = fx_mbTap(i, n, j);
      vec4 a = fx_mbPose(0, t.x), b = fx_mbPose(1, t.x);
      if (b.w > 0.5) sum += tf_at(a, b.xy, q) * clamp(b.z / 100.0, 0.0, 1.0) * t.y;
      wsum += t.y;
    }
    fragColor = sum / max(wsum, 1e-6);
    return;
  }
  if (!u_tfValid) { fragColor = vec4(0.0); return; }
  vec2 q = fx_layerPx();
  vec2 s = vec2(u_tfA.x * q.x + u_tfA.z * q.y, u_tfA.y * q.x + u_tfA.w * q.y) + u_tfT;
  vec2 n = s / (u_box.zw / u_pxScale);
  vec4 c = all(greaterThanEqual(n, vec2(0.0))) && all(lessThanEqual(n, vec2(1.0))) ? texture(u_source, fx_uvOfLayerNorm(n)) : vec4(0.0);
  fragColor = c * clamp(u_opacity / 100.0, 0.0, 1.0);
}`,
			},
		],
	},
});

export const TRANSFORM_EFFECTS: readonly EffectSpec[] = [EDGE_FEATHER, TRANSFORM];

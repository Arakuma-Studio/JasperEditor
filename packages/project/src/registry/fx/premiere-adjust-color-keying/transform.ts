// Premiere Pro "Transform" video effects (fx family premiere-adjust-color-keying): Edge Feather, Transform.
// (Crop, Horizontal/Vertical Flip already exist.) Transform's "Use Composition's Shutter Angle" / "Shutter Angle"
// motion blur is not offered: it needs the effect's params at sub-frame times, which the framework does not provide
// (params are evaluated at the current frame; time samples are raw source frames).
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { fxParam } from '../params.ts';
import { bool, num, slider } from './common.ts';

// ---------------------------------------------------------------- Edge Feather

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

// ---------------------------------------------------------------- Transform

/**
 * The Transform effect as an inverse affine map (layer px → source layer px): source = A · out + b, with
 * out = position + R(rotation) · Skew(skew, axis) · S(scale) · (src − anchor). Returns [a, b, c, d, tx, ty] with
 * source.x = a·x + c·y + tx, source.y = b·x + d·y + ty, or null when the scale is zero.
 */
export function transformInverse(p: EffectParams, size: { width: number; height: number }): number[] | null {
	const pt = (v: unknown): [number, number] =>
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
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => {
			const inv = transformInverse(p, ctx);
			return inv
				? { u_tfA: [inv[0]!, inv[1]!, inv[2]!, inv[3]!], u_tfT: [inv[4]!, inv[5]!], u_tfValid: true }
				: { u_tfA: [1, 0, 0, 1], u_tfT: [0, 0], u_tfValid: false };
		},
		passes: [
			{
				frag: /* glsl */ `
void main() {
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

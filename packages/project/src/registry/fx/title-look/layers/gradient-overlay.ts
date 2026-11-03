// `gradientOverlay` (spec 19 §8, not in the §5.1 table: the look layer of the Gradient Overlay effect, so both share this
// GLSL). Ported from Pachislop's gradientOverlay (effects/a/stylize.ts): recolours what is below it with a gradient and
// keeps its alpha; `fit` stretches the gradient over the title, `band` moves a gradient of fixed length across it (a glint).
// Every blend is linear light (§8); Pachislop's "Light (add)" and "Light (multiply)" are `add` and `multiply` here.
import { FX_BLEND_MODE_LABELS, FX_BLEND_MODES, GLSL_BLEND } from '../../glsl/blend.ts';
import { fmtNumber, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';
import { GLSL_TL_LIGHT } from '../light.ts';
import { SHAPE_GRADIENT_DEPTH } from '../paint.ts';

/** The blends of `fx_blendRgb` that work on any colour: the first 16 (the rest need a backdrop's clip formulas). */
export const OVERLAY_BLENDS = FX_BLEND_MODES.slice(0, 16);
export const OVERLAY_BLEND_LABELS = FX_BLEND_MODE_LABELS.slice(0, 16);

const gradientPaint = (p: Record<string, unknown>) =>
	(p.paint as { kind?: string } | undefined)?.kind === 'gradient';

const POSITION = /* glsl */ `
float tl_overlayPos(TlSurface s) {
  vec4 b = tl_bounds();
  vec2 centre = 0.5 * (b.xy + b.zw);
  vec2 half_ = max(0.5 * (b.zw - b.xy), vec2(1.0));
  vec2 dir = u_paintDir;
  float x;
  if (u_style == 1) {
    float ext = max(abs(dir.x) * half_.x + abs(dir.y) * half_.y, 1.0);
    float len = max(tl_px(u_bandLength), 1.0);
    x = 0.5 + (dot(s.px - centre, dir) - u_position * 0.01 * (ext + 0.5 * len)) / len;
  } else {
    float fit = tl_gradientPos(u_paintType, dir, u_paintRad, tl_px(${SHAPE_GRADIENT_DEPTH.toFixed(1)}), s);
    x = (fit - 0.5) / max(u_scale * 0.01, 0.01) + 0.5 + u_offset * 0.01;
  }
  if (u_wrap == 1) return fract(x);
  if (u_wrap == 2) return 1.0 - abs(mod(x, 2.0) - 1.0);
  return x;
}`;

export const GRADIENT_OVERLAY_LAYER: TitleLayerInit = {
	type: 'gradientOverlay',
	label: 'Gradient Overlay',
	description:
		'Recolours what is below it with a gradient, keeping its alpha; a band of it can sweep across the title.',
	finish: false,
	params: [
		...lp.paint('paint', 'Paint', {
			kind: 'gradient',
			gradient: {
				type: 'linear',
				span: 'block',
				angle: 90,
				stops: [
					{ at: 0, paint: { role: 'face' } },
					{ at: 1, paint: { role: 'faceAlt' } },
				],
			},
		}),
		lp.choice('style', 'Style', ['fit', 'band'], ['Fit to Title', 'Band'], 'fit'),
		lp.number('scale', 'Scale', 100, { min: 1, max: 1000, softMax: 300, step: 0.1 }, { unit: '%' }),
		lp.number('offset', 'Offset', 0, { min: -200, max: 200, step: 0.1 }, { unit: '%' }),
		lp.distance('bandLength', 'Band Length', 100, { min: 0.1, softMax: 400 }),
		lp.number('position', 'Position', 0, { min: -100, max: 100, step: 0.1 }, { unit: '%' }),
		lp.choice('wrap', 'Wrap', ['clamp', 'repeat', 'mirror'], ['Clamp', 'Repeat', 'Mirror'], 'clamp'),
		lp.percent('amount', 'Amount', 100),
		lp.choice('blend', 'Blend', OVERLAY_BLENDS, OVERLAY_BLEND_LABELS, 'normal'),
	],
	shader(p) {
		const gradient = gradientPaint(p);
		return {
			glsl: /* glsl */ `${gradient ? POSITION : ''}
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  if (under.a <= 0.0) return vec4(0.0);
  vec4 g = ${gradient ? 'tl_ramp(u_paintRamp, clamp(tl_overlayPos(s), 0.0, 1.0))' : 'tlPaint_paint(s)'};
  vec3 base = under.rgb / under.a;
  vec3 top = g.a > 0.0 ? g.rgb / g.a : vec3(0.0);
  vec3 r = mix(base, fx_blendRgb(u_blend, base, top), u_amount * 0.01 * g.a);
  return tl_result(under, vec4(r * under.a, under.a));
}`,
			include: [GLSL_BLEND, GLSL_TL_LIGHT],
		};
	},
	handles: [
		{ kind: 'angle', params: ['paintAngle'] },
		{
			kind: 'position',
			params: ['position'],
			when: { param: 'style', value: 'band' },
			along: { paint: 'paint' },
			range: { band: 'bandLength' },
		},
	],
	summary(p) {
		return {
			swatch: layerSwatch(GRADIENT_OVERLAY_LAYER, p),
			text: `${paintText(p.paint)}, ${fmtNumber(p.amount)} %`,
			primary: 'amount',
		};
	},
};

// `sheen` (§5.1): a band of light across what is below it in the stack, Pachislop's Sheen2D. `position` sweeps it from one
// side of the shape's bounds (0 %) to the other (100 %); keyframe it for the classic pass of light. It adds light and more of
// it on what is already bright, so it never paints outside the shape.
import { fmtDistance, fmtNumber, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

export const SHEEN_LAYER: TitleLayerInit = {
	type: 'sheen',
	label: 'Sheen',
	description: 'A band of light across the shape; animate Position to pass it over the title.',
	finish: false,
	params: [
		lp.angle('angle', 'Angle', 20),
		lp.number('position', 'Position', 35, { softMin: -50, softMax: 150, step: 0.1 }, { unit: '%' }),
		lp.distance('width', 'Width', 22, { softMax: 100 }),
		lp.number('intensity', 'Intensity', 120, { min: 0, max: 1000, softMax: 300, step: 1 }, { unit: '%' }),
		...lp.paint('paint', 'Paint', { kind: 'color', color: [1, 1, 1, 1] }),
	],
	shader: () => ({
		glsl: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  if (under.a <= 0.0) return vec4(0.0);
  vec4 b = tl_bounds();
  vec2 h = max((b.zw - b.xy) * 0.5, vec2(0.5));
  vec2 dir = fx_dir(u_angle);
  float ext = abs(dir.x) * h.x + abs(dir.y) * h.y;
  float x = dot(s.px - (b.xy + b.zw) * 0.5, dir) - (u_position * 0.02 - 1.0) * ext;
  float w = max(tl_px(u_width), 0.5);
  float band = exp(-(x * x) / (w * w)) * u_intensity * 0.01;
  vec3 c = under.rgb / under.a;
  // Bright surfaces catch more of it: a dark fill keeps its depth.
  float catchLight = 0.4 + 0.6 * clamp(fx_luma(c), 0.0, 1.0);
  vec4 p = tlPaint_paint(s);
  return vec4(p.rgb * band * catchLight * under.a, 0.0);
}`,
	}),
	handles: [
		{ kind: 'position', params: ['position'] },
		{ kind: 'angle', params: ['angle'] },
		{ kind: 'distance', params: ['width'], from: 'band' },
	],
	summary(p) {
		return {
			swatch: layerSwatch(SHEEN_LAYER, p),
			text: `${fmtNumber(p.position)} %, ${fmtDistance(p.width)}, ${paintText(p.paint)}`,
			primary: 'position',
		};
	},
};

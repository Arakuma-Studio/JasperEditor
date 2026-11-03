// `gloss` (§5.1): the cap of the `gloss` finish over everything below it in the stack, so rims and face catch one highlight.

import { fmtNumber, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';
import { GLOSS_CAP_GLSL } from '../finishes/gloss.ts';

export const GLOSS_LAYER: TitleLayerInit = {
	type: 'gloss',
	label: 'Gloss',
	description: 'A cap of light across the upper part of the shape.',
	finish: false,
	params: [
		lp.percent('height', 'Height', 48),
		lp.percent('curve', 'Curve', 45),
		lp.percent('softness', 'Softness', 6),
		lp.number('intensity', 'Intensity', 60, { min: 0, max: 100, step: 0.1 }, { unit: '%' }),
		lp.angle('angle', 'Angle', 0),
		...lp.paint('paint', 'Paint', { kind: 'color', color: [1, 1, 1, 1] }),
	],
	shader: () => ({
		glsl: /* glsl */ `${GLOSS_CAP_GLSL}
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  if (under.a <= 0.0) return vec4(0.0);
  float a = clamp(tl_glossCap(s, u_height * 0.01, u_curve * 0.01, u_softness * 0.01, radians(u_angle)) * u_intensity * 0.01, 0.0, 1.0);
  vec4 p = tlPaint_paint(s);
  // Over what is there, keeping its alpha: the cap adds no coverage at an antialiased edge.
  return vec4((p.rgb * under.a - under.rgb) * a * p.a, 0.0);
}`,
	}),
	handles: [
		// The cap's edge runs down the shape from its angle (`tl_glossCap`: 0 % at the top, 100 % at the bottom); the
		// angle's zero points up, where the cap is.
		{ kind: 'position', params: ['height'], along: { turn: 90 } },
		{ kind: 'angle', params: ['angle'], along: { turn: -90 } },
	],
	summary(p) {
		return {
			swatch: layerSwatch(GLOSS_LAYER, p),
			text: `${fmtNumber(p.height)} %, ${fmtNumber(p.intensity)} %, ${paintText(p.paint)}`,
			primary: 'height',
		};
	},
};

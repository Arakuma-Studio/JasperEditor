// `face` (§5.1): the fill of the shape. Its coverage is the input's own alpha, so the glyphs' antialiasing and any
// per-character fade stay exactly as the text drew them.
import { fmtNumber, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

export const FACE_LAYER: TitleLayerInit = {
	type: 'face',
	label: 'Face',
	description: 'The fill of the shape.',
	finish: true,
	params: [
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'face' }),
		lp.percent('opacity', 'Opacity', 100),
	],
	shader: () => ({
		glsl: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  return tl_finish(tlPaint_paint(s), s) * s.alpha * (u_opacity * 0.01);
}`,
	}),
	summary(p) {
		return {
			swatch: layerSwatch(FACE_LAYER, p),
			text: `${paintText(p.paint)}, ${fmtNumber(p.opacity)} %`,
			primary: 'opacity',
		};
	},
};

// `rim` (§5.1): a ring around the shape, growing cumulatively from the face or the previous rim (Pachislop's rim stack,
// computed here from the shape field, so corners are round and the input can be any alpha).
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const RIM_LAYER: TitleLayerInit = {
	type: 'rim',
	label: 'Rim',
	description: 'A ring around the shape, growing from the face or the previous rim.',
	finish: true,
	params: [
		lp.distance('width', 'Width', 6, { softMax: 40 }),
		lp.distance('offset', 'Offset', 0, { softMax: 40 }),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'keyline' }),
		lp.percent('opacity', 'Opacity', 100),
	],
	shader: () => ({
		glsl: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  float gap = tl_px(u_offset);
  float inner = s.base + gap;
  // A rim touching what is above it reaches one pixel under it, so their antialiased edges never leak the background.
  float under = 1.0 - clamp(gap, 0.0, 1.0);
  float cov = tl_band(s.d, inner - under, inner + tl_px(u_width));
  return tl_finish(tlPaint_paint(s), s) * cov * s.opacity * (u_opacity * 0.01);
}`,
	}),
	depth: {
		ring: true,
		glsl: /* glsl */ `
float tl_depth(TlSurface s) { return s.base + tl_px(u_offset) + tl_px(u_width) - s.d; }
float tl_bandPx(TlSurface s) { return tl_px(u_width); }
`,
	},
	grows: (p) => num(p.offset) + num(p.width),
	reach: (p) => num(p.offset) + num(p.width),
	handles: [
		{ kind: 'distance', params: ['width'] },
		{ kind: 'angle', params: ['paintAngle'] },
	],
	summary(p) {
		return {
			swatch: layerSwatch(RIM_LAYER, p),
			text: `${fmtDistance(p.width)}, ${paintText(p.paint)}`,
			primary: 'width',
		};
	},
};

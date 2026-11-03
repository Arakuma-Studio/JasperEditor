// `inline` (§5.1): a ring inside the shape, the mirror of a rim. Coverage ends at the input's own alpha, so the ring keeps the
// glyphs' antialiasing where it touches their edge.
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const INLINE_LAYER: TitleLayerInit = {
	type: 'inline',
	label: 'Inline',
	description: 'A ring inside the shape.',
	finish: true,
	params: [
		lp.distance('inset', 'Inset', 3, { softMax: 9 }),
		lp.distance('width', 'Width', 2, { softMax: 8 }),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'accent1' }),
		lp.percent('opacity', 'Opacity', 100),
	],
	shader: () => ({
		glsl: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  float a = tl_px(u_inset);
  float cov = tl_band(-s.d, a, a + tl_px(u_width));
  return tl_finish(tlPaint_paint(s), s) * cov * s.alpha * (u_opacity * 0.01);
}`,
	}),
	depth: {
		ring: true,
		glsl: /* glsl */ `
float tl_depth(TlSurface s) { return -s.d - tl_px(u_inset); }
float tl_bandPx(TlSurface s) { return tl_px(u_width); }
`,
	},
	fieldReach: (p) => ({ inside: num(p.inset) + num(p.width) + 1, outside: 0 }),
	handles: [
		{ kind: 'distance', params: ['inset', 'width'], from: 'inside' },
		{ kind: 'angle', params: ['paintAngle'] },
	],
	summary(p) {
		return {
			swatch: layerSwatch(INLINE_LAYER, p),
			text: `${fmtDistance(p.width)} at ${fmtDistance(p.inset)}, ${paintText(p.paint)}`,
			primary: 'width',
		};
	},
};

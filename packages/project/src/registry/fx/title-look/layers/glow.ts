// `glow` (§5.1): outer glow, ported from Pachislop's outerGlow (effects/a/glow.ts). Technique as in Photoshop: `soft` is
// the blurred silhouette (a halo that rounds corners), `precise` the exact distance from the edge (follows corners).
// From: `edge` lights with the paint, `layer` with the picture's own colours (blurred, Soft only).
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const SIGMAS = 3;

const EDGE_MASK = /* glsl */ `
vec4 tl_mask(TlSurface s) { return vec4(tl_inside(s.d, s.base) * s.opacity); }`;

const LAYER_MASK = /* glsl */ `
vec4 tl_mask(TlSurface s) {
  vec4 c = tl_sourceLinear(s.uv);
  float a = c.a * tl_inside(s.d, s.base);
  return vec4(c.rgb * a, a);
}`;

const SOFT = (layer: boolean) => /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 b = texture(u_tlBlur, s.uv);
  float g = clamp(b.a * (u_intensity * 0.01), 0.0, 1.0);
  ${layer ? 'return b * (u_intensity * 0.01);' : 'return tlPaint_paint(s) * g;'}
}`;

const PRECISE = /* glsl */ `
vec4 tl_layer(TlSurface s) {
  float size = max(tl_px(u_radius), 1.0);
  float x = max(s.d - s.base, 0.0) / size;
  float a = (1.0 - smoothstep(0.0, 1.0, x)) * clamp(size - (s.d - s.base) + 0.5, 0.0, 1.0);
  return tlPaint_paint(s) * clamp(a * (u_intensity * 0.01), 0.0, 1.0) * s.opacity;
}`;

const precise = (p: Record<string, unknown>) => p.technique === 'precise';
const fromLayer = (p: Record<string, unknown>) => p.from === 'layer' && !precise(p);

export const GLOW_LAYER: TitleLayerInit = {
	type: 'glow',
	label: 'Glow',
	description: 'Light around the shape: a soft halo or a precise falloff, from the edge or the picture.',
	finish: false,
	params: [
		lp.choice('technique', 'Technique', ['soft', 'precise'], ['Soft', 'Precise'], 'soft'),
		lp.choice('from', 'From', ['edge', 'layer'], ['Edge', 'Layer'], 'edge'),
		lp.distance('radius', 'Radius', 20, { softMax: 100 }),
		lp.number('intensity', 'Intensity', 100, { min: 0, max: 1000, softMax: 300, step: 1 }, { unit: '%' }),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'glow' }),
	],
	shader(p) {
		return { glsl: precise(p) ? PRECISE : SOFT(fromLayer(p)) };
	},
	blur(p) {
		if (precise(p)) return null;
		return { sigma: Math.max(num(p.radius), 0.01) / SIGMAS, mask: fromLayer(p) ? LAYER_MASK : EDGE_MASK };
	},
	reach: (p) => num(p.radius),
	fieldReach: (p) => (precise(p) ? { outside: num(p.radius) + 1 } : { outside: 1 }),
	handles: [{ kind: 'distance', params: ['radius'] }],
	summary(p) {
		return {
			swatch: layerSwatch(GLOW_LAYER, p),
			text: `${String(p.technique)}, ${fmtDistance(p.radius)}, ${paintText(p.paint)}`,
			primary: 'radius',
		};
	},
};

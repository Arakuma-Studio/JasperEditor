// `innerGlow` (§5.1): glow inside the shape, ported from Pachislop's innerGlow (effects/a/glow.ts). Technique as in
// Photoshop: `soft` is the blurred silhouette, `precise` the exact distance from the edge, solid to Choke and then a
// smooth falloff. From the edge inward, or from the centre outward. The blur reads the silhouette, not the alpha, so a
// fading glyph keeps its glow and only fades; blends in linear light.
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';
import { GLSL_TL_LIGHT } from '../light.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const SIGMAS = 3;

const precise = (p: Record<string, unknown>) => p.technique === 'precise';

const AMOUNT: Record<string, string> = {
	'soft-edge': /* glsl */ `
float tl_amount(TlSurface s) {
  return 2.0 * (1.0 - texture(u_tlBlur, s.uv).a) / max(1.0 - u_choke * 0.01, 0.02);
}`,
	'soft-center': /* glsl */ `
float tl_amount(TlSurface s) {
  return 2.0 * (texture(u_tlBlur, s.uv).a - 0.5) / max(1.0 - u_choke * 0.01, 0.02);
}`,
	'precise-edge': /* glsl */ `
float tl_amount(TlSurface s) {
  float size = max(tl_px(u_radius), 1.0);
  float x = smoothstep(min(u_choke * 0.01, 0.999), 1.0, max(-s.d, 0.0) / size);
  return (1.0 - x) * clamp(size + s.d + 0.5, 0.0, 1.0);
}`,
	'precise-center': /* glsl */ `
float tl_amount(TlSurface s) {
  float size = max(tl_px(u_radius), 1.0);
  return smoothstep(min(u_choke * 0.01, 0.999), 1.0, max(-s.d, 0.0) / size);
}`,
};

const BLEND: Record<string, string> = {
	normal: 'return p * k;',
	screen: 'return vec4((p.rgb - under.rgb * p.rgb) * k, 0.0);',
	add: 'return vec4(p.rgb * k, 0.0);',
};

export const INNER_GLOW_LAYER: TitleLayerInit = {
	type: 'innerGlow',
	label: 'Inner Glow',
	description: 'Light inside the shape, from its edge inward or from its centre outward.',
	finish: false,
	params: [
		lp.choice('technique', 'Technique', ['soft', 'precise'], ['Soft', 'Precise'], 'soft'),
		lp.choice('source', 'Source', ['edge', 'center'], ['Edge', 'Center'], 'edge'),
		lp.distance('radius', 'Radius', 12, { softMax: 60 }),
		lp.number('intensity', 'Intensity', 100, { min: 0, max: 1000, softMax: 300, step: 1 }, { unit: '%' }),
		lp.percent('choke', 'Choke', 0),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'glow' }),
		lp.choice('blend', 'Blend', ['normal', 'screen', 'add'], ['Normal', 'Screen', 'Add'], 'screen'),
		lp.percent('opacity', 'Opacity', 100),
	],
	shader(p) {
		const key = `${precise(p) ? 'precise' : 'soft'}-${p.source === 'center' ? 'center' : 'edge'}`;
		return {
			glsl: /* glsl */ `${AMOUNT[key]}
vec4 tl_layer(TlSurface s) {
  float k = clamp(tl_amount(s) * (u_intensity * 0.01), 0.0, 1.0) * (u_opacity * 0.01) * s.alpha;
  vec4 p = tlPaint_paint(s);
  vec4 under = texture(u_tlComp, s.uv);
  ${BLEND[String(p.blend)] ?? BLEND.screen}
}`,
			include: [GLSL_TL_LIGHT],
		};
	},
	blur(p) {
		if (precise(p)) return null;
		return {
			sigma: Math.max(num(p.radius), 0.01) / SIGMAS,
			mask: /* glsl */ `vec4 tl_mask(TlSurface s) { return vec4(tl_inside(s.d, 0.0)); }`,
		};
	},
	// Nothing is drawn outside the shape: this is what the blur and the field must see around it.
	reach: (p) => (precise(p) ? 0.01 : Math.max(num(p.radius), 0.01)),
	fieldReach: (p) => ({ inside: precise(p) ? num(p.radius) + 1 : 0, outside: 1 }),
	handles: [{ kind: 'distance', params: ['radius'] }],
	summary(p) {
		return {
			swatch: layerSwatch(INNER_GLOW_LAYER, p),
			text: `${fmtDistance(p.radius)}, ${paintText(p.paint)}`,
			primary: 'radius',
		};
	},
};

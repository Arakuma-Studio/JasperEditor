// `glow` (§5.1): outer glow, ported from Pachislop's outerGlow (effects/a/glow.ts). Technique as in Photoshop: `soft` is
// the blurred silhouette (a halo that rounds corners) with a tighter core mixed in, `precise` the exact distance from the
// edge (follows corners), solid to Spread and then a smooth falloff. From: `edge` lights with the paint, `layer` with the
// picture's own colours (blurred, for either technique), `distance` runs a gradient paint outward from the edge. Blend:
// behind the title, or added as light over it. The tight core comes from the field: a second blur for a share of the
// glow would cost more than the look's whole field.
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';
import { GLSL_TL_LIGHT } from '../light.ts';

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

const precise = (p: Record<string, unknown>) => p.technique === 'precise';
const fromLayer = (p: Record<string, unknown>) => p.from === 'layer';
const fromDistance = (p: Record<string, unknown>) => p.from === 'distance';
const gradientPaint = (p: Record<string, unknown>) => (p.paint as { kind?: string } | undefined)?.kind === 'gradient';

/** How much glow reaches this pixel, before Intensity. */
const AMOUNT: Record<string, string> = {
	soft: /* glsl */ `
float tl_amount(TlSurface s) {
  // Pachislop's core: 40 % of a blur at 0.3 of the radius. A blurred straight edge is the distance's smooth ramp.
  float core = max(tl_px(u_radius) * 0.1, 0.5);
  float a = 0.6 * texture(u_tlBlur, s.uv).a + 0.4 * (1.0 - smoothstep(-2.0 * core, 2.0 * core, s.d - s.base)) * s.opacity;
  return clamp(a / max(1.0 - u_spread * 0.01, 0.02), 0.0, 1.0);
}`,
	layer: /* glsl */ `
float tl_amount(TlSurface s) {
  return clamp(texture(u_tlBlur, s.uv).a / max(1.0 - u_spread * 0.01, 0.02), 0.0, 1.0);
}`,
	precise: /* glsl */ `
float tl_amount(TlSurface s) {
  float size = max(tl_px(u_radius), 1.0);
  float d = s.d - s.base;
  float x = max(d, 0.0) / size;
  return (1.0 - smoothstep(min(u_spread * 0.01, 0.999), 1.0, x)) * clamp(size - d + 0.5, 0.0, 1.0) * s.opacity;
}`,
};

function colour(p: Record<string, unknown>): string {
	if (fromLayer(p))
		return /* glsl */ `
vec4 tl_colour(TlSurface s) {
  vec4 b = texture(u_tlBlur, s.uv);
  return b.a > 0.0 ? vec4(b.rgb / b.a, 1.0) : vec4(0.0);
}`;
	if (fromDistance(p) && gradientPaint(p))
		return /* glsl */ `
vec4 tl_colour(TlSurface s) {
  return tl_ramp(u_paintRamp, clamp(max(s.d - s.base, 0.0) / max(tl_px(u_radius), 1.0), 0.0, 1.0));
}`;
	return /* glsl */ `
vec4 tl_colour(TlSurface s) { return tlPaint_paint(s); }`;
}

const BLEND: Record<string, string> = {
	behind: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  return tl_colour(s) * clamp(tl_amount(s) * (u_intensity * 0.01), 0.0, 1.0) * (u_opacity * 0.01);
}`,
	add: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  vec4 c = tl_colour(s);
  vec3 light = c.rgb * tl_amount(s) * (u_intensity * 0.01) * (u_opacity * 0.01);
  return tl_result(under, tl_lit(under, under.rgb + light * (u_onFace * 0.01) * under.a, light));
}`,
};

export const GLOW_LAYER: TitleLayerInit = {
	type: 'glow',
	label: 'Glow',
	description: 'Light around the shape: a soft halo or a precise falloff, from the edge or the picture.',
	finish: false,
	params: [
		lp.choice('technique', 'Technique', ['soft', 'precise'], ['Soft', 'Precise'], 'soft'),
		lp.choice('from', 'From', ['edge', 'layer', 'distance'], ['Edge', 'Layer', 'Distance'], 'edge'),
		lp.distance('radius', 'Radius', 20, { softMax: 100 }),
		lp.number('intensity', 'Intensity', 100, { min: 0, max: 1000, softMax: 300, step: 1 }, { unit: '%' }),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'glow' }),
		lp.percent('spread', 'Spread', 0),
		lp.percent('opacity', 'Opacity', 100),
		lp.choice('blend', 'Blend', ['behind', 'add'], ['Behind', 'Add as Light'], 'behind'),
		lp.percent('onFace', 'Glow Over Face', 15),
	],
	shader(p) {
		const amount = precise(p) ? AMOUNT.precise : fromLayer(p) ? AMOUNT.layer : AMOUNT.soft;
		return {
			glsl: `${amount}${colour(p)}${BLEND[String(p.blend)] ?? BLEND.behind}`,
			include: [GLSL_TL_LIGHT],
		};
	},
	blur(p) {
		if (precise(p) && !fromLayer(p)) return null;
		return { sigma: Math.max(num(p.radius), 0.01) / SIGMAS, mask: fromLayer(p) ? LAYER_MASK : EDGE_MASK };
	},
	reach: (p) => num(p.radius),
	fieldReach: (p) =>
		precise(p) || fromDistance(p)
			? { outside: num(p.radius) + 1 }
			: { outside: fromLayer(p) ? 1 : num(p.radius) * 0.2 + 1 },
	handles: [{ kind: 'distance', params: ['radius'] }],
	summary(p) {
		return {
			swatch: layerSwatch(GLOW_LAYER, p),
			text: `${String(p.technique)}, ${fmtDistance(p.radius)}, ${paintText(p.paint)}`,
			primary: 'radius',
		};
	},
};

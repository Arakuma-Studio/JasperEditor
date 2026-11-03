// `innerShadow` (§5.1): the shadow inside the shape, ported from Pachislop's innerShadow (effects/a/shadow.ts). The
// silhouette, moved and blurred: where it no longer covers the shape, the edge facing the light casts a shadow inward. The
// mask is the silhouette, not the alpha, so a fading glyph keeps its shadow and only fades. Outside the canvas counts as
// empty, and the blur has transparent padding to read, so a clip filling its box is shaded from its box's edges.
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';
import { GLSL_TL_STAGE } from '../glsl.ts';
import { GLSL_TL_LIGHT } from '../light.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Param `blur` is the visible radius ≈ 3σ (see `shadow.ts`). */
const sigmaOf = (p: Record<string, unknown>) => num(p.blur) / 3;

const body = (blurred: boolean) => /* glsl */ `
vec4 tl_layer(TlSurface s) {
  // Angle on screen: the shadow falls the same way however the title turns.
  vec2 dir = u_useLight ? -u_tlLightDir : tl_fromScreen(fx_dir(u_angle));
  vec2 q = s.uv - dir * tl_px(u_distance) / u_canvasSize;
  float inside = 0.0;
  if (all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0))))
    inside = ${blurred ? 'texture(u_tlBlur, q).a' : 'tl_inside(tl_surfaceAt(q).d, 0.0)'};
  float k = clamp((1.0 - inside) / max(1.0 - u_choke * 0.01, 0.02), 0.0, 1.0);
  vec4 under = texture(u_tlComp, s.uv);
  return tl_atop(under, tlPaint_paint(s), k * tl_ofShape(under, s.alpha) * (u_opacity * 0.01));
}`;

export const INNER_SHADOW_LAYER: TitleLayerInit = {
	type: 'innerShadow',
	label: 'Inner Shadow',
	description: 'A shadow inside the shape, cast inward by the edge facing the light.',
	finish: false,
	params: [
		lp.toggle('useLight', 'Use Light', false),
		lp.angle('angle', 'Angle', 60),
		lp.distance('distance', 'Distance', 4, { softMax: 40 }),
		lp.distance('blur', 'Blur', 6, { softMax: 40 }),
		lp.percent('choke', 'Choke', 0),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'shadow' }),
		lp.percent('opacity', 'Opacity', 60),
	],
	shader: (p) => ({ glsl: body(sigmaOf(p) > 0), include: [GLSL_TL_LIGHT, GLSL_TL_STAGE] }),
	blur(p) {
		const sigma = sigmaOf(p);
		if (sigma <= 0) return null;
		return { sigma, mask: /* glsl */ `vec4 tl_mask(TlSurface s) { return vec4(tl_inside(s.d, 0.0)); }` };
	},
	// Nothing is drawn outside the shape: this is what the blur and the field must see around it.
	reach: (p) => Math.max(num(p.blur), 0.01),
	fieldReach: () => ({ outside: 1 }),
	handles: [
		{
			kind: 'offset',
			params: ['angle', 'distance'],
			when: { param: 'useLight', value: false },
			screen: true,
		},
		{ kind: 'distance', params: ['distance'], when: { param: 'useLight', value: true }, screen: true },
		{ kind: 'angle', params: ['angle'], target: 'light', when: { param: 'useLight', value: true } },
	],
	summary(p) {
		return {
			swatch: layerSwatch(INNER_SHADOW_LAYER, p),
			text: `${fmtDistance(p.distance)}, ${paintText(p.paint)}`,
			primary: 'distance',
		};
	},
};

// `shadow` (§5.1): drop, long or perspective. Ported from Pachislop's drop shadow (effects/a/shadow.ts: offset, spread,
// blurred alpha), computed from the shape field, resolution independent and casting from the silhouette at this layer
// (rims above included). Direction: `angle` degrees, or away from the look's light with `useLight`.
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const DEG = Math.PI / 180;

/** Gaussian reach in standard deviations (the framework's convention for padded blurs). */
const SIGMAS = 3;

/** Param `blur` is the visible radius ≈ 3σ, as Pachislop's `size`. */
const sigmaOf = (p: Record<string, unknown>) => num(p.blur) / SIGMAS;

/** The shadow's picture before blurring: the silhouette, moved by the kind's geometry. */
const COMMON = /* glsl */ `
vec2 tl_shadowDir() { return u_useLight ? -u_tlLightDir : fx_dir(u_angle); }
float tl_silhouette(TlSurface s) { return tl_inside(s.d, s.base + tl_px(u_spread)) * s.opacity; }
`;

const MASK: Record<string, string> = {
	drop: /* glsl */ `
vec4 tl_mask(TlSurface s) { return vec4(tl_silhouette(s)); }`,
	long: /* glsl */ `
// March back towards the caster: the field says how far is safe, so a long shadow needs few steps at any size.
vec4 tl_mask(TlSurface s) {
  vec2 dir = tl_shadowDir();
  float end = tl_px(u_distance);
  float t = 0.0;
  float best = tl_silhouette(s);
  for (int i = 0; i < 48; i++) {
    if (t >= end || best >= 0.999) break;
    float room = s.d - (s.base + tl_px(u_spread));
    t = min(t + max(room, 1.0), end);
    TlSurface q = tl_surfaceAt(s.uv - dir * t / u_canvasSize);
    q.base = s.base;
    s.d = q.d;
    best = max(best, tl_silhouette(q));
  }
  return vec4(best);
}`,
	perspective: /* glsl */ `
// The silhouette laid on the ground: heights above the baseline shrink by u_foreshorten and shear along the direction.
vec4 tl_mask(TlSurface s) {
  vec2 dir = tl_shadowDir();
  float baseline = tl_bounds().w;
  float above = baseline - s.px.y;
  float k = max(u_foreshorten * 0.01, 0.01);
  vec2 lift = vec2(-dir.x * tl_px(u_distance) * 0.01, 0.0) * above;
  vec2 p = vec2(s.px.x + lift.x, baseline - above / k);
  TlSurface q = tl_surfaceAt(p / u_canvasSize);
  return vec4(tl_silhouette(q));
}`,
};

const BODY = (blurred: boolean, offset: boolean) => /* glsl */ `
vec4 tl_layer(TlSurface s) {
${
	blurred
		? `  float a = texture(u_tlBlur, ${offset ? 's.uv - tl_shadowDir() * tl_px(u_distance) / u_canvasSize' : 's.uv'}).a;`
		: `  TlSurface q = ${offset ? 'tl_surfaceAt(s.uv - tl_shadowDir() * tl_px(u_distance) / u_canvasSize)' : 's'};
  q.base = s.base;
  float a = tl_mask(q).a;`
}
  return tlPaint_paint(s) * a * (u_opacity * 0.01);
}`;

export const SHADOW_LAYER: TitleLayerInit = {
	type: 'shadow',
	label: 'Shadow',
	description: 'A drop, long or perspective shadow of the shape.',
	finish: false,
	params: [
		lp.choice('kind', 'Kind', ['drop', 'long', 'perspective'], ['Drop', 'Long', 'Perspective'], 'drop'),
		lp.toggle('useLight', 'Use Light', false),
		lp.angle('angle', 'Angle', 45),
		lp.distance('distance', 'Distance', 8, { softMax: 100 }),
		lp.distance('blur', 'Blur', 6, { softMax: 60 }),
		lp.distance('spread', 'Spread', 0, { softMax: 20 }),
		lp.percent('foreshorten', 'Foreshorten', 40, { group: 'perspective' }),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'shadow' }),
		lp.percent('opacity', 'Opacity', 75),
	],
	shader(p) {
		const kind = String(p.kind);
		const blurred = sigmaOf(p) > 0;
		return { glsl: `${COMMON}${MASK[kind] ?? MASK.drop}${BODY(blurred, kind === 'drop')}` };
	},
	blur(p) {
		const sigma = sigmaOf(p);
		if (sigma <= 0) return null;
		return { sigma, mask: `${COMMON}${MASK[String(p.kind)] ?? MASK.drop}` };
	},
	reach(p) {
		// The light's direction is not known here: `useLight` pads every side by the distance.
		const a = num(p.angle) * DEG;
		const d = num(p.distance);
		const kind = String(p.kind);
		const dx = p.useLight === true || kind === 'perspective' ? d : d * Math.cos(a);
		const dy = p.useLight === true ? d : kind === 'perspective' ? 0 : d * Math.sin(a);
		const spread = num(p.spread) + num(p.blur);
		const stretch = kind === 'perspective' ? 100 / Math.max(num(p.foreshorten), 1) : 1;
		const side = (v: number) => Math.max(0, v) * (kind === 'perspective' ? stretch : 1) + spread;
		return { left: side(-dx), top: side(-dy), right: side(dx), bottom: side(dy) };
	},
	fieldReach: (p) => ({ outside: num(p.spread) + 1 }),
	handles: [{ kind: 'offset', params: ['angle', 'distance'] }],
	summary(p) {
		return {
			swatch: layerSwatch(SHADOW_LAYER, p),
			text: `${String(p.kind)}, ${fmtDistance(p.distance)}, ${paintText(p.paint)}`,
			primary: 'distance',
		};
	},
};

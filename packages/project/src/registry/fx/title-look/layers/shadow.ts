// `shadow` (§5.1): drop, long or perspective. Ported from Pachislop's drop and perspective shadows (effects/a/shadow.ts:
// offset, spread, blurred alpha; a floor projection), computed from the shape field, resolution independent and casting
// from the silhouette at this layer (rims above included). Direction: `angle` degrees, or away from the look's light with
// `useLight` (a floor shadow recedes: the light is in front of the title, so `away` is mirrored vertically).
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const DEG = Math.PI / 180;

/** Gaussian reach in standard deviations (the framework's convention for padded blurs). */
const SIGMAS = 3;

/** Param `blur` is the visible radius ≈ 3σ, as Pachislop's `size`. */
const sigmaOf = (p: Record<string, unknown>) => num(p.blur) / SIGMAS;

/** Fewest steps a long shadow takes per its length: the field must reach this share of it. */
const LONG_STEPS = 40;
/** The floor projection stays finite: a direction keeps this much of its vertical part (10° from the horizontal). */
const FLOOR_MIN_DY = 0.17;

/** The shadow's picture before blurring: the silhouette, moved by the kind's geometry. */
const COMMON = /* glsl */ `
vec2 tl_shadowDir() { return u_useLight ? -u_tlLightDir : fx_dir(u_angle); }
float tl_silhouette(TlSurface s) { return tl_inside(s.d, s.base + tl_px(u_spread)) * s.opacity; }
`;

const DROP_MASK = /* glsl */ `
vec4 tl_mask(TlSurface s) { return vec4(tl_silhouette(s)); }`;

const MASK: Record<string, string> = {
	drop: DROP_MASK,
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
	// The blur is in the picture's own space, before the projection: it grows with the distance from the floor line.
	perspective: DROP_MASK,
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

/**
 * The shadow cast on a floor at the base of the shape (Pachislop's perspectiveShadow): each pixel asks which height of
 * the shape falls on it. Sheared by the direction, squashed by Foreshorten, narrowing by Perspective, blurring from Near
 * to `blur` and fading with that height.
 */
const FLOOR = (blurred: boolean) => /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 b = tl_bounds();
  vec2 dir = u_useLight ? vec2(-u_tlLightDir.x, u_tlLightDir.y) : fx_dir(u_angle);
  if (abs(dir.y) < ${FLOOR_MIN_DY}) dir.y = dir.y < 0.0 ? -${FLOOR_MIN_DY} : ${FLOOR_MIN_DY};
  float len = max(tl_px(u_distance), 1.0);
  float H = max(b.w - b.y, 1.0);
  float shear = dir.x * len / H;
  float ratio = dir.y * len * max(u_foreshorten, 1.0) * 0.01 / H;
  float base = b.w + s.base + tl_px(u_floorOffset);
  float cx = 0.5 * (b.x + b.z);
  float h = (s.px.y - base) / ratio;
  float edge = clamp(h * abs(ratio) + 0.5, 0.0, 1.0);
  h = max(h, 0.0);
  float t = clamp(h / H, 0.0, 1.0);
  float k = max(1.0 - u_convergence * 0.01 * t, 0.05);
  vec2 q = vec2(cx + (s.px.x - cx - h * shear) / k, b.w - h) / u_canvasSize;
  if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) return vec4(0.0);
  TlSurface near = tl_surfaceAt(q);
  near.base = s.base;
  tl_aa = max(1.0, tl_px(u_blurNear));
  float a = tl_silhouette(near);
  tl_aa = 1.0;
  ${blurred ? 'a = mix(a, texture(u_tlBlur, q).a, smoothstep(0.0, 1.0, t));' : ''}
  return tlPaint_paint(s) * a * edge * max(1.0 - u_fade * 0.01 * t, 0.0) * (u_opacity * 0.01);
}`;

/** Padding of the floor projection, per side, before spread and blur. */
function floorReach(p: Record<string, unknown>) {
	const a = num(p.angle) * DEG;
	const d = num(p.distance);
	const free = p.useLight === true; // the light's direction is not known here: every side
	const dy = Math.max(Math.abs(Math.sin(a)), FLOOR_MIN_DY) * d * (Math.max(num(p.foreshorten), 1) / 100);
	const off = num(p.floorOffset);
	return {
		left: free ? d : Math.max(0, -Math.cos(a)) * d,
		right: free ? d : Math.max(0, Math.cos(a)) * d,
		top: (free || Math.sin(a) < 0 ? dy : 0) + Math.max(0, -off),
		bottom: (free || Math.sin(a) >= 0 ? dy : 0) + Math.max(0, off),
	};
}

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
		lp.percent('convergence', 'Perspective', 35, { group: 'perspective' }),
		lp.distance('blurNear', 'Blur Near', 1, { softMax: 30, group: 'perspective' }),
		lp.percent('fade', 'Fade', 75, { group: 'perspective' }),
		lp.distance('floorOffset', 'Floor Offset', 0, {
			min: -300,
			softMin: -50,
			softMax: 50,
			group: 'perspective',
		}),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'shadow' }),
		lp.percent('opacity', 'Opacity', 75),
	],
	shader(p) {
		const kind = String(p.kind);
		const blurred = sigmaOf(p) > 0;
		if (kind === 'perspective') return { glsl: `${COMMON}${FLOOR(blurred)}` };
		return { glsl: `${COMMON}${MASK[kind] ?? MASK.drop}${BODY(blurred, kind === 'drop')}` };
	},
	blur(p) {
		const sigma = sigmaOf(p);
		if (sigma <= 0) return null;
		return { sigma, mask: `${COMMON}${MASK[String(p.kind)] ?? MASK.drop}` };
	},
	reach(p) {
		const spread = num(p.spread) + num(p.blur);
		if (p.kind === 'perspective') {
			const r = floorReach(p);
			return {
				left: r.left + spread,
				top: r.top + spread,
				right: r.right + spread,
				bottom: r.bottom + spread,
			};
		}
		// The light's direction is not known here: `useLight` pads every side by the distance.
		const a = num(p.angle) * DEG;
		const d = num(p.distance);
		const dx = p.useLight === true ? d : d * Math.cos(a);
		const dy = p.useLight === true ? d : d * Math.sin(a);
		const side = (v: number) => (p.useLight === true ? Math.abs(v) : Math.max(0, v)) + spread;
		return { left: side(-dx), top: side(-dy), right: side(dx), bottom: side(dy) };
	},
	fieldReach(p) {
		const spread = num(p.spread) + 1;
		if (p.kind === 'long') return { outside: spread + num(p.distance) / LONG_STEPS };
		if (p.kind === 'perspective') return { outside: spread + num(p.blurNear) };
		return { outside: spread };
	},
	handles: [
		{ kind: 'offset', params: ['angle', 'distance'], when: { param: 'useLight', value: false } },
		{ kind: 'distance', params: ['distance'], when: { param: 'useLight', value: true } },
		{ kind: 'angle', params: ['angle'], target: 'light', when: { param: 'useLight', value: true } },
	],
	summary(p) {
		return {
			swatch: layerSwatch(SHADOW_LAYER, p),
			text: `${String(p.kind)}, ${fmtDistance(p.distance)}, ${paintText(p.paint)}`,
			primary: 'distance',
		};
	},
};

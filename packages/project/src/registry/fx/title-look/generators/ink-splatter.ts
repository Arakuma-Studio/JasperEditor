// Ink Splatter (TL-061, TL-062): seeded drops, satellite droplets and drag streaks thrown off the silhouette, after
// Pachislop's generators/inkSplatter.ts. Pachislop places drops by rejection on a grid of the current picture, so one
// flipped cell changes which drops exist. Here a drop is a seeded site in the anchor box: it exists by its distance to the
// shape, read from the field, with a smooth gate, so it grows or shrinks when the shape moves and never re-rolls. Reveal
// lands each drop at its own moment, a closed form of Reveal (or of time, with Reveal Time).
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG_QUAD } from './light-streaks.ts';
import { anchorParam, GLSL_TLG, GLSL_TLG_SITES, hex, num, variationParam } from './shared.ts';

/** Most main drops at Amount 100 %. */
const MAX_DROPS = 80;
/** Sites per drop that lands: about one in this many passes the gate around a title. */
const SITES_PER_DROP = 5;
/** Instances per site: the drop and its satellites. */
const PER_SITE = 7;

const sites = (p: LayerParams) => Math.round((num(p.amount) / 100) * MAX_DROPS * SITES_PER_DROP);
const reachOf = (p: LayerParams) => num(p.spread) + num(p.streakLength) + 3.5 * num(p.dropSize) + 3;

export const GENERATOR_INK_SPLATTER = defineGenerator({
	id: 'inkSplatter',
	label: 'Ink Splatter',
	description: 'Ink drops, droplets and drag streaks thrown off the title, landing one by one as it reveals.',
	keywords: ['ink', 'splash', 'paint', 'blood', 'brush', 'drops'],
	params: [
		lp.percent('amount', 'Amount', 45),
		lp.distance('spread', 'Spread', 75, { softMax: 400 }),
		lp.distance('dropSize', 'Drop Size', 11, { min: 0.5, softMax: 100 }),
		lp.number('satellites', 'Satellite Droplets', 60, { min: 0, max: 200, step: 1 }, { unit: '%' }),
		lp.percent('streaks', 'Streaks', 35),
		lp.distance('streakLength', 'Streak Length', 55, { softMax: 400 }),
		lp.choice(
			'streakDirection',
			'Streak Direction',
			['radial', 'directional'],
			['Away from the Centre', 'One Direction'],
			'radial',
		),
		lp.angle('angle', 'Streak Angle', 10),
		lp.percent('reveal', 'Reveal', 100),
		lp.number('revealTime', 'Reveal Time', 0, { min: 0, max: 60, softMax: 5, step: 0.01 }, { unit: 's' }),
		anchorParam(),
		lp.color('color', 'Ink Colour', hex('#0b0907')),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	shapeAware: true,
	standIn: 'disc',
	usesBounds: () => true,
	color: { role: 'shadow', mode: 'flat' },
	presets: [
		{ id: 'black', label: 'Black Ink Behind', params: {} },
		{ id: 'splash', label: 'Splash In', params: { revealTime: 0.8, streaks: 60, variation: 2 } },
		{ id: 'red', label: 'Red Ink', params: { color: hex('#b0000c') } },
		{
			id: 'swept',
			label: 'Swept Streaks',
			params: { streaks: 80, streakLength: 110, streakDirection: 'directional' },
		},
	],
	reach: reachOf,
	fieldReach: (p) => ({ outside: num(p.spread) + 2 }),
	timeDependent: (p) => num(p.revealTime) > 0,
	summary: (p) => `${Math.round(num(p.amount))} %, spread ${Math.round(num(p.spread))} %`,
	prepass: (p, c) => [
		c.pass({
			output: 'tlGenA',
			format: 'rgba16f',
			include: [GLSL_UV, GLSL_TLG_SITES, GLSL_TLG_QUAD],
			draw: {
				vertices: 6,
				instances: sites(p) * PER_SITE,
				blend: 'over',
				vert: /* glsl */ `
out vec2 v_p;
flat out vec2 v_a;
flat out vec2 v_b;
flat out vec2 v_r;
flat out float v_id;
void main() {
  tlg_begin();
  int site = gl_InstanceID / ${PER_SITE};
  int j = gl_InstanceID % ${PER_SITE};
  float spread = max(tl_px(u_spread), 1.0);
  float size = tl_px(u_dropSize);
  // The site: anywhere in the anchor box grown by the spread, fixed for the seed.
  vec2 lo = tlg_anchor(vec2(0.0)) - spread, hi = tlg_anchor(vec2(1.0)) + spread;
  vec2 q = mix(lo, hi, vec2(tlg_h(site, 0), tlg_h(site, 1)));
  vec4 f = tlg_field(q);
  float d = max(f.x, 0.0);
  float near = 1.0 - d / spread;
  // Dense and heavy at the edge, thinning out with distance; few land on the letters. The gate is smooth in the
  // distance: a drop the shape moves away from shrinks away.
  float want = f.x <= 0.0 ? 0.25 : pow(max(near, 0.0), 1.2);
  float gate = smoothstep(0.0, 0.08, want - tlg_h(site, 2));
  if (gate <= 0.0 || near <= 0.0) { fx_cull(); return; }
  float progress = clamp(u_reveal * 0.01, 0.0, 1.0);
  if (u_revealTime > 0.0) progress *= clamp(u_tlTime / u_revealTime, 0.0, 1.0);
  // Per-drop reveal: each lands at its own moment over a quarter of the reveal; satellites a moment later.
  float start = tlg_h(site, 3) * 0.65 + (j > 0 ? 0.1 : 0.0);
  float k = clamp((progress - start) / 0.25, 0.0, 1.0);
  if (progress >= 1.0) k = 1.0;
  if (k <= 0.0) { fx_cull(); return; }
  float pop = k * (1.0 + 0.35 * (1.0 - k));
  float rad = size * (0.2 + 0.8 * pow(tlg_h(site, 4), 2.0)) * (0.45 + 0.55 * near) * gate;
  vec2 mid = 0.5 * (tlg_anchor(vec2(0.0)) + tlg_anchor(vec2(1.0)));
  vec2 away = q - mid;
  float base = u_streakDirection == 0 ? atan(away.y, away.x) : radians(u_angle);
  float dirA = base + (tlg_h(site, 5) - 0.5) * (u_streakDirection == 0 ? 0.5 : 0.3);
  vec2 u = vec2(cos(dirA), sin(dirA));
  vec2 head = q;
  bool streak = tlg_h(site, 6) < u_streaks * 0.01 && u_streakLength > 0.0;
  if (streak) head = q + u * tl_px(u_streakLength) * (0.35 + 0.65 * tlg_h(site, 7)) * (0.5 + 0.5 * near);
  vec2 A, B, R;
  if (j == 0) {
    // A drag streak: a thin tail at the landing point, the bulk piled up at the far end, reaching there as it reveals.
    A = q;
    B = mix(q, head, k);
    R = streak ? vec2(max(tl_px(0.3), rad * 0.22), rad * 0.95) * pop : vec2(rad) * pop;
  } else {
    float sats = floor((u_satellites * 0.01) * (1.0 + 5.0 * tlg_h(site, 8)) * (0.4 + 0.6 * near) + 0.5);
    if (float(j) > sats) { fx_cull(); return; }
    int id = site * ${PER_SITE} + j;
    float a = dirA + (tlg_h(id, 10) - 0.5) * 2.4;
    float far0 = rad * (1.4 + 2.2 * pow(tlg_h(id, 11), 1.5));
    float sr = max(tl_px(0.3), rad * (0.06 + 0.2 * pow(tlg_h(id, 12), 2.0)));
    A = head + vec2(cos(a), sin(a)) * far0 * k;
    B = A;
    R = vec2(sr) * pop;
  }
  v_a = A;
  v_b = B;
  v_r = R;
  v_id = tlg_h(gl_InstanceID, 13);
  vec2 ab = B - A;
  float len = length(ab);
  vec2 ux = len > 1.0e-3 ? ab / len : vec2(1.0, 0.0);
  vec2 uy = vec2(-ux.y, ux.x);
  float pad = max(R.x, R.y) * 1.3 + 1.5;
  vec2 corner = tlg_corner(gl_VertexID);
  v_p = 0.5 * (A + B) + ux * corner.x * (0.5 * len + pad) + uy * corner.y * pad;
  fx_emit(v_p);
}`,
			},
			frag: /* glsl */ `
in vec2 v_p;
flat in vec2 v_a;
flat in vec2 v_b;
flat in vec2 v_r;
flat in float v_id;
void main() {
  tlg_begin();
  vec2 ab = v_b - v_a;
  float t = clamp(dot(v_p - v_a, ab) / max(dot(ab, ab), 1.0e-6), 0.0, 1.0);
  float r = mix(v_r.x, v_r.y, t);
  float d = length(v_p - (v_a + ab * t)) - r;
  // A ragged rim at the scale of the drop: big blots wobble, tiny droplets stay round.
  float s = max(v_r.y, 1.0);
  float n = tlg_vnoise((v_p - v_b) / s * 2.2 + v_id * 170.0) + 0.5 * tlg_vnoise((v_p - v_b) / s * 5.0 + v_id * 50.0) - 0.75;
  d -= n * 0.45 * r;
  fragColor = vec4(clamp(0.5 - d / max(length(vec2(dFdx(d), dFdy(d))), 1.0e-3), 0.0, 1.0));
}`,
		}),
	],
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) {
  float a = clamp(texture(u_tlGenA, s.uv).a, 0.0, 1.0);
  return vec4(tlg_rgb(u_color) * a, a);
}`,
});

// Sapphire geometric / shape wipes: S_WipeLine, S_WipeClock, S_WipeCircle, S_WipeRectangle, S_WipeStar,
// S_WipeWedge, S_WipeDoubleWedge, S_WipeFourWedges. See ./common.ts for the composite (edge, border, glow).
import { fxParam } from '../../fx/params.ts';
import { GLSL_SW_SHAPE, sapphireWipe, swParam } from './common.ts';

/** S_WipeLine: a straight edge crossing the frame along Angle. */
export const S_WIPE_LINE = sapphireWipe({
	name: 'wipe-line',
	label: 'S_WipeLine',
	description: 'A simple line wipe: a straight edge crosses the frame in the direction of Angle.',
	keywords: ['line', 'linear', 'straight'],
	params: [swParam.edgeSoftness(), swParam.angle('angle', 'Angle', 45)],
	frag: /* glsl */ `
void main() {
  float d = tr_linearWipe(tr_px(), fx_dir(u_angle), tr_progress(), u_swMargin);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), d);
}`,
});

/**
 * S_WipeClock: a clock wipe around Center. The sector of B opens at Angle Open and sweeps a full turn; its trailing
 * edge turns from Angle Open to Angle Close meanwhile (equal angles: a classic clock wipe).
 */
export const S_WIPE_CLOCK = sapphireWipe({
	name: 'wipe-clock',
	label: 'S_WipeClock',
	description:
		'A clock wipe: a hand sweeps around the center point, clockwise or counter-clockwise, from Angle Open to Angle Close.',
	keywords: ['clock', 'radial', 'sweep', 'hand'],
	params: [
		swParam.choice('direction', 'Direction', ['clockwise', 'counterClockwise'], ['Clockwise', 'CounterCW']),
		swParam.edgeSoftness(),
		swParam.angle('angleOpen', 'Angle Open', -90),
		swParam.angle('angleClose', 'Angle Close', -90),
	],
	center: true,
	frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 c = u_center * u_compSize;
  vec2 dv = tr_px() - c;
  float r = max(length(dv), 1.0);
  float s = u_direction == 0 ? 1.0 : -1.0;
  // Trailing edge: Angle Open → Angle Close; the sector (in the sweep direction) grows 0 → 360° (+ margins).
  float trail = fx_deg(mix(u_angleOpen, u_angleClose, p));
  float slack = 2.0 * u_swMargin / max(0.25 * tr_coverRadius(c), 1.0);
  float sweep = mix(-slack, FX_TAU + slack, p);
  float a = mod(s * (atan(dv.y, dv.x) - trail), FX_TAU);
  float off = abs(a - 0.5 * sweep);
  off = min(off, FX_TAU - off);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), r * (0.5 * sweep - off));
}`,
});

/** S_WipeCircle: a circle (oval with Rel Width) shrinking onto Center (Circle In) or growing from it (Circle Out). */
export const S_WIPE_CIRCLE = sapphireWipe({
	name: 'wipe-circle',
	label: 'S_WipeCircle',
	description:
		'A circle wipe: the outgoing clip shrinks into a circle (Circle In) or the incoming clip grows out of one (Circle Out).',
	keywords: ['circle', 'iris', 'oval', 'round'],
	params: [
		swParam.choice('wipeDirection', 'Wipe Direction', ['circleIn', 'circleOut'], ['Circle In', 'Circle Out']),
		swParam.edgeSoftness(),
		swParam.rel('relWidth', 'Rel Width', 1),
		swParam.angle('rotate', 'Rotate', 0),
	],
	center: true,
	include: [GLSL_SW_SHAPE],
	frag: /* glsl */ `
float sw_gauge(vec2 px) {
  vec2 q = fx_rot(-fx_deg(u_rotate)) * (px - u_center * u_compSize);
  q.x /= max(u_relWidth, 1e-3);
  return length(q);
}
void main() {
  float d = sw_shapeWipe(u_wipeDirection == 1, u_swMargin);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), d);
}`,
});

/** S_WipeRectangle: a rotated rectangle (Rel Width = width / height) shrinking (Rect In) or growing (Rect Out). */
export const S_WIPE_RECTANGLE = sapphireWipe({
	name: 'wipe-rectangle',
	label: 'S_WipeRectangle',
	description:
		'A rectangle wipe: the outgoing clip shrinks into a rectangle (Rect In) or the incoming clip grows out of one (Rect Out).',
	keywords: ['rectangle', 'box', 'square', 'iris'],
	params: [
		swParam.choice('wipeDirection', 'Wipe Direction', ['rectIn', 'rectOut'], ['Rect In', 'Rect Out']),
		swParam.edgeSoftness(),
		swParam.angle('angle', 'Angle', 0),
		swParam.rel('relWidth', 'Rel Width', 1.25, 0.02),
	],
	center: true,
	include: [GLSL_SW_SHAPE],
	frag: /* glsl */ `
float sw_gauge(vec2 px) {
  vec2 q = fx_rot(-fx_deg(u_angle)) * (px - u_center * u_compSize);
  return max(abs(q.x) / max(u_relWidth, 1e-3), abs(q.y));
}
void main() {
  float d = sw_shapeWipe(u_wipeDirection == 1, u_swMargin);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), d);
}`,
});

/**
 * S_WipeStar: a star of Points points (Pointiness 0 = a regular polygon, larger = sharper spikes) shrinking onto
 * Center (Star In) or growing from it (Star Out).
 */
export const S_WIPE_STAR = sapphireWipe({
	name: 'wipe-star',
	label: 'S_WipeStar',
	description:
		'A star wipe: the outgoing clip shrinks into a star (Star In) or the incoming clip grows out of one (Star Out).',
	keywords: ['star', 'points', 'polygon', 'iris'],
	params: [
		swParam.choice('wipeDirection', 'Wipe Direction', ['starIn', 'starOut'], ['Star In', 'Star Out']),
		swParam.edgeSoftness(),
		fxParam.number('points', 'Points', 5, { min: 3, max: 64, softMax: 20, step: 1 }, { animatable: false }),
		fxParam.number('pointiness', 'Pointiness', 1.1, { min: 0, max: 20, softMax: 5, step: 0.01 }),
		swParam.angle('angle', 'Angle', 0),
		swParam.rel('relWidth', 'Rel Width', 1),
	],
	center: true,
	include: [GLSL_SW_SHAPE],
	frag: /* glsl */ `
// Star gauge: |q| over the radius of the unit star outline in q's direction (outer points at radius 1, one up).
float sw_gauge(vec2 px) {
  vec2 q = fx_rot(-fx_deg(u_angle)) * (px - u_center * u_compSize);
  q.x /= max(u_relWidth, 1e-3);
  float n = max(3.0, floor(u_points + 0.5));
  float an = FX_PI / n;
  float k = cos(an) / (1.0 + max(u_pointiness, 0.0));
  float a = abs(mod(atan(q.x, -q.y) + an, 2.0 * an) - an);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 e = k * vec2(cos(an), sin(an)) - vec2(1.0, 0.0);
  float rho = e.y / max(dir.x * e.y - dir.y * e.x, 1e-5);
  return length(q) / max(rho, 1e-4);
}
void main() {
  float d = sw_shapeWipe(u_wipeDirection == 1, u_swMargin);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), d);
}`,
});

/** Wedge geometry: frame coordinates rotated by Angle, and the frame's half extents along / across it. */
const WEDGE_FRAME = /* glsl */ `
vec2 swWedgeQ(vec2 px) { return fx_rot(-fx_deg(u_angle)) * (px - 0.5 * u_compSize); }
vec2 swWedgeExt() {
  vec2 d = fx_dir(u_angle);
  return 0.5 * vec2(abs(d.x) * u_compSize.x + abs(d.y) * u_compSize.y, abs(d.y) * u_compSize.x + abs(d.x) * u_compSize.y);
}
`;

const WEDGE_DIRECTION = swParam.choice(
	'wipeDirection',
	'Wipe Direction',
	['wedgeIn', 'wedgeOut'],
	['Wedge In', 'Wedge Out'],
);
const POINTINESS = fxParam.number('pointiness', 'Pointiness', 2, { min: 0, max: 50, softMax: 10, step: 0.01 });

/**
 * S_WipeWedge: a wedge (a triangle with its point leading) enters from one side and travels along Angle, widening
 * until it covers the frame (Wedge In); Wedge Out plays the shape the other way (the outgoing clip is a wedge that
 * retracts to its base).
 */
export const S_WIPE_WEDGE = sapphireWipe({
	name: 'wipe-wedge',
	label: 'S_WipeWedge',
	description:
		'A wedge wipe: a pointed wedge of the incoming clip enters from one side along Angle and widens over the frame.',
	keywords: ['wedge', 'arrow', 'chevron', 'triangle'],
	params: [WEDGE_DIRECTION, swParam.edgeSoftness(), swParam.angle('angle', 'Angle', 0), POINTINESS],
	include: [GLSL_SW_SHAPE],
	frag: /* glsl */ `${WEDGE_FRAME}
float sw_gauge(vec2 px) {
  vec2 q = swWedgeQ(px);
  return q.x + swWedgeExt().x + max(u_pointiness, 0.0) * abs(q.y);
}
void main() {
  float d = sw_shapeWipe(u_wipeDirection == 0, u_swMargin);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), d);
}`,
});

/** S_WipeDoubleWedge: two wedges enter from opposite sides (along Angle) and meet in the middle. */
export const S_WIPE_DOUBLE_WEDGE = sapphireWipe({
	name: 'wipe-double-wedge',
	label: 'S_WipeDoubleWedge',
	description:
		'A double wedge wipe: two pointed wedges of the incoming clip enter from opposite sides and meet in the middle.',
	keywords: ['wedge', 'double', 'arrows', 'chevron'],
	params: [WEDGE_DIRECTION, swParam.edgeSoftness(), swParam.angle('angle', 'Angle', 0), POINTINESS],
	include: [GLSL_SW_SHAPE],
	frag: /* glsl */ `${WEDGE_FRAME}
float sw_gauge(vec2 px) {
  vec2 q = swWedgeQ(px);
  return swWedgeExt().x - abs(q.x) + max(u_pointiness, 0.0) * abs(q.y);
}
void main() {
  float d = sw_shapeWipe(u_wipeDirection == 0, u_swMargin);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), d);
}`,
});

/**
 * S_WipeFourWedges: four right-angled wedges grow from the four sides and merge, the outgoing clip ending as an
 * "X" along the diagonals (Wedge In); Wedge Out grows the incoming clip from that X. Aspect Scale stretches the
 * shapes horizontally (1: the X runs corner to corner).
 */
export const S_WIPE_FOUR_WEDGES = sapphireWipe({
	name: 'wipe-four-wedges',
	label: 'S_WipeFourWedges',
	description: 'A four wedges wipe: wedges grow in from the four sides and merge into an X shape.',
	keywords: ['wedge', 'four', 'x', 'cross', 'diagonal'],
	params: [
		WEDGE_DIRECTION,
		swParam.edgeSoftness(),
		swParam.angle('angle', 'Angle', 0),
		swParam.rel('aspectScale', 'Aspect Scale', 1, 0.01),
	],
	include: [GLSL_SW_SHAPE],
	frag: /* glsl */ `${WEDGE_FRAME}
float sw_gauge(vec2 px) {
  vec2 ext = swWedgeExt();
  vec2 q = swWedgeQ(px);
  q.x *= ext.y / max(ext.x * u_aspectScale, 1e-3);
  return ext.y - abs(abs(q.x) - abs(q.y));
}
void main() {
  float d = sw_shapeWipe(u_wipeDirection == 0, u_swMargin);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), d);
}`,
});

export const SAPPHIRE_SHAPE_WIPES = [
	S_WIPE_CIRCLE,
	S_WIPE_CLOCK,
	S_WIPE_DOUBLE_WEDGE,
	S_WIPE_FOUR_WEDGES,
	S_WIPE_LINE,
	S_WIPE_RECTANGLE,
	S_WIPE_STAR,
	S_WIPE_WEDGE,
] as const;

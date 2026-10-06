// Sapphire geometric pattern wipes: S_WipeCells, S_WipeChecker, S_WipeDots, S_WipeMoire, S_WipeRings,
// S_WipeStripes, S_WipeTiles. Each builds a 0..1 switching-order field (see ./common.ts) plus Grad Add.
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { fxParam } from '../../fx/params.ts';
import { sapphireWipe, swParam } from './common.ts';

const GROW_SHRINK = ['grow', 'shrink'] as const;
const GROW_SHRINK_LABELS = ['Grow', 'Shrink'] as const;

/** The lattice params of Checker / Dots / Tiles (Sapphire's order after Edge Softness). */
const latticeParams = (angle: number, frequency: number) => [
	swParam.angle('angle', 'Angle', angle),
	swParam.frequency(frequency),
	swParam.rel('relWidth', 'Rel Width'),
	swParam.rel('relWidPreRot', 'Rel Wid Pre Rot'),
	swParam.shift(),
];
const LATTICE_UV = 'sw_patternUv(tr_px(), u_frequency, u_relWidth, u_angle, u_relWidPreRot, u_shift)';

/**
 * S_WipeCells: a Voronoi pattern of cells; the incoming clip grows inside every cell from its seed point (Grow) or
 * in from the cell walls (Shrink), in the cell's own polygonal shape.
 */
export const S_WIPE_CELLS = sapphireWipe({
	name: 'wipe-cells',
	label: 'S_WipeCells',
	description:
		'A cells wipe: a pattern of procedurally generated cellular shapes, each growing (or shrinking) to reveal the incoming clip.',
	keywords: ['cells', 'voronoi', 'cellular', 'organic'],
	params: [
		swParam.choice('cells', 'Cells', GROW_SHRINK, GROW_SHRINK_LABELS),
		swParam.edgeSoftness(),
		swParam.frequency(6, 0.01),
		swParam.rel('relWidth', 'Rel Width'),
		swParam.seed(),
		swParam.shift(),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	include: [GLSL_NOISE],
	frag: /* glsl */ `
void main() {
  vec2 q = sw_patternUv(tr_px(), u_frequency, u_relWidth, 0.0, 1.0, u_shift);
  vec2 f = fx_cellular(q, 1.0, u_seed);
  // 0 at the cell's seed point, 1 on its walls (F2 − F1 ≈ twice the distance to the nearest wall).
  float v = f.x / max(f.x + 0.5 * (f.y - f.x), 1e-5);
  v = sw_growShrink(v, u_cells == 1);
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

/**
 * S_WipeChecker: squares grow from the black cells of a (rotated) checkerboard: half-way the frame is a checkerboard
 * of both clips, then the squares spread over the white cells. Shrink plays it from the other side.
 */
export const S_WIPE_CHECKER = sapphireWipe({
	name: 'wipe-checker',
	label: 'S_WipeChecker',
	description:
		'A checker wipe: a grid of growing (or shrinking) checkers; mid-way the two clips form a checkerboard.',
	keywords: ['checker', 'checkerboard', 'grid', 'squares'],
	params: [
		swParam.choice('checkers', 'Checkers', GROW_SHRINK, GROW_SHRINK_LABELS),
		swParam.edgeSoftness(),
		...latticeParams(45, 6),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	frag: /* glsl */ `
void main() {
  vec2 q = ${LATTICE_UV};
  vec2 c = floor(q);
  // Chebyshev distance to the nearest "black" cell centre (cells with an even i + j), in cells: 0.5 = the black
  // cells are full, 1 = everything.
  float v = 2.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 k = c + vec2(float(i), float(j));
      if (mod(k.x + k.y, 2.0) > 0.5) continue;
      vec2 o = abs(q - k - 0.5);
      v = min(v, max(o.x, o.y));
    }
  v = clamp(v, 0.0, 1.0);
  if (u_checkers == 1) v = 1.0 - v;
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

/** S_WipeDots: a (rotated) grid of dots growing until they cover their cells (Grow), or shrinking holes (Shrink). */
export const S_WIPE_DOTS = sapphireWipe({
	name: 'wipe-dots',
	label: 'S_WipeDots',
	description: 'A dots wipe: a grid of growing (or shrinking) dots reveals the incoming clip.',
	keywords: ['dots', 'circles', 'halftone', 'grid'],
	params: [
		swParam.choice('dots', 'Dots', GROW_SHRINK, GROW_SHRINK_LABELS),
		swParam.edgeSoftness(),
		...latticeParams(45, 6),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	frag: /* glsl */ `
void main() {
  vec2 q = ${LATTICE_UV};
  float v = clamp(length(fract(q) - 0.5) / 0.70710678, 0.0, 1.0);
  v = sw_growShrink(v, u_dots == 1);
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

/** S_WipeStripes: parallel stripes (rotated by Angle) widen from their centre lines. */
export const S_WIPE_STRIPES = sapphireWipe({
	name: 'wipe-stripes',
	label: 'S_WipeStripes',
	description: 'A stripes wipe: a series of parallel stripes widen until the incoming clip fills the frame.',
	keywords: ['stripes', 'bands', 'blinds', 'lines'],
	params: [
		swParam.edgeSoftness(),
		swParam.angle('angle', 'Angle', 45),
		swParam.frequency(6),
		fxParam.number('shiftStripes', 'Shift Stripes', 0, { softMin: -5, softMax: 5, step: 0.01 }),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	frag: /* glsl */ `
void main() {
  float x = dot(tr_px() - 0.5 * u_compSize, fx_dir(u_angle)) / max(u_compSize.x, 1.0) * u_frequency;
  vec3 g = sw_grad(sw_tri(x - u_shiftStripes), u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

/**
 * S_WipeRings: concentric rings around Center widen from their middle lines. Bulge makes the inner rings thicker
 * (> 0) or thinner (< 0) than the outer ones; Radial Grad makes the rings switch from the centre outwards (> 0) or
 * inwards (< 0).
 */
export const S_WIPE_RINGS = sapphireWipe({
	name: 'wipe-rings',
	label: 'S_WipeRings',
	description: 'A rings wipe: a pattern of concentric rings widen until the incoming clip fills the frame.',
	keywords: ['rings', 'concentric', 'circles', 'ripple'],
	params: [
		swParam.edgeSoftness(),
		swParam.frequency(4),
		swParam.rel('relWidth', 'Rel Width'),
		fxParam.number('shiftStripes', 'Shift Stripes', 0, { min: -5, max: 5, step: 0.01 }),
		fxParam.number('bulge', 'Bulge', 0, { min: -1, max: 1, step: 0.01 }),
		swParam.angle('rotate', 'Rotate', 0),
		swParam.gradAdd(),
		swParam.gradAngle(),
		fxParam.number('radialGrad', 'Radial Grad', 0, { softMin: -10, softMax: 10, step: 0.01 }),
	],
	center: true,
	frag: /* glsl */ `
void main() {
  vec2 c = u_center * u_compSize;
  mat2 rot = fx_rot(-fx_deg(u_rotate));
  vec2 q = rot * (tr_px() - c);
  q.x /= max(u_relWidth, 1e-3);
  float rmax = 0.0;
  vec2 corners[4] = vec2[4](vec2(0.0), vec2(u_compSize.x, 0.0), vec2(0.0, u_compSize.y), u_compSize);
  for (int i = 0; i < 4; i++) {
    vec2 k = rot * (corners[i] - c);
    k.x /= max(u_relWidth, 1e-3);
    rmax = max(rmax, length(k));
  }
  float rn = clamp(length(q) / max(rmax, 1.0), 0.0, 1.0);
  float rb = pow(rn, exp2(u_bulge)) * rmax;
  float stripes = sw_tri(rb / max(0.5 * u_compSize.x, 1.0) * u_frequency - u_shiftStripes);
  float rg = u_radialGrad;
  float v = stripes + rg * rn + u_gradAdd * sw_gradPos(tr_px(), u_gradAngle);
  float lo = min(0.0, u_gradAdd) + min(0.0, rg);
  float hi = 1.0 + max(0.0, u_gradAdd) + max(0.0, rg);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(v, lo, hi, u_swMargin));
}`,
});

/**
 * S_WipeTiles: a tiling of hexagons, triangles, diamonds or stars; each tile grows from its centre (Grow) or shrinks
 * towards it (Shrink). Morph Shapes turns the growing shapes inside their tiles.
 */
export const S_WIPE_TILES = sapphireWipe({
	name: 'wipe-tiles',
	label: 'S_WipeTiles',
	description:
		'A tiles wipe: a pattern of growing (or shrinking) hexagons, triangles, diamonds or stars reveals the incoming clip.',
	keywords: ['tiles', 'hexagons', 'triangles', 'diamonds', 'stars', 'honeycomb'],
	params: [
		swParam.choice(
			'tileShapes',
			'Tile Shapes',
			['hexagons', 'triangles', 'diamonds', 'stars'],
			['Hexagons', 'Triangles', 'Diamonds', 'Stars'],
		),
		swParam.choice('shapesDir', 'Shapes Dir', GROW_SHRINK, GROW_SHRINK_LABELS),
		swParam.edgeSoftness(),
		...latticeParams(0, 4),
		swParam.angle('morphShapes', 'Morph Shapes', 0),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	frag: /* glsl */ `
const float SW_S3 = 1.7320508;
// Gauges (1 on the outline) of the unit tile shapes around their centre.
float swHexG(vec2 l) { l = abs(l); return max(l.x, dot(l, vec2(0.5, 0.8660254))) / 0.5; }
float swTriG(vec2 l) { return max(-l.y, max(dot(l, vec2(0.8660254, 0.5)), dot(l, vec2(-0.8660254, 0.5)))) / 0.28867513; }
float swDiaG(vec2 l) { l = abs(l); return max(l.x, l.y) / 0.5; }
float swStarG(vec2 l) {
  const float an = 0.62831853;                  // 5 points
  const float k = 0.42;
  float a = abs(mod(atan(l.x, -l.y) + an, 2.0 * an) - an);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 e = k * vec2(cos(an), sin(an)) - vec2(1.0, 0.0);
  float rho = e.y / max(dir.x * e.y - dir.y * e.x, 1e-5);
  return length(l) / max(rho * 0.5, 1e-4);
}
float swShapeG(int s, vec2 l) {
  l = fx_rot(-fx_deg(u_morphShapes)) * l;
  return s == 0 ? swHexG(l) : s == 1 ? swTriG(l) : s == 2 ? swDiaG(l) : swStarG(l);
}
void main() {
  vec2 q = ${LATTICE_UV};
  int s = u_tileShapes;
  vec2 l;            // position relative to the tile centre (pattern units)
  float flip = 1.0;  // triangles alternate up / down
  if (s == 0) {
    vec2 sz = vec2(1.0, SW_S3);
    vec2 a = mod(q, sz) - 0.5 * sz;
    vec2 b = mod(q - 0.5 * sz, sz) - 0.5 * sz;
    l = dot(a, a) < dot(b, b) ? a : b;
  } else if (s == 1) {
    vec2 sk = vec2(q.x - q.y / SW_S3, q.y * 2.0 / SW_S3);
    vec2 f = fract(sk);
    bool up = f.x + f.y < 1.0;
    vec2 cs = floor(sk) + (up ? vec2(1.0 / 3.0) : vec2(2.0 / 3.0));
    l = q - vec2(cs.x + 0.5 * cs.y, cs.y * SW_S3 * 0.5);
    flip = up ? 1.0 : -1.0;
  } else if (s == 2) {
    l = fract(fx_rot(0.78539816) * q * 0.70710678) - 0.5;
  } else {
    l = fract(q) - 0.5;
  }
  // Normalise by the gauge's largest value over the tile (its vertices; the star: its square cell's border).
  float norm = 0.0;
  if (s == 0) {
    for (int i = 0; i < 6; i++) {
      float a = 1.5707963 + float(i) * 1.0471976;
      norm = max(norm, swShapeG(0, 0.57735027 * vec2(cos(a), sin(a))));
    }
  } else if (s == 1) {
    norm = max(swShapeG(1, vec2(-0.5, -0.28867513)), max(swShapeG(1, vec2(0.5, -0.28867513)), swShapeG(1, vec2(0.0, 0.57735027))));
  } else if (s == 2) {
    norm = max(max(swShapeG(2, vec2(0.5)), swShapeG(2, vec2(-0.5))), max(swShapeG(2, vec2(0.5, -0.5)), swShapeG(2, vec2(-0.5, 0.5))));
  } else {
    for (int i = 0; i < 16; i++) {
      float t = float(i) / 16.0 - 0.5;
      norm = max(norm, max(max(swShapeG(3, vec2(t, -0.5)), swShapeG(3, vec2(t, 0.5))), max(swShapeG(3, vec2(-0.5, t)), swShapeG(3, vec2(0.5, t)))));
    }
  }
  float v = clamp(swShapeG(s, l * flip) / max(norm * 1.01, 1e-4), 0.0, 1.0);
  v = sw_growShrink(v, u_shapesDir == 1);
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

/**
 * S_WipeMoire: two sets of concentric rings (A Center, B Center) interfere into a moire pattern whose bands carry the
 * switch; the ring phases move during the transition (Phase Speed, Moire Speed: cycles per transition).
 */
export const S_WIPE_MOIRE = sapphireWipe({
	name: 'wipe-moire',
	label: 'S_WipeMoire',
	description: 'A moire wipe: a pattern of two combined sets of concentric rings reveals the incoming clip.',
	keywords: ['moire', 'interference', 'rings', 'concentric'],
	params: [
		swParam.edgeSoftness(6),
		fxParam.point('aCenter', 'A Center', [0.292, 0.731]),
		fxParam.point('bCenter', 'B Center', [0.708, 0.269]),
		swParam.frequency(5, 0.5),
		fxParam.number('phaseStart', 'Phase Start', 0, { softMin: -5, softMax: 5, step: 0.01 }),
		fxParam.number('phaseSpeed', 'Phase Speed', 1, { softMin: -10, softMax: 10, step: 0.01 }),
		fxParam.number('moirePhase', 'Moire Phase', 0, { softMin: -5, softMax: 5, step: 0.01 }),
		fxParam.number('moireSpeed', 'Moire Speed', 0, { softMin: -10, softMax: 10, step: 0.01 }),
		swParam.rel('aRelFreq', 'A Rel Freq'),
		swParam.rel('aRelWidth', 'A Rel Width', 1, 0.2),
		swParam.angle('aRotate', 'A Rotate', 0),
		swParam.rel('bRelFreq', 'B Rel Freq'),
		swParam.rel('bRelWidth', 'B Rel Width', 1, 0.2),
		swParam.angle('bRotate', 'B Rotate', 0),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	frag: /* glsl */ `
float swRing(vec2 c, float relW, float rotate) {
  vec2 q = fx_rot(-fx_deg(rotate)) * (tr_px() - c * u_compSize);
  q.x /= max(relW, 1e-3);
  return length(q) / max(u_compSize.x, 1.0);
}
void main() {
  float p = tr_progress();
  float ph = u_phaseStart + u_phaseSpeed * p;
  float mp = u_moirePhase + u_moireSpeed * p;
  float ra = swRing(u_aCenter, u_aRelWidth, u_aRotate) * u_frequency * u_aRelFreq;
  float rb = swRing(u_bCenter, u_bRelWidth, u_bRotate) * u_frequency * u_bRelFreq;
  float v = 0.5 + 0.25 * (cos(FX_TAU * (ra + ph)) + cos(FX_TAU * (rb + ph + mp)));
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

export const SAPPHIRE_PATTERN_WIPES = [
	S_WIPE_CELLS,
	S_WIPE_CHECKER,
	S_WIPE_DOTS,
	S_WIPE_MOIRE,
	S_WIPE_RINGS,
	S_WIPE_STRIPES,
	S_WIPE_TILES,
] as const;

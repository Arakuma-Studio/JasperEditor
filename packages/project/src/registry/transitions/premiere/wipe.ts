// Premiere ▸ Video Transitions ▸ Wipe (part of the premiere-transitions family; see ../premiere-transitions.ts).
// Every wipe keeps the progress contract (A at 0, B at 1) including its border and anti-aliased edge: the moving
// edges start a margin outside the frame and end a margin past it (`m` of `defineEdgeWipe`).
import type { TransitionSpec } from '../../../transitions.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_BLOCKS, GLSL_TR_WIPE } from '../glsl.ts';
import {
	CORNERS,
	countParam,
	DIR4,
	DIR8,
	defineEdgeWipe,
	GLSL_PR_COMMON,
	ORIENT,
	START4,
	selectorIndex,
	selectorParam,
	selectorVec,
} from './common.ts';

const bin = TRANSITION_BINS.wipe;

/** Wipe ▸ Wipe: a straight edge travels across the frame (eight edge selectors). */
export const WIPE = defineEdgeWipe({
	id: 'jasper.wipe',
	label: 'Wipe',
	bin,
	description: 'The incoming clip wipes across the outgoing clip from one side or corner of the frame.',
	keywords: ['linear', 'edge', 'reveal'],
	params: [selectorParam(DIR8, 'westToEast')],
	uniforms: (p) => ({ u_dir: selectorVec(DIR8, p) }),
	body: 'd = tr_linearWipe(px, u_dir, p, m);',
});

/** Wipe ▸ Band Wipe: interleaved bands wipe in from opposite sides. */
export const BAND_WIPE = defineEdgeWipe({
	id: 'jasper.band-wipe',
	label: 'Band Wipe',
	bin,
	description: 'The incoming clip wipes in as bands that alternately enter from opposite sides of the frame.',
	keywords: ['bands', 'stripes', 'interlaced'],
	params: [selectorParam(DIR8, 'westToEast'), countParam('bands', 'Bands', 7)],
	uniforms: (p) => ({ u_dir: selectorVec(DIR8, p) }),
	body: `
  vec2 st = pr_axes(px, u_dir);
  vec2 ext = pr_extent(u_dir);
  float n = max(1.0, floor(u_bands + 0.5));
  float k = floor(clamp((st.y + ext.y) / (2.0 * ext.y), 0.0, 0.99999) * n);
  float s = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
  d = pr_grow(p, 2.0 * ext.x, m) - (s * st.x + ext.x);`,
});

/** Wipe ▸ Barn Doors: two doors open from the centre line. */
export const BARN_DOORS = defineEdgeWipe({
	id: 'jasper.barn-doors',
	label: 'Barn Doors',
	bin,
	description: 'The incoming clip is revealed from the middle outwards, like two barn doors opening.',
	keywords: ['doors', 'open', 'split'],
	params: [selectorParam(ORIENT, 'horizontal')],
	uniforms: (p) => ({ u_dir: selectorVec(ORIENT, p) }),
	body: `
  vec2 st = pr_axes(px, u_dir);
  d = pr_grow(p, pr_extent(u_dir).x, m) - abs(st.x);`,
});

/** Wipe ▸ Venetian Blinds: B appears through opening slats. */
export const VENETIAN_BLINDS = defineEdgeWipe({
	id: 'jasper.venetian-blinds',
	label: 'Venetian Blinds',
	bin,
	description: 'The incoming clip appears through slats that open together, like Venetian blinds.',
	keywords: ['blinds', 'slats', 'bands', 'louver'],
	params: [selectorParam(DIR4, 'northToSouth'), countParam('bands', 'Bands', 6)],
	uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
	body: `
  vec2 st = pr_axes(px, u_dir);
  vec2 ext = pr_extent(u_dir);
  float L = 2.0 * ext.x / max(1.0, floor(u_bands + 0.5));
  float local = mod(st.x + ext.x, L);
  d = pr_grow(p, L, m) - local;`,
});

const CHECKER_CELL = /* glsl */ `
// The checker cell of v_uv: cell index, parity, the cell's length along dir (px) and the px position along dir inside it.
struct PrCell { vec2 cell; vec2 grid; float parity; float len; float along; };
PrCell pr_checkerCell(vec2 dir) {
  PrCell c;
  c.grid = vec2(max(1.0, floor(u_horizontal + 0.5)), max(1.0, floor(u_vertical + 0.5)));
  vec2 g = clamp(v_uv, 0.0, 0.99999) * c.grid;
  c.cell = floor(g);
  c.parity = mod(c.cell.x + c.cell.y, 2.0);
  vec2 cs = u_compSize / c.grid;
  c.len = abs(dot(cs, dir));
  c.along = dot(fract(g) * cs - 0.5 * cs, dir) + 0.5 * c.len;
  return c;
}`;

const SLICES = [
	countParam('horizontal', 'Horizontal Slices', 8),
	countParam('vertical', 'Vertical Slices', 8),
] as const;

/** Wipe ▸ Checker Wipe: a checkerboard of slices wipes across the frame, alternate squares half a square behind. */
export const CHECKER_WIPE = defineEdgeWipe({
	id: 'jasper.checker-wipe',
	label: 'Checker Wipe',
	bin,
	description:
		'A checkerboard pattern of incoming-clip slices wipes across the outgoing clip, alternate squares lagging.',
	keywords: ['checker', 'checkerboard', 'squares', 'grid'],
	params: [selectorParam(DIR4, 'westToEast'), ...SLICES],
	uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
	helpers: CHECKER_CELL,
	body: `
  PrCell c = pr_checkerCell(u_dir);
  // Columns along the direction: each square wipes during one time unit, odd squares half a unit later.
  float nAlong = abs(dot(c.grid, u_dir));
  float i = dot(c.cell, abs(u_dir));
  if (u_dir.x + u_dir.y < 0.0) i = nAlong - 1.0 - i;
  float cp = clamp(p * (nAlong + 0.5) - (i + 0.5 * c.parity), 0.0, 1.0);
  // Squares that have not started (or are done) sit a margin beyond their ends.
  d = pr_grow(cp, c.len, m) - c.along;`,
});

/** Wipe ▸ CheckerBoard: one colour of the board wipes in, then the other. */
export const CHECKERBOARD = defineEdgeWipe({
	id: 'jasper.checkerboard',
	label: 'CheckerBoard',
	bin,
	description: 'Boxes of the incoming clip wipe in on one colour of a checkerboard, then on the other.',
	keywords: ['checker', 'checkerboard', 'boxes', 'grid'],
	params: [selectorParam(DIR4, 'northToSouth'), ...SLICES],
	uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
	helpers: CHECKER_CELL,
	include: [GLSL_TR_BLOCKS],
	body: `
  PrCell c = pr_checkerCell(u_dir);
  d = pr_grow(tr_stagger(p, c.parity, 0.5), c.len, m) - c.along;`,
});

/** Wipe ▸ Clock Wipe: a hand sweeps around the centre (Reverse: counterclockwise). */
export const CLOCK_WIPE = defineEdgeWipe({
	id: 'jasper.clock-wipe',
	label: 'Clock Wipe',
	bin,
	description: 'The incoming clip is revealed by a hand sweeping around the center, like a clock.',
	keywords: ['clock', 'radial', 'sweep'],
	params: [fxParam.angle('startAngle', 'Start Angle', -90)],
	center: true,
	body: `
  vec2 c = u_center * u_compSize;
  vec2 q = px - c;
  float R = tr_coverRadius(c);
  float s = pr_sweep(p, PR_TAU, m, R);
  float a = mod(atan(q.y, q.x) - radians(u_startAngle), PR_TAU);
  d = (s - a) * pr_arcRadius(length(q), R);`,
});

/** Wipe ▸ Wedge Wipe: a wedge opens from the centre, two hands sweeping in opposite directions. */
export const WEDGE_WIPE = defineEdgeWipe({
	id: 'jasper.wedge-wipe',
	label: 'Wedge Wipe',
	bin,
	description: 'The incoming clip appears in a pie wedge that opens from the center in both directions.',
	keywords: ['wedge', 'pie', 'fan', 'radial'],
	params: [selectorParam(START4, 'north')],
	center: true,
	uniforms: (p) => ({ u_startAngle: selectorVec(START4, p)[0] }),
	body: `
  vec2 c = u_center * u_compSize;
  vec2 q = px - c;
  float R = tr_coverRadius(c);
  float s = pr_sweep(p, PR_PI, m, R);
  float a = abs(mod(atan(q.y, q.x) - radians(u_startAngle) + PR_PI, PR_TAU) - PR_PI);
  d = (s - a) * pr_arcRadius(length(q), R);`,
});

/** Wipe ▸ Pinwheel: several wedges sweep around the centre at once. */
export const PINWHEEL = defineEdgeWipe({
	id: 'jasper.pinwheel',
	label: 'Pinwheel',
	bin,
	description: 'The incoming clip appears in wedges that sweep around the center together, like a pinwheel.',
	keywords: ['pinwheel', 'pin wheel', 'wedges', 'blades', 'radial'],
	params: [countParam('wedges', 'Wedges', 8, 64)],
	center: true,
	body: `
  vec2 c = u_center * u_compSize;
  vec2 q = px - c;
  float R = tr_coverRadius(c);
  float span = PR_TAU / max(1.0, floor(u_wedges + 0.5));
  float s = pr_sweep(p, span, m, R);
  float a = mod(atan(q.y, q.x) + 0.5 * PR_PI, span);
  d = (s - a) * pr_arcRadius(length(q), R);`,
});

/** Wipe ▸ Radial Wipe: a line pivoting on a corner sweeps across the frame. */
export const RADIAL_WIPE = defineEdgeWipe({
	id: 'jasper.radial-wipe',
	label: 'Radial Wipe',
	bin,
	description: 'The incoming clip is revealed by a line that sweeps across the frame, pivoting on a corner.',
	keywords: ['radial', 'sweep', 'corner', 'fan'],
	params: [selectorParam(CORNERS, 'northWest')],
	uniforms: (p) => ({ u_corner: selectorVec(CORNERS, p), u_startAngle: 90 * selectorIndex(CORNERS, p) }),
	body: `
  vec2 c = u_corner * u_compSize;
  vec2 q = px - c;
  float R = tr_coverRadius(c);
  float s = pr_sweep(p, 0.5 * PR_PI, m, R);
  // Wrapped so the pixels on the start edge (angle ~0 or ~2π) count as just started.
  float a = mod(atan(q.y, q.x) - radians(u_startAngle) + 0.25 * PR_PI, PR_TAU) - 0.25 * PR_PI;
  d = (s - a) * pr_arcRadius(length(q), R);`,
});

/** Wipe ▸ Inset: B grows in a box from a corner. */
export const INSET = defineEdgeWipe({
	id: 'jasper.inset',
	label: 'Inset',
	bin,
	description: 'The incoming clip appears in a small box in a corner of the frame that grows to fill it.',
	keywords: ['inset', 'box', 'corner', 'grow'],
	params: [selectorParam(CORNERS, 'northWest')],
	uniforms: (p) => ({ u_corner: selectorVec(CORNERS, p) }),
	body: `
  vec2 corner = u_corner * u_compSize;
  vec2 inward = 1.0 - 2.0 * u_corner;
  float q = pr_grow(p, 1.0, m / min(u_compSize.x, u_compSize.y));
  vec2 hs = 0.5 * q * u_compSize;
  d = pr_box(px, corner + inward * hs, hs);`,
});

/** Spiral / zig-zag orders of a block grid (Spiral Boxes, Zig-Zag Blocks). */
const BLOCK_PATH = /* glsl */ `
// Index of a cell on a clockwise rectangular spiral (from the top-left cell, east first, inwards) of a w × h grid,
// and the direction it is travelled (0 east, 1 south, 2 west, 3 north).
vec2 pr_spiral(vec2 c, vec2 dims) {
  float k = min(min(c.x, c.y), min(dims.x - 1.0 - c.x, dims.y - 1.0 - c.y));
  float w = dims.x - 2.0 * k, h = dims.y - 2.0 * k;
  float before = dims.x * dims.y - w * h;
  vec2 l = c - k;
  if (l.y < 0.5) return vec2(before + l.x, 0.0);
  if (l.x > w - 1.5) return vec2(before + (w - 1.0) + l.y, 1.0);
  if (l.y > h - 1.5) return vec2(before + (w - 1.0) + (h - 1.0) + (w - 1.0 - l.x), 2.0);
  return vec2(before + 2.0 * (w - 1.0) + (h - 1.0) + (h - 1.0 - l.y), 3.0);
}
// Signed px distance of a block path: the path advances s cells (all cells before it are B); in the current cell the
// edge moves along the travel direction. f = position inside the cell (0..1), cell = (w, h) px of a cell.
float pr_pathDist(float s, vec2 idxDir, vec2 f, vec2 cellPx) {
  int dir = int(idxDir.y + 0.5);
  float along = dir == 0 ? f.x : dir == 1 ? f.y : dir == 2 ? 1.0 - f.x : 1.0 - f.y;
  float len = (dir == 0 || dir == 2) ? cellPx.x : cellPx.y;
  return (s - idxDir.x - along) * len;
}`;

/** Wipe ▸ Spiral Boxes: boxes fill in a rectangular spiral from the outside in. */
export const SPIRAL_BOXES = defineEdgeWipe({
	id: 'jasper.spiral-boxes',
	label: 'Spiral Boxes',
	bin,
	description:
		'The incoming clip fills in box by box along a rectangular spiral, from the edges of the frame inwards.',
	keywords: ['spiral', 'boxes', 'blocks', 'grid'],
	params: [
		selectorParam(CORNERS, 'northWest'),
		countParam('horizontal', 'Horizontal', 8),
		countParam('vertical', 'Vertical', 6),
	],
	uniforms: (p) => ({ u_corner: { int: selectorIndex(CORNERS, p) } }),
	helpers: BLOCK_PATH,
	body: `
  vec2 grid = vec2(max(1.0, floor(u_horizontal + 0.5)), max(1.0, floor(u_vertical + 0.5)));
  vec2 g = clamp(v_uv, 0.0, 0.99999) * grid;
  vec2 c = floor(g), f = fract(g);
  vec2 cellPx = u_compSize / grid;
  // Rotate the grid so the spiral starts at the chosen corner and keeps turning clockwise.
  vec2 cc = c, ff = f, dims = grid, cpx = cellPx;
  if (u_corner == 1) { cc = vec2(c.y, grid.x - 1.0 - c.x); ff = vec2(f.y, 1.0 - f.x); dims = grid.yx; cpx = cellPx.yx; }
  else if (u_corner == 2) { cc = grid - 1.0 - c; ff = 1.0 - f; }
  else if (u_corner == 3) { cc = vec2(grid.y - 1.0 - c.y, c.x); ff = vec2(1.0 - f.y, f.x); dims = grid.yx; cpx = cellPx.yx; }
  float n = dims.x * dims.y;
  float mc = m / min(cpx.x, cpx.y);
  d = pr_pathDist(mix(-mc, n + mc, p), pr_spiral(cc, dims), ff, cpx);`,
});

/** Wipe ▸ Zig-Zag Blocks: blocks fill row by row, alternating direction. */
export const ZIG_ZAG_BLOCKS = defineEdgeWipe({
	id: 'jasper.zig-zag-blocks',
	label: 'Zig-Zag Blocks',
	bin,
	description: 'The incoming clip fills in block by block, row after row, back and forth across the frame.',
	keywords: ['zigzag', 'zig zag', 'blocks', 'rows', 'grid'],
	params: [
		selectorParam(CORNERS, 'northWest'),
		countParam('horizontal', 'Horizontal', 8),
		countParam('vertical', 'Vertical', 6),
	],
	uniforms: (p) => ({ u_corner: selectorVec(CORNERS, p) }),
	helpers: BLOCK_PATH,
	body: `
  vec2 grid = vec2(max(1.0, floor(u_horizontal + 0.5)), max(1.0, floor(u_vertical + 0.5)));
  // Mirror so the path starts at the chosen corner.
  vec2 uv = mix(v_uv, 1.0 - v_uv, u_corner);
  vec2 g = clamp(uv, 0.0, 0.99999) * grid;
  vec2 c = floor(g), f = fract(g);
  bool even = mod(c.y, 2.0) < 0.5;
  vec2 idxDir = vec2(c.y * grid.x + (even ? c.x : grid.x - 1.0 - c.x), even ? 0.0 : 2.0);
  vec2 cellPx = u_compSize / grid;
  float mc = m / min(cellPx.x, cellPx.y);
  d = pr_pathDist(mix(-mc, grid.x * grid.y + mc, p), idxDir, f, cellPx);`,
});

/** Wipe ▸ Random Blocks: B appears in blocks that pop in at random. */
export const RANDOM_BLOCKS = defineShaderTransition({
	id: 'jasper.random-blocks',
	label: 'Random Blocks',
	bin,
	description: 'The incoming clip appears in blocks that pop in one by one in a random order.',
	keywords: ['random', 'blocks', 'dissolve', 'pixel'],
	params: [countParam('wide', 'Wide', 10, 200), countParam('high', 'High', 10, 200)],
	gpu: {
		passes: [
			{
				include: [GLSL_TR_BLOCKS],
				frag: /* glsl */ `
void main() {
  vec2 grid = vec2(max(1.0, floor(u_wide + 0.5)), max(1.0, floor(u_high + 0.5)));
  float r = tr_cellRandom(tr_cell(v_uv, grid), u_seed);
  // r in (0.001, 0.999): nothing at p = 0, everything at p = 1.
  fragColor = tr_progress() > 0.001 + 0.998 * r ? tr_to(v_uv) : tr_from(v_uv);
}`,
			},
		],
	},
});

/** Wipe ▸ Random Wipe: small blocks switch at random behind a wipe front. */
export const RANDOM_WIPE = defineShaderTransition({
	id: 'jasper.random-wipe',
	label: 'Random Wipe',
	bin,
	description:
		'The incoming clip appears in small random blocks that sweep across the frame in one direction.',
	keywords: ['random', 'blocks', 'wipe', 'scatter'],
	params: [selectorParam(DIR4, 'northToSouth')],
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_TR_BLOCKS],
				frag: /* glsl */ `
void main() {
  vec2 grid = tr_squareGrid(48.0);
  ivec2 cell = tr_cell(v_uv, grid);
  vec2 cc = (vec2(cell) + 0.5) / grid;
  float along = clamp(dot(cc - 0.5, u_dir) + 0.5, 0.0, 1.0);
  // A ragged front: the position along the direction plus a random delay per block.
  float t = 0.65 * along + 0.35 * tr_cellRandom(cell, u_seed);
  fragColor = tr_progress() > 0.001 + 0.998 * t ? tr_to(v_uv) : tr_from(v_uv);
}`,
			},
		],
	},
});

/** Wipe ▸ Paint Splatter: B appears in growing splotches of paint. */
export const PAINT_SPLATTER = defineShaderTransition({
	id: 'jasper.paint-splatter',
	label: 'Paint Splatter',
	bin,
	description: 'The incoming clip appears in splotches of paint that splatter onto the frame and spread.',
	keywords: ['paint', 'splatter', 'splash', 'blots', 'ink'],
	options: { antiAliasing: true },
	gpu: {
		passes: [
			{
				include: [GLSL_TR_WIPE, GLSL_TR_BLOCKS, GLSL_HASH],
				frag: /* glsl */ `
const float PS_RMAX = 2.1;
// Time (0..1) at which a splat (and its droplets) of a jittered grid cell reaches the point g (cell units). Cheap on
// purpose (software GL compiles every call inline): the rim is a few random harmonics, not noise.
float psSplat(vec2 g, vec2 cell, vec2 aspect) {
  ivec2 ic = ivec2(cell);
  vec4 h = vec4(fx_hash22(ic, u_seed), fx_hash22(ic + ivec2(31, 17), u_seed));
  vec2 ctr = cell + 0.15 + 0.7 * h.xy;
  float t0 = 0.04 + 0.56 * h.z;
  vec2 q = (g - ctr) * aspect;
  float r = length(q);
  float a = atan(q.y, q.x);
  float ph = 6.2831853 * h.w;
  // Lobes plus sharp spikes; the rim never drops below 0.6 so every point of the cell is reached by t = 1.
  float rim = 1.0 + 0.2 * sin(3.0 * a + ph) + 0.12 * sin(5.0 * a + 2.7 * ph) + 0.08 * sin(9.0 * a + 4.1 * ph)
    + 0.45 * pow(max(sin(7.0 * a + 1.3 * ph), 0.0), 12.0);
  // The area of a splat grows linearly in time (its radius like a square root): splotches land, then spread.
  float rr = r / (PS_RMAX * rim);
  float t = t0 + (1.0 - t0) * rr * rr;
  // Droplets thrown around the splat: small discs that land shortly after it.
  for (int k = 0; k < 3; k++) {
    vec2 d = fx_hash22(ic * 3 + ivec2(k, 101), u_seed);
    float ang = 6.2831853 * d.x;
    vec2 dc = ctr + vec2(cos(ang), sin(ang)) * (0.5 + 0.45 * d.y) / aspect;
    float rad = 0.05 + 0.06 * fract(d.y * 7.31);
    float dd = length((g - dc) * aspect);
    if (dd < rad) t = min(t, t0 + 0.06 + 0.12 * dd / rad);
  }
  return t;
}
void main() {
  vec2 grid = tr_squareGrid(6.0);
  vec2 cellPx = u_compSize / grid;
  vec2 aspect = cellPx / cellPx.y;
  vec2 g = v_uv * grid;
  // The four cells around the nearest cell corner (the point's own cell is always one of them).
  vec2 base = floor(g - 0.5);
  float t = 1.0;
  for (int j = 0; j <= 1; j++)
    for (int i = 0; i <= 1; i++) t = min(t, psSplat(g, base + vec2(float(i), float(j)), aspect));
  // Most of the frame is covered by t ≈ 0.5 and the covered area grows like an S-curve in t; this clock (early splats
  // sooner, the middle slower) keeps the covered area close to the progress, and catches up with the real time at the
  // end so the last gaps close by progress 1. Time → px (roughly the speed a rim moves at) for the anti-aliased edge.
  float p = tr_progress();
  float q = mix(0.4 * p + 0.07 * sin(3.14159265 * p), p, smoothstep(0.75, 1.0, p));
  float d = (q - t) * PS_RMAX * cellPx.y;
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), tr_edge(d, 0.0, tr_aaWidth(u_antiAliasing)));
}`,
			},
		],
	},
});

/** Gradients of Gradient Wipe (the grayscale image whose dark areas switch first). */
const GRADIENTS = [
	'leftToRight',
	'topToBottom',
	'diagonal',
	'radial',
	'box',
	'angular',
	'outgoingLuma',
	'incomingLuma',
] as const;
const GRADIENT_LABELS = [
	'Linear (Left to Right)',
	'Linear (Top to Bottom)',
	'Diagonal',
	'Radial',
	'Box',
	'Angular',
	'Outgoing Clip Luminance',
	'Incoming Clip Luminance',
] as const;

/**
 * Wipe ▸ Gradient Wipe: B appears following the brightness of a grayscale gradient (dark first) with a softness.
 * Premiere loads any image as the gradient; transitions cannot take media params yet (framework), so the gradient
 * is one of a set of built-in ramps or the luminance of either clip.
 */
export const GRADIENT_WIPE = defineShaderTransition({
	id: 'jasper.gradient-wipe',
	label: 'Gradient Wipe',
	bin,
	description:
		'The incoming clip wipes in following the brightness of a grayscale gradient (dark areas first), with softness.',
	keywords: ['gradient', 'luma', 'matte', 'soft', 'ramp'],
	params: [
		fxParam.choice('gradient', 'Gradient', GRADIENTS, GRADIENT_LABELS, 'leftToRight'),
		fxParam.percent('softness', 'Softness', 10),
		fxParam.toggle('invert', 'Invert Gradient', false),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_COLOR, GLSL_PR_COMMON],
				frag: /* glsl */ `
float gwGradient() {
  vec2 uv = v_uv;
  float asp = tr_aspect();
  if (u_gradient == 0) return uv.x;
  if (u_gradient == 1) return uv.y;
  if (u_gradient == 2) return 0.5 * (uv.x + uv.y);
  if (u_gradient == 3) return clamp(length((uv - 0.5) * vec2(asp, 1.0)) / length(vec2(asp, 1.0) * 0.5), 0.0, 1.0);
  if (u_gradient == 4) return clamp(2.0 * max(abs(uv.x - 0.5), abs(uv.y - 0.5)), 0.0, 1.0);
  if (u_gradient == 5) {
    vec2 q = (uv - 0.5) * vec2(asp, 1.0);
    return mod(atan(q.y, q.x) + 0.5 * PR_PI, PR_TAU) / PR_TAU;
  }
  vec4 c = fx_unpremultiply(u_gradient == 6 ? tr_from(uv) : tr_to(uv));
  return clamp(fx_luma(c.rgb) * c.a, 0.0, 1.0);
}
void main() {
  float g = gwGradient();
  if (u_invert) g = 1.0 - g;
  float s = max(u_softness / 100.0, 0.002);
  // The threshold runs from 0 to 1 + s so the soft band has left at both ends.
  float k = clamp((tr_progress() * (1.0 + s) - g) / s, 0.0, 1.0);
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), k);
}`,
			},
		],
	},
});

export const PREMIERE_WIPES: readonly TransitionSpec[] = [
	BAND_WIPE,
	BARN_DOORS,
	CHECKER_WIPE,
	CHECKERBOARD,
	CLOCK_WIPE,
	GRADIENT_WIPE,
	INSET,
	PAINT_SPLATTER,
	PINWHEEL,
	RADIAL_WIPE,
	RANDOM_BLOCKS,
	RANDOM_WIPE,
	SPIRAL_BOXES,
	VENETIAN_BLINDS,
	WEDGE_WIPE,
	WIPE,
	ZIG_ZAG_BLOCKS,
];

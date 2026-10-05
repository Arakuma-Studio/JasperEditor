// Sapphire kaleidoscopes (Stylize): S_Kaleido:Triangles/Squares/Diamonds/Oct (mirror groups folding the plane into one
// cell), S_KaleidoPolar (the picture wrapped around a disk), S_KaleidoRadial (a 2/3-mirror slice kaleidoscope),
// S_FlysEyeRect/Hex/Circles (each tile shows its own zoomed copy) and S_TileScramble (tiles of randomly shifted
// mirrors). Each is a coordinate mapping of the layer picture (Wrap: No/Tile/Reflect outside it); Filter averages
// 4 sub-pixel lookups; Kaleido Amount interpolates between the identity (0) and the full pattern (1).
// Coordinates: "frame units" (1 = the layer height), centres are point params, shifts are fractions of the layer
// width (y up, as in Sapphire), Z Dist > 1 zooms out.
import type { EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { fxParam, mixWithOriginalParam, seedParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import { filterParam, PKE_COMMON, sNum, wrapParam, xyParam } from './common.ts';

const bin = SAPPHIRE_BINS.stylize;

/**
 * The supersampling wrapper: `KAL_MAIN(map)` writes the effect result for a mapping `vec4 map(vec2 n)` that returns
 * the picture for a layer-normalised position (Filter on → 4 rotated-grid samples per pixel).
 */
const kalMain = (wrap: string) => /* glsl */ `
vec4 kal_lookup(vec2 n);
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 n = fx_layerNorm();
  vec4 c;
  if (u_filter) {
    vec2 px = 1.0 / u_box.zw;
    c = 0.25 * (kal_lookup(n + vec2(-0.125, -0.375) * px) + kal_lookup(n + vec2(0.375, -0.125) * px)
              + kal_lookup(n + vec2(0.125, 0.375) * px) + kal_lookup(n + vec2(-0.375, 0.125) * px));
  } else {
    c = kal_lookup(n);
  }
  fragColor = fx_mixOriginal(c, src, u_mixWithOriginal);
}
vec4 kal_sample(vec2 n) { return pke_sampleWrap(u_source, n, ${wrap}); }
`;

/** Mirror-group folds in frame units; each returns the folded point relative to the cell's centre. */
const KAL_FOLDS: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/folds',
	source: /* glsl */ `
// Triangle wave: identity on [-0.5, 0.5], mirrored at ±0.5 (period 2).
vec2 kal_tri(vec2 k) { return abs(mod(k - 0.5, 2.0) - 1.0) - 0.5; }
vec2 kal_foldSquares(vec2 k) { return kal_tri(k); }
// p4m: squares plus the diagonals; 8 right triangles meet at every cell centre (an octagonal pattern).
vec2 kal_foldOct(vec2 k) {
  vec2 a = abs(kal_tri(k));
  return a.y > a.x ? a.yx : a;
}
// Diamonds: the square fold in a 45°-rotated, vertically stretched frame (tall rhombic cells).
vec2 kal_foldDiamonds(vec2 k) {
  const float S = 0.7071068;
  vec2 q = k * vec2(1.0, 1.0 / 1.6);
  vec2 r = mat2(S, -S, S, S) * q;
  r = kal_tri(r / 0.6) * 0.6;
  q = mat2(S, S, -S, S) * r;
  return q * vec2(1.0, 1.6);
}
// p3m1: reflections in the sides of an equilateral triangle of side 1 (centred on its centroid).
vec2 kal_foldTriangles(vec2 k) {
  const float L = 1.0;
  const float H = 0.8660254;
  vec2 cen = vec2(0.5 * L, H / 3.0);
  vec2 p = k + cen;
  mat2 B = mat2(vec2(0.0, 2.0 * H), 2.0 * H * vec2(0.8660254, -0.5));
  p = B * fract(inverse(B) * p);
  vec2 n1 = vec2(0.8660254, -0.5);
  vec2 n2 = vec2(-0.8660254, -0.5);
  for (int i = 0; i < 12; i++) {
    bool moved = false;
    if (p.y < 0.0) { p.y = -p.y; moved = true; }
    float d1 = dot(p, n1);
    if (d1 < 0.0) { p -= 2.0 * d1 * n1; moved = true; }
    float d2 = dot(p - vec2(L, 0.0), n2);
    if (d2 < 0.0) { p -= 2.0 * d2 * n2; moved = true; }
    if (!moved) break;
  }
  return p - cen;
}
`,
};

const insideShiftFrame = (name: string) => `vec2(${name}.x * pke_aspect(), -${name}.y)`;

function mirrorKaleido(o: { id: string; label: string; fold: string; description: string; keywords: string[] }) {
	return defineShaderEffect({
		id: o.id,
		label: o.label,
		category: 'Stylize',
		bin,
		description: o.description,
		keywords: ['kaleidoscope', 'mirror', 'pattern', 'symmetry', 'sapphire', ...o.keywords],
		params: [
			fxParam.point('center', 'Center', [0.5, 0.5]),
			sNum('zDist', 'Z Dist', 2, { min: 0.001, softMax: 10, step: 0.01 }),
			fxParam.angle('rotate', 'Rotate', 0),
			xyParam('insideShift', 'Inside Shift', [0, 0]),
			sNum('insideZDist', 'Inside Z Dist', 1, { min: 0.001, softMax: 10, step: 0.01 }),
			fxParam.angle('insideRotate', 'Inside Rotate', 0),
			sNum('kaleidoAmount', 'Kaleido Amount', 1, { min: 0, softMax: 1, step: 0.01 }),
			wrapParam('wrapX', 'Wrap X'),
			wrapParam('wrapY', 'Wrap Y'),
			filterParam(true),
			mixWithOriginalParam(),
		],
		gpu: {
			timeInvariant: true,
			passes: [
				{
					include: [PKE_COMMON, KAL_FOLDS, GLSL_COMPOSITE],
					frag: /* glsl */ `
${kalMain('ivec2(u_wrapX, u_wrapY)')}
vec4 kal_lookup(vec2 n) {
  vec2 f = pke_toFrame(n, u_center) * u_zDist;
  // The mirrors turn by Rotate; the picture inside them does not.
  vec2 m = pke_rot(u_rotate) * ${o.fold}(pke_rot(-u_rotate) * f);
  vec2 s = pke_rot(u_insideRotate) * m * u_insideZDist - ${insideShiftFrame('u_insideShift')};
  vec2 k = pke_fromFrame(s, vec2(0.5));
  return kal_sample(mix(n, k, u_kaleidoAmount));
}`,
				},
			],
		},
	});
}

export const S_KALEIDO_TRIANGLES = mirrorKaleido({
	id: 'jasper.s.kaleido-triangles',
	label: 'S_Kaleido:Triangles',
	fold: 'kal_foldTriangles',
	description:
		'Reflects the clip into a pattern of equilateral triangles. Inside params move the picture inside the mirrors; Center, Z Dist and Rotate move the pattern.',
	keywords: ['triangles'],
});
export const S_KALEIDO_SQUARES = mirrorKaleido({
	id: 'jasper.s.kaleido-squares',
	label: 'S_Kaleido:Squares',
	fold: 'kal_foldSquares',
	description: 'Reflects the clip into a pattern of mirrored squares.',
	keywords: ['squares', 'grid'],
});
export const S_KALEIDO_DIAMONDS = mirrorKaleido({
	id: 'jasper.s.kaleido-diamonds',
	label: 'S_Kaleido:Diamonds',
	fold: 'kal_foldDiamonds',
	description: 'Reflects the clip into a pattern of mirrored diamonds.',
	keywords: ['diamonds', 'rhombus'],
});
export const S_KALEIDO_OCT = mirrorKaleido({
	id: 'jasper.s.kaleido-oct',
	label: 'S_Kaleido:Oct',
	fold: 'kal_foldOct',
	description: 'Reflects the clip into an octagonal pattern of right triangles (eight meet at every centre).',
	keywords: ['octagon', 'oct', 'eight'],
});

export const S_KALEIDO_POLAR = defineShaderEffect({
	id: 'jasper.s.kaleido-polar',
	label: 'S_KaleidoPolar',
	category: 'Stylize',
	bin,
	description:
		'Wraps the clip around a disk and reflects it radially, as if seen through a reflecting cylinder. Angle Repeats sets how many copies go around.',
	keywords: ['kaleidoscope', 'polar', 'disk', 'radial', 'mirror', 'sapphire'],
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		sNum('zDist', 'Z Dist', 1, { min: 0.001, softMax: 10, step: 0.01 }),
		fxParam.angle('rotate', 'Rotate', 0),
		fxParam.vec2('stretch', 'Stretch', [1, 1], { min: 0.1, softMax: 4, step: 0.01 }),
		sNum('insideShiftY', 'Inside Shift Y', 0, { softMin: -1, softMax: 1 }),
		sNum('angleRepeats', 'Angle Repeats', 6, { min: 0.01, softMax: 24, step: 0.01 }),
		sNum('kaleidoAmount', 'Kaleido Amount', 1, { min: 0, softMax: 1, step: 0.01 }),
		filterParam(true),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [PKE_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
${kalMain('ivec2(2, 2)')}
vec4 kal_lookup(vec2 n) {
  vec2 f = pke_rot(-u_rotate) * pke_toFrame(n, u_center) / max(u_stretch, vec2(0.1));
  float r = length(f) * u_zDist;
  float a = atan(f.y, f.x) / 6.28318530718 + 0.25;
  // Around the disk: the picture's width, mirrored every copy. Outwards: the picture's height (top at the centre).
  float u = a * u_angleRepeats;
  float x = 1.0 - abs(mod(u, 2.0) - 1.0);
  float y = r * 2.0 - u_insideShiftY;
  return kal_sample(mix(n, vec2(x, y), u_kaleidoAmount));
}`,
			},
		],
	},
});

export const S_KALEIDO_RADIAL = defineShaderEffect({
	id: 'jasper.s.kaleido-radial',
	label: 'S_KaleidoRadial',
	category: 'Stylize',
	bin,
	description:
		'A traditional 2- or 3-mirror kaleidoscope: a pie slice of the clip and its mirrored copies around the Center. Rotate Inside Speed turns the picture under the mirrors over time.',
	keywords: ['kaleidoscope', 'radial', 'slices', 'mirror', 'mandala', 'sapphire'],
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		sNum('zDist', 'Z Dist', 1, { min: 0.001, softMax: 10, step: 0.01 }),
		sNum('slices', 'Slices', 6, { min: 0.01, softMax: 24, step: 0.01 }),
		fxParam.angle('rotate', 'Rotate', 0),
		fxParam.angle('rotateKaleido', 'Rotate Kaleido', 0),
		fxParam.angle('rotateInside', 'Rotate Inside', 0),
		sNum('rotateInsideSpeed', 'Rotate Inside Speed', 30, { softMin: -360, softMax: 360, step: 0.1 }),
		xyParam('shiftInside', 'Shift Inside', [0, 0]),
		sNum('kaleidoAmount', 'Kaleido Amount', 1, { min: 0, softMax: 1, step: 0.01 }),
		wrapParam('wrap', 'Wrap'),
		filterParam(true),
		mixWithOriginalParam(),
	],
	gpu: {
		passes: [
			{
				include: [PKE_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
${kalMain('ivec2(u_wrap)')}
vec4 kal_lookup(vec2 n) {
  vec2 f = pke_rot(-u_rotate) * pke_toFrame(n, u_center) * u_zDist;
  float r = length(f);
  float a = degrees(atan(f.y, f.x)) - u_rotateKaleido;
  float w = 360.0 / max(u_slices, 0.01);
  float am = mod(a, 2.0 * w);
  if (am > w) am = 2.0 * w - am;
  float ai = am + u_rotateKaleido + u_rotateInside + u_rotateInsideSpeed * u_time;
  vec2 s = pke_rot(u_rotate) * (r * vec2(cos(radians(ai)), sin(radians(ai)))) - ${insideShiftFrame('u_shiftInside')};
  vec2 k = pke_fromFrame(s, u_center);
  return kal_sample(mix(n, k, u_kaleidoAmount));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- fly's eye

/** Tile lattice helpers: positions are canvas px relative to the layer box centre. */
const FLY_GLSL: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/flyseye',
	deps: [PKE_COMMON],
	source: /* glsl */ `
vec2 fly_pos() { return pke_boxPx() - 0.5 * u_box.zw - vec2(u_tileShift.x, -u_tileShift.y) * u_box.z; }
// The picture seen by a tile centred at tc (box-centred px) at offset d from its centre.
vec4 fly_view(vec2 tc, vec2 d) {
  vec2 p = tc * u_overallZdist + pke_rot(u_insideRotate) * d * u_insideZdist + vec2(u_tileShift.x, -u_tileShift.y) * u_box.z;
  return pke_sampleWrap(u_source, (p + 0.5 * u_box.zw) / u_box.zw, ivec2(u_wrap));
}
float fly_cell() { return u_box.z / max(u_tileFrequency, 0.1); }
// Nearest and second-nearest centres of a hexagonal lattice (rows of spacing cell, every other row offset by ½).
void fly_hex(vec2 p, float cell, float relH, out vec2 c1, out vec2 c2) {
  vec2 sp = vec2(cell, cell * 0.8660254 * relH);
  float row = floor(p.y / sp.y + 0.5);
  float d1 = 1.0e9, d2 = 1.0e9;
  c1 = vec2(0.0); c2 = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    float rj = row + float(j);
    float off = mod(rj, 2.0) * 0.5;
    float col = floor(p.x / sp.x - off + 0.5);
    for (int i = -1; i <= 1; i++) {
      vec2 c = vec2((col + float(i) + off) * sp.x, rj * sp.y);
      vec2 dd = (p - c) / vec2(1.0, relH);
      float d = dot(dd, dd);
      if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = c; } else if (d < d2) { d2 = d; c2 = c; }
    }
  }
}
`,
};

const flyParams = (extra: ParamSpec[], tail: ParamSpec[] = []): ParamSpec[] => [
	sNum('tileFrequency', 'Tile Frequency', 12, { min: 0.1, softMax: 60, step: 0.01 }),
	sNum('tileRelHeight', 'Tile Rel Height', 1, { min: 0.01, softMax: 4, step: 0.01 }),
	xyParam('tileShift', 'Tile Shift', [0, 0]),
	...extra,
	sNum('insideZdist', 'Inside Zdist', 2, { min: 0, softMax: 10, step: 0.01 }),
	fxParam.angle('insideRotate', 'Inside Rotate', 0),
	sNum('overallZdist', 'Overall Zdist', 1, { softMin: -2, softMax: 4, step: 0.01 }),
	wrapParam('wrap', 'Wrap'),
	filterParam(true),
	...tail,
	mixWithOriginalParam(),
];

/** Fly's-eye main: supersampled (Filter) evaluation of `vec4 fly_at(vec2 p)` at box-centred px p. */
const flyMain = /* glsl */ `
vec4 fly_at(vec2 p);
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 p = fly_pos();
  vec4 c = u_filter
    ? 0.25 * (fly_at(p + vec2(-0.125, -0.375)) + fly_at(p + vec2(0.375, -0.125)) + fly_at(p + vec2(0.125, 0.375)) + fly_at(p + vec2(-0.375, 0.125)))
    : fly_at(p);
  fragColor = fx_mixOriginal(c, src, u_mixWithOriginal);
}
`;

export const S_FLYS_EYE_RECT = defineShaderEffect({
	id: 'jasper.s.flys-eye-rect',
	label: 'S_FlysEyeRect',
	category: 'Stylize',
	bin,
	description: "Breaks the clip into rectangular tiles, each showing its own zoomed view (a fly's-eye look).",
	keywords: ['flys eye', 'tiles', 'grid', 'compound eye', 'sapphire'],
	params: flyParams([]),
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [FLY_GLSL, GLSL_COMPOSITE],
				frag: /* glsl */ `
${flyMain}
vec4 fly_at(vec2 p) {
  vec2 sz = vec2(fly_cell(), fly_cell() * max(u_tileRelHeight, 0.01));
  vec2 tc = (floor(p / sz) + 0.5) * sz;
  return fly_view(tc, p - tc);
}`,
			},
		],
	},
});

export const S_FLYS_EYE_HEX = defineShaderEffect({
	id: 'jasper.s.flys-eye-hex',
	label: 'S_FlysEyeHex',
	category: 'Stylize',
	bin,
	description:
		"Breaks the clip into hexagonal tiles, each showing its own zoomed view (a fly's-eye look). Edge Softness blends neighbouring tiles.",
	keywords: ['flys eye', 'hexagon', 'honeycomb', 'tiles', 'compound eye', 'sapphire'],
	params: flyParams([
		fxParam.angle('tileRotate', 'Tile Rotate', 0),
		sNum('edgeSoftness', 'Edge Softness', 0, { min: 0, max: 1, step: 0.01 }),
	]),
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [FLY_GLSL, GLSL_COMPOSITE],
				frag: /* glsl */ `
${flyMain}
vec4 fly_at(vec2 p) {
  float cell = fly_cell();
  float relH = max(u_tileRelHeight, 0.01);
  vec2 q = pke_rot(-u_tileRotate) * p;
  vec2 c1, c2;
  fly_hex(q, cell, relH, c1, c2);
  mat2 back = pke_rot(u_tileRotate);
  vec2 t1 = back * c1, t2 = back * c2;
  vec4 a = fly_view(t1, p - t1);
  if (u_edgeSoftness <= 0.0) return a;
  // Distance to the shared edge (the bisector of the two centres), in px.
  vec2 e = c2 - c1;
  float de = (dot(q - c1, e) / length(e) - 0.5 * length(e)) * -1.0;
  float k = 0.5 + 0.5 * clamp(de / (u_edgeSoftness * cell * 0.5), 0.0, 1.0);
  return mix(fly_view(t2, p - t2), a, k);
}`,
			},
		],
	},
});

export const S_FLYS_EYE_CIRCLES = defineShaderEffect({
	id: 'jasper.s.flys-eye-circles',
	label: 'S_FlysEyeCircles',
	category: 'Stylize',
	bin,
	description:
		"Breaks the clip into circular tiles, each showing its own zoomed view (a fly's-eye look); Circle Overlap combines overlapping circles (average, screen, max, min, multiply).",
	keywords: ['flys eye', 'circles', 'lenses', 'bubbles', 'compound eye', 'sapphire'],
	expensive: true,
	params: flyParams([
		fxParam.choice(
			'circleOverlap',
			'Circle Overlap',
			['ave', 'screen', 'max', 'min', 'mult'],
			['Ave', 'Screen', 'Max', 'Min', 'Mult'],
			'ave',
		),
		sNum('circleRadius', 'Circle Radius', 1, { min: 0, max: 1, step: 0.01 }),
		sNum('edgeSoftness', 'Edge Softness', 0, { min: 0, max: 1, step: 0.01 }),
	]),
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [FLY_GLSL, GLSL_COMPOSITE],
				frag: /* glsl */ `
${flyMain}
vec4 fly_at(vec2 p) {
  float cell = fly_cell();
  float relH = max(u_tileRelHeight, 0.01);
  vec2 sp = vec2(cell, cell * 0.8660254 * relH);
  // Radius 1 = the hexagon's circumradius: circles just cover the plane, overlapping their neighbours.
  float R = max(u_circleRadius, 1.0e-4) * cell * 0.5773503 * 1.02;
  float row = floor(p.y / sp.y + 0.5);
  int mode = u_circleOverlap;
  vec4 acc = mode == 0 ? vec4(0.0) : (mode == 3 || mode == 4) ? vec4(1.0) : vec4(0.0);
  float wsum = 0.0, cover = 0.0;
  for (int j = -2; j <= 2; j++) {
    float rj = row + float(j);
    float off = mod(rj, 2.0) * 0.5;
    float col = floor(p.x / sp.x - off + 0.5);
    for (int i = -2; i <= 2; i++) {
      vec2 c = vec2((col + float(i) + off) * sp.x, rj * sp.y);
      vec2 dd = (p - c) / vec2(1.0, relH);
      float d = length(dd);
      if (d >= R) continue;
      float soft = max(u_edgeSoftness * R, 0.75);
      float a = 1.0 - smoothstep(R - soft, R, d);
      vec4 v = fly_view(c, p - c) * a;
      cover = max(cover, a);
      if (mode == 0) { float w = a * (1.0 - d / R + 0.02); acc += v * w; wsum += w; }
      else if (mode == 1) acc = acc + v - acc * v;
      else if (mode == 2) acc = max(acc, v);
      else if (mode == 3) acc = min(acc, v + vec4(1.0 - a));
      else acc *= v + vec4(1.0 - a);
    }
  }
  if (mode == 0) return wsum > 0.0 ? acc / wsum * cover : vec4(0.0);
  // Gaps: black for Screen/Max, white for Min/Mult (opaque).
  if (mode == 1 || mode == 2) return vec4(acc.rgb, 1.0);
  return vec4(acc.rgb, 1.0);
}`,
			},
		],
	},
});

export const S_TILE_SCRAMBLE = defineShaderEffect({
	id: 'jasper.s.tile-scramble',
	label: 'S_TileScramble',
	category: 'Stylize',
	bin,
	description:
		'Breaks the clip into rectangular tiles and shifts the picture inside each by a random amount, like a wall of small randomly tilted mirrors.',
	keywords: ['tiles', 'scramble', 'mosaic', 'mirrors', 'glitch', 'sapphire'],
	params: [
		sNum('scrambleSpeed', 'Scramble Speed', 0.1, { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('scrambleRelX', 'Scramble Rel X', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('scrambleRelY', 'Scramble Rel Y', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('tiles', 'Tiles', 10, { min: 1, softMax: 100, step: 0.1 }),
		sNum('tileRelWidth', 'Tile Rel Width', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		sNum('tileRelHeight', 'Tile Rel Height', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		xyParam('tileShift', 'Tile Shift', [0, 0]),
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		sNum('zDist', 'Z Dist', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		seedParam(),
		wrapParam('wrap', 'Wrap', 'none'),
		filterParam(false),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [PKE_COMMON, GLSL_HASH, GLSL_COMPOSITE],
				frag: /* glsl */ `
vec4 at(vec2 p) {
  float t = u_box.z / max(u_tiles, 1.0);
  vec2 sz = t * vec2(max(u_tileRelWidth, 0.01), max(u_tileRelHeight, 0.01));
  vec2 sh = vec2(u_tileShift.x, -u_tileShift.y) * u_box.z;
  vec2 cell = floor((p - sh) / sz);
  vec2 tc = (cell + 0.5) * sz + sh;
  vec2 rnd = fx_hash22(ivec2(cell), u_seed) * 2.0 - 1.0;
  vec2 off = pke_rot(u_rotateWarpDir) * (rnd * vec2(u_scrambleRelX, u_scrambleRelY)) * u_scrambleSpeed * u_box.z;
  vec2 q = tc + (p - tc) * u_zDist + off;
  return pke_sampleWrap(u_source, q / u_box.zw, ivec2(u_wrap));
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 p = pke_boxPx();
  vec4 c = (u_filter && u_zDist > 1.0)
    ? 0.25 * (at(p + vec2(-0.125, -0.375)) + at(p + vec2(0.375, -0.125)) + at(p + vec2(0.125, 0.375)) + at(p + vec2(-0.375, 0.125)))
    : at(p);
  fragColor = fx_mixOriginal(c, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const KALEIDO_EFFECTS: readonly EffectSpec[] = [
	S_KALEIDO_TRIANGLES,
	S_KALEIDO_SQUARES,
	S_KALEIDO_DIAMONDS,
	S_KALEIDO_OCT,
	S_KALEIDO_POLAR,
	S_KALEIDO_RADIAL,
	S_FLYS_EYE_CIRCLES,
	S_FLYS_EYE_HEX,
	S_FLYS_EYE_RECT,
	S_TILE_SCRAMBLE,
];

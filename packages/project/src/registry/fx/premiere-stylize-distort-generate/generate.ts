// Premiere Pro standard effects — Generate, part 1 (family "premiere-stylize-distort-generate", wave 2): 4-Color
// Gradient, Cell Pattern, Checkerboard, Circle, Ellipse, Eyedropper Fill, Grid, Ramp. Generators draw inside the
// layer box (layer px via `gen_*` of generate-glsl.ts) and combine with the layer through Premiere's Blending Mode
// (None = the generated picture alone), Composite On Original or Blend With Original.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { fxParam } from '../params.ts';
import {
	blendWithOriginalParam,
	evolutionParams,
	GLSL_PSDG_BLEND,
	psdgBlendModeParam,
	randomSeedParam,
} from './common.ts';
import { GLSL_PSDG_GENERATE } from './generate-glsl.ts';

// ---------------------------------------------------------------- 4-Color Gradient

export const FOUR_COLOR_GRADIENT = defineShaderEffect({
	id: 'jasper.4-color-gradient',
	label: '4-Color Gradient',
	category: 'Generate',
	description: 'Fills the layer with a smooth gradient blended from four coloured points.',
	keywords: ['gradient', 'four color', 'background', 'mesh', 'color wash'],
	params: [
		fxParam.point('point1', 'Point 1', [0.1, 0.1], { group: 'Positions & Colors' }),
		fxParam.color('color1', 'Color 1', [1, 1, 0, 1], { group: 'Positions & Colors' }),
		fxParam.point('point2', 'Point 2', [0.9, 0.1], { group: 'Positions & Colors' }),
		fxParam.color('color2', 'Color 2', [0, 1, 0, 1], { group: 'Positions & Colors' }),
		fxParam.point('point3', 'Point 3', [0.1, 0.9], { group: 'Positions & Colors' }),
		fxParam.color('color3', 'Color 3', [1, 0, 1, 1], { group: 'Positions & Colors' }),
		fxParam.point('point4', 'Point 4', [0.9, 0.9], { group: 'Positions & Colors' }),
		fxParam.color('color4', 'Color 4', [0, 0, 1, 1], { group: 'Positions & Colors' }),
		fxParam.number('blend', 'Blend', 100, { min: 1, max: 1000, softMax: 500, step: 0.1 }),
		fxParam.number(
			'jitter',
			'Jitter',
			0,
			{ min: 0, max: 100, step: 0.1 },
			{ unit: '%', ui: { control: 'slider' } },
		),
		fxParam.percent('opacity', 'Opacity', 100),
		psdgBlendModeParam('none'),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_GENERATE, GLSL_HASH],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 size = gen_layerSize();
  vec2 lp = fx_layerPx();
  float diag = length(size);
  // Inverse-distance weighting; Blend sets the falloff exponent (higher Blend = softer mixing).
  float e = clamp(220.0 / max(u_blend, 1.0), 0.15, 60.0);
  vec2 pts[4] = vec2[4](u_point1, u_point2, u_point3, u_point4);
  vec4 cols[4] = vec4[4](u_color1, u_color2, u_color3, u_color4);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = max(length(lp - pts[i] * size) / diag, 1.0e-4);
    float w = pow(d, -e);
    sum += cols[i].rgb * w;
    wsum += w;
  }
  vec3 c = sum / wsum;
  c += (fx_hash2(ivec2(floor(lp)), u_seed) - 0.5) * u_jitter / 100.0 * 0.25;
  fragColor = gen_finish(u_blendingMode, src, vec4(clamp(c, 0.0, 1.0), 1.0), u_opacity);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Cell Pattern

const CELL_TYPES = [
	'bubbles',
	'crystals',
	'plates',
	'staticPlates',
	'crystallize',
	'pillow',
	'crystalsHq',
	'platesHq',
	'staticPlatesHq',
	'crystallizeHq',
	'mixedCrystals',
	'tubular',
] as const;

export const CELL_PATTERN = defineShaderEffect({
	id: 'jasper.cell-pattern',
	label: 'Cell Pattern',
	category: 'Generate',
	description:
		'Generates cellular (Voronoi) patterns — bubbles, crystals, plates, pillows, tubes — for textures, mattes and backgrounds.',
	keywords: ['voronoi', 'worley', 'cells', 'texture', 'organic', 'crystals'],
	params: [
		fxParam.choice(
			'cellPattern',
			'Cell Pattern',
			CELL_TYPES,
			[
				'Bubbles',
				'Crystals',
				'Plates',
				'Static Plates',
				'Crystallize',
				'Pillow',
				'Crystals HQ',
				'Plates HQ',
				'Static Plates HQ',
				'Crystallize HQ',
				'Mixed Crystals',
				'Tubular',
			],
			'bubbles',
		),
		fxParam.toggle('invert', 'Invert', false),
		fxParam.number('contrast', 'Contrast', 100, { min: 0, max: 10000, softMax: 400, step: 0.1 }),
		fxParam.choice(
			'overflow',
			'Overflow',
			['clip', 'softClamp', 'wrapBack'],
			['Clip', 'Soft Clamp', 'Wrap Back'],
			'clip',
		),
		fxParam.number('disperse', 'Disperse', 1, { min: 0, max: 1.5, step: 0.01 }),
		fxParam.number('size', 'Size', 60, { min: 2, max: 1000, softMax: 300, step: 0.1 }),
		fxParam.point('offset', 'Offset', [0.5, 0.5]),
		fxParam.toggle('enableTiling', 'Enable Tiling', false, { group: 'Tiling Options' }),
		fxParam.number(
			'cellsHorizontal',
			'Cells Horizontal',
			16,
			{ min: 1, max: 1000, softMax: 64, step: 1 },
			{ group: 'Tiling Options' },
		),
		fxParam.number(
			'cellsVertical',
			'Cells Vertical',
			16,
			{ min: 1, max: 1000, softMax: 64, step: 1 },
			{ group: 'Tiling Options' },
		),
		...evolutionParams(),
		randomSeedParam(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_GENERATE, GLSL_HASH],
				frag: /* glsl */ `
// Feature point of a cell: jittered by Disperse, circling with Evolution (each cell its own radius/phase; the
// motion repeats every revolution, so Cycle Evolution loops seamlessly at any whole number of revolutions).
vec2 cellPoint(ivec2 c) {
  ivec2 k = c;
  if (u_enableTiling) {
    ivec2 n = ivec2(max(floor(u_cellsHorizontal), 1.0), max(floor(u_cellsVertical), 1.0));
    k = ivec2(((c.x % n.x) + n.x) % n.x, ((c.y % n.y) + n.y) % n.y);
  }
  vec2 h = fx_hash22(k, u_seed);
  float ph = fx_hash2(k + ivec2(17, 3), u_seed) * 6.28318;
  float a = radians(u_evolution) + ph;
  vec2 base = vec2(c) + 0.5 + (h - 0.5) * clamp(u_disperse, 0.0, 1.5) * 0.8;
  return base + vec2(cos(a), sin(a)) * 0.22 * clamp(u_disperse, 0.0, 1.5);
}
float cellId(ivec2 c) {
  ivec2 k = c;
  if (u_enableTiling) {
    ivec2 n = ivec2(max(floor(u_cellsHorizontal), 1.0), max(floor(u_cellsVertical), 1.0));
    k = ivec2(((c.x % n.x) + n.x) % n.x, ((c.y % n.y) + n.y) % n.y);
  }
  return fx_hash2(k + ivec2(101, 7), u_seed);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) { fragColor = vec4(0.0); return; }
  vec2 size = gen_layerSize();
  vec2 lp = fx_layerPx();
  vec2 q = u_enableTiling
    ? (lp / size) * vec2(max(floor(u_cellsHorizontal), 1.0), max(floor(u_cellsVertical), 1.0))
    : (lp - u_offset * size) / max(u_size, 1.0) + 1000.0;
  int type = u_cellPattern;
  bool hq = type >= 6 && type <= 9;
  int R = hq ? 2 : 1;
  ivec2 c0 = ivec2(floor(q));
  float f1 = 9.0, f2 = 9.0, id = 0.0;
  for (int y = -R; y <= R; y++)
    for (int x = -R; x <= R; x++) {
      ivec2 c = c0 + ivec2(x, y);
      float d = length(cellPoint(c) - q);
      if (d < f1) { f2 = f1; f1 = d; id = cellId(c); } else if (d < f2) f2 = d;
    }
  float edge = f2 - f1;
  int base = hq ? type - 5 : type; // HQ variants share the look of their standard type
  float v;
  if (base == 0) v = 1.0 - f1 * 1.25;                                     // bubbles
  else if (base == 1) v = clamp(edge * 2.2, 0.0, 1.0);                     // crystals
  else if (base == 2) v = clamp(edge * 2.2, 0.0, 1.0) * (0.35 + 0.65 * id) + 0.0; // plates
  else if (base == 3) v = id;                                               // static plates
  else if (base == 4) v = id * smoothstep(0.0, 0.06, edge);                 // crystallize
  else if (base == 5) v = pow(clamp(1.0 - f1 / max(f2, 1.0e-4), 0.0, 1.0), 0.7); // pillow
  else if (type == 10) v = mix(clamp(edge * 2.2, 0.0, 1.0), id, 0.5);      // mixed crystals
  else v = exp(-pow(edge / 0.09, 2.0));                                     // tubular
  if (u_invert) v = 1.0 - v;
  v = (v - 0.5) * u_contrast / 100.0 + 0.5;
  if (u_overflow == 0) v = clamp(v, 0.0, 1.0);
  else if (u_overflow == 1) v = 1.0 / (1.0 + exp(-4.0 * (v - 0.5)));
  else { v = mod(v, 2.0); v = v > 1.0 ? 2.0 - v : v; }
  fragColor = vec4(vec3(v), 1.0);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Checkerboard

const sizeFromParam = (def: string) =>
	fxParam.choice(
		'sizeFrom',
		'Size From',
		['cornerPoint', 'widthSlider', 'widthHeightSliders'],
		['Corner Point', 'Width Slider', 'Width & Height Sliders'],
		def,
	);

export const CHECKERBOARD = defineShaderEffect({
	id: 'jasper.checkerboard',
	label: 'Checkerboard',
	category: 'Generate',
	description: 'Draws a checkerboard of coloured and transparent squares (or rectangles) over the layer.',
	keywords: ['checker', 'chess', 'squares', 'pattern', 'grid'],
	params: [
		fxParam.point('anchor', 'Anchor', [0.5, 0.5]),
		sizeFromParam('widthSlider'),
		fxParam.point('corner', 'Corner', [0.6, 0.6]),
		fxParam.pixels('width', 'Width', 64, 1000),
		fxParam.pixels('height', 'Height', 64, 1000),
		fxParam.pixels('featherWidth', 'Width', 0, 100, { group: 'Feather' }),
		fxParam.pixels('featherHeight', 'Height', 0, 100, { group: 'Feather' }),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.percent('opacity', 'Opacity', 100),
		psdgBlendModeParam('none', { stencil: true }),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_GENERATE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 size = gen_layerSize();
  vec2 a = u_anchor * size;
  vec2 cell = gen_cellSize(u_sizeFrom, a, u_corner * size, u_width, u_height);
  vec2 rel = fx_layerPx() - a;
  float sx = gen_squareWave(rel.x, cell.x, u_featherWidth);
  float sy = gen_squareWave(rel.y, cell.y, u_featherHeight);
  float cov = clamp(0.5 + 0.5 * sx * sy, 0.0, 1.0);
  fragColor = gen_finish(u_blendingMode, src, fx_premultiply(u_color) * cov, u_opacity);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Circle

export const CIRCLE = defineShaderEffect({
	id: 'jasper.circle',
	label: 'Circle',
	category: 'Generate',
	description: 'Draws a filled circle or a ring (with feathered edges), or cuts the layer with it.',
	keywords: ['ring', 'disc', 'dot', 'shape', 'spotlight mask'],
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		fxParam.pixels('radius', 'Radius', 75, 1000),
		fxParam.choice(
			'edge',
			'Edge',
			['none', 'edgeRadius', 'thickness', 'thicknessRadius', 'thicknessFeatherRadius'],
			['None', 'Edge Radius', 'Thickness', 'Thickness * Radius', 'Thickness & Feather * Radius'],
			'none',
		),
		fxParam.pixels('thickness', 'Thickness', 10, 500),
		fxParam.pixels('featherOuter', 'Feather Outer Edge', 0, 500, { group: 'Feather' }),
		fxParam.pixels('featherInner', 'Feather Inner Edge', 0, 500, { group: 'Feather' }),
		fxParam.toggle('invertCircle', 'Invert Circle', false),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.percent('opacity', 'Opacity', 100),
		psdgBlendModeParam('none', { stencil: true }),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_GENERATE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 c = u_center * gen_layerSize();
  float d = length(fx_layerPx() - c);
  float R = max(u_radius, 0.0);
  float fo = u_featherOuter, fi = u_featherInner;
  float inner = -1.0;
  if (u_edge == 1) inner = min(u_thickness, R);                       // Edge Radius = the inner radius
  else if (u_edge == 2) inner = R - u_thickness;                       // Thickness
  else if (u_edge == 3) inner = R - u_thickness * R / 100.0;           // Thickness × Radius
  else if (u_edge == 4) { inner = R - u_thickness * R / 100.0; fo *= R / 100.0; fi *= R / 100.0; }
  float cov = gen_below(d, R, fo * 2.0);
  if (inner > 0.0) cov *= 1.0 - gen_below(d, inner, fi * 2.0);
  if (u_invertCircle) cov = 1.0 - cov;
  fragColor = gen_finish(u_blendingMode, src, fx_premultiply(u_color) * cov, u_opacity);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Ellipse

export const ELLIPSE = defineShaderEffect({
	id: 'jasper.ellipse',
	label: 'Ellipse',
	category: 'Generate',
	description: 'Draws a soft, glowing elliptical ring that blends from Inside Color to Outside Color.',
	keywords: ['ring', 'oval', 'halo', 'glow ring', 'shape'],
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		fxParam.pixels('width', 'Width', 200, 2000),
		fxParam.pixels('height', 'Height', 100, 2000),
		fxParam.pixels('thickness', 'Thickness', 12, 500),
		fxParam.percent('softness', 'Softness', 50),
		fxParam.color('insideColor', 'Inside Color', [1, 1, 1, 1]),
		fxParam.color('outsideColor', 'Outside Color', [0, 0.25, 1, 1]),
		fxParam.toggle('compositeOnOriginal', 'Composite On Original', false),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_GENERATE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) { fragColor = u_compositeOnOriginal ? src : vec4(0.0); return; }
  vec2 p = fx_layerPx() - u_center * gen_layerSize();
  vec2 r = max(vec2(u_width, u_height) * 0.5, vec2(0.5));
  // Approximate distance to the ellipse outline (layer px).
  float k = length(p / r);
  float d = (k - 1.0) * length(p) / max(k, 1.0e-4);
  float half_ = max(u_thickness * 0.5, 0.5);
  float soft = u_softness / 100.0;
  // Solid core of the ring (inside colour) with a soft falloff to the outside colour, then to transparent.
  float core = 1.0 - smoothstep(half_ * (1.0 - soft), half_, abs(d));
  float glow = 1.0 - smoothstep(half_, half_ * (1.0 + 2.0 * soft) + 1.0, abs(d));
  vec3 col = mix(u_outsideColor.rgb, u_insideColor.rgb, core);
  float a = max(core, glow);
  vec4 ring = vec4(col * a, a);
  fragColor = u_compositeOnOriginal ? ring + src * (1.0 - ring.a) : ring;
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Eyedropper Fill

export const EYEDROPPER_FILL = defineShaderEffect({
	id: 'jasper.eyedropper-fill',
	label: 'Eyedropper Fill',
	category: 'Generate',
	description: 'Fills the layer with the colour sampled (averaged over Sample Radius) at Sample Point.',
	keywords: ['sample color', 'fill', 'average color', 'solid', 'picker'],
	params: [
		fxParam.point('samplePoint', 'Sample Point', [0.5, 0.5]),
		fxParam.pixels('sampleRadius', 'Sample Radius', 1, 500),
		fxParam.choice(
			'averagePixelColors',
			'Average Pixel Colors',
			['skipEmpty', 'all', 'allPremultiplied', 'includingAlpha'],
			['Skip Empty', 'All', 'All Premultiplied', 'Including Alpha'],
			'skipEmpty',
		),
		fxParam.toggle('maintainOriginalAlpha', 'Maintain Original Alpha', false),
		blendWithOriginalParam(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				// One tiny pass: the average of a 16×16 tap grid over the sample disk (computed once, read by every pixel).
				output: 'avg',
				scale: 0.001,
				uniforms: { u_taps: { int: 16 } },
				filter: 'nearest',
				format: 'rgba16f',
				include: [GLSL_PSDG_GENERATE],
				frag: /* glsl */ `
void main() {
  vec2 c = u_samplePoint * gen_layerSize();
  float r = max(u_sampleRadius, 0.0);
  vec4 sumP = vec4(0.0);  // premultiplied
  vec3 sumS = vec3(0.0);  // straight
  float n = 0.0, na = 0.0;
  for (int y = 0; y < u_taps; y++)
    for (int x = 0; x < u_taps; x++) {
      vec2 o = (vec2(float(x), float(y)) + 0.5) / float(u_taps) * 2.0 - 1.0;
      if (dot(o, o) > 1.0 && r > 0.5) continue;
      vec4 s = texture(u_source, fx_uvOfLayerPx(c + o * r));
      sumP += s;
      n += 1.0;
      if (s.a > 0.0) { sumS += s.rgb / s.a; na += 1.0; }
    }
  vec4 res;
  if (u_averagePixelColors == 0) res = vec4(sumP.a > 0.0 ? sumP.rgb / sumP.a : vec3(0.0), 1.0);   // skip empty
  else if (u_averagePixelColors == 1) res = vec4((sumS + vec3(0.0) * (n - na)) / max(n, 1.0), 1.0); // all
  else if (u_averagePixelColors == 2) res = vec4(sumP.rgb / max(n, 1.0), 1.0);                       // all premultiplied
  else { vec4 m = sumP / max(n, 1.0); res = vec4(m.a > 0.0 ? m.rgb / m.a : vec3(0.0), m.a); }      // including alpha
  fragColor = res; // straight colour + alpha
}`,
			},
			{
				include: [GLSL_PSDG_BLEND],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) { fragColor = src; return; }
  vec4 avg = texture(u_avg, vec2(0.5));
  float a = u_maintainOriginalAlpha ? src.a : avg.a;
  vec4 fill = vec4(clamp(avg.rgb, 0.0, 1.0) * a, a);
  fragColor = psdg_blendOriginal(fill, src, u_blendWithOriginal);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Grid

export const GRID = defineShaderEffect({
	id: 'jasper.grid',
	label: 'Grid',
	category: 'Generate',
	description: 'Draws a customisable grid of lines (or cuts the layer with it).',
	keywords: ['lines', 'graph paper', 'pattern', 'overlay', 'guides'],
	params: [
		fxParam.point('anchor', 'Anchor', [0.5, 0.5]),
		sizeFromParam('cornerPoint'),
		fxParam.point('corner', 'Corner', [0.6, 0.6]),
		fxParam.pixels('width', 'Width', 64, 1000),
		fxParam.pixels('height', 'Height', 64, 1000),
		fxParam.pixels('border', 'Border', 5, 200),
		fxParam.pixels('featherWidth', 'Width', 0, 100, { group: 'Feather' }),
		fxParam.pixels('featherHeight', 'Height', 0, 100, { group: 'Feather' }),
		fxParam.toggle('invertGrid', 'Invert Grid', false),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.percent('opacity', 'Opacity', 100),
		psdgBlendModeParam('none', { stencil: true }),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_GENERATE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 size = gen_layerSize();
  vec2 a = u_anchor * size;
  vec2 cell = gen_cellSize(u_sizeFrom, a, u_corner * size, u_width, u_height);
  vec2 rel = fx_layerPx() - a;
  float hb = max(u_border, 0.0) * 0.5;
  float lx = gen_band(gen_edgeDistance(rel.x, cell.x), hb, u_featherWidth);
  float ly = gen_band(gen_edgeDistance(rel.y, cell.y), hb, u_featherHeight);
  float cov = max(lx, ly);
  if (u_invertGrid) cov = 1.0 - cov;
  fragColor = gen_finish(u_blendingMode, src, fx_premultiply(u_color) * cov, u_opacity);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Ramp

export const RAMP = defineShaderEffect({
	id: 'jasper.ramp',
	label: 'Ramp',
	category: 'Generate',
	description: 'Fills the layer with a linear or radial colour gradient between two points.',
	keywords: ['gradient', 'linear gradient', 'radial gradient', 'background', 'fade'],
	params: [
		fxParam.point('startOfRamp', 'Start of Ramp', [0.5, 0]),
		fxParam.color('startColor', 'Start Color', [0, 0, 0, 1]),
		fxParam.point('endOfRamp', 'End of Ramp', [0.5, 1]),
		fxParam.color('endColor', 'End Color', [1, 1, 1, 1]),
		fxParam.choice('rampShape', 'Ramp Shape', ['linear', 'radial'], ['Linear Ramp', 'Radial Ramp'], 'linear'),
		fxParam.number('rampScatter', 'Ramp Scatter', 0, { min: 0, max: 255, softMax: 100, step: 0.1 }),
		blendWithOriginalParam(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_GENERATE, GLSL_HASH, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) { fragColor = src; return; }
  vec2 size = gen_layerSize();
  vec2 lp = fx_layerPx();
  vec2 s = u_startOfRamp * size, e = u_endOfRamp * size;
  vec2 d = e - s;
  float t = u_rampShape == 0
    ? dot(lp - s, d) / max(dot(d, d), 1.0e-6)
    : length(lp - s) / max(length(d), 1.0e-6);
  // Ramp Scatter: dithering noise (in 8-bit levels) that hides banding.
  t += (fx_hash2(ivec2(floor(lp)), u_seed) - 0.5) * u_rampScatter / 255.0 * 2.0;
  t = clamp(t, 0.0, 1.0);
  vec4 c = mix(u_startColor, u_endColor, t);
  fragColor = psdg_blendOriginal(fx_premultiply(c), src, u_blendWithOriginal);
}`,
			},
		],
	},
});

export const PSDG_GENERATE_EFFECTS: readonly EffectSpec[] = [
	FOUR_COLOR_GRADIENT,
	CELL_PATTERN,
	CHECKERBOARD,
	CIRCLE,
	ELLIPSE,
	EYEDROPPER_FILL,
	GRID,
	RAMP,
];

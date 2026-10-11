// Sapphire AutoPaint and friends (Stylize): S_AutoPaint, S_Sketch, S_Etching, S_Brush:Oil, S_Brush:Chalk,
// S_Crosshatch, S_Cartoon, S_CartoonPaint, S_Posterize.
//
// Stroke engine (AutoPaint, Sketch, CartoonPaint, Brush): strokes are scattered one per cell of a grid anchored to the
// layer box, at seeded random positions (`u_seed`: per clip + instance + Seed param), so the pattern is stable over
// time — only the colours follow the picture — unless Jitter Frames re-randomises it every N frames. Each stroke's
// direction comes from an orientation field: Sobel gradients of the smoothed picture at the stroke scale, averaged
// in the doubled-angle representation (Stroke Align = how far it is smoothed), with a slowly varying random
// direction in flat areas. Each pixel looks at the strokes of the neighbouring cells and keeps the two on top
// (seeded priorities) — painter's order without sorting.
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam, mixWithOriginalParam, seedParam } from '../params.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';
import {
	blurPasses,
	num,
	PKE_COMMON,
	PKE_SOBEL,
	PKE_TONE,
	rgbParam,
	sNum,
	sUnitsPx,
	xyParam,
} from './common.ts';

const bin = SAPPHIRE_BINS.stylize;

/** Stroke cell size in canvas px for a Sapphire Frequency (strokes across the layer width). */
export function strokeCellPx(
	frequency: ParamValue | undefined,
	ctx: Pick<FxPlanContext, 'width' | 'pxScale'>,
): number {
	return (ctx.width * ctx.pxScale) / Math.max(0.1, num(frequency, 50));
}

/**
 * Orientation-field passes: `orient` (doubled-angle gradient at the stroke scale, half resolution) and `orientS`
 * (smoothed by Stroke Align). Reads the output `smooth`.
 */
export function orientPasses(cellPx: number, align: ParamValue | undefined): ShaderPass[] {
	return [
		{
			output: 'orient',
			scale: 0.5,
			format: 'rgba16f',
			include: [PKE_SOBEL],
			uniforms: { u_orientTap: Math.max(1, cellPx * 0.3) },
			frag: /* glsl */ `
void main() {
  vec2 g = pke_sobelLuma(u_smooth, v_uv, vec2(u_orientTap) / u_canvasSize);
  float m = min(length(g) * 4.0, 1.0);
  float a2 = 2.0 * atan(g.y, g.x);
  vec2 v = m > 1.0e-5 ? vec2(cos(a2), sin(a2)) * m : vec2(0.0);
  fragColor = vec4(v * 0.5 + 0.5, m, 1.0);
}`,
		},
		...blurPasses('orient', 'orientS', cellPx * (0.5 + 2.5 * Math.max(0, num(align, 0.2))), 'rgba16f'),
	];
}

/** The field readers (need the outputs `orientS` and `smooth`). */
const PNT_FIELD: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/field',
	deps: [PKE_COMMON],
	source: /* glsl */ `
vec3 pnt_orient(vec2 boxPx) {
  vec4 o = texture(u_orientS, pke_uvOfBoxPx(boxPx));
  return vec3(o.rg * 2.0 - 1.0, o.b);
}
// Unit edge tangent at a box position (canvas px, y down); flat areas follow a slowly varying random direction.
vec2 pnt_tangent(vec2 boxPx, float seed, float noiseFreq) {
  vec3 o = pnt_orient(boxPx);
  float na = pke_noise(boxPx * noiseFreq, seed) * 3.14159265;
  vec2 v = o.xy + 0.03 * vec2(cos(2.0 * na), sin(2.0 * na));
  float ga = 0.5 * atan(v.y, v.x);
  return vec2(-sin(ga), cos(ga));
}
// The smoothed picture (premultiplied) at a box position.
vec4 pnt_color(vec2 boxPx) { return texture(u_smooth, pke_uvOfBoxPx(clamp(boxPx, vec2(0.0), u_box.zw))); }
`,
};

/**
 * AutoPaint strokes (Van Gogh / Hairy Paint / Pointalize) over the smoothed picture. Used by S_AutoPaint and
 * S_CartoonPaint. `style`: 0 along edges, 1 across edges, 2 pointalize.
 */
const PNT_AUTOPAINT: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/autopaint',
	deps: [PNT_FIELD, PKE_COMMON],
	source: /* glsl */ `
vec4 ap_strokeColor(vec4 s, float seed) {
  vec4 c = pnt_color(s.xy);
  // Bristle streaks along the stroke.
  float br = pke_noise(vec2(s.w * 4.0, s.z * 0.5) + s.xy * 0.37, seed);
  c.rgb *= 1.0 + 0.12 * br;
  return c;
}
vec4 ap_pointalize(vec2 p, float cell, float seed) {
  ivec2 b = ivec2(floor(p / cell));
  float d1 = 1.0e9, d2 = 1.0e9;
  vec2 c1 = p;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      ivec2 id = b + ivec2(i, j);
      vec2 ctr = (vec2(id) + 0.1 + 0.8 * pke_hash22(id, seed)) * cell;
      vec2 d = abs(p - ctr);
      // A metric between Euclidean and Manhattan: pointed, crystal-like cells.
      float dist = mix(length(d), d.x + d.y, 0.6);
      if (dist < d1) { d2 = d1; d1 = dist; c1 = ctr; } else if (dist < d2) { d2 = dist; }
    }
  vec4 c = pnt_color(c1);
  float edge = smoothstep(0.0, 0.06 * cell, d2 - d1);
  c.rgb *= 0.8 + 0.2 * edge;
  return c;
}
// Strokes over the smoothed picture at box position p (canvas px).
vec4 ap_paint(vec2 p, float cell, float lenRatio, int style, float seed) {
  if (style == 2) return ap_pointalize(p, cell, seed);
  vec4 base = pnt_color(p);
  bool across = (style == 1) != (lenRatio < 0.0);
  float halfL = max(abs(lenRatio), 0.3) * 0.6 * cell;
  float halfW = 0.5 * cell;
  int R = int(min(3.0, ceil((halfL + halfW) / cell)));
  ivec2 b = ivec2(floor(p / cell));
  float p1 = -1.0, p2 = -1.0, a1 = 0.0, a2 = 0.0;
  vec4 s1 = vec4(0.0), s2 = vec4(0.0);
  float reach = halfL + halfW;
  for (int j = -R; j <= R; j++)
    for (int i = -R; i <= R; i++) {
      ivec2 id = b + ivec2(i, j);
      vec2 ctr = (vec2(id) + pke_hash22(id, seed)) * cell;
      vec2 d = p - ctr;
      if (dot(d, d) > reach * reach) continue;
      float pr = pke_hash2(id + ivec2(7331, 1337), seed);
      if (pr < p2) continue;
      vec2 t = pnt_tangent(ctr, seed, 0.25 / cell);
      if (across) t = vec2(-t.y, t.x);
      float u = dot(d, t) / halfL;
      float v = dot(d, vec2(-t.y, t.x)) / halfW;
      float taper = 1.0 - 0.3 * max(u, 0.0);
      float r = length(vec2(u, v / taper));
      float a = 1.0 - smoothstep(1.0 - 1.5 / halfW, 1.0, r);
      if (a <= 0.0) continue;
      if (pr > p1) { p2 = p1; a2 = a1; s2 = s1; p1 = pr; a1 = a; s1 = vec4(ctr, u, v); }
      else { p2 = pr; a2 = a; s2 = vec4(ctr, u, v); }
    }
  vec4 c1 = a1 > 0.0 ? ap_strokeColor(s1, seed) : vec4(0.0);
  vec4 c2 = a2 > 0.0 ? ap_strokeColor(s2, seed) : vec4(0.0);
  return c1 * a1 + (c2 * a2 + base * (1.0 - a2)) * (1.0 - a1);
}
`,
};

/** Unsharp mask of the output `paint` at radius r canvas px. */
const SHARPEN_GLSL = /* glsl */ `
vec4 pnt_sharpen(float amount, float r) {
  vec4 c = texture(u_paint, v_uv);
  vec2 d = vec2(max(r, 0.75)) / u_canvasSize;
  vec4 b = (texture(u_paint, v_uv + vec2(d.x, 0.0)) + texture(u_paint, v_uv - vec2(d.x, 0.0))
          + texture(u_paint, v_uv + vec2(0.0, d.y)) + texture(u_paint, v_uv - vec2(0.0, d.y))) * 0.15
         + (texture(u_paint, v_uv + d * 0.7071) + texture(u_paint, v_uv - d * 0.7071)
          + texture(u_paint, v_uv + vec2(d.x, -d.y) * 0.7071) + texture(u_paint, v_uv + vec2(-d.x, d.y) * 0.7071)) * 0.1;
  vec4 s = c + amount * (c - b);
  s.a = clamp(s.a, 0.0, 1.0);
  s.rgb = clamp(s.rgb, vec3(0.0), vec3(s.a));
  return s;
}
`;

const jitterParam = () =>
	fxParam.number('jitterFrames', 'Jitter Frames', 0, { min: 0, softMax: 30, step: 1 }, { animatable: false });
const strokeParams = (styleOpts: [string[], string[], string], freqMin: number): ParamSpec[] => [
	fxParam.choice('style', 'Style', styleOpts[0], styleOpts[1], styleOpts[2]),
	sNum('frequency', 'Frequency', 50, { min: freqMin, softMax: 200, step: 0.1 }),
	sNum('strokeLength', 'Stroke Length', 2, { softMin: -6, softMax: 6, step: 0.01 }),
	sNum('strokeAlign', 'Stroke Align', 0.2, { min: 0, softMax: 2, step: 0.01 }),
	sNum('smoothColors', 'Smooth Colors', 0, { min: 0, softMax: 2 }),
	seedParam(),
	jitterParam(),
];
const edgeParams = (): ParamSpec[] => [
	sNum('edgeWidth', 'Edge Width', 0.02, { min: 0, softMax: 1 }),
	sNum('edgeStrength', 'Edge Strength', 2, { min: 0, softMax: 10, step: 0.01 }),
	sNum('edgeThreshold', 'Edge Threshold', 0.1, { min: 0, softMax: 1 }),
	rgbParam('edgeColor', 'Edge Color', [0, 0, 0]),
	sNum('suppressSmallEdges', 'Suppress Small Edges', 0.5, { min: 0, softMax: 4, step: 0.01 }),
	sNum('edgeSharpen', 'Edge Sharpen', 0, { min: 0, softMax: 4, step: 0.01 }),
];
const posterizeParams = (): ParamSpec[] => [
	sNum('posterizeAmount', 'Posterize Amount', 0, { min: 0, max: 1, step: 0.001 }),
	sNum('posterizeSmooth', 'Posterize Smooth', 0.1, { min: 0, max: 1, step: 0.001 }),
	sNum('posterizePhase', 'Posterize Phase', 0, { softMin: -1, softMax: 1, step: 0.001 }),
];
const saturationP = (min = -2, max = 10) => sNum('saturation', 'Saturation', 1, { min, max, step: 0.01 });
const scaleLightsP = () => sNum('scaleLights', 'Scale Lights', 1, { min: 0, softMax: 4, step: 0.01 });
const offsetDarksP = (range: { min?: number; max?: number } = {}) =>
	sNum('offsetDarks', 'Offset Darks', 0, { softMin: -1, softMax: 1, step: 0.001, ...range });
const tintLightsP = () => rgbParam('tintLights', 'Tint Lights', [1, 1, 1]);
const tintDarksP = () => rgbParam('tintDarks', 'Tint Darks', [0, 0, 0]);

export const S_AUTO_PAINT = defineShaderEffect({
	id: 'jasper.s.auto-paint',
	label: 'S_AutoPaint',
	category: 'Stylize',
	bin,
	description:
		'A paint-brushed version of the clip: strokes follow the edges (Van Gogh), cross them (Hairy Paint) or form pointed cells (Pointalize). Stroke positions stay put over time unless Jitter Frames is set.',
	keywords: ['paint', 'painting', 'brush', 'strokes', 'van gogh', 'impressionist', 'artistic', 'sapphire'],
	expensive: true,
	params: [
		...strokeParams(
			[['vanGogh', 'hairyPaint', 'pointalize'], ['Van Gogh', 'Hairy Paint', 'Pointalize'], 'vanGogh'],
			0.1,
		),
		sNum('sharpen', 'Sharpen', 1, { softMin: -2, softMax: 4, step: 0.01 }),
		sNum('sharpenWidth', 'Sharpen Width', 0.1, { min: 0, softMax: 1, step: 0.001 }),
		mixWithOriginalParam(),
	],
	gpu: {
		passes: (p, ctx) => {
			const cell = strokeCellPx(p.frequency, ctx);
			return [
				...blurPasses('source', 'smooth', sUnitsPx(p.smoothColors, ctx)),
				...orientPasses(cell, p.strokeAlign),
				{
					output: 'paint',
					include: [PNT_AUTOPAINT],
					frag: /* glsl */ `
void main() {
  float cell = u_box.z / max(u_frequency, 0.1);
  fragColor = ap_paint(pke_boxPx(), cell, u_strokeLength, u_style, pke_seed(u_jitterFrames));
}`,
				},
				{
					include: [GLSL_COMPOSITE],
					frag: /* glsl */ `
${SHARPEN_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  float cell = u_box.z / max(u_frequency, 0.1);
  fragColor = fx_mixOriginal(pnt_sharpen(u_sharpen, u_sharpenWidth * cell), src, u_mixWithOriginal);
}`,
				},
			];
		},
	},
});

export const S_SKETCH = defineShaderEffect({
	id: 'jasper.s.sketch',
	label: 'S_Sketch',
	category: 'Stylize',
	bin,
	description:
		'A hand-drawn sketch of the clip: coloured pencil lines following the edges (or across them: Bumpy Sketch) over a paper-coloured background, denser in the darks.',
	keywords: ['sketch', 'pencil', 'drawing', 'lines', 'hand drawn', 'artistic', 'sapphire'],
	expensive: true,
	params: [
		...strokeParams([['sketch', 'bumpySketch'], ['Sketch', 'Bumpy Sketch'], 'sketch'], 1),
		rgbParam('backgroundColor', 'Background Color', [0.8, 0.8, 0.8]),
		sNum('lineThickness', 'Line Thickness', 0.04, { min: 0, softMax: 0.5 }),
		sNum('lineStrength', 'Line Strength', 0.3, { min: 0, softMax: 2, step: 0.01 }),
		mixWithOriginalParam(),
	],
	gpu: {
		passes: (p, ctx) => {
			const cell = strokeCellPx(p.frequency, ctx);
			return [
				...blurPasses('source', 'smooth', sUnitsPx(p.smoothColors, ctx)),
				...orientPasses(cell, p.strokeAlign),
				{
					include: [PNT_FIELD, PKE_COMMON, GLSL_COMPOSITE],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 p = pke_boxPx();
  float seed = pke_seed(u_jitterFrames);
  float cell = u_box.z / max(u_frequency, 1.0);
  float lc = cell / 2.5;                                   // line spacing: several lines per stroke cell
  bool across = (u_style == 1) != (u_strokeLength < 0.0);
  float halfL = max(abs(u_strokeLength), 0.3) * 0.45 * cell;
  float halfT = max(u_lineThickness * cell * 0.5, 0.6);
  int R = int(min(4.0, ceil(halfL / lc)));
  ivec2 b = ivec2(floor(p / lc));
  vec3 csum = vec3(0.0);
  float wsum = 0.0, keep = 1.0;
  for (int j = -R; j <= R; j++)
    for (int i = -R; i <= R; i++) {
      ivec2 id = b + ivec2(i, j);
      vec2 ctr = (vec2(id) + pke_hash22(id, seed)) * lc;
      vec2 d = p - ctr;
      if (dot(d, d) > (halfL + halfT) * (halfL + halfT)) continue;
      vec4 c = fx_unpremultiply(pnt_color(ctr));
      float dark = 1.0 - fx_luma(c.rgb);
      // Fewer lines where the picture is light.
      if (pke_hash2(id + ivec2(31, 977), seed) > 0.15 + 1.1 * dark) continue;
      vec2 t = pnt_tangent(ctr, seed, 0.25 / cell);
      if (across) t = vec2(-t.y, t.x);
      float len = halfL * (0.6 + 0.4 * pke_hash2(id + ivec2(5, 3), seed));
      float u = clamp(dot(d, t), -len, len);
      float dist = length(d - t * u);
      float cov = 1.0 - smoothstep(halfT - 0.5, halfT + 0.5, dist);
      cov *= 1.0 - smoothstep(0.6, 1.0, abs(dot(d, t)) / len) * 0.7;  // lighter ends
      float a = clamp(cov * u_lineStrength * (0.6 + 1.6 * dark), 0.0, 1.0);
      if (a <= 0.0) continue;
      csum += c.rgb * 0.75 * a;
      wsum += a;
      keep *= 1.0 - a;
    }
  vec3 lineCol = wsum > 0.0 ? csum / wsum : vec3(0.0);
  vec3 col = mix(u_backgroundColor.rgb, lineCol, 1.0 - keep);
  fragColor = fx_mixOriginal(vec4(col * src.a, src.a), src, u_mixWithOriginal);
}`,
				},
			];
		},
	},
});

export const S_ETCHING = defineShaderEffect({
	id: 'jasper.s.etching',
	label: 'S_Etching',
	category: 'Stylize',
	bin,
	description:
		'An etching / lithograph look: two sets of wavy black and white lines whose thickness follows the brightness, bent by the picture, plus engraved edges.',
	keywords: ['etching', 'engraving', 'lithograph', 'lines', 'banknote', 'woodcut', 'sapphire'],
	params: [
		sNum('linesFrequency', 'Lines Frequency', 50, { min: 0, softMax: 300, step: 0.1 }),
		sNum('lines1Frequency', 'Lines1 Frequency', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('lines2Frequency', 'Lines2 Frequency', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.angle('linesAngle', 'Lines Angle', 0),
		fxParam.angle('lines1Angle', 'Lines1 Angle', 30),
		fxParam.angle('lines2Angle', 'Lines2 Angle', -20),
		xyParam('linesShift', 'Lines Shift', [0, 0]),
		sNum('linesSharpness', 'Lines Sharpness', 4, { min: 0, softMax: 20, step: 0.01 }),
		sNum('linesAddWidth', 'Lines Add Width', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('smoothSource', 'Smooth Source', 0, { min: 0, softMax: 2 }),
		rgbParam('color1', 'Color1', [1, 1, 1]),
		rgbParam('color0', 'Color0', [0, 0, 0]),
		sNum('waveAmp', 'Wave Amp', 0.1, { min: 0, softMax: 1 }),
		sNum('waveFrequency', 'Wave Frequency', 2, { min: 0, softMax: 20, step: 0.01 }),
		sNum('warpAmp', 'Warp Amp', 0.04, { softMin: -0.5, softMax: 0.5 }),
		sNum('warpSmooth', 'Warp Smooth', 0.044, { min: 0, softMax: 1 }),
		sNum('edgesScale', 'Edges Scale', 0.5, { min: 0, softMax: 4, step: 0.01 }),
		sNum('edgesThreshold', 'Edges Threshold', 0.3, { min: 0, softMax: 2, step: 0.001 }),
		sNum('edgesWidth', 'Edges Width', 0, { min: 0, softMax: 1 }),
		sNum('edgesSharpness', 'Edges Sharpness', 3, { min: 0, softMax: 20, step: 0.01 }),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth', sUnitsPx(p.smoothSource, ctx)),
			...blurPasses('source', 'warp', sUnitsPx(p.warpSmooth, ctx) * 10),
			...blurPasses('source', 'edgeSrc', sUnitsPx(p.edgesWidth, ctx)),
			{
				include: [PKE_COMMON, PKE_SOBEL, GLSL_COMPOSITE],
				frag: /* glsl */ `
float lineSet(vec2 c, float angle, float freq, float level, float warp) {
  vec2 q = pke_rot(-(u_linesAngle + angle)) * c;
  float f = u_linesFrequency * freq;
  float u = q.y * f + u_waveAmp * 2.0 * sin(6.28318530718 * u_waveFrequency * q.x) + u_warpAmp * f * warp;
  float tri = abs(fract(u) - 0.5) * 2.0;                     // 0 on a line, 1 between lines
  float dark = (1.0 - level) * 0.52 + u_linesAddWidth;      // line width grows with darkness
  float w = max(0.25 / (u_linesSharpness + 1.0), fwidth(tri) * 0.75);
  return clamp(0.5 + (tri - dark) / (2.0 * w), 0.0, 1.0);    // 1 = bright paper
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 c = (pke_boxPx() - 0.5 * u_box.zw) / u_box.z - vec2(u_linesShift.x, -u_linesShift.y);
  float level = fx_luma(fx_unpremultiply(texture(u_smooth, v_uv)).rgb);
  float warp = fx_luma(fx_unpremultiply(texture(u_warp, v_uv)).rgb);
  float bright = min(lineSet(c, u_lines1Angle, u_lines1Frequency, level, warp),
                     lineSet(c, u_lines2Angle, u_lines2Frequency, level, warp));
  // Engraved edges.
  float e = length(pke_sobelLuma(u_edgeSrc, v_uv, u_texel)) * 2.0;
  float ew = 0.5 / (u_edgesSharpness + 1.0);
  float edge = smoothstep(u_edgesThreshold * 0.5, u_edgesThreshold * 0.5 + ew, e) * u_edgesScale * 2.0;
  bright *= 1.0 - clamp(edge, 0.0, 1.0);
  vec3 col = mix(u_color0.rgb, u_color1.rgb, bright);
  fragColor = fx_mixOriginal(vec4(col * src.a, src.a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

/** Brush shapes in Sapphire's popup order (`matchToStyle` = Round for Oil, Sponge for Chalk). */
export const BRUSH_SHAPES = [
	'matchToStyle',
	'feltTip',
	'splat',
	'waterColor',
	'stipple',
	'pencil',
	'pastel',
	'sponge',
	'splodge',
	'round',
	'cubes',
] as const;
const BRUSH_SHAPE_LABELS = [
	'Match To Style',
	'Felt Tip',
	'Splat',
	'Water Color',
	'Stipple',
	'Pencil',
	'Pastel',
	'Sponge',
	'Splodge',
	'Round',
	'Cubes',
];
/** Most paint layers (Sapphire: 1..5). */
export const BRUSH_MAX_LAYERS = 5;

const BRUSH_GLSL: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/brush',
	deps: [PNT_FIELD, PKE_COMMON],
	source: /* glsl */ `
// Width / length of each shape (index = BRUSH_SHAPES).
float br_aspect(int s) {
  if (s == 1) return 0.5; if (s == 2) return 0.9; if (s == 3) return 0.85; if (s == 4) return 0.6;
  if (s == 5) return 0.14; if (s == 6) return 0.45; if (s == 7) return 0.6; if (s == 8) return 0.6;
  if (s == 10) return 1.0; return 0.5;
}
float br_in(float x, float aa) { return 1.0 - smoothstep(1.0 - aa, 1.0, x); }
// Bristle streaks along a stroke (analytic, so the oil relief can use its slope): 0..1.
float br_streak(float v, float phase) { return 0.5 + 0.5 * sin(v * 9.0 + phase); }
// Dots of a jittered grid in stroke space (splat, stipple holes): distance to the cell's dot, in cells.
float br_dots(vec2 l, float freq, vec2 g, float seed) {
  vec2 q = l * freq + g;
  vec2 c = floor(q);
  vec2 o = 0.25 + 0.5 * pke_hash22(ivec2(c), seed);
  return length(q - c - o);
}
// Brush coverage at local coords (x along the stroke −1..1, y across −1..1); g = per-stroke noise offset;
// aa = antialias width in local units.
float br_shape(int s, vec2 l, vec2 g, float aa, float seed) {
  float u = l.x, v = l.y;
  float n = pke_noise(l * 2.0 + g, seed) * 0.5 + 0.5;
  float streak = br_streak(v, g.x);
  if (s == 1) return br_in(abs(u), aa) * br_in(abs(v) / max((1.0 - u) * 0.55 + 0.05, 0.05), aa);            // felt tip
  if (s == 2) return br_in(length(l), aa) * (1.0 - smoothstep(0.18, 0.3, br_dots(l, 5.0, g, seed)));       // splat
  if (s == 3) { float r = length(l) / (0.72 + 0.28 * n); return br_in(r, aa * 2.0) * (0.55 + 0.45 * smoothstep(0.55, 0.95, r)); } // water color
  if (s == 4) return (1.0 - smoothstep(0.7, 1.0, abs(u))) * (1.0 - smoothstep(0.6, 1.0, abs(v))) * smoothstep(0.12, 0.3, br_dots(l, 3.5, g, seed)); // stipple
  if (s == 5) return br_in(abs(u), aa) * br_in(abs(v), aa * 3.0) * (0.55 + 0.45 * pke_hash2(ivec2(floor((l + g) * vec2(4.0, 12.0))), seed)); // pencil
  if (s == 6) return br_in(abs(u), aa) * br_in(abs(v) / (0.25 + 0.375 * (1.0 - u)), aa) * (0.7 + 0.3 * streak); // pastel
  if (s == 7) return (1.0 - smoothstep(0.75, 1.0, abs(u))) * (1.0 - smoothstep(0.75, 1.0, abs(v)))
                  * smoothstep(0.38, 0.55, n * 0.6 + 0.4 * pke_hash2(ivec2(floor((l + g) * 6.0)), seed));      // sponge
  if (s == 8) return (1.0 - smoothstep(0.4, 1.0, abs(u))) * (1.0 - smoothstep(0.3, 1.0, abs(v))) * (0.6 + 0.4 * n); // splodge
  if (s == 10) return br_in(abs(u), aa) * br_in(abs(v), aa);                                                  // cubes
  float body = 1.0 - smoothstep(0.55, 1.0, length(l));                                                         // round
  return body * mix(1.0, smoothstep(0.3, 0.6, streak), clamp(-u * 1.3, 0.0, 1.0));
}
`,
};

function brushParams(style: 'oil' | 'chalk'): ParamSpec[] {
	const looks: ParamSpec[] =
		style === 'oil'
			? [
					sNum('roughness', 'Roughness', 0.5, { min: 0, max: 10, step: 0.01 }),
					sNum('intensity', 'Intensity', 1, { min: 0, max: 10, step: 0.01 }),
					sNum('deterioration', 'Deterioration', 0, { min: 0, max: 10, step: 0.01 }),
				]
			: [
					sNum('contrast', 'Contrast', 0.05, { min: 0, max: 10, step: 0.01 }),
					sNum('chalkiness', 'Chalkiness', 0.6, { min: 0, max: 1, step: 0.01 }),
					sNum('blending', 'Blending', 0.6, { min: 0, max: 1, step: 0.01 }),
				];
	return [
		fxParam.choice('shape', 'Shape', BRUSH_SHAPES, BRUSH_SHAPE_LABELS, 'matchToStyle'),
		sNum('maxSize', 'Max Size', 1.5, { min: 0, max: 10, step: 0.01 }),
		sNum('sizeRange', 'Size Range', 0.01, { min: 0, max: 1, step: 0.001 }),
		fxParam.angle('angle', 'Angle', 60, { range: { min: 0, max: 360 } }),
		fxParam.angle('varyAngle', 'Vary Angle', 20, { range: { min: 0, max: 360 } }),
		sNum('contourAlignment', 'Contour Alignment', 0.5, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('layers', 'Layers', 3, { min: 1, max: BRUSH_MAX_LAYERS, step: 1 }, { animatable: false }),
		sNum('density', 'Density', 80, { min: 1, max: 100, step: 0.1 }),
		sNum('relXDensity', 'Rel X Density', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('relYDensity', 'Rel Y Density', 0.8, { min: 0, softMax: 4, step: 0.01 }),
		sNum('varyPosition', 'Vary Position', 1, { min: 0, max: 10, step: 0.01 }),
		...looks,
		sNum('smoothColors', 'Smooth Colors', 0.08, { min: 0, max: 1, step: 0.001 }),
		sNum('useSourceColor', 'Use Source Color', 0.8, { min: 0, max: 1, step: 0.01 }),
		rgbParam('paintColor', 'Paint Color', [1, 1, 1]),
		sNum('bgOpacity', 'Bg Opacity', 1, { min: 0, max: 1, step: 0.01 }),
		seedParam(),
		fxParam.toggle('cropToSourceAlpha', 'Crop To Source Alpha', false),
		fxParam.toggle('softBorders', 'Soft Borders', false),
		mixWithOriginalParam(),
	];
}

/** Brush length (layer px) of the first layer: Max Size 1 = 2 % of the layer width. */
export function brushSizePx(p: EffectParams, width: number): number {
	return Math.max(0, num(p.maxSize, 1.5)) * 0.02 * width;
}

const OIL_COVERAGE = 'cov = 1.0 - pow(1.0 - clamp(cov, 0.0, 1.0), max(u_intensity, 0.0) * 1.5 + 0.01);';
const CHALK_COVERAGE = `float grainN = pke_noise(p * 0.45, seed) * 0.5 + 0.5;
      float th = (1.0 - u_chalkiness) * 0.75;
      cov *= smoothstep(th - 0.12, th + 0.12, grainN * 0.7 + 0.3 * cov) * (1.0 - 0.6 * u_blending);`;
const CHALK_TINT = 'col *= 1.0 + u_contrast * (pke_hash2(id + ivec2(41, 43), seed) - 0.5) * 2.0;';
const OIL_FUNCS = /* glsl */ `
// Paint relief of the top stroke (oil): a dome across the stroke with bristle ridges, lit from the upper left.
// w = (local x, local y, noise offset), f = (tangent, half length, half width) in canvas px.
vec3 shadeOil(vec3 col, vec2 p, vec4 w, vec4 f, float seed, float S, vec2 crack) {
  vec2 l = w.xy;
  // h = dome(l) * (0.6 + 0.4 streak): slopes per local unit, then per px.
  float q = clamp(1.0 - l.x * l.x * 0.35 - l.y * l.y, 0.02, 1.0);
  float dome = sqrt(q);
  vec2 dDome = vec2(-0.35 * l.x, -l.y) / dome;
  dDome *= min(1.0, 1.5 / max(length(dDome), 1.0e-4));          // no cliffs at the rim
  float st = br_streak(l.y, w.z);
  float dSt = 4.5 * cos(l.y * 9.0 + w.z);
  vec2 dh = dDome * (0.6 + 0.4 * st) + vec2(0.0, dome * 0.4 * dSt);
  // Slopes per local unit → screen directions (length and width axes), scaled by Roughness.
  vec2 t = f.xy;
  vec2 sl = dh.x * (f.w / f.z) * t + dh.y * vec2(-t.y, t.x);
  vec3 nrm = normalize(vec3(-sl * u_roughness * 0.45, 1.0));
  vec3 L = normalize(vec3(-0.6, -0.7, 1.0));
  float dif = max(dot(nrm, L), 0.0) / L.z;
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = max(pow(max(dot(nrm, H), 0.0), 30.0) - pow(H.z, 30.0), 0.0);
  col = col * mix(1.0, dif, 0.7) + spec * 0.6 * min(u_roughness, 2.0);
  if (u_deterioration > 0.0) {
    float cr = 1.0 - smoothstep(0.0, 0.07, crack.y - crack.x);
    col *= 1.0 - clamp(u_deterioration * (0.12 * cr + 0.05 * (1.0 - dif)), 0.0, 0.9);
  }
  return col;
}
`;
const OIL_SHADE = `if (a1 > 0.0) {
    vec2 crack = u_deterioration > 0.0 ? pke_cellular(p / max(S * 0.25, 2.0), seed + 0.37) : vec2(1.0);
    c1 = shadeOil(c1, p, w1, f1, seed, S, crack);
  }`;

function brushEffect(style: 'oil' | 'chalk') {
	const oil = style === 'oil';
	return defineShaderEffect({
		id: oil ? 'jasper.s.brush-oil' : 'jasper.s.brush-chalk',
		label: oil ? 'S_Brush:Oil' : 'S_Brush:Chalk',
		category: 'Stylize',
		bin,
		description: oil
			? 'An oil painting: layers of brush strokes of varying sizes and directions (ten brush shapes), with paint thickness, highlights and cracking.'
			: 'A chalk drawing: layers of grainy brush strokes of varying sizes and directions (ten brush shapes) that blend into each other.',
		keywords: oil
			? ['oil', 'paint', 'painting', 'brush', 'strokes', 'canvas', 'impasto', 'sapphire']
			: ['chalk', 'pastel', 'drawing', 'brush', 'strokes', 'sapphire'],
		expensive: true,
		params: brushParams(style),
		gpu: {
			timeInvariant: true,
			padding: (p, ctx) => (p.softBorders === true ? brushSizePx(p, ctx.width) * 0.75 : 0),
			passes: (p, ctx) => {
				const size = brushSizePx(p, ctx.width) * ctx.pxScale;
				const layers = Math.round(Math.min(BRUSH_MAX_LAYERS, Math.max(1, num(p.layers, 3))));
				const frag = /* glsl */ `
const int MATCH_SHAPE = ${oil ? 9 : 7};
OILFUNCS
// Top two strokes of one layer at p → premultiplied colour.
vec4 layerPaint(vec2 p, int k, float S, int shape, float seed) {
  float aspect = br_aspect(shape);
  float base = S * mix(1.2, 0.3, (u_density - 1.0) / 99.0);
  vec2 sp = vec2(base / max(u_relXDensity, 0.05), base / max(u_relYDensity, 0.05));
  float halfL = 0.5 * S, halfW = halfL * aspect;
  float jit = u_varyPosition * 0.5;
  int R = int(min(3.0, ceil((halfL + jit * max(sp.x, sp.y)) / min(sp.x, sp.y))));
  ivec2 b = ivec2(floor(p / sp));
  float p1 = -1.0, p2 = -1.0, a1 = 0.0, a2 = 0.0;
  vec3 c1 = vec3(0.0), c2 = vec3(0.0);
  vec4 w1 = vec4(0.0), f1 = vec4(1.0);
  float aa = 1.2 / max(halfW, 1.0);
  float ang = radians(u_angle);
  vec2 fixedDir = vec2(cos(2.0 * ang), sin(2.0 * ang));
  for (int j = -R; j <= R; j++)
    for (int i = -R; i <= R; i++) {
      ivec2 cid = b + ivec2(i, j);
      ivec2 id = cid + ivec2(k * 7919, k * 104729);
      vec2 r = pke_hash22(id, seed);
      vec2 ctr = (vec2(cid) + 0.5 + (r - 0.5) * jit * 2.0) * sp;
      if (any(lessThan(ctr, vec2(0.0))) || any(greaterThan(ctr, u_box.zw))) continue;
      float pr = pke_hash2(id + ivec2(13, 71), seed);
      if (pr < p2) continue;
      float sz = 1.0 - u_sizeRange * pke_hash2(id + ivec2(17, 19), seed);
      vec2 d = p - ctr;
      float hl = halfL * sz, hw = halfW * sz;
      if (dot(d, d) > (hl + hw) * (hl + hw)) continue;
      vec3 o = pnt_orient(ctr);
      // Finer layers only where there is detail.
      if (k > 0 && pke_hash2(id + ivec2(3, 5), seed) > smoothstep(0.05, 0.35, o.z) * (1.0 - 0.12 * float(k))) continue;
      // Direction: Angle blended with the contour direction (orientations as doubled angles), plus Vary Angle.
      vec2 contour = -o.xy + 0.03 * vec2(cos(pke_hash2(cid, seed) * 6.2832), sin(pke_hash2(cid, seed) * 6.2832));
      vec2 m = mix(fixedDir, contour, u_contourAlignment);
      float a = 0.5 * atan(m.y, m.x) + radians(u_varyAngle) * pke_hash2(id + ivec2(23, 29), seed);
      vec2 t = vec2(cos(a), sin(a));
      vec2 l = vec2(dot(d, t) / hl, dot(d, vec2(-t.y, t.x)) / hw);
      if (abs(l.x) > 1.05 || abs(l.y) > 1.05) continue;
      vec2 g = r * 37.0;
      float cov = br_shape(shape, l, g, aa, seed);
      COVERAGE
      if (cov <= 0.002) continue;
      vec4 sc = fx_unpremultiply(pnt_color(ctr));
      cov *= sc.a;                                   // no paint where the source is transparent
      if (cov <= 0.002) continue;
      vec3 col = mix(u_paintColor.rgb, sc.rgb, u_useSourceColor);
      TINT
      col = clamp(col, 0.0, 1.0);
      if (pr > p1) { p2 = p1; a2 = a1; c2 = c1; p1 = pr; a1 = cov; c1 = col; w1 = vec4(l, g); f1 = vec4(t, hl, hw); }
      else { p2 = pr; a2 = cov; c2 = col; }
    }
  SHADE
  float A = 1.0 - (1.0 - a1) * (1.0 - a2);
  return vec4(c1 * a1 + c2 * a2 * (1.0 - a1), A);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 p = pke_boxPx();
  int shape = u_shape == 0 ? MATCH_SHAPE : u_shape;
  float S0 = u_maxSize * 0.02 * u_box.z;
  // Layer k paints over the previous layers (pass k − 1) or, first, over the background.
  vec4 acc = u_layer == 0 ? src * u_bgOpacity : texture(u_prev, v_uv);
  if (S0 >= 1.0) {
    vec4 lp = layerPaint(p, u_layer, S0 * pow(0.72, float(u_layer)), shape, fract(u_seed + float(u_layer) * 0.1031));
    acc = lp + acc * (1.0 - lp.a);
  }
  if (u_last) {
    if (u_cropToSourceAlpha) acc *= src.a;
    if (!u_softBorders && !fx_inBox(v_uv)) acc = vec4(0.0);
    acc = fx_mixOriginal(acc, src, u_mixWithOriginal);
  }
  fragColor = acc;
}`
					.replace('COVERAGE', oil ? OIL_COVERAGE : CHALK_COVERAGE)
					.replace('TINT', oil ? '' : CHALK_TINT)
					.replace('SHADE', oil ? OIL_SHADE : '')
					.replace('OILFUNCS', oil ? OIL_FUNCS : '');
				return [
					...blurPasses('source', 'smooth', Math.max(0, num(p.smoothColors, 0.08)) * size),
					...orientPasses(Math.max(2, size * 0.6), 0.3),
					// One pass per paint layer (the same shader; keeps each draw short on slow GPUs).
					...Array.from(
						{ length: layers },
						(_, k): ShaderPass => ({
							output: `layer${k}`,
							include: [BRUSH_GLSL, GLSL_COMPOSITE],
							uniforms: { u_layer: { int: k }, u_last: k === layers - 1 },
							frag,
						}),
					),
				];
			},
		},
	});
}

export const S_BRUSH_OIL = brushEffect('oil');
export const S_BRUSH_CHALK = brushEffect('chalk');

export const S_CROSSHATCH = defineShaderEffect({
	id: 'jasper.s.crosshatch',
	label: 'S_Crosshatch',
	category: 'Stylize',
	bin,
	description:
		'A pen-sketch crosshatch: the picture is split into four luma bands, each drawn with a denser pattern of overlapping strokes (from none in the brights to double crosshatching in the darks).',
	keywords: ['crosshatch', 'hatching', 'pen', 'ink', 'sketch', 'drawing', 'comic', 'sapphire'],
	expensive: true,
	params: [
		sNum('strokeFrequency', 'Stroke Frequency', 100, { min: 1, max: 500, step: 0.1 }),
		sNum('strokeLength', 'Stroke Length', 10, { min: 0.1, softMax: 40, step: 0.01 }),
		sNum('strokeStrength', 'Stroke Strength', 0.55, { min: 0, max: 1, step: 0.001 }),
		sNum('strokeSoftness', 'Stroke Softness', 0.1, { min: 0.001, max: 1, step: 0.001 }),
		fxParam.angle('strokeAngle', 'Stroke Angle', 45),
		xyParam('strokeShift', 'Stroke Shift', [0, 0]),
		sNum('animateSpeed', 'Animate Speed', 1, { min: 0, max: 5, step: 0.01 }),
		sNum('thresholdDarks', 'Threshold Darks', 0.15, { min: 0, max: 1, step: 0.001 }),
		sNum('thresholdMids', 'Threshold Mids', 0.35, { min: 0, max: 1, step: 0.001 }),
		sNum('thresholdBrights', 'Threshold Brights', 0.6, { min: 0, max: 1, step: 0.001 }),
		sNum('thresholdsAdd', 'Thresholds Add', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('mixThreshold', 'Mix Threshold', 0.005, { min: 0, max: 0.1, step: 0.0001 }),
		sNum('strokesUseSource', 'Strokes Use Source', 0, { min: 0, max: 1, step: 0.01 }),
		rgbParam('strokeColor', 'Stroke Color', [0, 0, 0]),
		...posterizeParams().map((p) => (p.name === 'posterizeSmooth' ? { ...p, default: 0 } : p)),
		sNum('edgeStrength', 'Edge Strength', 0, { min: 0, softMax: 10, step: 0.01 }),
		sNum('edgeWidth', 'Edge Width', 0.002, { min: 0, softMax: 0.5 }),
		sNum('edgeThreshold', 'Edge Threshold', 0.5, { min: 0, softMax: 2, step: 0.001 }),
		rgbParam('edgeColor', 'Edge Color', [0, 0, 0]),
		sNum('suppressSmallEdges', 'Suppress Small Edges', 0.5, { min: 0, softMax: 4, step: 0.01 }),
		sNum('edgeSharpen', 'Edge Sharpen', 0, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.choice(
			'backStyle',
			'Back Style',
			['source', 'solidColor'],
			['Source', 'Solid Color'],
			'solidColor',
		),
		rgbParam('solidColor', 'Solid Color', [1, 1, 1]),
		sNum('preBlurBg', 'Pre Blur Bg', 0, { min: 0, softMax: 2 }),
		sNum('useSourceAlpha', 'Use Source Alpha', 1, { min: 0, max: 1, step: 0.01 }),
		saturationP(0, 10),
		scaleLightsP(),
		offsetDarksP(),
		tintLightsP(),
		tintDarksP(),
		seedParam(),
		mixWithOriginalParam(),
	],
	gpu: {
		passes: (p, ctx) => [
			...blurPasses('source', 'pre', sUnitsPx(p.preBlurBg, ctx)),
			{
				include: [PKE_COMMON, PKE_SOBEL, PKE_TONE, GLSL_COMPOSITE],
				frag: /* glsl */ `
// Coverage of one set of strokes at angle (degrees) for box position p (canvas px).
float strokes(vec2 p, float angle, float salt) {
  float w = u_box.z / max(u_strokeFrequency, 1.0);           // stroke width unit
  float len = max(u_strokeLength, 0.1) * w;
  vec2 q = pke_rot(-angle) * p;
  vec2 cs = vec2(len * 0.75, w);                              // cell: along × across
  ivec2 b = ivec2(floor(q / cs));
  float hw = 0.5 * w * u_strokeStrength * 0.8;
  float hl = 0.5 * len * (0.55 + 0.45 * u_strokeStrength);
  float soft = max(u_strokeSoftness * hw, 0.6);
  float t = u_time * u_animateSpeed;
  float cov = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      ivec2 id = b + ivec2(i, j);
      vec2 r = pke_hash22(id + ivec2(int(salt), 0), u_seed);
      // Subtle animation: the strokes drift and wobble slowly over time.
      vec2 wob = vec2(pke_noise(vec2(t * 0.8, r.x * 40.0), u_seed), pke_noise(vec2(t * 0.8, r.y * 40.0 + 7.0), u_seed));
      vec2 ctr = (vec2(id) + 0.5 + (r - 0.5) * vec2(0.8, 0.5) + wob * vec2(0.15, 0.1)) * cs;
      vec2 d = q - ctr;
      float tilt = (pke_hash2(id + ivec2(int(salt) + 5, 9), u_seed) - 0.5) * 0.12;
      d = vec2(d.x, d.y - d.x * tilt);
      float l = hl * (0.7 + 0.3 * pke_hash2(id + ivec2(int(salt) + 3, 1), u_seed));
      float u = clamp(d.x, -l, l);
      float dist = length(d - vec2(u, 0.0));
      float taper = 1.0 - 0.5 * smoothstep(0.6, 1.0, abs(d.x) / l);
      cov = max(cov, 1.0 - smoothstep(hw * taper - soft, hw * taper + soft, dist));
    }
  return cov;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 pre = fx_unpremultiply(texture(u_pre, v_uv));
  vec3 sc = pke_posterizeRgb(pre.rgb, u_posterizeAmount, u_posterizeSmooth, vec3(u_posterizePhase));
  float L = fx_luma(sc);
  vec2 p = pke_boxPx() - vec2(u_strokeShift.x, -u_strokeShift.y) * u_box.z;
  float m = max(u_mixThreshold, 1.0e-4);
  float td = u_thresholdDarks + u_thresholdsAdd, tm = u_thresholdMids + u_thresholdsAdd, tb = u_thresholdBrights + u_thresholdsAdd;
  float s1 = strokes(p, u_strokeAngle, 0.0);
  float s2 = strokes(p, u_strokeAngle + 90.0, 101.0);
  float c1 = s1;
  float c2 = max(s1, s2);
  float c3 = max(c2, max(strokes(p, u_strokeAngle, 211.0), strokes(p, u_strokeAngle + 90.0, 307.0)));
  float cov = mix(c3, mix(c2, mix(c1, 0.0, smoothstep(tb - m, tb + m, L)), smoothstep(tm - m, tm + m, L)), smoothstep(td - m, td + m, L));
  float alphaCut = mix(1.0, pre.a, u_useSourceAlpha);
  cov *= alphaCut;
  vec3 strokeCol = mix(u_strokeColor.rgb, sc, u_strokesUseSource);
  vec3 bg = u_backStyle == 0 ? sc : u_solidColor.rgb;
  vec3 col = mix(bg, strokeCol, cov);
  if (u_edgeStrength > 0.0) {
    float tap = max(u_edgeWidth * pke_unit(), 1.0);
    float e = length(pke_sobelLuma(u_pre, v_uv, vec2(tap) / u_canvasSize)) * 2.0;
    float coarse = length(pke_sobelLuma(u_pre, v_uv, vec2(tap * 3.0) / u_canvasSize)) * 2.0;
    e *= smoothstep(0.0, max(u_suppressSmallEdges, 1.0e-3) * 0.3, coarse);
    float ew = 0.15 / (1.0 + u_edgeSharpen * 3.0);
    float edge = clamp(smoothstep(u_edgeThreshold * 0.4, u_edgeThreshold * 0.4 + ew, e) * u_edgeStrength, 0.0, 1.0);
    col = mix(col, u_edgeColor.rgb, edge * alphaCut);
  }
  col = pke_colorCorrect(col, u_saturation, u_scaleLights, u_offsetDarks, u_tintLights.rgb, u_tintDarks.rgb);
  float a = mix(1.0, src.a, u_useSourceAlpha);
  fragColor = fx_mixOriginal(vec4(clamp(col, 0.0, 1.0) * a, a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

/** Cartoon outline passes: `eblur` (Edge Width), `edges` (strength − threshold), `edgesWide` (for suppression). */
function cartoonEdgePasses(p: EffectParams, ctx: FxPlanContext): ShaderPass[] {
	return [
		...blurPasses('source', 'eblur', sUnitsPx(p.edgeWidth, ctx)),
		{
			output: 'edges',
			include: [PKE_SOBEL],
			frag: /* glsl */ `
void main() {
  float e = length(pke_sobelLuma(u_eblur, v_uv, u_texel)) * 2.0 * u_edgeStrength;
  fragColor = vec4(vec3(clamp(e - u_edgeThreshold, 0.0, 1.0)), 1.0);
}`,
		},
		...blurPasses('edges', 'edgesWide', Math.max(2, ctx.width * ctx.pxScale * 0.006)),
	];
}

const CARTOON_GLSL: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/cartoon',
	deps: [PKE_TONE],
	source: /* glsl */ `
// The outline amount at this pixel (Suppress Small Edges: isolated short edges fade; Edge Sharpen: harder sides).
float cartoon_edge() {
  float e = texture(u_edges, v_uv).r;
  float wide = texture(u_edgesWide, v_uv).r;
  e *= smoothstep(0.0, max(u_suppressSmallEdges, 1.0e-3) * 0.12, wide);
  float k = 0.5 / (1.0 + u_edgeSharpen * 4.0);
  return mix(e, smoothstep(0.5 - k, 0.5 + k, e), min(u_edgeSharpen, 1.0));
}
vec3 cartoon_finish(vec3 c) {
  c = pke_posterizeRgb(c, u_posterizeAmount * 0.5, u_posterizeSmooth, vec3(u_posterizePhase));
  return pke_colorCorrect(c, u_saturation, u_scaleLights, u_offsetDarks, u_tintLights.rgb, u_tintDarks.rgb);
}
`,
};

export const S_CARTOON = defineShaderEffect({
	id: 'jasper.s.cartoon',
	label: 'S_Cartoon',
	category: 'Stylize',
	bin,
	description:
		'A cartoon look: new outlines drawn along the edges, smoothed flat colours between them, optionally posterized into fewer colours.',
	keywords: ['cartoon', 'comic', 'toon', 'cel', 'outline', 'anime', 'sapphire'],
	params: [
		...edgeParams(),
		sNum('smooth', 'Smooth', 0.1, { min: 0, softMax: 2 }),
		...posterizeParams(),
		saturationP(-2, 10),
		scaleLightsP(),
		tintLightsP(),
		tintDarksP(),
		offsetDarksP(),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			...blurPasses('source', 'flat', sUnitsPx(p.smooth, ctx) * 4),
			...cartoonEdgePasses(p, ctx),
			{
				include: [CARTOON_GLSL, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 sm = fx_unpremultiply(texture(u_flat, v_uv));
  vec3 c = cartoon_finish(sm.rgb);
  c = mix(c, u_edgeColor.rgb, clamp(cartoon_edge(), 0.0, 1.0));
  fragColor = fx_mixOriginal(vec4(clamp(c, 0.0, 1.0) * src.a, src.a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_CARTOON_PAINT = defineShaderEffect({
	id: 'jasper.s.cartoon-paint',
	label: 'S_CartoonPaint',
	category: 'Stylize',
	bin,
	description:
		'A cartoon look with painted fills: outlines drawn along the edges, the areas between them painted with brush strokes that follow the contours.',
	keywords: ['cartoon', 'paint', 'comic', 'outline', 'brush', 'strokes', 'sapphire'],
	expensive: true,
	params: [
		...edgeParams(),
		sNum('frequency', 'Frequency', 50, { min: 0.3, softMax: 200, step: 0.1 }),
		sNum('strokeLength', 'Stroke Length', 2, { softMin: -6, softMax: 6, step: 0.01 }),
		sNum('strokeAlign', 'Stroke Align', 0.2, { min: 0, softMax: 2, step: 0.01 }),
		sNum('smoothColors', 'Smooth Colors', 0, { min: 0, softMax: 2 }),
		seedParam(),
		jitterParam(),
		...posterizeParams(),
		saturationP(-2, 10),
		scaleLightsP(),
		offsetDarksP(),
		tintLightsP(),
		tintDarksP(),
		mixWithOriginalParam(),
	],
	gpu: {
		passes: (p, ctx) => {
			const cell = strokeCellPx(p.frequency, ctx);
			return [
				...blurPasses('source', 'smooth', sUnitsPx(p.smoothColors, ctx)),
				...orientPasses(cell, p.strokeAlign),
				{
					output: 'paint',
					include: [PNT_AUTOPAINT],
					frag: /* glsl */ `
void main() {
  float cell = u_box.z / max(u_frequency, 0.3);
  fragColor = ap_paint(pke_boxPx(), cell, u_strokeLength, 0, pke_seed(u_jitterFrames));
}`,
				},
				...cartoonEdgePasses(p, ctx),
				{
					include: [CARTOON_GLSL, GLSL_COMPOSITE],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 pt = fx_unpremultiply(texture(u_paint, v_uv));
  vec3 c = cartoon_finish(pt.rgb);
  c = mix(c, u_edgeColor.rgb, clamp(cartoon_edge(), 0.0, 1.0));
  fragColor = fx_mixOriginal(vec4(clamp(c, 0.0, 1.0) * src.a, src.a), src, u_mixWithOriginal);
}`,
				},
			];
		},
	},
});

export const S_POSTERIZE = defineShaderEffect({
	id: 'jasper.s.posterize',
	label: 'S_Posterize',
	category: 'Stylize',
	bin,
	description:
		'Limits the number of colours: detail and noise become flat areas of solid colour with smoothed boundaries (luma only, or per RGB channel).',
	keywords: ['posterize', 'posterise', 'levels', 'flat', 'cel', 'reduce colors', 'sapphire'],
	params: [
		sNum('amount', 'Amount', 0.1, { min: 0, max: 1, step: 0.001 }),
		sNum('preserveChroma', 'Preserve Chroma', 1, { min: 0, max: 1, step: 0.01 }),
		sNum('smoothEdges', 'Smooth Edges', 0.1, { min: 0, max: 1, step: 0.001 }),
		sNum('smoothSource', 'Smooth Source', 0.008, { min: 0, softMax: 1 }),
		sNum('colorPhase', 'Color Phase', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('phaseRed', 'Phase Red', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('phaseGreen', 'Phase Green', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('phaseBlue', 'Phase Blue', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		scaleLightsP(),
		offsetDarksP({ min: -8, max: 2 }),
		saturationP(-2, 8),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth', sUnitsPx(p.smoothSource, ctx)),
			{
				include: [PKE_TONE, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 sm = fx_unpremultiply(texture(u_smooth, v_uv));
  vec3 lumaPost = pke_posterizeLuma(sm.rgb, u_amount, u_smoothEdges, u_colorPhase);
  vec3 rgbPost = pke_posterizeRgb(sm.rgb, u_amount, u_smoothEdges, vec3(u_colorPhase) + vec3(u_phaseRed, u_phaseGreen, u_phaseBlue));
  vec3 c = mix(rgbPost, lumaPost, clamp(u_preserveChroma, 0.0, 1.0));
  c = pke_colorCorrect(c, u_saturation, u_scaleLights, u_offsetDarks, vec3(1.0), vec3(0.0));
  fragColor = fx_mixOriginal(vec4(clamp(c, 0.0, 1.0) * src.a, src.a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const PAINT_EFFECTS: readonly EffectSpec[] = [
	S_AUTO_PAINT,
	S_SKETCH,
	S_ETCHING,
	S_BRUSH_OIL,
	S_BRUSH_CHALK,
	S_CROSSHATCH,
	S_CARTOON,
	S_CARTOON_PAINT,
	S_POSTERIZE,
];

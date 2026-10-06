// Sapphire Render ▸ gradients, grid, shape: S_Gradient (linear), S_GradientMulti (up to six coloured points),
// S_GradientRadial (elliptical), S_Grid (a perspective grid of lines) and S_Shape (polygons, stars, flowers, swirls).
// Single-pass generators combined with the source by their Combine popup; time-invariant (no randomness except the
// static anti-banding noise).
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { fxParam, sapphireCommonParams } from '../params.ts';
import {
	type CombineOption,
	combineParam,
	combineUniforms,
	GLSL_SRT_COMMON,
	int,
	n,
	outputOpacityParam,
	pictureCombine,
	rgb,
} from './common.ts';

const GRAD_COMBINE = pictureCombine('Grad');

const brightnessNoise = () => [
	n('brightness', 'Brightness', 1, 0, undefined, { softMax: 4, step: 0.01 }),
	n('addNoise', 'Add Noise', 0, 0, undefined, { softMax: 0.2, step: 0.001 }),
	n('smoothCurve', 'Smooth Curve', 0, 0, 1, { step: 0.01 }),
];
const gradTail = () => [
	n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
	combineParam(GRAD_COMBINE, 'only'),
	outputOpacityParam(),
	...sapphireCommonParams(),
];

/** GLSL: shared finish of the gradient generators (noise, brightness, combine, Show/Mix). */
const GRAD_FINISH = /* glsl */ `
vec4 grad_finish(vec3 c) {
  vec4 src = texture(u_source, v_uv);
  float nz = (fx_hash2(ivec2(floor(srt_here())), u_seed) - 0.5) * u_addNoise;
  c = max(c * u_brightness + nz, vec3(0.0));
  vec4 res = srt_picture(u_combineOp, src, c, 1.0, u_bgBrightness, u_outputOpacity == 0);
  return fx_finish(res, src, fx_luma(clamp(c, 0.0, 1.0)), u_mixWithOriginal, u_show);
}
float grad_curve(float t) { return mix(t, t * t * (3.0 - 2.0 * t), u_smoothCurve); }
`;

export const S_GRADIENT = defineShaderEffect({
	id: 'jasper.s.gradient',
	label: 'S_Gradient',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'A smooth two-colour gradient between Start and End points, optionally combined with the clip (Mult, Add, Screen, Difference, Overlay).',
	keywords: ['gradient', 'ramp', 'linear', 'color', 'fill'],
	params: [
		fxParam.point('start', 'Start', [0.5, -0.03]),
		fxParam.point('end', 'End', [0.5, 1.03]),
		rgb('startColor', 'Start Color', [1, 1, 1]),
		rgb('endColor', 'End Color', [0, 0, 0]),
		fxParam.toggle('swapColors', 'Swap Colors', false),
		...brightnessNoise(),
		...gradTail(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		uniforms: (p) => combineUniforms(p, GRAD_COMBINE, 'only'),
		passes: [
			{
				include: [GLSL_SRT_COMMON, GLSL_HASH, GLSL_COMPOSITE],
				frag: /* glsl */ `
${GRAD_FINISH}
void main() {
  vec2 a = srt_pt(u_start), b = srt_pt(u_end);
  vec2 d = b - a;
  float t = clamp(dot(srt_here() - a, d) / max(dot(d, d), 1.0e-6), 0.0, 1.0);
  t = grad_curve(t);
  vec3 c0 = u_swapColors ? u_endColor.rgb : u_startColor.rgb;
  vec3 c1 = u_swapColors ? u_startColor.rgb : u_endColor.rgb;
  fragColor = grad_finish(mix(c0, c1, t));
}`,
			},
		],
	},
});

const MULTI_DEFAULTS: { color: [number, number, number]; point: [number, number]; on: boolean }[] = [
	{ color: [1, 0, 0], point: [0.014, 1.14], on: true },
	{ color: [0, 1, 0], point: [0.014, -0.12], on: true },
	{ color: [0, 0, 1], point: [0.986, -0.12], on: true },
	{ color: [1, 1, 1], point: [0.986, 1.14], on: false },
	{ color: [1, 1, 0], point: [0.417, 0.5], on: false },
	{ color: [0, 1, 1], point: [0.583, 0.5], on: false },
];

export const S_GRADIENT_MULTI = defineShaderEffect({
	id: 'jasper.s.gradient-multi',
	label: 'S_GradientMulti',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'A smooth multi-colour gradient from up to six coloured control points (each with its own softness and size), optionally combined with the clip.',
	keywords: ['gradient', 'multi', 'four color', 'corner', 'ramp', 'color'],
	params: [
		n('softness', 'Softness', 1, 0.01, undefined, { softMax: 5, step: 0.01 }),
		n('softnessFalloff', 'Softness Falloff', 0, 0, undefined, { softMax: 5, step: 0.01 }),
		...MULTI_DEFAULTS.flatMap((d, i) => [
			fxParam.toggle(`point${i + 1}Enable`, `Point ${i + 1} Enable`, d.on),
			rgb(`color${i + 1}`, `Color ${i + 1}`, d.color),
			fxParam.point(`point${i + 1}`, `Point ${i + 1}`, d.point),
			n(`softness${i + 1}`, `Softness ${i + 1}`, 1, 0.1, undefined, { softMax: 5, step: 0.01 }),
			n(`size${i + 1}`, `Size ${i + 1}`, 1, 0.1, undefined, { softMax: 5, step: 0.01 }),
		]),
		combineParam(GRAD_COMBINE, 'only'),
		n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		outputOpacityParam(),
		...sapphireCommonParams(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		uniforms: (p) => combineUniforms(p, GRAD_COMBINE, 'only'),
		passes: [
			{
				include: [GLSL_SRT_COMMON, GLSL_HASH, GLSL_COMPOSITE],
				frag: /* glsl */ `
const float u_brightness = 1.0;
const float u_addNoise = 0.0;
const float u_smoothCurve = 0.0;
${GRAD_FINISH}
// Soft nearest-colour blend: weights exp(−d/size / softness) (a soft Voronoi), the softness shrinking with the
// distance by Softness Falloff.
void gm_add(inout vec4 acc, inout float dmin, bool on, vec3 col, vec2 pt, float soft, float size, vec2 p, int pass) {
  if (!on) return;
  float d = distance(p, srt_pt(pt)) / srt_unit() / max(size, 0.1);
  if (pass == 0) { dmin = min(dmin, d); return; }
  float s = max(u_softness * soft, 0.01) * 0.35 / (1.0 + u_softnessFalloff * d);
  float w = exp(-(d - dmin) / s);
  acc += vec4(col * w, w);
}
void main() {
  vec2 p = srt_here();
  vec4 acc = vec4(0.0);
  float dmin = 1.0e9;
  for (int pass = 0; pass < 2; pass++) {
    gm_add(acc, dmin, u_point1Enable, u_color1.rgb, u_point1, u_softness1, u_size1, p, pass);
    gm_add(acc, dmin, u_point2Enable, u_color2.rgb, u_point2, u_softness2, u_size2, p, pass);
    gm_add(acc, dmin, u_point3Enable, u_color3.rgb, u_point3, u_softness3, u_size3, p, pass);
    gm_add(acc, dmin, u_point4Enable, u_color4.rgb, u_point4, u_softness4, u_size4, p, pass);
    gm_add(acc, dmin, u_point5Enable, u_color5.rgb, u_point5, u_softness5, u_size5, p, pass);
    gm_add(acc, dmin, u_point6Enable, u_color6.rgb, u_point6, u_softness6, u_size6, p, pass);
  }
  vec3 c = acc.w > 0.0 ? acc.rgb / acc.w : vec3(0.0);
  fragColor = grad_finish(c);
}`,
			},
		],
	},
});

export const S_GRADIENT_RADIAL = defineShaderEffect({
	id: 'jasper.s.gradient-radial',
	label: 'S_GradientRadial',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'A smooth radial gradient in an ellipse between an Inner and an Outer Radius around a Center, optionally combined with the clip.',
	keywords: ['gradient', 'radial', 'ellipse', 'circle', 'vignette', 'ramp'],
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		n('innerRadius', 'Inner Radius', 0.14, 0, undefined, { softMax: 3, step: 0.001 }),
		n('outerRadius', 'Outer Radius', 1, 0, undefined, { softMax: 3, step: 0.001 }),
		n('relHeight', 'Rel Height', 0.75, 0.1, undefined, { softMax: 4, step: 0.01 }),
		n('relWidth', 'Rel Width', 1, 0.1, undefined, { softMax: 4, step: 0.01 }),
		fxParam.angle('rotate', 'Rotate', 0),
		rgb('innerColor', 'Inner Color', [1, 1, 1]),
		rgb('outerColor', 'Outer Color', [0, 0, 0]),
		fxParam.toggle('swapColors', 'Swap Colors', false),
		...brightnessNoise(),
		...gradTail(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		uniforms: (p) => combineUniforms(p, GRAD_COMBINE, 'only'),
		passes: [
			{
				include: [GLSL_SRT_COMMON, GLSL_HASH, GLSL_COMPOSITE],
				frag: /* glsl */ `
${GRAD_FINISH}
void main() {
  vec2 q = srt_rot(srt_here() - srt_pt(u_center), -radians(u_rotate)) / srt_unit();
  q /= vec2(max(u_relWidth, 0.1), max(u_relHeight, 0.1));
  float d = length(q);
  float t = clamp((d - u_innerRadius) / max(u_outerRadius - u_innerRadius, 1.0e-4), 0.0, 1.0);
  t = grad_curve(t);
  vec3 c0 = u_swapColors ? u_outerColor.rgb : u_innerColor.rgb;
  vec3 c1 = u_swapColors ? u_innerColor.rgb : u_outerColor.rgb;
  fragColor = grad_finish(mix(c0, c1, t));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_Grid

const GRID_COMBINE: CombineOption[] = [
	{ value: 'over', label: 'Over', op: 'over' },
	{ value: 'exclusion', label: 'Exclusion', op: 'exclusion' },
	{ value: 'gridOnly', label: 'Grid Only', op: 'only' },
];

export const S_GRID = defineShaderEffect({
	id: 'jasper.s.grid',
	label: 'S_Grid',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'A grid of lines (with thicker major lines) drawn over the clip; Latitude, Swing and Roll rotate it in 3D, Z Dist and Tele Lens Width zoom it.',
	keywords: ['grid', 'lines', 'graph paper', 'perspective', 'floor', 'tron'],
	params: [
		fxParam.vec2('boxes', 'Boxes', [24, 16], { min: 1, step: 1, softMax: 200 }),
		n('gridSize', 'Grid Size', 1, 0, undefined, { softMax: 4, step: 0.001 }),
		n('gridSizeX', 'Grid Size X', 1, 0, undefined, { softMax: 4, step: 0.001 }),
		n('gridSizeY', 'Grid Size Y', 0.75, 0, undefined, { softMax: 4, step: 0.001 }),
		fxParam.vec2('shift', 'Shift', [0, 0], { step: 0.001, softMin: -2, softMax: 2 }),
		n('lineWidth', 'Line Width', 1.16, 0, undefined, { softMax: 10, step: 0.01 }),
		n('hLineRelWidth', 'H Line Rel Width', 1, 0, undefined, { softMax: 5, step: 0.01 }),
		n('vLineRelWidth', 'V Line Rel Width', 1, 0, undefined, { softMax: 5, step: 0.01 }),
		int('majorLineSpacing', 'Major Line Spacing', 4, 0, undefined, 20),
		n('majorLineWidth', 'Major Line Width', 2.5, 1, undefined, { softMax: 10, step: 0.01 }),
		n('brightness', 'Brightness', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		rgb('color', 'Color', [1, 1, 1]),
		n('gridOpacity', 'Grid Opacity', 1, 0, 1, { step: 0.01 }),
		n('latitude', 'Latitude', 0, -89, 89, { step: 0.1, unit: 'deg' }),
		fxParam.angle('swing', 'Swing', 0),
		fxParam.angle('roll', 'Roll', 0),
		n('zDist', 'Z Dist', 1, 0.01, undefined, { softMax: 10, step: 0.001 }),
		n('teleLensWidth', 'Tele Lens Width', 1, 0.2, 3, { step: 0.01 }),
		n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		combineParam(GRID_COMBINE, 'over'),
		...sapphireCommonParams(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		uniforms: (p) => combineUniforms(p, GRID_COMBINE, 'over'),
		passes: [
			{
				include: [GLSL_SRT_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
// Coverage of the lines at grid coordinate g (cells), line half widths w (cells), pixel footprint fw (cells).
float grid_lines(float g, float w, float fw, float boxes) {
  if (g < -w - fw || g > boxes + w + fw) return 0.0;
  float d = abs(g - floor(g + 0.5));
  float aa = max(fw, 1.0e-5);
  float we = max(w, 0.5 * aa);
  return clamp((we - d) / aa + 0.5, 0.0, 1.0) * (w / we);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 q = srt_sapphire(srt_here());
  q = srt_rot(q, radians(u_roll));
  float lat = radians(u_latitude);
  // camera at the origin looking along +z; the grid plane passes through (0, 0, zDist), tilted by Latitude
  vec3 ray = vec3(q, u_teleLensWidth);
  vec3 nrm = vec3(0.0, sin(lat), cos(lat));
  vec3 ax = vec3(1.0, 0.0, 0.0);
  vec3 ay = vec3(0.0, cos(lat), -sin(lat));
  float denom = dot(ray, nrm);
  float cov = 0.0;
  if (denom > 1.0e-5) {
    float lam = u_zDist * u_teleLensWidth * nrm.z / denom;
    vec3 hit = ray * lam - vec3(0.0, 0.0, u_zDist * u_teleLensWidth);
    vec2 pl = vec2(dot(hit, ax), dot(hit, ay)) / u_teleLensWidth;
    pl = srt_rot(pl, -radians(u_swing)) - u_shift;
    vec2 ext = vec2(u_gridSize * u_gridSizeX, u_gridSize * u_gridSizeY);
    vec2 boxes = max(floor(u_boxes + 0.5), vec2(1.0));
    vec2 g = (pl / max(ext, vec2(1.0e-4)) * 0.5 + 0.5) * boxes;
    g.y = boxes.y - g.y;
    vec2 fw = fwidth(g);
    vec2 cell = 2.0 * max(ext, vec2(1.0e-4)) / boxes;
    // line half widths in cells (plane units: Line Width × 0.0015 units)
    vec2 w = vec2(u_vLineRelWidth, u_hLineRelWidth) * u_lineWidth * 0.0015 / cell;
    int major = int(floor(u_majorLineSpacing + 0.5));
    vec2 idx = floor(g + 0.5);
    vec2 isMajor = major > 0 ? vec2(mod(idx.x, float(major)) == 0.0 ? 1.0 : 0.0, mod(idx.y, float(major)) == 0.0 ? 1.0 : 0.0) : vec2(0.0);
    w *= mix(vec2(1.0), vec2(u_majorLineWidth), isMajor);
    bool inX = g.x > -w.x - fw.x && g.x < boxes.x + w.x + fw.x;
    bool inY = g.y > -w.y - fw.y && g.y < boxes.y + w.y + fw.y;
    float cx = inY ? grid_lines(g.x, w.x, fw.x, boxes.x) : 0.0;
    float cy = inX ? grid_lines(g.y, w.y, fw.y, boxes.y) : 0.0;
    cov = max(cx, cy);
  }
  cov *= u_gridOpacity;
  vec3 col = u_color.rgb * u_brightness;
  vec4 res = srt_picture(u_combineOp, src, col, cov, u_bgBrightness, false);
  if (u_combineOp == SRT_ONLY) res = vec4(col * cov, 1.0) * src.a;
  fragColor = fx_finish(res, src, cov, u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_Shape

const SHAPE_COMBINE: CombineOption[] = [
	{ value: 'shapeOnly', label: 'Shape Only', op: 'only' },
	{ value: 'mult', label: 'Mult', op: 'mult' },
	{ value: 'add', label: 'Add', op: 'add' },
	{ value: 'screen', label: 'Screen', op: 'screen' },
	{ value: 'difference', label: 'Difference', op: 'difference' },
	{ value: 'overlay', label: 'Overlay', op: 'overlay' },
	{ value: 'over', label: 'Over', op: 'over' },
];

export const S_SHAPE = defineShaderEffect({
	id: 'jasper.s.shape',
	label: 'S_Shape',
	category: 'Generate',
	bin: SAPPHIRE_BINS.render,
	description:
		'Draws a shape — polygons, circles, stars, flowers and swirled starfish — from Points, Pointiness, Roundness and Swirl, combined with the clip.',
	keywords: ['shape', 'polygon', 'star', 'circle', 'flower', 'ellipse', 'mask'],
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		n('size', 'Size', 0.5, 0, undefined, { softMax: 3, step: 0.001 }),
		n('relWidth', 'Rel Width', 1.4, 0, undefined, { softMax: 4, step: 0.01 }),
		n('relHeight', 'Rel Height', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		int('points', 'Points', 5, 3, 500, 24),
		n('pointiness', 'Pointiness', 0, undefined, undefined, { softMin: -1, softMax: 5, step: 0.01 }),
		n('roundness', 'Roundness', 1, 0, 1, { step: 0.01 }),
		n('swirl', 'Swirl', 0, -5, 5, { step: 0.01 }),
		fxParam.angle('rotate', 'Rotate', 0),
		fxParam.angle('rotatePreScale', 'Rotate Pre Scale', 0),
		n('blur', 'Blur', 0, 0, undefined, { softMax: 1, step: 0.001 }),
		n('brightness1', 'Brightness1', 1, 0, undefined, { softMax: 4, step: 0.01 }),
		rgb('color1', 'Color1', [1, 1, 1]),
		rgb('color0', 'Color0', [0, 0, 0]),
		n('offset0', 'Offset0', 0, undefined, undefined, { softMin: -1, softMax: 1, step: 0.01 }),
		n('bgBrightness', 'Bg Brightness', 1, 0, undefined, { softMax: 2, step: 0.01 }),
		combineParam(SHAPE_COMBINE, 'over'),
		...sapphireCommonParams(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		uniforms: (p) => combineUniforms(p, SHAPE_COMBINE, 'over'),
		passes: [
			{
				include: [GLSL_SRT_COMMON, GLSL_COMPOSITE],
				frag: /* glsl */ `
// Radius (relative) of the shape outline in direction theta: a polygon with N points (vertices at R = 1),
// rounded towards a circle by Roundness, pinched (stars) or bulged (flowers) by Pointiness.
float shape_radius(float th, float N) {
  float a = SRT_TAU / N;
  float ph = mod(th + 0.5 * SRT_PI + 0.5 * a, a) - 0.5 * a;
  float t = abs(ph) / (0.5 * a);
  float poly = cos(0.5 * a) / cos(0.5 * a - abs(ph));
  float r = mix(poly, 1.0, clamp(u_roundness, 0.0, 1.0));
  return r / max(1.0 + u_pointiness * t, 0.05);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  float U = srt_unit();
  float N = clamp(floor(u_points + 0.5), 3.0, 500.0);
  vec2 q = srt_rot(srt_here() - srt_pt(u_center), -radians(u_rotate));
  vec2 sc = max(u_size * U * vec2(u_relWidth, u_relHeight) * 0.5, vec2(1.0e-3));
  q = srt_rot(q / sc, -radians(u_rotatePreScale));
  float r = length(q);
  float th = atan(q.y, q.x) - u_swirl * r;
  float R = shape_radius(th, N);
  // approximate distance in px to the outline (scaled by the smaller axis)
  float d = (r - R) * min(sc.x, sc.y) / max(1.0, 0.5 + 0.5 * abs(u_swirl) * r);
  float soft = u_blur * U * 0.5 + 0.75;
  float cov = smoothstep(soft, -soft, d);
  vec3 c1 = u_color1.rgb * u_brightness1;
  vec3 c0 = u_color0.rgb + u_offset0;
  vec4 res = u_combineOp == SRT_OVER
    ? srt_picture(SRT_OVER, src, c1, cov, u_bgBrightness, false)
    : srt_picture(u_combineOp, src, mix(c0, c1, cov), 1.0, u_bgBrightness, false);
  fragColor = fx_finish(res, src, cov, u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

export const SAPPHIRE_GRADIENT_SHAPE_EFFECTS: readonly EffectSpec[] = [
	S_GRADIENT,
	S_GRADIENT_MULTI,
	S_GRADIENT_RADIAL,
	S_GRID,
	S_SHAPE,
];

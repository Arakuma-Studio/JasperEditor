// "Sapphire other stylize" family — S_PrismLens: the picture as seen through prismatic lens facets: polygon/ellipse
// windows (one, a line of copies, or rings of copies) each showing a perspective-tilted, colour-corrected reflection
// of the source with chromatic dispersion, tinted by a three-point gradient and combined with the source.
// Parameters follow Boris FX's public Sapphire documentation (AE/Premiere host).
// Approximations / omissions: no separate Reflection input (the source reflects itself), no Mask "Shape" use, and
// the Glow (Glow Brightness/Threshold/Width…) and Lights (lens-flare hot spots) groups are not implemented.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_SAMPLE, GLSL_UV } from '../glsl/sample.ts';
import { fxParam, sapphireCommonParams } from '../params.ts';
import {
	blurPasses,
	GLSL_SSO_COMMON,
	GLSL_SSO_MASK,
	maskParams,
	sapphireBlurPx,
	sapphirePoint,
	sInt,
	sNum,
} from './common.ts';

const fade = (name: string, label: string) => sNum(name, label, 0, { min: 0, max: 1 });
const sizeFade = (name: string, label: string) => sNum(name, label, 0, { min: -3, max: 3 });

export const S_PRISM_LENS: EffectSpec = defineShaderEffect({
	id: 'jasper.s.prism-lens',
	label: 'S_PrismLens',
	category: 'Stylize',
	bin: SAPPHIRE_BINS.stylize,
	description:
		'Emulates shooting through a prismatic lens: polygon or ellipse facets (one, a line or rings of copies) show tilted, chromatically dispersed reflections of the picture, tinted by a three-point gradient. Sizes in Sapphire units (1.0 = half the width).',
	keywords: [
		'prism',
		'lens',
		'refraction',
		'kaleidoscope',
		'chromatic aberration',
		'in-camera',
		'reflection',
	],
	expensive: true,
	params: [
		fxParam.choice(
			'mode',
			'Mode',
			['single', 'linear', 'radial'],
			['PrismLensSingle', 'PrismLensLinear', 'PrismLensRadial'],
			'single',
		),
		fxParam.choice(
			'combineWithSource',
			'Combine With Source',
			['composite', 'add', 'screen', 'reflectionsOnly'],
			['Composite', 'Add', 'Screen', 'Reflections Only'],
			'composite',
		),
		fxParam.choice('geometry', 'Geometry', ['polygon', 'ellipse'], ['Polygon', 'Ellipse'], 'polygon'),
		sInt('sides', 'Sides', 4, 3, 64, 12),
		sNum('size', 'Size', 0.724, { min: 0, softMax: 3 }),
		sNum('relWidth', 'Rel Width', 0.42, { min: 0.01, softMax: 3 }),
		fxParam.point('position', 'Position', sapphirePoint(0.227, -0.024)),
		fxParam.angle('rotate', 'Rotate', -33),
		sNum('softness', 'Softness', 0.2, { min: 0, softMax: 2 }),
		sInt('copies', 'Copies', 5, 1, 10),
		fxParam.angle('angle', 'Angle', 0),
		sNum('distance', 'Distance', 0.2, { min: 0.01, max: 1 }),
		sNum('startOffset', 'Start Offset', 0.2, { min: 0, max: 1 }),
		sNum('bias', 'Bias', 0, { min: -1, max: 1 }),
		fade('opacityFade', 'Opacity Fade'),
		sizeFade('sizeFade', 'Size Fade'),
		fxParam.toggle('reflectBothDirections', 'Reflect Both Directions', true),
		sInt('radialCopies', 'Radial Copies', 6, 1, 10),
		fxParam.angle('startAngle', 'Start Angle', 15),
		sNum('totalAngle', 'Total Angle', 360, { min: 0, max: 360, step: 0.1 }),
		sInt('rows', 'Rows', 1, 1, 3),
		sNum('rowDistance', 'Row Distance', 0.2, { min: 0, max: 1 }),
		sNum('rowStartOffset', 'Row Start Offset', 0.2, { min: 0, max: 1 }),
		fade('radialOpacityFade', 'Radial Opacity Fade'),
		sizeFade('radialSizeFade', 'Radial Size Fade'),
		fade('rowOpacityFade', 'Row Opacity Fade'),
		sizeFade('rowSizeFade', 'Row Size Fade'),
		sNum('reflectionOpacity', 'Reflection Opacity', 0.9, { min: 0, max: 1 }),
		fxParam.point('sourcePosition', 'Source Position', sapphirePoint(-0.128, 0.04)),
		sNum('sourceZDist', 'Source Z Dist', 1.05, { min: 0.01, softMax: 4 }),
		fxParam.angle('sourceRotate', 'Source Rotate', -2),
		fxParam.angle('sourceTilt', 'Source Tilt', -10),
		fxParam.angle('sourceSwivel', 'Source Swivel', -12),
		fxParam.toggle('flipHorizontal', 'Flip Horizontal', false),
		fxParam.toggle('flipVertical', 'Flip Vertical', false),
		sNum('blurSource', 'Blur Source', 0.0084, { min: 0, softMax: 0.5 }),
		sNum('sourceThreshold', 'Source Threshold', 0, { min: 0, softMax: 1 }),
		sNum('thresholdSoftness', 'Threshold Softness', 0.05, { min: 0, softMax: 1 }),
		fxParam.choice(
			'sourceWrap',
			'Source Wrap',
			['no', 'tile', 'reflect'],
			['No', 'Tile', 'Reflect'],
			'reflect',
		),
		sNum('ccMixWithSource', 'CC Mix With Source', 0, { min: 0, max: 1 }),
		sNum('ccBrightness', 'CC Brightness', 1, { min: 0, softMax: 4 }),
		sNum('saturation', 'Saturation', 1, { min: -2, max: 8, softMax: 4 }),
		sNum('hueShift', 'Hue Shift', 0, { softMin: -1, softMax: 1 }),
		sNum('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2, softMin: -1, softMax: 1 }),
		sNum('amount', 'Amount', 0.05, { min: 0, softMax: 0.5 }),
		sInt('chromaticSteps', 'Chromatic Steps', 12, 3, 100, 32),
		fxParam.vec2('chromaticShift', 'Chromatic Shift', [0, 0], { softMin: -0.5, softMax: 0.5, step: 0.001 }),
		fxParam.angle('chromaticRotate', 'Chromatic Rotate', 0),
		sNum('chromaticZDist', 'Chromatic Z Dist', 1, { min: 0.001, softMax: 4 }),
		fxParam.color('chromaticColor1', 'Chromatic Color1', [1, 0, 0, 1]),
		fxParam.color('chromaticColor2', 'Chromatic Color2', [0, 1, 0, 1]),
		fxParam.color('chromaticColor3', 'Chromatic Color3', [0, 0, 1, 1]),
		sNum('gradientOpacity', 'Gradient Opacity', 0.4, { min: 0, max: 1 }),
		fxParam.color('color1', 'Color 1', [1, 0, 0, 1]),
		fxParam.point('point1', 'Point 1', sapphirePoint(0.599, -0.526)),
		fxParam.color('color2', 'Color 2', [0, 1, 0, 1]),
		fxParam.point('point2', 'Point 2', sapphirePoint(-0.98, 0.529)),
		fxParam.color('color3', 'Color 3', [0, 0, 1, 1]),
		fxParam.point('point3', 'Point 3', sapphirePoint(0.958, 0.529)),
		fxParam.choice(
			'combine',
			'Combine',
			['gradOnly', 'mult', 'add', 'screen', 'difference', 'overlay'],
			['Grad Only', 'Mult', 'Add', 'Screen', 'Difference', 'Overlay'],
			'screen',
		),
		...sapphireCommonParams({ show: [{ value: 'reflections', label: 'All Reflections' }] }),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			...blurPasses({ input: 'source', output: 'refl', sigmaX: sapphireBlurPx(p.blurSource, ctx) }),
			{
				include: [GLSL_SSO_COMMON, GLSL_SSO_MASK, GLSL_UV, GLSL_SAMPLE, GLSL_BLEND],
				frag: PRISM_FRAG,
			},
		],
	},
});

const PRISM_FRAG = /* glsl */ `
const int PL_MAX_COPIES = 30;
// Copy k of the current Mode: centre (canvas px), size factor, opacity, extra rotation (radians). False = none.
bool pl_copy(int k, vec2 P, float unit, out vec2 c, out float sc, out float op, out float rot) {
  c = P; sc = 1.0; op = 1.0; rot = 0.0;
  if (u_mode == 0) return k == 0;
  if (u_mode == 1) {
    int n = int(clamp(u_copies, 1.0, 10.0));
    int sides = u_reflectBothDirections ? 2 : 1;
    if (k >= n * sides) return false;
    int j = k % n;
    float sgn = k < n ? 1.0 : -1.0;
    float off = u_startOffset + float(j) * u_distance * (1.0 + sgn * u_bias);
    c = P + sgn * fx_dir(u_angle) * off * unit;
    float f = float(j + 1) / float(n);
    sc = max(0.0, 1.0 - u_sizeFade * f);
    op = clamp(1.0 - u_opacityFade * f, 0.0, 1.0);
    return true;
  }
  int per = int(clamp(u_radialCopies, 1.0, 10.0));
  int rows = int(clamp(u_rows, 1.0, 3.0));
  if (k >= per * rows) return false;
  int row = k / per, i = k % per;
  float stepDeg = u_totalAngle >= 359.9 ? u_totalAngle / float(per) : u_totalAngle / float(max(per - 1, 1));
  float a = u_startAngle + float(i) * stepDeg;
  c = P + fx_dir(a) * (u_rowStartOffset + float(row) * u_rowDistance) * unit;
  float fi = per > 1 ? float(i) / float(per - 1) : 0.0;
  float fr = rows > 1 ? float(row) / float(rows - 1) : 0.0;
  sc = max(0.0, (1.0 - u_radialSizeFade * fi) * (1.0 - u_rowSizeFade * fr));
  op = clamp((1.0 - u_radialOpacityFade * fi) * (1.0 - u_rowOpacityFade * fr), 0.0, 1.0);
  rot = fx_deg(a);
  return true;
}
// Inside-ness of a facet (soft edge) for a local offset d in Sapphire units (rotated, not yet scaled).
float pl_shape(vec2 d, float sc) {
  float R = max(u_size * 0.5 * sc, 1.0e-4);
  d.x /= max(u_relWidth, 0.01);
  float f;
  if (u_geometry == 1) f = length(d) - R;
  else {
    float n = clamp(floor(u_sides + 0.5), 3.0, 64.0);
    float sector = 6.28318530718 / n;
    float a = atan(d.y, d.x) + 1.5707963;              // a vertex at the top
    f = cos(floor(0.5 + a / sector) * sector - a) * length(d) - R * cos(3.14159265359 / n);
  }
  float w = max(u_softness * R * 0.25, 1.5 / sso_unit());
  return 1.0 - smoothstep(-w, w, f);
}
// A plane through the image centre tilted (about x) and swivelled (about y), seen from a focal distance of 2 units.
vec2 pl_perspective(vec2 v) {
  float t = fx_deg(u_sourceTilt), s = fx_deg(u_sourceSwivel);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cos(t), sin(t), 0.0, -sin(t), cos(t));
  mat3 ry = mat3(cos(s), 0.0, -sin(s), 0.0, 1.0, 0.0, sin(s), 0.0, cos(s));
  mat3 r = ry * rx;
  vec3 n = r * vec3(0.0, 0.0, 1.0);
  vec3 dir = vec3(v, 2.0);
  float den = dot(n, dir);
  if (abs(den) < 1.0e-3) return vec2(1.0e3);
  vec3 hit = dir * (2.0 * n.z / den) - vec3(0.0, 0.0, 2.0);
  return (transpose(r) * hit).xy;
}
vec4 pl_sampleSource(vec2 v, float unit) {
  vec2 px = fx_uvOfLayerNorm(u_sourcePosition) * u_canvasSize + v * unit;
  vec2 n = (px - u_box.xy) / u_box.zw;
  int mode = u_sourceWrap == 0 ? FX_EDGE_TRANSPARENT : u_sourceWrap == 1 ? FX_EDGE_REPEAT : FX_EDGE_MIRROR;
  return fx_sampleLayer(u_refl, n, mode);
}
vec3 pl_spectrum(float t) {
  return t < 0.5 ? mix(u_chromaticColor1.rgb, u_chromaticColor2.rgb, t * 2.0)
                 : mix(u_chromaticColor2.rgb, u_chromaticColor3.rgb, t * 2.0 - 1.0);
}
// The reflection seen through a facet at local offset v (Sapphire units, facet-rotated): dispersion, CC, threshold.
vec4 pl_reflection(vec2 v, float unit) {
  v = pl_perspective(v);
  v = fx_rot(fx_deg(u_sourceRotate)) * v * u_sourceZDist;
  if (u_flipHorizontal) v.x = -v.x;
  if (u_flipVertical) v.y = -v.y;
  int steps = (u_amount <= 0.0 && dot(u_chromaticShift, u_chromaticShift) <= 0.0) ? 1 : int(clamp(u_chromaticSteps, 3.0, 32.0));
  vec2 shift = fx_rot(fx_deg(u_chromaticRotate)) * u_chromaticShift;
  vec3 sum = vec3(0.0), wsum = vec3(0.0);
  float a = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= steps) break;
    float t = steps == 1 ? 0.5 : float(i) / float(steps - 1);
    vec3 w = steps == 1 ? vec3(1.0) : pl_spectrum(t);
    vec2 vs = v * (1.0 + u_amount * (t - 0.5) * 2.0 / max(u_chromaticZDist, 0.001)) + shift * (t - 0.5);
    vec4 s = pl_sampleSource(vs, unit);
    sum += s.rgb * w; wsum += w; a += s.a;
  }
  vec4 r = vec4(sum / max(wsum, vec3(1.0e-4)), a / float(steps));
  vec3 raw = fx_unpremultiply(r).rgb;
  vec3 cc = fx_saturate(raw, u_saturation) * u_ccBrightness;
  if (u_hueShift != 0.0) cc = fx_hueShift(max(cc, 0.0), u_hueShift);
  cc = sso_offsetDarks(cc, u_offsetDarks);
  vec3 col = clamp(mix(cc, raw, u_ccMixWithSource), 0.0, 1.0);
  float th = smoothstep(u_sourceThreshold, u_sourceThreshold + max(u_thresholdSoftness, 1.0e-4), fx_luma(raw));
  if (u_sourceThreshold <= 0.0) th = 1.0;
  return vec4(col, r.a * th);                                  // straight colour, alpha
}
vec3 pl_gradient(vec2 px) {
  vec2 p1 = fx_uvOfLayerNorm(u_point1) * u_canvasSize, p2 = fx_uvOfLayerNorm(u_point2) * u_canvasSize, p3 = fx_uvOfLayerNorm(u_point3) * u_canvasSize;
  float w1 = 1.0 / (dot(px - p1, px - p1) + 1.0), w2 = 1.0 / (dot(px - p2, px - p2) + 1.0), w3 = 1.0 / (dot(px - p3, px - p3) + 1.0);
  return (u_color1.rgb * w1 + u_color2.rgb * w2 + u_color3.rgb * w3) / (w1 + w2 + w3);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  float unit = sso_unit();
  vec2 px = v_uv * u_canvasSize;
  vec2 P = fx_uvOfLayerNorm(u_position) * u_canvasSize;
  vec3 grad = pl_gradient(px);
  vec4 acc = vec4(0.0);
  float matte = 0.0;
  for (int k = 0; k < PL_MAX_COPIES; k++) {
    vec2 c; float sc, op, rot;
    if (!pl_copy(k, P, unit, c, sc, op, rot)) break;
    vec2 d = fx_rot(-(fx_deg(u_rotate) + rot)) * (px - c) / unit;
    float m = pl_shape(d, sc);
    if (m <= 0.0) continue;
    vec4 r = pl_reflection(fx_rot(-rot) * (px - c) / unit / max(sc, 0.05), unit);
    vec3 g = u_combine == 0 ? grad : u_combine == 1 ? r.rgb * grad : u_combine == 2 ? min(r.rgb + grad, 1.0)
           : u_combine == 3 ? fx_blendRgb(FX_BLEND_SCREEN, r.rgb, grad) : u_combine == 4 ? abs(r.rgb - grad)
           : fx_blendRgb(FX_BLEND_OVERLAY, r.rgb, grad);
    vec3 col = mix(r.rgb, g, clamp(u_gradientOpacity, 0.0, 1.0));
    float a = r.a * m * op * clamp(u_reflectionOpacity, 0.0, 1.0);
    acc = fx_over(vec4(col * a, a), acc);
    matte = max(matte, m * op);
  }
  if (u_show == 2) { fragColor = acc; return; }
  vec4 result = u_combineWithSource == 0 ? fx_over(acc, src)
              : u_combineWithSource == 1 ? vec4(min(src.rgb + acc.rgb, 1.0), max(src.a, acc.a))
              : u_combineWithSource == 2 ? fx_blend(FX_BLEND_SCREEN, src, acc, 1.0)
              : acc;
  fragColor = sso_finish(result, src, matte);
}`;

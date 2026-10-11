// Premiere Pro "Channel" video effects (fx family premiere-adjust-color-keying): Arithmetic, Blend, Calculations,
// Compound Arithmetic, Invert, Set Matte, Solid Composite. Second layers ("Blend With Layer", "Second Layer"…) are
// `media` params placed over the layer box (centred at native size or stretched, Premiere's "If Layer Sizes Differ").
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { blendModeParam, fxParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import { blendWithOriginalParam, GLSL_PACG, layerSizesParam, popup, slider } from './common.ts';

/** 8-bit integer channel maths (Arithmetic / Compound Arithmetic). */
const GLSL_PACG_INT8: GlslChunk = {
	name: 'pacg/int8',
	source: /* glsl */ `
uvec3 pacg_u8(vec3 c) { return uvec3(clamp(floor(c * 255.0 + 0.5), 0.0, 255.0)); }
`,
};

const ARITHMETIC_OPS: [string, string][] = [
	['and', 'And'],
	['or', 'Or'],
	['xor', 'Xor'],
	['add', 'Add'],
	['subtract', 'Subtract'],
	['difference', 'Difference'],
	['min', 'Min'],
	['max', 'Max'],
	['blockAbove', 'Block Above'],
	['blockBelow', 'Block Below'],
	['slice', 'Slice'],
	['multiply', 'Multiply'],
	['screen', 'Screen'],
];

export const ARITHMETIC = defineShaderEffect({
	id: 'jasper.arithmetic',
	label: 'Arithmetic',
	category: 'Channel',
	description:
		'Applies a simple maths or bitwise operation (And, Or, Add, Min, Slice, Screen…) between each channel and a value.',
	keywords: ['math', 'bitwise', 'channel', 'posterize', 'xor'],
	params: [
		popup('operator', 'Operator', ARITHMETIC_OPS, 'add'),
		slider('redValue', 'Red Value', 0, 0, 255, { step: 1 }),
		slider('greenValue', 'Green Value', 0, 0, 255, { step: 1 }),
		slider('blueValue', 'Blue Value', 0, 0, 255, { step: 1 }),
		fxParam.toggle('clipResultValues', 'Clip Result Values', true),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG, GLSL_PACG_INT8],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src) * 255.0;
  vec3 v = floor(vec3(u_redValue, u_greenValue, u_blueValue) + 0.5);
  uvec3 ci = pacg_u8(c / 255.0);
  uvec3 vi = uvec3(clamp(v, 0.0, 255.0));
  vec3 r;
  int op = u_operator;
  if (op == 0) r = vec3(ci & vi);
  else if (op == 1) r = vec3(ci | vi);
  else if (op == 2) r = vec3(ci ^ vi);
  else if (op == 3) r = c + v;
  else if (op == 4) r = c - v;
  else if (op == 5) r = abs(c - v);
  else if (op == 6) r = min(c, v);
  else if (op == 7) r = max(c, v);
  else if (op == 8) r = mix(c, vec3(0.0), vec3(greaterThan(c, v)));
  else if (op == 9) r = mix(c, vec3(0.0), vec3(lessThan(c, v)));
  else if (op == 10) r = mix(vec3(0.0), vec3(255.0), vec3(greaterThan(c, v)));
  else if (op == 11) r = c * v / 255.0;
  else r = 255.0 - (255.0 - c) * (255.0 - v) / 255.0;
  r = u_clipResultValues ? clamp(r, 0.0, 255.0) : mod(floor(r + 0.5), 256.0);
  fragColor = fx_premultiply(vec4(r / 255.0, src.a));
}`,
			},
		],
	},
});

export const BLEND = defineShaderEffect({
	id: 'jasper.blend',
	label: 'Blend',
	category: 'Channel',
	description:
		'Blends the clip with another layer: crossfade, take its colour or tint, or keep the darker / lighter pixels.',
	keywords: ['mix', 'crossfade', 'colorize', 'layer blend', 'darken', 'lighten'],
	params: [
		fxParam.media('blendWithLayer', 'Blend With Layer'),
		popup('mode', 'Mode', [
			['crossfade', 'Crossfade'],
			['colorOnly', 'Color Only'],
			['tintOnly', 'Tint Only'],
			['darkenOnly', 'Darken Only'],
			['lightenOnly', 'Lighten Only'],
		]),
		blendWithOriginalParam(),
		layerSizesParam('center'),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_blendWithLayer_size.x <= 0.0) { fragColor = src; return; }
  vec4 lay = pacg_media(u_blendWithLayer, u_blendWithLayer_size, u_layerSizes == 1);
  vec3 c = pacg_straight(src);
  vec3 l = pacg_straight(lay);
  vec4 r;
  if (u_mode == 0) {
    r = lay;
  } else if (u_mode == 1 || u_mode == 2) {
    // Colour of the layer (hue + saturation) at the clip's lightness; Tint Only only where the clip has colour.
    vec3 hc = fx_rgb2hsl(c);
    vec3 hl = fx_rgb2hsl(l);
    vec3 col = fx_hsl2rgb(vec3(hl.x, hl.y, hc.z));
    if (u_mode == 2) col = mix(c, col, clamp(hc.y * 4.0, 0.0, 1.0));
    col = mix(c, col, lay.a);
    r = fx_premultiply(vec4(col, src.a));
  } else {
    vec3 m = u_mode == 3 ? min(c, mix(vec3(1.0), l, lay.a)) : max(c, l * lay.a);
    r = fx_premultiply(vec4(m, src.a));
  }
  fragColor = mix(r, src, u_blendWithOriginal / 100.0);
}`,
			},
		],
	},
});

const CALC_CHANNELS: [string, string][] = [
	['rgba', 'RGBA'],
	['gray', 'Gray'],
	['red', 'Red'],
	['green', 'Green'],
	['blue', 'Blue'],
	['alpha', 'Alpha'],
];

export const CALCULATIONS = defineShaderEffect({
	id: 'jasper.calculations',
	label: 'Calculations',
	category: 'Channel',
	description:
		'Combines a channel of the clip with a channel of a second layer through a blending mode (Photoshop-style Calculations).',
	keywords: ['channel', 'blend mode', 'combine', 'composite', 'second layer'],
	params: [
		popup('inputChannel', 'Input Channel', CALC_CHANNELS, 'rgba', 'Input'),
		fxParam.toggle('invertInput', 'Invert Input', false, { group: 'Input' }),
		fxParam.media('secondLayer', 'Second Layer', ['image', 'video'], { group: 'Second Source' }),
		popup('secondLayerChannel', 'Second Layer Channel', CALC_CHANNELS, 'rgba', 'Second Source'),
		fxParam.percent('secondLayerOpacity', 'Second Layer Opacity', 100, { group: 'Second Source' }),
		fxParam.toggle('invertSecondLayer', 'Invert Second Layer', false, { group: 'Second Source' }),
		fxParam.toggle('stretchSecondLayer', 'Stretch Second Layer to Fit', true, { group: 'Second Source' }),
		blendModeParam('blendingMode', 'Blending Mode'),
		fxParam.toggle('preserveTransparency', 'Preserve Transparency', false),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PACG, GLSL_BLEND],
				frag: /* glsl */ `
// A channel view of a premultiplied picture (premultiplied out); inverting inverts the colour channels.
vec4 channelOf(vec4 p, int ch, bool inv) {
  vec3 c = pacg_straight(p);
  float a = p.a;
  if (ch == 1) c = vec3(fx_luma(c));
  else if (ch == 2) c = vec3(c.r);
  else if (ch == 3) c = vec3(c.g);
  else if (ch == 4) c = vec3(c.b);
  else if (ch == 5) { c = vec3(a); a = 1.0; }
  if (inv) c = 1.0 - c;
  return vec4(c * a, a);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 base = channelOf(src, u_inputChannel, u_invertInput);
  vec4 r = base;
  if (u_secondLayer_size.x > 0.0) {
    vec4 sec = pacg_media(u_secondLayer, u_secondLayer_size, u_stretchSecondLayer);
    vec4 top = channelOf(sec, u_secondLayerChannel, u_invertSecondLayer);
    r = fx_blend(u_blendingMode, base, top, u_secondLayerOpacity / 100.0);
  }
  if (u_preserveTransparency) r = vec4(pacg_straight(r) * src.a, src.a);
  fragColor = r;
}`,
			},
		],
	},
});

export const COMPOUND_ARITHMETIC = defineShaderEffect({
	id: 'jasper.compound-arithmetic',
	label: 'Compound Arithmetic',
	category: 'Channel',
	description:
		'Combines the clip with a second source layer channel by channel (Add, Subtract, Difference, And, Screen, Overlay…).',
	keywords: ['math', 'combine', 'second layer', 'difference', 'bitwise'],
	params: [
		fxParam.media('secondSourceLayer', 'Second Source Layer'),
		popup('operator', 'Operator', [
			['copy', 'Copy'],
			['add', 'Add'],
			['subtract', 'Subtract'],
			['multiply', 'Multiply'],
			['difference', 'Difference'],
			['and', 'And'],
			['or', 'Or'],
			['xor', 'Xor'],
			['lighten', 'Lighten'],
			['darken', 'Darken'],
			['min', 'Minimum'],
			['max', 'Maximum'],
			['screen', 'Screen'],
			['overlay', 'Overlay'],
			['hardLight', 'Hard Light'],
		]),
		popup('operateOnChannels', 'Operate on Channels', [
			['rgb', 'RGB'],
			['argb', 'ARGB'],
			['alpha', 'Alpha'],
		]),
		popup('overflowBehavior', 'Overflow Behavior', [
			['clip', 'Clip'],
			['wrap', 'Wrap'],
			['scale', 'Scale'],
		]),
		fxParam.toggle('stretchSecondSource', 'Stretch Second Source to Fit', true),
		blendWithOriginalParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PACG, GLSL_PACG_INT8, GLSL_BLEND],
				frag: /* glsl */ `
vec4 op4(int op, vec4 a, vec4 b) {
  if (op == 0) return b;
  if (op == 1) return a + b;
  if (op == 2) return a - b;
  if (op == 3) return a * b;
  if (op == 4) return abs(a - b);
  if (op >= 5 && op <= 7) {
    uvec4 x = uvec4(clamp(floor(a * 255.0 + 0.5), 0.0, 255.0));
    uvec4 y = uvec4(clamp(floor(b * 255.0 + 0.5), 0.0, 255.0));
    uvec4 r = op == 5 ? (x & y) : op == 6 ? (x | y) : (x ^ y);
    return vec4(r) / 255.0;
  }
  if (op == 8 || op == 11) return max(a, b);
  if (op == 9 || op == 10) return min(a, b);
  if (op == 12) return a + b - a * b;
  if (op == 13) return vec4(fx_overlayRgb(a.rgb, b.rgb), fx_overlayRgb(vec3(a.a), vec3(b.a)).x);
  return vec4(fx_overlayRgb(b.rgb, a.rgb), fx_overlayRgb(vec3(b.a), vec3(a.a)).x);
}
// Overflow: clip, wrap around, or scale the operation's range back into 0..1.
vec4 overflow(int op, vec4 r) {
  if (u_overflowBehavior == 1) return mod(floor(r * 255.0 + 0.5), 256.0) / 255.0;
  if (u_overflowBehavior == 2) {
    if (op == 1) return r * 0.5;
    if (op == 2) return r * 0.5 + 0.5;
  }
  return clamp(r, 0.0, 1.0);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_secondSourceLayer_size.x <= 0.0) { fragColor = src; return; }
  vec4 sec = pacg_media(u_secondSourceLayer, u_secondSourceLayer_size, u_stretchSecondSource);
  vec4 a = vec4(pacg_straight(src), src.a);
  vec4 b = vec4(pacg_straight(sec), sec.a);
  vec4 r = overflow(u_operator, op4(u_operator, a, b));
  vec4 o = a;
  if (u_operateOnChannels == 0) o.rgb = r.rgb;
  else if (u_operateOnChannels == 1) o = r;
  else o.a = r.a;
  vec4 res = fx_premultiply(clamp(o, 0.0, 1.0));
  fragColor = mix(res, src, u_blendWithOriginal / 100.0);
}`,
			},
		],
	},
});

export const INVERT = defineShaderEffect({
	id: 'jasper.invert',
	label: 'Invert',
	category: 'Channel',
	description:
		'Inverts the colour information of a channel or colour space (RGB, HLS, YIQ, luminance, chrominance, alpha…).',
	keywords: ['negative', 'invert colors', 'reverse', 'channel'],
	params: [
		popup('channel', 'Channel', [
			['rgb', 'RGB'],
			['red', 'Red'],
			['green', 'Green'],
			['blue', 'Blue'],
			['hls', 'HLS'],
			['hue', 'Hue'],
			['lightness', 'Lightness'],
			['saturation', 'Saturation'],
			['yiq', 'YIQ'],
			['luminance', 'Luminance'],
			['inPhaseChrominance', 'In Phase Chrominance'],
			['quadratureChrominance', 'Quadrature Chrominance'],
			['alpha', 'Alpha'],
		]),
		blendWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  float a = src.a;
  int ch = u_channel;
  vec3 r = c;
  if (ch == 0) r = 1.0 - c;
  else if (ch == 1) r.r = 1.0 - c.r;
  else if (ch == 2) r.g = 1.0 - c.g;
  else if (ch == 3) r.b = 1.0 - c.b;
  else if (ch >= 4 && ch <= 7) {
    vec3 hsl = fx_rgb2hsl(c);
    if (ch == 4) hsl = vec3(fract(hsl.x + 0.5), 1.0 - hsl.y, 1.0 - hsl.z);
    else if (ch == 5) hsl.x = fract(hsl.x + 0.5);
    else if (ch == 6) hsl.z = 1.0 - hsl.z;
    else hsl.y = 1.0 - hsl.y;
    r = fx_hsl2rgb(hsl);
  } else if (ch >= 8 && ch <= 11) {
    vec3 y = pacg_rgb2yiq(c);
    if (ch == 8) y = vec3(1.0 - y.x, -y.y, -y.z);
    else if (ch == 9) y.x = 1.0 - y.x;
    else if (ch == 10) y.y = -y.y;
    else y.z = -y.z;
    r = pacg_yiq2rgb(y);
  } else {
    a = fx_inBox(v_uv) ? 1.0 - src.a : 0.0;
  }
  vec4 res = vec4(clamp(r, 0.0, 1.0) * a, a);
  fragColor = mix(res, src, u_blendWithOriginal / 100.0);
}`,
			},
		],
	},
});

export const SET_MATTE = defineShaderEffect({
	id: 'jasper.set-matte',
	label: 'Set Matte',
	category: 'Channel',
	description:
		"Replaces the clip's alpha with a channel (red, luminance, hue, alpha…) of another layer or of the clip itself.",
	keywords: ['matte', 'alpha', 'mask', 'track matte', 'luma matte'],
	params: [
		fxParam.media('takeMatteFromLayer', 'Take Matte From Layer'),
		popup(
			'useForMatte',
			'Use For Matte',
			[
				['red', 'Red Channel'],
				['green', 'Green Channel'],
				['blue', 'Blue Channel'],
				['alpha', 'Alpha Channel'],
				['luminance', 'Luminance'],
				['hue', 'Hue'],
				['lightness', 'Lightness'],
				['saturation', 'Saturation'],
				['full', 'Full'],
				['off', 'Off'],
			],
			'alpha',
		),
		fxParam.toggle('invertMatte', 'Invert Matte', false),
		fxParam.toggle('stretchMatteToFit', 'If Layer Sizes Differ: Stretch Matte to Fit', true),
		fxParam.toggle('compositeMatteWithOriginal', 'Composite Matte with Original', true),
		fxParam.toggle('premultiplyMatteLayer', 'Premultiply Matte Layer', true),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  bool own = u_takeMatteFromLayer_size.x <= 0.0;
  vec4 m = own ? src : pacg_media(u_takeMatteFromLayer, u_takeMatteFromLayer_size, u_stretchMatteToFit);
  // Channel values of the matte layer: straight, or premultiplied with its own alpha.
  vec3 c = u_premultiplyMatteLayer ? m.rgb : pacg_straight(m);
  vec3 hsl = fx_rgb2hsl(pacg_straight(m));
  int u = u_useForMatte;
  float k = u == 0 ? c.r : u == 1 ? c.g : u == 2 ? c.b : u == 3 ? m.a : u == 4 ? fx_luma(c)
          : u == 5 ? hsl.x : u == 6 ? hsl.z * (u_premultiplyMatteLayer ? m.a : 1.0) : u == 7 ? hsl.y : u == 8 ? 1.0 : 0.0;
  if (u_invertMatte) k = 1.0 - k;
  if (!fx_inBox(v_uv)) k = 0.0;
  float a = u_compositeMatteWithOriginal ? k * src.a : k;
  fragColor = vec4(pacg_straight(src) * a, a);
}`,
			},
		],
	},
});

export const SOLID_COMPOSITE = defineShaderEffect({
	id: 'jasper.solid-composite',
	label: 'Solid Composite',
	category: 'Channel',
	description: 'Composites the clip over a solid colour (behind it) with a blending mode and opacities.',
	keywords: ['background', 'solid', 'color matte', 'fill', 'blend mode'],
	params: [
		fxParam.percent('sourceOpacity', 'Source Opacity', 100),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.percent('opacity', 'Opacity', 100),
		blendModeParam('blendingMode', 'Blending Mode'),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_BLEND],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float sa = fx_inBox(v_uv) ? u_color.a * u_opacity / 100.0 : 0.0;
  vec4 solid = vec4(u_color.rgb * sa, sa);
  fragColor = fx_blend(u_blendingMode, solid, src, u_sourceOpacity / 100.0);
}`,
			},
		],
	},
});

export const CHANNEL_EFFECTS: readonly EffectSpec[] = [
	ARITHMETIC,
	BLEND,
	CALCULATIONS,
	COMPOUND_ARITHMETIC,
	INVERT,
	SET_MATTE,
	SOLID_COMPOSITE,
];

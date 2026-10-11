// Premiere Pro standard effects — Transition bin (family "premiere-stylize-distort-generate"): the keyframable
// EFFECT versions of Block Dissolve, Gradient Wipe, Linear Wipe, Radial Wipe and Venetian Blinds. Each makes the layer
// progressively transparent as Transition Completion goes 0 → 100 % (0 % = untouched, 100 % = fully transparent);
// animate Transition Completion to reveal the layers below. They do not use the transition framework's u_progress.
// Angles are compass angles (0° = up, clockwise), as in Premiere.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import { transitionCompletionParam } from './common.ts';
import { GLSL_PSDG_HASH } from './noise-glsl.ts';
import { GLSL_PSDG_COMPASS } from './stylize.ts';

export const BLOCK_DISSOLVE = defineShaderEffect({
	id: 'jasper.block-dissolve',
	label: 'Block Dissolve',
	category: 'Transition',
	description: 'Makes the layer disappear in random blocks as Transition Completion increases.',
	keywords: ['dissolve', 'pixel', 'random', 'blocks', 'transition'],
	params: [
		transitionCompletionParam(),
		fxParam.number(
			'blockWidth',
			'Block Width',
			1,
			{ min: 1, max: 10000, softMax: 100, step: 0.1 },
			{ unit: 'px' },
		),
		fxParam.number(
			'blockHeight',
			'Block Height',
			1,
			{ min: 1, max: 10000, softMax: 100, step: 0.1 },
			{ unit: 'px' },
		),
		fxParam.pixels('feather', 'Feather', 0, 100),
		fxParam.toggle('softEdges', 'Soft Edges (Best Quality)', true),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_HASH],
				frag: /* glsl */ `
float visibleAt(vec2 lp, float c) {
  vec2 bs = max(vec2(u_blockWidth, u_blockHeight), vec2(1.0));
  float r = psdg_hash2(ivec2(floor(lp / bs)), u_seed);
  return r >= c ? 1.0 : 0.0;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  float c = clamp(u_completion / 100.0, 0.0, 1.0);
  if (c <= 0.0) { fragColor = src; return; }
  if (c >= 1.0) { fragColor = vec4(0.0); return; }
  vec2 lp = fx_layerPx();
  float f = max(u_feather, 0.0);
  float v;
  if (f > 0.0 || u_softEdges) {
    // Average the block mask over a small disk (Feather, at least half a pixel with Soft Edges).
    float r = max(f, 0.5);
    v = 0.0;
    for (int y = -2; y <= 2; y++)
      for (int x = -2; x <= 2; x++) v += visibleAt(lp + vec2(float(x), float(y)) * r * 0.5, c);
    v /= 25.0;
  } else v = visibleAt(lp, c);
  fragColor = src * v;
}`,
			},
		],
	},
});

export const GRADIENT_WIPE = defineShaderEffect({
	id: 'jasper.gradient-wipe',
	label: 'Gradient Wipe',
	category: 'Transition',
	description:
		'Wipes the layer away following the luminance of a gradient picture: dark areas disappear first (the layer’s own luminance without one).',
	keywords: ['luma wipe', 'gradient', 'matte', 'transition', 'reveal'],
	params: [
		transitionCompletionParam(),
		fxParam.percent('softness', 'Transition Softness', 0),
		fxParam.media('gradientLayer', 'Gradient Layer', ['image', 'video']),
		fxParam.choice(
			'placement',
			'Gradient Placement',
			['tile', 'center', 'stretch'],
			['Tile Gradient', 'Center Gradient', 'Stretch Gradient to Fit'],
			'stretch',
		),
		fxParam.toggle('invert', 'Invert Gradient', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
float gradientAt(vec2 lp, vec4 src) {
  vec2 ts = u_gradientLayer_size;
  if (ts.x <= 0.0) return src.a > 0.0 ? fx_luma(src.rgb / src.a) : 0.0;
  vec2 box = u_box.zw / u_pxScale;
  vec2 uv;
  if (u_placement == 2) uv = lp / box;
  else if (u_placement == 1) {
    uv = (lp - (box - ts) * 0.5) / ts;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  } else uv = fract(lp / ts);
  vec4 g = texture(u_gradientLayer, uv);
  return g.a > 0.0 ? fx_luma(g.rgb / g.a) : 0.0;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  float c = clamp(u_completion / 100.0, 0.0, 1.0);
  if (c <= 0.0) { fragColor = src; return; }
  if (c >= 1.0) { fragColor = vec4(0.0); return; }
  float g = gradientAt(fx_layerPx(), src);
  if (u_invert) g = 1.0 - g;
  float s = u_softness / 100.0;
  // The threshold sweeps from −softness to 1 so 0 % shows everything and 100 % nothing.
  float t = mix(-s, 1.0, c);
  float v = s > 0.0 ? smoothstep(t, t + s, g) : (g > t ? 1.0 : 0.0);
  fragColor = src * v;
}`,
			},
		],
	},
});

/** Projection range of the layer box on a direction (layer px), used by Linear Wipe. */
const linearWipeFrag = /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float c = clamp(u_completion / 100.0, 0.0, 1.0);
  if (c <= 0.0) { fragColor = src; return; }
  if (c >= 1.0) { fragColor = vec4(0.0); return; }
  vec2 box = u_box.zw / u_pxScale;
  vec2 d = psdg_compass(u_wipeAngle);
  // The wipe travels along d: the side it comes from disappears first.
  float lo = min(min(0.0, d.x * box.x), min(d.y * box.y, d.x * box.x + d.y * box.y));
  float hi = max(max(0.0, d.x * box.x), max(d.y * box.y, d.x * box.x + d.y * box.y));
  float f = max(u_feather, 0.0);
  float t = mix(lo - f, hi, c);
  float x = dot(fx_layerPx(), d);
  float v = f > 0.0 ? smoothstep(t, t + f, x) : clamp(x - t + 0.5, 0.0, 1.0);
  fragColor = src * v;
}`;

export const LINEAR_WIPE = defineShaderEffect({
	id: 'jasper.linear-wipe',
	label: 'Linear Wipe',
	category: 'Transition',
	description: 'Wipes the layer away in a straight line travelling in the Wipe Angle direction.',
	keywords: ['wipe', 'reveal', 'transition', 'slide'],
	params: [
		transitionCompletionParam(),
		fxParam.angle('wipeAngle', 'Wipe Angle', 90),
		fxParam.pixels('feather', 'Feather', 0, 500),
	],
	gpu: { timeInvariant: true, passes: [{ include: [GLSL_PSDG_COMPASS], frag: linearWipeFrag }] },
});

export const RADIAL_WIPE = defineShaderEffect({
	id: 'jasper.radial-wipe',
	label: 'Radial Wipe',
	category: 'Transition',
	description: 'Wipes the layer away with a sweep around Wipe Center, like a clock hand.',
	keywords: ['clock wipe', 'pie', 'sweep', 'transition', 'reveal'],
	params: [
		transitionCompletionParam(),
		fxParam.angle('startAngle', 'Start Angle', 0),
		fxParam.point('wipeCenter', 'Wipe Center', [0.5, 0.5]),
		fxParam.choice(
			'wipe',
			'Wipe',
			['clockwise', 'counterclockwise', 'both'],
			['Clockwise', 'Counterclockwise', 'Both'],
			'clockwise',
		),
		fxParam.pixels('feather', 'Feather', 0, 500),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
const float TAU = 6.28318530718;
void main() {
  vec4 src = texture(u_source, v_uv);
  float c = clamp(u_completion / 100.0, 0.0, 1.0);
  if (c <= 0.0) { fragColor = src; return; }
  if (c >= 1.0) { fragColor = vec4(0.0); return; }
  vec2 d = fx_layerPx() - u_wipeCenter * u_box.zw / u_pxScale;
  float r = length(d);
  // Compass angle of the pixel (0 = up, clockwise), relative to Start Angle, in turns 0..1.
  float a = atan(d.x, -d.y) / TAU;
  float rel = fract(a - u_startAngle / 360.0);
  float sweep;
  if (u_wipe == 0) sweep = rel;                       // clockwise from the start
  else if (u_wipe == 1) sweep = 1.0 - rel;            // counterclockwise
  else sweep = min(rel, 1.0 - rel) * 2.0;             // both ways
  // Feather: px along the arc → turns at this radius.
  float f = max(u_feather, 0.0) / max(r * TAU, 1.0e-3);
  float aa = 0.75 / max(r * TAU, 1.0);
  float w = max(f, aa);
  float t = mix(-w, 1.0, c);
  float v = smoothstep(t, t + w, sweep);
  fragColor = src * v;
}`,
			},
		],
	},
});

export const VENETIAN_BLINDS = defineShaderEffect({
	id: 'jasper.venetian-blinds',
	label: 'Venetian Blinds',
	category: 'Transition',
	description: 'Wipes the layer away in stripes that grow across each blind, like venetian blinds closing.',
	keywords: ['blinds', 'stripes', 'shutter', 'transition', 'louvre'],
	params: [
		transitionCompletionParam(),
		fxParam.angle('direction', 'Direction', 0),
		fxParam.pixels('width', 'Width', 10, 500),
		fxParam.pixels('feather', 'Feather', 0, 100),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_COMPASS],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float c = clamp(u_completion / 100.0, 0.0, 1.0);
  if (c <= 0.0) { fragColor = src; return; }
  if (c >= 1.0) { fragColor = vec4(0.0); return; }
  float w = max(u_width, 1.0);
  vec2 d = psdg_compass(u_direction);
  // Position across a blind (layer px from the blind's start), blinds stacked along Direction from the centre.
  vec2 rel = fx_layerPx() - 0.5 * u_box.zw / u_pxScale;
  float x = mod(dot(rel, d), w);
  float f = min(max(u_feather, 0.0), w);
  float t = mix(-f, w, c);
  float v = f > 0.0 ? smoothstep(t, t + f, x) : clamp(x - t + 0.5, 0.0, 1.0);
  fragColor = src * v;
}`,
			},
		],
	},
});

export const PSDG_TRANSITION_EFFECTS: readonly EffectSpec[] = [
	BLOCK_DISSOLVE,
	GRADIENT_WIPE,
	LINEAR_WIPE,
	RADIAL_WIPE,
	VENETIAN_BLINDS,
];

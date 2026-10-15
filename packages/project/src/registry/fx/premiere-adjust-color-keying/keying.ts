// Premiere Pro "Keying" video effects (fx family premiere-adjust-color-keying): Ultra Key, Alpha Adjust, Color Key,
// Difference Matte, Image Matte Key, Luma Key, Non Red Key, Remove Matte, Track Matte Key. Mattes are computed on
// straight colour; the result is premultiplied (alpha = matte × source alpha). Matte layers of Image Matte Key /
// Track Matte Key / Difference Matte are `media` params placed over the layer box.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';
import { GLSL_PACG, layerSizesParam, num, popup, slider, str } from './common.ts';

/** Separable min/max (erode/dilate) of a matte stored in the red channel, radius in texture pixels. */
export const GLSL_PACG_MATTE: GlslChunk = {
	name: 'pacg/matte',
	source: /* glsl */ `
// Erodes (dilate = false: minimum) or dilates (maximum) the red channel along dir over radius texels; fractional
// radii weight the outermost taps so animated chokes move smoothly.
float pacg_morph1d(sampler2D t, vec2 uv, vec2 dir, vec2 texel, float radius, bool dilate) {
  float v = texture(t, uv).r;
  int n = int(ceil(radius));
  for (int i = 1; i <= 64; i++) {
    if (i > n) break;
    float w = clamp(radius - float(i - 1), 0.0, 1.0);
    float a = texture(t, uv + dir * texel * float(i)).r;
    float b = texture(t, uv - dir * texel * float(i)).r;
    float m = dilate ? max(a, b) : min(a, b);
    v = dilate ? max(v, mix(v, m, w)) : min(v, mix(v, m, w));
  }
  return v;
}
`,
};

/** Two passes (H, V) eroding (radius > 0) or dilating (radius < 0) the red-channel matte `input` → `output`. */
export function morphPasses(input: string, output: string, radius: number): ShaderPass[] {
	const r = Math.min(64, Math.abs(radius));
	const dilate = radius < 0;
	const frag = (tex: string) => /* glsl */ `
void main() {
  float m = pacg_morph1d(${tex}, v_uv, u_morphDir, u_texel, u_morphRadius, u_morphDilate);
  fragColor = vec4(m, m, m, 1.0);
}`;
	return [
		{
			output: `${output}H`,
			include: [GLSL_PACG_MATTE],
			frag: frag(`u_${input}`),
			uniforms: { u_morphDir: [1, 0], u_morphRadius: r, u_morphDilate: dilate },
		},
		{
			output,
			include: [GLSL_PACG_MATTE],
			frag: frag(`u_${output}H`),
			uniforms: { u_morphDir: [0, 1], u_morphRadius: r, u_morphDilate: dilate },
		},
	];
}

/** Gaussian softening of a matte (H, V); empty when `sigma` (canvas px) is ~0. */
function softenPasses(input: string, output: string, sigma: number): ShaderPass[] {
	if (sigma < 0.05) return [];
	return gaussianBlurPasses({ input, output, sigma, scale: sigma > 8 ? 0.5 : 1 });
}

/** Matte Generation / Cleanup values of Ultra Key's "Setting" presets (Default = the param defaults). */
const ULTRA_KEY_PRESETS = {
	default: { transparency: 45, highlight: 10, shadow: 50, tolerance: 50, pedestal: 10 },
	relaxed: { transparency: 45, highlight: 10, shadow: 50, tolerance: 25, pedestal: 0 },
	aggressive: { transparency: 55, highlight: 20, shadow: 40, tolerance: 75, pedestal: 25 },
} as const;

/**
 * The matte-generation values Ultra Key uses: the preset's for Relaxed/Aggressive, the sliders for Default/Custom
 * (the sliders' defaults are the Default preset; Premiere switches to Custom when one is edited).
 */
function ultraKeyMatteValues(p: EffectParams) {
	const setting = str(p.setting, 'default');
	if (setting === 'relaxed' || setting === 'aggressive') return ULTRA_KEY_PRESETS[setting];
	const d = ULTRA_KEY_PRESETS.default;
	return {
		transparency: num(p.transparency, d.transparency),
		highlight: num(p.highlight, d.highlight),
		shadow: num(p.shadow, d.shadow),
		tolerance: num(p.tolerance, d.tolerance),
		pedestal: num(p.pedestal, d.pedestal),
	};
}

/** Ultra Key's choke radius and soften sigma in layer px. */
export const ultraKeyChokePx = (p: EffectParams) => Math.max(0, num(p.choke)) * 0.1;
export const ultraKeySoftenPx = (p: EffectParams) => Math.max(0, num(p.soften)) * 0.1;

/**
 * Chroma keying maths (Rec.709 Y′CbCr). The key colour defines a direction in the chroma plane; a pixel's "key
 * strength" is its chroma along that direction minus a tolerance-weighted share of its chroma across it (the
 * generalised colour-difference keyer: for a green key ≈ G − max(R, B)), relative to the key's own chroma, with
 * shadow/highlight compensation by luma. 0 = foreground, ≥ 1 = as much key colour as the key itself.
 */
export const GLSL_PACG_CHROMA_KEY: GlslChunk = {
	name: 'pacg/chroma-key',
	source: /* glsl */ `
const vec3 PACG_Y709 = vec3(0.2126, 0.7152, 0.0722);
vec3 pacg_ycc(vec3 c) { float y = dot(c, PACG_Y709); return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748); }
vec3 pacg_rgbOfYcc(vec3 ycc) {
  float r = ycc.x + 1.5748 * ycc.z;
  float b = ycc.x + 1.8556 * ycc.y;
  return vec3(r, (ycc.x - 0.2126 * r - 0.0722 * b) / 0.7152, b);
}
// Key strength of c (straight RGB) against key; tolW = weight of off-axis chroma (lower = more tolerant),
// shadowComp 0..1 = how much darker shades of the key count as key, highlight 0..1 = how much brighter ones do not.
float pacg_keyStrength(vec3 c, vec3 key, float tolW, float shadowComp, float highlight) {
  vec3 k = pacg_ycc(key);
  float mk = max(length(k.yz), 1.0e-3);
  vec2 dk = k.yz / mk;
  vec3 p = pacg_ycc(c);
  float along = dot(p.yz, dk);
  float across = length(p.yz - along * dk);
  float ref = mk;
  if (p.x < k.x) ref *= mix(1.0, max(p.x / max(k.x, 1.0e-3), 0.3), shadowComp);
  float s = (along - across * tolW) / ref;
  if (p.x > k.x) s *= 1.0 - highlight * smoothstep(0.0, 0.3, p.x - k.x);
  return s;
}
`,
};

export const ULTRA_KEY = defineShaderEffect({
	id: 'jasper.ultra-key',
	label: 'Ultra Key',
	category: 'Keying',
	description:
		'High-quality chroma keyer: removes a key colour (green/blue screen) with matte generation, cleanup, spill suppression and colour correction.',
	keywords: ['chroma key', 'green screen', 'blue screen', 'keyer', 'spill', 'matte', 'transparency'],
	expensive: true,
	params: [
		popup('output', 'Output', [
			['composite', 'Composite'],
			['alphaChannel', 'Alpha Channel'],
			['colorChannel', 'Color Channel'],
		]),
		popup('setting', 'Setting', [
			['default', 'Default'],
			['relaxed', 'Relaxed'],
			['aggressive', 'Aggressive'],
			['custom', 'Custom'],
		]),
		fxParam.color('keyColor', 'Key Color', [0.18, 0.75, 0.28, 1]),
		fxParam.percent('transparency', 'Transparency', 45, { group: 'Matte Generation' }),
		fxParam.percent('highlight', 'Highlight', 10, { group: 'Matte Generation' }),
		fxParam.percent('shadow', 'Shadow', 50, { group: 'Matte Generation' }),
		fxParam.percent('tolerance', 'Tolerance', 50, { group: 'Matte Generation' }),
		fxParam.percent('pedestal', 'Pedestal', 10, { group: 'Matte Generation' }),
		fxParam.percent('choke', 'Choke', 0, { group: 'Matte Cleanup' }),
		fxParam.percent('soften', 'Soften', 0, { group: 'Matte Cleanup' }),
		fxParam.percent('contrast', 'Contrast', 0, { group: 'Matte Cleanup' }),
		fxParam.percent('midPoint', 'Mid Point', 50, { group: 'Matte Cleanup' }),
		fxParam.percent('desaturate', 'Desaturate', 25, { group: 'Spill Suppression' }),
		fxParam.percent('range', 'Range', 50, { group: 'Spill Suppression' }),
		fxParam.percent('spill', 'Spill', 50, { group: 'Spill Suppression' }),
		fxParam.percent('luma', 'Luma', 50, { group: 'Spill Suppression' }),
		slider('ccSaturation', 'Saturation', 100, 0, 200, { group: 'Color Correction' }),
		fxParam.angle('ccHue', 'Hue', 0, { group: 'Color Correction' }),
		slider('ccLuminance', 'Luminance', 100, 0, 200, { group: 'Color Correction' }),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => {
			const m = ultraKeyMatteValues(p);
			return {
				u_mTransparency: m.transparency,
				u_mHighlight: m.highlight,
				u_mShadow: m.shadow,
				u_mTolerance: m.tolerance,
				u_mPedestal: m.pedestal,
			};
		},
		passes: (p, ctx: FxPlanContext) => {
			const choke = ultraKeyChokePx(p) * ctx.pxScale;
			const soften = ultraKeySoftenPx(p) * ctx.pxScale;
			const passes: ShaderPass[] = [
				{
					output: 'raw',
					include: [GLSL_PACG_CHROMA_KEY],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  float tolW = mix(3.0, 0.25, u_mTolerance / 100.0);
  float s = pacg_keyStrength(c, u_keyColor.rgb, tolW, 1.0 - u_mShadow / 100.0, u_mHighlight / 100.0);
  float gain = mix(1.0, 3.5, u_mTransparency / 100.0);
  float a = clamp(1.0 - s * gain, 0.0, 1.0);
  float ped = u_mPedestal / 100.0 * 0.6;
  a = clamp((a - ped) / max(1.0 - ped, 1.0e-3), 0.0, 1.0);
  fragColor = vec4(a, a, a, 1.0);
}`,
				},
			];
			let matte = 'raw';
			if (choke > 0.01) {
				passes.push(...morphPasses(matte, 'choked', choke));
				matte = 'choked';
			}
			const soft = softenPasses(matte, 'soft', soften);
			if (soft.length) {
				passes.push(...soft);
				matte = 'soft';
			}
			passes.push({
				include: [GLSL_PACG_CHROMA_KEY],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  float a = texture(u_${matte}, v_uv).r;
  // Matte cleanup: contrast around the mid point.
  float mid = u_midPoint / 100.0;
  if (u_contrast > 0.0) a = clamp((a - mid) * (1.0 + u_contrast / 100.0 * 6.0) + mid, 0.0, 1.0);
  // Spill suppression: remove the excess key-direction chroma of the foreground.
  vec3 k = pacg_ycc(u_keyColor.rgb);
  float mk = max(length(k.yz), 1.0e-3);
  vec2 dk = k.yz / mk;
  vec3 ycc = pacg_ycc(c);
  float along = dot(ycc.yz, dk);
  float across = length(ycc.yz - along * dk);
  float spillW = mix(2.0, 0.0, u_range / 100.0);
  float excess = max(0.0, along - across * spillW);
  float removed = excess * (u_spill / 50.0);
  ycc.yz -= dk * removed;
  ycc.x -= (1.0 - u_luma / 100.0) * removed * (k.x / mk) * 0.5;
  // Desaturate what is nearly transparent (edge pixels mixed with the screen).
  float d = u_desaturate / 100.0 * smoothstep(0.0, 1.0, 1.0 - a);
  ycc.yz *= 1.0 - d;
  // Colour correction of the foreground.
  float h = radians(u_ccHue);
  ycc.yz = mat2(cos(h), sin(h), -sin(h), cos(h)) * ycc.yz * (u_ccSaturation / 100.0);
  ycc.x *= u_ccLuminance / 100.0;
  vec3 fg = clamp(pacg_rgbOfYcc(ycc), 0.0, 1.0);
  if (u_output == 1) { fragColor = vec4(vec3(a * src.a), 1.0); return; }
  if (u_output == 2) { fragColor = vec4(fg * src.a, src.a); return; }
  float alpha = a * src.a;
  fragColor = vec4(fg * alpha, alpha);
}`,
			});
			return passes;
		},
	},
});

export const ALPHA_ADJUST = defineShaderEffect({
	id: 'jasper.alpha-adjust',
	label: 'Alpha Adjust',
	category: 'Keying',
	description:
		"Changes the layer's opacity through its alpha channel: scale, ignore or invert alpha, or show the mask.",
	keywords: ['opacity', 'alpha', 'invert alpha', 'mask'],
	params: [
		slider('opacity', 'Opacity', 100, 0, 100, { unit: '%' }),
		fxParam.toggle('ignoreAlpha', 'Ignore Alpha', false),
		fxParam.toggle('invertAlpha', 'Invert Alpha', false),
		fxParam.toggle('maskOnly', 'Mask Only', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  float a = u_ignoreAlpha ? (fx_inBox(v_uv) ? 1.0 : 0.0) : src.a;
  if (u_invertAlpha) a = 1.0 - a;
  a *= clamp(u_opacity / 100.0, 0.0, 1.0);
  if (u_maskOnly) { fragColor = vec4(vec3(a), a); return; }
  fragColor = vec4(c * a, a);
}`,
			},
		],
	},
});

/** Color Key's Edge Thin / Edge Feather in layer px. */
export const colorKeyEdgeThinPx = (p: EffectParams) => Math.max(-5, Math.min(5, num(p.edgeThin)));
export const colorKeyFeatherPx = (p: EffectParams) => Math.max(0, Math.min(10, num(p.edgeFeather)));

export const COLOR_KEY = defineShaderEffect({
	id: 'jasper.color-key',
	label: 'Color Key',
	category: 'Keying',
	description:
		'Keys out all pixels similar to a key colour (RGB distance within the tolerance); thin and feather the edges.',
	keywords: ['chroma key', 'transparency', 'green screen', 'key out'],
	params: [
		fxParam.color('keyColor', 'Key Color', [0, 0, 1, 1]),
		slider('colorTolerance', 'Color Tolerance', 0, 0, 255, { step: 1 }),
		slider('edgeThin', 'Edge Thin', 0, -5, 5, { step: 1 }),
		slider('edgeFeather', 'Edge Feather', 0, 0, 10, { step: 0.1 }),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const thin = colorKeyEdgeThinPx(p) * ctx.pxScale;
			const feather = colorKeyFeatherPx(p) * ctx.pxScale;
			const passes: ShaderPass[] = [
				{
					output: 'raw',
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 d = abs(c - u_keyColor.rgb) * 255.0;
  float m = max(d.r, max(d.g, d.b)) <= u_colorTolerance + 0.5 ? 0.0 : 1.0;
  fragColor = vec4(m, m, m, 1.0);
}`,
				},
			];
			let matte = 'raw';
			if (Math.abs(thin) > 0.01) {
				passes.push(...morphPasses(matte, 'thin', thin));
				matte = 'thin';
			}
			const soft = softenPasses(matte, 'soft', feather / 2);
			if (soft.length) {
				passes.push(...soft);
				matte = 'soft';
			}
			passes.push({
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  fragColor = src * texture(u_${matte}, v_uv).r;
}`,
			});
			return passes;
		},
	},
});

export const DIFFERENCE_MATTE = defineShaderEffect({
	id: 'jasper.difference-matte',
	label: 'Difference Matte',
	category: 'Keying',
	description:
		'Makes transparent the pixels that match a difference layer (e.g. a clean plate of the background), keeping what changed.',
	keywords: ['clean plate', 'background subtraction', 'matte', 'difference'],
	params: [
		popup('view', 'View', [
			['finalOutput', 'Final Output'],
			['sourceOnly', 'Source Only'],
			['matteOnly', 'Difference Matte Only'],
		]),
		fxParam.media('differenceLayer', 'Difference Layer'),
		layerSizesParam('center'),
		fxParam.percent('matchingTolerance', 'Matching Tolerance', 15),
		fxParam.percent('matchingSoftness', 'Matching Softness', 0),
		slider('blurBeforeDifference', 'Blur Before Difference', 0, 0, 1000, { softMax: 20, step: 0.1 }),
	],
	gpu: {
		passes: (p, ctx) => {
			const sigma = Math.max(0, num(p.blurBeforeDifference)) * ctx.pxScale * 0.5;
			const passes: ShaderPass[] = [
				{
					output: 'plate',
					include: [GLSL_PACG],
					frag: /* glsl */ `
void main() { fragColor = pacg_media(u_differenceLayer, u_differenceLayer_size, u_layerSizes == 1); }`,
				},
			];
			let a = 'source';
			let b = 'plate';
			if (sigma >= 0.05) {
				passes.push(
					...gaussianBlurPasses({ input: 'source', output: 'blurA', sigma, scale: sigma > 8 ? 0.5 : 1 }),
				);
				passes.push(
					...gaussianBlurPasses({ input: 'plate', output: 'blurB', sigma, scale: sigma > 8 ? 0.5 : 1 }),
				);
				a = 'blurA';
				b = 'blurB';
			}
			passes.push({
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  // (u_differenceLayer_size is only set in passes that sample the layer: a missing layer = a transparent plate.)
  if (u_view == 1) { fragColor = src; return; }
  vec4 pa = texture(u_${a}, v_uv);
  vec4 pb = texture(u_${b}, v_uv);
  vec3 d = abs(pacg_straight(pa) - pacg_straight(pb));
  float diff = max(max(d.r, d.g), d.b);
  if (pb.a <= 0.0) diff = 1.0;
  float tol = u_matchingTolerance / 100.0;
  float soft = u_matchingSoftness / 100.0;
  float m = soft > 0.0 ? smoothstep(tol, tol + soft, diff) : step(tol, diff);
  if (u_view == 2) { fragColor = vec4(vec3(m * src.a), 1.0); return; }
  fragColor = src * m;
}`,
			});
			return passes;
		},
	},
});

const matteKeyFrag = (param: string) => /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_${param}_size.x <= 0.0) { fragColor = u_reverse ? vec4(0.0) : src; return; }
  vec4 m = pacg_media(u_${param}, u_${param}_size, true);
  float k = u_compositeUsing == 0 ? m.a : fx_luma(pacg_straight(m)) * m.a;
  if (u_reverse) k = 1.0 - k;
  fragColor = src * k;
}`;

const compositeUsingParam = () =>
	popup('compositeUsing', 'Composite Using', [
		['matteAlpha', 'Matte Alpha'],
		['matteLuma', 'Matte Luma'],
	]);

export const IMAGE_MATTE_KEY = defineShaderEffect({
	id: 'jasper.image-matte-key',
	label: 'Image Matte Key',
	category: 'Keying',
	description: "Keys the layer through a still image's alpha or luminance (stretched over the layer).",
	keywords: ['matte', 'mask', 'luma matte', 'alpha matte'],
	params: [
		fxParam.media('matte', 'Matte', ['image']),
		compositeUsingParam(),
		fxParam.toggle('reverse', 'Reverse', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [{ include: [GLSL_PACG], frag: matteKeyFrag('matte') }],
	},
});

/**
 * Track Matte Key (Premiere: Matte = a video track, Composite Using = Matte Alpha / Matte Luma, Reverse). wp masks:
 * `matteTrack` names a video track of the sequence; its composite at the same sequence frame (every clip of that
 * track with its effects, masks, Motion and opacity, rendered alone) is the matte, placed in sequence space — so the
 * fill layer's own Motion moves the fill under a fixed matte, as in After Effects. The composition binds it as
 * `u_matte` (sequence-sized) and sets `u_matteFromTrack`. Without a track the older `matte` media param (a clip
 * stretched over the layer box) is used.
 */
export const TRACK_MATTE_KEY = defineShaderEffect({
	id: 'jasper.track-matte-key',
	label: 'Track Matte Key',
	category: 'Keying',
	description:
		"Shows the layer through another video track's alpha or luminance (travelling matte), at the same sequence time.",
	keywords: ['travelling matte', 'traveling matte', 'mask', 'luma matte', 'alpha matte', 'track matte'],
	params: [
		{
			name: 'matteTrack',
			label: 'Matte',
			type: 'string',
			default: '',
			animatable: false,
			ui: { control: 'track' },
		},
		compositeUsingParam(),
		fxParam.toggle('reverse', 'Reverse', false),
		fxParam.media('matte', 'Matte Clip (no track)'),
	],
	gpu: {
		uniforms: (p) => ({ u_matteFromTrack: typeof p.matteTrack === 'string' && p.matteTrack !== '' }),
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_matte_size.x <= 0.0) { fragColor = u_reverse ? vec4(0.0) : src; return; }
  vec4 m;
  if (u_matteFromTrack) {
    // The track composite is sequence-sized: this layer pixel's position in the sequence frame.
    vec3 q = u_layerToComp * vec3(fx_layerPx(), 1.0);
    vec2 uv = (q.xy / (abs(q.z) < 1e-9 ? 1e-9 : q.z)) / u_compSize;
    m = (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) ? vec4(0.0) : texture(u_matte, uv);
  } else {
    m = pacg_media(u_matte, u_matte_size, true);
  }
  float k = u_compositeUsing == 0 ? m.a : fx_luma(pacg_straight(m)) * m.a;
  if (u_reverse) k = 1.0 - k;
  fragColor = src * k;
}`,
			},
		],
	},
});

export const LUMA_KEY = defineShaderEffect({
	id: 'jasper.luma-key',
	label: 'Luma Key',
	category: 'Keying',
	description: 'Keys out the dark areas of the layer: luminance below the threshold becomes transparent.',
	keywords: ['luminance key', 'key out black', 'brightness key'],
	params: [fxParam.percent('threshold', 'Threshold', 10), fxParam.percent('cutoff', 'Cutoff', 0)],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float y = fx_luma(pacg_straight(src));
  // Threshold: the range of dark values that turn transparent (with a short soft ramp above it);
  // Cutoff: makes the remaining, non-transparent part more transparent.
  float t = u_threshold / 100.0;
  float m = t <= 0.0 ? 1.0 : smoothstep(t, t + 0.08, y);
  m *= 1.0 - u_cutoff / 100.0;
  fragColor = src * m;
}`,
			},
		],
	},
});

export const NON_RED_KEY = defineShaderEffect({
	id: 'jasper.non-red-key',
	label: 'Non Red Key',
	category: 'Keying',
	description:
		'Keys out green or blue backgrounds (anything where green or blue dominates red), with defringing.',
	keywords: ['green screen', 'blue screen', 'chroma key', 'defringe'],
	params: [
		fxParam.percent('threshold', 'Threshold', 50),
		fxParam.percent('cutoff', 'Cutoff', 0),
		popup('defringing', 'Defringing', [
			['none', 'None'],
			['green', 'Green'],
			['blue', 'Blue'],
		]),
		popup('smoothing', 'Smoothing', [
			['none', 'None'],
			['low', 'Low'],
			['high', 'High'],
		]),
		fxParam.toggle('maskOnly', 'Mask Only', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				output: 'raw',
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  // How far green/blue rise above red: 0 = no screen colour.
  float screen = max(c.g, c.b) - c.r;
  float t = u_threshold / 100.0;
  float lo = mix(0.6, 0.0, t);
  float hi = lo + mix(0.02, 0.4, u_cutoff / 100.0) + 0.02;
  float m = 1.0 - smoothstep(lo, hi, screen);
  fragColor = vec4(m, m, m, 1.0);
}`,
			},
			{
				include: [GLSL_PACG, GLSL_BLUR],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float m = texture(u_raw, v_uv).r;
  if (u_smoothing == 1) m = fx_blur9(u_raw, v_uv, u_texel).r;
  if (u_smoothing == 2) m = fx_blur9(u_raw, v_uv, u_texel * 2.0).r;
  if (u_maskOnly) { fragColor = vec4(vec3(m * src.a), 1.0); return; }
  vec3 c = pacg_straight(src);
  if (u_defringing == 1) c.g = min(c.g, max(c.r, c.b));
  if (u_defringing == 2) c.b = min(c.b, max(c.r, c.g));
  float a = m * src.a;
  fragColor = vec4(c * a, a);
}`,
			},
		],
	},
});

export const REMOVE_MATTE = defineShaderEffect({
	id: 'jasper.remove-matte',
	label: 'Remove Matte',
	category: 'Keying',
	description:
		'Removes the white or black fringe of a layer whose colours were premultiplied against a white or black matte.',
	keywords: ['fringe', 'halo', 'premultiplied', 'unmultiply', 'matte'],
	params: [
		popup('matteType', 'Matte Type', [
			['white', 'White'],
			['black', 'Black'],
		]),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  // The straight colour was matted: c = fg·a + M·(1 − a). Recover fg.
  vec3 c = src.rgb / src.a;
  vec3 M = u_matteType == 0 ? vec3(1.0) : vec3(0.0);
  vec3 fg = clamp((c - M * (1.0 - src.a)) / src.a, 0.0, 1.0);
  fragColor = vec4(fg * src.a, src.a);
}`,
			},
		],
	},
});

export const KEYING_EFFECTS: readonly EffectSpec[] = [
	ULTRA_KEY,
	ALPHA_ADJUST,
	COLOR_KEY,
	DIFFERENCE_MATTE,
	IMAGE_MATTE_KEY,
	LUMA_KEY,
	NON_RED_KEY,
	REMOVE_MATTE,
	TRACK_MATTE_KEY,
];

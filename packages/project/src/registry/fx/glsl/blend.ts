// Blend modes and premultiplied compositing.
// - `fx_blendRgb(mode, base, top)` works on straight RGB 0..1; `fx_blend(mode, base, top, opacity)` composites
//   premultiplied RGBA (top over base, the blend applied where both exist — the W3C compositing model). Mode numbers
//   = indexes of FX_BLEND_MODES, so an enum param built with `blendModeParam()` maps straight onto `int u_<name>`.
//   Effect blend formulas differ from clip blending for modes 0–15; higher modes use the clip formulas.
// - `fx_layerBlend(mode, dst, src, noise)` is the clip blend of the layer compositor (mode = index in the schema's
//   BLEND_MODES, `blendModeIndex`), ported from EffectCraft's `blend_pixel` (crates/gpu/src/shaders/common.wgsl,
//   MIT OR Apache-2.0); bit-for-bit the formulas of `blendPixel` in `blend-modes.ts` (the native export kernel).
// - `fx_blendNoise(px, seed)`: Dissolve's integer hash (EffectCraft `hash_noise`), equal to `dissolveNoise` in JS.
import type { GlslChunk } from '../shader.ts';

/** Blend mode option values in GLSL index order (`blendModeParam` options). */
export const FX_BLEND_MODES = [
	'normal',
	'add',
	'screen',
	'multiply',
	'overlay',
	'softLight',
	'hardLight',
	'colorDodge',
	'colorBurn',
	'linearBurn',
	'lighten',
	'darken',
	'difference',
	'exclusion',
	'subtract',
	'divide',
	// keyframes-blend: the rest of Premiere's 27 and After Effects' utility modes.
	'dissolve',
	'darkerColor',
	'lighterColor',
	'vividLight',
	'linearLight',
	'pinLight',
	'hardMix',
	'hue',
	'saturation',
	'color',
	'luminosity',
	'stencilAlpha',
	'stencilLuma',
	'silhouetteAlpha',
	'silhouetteLuma',
	'alphaAdd',
] as const;
export const FX_BLEND_MODE_LABELS = [
	'Normal',
	'Add',
	'Screen',
	'Multiply',
	'Overlay',
	'Soft Light',
	'Hard Light',
	'Color Dodge',
	'Color Burn',
	'Linear Burn',
	'Lighten',
	'Darken',
	'Difference',
	'Exclusion',
	'Subtract',
	'Divide',
	'Dissolve',
	'Darker Color',
	'Lighter Color',
	'Vivid Light',
	'Linear Light',
	'Pin Light',
	'Hard Mix',
	'Hue',
	'Saturation',
	'Color',
	'Luminosity',
	'Stencil Alpha',
	'Stencil Luma',
	'Silhouette Alpha',
	'Silhouette Luma',
	'Alpha Add',
] as const;

/** The clip blend mode (schema `BLEND_MODES` id) of each FX_BLEND_MODES entry. */
export const FX_BLEND_TO_LAYER: Readonly<Record<(typeof FX_BLEND_MODES)[number], string>> = {
	normal: 'normal',
	add: 'add',
	screen: 'screen',
	multiply: 'multiply',
	overlay: 'overlay',
	softLight: 'soft-light',
	hardLight: 'hard-light',
	colorDodge: 'color-dodge',
	colorBurn: 'color-burn',
	linearBurn: 'linear-burn',
	lighten: 'lighten',
	darken: 'darken',
	difference: 'difference',
	exclusion: 'exclusion',
	subtract: 'subtract',
	divide: 'divide',
	dissolve: 'dissolve',
	darkerColor: 'darker-color',
	lighterColor: 'lighter-color',
	vividLight: 'vivid-light',
	linearLight: 'linear-light',
	pinLight: 'pin-light',
	hardMix: 'hard-mix',
	hue: 'hue',
	saturation: 'saturation',
	color: 'color',
	luminosity: 'luminosity',
	stencilAlpha: 'stencil-alpha',
	stencilLuma: 'stencil-luma',
	silhouetteAlpha: 'silhouette-alpha',
	silhouetteLuma: 'silhouette-luma',
	alphaAdd: 'alpha-add',
};

/** Layer mode numbers (schema BLEND_MODES order) used by `fx_layerBlend`. */
const LAYER = {
	NORMAL: 0,
	DISSOLVE: 1,
	DARKEN: 2,
	MULTIPLY: 3,
	COLOR_BURN: 4,
	LINEAR_BURN: 5,
	DARKER_COLOR: 6,
	LIGHTEN: 7,
	SCREEN: 8,
	COLOR_DODGE: 9,
	ADD: 10,
	LIGHTER_COLOR: 11,
	OVERLAY: 12,
	SOFT_LIGHT: 13,
	HARD_LIGHT: 14,
	VIVID_LIGHT: 15,
	LINEAR_LIGHT: 16,
	PIN_LIGHT: 17,
	HARD_MIX: 18,
	DIFFERENCE: 19,
	EXCLUSION: 20,
	SUBTRACT: 21,
	DIVIDE: 22,
	HUE: 23,
	SATURATION: 24,
	COLOR: 25,
	LUMINOSITY: 26,
	STENCIL_ALPHA: 27,
	STENCIL_LUMA: 28,
	SILHOUETTE_ALPHA: 29,
	SILHOUETTE_LUMA: 30,
	ALPHA_ADD: 31,
} as const;

/** Layer mode numbers of FX_BLEND_MODES 16… (the appended modes). */
const FX_APPENDED_LAYER = [
	LAYER.DISSOLVE,
	LAYER.DARKER_COLOR,
	LAYER.LIGHTER_COLOR,
	LAYER.VIVID_LIGHT,
	LAYER.LINEAR_LIGHT,
	LAYER.PIN_LIGHT,
	LAYER.HARD_MIX,
	LAYER.HUE,
	LAYER.SATURATION,
	LAYER.COLOR,
	LAYER.LUMINOSITY,
	LAYER.STENCIL_ALPHA,
	LAYER.STENCIL_LUMA,
	LAYER.SILHOUETTE_ALPHA,
	LAYER.SILHOUETTE_LUMA,
	LAYER.ALPHA_ADD,
];

const layerConsts = Object.entries(LAYER)
	.map(([k, v]) => `const int FX_LAYER_${k} = ${v};`)
	.join('\n');
const fxConsts = FX_BLEND_MODES.map(
	(m, i) => `const int FX_BLEND_${m.replace(/([A-Z])/g, '_$1').toUpperCase()} = ${i};`,
).join('\n');
const appended = FX_APPENDED_LAYER.map((l, i) => `  if (mode == ${16 + i}) return ${l};`).join('\n');

export const GLSL_LAYER_BLEND: GlslChunk = {
	name: 'fx/layer-blend',
	source: /* glsl */ `
${fxConsts}
${layerConsts}

float fx_bl_burn(float cb, float cs) { if (cb >= 1.0) return 1.0; if (cs <= 0.0) return 0.0; return 1.0 - min((1.0 - cb) / cs, 1.0); }
float fx_bl_dodge(float cb, float cs) { if (cb <= 0.0) return 0.0; if (cs >= 1.0) return 1.0; return min(cb / (1.0 - cs), 1.0); }
float fx_bl_hardLight(float cb, float cs) { if (cs <= 0.5) return cb * 2.0 * cs; float s = 2.0 * cs - 1.0; return cb + s - cb * s; }
float fx_bl_softLight(float cb, float cs) {
  if (cs <= 0.5) return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
  float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(max(cb, 0.0));
  return cb + (2.0 * cs - 1.0) * (d - cb);
}
float fx_bl_sep(int mode, float cb, float cs) {
  switch (mode) {
    case FX_LAYER_DARKEN: return min(cb, cs);
    case FX_LAYER_MULTIPLY: return cb * cs;
    case FX_LAYER_COLOR_BURN: return fx_bl_burn(cb, cs);
    case FX_LAYER_LINEAR_BURN: return max(cb + cs - 1.0, 0.0);
    case FX_LAYER_LIGHTEN: return max(cb, cs);
    case FX_LAYER_SCREEN: return cb + cs - cb * cs;
    case FX_LAYER_COLOR_DODGE: return fx_bl_dodge(cb, cs);
    case FX_LAYER_ADD: return cb + cs;
    case FX_LAYER_OVERLAY: return fx_bl_hardLight(cs, cb);
    case FX_LAYER_SOFT_LIGHT: return fx_bl_softLight(cb, cs);
    case FX_LAYER_HARD_LIGHT: return fx_bl_hardLight(cb, cs);
    case FX_LAYER_VIVID_LIGHT: return cs <= 0.5 ? fx_bl_burn(cb, 2.0 * cs) : fx_bl_dodge(cb, 2.0 * (cs - 0.5));
    case FX_LAYER_LINEAR_LIGHT: return clamp(cb + 2.0 * cs - 1.0, 0.0, 1.0);
    case FX_LAYER_PIN_LIGHT: return cs <= 0.5 ? min(cb, 2.0 * cs) : max(cb, 2.0 * cs - 1.0);
    case FX_LAYER_HARD_MIX: return cb + cs >= 1.0 - 0.25 / 255.0 ? 1.0 : 0.0;
    case FX_LAYER_DIFFERENCE: return abs(cb - cs);
    case FX_LAYER_EXCLUSION: return cb + cs - 2.0 * cb * cs;
    case FX_LAYER_SUBTRACT: return max(cb - cs, 0.0);
    case FX_LAYER_DIVIDE: return cs <= 0.0 ? (cb > 0.0 ? 1.0 : 0.0) : cb / cs;
    default: return cs;
  }
}
float fx_bl_lum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
float fx_bl_luma709(vec3 c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
vec3 fx_bl_clip(vec3 c) {
  float l = fx_bl_lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  vec3 o = c;
  if (n < 0.0) o = l + (o - l) * (l / max(l - n, 1e-9));
  if (x > 1.0) o = l + (o - l) * ((1.0 - l) / max(x - l, 1e-9));
  return o;
}
vec3 fx_bl_setLum(vec3 c, float l) { return fx_bl_clip(c + (l - fx_bl_lum(c))); }
float fx_bl_sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 fx_bl_setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  if (mx - mn <= 1e-9) return vec3(0.0);
  return (c - mn) * (s / (mx - mn));
}
// B(Cb, Cs) of a clip blend mode on straight RGB.
vec3 fx_layerBlendRgb(int mode, vec3 cb, vec3 cs) {
  switch (mode) {
    case FX_LAYER_HUE: return fx_bl_setLum(fx_bl_setSat(cs, fx_bl_sat(cb)), fx_bl_lum(cb));
    case FX_LAYER_SATURATION: return fx_bl_setLum(fx_bl_setSat(cb, fx_bl_sat(cs)), fx_bl_lum(cb));
    case FX_LAYER_COLOR: return fx_bl_setLum(cs, fx_bl_lum(cb));
    case FX_LAYER_LUMINOSITY: return fx_bl_setLum(cb, fx_bl_lum(cs));
    case FX_LAYER_DARKER_COLOR: return fx_bl_luma709(cs) < fx_bl_luma709(cb) - 1e-5 ? cs : cb;
    case FX_LAYER_LIGHTER_COLOR: return fx_bl_luma709(cs) > fx_bl_luma709(cb) + 1e-5 ? cs : cb;
    default: return vec3(fx_bl_sep(mode, cb.r, cs.r), fx_bl_sep(mode, cb.g, cs.g), fx_bl_sep(mode, cb.b, cs.b));
  }
}
bool fx_bl_hdr(int mode) {
  return mode == FX_LAYER_NORMAL || mode == FX_LAYER_DISSOLVE || mode == FX_LAYER_DARKEN || mode == FX_LAYER_MULTIPLY
    || mode == FX_LAYER_LINEAR_BURN || mode == FX_LAYER_DARKER_COLOR || mode == FX_LAYER_LIGHTEN || mode == FX_LAYER_SCREEN
    || mode == FX_LAYER_ADD || mode == FX_LAYER_LIGHTER_COLOR || mode == FX_LAYER_DIFFERENCE || mode == FX_LAYER_SUBTRACT
    || mode == FX_LAYER_DIVIDE || mode >= FX_LAYER_STENCIL_ALPHA;
}
// Dissolve's per-pixel random value in [0, 1) (integer hash; = dissolveNoise in blend-modes.ts).
float fx_blendNoise(uvec2 px, uint seed) {
  uint h = (px.x * 0x8da6b343u) ^ (px.y * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
  h = h ^ (h >> 13u);
  h = h * 0x5bd1e995u;
  h = h ^ (h >> 15u);
  return float(h & 0x00ffffffu) / 16777216.0;
}
// Composites a premultiplied source (opacity included) onto a premultiplied destination with a clip blend mode.
vec4 fx_layerBlend(int mode, vec4 dst, vec4 src, float noise) {
  float sa = src.a;
  float da = dst.a;
  if (mode == FX_LAYER_NORMAL) return src + dst * (1.0 - sa);
  if (mode == FX_LAYER_DISSOLVE) {
    if (sa <= 0.0 || noise >= sa) return dst;
    return vec4(src.rgb / sa, 1.0);
  }
  if (mode == FX_LAYER_STENCIL_ALPHA) return dst * sa;
  if (mode == FX_LAYER_SILHOUETTE_ALPHA) return dst * (1.0 - sa);
  if (mode == FX_LAYER_STENCIL_LUMA) return dst * fx_bl_luma709(src.rgb);
  if (mode == FX_LAYER_SILHOUETTE_LUMA) return dst * (1.0 - fx_bl_luma709(src.rgb));
  if (mode == FX_LAYER_ALPHA_ADD) return vec4(src.rgb + dst.rgb * (1.0 - sa), min(sa + da, 1.0));
  if (sa <= 0.0) return dst;
  if (da <= 0.0) return src;
  vec3 cs = src.rgb / sa;
  vec3 cb = dst.rgb / da;
  if (!fx_bl_hdr(mode)) { cs = clamp(cs, 0.0, 1.0); cb = clamp(cb, 0.0, 1.0); }
  vec3 b = fx_layerBlendRgb(mode, cb, cs);
  return vec4((1.0 - da) * src.rgb + (1.0 - sa) * dst.rgb + sa * da * b, sa + da - sa * da);
}
// A composited pixel as stored between layers (= clampPremul): alpha 0..1, colour 0..alpha.
vec4 fx_clampPremul(vec4 c) { float a = clamp(c.a, 0.0, 1.0); return vec4(clamp(c.rgb, vec3(0.0), vec3(a)), a); }
// FX_BLEND_* (16…) → layer mode.
int fx_blendLayerMode(int mode) {
${appended}
  return FX_LAYER_NORMAL;
}
`,
};

export const GLSL_BLEND: GlslChunk = {
	name: 'fx/blend',
	deps: [GLSL_LAYER_BLEND],
	source: /* glsl */ `
vec3 fx_overlayRgb(vec3 b, vec3 t) { return mix(2.0 * b * t, 1.0 - 2.0 * (1.0 - b) * (1.0 - t), step(0.5, b)); }
vec3 fx_softLightRgb(vec3 b, vec3 t) {
  vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
  return mix(b - (1.0 - 2.0 * t) * b * (1.0 - b), b + (2.0 * t - 1.0) * (d - b), step(0.5, t));
}
// Straight-colour blend; the whole-pixel modes (Dissolve, the stencils, Alpha Add) need alpha: use fx_blend for them
// (here they return the top colour).
vec3 fx_blendRgb(int mode, vec3 b, vec3 t) {
  if (mode == FX_BLEND_ADD) return min(b + t, vec3(1.0));
  if (mode == FX_BLEND_SCREEN) return b + t - b * t;
  if (mode == FX_BLEND_MULTIPLY) return b * t;
  if (mode == FX_BLEND_OVERLAY) return fx_overlayRgb(b, t);
  if (mode == FX_BLEND_SOFT_LIGHT) return fx_softLightRgb(b, t);
  if (mode == FX_BLEND_HARD_LIGHT) return fx_overlayRgb(t, b);
  if (mode == FX_BLEND_COLOR_DODGE) return mix(min(vec3(1.0), b / max(1.0 - t, vec3(1.0e-5))), vec3(1.0), step(1.0, t)) * step(1.0e-5, b);
  if (mode == FX_BLEND_COLOR_BURN) return mix(1.0 - min(vec3(1.0), (1.0 - b) / max(t, vec3(1.0e-5))), vec3(1.0), step(1.0, b));
  if (mode == FX_BLEND_LINEAR_BURN) return max(b + t - 1.0, vec3(0.0));
  if (mode == FX_BLEND_LIGHTEN) return max(b, t);
  if (mode == FX_BLEND_DARKEN) return min(b, t);
  if (mode == FX_BLEND_DIFFERENCE) return abs(b - t);
  if (mode == FX_BLEND_EXCLUSION) return b + t - 2.0 * b * t;
  if (mode == FX_BLEND_SUBTRACT) return max(b - t, vec3(0.0));
  if (mode == FX_BLEND_DIVIDE) return min(vec3(1.0), b / max(t, vec3(1.0e-5)));
  if (mode >= FX_BLEND_DISSOLVE) {
    int l = fx_blendLayerMode(mode);
    if (l == FX_LAYER_DISSOLVE || l >= FX_LAYER_STENCIL_ALPHA) return t;
    return fx_layerBlendRgb(l, clamp(b, 0.0, 1.0), clamp(t, 0.0, 1.0));
  }
  return t;
}
// Premultiplied source-over.
vec4 fx_over(vec4 top, vec4 base) { return top + base * (1.0 - top.a); }
// Premultiplied blend of top over base with a blend mode and an opacity 0..1 (W3C: B(cb, cs) where both exist). The
// appended modes composite like clips (fx_layerBlend); Dissolve's noise is per canvas pixel, seeded by u_seed.
vec4 fx_blend(int mode, vec4 base, vec4 top, float opacity) {
  top *= clamp(opacity, 0.0, 1.0);
  if (mode == FX_BLEND_NORMAL) return fx_over(top, base);
  if (mode >= FX_BLEND_DISSOLVE) {
    uvec2 px = uvec2(max(floor(v_uv * u_canvasSize), vec2(0.0)));
    return fx_layerBlend(fx_blendLayerMode(mode), base, top, fx_blendNoise(px, uint(u_seed * 16777216.0)));
  }
  vec3 cb = base.a > 0.0 ? base.rgb / base.a : vec3(0.0);
  vec3 cs = top.a > 0.0 ? top.rgb / top.a : vec3(0.0);
  vec3 mixed = (1.0 - base.a) * cs + base.a * fx_blendRgb(mode, cb, cs);
  return vec4(top.a * mixed + (1.0 - top.a) * base.rgb, top.a + base.a * (1.0 - top.a));
}
// Additive light (glows, flares, rays): adds premultiplied light, alpha grows with the light's luminance.
vec4 fx_addLight(vec4 base, vec3 light) {
  vec3 rgb = base.rgb + light;
  return vec4(rgb, clamp(max(base.a, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0));
}
`,
};

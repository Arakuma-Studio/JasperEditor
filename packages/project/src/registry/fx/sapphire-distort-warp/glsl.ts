// Family-private GLSL of the Sapphire Distort family (fx catalogue, wave 2).
//
// Coordinates ("frame units", Sapphire's convention with the editor's y-down axis): origin at the centre of the
// layer box, 1 = the layer width, y down (so y spans ±aspect/2, aspect = height / width). Radii use `dw_unit()` =
// half the smaller side of the layer (Sapphire-style radius defaults such as 0.4 then read as "40 % of the half
// height" on landscape frames).
//
// Wrap ("Wrap" popups, per axis): No (transparent beyond the layer), Tile, Reflect. Outside the layer box (padding
// area) a warp only shows content that really moves there (No), never tiles.
//
// Warps are written as `vec2 dw_warp(vec2 f)` (output frame position → source frame position) and
// `vec4 dw_shade(vec2 f, ivec2 wrap)` (the output colour at f; usually `dw_tap(dw_warp(f), wrap)`). `dw_render`
// supersamples dw_shade adaptively ("Filter"): it measures the warp's footprint with finite differences and takes
// up to N×N samples where the warp minifies or folds (antialiased edges of magnifiers, centres of polar/vortex warps).
import type { GlslChunk } from '../shader.ts';

/** Wrap option values in GLSL index order. */
export const DW_WRAP_OPTIONS = ['no', 'tile', 'reflect'] as const;
export const DW_WRAP_LABELS = ['No', 'Tile', 'Reflect'] as const;

export const GLSL_DW: GlslChunk = {
	name: 'sapphire-distort-warp/core',
	source: /* glsl */ `
const int DW_NO = 0;
const int DW_TILE = 1;
const int DW_REFLECT = 2;
const float DW_PI = 3.14159265358979;
const float DW_TAU = 6.28318530717959;
const vec3 DW_LUMA = vec3(0.2126, 0.7152, 0.0722);
float dw_aspect() { return u_box.w / u_box.z; }
// Radius unit: half the smaller side of the layer, in frame units.
float dw_unit() { return 0.5 * min(1.0, dw_aspect()); }
vec2 dw_frameOfUv(vec2 uv) { return (uv * u_canvasSize - u_box.xy - 0.5 * u_box.zw) / u_box.z; }
vec2 dw_frame() { return dw_frameOfUv(v_uv); }
vec2 dw_normOfFrame(vec2 f) { return vec2(f.x + 0.5, f.y / dw_aspect() + 0.5); }
vec2 dw_frameOfNorm(vec2 n) { return vec2(n.x - 0.5, (n.y - 0.5) * dw_aspect()); }
vec2 dw_uvOfFrame(vec2 f) { return fx_uvOfLayerNorm(dw_normOfFrame(f)); }
// One canvas pixel in frame units.
float dw_px() { return 1.0 / u_box.z; }
bool dw_inBoxF(vec2 f) {
  vec2 n = dw_normOfFrame(f);
  return all(greaterThanEqual(n, vec2(0.0))) && all(lessThanEqual(n, vec2(1.0)));
}
// Rotation by degrees, clockwise on screen (y down).
mat2 dw_rot(float deg) { float a = radians(deg); float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float dw_wrap1(float x, int m) {
  if (m == DW_TILE) return fract(x);
  if (m == DW_REFLECT) { float t = mod(x, 2.0); return t > 1.0 ? 2.0 - t : t; }
  return x;
}
// 1 inside [0,1], 0 outside, a one-pixel ramp across the edge (antialiased hard edges).
float dw_cov1(float n, float sizePx) { return clamp(min(n, 1.0 - n) * sizePx + 0.5, 0.0, 1.0); }
// The source picture at frame position f (premultiplied), with a wrap mode per axis.
vec4 dw_tap(vec2 f, ivec2 wrap) {
  vec2 n = dw_normOfFrame(f);
  if (wrap.x == DW_NO && wrap.y == DW_NO) {
    // The whole canvas: keeps what earlier effects drew into their padding.
    vec2 uv = fx_uvOfLayerNorm(n);
    float c = dw_cov1(uv.x, u_canvasSize.x) * dw_cov1(uv.y, u_canvasSize.y);
    return c > 0.0 ? texture(u_source, clamp(uv, vec2(0.0), vec2(1.0))) * c : vec4(0.0);
  }
  float cov = 1.0;
  if (wrap.x == DW_NO) cov *= dw_cov1(n.x, u_box.z); else n.x = dw_wrap1(n.x, wrap.x);
  if (wrap.y == DW_NO) cov *= dw_cov1(n.y, u_box.w); else n.y = dw_wrap1(n.y, wrap.y);
  if (cov <= 0.0) return vec4(0.0);
  vec2 lim = 0.5 / u_box.zw;
  return texture(u_source, fx_uvOfLayerNorm(clamp(n, lim, 1.0 - lim))) * cov;
}
// The wrap that applies at output position f: the effect's inside the layer box, No in the padding.
ivec2 dw_wrapAt(vec2 f, ivec2 wrap) { return dw_inBoxF(f) ? wrap : ivec2(DW_NO); }
// Spectrum weights from Color1 (t = 0) over Color2 (t = 0.5) to Color3 (t = 1): Bernstein weights, which sum to
// white over a uniform sweep when the colours are pure red, green and blue.
vec3 dw_spectrum(float t, vec3 c1, vec3 c2, vec3 c3) {
  float a = (1.0 - t) * (1.0 - t), b = 2.0 * t * (1.0 - t), c = t * t;
  return c1 * a + c2 * b + c3 * c;
}
`,
};

/**
 * Adaptive supersampling of `dw_shade` (the effect defines `dw_warp` and `dw_shade` after including this chunk).
 * `maxN` caps the samples per axis (≤ 4).
 */
export const GLSL_DW_RENDER: GlslChunk = {
	name: 'sapphire-distort-warp/render',
	deps: [GLSL_DW],
	source: /* glsl */ `
vec2 dw_warp(vec2 f);
vec4 dw_shade(vec2 f, ivec2 wrap);
// Source pixels covered by one output pixel at f (1 = no minification; large at folds and discontinuities).
float dw_footprint(vec2 f) {
  float h = dw_px();
  vec2 s = dw_warp(f);
  vec2 sx = dw_warp(f + vec2(h, 0.0)) - s;
  vec2 sy = dw_warp(f + vec2(0.0, h)) - s;
  float fp = max(length(sx), length(sy)) / h;
  return (isnan(fp) || isinf(fp)) ? 16.0 : fp; // a broken warp counts as a discontinuity
}
vec4 dw_render(ivec2 wrap, bool filt, int maxN) {
  vec2 f = dw_frame();
  ivec2 w = dw_wrapAt(f, wrap);
  if (!filt) return dw_shade(f, w);
  int n = int(clamp(ceil(dw_footprint(f) - 0.25), 1.0, float(min(maxN, 4))));
  if (n <= 1) return dw_shade(f, w);
  float h = dw_px();
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    if (j >= n) break;
    for (int i = 0; i < 4; i++) {
      if (i >= n) break;
      vec2 o = ((vec2(float(i), float(j)) + 0.5) / float(n) - 0.5) * h;
      acc += dw_shade(f + o, w);
    }
  }
  return acc / float(n * n);
}
`,
};

/**
 * The Lens of S_Distort / S_DistortBlur / S_DistortChroma / S_DistortRGB / S_WarpPuff: its blurred luminance is the
 * pass output `lensB` (see `lensPasses`); these read it and its gradient (luminance per frame width).
 */
export const GLSL_DW_LENS: GlslChunk = {
	name: 'sapphire-distort-warp/lens',
	deps: [GLSL_DW],
	source: /* glsl */ `
float dw_lensAt(vec2 f) { return texture(u_lensB, dw_uvOfFrame(f)).r; }
vec2 dw_lensGrad(vec2 f) {
  float h = dw_px() * 1.5;
  return vec2(dw_lensAt(f + vec2(h, 0.0)) - dw_lensAt(f - vec2(h, 0.0)),
              dw_lensAt(f + vec2(0.0, h)) - dw_lensAt(f - vec2(0.0, h))) / (2.0 * h);
}
`,
};

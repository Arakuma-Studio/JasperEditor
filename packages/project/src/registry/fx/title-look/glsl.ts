// Spec 19 TL-031 / TL-032: the GLSL every look pass shares: the surface a layer shades, unit conversion, the shape
// field and the linear-light composite. Pass sources are built in `plan.ts` from these chunks and the layer files.
// Seed estimation and the flood follow Pachislop's effects/lib.ts `sdf()` (licenses/ported/pachislop-rendering.md); the
// input here is the layer's alpha, whose edges and opacities animate, so the threshold is local (see `GLSL_TL_ALPHA`).
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import type { GlslChunk } from '../shader.ts';

/** Faintest local opacity that counts as shape: below it a part of the picture has no edge yet. */
const FLOOR = '0.02';

/** The surface a layer shades, and helpers. `s.d`: + outside the shape, − inside, canvas px. */
export const GLSL_TL_SURFACE: GlslChunk = {
	name: 'title-look/surface',
	deps: [GLSL_COLOR, GLSL_UV],
	source: /* glsl */ `
struct TlSurface {
  vec2 uv;        // canvas uv, (0,0) top-left
  vec2 px;        // canvas px
  float d;        // signed distance to the shape edge, canvas px, + outside
  float opacity;  // opacity of the nearest part of the shape (a fading glyph's rim fades with it)
  vec2 toEdge;    // canvas px from here to the nearest edge point
  float base;     // canvas px: growth of the silhouette by the layers above this one
  float alpha;    // the input's alpha here
};
// Antialiasing width in canvas px: one pixel of the pass being drawn (a mask at reduced resolution sets it wider).
float tl_aa = 1.0;
// 1 inside the band a..b of distances, antialiased.
float tl_band(float d, float a, float b) {
  return clamp((b - d) / tl_aa + 0.5, 0.0, 1.0) * clamp((d - a) / tl_aa + 0.5, 0.0, 1.0);
}
// 1 where d < edge, antialiased.
float tl_inside(float d, float edge) { return clamp((edge - d) / tl_aa + 0.5, 0.0, 1.0); }
vec4 tl_over(vec4 under, vec4 top) { return top + under * (1.0 - top.a); }
vec3 tl_linear(vec3 srgb) { return fx_srgbToLinear(clamp(srgb, 0.0, 1.0)); }
`,
};

/** Unit when the planner knows it (text clips: the text size): one uniform, no texture read. */
export const GLSL_TL_UNIT_KNOWN: GlslChunk = {
	name: 'title-look/unit-known',
	source: /* glsl */ `
float tl_unit() { return u_tlUnit; }
float tl_px(float percent) { return percent * 0.01 * u_tlUnit; }
`,
};

/** The alpha bounds, canvas px (x0, y0, x1, y1): the reduction's 1×1 result. */
export const GLSL_TL_BOUNDS: GlslChunk = {
	name: 'title-look/bounds',
	source: /* glsl */ `
vec4 tl_bounds() {
  vec4 m = texelFetch(u_tlBounds, ivec2(0), 0);
  if (m.x + m.z < -1.0e8) return vec4(0.0, 0.0, u_canvasSize);
  return vec4(-m.x, -m.y, m.z, m.w);
}
`,
};

/** Unit from the alpha bounds (TL-012, every clip kind but text). */
export const GLSL_TL_UNIT_BOUNDS: GlslChunk = {
	name: 'title-look/unit-bounds',
	deps: [GLSL_TL_BOUNDS],
	source: /* glsl */ `
float tl_unit() { vec4 b = tl_bounds(); return max(1.0, min(b.z - b.x, b.w - b.y)); }
float tl_px(float percent) { return percent * 0.01 * tl_unit(); }
`,
};

/** Reads of the field and the input as a `TlSurface`. Needs a unit chunk. */
export const GLSL_TL_FIELD: GlslChunk = {
	name: 'title-look/field',
	deps: [GLSL_TL_SURFACE],
	source: /* glsl */ `
TlSurface tl_surfaceAt(vec2 uv) {
  vec4 f = texture(u_tlField, uv);
  TlSurface s;
  s.uv = uv;
  s.px = uv * u_canvasSize;
  s.d = f.x;
  s.opacity = f.y;
  s.toEdge = f.zw;
  s.base = tl_px(u_tlBase);
  s.alpha = texture(u_source, uv).a;
  return s;
}
TlSurface tl_surface() { return tl_surfaceAt(v_uv); }
// The input picture as straight linear colour (alpha in .a), the 'source' paint.
vec4 tl_sourceLinear(vec2 uv) {
  vec4 c = texture(u_source, uv);
  return c.a > 0.0 ? vec4(tl_linear(c.rgb / c.a), c.a) : vec4(0.0);
}
`,
};

/** Paint helpers: a 256-entry ramp of premultiplied linear colours and gradient positions. */
export const GLSL_TL_PAINT: GlslChunk = {
	name: 'title-look/paint',
	deps: [GLSL_DATA, GLSL_TL_BOUNDS, GLSL_TL_SURFACE],
	source: /* glsl */ `
vec4 tl_ramp(highp sampler2D t, float x) {
  float g = clamp(x, 0.0, 1.0) * 255.0;
  int i = int(floor(g));
  return mix(fx_texel(t, i), fx_texel(t, min(i + 1, 255)), g - float(i));
}
// Position along a gradient: 0 linear (dir = rotated unit vector), 1 radial, 2 sweep, 3 shape (from the edge inward).
float tl_gradientPos(int kind, vec2 dir, float angle, float depth, TlSurface s) {
  vec4 b = tl_bounds();
  vec2 size = max(b.zw - b.xy, vec2(1.0));
  vec2 c = (b.xy + b.zw) * 0.5;
  vec2 q = s.px - c;
  if (kind == 0) return dot(q, dir) / max(abs(dir.x) * size.x + abs(dir.y) * size.y, 1.0) + 0.5;
  if (kind == 1) return length(q / (size * 0.5));
  if (kind == 2) return fract((atan(q.y, q.x) - angle) / FX_TAU);
  return clamp(-s.d / max(depth, 1.0), 0.0, 1.0);
}
`,
};

/** The alpha read of the seed and field passes: the shape edge sits at half the local peak opacity. */
export const GLSL_TL_ALPHA: GlslChunk = {
	name: 'title-look/alpha',
	source: /* glsl */ `
const float TL_FLOOR = ${FLOOR};
float tl_a(ivec2 q, ivec2 sz) { return texelFetch(u_source, clamp(q, ivec2(0), sz - 1), 0).a; }
// The brightest alpha of the 5×5 around q. A glyph fading in at 30 % has its edge at 20 %, not at a fixed 50 %, so its
// rim fades in with it instead of popping when it crosses a threshold (per-character opacity animators). Two pixels of
// reach: the outer pixels of a 2 px antialiased ramp must see the solid interior, else they read as a faint shape of
// their own and seed a false edge outside the true one.
float tl_peak(ivec2 p, ivec2 sz) {
  float m = 0.0;
  for (int y = -2; y <= 2; y++)
    for (int x = -2; x <= 2; x++) m = max(m, tl_a(p + ivec2(x, y), sz));
  return m;
}
// Antialiased edges are up to 2 px wide and thin strokes never reach full alpha: from 75 % up a part of the picture
// counts as solid, so its edge sits at the usual 50 % and solid text has one threshold everywhere.
float tl_threshold(float peak) { return 0.5 * min(peak / 0.75, 1.0); }
// What a rim around this part of the picture inherits: full from 50 % local alpha up, so thin strokes keep solid rims.
float tl_opacity(float peak) { return clamp(peak * 2.0, 0.0, 1.0); }
`,
};

/** First flood pass: sub-pixel edge points (x, y in canvas px, opacity, 1), or 0 away from an edge. */
export const FRAG_TL_SEED = /* glsl */ `
vec2 tl_size;
float tl_aBilinear(vec2 p) { return texture(u_source, clamp(p, vec2(0.5), tl_size - 0.5) / tl_size).a; }
void main() {
  ivec2 sz = textureSize(u_source, 0);
  tl_size = vec2(sz);
  ivec2 ip = ivec2(floor(v_uv * tl_size));
  float a = tl_a(ip, sz);
  float l = tl_a(ip + ivec2(-1, 0), sz), r = tl_a(ip + ivec2(1, 0), sz);
  float t = tl_a(ip + ivec2(0, -1), sz), b = tl_a(ip + ivec2(0, 1), sz);
  // Flat alpha, inside or out: no edge here, and most of the canvas stops at these five reads.
  float hi = max(a, max(max(l, r), max(t, b)));
  float lo = min(a, min(min(l, r), min(t, b)));
  if (hi < TL_FLOOR || hi - lo < 0.002) { fragColor = vec4(0.0); return; }
  float peak = tl_peak(ip, sz);
  float th = tl_threshold(peak);
  bool inside = a >= th;
  if ((l >= th) == inside && (r >= th) == inside && (t >= th) == inside && (b >= th) == inside) {
    fragColor = vec4(0.0);
    return;
  }
  vec2 p = vec2(ip) + 0.5;
  float tl = tl_a(ip + ivec2(-1, -1), sz), tr = tl_a(ip + ivec2(1, -1), sz);
  float bl = tl_a(ip + ivec2(-1, 1), sz), br = tl_a(ip + ivec2(1, 1), sz);
  // Sobel gradient of alpha: the normal pointing into the shape.
  vec2 g = vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, bl + 2.0 * b + br - tl - 2.0 * t - tr);
  if (dot(g, g) < 1.0e-8) { fragColor = vec4(p, tl_opacity(peak), 1.0); return; }
  vec2 n = normalize(g);
  // Alpha slope per px along n, the steeper one-sided difference: edges arrive 1 to 2 px wide.
  float slope = max(max(tl_aBilinear(p + n) - a, a - tl_aBilinear(p - n)), 1.0e-3);
  fragColor = vec4(p - n * clamp((a - th) / slope, -1.0, 1.0), tl_opacity(peak), 1.0);
}`;

/** One jump-flood step (`u_tlStep` px). The same text for every step: one program. */
export const FRAG_TL_FLOOD = /* glsl */ `
void main() {
  ivec2 res = textureSize(u_tlFlood, 0);
  ivec2 ip = ivec2(floor(v_uv * vec2(res)));
  vec2 p = vec2(ip) + 0.5;
  int stride = int(u_tlStep);
  vec4 best = vec4(0.0);
  float dBest = 1.0e20;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 q = ip + ivec2(x, y) * stride;
      if (q.x < 0 || q.y < 0 || q.x >= res.x || q.y >= res.y) continue;
      vec4 s = texelFetch(u_tlFlood, q, 0);
      if (s.w < 0.5) continue;
      vec2 v = s.xy - p;
      float d = dot(v, v);
      if (d < dBest) { dBest = d; best = s; }
    }
  fragColor = best;
}`;

/** The shape field (rgba16f): signed distance, opacity of the nearest edge, vector to it. */
export const FRAG_TL_FIELD = /* glsl */ `
void main() {
  ivec2 sz = textureSize(u_source, 0);
  ivec2 ip = ivec2(floor(v_uv * vec2(sz)));
  vec2 p = vec2(ip) + 0.5;
  vec4 s = texelFetch(u_tlFlood, ip, 0);
  float a = tl_a(ip, sz);
  // Only partial alpha needs its surroundings: solid and empty pixels answer at once.
  float peak = (a <= 0.0 || a >= 0.75) ? a : tl_peak(ip, sz);
  bool inside = peak >= TL_FLOOR && a >= tl_threshold(peak);
  bool seeded = s.w > 0.5;
  vec2 toEdge = seeded ? s.xy - p : vec2(0.0);
  float d = seeded ? length(toEdge) : u_tlReach;
  fragColor = vec4(inside ? -d : d, seeded ? s.z : (inside ? tl_opacity(peak) : 0.0), toEdge);
}`;

/** First bounds reduction: 8×8 blocks of the input to (−x0, −y0, x1, y1), −1e9 where empty. */
export const FRAG_TL_BOUNDS_FIRST = /* glsl */ `
void main() {
  ivec2 sz = textureSize(u_source, 0);
  ivec2 base = ivec2(floor(v_uv * u_resolution)) * 8;
  vec4 m = vec4(-1.0e9);
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++) {
      ivec2 q = base + ivec2(x, y);
      if (q.x >= sz.x || q.y >= sz.y) continue;
      if (texelFetch(u_source, q, 0).a >= 0.02) m = max(m, vec4(-vec2(q), vec2(q) + 1.0));
    }
  fragColor = m;
}`;

/** Later reductions: 8×8 blocks of the previous step. */
export const FRAG_TL_BOUNDS_NEXT = /* glsl */ `
void main() {
  ivec2 sz = textureSize(u_tlBounds, 0);
  ivec2 base = ivec2(floor(v_uv * u_resolution)) * 8;
  vec4 m = vec4(-1.0e9);
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++) {
      ivec2 q = base + ivec2(x, y);
      if (q.x >= sz.x || q.y >= sz.y) continue;
      m = max(m, texelFetch(u_tlBounds, q, 0));
    }
  fragColor = m;
}`;

/** The composite so far, back to the framework's signal: sRGB-encoded, premultiplied (TL-032). */
export const FRAG_TL_OUTPUT = /* glsl */ `
void main() {
  vec4 c = texture(u_tlComp, v_uv);
  float a = clamp(c.a, 0.0, 1.0);
  vec4 look = a > 0.0 ? vec4(fx_linearToSrgb(clamp(c.rgb / a, 0.0, 1.0)) * a, a) : vec4(0.0);
  // TL-089: Intensity shows the clip's own picture through the look, both premultiplied signal.
  fragColor = mix(texture(u_source, v_uv), look, clamp(u_lookIntensity * 0.01, 0.0, 1.0));
}`;

/** The start of the composite: nothing. */
export const FRAG_TL_CLEAR = /* glsl */ `
void main() { fragColor = vec4(0.0); }`;

/** One axis of the blur of `tlMask` (`u_tlBlurDir`): sigma in percent of the unit, at the resolution of the pass. */
const blurAxis = (tex: string) => /* glsl */ `
void main() {
  vec2 size = vec2(textureSize(${tex}, 0));
  float sigma = tl_px(u_tlBlurSigma) * size.x / u_canvasSize.x;
  if (sigma < 0.05) { fragColor = texture(${tex}, v_uv); return; }
  float radius = ceil(sigma * 3.0);
  float stride = max(1.0, radius / 32.0);
  vec4 sum = texture(${tex}, v_uv);
  float wsum = 1.0;
  for (int i = 1; i <= 32; i++) {
    float x = float(i) * stride;
    if (x > radius) break;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    vec2 o = u_tlBlurDir * x / size;
    sum += (texture(${tex}, v_uv + o) + texture(${tex}, v_uv - o)) * w;
    wsum += 2.0 * w;
  }
  fragColor = sum / wsum;
}`;

export const FRAG_TL_BLUR_H = blurAxis('u_tlMask');
export const FRAG_TL_BLUR_V = blurAxis('u_tlBlurH');

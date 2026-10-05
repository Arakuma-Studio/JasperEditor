// Family-private GLSL of the Sapphire film / grain / damage family (registry/fx/sapphire-film-grain.ts): film grain,
// dust, hairs, scratches, splotches, vignettes, colour fades and the video-damage helpers shared by several effects
// of the family. Every random pattern is a pure function of (pixel, frame, u_seed) through the integer hashes and
// noises of fx/hash and fx/noise, so the Player, stills and parallel renders draw identical pixels.
// Conventions: positions are LAYER pixels (fx_layerPx(); scale-independent of u_pxScale), colours straight RGB.
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';
import type { GlslChunk } from '../shader.ts';

/** Grain, film dirt and vignette helpers (`sfg_*`). */
export const GLSL_FILM: GlslChunk = {
	name: 'sapphire-film-grain/film',
	deps: [GLSL_HASH, GLSL_NOISE, GLSL_COLOR],
	source: /* glsl */ `
// A seed for frame f (and layer k): every frame draws an independent pattern.
float sfg_frameSeed(float seed, float frame, float k) {
  return fx_hash3(ivec3(int(floor(frame)), int(k), 911), seed);
}
// Gaussian-like zero-mean noise (sd ≈ 1) of a lattice point: sum of 4 uniform hashes (Irwin–Hall).
float sfg_gauss(ivec2 p, float seed) {
  float s = fx_hash2(p, seed) + fx_hash2(p + ivec2(5113, 0), seed)
          + fx_hash2(p + ivec2(0, 7177), seed) + fx_hash2(p + ivec2(3307, 9901), seed);
  return (s - 2.0) * 1.7320508;
}
// Smoothly interpolated Gaussian lattice noise (sd ≈ 0.6 between lattice points, 1.0 on them).
float sfg_gaussNoise(vec2 p, float seed) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = sfg_gauss(i, seed), b = sfg_gauss(i + ivec2(1, 0), seed);
  float c = sfg_gauss(i + ivec2(0, 1), seed), d = sfg_gauss(i + ivec2(1, 1), seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Film grain of a given size (layer px, ≈ the grain clump diameter) at layer px p; zero mean, sd ≈ 1.
// Sizes ≤ 1 px are per-pixel noise; bigger grains are band-limited (two octaves so they stay grainy, not blobby).
float sfg_grain(vec2 p, float size, float seed) {
  float s = max(size, 0.05);
  if (s <= 1.0) {
    float w = sfg_gauss(ivec2(floor(p / s)), seed);
    return w;
  }
  vec2 q = p / s;
  float n = sfg_gaussNoise(q, seed) * 0.8 + sfg_gaussNoise(q * 2.13 + 31.7, fract(seed + 0.371)) * 0.45;
  return n * 1.35;
}
// Per-channel grain (r, g, b independent) mixed with a shared monochrome grain by colorCorr (0 = independent,
// 1 = monochrome), sizes per channel.
vec3 sfg_grainRgb(vec2 p, vec3 size, float colorCorr, float seed) {
  float m = sfg_grain(p, (size.r + size.g + size.b) / 3.0, fract(seed + 0.731));
  vec3 c = vec3(sfg_grain(p, size.r, seed), sfg_grain(p, size.g, fract(seed + 0.137)), sfg_grain(p, size.b, fract(seed + 0.519)));
  return mix(c, vec3(m), clamp(colorCorr, 0.0, 1.0));
}
// Grain response to the picture's brightness (film grain is strongest in the mid-tones): weights for shadows,
// mid-tones and highlights blended by luma.
float sfg_toneWeight(float luma, float shadows, float mids, float highs) {
  float l = clamp(luma, 0.0, 1.0);
  float ws = 1.0 - smoothstep(0.0, 0.5, l);
  float wh = smoothstep(0.5, 1.0, l);
  float wm = 1.0 - ws - wh;
  return ws * shadows + wm * mids + wh * highs;
}
// Soft elliptical vignette factor: 1 inside, 0 at the edges. n = layer norm (0..1), center normalised,
// radius (fraction of the half-diagonal), softness 0..1, aspect (>1 = wider).
float sfg_vignette(vec2 n, vec2 center, float radius, float softness, float aspect, vec2 boxSize) {
  vec2 d = (n - center) * boxSize / length(boxSize * 0.5);
  d.x /= max(aspect, 1.0e-3);
  float r = length(d);
  float s = max(softness, 1.0e-3);
  return 1.0 - smoothstep(radius * (1.0 - s), radius * (1.0 + s * 0.5) + 1.0e-3, r);
}

// --- Sapphire conventions -------------------------------------------------------------------------------------
// Layer box size in layer px.
vec2 sfg_boxPx() { return u_box.zw / u_pxScale; }
// Sapphire centred units of a layer px position: x −1..1 over the width, y up, same scale (half widths).
vec2 sfg_sapph(vec2 layerPx) { vec2 b = sfg_boxPx(); vec2 d = (layerPx - b * 0.5) / (b.x * 0.5); return vec2(d.x, -d.y); }
// Sapphire film vignette (Darkness, Radius, Edge Softness, Rel Height): multiplier 1 − darkness at the edges.
float sfg_filmVignette(vec2 layerPx, float darkness, float radius, float softness, float relHeight) {
  if (darkness <= 0.0) return 1.0;
  vec2 s = sfg_sapph(layerPx);
  float d = length(s / vec2(1.0, max(relHeight, 0.05))) / max(radius, 1.0e-3);
  float soft = max(softness, 1.0e-3);
  float t = clamp((d - (1.0 - 0.5 * soft)) / soft, 0.0, 1.0);
  return 1.0 - clamp(darkness, 0.0, 1.0) * t * t * (3.0 - 2.0 * t);
}
// Sapphire grain amplitude curve per channel: Darks at black → Mids at the midtone position → Brights at white.
vec3 sfg_grainCurve(vec3 c, float darks, float mids, float brights, vec3 midPos) {
  vec3 m = clamp(midPos, 0.01, 0.99);
  vec3 v = clamp(c, 0.0, 1.0);
  vec3 lo = mix(vec3(darks), vec3(mids), v / m);
  vec3 hi = mix(vec3(mids), vec3(brights), (v - m) / (1.0 - m));
  return mix(lo, hi, step(m, v));
}
// Zero-mean grain noise per channel (sd ≈ 1) with per-channel feature sizes (layer px); mono = one pattern.
vec3 sfg_grainNoise(vec2 p, vec3 sizePx, bool mono, float seed) {
  if (mono) return vec3(sfg_grain(p, sizePx.g, seed));
  return vec3(sfg_grain(p, sizePx.r, seed), sfg_grain(p, sizePx.g, fract(seed + 0.137)), sfg_grain(p, sizePx.b, fract(seed + 0.519)));
}

// Sapphire "Scale Lights" / "Offset Darks": multiply, then lift (offset > 0) or crush (offset < 0) the darks.
vec3 sfg_lights(vec3 c, float scaleLights, float offsetDarks) {
  return c * scaleLights + offsetDarks * 0.1 * (1.0 - clamp(c, 0.0, 1.0));
}
// Straight result → premultiplied with the source alpha, mixed with the original.
vec4 sfg_out(vec3 c, vec4 src, float mixWithOriginal) {
  vec4 r = vec4(clamp(c, 0.0, 1.0) * src.a, src.a);
  return mix(r, src, clamp(mixWithOriginal, 0.0, 1.0));
}

// --- film dirt ----------------------------------------------------------------------------------------------
// Dust: irregular specks scattered in cells of cellPx; density 0..1 = probability of a speck per cell; size in px.
// Returns coverage 0..1 at layer px p for the frame seed.
float sfg_dust(vec2 p, float cellPx, float density, float size, float seed) {
  if (density <= 0.0) return 0.0;
  vec2 q = p / cellPx;
  ivec2 c = ivec2(floor(q));
  float cov = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 cc = c + ivec2(x, y);
      vec3 h = fx_hash33(ivec3(cc, 3), seed);
      if (h.z > density) continue;
      vec2 centre = (vec2(cc) + h.xy) * cellPx;
      float r = size * (0.35 + 1.3 * fx_hash2(cc + ivec2(17, 3), seed) * fx_hash2(cc + ivec2(5, 41), seed));
      vec2 d = p - centre;
      // irregular outline: wobble the radius with angle-dependent noise; elongate some specks
      float ang = atan(d.y, d.x);
      float e = 1.0 + 1.6 * fx_hash2(cc + ivec2(9, 9), seed) * step(0.7, fx_hash2(cc + ivec2(2, 7), seed));
      float rot = fx_hash2(cc + ivec2(13, 1), seed) * 6.2831853;
      vec2 dr = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * d;
      dr.x /= e;
      float wob = 1.0 + 0.35 * fx_valueNoise(vec2(ang * 1.6, float(cc.x * 7 + cc.y)), seed);
      float dist = length(dr) / max(r * wob, 0.3);
      cov = max(cov, 1.0 - smoothstep(0.6, 1.0, dist));
    }
  return cov;
}
// Distance from p to a quadratic Bézier (a, b, c), approximated by 12 line segments.
float sfg_bezierDist(vec2 p, vec2 a, vec2 b, vec2 c) {
  float best = 1.0e9;
  vec2 prev = a;
  for (int i = 1; i <= 12; i++) {
    float t = float(i) / 12.0;
    vec2 q = mix(mix(a, b, t), mix(b, c, t), t);
    vec2 pa = p - prev, ba = q - prev;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-6), 0.0, 1.0);
    best = min(best, length(pa - ba * h));
    prev = q;
  }
  return best;
}
// Hairs: up to 6 curly fibres on the frame (count 0..6 fractional = probability of the last), length in px,
// width in px. Returns coverage 0..1.
float sfg_hairs(vec2 p, vec2 boxSize, float count, float len, float width, float seed) {
  float cov = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    if (fi >= ceil(count)) break;
    vec4 h = vec4(fx_hash1(i * 4 + 1, seed), fx_hash1(i * 4 + 2, seed), fx_hash1(i * 4 + 3, seed), fx_hash1(i * 4 + 4, seed));
    if (fi + 1.0 > count && h.w > fract(count)) continue;
    vec2 a = h.xy * boxSize;
    float ang = h.z * 6.2831853;
    float l = len * (0.5 + h.w);
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 c = a + dir * l;
    vec2 nrm = vec2(-dir.y, dir.x);
    vec2 b = (a + c) * 0.5 + nrm * l * (fx_hash1(i * 4 + 31, seed) - 0.5) * 1.4;
    // quick reject
    vec2 lo = min(min(a, b), c) - width * 2.0, hi = max(max(a, b), c) + width * 2.0;
    if (any(lessThan(p, lo)) || any(greaterThan(p, hi))) continue;
    float d = sfg_bezierDist(p, a, b, c);
    cov = max(cov, 1.0 - smoothstep(width * 0.5, width * 0.5 + 0.8, d));
  }
  return cov;
}
// Vertical scratches: up to 8 lines, persistent over a few frames (life) while they drift sideways and flicker.
// count 0..8, width px, frame. Returns signed intensity (−1 dark .. +1 bright) * coverage.
float sfg_scratches(vec2 p, vec2 boxSize, float count, float width, float frame, float life, float seed, float darkFraction) {
  float acc = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    if (fi >= ceil(count)) break;
    float lf = max(life, 1.0);
    float ph = fx_hash1(i * 7 + 3, seed) * lf;
    float epochF = floor((frame + ph) / lf);
    int epoch = int(epochF);
    float t = fract((frame + ph) / lf);
    vec4 h = vec4(fx_hash3(ivec3(i, epoch, 1), seed), fx_hash3(ivec3(i, epoch, 2), seed), fx_hash3(ivec3(i, epoch, 3), seed), fx_hash3(ivec3(i, epoch, 4), seed));
    if (fi + 1.0 > count && h.w > fract(count)) continue;
    if (h.z < 0.25) continue; // some lines are absent in this epoch
    float x = h.x * boxSize.x + (h.y - 0.5) * 40.0 * t;
    // the scratch wobbles a little along y
    x += fx_valueNoise(vec2(p.y / 90.0, fi * 13.0 + epochF), seed) * 2.5;
    float w = width * (0.6 + 0.8 * h.y);
    float d = abs(p.x - x);
    float cov = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.9, d);
    // broken along its length
    float brk = smoothstep(-0.35, 0.1, fx_valueNoise(vec2(p.y / 60.0, fi * 5.0 + epochF * 3.0), fract(seed + 0.3)));
    float flick = 0.55 + 0.45 * fx_hash3(ivec3(i, int(floor(frame)), 5), seed);
    float sgn = fx_hash3(ivec3(i, epoch, 6), seed) < darkFraction ? -1.0 : 1.0;
    acc += sgn * cov * brk * flick;
  }
  return clamp(acc, -1.0, 1.0);
}
// Large soft blotches (emulsion splotches / water marks): coverage 0..1.
float sfg_splotches(vec2 p, float size, float density, float seed) {
  if (density <= 0.0) return 0.0;
  float n = fx_fbm(p / max(size, 1.0), 3, 2.0, 0.5, seed) * 0.5 + 0.5;
  return smoothstep(1.0 - density * 0.45, 1.0 - density * 0.45 + 0.06, n);
}
// Sepia / faded print look: desaturate towards a tint, lift blacks, lower contrast (amounts 0..1).
vec3 sfg_fadeColor(vec3 c, float desat, vec3 tint, float tintAmt, float fade) {
  float l = fx_luma(c);
  vec3 o = mix(c, vec3(l), clamp(desat, 0.0, 1.0));
  o = mix(o, l * tint * 1.25, clamp(tintAmt, 0.0, 1.0) * 0.85);
  o = mix(o, vec3(0.5) + (o - 0.5) * 0.7 + 0.08, clamp(fade, 0.0, 1.0));
  return o;
}
`,
};

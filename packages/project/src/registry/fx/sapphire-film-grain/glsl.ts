// Family-private GLSL of the Sapphire film / grain / damage family (registry/fx/sapphire-film-grain.ts): film grain,
// Sapphire coordinate helpers, vignettes, and the film dirt layers (dust, hairs, scratches, stains) shared by
// S_FilmDamage and S_FilmBurn. Every random pattern is a pure function of (pixel, frame, u_seed) through the integer
// hashes and noises of fx/hash and fx/noise, so the Player, stills and parallel renders draw identical pixels.
// Conventions: positions are LAYER pixels (fx_layerPx(), independent of u_pxScale), colours straight RGB.
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';
import type { GlslChunk } from '../shader.ts';

/** Grain, Sapphire conventions, vignette and output helpers (`sfg_*`). */
export const GLSL_FILM: GlslChunk = {
	name: 'sapphire-film-grain/film',
	deps: [GLSL_HASH, GLSL_NOISE, GLSL_COLOR],
	source: /* glsl */ `
// A seed for frame f (and layer k): every frame draws an independent pattern.
float sfg_frameSeed(float seed, float frame, float k) {
  return fx_hash3(ivec3(int(floor(frame)), int(k), 911), seed);
}
// Gaussian-like zero-mean noise (sd ≈ 1) of a lattice point: one integer hash split into four bytes, summed
// (Irwin–Hall). One hash per lattice point keeps the shaders small (SwiftShader compiles them in software).
uint sfg_seedU(float seed) { return fx_pcg(fx_seedBits(seed)); }
float sfg_gaussU(ivec2 p, uint s) {
  uint h = fx_pcg(fx_pcg(uint(p.x + 1073741824) ^ s) ^ (uint(p.y + 1073741824) * 1664525u));
  vec4 b = vec4(float(h & 255u), float((h >> 8u) & 255u), float((h >> 16u) & 255u), float(h >> 24u)) * (1.0 / 255.0);
  return (b.x + b.y + b.z + b.w - 2.0) * 1.7320508;
}
// Smoothly interpolated Gaussian lattice noise.
float sfg_gaussNoiseU(vec2 p, uint s) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = sfg_gaussU(i, s), b = sfg_gaussU(i + ivec2(1, 0), s);
  float c = sfg_gaussU(i + ivec2(0, 1), s), d = sfg_gaussU(i + ivec2(1, 1), s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Film grain with a feature size in layer px at layer px p; zero mean, sd ≈ 1. Sizes ≤ 1 px are per-pixel noise;
// bigger grains are smooth lattice noise mixed with a little per-pixel noise (grainy rather than blobby).
float sfg_grainU(vec2 p, float size, uint s) {
  float sz = max(size, 0.05);
  float px = sfg_gaussU(ivec2(floor(p / min(sz, 1.0))), s ^ 0x5bd1e995u);
  if (sz <= 1.0) return px;
  float k = clamp((sz - 1.0) * 0.5, 0.0, 1.0);
  return mix(px, sfg_gaussNoiseU(p / sz, s) * 1.45, k);
}
float sfg_grain(vec2 p, float size, float seed) { return sfg_grainU(p, size, sfg_seedU(seed)); }
// Zero-mean grain per channel (sd ≈ 1) with per-channel feature sizes (layer px); mono = one pattern.
vec3 sfg_grainNoise(vec2 p, vec3 sizePx, bool mono, float seed) {
  uint s = sfg_seedU(seed);
  if (mono) return vec3(sfg_grainU(p, sizePx.g, s));
  return vec3(sfg_grainU(p, sizePx.r, s), sfg_grainU(p, sizePx.g, s ^ 0x68e31da4u), sfg_grainU(p, sizePx.b, s ^ 0xb5297a4du));
}
// Cheap hashes for the dirt layers (one PCG round per call; SwiftShader compiles these shaders in software, so
// fewer hash rounds = much faster first frames). h → 0..1 floats: 16-bit pairs or 8-bit quads.
// Branch-free int → uint for |x| < 2^30 (cells, frames, indices): fx_u's sign branch, inlined dozens of times,
// makes SwiftShader's compiler crawl.
uint sfd_uu(int x) { return uint(x + 1073741824); }
uint sfd_h(ivec3 p, uint s) { return fx_pcg((sfd_uu(p.x) * 73856093u) ^ (sfd_uu(p.y) * 19349663u) ^ (sfd_uu(p.z) * 83492791u) ^ s); }
vec2 sfd_u16(uint h) { return vec2(float(h & 65535u), float(h >> 16u)) * (1.0 / 65535.0); }
vec4 sfd_u8(uint h) { return vec4(float(h & 255u), float((h >> 8u) & 255u), float((h >> 16u) & 255u), float(h >> 24u)) * (1.0 / 255.0); }
// 1D value noise (−1..1) along x for a stream id.
float sfd_noise1(float x, uint id) {
  float i = floor(x);
  float f = fract(x);
  float a = float(fx_pcg(sfd_uu(int(i)) ^ id) >> 8u) * (1.0 / 16777216.0);
  float b = float(fx_pcg(sfd_uu(int(i) + 1) ^ id) >> 8u) * (1.0 / 16777216.0);
  return mix(a, b, f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
}
// 2D value noise (−1..1).
float sfd_noise2(vec2 p, uint id) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = float(sfd_h(ivec3(i, 0), id) >> 8u), b = float(sfd_h(ivec3(i + ivec2(1, 0), 0), id) >> 8u);
  float c = float(sfd_h(ivec3(i + ivec2(0, 1), 0), id) >> 8u), d = float(sfd_h(ivec3(i + ivec2(1, 1), 0), id) >> 8u);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * (2.0 / 16777216.0) - 1.0;
}

// Sapphire grain amplitude curve per channel: Darks at black → Mids at the midtone position → Brights at white.
vec3 sfg_grainCurve(vec3 c, float darks, float mids, float brights, vec3 midPos) {
  vec3 m = clamp(midPos, 0.01, 0.99);
  vec3 v = clamp(c, 0.0, 1.0);
  vec3 lo = mix(vec3(darks), vec3(mids), v / m);
  vec3 hi = mix(vec3(mids), vec3(brights), (v - m) / (1.0 - m));
  return mix(lo, hi, step(m, v));
}
// Layer box size in layer px.
vec2 sfg_boxPx() { return u_box.zw / u_pxScale; }
// Sapphire centred units of a layer px position: x −1..1 over the width, y up, same scale (half widths).
vec2 sfg_sapph(vec2 layerPx) { vec2 b = sfg_boxPx(); vec2 d = (layerPx - b * 0.5) / (b.x * 0.5); return vec2(d.x, -d.y); }
// Sapphire film vignette (Darkness, Radius, Edge Softness, Rel Height): a multiplier, 1 − darkness at the edges.
float sfg_filmVignette(vec2 layerPx, float darkness, float radius, float softness, float relHeight) {
  if (darkness <= 0.0) return 1.0;
  vec2 s = sfg_sapph(layerPx);
  float d = length(s / vec2(1.0, max(relHeight, 0.05))) / max(radius, 1.0e-3);
  float soft = max(softness, 1.0e-3);
  float t = clamp((d - (1.0 - 0.5 * soft)) / soft, 0.0, 1.0);
  return 1.0 - clamp(darkness, 0.0, 1.0) * t * t * (3.0 - 2.0 * t);
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
`,
};

/** Sapphire's element "Combine" modes (`sfd_combine`). */
export const GLSL_COMBINE: GlslChunk = {
	name: 'sapphire-film-grain/combine',
	deps: [GLSL_FILM, GLSL_BLEND],
	source: /* glsl */ `
// Sapphire element Combine: 0 Normal, 1 Add, 2 Screen, 3 Mult, 4 Overlay, 5 Stencil Luma; a = coverage × opacity.
vec3 sfd_combine(int mode, vec3 base, vec3 col, float a) {
  a = clamp(a, 0.0, 1.0);
  if (mode == 1) return base + col * a;
  if (mode == 2) return mix(base, fx_blendRgb(FX_BLEND_SCREEN, clamp(base, 0.0, 1.0), col), a);
  if (mode == 3) return mix(base, base * col, a);
  if (mode == 4) return mix(base, fx_blendRgb(FX_BLEND_OVERLAY, clamp(base, 0.0, 1.0), col), a);
  if (mode == 5) return base * (1.0 - a * (1.0 - fx_luma(col)));
  return mix(base, col, a);
}

`,
};

/** Film dirt layers (dust, hairs, scratches, stains) (`sfd_*`). */
export const GLSL_DIRT: GlslChunk = {
	name: 'sapphire-film-grain/dirt',
	deps: [GLSL_FILM],
	source: /* glsl */ `
// Dust: specks scattered in cells of cellPx (≤ 1 speck per cell with probability prob); radius px ± vary.
// Returns (coverage 0..1, a 0..1 random of the speck for colour/opacity/print-vs-negative choices).
vec2 sfd_dustCell(vec2 p, ivec2 cc, float cellPx, float prob, float radius, float vary, uint s) {
  uint h1 = sfd_h(ivec3(cc, 3), s);
  vec4 k = sfd_u8(fx_pcg(h1));
  if (k.x >= prob) return vec2(0.0);
  vec2 centre = (vec2(cc) + sfd_u16(h1)) * cellPx;
  float r = radius * max(0.15, 1.0 + vary * (k.y * 2.0 - 1.0));
  vec2 d = p - centre;
  if (dot(d, d) > 9.0 * r * r) return vec2(0.0);
  // irregular specks: some elongated (fibres), all with a lumpy outline
  float rot = k.z * 6.2831853;
  vec2 dr = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * d;
  dr.x /= 1.0 + 2.0 * step(0.75, k.w) * k.y;
  float ang = atan(dr.y, dr.x);
  float wob = 1.0 + 0.18 * sin(ang * 3.0 + k.w * 20.0) + 0.1 * sin(ang * 5.0 + k.z * 30.0);
  float dist = length(dr) / max(r * wob, 0.35);
  return vec2(1.0 - smoothstep(0.55, 1.0, dist), fract(k.w * 7.0 + k.y * 3.0));
}
vec2 sfd_dust(vec2 p, float cellPx, float prob, float radius, float vary, float seed) {
  if (prob <= 0.0 || radius <= 0.0) return vec2(0.0);
  uint s = sfg_seedU(seed);
  ivec2 c = ivec2(floor(p / cellPx));
  vec2 best = vec2(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 v = sfd_dustCell(p, c + ivec2(x, y), cellPx, prob, radius, vary, s);
      if (v.x > best.x) best = v;
    }
  return best;
}

// Distance from p to a quadratic Bézier (a, b, c), approximated by 8 segments.
float sfd_bezierDist(vec2 p, vec2 a, vec2 b, vec2 c) {
  float best = 1.0e9;
  vec2 prev = a;
  for (int i = 1; i <= 8; i++) {
    float t = float(i) / 8.0;
    vec2 q = mix(mix(a, b, t), mix(b, c, t), t);
    vec2 pa = p - prev, ba = q - prev;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-6), 0.0, 1.0);
    best = min(best, length(pa - ba * h));
    prev = q;
  }
  return best;
}
float sfd_hair(int i, vec2 p, vec2 box, float count, float persistence, float wiggleAmp, float wiggleFreq,
               float len, float width, float vary, float frame, float fps, uint s) {
  float life = max(persistence, 0.1);
  uint h0 = fx_pcg(sfd_uu(i * 13 + 5) ^ s);
  float ph = float(h0 >> 8u) * (1.0 / 16777216.0) * life;
  int epoch = int(floor((frame + ph) / life));
  uint h1 = sfd_h(ivec3(i, epoch, 1), s);
  vec4 k = sfd_u8(fx_pcg(h1));
  if (float(i) + 1.0 > count && k.x > fract(count)) return 0.0;
  float l = len * max(0.2, 1.0 + vary * (k.y - 0.5));
  vec2 a = sfd_u16(h1) * box;
  float ang = k.z * 6.2831853;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 c = a + dir * l;
  vec2 nrm = vec2(-dir.y, dir.x);
  float t = frame / max(fps, 1.0);
  float bend = (k.w - 0.5) * 1.3 + wiggleAmp * sin(6.2831853 * (wiggleFreq * t + k.y));
  vec2 b = (a + c) * 0.5 + nrm * l * bend;
  vec2 lo = min(min(a, b), c) - width * 3.0, hi = max(max(a, b), c) + width * 3.0;
  if (any(lessThan(p, lo)) || any(greaterThan(p, hi))) return 0.0;
  float d = sfd_bezierDist(p, a, b, c);
  float w = width * max(0.3, 1.0 + vary * 0.5 * (k.x - 0.5));
  return 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.9, d);
}
// Hairs caught in the gate: count (≤ 6; fractional = probability of the last), each lives ~persistence frames and
// wiggles. len/width in layer px (± vary). Returns coverage 0..1.
float sfd_hairs(vec2 p, vec2 box, float count, float persistence, float wiggleAmp, float wiggleFreq,
                float len, float width, float vary, float frame, float fps, float seed) {
  uint s = sfg_seedU(seed);
  float cov = 0.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= ceil(count)) break;
    cov = max(cov, sfd_hair(i, p, box, count, persistence, wiggleAmp, wiggleFreq, len, width, vary, frame, fps, s));
  }
  return cov;
}

float sfd_scratch(int i, vec2 p, vec2 box, float pOn, float life, float width, float varyW, float taper,
                  float rough, float roughFreq, float gaps, float gapsFreq, float areaC, float areaW,
                  float weave, float weaveFreq, float frame, uint s) {
  uint h0 = fx_pcg(sfd_uu(i * 7 + 3) ^ s);
  float ph = float(h0 >> 8u) * (1.0 / 16777216.0) * life;
  float ef = floor((frame + ph) / life);
  float age = fract((frame + ph) / life);
  uint h1 = sfd_h(ivec3(i, int(ef), 1), s);
  uint h2 = fx_pcg(h1);
  vec4 k = sfd_u8(h2);
  if (k.x >= pOn) return 0.0;
  vec2 u = sfd_u16(h1);
  float xs = areaC + (u.x - 0.5) * areaW;                         // Sapphire units
  float x = (xs * 0.5 + 0.5) * box.x + weave * sin(6.2831853 * (weaveFreq * frame + u.y));
  float yn = p.y / box.y;
  x += rough * sfd_noise1(yn * roughFreq, h2);
  float w = width * max(0.2, 1.0 + varyW * (k.y * 2.0 - 1.0));
  // taper: thinner towards the ends of a scratch that does not span the whole frame
  float y0 = k.z * 0.6 - 0.3;
  float y1 = y0 + 1.0 + k.w;
  float along = clamp((yn - y0) / (y1 - y0), 0.0, 1.0);
  w *= mix(1.0, smoothstep(0.0, 0.25, min(along, 1.0 - along)), clamp(taper, 0.0, 1.0));
  float c = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.8, abs(p.x - x));
  if (gaps > 0.0) c *= step(gaps, (sfd_noise1(yn * gapsFreq * 0.25, h2 ^ 0x27d4eb2du) * 0.5 + 0.5) * 1.15);
  float fl = float(fx_pcg(h1 ^ sfd_uu(int(floor(frame)))) >> 24u) * (1.0 / 255.0);   // a little flicker
  return c * (0.75 + 0.25 * fl) * (smoothstep(0.0, 0.08, age) * 0.4 + 0.6);
}
// Vertical scratches of one kind: about 'count' visible per frame (≤ 8 slots), each living lifeFrames frames,
// within the area (centre/width in Sapphire −1..1 units). width px ± varyW; roughness px at roughFreq (cycles per
// frame height); gaps 0..1 at gapsFreq; weave = sideways drift (px) at weaveFreq (cycles per frame).
float sfd_scratches(vec2 p, vec2 box, float count, float lifeFrames, float width, float varyW, float taper,
                    float rough, float roughFreq, float gaps, float gapsFreq, float areaC, float areaW,
                    float weave, float weaveFreq, float frame, float seed) {
  if (count <= 0.0 || width <= 0.0) return 0.0;
  uint s = sfg_seedU(seed);
  float slots = min(8.0, ceil(count / 0.65));
  float pOn = min(1.0, count / slots);
  float cov = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= slots) break;
    cov = max(cov, sfd_scratch(i, p, box, pOn, max(lifeFrames, 1.0), width, varyW, taper, rough, roughFreq, gaps,
                               gapsFreq, areaC, areaW, weave, weaveFreq, frame, s));
  }
  return cov;
}

vec2 sfd_stain(int i, vec2 p, vec2 box, float density, float radius, float vary, float frame, uint s) {
  uint h1 = sfd_h(ivec3(i, int(floor(frame)), 21), s);
  vec4 k = sfd_u8(fx_pcg(h1));
  if (float(i) + 1.0 > density && k.x > fract(density)) return vec2(0.0);
  float r = radius * max(0.15, 1.0 + vary * (k.y * 2.0 - 1.0));
  vec2 d = (p - sfd_u16(h1) * box) / max(r, 1.0);
  if (dot(d, d) > 4.0) return vec2(0.0);
  uint id = fx_pcg(h1 ^ 0x9e3779b9u);
  float n = sfd_noise2(d * 1.8, id) * 0.6 + sfd_noise2(d * 4.1, id ^ 0x85ebca6bu) * 0.3;
  float dist = length(d) * (1.0 + 0.45 * n);
  float body = 1.0 - smoothstep(0.7, 1.0, dist);
  float rim = smoothstep(0.75, 0.95, dist) * (1.0 - smoothstep(0.95, 1.08, dist));
  return vec2(clamp(body * (0.55 + 0.2 * n) + rim * 0.8, 0.0, 1.0), k.z);
}
// Stains (water marks / emulsion blotches): 'density' per frame (≤ 4; fractional = probability), radius px ± vary.
// Returns (coverage 0..1, a random 0..1 of the stain).
vec2 sfd_stains(vec2 p, vec2 box, float density, float radius, float vary, float frame, float seed) {
  uint s = sfg_seedU(seed);
  vec2 best = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= ceil(density)) break;
    vec2 v = sfd_stain(i, p, box, density, radius, vary, frame, s);
    if (v.x > best.x) best = v;
  }
  return best;
}
`,
};

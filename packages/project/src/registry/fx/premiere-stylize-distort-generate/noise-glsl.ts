// Family-private GLSL noise of "premiere-stylize-distort-generate": lean integer hashes and an evolving gradient-noise
// fbm for the After Effects-derived fractal controls (Turbulent Displace, Roughen Edges, …).
// Why not the library's fx_hash*/fx_simplex3: they are exact and deterministic, but each hash is three PCG rounds plus
// sign handling, and a noise sample evaluates 8 of them; inside an octave loop SwiftShader (the software GL of the
// render browser when there is no GPU) needs minutes to JIT such a shader. One multiply-xorshift round per lattice
// point keeps the same guarantees (integer maths, identical on every GPU) and JITs in well under a second.
import type { GlslChunk } from '../shader.ts';

/** `psdg_seed(u_seed)` → uint seed; `psdg_h2/h3` → uint; `psdg_r2/r3/r22` → 0..1. */
export const GLSL_PSDG_HASH: GlslChunk = {
	name: 'psdg/hash',
	source: /* glsl */ `
uint psdg_seed(float seed) { return uint(clamp(seed, 0.0, 1.0) * 16777215.0) * 2654435761u; }
uint psdg_mix(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
// Coordinates are offset to stay non-negative (no int → uint conversion of negative values).
uint psdg_h2(ivec2 i, uint s) { uvec2 u = uvec2(i + 1048576); return psdg_mix((u.x * 0x8da6b343u) ^ (u.y * 0xd8163841u) ^ s); }
uint psdg_h3(ivec3 i, uint s) {
  uvec3 u = uvec3(i + 1048576);
  return psdg_mix((u.x * 0x8da6b343u) ^ (u.y * 0xd8163841u) ^ (u.z * 0xcb1ab31fu) ^ s);
}
float psdg_u01(uint h) { return float(h >> 8) * (1.0 / 16777216.0); }
float psdg_r2(ivec2 i, uint s) { return psdg_u01(psdg_h2(i, s)); }
float psdg_r3(ivec3 i, uint s) { return psdg_u01(psdg_h3(i, s)); }
vec2 psdg_r22(ivec2 i, uint s) { uint h = psdg_h2(i, s); return vec2(float(h & 65535u), float(h >> 16)) * (1.0 / 65535.0); }
// Drop-in counterparts of the library's fx_hash1/2/3/22/33 (float seed 0..1 → 0..1 values).
float psdg_hash1(int x, float seed) { return psdg_r2(ivec2(x, 0), psdg_seed(seed)); }
float psdg_hash2(ivec2 p, float seed) { return psdg_r2(p, psdg_seed(seed)); }
float psdg_hash3(ivec3 p, float seed) { return psdg_r3(p, psdg_seed(seed)); }
vec2 psdg_hash22(ivec2 p, float seed) { return psdg_r22(p, psdg_seed(seed)); }
vec3 psdg_hash33(ivec3 p, float seed) {
  uint h = psdg_h3(p, psdg_seed(seed));
  return vec3(float(h & 2047u), float((h >> 11) & 2047u), float(h >> 22)) / vec3(2047.0, 2047.0, 1023.0);
}
`,
};

/**
 * Evolving fractal noise. `psdg_evolve(p, octaves, evolutionDeg, cycleOn, cycleRevs, seed, turbulent)`: gradient-noise
 * fbm (≈ −1..1) or turbulence (|noise| sum, 0..1) in (p, evolution); fractional octaves fade the last octave in (AE
 * Complexity). One revolution of Evolution moves the noise along its third dimension; Cycle Evolution loops every
 * Cycle revolutions (cross-fade with the phase one cycle earlier — seamless). Pass octaves derived from a uniform
 * (never a literal) so the octave loop stays a loop.
 */
export const GLSL_PSDG_EVOLVE: GlslChunk = {
	name: 'psdg/evolve',
	deps: [GLSL_PSDG_HASH],
	source: /* glsl */ `
// 3D gradient noise (Perlin-style, one of 12 edge gradients per lattice point), ≈ −1..1.
float psdg_grad(uint h, vec3 f) {
  uint k = h % 12u;
  float u = k < 8u ? f.x : f.y;
  float v = k < 4u ? f.y : f.z;
  return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v);
}
float psdg_gnoise3(vec3 p, uint s) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = psdg_grad(psdg_h3(i, s), f);
  float n100 = psdg_grad(psdg_h3(i + ivec3(1, 0, 0), s), f - vec3(1.0, 0.0, 0.0));
  float n010 = psdg_grad(psdg_h3(i + ivec3(0, 1, 0), s), f - vec3(0.0, 1.0, 0.0));
  float n110 = psdg_grad(psdg_h3(i + ivec3(1, 1, 0), s), f - vec3(1.0, 1.0, 0.0));
  float n001 = psdg_grad(psdg_h3(i + ivec3(0, 0, 1), s), f - vec3(0.0, 0.0, 1.0));
  float n101 = psdg_grad(psdg_h3(i + ivec3(1, 0, 1), s), f - vec3(1.0, 0.0, 1.0));
  float n011 = psdg_grad(psdg_h3(i + ivec3(0, 1, 1), s), f - vec3(0.0, 1.0, 1.0));
  float n111 = psdg_grad(psdg_h3(i + ivec3(1, 1, 1), s), f - vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y), mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y), w.z) * 0.9;
}
float psdg_fbmFrac(vec3 p, float octaves, float seed, bool turbulent) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  uint s = psdg_seed(seed);
  int n = int(ceil(clamp(octaves, 0.0, 10.0)));
  for (int k = 0; k < n; k++) {
    float w = clamp(octaves - float(k), 0.0, 1.0);
    float v = psdg_gnoise3(p, s + uint(k) * 0x9e3779b9u);
    sum += amp * w * (turbulent ? abs(v) : v);
    norm += amp * w;
    p = p * 2.0 + vec3(0.0, 0.0, 0.37);
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float psdg_evolve(vec2 p, float octaves, float evolutionDeg, bool cycleOn, float cycleRevs, float seed, bool turbulent) {
  float z = evolutionDeg / 360.0;
  float c = max(floor(cycleRevs), 1.0);
  float zc = cycleOn ? mod(z, c) : z;
  float w = cycleOn ? zc / c : 0.0;
  float acc = 0.0;
  int m = cycleOn ? 2 : 1;
  for (int j = 0; j < m; j++) {
    float wj = j == 0 ? 1.0 - w : w;
    if (wj <= 0.0) continue;
    acc += wj * psdg_fbmFrac(vec3(p, (zc - float(j) * c) * 0.6), octaves, seed, turbulent);
  }
  return acc;
}
`,
};

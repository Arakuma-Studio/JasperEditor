// Shared GLSL: integer hashes (wave-1 fx framework, docs/wp-notes/fx-shader-framework.md §GLSL library).
// Integer arithmetic (PCG-style) is exact on every GPU, so a seeded pattern is identical in the Player, in parallel
// render pages and in software GL (SwiftShader) — no `sin()`-based float hashes (their precision varies by GPU).
import type { GlslChunk } from '../shader.ts';

export const GLSL_HASH: GlslChunk = {
	name: 'fx/hash',
	source: /* glsl */ `
uint fx_pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint fx_seedBits(float seed) { return uint(clamp(seed, 0.0, 1.0) * 4294967040.0); }
// int → uint without relying on the conversion of negative ints (portable across GLSL back ends).
// Branch-free (same values as \`x >= 0 ? uint(x) : (uint(-x) * 2654435761u) ^ 0x9e3779b9u\`): a select inlined many
// times makes SwiftShader's shader compiler stall for minutes in software-GL renders.
uint fx_u(int x) {
  uint neg = uint(x < 0);
  return uint(max(x, 0)) * (1u - neg) + ((uint(max(-x, 0)) * 2654435761u) ^ 0x9e3779b9u) * neg;
}
// Hashes of integer lattice points → 0..1 (24-bit resolution).
float fx_hashU(uint h) { return float(fx_pcg(h) >> 8u) * (1.0 / 16777216.0); }
// The hashed seed of fx_hash1/2/3 (fx_hashSeed(seed) = fx_pcg(fx_seedBits(seed))): code that hashes many lattice
// points with one seed computes it once and calls the *s variants (identical values, less code to compile).
uint fx_hashSeed(float seed) { return fx_pcg(fx_seedBits(seed)); }
float fx_hash2s(ivec2 p, uint s) { return fx_hashU(fx_pcg(fx_u(p.x) ^ s) ^ fx_u(p.y) * 1664525u); }
float fx_hash3s(ivec3 p, uint s) {
  uint h = fx_pcg(fx_u(p.x) ^ s);
  h = fx_pcg(h ^ fx_u(p.y) * 1664525u);
  return fx_hashU(h ^ fx_u(p.z) * 22695477u);
}
float fx_hash1(int x, float seed) { return fx_hashU(fx_u(x) ^ fx_hashSeed(seed)); }
float fx_hash2(ivec2 p, float seed) { return fx_hash2s(p, fx_hashSeed(seed)); }
float fx_hash3(ivec3 p, float seed) { return fx_hash3s(p, fx_hashSeed(seed)); }
vec2 fx_hash22s(ivec2 p, uint s) { return vec2(fx_hash2s(p, s), fx_hash2s(p + ivec2(7919, 104729), s)); }
vec2 fx_hash22(ivec2 p, float seed) { return fx_hash22s(p, fx_hashSeed(seed)); }
vec3 fx_hash33(ivec3 p, float seed) {
  uint s = fx_hashSeed(seed);
  return vec3(fx_hash3s(p, s), fx_hash3s(p + ivec3(7919, 0, 0), s), fx_hash3s(p + ivec3(0, 104729, 0), s));
}
// Per-pixel white noise for a frame: fx_random(fx_canvasPx(), u_frame, u_seed).
float fx_random(vec2 px, float frame, float seed) { return fx_hash3(ivec3(floor(px), int(floor(frame))), seed); }
`,
};

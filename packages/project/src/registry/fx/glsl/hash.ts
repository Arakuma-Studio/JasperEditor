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
uint fx_u(int x) { return x >= 0 ? uint(x) : (uint(-x) * 2654435761u) ^ 0x9e3779b9u; }
// Hashes of integer lattice points → 0..1 (24-bit resolution).
float fx_hashU(uint h) { return float(fx_pcg(h) >> 8u) * (1.0 / 16777216.0); }
float fx_hash1(int x, float seed) { return fx_hashU(fx_u(x) ^ fx_pcg(fx_seedBits(seed))); }
float fx_hash2(ivec2 p, float seed) { return fx_hashU(fx_pcg(fx_u(p.x) ^ fx_pcg(fx_seedBits(seed))) ^ fx_u(p.y) * 1664525u); }
float fx_hash3(ivec3 p, float seed) {
  uint h = fx_pcg(fx_u(p.x) ^ fx_pcg(fx_seedBits(seed)));
  h = fx_pcg(h ^ fx_u(p.y) * 1664525u);
  return fx_hashU(h ^ fx_u(p.z) * 22695477u);
}
vec2 fx_hash22(ivec2 p, float seed) { return vec2(fx_hash2(p, seed), fx_hash2(p + ivec2(7919, 104729), seed)); }
vec3 fx_hash33(ivec3 p, float seed) {
  return vec3(fx_hash3(p, seed), fx_hash3(p + ivec3(7919, 0, 0), seed), fx_hash3(p + ivec3(0, 104729, 0), seed));
}
// Per-pixel white noise for a frame: fx_random(fx_canvasPx(), u_frame, u_seed).
float fx_random(vec2 px, float frame, float seed) { return fx_hash3(ivec3(floor(px), int(floor(frame))), seed); }
`,
};

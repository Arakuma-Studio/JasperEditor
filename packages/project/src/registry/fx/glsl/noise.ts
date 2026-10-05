// Shared GLSL: seeded procedural noise (wave-1 fx framework): value noise, gradient (Perlin-style) noise, simplex
// noise (2D, 3D), fractal sums (fbm, turbulence, ridged) and cellular (Worley) noise. Every function takes a `seed`
// (pass `u_seed`, or `u_seed + k` for independent layers) and is built on the integer hashes of fx/hash, so the
// patterns are deterministic. Output ranges: value/gradient/simplex ≈ −1..1 (fx_*01 variants 0..1).
import type { GlslChunk } from '../shader.ts';
import { GLSL_HASH } from './hash.ts';

export const GLSL_NOISE: GlslChunk = {
	name: 'fx/noise',
	deps: [GLSL_HASH],
	source: /* glsl */ `
vec2 fx_fade2(vec2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
vec3 fx_fade3(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

// Value noise, −1..1.
float fx_valueNoise(vec2 p, float seed) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fx_fade2(fract(p));
  float a = fx_hash2(i, seed), b = fx_hash2(i + ivec2(1, 0), seed);
  float c = fx_hash2(i + ivec2(0, 1), seed), d = fx_hash2(i + ivec2(1, 1), seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
}
float fx_valueNoise3(vec3 p, float seed) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fx_fade3(fract(p));
  float n000 = fx_hash3(i, seed), n100 = fx_hash3(i + ivec3(1, 0, 0), seed);
  float n010 = fx_hash3(i + ivec3(0, 1, 0), seed), n110 = fx_hash3(i + ivec3(1, 1, 0), seed);
  float n001 = fx_hash3(i + ivec3(0, 0, 1), seed), n101 = fx_hash3(i + ivec3(1, 0, 1), seed);
  float n011 = fx_hash3(i + ivec3(0, 1, 1), seed), n111 = fx_hash3(i + ivec3(1, 1, 1), seed);
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z) * 2.0 - 1.0;
}

// Gradient (Perlin-style) noise, ≈ −1..1.
vec2 fx_grad2(ivec2 i, float seed) { float a = fx_hash2(i, seed) * 6.28318530718; return vec2(cos(a), sin(a)); }
float fx_gradientNoise(vec2 p, float seed) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = fx_fade2(f);
  float a = dot(fx_grad2(i, seed), f);
  float b = dot(fx_grad2(i + ivec2(1, 0), seed), f - vec2(1.0, 0.0));
  float c = dot(fx_grad2(i + ivec2(0, 1), seed), f - vec2(0.0, 1.0));
  float d = dot(fx_grad2(i + ivec2(1, 1), seed), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.41421356;
}

// Simplex noise 2D, ≈ −1..1.
float fx_simplex(vec2 p, float seed) {
  const float F2 = 0.36602540378; // (sqrt(3) - 1) / 2
  const float G2 = 0.21132486540; // (3 - sqrt(3)) / 6
  vec2 s = floor(p + (p.x + p.y) * F2);
  vec2 x0 = p - s + (s.x + s.y) * G2;
  vec2 o = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 x1 = x0 - o + G2;
  vec2 x2 = x0 - 1.0 + 2.0 * G2;
  ivec2 i = ivec2(s);
  vec3 t = max(0.5 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  t = t * t; t = t * t;
  vec3 n = vec3(dot(fx_grad2(i, seed), x0), dot(fx_grad2(i + ivec2(o), seed), x1), dot(fx_grad2(i + ivec2(1), seed), x2));
  return 70.0 * dot(t, n);
}

// Simplex noise 3D (use z = time for evolving patterns), ≈ −1..1.
vec3 fx_grad3(ivec3 i, float seed) {
  vec2 h = vec2(fx_hash3(i, seed), fx_hash3(i + ivec3(31, 17, 7), seed));
  float z = h.x * 2.0 - 1.0;
  float a = h.y * 6.28318530718;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(a), r * sin(a), z);
}
float fx_simplex3(vec3 p, float seed) {
  const float F3 = 1.0 / 3.0;
  const float G3 = 1.0 / 6.0;
  vec3 s = floor(p + dot(p, vec3(F3)));
  vec3 x0 = p - s + dot(s, vec3(G3));
  vec3 e = step(x0.yzx, x0.xyz);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 x1 = x0 - i1 + G3;
  vec3 x2 = x0 - i2 + 2.0 * G3;
  vec3 x3 = x0 - 1.0 + 3.0 * G3;
  ivec3 i = ivec3(s);
  vec4 t = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  t = t * t; t = t * t;
  vec4 n = vec4(dot(fx_grad3(i, seed), x0), dot(fx_grad3(i + ivec3(i1), seed), x1),
                dot(fx_grad3(i + ivec3(i2), seed), x2), dot(fx_grad3(i + ivec3(1), seed), x3));
  return 32.0 * dot(t, n);
}

// Fractal sums. octaves ≤ 12; lacunarity ~2, gain ~0.5. Each octave uses an independent seed.
float fx_fbm(vec2 p, int octaves, float lacunarity, float gain, float seed) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int k = 0; k < 12; k++) {
    if (k >= octaves) break;
    sum += amp * fx_simplex(p, fract(seed + float(k) * 0.1031));
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float fx_fbm3(vec3 p, int octaves, float lacunarity, float gain, float seed) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int k = 0; k < 12; k++) {
    if (k >= octaves) break;
    sum += amp * fx_simplex3(p, fract(seed + float(k) * 0.1031));
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
// Turbulence (sum of |noise|), 0..1; ridged multifractal, 0..1.
float fx_turbulence(vec3 p, int octaves, float lacunarity, float gain, float seed) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int k = 0; k < 12; k++) {
    if (k >= octaves) break;
    sum += amp * abs(fx_simplex3(p, fract(seed + float(k) * 0.1031)));
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float fx_ridged(vec3 p, int octaves, float lacunarity, float gain, float seed) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int k = 0; k < 12; k++) {
    if (k >= octaves) break;
    float n = 1.0 - abs(fx_simplex3(p, fract(seed + float(k) * 0.1031)));
    sum += amp * n * n;
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// Cellular (Worley) noise: x = distance to the nearest feature point (F1), y = second nearest (F2), in cell units.
// jitter 0..1 (1 = fully random points).
vec2 fx_cellular(vec2 p, float jitter, float seed) {
  ivec2 c = ivec2(floor(p));
  vec2 f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 o = ivec2(x, y);
      vec2 pt = vec2(o) + 0.5 + (fx_hash22(c + o, seed) - 0.5) * jitter;
      float d = length(pt - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  return vec2(f1, f2);
}
// Cell id (0..1) of the nearest feature point (for flat-shaded cells / mosaics).
float fx_cellId(vec2 p, float jitter, float seed) {
  ivec2 c = ivec2(floor(p));
  vec2 f = fract(p);
  float best = 8.0; ivec2 id = c;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 o = ivec2(x, y);
      vec2 pt = vec2(o) + 0.5 + (fx_hash22(c + o, seed) - 0.5) * jitter;
      float d = length(pt - f);
      if (d < best) { best = d; id = c + o; }
    }
  return fx_hash2(id, fract(seed + 0.5));
}
float fx_noise01(float n) { return n * 0.5 + 0.5; }
`,
};

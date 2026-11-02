// Spec 19: procedural motif patterns for the `pattern` finish and the `texture` layer, ported from Pachislop's
// engine/patterns.ts. Differences: integer hashes (the original's float hashes vary by GPU, TL-035), generic names, and one
// program per kind: a pass defines `TLP_KIND` and only that kind's code compiles. The result of `tlp_sample` is
//   x mark coverage (analytic antialiasing over the pixel footprint), y second-colour coverage over the marks, z mark
//   height for relief.
// Each kind computes a signed distance to its mark outline in its own units, so edges stay sharp at every resolution.
// `p` is in motif units (one unit = the pattern's scale), `dx` and `dy` its steps per canvas px. Needs GLSL_HASH.
import type { GlslChunk } from '../shader.ts';
import { GLSL_HASH } from './hash.ts';

/** Option values of a motif param, in the order of `TLP_KIND` (1-based). Stored in documents: never rename. */
export const TL_PATTERN_KINDS = [
	'zebra',
	'tiger',
	'giraffe',
	'leopard',
	'checker',
	'hazard',
	'stripes',
	'dots',
	'blossom',
	'fans',
	'leafLattice',
	'rings',
	'hexagons',
	'scales',
	'image',
] as const;
export const TL_PATTERN_LABELS = [
	'Zebra',
	'Tiger',
	'Giraffe',
	'Leopard',
	'Checker',
	'Hazard Stripes',
	'Stripes',
	'Dots',
	'Blossom',
	'Fans',
	'Leaf Lattice',
	'Rings',
	'Hexagons',
	'Scales',
	'Image Tile',
] as const;

/** `#define TLP_KIND n` for a motif value (unknown values read as the first kind). */
export function tlPatternDefine(kind: unknown): string {
	return `#define TLP_KIND ${Math.max(0, TL_PATTERN_KINDS.indexOf(kind as (typeof TL_PATTERN_KINDS)[number])) + 1}\n`;
}

/** Base lattice helpers, in every kind's program. */
export const GLSL_TL_PATTERN_BASE: GlslChunk = {
	name: 'title-look/pattern-base',
	deps: [GLSL_HASH],
	source: /* glsl */ `
uint tlp_s = 0u;
float tlp_h1(vec2 c, int salt) { return fx_hash2s(ivec2(floor(c)) + salt * ivec2(211, 97), tlp_s); }
vec2 tlp_h2(vec2 c, int salt) { return fx_hash22s(ivec2(floor(c)) + salt * ivec2(211, 97), tlp_s); }
// Gradient noise, roughly -1..1.
float tlp_gnoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(tlp_h2(i, 0) * 2.0 - 1.0, f);
  float b = dot(tlp_h2(i + vec2(1.0, 0.0), 0) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(tlp_h2(i + vec2(0.0, 1.0), 0) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(tlp_h2(i + vec2(1.0, 1.0), 0) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return 1.6 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec2 tlp_warp(vec2 q, float freq, float amt) {
  return q + amt * vec2(tlp_gnoise(q * freq + 3.7), tlp_gnoise(q * freq + 11.3));
}
float tlp_smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float tlp_seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
const float TLP_NONE = 1000.0;
`,
};

/**
 * The kinds, guarded by `TLP_KIND`: a plain string, placed after the pass's `#define TLP_KIND n` and, for the image kind,
 * `#define TLP_IMAGE <sampler>`. Each kind ends in `vec3 tlp_kind(q, dqx, dqy, px)`: mark distance, second-colour
 * distance (TLP_NONE = none), relief ramp width, all in the kind's own units; `TLP_UNIT` is its units per motif unit.
 */
export const TLP_KINDS_GLSL = /* glsl */ `
#if TLP_KIND == 1
#define TLP_UNIT 0.7
// Irregular stripes bent by low-frequency noise; where their width falls below zero a stripe tapers to a point and breaks.
float tlp_zebraU(vec2 q) { return q.x + 0.95 * tlp_gnoise(q * vec2(0.19, 0.13)) + 0.22 * tlp_gnoise(q * vec2(0.7, 0.5) + 5.3); }
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  float u = tlp_zebraU(q);
  float k = px / max(abs(tlp_zebraU(q + dqx) - u) + abs(tlp_zebraU(q + dqy) - u), 1.0e-6);
  float id = floor(u + 0.5);
  float f = u - id;
  float wv = tlp_gnoise(vec2(id * 1.73 + 0.31, q.y * 0.5));
  float hw = 0.25 + 0.24 * wv + 0.05 * tlp_gnoise(q * 1.7 + 7.1);
  return vec3((abs(f) - min(hw, 0.4)) * k, TLP_NONE, 0.1);
}
#elif TLP_KIND == 2
#define TLP_UNIT 0.7
// A stripe per unit of u, broken along v into strokes that swell off-centre and taper to needle tips; some fork, some cells
// stay empty, and short dashes sit between the stripes.
float tlp_tigerU(vec2 q) { return q.x * 0.6 + 0.4 * tlp_gnoise(q * vec2(0.22, 0.16)) + 0.06 * tlp_gnoise(q * 1.1 + 2.0); }
float tlp_tigerW(float t, float skew) { float s = pow(clamp(t, 0.0, 1.0), skew); return pow(max(4.0 * s * (1.0 - s), 0.0), 0.85); }
float tlp_stroke(float f, float v, float len, float w, float h, float fork) {
  float t = v / len;
  float skew = mix(0.75, 1.35, h);
  float cap = max(-v, v - len);
  float hw = w * tlp_tigerW(t, skew);
  if (fork == 0.0) return max(abs(f) - hw, cap);
  float t0 = mix(0.45, 0.65, fract(h * 7.31));
  float tf = fork > 0.0 ? t : 1.0 - t;
  float tau = max(tf - t0, 0.0) / (1.0 - t0);
  float span = (1.0 - t0) * len;
  float body = max(max(abs(f) - hw * (1.0 - smoothstep(0.0, 0.5, tau)), cap), (tau - 0.5) * span);
  float pw = 0.7 * w * tlp_tigerW(fork > 0.0 ? t0 : 1.0 - t0, skew);
  float sep = (0.7 * w + 0.08) * pow(tau, 1.3);
  float before = (t0 - tf) * len;
  float l2 = mix(0.55, 1.0, fract(h * 13.7));
  float p1 = max(max(abs(f - sep) - pw * pow(max(1.0 - tau, 0.0), 1.1), before), cap);
  float p2 = max(max(abs(f + 0.85 * sep) - pw * pow(max(1.0 - tau / l2, 0.0), 1.1), before), (tau - l2) * span);
  return min(body, min(p1, p2));
}
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  float u = tlp_tigerU(q);
  float k = px / max(abs(tlp_tigerU(q + dqx) - u) + abs(tlp_tigerU(q + dqy) - u), 1.0e-6);
  float v = q.y * 0.6 + 0.25 * tlp_gnoise(q * vec2(0.3, 0.2) + 5.1);
  float id0 = floor(u);
  float d = TLP_NONE;
  for (int i = 0; i < 2; i++) {
    float id = id0 + float(i);
    float hs = tlp_h1(vec2(id, 4.0), 1);
    float period = mix(4.5, 7.5, hs);
    float vs = v + hs * 17.0;
    float j = floor(vs / period);
    vec2 ha = tlp_h2(vec2(id, j), 2), hb = tlp_h2(vec2(j, id), 3);
    if (ha.x < 0.1) continue;
    float gap = mix(0.3, 1.0, ha.y);
    float fork = hb.x < 0.4 ? (hb.y < 0.5 ? -1.0 : 1.0) : 0.0;
    float w = mix(0.15, 0.28, fract(ha.x * 3.7));
    d = min(d, tlp_stroke(u - id - (hb.y - 0.5) * 0.14, vs - j * period - gap * hb.x, period - gap, w, ha.x, fork));
  }
  float vd = v + tlp_h1(vec2(id0, 8.0), 4) * 11.0;
  float jd = floor(vd / 1.8);
  vec2 hc = tlp_h2(vec2(id0, jd), 5), hd = tlp_h2(vec2(jd, id0), 6);
  if (hc.x > 0.5) {
    float len = mix(0.4, 1.0, hc.y);
    d = min(d, tlp_stroke(u - id0 - 0.5 - (hd.x - 0.5) * 0.16, vd - jd * 1.8 - (1.8 - len) * hd.y, len, mix(0.05, 0.1, hd.y), hc.x, 0.0));
  }
  return vec3(d * k, TLP_NONE, 0.12);
}
#elif TLP_KIND == 3
#define TLP_UNIT 0.45
// Rounded Voronoi patches separated by gaps of the base colour.
vec3 tlp_kind(vec2 q0, vec2 dqx, vec2 dqy, float px) {
  vec2 q = tlp_warp(q0, 1.6, 0.07);
  vec2 n = floor(q), f = q - n;
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + 0.5 + 0.38 * sin(6.2831853 * tlp_h2(n + g, 0)) - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  float e = 8.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 r = g + 0.5 + 0.38 * sin(6.2831853 * tlp_h2(n + g, 0)) - f;
      vec2 dr = r - mr;
      if (dot(dr, dr) > 1.0e-5) e = tlp_smin(e, dot(0.5 * (mr + r), normalize(dr)), 0.14);
    }
  return vec3(0.055 - e, TLP_NONE, 0.1);
}
#elif TLP_KIND == 4
#define TLP_UNIT 0.38
// Broken rosette rings with second-colour centres, and some solid spots.
vec3 tlp_kind(vec2 q0, vec2 dqx, vec2 dqy, float px) {
  vec2 q = tlp_warp(q0, 1.3, 0.05);
  vec2 n = floor(q), f = q - n;
  float d = TLP_NONE, d2 = TLP_NONE;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 c = n + g;
      vec2 h = tlp_h2(c, 0);
      float h3 = tlp_h1(c, 7), h4 = tlp_h1(c, 8);
      vec2 r = f - (g + 0.28 + 0.44 * h);
      float ang = atan(r.y, r.x);
      float rr = length(r) * (1.0 + 0.14 * sin(2.0 * ang + 6.2831853 * h4) + 0.05 * sin(3.0 * ang + 9.0 * h3));
      if (h3 > 0.84) {
        d = min(d, rr - 0.08 - 0.05 * h4);
      } else {
        float R = 0.24 + 0.05 * h3;
        float lobes = 3.0 + floor(h4 * 2.999);
        float s = smoothstep(0.1, 0.42, 0.5 + 0.5 * cos(lobes * ang + 6.2831853 * h3));
        float th = 0.075 * s - 0.018 + 0.012 * sin(5.0 * ang + 5.0 * h4) + 0.012 * tlp_gnoise(r * 7.0 + c);
        float dr = abs(rr - R) - th;
        d = min(d, dr);
        d2 = min(d2, max(rr - R, -dr));
      }
    }
  return vec3(d, d2, 0.05);
}
#elif TLP_KIND == 5
#define TLP_UNIT 1.0
// Marks on one parity, the second colour on the other.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  vec2 cell = floor(q), fr = q - cell;
  float e = min(min(fr.x, 1.0 - fr.x), min(fr.y, 1.0 - fr.y));
  float d = mod(cell.x + cell.y, 2.0) < 0.5 ? -e : e;
  return vec3(d, -d, 0.08);
}
#elif TLP_KIND == 6
#define TLP_UNIT 0.6
// 45° stripes alternating the two colours.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  float u = (q.x - q.y) * 0.7071068;
  float d = abs(fract(u) - 0.25) - 0.25;
  return vec3(d, -d, 0.06);
}
#elif TLP_KIND == 7
#define TLP_UNIT 1.0
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) { return vec3(abs(fract(q.x) - 0.5) - 0.25, TLP_NONE, 0.08); }
#elif TLP_KIND == 8
#define TLP_UNIT 1.0
// Polka dots on two interleaved square grids.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  float d = min(length(fract(q) - 0.5), length(fract(q + 0.5) - 0.5)) - 0.2;
  return vec3(d, TLP_NONE, 0.08);
}
#elif TLP_KIND == 9
#define TLP_UNIT 0.32
// Scattered five-petal blossoms with notched tips and second-colour centres.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  vec2 n = floor(q), f = q - n;
  float d = TLP_NONE, d2 = TLP_NONE;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 c = n + g;
      if (tlp_h1(c, 9) >= 0.12) {
        vec2 h = tlp_h2(c, 0);
        float R = 0.27 + 0.1 * tlp_h1(c, 10);
        vec2 r = f - (g + 0.3 + 0.4 * h);
        float rl = length(r);
        float ang = atan(r.y, r.x) + 6.2831853 * tlp_h1(c, 11);
        float a = mod(ang, 1.2566371) - 0.6283185;
        float petal = R * (0.42 + 0.58 * pow(max(cos(a * 2.5), 0.0), 0.6));
        petal -= R * 0.2 * max(0.0, 1.0 - abs(a) / 0.14);
        d = min(d, (rl - petal) * 0.8);
        d2 = min(d2, rl - R * 0.17);
      }
    }
  return vec3(d, d2, 0.05);
}
#elif TLP_KIND == 10
#define TLP_UNIT 0.4
// Rows of concentric fans, lower rows overlapping the ones above.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  const float R = 0.5, rowH = 0.25, hw = 0.022, sp = R / 4.0;
  float j0 = floor(q.y / rowH);
  float l = R;
  for (int k = 2; k >= -2; k--) {
    float j = j0 + float(k);
    float off = mod(j, 2.0) * 0.5;
    vec2 c = vec2(floor(q.x - off + 0.5) + off, j * rowH);
    float lk = length(q - c);
    if (lk < R + hw + px) l = lk;
  }
  float ring = clamp(floor(l / sp + 0.5), 1.0, 4.0);
  return vec3(abs(l - ring * sp) - hw, TLP_NONE, hw);
}
#elif TLP_KIND == 11
#define TLP_UNIT 0.55
// A triangle lattice with spokes from each centroid to its corners.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  const float H = 0.8660254, hw = 0.022;
  vec2 st = vec2(q.x - 0.5 * q.y / H, q.y / H);
  vec2 cell = floor(st), f = st - cell;
  vec2 A = cell, B, C;
  if (f.x + f.y < 1.0) { B = cell + vec2(1.0, 0.0); C = cell + vec2(0.0, 1.0); }
  else { A = cell + vec2(1.0, 0.0); B = cell + vec2(1.0, 1.0); C = cell + vec2(0.0, 1.0); }
  vec2 a = vec2(A.x + 0.5 * A.y, A.y * H), b = vec2(B.x + 0.5 * B.y, B.y * H), c = vec2(C.x + 0.5 * C.y, C.y * H);
  vec2 m = (a + b + c) / 3.0;
  float d = min(min(tlp_seg(q, a, b), tlp_seg(q, b, c)), tlp_seg(q, c, a));
  d = min(d, min(min(tlp_seg(q, m, a), tlp_seg(q, m, b)), tlp_seg(q, m, c)));
  return vec3(d - hw, TLP_NONE, hw);
}
#elif TLP_KIND == 12
#define TLP_UNIT 0.65
// Circles on a square grid, each overlapped a quarter by its four neighbours.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  const float r = 0.7071068, hw = 0.025;
  vec2 n = floor(q);
  float d = TLP_NONE;
  for (int j = 0; j <= 1; j++)
    for (int i = 0; i <= 1; i++) d = min(d, abs(length(q - n - vec2(float(i), float(j))) - r));
  return vec3(d - hw, TLP_NONE, hw);
}
#elif TLP_KIND == 13
#define TLP_UNIT 0.5
// A flat-top hexagon lattice with a double outline.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  const float hw = 0.02;
  vec2 s = vec2(1.0, 1.7320508), h = s * 0.5;
  vec2 p = q.yx;
  vec2 a = mod(p, s) - h, b = mod(p - h, s) - h;
  vec2 g = abs(dot(a, a) < dot(b, b) ? a : b);
  float hd = max(dot(g, vec2(0.5, 0.8660254)), g.x);
  float d = min(abs(hd - 0.5) - hw, abs(hd - 0.41) - hw * 0.75);
  return vec3(d, TLP_NONE, hw);
}
#elif TLP_KIND == 14
#define TLP_UNIT 0.55
// Upward triangles of the mark colour tiling with downward triangles of the base.
vec3 tlp_kind(vec2 q, vec2 dqx, vec2 dqy, float px) {
  const float H = 0.8660254;
  vec2 st = vec2(q.x - 0.5 * q.y / H, q.y / H);
  vec2 f = st - floor(st);
  float s = f.x + f.y;
  float d = s < 1.0 ? -min(min(f.x, f.y), 1.0 - s) * H : min(min(1.0 - f.x, 1.0 - f.y), s - 1.0) * H;
  return vec3(d, TLP_NONE, 0.07);
}
#endif
#if TLP_KIND == 15
// A tile of the picture per motif unit: luminance × alpha is the mark and the relief. Media textures have no mip chain, so
// the taps spread over the pixel's footprint: a tile shown small does not shimmer, whatever the render size.
vec4 tlp_sample(vec2 p, vec2 dx, vec2 dy, float seed) {
  if (TLP_IMAGE_SIZE.x <= 0.0) return vec4(0.0);
  // The tile keeps its picture's aspect: a scale wide, as tall as that makes it.
  vec2 k = vec2(1.0, TLP_IMAGE_SIZE.x / max(TLP_IMAGE_SIZE.y, 1.0));
  p *= k;
  dx *= k;
  dy *= k;
  float m = 0.0;
  for (int j = 0; j < 3; j++)
    for (int i = 0; i < 3; i++) {
      vec2 o = (vec2(float(i), float(j)) + 0.5) / 3.0 - 0.5;
      vec4 c = texture(TLP_IMAGE, fract(p + dx * o.x + dy * o.y));
      m += c.a > 0.0 ? dot(c.rgb / c.a, vec3(0.2126, 0.7152, 0.0722)) * c.a : 0.0;
    }
  m /= 9.0;
  return vec4(m, 0.0, m, 0.0);
}
#else
vec4 tlp_sample(vec2 p, vec2 dx, vec2 dy, float seed) {
  tlp_s = fx_hashSeed(seed);
  // Whole offsets keep lattices anchored while the seed reshuffles their cells.
  vec2 so = floor(vec2(fx_hash1(1, seed), fx_hash1(2, seed)) * 512.0);
  vec2 q = p * TLP_UNIT + so;
  vec2 dqx = dx * TLP_UNIT, dqy = dy * TLP_UNIT;
  float px = max(length(abs(dqx) + abs(dqy)) * 0.7071068, 1.0e-6);
  vec3 r = tlp_kind(q, dqx, dqy, px);
  float t = clamp(-r.x / max(r.z, px), 0.0, 1.0);
  return vec4(clamp(0.5 - r.x / px, 0.0, 1.0), clamp(0.5 - r.y / px, 0.0, 1.0), t * t * (3.0 - 2.0 * t), 0.0);
}
#endif
`;

/** GLSL of one motif for a shader: its kind, its image (`u_<param>` of a media param) and the code. */
export const tlPatternProgram = (kind: unknown, image: string) =>
	`${tlPatternDefine(kind)}#define TLP_IMAGE ${image}\n#define TLP_IMAGE_SIZE ${image}_size\n${TLP_KINDS_GLSL}`;

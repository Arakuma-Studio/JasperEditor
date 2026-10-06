// GLSL of the lightning effects (S_Zap, S_UltraZap, S_ZapTo, S_ZapFrom). A bolt is a base path (a straight segment
// or the sampled spline `u_spline`) displaced sideways by fractal noise: a smooth low-frequency "curve" term plus
// octaves of piecewise-linear lattice noise (the jagged "wrinkles", like midpoint displacement). Displacement and
// its slope are analytic, so the distance from a pixel to the bolt is a cheap per-segment evaluation (corrected by
// the slope) instead of a polyline search. The noise evolves along a time axis (`tau`: Wiggle), every random choice
// hashes integers with `u_seed`-derived seeds (fx/hash), so a frame is exactly reproducible.
import type { GlslChunk } from '../shader.ts';
import { GLSL_SRT_COMMON, GLSL_SRT_NOISE, GLSL_SRT_SPLINE } from './common.ts';

export const GLSL_ZAP: GlslChunk = {
	name: 'srt/zap',
	deps: [GLSL_SRT_NOISE, GLSL_SRT_COMMON],
	source: /* glsl */ `
struct ZapStyle { float curve; float wrinkle; float tau; float seed; vec2 pins; };
// A bolt's base: a straight segment a → a + d·len (spline = false) or u_spline (true, see srt/zap-spline).
struct ZapBase { bool spline; vec2 a; vec2 d; float len; vec2 endOff; };

float zap_h(int i, int j, int k, float seed) { return srt_h3(ivec3(i, j, k), uint(fract(seed) * 16777216.0) * 0x9e3779b1u); }
// Lattice noise along x (piecewise linear = jagged, or smooth), smoothly evolving in tau → (value −1..1, d/dx).
vec2 zap_noise(float x, float tau, int k, float seed, bool smoothX) {
  float fx = floor(x);
  float f = x - fx;
  int i = int(fx);
  float fj = floor(tau);
  float g = tau - fj;
  g = g * g * (3.0 - 2.0 * g);
  int j = int(fj);
  float s0 = mix(zap_h(i, j, k, seed), zap_h(i, j + 1, k, seed), g);
  float s1 = mix(zap_h(i + 1, j, k, seed), zap_h(i + 1, j + 1, k, seed), g);
  if (smoothX) {
    float w = f * f * (3.0 - 2.0 * f);
    return vec2(mix(s0, s1, w) * 2.0 - 1.0, (s1 - s0) * 12.0 * f * (1.0 - f));
  }
  return vec2(mix(s0, s1, f) * 2.0 - 1.0, (s1 - s0) * 2.0);
}
// Largest sideways displacement of a bolt of length L (px).
float zap_amp(float L, ZapStyle st) { return L * (0.16 * st.curve + 0.115 * st.wrinkle); }
// Sideways displacement (px) at arc length s of a bolt of length L, and its slope dD/ds.
vec2 zap_disp(float s, float L, int id, ZapStyle st) {
  L = max(L, 1.0);
  float t = clamp(s / L, 0.0, 1.0);
  float eC = (st.pins.x > 0.5 ? smoothstep(0.0, 0.5, t) : 1.0) * (st.pins.y > 0.5 ? smoothstep(1.0, 0.5, t) : 1.0);
  float eW = (st.pins.x > 0.5 ? smoothstep(0.0, 0.08, t) : 1.0) * (st.pins.y > 0.5 ? smoothstep(1.0, 0.92, t) : 1.0);
  vec2 c = zap_noise(t * 2.5 + 0.37, st.tau * 0.5, id * 16, st.seed, true);
  float aC = 0.16 * L * st.curve * eC;
  float D = aC * c.x;
  float dD = aC * c.y * 2.5 / L;
  float cells = 7.0;
  float amp = 0.045 * L * st.wrinkle * eW;
  int oct = int(clamp(ceil(log2(L / 12.0)), 1.0, 8.0));
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    vec2 w = zap_noise(t * cells, st.tau * (1.0 + 0.4 * float(o)), id * 16 + o + 1, st.seed, false);
    D += amp * w.x;
    dD += amp * w.y * cells / L;
    cells *= 2.0;
    amp *= 0.6;
  }
  return vec2(D, dD);
}
// Distance (px) from p to a bolt with a straight base and the base parameter t (0..1) of the closest point.
vec2 zap_straight(vec2 p, vec2 a, vec2 d, float L, int id, ZapStyle st, float halo) {
  vec2 q = p - a;
  float u = dot(q, d);
  float v = dot(q, vec2(-d.y, d.x));
  float band = zap_amp(L, st) + halo;
  if (u < -halo || u > L + halo || abs(v) > band) return vec2(1.0e9, 0.0);
  float s = clamp(u, 0.0, L);
  vec2 D = zap_disp(s, L, id, st);
  float dv = (v - D.x) / sqrt(1.0 + D.y * D.y);
  return vec2(length(vec2(u - s, dv)), s / max(L, 1.0e-3));
}
// Width profile: thin towards the start (taperStart) and the end (taperEnd), fractions of the length.
float zap_taper(float t, float ts, float te) {
  float a = ts > 1.0e-3 ? clamp(t / ts, 0.0, 1.0) : 1.0;
  float b = te > 1.0e-3 ? clamp((1.0 - t) / te, 0.0, 1.0) : 1.0;
  return min(sqrt(a), b);
}
// Random width variation along the bolt (Vary Width).
float zap_vary(float t, int id, ZapStyle st, float vary) {
  if (vary <= 0.0) return 1.0;
  return 1.0 - clamp(vary, 0.0, 1.0) * (0.5 + 0.5 * zap_noise(t * 9.0, st.tau, id * 16 + 11, st.seed, true).x);
}
// Visible part of a bolt: t in [start, start + len] (Start Offset / Length), with a soft cut.
float zap_window(float t, float start, float len) {
  if (start <= 0.0 && len >= 1.0) return 1.0;
  return smoothstep(start - 0.004, start + 0.004, t) * smoothstep(start + len + 0.004, start + len - 0.004, t);
}
// Coverage of a bolt core of half width hw (px) at distance dist (anti-aliased, a little soft heat around it).
float zap_cov(float dist, float hw, float feather) {
  float e = 0.75 + feather;
  float core = smoothstep(hw + e, hw - e, dist) * clamp(hw * 1.6, 0.0, 1.0);
  float soft = 0.3 * exp(-dist / max(hw * 1.5 + feather, 0.6)) * clamp(hw * 2.0, 0.0, 1.0);
  return clamp(core + soft, 0.0, 1.0);
}
`,
};

/** Spline-based bolts (S_Zap, S_UltraZap): `u_spline` must be declared (see `splineUniform`). */
export const GLSL_ZAP_SPLINE: GlslChunk = {
	name: 'srt/zap-spline',
	deps: [GLSL_ZAP, GLSL_SRT_SPLINE],
	source: /* glsl */ `
// Distance to a bolt along the spline → (dist, t). endOff: Vary Endpoint offset (px), blended in towards the end.
vec2 zap_spline(vec2 p, int id, ZapStyle st, float halo, vec2 endOff) {
  float L = srt_splineLen();
  float band = zap_amp(L, st) + halo + length(endOff);
  float best = 1.0e9, bt = 0.0;
  vec2 a = srt_splineP(0);
  float sa = 0.0;
  for (int i = 1; i < SRT_SPLINE_N; i++) {
    vec2 b = srt_splineP(i);
    float sb = srt_splineS(i);
    vec2 e = b - a;
    float l = length(e);
    if (l > 1.0e-4) {
      vec2 d = e / l;
      vec2 q = p - a;
      float u = dot(q, d);
      float v = dot(q, vec2(-d.y, d.x));
      if (u > -band && u < l + band && abs(v) < band) {
        float uc = clamp(u, 0.0, l);
        float s = sa + uc;
        float t = s / L;
        vec2 D = zap_disp(s, L, id, st);
        vec2 n = vec2(-d.y, d.x);
        float eo = dot(endOff, n);
        D += vec2(eo * t * t, eo * 2.0 * t / L);
        float dist = length(vec2(u - uc, (v - D.x) / sqrt(1.0 + D.y * D.y)));
        if (dist < best) { best = dist; bt = t; }
      }
    }
    a = b;
    sa = sb;
  }
  return vec2(best, bt);
}
`,
};

/** Generic bolt (straight or spline) + branches. Include after GLSL_ZAP_SPLINE (or GLSL_ZAP_STRAIGHT_ONLY). */
const BRANCHES = /* glsl */ `
// Point (xy) and tangent (zw) of the displaced bolt at t.
vec4 zap_boltAt(float t, ZapBase B, int id, ZapStyle st) {
  vec4 f;
  float L;
  if (B.spline) { L = zap_baseLen(); f = zap_baseFrame(t * L); }
  else { L = B.len; f = vec4(B.a + B.d * t * L, B.d); }
  vec2 n = vec2(-f.w, f.z);
  vec2 D = zap_disp(t * L, L, id, st);
  float eo = dot(B.endOff, n);
  D += vec2(eo * t * t, eo * 2.0 * t / max(L, 1.0));
  return vec4(f.xy + n * D.x, normalize(f.zw + n * D.y));
}
vec2 zap_bolt(vec2 p, ZapBase B, int id, ZapStyle st, float halo) {
  if (B.spline) return zap_baseDist(p, id, st, halo, B.endOff);
  return zap_straight(p, B.a, B.d, B.len, id, st, halo);
}
// Branches of a bolt: count, max angle (deg), relative length, width relative to the bolt at the root.
struct ZapBranches { int count; float angle; float len; float width; float ts; float te; float winStart; float winLen; };
// → (coverage, t along the branch where it is strongest, t of its root on the bolt)
vec3 zap_branches(vec2 p, ZapBase B, int id, ZapStyle st, float hw, ZapBranches br, float halo) {
  vec3 best = vec3(0.0);
  float L = B.spline ? zap_baseLen() : B.len;
  ZapStyle bs = st;
  bs.pins = vec2(1.0, 0.0);
  bs.curve *= 0.6;
  for (int j = 0; j < 24; j++) {
    if (j >= br.count) break;
    float h1 = zap_h(j, id, 501, st.seed), h2 = zap_h(j, id, 502, st.seed);
    float h3 = zap_h(j, id, 503, st.seed), h4 = zap_h(j, id, 504, st.seed);
    float tj = 0.05 + 0.8 * h1;
    float win = zap_window(tj, br.winStart, br.winLen);
    if (win <= 0.0) continue;
    float Lb = br.len * L * mix(0.3, 1.0, h3) * (1.0 - 0.5 * tj);
    if (Lb < 2.0) continue;
    vec4 root = zap_boltAt(tj, B, id, st);
    if (distance(p, root.xy) > Lb * 1.6 + halo) continue;
    float ang = (h2 < 0.5 ? -1.0 : 1.0) * mix(0.3, 1.0, h4) * radians(br.angle);
    vec2 dir = srt_rot(root.zw, ang);
    float hwRoot = hw * zap_taper(tj, br.ts, br.te) * br.width;
    int bid = id * 64 + 8 + j;
    vec2 r = zap_straight(p, root.xy, dir, Lb, bid, bs, halo);
    float c = zap_cov(r.x, hwRoot * (1.0 - r.y), 0.0) * win;
    if (c > best.x) best = vec3(c, r.y, tj);
    // one sub-branch
    float h5 = zap_h(j, id, 505, st.seed);
    float tb = 0.25 + 0.5 * h5;
    float Ls = Lb * 0.5 * (1.0 - tb * 0.5);
    if (Ls > 2.0) {
      vec2 D = zap_disp(tb * Lb, Lb, bid, bs);
      vec2 nb = vec2(-dir.y, dir.x);
      vec2 rp = root.xy + dir * tb * Lb + nb * D.x;
      vec2 rd = srt_rot(normalize(dir + nb * D.y), (h5 < 0.5 ? 1.0 : -1.0) * radians(br.angle) * mix(0.4, 1.0, h3));
      vec2 rs = zap_straight(p, rp, rd, Ls, bid * 2 + 1, bs, halo);
      float cs = zap_cov(rs.x, hwRoot * (1.0 - tb) * 0.7 * (1.0 - rs.y), 0.0) * win;
      if (cs > best.x) best = vec3(cs, mix(tb, 1.0, rs.y), tj);
    }
  }
  return best;
}
`;

export const GLSL_ZAP_BOLT_SPLINE: GlslChunk = {
	name: 'srt/zap-bolt-spline',
	deps: [GLSL_ZAP_SPLINE],
	source: `
float zap_baseLen() { return srt_splineLen(); }
vec4 zap_baseFrame(float s) { return srt_splineFrame(s); }
vec2 zap_baseDist(vec2 p, int id, ZapStyle st, float halo, vec2 endOff) { return zap_spline(p, id, st, halo, endOff); }
${BRANCHES}`,
};

export const GLSL_ZAP_BOLT_STRAIGHT: GlslChunk = {
	name: 'srt/zap-bolt-straight',
	deps: [GLSL_ZAP],
	source: `
float zap_baseLen() { return 1.0; }
vec4 zap_baseFrame(float s) { return vec4(0.0, 0.0, 1.0, 0.0); }
vec2 zap_baseDist(vec2 p, int id, ZapStyle st, float halo, vec2 endOff) { return vec2(1.0e9, 0.0); }
${BRANCHES}`,
};

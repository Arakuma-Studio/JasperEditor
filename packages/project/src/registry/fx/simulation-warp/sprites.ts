// Sprite rendering of the simulation-warp family (sim-warp workstream): particles, drops, flakes, stars, balls and
// strand segments are instanced quads of a draw pass (`ShaderPass.draw`), shaded per pixel by `sp_shade` — a port of
// EffectCraft's sprite rasteriser (crates/effects/src/sim.rs `sprite_shade`, MIT OR Apache-2.0; see
// licenses/ported/sim-warp.md) — and composited with the original layer by `sp_combine` (the effects' Transfer
// Modes). Coordinates are canvas pixels (y down); colours straight in, premultiplied out.
import type { GlslChunk } from '../shader.ts';
import { GLSL_HASH } from '../glsl/hash.ts';

/** Sprite shapes (`int` shape codes of sp_shade). */
export const SP = {
	soft: 0,
	disc: 1,
	sphere: 2,
	faded: 3,
	bubble: 4,
	star: 5,
	square: 6,
	tri: 7,
	line: 8,
	darkSphere: 9,
} as const;

export const GLSL_SPRITES: GlslChunk = {
	name: 'sim/sprites',
	deps: [GLSL_HASH],
	source: /* glsl */ `
// Instance hash → [0, 1) (integer maths: identical on every GPU).
float sp_h(int i, int k, uint s) { return fx_hashU(fx_pcg(uint(i) ^ s) ^ uint(k) * 1664525u); }
float sp_hs(int i, int k, uint s) { return sp_h(i, k, s) * 2.0 - 1.0; }
// The six corners (two triangles) of an instance quad: (−1..1)².
vec2 sp_corner(int v) {
  int c = v < 3 ? v : v - 2;          // 0 1 2 | 1 2 3
  if (v == 3) c = 2;
  if (v == 4) c = 1;
  if (v == 5) c = 3;
  return vec2(c == 1 || c == 3 ? 1.0 : -1.0, c >= 2 ? 1.0 : -1.0);
}
// Wraps v into [lo, lo + span).
float sp_wrap(float v, float lo, float span) { return span <= 0.0 ? v : lo + mod(v - lo, span); }
float sp_aa(float edge) { return clamp(edge + 0.5, 0.0, 1.0); }
// Half extent of a sprite's quad (px) around its centre (lines: handled by sp_lineCorner).
float sp_extent(int shape, float r) { return (shape == 5 ? 2.0 : 1.0) * max(r, 0.5) + 1.5; }
// A line sprite's quad corner: the segment from p0 to p0 + seg, widened by r + 1.5.
vec2 sp_lineCorner(vec2 corner, vec2 p0, vec2 seg, float r) {
  float l = length(seg);
  vec2 t = l > 1e-4 ? seg / l : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float e = max(r, 0.5) + 1.5;
  vec2 a = p0 + seg * (corner.x * 0.5 + 0.5) + t * corner.x * e;
  return a + n * corner.y * e;
}
// Premultiplied colour of a sprite at offset d (px) from its centre: shape, radius r, rotation (radians), segment
// (lines: p − p0 is d, the segment vector seg), straight colour c (alpha = opacity). vec4(0) outside.
vec4 sp_shade(int shape, vec2 d, float r0, float rot, vec2 seg, vec4 c) {
  float r = max(r0, 0.5);
  float fade = r0 < 0.5 ? max(r0, 0.0) / 0.5 : 1.0;
  vec3 rgb = c.rgb;
  float cov = 0.0;
  if (shape == 0) {
    float d2 = dot(d, d) / (r * r);
    float q = max(1.0 - d2, 0.0);
    cov = q * q;
  } else if (shape == 1) {
    cov = sp_aa(r - length(d));
  } else if (shape == 3) {
    cov = pow(max(1.0 - length(d) / r, 0.0), 1.5);
  } else if (shape == 2 || shape == 9) {
    float dd = length(d);
    cov = sp_aa(r - dd);
    vec2 n2 = d / r;
    float nz = sqrt(max(1.0 - dot(n2, n2), 0.0));
    vec3 l = vec3(-0.48, -0.58, 0.66);
    float diff = max(dot(vec3(n2, nz), l), 0.0);
    float rz = 2.0 * diff * nz - l.z;
    float spec = pow(max(rz, 0.0), 20.0) * 0.6;
    if (shape == 9) rgb = rgb * (0.15 + 0.85 * nz);
    else rgb = rgb * (0.2 + 0.8 * diff) + spec;
  } else if (shape == 4) {
    float dd = length(d) / r;
    if (dd > 1.0 + 1.0 / r) return vec4(0.0);
    float ring = max(1.0 - pow((dd - 0.9) / 0.12, 2.0), 0.0);
    vec2 hp = d / r + 0.4;
    float hl = max(1.0 - dot(hp, hp) / 0.04, 0.0);
    cov = min((dd <= 1.0 ? 0.12 : 0.0) + ring * 0.8 + hl, 1.0);
  } else if (shape == 5) {
    float sn = sin(rot), cs = cos(rot);
    vec2 u = vec2(d.x * cs + d.y * sn, -d.x * sn + d.y * cs) / r;
    float core = pow(max(1.0 - length(u), 0.0), 2.0);
    float sx = max(1.0 - abs(u.x) / 2.0, 0.0) * max(1.0 - abs(u.y) * 6.0, 0.0);
    float sy = max(1.0 - abs(u.y) / 2.0, 0.0) * max(1.0 - abs(u.x) * 6.0, 0.0);
    cov = min(core + sx + sy, 1.0);
  } else if (shape == 6) {
    float sn = sin(rot), cs = cos(rot);
    vec2 u = vec2(d.x * cs + d.y * sn, -d.x * sn + d.y * cs);
    float e = r * 0.75;
    cov = sp_aa(e - abs(u.x)) * sp_aa(e - abs(u.y));
  } else if (shape == 7) {
    float sn = sin(rot), cs = cos(rot);
    vec2 u = vec2(d.x * cs + d.y * sn, -d.x * sn + d.y * cs);
    float e = r * 0.5;
    float m = 1e9;
    for (int k = 0; k < 3; k++) {
      float a = 1.5707963 + float(k) * 2.0943951;
      m = min(m, e - (u.x * cos(a) + u.y * sin(a)));
    }
    cov = sp_aa(m);
  } else {
    float l2 = dot(seg, seg);
    float t = l2 > 0.0 ? clamp(dot(d, seg) / l2, 0.0, 1.0) : 0.0;
    cov = sp_aa(r - length(d - seg * t));
  }
  float a = cov * c.a * fade;
  if (a <= 1e-6) return vec4(0.0);
  return vec4(rgb * a, a);
}
// The effect layer fx combined with the original src (both premultiplied): 0 Composite (fx over src), 1 Screen,
// 2 Add, 3 Lighten, 4 Darken, 5 the effect only, 6 the effect over opaque black (Black Matte).
vec4 sp_combine(int mode, vec4 src, vec4 fx) {
  if (mode == 1) return src + fx - src * fx;
  if (mode == 2) return vec4(src.rgb + fx.rgb, min(src.a + fx.a, 1.0));
  if (mode == 3) return vec4(max(src.rgb, fx.rgb), src.a + fx.a - src.a * fx.a);
  if (mode == 4) {
    vec3 fc = fx.a > 0.0 ? fx.rgb / fx.a : vec3(0.0);
    return vec4(src.rgb - (src.rgb - min(src.rgb, fc * src.a)) * fx.a, src.a);
  }
  if (mode == 5) return fx;
  if (mode == 6) return fx + vec4(0.0, 0.0, 0.0, 1.0) * (1.0 - fx.a);
  return fx + src * (1.0 - fx.a);
}
`,
};

/** The GLSL of a sprite's fragment stage: reads the varyings written by `spriteVaryingsOut` and shades. */
export const SPRITE_FRAG_DECLS = /* glsl */ `
in vec2 v_d;
in vec2 v_seg;
flat in int v_shape;
flat in vec4 v_col;
flat in vec2 v_rr;
`;
export const SPRITE_VERT_DECLS = /* glsl */ `
out vec2 v_d;
out vec2 v_seg;
flat out int v_shape;
flat out vec4 v_col;
flat out vec2 v_rr;
// Emits vertex v of a sprite centred at p (canvas px): shape, radius r, rotation (rad), segment seg (lines: p is the
// segment's start), straight colour c.
void sp_emitSprite(int v, vec2 p, int shape, float r, float rot, vec2 seg, vec4 c) {
  vec2 corner = sp_corner(v);
  vec2 q = shape == 8 ? sp_lineCorner(corner, p, seg, r) : p + corner * sp_extent(shape, r);
  if (c.a <= 1e-5 || r <= 0.0) { fx_cull(); v_d = vec2(0.0); v_seg = vec2(0.0); v_shape = 0; v_col = vec4(0.0); v_rr = vec2(0.0); return; }
  v_d = q - p;
  v_seg = seg;
  v_shape = shape;
  v_col = c;
  v_rr = vec2(r, rot);
  fx_emit(q);
}
`;
/** Fragment main of a plain sprite pass. */
export const SPRITE_FRAG_MAIN = /* glsl */ `${SPRITE_FRAG_DECLS}
void main() { fragColor = sp_shade(v_shape, v_d, v_rr.x, v_rr.y, v_seg, v_col); }
`;

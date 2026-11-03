// Lightning (TL-061, TL-062): electric arcs shooting from and crawling over the edges of the shape, after Pachislop's
// energy/lightning.ts, which walks a CPU list of edge cells. Here a bolt is a closed form of its index: its ends are stable
// sites on the shared field, its body a sum of 1D noise octaves (midpoint displacement in closed form), and each segment a
// capsule in a draw pass, so no list of the shape is ever built. Two motions: Boil holds each jag for a frame count and
// re-strikes bolts on a beat, Crawl slides the noise along the bolt continuously. `jasper.lightning` and `jasper.s.zap`
// are bolts between two points; this one lives on the title's edges.
import { GLSL_UV } from '../../glsl/sample.ts';
import type { GlslChunk } from '../../shader.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG_QUAD } from './light-streaks.ts';
import {
	anchorParam,
	boilParams,
	GLSL_TLG,
	GLSL_TLG_SITES,
	hex,
	num,
	pct,
	variationParam,
} from './shared.ts';

const MODES = ['mixed', 'outward', 'crawl', 'edge'];
/** Segments of one path. */
const SEGMENTS = 40;
/** Paths per bolt: the bolt and its possible branches. */
const PER_BOLT = 4;

const edgeMode = (p: LayerParams) => p.mode === 'edge';
const fineBounds = (p: LayerParams) => p.anchor === 'bounds';
/** Whether some arcs crawl from one point of the edge to another (Mixed, Crawl Along Edge). */
const crawls = (p: LayerParams) => p.mode === 'mixed' || p.mode === 'crawl';
const boltCount = (p: LayerParams) =>
	Math.round(Math.min(60, Math.max(1, edgeMode(p) ? num(p.arcs) : num(p.count))));

const reachOf = (p: LayerParams) => {
	const glow = 3 * num(p.glowSize) + num(p.coreWidth);
	if (edgeMode(p)) return num(p.wrinkle) * 0.3 + 0.35 * num(p.boltLength) + glow + 4;
	return num(p.boltLength) * (1 + 1.2 * (num(p.jaggedness) / 100)) + glow + 4;
};

/**
 * Pass 0, with Anchor Alpha Bounds: the bounds to sub-pixel. `tl_bounds()` is whole pixels, out to the last one with 2 % alpha,
 * so between 1x and 2x it moves by up to a pixel, every site with it, and on a curve the bolt's direction turns with its start.
 * Each side is refined to the outermost point where the alpha crosses half its peak near that side, per line of pixels,
 * between pixel centres: on an edge at x that is x at every resolution.
 */
const FRAG_FINE_BOUNDS = /* glsl */ `
const int TLG_SCAN = 8;
ivec2 tlg_size;
float tlg_alpha(ivec2 p) {
  return any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, tlg_size)) ? 0.0 : texelFetch(u_source, p, 0).a;
}
// The outermost crossing near one side, px along away from the centres of its outermost line of pixels (n of them, from start
// along along); -1e9 when there is none within TLG_SCAN px.
float tlg_side(ivec2 start, ivec2 along, ivec2 away, int n) {
  float peak = 0.0;
  for (int i = 0; i < 16384; i++) {
    if (i >= n) break;
    for (int k = 0; k < TLG_SCAN; k++) peak = max(peak, tlg_alpha(start + along * i - away * k));
  }
  float level = 0.5 * peak;
  float best = -1.0e9;
  if (level < 0.01) return best;
  for (int i = 0; i < 16384; i++) {
    if (i >= n) break;
    ivec2 p = start + along * i;
    for (int k = 0; k < TLG_SCAN; k++) {
      float outer = tlg_alpha(p - away * (k - 1)), inner = tlg_alpha(p - away * k);
      if (inner >= level && outer < level) {
        best = max(best, float(-k) + (inner - level) / (inner - outer));
        break;
      }
    }
  }
  return best;
}
void main() {
  vec4 b = tl_bounds();
#ifdef TLG_STANDALONE
  fragColor = b;
#else
  tlg_size = textureSize(u_source, 0);
  ivec2 lo = ivec2(floor(b.xy + 0.5)), hi = ivec2(floor(b.zw + 0.5));
  ivec2 n = max(hi - lo, ivec2(1));
  float l = tlg_side(lo, ivec2(0, 1), ivec2(-1, 0), n.y), r = tlg_side(ivec2(hi.x - 1, lo.y), ivec2(0, 1), ivec2(1, 0), n.y);
  float t = tlg_side(lo, ivec2(1, 0), ivec2(0, -1), n.x), d = tlg_side(ivec2(lo.x, hi.y - 1), ivec2(1, 0), ivec2(0, 1), n.x);
  fragColor = vec4(l > -1.0e8 ? float(lo.x) + 0.5 - l : b.x, t > -1.0e8 ? float(lo.y) + 0.5 - t : b.y,
                   r > -1.0e8 ? float(hi.x) - 0.5 + r : b.z, d > -1.0e8 ? float(hi.y) - 0.5 + d : b.w);
#endif
}`;

/** A bolt's clock and jag: what the bolt pass and the draw pass both read. */
const GLSL_TLG_BOLT: GlslChunk = {
	name: 'title-look/lightning',
	deps: [GLSL_TLG],
	source: /* glsl */ `
int tlg_step, tlg_strike;   // the held jag; the strike a bolt is on
float tlg_phase;            // the continuous slide of the noise
float tlg_beat;             // the bolt's light: per held step, or its fade in and out
float tlg_rs(int b, int k) { return tlg_h3(b, tlg_strike, k); }
// Where bolt b is in its life at u_tlTime (TL-061).
void tlg_clock(int b) {
  float time = u_tlTime;
  if (u_motion == 0) {
    // Hold-frame boil: the jag re-rolls every held frame; each bolt re-strikes on its own beat.
    float x = floor(time * max(u_boilRate, 0.1));
    tlg_step = int(x);
    tlg_strike = int(floor(x / 4.0 + tlg_h(b, 30) * 4.0));
    tlg_phase = 0.0;
    tlg_beat = 0.75 + 0.25 * tlg_h3(b, tlg_step, 31);
  } else {
    // Continuous crawl: the jag slides along the bolt; a bolt fades out and strikes elsewhere, unseen.
    float x = time * 0.35 + tlg_h(b, 30) * 4.0;
    tlg_step = 0;
    tlg_strike = int(floor(x));
    tlg_phase = time * u_crawlSpeed * 2.0;
    float f = x - floor(x);
    tlg_beat = smoothstep(0.0, 0.12, f) * (1.0 - smoothstep(0.82, 1.0, f));
  }
}
// Fractal noise along a bolt: midpoint displacement as a closed form, -1..1 by octave weights; x = 0..1.
float tlg_jag(float x, int b, float o) {
  float sum = 0.0, amp = 1.0, f = 3.0;
  for (int k = 0; k < 5; k++) {
    int ch = b * 31 + k * 7 + tlg_step * 1009 + 200;
    sum += amp * (tlg_noise1(x * f + o + tlg_phase * (1.0 + 0.5 * float(k)), ch) - 0.5) * 2.0;
    amp *= 0.55;
    f *= 2.0;
  }
  return sum;
}
struct TlgBolt { vec2 a, b, n; float gain, len; };
`,
};

/**
 * Pass 1: each bolt's ends, once per frame. Outward, crawl and mixed: texels 2b and 2b + 1 hold (start, end) and (normal,
 * light, length) of bolt b, light 0 when it sleeps. Along Edge: texel (i, b) holds point i of arc b's path and its light.
 */
const FRAG_BOLTS = /* glsl */ `
// The shape's alpha at canvas px p, bilinear: at a pixel corner, the mean of the four pixels around it. Standalone, the
// stand-in shape's, antialiased over a pixel as the field's edge is.
float tlg_cover(vec2 p) {
#ifdef TLG_STANDALONE
  vec2 f = p - 0.5;
  vec2 i = floor(f);
  vec2 t = f - i;
  vec2 c = i + 0.5;
  float c00 = clamp(0.5 - tlg_standIn(c).x, 0.0, 1.0);
  float c10 = clamp(0.5 - tlg_standIn(c + vec2(1.0, 0.0)).x, 0.0, 1.0);
  float c01 = clamp(0.5 - tlg_standIn(c + vec2(0.0, 1.0)).x, 0.0, 1.0);
  float c11 = clamp(0.5 - tlg_standIn(c + vec2(1.0)).x, 0.0, 1.0);
  return mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
#else
  return texture(u_source, p / u_canvasSize).a;
#endif
}
const int TLG_MASS_SIDE = 260;
// The shape's mass around p at a scale of sigma px: the Gaussian-weighted first moment of its alpha, summed over every pixel
// within 3 sigma; past 64 px of reach over 2x2 blocks, each read at its shared corner (their exact mean); past 128 px in
// wider steps. It is an area integral of the picture, so 1x and 2x converge to one value: antialiased alpha is coverage, and
// a sum over hundreds of pixels averages away their 8-bit steps, where a few reads of the field keep its sub-pixel noise.
// (direction out of the shape, strength): the strength is 1 on a straight edge and falls to 0 where the mass around p balances.
vec3 tlg_mass(vec2 p, float sigma) {
  float R = 3.0 * sigma;
  float st = R <= 64.0 ? 1.0 : 2.0 * ceil(R / 128.0);
  vec2 lo = st == 1.0 ? floor(p - R) + 0.5 : floor((p - R) / st) * st;
  int n = min(int(ceil(2.0 * R / st)) + 2, TLG_MASS_SIDE);
  float k = 0.5 / (sigma * sigma);
  vec2 m = vec2(0.0);
  for (int j = 0; j < TLG_MASS_SIDE; j++) {
    if (j >= n) break;
    for (int i = 0; i < TLG_MASS_SIDE; i++) {
      if (i >= n) break;
      vec2 x = lo + vec2(float(i), float(j)) * st;
      vec2 r = x - p;
      float rr = dot(r, r) / (R * R);
      if (rr >= 1.0) continue;
      // A Gaussian that ends smoothly at 3 sigma: a pixel entering the disc adds nothing.
      float w = exp(-rr * R * R * k) * (1.0 - smoothstep(0.64, 1.0, rr));
      m += r * (w * tlg_cover(x));
    }
  }
  float ml = length(m);
  return vec3(ml > 0.0 ? -m / ml : vec2(0.0), ml * st * st / (sigma * sigma * sigma * 2.50662827));
}
// The least scale of a bolt's direction, percent of the unit.
const float TLG_NORMAL = 10.0;
// The edge near e along inward (into the shape), on the alpha itself: where it crosses the field's level, half its peak
// there (tl_threshold), by bisection on the bilinear alpha within 2 px. The field's zero is good to its seeds, a tenth
// or two of a pixel; an antialiased edge crosses its level where the edge is, at every resolution.
vec2 tlg_alphaEdge(vec2 e, vec2 inward) {
#ifdef TLG_STANDALONE
  return e;
#else
  float peak = 0.0;
  for (int k = 1; k <= 3; k++) peak = max(peak, tlg_cover(e + inward * float(k)));
  float level = 0.5 * min(peak / 0.75, 1.0);
  float lo = -2.0, hi = 2.0;
  if (level < 0.01 || tlg_cover(e + inward * lo) >= level || tlg_cover(e + inward * hi) < level) return e;
  for (int i = 0; i < 14; i++) {
    float m = 0.5 * (lo + hi);
    if (tlg_cover(e + inward * m) >= level) hi = m;
    else lo = m;
  }
  return e + inward * (0.5 * (lo + hi));
#endif
}
// Where a site at q emits from (TL-062): the edge of the shape, seen from q, read so it is the same at every resolution. The
// way to it is the mass of the alpha around q at half q's distance from the edge (an area sum, see tlg_mass); a march along
// it meets the edge of the field, and the start is refined onto the alpha's own edge (tlg_alphaEdge). The bolt's direction
// is the mass around q too, at TLG_NORMAL or more: read at q, a seeded point, not at the start, which carries a tenth of a
// pixel of error that a sharp corner turns into a degree. Projecting q along the field's gradient instead (tlg_site) carries
// that gradient's few degrees of raster noise, which a site up to Capture away turns into pixels at the start, and a bolt two
// units long into more at its tip. Nothing pops: a site fades out where its mass balances (between two letters, in a counter), where its march meets the
// edge at a graze, where it passes close by a part of the shape before the edge it meets (there that edge would jump to the
// part), and towards Capture.
TlgSite tlg_boltSite(vec2 q, float capture) {
  TlgSite s;
  s.px = q;
  s.normal = vec2(1.0, 0.0);
  s.gate = 0.0;
  float d = tlg_d(q / u_canvasSize);
  if (abs(d) >= capture) return s;
  // The way to the edge follows the shape closely near it; the bolt's direction, a wider mass, follows its outline.
  float sw = max(0.5 * abs(d), max(tl_px(3.0), 1.0)), sn = max(0.5 * abs(d), max(tl_px(TLG_NORMAL), 1.0));
  vec3 m = tlg_mass(q, sw);
  vec3 mn = sn > sw ? tlg_mass(q, sn) : m;
  if (m.z <= 0.0) return s;
  // Into the shape from outside, out of it from inside.
  vec2 dir = d > 0.0 ? -m.xy : m.xy;
  // Sphere tracing: the field is a distance, so a step of it reaches the edge without passing it, but for the field's
  // sub-pixel error near the edge; a step that passes it is taken back to the crossing (regula falsi on the line).
  float side = d > 0.0 ? 1.0 : -1.0;
  float t = 0.0, t0 = 0.0, d0 = abs(d), low = abs(d), rise = 0.0, keep = 1.0;
  float near = tl_px(4.0), bump = tl_px(1.0);
  bool hit = false;
  for (int i = 0; i < 64; i++) {
    float di = side * tlg_d((q + dir * t) / u_canvasSize);
    if (di < 0.0) {
      float t1 = t, d1 = di;
      for (int j = 0; j < 4; j++) {
        t = t0 + (t1 - t0) * d0 / (d0 - d1);
        float dm = side * tlg_d((q + dir * t) / u_canvasSize);
        if (abs(dm) < 0.01) break;
        if (dm > 0.0) { t0 = t; d0 = dm; } else { t1 = t; d1 = dm; }
      }
      hit = true;
      break;
    }
    if (di < low) {
      // Below a closest approach that rose again: the march went by a part of the shape.
      keep = min(keep, mix(1.0, smoothstep(0.0, near, low), smoothstep(0.5 * bump, bump, rise)));
      low = di;
      rise = 0.0;
    } else rise = max(rise, di - low);
    if (di < 0.02) {
      hit = true;
      break;
    }
    t0 = t;
    d0 = di;
    t += di;
    if (t >= capture) break;
  }
  if (!hit) return s;
  s.px = tlg_alphaEdge(q + dir * t, side * dir);
  s.normal = mn.xy;
  float facing = abs(dot(dir, tlg_mass(s.px, max(tl_px(TLG_NORMAL), 1.0)).xy));
  s.gate = (1.0 - smoothstep(capture * 0.6, capture, t)) * smoothstep(0.03, 0.09, min(m.z, mn.z)) * smoothstep(0.3, 0.55, facing)
    * keep * tlg_field(s.px).y;
  return s;
}
// Where sites live: the layer box, or the sub-pixel alpha bounds of pass 0.
vec2 tlg_at(vec2 n) {
#if TLG_FINE_BOUNDS
  vec4 b = texelFetch(u_tlGenC, ivec2(0), 0);
  return mix(b.xy, b.zw, n);
#else
  return tlg_anchor(n);
#endif
}
TlgBolt tlg_bolt(int b) {
  float capture = max(tl_px(u_capture), 1.0);
  float L = tl_px(u_boltLength);
  TlgBolt o;
  vec2 q = tlg_at(vec2(tlg_rs(b, 1), tlg_rs(b, 2)));
  TlgSite s = tlg_boltSite(q, capture);
  o.gain = (0.7 + 0.3 * tlg_rs(b, 3)) * s.gate;
  o.a = s.px;
  o.n = s.normal;
  o.len = L * (0.55 + 0.45 * tlg_rs(b, 4));
  bool crawl = TLG_LIGHTNING == 2 || (TLG_LIGHTNING == 0 && tlg_rs(b, 5) < 0.45);
  if (crawl) {
    // Arc to another point of the edge roughly a bolt away along it, bulging outward.
    vec2 t = vec2(-s.normal.y, s.normal.x) * (tlg_rs(b, 6) < 0.5 ? -1.0 : 1.0);
    TlgSite e = tlg_boltSite(s.px + t * o.len + s.normal * o.len * 0.2, capture * 2.0);
    o.b = e.px;
    o.len = length(o.b - o.a);
    // Both ends must be awake, and an arc whose ends close in fades out.
    o.gain *= e.gate * smoothstep(tl_px(3.0), tl_px(6.0), o.len);
    o.n = normalize(s.normal + e.normal + vec2(1.0e-4, 0.0));
  } else {
    float ang = (tlg_rs(b, 7) - 0.5) * 1.3;
    float c0 = cos(ang), s0 = sin(ang);
    vec2 d = vec2(o.n.x * c0 - o.n.y * s0, o.n.x * s0 + o.n.y * c0);
    o.b = o.a + d * o.len;
  }
  if (o.gain <= 0.007) o.gain = 0.0;
  return o;
}
void main() {
  tlg_begin();
  ivec2 k = ivec2(floor(v_uv * u_resolution));
#if TLG_LIGHTNING == 3
  // Along the edge: the path of a seeded line through the shape, each point pulled onto the outline, hovering off it.
  int b = k.y;
  tlg_clock(b);
  float capture = max(tl_px(u_capture), 1.0);
  float L = tl_px(u_boltLength) * (0.5 + 0.5 * tlg_rs(b, 3));
  vec2 q = tlg_at(vec2(tlg_rs(b, 1), tlg_rs(b, 2)));
  float dirA = tlg_rs(b, 4) * FX_TAU;
  vec2 along = vec2(cos(dirA), sin(dirA));
  float x = float(k.x) / ${SEGMENTS}.0;
  TlgSite s = tlg_boltSite(q + along * L * (x - 0.5), capture);
  float hover = tl_px(u_wrinkle * 0.12) * (0.5 + 0.5 * tlg_jag(x, b, 3.0));
  vec2 p = s.px + s.normal * hover + vec2(-along.y, along.x) * u_wrinkle * 0.01 * tl_px(1.5) * tlg_jag(x * 4.0, b + 77, 0.0);
  fragColor = vec4(p, s.gate, 0.0);
#else
  int b = k.x / 2;
  tlg_clock(b);
  TlgBolt o = tlg_bolt(b);
  fragColor = k.x % 2 == 0 ? vec4(o.a, o.b) : vec4(o.n, o.gain, o.len);
#endif
}`;

/** Pass 2: the bolts as chains of capsules, MAX-blended, from pass 1's ends. */
const VERT_BOLTS = /* glsl */ `
out vec2 v_l;         // px along from the segment's centre, px across
flat out vec4 v_s;    // half length, core half width, intensity, glow px
// The bolt at x = 0..1: pinned at its ends, and thrown off the chord by the jag.
vec2 tlg_path(TlgBolt o, int b, float x, float amount, vec2 side, float bulge) {
  float pin = sqrt(max(sin(3.14159265 * x), 0.0));
  float off = amount * tlg_jag(x, b, 0.0) * pin + bulge * sin(3.14159265 * x);
  return mix(o.a, o.b, x) + side * off;
}
void main() {
  tlg_begin();
  int b = gl_InstanceID / ${PER_BOLT};
  int path = gl_InstanceID % ${PER_BOLT};
  tlg_clock(b);
  float gain = tlg_beat;
  float core = max(tl_px(u_coreWidth) * 0.5, 0.35);
  float glow = max(tl_px(u_glowSize), 0.0);
  int seg = gl_VertexID / 6;
  float x0 = float(seg) / ${SEGMENTS}.0, x1 = float(seg + 1) / ${SEGMENTS}.0;
  vec2 p0, p1;
  float taper = 1.0, inten = 1.0;
#if TLG_LIGHTNING == 3
  if (path > 0) { fx_cull(); return; }
  vec4 s0 = texelFetch(u_tlGenB, ivec2(seg, b), 0), s1 = texelFetch(u_tlGenB, ivec2(seg + 1, b), 0);
  float L = tl_px(u_boltLength) * (0.5 + 0.5 * tlg_rs(b, 3));
  p0 = s0.xy;
  p1 = s1.xy;
  // A jump across a counter or between letters is not an arc.
  if (s0.z <= 0.01 || s1.z <= 0.01 || length(p1 - p0) > L / ${SEGMENTS}.0 * 5.0 + tl_px(1.0)) { fx_cull(); return; }
  taper = 1.0 - 0.5 * abs(2.0 * x0 - 1.0);
  inten = 0.7 + 0.3 * tlg_rs(b, 5);
#else
  vec4 t0 = texelFetch(u_tlGenB, ivec2(2 * b, 0), 0), t1 = texelFetch(u_tlGenB, ivec2(2 * b + 1, 0), 0);
  if (t1.z <= 0.0) { fx_cull(); return; }
  TlgBolt o;
  o.a = t0.xy;
  o.b = t0.zw;
  o.n = t1.xy;
  o.gain = t1.z;
  o.len = t1.w;
  vec2 chord = o.b - o.a;
  float clen = max(length(chord), 1.0);
  vec2 side = vec2(-chord.y, chord.x) / clen;
  float jag = u_jaggedness * 0.01 * clen * 0.2;
  float bulge = dot(side, o.n) >= 0.0 ? 0.22 * clen : -0.22 * clen;
  bool crawled = TLG_LIGHTNING == 2 || (TLG_LIGHTNING == 0 && tlg_rs(b, 5) < 0.45);
  if (!crawled) bulge = 0.0;
  inten = o.gain;
  if (path == 0) {
    p0 = tlg_path(o, b, x0, jag, side, bulge);
    p1 = tlg_path(o, b, x1, jag, side, bulge);
    taper = 1.0 - 0.5 * x0;
  } else {
    // A branch leaves the bolt part of the way along, at an angle, shorter and dimmer.
    if (tlg_rs(b, 10 + path) > u_branches * 0.01 * 0.7) { fx_cull(); return; }
    float at = 0.2 + 0.6 * tlg_rs(b, 14 + path);
    vec2 root = tlg_path(o, b, at, jag, side, bulge);
    float rot = (tlg_rs(b, 18 + path) < 0.5 ? -1.0 : 1.0) * (0.35 + 0.5 * tlg_rs(b, 22 + path));
    float bl = (0.25 + 0.3 * tlg_rs(b, 26 + path)) * (1.0 - at);
    float cr = cos(rot), sr = sin(rot);
    vec2 tip = root + vec2(chord.x * cr - chord.y * sr, chord.x * sr + chord.y * cr) * bl;
    vec2 bd = tip - root;
    float bll = max(length(bd), 1.0);
    TlgBolt br = o;
    br.a = root;
    br.b = tip;
    vec2 bside = vec2(-bd.y, bd.x) / bll;
    float bj = jag * bl;
    p0 = tlg_path(br, b + path * 53, x0, bj, bside, 0.0);
    p1 = tlg_path(br, b + path * 53, x1, bj, bside, 0.0);
    taper = 0.55 * (1.0 - 0.7 * x0);
    inten *= 0.7;
  }
#endif
  // Thinner than a pixel, a core is drawn a pixel wide at its own energy: the same light at every resolution.
  float hw0 = core * taper;
  float hw = max(hw0, 0.5);
  inten *= hw0 / hw;
  float pad = hw * 1.6 + glow * 3.0 + 1.0;
  vec2 d = p1 - p0;
  float l = max(length(d), 1.0e-3);
  vec2 ux = d / l, uy = vec2(-ux.y, ux.x);
  vec2 q2 = tlg_corner(gl_VertexID);
  vec2 lc = q2 * vec2(0.5 * l + pad, pad);
  v_l = lc;
  v_s = vec4(0.5 * l, hw, inten * gain, glow);
  fx_emit(0.5 * (p0 + p1) + ux * lc.x + uy * lc.y);
}`;

const FRAG_SEGMENT = /* glsl */ `
in vec2 v_l;
flat in vec4 v_s;
void main() {
  // The distance to the capsule of this segment, so joints are round; MAX blending keeps them from doubling.
  float x = max(abs(v_l.x) - v_s.x, 0.0);
  float d = length(vec2(x, v_l.y));
  float w = v_s.y;
  float I = v_s.z;
  float g = max(v_s.w, 1.0e-3);
  // The glow ends inside the quad: an exponential cut at its edge would draw the quad.
  float end = 1.0 - smoothstep(0.6, 1.0, d / (3.0 * g + w * 1.6));
  fragColor = vec4(I * exp(-d * d / (w * w) * 2.2), I * exp(-d / (0.3 * g)) * end, I * exp(-d / g) * end, 1.0);
}`;

export const GENERATOR_LIGHTNING = defineGenerator({
	id: 'lightning',
	label: 'Lightning',
	effectLabel: 'Title Lightning',
	description:
		'Electric arcs shooting from the edges of the title and crawling over them, boiling or crawling.',
	keywords: ['electric', 'arc', 'bolt', 'plasma', 'energy', 'electrify'],
	params: [
		lp.choice('mode', 'Arcs', MODES, ['Mixed', 'Shoot Outward', 'Crawl Along Edge', 'Along Edge'], 'mixed'),
		lp.choice('motion', 'Motion', ['boil', 'crawl'], ['Hold-Frame Boil', 'Continuous Crawl'], 'boil'),
		...boilParams(12),
		lp.number('crawlSpeed', 'Crawl Speed', 1.2, { min: -20, max: 20, softMin: 0, softMax: 6, step: 0.01 }),
		lp.number('count', 'Bolt Count', 12, { min: 1, max: 40, step: 1 }),
		lp.number('arcs', 'Arc Count', 24, { min: 1, max: 60, step: 1 }),
		// Hard maxima at twice the slider's end: a bolt's reach is about 2.8 lengths (jagged), and a site up to Capture away
		// (twice it for crawling arcs) is reached; both are padding. Default and slider end set the fingerprints.
		lp.distance('boltLength', 'Bolt Length', 110, { min: 1, softMax: 400, max: 800 }),
		lp.percent('jaggedness', 'Jaggedness', 55, { range: { max: 150 } }),
		lp.percent('branches', 'Branching', 60),
		lp.percent('wrinkle', 'Wrinkle', 60, { range: { max: 150 } }),
		lp.distance('coreWidth', 'Core Width', 1.75, { min: 0.1, softMax: 10 }),
		lp.distance('glowSize', 'Glow Size', 9, { softMax: 40 }),
		lp.number('glowStrength', 'Glow Strength', 100, { min: 0, max: 300, step: 1 }, { unit: '%' }),
		lp.color('color', 'Glow Colour', hex('#4fd8ff')),
		lp.number('intensity', 'Intensity', 100, { min: 0, max: 300, step: 1 }, { unit: '%' }),
		lp.distance('capture', 'Capture', 20, { min: 0.5, softMax: 80, max: 160 }),
		anchorParam(),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	shapeAware: true,
	front: true,
	standIn: 'disc',
	usesBounds: () => true,
	color: { role: 'glow', mode: 'light' },
	defines: (p) =>
		`#define TLG_LIGHTNING ${Math.max(0, MODES.indexOf(String(p.mode)))}\n#define TLG_FINE_BOUNDS ${fineBounds(p) ? 1 : 0}\n`,
	presets: [
		{ id: 'bolts', label: 'Lightning Bolts', params: {} },
		{
			id: 'electric',
			label: 'Electric Blue',
			params: {
				mode: 'outward',
				count: 9,
				boltLength: 85,
				jaggedness: 60,
				coreWidth: 1.1,
				glowSize: 6,
				glowStrength: 110,
				color: hex('#5fd8ff'),
				variation: 4,
			},
		},
		{ id: 'electrify', label: 'Electrify', params: { mode: 'edge', motion: 'crawl', variation: 3 } },
		{
			id: 'boil',
			label: 'Red Boil',
			params: { mode: 'edge', boilRate: 8, color: hex('#ff4a6a'), glowSize: 7, variation: 8 },
		},
	],
	reach: reachOf,
	// An arc's far end is found up to twice Capture away: the field must be a distance there too (beyond its reach it is
	// clamped, at a value in pixels, which would differ between resolutions).
	fieldReach: (p) => {
		const outside = (crawls(p) ? 2 : 1) * num(p.capture) + 4;
		return { outside, inside: num(p.capture) + 4 };
	},
	timeDependent: () => true,
	summary: (p) => `${String(p.mode)}, ${boltCount(p)} arcs, ${pct(p.boltLength)}`,
	prepass: (p, c) => {
		const data = {
			format: 'rgba32f' as const,
			filter: 'nearest' as const,
			include: [GLSL_TLG_SITES, GLSL_TLG_BOLT],
		};
		const edge = edgeMode(p);
		return [
			...(fineBounds(p)
				? [c.pass({ ...data, output: 'tlGenC', size: { width: 1, height: 1 }, frag: FRAG_FINE_BOUNDS })]
				: []),
			// Every bolt's ends and direction once, not once per vertex: the reads that make them resolution independent are
			// area sums of hundreds of pixels.
			c.pass({
				...data,
				output: 'tlGenB',
				size: edge ? { width: SEGMENTS + 1, height: boltCount(p) } : { width: 2 * boltCount(p), height: 1 },
				frag: FRAG_BOLTS,
			}),
			c.pass({
				output: 'tlGenA',
				format: 'rgba16f',
				include: [GLSL_UV, GLSL_TLG_BOLT, GLSL_TLG_QUAD],
				draw: {
					vertices: SEGMENTS * 6,
					instances: boltCount(p) * PER_BOLT,
					blend: 'max',
					vert: VERT_BOLTS,
				},
				frag: FRAG_SEGMENT,
			}),
		];
	},
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) {
  vec3 v = texture(u_tlGenA, s.uv).rgb;
  vec3 col = tlg_rgb(u_color);
  vec3 light = v.r * mix(col, vec3(1.0), 0.8) * 1.6 + (v.g * 0.9 + v.b * 0.45) * col * (u_glowStrength * 0.01);
  return tlg_light(light * (u_intensity * 0.01));
}`,
});

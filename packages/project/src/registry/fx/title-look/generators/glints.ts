// Glints (TL-061, TL-062): star sparkles on the highlights of a title, after Pachislop's generators/glints.ts, whose
// placement reads a grid back to the CPU for one still frame. Here placement runs on the GPU every frame, deterministic
// and with no read-back, and a star keeps its identity across frames. There is no history to carry an identity with
// (TL-061), so identity is spatial:
//   1. analysis: luminance of what is below the layer, on a grid fixed in units of the title (the resolution does not
//      change it), smoothed, then non-maximum suppression, prominence over the neighbourhood, regional normalisation,
//      face bias from the field and Hessian ridge rejection pick peaks with a score, each at a sub-cell position;
//   2. homes: 64 seeded homes in the anchor box. A home is a star's identity: its size jitter, rotation and twinkle
//      phase belong to it. Each home takes the strongest peak under a Gaussian prior around it. The prior is the
//      hysteresis: a peak has to beat the one a star holds by the prior's margin to take it, whatever else moves;
//   3. greedy spacing: the strongest homes win, as Pachislop's pickHighlights, in one pass over the 64 candidates.
//      Nothing here can pop: a star's strength fades with its margin over its runner-up in the window and over the first
//      home left out, and spacing is a smooth suppression, so a swap happens where both are invisible.
// `jasper.s.glint` puts rays on every highlight of a picture, as a filter, and has no stars to keep; this one is in a look.
import { GLSL_UV } from '../../glsl/sample.ts';
import type { GlslChunk } from '../../shader.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG_QUAD } from './light-streaks.ts';
import { anchorParam, GLSL_TLG, GLSL_TLG_SITES, hex, num, pct, variationParam } from './shared.ts';

const PLACEMENTS = ['highlights', 'peaks', 'hero', 'scatter', 'point'];
/** Homes, and so the most stars of the highlight placements. */
const HOMES = 64;
/** Analysis cell, percent of the unit: about Pachislop's 4 px on a 200 px title. */
const CELL = 2;
/** Small glints' radius, a share of the sparkle size. */
const SMALL = 0.34;
/** How much sparkles avoid lit edges. */
const RIDGE = 0.7;

const analysed = (p: LayerParams) => p.placement !== 'scatter' && p.placement !== 'point';

const HOME = /* glsl */ `
// The seeded home of star k: a low-discrepancy sequence (R2), so homes spread evenly for any seed.
vec2 tlg_homeUv(int k) {
  float a = float(k) + 1.0;
  return fract(vec2(0.7548776662, 0.5698402910) * a + vec2(tlg_h(0, 40), tlg_h(0, 41)));
}`;

const LUM = 'vec3(0.2126, 0.7152, 0.0722)';

/** Pass 1: luminance, coverage and distance, box means over the cells. */
const FRAG_GRID = /* glsl */ `
void main() {
  tlg_begin();
  ivec2 p = ivec2(floor(v_uv * u_resolution));
  int n = int(clamp(ceil(u_canvasSize.x / u_resolution.x), 1.0, 6.0));
  float lum = 0.0, a = 0.0;
  for (int y = 0; y < n; y++)
    for (int x = 0; x < n; x++) {
      vec2 uv = (vec2(p) + (vec2(x, y) + 0.5) / float(n)) / u_resolution;
#ifdef TLG_STANDALONE
      vec4 c = texture(u_source, uv);
      if (c.a <= 0.0) {
        // A transparent solid has no picture: the stand-in disc gives the stars somewhere to sit.
        TlSurface st = tl_surfaceAt(uv);
        c = vec4(vec3(st.alpha * (0.4 + 0.6 * tlg_vnoise(uv * u_resolution / 6.0))), st.alpha);
      }
#else
      vec4 c = texture(u_tlComp, uv);
#endif
      lum += dot(c.rgb, ${LUM});
      a += min(c.a, 1.0);
    }
  float k = 1.0 / float(n * n);
  fragColor = vec4(lum * k, a * k, tlg_d(v_uv), 1.0);
}`;

/** Pass 2: a Gaussian of about 1.4 cells, strong enough that thin lines pool into one peak at every size. */
const FRAG_SMOOTH = /* glsl */ `
void main() {
  ivec2 sz = textureSize(u_tlGenA, 0);
  ivec2 p = ivec2(floor(v_uv * vec2(sz)));
  float sum = 0.0, wsum = 0.0;
  for (int y = -3; y <= 3; y++)
    for (int x = -3; x <= 3; x++) {
      vec4 t = texelFetch(u_tlGenA, clamp(p + ivec2(x, y), ivec2(0), sz - 1), 0);
      // The deep middle of a stroke wins a tie: a flat fill still has junctions for stars to sit on, and they move with it.
      float w = exp(-0.25 * float(x * x + y * y));
      sum += t.x * (1.0 + 0.25 * clamp(-t.z / tl_px(8.0), 0.0, 1.0)) * w;
      wsum += w;
    }
  vec4 c = texelFetch(u_tlGenA, p, 0);
  fragColor = vec4(sum / wsum, c.y, c.z, 1.0);
}`;

/** Pass 3: the peaks, as canvas px and score. Every step of Pachislop's findHighlights, on one cell at a time. */
const FRAG_PEAKS = /* glsl */ `
vec4 tlg_at(ivec2 q) { return texelFetch(u_tlGenB, q, 0); }
float tlg_vertex(float l, float c, float r) {
  float d = l - 2.0 * c + r;
  return d < 0.0 ? clamp(0.5 * (l - r) / d, -0.5, 0.5) : 0.0;
}
void main() {
  ivec2 sz = textureSize(u_tlGenB, 0);
  ivec2 p = ivec2(floor(v_uv * vec2(sz)));
  fragColor = vec4(0.0);
  if (p.x < 2 || p.y < 2 || p.x >= sz.x - 2 || p.y >= sz.y - 2) return;
  vec4 c0 = tlg_at(p);
  float c = c0.x;
  if (c0.y < 0.5 || c <= 0.0) return;
  // Non-maximum suppression: strict against the cells before this one in scan order, so a plateau yields one peak.
  if (tlg_at(p + ivec2(-1, -1)).x >= c || tlg_at(p + ivec2(0, -1)).x >= c || tlg_at(p + ivec2(1, -1)).x >= c) return;
  if (tlg_at(p + ivec2(-1, 0)).x >= c) return;
  if (tlg_at(p + ivec2(1, 0)).x > c || tlg_at(p + ivec2(-1, 1)).x > c || tlg_at(p + ivec2(0, 1)).x > c || tlg_at(p + ivec2(1, 1)).x > c) return;
  // The brightest and the deepest of its part of the title, and the mean around it.
  float region = 0.0, deep = 0.0, bg = 0.0, bgN = 0.0;
  for (int y = -30; y <= 30; y += 3)
    for (int x = -30; x <= 30; x += 3) {
      ivec2 q = p + ivec2(x, y);
      if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
      vec4 t = tlg_at(q);
      if (t.y >= 0.5) { region = max(region, t.x); deep = max(deep, -t.z); }
    }
  for (int y = -6; y <= 6; y += 2)
    for (int x = -6; x <= 6; x += 2) {
      bg += tlg_at(clamp(p + ivec2(x, y), ivec2(0), sz - 1)).x;
      bgN += 1.0;
    }
  bg /= bgN;
  float ref = max(region, 1.0e-6);
  if (c < ref * u_threshold * 0.01) return;
  float wDepth = 1.0;
  if (u_faceBias > 0.0 && deep > 0.0)
    wDepth = 1.0 - u_faceBias * 0.01 * (1.0 - smoothstep(0.1, 0.5, -c0.z / deep));
  // Hessian eigenvalues: a spot or a corner curves down both ways, a ridge only across itself.
  float l2 = tlg_at(p + ivec2(-2, 0)).x, r2 = tlg_at(p + ivec2(2, 0)).x;
  float u2 = tlg_at(p + ivec2(0, -2)).x, d2 = tlg_at(p + ivec2(0, 2)).x;
  float lxx = l2 - 2.0 * c + r2, lyy = u2 - 2.0 * c + d2;
  float lxy = 0.25 * (tlg_at(p + ivec2(2, 2)).x - tlg_at(p + ivec2(-2, 2)).x - tlg_at(p + ivec2(2, -2)).x + tlg_at(p + ivec2(-2, -2)).x);
  float m = 0.5 * (lxx + lyy);
  float q = sqrt(0.25 * (lxx - lyy) * (lxx - lyy) + lxy * lxy);
  float strong = min(0.0, m - q), weak = min(0.0, m + q);
  float iso = strong < 0.0 ? weak / strong : 0.0;
  float wRidge = 1.0 - ${RIDGE.toFixed(2)} * (1.0 - sqrt(iso));
  float score = ((c - bg + 0.15 * c) / ref) * wDepth * wRidge;
  if (score <= 0.0) return;
  vec2 f = vec2(tlg_vertex(tlg_at(p + ivec2(-1, 0)).x, c, tlg_at(p + ivec2(1, 0)).x),
                tlg_vertex(tlg_at(p + ivec2(0, -1)).x, c, tlg_at(p + ivec2(0, 1)).x));
  vec2 cell = u_canvasSize / vec2(sz);
  fragColor = vec4((vec2(p) + 0.5 + f) * cell, score, 1.0);
}`;

/** Pass 4: each home's star: position, score, and how far it stands above the runner-up in its window. */
const FRAG_STARS = /* glsl */ `${HOME}
void main() {
  tlg_begin();
  int k = int(floor(v_uv.x * u_resolution.x));
  vec2 home = tlg_anchor(tlg_homeUv(k));
  ivec2 sz = textureSize(u_tlGenC, 0);
  vec2 cell = u_canvasSize / vec2(sz);
  vec4 b = u_anchor == 1 ? tl_bounds() : tlg_layout();
  vec2 span = max(b.zw - b.xy, vec2(1.0));
  // The prior: as wide as a home's share of the box, and this wide even for a title much smaller than its box.
  float sigma = 0.75 * sqrt(span.x * span.y / ${HOMES}.0);
  ivec2 c0 = ivec2(floor(home / cell));
  int w = int(clamp(ceil(2.5 * sigma / cell.x), 2.0, 32.0));
  float tie = tl_px(4.0);
  float best = 0.0, second = 0.0, bestS = 0.0;
  vec2 bestP = home;
  for (int y = -w; y <= w; y++)
    for (int x = -w; x <= w; x++) {
      ivec2 q = c0 + ivec2(x, y);
      if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
      vec4 t = texelFetch(u_tlGenC, q, 0);
      if (t.w < 0.5) continue;
      vec2 r = t.xy - home;
      float v = t.z * exp(-0.5 * dot(r, r) / (sigma * sigma));
      if (v > best) {
        if (length(t.xy - bestP) > tie) second = max(second, best);
        best = v;
        bestS = t.z;
        bestP = t.xy;
      } else if (length(t.xy - bestP) > tie) second = max(second, v);
    }
  float margin = best > 0.0 ? smoothstep(0.0, 0.3, (best - second) / best) : 0.0;
  fragColor = vec4(bestP, bestS, margin);
}`;

/** Pass 5: greedy spacing over the candidates, in one pass: (size factor, intensity, is hero, _). */
const FRAG_PICK = /* glsl */ `
float tlg_sizeOf(float score, float top, float variation) {
  float t = clamp((top - score) / (0.3 * top), 0.0, 1.0);
  return 1.0 - variation * t;
}
void main() {
  int me = int(floor(v_uv.x * u_resolution.x));
  vec4 cand[${HOMES}];
  float score[${HOMES}], supp[${HOMES}];
  bool taken[${HOMES}];
  float top = 0.0;
  for (int i = 0; i < ${HOMES}; i++) {
    cand[i] = texelFetch(u_tlGenA, ivec2(i, 0), 0);
    score[i] = cand[i].z * cand[i].w;
    supp[i] = 1.0;
    taken[i] = false;
    top = max(top, score[i]);
  }
  fragColor = vec4(0.0);
  if (top <= 0.0 || score[me] <= 0.0) return;
  vec4 b = tl_bounds();
  float size = tl_px(u_size);
  float sv = u_sizeVariation * 0.01, bv = u_brightnessVariation * 0.01;
  float spacing = tl_px(u_spacing);
#if TLG_PLACEMENT == 0
  int nLarge = int(floor(u_large + 0.5)), total = nLarge + int(floor(u_small + 0.5));
  float span = 0.7 * length(b.zw - b.xy) / max(1.0, float(nLarge));
  float sep0 = max(spacing, span), sep1 = 0.5 * spacing;
#elif TLG_PLACEMENT == 1
  int nLarge = 0, total = int(floor(u_stars + 0.5));
  float sep0 = 0.9 * size, sep1 = 0.9 * size;
#else
  int nLarge = 1, total = 1 + int(floor(u_heroStars + 0.5));
  float sep0 = spacing, sep1 = spacing;
#endif
  total = min(total, ${HOMES} - 1);
  float margin = 0.08 * top;
  float cutLarge = -1.0, runner = 0.0;
  bool picked = false;
  int rank = 0;
  for (int pick = 0; pick <= total; pick++) {
    int best = -1;
    float bs = 0.0;
    for (int i = 0; i < ${HOMES}; i++) {
      if (taken[i]) continue;
      float s = score[i] * supp[i];
#if TLG_PLACEMENT == 2
      // The hero's core sits inside the central band, so its streak fits the title.
      if (pick == 0 && abs(cand[i].x - 0.5 * (b.x + b.z)) > 0.35 * (b.z - b.x)) continue;
#endif
      if (s > bs) { bs = s; best = i; }
    }
    if (best < 0) break;
    if (pick == nLarge) cutLarge = bs;
    if (pick == total) { runner = bs; break; }
    taken[best] = true;
    if (best == me) { picked = true; rank = pick; }
    float sep = pick < nLarge ? sep0 : sep1;
    for (int i = 0; i < ${HOMES}; i++) {
      if (taken[i]) continue;
      supp[i] *= smoothstep(0.75 * sep, 1.05 * sep, length(cand[i].xy - cand[best].xy));
    }
  }
  if (!picked) return;
  float s = score[me];
  float fade = clamp((s - runner) / margin, 0.0, 1.0);
#if TLG_PLACEMENT == 0
  // A star's class follows its score, so two near-tied stars swapping rank keep near-equal sizes.
  float large = nLarge > 0 ? smoothstep(cutLarge - margin, cutLarge + margin, s) : 0.0;
  float big = tlg_sizeOf(s, top, 0.5 * sv);
  float sf = mix(${SMALL.toFixed(2)}, big, large);
  float inten = mix(1.0 - bv * 0.6, 1.0 - bv * (1.0 - big), large);
  fragColor = vec4(sf * (0.6 + 0.4 * fade), inten * fade, 0.0, 1.0);
#elif TLG_PLACEMENT == 1
  float sf = tlg_sizeOf(s, top, sv);
  fragColor = vec4(sf * (0.6 + 0.4 * fade), (0.4 + 0.6 * sf) * fade, 0.0, 1.0);
#else
  if (rank == 0) fragColor = vec4(1.0, 1.0, 1.0, 1.0);
  else fragColor = vec4(0.45 * (0.6 + 0.4 * fade), (1.0 - bv * 0.4) * fade, 0.0, 1.0);
#endif
}`;

const STAR_VERT = /* glsl */ `${HOME}
out vec2 v_l;
flat out vec4 v_s;   // intensity, hero half length px, hero half cross px, hero thickness px
flat out float v_rot;
void main() {
  tlg_begin();
  int k = gl_InstanceID;
  float size = tl_px(u_size);
  float pos0, sizeK = 1.0, inten = 1.0, heroK = 0.0;
  vec2 at;
#if TLG_PLACEMENT == 4
  at = fx_canvasPxOfLayerNorm(u_center);
#elif TLG_PLACEMENT == 3
  // Scatter: seeded sites over and around the shape; the gate says which are near it, smoothly.
  float spread = max(tl_px(u_scatterSpread), 1.0);
  vec2 lo = tlg_anchor(vec2(0.0)) - spread, hi = tlg_anchor(vec2(1.0)) + spread;
  at = mix(lo, hi, vec2(tlg_h(k, 50), tlg_h(k, 51)));
  float d = tlg_field(at).x;
  float gate = 1.0 - smoothstep(0.7 * spread, spread, max(d, 0.0));
  if (!u_scatterInside) gate *= smoothstep(0.0, tl_px(2.0), d);
  if (gate <= 0.0) { fx_cull(); return; }
  sizeK = (1.0 - u_sizeVariation * 0.01 + u_sizeVariation * 0.01 * tlg_h(k, 52)) * gate;
  inten = (1.0 - u_brightnessVariation * 0.01 * tlg_h(k, 53)) * gate;
#else
  vec4 st = texelFetch(u_tlGenA, ivec2(k, 0), 0);
  vec4 pick = texelFetch(u_tlGenB, ivec2(k, 0), 0);
  if (pick.w < 0.5 || pick.y <= 0.0) { fx_cull(); return; }
  at = st.xy;
  sizeK = pick.x;
  inten = pick.y;
  heroK = pick.z;
#endif
  // What belongs to the star, whatever peak it holds: its jitter, and its twinkle.
  float jit = u_jitter * 0.01;
  sizeK *= 1.0 + 0.4 * jit * (tlg_h(k, 54) - 0.5);
  float rot = radians(u_rotation) + 0.42 * jit * (tlg_h(k, 55) - 0.5);
  float tw = u_twinkle * 0.01;
  float beat = 0.5 + 0.5 * sin(6.28318531 * (u_tlTime * u_twinkleRate * (0.6 + 0.8 * tlg_h(k, 56)) + tlg_h(k, 57)));
  float pulse = beat * beat * beat;
  inten *= mix(1.0, 0.2 + 1.2 * pulse, tw);
  sizeK *= mix(1.0, 0.8 + 0.35 * pulse, tw);
  float r = size * sizeK;
  vec2 q = tlg_corner(gl_VertexID);
  float hx = r, hy = r;
  float heroLen = 0.0, heroCross = 0.0, heroT = 0.0;
  if (heroK > 0.5) {
    heroLen = max(tl_px(u_heroLength), 1.0);
    heroCross = heroLen * u_heroCross * 0.01;
    heroT = max(size * u_heroThickness * 0.01, 0.5);
    rot = radians(u_heroAngle);
    hx = heroLen;
    hy = max(heroCross, 4.0 * heroT);
  }
  v_l = q * vec2(hx, hy);
  v_s = vec4(inten, heroLen, heroCross, heroT);
  v_rot = r;
  float c = cos(rot), s = sin(rot);
  fx_emit(at + vec2(c * v_l.x - s * v_l.y, s * v_l.x + c * v_l.y));
}`;

const STAR_FRAG = /* glsl */ `
in vec2 v_l;
flat in vec4 v_s;
flat in float v_rot;
vec3 tlg_spectrum(float t) {
  return clamp(abs(fract(t + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
vec3 tlg_ray(vec2 v, float ang, float len, float thin) {
  vec2 d = vec2(cos(ang), sin(ang));
  float al = abs(dot(v, d)) / len;
  if (al >= 1.0) return vec3(0.0);
  float pe = abs(dot(v, vec2(-d.y, d.x)));
  float w = thin * (1.0 - al) + 0.003;
  float fall = pow(1.0 - al, 1.2);
  if (!u_spectral) return vec3((exp(-pe / w) + 0.35 * exp(-pe / (w * 4.0))) * fall);
  // Cross-screen diffraction: the sheath fans out by wavelength and the ray runs violet to red, leaving the centre white.
  vec3 wc = w * vec3(1.4, 1.0, 0.7);
  vec3 i = exp(-pe / wc) + 0.5 * exp(-pe / (wc * 4.0));
  vec3 tint = mix(vec3(1.0), 1.7 * tlg_spectrum(0.72 * (1.0 - fract(al * 2.0 + 0.15))), smoothstep(0.04, 0.2, al));
  return i * tint * fall;
}
vec3 tlg_anamorphic(vec2 lv, float size, float len, vec3 col) {
  float sy = abs(lv.y) / size;
  float sx = abs(lv.x) / max(len, 1.0);
  float streak = exp(-sy * 28.0) * exp(-sx * 2.2) * 1.4 + exp(-sy * 7.0) * exp(-sx * 4.0) * 0.35;
  return mix(col, vec3(1.0), exp(-sx * 6.0) * exp(-sy * 40.0)) * streak;
}
// A thin line tapering to nothing at the end of its length: it carries the streak across the whole span.
vec3 tlg_taper(vec2 lv, float t, float len, vec3 col) {
  float f = max(1.0 - abs(lv.x) / max(len, 1.0), 0.0);
  float ay = abs(lv.y) / t;
  return mix(col, vec3(1.0), f * f) * (exp(-ay * 30.0) * 1.3 + exp(-ay * 6.0) * 0.2) * pow(f, 1.1);
}
void main() {
  vec3 col = tlg_rgb(u_color);
  vec3 c;
  if (v_s.y > 0.0) {
    float t = v_s.w;
    float r = length(v_l) / (t * 0.6);
    vec3 L = vec3(exp(-r * r * 18.0) * 2.0 + 0.2 / (1.0 + r * r * 6.0)) + col * 0.3 / (1.0 + r * r * 1.5);
    L += tlg_anamorphic(v_l, t, v_s.y / 2.5, col) + tlg_taper(v_l, t, v_s.y, col);
    L += tlg_anamorphic(v_l.yx, t * 0.8, v_s.z / 2.5, col) + tlg_taper(v_l.yx, t * 0.8, v_s.z, col);
    // The quad's own rim: light ends before it does.
    vec2 e = abs(v_l) / vec2(v_s.y, max(v_s.z, 4.0 * t));
    c = L * (1.0 - smoothstep(0.8, 1.0, max(e.x, e.y)));
  } else {
    vec2 v = v_l / max(v_rot, 1.0e-3);
    float r = length(v);
    float thin = (TLG_PLACEMENT == 1 || TLG_PLACEMENT == 4 ? 0.026 : 0.035) * (u_thickness * 0.01);
    vec3 I;
    float haloK = 0.6;
    if (u_rays == 0) I = tlg_ray(v, 0.0, 1.0, thin) + tlg_ray(v, 1.5708, 1.0, thin);
    else if (u_rays == 1) {
      float t = thin * 0.7;
      I = tlg_ray(v, 1.5708, 1.0, t) + tlg_ray(v, 0.5236, 1.0, t) + tlg_ray(v, 2.618, 1.0, t);
      haloK = 0.35;
    } else {
      I = tlg_ray(v, 0.0, 1.0, thin) + tlg_ray(v, 1.5708, 1.0, thin) + 0.6 * (tlg_ray(v, 0.7854, 0.5, thin) + tlg_ray(v, -0.7854, 0.5, thin));
    }
    float core = exp(-r * r * 50.0);
    float halo = exp(-r * 6.0) * haloK * (1.0 - smoothstep(0.7, 1.0, r));
    float lum = dot(I, vec3(0.3333));
    c = col * (I + halo) + vec3(core * 2.0 + lum * 0.6 * exp(-r * 2.5));
  }
  c *= v_s.x;
  fragColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
}`;

const QUAD: readonly GlslChunk[] = [GLSL_UV, GLSL_TLG_QUAD];

export const GENERATOR_GLINTS = defineGenerator({
	id: 'glints',
	label: 'Glints',
	description:
		'Star sparkles that hold on to the highlights of the title as it moves, each with its own twinkle.',
	keywords: ['sparkle', 'star', 'twinkle', 'shine', 'glitter', 'cross filter'],
	params: [
		lp.choice(
			'placement',
			'Placement',
			PLACEMENTS,
			['On Highlights', 'Hottest Peaks', 'Hero Glint', 'Scatter', 'Fixed Point'],
			'highlights',
		),
		lp.number('large', 'Large Glints', 5, { min: 0, max: 20, step: 1 }),
		lp.number('small', 'Small Glints', 6, { min: 0, max: 40, step: 1 }),
		lp.number('stars', 'Star Count', 5, { min: 1, max: 40, step: 1 }),
		lp.number('scatterCount', 'Scatter Count', 40, { min: 1, max: 400, softMax: 120, step: 1 }),
		lp.distance('scatterSpread', 'Scatter Area', 30, { softMax: 200 }),
		lp.toggle('scatterInside', 'Scatter Over Shape', true),
		lp.distance('heroLength', 'Hero Streak', 160, { min: 1, softMax: 600 }),
		lp.percent('heroThickness', 'Hero Thickness', 100, { range: { max: 400 } }),
		lp.percent('heroCross', 'Vertical Spike', 22),
		lp.angle('heroAngle', 'Streak Angle', 0),
		lp.number('heroStars', 'Small Stars', 3, { min: 0, max: 8, step: 1 }),
		lp.point('center', 'Position', [0.5, 0.5]),
		lp.distance('size', 'Star Size', 25, { min: 1, softMax: 200 }),
		lp.percent('sizeVariation', 'Size Variation', 60),
		lp.percent('threshold', 'Highlight Threshold', 30),
		lp.distance('spacing', 'Min. Spacing', 40, { softMax: 300 }),
		lp.percent('faceBias', 'Face Priority', 70),
		lp.percent('jitter', 'Size and Angle Jitter', 50),
		lp.percent('twinkle', 'Twinkle', 70),
		lp.number(
			'twinkleRate',
			'Twinkle Rate',
			0.9,
			{ min: 0, max: 20, softMax: 5, step: 0.01 },
			{ unit: 'Hz' },
		),
		anchorParam(),
		lp.choice(
			'rays',
			'Shape',
			['four', 'snow', 'eight'],
			['4-Ray Cross', '6-Ray Snow Cross', '8-Ray Star'],
			'four',
		),
		lp.toggle('spectral', 'Rainbow Rays', false),
		lp.percent('thickness', 'Ray Thickness', 100, { range: { max: 400 } }),
		lp.color('color', 'Colour', hex('#fff4c0')),
		lp.number('intensity', 'Intensity', 130, { min: 0, max: 400, step: 1 }, { unit: '%' }),
		lp.angle('rotation', 'Rotation', 0),
		lp.percent('brightnessVariation', 'Brightness Variation', 50),
		variationParam(),
	],
	include: [GLSL_TLG],
	shapeAware: true,
	front: true,
	standIn: 'disc',
	usesBounds: () => true,
	color: { role: 'glow', mode: 'light' },
	defines: (p) => `#define TLG_PLACEMENT ${Math.max(0, PLACEMENTS.indexOf(String(p.placement)))}\n`,
	presets: [
		{ id: 'highlights', label: 'Highlight Glints', params: {} },
		{
			id: 'hero',
			label: 'Hero Glint',
			params: { placement: 'hero', size: 26, color: hex('#fff6dc'), intensity: 140 },
		},
		{
			id: 'stars',
			label: 'Star Glints',
			params: {
				placement: 'peaks',
				stars: 4,
				threshold: 60,
				size: 45,
				sizeVariation: 50,
				rays: 'eight',
				color: hex('#ffffff'),
				intensity: 140,
			},
		},
		{
			id: 'rainbow',
			label: 'Rainbow Glints',
			params: {
				large: 4,
				small: 6,
				size: 32,
				threshold: 40,
				spectral: true,
				color: hex('#ffffff'),
				intensity: 140,
			},
		},
		{
			id: 'scatter',
			label: 'Scattered Sparkles',
			params: {
				placement: 'scatter',
				scatterCount: 60,
				size: 13,
				scatterSpread: 5,
				color: hex('#e8fbff'),
				intensity: 110,
				variation: 3,
			},
		},
	],
	reach: (p) => {
		if (p.placement === 'hero') return num(p.heroLength) + 2;
		if (p.placement === 'scatter') return num(p.scatterSpread) + num(p.size) * 1.3 + 2;
		return num(p.size) * 1.4 + 2;
	},
	fieldReach: (p) =>
		p.placement === 'scatter' ? { outside: num(p.scatterSpread) + 2 } : { outside: 1, inside: 30 },
	timeDependent: (p) => num(p.twinkle) > 0 && num(p.twinkleRate) > 0,
	summary: (p) => `${String(p.placement)}, ${pct(p.size)}`,
	prepass: (p, c) => {
		const stars = {
			output: 'tlGenC',
			format: 'rgba16f' as const,
			include: QUAD,
			draw: {
				vertices: 6,
				instances:
					p.placement === 'point' ? 1 : p.placement === 'scatter' ? Math.round(num(p.scatterCount)) : HOMES,
				blend: 'add' as const,
				vert: STAR_VERT,
			},
			frag: STAR_FRAG,
		};
		if (!analysed(p)) return [c.pass({ ...stars, include: [...QUAD, GLSL_TLG_SITES] })];
		// Cells fixed in units of the title: the same grid at every resolution.
		const scale = 1 / Math.max(2, CELL * c.pxPerPercent);
		const grid = { format: 'rgba16f' as const, filter: 'nearest' as const, scale };
		const data = (width: number) => ({
			format: 'rgba32f' as const,
			filter: 'nearest' as const,
			size: { width, height: 1 },
		});
		return [
			c.pass({ ...grid, output: 'tlGenA', frag: FRAG_GRID }),
			c.pass({ ...grid, output: 'tlGenB', frag: FRAG_SMOOTH }),
			c.pass({ format: 'rgba32f', filter: 'nearest', scale, output: 'tlGenC', frag: FRAG_PEAKS }),
			c.pass({ ...data(HOMES), output: 'tlGenA', include: [GLSL_TLG_SITES], frag: FRAG_STARS }),
			c.pass({ ...data(HOMES), output: 'tlGenB', frag: FRAG_PICK }),
			c.pass({ ...stars, include: [...QUAD, GLSL_TLG_SITES] }),
		];
	},
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) { return tlg_light(texture(u_tlGenC, s.uv).rgb * (u_intensity * 0.01)); }`,
});

// The GL mask rasteriser (wp masks): GLSL ES 3.00 fragment shader of the mask pass, the exact counterpart of
// `rasterizeMaskPack` (masks/raster.ts — same packed data, same algorithm, same coverage formula). The preview
// and Remotion renders run it on the fx GPU host (packages/compositions/src/fx/mask.ts).
//
// Modes: 0 = apply (Opacity masks: premultiplied picture × coverage), 1 = mix (an effect limited to its masks:
// mix(original, effected, coverage)), 2 = coverage (white × coverage, for tests and the matte view).
// Pixel centres come from gl_FragCoord (exact half-integers): the pass draws into the bottom-left `u_size` of the
// host canvas, flipped, so canvas px = (x, H − y).

export const MASK_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
uniform sampler2D u_orig;
uniform highp sampler2D u_maskData;
uniform int u_passMode;
uniform int u_maskCount;
uniform ivec2 u_grid;
uniform int u_tile;
uniform int u_listBase;
uniform vec2 u_size;

const int DW = 1024;

vec4 md(int i) { return texelFetch(u_maskData, ivec2(i % DW, i / DW), 0); }

float comp4(vec4 t, int c) {
  if (c == 0) return t.x;
  if (c == 1) return t.y;
  if (c == 2) return t.z;
  return t.w;
}

float listIndex(int i) { return comp4(md(u_listBase + (i >> 2)), i & 3); }

float modeStart(int mode) { return (mode == 2 || mode == 3 || mode == 5) ? 1.0 : 0.0; }

float combineMode(int mode, float a, float m) {
  if (mode == 1) return a + m - a * m;
  if (mode == 2) return a * (1.0 - m);
  if (mode == 3) return a * m;
  if (mode == 4) return max(a, m);
  if (mode == 5) return min(a, m);
  if (mode == 6) return a + m - 2.0 * a * m;
  return a;
}

vec2 profileBlend(vec4 a, vec4 b, float x) {
  float xx = clamp(x, 0.0, 1.0);
  float sm = xx * xx * (3.0 - 2.0 * xx);
  float tension = clamp((a.w + b.w) * 0.5, 0.0, 1.0);
  float w = sm + (xx - sm) * tension;
  return vec2(a.y + (b.y - a.y) * w, a.z + (b.z - a.z) * w);
}

// Outer / inner variable-feather radius at arc length u (closed outline: wraps around).
vec2 profileAt(int base, int n, float len, float u) {
  if (n == 0) return vec2(0.0);
  vec4 first = md(base);
  if (n == 1) return first.yz;
  vec4 last = md(base + n - 1);
  if (u < first.x || u >= last.x) {
    float span = len - last.x + first.x;
    float x = u >= last.x ? u - last.x : u + len - last.x;
    return profileBlend(last, first, span > 1e-9 ? x / span : 0.0);
  }
  int i = 1;
  for (int k = 1; k < 4096; k++) {
    if (k >= n - 1) break;
    if (md(base + k).x > u) break;
    i = k + 1;
  }
  vec4 a = md(base + i - 1);
  vec4 b = md(base + i);
  float span = b.x - a.x;
  return profileBlend(a, b, span > 1e-9 ? (u - a.x) / span : 0.0);
}

float maskCoverage(vec2 p) {
  ivec2 tc = clamp(ivec2(floor(p / float(u_tile))), ivec2(0), u_grid - 1);
  int tile = tc.y * u_grid.x + tc.x;
  int row = int(floor(p.y)) - tc.y * u_tile;
  float acc = 0.0;
  for (int m = 0; m < 1024; m++) {
    if (m >= u_maskCount) break;
    vec4 i0 = md(m * 4);
    vec4 i1 = md(m * 4 + 1);
    vec4 i2 = md(m * 4 + 2);
    vec4 i3 = md(m * 4 + 3);
    int mode = int(i0.x + 0.5);
    if (m == 0) acc = modeStart(mode);
    int tb = int(i2.y + 0.5) + tile * (1 + u_tile / 4);
    vec4 th = md(tb);
    int off = int(th.x + 0.5);
    int cnt = int(th.y + 0.5);
    float wind = comp4(md(tb + 1 + (row >> 2)), row & 3);
    float band = i1.y;
    float d2 = band * band;
    float arc = 0.0;
    int edgeBase = int(i2.x + 0.5);
    for (int k = 0; k < 1048576; k++) {
      if (k >= cnt) break;
      int e = int(listIndex(off + k) + 0.5);
      vec4 ab = md(edgeBase + 2 * e);
      if ((ab.y <= p.y) != (ab.w <= p.y)) {
        float xc = ab.x + (p.y - ab.y) * (ab.z - ab.x) / (ab.w - ab.y);
        if (xc < p.x) wind += ab.w > ab.y ? 1.0 : -1.0;
      }
      vec2 d = ab.zw - ab.xy;
      vec2 q = p - ab.xy;
      float l2 = dot(d, d);
      float t = l2 > 0.0 ? clamp(dot(q, d) / l2, 0.0, 1.0) : 0.0;
      vec2 ev = q - d * t;
      float dd = dot(ev, ev);
      if (dd < d2) {
        d2 = dd;
        vec4 arcs = md(edgeBase + 2 * e + 1);
        arc = arcs.x + (arcs.y - arcs.x) * t;
      }
    }
    float dist = sqrt(d2);
    float sd = wind != 0.0 ? dist : -dist;
    float s = sd + i1.x;
    vec2 r = profileAt(int(i2.z + 0.5), int(i1.w + 0.5), i3.x, arc);
    float feather = i0.w;
    float lo = max(r.x + feather * 0.5, 0.5);
    float hi = max(r.y + feather * 0.5, 0.5);
    float u = clamp((s + lo) / (lo + hi), 0.0, 1.0);
    float c = u;
    if (i1.z < 0.5) {
      float k = clamp(lo + hi - 1.0, 0.0, 1.0);
      c = u + (u * u * (3.0 - 2.0 * u) - u) * k;
    }
    float v = i0.z * (i0.y > 0.5 ? 1.0 - c : c);
    acc = clamp(combineMode(mode, acc, v), 0.0, 1.0);
  }
  return acc;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 uv = p / u_size;
  float cov = u_maskCount > 0 ? maskCoverage(p) : 1.0;
  if (u_passMode == 2) {
    fragColor = vec4(cov);
    return;
  }
  vec4 src = texture(u_src, uv);
  if (u_passMode == 1) {
    vec4 o = texture(u_orig, uv);
    fragColor = o + (src - o) * cov;
    return;
  }
  fragColor = src * cov;
}
`;

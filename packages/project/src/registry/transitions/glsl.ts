// GLSL library of GPU transitions (authoring guide
// docs/wp-notes/fx-transition-framework.md §GLSL). Functions start with `tr_`, constants with `TR_`. Coordinates:
// `v_uv` 0..1 over the sequence frame ((0,0) = top-left); "px" = sequence pixels (y down), `tr_px()` = v_uv ·
// u_compSize. Every chunk is compiled by packages/compositions/test/transition-gl.test.ts in Chrome's WebGL2.
//   tr          (always included) tr_from, tr_to, tr_inFrame, tr_px, tr_uvOfPx, tr_aspect, tr_progress, tr_over,
//               tr_premul, tr_coverRadius, tr_halfDiagonal
//   tr/ease     tr_linearstep, tr_phase, tr_easeIn/Out/InOut (cubic), tr_easeInOutSine, tr_easeInOutExpo, tr_smoother
//   tr/wipe     tr_aaWidth, tr_edge, tr_wipeMix, tr_linearWipe, tr_circle, tr_irisRadius, tr_clockWipe, tr_boxDist
//   tr/blocks   tr_cell, tr_cellUv, tr_cellRandom, tr_stagger, tr_squareGrid
//   tr/3d       tr_card (perspective card / plane rotation: uv on the card + which face is seen)
// The fx library (`GLSL_HASH`, `GLSL_NOISE`, `GLSL_COLOR`, `GLSL_BLEND`, `GLSL_UV`, `GLSL_BLUR`…) works here too.
import { GLSL_HASH } from '../fx/glsl/hash.ts';
import type { GlslChunk } from '../fx/shader.ts';

/** Options of the standard "Anti-aliasing Quality" param, in `tr_aaWidth` index order. */
export const TR_AA_OPTIONS = ['off', 'low', 'medium', 'high'] as const;
export const TR_AA_LABELS = ['Off', 'Low', 'Medium', 'High'] as const;

/** Always included in a transition's passes (after the declarations of `u_from` / `u_to`). */
export const GLSL_TRANSITION: GlslChunk = {
	name: 'tr',
	source: /* glsl */ `
bool tr_inFrame(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }
// The sides at a frame position (uv over the sequence frame); transparent outside the frame.
vec4 tr_from(vec2 uv) { return tr_inFrame(uv) ? texture(u_from, uv) : vec4(0.0); }
vec4 tr_to(vec2 uv) { return tr_inFrame(uv) ? texture(u_to, uv) : vec4(0.0); }
vec2 tr_px() { return v_uv * u_compSize; }
vec2 tr_uvOfPx(vec2 px) { return px / u_compSize; }
float tr_aspect() { return u_compSize.x / max(u_compSize.y, 1.0); }
float tr_progress() { return clamp(u_progress, 0.0, 1.0); }
// Premultiplied "over".
vec4 tr_over(vec4 top, vec4 base) { return top + base * (1.0 - top.a); }
vec4 tr_premul(vec4 straight) { return vec4(straight.rgb * straight.a, straight.a); }
float tr_halfDiagonal() { return 0.5 * length(u_compSize); }
// Distance from px to the farthest frame corner: the radius a shape centred at px needs to cover the frame.
float tr_coverRadius(vec2 px) { return length(max(abs(px), abs(u_compSize - px))); }
`,
};

export const GLSL_TR_EASE: GlslChunk = {
	name: 'tr/ease',
	source: /* glsl */ `
float tr_linearstep(float a, float b, float x) { return clamp((x - a) / max(b - a, 1e-6), 0.0, 1.0); }
// Progress of the sub-interval [a, b] of the transition (two-phase transitions, dips, staggers).
float tr_phase(float p, float a, float b) { return tr_linearstep(a, b, p); }
float tr_easeIn(float t) { return t * t * t; }
float tr_easeOut(float t) { float u = 1.0 - t; return 1.0 - u * u * u; }
float tr_easeInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5; }
float tr_easeInOutSine(float t) { return 0.5 - 0.5 * cos(3.14159265358979 * clamp(t, 0.0, 1.0)); }
float tr_easeInOutExpo(float t) {
  if (t <= 0.0) return 0.0;
  if (t >= 1.0) return 1.0;
  return t < 0.5 ? pow(2.0, 20.0 * t - 10.0) * 0.5 : (2.0 - pow(2.0, -20.0 * t + 10.0)) * 0.5;
}
float tr_smoother(float t) { t = clamp(t, 0.0, 1.0); return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
`,
};

export const GLSL_TR_WIPE: GlslChunk = {
	name: 'tr/wipe',
	deps: [GLSL_TRANSITION],
	source: /* glsl */ `
// Edge width in px of the standard Anti-aliasing Quality param (TR_AA_OPTIONS index: off, low, medium, high).
float tr_aaWidth(int quality) { return quality <= 0 ? 0.0 : quality == 1 ? 1.0 : quality == 2 ? 2.0 : 3.0; }
// Coverage (0..1) of the B side at a signed distance d (px, d > 0 = B side) from an edge, feathered over soft px
// and at least aa px wide (anti-aliasing). soft = aa = 0: a hard edge.
float tr_edge(float d, float soft, float aa) {
  float w = max(soft, aa);
  return w <= 0.0 ? step(0.0, d) : smoothstep(-0.5 * w, 0.5 * w, d);
}
// A and B split by an edge (signed distance d in px, d > 0 = B side), with Premiere's border: a band of border px on
// the B side of the edge in borderColor (straight RGBA). All colours premultiplied in and out.
vec4 tr_wipeMix(vec4 a, vec4 b, float d, float soft, float aa, float border, vec4 borderColor) {
  float m = tr_edge(d, soft, aa);
  if (border <= 0.0) return mix(a, b, m);
  float mb = tr_edge(d - border, soft, aa);
  vec4 bc = vec4(borderColor.rgb * borderColor.a, borderColor.a);
  return mix(mix(a, bc, m), b, mb);
}
// Signed distance (px) behind a straight edge that travels along dir (unit vector) across the frame: at p = 0 the
// whole frame is A (d < 0), at p = 1 all B. margin (px; softness / 2 + border) lets the soft edge and the border
// leave the frame at both ends.
float tr_linearWipe(vec2 px, vec2 dir, float p, float margin) {
  float h = 0.5 * (abs(dir.x) * u_compSize.x + abs(dir.y) * u_compSize.y);
  float s = dot(px - 0.5 * u_compSize, dir);
  return mix(-h - margin, h + margin, p) - s;
}
// Signed distance (px) inside a circle of radius r around c (> 0 inside).
float tr_circle(vec2 px, vec2 c, float r) { return r - length(px - c); }
// Signed distance (px) inside an axis-aligned box of half size hs around c (> 0 inside).
float tr_boxDist(vec2 px, vec2 c, vec2 hs) { vec2 q = abs(px - c) - hs; return -(length(max(q, 0.0)) + min(max(q.x, q.y), 0.0)); }
// Radius of an iris opening around c at progress p: 0 at p = 0, the whole frame (+ margin px) at p = 1.
float tr_irisRadius(vec2 c, float p, float margin) { return p * (tr_coverRadius(c) + margin); }
// Signed distance (px, measured along the arc) of a clock wipe around c that starts at startDeg (0° = right,
// clockwise on screen) and has swept p · 360° (B inside the swept sector).
float tr_clockWipe(vec2 px, vec2 c, float p, float startDeg) {
  vec2 d = px - c;
  float a = mod(atan(d.y, d.x) - radians(startDeg), 6.28318530717959);
  return (p * 6.28318530717959 - a) * max(length(d), 1.0);
}
`,
};

export const GLSL_TR_BLOCKS: GlslChunk = {
	name: 'tr/blocks',
	deps: [GLSL_TRANSITION, GLSL_HASH],
	source: /* glsl */ `
// Cell of uv on a grid of grid.x × grid.y cells, and the position inside the cell (0..1).
ivec2 tr_cell(vec2 uv, vec2 grid) { return ivec2(floor(clamp(uv, vec2(0.0), vec2(0.99999)) * grid)); }
vec2 tr_cellUv(vec2 uv, vec2 grid) { return fract(clamp(uv, vec2(0.0), vec2(0.99999)) * grid); }
// Deterministic 0..1 random per cell (seeded integer hash: identical on every GPU and in software GL).
float tr_cellRandom(ivec2 cell, float seed) { return fx_hash2(cell, seed); }
// Staggered progress of one element that switches during a window of width (0..1] of the transition, starting at its
// offset t0 (0..1: the windows are spread over [0, 1 − width]).
float tr_stagger(float p, float t0, float width) {
  float w = clamp(width, 1e-3, 1.0);
  return clamp((p - t0 * (1.0 - w)) / w, 0.0, 1.0);
}
// A grid of roughly square cells with count columns.
vec2 tr_squareGrid(float count) { float c = max(1.0, floor(count)); return vec2(c, max(1.0, floor(c / tr_aspect() + 0.5))); }
`,
};

export const GLSL_TR_3D: GlslChunk = {
	name: 'tr/3d',
	deps: [GLSL_TRANSITION],
	source: /* glsl */ `
// The frame as a card (aspect × 1 frame heights) rotated by angle (radians) about its vertical (axis 0) or horizontal
// (axis 1) centre line, scaled by scale and seen in perspective by a camera dist frame heights away. Returns, for
// the screen position uv, the card position (xy, 0..1 inside the card; outside = the ray misses it) and z = +1 when
// the front face is seen, −1 the back (back-face xy is mirrored so a picture on the back reads correctly).
vec3 tr_card(vec2 uv, float angle, int axis, float dist, float scale) {
  float asp = tr_aspect();
  vec3 dir = vec3((uv - 0.5) * vec2(asp, 1.0), dist);
  vec3 cam = vec3(0.0, 0.0, -dist);
  float c = cos(angle), s = sin(angle);
  vec3 n = axis == 0 ? vec3(s, 0.0, c) : vec3(0.0, -s, c);
  float den = dot(n, dir);
  if (abs(den) < 1e-6) return vec3(-1.0, -1.0, 1.0);
  float t = -dot(n, cam) / den;
  if (t <= 0.0) return vec3(-1.0, -1.0, 1.0);
  vec3 p = cam + t * dir;
  // Back to the card's own axes (inverse rotation).
  vec2 q = axis == 0 ? vec2(c * p.x - s * p.z, p.y) : vec2(p.x, c * p.y + s * p.z);
  vec2 cuv = q / (vec2(asp, 1.0) * max(scale, 1e-4)) + 0.5;
  float face = den > 0.0 ? 1.0 : -1.0;
  if (face < 0.0) cuv = axis == 0 ? vec2(1.0 - cuv.x, cuv.y) : vec2(cuv.x, 1.0 - cuv.y);
  return vec3(cuv, face);
}
`,
};

/** Every transition chunk (the GL test compiles them all together). */
export const GLSL_TR_LIBRARY = [
	GLSL_TRANSITION,
	GLSL_TR_EASE,
	GLSL_TR_WIPE,
	GLSL_TR_BLOCKS,
	GLSL_TR_3D,
] as const;

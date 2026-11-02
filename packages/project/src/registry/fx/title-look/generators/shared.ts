// What the generators of spec 19 §7 share: seeded noise on integer hashes, the shape as they read it, stable anchors
// (TL-062) and the small TS helpers of their param lists. Every function is closed-form in time and seed: a generator
// keeps no state between frames (TL-061). Ported ideas and the changes made: licenses/ported/pachislop-generators.md.
import type { RGBA } from '../../../../schema/common.ts';
import { GLSL_HASH } from '../../glsl/hash.ts';
import type { GlslChunk } from '../../shader.ts';
import { type GeneratorStandIn, lp, type TitleParamSpec } from '../contract.ts';
import { GLSL_TL_SURFACE } from '../glsl.ts';

export const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A colour from `#rrggbb` (the signal, straight, alpha 1). */
export const hex = (s: string): RGBA => {
	const n = Number.parseInt(s.slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
};

/** A second pattern from the same seed. Named `variation`: `seed` is `u_seed`, which a look must not read (TL-035). */
export const variationParam = (): TitleParamSpec =>
	lp.number('variation', 'Variation', 0, { min: 0, max: 999, step: 1 });

/** Motion through a noise field: `speed` per second added to `evolution`, which also keyframes. */
export const evolutionParams = (speed: number): TitleParamSpec[] => [
	lp.number('speed', 'Speed', speed, { min: -20, max: 20, softMin: 0, softMax: 4, step: 0.01 }),
	lp.number('evolution', 'Evolution', 0, { min: -1000, max: 1000, softMin: 0, softMax: 10, step: 0.01 }),
];

/**
 * TL-062: where sites live. `layout`: the layer box, so a letter that moves disturbs only the sites around it and a
 * typewriter wakes sites where they stand. `bounds`: the alpha bounds, so a title that moves whole inside its box
 * carries its sites with it.
 */
export const anchorParam = (): TitleParamSpec =>
	lp.choice('anchor', 'Anchor', ['layout', 'bounds'], ['Layout', 'Alpha Bounds'], 'layout');

/** How a hold-frame generator moves (TL-061). */
export const boilParams = (fps: number): TitleParamSpec[] => [
	lp.number('boilRate', 'Boil Rate', fps, { min: 0.1, max: 60, softMax: 24, step: 0.1 }, { unit: 'Hz' }),
];

/** The fade every generator of a look has at the canvas edge: a padding is a hard end, a reach is not. */
export const GLSL_TLG_WINDOW: GlslChunk = {
	name: 'title-look/generator-window',
	source: /* glsl */ `
float tlg_window(vec2 px) {
  vec2 e = min(px, u_canvasSize - px);
  return smoothstep(0.0, max(tl_px(2.0), 2.0), min(e.x, e.y));
}
`,
};

/** Seeds, noise and light. Call `tlg_begin()` first in `main` or `tl_generate`. */
export const GLSL_TLG: GlslChunk = {
	name: 'title-look/generator',
	deps: [GLSL_HASH, GLSL_TL_SURFACE],
	source: /* glsl */ `
uint tlg_s = 0u;
void tlg_begin() { tlg_s = fx_hashSeed(fract(u_tlSeed + u_variation * 0.61803398875)); }
// 0..1 of a particle, drop or star i, channel k. Integer hashes: exact on every GPU.
float tlg_h(int i, int k) { return fx_hash2s(ivec2(i, k), tlg_s); }
float tlg_h3(int i, int j, int k) { return fx_hash3s(ivec3(i, j, k), tlg_s); }
// Value noise, 0..1.
float tlg_vnoise(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fx_hash2s(i, tlg_s), fx_hash2s(i + ivec2(1, 0), tlg_s), u.x),
             mix(fx_hash2s(i + ivec2(0, 1), tlg_s), fx_hash2s(i + ivec2(1, 1), tlg_s), u.x), u.y);
}
float tlg_fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * tlg_vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float tlg_ridge(vec2 p) { return 1.0 - abs(2.0 * tlg_vnoise(p) - 1.0); }
// Smooth 1D noise of x, 0..1, per channel k.
float tlg_noise1(float x, int k) {
  float i = floor(x);
  float f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  int n = int(i);
  return mix(tlg_h(n, k), tlg_h(n + 1, k), f);
}
// Light as premultiplied colour: alpha = the brightest channel, so it adds over black and reads on transparent.
vec4 tlg_light(vec3 c) {
  c = max(c, vec3(0.0));
  return vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
}
// A signal colour param (straight) as linear light.
vec3 tlg_rgb(vec4 c) { return tl_linear(c.rgb); }
vec3 tlg_ramp3(float t, vec3 a, vec3 b, vec3 c) {
  return t < 0.5 ? mix(a, b, clamp(t * 2.0, 0.0, 1.0)) : mix(b, c, clamp(t * 2.0 - 1.0, 0.0, 1.0));
}
`,
};

/**
 * "Upstream" distance, after Pachislop's energy/shared.ts: how far the source edge is looking back against the flow,
 * sideways distance weighted by `side`, so flames lick up the sides. The field is 1-Lipschitz, so the march steps by
 * what the distance leaves open: about a dozen reads where Pachislop's fixed 40 were spent mostly on nothing.
 */
export const GLSL_TLG_UPSTREAM: GlslChunk = {
	name: 'title-look/generator-upstream',
	source: /* glsl */ `
float tlg_upstream(vec2 px, vec2 dir, float len, float side) {
  float E = 1.0e9;
  float st = 0.0;
  for (int i = 0; i < 24; i++) {
    if (st > min(E, len)) break;
    float d = max(tlg_d((px - dir * st) / u_canvasSize), 0.0);
    E = min(E, d * side + st);
    st += max(d * 0.7, len / 24.0);
  }
  return E;
}
`,
};

/** The shape of a look layer: the shared field (TL-031). `tlg_field(px)`: (d, opacity, toEdge) at a canvas px. */
export const GLSL_TLG_LOOK_SHAPE: GlslChunk = {
	name: 'title-look/generator-shape',
	source: /* glsl */ `
float tlg_d(vec2 uv) { return texture(u_tlField, uv).x; }
// Where layout-anchored sites live: the layer box, which holds the title's layout whatever its letters do.
vec4 tlg_layout() { return vec4(u_box.xy, u_box.xy + u_box.zw); }
vec4 tlg_field(vec2 px) {
  ivec2 q = clamp(ivec2(floor(px)), ivec2(0), textureSize(u_tlField, 0) - 1);
  return texelFetch(u_tlField, q, 0);
}
`,
};

const STAND_IN: Record<GeneratorStandIn, string> = {
	// Nothing to read: every distance is large.
	none: /* glsl */ `
vec4 tlg_standIn(vec2 px) { return vec4(1.0e6, 0.0, 0.0, 0.0); }
vec4 tl_bounds() { return vec4(u_box.xy, u_box.xy + u_box.zw); }
`,
	// The bottom of the frame: fire and smoke rise from it.
	ground: /* glsl */ `
vec4 tlg_standIn(vec2 px) {
  float top = u_box.y + u_box.w * 0.92;
  float d = top - px.y;
  return vec4(d, 1.0, 0.0, d);
}
vec4 tl_bounds() { return vec4(u_box.x, u_box.y + u_box.w * 0.92, u_box.x + u_box.z, u_box.y + u_box.w); }
`,
	// A title-sized disc in the middle of the frame.
	disc: /* glsl */ `
vec4 tlg_standIn(vec2 px) {
  vec2 c = u_box.xy + u_box.zw * 0.5;
  float R = min(u_box.z, u_box.w) * 0.22;
  vec2 v = px - c;
  float l = length(v);
  float d = l - R;
  vec2 n = l > 1.0e-3 ? v / l : vec2(1.0, 0.0);
  return vec4(d, 1.0, -n * d);
}
vec4 tl_bounds() {
  vec2 c = u_box.xy + u_box.zw * 0.5;
  float R = min(u_box.z, u_box.w) * 0.22;
  return vec4(c - R, c + R);
}
`,
};

/** The surface of a standalone instance: the same API as `GLSL_TL_FIELD` on a virtual shape (TL-060). */
export function standInChunk(kind: GeneratorStandIn): GlslChunk {
	return {
		name: `title-look/stand-in-${kind}`,
		deps: [GLSL_TL_SURFACE],
		source: /* glsl */ `${STAND_IN[kind]}
vec4 tlg_field(vec2 px) { return tlg_standIn(px); }
float tlg_d(vec2 uv) { return tlg_standIn(uv * u_canvasSize).x; }
// A frame-sized box would leave most sites far from a title-sized stand-in.
vec4 tlg_layout() { return tl_bounds(); }
TlSurface tl_surfaceAt(vec2 uv) {
  vec4 f = tlg_standIn(uv * u_canvasSize);
  TlSurface s;
  s.uv = uv;
  s.px = uv * u_canvasSize;
  s.d = f.x;
  s.opacity = f.y;
  s.toEdge = f.zw;
  s.base = 0.0;
  s.alpha = clamp(0.5 - f.x, 0.0, 1.0);
  return s;
}
TlSurface tl_surface() { return tl_surfaceAt(v_uv); }
vec4 tl_sourceLinear(vec2 uv) {
  vec4 c = texture(u_source, uv);
  return c.a > 0.0 ? vec4(tl_linear(c.rgb / c.a), c.a) : vec4(0.0);
}
`,
	};
}

/**
 * Stable birth sites (TL-062). A site is a seeded point of the anchor box; what it emits from is the nearest part of the
 * shape, read from the field. No list of shape pixels is drawn from, so nothing re-rolls when pixels change: a moved
 * letter moves only the sites captured by it (the projection is continuous except across the medial axis between two
 * letters), and a site with nothing near it sleeps. Needs `u_anchor`.
 */
export const GLSL_TLG_SITES: GlslChunk = {
	name: 'title-look/generator-sites',
	source: /* glsl */ `
vec2 tlg_anchor(vec2 n) {
  vec4 b = u_anchor == 1 ? tl_bounds() : tlg_layout();
  return mix(b.xy, b.zw, n);
}
struct TlgSite {
  vec2 px;      // the emitting point, canvas px
  vec2 normal;  // out of the shape
  float gate;   // 0..1: asleep .. awake (smooth, so a site never pops)
};
// The site at q. edge: on the outline, or depth px inside it; else the fill, with q itself where q is inside.
TlgSite tlg_site(vec2 q, bool edge, float depth, float capture) {
  vec4 f = tlg_field(q);
  vec2 at = (floor(q) + 0.5);
  float d = f.x;
  float l = length(f.zw);
  TlgSite s;
  vec2 toward = l > 1.0e-3 ? f.zw / l : vec2(0.0);
  s.normal = d > 0.0 ? -toward : toward;
  if (l <= 1.0e-3) {
    vec2 r = q - (u_box.xy + u_box.zw * 0.5);
    float rl = length(r);
    s.normal = rl > 1.0e-3 ? r / rl : vec2(1.0, 0.0);
  }
  vec2 onEdge = at + f.zw;
  if (edge) s.px = onEdge - s.normal * depth;
  else s.px = d <= 0.0 ? at : onEdge;
  s.gate = (1.0 - smoothstep(capture * 0.6, capture, edge ? abs(d) : max(d, 0.0))) * f.y;
  return s;
}
`,
};

/** Distance helper of summaries. */
export const pct = (v: unknown): string => `${Math.round(num(v) * 10) / 10} %`;

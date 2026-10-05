// Family-private GLSL of `sapphire-textures-clouds` (names `stc_*`, chunk names `sapphire-textures-clouds/*`).
// Texture space ("screen" units): the layer box centred on (0,0), in units of the layer HEIGHT, y down — so a
// Frequency of 4 means about four noise features per frame height on any aspect ratio, and patterns keep their
// shape when the layer is resized. Vector params (Shift, speeds, directions) keep Sapphire's y-UP convention so
// the defaults move/light the way the originals do; point params (centres) are the editor's layer-normalised,
// y-down points with on-canvas handles. Built on the seeded noise of fx/noise (integer hashes: deterministic everywhere).
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import type { GlslChunk } from '../shader.ts';

/** Coordinates, continuous-octave fBm (2D, 3D), value mapping, cloud and perspective-plane helpers. */
export const STC_CORE: GlslChunk = {
	name: 'sapphire-textures-clouds/core',
	deps: [GLSL_NOISE, GLSL_UV, GLSL_COLOR],
	source: /* glsl */ `
// Octave step: ×2 with a rotation (hides the lattice of the base noise).
const mat2 STC_OCT = mat2(1.6, 1.2, -1.2, 1.6);
float stc_aspect() { return u_box.z / max(u_box.w, 1.0); }
// Texture space of the current pixel: layer centre = (0,0), 1 unit = layer height, y down.
vec2 stc_screen() { return (fx_layerNorm() - 0.5) * vec2(stc_aspect(), 1.0); }
// A point param (layer-normalised) in texture space, and back to canvas uv.
vec2 stc_screenOfNorm(vec2 n) { return (n - 0.5) * vec2(stc_aspect(), 1.0); }
vec2 stc_uvOfScreen(vec2 q) { return fx_uvOfLayerNorm(q / vec2(stc_aspect(), 1.0) + 0.5); }
// Sapphire X & Y vectors (Shift, Shift Speed, Morph, Light Dir, Add Grad…) are y-UP; texture space is y-down.
vec2 stc_yUp(vec2 v) { return vec2(v.x, -v.y); }
// Layer height in canvas pixels (glow and sharpen widths are relative to it).
float stc_heightPx() { return u_box.w; }
float stc_octSeed(float seed, int k) { return fract(seed + float(k) * 0.1031); }
float stc_seed(float seed, float k) { return fract(seed + k * 0.618034); }

// Fractional Brownian motion with a CONTINUOUS octave count (the last octave fades in, so keyframed octaves never
// pop) and constant variance (normalised by the RMS of the amplitudes): ≈ −1..1, standard deviation ≈ 0.3.
float stc_fbm(vec2 p, float octaves, float gain, float seed) {
  float n = clamp(octaves, 1.0, 12.0);
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int k = 0; k < 12; k++) {
    float w = clamp(n - float(k), 0.0, 1.0);
    if (w <= 0.0) break;
    sum += w * amp * fx_simplex(p, stc_octSeed(seed, k));
    norm += w * amp * amp;
    p = STC_OCT * p;
    amp *= gain;
  }
  return sum / sqrt(max(norm, 1.0e-6));
}
// Same in 3D (z = time for "boiling" textures; every octave boils at its own rate).
float stc_fbm3(vec3 p, float octaves, float gain, float seed) {
  float n = clamp(octaves, 1.0, 12.0);
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int k = 0; k < 12; k++) {
    float w = clamp(n - float(k), 0.0, 1.0);
    if (w <= 0.0) break;
    sum += w * amp * fx_simplex3(p, stc_octSeed(seed, k));
    norm += w * amp * amp;
    p = vec3(STC_OCT * p.xy, p.z * 2.0);
    amp *= gain;
  }
  return sum / sqrt(max(norm, 1.0e-6));
}
// Noise (≈ −1..1) → texture value 0..1 with Sapphire-like contrast (not clamped: Offset/Brightness act first).
float stc_unit(float n) { return 0.5 + 0.65 * n; }

// Sapphire clouds: plain fBm translated by Shift, or (Boiling Mode) 3D fBm evolving at Boil Speed with the
// gain Boil Details. \`t\` is the boil time (seconds × speed).
float stc_clouds(vec2 p, float octaves, bool boil, float details, float t, float seed) {
  if (boil) return stc_fbm3(vec3(p, t * 0.35), octaves, clamp(details, 0.0, 1.0), seed);
  return stc_fbm(p, octaves, 0.5, seed);
}

// A textured plane seen in perspective (CloudsPerspective, CloudsVortex). q = texture-space position relative to
// the centre; returns plane coordinates (= q · zDist when latitude is 0). Positive latitude tilts the plane down
// (horizon below the frame centre), negative up. \`facing\` > 0 where the ray hits the plane (else: past the horizon).
vec2 stc_plane(vec2 q, float zDist, float latitudeDeg, float lens, out float facing) {
  float f = max(lens, 0.05) * 0.6;
  float a = fx_deg(clamp(latitudeDeg, -89.0, 89.0));
  vec3 d = vec3(q, f);
  vec3 e2 = vec3(0.0, cos(a), sin(a));
  vec3 nrm = vec3(0.0, -sin(a), cos(a));
  vec3 p0 = vec3(0.0, 0.0, max(zDist, 1.0e-3) * f);
  float den = dot(d, nrm);
  facing = den;
  float t = dot(p0, nrm) / (abs(den) < 1.0e-5 ? 1.0e-5 : den);
  vec3 h = t * d - p0;
  return vec2(h.x, dot(h, e2));
}
// Hue spectrum 0..1 (red → violet), unit sum over a full sweep (ChromaSpiral's colour steps).
vec3 stc_spectrum(float s) {
  return clamp(abs(fract(s * 0.85 + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
`,
};

/** The Color0 → Color1 ramp (needs the `rampParams` uniforms). */
export const STC_RAMP: GlslChunk = {
	name: 'sapphire-textures-clouds/ramp',
	deps: [STC_CORE],
	source: /* glsl */ `
vec3 stc_ramp(vec3 v) { return mix(u_color0.rgb + u_offset0, u_color1.rgb * u_brightness1, v); }
vec3 stc_ramp1(float v) { return stc_ramp(vec3(v)); }
`,
};

/**
 * Combine with the Background + Output Opacity + Show/Mix with Orig (needs the `finishParams` uniforms). Writes the
 * texture over the layer box; pixels outside it (padding of other effects) keep the input.
 */
export const STC_FINISH: GlslChunk = {
	name: 'sapphire-textures-clouds/finish',
	deps: [STC_CORE, GLSL_BLEND, GLSL_COMPOSITE],
	source: /* glsl */ `
vec3 stc_combine(int mode, vec3 tex, vec3 bg) {
  if (mode == 1) return tex * bg;
  if (mode == 2) return tex + bg;
  if (mode == 3) { vec3 t = clamp(tex, 0.0, 1.0), b = clamp(bg, 0.0, 1.0); return t + b - t * b; }
  if (mode == 4) return abs(tex - bg);
  if (mode == 5) return fx_overlayRgb(clamp(bg, 0.0, 1.0), clamp(tex, 0.0, 1.0));
  return tex;
}
vec4 stc_finish(vec3 tex) {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) return src;
  vec4 s = fx_unpremultiply(src);
  vec3 rgb = clamp(stc_combine(u_combine, tex, s.rgb * u_bgBrightness), 0.0, 1.0);
  float a = u_outputOpacity == 0 ? 1.0 : src.a;
  return fx_finish(vec4(rgb * a, a), src, fx_luma(clamp(tex, 0.0, 1.0)), u_mixWithOriginal, u_show);
}
`,
};

/**
 * Chromatic glow from a bloom pyramid (`glowPasses`: outputs u_glow0…u_glow5 of a mono source in .r): each
 * channel weights the pyramid levels around its own radius (Glow Width × Glow Width Red/Grn/Blue), so the three
 * channels spread differently — Sapphire's coloured glow fringes. Returns the glow light (unscaled).
 */
export const STC_GLOW: GlslChunk = {
	name: 'sapphire-textures-clouds/glow',
	deps: [STC_CORE],
	source: /* glsl */ `
float stc_up(sampler2D t, vec2 uv) {
  vec2 tx = 1.0 / vec2(textureSize(t, 0));
  return 0.25 * (texture(t, uv + tx * vec2(-0.5, -0.5)).r + texture(t, uv + tx * vec2(0.5, -0.5)).r +
                 texture(t, uv + tx * vec2(-0.5, 0.5)).r + texture(t, uv + tx * vec2(0.5, 0.5)).r);
}
void stc_level(float v, float k, vec3 l, inout vec3 acc, inout vec3 ws) {
  vec3 d = l - (k + 1.0);
  vec3 w = exp(-0.8 * d * d);
  // Light spreads: wider levels keep more energy so a wide glow stays visible.
  acc += w * v * exp2(0.6 * k);
  ws += w;
}
vec3 stc_glow(vec2 uv, vec3 radiusPx) {
  vec3 l = log2(max(radiusPx, vec3(1.0)));
  vec3 acc = vec3(0.0), ws = vec3(0.0);
  stc_level(stc_up(u_glow0, uv), 0.0, l, acc, ws);
  stc_level(stc_up(u_glow1, uv), 1.0, l, acc, ws);
  stc_level(stc_up(u_glow2, uv), 2.0, l, acc, ws);
  stc_level(stc_up(u_glow3, uv), 3.0, l, acc, ws);
  stc_level(stc_up(u_glow4, uv), 4.0, l, acc, ws);
  stc_level(stc_up(u_glow5, uv), 5.0, l, acc, ws);
  return acc / max(ws, vec3(1.0e-4));
}
`,
};

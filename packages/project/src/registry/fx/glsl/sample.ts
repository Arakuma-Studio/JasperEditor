// Shared GLSL: sampling with edge modes and UV helpers. Textures are clamp-to-edge with linear
// filtering; these helpers implement the other edge behaviours in the shader (After Effects / Sapphire "Edge Mode":
// transparent, repeat, mirror, clamp/extend). Mode numbers = indexes of FX_EDGE_MODES (`edgeModeParam`).
import type { GlslChunk } from '../shader.ts';

/** Edge mode option values in GLSL index order. */
export const FX_EDGE_MODES = ['transparent', 'clamp', 'repeat', 'mirror'] as const;
export const FX_EDGE_MODE_LABELS = [
	'Transparent',
	'Clamp (Extend Edges)',
	'Repeat (Tile)',
	'Mirror',
] as const;

export const GLSL_SAMPLE: GlslChunk = {
	name: 'fx/sample',
	source: /* glsl */ `
const int FX_EDGE_TRANSPARENT = 0;
const int FX_EDGE_CLAMP = 1;
const int FX_EDGE_REPEAT = 2;
const int FX_EDGE_MIRROR = 3;
vec2 fx_mirrorUv(vec2 uv) { vec2 m = mod(uv, 2.0); return mix(m, 2.0 - m, step(1.0, m)); }
vec4 fx_sampleEdge(sampler2D t, vec2 uv, int mode) {
  if (mode == FX_EDGE_REPEAT) return texture(t, fract(uv));
  if (mode == FX_EDGE_MIRROR) return texture(t, fx_mirrorUv(uv));
  if (mode == FX_EDGE_CLAMP) return texture(t, clamp(uv, vec2(0.0), vec2(1.0)));
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return texture(t, uv);
}
vec4 fx_sampleTransparent(sampler2D t, vec2 uv) { return fx_sampleEdge(t, uv, FX_EDGE_TRANSPARENT); }
// Samples the layer picture with layer-box-relative coordinates (0..1 = the box; outside = edge mode), so warps that
// address the layer (not the padded canvas) wrap/extend at the layer edges.
vec4 fx_sampleLayer(sampler2D t, vec2 layerNorm, int mode) {
  vec2 n = layerNorm;
  if (mode == FX_EDGE_REPEAT) n = fract(n);
  else if (mode == FX_EDGE_MIRROR) n = fx_mirrorUv(n);
  else if (mode == FX_EDGE_CLAMP) n = clamp(n, vec2(0.5) / u_box.zw, vec2(1.0) - vec2(0.5) / u_box.zw);
  else if (any(lessThan(n, vec2(0.0))) || any(greaterThan(n, vec2(1.0)))) return vec4(0.0);
  return texture(t, fx_uvOfLayerNorm(n));
}
`,
};

export const GLSL_UV: GlslChunk = {
	name: 'fx/uv',
	source: /* glsl */ `
const float FX_PI = 3.14159265358979;
const float FX_TAU = 6.28318530717959;
mat2 fx_rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// Rotation in pixel space (y down: positive angles turn clockwise on screen, like Premiere's rotation).
vec2 fx_rotateAround(vec2 p, vec2 center, float radians) { return center + fx_rot(radians) * (p - center); }
vec2 fx_scaleAround(vec2 p, vec2 center, vec2 scale) { return center + (p - center) / scale; }
// Polar coordinates around a centre: x = radius, y = angle in radians (−π..π).
vec2 fx_toPolar(vec2 p, vec2 center) { vec2 d = p - center; return vec2(length(d), atan(d.y, d.x)); }
vec2 fx_fromPolar(vec2 rp, vec2 center) { return center + rp.x * vec2(cos(rp.y), sin(rp.y)); }
float fx_deg(float degrees) { return degrees * (FX_PI / 180.0); }
// Direction of an angle in degrees (0° = right, 90° = down, Premiere/AE "Direction" params).
vec2 fx_dir(float degrees) { float a = fx_deg(degrees); return vec2(cos(a), sin(a)); }
`,
};

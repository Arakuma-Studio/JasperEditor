// sim-warp: data textures (`{texels}` uniforms, `uniform highp sampler2D u_x`): RGBA32F records written by TS hooks
// (particles, mesh vertices, displacement grids), FX_DATA_ROW (1024) texels per row. Usable in vertex and fragment
// shaders (draw passes read their instance records with `fx_texel(u_x, gl_InstanceID * stride + k)`).
import type { GlslChunk } from '../shader.ts';

export const GLSL_DATA: GlslChunk = {
	name: 'fx/data',
	source: /* glsl */ `
vec4 fx_texel(highp sampler2D t, int i) { return texelFetch(t, ivec2(i & 1023, i >> 10), 0); }
// Bilinear read of a grid stored row-major (w × h texels) at grid coordinates g (clamped to the grid).
vec4 fx_texelGrid(highp sampler2D t, int w, int h, vec2 g) {
  vec2 c = clamp(g, vec2(0.0), vec2(float(w - 1), float(h - 1)));
  ivec2 i0 = ivec2(floor(c));
  ivec2 i1 = min(i0 + 1, ivec2(w - 1, h - 1));
  vec2 f = c - vec2(i0);
  vec4 a = fx_texel(t, i0.y * w + i0.x);
  vec4 b = fx_texel(t, i0.y * w + i1.x);
  vec4 d = fx_texel(t, i1.y * w + i0.x);
  vec4 e = fx_texel(t, i1.y * w + i1.x);
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}
`,
};

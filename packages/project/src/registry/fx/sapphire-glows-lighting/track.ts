// Family-private bright-spot tracker of the Sapphire Glows + Lighting family (S_LensFlareAutoTrack): finds the
// brightest blob of the current frame on the GPU, deterministically and without state between frames (S11 §2):
//   tA (1/8 canvas): the mean luminance of each 8×8 block (blob-size aware: a lamp beats a thin bright text stroke),
//                    weighted by the search region; stored with the block centre (uv);
//   tB (1/64), tC (smallest): max-reductions (the brightest child wins; ties → the first in scan order);
//   tD (same size as tC): every texel holds the global winner, refined to the luminance-weighted centroid of the
//                    source around it (sub-block accuracy), and its strength 0..1.
// The flare pass reads `texture(u_tD, vec2(0.5))` = (x uv, y uv, strength, 1). rgba16f keeps positions to ~1/2000
// of the canvas (rgba8 fallback: the refinement still lands on the blob).
import type { ShaderPass } from '../shader.ts';
import { GLSL_SGL_CORE } from './glow.ts';
import { GLSL_COLOR } from '../glsl/color.ts';

/** Max-reduction of a (strength, x, y) texture: each output texel keeps its brightest input texel. */
const reduceFrag = (input: string) => /* glsl */ `
void main() {
  ivec2 si = textureSize(u_${input}, 0);
  ivec2 so = ivec2(u_resolution);
  ivec2 o = ivec2(v_uv * u_resolution);
  ivec2 a = o * si / so;
  ivec2 b = max(a + 1, (o + 1) * si / so);
  vec4 best = vec4(-1.0, 0.5, 0.5, 1.0);
  for (int y = 0; y < 16; y++) {
    if (a.y + y >= b.y) break;
    for (int x = 0; x < 16; x++) {
      if (a.x + x >= b.x) break;
      vec4 t = texelFetch(u_${input}, min(a + ivec2(x, y), si - 1), 0);
      if (t.r > best.r) best = t;
    }
  }
  fragColor = best;
}`;

/**
 * The tracker passes. `weight` = GLSL expression of a float 0..1 per canvas uv `p` limiting the search (e.g. a
 * region); `threshold` = GLSL expression of the luminance a spot must exceed (0..1).
 */
export function trackPasses(weight: string, threshold: string): ShaderPass[] {
	return [
		{
			output: 'tA',
			scale: 1 / 8,
			format: 'rgba16f',
			filter: 'nearest',
			include: [GLSL_SGL_CORE, GLSL_COLOR],
			frag: /* glsl */ `
void main() {
  vec4 s = sgl_boxRead(u_source, v_uv, 8.0);
  vec2 p = v_uv;
  float l = fx_luma(s.rgb) * (${weight});
  fragColor = vec4(l, v_uv, 1.0);
}`,
		},
		{ output: 'tB', scale: 1 / 64, format: 'rgba16f', filter: 'nearest', frag: reduceFrag('tA') },
		{ output: 'tC', scale: 1 / 1000, format: 'rgba16f', filter: 'nearest', frag: reduceFrag('tB') },
		{
			output: 'tD',
			scale: 1 / 1000,
			format: 'rgba16f',
			filter: 'nearest',
			include: [GLSL_COLOR],
			frag: /* glsl */ `
void main() {
  ivec2 si = textureSize(u_tC, 0);
  vec4 best = vec4(-1.0, 0.5, 0.5, 1.0);
  for (int y = 0; y < 16; y++) {
    if (y >= si.y) break;
    for (int x = 0; x < 16; x++) {
      if (x >= si.x) break;
      vec4 t = texelFetch(u_tC, ivec2(x, y), 0);
      if (t.r > best.r) best = t;
    }
  }
  // Refine: luminance^4-weighted centroid of the source in a 3×3-block window around the winner.
  vec2 cell = 8.0 / u_canvasSize;
  vec3 acc = vec3(0.0);
  for (int y = -6; y <= 6; y++)
    for (int x = -6; x <= 6; x++) {
      vec2 q = best.gb + vec2(float(x), float(y)) * cell * 0.25;
      vec2 p = q;
      float l = fx_luma(texture(u_source, q).rgb) * (${weight});
      float w = l * l * l * l;
      acc += vec3(q * w, w);
    }
  vec2 pos = acc.z > 1.0e-6 ? acc.xy / acc.z : best.gb;
  float thr = clamp(${threshold}, 0.0, 0.999);
  float strength = clamp((best.r - thr) / (1.0 - thr), 0.0, 1.0);
  fragColor = vec4(pos, strength, 1.0);
}`,
		},
	];
}

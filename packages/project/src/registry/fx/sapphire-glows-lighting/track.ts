// Family-private bright-spot tracker of the Sapphire Glows + Lighting family (S_LensFlareAutoTrack): finds the
// brightest blobs of the current frame on the GPU, deterministically and with no state between frames (S11 §2):
//   tA (1/8 canvas): the mean luminance around each 8×8 block (widened by Blur For Auto: a lamp beats a thin bright
//                    text stroke), inside the layer box; positions are the block centres (canvas uv);
//   per hotspot k (Max Hotspots, ≤ 3):
//     tBk (1/64), tCk (smallest grid): max-reductions — the brightest child wins (ties: the first in scan order),
//                    blocks within EXCLUDE of an earlier hotspot are skipped;
//     tDk (smallest grid): every texel holds the winner, refined to the luminance⁴-weighted centroid of the source
//                    around it (sub-block accuracy), and its strength vs Hotspot Threshold.
// A flare pass reads `texelFetch(u_tDk, ivec2(0), 0)` = (x uv, y uv, strength, 1). rgba16f keeps positions to
// ~1/2000 of the canvas (the rgba8 fallback is coarser; the refinement still lands on the blob).
import { GLSL_COLOR } from '../glsl/color.ts';
import type { ShaderPass } from '../shader.ts';
import { GLSL_SGL_CORE } from './glow.ts';

/** Exclusion radius around earlier hotspots, in layer widths. */
const EXCLUDE = 0.12;

const excludeGlsl = (k: number) =>
	Array.from(
		{ length: k },
		(_, j) => /* glsl */ `
  {
    vec4 h = texelFetch(u_tD${j}, ivec2(0), 0);
    if (length((t.gb - h.xy) * u_canvasSize) < ${EXCLUDE.toFixed(3)} * u_box.z) t.r = -1.0;
  }`,
	).join('');

/** Max-reduction of a (strength, x, y) texture, skipping blocks near hotspots 0…k−1. */
const reduceFrag = (input: string, k: number) => /* glsl */ `
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
      vec4 t = texelFetch(u_${input}, min(a + ivec2(x, y), si - 1), 0);${excludeGlsl(k)}
      if (t.r > best.r) best = t;
    }
  }
  fragColor = best;
}`;

/**
 * The tracker passes for `hotspots` (1…3) spots. Uniforms read: `u_trackBlur` (canvas px, Blur For Auto) and
 * `u_hotspotThreshold` (0..1).
 */
export function trackPasses(hotspots: number): ShaderPass[] {
	const n = Math.max(1, Math.min(3, Math.round(hotspots)));
	const passes: ShaderPass[] = [
		{
			output: 'tA',
			scale: 1 / 8,
			format: 'rgba16f',
			filter: 'nearest',
			include: [GLSL_SGL_CORE, GLSL_COLOR],
			frag: /* glsl */ `
void main() {
  vec2 o = max(u_trackBlur, 4.0) / 1.5 / u_canvasSize;
  float l = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 q = v_uv + vec2(float(x), float(y)) * o;
      float w = (x == 0 && y == 0) ? 4.0 : 0.625;
      l += (fx_inBox(q) ? fx_luma(sgl_boxRead(u_source, q, 8.0).rgb) : 0.0) * w;
    }
  fragColor = vec4(fx_inBox(v_uv) ? l / 9.0 : -1.0, v_uv, 1.0);
}`,
		},
	];
	for (let k = 0; k < n; k++) {
		passes.push(
			{ output: `tB${k}`, scale: 1 / 64, format: 'rgba16f', filter: 'nearest', frag: reduceFrag('tA', k) },
			{
				output: `tC${k}`,
				scale: 1 / 1000,
				format: 'rgba16f',
				filter: 'nearest',
				frag: reduceFrag(`tB${k}`, k),
			},
			{
				output: `tD${k}`,
				scale: 1 / 1000,
				format: 'rgba16f',
				filter: 'nearest',
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  ivec2 si = textureSize(u_tC${k}, 0);
  vec4 best = vec4(-1.0, 0.5, 0.5, 1.0);
  for (int y = 0; y < 16; y++) {
    if (y >= si.y) break;
    for (int x = 0; x < 16; x++) {
      if (x >= si.x) break;
      vec4 t = texelFetch(u_tC${k}, ivec2(x, y), 0);
      if (t.r > best.r) best = t;
    }
  }
  // Refine: luminance⁴-weighted centroid of the source in a ±12 px window around the winner.
  vec2 cell = 2.0 / u_canvasSize;
  vec3 acc = vec3(0.0);
  for (int y = -6; y <= 6; y++)
    for (int x = -6; x <= 6; x++) {
      vec2 q = best.gb + vec2(float(x), float(y)) * cell;
      float l = fx_inBox(q) ? fx_luma(texture(u_source, q).rgb) : 0.0;
      float w = l * l * l * l;
      acc += vec3(q * w, w);
    }
  vec2 pos = acc.z > 1.0e-6 ? acc.xy / acc.z : best.gb;
  float thr = clamp(u_hotspotThreshold, 0.0, 0.999);
  float strength = clamp((best.r - thr) / (1.0 - thr) * 2.0, 0.0, 1.0);
  fragColor = vec4(pos, strength, 1.0);
}`,
			},
		);
	}
	return passes;
}

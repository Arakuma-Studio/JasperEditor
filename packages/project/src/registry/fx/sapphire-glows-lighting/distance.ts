// Family-private distance field of the Sapphire Glows + Lighting family: S_GlowDist, S_GlowRainbow, S_GlowRings and
// S_GlowAura glow by DISTANCE from the edge of the above-threshold areas (thin lines glow as far and as brightly as
// big shapes), which a blur cannot give. A jump-flood (JFA) pass chain finds, for every texel of a downscaled grid,
// the nearest seed texel (an above-threshold one): an init pass, then ⌈log2(reach)⌉ passes with halving steps. The
// final pass reads the nearest seed (nearest filtering; the 2×2 grid neighbours are checked too, smoothing the
// quantisation) and measures the exact distance in canvas px. Seeds are stored as canvas uv in rgba16f.
import type { GlslChunk, ShaderPass } from '../shader.ts';
import { clamp, GLSL_SGL_CORE } from './glow.ts';

const pow2ceil = (x: number) => 2 ** Math.ceil(Math.log2(Math.max(1, x)));

/**
 * The JFA passes: `seedExpr` = GLSL float expression (0..1, ≥ 0.5 = seed) over `vec4 s` = the box-filtered input
 * at the texel (premultiplied). `reachPx` = the farthest distance (canvas px) the effect needs. Outputs `jf0…`;
 * returns the name of the last one and the grid downscale.
 */
export function jfaPasses(
	seedExpr: string,
	reachPx: number,
	include: readonly GlslChunk[] = [],
): { passes: ShaderPass[]; field: string; down: number } {
	// Grid: at most ~128 texels of reach (7 flood passes), 1…8 canvas px per texel.
	const down = clamp(pow2ceil(reachPx / 128), 1, 8);
	const reach = Math.max(1, reachPx / down);
	const steps: number[] = [];
	for (let s = pow2ceil(reach) / 2; s >= 1; s /= 2) steps.push(s);
	if (steps.length === 0) steps.push(1);
	const passes: ShaderPass[] = [
		{
			output: 'jf0',
			scale: 1 / down,
			format: 'rgba16f',
			filter: 'nearest',
			include: [GLSL_SGL_CORE, ...include],
			uniforms: { u_jd: down },
			frag: /* glsl */ `
void main() {
  vec4 s = sgl_boxRead(u_source, v_uv, u_jd);
  float seed = ${seedExpr};
  fragColor = seed >= 0.5 ? vec4(v_uv, 1.0, 1.0) : vec4(0.0);
}`,
		},
	];
	steps.slice(0, 10).forEach((step, i) => {
		const input = `jf${i}`;
		passes.push({
			output: `jf${i + 1}`,
			scale: 1 / down,
			format: 'rgba16f',
			filter: 'nearest',
			uniforms: { u_jstep: step },
			frag: /* glsl */ `
void main() {
  vec2 tx = 1.0 / vec2(textureSize(u_${input}, 0));
  vec2 asp = u_canvasSize;
  vec4 best = vec4(0.0);
  float bd = 1.0e20;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec4 t = texture(u_${input}, v_uv + vec2(float(x), float(y)) * u_jstep * tx);
      if (t.z < 0.5) continue;
      vec2 d = (t.xy - v_uv) * asp;
      float dd = dot(d, d);
      if (dd < bd) { bd = dd; best = t; }
    }
  fragColor = best;
}`,
		});
	});
	return { passes, field: `jf${Math.min(steps.length, 10)}`, down };
}

/**
 * `vec3 sgl_nearestSeed(sampler2D field, vec2 uv)` → (seed uv, found 0/1): the nearest seed among the grid texel of
 * uv and its neighbours, exact distance measured at full resolution.
 */
export const GLSL_SGL_DISTANCE: GlslChunk = {
	name: 'sgl/distance',
	source: /* glsl */ `
vec3 sgl_nearestSeed(sampler2D field, vec2 uv) {
  vec2 tx = 1.0 / vec2(textureSize(field, 0));
  vec3 best = vec3(0.0);
  float bd = 1.0e20;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec4 t = texture(field, uv + vec2(float(x), float(y)) * tx);
      if (t.z < 0.5) continue;
      vec2 d = (t.xy - uv) * u_canvasSize;
      float dd = dot(d, d);
      if (dd < bd) { bd = dd; best = vec3(t.xy, 1.0); }
    }
  return best;
}
`,
};

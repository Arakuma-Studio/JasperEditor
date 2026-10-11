// GPU painter's order for the simulation-warp family: pieces (cards, shards, polygons) and balls
// whose depth depends on pictures only the GPU has (gradient maps, the layer's own colours) are drawn far to near by
// sorting their depth keys on the GPU — a bitonic sorting network over an rgba32f texture of (key, id) pairs, one
// ping-pong pass per network stage (`update` passes of one output, one program). The draw pass then reads the id of
// its instance from the sorted texture (`sw_sortedId(gl_InstanceID)`), so instance order = far to near.
import type { GlslChunk, ShaderPass } from '../shader.ts';

/** Largest number of items the GPU sort orders (1024 × 1024). */
export const SORT_MAX = 1 << 20;

/** Size of the sort texture for `count` items: a power of two ≥ count, as width × height (width ≤ 1024). */
export function sortSize(count: number): { n: number; width: number; height: number } {
	const c = Math.max(1, Math.min(SORT_MAX, Math.floor(count)));
	let n = 1;
	while (n < c) n *= 2;
	const width = Math.min(n, 1024);
	return { n, width, height: n / width };
}

/** GLSL of a draw pass that reads the sorted order (`u_order`). */
export const GLSL_SORTED: GlslChunk = {
	name: 'sim/sorted',
	source: /* glsl */ `
// The id of the j-th item in ascending key order (keys of the sort pass; ties by id).
int sw_sortedId(int j) {
  int w = textureSize(u_order, 0).x;
  return int(texelFetch(u_order, ivec2(j % w, j / w), 0).y + 0.5);
}
`,
};

/**
 * Passes that sort `count` items by the key the author's GLSL computes: `keyGlsl` defines
 * `float sw_sortKey(int id)` (smaller = drawn first: return −depth for far-to-near). Output `order` (rgba32f,
 * (key, id) per texel, ascending). `include` = GLSL the key function needs.
 */
export function gpuSortPasses(opts: {
	count: number;
	keyGlsl: string;
	include?: ShaderPass['include'];
	uniforms?: ShaderPass['uniforms'];
}): ShaderPass[] {
	const { n, width, height } = sortSize(opts.count);
	const size = { width, height };
	const passes: ShaderPass[] = [
		{
			output: 'order',
			format: 'rgba32f',
			filter: 'nearest',
			size,
			include: opts.include,
			uniforms: { ...(opts.uniforms ?? {}), u_sortCount: { int: Math.min(opts.count, n) } },
			frag: /* glsl */ `${opts.keyGlsl}
void main() {
  ivec2 c = ivec2(v_uv * u_resolution);
  int id = c.y * int(u_resolution.x) + c.x;
  float k = id < u_sortCount ? sw_sortKey(id) : 3.0e38;
  if (!(k <= 3.0e38)) k = 3.0e38;
  fragColor = vec4(k, float(id), 0.0, 1.0);
}`,
		},
	];
	for (let k = 2; k <= n; k *= 2)
		for (let j = k / 2; j >= 1; j /= 2)
			passes.push({
				output: 'order',
				update: true,
				format: 'rgba32f',
				filter: 'nearest',
				size,
				uniforms: { u_sk: { int: k }, u_sj: { int: j } },
				frag: /* glsl */ `
void main() {
  ivec2 c = ivec2(v_uv * u_resolution);
  int w = int(u_resolution.x);
  int i = c.y * w + c.x;
  int p = i ^ u_sj;
  vec4 a = texelFetch(u_order, c, 0);
  vec4 b = texelFetch(u_order, ivec2(p % w, p / w), 0);
  bool up = (i & u_sk) == 0;
  bool aFirst = a.x < b.x || (a.x == b.x && a.y < b.y);
  bool keepFirst = (i < p) == up;
  fragColor = keepFirst == aFirst ? a : b;
}`,
			});
	return passes;
}

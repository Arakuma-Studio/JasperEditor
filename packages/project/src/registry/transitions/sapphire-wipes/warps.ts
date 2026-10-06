// Sapphire band wipes: S_WipeBubble, S_WipeDiffuse, S_WipePixelate, S_WipePointalize. A transition band of Edge
// Width (a fraction of the frame along Angle) travels across the frame; inside it the pixels are warped (bubble),
// scattered (diffuse) or switched block by block / brush stroke by brush stroke in a semi-random order. These have
// no border controls in Sapphire.
import type { GlslChunk } from '../../fx/shader.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { GLSL_SAMPLE } from '../../fx/glsl/sample.ts';
import { fxParam } from '../../fx/params.ts';
import { GLSL_SW_CORE, sapphireWipe, swParam } from './common.ts';

/** The travelling band: 0 = still A, 1 = already B, at a frame position. */
const GLSL_SW_BAND: GlslChunk = {
	name: 'sapphire-wipes/band',
	deps: [GLSL_SW_CORE, GLSL_SAMPLE],
	source: /* glsl */ `
// Position (0..1) inside the band of width ew (frame fractions) travelling along deg: 0 ahead of it (A), 1 behind (B).
float sw_band(vec2 px, float deg, float ew) {
  float w = max(ew, 1e-3);
  return clamp((tr_progress() * (1.0 + w) - sw_gradPos(px, deg)) / w, 0.0, 1.0);
}
// A side sampled with Sapphire's Wrap (0 No, 1 Tile, 2 Reflect).
vec4 sw_wrapFrom(vec2 uv, int wrap) { return fx_sampleEdge(u_from, uv, wrap == 0 ? FX_EDGE_TRANSPARENT : wrap == 1 ? FX_EDGE_REPEAT : FX_EDGE_MIRROR); }
vec4 sw_wrapTo(vec2 uv, int wrap) { return fx_sampleEdge(u_to, uv, wrap == 0 ? FX_EDGE_TRANSPARENT : wrap == 1 ? FX_EDGE_REPEAT : FX_EDGE_MIRROR); }
`,
};

/**
 * S_WipeBubble: inside the band both clips are bubble-warped (the gradient of a fractal noise displaces the picture,
 * strongest mid-band) and switch along a bubbly boundary.
 */
export const S_WIPE_BUBBLE = sapphireWipe({
	name: 'wipe-bubble',
	label: 'S_WipeBubble',
	description: 'A bubble wipe: a bubble-warp distorts both clips inside the transition area as it crosses the frame.',
	keywords: ['bubble', 'warp', 'distort', 'liquid'],
	params: [
		swParam.edgeWidth(1.4),
		swParam.angle('angle', 'Angle', 0),
		fxParam.number('bubbleAmount', 'Bubble Amount', 0.5, { min: 0, max: 20, softMax: 3, step: 0.01 }),
		swParam.frequency(8),
		swParam.rel('freqRelX', 'Frequency Rel X', 1, 0.01),
		swParam.octaves(8),
		swParam.seed(),
		swParam.wrap(),
	],
	border: false,
	include: [GLSL_SW_BAND, GLSL_NOISE],
	frag: /* glsl */ `
float swBubbleNoise(vec2 q) { return fx_fbm(q, int(u_octaves), 2.0, 0.5, u_seed); }
void main() {
  vec2 px = tr_px();
  float w = sw_band(px, u_angle, u_edgeWidth);
  float strength = sin(FX_PI * w);
  vec2 q = (px - 0.5 * u_compSize) / max(u_compSize.x, 1.0) * u_frequency;
  q.x *= u_freqRelX;
  const float h = 0.02;
  float n = swBubbleNoise(q);
  vec2 grad = vec2(swBubbleNoise(q + vec2(h, 0.0)) - n, swBubbleNoise(q + vec2(0.0, h)) - n) / h;
  // Displacement (frame fractions), like looking through bubbles; zero outside the band.
  vec2 disp = grad * (0.04 * u_bubbleAmount * strength / max(u_frequency, 0.1));
  vec2 uv = v_uv - disp * vec2(1.0, tr_aspect());
  vec4 a = sw_wrapFrom(uv, u_wrap);
  vec4 b = sw_wrapTo(uv, u_wrap);
  float m = smoothstep(0.0, 1.0, clamp(w + 0.45 * n * strength, 0.0, 1.0));
  float p = tr_progress();
  fragColor = p <= 0.0 ? tr_from(v_uv) : p >= 1.0 ? tr_to(v_uv) : mix(a, b, m);
}`,
});

/**
 * S_WipeDiffuse: inside the band the pixels of both clips are scattered (a per-pixel random displacement up to
 * Diffuse Amount × 10 % of the frame height, strongest mid-band, new every frame) and switch in a random order.
 */
export const S_WIPE_DIFFUSE = sapphireWipe({
	name: 'wipe-diffuse',
	label: 'S_WipeDiffuse',
	description: 'A diffuse wipe: pixels scatter and diffuse between the clips inside the transition area.',
	keywords: ['diffuse', 'scatter', 'dither', 'noise', 'sand'],
	params: [
		swParam.edgeWidth(1.4),
		swParam.angle('angle', 'Angle', 0),
		fxParam.number('diffuseAmount', 'Diffuse Amount', 0.4, { min: 0, max: 20, softMax: 3, step: 0.01 }),
		swParam.wrap(),
	],
	border: false,
	include: [GLSL_SW_BAND, GLSL_NOISE],
	frag: /* glsl */ `
void main() {
  vec2 px = tr_px();
  float w = sw_band(px, u_angle, u_edgeWidth);
  float strength = sin(FX_PI * w);
  ivec3 cell = ivec3(floor(px), int(u_frame));
  vec2 r = vec2(fx_hash3(cell, u_seed), fx_hash3(cell + ivec3(7919, 104729, 0), u_seed)) - 0.5;
  vec2 disp = r * (0.2 * u_diffuseAmount * strength * u_compSize.y);
  vec2 uv = tr_uvOfPx(px + disp);
  float order = fx_hash3(cell + ivec3(31, 17, 3), fract(u_seed + 0.5));
  float m = step(order, w);
  vec4 c = m > 0.5 ? sw_wrapTo(uv, u_wrap) : sw_wrapFrom(uv, u_wrap);
  float p = tr_progress();
  fragColor = p <= 0.0 ? tr_from(v_uv) : p >= 1.0 ? tr_to(v_uv) : c;
}`,
});

/** Switching time (0..1, never exactly 0 or 1) of an element at position s along the band with random r. */
const GLSL_SW_ORDER: GlslChunk = {
	name: 'sapphire-wipes/order',
	deps: [GLSL_SW_CORE],
	source: /* glsl */ `
float sw_order(float s, float r, float ew) {
  float w = max(ew, 0.0);
  return 0.002 + 0.996 * clamp((s + w * r) / (1.0 + w), 0.0, 1.0);
}
`,
};

/**
 * S_WipePixelate: blocks of the incoming clip pop in one by one, ordered along Angle with a random spread of Edge
 * Width; Chunky clusters the random order into patches.
 */
export const S_WIPE_PIXELATE = sapphireWipe({
	name: 'wipe-pixelate',
	label: 'S_WipePixelate',
	description:
		'A pixelate wipe: blocks of pixels of the incoming clip are added onto the outgoing clip in a semi-random order.',
	keywords: ['pixelate', 'blocks', 'pixels', 'mosaic', 'random'],
	params: [
		swParam.edgeWidth(1),
		swParam.angle('angle', 'Angle', 0),
		swParam.frequency(20, 0.1, 'pixelFrequency', 'Pixel Frequency'),
		swParam.rel('pixelRelWidth', 'Pixel Rel Width', 1, 0.01),
		fxParam.number('chunky', 'Chunky', 0, { min: 0, max: 100, softMax: 5, step: 0.01 }),
		swParam.seed(),
	],
	border: false,
	include: [GLSL_SW_ORDER, GLSL_NOISE],
	frag: /* glsl */ `
void main() {
  vec2 bs = vec2(max(u_pixelRelWidth, 0.01), 1.0) * u_compSize.x / max(u_pixelFrequency, 0.1);
  vec2 cellF = floor(tr_px() / bs);
  ivec2 cell = ivec2(cellF);
  float r = fx_hash2(cell, u_seed);
  float k = u_chunky / (1.0 + u_chunky);
  r = mix(r, fx_noise01(fx_valueNoise(cellF * 0.25, fract(u_seed + 0.3))), k);
  float s = sw_gradPos((cellF + 0.5) * bs, u_angle);
  float t = sw_order(clamp(s, 0.0, 1.0), r, u_edgeWidth);
  float p = tr_progress();
  fragColor = p > t ? tr_to(v_uv) : tr_from(v_uv);
}`,
});

/**
 * S_WipePointalize: brush-like polygons (Voronoi cells, stretched into strokes by Stroke Length along directions
 * smoothed by Stroke Align) of the incoming clip are added in a semi-random order along Angle (Edge Width spread,
 * Chunky clusters).
 */
export const S_WIPE_POINTALIZE = sapphireWipe({
	name: 'wipe-pointalize',
	label: 'S_WipePointalize',
	description:
		'A pointalize wipe: brush-like polygon shapes of the incoming clip are added onto the outgoing clip in a semi-random order.',
	keywords: ['pointalize', 'pointillism', 'brush', 'strokes', 'polygons', 'paint'],
	params: [
		swParam.edgeWidth(2, 0.05),
		swParam.angle('angle', 'Angle', 0),
		swParam.frequency(20, 5),
		fxParam.number('chunky', 'Chunky', 0, { min: 0, max: 100, softMax: 5, step: 0.01 }),
		fxParam.number('strokeLength', 'Stroke Length', 0, { softMin: -5, softMax: 5, step: 0.01 }),
		fxParam.number('strokeAlign', 'Stroke Align', 0.5, { min: 0, max: 10, softMax: 1, step: 0.01 }),
		swParam.seed(),
	],
	border: false,
	include: [GLSL_SW_ORDER, GLSL_NOISE],
	frag: /* glsl */ `
// Switching time of the stroke around feature cell c (its point in pattern units: pt).
float swStrokeTime(ivec2 c, vec2 pt, float cellPx) {
  float r = fx_hash2(c, fract(u_seed + 0.21));
  float k = u_chunky / (1.0 + u_chunky);
  r = mix(r, fx_noise01(fx_valueNoise(pt * 0.25, fract(u_seed + 0.3))), k);
  float s = sw_gradPos(pt * cellPx, u_angle);
  return sw_order(clamp(s, 0.0, 1.0), r, u_edgeWidth);
}
void main() {
  float cellPx = u_compSize.x / max(u_frequency, 5.0);
  vec2 q = tr_px() / cellPx;
  ivec2 base = ivec2(floor(q));
  float L = 1.0 + abs(u_strokeLength);
  float d1 = 1e9, d2 = 1e9;
  float t1 = 0.0, t2 = 0.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      ivec2 c = base + ivec2(i, j);
      vec2 pt = vec2(c) + fx_hash22(c, u_seed);
      // Stroke direction: random per stroke, pulled towards a smooth flow field by Stroke Align.
      float ra = fx_hash2(c, fract(u_seed + 0.63)) * FX_TAU;
      float fa = fx_valueNoise(pt * 0.15, fract(u_seed + 0.85)) * FX_PI;
      float al = clamp(u_strokeAlign, 0.0, 1.0);
      vec2 dir = normalize(mix(vec2(cos(ra), sin(ra)), vec2(cos(fa), sin(fa)), al) + vec2(1e-4, 0.0));
      if (u_strokeLength < 0.0) dir = vec2(-dir.y, dir.x);
      vec2 o = q - pt;
      float d = length(vec2(dot(o, dir) / L, dot(o, vec2(-dir.y, dir.x))));
      if (d < d1) { d2 = d1; t2 = t1; d1 = d; t1 = swStrokeTime(c, pt, cellPx); }
      else if (d < d2) { d2 = d; t2 = swStrokeTime(c, pt, cellPx); }
    }
  float p = tr_progress();
  float m1 = p > t1 ? 1.0 : 0.0;
  float m2 = p > t2 ? 1.0 : 0.0;
  // Antialiased stroke edges: blend with the neighbouring stroke within half a pixel of the cell wall.
  float edgePx = 0.5 * (d2 - d1) * cellPx;
  float m = mix(m2, m1, clamp(0.5 + edgePx, 0.0, 1.0));
  fragColor = p <= 0.0 ? tr_from(v_uv) : p >= 1.0 ? tr_to(v_uv) : mix(tr_from(v_uv), tr_to(v_uv), m);
}`,
});

export const SAPPHIRE_BAND_WIPES = [S_WIPE_BUBBLE, S_WIPE_DIFFUSE, S_WIPE_PIXELATE, S_WIPE_POINTALIZE] as const;

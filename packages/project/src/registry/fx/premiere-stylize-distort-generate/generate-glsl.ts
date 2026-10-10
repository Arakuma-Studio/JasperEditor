// GLSL shared by the Premiere "Generate" effects (family "premiere-stylize-distort-generate", wave 2): layer-pixel
// coordinates, antialiased coverage helpers (box-filtered bands, soft steps), the "Size From" cell size of
// Checkerboard/Grid and the generator tail (draw inside the layer box, Blending Mode over the layer).
import type { GlslChunk } from '../shader.ts';
import { GLSL_PSDG_BLEND } from './common.ts';

export const GLSL_PSDG_GENERATE: GlslChunk = {
	name: 'psdg/generate',
	deps: [GLSL_PSDG_BLEND],
	source: /* glsl */ `
// Layer box size in layer pixels.
vec2 gen_layerSize() { return u_box.zw / u_pxScale; }
// Half a canvas pixel in layer pixels (antialiasing half-width).
float gen_aa() { return 0.5 / u_pxScale; }
// Coverage 1 below 'edge', 0 above, with a linear transition of half-width max(feather / 2, AA) centred on 'edge'.
float gen_below(float x, float edge, float feather) {
  float h = max(feather * 0.5, gen_aa());
  return clamp((edge + h - x) / (2.0 * h), 0.0, 1.0);
}
// Box-filtered coverage of the band |x| <= halfWidth by a filter of half-width max(feather / 2, AA) (0 when the
// band is empty — no ghost lines at zero width).
float gen_band(float x, float halfWidth, float feather) {
  float h = max(feather * 0.5, gen_aa());
  float hw = max(halfWidth, 0.0);
  float a = min(abs(x) + h, hw) - max(abs(x) - h, -hw);
  return clamp(a / (2.0 * h), 0.0, 1.0);
}
// Signed square wave of a checkerboard axis: +1 inside even cells, -1 inside odd cells, linear across the cell
// edges over max(feather, 1 canvas px).
float gen_squareWave(float x, float period, float feather) {
  float u = x / period;
  float k = floor(u);
  float f = u - k;
  float d = min(f, 1.0 - f) * period;
  float h = max(feather * 0.5, gen_aa());
  float s = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
  return s * clamp(d / h, 0.0, 1.0);
}
// Distance (layer px) to the nearest cell edge along one axis.
float gen_edgeDistance(float x, float period) {
  float f = fract(x / period);
  return min(f, 1.0 - f) * period;
}
// Checkerboard / Grid "Size From": 0 Corner Point (anchor→corner rectangle), 1 Width Slider (squares),
// 2 Width & Height Sliders. Layer pixels, at least 1/100 px.
vec2 gen_cellSize(int sizeFrom, vec2 anchorPx, vec2 cornerPx, float w, float h) {
  vec2 s = sizeFrom == 0 ? abs(cornerPx - anchorPx) : sizeFrom == 1 ? vec2(w) : vec2(w, h);
  return max(s, vec2(0.01));
}
// Generator tail: the generated picture (premultiplied) only inside the layer box, blended over the layer.
vec4 gen_finish(int mode, vec4 src, vec4 generated, float opacityPercent) {
  vec4 g = fx_inBox(v_uv) ? generated : vec4(0.0);
  return psdg_blend(mode, src, g, opacityPercent / 100.0);
}
`,
};

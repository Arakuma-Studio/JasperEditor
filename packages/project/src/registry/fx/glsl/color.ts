// Shared GLSL: colour helpers. Inputs are straight (un-premultiplied) display-referred RGB in
// 0..1 unless noted — call `fx_unpremultiply` on texture reads first and `fx_premultiply` before writing fragColor.
// Luma uses the Rec.709 weights, like the colour stage (S06).
import type { GlslChunk } from '../shader.ts';

export const GLSL_COLOR: GlslChunk = {
	name: 'fx/color',
	source: /* glsl */ `
const vec3 FX_LUMA709 = vec3(0.2126, 0.7152, 0.0722);
float fx_luma(vec3 c) { return dot(c, FX_LUMA709); }
vec3 fx_saturate(vec3 c, float amount) { float l = fx_luma(c); return mix(vec3(l), c, amount); }
vec3 fx_srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 fx_linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
// HSV / HSL with h, s, v / l in 0..1.
vec3 fx_rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 fx_hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 fx_rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d <= 1.0e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float fx_hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 fx_hsl2rgb(vec3 c) {
  if (c.y <= 0.0) return vec3(c.z);
  float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y;
  float p = 2.0 * c.z - q;
  return vec3(fx_hue2rgb(p, q, c.x + 1.0 / 3.0), fx_hue2rgb(p, q, c.x), fx_hue2rgb(p, q, c.x - 1.0 / 3.0));
}
// Rotates hue by turns (1.0 = 360°).
vec3 fx_hueShift(vec3 c, float turns) { vec3 h = fx_rgb2hsv(c); h.x = fract(h.x + turns); return fx_hsv2rgb(h); }
// Brightness (additive) / contrast (around mid grey) like jasper.brightness-contrast's maths, values −1..1.
vec3 fx_brightnessContrast(vec3 c, float brightness, float contrast) { return (c - 0.5) * (1.0 + contrast) + 0.5 + brightness; }
// Gradient map: black → a, white → b (Premiere Tint).
vec3 fx_tint(vec3 c, vec3 black, vec3 white, float amount) { return mix(c, mix(black, white, fx_luma(c)), amount); }
`,
};

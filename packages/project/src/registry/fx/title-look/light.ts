// Light in a look: what additive light does to a premultiplied picture, shared by every layer and effect that adds it
// (`deepGlow`, `contourLines`, additive `glow`, Deep Glow). Spec 19 TL-032.
//
// Compositing inside a look is linear light, but the sequence composites its signal (sRGB-encoded, premultiplied). Light
// over nothing has no alpha of its own, and the usual fix, alpha = its brightest linear channel, reads far too dark once
// encoded: a white tail of 2 % comes out as signal 0.02 over black, where light of 2 % looks like 0.15, so a glow keeps a
// bright core and loses its tail. `tl_veil` picks the colour and alpha whose encoded, premultiplied form over black is
// exactly the encoded light, and that screens over anything else. Assumption, not a documented formula: chosen by
// comparing glows over black and over footage (docs/wp-notes/title-looks.md).
import { GLSL_COLOR } from '../glsl/color.ts';
import type { GlslChunk } from '../shader.ts';
import { GLSL_TL_SURFACE } from './glsl.ts';

export const GLSL_TL_LIGHT: GlslChunk = {
	name: 'title-look/light',
	deps: [GLSL_COLOR, GLSL_TL_SURFACE],
	source: /* glsl */ `
// What tl_layer returns so that tl_over(under, result) is exactly D: for layers that add light or blend with what is
// below, which a premultiplied top colour cannot say on its own.
vec4 tl_result(vec4 under, vec4 D) {
  float t = under.a < 0.9995 ? clamp((D.a - under.a) / (1.0 - under.a), 0.0, 1.0) : 0.0;
  return vec4(D.rgb - under.rgb * (1.0 - t), t);
}
// Linear light on nothing as a premultiplied linear colour (see the note at the top of this file).
vec4 tl_veil(vec3 light) {
  vec3 signal = fx_linearToSrgb(clamp(light, 0.0, 1.0));
  float a = max(signal.r, max(signal.g, signal.b));
  if (a <= 0.0) return vec4(0.0);
  return vec4(fx_srgbToLinear(signal / a) * a, a);
}
// Light added to a picture: 'covered' on the part the picture covers (premultiplied by it), 'empty' where it does not.
vec4 tl_lit(vec4 under, vec3 covered, vec3 empty) {
  vec4 v = tl_veil(empty) * (1.0 - clamp(under.a, 0.0, 1.0));
  return vec4(covered + v.rgb, under.a + v.a);
}
// The composite as the framework's signal: sRGB-encoded, premultiplied (FRAG_TL_OUTPUT as a function).
vec4 tl_encode(vec4 c) {
  float a = clamp(c.a, 0.0, 1.0);
  if (a <= 0.0) return vec4(0.0);
  return vec4(fx_linearToSrgb(clamp(c.rgb / a, 0.0, 1.0)) * a, a);
}
// The input picture as premultiplied linear light, for effects without a shape field.
vec4 tl_inputLinear(vec2 uv) {
  vec4 c = texture(u_source, uv);
  return c.a > 0.0 ? vec4(tl_linear(c.rgb / c.a) * c.a, c.a) : vec4(0.0);
}
`,
};

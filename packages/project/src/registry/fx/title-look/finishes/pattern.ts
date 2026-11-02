// `pattern` (§5.1): a motif over the paint, in two colours or a tile of the user's picture. The motif sits on the layer box, in
// the look's unit: it moves with the title and keeps its size at every resolution (Pachislop's Pattern, without its layer
// space). `Relief` raises the marks and lights them with the look's light.
import { TL_PATTERN_KINDS, GLSL_TL_PATTERN_BASE, TL_PATTERN_LABELS, TLP_KINDS_GLSL, tlPatternDefine } from '../../glsl/title-pattern.ts';
import { GLSL_TL_SHADE } from '../../glsl/title-relief.ts';
import { defineFinish, lp } from '../contract.ts';

/** Canvas px → motif units (`scale`: canvas px per motif, `a`: rotation) and the steps per canvas px, for finishes and layers. */
export const MOTIF_GLSL = /* glsl */ `
vec2 tl_motifAt(vec2 px, float scale, float a) {
  float c = cos(a), n = sin(a);
  vec2 q = (px - u_box.xy) / max(scale, 1.0e-3);
  return vec2(c * q.x - n * q.y, n * q.x + c * q.y);
}
`;

export const FINISH_PATTERN = defineFinish({
	id: 'pattern',
	label: 'Pattern',
	description: 'A motif over the paint, in two colours or a tile of your own picture.',
	params: [
		lp.choice('patternKind', 'Motif', TL_PATTERN_KINDS, TL_PATTERN_LABELS, 'hazard'),
		lp.media('patternImage', 'Tile', ['image']),
		lp.distance('patternScale', 'Scale', 12, { softMax: 60 }),
		lp.angle('patternAngle', 'Angle', 0),
		lp.number('patternSeed', 'Seed', 0, { min: 0, max: 100000, softMax: 1000, step: 1 }),
		...lp.paint('patternInk', 'Marks', { kind: 'role', role: 'accent1' }),
		...lp.paint('patternInkAlt', 'Second Colour', { kind: 'role', role: 'accent2' }),
		lp.percent('patternOpacity', 'Opacity', 100),
		lp.percent('patternRelief', 'Relief', 0),
	],
	include: [GLSL_TL_PATTERN_BASE, GLSL_TL_SHADE],
	defines: (p) =>
		`${tlPatternDefine(p.patternKind)}#define TLP_IMAGE u_patternImage\n#define TLP_IMAGE_SIZE u_patternImage_size\n`,
	glsl: /* glsl */ `${TLP_KINDS_GLSL}${MOTIF_GLSL}
vec4 tl_finish(vec4 paint, TlSurface s) {
  float scale = tl_px(max(u_patternScale, 0.1));
  float a = radians(u_patternAngle);
  vec2 p = tl_motifAt(s.px, scale, a);
  vec2 dx = tl_motifAt(s.px + vec2(1.0, 0.0), scale, a) - p;
  vec2 dy = tl_motifAt(s.px + vec2(0.0, 1.0), scale, a) - p;
  float seed = fract(u_tlSeed + u_patternSeed * 0.0137);
  vec4 m = tlp_sample(p, dx, dy, seed);
  vec3 c = tl_straight(paint);
  float op = u_patternOpacity * 0.01;
  vec4 ink = tlPaint_patternInk(s), alt = tlPaint_patternInkAlt(s);
  c = mix(c, tl_straight(ink), m.x * op * ink.a);
  c = mix(c, tl_straight(alt), m.y * op * alt.a);
  if (u_patternRelief > 0.0) {
    // Raised marks stand 6 % of a motif tall at full relief, whatever the pattern's scale (Pachislop's convention).
    float k = u_patternRelief * 0.01 * 0.06 / max(length(dx), 1.0e-6);
    vec2 g = vec2(tlp_sample(p + dx, dx, dy, seed).z - tlp_sample(p - dx, dx, dy, seed).z,
                  tlp_sample(p + dy, dx, dy, seed).z - tlp_sample(p - dy, dx, dy, seed).z) * 0.5 * k;
    vec3 n = normalize(vec3(-g, 1.0));
    float l = dot(n, u_tlLight) - u_tlLight.z;
    c *= 1.0 + l * 1.6;
  }
  return vec4(c * paint.a, paint.a);
}`,
	summary: (p) => `${String(p.patternKind)} pattern`,
});

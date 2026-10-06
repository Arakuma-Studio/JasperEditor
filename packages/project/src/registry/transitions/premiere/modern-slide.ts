// Premiere 26 ▸ Video Transitions ▸ Slide — the modern entries (from Film Impact): 3D Roll, Film Roll, Roll and
// Stretch. Part of the premiere-transitions family (Push, Split, Whip and the classic slides are in ./slide.ts and
// ../premiere-transitions.ts). Shaders work in "motion axes" (pm_toAxes): x along the motion, B arriving from −x.
import type { TransitionSpec } from '../../../transitions.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { DIR4, selectorParam, selectorVec } from './common.ts';
import { GLSL_PR_MODERN } from './modern-common.ts';

const bin = TRANSITION_BINS.slide;
const blurParam = (def = 50) => fxParam.percent('blur', 'Motion Blur', def);

/** Speed of an eased travel (frame lengths per frame) at p, for motion-blur lengths. */
const SPEED = /* glsl */ `
float pmSpeed(float p) {
  float a = max(p - 0.01, 0.0), b = min(p + 0.01, 1.0);
  return (tr_easeInOut(b) - tr_easeInOut(a)) / max(b - a, 1e-4) / max(u_duration, 2.0);
}`;

/** Slide ▸ 3D Roll: the clips scroll past as if wrapped around a turning drum, bending in perspective mid-way. */
export const ROLL_3D = defineShaderTransition({
	id: 'jasper.3d-roll',
	label: '3D Roll',
	bin,
	description:
		'The clips roll past in perspective, as if wrapped around a turning drum: the outgoing clip rolls away, the incoming clip rolls in.',
	keywords: ['3d', 'roll', 'drum', 'cylinder', 'perspective', 'film impact'],
	params: [selectorParam(DIR4, 'westToEast'), fxParam.angle('bend', 'Bend', 60), blurParam()],
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `${SPEED}
// The strip (A on [0, 1], B on [−1, 0] along the motion) at strip position u, across position y.
vec4 rdStrip(float u, float y) {
  if (y < 0.0 || y > 1.0) return vec4(0.0);
  if (u >= 0.0) return u <= 1.0 ? tr_from(pm_fromAxes(vec2(u, y), u_dir)) : vec4(0.0);
  return u >= -1.0 ? tr_to(pm_fromAxes(vec2(u + 1.0, y), u_dir)) : vec4(0.0);
}
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  vec2 S = pm_axesSize(u_dir);
  float travel = tr_easeInOut(p);
  float bend = clamp(radians(u_bend), 0.0, 1.5) * pm_bump(p);
  float X = q.x - 0.5;
  float phi = 0.0, s = X;
  if (bend > 1e-3) {
    phi = asin(clamp(2.0 * X * sin(bend), -1.0, 1.0));
    s = 0.5 * phi / bend;
  }
  // Depth of the drum surface (frame lengths) → the across axis shrinks with distance.
  float R = bend > 1e-3 ? 0.5 / sin(bend) : 1e6;
  float z = bend > 1e-3 ? R * (cos(phi) - cos(bend)) : 0.0;
  float zc = bend > 1e-3 ? R * (1.0 - cos(bend)) : 0.0;
  float D = 1.6;
  float y = 0.5 + (q.y - 0.5) * (D + (zc - z) * S.x / S.y) / D;
  float L = (u_blur / 100.0) * pmSpeed(p) * 1.5;
  vec4 c = vec4(0.0);
  for (int i = 0; i < 12; i++) c += rdStrip(s + 0.5 - travel + L * ((float(i) + 0.5) / 12.0 - 0.5), y);
  c /= 12.0;
  float shade = mix(1.0, cos(phi), 0.85);
  fragColor = vec4(c.rgb * shade, c.a);
}`,
			},
		],
	},
});

/** Slide ▸ Film Roll: the picture slips like film in a projector — frame line, sprocket holes and motion blur. */
export const FILM_ROLL = defineShaderTransition({
	id: 'jasper.film-roll',
	label: 'Film Roll',
	bin,
	description:
		'The picture slips like film running through a projector: the outgoing frame rolls out past the frame line and sprocket holes, the incoming frame rolls in.',
	keywords: ['film', 'roll', 'projector', 'sprocket', 'frame line', 'film impact'],
	params: [selectorParam(DIR4, 'southToNorth'), blurParam(60)],
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `${SPEED}
const float FR_GAP = 0.07;
// The film at strip position u (A on [0, 1], frame line, B before it) and across position y (the picture on
// [0, 1], the perforated film edges beyond).
vec4 frFilm(float u, float y, float edge, vec2 S) {
  vec4 base = vec4(0.035, 0.03, 0.025, 1.0);
  if (y < 0.0 || y > 1.0) {
    float e = y < 0.0 ? -y : y - 1.0;
    if (e > edge) return vec4(0.0);
    // Sprocket holes: rounded rectangles every quarter frame, in the middle of the edge band.
    float along = mod(u * 4.0, 1.0) - 0.5;
    vec2 h = vec2(abs(along) * S.x / 4.0, abs(e - 0.5 * edge) * S.y) - vec2(0.18 * S.x / 4.0, 0.22 * edge * S.y);
    float hole = 1.0 - smoothstep(-1.0, 1.0, length(max(h, 0.0)) + min(max(h.x, h.y), 0.0) - 2.0);
    return mix(base, vec4(0.82, 0.8, 0.74, 1.0), hole);
  }
  if (u >= 0.0) return u <= 1.0 ? tr_from(pm_fromAxes(vec2(u, y), u_dir)) : base;
  if (u > -FR_GAP) return base;
  return u >= -1.0 - FR_GAP ? tr_to(pm_fromAxes(vec2(u + 1.0 + FR_GAP, y), u_dir)) : base;
}
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  vec2 S = pm_axesSize(u_dir);
  float travel = tr_easeInOut(p) * (1.0 + FR_GAP);
  // The strip pulls back a little mid-way so its perforated edges show.
  float sc = 1.0 - 0.16 * pm_bump(p);
  vec2 c = (q - 0.5) / sc + 0.5;
  float edge = 0.12 * S.x / S.y;
  float L = (u_blur / 100.0) * pmSpeed(p) * (1.0 + FR_GAP) * 1.5;
  vec4 col = vec4(0.0);
  for (int i = 0; i < 12; i++) col += frFilm(c.x - travel + L * ((float(i) + 0.5) / 12.0 - 0.5), c.y, edge, S);
  fragColor = col / 12.0;
}`,
			},
		],
	},
});

/** Slide ▸ Roll: the clips ride a big wheel — the outgoing clip rolls out, the incoming one rolls in. */
export const ROLL = defineShaderTransition({
	id: 'jasper.roll',
	label: 'Roll',
	bin,
	description:
		'The clips ride a big wheel turning under the frame: the outgoing clip rolls out of the frame as the incoming clip rolls in.',
	keywords: ['roll', 'rotate', 'wheel', 'spin', 'film impact'],
	params: [
		fxParam.choice(
			'rotation',
			'Direction',
			['clockwise', 'counterclockwise'],
			['Clockwise', 'Counterclockwise'],
			'clockwise',
		),
		blurParam(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `${SPEED}
const float RL_HUB = 1.6;
vec2 rlRot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x + s * v.y, -s * v.x + c * v.y); }
// The clips sit side by side on the rim (one picture width apart at the frame centre's radius).
float rlStep() { return 2.0 * atan(0.5 * tr_aspect() / RL_HUB); }
vec4 rlWheel(float a, float sgn) {
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 hub = vec2(0.5, 0.5 + RL_HUB);
  vec2 v = (v_uv - hub) * asp;
  vec4 A = tr_from(rlRot(v, a) / asp + hub);
  vec4 B = tr_to(rlRot(v, a - sgn * rlStep()) / asp + hub);
  return tr_over(A, B);
}
void main() {
  float p = tr_progress();
  float sgn = u_rotation == 0 ? 1.0 : -1.0;
  float a = sgn * tr_easeInOut(p) * rlStep();
  float L = (u_blur / 100.0) * pmSpeed(p) * rlStep() * 1.5;
  vec4 c = vec4(0.0);
  for (int i = 0; i < 12; i++) c += rlWheel(a + sgn * L * ((float(i) + 0.5) / 12.0 - 0.5), sgn);
  fragColor = c / 12.0;
}`,
			},
		],
	},
});

/** Slide ▸ Stretch: the outgoing clip is pulled out of the frame, stretching; the incoming one snaps in. */
export const STRETCH_TRANSITION = defineShaderTransition({
	id: 'jasper.stretch-transition',
	label: 'Stretch',
	bin,
	description:
		'The outgoing clip is pulled across and out of the frame, stretching as it goes, while the incoming clip arrives stretched and relaxes into place.',
	keywords: ['stretch', 'pull', 'elastic', 'warp', 'film impact'],
	params: [selectorParam(DIR4, 'westToEast'), fxParam.percent('stretch', 'Stretch', 100), blurParam(40)],
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `${SPEED}
vec4 stAt(float x, float y, float tr, float g) {
  x = clamp(x, 0.0, 1.0);
  if (x >= tr) {
    float t = (x - tr) / max(1.0 - tr, 1e-4);
    float u = (1.0 - tr) * (1.0 - pow(1.0 - t, g));
    return tr_from(pm_fromAxes(vec2(u, y), u_dir));
  }
  float t = x / max(tr, 1e-4);
  float u = (1.0 - tr) + tr * pow(t, g);
  return tr_to(pm_fromAxes(vec2(u, y), u_dir));
}
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  float tr = tr_easeInOut(p);
  float g = 1.0 + 3.0 * (u_stretch / 100.0) * pm_bump(p);
  float L = (u_blur / 100.0) * pmSpeed(p) * 1.5;
  vec4 c = vec4(0.0);
  for (int i = 0; i < 12; i++) c += stAt(q.x + L * ((float(i) + 0.5) / 12.0 - 0.5), q.y, tr, g);
  fragColor = c / 12.0;
}`,
			},
		],
	},
});

export const MODERN_SLIDES: readonly TransitionSpec[] = [ROLL_3D, FILM_ROLL, ROLL, STRETCH_TRANSITION];

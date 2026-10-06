// Premiere ▸ Video Transitions ▸ 3D Motion (part of the premiere-transitions family): Cube Spin and Flip Over, ray
// traced in a small perspective scene. Units are frame heights; the camera looks at the frame from PR3_DIST frame
// heights in front of it, so the frame plane (z = 0) maps 1:1 onto the screen. The scene is laid out for the
// "West to East" direction; the other edge selectors rotate/mirror the screen into that layout and back.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import type { GlslChunk } from '../../fx/shader.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_WIPE, GLSL_TRANSITION } from '../glsl.ts';
import { countParam, DIR4, ORIENT, selectorParam, selectorVec } from './common.ts';

const bin = TRANSITION_BINS.motion3d;

/** Screen ↔ scene layout of a direction: `u_swap` (vertical motion: x/y exchanged) and `u_flip` (mirrored). */
const layout = (dir: [number, number]) => ({
	u_swap: dir[1] !== 0,
	u_flip: dir[0] + dir[1] < 0,
});

export const GLSL_PR_3D: GlslChunk = {
	name: 'premiere/3d',
	deps: [GLSL_TRANSITION, GLSL_TR_WIPE],
	source: /* glsl */ `
const float PR3_DIST = 2.5;
const float PR_PI_3D = 3.14159265358979;
// Scene coordinates of v_uv in frame heights (s = along the motion, a = along the rotation axis) and the frame's half
// extents in them.
vec2 pr3Screen(bool swap, bool flip) {
  vec2 q = (v_uv - 0.5) * vec2(tr_aspect(), 1.0);
  if (swap) q = q.yx;
  if (flip) q.x = -q.x;
  return q;
}
vec2 pr3Half(bool swap) { vec2 h = 0.5 * vec2(tr_aspect(), 1.0); return swap ? h.yx : h; }
// Back from face coordinates (0..1 along s and a) to frame uv.
vec2 pr3Uv(vec2 f, bool swap, bool flip) {
  if (flip) f.x = 1.0 - f.x;
  return swap ? f.yx : f;
}
// Ray from the camera through the screen point q: hit of the plane through c with normal n (unit), spanned by the
// unit vectors U (face s axis) and V (face a axis) of half sizes h. Returns (face s, face a, ray t, facing): facing > 0
// when the front of the face (the side its normal points to) is seen; t < 0 = no hit.
vec4 pr3Face(vec2 q, vec3 c, vec3 n, vec3 U, vec3 V, vec2 h) {
  vec3 cam = vec3(0.0, 0.0, -PR3_DIST);
  vec3 dir = vec3(q, PR3_DIST);
  float den = dot(dir, n);
  if (abs(den) < 1e-6) return vec4(0.0, 0.0, -1.0, 0.0);
  float t = dot(c - cam, n) / den;
  vec3 p = cam + t * dir - c;
  vec2 f = vec2(dot(p, U), dot(p, V)) / (2.0 * h) + 0.5;
  return vec4(f, t, den < 0.0 ? 1.0 : -1.0);
}
// Distance (px) from the face coordinate f to the face edge, for a face of half size h (frame heights).
float pr3EdgePx(vec2 f, vec2 h) {
  vec2 e = min(f, 1.0 - f) * 2.0 * h * u_compSize.y;
  return min(e.x, e.y);
}
`,
};

/** 3D Motion ▸ Cube Spin: A and B are two sides of a cube that turns to bring B to the front. */
export const CUBE_SPIN = defineShaderTransition({
	id: 'jasper.cube-spin',
	label: 'Cube Spin',
	bin,
	description:
		'The outgoing and incoming clips are two sides of a cube that spins to bring the incoming clip to the front.',
	keywords: ['cube', 'spin', '3d', 'rotate', 'box'],
	params: [selectorParam(DIR4, 'westToEast')],
	options: { border: true, antiAliasing: true },
	gpu: {
		uniforms: (p: EffectParams) => layout(selectorVec(DIR4, p)),
		passes: [
			{
				include: [GLSL_PR_3D],
				frag: /* glsl */ `
vec4 csFace(vec4 hit, vec2 h, bool isTo, float bw, float aa) {
  if (hit.z <= 0.0 || hit.w <= 0.0 || any(lessThan(hit.xy, vec2(0.0))) || any(greaterThan(hit.xy, vec2(1.0)))) return vec4(0.0);
  vec2 uv = pr3Uv(hit.xy, u_swap, u_flip);
  vec4 c = isTo ? tr_to(uv) : tr_from(uv);
  float e = pr3EdgePx(hit.xy, h);
  if (bw > 0.0) c = mix(tr_premul(u_borderColor), c, tr_edge(e - bw, 0.0, aa));
  return c * (aa > 0.0 ? clamp(e / aa + 0.5, 0.0, 1.0) : 1.0);
}
void main() {
  float p = tr_progress();
  float phi = 0.5 * PR_PI_3D * p;
  vec2 q = pr3Screen(u_swap, u_flip);
  vec2 h = pr3Half(u_swap);
  // Square cross-section of side 2·h.x; pushed back so its nearest edge stays on the frame plane.
  float hs = h.x;
  float cz = hs * (cos(phi) + sin(phi));
  // Turning by −phi about the vertical axis: the front face (A) moves towards +s, the −s face (B) comes to the front.
  float co = cos(phi), si = sin(phi);
  vec3 centre = vec3(0.0, 0.0, cz);
  vec3 nA = vec3(si, 0.0, -co);
  vec3 uA = vec3(co, 0.0, si);
  vec3 nB = vec3(-co, 0.0, -si);
  vec3 uB = vec3(si, 0.0, -co);
  vec3 V = vec3(0.0, 1.0, 0.0);
  vec4 ha = pr3Face(q, centre + hs * nA, nA, uA, V, h);
  vec4 hb = pr3Face(q, centre + hs * nB, nB, uB, V, h);
  // The border and edge softening fade in and out so the first / last frames are exactly A / B.
  float k = clamp(8.0 * p * (1.0 - p), 0.0, 1.0);
  float bw = max(u_borderWidth, 0.0) * k;
  float aa = tr_aaWidth(u_antiAliasing) * k;
  vec4 a = csFace(ha, h, false, bw, aa);
  vec4 b = csFace(hb, h, true, bw, aa);
  bool aFirst = ha.z > 0.0 && (hb.z <= 0.0 || ha.z < hb.z);
  fragColor = aFirst ? tr_over(a, b) : tr_over(b, a);
}`,
			},
		],
	},
});

/** 3D Motion ▸ Flip Over: A flips over like a card (or a row of cards) to show B on its back. */
export const FLIP_OVER = defineShaderTransition({
	id: 'jasper.flip-over',
	label: 'Flip Over',
	bin,
	description:
		'The outgoing clip flips over like a card to reveal the incoming clip on its back; split into several bands it flips like slats.',
	keywords: ['flip', 'card', '3d', 'turn', 'bands'],
	params: [
		selectorParam(ORIENT, 'horizontal'),
		countParam('bands', 'Bands', 1, 32),
		fxParam.color('fillColor', 'Fill Color', [0.5, 0.5, 0.5, 1]),
	],
	options: { antiAliasing: true },
	gpu: {
		uniforms: (p: EffectParams) => layout(selectorVec(ORIENT, p)),
		passes: [
			{
				include: [GLSL_PR_3D],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float th = PR_PI_3D * p;
  vec2 q = pr3Screen(u_swap, false);
  vec2 h = pr3Half(u_swap);
  float n = max(1.0, floor(u_bands + 0.5));
  float bandW = 2.0 * h.x / n;
  vec2 hb = vec2(0.5 * bandW, h.y);
  float k = clamp(8.0 * p * (1.0 - p), 0.0, 1.0);
  float aa = tr_aaWidth(u_antiAliasing) * k;
  // Each band is a card turning about its own centre line; check this band and its neighbours (a card leaning towards
  // the camera can reach over them) and keep the nearest hit.
  float i0 = floor((q.x + h.x) / bandW);
  vec4 best = vec4(0.0);
  float bestT = 1e9;
  float co = cos(th), si = sin(th);
  vec3 nrm = vec3(si, 0.0, -co);
  vec3 U = vec3(co, 0.0, si);
  for (int j = -1; j <= 1; j++) {
    float i = i0 + float(j);
    if (i < 0.0 || i > n - 1.0) continue;
    vec3 c = vec3(-h.x + (i + 0.5) * bandW, 0.0, 0.0);
    vec4 hit = pr3Face(q, c, nrm, U, vec3(0.0, 1.0, 0.0), hb);
    if (hit.z <= 0.0 || hit.z >= bestT || any(lessThan(hit.xy, vec2(0.0))) || any(greaterThan(hit.xy, vec2(1.0)))) continue;
    bool front = hit.w > 0.0;
    // Back face: seen from behind, so its s axis runs the other way (B reads correctly).
    float fs = front ? hit.x : 1.0 - hit.x;
    vec2 f = vec2((i + fs) / n, hit.y);
    vec2 uv = u_swap ? f.yx : f;
    vec4 col = front ? tr_from(uv) : tr_to(uv);
    float cov = aa > 0.0 ? clamp(pr3EdgePx(hit.xy, hb) / aa + 0.5, 0.0, 1.0) : 1.0;
    best = col * cov + tr_premul(u_fillColor) * (1.0 - cov);
    bestT = hit.z;
  }
  fragColor = bestT < 1e8 ? best : tr_premul(u_fillColor);
}`,
			},
		],
	},
});

export const PREMIERE_3D_MOTION: readonly TransitionSpec[] = [CUBE_SPIN, FLIP_OVER];

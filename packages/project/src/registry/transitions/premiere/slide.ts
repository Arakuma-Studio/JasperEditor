// Premiere ▸ Video Transitions ▸ Slide (part of the premiere-transitions family; Push lives in
// ../premiere-transitions.ts). Moving pictures carry their border with them: the border sits ahead of a moving B (or
// on the B side of a moving piece of A) and the travel is extended by the border + anti-aliasing width, so nothing of
// it is left in the frame at either end of the transition.
import type { TransitionSpec } from '../../../transitions.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_EASE } from '../glsl.ts';
import { countParam, DIR4, DIR8, GLSL_PR_COMMON, ORIENT, selectorParam, selectorVec } from './common.ts';

const bin = TRANSITION_BINS.slide;
const OPTIONS = { border: true, antiAliasing: true } as const;

/** Preamble of the slide passes: progress, edge width, border and margin. */
const PRE = /* glsl */ `
  vec2 px = tr_px();
  float p = tr_progress();
  float aa = tr_aaWidth(u_antiAliasing);
  float bw = max(u_borderWidth, 0.0);
  float m = bw + aa + 1.0;`;

/** Slide ▸ Slide: B slides in over A (eight edge selectors). */
export const SLIDE = defineShaderTransition({
	id: 'jasper.slide',
	label: 'Slide',
	bin,
	description: 'The incoming clip slides in over the outgoing clip from one side or corner of the frame.',
	keywords: ['slide', 'move', 'cover', 'conceal'],
	params: [selectorParam(DIR8, 'westToEast')],
	options: OPTIONS,
	gpu: {
		// Diagonals come from the corner: both axes travel a full frame.
		uniforms: (p) => {
			const [x, y] = selectorVec(DIR8, p);
			return { u_dir: [Math.sign(Math.round(x * 2)), Math.sign(Math.round(y * 2))] };
		},
		passes: [
			{
				include: [GLSL_PR_COMMON],
				frag: /* glsl */ `
void main() {${PRE}
  vec2 off = (p - 1.0) * u_dir * (u_compSize + m);
  vec4 b = texture(u_to, clamp(tr_uvOfPx(px - off), 0.0, 1.0));
  if (!u_hasTo) b = vec4(0.0);
  // B's rectangle (unbounded along the axes it does not move on); the edge ramp and the border lie ahead of it.
  vec2 hs = 0.5 * u_compSize + (1.0 - abs(u_dir)) * 1e5;
  float d = pr_box(px, 0.5 * u_compSize + off, hs) + bw + 0.5 * aa;
  fragColor = tr_wipeMix(tr_from(v_uv), b, d, 0.0, aa, bw, u_borderColor);
}`,
			},
		],
	},
});

/** Slide ▸ Band Slide: bands of B slide in from alternating sides. */
export const BAND_SLIDE = defineShaderTransition({
	id: 'jasper.band-slide',
	label: 'Band Slide',
	bin,
	description: 'The incoming clip slides in as bands that alternately enter from opposite sides of the frame.',
	keywords: ['bands', 'slide', 'stripes', 'interlaced'],
	params: [selectorParam(DIR4, 'westToEast'), countParam('bands', 'Bands', 7)],
	options: OPTIONS,
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_PR_COMMON],
				frag: /* glsl */ `
void main() {${PRE}
  vec2 st = pr_axes(px, u_dir);
  vec2 ext = pr_extent(u_dir);
  float n = max(1.0, floor(u_bands + 0.5));
  float k = floor(clamp((st.y + ext.y) / (2.0 * ext.y), 0.0, 0.99999) * n);
  float s = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
  float off = (p - 1.0) * (2.0 * ext.x + m);
  vec4 b = texture(u_to, clamp(tr_uvOfPx(px - s * u_dir * off), 0.0, 1.0));
  if (!u_hasTo) b = vec4(0.0);
  float d = (ext.x + off) - s * st.x + bw + 0.5 * aa;
  fragColor = tr_wipeMix(tr_from(v_uv), b, d, 0.0, aa, bw, u_borderColor);
}`,
			},
		],
	},
});

/**
 * A split of A into pieces that move away from the centre (Center Split: four quarters to the corners; Split: two
 * halves along one axis), revealing B. `axes` = which axes split (1 = splits).
 */
function splitPass(axes: string) {
	return {
		include: [GLSL_PR_COMMON],
		frag: /* glsl */ `
void main() {${PRE}
  vec2 axes = ${axes};
  vec2 c = 0.5 * u_compSize;
  vec2 q = px - c;
  vec2 sg = vec2(q.x < 0.0 ? -1.0 : 1.0, q.y < 0.0 ? -1.0 : 1.0) * axes;
  vec2 off = sg * p * (c + m);
  // Distance inside the moved piece, measured from its inner (split) edges only.
  vec2 inner = sg * (q - off);
  float dA = min(axes.x > 0.5 ? inner.x : 1e5, axes.y > 0.5 ? inner.y : 1e5);
  // A sampled inside its own piece (clamped there, so the edge ramp never shows the other piece).
  vec2 lo = vec2(sg.x > 0.0 ? c.x : 0.0, sg.y > 0.0 ? c.y : 0.0);
  vec2 hi = vec2(sg.x < 0.0 ? c.x : u_compSize.x, sg.y < 0.0 ? c.y : u_compSize.y);
  lo = mix(vec2(0.0), lo, axes);
  hi = mix(u_compSize, hi, axes);
  vec4 a = texture(u_from, tr_uvOfPx(clamp(px - off, lo, hi)));
  if (!u_hasFrom) a = vec4(0.0);
  // The edge ramp lies on B's side of the piece's edge; the border follows it on B's side.
  fragColor = tr_wipeMix(a, tr_to(v_uv), -dA - 0.5 * aa, 0.0, aa, bw, u_borderColor);
}`,
	};
}

/** Slide ▸ Center Split: A splits into four quarters that slide to the corners. */
export const CENTER_SPLIT = defineShaderTransition({
	id: 'jasper.center-split',
	label: 'Center Split',
	bin,
	description: 'The outgoing clip splits into four quarters that slide out to the corners, revealing the incoming clip.',
	keywords: ['split', 'quarters', 'corners', 'open'],
	options: OPTIONS,
	gpu: { passes: [splitPass('vec2(1.0)')] },
});

/** Slide ▸ Split: A splits into two halves that slide apart. */
export const SPLIT = defineShaderTransition({
	id: 'jasper.split',
	label: 'Split',
	bin,
	description: 'The outgoing clip splits down the middle and both halves slide apart, revealing the incoming clip.',
	keywords: ['split', 'halves', 'doors', 'open'],
	params: [selectorParam(ORIENT, 'horizontal')],
	options: OPTIONS,
	gpu: {
		uniforms: (p) => ({ u_axes: selectorVec(ORIENT, p) }),
		passes: [splitPass('u_axes')],
	},
});

/** Slide ▸ Whip: a fast whip pan from A to B with motion blur. */
export const WHIP = defineShaderTransition({
	id: 'jasper.whip',
	label: 'Whip',
	bin,
	description: 'A fast whip pan: both clips race across the frame with motion blur, the incoming one landing in place.',
	keywords: ['whip', 'pan', 'swish', 'motion blur', 'fast'],
	params: [selectorParam(DIR4, 'westToEast'), fxParam.percent('blur', 'Motion Blur', 75)],
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_TR_EASE],
				frag: /* glsl */ `
const int WH_TAPS = 32;
// The pushed pair (A ahead, B following one frame behind) at travel q.
vec4 whPair(vec2 uv, float q) {
  vec2 d = u_dir;
  vec4 a = tr_from(uv - d * q);
  vec4 b = tr_to(uv - d * (q - 1.0));
  return a + b;
}
void main() {
  float p = tr_progress();
  float q = tr_easeInOut(p);
  // Speed of the pan (frame widths per frame) sets the blur length (a 180° shutter at Motion Blur 100 %).
  float speed = (tr_easeInOut(min(p + 0.01, 1.0)) - tr_easeInOut(max(p - 0.01, 0.0))) / (min(p + 0.01, 1.0) - max(p - 0.01, 0.0));
  float len = (u_blur / 100.0) * speed / max(u_duration, 2.0) * 1.5;
  vec4 s = vec4(0.0);
  for (int i = 0; i < WH_TAPS; i++) {
    float t = (float(i) + 0.5) / float(WH_TAPS) - 0.5;
    s += whPair(v_uv, q + t * len);
  }
  fragColor = s / float(WH_TAPS);
}`,
			},
		],
	},
});

export const PREMIERE_SLIDES: readonly TransitionSpec[] = [BAND_SLIDE, CENTER_SPLIT, SLIDE, SPLIT, WHIP];

// Premiere 26 ▸ Video Transitions ▸ Animation (from Film Impact): Block, Flip, Fold, Pop, Pull, Spin, Spring and
// Travel Motion — clips moving with designed eases (back, spring, smooth) and motion blur. Part of the
// premiere-transitions family; the folder sits in MODERN_BINS.animation until the framework has an Animation bin.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition } from '../define.ts';
import { GLSL_TR_BLOCKS } from '../glsl.ts';
import { countParam, DIR4, selectorParam, selectorVec } from './common.ts';
import { FOLDER_KEYWORDS, GLSL_PR_MODERN, MODERN_BINS } from './modern-common.ts';
import { GLSL_PR_3D } from './motion3d.ts';

const bin = MODERN_BINS.animation;
const kw = (...k: string[]) => [...k, ...FOLDER_KEYWORDS.animation, 'film impact'];
const blurParam = (def = 50) => fxParam.percent('blur', 'Motion Blur', def);
const dirUniform = (p: EffectParams) => ({ u_dir: selectorVec(DIR4, p) });
/** Scene layout of a direction for the 3D chunk (`u_swap`: vertical motion, `u_flip`: mirrored). */
const layout3d = (p: EffectParams) => {
	const d = selectorVec(DIR4, p);
	return { u_swap: d[1] !== 0, u_flip: d[0] + d[1] < 0 };
};

const SPEED = /* glsl */ `
float pmSpeed(float p) {
  float a = max(p - 0.01, 0.0), b = min(p + 0.01, 1.0);
  return (tr_easeInOut(b) - tr_easeInOut(a)) / max(b - a, 1e-4) / max(u_duration, 2.0);
}`;

/** Animation ▸ Block Motion: the frame breaks into blocks; each one pushes B in, in a wave across the frame. */
export const BLOCK_MOTION = defineShaderTransition({
	id: 'jasper.block-motion',
	label: 'Block Motion',
	bin,
	description:
		'The frame breaks into blocks that each slide the incoming clip in, one after another in a wave across the frame.',
	keywords: kw('blocks', 'grid', 'tiles', 'slide'),
	params: [
		selectorParam(DIR4, 'westToEast'),
		countParam('columns', 'Columns', 6),
		countParam('rows', 'Rows', 4),
		fxParam.percent('stagger', 'Stagger', 60),
	],
	gpu: {
		uniforms: dirUniform,
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_TR_BLOCKS],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 grid = vec2(max(1.0, floor(u_columns + 0.5)), max(1.0, floor(u_rows + 0.5)));
  vec2 g = clamp(v_uv, 0.0, 0.99999) * grid;
  vec2 cell = floor(g);
  vec2 f = pm_toAxes(fract(g), u_dir);
  // Blocks ahead in the direction of motion start first, with a little randomness.
  float along = pm_toAxes((cell + 0.5) / grid, u_dir).x;
  float t0 = clamp((1.0 - along) * 0.8 + 0.2 * tr_cellRandom(ivec2(cell), u_seed), 0.0, 1.0);
  float st = clamp(u_stagger / 100.0, 0.0, 0.9);
  float cp = tr_easeInOut(tr_stagger(p, t0, 1.0 - st));
  // Each block shrinks a little while it moves (gaps open between the blocks).
  float s = 1.0 - 0.12 * pm_bump(cp);
  vec2 l = (f - 0.5) / s + 0.5;
  vec4 c = vec4(0.0);
  if (all(greaterThanEqual(l, vec2(0.0))) && all(lessThanEqual(l, vec2(1.0)))) {
    float x = l.x - cp;
    vec2 la = vec2(x >= 0.0 ? x : x + 1.0, l.y);
    vec2 uv = (cell + pm_fromAxes(la, u_dir)) / grid;
    c = x >= 0.0 ? tr_from(uv) : tr_to(uv);
  }
  fragColor = c;
}`,
			},
		],
	},
});

/** Animation ▸ Flip Motion: the frame flips over like a card, pulling back as it turns. */
export const FLIP_MOTION = defineShaderTransition({
	id: 'jasper.flip-motion',
	label: 'Flip Motion',
	bin,
	description:
		'The outgoing clip flips over like a card — pulling back as it turns — to land as the incoming clip on its back.',
	keywords: kw('flip', 'card', 'turn', '3d'),
	params: [selectorParam(DIR4, 'westToEast'), fxParam.percent('zoom', 'Pull Back', 40)],
	gpu: {
		uniforms: layout3d,
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_3D],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float th = PM_PI * tr_easeInOut(p);
  vec2 q = pr3Screen(u_swap, u_flip);
  vec2 h = pr3Half(u_swap);
  float co = cos(th), si = sin(th);
  vec3 c = vec3(0.0, 0.0, 2.5 * (u_zoom / 100.0) * pm_bump(p));
  vec4 hit = pr3Face(q, c, vec3(si, 0.0, -co), vec3(co, 0.0, si), vec3(0.0, 1.0, 0.0), h);
  vec4 col = vec4(0.0);
  if (hit.z > 0.0 && all(greaterThanEqual(hit.xy, vec2(0.0))) && all(lessThanEqual(hit.xy, vec2(1.0)))) {
    bool front = hit.w > 0.0;
    vec2 f = front ? hit.xy : vec2(1.0 - hit.x, hit.y);
    vec2 uv = pr3Uv(f, u_swap, u_flip);
    col = front ? tr_from(uv) : tr_to(uv);
    float k = clamp(8.0 * p * (1.0 - p), 0.0, 1.0);
    col *= k > 0.0 ? clamp(pr3EdgePx(hit.xy, h) / k + 0.5, 0.0, 1.0) : 1.0;
    // A little light falloff while the card is turned away.
    col.rgb *= mix(1.0, 0.75, abs(si));
  }
  fragColor = col;
}`,
			},
		],
	},
});

/** Animation ▸ Fold Motion: half of the frame folds over like paper, carrying B on its back. */
export const FOLD_MOTION = defineShaderTransition({
	id: 'jasper.fold-motion',
	label: 'Fold Motion',
	bin,
	description:
		'Half of the outgoing clip folds over the other half like a sheet of paper; the incoming clip is on its back and underneath.',
	keywords: kw('fold', 'paper', 'origami', 'book', '3d'),
	params: [selectorParam(DIR4, 'westToEast')],
	gpu: {
		uniforms: layout3d,
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_3D],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float th = PM_PI * tr_easeInOut(p);
  vec2 q = pr3Screen(u_swap, u_flip);
  vec2 h = pr3Half(u_swap);
  float co = cos(th), si = sin(th);
  // The flap: the −s half, hinged on the centre line, turning towards the camera and over onto the +s half.
  vec3 U = vec3(-co, 0.0, -si);
  vec3 n = vec3(si, 0.0, -co);
  vec2 hf = vec2(0.5 * h.x, h.y);
  vec4 hit = pr3Face(q, U * hf.x, n, U, vec3(0.0, 1.0, 0.0), hf);
  // Underneath: B's −s half (uncovered), A's +s half (not yet covered).
  vec2 f0 = vec2(q.x / (2.0 * h.x) + 0.5, q.y / (2.0 * h.y) + 0.5);
  vec2 uv0 = pr3Uv(f0, u_swap, u_flip);
  vec4 col = q.x < 0.0 ? tr_to(uv0) : tr_from(uv0) * vec4(vec3(1.0 - 0.3 * si), 1.0);
  if (hit.z > 0.0 && all(greaterThanEqual(hit.xy, vec2(0.0))) && all(lessThanEqual(hit.xy, vec2(1.0)))) {
    bool front = hit.w > 0.0;
    // Front: A's −s half (hinge at f.x = 0); back: B's +s half.
    vec2 f = vec2(front ? 0.5 - 0.5 * hit.x : 0.5 + 0.5 * hit.x, hit.y);
    vec4 flap = front ? tr_from(pr3Uv(f, u_swap, u_flip)) : tr_to(pr3Uv(f, u_swap, u_flip));
    flap.rgb *= front ? 0.65 + 0.35 * co : 0.65 - 0.35 * co;
    col = tr_over(flap, col);
  }
  fragColor = col;
}`,
			},
		],
	},
});

/** Animation ▸ Pop Motion: A pops away (anticipation, then gone), B pops in with an overshoot. */
export const POP_MOTION = defineShaderTransition({
	id: 'jasper.pop-motion',
	label: 'Pop Motion',
	bin,
	description:
		'The outgoing clip pops away — a little anticipation, then gone — and the incoming clip pops in with an overshoot.',
	keywords: kw('pop', 'scale', 'bounce', 'snap'),
	params: [fxParam.percent('overshoot', 'Overshoot', 40)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float c1 = 1.70158 * u_overshoot / 40.0;
  float c3 = c1 + 1.0;
  vec4 col;
  if (p < 0.5) {
    float t = 2.0 * p;
    float s = 1.0 - (c3 * t * t * t - c1 * t * t);
    col = s > 1e-3 ? tr_from((v_uv - 0.5) / s + 0.5) : vec4(0.0);
  } else {
    float t = 2.0 * p - 1.0 - 1.0;
    float s = 1.0 + c3 * t * t * t + c1 * t * t;
    col = s > 1e-3 ? tr_to((v_uv - 0.5) / s + 0.5) : vec4(0.0);
  }
  fragColor = col;
}`,
			},
		],
	},
});

/** Animation ▸ Pull Motion: the camera pulls back, pans to B beside A and pushes in. */
export const PULL_MOTION = defineShaderTransition({
	id: 'jasper.pull-motion',
	label: 'Pull Motion',
	bin,
	description:
		'The view pulls back from the outgoing clip, glides over to the incoming clip waiting beside it and pushes in.',
	keywords: kw('pull', 'zoom out', 'pan', 'camera'),
	params: [selectorParam(DIR4, 'westToEast'), fxParam.percent('zoom', 'Pull Back', 45), blurParam(40)],
	gpu: {
		uniforms: dirUniform,
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `${SPEED}
const float PL_GAP = 0.06;
vec4 plAt(vec2 c) {
  if (c.y < 0.0 || c.y > 1.0) return vec4(0.0);
  if (c.x >= 0.0) return c.x <= 1.0 ? tr_from(pm_fromAxes(c, u_dir)) : vec4(0.0);
  float u = c.x + 1.0 + PL_GAP;
  return u >= 0.0 && u <= 1.0 ? tr_to(pm_fromAxes(vec2(u, c.y), u_dir)) : vec4(0.0);
}
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  float z = 1.0 - clamp(u_zoom / 100.0, 0.0, 0.9) * pm_bump(p);
  float pan = tr_easeInOut(p) * (1.0 + PL_GAP);
  vec2 c = (q - 0.5) / z + 0.5 - vec2(pan, 0.0);
  float L = (u_blur / 100.0) * pmSpeed(p) * (1.0 + PL_GAP) * 1.5;
  vec4 col = vec4(0.0);
  for (int i = 0; i < 12; i++) col += plAt(c + vec2(L * ((float(i) + 0.5) / 12.0 - 0.5), 0.0));
  fragColor = col / 12.0;
}`,
			},
		],
	},
});

/** Animation ▸ Spin Motion: A spins up with a spin blur, B spins down into place. */
export const SPIN_MOTION = defineShaderTransition({
	id: 'jasper.spin-motion',
	label: 'Spin Motion',
	bin,
	description: 'The outgoing clip spins up with a spin blur and the incoming clip spins down into place.',
	keywords: kw('spin', 'rotate', 'twirl', 'swirl'),
	params: [fxParam.angle('rotation', 'Rotation', 360), fxParam.percent('zoom', 'Zoom', 20), blurParam(60)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `${SPEED}
vec4 spAt(int side, float a, float s) {
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 v = (v_uv - 0.5) * asp / s;
  float c = cos(a), si = sin(a);
  vec2 r = vec2(c * v.x + si * v.y, -si * v.x + c * v.y) / asp + 0.5;
  return pm_sideMirrored(side, r);
}
void main() {
  float p = tr_progress();
  float total = radians(u_rotation);
  float a = total * tr_easeInOut(p);
  float s = 1.0 + (u_zoom / 100.0) * pm_bump(p);
  float L = (u_blur / 100.0) * pmSpeed(p) * abs(total) * 1.5;
  float k = pm_switch(p, 0.04);
  vec4 A = vec4(0.0), B = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float o = L * ((float(i) + 0.5) / 12.0 - 0.5) * sign(total);
    if (k < 1.0) A += spAt(0, a + o, s);
    if (k > 0.0) B += spAt(1, a + o - total, s);
  }
  fragColor = mix(A, B, k) / 12.0;
}`,
			},
		],
	},
});

/** Animation ▸ Spring Motion: B springs in over A, overshooting and settling. */
export const SPRING_MOTION = defineShaderTransition({
	id: 'jasper.spring-motion',
	label: 'Spring Motion',
	bin,
	description:
		'The incoming clip springs in over the outgoing clip, overshoots and bounces before it settles.',
	keywords: kw('spring', 'bounce', 'elastic', 'slide'),
	params: [
		selectorParam(DIR4, 'westToEast'),
		fxParam.percent('bounce', 'Bounce', 50),
		countParam('bounces', 'Bounces', 2, 8),
	],
	gpu: {
		uniforms: dirUniform,
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
// A damped spring from 0 to 1 that ends exactly at 1 (the cosine is at a zero there).
float spSpring(float p) {
  float w = PM_PI * (0.5 + floor(u_bounces + 0.5));
  float d = mix(9.0, 2.0, clamp(u_bounce / 100.0, 0.0, 1.0));
  return 1.0 - exp(-d * p) * cos(w * p);
}
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  float x = q.x + 1.0 - spSpring(p);
  fragColor = x >= 0.0 && x <= 1.0 ? tr_over(tr_to(pm_fromAxes(vec2(x, q.y), u_dir)), tr_from(v_uv)) : tr_from(v_uv);
}`,
			},
		],
	},
});

/** Animation ▸ Travel Motion: A slides out as B pushes in, both easing and pulling back slightly on the way. */
export const TRAVEL_MOTION = defineShaderTransition({
	id: 'jasper.travel-motion',
	label: 'Travel Motion',
	bin,
	description:
		'The outgoing clip slides out as the incoming clip pushes in, both easing and shrinking slightly on the way, with motion blur.',
	keywords: kw('travel', 'push', 'slide', 'move'),
	params: [selectorParam(DIR4, 'westToEast'), fxParam.percent('scale', 'Scale', 85), blurParam(60)],
	gpu: {
		uniforms: dirUniform,
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `${SPEED}
const float TV_GAP = 0.04;
vec4 tvAt(vec2 c) {
  if (c.y < 0.0 || c.y > 1.0) return vec4(0.0);
  if (c.x >= 0.0) return c.x <= 1.0 ? tr_from(pm_fromAxes(c, u_dir)) : vec4(0.0);
  float u = c.x + 1.0 + TV_GAP;
  return u >= 0.0 && u <= 1.0 ? tr_to(pm_fromAxes(vec2(u, c.y), u_dir)) : vec4(0.0);
}
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  float s = 1.0 - (1.0 - clamp(u_scale / 100.0, 0.1, 1.0)) * pm_bump(p);
  float tr = tr_easeInOut(p) * (1.0 + TV_GAP);
  vec2 c = (q - 0.5) / s + 0.5 - vec2(tr, 0.0);
  float L = (u_blur / 100.0) * pmSpeed(p) * (1.0 + TV_GAP) * 1.5;
  vec4 col = vec4(0.0);
  for (int i = 0; i < 12; i++) col += tvAt(c + vec2(L * ((float(i) + 0.5) / 12.0 - 0.5), 0.0));
  fragColor = col / 12.0;
}`,
			},
		],
	},
});

export const MODERN_ANIMATION: readonly TransitionSpec[] = [
	BLOCK_MOTION,
	FLIP_MOTION,
	FOLD_MOTION,
	POP_MOTION,
	PULL_MOTION,
	SPIN_MOTION,
	SPRING_MOTION,
	TRAVEL_MOTION,
];

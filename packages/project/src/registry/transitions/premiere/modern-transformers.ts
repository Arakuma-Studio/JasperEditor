// Premiere 26 ▸ Video Transitions ▸ Transformers (from Film Impact): 3D Spin, Frame, Louver, Mirror, Slice and Wave.
// (Page Peel, also in that folder in Premiere 26, is the classic one in ./page.ts.) Part of the premiere-transitions
// family; the folder sits in MODERN_BINS.transformers until the framework has a Transformers bin.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition } from '../define.ts';
import { GLSL_TR_BLOCKS } from '../glsl.ts';
import { countParam, DIR4, ORIENT, selectorParam, selectorVec } from './common.ts';
import { FOLDER_KEYWORDS, GLSL_PR_MODERN, MODERN_BINS } from './modern-common.ts';
import { GLSL_PR_3D } from './motion3d.ts';

const bin = MODERN_BINS.transformers;
const kw = (...k: string[]) => [...k, ...FOLDER_KEYWORDS.transformers, 'film impact'];
const orientLayout = (p: EffectParams, name = 'direction') => ({
	u_swap: selectorVec(ORIENT, p, name)[1] !== 0,
});

/** Transformers ▸ 3D Spin: the frame spins around in 3D, pulling back, and lands as B. */
export const SPIN_3D = defineShaderTransition({
	id: 'jasper.3d-spin',
	label: '3D Spin',
	bin,
	description:
		'The outgoing clip spins around in 3D space — pulling back and blurring — and comes to rest as the incoming clip on its other side.',
	keywords: kw('3d', 'spin', 'rotate', 'turn', 'card'),
	params: [
		selectorParam(ORIENT, 'horizontal'),
		fxParam.number('spins', 'Extra Spins', 1, { min: 0, max: 10, step: 1 }),
		fxParam.percent('zoom', 'Pull Back', 50),
		fxParam.percent('blur', 'Motion Blur', 50),
	],
	gpu: {
		uniforms: (p) => orientLayout(p),
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_3D],
				frag: /* glsl */ `
vec4 s3Card(vec2 q, vec2 h, float th, float z) {
  float co = cos(th), si = sin(th);
  vec4 hit = pr3Face(q, vec3(0.0, 0.0, z), vec3(si, 0.0, -co), vec3(co, 0.0, si), vec3(0.0, 1.0, 0.0), h);
  if (hit.z <= 0.0 || any(lessThan(hit.xy, vec2(0.0))) || any(greaterThan(hit.xy, vec2(1.0)))) return vec4(0.0);
  bool front = hit.w > 0.0;
  vec2 f = front ? hit.xy : vec2(1.0 - hit.x, hit.y);
  vec2 uv = pr3Uv(f, u_swap, false);
  vec4 c = front ? tr_from(uv) : tr_to(uv);
  c.rgb *= mix(1.0, 0.7, abs(si));
  return c;
}
void main() {
  float p = tr_progress();
  float total = PM_PI * (1.0 + 2.0 * floor(max(u_spins, 0.0) + 0.5));
  vec2 q = pr3Screen(u_swap, false);
  vec2 h = pr3Half(u_swap);
  // The real spin over the shutter (Motion Blur % of a frame): the card's edges sweep up to ~its half width per radian.
  float hs = pm_shutter(p, u_blur, 1.0);
  float ext = total * abs(tr_easeInOut(p + hs) - tr_easeInOut(p - hs)) * 0.75 * max(u_compSize.x, u_compSize.y);
  int n = fx_mbTapCount(ext, 64);
  float j = fx_mbJitterFor(ext, n);
  vec4 c = vec4(0.0);
  for (int i = 0; i < fx_mbDyn(64); i++) {
    if (i >= n) break;
    float qq = mix(p - hs, p + hs, fx_mbTapAt(i, n, j));
    c += s3Card(q, h, total * tr_easeInOut(qq), 3.0 * (u_zoom / 100.0) * pm_bump(qq));
  }
  fragColor = c / float(n);
}`,
			},
		],
	},
});

/** Transformers ▸ 3D Spinback: A whips round edge-on in 3D; B spins back in from the other side and settles. */
export const SPINBACK_3D = defineShaderTransition({
	id: 'jasper.3d-spinback',
	label: '3D Spinback',
	bin,
	description:
		'A stylized 3D spin: the outgoing clip whips round until it is edge-on, then the incoming clip spins back in from the other side with motion blur and settles, with an optional overshoot.',
	keywords: kw('3d', 'spin', 'spinback', 'rotate', 'whip'),
	params: [
		selectorParam(ORIENT, 'horizontal'),
		fxParam.choice('easing', 'Easing', ['smooth', 'overshoot'], ['Smooth', 'Overshoot'], 'overshoot'),
		fxParam.percent('blur', 'Motion Blur', 60),
	],
	gpu: {
		uniforms: (p) => orientLayout(p),
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_3D],
				frag: /* glsl */ `
// Card angle at progress p: A turns 0 → 90° (accelerating), B turns −90° → 0 (decelerating, optionally overshooting).
float sbAngle(float p) {
  if (p < 0.5) return 0.5 * PM_PI * tr_easeIn(2.0 * p);
  float t = 2.0 * p - 1.0;
  float e = 1.0 - pow(1.0 - t, 3.0);
  if (u_easing == 1) {
    float c1 = 1.4, c3 = c1 + 1.0;
    float u = t - 1.0;
    e = 1.0 + c3 * u * u * u + c1 * u * u;
  }
  return -0.5 * PM_PI * (1.0 - e);
}
vec4 sbCard(vec2 q, vec2 h, float th, bool isB) {
  float co = cos(th), si = sin(th);
  vec4 hit = pr3Face(q, vec3(0.0), vec3(si, 0.0, -co), vec3(co, 0.0, si), vec3(0.0, 1.0, 0.0), h);
  if (hit.z <= 0.0 || hit.w <= 0.0 || any(lessThan(hit.xy, vec2(0.0))) || any(greaterThan(hit.xy, vec2(1.0)))) return vec4(0.0);
  vec2 uv = pr3Uv(hit.xy, u_swap, false);
  vec4 c = isB ? tr_to(uv) : tr_from(uv);
  c.rgb *= mix(1.0, 0.65, abs(si));
  return c;
}
void main() {
  float p = tr_progress();
  vec2 q = pr3Screen(u_swap, false);
  vec2 h = pr3Half(u_swap);
  bool isB = p >= 0.5;
  // The real (eased, overshooting) turn over the shutter, kept within the card's half of the transition.
  float hs = pm_shutter(p, u_blur, 1.0);
  float lo = max(p - hs, isB ? 0.5 : 0.0), hi = min(p + hs, isB ? 1.0 : 0.4999);
  float ext = (abs(sbAngle(hi) - sbAngle(p)) + abs(sbAngle(p) - sbAngle(lo))) * 0.75 * max(u_compSize.x, u_compSize.y);
  int n = fx_mbTapCount(ext, 64);
  float j = fx_mbJitterFor(ext, n);
  vec4 c = vec4(0.0);
  for (int i = 0; i < fx_mbDyn(64); i++) {
    if (i >= n) break;
    c += sbCard(q, h, n > 1 ? sbAngle(mix(lo, hi, fx_mbTapAt(i, n, j))) : sbAngle(p), isB);
  }
  fragColor = c / float(n);
}`,
			},
		],
	},
});

/** Transformers ▸ Frame: A shrinks into a framed picture that slides away; B slides in framed and grows. */
export const FRAME_TRANSITION = defineShaderTransition({
	id: 'jasper.frame-transition',
	label: 'Frame',
	bin,
	description:
		'The outgoing clip shrinks into a framed picture and slides away; the incoming clip slides in framed and grows to fill the screen.',
	keywords: kw('frame', 'border', 'picture', 'card', 'slide', 'scale'),
	params: [
		selectorParam(DIR4, 'eastToWest'),
		fxParam.percent('scale', 'Scale', 70),
		fxParam.pixels('frameWidth', 'Frame Width', 12, 100),
		fxParam.color('frameColor', 'Frame Color', [1, 1, 1, 1]),
		fxParam.color('background', 'Background', [0.08, 0.08, 0.09, 1]),
	],
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
const float FM_GAP = 0.18;
// The two framed cards at content position c (A on [0, 1], B on [−1 − gap, −gap] along the motion).
vec4 fmCards(vec2 c, float fw, float fa) {
  vec2 S = pm_axesSize(u_dir);
  vec2 fwq = vec2(fw / S.x, fw / S.y);
  float u = c.x >= -0.5 * FM_GAP ? c.x : c.x + 1.0 + FM_GAP;
  bool isA = c.x >= -0.5 * FM_GAP;
  vec2 l = vec2(u, c.y);
  if (all(greaterThanEqual(l, vec2(0.0))) && all(lessThanEqual(l, vec2(1.0))))
    return isA ? tr_from(pm_fromAxes(l, u_dir)) : tr_to(pm_fromAxes(l, u_dir));
  if (all(greaterThanEqual(l, -fwq)) && all(lessThanEqual(l, 1.0 + fwq))) return tr_premul(u_frameColor) * fa;
  return vec4(0.0);
}
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  float hold = smoothstep(0.0, 0.3, p) * (1.0 - smoothstep(0.7, 1.0, p));
  float s = 1.0 - (1.0 - clamp(u_scale / 100.0, 0.1, 1.0)) * hold;
  float slide = tr_easeInOut(clamp((p - 0.3) / 0.4, 0.0, 1.0)) * (1.0 + FM_GAP);
  vec2 c = (q - 0.5) / s + 0.5 - vec2(slide, 0.0);
  float fw = u_frameWidth / s;
  vec4 col = vec4(0.0);
  float speed = p > 0.3 && p < 0.7 ? 1.0 : 0.0;
  for (int i = 0; i < 6; i++) col += fmCards(c + vec2(0.02 * speed * pm_bump((p - 0.3) / 0.4) * ((float(i) + 0.5) / 6.0 - 0.5), 0.0), fw, hold);
  col /= 6.0;
  float bg = smoothstep(0.0, 0.08, p) * (1.0 - smoothstep(0.92, 1.0, p));
  fragColor = tr_over(col, tr_premul(u_background) * bg);
}`,
			},
		],
	},
});

/** Transformers ▸ Louver: slats turn over one after another, B on their backs. */
export const LOUVER = defineShaderTransition({
	id: 'jasper.louver',
	label: 'Louver',
	bin,
	description:
		'The frame is cut into slats that turn over one after another, like louvers, showing the incoming clip on their backs.',
	keywords: kw('louver', 'blinds', 'slats', 'shutters', '3d'),
	params: [
		fxParam.choice('slatAxis', 'Slats', ['horizontal', 'vertical'], ['Horizontal', 'Vertical'], 'horizontal'),
		countParam('slats', 'Slats Count', 8, 64),
		fxParam.percent('stagger', 'Stagger', 50),
		fxParam.color('fillColor', 'Fill Color', [0, 0, 0, 1]),
	],
	gpu: {
		uniforms: (p) => ({ u_swap: String(p.slatAxis) !== 'vertical' }),
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_3D, GLSL_TR_BLOCKS],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 q = pr3Screen(u_swap, false);
  vec2 h = pr3Half(u_swap);
  float n = max(1.0, floor(u_slats + 0.5));
  float bw = 2.0 * h.x / n;
  vec2 hb = vec2(0.5 * bw, h.y);
  float st = clamp(u_stagger / 100.0, 0.0, 0.95);
  float i0 = floor((q.x + h.x) / bw);
  vec4 best = vec4(0.0);
  float bestT = 1e9;
  for (int j = -1; j <= 1; j++) {
    float i = i0 + float(j);
    if (i < 0.0 || i > n - 1.0) continue;
    float th = PM_PI * tr_easeInOut(tr_stagger(p, n > 1.0 ? i / (n - 1.0) : 0.0, 1.0 - st));
    float co = cos(th), si = sin(th);
    vec4 hit = pr3Face(q, vec3(-h.x + (i + 0.5) * bw, 0.0, 0.0), vec3(si, 0.0, -co), vec3(co, 0.0, si), vec3(0.0, 1.0, 0.0), hb);
    if (hit.z <= 0.0 || hit.z >= bestT || any(lessThan(hit.xy, vec2(0.0))) || any(greaterThan(hit.xy, vec2(1.0)))) continue;
    bool front = hit.w > 0.0;
    vec2 f = vec2((i + (front ? hit.x : 1.0 - hit.x)) / n, hit.y);
    vec2 uv = u_swap ? f.yx : f;
    vec4 col = front ? tr_from(uv) : tr_to(uv);
    col.rgb *= mix(1.0, 0.55, abs(si));
    best = col;
    bestT = hit.z;
  }
  // The gaps between turning slats show the fill (faded at the ends so the first / last frames are A / B).
  float fill = smoothstep(0.0, 0.08, p) * (1.0 - smoothstep(0.92, 1.0, p));
  fragColor = tr_over(best, tr_premul(u_fillColor) * fill);
}`,
			},
		],
	},
});

/** Transformers ▸ Mirror: the picture multiplies into mirrored reflections through the cut. */
export const MIRROR_TRANSITION = defineShaderTransition({
	id: 'jasper.mirror-transition',
	label: 'Mirror',
	bin,
	description:
		'The picture multiplies into mirrored reflections of itself, changes to the incoming clip and folds back to one image.',
	keywords: kw('mirror', 'reflection', 'tile', 'symmetry', 'repeat'),
	params: [
		fxParam.number('tiles', 'Reflections', 3, { min: 1, max: 12, step: 0.1 }),
		fxParam.choice(
			'mode',
			'Mode',
			['both', 'horizontal', 'vertical'],
			['Both', 'Horizontal', 'Vertical'],
			'both',
		),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float z = 1.0 + (max(u_tiles, 1.0) - 1.0) * tr_easeInOutSine(pm_bump(p));
  vec2 zv = u_mode == 0 ? vec2(z) : u_mode == 1 ? vec2(z, 1.0) : vec2(1.0, z);
  vec2 uv = (v_uv - 0.5) * zv + 0.5;
  fragColor = mix(pm_sideMirrored(0, uv), pm_sideMirrored(1, uv), pm_switch(p, 0.15));
}`,
			},
		],
	},
});

/** Transformers ▸ Slice: the frame is cut into slanted slices that slide away in alternate directions. */
export const SLICE_TRANSITION = defineShaderTransition({
	id: 'jasper.slice-transition',
	label: 'Slice',
	bin,
	description:
		'The frame is cut into slanted slices that slide out one after another in alternate directions, pushing the incoming clip in.',
	keywords: kw('slice', 'cut', 'strips', 'shift', 'slide'),
	params: [
		countParam('slices', 'Slices', 6, 64),
		fxParam.angle('angle', 'Angle', 30),
		fxParam.percent('stagger', 'Stagger', 50),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_TR_BLOCKS],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 dir = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 rel = tr_px() - 0.5 * u_compSize;
  float ext = 0.5 * dot(abs(dir), u_compSize);
  float extP = 0.5 * dot(abs(perp), u_compSize);
  float n = max(1.0, floor(u_slices + 0.5));
  float k = floor(clamp((dot(rel, perp) + extP) / (2.0 * extP), 0.0, 0.99999) * n);
  float sg = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
  vec2 d = dir * sg;
  float st = clamp(u_stagger / 100.0, 0.0, 0.95);
  float cp = tr_easeInOut(tr_stagger(p, n > 1.0 ? k / (n - 1.0) : 0.0, 1.0 - st));
  float L = 2.0 * ext;
  float o = cp * L;
  float u = dot(rel, d);
  vec2 src = u >= -ext + o ? rel - d * o : rel - d * (o - L);
  vec2 uv = (src + 0.5 * u_compSize) / u_compSize;
  fragColor = u >= -ext + o ? pm_sideMirrored(0, uv) : pm_sideMirrored(1, uv);
}`,
			},
		],
	},
});

/** Transformers ▸ Wave: a wave runs across the frame, rippling the picture; behind it is B. */
export const WAVE_TRANSITION = defineShaderTransition({
	id: 'jasper.wave-transition',
	label: 'Wave',
	bin,
	description:
		'A wave runs across the frame, rippling the picture as it passes; behind it the incoming clip has taken over.',
	keywords: kw('wave', 'ripple', 'water', 'distort', 'wobble'),
	params: [
		selectorParam(DIR4, 'westToEast'),
		fxParam.pixels('amplitude', 'Amplitude', 30, 300),
		fxParam.pixels('wavelength', 'Wavelength', 120, 1000),
		fxParam.percent('width', 'Wave Width', 30),
	],
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  vec2 S = pm_axesSize(u_dir);
  float w = max(u_width / 100.0, 0.02);
  float f = mix(-3.0 * w, 1.0 + 3.0 * w, p);
  float env = exp(-pow((q.x - f) / w, 2.0)) * min(1.0, 4.0 * pm_bump(p));
  float ph = 6.2831853 * q.x * S.x / max(u_wavelength, 4.0) - 10.0 * p;
  // Ripple along and across the motion.
  vec2 disp = vec2(sin(ph), 0.5 * cos(1.3 * ph)) * u_amplitude * env / S;
  vec2 uv = pm_fromAxes(q + disp, u_dir);
  float k = smoothstep(f + 0.02, f - 0.02, q.x);
  fragColor = mix(pm_sideMirrored(0, uv), pm_sideMirrored(1, uv), k);
}`,
			},
		],
	},
});

export const MODERN_TRANSFORMERS: readonly TransitionSpec[] = [
	SPIN_3D,
	SPINBACK_3D,
	FRAME_TRANSITION,
	LOUVER,
	MIRROR_TRANSITION,
	SLICE_TRANSITION,
	WAVE_TRANSITION,
];

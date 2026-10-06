// Premiere 26 ▸ Video Transitions ▸ Wipe — the modern entries (from Film Impact): Linear Wipe, Neon Wipe, Panel Wipe,
// Plateau Wipe, Soft Wipe, Star Wipe and Stretch Wipe. (Its Clock Wipe and Radial Wipe share their names with the
// classic ones in ./wipe.ts, which are kept.) Part of the premiere-transitions family.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_BLOCKS, GLSL_TR_WIPE } from '../glsl.ts';
import { countParam, DIR4, defineEdgeWipe, num, selectorParam, selectorVec } from './common.ts';
import { blurLevelPasses, GLSL_PR_BLUR_LEVELS, GLSL_PR_MODERN } from './modern-common.ts';
import { GLSL_PR_3D } from './motion3d.ts';

const bin = TRANSITION_BINS.wipe;
const kw = (...k: string[]) => [...k, 'film impact'];
const angleDir = (p: EffectParams) => {
	const a = (num(p.angle, 0) * Math.PI) / 180;
	return { u_dir: [Math.cos(a), Math.sin(a)] as [number, number] };
};

/** Wipe ▸ Linear Wipe: a straight, feathered edge at any angle. */
export const LINEAR_WIPE_TRANSITION = defineShaderTransition({
	id: 'jasper.linear-wipe-transition',
	label: 'Linear Wipe',
	bin,
	description: 'The incoming clip is revealed by a straight wipe at any angle, with a feathered edge.',
	keywords: kw('linear', 'wipe', 'feather', 'soft edge', 'angle'),
	params: [fxParam.angle('angle', 'Angle', 0), fxParam.pixels('feather', 'Feather', 40, 1000)],
	gpu: {
		uniforms: angleDir,
		passes: [
			{
				include: [GLSL_TR_WIPE],
				frag: /* glsl */ `
void main() {
  float f = max(u_feather, 0.0);
  float d = tr_linearWipe(tr_px(), u_dir, tr_progress(), 0.5 * f + 1.0);
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), tr_edge(d, f, 1.0));
}`,
			},
		],
	},
});

/** Wipe ▸ Neon Wipe: the wipe edge is a glowing neon line. */
export const NEON_WIPE = defineShaderTransition({
	id: 'jasper.neon-wipe',
	label: 'Neon Wipe',
	bin,
	description: 'The incoming clip wipes in behind a glowing neon line.',
	keywords: kw('neon', 'glow', 'line', 'wipe', 'light'),
	params: [
		fxParam.angle('angle', 'Angle', 0),
		fxParam.color('color', 'Color', [0.2, 0.9, 1, 1]),
		fxParam.pixels('width', 'Line Width', 6, 100),
		fxParam.pixels('glow', 'Glow', 40, 400),
		fxParam.percent('intensity', 'Intensity', 100),
	],
	gpu: {
		uniforms: angleDir,
		passes: [
			{
				include: [GLSL_TR_WIPE, GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float g = max(u_glow, 1.0);
  float d = tr_linearWipe(tr_px(), u_dir, p, 0.5 * u_width + 2.0);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), tr_edge(d, 0.0, 1.0));
  float core = exp(-pow(d / max(0.5 * u_width, 0.5), 2.0));
  float halo = exp(-abs(d) / g);
  vec3 light = u_color.rgb * (0.9 * halo + 1.2 * core) + vec3(0.8 * core);
  // The light fades in and out at the ends so the first / last frames are exactly A / B.
  fragColor = pm_addLight(base, light * (u_intensity / 100.0) * min(1.0, 6.0 * pm_bump(p)));
}`,
			},
		],
	},
});

/** Wipe ▸ Panel Wipe: panels of B slide across one after another. */
export const PANEL_WIPE = defineShaderTransition({
	id: 'jasper.panel-wipe',
	label: 'Panel Wipe',
	bin,
	description:
		'Panels carrying the incoming clip slide across the frame one after another, each casting a soft shadow.',
	keywords: kw('panel', 'panels', 'slide', 'sliding doors', 'wipe'),
	params: [
		selectorParam(DIR4, 'westToEast'),
		countParam('panels', 'Panels', 4, 32),
		fxParam.percent('stagger', 'Stagger', 50),
	],
	gpu: {
		uniforms: (p) => ({ u_dir: selectorVec(DIR4, p) }),
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_TR_BLOCKS],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 q = pm_toAxes(v_uv, u_dir);
  vec2 S = pm_axesSize(u_dir);
  float n = max(1.0, floor(u_panels + 0.5));
  float k = floor(clamp(q.y, 0.0, 0.99999) * n);
  float st = clamp(u_stagger / 100.0, 0.0, 0.95);
  float cp = tr_easeInOut(tr_stagger(p, n > 1.0 ? k / (n - 1.0) : 0.0, 1.0 - st));
  // The panel's leading edge runs from 0 to 1 (+ the shadow length) along the motion; B rides on it.
  float sh = 24.0 / S.x;
  float lead = cp;
  float x = q.x - lead + 1.0;
  vec4 a = tr_from(v_uv);
  if (x >= 0.0 && x <= 1.0) fragColor = tr_to(pm_fromAxes(vec2(x, q.y), u_dir));
  else {
    // Soft shadow ahead of the panel.
    float ahead = (q.x - lead) / sh;
    float shadow = ahead > 0.0 && cp > 0.0 && cp < 1.0 ? 0.45 * exp(-ahead * 3.0) : 0.0;
    fragColor = vec4(a.rgb * (1.0 - shadow), a.a);
  }
}`,
			},
		],
	},
});

/** Wipe ▸ Plateau Wipe: A falls back flat like a lid, B rises up from flat. */
export const PLATEAU_WIPE = defineShaderTransition({
	id: 'jasper.plateau-wipe',
	label: 'Plateau Wipe',
	bin,
	description:
		'The outgoing clip falls back flat onto a plateau, hinged on one edge, and the incoming clip unfolds up from it.',
	keywords: kw('plateau', 'fall', 'tilt', 'hinge', '3d', 'unfold'),
	params: [selectorParam(DIR4, 'northToSouth'), fxParam.color('background', 'Background', [0, 0, 0, 1])],
	gpu: {
		uniforms: (p) => {
			const d = selectorVec(DIR4, p);
			return { u_swap: d[1] !== 0, u_flip: d[0] + d[1] < 0 };
		},
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_3D],
				frag: /* glsl */ `
// A card hinged on its leading (+s) edge, tilted back by t radians (0 = in the frame, π/2 = flat, away from view).
vec4 plCard(vec2 q, vec2 h, float t, bool isB) {
  vec3 U = vec3(-cos(t), 0.0, sin(t));
  vec3 n = vec3(-sin(t), 0.0, -cos(t));
  vec4 hit = pr3Face(q, vec3(h.x, 0.0, 0.0) + U * h.x, n, U, vec3(0.0, 1.0, 0.0), h);
  if (hit.z <= 0.0 || hit.w <= 0.0 || any(lessThan(hit.xy, vec2(0.0))) || any(greaterThan(hit.xy, vec2(1.0)))) return vec4(0.0);
  vec2 uv = pr3Uv(vec2(1.0 - hit.x, hit.y), u_swap, u_flip);
  vec4 c = isB ? tr_to(uv) : tr_from(uv);
  return vec4(c.rgb * (0.55 + 0.45 * cos(t)), c.a);
}
void main() {
  float p = tr_progress();
  vec2 q = pr3Screen(u_swap, u_flip);
  vec2 h = pr3Half(u_swap);
  // A falls back flat onto the plateau, then B unfolds from it — both hinged on the same edge.
  float ta = 0.5 * PM_PI * tr_easeIn(clamp(2.0 * p, 0.0, 1.0));
  float tb = 0.5 * PM_PI * (1.0 - tr_easeOut(clamp(2.0 * p - 1.0, 0.0, 1.0)));
  vec4 a = p < 0.5 ? plCard(q, h, ta, false) : vec4(0.0);
  vec4 b = p >= 0.5 ? plCard(q, h, tb, true) : vec4(0.0);
  // The background behind the cards (faded at the ends so the first / last frames are exactly A / B).
  float bg = smoothstep(0.0, 0.08, p) * (1.0 - smoothstep(0.92, 1.0, p));
  fragColor = tr_over(tr_over(b, a), tr_premul(u_background) * bg);
}`,
			},
		],
	},
});

/** Wipe ▸ Soft Wipe: a broad, out-of-focus wipe — the edge region is defocused like a lens. */
export const SOFT_WIPE = defineShaderTransition({
	id: 'jasper.soft-wipe',
	label: 'Soft Wipe',
	bin,
	description:
		'A broad, out-of-focus wipe: the region around the moving edge is defocused like a lens as the clips trade places.',
	keywords: kw('soft', 'wipe', 'defocus', 'blur', 'feather'),
	params: [
		fxParam.angle('angle', 'Angle', 0),
		fxParam.pixels('softness', 'Softness', 300, 2000),
		fxParam.pixels('blur', 'Blur', 40, 400),
	],
	gpu: {
		uniforms: angleDir,
		passes: (p): ShaderPass[] => {
			const mixFrag = /* glsl */ `
float swMask() {
  float f = max(u_softness, 1.0);
  return tr_edge(tr_linearWipe(tr_px(), u_dir, tr_progress(), 0.5 * f + 1.0), f, 1.0);
}`;
			return [
				{
					output: 'swMix',
					include: [GLSL_TR_WIPE],
					frag: `${mixFrag}
void main() { fragColor = mix(tr_from(v_uv), tr_to(v_uv), swMask()); }`,
				},
				...blurLevelPasses('swMix', 'swBlur', num(p.blur, 40) / 4),
				{
					include: [GLSL_TR_WIPE, GLSL_PR_BLUR_LEVELS],
					frag: `${mixFrag}
void main() {
  float m = swMask();
  vec4 sharp = mix(tr_from(v_uv), tr_to(v_uv), m);
  // Defocus peaks in the middle of the soft band.
  float amount = 1.0 - abs(2.0 * m - 1.0);
  fragColor = pm_blurLevels(sharp, texture(u_swBlur1, v_uv), texture(u_swBlur2, v_uv), texture(u_swBlur3, v_uv), amount);
}`,
				},
			];
		},
	},
});

/** Wipe ▸ Star Wipe: B appears inside a growing star. */
export const STAR_WIPE = defineEdgeWipe({
	id: 'jasper.star-wipe',
	label: 'Star Wipe',
	bin,
	description:
		'The incoming clip is revealed (or the outgoing one concealed, reversed) through a growing star shape.',
	keywords: kw('star', 'iris', 'shape', 'wipe'),
	params: [
		countParam('points', 'Points', 5, 24),
		fxParam.percent('innerRadius', 'Inner Radius', 45),
		fxParam.angle('rotation', 'Rotation', 0),
	],
	center: true,
	helpers: /* glsl */ `
// Signed distance (px, > 0 inside) to a star of outer radius r (px), n points, inner radius ri·r, the first point up.
float swStar(vec2 q, float r, float n, float ri) {
  float sector = 6.28318530718 / n;
  float a = atan(q.x, -q.y) - radians(u_rotation);
  float b = mod(a + 0.5 * sector, sector) - 0.5 * sector;
  vec2 pp = length(q) * vec2(cos(b), abs(sin(b)));
  vec2 tip = vec2(r, 0.0);
  vec2 inner = ri * r * vec2(cos(0.5 * sector), sin(0.5 * sector));
  vec2 e = inner - tip;
  vec2 nn = normalize(vec2(e.y, -e.x));
  if (dot(nn, -tip) > 0.0) nn = -nn;
  return -dot(pp - tip, nn);
}`,
	body: `
  vec2 c = u_center * u_compSize;
  float n = max(3.0, floor(u_points + 0.5));
  float ri = clamp(u_innerRadius / 100.0, 0.1, 1.0);
  // The star's inscribed circle (≈ the inner vertex distance projected on the edge normal) must cover the frame.
  vec2 tip = vec2(1.0, 0.0);
  vec2 inner = ri * vec2(cos(3.14159265 / n), sin(3.14159265 / n));
  vec2 e = inner - tip;
  float inscribed = abs(dot(-tip, normalize(vec2(e.y, -e.x))));
  float full = (tr_coverRadius(c) + m) / max(inscribed, 0.05);
  float r = pr_grow(p, full, m / max(inscribed, 0.05));
  d = swStar(px - c, max(r, 0.0), n, ri) + min(r, 0.0);`,
});

/** Wipe ▸ Stretch Wipe: an elastic wipe — both clips smear towards the moving edge. */
export const STRETCH_WIPE = defineShaderTransition({
	id: 'jasper.stretch-wipe',
	label: 'Stretch Wipe',
	bin,
	description:
		'An elastic wipe: near the moving edge both clips are stretched and smeared towards it, like pulled rubber.',
	keywords: kw('stretch', 'elastic', 'smear', 'wipe', 'pull'),
	params: [fxParam.angle('angle', 'Angle', 0), fxParam.pixels('stretch', 'Stretch', 200, 2000)],
	gpu: {
		uniforms: angleDir,
		passes: [
			{
				include: [GLSL_TR_WIPE, GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float S = max(u_stretch, 1.0) * min(1.0, 4.0 * pm_bump(p));
  float d = tr_linearWipe(tr_px(), u_dir, p, 2.0);
  // Content near the edge is pulled towards it: B from behind, A from ahead (exponential falloff).
  vec2 px = tr_px();
  vec2 pb = px - u_dir * S * exp(-max(d, 0.0) / max(S, 1.0));
  vec2 pa = px + u_dir * S * exp(min(d, 0.0) / max(S, 1.0));
  vec4 a = pm_sideClamped(0, tr_uvOfPx(pa));
  vec4 b = pm_sideClamped(1, tr_uvOfPx(pb));
  if (S <= 0.0) { a = tr_from(v_uv); b = tr_to(v_uv); }
  fragColor = mix(a, b, tr_edge(d, 0.0, 1.0));
}`,
			},
		],
	},
});

export const MODERN_WIPES: readonly TransitionSpec[] = [
	LINEAR_WIPE_TRANSITION,
	NEON_WIPE,
	PANEL_WIPE,
	PLATEAU_WIPE,
	SOFT_WIPE,
	STAR_WIPE,
	STRETCH_WIPE,
];

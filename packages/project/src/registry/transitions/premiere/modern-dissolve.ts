// Premiere 26 ▸ Video Transitions ▸ Dissolve — the modern entries (from Film Impact): Blur Dissolve, Burn Alpha,
// Dip to Color, Luma Fade, Mosaic, and Shape Dissolve (26.3). Part of the premiere-transitions family. Cross
// Dissolve / Dip to Black are the native built-ins; Additive / Film Dissolve and Dip to White are the classic versions
// in ./dissolve.ts.
import type { TransitionSpec } from '../../../transitions.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { fxParam } from '../../fx/params.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_EASE } from '../glsl.ts';
import { num } from './common.ts';
import { blurLevelPasses, GLSL_PR_BLUR_LEVELS, GLSL_PR_MODERN, GLSL_PR_NOISE } from './modern-common.ts';

const bin = TRANSITION_BINS.dissolve;

/** Dissolve ▸ Blur Dissolve: the picture goes out of focus while it dissolves, then sharpens on B. */
export const BLUR_DISSOLVE = defineShaderTransition({
	id: 'jasper.blur-dissolve',
	label: 'Blur Dissolve',
	bin,
	description:
		'Dissolves through a blur: the outgoing clip goes soft, the clips cross, the incoming clip sharpens.',
	keywords: ['blur', 'dissolve', 'defocus', 'soft', 'film impact'],
	params: [fxParam.pixels('blur', 'Blur', 80, 400)],
	gpu: {
		passes: (p): ShaderPass[] => [
			{
				output: 'bdMix',
				include: [GLSL_TR_EASE],
				frag: /* glsl */ `
void main() { fragColor = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(0.25, 0.75, tr_progress())); }`,
			},
			...blurLevelPasses('bdMix', 'bdBlur', num(p.blur, 80) / 4),
			{
				include: [GLSL_PR_MODERN, GLSL_PR_BLUR_LEVELS],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 sharp = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(0.25, 0.75, p));
  fragColor = pm_blurLevels(sharp, texture(u_bdBlur1, v_uv), texture(u_bdBlur2, v_uv), texture(u_bdBlur3, v_uv), pm_bump(p));
}`,
			},
		],
	},
});

/** Dissolve ▸ Dip to Color: A fades to a colour, (holds,) then the colour fades to B. */
export const DIP_TO_COLOR = defineShaderTransition({
	id: 'jasper.dip-to-color',
	label: 'Dip to Color',
	bin,
	description:
		'The outgoing clip fades to a color of your choice, optionally holds it, then the incoming clip fades in.',
	keywords: ['dip', 'color', 'fade', 'flash', 'film impact'],
	params: [fxParam.color('color', 'Color', [0, 0, 0, 1]), fxParam.percent('hold', 'Hold', 0)],
	gpu: {
		passes: [
			{
				include: [GLSL_TR_EASE],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float h = clamp(u_hold / 100.0, 0.0, 0.98);
  float t = 0.5 * (1.0 - h);
  vec4 c = tr_premul(u_color);
  if (p < t) fragColor = mix(tr_from(v_uv), c, tr_easeInOutSine(p / t));
  else if (p <= t + h) fragColor = c;
  else fragColor = mix(c, tr_to(v_uv), tr_easeInOutSine((p - t - h) / t));
}`,
			},
		],
	},
});

/** Dissolve ▸ Luma Fade: the pixels switch in the order of their brightness. */
export const LUMA_FADE = defineShaderTransition({
	id: 'jasper.luma-fade',
	label: 'Luma Fade',
	bin,
	description:
		'Fades by brightness: the brightest areas of the chosen clip change first (or the darkest, inverted).',
	keywords: ['luma', 'luminance', 'fade', 'brightness', 'film impact'],
	params: [
		fxParam.choice(
			'lumaFrom',
			'Luma From',
			['outgoing', 'incoming'],
			['Outgoing Clip', 'Incoming Clip'],
			'outgoing',
		),
		fxParam.percent('softness', 'Softness', 25),
		fxParam.toggle('invert', 'Dark First', false),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(u_lumaFrom == 0 ? tr_from(v_uv) : tr_to(v_uv));
  float l = clamp(fx_luma(c.rgb) * c.a, 0.0, 1.0);
  float g = u_invert ? l : 1.0 - l;
  float s = max(u_softness / 100.0, 0.002);
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), clamp((tr_progress() * (1.0 + s) - g) / s, 0.0, 1.0));
}`,
			},
		],
	},
});

/** Dissolve ▸ Blur to Color: A blurs into a solid colour, which then fades into a blurred B that sharpens. */
export const BLUR_TO_COLOR = defineShaderTransition({
	id: 'jasper.blur-to-color',
	label: 'Blur to Color',
	bin,
	description:
		'The outgoing clip blurs into a solid color, then the color gives way to the incoming clip coming back into focus.',
	keywords: ['blur', 'color', 'dip', 'fade', 'defocus', 'film impact'],
	params: [fxParam.color('color', 'Color', [1, 1, 1, 1]), fxParam.pixels('blur', 'Blur', 80, 400)],
	gpu: {
		passes: (p): ShaderPass[] => [
			{
				output: 'btMix',
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() { fragColor = tr_progress() < 0.5 ? tr_from(v_uv) : tr_to(v_uv); }`,
			},
			...blurLevelPasses('btMix', 'btBlur', num(p.blur, 80) / 4),
			{
				include: [GLSL_PR_MODERN, GLSL_PR_BLUR_LEVELS],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 sharp = p < 0.5 ? tr_from(v_uv) : tr_to(v_uv);
  vec4 blurred = pm_blurLevels(sharp, texture(u_btBlur1, v_uv), texture(u_btBlur2, v_uv), texture(u_btBlur3, v_uv), pm_bump(p));
  // The colour covers the cut: 0 at the ends, full around the middle.
  float c = smoothstep(0.55, 0.95, pm_bump(p));
  fragColor = mix(blurred, tr_premul(u_color), c);
}`,
			},
		],
	},
});

/** Dissolve ▸ Burn Alpha: holes burn through A with glowing edges, B behind. */
export const BURN_ALPHA = defineShaderTransition({
	id: 'jasper.burn-alpha',
	label: 'Burn Alpha',
	bin,
	description:
		'Holes burn through the outgoing clip with glowing, scorched edges to reveal the incoming clip.',
	keywords: ['burn', 'fire', 'film burn', 'holes', 'scorch', 'film impact'],
	params: [
		fxParam.number('scale', 'Scale', 4, { min: 0.5, max: 30, softMax: 12, step: 0.1 }),
		fxParam.percent('burnWidth', 'Burn Width', 12),
		fxParam.color('burnColor', 'Burn Color', [1, 0.42, 0.08, 1]),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_NOISE],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  // fbm clusters around 0.5: stretch it so the burn advances evenly over the transition.
  float n = clamp(0.5 + 1.8 * (pm_fbm(v_uv * vec2(tr_aspect(), 1.0) * u_scale, u_seed) - 0.5), 0.0, 1.0);
  float w = max(u_burnWidth / 100.0, 0.005);
  float T = mix(-w, 1.0 + w, p);
  vec4 col;
  vec3 light = vec3(0.0);
  vec3 hot = u_burnColor.rgb;
  if (n < T) {
    col = tr_to(v_uv);
    float e = clamp((T - n) / w, 0.0, 1.0);
    light = hot * pow(1.0 - e, 3.0) * 0.8;
  } else {
    float e = clamp((n - T) / w, 0.0, 1.0);
    // Scorched (darkened) A ahead of the burning rim, which glows from the burn colour to white-hot.
    col = tr_from(v_uv);
    col.rgb *= mix(0.15, 1.0, smoothstep(0.0, 1.0, e));
    light = hot * pow(1.0 - e, 2.0) * 1.6 + vec3(1.0, 0.95, 0.8) * pow(1.0 - e, 8.0);
  }
  fragColor = pm_addLight(col, light);
}`,
			},
		],
	},
});

/** Dissolve ▸ Mosaic: A breaks into growing tiles, B emerges from them. */
export const MOSAIC_TRANSITION = defineShaderTransition({
	id: 'jasper.mosaic-transition',
	label: 'Mosaic',
	bin,
	description:
		'The outgoing clip breaks into ever larger tiles, the clips switch, and the incoming clip resolves from them.',
	keywords: ['mosaic', 'pixelate', 'tiles', 'blocks', 'film impact'],
	params: [fxParam.pixels('tileSize', 'Tile Size', 80, 400)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float s = max(1.0, u_tileSize * pm_bump(p));
  vec2 px = tr_px();
  // A tile is centred on the frame centre (symmetric pattern).
  vec2 c = 0.5 * u_compSize;
  vec2 cell = floor((px - c) / s + 0.5) * s + c;
  vec2 uv = s <= 1.0 ? v_uv : clamp(cell / u_compSize, 0.0, 1.0);
  fragColor = mix(tr_from(uv), tr_to(uv), pm_switch(p, 0.12));
}`,
			},
		],
	},
});

const SHAPES = ['circle', 'square', 'diamond', 'star', 'cross'] as const;
const SHAPE_LABELS = ['Circle', 'Square', 'Diamond', 'Star', 'Cross'] as const;

/** Dissolve ▸ Shape Dissolve (Premiere 26.3): a pattern of growing shapes dissolves A into B. */
export const SHAPE_DISSOLVE = defineShaderTransition({
	id: 'jasper.shape-dissolve',
	label: 'Shape Dissolve',
	bin,
	description:
		'A patterned dissolve: a grid of shapes grows across the frame in a direction, revealing the incoming clip.',
	keywords: ['shape', 'pattern', 'dissolve', 'circles', 'dots', 'halftone'],
	params: [
		fxParam.choice('shape', 'Shape', SHAPES, SHAPE_LABELS, 'circle'),
		fxParam.pixels('size', 'Size', 80, 400),
		fxParam.angle('direction', 'Direction', 0),
		fxParam.percent('spread', 'Spread', 60),
		fxParam.angle('rotation', 'Rotation', 0),
		fxParam.pixels('feather', 'Feather', 2, 50),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
// Signed distance (px, > 0 outside) of the shape of "radius" r at q.
float sdShape(vec2 q, float r) {
  if (u_shape == 0) return length(q) - r;
  if (u_shape == 1) return max(abs(q.x), abs(q.y)) - r;
  if (u_shape == 2) return (abs(q.x) + abs(q.y) - r) * 0.70710678;
  if (u_shape == 3) {
    float sector = 2.0 * PM_PI / 5.0;
    float a = atan(q.x, -q.y);
    float b = mod(a + 0.5 * sector, sector) - 0.5 * sector;
    vec2 pp = length(q) * vec2(cos(b), abs(sin(b)));
    vec2 tip = vec2(r, 0.0);
    vec2 inner = 0.45 * r * vec2(cos(0.5 * sector), sin(0.5 * sector));
    vec2 e = inner - tip;
    vec2 n = normalize(vec2(-e.y, e.x));
    if (dot(n, -tip) > 0.0) n = -n;
    return dot(pp - tip, n);
  }
  float w = 0.35 * r;
  return min(max(abs(q.x) - r, abs(q.y) - w), max(abs(q.x) - w, abs(q.y) - r));
}
void main() {
  float p = tr_progress();
  float size = max(u_size, 4.0);
  vec2 c = 0.5 * u_compSize;
  vec2 g = (tr_px() - c) / size + 0.5;
  vec2 cell = floor(g);
  vec2 q = (fract(g) - 0.5) * size;
  float ro = radians(u_rotation);
  q = mat2(cos(ro), -sin(ro), sin(ro), cos(ro)) * q;
  // Cells start in the order of their position along the direction.
  vec2 dir = vec2(cos(radians(u_direction)), sin(radians(u_direction)));
  vec2 cc = (cell + 0.5 - 0.5) * size;
  float ext = 0.5 * (abs(dir.x) * u_compSize.x + abs(dir.y) * u_compSize.y) + size;
  float along = clamp(0.5 + 0.5 * dot(cc, dir) / ext, 0.0, 1.0);
  float spread = clamp(u_spread / 100.0, 0.0, 0.95);
  float cp = clamp((p - spread * along) / (1.0 - spread), 0.0, 1.0);
  // Radius that covers the whole (rotated) cell: the shape's inscribed circle reaches the cell's corners.
  float cover = u_shape == 0 ? 0.7072 : u_shape == 1 ? 0.7072 : u_shape == 2 ? 1.0 : u_shape == 3 ? 1.95 : 2.03;
  float f = max(u_feather, 0.5);
  float r = mix(-f, cover * size + f, cp);
  float sd = sdShape(q, max(r, 0.0)) - min(r, 0.0);
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(0.5 * f, -0.5 * f, sd));
}`,
			},
		],
	},
});

export const MODERN_DISSOLVES: readonly TransitionSpec[] = [
	BLUR_DISSOLVE,
	BLUR_TO_COLOR,
	BURN_ALPHA,
	DIP_TO_COLOR,
	LUMA_FADE,
	MOSAIC_TRANSITION,
	SHAPE_DISSOLVE,
];

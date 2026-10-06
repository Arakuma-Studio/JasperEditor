// Premiere 26 ▸ Video Transitions ▸ Lights & Blurs (from Film Impact): Burn Chroma, Chroma Leak, Directional Blur,
// Flare, Flash, Glow, Lens Blur, Light Leak, Light Sweep, Phosphor, Radial Blur, Ray, Solarize, Stripe, Zoom Blur.
// (Cross Zoom, also in that folder in Premiere 26, is ../premiere-transitions.ts.) Part of the premiere-transitions
// family; the folder sits in MODERN_BINS.lightsBlurs until the framework has a Lights & Blurs bin. Light and blur
// amounts follow bumps that are 0 at both ends (A at progress 0, B at 1).
import type { TransitionSpec } from '../../../transitions.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { fxParam } from '../../fx/params.ts';
import { gaussianBlurPasses } from '../../fx/passes.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import { defineShaderTransition } from '../define.ts';
import { num } from './common.ts';
import {
	blurLevelPasses,
	FOLDER_KEYWORDS,
	GLSL_PR_BLUR_LEVELS,
	GLSL_PR_MODERN,
	GLSL_PR_NOISE,
	MODERN_BINS,
} from './modern-common.ts';

const bin = MODERN_BINS.lightsBlurs;
const kw = (...k: string[]) => [...k, ...FOLDER_KEYWORDS.lightsBlurs, 'film impact'];
const intensity = (def = 100) => fxParam.percent('intensity', 'Intensity', def);

/** Lights & Blurs ▸ Burn Chroma: a burn with rainbow-hot, color-split edges eats through A. */
export const BURN_CHROMA = defineShaderTransition({
	id: 'jasper.burn-chroma',
	label: 'Burn Chroma',
	bin,
	description:
		'Holes burn through the outgoing clip with rainbow-colored, chromatically split edges to reveal the incoming clip.',
	keywords: kw('burn', 'chroma', 'rainbow', 'film burn', 'prism'),
	params: [
		fxParam.number('scale', 'Scale', 3, { min: 0.5, max: 30, softMax: 12, step: 0.1 }),
		fxParam.percent('burnWidth', 'Burn Width', 15),
		intensity(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_NOISE, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  // fbm clusters around 0.5: stretch it so the burn advances evenly over the transition.
  float n = clamp(0.5 + 1.8 * (pm_fbm(v_uv * vec2(tr_aspect(), 1.0) * u_scale, u_seed) - 0.5), 0.0, 1.0);
  float w = max(u_burnWidth / 100.0, 0.005);
  float T = mix(-w, 1.0 + w, p);
  float I = u_intensity / 100.0;
  vec3 rim = fx_hsv2rgb(vec3(fract(n * 3.0 + v_uv.x * 0.6 + u_seed), 0.85, 1.0));
  vec4 col;
  vec3 light;
  if (n < T) {
    float e = clamp((T - n) / w, 0.0, 1.0);
    col = tr_to(v_uv);
    light = rim * pow(1.0 - e, 3.0);
  } else {
    float e = clamp((n - T) / w, 0.0, 1.0);
    // The colour channels of A split apart near the rim.
    vec2 o = vec2(0.012 * (1.0 - e), 0.0);
    vec4 a = tr_from(v_uv);
    col = vec4(tr_from(v_uv + o).r, a.g, tr_from(v_uv - o).b, a.a);
    light = rim * pow(1.0 - e, 2.0) * 1.5 + vec3(pow(1.0 - e, 8.0));
  }
  fragColor = pm_addLight(col, light * I);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Chroma Leak: drifting, saturated light leaks wash over the cut. */
export const CHROMA_LEAK = defineShaderTransition({
	id: 'jasper.chroma-leak',
	label: 'Chroma Leak',
	bin,
	description: 'Colorful, drifting light leaks wash over the frame and hide the change to the incoming clip.',
	keywords: kw('leak', 'light leak', 'chroma', 'color', 'flare'),
	params: [intensity(), fxParam.angle('hue', 'Hue', 0)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 h = vec4(fx_hash22(ivec2(i, 3), u_seed), fx_hash22(ivec2(i, 11), u_seed));
    vec2 start = vec2(h.x * 1.6 - 0.3, h.y);
    vec2 vel = (h.zw - 0.5) * 0.8;
    vec2 c = start + vel * p;
    float r = 0.35 + 0.35 * h.z;
    float d = length((v_uv - c) * asp);
    vec3 col = fx_hsv2rgb(vec3(fract(u_hue / 360.0 + u_seed + 0.23 * float(i)), 0.85, 1.0));
    light += col * exp(-d * d / (r * r));
  }
  float I = (u_intensity / 100.0) * pow(pm_bump(p), 1.5);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.25));
  fragColor = pm_addLight(base, light * I);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Directional Blur: both clips smear along a direction through the cut. */
export const DIRECTIONAL_BLUR_TRANSITION = defineShaderTransition({
	id: 'jasper.directional-blur-transition',
	label: 'Directional Blur',
	bin,
	description:
		'The outgoing clip smears along a direction, the clips cross under the blur and the incoming clip sharpens.',
	keywords: kw('directional blur', 'motion blur', 'smear', 'streak'),
	params: [fxParam.angle('angle', 'Direction', 0), fxParam.pixels('length', 'Blur Length', 200, 1000)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 dir = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
  vec2 delta = dir * u_length * pm_bump(p) / u_compSize;
  float k = pm_switch(p, 0.15);
  vec4 a = k < 1.0 ? pm_streakLong(0, v_uv, delta) : vec4(0.0);
  vec4 b = k > 0.0 ? pm_streakLong(1, v_uv, delta) : vec4(0.0);
  fragColor = mix(a, b, k);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Flare: a lens flare sweeps across the frame and hides the cut. */
export const FLARE = defineShaderTransition({
	id: 'jasper.flare',
	label: 'Flare',
	bin,
	description:
		'A lens flare — glowing source, anamorphic streak and ghosts — sweeps across the frame and hides the change of clip.',
	keywords: kw('flare', 'lens flare', 'anamorphic', 'streak', 'light'),
	params: [
		fxParam.color('color', 'Color', [1, 0.82, 0.55, 1]),
		intensity(),
		fxParam.angle('angle', 'Path Angle', 0),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 dir = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
  vec2 src = 0.5 * asp + dir * (p - 0.5) * 1.6 * asp.x + vec2(0.0, -0.12);
  vec2 q = v_uv * asp;
  vec2 v = q - src;
  float r = length(v);
  vec3 c = u_color.rgb;
  vec3 light = c * (exp(-r * 5.0) * 0.8 + exp(-r * 30.0) * 2.0);
  light += mix(c, vec3(0.6, 0.8, 1.0), 0.5) * exp(-abs(v.y) * 70.0) * exp(-abs(v.x) * 1.8) * 1.2;
  // Ghosts along the line through the frame centre.
  vec2 ctr = 0.5 * asp;
  for (int i = 0; i < 4; i++) {
    float g = -0.4 - 0.45 * float(i);
    vec2 gp = ctr + (src - ctr) * g;
    float gs = 0.04 + 0.05 * float(i);
    float d = length(q - gp);
    vec3 tint = i == 0 ? vec3(0.4, 1.0, 0.6) : i == 1 ? vec3(0.5, 0.6, 1.0) : i == 2 ? vec3(1.0, 0.5, 0.8) : c;
    light += tint * 0.18 * (1.0 - smoothstep(gs * 0.8, gs, d));
  }
  float I = (u_intensity / 100.0) * pow(pm_bump(p), 1.2);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.12));
  base.rgb = min(base.rgb * (1.0 + 0.5 * I), vec3(base.a));
  fragColor = pm_addLight(base, light * I);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Flash: an overexposed flash of light hides the cut. */
export const FLASH_TRANSITION = defineShaderTransition({
	id: 'jasper.flash-transition',
	label: 'Flash',
	bin,
	description:
		'A bright flash — the picture overexposes into the flash color — hides the cut to the incoming clip.',
	keywords: kw('flash', 'exposure', 'white', 'bright', 'strobe'),
	params: [
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		intensity(),
		fxParam.percent('flashLength', 'Flash Length', 40),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float w = max(u_flashLength / 100.0, 0.02);
  float f = exp(-pow((p - 0.5) / (0.5 * w), 2.0)) * pm_bump(p) * (u_intensity / 100.0);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.03));
  base.rgb = min(base.rgb * (1.0 + 3.0 * f), vec3(base.a));
  fragColor = pm_addLight(base, u_color.rgb * min(f, 1.0));
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Glow: highlights bloom into a glow that peaks at the cut. */
export const GLOW_TRANSITION = defineShaderTransition({
	id: 'jasper.glow-transition',
	label: 'Glow',
	bin,
	description:
		'The bright areas bloom into a glow that intensifies towards the cut and fades out on the incoming clip.',
	keywords: kw('glow', 'bloom', 'bright', 'dreamy', 'soft'),
	params: [
		fxParam.pixels('radius', 'Radius', 60, 400),
		intensity(150),
		fxParam.percent('threshold', 'Threshold', 50),
	],
	gpu: {
		passes: (p): ShaderPass[] => [
			{
				output: 'gwBright',
				scale: 0.5,
				include: [GLSL_PR_MODERN, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec4 c = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(tr_progress(), 0.2));
  vec4 u = fx_unpremultiply(c);
  float t = u_threshold / 100.0;
  fragColor = c * smoothstep(t, min(t + 0.25, 1.0), fx_luma(u.rgb));
}`,
			},
			...gaussianBlurPasses({ input: 'gwBright', output: 'gwBlur', sigma: num(p.radius, 60), scale: 0.25 }),
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.2));
  vec4 g = texture(u_gwBlur, v_uv);
  fragColor = pm_addLight(base, g.rgb * (u_intensity / 100.0) * 2.0 * pm_bump(p));
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Lens Blur: the lens racks out of focus (blooming highlights) and back in on B. */
export const LENS_BLUR_TRANSITION = defineShaderTransition({
	id: 'jasper.lens-blur-transition',
	label: 'Lens Blur',
	bin,
	description:
		'The lens racks out of focus — highlights blooming into soft discs — the clips cross, and focus returns on the incoming clip.',
	keywords: kw('lens blur', 'defocus', 'bokeh', 'focus', 'rack focus'),
	params: [fxParam.pixels('radius', 'Radius', 60, 400)],
	gpu: {
		passes: (p): ShaderPass[] => [
			{
				// Highlights pushed above 1 so they keep their energy through the blur (HDR intermediate).
				output: 'lbMix',
				format: 'rgba16f',
				include: [GLSL_PR_MODERN, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec4 c = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(0.3, 0.7, tr_progress()));
  vec4 u = fx_unpremultiply(c);
  float l = fx_luma(u.rgb);
  fragColor = vec4(c.rgb * (1.0 + 4.0 * pow(l, 6.0)), c.a);
}`,
			},
			...blurLevelPasses('lbMix', 'lbBlur', num(p.radius, 60) / 4, 'rgba16f'),
			{
				include: [GLSL_PR_MODERN, GLSL_PR_BLUR_LEVELS],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 sharp = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(0.3, 0.7, p));
  vec4 c = pm_blurLevels(sharp, texture(u_lbBlur1, v_uv), texture(u_lbBlur2, v_uv), texture(u_lbBlur3, v_uv), pm_bump(p));
  fragColor = vec4(min(c.rgb, vec3(c.a)), min(c.a, 1.0));
}`,
			},
		],
	},
});

const PALETTES = ['warm', 'golden', 'magenta', 'cool'] as const;
const PALETTE_LABELS = ['Warm', 'Golden', 'Magenta', 'Cool'] as const;

/** Lights & Blurs ▸ Light Leak: organic film light leaks flare across the frame through the cut. */
export const LIGHT_LEAK = defineShaderTransition({
	id: 'jasper.light-leak',
	label: 'Light Leak',
	bin,
	description:
		'Organic film light leaks and burns flare in from the edge of the frame and wash over the cut.',
	keywords: kw('light leak', 'film burn', 'leak', 'warm', 'vintage'),
	params: [fxParam.choice('palette', 'Palette', PALETTES, PALETTE_LABELS, 'warm'), intensity()],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_PR_NOISE],
				frag: /* glsl */ `
vec3 llRamp(float t) {
  vec3 a = u_palette == 0 ? vec3(0.9, 0.2, 0.05) : u_palette == 1 ? vec3(1.0, 0.55, 0.1) : u_palette == 2 ? vec3(0.9, 0.1, 0.5) : vec3(0.1, 0.4, 1.0);
  vec3 b = u_palette == 0 ? vec3(1.0, 0.75, 0.3) : u_palette == 1 ? vec3(1.0, 0.95, 0.6) : u_palette == 2 ? vec3(1.0, 0.6, 0.3) : vec3(0.6, 0.95, 1.0);
  return mix(a, b, clamp(t, 0.0, 1.0));
}
void main() {
  float p = tr_progress();
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 q = v_uv * asp;
  float n = pm_fbm(q * 1.3 + vec2(p * 0.8, -p * 0.3), u_seed);
  // The leak enters from one side and sweeps across.
  float sweep = mix(-0.4, 1.4, p) * asp.x;
  float m = exp(-pow((q.x - sweep) / (0.55 * asp.x), 2.0)) * smoothstep(0.25, 0.75, n);
  float I = (u_intensity / 100.0) * pm_bump(p) * 1.6;
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.2));
  fragColor = pm_addLight(base, llRamp(n * 1.4 - 0.2) * m * I);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Light Sweep: a beam of light sweeps across the frame and leaves B behind it. */
export const LIGHT_SWEEP = defineShaderTransition({
	id: 'jasper.light-sweep',
	label: 'Light Sweep',
	bin,
	description:
		'A beam of light sweeps across the frame; behind it the incoming clip has replaced the outgoing one.',
	keywords: kw('light sweep', 'beam', 'shine', 'glint', 'wipe'),
	params: [
		fxParam.angle('angle', 'Angle', 20),
		fxParam.pixels('width', 'Width', 160, 1000),
		fxParam.color('color', 'Color', [1, 0.97, 0.9, 1]),
		intensity(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 dir = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
  float s = dot(tr_px() - 0.5 * u_compSize, dir);
  float w = max(u_width, 4.0);
  float h = 0.5 * dot(abs(dir), u_compSize) + 2.0 * w;
  float d = s - mix(-h, h, p);
  float band = exp(-pow(d / (0.5 * w), 2.0));
  float k = smoothstep(0.25 * w, -0.25 * w, d);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), k);
  fragColor = pm_addLight(base, u_color.rgb * band * (u_intensity / 100.0));
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Phosphor: A's highlights linger as a phosphor afterglow while B fades in. */
export const PHOSPHOR = defineShaderTransition({
	id: 'jasper.phosphor',
	label: 'Phosphor',
	bin,
	description:
		"A phosphorescent fade: the outgoing clip's highlights linger as a tinted afterglow while the incoming clip fades in.",
	keywords: kw('phosphor', 'afterglow', 'trail', 'glow', 'crt'),
	params: [
		fxParam.color('color', 'Glow Color', [0.45, 1, 0.75, 1]),
		intensity(),
		fxParam.pixels('radius', 'Spread', 20, 200),
	],
	gpu: {
		passes: (p): ShaderPass[] => [
			{
				output: 'phBright',
				scale: 0.5,
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec4 a = tr_from(v_uv);
  vec4 u = fx_unpremultiply(a);
  float l = fx_luma(u.rgb) * a.a;
  fragColor = vec4(vec3(smoothstep(0.35, 0.9, l)), 1.0);
}`,
			},
			...gaussianBlurPasses({ input: 'phBright', output: 'phGlow', sigma: num(p.radius, 20), scale: 0.5 }),
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(0.15, 0.85, p));
  float g = 0.6 * texture(u_phBright, v_uv).r + 0.8 * texture(u_phGlow, v_uv).r;
  // The afterglow builds as A fades and decays before the end.
  float e = pow(pm_bump(p), 0.8) * (1.0 - 0.5 * p);
  fragColor = pm_addLight(base, u_color.rgb * g * e * (u_intensity / 100.0) * 1.4);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Radial Blur: a spin blur around a centre peaks at the cut. */
export const RADIAL_BLUR_TRANSITION = defineShaderTransition({
	id: 'jasper.radial-blur-transition',
	label: 'Radial Blur',
	bin,
	description:
		'The picture spins into a radial blur around the center, the clips cross, and the incoming clip spins out sharp.',
	keywords: kw('radial blur', 'spin blur', 'rotate', 'twist'),
	params: [fxParam.angle('angle', 'Angle', 30)],
	options: { center: true },
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float a = radians(u_angle) * pm_bump(p);
  float k = pm_switch(p, 0.15);
  vec4 A = k < 1.0 ? pm_spinBlur(0, v_uv, u_center, a) : vec4(0.0);
  vec4 B = k > 0.0 ? pm_spinBlur(1, v_uv, u_center, a) : vec4(0.0);
  fragColor = mix(A, B, k);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Ray: shafts of light burst from a point through the cut. */
export const RAY = defineShaderTransition({
	id: 'jasper.ray',
	label: 'Ray',
	bin,
	description:
		'Shafts of light burst from a point in the picture, flood the frame at the cut and fade on the incoming clip.',
	keywords: kw('ray', 'god rays', 'light rays', 'beams', 'volumetric'),
	params: [intensity(), fxParam.percent('length', 'Ray Length', 60)],
	options: { center: [0.5, 0.35] },
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float k = pm_switch(p, 0.15);
  float e = pm_bump(p);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), k);
  // March towards the centre gathering the bright parts of the picture.
  vec2 d = (u_center - v_uv) * (u_length / 100.0);
  vec3 acc = vec3(0.0);
  float decay = 1.0;
  for (int i = 0; i < 24; i++) {
    vec2 uv = v_uv + d * (float(i) + 1.0) / 24.0;
    vec4 s = mix(pm_sideClamped(0, uv), pm_sideClamped(1, uv), k);
    vec4 u = fx_unpremultiply(s);
    acc += u.rgb * smoothstep(0.45, 0.95, fx_luma(u.rgb)) * decay;
    decay *= 0.93;
  }
  fragColor = pm_addLight(base, acc / 8.0 * (u_intensity / 100.0) * e * 1.5);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Solarize: the picture solarizes (inverting above a threshold) through the cut. */
export const SOLARIZE_TRANSITION = defineShaderTransition({
	id: 'jasper.solarize-transition',
	label: 'Solarize',
	bin,
	description:
		'The picture solarizes — tones above a threshold invert like an overexposed photograph — across the change of clip.',
	keywords: kw('solarize', 'invert', 'sabattier', 'psychedelic'),
	params: [fxParam.percent('threshold', 'Threshold', 50)],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 c = mix(tr_from(v_uv), tr_to(v_uv), pm_switch(p, 0.12));
  vec4 u = fx_unpremultiply(c);
  float t = u_threshold / 100.0;
  vec3 sol = mix(u.rgb, 1.0 - u.rgb, smoothstep(t - 0.04, t + 0.04, u.rgb));
  vec3 rgb = mix(u.rgb, sol, pm_bump(p));
  fragColor = vec4(rgb * c.a, c.a);
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Stripe: bands of light sweep across; B is behind them. */
export const STRIPE = defineShaderTransition({
	id: 'jasper.stripe',
	label: 'Stripe',
	bin,
	description:
		'A set of light stripes sweeps across the frame; the incoming clip appears behind the middle stripe.',
	keywords: kw('stripe', 'stripes', 'bands', 'light', 'sweep'),
	params: [
		fxParam.number('stripes', 'Stripes', 5, { min: 1, max: 20, step: 1 }),
		fxParam.angle('angle', 'Angle', 20),
		fxParam.pixels('width', 'Width', 40, 400),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		intensity(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 dir = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
  float s = dot(tr_px() - 0.5 * u_compSize, dir);
  float n = max(1.0, floor(u_stripes + 0.5));
  float w = max(u_width, 2.0);
  float gap = 2.2 * w;
  float span = (n - 1.0) * gap;
  float h = 0.5 * dot(abs(dir), u_compSize) + span + 2.0 * w;
  float front = mix(-h, h, p);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 20; i++) {
    if (float(i) >= n) break;
    float d = s - (front - float(i) * gap);
    light += u_color.rgb * exp(-pow(d / (0.5 * w), 2.0));
  }
  float dm = s - (front - 0.5 * span);
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(0.25 * w, -0.25 * w, dm));
  fragColor = pm_addLight(base, light * (u_intensity / 100.0));
}`,
			},
		],
	},
});

/** Lights & Blurs ▸ Zoom Blur: A rushes forward into a zoom blur; B arrives out of it. */
export const ZOOM_BLUR_TRANSITION = defineShaderTransition({
	id: 'jasper.zoom-blur-transition',
	label: 'Zoom Blur',
	bin,
	description:
		'The outgoing clip rushes forward into a zoom blur and the incoming clip arrives out of it, like warp speed.',
	keywords: kw('zoom blur', 'warp', 'rush', 'radial', 'speed'),
	params: [fxParam.percent('amount', 'Amount', 60), fxParam.percent('zoom', 'Zoom', 30)],
	options: { center: true },
	gpu: {
		passes: [
			{
				include: [GLSL_PR_MODERN],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  float e = pm_bump(p);
  float k = pm_switch(p, 0.12);
  float z = u_zoom / 100.0;
  vec2 c = u_center;
  // A scales up into the cut, B scales down out of it.
  float sa = 1.0 + z * tr_easeIn(clamp(2.0 * p, 0.0, 1.0));
  float sb = 1.0 + z * tr_easeOut(clamp(2.0 - 2.0 * p, 0.0, 1.0));
  float amt = (u_amount / 100.0) * 0.5 * e;
  vec4 A = k < 1.0 ? pm_zoomBlur(0, c + (v_uv - c) / sa, c, amt) : vec4(0.0);
  vec4 B = k > 0.0 ? pm_zoomBlur(1, c + (v_uv - c) / sb, c, amt) : vec4(0.0);
  fragColor = mix(A, B, k);
}`,
			},
		],
	},
});

export const MODERN_LIGHTS: readonly TransitionSpec[] = [
	BURN_CHROMA,
	CHROMA_LEAK,
	DIRECTIONAL_BLUR_TRANSITION,
	FLARE,
	FLASH_TRANSITION,
	GLOW_TRANSITION,
	LENS_BLUR_TRANSITION,
	LIGHT_LEAK,
	LIGHT_SWEEP,
	PHOSPHOR,
	RADIAL_BLUR_TRANSITION,
	RAY,
	SOLARIZE_TRANSITION,
	STRIPE,
	ZOOM_BLUR_TRANSITION,
];

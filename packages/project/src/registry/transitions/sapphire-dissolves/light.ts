// Sapphire-style light-effect dissolves: S_DissolveGlint / S_DissolveGlintRainbow (star glints on the highlights),
// S_DissolveGlare (glares: rays + halo by style), S_DissolveFlashbulbs (random camera flashes), S_DissolveLensFlare
// (a procedural lens flare sweeping across the cut) and S_DissolveZap (lightning bolts + a background glow).
// Parameters follow Boris FX's public Sapphire documentation; clean-room implementations. The light amounts follow
// the family envelope (0 at both ends), so the ends are exactly A and B.
//
// Approximations: glints / glares are gathered at ¼ resolution along their ray directions (jittered taps, so long
// rays from small highlights read as fine streaks rather than dotted lines); Sapphire's library styles (glare
// "Style", flare "Lens", flash "Flash Style") are a handful of built-in procedural designs here.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import {
	blurPasses,
	blurPx,
	check,
	clamp,
	color,
	defineDissolve,
	dissolveTiming,
	GLSL_SD,
	GLSL_SD_GLOW,
	GLSL_SD_NOISE,
	glowPasses,
	grp,
	intSlider,
	num,
	SAPPHIRE_GLOW_UNIT,
	sapphirePoint,
	seed,
	slider,
	vec2,
} from './common.ts';
import { brightPass, GLOW_GAIN, relSideParams } from './glow.ts';

/** Glint / glare lengths: a Sapphire size of 1.0 = 10 % of the frame width. */
const GLINT_UNIT = 0.1;

// ---------------------------------------------------------------- shared streak gather

/**
 * Streaks of a light texture along up to 16 directions (both ways), packed in `u_rays` (floats: dx, dy, length px,
 * brightness per direction; `u_rayCount` directions). Per-channel weights along the ray come from `rayWeight(u)`
 * (u = 0 at the source … 1 at the far end), defined by the caller. Lengths are normalised so a ray's brightness does
 * not depend on its length; taps are jittered per pixel.
 */
const STREAK_GLSL = /* glsl */ `
float rd(int i, int k) { return u_rays[i][k]; }
vec3 streaks(sampler2D t, float thickness) {
  vec2 res = vec2(textureSize(t, 0));
  float jit = sd_h2(ivec2(v_uv * res), 977u);
  float pxToTex = res.x / u_compSize.x;
  vec3 acc = vec3(0.0);
  int nd = int(u_rayCount);
  int taps = int(u_rayTaps);
  for (int d = 0; d < nd; d++) {
    float b = rd(d, 3);
    float L = rd(d, 2) * pxToTex;
    if (b <= 0.0 || L < 0.5) continue;
    vec2 dir = vec2(rd(d, 0), rd(d, 1));
    vec2 perp = vec2(-dir.y, dir.x) * thickness / res;
    vec3 sum = vec3(0.0);
    for (int i = 0; i < taps; i++) {
      float u = (float(i) + jit) / float(taps);
      vec2 o = dir * u * L / res;
      vec3 s = texture(t, v_uv + o).rgb + texture(t, v_uv - o).rgb;
      if (thickness > 0.0) s = 0.5 * s + 0.25 * (texture(t, v_uv + o + perp).rgb + texture(t, v_uv - o - perp).rgb);
      sum += s * rayWeight(u, d);
    }
    acc += sum * b * (L / float(taps));
  }
  return acc;
}`;

/** Packs ray directions (degrees, clockwise) with lengths (frame px) and brightnesses for `u_rays`. */
export function packRays(rays: readonly { angle: number; length: number; brightness: number }[]) {
	const floats: number[] = [];
	for (const r of rays.slice(0, 16)) {
		const a = (r.angle * Math.PI) / 180;
		floats.push(Math.cos(a), Math.sin(a), Math.max(0, r.length), Math.max(0, r.brightness));
	}
	if (floats.length === 0) floats.push(1, 0, 0, 0);
	while (floats.length < 64) floats.push(0, 0, 0, 0);
	return { u_rays: { vec4s: floats }, u_rayCount: Math.min(16, rays.length) };
}

// ---------------------------------------------------------------- S_DissolveGlint / S_DissolveGlintRainbow

/** The 4 glint rays of a frame: X, Y, Diag1 (top right → bottom left), Diag2 (top left → bottom right). */
export function glintRays(p: EffectParams, width: number, env: number, mix: number) {
	const relSize = num(p.relFromSize, 1) * (1 - mix) + num(p.relToSize, 1) * mix;
	const shrink = clamp(num(p.glintShrink, 0.8), 0, 1);
	const L = Math.max(0, num(p.glintSize, 2)) * GLINT_UNIT * width * (1 - shrink + shrink * env) * relSize;
	const swap = p.swapDiagonals === true;
	const d1 = swap ? 45 : -45;
	const d2 = swap ? -45 : 45;
	return [
		{ angle: 0, length: L * Math.max(0, num(p.sizeX, 1)), brightness: Math.max(0, num(p.brightnessX, 1)) },
		{ angle: 90, length: L * Math.max(0, num(p.sizeY, 1)), brightness: Math.max(0, num(p.brightnessY, 1)) },
		{
			angle: d1,
			length: L * Math.max(0, num(p.sizeDiag1, 0.75)),
			brightness: Math.max(0, num(p.brightnessDiag1, 1)),
		},
		{
			angle: d2,
			length: L * Math.max(0, num(p.sizeDiag2, 0.75)),
			brightness: Math.max(0, num(p.brightnessDiag2, 1)),
		},
	];
}

function glintDissolve(rainbow: boolean): TransitionSpec {
	const label = rainbow ? 'S_DissolveGlintRainbow' : 'S_DissolveGlint';
	return defineDissolve({
		id: rainbow ? 'jasper.s.dissolve-glint-rainbow' : 'jasper.s.dissolve-glint',
		label,
		description: rainbow
			? 'Dissolves through rainbow glints: the highlights of both clips shoot spectral star rays (X, Y and diagonals) that grow towards the peak.'
			: 'Dissolves through glints: the highlights of both clips shoot star rays (X, Y and diagonals, per-channel lengths) that grow towards the peak.',
		keywords: rainbow
			? ['glint', 'rainbow', 'star', 'sparkle', 'spectrum', 'dissolve']
			: ['glint', 'star', 'sparkle', 'twinkle', 'rays', 'dissolve'],
		timing: { speed: 3 },
		params: [
			slider('glintBrightness', 'Glint Brightness', 1.5, { min: 0, softMax: 10 }),
			slider('glintThreshold', 'Glint Threshold', 0.7, { min: 0, softMax: 1 }),
			slider('glintThresholdBlur', 'Glint Threshold Blur', 0.0896, { min: 0, softMax: 1, step: 0.001 }),
			color('glintScaleColors', 'Glint Scale Colors', [1, 1, 1]),
			slider('brightnessX', 'Brightness X', 1, { min: 0, softMax: 4 }),
			slider('brightnessY', 'Brightness Y', 1, { min: 0, softMax: 4 }),
			slider('brightnessDiag1', 'Brightness Diag1', 1, { min: 0, softMax: 4 }),
			slider('brightnessDiag2', 'Brightness Diag2', 1, { min: 0, softMax: 4 }),
			slider('glintSize', 'Glint Size', 2, { min: 0, softMax: 10 }),
			slider('glintShrink', 'Glint Shrink', 0.8, { min: 0, max: 1 }),
			slider('sizeX', 'Size X', 1, { min: 0, softMax: 4 }),
			slider('sizeY', 'Size Y', 1, { min: 0, softMax: 4 }),
			slider('sizeDiag1', 'Size Diag1', 0.75, { min: 0, softMax: 4 }),
			slider('sizeDiag2', 'Size Diag2', 0.75, { min: 0, softMax: 4 }),
			...(rainbow
				? [
						slider('shiftOut', 'Shift Out', 1, { softMin: -2, softMax: 4 }),
						slider('shiftRed', 'Shift Red', 0.3, { softMin: -2, softMax: 2 }),
						slider('shiftBlue', 'Shift Blue', -0.3, { softMin: -2, softMax: 2 }),
					]
				: [
						slider('sizeRed', 'Size Red', 0.5, { min: 0, softMax: 4 }),
						slider('sizeGreen', 'Size Green', 1, { min: 0, softMax: 4 }),
						slider('sizeBlue', 'Size Blue', 1.5, { min: 0, softMax: 4 }),
					]),
			...relSideParams('From', 'Size'),
			...relSideParams('To', 'Size'),
			slider('affectAlpha', 'Affect Alpha', 1, { min: 0, softMax: 2 }),
			check('swapDiagonals', 'Swap Diagonals', false),
		],
		gpu: {
			uniforms: (p, ctx) => {
				const d = dissolveTiming(p, ctx.progress);
				const rays = glintRays(p, ctx.width, d.env, d.mix);
				// Per-channel lengths: the taps cover the longest channel.
				const rel = rainbow
					? [1, 1, 1]
					: [num(p.sizeRed, 0.5), num(p.sizeGreen, 1), num(p.sizeBlue, 1.5)].map((x) => Math.max(0, x));
				const maxRel = Math.max(1e-3, ...rel);
				return {
					...packRays(rays.map((r) => ({ ...r, length: r.length * maxRel }))),
					u_rayTaps: 40,
					u_chanRel: rel.map((x) => x / maxRel) as [number, number, number],
					u_thrBlur: blurPx(p.glintThresholdBlur ?? 0.0896, ctx.width),
				};
			},
			passes: (): ShaderPass[] => [
				brightPass('u_glintThreshold'),
				...blurPasses({
					input: 'bright',
					output: 'brightBlur',
					scale: 0.25,
					sigma: 'vec2(u_thrBlur + 1.0)',
					format: 'rgba16f',
				}),
				{
					output: 'glint',
					scale: 0.25,
					format: 'rgba16f',
					include: [GLSL_SD, GLSL_SD_NOISE],
					frag: /* glsl */ `
${
	rainbow
		? `// Spectral bands along the ray: red at Shift Out + Shift Red, blue at Shift Out + Shift Blue, green between.
vec3 rayWeight(float u, int d) {
  float base = 0.3 * u_shiftOut;
  vec3 c = vec3(base + 0.4 * u_shiftRed + 0.2, base + 0.2 * (u_shiftRed + u_shiftBlue) + 0.2, base + 0.4 * u_shiftBlue + 0.2);
  vec3 x = (vec3(u) - c) / 0.18;
  return exp(-x * x) * (1.0 - u) * 1.6;
}`
		: `vec3 rayWeight(float u, int d) {
  vec3 x = max(1.0 - vec3(u) / max(u_chanRel, vec3(1e-3)), 0.0);
  return x * x;
}`
}
${STREAK_GLSL}
void main() { fragColor = vec4(streaks(u_brightBlur, 0.0), 1.0); }`,
				},
				{
					include: [GLSL_SD],
					frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec3 gs = sd_bicubic(u_glint, v_uv).rgb;
  // Soft compression: broad bright areas do not flood the frame, small highlights keep thin, bright rays.
  gs = gs / (1.0 + 0.12 * gs);
  vec3 light = (gs * 0.15 + sd_bicubic(u_bright, v_uv).rgb * 0.3)
             * u_glintScaleColors.rgb * u_glintBrightness * u_sdEnv;
  fragColor = mix(sd_lightOver(base, light, u_affectAlpha, false), sd_dissolve(), u_mixWithDissolve);
}`,
				},
			],
		},
	});
}

export const S_DISSOLVE_GLINT = glintDissolve(false);
export const S_DISSOLVE_GLINT_RAINBOW = glintDissolve(true);

// ---------------------------------------------------------------- S_DissolveGlare

export const GLARE_STYLES = ['star4', 'star6', 'star8', 'sparkle', 'haloRing', 'anamorphic'] as const;
const GLARE_STYLE_LABELS = ['Star 4', 'Star 6', 'Star 8', 'Sparkle', 'Halo Ring', 'Anamorphic'] as const;

/** A glare style: ray lines (each both ways), alternate-ray length, halo / ring amounts, tint, spectral rays. */
const GLARE_DESIGNS: Record<
	(typeof GLARE_STYLES)[number],
	{
		lines: number;
		alt: number;
		halo: number;
		ring: number;
		tint: [number, number, number];
		rainbow: number;
		aspect: number;
	}
> = {
	star4: { lines: 2, alt: 1, halo: 0.6, ring: 0, tint: [1, 1, 1], rainbow: 0, aspect: 1 },
	star6: { lines: 3, alt: 1, halo: 0.5, ring: 0, tint: [1, 0.97, 0.9], rainbow: 0, aspect: 1 },
	star8: { lines: 4, alt: 0.5, halo: 0.5, ring: 0, tint: [0.95, 0.97, 1], rainbow: 0, aspect: 1 },
	sparkle: { lines: 4, alt: 0.35, halo: 0.35, ring: 0.15, tint: [1, 1, 1], rainbow: 1, aspect: 1 },
	haloRing: { lines: 2, alt: 1, halo: 0.8, ring: 0.6, tint: [1, 0.92, 0.8], rainbow: 0.5, aspect: 1 },
	anamorphic: { lines: 1, alt: 1, halo: 0.4, ring: 0, tint: [0.55, 0.75, 1], rainbow: 0, aspect: 0.6 },
};

export function glareRays(p: EffectParams, width: number, env: number) {
	const style = GLARE_DESIGNS[String(p.style) as keyof typeof GLARE_DESIGNS] ?? GLARE_DESIGNS.star4;
	const size = Math.max(0, num(p.size, 2.4)) * GLINT_UNIT * width * (0.35 + 0.65 * env);
	const n = Math.max(1, Math.min(8, Math.round(style.lines * Math.max(0, num(p.raysNumScale, 1)))));
	const rays = [];
	for (let i = 0; i < n; i++) {
		const len =
			size * Math.max(0, num(p.raysLength, 1)) * (i % 2 === 1 ? style.alt : 1) * (style.lines === 1 ? 2 : 1);
		rays.push({ angle: num(p.rotate, 0) + (180 * i) / n, length: len, brightness: 1 });
	}
	return { rays, style, size };
}

export const S_DISSOLVE_GLARE: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-glare',
	label: 'S_DissolveGlare',
	description:
		'Dissolves through glares: the highlights of both clips flare up into star-shaped glares (rays, halo, ring by style) whose size and brightness peak mid-way.',
	keywords: ['glare', 'star', 'flare', 'highlight', 'bloom', 'dissolve'],
	timing: { speed: 3 },
	params: [
		slider('size', 'Size', 2.4, { min: 0, softMax: 10 }),
		slider('relHeight', 'Rel Height', 1, { min: 0, softMax: 4 }),
		fxParam.choice('style', 'Style', GLARE_STYLES, GLARE_STYLE_LABELS, 'star4'),
		slider('threshold', 'Threshold', 0.5, { min: 0, softMax: 1 }),
		color('thresholdAddColor', 'Threshold Add Color', [0, 0, 0]),
		slider('thresholdBlur', 'Threshold Blur', 0, { min: 0, softMax: 1 }),
		slider('brightness', 'Brightness', 3, { min: 0, softMax: 10 }),
		color('scaleColors', 'Scale Colors', [1, 1, 1]),
		slider('saturation', 'Saturation', 1, { min: -2, max: 8 }),
		fxParam.angle('rotate', 'Rotate', 0),
		slider('raysNumScale', 'Rays Num Scale', 1, { min: 0, softMax: 4 }),
		slider('raysLength', 'Rays Length', 1, { min: 0, softMax: 4 }),
		slider('raysThickness', 'Rays Thickness', 1, { min: 0, softMax: 4 }),
		slider('blurGlare', 'Blur Glare', 0, { min: 0, softMax: 1 }),
		slider('hueShift', 'Hue Shift', 0, { softMin: -1, softMax: 1 }),
		fxParam.choice('glareRes', 'Glare Res', ['full', 'half', 'quarter'], ['Full', 'Half', 'Quarter'], 'full'),
		slider('affectAlpha', 'Affect Alpha', 1, { min: 0, softMax: 2 }),
		slider('glareFromAlpha', 'Glare From Alpha', 0, { min: 0, max: 1 }),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const d = dissolveTiming(p, ctx.progress);
			const g = glareRays(p, ctx.width, d.env);
			return {
				...packRays(g.rays),
				u_rayTaps: 40,
				u_glareHalo: g.style.halo,
				u_glareRing: g.style.ring,
				u_glareTint: g.style.tint,
				u_glareRainbow: g.style.rainbow,
				u_glareAspect: g.style.aspect * Math.max(0.01, num(p.relHeight, 1)),
				u_glareSize: g.size,
				u_thrBlur: blurPx(p.thresholdBlur, ctx.width) + blurPx(p.blurGlare, ctx.width),
			};
		},
		passes: (p): ShaderPass[] => {
			const scale = p.glareRes === 'quarter' ? 0.125 : p.glareRes === 'half' ? 0.25 : 0.5;
			return [
				{
					// Threshold of both sides (Threshold Add Color raises it per channel; Glare From Alpha), dissolve-weighted.
					output: 'bright',
					scale: 0.5,
					format: 'rgba16f',
					include: [GLSL_SD],
					frag: /* glsl */ `
vec3 lightOf(vec4 c) {
  vec3 s = c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
  vec3 thr = vec3(u_threshold) + u_thresholdAddColor.rgb;
  vec3 l = max(s - thr, 0.0) / max(1.0 - thr, vec3(0.05)) * c.a;
  return mix(l, vec3(smoothstep(u_threshold, 1.0, c.a)), u_glareFromAlpha);
}
void main() {
  fragColor = vec4(lightOf(tr_from(v_uv)) * (1.0 - u_sdMix) + lightOf(tr_to(v_uv)) * u_sdMix, 1.0);
}`,
				},
				...blurPasses({
					input: 'bright',
					output: 'brightBlur',
					scale,
					sigma: 'vec2(u_thrBlur + 1.0)',
					format: 'rgba16f',
				}),
				{
					output: 'glare',
					scale,
					format: 'rgba16f',
					include: [GLSL_SD, GLSL_SD_NOISE],
					frag: /* glsl */ `
vec3 rayWeight(float u, int d) {
  float w = (1.0 - u) * (1.0 - u);
  // Spectral styles: the ray colour runs through the spectrum along its length.
  vec3 spec = 0.5 + 0.5 * cos(6.2831853 * (u * 1.2 + vec3(0.0, 0.33, 0.67)));
  return w * mix(vec3(1.0), spec * 1.4, u_glareRainbow);
}
${STREAK_GLSL}
// Halo (a soft disc) and ring around the highlights: a 24-tap ring / disc gather (Rel Height squashes them).
vec3 haloRing(sampler2D t) {
  vec2 res = vec2(textureSize(t, 0));
  float R = u_glareSize * 0.25 * res.x / u_compSize.x;
  vec3 h = vec3(0.0), r = vec3(0.0);
  float jit = sd_h2(ivec2(v_uv * res), 31u) * 6.2831853;
  for (int i = 0; i < 24; i++) {
    float a = float(i) * 0.2617994 + jit;
    vec2 dir = vec2(cos(a), sin(a) * u_glareAspect);
    float k = fract(float(i) * 0.618034 + 0.3);
    h += texture(t, v_uv + dir * R * k / res).rgb * (1.0 - k);
    r += texture(t, v_uv + dir * R / res).rgb;
  }
  return h / 24.0 * u_glareHalo * 2.0 + r / 24.0 * u_glareRing;
}
void main() {
  vec3 g = streaks(u_brightBlur, max(u_raysThickness - 1.0, 0.0)) * 0.3;
  g = g / (1.0 + 0.12 * g) + haloRing(u_brightBlur);
  fragColor = vec4(g, 1.0);
}`,
				},
				{
					include: [GLSL_SD],
					frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec3 g = sd_bicubic(u_glare, v_uv).rgb * 0.5 + 0.25 * sd_bicubic(u_bright, v_uv).rgb;
  g *= u_glareTint * u_scaleColors.rgb;
  float l = fx_luma(g);
  g = max(mix(vec3(l), g, u_saturation), 0.0);
  if (u_hueShift != 0.0) g = fx_hueShift(min(g, vec3(64.0)), u_hueShift);
  vec3 light = g * u_brightness * 0.12 * u_sdEnv;
  fragColor = mix(sd_lightOver(base, light, u_affectAlpha, false), sd_dissolve(), u_mixWithDissolve);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- S_DissolveFlashbulbs

export const FLASH_STYLES = ['bulb', 'star', 'soft', 'glare'] as const;
const FLASH_STYLE_LABELS = ['Bulb', 'Star', 'Soft', 'Glare'] as const;
/** Most flashes per frame (and frames of Hold). */
export const MAX_FLASHES = 64;
export const MAX_HOLD = 6;

/**
 * Flash counts of the current frame and the held ones (frame − h, h = 0 … Hold Frames): Max Flashes × the envelope
 * at that frame × a per-frame random reduction (Flash Randomness), with the decay weight of each held frame.
 */
export function flashFrames(
	p: EffectParams,
	ctx: { frame: number; duration: number; seed: number; progressAt(frame: number): number },
) {
	const hold = Math.max(0, Math.min(MAX_HOLD, Math.round(num(p.holdFrames, 1))));
	const maxN = Math.max(0, Math.min(MAX_FLASHES, num(p.maxFlashes, 20)));
	const rnd = clamp(num(p.flashRandomness, 0.2), 0, 1);
	const decay = clamp(num(p.flashDecayRate, 0.1), 0, 1);
	const floats: number[] = [];
	for (let h = 0; h <= hold; h++) {
		const f = ctx.frame - h;
		const env = f < 0 ? 0 : dissolveTiming(p, ctx.progressAt(f)).env;
		const r = hashFrame(ctx.seed, f);
		floats.push(f, maxN * env * (1 - rnd * r), h === 0 ? 1 : decay ** h, 0);
	}
	return { u_flashFrames: { vec4s: floats }, u_flashHold: hold + 1 };
}

/** A deterministic 0..1 random of (seed, frame) (TS side). */
function hashFrame(seed: number, f: number): number {
	let h = (Math.floor(seed * 4294967295) ^ Math.imul(f + 1013, 2654435761)) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const S_DISSOLVE_FLASHBULBS: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-flashbulbs',
	label: 'S_DissolveFlashbulbs',
	description:
		'Lots of camera flashbulbs go off while the clips dissolve (a stadium or red-carpet look): random flashes per frame, most at the peak, with persistence trails.',
	keywords: ['flashbulbs', 'flash', 'camera', 'paparazzi', 'red carpet', 'stadium', 'dissolve'],
	timing: { speed: 3 },
	params: [
		fxParam.choice('flashStyle', 'Flash Style', FLASH_STYLES, FLASH_STYLE_LABELS, 'bulb'),
		slider('maxFlashes', 'Max Flashes', 20, { min: 0, max: MAX_FLASHES, step: 1 }),
		slider('flashRandomness', 'Flash Randomness', 0.2, { min: 0, max: 1 }),
		slider('flashSize', 'Flash Size', 0.4, { min: 0, softMax: 2 }),
		slider('flashRelHeight', 'Flash Rel Height', 1, { min: 0, softMax: 4 }),
		slider('brightness', 'Brightness', 3, { min: 0, softMax: 10 }),
		slider('varyBrightness', 'Vary Brightness', 0.2, { min: 0, max: 1 }),
		slider('flashGamma', 'Flash Gamma', 1, { min: 0.1, softMax: 4 }),
		intSlider('holdFrames', 'Hold Frames', 1, 0, MAX_HOLD),
		slider('flashDecayRate', 'Flash Decay Rate', 0.1, { min: 0, max: 1 }),
		fxParam.choice('combine', 'Combine', ['screen', 'add'], ['Screen', 'Add'], 'add'),
		seed(),
		slider('affectAlpha', 'Affect Alpha', 1, { min: 0, softMax: 2 }),
		check('flipVertically', 'Flip Vertically', false),
	],
	gpu: {
		uniforms: (p, ctx) =>
			flashFrames(p, {
				frame: ctx.frame,
				duration: ctx.duration,
				seed: ctx.seed,
				// Linear progress of an earlier frame of the span (two-sided ramp), Start/End applied.
				progressAt: (f) => {
					const lin = (f + 1) / (ctx.duration + 1);
					const s = clamp(num(p.startPercent, 0) / 100, 0, 1);
					const e = clamp(num(p.endPercent, 100) / 100, 0, 1);
					const prog = s + (e - s) * lin;
					return ctx.reversed ? 1 - prog : prog;
				},
			}),
		passes: [
			{
				output: 'flash',
				scale: 0.5,
				format: 'rgba16f',
				include: [GLSL_SD, GLSL_SD_NOISE],
				frag: /* glsl */ `
float ff(int h, int k) { return u_flashFrames[h][k]; }
// One flash at offset d (px) of size R (px): a hot core, a halo, and rays by style.
float flashShape(vec2 d, float R) {
  if (u_flipVertically) d.y = -d.y;
  d.y /= max(u_flashRelHeight, 0.01);
  float r = length(d) / R;
  float core = exp(-r * r * 60.0) * 3.0;
  float halo = exp(-r * r * 5.0);
  float rays = 0.0;
  if (u_flashStyle == 0 || u_flashStyle == 1) {
    float th = R * 0.015 + 0.5;
    float fall = max(0.0, 1.0 - r * (u_flashStyle == 1 ? 0.7 : 1.0));
    rays = (exp(-abs(d.y) / th) + exp(-abs(d.x) / th)) * fall * fall;
    if (u_flashStyle == 1) {
      vec2 e = vec2(d.x + d.y, d.x - d.y) * 0.70710678;
      rays += (exp(-abs(e.y) / th) + exp(-abs(e.x) / th)) * fall * fall * 0.6;
    }
  }
  if (u_flashStyle == 2) { core *= 0.3; halo = exp(-r * r * 2.0) * 1.3; }
  if (u_flashStyle == 3) {
    halo += smoothstep(0.08, 0.0, abs(r - 0.6)) * 0.3;
    rays = exp(-abs(d.y) / (R * 0.01 + 0.5)) * max(0.0, 1.0 - r * 0.4) * 1.5;
  }
  return core + halo * 0.6 + rays * 0.8;
}
void main() {
  vec2 px = tr_px();
  float R0 = u_flashSize * 0.25 * u_compSize.x;
  vec3 acc = vec3(0.0);
  int nh = int(u_flashHold);
  for (int h = 0; h < nh; h++) {
    float count = ff(h, 1);
    float w = ff(h, 2);
    int n = int(ceil(count));
    uint s = sd_seedU(fract(u_seed + ff(h, 0) * 0.0137));
    for (int i = 0; i < n; i++) {
      float last = float(i) + 1.0 > count ? fract(count) : 1.0;
      vec2 pos = vec2(sd_h3(ivec3(i, 1, 0), s), sd_h3(ivec3(i, 2, 0), s)) * u_compSize;
      float R = R0 * (0.5 + 0.7 * sd_h3(ivec3(i, 3, 0), s));
      vec2 d = px - pos;
      if (abs(d.x) > R * 1.6 || abs(d.y) > R * 1.6 * max(u_flashRelHeight, 0.01)) continue;
      float b = (1.0 - u_varyBrightness * sd_h3(ivec3(i, 4, 0), s)) * last;
      float warm = sd_h3(ivec3(i, 5, 0), s);
      acc += mix(vec3(1.0, 0.97, 0.92), vec3(0.9, 0.95, 1.0), warm) * flashShape(d, R) * b * w;
    }
  }
  acc = pow(max(acc, 0.0), vec3(1.0 / max(u_flashGamma, 0.1)));
  fragColor = vec4(acc, 1.0);
}`,
			},
			{
				include: [GLSL_SD],
				frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec3 light = sd_bicubic(u_flash, v_uv).rgb * u_brightness * 0.35;
  fragColor = mix(sd_lightOver(base, light, u_affectAlpha, u_combine == 0), sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_DissolveLensFlare

export const LENS_TYPES = ['standard', 'anamorphic', 'zoom', 'sun'] as const;
const LENS_LABELS = ['Standard 50mm', 'Anamorphic', 'Zoom Lens', 'Sun'] as const;

/** Ghost elements of a lens: [position along hotspot → pivot (0 hotspot, 1 pivot, 2 mirror), size, r, g, b, shape]. */
const LENS_GHOSTS: Record<(typeof LENS_TYPES)[number], number[][]> = {
	standard: [
		[0.45, 0.12, 0.4, 0.8, 0.5, 2],
		[0.75, 0.06, 0.9, 0.6, 0.3, 0],
		[1.25, 0.2, 0.3, 0.5, 1, 1],
		[1.45, 0.08, 1, 0.5, 0.2, 2],
		[1.7, 0.35, 0.25, 0.9, 0.4, 3],
		[2.0, 0.15, 0.6, 0.4, 1, 0],
	],
	anamorphic: [
		[0.6, 0.1, 0.3, 0.6, 1, 0],
		[1.3, 0.25, 0.2, 0.4, 1, 1],
		[1.6, 0.08, 0.5, 0.8, 1, 0],
		[2.1, 0.18, 0.2, 0.5, 1, 3],
	],
	zoom: [
		[0.3, 0.05, 1, 0.4, 0.2, 2],
		[0.55, 0.09, 0.4, 1, 0.4, 2],
		[0.8, 0.14, 0.3, 0.5, 1, 2],
		[1.1, 0.06, 1, 0.9, 0.3, 0],
		[1.35, 0.22, 0.8, 0.3, 0.9, 1],
		[1.6, 0.1, 0.3, 1, 0.8, 2],
		[1.9, 0.3, 0.9, 0.6, 0.2, 3],
		[2.3, 0.12, 0.5, 0.5, 1, 2],
	],
	sun: [
		[0.7, 0.08, 1, 0.8, 0.4, 0],
		[1.4, 0.3, 1, 0.6, 0.3, 3],
	],
};
/** Hotspot design per lens: rays count, streak (anamorphic), halo size, tint. */
const LENS_HOTSPOT: Record<
	(typeof LENS_TYPES)[number],
	{ rays: number; streak: number; halo: number; tint: [number, number, number] }
> = {
	standard: { rays: 12, streak: 0.2, halo: 1, tint: [1, 0.95, 0.85] },
	anamorphic: { rays: 4, streak: 1.5, halo: 0.7, tint: [0.6, 0.8, 1] },
	zoom: { rays: 8, streak: 0.1, halo: 0.8, tint: [1, 1, 1] },
	sun: { rays: 24, streak: 0, halo: 1.8, tint: [1, 0.9, 0.7] },
};

export function lensFlareUniforms(
	p: EffectParams,
	ctx: { width: number; height: number; env: number; t: number },
) {
	const lens =
		(String(p.lens) as (typeof LENS_TYPES)[number]) in LENS_GHOSTS
			? (String(p.lens) as (typeof LENS_TYPES)[number])
			: 'standard';
	const unit = ctx.width / 2;
	const c = vec2(p.hotspotCenter, [0.5, 0.5]);
	const a = (num(p.hotspotAngle, -25) * Math.PI) / 180;
	const travel = num(p.hotspotSpeed, 1) * (ctx.t - 0.5) * 2 * unit;
	// Sapphire angles are counter-clockwise with y up: on screen (y down) the sweep goes up for positive angles.
	const hot: [number, number] = [
		c[0] * ctx.width + Math.cos(a) * travel,
		c[1] * ctx.height - Math.sin(a) * travel,
	];
	const pv = vec2(p.pivot, [0.5, 0.5]);
	const shrink = clamp(num(p.flareShrink, 0.5), 0, 1);
	const width = Math.max(0, num(p.flareWidth, 2.5)) * 0.05 * ctx.width * (1 - shrink + shrink * ctx.env);
	const fade = clamp(num(p.flareFade, 1), 0, 1);
	const bright = Math.max(0, num(p.flareBrightness, 8)) * (1 - fade + fade * ctx.env);
	const ghosts: number[] = [];
	for (const g of LENS_GHOSTS[lens]) ghosts.push(...g, 0, 0);
	while (ghosts.length < 8 * 8) ghosts.push(0, 0, 0, 0, 0, 0, 0, 0);
	const h = LENS_HOTSPOT[lens];
	return {
		u_hot: hot,
		u_pivotPx: [pv[0] * ctx.width, pv[1] * ctx.height] as [number, number],
		u_flareWidthPx: width,
		u_flareBright: bright,
		u_ghosts: { vec4s: ghosts },
		u_ghostCount: LENS_GHOSTS[lens].length,
		u_hotRays: h.rays,
		u_hotStreak: h.streak,
		u_hotHalo: h.halo,
		u_hotTint: h.tint,
	};
}

export const S_DISSOLVE_LENS_FLARE: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-lens-flare',
	label: 'S_DissolveLensFlare',
	description:
		'Dissolves under a lens flare that sweeps across the frame along a line, growing and brightening towards the peak (hotspot, rays and ghost elements lined up with the pivot).',
	keywords: ['lens flare', 'flare', 'sun', 'anamorphic', 'light', 'dissolve'],
	timing: { speed: 3 },
	params: [
		fxParam.point('hotspotCenter', 'Hotspot Center', sapphirePoint(0, 0)),
		slider('hotspotSpeed', 'Hotspot Speed', 1, { min: 0, max: 2 }),
		fxParam.angle('hotspotAngle', 'Hotspot Angle', -25),
		fxParam.point('pivot', 'Pivot', sapphirePoint(0, 0)),
		slider('flareBrightness', 'Flare Brightness', 8, { min: 0, softMax: 20 }),
		slider('flareFade', 'Flare Fade', 1, { min: 0, max: 1 }),
		slider('flareWidth', 'Flare Width', 2.5, { min: 0, softMax: 10 }),
		slider('flareShrink', 'Flare Shrink', 0.5, { min: 0, max: 1 }),
		slider('relHeights', 'Rel Heights', 1, { min: 0, softMax: 4 }),
		fxParam.choice('lens', 'Lens', LENS_TYPES, LENS_LABELS, 'standard'),
		...grp('Flare Details', [
			fxParam.angle('raysRotate', 'Rays Rotate', 0),
			color('flareColor', 'Color', [1, 1, 1]),
			slider('gamma', 'Gamma', 1, { min: 0, softMax: 4 }),
			slider('saturation', 'Saturation', 1, { softMin: -2, softMax: 4 }),
			slider('hueShift', 'Hue Shift', 0, { min: -1, max: 1 }),
			color('hotspotColor', 'Hotspot Color', [1, 1, 1]),
			slider('hotspotBrightness', 'Hotspot Brightness', 1, { min: 0, softMax: 4 }),
			slider('raysBrightness', 'Rays Brightness', 1, { min: 0, softMax: 4 }),
			slider('raysNumScale', 'Rays Num Scale', 1, { min: 0, softMax: 4 }),
			slider('raysLength', 'Rays Length', 1, { min: 0, softMax: 4 }),
			slider('raysThickness', 'Rays Thickness', 1, { min: 0, softMax: 4 }),
			slider('otherBrightness', 'Other Brightness', 1, { min: 0, softMax: 4 }),
			slider('otherWidth', 'Other Width', 1, { min: 0, softMax: 4 }),
			color('otherColor', 'Other Color', [1, 1, 1]),
		]),
		slider('bgBrightness', 'Bg Brightness', 1, { min: 0, softMax: 2 }),
		fxParam.choice('combine', 'Combine', ['screen', 'add'], ['Screen', 'Add'], 'screen'),
		check('tintBgWhites', 'Tint Bg Whites', false),
		slider('affectAlpha', 'Affect Alpha', 1, { min: 0, softMax: 2 }),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const d = dissolveTiming(p, ctx.progress);
			return lensFlareUniforms(p, { width: ctx.width, height: ctx.height, env: d.env, t: d.t });
		},
		passes: [
			{
				output: 'flare',
				scale: 0.5,
				format: 'rgba16f',
				include: [GLSL_SD, GLSL_SD_NOISE],
				frag: /* glsl */ `
float gh(int i, int k) { return u_ghosts[i * 2 + k / 4][k % 4]; }
float hexDist(vec2 p) { p = abs(p); return max(dot(p, vec2(0.8660254, 0.5)), p.y); }
void main() {
  vec2 px = tr_px();
  float W = max(u_flareWidthPx, 1.0);
  vec2 d = px - u_hot;
  d.y /= max(u_relHeights, 0.01);
  float r = length(d) / W;
  // Hotspot: core + halo, rays (Rays Rotate / Num / Length / Thickness), anamorphic streak.
  vec3 hot = vec3(exp(-r * r * 30.0) * 3.0 + exp(-r * 2.5) * 0.6 * u_hotHalo);
  float nr = max(1.0, floor(u_hotRays * u_raysNumScale + 0.5));
  float ang = atan(d.y, d.x) - radians(u_raysRotate);
  float spoke = pow(abs(cos(ang * nr * 0.5)), 60.0 / max(u_raysThickness, 0.05));
  float rn = sd_vnoise(vec2(ang * 7.0, 0.5), 0.71) * 0.5 + 0.5;
  float rays = spoke * (0.4 + 0.6 * rn) * exp(-r / (1.2 * max(u_raysLength, 0.01)));
  float streak = exp(-abs(d.y) / (W * 0.02)) * exp(-abs(d.x) / (W * 3.0)) * u_hotStreak;
  vec3 hotspot = (hot * u_hotspotColor.rgb * u_hotspotBrightness + vec3(rays) * u_raysBrightness + vec3(streak)) * u_hotTint;
  // Ghosts along the line hotspot → pivot (and beyond, mirrored through the pivot).
  vec3 other = vec3(0.0);
  int n = int(u_ghostCount);
  for (int i = 0; i < n; i++) {
    vec2 c = mix(u_hot, u_pivotPx, gh(i, 0));
    float R = gh(i, 1) * W * 2.0 * u_otherWidth;
    vec2 q = (px - c) / max(R, 1.0);
    q.y /= max(u_relHeights, 0.01);
    float shape = gh(i, 5);
    float e = shape >= 2.0 ? hexDist(q) : length(q);
    float v = shape == 0.0 ? exp(-e * e * 3.0) * 0.8
            : shape == 1.0 ? smoothstep(0.12, 0.0, abs(e - 0.85)) * 0.8 + smoothstep(1.0, 0.0, e) * 0.08
            : shape == 2.0 ? smoothstep(1.0, 0.92, e) * 0.35
            : smoothstep(1.0, 0.4, e) * 0.25;
    other += vec3(gh(i, 2), gh(i, 3), gh(i, 4)) * v * 2.0;
  }
  vec3 flare = (hotspot + other * u_otherColor.rgb * u_otherBrightness) * u_flareColor.rgb;
  flare = pow(max(flare, 0.0), vec3(1.0 / max(u_gamma, 0.05)));
  float l = fx_luma(flare);
  flare = max(mix(vec3(l), flare, u_saturation), 0.0);
  if (u_hueShift != 0.0) flare = fx_hueShift(min(flare, vec3(64.0)), u_hueShift);
  fragColor = vec4(flare * u_flareBright * 0.3, 1.0);
}`,
			},
			{
				include: [GLSL_SD],
				frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  base.rgb *= mix(1.0, u_bgBrightness, u_sdEnv);
  vec3 flare = sd_bicubic(u_flare, v_uv).rgb;
  vec4 c;
  if (u_tintBgWhites) {
    // The flare's chroma is added after the brightness is clamped: its colour shows over white backgrounds.
    float l = fx_luma(flare);
    c = sd_lightOver(base, vec3(l), u_affectAlpha, u_combine == 0);
    c.rgb = clamp(c.rgb + (flare - l) * c.a, 0.0, c.a);
  } else {
    c = sd_lightOver(base, flare, u_affectAlpha, u_combine == 0);
  }
  fragColor = mix(c, sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_DissolveZap

/** Most bolts drawn (Max Bolts is clamped to it). */
export const MAX_BOLTS = 64;

export function zapUniforms(
	p: EffectParams,
	ctx: { width: number; height: number; env: number; mix: number },
) {
	const s = vec2(p.start, [0.5, 0.5]);
	const e = vec2(p.end, [0.5, 0.5]);
	const glow = Math.max(0, num(p.zapGlowWidth, 0.224)) * SAPPHIRE_GLOW_UNIT * ctx.width;
	const bg = Math.max(0, num(p.bgGlowWidth, 0.4)) * SAPPHIRE_GLOW_UNIT * ctx.width;
	return {
		u_zapStart: [s[0] * ctx.width, s[1] * ctx.height] as [number, number],
		u_zapEnd: [e[0] * ctx.width, e[1] * ctx.height] as [number, number],
		u_boltCount: Math.min(MAX_BOLTS, Math.max(1, Math.round(num(p.maxBolts, 35)))) * ctx.env,
		// The bolts grow from Start towards their ends over the first part of the ramp.
		u_grow: Math.min(1, ctx.env * 1.6),
		u_boltWidthPx: Math.max(0.3, num(p.boltWidth, 0.112) * 0.02 * ctx.width),
		u_zapGlowSigma: [glow, glow] as [number, number],
		u_bgSigma: [bg, bg] as [number, number],
	};
}

export const S_DISSOLVE_ZAP: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-zap',
	label: 'S_DissolveZap',
	description:
		'Lightning bolts crackle from a start point to random end points while the clips dissolve; the bolts multiply and the background glows towards the peak.',
	keywords: ['zap', 'lightning', 'electric', 'bolt', 'energy', 'dissolve'],
	timing: { speed: 5 },
	params: [
		slider('maxBolts', 'Max Bolts', 35, { min: 1, max: MAX_BOLTS, step: 1 }),
		fxParam.point('start', 'Start', sapphirePoint(0, 0)),
		fxParam.point('end', 'End', sapphirePoint(0, 0)),
		slider('varyEndpoint', 'Vary Endpoint', 1.4, { min: 0, softMax: 4 }),
		slider('boltWidth', 'Bolt Width', 0.112, { min: 0, softMax: 1, step: 0.001 }),
		slider('branchiness', 'Branchiness', 5, { min: 0, max: 20 }),
		slider('zapBright', 'Zap Bright', 1, { min: 0, softMax: 4 }),
		color('zapColor', 'Zap Color', [1, 1, 1]),
		slider('zapGlowBright', 'Zap Glow Bright', 2, { min: 0, softMax: 10 }),
		color('zapGlowColor', 'Zap Glow Color', [0.5, 0.5, 1]),
		slider('zapGlowWidth', 'Zap Glow Width', 0.224, { min: 0, softMax: 2, step: 0.001 }),
		slider('bgGlowBright', 'Bg Glow Bright', 8, { min: 0, softMax: 20 }),
		color('bgGlowColor', 'Bg Glow Color', [1, 1, 1]),
		slider('bgGlowWidth', 'Bg Glow Width', 0.4, { min: 0, softMax: 4 }),
		slider('startOffset', 'Start Offset', 0, { min: 0, softMax: 1 }),
		slider('length', 'Length', 1, { min: 0, softMax: 1 }),
		seed('Rand Seed'),
		slider('affectAlpha', 'Affect Alpha', 1, { min: 0, softMax: 2 }),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const d = dissolveTiming(p, ctx.progress);
			return zapUniforms(p, { width: ctx.width, height: ctx.height, env: d.env, mix: d.mix });
		},
		passes: [
			{
				// The bolts (½ resolution): r = core, g = soft halo. Bolt shapes change every frame (crackle).
				output: 'bolts',
				scale: 0.5,
				format: 'rgba16f',
				include: [GLSL_SD, GLSL_SD_NOISE],
				frag: /* glsl */ `
// Jagged offset (px) across a bolt at chord parameter t (0..1), pinned at both ends.
float jag(float t, float len, float seed) {
  float x = t * len / 60.0;
  return (sd_fbm(vec2(x, seed * 13.0), 3, 0.55, seed)) * min(len * 0.12, 90.0) * sin(3.14159265 * clamp(t, 0.0, 1.0));
}
// Distance (px) from p to a bolt a → b drawn over chord parameters [t0, t1].
float boltDist(vec2 p, vec2 a, vec2 b, float t0, float t1, float seed) {
  vec2 ab = b - a;
  float len = max(length(ab), 1.0);
  vec2 dir = ab / len;
  vec2 ap = p - a;
  float t = dot(ap, dir) / len;
  float side = dot(ap, vec2(-dir.y, dir.x));
  float reach = min(len * 0.12, 90.0) + 6.0 * u_boltWidthPx;
  if (t < t0 - 0.02 || t > t1 + 0.02 || abs(side) > reach * 1.2) return 1e6;
  float tc = clamp(t, t0, t1);
  float off = jag(tc, len, seed);
  float along = (t - tc) * len;
  return length(vec2(along, side - off));
}
void main() {
  vec2 px = tr_px();
  float core = 0.0, halo = 0.0;
  int n = int(ceil(u_boltCount));
  float frameSeed = fract(u_seed + u_frame * 0.0618);
  uint s = sd_seedU(u_seed);
  float w = u_boltWidthPx;
  float t0 = clamp(u_startOffset, 0.0, 1.0);
  float t1 = clamp(u_startOffset + u_length * u_grow, 0.0, 1.0);
  int nb = int(clamp(u_branchiness * 0.6, 0.0, 6.0));
  for (int i = 0; i < n; i++) {
    float last = float(i) + 1.0 > u_boltCount ? fract(u_boltCount) : 1.0;
    // End point: End + a random offset within Vary Endpoint (Sapphire units: half widths).
    float ra = sd_h3(ivec3(i, 1, 7), s) * 6.2831853;
    float rr = sqrt(sd_h3(ivec3(i, 2, 7), s)) * u_varyEndpoint * sd_unit();
    vec2 b = u_zapEnd + vec2(cos(ra), sin(ra)) * rr;
    float bs = fract(frameSeed + float(i) * 0.1373);
    float d = boltDist(px, u_zapStart, b, t0, t1, bs);
    // Branches: off the main bolt at a random point, a shorter jagged fork.
    vec2 ab = b - u_zapStart;
    float len = length(ab);
    vec2 dir = ab / max(len, 1.0);
    for (int k = 0; k < nb; k++) {
      float tb = mix(0.15, 0.8, sd_h3(ivec3(i, k, 11), s));
      if (tb > t1) continue;
      vec2 at = u_zapStart + ab * tb + vec2(-dir.y, dir.x) * jag(tb, len, bs);
      float ba = (sd_h3(ivec3(i, k, 12), s) - 0.5) * 1.6;
      vec2 bdir = vec2(dir.x * cos(ba) - dir.y * sin(ba), dir.x * sin(ba) + dir.y * cos(ba));
      float bl = len * mix(0.15, 0.4, sd_h3(ivec3(i, k, 13), s));
      float grow = clamp((t1 - tb) / max(1.0 - tb, 1e-3), 0.0, 1.0);
      d = min(d, boltDist(px, at, at + bdir * bl, 0.0, grow, fract(bs + float(k) * 0.29)) * 1.6);
    }
    core += smoothstep(w, 0.0, d) * last;
    halo += exp(-d / (w * 4.0)) * last;
  }
  fragColor = vec4(core, halo, 0.0, 1.0);
}`,
			},
			...blurPasses({
				input: 'bolts',
				output: 'boltGlow',
				scale: 0.25,
				sigma: 'u_zapGlowSigma',
				format: 'rgba16f',
			}),
			{
				output: 'bright',
				scale: 0.5,
				format: 'rgba16f',
				include: [GLSL_SD],
				frag: /* glsl */ `
void main() {
  vec4 c = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec3 s = c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
  fragColor = vec4(sd_threshold(s, 0.2) * c.a, 1.0);
}`,
			},
			...glowPasses({ input: 'bright', prefix: 'bg', sigma: 'u_bgSigma' }),
			{
				include: [GLSL_SD_GLOW],
				frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec2 bolt = sd_bicubic(u_bolts, v_uv).rg;
  vec2 bglow = sd_bicubic(u_boltGlow, v_uv).rg;
  vec3 light = min(bolt.r, 1.0) * u_zapColor.rgb * u_zapBright * 1.5
             + (bolt.g * 0.06 + bglow.r * 0.8 + bglow.g * 0.08) * u_zapGlowColor.rgb * u_zapGlowBright
             + sd_glow(u_bgNear, u_bgFar, 0.0) * u_bgGlowColor.rgb * u_bgGlowBright * ${GLOW_GAIN * 0.4} * u_sdEnv;
  fragColor = mix(sd_lightOver(base, light, u_affectAlpha, false), sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

export const LIGHT_DISSOLVES = [
	S_DISSOLVE_FLASHBULBS,
	S_DISSOLVE_GLARE,
	S_DISSOLVE_GLINT,
	S_DISSOLVE_GLINT_RAINBOW,
	S_DISSOLVE_LENS_FLARE,
	S_DISSOLVE_ZAP,
] as const;

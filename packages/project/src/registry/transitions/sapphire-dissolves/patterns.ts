// Sapphire-style pattern dissolves: S_Dissolve (plain, with Dissolve Speed and Slow In / Out), S_DissolveFilm (gamma
// dissolve), S_DissolveLuma (luminance pattern of either or both clips), S_DissolveSpeckle (noise pattern) and
// S_DissolveStatic (random pixel static). Parameters follow Boris FX's public Sapphire documentation; clean-room
// implementations.

import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { fxParam } from '../../fx/params.ts';
import { gaussianBlurPasses } from '../../fx/passes.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import { blurPx, defineDissolve, GLSL_SD, intSlider, seed, slider } from './common.ts';

/** S_Dissolve: a cross fade, with Dissolve Speed (a quicker cut around the peak) and Slow In / Slow Out. */
export const S_DISSOLVE = defineDissolve({
	id: 'jasper.s.dissolve',
	label: 'S_Dissolve',
	description:
		'A basic cross fade between the two clips, with Dissolve Speed (shorter dissolve around the peak) and Slow In / Slow Out easing.',
	keywords: ['dissolve', 'cross fade', 'mix', 'fade'],
	timing: { speed: 1, slow: [0.2, 0.2], mix: false },
	gpu: {
		passes: [
			{
				include: [GLSL_SD],
				frag: /* glsl */ `
void main() { fragColor = sd_dissolve(); }`,
			},
		],
	},
});

/** S_DissolveFilm: a dissolve in a gamma space (film / light-like): highlights survive longer. */
export const S_DISSOLVE_FILM = defineDissolve({
	id: 'jasper.s.dissolve-film',
	label: 'S_DissolveFilm',
	description:
		'A film dissolve with selectable gamma: the clips are mixed as light (raised to Gamma), so highlights last longer than in a plain dissolve.',
	keywords: ['film dissolve', 'gamma', 'additive', 'highlights'],
	timing: false,
	params: [slider('gamma', 'Gamma', 2, { min: 0.1, max: 10, softMax: 5 })],
	gpu: {
		passes: [
			{
				include: [GLSL_SD],
				frag: /* glsl */ `
void main() {
  vec4 a = tr_from(v_uv), b = tr_to(v_uv);
  float m = u_sdMix;
  float g = max(u_gamma, 0.1);
  // Mix straight colours as light (power g), weighted by the side opacities; alpha mixes linearly.
  float wa = (1.0 - m) * a.a, wb = m * b.a;
  vec3 ca = pow(max(a.rgb / max(a.a, 1e-5), 0.0), vec3(g));
  vec3 cb = pow(max(b.rgb / max(b.a, 1e-5), 0.0), vec3(g));
  float alpha = wa + wb;
  vec3 c = pow((wa * ca + wb * cb) / max(alpha, 1e-5), vec3(1.0 / g));
  // Film: the light of both clips adds up (≈ (1-m)·A^g + m·B^g), which keeps the highlights of the fading clip.
  vec3 film = pow(max((1.0 - m) * ca + m * cb, 0.0), vec3(1.0 / g));
  c = a.a > 0.0 && b.a > 0.0 ? film : c;
  fragColor = vec4(clamp(c, 0.0, 1.0) * alpha, alpha);
}`,
			},
		],
	},
});

export const LUMA_SOURCES = ['difference', 'subtract', 'mult', 'screen', 'foreground', 'background'] as const;
const LUMA_SOURCE_LABELS = ['Difference', 'Subtract', 'Mult', 'Screen', 'Foreground', 'Background'] as const;

/**
 * S_DissolveLuma params of version 1 (Luma From / Dissolve Width / Invert Luma / Blur Luma px) → version 2
 * (Sapphire's Softness / Use Luma Of / Invert Pattern / Smooth Pattern). v1 switched the BRIGHT areas of the chosen
 * clip first; Sapphire's Foreground switches the dark areas of the outgoing clip first, Background the bright areas
 * of the incoming clip first.
 */
function migrateLumaV1(from: number, p: Record<string, unknown>): Record<string, unknown> {
	if (from >= 2) return p;
	const { lumaFrom, width, invert, blurLuma, ...rest } = p;
	const inv = invert === true;
	const out: Record<string, unknown> = { ...rest };
	out.useLumaOf = lumaFrom === 'to' ? 'background' : 'foreground';
	out.invertPattern = lumaFrom === 'to' ? inv : !inv;
	if (typeof width === 'number') out.softness = Math.min(1, Math.max(0, width / 2));
	// Blur Luma was in px at the sequence size; Smooth Pattern is in Sapphire blur units (σ = 3 % of a 1920 frame).
	if (typeof blurLuma === 'number') out.smoothPattern = Math.max(0, blurLuma) / (0.03 * 1920);
	return out;
}

/**
 * S_DissolveLuma: the pixels switch from A to B in the order of a pattern made from the clips' luminances (Use Luma
 * Of): similar areas first (Difference), where A is brighter (Subtract), where both / either are bright (Mult /
 * Screen), the dark areas of A (Foreground) or the bright areas of B (Background) first.
 */
export const S_DISSOLVE_LUMA = defineDissolve({
	id: 'jasper.s.dissolve-luma',
	version: 2,
	migrate: migrateLumaV1,
	label: 'S_DissolveLuma',
	description:
		'Transitions through a pattern derived from the luminances of the clips (Use Luma Of: Difference, Subtract, Mult, Screen, Foreground, Background): one clip appears to emerge through the other.',
	keywords: ['luma', 'luminance', 'dissolve', 'wipe', 'brightness', 'difference'],
	timing: false,
	params: [
		slider('softness', 'Softness', 0.1, { min: 0, max: 1 }),
		fxParam.choice('useLumaOf', 'Use Luma Of', LUMA_SOURCES, LUMA_SOURCE_LABELS, 'difference'),
		fxParam.toggle('invertPattern', 'Invert Pattern', false),
		slider('smoothPattern', 'Smooth Pattern', 0, { min: 0, softMax: 2 }),
	],
	gpu: {
		passes: (p, ctx): ShaderPass[] => [
			{
				// The transition pattern (0 = switches first … 1 = last), at half resolution.
				output: 'luma',
				scale: 0.5,
				include: [GLSL_COLOR],
				frag: /* glsl */ `
float lumaOf(vec4 c) { return c.a > 0.0 ? fx_luma(clamp(c.rgb / c.a, 0.0, 1.0)) * c.a : 0.0; }
void main() {
  float la = lumaOf(tr_from(v_uv)), lb = lumaOf(tr_to(v_uv));
  int m = u_useLumaOf;
  float pat = m == 0 ? abs(la - lb)
            : m == 1 ? 0.5 - 0.5 * (la - lb)
            : m == 2 ? 1.0 - la * lb
            : m == 3 ? (1.0 - la) * (1.0 - lb)
            : m == 4 ? la
            : 1.0 - lb;
  if (u_invertPattern) pat = 1.0 - pat;
  fragColor = vec4(vec3(clamp(pat, 0.0, 1.0)), 1.0);
}`,
			},
			// Smooth Pattern (always planned, σ 0 = a copy, so the pass layout is stable).
			...gaussianBlurPasses({
				input: 'luma',
				output: 'lumaBlur',
				sigma: blurPx(p.smoothPattern, ctx.width),
				scale: 0.5,
			}),
			{
				frag: /* glsl */ `
void main() {
  float pat = texture(u_lumaBlur, v_uv).r;
  float s = max(u_softness, 0.002);
  // The threshold sweeps from −s to 1 + s: exactly A at progress 0 and B at 1.
  float th = mix(-s, 1.0 + s, tr_progress());
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(pat - s, pat + s, th));
}`,
			},
		],
	},
});

/** S_DissolveSpeckle: B shows through a speckled noise pattern that fills in. */
export const S_DISSOLVE_SPECKLE = defineDissolve({
	id: 'jasper.s.dissolve-speckle',
	label: 'S_DissolveSpeckle',
	description:
		'Transitions through a speckled noise pattern: B appears in noise speckles that grow until they fill the frame.',
	keywords: ['speckle', 'noise', 'dissolve', 'blotch', 'pattern'],
	timing: false,
	params: [
		slider('frequency', 'Frequency', 40, { min: 0.01, softMax: 200, step: 0.1 }),
		slider('frequencyRelY', 'Frequency Rel Y', 1, { min: 0.01, softMax: 4 }),
		intSlider('octaves', 'Octaves', 1, 1, 10),
		seed(),
		slider('edgeSoftness', 'Edge Softness', 0, { min: 0, softMax: 1 }),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_NOISE],
				frag: /* glsl */ `
void main() {
  vec2 q = tr_px() / u_compSize.x * u_frequency * vec2(1.0, u_frequencyRelY);
  int oct = int(clamp(u_octaves, 1.0, 10.0));
  // fbm is concentrated around its mean: stretch it so the speckles span the whole transition.
  float n = clamp(0.5 + fx_fbm(q, oct, 2.0, 0.5, u_seed) * 0.95, 0.0, 1.0);
  float s = max(u_edgeSoftness * 0.25, 0.004);
  float th = mix(-s, 1.0 + s, tr_progress());
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), smoothstep(n - s, n + s, th));
}`,
			},
		],
	},
});

/** S_DissolveStatic: every pixel switches at a random moment, re-drawn every frame (TV static). */
export const S_DISSOLVE_STATIC = defineDissolve({
	id: 'jasper.s.dissolve-static',
	label: 'S_DissolveStatic',
	description:
		'Transitions using random pixel static: each pixel shows A or B at random, more B as the transition goes on, changing every frame.',
	keywords: ['static', 'noise', 'tv', 'pixel', 'random', 'snow'],
	timing: false,
	gpu: {
		passes: [
			{
				include: [GLSL_HASH],
				frag: /* glsl */ `
void main() {
  float r = fx_random(tr_px(), u_frame, u_seed);
  float p = tr_progress();
  // r < p shows B; r in [0, 1) so progress 0 is all A and 1 all B.
  fragColor = r < p ? tr_to(v_uv) : tr_from(v_uv);
}`,
			},
		],
	},
});

export const PATTERN_DISSOLVES = [
	S_DISSOLVE,
	S_DISSOLVE_FILM,
	S_DISSOLVE_LUMA,
	S_DISSOLVE_SPECKLE,
	S_DISSOLVE_STATIC,
] as const;

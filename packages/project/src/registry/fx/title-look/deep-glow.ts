// Deep Glow (spec 19 §8, §5.1 `deepGlow`): scattered light. Ported from Pachislop's effects/a/lightGlow.ts
// (licenses/ported/pachislop-effects.md), shared by the look layer and the standalone effect.
//
// PSF: veiling glare and lens bloom fall off close to an inverse power law I(r) ∝ r^-p. A scale mixture of unit-energy
// Gaussians Σ w(σ) G_σ with w ∝ σ^(2-p) per log-σ step equals r^-p between its smallest and largest σ, so the octaves sit
// one octave apart below σmax = radius / 3 and the weights sum to 1: Radius and Falloff reshape the light without
// changing how much there is. (Check: ∫ σ^(2-p) · σ^-2 exp(-r²/2σ²) dlog σ ∝ r^-p.)
//
// What differs from Pachislop. Its octaves start at 1 comp px, so the PSF changes with the radius and the comp size; here
// the table is a fixed ratio of the radius, so a look keeps its glow at any size and an animated radius is continuous. Each
// octave blurs the previous one (Gaussians compose: variances add) on a pyramid, and the variance the 2×2 reductions and
// the final bilinear read add is taken off the blur, per channel, in the shader: σ is a percentage of the unit there, whose
// true value on non-text clips only the shader knows. An octave too narrow to reach a pixel is the picture itself, and
// its weight goes to the unblurred term, so energy stays exact at low resolution. Light leaves the canvas instead of
// piling up at its edge, and the padding is the PSF's reach (TL-033).
import type { RGBA } from '../../../schema/common.ts';
import type { Paint, Role } from '../../../title-looks/model.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import type { GlslChunk, ShaderPass } from '../shader.ts';
import { GLSL_TL_SURFACE } from './glsl.ts';
import { GLSL_TL_LIGHT } from './light.ts';
import { gradientRamp, linearPremultiplied, RAMP_SIZE } from './paint.ts';

/** Falloff 0 % → long haze (p = 1.6) … 100 % → tight (p = 3.2), Pachislop's range. */
export const DG_P_LONG = 1.6;
export const DG_P_TIGHT = 3.2;
/** Gaussians in the mixture: σmin = σmax / 256, narrower than a pixel on any title. */
export const DG_OCTAVES = 9;
/** Chromatic scatter at ±100 %: the R / G / B PSF radius is 120 / 100 / 80 % of the radius. */
export const DG_CHROMA_SPREAD = 0.2;
/** Canvas px: a Gaussian this narrow leaves a pixel where it was. */
const DG_MERGE_SIGMA = 0.35;
/** Texels an octave's narrowest channel keeps at its pyramid level. */
const DG_LEVEL_SIGMA = 2;

export type GlowOctave = {
	/** σ per channel, in the unit of the radius. */
	sigma: [number, number, number];
	/** Energy weight (the octaves sum to 1). */
	weight: number;
	/** Position over the radius, 0 = narrowest, 1 = widest (the tint's gradient). */
	t: number;
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** The power-law exponent of a Falloff percentage. */
export const dgExponent = (falloff: number) =>
	DG_P_LONG + (DG_P_TIGHT - DG_P_LONG) * clamp(Number.isFinite(falloff) ? falloff / 100 : 0.5, 0, 1);

/** The PSF: narrowest first. `radius` in any unit, `falloff` and `chroma` percentages. */
export function dgOctaves(radius: number, falloff: number, chroma: number): GlowOctave[] {
	const p = dgExponent(falloff);
	const top = Math.max(0, radius) / 3;
	const k = DG_CHROMA_SPREAD * clamp(Number.isFinite(chroma) ? chroma / 100 : 0, -1, 1);
	const out: GlowOctave[] = [];
	let sum = 0;
	for (let i = 0; i < DG_OCTAVES; i++) {
		const rel = 2 ** (i - (DG_OCTAVES - 1));
		const weight = rel ** (2 - p);
		sum += weight;
		const s = top * rel;
		out.push({ sigma: [s * (1 + k), s, s * (1 - k)], weight, t: i / (DG_OCTAVES - 1) });
	}
	for (const o of out) o.weight /= sum;
	return out;
}

/** How far the PSF reaches beyond its emitter, in the unit of the radius: 3σ of the widest channel. */
export const dgReach = (radius: number, chroma: number) =>
	Math.max(0, radius) * (1 + DG_CHROMA_SPREAD * Math.abs(clamp(Number.isFinite(chroma) ? chroma / 100 : 0, -1, 1)));

export const GLSL_TL_DEEP_GLOW: GlslChunk = {
	name: 'title-look/deep-glow',
	deps: [GLSL_COLOR, GLSL_TL_SURFACE, GLSL_TL_LIGHT],
	source: /* glsl */ `
// Fraction of a pixel's light above the luminance threshold, soft knee of width u_knee (quadratic toe, then linear): the
// threshold is subtracted, so only the excess emits.
float dg_emitFraction(vec4 L) {
  if (u_threshold <= 0.0) return 1.0;
  vec3 c = L.a > 1.0e-5 ? L.rgb / L.a : vec3(0.0);
  float b = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float x = b - u_threshold;
  float e = x;
  if (u_knee > 1.0e-4) {
    float q = clamp(x + u_knee, 0.0, 2.0 * u_knee);
    e = max(x, q * q / (4.0 * u_knee));
  }
  return max(e, 0.0) / max(b, 1.0e-4);
}
// Over-exposure response. Exactly the identity for every channel at or below 1 that nothing pushed up, so adding the glow
// never dims or recolours the picture. Light past a channel's clip spills into its spectral neighbours, and a neighbour
// pushed past its clip spills on (blue, cyan, white; red, orange, yellow, white); Core Whiteness sends it straight to the
// far channel. The shoulder rolls off to 1.5: the display clips at 1, where the spill takes over.
vec3 dg_shoulder(vec3 x) { return min(x, vec3(1.0)) + 0.5 * (1.0 - exp(-2.0 * max(x - 1.0, vec3(0.0)))); }
vec3 dg_bleed(vec3 e) {
  return 0.5 * vec3(e.g, e.r + e.b, e.g) + 0.5 * (u_coreWhite * 0.01) * vec3(e.b, 0.0, e.r);
}
vec3 dg_overexpose(vec3 x) {
  float h = u_highlightShift * 0.01;
  vec3 x1 = x + h * dg_bleed(max(x - 1.0, vec3(0.0)));
  vec3 x2 = x + h * dg_bleed(max(x1 - 1.0, vec3(0.0)));
  // x + (y − x)·k, not mix(): stays exact where y == x.
  return x + (dg_shoulder(x2) - x) * smoothstep(0.0, 0.25, h);
}
// The picture with its direct light and the scattered glow. 'direct': the picture itself emits (its light × 2^exposure).
vec4 dg_result(vec4 under, vec3 glow, bool direct) {
  float cover = clamp(under.a, 0.0, 1.0);
  vec3 lit = under.rgb;
  if (direct) lit *= 1.0 + dg_emitFraction(under) * (pow(2.0, u_exposure) - 1.0);
  vec3 covered = lit + glow * (u_onFace * 0.01) * cover;
  return tl_lit(under, dg_overexpose(max(covered, vec3(0.0))), dg_overexpose(max(glow, vec3(0.0))));
}
`,
};

/** A 2×2 reduction: four bilinear taps landing on the four source texels when the size halves exactly. */
const FRAG_DG_DOWN = /* glsl */ `
void main() {
  vec2 h = 0.5 / vec2(textureSize(u_tlDgPyr, 0));
  fragColor = 0.25 * (texture(u_tlDgPyr, v_uv + vec2(-h.x, -h.y)) + texture(u_tlDgPyr, v_uv + vec2(h.x, -h.y)) +
                      texture(u_tlDgPyr, v_uv + vec2(-h.x, h.y)) + texture(u_tlDgPyr, v_uv + vec2(h.x, h.y)));
}`;

/**
 * One axis of the next octave: σ² per channel of the octave, less what the chain already holds (`u_dgPrev`, percent of
 * the unit; `u_dgVar`, canvas px², what the reductions and the bilinear reads changed). Zero outside the canvas: light
 * leaves the picture, and the weights still sum to the kernel's so nothing piles up at the edge.
 */
const blurAxis = (tex: string) => /* glsl */ `
void main() {
  vec2 size = vec2(textureSize(${tex}, 0));
  vec3 now = u_dgSigma * 0.01 * tl_unit();
  vec3 prev = u_dgPrev * 0.01 * tl_unit();
  vec3 st = sqrt(max(now * now - prev * prev - u_dgVar, vec3(0.0))) * size.x / u_canvasSize.x;
  vec3 k = 0.5 / max(st * st, vec3(1.0e-4));
  int taps = int(min(48.0, ceil(3.0 * max(st.r, max(st.g, st.b)))));
  vec3 acc = vec3(0.0);
  vec3 ws = vec3(0.0);
  for (int i = -48; i <= 48; i++) {
    if (i < -taps || i > taps) continue;
    float f = float(i);
    vec3 w = exp(-f * f * k);
    ws += w;
    vec2 uv = v_uv + u_dgDir * f / size;
    if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) acc += texture(${tex}, uv).rgb * w;
  }
  fragColor = vec4(acc / ws, 0.0);
}`;

const FRAG_DG_BLUR_H = blurAxis('u_tlDgPyr');
const FRAG_DG_BLUR_V = blurAxis('u_tlDgH');

/** One term of the sum, tinted toward the tint at its radius (colour replaced, brightest channel kept). */
const accum = (add: string) => /* glsl */ `
void main() {
  vec3 c = texture(u_tlDgPyr, v_uv).rgb;
  if (u_dgTintAmount > 0.0) {
    vec3 tinted = max(c.r, max(c.g, c.b)) * u_dgTint / max(max(u_dgTint.r, max(u_dgTint.g, u_dgTint.b)), 1.0e-4);
    c = mix(c, tinted, u_dgTintAmount);
  }
  fragColor = vec4(${add}c * u_dgWeight, 0.0);
}`;

const FRAG_DG_FIRST = accum('');
const FRAG_DG_ACCUM = accum('texture(u_tlDgAcc, v_uv).rgb + ');

export type DeepGlowPlan = {
	/** The PSF's radius in percent of the unit (standalone: layer px, a unit of 100 px). */
	radius: number;
	falloff: number;
	chroma: number;
	/** Scattered light × this (energy into the glow). */
	intensity: number;
	/** 0..1 toward the tint. */
	tintAmount: number;
	/** The tint at a position over the radius (0 narrowest, 1 widest), linear. */
	tintAt: (t: number) => readonly [number, number, number];
	/** Canvas px per percent of the unit (an upper bound without `unitKnown`). */
	pxPerPercent: number;
	unitKnown: boolean;
	unit: GlslChunk;
	/** Passes may write names an earlier layer wrote (`update`): a look can hold several deep glows. */
	again: boolean;
};

/**
 * The scatter, after a pass that wrote the emitter to `tlDgPyr` (full size, `rgba16f`, alpha unused): the glow ends in
 * `tlDgAcc`, RGB only, at full size. One program per pass kind: only uniforms differ per octave and per frame.
 */
export function deepGlowPasses(o: DeepGlowPlan): ShaderPass[] {
	const fmt = { format: 'rgba16f' as const };
	const octaves = dgOctaves(o.radius, o.falloff, o.chroma);
	const pxOf = (v: number) => v * o.pxPerPercent;
	const active = octaves.filter((c) => pxOf(Math.max(...c.sigma)) >= DG_MERGE_SIGMA);
	const merged = octaves.filter((c) => !active.includes(c));
	const direct = merged.reduce((s, c) => s + c.weight, 0);
	const tint = (t: number) => ({ u_dgTint: [...o.tintAt(t)] as [number, number, number] });
	const passes: ShaderPass[] = [
		{
			output: 'tlDgAcc',
			...(o.again ? { update: true } : {}),
			...fmt,
			frag: FRAG_DG_FIRST,
			uniforms: {
				u_dgWeight: direct * o.intensity,
				u_dgTintAmount: o.tintAmount,
				...tint(merged.at(-1)?.t ?? 0),
			},
		},
	];
	let level = 0;
	let prev: [number, number, number] = [0, 0, 0];
	/** Canvas px²: the bilinear read the previous octave's blur already counted on. */
	let upPrev = 0;
	active.forEach((c, i) => {
		// Without a known unit the plan's σ is an upper bound: three levels finer keep small alpha bounds right.
		const narrow = pxOf(Math.min(...c.sigma)) / DG_LEVEL_SIGMA;
		const fit = Math.max(0, Math.floor(Math.log2(Math.max(1, narrow))));
		const target = Math.max(level, o.unitKnown ? fit : Math.max(0, fit - 3));
		let down = 0;
		while (level < target) {
			down += 4 ** level / 4; // a 2×2 box: ¼ texel² per axis at the level it reads
			level++;
			passes.push({ output: 'tlDgPyr', update: true, ...fmt, scale: 1 / 2 ** level, frag: FRAG_DG_DOWN });
		}
		const scale = 1 / 2 ** level;
		// The accumulation reads this level bilinearly: a tent, 1/6 texel² per axis.
		const up = level > 0 ? 4 ** level / 6 : 0;
		const uniforms = { u_dgSigma: c.sigma, u_dgPrev: prev, u_dgVar: down + up - upPrev };
		passes.push(
			{
				output: 'tlDgH',
				...(o.again || i > 0 ? { update: true } : {}),
				...fmt,
				scale,
				include: [o.unit],
				frag: FRAG_DG_BLUR_H,
				uniforms: { ...uniforms, u_dgDir: [1, 0] },
			},
			{
				output: 'tlDgPyr',
				update: true,
				...fmt,
				scale,
				include: [o.unit],
				frag: FRAG_DG_BLUR_V,
				uniforms: { ...uniforms, u_dgDir: [0, 1] },
			},
			{
				output: 'tlDgAcc',
				update: true,
				...fmt,
				frag: FRAG_DG_ACCUM,
				uniforms: { u_dgWeight: c.weight * o.intensity, u_dgTintAmount: o.tintAmount, ...tint(c.t) },
			},
		);
		prev = c.sigma;
		upPrev = up;
	});
	return passes;
}

/** The tint of a position over the radius from a flat or gradient paint (role colours resolved), linear. */
export function dgTintOf(paint: Paint, palette: Record<Role, RGBA>): (t: number) => [number, number, number] {
	const rgb = (c: readonly number[]): [number, number, number] => {
		const a = Math.max(c[3] ?? 1, 1.0e-4);
		return [c[0]! / a, c[1]! / a, c[2]! / a];
	};
	if (paint.kind === 'gradient') {
		const ramp = gradientRamp(paint.gradient, palette);
		return (t) => {
			const i = Math.round(clamp(t, 0, 1) * (RAMP_SIZE - 1)) * 4;
			return rgb([ramp[i]!, ramp[i + 1]!, ramp[i + 2]!, ramp[i + 3]!]);
		};
	}
	if (paint.kind === 'source') return () => [1, 1, 1];
	const c = linearPremultiplied(paint.kind === 'role' ? palette[paint.role] : (paint.color as RGBA));
	return () => rgb(c);
}

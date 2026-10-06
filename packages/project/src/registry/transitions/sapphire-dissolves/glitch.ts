// Sapphire-style glitch dissolves: S_DissolveDigitalDamage (digital transmission damage that flares up around the
// cut), S_DissolvePixelMosh (a datamosh: the outgoing clip's pixels are dragged by the macroblock motion that maps it
// onto the incoming clip) and S_DissolvePixelSort (the dissolve's pixels are sorted along lines, rays or circles,
// most at the peak). Parameters follow Boris FX's public Sapphire documentation; clean-room implementations.
//
// Reuse: S_DissolveDigitalDamage shares S_DigitalDamage's param names and its per-frame blink gates
// (`digitalDamageGates`) and film-damage GLSL helpers (`GLSL_FILM`) from the Sapphire film / grain family.
// Approximations (a transition only has the two current pictures, no earlier frames):
// - DigitalDamage: "frozen" and "flowing" blocks show the OTHER clip (stale frames across the cut) instead of an
//   earlier frame of the same clip;
// - PixelMosh: the motion field is the block matching from A to B (where each block of B is found in A), not the
//   frame-to-frame optical flow; A is advected along it towards B's layout (B "built from A's pixels") before the
//   quick cut, and B settles from the reverse field after it. The time-based hold / pulse controls of S_PixelMosh
//   do not apply;
// - PixelSort: computed at ≤ ½ resolution (Downsample / Sort Resolution lower it further), spans ≤ 192 steps.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { fxParam } from '../../fx/params.ts';
import { digitalDamageGates } from '../../fx/sapphire-film-grain/digital.ts';
import { GLSL_FILM } from '../../fx/sapphire-film-grain/glsl.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import {
	blurPasses,
	blurPx,
	check,
	clamp,
	defineDissolve,
	dissolveTiming,
	GLSL_SD,
	GLSL_SD_NOISE,
	grp,
	intSlider,
	num,
	sapphirePoint,
	seed,
	slider,
} from './common.ts';

// ---------------------------------------------------------------- S_DissolveDigitalDamage

const gate = (name: string, label: string, blink: number, always: number) => [
	slider(`${name}BlinkFreq`, `${label} Blink Freq`, blink, { min: 0.1, softMax: 30 }),
	slider(`${name}Always`, `${label} Always`, always, { min: 0, max: 1 }),
];

const DAMAGE_PARAMS: ParamSpec[] = [
	slider('intensity', 'Intensity', 1, { min: 0, softMax: 3 }),
	slider('timeIntensity', 'Time Intensity', 1, { min: 0, softMax: 3 }),
	slider('damageSize', 'Damage Size', 1, { min: 0.001, softMax: 4 }),
	slider('damageSizeRelX', 'Damage Size Rel X', 1, { min: 0.001, softMax: 4 }),
	...grp('Freeze', [
		check('freeze', 'Freeze', true),
		slider('freezeThreshold', 'Freeze Threshold', 0.09, { min: 0, max: 1 }),
		slider('freezeSaturation', 'Freeze Saturation', 2.5, { min: 0, softMax: 4 }),
		slider('freezeQuality', 'Freeze Quality', 0.1, { min: 0, softMax: 1 }),
		slider('freezeErrs', 'Freeze Errs', 0.05, { min: 0, softMax: 1 }),
		intSlider('freezeFrames', 'Freeze Frames', 10, 0, 20),
		...gate('freeze', 'Freeze', 15, 0.3),
	]),
	...grp('Shift', [
		check('shift', 'Shift', true),
		slider('shiftAmount', 'Shift Amount', 0.1, { min: 0, softMax: 2 }),
		slider('shiftThreshold', 'Shift Threshold', 0.3, { min: 0, max: 1 }),
		...gate('shift', 'Shift', 10, 0.3),
	]),
	...grp('Brights Noise', [
		check('brightsNoise', 'Brights Noise', true),
		slider('brightsThreshold', 'Brights Threshold', 0.6, { min: 0, max: 1 }),
		slider('brightsBandThreshold', 'Brights Band Threshold', 0.4, { min: 0, max: 1 }),
		slider('brightsBandFreq', 'Brights Band Freq', 6, { min: 0.1, softMax: 30 }),
		...gate('brights', 'Brights', 10, 0.23),
	]),
	...grp('Pixelate', [
		check('pixelate', 'Pixelate', true),
		slider('pixelateFrequency', 'Pixelate Frequency', 40, { min: 1, softMax: 200 }),
		slider('pixelateHold', 'Pixelate Hold', 0.95, { min: 0, max: 1 }),
		slider('pixelateThreshold', 'Pixelate Threshold', 0.1, { min: 0, max: 1 }),
		slider('pixelateOverdrive', 'Pixelate Overdrive', 1.6, { min: 0, softMax: 4 }),
		...gate('pixelate', 'Pixelate', 10, 0.15),
	]),
	...grp('Block Noise', [
		check('blockNoise', 'Block Noise', true),
		slider('blocksIntensity', 'Blocks Intensity', 1, { min: 0, softMax: 1 }),
		slider('blocksThreshold', 'Blocks Threshold', 0.4, { min: 0, max: 1 }),
		slider('blocksSoftness', 'Blocks Softness', 0.2, { min: 0, softMax: 1 }),
		slider('blocksChroma', 'Blocks Chroma', 0.95, { min: 0, max: 1 }),
		...gate('blocks', 'Blocks', 10, 0.15),
		slider('blocksAffectAlpha', 'Blocks Affect Alpha', 0, { min: 0, softMax: 1 }),
	]),
	...grp('Invert', [
		check('invert', 'Invert', true),
		slider('invertThreshold', 'Invert Threshold', 0.35, { min: 0, max: 1 }),
		slider('invertDarken', 'Invert Darken', 0.4, { min: 0, softMax: 1 }),
		slider('invertPatternFreq', 'Invert Pattern Freq', 2, { min: 0.1, softMax: 20 }),
		...gate('invert', 'Invert', 10, 0.21),
	]),
	...grp('Flow', [
		check('flow', 'Flow', true),
		slider('flowBlockFreq', 'Flow Block Freq', 4, { min: 0.1, softMax: 20 }),
		slider('flowDamageAmount', 'Flow Damage Amount', 1, { min: 0, softMax: 3 }),
		slider('flowThreshold', 'Flow Threshold', 0.6, { min: 0, max: 1 }),
		slider('flowSpeed', 'Flow Speed', 1, { min: 0, softMax: 4 }),
		...gate('flow', 'Flow', 8, 0.2),
	]),
	seed(),
];

/** Uniforms of a frame: blink gates (S_DigitalDamage's), the damage intensity on the envelope, block size. */
export function digitalDamageUniforms(
	p: EffectParams,
	ctx: { frame: number; fps: number; seed: number; width: number; progress: number },
) {
	const d = dissolveTiming(p, ctx.progress);
	const size = 16 * Math.max(0.001, num(p.damageSize, 1)) * (Math.max(1, ctx.width) / 1920);
	const n = Math.round(num(p.freezeFrames, 10));
	return {
		...digitalDamageGates(p, ctx),
		u_damage: Math.max(0, num(p.intensity, 1)) * d.env,
		u_blockPx: [Math.max(1, size * Math.max(0.001, num(p.damageSizeRelX, 1))), Math.max(1, size)] as [
			number,
			number,
		],
		u_frameInHold: n <= 1 ? 0 : ((Math.floor(ctx.frame) % n) + n) % n,
	};
}

export const S_DISSOLVE_DIGITAL_DAMAGE: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-digital-damage',
	label: 'S_DissolveDigitalDamage',
	description:
		'Dissolves through bad digital transmission: frozen and flowing blocks, shifted rows, noise in the brights, pixelation, satellite block noise and inverted bands flare up around the cut, each kind blinking on and off.',
	keywords: ['digital damage', 'glitch', 'corruption', 'macroblock', 'signal', 'datamosh', 'dissolve'],
	timing: { speed: 1, slow: [0.2, 0.2] },
	params: DAMAGE_PARAMS,
	gpu: {
		uniforms: (p, ctx) => digitalDamageUniforms(p, ctx),
		passes: [
			{
				include: [GLSL_SD, GLSL_FILM],
				frag: /* glsl */ `
// Coherent damage regions over the block grid: 1 where the damage of a kind applies (needs u_damage > 0).
float region(vec2 blk, float threshold, float epoch, float k, float scale) {
  uint s = sfg_seedU(u_seed) ^ sfd_uu(int(epoch) * 31 + int(k) * 7919);
  float n = sfd_noise2(blk / scale, s) * 0.5 + 0.5;
  n = n * 0.75 + 0.25 * sfd_u8(sfd_h(ivec3(ivec2(blk), int(k)), s)).x;
  return step(0.5 + threshold * 0.5, n * u_damage);
}
// The dissolve at uv, and the "stale" picture: the other side of the cut.
vec4 cur(vec2 uv) { return mix(tr_from(uv), tr_to(uv), u_sdMix); }
vec4 stale(vec2 uv) { return u_sdT < 0.5 ? tr_to(uv) : tr_from(uv); }
void main() {
  vec4 src = cur(v_uv);
  if (u_damage <= 0.0) { fragColor = src; return; }
  vec2 box = u_compSize;
  vec2 p = tr_px();
  vec2 bsz = u_blockPx;
  vec2 blk = floor(p / bsz);
  vec2 n = v_uv;
  bool frozen = false;
  float fz = u_freeze && u_on_freeze > 0.5 ? region(blk, u_freezeThreshold, u_epoch_freeze, 1.0, 3.0) : 0.0;
  frozen = fz > 0.5;
  if (u_flow && u_on_flow > 0.5) {
    vec2 fb = floor(p / (bsz * u_flowBlockFreq * 0.5 + 1.0));
    if (region(fb, u_flowThreshold, u_epoch_flow, 7.0, 2.0) > 0.5) {
      vec4 r = sfd_u8(sfd_h(ivec3(ivec2(fb), 77), sfg_seedU(u_seed) ^ sfd_uu(int(u_epoch_flow))));
      n -= (r.xy - 0.5) * 2.0 * u_flowSpeed * u_flowDamageAmount * 0.02 * (u_frameInHold + 1.0) * vec2(1.0, box.x / box.y);
      frozen = true;
    }
  }
  if (u_shift && u_on_shift > 0.5) {
    float sh = region(vec2(0.0, blk.y), u_shiftThreshold, u_epoch_shift, 2.0, 1.5);
    float r = sfd_u8(sfd_h(ivec3(0, int(blk.y), 2), sfg_seedU(u_seed) ^ sfd_uu(int(u_epoch_shift)))).x;
    n.x += sh * (r - 0.5) * 2.0 * u_shiftAmount * u_damage;
  }
  vec2 uv = n;
  float pxl = 0.0;
  if (u_pixelate && u_on_pixelate > 0.5) {
    float ep = floor(u_epoch_pixelate * (1.0 - clamp(u_pixelateHold, 0.0, 0.99)));
    pxl = region(blk, u_pixelateThreshold, ep, 4.0, 4.0);
    if (pxl > 0.5) {
      vec2 cell = vec2(box.x / max(u_pixelateFrequency, 1.0));
      uv = (floor(n * box / cell) + 0.5) * cell / box;
    }
  }
  vec4 s = frozen ? stale(uv) : cur(uv);
  vec3 c = s.a > 0.0 ? clamp(s.rgb / s.a, 0.0, 1.0) : vec3(0.0);
  float alpha = s.a;
  if (pxl > 0.5) c = clamp((c - 0.5) * u_pixelateOverdrive + 0.5, 0.0, 1.0);
  if (fz > 0.5) {
    float levels = 3.0 + u_freezeQuality * 60.0;
    c = floor(c * levels + 0.5) / levels;
    c = clamp(mix(vec3(fx_luma(c)), c, u_freezeSaturation), 0.0, 1.0);
    vec4 r = sfd_u8(sfd_h(ivec3(ivec2(blk), 5), sfg_seedU(u_seed) ^ sfd_uu(int(u_epoch_freeze))));
    if (r.x < u_freezeErrs) c = r.yzw;
  }
  if (u_brightsNoise && u_on_brights > 0.5) {
    float band = sfd_noise1(n.y * u_brightsBandFreq * 4.0, sfg_seedU(u_seed) ^ sfd_uu(int(u_epoch_brights))) * 0.5 + 0.5;
    if (band > u_brightsBandThreshold && fx_luma(c) > u_brightsThreshold) {
      vec4 r = sfd_u8(sfd_h(ivec3(ivec2(floor(p / max(1.0, bsz.x * 0.125))), int(u_frame)), sfg_seedU(u_seed)));
      c = mix(c, r.xyz, 0.7 * min(u_damage, 1.0));
    }
  }
  if (u_blockNoise && u_on_blocks > 0.5) {
    if (region(blk, u_blocksThreshold, u_epoch_blocks, 5.0, 2.5) > 0.5) {
      vec4 r = sfd_u8(sfd_h(ivec3(ivec2(floor(p / max(1.0, bsz.x * 0.25))), int(u_frame) + 99), sfg_seedU(u_seed)));
      vec3 noiseC = mix(vec3(r.x), r.xyz, clamp(u_blocksChroma, 0.0, 1.0));
      vec2 f = fract(p / bsz);
      float edge = smoothstep(0.0, max(u_blocksSoftness, 1.0e-3) * 0.5, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      float k = clamp(u_blocksIntensity * mix(1.0, edge, step(1.0e-3, u_blocksSoftness)), 0.0, 1.0);
      c = mix(c, noiseC, k);
      alpha = max(alpha, k * clamp(u_blocksAffectAlpha, 0.0, 1.0));
    }
  }
  if (u_invert && u_on_invert > 0.5) {
    float iv = region(vec2(floor(n.x * u_invertPatternFreq), floor(n.y * u_invertPatternFreq * 4.0)), u_invertThreshold, u_epoch_invert, 6.0, 1.0);
    if (iv > 0.5) c = (1.0 - c) * (1.0 - u_invertDarken);
  }
  fragColor = mix(vec4(c * alpha, alpha), sd_dissolve(), u_mixWithDissolve);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_DissolvePixelMosh

/** Macroblock size in frame px (Block Size X / Y). */
export function moshBlockPx(p: EffectParams): [number, number] {
	return [Math.max(4, Math.round(num(p.blockSizeX, 32))), Math.max(4, Math.round(num(p.blockSizeY, 32)))];
}

const MOSH_RANGE = 48; // encoded motion range (± frame px per unit of the field)

export const S_DISSOLVE_PIXEL_MOSH: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-pixel-mosh',
	label: 'S_DissolvePixelMosh',
	description:
		'A datamosh transition: the macroblocks of the outgoing clip are dragged by the motion that maps them onto the incoming clip (its shapes appear made of the old pixels), then a quick cut leaves the new clip settling out of the smear.',
	keywords: ['pixel mosh', 'datamosh', 'glitch', 'macroblock', 'compression', 'i-frame', 'dissolve'],
	timing: { speed: 5, slow: [0.2, 0.2] },
	params: [
		check('useFlowWarp', 'Use Flow Warp', true),
		intSlider('blockSizeX', 'Block Size X', 32, 4, 256),
		intSlider('blockSizeY', 'Block Size Y', 32, 4, 256),
		slider('flowWarpScale', 'Flow Warp Scale', 2, { softMin: -2, softMax: 4 }),
		slider('blurFlow', 'Blur Flow', 0, { min: 0, softMax: 2 }),
		slider('flowFieldSmoothness', 'Flow Field Smoothness', 0.8, { min: 0, softMax: 1 }),
		slider('flowViewScale', 'Flow View Scale', 0.9, { min: 0, softMax: 4 }),
		seed(),
		fxParam.choice('show', 'Show', ['result', 'flowVectors'], ['Result', 'Flow Vectors'], 'result'),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const t = dissolveTiming(p, ctx.progress).t;
			return {
				u_blockPx: moshBlockPx(p),
				u_blurFlowPx: blurPx(p.blurFlow, ctx.width),
				// The smear builds up over the outgoing half and settles over the incoming half.
				u_moshA: clamp(t * 2, 0, 1),
				u_moshB: clamp(2 - t * 2, 0, 1),
			};
		},
		passes: (p): ShaderPass[] => {
			const [bx, by] = moshBlockPx(p);
			const scale = clamp(1 / Math.min(bx, by), 0.004, 1);
			const enc = (2 * MOSH_RANGE).toFixed(1);
			const decode = `vec2 decodeFlow(vec4 e) { return (e.rg - 0.5) * ${enc}; }`;
			return [
				{
					// Lumas of both sides (¼ resolution): r = A, g = B.
					output: 'lumas',
					scale: 0.25,
					include: [GLSL_SD],
					frag: /* glsl */ `
float lumaOf(vec4 c) { return c.a > 0.0 ? fx_luma(clamp(c.rgb / c.a, 0.0, 1.0)) * c.a : 0.0; }
void main() { fragColor = vec4(lumaOf(tr_from(v_uv)), lumaOf(tr_to(v_uv)), 0.0, 1.0); }`,
				},
				...blurPasses({ input: 'lumas', output: 'lumasB', scale: 0.25, sigma: 'vec2(u_blurFlowPx + 2.0)' }),
				{
					// Block matching: for each block of B, the displacement d (frame px) where A at x − d matches B at x
					// best (SAD of 16 samples; a coarse ±R grid, then refined).
					output: 'motion',
					scale,
					filter: 'nearest',
					frag: /* glsl */ `
float sad(vec2 o, vec2 d) {
  float s = 0.0;
  for (int j = 0; j < 16; j++) {
    vec2 q = o + (vec2(float(j % 4), float(j / 4)) + 0.5) * u_blockPx * 0.25;
    s += abs(texture(u_lumasB, q / u_compSize).g - texture(u_lumasB, (q - d) / u_compSize).r);
  }
  return s;
}
void main() {
  vec2 o = floor(v_uv * u_compSize / u_blockPx) * u_blockPx;
  float R = min(${MOSH_RANGE.toFixed(1)} - 1.0, max(u_blockPx.x, u_blockPx.y) * 1.25);
  float st0 = R / 6.0;
  vec2 best = vec2(0.0);
  float bestCost = sad(o, best);
  for (int i = 0; i < 169; i++) {
    vec2 d = (vec2(float(i % 13), float(i / 13)) - 6.0) * st0;
    float c = sad(o, d) + 0.05 * length(d) / R;
    if (c < bestCost) { bestCost = c; best = d; }
  }
  vec2 centre = best;
  float st1 = st0 / 3.0;
  for (int i = 0; i < 25; i++) {
    vec2 d = centre + (vec2(float(i % 5), float(i / 5)) - 2.0) * st1;
    float c = sad(o, d) + 0.05 * length(d) / R;
    if (c < bestCost) { bestCost = c; best = d; }
  }
  fragColor = vec4(best / ${enc} + 0.5, 0.0, 1.0);
}`,
				},
				{
					// Flow Field Smoothness: each block's vector mixed with the mean of its 3×3 neighbourhood.
					output: 'flow',
					scale,
					filter: 'nearest',
					frag: /* glsl */ `
${decode}
void main() {
  vec2 c = (floor(v_uv * u_compSize / u_blockPx) + 0.5) * u_blockPx;
  vec2 sum = vec2(0.0);
  for (int i = 0; i < 9; i++) {
    vec2 q = clamp(c + (vec2(float(i % 3), float(i / 3)) - 1.0) * u_blockPx, vec2(0.5), u_compSize - 0.5);
    sum += decodeFlow(texture(u_motion, q / u_compSize));
  }
  vec2 v = mix(decodeFlow(texture(u_motion, c / u_compSize)), sum / 9.0, clamp(u_flowFieldSmoothness, 0.0, 1.0));
  fragColor = vec4(v / ${enc} + 0.5, 0.0, 1.0);
}`,
				},
				{
					include: [GLSL_SD],
					frag: /* glsl */ `
${decode}
vec2 flowAt(vec2 px) { return decodeFlow(texture(u_flow, clamp(px, vec2(0.5), u_compSize - 0.5) / u_compSize)); }
void main() {
  vec2 px = tr_px();
  if (u_show == 1) {
    vec2 v = flowAt(px) / ${MOSH_RANGE.toFixed(1)};
    float ang = atan(v.y, v.x) / 6.28318530718 + 0.5;
    fragColor = vec4(fx_hsv2rgb(vec3(ang, clamp(length(v) * u_flowViewScale * 2.0, 0.0, 1.0), 1.0)), 1.0);
    return;
  }
  vec4 a = tr_from(v_uv), b = tr_to(v_uv);
  if (u_useFlowWarp) {
    // A advected along the block field (several small steps: the smear "blooms"), B settling from the reverse field.
    vec2 qa = px, qb = px;
    for (int i = 0; i < 6; i++) {
      qa -= flowAt(qa) * u_flowWarpScale * u_moshA / 6.0;
      qb += flowAt(qb) * u_flowWarpScale * u_moshB / 6.0;
    }
    // Clamped to the frame: a smear pulls the edge pixels in rather than transparency.
    a = tr_from(clamp(qa, vec2(0.5), u_compSize - 0.5) / u_compSize);
    b = tr_to(clamp(qb, vec2(0.5), u_compSize - 0.5) / u_compSize);
  }
  fragColor = mix(mix(a, b, u_sdMix), sd_dissolve(), u_mixWithDissolve);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- S_DissolvePixelSort

export const SORT_TYPES = [
	'monochrome',
	'average',
	'minimum',
	'maximum',
	'red',
	'green',
	'blue',
	'hue',
	'saturation',
	'brightness',
] as const;
const SORT_TYPE_LABELS = [
	'Monochrome',
	'Average',
	'Minimum',
	'Maximum',
	'Red',
	'Green',
	'Blue',
	'Hue',
	'Saturation',
	'Brightness',
] as const;

/** Resolution of the sort pass: ½, or Sort Resolution lines of the frame height with Downsample. */
export function sortScale(p: EffectParams, height: number): number {
	if (p.downsample !== true) return 0.5;
	return clamp(Math.round(num(p.sortResolution, 720)) / Math.max(1, height), 0.05, 0.5);
}

/** The sort threshold of a frame: nothing sorted at the ends, Max Percentage of the key range at the peak. */
export function sortThreshold(p: EffectParams, env: number): number {
	const k = clamp(Math.max(0, num(p.maxPercentage, 1)) * env, 0, 1);
	return p.sortDirection === 'below' ? k : 1 - k;
}

const SORT_GLSL = /* glsl */ `
const int SORT_MAXL = 192;
const int SORT_BINS = 32;
int g_line;
float g_L;
vec2 g_o, g_dir, g_perp;
float g_theta, g_rr, g_a0;
int g_n;
// Position (frame px) of step t of the current line.
vec2 ps_pos(int t) {
  float ft = float(t) + 0.5;
  if (u_mode == 0) return g_o + ft * g_L * g_dir + (float(g_line) + 0.5) * g_L * g_perp;
  if (u_mode == 1) return g_o + ft * g_L * vec2(cos(g_theta), sin(g_theta));
  float a = g_a0 + ft / float(g_n) * 6.28318530718;
  return g_o + g_rr * vec2(cos(a), sin(a));
}
bool ps_region(int t) {
  float unit = sd_unit();
  if (u_mode == 1) {
    float r = (float(t) + 0.5) * g_L / unit;
    float start = u_innerRadius + u_varyRadius * sd_h2(ivec2(g_line, 3), sd_seedU(u_seed)) * u_rayLength;
    float deg = mod(degrees(g_theta) - u_startAngle, 360.0);
    return r >= start && r <= start + u_rayLength && deg <= u_degreesSorted;
  }
  if (u_mode == 2) {
    float r = g_rr / unit;
    float arc = (float(t) + 0.5) / float(g_n) * 360.0;
    return t >= 0 && t < g_n && r >= u_circleInnerRadius && r <= u_circleInnerRadius + u_thickness && arc <= u_circleDegreesSorted;
  }
  return true;
}
// Sort key of step t, or −1 when it is not sortable (outside the frame, the region or the threshold mask).
float ps_key(int t) {
  if (!ps_region(t)) return -1.0;
  vec2 p = ps_pos(t);
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, u_compSize))) return -1.0;
  vec4 k = texture(u_keys, p / u_compSize);
  return k.g > 0.5 ? k.r : -1.0;
}
bool ps_break(int t) {
  float prob = u_randomlyRestartSort / 20000.0 * g_L;
  if (sd_h3(ivec3(g_line, t, 17), sd_seedU(u_seed)) < prob) return true;
  int phase = int(sd_h2(ivec2(g_line, 5), sd_seedU(fract(u_seed + 0.37))) * float(SORT_MAXL));
  return (t + phase + 1048576) % SORT_MAXL == 0;
}
int ps_bin(float k) { return clamp(int(k * float(SORT_BINS)), 0, SORT_BINS - 1); }
void main() {
  vec2 p = tr_px();
  g_L = u_compSize.x / u_resolution.x;
  int t0;
  if (u_mode == 0) {
    g_o = 0.5 * u_compSize;
    float a = radians(u_sortAngle);
    g_dir = vec2(cos(a), sin(a));
    g_perp = vec2(-g_dir.y, g_dir.x);
    vec2 d = p - g_o;
    g_line = int(floor(dot(d, g_perp) / g_L));
    t0 = int(floor(dot(d, g_dir) / g_L));
  } else if (u_mode == 1) {
    g_o = u_center * u_compSize;
    vec2 d = p - g_o;
    float n = ceil(6.28318530718 * length(u_compSize) / g_L);
    float th = atan(d.y, d.x) + 3.14159265359;
    g_line = int(floor(th / 6.28318530718 * n));
    g_theta = (float(g_line) + 0.5) / n * 6.28318530718 - 3.14159265359;
    t0 = int(floor(length(d) / g_L));
  } else {
    g_o = u_circleCenter * u_compSize;
    vec2 d = p - g_o;
    g_line = int(floor(length(d) / g_L));
    g_rr = (float(g_line) + 0.5) * g_L;
    g_n = max(1, int(floor(6.28318530718 * g_rr / g_L)));
    g_a0 = radians(u_circleStartAngle + u_varyStart * 360.0 * (sd_h2(ivec2(g_line, 9), sd_seedU(u_seed)) - 0.5));
    float rel = mod(atan(d.y, d.x) - g_a0, 6.28318530718);
    t0 = int(floor(rel / 6.28318530718 * float(g_n)));
  }
  vec4 src = texture(u_src, v_uv);
  if (u_sortThreshold >= 1.0 && u_sortDirection == 0 || u_sortThreshold <= 0.0 && u_sortDirection == 1 || ps_key(t0) < 0.0) {
    fragColor = src;
    return;
  }
  int s = t0;
  for (int i = 1; i < SORT_MAXL; i++) {
    int t = t0 - i;
    if (ps_break(t + 1) || ps_key(t) < 0.0) break;
    s = t;
  }
  float hist[SORT_BINS];
  for (int b = 0; b < SORT_BINS; b++) hist[b] = 0.0;
  int e = s;
  for (int i = 0; i < SORT_MAXL; i++) {
    int t = s + i;
    float k = ps_key(t);
    if (i > 0 && (k < 0.0 || ps_break(t))) break;
    hist[ps_bin(k)] += 1.0;
    e = t + 1;
  }
  int idx = t0 - s;
  float acc = 0.0;
  int bin = 0;
  for (int i = 0; i < SORT_BINS; i++) {
    int b = u_reverseSortDirection ? SORT_BINS - 1 - i : i;
    bin = b;
    if (acc + hist[b] > float(idx)) break;
    acc += hist[b];
  }
  int want = idx - int(acc);
  vec4 col = src;
  for (int i = 0; i < SORT_MAXL; i++) {
    int t = s + i;
    if (t >= e) break;
    if (ps_bin(ps_key(t)) == bin) {
      if (want == 0) { col = texture(u_src, ps_pos(t) / u_compSize); break; }
      want--;
    }
  }
  fragColor = col;
}`;

export const S_DISSOLVE_PIXEL_SORT: TransitionSpec = defineDissolve({
	id: 'jasper.s.dissolve-pixel-sort',
	label: 'S_DissolvePixelSort',
	description:
		'Sorts the pixels of the dissolve along lines (Linear), rays from a centre (Radial) or circles (Circular): more and more pixels above (or below) a moving threshold are sorted towards the peak, then the sort unwinds onto the incoming clip.',
	keywords: ['pixel sort', 'sorting', 'glitch', 'databend', 'streaks', 'dissolve'],
	timing: { speed: 5 },
	params: [
		fxParam.choice(
			'mode',
			'Mode',
			['linear', 'radial', 'circular'],
			['DissolvePixelSortLinear', 'DissolvePixelSortRadial', 'DissolvePixelSortCircular'],
			'linear',
		),
		slider('maxPercentage', 'Max Percentage', 1, { min: 0, softMax: 1 }),
		fxParam.angle('sortAngle', 'Sort Angle', 0),
		fxParam.point('center', 'Center', sapphirePoint(0, 0)),
		fxParam.angle('startAngle', 'Start Angle', 0),
		slider('degreesSorted', 'Degrees Sorted', 360, { min: 0, max: 360, step: 0.1 }),
		slider('innerRadius', 'Inner Radius', 0, { min: 0, softMax: 2 }),
		slider('rayLength', 'Ray Length', 1, { min: 0, softMax: 3 }),
		slider('varyRadius', 'Vary Radius', 0, { min: 0, max: 1 }),
		fxParam.angle('circleStartAngle', 'Circle Start Angle', 0),
		slider('circleDegreesSorted', 'Circle Degrees Sorted', 360, { min: 0, max: 360, step: 0.1 }),
		fxParam.point('circleCenter', 'Circle Center', sapphirePoint(0, 0)),
		slider('varyStart', 'Vary Start', 0, { min: 0, max: 1 }),
		slider('circleInnerRadius', 'Circle Inner Radius', 0, { min: 0, softMax: 2 }),
		slider('thickness', 'Thickness', 1, { min: 0, softMax: 3 }),
		fxParam.choice(
			'sortDirection',
			'Sort Direction',
			['above', 'below'],
			['Sort Above Threshold', 'Sort Below Threshold'],
			'above',
		),
		check('reverseSortDirection', 'Reverse Sort Direction', false),
		slider('randomlyRestartSort', 'Randomly Restart Sort', 100, { min: 0, max: 1000, step: 1 }),
		fxParam.choice('sortType', 'Sort Type', SORT_TYPES, SORT_TYPE_LABELS, 'monochrome'),
		seed(),
		slider('softenThresholdMask', 'Soften Threshold Mask', 0.1, { min: 0, softMax: 1 }),
		check('downsample', 'Downsample', false),
		fxParam.number(
			'sortResolution',
			'Sort Resolution',
			720,
			{ min: 16, max: 8192, step: 1 },
			{ animatable: false },
		),
		fxParam.choice(
			'show',
			'Show',
			['result', 'rawSortValues', 'thresholdMask'],
			['Result', 'Raw Sort Values', 'Threshold Mask'],
			'result',
		),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const d = dissolveTiming(p, ctx.progress);
			return {
				u_sortThreshold: sortThreshold(p, d.env),
				u_softenPx: Math.max(0, num(p.softenThresholdMask, 0.1)) * 0.02 * ctx.width,
			};
		},
		passes: (p, ctx): ShaderPass[] => {
			const scale = sortScale(p, ctx.height);
			return [
				{
					// The dissolve at the sort resolution.
					output: 'src',
					scale,
					frag: /* glsl */ `
void main() { fragColor = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix); }`,
				},
				{
					// r = sort key, g = threshold mask.
					output: 'keys',
					scale,
					filter: 'nearest',
					include: [GLSL_SD],
					frag: /* glsl */ `
void main() {
  vec4 s = texture(u_src, v_uv);
  vec3 c = s.a > 0.0 ? clamp(s.rgb / s.a, 0.0, 1.0) : vec3(0.0);
  vec3 hsv = fx_rgb2hsv(c);
  int t = u_sortType;
  float k = t == 0 ? fx_luma(c) : t == 1 ? (c.r + c.g + c.b) / 3.0 : t == 2 ? min(c.r, min(c.g, c.b))
          : t == 3 ? max(c.r, max(c.g, c.b)) : t == 4 ? c.r : t == 5 ? c.g : t == 6 ? c.b
          : t == 7 ? hsv.x : t == 8 ? hsv.y : hsv.z;
  bool pass = u_sortDirection == 0 ? k > u_sortThreshold : k < u_sortThreshold;
  fragColor = vec4(clamp(k, 0.0, 1.0), pass && s.a > 0.0 ? 1.0 : 0.0, 0.0, 1.0);
}`,
				},
				...blurPasses({ input: 'keys', output: 'soft', scale, sigma: 'vec2(u_softenPx, 0.0)' }),
				{
					output: 'sorted',
					scale,
					include: [GLSL_SD, GLSL_SD_NOISE],
					frag: SORT_GLSL,
				},
				{
					include: [GLSL_SD],
					frag: /* glsl */ `
void main() {
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), u_sdMix);
  vec4 k = texture(u_keys, v_uv);
  if (u_show == 1) { fragColor = vec4(vec3(k.r), 1.0); return; }
  if (u_show == 2) { fragColor = vec4(vec3(k.g), 1.0); return; }
  float soft = clamp(texture(u_soft, v_uv).g, 0.0, 1.0);
  vec4 sorted = sd_bicubic(u_sorted, v_uv);
  fragColor = mix(mix(base, sorted, soft), sd_dissolve(), u_mixWithDissolve);
}`,
				},
			];
		},
	},
});

export const GLITCH_DISSOLVES = [
	S_DISSOLVE_DIGITAL_DAMAGE,
	S_DISSOLVE_PIXEL_MOSH,
	S_DISSOLVE_PIXEL_SORT,
] as const;

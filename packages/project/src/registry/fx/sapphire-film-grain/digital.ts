// Sapphire damage looks — digital: S_JpegDamage (a real 8×8 DCT → quantise → IDCT round trip in four separable
// passes, with frequency-band scaling and random decode errors) and S_DigitalDamage (bad digital transmission:
// frozen blocks from an earlier frame, shifted rows, bright-area noise, pixelation, satellite block noise, inverted
// bands, MPEG-style flowing blocks). Parameter names, order and defaults follow Boris FX's public Sapphire reference.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import type { FxUniformValue, ShaderPass } from '../shader.ts';
import { check, grp, intSlider, mixParam, num, sapphireSeed, slider, stepNoise1 } from './common.ts';
import { GLSL_FILM } from './glsl.ts';

const STYLIZE = SAPPHIRE_BINS.stylize;

// ---------------------------------------------------------------- S_JpegDamage

/** Standard JPEG quantisation tables (ITU T.81 Annex K), row-major (v, u). */
const LUMA_Q = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22,
	29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103,
	121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
	17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99,
	99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** libjpeg's quality scaling: quality 0..1 → the factor applied to the tables (percent). */
export function jpegQualityScale(quality: number): number {
	const q = Math.min(100, Math.max(1, quality * 100));
	return q < 50 ? 5000 / q : 200 - 2 * q;
}

/** Quantiser steps (0..1 signal units) of the luma and chroma tables for a quality. */
export function jpegSteps(quality: number): { luma: number[]; chroma: number[] } {
	const s = jpegQualityScale(quality);
	const step = (t: number) => Math.max(1, Math.floor((t * s + 50) / 100)) / 255;
	return { luma: LUMA_Q.map(step), chroma: CHROMA_Q.map(step) };
}

/** GLSL shared by the four DCT passes: cell grid of the layer, cell sampling, the DCT basis. */
const JPEG_COMMON = /* glsl */ `
// Cell (macro pixel) of layer px p: the image is processed at 1/Res Factor (cells of u_cellPx layer px).
ivec2 sjd_cell(vec2 p) { return ivec2(floor(p / u_cellPx)); }
vec2 sjd_uvOfCell(ivec2 c) { return fx_uvOfLayerPx((vec2(c) + 0.5) * u_cellPx); }
float sjd_basis(int k, int x) {
  float ck = k == 0 ? 0.70710678 : 1.0;
  return 0.5 * ck * cos(float(2 * x + 1) * float(k) * 0.19634954);
}
// coefficients are stored encoded so they fit any target format: e = F / 8 + 0.5
vec3 sjd_dec(vec4 e) { return (e.rgb - 0.5) * 8.0; }
vec4 sjd_enc(vec3 f) { return vec4(f / 8.0 + 0.5, 1.0); }
`;

const JPEG_ROW_DCT = /* glsl */ `${JPEG_COMMON}
vec3 sjd_ycc(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y - 0.5, (c.b - y) * 0.564, (c.r - y) * 0.713);
}
void main() {
  ivec2 c = sjd_cell(fx_layerPx());
  int u = ((c.x % 8) + 8) % 8;
  int bx = c.x - u;
  vec3 acc = vec3(0.0);
  for (int x = 0; x < 8; x++) {
    vec4 s = texture(u_source, sjd_uvOfCell(ivec2(bx + x, c.y)));
    acc += sjd_ycc(fx_unpremultiply(s).rgb) * sjd_basis(u, x);
  }
  fragColor = sjd_enc(acc);
}`;

const JPEG_COL_DCT_QUANT = /* glsl */ `${JPEG_COMMON}
float sjd_band(int u, int v) {
  int f = u + v;
  float b = f == 0 ? 1.0 : f <= 2 ? u_lowFreqScale : f <= 7 ? u_midFreqScale : u_highFreqScale;
  if (f > 0) b *= u_allFreqScale * mix(1.0, u_xFreqScale, float(u) / 7.0) * mix(1.0, u_yFreqScale, float(v) / 7.0);
  return b;
}
void main() {
  ivec2 c = sjd_cell(fx_layerPx());
  int v = ((c.y % 8) + 8) % 8;
  int by = c.y - v;
  int u = ((c.x % 8) + 8) % 8;
  vec3 G = vec3(0.0);
  for (int y = 0; y < 8; y++) G += sjd_dec(texture(u_prev, sjd_uvOfCell(ivec2(c.x, by + y)))) * sjd_basis(v, y);
  int k = v * 8 + u;
  vec3 q = vec3(u_lumaQ[k], u_chromaQ[k], u_chromaQ[k]);
  vec3 Gq = floor(G / q + 0.5) * q;
  G = mix(G, Gq, vec3(clamp(u_affectLuma, 0.0, 1.0), clamp(u_affectChroma, 0.0, 1.0), clamp(u_affectChroma, 0.0, 1.0)));
  G *= sjd_band(u, v);
  // decode errors: damaged blocks (clustered by Error Coherence) get wrong coefficients
  if (u_errorP > 0.0) {
    ivec2 blk = ivec2(c.x - u, by) / 8;
    uint s = sfg_seedU(u_seed) ^ fx_u(int(u_errFrame));
    float coh = max(u_errorCoherence, 0.0);
    float field = coh > 0.0 ? sfd_noise2(vec2(blk) / (1.0 + 3.0 * coh), s) * 0.5 + 0.5 : 0.5;
    vec4 r = sfd_u8(sfd_h(ivec3(blk, 1), s));
    float pBlock = u_errorP * mix(1.0, field * 2.0, min(coh, 1.0));
    if (r.x < pBlock && r.y < u_errBlockDensity + 0.25) {
      vec4 e = sfd_u8(sfd_h(ivec3(blk * 8 + ivec2(u, v), 2), s));
      float amp = u_errorAmp * (k == 0 ? 1.5 : 0.6 / (1.0 + float(u + v) * 0.3));
      G += (e.xyz - 0.5) * amp * (r.z < 0.5 ? 1.0 : 2.5);
    }
  }
  fragColor = sjd_enc(G);
}`;

const JPEG_COL_IDCT = /* glsl */ `${JPEG_COMMON}
void main() {
  ivec2 c = sjd_cell(fx_layerPx());
  int y = ((c.y % 8) + 8) % 8;
  int by = c.y - y;
  vec3 f = vec3(0.0);
  for (int v = 0; v < 8; v++) f += sjd_dec(texture(u_prev, sjd_uvOfCell(ivec2(c.x, by + v)))) * sjd_basis(v, y);
  fragColor = sjd_enc(f);
}`;

const JPEG_ROW_IDCT = /* glsl */ `${JPEG_COMMON}
void main() {
  vec4 src = texture(u_source, v_uv);
  ivec2 c = sjd_cell(fx_layerPx());
  int x = ((c.x % 8) + 8) % 8;
  int bx = c.x - x;
  vec3 f = vec3(0.0);
  for (int u = 0; u < 8; u++) f += sjd_dec(texture(u_prev, sjd_uvOfCell(ivec2(bx + u, c.y)))) * sjd_basis(u, x);
  float yy = f.x + 0.5;
  vec3 rgb = vec3(yy + 1.403 * f.z, yy - 0.344 * f.y - 0.714 * f.z, yy + 1.773 * f.y);
  rgb = mix(vec3(fx_luma(rgb)), rgb, u_saturation);
  rgb = sfg_lights(rgb, u_scaleLights, u_offsetDarks);
  fragColor = sfg_out(rgb, src, u_mixWithOriginal);
}`;

export const S_JPEG_DAMAGE = defineShaderEffect({
	id: 'jasper.s.jpeg-damage',
	label: 'S_JpegDamage',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Real JPEG artefacts: an 8×8 DCT re-encode at a low Quality (blocking, ringing, colour smearing), frequency-band scaling, bigger blocks with Res Factor and random decode errors that change every Jitter Frames.',
	keywords: ['jpeg', 'compression', 'artifact', 'blocky', 'dct', 'glitch', 'digital'],
	expensive: true,
	params: [
		slider('quality', 'Quality', 0.1, 0.01, 1, { step: 0.001 }),
		intSlider('resFactor', 'Res Factor', 1, 1, 64, 16),
		slider('resRelX', 'Res Rel X', 1, 0.01, 16, { softMax: 4 }),
		slider('allFreqScale', 'All Freq Scale', 1, 0, 10, { softMax: 3 }),
		slider('xFreqScale', 'X Freq Scale', 1, 0, 10, { softMax: 3 }),
		slider('yFreqScale', 'Y Freq Scale', 1, 0, 10, { softMax: 3 }),
		slider('lowFreqScale', 'Low Freq Scale', 1, 0, 10, { softMax: 3 }),
		slider('midFreqScale', 'Mid Freq Scale', 1, 0, 10, { softMax: 3 }),
		slider('highFreqScale', 'High Freq Scale', 1, 0, 10, { softMax: 3 }),
		slider('affectLuma', 'Affect Luma', 1, 0, 1),
		slider('affectChroma', 'Affect Chroma', 0.5, 0, 1),
		slider('errorRate', 'Error Rate', 0, 0, 100, { softMax: 5 }),
		slider('errBlockDensity', 'Err Block Density', 0.75, 0, 1),
		slider('errorAmp', 'Error Amp', 1, 0, 10, { softMax: 3 }),
		slider('errorCoherence', 'Error Coherence', 1, 0, 10, { softMax: 3 }),
		intSlider('jitterFrames', 'Jitter Frames', 1, 0, 1000, 30),
		sapphireSeed('Rand Seed'),
		slider('scaleLights', 'Scale Lights', 1, 0, 10, { softMax: 3 }),
		slider('offsetDarks', 'Offset Darks', 0, undefined, undefined, { softMin: -8, softMax: 2 }),
		slider('saturation', 'Saturation', 1, undefined, undefined, { softMin: 0, softMax: 3 }),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const steps = jpegSteps(num(p.quality, 0.1));
			const res = Math.max(1, Math.round(num(p.resFactor, 1)));
			const jit = Math.max(0, Math.round(num(p.jitterFrames, 1)));
			const rate = Math.max(0, num(p.errorRate));
			return {
				u_cellPx: [res * Math.max(0.01, num(p.resRelX, 1)), res],
				u_lumaQ: { floats: steps.luma },
				u_chromaQ: { floats: steps.chroma },
				u_errorP: 1 - Math.exp(-rate * 0.15),
				u_errFrame: jit === 0 ? 0 : Math.floor(ctx.frame / jit),
			};
		},
		passes: () => {
			const fmt = { format: 'rgba16f' as const, filter: 'nearest' as const, include: [GLSL_FILM] };
			return [
				{ output: 'dctRow', frag: JPEG_ROW_DCT, ...fmt },
				{ output: 'dct', frag: JPEG_COL_DCT_QUANT, ...fmt },
				{ output: 'idctCol', frag: JPEG_COL_IDCT, ...fmt },
				{ frag: JPEG_ROW_IDCT, include: [GLSL_FILM] },
			];
		},
	},
});

// ---------------------------------------------------------------- S_DigitalDamage

const DAMAGE_KINDS = ['freeze', 'shift', 'brights', 'pixelate', 'blocks', 'invert', 'flow'] as const;

/** Per-frame on/off state of each damage kind: blinks at its Blink Freq, present an "Always" fraction of the time. */
export function digitalDamageGates(p: EffectParams, ctx: { frame: number; fps: number; seed: number }) {
	const t = ctx.frame / Math.max(1, ctx.fps);
	const ti = Math.max(0, num(p.timeIntensity, 1));
	const kinds: Record<(typeof DAMAGE_KINDS)[number], [string, string, string, number, number]> = {
		freeze: ['freeze', 'freezeBlinkFreq', 'freezeAlways', 15, 0.3],
		shift: ['shift', 'shiftBlinkFreq', 'shiftAlways', 10, 0.3],
		brights: ['brightsNoise', 'brightsBlinkFreq', 'brightsAlways', 10, 0.23],
		pixelate: ['pixelate', 'pixelateBlinkFreq', 'pixelateAlways', 10, 0.15],
		blocks: ['blockNoise', 'blocksBlinkFreq', 'blocksAlways', 10, 0.15],
		invert: ['invert', 'invertBlinkFreq', 'invertAlways', 10, 0.21],
		flow: ['flow', 'flowBlinkFreq', 'flowAlways', 8, 0.2],
	};
	const out: Record<string, FxUniformValue> = {};
	DAMAGE_KINDS.forEach((k, i) => {
		const [on, freq, always, df, da] = kinds[k];
		const enabled = p[on] !== false;
		const period = t * Math.max(0.01, num(p[freq], df));
		const state = stepNoise1(ctx.seed, 50 + i, period) < Math.min(1, num(p[always], da) * ti);
		out[`u_on_${k}`] = enabled && state ? 1 : 0;
		out[`u_epoch_${k}`] = Math.floor(period) % 65536;
	});
	return out;
}

/** Frames since the last held frame (Freeze Frames: holds every Nth frame; ≤ 1 = no hold). */
export function freezeOffset(p: EffectParams, frame: number): number {
	const n = Math.round(num(p.freezeFrames, 10));
	if (n <= 1) return 0;
	return -(((Math.floor(frame) % n) + n) % n);
}

const DIGITAL_FRAG = /* glsl */ `
// coherent damage regions over the block grid: true where the damage of a kind applies
float sdd_region(vec2 blk, float threshold, float epoch, float k, float scale) {
  uint s = sfg_seedU(u_seed) ^ fx_u(int(epoch) * 31 + int(k) * 7919);
  float n = sfd_noise2(blk / scale, s) * 0.5 + 0.5;
  n = n * 0.75 + 0.25 * sfd_u8(sfd_h(ivec3(ivec2(blk), int(k)), s)).x;
  return step(0.5 + threshold * 0.5, n * u_intensity);
}
vec4 sdd_src(vec2 uv, bool frozen) {
  vec4 f = frozen && u_sampleCount > 0 ? fx_sample(0, uv) : vec4(0.0);
  return f.a > 0.0 ? f : texture(u_source, uv);   // no held frame (DOM layers, before the clip): the current one
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  vec2 bsz = u_blockPx;
  vec2 blk = floor(p / bsz);
  vec2 n = fx_layerNorm();
  bool frozen = false;
  // freeze: blocks keep showing an earlier frame (quantised, oversaturated, with wrong-colour blocks)
  float fz = u_freeze && u_on_freeze > 0.5 ? sdd_region(blk, u_freezeThreshold, u_epoch_freeze, 1.0, 3.0) : 0.0;
  frozen = fz > 0.5;
  // flow: MPEG I-frame loss — blocks of the held frame drift (motion vectors without new detail)
  if (u_flow && u_on_flow > 0.5) {
    vec2 fb = floor(p / (bsz * u_flowBlockFreq * 0.5 + 1.0));
    float fl = sdd_region(fb, u_flowThreshold, u_epoch_flow, 7.0, 2.0);
    if (fl > 0.5) {
      vec4 r = sfd_u8(sfd_h(ivec3(ivec2(fb), 77), sfg_seedU(u_seed) ^ fx_u(int(u_epoch_flow))));
      vec2 dir = (r.xy - 0.5) * 2.0;
      n -= dir * u_flowSpeed * u_flowDamageAmount * 0.02 * (u_frameInHold + 1.0) * vec2(1.0, box.x / box.y);
      frozen = true;
    }
  }
  // shift: rows of blocks slide sideways
  if (u_shift && u_on_shift > 0.5) {
    float sh = sdd_region(vec2(0.0, blk.y), u_shiftThreshold, u_epoch_shift, 2.0, 1.5);
    float r = sfd_u8(sfd_h(ivec3(0, int(blk.y), 2), sfg_seedU(u_seed) ^ fx_u(int(u_epoch_shift)))).x;
    n.x += sh * (r - 0.5) * 2.0 * u_shiftAmount * u_intensity;
  }
  // pixelate: coarse pixels in damaged regions (Hold keeps the regions longer)
  vec2 uv = fx_uvOfLayerNorm(n);
  float pxl = 0.0;
  if (u_pixelate && u_on_pixelate > 0.5) {
    float ep = floor(u_epoch_pixelate * (1.0 - clamp(u_pixelateHold, 0.0, 0.99)));
    pxl = sdd_region(blk, u_pixelateThreshold, ep, 4.0, 4.0);
    if (pxl > 0.5) {
      vec2 cell = vec2(box.x / max(u_pixelateFrequency, 1.0));
      uv = fx_uvOfLayerPx((floor(n * box / cell) + 0.5) * cell);
    }
  }
  vec4 s = sdd_src(uv, frozen);
  vec3 c = fx_unpremultiply(s).rgb;
  if (pxl > 0.5) c = clamp((c - 0.5) * u_pixelateOverdrive + 0.5, 0.0, 1.0);
  if (fz > 0.5) {
    float levels = 3.0 + u_freezeQuality * 60.0;
    c = floor(c * levels + 0.5) / levels;
    c = mix(vec3(fx_luma(c)), c, u_freezeSaturation);
    vec4 r = sfd_u8(sfd_h(ivec3(ivec2(blk), 5), sfg_seedU(u_seed) ^ fx_u(int(u_epoch_freeze))));
    if (r.x < u_freezeErrs) c = r.yzw;
  }
  // brights noise: noisy horizontal bands in the bright areas
  if (u_brightsNoise && u_on_brights > 0.5) {
    float band = sfd_noise1(n.y * u_brightsBandFreq * 4.0, sfg_seedU(u_seed) ^ fx_u(int(u_epoch_brights))) * 0.5 + 0.5;
    if (band > u_brightsBandThreshold && fx_luma(c) > u_brightsThreshold) {
      vec4 r = sfd_u8(sfd_h(ivec3(ivec2(floor(p / max(1.0, bsz.x * 0.125))), int(u_frame)), sfg_seedU(u_seed)));
      c = mix(c, r.xyz, 0.7 * u_intensity);
    }
  }
  // block noise: blocks of coloured satellite noise
  if (u_blockNoise && u_on_blocks > 0.5) {
    float b = sdd_region(blk, u_blocksThreshold, u_epoch_blocks, 5.0, 2.5);
    if (b > 0.5) {
      vec4 r = sfd_u8(sfd_h(ivec3(ivec2(floor(p / max(1.0, bsz.x * 0.25))), int(u_frame) + 99), sfg_seedU(u_seed)));
      vec3 noiseC = mix(vec3(r.x), r.xyz, clamp(u_blocksChroma, 0.0, 1.0));
      vec2 f = fract(p / bsz);
      float edge = smoothstep(0.0, max(u_blocksSoftness, 1.0e-3) * 0.5, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      c = mix(c, noiseC, clamp(u_blocksIntensity * mix(1.0, edge, step(1.0e-3, u_blocksSoftness)), 0.0, 1.0));
    }
  }
  // invert: inverted, darkened bands
  if (u_invert && u_on_invert > 0.5) {
    float iv = sdd_region(vec2(floor(n.x * u_invertPatternFreq), floor(n.y * u_invertPatternFreq * 4.0)), u_invertThreshold, u_epoch_invert, 6.0, 1.0);
    if (iv > 0.5) c = (1.0 - c) * (1.0 - u_invertDarken);
  }
  fragColor = sfg_out(c, src, u_mixWithOriginal);
}`;

const gateParams = (name: string, blink: number, always: number) => [
	slider(`${name}BlinkFreq`, `${cap(name)} Blink Freq`, blink, 0, 100, { softMax: 30 }),
	slider(`${name}Always`, `${cap(name)} Always`, always, 0, 1),
];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const S_DIGITAL_DAMAGE = defineShaderEffect({
	id: 'jasper.s.digital-damage',
	label: 'S_DigitalDamage',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Bad digital transmission: frozen blocks of an earlier frame, shifted block rows, noise in the bright areas, pixelation, coloured satellite block noise, inverted bands and MPEG-style flowing blocks — each kind blinking on and off.',
	keywords: ['digital damage', 'glitch', 'datamosh', 'macroblock', 'corruption', 'signal', 'mpeg'],
	expensive: true,
	params: [
		slider('intensity', 'Intensity', 1, 0, 10, { softMax: 3 }),
		slider('timeIntensity', 'Time Intensity', 1, 0, 10, { softMax: 3 }),
		slider('damageSize', 'Damage Size', 1, 0.001, 20, { softMax: 4 }),
		slider('damageSizeRelX', 'Damage Size Rel X', 1, 0.001, 20, { softMax: 4 }),
		{ ...sapphireSeed('Seed') },
		...grp('Freeze', [
			check('freeze', 'Freeze', true),
			slider('freezeThreshold', 'Freeze Threshold', 0.09, 0, 1),
			slider('freezeSaturation', 'Freeze Saturation', 2.5, 0, 10, { softMax: 4 }),
			slider('freezeQuality', 'Freeze Quality', 0.1, 0, 1),
			slider('freezeErrs', 'Freeze Errs', 0.05, 0, 1),
			intSlider('freezeFrames', 'Freeze Frames', 10, 0, 20),
			...gateParams('freeze', 15, 0.3),
		]),
		...grp('Shift', [
			check('shift', 'Shift', true),
			slider('shiftAmount', 'Shift Amount', 0.1, 0, 2),
			slider('shiftThreshold', 'Shift Threshold', 0.3, 0, 1),
			...gateParams('shift', 10, 0.3),
		]),
		...grp('Brights Noise', [
			check('brightsNoise', 'Brights Noise', true),
			slider('brightsThreshold', 'Brights Threshold', 0.6, 0, 1),
			slider('brightsBandThreshold', 'Brights Band Threshold', 0.4, 0, 1),
			slider('brightsBandFreq', 'Brights Band Freq', 6, 0, 100, { softMax: 30 }),
			...gateParams('brights', 10, 0.23),
		]),
		...grp('Pixelate', [
			check('pixelate', 'Pixelate', true),
			slider('pixelateFrequency', 'Pixelate Frequency', 40, 1, 1000, { softMax: 200 }),
			slider('pixelateHold', 'Pixelate Hold', 0.95, 0, 1),
			slider('pixelateThreshold', 'Pixelate Threshold', 0.1, 0, 1),
			slider('pixelateOverdrive', 'Pixelate Overdrive', 1.6, 0, 10, { softMax: 4 }),
			...gateParams('pixelate', 10, 0.15),
		]),
		...grp('Block Noise', [
			check('blockNoise', 'Block Noise', true),
			slider('blocksIntensity', 'Blocks Intensity', 1, 0, 1),
			slider('blocksThreshold', 'Blocks Threshold', 0.4, 0, 1),
			slider('blocksSoftness', 'Blocks Softness', 0.2, 0, 1),
			slider('blocksChroma', 'Blocks Chroma', 0.95, 0, 1),
			...gateParams('blocks', 10, 0.15),
		]),
		...grp('Invert', [
			check('invert', 'Invert', true),
			slider('invertThreshold', 'Invert Threshold', 0.35, 0, 1),
			slider('invertDarken', 'Invert Darken', 0.4, 0, 1),
			slider('invertPatternFreq', 'Invert Pattern Freq', 2, 0.1, 100, { softMax: 20 }),
			...gateParams('invert', 10, 0.21),
		]),
		...grp('Flow', [
			check('flow', 'Flow', true),
			slider('flowBlockFreq', 'Flow Block Freq', 4, 0.1, 100, { softMax: 20 }),
			slider('flowDamageAmount', 'Flow Damage Amount', 1, 0, 10, { softMax: 3 }),
			slider('flowThreshold', 'Flow Threshold', 0.6, 0, 1),
			slider('flowSpeed', 'Flow Speed', 1, 0, 10, { softMax: 4 }),
			...gateParams('flow', 8, 0.2),
		]),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const hd = Math.max(1, ctx.width) / 1920;
			const size = 16 * Math.max(0.001, num(p.damageSize, 1)) * hd;
			return {
				...digitalDamageGates(p, ctx),
				u_blockPx: [Math.max(1, size * Math.max(0.001, num(p.damageSizeRelX, 1))), Math.max(1, size)],
				u_frameInHold: -freezeOffset(p, ctx.frame),
			};
		},
		time: {
			samples: (p, ctx) => (p.freeze === false && p.flow === false ? [] : [freezeOffset(p, ctx.frame)]),
		},
		passes: [{ include: [GLSL_FILM], frag: DIGITAL_FRAG } satisfies ShaderPass],
	},
});

export const DIGITAL_EFFECTS: readonly EffectSpec[] = [S_JPEG_DAMAGE, S_DIGITAL_DAMAGE];

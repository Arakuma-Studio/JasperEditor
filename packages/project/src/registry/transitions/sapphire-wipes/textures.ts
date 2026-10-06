// Sapphire noise-texture wipes: S_WipeBlobs, S_WipeClouds, S_WipeFlux, S_WipePlasma, S_WipeWeave. The switching
// order is a seeded procedural texture (fx/noise), animated over time where Sapphire's is (`u_time`, seconds into
// the transition), plus Grad Add.
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { fxParam } from '../../fx/params.ts';
import { sapphireWipe, swParam } from './common.ts';

/** S_WipeBlobs: fractal noise blobs; the incoming clip appears in the blobs' low areas first. */
export const S_WIPE_BLOBS = sapphireWipe({
	name: 'wipe-blobs',
	label: 'S_WipeBlobs',
	description: 'A blobs wipe: a pattern of noise-generated blobs reveals the incoming clip.',
	keywords: ['blobs', 'noise', 'organic', 'liquid'],
	params: [
		swParam.edgeSoftness(),
		swParam.frequency(6),
		swParam.rel('relWidth', 'Rel Width', 1, 0.01),
		swParam.octaves(1),
		swParam.seed(),
		swParam.shift(),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	include: [GLSL_NOISE],
	frag: /* glsl */ `
void main() {
  vec2 q = sw_patternUv(tr_px(), u_frequency, u_relWidth, 0.0, 1.0, u_shift);
  float v = sw_noise01(fx_fbm(q, int(u_octaves), 2.0, 0.5, u_seed), 1.6);
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

/** Half-width (field units) of the soft band of S_WipeClouds, which has no edge control in Sapphire. */
const CLOUDS_BAND = 0.12;

/** S_WipeClouds: a drifting cloud texture used as a soft matte. */
export const S_WIPE_CLOUDS = sapphireWipe({
	name: 'wipe-clouds',
	label: 'S_WipeClouds',
	description: 'A clouds wipe: the incoming clip appears through a moving cloud texture.',
	keywords: ['clouds', 'smoke', 'fog', 'noise', 'soft'],
	params: [
		swParam.frequency(2),
		swParam.rel('freqRelX', 'Frequency Rel X', 0.4, 0.01),
		swParam.octaves(8),
		swParam.seed(),
		swParam.shift('shiftStart', 'Shift Start'),
		swParam.shift('shiftSpeed', 'Shift Speed', [0.2, 0]),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	border: false,
	include: [GLSL_NOISE],
	frag: /* glsl */ `
void main() {
  vec2 q = (tr_px() - 0.5 * u_compSize) / max(u_compSize.x, 1.0) * u_frequency;
  q.x *= u_freqRelX;
  q += u_shiftStart + u_shiftSpeed * u_time;
  float v = sw_noise01(fx_fbm(q, int(u_octaves), 2.0, 0.5, u_seed), 2.2);
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  const float w = ${CLOUDS_BAND};
  float t = mix(g.y - w, g.z + w, tr_progress());
  float m = smoothstep(-w, w, t - g.x);
  vec4 a = tr_from(v_uv), b = tr_to(v_uv);
  fragColor = tr_progress() <= 0.0 ? a : tr_progress() >= 1.0 ? b : mix(a, b, m);
}`,
});

/**
 * S_WipeFlux: a flux texture of mostly round cells: Voronoi cells domain-warped by a smooth noise (Bubble Amount,
 * Bubble Smooth, Rotate Warp Dir) that undulates over time (Morph: drift x / evolution y, Morph Speed per second).
 */
export const S_WIPE_FLUX = sapphireWipe({
	name: 'wipe-flux',
	label: 'S_WipeFlux',
	description: 'A flux wipe: a flowing texture of mostly round cells reveals the incoming clip.',
	keywords: ['flux', 'cells', 'bubbles', 'organic', 'warp'],
	params: [
		swParam.edgeSoftness(),
		swParam.frequency(6),
		swParam.rel('freqRelX', 'Freq Rel X'),
		swParam.seed(),
		swParam.shift(),
		swParam.octaves(2),
		fxParam.number('bubbleAmount', 'Bubble Amount', 1, { softMin: -5, softMax: 5, step: 0.01 }),
		fxParam.number('bubbleSmooth', 'Bubble Smooth', 0.25, { min: 0.008, max: 10, softMax: 2, step: 0.001 }),
		swParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		fxParam.vec2('morph', 'Morph', [0, 1], { softMin: -5, softMax: 5, step: 0.01 }),
		fxParam.number('morphSpeed', 'Morph Speed', 0.3, { softMin: -5, softMax: 5, step: 0.01 }),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	include: [GLSL_NOISE],
	frag: /* glsl */ `
void main() {
  vec2 q = (tr_px() - 0.5 * u_compSize) / max(u_compSize.x, 1.0) * u_frequency - u_shift;
  q.x *= u_freqRelX;
  float tt = u_morphSpeed * u_time;
  vec3 pw = vec3(q / (4.0 * max(u_bubbleSmooth, 0.008)) + vec2(u_morph.x * tt, 0.0), u_morph.y * tt);
  vec2 w = vec2(fx_simplex3(pw, u_seed), fx_simplex3(pw + vec3(17.3, -9.1, 4.7), fract(u_seed + 0.37)));
  vec2 qq = q + 0.18 * u_bubbleAmount * (fx_rot(fx_deg(u_rotateWarpDir)) * w);
  vec2 f = fx_cellular(qq, 0.9, u_seed);
  float v = sw_growShrink(f.x / max(f.x + 0.5 * (f.y - f.x), 1e-5), false);
  if (u_octaves > 1.5) v = clamp(v + 0.25 * fx_fbm(qq * 2.0, int(u_octaves) - 1, 2.0, 0.5, fract(u_seed + 0.71)), 0.0, 1.0);
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

/**
 * S_WipePlasma: plasma tendrils — Layers contour bands of a fractal noise (optionally aligned by Plasma Grad along
 * Plasma Grad Angle) that undulate over time (Phase Start, Phase Speed per second); Grad Add (0.5 by default) makes
 * the tendrils sweep across the frame.
 */
export const S_WIPE_PLASMA = sapphireWipe({
	name: 'wipe-plasma',
	label: 'S_WipePlasma',
	description: 'A plasma wipe: a plasma texture with moving tendrils reveals the incoming clip.',
	keywords: ['plasma', 'tendrils', 'energy', 'noise'],
	params: [
		swParam.edgeSoftness(),
		swParam.frequency(4, 0.05),
		swParam.rel('freqRelX', 'Freq Rel X', 1, 0.01),
		swParam.octaves(4),
		swParam.seed(),
		fxParam.number('plasmaGrad', 'Plasma Grad', 0, { min: 0, max: 100, softMax: 10, step: 0.01 }),
		swParam.angle('plasmaGradAngle', 'Plasma Grad Angle', 0),
		fxParam.number('layers', 'Layers', 8, { min: 0, max: 100, softMax: 20, step: 0.1 }),
		swParam.shift(),
		fxParam.number('phaseStart', 'Phase Start', 0, { softMin: -5, softMax: 5, step: 0.01 }),
		fxParam.number('phaseSpeed', 'Phase Speed', 2, { softMin: -10, softMax: 10, step: 0.01 }),
		swParam.gradAdd(0.5),
		swParam.gradAngle(),
	],
	include: [GLSL_NOISE],
	frag: /* glsl */ `
void main() {
  vec2 q = (tr_px() - 0.5 * u_compSize) / max(u_compSize.x, 1.0) * u_frequency - u_shift;
  q.x *= u_freqRelX;
  float n = fx_fbm(q, int(u_octaves), 2.0, 0.5, u_seed);
  float ph = u_layers * n + u_plasmaGrad * sw_gradPos(tr_px(), u_plasmaGradAngle) + u_phaseStart + u_phaseSpeed * u_time;
  float v = 0.5 + 0.5 * sin(FX_TAU * ph);
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

/**
 * S_WipeWeave: perpendicular woven strands (alternating over / under per crossing), each strand a noise that varies
 * slowly along it (Rel Length) and flows (H Speed X, V Speed Y: pattern units per second); strands open from their
 * middle (Grow) or their sides (Shrink).
 */
export const S_WIPE_WEAVE = sapphireWipe({
	name: 'wipe-weave',
	label: 'S_WipeWeave',
	description: 'A weave wipe: a texture resembling perpendicular woven strands reveals the incoming clip.',
	keywords: ['weave', 'woven', 'strands', 'fabric', 'basket'],
	params: [
		swParam.choice('strands', 'Strands', ['grow', 'shrink'], ['Grow', 'Shrink']),
		swParam.edgeSoftness(),
		swParam.frequency(20, 0.01),
		swParam.rel('relLength', 'Rel Length', 10, 0.1),
		swParam.octaves(2),
		swParam.seed(),
		swParam.shift(),
		fxParam.number('hSpeedX', 'H Speed X', 0, { softMin: -10, softMax: 10, step: 0.01 }),
		fxParam.number('vSpeedY', 'V Speed Y', 0, { softMin: -10, softMax: 10, step: 0.01 }),
		swParam.gradAdd(),
		swParam.gradAngle(),
	],
	include: [GLSL_NOISE],
	frag: /* glsl */ `
void main() {
  vec2 q = sw_patternUv(tr_px(), u_frequency, 1.0, 0.0, 1.0, u_shift);
  float L = max(u_relLength, 0.1);
  vec2 cell = floor(q);
  // Over / under: which strand is on top alternates at every crossing (cell).
  bool horizontal = mod(cell.x + cell.y, 2.0) < 0.5;
  // The visible strand: its own switching time, a slow noise along it (flowing at H / V Speed) and its profile
  // (opens from its centre line).
  int strand = horizontal ? int(cell.y) : int(cell.x);
  float base = fx_hash1(strand, horizontal ? u_seed : fract(u_seed + 0.5));
  vec2 alongP = horizontal ? vec2((q.x - u_hSpeedX * u_time) / L, cell.y * 1.37)
                           : vec2(cell.x * 1.37, (q.y - u_vSpeedY * u_time) / L);
  float along = sw_noise01(fx_fbm(alongP, int(u_octaves), 2.0, 0.5, fract(u_seed + (horizontal ? 0.25 : 0.75))), 1.6);
  float profile = abs(2.0 * (horizontal ? fract(q.y) : fract(q.x)) - 1.0);
  float v = 0.35 * base + 0.4 * along + 0.25 * profile;
  if (u_strands == 1) v = 1.0 - v;
  vec3 g = sw_grad(v, u_gradAdd, u_gradAngle);
  fragColor = sw_composite(tr_from(v_uv), tr_to(v_uv), sw_fieldWipe(g.x, g.y, g.z, u_swMargin));
}`,
});

export const SAPPHIRE_TEXTURE_WIPES = [
	S_WIPE_BLOBS,
	S_WIPE_CLOUDS,
	S_WIPE_FLUX,
	S_WIPE_PLASMA,
	S_WIPE_WEAVE,
] as const;

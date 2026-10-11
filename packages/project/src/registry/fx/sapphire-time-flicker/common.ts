// Shared params and GLSL of the Sapphire Time + Flicker family: integer/frame params, the
// Sapphire-style float Seed, the field-swap popup of the reversing effects and the "frame at a time offset" lookup
// the sample-based effects share (time slices, time displacement).
import type { ParamSpec } from '../../effects.ts';
import { fxParam } from '../params.ts';
import type { GlslChunk, ShaderPass } from '../shader.ts';

/**
 * Sapphire blur amounts → Gaussian σ: σ = amount × this × layer height (so "Blur Matte 0.224" ≈ 2.2 % of the height,
 * independent of the resolution).
 */
export const SAPPHIRE_BLUR_UNIT = 0.1;

/** An integer-valued number param (frames, counts). */
export function intParam(
	name: string,
	label: string,
	def: number,
	range: { min?: number; max?: number; softMin?: number; softMax?: number } = {},
	frames = true,
): ParamSpec {
	return fxParam.number(name, label, def, { ...range, step: 1 }, frames ? { unit: 'frames' } : undefined);
}

/** Sapphire's "Seed" (a float, 0.123 by default). Named `seed`, so the framework mixes it into `u_seed`. */
export function sapphireSeedParam(def = 0.123): ParamSpec {
	return {
		name: 'seed',
		label: 'Seed',
		type: 'number',
		default: def,
		range: { min: 0, softMax: 10, step: 0.001 },
		animatable: false,
	};
}

export const SWAP_FIELDS = ['no', 'yesAve', 'yesUp1', 'yesDown1'] as const;
export const SWAP_FIELD_LABELS = ['NO', 'Yes Ave', 'Yes Up1', 'Yes Down1'] as const;

export function swapFieldsParam(def: (typeof SWAP_FIELDS)[number]): ParamSpec {
	return fxParam.choice('swapFields', 'Swap Fields', SWAP_FIELDS, SWAP_FIELD_LABELS, def);
}

/** A pass that shows the (remapped) input, optionally with the fields swapped (`u_swapFields`). */
export const SWAP_FIELDS_PASS: ShaderPass = {
	frag: /* glsl */ `
void main() {
  vec2 d = vec2(0.0, u_pxScale / u_canvasSize.y);
  if (u_swapFields == 1) fragColor = 0.5 * (texture(u_source, v_uv - d) + texture(u_source, v_uv + d));
  else if (u_swapFields == 2) fragColor = texture(u_source, v_uv + d);
  else if (u_swapFields == 3) fragColor = texture(u_source, v_uv - d);
  else fragColor = texture(u_source, v_uv);
}`,
};

/** The input, unchanged (pure source remaps: the remap already changed the picture). */
export const PASSTHROUGH_PASS: ShaderPass = {
	frag: 'void main() { fragColor = texture(u_source, v_uv); }',
};

/**
 * `ts_frameAt(d, interp)`: the picture `d` frames from the current one, from the candidates "current frame" (offset
 * 0 = `u_source`) and the time samples (`u_sampleOffsets`). Nearest candidate, or a linear blend of the two that
 * bracket `d` when `interp` (Sapphire "Interp Frames"). Candidates missing at the clip's ends fall back to the
 * nearest available frame.
 */
export const GLSL_FRAME_AT: GlslChunk = {
	name: 'sapphire-time-flicker/frame-at',
	source: /* glsl */ `
vec4 ts_candidate(int i, vec2 uv) { return i < 0 ? texture(u_source, uv) : fx_sample(i, uv); }
vec4 ts_frameAt(float d, bool interp, vec2 uv) {
  float lo = -1.0e9; float hi = 1.0e9; int iLo = -2; int iHi = -2;
  if (d >= 0.0) { lo = 0.0; iLo = -1; }
  if (d <= 0.0) { hi = 0.0; iHi = -1; }
  for (int i = 0; i < 8; i++) {
    if (i >= u_sampleCount) break;
    float o = u_sampleOffsets[i];
    if (o <= d && o > lo) { lo = o; iLo = i; }
    if (o >= d && o < hi) { hi = o; iHi = i; }
  }
  if (iLo == -2) return ts_candidate(iHi, uv);
  if (iHi == -2) return ts_candidate(iLo, uv);
  if (iLo == iHi) return ts_candidate(iLo, uv);
  if (!interp) return (d - lo <= hi - d) ? ts_candidate(iLo, uv) : ts_candidate(iHi, uv);
  return mix(ts_candidate(iLo, uv), ts_candidate(iHi, uv), (d - lo) / max(hi - lo, 1.0e-6));
}
`,
};

/**
 * Candidate offsets for `ts_frameAt` over [lo, hi]: ≤ 8 samples evenly spread, without 0 (the current frame is
 * `u_source`), so windows of up to 9 frames are exact.
 */
export function frameAtOffsets(
	lo: number,
	hi: number,
	spread: (a: number, b: number, n: number) => number[],
) {
	const a = Math.min(lo, hi);
	const b = Math.max(lo, hi);
	if (a <= 0 && b >= 0) {
		const nine = spread(a, b, 9);
		if (nine.includes(0)) return nine.filter((o) => o !== 0);
	}
	return spread(a, b, 8).filter((o) => o !== 0);
}

// Family-private pass builders of `sapphire-textures-clouds`: the chromatic glow pyramid (S_TexturePlasma,
// S_TextureNeurons) and the post-process sharpen blur (S_TextureWeave, S_TextureNoisePaint).
import { bloomPyramidPasses, gaussianBlurPasses } from '../passes.ts';
import type { FxPlanContext, ShaderPass } from '../shader.ts';

/** Number of bloom levels behind `stc_glow` (outputs glow0…glow5, 1/2 … 1/64 of the canvas). */
export const STC_GLOW_LEVELS = 6;

/** Half-float bloom pyramid of the mono texture `input` (.r) → u_glow0…u_glow5, read by `stc_glow`. */
export function glowPasses(input: string): ShaderPass[] {
	return bloomPyramidPasses({ input, prefix: 'glow', levels: STC_GLOW_LEVELS, format: 'rgba16f' });
}

/**
 * Sharpen width (relative to a texture feature of `1 / frequency` frame heights) → blur sigma in canvas pixels.
 * Pure: exported for the unit tests.
 */
export function sharpenSigma(width: number, frequency: number, ctx: FxPlanContext): number {
	const w = Number.isFinite(width) ? Math.max(0, width) : 0;
	const f = Number.isFinite(frequency) ? Math.max(0.01, frequency) : 1;
	return Math.min(256, Math.max(0.5, (w / f) * ctx.height * ctx.pxScale));
}

/** Gaussian blur of `input` (→ u_soft) for an unsharp mask in the last pass: `tex + amount * (tex - soft)`. */
export function sharpenPasses(input: string, sigma: number): ShaderPass[] {
	return gaussianBlurPasses({ input, output: 'soft', sigma, format: 'rgba16f' });
}

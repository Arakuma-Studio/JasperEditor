// Recipe identity shared by the engine and jasper-proc (S07:PRC-002): processor version, canonical recipe
// hash, step labels for item names ("crudo [Stabilized · Upscaled 2×]").
import { createHash } from 'node:crypto';
import { canonicalJson, type ProcessStep } from '@jasper/project';

/**
 * Bump when the output of the same steps changes (algorithm or encoder settings). Part of the recipe hash, so
 * processed files of an older processor are not reused.
 */
export const RECIPE_VERSION = 1;

export const PROC_NAME = 'jasper-proc';
export const PROC_VERSION = '0.1.0';

/** `recipeHash = sha256(canonicalJson({steps, recipeVersion}))` (+ the range when one is processed). */
export function recipeHash(
	steps: readonly ProcessStep[],
	recipeVersion = RECIPE_VERSION,
	range?: { startFrame: number; endFrame: number } | null,
): string {
	const body: Record<string, unknown> = { steps, recipeVersion };
	if (range) body.range = range;
	return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** Human label of one step (Project item names, job titles, badges). */
function stepLabel(step: ProcessStep): string {
	switch (step.op) {
		case 'stabilize':
			return 'Stabilized';
		case 'dejudder':
			return 'De-juddered';
		case 'denoise':
			return 'Denoised';
		case 'deblock':
			return 'Deblocked';
		case 'upscale':
			return `Upscaled ${step.scale}×`;
	}
}

export function recipeLabel(steps: readonly ProcessStep[]): string {
	return steps.map(stepLabel).join(' · ');
}

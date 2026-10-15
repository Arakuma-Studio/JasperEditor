// Jasper Synth rendering (spec 12 §2.1): `renderSynth(recipe, seed)` → stereo 48 kHz Float32 channels, deterministic.
// The library indexes `SYNTH_VARIANTS` seeds (0 … 7) of every recipe as its last-resort source
// (`{type: 'synth', recipe, seed}`); any 32-bit seed renders.
import type { SoundTypeId } from '../analysis/sound-judge.ts';
import { hashString, SplitMix32 } from './kit.ts';
import { SYNTH_RECIPES, type SynthRecipe } from './recipes.ts';

export { SplitMix32 } from './kit.ts';
export { SYNTH_RECIPES, type SynthRecipe } from './recipes.ts';

/** Every synth sound is rendered at this rate. */
export const SYNTH_SAMPLE_RATE = 48_000;
/** Seeds 0 … SYNTH_VARIANTS − 1 make the indexed variants of each recipe. */
export const SYNTH_VARIANTS = 8;
/** Bumped whenever any recipe's output changes (cached renders and indexed descriptors are then stale). */
export const SYNTH_VERSION = 1;

export interface SynthSound {
	recipe: string;
	type: SoundTypeId;
	title: string;
	seed: number;
	sampleRate: number;
	/** Planar stereo samples (peak −1 dBFS). */
	channels: Float32Array[];
}

/** Thrown for an unknown recipe or a seed that is not a 32-bit unsigned integer. */
export class SynthError extends Error {
	readonly code = 'E_INVALID_PARAM';
	constructor(message: string) {
		super(message);
		this.name = 'SynthError';
	}
}

const BY_ID = new Map<string, SynthRecipe>(SYNTH_RECIPES.map((r) => [r.id, r]));

/** The recipe with this id, or undefined. */
export function synthRecipe(id: string): SynthRecipe | undefined {
	return BY_ID.get(id);
}

/** Render one synth sound. Same recipe and seed → the same samples, bit for bit. */
export function renderSynth(recipeId: string, seed: number): SynthSound {
	const recipe = typeof recipeId === 'string' ? BY_ID.get(recipeId) : undefined;
	if (!recipe) throw new SynthError(`unknown synth recipe ${JSON.stringify(recipeId)}`);
	if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
		throw new SynthError('seed must be an integer from 0 to 4294967295');
	const rng = new SplitMix32((hashString(recipe.id) ^ Math.imul(seed, 0x9e3779b1)) >>> 0);
	const channels = recipe.render(rng, SYNTH_SAMPLE_RATE);
	return {
		recipe: recipe.id,
		type: recipe.type,
		title: `${recipe.title} ${seed + 1}`,
		seed,
		sampleRate: SYNTH_SAMPLE_RATE,
		channels,
	};
}

/** The indexed synth variants: every recipe × seeds 0 … SYNTH_VARIANTS − 1 (without rendering). */
export function synthCatalogue(): { recipe: string; type: SoundTypeId; seed: number; title: string }[] {
	return SYNTH_RECIPES.flatMap((r) =>
		Array.from({ length: SYNTH_VARIANTS }, (_, seed) => ({
			recipe: r.id,
			type: r.type,
			seed,
			title: `${r.title} ${seed + 1}`,
		})),
	);
}

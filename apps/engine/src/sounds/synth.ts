// Jasper Synth in the library (spec 12 §0, §2.1 source 4; wp-note "WP1.2"): the deterministic procedural kit of
// `@jasper/audio-fx`, rendered on demand to `<appdir>/sounds/synth/` as 16-bit WAV and indexed with source
// `{type: 'synth', recipe, seed}` and licence `LicenseRef-JasperEditor`. Real recordings always rank above it.
// A deleted render (cache cleaned) is rendered again when it is needed; the same recipe, seed and SYNTH_VERSION give
// the same bytes, so the sound id stays the same.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';
import { renderSynth, SYNTH_VARIANTS, SYNTH_VERSION, synthCatalogue } from '@jasper/audio-fx';
import { atomicWriteFile } from '../tools/fs.ts';

export const SYNTH_VARIANTS_ENV = 'JASPER_SOUND_SYNTH_VARIANTS';

export type SynthItem = { recipe: string; type: string; seed: number; title: string };

/**
 * The catalogue entries the library indexes: every recipe with seeds 0 … variants − 1 (`JASPER_SOUND_SYNTH_VARIANTS`,
 * 0 … 8, default all 8; 0 leaves Jasper Synth out of the index).
 */
export function synthItems(env: Record<string, string | undefined> = process.env): SynthItem[] {
	const raw = env[SYNTH_VARIANTS_ENV];
	const n = raw !== undefined && /^\d$/.test(raw) ? Math.min(SYNTH_VARIANTS, Number(raw)) : SYNTH_VARIANTS;
	return synthCatalogue()
		.filter((e) => e.seed < n)
		.map((e) => ({ recipe: e.recipe, type: e.type, seed: e.seed, title: e.title }));
}

/** File name of a render: recipe, seed and synth version (a new version renders new files). */
export function synthFileName(recipe: string, seed: number): string {
	return `${recipe.replace(/[^a-z0-9.-]/gi, '_')}-${seed}-v${SYNTH_VERSION}.wav`;
}

/** Renders a synth sound to its file unless it is already there; returns the path. Throws `SynthError` for unknown recipes. */
export async function ensureSynthFile(dir: string, recipe: string, seed: number): Promise<string> {
	const file = join(dir, synthFileName(recipe, seed));
	const st = await stat(file).catch(() => null);
	if (st?.isFile() && st.size > 44) return file;
	const s = renderSynth(recipe, seed);
	await atomicWriteFile(file, encodeWav(s.channels, s.sampleRate, 's16'));
	return file;
}

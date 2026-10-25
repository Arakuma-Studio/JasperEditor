// Jasper Synth (spec 12 P1-R3): deterministic renders (byte hashes pinned), and every variant accepted by the judge for
// its own type.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	analyzeSound,
	DEFAULT_TYPE_PROFILES,
	judgeSound,
	renderSynth,
	SOUND_TYPE_IDS,
	SYNTH_RECIPES,
	SYNTH_SAMPLE_RATE,
	SYNTH_VARIANTS,
	SynthError,
	synthCatalogue,
	synthRecipe,
} from '../src/index.ts';

/**
 * sha256 (first 128 bits) of the Float32 bytes of seeds 0 … 7, every channel in order. A change here means a recipe
 * changed: bump SYNTH_VERSION (cached renders and indexed descriptors are stale) and update the table.
 */
const PINNED: Record<string, string> = {
	'synth.hit': '43735b04b97f838be2852df069de293c',
	'synth.boom': 'daefc2a622016395f20a2b239e8f6d0c',
	'synth.riser': '047c1adedbd2184bb5107064a3983e36',
	'synth.reverse': '38e85285ac079b3602b05aa59844c95d',
	'synth.transition': '5c658d7acd803ec67f5d765456b774f3',
	'synth.whoosh': '0d02a340d5e8454f00382cb7d5c3de6c',
	'synth.swish': '87531e130d8a66d6d2421626b17f9554',
	'synth.glitch': '9234f9256e5f7c505a614a6b9831700d',
	'synth.ui': '0f0443a0c7fc09b9129c0f0dd19402f9',
	'synth.click': '4e23d820f401bf4671b11d5596681da3',
	'synth.key': 'afe08cc495cf58c6a69d84e9f0ab26da',
	'synth.tick': 'dcffe90653240290416ccba1b6bd8851',
	'synth.tap': '95f86da4905c482002d3ba07453d8bd8',
	'synth.pop': '4784e6546c2c2a45a77d61dbea6a0134',
	'synth.thump': 'b1b2b2f23adaf1165f53579b5e76c662',
	'synth.paper': 'f9f53e47c39a9799d9d507fb8004bb1e',
	'synth.chime': 'ff684d0e051f540033f3eccc2dd9c194',
	'synth.shimmer': '6c99841fc37c437f8944e55a8ae77ef5',
	'synth.zap': '240dc8e63b55e670a594fe5e3f2a0edc',
};

const hashRecipe = (id: string): string => {
	const h = createHash('sha256');
	for (let s = 0; s < SYNTH_VARIANTS; s++)
		for (const c of renderSynth(id, s).channels)
			h.update(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
	return h.digest('hex').slice(0, 32);
};

describe('Jasper Synth', () => {
	it('has one recipe for each of the 19 effect types', () => {
		const effectTypes = SOUND_TYPE_IDS.filter((t) => t !== 'ambience' && t !== 'roomtone');
		expect(SYNTH_RECIPES.map((r) => r.type)).toEqual(effectTypes);
		expect(new Set(SYNTH_RECIPES.map((r) => r.id)).size).toBe(19);
		for (const r of SYNTH_RECIPES) expect(r.id).toBe(`synth.${r.type}`);
		expect(synthCatalogue()).toHaveLength(19 * SYNTH_VARIANTS);
		expect(synthRecipe('synth.hit')?.type).toBe('hit');
		expect(synthRecipe('nope')).toBeUndefined();
	});

	it.each(SYNTH_RECIPES.map((r) => [r.id]))('%s renders the versioned pinned bytes', (id) => {
		expect(hashRecipe(id)).toBe(PINNED[id]);
	});

	it.each(SYNTH_RECIPES.map((r) => [r.id, r.type] as const))(
		'every variant of %s passes the judge as %s',
		(id, type) => {
			for (let seed = 0; seed < SYNTH_VARIANTS; seed++) {
				const s = renderSynth(id, seed);
				expect(s.sampleRate).toBe(SYNTH_SAMPLE_RATE);
				expect(s.channels).toHaveLength(2);
				expect(s.type).toBe(type);
				// One assertion per sound, not per sample: an expect() per sample (≈ 140 000 per variant) made this
				// test take 7 s per variant, 90 s per type under load, and time out in the gate.
				let peak = 0;
				let nonFinite = -1;
				for (const c of s.channels)
					for (let i = 0; i < c.length; i++) {
						const v = c[i]!;
						if (!Number.isFinite(v)) {
							if (nonFinite < 0) nonFinite = i;
						} else if (Math.abs(v) > peak) peak = Math.abs(v);
					}
				expect(nonFinite, `${id} seed ${seed}: first non-finite sample`).toBe(-1);
				expect(Math.abs(20 * Math.log10(peak) - -1)).toBeLessThan(0.01);
				const d = analyzeSound(s.channels, s.sampleRate);
				const j = judgeSound(d, DEFAULT_TYPE_PROFILES[type]);
				expect(j.reasons, `${id} seed ${seed}: ${JSON.stringify(d)}`).toEqual([]);
				expect(j.ok).toBe(true);
			}
		},
	);

	it('any 32-bit seed renders; others are refused', () => {
		expect(renderSynth('synth.click', 0xffffffff).channels[0]!.length).toBeGreaterThan(0);
		for (const seed of [-1, 1.5, 2 ** 32, Number.NaN])
			expect(() => renderSynth('synth.click', seed)).toThrow(SynthError);
		expect(() => renderSynth('synth.nope', 0)).toThrow(SynthError);
		expect(() => renderSynth(42 as unknown as string, 0)).toThrow(SynthError);
	});
});

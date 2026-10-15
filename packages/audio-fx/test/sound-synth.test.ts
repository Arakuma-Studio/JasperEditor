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
	SplitMix32,
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

	it('SplitMix32 is the reference sequence', () => {
		// splitmix32 from seed 0 (x += 0x9e3779b9; murmur3 fmix with 0x85ebca6b / 0xc2b2ae35)
		const r = new SplitMix32(0);
		const a = [r.nextU32(), r.nextU32(), r.nextU32()];
		const ref = (x: number) => {
			let z = x >>> 0;
			z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
			z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
			return (z ^ (z >>> 16)) >>> 0;
		};
		expect(a).toEqual([ref(0x9e3779b9), ref(0x3c6ef372), ref(0xdaa66d2b)]);
		const u = new SplitMix32(5);
		for (let i = 0; i < 1000; i++) {
			const v = u.unit();
			expect(v >= 0 && v < 1).toBe(true);
		}
	});

	it.each(SYNTH_RECIPES.map((r) => [r.id]))('%s renders the pinned bytes, twice the same', (id) => {
		const a = renderSynth(id, 3).channels;
		const b = renderSynth(id, 3).channels;
		expect(b).toEqual(a);
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
				let peak = 0;
				for (const c of s.channels)
					for (const v of c) {
						expect(Number.isFinite(v)).toBe(true);
						peak = Math.max(peak, Math.abs(v));
					}
				expect(Math.abs(20 * Math.log10(peak) - -1)).toBeLessThan(0.01);
				const d = analyzeSound(s.channels, s.sampleRate);
				const j = judgeSound(d, DEFAULT_TYPE_PROFILES[type]);
				expect(j.reasons, `${id} seed ${seed}: ${JSON.stringify(d)}`).toEqual([]);
				expect(j.ok).toBe(true);
			}
		},
	);

	it('variants differ from each other', () => {
		for (const r of SYNTH_RECIPES) {
			const a = renderSynth(r.id, 0).channels[0]!;
			const b = renderSynth(r.id, 1).channels[0]!;
			expect(a.length === b.length && a.every((v, i) => v === b[i]), r.id).toBe(false);
		}
	});

	it('any 32-bit seed renders; others are refused', () => {
		expect(renderSynth('synth.click', 0xffffffff).channels[0]!.length).toBeGreaterThan(0);
		for (const seed of [-1, 1.5, 2 ** 32, Number.NaN])
			expect(() => renderSynth('synth.click', seed)).toThrow(SynthError);
		expect(() => renderSynth('synth.nope', 0)).toThrow(SynthError);
		expect(() => renderSynth(42 as unknown as string, 0)).toThrow(SynthError);
	});
});

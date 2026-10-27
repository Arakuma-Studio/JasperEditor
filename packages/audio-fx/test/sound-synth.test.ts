// Jasper Synth (spec 12 P1-R3): versioned library WAV bytes, and every variant accepted by the judge for its type.
import { createHash } from 'node:crypto';
import { encodeWav } from '@jasper/audio-dsp';
import { describe, expect, it } from 'vitest';
import {
	analyzeSound,
	DEFAULT_TYPE_PROFILES,
	judgeSound,
	renderSynth,
	SOUND_TYPE_IDS,
	SYNTH_EXTRA_RECIPES,
	SYNTH_RECIPES,
	SYNTH_SAMPLE_RATE,
	SYNTH_VARIANTS,
	SynthError,
	synthCatalogue,
	synthRecipe,
} from '../src/index.ts';

/**
 * sha256 (first 128 bits) of the version-1 library PCM16 WAVs for seeds 0 … 7, concatenated in seed order.
 * These freeze the persisted bytes written by engine/sounds/synth.ts. Intermediate Float32 buffers can differ
 * across V8 versions without changing a single cached sample; cache-byte changes require a SYNTH_VERSION bump.
 */
const PINNED_WAV: Record<string, string> = {
	'synth.hit': '7aad94d10f94e2c107512f78b3e3ea0b',
	'synth.boom': 'e45af28bf958d93e22f6a7662402f630',
	'synth.riser': '6cb7c6943061038e1a7d3f03e8bef87d',
	'synth.reverse': '0a95173a7bb24690296e38049fa7986b',
	'synth.transition': 'e43b6c9db5d59c5affa611dfa150f22f',
	'synth.whoosh': '9404a80cec00f161f29f9be29b8b8a75',
	'synth.swish': '715f77a1765b39f5ec904c7219071c0e',
	'synth.glitch': '1bd366aa6d1568d8dd1fd52ef3853e47',
	'synth.ui': '43b035f98a6a6462f85ea5d8595ff3f3',
	'synth.click': 'eb9b159ae7bbda2170762a5ceb9f9a8c',
	'synth.key': '83e6cb0247e489aa07c34ccd1dec68a3',
	'synth.tick': '9489cf41db91142e0b7ef11043655822',
	'synth.tap': '3ee00de58a4401991984354a86f293bd',
	'synth.pop': '7ffc98c479ada50ba9565f23549b63af',
	'synth.thump': 'b45d5ee2570a84f6ed829f680ed0a065',
	'synth.paper': '40341ab4a6ce13115c132755588516c4',
	'synth.chime': '3ffb03d0c73350b36b45a1b96adcddd8',
	'synth.shimmer': '5b3b5c339693060a770204fc17f99658',
	'synth.zap': '44808baf6fe7771930984c26838d00d0',
	'synth.static': 'a9e81d3bebceea317a4cac8e9cb51811',
};

const ALL_RECIPES = [...SYNTH_RECIPES, ...SYNTH_EXTRA_RECIPES];

describe('Jasper Synth', () => {
	it('has one recipe for each of the 19 effect types', () => {
		const effectTypes = SOUND_TYPE_IDS.filter((t) => t !== 'ambience' && t !== 'roomtone');
		expect(SYNTH_RECIPES.map((r) => r.type)).toEqual(effectTypes);
		expect(new Set(SYNTH_RECIPES.map((r) => r.id)).size).toBe(19);
		for (const r of SYNTH_RECIPES) expect(r.id).toBe(`synth.${r.type}`);
		expect(synthCatalogue()).toHaveLength((19 + SYNTH_EXTRA_RECIPES.length) * SYNTH_VARIANTS);
		expect(synthRecipe('synth.hit')?.type).toBe('hit');
		// spec 15 EA-026: the stingers' generated TV static, a glitch-type sound asked for by its recipe id
		expect(SYNTH_EXTRA_RECIPES.map((r) => r.id)).toEqual(['synth.static']);
		expect(synthRecipe('synth.static')?.type).toBe('glitch');
		expect(synthCatalogue().filter((e) => e.recipe === 'synth.static')).toHaveLength(SYNTH_VARIANTS);
		expect(synthRecipe('nope')).toBeUndefined();
	});

	it.each(ALL_RECIPES.map((r) => [r.id, r.type] as const))(
		'every variant of %s keeps its cached WAV bytes and passes the judge as %s',
		(id, type) => {
			const hash = createHash('sha256');
			for (let seed = 0; seed < SYNTH_VARIANTS; seed++) {
				const s = renderSynth(id, seed);
				hash.update(encodeWav(s.channels, s.sampleRate, 's16'));
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
			expect(hash.digest('hex').slice(0, 32)).toBe(PINNED_WAV[id]);
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

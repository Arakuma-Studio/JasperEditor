// Describe mode of the ranking (spec 12 P6-E14, WP-E9): the audio-text match blended with the other parts — it ranks
// a badly named sound by its match, the description's words add a small bonus (evidence only), a sound without an
// embedding falls back to the words, a sound matching worse than average (score 0) is left out, `q` still filters,
// real recordings still rank above synth.
import { describe, expect, it } from 'vitest';
import { type RankableSound, rankSounds } from '../src/index.ts';

function snd(id: string, over: Partial<RankableSound> = {}): RankableSound {
	return {
		id,
		title: id,
		tags: [],
		types: ['hit'],
		source: { type: 'starter' },
		license: 'CC0-1.0',
		judge: { ok: true, score: 1 },
		descriptors: { durationSec: 1, peakSec: 0.01 },
		...over,
	};
}
const ids = (r: { entry: { id: string } }[]) => r.map((x) => x.entry.id);
const sem = (scores: Record<string, number>, text = 'glass shattering on concrete') => ({
	semantic: { scores: new Map(Object.entries(scores)), text },
});

describe('describe mode', () => {
	const lib = [
		snd('a_sfx_0001', { title: 'SFX_0001' }),
		snd('b_sfx_0002', { title: 'SFX_0002' }),
		snd('c_glass', { title: 'Glass shatter' }),
		snd('d_wood', { title: 'Wood knock' }),
	];

	it('ranks by the match, the words only adding a bonus', () => {
		const r = rankSounds(lib, sem({ a_sfx_0001: 0.9, b_sfx_0002: 0.2, c_glass: 0.5, d_wood: 0.4 }));
		expect(ids(r)).toEqual(['a_sfx_0001', 'c_glass', 'd_wood', 'b_sfx_0002']);
		expect(r[0]!.parts.semantic).toBe(0.9);
		expect(r[0]!.parts.titleMatch).toBeNull();
		// "glass" is in c's title: its score is higher than d's with the same match, by the words' bonus
		const same = rankSounds(lib, sem({ c_glass: 0.4, d_wood: 0.4 }));
		expect(ids(same).slice(0, 2)).toEqual(['c_glass', 'd_wood']);
		const gap = same[0]!.score - same[1]!.score;
		expect(gap).toBeGreaterThan(0);
		expect(gap).toBeLessThanOrEqual(0.1);
	});

	it('leaves out matches of 0 and falls back to the words without an embedding', () => {
		const r = rankSounds(lib, sem({ a_sfx_0001: 0.9, b_sfx_0002: 0 }));
		// b: matched worse than average; c: no embedding but its words match; d: neither
		expect(ids(r)).toEqual(['a_sfx_0001', 'c_glass']);
		expect(r[1]!.parts.semantic).toBeNull();
		// a description of stopwords only lists embedded sounds alone
		expect(ids(rankSounds(lib, sem({ a_sfx_0001: 0.3 }, 'the of a')))).toEqual(['a_sfx_0001']);
		// hostile scores never throw and never rank
		expect(
			ids(
				rankSounds(lib, sem({ a_sfx_0001: Number.NaN, b_sfx_0002: Number.POSITIVE_INFINITY, c_glass: -3 })),
			),
		).toEqual([]);
		expect(() => rankSounds(lib, { semantic: { scores: {} as never, text: 'x' } })).not.toThrow();
	});

	it('keeps q as a filter and real recordings above synth', () => {
		expect(ids(rankSounds(lib, { query: 'wood', ...sem({ a_sfx_0001: 1, d_wood: 0.1 }) }))).toEqual([
			'd_wood',
		]);
		const withSynth = [...lib, snd('e_synth', { source: { type: 'synth' } })];
		const r = rankSounds(withSynth, sem({ a_sfx_0001: 0.9, e_synth: 1 }));
		expect(ids(r)).toEqual(['a_sfx_0001', 'c_glass', 'e_synth']);
	});
});

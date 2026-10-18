// Describe mode of the ranking (spec 12 P6-E14, WP-E9): the audio-text match blended with the other parts — it ranks
// a badly named sound by its match, the description's words add a small bonus (evidence only), a sound without an
// embedding falls back to the words, a sound matching worse than average (score 0) is left out, `q` still filters,
// real recordings still rank above synth, and the result is deterministic and the same through `rankSoundsPage` and
// the facet filter bits (property test over random scores).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	DESCRIBE_WORDS_BONUS,
	RANK_WEIGHTS,
	type RankableSound,
	rankSounds,
	rankSoundsPage,
	SOUND_FILTER_ALL,
	soundFilterOf,
} from '../src/index.ts';

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
		expect(gap).toBeLessThanOrEqual(DESCRIBE_WORDS_BONUS);
		// a sound without the words is not penalised for it (the words are no part of its score)
		const noWords = rankSounds([lib[0]!], sem({ a_sfx_0001: 0.5 }))[0]!;
		const w = RANK_WEIGHTS;
		expect(noWords.score).toBeCloseTo(
			(w.semantic * 0.5 +
				w.durationFit * noWords.parts.durationFit +
				w.judge * 1 +
				w.license * noWords.parts.license) /
				(w.semantic + w.durationFit + w.judge + w.license),
			5,
		);
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

	it('is deterministic and equal through rankSoundsPage and the filter bits (property)', () => {
		const many = Array.from({ length: 40 }, (_, i) =>
			snd(`s${String(i).padStart(3, '0')}`, { title: i % 5 === 0 ? `glass ${i}` : `SFX ${i}` }),
		);
		fc.assert(
			fc.property(
				fc.array(fc.option(fc.double({ min: -0.5, max: 1.5, noNaN: true }), { nil: undefined }), {
					minLength: 40,
					maxLength: 40,
				}),
				fc.integer({ min: 0, max: 30 }),
				(scores, offset) => {
					const m: Record<string, number> = {};
					scores.forEach((v, i) => {
						if (v !== undefined) m[many[i]!.id] = v;
					});
					const req = sem(m);
					const a = rankSounds(many, req);
					expect(rankSounds(many, req)).toEqual(a);
					const page = rankSoundsPage(many, req, {}, { offset, limit: 10 });
					expect(page.total).toBe(a.length);
					expect(ids(page.results)).toEqual(ids(a.slice(offset, offset + 10)));
					const bits = soundFilterOf(req);
					expect(
						many
							.filter((e) => bits(e) === SOUND_FILTER_ALL)
							.map((e) => e.id)
							.sort(),
					).toEqual(ids(a).sort());
				},
			),
			{ numRuns: 150 },
		);
	});
});

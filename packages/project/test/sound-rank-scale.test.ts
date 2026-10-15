// Sound ranking at library scale and against hostile names (spec 12 §2.1; wp-note "WP1.2 engine library" ▸ "Review
// fixes", findings 10 and 11): prototype keys name no type, query words are deduplicated and capped, `soundFilterOf`
// agrees with `rankSounds`, and ranking 5 000 sounds takes < 50 ms.
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	inferTypesFromName,
	MAX_QUERY_TOKENS,
	type RankableSound,
	rankSounds,
	rankSoundsPage,
	resolveTypeNames,
	SOUND_FILTER_ALL,
	SOUND_TYPE_IDS,
	type SoundRankRequest,
	soundFilterOf,
	synonymType,
	typesInTokens,
} from '../src/index.ts';

const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'];

function snd(id: string, title: string, over: Partial<RankableSound> = {}): RankableSound {
	return {
		id,
		title,
		tags: [],
		types: ['hit'],
		source: { type: 'starter' },
		license: 'CC0-1.0',
		judge: { ok: true, score: 1 },
		descriptors: { durationSec: 0.5, peakSec: 0.01, riseMs: 2, centroidHz: 1800 },
		...over,
	};
}

describe('type names are own synonyms only (finding 11)', () => {
	it('prototype keys name no type anywhere', () => {
		for (const k of PROTO_KEYS) {
			expect(synonymType(k)).toBeUndefined();
			expect(resolveTypeNames([k])).toEqual([]);
			expect(typesInTokens([k])).toEqual([]);
			expect(inferTypesFromName(`${k}/${k}.wav`)).toEqual([]);
			// Asking for such a "type" filters everything out instead of matching through Object.prototype.
			expect(rankSounds([snd('snd_a', 'Punch')], { types: [k] })).toEqual([]);
			const r = rankSounds([snd('snd_a', `${k} punch`)], { query: `${k} punch` });
			expect(r).toHaveLength(1);
			expect(r[0]!.parts.typeFit).toBeNull();
		}
		expect(resolveTypeNames(['constructor', 'swoosh'])).toEqual(['whoosh']);
	});
});

describe('query words (finding 10)', () => {
	it('repeated words count once', () => {
		const lib = [snd('snd_a', 'Heavy slam'), snd('snd_b', 'Heavy door'), snd('snd_c', 'Slam')];
		const once = rankSounds(lib, { query: 'slam heavy' });
		expect(once).toHaveLength(3);
		expect(rankSounds(lib, { query: 'slam slam heavy slam heavy' })).toEqual(once);
	});

	it(`only the first ${MAX_QUERY_TOKENS} distinct words are matched`, () => {
		const filler = Array.from({ length: MAX_QUERY_TOKENS }, (_, i) => `word${String.fromCharCode(97 + i)}`);
		const lib = [snd('snd_a', 'Punch')];
		expect(rankSounds(lib, { query: `punch ${filler.join(' ')}` })).toHaveLength(1);
		expect(rankSounds(lib, { query: `${filler.join(' ')} punch` })).toEqual([]);
	});
});

const WORDS = [
	'heavy',
	'light',
	'metal',
	'door',
	'slam',
	'punch',
	'whoosh',
	'swoosh',
	'riser',
	'click',
	'room',
	'tone',
];
const entryArb = fc.record({
	id: fc.stringMatching(/^snd_[0-9a-f]{6}$/),
	title: fc.array(fc.constantFrom(...WORDS), { maxLength: 4 }).map((a) => a.join(' ')),
	tags: fc.array(fc.constantFrom(...WORDS), { maxLength: 4 }),
	types: fc.array(fc.constantFrom('hit', 'whoosh', 'riser', 'click', 'roomtone', 'nope', 'constructor'), {
		maxLength: 3,
	}),
	source: fc.record({ type: fc.constantFrom('starter', 'pack', 'folder', 'synth') }),
	license: fc.constantFrom('CC0-1.0', 'CC-BY-4.0', 'LicenseRef-UserProvided', 'CC-BY-NC-4.0'),
	descriptors: fc.record({
		durationSec: fc.double({ min: 0.01, max: 20, noNaN: true }),
		centroidHz: fc.double({ min: 100, max: 8000, noNaN: true }),
		riseMs: fc.double({ min: 0, max: 100, noNaN: true }),
	}),
});
const requestArb: fc.Arbitrary<SoundRankRequest> = fc.record(
	{
		query: fc.array(fc.constantFrom(...WORDS, 'constructor', 'zz'), { maxLength: 3 }).map((a) => a.join(' ')),
		types: fc.array(fc.constantFrom('hit', 'swoosh', 'roomtone', 'nope', '__proto__'), { maxLength: 2 }),
		license: fc.constantFrom('any' as const, 'commercial-safe' as const),
		length: fc.constantFrom('short' as const, 'medium' as const, 'long' as const),
		tone: fc.constantFrom('dark' as const, 'bright' as const),
	},
	{ requiredKeys: [] },
);

describe('soundFilterOf and rankSoundsPage agree with rankSounds', () => {
	it('rankSoundsPage gives rankSounds’ order, total and parts, page by page (property)', () => {
		fc.assert(
			fc.property(
				fc.array(entryArb, { maxLength: 40 }),
				requestArb,
				fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
				fc.integer({ min: 0, max: 20 }),
				fc.integer({ min: 0, max: 20 }),
				(entries, req0, limit, offset, size) => {
					const req = limit === undefined ? req0 : { ...req0, limit };
					const keep = (e: RankableSound) => e.source.type !== 'pack';
					const all = rankSounds(entries.filter(keep), req, {
						usedNearby: entries.slice(0, 2).map((e) => e.id),
					});
					const seen: [RankableSound, number][] = [];
					const page = rankSoundsPage(
						entries,
						req,
						{ usedNearby: entries.slice(0, 2).map((e) => e.id) },
						{ inRanking: keep, onFilter: (e, bits) => seen.push([e, bits]), offset, limit: size },
					);
					expect(page.total).toBe(all.length);
					expect(page.results).toEqual(all.slice(offset, offset + size));
					expect(seen.map(([e]) => e)).toEqual(entries);
				},
			),
			{ numRuns: 400 },
		);
	});

	it('an entry passes every filter exactly when rankSounds keeps it (property)', () => {
		fc.assert(
			fc.property(fc.array(entryArb, { maxLength: 40 }), requestArb, (entries, req) => {
				const kept = new Set(rankSounds(entries, req).map((r) => r.entry));
				const f = soundFilterOf(req);
				for (const e of entries) expect(f(e) === SOUND_FILTER_ALL, JSON.stringify(e)).toBe(kept.has(e));
			}),
			{ numRuns: 400 },
		);
	});
});

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ADJ = [
	'heavy',
	'light',
	'metal',
	'wood',
	'glass',
	'deep',
	'sharp',
	'soft',
	'distant',
	'fast',
	'dark',
	'bright',
];
const NOUN = [
	'punch',
	'impact',
	'door slam',
	'whoosh',
	'swoosh',
	'riser',
	'click',
	'button',
	'room tone',
	'chime',
	'zap',
];

function library(n: number): RankableSound[] {
	const r = rng(5);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
	return Array.from({ length: n }, (_, i) => {
		const dur = 0.03 * 10 ** (r() * 3);
		return {
			id: `snd_${i.toString(16).padStart(16, '0')}`,
			title: `${pick(ADJ)} ${pick(NOUN)} ${1 + (i % 40)}`,
			tags: [pick(ADJ), pick(ADJ), pick(NOUN)],
			types: r() < 0.2 ? [pick(SOUND_TYPE_IDS), pick(SOUND_TYPE_IDS)] : [pick(SOUND_TYPE_IDS)],
			source: { type: pick(['starter', 'pack', 'folder', 'folder', 'synth']) },
			license: pick(['CC0-1.0', 'CC-BY-4.0', 'LicenseRef-UserProvided', 'LicenseRef-UserRoyaltyFree']),
			judge: { ok: true, score: r() },
			descriptors: {
				durationSec: dur,
				peakSec: dur * r(),
				riseMs: r() * 100,
				centroidHz: 200 + r() * 7000,
				below150Share: r() * 0.5,
				flatness: r() * 0.5,
				octaveBandsDb: Array.from({ length: 7 }, () => -40 + r() * 30),
			},
		};
	});
}

describe('ranking 5 000 sounds (finding 10)', () => {
	it('takes < 50 ms (min of 7 runs after a warm-up, a new query each run)', () => {
		const lib = library(5000);
		const report: string[] = [];
		for (const base of [
			{ query: 'heavy punch' },
			{ query: 'door slam', types: ['hit'] },
			{ query: 'swoosh dark', length: 'short' as const, license: 'any' as const },
			{},
		] satisfies SoundRankRequest[]) {
			const run = (i: number) => {
				// Another query string each run (trailing spaces: the same words), so no text score is reused.
				const query = base.query === undefined ? undefined : `${base.query}${' '.repeat(i)}`;
				const t0 = performance.now();
				const out = rankSounds(lib, { ...base, ...(query !== undefined ? { query } : {}) });
				return { ms: performance.now() - t0, n: out.length };
			};
			const warm = run(0);
			const times: number[] = [];
			for (let i = 1; i <= 7; i++) {
				const r = run(i);
				expect(r.n).toBe(warm.n);
				times.push(r.ms);
			}
			times.sort((a, b) => a - b);
			report.push(
				`${JSON.stringify(base)}: ${warm.n} results, min ${times[0]!.toFixed(2)} ms, median ${times[3]!.toFixed(2)} ms`,
			);
			expect(times[0]!).toBeLessThan(50);
		}
		console.log(`rankSounds, 5000 sounds:\n${report.join('\n')}`);
	});
});

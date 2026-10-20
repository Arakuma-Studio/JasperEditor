import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	DESCRIPTOR_FILTERS,
	descriptorDistance,
	durationFit,
	isCommercialSafe,
	licenseClass,
	licensePreference,
	licenseUrlOf,
	type RankableSound,
	rankSounds,
	requiresAttribution,
	resolveTypeNames,
} from '../src/index.ts';

const BANDS = [-20, -18, -16, -15, -17, -20, -26];
function snd(id: string, over: Partial<RankableSound> & { d?: Partial<RankableSound['descriptors']> } = {}) {
	const { d, ...rest } = over;
	return {
		id,
		title: id,
		tags: [],
		types: ['hit'],
		source: { type: 'starter' },
		license: 'CC0-1.0',
		judge: { ok: true, score: 1 },
		...rest,
		descriptors: {
			durationSec: 1.2,
			peakSec: 0.01,
			riseMs: 2,
			centroidHz: 1800,
			below150Share: 0.1,
			above6kShare: 0.1,
			flatness: 0.05,
			octaveBandsDb: BANDS,
			...d,
		},
	} satisfies RankableSound;
}
const ids = (r: { entry: { id: string } }[]) => r.map((x) => x.entry.id);

describe('licences', () => {
	it('classifies SPDX ids and our LicenseRefs', () => {
		expect(licenseClass('CC0-1.0')).toBe('cc0');
		expect(licenseClass('cc0')).toBe('cc0');
		expect(licenseClass('CC-BY-4.0')).toBe('cc-by');
		expect(licenseClass('CC-BY-3.0')).toBe('cc-by');
		expect(licenseClass('CC-BY-SA-4.0')).toBe('cc-by-sa');
		expect(licenseClass('CC-BY-NC-4.0')).toBe('nc');
		expect(licenseClass('CC-BY-NC-SA-3.0')).toBe('nc');
		expect(licenseClass('CC-BY-ND-4.0')).toBe('nd');
		expect(licenseClass('LicenseRef-JasperEditor')).toBe('jasper');
		expect(licenseClass('LicenseRef-UserProvided')).toBe('user-provided');
		expect(licenseClass('LicenseRef-UserRoyaltyFree')).toBe('royalty-free');
		expect(licenseClass('MIT')).toBe('permissive');
		expect(licenseClass('NOASSERTION')).toBe('unknown');
		expect(licenseClass('GPL-3.0')).toBe('unknown');
		expect(licenseClass(7)).toBe('unknown');
	});
	it('commercial-safe = the allowlist plus user-declared royalty-free', () => {
		for (const l of [
			'CC0-1.0',
			'CC-BY-4.0',
			'CC-BY-SA-4.0',
			'LicenseRef-JasperEditor',
			'LicenseRef-UserRoyaltyFree',
		])
			expect(isCommercialSafe(l), l).toBe(true);
		for (const l of ['CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'LicenseRef-UserProvided', 'NOASSERTION', 'WTFPL'])
			expect(isCommercialSafe(l), l).toBe(false);
	});
	it('prefers CC0 > CC-BY > CC-BY-SA > user-provided', () => {
		const order = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'LicenseRef-UserProvided', 'CC-BY-NC-4.0'];
		const prefs = order.map(licensePreference);
		for (let i = 1; i < prefs.length; i++) expect(prefs[i]!).toBeLessThan(prefs[i - 1]!);
		expect(requiresAttribution('CC-BY-4.0')).toBe(true);
		expect(requiresAttribution('CC0-1.0')).toBe(false);
		expect(licenseUrlOf('CC-BY-SA-4.0')).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
		expect(licenseUrlOf('CC0-1.0')).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
		expect(licenseUrlOf('MIT')).toBeNull();
	});
});

describe('rankSounds (spec 12 §2.1)', () => {
	it('matches titles, tags and types with synonyms; words that match nothing drop the sound', () => {
		const list = [
			snd('snd_a', { title: 'Fast Swoosh 03', types: ['whoosh'] }),
			snd('snd_b', { title: 'Door slam', types: ['hit'] }),
			snd('snd_c', { title: 'Air pass', types: [], tags: ['woosh'] }),
			snd('snd_d', { title: 'Big Thing', types: ['boom'] }),
		];
		expect(ids(rankSounds(list, { query: 'whoosh' }))).toEqual(['snd_a', 'snd_c']);
		expect(ids(rankSounds(list, { query: 'impact' }))).toEqual(['snd_b']);
		expect(ids(rankSounds(list, { query: 'sub drop' }))).toEqual(['snd_d']);
		expect(ids(rankSounds(list, { query: 'the sfx' })).length).toBe(4); // stopwords only = no text filter
		const r = rankSounds(list, { query: 'swoo' });
		expect(ids(r)).toEqual(['snd_a']);
		expect(r[0]!.parts.text).toBe(0.75);
	});

	it('a title word (exact or prefix) outranks a match through a type synonym (starter-kit regression)', () => {
		// The starter kit's descriptors (manifest, WP1.2b): "punch" is a synonym of hit, so "Crunchy impact" matched
		// the query as well as "Punch" did, and its duration fit put it first.
		const punch = snd('snd_punch', {
			title: 'Punch',
			tags: ['punch', 'body', 'fight'],
			d: { durationSec: 0.5387, peakSec: 0.0405 },
		});
		const crunchy = snd('snd_crunchy', {
			title: 'Crunchy impact',
			tags: ['crunch', 'explosion', 'debris'],
			d: { durationSec: 1.2558, peakSec: 0.2325 },
		});
		const thump = snd('snd_thump', {
			title: 'Heavy punch thump',
			types: ['thump'],
			tags: ['punch', 'body', 'heavy'],
			d: { durationSec: 0.6464, peakSec: 0.0245 },
		});
		const r = rankSounds([crunchy, thump, punch], { query: 'punch' });
		expect(ids(r).at(-1)).toBe('snd_crunchy');
		expect(ids(r).indexOf('snd_punch')).toBeLessThan(ids(r).indexOf('snd_crunchy'));
		expect(r.find((x) => x.entry.id === 'snd_crunchy')!.parts).toMatchObject({ text: 1, titleMatch: 0 });
		expect(r.find((x) => x.entry.id === 'snd_punch')!.parts).toMatchObject({ text: 1, titleMatch: 1 });
		// Even when the type match scores higher overall, a title prefix comes first.
		const typed = snd('snd_typed', { title: 'Air pass', types: ['whoosh'], d: { durationSec: 0.8 } });
		const titled = snd('snd_titled', {
			title: 'Whooshing drone',
			types: ['riser'],
			judge: { ok: false, score: 0.2 },
			d: { durationSec: 9 },
		});
		const w = rankSounds([typed, titled], { query: 'whoosh' });
		expect(ids(w)).toEqual(['snd_titled', 'snd_typed']);
		expect(w[1]!.score).toBeGreaterThan(w[0]!.score);
		// Without a query there is no title tier.
		expect(rankSounds([punch], {})[0]!.parts.titleMatch).toBeNull();
		// Two-word queries: the share of words the title names.
		expect(rankSounds([thump], { query: 'heavy hit' })[0]!.parts.titleMatch).toBe(0.5);
	});

	it('filters by type (ids or synonyms) and fits types to the visual kind', () => {
		const list = [
			snd('snd_hit', { types: ['hit'] }),
			snd('snd_whoosh', { types: ['whoosh'], d: { durationSec: 1, peakSec: 0.6 } }),
			snd('snd_swish', { types: ['swish'], d: { durationSec: 0.35, peakSec: 0.2 } }),
		];
		expect(ids(rankSounds(list, { types: ['swoosh'] }))).toEqual(['snd_whoosh']);
		expect(rankSounds(list, { types: ['not-a-type'] })).toEqual([]);
		expect(resolveTypeNames(['Swoosh', 'impact', 'nope', 'hit'])).toEqual(['whoosh', 'hit']);
		const moved = rankSounds(list, { visualKind: 'move' });
		// both list `move` first and sit at their ideal lengths: a tie, broken by id
		expect(ids(moved)).toEqual(['snd_swish', 'snd_whoosh', 'snd_hit']);
		expect(moved[0]!.score).toBe(moved[1]!.score);
		expect(moved[2]!.parts.typeFit).toBe(0);
		expect(ids(rankSounds(list, { visualKind: 'land' }))[0]).toBe('snd_hit');
	});

	it('applies the Refine pills at their thresholds (inclusive) and drops unknown descriptors', () => {
		const F = DESCRIPTOR_FILTERS;
		const list = [
			snd('snd_short', { d: { durationSec: 0.29 } }),
			snd('snd_med_lo', { d: { durationSec: 0.3 } }),
			snd('snd_med_hi', { d: { durationSec: 1.5 } }),
			snd('snd_long', { d: { durationSec: 1.51 } }),
		];
		expect(ids(rankSounds(list, { length: 'short' }))).toEqual(['snd_short']);
		expect(ids(rankSounds(list, { length: 'medium' })).sort()).toEqual(['snd_med_hi', 'snd_med_lo']);
		expect(ids(rankSounds(list, { length: 'long' }))).toEqual(['snd_long']);
		const tone = [
			snd('snd_dark', { d: { centroidHz: F.tone.darkMaxHz } }),
			snd('snd_mid', { d: { centroidHz: 2000 } }),
			snd('snd_bright', { d: { centroidHz: F.tone.brightMinHz } }),
			snd('snd_unknown', { d: { centroidHz: undefined } }),
		];
		expect(ids(rankSounds(tone, { tone: 'dark' }))).toEqual(['snd_dark']);
		expect(ids(rankSounds(tone, { tone: 'bright' }))).toEqual(['snd_bright']);
		const misc = [
			snd('snd_a', { d: { riseMs: 10, below150Share: 0.05, flatness: 0.1 } }),
			snd('snd_b', { d: { riseMs: 50, below150Share: 0.3, flatness: 0.25 } }),
		];
		expect(ids(rankSounds(misc, { attack: 'punchy' }))).toEqual(['snd_a']);
		expect(ids(rankSounds(misc, { attack: 'soft' }))).toEqual(['snd_b']);
		expect(ids(rankSounds(misc, { weight: 'light' }))).toEqual(['snd_a']);
		expect(ids(rankSounds(misc, { weight: 'heavy' }))).toEqual(['snd_b']);
		expect(ids(rankSounds(misc, { texture: 'clean' }))).toEqual(['snd_a']);
		expect(ids(rankSounds(misc, { texture: 'noisy' }))).toEqual(['snd_b']);
	});

	it('is commercial-safe by default and prefers obligation-free licences', () => {
		const list = [
			snd('snd_nc', { license: 'CC-BY-NC-4.0' }),
			snd('snd_user', { license: 'LicenseRef-UserProvided' }),
			snd('snd_by', { license: 'CC-BY-4.0' }),
			snd('snd_cc0', { license: 'CC0-1.0' }),
			snd('snd_rf', { license: 'LicenseRef-UserRoyaltyFree' }),
		];
		expect(ids(rankSounds(list))).toEqual(['snd_cc0', 'snd_by', 'snd_rf']);
		expect(ids(rankSounds(list, { license: 'any' }))).toEqual([
			'snd_cc0',
			'snd_by',
			'snd_rf',
			'snd_user',
			'snd_nc',
		]);
	});

	it('always ranks real recordings above Jasper Synth', () => {
		const list = [
			snd('snd_synth', { source: { type: 'synth' }, title: 'hit hit', license: 'LicenseRef-JasperEditor' }),
			snd('snd_folder', {
				source: { type: 'folder' },
				license: 'LicenseRef-UserRoyaltyFree',
				judge: { ok: false, score: 0.3 },
				d: { durationSec: 9 },
			}),
		];
		const r = rankSounds(list, { query: 'hit' });
		expect(ids(r)).toEqual(['snd_folder', 'snd_synth']);
		expect(r[1]!.score).toBeGreaterThan(r[0]!.score);
	});

	it('penalises sounds used nearby (rotation), nearest most', () => {
		const list = [snd('snd_a'), snd('snd_b'), snd('snd_c')];
		expect(ids(rankSounds(list))).toEqual(['snd_a', 'snd_b', 'snd_c']);
		const r = rankSounds(list, {}, { usedNearby: ['snd_a', 'snd_b'] });
		expect(ids(r)).toEqual(['snd_c', 'snd_b', 'snd_a']);
		expect(r.find((x) => x.entry.id === 'snd_a')!.parts.rotation).toBe(0.3);
		expect(r.find((x) => x.entry.id === 'snd_b')!.parts.rotation).toBe(0.15);
	});

	it('fits durations to cue windows: a riser that ends on the cue should fill the build', () => {
		const list = [
			snd('snd_r1', { types: ['riser'], d: { durationSec: 1 } }),
			snd('snd_r3', { types: ['riser'], d: { durationSec: 3 } }),
			snd('snd_r8', { types: ['riser'], d: { durationSec: 8 } }),
		];
		expect(ids(rankSounds(list, { windowSec: 3 }))[0]).toBe('snd_r3');
		expect(ids(rankSounds(list, { windowSec: 8 }))[0]).toBe('snd_r8');
		expect(durationFit({ durationSec: 3 }, 'riser', 3)).toBe(1);
		// whooshes measure their run-up to the peak
		expect(durationFit({ durationSec: 4, peakSec: 0.5 }, 'whoosh', 0.5)).toBe(1);
		// one-shots ignore windows and prefer their ideal length
		expect(durationFit({ durationSec: 1.2 }, 'hit', 10)).toBe(1);
		expect(durationFit({ durationSec: 0 }, 'hit')).toBe(0);
		expect(durationFit({ durationSec: 20 }, 'hit')).toBeLessThan(0.1);
	});

	it('ranks by similarity to a reference and leaves the reference out', () => {
		const ref = snd('snd_ref', { d: { durationSec: 1, centroidHz: 1000, flatness: 0.1 } });
		const list = [
			ref,
			snd('snd_far', {
				d: {
					durationSec: 6,
					centroidHz: 9000,
					flatness: 0.9,
					octaveBandsDb: [-60, -50, -40, -30, -20, -10, -5],
				},
			}),
			snd('snd_near', { d: { durationSec: 1.1, centroidHz: 1100, flatness: 0.12 } }),
		];
		const r = rankSounds(list, { similarTo: { id: 'snd_ref', descriptors: ref.descriptors } });
		expect(ids(r)).toEqual(['snd_near', 'snd_far']);
		expect(descriptorDistance(ref.descriptors, ref.descriptors)).toBe(0);
		expect(descriptorDistance({ durationSec: Number.NaN }, { durationSec: 1 })).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	it('breaks ties by id and gives the same order for any input order', () => {
		const list = ['snd_d', 'snd_b', 'snd_a', 'snd_c'].map((id) => snd(id));
		expect(ids(rankSounds(list))).toEqual(['snd_a', 'snd_b', 'snd_c', 'snd_d']);
		fc.assert(
			fc.property(fc.shuffledSubarray(list, { minLength: 4, maxLength: 4 }), (shuffled) => {
				expect(ids(rankSounds(shuffled))).toEqual(['snd_a', 'snd_b', 'snd_c', 'snd_d']);
			}),
			{ numRuns: 50, seed: 7 },
		);
		expect(rankSounds(list, { limit: 2 })).toHaveLength(2);
		expect(rankSounds(list, { limit: -5 })).toHaveLength(1);
	});

	it('never throws on hostile entries and requests; scores stay finite (property)', () => {
		const num = fc.oneof(
			fc.double(),
			fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1e300),
			fc.integer({ min: -10, max: 10_000 }),
		);
		const entry = fc.record(
			{
				id: fc.oneof(fc.string({ maxLength: 12 }), fc.constant(undefined)),
				title: fc.oneof(fc.string({ maxLength: 40 }), fc.constant(null)),
				tags: fc.oneof(
					fc.array(fc.oneof(fc.string({ maxLength: 10 }), fc.integer())),
					fc.constant(undefined),
				),
				types: fc.oneof(
					fc.array(fc.constantFrom('hit', 'whoosh', 'riser', 'x', '__proto__')),
					fc.constant(null),
				),
				source: fc.oneof(
					fc.record({ type: fc.constantFrom('starter', 'synth', 'folder', 'odd') }),
					fc.constant(null),
				),
				license: fc.oneof(fc.constantFrom('CC0-1.0', 'CC-BY-4.0', 'x'), fc.integer()),
				descriptors: fc.oneof(
					fc.record({
						durationSec: num,
						peakSec: num,
						riseMs: num,
						centroidHz: num,
						below150Share: num,
						above6kShare: num,
						flatness: num,
						octaveBandsDb: fc.oneof(fc.array(num, { maxLength: 9 }), fc.constant(undefined)),
					}),
					fc.constant(undefined),
				),
				judge: fc.oneof(fc.record({ ok: fc.boolean(), score: num }), fc.constant(null)),
			},
			{ requiredKeys: [] },
		);
		const request = fc.record(
			{
				query: fc.string({ maxLength: 30 }),
				types: fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
				visualKind: fc.constantFrom('cut', 'move', 'land'),
				windowSec: num,
				length: fc.constantFrom('short', 'medium', 'long'),
				tone: fc.constantFrom('dark', 'bright'),
				license: fc.constantFrom('any', 'commercial-safe'),
				limit: num,
			},
			{ requiredKeys: [] },
		);
		fc.assert(
			fc.property(
				fc.array(entry, { maxLength: 12 }),
				request,
				fc.array(fc.string(), { maxLength: 4 }),
				(es, req, used) => {
					const r = rankSounds(es as unknown as RankableSound[], req as never, { usedNearby: used });
					for (const x of r) expect(Number.isFinite(x.score)).toBe(true);
				},
			),
			{ numRuns: 300, seed: 1215 },
		);
	});
});

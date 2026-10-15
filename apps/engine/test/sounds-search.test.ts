// Sound library search at scale (spec 12 §2.1; wp-note "WP1.2 engine library" ▸ "Review fixes", finding 10): the
// one-pass facets equal the disjunctive counts of four `rankSounds` passes (the previous algorithm, kept here as the
// oracle) on random libraries and queries, and a search over a synthetic 5 000-sound library takes < 50 ms.
import { performance } from 'node:perf_hooks';
import {
	type SoundEntry,
	type SoundFacets,
	type SoundSearchQuery,
	SoundSearchQuerySchema,
} from '@jasper/api';
import {
	isSoundTypeId,
	licenseClass,
	rankSounds,
	SOUND_TYPE_IDS,
	SOUND_TYPES,
	type SoundTypeId,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { rankRequestOf, searchSoundEntries } from '../src/sounds/search.ts';

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

const ADJECTIVES = [
	'heavy',
	'light',
	'metal',
	'wood',
	'glass',
	'deep',
	'sharp',
	'soft',
	'big',
	'small',
	'distant',
	'close',
	'fast',
	'slow',
	'punchy',
	'dark',
	'bright',
	'cinematic',
	'retro',
	'digital',
	'organic',
	'short',
	'long',
	'wet',
	'dry',
];
const NOUNS: Partial<Record<SoundTypeId, string[]>> = {
	hit: ['punch', 'impact', 'slam', 'door slam', 'strike', 'smash', 'hit'],
	boom: ['boom', 'sub drop', 'explosion', 'rumble', 'braam'],
	riser: ['riser', 'build up', 'tension', 'swell'],
	reverse: ['reverse cymbal', 'suck back', 'reverse'],
	transition: ['transition', 'sweep', 'scene change'],
	whoosh: ['whoosh', 'swoosh', 'pass by', 'fly by'],
	swish: ['swish', 'swipe', 'whip'],
	glitch: ['glitch', 'stutter', 'bit crush'],
	ui: ['button', 'notification', 'beep', 'menu'],
	click: ['click', 'mouse click', 'switch', 'toggle'],
	key: ['keyboard', 'typing', 'typewriter'],
	tick: ['tick', 'clock', 'metronome'],
	tap: ['tap', 'knock', 'finger tap'],
	pop: ['pop', 'bubble', 'cork'],
	thump: ['thump', 'thud', 'body fall'],
	paper: ['paper', 'page turn', 'crumple'],
	chime: ['chime', 'bell', 'ding'],
	shimmer: ['shimmer', 'sparkle', 'twinkle'],
	zap: ['zap', 'laser', 'spark'],
	ambience: ['ambience', 'city atmosphere', 'forest background'],
	roomtone: ['room tone', 'air tone'],
};
const LICENSES = [
	'CC0-1.0',
	'CC-BY-4.0',
	'CC-BY-SA-4.0',
	'LicenseRef-UserProvided',
	'LicenseRef-UserRoyaltyFree',
	'CC-BY-NC-4.0',
];
const ROOTS = ['root_000000000001', 'root_000000000002', 'root_000000000003'];

/** A synthetic library of `n` realistic entries (titles, tags, 1–2 types, descriptors, sources, licences). */
function syntheticLibrary(n: number, seed = 1): SoundEntry[] {
	const r = rng(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
	const out: SoundEntry[] = [];
	for (let i = 0; i < n; i++) {
		const t1 = pick(SOUND_TYPE_IDS);
		const types: string[] = [t1];
		if (r() < 0.25) types.push(pick(SOUND_TYPE_IDS));
		if (r() < 0.05) types.push('custom-type');
		const noun = pick(NOUNS[t1] ?? [t1]);
		const title =
			`${pick(ADJECTIVES)} ${noun} ${r() < 0.5 ? pick(ADJECTIVES) : ''} ${1 + Math.floor(r() * 40)}`
				.replace(/\s+/g, ' ')
				.trim();
		const tags = Array.from({ length: 2 + Math.floor(r() * 5) }, () => pick(ADJECTIVES));
		if (r() < 0.3) tags.push(pick(NOUNS[pick(SOUND_TYPE_IDS)] ?? ['x']));
		const s = r();
		const source =
			s < 0.55
				? { type: 'folder' as const, rootId: pick(ROOTS), relPath: `${t1}/${title}.wav` }
				: s < 0.8
					? { type: 'pack' as const, packId: 'pack-a', file: `${title}.wav` }
					: s < 0.93
						? { type: 'starter' as const, file: `${title}.ogg` }
						: { type: 'synth' as const, recipe: t1, seed: i % 8 };
		const dur = 0.03 * 10 ** (r() * 3);
		const id = `snd_${(i + 1).toString(16).padStart(16, '0')}`;
		out.push({
			id,
			fingerprint: `q1:${(i + 1).toString(16).padStart(64, '0')}`,
			title,
			types,
			tags,
			source,
			license: source.type === 'synth' ? 'LicenseRef-JasperEditor' : pick(LICENSES),
			author: 'Someone',
			attribution: null,
			format: { durationSec: dur, sampleRate: 48000, channels: 2, container: 'wav' },
			descriptors: {
				durationSec: dur,
				peakSec: dur * r(),
				onsetSec: 0.01,
				riseMs: r() * 120,
				decayMs: 100,
				decays: true,
				tailSec: dur / 2,
				centroidHz: 200 + r() * 7000,
				rolloff85Hz: 4000,
				below150Share: r() * 0.6,
				above6kShare: r() * 0.3,
				flatness: r() * 0.5,
				octaveBandsDb: Array.from({ length: 7 }, () => -40 + r() * 30),
				pitchMidi: null,
				pitchConfidence: 0.1,
				onsetCount: 1,
				integratedLufs: -20,
				maxMomentaryLufs: -15,
				truePeakDb: -3,
				stereoWidth: 0.1,
				headQuietSec: 0.01,
				loopable: false,
			},
			judge: r() < 0.9 ? { ok: r() < 0.8, score: r(), reasons: [], type: t1 } : null,
			indexedAt: '2026-10-15T00:00:00.000Z',
			analysisVersion: 1001,
		} as SoundEntry);
	}
	return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The previous algorithm (four ranking passes), the oracle of the one-pass facets. */
function oracle(all: SoundEntry[], q: SoundSearchQuery, includeFolders: boolean) {
	const byId = new Map(all.map((e) => [e.id, e]));
	const { req, none } = rankRequestOf(q, (id) => byId.get(id));
	const visible = includeFolders ? all : all.filter((e) => e.source.type !== 'folder');
	const byRoot = q.rootId
		? visible.filter((e) => e.source.type === 'folder' && e.source.rootId === q.rootId)
		: visible;
	const sources = q.sources?.length ? new Set<string>(q.sources) : null;
	const pool = sources ? byRoot.filter((e) => sources.has(e.source.type)) : byRoot;
	const ranked = none ? [] : rankSounds(pool, req, q.usedNearby?.length ? { usedNearby: q.usedNearby } : {});
	const facets: SoundFacets = { types: {}, families: {}, licenses: {}, sources: {} };
	const bump = (rec: Record<string, number>, k: string) => {
		rec[k] = (rec[k] ?? 0) + 1;
	};
	const { types: _t, ...noTypes } = req;
	for (const r of rankSounds(pool, noTypes)) {
		const fams = new Set<string>();
		for (const t of r.entry.types)
			if (isSoundTypeId(t)) {
				bump(facets.types, t);
				fams.add(SOUND_TYPES[t].family);
			}
		for (const f of fams) bump(facets.families, f);
	}
	if (!none) {
		for (const r of rankSounds(pool, { ...req, license: 'any' }))
			bump(facets.licenses, licenseClass(r.entry.license));
		for (const r of rankSounds(byRoot, req)) bump(facets.sources, r.entry.source.type);
	}
	return { ranked, facets };
}

function randomQuery(r: () => number, all: SoundEntry[]): SoundSearchQuery {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
	const raw: Record<string, string> = {};
	const words = [...ADJECTIVES, ...Object.values(NOUNS).flat(), 'constructor', 'zzz', 'the'];
	if (r() < 0.7) raw.q = Array.from({ length: Math.floor(r() * 4) }, () => pick(words)).join(' ');
	if (r() < 0.3)
		raw.types = Array.from({ length: 1 + Math.floor(r() * 2) }, () =>
			pick([...SOUND_TYPE_IDS, 'swoosh', 'nope']),
		).join(',');
	if (r() < 0.2) raw.family = pick(['impacts', 'movement', 'digital', 'tactile', 'tonal', 'beds']);
	if (r() < 0.2) raw.length = pick(['short', 'medium', 'long']);
	if (r() < 0.2) raw.tone = pick(['dark', 'bright']);
	if (r() < 0.15) raw.attack = pick(['punchy', 'soft']);
	if (r() < 0.15) raw.weight = pick(['light', 'heavy']);
	if (r() < 0.15) raw.texture = pick(['clean', 'noisy']);
	if (r() < 0.5) raw.license = pick(['any', 'commercial-safe']);
	if (r() < 0.3)
		raw.sources = Array.from({ length: 1 + Math.floor(r() * 2) }, () =>
			pick(['starter', 'pack', 'folder', 'synth']),
		).join(',');
	if (r() < 0.15) raw.rootId = pick(ROOTS);
	if (r() < 0.15) raw.similarTo = pick(all).id;
	if (r() < 0.2) raw.usedNearby = [pick(all).id, pick(all).id].join(',');
	if (r() < 0.2) raw.visualKind = pick(['cut', 'transition', 'land', 'appear']);
	return SoundSearchQuerySchema.parse(raw);
}

describe('search facets in one pass (finding 10)', () => {
	it('equal the four-pass disjunctive counts, with the same results, on random libraries and queries', () => {
		for (let lib = 0; lib < 4; lib++) {
			const all = syntheticLibrary(400, 100 + lib);
			const byId = new Map(all.map((e) => [e.id, e]));
			const r = rng(7 + lib);
			for (let i = 0; i < 120; i++) {
				const q = randomQuery(r, all);
				const includeFolders = r() < 0.8;
				const want = oracle(all, q, includeFolders);
				const got = searchSoundEntries(
					all,
					{ ...q, limit: 500 },
					{ lookup: (id) => byId.get(id), includeFolders },
				);
				expect(got.facets, JSON.stringify(q)).toEqual(want.facets);
				expect(got.total).toBe(want.ranked.length);
				expect(got.results.map((x) => [x.sound.id, x.score])).toEqual(
					want.ranked.slice(0, 500).map((x) => [x.entry.id, x.score]),
				);
			}
		}
	});
});

describe('search speed (finding 10: < 50 ms for thousands of sounds)', () => {
	it('searches a synthetic 5 000-sound library in < 50 ms (min of 7 runs after a warm-up)', () => {
		const all = syntheticLibrary(5000, 42);
		const byId = new Map(all.map((e) => [e.id, e]));
		const queries: Record<string, string>[] = [
			{ q: 'heavy punch' },
			{ q: 'door slam' },
			{ q: '' },
			{},
			{ q: 'heavy punch', types: 'hit', length: 'short', license: 'any' },
			{ q: 'whoosh', family: 'movement', tone: 'dark' },
			{ types: 'whoosh,swoosh', weight: 'heavy', attack: 'punchy', sources: 'folder,pack' },
			{ q: 'metal impact cinematic', visualKind: 'land', windowSec: '0.5' },
		];
		// Every run sends another query string with the same words (trailing spaces), so no run reuses the text scores
		// of the one before (only the per-sound tokens, which stay valid for the library).
		const variant = (text: string, i: number) => `${text}${' '.repeat(i)}`;
		const report: string[] = [];
		for (const raw of queries) {
			const run = (i: number) => {
				const q = SoundSearchQuerySchema.parse(raw.q ? { ...raw, q: variant(raw.q, i) } : raw);
				const t0 = performance.now();
				searchSoundEntries(all, q, { lookup: (id) => byId.get(id), includeFolders: true });
				return performance.now() - t0;
			};
			run(0); // warm-up (the per-sound token cache, JIT)
			const times: number[] = [];
			for (let i = 1; i <= 7; i++) times.push(run(i));
			times.sort((a, b) => a - b);
			report.push(
				`${JSON.stringify(raw)}: min ${times[0]!.toFixed(2)} ms, median ${times[3]!.toFixed(2)} ms`,
			);
			expect(times[0]!, JSON.stringify(raw)).toBeLessThan(50);
		}
		console.log(`sound search, 5000 sounds:\n${report.join('\n')}`);
	});
});

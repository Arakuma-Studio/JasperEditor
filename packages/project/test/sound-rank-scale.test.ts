// Sound ranking at library scale and against hostile names (spec 12 §2.1; wp-note "WP1.2 engine library" ▸ "Review
// fixes", findings 10 and 11): prototype keys name no type, query words are deduplicated and capped, `soundFilterOf`
// returns literal expected pages/filter results, and ranking 5 000 sounds takes < 50 ms of executing-thread CPU time.
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { threadCpuMs } from '../../../scripts/perf/cpu.ts';
import {
	inferTypesFromName,
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

	it('only the first 16 distinct words are matched', () => {
		const filler = Array.from({ length: 16 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
		const lib = [snd('snd_a', 'Punch')];
		expect(rankSounds(lib, { query: `punch ${filler.join(' ')}` })).toHaveLength(1);
		expect(rankSounds(lib, { query: `${filler.join(' ')} punch` })).toEqual([]);
	});
});

describe('rankSoundsPage', () => {
	it('pages eligible sounds in id order and counts matches independently of the page', () => {
		const entries = [
			snd('snd_a', 'Punch'),
			snd('snd_b', 'Punch'),
			snd('snd_c', 'Punch'),
			snd('snd_nc', 'Punch', { license: 'CC-BY-NC-4.0' }),
			snd('snd_pack', 'Punch', { source: { type: 'pack' } }),
			snd('snd_whoosh', 'Air', { types: ['whoosh'] }),
		];
		for (const library of [entries, [...entries].reverse()]) {
			const req = { types: ['hit'] };
			const page = rankSoundsPage(
				library,
				req,
				{},
				{
					inRanking: (e) => e.source.type !== 'pack',
					offset: 1,
					limit: 2,
				},
			);
			expect(page.total).toBe(3);
			expect(page.results.map((r) => r.entry.id)).toEqual(['snd_b', 'snd_c']);
			expect(rankSoundsPage(library, req, {}, { offset: 10, limit: 2 }).results).toEqual([]);
			const filter = soundFilterOf(req);
			expect(
				library
					.filter((e) => filter(e) === SOUND_FILTER_ALL)
					.map((e) => e.id)
					.sort(),
			).toEqual(['snd_a', 'snd_b', 'snd_c', 'snd_pack']);
		}
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

/**
 * The budget of one search: 50 ms of CPU time, whatever the host's load. Wall time on an oversubscribed shared host
 * mostly measures the wait for a core (the old check scaled its budget with the load average: 100 ms at load 64 on 16
 * cores, so it was loose when strict mattered and still flaky in spikes); CPU time is what the search itself costs. The
 * code before finding 10 took ≈ 560 ms, so a regression of that kind still fails by an order of magnitude.
 */
const BUDGET_CPU_MS = 50;

/** Current-thread CPU time and wall time (ms) of `fn`. */
function cpuTimed(fn: () => void): { cpu: number; wall: number } {
	const c0 = threadCpuMs();
	const t0 = performance.now();
	fn();
	const wall = performance.now() - t0;
	return { cpu: threadCpuMs() - c0, wall };
}

/** Minimum CPU time and median wall time of seven queries after the warm-up. */
function measure(run: (i: number) => { cpu: number; wall: number }): { min: number; wallMedian: number } {
	const runs = Array.from({ length: 7 }, (_, i) => run(i + 1));
	const cpu = runs.map((r) => r.cpu).sort((a, b) => a - b);
	const wall = runs.map((r) => r.wall).sort((a, b) => a - b);
	return { min: cpu[0]!, wallMedian: wall[3]! };
}

describe('ranking 5 000 sounds (finding 10)', () => {
	it('takes < 50 ms of CPU time (min of 7 runs after a warm-up, a new query each run)', () => {
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
				let n = 0;
				const t = cpuTimed(() => {
					n = rankSounds(lib, { ...base, ...(query !== undefined ? { query } : {}) }).length;
				});
				return { ...t, n };
			};
			const warm = run(0);
			const t = measure((i) => {
				const r = run(i);
				expect(r.n).toBe(warm.n);
				return r;
			});
			report.push(
				`${JSON.stringify(base)}: ${warm.n} results, min CPU ${t.min.toFixed(2)} ms, median wall ${t.wallMedian.toFixed(2)} ms`,
			);
			expect(t.min).toBeLessThan(BUDGET_CPU_MS);
		}
		console.log(
			`rankSounds, 5000 sounds (load ${loadavg()[0]!.toFixed(1)}, CPU budget ${BUDGET_CPU_MS} ms):\n${report.join('\n')}`,
		);
	});
});

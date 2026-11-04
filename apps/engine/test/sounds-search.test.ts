// Sound library search at scale (spec 12 §2.1; wp-note "WP1.2 engine library" ▸ "Review fixes", finding 10):
// a search over a synthetic 5 000-sound library takes < 50 ms of
// main-thread CPU time (not wall time: one strict budget whatever the host's load).
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';
import { type SoundEntry, SoundSearchQuerySchema } from '@jasper/api';
import { materialsOf, SOUND_TYPE_IDS, type SoundTypeId } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { searchSoundEntries } from '../src/sounds/search.ts';

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
			materials: materialsOf([title, ...tags]),
		} as SoundEntry);
		// some multi-hit recordings with takes (P6-E9), a few of them cut
		if (r() < 0.1) {
			const e = out[out.length - 1]!;
			e.takes = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, k) => ({
				index: k + 1,
				startSec: k * 0.3,
				endSec: k * 0.3 + 0.2,
				headDb: -40,
				tailDb: -40,
				flags: r() < 0.25 ? ['tail-cut' as const] : [],
				strokes: 1 as const,
				descriptors: { ...e.descriptors, durationSec: 0.2, peakSec: 0.01, riseMs: r() * 20 },
				judge: { ok: true, score: r(), reasons: [], type: t1 },
			}));
		}
	}
	return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

describe('disjunctive search facets', () => {
	it('ignores only each facet’s own source or licence filter', () => {
		const base: SoundEntry = {
			...syntheticLibrary(1)[0]!,
			title: 'Hit',
			types: ['hit'],
			tags: [],
			materials: [],
			takes: undefined,
			judge: null,
		};
		const starter = { type: 'starter' as const, file: 'hit.wav' };
		const pack = { type: 'pack' as const, packId: 'hits', file: 'hit.wav' };
		const all: SoundEntry[] = [
			{ ...base, id: 'snd_0000000000000001', source: starter, license: 'CC0-1.0' },
			{ ...base, id: 'snd_0000000000000002', source: starter, license: 'CC-BY-SA-4.0' },
			{ ...base, id: 'snd_0000000000000003', source: pack, license: 'CC0-1.0' },
			{ ...base, id: 'snd_0000000000000004', source: pack, license: 'CC-BY-SA-4.0' },
		];
		const result = searchSoundEntries(
			all,
			SoundSearchQuerySchema.parse({ sources: 'starter', license: 'commercial-safe' }),
			{ lookup: (id) => all.find((entry) => entry.id === id), includeFolders: true },
		);
		expect(result.total).toBe(1);
		expect(result.results.map((row) => row.sound.id)).toEqual(['snd_0000000000000001']);
		expect(result.facets.sources).toEqual({ starter: 1, pack: 1 });
		expect(result.facets.licenses).toEqual({ cc0: 1, 'cc-by-sa': 1 });
	});
});

/**
 * The budget of one search: 50 ms of CPU time, whatever the host's load. Wall time on an oversubscribed shared host
 * mostly measures the wait for a core (the old check scaled its budget with the load average: 100 ms at load 64 on 16
 * cores, so it was loose when strict mattered and still flaky in spikes); CPU time is what the search itself costs. The
 * code before finding 10 took ≈ 560 ms, so a regression of that kind still fails by an order of magnitude.
 */
const BUDGET_CPU_MS = 50;

/**
 * CPU time (ms) of this thread on the CPU, ns-exact: the first field of Linux's `/proc/self/task/<tid>/schedstat`.
 * Only the main thread is counted — `process.cpuUsage` adds V8's concurrent GC and compiler threads, which made one
 * search "cost" 26 ms of CPU in 12 ms of wall time at load 53. Vitest runs each test file in its own forked process
 * (the default `forks` pool), whose main thread is this one. Elsewhere (no procfs) `process.cpuUsage` stands in.
 */
function threadCpuMs(): number {
	try {
		const ns = Number(readFileSync(`/proc/self/task/${process.pid}/schedstat`, 'utf8').split(' ')[0]);
		if (Number.isFinite(ns)) return ns / 1e6;
	} catch {
		// no procfs: fall through
	}
	const c = process.cpuUsage();
	return (c.user + c.system) / 1000;
}

/** Main-thread CPU time and wall time (ms) of `fn`. */
function cpuTimed(fn: () => void): { cpu: number; wall: number } {
	if (!isMainThread) throw new Error('the CPU-time budget needs the forks pool (one process per test file)');
	const c0 = threadCpuMs();
	const t0 = performance.now();
	fn();
	const wall = performance.now() - t0;
	return { cpu: threadCpuMs() - c0, wall };
}

/** Min CPU and median wall time of one fixed set of 7 runs after the warm-up. */
function measure(run: (i: number) => { cpu: number; wall: number }): { min: number; wallMedian: number } {
	const runs = Array.from({ length: 7 }, (_, i) => run(i + 1));
	const cpu = runs.map((r) => r.cpu).sort((a, b) => a - b);
	const wall = runs.map((r) => r.wall).sort((a, b) => a - b);
	return { min: cpu[0]!, wallMedian: wall[3]! };
}

describe('search speed (finding 10: < 50 ms for thousands of sounds)', () => {
	it('searches a synthetic 5 000-sound library in < 50 ms of CPU time (min of 7 runs after a warm-up)', {
		timeout: 300_000,
	}, () => {
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
				return cpuTimed(() =>
					searchSoundEntries(all, q, { lookup: (id) => byId.get(id), includeFolders: true }),
				);
			};
			run(0); // warm-up (the per-sound token cache, JIT)
			const t = measure(run);
			report.push(
				`${JSON.stringify(raw)}: min CPU ${t.min.toFixed(2)} ms, median wall ${t.wallMedian.toFixed(2)} ms`,
			);
			expect(t.min, JSON.stringify(raw)).toBeLessThan(BUDGET_CPU_MS);
		}
		console.log(
			`sound search, 5000 sounds (load ${loadavg()[0]!.toFixed(1)}, CPU budget ${BUDGET_CPU_MS} ms):\n${report.join('\n')}`,
		);
	});
});

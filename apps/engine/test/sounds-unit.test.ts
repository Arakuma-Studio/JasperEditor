// Sound library units (spec 12 WP1.2): manifest loading, visual data, attribution and naming, the index store's
// persistence and recovery, request schemas under fuzzing.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	SOUND_SPECTROGRAM_BINS,
	type SoundEntry,
	SoundRootsPutRequestSchema,
	SoundSearchQuerySchema,
	soundSearchParams,
} from '@jasper/api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { attributionFor, tagsFromPath, titleFromFile } from '../src/sounds/index-job.ts';
import { SoundLibrary, snapshotHashOf } from '../src/sounds/library.ts';
import { loadManifest, loadPackManifest } from '../src/sounds/starter.ts';
import { computePeaks, computeSpectrogram, computeVisual } from '../src/sounds/visual.ts';
import { makeStarter, PACK, SR, samples } from './sound-fixtures.ts';
import { tempAppdir } from './temp.ts';

const entry = (id: string, extra: Partial<SoundEntry> = {}): SoundEntry => ({
	id,
	fingerprint: `q1:${'0'.repeat(64)}`,
	title: 'A sound',
	types: ['hit'],
	tags: [],
	source: { type: 'starter', file: 'a.wav' },
	license: 'CC0-1.0',
	author: 'Someone',
	attribution: null,
	format: { durationSec: 1, sampleRate: 48000, channels: 2, container: 'wav' },
	descriptors: {
		durationSec: 1,
		peakSec: 0.1,
		onsetSec: 0.05,
		riseMs: 2,
		decayMs: 100,
		decays: true,
		tailSec: 0.5,
		centroidHz: 1000,
		rolloff85Hz: 4000,
		below150Share: 0.1,
		above6kShare: 0.1,
		flatness: 0.2,
		octaveBandsDb: [-30, -30, -30, -30, -30, -30, -30],
		pitchMidi: null,
		pitchConfidence: 0.1,
		onsetCount: 1,
		integratedLufs: -20,
		maxMomentaryLufs: -15,
		truePeakDb: -3,
		stereoWidth: 0.1,
		headQuietSec: 0.04,
		loopable: false,
	},
	judge: { ok: true, score: 1, reasons: [], type: 'hit' },
	indexedAt: '2026-10-15T00:00:00.000Z',
	analysisVersion: 1001,
	...extra,
});

describe('starter manifest', () => {
	it('tolerates an absent kit and reports unreadable manifests without throwing', async () => {
		const dir = tempAppdir('jasper-starter-');
		expect(await loadManifest(join(dir, 'nothing'))).toMatchObject({
			status: 'absent',
			sounds: [],
			hash: '',
		});
		writeFileSync(join(dir, 'manifest.json'), '{ not json');
		expect(await loadManifest(dir)).toMatchObject({ status: 'invalid', sounds: [] });
		writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 2, packs: [], sounds: [] }));
		expect((await loadManifest(dir)).status).toBe('invalid');
		writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, packs: [], sounds: [] }));
		expect(await loadManifest(dir)).toMatchObject({ status: 'ok', sounds: [], errors: [] });
	});

	it('keeps valid entries and skips non-audio files, escaping paths and unknown packs', async () => {
		const dir = makeStarter(tempAppdir('jasper-starter-'));
		const m = await loadManifest(dir);
		expect(m.status).toBe('ok');
		expect(m.sounds.map((s) => s.file)).toEqual([
			'impacts/hit_heavy.wav',
			'impacts/hit_light.wav',
			'movement/whoosh_fast.wav',
			'ui/click_soft.wav',
		]);
		expect(m.errors).toHaveLength(3);
		expect(m.errors.join('\n')).toMatch(/not an audio file/);
		expect(m.errors.join('\n')).toMatch(/sounds\[5\]/);
		expect(m.errors.join('\n')).toMatch(/unknown pack "nope"/);
		expect(m.packs).toEqual([PACK]);
		expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('reads an installed pack only when it describes exactly that pack', async () => {
		const dir = tempAppdir('jasper-pack-');
		writeFileSync(
			join(dir, 'pack.json'),
			JSON.stringify({
				version: 1,
				packs: [PACK],
				sounds: [{ file: 'a.wav', title: 'A', author: 'x', license: 'CC0-1.0' }],
			}),
		);
		const ok = await loadPackManifest(dir, PACK.id);
		expect(ok.status).toBe('ok');
		expect(ok.sounds[0]!.packId).toBe(PACK.id);
		expect((await loadPackManifest(dir, 'other')).status).toBe('invalid');
	});

	it('never throws on hostile manifests (property)', async () => {
		const dir = tempAppdir('jasper-starter-fuzz-');
		await fc.assert(
			fc.asyncProperty(fc.jsonValue(), async (v) => {
				writeFileSync(join(dir, 'manifest.json'), JSON.stringify(v));
				const m = await loadManifest(dir);
				expect(['ok', 'invalid']).toContain(m.status);
			}),
			{ numRuns: 150, seed: 0x5eed },
		);
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({ file: fc.string(), title: fc.string(), author: fc.string(), license: fc.string() }),
					{
						maxLength: 8,
					},
				),
				async (sounds) => {
					writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, packs: [], sounds }));
					const m = await loadManifest(dir);
					for (const s of m.sounds) {
						expect(s.file.split('/')).not.toContain('..');
						expect(s.file.startsWith('/')).toBe(false);
					}
				},
			),
			{ numRuns: 150, seed: 0x5eed },
		);
	});
});

describe('visual data', () => {
	it('peaks: 100 per second, max |sample| over channels as u8', () => {
		const ch = [new Float32Array(SR), new Float32Array(SR)];
		ch[0]![100] = 0.5;
		ch[1]![600] = -1;
		ch[0]![SR - 1] = Number.NaN;
		const p = computePeaks(ch, SR, 100);
		expect(p.length).toBe(100);
		expect(p[0]).toBe(128);
		expect(p[1]).toBe(255);
		expect(p[2]).toBe(0);
		expect(p[99]).toBe(0);
		expect(computePeaks([], SR, 100).length).toBe(0);
	});

	it('spectrogram: a full-scale 1 kHz sine lights the band holding 1 kHz at ≈ 0 dB', () => {
		const n = SR / 2;
		const sine = new Float32Array(n);
		for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 1000 * i) / SR);
		const s = computeSpectrogram([sine], SR);
		expect(s.frames).toBe(50);
		expect(s.framesPerSecond).toBe(100);
		const bins = SOUND_SPECTROGRAM_BINS;
		const band = Math.floor((Math.log(1000 / s.minHz) / Math.log(s.maxHz / s.minHz)) * bins);
		const mid = s.data.subarray(25 * bins, 26 * bins);
		const loudest = mid.indexOf(Math.max(...mid));
		expect(Math.abs(loudest - band)).toBeLessThanOrEqual(1);
		// Within 3 dB of 0 dBFS (255 = 0 dB, 96 dB over 255 steps).
		expect(mid[loudest]!).toBeGreaterThan(255 - (3 * 255) / 96);
		// Far bands are near the floor.
		expect(mid[2]!).toBeLessThan(60);
		expect(mid[bins - 2]!).toBeLessThan(60);
	});

	it('bounds long input to 3000 frames and handles silence, NaN and empty input', () => {
		const long = new Float32Array(SR * 40);
		const s = computeSpectrogram([long], SR);
		expect(s.frames).toBe(3000);
		expect(s.data.every((v) => v === 0)).toBe(true);
		const bad = new Float32Array(1000).fill(Number.NaN);
		expect(computeSpectrogram([bad], SR).data.every((v) => v === 0)).toBe(true);
		expect(computeSpectrogram([], SR).frames).toBe(0);
		const v = computeVisual({
			soundId: 'snd_0000000000000000',
			fingerprint: 'q1:x',
			durationSec: 0,
			peakSec: 0,
			channels: [new Float32Array(0)],
			rate: SR,
		});
		expect(v).toMatchObject({ coveredSec: 0, peaks: { count: 0 }, spectrogram: { frames: 0 } });
	});

	it('encodes peaks and spectrogram as base64 of their dimensions', () => {
		const ch = samples('hit', 0.5);
		const v = computeVisual({
			soundId: 'snd_0000000000000000',
			fingerprint: 'q1:x',
			durationSec: 0.5,
			peakSec: 0.03,
			channels: ch,
			rate: SR,
		});
		expect(Buffer.from(v.peaks.data, 'base64').length).toBe(v.peaks.count);
		expect(v.peaks.count).toBe(50);
		expect(Buffer.from(v.spectrogram.data, 'base64').length).toBe(v.spectrogram.frames * v.spectrogram.bins);
		expect(v.coveredSec).toBe(0.5);
	});
});

describe('names, tags and credits', () => {
	it('derives titles and tags from paths', () => {
		expect(titleFromFile('Door_Slam-01.wav')).toBe('Door Slam 01');
		expect(titleFromFile('.wav')).toBe('.wav');
		expect(tagsFromPath('Foley/Doors/Door_Slam-01.wav')).toEqual(['foley', 'doors', 'door', 'slam']);
		expect(tagsFromPath('SFX/sound 1.wav')).toEqual([]);
	});

	it('writes a credit line when the licence asks for one, or fills the folder template', () => {
		expect(attributionFor({ title: 'Boom', author: 'A', license: 'CC0-1.0' })).toBeNull();
		expect(
			attributionFor({
				title: 'Boom',
				author: 'Jane',
				license: 'CC-BY-4.0',
				licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
				sourceUrl: 'https://x.invalid/boom',
			}),
		).toBe(
			'"Boom" by Jane (https://x.invalid/boom), licensed under CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)',
		);
		expect(
			attributionFor({
				title: 'Boom',
				author: 'Jane',
				license: 'LicenseRef-UserRoyaltyFree',
				template: '{title} from {folder} ({file}) by {author}, {license} {unknown}',
				file: 'boom.wav',
				folder: 'My SFX',
			}),
		).toBe('Boom from My SFX (boom.wav) by Jane, LicenseRef-UserRoyaltyFree {unknown}');
	});
});

describe('library index store', () => {
	it('persists atomically and reloads the same snapshot', async () => {
		const dir = tempAppdir('jasper-lib-');
		const file = join(dir, 'sounds', 'library.json');
		const changes: unknown[] = [];
		const lib = new SoundLibrary(file, { onChange: (c) => changes.push(c) });
		expect(await lib.neverIndexed()).toBe(true);
		const e = entry('snd_00000000000000aa');
		const s = await lib.commit({
			indexedAt: 'now',
			starterHash: 'h',
			roots: [],
			packs: {},
			sounds: { [e.id]: e },
			files: { 'starter:a.wav': { size: 1, mtimeMs: 2, fingerprint: e.fingerprint } },
		});
		expect(s.snapshotHash).toBe(snapshotHashOf({ [e.id]: e }));
		expect(changes).toEqual([{ snapshotHash: s.snapshotHash, sounds: 1 }]);
		// No temporary files left behind.
		expect(readdirSync(join(dir, 'sounds'))).toEqual(['library.json']);
		const again = new SoundLibrary(file);
		expect(await again.neverIndexed()).toBe(false);
		expect(await again.get(e.id)).toEqual(e);
		expect((await again.snapshot()).snapshotHash).toBe(s.snapshotHash);
	});

	it('moves an unreadable index aside, starts empty and asks for a rebuild', async () => {
		const dir = tempAppdir('jasper-lib-');
		mkdirSync(join(dir, 'sounds'));
		const file = join(dir, 'sounds', 'library.json');
		for (const junk of ['{"format": "jasper-sound-library", "vers', '[]', '{"format":"other","version":1}']) {
			writeFileSync(file, junk);
			const lib = new SoundLibrary(file);
			expect(await lib.entries()).toEqual([]);
			expect(lib.recovered).toBe(true);
			expect(await lib.neverIndexed()).toBe(true);
			expect(existsSync(file)).toBe(false);
		}
		const aside = readdirSync(join(dir, 'sounds')).filter((n) => n.startsWith('library.json.corrupt-'));
		expect(aside.length).toBeGreaterThanOrEqual(1);
	});

	it('drops invalid entries (and asks for a rebuild) but keeps the valid ones', async () => {
		const dir = tempAppdir('jasper-lib-');
		mkdirSync(join(dir, 'sounds'));
		const file = join(dir, 'sounds', 'library.json');
		const good = entry('snd_00000000000000bb');
		writeFileSync(
			file,
			JSON.stringify({
				format: 'jasper-sound-library',
				version: 1,
				sounds: {
					[good.id]: good,
					snd_00000000000000cc: { ...good, id: 'snd_00000000000000cc', descriptors: { durationSec: 'x' } },
					snd_00000000000000dd: entry('snd_00000000000000ee'),
					__proto__: { evil: true },
				},
				files: { a: { size: 1, mtimeMs: 1, fingerprint: 'q1:x' }, b: { size: 'x' } },
			}),
		);
		const lib = new SoundLibrary(file);
		expect((await lib.entries()).map((e) => e.id)).toEqual([good.id]);
		expect(lib.recovered).toBe(true);
		expect(Object.keys((await lib.snapshot()).files)).toEqual(['a']);
		// The file itself is left for the rebuild to replace.
		expect(JSON.parse(readFileSync(file, 'utf8')).format).toBe('jasper-sound-library');
	});

	it('removes sounds and file records by predicate', async () => {
		const dir = tempAppdir('jasper-lib-');
		const lib = new SoundLibrary(join(dir, 'library.json'));
		const a = entry('snd_00000000000000a1', {
			source: { type: 'folder', rootId: 'root_000000000001', relPath: 'a.wav' },
		});
		const b = entry('snd_00000000000000b1');
		await lib.commit({
			indexedAt: null,
			starterHash: '',
			roots: [],
			packs: {},
			sounds: { [a.id]: a, [b.id]: b },
			files: { 'folder:root_000000000001:a.wav': { size: 1, mtimeMs: 1, fingerprint: 'q1:a' } },
		});
		expect(await lib.remove((e) => e.source.type === 'folder', ['folder:root_000000000001:'])).toBe(1);
		expect((await lib.entries()).map((e) => e.id)).toEqual([b.id]);
		expect((await lib.snapshot()).files).toEqual({});
		expect(await lib.remove(() => false, [])).toBe(0);
	});
});

describe('request schemas (hostile input)', () => {
	it('search queries parse or fail cleanly, and round-trip from typed requests', () => {
		fc.assert(
			fc.property(
				fc.dictionary(fc.constantFrom(...Object.keys(SoundSearchQuerySchema.shape), 'x'), fc.string()),
				(q) => {
					expect(() => SoundSearchQuerySchema.safeParse(q)).not.toThrow();
				},
			),
			{ numRuns: 500, seed: 0x5eed },
		);
		const parsed = SoundSearchQuerySchema.parse(
			soundSearchParams({
				q: 'door slam',
				types: ['hit', 'thump'],
				sources: ['starter'],
				limit: 5,
				windowSec: 1.5,
			}),
		);
		expect(parsed).toEqual({
			q: 'door slam',
			types: ['hit', 'thump'],
			sources: ['starter'],
			limit: 5,
			windowSec: 1.5,
		});
		expect(SoundSearchQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
		expect(SoundSearchQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
		expect(SoundSearchQuerySchema.safeParse({ sources: 'starter,web' }).success).toBe(false);
		expect(SoundSearchQuerySchema.safeParse({ usedNearby: 'snd_x' }).success).toBe(false);
	});

	it('folder lists are bounded and typed', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (v) => {
				expect(() => SoundRootsPutRequestSchema.safeParse(v)).not.toThrow();
			}),
			{ numRuns: 300, seed: 0x5eed },
		);
		const many = { roots: Array.from({ length: 33 }, () => ({ path: '/x' })) };
		expect(SoundRootsPutRequestSchema.safeParse(many).success).toBe(false);
		expect(
			SoundRootsPutRequestSchema.safeParse({ roots: [{ path: '/x', license: 'CC-BY-NC-4.0' }] }).success,
		).toBe(false);
	});
});

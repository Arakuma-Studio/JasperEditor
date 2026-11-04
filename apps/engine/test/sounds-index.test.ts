// WP1.2/security review: 20,000 files per folder, 50,000 indexed sounds, synth reservation and stale-scan repair.
// Virtualize filesystem/media I/O, not selection or commit decisions; exercise the real indexer and stores.
import { type Dirent, mkdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SoundRoot } from '@jasper/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../src/jobs/types.ts';
import { fingerprintFile } from '../src/media/fingerprint.ts';
import { SoundAnalyzer } from '../src/sounds/analysis.ts';
import { runAnalysis } from '../src/sounds/analysis-core.ts';
import { decodeSound } from '../src/sounds/decode.ts';
import { SoundIndexer } from '../src/sounds/index-job.ts';
import { SoundLibrary } from '../src/sounds/library.ts';
import { SoundRootStore } from '../src/sounds/roots.ts';
import { loadManifest } from '../src/sounds/starter.ts';
import { ensureSynthFile, synthItems } from '../src/sounds/synth.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { atomicWriteJson, readJsonOrNull } from '../src/tools/fs.ts';
import { SR, samples, writeWav } from './sound-fixtures.ts';
import { tempAppdir } from './temp.ts';

vi.mock('node:fs/promises', async (original) => ({
	...(await original<typeof import('node:fs/promises')>()),
	readdir: vi.fn(),
	stat: vi.fn(),
}));
vi.mock('../src/media/fingerprint.ts', async (original) => ({
	...(await original<typeof import('../src/media/fingerprint.ts')>()),
	fingerprintFile: vi.fn(),
}));
vi.mock('../src/sounds/decode.ts', async (original) => ({
	...(await original<typeof import('../src/sounds/decode.ts')>()),
	decodeSound: vi.fn(),
}));
vi.mock('../src/sounds/starter.ts', async (original) => ({
	...(await original<typeof import('../src/sounds/starter.ts')>()),
	loadManifest: vi.fn(),
}));
vi.mock('../src/sounds/synth.ts', async (original) => ({
	...(await original<typeof import('../src/sounds/synth.ts')>()),
	ensureSynthFile: vi.fn(),
}));
vi.mock('../src/sounds/visual.ts', async (original) => ({
	...(await original<typeof import('../src/sounds/visual.ts')>()),
	writeVisual: vi.fn(),
}));
vi.mock('../src/tools/fs.ts', async (original) => ({
	...(await original<typeof import('../src/tools/fs.ts')>()),
	atomicWriteJson: vi.fn(),
	readJsonOrNull: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

async function fixture(counts: number[], options: { synth?: boolean; anchor?: boolean } = {}) {
	const directory = tempAppdir('jasper-library-index-');
	const representative = writeWav(join(directory, 'sample.wav'), 'hit', 0.1);
	const fileStat = statSync(representative);
	const directoryStat = statSync(directory);
	const roots: SoundRoot[] = counts.map((_, i) => ({
		id: `root_${String(i + 1).padStart(12, '0')}`,
		path: join(directory, `folder-${i}`),
		label: `Folder ${i}`,
		license: 'CC0-1.0',
		enabled: true,
		addedAt: '2026-10-15T00:00:00.000Z',
	}));
	const listings = new Map<string, Dirent[]>();
	const fingerprints = new Map<string, string>();
	let ordinal = 0;
	const identify = (path: string) =>
		fingerprints.set(path, `q1:${(++ordinal).toString(16).padStart(16, '0')}${'0'.repeat(48)}`);
	for (const [i, count] of counts.entries()) {
		const root = roots[i]!;
		mkdirSync(root.path);
		listings.set(
			root.path,
			Array.from({ length: count }, (_, n) => {
				const name = `file_${String(n).padStart(5, '0')}.wav`;
				identify(join(root.path, name));
				return {
					name,
					parentPath: root.path,
					path: root.path,
					isFile: () => true,
					isDirectory: () => false,
					isSymbolicLink: () => false,
					isBlockDevice: () => false,
					isCharacterDevice: () => false,
					isFIFO: () => false,
					isSocket: () => false,
				} satisfies Dirent;
			}),
		);
	}
	const synth = options.synth ? synthItems({ JASPER_SOUND_SYNTH_VARIANTS: '1' }).slice(0, 2) : [];
	const synthPath = (recipe: string, seed: number) => join(directory, 'synth', `${recipe}-${seed}.wav`);
	for (const item of synth) identify(synthPath(item.recipe, item.seed));
	const anchorPath = join(directory, 'anchor.wav');
	if (options.anchor) identify(anchorPath);
	const directories = new Set([
		directory,
		...listings.keys(),
		...['synth', 'packs', 'cache'].map((name) => join(directory, name)),
	]);
	vi.mocked(readdir).mockImplementation(async (path) => (listings.get(String(path)) ?? []) as never);
	const statFor = async (path: unknown) => {
		if (directories.has(String(path))) return directoryStat;
		if (fingerprints.has(String(path))) return fileStat;
		throw Object.assign(new Error('virtual file does not exist'), { code: 'ENOENT' });
	};
	vi.mocked(stat).mockImplementation(async (path) => (await statFor(path)) as never);
	const json = new Map<string, unknown>();
	vi.mocked(atomicWriteJson).mockImplementation(async (path, value) => {
		json.set(path, structuredClone(value));
	});
	vi.mocked(readJsonOrNull).mockImplementation(async <T>(path: string): Promise<T | null> => {
		const value = json.get(path);
		return value === undefined ? null : (structuredClone(value) as T);
	});
	vi.mocked(fingerprintFile).mockImplementation(async (path) => ({
		fingerprint: fingerprints.get(path)!,
		sizeBytes: fileStat.size,
	}));
	vi.mocked(loadManifest).mockResolvedValue({
		status: options.anchor ? 'ok' : 'absent',
		dir: directory,
		packs: [],
		errors: [],
		hash: options.anchor ? 'anchor' : '',
		sounds: options.anchor
			? [
					{
						file: 'anchor.wav',
						title: 'Anchor',
						types: [],
						tags: [],
						author: 'Test',
						license: 'CC0-1.0',
						inferTypes: false,
					},
				]
			: [],
	});
	vi.mocked(ensureSynthFile).mockImplementation(async (_dir, recipe, seed) => synthPath(recipe, seed));
	const channels = samples('hit', 0.1);
	vi.mocked(decodeSound).mockResolvedValue({
		channels,
		rate: SR,
		format: { durationSec: 0.1, sampleRate: SR, channels: 2, container: 'wav' },
	});
	const analysis = runAnalysis({
		kind: 'analyse',
		channels,
		rate: SR,
		soundId: 'snd_0000000000000001',
		fingerprint: `q1:${'1'.repeat(64)}`,
		durationSec: 0.1,
	});
	const analyzer = new SoundAnalyzer(null);
	vi.spyOn(analyzer, 'run').mockImplementation(async (request) => ({
		...analysis,
		visual: { ...analysis.visual, soundId: request.soundId, fingerprint: request.fingerprint },
	}));
	const library = new SoundLibrary(join(directory, 'library.json'));
	const rootStore = new SoundRootStore(join(directory, 'roots.json'));
	await rootStore.save(roots);
	const followUps: string[] = [];
	const indexer = new SoundIndexer({
		library,
		roots: rootStore,
		analyzer,
		ffmpeg: new Ffmpeg({ ffmpeg: null, ffprobe: null }),
		starterDir: () => directory,
		packsDir: join(directory, 'packs'),
		synthDir: join(directory, 'synth'),
		cacheDir: join(directory, 'cache'),
		synthItems: () => synth,
		followUp: (id) => followUps.push(id),
	});
	const context: JobContext = {
		job: { id: 'job_test000001' } as JobContext['job'],
		input: {},
		signal: new AbortController().signal,
		slots: 1,
		progress: () => undefined,
		trackChild: () => undefined,
		addPartial: () => undefined,
		scratchDir: async () => directory,
		log: () => undefined,
	};
	return {
		indexer,
		library,
		rootStore,
		context,
		roots,
		analyzer,
		analysis,
		followUps,
		statFor,
		representative,
		anchorPath,
	};
}

describe('sound index job contracts', () => {
	it('caps each folder and the total index while preserving the synth fallback', {
		timeout: 30_000,
	}, async () => {
		const { indexer, library, context, roots } = await fixture([20_001, 20_000, 10_000], { synth: true });
		const result = await indexer.run(context);
		const entries = await library.entries();
		expect(result.sounds).toBe(50_000);
		expect(entries).toHaveLength(50_000);
		expect(entries.filter((entry) => entry.source.type === 'synth')).toHaveLength(2);
		for (const [i, expected] of [20_000, 20_000, 9_998].entries())
			expect(
				entries.filter((entry) => entry.source.type === 'folder' && entry.source.rootId === roots[i]!.id),
			).toHaveLength(expected);
		expect(result.errors.some((error) => error.code === 'LIBRARY_FULL')).toBe(true);
	});

	it('keeps disabled or relicensed folder data out of stale commits and requests a follow-up', async () => {
		for (const change of ['enabled', 'license'] as const) {
			const setup = await fixture([1], { anchor: true });
			let revision = 0;
			// The file changes while each pass is being analysed, so its next pass is a cache miss too.
			vi.mocked(stat).mockImplementation(async (path) => {
				const value = await setup.statFor(path);
				if (!value.isFile()) return value as never;
				const modified = statSync(setup.representative);
				modified.mtimeMs = ++revision;
				return modified as never;
			});
			vi.mocked(fingerprintFile).mockImplementation(async (path) => ({
				fingerprint: `q1:${path === setup.anchorPath ? '1' : '2'}${revision.toString(16).padStart(15, '0')}${'0'.repeat(48)}`,
				sizeBytes: statSync(setup.representative).size,
			}));
			vi.mocked(setup.analyzer.run).mockImplementation(async (request) => {
				if (request.fingerprint.startsWith('q1:1')) {
					const roots = await setup.rootStore.list();
					await setup.rootStore.save(
						roots.map((root) =>
							change === 'enabled'
								? { ...root, enabled: !root.enabled }
								: { ...root, license: root.license === 'CC0-1.0' ? 'CC-BY-4.0' : 'CC0-1.0' },
						),
					);
				}
				return {
					...setup.analysis,
					visual: { ...setup.analysis.visual, soundId: request.soundId, fingerprint: request.fingerprint },
				};
			});
			const result = await setup.indexer.run({ ...setup.context, signal: new AbortController().signal });
			const snapshot = await setup.library.snapshot();
			expect(Object.values(snapshot.sounds).map((entry) => entry.source.type)).toEqual(['starter']);
			expect(snapshot.roots).toEqual([]);
			expect(Object.keys(snapshot.files).some((key) => key.startsWith('folder:'))).toBe(false);
			expect(result.sounds).toBe(1);
			expect(setup.followUps).toContain(setup.context.job.id);
		}
	});
});

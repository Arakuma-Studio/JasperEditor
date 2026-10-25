// Link Media on the engine (docs/wp-notes/link-media.md): Relink others automatically from a located file, match
// property verification, ambiguity, scale, cancellation, and the routes' validation and refusals.
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
	type EngineJob,
	type RegisteredMedia,
	type RelinkScanRequest,
	RelinkScanRequestSchema,
	type RelinkScanResult,
} from '@jasper/api';
import type { MediaAsset } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	effectiveCriteria,
	failedCriteria,
	type RelinkScanDeps,
	runRelinkScan,
} from '../src/interchange/relink.ts';
import { JobError } from '../src/jobs/types.ts';
import {
	closeApps,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	type TestApp,
	tempAppdir,
	until,
} from './helpers.ts';

const FLICKS = 705_600_000;

/** An offline placeholder as an imported Premiere project has it: a Windows path and (optionally) a relative one. */
function placeholder(
	id: string,
	path: string | null,
	opts: {
		seconds?: number;
		kind?: MediaAsset['kind'];
		rel?: string;
		name?: string;
		fingerprint?: string;
		size?: number;
	} = {},
): MediaAsset {
	const kind = opts.kind ?? 'video';
	const name = opts.name ?? (path ? path.split(/[\\/]/).pop()! : id);
	return {
		id,
		kind,
		fingerprint: opts.fingerprint ?? `pending:interchange:${id}`,
		originalName: name,
		sizeBytes: opts.size ?? 0,
		container: '',
		probe: {
			durationFlicks: kind === 'image' ? null : Math.round((opts.seconds ?? 2) * FLICKS),
			startTimecode: null,
			streams:
				kind === 'audio'
					? [{ index: 0, type: 'audio', codec: '', sampleRate: 48000, channels: 2, channelLayout: 'stereo' }]
					: [
							{
								index: 0,
								type: 'video',
								codec: '',
								width: 1920,
								height: 1080,
								pixelAspect: { num: 1, den: 1 },
								frameRate: { num: 30, den: 1 },
								pixelFormat: '',
								bitDepth: 8,
								color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
								browserDecodable: null,
							},
						],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: path ? [{ type: 'path', path, relativeToProject: opts.rel ?? null }] : [],
		derivation: null,
		importedAt: '2026-10-25T00:00:00.000Z',
	} as MediaAsset;
}

/** A tree of files; `seconds` is what the fake registration reports as each file's duration. */
function tree(root: string, files: Record<string, number>): void {
	for (const [rel, seconds] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(join(p, '..'), { recursive: true });
		writeFileSync(p, `${seconds}`);
	}
}

const AUDIO = /\.(wav|mp3|aif)$/i;
const IMAGE = /\.(png|jpg)$/i;
function fakeDeps(over: Partial<RelinkScanDeps> = {}): RelinkScanDeps & { registered: string[] } {
	const registered: string[] = [];
	return {
		registered,
		register: async (p) => {
			registered.push(p);
			const seconds = Number(readFileSync(p, 'utf8')) || 2;
			const kind = AUDIO.test(p) ? 'audio' : IMAGE.test(p) ? 'image' : 'video';
			const a = placeholder('x', p, { seconds, kind });
			return {
				mediaKey: `mk_${registered.length}`,
				fingerprint: `q1:${p}`,
				originalName: basename(p),
				sizeBytes: statSync(p).size,
				container: 'mov,mp4',
				kind,
				probe: a.probe,
				locators: [
					{ type: 'engine-store', engineId: 'local', key: `mk_${registered.length}` },
					{ type: 'path', path: p, relativeToProject: null },
				],
				browserPlayable: 'yes',
			} as RegisteredMedia;
		},
		fingerprint: async (p) => `q1:${p}`,
		host: 'posix',
		signal: new AbortController().signal,
		progress: () => undefined,
		...over,
	};
}

const scan = (req: RelinkScanRequest, deps = fakeDeps()) =>
	runRelinkScan(RelinkScanRequestSchema.parse(req), deps).then((r) => ({ r, deps }));

describe('Relink others automatically (engine search)', () => {
	it('one located Windows file relinks the others by the folder mapping, relative path, same folder and search', async () => {
		const mac = tempAppdir('jasper-mac-');
		tree(mac, {
			'Videos/Short A/TV static.mp4': 2,
			'Videos/Short A/avatar/Happy.png': 0,
			'Assets/music/Composer/theme.mp3': 3,
			// moved out of its old folder into the located file's folder
			'Videos/Short A/loose.wav': 1,
			// moved deeper under the located file's folder
			'Videos/Short A/deep/er/buried.mov': 2,
			// two files of the same name: never guessed
			'Videos/Short A/a/dup.mov': 2,
			'Videos/Short A/b/dup.mov': 2,
		});
		const assets = [
			placeholder('happy', 'D:\\Videos\\Short A\\avatar\\Happy.png', { kind: 'image' }),
			placeholder('sans', 'D:\\Assets\\music\\Composer\\theme.mp3', { kind: 'audio', seconds: 3 }),
			placeholder('loose', 'E:\\Old SFX\\loose.wav', { kind: 'audio', seconds: 1 }),
			placeholder('buried', 'F:\\elsewhere\\buried.mov'),
			placeholder('dup', 'G:\\x\\dup.mov'),
			placeholder('gone', 'D:\\Videos\\Short A\\never there.mov'),
		];
		const { r } = await scan({
			anchors: [
				{
					from: 'D:\\Videos\\Short A\\TV static.mp4',
					to: join(mac, 'Videos/Short A/TV static.mp4'),
				},
			],
			assets,
			match: ['name', 'duration', 'streams'],
		});
		const by = Object.fromEntries(r.found.map((f) => [f.assetId, [f.step, f.path]]));
		expect(by).toEqual({
			happy: ['mapping', join(mac, 'Videos/Short A/avatar/Happy.png')],
			sans: ['mapping', join(mac, 'Assets/music/Composer/theme.mp3')],
			loose: ['same-folder', join(mac, 'Videos/Short A/loose.wav')],
			buried: ['search', join(mac, 'Videos/Short A/deep/er/buried.mov')],
		});
		expect(r.found.every((f) => f.match === 'placeholder' && f.needsConfirm === false)).toBe(true);
		expect(r.ambiguous).toEqual([
			{
				assetId: 'dup',
				step: 'search',
				candidates: [join(mac, 'Videos/Short A/a/dup.mov'), join(mac, 'Videos/Short A/b/dup.mov')],
			},
		]);
		expect(r.notFound).toEqual(['gone']);
		expect(r.mappings).toEqual([{ from: 'D:\\', to: mac }]);
		// the walk covers the located file's folder only (theme.mp3 was found by the mapping)
		expect(r.scannedFiles).toBe(6);
	});

	it('the project-relative path finds media whose absolute path does not map', async () => {
		const root = tempAppdir('jasper-rel-');
		tree(root, { 'Proj/Footage/a.mov': 2, 'Proj/Audio/b.wav': 1 });
		const { r } = await scan({
			anchors: [
				{
					from: 'C:\\Users\\x\\Proj\\Footage\\a.mov',
					to: join(root, 'Proj/Footage/a.mov'),
					relativePath: 'Footage\\a.mov',
				},
			],
			// the old absolute path was on another machine layout entirely
			assets: [placeholder('b', '\\\\nas\\share\\b.wav', { kind: 'audio', seconds: 1, rel: 'Audio\\b.wav' })],
			match: ['name'],
		});
		expect(r.found.map((f) => [f.assetId, f.step, f.path])).toEqual([
			['b', 'relative', join(root, 'Proj/Audio/b.wav')],
		]);
	});

	it('verifies the match properties: a wrong duration or kind is rejected, File Extension off finds a transcode', async () => {
		const root = tempAppdir('jasper-verify-');
		tree(root, { 'M/a.mov': 2, 'M/short.mov': 0.2, 'M/clip.mp4': 2, 'M/tone.mov': 1 });
		const anchors = [{ from: 'D:\\M\\a.mov', to: join(root, 'M/a.mov') }];
		const assets = [
			placeholder('short', 'D:\\M\\short.mov', { seconds: 5 }),
			placeholder('clip', 'D:\\M\\clip.mov'),
			placeholder('tone', 'D:\\M\\tone.mov', { kind: 'audio', seconds: 1 }),
		];
		const strict = (await scan({ anchors, assets, match: ['name', 'duration', 'streams'] })).r;
		// a placeholder whose only difference is its (guessed) streams is found, but waits for confirmation
		expect(strict.found.map((f) => [f.assetId, f.needsConfirm])).toEqual([['tone', true]]);
		expect(strict.notFound).toEqual(['short', 'clip']);
		const noExt = (await scan({ anchors, assets, match: ['name', 'duration'], ignoreExtension: true })).r;
		// without Streams the video file named like the audio asset is found too, but only with confirmation
		expect(noExt.found.map((f) => [f.assetId, basename(f.path), f.needsConfirm])).toEqual([
			['clip', 'clip.mp4', false],
			['tone', 'tone.mov', true],
		]);
		// without the duration check the short file is found, but linking it needs confirmation (clips need 5 s)
		const loose = (await scan({ anchors, assets: [assets[0]!], match: ['name'] })).r;
		expect(loose.found[0]).toMatchObject({ assetId: 'short', needsConfirm: true });
	});

	it('a moved and renamed real asset is found by its bytes under the searched folder', async () => {
		const root = tempAppdir('jasper-fp-');
		tree(root, { 'new/renamed.mov': 2 });
		const p = join(root, 'new/renamed.mov');
		const { r } = await scan({
			folder: root,
			assets: [placeholder('real', '/gone/original.mov', { fingerprint: `q1:${p}`, size: 1 })],
			match: ['name'],
		});
		expect(r.found.map((f) => [f.assetId, f.step, f.match])).toEqual([
			['real', 'fingerprint', 'fingerprint'],
		]);
	});

	it('scales to thousands of offline media: one registration per linked file, linear time', async () => {
		const root = tempAppdir('jasper-scale-');
		const N = 3000;
		const files: Record<string, number> = { 'Media/anchor.mov': 2 };
		for (let i = 0; i < N; i++) files[`Media/p${i % 40}/clip ${i}.mov`] = 2;
		tree(root, files);
		const assets = Array.from({ length: N }, (_, i) =>
			placeholder(`m${i}`, `D:\\Media\\p${i % 40}\\clip ${i}.mov`),
		);
		// a quarter moved without their folder: found by the bounded search under the located file's folder
		for (let i = 0; i < N; i += 4) assets[i] = placeholder(`m${i}`, `Z:\\lost\\clip ${i}.mov`);
		const progress: (number | null)[] = [];
		const deps = fakeDeps({ progress: (p) => progress.push(p) });
		const t0 = performance.now();
		const { r } = await scan(
			{
				anchors: [{ from: 'D:\\Media\\anchor.mov', to: join(root, 'Media/anchor.mov') }],
				assets,
				match: ['name', 'duration'],
			},
			deps,
		);
		const ms = performance.now() - t0;
		expect(r.found.length).toBe(N);
		expect(r.found.filter((f) => f.step === 'search').length).toBe(N / 4);
		expect(deps.registered.length).toBe(N);
		expect(progress.at(-1)).toBe(1);
		expect(ms).toBeLessThan(60_000);
	}, 120_000);

	it('the folder walk honours its file cap and time budget; cancelling stops the job', async () => {
		const root = tempAppdir('jasper-caps-');
		const files: Record<string, number> = {};
		for (let i = 0; i < 50; i++) files[`d${i}/f${i}.mov`] = 2;
		tree(root, files);
		const assets = [placeholder('x', '/old/nothing.mov')];
		const capped = (await scan({ folder: root, assets, maxFiles: 10 })).r;
		expect(capped.truncated).toBe(true);
		expect(capped.scannedFiles).toBe(10);
		let t = 0;
		const timed = (await scan({ folder: root, assets, timeLimitSec: 1 }, fakeDeps({ now: () => (t += 400) })))
			.r;
		expect(timed.timedOut).toBe(true);
		expect(timed.scannedFiles).toBeLessThan(50);
		const ac = new AbortController();
		ac.abort();
		await expect(scan({ folder: root, assets }, fakeDeps({ signal: ac.signal }))).rejects.toBeInstanceOf(
			JobError,
		);
	});

	it('anchors whose new path is not on this computer are ignored; foreign last known paths are never opened', async () => {
		const deps = fakeDeps();
		const { r } = await scan(
			{ anchors: [{ from: 'D:\\a\\b.mov', to: 'E:\\a\\b.mov' }], assets: [placeholder('p', 'D:\\a\\c.mov')] },
			deps,
		);
		expect(r.notFound).toEqual(['p']);
		expect(r.mappings).toEqual([]);
		expect(deps.registered).toEqual([]);
	});
});

describe('match property checks', () => {
	it('legacy "name" means the whole file name unless the extension is ignored', () => {
		expect(effectiveCriteria(['name'], false)).toEqual(['name', 'extension']);
		expect(effectiveCriteria(['name'], true)).toEqual(['name']);
		expect(effectiveCriteria(['name', 'extension', 'name'], true)).toEqual(['name', 'extension']);
	});

	it('lists each failed property; properties the asset does not record are not compared', async () => {
		const a = placeholder('a', 'D:\\x\\Clip.MOV', { seconds: 4 });
		const deps = fakeDeps();
		const root = tempAppdir('jasper-crit-');
		tree(root, { 'clip.mp4': 1 });
		const reg = await deps.register(join(root, 'clip.mp4'));
		expect(
			failedCriteria(a, reg, 'clip.mp4', ['name', 'extension', 'size', 'duration', 'mediaStart', 'streams']),
		).toEqual(['extension', 'duration']);
		expect(failedCriteria({ ...a, kind: 'audio' }, reg, 'clip.mp4', ['streams'])).toEqual(['streams']);
	});
});

describe('Link Media routes', () => {
	let app: TestApp;
	beforeAll(async () => {
		ensureFixtures();
		app = await makeApp();
	}, 120_000);
	afterAll(closeApps);

	const post = (url: string, payload: object) =>
		app.inject({ method: 'POST', url, headers: JSON_H, payload });

	it('relinking to a path of another computer is refused with a named error', async () => {
		const a = placeholder('med_a', 'D:\\Media\\clip-a.mp4');
		const r = await post('/api/assets/med_a/relink', {
			projectId: 'prj_1',
			path: 'D:\\Media\\clip-a.mp4',
			asset: a,
		});
		expect(r.statusCode).toBe(400);
		expect(r.json()).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
		expect(r.json().message).toMatch(/another computer/);
		const rel = await post('/api/assets/med_a/relink', { projectId: 'prj_1', path: 'clip-a.mp4', asset: a });
		expect(rel.statusCode).toBe(400);
		const bad = await post('/api/assets/med_a/relink', {
			projectId: 'prj_1',
			path: fixture('clip-a.mp4'),
			asset: { id: 'med_a' },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe('VALIDATION_FAILED');
	});

	it('a located file is verified against the selected match properties', async () => {
		const a = placeholder('med_a', 'D:\\Media\\clip-a.mov', { seconds: 600 });
		const r = await post('/api/assets/med_a/relink', {
			projectId: 'prj_1',
			path: fixture('clip-a.mp4'),
			asset: a,
			match: ['name', 'extension', 'duration'],
		});
		expect(r.statusCode, r.body).toBe(200);
		expect(r.json().failed).toEqual(['extension', 'duration']);
		expect(r.json().needsConfirm).toBe(true);
	});

	it('relink-scan validates its body, folders and anchors; the result route checks the job', async () => {
		const a = placeholder('med_a', 'D:\\Media\\clip-a.mp4');
		expect((await post('/api/projects/prj_1/relink-scan', { assets: [] })).statusCode).toBe(400);
		expect(
			(await post('/api/projects/prj_1/relink-scan', { assets: [a], match: ['bogus'] })).statusCode,
		).toBe(400);
		const far = await post('/api/projects/prj_1/relink-scan', {
			assets: [a],
			anchors: [{ from: 'D:\\a.mov', to: 'E:\\a.mov' }],
		});
		expect(far.statusCode).toBe(400);
		expect(far.json().message).toMatch(/another computer/);
		const nofolder = await post('/api/projects/prj_1/relink-scan', {
			assets: [a],
			folder: join(tempAppdir(), 'nope'),
		});
		expect(nofolder.statusCode).toBe(404);
		const missing = await app.inject({
			method: 'GET',
			url: '/api/projects/prj_1/relink-scan/job_nope',
			headers: JSON_H,
		});
		expect(missing.statusCode).toBe(404);
		expect(missing.json().code).toBe('JOB_NOT_FOUND');
	});

	it('locate one Windows-path placeholder, the job relinks the others; the result is per project', async () => {
		const mac = tempAppdir('jasper-mac-route-');
		mkdirSync(join(mac, 'Media', 'B roll'), { recursive: true });
		copyFileSync(fixture('clip-a.mp4'), join(mac, 'Media', 'clip-a.mp4'));
		copyFileSync(fixture('clip-b.mp4'), join(mac, 'Media', 'B roll', 'clip-b.mp4'));
		copyFileSync(fixture('tone.wav'), join(mac, 'Media', 'tone.wav'));
		const assets = [
			placeholder('med_b', 'D:\\Media\\B roll\\clip-b.mp4', { seconds: 0.5 }),
			placeholder('med_t', 'D:\\Media\\tone.wav', { kind: 'audio', seconds: 0.5 }),
		];
		const r = await post('/api/projects/prj_2/relink-scan', {
			anchors: [{ from: 'D:\\Media\\clip-a.mp4', to: join(mac, 'Media', 'clip-a.mp4') }],
			assets,
			match: ['name', 'extension', 'duration', 'streams'],
		});
		expect(r.statusCode, r.body).toBe(202);
		const job = r.json() as EngineJob;
		const end = await until(async () => {
			const j = (
				await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: JSON_H })
			).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled'].includes(j.state) ? j : null;
		}, 60_000);
		expect(end.state, JSON.stringify(end.error)).toBe('succeeded');
		expect(end.result).toEqual({
			found: 2,
			needsConfirm: 0,
			ambiguous: 0,
			notFound: 0,
			scannedFiles: 0,
			truncated: false,
			timedOut: false,
		});
		const other = await app.inject({
			method: 'GET',
			url: `/api/projects/prj_1/relink-scan/${job.id}`,
			headers: JSON_H,
		});
		expect(other.statusCode).toBe(404);
		const full = (
			await app.inject({ method: 'GET', url: `/api/projects/prj_2/relink-scan/${job.id}`, headers: JSON_H })
		).json() as RelinkScanResult;
		expect(full.found.map((f) => [f.assetId, f.step, basename(f.path)])).toEqual([
			['med_b', 'mapping', 'clip-b.mp4'],
			['med_t', 'mapping', 'tone.wav'],
		]);
		expect(full.found[0]!.media.mediaKey).toBeTruthy();
	});
});

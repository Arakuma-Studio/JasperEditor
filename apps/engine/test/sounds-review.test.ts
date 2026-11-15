// Sound library review fixes (spec 12 WP1.2; wp-note "WP1.2 engine library" ▸ "Review fixes"): folder approvals
// against a list that changed meanwhile, approval cards that cannot hide a removal, index jobs that never commit a
// stale scan and never swallow a full rebuild, automatic indexing that respects a cancel, the analysis worker's
// lifecycle, cache pruning, the library cap, credit changes, remote mode. Generated WAVs only, no network.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	AGENT_NAME_HEADER,
	type EngineJob,
	SoundIndexResultSchema,
	type SoundRoot,
	SoundSearchResponseSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { createCounterIdSource, createEmptyProject, makeEnvelope } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { SoundAnalyzer } from '../src/sounds/analysis.ts';
import type { AnalysisJob, AnalysisResult } from '../src/sounds/analysis-core.ts';
import type { SoundService } from '../src/sounds/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, editorCookie, H, JSON_H, makeApp, tempAppdir } from './helpers.ts';
import { makeStarter, SR, samples, writeWav } from './sound-fixtures.ts';

type App = Awaited<ReturnType<typeof makeApp>>;
const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let starter = '';
beforeEach(() => {
	starter = makeStarter(tempAppdir('jasper-starter-'));
	process.env.JASPER_SOUND_STARTER_DIR = starter;
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '0';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
});
afterEach(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const svcOf = (app: FastifyInstance) => app.jasper.services.sounds as SoundService;

function jobMatching(app: FastifyInstance, match: (job: EngineJob) => boolean): Promise<EngineJob> {
	const core = coreServices(app);
	const existing = core.queue.list({}).find(match);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve) => {
		const off = core.broadcaster.subscribe((event) => {
			if (!['job.created', 'job.updated', 'job.finished'].includes(event.type)) return;
			const job = event.payload as EngineJob;
			if (!match(job)) return;
			off();
			resolve(job);
		});
	});
}

async function get<T = unknown>(app: FastifyInstance, url: string, headers: Record<string, string> = H) {
	const r = await app.inject({ method: 'GET', url, headers });
	return { status: r.statusCode, body: r.json() as T };
}

async function startIndex(app: FastifyInstance, body: Record<string, unknown> = {}): Promise<EngineJob> {
	const r = await app.inject({ method: 'POST', url: '/api/sounds/index', headers: JSON_H, payload: body });
	expect(r.statusCode).toBe(202);
	return r.json() as EngineJob;
}

async function index(app: FastifyInstance, body: Record<string, unknown> = {}) {
	const job = await coreServices(app).queue.wait((await startIndex(app, body)).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return SoundIndexResultSchema.parse(job.result);
}

async function search(app: FastifyInstance, qs = '', headers: Record<string, string> = H) {
	const r = await get(app, `/api/sounds${qs ? `?${qs}` : ''}`, headers);
	expect(r.status, JSON.stringify(r.body)).toBe(200);
	return SoundSearchResponseSchema.parse(r.body);
}

async function putRoots(app: FastifyInstance, roots: unknown[], headers: Record<string, string> = JSON_H) {
	return app.inject({ method: 'PUT', url: '/api/sounds/roots', headers, payload: { roots } });
}

/** `n` more starter sounds (to keep a scan busy long enough to act during it). */
function bulkStarter(n: number, seed = 100) {
	const manifestFile = join(starter, 'manifest.json');
	const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
	for (let i = 0; i < n; i++) {
		writeWav(join(starter, 'bulk', `hit_${seed + i}.wav`), 'hit', 0.3, seed + i);
		manifest.sounds.push({
			file: `bulk/hit_${seed + i}.wav`,
			title: `Bulk ${seed + i}`,
			author: 'x',
			license: 'CC0-1.0',
		});
	}
	writeFileSync(manifestFile, JSON.stringify(manifest));
}

const TOKEN = 'tok_sounds_0123456789abcdef';
const KEY = 'key_sounds_0123456789abcdef';
const AGENT = {
	...H,
	authorization: `Bearer ${TOKEN}`,
	[AGENT_NAME_HEADER]: 'sound-agent',
	'content-type': 'application/json',
};
const EDITOR = {
	...H,
	cookie: editorCookie(TOKEN, KEY),
	'content-type': 'application/json',
};

type Card = { approvalId: string; answerKey: string; summary: string; label: string };

/** An editor window with a project open: collects approval cards and answers them. */
async function editorSession(app: App) {
	const doc = createEmptyProject({ ids: createCounterIdSource(5), name: 'Sounds', preset: 'hd-1080p-30' });
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 1, savedAt: '2026-10-15T00:00:00.000Z', platform: 'test' })),
	);
	const ws: WebSocket = await app.injectWS('/agent', { headers: EDITOR });
	const cards: Card[] = [];
	let wake: (() => void) | null = null;
	ws.on('message', (d) => {
		const m = JSON.parse(String(d)) as { type: string; event?: string; payload?: unknown };
		if (m.type === 'event' && m.event === 'agent.approval.requested') {
			cards.push(m.payload as Card);
			wake?.();
		}
	});
	const welcome = once(ws, 'message');
	ws.send(
		JSON.stringify({ type: 'hello', projectId: doc.projectId, sessionId: 'ses_1', leaseId: 'lease_1' }),
	);
	await welcome;
	const card = async (n: number) => {
		while (cards.length < n) await new Promise<void>((r) => (wake = r));
		return cards[n - 1]!;
	};
	const answer = (c: Card, decision: 'approved' | 'denied') =>
		ws.send(
			JSON.stringify({
				type: 'event',
				event: 'agent.approval.resolve',
				payload: { approvalId: c.approvalId, decision, answerKey: c.answerKey },
			}),
		);
	return { card, answer, cards };
}

describe('folder approvals (finding 1, 2, 8)', { timeout: 300_000 }, () => {
	it('an approval granted after the list changed is refused with SOUND_ROOTS_CHANGED; the other change stays', async () => {
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const a = tempAppdir('jasper-sfx-a-');
		const b = tempAppdir('jasper-sfx-b-');
		writeWav(join(a, 'boom.wav'), 'hit', 0.2, 1);
		writeWav(join(b, 'swoosh.wav'), 'whoosh', 0.3, 2);
		const first = await putRoots(app, [{ path: a, label: 'A' }], EDITOR);
		expect(first.statusCode).toBe(200);
		const rootA = (first.json() as { roots: SoundRoot[] }).roots[0]!;
		const editor = await editorSession(app);
		// The agent removes A: the card waits for the user.
		const pending = putRoots(app, [], AGENT);
		const c1 = await editor.card(1);
		// Meanwhile the user adds B in the editor.
		const mine = await putRoots(app, [rootA, { path: b, label: 'B' }], EDITOR);
		expect(mine.statusCode).toBe(200);
		// Approving the agent's stale plan must not drop B (nor remove A without a card of the current list).
		editor.answer(c1, 'approved');
		const r = await pending;
		expect(r.statusCode, r.body).toBe(409);
		expect(r.json()).toMatchObject({ code: 'SOUND_ROOTS_CHANGED' });
		const roots = (await get<{ roots: SoundRoot[] }>(app, '/api/sounds/roots', EDITOR)).body.roots;
		expect(roots.map((x) => x.label)).toEqual(['A', 'B']);
	});

	it('a long added path cannot hide the removed folder in its approval card', async () => {
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const keep = tempAppdir('jasper-sfx-keep-');
		const first = await putRoots(app, [{ path: keep, label: 'Old impacts' }], EDITOR);
		const old = (first.json() as { roots: SoundRoot[] }).roots[0]!;
		// A 3000-character folder path (12 levels of 249 characters).
		let deep = tempAppdir('jasper-sfx-long-');
		for (let i = 0; i < 12; i++) deep = join(deep, String.fromCharCode(97 + i).repeat(249));
		mkdirSync(deep, { recursive: true });
		expect(deep.length).toBeGreaterThan(3000);
		const editor = await editorSession(app);
		const pending = putRoots(app, [{ path: deep }], AGENT);
		const c = await editor.card(1);
		expect(c.summary).toContain(old.label);
		expect(c.summary.length).toBeLessThanOrEqual(600);
		editor.answer(c, 'denied');
		expect((await pending).statusCode).toBe(403);
	});

	it('changing a folder’s credit template or author rescans it; an agent doing it is asked', async () => {
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const folder = tempAppdir('jasper-sfx-credit-');
		writeWav(join(folder, 'door slam.wav'), 'hit', 0.3, 5);
		const added = await putRoots(
			app,
			[
				{
					path: folder,
					label: 'Mine',
					license: 'CC-BY-4.0',
					author: 'Ann',
					attributionTemplate: '{title} by {author}',
				},
			],
			EDITOR,
		);
		const body = added.json() as { roots: SoundRoot[]; job: EngineJob };
		await coreServices(app).queue.wait(body.job.id);
		const credit = async () =>
			(await search(app, 'sources=folder&license=any', EDITOR)).results.map((r) => [
				r.sound.attribution,
				r.sound.author,
			]);
		expect(await credit()).toEqual([['door slam by Ann', 'Ann']]);
		const editor = await editorSession(app);
		// An agent rewriting the credit line is asked; the card names the folder and the change.
		const pending = putRoots(app, [{ ...body.roots[0], attributionTemplate: '{title} (free)' }], AGENT);
		const c = await editor.card(1);
		expect(c.summary).toContain('Mine');
		expect(c.summary).toContain('{title} by {author}');
		expect(c.summary).toContain('{title} (free)');
		editor.answer(c, 'denied');
		expect((await pending).statusCode).toBe(403);
		expect(await credit()).toEqual([['door slam by Ann', 'Ann']]);
		// The editor changing the author: no card, and the sounds are rescanned with the new credit.
		const r = await putRoots(app, [{ ...body.roots[0], author: 'Bea' }], EDITOR);
		const job = (r.json() as { job: EngineJob | null }).job;
		expect(job).not.toBeNull();
		await coreServices(app).queue.wait(job!.id);
		expect(await credit()).toEqual([['door slam by Bea', 'Bea']]);
		expect(editor.cards).toHaveLength(1);
	});
});

describe('joining index jobs', { timeout: 300_000 }, () => {
	it('POST /api/sounds/index {full: true} during an incremental job is not swallowed', async () => {
		const app = await makeApp();
		await index(app);
		bulkStarter(10);
		const q = coreServices(app).queue;
		const job = await startIndex(app);
		await jobMatching(app, (j) => j.id === job.id && j.state === 'running' && (j.progress ?? 0) > 0);
		const joined = await startIndex(app, { full: true });
		expect(joined.id).toBe(job.id);
		const done = await q.wait(job.id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		// The last pass was the full rebuild: every file analysed again, none reused.
		expect(SoundIndexResultSchema.parse(done.result)).toMatchObject({ sounds: 14, analysed: 14, reused: 0 });
		expect(q.list({ kind: 'sound-index' })).toHaveLength(2);
	});
});

describe('automatic indexing (finding 4)', { timeout: 300_000 }, () => {
	it('does not start again after the user cancelled it, until an index is asked for', async () => {
		process.env.JASPER_SOUND_AUTO_INDEX = '1';
		const app = await makeApp();
		const q = coreServices(app).queue;
		const jobs = () => q.list({ kind: 'sound-index' });
		const auto = await jobMatching(app, (j) => j.kind === 'sound-index');
		expect(auto.origin.type).toBe('system');
		await jobMatching(app, (j) => j.id === auto.id && j.state === 'running');
		q.cancel(auto.id);
		expect((await q.wait(auto.id)).state).toBe('cancelled');
		expect((await get<{ needsIndex: boolean }>(app, '/api/sounds/status')).body.needsIndex).toBe(true);
		const automatic = vi.spyOn(svcOf(app), 'autoIndex');
		try {
			await search(app);
			await get(app, '/api/sounds/status');
			await Promise.all(automatic.mock.results.map((result) => result.value));
			expect(jobs()).toHaveLength(1);
		} finally {
			automatic.mockRestore();
		}
		// The user asks: it runs, and automatic indexing is allowed again afterwards.
		const user = await startIndex(app);
		expect(user.origin.type).toBe('user');
		expect((await q.wait(user.id)).state).toBe('succeeded');
		expect(jobs()).toHaveLength(2);
	});

	it('backs off after a failed automatic job and retries when the starter kit changes', async () => {
		const app = await makeApp();
		const svc = svcOf(app);
		const q = coreServices(app).queue;
		// The runner fails (as a broken ffmpeg would).
		q.registerRunner('sound-index', async () => {
			throw Object.assign(new Error('no ffmpeg'), { code: 'BINARY_MISSING' });
		});
		process.env.JASPER_SOUND_AUTO_INDEX = '1';
		const first = (await svc.autoIndex())!;
		expect(first).not.toBeNull();
		expect((await q.wait(first.id)).state).toBe('failed');
		expect(await svc.autoIndex()).toBeNull();
		expect(q.list({ kind: 'sound-index' })).toHaveLength(1);
		// A new starter kit is worth one more try at once.
		bulkStarter(1, 900);
		// Expire the documented manifest cache through its clock rather than clearing private state.
		const refreshAt = Date.now() + 30_000;
		const clock = vi.spyOn(Date, 'now').mockReturnValue(refreshAt);
		try {
			await svc.starter();
		} finally {
			clock.mockRestore();
		}
		const again = await svc.autoIndex();
		expect(again).not.toBeNull();
		expect((await q.wait(again!.id)).state).toBe('failed');
		expect(await svc.autoIndex()).toBeNull();
	});
});

describe('analysis worker lifecycle (finding 5)', () => {
	const job = (soundId: string, kind: 'visual' | 'analyse' = 'visual'): AnalysisJob =>
		({
			kind,
			soundId,
			fingerprint: 'q1:x',
			durationSec: 0.1,
			peakSec: 0.02,
			channels: samples('hit', 0.1),
			rate: SR,
		}) as AnalysisJob;

	async function received(file: string): Promise<void> {
		const watcher = watch(dirname(file));
		const signal = AbortSignal.timeout(10_000);
		try {
			while (!existsSync(file)) await once(watcher, 'change', { signal });
		} finally {
			watcher.close();
		}
	}

	function expectVisual(result: AnalysisResult, soundId: string) {
		expect(result).toMatchObject({ descriptors: null, visual: { soundId, peaks: { count: 10 } } });
		const peaks = Buffer.from(result.visual.peaks.data, 'base64');
		expect(peaks.subarray(0, 2)).toEqual(Buffer.from([0, 0]));
		expect(peaks[2]).toBeGreaterThan(0);
	}

	it('recovers real workers after concurrent cancellation, crashes and timed-out analysis', {
		timeout: 30_000,
	}, async () => {
		const directory = tempAppdir('jasper-analysis-lifecycle-');
		const file = join(directory, 'sound-worker.mjs');
		const { build } = await import('esbuild');
		await build({
			entryPoints: [fileURLToPath(new URL('./fixtures/sound-analysis-worker.ts', import.meta.url))],
			outfile: file,
			bundle: true,
			platform: 'node',
			format: 'esm',
			target: 'node20',
			logLevel: 'silent',
			banner: {
				js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);",
			},
		});
		const analyzer = new SoundAnalyzer(pathToFileURL(file));
		try {
			const visualId = 'snd_0000000000000001';
			const indexId = 'snd_0000000000000002';
			const ctrl = new AbortController();
			const visual = analyzer.run(job(visualId));
			const cancelled = expect(analyzer.run(job(indexId, 'analyse'), ctrl.signal)).rejects.toMatchObject({
				code: 'JOB_CANCELLED',
			});
			await Promise.all([received(join(directory, visualId)), received(join(directory, indexId))]);
			ctrl.abort();
			await cancelled;
			writeFileSync(join(directory, 'release'), '');
			expectVisual(await visual, visualId);

			// A real uncaught error is followed by an exit event. Neither may strand or fail subsequent work.
			await expect(analyzer.run(job('snd_0000000000000003'))).rejects.toMatchObject({
				code: 'ANALYSIS_FAILED',
			});
			expectVisual(await analyzer.run(job(visualId)), visualId);
			await expect(
				analyzer.run(job('snd_0000000000000004'), undefined, { timeoutMs: 100 }),
			).rejects.toMatchObject({ code: 'ANALYSIS_TIMEOUT' });
			expectVisual(await analyzer.run(job(visualId)), visualId);
			expect(existsSync(join(directory, `${indexId}.computed`))).toBe(false);
		} finally {
			await analyzer.close();
		}
	});
});

describe('the sound cache is pruned after a commit (finding 6)', { timeout: 300_000 }, () => {
	it('fingerprint folders of a removed folder, old analysis versions and old synth renders go', async () => {
		const app = await makeApp();
		const paths = appdirPaths(app.appdir);
		const folder = tempAppdir('jasper-sfx-prune-');
		writeWav(join(folder, 'one.wav'), 'hit', 0.2, 41);
		writeWav(join(folder, 'two.wav'), 'whoosh', 0.3, 42);
		const added = await putRoots(app, [{ path: folder }]);
		await coreServices(app).queue.wait((added.json() as { job: EngineJob }).job.id);
		const folderHex = (await search(app, 'sources=folder&license=any')).results.map((r) =>
			r.sound.fingerprint.slice(3),
		);
		expect(folderHex).toHaveLength(2);
		for (const h of folderHex) expect(existsSync(join(paths.soundCacheDir, h))).toBe(true);
		const starterHex = (await search(app, 'sources=starter&license=any')).results[0]!.sound.fingerprint.slice(
			3,
		);
		writeFileSync(join(paths.soundCacheDir, starterHex, 'analysis-v1.json'), '{}');
		mkdirSync(paths.soundSynthDir, { recursive: true });
		writeFileSync(join(paths.soundSynthDir, 'hit-0-v0.wav'), 'old render');
		writeFileSync(join(paths.soundSynthDir, 'notes.txt'), 'not ours');

		expect((await putRoots(app, [])).statusCode).toBe(200);
		await index(app);
		for (const h of folderHex) expect(existsSync(join(paths.soundCacheDir, h))).toBe(false);
		expect(readdirSync(join(paths.soundCacheDir, starterHex)).some((f) => f.startsWith('analysis-v'))).toBe(
			true,
		);
		expect(existsSync(join(paths.soundCacheDir, starterHex, 'analysis-v1.json'))).toBe(false);
		expect(existsSync(join(paths.soundSynthDir, 'hit-0-v0.wav'))).toBe(false);
		expect(existsSync(join(paths.soundSynthDir, 'notes.txt'))).toBe(true);
		// The starter sounds keep their cache: the next scan reuses every analysis.
		expect(await index(app)).toMatchObject({ sounds: 4, analysed: 0, reused: 4 });
	});
});

describe('remote mode and hostile files (finding 9)', { timeout: 300_000 }, () => {
	async function withFolder() {
		const app = await makeApp({ dev: false });
		const folder = tempAppdir('jasper-sfx-remote-');
		writeWav(join(folder, 'door slam.wav'), 'hit', 0.3, 61);
		const added = await putRoots(app, [{ path: folder, license: 'CC0-1.0' }]);
		expect(added.statusCode, added.body).toBe(200);
		await coreServices(app).queue.wait((added.json() as { job: EngineJob }).job.id);
		const sound = (await search(app, 'sources=folder')).results[0]!.sound;
		return { app, folder, sound };
	}

	it('a remote engine lists no folder paths, offers no folder sounds and serves no cached folder visuals', async () => {
		const { app, sound } = await withFolder();
		expect((await get(app, `/api/sounds/${sound.id}/visual`)).status).toBe(200);
		app.jasper.config.host = '192.0.2.10';
		const roots = await get<{ roots: SoundRoot[]; local: boolean }>(app, '/api/sounds/roots');
		expect(roots.body).toEqual({ roots: [], local: false });
		expect((await search(app, 'license=any')).results.map((r) => r.sound.source.type)).not.toContain(
			'folder',
		);
		expect((await search(app, 'sources=folder&license=any')).total).toBe(0);
		const v = await get<{ code: string }>(app, `/api/sounds/${sound.id}/visual`);
		expect(v.status).toBe(403);
		expect(v.body.code).toBe('LOCAL_MODE_ONLY');
		// A rescan leaves folder sounds out (and says why).
		const r = await index(app);
		expect(r.errors.map((e) => e.code)).toContain('LOCAL_MODE_ONLY');
		app.jasper.config.host = '127.0.0.1';
		expect((await search(app, 'sources=folder&license=any')).total).toBe(0);
	});

	it('a FIFO named like a sound is refused, not read', async () => {
		const { app, folder, sound } = await withFolder();
		const file = join(folder, 'door slam.wav');
		rmSync(file);
		try {
			execFileSync('mkfifo', [file]);
		} catch {
			return; // no mkfifo on this system
		}
		const r = await get<{ code: string }>(app, `/api/sounds/${sound.id}/audio`);
		expect(r.status).toBe(403);
		expect(r.body.code).toBe('NOT_A_SOUND');
		rmSync(file);
	});

	it('a missing ffmpeg is a 503 for visual data, not a 422', async () => {
		const app = await makeApp();
		await index(app);
		const sound = (await search(app, 'license=any')).results[0]!.sound;
		rmSync(appdirPaths(app.appdir).soundCacheDir, { recursive: true, force: true });
		const ff = coreServices(app).ffmpeg as unknown as { probeJson: () => Promise<never> };
		ff.probeJson = async () => {
			throw Object.assign(new Error('ffprobe not found'), { code: 'BINARY_MISSING' });
		};
		const v = await get<{ code: string }>(app, `/api/sounds/${sound.id}/visual`);
		expect(v.status).toBe(503);
		expect(v.body.code).toBe('BINARY_MISSING');
	});
});

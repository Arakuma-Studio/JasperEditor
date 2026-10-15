// Sound library review fixes (spec 12 WP1.2; wp-note "WP1.2 engine library" ▸ "Review fixes"): folder approvals
// against a list that changed meanwhile, approval cards that cannot hide a removal, index jobs that never commit a
// stale scan and never swallow a full rebuild, automatic indexing that respects a cancel, the analysis worker's
// lifecycle, cache pruning, the library cap, credit changes, remote mode. Generated WAVs only, no network.
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { JobContext } from '../src/jobs/types.ts';
import { rootsApprovalCard } from '../src/routes/sounds.ts';
import { type AnalysisWorker, SoundAnalyzer, type WorkerRequest } from '../src/sounds/analysis.ts';
import type { AnalysisJob } from '../src/sounds/analysis-core.ts';
import { MAX_PASSES, SoundIndexer, walkRoot } from '../src/sounds/index-job.ts';
import { type LibrarySnapshot, SoundLibrary } from '../src/sounds/library.ts';
import { SoundRootStore, type SoundRootsPlan } from '../src/sounds/roots.ts';
import type { SoundService } from '../src/sounds/service.ts';
import { synthItems } from '../src/sounds/synth.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, JSON_H, makeApp, tempAppdir, until } from './helpers.ts';
import { makeStarter, writeWav } from './sound-fixtures.ts';

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
afterAll(closeApps);

const svcOf = (app: FastifyInstance) => app.jasper.services.sounds as SoundService;

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
	cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}`,
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
	ws.send(JSON.stringify({ type: 'hello', projectId: doc.projectId, sessionId: 'ses_1', leaseId: 'lease_1' }));
	await new Promise((r) => setTimeout(r, 100));
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
		expect(c1.label).toBe('Remove a sound folder');
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

	it('the card counts every kind of change and a long path cannot push a removal off it', async () => {
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
		expect(c.summary).toContain('removes 1');
		expect(c.summary).toContain('adds 1');
		expect(c.summary).toContain('remove "Old impacts"');
		expect(c.summary).toContain(old.label);
		expect(c.summary.length).toBeLessThanOrEqual(600);
		expect(c.label).toBe('Sound folders: remove, add');
		editor.answer(c, 'denied');
		expect((await pending).statusCode).toBe(403);
	});

	it('cards: labels name every kind, every item is cut, counts always shown (unit)', () => {
		const root = (id: string, path: string, label: string): SoundRoot => ({
			id,
			path,
			label,
			license: 'CC-BY-4.0',
			enabled: true,
			addedAt: '2026-10-15T00:00:00.000Z',
		});
		const plan = (p: Partial<SoundRootsPlan>): SoundRootsPlan => ({
			next: [],
			added: [],
			removed: [],
			relicensed: [],
			recredited: [],
			revision: 0,
			...p,
		});
		expect(rootsApprovalCard(plan({}))).toBeNull();
		const long = `/x/${'p'.repeat(3000)}`;
		const card = rootsApprovalCard(
			plan({
				added: [root('root_000000000001', long, 'p')],
				removed: [root('root_000000000002', '/sfx/old', 'Old')],
				relicensed: [root('root_000000000003', '/sfx/b', 'B')],
				recredited: [{ root: root('root_000000000004', '/sfx/c', 'C'), changes: ['author "x" → "y"'] }],
			}),
		)!;
		expect(card.label).toBe('Sound folders: remove, relicense, change credits, add');
		expect(card.summary).toMatch(/^This adds 1, removes 1, relicenses 1 and changes the credit line of 1/);
		expect(card.summary.length).toBeLessThan(800);
		expect(card.summary.slice(0, 600)).toContain('remove "Old" (/sfx/old)');
		expect(card.summary.slice(0, 600)).toContain('author "x" → "y"');
	});

	it('changing a folder’s credit template or author rescans it; an agent doing it is asked', async () => {
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const folder = tempAppdir('jasper-sfx-credit-');
		writeWav(join(folder, 'door slam.wav'), 'hit', 0.3, 5);
		const added = await putRoots(
			app,
			[{ path: folder, label: 'Mine', license: 'CC-BY-4.0', author: 'Ann', attributionTemplate: '{title} by {author}' }],
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
		expect(c.label).toBe('Change a sound folder’s credit line');
		expect(c.summary).toContain('"Mine"');
		expect(c.summary).toContain('credit template "{title} by {author}" → "{title} (free)"');
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

/** A job context for driving the indexer directly. */
function fakeCtx(id = 'job_test0001'): JobContext {
	return {
		job: { id } as JobContext['job'],
		input: {},
		signal: new AbortController().signal,
		slots: 1,
		progress: () => undefined,
		trackChild: () => undefined,
		addPartial: () => undefined,
		scratchDir: async () => tempAppdir('jasper-scratch-'),
		log: () => undefined,
	};
}

const entryOf = (id: string, source: Record<string, unknown>) =>
	({
		id,
		fingerprint: `q1:${id.slice(4).padEnd(64, '0')}`,
		title: id,
		types: ['hit'],
		tags: [],
		source,
		license: 'CC0-1.0',
		author: 'x',
		attribution: null,
	}) as unknown as LibrarySnapshot['sounds'][string];

describe('index jobs never commit a stale scan (finding 3)', { timeout: 300_000 }, () => {
	async function setup() {
		const dir = tempAppdir('jasper-idx-');
		const roots = new SoundRootStore(join(dir, 'roots.json'));
		const library = new SoundLibrary(join(dir, 'library.json'));
		const rootDir = tempAppdir('jasper-idx-root-');
		const plan = await roots.plan({ roots: [{ path: rootDir, label: 'A' }] }, '2026-10-15T00:00:00.000Z');
		await roots.save(plan.next);
		return { dir, roots, library, root: plan.next[0]! };
	}

	/** An indexer whose scan is scripted: `during(pass)` runs in the middle of each scan. */
	function scripted(
		deps: { roots: SoundRootStore; library: SoundLibrary },
		during: (pass: number, full: boolean) => Promise<void>,
		followUps: [string, boolean][],
	) {
		const ix = new SoundIndexer({
			library: deps.library,
			roots: deps.roots,
			ffmpeg: null as never,
			analyzer: null as never,
			starterDir: () => '/nonexistent',
			packsDir: '/nonexistent',
			synthDir: '/nonexistent',
			cacheDir: '/nonexistent',
			synthItems: () => [],
			followUp: (jobId, full) => followUps.push([jobId, full]),
		});
		let pass = 0;
		const fulls: boolean[] = [];
		ix.scan = async (_ctx, full) => {
			pass++;
			fulls.push(full);
			const roots = (await deps.roots.list()).filter((r) => r.enabled);
			await during(pass, full);
			const sounds: LibrarySnapshot['sounds'] = { snd_0000000000000001: entryOf('snd_0000000000000001', { type: 'starter', file: 'a.wav' }) };
			const files: LibrarySnapshot['files'] = {};
			for (const r of roots) {
				const id = `snd_${r.id.slice(5).padStart(16, '0')}`;
				sounds[id] = entryOf(id, { type: 'folder', rootId: r.id, relPath: 'x.wav' });
				files[`folder:${r.id}:x.wav`] = { size: 1, mtimeMs: 1, fingerprint: sounds[id]!.fingerprint };
			}
			return {
				next: { indexedAt: 'now', starterHash: '', roots, packs: {}, sounds, files },
				result: { snapshotHash: '', sounds: 0, files: 0, analysed: 0, reused: 0, added: 0, removed: 0, errors: [] },
				before: new Set<string>(),
			};
		};
		return { ix, fulls, passes: () => pass };
	}

	it('when the folders keep changing, it commits only folders enabled now and queues a follow-up', async () => {
		const s = await setup();
		const followUps: [string, boolean][] = [];
		const { ix, passes } = scripted(
			s,
			async (pass) => {
				// Every scan, the folder list changes: A is disabled, then enabled, then disabled again.
				const cur = await s.roots.list();
				await s.roots.save(cur.map((r) => ({ ...r, enabled: pass % 2 === 0 })));
			},
			followUps,
		);
		const result = await ix.run(fakeCtx('job_stale0001'));
		expect(passes()).toBe(MAX_PASSES);
		const snap = await s.library.snapshot();
		// The last scan saw A enabled, but A is disabled now: its sound and file record are not committed.
		expect((await s.roots.list())[0]!.enabled).toBe(false);
		expect(Object.values(snap.sounds).map((e) => e.source.type)).toEqual(['starter']);
		expect(Object.keys(snap.files)).toEqual([]);
		expect(snap.roots).toEqual([]);
		expect(result.sounds).toBe(1);
		expect(followUps).toEqual([['job_stale0001', false]]);
	});

	it('a folder relicensed during the last scan is left out until the follow-up rescans it', async () => {
		const s = await setup();
		const followUps: [string, boolean][] = [];
		const { ix } = scripted(
			s,
			async () => {
				const cur = await s.roots.list();
				const next = cur[0]!.license === 'CC0-1.0' ? 'CC-BY-4.0' : 'CC0-1.0';
				await s.roots.save(cur.map((r) => ({ ...r, license: next })));
			},
			followUps,
		);
		await ix.run(fakeCtx());
		expect(Object.values((await s.library.snapshot()).sounds).map((e) => e.source.type)).toEqual(['starter']);
		expect(followUps).toHaveLength(1);
	});

	it('a request joined during a scan (full) makes one more, full pass; nothing is queued after', async () => {
		const s = await setup();
		const followUps: [string, boolean][] = [];
		const { ix, fulls } = scripted(
			s,
			async (pass) => {
				if (pass === 1) ix.requestPass(true);
			},
			followUps,
		);
		await ix.run(fakeCtx());
		expect(fulls).toEqual([false, true]);
		expect(followUps).toEqual([]);
		expect(Object.keys((await s.library.snapshot()).sounds)).toHaveLength(2);
	});

	it('POST /api/sounds/index {full: true} during an incremental job is not swallowed', async () => {
		const app = await makeApp();
		await index(app);
		bulkStarter(10);
		const q = coreServices(app).queue;
		const job = await startIndex(app);
		await until(() => q.get(job.id)?.state === 'running' && (q.get(job.id)?.progress ?? 0) > 0, 120_000, 10);
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
		bulkStarter(10);
		process.env.JASPER_SOUND_AUTO_INDEX = '1';
		const app = await makeApp();
		const q = coreServices(app).queue;
		const jobs = () => q.list({ kind: 'sound-index' });
		const auto = await until(() => jobs()[0], 60_000);
		expect(auto.origin.type).toBe('system');
		await until(() => q.get(auto.id)?.state === 'running', 60_000, 10);
		q.cancel(auto.id);
		expect((await q.wait(auto.id)).state).toBe('cancelled');
		expect((await get<{ needsIndex: boolean }>(app, '/api/sounds/status')).body.needsIndex).toBe(true);
		await search(app);
		await get(app, '/api/sounds/status');
		await new Promise((r) => setTimeout(r, 200));
		expect(jobs()).toHaveLength(1);
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
		(svc as unknown as { starterCache: null }).starterCache = null; // the manifest is re-read at most every 5 s
		const again = await svc.autoIndex();
		expect(again).not.toBeNull();
		expect((await q.wait(again!.id)).state).toBe('failed');
		expect(await svc.autoIndex()).toBeNull();
	});
});

/** A scripted worker thread. */
class FakeWorker extends EventEmitter implements AnalysisWorker {
	posted: WorkerRequest[] = [];
	terminated = false;
	constructor() {
		super();
		setImmediate(() => this.emit('message', { id: 0, ready: true }));
	}
	postMessage(m: WorkerRequest): void {
		this.posted.push(m);
	}
	terminate(): void {
		this.terminated = true;
	}
	reply(id: number, soundId = 'snd_x') {
		this.emit('message', {
			id,
			ok: true,
			result: { descriptors: null, visual: { soundId } as never },
		});
	}
}

describe('analysis worker lifecycle (finding 5)', () => {
	const job = (soundId: string, kind: 'visual' | 'analyse' = 'visual'): AnalysisJob =>
		({
			kind,
			soundId,
			fingerprint: 'q1:x',
			durationSec: 1,
			peakSec: 0.1,
			channels: [new Float32Array(4)],
			rate: 48_000,
		}) as AnalysisJob;

	function analyzer() {
		const workers: FakeWorker[] = [];
		const a = new SoundAnalyzer(new URL('file:///fake/worker.mjs'), () => undefined, {
			createWorker: () => {
				const w = new FakeWorker();
				workers.push(w);
				return w;
			},
		});
		return { a, workers };
	}

	it('cancelling an index analysis does not fail a visual request on the same worker', async () => {
		const { a, workers } = analyzer();
		const ctrl = new AbortController();
		const visual = a.run(job('snd_visual'));
		const indexing = a.run(job('snd_index', 'analyse'), ctrl.signal);
		await until(() => workers[0]?.posted.length === 2);
		ctrl.abort();
		await expect(indexing).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		expect(workers[0]!.terminated).toBe(true);
		// The visual request moved to a new worker; it completes there.
		await until(() => workers[1]?.posted.length === 1);
		expect(workers[1]!.posted[0]!.job.soundId).toBe('snd_visual');
		workers[1]!.reply(workers[1]!.posted[0]!.id, 'snd_visual');
		expect((await visual).visual.soundId).toBe('snd_visual');
		await a.close();
	});

	it('events of a worker that is no longer current never fail the new worker’s requests', async () => {
		const { a, workers } = analyzer();
		const ctrl = new AbortController();
		const first = a.run(job('snd_1', 'analyse'), ctrl.signal);
		await until(() => workers[0]?.posted.length === 1);
		ctrl.abort();
		await expect(first).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		const second = a.run(job('snd_2'));
		await until(() => workers[1]?.posted.length === 1);
		// The old worker's exit (and a late error) arrive now.
		workers[0]!.emit('error', new Error('late'));
		workers[0]!.emit('exit', 1);
		workers[1]!.reply(workers[1]!.posted[0]!.id, 'snd_2');
		expect((await second).visual.soundId).toBe('snd_2');
		// A worker that dies by itself fails only its own requests.
		const third = a.run(job('snd_3'));
		await until(() => workers[1]!.posted.length === 2);
		workers[1]!.emit('exit', 1);
		await expect(third).rejects.toMatchObject({ code: 'ANALYSIS_FAILED' });
		await a.close();
	});

	it('a visual analysis that hangs times out and frees the worker for the next one', async () => {
		const { a, workers } = analyzer();
		const hung = a.run(job('snd_hung'), undefined, { timeoutMs: 50 });
		await expect(hung).rejects.toMatchObject({ code: 'ANALYSIS_TIMEOUT' });
		expect(workers[0]!.terminated).toBe(true);
		const next = a.run(job('snd_next'), undefined, { timeoutMs: 5000 });
		await until(() => workers[1]?.posted.length === 1);
		workers[1]!.reply(workers[1]!.posted[0]!.id, 'snd_next');
		expect((await next).visual.soundId).toBe('snd_next');
		await a.close();
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
		const starterHex = (await search(app, 'sources=starter&license=any')).results[0]!.sound.fingerprint.slice(3);
		writeFileSync(join(paths.soundCacheDir, starterHex, 'analysis-v1.json'), '{}');
		mkdirSync(paths.soundSynthDir, { recursive: true });
		writeFileSync(join(paths.soundSynthDir, 'hit-0-v0.wav'), 'old render');
		writeFileSync(join(paths.soundSynthDir, 'notes.txt'), 'not ours');

		expect((await putRoots(app, [])).statusCode).toBe(200);
		await index(app);
		for (const h of folderHex) expect(existsSync(join(paths.soundCacheDir, h))).toBe(false);
		expect(readdirSync(join(paths.soundCacheDir, starterHex)).some((f) => f.startsWith('analysis-v'))).toBe(true);
		expect(existsSync(join(paths.soundCacheDir, starterHex, 'analysis-v1.json'))).toBe(false);
		expect(existsSync(join(paths.soundSynthDir, 'hit-0-v0.wav'))).toBe(false);
		expect(existsSync(join(paths.soundSynthDir, 'notes.txt'))).toBe(true);
		// The starter sounds keep their cache: the next scan reuses every analysis.
		expect(await index(app)).toMatchObject({ sounds: 4, analysed: 0, reused: 4 });
	});
});

describe('the library cap (finding 7)', { timeout: 300_000 }, () => {
	it('walks a folder only up to the room left', async () => {
		const folder = tempAppdir('jasper-sfx-cap-');
		for (let i = 0; i < 5; i++) writeWav(join(folder, `hit_${i}.wav`), 'hit', 0.05, i + 1);
		let full = 0;
		const errors: string[] = [];
		const items = await walkRoot(
			{ id: 'root_000000000001', path: folder, label: 'F', license: 'CC0-1.0', enabled: true, addedAt: '' },
			new AbortController().signal,
			(_f, m) => errors.push(m),
			{ maxFiles: 2, onLibraryFull: () => full++ },
		);
		expect(items.map((i) => i.key)).toEqual(['folder:root_000000000001:hit_0.wav', 'folder:root_000000000001:hit_1.wav']);
		expect(full).toBe(1);
		expect(errors).toEqual([]);
	});

	it('keeps room for Jasper Synth and stops listing at the cap', async () => {
		process.env.JASPER_SOUND_SYNTH_VARIANTS = '1';
		const app = await makeApp();
		const svc = svcOf(app);
		const core = coreServices(app);
		const folder = tempAppdir('jasper-sfx-cap-');
		for (let i = 0; i < 3; i++) writeWav(join(folder, `hit_${i}.wav`), 'hit', 0.05, i + 1);
		const added = await putRoots(app, [{ path: folder }]);
		await core.queue.cancel((added.json() as { job: EngineJob }).job.id);
		await core.queue.wait((added.json() as { job: EngineJob }).job.id);
		const synth = synthItems({ JASPER_SOUND_SYNTH_VARIANTS: '1' }).slice(0, 2);
		const ix = new SoundIndexer({
			library: svc.library,
			roots: svc.roots,
			ffmpeg: core.ffmpeg,
			analyzer: svc.analyzer,
			starterDir: () => starter,
			packsDir: core.config.paths.soundPacksDir,
			synthDir: core.config.paths.soundSynthDir,
			cacheDir: core.config.paths.soundCacheDir,
			synthItems: () => synth,
			maxSounds: 5,
		});
		const { next, result } = await ix.scan(fakeCtx(), false);
		const types = Object.values(next.sounds).map((e) => e.source.type);
		// 4 starter sounds, 3 folder sounds, 2 synth sounds; room for 5: 3 starter + both synth, no folder.
		expect(types.filter((t) => t === 'synth')).toHaveLength(2);
		expect(types.filter((t) => t === 'starter')).toHaveLength(3);
		expect(types.filter((t) => t === 'folder')).toHaveLength(0);
		expect(result.errors.filter((e) => e.code === 'LIBRARY_FULL').length).toBeGreaterThanOrEqual(1);
		expect(Object.keys(next.sounds)).toHaveLength(5);
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
		expect((await search(app, 'license=any')).results.map((r) => r.sound.source.type)).not.toContain('folder');
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

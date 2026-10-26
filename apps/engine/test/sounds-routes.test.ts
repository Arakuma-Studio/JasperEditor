// Sound library routes end to end (spec 12 WP1.2): indexing (starter kit, folders, synth), incremental rescans,
// search ranking, facets and filters, audio and visual routes, registering into a project, folder validation and the
// approval gate for agents, cancellation and recovery of a damaged index. Generated WAVs only, no network.

import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	AGENT_NAME_HEADER,
	type EngineJob,
	RegisterSoundResponseSchema,
	SOUND_ANALYSIS_SECONDS,
	type SoundEntry,
	SoundEntrySchema,
	SoundIndexResultSchema,
	SoundLibraryStatusSchema,
	type SoundRoot,
	SoundSearchResponseSchema,
	SoundVisualSchema,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	createCounterIdSource,
	createEmptyProject,
	LIBRARY_LEAD_SILENCE_SEC,
	LibraryProvenanceSchema,
	libraryTrailSilenceSamples,
	makeEnvelope,
} from '@jasper/project';
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, JSON_H, makeApp, TEST_FFMPEG, tempAppdir, until } from './helpers.ts';
import { makeStarter, SR, samples, writeWav } from './sound-fixtures.ts';

/** Interleaved f32 samples of a file's first audio stream (the engine tests' ffmpeg). */
function decodeF32(file: string): Float32Array {
	const out = execFileSync(TEST_FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-']);
	return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

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

async function get<T = unknown>(app: FastifyInstance, url: string, headers: Record<string, string> = H) {
	const r = await app.inject({ method: 'GET', url, headers });
	return {
		status: r.statusCode,
		body: (String(r.headers['content-type'] ?? '').includes('json') ? r.json() : r.body) as T,
		r,
	};
}

async function waitJob(app: FastifyInstance, id: string): Promise<EngineJob> {
	return coreServices(app).queue.wait(id);
}

/** Starts an index job and waits for it; returns the job's result. */
async function index(app: FastifyInstance, body: Record<string, unknown> = {}) {
	const r = await app.inject({ method: 'POST', url: '/api/sounds/index', headers: JSON_H, payload: body });
	expect(r.statusCode).toBe(202);
	const job = await waitJob(app, (r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return SoundIndexResultSchema.parse(job.result);
}

async function search(app: FastifyInstance, qs = '') {
	const r = await get(app, `/api/sounds${qs ? `?${qs}` : ''}`);
	expect(r.status, JSON.stringify(r.body)).toBe(200);
	return SoundSearchResponseSchema.parse(r.body);
}

const byTitle = async (app: FastifyInstance, title: string): Promise<SoundEntry> => {
	const s = await search(app, 'license=any&limit=500');
	const hit = s.results.find((x) => x.sound.title === title);
	if (!hit) throw new Error(`no sound titled ${title}`);
	return hit.sound;
};

async function putRoots(app: FastifyInstance, roots: unknown[], headers: Record<string, string> = JSON_H) {
	return app.inject({ method: 'PUT', url: '/api/sounds/roots', headers, payload: { roots } });
}

describe('indexing the starter kit', { timeout: 300_000 }, () => {
	it('indexes, persists and describes every valid manifest sound', async () => {
		const app = await makeApp();
		const before = await get(app, '/api/sounds/status');
		expect(SoundLibraryStatusSchema.parse(before.body)).toMatchObject({
			sounds: 0,
			needsIndex: true,
			starter: { status: 'ok', sounds: 4 },
			synth: true,
			local: true,
		});
		const result = await index(app);
		expect(result).toMatchObject({ sounds: 4, files: 4, analysed: 4, reused: 0, added: 4, removed: 0 });
		expect(result.errors.map((e) => e.code)).toEqual([
			'MANIFEST_INVALID',
			'MANIFEST_INVALID',
			'MANIFEST_INVALID',
		]);
		const status = SoundLibraryStatusSchema.parse((await get(app, '/api/sounds/status')).body);
		expect(status).toMatchObject({ sounds: 4, needsIndex: false, bySource: { starter: 4 }, indexing: null });
		expect(status.snapshotHash).toBe(result.snapshotHash);

		const heavy = await byTitle(app, 'Heavy hit');
		expect(SoundEntrySchema.parse(heavy)).toEqual(heavy);
		expect(heavy).toMatchObject({
			types: ['hit'],
			source: { type: 'starter', file: 'impacts/hit_heavy.wav', packId: 'test-impacts' },
			license: 'CC0-1.0',
			licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
			attribution: null,
			format: { sampleRate: 48000, channels: 2, container: 'wav' },
			judge: { type: 'hit' },
		});
		expect(heavy.id).toMatch(/^snd_[0-9a-f]{16}$/);
		expect(heavy.format.durationSec).toBeCloseTo(0.6, 2);
		// The hit starts after 20 ms of silence: its peak is right after, the quiet head before.
		expect(heavy.descriptors.peakSec).toBeGreaterThan(0.015);
		expect(heavy.descriptors.peakSec).toBeLessThan(0.04);
		expect(heavy.descriptors.headQuietSec).toBeGreaterThan(0.015);
		// Types inferred from the file name when the manifest gives none; CC-BY gets a credit line.
		expect((await byTitle(app, 'Soft click')).types).toEqual(['click', 'ui']);
		const credit = (await byTitle(app, 'Fast whoosh')).attribution;
		expect(credit).toContain('Jane Doe');
		expect(credit).toContain('CC-BY-4.0');
		const lib = JSON.parse(readFileSync(appdirPaths(app.appdir).soundLibraryIndex, 'utf8'));
		expect(lib).toMatchObject({
			format: 'jasper-sound-library',
			version: 1,
			snapshotHash: result.snapshotHash,
		});
		expect(Object.keys(lib.sounds)).toHaveLength(4);

		const caps = await get<{ features: { sound: unknown } }>(app, '/api/capabilities');
		// P6-E14: Describe-it search is reported too (the optional model is not installed here)
		expect(caps.body.features.sound).toEqual({
			library: { sounds: 4, packs: 0 },
			synth: true,
			describe: { status: 'not-installed' },
		});
	});

	it('rescans incrementally: unchanged files reuse their analysis, a changed one is analysed again', async () => {
		const app = await makeApp();
		await index(app);
		const second = await index(app);
		expect(second).toMatchObject({ sounds: 4, analysed: 0, reused: 4, added: 0, removed: 0 });
		const old = await byTitle(app, 'Light hit');
		writeWav(join(starter, 'impacts', 'hit_light.wav'), 'hit', 0.45, 9);
		const third = await index(app);
		expect(third).toMatchObject({ sounds: 4, analysed: 1, reused: 3, added: 1, removed: 1 });
		const now = await byTitle(app, 'Light hit');
		expect(now.id).not.toBe(old.id);
		expect(now.format.durationSec).toBeCloseTo(0.45, 2);
		// Same size and time as indexed: the file is not even read (fingerprint kept).
		const full = await index(app, { full: true });
		expect(full).toMatchObject({ analysed: 4, reused: 0 });
	});

	it('recovers a damaged index by rebuilding it', async () => {
		const appdir = tempAppdir();
		const first = await makeApp({ appdir });
		const built = await index(first);
		await closeApps();
		const file = appdirPaths(appdir).soundLibraryIndex;
		writeFileSync(file, readFileSync(file, 'utf8').slice(0, 200));
		process.env.JASPER_SOUND_AUTO_INDEX = '1';
		const app = await makeApp({ appdir });
		const status = SoundLibraryStatusSchema.parse((await get(app, '/api/sounds/status')).body);
		expect(status).toMatchObject({ recovered: true, needsIndex: true });
		expect(readdirSync(join(appdir, 'sounds')).some((n) => n.startsWith('library.json.corrupt-'))).toBe(true);
		const job = status.indexing ?? coreServices(app).queue.list({ kind: 'sound-index' })[0];
		expect(job).toBeTruthy();
		expect((await waitJob(app, job!.id)).state).toBe('succeeded');
		const after = SoundLibraryStatusSchema.parse((await get(app, '/api/sounds/status')).body);
		expect(after).toMatchObject({ sounds: 4, recovered: false, needsIndex: false });
		expect(after.snapshotHash).toBe(built.snapshotHash);
	});

	it('cancelling a scan commits nothing', async () => {
		for (let i = 0; i < 12; i++) writeWav(join(starter, 'bulk', `hit_${i}.wav`), 'hit', 0.3, 100 + i);
		const manifest = JSON.parse(readFileSync(join(starter, 'manifest.json'), 'utf8'));
		for (let i = 0; i < 12; i++)
			manifest.sounds.push({
				file: `bulk/hit_${i}.wav`,
				title: `Bulk ${i}`,
				author: 'x',
				license: 'CC0-1.0',
			});
		writeFileSync(join(starter, 'manifest.json'), JSON.stringify(manifest));
		const app = await makeApp();
		const r = await app.inject({ method: 'POST', url: '/api/sounds/index', headers: JSON_H, payload: {} });
		const job = r.json() as EngineJob;
		const q = coreServices(app).queue;
		await until(() => q.get(job.id)?.state === 'running' && (q.get(job.id)?.progress ?? 0) > 0, 60_000, 10);
		const c = await app.inject({
			method: 'POST',
			url: `/api/jobs/${job.id}/cancel`,
			headers: JSON_H,
			payload: {},
		});
		expect(c.statusCode).toBe(200);
		expect((await waitJob(app, job.id)).state).toBe('cancelled');
		expect(existsSync(appdirPaths(app.appdir).soundLibraryIndex)).toBe(false);
		expect(SoundLibraryStatusSchema.parse((await get(app, '/api/sounds/status')).body).sounds).toBe(0);
		// What it analysed before the cancel is cached: the next scan does not decode those files again.
		const next = await index(app);
		expect(next.sounds).toBe(16);
		expect(next.reused).toBeGreaterThan(0);
	});
});

describe('user folders', { timeout: 300_000 }, () => {
	function makeFolder(): string {
		const dir = tempAppdir('jasper-sfx-folder-');
		writeWav(join(dir, 'Impacts', 'Door_Slam-01.wav'), 'hit', 0.5, 11);
		writeWav(join(dir, 'Movement', 'swoosh fast.wav'), 'whoosh', 0.7, 12);
		writeWav(join(dir, 'UI', 'button-click.wav'), 'click', 0.06, 13);
		writeWav(join(dir, '.hidden', 'hit.wav'), 'hit', 0.2, 14);
		writeFileSync(join(dir, 'notes.txt'), 'not audio');
		symlinkSync(join(dir, 'Impacts', 'Door_Slam-01.wav'), join(dir, 'link.wav'));
		return dir;
	}

	it('indexes a folder in place with synonyms, its licence declaration and its credit template', async () => {
		const app = await makeApp();
		const folder = makeFolder();
		const r = await putRoots(app, [
			{ path: folder, label: 'My SFX', author: 'Me', attributionTemplate: '{title} ({folder})' },
		]);
		expect(r.statusCode, r.body).toBe(200);
		const body = r.json() as { roots: SoundRoot[]; job: EngineJob | null };
		expect(body.roots[0]).toMatchObject({
			label: 'My SFX',
			license: 'LicenseRef-UserProvided',
			enabled: true,
		});
		expect(body.job).not.toBeNull();
		expect((await waitJob(app, body.job!.id)).state).toBe('succeeded');

		// Undeclared user files are not commercial-safe: hidden by the default filter.
		const safe = await search(app, 'sources=folder');
		expect(safe.total).toBe(0);
		const any = await search(app, 'sources=folder&license=any');
		expect(any.results.map((x) => x.sound.source)).toEqual(
			expect.arrayContaining([
				{ type: 'folder', rootId: body.roots[0]!.id, relPath: 'Impacts/Door_Slam-01.wav' },
				{ type: 'folder', rootId: body.roots[0]!.id, relPath: 'Movement/swoosh fast.wav' },
				{ type: 'folder', rootId: body.roots[0]!.id, relPath: 'UI/button-click.wav' },
			]),
		);
		expect(any.total).toBe(3); // hidden folders, other files and symlinks are skipped
		const slam = any.results.find((x) => x.sound.title === 'Door Slam 01')!.sound;
		expect(slam).toMatchObject({
			types: ['hit'],
			license: 'LicenseRef-UserProvided',
			author: 'Me',
			attribution: 'Door Slam 01 (My SFX)',
		});
		expect(slam.tags).toEqual(expect.arrayContaining(['impacts', 'door', 'slam']));
		// `swoosh` is a synonym of whoosh: type inferred, and found by a synonym query.
		expect(any.results.find((x) => x.sound.title === 'swoosh fast')!.sound.types).toEqual(['whoosh']);
		const q = await search(app, 'q=swoosh&license=any');
		expect(q.results.map((x) => x.sound.title).sort()).toEqual(['Fast whoosh', 'swoosh fast']);
		const w = await search(app, 'types=whoosh&license=any');
		expect(w.results.map((x) => x.sound.title).sort()).toEqual(['Fast whoosh', 'swoosh fast']);

		// Declaring the folder royalty-free makes it commercial-safe (and re-indexes it).
		const relicense = await putRoots(app, [{ ...body.roots[0], license: 'LicenseRef-UserRoyaltyFree' }]);
		expect(relicense.statusCode).toBe(200);
		await waitJob(app, (relicense.json() as { job: EngineJob }).job.id);
		expect((await search(app, 'sources=folder')).total).toBe(3);
		expect((await search(app, `rootId=${body.roots[0]!.id}`)).total).toBe(3);

		// Disabling takes its sounds out at once; removing keeps them out.
		const current = (relicense.json() as { roots: SoundRoot[] }).roots[0]!;
		const off = await putRoots(app, [{ ...current, enabled: false }]);
		expect(off.json()).toMatchObject({ removedSounds: 3, job: null });
		expect((await search(app, 'sources=folder&license=any')).total).toBe(0);
		expect((await putRoots(app, [])).json()).toMatchObject({ roots: [], removedSounds: 0 });
	});

	it('validates folder paths (D-47)', async () => {
		const app = await makeApp();
		const file = writeWav(join(tempAppdir('jasper-f-'), 'a.wav'), 'hit', 0.1);
		const folder = tempAppdir('jasper-f-');
		const cases: [unknown, number, string][] = [
			['relative/path', 400, 'BAD_PATH'],
			['/tmp/a\u0000b', 400, 'BAD_PATH'],
			[join(folder, 'missing'), 404, 'NOT_FOUND'],
			[file, 400, 'NOT_A_FOLDER'],
			['/', 400, 'BAD_PATH'],
		];
		for (const [path, status, code] of cases) {
			const r = await putRoots(app, [{ path }]);
			expect(r.statusCode, String(path)).toBe(status);
			expect(r.json().code).toBe(code);
		}
		const dup = await putRoots(app, [{ path: folder }, { path: `${folder}/.` }]);
		expect(dup.json()).toMatchObject({ code: 'DUPLICATE_FOLDER' });
		expect((await putRoots(app, [{ path: folder, license: 'CC-BY-NC-4.0' }])).statusCode).toBe(400);
		expect((await get<{ roots: unknown[] }>(app, '/api/sounds/roots')).body.roots).toEqual([]);
	});

	it('refuses folders outside local mode', async () => {
		const app = await makeApp({ dev: false });
		app.jasper.config.host = '192.0.2.10';
		const r = await putRoots(app, [{ path: tempAppdir('jasper-f-') }]);
		expect(r.statusCode).toBe(403);
		expect(r.json().code).toBe('LOCAL_MODE_ONLY');
		expect((await get<{ local: boolean }>(app, '/api/sounds/roots')).body.local).toBe(false);
	});
});

describe('agents and folders (approval gate, security review AGT-3)', { timeout: 300_000 }, () => {
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

	async function editorSession(app: App) {
		const doc = createEmptyProject({ ids: createCounterIdSource(5), name: 'Sounds', preset: 'hd-1080p-30' });
		const file = appdirPaths(app.appdir).projectFile(doc.projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				makeEnvelope(doc, { revision: 1, savedAt: '2026-10-15T00:00:00.000Z', platform: 'test' }),
			),
		);
		const ws: WebSocket = await app.injectWS('/agent', { headers: EDITOR });
		const cards: { approvalId: string; answerKey: string; summary: string; label: string }[] = [];
		let wake: (() => void) | null = null;
		ws.on('message', (d) => {
			const m = JSON.parse(String(d)) as { type: string; event?: string; payload?: unknown };
			if (m.type === 'event' && m.event === 'agent.approval.requested') {
				cards.push(m.payload as (typeof cards)[number]);
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
		const answer = (c: (typeof cards)[number], decision: 'approved' | 'denied') =>
			ws.send(
				JSON.stringify({
					type: 'event',
					event: 'agent.approval.resolve',
					payload: { approvalId: c.approvalId, decision, answerKey: c.answerKey },
				}),
			);
		return { card, answer, cards };
	}

	it('an agent adding or removing a folder needs the user; the editor and harmless changes do not', async () => {
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const folder = tempAppdir('jasper-agent-sfx-');
		writeWav(join(folder, 'boom.wav'), 'hit', 0.2);
		// No editor window to ask: refused, nothing changes.
		const refused = await putRoots(app, [{ path: folder }], AGENT);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({ code: 'APPROVAL_DENIED', detail: { code: 'E_APPROVAL_DENIED' } });
		expect((await get<{ roots: unknown[] }>(app, '/api/sounds/roots', AGENT)).body.roots).toEqual([]);

		const editor = await editorSession(app);
		const denied = putRoots(app, [{ path: folder, license: 'LicenseRef-UserRoyaltyFree' }], AGENT);
		const c1 = await editor.card(1);
		expect(c1.summary).toContain(folder);
		expect(c1.summary).toContain('LicenseRef-UserRoyaltyFree');
		editor.answer(c1, 'denied');
		expect((await denied).statusCode).toBe(403);
		expect((await get<{ roots: unknown[] }>(app, '/api/sounds/roots', AGENT)).body.roots).toEqual([]);

		const approved = putRoots(app, [{ path: folder }], AGENT);
		editor.answer(await editor.card(2), 'approved');
		const ok = await approved;
		expect(ok.statusCode).toBe(200);
		const root = (ok.json() as { roots: SoundRoot[]; job: EngineJob }).roots[0]!;
		await waitJob(app, (ok.json() as { job: EngineJob }).job.id);

		// Label and enabled changes are not decisions about the user's files: no card.
		const renamed = await putRoots(app, [{ ...root, label: 'Booms' }], AGENT);
		expect(renamed.statusCode).toBe(200);
		expect(editor.cards).toHaveLength(2);

		// A licence declaration is the user's: asked.
		const relicense = putRoots(app, [{ ...root, license: 'CC0-1.0' }], AGENT);
		const c3 = await editor.card(3);
		editor.answer(c3, 'denied');
		expect((await relicense).statusCode).toBe(403);

		// Removing: asked too.
		const remove = putRoots(app, [], AGENT);
		const c4 = await editor.card(4);
		expect(c4.summary).toContain('Booms');
		editor.answer(c4, 'approved');
		expect((await remove).statusCode).toBe(200);

		// The editor window itself is never asked.
		const mine = await putRoots(app, [{ path: folder }], EDITOR);
		expect(mine.statusCode).toBe(200);
		expect(editor.cards).toHaveLength(4);
	});
});

describe('search, audio, visual and register', { timeout: 300_000 }, () => {
	it('ranks with facets and filters', async () => {
		const app = await makeApp();
		await index(app);
		const all = await search(app);
		// CC0 and CC-BY are both commercial-safe.
		expect(all.total).toBe(4);
		expect(all.librarySize).toBe(4);
		expect(all.indexing).toBe(false);
		expect(all.facets.sources).toEqual({ starter: 4 });
		expect(all.facets.licenses).toEqual({ cc0: 3, 'cc-by': 1 });
		expect(all.facets.types.hit).toBe(2);
		expect(all.facets.families.impacts).toBe(2);

		const hits = await search(app, 'types=hit');
		expect(hits.total).toBe(2);
		// Facets of a dimension ignore its own filter.
		expect(hits.facets.types.whoosh).toBe(1);
		expect(hits.results.every((r) => r.sound.types.includes('hit'))).toBe(true);
		expect((await search(app, 'family=movement')).results.map((r) => r.sound.title)).toEqual(['Fast whoosh']);
		expect((await search(app, 'family=movement&types=hit')).total).toBe(0);
		expect((await search(app, `q=${encodeURIComponent('heavy')}`)).results[0]!.sound.title).toBe('Heavy hit');
		// `impact` is a synonym of hit.
		const impact = await search(app, 'q=impact');
		expect(impact.results.map((r) => r.sound.title).sort()).toEqual(['Heavy hit', 'Light hit']);
		expect((await search(app, 'length=short')).results.map((r) => r.sound.title)).toContain('Soft click');
		expect((await search(app, 'sources=pack')).total).toBe(0);
		const page = await search(app, 'limit=1&offset=1');
		expect(page).toMatchObject({ total: 4, offset: 1 });
		expect(page.results).toHaveLength(1);
		expect(page.results[0]!.sound.id).toBe(all.results[1]!.sound.id);

		const heavy = await byTitle(app, 'Heavy hit');
		const sim = await search(app, `similarTo=${heavy.id}`);
		expect(sim.results.map((r) => r.sound.id)).not.toContain(heavy.id);
		expect(sim.results[0]!.sound.title).toBe('Light hit');
		const rot = await search(app, `types=hit&usedNearby=${heavy.id}`);
		expect(rot.results.find((r) => r.sound.id === heavy.id)!.parts.rotation).toBeCloseTo(0.3);

		for (const bad of ['limit=0', 'limit=abc', 'sources=web', 'similarTo=nope', 'family=x', 'windowSec=-1'])
			expect((await get(app, `/api/sounds?${bad}`)).status, bad).toBe(400);
		expect((await get(app, `/api/sounds?similarTo=snd_${'f'.repeat(16)}`)).status).toBe(404);
	});

	it('serves audio with audio types only, nosniff and Range', async () => {
		const app = await makeApp();
		await index(app);
		const heavy = await byTitle(app, 'Heavy hit');
		const r = await app.inject({ method: 'GET', url: `/api/sounds/${heavy.id}/audio`, headers: H });
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toMatch(/^audio\/wav/);
		expect(r.headers['x-content-type-options']).toBe('nosniff');
		expect(String(r.headers['content-security-policy'])).toMatch(/(^|;\s*)sandbox(;|$)/);
		expect(r.headers['accept-ranges']).toBe('bytes');
		expect(r.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
		const part = await app.inject({
			method: 'GET',
			url: `/api/sounds/${heavy.id}/audio`,
			headers: { ...H, range: 'bytes=0-11' },
		});
		expect(part.statusCode).toBe(206);
		expect(part.rawPayload.length).toBe(12);
		expect((await get(app, `/api/sounds/snd_${'0'.repeat(16)}/audio`)).status).toBe(404);
		expect((await get(app, '/api/sounds/..%2F..%2Fetc%2Fpasswd/audio')).status).toBe(404);
		// The file went away: a clear error, not a crash.
		rmSync(join(starter, 'impacts', 'hit_heavy.wav'));
		const gone = await get<{ code: string }>(app, `/api/sounds/${heavy.id}/audio`);
		expect(gone.status).toBe(404);
		expect(gone.body.code).toBe('SOUND_FILE_MISSING');
		// A file swapped for a link that leaves the kit is refused.
		symlinkSync('/etc/hostname', join(starter, 'impacts', 'hit_heavy.wav'));
		const out = await get<{ code: string }>(app, `/api/sounds/${heavy.id}/audio`);
		expect(out.status).toBe(403);
	});

	it('returns visual data, from the index cache or computed again', async () => {
		const app = await makeApp();
		await index(app);
		const heavy = await byTitle(app, 'Heavy hit');
		const v = SoundVisualSchema.parse((await get(app, `/api/sounds/${heavy.id}/visual`)).body);
		expect(v).toMatchObject({
			soundId: heavy.id,
			fingerprint: heavy.fingerprint,
			peakSec: heavy.descriptors.peakSec,
		});
		expect(v.peaks.count).toBe(60);
		expect(v.spectrogram).toMatchObject({ bins: 64, frames: 60, minHz: 20, maxHz: 20000, floorDb: -96 });
		// The loudest peak is where the hit is.
		const peaks = Buffer.from(v.peaks.data, 'base64');
		expect(peaks).toHaveLength(60);
		expect(Buffer.from(v.spectrogram.data, 'base64')).toHaveLength(60 * 64);
		expect(peaks.indexOf(Math.max(...peaks))).toBeLessThanOrEqual(5);
		rmSync(appdirPaths(app.appdir).soundCacheDir, { recursive: true, force: true });
		const again = SoundVisualSchema.parse((await get(app, `/api/sounds/${heavy.id}/visual`)).body);
		expect(again).toEqual(v);
	});

	it('registers a sound into a project with its provenance, copies it with lead silence and dedupes', async () => {
		const app = await makeApp();
		await index(app);
		const created = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: JSON_H,
			payload: { name: 'SFX', preset: 'hd-1080p-30' },
		});
		const projectId = (created.json() as { projectId: string }).projectId;
		const whoosh = await byTitle(app, 'Fast whoosh');
		const status = SoundLibraryStatusSchema.parse((await get(app, '/api/sounds/status')).body);
		const reg = async (id: string, pid = projectId) =>
			app.inject({
				method: 'POST',
				url: `/api/sounds/${id}/register`,
				headers: JSON_H,
				payload: { projectId: pid },
			});
		const r = await reg(whoosh.id);
		expect(r.statusCode, r.body).toBe(200);
		const out = RegisterSoundResponseSchema.parse(r.json());
		// The whoosh swells from silence but its quiet head (< 50 ms) cannot absorb every sub-frame rest: the project
		// gets a copy with 50 ms (2400 samples at 48 kHz) of silence in front, a different file.
		expect(whoosh.descriptors.headQuietSec).toBeLessThan(LIBRARY_LEAD_SILENCE_SEC);
		expect(out.fingerprint).not.toBe(whoosh.fingerprint);
		expect(out.kind).toBe('audio');
		expect(out.existingMediaId).toBeNull();
		const lead = 2400 / 48000;
		// …and as it does not end in 50 ms of quiet, silence after it too (fix "SFX tail truncation")
		const trailSamples = libraryTrailSilenceSamples(whoosh.descriptors, 48000, {
			analysedSec: SOUND_ANALYSIS_SECONDS,
		});
		expect(trailSamples).toBe(2400);
		const trail = trailSamples / 48000;
		expect(LibraryProvenanceSchema.parse(out.library)).toEqual({
			soundId: whoosh.id,
			title: 'Fast whoosh',
			types: ['whoosh'],
			source: { type: 'starter', file: 'movement/whoosh_fast.wav', packId: 'test-impacts' },
			license: 'CC-BY-4.0',
			licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
			author: 'Jane Doe',
			sourceUrl: 'https://example.invalid/sounds',
			attribution: whoosh.attribution,
			descriptors: {
				peakSec: whoosh.descriptors.peakSec + lead,
				onsetSec: whoosh.descriptors.onsetSec + lead,
				headQuietSec: whoosh.descriptors.headQuietSec + lead,
				durationSec: whoosh.descriptors.durationSec + lead + trail,
				octaveBandsDb: whoosh.descriptors.octaveBandsDb,
				centroidHz: whoosh.descriptors.centroidHz,
				maxMomentaryLufs: whoosh.descriptors.maxMomentaryLufs,
				// the true peak too (Phase 2 verification B: placement's default level caps by it)
				truePeakDb: whoosh.descriptors.truePeakDb,
				// where it has faded (the analysis covered the whole file)
				tailSec: whoosh.descriptors.tailSec,
			},
			leadSilenceSec: lead,
			trailSilenceSec: trail,
			snapshotHash: status.snapshotHash,
		});
		// Copied into managed media (the project does not depend on the app's install folder).
		const media = appdirPaths(app.appdir).mediaDir;
		expect(readdirSync(join(media, out.mediaKey))).toEqual(['whoosh_fast.wav']);
		// The copy is the library file's samples exactly, between 2400 samples of digital silence on each side.
		const original = decodeF32(join(starter, 'movement', 'whoosh_fast.wav'));
		const padded = decodeF32(join(media, out.mediaKey, 'whoosh_fast.wav'));
		expect(padded.length).toBe(original.length + 2 * 2400 + 2 * trailSamples);
		expect(padded.subarray(0, 2 * 2400).every((v) => v === 0)).toBe(true);
		expect(padded.subarray(padded.length - 2 * trailSamples).every((v) => v === 0)).toBe(true);
		const body = padded.subarray(2 * 2400, padded.length - 2 * trailSamples);
		expect(
			Buffer.from(body.buffer, body.byteOffset, body.byteLength).equals(Buffer.from(original.buffer)),
		).toBe(true);
		expect(out.probe.durationFlicks).toBe(
			Math.round((whoosh.format.durationSec + lead + trail) * 705_600_000),
		);
		expect(readdirSync(media).filter((f) => f.startsWith('.sound-tmp'))).toEqual(
			existsSync(join(media, '.sound-tmp')) ? ['.sound-tmp'] : [],
		);
		if (existsSync(join(media, '.sound-tmp'))) expect(readdirSync(join(media, '.sound-tmp'))).toEqual([]);

		// Registering again: the same bytes, so the same media; once the saved project has it, it is named.
		const again = RegisterSoundResponseSchema.parse((await reg(whoosh.id)).json());
		expect(again.mediaKey).toBe(out.mediaKey);
		expect(again.fingerprint).toBe(out.fingerprint);
		const projectFile = appdirPaths(app.appdir).projectFile(projectId);
		const env = JSON.parse(readFileSync(projectFile, 'utf8'));
		env.document.media.med_FAKE0000000001 = {
			id: 'med_FAKE0000000001',
			fingerprint: out.fingerprint,
			derivation: null,
		};
		writeFileSync(projectFile, JSON.stringify(env));
		expect(RegisterSoundResponseSchema.parse((await reg(whoosh.id)).json()).existingMediaId).toBe(
			'med_FAKE0000000001',
		);

		expect((await reg(`snd_${'0'.repeat(16)}`)).statusCode).toBe(404);
		expect((await reg(whoosh.id, 'prj_0000000000000099')).statusCode).toBe(404);
		expect((await reg(whoosh.id, '../../etc')).statusCode).toBe(404);
	});

	it('registers folder sounds in place, and Jasper Synth sounds (indexed below real recordings) as copies', async () => {
		process.env.JASPER_SOUND_SYNTH_VARIANTS = '1';
		const app = await makeApp();
		const folder = tempAppdir('jasper-sfx-place-');
		const wav = writeWav(join(folder, 'Hits', 'punch.wav'), 'hit', 0.3, 77);
		// A hit after 80 ms of silence and before 80 ms more: its quiet head absorbs any sub-frame rest and its quiet end
		// holds the last frame of a placed clip, so it is registered in place.
		const late = join(folder, 'Hits', 'late punch.wav');
		const [l, r] = samples('hit', 0.3, 79);
		const pad = (c: Float32Array) => {
			const o = new Float32Array(c.length + 0.16 * SR);
			o.set(c, 0.08 * SR);
			return o;
		};
		writeFileSync(late, encodeWav([pad(l!), pad(r!)], SR, 's16'));
		const put = await putRoots(app, [{ path: folder, license: 'CC0-1.0' }]);
		const job = await waitJob(app, (put.json() as { job: EngineJob }).job.id);
		const result = SoundIndexResultSchema.parse(job.result);
		expect(result.errors.filter((e) => e.source !== 'starter')).toEqual([]);
		// 4 starter + 2 folder + 20 synth (one seed per recipe: the 19 types and the stingers' TV static).
		expect(result.sounds).toBe(26);
		const status = SoundLibraryStatusSchema.parse((await get(app, '/api/sounds/status')).body);
		expect(status.bySource).toEqual({ starter: 4, pack: 0, folder: 2, synth: 20 });
		const synth = (await search(app, 'sources=synth&limit=100')).results.map((r) => r.sound);
		expect(synth).toHaveLength(20);
		for (const s of synth) {
			expect(s).toMatchObject({
				license: 'LicenseRef-JasperEditor',
				author: 'JasperEditor',
				attribution: null,
			});
			expect(s.source.type).toBe('synth');
			expect(s.judge?.ok, `${s.title}: ${s.judge?.reasons.join(', ')}`).toBe(true);
		}
		// Real recordings always come first.
		const hits = await search(app, 'types=hit');
		const order = hits.results.map((r) => r.sound.source.type);
		expect(order).toHaveLength(5);
		expect(order[4]).toBe('synth');
		expect([...order.slice(0, 4)].sort()).toEqual(['folder', 'folder', 'starter', 'starter']);

		const created = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: JSON_H,
			payload: { name: 'SFX', preset: 'hd-1080p-30' },
		});
		const projectId = (created.json() as { projectId: string }).projectId;
		const folderHits = hits.results.filter((r) => r.sound.source.type === 'folder').map((r) => r.sound);
		const punch = folderHits.find((e) => e.title === 'punch')!;
		const latePunch = folderHits.find((e) => e.title === 'late punch')!;
		expect(latePunch.descriptors.headQuietSec).toBeGreaterThanOrEqual(LIBRARY_LEAD_SILENCE_SEC);
		const registerIt = async (id: string) =>
			RegisterSoundResponseSchema.parse(
				(
					await app.inject({
						method: 'POST',
						url: `/api/sounds/${id}/register`,
						headers: JSON_H,
						payload: { projectId },
					})
				).json(),
			);
		const inPlace = await registerIt(latePunch.id);
		expect(inPlace.fingerprint).toBe(latePunch.fingerprint);
		expect(inPlace.locators).toContainEqual(expect.objectContaining({ type: 'path', path: late }));
		expect(inPlace.library.license).toBe('CC0-1.0');
		expect(inPlace.library.leadSilenceSec).toBeUndefined();
		expect(inPlace.library.trailSilenceSec).toBeUndefined();
		expect(inPlace.library.descriptors?.peakSec).toBe(latePunch.descriptors.peakSec);
		expect(existsSync(join(appdirPaths(app.appdir).mediaDir, inPlace.mediaKey))).toBe(false);
		// A folder hit with a loud head gets a managed padded copy (decision: exact placement over in-place).
		const padded = await registerIt(punch.id);
		expect(padded.fingerprint).not.toBe(punch.fingerprint);
		expect(padded.library.leadSilenceSec).toBe(0.05);
		expect(padded.library.source).toEqual(punch.source);
		expect(padded.library.descriptors?.peakSec).toBeCloseTo(punch.descriptors.peakSec + 0.05, 9);
		expect(readdirSync(join(appdirPaths(app.appdir).mediaDir, padded.mediaKey))).toEqual(['punch.wav']);

		// A synth render that was cleaned away is rendered again, byte for byte.
		const hitSynth = hits.results.find((r) => r.sound.source.type === 'synth')!.sound;
		rmSync(appdirPaths(app.appdir).soundSynthDir, { recursive: true, force: true });
		const audio = await app.inject({ method: 'GET', url: `/api/sounds/${hitSynth.id}/audio`, headers: H });
		expect(audio.statusCode).toBe(200);
		const s = RegisterSoundResponseSchema.parse(
			(
				await app.inject({
					method: 'POST',
					url: `/api/sounds/${hitSynth.id}/register`,
					headers: JSON_H,
					payload: { projectId },
				})
			).json(),
		);
		// the synth hit starts at once: padded, from the re-rendered (identical) file
		expect(hitSynth.descriptors.headQuietSec).toBeLessThan(LIBRARY_LEAD_SILENCE_SEC);
		expect(s.library.leadSilenceSec).toBe(0.05);
		expect(s.library.source).toEqual({ type: 'synth', recipe: 'synth.hit', seed: 0 });
		// A folder file changed since indexing is reported, not silently registered as the old sound.
		writeWav(wav, 'hit', 0.31, 78);
		utimesSync(wav, new Date(), new Date(Date.now() + 5000));
		const changed = await app.inject({
			method: 'POST',
			url: `/api/sounds/${punch.id}/register`,
			headers: JSON_H,
			payload: { projectId },
		});
		expect(changed.statusCode).toBe(409);
		expect(changed.json().code).toBe('SOUND_CHANGED');
	});
});

describe('lossy sounds are registered as PCM (sample-exact seeks)', { timeout: 300_000 }, () => {
	// Phase 2 verification: an Ogg Vorbis sound with a quiet head was registered as the Ogg itself. ffmpeg's seeked
	// Vorbis decode (what every export path does for a clip whose In point is not 0) is 128 samples off its full
	// decode (what the descriptors are measured on), so a peak-aligned clip with a sub-frame In played 2.7 ms late
	// (measured on the Remotion export of the Phase 2 fixture: +129 samples). A lossy source is now registered as a
	// PCM WAV copy of its full decode (no lead silence when its head is already quiet).
	it('an Ogg Vorbis sound with a quiet head becomes a WAV copy whose samples are its full decode', async () => {
		const app = await makeApp();
		const folder = tempAppdir('jasper-sfx-ogg-');
		const kit = join(fileURLToPath(new URL('../sounds/starter/', import.meta.url)), 'swish-blade-01.ogg');
		mkdirSync(join(folder, 'Swishes'), { recursive: true });
		copyFileSync(kit, join(folder, 'Swishes', 'blade.ogg'));
		const put = await putRoots(app, [{ path: folder, license: 'CC0-1.0' }]);
		await waitJob(app, (put.json() as { job: EngineJob }).job.id);
		const blade = (await search(app, 'sources=folder&limit=10')).results.map((r) => r.sound)[0]!;
		expect(blade.title).toBe('blade');
		expect(blade.descriptors.headQuietSec).toBeGreaterThanOrEqual(LIBRARY_LEAD_SILENCE_SEC);
		const created = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: JSON_H,
			payload: { name: 'SFX', preset: 'hd-1080p-30' },
		});
		const projectId = (created.json() as { projectId: string }).projectId;
		const r = await app.inject({
			method: 'POST',
			url: `/api/sounds/${blade.id}/register`,
			headers: JSON_H,
			payload: { projectId },
		});
		expect(r.statusCode, r.body).toBe(200);
		const out = RegisterSoundResponseSchema.parse(r.json());
		expect(out.library.leadSilenceSec).toBeUndefined();
		expect(out.library.descriptors?.peakSec).toBe(blade.descriptors.peakSec);
		expect(out.fingerprint).not.toBe(blade.fingerprint);
		const media = appdirPaths(app.appdir).mediaDir;
		expect(readdirSync(join(media, out.mediaKey))).toEqual(['blade.wav']);
		const copy = join(media, out.mediaKey, 'blade.wav');
		const full = decodeF32(join(folder, 'Swishes', 'blade.ogg'));
		const pcm = decodeF32(copy);
		expect(pcm.length).toBe(full.length);
		expect(Buffer.from(pcm.buffer).equals(Buffer.from(full.buffer))).toBe(true);
		// a seek into the copy (an In point) lands on the same sample as the full decode
		const at = 1013; // 21.1 ms at 48 kHz
		const seeked = new Float32Array(
			execFileSync(TEST_FFMPEG, [
				'-v',
				'error',
				'-ss',
				String(at / SR),
				'-i',
				copy,
				'-map',
				'0:a:0',
				'-f',
				'f32le',
				'-',
			]).buffer.slice(0),
		);
		const ch = 2;
		const bytes = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
		expect(bytes(seeked.subarray(0, 2000 * ch)).equals(bytes(full.subarray(at * ch, (at + 2000) * ch)))).toBe(
			true,
		);
	});
});

describe('hostile requests never crash the routes', { timeout: 300_000 }, () => {
	it('search queries and folder bodies (property)', async () => {
		const app = await makeApp();
		await index(app);
		await fc.assert(
			fc.asyncProperty(
				fc.dictionary(
					fc.constantFrom(
						'q',
						'types',
						'family',
						'visualKind',
						'windowSec',
						'license',
						'sources',
						'limit',
						'offset',
						'similarTo',
						'usedNearby',
						'rootId',
						'zzz',
					),
					fc.oneof(
						fc.string(),
						fc.constantFrom('hit', 'hit,whoosh', '0', '500', 'snd_0123456789abcdef', '1e9', '-1', '%00'),
					),
				),
				async (q) => {
					const qs = Object.entries(q)
						.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
						.join('&');
					const r = await app.inject({ method: 'GET', url: `/api/sounds?${qs}`, headers: H });
					expect(r.statusCode, `${qs} → ${r.body.slice(0, 200)}`).toBeLessThan(500);
				},
			),
			{ numRuns: 120, seed: 0x5eed },
		);
		await fc.assert(
			fc.asyncProperty(fc.jsonValue(), async (body) => {
				const r = await app.inject({
					method: 'PUT',
					url: '/api/sounds/roots',
					headers: JSON_H,
					payload: JSON.stringify(body),
				});
				expect(r.statusCode, r.body.slice(0, 200)).toBeLessThan(500);
			}),
			{ numRuns: 80, seed: 0x5eed },
		);
		const folder = tempAppdir('jasper-fuzz-folder-');
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						path: fc.oneof(fc.string(), fc.constant(folder)),
						label: fc.string(),
						enabled: fc.boolean(),
					}),
					{ maxLength: 3 },
				),
				async (roots) => {
					const r = await putRoots(app, roots);
					expect(r.statusCode, r.body.slice(0, 200)).toBeLessThan(500);
				},
			),
			{ numRuns: 40, seed: 0x5eed },
		);
	});
});

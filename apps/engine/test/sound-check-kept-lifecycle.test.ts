// A kept Sound Check report goes with its sequence and its project (wp-note "WP6.5b → Sound Check" (d)). Decision: the
// report of a sequence the saved project no longer has is deleted when no editing session could bring the sequence
// back — a save with no editor holding the project (agent / headless edits), the end of the editor's session, the start
// of a new one; while an editor holds the project its History can undo the delete, so the report stays (and serves the
// sequence again when the undo is saved). A check that finishes after its project or sequence is gone keeps nothing.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Lease, SoundCheckLastResponseSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SoundCheckReportStore } from '../src/sound-design/report-store.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, type TestApp } from './helpers.ts';
import { keptReportFixture } from './sound-check-fixture.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_life_0123456789abcdef0123';
const KEY = 'key_life_0123456789abcdef0123';
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

let app: TestApp;
let appdir: string;
let projects = 0;

/** A saved project with two sequences, each with a kept report (written as the engine's store writes them). */
async function seeded(): Promise<{
	projectId: string;
	doc: ProjectDocument;
	a: string;
	b: string;
	file: (s: string) => string;
}> {
	const builder = new DocBuilder();
	const a = builder.seqId;
	const b = (builder.tx([{ type: 'sequence.create', name: 'Second', ref: '$s' }]).refs.$s as string)!;
	const projectId = `prj_${(4200 + ++projects).toString().padStart(16, '0')}`;
	const doc = { ...builder.doc, projectId };
	const file = appdirPaths(appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-17T00:00:00.000Z', platform: 'test' })),
	);
	const store = new SoundCheckReportStore({ projectDir: (pid) => appdirPaths(appdir).projectDir(pid) });
	for (const s of [a, b])
		expect(await store.save(projectId, keptReportFixture(projectId, s), `job_${s}`)).toBe(true);
	const at = (s: string) => join(appdirPaths(appdir).projectDir(projectId), 'sound-check', `${s}.json`);
	return { projectId, doc, a, b, file: at };
}
const post = (url: string, body: unknown, headers: Record<string, string> = EDITOR_H) =>
	app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(body) });
const last = (projectId: string, sequenceId: string) =>
	post('/api/sound-design/check/last', { projectId, sequenceId });
// Observe real reads and prunes so a save or lease change can be drained without a deadline.
const pending = new Set<Promise<unknown>>();
function observe<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise);
	void promise.then(
		() => pending.delete(promise),
		() => pending.delete(promise),
	);
	return promise;
}
async function drainPrunes(): Promise<void> {
	do {
		await Promise.allSettled([...pending]);
		// A completed project read starts the prune in its promise continuation.
		await new Promise<void>((resolve) => setImmediate(resolve));
	} while (pending.size);
}
async function saveDoc(projectId: string, doc: ProjectDocument): Promise<void> {
	const cur = await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: EDITOR_H });
	const revision = (cur.json() as { revision: number }).revision;
	const r = await app.inject({
		method: 'PUT',
		url: `/api/projects/${projectId}`,
		headers: { ...json(EDITOR_H), 'if-match': String(revision) },
		payload: JSON.stringify(
			makeEnvelope(doc, { revision: revision + 1, savedAt: '2026-10-17T00:00:01.000Z', platform: 'test' }),
		),
	});
	expect(r.statusCode, r.body).toBe(200);
}
const without = (doc: ProjectDocument, seqId: string): ProjectDocument => {
	const d = structuredClone(doc);
	delete (d.sequences as Record<string, unknown>)[seqId];
	return d;
};

beforeAll(async () => {
	appdir = mkdtempSync(join(tmpdir(), 'jasper-life-appdir-'));
	app = await makeApp({ appdir, dev: false, token: TOKEN, editorKey: KEY });
	const projects = coreServices(app).projects;
	const get = projects.get.bind(projects);
	vi.spyOn(projects, 'get').mockImplementation((projectId) => observe(get(projectId)));
	const prune = SoundCheckReportStore.prototype.prune;
	vi.spyOn(SoundCheckReportStore.prototype, 'prune').mockImplementation(function (
		this: SoundCheckReportStore,
		...args: Parameters<SoundCheckReportStore['prune']>
	) {
		return observe(prune.apply(this, args));
	});
}, 180_000);
afterAll(async () => {
	await closeApps();
	await drainPrunes();
	vi.restoreAllMocks();
	rmSync(appdir, { recursive: true, force: true });
});

describe('the kept report follows its sequence and project', { timeout: 120_000 }, () => {
	it('a save without the sequence while no editor holds the project: its report is deleted, the other is kept', async () => {
		const { projectId, doc, a, b, file } = await seeded();
		expect((await last(projectId, b)).statusCode).toBe(200);
		// (headless agent transactions refuse sequence.delete — destructive — so the save is the way it goes)
		await saveDoc(projectId, without(doc, b));
		await drainPrunes();
		expect(existsSync(file(b)), 'the deleted sequence’s report is gone').toBe(false);
		expect(existsSync(file(a))).toBe(true);
		expect((await last(projectId, a)).statusCode).toBe(200);
	});

	it('while an editor holds the project the delete can be undone: kept; undone and saved: served again; gone when the session ends', async () => {
		const { projectId, doc, a, b, file } = await seeded();
		const lease = (
			await post(`/api/projects/${projectId}/lease`, { sessionId: 'ses_editor_1' })
		).json() as Lease;
		expect(lease.leaseId).toBeTruthy();
		// the editor deletes B and saves: B's History entry can still undo it
		await saveDoc(projectId, without(doc, b));
		await drainPrunes();
		expect(existsSync(file(b))).toBe(true);
		// undo + save: the sequence is back, and so is its report
		await saveDoc(projectId, doc);
		const back = await last(projectId, b);
		expect(back.statusCode, back.body).toBe(200);
		expect(SoundCheckLastResponseSchema.parse(back.json()).sequenceId).toBe(b);
		// deleted again, saved, the editor closes (lease released): nobody can bring it back
		await saveDoc(projectId, without(doc, b));
		await drainPrunes();
		expect(existsSync(file(b))).toBe(true);
		const rel = await app.inject({
			method: 'DELETE',
			url: `/api/projects/${projectId}/lease/${lease.leaseId}`,
			headers: EDITOR_H,
		});
		expect(rel.statusCode, rel.body).toBe(200);
		await drainPrunes();
		expect(existsSync(file(b)), 'gone when the session ends').toBe(false);
		expect(existsSync(file(a))).toBe(true);
	});

	it('an unsaved delete undone before the session ends keeps the report; a new session prunes against the saved project', async () => {
		const { projectId, doc, a, b, file } = await seeded();
		const l1 = (
			await post(`/api/projects/${projectId}/lease`, { sessionId: 'ses_editor_2' })
		).json() as Lease;
		await saveDoc(projectId, without(doc, b));
		// the window is taken over by another session (its History is not the old one's): pruned at once
		const l2 = await post(`/api/projects/${projectId}/lease`, { sessionId: 'ses_editor_3', takeOver: true });
		expect(l2.statusCode, l2.body).toBe(200);
		expect((l2.json() as Lease).leaseId).not.toBe(l1.leaseId);
		await drainPrunes();
		expect(existsSync(file(b)), 'a new session starts from the saved project').toBe(false);
		expect(existsSync(file(a))).toBe(true);
	});

	it('deleting the project deletes its kept reports', async () => {
		const { projectId } = await seeded();
		const dir = appdirPaths(appdir).projectDir(projectId);
		expect(readdirSync(join(dir, 'sound-check')).length).toBe(2);
		const r = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: EDITOR_H });
		expect(r.statusCode, r.body).toBe(200);
		expect(existsSync(dir)).toBe(false);
	});
});

describe('SoundCheckReportStore lifecycle', () => {
	it('prune keeps only the given sequences (moved-aside copies too); keep / exists refuse a late report', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-life-store-'));
		let projectThere = true;
		const store = new SoundCheckReportStore({
			projectDir: (pid) => join(dir, pid),
			exists: async () => projectThere,
			keep: async (_pid, seq) => seq !== 'seq_gone',
		});
		for (const s of ['seq_1', 'seq_2', 'seq_3'])
			expect(await store.save('prj_a', keptReportFixture('prj_a', s), null)).toBe(true);
		writeFileSync(join(dir, 'prj_a', 'sound-check', 'seq_2.json.corrupt-123'), 'x');
		expect(await store.save('prj_a', keptReportFixture('prj_a', 'seq_gone'), null)).toBe(false);
		expect((await store.prune('prj_a', new Set(['seq_1']))).sort()).toEqual(['seq_2', 'seq_3']);
		expect(readdirSync(join(dir, 'prj_a', 'sound-check'))).toEqual(['seq_1.json']);
		expect(await store.prune('prj_missing', new Set())).toEqual([]);
		// the project is deleted while a report is written: nothing is left behind (exists checked after the write)
		let calls = 0;
		const racing = new SoundCheckReportStore({
			projectDir: (pid) => join(dir, pid),
			exists: async () => ++calls === 1,
		});
		expect(await racing.save('prj_b', keptReportFixture('prj_b', 'seq_1'), null)).toBe(false);
		expect(existsSync(join(dir, 'prj_b'))).toBe(false);
		projectThere = false;
		expect(await store.save('prj_a', keptReportFixture('prj_a', 'seq_1'), null)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
});

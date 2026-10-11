import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appdirPaths } from '@jasper/config';
import { EngineClient } from '@jasper/engine-client';
import { CURRENT_SCHEMA_VERSION } from '@jasper/project';
import { defaultSequenceView, EngineProjectStore, type ProjectViewState } from '@jasper/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaseManager } from '../src/projects/leases.ts';
import { ProjectStoreFs } from '../src/projects/store.ts';
import { closeApps, H, JSON_H, makeApp, type TestApp, tempAppdir } from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	app = await makeApp();
});
afterAll(closeApps);

async function create(name = 'My Project'): Promise<string> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/projects',
		headers: JSON_H,
		payload: { name, preset: 'hd-1080p-29.97' },
	});
	expect(r.statusCode).toBe(201);
	return r.json().projectId;
}

function projectStore(): EngineProjectStore {
	const client = new EngineClient({
		baseUrl: 'http://engine.test',
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const r = await app.inject({
				method: (init?.method ?? 'GET') as 'GET',
				url: url.pathname + url.search,
				headers: { ...H, ...((init?.headers as Record<string, string>) ?? {}) },
				...(init?.body !== undefined ? { payload: init.body as string } : {}),
			});
			return new Response(
				r.statusCode === 204 || r.statusCode === 304 ? null : new Uint8Array(r.rawPayload),
				{
					status: r.statusCode,
					headers: r.headers as Record<string, string>,
				},
			);
		}) as typeof fetch,
	});
	return new EngineProjectStore(client);
}

describe('projects (ARCHITECTURE §9.2)', () => {
	it('creates, lists and opens a project envelope', async () => {
		const id = await create();
		expect(id).toMatch(/^prj_[0-9A-Z]{16}$/);
		const list = (await app.inject({ method: 'GET', url: '/api/projects', headers: H })).json().projects;
		expect(list).toEqual([
			expect.objectContaining({
				projectId: id,
				name: 'My Project',
				revision: 0,
				schemaVersion: CURRENT_SCHEMA_VERSION,
				thumbnail: null,
			}),
		]);
		const got = (await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: H })).json();
		expect(got.revision).toBe(0);
		expect(got.view).toBeNull();
		expect(got.envelope).toMatchObject({
			format: 'jasper-project',
			schemaVersion: CURRENT_SCHEMA_VERSION,
			revision: 0,
		});
		const seq = Object.values(
			got.envelope.document.sequences as Record<
				string,
				{ settings: { frameRate: unknown; dropFrame: boolean } }
			>,
		)[0]!;
		expect(seq.settings).toMatchObject({ frameRate: { num: 30000, den: 1001 }, dropFrame: true });
		expect(
			(await app.inject({ method: 'GET', url: '/api/projects/prj_ZZZZZZZZZZZZZZZZ', headers: H })).json()
				.code,
		).toBe('PROJECT_NOT_FOUND');
		expect((await app.inject({ method: 'GET', url: '/api/projects/..%2Fetc', headers: H })).statusCode).toBe(
			404,
		);
		const bad = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: JSON_H,
			payload: { name: 'x', preset: 'nope' },
		});
		expect(bad.statusCode).toBe(400);
	});

	it('saves with If-Match revisions and answers 409 with the current revision on conflict', async () => {
		const id = await create('Conflicts');
		const { envelope } = (await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: H })).json();
		const save = (rev: number, ifMatch: string | undefined, name: string) =>
			app.inject({
				method: 'PUT',
				url: `/api/projects/${id}`,
				headers: { ...JSON_H, ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) },
				payload: { ...envelope, revision: rev, document: { ...envelope.document, name } },
			});
		const ok = await save(3, '0', 'Renamed');
		expect(ok.statusCode).toBe(200);
		expect(ok.json()).toEqual({ revision: 3 });
		const conflict = await save(1, '0', 'Stale');
		expect(conflict.statusCode).toBe(409);
		expect(conflict.json()).toMatchObject({ code: 'REVISION_CONFLICT', detail: { revision: 3 } });
		expect((await save(2, '3', 'Again')).json()).toEqual({ revision: 4 });
		expect((await save(9, undefined, 'x')).statusCode).toBe(428);
		const doc = (await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: H })).json();
		expect(doc.revision).toBe(4);
		expect(doc.envelope.document.name).toBe('Again');
		const invalid = await app.inject({
			method: 'PUT',
			url: `/api/projects/${id}`,
			headers: { ...JSON_H, 'if-match': '4' },
			payload: { ...envelope, revision: 5, document: { ...envelope.document, sequences: 'nope' } },
		});
		expect(invalid.statusCode).toBe(400);
		const foreign = await app.inject({
			method: 'PUT',
			url: `/api/projects/${id}`,
			headers: { ...JSON_H, 'if-match': '4' },
			payload: {
				...envelope,
				revision: 5,
				document: { ...envelope.document, projectId: 'prj_0000000000000009' },
			},
		});
		expect(foreign.statusCode).toBe(400);
		const dir = appdirPaths(app.appdir).projectDir(id);
		expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([]);
	});

	it('works end to end with the session EngineProjectStore (open → save → conflict)', async () => {
		const store = projectStore();
		const id = await store.create({ name: 'Session', preset: 'hd-1080p-30' });
		const opened = await store.open(id);
		expect(opened.revision).toBe(0);
		const saved = await store.save(
			id,
			{ ...opened.document, name: 'Session 2' },
			{ revision: 5, baseRevision: 0 },
		);
		expect(saved).toEqual({ ok: true, revision: 5 });
		const stale = await store.save(id, opened.document, { revision: 6, baseRevision: 0 });
		expect(stale).toEqual({ ok: false, conflict: true, revision: 5 });
		const sequenceId = Object.keys(opened.document.sequences)[0]!;
		const view: ProjectViewState = {
			version: 1,
			views: { [sequenceId]: { ...defaultSequenceView(), playhead: 42 } },
			tabs: { open: [sequenceId] },
			activeSequenceId: sequenceId,
		};
		await store.saveView(id, view);
		const reopened = await store.open(id);
		expect(reopened.view).toEqual(view);
		expect(reopened.issues).toEqual([]);
		expect((await store.listVersions(id)).length).toBe(1);
		const lease = await store.acquireLease(id, '00000000-0000-4000-8000-00000000000a');
		await expect(store.acquireLease(id, '00000000-0000-4000-8000-00000000000b')).rejects.toThrow();
		await store.releaseLease(id, lease.leaseId);
		await store.delete(id);
		expect((await store.list()).some((p) => p.projectId === id)).toBe(false);
	});

	it('reports malformed saved views without changing project or view bytes', async () => {
		const store = projectStore();
		const id = await store.create({ name: 'Preserved view', preset: 'hd-1080p-30' });
		const original = await store.open(id);
		const paths = appdirPaths(app.appdir);
		const projectBytes = readFileSync(paths.projectFile(id));
		await store.engine.putView(id, { version: 1 });
		const viewBytes = readFileSync(paths.projectViewFile(id));

		const reopened = await store.open(id);
		expect(reopened.view).toBeNull();
		expect(reopened.issues).toEqual([
			expect.objectContaining({
				code: 'W_REPAIRED',
				message: expect.stringContaining('Saved view settings'),
			}),
		]);
		expect(reopened.document).toEqual(original.document);
		expect(reopened.revision).toBe(original.revision);
		expect(readFileSync(paths.projectFile(id))).toEqual(projectBytes);
		expect(readFileSync(paths.projectViewFile(id))).toEqual(viewBytes);
	});

	it('keeps versions at most every 5 minutes of saving (S01:PER-020) and stores the view file', async () => {
		let now = Date.parse('2026-09-30T10:00:00Z');
		const appdir = tempAppdir();
		const paths = appdirPaths(appdir);
		const store = new ProjectStoreFs({
			paths,
			leases: new LeaseManager(),
			appVersion: '0.1.0',
			now: () => new Date(now),
		});
		const id = await store.create({ name: 'V', preset: 'hd-1080p-30' });
		const { envelope } = await store.get(id);
		let rev = 0;
		const save = async () => {
			rev = (await store.save(id, { ...envelope, revision: rev + 1 }, rev)).revision;
		};
		await save();
		now += 60_000;
		await save();
		now += 5 * 60_000;
		await save();
		const versions = await store.versions(id);
		expect(versions.map((v) => v.revision)).toEqual([2, 0]);
		await store.saveView(id, { version: 1, playhead: 42 });
		expect(JSON.parse(readFileSync(paths.projectViewFile(id), 'utf8'))).toEqual({ version: 1, playhead: 42 });
		const loaded = await store.get(id);
		expect(loaded.revision).toBe(3);
		expect(loaded.envelope.document.name).toBe('V');
		await store.delete(id);
		expect(existsSync(join(paths.projectsDir, id))).toBe(false);
	});
});

describe('leases (S01:PER-040)', () => {
	it('grants one holder, refreshes by heartbeat, expires after 30 s and releases', async () => {
		const id = await create('Leases');
		const acquire = (sessionId: string) =>
			app.inject({
				method: 'POST',
				url: `/api/projects/${id}/lease`,
				headers: JSON_H,
				payload: { sessionId },
			});
		const a = await acquire('sess-a');
		expect(a.statusCode).toBe(200);
		const lease = a.json();
		expect(lease).toMatchObject({ projectId: id, sessionId: 'sess-a', heartbeatMs: 10_000 });
		const b = await acquire('sess-b');
		expect(b.statusCode).toBe(409);
		expect(b.json()).toMatchObject({
			code: 'LEASE_HELD',
			detail: { holderSessionId: 'sess-a' },
			retryable: true,
		});
		expect((await acquire('sess-a')).json().leaseId).toBe(lease.leaseId);
		const hb = await app.inject({
			method: 'POST',
			url: `/api/projects/${id}/lease/${lease.leaseId}/heartbeat`,
			headers: H,
		});
		expect(hb.statusCode).toBe(200);
		expect(
			(await app.inject({ method: 'POST', url: `/api/projects/${id}/lease/nope/heartbeat`, headers: H }))
				.statusCode,
		).toBe(404);
		expect(
			(
				await app.inject({ method: 'DELETE', url: `/api/projects/${id}/lease/${lease.leaseId}`, headers: H })
			).json(),
		).toEqual({
			ok: true,
		});
		expect((await acquire('sess-b')).statusCode).toBe(200);
		expect(
			(
				await app.inject({
					method: 'POST',
					url: '/api/projects/prj_ZZZZZZZZZZZZZZZZ/lease',
					headers: JSON_H,
					payload: { sessionId: 'x' },
				})
			).statusCode,
		).toBe(404);

		let t = 0;
		const lm = new LeaseManager(() => t);
		lm.acquire('p', 's1');
		t = 29_000;
		expect(() => lm.acquire('p', 's2')).toThrow(/Another session/);
		t = 31_000;
		expect(lm.acquire('p', 's2').sessionId).toBe('s2');
	});

	it('takeOver revokes the other holder (WP-2E "Take over editing")', async () => {
		const id = await create('Take over');
		const acquire = (sessionId: string, takeOver?: boolean) =>
			app.inject({
				method: 'POST',
				url: `/api/projects/${id}/lease`,
				headers: JSON_H,
				payload: { sessionId, ...(takeOver === undefined ? {} : { takeOver }) },
			});
		const a = (await acquire('sess-a')).json();
		expect((await acquire('sess-b')).statusCode).toBe(409);
		const b = await acquire('sess-b', true);
		expect(b.statusCode).toBe(200);
		expect(b.json()).toMatchObject({ sessionId: 'sess-b' });
		expect(b.json().leaseId).not.toBe(a.leaseId);
		const oldHb = await app.inject({
			method: 'POST',
			url: `/api/projects/${id}/lease/${a.leaseId}/heartbeat`,
			headers: H,
		});
		expect(oldHb.statusCode).toBe(404);
		expect(oldHb.json()).toMatchObject({ code: 'LEASE_NOT_FOUND' });
		expect((await acquire('sess-b', true)).json().leaseId).toBe(b.json().leaseId);
	});
});

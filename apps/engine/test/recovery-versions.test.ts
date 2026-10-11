// Crash-recovery journal (S01:PER-021, AC-18), saved versions (read / restore) and the schema backup kept by the
// first save over a migrated project (S01:MIG-004). ARCHITECTURE D-39, docs/project-files.md.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appdirPaths } from '@jasper/config';
import { EngineClient } from '@jasper/engine-client';
import { CURRENT_SCHEMA_VERSION, createRandomIdSource, defaultRegistries, migrate } from '@jasper/project';
import { attachPersistence, EditorSession, EngineProjectStore, reopenSession } from '@jasper/session';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaseManager } from '../src/projects/leases.ts';
import { RecoveryJournal } from '../src/projects/recovery.ts';
import { ProjectStoreFs, schemaBackupName } from '../src/projects/store.ts';
import { closeApps, H, JSON_H, makeApp, type TestApp, tempAppdir } from './helpers.ts';

const FIXTURE_V4 = join(__dirname, '../../../packages/project/test/fixtures/schema-v4.jasper');

function storeOn(appdir = tempAppdir()) {
	let now = Date.parse('2026-10-07T10:00:00Z');
	const leases = new LeaseManager(() => now);
	const paths = appdirPaths(appdir);
	const store = new ProjectStoreFs({ paths, leases, appVersion: '0.1.0', now: () => new Date(now) });
	return { store, leases, paths, tick: (ms: number) => (now += ms) };
}

/** A project whose file on disk is the schema v4 fixture (as an older JasperEditor saved it). */
async function v4Project(s: ReturnType<typeof storeOn>) {
	const id = await s.store.create({ name: 'Old', preset: 'hd-1080p-30' });
	const env = JSON.parse(readFileSync(FIXTURE_V4, 'utf8'));
	env.document.projectId = id;
	writeFileSync(s.paths.projectFile(id), JSON.stringify(env));
	return { id, env };
}

describe('project file errors', () => {
	it('reports corrupt envelopes without changing the file or treating the project as missing', async () => {
		const s = storeOn();
		const id = await s.store.create({ name: 'Preserved', preset: 'hd-1080p-30' });
		await fc.assert(
			fc.asyncProperty(fc.jsonValue(), async (invalid) => {
				const text = JSON.stringify({ malformed: invalid });
				writeFileSync(s.paths.projectFile(id), text);
				await expect(s.store.get(id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
				await expect(s.store.revision(id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
				expect(readFileSync(s.paths.projectFile(id), 'utf8')).toBe(text);
			}),
			{ numRuns: 20 },
		);
		writeFileSync(s.paths.projectFile(id), '{');
		await expect(s.store.get(id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
		expect(readFileSync(s.paths.projectFile(id), 'utf8')).toBe('{');
	});

	it('propagates project directory and file read errors', async () => {
		const s = storeOn();
		writeFileSync(s.paths.projectsDir, 'not a directory');
		await expect(s.store.list()).rejects.toMatchObject({ code: 'ENOTDIR' });
		await expect(s.store.get('prj_0000000000000001')).rejects.toMatchObject({ code: 'ENOTDIR' });
		await expect(s.store.revision('prj_0000000000000001')).rejects.toMatchObject({ code: 'ENOTDIR' });
	});
});

describe('schema backup on the first save over a migrated project (S01:MIG-004)', () => {
	it('keeps project (schema vN backup).jasper once, lists it and restores it as a copy', async () => {
		const s = storeOn();
		const { id, env } = await v4Project(s);
		const migrated = migrate(env).document as unknown as Record<string, unknown>;
		const before = readFileSync(s.paths.projectFile(id), 'utf8');
		const save = (rev: number) =>
			s.store.save(
				id,
				{ ...env, schemaVersion: CURRENT_SCHEMA_VERSION, revision: rev + 1, document: migrated },
				rev,
			);
		await save(env.revision);
		const backup = join(s.paths.projectDir(id), schemaBackupName(4));
		expect(readFileSync(backup, 'utf8')).toBe(before);
		s.tick(10 * 60_000);
		await save(env.revision + 1); // later saves never touch the backup
		expect(readFileSync(backup, 'utf8')).toBe(before);

		const versions = await s.store.versions(id);
		expect(versions.find((v) => v.kind === 'schema-backup')).toMatchObject({
			versionId: 'schema-v4-backup',
			schemaVersion: 4,
		});
		const got = await s.store.version(id, 'schema-v4-backup');
		expect(got.envelope.document.schemaVersion).toBe(4);

		const copy = await s.store.restoreVersion(id, 'schema-v4-backup', {
			mode: 'copy',
			name: 'For the old build',
		});
		expect(copy.projectId).not.toBe(id);
		const opened = await s.store.get(copy.projectId);
		expect(opened.envelope.document).toMatchObject({ projectId: copy.projectId, name: 'For the old build' });
		expect(opened.envelope.document.schemaVersion).toBe(4);
	});

	it('does not back up a save at the same schema', async () => {
		const s = storeOn();
		const id = await s.store.create({ name: 'New', preset: 'hd-1080p-30' });
		const { envelope } = await s.store.get(id);
		await s.store.save(id, { ...envelope, revision: 1 }, 0);
		expect((await s.store.versions(id)).map((v) => v.kind)).toEqual(['auto']);
	});
});

describe('saved versions: read and restore (S01:PER-001/020)', () => {
	it('restores in place, keeping the replaced state, and only for the lease holder', async () => {
		const s = storeOn();
		const id = await s.store.create({ name: 'First', preset: 'hd-1080p-30' });
		const { envelope } = await s.store.get(id);
		await s.store.save(
			id,
			{ ...envelope, revision: 1, document: { ...envelope.document, name: 'Second' } },
			0,
		);
		const [first] = await s.store.versions(id);
		expect(first).toMatchObject({ kind: 'auto', revision: 0 });

		const lease = s.leases.acquire(id, 'ses_editor');
		await expect(s.store.restoreVersion(id, first!.versionId, { mode: 'replace' })).rejects.toMatchObject({
			code: 'LEASE_HELD',
		});
		const r = await s.store.restoreVersion(id, first!.versionId, { mode: 'replace', leaseId: lease.leaseId });
		expect(r).toMatchObject({ projectId: id, revision: 2 });
		const now = await s.store.get(id);
		expect(now.revision).toBe(2);
		expect(now.envelope.document.name).toBe('First');
		const kept = await s.store.version(id, r.keptAs!);
		expect(kept.version.kind).toBe('before-restore');
		expect(kept.envelope.document.name).toBe('Second');
	});

	it('refuses unknown and path-like version ids', async () => {
		const s = storeOn();
		const id = await s.store.create({ name: 'X', preset: 'hd-1080p-30' });
		for (const v of ['nope', '../project', '..%2Fproject', 'schema-vX-backup'])
			await expect(s.store.version(id, v)).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('crash-recovery journal over HTTP (S01:PER-021, AC-18)', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await makeApp();
	});
	afterAll(closeApps);

	const create = async (name: string) =>
		(
			await app.inject({
				method: 'POST',
				url: '/api/projects',
				headers: JSON_H,
				payload: { name, preset: 'hd-1080p-30' },
			})
		).json().projectId as string;
	const get = (url: string) => app.inject({ method: 'GET', url, headers: H });
	const lease = async (id: string, sessionId: string) =>
		(
			await app.inject({
				method: 'POST',
				url: `/api/projects/${id}/lease`,
				headers: JSON_H,
				payload: { sessionId },
			})
		).json();

	it('is held while the session holds the lease, then offered, read and discarded', async () => {
		const id = await create('Crashy');
		const { envelope } = (await get(`/api/projects/${id}`)).json();
		const l = await lease(id, 'ses_a');
		const edited = { ...envelope, document: { ...envelope.document, name: 'Crashy (edited)' } };
		const put = (body: unknown, sessionId = 'ses_a') =>
			app.inject({
				method: 'PUT',
				url: `/api/projects/${id}/recovery/${sessionId}`,
				headers: JSON_H,
				payload: body as object,
			});
		const body = {
			leaseId: l.leaseId,
			baseRevision: 0,
			revision: 3,
			changes: ['Rename', 'Move Clip'],
			envelope: edited,
		};

		expect((await put(body)).json()).toMatchObject({ ok: true });
		// someone else's lease id, or a session that does not hold the lease, cannot write
		expect((await put({ ...body, leaseId: 'lse_nope' })).statusCode).toBe(404);
		expect((await put(body, 'ses_b')).statusCode).toBe(409);
		expect((await put(body, 'bad%21id')).statusCode).toBe(400);

		// held: not offered, not readable, not deletable by others
		expect((await get(`/api/projects/${id}/recovery`)).json().candidates).toEqual([]);
		expect((await get(`/api/projects/${id}/recovery/ses_a`)).statusCode).toBe(409);
		expect(
			(await app.inject({ method: 'DELETE', url: `/api/projects/${id}/recovery/ses_a`, headers: H }))
				.statusCode,
		).toBe(409);

		// the editor dies: its lease is released (or expires) without the journal being cleared
		await app.inject({ method: 'DELETE', url: `/api/projects/${id}/lease/${l.leaseId}`, headers: H });
		const [c] = (await get(`/api/projects/${id}/recovery`)).json().candidates;
		expect(c).toMatchObject({
			sessionId: 'ses_a',
			projectName: 'Crashy (edited)',
			baseRevision: 0,
			revision: 3,
			projectRevision: 0,
			changes: ['Rename', 'Move Clip'],
			changeCount: 2,
		});
		const read = (await get(`/api/projects/${id}/recovery/ses_a`)).json();
		expect(read.envelope.document.name).toBe('Crashy (edited)');

		expect(
			(await app.inject({ method: 'DELETE', url: `/api/projects/${id}/recovery/ses_a`, headers: H })).json(),
		).toEqual({ ok: true });
		expect((await get(`/api/projects/${id}/recovery`)).json().candidates).toEqual([]);
		expect((await get(`/api/projects/${id}/recovery/ses_a`)).statusCode).toBe(404);
	});

	it('the session clears its own journal with its lease; a journal equal to the saved project is stale', async () => {
		const id = await create('Saved');
		const { envelope } = (await get(`/api/projects/${id}`)).json();
		const l = await lease(id, 'ses_c');
		const put = (env: unknown) =>
			app.inject({
				method: 'PUT',
				url: `/api/projects/${id}/recovery/ses_c`,
				headers: JSON_H,
				payload: { leaseId: l.leaseId, baseRevision: 0, revision: 1, changes: ['x'], envelope: env },
			});
		await put({ ...envelope, document: { ...envelope.document, name: 'Changed' } });
		const own = await app.inject({
			method: 'DELETE',
			url: `/api/projects/${id}/recovery/ses_c?leaseId=${l.leaseId}`,
			headers: H,
		});
		expect(own.json()).toEqual({ ok: true });
		expect(existsSync(join(app.appdir, 'projects', id, 'recovery', 'ses_c'))).toBe(false);

		// the autosave caught up before the crash: nothing to offer, and the journal goes away
		await put(envelope);
		await app.inject({ method: 'DELETE', url: `/api/projects/${id}/lease/${l.leaseId}`, headers: H });
		expect((await get(`/api/projects/${id}/recovery`)).json().candidates).toEqual([]);
		expect(existsSync(join(app.appdir, 'projects', id, 'recovery', 'ses_c'))).toBe(false);
	});
});

describe('session journal and versions through EngineProjectStore (real routes)', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await makeApp();
	});
	afterAll(closeApps);

	function store() {
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
				return new Response(r.statusCode === 204 ? null : new Uint8Array(r.rawPayload), {
					status: r.statusCode,
					headers: r.headers as Record<string, string>,
				});
			}) as typeof fetch,
		});
		return new EngineProjectStore(client);
	}
	const ctx = {
		ids: createRandomIdSource(),
		now: () => new Date().toISOString(),
		registries: defaultRegistries(),
	};
	const solid = (at: number) => ({
		type: 'clip.addSolid' as const,
		at,
		duration: 10,
		track: 'V1',
		color: [1, 0, 0, 1] as [number, number, number, number],
	});

	it('journals unsaved edits, offers them after the editor dies, and restores saved versions', async () => {
		const st = store();
		const projectId = await st.create({ name: 'Journal', preset: 'hd-1080p-30' });
		const s1 = await EditorSession.open({ store: st, projectId, ctx, sessionId: 'ses_one' });
		const p1 = attachPersistence(s1, {
			window: null,
			document: null,
			recovery: { idleMs: 10, maxIntervalMs: 50 },
		});
		s1.apply({ label: 'Add Solid', origin: 'user', commands: [solid(0)] });
		await p1.journal!.flush();
		expect(p1.journal!.getStatus()).toMatchObject({ written: true, error: null });
		// the editor dies before autosave ran: stop its timers, drop its lease
		p1.autosaver.dispose();
		p1.journal!.dispose();
		const lease = s1.getState().lease.leaseId!;
		await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/lease/${lease}`, headers: H });

		const s2 = await EditorSession.open({ store: st, projectId, ctx, sessionId: 'ses_two' });
		const p2 = attachPersistence(s2, { window: null, document: null });
		const [c] = await st.listRecovery(projectId);
		expect(c).toMatchObject({ sessionId: 'ses_one', changes: ['Add Solid'], projectName: 'Journal' });
		const snap = await st.readRecovery(projectId, 'ses_one');
		expect(s2.replaceDocument(snap.document, 'Recover Unsaved Changes').ok).toBe(true);
		await p2.flush();
		await st.discardRecovery(projectId, 'ses_one');
		expect(await st.listRecovery(projectId)).toEqual([]);
		expect((await st.open(projectId)).revision).toBe(1);

		// restore the first version in place from the open editor, then reopen it
		const versions = await st.listVersions(projectId);
		expect(versions[0]).toMatchObject({ kind: 'auto', revision: 0 });
		await p2.flush();
		const rev = await st.revertToVersion(projectId, versions[0]!.versionId, s2.getState().lease.leaseId!);
		expect(rev).toBe(2);
		const s3 = await reopenSession(s2);
		expect(Object.keys(Object.values(s3.getCommitted().sequences)[0]!.clips)).toEqual([]);
		// and as a copy (S01:PER-001 restoreVersion)
		const copyId = await st.restoreVersion(projectId, versions[0]!.versionId);
		expect((await st.list()).some((p) => p.projectId === copyId)).toBe(true);
		await s3.close();
	});
});

describe('journal locks across engine processes', () => {
	async function journalled() {
		const s = storeOn();
		const id = await s.store.create({ name: 'P', preset: 'hd-1080p-30' });
		const { envelope } = await s.store.get(id);
		const saved = async (pid: string) => {
			const g = await s.store.get(pid);
			return { revision: g.revision, document: g.envelope.document };
		};
		const j = new RecoveryJournal({ paths: s.paths, leases: s.leases, saved });
		const l = s.leases.acquire(id, 'ses_x');
		await j.write(id, 'ses_x', {
			leaseId: l.leaseId,
			baseRevision: 0,
			revision: 1,
			changes: ['Edit'],
			envelope: { ...envelope, document: { ...envelope.document, name: 'Unsaved' } },
		});
		return { s, id, saved };
	}

	it('preserves unsaved snapshots when journal metadata is missing or malformed', async () => {
		const { s, id, saved } = await journalled();
		const dir = join(s.paths.projectDir(id), 'recovery', 'ses_x');
		const metadata = join(dir, 'session.json');
		const snapshot = join(dir, 'snapshot.jasper');
		const before = readFileSync(snapshot, 'utf8');
		const restarted = new RecoveryJournal({ paths: s.paths, leases: new LeaseManager(), saved });
		unlinkSync(metadata);
		await expect(restarted.list(id)).rejects.toMatchObject({
			code: 'VALIDATION_FAILED',
			status: 422,
			detail: { projectId: id, sessionId: 'ses_x' },
		});
		expect(readFileSync(snapshot, 'utf8')).toBe(before);
		await fc.assert(
			fc.asyncProperty(fc.jsonValue(), async (invalid) => {
				writeFileSync(metadata, JSON.stringify({ malformed: invalid }));
				await expect(restarted.list(id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
				expect(readFileSync(snapshot, 'utf8')).toBe(before);
			}),
			{ numRuns: 20 },
		);
	});

	it('an engine restart (new instance, no leases) offers the journal of the dead session', async () => {
		const { s, id, saved } = await journalled();
		const restarted = new RecoveryJournal({ paths: s.paths, leases: new LeaseManager(), saved });
		expect((await restarted.list(id)).map((c) => c.sessionId)).toEqual(['ses_x']);
	});

	it('a journal written by another live engine process is never touched', async () => {
		const { s, id, saved } = await journalled();
		const lockFile = join(s.paths.projectDir(id), 'recovery', 'ses_x', 'lock');
		writeFileSync(lockFile, JSON.stringify({ pid: process.pid + 1, instance: 'eng_other' }));
		const other = (alive: boolean) =>
			new RecoveryJournal({ paths: s.paths, leases: new LeaseManager(), saved, processAlive: () => alive });
		expect(await other(true).list(id)).toEqual([]);
		await expect(other(true).remove(id, 'ses_x')).rejects.toMatchObject({ code: 'LEASE_HELD' });
		expect((await other(false).list(id)).map((c) => c.sessionId)).toEqual(['ses_x']);
	});
});

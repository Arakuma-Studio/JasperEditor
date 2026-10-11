import { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, defaultRegistries, type ProjectDocument } from '@jasper/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	attachPersistence,
	EditorSession,
	EngineProjectStore,
	LeaseHeldError,
	persistenceFor,
	readOnlyReason,
	takeOverSession,
} from '../../src/index.ts';
import { FakeEngine } from './fake-engine.ts';

const ctx = () => ({
	ids: createCounterIdSource(1),
	now: () => '2026-09-30T10:00:00.000Z',
	registries: defaultRegistries(),
});
const solid = (at: number) => ({
	type: 'clip.addSolid' as const,
	at,
	duration: 30,
	track: 'V1',
	color: [1, 0, 0, 1] as [number, number, number, number],
});
const noLifecycle = { window: null, document: null } as const;

function setup() {
	const engine = new FakeEngine();
	const projectId = engine.seed('Film');
	const store = () => new EngineProjectStore(engine.client());
	const open = async (sessionId: string, s = store()) => {
		const pending = EditorSession.open({ store: s, projectId, ctx: ctx(), sessionId });
		if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(3000);
		return pending;
	};
	return { engine, projectId, store, open };
}

describe('EngineProjectStore (S01:PER-001 over the engine routes)', () => {
	it('preserves recovery warnings alongside candidate listings', async () => {
		const { engine, projectId } = setup();
		const client = engine.client();
		const result = {
			candidates: [],
			warnings: [{ sessionId: 'damaged', code: 'INVALID_JSON', message: 'Unreadable recovery journal' }],
		};
		vi.spyOn(client, 'listRecovery').mockResolvedValue(result);
		const store = new EngineProjectStore(client);
		expect(await store.listRecovery(projectId)).toEqual(result);
	});

	it('saves with If-Match: <baseRevision> and returns the new revision', async () => {
		const { engine, store, projectId } = setup();
		const s = store();
		const { document } = await s.open(projectId);
		const r = await s.save(projectId, { ...document, name: 'Renamed' }, { revision: 3, baseRevision: 0 });
		expect(r).toEqual({ ok: true, revision: 3 });
		const put = engine.requests.find((q) => q.method === 'PUT' && q.path === `/api/projects/${projectId}`)!;
		expect(put.headers['if-match']).toBe('0');
		expect((put.body as { format: string; revision: number }).format).toBe('jasper-project');
		expect((put.body as { revision: number }).revision).toBe(3);
		expect((engine.projects.get(projectId)!.envelope.document as ProjectDocument).name).toBe('Renamed');
	});

	it('turns a 409 REVISION_CONFLICT into a conflict result with the server revision', async () => {
		const { engine, store, projectId } = setup();
		const s = store();
		const { document } = await s.open(projectId);
		engine.projects.get(projectId)!.revision = 7;
		const r = await s.save(projectId, document, { revision: 1, baseRevision: 0 });
		expect(r).toEqual({ ok: false, conflict: true, revision: 7 });
	});

	it('duplicates, exports and imports projects', async () => {
		const { engine, store, projectId } = setup();
		const s = store();
		const copyId = await s.duplicate(projectId, 'Film copy');
		expect(copyId).not.toBe(projectId);
		const copy = await s.open(copyId);
		expect(copy.document.name).toBe('Film copy');
		expect(copy.document.projectId).toBe(copyId);
		const blob = await s.exportFile(projectId);
		const env = JSON.parse(await blob.text());
		expect(env.format).toBe('jasper-project');
		const importedId = await s.importFile(blob);
		expect((await s.open(importedId)).document.name).toBe('Film');
		expect(engine.projects.size).toBe(3);
		await expect(s.importFile(new Blob(['not json']))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
	});
});

describe('leases (S01:PER-040)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('a second opener is read-only (reason "lease"); release on close frees the project', async () => {
		const { open } = setup();
		const a = await open('a');
		expect(a.getState().lease.status).toBe('held');
		const b = await open('b');
		expect(b.getState().readOnly).toBe(true);
		expect(b.getState().lease).toMatchObject({ status: 'read-only', holder: 'a' });
		expect(readOnlyReason(b.getState())).toBe('lease');
		await a.close();
		await b.close();
		const c = await open('c');
		expect(c.getState().lease.status).toBe('held');
		await c.close();
	});

	it('keepalive lease release carries the bearer token in token-only auth mode (WP-3I)', async () => {
		const { engine, projectId } = setup();
		const page = new EventTarget();
		const client = new EngineClient({ fetch: engine.fetch, token: 'tok123' });
		vi.stubGlobal('window', page);
		vi.stubGlobal('fetch', engine.fetch);
		const s = new EngineProjectStore(client);
		const a = await EditorSession.open({ store: s, projectId, ctx: ctx(), sessionId: 'a' });
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		const del = engine.requests.find((r) => r.method === 'DELETE' && r.path.includes('/lease/'))!;
		expect(del.headers.authorization).toBe('Bearer tok123');
		expect(del.keepalive).toBe(true);
		expect(engine.leases.has(projectId)).toBe(false);
		await a.close();
	});

	/** A tab's sessionStorage (survives a reload of the tab, not shared with other tabs). */
	function tabStorage(): Storage {
		const m = new Map<string, string>();
		return {
			get length() {
				return m.size;
			},
			clear: () => m.clear(),
			getItem: (k) => m.get(k) ?? null,
			key: (i) => [...m.keys()][i] ?? null,
			removeItem: (k) => void m.delete(k),
			setItem: (k, v) => void m.set(k, String(v)),
		};
	}

	it('a reload does not open the project read-only while the old page’s keepalive release is in flight', async () => {
		const { engine, projectId } = setup();
		const page = new EventTarget();
		vi.stubGlobal('window', page);
		vi.stubGlobal('sessionStorage', tabStorage());
		// The keepalive DELETE reaches the engine 1 s late (browser busy unloading, engine under load).
		const late = (url: string, init: RequestInit = {}) =>
			init.method === 'DELETE'
				? new Promise<Response>((resolve) => setTimeout(() => resolve(engine.fetch(url, init)), 1000))
				: engine.fetch(url, init);
		vi.stubGlobal('fetch', late);
		const a = await EditorSession.open({
			store: new EngineProjectStore(engine.client()),
			projectId,
			ctx: ctx(),
			sessionId: 'a',
		});
		expect(a.getState().lease.status).toBe('held');
		page.dispatchEvent(new Event('pagehide')); // reload: the old page goes away
		const pending = EditorSession.open({
			store: new EngineProjectStore(engine.client()),
			projectId,
			ctx: ctx(),
			sessionId: 'a2',
		});
		await vi.advanceTimersByTimeAsync(3000);
		const a2 = await pending;
		expect(a2.getState().readOnly).toBe(false);
		expect(a2.getState().lease.status).toBe('held');
		expect(engine.leases.get(projectId)?.sessionId).toBe('a2');
		await a2.close();
	});

	it('a duplicated tab (copied sessionStorage) still opens read-only while the original holds the lease', async () => {
		const { engine, projectId, open } = setup();
		const storage = tabStorage();
		vi.stubGlobal('sessionStorage', storage);
		const a = await open('a');
		// The duplicate gets a copy of the tab's storage; `a` stays open and keeps heartbeating.
		const b = await open('b');
		expect(b.getState().readOnly).toBe(true);
		expect(b.getState().lease).toMatchObject({ status: 'read-only', holder: 'a' });
		await a.close();
		await b.close();
		// A confirmed release forgets the session: nothing left to wait for after a reload.
		expect(JSON.parse(storage.getItem('jasper:tab-lease-sessions') ?? '[]')).not.toContain('a');
		expect(engine.leases.has(projectId)).toBe(false);
	});

	it('heartbeats every lease.heartbeatMs and re-acquires transparently after an engine restart', async () => {
		const { engine, open, projectId } = setup();
		const a = await open('a');
		await vi.advanceTimersByTimeAsync(10_000);
		const beats = engine.requests.filter((r) => r.path.endsWith('/heartbeat'));
		expect(beats.length).toBe(1);
		engine.leases.clear(); // engine restart: in-memory leases are gone
		await vi.advanceTimersByTimeAsync(10_000);
		expect(engine.leases.get(projectId)?.sessionId).toBe('a');
		expect(a.getState().lease.status).toBe('held');
		// A network blip does not mark the lease lost.
		engine.failures.push({ match: /heartbeat/, status: 0, network: true });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(a.getState().lease.status).toBe('held');
		// Subsequent heartbeats use the re-acquired lease id.
		await vi.advanceTimersByTimeAsync(10_000);
		const last = engine.requests.filter((r) => r.path.endsWith('/heartbeat')).at(-1)!;
		expect(last.path).toContain(engine.leases.get(projectId)!.leaseId);
		await a.close();
		expect(engine.leases.has(projectId)).toBe(false);
	});

	it('"Take over" gives the lease to the read-only session; the old holder becomes lost and stops saving', async () => {
		const { engine, open, projectId } = setup();
		const a = await open('a');
		const pa = attachPersistence(a, noLifecycle);
		const b = await open('b');
		expect(b.getState().readOnly).toBe(true);

		const b2 = await takeOverSession(b, { sessionId: 'b2' });
		expect(b.getState().lease.status).toBe('read-only');
		expect(b2.getState().readOnly).toBe(false);
		expect(b2.getState().lease.status).toBe('held');
		expect(engine.leases.get(projectId)?.sessionId).toBe('b2');

		// A's next heartbeat finds its lease gone and cannot re-acquire it.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(a.getState().lease.status).toBe('lost');
		expect(pa.autosaver.getStatus().paused).toBe('lease-lost');
		const puts = () => engine.requests.filter((r) => r.method === 'PUT' && r.path.endsWith(projectId)).length;
		const before = puts();
		a.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(5000);
		expect(puts()).toBe(before);

		// B2 edits and autosaves normally.
		attachPersistence(b2, noLifecycle);
		b2.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(1600);
		expect(puts()).toBe(before + 1);
		await persistenceFor(b2)!.dispose();
		await pa.dispose();
		await a.close();
		await b2.close();
	});

	it('refuses take over when the engine does not grant it', async () => {
		const { engine, open } = setup();
		const a = await open('a');
		const b = await open('b');
		engine.failures.push({
			match: /\/lease$/,
			status: 409,
			body: {
				code: 'LEASE_HELD',
				message: 'held',
				retryable: true,
				detail: { holderSessionId: 'a', expiresAt: '2026-09-30T10:00:30.000Z' },
			},
		});
		const err = await takeOverSession(b).catch((e) => e);
		expect(err).toBeInstanceOf(LeaseHeldError);
		expect((err as LeaseHeldError).expiresAt).toBe('2026-09-30T10:00:30.000Z');
		await a.close();
		await b.close();
	});

	it('a document with a newer schemaVersion opens read-only without taking the lease (MIG-003)', async () => {
		const { engine, open, projectId } = setup();
		const p = engine.projects.get(projectId)!;
		p.envelope = {
			...p.envelope,
			schemaVersion: 99,
			document: { ...(p.envelope.document as object), schemaVersion: 99 },
		};
		const s = await open('a');
		expect(s.getState().readOnly).toBe(true);
		expect(readOnlyReason(s.getState())).toBe('schema');
		expect(engine.leases.size).toBe(0);
		await s.close();
	});
});

describe('autosave through the engine (S01:PER-020, PER-025)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('saves 1.5 s after a commit; a 409 pauses autosave until Overwrite', async () => {
		const { engine, open, projectId } = setup();
		const s = await open('a');
		const conflicts: number[] = [];
		const p = attachPersistence(s, { ...noLifecycle, onConflict: (r) => conflicts.push(r) });
		const puts = () => engine.requests.filter((r) => r.method === 'PUT' && r.path.endsWith(projectId));

		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		expect(s.getState().dirty).toBe(true);
		await vi.advanceTimersByTimeAsync(1400);
		expect(puts().length).toBe(0);
		await vi.advanceTimersByTimeAsync(200);
		expect(puts().length).toBe(1);
		expect(puts()[0]!.headers['if-match']).toBe('0');
		expect(s.getState().dirty).toBe(false);

		// Another writer saved in between.
		engine.projects.get(projectId)!.revision = 40;
		s.apply({ label: 'Add', origin: 'user', commands: [solid(100)] });
		await vi.advanceTimersByTimeAsync(1600);
		expect(conflicts).toEqual([40]);
		expect(p.autosaver.getStatus()).toMatchObject({ conflict: { serverRevision: 40 }, paused: 'conflict' });
		s.apply({ label: 'Add', origin: 'user', commands: [solid(200)] });
		await vi.advanceTimersByTimeAsync(20_000);
		expect(puts().length).toBe(2);
		expect(s.getState().dirty).toBe(true);

		await p.autosaver.overwrite();
		expect(puts().length).toBe(3);
		expect(puts()[2]!.headers['if-match']).toBe('40');
		expect(p.autosaver.getStatus().paused).toBeNull();
		expect(s.getState().dirty).toBe(false);
		await p.dispose();
		await s.close();
	});
});

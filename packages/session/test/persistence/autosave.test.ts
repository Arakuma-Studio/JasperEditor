import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPersistence, createAutosaver, EditorSession, MemoryProjectStore } from '../../src/index.ts';

async function setup(opts: { readOnly?: boolean } = {}) {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => '2026-09-30T10:00:00.000Z' });
	const doc = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	store.put(doc);
	const ctx = { ids, now: () => '2026-09-30T10:00:00.000Z', registries: defaultRegistries() };
	const session = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx,
		sessionId: 's1',
		readOnly: opts.readOnly,
	});
	return { store, session };
}

const solid = (at: number) => ({
	type: 'clip.addSolid' as const,
	at,
	duration: 10,
	track: 'V1',
	color: [0, 1, 0, 1] as [number, number, number, number],
});
const firstClip = (doc: ProjectDocument) => Object.values(Object.values(doc.sequences)[0]!.clips)[0]!;

describe('autosave timing (S01:PER-020)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('saves 1.5 s after the last commit and restarts the idle timer on each commit', async () => {
		const { store, session } = await setup();
		const a = createAutosaver(session, store);
		session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(1000);
		session.apply({ label: 'Add', origin: 'user', commands: [solid(100)] });
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.saveCount).toBe(0);
		await vi.advanceTimersByTimeAsync(600);
		expect(store.saveCount).toBe(1);
		expect(a.lastSavedRevision).toBe(session.revision);
		expect(session.getState().dirty).toBe(false);
		a.dispose();
	});

	it('saves at least every 10 s during continuous editing', async () => {
		const { store, session } = await setup();
		const a = createAutosaver(session, store);
		for (let i = 0; i < 12; i++) {
			session.apply({ label: 'Add', origin: 'user', commands: [solid(i * 20)] });
			await vi.advanceTimersByTimeAsync(1000);
		}
		expect(store.saveCount).toBe(1);
		a.dispose();
	});

	it('never saves while a gesture is in progress, even past 10 s; saves after the commit (AC-13)', async () => {
		const { store, session } = await setup();
		const a = createAutosaver(session, store);
		session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const id = firstClip(session.getCommitted()).id;
		await vi.advanceTimersByTimeAsync(500);
		const g = session.beginGesture('Move Clip');
		for (let i = 1; i <= 60; i++) {
			g.update([{ type: 'clip.move', clipIds: [id], deltaFrames: i }]);
			await vi.advanceTimersByTimeAsync(250);
		}
		expect(store.saveCount).toBe(0);
		g.commit();
		await vi.advanceTimersByTimeAsync(1600);
		expect(store.saveCount).toBe(1);
		const saved = await store.open(session.projectId);
		expect(firstClip(saved.document).start).toBe(60);
		a.dispose();
	});

	it('flush saves immediately, waits for an in-flight save, and saves the committed doc mid-gesture', async () => {
		const { store, session } = await setup();
		const a = createAutosaver(session, store);
		session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const p1 = a.flush();
		session.apply({ label: 'Add', origin: 'user', commands: [solid(50)] });
		await Promise.all([p1, a.flush()]);
		expect(store.saveCount).toBe(2);
		expect(a.lastSavedRevision).toBe(session.revision);

		const id = firstClip(session.getCommitted()).id;
		const g = session.beginGesture('Move Clip');
		g.update([{ type: 'clip.move', clipIds: [id], deltaFrames: 5 }]);
		session.apply({ label: 'Add', origin: 'user', commands: [solid(300)] });
		await a.flush();
		expect(store.saveCount).toBe(3);
		expect(firstClip((await store.open(session.projectId)).document).start).toBe(0);
		g.cancel();
		a.dispose();
	});

	it('does nothing in read-only sessions', async () => {
		const { store, session } = await setup({ readOnly: true });
		const a = createAutosaver(session, store);
		expect(a.getStatus().paused).toBe('read-only');
		await a.flush();
		expect(store.saveCount).toBe(0);
		a.dispose();
	});

	it('debounces view-state saves by 1 s', async () => {
		const { store, session } = await setup();
		const a = createAutosaver(session, store);
		const seqId = session.getState().activeSequenceId!;
		for (let i = 0; i < 5; i++) {
			session.setView(seqId, { pxPerFrame: 2 + i });
			await vi.advanceTimersByTimeAsync(300);
		}
		expect(store.viewSaveCount).toBe(0);
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.viewSaveCount).toBe(1);
		a.dispose();
	});
});

describe('page lifecycle (S01:PER-022)', () => {
	it('re-attaching right after dispose (StrictMode remount) yields a working controller', async () => {
		const { store, session } = await setup();
		const first = attachPersistence(session, { window: null, document: null });
		const disposing = first.dispose();
		const second = attachPersistence(session, { window: null, document: null });
		expect(second).not.toBe(first);
		await disposing;
		session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(1600);
		expect(store.saveCount).toBe(1);
		await second.dispose();
	});

	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('flushes on visibilitychange → hidden and on pagehide; guards beforeunload while dirty', async () => {
		const { store, session } = await setup();
		const win = new EventTarget();
		const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
		const p = attachPersistence(session, { window: win, document: doc });

		session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const ev = new Event('beforeunload', { cancelable: true });
		win.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(store.saveCount).toBe(1);

		session.apply({ label: 'Add', origin: 'user', commands: [solid(40)] });
		doc.visibilityState = 'hidden';
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(store.saveCount).toBe(2);

		session.apply({ label: 'Add', origin: 'user', commands: [solid(80)] });
		win.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		expect(store.saveCount).toBe(3);

		const clean = new Event('beforeunload', { cancelable: true });
		win.dispatchEvent(clean);
		expect(clean.defaultPrevented).toBe(false);

		await p.dispose();
		session.apply({ label: 'Add', origin: 'user', commands: [solid(120)] });
		win.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(5000);
		expect(store.saveCount).toBe(3);
	});
});

import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPersistence, EditorSession, MemoryProjectStore, reopenSession } from '../../src/index.ts';

const noLifecycle = { window: null, document: null } as const;

async function setup() {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => new Date().toISOString() });
	const doc = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	store.put(doc);
	const ctx = { ids, now: () => '2026-10-07T10:00:00.000Z', registries: defaultRegistries() };
	const open = (sessionId: string) => EditorSession.open({ store, projectId: doc.projectId, ctx, sessionId });
	return { store, open, projectId: doc.projectId };
}

const solid = (at: number) => ({
	type: 'clip.addSolid' as const,
	at,
	duration: 10,
	track: 'V1',
	color: [0, 1, 0, 1] as [number, number, number, number],
});
const clipCount = (d: ProjectDocument) => Object.values(Object.values(d.sequences)[0]!.clips).length;

describe('crash-recovery journal (S01:PER-021, AC-18)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('journals about 1 s after an edit, and at most every 5 s while edits keep coming', async () => {
		const { store, open, projectId } = await setup();
		vi.spyOn(store, 'save').mockRejectedValue(new Error('disk full')); // autosave keeps failing
		const write = vi.spyOn(store, 'writeRecovery');
		const s = await open('s1');
		const p = attachPersistence(s, { ...noLifecycle, onError: () => undefined });
		s.apply({ label: 'Add Solid', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(900);
		expect(write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(200);
		expect(write).toHaveBeenCalledTimes(1);
		expect(store.journalOf(projectId, 's1')?.changes).toEqual(['Add Solid']);

		// continuous edits every 500 ms: still written within 5 s of the first unjournalled change
		for (let i = 1; i <= 12; i++) {
			s.apply({ label: `Add ${i}`, origin: 'user', commands: [solid(20 * i)] });
			await vi.advanceTimersByTimeAsync(500);
		}
		expect(write.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(clipCount(store.journalOf(projectId, 's1')!.document)).toBeGreaterThan(1);
		p.journal?.dispose();
		p.autosaver.dispose();
	});

	it('is deleted when autosave catches up and when the session closes cleanly', async () => {
		const { store, open, projectId } = await setup();
		const discard = vi.spyOn(store, 'discardRecovery');
		const s = await open('s1');
		const p = attachPersistence(s, noLifecycle);
		s.apply({ label: 'Add Solid', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(1100); // journal written
		expect(store.journalOf(projectId, 's1')).not.toBeNull();
		await vi.advanceTimersByTimeAsync(600); // autosave at 1.5 s
		expect(s.getState().dirty).toBe(false);
		expect(store.journalOf(projectId, 's1')).toBeNull();
		expect(discard).toHaveBeenCalledTimes(1);
		await p.dispose();
		await s.close();
		expect(store.journalOf(projectId, 's1')).toBeNull();
	});

	it('survives a crash and is recovered into a new session as one undoable step', async () => {
		const { store, open, projectId } = await setup();
		const save = vi.spyOn(store, 'save').mockRejectedValue(new Error('engine gone'));
		const s1 = await open('s1');
		attachPersistence(s1, { ...noLifecycle, onError: () => undefined });
		s1.apply({ label: 'Add Solid', origin: 'user', commands: [solid(0)] });
		s1.apply({ label: 'Add Solid', origin: 'user', commands: [solid(50)] });
		await vi.advanceTimersByTimeAsync(1100);
		// the tab dies: no close, no release; its lease runs out
		store.expireLease(projectId);
		save.mockRestore();

		const s2 = await open('s2');
		const p2 = attachPersistence(s2, noLifecycle);
		const {
			candidates: [c],
		} = await store.listRecovery(projectId);
		expect(c).toMatchObject({ sessionId: 's1', changes: ['Add Solid', 'Add Solid'], baseRevision: 0 });
		expect((await store.listRecovery(projectId)).candidates).toHaveLength(1); // own (empty) session is not a candidate

		const snap = await store.readRecovery(projectId, 's1');
		const before = s2.getCommitted();
		const r = s2.replaceDocument(snap.document, 'Recover Unsaved Changes');
		expect(r.ok).toBe(true);
		expect(clipCount(s2.getCommitted())).toBe(2);
		expect(s2.getState().dirty).toBe(true);
		expect(s2.getState().history.entries.at(-1)?.label).toBe('Recover Unsaved Changes');
		// the recovered state goes into this session's journal before the old one is deleted
		await p2.journal!.flush();
		expect(clipCount(store.journalOf(projectId, 's2')!.document)).toBe(2);
		await store.discardRecovery(projectId, 's1');
		expect(await store.listRecovery(projectId)).toEqual({ candidates: [], warnings: [] });
		s2.undo();
		expect(s2.getCommitted()).toBe(before);
		await p2.dispose();
		await s2.close();
	});

	it('a clean close with unsaved changes keeps them journalled; Revert discards them', async () => {
		const { store, open, projectId } = await setup();
		vi.spyOn(store, 'save').mockRejectedValue(new Error('engine gone'));
		const s = await open('s1');
		const p = attachPersistence(s, { ...noLifecycle, onError: () => undefined });
		s.apply({ label: 'Add Solid', origin: 'user', commands: [solid(0)] });
		await p.dispose(); // the save on close fails: the journal keeps the change
		await s.close();
		expect(store.journalOf(projectId, 's1')?.changes).toEqual(['Add Solid']);
		expect((await store.listRecovery(projectId)).candidates.map((c) => c.sessionId)).toEqual(['s1']);
		await store.discardRecovery(projectId, 's1');

		const s2 = await open('s2');
		attachPersistence(s2, { ...noLifecycle, onError: () => undefined });
		s2.apply({ label: 'Add Solid', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(1100);
		expect(store.journalOf(projectId, 's2')).not.toBeNull();
		const s3 = await reopenSession(s2, { discardUnsaved: true });
		expect(store.journalOf(projectId, 's2')).toBeNull();
		expect(clipCount(s3.getCommitted())).toBe(0);
		await s3.close();
	});

	it('read-only sessions never journal; documents of another project are refused', async () => {
		const { store, open, projectId } = await setup();
		const holder = await open('holder');
		const write = vi.spyOn(store, 'writeRecovery');
		const ro = await open('reader');
		expect(ro.getState().readOnly).toBe(true);
		const p = attachPersistence(ro, noLifecycle);
		expect(ro.apply({ label: 'x', origin: 'user', commands: [solid(0)] }).ok).toBe(false);
		await vi.advanceTimersByTimeAsync(6000);
		expect(write).not.toHaveBeenCalled();
		const other = createEmptyProject({ ids: createCounterIdSource(900), name: 'B', preset: 'hd-1080p-30' });
		expect(holder.replaceDocument(other, 'x')).toMatchObject({ ok: false });
		expect(holder.getCommitted().projectId).toBe(projectId);
		await p.dispose();
	});
});

// File ▸ Save As / Save a Copy / Revert / Project Versions / Recover Unsaved Changes (process workstream, D-39):
// the actions over a ProjectStore and the recovery and versions dialogs.
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { attachPersistence, EditorSession, MemoryProjectStore } from '@jasper/session';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectFileActions, PROJECT_FILE_DIALOGS } from '../src/home/project-files.tsx';

afterEach(() => {
	closeAllDialogs();
	cleanup();
});

const solid = (at: number) => ({
	type: 'clip.addSolid' as const,
	at,
	duration: 10,
	track: 'V1',
	color: [0, 1, 0, 1] as [number, number, number, number],
});
const clips = (d: ProjectDocument) => Object.keys(Object.values(d.sequences)[0]!.clips).length;

async function setup() {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'Film', preset: 'hd-1080p-30' });
	store.put(doc);
	const ctx = { ids, now: () => '2026-10-07T10:00:00.000Z', registries: defaultRegistries() };
	const open = (sessionId: string) => EditorSession.open({ store, projectId: doc.projectId, ctx, sessionId });
	return { store, open, projectId: doc.projectId };
}

describe('project file actions', () => {
	it('Save As makes a new project with the current document and opens it; Save a Copy stays', async () => {
		const { store, open } = await setup();
		const s = await open('s1');
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const opened: string[] = [];
		const a = createProjectFileActions(s, { replace: () => undefined, open: (id) => opened.push(id) });
		const copy = await a.saveAs('Film copy', { open: false });
		const as = await a.saveAs('Film v2', { open: true });
		expect(opened).toEqual([as]);
		for (const [id, name] of [
			[copy, 'Film copy'],
			[as, 'Film v2'],
		] as const) {
			const o = await store.open(id);
			expect(o.document.name).toBe(name);
			expect(clips(o.document)).toBe(1);
		}
		await s.close();
	});

	it('Revert discards unsaved changes and reloads the saved state in a new session', async () => {
		const { open } = await setup();
		const s = await open('s1');
		attachPersistence(s, { window: null, document: null });
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		let next: EditorSession | null = null;
		const a = createProjectFileActions(s, { replace: (n) => (next = n), open: () => undefined });
		await a.revert();
		expect(next).not.toBeNull();
		expect(clips(next!.getCommitted())).toBe(0);
		await next!.close();
	});

	it('restores a version in place (keeping the current state) or opens it as a copy', async () => {
		const { store, open, projectId } = await setup();
		const s = await open('s1');
		const p = attachPersistence(s, { window: null, document: null });
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		await p.flush();
		let next: EditorSession | null = null;
		const opened: string[] = [];
		const a = createProjectFileActions(s, { replace: (n) => (next = n), open: (id) => opened.push(id) });
		const [v] = await a.listVersions();
		expect(v).toMatchObject({ kind: 'auto', revision: 0 });
		const copyId = await a.openVersionAsCopy(v!.versionId);
		expect(opened).toEqual([copyId]);
		await a.restoreVersion(v!.versionId);
		expect(clips(next!.getCommitted())).toBe(0);
		expect((await store.listVersions(projectId)).some((x) => x.kind === 'before-restore')).toBe(true);
		await next!.close();
	});
});

describe('recovery dialog (S01:PER-021, AC-18)', () => {
	async function crashed() {
		const env = await setup();
		vi.useFakeTimers();
		const save = vi.spyOn(env.store, 'save').mockRejectedValue(new Error('engine gone'));
		const s1 = await env.open('dead');
		attachPersistence(s1, { window: null, document: null, onError: () => undefined });
		s1.apply({ label: 'Add Solid', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(1100);
		vi.useRealTimers();
		save.mockRestore();
		env.store.expireLease(env.projectId);
		const s2 = await env.open('alive');
		attachPersistence(s2, { window: null, document: null });
		const a = createProjectFileActions(s2, { replace: () => undefined, open: () => undefined });
		return { ...env, s2, a };
	}

	it('offers the dead session’s changes; Recover applies them as one undoable step', async () => {
		const { s2, a, store, projectId } = await crashed();
		const candidates = await a.listRecovery();
		expect(candidates.map((c) => [c.sessionId, c.changes])).toEqual([['dead', ['Add Solid']]]);
		render(<DialogHost />);
		let result: unknown;
		act(() => {
			void openDialog(PROJECT_FILE_DIALOGS.recovery, { actions: a, candidates, atOpen: true }).then(
				(r) => (result = r),
			);
		});
		const dialog = await screen.findByTestId('recovery-dialog');
		expect(within(dialog).getByTestId('recovery-changes').textContent).toBe('1 unsaved change: Add Solid');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Recover' }));
		await waitFor(() => expect(result).toBe('recovered'));
		expect(clips(s2.getCommitted())).toBe(1);
		expect(s2.getState().history.entries.at(-1)?.label).toBe('Recover Unsaved Changes');
		expect(await store.listRecovery(projectId)).toEqual([]);
		s2.undo();
		expect(clips(s2.getCommitted())).toBe(0);
		await s2.close();
	});

	it('Discard deletes the journal without touching the project', async () => {
		const { s2, a, store, projectId } = await crashed();
		const candidates = await a.listRecovery();
		render(<DialogHost />);
		act(() => {
			void openDialog(PROJECT_FILE_DIALOGS.recovery, { actions: a, candidates, atOpen: false });
		});
		fireEvent.click(await screen.findByTestId('recovery-discard'));
		await waitFor(() => expect(screen.queryByTestId('recovery-dialog')).toBeNull());
		expect(await store.listRecovery(projectId)).toEqual([]);
		expect(clips(s2.getCommitted())).toBe(0);
		await s2.close();
	});
});

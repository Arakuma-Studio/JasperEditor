import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { attachPersistence, EditorSession, MemoryProjectStore } from '@jasper/session';
import { describe, expect, it, vi } from 'vitest';
import { runUiAction, setUiAutomationHost } from '../src/agent-bridge/ui-automation.ts';
import { appCommands } from '../src/commands/app.ts';
import { listCommands, registerCommands, runCommand } from '../src/commands/registry.ts';
import type { CommandCtx } from '../src/commands/types.ts';

describe('ui_key DOM protocol', () => {
	it('dispatches printable chord keys and rejects unknown keys or modifiers', async () => {
		const observed: KeyboardEvent[] = [];
		const listen = (event: KeyboardEvent) => {
			observed.push(event);
			event.preventDefault();
		};
		window.addEventListener('keydown', listen);
		try {
			for (const [chord, key, code, shiftKey, altKey] of [
				['Space', ' ', 'Space', false, false],
				['?', '?', 'Slash', true, false],
				['Alt++', '+', 'Equal', true, true],
			] as const) {
				await expect(runUiAction('key', { key: chord })).resolves.toMatchObject({ handled: true });
				expect(observed.at(-1)).toMatchObject({ key, code, shiftKey, altKey });
			}
			for (const key of ['Hyper+K', 'Banana'])
				await expect(runUiAction('key', { key })).rejects.toMatchObject({ code: 'E_INVALID_PARAM' });
		} finally {
			window.removeEventListener('keydown', listen);
		}
	});
});

describe('desktop screenshots', () => {
	it('reports a refused native capture as unavailable', async () => {
		const previous = Object.getOwnPropertyDescriptor(window, 'jasperDesktop');
		const capturePage = vi.fn().mockResolvedValue(null);
		Object.defineProperty(window, 'jasperDesktop', { configurable: true, value: { capturePage } });
		try {
			await expect(runUiAction('screenshot', {})).rejects.toMatchObject({ code: 'E_NOT_AVAILABLE' });
		} finally {
			if (previous) Object.defineProperty(window, 'jasperDesktop', previous);
			else delete window.jasperDesktop;
		}
	});
});

describe('ui command file.save', () => {
	it('fails with E_SAVE_CONFLICT, saying nothing was saved, while a revision conflict pauses saving', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
		const ids = createCounterIdSource(5);
		const store = new MemoryProjectStore({ ids });
		const doc = createEmptyProject({ ids, name: 'Save', preset: 'hd-1080p-30' });
		store.put(doc);
		const ctx0 = { ids, now: () => '2026-09-30T00:00:00.000Z', registries: defaultRegistries() };
		const session = await EditorSession.open({ store, projectId: doc.projectId, ctx: ctx0, sessionId: 'a' });
		const persistence = attachPersistence(session, { window: null, document: null, recovery: false });
		// Saved from somewhere else: the window's next save conflicts and pauses autosave.
		await store.save(doc.projectId, session.getCommitted(), { revision: 40, baseRevision: 0 });
		session.apply({ label: 'Mine', origin: 'user', commands: [{ type: 'marker.add', frame: 2 }] });
		await vi.advanceTimersByTimeAsync(1600);
		vi.useRealTimers();
		expect(persistence.autosaver.getStatus().paused).toBe('conflict');

		const offCommands = registerCommands(appCommands);
		const ctx = {
			session,
			focus: { panel: null, instanceId: null },
			capabilities: new Set(),
			services: { get: () => undefined },
			ui: { toast() {}, openDialog() {} },
		} as unknown as CommandCtx;
		const offHost = setUiAutomationHost({
			getCtx: () => ctx,
			runCommand: (id, args) => runCommand(id, ctx, args),
			listCommands: () => listCommands(),
			isEnabled: () => true,
			isChecked: () => false,
			shortcutFor: () => null,
			labelFor: (c) => c.label,
			shell: () => null,
		});
		try {
			await expect(runUiAction('command', { id: 'file.save' })).rejects.toMatchObject({
				code: 'E_SAVE_CONFLICT',
				message: expect.stringContaining('Nothing was saved'),
			});
			expect((await store.open(doc.projectId)).revision).toBe(40);
		} finally {
			offHost();
			offCommands();
			await persistence.dispose();
			await session.close();
		}
	});
});

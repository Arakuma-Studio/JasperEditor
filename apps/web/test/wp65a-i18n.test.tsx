// WP6.5a carry-over (i18n): "Undo <step>" / "Redo <step>" in the Edit menu and the recovery list, and the built-in
// workspace names, in the UI language. Ids and stored names stay English.
import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import { createEmptyProject, createRandomIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { editCommands } from '../src/commands/edit.ts';
import { registerCommands as register } from '../src/commands/registry.ts';
import type { UiCommand } from '../src/commands/types.ts';
import { setLanguage } from '../src/i18n/runtime.ts';
import { DIALOGS, registerShellDialogs } from '../src/shell/dialogs.tsx';
import { recoveryChangeLabel } from '../src/shell/history-labels.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { resolveMenu } from '../src/shell/menus/resolve.ts';
import { workspaceName } from '../src/shell/workspaces/definitions.ts';
import { WorkspaceStore } from '../src/shell/workspaces/store.ts';
import { memoryStorage } from './shell-storage.ts';

const engine = new EngineClient({
	fetch: (async () => new Response('{}', { status: 501 })) as unknown as typeof fetch,
});
const unregister: (() => void)[] = [];
function registerCommands(commands: readonly UiCommand[]) {
	unregister.push(register(commands));
}

afterEach(async () => {
	for (const off of unregister.splice(0).reverse()) off();
	cleanup();
	closeAllDialogs();
	await setLanguage('en');
});

async function sessionWith(label: string, origin: unknown = 'user') {
	const ids = createRandomIdSource();
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-29.97' });
	store.put(doc);
	const session = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => new Date().toISOString(), registries: defaultRegistries(mgRegistry) },
	});
	const seqId = session.getState().activeSequenceId!;
	const r = session.apply({
		label,
		origin: origin as never,
		sequenceId: seqId,
		commands: [{ type: 'marker.add', sequenceId: seqId, frame: 10 } as never],
	});
	expect(r.ok).toBe(true);
	return session;
}

function editMenuLabel(session: EditorSession, id: 'history.undo' | 'history.redo') {
	const ctx = createCommandContext({ engine, session });
	const env = { ctx, platform: 'linux' as const, runtime: 'web' as const, run: () => {} };
	const items = resolveMenu(MENUBAR.find((m) => m.id === 'edit')!.items, env);
	const item = items.find((i) => i.id === id);
	return item?.type === 'item' ? item.label : null;
}

describe('Undo / Redo labels (WP6.5a item 2)', () => {
	it('the Edit menu says Undo / Redo and the step in Spanish', async () => {
		registerCommands(editCommands);
		const session = await sessionWith('Add Marker');
		expect(editMenuLabel(session, 'history.undo')).toBe('Undo Add Marker');
		await setLanguage('es');
		expect(editMenuLabel(session, 'history.undo')).toBe('Deshacer Añadir marcador');
		session.undo();
		expect(editMenuLabel(session, 'history.redo')).toBe('Rehacer Añadir marcador');
		expect(editMenuLabel(session, 'history.undo')).toBe('Deshacer');
		await session.close();
	});

	it("an agent's step and a name the catalogue does not know", async () => {
		registerCommands(editCommands);
		const agent = await sessionWith('Add Marker', { agent: 'test' });
		await setLanguage('es');
		expect(editMenuLabel(agent, 'history.undo')).toBe('Deshacer Agente: Añadir marcador');
		await agent.close();
		const own = await sessionWith('Mark the beat');
		expect(editMenuLabel(own, 'history.undo')).toBe('Deshacer Mark the beat');
		await own.close();
	});

	it('Edit ▸ Select All / Deselect All (commands that delegate to the Timeline) are translated too', async () => {
		const { integrationCommands } = await import('../src/commands/integration.ts');
		registerCommands(integrationCommands);
		await setLanguage('es');
		const all = integrationCommands.find((c) => c.id === 'edit.selectAll')!;
		expect(all.label).toBe('Seleccionar todo');
		expect(integrationCommands.find((c) => c.id === 'edit.deselectAll')!.label).toBe('Deseleccionar todo');
		await setLanguage('en');
		expect(all.label).toBe('Select All');
	});

	it('the crash-recovery list translates its journalled "Undo …" / "Redo …" changes', async () => {
		await setLanguage('es');
		expect(recoveryChangeLabel('Undo Add Marker')).toBe('Deshacer Añadir marcador');
		expect(recoveryChangeLabel('Redo Add Edit')).toBe('Rehacer Añadir edición');
		expect(recoveryChangeLabel('Add Edit')).toBe('Añadir edición');
		expect(recoveryChangeLabel('My own step')).toBe('My own step');
		await setLanguage('en');
		expect(recoveryChangeLabel('Undo Add Marker')).toBe('Undo Add Marker');
	});
});

describe('built-in workspace names (WP6.5a item 3)', () => {
	it('switching language preserves workspace ids, stored names, and user-chosen names', async () => {
		const store = new WorkspaceStore(memoryStorage());
		const before = store.list().map((w) => [w.id, w.name]);
		await setLanguage('es');
		expect(store.list().map((w) => [w.id, w.name])).toEqual(before);
		// a custom workspace keeps the user's name, even one that reads like a built-in
		const r = store.saveAs('Effects 2', null);
		expect(workspaceName(store.get(r.id!)!)).toBe('Effects 2');
		expect(workspaceName({ id: 'custom:editing', name: 'Editing', builtIn: false })).toBe('Editing');
	});

	it('Edit Workspaces lists the translated names', async () => {
		registerShellDialogs();
		const store = new WorkspaceStore(memoryStorage());
		await setLanguage('es');
		render(<DialogHost />);
		await act(async () => {
			void openDialog(DIALOGS.editWorkspaces, { store });
		});
		expect(await screen.findByText('Diseño de sonido')).toBeTruthy();
		expect(screen.getByText('Edición')).toBeTruthy();
		expect(screen.queryByText('Sound Design')).toBeNull();
	});
});

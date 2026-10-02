import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import { createEmptyProject, createRandomIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { Dialog, Select } from '@jasper/ui';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { editCommands } from '../src/commands/edit.ts';
import { DEFAULT_KEYMAP } from '../src/commands/keymap-defaults.ts';
import { registerCommands, resetCommandRegistry } from '../src/commands/registry.ts';
import type { CommandCtx, UiCommand } from '../src/commands/types.ts';
import { listPanels } from '../src/panels/registry.ts';
import type { PanelKind } from '../src/panels/types.ts';
import { focusStore } from '../src/shell/focus.ts';
import { installKeyboardDispatcher, resolveKey } from '../src/shell/keymap/dispatcher.ts';
import { formatChord, shortcutFor } from '../src/shell/keymap/format.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { resolveMenu } from '../src/shell/menus/resolve.ts';
import { BUILTIN_WORKSPACES } from '../src/shell/workspaces/definitions.ts';
import { buildLayout, sanitizeLayout } from '../src/shell/workspaces/layout.ts';
import { memoryStorage } from '../src/shell/workspaces/storage.ts';
import { WORKSPACES_KEY, WorkspaceStore } from '../src/shell/workspaces/store.ts';

const engine = new EngineClient({
	fetch: (async () => new Response('{}', { status: 501 })) as unknown as typeof fetch,
});
const panelMap = new Map(listPanels().map((d) => [d.kind, d]));

function ctx(extra: Partial<Parameters<typeof createCommandContext>[0]> = {}): CommandCtx {
	return createCommandContext({ engine, ...extra });
}

afterEach(() => {
	resetCommandRegistry();
	focusStore.clear();
	document.body.innerHTML = '';
});
describe('workspace layout compatibility', () => {
	it('drops unknown panel kinds from a saved layout (SH-023)', () => {
		const saved = {
			grid: {
				width: 1000,
				height: 600,
				orientation: 'HORIZONTAL',
				root: { type: 'leaf', size: 1000, data: { id: 'group-1', views: ['project-1', 'hologram-1'] } },
			},
			panels: {
				'project-1': { id: 'project-1', params: { kind: 'project' } },
				'hologram-1': { id: 'hologram-1', params: { kind: 'hologram' } },
			},
		};
		const clean = sanitizeLayout(saved);
		expect(clean?.panels['hologram-1']).toBeUndefined();
		expect(clean?.panels['project-1']).toBeDefined();
		expect(JSON.stringify(clean?.grid.root)).not.toContain('hologram-1');
	});
});
describe('workspace store', () => {
	it('a newer workspace storage version falls back without loading its data (SH-021)', () => {
		const storage = memoryStorage({
			[WORKSPACES_KEY]: JSON.stringify({ version: 99, data: { activeId: 'custom:foreign' } }),
		});
		const store = new WorkspaceStore(storage);
		expect(store.resetReason).toBe('newer');
		expect(store.getState().activeId).toBe('editing');
		expect(storage.getItem(WORKSPACES_KEY)).toBeNull();
	});

	it('ignores inherited object keys as workspace ids (storage and workspace.switch args)', () => {
		const stored = JSON.stringify({
			version: 1,
			data: { activeId: 'constructor', order: ['toString', 'editing'], workspaces: {} },
		});
		const store = new WorkspaceStore(memoryStorage({ [WORKSPACES_KEY]: stored }));
		expect(store.getState().activeId).toBe('editing');
		expect(store.get('constructor')).toBeUndefined();
		store.setActive('constructor');
		expect(store.getState().activeId).toBe('editing');
	});

	it('state saved by a build that had the Agent panel still loads (wp-mcp)', () => {
		const stored = JSON.stringify({
			version: 1,
			data: {
				activeId: 'agent',
				order: ['editing', 'agent', 'assembly', 'custom:mine'],
				workspaces: {
					agent: { name: 'Agent', current: null, saved: null },
					'custom:mine': { name: 'Mine', current: null, saved: null },
				},
			},
		});
		const store = new WorkspaceStore(memoryStorage({ [WORKSPACES_KEY]: stored }));
		expect(store.resetReason).toBeNull();
		expect(store.get('agent')).toBeUndefined();
		expect(store.getState().activeId).toBe('editing');
		expect(store.get('custom:mine')?.name).toBe('Mine');
	});

	it('persists a saved workspace and imports a duplicate name with a suffix (WS-010, WS-014)', () => {
		const storage = memoryStorage();
		const store = new WorkspaceStore(storage);
		const layout = buildLayout(BUILTIN_WORKSPACES[1]!, { width: 1600, height: 900 }, panelMap);
		store.saveChanges('editing', layout);
		const exported = store.exportJson('editing')!;
		const imported = store.importJson(exported, (l) => sanitizeLayout(l));
		expect(imported.ok).toBe(true);
		const importedId = (imported as { id: string }).id;
		const again = new WorkspaceStore(storage);
		expect(again.get('editing')?.saved).toEqual(layout);
		expect(again.get(importedId)?.name).toBe('Editing (2)');
	});
});

// ------------------------------------------------------------------ keyboard (KB-001…007, AC-KB-1/2/4)

describe('keyboard dispatcher', () => {
	function mount(focus: PanelKind | null, commands: UiCommand[]) {
		registerCommands(commands);
		const run = vi.fn((c: UiCommand, cx: CommandCtx) => c.run(cx));
		const off = installKeyboardDispatcher(window, {
			getCtx: () => ctx(),
			getFocusKind: () => focus,
			platform: 'linux',
			runtime: 'web',
			run,
		});
		return { run, off };
	}
	const cmd = (
		id: string,
		scope: UiCommand['scope'],
		run = vi.fn(),
		extra: Partial<UiCommand> = {},
	): UiCommand => ({
		id,
		label: id,
		scope,
		run,
		...extra,
	});

	it('AC-KB-1: = zooms thumbnails in Project and the timeline when Timeline is focused', () => {
		const projectZoom = vi.fn();
		const timelineZoom = vi.fn();
		const cmds = [
			cmd('project.zoomIn', 'project', projectZoom),
			cmd('timeline.zoomIn', 'timeline', timelineZoom),
		];
		const a = mount('project', cmds);
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Equal', key: '=', bubbles: true }));
		expect(projectZoom).toHaveBeenCalledOnce();
		expect(timelineZoom).not.toHaveBeenCalled();
		a.off();
		const b = mount('timeline', cmds);
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Equal', key: '=', bubbles: true }));
		expect(timelineZoom).toHaveBeenCalledOnce();
		b.off();
	});

	it('AC-KB-2: typing "j" in a search field does not shuttle; Ctrl+S still saves', () => {
		const shuttle = vi.fn();
		const save = vi.fn();
		const { off } = mount('project', [
			cmd('transport.shuttleReverse', 'editing', shuttle),
			cmd('app.save', 'global', save),
		]);
		const input = document.createElement('input');
		input.type = 'search';
		document.body.append(input);
		input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', bubbles: true }));
		expect(shuttle).not.toHaveBeenCalled();
		// Even with an editing panel focused the key is suspended inside the field.
		off();
		const again = mount('timeline', [
			cmd('transport.shuttleReverse', 'editing', shuttle),
			cmd('app.save', 'global', save),
		]);
		input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', bubbles: true }));
		expect(shuttle).not.toHaveBeenCalled();
		input.dispatchEvent(
			new KeyboardEvent('keydown', {
				code: 'KeyS',
				key: 's',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(save).toHaveBeenCalledOnce();
		// Text-editing chords stay with the field.
		const undo = vi.fn();
		registerCommands([cmd('history.undo', 'global', undo)]);
		input.dispatchEvent(
			new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', ctrlKey: true, bubbles: true }),
		);
		expect(undo).not.toHaveBeenCalled();
		again.off();
	});

	it('a widget that consumes a key wins; otherwise the command runs after it', () => {
		const next = vi.fn();
		const { off } = mount('timeline', [cmd('transport.stepForward', 'editing', next)]);
		const list = document.createElement('div');
		list.setAttribute('data-keymap-local', '');
		list.tabIndex = 0;
		document.body.append(list);
		list.addEventListener('keydown', (e) => {
			if ((e as KeyboardEvent).code === 'ArrowRight') e.preventDefault();
		});
		list.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true }));
		expect(next).not.toHaveBeenCalled();
		const plain = document.createElement('div');
		document.body.append(plain);
		plain.dispatchEvent(
			new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true }),
		);
		expect(next).toHaveBeenCalledOnce();
		off();
	});

	it('repeat only for repeatable commands; keyup reaches hold-to-act commands (KB-006/007)', () => {
		const toggle = vi.fn();
		const shuttle = vi.fn();
		const up = vi.fn();
		const { off } = mount('timeline', [
			cmd('timeline.toggleSnap', 'timeline', toggle),
			cmd('transport.shuttleForward', 'editing', shuttle, { onKeyUp: up }),
		]);
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', repeat: true, bubbles: true }));
		expect(toggle).toHaveBeenCalledOnce();
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyL', bubbles: true }));
		expect(shuttle).toHaveBeenCalledOnce();
		expect(up).toHaveBeenCalledOnce();
		off();
	});

	it('disabled commands fall through to an enabled global binding (KB-002)', () => {
		const global = vi.fn();
		registerCommands([
			cmd('project.newBin', 'project', vi.fn(), { when: () => false }),
			{ ...cmd('x.global', 'global', global) },
		]);
		const res = resolveKey('Ctrl+KeyB', 'project', ctx(), {
			platform: 'linux',
			runtime: 'web',
			keymap: [
				{ command: 'project.newBin', key: 'Ctrl+KeyB', scope: 'project' },
				{ command: 'x.global', key: 'Ctrl+KeyB', scope: 'global' },
			],
		});
		expect(res?.command.id).toBe('x.global');
	});

	it('keys in a modal dialog reach its controls: Enter / Space / ↓ open a focused Select, no shortcut runs', async () => {
		const play = vi.fn();
		const next = vi.fn();
		const { off } = mount('timeline', [
			cmd('transport.playStop', 'editing', play),
			cmd('transport.nextEdit', 'editing', next),
		]);
		try {
			for (const key of ['Enter', ' ', 'ArrowDown']) {
				const view = render(
					<Dialog open onOpenChange={() => {}} title="D" primaryLabel="Go" onPrimary={() => false}>
						<Select
							label="Pick"
							value="a"
							onValueChange={() => {}}
							options={[
								{ value: 'a', label: 'Alpha' },
								{ value: 'b', label: 'Beta' },
							]}
						/>
					</Dialog>,
				);
				const trigger = view.getByRole('combobox', { name: 'Pick' });
				trigger.focus();
				const code = key === ' ' ? 'Space' : key;
				await act(async () => {
					trigger.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
				});
				expect(trigger.getAttribute('aria-expanded'), key).toBe('true');
				view.unmount();
			}
			expect(play).not.toHaveBeenCalled();
			expect(next).not.toHaveBeenCalled();
		} finally {
			off();
		}
	});

	it('AC-KB-4: the default keymap has no duplicate bindings per scope (every platform/runtime)', () => {
		for (const platform of ['win', 'linux', 'mac'] as const)
			for (const runtime of ['web', 'desktop'] as const) {
				const seen = new Map<string, string>();
				for (const b of DEFAULT_KEYMAP) {
					const key = shortcutFor(b.command, { platform, runtime, keymap: [b] });
					if (!key) continue;
					const id = `${b.scope}|${key}`;
					const prev = seen.get(id);
					expect(
						prev === undefined || prev === b.command,
						`${platform}/${runtime} ${id}: ${prev} vs ${b.command}`,
					).toBe(true);
					seen.set(id, b.command);
				}
			}
	});

	it('formats shortcuts per platform with web fallbacks (MN-004, KB-013)', () => {
		expect(formatChord('Ctrl+Shift+KeyZ', 'linux')).toBe('Ctrl+Shift+Z');
		expect(formatChord('Cmd+Shift+KeyZ', 'mac')).toBe('⇧⌘Z');
		expect(shortcutFor('app.newSequence', { platform: 'linux', runtime: 'web' })).toBe('Alt+N');
		expect(shortcutFor('app.newSequence', { platform: 'win', runtime: 'desktop' })).toBe('Ctrl+N');
		expect(shortcutFor('palette.open', { platform: 'linux', runtime: 'web' })).toBe('Ctrl+Shift+P');
		expect(shortcutFor('panel.focus.project', { platform: 'linux', runtime: 'web' })).toBe('Shift+1');
	});
});

// ------------------------------------------------------------------ menus (MN-001/011, SH-031)

describe('menus', () => {
	async function sessionWithEdit() {
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
			label: 'Add Marker',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'marker.add', sequenceId: seqId, frame: 10 } as never],
		});
		expect(r.ok).toBe(true);
		return session;
	}

	it('unregistered commands stay visible but disabled with a reason; undo shows the step name', async () => {
		registerCommands(editCommands);
		const session = await sessionWithEdit();
		const env = { ctx: ctx({ session }), platform: 'linux' as const, runtime: 'web' as const, run: vi.fn() };
		const edit = resolveMenu(MENUBAR.find((m) => m.id === 'edit')!.items, env);
		const undo = edit.find((i) => i.id === 'history.undo');
		expect(undo && undo.type === 'item' && undo.label).toBe('Undo Add Marker');
		expect(undo && undo.type === 'item' && undo.shortcut).toBe('Ctrl+Z');
		const redo = edit.find((i) => i.id === 'history.redo');
		expect(redo?.type === 'item' && redo.disabled && redo.disabledReason).toBe('Nothing to redo');
		const cut = edit.find((i) => i.id === 'edit.cut');
		expect(cut?.type === 'item' && cut.disabled && cut.disabledReason).toMatch(/not available/i);
		if (undo?.type === 'item') undo.onSelect();
		expect(env.run).toHaveBeenCalledWith('history.undo', undefined);
		session.undo();
		const after = resolveMenu(MENUBAR.find((m) => m.id === 'edit')!.items, env);
		const redo2 = after.find((i) => i.id === 'history.redo');
		expect(redo2?.type === 'item' && redo2.label).toBe('Redo Add Marker');
		// Agent steps read "Undo Agent: …" (MN-011).
		const seqId = session.getState().activeSequenceId!;
		session.apply({
			label: 'Mark beat',
			origin: { agent: 'test' },
			sequenceId: seqId,
			commands: [{ type: 'marker.add', sequenceId: seqId, frame: 20 } as never],
		});
		const agentMenu = resolveMenu(MENUBAR.find((m) => m.id === 'edit')!.items, env);
		const u = agentMenu.find((i) => i.id === 'history.undo');
		expect(u?.type === 'item' && u.label).toBe('Undo Agent: Mark beat');
		await session.close();
	});

	it('capability-gated commands explain what is missing; edit-only menus are disabled outside Edit (MN-010)', () => {
		registerCommands([
			{ id: 'export.media', label: 'Export Media…', scope: 'global', capability: 'engine', run: () => {} },
		]);
		const env = { ctx: ctx(), platform: 'linux' as const, runtime: 'web' as const, run: vi.fn() };
		const file = resolveMenu(MENUBAR.find((m) => m.id === 'file')!.items, env);
		const exp = file.find((i) => i.type === 'submenu' && i.label === 'Export');
		const media = exp?.type === 'submenu' ? exp.items.find((i) => i.id === 'export.media') : undefined;
		expect(media?.type === 'item' && media.disabledReason).toMatch(/engine/i);
		const seq = resolveMenu(MENUBAR.find((m) => m.id === 'sequence')!.items, {
			...env,
			disabledReason: 'Not available outside Edit mode',
		});
		expect(
			seq.every(
				(i) => i.type !== 'item' || (i.disabled && i.disabledReason === 'Not available outside Edit mode'),
			),
		).toBe(true);
	});
});

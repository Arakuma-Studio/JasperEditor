import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import { createEmptyProject, createRandomIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { toasts } from '@jasper/ui';
import { act, render } from '@testing-library/react';
import { type DockviewApi, DockviewReact } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { editCommands } from '../src/commands/edit.ts';
import { DEFAULT_KEYMAP } from '../src/commands/keymap-defaults.ts';
import { registerCommands, resetCommandRegistry } from '../src/commands/registry.ts';
import type { CommandCtx, UiCommand } from '../src/commands/types.ts';
import { listPanels } from '../src/panels/registry.ts';
import { PANEL_KINDS, type PanelKind } from '../src/panels/types.ts';
import { DockController } from '../src/shell/dock/controller.ts';
import { focusStore } from '../src/shell/focus.ts';
import { classifyTarget, installKeyboardDispatcher, resolveKey } from '../src/shell/keymap/dispatcher.ts';
import { formatChord, shortcutFor } from '../src/shell/keymap/format.ts';
import { computeLayoutMode } from '../src/shell/layout-mode.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { NOT_AVAILABLE_REASON, resolveMenu } from '../src/shell/menus/resolve.ts';
import { fuzzyScore, parsePaletteQuery } from '../src/shell/palette/fuzzy.ts';
import { parsePrefs } from '../src/shell/prefs.ts';
import { BUILTIN_WORKSPACES, LAYOUT_PRESETS, panelsIn } from '../src/shell/workspaces/definitions.ts';
import { buildLayout, distribute, sanitizeLayout } from '../src/shell/workspaces/layout.ts';
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

// ------------------------------------------------------------------ workspaces as data (WS-001, AC-SH-1)

describe('built-in workspaces', () => {
	it('ship editing, assembly, effects, motion and essentials; every referenced panel exists once', () => {
		const ids = BUILTIN_WORKSPACES.map((w) => w.id);
		for (const id of ['editing', 'assembly', 'effects', 'motion', 'essentials']) expect(ids).toContain(id);
		// The Agent workspace and panel are gone (agents connect over MCP).
		expect(ids).not.toContain('agent');
		expect(PANEL_KINDS as readonly string[]).not.toContain('agent');
		expect(ids[0]).toBe('editing');
		for (const ws of [...BUILTIN_WORKSPACES, ...LAYOUT_PRESETS]) {
			const kinds = panelsIn(ws.layout);
			for (const k of kinds) expect(PANEL_KINDS, `${ws.id} references ${k}`).toContain(k);
			const singles = kinds.filter((k) => panelMap.get(k)?.instance === 'single');
			expect(new Set(singles).size, `${ws.id} duplicates`).toBe(singles.length);
		}
	});

	it('Editing places every panel with Properties full height on the right (S05 §4.2)', () => {
		const editing = BUILTIN_WORKSPACES[0]!;
		expect(new Set(panelsIn(editing.layout))).toEqual(new Set(PANEL_KINDS));
		const layout = buildLayout(editing, { width: 1914, height: 1013 }, panelMap);
		expect(layout.grid.orientation).toBe('HORIZONTAL');
		type N = { type: string; size: number; data: unknown };
		const [left, right] = layout.grid.root.data as N[] as [N, N];
		expect(right.type).toBe('leaf');
		expect((right.data as { views: string[] }).views).toEqual(['properties-1']);
		expect(Math.round((right.size / 1914) * 100)).toBe(22);
		const bottomRow = (left.data as N[])[1] as N;
		const bottom = bottomRow.data as { size: number; data: { views: string[] } }[];
		const sizes = Object.fromEntries(bottom.map((n) => [n.data.views[0], n.size]));
		expect(sizes['tools-1']).toBeGreaterThanOrEqual(40);
		expect(sizes['tools-1']).toBeLessThanOrEqual(43);
		expect(sizes['audioMeters-1']).toBeGreaterThanOrEqual(52);
		expect(sizes['audioMeters-1']).toBeLessThanOrEqual(55);
		expect(Math.round(((sizes['project-1'] ?? 0) / 1914) * 100)).toBe(21);
		// Program and Timeline are keep-alive (SH-006).
		expect(layout.panels['program-1']?.renderer).toBe('always');
		expect(layout.panels['timeline-1']?.renderer).toBe('always');
	});

	it('distributes px, fractions and fill exactly', () => {
		expect(distribute([{ px: 40 }, 'fill', { px: 52 }], 1000)).toEqual([40, 908, 52]);
		expect(distribute([0.25, 'fill'], 1000)).toEqual([250, 750]);
		expect(distribute([0.3, 0.7], 999).reduce((a, b) => a + b)).toBe(999);
	});

	it('sanitize drops unknown panel kinds and gives their space to neighbors (SH-023)', () => {
		const layout = buildLayout(BUILTIN_WORKSPACES[0]!, { width: 1600, height: 900 }, panelMap) as unknown as {
			panels: Record<string, { params: { kind: string } }>;
		};
		layout.panels['history-1']!.params.kind = 'hologram';
		const clean = sanitizeLayout(layout);
		expect(clean).not.toBeNull();
		expect(Object.keys(clean!.panels)).not.toContain('history-1');
		expect(sanitizeLayout({ nope: true })).toBeNull();
		expect(sanitizeLayout(null)).toBeNull();
	});
});

// ------------------------------------------------------------------ persistence (SH-020…022, AC-SH-4)

describe('workspace store', () => {
	it('corrupt stored JSON falls back to defaults and flags a single reset', () => {
		const storage = memoryStorage({ [WORKSPACES_KEY]: '{corrupt' });
		const store = new WorkspaceStore(storage);
		expect(store.resetReason).toBe('corrupt');
		expect(store.getState().activeId).toBe('editing');
		expect(storage.getItem(WORKSPACES_KEY)).toBeNull();
		const newer = new WorkspaceStore(
			memoryStorage({ [WORKSPACES_KEY]: JSON.stringify({ version: 99, data: {} }) }),
		);
		expect(newer.resetReason).toBe('newer');
		const ok = new WorkspaceStore(memoryStorage());
		expect(ok.resetReason).toBeNull();
	});

	it('ignores inherited object keys as workspace ids (storage and workspace.switch args)', () => {
		const stored = JSON.stringify({
			version: 1,
			data: { activeId: 'constructor', order: ['toString', 'editing'], workspaces: {} },
		});
		const store = new WorkspaceStore(memoryStorage({ [WORKSPACES_KEY]: stored }));
		expect(store.getState().activeId).toBe('editing');
		expect(store.getState().order).not.toContain('toString');
		expect(store.get('constructor')).toBeUndefined();
		store.setActive('constructor');
		expect(store.getState().activeId).toBe('editing');
	});

	it('state saved by a build that had the Agent panel still loads (wp-mcp)', () => {
		// What the previous build stored: the Agent workspace (active), and layouts with an `agent` tab.
		type Stored = {
			grid: { root: { data: unknown[] } };
			panels: Record<string, { id: string; params: { kind: string } }>;
		};
		const withAgentTab = (): Stored => {
			const l = buildLayout(
				BUILTIN_WORKSPACES[0]!,
				{ width: 1600, height: 900 },
				panelMap,
			) as unknown as Stored;
			l.panels['agent-1'] = { ...l.panels['properties-1']!, id: 'agent-1', params: { kind: 'agent' } };
			const right = l.grid.root.data[1] as { data: { views: string[]; activeView: string } };
			right.data.views = ['properties-1', 'agent-1'];
			right.data.activeView = 'agent-1';
			return l;
		};
		const agentOnly = withAgentTab();
		const onlyGroup = agentOnly.grid.root.data[1] as { data: { views: string[]; activeView: string } };
		onlyGroup.data.views = ['agent-1'];
		const stored = JSON.stringify({
			version: 1,
			data: {
				activeId: 'agent',
				order: ['editing', 'agent', 'assembly', 'custom:mine'],
				workspaces: {
					editing: { name: 'Editing', current: withAgentTab(), saved: withAgentTab() },
					agent: { name: 'Agent', current: withAgentTab(), saved: null },
					'custom:mine': { name: 'Mine', current: agentOnly, saved: agentOnly },
				},
			},
		});
		const store = new WorkspaceStore(memoryStorage({ [WORKSPACES_KEY]: stored }));
		// Nothing is reset: the user's other layouts survive.
		expect(store.resetReason).toBeNull();
		expect(store.get('agent')).toBeUndefined();
		expect(store.getState().order).not.toContain('agent');
		expect(store.getState().activeId).toBe('editing');
		expect(store.get('custom:mine')?.name).toBe('Mine');
		// Applying a stored layout drops just the retired panel (the dock sanitizes on apply).
		const clean = sanitizeLayout(store.get('editing')!.current) as unknown as Stored;
		expect(Object.keys(clean.panels)).not.toContain('agent-1');
		expect(Object.keys(clean.panels)).toContain('properties-1');
		const right = clean.grid.root.data[1] as { data: { views: string[]; activeView: string } };
		expect(right.data).toMatchObject({ views: ['properties-1'], activeView: 'properties-1' });
		// A group that only held the Agent tab disappears; the rest of the layout stays usable.
		const mine = sanitizeLayout(store.get('custom:mine')!.current) as unknown as Stored;
		expect(mine).not.toBeNull();
		expect(Object.values(mine.panels).map((p) => p.params.kind)).not.toContain('agent');
		expect(Object.keys(mine.panels)).toContain('timeline-1');
		expect(mine.grid.root.data).toHaveLength(1);
	});

	it('current/saved snapshots, save as, reset, reorder and Alt+Shift numbering (WS-010…012)', () => {
		vi.useFakeTimers();
		const storage = memoryStorage();
		const store = new WorkspaceStore(storage);
		const layout = buildLayout(BUILTIN_WORKSPACES[1]!, { width: 1600, height: 900 }, panelMap);
		store.setCurrent('editing', layout);
		expect(storage.getItem(WORKSPACES_KEY)).toBeNull(); // debounced
		vi.advanceTimersByTime(300);
		expect(JSON.parse(storage.getItem(WORKSPACES_KEY)!).version).toBe(1);
		expect(store.resetToSaved('editing')).toBeNull(); // built-in saved = factory
		store.setCurrent('editing', layout);
		store.saveChanges('editing');
		expect(store.get('editing')?.saved).toEqual(layout);
		expect(store.checkName('  ').ok).toBe(false);
		expect(store.checkName('editing').ok).toBe(false);
		const r = store.saveAs('My cut', layout);
		expect(r.ok).toBe(true);
		expect(store.getState().activeId).toBe(r.id);
		expect(store.byNumber(1)).toBe('editing');
		store.move(r.id!, 'editing');
		expect(store.byNumber(1)).toBe(r.id);
		expect(store.remove('editing')).toBe(false);
		expect(store.remove(r.id!)).toBe(true);
		const exported = store.exportJson('editing')!;
		const imported = store.importJson(exported, (l) => sanitizeLayout(l));
		expect(imported.ok).toBe(true);
		expect(store.get((imported as { id: string }).id)?.name).toBe('Editing (2)');
		// Reload from storage keeps everything.
		store.flush();
		const again = new WorkspaceStore(storage);
		expect(again.list().map((w) => w.name)).toContain('Editing (2)');
		vi.useRealTimers();
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

	it('disabled or unregistered commands fall through the scope chain (KB-002)', () => {
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
		expect(classifyTarget(document.createElement('textarea'))).toBe('editable');
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
		expect(cut?.type === 'item' && cut.disabled && cut.disabledReason).toBe(NOT_AVAILABLE_REASON);
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

// ------------------------------------------------------------------ dock controller with real dockview (DK-040, DK-043)

describe('dock controller', () => {
	it('maximize toggles without changing the tree and restores the same layout (AC-SH-5 state)', async () => {
		const store = new WorkspaceStore(memoryStorage());
		const dock = new DockController(store, panelMap);
		let api: DockviewApi | null = null;
		render(
			<div style={{ width: 1600, height: 900 }}>
				<DockviewReact
					components={{ panel: () => <div /> }}
					tabComponents={{ panelTab: () => <span /> }}
					onReady={(e) => {
						api = e.api;
						dock.attach(e.api, null);
						dock.apply('editing');
					}}
				/>
			</div>,
		);
		await act(async () => {});
		expect(api).not.toBeNull();
		// happy-dom has no real layout (sizes collapse to minimums), so compare the tree structure here;
		// pixel-equal restore is verified in Chrome (docs/wp-notes/WP-2A.md).
		const shape = () =>
			JSON.stringify(dock.currentLayout()?.grid.root, (k, v) => (k === 'size' ? undefined : v));
		const before = shape();
		expect(dock.isOpen('timeline')).toBe(true);
		act(() => focusStore.focus('timeline-1', 'timeline'));
		act(() => {
			expect(dock.toggleMaximize('focused')).toBe(true);
		});
		expect(dock.isMaximized()).toBe(true);
		act(() => {
			expect(dock.toggleMaximize('focused')).toBe(false);
		});
		expect(dock.isMaximized()).toBe(false);
		expect(shape()).toBe(before);
		// Closing and reopening a panel lands in its home group (DK-050).
		act(() => dock.close('history-1'));
		expect(dock.isOpen('history')).toBe(false);
		act(() => {
			dock.focus('history');
		});
		expect(dock.panelOf('history')?.group.panels.map((p) => p.id)).toContain('project-1');
		expect(focusStore.getState().kind).toBe('history');
		// Closing the focused panel through dockview itself (tab ×) drops the stale focus (FO-001).
		act(() => dock.panelOf('history')?.api.close());
		expect(focusStore.getState().instanceId).toBeNull();
		// Focus cycling with nothing focused: backward starts at the last panel in reading order (FO-003).
		act(() => dock.cycleFocus(-1));
		expect(focusStore.getState().instanceId).toBe(dock.readingOrder().at(-1)?.id);
		// AC-SH-7: closing everything leaves an empty dock; the factory layout comes back on reset.
		act(() => {
			for (const k of dock.openKinds()) dock.close(`${k}-1`);
		});
		expect(dock.openKinds()).toHaveLength(0);
		act(() => dock.apply('editing', store.resetToSaved('editing')));
		expect(dock.isOpen('program')).toBe(true);
	});
});

// ------------------------------------------------------------------ misc

describe('shell helpers', () => {
	it('layout modes (S05 §19.1)', () => {
		expect(computeLayoutMode({ width: 1920, height: 1080, coarse: false })).toBe('desktop');
		expect(computeLayoutMode({ width: 1100, height: 800, coarse: false })).toBe('compact');
		expect(computeLayoutMode({ width: 1024, height: 768, coarse: true })).toBe('tablet');
		expect(computeLayoutMode({ width: 390, height: 844, coarse: true })).toBe('phone');
		expect(computeLayoutMode({ width: 390, height: 844, coarse: true, forced: 'desktop' })).toBe('desktop');
	});
	it('prefs parse tolerantly', () => {
		expect(parsePrefs({ theme: 'dark', contrast: 'weird' })).toMatchObject({
			theme: 'dark',
			contrast: 'normal',
		});
		expect(parsePrefs(null).theme).toBe('darkest');
	});
	it('palette fuzzy search and prefixes (MN-041/042)', () => {
		expect(fuzzyScore('razor', 'Razor Tool')).not.toBeNull();
		expect(fuzzyScore('rzr', 'Razor Tool')).not.toBeNull();
		expect(fuzzyScore('xyz', 'Razor Tool')).toBeNull();
		expect(fuzzyScore('raz', 'Razor Tool')! > fuzzyScore('raz', 'Graze a Zone')!).toBe(true);
		expect(parsePaletteQuery(':00:01:10:00')).toEqual({ prefix: ':', text: '00:01:10:00' });
		expect(parsePaletteQuery('make it punchier')).toEqual({ prefix: null, text: 'make it punchier' });
	});
});

describe('toast adapter', () => {
	beforeEach(() => toasts.dismissAll());
	it('command toasts become design-system toasts with actions', async () => {
		const { adaptToast } = await import('../src/shell/context.tsx');
		const run = vi.fn();
		adaptToast(
			{ kind: 'error', message: 'Save failed', action: { label: 'Retry', command: 'file.save' } },
			run,
		);
		const t = toasts.getState().toasts.at(-1)!;
		expect(t.title).toBe('Save failed');
		t.actions?.[0]?.run?.();
		expect(run).toHaveBeenCalledWith('file.save', undefined);
	});
});

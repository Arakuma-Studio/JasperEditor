// polish: every menu entry (menubar, Workspaces menu, panel menus) and every default key binding resolves to a
// registered command. An entry may be limited to a runtime (File ▸ Exit is desktop-only), but it is still wired.
import { beforeAll, describe, expect, it } from 'vitest';
import { getCommand, registerAllCommands } from '../src/commands/index.ts';
import { DEFAULT_KEYMAP } from '../src/commands/keymap-defaults.ts';
import { listPanels } from '../src/panels/registry.ts';
import { MENUBAR, WORKSPACES_MENU } from '../src/shell/menus/model.ts';
import type { ShellMenuItem } from '../src/shell/menus/resolve.ts';

beforeAll(() => registerAllCommands());

type AnyItem = ShellMenuItem | { type: string; command?: string; label?: string; items?: AnyItem[] };

function commandEntries(items: readonly AnyItem[], path: string): { id: string; where: string }[] {
	const out: { id: string; where: string }[] = [];
	for (const item of items) {
		if (item.type === 'command' && 'command' in item && item.command)
			out.push({ id: item.command, where: `${path} ▸ ${item.label ?? item.command}` });
		else if (item.type === 'submenu' && 'items' in item && item.items)
			out.push(...commandEntries(item.items, `${path} ▸ ${item.label ?? ''}`));
	}
	return out;
}

describe('menu wiring', () => {
	it('every menubar entry resolves to a registered command', () => {
		const entries = MENUBAR.flatMap((m) => commandEntries(m.items, m.label));
		expect(entries.length).toBeGreaterThan(250);
		const missing = entries.filter((e) => !getCommand(e.id)).map((e) => `${e.where} [${e.id}]`);
		expect(missing).toEqual([]);
	});

	it('runtime-limited entries are wired too (hidden elsewhere, never dead)', () => {
		const limited = MENUBAR.flatMap((m) => m.items).filter(
			(i): i is Extract<ShellMenuItem, { type: 'command' }> => i.type === 'command' && !!i.runtimes,
		);
		expect(limited.map((i) => i.command)).toContain('app.quit');
		for (const i of limited) expect(getCommand(i.command), i.command).toBeTruthy();
	});

	it('the Workspaces menu and every panel menu resolve to registered commands', () => {
		const entries = [
			...commandEntries(WORKSPACES_MENU, 'Workspaces'),
			...listPanels().flatMap((p) => commandEntries((p.menu ?? []) as AnyItem[], `panel ${p.kind}`)),
		];
		const missing = entries.filter((e) => !getCommand(e.id)).map((e) => `${e.where} [${e.id}]`);
		expect(missing).toEqual([]);
	});

	it('every default key binding resolves to a registered command', () => {
		const missing = [...new Set(DEFAULT_KEYMAP.map((b) => b.command))].filter((id) => !getCommand(id));
		expect(missing).toEqual([]);
	});

	it('the five entries that used to render disabled are registered', () => {
		for (const id of [
			'project.importFromMediaBrowser',
			'engine.connect',
			'engine.status',
			'mg.editParameters',
			'app.notices',
			'panel.open.mediaBrowser',
		])
			expect(getCommand(id), id).toBeTruthy();
	});
});

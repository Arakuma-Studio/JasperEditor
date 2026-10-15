import { EngineClient } from '@jasper/engine-client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	createCommandContext,
	effectiveKey,
	getActiveKeymap,
	listCommands,
	normalizeChord,
	type Platform,
	type Runtime,
	registerAllCommands,
	resolveBindings,
	runCommand,
} from '../src/commands/index.ts';
import { LAYOUTS, layoutKeymap } from '../src/commands/keymap-presets.ts';
import { SPRING_HOLD_MS } from '../src/commands/timeline.ts';
import { resolveKey } from '../src/shell/keymap/dispatcher.ts';
import { KeyboardShortcutsDialog } from '../src/shell/keymap/KeyboardShortcutsDialog.tsx';
import {
	assignShortcut,
	chordAllowed,
	clearShortcuts,
	conflictsFor,
	deleteCustomLayout,
	KEYMAP_STORAGE_KEY,
	keymapStore,
	parseKeymapPrefs,
	removeShortcut,
	resetShortcuts,
	saveLayoutAs,
	setLayout,
} from '../src/shell/keymap/store.ts';
import { makeSession } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => {
	localStorage.removeItem(KEYMAP_STORAGE_KEY);
	keymapStore.reload();
});
afterEach(() => cleanup());

const COMBOS: [Platform, Runtime][] = [
	['win', 'desktop'],
	['linux', 'web'],
	['mac', 'desktop'],
	['mac', 'web'],
];

function duplicates(keymap: ReturnType<typeof layoutKeymap>, platform: Platform, runtime: Runtime): string[] {
	const seen = new Map<string, string>();
	const contextual = new Set<string>();
	const dups: string[] = [];
	for (const b of keymap) {
		const key = effectiveKey(b, platform, runtime);
		if (!key) continue;
		const k = `${b.scope}|${normalizeChord(key)}`;
		const prev = seen.get(k);
		if (prev && prev !== b.command && !b.contextual && !contextual.has(k))
			dups.push(`${k}: ${prev} vs ${b.command}`);
		if (b.contextual) contextual.add(k);
		seen.set(k, b.command);
	}
	return dups;
}

describe('keyboard layouts', () => {
	for (const l of LAYOUTS)
		for (const [platform, runtime] of COMBOS)
			it(`${l.label} has no conflicting chords (${platform}/${runtime})`, () => {
				expect(duplicates(layoutKeymap(l.id), platform, runtime)).toEqual([]);
			});
});

describe('shortcut store', () => {
	it('switching layouts changes resolution; edits make a "Custom" layout that persists', () => {
		const opts = { platform: 'win' as const, runtime: 'desktop' as const };
		expect(resolveBindings('F9', ['timeline', 'editing', 'global'], opts)).toEqual([]);
		setLayout('fcp7');
		expect(resolveBindings('F9', ['timeline', 'editing', 'global'], opts)[0]!.command).toBe(
			'timeline.insertFromSource',
		);
		const lost = assignShortcut('timeline.matchFrame', 'editing', 'KeyF', 'win', 'desktop');
		expect(lost).toEqual([]);
		expect(keymapStore.getState().layout).toBe('custom:Custom');
		const stored = parseKeymapPrefs(JSON.parse(localStorage.getItem(KEYMAP_STORAGE_KEY)!));
		expect(stored.layout).toBe('custom:Custom');
		expect(stored.custom.Custom!.base).toBe('fcp7');
		keymapStore.reload();
		expect(getActiveKeymap().some((b) => b.command === 'timeline.insertFromSource' && b.key === 'F9')).toBe(
			true,
		);
	});

	it('assigning a used chord takes it from the other command in that scope; shadows are reported', () => {
		const lost = assignShortcut('timeline.speedDuration', 'timeline', 'KeyG', 'win', 'desktop');
		expect(lost).toEqual(['timeline.audioGain']);
		expect(getActiveKeymap().some((b) => b.command === 'timeline.audioGain' && b.key === 'KeyG')).toBe(false);
		// KeyF is Match Frame in `editing`; binding it in the Timeline shadows it there.
		const c = conflictsFor(getActiveKeymap(), 'KeyF', 'timeline', 'win', 'desktop', 'timeline.speedDuration');
		expect(c).toEqual([
			{ command: 'timeline.matchFrame', scope: 'editing', shadow: true, contextual: false },
		]);
	});

	it('remove / clear / reset a command; custom layouts can be saved and deleted', () => {
		const b = getActiveKeymap().find((x) => x.command === 'timeline.matchFrame')!;
		removeShortcut(b);
		expect(getActiveKeymap().some((x) => x.command === 'timeline.matchFrame')).toBe(false);
		resetShortcuts('timeline.matchFrame');
		expect(getActiveKeymap().some((x) => x.command === 'timeline.matchFrame' && x.key === 'KeyF')).toBe(true);
		clearShortcuts('timeline.lift');
		expect(getActiveKeymap().some((x) => x.command === 'timeline.lift')).toBe(false);
		expect(saveLayoutAs('Editors')).toBeNull();
		expect(keymapStore.getState().layout).toBe('custom:Editors');
		expect(saveLayoutAs('Avid Media Composer')).toMatch(/built-in/);
		deleteCustomLayout('Editors');
		expect(keymapStore.getState().layout).toBe('premiere');
	});

	it('mac chords keep the exact chord; browser-reserved chords are refused in the web app', () => {
		assignShortcut('timeline.matchFrame', 'editing', 'Ctrl+KeyF', 'mac', 'desktop');
		const b = getActiveKeymap().find((x) => x.command === 'timeline.matchFrame' && x.mac)!;
		expect(b).toMatchObject({ key: 'Ctrl+KeyF', mac: 'Ctrl+KeyF' });
		expect(effectiveKey(b, 'mac', 'desktop')).toBe('Ctrl+KeyF');
		expect(chordAllowed('Ctrl+KeyT', 'win', 'web')).toMatch(/browser/);
		expect(chordAllowed('Ctrl+KeyT', 'win', 'desktop')).toBeNull();
		expect(chordAllowed('Shift+ShiftLeft', 'win', 'desktop')).toMatch(/modifiers/);
	});

	it('malformed stored prefs fall back safely', () => {
		expect(
			parseKeymapPrefs({ layout: 'custom:nope', custom: { x: { bindings: [{ command: 1 }] } } }),
		).toEqual({
			layout: 'premiere',
			custom: { x: { base: 'premiere', bindings: [] } },
		});
		expect(parseKeymapPrefs('garbage').layout).toBe('premiere');
	});
});

describe('dispatch details', () => {
	const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
	it('contextual chords: Ctrl+Alt+← slips without edit points (the trim binding is disabled)', () => {
		const { session } = makeSession();
		const ctx = createCommandContext({ engine, session, focus: { panel: 'timeline', instanceId: 't' } });
		const res = resolveKey('Ctrl+Alt+ArrowLeft', 'timeline', ctx, { platform: 'win', runtime: 'desktop' });
		expect(res?.command.id).toBe('timeline.slipLeft');
	});

	it('spring-loaded tools: a held key returns to the previous tool on release, a tap switches', async () => {
		const { session } = makeSession();
		const ctx = createCommandContext({ engine, session, focus: { panel: 'timeline', instanceId: 't' } });
		await runCommand('tool.razor', ctx);
		const cmd = listCommands().find((c) => c.id === 'tool.razor')!;
		cmd.onKeyUp!(ctx);
		expect(session.getState().toggles.activeTool).toBe('razor');
		await runCommand('tool.selection', ctx);
		await runCommand('tool.ripple', ctx);
		await new Promise((r) => setTimeout(r, SPRING_HOLD_MS + 20));
		listCommands().find((c) => c.id === 'tool.ripple')!.onKeyUp!(ctx);
		expect(session.getState().toggles.activeTool).toBe('selection');
	});
});

describe('Keyboard Shortcuts dialog', () => {
	it('searches, captures a new chord and reports the takeover', () => {
		render(<KeyboardShortcutsDialog platform="win" runtime="desktop" close={() => {}} />);
		fireEvent.change(screen.getByTestId('kb-search'), { target: { value: 'Speed/Duration' } });
		const add = screen.getByTestId('kb-add-timeline-timeline.speedDuration');
		fireEvent.click(add);
		expect(screen.getByTestId('kb-capture')).toBeTruthy();
		act(() => {
			fireEvent.keyDown(screen.getByTestId('kb-list'), { code: 'KeyG', key: 'g' });
		});
		expect(getActiveKeymap().some((b) => b.command === 'timeline.audioGain' && b.key === 'KeyG')).toBe(false);
		expect(getActiveKeymap().some((b) => b.command === 'timeline.speedDuration' && b.key === 'KeyG')).toBe(
			true,
		);
		fireEvent.click(screen.getByTestId('kb-undo'));
		expect(getActiveKeymap().some((b) => b.command === 'timeline.speedDuration' && b.key === 'KeyG')).toBe(
			false,
		);
	});
});

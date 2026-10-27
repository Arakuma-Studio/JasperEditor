// Spec 17 SC-080 entry points: "Fix Transcript…" and "Script…" are registered UI commands with no default shortcut
// (assignable), in Sequence ▸ Fix Transcript from Script… and the Text panel menu; disabled with a reason without a
// sequence or in a read-only project; the Review's new group keys (Shift+Enter, Shift+U) conflict with nothing.
import { describe, expect, it } from 'vitest';
import { getCommand, isCommandEnabled, registerAllCommands } from '../src/commands/index.ts';
import { DEFAULT_KEYMAP } from '../src/commands/keymap-defaults.ts';
import type { CommandCtx } from '../src/commands/types.ts';
import textPanel from '../src/panels/text/index.ts';
import { conflictsFor } from '../src/shell/keymap/store.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { fixSession } from './script-fix-helpers.ts';

registerAllCommands();

const ctxOf = (session: CommandCtx['session']): CommandCtx =>
	({
		session,
		focus: { panel: 'text', instanceId: null },
		capabilities: new Set(),
		services: { get: () => undefined },
		ui: { toast() {}, openDialog() {} },
	}) as never;

const commandsIn = (items: readonly unknown[]): string[] =>
	items.flatMap((i) => {
		const it = i as { type: string; command?: string; items?: unknown[] };
		return it.type === 'command' ? [it.command!] : it.type === 'submenu' ? commandsIn(it.items ?? []) : [];
	});

describe('Fix Transcript entry points (SC-080)', () => {
	it('registers the commands without default shortcuts', () => {
		for (const id of ['transcript.fix', 'transcript.script']) {
			const c = getCommand(id)!;
			expect(c, id).toBeTruthy();
			expect(c.scope).toBe('global');
			expect(c.agentExposed).toBe(true);
			expect(DEFAULT_KEYMAP.some((b) => b.command === id)).toBe(false);
		}
		expect(getCommand('transcript.fix')!.label).toBe('Fix Transcript…');
		expect(getCommand('transcript.script')!.label).toBe('Script…');
	});

	it('is in Sequence ▸ and in the Text panel menu', () => {
		const seq = MENUBAR.find((m) => m.id === 'sequence')!;
		expect(commandsIn(seq.items)).toContain('transcript.fix');
		const item = seq.items.find((i) => (i as { command?: string }).command === 'transcript.fix') as {
			label: string;
		};
		expect(item.label).toBe('Fix Transcript from Script…');
		expect(commandsIn(textPanel.menu ?? [])).toEqual(
			expect.arrayContaining(['transcript.fix', 'transcript.script']),
		);
	});

	it('is disabled with a reason without a sequence, and in a read-only project', () => {
		const fix = getCommand('transcript.fix')!;
		expect(isCommandEnabled(fix, ctxOf(null))).toBe(false);
		expect(fix.disabledReason?.(ctxOf(null))).toBe('Open a project first');
		const { session } = fixSession();
		expect(isCommandEnabled(fix, ctxOf(session))).toBe(true);
		// a newer-schema project opens read-only (the session's state; set directly here)
		(session.store as unknown as { setState(p: object): void }).setState({ readOnly: true });
		expect(isCommandEnabled(fix, ctxOf(session))).toBe(false);
		expect(fix.disabledReason?.(ctxOf(session))).toBe('The project is read-only');
	});

	it('the Review’s group keys conflict with nothing in its scope chain', () => {
		for (const [command, key] of [
			['proposals.acceptGroup', 'Shift+Enter'],
			['proposals.clearGroup', 'Shift+KeyU'],
		] as const) {
			expect(DEFAULT_KEYMAP.find((b) => b.command === command)).toMatchObject({ key, scope: 'review' });
			for (const platform of ['win', 'mac'] as const)
				for (const runtime of ['desktop', 'web'] as const)
					expect(conflictsFor(DEFAULT_KEYMAP, key, 'review', platform, runtime, command)).toEqual([]);
		}
	});
});

// The Review keymap scope inside widgets the keyboard dispatcher leaves alone (a `role="listbox"` is an overlay to it,
// S05 §18): the widget resolves the key along the scope chain itself, so the shortcuts stay rebindable and shown in
// Keyboard Shortcuts (as the Sound Library's result list does).
import type { KeyboardEvent } from 'react';
import { chordFromEvent, resolveBindings, scopeChain } from '../commands/keymap-defaults.ts';
import { getCommand, isCommandEnabled, runCommand } from '../commands/registry.ts';
import type { CommandCtx, CommandScope } from '../commands/types.ts';

/** Runs the first enabled command bound to the key in `scope` (then its chain); true when one ran. */
export function runScopedKey(
	e: KeyboardEvent,
	scope: CommandScope,
	ctx: CommandCtx,
	env: { platform?: 'win' | 'linux' | 'mac'; runtime?: 'web' | 'pwa' | 'desktop' } = {},
): boolean {
	const platform = env.platform ?? 'linux';
	const chord = chordFromEvent(e.nativeEvent, platform);
	for (const b of resolveBindings(chord, scopeChain(scope), { platform, runtime: env.runtime ?? 'web' })) {
		const cmd = getCommand(b.command);
		if (!cmd || !isCommandEnabled(cmd, ctx)) continue;
		e.preventDefault();
		e.stopPropagation();
		if (e.repeat && !b.repeat && !cmd.repeat) return true;
		void runCommand(b.command, ctx, b.args);
		return true;
	}
	return false;
}

/** Keys a focused button / field handles itself (activation, typing): they never reach the keymap from there. */
export function isOwnKey(e: KeyboardEvent): boolean {
	const el = e.target as HTMLElement | null;
	if (!el || typeof el.closest !== 'function') return false;
	const tag = el.tagName;
	const field = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable;
	if (field) return !(e.ctrlKey || e.metaKey) || e.key !== 'Enter';
	const control = !!el.closest('button,[role="button"],[role="combobox"],[role="menuitem"],a[href]');
	return control && (e.key === 'Enter' || e.key === ' ' || e.code === 'NumpadEnter');
}

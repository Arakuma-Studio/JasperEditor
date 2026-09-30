// Command plumbing for the monitors: a CommandCtx for buttons, command-with-fallback for ids owned by
// other packages (timeline.markIn…), and a keyboard fallback for when no global keymap dispatcher
// handled the event (the WP-2A dispatcher runs in the capture phase and calls preventDefault on the
// events it handles, so this bubble-phase handler only acts on unhandled keys).
import { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { useMemo } from 'react';
import {
	chordFromEvent,
	createCommandContext,
	getCommand,
	isCommandEnabled,
	type Platform,
	resolveBindings,
	runCommand,
	scopeChain,
} from '../../commands/index.ts';
import type { CommandCtx } from '../../commands/types.ts';
import { PanelServices } from '../../state/panel-services.ts';
import type { PanelKind } from '../types.ts';

let services = new PanelServices();

/** The shell (WP-2A) passes its PanelServices here so monitors publish into the shared registry. */
export function setMonitorPanelServices(s: PanelServices): void {
	services = s;
}

export function monitorPanelServices(): PanelServices {
	return services;
}

const fallbackEngine = new EngineClient({ baseUrl: '' });

export function useMonitorCommandCtx(opts: {
	session: EditorSession;
	panel: PanelKind;
	instanceId: string;
	engine?: EngineClient | null;
}): CommandCtx {
	const { session, panel, instanceId, engine } = opts;
	return useMemo(
		() =>
			createCommandContext({
				engine: engine ?? fallbackEngine,
				session,
				transport: session.transport,
				focus: { panel, instanceId },
				services,
				capabilities: ['engine'],
				toast: (r) => console.info(`[${panel}] ${r.kind}: ${r.message}${r.detail ? ` — ${r.detail}` : ''}`),
			}),
		[engine, session, panel, instanceId],
	);
}

/** Runs a command; when it is not registered (owner package not merged yet) runs `fallback`. */
export async function runWithFallback(
	id: string,
	ctx: CommandCtx,
	fallback: () => void,
	args?: unknown,
): Promise<void> {
	const r = await runCommand(id, ctx, args);
	if (!r.ran && r.reason === 'unknown') fallback();
}

export function detectPlatform(): Platform {
	const p = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '';
	if (/Mac|iPhone|iPad/i.test(p)) return 'mac';
	if (/Win/i.test(p)) return 'win';
	return 'linux';
}

function isEditable(t: EventTarget | null): boolean {
	const el = t as HTMLElement | null;
	if (!el || typeof el.tagName !== 'string') return false;
	return (
		el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
	);
}

type KeyLike = Pick<
	KeyboardEvent,
	| 'code'
	| 'ctrlKey'
	| 'altKey'
	| 'shiftKey'
	| 'metaKey'
	| 'repeat'
	| 'target'
	| 'defaultPrevented'
	| 'preventDefault'
>;

/**
 * Keyboard fallback for a focused monitor: resolves the chord along panel → editing → global and
 * runs the first enabled registered command. Returns true when handled.
 */
export function handleMonitorKey(
	e: KeyLike,
	phase: 'down' | 'up',
	ctx: CommandCtx,
	panel: PanelKind,
	platform: Platform = detectPlatform(),
): boolean {
	if (e.defaultPrevented || isEditable(e.target)) return false;
	const chord = chordFromEvent(e, platform);
	const bindings = resolveBindings(chord, scopeChain(panel), { platform, runtime: 'web' });
	for (const b of bindings) {
		const cmd = getCommand(b.command);
		if (!cmd) continue;
		if (phase === 'up') {
			if (!b.keyup || !cmd.onKeyUp) continue;
			e.preventDefault();
			cmd.onKeyUp(ctx);
			return true;
		}
		if (!isCommandEnabled(cmd, ctx)) continue;
		e.preventDefault();
		if (e.repeat && !b.repeat) return true;
		void runCommand(b.command, ctx, b.args);
		return true;
	}
	return false;
}

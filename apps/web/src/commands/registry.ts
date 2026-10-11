import { AGENT_UI_REFUSED_COMMANDS, agentInputActive } from '../agent-bridge/agent-input.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

const commands = new Map<string, UiCommand>();
const listeners = new Set<() => void>();

function notify() {
	for (const l of [...listeners]) l();
}

/** Registers commands; returns an unregister function. Re-registering an id replaces it. */
export function registerCommands(list: readonly UiCommand[]): () => void {
	for (const c of list) commands.set(c.id, c);
	notify();
	return () => {
		for (const c of list) if (commands.get(c.id) === c) commands.delete(c.id);
		notify();
	};
}

export function getCommand(id: string): UiCommand | undefined {
	return commands.get(id);
}

export function listCommands(filter?: { scope?: CommandScope; agentExposed?: boolean }): UiCommand[] {
	return [...commands.values()].filter(
		(c) =>
			(!filter?.scope || c.scope === filter.scope) &&
			(filter?.agentExposed === undefined || !!c.agentExposed === filter.agentExposed),
	);
}

export function subscribeCommands(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Enabled = capability present (S05:SH-031 keeps it visible but disabled) and `when` passes. */
export function isCommandEnabled(cmd: UiCommand, ctx: CommandCtx): boolean {
	if (cmd.capability && !ctx.capabilities.has(cmd.capability)) return false;
	try {
		return cmd.when ? cmd.when(ctx) : true;
	} catch {
		return false;
	}
}

export function isCommandChecked(cmd: UiCommand, ctx: CommandCtx): boolean {
	try {
		return cmd.checked ? cmd.checked(ctx) : false;
	} catch {
		return false;
	}
}

export type RunResult = {
	ran: boolean;
	reason?: 'unknown' | 'disabled' | 'invalid-args' | 'error';
	error?: unknown;
};

const beforeRun = new Set<(id: string, ctx: CommandCtx) => void>();

/**
 * Called before every command runs (edit-ux: a dynamic J/K/L trim in progress commits first, as in Premiere and
 * FilmCraft, so another command never runs on top of the open trim gesture). Returns the unregister function.
 */
export function onBeforeCommand(fn: (id: string, ctx: CommandCtx) => void): () => void {
	beforeRun.add(fn);
	return () => beforeRun.delete(fn);
}

/** Runs a command by id (menus, palette, keymap, agents all go through here, S05:KB-001). */
export async function runCommand(id: string, ctx: CommandCtx, args?: unknown): Promise<RunResult> {
	const cmd = commands.get(id);
	if (!cmd) return { ran: false, reason: 'unknown' };
	try {
		for (const fn of [...beforeRun]) fn(id, ctx);
		if (!isCommandEnabled(cmd, ctx)) return { ran: false, reason: 'disabled' };
		// Irreversible commands outside undo history require a human action.
		if (AGENT_UI_REFUSED_COMMANDS.has(id) && agentInputActive()) {
			const error = new Error(`${cmd.label} cannot be run by agent UI automation; ask the user to run it`);
			ctx.ui.toast({ kind: 'warning', message: `${cmd.label}: refused for an agent`, detail: error.message });
			return { ran: false, reason: 'error', error };
		}
		if (cmd.argsSchema) {
			const parsed = cmd.argsSchema.safeParse(args);
			if (!parsed.success) return { ran: false, reason: 'invalid-args', error: parsed.error };
			args = parsed.data;
		}
		await cmd.run(ctx, args);
		return { ran: true };
	} catch (error) {
		ctx.ui.toast({
			kind: 'error',
			message: `${cmd.label} failed`,
			detail: error instanceof Error ? error.message : String(error),
		});
		return { ran: false, reason: 'error', error };
	}
}

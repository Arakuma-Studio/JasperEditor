// UI command registry (ARCHITECTURE §7.3, S05 §18): register, look up, evaluate and run commands.
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

/** Runs a command by id (menus, palette, keymap, agents all go through here, S05:KB-001). */
export async function runCommand(id: string, ctx: CommandCtx, args?: unknown): Promise<RunResult> {
	const cmd = commands.get(id);
	if (!cmd) return { ran: false, reason: 'unknown' };
	if (!isCommandEnabled(cmd, ctx)) return { ran: false, reason: 'disabled' };
	if (cmd.argsSchema) {
		const parsed = cmd.argsSchema.safeParse(args);
		if (!parsed.success) return { ran: false, reason: 'invalid-args', error: parsed.error };
		args = parsed.data;
	}
	try {
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

/** Test helper: removes every registered command. */
export function resetCommandRegistry(): void {
	commands.clear();
	notify();
}

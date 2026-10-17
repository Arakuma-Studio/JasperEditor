import type { EditorSession } from '@jasper/session';
import type { PanelKind } from '../panels/types.ts';
import { redoMenuLabel, undoMenuLabel } from '../shell/history-labels.ts';
import { getCommand, isCommandEnabled, runCommand } from './registry.ts';
import type { CommandCtx, UiCommand } from './types.ts';

/** Label of the step that Undo would revert, or null. */
function undoLabel(session: EditorSession | null): string | null {
	const h = session?.getState().history;
	return h?.canUndo ? (h.entries[h.index - 1]?.label ?? null) : null;
}

/** Label of the step that Redo would re-apply, or null. */
function redoLabel(session: EditorSession | null): string | null {
	const h = session?.getState().history;
	return h?.canRedo ? (h.entries[h.index]?.label ?? null) : null;
}

function blocked(ctx: CommandCtx): string | undefined {
	const s = ctx.session?.getState();
	if (!ctx.session || !s) return 'Open a project first';
	if (s.readOnly) return 'The project is open read-only';
	if (s.gesture) return 'Finish the current drag first';
	return undefined;
}

/** Edit ▸ Clear / Delete routes to the focused panel's delete command (integration of WP-2B/2D/2E). */
const CLEAR_BY_PANEL: Partial<Record<PanelKind, string>> = {
	project: 'project.deleteItems',
	timeline: 'timeline.clear',
	effectControls: 'effectControls.removeEffect',
};

function clearTarget(ctx: CommandCtx): UiCommand | undefined {
	const id = ctx.focus.panel ? CLEAR_BY_PANEL[ctx.focus.panel] : undefined;
	const cmd = id ? getCommand(id) : undefined;
	return cmd && isCommandEnabled(cmd, ctx) ? cmd : undefined;
}

export const editCommands: UiCommand[] = [
	{
		id: 'edit.clear',
		label: 'Clear',
		description: 'Delete the selection in the focused panel',
		scope: 'global',
		when: (ctx) => !!clearTarget(ctx),
		disabledReason: (ctx) => blocked(ctx) ?? 'Nothing to clear in this panel',
		run: async (ctx) => {
			const target = clearTarget(ctx);
			if (target) await runCommand(target.id, ctx);
		},
	},
	{
		id: 'history.undo',
		label: 'Undo',
		icon: 'app.reset',
		scope: 'global',
		repeat: true,
		agentExposed: true,
		labelFor: (ctx) => {
			const l = undoLabel(ctx.session);
			return undoMenuLabel(l);
		},
		when: (ctx) => !blocked(ctx) && !!ctx.session?.getState().history.canUndo,
		disabledReason: (ctx) => blocked(ctx) ?? 'Nothing to undo',
		run: (ctx) => {
			const r = ctx.session?.undo();
			if (r && !r.ok) ctx.ui.toast({ kind: 'warning', message: 'Cannot undo', detail: r.code });
		},
	},
	{
		id: 'history.redo',
		label: 'Redo',
		scope: 'global',
		repeat: true,
		agentExposed: true,
		labelFor: (ctx) => {
			const l = redoLabel(ctx.session);
			return redoMenuLabel(l);
		},
		when: (ctx) => !blocked(ctx) && !!ctx.session?.getState().history.canRedo,
		disabledReason: (ctx) => blocked(ctx) ?? 'Nothing to redo',
		run: (ctx) => {
			const r = ctx.session?.redo();
			if (r && !r.ok) ctx.ui.toast({ kind: 'warning', message: 'Cannot redo', detail: r.code });
		},
	},
];

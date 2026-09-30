// edit UI commands — owned by WP-2A: undo/redo with history step names in their labels (S05:MN-011,
// S01 §17). Clipboard/selection commands (edit.cut, edit.copy…) belong to the panels that own the
// selection (timeline.*, project.*) and stay inert here until registered.
import type { EditorSession } from '@jasper/session';
import type { CommandCtx, UiCommand } from './types.ts';

function historyOf(session: EditorSession | null) {
	return session?.getState().history ?? null;
}

/** Label of the step that Undo would revert, or null. */
export function undoLabel(session: EditorSession | null): string | null {
	const h = historyOf(session);
	return h?.canUndo ? (h.entries[h.index - 1]?.label ?? null) : null;
}

/** Label of the step that Redo would re-apply, or null. */
export function redoLabel(session: EditorSession | null): string | null {
	const h = historyOf(session);
	return h?.canRedo ? (h.entries[h.index]?.label ?? null) : null;
}

function blocked(ctx: CommandCtx): string | undefined {
	const s = ctx.session?.getState();
	if (!ctx.session || !s) return 'Open a project first';
	if (s.readOnly) return 'The project is open read-only';
	if (s.gesture) return 'Finish the current drag first';
	return undefined;
}

export const editCommands: UiCommand[] = [
	{
		id: 'history.undo',
		label: 'Undo',
		icon: 'app.reset',
		scope: 'global',
		repeat: true,
		agentExposed: true,
		labelFor: (ctx) => {
			const l = undoLabel(ctx.session);
			return l ? `Undo ${l}` : 'Undo';
		},
		when: (ctx) => !blocked(ctx) && !!historyOf(ctx.session)?.canUndo,
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
			return l ? `Redo ${l}` : 'Redo';
		},
		when: (ctx) => !blocked(ctx) && !!historyOf(ctx.session)?.canRedo,
		disabledReason: (ctx) => blocked(ctx) ?? 'Nothing to redo',
		run: (ctx) => {
			const r = ctx.session?.redo();
			if (r && !r.ok) ctx.ui.toast({ kind: 'warning', message: 'Cannot redo', detail: r.code });
		},
	},
];

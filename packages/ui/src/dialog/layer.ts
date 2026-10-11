// Overlay layering inside dialogs (S05:DT-030): popovers (Select lists, …) portal to <body> with
// `--pr-z-popover`, which is below `--pr-z-dialog`; opened from inside a dialog they must stack above it, or the
// dialog's scrim covers them. Dialog provides `InDialogContext`; popover primitives pick `popoverZClass()`.
import { createContext, useContext } from 'react';

export const InDialogContext = createContext(false);

export function useInDialog(): boolean {
	return useContext(InDialogContext);
}

export function popoverZClass(inDialog: boolean): string {
	return inDialog ? 'z-[calc(var(--pr-z-dialog)+10)]' : 'z-[var(--pr-z-popover)]';
}

/**
 * Mark a field inside a Dialog with `{[DIALOG_ESCAPE_REVERTS]: 'true'}` while it holds uncommitted text: the
 * first Esc then reverts the field (its own keydown handler) and keeps the dialog open; a second Esc, or Esc
 * with nothing being edited, closes the dialog (standard editor behaviour).
 */
export const DIALOG_ESCAPE_REVERTS = 'data-escape-reverts';

export function escapeRevertsField(target: EventTarget | null): boolean {
	const el = target as { closest?(selector: string): Element | null } | null;
	return !!el?.closest?.(`[${DIALOG_ESCAPE_REVERTS}="true"]`);
}

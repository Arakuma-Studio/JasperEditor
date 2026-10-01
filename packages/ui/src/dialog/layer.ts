// Overlay layering inside dialogs (S05:DT-030): popovers (Select lists, …) portal to <body> with
// `--pr-z-popover`, which is below `--pr-z-dialog`; opened from inside a dialog they must stack above it, or the
// dialog's scrim covers them. Dialog provides `InDialogContext`; popover primitives pick `popoverZClass()`.
import { createContext, useContext } from 'react';

export const InDialogContext = createContext(false);

/** True inside a Dialog's content. */
export function useInDialog(): boolean {
	return useContext(InDialogContext);
}

/** The z-index class of a popover: the popover layer, or just above the dialog layer inside a dialog. */
export function popoverZClass(inDialog: boolean): string {
	return inDialog ? 'z-[calc(var(--pr-z-dialog)+10)]' : 'z-[var(--pr-z-popover)]';
}

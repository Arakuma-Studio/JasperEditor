// The modal dialogs open in this window (their content elements), for overlays that must stay clear of a dialog's
// actions: toasts are always visible, above dialogs (S05:DT-030), but never over a dialog's title bar (its close
// button) or footer (Cancel / OK / Export) — wp-note sound-design "final carry-over cleanup", item 2.

const open: HTMLElement[] = [];
let snapshot: readonly HTMLElement[] = [];
const listeners = new Set<() => void>();
const emit = () => {
	snapshot = [...open];
	for (const l of [...listeners]) l();
};

/** Registers an open modal's content element; returns the unregister function. */
export function registerModal(el: HTMLElement): () => void {
	if (!open.includes(el)) {
		open.push(el);
		emit();
	}
	return () => {
		const i = open.indexOf(el);
		if (i >= 0) {
			open.splice(i, 1);
			emit();
		}
	};
}

export function subscribeModals(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The open modals, oldest first (a stable array between changes, for `useSyncExternalStore`). */
export function openModals(): readonly HTMLElement[] {
	return snapshot;
}

/** Marks a dialog's title bar (its close button). */
export const MODAL_HEADER_ATTR = 'data-dialog-header';
/** Marks a dialog's footer (its buttons). */
export const MODAL_ACTIONS_ATTR = 'data-dialog-actions';
/** Marks the toast host (and its "+N more" log): a click there is not a click outside a modal. */
export const TOAST_HOST_ATTR = 'data-toast-host';

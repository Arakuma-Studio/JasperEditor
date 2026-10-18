// Where the toast stack goes when a modal dialog is open (wp-note sound-design "final carry-over cleanup", item 2).
// Toasts are bottom-right, 16 px from the edges (S05:TS-001), and always visible, above dialogs (S05:DT-030) — but a
// toast must never cover what the user has to click in a modal: its footer (Cancel / OK / Export) and its title bar
// (the close button). Premiere's notifications live in the main window, which a modal dialog blocks; here they stay
// readable and move out of the way instead:
//   1. where they are, when that is clear of every open dialog;
//   2. else in the same column above the dialogs, when they fit there;
//   3. else between the dialog's title bar and its footer (the stack's height capped, the newest toasts kept).
// Pure.
import type { Rect } from '../menu/placement.ts';

export type ModalBox = { rect: Rect; header: Rect | null; actions: Rect | null };
export type ToastPlacement = {
	/** Distance of the stack's bottom edge from the window's bottom (px). */
	bottom: number;
	/** Cap on the stack's height (older toasts clipped at the top), or null. */
	maxHeight: number | null;
	/** Why it moved: not at all, above the dialogs, or between a dialog's title bar and footer. */
	avoided: 'none' | 'dialog' | 'actions';
};

/** The stack's distance from the right and bottom edges (S05:TS-001). */
export const TOAST_EDGE = 16;
/** Space kept between the stack and a dialog (px). */
export const TOAST_DIALOG_GAP = 8;

export function placeToasts(
	view: { width: number; height: number },
	stack: { width: number; height: number },
	baseBottom: number,
	modals: readonly ModalBox[],
	/** The stack's distance from the right edge. */
	rightEdge: number = TOAST_EDGE,
): ToastPlacement {
	const H = view.height;
	const G = TOAST_DIALOG_GAP;
	const right = view.width - rightEdge;
	const left = right - stack.width;
	const inColumn = (r: Rect | null): r is Rect => !!r && r.left < right + G && r.right > left - G;
	const covers = (r: Rect, bottom: number) =>
		inColumn(r) && r.top - G < H - bottom && r.bottom + G > H - bottom - stack.height;
	const none: ToastPlacement = { bottom: baseBottom, maxHeight: null, avoided: 'none' };
	if (stack.height <= 0 || stack.width <= 0) return none;
	const hit = modals.filter((m) => covers(m.rect, baseBottom));
	if (!hit.length) return none;
	// 2. above every dialog in the column
	const column = modals.filter((m) => inColumn(m.rect));
	const top = Math.min(...column.map((m) => m.rect.top));
	const above = H - top + G;
	if (H - above - stack.height >= G && above >= baseBottom)
		return { bottom: above, maxHeight: null, avoided: 'dialog' };
	// 3. between the title bars and the footers of the dialogs in the column
	let low = H - baseBottom;
	let high = G;
	for (const m of column) {
		if (inColumn(m.actions) && m.actions.top - G < low) low = m.actions.top - G;
		if (inColumn(m.header) && m.header.bottom + G > high) high = m.header.bottom + G;
	}
	const room = Math.max(0, low - high);
	return { bottom: H - low, maxHeight: room >= stack.height ? null : room, avoided: 'actions' };
}

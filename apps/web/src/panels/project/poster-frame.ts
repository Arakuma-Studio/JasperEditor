// polish (Premiere: Set / Clear Poster Frame, Shift+P / Alt+Shift+P): the frame a media item shows as its thumbnail
// in the Project panel's icon view. The frame is the one under the pointer while hover-scrubbing a thumbnail; the
// document keeps it on the item (`item.setPoster`, undoable).
import type { MediaItem } from '@jasper/project';
import type { EditorSession } from '@jasper/session';

/** The thumbnail being hover-scrubbed right now and the media time (seconds) of the frame it shows. */
let hover: { itemId: string; seconds: number } | null = null;

export function setPosterHover(itemId: string, seconds: number): void {
	hover = { itemId, seconds };
}
export function clearPosterHover(itemId: string): void {
	if (hover?.itemId === itemId) hover = null;
}
export const posterHover = (): { itemId: string; seconds: number } | null => hover;

/** Media items of the Project panel selection that have a poster frame of their own. */
export function selectedPosterItems(session: EditorSession): string[] {
	const s = session.getState();
	return s.selection.project.items.filter(
		(id) =>
			(s.document.items[id] as MediaItem | undefined)?.kind === 'media' &&
			!!(s.document.items[id] as MediaItem).poster,
	);
}

/** Sets the hovered frame as the poster of its item; false when no thumbnail is being scrubbed. */
export function setPosterFromHover(session: EditorSession): boolean {
	const h = hover;
	if (!h || session.getState().document.items[h.itemId]?.kind !== 'media') return false;
	const r = session.apply({
		label: 'Set Poster Frame',
		origin: 'user',
		commands: [{ type: 'item.setPoster', itemId: h.itemId, time: { seconds: Math.max(0, h.seconds) } }],
	});
	if (!r.ok) throw new Error(r.errors[0]?.message ?? 'Could not set the poster frame');
	return true;
}

/** Clears the poster frame of the hovered item, else of the selected items; the number of items cleared. */
export function clearPosterFrames(session: EditorSession): number {
	const doc = session.getState().document;
	const hovered = hover && (doc.items[hover.itemId] as MediaItem | undefined)?.poster ? [hover.itemId] : [];
	const ids = hovered.length ? hovered : selectedPosterItems(session);
	if (!ids.length) return 0;
	const r = session.apply({
		label: 'Clear Poster Frame',
		origin: 'user',
		commands: ids.map((itemId) => ({ type: 'item.setPoster', itemId, time: null })),
	});
	if (!r.ok) throw new Error(r.errors[0]?.message ?? 'Could not clear the poster frame');
	return ids.length;
}

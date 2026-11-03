// In-place text entry on the Program monitor (spec 19 TL-085): which entry is open. One at a time; the overlay
// (TextEntryEditor.tsx) renders it on the Program monitor of `session`. Opening a second one finishes the first.
import type { TextRun, Vec2 } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { createStore } from 'zustand/vanilla';

export type TextEntry = {
	session: EditorSession;
	/** The text clip being edited; null = a new text at `point`. */
	clipId: string | null;
	/** Sequence pixel the caret was placed at. */
	point: Vec2;
	/** Sequence frame shown when the entry opened. */
	frame: number;
	/** Client pixel of the click, to put the caret under it. */
	client: Vec2 | null;
	/** What an earlier editor held when it failed: nothing typed is lost (AGENTS §0). */
	recovered?: { text: string; runs: TextRun[] };
	/** Increments per start (remounts the editor). */
	seq: number;
};

export const textEntryStore = createStore<{ current: TextEntry | null }>(() => ({ current: null }));

let seq = 0;

export function startTextEntry(e: Omit<TextEntry, 'seq'>): void {
	textEntryStore.setState({ current: { ...e, seq: ++seq } });
}

/** Closes the entry `s` (a newer one opened meanwhile stays). */
export function endTextEntry(s: number): void {
	const cur = textEntryStore.getState().current;
	if (cur?.seq === s) textEntryStore.setState({ current: null });
}

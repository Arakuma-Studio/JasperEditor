// Program-monitor text editing of anime templates (WP7b canvas-edit): which clip and param the in-place editor is open
// on, or a short message at the double-clicked point (locked track, read-only project). One editor at a time; the
// overlay (TemplateTextEditor.tsx) renders it on the Program monitor of `session`.
import type { Vec2 } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { createStore } from 'zustand/vanilla';

export type TemplateTextEdit = {
	kind: 'edit';
	session: EditorSession;
	clipId: string;
	param: string;
	/** The param holds word-marks markup (`data-template-marks="true"`). */
	marks: boolean;
	/** Which of the clip's elements drawing `param` (document order) was double-clicked. */
	ordinal: number;
	/** Sequence pixel that was double-clicked. */
	point: Vec2;
	/** Where in the element (0…1 of its box) the double-click landed: the caret goes to the word there. */
	at: Vec2 | null;
	/** Increments per start (remounts the editor). */
	seq: number;
};

export type TemplateEditMessage = {
	kind: 'message';
	session: EditorSession;
	text: string;
	point: Vec2;
	seq: number;
};

export type TemplateEditState = TemplateTextEdit | TemplateEditMessage;

export const templateEditStore = createStore<{ current: TemplateEditState | null }>(() => ({
	current: null,
}));

let seq = 0;

export function startTemplateTextEdit(e: Omit<TemplateTextEdit, 'kind' | 'seq'>): void {
	templateEditStore.setState({ current: { ...e, kind: 'edit', seq: ++seq } });
}

export function showTemplateEditMessage(session: EditorSession, text: string, point: Vec2): void {
	templateEditStore.setState({ current: { kind: 'message', session, text, point, seq: ++seq } });
}

/** Closes the editor (or message) `s` (any when omitted); a newer one opened meanwhile stays. */
export function endTemplateEdit(s?: number): void {
	const cur = templateEditStore.getState().current;
	if (cur && (s === undefined || cur.seq === s)) templateEditStore.setState({ current: null });
}

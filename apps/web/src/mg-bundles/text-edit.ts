// On-canvas editing state of composition texts (M3, wp-m3-mgtext, S08:MGU-005): which clip/text the Program
// monitor's in-place editor is open on, started by a double-click on the layer (TransformOverlay →
// `layerDoubleClickHandlers`) or by "Edit on canvas" in Properties ▸ Composition. One editor at a time.
import type { EditorSession } from '@jasper/session';
import { createStore } from 'zustand/vanilla';

export type CanvasTextEdit = {
	session: EditorSession;
	clipId: string;
	/** The text to edit (prop path); null = the text under `point`. */
	path: string[] | null;
	/** Sequence pixel that was double-clicked. */
	point: [number, number] | null;
	/** Increments per start (remounts the editor). */
	seq: number;
};

export const canvasTextEditStore = createStore<{ edit: CanvasTextEdit | null }>(() => ({ edit: null }));

let seq = 0;

export function startCanvasTextEdit(
	session: EditorSession,
	clipId: string,
	opts: { path?: readonly string[]; point?: readonly [number, number] } = {},
): void {
	canvasTextEditStore.setState({
		edit: {
			session,
			clipId,
			path: opts.path ? [...opts.path] : null,
			point: opts.point ? [opts.point[0], opts.point[1]] : null,
			seq: ++seq,
		},
	});
}

export function endCanvasTextEdit(): void {
	if (canvasTextEditStore.getState().edit) canvasTextEditStore.setState({ edit: null });
}

type FocusRequest = { clipId: string; path: string[] };
const focusListeners = new Set<(r: FocusRequest) => void>();

/** Asks the Properties text editor of `path` to take the focus (when it cannot be edited on canvas). */
export function requestTextFieldFocus(clipId: string, path: readonly string[]): void {
	for (const l of focusListeners) l({ clipId, path: [...path] });
}

export function onTextFieldFocusRequest(cb: (r: FocusRequest) => void): () => void {
	focusListeners.add(cb);
	return () => focusListeners.delete(cb);
}

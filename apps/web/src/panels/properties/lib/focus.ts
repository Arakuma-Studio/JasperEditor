// The inspector's focused property and effect (for UI commands: stopwatch toggle, next/previous
// keyframe, reset, remove effect). A tiny external store: panels write it on pointer/focus, commands read it.

export type InspectorFocus = {
	/** Panel that set the focus. */
	source: 'properties' | 'effectControls' | null;
	/** Clips the focused row edits. */
	clipIds: string[];
	/** Row id (`opacity`, `crop.left`, `effects.<fxId>.<param>`…). */
	rowId: string | null;
	/** Effect selected in Effect Controls (Delete removes it when no keyframes are selected). */
	effectInstanceId: string | null;
};

let state: InspectorFocus = { source: null, clipIds: [], rowId: null, effectInstanceId: null };
const listeners = new Set<() => void>();

export const inspectorFocus = {
	get: (): InspectorFocus => state,
	set(patch: Partial<InspectorFocus>): void {
		state = { ...state, ...patch };
		for (const l of [...listeners]) l();
	},
	reset(): void {
		state = { source: null, clipIds: [], rowId: null, effectInstanceId: null };
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

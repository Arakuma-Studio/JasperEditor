// Mask editing state shared by Effect Controls and the Program monitor (wp masks): the selected mask (its path is
// drawn and edited on the monitor), its selected vertices, the pen tool target (drawing a new free-form mask) and
// running tracking jobs (progress + cancel). A tiny external store (useSyncExternalStore).
import { useSyncExternalStore } from 'react';

export type MaskOwner = { clipId: string; effectId: string | null };

export type MaskTrackRun = {
	jobId: string | null;
	maskId: string;
	direction: 'forward' | 'backward';
	progress: number | null;
	label: string;
};

export type MaskUiState = {
	/** The mask edited on the monitor. */
	selected: { maskId: string; clipId: string } | null;
	/** Selected vertex indices of the selected mask. */
	vertices: number[];
	/** Pen tool: clicks on the monitor add vertices to a new mask of this owner (`maskId` once created). */
	pen: (MaskOwner & { maskId: string | null }) | null;
	/** Mask tracking jobs by mask id. */
	tracking: Record<string, MaskTrackRun>;
};

let state: MaskUiState = { selected: null, vertices: [], pen: null, tracking: {} };
const listeners = new Set<() => void>();

export const maskUi = {
	get: (): MaskUiState => state,
	set(patch: Partial<MaskUiState> | ((s: MaskUiState) => Partial<MaskUiState>)): void {
		const p = typeof patch === 'function' ? patch(state) : patch;
		state = { ...state, ...p };
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	select(sel: MaskUiState['selected']): void {
		maskUi.set({ selected: sel, vertices: [] });
	},
};

export function useMaskUi<T>(pick: (s: MaskUiState) => T): T {
	return useSyncExternalStore(
		maskUi.subscribe,
		() => pick(state),
		() => pick(state),
	);
}

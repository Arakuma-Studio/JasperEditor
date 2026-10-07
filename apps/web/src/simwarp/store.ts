// Program-monitor tool state of the sim-warp effects (Puppet Pin tool, Liquify brush), shared by Effect Controls
// (tool rows) and the Program-monitor overlay. A tiny external store (useSyncExternalStore).
import type { PuppetPinKind } from '@jasper/project';
import { useSyncExternalStore } from 'react';

export type SimWarpUiState = {
	/** Puppet Pin tool: clicks on the focused Puppet effect's layer add pins of this kind (null = off). */
	pinTool: PuppetPinKind | null;
	/** Liquify brush: drags on the focused Liquify effect's layer paint strokes with its Tool. */
	brush: boolean;
	/** Selected pins (moved together, deleted with Delete). */
	pins: string[];
};

let state: SimWarpUiState = { pinTool: null, brush: false, pins: [] };
const listeners = new Set<() => void>();

export const simWarpUi = {
	get: (): SimWarpUiState => state,
	set(patch: Partial<SimWarpUiState>): void {
		state = { ...state, ...patch };
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useSimWarpUi<T>(pick: (s: SimWarpUiState) => T): T {
	return useSyncExternalStore(
		simWarpUi.subscribe,
		() => pick(state),
		() => pick(state),
	);
}

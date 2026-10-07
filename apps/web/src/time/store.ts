// Which clips show the speed rubber band (workstream `time`): Premiere's "Show Clip Keyframes ▸ Time Remapping ▸
// Speed" is a per-clip display choice. Time-remapped clips always show it. UI state only (not in the document).
import { useSyncExternalStore } from 'react';

const shown = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
	version++;
	for (const l of listeners) l();
}

export function isBandShown(clipId: string): boolean {
	return shown.has(clipId);
}

export function setBandShown(clipIds: readonly string[], on: boolean): void {
	let changed = false;
	for (const id of clipIds) {
		if (on && !shown.has(id)) {
			shown.add(id);
			changed = true;
		} else if (!on && shown.delete(id)) changed = true;
	}
	if (changed) emit();
}

export function subscribeBand(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

/** Re-renders when the set changes; returns its version. */
export function useBandVersion(): number {
	return useSyncExternalStore(subscribeBand, () => version);
}

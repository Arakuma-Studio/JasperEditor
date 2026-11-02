// Spec 19 TL-092: the layer selected in a look's stack, read by the Program outline and the tool bar's `Clip › Layer`.
// Selecting a layer is a click on it in Properties or Effect Controls: it never changes the clip selection, and a focus on
// another clip than the selected one simply draws nothing.
import { useSyncExternalStore } from 'react';

/** `light` = the look's light, a target of its own with its own on-canvas handle. */
export type LookFocus = { clipId: string; fxId: string; target: string } | null;
export const LIGHT_TARGET = 'light';

let state: LookFocus = null;
const listeners = new Set<() => void>();

export const lookFocus = {
	get: (): LookFocus => state,
	set(next: LookFocus): void {
		if (
			state?.clipId === next?.clipId &&
			state?.fxId === next?.fxId &&
			state?.target === next?.target
		)
			return;
		state = next;
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useLookFocus(): LookFocus {
	return useSyncExternalStore(lookFocus.subscribe, lookFocus.get);
}

// Availability of the WebGL2 colour stage (S06:CG-045): a tiny external store the layers subscribe to. When a
// context is lost the preview draws layers ungraded with a "Grade unavailable" chip until it is restored;
// renders never draw ungraded (they fail with WEBGL_UNAVAILABLE instead, CG-042).
import { useSyncExternalStore } from 'react';
import { canUseWebGl2 } from './gl.ts';

export type ColorStageState = 'ok' | 'lost' | 'unavailable';

let lostContexts = 0;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of listeners) l();
};

export const colorStageStatus = {
	get(): ColorStageState {
		if (!canUseWebGl2()) return 'unavailable';
		return lostContexts > 0 ? 'lost' : 'ok';
	},
	subscribe(cb: () => void): () => void {
		listeners.add(cb);
		return () => listeners.delete(cb);
	},
	/** A colour-stage context was lost / restored (called by the stage's canvas listeners). */
	contextLost(): void {
		lostContexts++;
		emit();
	},
	contextRestored(): void {
		lostContexts = Math.max(0, lostContexts - 1);
		emit();
	},
	/** Tests. */
	reset(): void {
		lostContexts = 0;
		emit();
	},
};

export function useColorStageStatus(): ColorStageState {
	return useSyncExternalStore(colorStageStatus.subscribe, colorStageStatus.get, colorStageStatus.get);
}

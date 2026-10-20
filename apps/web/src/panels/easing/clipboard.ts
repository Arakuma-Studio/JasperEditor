// Easing panel ▸ the ease clipboard: what Copy took from the keyframe selection (the ease, and the keys' values for
// Paste Values). Kept for this window's session, apart from the system clipboard (which holds keyframes, clips…).

import type { EaseClip } from '@jasper/project';
import { useSyncExternalStore } from 'react';

export type EaseClipboardEntry = {
	ease: EaseClip;
	/** The copied keys' values in order (property, then time), for Paste Values. */
	values: unknown[];
	/** Property the ease came from, for the info line. */
	label: string;
};

let entry: EaseClipboardEntry | null = null;
const listeners = new Set<() => void>();

export const easeClipboard = {
	get: (): EaseClipboardEntry | null => entry,
	set(next: EaseClipboardEntry | null): void {
		entry = next;
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useEaseClipboard(): EaseClipboardEntry | null {
	return useSyncExternalStore(easeClipboard.subscribe, easeClipboard.get, easeClipboard.get);
}

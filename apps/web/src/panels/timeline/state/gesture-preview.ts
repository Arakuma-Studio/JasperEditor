// Transient gesture payloads published for other panels (S02:TL-538 two-up, TL-626/631 four-up).
// The Program monitor (WP-2C) subscribes and renders them; the timeline only publishes.
import { createStore } from 'zustand/vanilla';
import type { TrimPreview } from '../model/gestures.ts';

export type GesturePreviewState = {
	/** Active trim/roll/slip/slide payload, or null when no such gesture runs. */
	preview: (TrimPreview & { sequenceId: string }) | null;
};

export const timelineGesturePreview = createStore<GesturePreviewState>(() => ({ preview: null }));

export function publishPreview(p: GesturePreviewState['preview']): void {
	const cur = timelineGesturePreview.getState().preview;
	if (cur === p || (cur && p && JSON.stringify(cur) === JSON.stringify(p))) return;
	timelineGesturePreview.setState({ preview: p });
}

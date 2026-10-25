// Program-monitor text editing of anime templates (WP7b canvas-edit, docs/wp-notes/social-comments.md "Program monitor
// editing"): while the host app edits a template clip's text on the Program monitor, that clip is drawn at its rest
// frame — the last frame of its hold, after the entrance and every extra (word reveal, count-up) has finished and
// before the exit begins — instead of the playhead's frame, so the editor sits over the settled layout and not over a
// card that is mid-animation. Only the edited clip is affected (other layers stay at the playhead), the playhead does
// not move, and only previews read it (`options.isPreview`): renders and exports never see an edit hold.
//
// Process-wide like the baked-layer runtime: the web app sets it, the layers in every Player subscribe.
import type { AnimeTemplateTiming } from '@jasper/mg-templates';
import { useSyncExternalStore } from 'react';

let held: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Holds clip `clipId` at its rest frame in previews (null releases it). One clip at a time. */
export function setTemplateEditHold(clipId: string | null): void {
	const next = typeof clipId === 'string' && clipId ? clipId : null;
	if (next === held) return;
	held = next;
	version++;
	for (const l of [...listeners]) {
		try {
			l();
		} catch {
			// a listener of an unmounted layer: nothing to update
		}
	}
}

/** The clip held for editing, or null. */
export function templateEditHold(): string | null {
	return held;
}

const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

/** Whether `clipId` is held for editing (re-renders when the hold changes). */
export function useTemplateEditHold(clipId: string): boolean {
	useSyncExternalStore(
		subscribe,
		() => version,
		() => 0,
	);
	return held !== null && held === clipId;
}

/**
 * The rest time (ms of content time) of an anime template clip: the last frame before the outro starts, or the end
 * of the intro when the hold is empty (intro and outro compressed to the clip). Every intro tween and the extras that
 * run after it have settled there, and the outro has not begun.
 */
export function animeTemplateRestMs(t: AnimeTemplateTiming): number {
	const frameMs = t.totalFrames > 0 ? t.totalMs / t.totalFrames : 0;
	const frame = Math.max(t.introFrames, t.totalFrames - t.outroFrames - 1);
	const ms = Number.isFinite(frameMs) && frameMs > 0 ? frame * frameMs : t.introMs;
	return Math.max(0, Math.min(Number.isFinite(ms) ? ms : 0, t.totalMs));
}

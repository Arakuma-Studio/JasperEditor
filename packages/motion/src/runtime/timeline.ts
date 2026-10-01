// Paused timelines and the canonical seek (S11:ANM-002/003, R-ANM §1). Timelines are never played: they are
// created with `autoplay: false` and only moved with `seekCanonical` at `frame * 1000 / fps`.

import type { TimelineParams } from 'animejs';
import animePackage from 'animejs/package.json';
import { createTimeline, type Timeline } from 'animejs/timeline';

export type { Timeline, TimelineParams };

/** The anime.js version the runtime runs (pinned exactly, S11:ANM-011); part of every render key. */
export const ANIMEJS_VERSION: string = animePackage.version;

/**
 * Timeline params that break seek-only driving, dropped by `createPausedTimeline`: `frameRate` gates rendering
 * by the wall clock (values stick), `loop`/`loopDelay`/`alternate` make the duration infinite or the canonical
 * seek history-dependent (R-ANM §1). The lint (S11:ANM-012) rejects them in source; this is the runtime guard.
 */
const UNSAFE_PARAMS = ['frameRate', 'loop', 'loopDelay', 'alternate'] as const;

/** A paused timeline: `autoplay` is forced to false whatever `params` says; unsafe params are dropped. */
export function createPausedTimeline(params?: TimelineParams): Timeline {
	const safe: TimelineParams = { ...params };
	for (const k of UNSAFE_PARAMS) delete safe[k];
	return createTimeline({ ...safe, autoplay: false });
}

/**
 * History-independent seek: `seek(duration) → seek(0) → seek(ms)`, callbacks muted. A plain `seek` depends on the
 * previously visited time (R-ANM §1: 259/300 random timelines differ by visit order; 0/300 with this). Non-finite
 * `ms` seeks to 0; an infinite duration (a looping child) is never visited.
 */
export function seekCanonical(tl: Timeline, ms: number): void {
	const t = Number.isFinite(ms) ? ms : 0;
	if (Number.isFinite(tl.duration)) tl.seek(tl.duration, true);
	tl.seek(0, true);
	tl.seek(t, true);
}

/** Seek time of an integer frame (S11:ANM-003). */
export function frameToMs(frame: number, fps: number): number {
	return (frame * 1000) / fps;
}

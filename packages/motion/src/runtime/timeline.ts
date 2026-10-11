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
 * Also dropped from `params.defaults`, which every child inherits (a child's `frameRate` gates it by the wall
 * clock in `tick`, a default `loop` makes every child infinite), with `autoplay` and a `'blend'` composition.
 */
// anime-allow: names the params the runtime drops
const UNSAFE_PARAMS = ['frameRate', 'loop', 'loopDelay', 'alternate'] as const;
const UNSAFE_DEFAULTS = [...UNSAFE_PARAMS, 'autoplay'] as const;
/** `compositionTypes.blend` of anime.js (`'blend'` or its enum value). */
const BLEND = 2;

type Defaults = NonNullable<TimelineParams['defaults']>;

/** `defaults` without the unsafe keys (a copy; the caller's object is untouched). */
function safeDefaults(defaults: Defaults): Defaults {
	const safe: Defaults = { ...defaults };
	for (const k of UNSAFE_DEFAULTS) delete safe[k];
	const composition = safe.composition;
	if (composition === 'blend' || composition === BLEND) delete safe.composition;
	return safe;
}

/**
 * A paused timeline: `autoplay` is forced to false whatever `params` says; unsafe params are dropped, at the top
 * level and in `defaults`.
 */
export function createPausedTimeline(params?: TimelineParams): Timeline {
	const safe: TimelineParams = { ...params };
	for (const k of UNSAFE_PARAMS) delete safe[k];
	if (safe.defaults) safe.defaults = safeDefaults(safe.defaults);
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

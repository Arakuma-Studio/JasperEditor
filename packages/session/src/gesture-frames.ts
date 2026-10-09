// Gesture frames for costly views (workstream ui-perf, docs/performance.md §5). A gesture (timeline drag or trim,
// property scrub, transform drag) replaces the transient document once per pointer frame; the panel driving it must
// follow every frame, but views that rebuild a lot from the whole document (the Program monitor's render snapshot
// and Player, ARCHITECTURE §8) would spend the frame budget the gesture needs. `gestureFrames(store)` is the drawn
// document (`transient ?? document`) as such views see it:
//
// - outside gestures and when a gesture ends (commit or cancel) it changes together with the session store, in the
//   same notification (no lag, no extra render);
// - during a gesture, transient documents are published from a task of their own (after the frame that produced
//   them is painted), and no more often than the views can afford: after a publish whose renders took `c` ms the
//   next one waits `DUTY × c` (`c` is a moving average of the measured cost, at most `MAX_INTERVAL_MS`). Cheap views
//   (a few ms) therefore still get every gesture frame; a 1 000-clip Program monitor gets a few per second and the
//   timeline keeps its frame rate. The last transient document of a gesture is always published.
import type { ProjectDocument } from '@jasper/project';
import type { StoreApi } from 'zustand/vanilla';
import type { SessionState } from './types.ts';

/** Views may use at most 1 / DUTY of the main thread during a gesture (their cost × DUTY between publishes). */
const DUTY = 5;
/** Upper bound on the wait between two gesture frames (≥ 4 per second whatever the cost). */
const MAX_INTERVAL_MS = 250;

export type GestureFrameStats = {
	/** Transient documents published to the views / skipped because a newer one replaced them first. */
	published: number;
	skipped: number;
	/** Moving average of the views' cost per published gesture frame (ms) and the resulting wait. */
	costMs: number;
	intervalMs: number;
};

export type GestureFrames = {
	/** The drawn document as the throttled views see it. */
	getState(): ProjectDocument;
	subscribe(listener: () => void): () => void;
	stats(): GestureFrameStats;
	dispose(): void;
};

type Timers = {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	/** Runs after the renders a notification scheduled (React flushes store updates in a microtask). */
	afterRender(fn: () => void): void;
};

const defaultTimers: Timers = {
	now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
	afterRender: (fn) => queueMicrotask(fn),
};

const cache = new WeakMap<StoreApi<SessionState>, GestureFrames>();

/** The shared gesture-frame view of a session store (one per store). */
export function gestureFrames(store: StoreApi<SessionState>): GestureFrames {
	let g = cache.get(store);
	if (!g) {
		g = createGestureFrames(store);
		cache.set(store, g);
	}
	return g;
}

const drawnOf = (s: SessionState) => s.transient ?? s.document;

/** A gesture-frame view with its own timers (tests); `gestureFrames` shares one per store. */
export function createGestureFrames(
	store: StoreApi<SessionState>,
	timers: Timers = defaultTimers,
): GestureFrames {
	let shown = drawnOf(store.getState());
	const listeners = new Set<() => void>();
	let timer: unknown = null;
	let lastPublish = Number.NEGATIVE_INFINITY;
	const stats: GestureFrameStats = { published: 0, skipped: 0, costMs: 0, intervalMs: 0 };

	const notify = () => {
		for (const l of [...listeners]) l();
	};
	const cancel = () => {
		if (timer !== null) timers.clearTimeout(timer);
		timer = null;
	};
	const publishTransient = () => {
		timer = null;
		const s = store.getState();
		const next = drawnOf(s);
		if (next === shown) return;
		shown = next;
		stats.published++;
		const t0 = timers.now();
		lastPublish = t0;
		notify();
		timers.afterRender(() => {
			const cost = timers.now() - t0;
			stats.costMs = stats.published === 1 ? cost : stats.costMs * 0.6 + cost * 0.4;
			stats.intervalMs = Math.min(MAX_INTERVAL_MS, stats.costMs * DUTY);
		});
	};
	const unsubscribe = store.subscribe((s) => {
		const next = drawnOf(s);
		if (next === shown) {
			if (timer !== null && !s.transient) cancel();
			return;
		}
		if (!s.transient) {
			// Committed, cancelled, undone, replaced: the views follow at once (same notification as the store).
			cancel();
			shown = next;
			notify();
			return;
		}
		if (timer !== null) {
			stats.skipped++;
			return;
		}
		const wait = Math.max(0, lastPublish + stats.intervalMs - timers.now());
		timer = timers.setTimeout(publishTransient, wait);
	});

	return {
		getState: () => shown,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stats: () => ({ ...stats }),
		dispose() {
			cancel();
			unsubscribe();
			listeners.clear();
		},
	};
}

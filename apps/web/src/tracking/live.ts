// Live tracking progress for the timeline strips (S09:TRU-005, TRK-010): while a `track` job runs, the engine's
// `tracking.progress` events (throttled by the engine, so not every frame) are collected per tracker in a plain
// buffer outside React state; a throttled version counter (≤ 10 Hz) in the tracking store tells the strips to
// redraw. `liveSamples` merges the frames tracked so far over the committed samples (like `tracker.setSamples
// {merge:'span'}` will), so the strip shows the growing span with its confidence; when the job ends the buffer is
// dropped and the committed result replaces it. Nothing here touches the document or History.
import type { TrackerSamples } from '@jasper/project';
import { trackingStore } from './store.ts';

/** Minimum interval between strip redraws caused by progress events. */
const LIVE_THROTTLE_MS = 100;

type LiveBuffer = {
	jobId: string | null;
	/** Flicks per source frame (content time of source frame f = f · step). */
	step: number;
	stride: 2 | 8;
	/** Source frame → confidence of the frames received so far. */
	frames: Map<number, number>;
	min: number;
	max: number;
	/** Cached merge (by committed samples identity and buffer size). */
	cache: { committed: TrackerSamples | null; size: number; result: TrackerSamples } | null;
};

const buffers = new Map<string, LiveBuffer>();
let bumpTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Set<string>();

function flush(): void {
	bumpTimer = null;
	if (!pending.size) return;
	const ids = [...pending];
	pending.clear();
	trackingStore.setState((s) => {
		const liveVersion = { ...s.liveVersion };
		for (const id of ids) liveVersion[id] = (liveVersion[id] ?? 0) + 1;
		return { liveVersion };
	});
}

function schedule(trackerId: string): void {
	pending.add(trackerId);
	if (bumpTimer === null) bumpTimer = setTimeout(flush, LIVE_THROTTLE_MS);
}

/** Records one progress event (source frame and its confidence) of a running job. */
export function recordLiveProgress(
	trackerId: string,
	p: { jobId: string | null; frame: number; confidence: number; step: number; stride: 2 | 8 },
): void {
	let b = buffers.get(trackerId);
	if (!b || b.jobId !== p.jobId || b.step !== p.step) {
		b = {
			jobId: p.jobId,
			step: p.step,
			stride: p.stride,
			frames: new Map(),
			min: p.frame,
			max: p.frame,
			cache: null,
		};
		buffers.set(trackerId, b);
	}
	b.frames.set(p.frame, Math.min(1, Math.max(0, p.confidence)));
	b.min = Math.min(b.min, p.frame);
	b.max = Math.max(b.max, p.frame);
	schedule(trackerId);
}

/** Drops a tracker's live buffer (job finished, failed or stopped); the strip falls back to the committed samples. */
function clearLiveProgress(trackerId: string): void {
	if (!buffers.delete(trackerId)) return;
	schedule(trackerId);
}

/**
 * The samples to draw for a tracker: the committed ones, with the frames tracked so far by its running job merged
 * over them (`span` semantics). Frames between two received ones (the engine throttles its events) take the lower
 * of the two confidences. Returns the committed samples when nothing is live.
 */
export function liveSamples(trackerId: string, committed: TrackerSamples | null): TrackerSamples | null {
	const b = buffers.get(trackerId);
	if (!b || b.frames.size === 0) return committed;
	if (b.cache && b.cache.committed === committed && b.cache.size === b.frames.size) return b.cache.result;
	const compatible = committed && committed.step === b.step && committed.start % b.step === 0;
	const n0 = compatible ? committed.confidence.length : 0;
	const c0 = compatible ? committed.start / b.step : b.min;
	const first = Math.min(b.min, n0 ? c0 : b.min);
	const last = Math.max(b.max, n0 ? c0 + n0 - 1 : b.max);
	const n = last - first + 1;
	const confidence = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		const j = first + i - c0;
		confidence[i] = n0 && j >= 0 && j < n0 ? committed!.confidence[j]! : 0;
	}
	// The job's received frames, gaps between them filled with the lower neighbour.
	const got = [...b.frames.keys()].sort((x, y) => x - y);
	for (let k = 0; k < got.length; k++) {
		const f = got[k]!;
		const c = b.frames.get(f)!;
		confidence[f - first] = c;
		const next = got[k + 1];
		if (next !== undefined)
			for (let g = f + 1; g < next; g++) confidence[g - first] = Math.min(c, b.frames.get(next)!);
	}
	const result: TrackerSamples = {
		start: first * b.step,
		step: b.step,
		stride: b.stride,
		// Geometry is not drawn by the strips; zeros keep the samples well-formed (count = data / stride).
		data: new Array<number>(n * b.stride).fill(0),
		confidence,
	};
	b.cache = { committed, size: b.frames.size, result };
	return result;
}

// A tracker leaving `running` (finished, failed, stopped) drops its live buffer.
trackingStore.subscribe((s) => {
	for (const id of [...buffers.keys()]) if (!s.running[id]) clearLiveProgress(id);
});

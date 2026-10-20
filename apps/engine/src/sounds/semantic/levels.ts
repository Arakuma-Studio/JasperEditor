// Where a found moment's sound is (spec 12 P6-E14, WP-E9 Find Moment; the head / tail idea is earshot's, our numbers):
// 10 ms RMS frames of the window, its loudest frame, and the frames within `rangeDb` of it. `trimToSound` shrinks a
// window to that span (5 ms before its first frame, 20 ms after its last); `edgeLevels` says how loud the first 5 ms
// and the last 10 ms are against the loudest 10 ms (a moment that starts inside a sound or ends before it has decayed
// reads high). Pure; samples are mono at `rate`.

const FRAME_SEC = 0.01;
const HEAD_SEC = 0.005;
const TAIL_SEC = 0.01;
const MARGIN_HEAD_SEC = 0.005;
const MARGIN_TAIL_SEC = 0.02;
const FLOOR_DB = -120;

const db = (rms: number) => (rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB);

function rmsOf(x: Float32Array, a: number, b: number): number {
	const lo = Math.max(0, a);
	const hi = Math.min(x.length, b);
	if (hi <= lo) return 0;
	let s = 0;
	for (let i = lo; i < hi; i++) {
		const v = x[i]!;
		if (Number.isFinite(v)) s += v * v;
	}
	return Math.sqrt(s / (hi - lo));
}

/** Loudest 10 ms RMS of `x` (dBFS), and its frame index. */
function loudest(x: Float32Array, rate: number): { db: number; frames: Float64Array; frame: number } {
	const len = Math.max(1, Math.round(FRAME_SEC * rate));
	const n = Math.max(1, Math.ceil(x.length / len));
	const frames = new Float64Array(n);
	let best = 0;
	for (let f = 0; f < n; f++) {
		frames[f] = db(rmsOf(x, f * len, (f + 1) * len));
		if (frames[f]! > frames[best]!) best = f;
	}
	return { db: frames[best]!, frames, frame: best };
}

/** Head (first 5 ms) and tail (last 10 ms) RMS against the loudest 10 ms, dB (0 for silence). */
export function edgeLevels(x: Float32Array, rate: number): { headDb: number; tailDb: number } {
	if (!(rate > 0) || x.length === 0) return { headDb: 0, tailDb: 0 };
	const peak = loudest(x, rate).db;
	if (peak <= FLOOR_DB) return { headDb: 0, tailDb: 0 };
	const head = db(rmsOf(x, 0, Math.max(1, Math.round(HEAD_SEC * rate))));
	const tail = db(rmsOf(x, x.length - Math.max(1, Math.round(TAIL_SEC * rate)), x.length));
	const r = (v: number) => Math.round(v * 10) / 10;
	return { headDb: r(Math.min(0, head - peak)), tailDb: r(Math.min(0, tail - peak)) };
}

/**
 * The part of a window where its sound is: from 5 ms before the first 10 ms frame within `rangeDb` of the loudest one
 * to 20 ms after the last, in samples of `x` (the whole window for silence). Never longer than the window.
 */
export function trimToSound(x: Float32Array, rate: number, rangeDb = 40): { start: number; end: number } {
	if (!(rate > 0) || x.length === 0) return { start: 0, end: x.length };
	const { db: peak, frames } = loudest(x, rate);
	if (peak <= FLOOR_DB) return { start: 0, end: x.length };
	const len = Math.max(1, Math.round(FRAME_SEC * rate));
	let first = 0;
	while (first < frames.length - 1 && frames[first]! < peak - rangeDb) first++;
	let last = frames.length - 1;
	while (last > first && frames[last]! < peak - rangeDb) last--;
	const start = Math.max(0, first * len - Math.round(MARGIN_HEAD_SEC * rate));
	const end = Math.min(x.length, (last + 1) * len + Math.round(MARGIN_TAIL_SEC * rate));
	return end > start ? { start, end } : { start: 0, end: x.length };
}

// Sound segments (Decorate Cuts' whooshes cut from a media, spec 15 EA-020; wp-note edit-automation "Decorate Cuts
// inputs"): the parts of a recording separated by quiet — a file of several whooshes, swooshes or hits one after the
// other. Unlike takes (takes.ts, attack-led strokes of percussive hits), a segment may swell in slowly: it is where the
// 10 ms level stays over a threshold — the louder of (the loudest window − SEGMENT_BELOW_PEAK_DB) and (the recording's
// floor, its 10th-percentile window, + SEGMENT_OVER_FLOOR_DB) — with gaps shorter than SEGMENT_GAP_SEC bridged,
// segments shorter than SEGMENT_MIN_SEC dropped and SEGMENT_PAD_SEC added on each side (never into a neighbour).
// Pure and deterministic; never throws for odd audio (non-finite samples count as 0; an invalid rate gives none).

/** Level window (s). */
export const SEGMENT_WINDOW_SEC = 0.01;
/** Quiet shorter than this inside a sound does not split it (s). */
export const SEGMENT_GAP_SEC = 0.08;
/** Shorter segments are dropped (s). */
export const SEGMENT_MIN_SEC = 0.05;
/** Lead and tail added around a segment (s). */
export const SEGMENT_PAD_SEC = 0.01;
/** A window this far under the loudest one is quiet (dB). */
export const SEGMENT_BELOW_PEAK_DB = 40;
/** A window at most this far over the floor is quiet (dB). */
export const SEGMENT_OVER_FLOOR_DB = 12;
/** Most segments returned (the first in time). */
export const SEGMENT_MAX = 256;

export type SoundSegment = { startSample: number; endSample: number };

/** The sounds of `channels` separated by quiet, in time order (see the file comment). */
export function soundSegments(
	channels: readonly Float32Array[],
	sampleRate: number,
	max = SEGMENT_MAX,
): SoundSegment[] {
	if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 768_000 || !channels.length)
		return [];
	const n = channels.reduce((m, c) => Math.max(m, c.length), 0);
	const w = Math.max(1, Math.round(SEGMENT_WINDOW_SEC * sampleRate));
	const k = Math.ceil(n / w);
	if (k === 0) return [];
	const db = new Float64Array(k);
	for (let f = 0; f < k; f++) {
		const a = f * w;
		const b = Math.min(n, a + w);
		let s = 0;
		for (const c of channels)
			for (let i = a; i < Math.min(b, c.length); i++) {
				const x = c[i]!;
				if (Number.isFinite(x)) s += x * x;
			}
		const p = s / ((b - a) * channels.length);
		db[f] = p > 0 ? 10 * Math.log10(p) : -200;
	}
	const sorted = Float64Array.from(db).sort();
	const peak = sorted[k - 1]!;
	if (!(peak > -200)) return [];
	const floor = sorted[Math.floor((k - 1) * 0.1)]!;
	const threshold = Math.max(peak - SEGMENT_BELOW_PEAK_DB, floor + SEGMENT_OVER_FLOOR_DB);
	// runs of loud windows, gaps under SEGMENT_GAP_SEC bridged
	const gap = Math.ceil(SEGMENT_GAP_SEC / SEGMENT_WINDOW_SEC);
	const runs: [number, number][] = [];
	for (let f = 0; f < k; f++) {
		if (db[f]! < threshold) continue;
		const last = runs[runs.length - 1];
		if (last && f - last[1] < gap) last[1] = f + 1;
		else runs.push([f, f + 1]);
	}
	const minFrames = Math.ceil(SEGMENT_MIN_SEC / SEGMENT_WINDOW_SEC);
	const kept = runs.filter(([a, b]) => b - a >= minFrames).slice(0, Math.max(0, max));
	const pad = Math.round(SEGMENT_PAD_SEC * sampleRate);
	return kept.map(([a, b], i) => {
		const lo = i > 0 ? Math.ceil((kept[i - 1]![1] * w + a * w) / 2) : 0;
		const hi = i + 1 < kept.length ? Math.floor((b * w + kept[i + 1]![0] * w) / 2) : n;
		return { startSample: Math.max(lo, a * w - pad), endSample: Math.min(hi, Math.min(n, b * w) + pad) };
	});
}

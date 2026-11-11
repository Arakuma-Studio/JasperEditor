// Edit-point placement (spec 14 TC-021; docs/wp-notes/transcript-cleanup.md "Edges"). Level mode is the prototype's
// rule (private `.prproj-analysis/research/edits/mac/autocut.py` `cut`, `edge == 'level'`), which matched the user's
// edits (out point inside the word decay ≈ floor + 20 dB, in point at the onset ≈ floor + 25 dB): the out point is the
// first 10 ms frame after the last kept speech frame whose level falls below the threshold, the in point the first
// frame at / after the onset that reaches it. The arithmetic is the prototype's (seconds as k × 0.01 doubles,
// truncation and rounding where it truncates and rounds) so the port places the same edges. Then edges are snapped
// to the sequence's frame grid: frame boundaries within `snapWindowS` compete on level (the quietest 10 ms frame
// wins); with none in the window an in point snaps down and an out point up (never into the word). Pure.
import { type CleanupVoice, edgeThreshold, FR, levelDbAt } from './detector.ts';

export { edgeThreshold };

/**
 * Level-referenced out point of a kept range `[a, b)` (seconds): walk back from the last frame to the last frame at
 * or above `thr`, then forward to the first frame below it (prototype).
 */
export function levelOutPoint(voice: CleanupVoice, a: number, b: number, thr: number): number {
	const n = voice.frameCount;
	let k = Math.round(b / FR) - 1;
	const lo = Math.trunc(a / FR);
	while (k > lo && levelDbAt(voice, k) < thr) k -= 1;
	while (k < n - 1 && levelDbAt(voice, k) >= thr) k += 1;
	return k * FR;
}

/**
 * Level-referenced in point of a kept range starting at `a` (seconds): the first frame from 80 ms before `a` that
 * reaches `thr`; when that is more than 100 ms after `a` the range keeps `a` (prototype).
 */
export function levelInPoint(voice: CleanupVoice, a: number, thr: number): number {
	const n = voice.frameCount;
	let k = Math.max(0, Math.round(a / FR) - 8);
	while (k < n - 1 && levelDbAt(voice, k) < thr) k += 1;
	return k * FR > a + 0.1 ? Math.min(a, k * FR) : k * FR;
}

/**
 * Snaps an edge at media second `t` to a frame boundary of the clip's placement. `boundaries(t)` lists the media
 * seconds of the frame boundaries around `t` (ascending). Boundaries within `window` of `t` compete on the level of
 * the 10 ms frame they fall in (quietest wins, nearest on ties); with none, an in point takes the boundary at or
 * before `t`, an out point the one at or after it.
 */
export function snapEdge(
	voice: CleanupVoice | null,
	t: number,
	which: 'in' | 'out',
	window: number,
	candidates: readonly number[],
): number {
	if (!candidates.length) return t;
	const near = candidates.filter((c) => Math.abs(c - t) <= window + 1e-9);
	if (near.length && voice) {
		let best = near[0]!;
		let bestDb = Number.POSITIVE_INFINITY;
		for (const c of near) {
			const db = levelDbAt(voice, Math.floor(c / FR + 1e-9));
			if (db < bestDb - 1e-9 || (Math.abs(db - bestDb) <= 1e-9 && Math.abs(c - t) < Math.abs(best - t))) {
				best = c;
				bestDb = db;
			}
		}
		return best;
	}
	if (near.length === 1) return near[0]!;
	if (which === 'in') {
		let pick = candidates[0]!;
		for (const c of candidates) if (c <= t + 1e-9) pick = c;
		return pick;
	}
	for (const c of candidates) if (c >= t - 1e-9) return c;
	return candidates[candidates.length - 1]!;
}

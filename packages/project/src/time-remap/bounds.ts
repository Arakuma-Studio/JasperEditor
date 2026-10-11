// Media bounds of remapped clips: every visible frame (and every handle frame a trim or a
// transition may reveal) must show a media time inside the media, 0 ≤ m < duration. Linear clips keep the S01:CLP-005
// rules of their callers; these helpers apply when `isRemapped(clip)`.
import type { Rational } from '../time.ts';
import { clipMediaExtent, type TimedClip } from './model.ts';

/** Tolerance (flicks) for media times at the very start of the media. */
const START_TOL = 1;
/** Largest number of handle frames searched (beyond this the room counts as unbounded). */
const MAX_ROOM = 1 << 24;

/** Whether the media times over sequence frames [f0, f1] lie inside the media (`dur` null = unbounded end). */
export function remapFramesInMedia(
	clip: TimedClip,
	f0: number,
	f1: number,
	rate: Rational,
	dur: number | null,
): boolean {
	if (f1 < f0) return true;
	const { min, max } = clipMediaExtent(clip, f0, f1, rate);
	if (!(min >= -START_TOL)) return false;
	if (dur !== null && !(max < dur)) return false;
	return Number.isFinite(min) && Number.isFinite(max);
}

/** Largest k ≥ 0 (≤ cap) with ok(k), for a predicate that is true at 0 and monotone (true … true false … false). */
function largestOk(ok: (k: number) => boolean, cap = MAX_ROOM): number {
	if (!ok(1)) return 0;
	let good = 1;
	let bad = 2;
	while (bad <= cap && ok(bad)) {
		good = bad;
		bad *= 2;
	}
	if (bad > cap) return ok(cap) ? Number.POSITIVE_INFINITY : bisect(ok, good, cap);
	return bisect(ok, good, bad);
}

function bisect(ok: (k: number) => boolean, good: number, bad: number): number {
	while (bad - good > 1) {
		const mid = Math.floor((good + bad) / 2);
		if (ok(mid)) good = mid;
		else bad = mid;
	}
	return good;
}

/**
 * Handles of a remapped clip in sequence frames: how far the in edge can extend to the left (`head`) and the out edge
 * to the right (`tail`) while every frame still shows media.
 */
export function remapRoom(
	clip: TimedClip,
	rate: Rational,
	dur: number | null,
): { head: number; tail: number } {
	const first = clip.start;
	const last = clip.start + clip.duration - 1;
	const head = largestOk((k) => remapFramesInMedia(clip, first - k, first - 1, rate, dur));
	const tail = largestOk((k) => remapFramesInMedia(clip, last + 1, last + k, rate, dur));
	return { head, tail };
}

/**
 * The longest duration ≤ `wanted` (≥ 1) whose frames all show media, for a clip starting at `clip.start`
 * (Premiere pushes the frames a slowed-down clip cannot show into its tail).
 */
export function remapFitDuration(
	clip: TimedClip,
	wanted: number,
	rate: Rational,
	dur: number | null,
): number {
	const ok = (d: number) =>
		remapFramesInMedia({ ...clip, duration: d }, clip.start, clip.start + d - 1, rate, dur);
	if (ok(wanted)) return wanted;
	if (!ok(1)) return 1;
	return bisect(ok, 1, wanted);
}

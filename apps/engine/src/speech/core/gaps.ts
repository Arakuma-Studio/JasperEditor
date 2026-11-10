// Spans of voice that the transcription left without words (spec 16 SG-011 safety net). Whisper can return nothing
// for a window although it holds clear speech — measured on a 57-minute Spanish file with large-v3-turbo: ≈ 45 s of
// speech after stretches of digital silence came back empty, and decoding those ranges on their own recovered the
// words. After the main pass, the worker decodes such spans again, alone, and merges what they yield.
//
// A span is a run of voiced 10 ms frames (voiced frames closer than `GAP_JOIN_FRAMES` join) lying between two words
// with at least `GAP_MIN_VOICED_FRAMES` voiced frames, padded by `GAP_PAD_FRAMES` of context on each side without
// reaching a word. Retries are bounded: at most `GAP_MAX_SPANS` spans and `GAP_MAX_FRAMES` frames in all, taken in
// time order; spans that do not fit are counted as skipped.
//
// Frames are 10 ms (160 samples at 16 kHz); word times are 16 kHz samples.
import { cleanupNorm, sameWord } from '@jasper/project/cleanup-worker';
import { placeWord } from './align.ts';
import { VAD_FRAME } from './vad.ts';

/** Voiced frames (2 s) a wordless span needs to be decoded again. */
export const GAP_MIN_VOICED_FRAMES = 200;
/** Voiced frames separated by less silence than this (2 s, the hallucination silence threshold) form one span. */
export const GAP_JOIN_FRAMES = 200;
/** Context (0.5 s) kept on each side of a span's voice, within its gap. */
export const GAP_PAD_FRAMES = 50;
/** At most this many spans are decoded again per job. */
export const GAP_MAX_SPANS = 32;
/** At most this many frames (10 min) are decoded again per job. */
export const GAP_MAX_FRAMES = 60_000;

export type GapSpan = { start: number; end: number };

/**
 * The wordless voiced spans of `mask` (frames `[start, end)`), in time order: `spans` to decode again (within the
 * budget) and how many qualifying spans did not fit (`skipped`). `words` must be sorted and non-overlapping.
 */
export function wordlessVoicedSpans(
	words: ReadonlyArray<{ start: number; end: number }>,
	mask: ArrayLike<number>,
	budget: { spans: number; frames: number } = { spans: GAP_MAX_SPANS, frames: GAP_MAX_FRAMES },
	/**
	 * What qualifies (default: the SG-011 safety net): `minVoiced` voiced frames, voice closer than `join` frames
	 * joins, `pad` frames of context, and words covering the voice within `margin` frames on each side.
	 */
	shape: { minVoiced: number; join: number; pad: number; margin: number } = {
		minVoiced: GAP_MIN_VOICED_FRAMES,
		join: GAP_JOIN_FRAMES,
		pad: GAP_PAD_FRAMES,
		margin: 0,
	},
): { spans: GapSpan[]; skipped: number } {
	const frames = mask.length;
	const found: GapSpan[] = [];
	for (let i = 0; i <= words.length; i++) {
		const lo = i === 0 ? 0 : Math.min(frames, Math.ceil(words[i - 1]!.end / VAD_FRAME) + shape.margin);
		const hi =
			i === words.length ? frames : Math.max(0, Math.floor(words[i]!.start / VAD_FRAME) - shape.margin);
		let f = lo;
		while (f < hi) {
			while (f < hi && !(mask[f]! > 0)) f++;
			if (f >= hi) break;
			const first = f;
			let last = f;
			let voiced = 0;
			let silent = 0;
			for (; f < hi; f++) {
				if (mask[f]! > 0) {
					voiced++;
					last = f;
					silent = 0;
				} else if (++silent >= shape.join) break;
			}
			if (voiced >= shape.minVoiced)
				found.push({
					start: Math.max(lo, first - shape.pad),
					end: Math.min(hi, last + 1 + shape.pad),
				});
		}
	}
	// neighbouring spans of one gap may share padding: keep them apart
	for (let k = 1; k < found.length; k++)
		if (found[k]!.start < found[k - 1]!.end) found[k]!.start = found[k - 1]!.end;
	const spans: GapSpan[] = [];
	let used = 0;
	let skipped = 0;
	for (const s of found) {
		const len = s.end - s.start;
		if (spans.length < budget.spans && used + len <= budget.frames) {
			spans.push(s);
			used += len;
		} else skipped++;
	}
	return { spans, skipped };
}

/**
 * Merges words recovered in spans into the sorted, non-overlapping `words`. Each recovered list is clamped to its
 * range (samples; a span of `wordlessVoicedSpans` lies between two words, so nothing there collides); the result is
 * sorted by start with integer, non-overlapping times, and a word overlapping the one before it is dropped.
 */
export function mergeRecoveredWords<W extends { start: number; end: number }>(
	words: readonly W[],
	recovered: ReadonlyArray<{ start: number; end: number; words: readonly W[] }>,
): W[] {
	const all: W[] = [...words];
	for (const r of recovered) {
		let prev = r.start;
		for (const w of r.words) {
			const start = Math.max(prev, Math.round(w.start));
			if (start >= r.end) break;
			const end = Math.min(r.end, Math.max(start, Math.round(w.end)));
			all.push({ ...w, start, end });
			prev = end;
		}
	}
	all.sort((a, b) => a.start - b.start);
	const out: W[] = [];
	let prevEnd = 0;
	for (const w of all)
		if (w.start >= prevEnd) {
			out.push(w);
			prevEnd = w.end;
		}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Hidden takes (docs/wp-notes/speech.md §11.3 "Hidden takes"). Whisper (measured on a 57-minute Spanish file with large-v3-turbo)
// writes a phrase the speaker says twice back to back — a restart or retake — only once, and stretches that phrase's
// word times over both takes; decoding a few seconds around it alone, without the previous text, writes every take
// with correct times. Two traces mark such places:
//
// - a stretched word: longer than `STRETCH_MIN_FRAMES` (1 s; normal words last 0.2–0.4 s) over continuous speech,
//   i.e. at least `STRETCH_VOICED_SHARE` of its frames voiced (a word stretched over a pause is not continuous
//   speech: word-bound refinement trims it, and nothing is hidden there);
// - short wordless voice: ≥ `SHORT_GAP_MIN_VOICED_FRAMES` (0.35 s) of voiced frames that no word covers within
//   `COVER_MARGIN_FRAMES` (50 ms), voice closer than `SHORT_GAP_JOIN_FRAMES` (100 ms) joining.
//
// Each trace gives a window from `SUSPECT_BEFORE_FRAMES` (3 s) before it to `SUSPECT_AFTER_FRAMES` (1.5 s) after it,
// each edge moved out to the middle of the nearest pause (≥ `SUSPECT_EDGE_PAUSE_FRAMES` unvoiced frames) within
// `SUSPECT_EDGE_SEARCH_FRAMES` (1 s) — an edge inside speech makes the re-decode write the cut word's first sound as a
// word (measured: tiny.en wrote "far" for the start of "foraging") — then widened to the bounds of a word it cuts, so
// every original word lies wholly inside or outside; overlapping windows merge while the merged one fits one Whisper window
// (30 s), else the later one starts where the earlier ends. Bounded per job: `SUSPECT_MAX_WINDOWS` windows and
// `SUSPECT_MAX_FRAMES` frames in all, in time order; the rest are counted as skipped.

/** A word longer than this many frames (1 s) over continuous speech is stretched. */
export const STRETCH_MIN_FRAMES = 100;
/** Share of a word's frames that must be voiced for it to lie over continuous speech. */
export const STRETCH_VOICED_SHARE = 0.5;
/** Voiced frames (0.35 s) wordless voice needs to be suspect. */
export const SHORT_GAP_MIN_VOICED_FRAMES = 35;
/** Voiced frames closer than this (100 ms) form one run of wordless voice. */
export const SHORT_GAP_JOIN_FRAMES = 10;
/** A word covers the voice within this many frames (50 ms) of its bounds. */
export const COVER_MARGIN_FRAMES = 5;
/** Context decoded before (3 s) and after (1.5 s) a trace. */
export const SUSPECT_BEFORE_FRAMES = 300;
export const SUSPECT_AFTER_FRAMES = 150;
/** A window edge moves out to a pause of at least this many unvoiced frames (100 ms)… */
export const SUSPECT_EDGE_PAUSE_FRAMES = 10;
/** … found within this many frames (1 s). */
export const SUSPECT_EDGE_SEARCH_FRAMES = 100;
/** Merged windows stay within one Whisper window (30 s). */
export const SUSPECT_MERGE_MAX_FRAMES = 3000;
/** At most this many windows per job… */
export const SUSPECT_MAX_WINDOWS = 96;
/** … and this many frames (10 min) in all. */
export const SUSPECT_MAX_FRAMES = 60_000;
/** Audio (10 min, both passes counted) a job decodes again in VAD chunks for rejected windows. */
export const REDECODE_CHUNKED_MAX_FRAMES = 60_000;

/**
 * A window to decode again (frames `[start, end)`), the traces inside it, and whether each edge lies in a pause
 * (`edges`; an edge inside speech keeps the original words next to it, `replaceRegion`).
 */
export type SuspectWindow = {
	start: number;
	end: number;
	stretched: number;
	wordless: number;
	edges: { start: boolean; end: boolean };
};

type Timed = { start: number; end: number };

/** Whether `w` (samples) is a stretched word over continuous speech in `mask` (see the section docs). */
export function isStretchedWord(w: Timed, mask: ArrayLike<number>): boolean {
	const a = Math.max(0, Math.floor(w.start / VAD_FRAME));
	const b = Math.min(mask.length, Math.ceil(w.end / VAD_FRAME));
	if ((w.end - w.start) / VAD_FRAME <= STRETCH_MIN_FRAMES || b <= a) return false;
	let v = 0;
	for (let f = a; f < b; f++) if (mask[f]! > 0) v++;
	return v >= STRETCH_VOICED_SHARE * (b - a);
}

/**
 * The windows around stretched words and short wordless voice of `words` (sorted, non-overlapping samples) over
 * `mask`, in time order within the budget, and how many did not fit (`skipped`).
 */
export function suspectWindows(
	words: readonly Timed[],
	mask: ArrayLike<number>,
	budget: { windows: number; frames: number } = { windows: SUSPECT_MAX_WINDOWS, frames: SUSPECT_MAX_FRAMES },
): { windows: SuspectWindow[]; skipped: number } {
	const frames = mask.length;
	const traces: Array<{ start: number; end: number; stretched: number; wordless: number }> = [];
	for (const w of words)
		if (isStretchedWord(w, mask))
			traces.push({
				start: Math.floor(w.start / VAD_FRAME),
				end: Math.ceil(w.end / VAD_FRAME),
				stretched: 1,
				wordless: 0,
			});
	const gaps = wordlessVoicedSpans(
		words,
		mask,
		{ spans: Number.POSITIVE_INFINITY, frames: Number.POSITIVE_INFINITY },
		{
			minVoiced: SHORT_GAP_MIN_VOICED_FRAMES,
			join: SHORT_GAP_JOIN_FRAMES,
			pad: 0,
			margin: COVER_MARGIN_FRAMES,
		},
	).spans;
	for (const g of gaps) traces.push({ ...g, stretched: 0, wordless: 1 });
	// the word whose span holds frame f (strictly inside), by binary search
	const holding = (f: number): Timed | null => {
		const t = f * VAD_FRAME;
		let lo = 0;
		let hi = words.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (words[mid]!.end <= t) lo = mid + 1;
			else hi = mid;
		}
		const w = words[lo];
		return w && w.start < t && t < w.end ? w : null;
	};
	// the middle of the nearest pause from frame f outwards (`dir` −1: backwards), else f
	const pauseFrom = (f: number, dir: -1 | 1): { at: number; pause: boolean } => {
		let run = 0;
		for (let k = 0; k <= SUSPECT_EDGE_SEARCH_FRAMES; k++) {
			const g = f + dir * k;
			if (g < 0 || g >= frames) return { at: dir < 0 ? 0 : frames, pause: true };
			if (mask[g]! > 0) run = 0;
			else if (++run >= SUSPECT_EDGE_PAUSE_FRAMES)
				return { at: g - dir * (SUSPECT_EDGE_PAUSE_FRAMES >> 1), pause: true };
		}
		return { at: f, pause: false };
	};
	const raw = traces
		.map((t): SuspectWindow => {
			const s0 = pauseFrom(Math.max(0, t.start - SUSPECT_BEFORE_FRAMES), -1);
			const e0 = pauseFrom(Math.min(frames, t.end + SUSPECT_AFTER_FRAMES), 1);
			let start = s0.at;
			let end = e0.at;
			const a = holding(start);
			if (a) start = Math.max(0, Math.floor(a.start / VAD_FRAME));
			const b = holding(end);
			if (b) end = Math.min(frames, Math.ceil(b.end / VAD_FRAME));
			return {
				start,
				end,
				stretched: t.stretched,
				wordless: t.wordless,
				edges: { start: s0.pause, end: e0.pause },
			};
		})
		.filter((w) => w.end > w.start)
		.sort((x, y) => x.start - y.start || x.end - y.end);
	const merged: SuspectWindow[] = [];
	for (const w of raw) {
		const prev = merged[merged.length - 1];
		if (prev && w.start < prev.end) {
			if (Math.max(prev.end, w.end) - prev.start <= SUSPECT_MERGE_MAX_FRAMES) {
				if (w.end > prev.end) prev.edges.end = w.edges.end;
				prev.end = Math.max(prev.end, w.end);
				prev.stretched += w.stretched;
				prev.wordless += w.wordless;
				continue;
			}
			if (w.end <= prev.end) {
				prev.stretched += w.stretched;
				prev.wordless += w.wordless;
				continue;
			}
			w.start = prev.end;
			w.edges.start = prev.edges.end;
		}
		merged.push({ ...w, edges: { ...w.edges } });
	}
	const windows: SuspectWindow[] = [];
	let used = 0;
	let skipped = 0;
	for (const w of merged) {
		const len = w.end - w.start;
		if (windows.length < budget.windows && used + len <= budget.frames) {
			windows.push(w);
			used += len;
		} else skipped++;
	}
	return { windows, skipped };
}

/** At a window edge inside speech, the original words within this many frames (0.5 s) of it are kept. */
export const REDECODE_EDGE_GUARD_FRAMES = 50;

/**
 * The part of a window (samples `[start, end)`) whose words a re-decode may replace: the whole window at an edge in a
 * pause; at an edge inside speech, from the first original word starting at least `REDECODE_EDGE_GUARD_FRAMES` inside
 * it (to the last one ending that far inside) — a decode cut inside speech writes the cut word's sound as a word, so
 * the original words there stay.
 */
export function replaceRegion(
	words: readonly Timed[],
	win: SuspectWindow,
	samples: number,
): { start: number; end: number } {
	let start = win.start * VAD_FRAME;
	let end = Math.min(samples, win.end * VAD_FRAME);
	const guard = REDECODE_EDGE_GUARD_FRAMES * VAD_FRAME;
	if (!win.edges.start) {
		const t = start + guard;
		start = words.find((w) => w.start >= t && w.start < end)?.start ?? end;
	}
	if (!win.edges.end) {
		const t = end - guard;
		let e = start;
		for (const w of words) if (w.end <= t && w.start >= start) e = Math.max(e, w.end);
		end = e;
	}
	return { start, end: Math.max(start, end) };
}

/** Original words a re-decode may write differently (1 in 5: "Playstore" / "Play Store"). */
export const REDECODE_SPELLING_SLACK = 0.2;

/** Re-decoded words over an original one share more than this many samples (50 ms) with it. */
const OVERLAP_SAMPLES = 5 * VAD_FRAME;
/** An original word is said again in place by a re-decoded one whose middle lies this close (0.25 s) to its own. */
const RESAID_NEAR_SAMPLES = 25 * VAD_FRAME;
/** At most this many original words in a row may be overwritten by other words. */
const REDECODE_MAX_RUN = 2;

/**
 * The words that replace a window's original words after a re-decode (`core/gaps.ts` section docs), or null when
 * it does not. An original word stays (merged in time order) unless the re-decode says it again in place (one to
 * one, in order) — the same word or a variant over it
 * or within 0.25 s of its middle, or a variant of it (`sameWord`, also of the re-decoded words over it joined: "Playstore" / "Play
 * Store") over it — or it is itself stretched (> 1 s, what the pass decodes again): a decode that skips a stretch of
 * speech never deletes it (fragment E's chunked re-decode skipped "decenas de miles de millones de dólares." at
 * 29.79–31.15 and wrote a phrase later in the window that a plain subsequence match took for it). The result must
 * then hold MORE words consistent with the audio than the original — words with letters or digits and at least
 * `minVoiced` of their frames voiced in `mask` — and re-say the original words in order and in place, allowing `REDECODE_SPELLING_SLACK` of them, never more than two in a row, to be
 * written differently. An equal or smaller result never replaces anything, so the pass never drops words.
 */
export function redecodeAccepted<W extends Timed & { text: string }>(
	original: readonly W[],
	redecoded: readonly W[],
	mask: ArrayLike<number>,
	minVoiced: number,
): W[] | null {
	const voiced = (w: Timed) => {
		const a = Math.min(mask.length - 1, Math.max(0, Math.floor(w.start / VAD_FRAME)));
		const b = Math.min(mask.length, Math.max(a + 1, Math.ceil(w.end / VAD_FRAME)));
		let v = 0;
		for (let f = a; f < b; f++) if (mask[f]! > 0) v++;
		return b > a && v / (b - a) >= minVoiced;
	};
	// punctuation-only words ("…") count for nothing and say nothing
	const o = original.filter((w) => cleanupNorm(w.text));
	const r = redecoded.filter((w) => cleanupNorm(w.text));
	const on = o.map((w) => cleanupNorm(w.text));
	const rn = r.map((w) => cleanupNorm(w.text));
	// which original words the re-decode says again in place: a one-to-one, in-order alignment (longest common
	// subsequence) of the same word or a variant over it or within 0.25 s of its middle
	const mid = (w: Timed) => (w.start + w.end) / 2;
	const same = (i: number, j: number) =>
		sameWord(on[i]!, rn[j]!) &&
		(Math.abs(mid(r[j]!) - mid(o[i]!)) <= RESAID_NEAR_SAMPLES ||
			(r[j]!.start < o[i]!.end && r[j]!.end > o[i]!.start));
	const dp = Array.from({ length: o.length + 1 }, () => new Array<number>(r.length + 1).fill(0));
	for (let i = o.length - 1; i >= 0; i--)
		for (let j = r.length - 1; j >= 0; j--)
			dp[i]![j] = same(i, j) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
	const resaid = new Array<boolean>(o.length).fill(false);
	for (let i = 0, j = 0; i < o.length && j < r.length; ) {
		if (same(i, j) && dp[i]![j] === dp[i + 1]![j + 1]! + 1) {
			resaid[i++] = true;
			j++;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
		else j++;
	}
	// a word not said again stays, unless it is stretched itself or the words written over it spell it differently
	const writtenOver = (w: W, n: string) => {
		const over = r.filter((x) => Math.min(x.end, w.end) - Math.max(x.start, w.start) > OVERLAP_SAMPLES);
		return (
			over.some((x) => sameWord(n, cleanupNorm(x.text))) ||
			(over.length > 1 && sameWord(n, over.map((x) => cleanupNorm(x.text)).join('')))
		);
	};
	const stays = o.map(
		(w, i) => !resaid[i] && w.end - w.start <= STRETCH_MIN_FRAMES * VAD_FRAME && !writtenOver(w, on[i]!),
	);
	const merged = [...redecoded, ...o.filter((_, i) => stays[i])].sort(
		(a, b) => a.start - b.start || a.end - b.end,
	);
	if (merged.filter((w) => cleanupNorm(w.text) && voiced(w)).length <= original.length) return null;
	// the words the result does not hold: few, never three in a row
	const missed = resaid.map((x, i) => !x && !stays[i]);
	let run = 0;
	for (const x of missed) {
		run = x ? run + 1 : 0;
		if (run > REDECODE_MAX_RUN) return null;
	}
	return missed.filter(Boolean).length <= Math.floor(o.length * REDECODE_SPELLING_SLACK) ? merged : null;
}

/**
 * `words` (sorted, non-overlapping) with the words whose midpoint lies in `[start, end)` (samples) replaced by
 * `incoming`: those of it whose midpoint lies there too, clamped between the kept neighbours, so the result stays
 * sorted with integer, non-overlapping times.
 */
export function replaceWindowWords<W extends Timed>(
	words: readonly W[],
	start: number,
	end: number,
	incoming: readonly W[],
): W[] {
	const mid = (w: Timed) => (w.start + w.end) / 2;
	const inside = (w: Timed) => mid(w) >= start && mid(w) < end;
	const before = words.filter((w) => !inside(w) && mid(w) < start);
	const after = words.filter((w) => !inside(w) && mid(w) >= end);
	let prev = before.length ? before[before.length - 1]!.end : 0;
	const limit = after.length ? after[0]!.start : Number.POSITIVE_INFINITY;
	const placed: W[] = [];
	for (const w of [...incoming].sort((a, b) => a.start - b.start)) {
		if (!inside(w)) continue;
		const s = Math.max(prev, Math.round(w.start));
		if (s >= limit) break;
		placeWord(placed, w, s, Math.min(limit, Math.max(s, Math.round(w.end))));
		prev = placed[placed.length - 1]!.end;
	}
	return [...before, ...placed, ...after];
}

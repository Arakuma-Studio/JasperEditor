// Audio score windows and readings (spec 17 SC-030, SC-031; request / result shapes of SC-092). Ported from the
// scriptfix spike (`sfjobs.py` `windows`, `bounds`, `add_readings`; FINDINGS §2.5) with the spec's packing: the
// transcript is split at gaps ≥ 1 s, a stretch longer than 28 s is split at its largest gap, consecutive stretches are
// packed into windows of ≤ 28 s, and each window is padded 0.25 s before / 0.35 s after its words (at most half the
// gap to the neighbouring words, and 20 ms clear of them). Only windows holding candidates are returned. Reading 0 is
// the window's ASR words; reading k replaces candidate k's region by its display words; each candidate is scored
// against reading 0 on its own. Pure; times are integer media flicks.
import { FLICKS_PER_SECOND } from '../time.ts';
import type { FixCandidate, FixWord } from './candidates.ts';

export const SCORE_WINDOW_DEFAULTS = Object.freeze({
	/** The transcript is split where the silence between words is at least this long. */
	gapSeconds: 1,
	/** Longest window (words span); longer stretches are split at their largest gap. */
	maxSeconds: 28,
	padBeforeSeconds: 0.25,
	padAfterSeconds: 0.35,
	/** Pads stop this far from the neighbouring words. */
	edgeMarginSeconds: 0.02,
	/** Pack consecutive stretches into one window up to `maxSeconds` (one encoder pass for several stretches). */
	pack: true,
});
/** Window packing settings (see `SCORE_WINDOW_DEFAULTS`). */
export type ScoreWindowOptions = {
	gapSeconds: number;
	maxSeconds: number;
	padBeforeSeconds: number;
	padAfterSeconds: number;
	edgeMarginSeconds: number;
	pack: boolean;
};

/** Id of reading 0 (the ASR words) in every window. */
export const ASR_READING_ID = 'asr';

/** One reading of a window (SC-092 request): word texts, no whitespace inside a word. */
export type ScoreReading = { id: string; words: string[] };

/**
 * Where a candidate sits in its window's readings: reading 0 words [from, asrTo) are replaced by reading
 * `readingId` words [from, scriptTo).
 */
export type ScoreRegion = {
	candidateId: string;
	readingId: string;
	from: number;
	asrTo: number;
	scriptTo: number;
};

/** A window to score: the SC-092 request window plus the bookkeeping that maps readings back to candidates. */
export type ScoreWindow = {
	id: string;
	/** Media flicks (padded). */
	start: number;
	end: number;
	readings: ScoreReading[];
	/** Transcript words [fromWord, toWord) of reading 0. */
	fromWord: number;
	toWord: number;
	regions: ScoreRegion[];
};

/** The exact SC-092 request window. */
export type ScoreRequestWindow = { id: string; start: number; end: number; readings: ScoreReading[] };

/** SC-092 result of one word of a reading (times in media flicks, like the request window). */
export type ScoreWordResult = {
	text: string;
	tokens: number;
	logprob: number;
	probability: number;
	start: number;
	end: number;
};
/** SC-092 result of one reading: LL over every text token and end-of-text, token count, per-word results. */
export type ScoreReadingResult = { id: string; logprob: number; tokens: number; words: ScoreWordResult[] };
/** SC-092 result of one window. */
export type ScoreWindowResult = { id: string; readings: ScoreReadingResult[] };

/** A candidate that got no window (prototype: skipped). */
export type UnplacedCandidate = { candidateId: string; reason: 'spansWindows' | 'windowEdge' };

function windowOptions(o: Partial<ScoreWindowOptions> | undefined): ScoreWindowOptions {
	const out: ScoreWindowOptions = { ...SCORE_WINDOW_DEFAULTS };
	if (!o) return out;
	for (const k of Object.keys(SCORE_WINDOW_DEFAULTS) as Array<keyof ScoreWindowOptions>) {
		const v = o[k];
		if (k === 'pack') {
			if (typeof v === 'boolean') out.pack = v;
		} else if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
			(out as Record<string, number | boolean>)[k] = v;
	}
	return out;
}

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * Word index ranges [a, b) of the windows (SC-030): split at gaps ≥ `gapSeconds`; a stretch spanning more than
 * `maxSeconds` is split at its largest gap (ties: nearest the middle, then earliest); then packed.
 */
export function windowRanges(
	words: readonly FixWord[],
	options?: Partial<ScoreWindowOptions>,
): Array<[number, number]> {
	const o = windowOptions(options);
	const n = words.length;
	if (!n) return [];
	const gapF = o.gapSeconds * FLICKS_PER_SECOND;
	const maxF = o.maxSeconds * FLICKS_PER_SECOND;
	const s = (k: number) => fin(words[k]?.start);
	const e = (k: number) => fin(words[k]?.end, s(k));
	const stretches: Array<[number, number]> = [];
	let a = 0;
	for (let k = 1; k <= n; k++)
		if (k === n || s(k) - e(k - 1) >= gapF) {
			stretches.push([a, k]);
			a = k;
		}
	const split: Array<[number, number]> = [];
	for (const r of stretches) {
		const stack: Array<[number, number]> = [r];
		while (stack.length) {
			const [x, y] = stack.pop()!;
			if (e(y - 1) - s(x) <= maxF || y - x < 2) {
				split.push([x, y]);
				continue;
			}
			let best = x + 1;
			let bestGap = Number.NEGATIVE_INFINITY;
			let bestMid = Number.POSITIVE_INFINITY;
			for (let k = x + 1; k < y; k++) {
				const gap = s(k) - e(k - 1);
				const mid = Math.abs(k - (x + y) / 2);
				if (gap > bestGap || (gap === bestGap && mid < bestMid)) {
					best = k;
					bestGap = gap;
					bestMid = mid;
				}
			}
			stack.push([best, y], [x, best]); // left half first
		}
	}
	if (!o.pack) return split;
	const packed: Array<[number, number]> = [];
	for (const r of split) {
		const cur = packed[packed.length - 1];
		if (cur && e(r[1] - 1) - s(cur[0]) <= maxF) cur[1] = r[1];
		else packed.push([r[0], r[1]]);
	}
	return packed;
}

/** Padded media bounds of the words [a, b) (SC-030). */
export function windowBounds(
	words: readonly FixWord[],
	a: number,
	b: number,
	options?: Partial<ScoreWindowOptions>,
): { start: number; end: number } {
	const o = windowOptions(options);
	const F = FLICKS_PER_SECOND;
	const first = fin(words[a]!.start);
	const last = fin(words[b - 1]!.end, first);
	const prevEnd = a > 0 ? fin(words[a - 1]!.end) : 0;
	const nextStart = b < words.length ? fin(words[b]!.start) : last + 5 * F;
	let start = Math.max(
		prevEnd + o.edgeMarginSeconds * F,
		first - o.padBeforeSeconds * F,
		first - (first - prevEnd) / 2,
		0,
	);
	start = Math.min(start, first);
	let end = Math.min(
		nextStart - o.edgeMarginSeconds * F,
		last + o.padAfterSeconds * F,
		last + (nextStart - last) / 2,
	);
	end = Math.max(end, last);
	return { start: Math.round(start), end: Math.round(end) };
}

/**
 * The windows to score for a media's candidates (SC-030, SC-031). Candidates that do not need audio are ignored;
 * a candidate whose words fall in two windows (or an insertion at a window edge) is returned as unplaced.
 */
export function buildScoreWindows(
	words: readonly FixWord[],
	candidates: readonly FixCandidate[],
	options?: Partial<ScoreWindowOptions>,
): { windows: ScoreWindow[]; unplaced: UnplacedCandidate[] } {
	const ranges = windowRanges(words, options);
	const winOf = new Int32Array(words.length).fill(-1);
	ranges.forEach(([a, b], k) => {
		winOf.fill(k, a, b);
	});
	const byWindow = new Map<number, FixCandidate[]>();
	const unplaced: UnplacedCandidate[] = [];
	for (const c of candidates) {
		if (!c.needsAudio) continue;
		const del = c.fromWord === c.toWord;
		const k0 = del ? (winOf[c.fromWord - 1] ?? -1) : (winOf[c.fromWord] ?? -1);
		// an insertion after the last word only needs the word before it
		const k1 = del
			? c.fromWord < words.length
				? (winOf[c.fromWord] ?? -1)
				: k0
			: (winOf[c.toWord - 1] ?? -1);
		if (k0 < 0 || k0 !== k1) {
			unplaced.push({ candidateId: c.id, reason: del ? 'windowEdge' : 'spansWindows' });
			continue;
		}
		let l = byWindow.get(k0);
		if (!l) byWindow.set(k0, (l = []));
		l.push(c);
	}
	const windows: ScoreWindow[] = [];
	for (const k of [...byWindow.keys()].sort((x, y) => x - y)) {
		const [a, b] = ranges[k]!;
		const base = words.slice(a, b).map((w) => String(w.text ?? '').trim());
		const { start, end } = windowBounds(words, a, b, options);
		const readings: ScoreReading[] = [{ id: ASR_READING_ID, words: base }];
		const regions: ScoreRegion[] = [];
		for (const c of byWindow.get(k)!) {
			const r0 = c.fromWord - a;
			const r1 = c.toWord - a;
			readings.push({ id: c.id, words: [...base.slice(0, r0), ...c.script, ...base.slice(r1)] });
			regions.push({
				candidateId: c.id,
				readingId: c.id,
				from: r0,
				asrTo: r1,
				scriptTo: r0 + c.script.length,
			});
		}
		windows.push({ id: `w${a}`, start, end, readings, fromWord: a, toWord: b, regions });
	}
	return { windows, unplaced };
}

/** The SC-092 request windows (bookkeeping removed). */
export function scoreRequestWindows(windows: readonly ScoreWindow[]): ScoreRequestWindow[] {
	return windows.map((w) => ({
		id: w.id,
		start: w.start,
		end: w.end,
		readings: w.readings.map((r) => ({ id: r.id, words: [...r.words] })),
	}));
}

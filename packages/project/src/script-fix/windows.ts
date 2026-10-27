// Audio score windows and readings (spec 17 SC-030, SC-031; request / result shapes of SC-092). Ported from the
// scriptfix spike (`sfjobs.py` `windows`, `bounds`, `add_readings`; FINDINGS §2.5): the transcript is split at gaps
// ≥ 1 s, a stretch longer than 28 s is split at its largest gap, and each window is padded 0.25 s before / 0.35 s
// after its words (at most half the gap to the neighbouring words, and 20 ms clear of them). Packing consecutive
// stretches into windows of ≤ 28 s (the spec's cost measure) is an option, off by default: on real recordings a gap
// between stretches can hold speech the transcript missed, and teacher forcing then lets a reading borrow that audio
// (SC-105 harness: 2 real deviations, a hallucination and a corrupted word fixed with packing, none without). Only windows holding candidates are returned. Reading 0 is
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
	/**
	 * Pack consecutive stretches into one window up to `maxSeconds` (one encoder pass for several stretches). Off: the
	 * SC-105 harness measured false fixes from packed windows and only 23 % more encoder passes without packing
	 * (docs/wp-notes/script-correction.md "Accuracy on real recordings").
	 */
	pack: false,
	/**
	 * Most transcript words in one window (longer stretches are split at their largest gap, like `maxSeconds`). Ordinary
	 * speech has ≤ 90 words in 28 s (SC-105 harness); only loops such as "cab cab cab …" reach it. Keeps every reading
	 * within the request's word limit and Whisper's 448-token context (≈ 4 tokens per word).
	 */
	maxWords: 100,
});

/**
 * The SC-092 request limits (`SpeechScoreRequestSchema` in packages/api, the worker's `SCORE_LIMITS`): the windows
 * built here always satisfy them, so one odd window can never make the scoring job refuse a whole recording.
 */
export const SCORE_REQUEST_LIMITS = Object.freeze({
	wordsPerReading: 224,
	readingsPerWindow: 64,
	/** Characters of a word after trimming (at least 1). */
	wordChars: 128,
	idChars: 128,
	/** Longest window (flicks). */
	windowFlicks: 30 * FLICKS_PER_SECOND,
});
/** Most script words a candidate brings into a reading (glossary targets: 8; script regions: 4). */
const MAX_REPLACEMENT_WORDS = 8;
/** Window packing settings (see `SCORE_WINDOW_DEFAULTS`). */
export type ScoreWindowOptions = {
	gapSeconds: number;
	maxSeconds: number;
	padBeforeSeconds: number;
	padAfterSeconds: number;
	edgeMarginSeconds: number;
	pack: boolean;
	maxWords: number;
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

/**
 * A candidate that got no window (prototype: skipped): its words fall in two windows, it inserts at a window edge,
 * it touches a word the scorer cannot read or brings one (`unreadable`), or its window would be longer than 30 s
 * (`tooLong`: a single word lasting longer than a window).
 */
export type UnplacedCandidate = {
	candidateId: string;
	reason: 'spansWindows' | 'windowEdge' | 'unreadable' | 'tooLong';
};

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
	// a reading holds the window's words plus a candidate's replacement words
	out.maxWords = Math.max(
		1,
		Math.min(SCORE_REQUEST_LIMITS.wordsPerReading - MAX_REPLACEMENT_WORDS, Math.floor(out.maxWords)),
	);
	out.maxSeconds = Math.min(out.maxSeconds, 29);
	return out;
}

/** A word text the scorer can read (SC-092: 1–128 characters after trimming). */
function readable(text: unknown): boolean {
	if (typeof text !== 'string') return false;
	const n = text.trim().length;
	return n >= 1 && n <= SCORE_REQUEST_LIMITS.wordChars;
}

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * Word index ranges [a, b) of the windows (SC-030): split at gaps ≥ `gapSeconds`; a stretch spanning more than
 * `maxSeconds` or holding more than `maxWords` words is split at its largest gap (ties: nearest the middle, then
 * earliest); then packed. A word the scorer cannot read (empty, or longer than 128 characters) is in no window.
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
	const maxW = o.maxWords;
	const ok = words.map((w) => readable(w?.text));
	const stretches: Array<[number, number]> = [];
	let a = 0;
	for (let k = 1; k <= n; k++)
		if (k === n || s(k) - e(k - 1) >= gapF || !ok[k] || !ok[k - 1]) {
			if (k - a > 1 || ok[a]) stretches.push([a, k]);
			a = k;
		}
	const split: Array<[number, number]> = [];
	for (const r of stretches) {
		const stack: Array<[number, number]> = [r];
		while (stack.length) {
			const [x, y] = stack.pop()!;
			if ((e(y - 1) - s(x) <= maxF && y - x <= maxW) || y - x < 2) {
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
		if (cur && cur[1] === r[0] && e(r[1] - 1) - s(cur[0]) <= maxF && r[1] - cur[0] <= maxW) cur[1] = r[1];
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
 * a candidate whose words fall in two windows (or an insertion at a window edge) is returned as unplaced. The
 * windows always satisfy `SCORE_REQUEST_LIMITS`: reading ids are `r1`, `r2`… (the regions map them to candidates),
 * and a window with more than 63 candidates is repeated over the same audio.
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
		if (!c.script.every(readable)) {
			unplaced.push({ candidateId: c.id, reason: 'unreadable' });
			continue;
		}
		const del = c.fromWord === c.toWord;
		const k0 = del ? (winOf[c.fromWord - 1] ?? -1) : (winOf[c.fromWord] ?? -1);
		// an insertion after the last word only needs the word before it
		const k1 = del
			? c.fromWord < words.length
				? (winOf[c.fromWord] ?? -1)
				: k0
			: (winOf[c.toWord - 1] ?? -1);
		if (k0 < 0 || k0 !== k1) {
			let unreadable = false;
			for (let k = c.fromWord; k < c.toWord && !unreadable; k++) unreadable = !readable(words[k]?.text);
			unplaced.push({
				candidateId: c.id,
				reason: unreadable ? 'unreadable' : del ? 'windowEdge' : 'spansWindows',
			});
			continue;
		}
		let l = byWindow.get(k0);
		if (!l) byWindow.set(k0, (l = []));
		l.push(c);
	}
	const windows: ScoreWindow[] = [];
	// readings per request window: the ASR reading plus at most this many candidates; more candidates of the same
	// audio go into further windows with the same range (the worker encodes a range once)
	const perWindow = SCORE_REQUEST_LIMITS.readingsPerWindow - 1;
	for (const k of [...byWindow.keys()].sort((x, y) => x - y)) {
		const [a, b] = ranges[k]!;
		const base = words.slice(a, b).map((w) => String(w.text ?? '').trim());
		const { start, end } = windowBounds(words, a, b, options);
		const list = byWindow.get(k)!;
		if (end - start > SCORE_REQUEST_LIMITS.windowFlicks) {
			for (const c of list) unplaced.push({ candidateId: c.id, reason: 'tooLong' });
			continue;
		}
		for (let p = 0; p < list.length; p += perWindow) {
			const readings: ScoreReading[] = [{ id: ASR_READING_ID, words: base }];
			const regions: ScoreRegion[] = [];
			list.slice(p, p + perWindow).forEach((c, j) => {
				const r0 = c.fromWord - a;
				const r1 = c.toWord - a;
				// short reading ids: candidate ids hold the media id and can exceed the request's 128 characters
				const readingId = `r${p + j + 1}`;
				readings.push({ id: readingId, words: [...base.slice(0, r0), ...c.script, ...base.slice(r1)] });
				regions.push({
					candidateId: c.id,
					readingId,
					from: r0,
					asrTo: r1,
					scriptTo: r0 + c.script.length,
				});
			});
			const id = p === 0 ? `w${a}` : `w${a}.${p / perWindow + 1}`;
			windows.push({ id, start, end, readings, fromWord: a, toWord: b, regions });
		}
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

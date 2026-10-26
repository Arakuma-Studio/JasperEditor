// Spec 13 AS-001 / AS-002 / AS-010: subtitle layout. Pure: transcript words (sequence time, flicks) + rules + the
// picture's cut events → subtitles (sequence frames) with their words, and statistics.
//
// Pipeline (AS-010: cut awareness runs after grouping words and before the duration / gap rules):
//   1. text transforms (case, glyphs, profanity) on the display text of every word;
//   2. grouping — `groupSubtitleWords`, the rules of `captionBlocks` (characters per line, lines, speaker change,
//      pause, maximum duration, `breakBefore: 'segment'`) plus maximum words, the punctuation mode and the language's
//      weak words (a subtitle or line does not end on an article / preposition when the next one can take it);
//   3. cut awareness (`alignToCutEvents`): split at cuts, start on cuts (look back / look ahead), end on cuts, cut
//      zones (two-sided transitions and montages of cuts closer than the minimum duration);
//   4. timing (`finishTiming`): hold until the next subtitle, minimum / maximum duration, gap, no overlaps — with the
//      priorities never cross a cut > exact cut alignment > minimum duration > gap (a piece made too short is
//      extended away from its cut where possible, else kept and reported).
// Words are in sequence flicks; subtitle bounds are integer sequence frames `[start, end)`.
import { FLICKS_PER_SECOND, type Rational } from '../../time.ts';
import { frameAt, tickOf } from '../formats/rate.ts';
import {
	type CutAwareOptions,
	MIN_WORDLESS_PIECE_FRAMES,
	MIN_ZONE_FRAMES,
	type SubtitleRules,
	type SubtitleText,
} from './rules.ts';
import {
	breakLines,
	endsClause,
	endsSentence,
	isWeakWord,
	stripTrailing,
	subtitleText,
	transformWords,
	weakWordsFor,
} from './text.ts';

/** A transcript word to lay out (sequence time, flicks). */
export type LayoutWord = {
	text: string;
	start: number;
	end: number;
	speaker?: string | null;
	breakBefore?: string;
};

/** A cut as the layout sees it: the edit point (first frame of the new picture) and its cut zone, if any. */
export type CutEvent = { frame: number; zone?: { start: number; end: number } | undefined };

/** A subtitle being laid out: frames `[start, end)`, its words (sequence flicks) and bookkeeping. */
export type WorkCaption = {
	start: number;
	end: number;
	words: { text: string; start: number; end: number }[];
	speaker: string | null;
	/** Index of the first word of each line after the first (within `words`). */
	lineStarts: number[];
	/** Where it came from (generation: the first word index; align: the clip id). */
	key: string;
	/** The start the words alone gave (frames), to count starts moved onto cuts. */
	wordStart: number;
	/** Pieces after the first one made by splitting at a cut. */
	splitPiece?: boolean;
	/** A subtitle with no word timing (manual text): its whole span counts as one word. */
	wordless?: boolean;
};

export type LayoutStats = {
	count: number;
	/** Subtitles whose start was moved onto a cut (or a cut zone's edit point). */
	snappedToCuts: number;
	/** Pieces added by splitting subtitles at cuts. */
	splitAtCuts: number;
	/** Subtitles shorter than the minimum duration (no room next to them). */
	belowMinimum: number;
	/** Cuts merged into cut zones (closer to each other than the minimum duration). */
	merged: number;
	/** Wordless pieces dropped (shorter than 3 frames, or emptied by a split). */
	dropped: number;
	/** Subtitles still running across a cut (0 unless the cut is inside a zone a subtitle may run through). */
	crossing: number;
	warnings: string[];
};

export const emptyStats = (): LayoutStats => ({
	count: 0,
	snappedToCuts: 0,
	splitAtCuts: 0,
	belowMinimum: 0,
	merged: 0,
	dropped: 0,
	crossing: 0,
	warnings: [],
});

const charCount = (s: string) => [...s].length;
const mid = (w: { start: number; end: number }) => w.start + Math.floor((w.end - w.start) / 2);

/** The last frame boundary at or after `t` (flicks → frame, ceiling). */
function ceilFrame(t: number, rate: Rational): number {
	const f = frameAt(t, rate);
	return tickOf(f, rate) < t ? f + 1 : f;
}

/** Whether `words` fit in `lines` lines of `maxChars` (a single word longer than a line takes a line). */
function fitsLines(
	words: readonly string[],
	maxChars: number,
	lines: number,
	weak: ReadonlySet<string> | null,
) {
	const starts = breakLines(words, maxChars, Number.POSITIVE_INFINITY, weak);
	if (starts.length + 1 > lines) return false;
	return true;
}

/**
 * Groups words into subtitles (half-open word index ranges): `captionBlocks`' rules plus maximum words, the
 * punctuation mode and weak words. `display` holds the displayed text of each word (lengths count on it);
 * punctuation is read from the spoken text.
 */
export function groupSubtitleWords(
	words: readonly LayoutWord[],
	display: readonly string[],
	rules: SubtitleRules,
	_rate: Rational,
	language: string | null,
): Array<[number, number]> {
	const maxChars = Math.max(1, Math.floor(rules.maxChars));
	const lines = Math.max(1, Math.floor(rules.lines));
	const capChars = maxChars * lines;
	const weak = weakWordsFor(language);
	const breakPause = Math.round(rules.breakPauseSeconds * FLICKS_PER_SECOND);
	const maxDuration = Math.round(rules.maxSeconds * FLICKS_PER_SECOND);
	const groups: Array<[number, number]> = [];
	let a = 0;
	const blockFits = (from: number, to: number) => {
		const shown = display.slice(from, to);
		return fitsLines(shown, maxChars, lines, weak) || to - from === 1;
	};
	for (let i = 0; i < words.length; i++) {
		if (i === a) continue;
		const w = words[i]!;
		const prev = words[i - 1]!;
		const used = display.slice(a, i).reduce((s, x) => s + charCount(x), 0) + (i - a - 1);
		const punct =
			rules.punctuation === 'always'
				? endsSentence(prev.text) || endsClause(prev.text)
				: rules.punctuation === 'half'
					? endsSentence(prev.text) && used * 2 >= capChars
					: false;
		const hard =
			(w.speaker ?? null) !== (prev.speaker ?? null) ||
			w.start - prev.end >= breakPause ||
			w.end - words[a]!.start > maxDuration ||
			punct ||
			w.breakBefore === 'segment';
		const soft = !blockFits(a, i + 1) || (rules.maxWords !== null && i - a >= rules.maxWords);
		if (!hard && !soft) continue;
		// A soft break after a weak word moves the weak word to the next subtitle when that one can take it.
		if (
			!hard &&
			weak &&
			i - 1 > a &&
			isWeakWord(prev.text, weak) &&
			!(words[i - 1]!.breakBefore === 'segment') &&
			(words[i - 1]!.speaker ?? null) === (w.speaker ?? null) &&
			blockFits(i - 1, i + 1) &&
			(rules.maxWords === null || rules.maxWords >= 2)
		) {
			groups.push([a, i - 1]);
			a = i - 1;
			continue;
		}
		groups.push([a, i]);
		a = i;
	}
	if (a < words.length) groups.push([a, words.length]);
	return groups;
}

/** Display text of every word: the text transforms of `opts` over the whole run. */
export function displayWords(words: readonly LayoutWord[], opts: SubtitleText, language: string): string[] {
	return transformWords(
		words.map((w) => w.text),
		opts,
		language,
	);
}

/** Subtitles from groups: frames from their words (start floored, end ceiled), lines, display words. */
export function captionsFromGroups(
	words: readonly LayoutWord[],
	display: readonly string[],
	groups: ReadonlyArray<[number, number]>,
	rules: SubtitleRules,
	text: SubtitleText,
	rate: Rational,
	language: string | null,
): WorkCaption[] {
	const weak = weakWordsFor(language);
	return groups.map(([g0, g1]) => {
		const shown = display.slice(g0, g1);
		if (text.stripTrailingPunctuation && shown.length)
			shown[shown.length - 1] = stripTrailing(shown[shown.length - 1]!);
		const start = frameAt(words[g0]!.start, rate);
		const end = Math.max(start + 1, ceilFrame(words[g1 - 1]!.end, rate));
		return {
			start,
			end,
			words: words.slice(g0, g1).map((w, k) => ({ text: shown[k]!, start: w.start, end: w.end })),
			speaker: words[g0]!.speaker ?? null,
			lineStarts: breakLines(shown, rules.maxChars, rules.lines, weak),
			key: String(g0),
			wordStart: start,
		};
	});
}

/** Cut events from cuts: transitions shorter than MIN_ZONE_FRAMES are hard cuts; montages merge into zones. */
export function prepareCutEvents(
	cuts: readonly CutEvent[],
	minFrames: number,
	stats: LayoutStats,
): CutEvent[] {
	const sorted = [...cuts]
		.filter((c) => Number.isFinite(c.frame))
		.map((c) => ({
			frame: Math.round(c.frame),
			zone:
				c.zone &&
				c.zone.end - c.zone.start >= MIN_ZONE_FRAMES &&
				c.zone.start <= c.frame &&
				c.frame < c.zone.end
					? { start: Math.round(c.zone.start), end: Math.round(c.zone.end) }
					: undefined,
		}))
		.sort((x, y) => x.frame - y.frame);
	const out: CutEvent[] = [];
	for (let i = 0; i < sorted.length; ) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1]!.frame - sorted[j]!.frame < minFrames) j++;
		if (j === i) {
			if (!out.length || out[out.length - 1]!.frame !== sorted[i]!.frame) out.push(sorted[i]!);
			i++;
			continue;
		}
		// A montage: cuts closer than the minimum duration are one zone, edit point = its first cut.
		const first = sorted[i]!;
		const last = sorted[j]!;
		out.push({
			frame: first.frame,
			zone: {
				start: Math.min(first.zone?.start ?? first.frame, first.frame),
				end: Math.max(last.zone?.end ?? last.frame + 1, last.frame + 1),
			},
		});
		stats.merged += j - i;
		i = j + 1;
	}
	return out;
}

/** First cut index with frame > f. */
function cutAfter(events: readonly CutEvent[], f: number): number {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const m = (lo + hi) >> 1;
		if (events[m]!.frame <= f) lo = m + 1;
		else hi = m;
	}
	return lo;
}

/**
 * The cut frames a subtitle `[s, e)` may not cross, in order: every hard cut inside it, and a zone's edit point unless
 * the part of the subtitle reaching it started before the zone. That part starts at the last blocking cut before it
 * (the subtitle is split there), so a zone that starts on or before an earlier blocking cut blocks too (spec 13
 * AS-010 step 5: only a subtitle that started before the transition runs through it).
 */
function blockingCuts(events: readonly CutEvent[], s: number, e: number): number[] {
	const out: number[] = [];
	let from = s;
	for (let i = cutAfter(events, s); i < events.length && events[i]!.frame < e; i++) {
		const ev = events[i]!;
		if (ev.zone && from < ev.zone.start) continue;
		out.push(ev.frame);
		from = ev.frame;
	}
	return out;
}

/** The words of a subtitle for cut decisions; a wordless one is a single word over its whole span. */
function timedWords(c: WorkCaption, rate: Rational): { text: string; start: number; end: number }[] {
	return c.wordless ? [{ text: '', start: tickOf(c.start, rate), end: tickOf(c.end, rate) }] : c.words;
}

function clampWords(c: WorkCaption, rate: Rational): void {
	const a = tickOf(c.start, rate);
	const b = tickOf(c.end, rate);
	let prevEnd = a;
	for (const w of c.words) {
		w.start = Math.min(Math.max(w.start, a, prevEnd), b);
		w.end = Math.min(Math.max(w.end, w.start), b);
		prevEnd = w.end;
	}
}

/**
 * AS-010 steps 1 and 3: every subtitle is split at the cuts it may not cross (words by midpoint; a straddling word goes
 * to the side holding most of it); all words on one side moves the boundary to the cut; a first piece within
 * `lookAhead` before the first cut joins the piece after it. Returns the pieces sorted by start.
 */
function splitAtCuts(
	caps: readonly WorkCaption[],
	events: readonly CutEvent[],
	lookAhead: number,
	rate: Rational,
	stats: LayoutStats,
): WorkCaption[] {
	const out: WorkCaption[] = [];
	for (const c of caps) {
		const inner = blockingCuts(events, c.start, c.end);
		if (!inner.length) {
			out.push(c);
			continue;
		}
		const ticks = inner.map((f) => tickOf(f, rate));
		const bins: WorkCaption['words'][] = inner.map(() => []);
		bins.push([]);
		const ws = timedWords(c, rate);
		for (const w of ws) {
			const m = mid(w);
			let b = 0;
			while (b < ticks.length && m >= ticks[b]!) b++;
			bins[b]!.push(w);
		}
		// look ahead: a first piece within `lookAhead` of the first cut joins the piece after it
		if (bins[0]!.length && inner[0]! - c.start <= lookAhead && inner[0]! > c.start) {
			bins[1]!.unshift(...bins[0]!);
			bins[0] = [];
		}
		let made = 0;
		bins.forEach((bin, b) => {
			if (!bin.length) return;
			const start = b === 0 ? c.start : inner[b - 1]!;
			const end = b === inner.length ? c.end : inner[b]!;
			if (end <= start) return;
			const piece: WorkCaption = {
				...c,
				start,
				end,
				words: c.wordless ? [] : bin.map((w) => ({ ...w })),
				lineStarts: [],
				key: made === 0 ? c.key : `${c.key}:${made}`,
				wordStart: made === 0 ? c.wordStart : start,
				...(made > 0 ? { splitPiece: true } : {}),
			};
			if (made > 0) stats.splitAtCuts++;
			made++;
			out.push(piece);
		});
		if (!made) stats.dropped++;
	}
	out.sort((x, y) => x.start - y.start || x.end - y.end);
	return out;
}

/**
 * AS-010 steps 1–3 and 5 on subtitles sorted by start: split at cuts (words by midpoint; a word straddling a cut
 * goes to the side holding most of it), look ahead / look back to start on cuts, end on cuts, cut zones. Mutates and
 * returns the list (re-sorted).
 */
export function alignToCutEvents(
	caps: WorkCaption[],
	events: readonly CutEvent[],
	opts: CutAwareOptions,
	rate: Rational,
	stats: LayoutStats,
): WorkCaption[] {
	if (!events.length) return caps;
	const fps = rate.num / rate.den;
	const lookAhead = Math.round(opts.lookAheadSeconds * fps);
	const lookBack = Math.round(opts.lookBackSeconds * fps);
	const isCut = new Set(events.map((e) => e.frame));
	// 1 + 3: split at cuts / move a boundary to the cut.
	let out = splitAtCuts(caps, events, lookAhead, rate, stats);
	// 2: start on cuts — look back from each start (the previous subtitle ends there if it has no words after it).
	for (let i = 0; i < out.length; i++) {
		const c = out[i]!;
		if (isCut.has(c.start)) continue;
		let k = cutAfter(events, c.start) - 1;
		// the latest cut in [start − lookBack, start)
		while (k >= 0 && events[k]!.frame >= c.start) k--;
		if (k < 0) continue;
		const cut = events[k]!.frame;
		if (c.start - cut > lookBack) continue;
		const prev = out[i - 1];
		const t = tickOf(cut, rate);
		if (prev && prev.end > cut) {
			if (prev.start >= cut) continue;
			if (timedWords(prev, rate).some((w) => mid(w) >= t)) continue;
			prev.end = cut;
		}
		c.start = cut;
	}
	// 5: cut zones — boundaries between subtitles inside a zone move to its edit point ("snap") or out of it ("avoid").
	for (const ev of events) {
		const z = ev.zone;
		if (!z) continue;
		for (let i = 0; i < out.length; i++) {
			const c = out[i]!;
			if (c.start <= z.start || c.start >= z.end || c.start === ev.frame) continue;
			const prev = out[i - 1];
			const target =
				opts.transitions === 'snap' ? ev.frame : c.start - z.start <= z.end - c.start ? z.start : z.end;
			const t = tickOf(target, rate);
			// the move may not take words away from either side
			if (target < c.start) {
				if (
					prev &&
					prev.end > target &&
					(prev.start >= target || timedWords(prev, rate).some((w) => mid(w) >= t))
				)
					continue;
				if (prev && prev.end > target) prev.end = target;
				c.start = target;
			} else {
				if (timedWords(c, rate).some((w) => mid(w) < t) || target >= c.end) continue;
				if (prev && prev.end === c.start) prev.end = target;
				c.start = target;
			}
		}
	}
	// starts moved by steps 2 and 5 can leave a piece starting on or inside a zone it then runs through: split again
	out = splitAtCuts(out, events, 0, rate, stats);
	for (const c of out) clampWords(c, rate);
	return out;
}

/**
 * Hold, minimum / maximum duration, gap and non-overlap (AS-010 steps 4 and 6). A start or end on a cut is fixed;
 * minimum-duration extension never crosses a cut (it extends away from the cut, else the subtitle is reported).
 */
export function finishTiming(
	caps: WorkCaption[],
	events: readonly CutEvent[],
	rules: SubtitleRules,
	rate: Rational,
	stats: LayoutStats,
	opts: { hold: boolean; minimum: boolean; limit?: { start: number; end: number } },
): WorkCaption[] {
	const fps = rate.num / rate.den;
	const minF = Math.max(1, Math.round(rules.minSeconds * fps));
	const maxF = Math.max(minF, Math.round(rules.maxSeconds * fps));
	const gap = Math.max(0, Math.floor(rules.gapFrames));
	const holdF = rules.holdSeconds === null ? 0 : Math.round(rules.holdSeconds * fps);
	const isCut = new Set(events.map((e) => e.frame));
	const lo = opts.limit?.start ?? 0;
	const hi = opts.limit?.end ?? Number.POSITIVE_INFINITY;
	caps.sort((x, y) => x.start - y.start || x.end - y.end);
	// no overlaps from frame rounding: a start on a cut wins, else the later subtitle starts where the earlier ends
	for (let i = 0; i + 1 < caps.length; i++) {
		const a = caps[i]!;
		const b = caps[i + 1]!;
		if (b.start >= a.end) continue;
		if (isCut.has(b.start) && b.start > a.start) a.end = b.start;
		else b.start = a.end;
		if (b.end <= b.start) b.end = b.start + 1;
	}
	const nextCut = (f: number) => {
		const k = cutAfter(events, f);
		return k < events.length ? events[k]!.frame : Number.POSITIVE_INFINITY;
	};
	const prevCut = (f: number) => {
		const k = cutAfter(events, f) - 1;
		return k >= 0 ? events[k]!.frame : Number.NEGATIVE_INFINITY;
	};
	for (let i = 0; i < caps.length; i++) {
		const c = caps[i]!;
		const next = caps[i + 1];
		const prev = caps[i - 1];
		const roomEnd = Math.min(next ? next.start - gap : hi, nextCut(c.start), hi);
		// hold until the next subtitle (never past a cut)
		if (opts.hold && holdF > 0 && c.end < roomEnd) c.end = Math.min(roomEnd, c.end + holdF);
		// minimum duration: into the silence after it, then (if its start is not on a cut) before it
		if (opts.minimum && c.end - c.start < minF) {
			if (c.end < roomEnd) c.end = Math.min(roomEnd, c.start + minF);
			if (c.end - c.start < minF && !isCut.has(c.start)) {
				const roomStart = Math.max(prev ? prev.end + gap : lo, prevCut(c.start), lo);
				if (c.start > roomStart) c.start = Math.max(roomStart, c.end - minF);
			}
			if (c.end - c.start < minF) stats.belowMinimum++;
		}
		// maximum duration (never cutting its words)
		if (c.end - c.start > maxF) {
			const wordsEnd = c.words.length ? ceilFrame(c.words[c.words.length - 1]!.end, rate) : c.start + 1;
			c.end = Math.max(c.start + maxF, Math.min(c.end, wordsEnd));
		}
		// gap before the next subtitle
		if (next && next.start - c.end < gap) c.end = Math.max(c.start + 1, next.start - gap);
		if (next && c.end > next.start) c.end = Math.max(c.start + 1, next.start);
	}
	const kept = caps.filter((c) => {
		if (c.end <= c.start) return false;
		if (!c.words.length && !c.wordless && c.end - c.start < MIN_WORDLESS_PIECE_FRAMES) {
			stats.dropped++;
			return false;
		}
		return true;
	});
	for (const c of kept) clampWords(c, rate);
	return kept;
}

/** Subtitles still crossing a hard cut (or a zone they started in): verification, expected 0. */
export function countCrossings(caps: readonly WorkCaption[], events: readonly CutEvent[]): number {
	let n = 0;
	for (const c of caps) if (blockingCuts(events, c.start, c.end).length) n++;
	return n;
}

export type SubtitleLayoutInput = {
	words: readonly LayoutWord[];
	rules: SubtitleRules;
	text: SubtitleText;
	language: string;
	rate: Rational;
	/** Cut events (cut-aware layout), or null when cut awareness is off. */
	cuts: readonly CutEvent[] | null;
	cutAware: CutAwareOptions;
	/** Frames the subtitles must stay inside (the generated range). */
	limit?: { start: number; end: number };
};

export type SubtitleLayout = { captions: WorkCaption[]; stats: LayoutStats; events: CutEvent[] };

/** The whole generation layout (see the file comment). */
export function layoutSubtitles(input: SubtitleLayoutInput): SubtitleLayout {
	const stats = emptyStats();
	const { words, rules, text, language, rate } = input;
	const valid = words.filter(
		(w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start && w.text.trim().length > 0,
	);
	if (valid.length < words.length)
		stats.warnings.push(`${words.length - valid.length} unusable word(s) skipped`);
	const display = displayWords(valid, text, language);
	const groups = groupSubtitleWords(valid, display, rules, rate, language);
	let caps = captionsFromGroups(valid, display, groups, rules, text, rate, language);
	const fps = rate.num / rate.den;
	const minF = Math.max(1, Math.round(rules.minSeconds * fps));
	const events = input.cuts && input.cutAware.enabled ? prepareCutEvents(input.cuts, minF, stats) : [];
	if (events.length) caps = alignToCutEvents(caps, events, input.cutAware, rate, stats);
	caps = finishTiming(caps, events, rules, rate, stats, { hold: true, minimum: true, limit: input.limit });
	if (input.limit) {
		const { start, end } = input.limit;
		caps = caps.filter((c) => c.end > start && c.start < end);
		for (const c of caps) {
			c.start = Math.max(c.start, start);
			c.end = Math.min(c.end, end);
			clampWords(c, rate);
		}
	}
	const weak = weakWordsFor(language);
	const cutFrames = new Set(events.map((e) => e.frame));
	for (const c of caps) {
		if (text.stripTrailingPunctuation && c.words.length) {
			const last = c.words[c.words.length - 1]!;
			last.text = stripTrailing(last.text);
		}
		c.lineStarts = breakLines(
			c.words.map((w) => w.text),
			rules.maxChars,
			rules.lines,
			weak,
		);
		if (c.start !== c.wordStart && cutFrames.has(c.start)) stats.snappedToCuts++;
	}
	stats.crossing = countCrossings(caps, events);
	stats.count = caps.length;
	return { captions: caps, stats, events };
}

/** The text a laid-out subtitle shows (its display words on its lines). */
export function workCaptionText(c: WorkCaption): string {
	return subtitleText(
		c.words.map((w) => w.text),
		c.lineStarts,
		false,
	);
}

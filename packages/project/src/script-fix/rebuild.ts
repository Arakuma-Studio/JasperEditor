// Rebuild from script for the kept speech (docs/wp-notes/script-correction.md "Rebuild from script"): the words heard
// in each media span a sequence keeps — re-transcribed from the raw audio by the engine (`apps/engine/src/speech/
// kept-spans.ts`) — are aligned to the script span by span and written back with `transcript.replaceWords`, so the
// subtitles read like the script. Pure: the kept spans of a sequence, the per-span alignment rules and the edits.
//
// Rules per span (alignment = `alignTranscript` of the span's heard words against the whole script, so every span may
// use any part of the script — retakes and restarts re-use script words):
// - an exact cell → the script spelling with the heard timing;
// - a non-exact cell (replaced inside the span) → the script text with the heard timing (n : m cells spread over the
//   heard span by characters);
// - heard words not in the script (`ins` / `off`) → dropped, or kept as heard with `keepOffScript`;
// - script words skipped between two cells of the span (missing) → inserted in the gap between their neighbours, the
//   gap widened by borrowing time from the longer neighbour when it is too short;
// - emoticon tokens ("XD") right after a script word → attached after that word (a short slice, borrowed from it when
//   there is no gap), even when the path leaves the script there;
// - a span with no cell at all (nothing of the script heard) keeps its heard words: there is nothing to align to.
// Symbol-only heard words ("%" after "99", "..." after a word) are folded into the word before them first, so a
// script "99%" replaces both ("99% %" was the result of replacing only the number).
import { REPLACE_WORDS_LIMITS, wordInReplaceSpan } from '../captions/replace-words.ts';
import { heardFromCutStart, transcriptForMedia } from '../captions/sequence-transcript.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Transcript } from '../schema/media.ts';
import type { Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame } from '../time.ts';
import { type AlignOptions, alignTranscript } from './align.ts';
import type { ParsedScript, ScriptToken } from './script.ts';
import { normalizeWord } from './text.ts';

/** Settings of a rebuild (assumptions, not measured beyond the reference cut; see the wp-note). */
export const REBUILD_DEFAULTS = Object.freeze({
	/** Audio around each kept span the engine decodes for context (seconds); words heard only there are not written. */
	padSeconds: 0.2,
	/** Confidence of words written from the script without being heard (Clean Up's ASR-suspect review lists < 0.4). */
	scriptDerivedConfidence: 0.3,
	/** Shortest time an inserted script word is given (seconds) before neighbours lend theirs. */
	insertedSeconds: 0.08,
	/** Length of an emoticon slice ("XD") after its word (seconds). */
	emoticonSeconds: 0.06,
	/** A neighbour lends at most this share of its duration to inserted words. */
	maxLendShare: 0.5,
	/** Old / new words per `transcript.replaceWords` edit stay at or below this (the command's limit is 64). */
	maxWordsPerEdit: 60,
	/** Spans of one media closer than this (frames of the sequence) are rebuilt as one. */
	joinFrames: 1,
});

/** A media range a sequence plays, with the transcript its words are written into. Media flicks. */
export type KeptSpan = {
	mediaId: string;
	transcriptId: string;
	start: number;
	end: number;
	/** Audio clips playing (part of) it, in sequence order. */
	clipIds: string[];
};

/**
 * The media spans a sequence keeps: every enabled, forward audio clip on an audio track whose media has a transcript
 * (its current one, not a translation), as media ranges merged per media when they overlap, lie within `joinFrames`
 * of each other or share a transcript word. Sorted by media (first played first), then start.
 */
export function keptSpans(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: Sequence,
	opts: { joinFrames?: number } = {},
): KeptSpan[] {
	const F = flicksPerFrame(seq.settings.frameRate);
	const join = Math.max(0, opts.joinFrames ?? REBUILD_DEFAULTS.joinFrames) * F;
	const audioTracks = new Set(seq.audioTracks.map((t) => t.id));
	const byMedia = new Map<string, { t: Transcript; first: number; spans: KeptSpan[] }>();
	const clips = Object.values(seq.clips).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
	for (const c of clips) {
		if (c.kind !== 'audio' || !audioTracks.has(c.trackId) || !c.enabled) continue;
		if (c.speed.reverse || !(c.speed.rate > 0) || !(c.duration > 0)) continue;
		const t = transcriptForMedia(doc, c.mediaId);
		if (!t || t.task === 'translate') continue;
		const start = c.sourceIn;
		const end = c.sourceIn + Math.round(c.duration * F * c.speed.rate);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
		let m = byMedia.get(c.mediaId);
		if (!m) byMedia.set(c.mediaId, (m = { t, first: c.start, spans: [] }));
		m.spans.push({ mediaId: c.mediaId, transcriptId: t.id, start, end, clipIds: [c.id] });
	}
	const out: KeptSpan[] = [];
	for (const m of [...byMedia.values()].sort((a, b) => a.first - b.first)) {
		const list = m.spans.sort((a, b) => a.start - b.start || a.end - b.end);
		// spans one transcript word overlaps are rebuilt as one (a word is replaced by one edit only)
		const sharesWord = (a: KeptSpan, b: KeptSpan) =>
			m.t.words.some((w) => wordInReplaceSpan(w, a.start, a.end) && wordInReplaceSpan(w, b.start, b.end));
		let cur: KeptSpan | null = null;
		for (const s of list) {
			if (cur && (s.start <= cur.end + join || sharesWord(cur, s))) {
				cur.end = Math.max(cur.end, s.end);
				cur.clipIds.push(...s.clipIds);
			} else {
				cur = { ...s, clipIds: [...s.clipIds] };
				out.push(cur);
			}
		}
	}
	return out;
}

/** A word the engine heard in a span (media flicks). */
export type HeardWord = { text: string; start: number; end: number; confidence: number | null };

/**
 * The heard words of one media given to its kept spans (sorted, disjoint media ranges): a word goes to the span holding
 * its midpoint — or, cut off at a span's start with its midpoint in no span, to that span by the sequence transcript's
 * rule (`heardFromCutStart`) — and is clamped into it. Words heard only in the padding around the spans go nowhere.
 */
export function heardInSpans(
	words: readonly HeardWord[],
	spans: ReadonlyArray<{ start: number; end: number }>,
): HeardWord[][] {
	const out: HeardWord[][] = spans.map(() => []);
	const inAny = (m: number) => spans.some((s) => m >= s.start && m < s.end);
	for (const w of words) {
		if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start) continue;
		const mid = w.start + (w.end - w.start) / 2;
		let k = spans.findIndex((s) => mid >= s.start && mid < s.end);
		if (k < 0) k = spans.findIndex((s) => heardFromCutStart(w, s.start, s.end, inAny));
		if (k < 0) continue;
		const s = spans[k]!;
		const start = Math.max(s.start, Math.min(s.end, w.start));
		out[k]!.push({ ...w, start, end: Math.max(start, Math.min(s.end, w.end)) });
	}
	for (const list of out) list.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}

/** How a rebuilt word came to be. */
export type RebuiltOrigin = 'exact' | 'replaced' | 'inserted' | 'emoticon' | 'kept';

/** A word of the rebuilt span (media flicks). */
export type RebuiltWord = {
	text: string;
	start: number;
	end: number;
	confidence: number | null;
	origin: RebuiltOrigin;
};

export type SpanRebuildCounts = {
	/** Script words written over a heard word that matched exactly. */
	exact: number;
	/** Script words written over heard words that differed (the heard timing kept). */
	replaced: number;
	/** Missing script words inserted (not heard). */
	inserted: number;
	/** Emoticons attached after their word. */
	emoticons: number;
	/** Heard words not in the script: dropped / kept (`keepOffScript`, or a span with nothing of the script). */
	dropped: number;
	kept: number;
};

export type SpanRebuild = {
	words: RebuiltWord[];
	counts: SpanRebuildCounts;
	/** False when nothing of the span aligned to the script (its heard words are kept as heard). */
	aligned: boolean;
};

export type RebuildSpanInput = {
	heard: readonly HeardWord[];
	script: ParsedScript;
	/** The transcript's language tag (default: the script's rule set). */
	language?: string | null;
	/** Keep heard words that are not in the script (default false: dropped). */
	keepOffScript?: boolean;
	options?: Partial<AlignOptions>;
};

const EMOTICON = /^x+d+$/;
const isEmoticon = (t: ScriptToken | undefined): boolean => !!t && t.kind === 'word' && EMOTICON.test(t.norm);

/**
 * Folds words without letters or digits ("%", "...", "¿") into a neighbour: closing ones join the word before
 * ("99" "%" → "99%"), a leading one the word after.
 */
export function foldSymbolWords(words: readonly HeardWord[]): HeardWord[] {
	const out: HeardWord[] = [];
	let lead: HeardWord | null = null;
	for (const w of words) {
		if (typeof w?.text !== 'string' || !w.text.trim()) continue;
		const text = w.text.trim();
		if (normalizeWord(text)) {
			const next: HeardWord = { ...w, text };
			if (lead) {
				next.text = lead.text + next.text;
				next.start = Math.min(lead.start, next.start);
				lead = null;
			}
			out.push(next);
			continue;
		}
		const prev = out[out.length - 1];
		if (prev) {
			prev.text += text;
			prev.end = Math.max(prev.end, w.end);
		} else {
			const held = lead as HeardWord | null;
			lead = held ? { ...held, text: held.text + text, end: w.end } : { ...w, text };
		}
	}
	return out;
}

const chars = (s: string) => Math.max(1, [...s].length);

/** `texts` spread over `[start, end]` by character count, each ≥ 1 flick while the span allows it. */
function spread(texts: readonly string[], start: number, end: number): Array<{ start: number; end: number }> {
	const span = Math.max(0, end - start);
	const total = texts.reduce((n, t) => n + chars(t), 0);
	let acc = 0;
	const out: Array<{ start: number; end: number }> = [];
	for (let i = 0; i < texts.length; i++) {
		const a = start + Math.floor((span * acc) / total);
		acc += chars(texts[i]!);
		const b = i === texts.length - 1 ? end : start + Math.floor((span * acc) / total);
		out.push({ start: a, end: Math.max(a, b) });
	}
	return out;
}

const minConfidence = (ws: readonly HeardWord[]): number | null => {
	let c: number | null = null;
	for (const w of ws)
		if (typeof w.confidence === 'number' && Number.isFinite(w.confidence))
			c = c === null ? w.confidence : Math.min(c, w.confidence);
	return c;
};

/** One span's words rebuilt from the script (`rebuildSpans` with one span). */
export function rebuildSpan(input: RebuildSpanInput): SpanRebuild {
	const { heard, ...rest } = input;
	return rebuildSpans({ ...rest, spans: [heard] })[0]!;
}

export type RebuildSpansInput = Omit<RebuildSpanInput, 'heard'> & {
	/** Each kept span's heard words (media flicks, inside the span), the spans in media order. */
	spans: ReadonlyArray<readonly HeardWord[]>;
	/**
	 * Each span's current transcript words: emoticons there ("XD", added by hand — never heard) are carried over,
	 * after the rebuilt word before them.
	 */
	previous?: ReadonlyArray<ReadonlyArray<{ text: string; start: number; end: number }>>;
};

/** Inserts an emoticon right after `words[i]` (a short slice; the word lends time when the next word is closer). */
function attachEmoticon(words: RebuiltWord[], i: number, text: string, before?: number): void {
	const F = FLICKS_PER_SECOND;
	const len = Math.round(REBUILD_DEFAULTS.emoticonSeconds * F);
	const last = words[i]!;
	const nextStart = before ?? words[i + 1]?.start ?? Number.POSITIVE_INFINITY;
	if (nextStart - last.end < len) {
		const lend = Math.min(
			len - Math.max(0, nextStart - last.end),
			Math.floor((last.end - last.start) * REBUILD_DEFAULTS.maxLendShare),
		);
		last.end -= Math.max(0, lend);
	}
	const start = last.end;
	const end = Math.max(start, Math.min(nextStart, start + len));
	words.splice(i + 1, 0, { text, start, end, confidence: null, origin: 'emoticon' });
}

type SpanState = {
	out: RebuiltWord[];
	/** Script index of each written word (−1: a heard word kept as heard). */
	sIndex: number[];
	emitted: Set<number>;
	counts: SpanRebuildCounts;
	cells: number;
};

/**
 * The kept spans' words rebuilt from the script (the module comment's rules). All spans are aligned in one pass, in
 * media order — a span then reads the script where its neighbours do (a few words alone could align to another
 * occurrence of them) — and the path is cut back into spans: nothing missing is inserted across a span boundary.
 * Each result is sorted, non-overlapping and inside its heard words' extent (inserted words only take time between or
 * from heard words).
 */
export function rebuildSpans(input: RebuildSpansInput): SpanRebuild[] {
	const per = (input.spans ?? []).map((list) =>
		foldSymbolWords(
			[...(list ?? [])]
				.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
				.sort((x, y) => x.start - y.start || x.end - y.end),
		),
	);
	const all: HeardWord[] = [];
	const spanOf: number[] = [];
	per.forEach((list, k) => {
		for (const w of list) {
			all.push(w);
			spanOf.push(k);
		}
	});
	const state: SpanState[] = per.map(() => ({
		out: [],
		sIndex: [],
		emitted: new Set<number>(),
		counts: { exact: 0, replaced: 0, inserted: 0, emoticons: 0, dropped: 0, kept: 0 },
		cells: 0,
	}));
	const asHeard = (k: number): SpanRebuild => {
		const counts: SpanRebuildCounts = {
			exact: 0,
			replaced: 0,
			inserted: 0,
			emoticons: 0,
			dropped: 0,
			kept: 0,
		};
		counts.kept = per[k]!.length;
		return {
			words: per[k]!.map((w) => ({ ...w, confidence: w.confidence ?? null, origin: 'kept' as const })),
			counts,
			aligned: false,
		};
	};
	if (!all.length) return state.map((sp) => ({ words: [], counts: sp.counts, aligned: false }));
	const al = alignTranscript({
		words: all,
		script: input.script,
		...(input.language !== undefined ? { language: input.language } : {}),
		...(input.options ? { options: input.options } : {}),
	});
	if (!al.ok) return per.map((_, k) => asHeard(k));
	const sTok = input.script.tokens;
	const keep = input.keepOffScript === true;
	const F = FLICKS_PER_SECOND;
	let cur = state[0]!;
	let curK = -1;
	let pending: number[] = [];
	let inPassage = false;
	const enter = (k: number) => {
		if (k === curK) return;
		curK = k;
		cur = state[k]!;
		pending = [];
		inPassage = false;
	};
	const push = (w: RebuiltWord, s: number) => {
		cur.out.push(w);
		cur.sIndex.push(s);
		if (s >= 0) cur.emitted.add(s);
	};
	const heardRange = (t: [number, number]): [number, number] => [
		al.tokens[t[0]]!.word,
		al.tokens[t[1]]!.word + 1,
	];
	const keepHeard = (a: number, b: number) => {
		for (let i = a; i < b; i++) {
			enter(spanOf[i]!);
			push({ ...all[i]!, confidence: all[i]!.confidence ?? null, origin: 'kept' }, -1);
			cur.counts.kept++;
		}
	};
	// missing script words between the last written word and the next one (which starts at `nextStart`)
	const placePending = (nextStart: number, next: RebuiltWord | null) => {
		const toks = pending.filter((s) => sTok[s]?.kind === 'word' && !cur.emitted.has(s));
		pending = [];
		const prev = cur.out[cur.out.length - 1];
		if (!toks.length || !prev) return;
		let cursor = prev.end;
		// emoticons right after the previous word ride on it
		let k = 0;
		while (k < toks.length && isEmoticon(sTok[toks[k]!])) k++;
		if (k) {
			const want = Math.round(REBUILD_DEFAULTS.emoticonSeconds * F) * k;
			const room = Math.max(0, nextStart - cursor);
			if (room < want) {
				const lend = Math.min(
					want - room,
					Math.floor((prev.end - prev.start) * REBUILD_DEFAULTS.maxLendShare),
				);
				prev.end -= Math.max(0, lend);
				cursor = prev.end;
			}
			const end = Math.min(nextStart, cursor + want);
			for (const [i, r] of spread(
				toks.slice(0, k).map((s) => sTok[s]!.text),
				cursor,
				Math.max(cursor, end),
			).entries()) {
				push({ text: sTok[toks[i]!]!.text, ...r, confidence: null, origin: 'emoticon' }, toks[i]!);
				cur.counts.emoticons++;
			}
			cursor = cur.out[cur.out.length - 1]!.end;
		}
		const rest = toks.slice(k);
		if (!rest.length) return;
		const before = cur.out[cur.out.length - 1]!;
		const need = Math.round(REBUILD_DEFAULTS.insertedSeconds * F) * rest.length;
		let gapEnd = nextStart;
		let gap = gapEnd - cursor;
		if (gap < need) {
			// borrow from the longer neighbour first, then the other; each keeps at least half of itself
			const prevLen = before.origin === 'emoticon' ? 0 : before.end - before.start;
			const nextLen = next ? next.end - next.start : 0;
			const lenders: Array<'prev' | 'next'> = prevLen >= nextLen ? ['prev', 'next'] : ['next', 'prev'];
			for (const who of lenders) {
				if (gap >= need) break;
				if (who === 'prev' && before.origin !== 'emoticon') {
					const lend = Math.min(
						need - gap,
						Math.floor((before.end - before.start) * REBUILD_DEFAULTS.maxLendShare),
					);
					if (lend > 0) {
						before.end -= lend;
						cursor = before.end;
					}
				} else if (who === 'next' && next) {
					const lend = Math.min(
						need - gap,
						Math.floor((next.end - next.start) * REBUILD_DEFAULTS.maxLendShare),
					);
					if (lend > 0) {
						next.start += lend;
						gapEnd = next.start;
					}
				}
				gap = gapEnd - cursor;
			}
		}
		for (const [i, r] of spread(
			rest.map((s) => sTok[s]!.text),
			cursor,
			Math.max(cursor, gapEnd),
		).entries()) {
			push(
				{
					text: sTok[rest[i]!]!.text,
					...r,
					confidence: REBUILD_DEFAULTS.scriptDerivedConfidence,
					origin: 'inserted',
				},
				rest[i]!,
			);
			cur.counts.inserted++;
		}
	};
	for (const st of al.steps) {
		if (st.kind === 'cell') {
			const [a, b] = heardRange(st.t);
			const hw = all.slice(a, b);
			const toks: number[] = [];
			for (let s = st.s[0]; s <= st.s[1]; s++) if (sTok[s]?.kind === 'word') toks.push(s);
			if (spanOf[a] !== spanOf[b - 1]) {
				// a merge cell across two spans: nothing to split it by, the heard words stay as heard
				keepHeard(a, b);
				pending = [];
				inPassage = false;
				continue;
			}
			enter(spanOf[a]!);
			if (!toks.length) {
				// a cell over directions only: nothing of the script to write
				if (keep) keepHeard(a, b);
				else cur.counts.dropped += hw.length;
				continue;
			}
			const origin = st.exact ? 'exact' : 'replaced';
			const words: RebuiltWord[] =
				toks.length === hw.length
					? toks.map((s, i) => ({
							text: sTok[s]!.text,
							start: hw[i]!.start,
							end: hw[i]!.end,
							confidence: hw[i]!.confidence ?? null,
							origin,
						}))
					: spread(
							toks.map((s) => sTok[s]!.text),
							hw[0]!.start,
							hw[hw.length - 1]!.end,
						).map((r, i) => ({
							text: sTok[toks[i]!]!.text,
							...r,
							confidence: minConfidence(hw),
							origin,
						}));
			if (pending.length) placePending(words[0]!.start, words[0]!);
			words.forEach((w, i) => {
				push(w, toks[i]!);
				cur.counts[origin]++;
			});
			cur.cells++;
			inPassage = true;
		} else if (st.kind === 'skip') {
			if (inPassage) for (let s = st.s[0]; s <= st.s[1]; s++) pending.push(s);
		} else if (st.kind === 'ins' || st.kind === 'off') {
			const [a, b] = heardRange(st.t);
			if (keep) {
				if (pending.length && spanOf[a] === curK) placePending(all[a]!.start, null);
				keepHeard(a, b);
			} else
				for (let i = a; i < b; i++) {
					enter(spanOf[i]!);
					cur.counts.dropped++;
				}
			if (st.kind === 'off') {
				pending = [];
				inPassage = false;
			}
		} else {
			// a jump: the next cell is elsewhere in the script, nothing between is missing
			pending = [];
			inPassage = false;
		}
	}
	return state.map((sp, k): SpanRebuild => {
		// nothing of the script heard in this span: its heard words are kept
		if (!sp.cells) return per[k]!.length ? asHeard(k) : { words: [], counts: sp.counts, aligned: false };
		// emoticons that follow a written script word in the script ride on it (the path may leave the script there)
		const words: RebuiltWord[] = [];
		for (let i = 0; i < sp.out.length; i++) {
			const w = sp.out[i]!;
			words.push(w);
			const s = sp.sIndex[i]!;
			if (s < 0 || w.origin === 'emoticon' || sp.sIndex[i + 1] === s + 1) continue;
			for (let e = s + 1; isEmoticon(sTok[e]) && !sp.emitted.has(e); e++) {
				attachEmoticon(words, words.length - 1, sTok[e]!.text, sp.out[i + 1]?.start);
				sp.emitted.add(e);
				sp.counts.emoticons++;
			}
		}
		// emoticons of the current transcript (never heard) ride on the rebuilt word before them
		for (const o of input.previous?.[k] ?? []) {
			if (!EMOTICON.test(normalizeWord(o.text))) continue;
			let i = -1;
			for (let j = 0; j < words.length; j++) if (words[j]!.start <= o.start) i = j;
			if (i < 0 || words[i + 1]?.origin === 'emoticon') continue;
			attachEmoticon(words, i, o.text);
			sp.counts.emoticons++;
		}
		// sorted, non-overlapping, integer flicks
		let prevEnd = Number.NEGATIVE_INFINITY;
		for (const w of words) {
			w.start = Math.round(Math.max(w.start, prevEnd));
			w.end = Math.round(Math.max(w.start, w.end));
			prevEnd = w.end;
		}
		return { words, counts: sp.counts, aligned: true };
	});
}

/** One `transcript.replaceWords` edit (media flicks). */
export type RebuildEdit = {
	start: number;
	end: number;
	expect: string[];
	words: Array<{ text: string; start: number; end: number; confidence: number | null }>;
};

/**
 * The `transcript.replaceWords` edits that write `words` over the span `[start, end)` of `old` (the transcript's
 * words): the span cut where no old word and no new word straddles, so no edit holds more than `maxWordsPerEdit` old or
 * new words. Edits that change nothing are left out. Null when the span cannot be cut that fine (an old word stretched
 * over more than `maxWordsPerEdit` new words).
 */
export function rebuildEdits(
	old: Transcript['words'],
	span: { start: number; end: number },
	words: readonly RebuiltWord[],
	maxWords: number = REBUILD_DEFAULTS.maxWordsPerEdit,
): RebuildEdit[] | null {
	const fresh = words.map((w) => ({
		text: w.text,
		start: Math.max(span.start, Math.min(span.end, w.start)),
		end: Math.max(span.start, Math.min(span.end, w.end)),
		confidence: w.confidence,
	}));
	for (let i = 1; i < fresh.length; i++)
		if (fresh[i]!.start < fresh[i - 1]!.end) fresh[i]!.start = fresh[i - 1]!.end;
	for (const w of fresh) w.end = Math.max(w.start, w.end);
	const inside = old.filter((w) => wordInReplaceSpan(w, span.start, span.end));
	const straddles = (t: number) => inside.some((o) => o.start < t && o.end > t);
	const oldIn = (a: number, b: number) => inside.filter((o) => wordInReplaceSpan(o, a, b)).length;
	// cut before new word i (at a time no old word straddles) once the running edit nears the limit
	const target = Math.max(1, maxWords - 8);
	const bounds: Array<{ t: number; i: number }> = [{ t: span.start, i: 0 }];
	for (let i = 1; i < fresh.length; i++) {
		const seg = bounds[bounds.length - 1]!;
		if (i - seg.i < target && oldIn(seg.t, fresh[i]!.start) < target) continue;
		const lo = fresh[i - 1]!.end;
		const hi = fresh[i]!.start;
		let t = !straddles(hi) ? hi : !straddles(lo) ? lo : -1;
		if (t < 0)
			for (const o of inside)
				if (o.end >= lo && o.end <= hi && !straddles(o.end)) {
					t = o.end;
					break;
				}
		if (t > seg.t) bounds.push({ t, i });
	}
	bounds.push({ t: span.end, i: fresh.length });
	const edits: RebuildEdit[] = [];
	for (let k = 0; k + 1 < bounds.length; k++) {
		const a = bounds[k]!.t;
		const b = bounds[k + 1]!.t;
		const expectWords = inside.filter((o) => wordInReplaceSpan(o, a, b));
		const mine = fresh.slice(bounds[k]!.i, bounds[k + 1]!.i);
		if (
			expectWords.length > REPLACE_WORDS_LIMITS.maxWordsPerEdit ||
			mine.length > REPLACE_WORDS_LIMITS.maxWordsPerEdit
		)
			return null;
		if (!expectWords.length && !mine.length) continue;
		const same =
			expectWords.length === mine.length &&
			expectWords.every(
				(o, i) =>
					o.text === mine[i]!.text &&
					o.start === mine[i]!.start &&
					o.end === mine[i]!.end &&
					(o.confidence ?? null) === (mine[i]!.confidence ?? null),
			);
		if (same) continue;
		edits.push({ start: a, end: b, expect: expectWords.map((o) => o.text), words: mine });
	}
	return edits;
}

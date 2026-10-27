// Spec 17 SC-050…SC-053: `transcript.replaceWords` — index-free word replacements in a transcript (each edit names the
// media-time span of the old words and their exact texts, so many edits compose in one transaction), with the
// subtitle text clips (spec 13 caption groups) and the older caption-track clips that show those words patched in
// place in the same command. `planReplaceWords` is the pure plan: the command applies exactly what it reports, and
// dry runs, the Review and MCP read the same report before anything changes. docs/wp-notes/script-correction.md
// "Applying fixes".
//
// Matching rules (documented assumptions, the wp-note):
// - a transcript word is in an edit's span `[start, end)` when it overlaps it (a zero-length word when it starts inside
//   it; for an empty span `[p, p)`, a word that straddles p) — the words in the span must equal `expect` exactly, else
//   the edit is stale (E_STALE);
// - the old and the new words are mapped into each sequence exactly as the sequence transcript maps them
//   (`sequenceWords`: top audio track first, a word belongs to the clip holding its midpoint), per audio clip;
// - a subtitle word matches an old word when the midpoint of one lies inside the other and their normalised texts are
//   equal (the old word as the group's text transforms show it, or as it is);
// - a clip whose words in that place no longer match (hand-edited), whose text no longer contains its words, or that
//   carries hand-made Source Text keys holding a copy of its text is left unchanged and reported as skipped.

import type { Keyframe } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Transcript, TranscriptWord } from '../schema/media.ts';
import type { CaptionsClip, Clip, Sequence, TextContent } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { captionClipName } from './model.ts';
import { type SeqWord, sequenceWords, transcriptForMedia } from './sequence-transcript.ts';
import {
	contentOfSequenceTime,
	isHighlightKeys,
	locateWords,
	nameOf,
	sequenceOfContentTime,
	wordsInSequence,
} from './subtitles/clips.ts';
import {
	type CaptionGroup,
	type CaptionWord,
	captionGroupsOf,
	captionOf,
	MAX_CAPTION_WORDS,
	type TextClipCaption,
} from './subtitles/model.ts';
import { rebreakSplices, spliceContent, type TextSplice } from './subtitles/patch.ts';
import { stripTrailing, transformWords, weakWordsFor } from './subtitles/text.ts';
import { normalizeWord, type WordBreak, wordsWellFormed } from './words.ts';

/** A new word of an edit: media-time flicks, and the confidence the producer measured (null = unknown). */
export type ReplaceWordsWord = { text: string; start: number; end: number; confidence: number | null };

/** One edit: the old words in `[start, end)` (media flicks) with their exact texts, and the words replacing them. */
export type ReplaceWordsEdit = {
	start: number;
	end: number;
	expect: readonly string[];
	words: readonly ReplaceWordsWord[];
};

export type ReplaceWordsInput = {
	transcriptId: string;
	edits: readonly ReplaceWordsEdit[];
	subtitles?: 'patch' | 'none';
	captionTracks?: 'patch' | 'none';
};

export const REPLACE_WORDS_LIMITS = {
	/** Edits per command (a "Replace all" over a long transcript). */
	maxEdits: 20_000,
	/** Old or new words per edit. */
	maxWordsPerEdit: 64,
	/** Characters of one new word. */
	maxWordText: 200,
} as const;

export type ReplaceWordsSkipReason =
	/** The clip's words there, or its text, no longer match the old words (edited by hand). */
	| 'edited'
	/** Hand-made Source Text keys hold copies of the old text. */
	| 'source-text-keyframes'
	/** A Source Text expression makes the text. */
	| 'expression'
	| 'locked'
	| 'reversed'
	/** The words span several subtitles and the fix cannot be divided among them (one would be left empty). */
	| 'split';

export type ReplaceWordsPatched = {
	clipId: string;
	sequenceId: string;
	kind: 'subtitle' | 'caption';
	groupId?: string;
	trackId: string;
	/** Indices of the edits that changed it. */
	edits: number[];
	before: string;
	after: string;
};

export type ReplaceWordsSkipped = {
	clipId: string;
	sequenceId: string;
	kind: 'subtitle' | 'caption';
	groupId?: string;
	trackId: string;
	edits: number[];
	reason: ReplaceWordsSkipReason;
};

export type ReplaceWordsStale = {
	index: number;
	start: number;
	end: number;
	expect: string[];
	/** The texts of the words in the span now. */
	actual: string[];
};

/** The patch report of a `transcript.replaceWords` (spec 17 SC-053). */
export type ReplaceWordsPlan = {
	ok: boolean;
	/** Why the command would be refused (absent when `ok`). */
	problem?: { code: 'E_NOT_FOUND' | 'E_INVALID_PARAM' | 'E_STALE'; message: string };
	transcriptId: string;
	/** Per edit: the replaced word indices `[from, to)` of the current transcript, the old and the new texts. */
	edits: Array<{
		index: number;
		start: number;
		end: number;
		from: number;
		to: number;
		before: string[];
		after: string[];
	}>;
	patched: ReplaceWordsPatched[];
	skipped: ReplaceWordsSkipped[];
	stale: ReplaceWordsStale[];
};

/** What the command writes (the plan's data). */
export type ReplaceWordsWork = {
	plan: ReplaceWordsPlan;
	/** Transcript word splices, in ascending order (apply from the last): `[from, to)` → `words`. */
	splices: Array<{ from: number; to: number; words: TranscriptWord[] }>;
	/** Words after the edits whose break moved to them (a deleted first word of a line or segment). */
	breaks: Array<{ index: number; breakBefore: WordBreak }>;
	words: TranscriptWord[];
	text: Array<{
		sequenceId: string;
		clipId: string;
		content: TextContent;
		words: CaptionWord[];
		name: string;
	}>;
	captions: Array<{
		sequenceId: string;
		clipId: string;
		transcriptId: string;
		words: TranscriptWord[];
		name: string;
	}>;
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Why the edits are malformed (E_INVALID_PARAM), or null. */
export function replaceWordsEditsProblem(edits: readonly ReplaceWordsEdit[]): string | null {
	if (!Array.isArray(edits) || edits.length === 0) return 'Give at least one edit';
	if (edits.length > REPLACE_WORDS_LIMITS.maxEdits)
		return `At most ${REPLACE_WORDS_LIMITS.maxEdits} edits per command (${edits.length} given)`;
	for (let i = 0; i < edits.length; i++) {
		const e = edits[i]!;
		if (!e || typeof e !== 'object') return `Edit ${i} is not an object`;
		if (!isInt(e.start) || !isInt(e.end) || e.start < 0 || e.end < e.start)
			return `Edit ${i}: start and end are non-negative integer flicks with start ≤ end`;
		if (!Array.isArray(e.expect) || !Array.isArray(e.words)) return `Edit ${i}: expect and words are lists`;
		if ((e.expect as readonly unknown[]).some((x) => typeof x !== 'string'))
			return `Edit ${i}: expect lists the old words' texts`;
		if (!e.expect.length && !e.words.length) return `Edit ${i} replaces nothing with nothing`;
		if (
			e.expect.length > REPLACE_WORDS_LIMITS.maxWordsPerEdit ||
			e.words.length > REPLACE_WORDS_LIMITS.maxWordsPerEdit
		)
			return `Edit ${i}: at most ${REPLACE_WORDS_LIMITS.maxWordsPerEdit} old and new words`;
		let prevEnd = e.start;
		for (let k = 0; k < e.words.length; k++) {
			const w = e.words[k]!;
			if (!w || typeof w.text !== 'string' || !w.text.length || /\s/.test(w.text))
				return `Edit ${i}, word ${k}: a word is non-empty text without spaces`;
			if (w.text.length > REPLACE_WORDS_LIMITS.maxWordText)
				return `Edit ${i}, word ${k}: at most ${REPLACE_WORDS_LIMITS.maxWordText} characters`;
			if (!isInt(w.start) || !isInt(w.end) || w.end < w.start)
				return `Edit ${i}, word ${k}: start and end are integer flicks with start ≤ end`;
			if (w.start < e.start || w.end > e.end)
				return `Edit ${i}, word ${k} lies outside the edit's span [${e.start}, ${e.end}]`;
			if (w.start < prevEnd) return `Edit ${i}: the words are not sorted or overlap (word ${k})`;
			if (
				w.confidence !== null &&
				!(typeof w.confidence === 'number' && w.confidence >= 0 && w.confidence <= 1)
			)
				return `Edit ${i}, word ${k}: confidence is a number in 0…1 or null`;
			prevEnd = w.end;
		}
		const prev = edits[i - 1];
		if (prev && e.start < prev.end) return `Edits ${i - 1} and ${i} overlap or are not sorted by start`;
	}
	return null;
}

/** Whether a transcript word lies in an edit's span (see the file comment). */
function inSpan(w: { start: number; end: number }, start: number, end: number): boolean {
	if (start === end) return w.start < start && w.end > start;
	if (w.start === w.end) return w.start >= start && w.start < end;
	return w.start < end && w.end > start;
}

/** The word indices `[from, to)` in an edit's span (from = to = the insertion point when none). */
function spanRange(words: readonly TranscriptWord[], start: number, end: number): [number, number] {
	// words are sorted with non-decreasing ends (INV-012): the first that may be in the span ends at or after start
	let lo = 0;
	let hi = words.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (words[mid]!.end < start) lo = mid + 1;
		else hi = mid;
	}
	let from = -1;
	let to = -1;
	for (let i = lo; i < words.length && words[i]!.start <= end; i++) {
		if (inSpan(words[i]!, start, end)) {
			if (from < 0) from = i;
			to = i + 1;
		} else if (from >= 0) break;
	}
	if (from >= 0) return [from, to];
	let at = lo;
	while (at < words.length && words[at]!.start < start) at++;
	return [at, at];
}

const mid = (w: { start: number; end: number }) => w.start + Math.floor((w.end - w.start) / 2);
const contains = (x: number, w: { start: number; end: number }) =>
	w.start <= x && (x < w.end || (w.start === w.end && x === w.start));
/** A subtitle / caption word and an old word are the same place when the midpoint of one lies inside the other. */
const samePlace = (a: { start: number; end: number }, b: { start: number; end: number }) =>
	contains(mid(a), b) || contains(mid(b), a);

function emptyPlan(transcriptId: string): ReplaceWordsPlan {
	return { ok: true, transcriptId, edits: [], patched: [], skipped: [], stale: [] };
}

/**
 * The patch report of a replacement, computed on `doc` without changing it (spec 17 SC-053): the edits with the word
 * indices they replace, the subtitle and caption clips patched and skipped (with why), and the stale edits. Never
 * throws; `ok: false` with `problem` = what the command would refuse with.
 */
export function planReplaceWords(doc: ProjectDocument, input: ReplaceWordsInput): ReplaceWordsPlan {
	return computeReplaceWords(doc, input).plan;
}

/** The plan and the data the command writes (`planReplaceWords` is its report). Never throws. */
export function computeReplaceWords(doc: ProjectDocument, input: ReplaceWordsInput): ReplaceWordsWork {
	const fail = (
		code: NonNullable<ReplaceWordsPlan['problem']>['code'],
		message: string,
		plan?: ReplaceWordsPlan,
	) => ({
		plan: {
			...(plan ?? emptyPlan(String(input?.transcriptId ?? ''))),
			ok: false,
			problem: { code, message },
		},
		splices: [],
		breaks: [],
		words: [],
		text: [],
		captions: [],
	});
	try {
		const tid = input?.transcriptId;
		const t =
			typeof tid === 'string' && doc.transcripts && Object.hasOwn(doc.transcripts, tid)
				? doc.transcripts[tid]
				: undefined;
		if (!t) return fail('E_NOT_FOUND', `Transcript not found: ${String(tid)}`);
		const bad = replaceWordsEditsProblem(input.edits);
		if (bad) return fail('E_INVALID_PARAM', bad);
		const words = t.words;
		const ranges = input.edits.map((e) => spanRange(words, e.start, e.end));
		for (let i = 1; i < ranges.length; i++)
			if (ranges[i]![0] < ranges[i - 1]![1])
				return fail('E_INVALID_PARAM', `Word ${ranges[i]![0]} lies in the spans of edits ${i - 1} and ${i}`);
		const plan = emptyPlan(t.id);
		input.edits.forEach((e, i) => {
			const [from, to] = ranges[i]!;
			const actual = words.slice(from, to).map((w) => w.text);
			if (actual.length !== e.expect.length || actual.some((x, k) => x !== e.expect[k]))
				plan.stale.push({ index: i, start: e.start, end: e.end, expect: [...e.expect], actual });
		});
		if (plan.stale.length) {
			const s = plan.stale[0]!;
			return fail(
				'E_STALE',
				`${plan.stale.length} edit(s) are stale: the words of edit ${s.index} are now "${s.actual.join(' ')}", not "${s.expect.join(' ')}"`,
				plan,
			);
		}
		// the new transcript words
		const splices: ReplaceWordsWork['splices'] = [];
		const breaks: ReplaceWordsWork['breaks'] = [];
		const next: TranscriptWord[] = [];
		const newRanges: Array<[number, number]> = [];
		let cursor = 0;
		let carry: WordBreak | null = null;
		input.edits.forEach((e, i) => {
			const [from, to] = ranges[i]!;
			for (let k = cursor; k < from; k++) {
				const w = words[k]!;
				if (carry && k === cursor && w.breakBefore === 'none') {
					next.push({ ...w, breakBefore: carry });
					breaks.push({ index: k, breakBefore: carry });
				} else next.push(w);
				carry = null;
			}
			const old = words.slice(from, to);
			const n = old.length;
			const m = e.words.length;
			const speaker = old[0]?.speaker ?? words[from - 1]?.speaker ?? words[to]?.speaker ?? null;
			// the first replaced word's break stays (or the break of a deleted word just before it)
			const first: WordBreak =
				old[0] && old[0].breakBefore !== 'none' ? old[0].breakBefore : (carry ?? 'none');
			const fresh: TranscriptWord[] = e.words.map((w, k) => ({
				text: w.text,
				start: w.start,
				end: w.end,
				confidence: w.confidence,
				speaker: n === m ? old[k]!.speaker : speaker,
				breakBefore: k === 0 ? first : n === m ? old[k]!.breakBefore : 'none',
			}));
			if (m > 0) carry = null;
			else if (old[0] && old[0].breakBefore !== 'none') carry = old[0].breakBefore;
			newRanges.push([next.length, next.length + m]);
			next.push(...fresh);
			splices.push({ from, to, words: fresh });
			cursor = to;
		});
		for (let k = cursor; k < words.length; k++) {
			const w = words[k]!;
			if (carry && k === cursor && w.breakBefore === 'none') {
				next.push({ ...w, breakBefore: carry });
				breaks.push({ index: k, breakBefore: carry });
			} else next.push(w);
			carry = null;
		}
		const wf = wordsWellFormed(next);
		if (wf) return fail('E_INVALID_PARAM', `The edits would leave the transcript malformed: ${wf}`, plan);
		plan.edits = input.edits.map((e, i) => ({
			index: i,
			start: e.start,
			end: e.end,
			from: ranges[i]![0],
			to: ranges[i]![1],
			before: [...e.expect],
			after: e.words.map((w) => w.text),
		}));
		const work: ReplaceWordsWork = { plan, splices, breaks, words: next, text: [], captions: [] };
		if (t.mediaId !== null && transcriptForMedia(doc, t.mediaId)?.id === t.id)
			patchSequences(doc, t, next, input, ranges, newRanges, work);
		return work;
	} catch (e) {
		return fail(
			'E_INVALID_PARAM',
			`Cannot plan the replacement: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Subtitle and caption-track patch (SC-051 / SC-052)

/** The words of one edit heard through one audio clip of a sequence, before and after (sequence flicks). */
type Occurrence = { edit: number; clipId: string; old: SeqWord[]; neu: SeqWord[] };

/** A clip that shows words: its sequence range and words (sequence flicks), and how it shows a transcript word. */
type Unit = {
	clip: Clip;
	kind: 'subtitle' | 'caption';
	group?: CaptionGroup;
	range: [number, number];
	words: Array<{ text: string; start: number; end: number }>;
	display: (texts: readonly string[], prev: string | null) => string[];
};

type Entry = { edit: number; j0: number; j1: number; neu: SeqWord[] };

function occurrencesOf(
	doc: ProjectDocument,
	after: Pick<ProjectDocument, 'transcripts'>,
	seq: Sequence,
	tid: string,
	ranges: ReadonlyArray<[number, number]>,
	newRanges: ReadonlyArray<[number, number]>,
): Occurrence[] {
	const span = (rs: ReadonlyArray<[number, number]>) => {
		const live = rs.filter(([a, b]) => b > a);
		return live.length ? { from: live[0]![0], to: live[live.length - 1]![1] } : null;
	};
	const editOf = (rs: ReadonlyArray<[number, number]>, index: number) => {
		let lo = 0;
		let hi = rs.length - 1;
		while (lo <= hi) {
			const m = (lo + hi) >> 1;
			const [a, b] = rs[m]!;
			if (index < a) hi = m - 1;
			else if (index >= b) lo = m + 1;
			else return m;
		}
		return -1;
	};
	const out = new Map<string, Occurrence>();
	const add = (w: SeqWord, edit: number, side: 'old' | 'neu') => {
		const key = `${edit}\u0000${w.clipId}`;
		let o = out.get(key);
		if (!o) {
			o = { edit, clipId: w.clipId, old: [], neu: [] };
			out.set(key, o);
		}
		o[side].push(w);
	};
	const os = span(ranges);
	if (os)
		for (const w of sequenceWords(doc, seq, { transcriptId: tid, ...os })) {
			const e = editOf(ranges, w.index);
			if (e >= 0) add(w, e, 'old');
		}
	const ns = span(newRanges);
	if (ns)
		for (const w of sequenceWords(after, seq, { transcriptId: tid, ...ns })) {
			const e = editOf(newRanges, w.index);
			if (e >= 0) add(w, e, 'neu');
		}
	for (const o of out.values()) {
		o.old.sort((a, b) => a.start - b.start);
		o.neu.sort((a, b) => a.start - b.start);
	}
	return [...out.values()];
}

/** Clips whose source the occurrence's audio clip feeds (a subtitle group's `sourceRef`). */
function groupHears(seq: Sequence, g: CaptionGroup, audioClipId: string, mediaId: string): boolean {
	const ref = g.sourceRef;
	if (ref.kind === 'sequence-transcript') return true;
	if (ref.kind === 'media') return ref.mediaId === mediaId;
	for (const id of ref.clipIds) {
		if (id === audioClipId) return true;
		const c = seq.clips[id];
		if (c?.linkId && seq.links[c.linkId]?.members.includes(audioClipId)) return true;
	}
	return false;
}

/**
 * Where an occurrence lands in the units that show it: per unit the run `[j0, j1)` of its words that are the old words
 * and the new words it takes; or the units to skip.
 */
function assign(
	units: readonly Unit[],
	occ: Occurrence,
	prevOld: string | null,
): {
	entries: Array<{ unit: Unit; entry: Entry }>;
	skip: Array<{ unit: Unit; reason: ReplaceWordsSkipReason }>;
} {
	const entries: Array<{ unit: Unit; entry: Entry }> = [];
	const skip: Array<{ unit: Unit; reason: ReplaceWordsSkipReason }> = [];
	const { old, neu } = occ;
	if (!old.length) {
		// an insertion: the unit showing the first new word's time, after the words before it
		if (!neu.length) return { entries, skip };
		const at = mid(neu[0]!);
		const unit = units.find((u) => u.words.length > 0 && at >= u.range[0] && at < u.range[1]);
		if (!unit) return { entries, skip };
		const j = unit.words.filter((w) => mid(w) < neu[0]!.start).length;
		entries.push({ unit, entry: { edit: occ.edit, j0: j, j1: j, neu } });
		return { entries, skip };
	}
	const lo = old[0]!.start;
	const hi = old[old.length - 1]!.end;
	const involved: Array<{ unit: Unit; hits: number[]; matched: number[]; ok: boolean }> = [];
	for (const u of units) {
		if (u.range[1] < lo || u.range[0] > hi) continue;
		const hits: number[] = [];
		const matched: number[] = [];
		u.words.forEach((w, j) => {
			const k = old.findIndex((o) => samePlace(w, o));
			if (k >= 0) {
				hits.push(j);
				matched.push(k);
			}
		});
		if (!hits.length) continue;
		let ok = hits.every((j, i) => j === hits[0]! + i) && matched.every((k, i) => k === matched[0]! + i);
		if (ok) {
			const shown = u.display(
				old.map((o) => o.text),
				prevOld,
			);
			ok = hits.every((j, i) => {
				const have = normalizeWord(u.words[j]!.text);
				const k = matched[i]!;
				return have === normalizeWord(shown[k] ?? '') || have === normalizeWord(old[k]!.text);
			});
		}
		involved.push({ unit: u, hits, matched, ok });
	}
	if (!involved.length) return { entries, skip };
	if (involved.some((x) => !x.ok)) {
		for (const x of involved) skip.push({ unit: x.unit, reason: x.ok ? 'split' : 'edited' });
		return { entries, skip };
	}
	const share: SeqWord[][] = involved.map(() => []);
	if (involved.length === 1) share[0] = [...neu];
	else
		for (const w of neu) {
			const m = mid(w);
			let best = involved.findIndex((x) => m >= x.unit.range[0] && m < x.unit.range[1]);
			if (best < 0)
				best =
					m < involved[0]!.unit.range[0]
						? 0
						: involved.reduce(
								(b, x, i) =>
									Math.abs(m - x.unit.range[0]) < Math.abs(m - involved[b]!.unit.range[0]) ? i : b,
								involved.length - 1,
							);
			share[best]!.push(w);
		}
	if (involved.some((x, i) => share[i]!.length === 0 && x.unit.words.length === x.hits.length)) {
		for (const x of involved) skip.push({ unit: x.unit, reason: 'split' });
		return { entries, skip };
	}
	involved.forEach((x, i) => {
		entries.push({
			unit: x.unit,
			entry: { edit: occ.edit, j0: x.hits[0]!, j1: x.hits[x.hits.length - 1]! + 1, neu: share[i]! },
		});
	});
	return { entries, skip };
}

function findTrack(seq: Sequence, id: string) {
	return (
		seq.videoTracks.find((t) => t.id === id) ??
		seq.audioTracks.find((t) => t.id === id) ??
		seq.captionTracks.find((t) => t.id === id)
	);
}

/** Keeps new words inside their neighbours (content time) so the list stays sorted and non-overlapping. */
function clampBetween<W extends { start: number; end: number }>(list: W[], fresh: ReadonlySet<W>): void {
	for (let i = 0; i < list.length; i++) {
		const w = list[i]!;
		if (!fresh.has(w)) continue;
		const prevEnd = i > 0 ? list[i - 1]!.end : 0;
		let nextStart = Number.POSITIVE_INFINITY;
		for (let k = i + 1; k < list.length; k++)
			if (!fresh.has(list[k]!)) {
				nextStart = list[k]!.start;
				break;
			}
		const start = Math.max(w.start, prevEnd);
		const end = Math.max(start, Math.min(w.end, nextStart));
		list[i] = { ...w, start: Math.min(start, end), end };
	}
}

function patchSequences(
	doc: ProjectDocument,
	t: Transcript,
	newWords: TranscriptWord[],
	input: ReplaceWordsInput,
	ranges: ReadonlyArray<[number, number]>,
	newRanges: ReadonlyArray<[number, number]>,
	work: ReplaceWordsWork,
): void {
	const subtitles = input.subtitles !== 'none';
	const captions = input.captionTracks !== 'none';
	if (!subtitles && !captions) return;
	const after: Pick<ProjectDocument, 'transcripts'> = {
		transcripts: { ...doc.transcripts, [t.id]: { ...t, words: newWords } },
	};
	const prevOf = (i: number) => t.words[ranges[i]![0] - 1]?.text ?? null;
	const prevNew = (i: number) => newWords[newRanges[i]![0] - 1]?.text ?? null;
	for (const seq of Object.values(doc.sequences)) {
		if (!Object.values(seq.clips).some((c) => c.kind === 'audio' && c.mediaId === t.mediaId)) continue;
		const occs = occurrencesOf(doc, after, seq, t.id, ranges, newRanges);
		if (!occs.length) continue;
		const rate = seq.settings.frameRate as Rational;
		const F = flicksPerFrame(rate);
		const groupUnits = new Map<string, Unit[]>();
		const captionUnits: Unit[] = [];
		const groups = captionGroupsOf(seq);
		for (const c of Object.values(seq.clips)) {
			const range: [number, number] = [c.start * F, (c.start + c.duration) * F];
			if (subtitles && c.kind === 'text') {
				const cap = captionOf(c);
				const g = cap ? groups[cap.groupId] : undefined;
				if (!cap || !g) continue;
				const list = groupUnits.get(g.id) ?? [];
				list.push({
					clip: c,
					kind: 'subtitle',
					group: g,
					range,
					words: wordsInSequence(c, rate),
					display: (texts, prev) =>
						prev === null
							? transformWords(texts, g.text, g.language)
							: transformWords([prev, ...texts], g.text, g.language).slice(1),
				});
				groupUnits.set(g.id, list);
			} else if (captions && c.kind === 'captions') {
				const tr = doc.transcripts[(c as CaptionsClip).transcriptId];
				if (!tr || tr.mediaId !== null || tr.origin === 'subtitle-file' || tr.id === t.id) continue;
				captionUnits.push({
					clip: c,
					kind: 'caption',
					range,
					words: tr.words.map((w) => {
						const a = sequenceOfContentTime(c, w.start, rate);
						const b = sequenceOfContentTime(c, w.end, rate);
						return { text: w.text, start: Math.min(a, b), end: Math.max(a, b) };
					}),
					display: (texts) => [...texts],
				});
			}
		}
		const perUnit = new Map<
			Unit,
			{ entries: Entry[]; skip: ReplaceWordsSkipReason | null; edits: Set<number> }
		>();
		const note = (u: Unit) => {
			let x = perUnit.get(u);
			if (!x) {
				x = { entries: [], skip: null, edits: new Set() };
				perUnit.set(u, x);
			}
			return x;
		};
		const run = (units: readonly Unit[], occ: Occurrence) => {
			const r = assign(units, occ, prevOf(occ.edit));
			for (const { unit, entry } of r.entries) {
				const x = note(unit);
				x.entries.push(entry);
				x.edits.add(entry.edit);
			}
			for (const { unit, reason } of r.skip) {
				const x = note(unit);
				x.skip ??= reason;
				x.edits.add(occ.edit);
			}
		};
		for (const occ of occs) {
			for (const units of groupUnits.values()) {
				const g = units[0]!.group!;
				if (groupHears(seq, g, occ.clipId, t.mediaId!)) run(units, occ);
			}
			if (captionUnits.length) run(captionUnits, occ);
		}
		for (const [u, x] of perUnit) {
			const base = {
				clipId: u.clip.id,
				sequenceId: seq.id,
				kind: u.kind,
				...(u.group ? { groupId: u.group.id } : {}),
				trackId: u.clip.trackId,
				edits: [...x.edits].sort((a, b) => a - b),
			};
			const reason = x.skip ?? unitSkip(seq, u, x.entries);
			if (reason) {
				work.plan.skipped.push({ ...base, reason });
				continue;
			}
			const done =
				u.kind === 'subtitle'
					? patchSubtitle(u, x.entries, rate, prevNew)
					: patchCaption(doc, u, x.entries, rate);
			if (typeof done === 'string') {
				work.plan.skipped.push({ ...base, reason: done });
				continue;
			}
			work.plan.patched.push({ ...base, before: done.before, after: done.after });
			if (done.kind === 'text')
				work.text.push({
					sequenceId: seq.id,
					clipId: u.clip.id,
					content: done.content,
					words: done.words,
					name: done.name,
				});
			else
				work.captions.push({
					sequenceId: seq.id,
					clipId: u.clip.id,
					transcriptId: done.transcriptId,
					words: done.words,
					name: done.name,
				});
		}
	}
	const order = (a: { sequenceId: string; clipId: string }, b: { sequenceId: string; clipId: string }) =>
		a.sequenceId.localeCompare(b.sequenceId) || a.clipId.localeCompare(b.clipId);
	work.plan.patched.sort(order);
	work.plan.skipped.sort(order);
}

/** Why a unit cannot be patched, before looking at its text (null: it can). */
function unitSkip(seq: Sequence, u: Unit, entries: readonly Entry[]): ReplaceWordsSkipReason | null {
	if (findTrack(seq, u.clip.trackId)?.locked) return 'locked';
	if (u.clip.speed.reverse) return 'reversed';
	const sorted = [...entries].sort((a, b) => a.j0 - b.j0 || a.j1 - b.j1);
	for (let i = 1; i < sorted.length; i++) if (sorted[i]!.j0 < sorted[i - 1]!.j1) return 'edited';
	if (u.kind === 'subtitle') {
		const c = u.clip as Extract<Clip, { kind: 'text' }>;
		if (c.content.expression) return 'expression';
		const cap = captionOf(c)!;
		if (!locateWords(c.content.text, cap.words)) return 'edited';
		const keys = (c as { sourceTextKeyframes?: Keyframe<TextContent>[] }).sourceTextKeyframes;
		if (
			keys?.length &&
			!isHighlightKeys(c) &&
			keys.some((k) => !!locateWords(k.value?.text ?? '', cap.words))
		)
			return 'source-text-keyframes';
	}
	return null;
}

type TextDone = {
	kind: 'text';
	content: TextContent;
	words: CaptionWord[];
	name: string;
	before: string;
	after: string;
};
type CaptionDone = {
	kind: 'caption';
	transcriptId: string;
	words: TranscriptWord[];
	name: string;
	before: string;
	after: string;
};

/** Splices a subtitle's text and words (styled runs, paragraphs and line breaks kept; offending lines re-broken). */
function patchSubtitle(
	u: Unit,
	entries: readonly Entry[],
	rate: Rational,
	prevNew: (edit: number) => string | null,
): TextDone | ReplaceWordsSkipReason {
	const clip = u.clip as Extract<Clip, { kind: 'text' }>;
	const g = u.group!;
	const cap = captionOf(clip) as TextClipCaption;
	const text = clip.content.text;
	const pos = locateWords(text, cap.words);
	if (!pos) return 'edited';
	const n = cap.words.length;
	const strip = g.text.stripTrailingPunctuation;
	let words: CaptionWord[] = cap.words.map((w) => ({ ...w }));
	const fresh = new Set<CaptionWord>();
	const splices: TextSplice[] = [];
	const sorted = [...entries].sort((a, b) => b.j0 - a.j0 || b.j1 - a.j1);
	for (const e of sorted) {
		const shown = u.display(
			e.neu.map((w) => w.text),
			prevNew(e.edit),
		);
		if (strip && shown.length && e.j1 === n)
			shown[shown.length - 1] = stripTrailing(shown[shown.length - 1]!);
		// the new words in content time, with their display texts
		const content = e.neu.map((w, k) => {
			const a = contentOfSequenceTime(clip, w.start, rate);
			const b = contentOfSequenceTime(clip, w.end, rate);
			return { text: shown[k]!, start: Math.max(0, Math.min(a, b)), end: Math.max(0, Math.max(a, b)) };
		});
		for (const w of content) fresh.add(w);
		words = [...words.slice(0, e.j0), ...content, ...words.slice(e.j1)];
		// the text
		const oldCount = e.j1 - e.j0;
		const seps: string[] = [];
		for (let k = e.j0; k + 1 < e.j1; k++) seps.push(text.slice(pos[k]![1], pos[k + 1]![0]));
		let joined = '';
		const offs: Array<[number, number]> = [];
		shown.forEach((w, k) => {
			if (k > 0) joined += k - 1 < seps.length && k < oldCount ? seps[k - 1]! : ' ';
			offs.push([joined.length, joined.length + w.length]);
			joined += w;
		});
		if (oldCount > 0 && shown.length > 0) {
			splices.push({
				from: pos[e.j0]![0],
				to: pos[e.j1 - 1]![1],
				text: joined,
				oldWords: pos.slice(e.j0, e.j1),
				newWords: offs,
			});
		} else if (oldCount > 0) {
			// removed words take a separator with them
			if (e.j1 < n) splices.push({ from: pos[e.j0]![0], to: pos[e.j1]![0], text: '' });
			else if (e.j0 > 0) {
				splices.push({ from: pos[e.j0 - 1]![1], to: pos[e.j1 - 1]![1], text: '' });
				if (strip) {
					// the word before is the last one now
					const [a, b] = pos[e.j0 - 1]!;
					const s = stripTrailing(text.slice(a, b));
					if (s !== text.slice(a, b)) {
						splices.push({ from: a, to: b, text: s });
						const w = words[e.j0 - 1]!;
						words[e.j0 - 1] = { ...w, text: stripTrailing(w.text) };
					}
				}
			} else return 'split';
		} else if (shown.length > 0) {
			if (e.j0 < n)
				splices.push({
					from: pos[e.j0]![0],
					to: pos[e.j0]![0],
					text: `${joined} `,
					newWords: offs,
				});
			else
				splices.push({
					from: pos[n - 1]![1],
					to: pos[n - 1]![1],
					text: ` ${joined}`,
					newWords: offs.map(([a, b]) => [a + 1, b + 1] as [number, number]),
				});
		}
	}
	if (!words.length) return 'split';
	clampBetween(words, fresh);
	if (words.length > MAX_CAPTION_WORDS) return 'split';
	let content = spliceContent(clip.content as TextContent, splices);
	content = spliceContent(
		content,
		rebreakSplices(content.text, g.rules.maxChars, g.rules.lines, weakWordsFor(g.language)),
	);
	if (!locateWords(content.text, words)) return 'edited';
	return {
		kind: 'text',
		content,
		words,
		name: clip.name === nameOf(text) ? nameOf(content.text) : clip.name,
		before: text,
		after: content.text,
	};
}

/** Splices the private words of an older caption-track clip (breaks and speakers kept). */
function patchCaption(
	doc: ProjectDocument,
	u: Unit,
	entries: readonly Entry[],
	rate: Rational,
): CaptionDone | ReplaceWordsSkipReason {
	const clip = u.clip as CaptionsClip;
	const tr = doc.transcripts[clip.transcriptId]!;
	let list: TranscriptWord[] = tr.words.map((w) => ({ ...w }));
	const fresh = new Set<TranscriptWord>();
	const sorted = [...entries].sort((a, b) => b.j0 - a.j0 || b.j1 - a.j1);
	for (const e of sorted) {
		const old = list.slice(e.j0, e.j1);
		const n = old.length;
		const m = e.neu.length;
		const speaker = old[0]?.speaker ?? list[e.j0 - 1]?.speaker ?? list[e.j0]?.speaker ?? null;
		const add: TranscriptWord[] = e.neu.map((w, k) => {
			const a = contentOfSequenceTime(clip, w.start, rate);
			const b = contentOfSequenceTime(clip, w.end, rate);
			return {
				text: w.text,
				start: Math.max(0, Math.min(a, b)),
				end: Math.max(0, Math.max(a, b)),
				confidence: w.confidence,
				speaker: n === m ? old[k]!.speaker : speaker,
				breakBefore: n === m ? old[k]!.breakBefore : k === 0 ? (old[0]?.breakBefore ?? 'none') : 'none',
			};
		});
		for (const w of add) fresh.add(w);
		const nextWord = list[e.j1];
		if (m === 0 && old[0] && old[0].breakBefore !== 'none' && nextWord && nextWord.breakBefore === 'none')
			list[e.j1] = { ...nextWord, breakBefore: old[0].breakBefore };
		list = [...list.slice(0, e.j0), ...add, ...list.slice(e.j1)];
	}
	if (!list.length) return 'split';
	clampBetween(list, fresh);
	if (wordsWellFormed(list)) return 'edited';
	const before = tr.words.map((w) => w.text).join(' ');
	const after = list.map((w) => w.text).join(' ');
	return {
		kind: 'caption',
		transcriptId: tr.id,
		words: list,
		name: clip.name === captionClipName(before) ? captionClipName(after) : clip.name,
		before,
		after,
	};
}

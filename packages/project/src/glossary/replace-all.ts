// "Replace all N" after a manual word edit (spec 17 SC-071; docs/wp-notes/script-correction.md "Personal
// glossary"): the user corrected one occurrence of a misrecognised spelling in the Transcript tab; this finds the
// other occurrences of the same recogniser spelling in the sequence's transcripts and returns them as plain data in
// the `transcript.replaceWords` edit shape (SC-050: media-time span, the exact old texts `expect`, the new words).
// Nothing is applied here: the caller sends one `transcript.replaceWords` per transcript in one transaction, and the
// command refuses an edit whose words changed meanwhile (`E_STALE`).
//
// Rules:
// - "Same spelling" = the same run of words compared with `normalizeWord` (markup and edge punctuation removed,
//   lower case; accents count). Words that normalise to nothing (lone punctuation) never match.
// - The new text's own edge punctuation (`"glimer box,"` corrected to `"Glimmerbox,"`) belongs to the edited spot:
//   each occurrence keeps its own leading ¿ ¡ « “ ( and trailing . , ; : ! ? … » ” ), like the readings of SC-031.
// - The first letter is capitalised where the recogniser capitalised the first old word (sentence start); the user's
//   casing is kept otherwise (assumption: a correction's casing is the right spelling, documented in the wp-note).
// - New words share the occurrence's span in proportion to their character counts (like `transcript.editText` and the
//   audio-free fixes of SC-042) and carry no confidence (null: a manual fix).
// - The edited span itself (`exclude`), occurrences that would not change, and spans too short to split are left out.
// - An empty correction (deleting words) is not offered: deleting everywhere is not a spelling fix.
import { plainCaptionText } from '../captions/formats/core.ts';
import { transcriptForMedia } from '../captions/sequence-transcript.ts';
import { normalizeWord, spreadTokens } from '../captions/words.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Transcript } from '../schema/media.ts';
import { cleanGlossaryText } from './schema.ts';

export const REPLACE_ALL_LIMITS = {
	/** Words of the edited span. */
	maxQueryWords: 20,
	/** Characters of the correction. */
	maxTextChars: 1000,
	/** Occurrences returned (the rest are counted in `truncated`). */
	maxOccurrences: 5000,
	/** Context words on each side of an occurrence. */
	contextWords: 3,
} as const;

/** A new word of an edit (`transcript.replaceWords` `words[]`). Media time, integer flicks. */
export type ReplaceAllWord = { text: string; start: number; end: number; confidence: number | null };

/** One edit in the `transcript.replaceWords` shape: replaces the words of `[start, end)` whose texts are `expect`. */
export type ReplaceAllEdit = { start: number; end: number; expect: string[]; words: ReplaceAllWord[] };

export type ReplaceAllQuery = {
	/** The words of the edited span as the recogniser wrote them (before the edit). */
	oldWords: readonly string[];
	/** What the user typed for them. */
	newText: string;
	/** The edited span itself (already changed), in media time: never offered again. */
	exclude?: { transcriptId: string; start: number; end: number };
};

export type ReplaceAllOccurrence = {
	transcriptId: string;
	mediaId: string | null;
	/** Word indices when planned (for display and selection; the edit itself is index-free). */
	fromWord: number;
	toWord: number;
	edit: ReplaceAllEdit;
	/** A few words before and after, for the offer's list. */
	before: string;
	after: string;
};

export type ReplaceAllCommand = {
	type: 'transcript.replaceWords';
	transcriptId: string;
	edits: ReplaceAllEdit[];
};

export type ReplaceAllPlan = {
	occurrences: ReplaceAllOccurrence[];
	/** The occurrences as commands: one per transcript, edits sorted by time (one transaction). */
	commands: ReplaceAllCommand[];
	/** Occurrences left out beyond `REPLACE_ALL_LIMITS.maxOccurrences`. */
	truncated: number;
};

const LEAD = /^[¿¡«“‘"'([]+/u;
const TRAIL = /[.,;:!?…»”’"')\]]+$/u;
const EMPTY: ReplaceAllPlan = { occurrences: [], commands: [], truncated: 0 };

function capitalised(s: string): boolean {
	const m = /\p{L}/u.exec(plainCaptionText(s));
	return !!m && m[0] !== m[0].toLowerCase();
}

function capitaliseFirst(s: string): string {
	return s.replace(/\p{L}/u, (c) => c.toUpperCase());
}

/** The correction without its edge punctuation, as tokens; [] when nothing is left. */
function correctionTokens(newText: string): string[] {
	const core = cleanGlossaryText(newText.slice(0, REPLACE_ALL_LIMITS.maxTextChars))
		.replace(LEAD, '')
		.replace(TRAIL, '')
		.trim();
	return core ? core.split(' ').filter(Boolean) : [];
}

/** The new texts for one occurrence: its own edge punctuation and sentence-start capital. */
function textsFor(tokens: readonly string[], first: string, last: string): string[] {
	const out = [...tokens];
	const lead = LEAD.exec(first.trim())?.[0] ?? '';
	const trail = TRAIL.exec(last.trim())?.[0] ?? '';
	const firstCore = first.trim().replace(LEAD, '');
	if (capitalised(firstCore || first) && /^\P{L}*\p{Ll}/u.test(out[0]!)) out[0] = capitaliseFirst(out[0]!);
	out[0] = lead + out[0]!;
	out[out.length - 1] = out[out.length - 1]! + trail;
	return out;
}

/**
 * The other occurrences of the edited spelling in `transcripts` (SC-071 "Replace all N"). Pure and deterministic;
 * bounded by `REPLACE_ALL_LIMITS`.
 */
export function findReplaceAll(transcripts: readonly Transcript[], query: ReplaceAllQuery): ReplaceAllPlan {
	const q = query.oldWords
		.slice(0, REPLACE_ALL_LIMITS.maxQueryWords + 1)
		.map((w) => normalizeWord(String(w)));
	if (!q.length || q.length > REPLACE_ALL_LIMITS.maxQueryWords || q.some((w) => !w)) return EMPTY;
	const tokens = correctionTokens(String(query.newText ?? ''));
	if (!tokens.length) return EMPTY;
	const n = q.length;
	const occurrences: ReplaceAllOccurrence[] = [];
	let truncated = 0;
	const seen = new Set<string>();
	for (const t of transcripts) {
		if (seen.has(t.id)) continue;
		seen.add(t.id);
		const words = t.words;
		const norms = words.map((w) => normalizeWord(w.text));
		const ex = query.exclude && query.exclude.transcriptId === t.id ? query.exclude : null;
		for (let i = 0; i + n <= words.length; ) {
			let match = true;
			for (let k = 0; k < n; k++)
				if (norms[i + k] !== q[k]) {
					match = false;
					break;
				}
			if (!match) {
				i++;
				continue;
			}
			const a = words[i]!;
			const b = words[i + n - 1]!;
			const start = a.start;
			const end = Math.max(b.end, start);
			const expect = words.slice(i, i + n).map((w) => w.text);
			const texts = textsFor(tokens, a.text, b.text);
			const overlapsEdit = ex !== null && start < ex.end && end > ex.start;
			const same = texts.length === expect.length && texts.every((x, k) => x === expect[k]);
			if (!overlapsEdit && !same && end - start >= texts.length) {
				if (occurrences.length >= REPLACE_ALL_LIMITS.maxOccurrences) truncated++;
				else {
					const spread = spreadTokens(
						texts.map((text) => ({ text, breakBefore: 'none' as const })),
						start,
						end,
					);
					const c = REPLACE_ALL_LIMITS.contextWords;
					occurrences.push({
						transcriptId: t.id,
						mediaId: t.mediaId,
						fromWord: i,
						toWord: i + n - 1,
						edit: {
							start,
							end,
							expect,
							words: spread.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: null })),
						},
						before: words
							.slice(Math.max(0, i - c), i)
							.map((w) => w.text)
							.join(' '),
						after: words
							.slice(i + n, i + n + c)
							.map((w) => w.text)
							.join(' '),
					});
				}
			}
			i += n;
		}
	}
	const byTranscript = new Map<string, ReplaceAllEdit[]>();
	for (const o of occurrences) {
		const list = byTranscript.get(o.transcriptId);
		if (list) list.push(o.edit);
		else byTranscript.set(o.transcriptId, [o.edit]);
	}
	const commands: ReplaceAllCommand[] = [...byTranscript].map(([transcriptId, edits]) => ({
		type: 'transcript.replaceWords',
		transcriptId,
		edits: [...edits].sort((x, y) => x.start - y.start),
	}));
	return { occurrences, commands, truncated };
}

/**
 * The media transcripts a sequence's audio clips play (the transcript of each media, `transcriptForMedia`), in the
 * order the audio tracks and clips first use them. Nested sequences are not entered.
 */
export function sequenceMediaTranscripts(
	doc: Pick<ProjectDocument, 'transcripts' | 'sequences'>,
	sequenceId: string,
): Transcript[] {
	const seq = doc.sequences[sequenceId];
	if (!seq) return [];
	const order = new Map(seq.audioTracks.map((t, i) => [t.id, i]));
	const clips = Object.values(seq.clips)
		.filter((c) => c.kind === 'audio' && order.has(c.trackId))
		.sort((x, y) => order.get(x.trackId)! - order.get(y.trackId)! || x.start - y.start);
	const out: Transcript[] = [];
	const seen = new Set<string>();
	for (const c of clips) {
		if (c.kind !== 'audio') continue;
		const t = transcriptForMedia(doc, c.mediaId);
		if (t && !seen.has(t.id)) {
			seen.add(t.id);
			out.push(t);
		}
	}
	return out;
}

/** `findReplaceAll` over the transcripts of a sequence's audio clips (SC-071 "elsewhere in the sequence's transcripts"). */
export function findReplaceAllInSequence(
	doc: Pick<ProjectDocument, 'transcripts' | 'sequences'>,
	sequenceId: string,
	query: ReplaceAllQuery,
): ReplaceAllPlan {
	return findReplaceAll(sequenceMediaTranscripts(doc, sequenceId), query);
}

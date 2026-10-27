// Spec 17 SC-061: one proposal item of the `transcript-correction` feature per decided candidate — commands
// `[transcript.replaceWords]` with the edit the aligner built (`replaceWordsEdit`, used verbatim: audio-retimed fixes
// span previous word end → next word start, a `del` edit may take in the following word), the review meta and the
// default selection (Maybe items start unselected). Inputs are plain data in the shapes of spec 17 §2.3–§2.5;
// docs/wp-notes/script-correction.md "Applying fixes".
import { type ReplaceWordsEdit, replaceWordsEditsProblem } from '../captions/replace-words.ts';
import { PROPOSAL_ITEM_ID_RE, PROPOSAL_LIMITS, type ProposalItemInput } from '../proposals/schema.ts';

export type TranscriptFixKind = 'sub' | 'merge' | 'del' | 'join' | 'glossary';
export type TranscriptFixCategory = 'proper' | 'english' | 'function' | 'other';
export type TranscriptFixGroup = 'fix' | 'spelling' | 'maybe';

/** A candidate disagreement between the transcript and the script (SC-020…SC-026). */
export type TranscriptFixCandidate = {
	transcriptId: string;
	mediaId: string;
	kind: TranscriptFixKind;
	category: TranscriptFixCategory;
	/** The transcript words of the region, exact texts (`expect`); [] for `del` (script words to insert). */
	asr: readonly string[];
	/** The script words of the region. */
	script: readonly string[];
	/** Media-time span (flicks) of the candidate's own words (the item's span is the edit's). */
	start: number;
	end: number;
	contextBefore: readonly string[];
	contextAfter: readonly string[];
	/** Stable fingerprint (SC-026): rejections and staleness. */
	fingerprint: string;
};

/** What verification decided for a candidate (SC-034). The new words are the edit's (SC-040…SC-042). */
export type TranscriptFixDecision = {
	group: TranscriptFixGroup;
	/** The rule that decided it (`sub`, `spelling`, `del`, `join`, `glossary`, `maybe`…). */
	rule: string;
	/** Δ_tok (SC-033); null for decisions made without audio (joins, glossary spellings). */
	deltaTok: number | null;
};

/** Why a fix edit cannot be a valid `transcript.replaceWords` edit (words outside the span, spaces…), or null. */
export function transcriptFixEditProblem(edit: ReplaceWordsEdit): string | null {
	return replaceWordsEditsProblem([edit]);
}

export type TranscriptFixItemMeta = {
	group: TranscriptFixGroup;
	kind: TranscriptFixKind;
	category: TranscriptFixCategory;
	asr: string[];
	script: string[];
	deltaTok: number | null;
	rule: string;
	mediaId: string;
	/** The edit's span (media flicks). */
	start: number;
	end: number;
	contextBefore: string[];
	contextAfter: string[];
	fingerprint: string;
};

const LABEL_WORDS = 12;
const clip = (words: readonly string[]) =>
	words.length > LABEL_WORDS ? `${words.slice(0, LABEL_WORDS).join(' ')} …` : words.join(' ');

/** An item id from a fingerprint: proposal-safe characters, ≤ 64 (a hash suffix keeps distinct fingerprints apart). */
export function transcriptFixItemId(fingerprint: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < fingerprint.length; i++) {
		h ^= fingerprint.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	const hash = h.toString(36).padStart(7, '0');
	const safe = fingerprint.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
	const id = `fix:${safe.slice(0, 64 - 5 - hash.length - 1)}:${hash}`.replace(/::/g, ':');
	return PROPOSAL_ITEM_ID_RE.test(id) ? id : `fix:${hash}`;
}

/**
 * The proposal item of a decided candidate: label "asr → new", group, one `transcript.replaceWords` command with `edit`
 * as given (subtitles and caption tracks patched), the review meta (`start` / `end` = the edit's span), and
 * `selected: false` for Maybe items (an "all" accept leaves them). Throws a RangeError naming the problem when the edit
 * is malformed (`transcriptFixEditProblem`): a producer bug, never a document state.
 */
export function transcriptFixItem(
	candidate: TranscriptFixCandidate,
	decision: TranscriptFixDecision,
	edit: ReplaceWordsEdit,
	opts: { id?: string } = {},
): ProposalItemInput {
	const bad = transcriptFixEditProblem(edit);
	if (bad) throw new RangeError(`Fix ${candidate.fingerprint}: ${bad.replace(/^Edit 0[,:]? ?/, '')}`);
	const after = edit.words.map((w) => w.text);
	const before = edit.expect.length ? clip(edit.expect) : '+';
	const label = `${before} → ${after.length ? clip(after) : '∅'}`.slice(0, PROPOSAL_LIMITS.maxLabel);
	const meta: TranscriptFixItemMeta = {
		group: decision.group,
		kind: candidate.kind,
		category: candidate.category,
		asr: [...candidate.asr],
		script: [...candidate.script],
		deltaTok: decision.deltaTok,
		rule: decision.rule,
		mediaId: candidate.mediaId,
		start: edit.start,
		end: edit.end,
		contextBefore: [...candidate.contextBefore],
		contextAfter: [...candidate.contextAfter],
		fingerprint: candidate.fingerprint,
	};
	return {
		id: opts.id ?? transcriptFixItemId(candidate.fingerprint),
		label,
		group: decision.group,
		commands: [
			{
				type: 'transcript.replaceWords',
				transcriptId: candidate.transcriptId,
				edits: [
					{
						start: edit.start,
						end: edit.end,
						expect: [...edit.expect],
						words: edit.words.map((w) => ({
							text: w.text,
							start: w.start,
							end: w.end,
							confidence: w.confidence,
						})),
					},
				],
			},
		],
		meta,
		...(decision.group === 'maybe' ? { selected: false } : {}),
	};
}

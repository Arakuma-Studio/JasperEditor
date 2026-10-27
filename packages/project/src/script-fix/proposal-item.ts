// Spec 17 SC-061: one proposal item of the `transcript-correction` feature per decided candidate — commands
// `[transcript.replaceWords]` (one edit: the candidate's ASR words → the decided words), the review meta and the
// default selection (Maybe items start unselected). Inputs are plain data in the shapes of spec 17 §2.3–§2.5 (the
// aligner and the speech decisions produce them); docs/wp-notes/script-correction.md "Applying fixes".
import type { ReplaceWordsWord } from '../captions/replace-words.ts';
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
	/** Media-time span (flicks) of the region: the ASR words, or for `del` the gap between the neighbours. */
	start: number;
	end: number;
	contextBefore: readonly string[];
	contextAfter: readonly string[];
	/** Stable fingerprint (SC-026): rejections and staleness. */
	fingerprint: string;
};

/** What verification decided for a candidate (SC-034, SC-040…SC-042). */
export type TranscriptFixDecision = {
	group: TranscriptFixGroup;
	/** The rule that decided it (`sub`, `spelling`, `del`, `join`, `glossary`, `maybe`…). */
	rule: string;
	/** Δ_tok (SC-033); null for decisions made without audio (joins, glossary spellings). */
	deltaTok: number | null;
	/** The new words, re-timed, inside `[start, end]`. */
	words: readonly ReplaceWordsWord[];
};

export type TranscriptFixItemMeta = {
	group: TranscriptFixGroup;
	kind: TranscriptFixKind;
	category: TranscriptFixCategory;
	asr: string[];
	script: string[];
	deltaTok: number | null;
	rule: string;
	mediaId: string;
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
 * The proposal item of a decided candidate: label "asr → new", group, one `transcript.replaceWords` command (subtitles
 * and caption tracks patched), the review meta, and `selected: false` for Maybe items (an "all" accept leaves them).
 */
export function transcriptFixItem(
	candidate: TranscriptFixCandidate,
	decision: TranscriptFixDecision,
	opts: { id?: string } = {},
): ProposalItemInput {
	const after = decision.words.map((w) => w.text);
	const before = candidate.asr.length ? clip(candidate.asr) : '+';
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
		start: candidate.start,
		end: candidate.end,
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
						start: candidate.start,
						end: candidate.end,
						expect: [...candidate.asr],
						words: decision.words.map((w) => ({
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

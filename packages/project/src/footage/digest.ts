// Spec 18 AF-DIG-001: the footage digest — every transcribed media (or `mediaIds`, or one sequence in sequence time)
// as packed phrase lines an agent reads instead of watching (docs/wp-notes/agent-footage-digest.md):
//
//   # Footage digest: <project name>
//   ## <mediaId> "<name>" (43.0 s, 1920×1080 29.97 fps, 8 phrases, speakers S0 S1)
//     [002.52-005.36] S0 Ninety percent of what a web agent does is ~completely wasted.
//   ## <mediaId> "<name>" (12.0 s, audio only) — no transcript: transcribe it with `transcribe`
//
// Times are seconds with two decimals, zero-padded to the widest time shown (at least three integer digits, as in
// video-use's format). `~` marks words with confidence < 0.6. `maxChars` (default 40 000, 1 000…200 000) cuts only
// between media and ends with "… N more media not shown: pass mediaIds"; a first media larger than the budget is cut
// at a phrase boundary with "… P more phrases not shown". Pure; never throws on malformed transcripts.

import { tickOf } from '../captions/formats/rate.ts';
import { sequenceWords } from '../captions/sequence-transcript.ts';
import { sequenceDuration } from '../derive/index.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND } from '../time.ts';
import {
	type FootageMedia,
	footageDuration,
	footageMedia,
	footageName,
	fpsText,
	mediaFacts,
	secondsText,
} from './media.ts';
import { DIGEST_LOW_CONFIDENCE, type FootagePhrase, footagePhrases, oneLine } from './phrases.ts';

export const DIGEST_DEFAULT_MAX_CHARS = 40_000;
export const DIGEST_MIN_MAX_CHARS = 1_000;
export const DIGEST_MAX_CHARS_LIMIT = 200_000;
/** Integer digits every digest time has at least (video-use's `[002.52-005.36]`). */
const MIN_TIME_DIGITS = 3;

export type FootageError = {
	ok: false;
	code: 'E_NOT_FOUND' | 'E_INVALID_PARAM' | 'E_TOO_LARGE';
	message: string;
	hint: string;
	details?: Record<string, unknown>;
};

export type DigestPhrase = {
	/** Flicks (media time, or sequence time for a sequence section). */
	start: number;
	end: number;
	/** `S0`, `S1`… in order of first appearance in the section, or null without a speaker. */
	speaker: string | null;
	/** The words, `~` before low-confidence ones. */
	text: string;
};

export type DigestSection = {
	id: string;
	kind: 'media' | 'sequence';
	name: string;
	/** The section's bound in flicks (media duration / sequence end), null when unknown. */
	end: number | null;
	transcribed: boolean;
	/** The phrases shown. */
	phrases: DigestPhrase[];
};

export type FootageDigest = {
	ok: true;
	text: string;
	/** The sections shown (whole, except a first section cut at a phrase boundary). */
	sections: DigestSection[];
	/** Ids shown / left out by `maxChars` (media ids, or the sequence id). */
	shown: string[];
	notShown: string[];
	/** Phrases of the first section left out when it alone was larger than `maxChars` (0 otherwise). */
	cutPhrases: number;
};

export type DigestOptions = {
	mediaIds?: readonly string[] | null;
	sequenceId?: string | null;
	maxChars?: number | null;
};

/** `maxChars` clamped to 1 000…200 000 (default 40 000). */
export function digestBudget(maxChars: number | null | undefined): number {
	if (typeof maxChars !== 'number' || Number.isNaN(maxChars)) return DIGEST_DEFAULT_MAX_CHARS;
	return Math.min(DIGEST_MAX_CHARS_LIMIT, Math.max(DIGEST_MIN_MAX_CHARS, Math.floor(maxChars)));
}

/** Hundredths of a second of `flicks` (rounded; monotonic). */
const centis = (flicks: number) => Math.round((flicks * 100) / FLICKS_PER_SECOND);

function timeText(flicks: number, digits: number): string {
	const c = centis(flicks);
	return `${String(Math.floor(c / 100)).padStart(digits, '0')}.${String(c % 100).padStart(2, '0')}`;
}

/** Integer digits of the widest time among `phrases`. */
function widest(phrases: Iterable<DigestPhrase>): number {
	let d = MIN_TIME_DIGITS;
	for (const p of phrases) d = Math.max(d, String(Math.floor(centis(p.end) / 100)).length);
	return d;
}

/** Speaker labels S0, S1… by first appearance; `key` identifies a speaker. */
function labeller() {
	const labels = new Map<string, string>();
	return {
		label(key: string | null): string | null {
			if (key === null) return null;
			let l = labels.get(key);
			if (!l) {
				l = `S${labels.size}`;
				labels.set(key, l);
			}
			return l;
		},
		all: () => [...labels.values()],
	};
}

function phraseText(p: FootagePhrase): string {
	return p.words
		.map((w) => (w.confidence !== null && w.confidence < DIGEST_LOW_CONFIDENCE ? `~${w.text}` : w.text))
		.join(' ');
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const quoted = (name: string) => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A section before layout: its header line and phrases. */
type Draft = { section: DigestSection; header: string };

function mediaDraft(m: FootageMedia): Draft {
	const end = footageDuration(m.asset);
	const facts = mediaFacts(m);
	const id = oneLine(m.id);
	if (!m.transcript) {
		const tail = m.hasAudio ? ' — no transcript: transcribe it with `transcribe`' : '';
		return {
			section: { id: m.id, kind: 'media', name: m.name, end, transcribed: false, phrases: [] },
			header: `## ${id} ${quoted(m.name)} (${facts.join(', ')})${tail}`,
		};
	}
	const speakers = labeller();
	const phrases = footagePhrases(m.transcript.words, { end }).map((p) => ({
		start: p.start,
		end: p.end,
		speaker: speakers.label(p.speaker),
		text: phraseText(p),
	}));
	const labels = speakers.all();
	facts.push(plural(phrases.length, 'phrase'));
	if (labels.length) facts.push(`speakers ${labels.join(' ')}`);
	return {
		section: { id: m.id, kind: 'media', name: m.name, end, transcribed: true, phrases },
		header: `## ${id} ${quoted(m.name)} (${facts.join(', ')})`,
	};
}

function sequenceDraft(doc: ProjectDocument, seq: Sequence): Draft {
	const rate = seq.settings.frameRate;
	const endFrames = sequenceDuration(seq);
	const end = Number.isFinite(endFrames) && endFrames > 0 ? tickOf(endFrames, rate) : null;
	const words = sequenceWords(doc, seq).map((w) => ({
		text: w.text,
		start: w.start,
		end: w.end,
		confidence: w.confidence,
		// one speaker per transcript speaker key; null stays null
		speaker: w.speakerKey === null ? null : `${w.transcriptId}\u0000${w.speakerKey}`,
		breakBefore: doc.transcripts[w.transcriptId]?.words[w.index]?.breakBefore ?? 'none',
	}));
	const speakers = labeller();
	const phrases = footagePhrases(words, { end }).map((p) => ({
		start: p.start,
		end: p.end,
		speaker: speakers.label(p.speaker),
		text: phraseText(p),
	}));
	const item = Object.values(doc.items ?? {}).find((i) => i?.kind === 'sequence' && i.sequenceId === seq.id);
	const name = footageName(item?.name || seq.id);
	const facts = ['sequence'];
	if (end !== null) facts.push(secondsText(end));
	const fps = fpsText(rate.num, rate.den);
	facts.push(`${seq.settings.width}×${seq.settings.height}${fps ? ` ${fps} fps` : ''}`);
	facts.push(plural(phrases.length, 'phrase'));
	const labels = speakers.all();
	if (labels.length) facts.push(`speakers ${labels.join(' ')}`);
	return {
		section: { id: seq.id, kind: 'sequence', name, end, transcribed: phrases.length > 0, phrases },
		header: `## ${oneLine(seq.id)} ${quoted(name)} (${facts.join(', ')})`,
	};
}

const mediaNotice = (n: number) => `… ${n} more media not shown: pass mediaIds`;
const phraseNotice = (n: number, budget: number) =>
	budget < DIGEST_MAX_CHARS_LIMIT
		? `  … ${n} more phrases not shown: pass a larger maxChars (≤ ${DIGEST_MAX_CHARS_LIMIT})`
		: `  … ${n} more phrases not shown: the digest holds at most ${DIGEST_MAX_CHARS_LIMIT} characters`;

const phraseLine = (p: DigestPhrase, digits: number) =>
	`  [${timeText(p.start, digits)}-${timeText(p.end, digits)}] ${p.speaker ? `${p.speaker} ` : ''}${p.text}`;

/** Which drafts (and how many phrases of a cut first one) fit in `budget` with `digits`-wide times. */
function layout(title: string, drafts: Draft[], budget: number, digits: number) {
	let used = title.length + 1;
	let count = 0;
	let cut: { phrases: number } | null = null;
	for (let i = 0; i < drafts.length; i++) {
		const d = drafts[i]!;
		const after = drafts.length - i - 1;
		const reserve = after > 0 ? mediaNotice(after).length + 1 : 0;
		const lines = d.section.phrases.map((p) => phraseLine(p, digits).length + 1);
		const size = d.header.length + 1 + lines.reduce((a, b) => a + b, 0);
		if (used + size + reserve <= budget) {
			used += size;
			count++;
			continue;
		}
		if (i === 0) {
			// a first section larger than the budget: cut at a phrase boundary
			const total = d.section.phrases.length;
			let room = budget - used - reserve - (d.header.length + 1);
			let k = 0;
			while (k < total && room - lines[k]! - (phraseNotice(total - k - 1, budget).length + 1) >= 0) {
				room -= lines[k]!;
				k++;
			}
			if (room - (phraseNotice(total - k, budget).length + 1) >= 0) {
				count = 1;
				cut = { phrases: k };
			}
		}
		break;
	}
	return { count, cut };
}

function render(
	title: string,
	drafts: Draft[],
	count: number,
	cut: { phrases: number } | null,
	budget: number,
	digits: number,
) {
	const out = [title];
	for (let i = 0; i < count; i++) {
		const d = drafts[i]!;
		out.push(d.header);
		const ps = cut && i === 0 ? d.section.phrases.slice(0, cut.phrases) : d.section.phrases;
		for (const p of ps) out.push(phraseLine(p, digits));
		if (cut && i === 0 && cut.phrases < d.section.phrases.length)
			out.push(phraseNotice(d.section.phrases.length - cut.phrases, budget));
	}
	if (count < drafts.length) out.push(mediaNotice(drafts.length - count));
	return `${out.join('\n')}\n`;
}

/** The footage digest of `doc` (see the module comment). */
export function packFootageDigest(
	doc: ProjectDocument,
	opts: DigestOptions = {},
): FootageDigest | FootageError {
	const budget = digestBudget(opts.maxChars);
	const title = `# Footage digest: ${footageName(doc.name) || 'Untitled'}`;
	let drafts: Draft[];
	if (opts.sequenceId) {
		if (opts.mediaIds?.length)
			return {
				ok: false,
				code: 'E_INVALID_PARAM',
				message: 'Give mediaIds or sequenceId, not both',
				hint: 'sequenceId renders one sequence in sequence time; mediaIds renders media in media time.',
			};
		// own properties only: an id such as "constructor" names no sequence
		const seq =
			doc.sequences && Object.hasOwn(doc.sequences, opts.sequenceId) ? doc.sequences[opts.sequenceId] : undefined;
		if (!seq)
			return {
				ok: false,
				code: 'E_NOT_FOUND',
				message: `No sequence ${opts.sequenceId}`,
				hint: 'get_project lists the sequence ids.',
			};
		drafts = [sequenceDraft(doc, seq)];
	} else {
		const { media, missing } = footageMedia(doc, opts.mediaIds?.length ? opts.mediaIds : null);
		if (missing.length)
			return {
				ok: false,
				code: 'E_NOT_FOUND',
				message: `No media ${missing.slice(0, 10).join(', ')} in this project`,
				hint: 'list_media lists media ids.',
				details: { missing },
			};
		drafts = media.map(mediaDraft);
	}
	// lay out with the widest time of every section, then render with the widest time of what is shown (narrower
	// times only shorten lines, so the layout still fits)
	const first = layout(title, drafts, budget, widest(drafts.flatMap((d) => d.section.phrases)));
	const shownPhrases = drafts
		.slice(0, first.count)
		.flatMap((d, i) =>
			first.cut && i === 0 ? d.section.phrases.slice(0, first.cut.phrases) : d.section.phrases,
		);
	const digits = widest(shownPhrases);
	const text = render(title, drafts, first.count, first.cut, budget, digits);
	const sections = drafts
		.slice(0, first.count)
		.map((d, i) =>
			first.cut && i === 0
				? { ...d.section, phrases: d.section.phrases.slice(0, first.cut.phrases) }
				: d.section,
		);
	return {
		ok: true,
		text,
		sections,
		shown: sections.map((s) => s.id),
		notShown: drafts.slice(first.count).map((d) => d.section.id),
		cutPhrases: first.cut ? drafts[0]!.section.phrases.length - first.cut.phrases : 0,
	};
}

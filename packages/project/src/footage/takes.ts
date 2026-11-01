// Spec 18 AF-TAK-001: takes of the same line across every transcribed media (docs/wp-notes/agent-footage-digest.md).
// Phrases (the digest's phrasing) are normalised — `cleanupNorm` (case, accents, punctuation) and the vocalic fillers
// of the transcript's language removed (transcript cleanup's lists, spec 14) — and two phrases are takes of one line
// when the LCS ratio of their word tokens, 2·LCS / (|a| + |b|), is ≥ `minSimilarity` (default 0.6). Groups are the
// connected components of that relation with ≥ 2 members. A member is `complete` when its last word ends a sentence
// and the cleanup detector's restart / false-start and stutter rules find nothing in it; the group suggests the last
// complete member (spec 14's default: keep the last complete take), else its last member.
//
// Bounded: at most 5 000 phrases are compared (E_TOO_LARGE beyond), candidate pairs come from a prefix-filtered
// token index (exact for this ratio), each phrase compares at most 200 tokens and the LCS work is capped. Pure.
import { builtinLists, cleanupLanguageOf, cleanupNorm, restartStopWords } from '../cleanup/lists.ts';
import {
	type AWord,
	lcs,
	type RuleContext,
	ruleRestarts,
	ruleStutters,
	type WordLabel,
} from '../cleanup/rules.ts';
import { NATURAL_SETTINGS } from '../cleanup/schema.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { FLICKS_PER_SECOND } from '../time.ts';
import type { FootageError } from './digest.ts';
import { footageDuration, footageMedia } from './media.ts';
import { type FootagePhrase, footagePhrases, meanConfidence } from './phrases.ts';

export const TAKES_DEFAULT_MIN_SIMILARITY = 0.6;
/** Most phrases compared in one call. */
export const TAKES_MAX_PHRASES = 5_000;
/** Phrases with fewer normalised tokens are not takes of a line ("Yes.", "Okay"). */
export const TAKE_MIN_TOKENS = 2;
/** Tokens of a phrase compared (a 12 s phrase of speech has ≈ 40). */
export const TAKE_MAX_TOKENS = 200;
/** LCS cells computed in one call at most (≈ 1 s); pathological input beyond it is refused. */
const MAX_LCS_CELLS = 200_000_000;

export type TakeMember = {
	mediaId: string;
	/** Media time, flicks. */
	start: number;
	end: number;
	text: string;
	/** The tokens compared, space-separated. */
	normalized: string;
	meanConfidence: number | null;
	complete: boolean;
};

export type TakeGroup = {
	id: string;
	/** In bin order of their media, then time. */
	members: TakeMember[];
	/** Index of the suggested member. */
	suggested: number;
};

export type TakesResult = { ok: true; groups: TakeGroup[]; phrasesCompared: number; minSimilarity: number };

/** Normalised tokens of `words` for take matching: `cleanupNorm`, empty and filler tokens removed. */
export function normaliseTakeTokens(words: readonly string[], language: string | null | undefined): string[] {
	const fillers = new Set(builtinLists(cleanupLanguageOf(language)).fillers);
	const out: string[] = [];
	for (const w of words) {
		const n = cleanupNorm(typeof w === 'string' ? w : '');
		if (n && !fillers.has(n)) out.push(n);
	}
	return out;
}

/** LCS ratio of two token lists: 2·LCS / (|a| + |b|), 0 when both are empty. Symmetric, in [0, 1]. */
export function takeSimilarity(a: readonly string[], b: readonly string[]): number {
	const n = a.length + b.length;
	return n ? (2 * lcs(a, b)) / n : 0;
}

/** Whether the last word ends a sentence (closing quotes / brackets allowed after the mark). */
const SENTENCE_END = /[.!?…。！？؟][\s"'”’»)\]]*$/u;

/** `complete`: ends a sentence and the detector's restart / false-start / stutter rules claim none of its words. */
function isComplete(p: FootagePhrase, language: string | null | undefined): boolean {
	const last = p.words[p.words.length - 1];
	if (!last || !SENTENCE_END.test(last.text)) return false;
	const lang = cleanupLanguageOf(language);
	const lists = builtinLists(lang);
	const words: AWord[] = [];
	for (const w of p.words) {
		const n = cleanupNorm(w.text);
		if (n)
			words.push({
				i: w.index,
				n,
				s: w.start / FLICKS_PER_SECOND,
				e: w.end / FLICKS_PER_SECOND,
				text: w.text,
				conf: w.confidence,
			});
	}
	const labels: (WordLabel | null)[] = new Array(words.length).fill(null);
	const ctx: RuleContext = {
		words,
		labels,
		settings: NATURAL_SETTINGS,
		lists,
		fillers: new Set(lists.fillers),
		stop: new Set(lists.stopWords),
		restartStop: new Set(restartStopWords(lang)),
		scriptTokens: [],
		voicedSeconds: null,
	};
	ruleRestarts(ctx);
	ruleStutters(ctx);
	return labels.every((l) => l === null);
}

class UnionFind {
	private readonly p: number[];
	constructor(n: number) {
		this.p = Array.from({ length: n }, (_, i) => i);
	}
	find(x: number): number {
		let r = x;
		while (this.p[r] !== r) r = this.p[r]!;
		while (this.p[x] !== r) {
			const nx = this.p[x]!;
			this.p[x] = r;
			x = nx;
		}
		return r;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb);
	}
}

type Cand = {
	mediaId: string;
	phrase: FootagePhrase;
	language: string | null;
	tokens: string[];
	key: string;
};

/** Takes of the same line (see the module comment). */
export function findTakes(
	doc: ProjectDocument,
	opts: { mediaIds?: readonly string[] | null; minSimilarity?: number | null } = {},
): TakesResult | FootageError {
	const raw = opts.minSimilarity;
	const s =
		typeof raw === 'number' && Number.isFinite(raw)
			? Math.min(1, Math.max(0.05, raw))
			: TAKES_DEFAULT_MIN_SIMILARITY;
	const { media, missing } = footageMedia(doc, opts.mediaIds?.length ? opts.mediaIds : null, 'transcribed');
	if (missing.length)
		return {
			ok: false,
			code: 'E_NOT_FOUND',
			message: `No media ${missing.slice(0, 10).join(', ')} in this project`,
			hint: 'list_media lists media ids.',
			details: { missing },
		};
	const cands: Cand[] = [];
	const perMedia: Array<{ mediaId: string; phrases: number }> = [];
	for (const m of media) {
		if (!m.transcript) continue;
		const language = typeof m.transcript.language === 'string' ? m.transcript.language : null;
		let n = 0;
		for (const phrase of footagePhrases(m.transcript.words, { end: footageDuration(m.asset) })) {
			const tokens = normaliseTakeTokens(
				phrase.words.map((w) => w.text),
				language,
			).slice(0, TAKE_MAX_TOKENS);
			if (tokens.length < TAKE_MIN_TOKENS) continue;
			cands.push({ mediaId: m.id, phrase, language, tokens, key: tokens.join(' ') });
			n++;
		}
		if (n) perMedia.push({ mediaId: m.id, phrases: n });
	}
	const tooLarge = (message: string): FootageError => ({
		ok: false,
		code: 'E_TOO_LARGE',
		message,
		hint: 'Pass mediaIds to compare fewer media at a time (details.media lists the phrases of each).',
		details: { phrases: cands.length, media: perMedia },
	});
	if (cands.length > TAKES_MAX_PHRASES)
		return tooLarge(
			`${cands.length} phrases to compare (at most ${TAKES_MAX_PHRASES}): pass mediaIds to narrow the search`,
		);

	// prefix filtering: order each phrase's token occurrences rarest first; two phrases with LCS ratio ≥ s share a
	// token occurrence within their first |x| − ⌈s·|x| / (2 − s)⌉ + 1 occurrences
	const occ = cands.map((c) => {
		const seen = new Map<string, number>();
		return c.tokens.map((t) => {
			const k = (seen.get(t) ?? 0) + 1;
			seen.set(t, k);
			return `${t}\u0000${k}`;
		});
	});
	const freq = new Map<string, number>();
	for (const list of occ) for (const t of list) freq.set(t, (freq.get(t) ?? 0) + 1);
	for (const list of occ) list.sort((a, b) => freq.get(a)! - freq.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
	const index = new Map<string, number[]>();
	const uf = new UnionFind(cands.length);
	let cells = 0;
	for (let i = 0; i < cands.length; i++) {
		const a = cands[i]!.tokens.length;
		const need = Math.ceil((s * a) / (2 - s) - 1e-9);
		const prefix = occ[i]!.slice(0, Math.min(a, Math.max(1, a - need + 1)));
		const seen = new Set<number>();
		for (const t of prefix) for (const j of index.get(t) ?? []) seen.add(j);
		for (const j of [...seen].sort((x, y) => x - y)) {
			const ci = cands[i]!;
			const cj = cands[j]!;
			const b = cj.tokens.length;
			if (2 * Math.min(a, b) < s * (a + b) - 1e-9) continue;
			let l: number;
			if (ci.key === cj.key) l = a;
			else {
				cells += a * b;
				if (cells > MAX_LCS_CELLS)
					return tooLarge('Too many similar phrases to compare at once: pass mediaIds to narrow the search');
				l = lcs(ci.tokens, cj.tokens);
			}
			if (2 * l >= s * (a + b) - 1e-9) uf.union(i, j);
		}
		for (const t of prefix) {
			const list = index.get(t);
			if (list) list.push(i);
			else index.set(t, [i]);
		}
	}

	const comps = new Map<number, number[]>();
	for (let i = 0; i < cands.length; i++) {
		const r = uf.find(i);
		const list = comps.get(r);
		if (list) list.push(i);
		else comps.set(r, [i]);
	}
	const groups: TakeGroup[] = [];
	for (const list of [...comps.values()].filter((l) => l.length >= 2).sort((x, y) => x[0]! - y[0]!)) {
		const members = list.map((i): TakeMember => {
			const c = cands[i]!;
			return {
				mediaId: c.mediaId,
				start: c.phrase.start,
				end: c.phrase.end,
				text: c.phrase.words.map((w) => w.text).join(' '),
				normalized: c.key,
				meanConfidence: meanConfidence(c.phrase),
				complete: isComplete(c.phrase, c.language),
			};
		});
		let suggested = members.length - 1;
		while (suggested > 0 && !members[suggested]!.complete) suggested--;
		if (!members[suggested]!.complete) suggested = members.length - 1;
		groups.push({ id: `t${groups.length + 1}`, members, suggested });
	}
	return { ok: true, groups, phrasesCompared: cands.length, minSimilarity: s };
}

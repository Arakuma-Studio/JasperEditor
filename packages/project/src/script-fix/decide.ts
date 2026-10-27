// Audio margins, decisions and the resulting transcript edits (spec 17 SC-033, SC-034, SC-040 … SC-042; edit shape of
// SC-050). Ported from the scriptfix spike (`sfanalyze.py` Δ_tok, `sffinal.py` `decide`; FINDINGS §2.5, §2.6, §4.1):
// Δ = LL(script reading) − LL(ASR reading) on the same window, Δ_tok = Δ / max(script-region tokens, ASR-region tokens,
// 1), then the strictness preset's margins. Fixed words take the forced alignment's times clamped into the gap
// between their neighbours; spelling fixes without audio keep the region's span and split it by character count.
// Pure.
import { spreadTokens } from '../captions/words.ts';
import type { FixCandidate } from './candidates.ts';
import { ASR_READING_ID, type ScoreWindow, type ScoreWindowResult, type ScoreWordResult } from './windows.ts';

/** SC-034 strictness presets (default `standard`). */
export const STRICTNESS_PRESETS = ['careful', 'standard', 'generous'] as const;
export type StrictnessPreset = (typeof STRICTNESS_PRESETS)[number];

/** Margins of one preset, in nats per token (Δ_tok ≥ margin passes). */
export type DecisionThresholds = {
	/** `sub` / `merge` / `glossary` fixed when Δ_tok ≥ this. */
	audio: number;
	/** Spelling rule: script side `proper` or `english` with psim ≥ `spellingMinPsim`, fixed when Δ_tok ≥ this. */
	spelling: number;
	spellingMinPsim: number;
	/** `del` (inserting script-only words) fixed when Δ_tok ≥ this. */
	del: number;
	/** Otherwise offered unselected ("Maybe") when Δ_tok ≥ this; below, the transcript is kept. */
	maybe: number;
};

/** SC-034 table. */
export const DECISION_PRESETS: Readonly<Record<StrictnessPreset, Readonly<DecisionThresholds>>> =
	Object.freeze({
		careful: Object.freeze({ audio: -1.0, spelling: -4, spellingMinPsim: 0.8, del: 0, maybe: -3 }),
		standard: Object.freeze({ audio: -1.5, spelling: -5, spellingMinPsim: 0.8, del: 0, maybe: -4 }),
		generous: Object.freeze({ audio: -2.0, spelling: -5, spellingMinPsim: 0.8, del: 0, maybe: -4 }),
	});

/** The audio evidence of one candidate (SC-033). */
export type CandidateScore = {
	candidateId: string;
	/** LL_k − LL_0 (nats). */
	delta: number;
	/** delta / max(scriptTokens, asrTokens, 1). */
	deltaTok: number;
	scriptTokens: number;
	asrTokens: number;
	/** Reading k's results for the replacement words (forced timing and probabilities). */
	words: ScoreWordResult[];
	/** Reading k's results for the words just before / after them (a `del` anchor's forced timing), if any. */
	before: ScoreWordResult | null;
	after: ScoreWordResult | null;
};

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Δ and Δ_tok of every candidate scored in `results` (SC-033). Region token counts come from the per-word token
 * counts. A candidate whose window or reading is missing or malformed (non-finite numbers, word counts that differ
 * from the request) gets no score.
 */
export function candidateScores(
	windows: readonly ScoreWindow[],
	results: readonly ScoreWindowResult[],
): Map<string, CandidateScore> {
	const out = new Map<string, CandidateScore>();
	const byId = new Map<string, ScoreWindowResult>();
	for (const r of Array.isArray(results) ? results : []) if (r && typeof r.id === 'string') byId.set(r.id, r);
	for (const w of windows) {
		const res = byId.get(w.id);
		if (!res || !Array.isArray(res.readings)) continue;
		const reading = (id: string) => {
			const req = w.readings.find((r) => r.id === id);
			const got = res.readings.find((r) => r && r.id === id);
			if (
				!req ||
				!got ||
				!finite(got.logprob) ||
				!Array.isArray(got.words) ||
				got.words.length !== req.words.length
			)
				return null;
			return got;
		};
		const base = reading(ASR_READING_ID);
		if (!base) continue;
		const tokens = (ws: readonly ScoreWordResult[], a: number, b: number) => {
			let n = 0;
			for (let k = a; k < b; k++) {
				const t = ws[k]?.tokens;
				if (!finite(t) || t < 0) return Number.NaN;
				n += t;
			}
			return n;
		};
		for (const reg of w.regions) {
			const rk = reading(reg.readingId);
			if (!rk) continue;
			const scriptTokens = tokens(rk.words, reg.from, reg.scriptTo);
			const asrTokens = tokens(base.words, reg.from, reg.asrTo);
			const delta = rk.logprob - base.logprob;
			if (!finite(scriptTokens) || !finite(asrTokens) || !finite(delta)) continue;
			out.set(reg.candidateId, {
				candidateId: reg.candidateId,
				delta,
				deltaTok: delta / Math.max(scriptTokens, asrTokens, 1),
				scriptTokens,
				asrTokens,
				words: rk.words.slice(reg.from, reg.scriptTo),
				before: rk.words[reg.from - 1] ?? null,
				after: rk.words[reg.scriptTo] ?? null,
			});
		}
	}
	return out;
}

/** SC-061 groups: Fixes, Spelling, Maybe. */
export type FixGroup = 'fix' | 'spelling' | 'maybe';
/** Which rule decided. */
export type FixRule =
	| 'audio'
	| 'spelling'
	| 'del'
	| 'join'
	| 'glossary-spelling'
	| 'maybe'
	| 'below-margin'
	| 'unscored';

/** A new transcript word of an edit (SC-050 `words`). */
export type FixedWord = { text: string; start: number; end: number; confidence: number | null };

/** The decision on one candidate. */
export type FixDecision = {
	candidateId: string;
	fingerprint: string;
	decision: 'fix' | 'maybe' | 'keep';
	/** Proposal group; null = keep the transcript (shown only in counts and the MCP report). */
	group: FixGroup | null;
	rule: FixRule;
	/** Null for decisions without audio (joins, glossary spellings) and unscored candidates. */
	deltaTok: number | null;
	/** Default selection in the review (Maybe items and rejected candidates start unselected). */
	selected: boolean;
	/** Media span the new words lie in ([start, end], the edit's span). */
	start: number;
	end: number;
	/** The new words after SC-040 / SC-042 timing ([] when kept). */
	words: FixedWord[];
};

/** The SC-050 `transcript.replaceWords` edit of one fix. */
export type ReplaceWordsEdit = { start: number; end: number; expect: string[]; words: FixedWord[] };

function thresholdsOf(s: StrictnessPreset | DecisionThresholds | undefined): DecisionThresholds {
	if (typeof s === 'string') return DECISION_PRESETS[s] ?? DECISION_PRESETS.standard;
	const d = DECISION_PRESETS.standard;
	if (!s || typeof s !== 'object') return d;
	const pick = (v: unknown, x: number) => (finite(v) ? v : x);
	return {
		audio: pick(s.audio, d.audio),
		spelling: pick(s.spelling, d.spelling),
		spellingMinPsim: pick(s.spellingMinPsim, d.spellingMinPsim),
		del: pick(s.del, d.del),
		maybe: pick(s.maybe, d.maybe),
	};
}

/**
 * Clamps words into [lo, hi] in order: each starts at or after the previous word's end, and each lasts at least one
 * flick while the span leaves one flick for every word still to come.
 */
function clampWords(words: FixedWord[], lo: number, hi: number): FixedWord[] {
	let cursor = lo;
	const n = words.length;
	return words.map((w, k) => {
		const lastStart = Math.max(cursor, hi - (n - k)); // room for one flick per remaining word
		const start = Math.min(lastStart, Math.max(cursor, Math.round(w.start)));
		const lastEnd = Math.max(start, hi - (n - k - 1));
		const end = Math.min(lastEnd, Math.max(Math.min(start + 1, lastEnd), Math.round(w.end)));
		cursor = end;
		return { ...w, start, end };
	});
}

/** The candidate's new words in order, with a `del` anchor placed where it reads (before or after the inserted words). */
function withAnchor<T>(candidate: FixCandidate, inserted: T[], anchor: T): T[] {
	return candidate.anchor?.side === 'before' ? [anchor, ...inserted] : [...inserted, anchor];
}

/**
 * SC-042: the candidate's display words spread over its span [start, end] by character count (like
 * `transcript.editText`); no confidence (they were not re-scored).
 */
export function splitByCharacters(candidate: FixCandidate): FixedWord[] {
	const a = candidate.anchor;
	const texts = a ? withAnchor(candidate, candidate.script, a.text) : candidate.script;
	const lo = a ? candidate.bounds.start : candidate.start;
	const hi = a ? Math.max(candidate.bounds.start, a.side === 'after' ? a.end : candidate.bounds.end) : candidate.end;
	const spread = spreadTokens(
		texts.map((text) => ({ text, breakBefore: 'none' as const })),
		lo,
		hi,
	);
	const out = spread.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: null as number | null }));
	if (a) out[a.side === 'before' ? 0 : out.length - 1]!.confidence = a.confidence;
	return clampWords(out, lo, hi);
}

/**
 * SC-040 / SC-041: the display words with the forced alignment's times of reading k, clamped into the candidate's
 * bounds (previous word's end … next word's start), confidence = the forced mean token probability. A `del` anchor
 * word is re-timed with them (its text and confidence kept). Falls back to the character split when the score's word
 * times are unusable.
 */
export function retimedWords(candidate: FixCandidate, score: CandidateScore): FixedWord[] {
	const a = candidate.anchor;
	const anchorScore = a ? (a.side === 'before' ? score.before : score.after) : null;
	const ws = score.words;
	const usable = (w: ScoreWordResult | null | undefined) => !!w && finite(w.start) && finite(w.end);
	if (ws.length !== candidate.script.length || !ws.every(usable) || (a && !usable(anchorScore)))
		return splitByCharacters(candidate);
	const fresh = candidate.script.map((text, k) => {
		const p = ws[k]!.probability;
		return {
			text,
			start: ws[k]!.start,
			end: ws[k]!.end,
			confidence: finite(p) ? Math.min(1, Math.max(0, p)) : null,
		};
	});
	const all = a
		? withAnchor(candidate, fresh, { text: a.text, start: anchorScore!.start, end: anchorScore!.end, confidence: a.confidence })
		: fresh;
	return clampWords(all, candidate.bounds.start, candidate.bounds.end);
}

/**
 * Decides one candidate (SC-034) and builds its new words. `score` is its audio evidence (absent: not scored).
 * Joins and glossary spelling fixes (`needsAudio: false`) are fixed without audio, in the Spelling group.
 */
export function decideFix(
	candidate: FixCandidate,
	score: CandidateScore | null | undefined,
	strictness: StrictnessPreset | DecisionThresholds = 'standard',
): FixDecision {
	const th = thresholdsOf(strictness);
	const base = { candidateId: candidate.id, fingerprint: candidate.fingerprint };
	const keep = (rule: FixRule, deltaTok: number | null): FixDecision => ({
		...base,
		decision: 'keep',
		group: null,
		rule,
		deltaTok,
		selected: false,
		start: candidate.start,
		end: candidate.end,
		words: [],
	});
	if (!candidate.needsAudio)
		return {
			...base,
			decision: 'fix',
			group: 'spelling',
			rule: candidate.kind === 'glossary' ? 'glossary-spelling' : 'join',
			deltaTok: null,
			selected: !candidate.rejected,
			start: candidate.start,
			end: candidate.end,
			words: splitByCharacters(candidate),
		};
	if (!score || !finite(score.deltaTok)) return keep('unscored', null);
	const d = score.deltaTok;
	let rule: FixRule | null = null;
	if (candidate.kind === 'del') {
		if (d >= th.del) rule = 'del';
	} else if (d >= th.audio) rule = 'audio';
	else if (
		(candidate.category === 'proper' || candidate.category === 'english') &&
		candidate.psim >= th.spellingMinPsim &&
		d >= th.spelling
	)
		rule = 'spelling';
	const timed = () => ({
		start: candidate.bounds.start,
		end: candidate.bounds.end,
		words: retimedWords(candidate, score),
	});
	if (rule)
		return {
			...base,
			decision: 'fix',
			group: 'fix',
			rule,
			deltaTok: d,
			selected: !candidate.rejected,
			...timed(),
		};
	if (d >= th.maybe)
		return {
			...base,
			decision: 'maybe',
			group: 'maybe',
			rule: 'maybe',
			deltaTok: d,
			selected: false,
			...timed(),
		};
	return keep('below-margin', d);
}

/** Decides every candidate of a media with the scores of `candidateScores` (input order kept). */
export function decideFixes(
	candidates: readonly FixCandidate[],
	scores: ReadonlyMap<string, CandidateScore>,
	strictness: StrictnessPreset | DecisionThresholds = 'standard',
): FixDecision[] {
	return candidates.map((c) => decideFix(c, scores.get(c.id), strictness));
}

/**
 * The SC-050 edit of a decided fix: the span its new words lie in, the exact texts of the transcript words in that
 * span (`[]` for `del`; the anchor word's text for a widened `del`), the new words. Null when the decision keeps the
 * transcript.
 */
export function replaceWordsEdit(candidate: FixCandidate, decision: FixDecision): ReplaceWordsEdit | null {
	if (decision.group === null || !decision.words.length) return null;
	return {
		start: decision.start,
		end: decision.end,
		expect: candidate.anchor ? [candidate.anchor.text] : [...candidate.asr],
		words: decision.words.map((w) => ({ ...w })),
	};
}

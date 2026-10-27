// Fix candidates (spec 17 SC-020 … SC-026, SC-031 display form, SC-073 glossary). Ported from the scriptfix spike
// (`sfalign.py` `candidates`, `sfjobs.py` `fmt_script` / `reading_for`, `sffinal.py` `decide` skip rules; FINDINGS
// §2.4, §2.5, §2.7, §5): a candidate is a maximal run of non-exact steps between exact cells, with anchors on both
// sides and at most 4 + 4 words. Added by the spec: spelling joins (SC-024), mixed regions split into their proper /
// plain parts (SC-025), glossary candidates (SC-073), stable fingerprints (SC-026). Pure; deterministic.
import { type AlignmentResult, type AlignOptions, alignOptions, type AlignStep, transcriptTokens } from './align.ts';
import { psim } from './phonetic.ts';
import type { ParsedScript, ScriptToken } from './script.ts';
import {
	functionWords,
	hash64,
	isContentWord,
	isEnglishWord,
	normalizeWord,
	type ScriptFixLanguage,
	scriptFixLanguage,
	spokenForm,
} from './text.ts';
import { FLICKS_PER_SECOND } from '../time.ts';

/** A transcript word as the fixer reads it (a `TranscriptWord` fits). Times are integer media flicks. */
export type FixWord = { text: string; start: number; end: number; confidence?: number | null };

/** A personal glossary entry as plain input (SC-070 storage lives elsewhere): ASR spellings → the right spelling. */
export type GlossaryEntryInput = { from: readonly string[]; to: string; lang?: string | null };

/** SC-021 kinds. `ins` (deleting transcript-only words) is never offered. */
export type FixKind = 'sub' | 'merge' | 'del' | 'join' | 'glossary';
/** SC-023 categories (numbers are never offered, so they have none). */
export type FixCategory = 'proper' | 'english' | 'function' | 'other';

/** A proposed fix of one transcript region. */
export type FixCandidate = {
	/** Unique within one media's candidate list: the fingerprint, with `#2`, `#3`… for repeats. */
	id: string;
	/** SC-026: media, normalised ASR words, normalised script words and ± 2 transcript words of context. */
	fingerprint: string;
	transcriptId: string;
	mediaId: string;
	kind: FixKind;
	category: FixCategory;
	/** Exact texts of the transcript words in the region ([] for `del`). */
	asr: string[];
	/** The replacement words in display form (SC-031 spelling, casing and punctuation); no whitespace inside a word. */
	script: string[];
	/** The script tokens (or glossary words) as written, before the display rules. */
	scriptSource: string[];
	/** Media flicks of the region; for `del`, the gap from the previous word's end to the next word's start. */
	start: number;
	end: number;
	/** Where re-timed words may go (SC-040): from the previous word's end to the next word's start. */
	bounds: { start: number; end: number };
	/** Transcript word indices [fromWord, toWord); for `del` both are the index of the word the insertion precedes. */
	fromWord: number;
	toWord: number;
	/** Script token indices [scriptFrom, scriptTo) (glossary: null). */
	scriptFrom: number | null;
	scriptTo: number | null;
	/** Script line / section of the region (glossary: null). */
	line: number | null;
	section: number | null;
	/** Transcript words before / after the region, for display. */
	contextBefore: string[];
	contextAfter: string[];
	/** Phonetic similarity of the concatenated ASR and script words (0 for `del`). */
	psim: number;
	/** False for spelling fixes decided without audio (`join`, glossary spellings that only change the split / casing). */
	needsAudio: boolean;
	/** Part of a mixed region split at its proper / plain boundary (SC-025). */
	mixed: boolean;
	/** The fingerprint is in the rejected list (only present when `includeRejected` asked for them). */
	rejected: boolean;
};

/** Why a disagreement between anchors is not offered (SC-021, SC-022). */
export type SkipReason =
	| 'ins'
	| 'anchors'
	| 'size'
	| 'direction'
	| 'number'
	| 'stylised'
	| 'rejected'
	| 'overlap';
export const SKIP_REASONS: readonly SkipReason[] = [
	'ins',
	'anchors',
	'size',
	'direction',
	'number',
	'stylised',
	'rejected',
	'overlap',
];

/** A region that is not offered (kept for counts and the MCP report; the list is capped, the counts are not). */
export type SkippedRegion = { reason: SkipReason; asr: string[]; script: string[]; start: number; end: number };

export type CandidateResult = {
	candidates: FixCandidate[];
	skipped: SkippedRegion[];
	skippedCounts: Record<SkipReason, number>;
};

export type FindCandidatesInput = {
	mediaId: string;
	transcriptId: string;
	words: readonly FixWord[];
	/** The transcript's language tag (default: the script's rule set). */
	language?: string | null;
	/** Script source (SC-002 + SC-013): both or neither. */
	script?: ParsedScript | null;
	alignment?: Extract<AlignmentResult, { ok: true }> | null;
	/** Personal glossary source (SC-073). */
	glossary?: readonly GlossaryEntryInput[] | null;
	/** Fingerprints the user rejected (SC-055): skipped unless `includeRejected`. */
	rejected?: Iterable<string> | null;
	includeRejected?: boolean;
	options?: Partial<AlignOptions>;
	/** Display context words on each side (default 3). */
	contextWords?: number;
};

const MAX_SKIPPED_LIST = 2000;
const MAX_GLOSSARY_ENTRIES = 2000;
const MAX_GLOSSARY_FROM = 20;
const MAX_GLOSSARY_WORDS = 8;
const FINGERPRINT_CONTEXT = 2;
/** SC-040 bound after the last word of a transcript (its audio pad). */
const END_PAD_FLICKS = Math.round(0.35 * FLICKS_PER_SECOND);
const PUNCT_START = /^[¿¡"“«(]+/u;
const PUNCT_END = /[.,;:!?…"”»)]+$/u;
const STYLISED = /([a-z])\1\1/;

type Ctx = {
	lang: ScriptFixLanguage;
	stop: ReadonlySet<string>;
	proper: ReadonlySet<string>;
	words: readonly FixWord[];
	norms: string[];
	mediaId: string;
	transcriptId: string;
	contextWords: number;
};

const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const capitalise = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);
const textOf = (w: FixWord | undefined) => (typeof w?.text === 'string' ? w.text : '');

function isProperToken(t: ScriptToken, proper: ReadonlySet<string>): boolean {
	return t.brandLike || proper.has(t.norm);
}

/**
 * SC-031 display form of replacement words: script spelling (outer punctuation removed), script casing only for
 * proper nouns (lower case otherwise), and the ASR region's punctuation — its leading ¿ ¡ « " ( and trailing . , ; : ! ?
 * … » " ) are carried, and the first word is capitalised when the ASR one was. With no ASR words (`del`) the first word
 * is capitalised at a sentence start. "&" reads as its spoken word.
 */
export function displayWords(
	words: ReadonlyArray<{ text: string; proper: boolean; spoken?: string }>,
	region: readonly string[],
	previousWord: string | null,
): string[] {
	const out = words.map((t) => {
		let w = t.spoken ?? t.text.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');
		if (!w) w = t.text;
		w = w.replace(/\s+/g, '');
		return t.proper ? w : w.toLowerCase();
	});
	if (!out.length) return out;
	const keepCase = (w: string) => /^\p{Ll}/u.test(w) && /\p{Lu}/u.test(w); // "iOS" stays "iOS"
	if (region.length) {
		const first = region[0]!.trim();
		const last = region[region.length - 1]!.trim();
		const core = first.replace(PUNCT_START, '');
		if (core && isUpper(core[0]!) && !keepCase(out[0]!)) out[0] = capitalise(out[0]!);
		const lead = PUNCT_START.exec(first);
		if (lead) out[0] = lead[0] + out[0];
		const trail = PUNCT_END.exec(last);
		if (trail) out[out.length - 1] = out[out.length - 1] + trail[0];
	} else if ((previousWord === null || /[.!?…]$/u.test(previousWord.trim())) && !keepCase(out[0]!))
		out[0] = capitalise(out[0]!);
	return out;
}

/** SC-023 category of a region from its script side (the ASR side when there is none). */
function categoryOf(scriptToks: readonly ScriptToken[], asrNorms: readonly string[], ctx: Ctx): FixCategory {
	if (scriptToks.some((t) => isProperToken(t, ctx.proper))) return 'proper';
	if (scriptToks.some((t) => isEnglishWord(t.norm, ctx.lang, ctx.stop))) return 'english';
	const ns = scriptToks.length ? scriptToks.map((t) => t.norm) : asrNorms;
	if (ns.length && ns.every((n) => ctx.stop.has(n) || n.length <= 2)) return 'function';
	return 'other';
}

function fingerprintOf(ctx: Ctx, from: number, to: number, scriptNorms: readonly string[]): string {
	const before: string[] = [];
	for (let k = from - 1; k >= 0 && before.length < FINGERPRINT_CONTEXT; k--) if (ctx.norms[k]) before.unshift(ctx.norms[k]!);
	const after: string[] = [];
	for (let k = to; k < ctx.words.length && after.length < FINGERPRINT_CONTEXT; k++) if (ctx.norms[k]) after.push(ctx.norms[k]!);
	const asr = ctx.norms.slice(from, to).filter(Boolean);
	const payload = [asr.join(' '), scriptNorms.join(' '), before.join(' '), after.join(' ')].join('|');
	const media = ctx.mediaId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
	return `sf1~${media}~${hash64(payload)}`;
}

/** SC-040 range for re-timed words of [from, to): previous word's end … next word's start (zero-length words excluded). */
function boundsOf(ctx: Ctx, from: number, to: number, start: number, end: number): { start: number; end: number } {
	const prev = ctx.words[from - 1];
	const next = ctx.words[to];
	let lo = prev ? prev.end + (prev.start === prev.end ? 1 : 0) : 0;
	let hi = next ? next.start - (next.start === next.end ? 1 : 0) : end + END_PAD_FLICKS;
	lo = Math.min(lo, start);
	hi = Math.max(hi, end);
	return { start: lo, end: hi };
}

function makeCandidate(
	ctx: Ctx,
	o: {
		kind: FixKind;
		category: FixCategory;
		from: number;
		to: number;
		script: string[];
		scriptSource: string[];
		scriptNorms: string[];
		scriptFrom: number | null;
		scriptTo: number | null;
		line: number | null;
		section: number | null;
		needsAudio: boolean;
		mixed: boolean;
	},
): FixCandidate {
	const { words } = ctx;
	const del = o.from === o.to;
	const start = del ? (words[o.from - 1]?.end ?? words[o.from]?.start ?? 0) : words[o.from]!.start;
	const end = del ? Math.max(start, words[o.from]?.start ?? start) : words[o.to - 1]!.end;
	const asrNorms = ctx.norms.slice(o.from, o.to).filter(Boolean);
	const a = asrNorms.map((n) => spokenForm(n, ctx.lang)).join('');
	const b = o.scriptNorms.map((n) => spokenForm(n, ctx.lang)).join('');
	const fingerprint = fingerprintOf(ctx, o.from, o.to, o.scriptNorms);
	return {
		id: fingerprint,
		fingerprint,
		transcriptId: ctx.transcriptId,
		mediaId: ctx.mediaId,
		kind: o.kind,
		category: o.category,
		asr: words.slice(o.from, o.to).map(textOf),
		script: o.script,
		scriptSource: o.scriptSource,
		start,
		end,
		bounds: del ? { start, end } : boundsOf(ctx, o.from, o.to, start, end),
		fromWord: o.from,
		toWord: o.to,
		scriptFrom: o.scriptFrom,
		scriptTo: o.scriptTo,
		line: o.line,
		section: o.section,
		contextBefore: words.slice(Math.max(0, o.from - ctx.contextWords), o.from).map(textOf),
		contextAfter: words.slice(o.to, o.to + ctx.contextWords).map(textOf),
		psim: a && b ? psim(a, b, ctx.lang) : 0,
		needsAudio: o.needsAudio,
		mixed: o.mixed,
		rejected: false,
	};
}

/** Finds the fix candidates of one media transcript (SC-020 … SC-026, SC-073). Never throws. */
export function findFixCandidates(input: FindCandidatesInput): CandidateResult {
	const opt = alignOptions(input.options);
	const words = Array.isArray(input.words) ? input.words : [];
	const script = input.script ?? null;
	const lang =
		input.language !== undefined && input.language !== null
			? scriptFixLanguage(input.language)
			: (script?.language ?? null);
	const glossary = sanitizeGlossary(input.glossary, lang);
	const proper = new Set(script?.properNorms ?? []);
	for (const g of glossary) for (const n of g.toNorms) proper.add(n);
	const ctx: Ctx = {
		lang,
		stop: functionWords(lang),
		proper,
		words,
		norms: words.map((w) => normalizeWord(textOf(w))),
		mediaId: String(input.mediaId ?? ''),
		transcriptId: String(input.transcriptId ?? ''),
		contextWords: Number.isFinite(input.contextWords) ? Math.max(0, Math.min(20, Math.floor(input.contextWords!))) : 3,
	};
	const skipped: SkippedRegion[] = [];
	const skippedCounts = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>;
	const skip = (reason: SkipReason, asr: string[], scriptWords: string[], start: number, end: number) => {
		skippedCounts[reason]++;
		if (skipped.length < MAX_SKIPPED_LIST) skipped.push({ reason, asr, script: scriptWords, start, end });
	};
	const out: FixCandidate[] = [];
	const alignment = input.alignment;
	if (script && alignment?.ok && alignment.tokens.every((t) => t.word < words.length))
		scriptCandidates(ctx, script, alignment.tokens, alignment.steps, opt, out, skip);
	if (glossary.length) {
		const taken = out.filter((c) => c.toWord > c.fromWord).map((c) => [c.fromWord, c.toWord] as const);
		glossaryCandidates(ctx, glossary, taken, out, skip);
	}
	// rejected fingerprints (SC-055)
	const rejected = new Set<string>();
	for (const r of input.rejected ?? []) if (typeof r === 'string') rejected.add(r);
	const kept: FixCandidate[] = [];
	for (const c of out) {
		if (rejected.has(c.fingerprint)) {
			if (!input.includeRejected) {
				skip('rejected', c.asr, c.script, c.start, c.end);
				continue;
			}
			c.rejected = true;
		}
		kept.push(c);
	}
	const kindOrder: Record<FixKind, number> = { sub: 0, merge: 1, del: 2, join: 3, glossary: 4 };
	kept.sort((x, y) => x.fromWord - y.fromWord || x.toWord - y.toWord || kindOrder[x.kind] - kindOrder[y.kind]);
	const seen = new Map<string, number>();
	for (const c of kept) {
		const n = (seen.get(c.fingerprint) ?? 0) + 1;
		seen.set(c.fingerprint, n);
		if (n > 1) c.id = `${c.fingerprint}#${n}`;
	}
	return { candidates: kept, skipped, skippedCounts };
}

function scriptCandidates(
	ctx: Ctx,
	script: ParsedScript,
	tokens: ReadonlyArray<{ word: number; norm: string }>,
	steps: readonly AlignStep[],
	opt: AlignOptions,
	out: FixCandidate[],
	skip: (reason: SkipReason, asr: string[], script: string[], start: number, end: number) => void,
): void {
	const st = script.tokens;
	const n = steps.length;
	const isExact = (x: AlignStep | undefined) => x !== undefined && x.kind === 'cell' && x.exact;
	const isBreak = (x: AlignStep) => x.kind === 'jump' || x.kind === 'jumpOff' || x.kind === 'off';
	const tsOf = (reg: readonly AlignStep[]) => {
		const ti: number[] = [];
		const sj: number[] = [];
		for (const s of reg) {
			if (s.kind === 'cell' || s.kind === 'ins') for (let i = s.t[0]; i <= s.t[1]; i++) ti.push(i);
			if (s.kind === 'cell' || s.kind === 'skip') for (let j = s.s[0]; j <= s.s[1]; j++) sj.push(j);
		}
		return { ti: [...new Set(ti)].sort((a, b) => a - b), sj: [...new Set(sj)].sort((a, b) => a - b) };
	};
	const anchorOk = (run: AlignStep[]) => {
		if (!run.length) return false;
		if (run.length >= opt.anchorRun) return true;
		const x = run[0]!;
		if (x.kind !== 'cell') return false;
		for (let j = x.s[0]; j <= x.s[1]; j++) if (isContentWord(st[j]!.norm, ctx.stop)) return true;
		return false;
	};
	const span = (ti: number[], insertAt: number) => {
		if (ti.length) return [tokens[ti[0]!]!.word, tokens[ti[ti.length - 1]!]!.word + 1] as const;
		return [insertAt, insertAt] as const;
	};
	const timeOf = (from: number, to: number) =>
		from < to
			? [ctx.words[from]!.start, ctx.words[to - 1]!.end]
			: [ctx.words[from - 1]?.end ?? 0, ctx.words[from]?.start ?? 0];
	const offer = (reg: AlignStep[], insertTok: number, mixed: boolean) => {
		const { ti, sj } = tsOf(reg);
		const [from, to] = span(ti, tokens[insertTok]!.word);
		const sToks = sj.map((j) => st[j]!);
		const asrWords = ctx.words.slice(from, to).map(textOf);
		const [t0, t1] = timeOf(from, to);
		if (!ti.length && !sj.length) return;
		if (!sj.length) return skip('ins', asrWords, [], t0!, t1!);
		const kind: FixKind = !ti.length
			? 'del'
			: reg.some((s) => s.kind === 'cell' && (s.t[1] > s.t[0] || s.s[1] > s.s[0]))
				? 'merge'
				: 'sub';
		const region = asrWords;
		const prevWord = from > 0 ? textOf(ctx.words[from - 1]) : null;
		const shown = displayWords(
			sToks.map((t) => ({
				text: t.text,
				proper: isProperToken(t, ctx.proper),
				spoken: t.text.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, '') === '&' ? t.norm : undefined,
			})),
			region,
			prevWord,
		);
		const asrNorms = ctx.norms.slice(from, to).filter(Boolean);
		out.push(
			makeCandidate(ctx, {
				kind,
				category: categoryOf(sToks, asrNorms, ctx),
				from,
				to,
				script: shown,
				scriptSource: sToks.map((t) => t.text),
				scriptNorms: sToks.map((t) => t.norm),
				scriptFrom: sj[0]!,
				scriptTo: sj[sj.length - 1]! + 1,
				line: sToks[0]!.line,
				section: sToks[0]!.section,
				needsAudio: true,
				mixed,
			}),
		);
	};
	let k = 0;
	while (k < n) {
		const step = steps[k]!;
		if (isExact(step) || isBreak(step)) {
			if (step.kind === 'cell' && step.exact) joinCandidate(ctx, script, tokens, step, out, skip);
			k++;
			continue;
		}
		const a = k;
		while (k < n && !isExact(steps[k]) && !isBreak(steps[k]!)) k++;
		const b = k;
		if (a === 0 || b >= n || !isExact(steps[a - 1]) || !isExact(steps[b])) continue;
		const L: AlignStep[] = [];
		for (let x = a - 1; x >= 0 && isExact(steps[x]) && L.length < 3; x--) L.push(steps[x]!);
		const R: AlignStep[] = [];
		for (let x = b; x < n && isExact(steps[x]) && R.length < 3; x++) R.push(steps[x]!);
		const reg = steps.slice(a, b);
		const { ti, sj } = tsOf(reg);
		if (!ti.length && !sj.length) continue;
		if (!ti.length && sj.every((j) => st[j]!.kind !== 'word')) continue;
		const rightTok = (R[0] as Extract<AlignStep, { kind: 'cell' }>).t[0];
		const [from, to] = span(ti, tokens[rightTok]!.word);
		const [t0, t1] = timeOf(from, to);
		const asrWords = ctx.words.slice(from, to).map(textOf);
		const scriptWords = sj.map((j) => st[j]!.text);
		const asrRaw = asrWords.join(' ');
		if (!(anchorOk(L) && anchorOk(R))) {
			skip('anchors', asrWords, scriptWords, t0!, t1!);
			continue;
		}
		if (ti.length > opt.maxRegionTranscript || sj.length > opt.maxRegionScript) {
			skip('size', asrWords, scriptWords, t0!, t1!);
			continue;
		}
		if (!sj.length) {
			skip('ins', asrWords, scriptWords, t0!, t1!);
			continue;
		}
		if (/\d/.test(asrRaw) || scriptWords.some((w) => /\d/.test(w))) {
			skip('number', asrWords, scriptWords, t0!, t1!);
			continue;
		}
		if (sj.some((j) => STYLISED.test(st[j]!.norm))) {
			skip('stylised', asrWords, scriptWords, t0!, t1!);
			continue;
		}
		if (sj.some((j) => st[j]!.kind !== 'word')) {
			skip('direction', asrWords, scriptWords, t0!, t1!);
			continue;
		}
		// SC-025: a region mixing proper / English words with other words is split into its parts
		const isName = (s: AlignStep) =>
			(s.kind === 'cell' || s.kind === 'skip') &&
			st
				.slice(s.s[0], s.s[1] + 1)
				.some((t) => isProperToken(t, ctx.proper) || isEnglishWord(t.norm, ctx.lang, ctx.stop));
		const classes = reg.map(isName);
		if (classes.some(Boolean) && classes.some((c) => !c)) {
			let p = 0;
			while (p < reg.length) {
				let q = p;
				while (q < reg.length && classes[q] === classes[p]) q++;
				const piece = reg.slice(p, q);
				// a piece without transcript words is inserted before the next transcript word of the region
				let ins = rightTok;
				for (const s of reg.slice(q))
					if (s.kind === 'cell' || s.kind === 'ins') {
						ins = s.t[0];
						break;
					}
				offer(piece, ins, true);
				p = q;
			}
		} else offer(reg, rightTok, false);
	}
}

/** SC-024: an exact concatenation with a different split becomes a spelling join when the script side is proper. */
function joinCandidate(
	ctx: Ctx,
	script: ParsedScript,
	tokens: ReadonlyArray<{ word: number; norm: string }>,
	step: Extract<AlignStep, { kind: 'cell' }>,
	out: FixCandidate[],
	skip: (reason: SkipReason, asr: string[], script: string[], start: number, end: number) => void,
): void {
	const nt = step.t[1] - step.t[0] + 1;
	const ns = step.s[1] - step.s[0] + 1;
	if (nt === ns) return;
	const sToks = script.tokens.slice(step.s[0], step.s[1] + 1);
	if (!sToks.some((t) => isProperToken(t, ctx.proper))) return;
	const from = tokens[step.t[0]]!.word;
	const to = tokens[step.t[1]]!.word + 1;
	const asrWords = ctx.words.slice(from, to).map(textOf);
	const sw = sToks.map((t) => t.text);
	const t0 = ctx.words[from]!.start;
	const t1 = ctx.words[to - 1]!.end;
	if (asrWords.some((w) => /\d/.test(w)) || sw.some((w) => /\d/.test(w))) return skip('number', asrWords, sw, t0, t1);
	if (sToks.some((t) => STYLISED.test(t.norm))) return skip('stylised', asrWords, sw, t0, t1);
	if (sToks.some((t) => t.kind !== 'word')) return skip('direction', asrWords, sw, t0, t1);
	const shown = displayWords(
		sToks.map((t) => ({ text: t.text, proper: isProperToken(t, ctx.proper) })),
		asrWords,
		from > 0 ? textOf(ctx.words[from - 1]) : null,
	);
	if (shown.join(' ') === asrWords.map((w) => w.trim()).join(' ')) return;
	out.push(
		makeCandidate(ctx, {
			kind: 'join',
			category: 'proper',
			from,
			to,
			script: shown,
			scriptSource: sw,
			scriptNorms: sToks.map((t) => t.norm),
			scriptFrom: step.s[0],
			scriptTo: step.s[1] + 1,
			line: sToks[0]!.line,
			section: sToks[0]!.section,
			needsAudio: false,
			mixed: false,
		}),
	);
}

type CleanGlossaryEntry = { froms: string[][]; to: string[]; toNorms: string[]; order: number };

/** Valid glossary entries of the transcript's language (malformed ones dropped, sizes capped). */
function sanitizeGlossary(
	entries: readonly GlossaryEntryInput[] | null | undefined,
	lang: ScriptFixLanguage,
): CleanGlossaryEntry[] {
	if (!Array.isArray(entries)) return [];
	const out: CleanGlossaryEntry[] = [];
	for (const e of entries.slice(0, MAX_GLOSSARY_ENTRIES)) {
		if (!e || typeof e !== 'object' || typeof e.to !== 'string' || !Array.isArray(e.from)) continue;
		if (typeof e.lang === 'string' && e.lang.trim() && scriptFixLanguage(e.lang) !== lang) continue;
		const to = e.to.trim().split(/\s+/).filter(Boolean).slice(0, MAX_GLOSSARY_WORDS);
		const toNorms = to.map(normalizeWord).filter(Boolean);
		if (!toNorms.length) continue;
		const froms: string[][] = [];
		for (const f of e.from.slice(0, MAX_GLOSSARY_FROM)) {
			if (typeof f !== 'string') continue;
			const seq = f.trim().split(/\s+/).map(normalizeWord).filter(Boolean);
			if (seq.length && seq.length <= MAX_GLOSSARY_WORDS) froms.push(seq);
		}
		if (froms.length) out.push({ froms, to, toNorms, order: out.length });
	}
	return out;
}

/** SC-073: glossary `from` spellings found in the transcript (longest first, no overlaps, script candidates win). */
function glossaryCandidates(
	ctx: Ctx,
	glossary: readonly CleanGlossaryEntry[],
	taken: ReadonlyArray<readonly [number, number]>,
	out: FixCandidate[],
	skip: (reason: SkipReason, asr: string[], script: string[], start: number, end: number) => void,
): void {
	const toks = transcriptTokens(ctx.words);
	const byFirst = new Map<string, Array<{ seq: string[]; entry: CleanGlossaryEntry }>>();
	for (const entry of glossary)
		for (const seq of entry.froms) {
			let l = byFirst.get(seq[0]!);
			if (!l) byFirst.set(seq[0]!, (l = []));
			l.push({ seq, entry });
		}
	for (const l of byFirst.values()) l.sort((a, b) => b.seq.length - a.seq.length || a.entry.order - b.entry.order);
	const overlaps = (from: number, to: number) => taken.some(([a, b]) => from < b && a < to);
	let i = 0;
	while (i < toks.length) {
		const options = byFirst.get(toks[i]!.norm);
		let advanced = false;
		for (const { seq, entry } of options ?? []) {
			if (i + seq.length > toks.length) continue;
			let ok = true;
			for (let k = 0; k < seq.length && ok; k++) ok = toks[i + k]!.norm === seq[k];
			if (!ok) continue;
			const from = toks[i]!.word;
			const to = toks[i + seq.length - 1]!.word + 1;
			const asrWords = ctx.words.slice(from, to).map(textOf);
			const t0 = ctx.words[from]!.start;
			const t1 = ctx.words[to - 1]!.end;
			const shown = displayWords(
				entry.to.map((w) => ({ text: w, proper: true })),
				asrWords,
				from > 0 ? textOf(ctx.words[from - 1]) : null,
			);
			if (shown.join(' ') === asrWords.map((w) => w.trim()).join(' ')) continue; // already right
			if (overlaps(from, to)) {
				skip('overlap', asrWords, shown, t0, t1);
				continue;
			}
			if (asrWords.some((w) => /\d/.test(w)) || entry.to.some((w) => /\d/.test(w))) {
				skip('number', asrWords, shown, t0, t1);
				continue;
			}
			const asrNorms = ctx.norms.slice(from, to).filter(Boolean);
			out.push(
				makeCandidate(ctx, {
					kind: 'glossary',
					category: 'proper',
					from,
					to,
					script: shown,
					scriptSource: [...entry.to],
					scriptNorms: entry.toNorms,
					scriptFrom: null,
					scriptTo: null,
					line: null,
					section: null,
					needsAudio: asrNorms.join('') !== entry.toNorms.join(''),
					mixed: false,
				}),
			);
			i += seq.length;
			advanced = true;
			break;
		}
		if (!advanced) i++;
	}
}


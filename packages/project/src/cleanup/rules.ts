// The word rules of the transcript cleanup detector (spec 14 TC-011). The restart, retake / false-start, off-script
// and marker-phrase rules are a faithful port of the research prototype that reproduced the user's cuts (private
// `.prproj-analysis/research/edits/mac/autocut.py` `detect`, `lcs`, `phrases`, `content`, `cw`; `common.py`
// `clean_words`): same order, same comparisons, same float arithmetic on seconds, so they label the same words
// (`packages/project/test/cleanup-port.test.ts` checks it against the prototype's own output) — except that a restart
// or retake must re-say what it removes (`ruleRestarts`, `ruleTakes`; a deliberate difference). The vocalic drawn-out
// vowel, stutter, lexical-review and ASR-suspect rules are additions from the spec. Pure.
import type { CleanupLanguageLists } from './lists.ts';
import type { CleanupSettings, FindingKind, RuleAction } from './schema.ts';

/** One analysed word: its transcript index, normalised text and times in seconds (media time). */
export type AWord = {
	/** Index in the transcript's `words`. */
	i: number;
	/** `cleanupNorm(text)` (never empty). */
	n: string;
	s: number;
	e: number;
	text: string;
	conf: number | null;
};

/** A word's label: the rule that claimed it and what the rule does. */
export type WordLabel = { kind: FindingKind; action: Exclude<RuleAction, 'off'>; group?: number };

/** Prototype `lcs`: longest common subsequence length (one-row DP); `eq` compares words (default: equal). */
export function lcs<T>(
	a: readonly T[],
	b: readonly T[],
	eq: (x: T, y: T) => boolean = (x, y) => x === y,
): number {
	if (!a.length || !b.length) return 0;
	const dp = new Array<number>(b.length + 1).fill(0);
	for (const x of a) {
		let prev = 0;
		for (let j = 0; j < b.length; j++) {
			const cur = dp[j + 1]!;
			dp[j + 1] = eq(x, b[j]!) ? prev + 1 : Math.max(dp[j + 1]!, dp[j]!);
			prev = cur;
		}
	}
	return dp[b.length]!;
}

/** The pairs `[index in a, index in b]` of one longest in-order alignment of `a` onto `b`. */
export function alignment<T>(
	a: readonly T[],
	b: readonly T[],
	eq: (x: T, y: T) => boolean,
): Array<[number, number]> {
	const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let x = a.length - 1; x >= 0; x--)
		for (let y = b.length - 1; y >= 0; y--)
			dp[x]![y] = eq(a[x]!, b[y]!) ? dp[x + 1]![y + 1]! + 1 : Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!);
	const out: Array<[number, number]> = [];
	for (let x = 0, y = 0; x < a.length && y < b.length; ) {
		if (eq(a[x]!, b[y]!) && dp[x]![y] === dp[x + 1]![y + 1]! + 1) out.push([x++, y++]);
		else if (dp[x + 1]![y]! >= dp[x]![y + 1]!) x++;
		else y++;
	}
	return out;
}

/** Prototype `phrases`: runs of words split where the pause before a word is ≥ `gap` seconds. Index lists. */
export function phrases(words: readonly AWord[], gap: number): number[][] {
	const out: number[][] = [];
	let cur: number[] = [];
	for (let k = 0; k < words.length; k++) {
		const w = words[k]!;
		if (cur.length && w.s - words[cur[cur.length - 1]!]!.e >= gap) {
			out.push(cur);
			cur = [];
		}
		cur.push(k);
	}
	if (cur.length) out.push(cur);
	return out;
}

export type RuleContext = {
	words: readonly AWord[];
	labels: (WordLabel | null)[];
	settings: CleanupSettings;
	lists: CleanupLanguageLists;
	fillers: ReadonlySet<string>;
	stop: ReadonlySet<string>;
	restartStop: ReadonlySet<string>;
	/** Normalised script tokens (empty without a script). */
	scriptTokens: readonly string[];
	/** Seconds of speech frames inside a word (null without voice analysis). */
	voicedSeconds: ((w: AWord) => number) | null;
};

const claim = (ctx: RuleContext, k: number, kind: FindingKind, action: RuleAction, group?: number) => {
	if (action === 'off' || ctx.labels[k]) return;
	ctx.labels[k] = group === undefined ? { kind, action } : { kind, action, group };
};

/** Prototype `content`: tokens that are not vocalic fillers. */
const content = (ctx: RuleContext, idx: readonly number[]) =>
	idx.map((k) => ctx.words[k]!.n).filter((t) => !ctx.fillers.has(t));
/** Prototype `cw`: content words (not stop words, ≥ 3 letters). */
const cw = (ctx: RuleContext, toks: readonly string[]) =>
	toks.filter((t) => !ctx.stop.has(t) && t.length >= 3);
/** Rule 3 of the prototype (vocalic fillers) + drawn-out single vowels (spec). */
export function ruleFillers(ctx: RuleContext): void {
	const a = ctx.settings.rules.fillerVocalic;
	if (a === 'off') return;
	const vowels = new Set(ctx.lists.vowels);
	for (let k = 0; k < ctx.words.length; k++) {
		const w = ctx.words[k]!;
		if (conjunction(ctx, k)) continue;
		if (ctx.fillers.has(w.n)) claim(ctx, k, 'filler-vocalic', a);
		else if (isDrawnVowel(w.n, vowels)) {
			const held = ctx.voicedSeconds ? ctx.voicedSeconds(w) : w.e - w.s;
			if (held > ctx.settings.thresholds.drawnVowelS) claim(ctx, k, 'filler-vocalic', a);
		}
	}
}

/** Spanish coordinating conjunctions written as one vowel ("y", "e" before an i- sound, "o", "u" before an o- sound). */
const CONJUNCTIONS = new Set(['y', 'e', 'o', 'u']);

/**
 * Whether word k is a coordinating conjunction, not a filler (round 6, fragment N: "Godot e incluso" lost its "e"):
 * "y" / "e" / "o" / "u" said into the next word (< `phraseGapS`) and — "e" before an i- / hi- word, "u" before an o- /
 * ho- word, as Spanish writes them — or between two content words in one phrase. A held hesitation ("eee…", a pause
 * after it) stays a filler.
 */
function conjunction(ctx: RuleContext, k: number): boolean {
	if (ctx.lists.vowels.indexOf('y') < 0) return false; // the Spanish lists only
	const w = ctx.words[k]!;
	const next = ctx.words[k + 1];
	if (!CONJUNCTIONS.has(w.n) || !next || next.s - w.e >= ctx.settings.thresholds.phraseGapS) return false;
	if (w.n === 'e') return /^h?i/.test(next.n) && !/^hi[aeou]/.test(next.n);
	if (w.n === 'u') return /^h?o/.test(next.n);
	const prev = ctx.words[k - 1];
	const content = (x: AWord) => !ctx.stop.has(x.n) && !ctx.fillers.has(x.n) && x.n.length >= 3;
	return !!prev && w.s - prev.e < ctx.settings.thresholds.phraseGapS && content(prev) && content(next);
}

/** "a", "aaa", "yyy", "eee": one vowel letter, repeated or not. */
function isDrawnVowel(n: string, vowels: ReadonlySet<string>): boolean {
	if (!n.length || !vowels.has(n[0]!)) return false;
	for (const c of n) if (c !== n[0]) return false;
	return true;
}

/** A word that ends a sentence (its closing quote or bracket after the mark). */
export const SENTENCE_END = /[.?!…]["'»”’)]*$/u;

/** A word the recogniser wrote as broken off: it ends with an ellipsis. */
export const CUT_OFF = /(\.\.\.|…)[?!]?$/;

/**
 * Rule 4 of the prototype: phrases with ≥ `offScriptMinTokens` content tokens of which < `offScriptSimilarity` occur in
 * the script. Deliberate difference: the share is taken over the phrase's content words (no stop words, ≥ 3 letters),
 * and a phrase needs two of them (one when `offScriptMinTokens` is 1) to be judged. The prototype counted function
 * words, which every script of the language holds ("cómo", "lo", "de"), so chatter such as "¿Cómo lo puedo pronunciar?
 * Cloud…" passed as scripted and long recordings got no off-script findings at all.
 */
export function ruleOffScript(ctx: RuleContext, phs: readonly number[][]): void {
	const a = ctx.settings.rules.offScript;
	if (a === 'off' || !ctx.scriptTokens.length) return;
	const t = ctx.settings.thresholds;
	const st = new Set(ctx.scriptTokens);
	for (const ph of phs) {
		const c = content(ctx, ph);
		if (c.length < t.offScriptMinTokens) continue;
		const ci = cw(ctx, c);
		if (ci.length < Math.min(2, t.offScriptMinTokens)) continue;
		const inscript = ci.filter((x) => st.has(x)).length / ci.length;
		if (inscript < t.offScriptSimilarity) for (const k of ph) claim(ctx, k, 'off-script', a);
	}
}

/**
 * Whether `toks` is made only of marker phrases and vocalic fillers (greedy longest match; the prototype's
 * standalone-phrase rule checked single tokens, which the single-word entries reproduce).
 */
export function onlyMarkers(
	toks: readonly string[],
	markers: readonly string[][],
	fillers: ReadonlySet<string>,
): boolean {
	let i = 0;
	while (i < toks.length) {
		if (fillers.has(toks[i]!)) {
			i++;
			continue;
		}
		let best = 0;
		for (const m of markers)
			if (m.length > best && i + m.length <= toks.length && m.every((x, k) => toks[i + k] === x))
				best = m.length;
		if (!best) return false;
		i += best;
	}
	return toks.length > 0;
}

/** The prototype's standalone-phrase rule: a phrase of ≤ `markerPhraseMaxWords` words made only of markers. */
export function ruleMarkerPhrases(
	ctx: RuleContext,
	phs: readonly number[][],
	markers: readonly string[][],
): void {
	const a = ctx.settings.rules.fillerPhrase;
	if (a === 'off') return;
	const max = ctx.settings.thresholds.markerPhraseMaxWords;
	for (const ph of phs) {
		const toks = ph.map((k) => ctx.words[k]!.n);
		if (toks.length && toks.length <= max && onlyMarkers(toks, markers, ctx.fillers))
			for (const k of ph) claim(ctx, k, 'filler-phrase', a);
	}
}

/**
 * Repeat / stutter (spec): 1–3 words said twice in a row with less than `stutterGapS` between the copies (not an
 * allowed emphasis such as "no no"), or a cut-off word ("jue-") whose next word starts with it. The first copy goes —
 * but a reduplication (`reduplicated`; round 6: "Guiño, guiño", "boing, boing, boing" were cut) is only reviewed.
 */
export function ruleStutters(ctx: RuleContext): void {
	const a = ctx.settings.rules.stutter;
	if (a === 'off') return;
	const gap = ctx.settings.thresholds.stutterGapS;
	const allow = new Set(ctx.lists.allow);
	const w = ctx.words;
	for (let j = 1; j < w.length; j++) {
		// cut-off word: "jue- juego"
		const prev = w[j - 1]!;
		if (
			/[-‐‑–—]$/.test(prev.text.trim()) &&
			w[j]!.n.startsWith(prev.n) &&
			w[j]!.n !== prev.n &&
			w[j]!.s - prev.e < gap
		) {
			claim(ctx, j - 1, 'stutter', a);
			continue;
		}
		for (const k of [3, 2, 1]) {
			if (j - k < 0 || j + k > w.length) continue;
			let same = true;
			for (let q = 0; q < k && same; q++) same = w[j - k + q]!.n === w[j + q]!.n;
			if (!same) continue;
			if (w[j]!.s - w[j - 1]!.e >= gap) continue;
			const gram = w.slice(j, j + k).map((x) => x.n);
			if (gram.every((x) => allow.has(x))) continue;
			// a reduplication ("guiño, guiño", "boing, boing, boing") is deliberate: reviewed, never cut by default
			const deliberate = k === 1 && reduplicated(ctx, j - 1);
			for (let q = j - k; q < j; q++) claim(ctx, q, 'stutter', deliberate ? 'review' : a);
			break;
		}
	}
}

/**
 * Whether word k starts a reduplication: the same content word (or allowed emphasis) said again at once (<
 * `stutterGapS`), the run ending its phrase (sentence end or ≥ `phraseGapS` pause after it) or of three or more —
 * "Guiño, guiño.", "boing, boing, boing" — where a stutter or restart goes on with new words ("Primero, primero diseñé").
 */
export function reduplicated(ctx: RuleContext, k: number): boolean {
	const w = ctx.words;
	const x = w[k]!.n;
	const content = (!ctx.stop.has(x) && (x.length >= 3 || /\d/.test(x))) || ctx.lists.allow.includes(x);
	if (!content || k + 1 >= w.length || w[k + 1]!.n !== x) return false;
	let e = k + 1;
	while (e + 1 < w.length && w[e + 1]!.n === x && w[e + 1]!.s - w[e]!.e < ctx.settings.thresholds.stutterGapS)
		e++;
	for (let y = k; y < e; y++) if (w[y + 1]!.s - w[y]!.e >= ctx.settings.thresholds.stutterGapS) return false;
	const next = w[e + 1];
	return (
		e - k >= 2 ||
		!next ||
		SENTENCE_END.test(w[e]!.text.trim()) ||
		next.s - w[e]!.e >= ctx.settings.thresholds.phraseGapS
	);
}

/**
 * Lexical marker at a clause start, followed by a comma or a pause ("Bueno, …", "Este… "): flagged for review with low
 * confidence; inside a sentence ("este video", "pero bueno") never.
 */
export function ruleLexicalReview(
	ctx: RuleContext,
	phs: readonly number[][],
	markers: readonly string[][],
): void {
	if (ctx.settings.rules.fillerLexical === 'off') return;
	const w = ctx.words;
	for (const ph of phs) {
		const toks = ph.map((k) => w[k]!.n);
		let best = 0;
		for (const m of markers) if (m.length > best && m.every((x, k) => toks[k] === x)) best = m.length;
		if (!best || best >= ph.length) continue;
		const last = w[ph[best - 1]!]!;
		const next = w[ph[best]!]!;
		const comma = /[,…;:]$|\.\.\.$/.test(last.text.trim());
		if (comma || next.s - last.e >= 0.15)
			for (let k = 0; k < best; k++) claim(ctx, ph[k]!, 'filler-lexical', 'review');
	}
}

/** ASR suspects (spec): low confidence or implausible word durations. Review only. */
export function ruleAsrSuspects(ctx: RuleContext): void {
	if (ctx.settings.rules.asrSuspect === 'off') return;
	const t = ctx.settings.thresholds;
	for (let k = 0; k < ctx.words.length; k++) {
		const w = ctx.words[k]!;
		const d = w.e - w.s;
		if ((w.conf !== null && w.conf < t.lowConfidence) || d < t.minWordS || d > t.maxWordS)
			claim(ctx, k, 'asr-suspect', 'review');
	}
}

export { claim as claimWord };

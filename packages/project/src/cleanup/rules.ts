// The word rules of the transcript cleanup detector (spec 14 TC-011). The restart, retake / false-start, off-script
// and marker-phrase rules are a faithful port of the research prototype that reproduced the user's cuts (private
// `.prproj-analysis/research/edits/mac/autocut.py` `detect`, `lcs`, `phrases`, `content`, `cw`; `common.py`
// `clean_words`): same order, same comparisons, same float arithmetic on seconds, so they label the same words
// (`packages/project/test/cleanup-port.test.ts` checks it against the prototype's own output) — except that a restart
// or retake must re-say what it removes (`ruleRestarts`, `ruleTakes`; a deliberate difference). The vocalic drawn-out
// vowel, stutter, lexical-review and ASR-suspect rules are additions from the spec. Pure.
import { type CleanupLanguageLists, sameWord } from './lists.ts';
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
export function lcs(
	a: readonly string[],
	b: readonly string[],
	eq: (x: string, y: string) => boolean = (x, y) => x === y,
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
/** Word indices `a … b − 1`. */
const span = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, q) => a + q);

/** Whether `kept` re-says every number of `removed` (digits, or the language's number words). */
function numbersReSaid(ctx: RuleContext, removed: readonly string[], kept: readonly string[]): boolean {
	const nums = new Set(ctx.lists.numbers);
	const k = new Set(kept);
	return removed.every((x) => k.has(x) || !(nums.has(x) || /^\d+$/.test(x)));
}

/** Rule 3 of the prototype (vocalic fillers) + drawn-out single vowels (spec). */
export function ruleFillers(ctx: RuleContext): void {
	const a = ctx.settings.rules.fillerVocalic;
	if (a === 'off') return;
	const vowels = new Set(ctx.lists.vowels);
	for (let k = 0; k < ctx.words.length; k++) {
		const w = ctx.words[k]!;
		if (ctx.fillers.has(w.n)) claim(ctx, k, 'filler-vocalic', a);
		else if (isDrawnVowel(w.n, vowels)) {
			const held = ctx.voicedSeconds ? ctx.voicedSeconds(w) : w.e - w.s;
			if (held > ctx.settings.thresholds.drawnVowelS) claim(ctx, k, 'filler-vocalic', a);
		}
	}
}

/** "a", "aaa", "yyy", "eee": one vowel letter, repeated or not. */
function isDrawnVowel(n: string, vowels: ReadonlySet<string>): boolean {
	if (!n.length || !vowels.has(n[0]!)) return false;
	for (const c of n) if (c !== n[0]) return false;
	return true;
}

/**
 * Rule 2 of the prototype (restarts): the speaker re-says words said shortly before — an earlier copy of the 3-gram
 * (within `restartWindowWords`) or of a 2-gram holding a content word (within `restartWindowWords2`), both within
 * `restartWindowS` — so everything from the earlier copy up to the restart point is an abandoned attempt (≤ 2 words:
 * a false start). An earlier copy must lie after the last restart point.
 *
 * Deliberate difference from the prototype: the attempt must be said again — the continuation (the next twice as many
 * words) repeats all its content words in order (lexical markers such as "pues" between attempt and retry need not
 * be re-said) and every number in it. A repeated n-gram alone also matched lists
 * ("el tema oscuro de Unity, la barra de menús de Unity"), comparisons ("mis juegos en mi motor funcionan mejor que
 * mis juegos en Unity") and a content 2-gram said again in the next sentence, whose removal loses words said once.
 */
export function ruleRestarts(ctx: RuleContext): void {
	const { restart, falseStart } = ctx.settings.rules;
	if (restart === 'off' && falseStart === 'off') return;
	const t = ctx.settings.thresholds;
	const words = ctx.words;
	const n = words.length;
	const toks = words.map((w) => w.n);
	// markers as one token: "pues", and "a ver" / "o sea" written as one word ("aver", "osea")
	const markers = new Set(ctx.lists.markers.map((m) => m.replace(/ /g, '')));
	// words of an attempt the retry may garble (ASR): ≤ 15 % of ≥ 6, at least one
	const garble = (len: number) => (len >= 6 ? Math.max(1, Math.floor(0.15 * len)) : 0);
	const attemptAt = (i: number, j: number) => {
		const attempt = content(ctx, span(i, j));
		return { attempt, a: cw(ctx, attempt).filter((x) => !markers.has(x)) };
	};
	// the attempt `[i, j)` said again (ASR variants match, `sameWord`) by the next `len` words from `from`
	const reSaid = (i: number, j: number, from = j, len = 2 * (j - i)) => {
		const { attempt, a } = attemptAt(i, j);
		const cont = content(ctx, span(from, Math.min(n, from + len)));
		const said = cw(ctx, cont);
		// a cut-off last word ("Y funcionan con cual…") is said again by its completion ("cualquier")
		const last = attempt[attempt.length - 1];
		if (a.length && a[a.length - 1] === last && !said.some((y) => sameWord(last, y))) {
			const whole = said.find((y) => y.startsWith(last));
			if (whole) a[a.length - 1] = whole;
		}
		return (
			a.length - lcs(a, said, (x, y) => sameWord(x, y)) <= garble(a.length) &&
			numbersReSaid(ctx, attempt, cont)
		);
	};
	// a chain of attempts `[i, end)` that each start with the same n-gram, said again after the last one (`end`): every
	// word of them in its next `len` words, ASR garble aside (≤ 15 % of ≥ 6, at least one; never two in a row)
	const chainReSaid = (i: number, end: number, len: number) => {
		const { attempt, a } = attemptAt(i, end);
		const cont = content(ctx, span(end, Math.min(n, end + len)));
		const said = cw(ctx, cont);
		const lost = a.map((x) => !said.some((y) => sameWord(x, y, true)));
		if (lost.some((x, q) => x && lost[q + 1])) return false;
		return lost.filter(Boolean).length <= garble(a.length) && numbersReSaid(ctx, attempt, cont);
	};
	// the retry starts where the words before both copies still match ("que pueda ser en un mes…" / "¿Que puedo hacer
	// en un mes…": one ASR substitution between two matches is the same word)
	const extend = (i: number, j: number, floor: number): [number, number] => {
		const m = (d: number) => i - d >= floor && j - d > i && sameWord(toks[i - d]!, toks[j - d]!);
		for (;;) {
			if (m(1)) {
				i--;
				j--;
			} else if (m(2) && m(3)) {
				i -= 3;
				j -= 3;
			} else return [i, j];
		}
	};
	let j = 1;
	let floor = 0;
	while (j < n) {
		// the restart point a hit moves back (`extend`) is rescanned from here on, never again (progress)
		const at = j;
		let hit: number | null = null;
		for (const k of [3, 2]) {
			if (j + k > n) continue;
			if (k === 2) {
				const g0 = toks[j]!;
				const g1 = toks[j + 1]!;
				const weak = (x: string) => ctx.restartStop.has(x) || x.length < t.restartContentLetters;
				if (weak(g0) && weak(g1)) continue;
			}
			const win = k === 3 ? t.restartWindowWords : t.restartWindowWords2;
			const stop = Math.max(floor - 1, j - win - 1);
			const gramAt = (p: number, i: number) => {
				for (let q = 0; q < k; q++) if (toks[i + q] !== toks[p + q]) return false;
				return true;
			};
			for (let i = j - k; i > stop; i--) {
				if (i < 0) break;
				if (!gramAt(j, i) || words[j]!.s - words[i]!.s > t.restartWindowS) continue;
				const [i2, j2] = extend(i, j, floor);
				if (reSaid(i2, j2)) {
					hit = i2;
					j = j2;
					break;
				}
				// a chain of restarts ("¿Qué puedo hacer…? ¿Qué puedo hacer…? … ¿Que puedo hacer … dólares?", fragment E):
				// the later copies of the n-gram, each within the window of the one before, and the attempts up to one
				// of them said again after it — the restart point moves to it
				const chain: number[] = [];
				for (let p = j + 1, prev = j; p + k <= n && p - prev <= win + k; p++) {
					if (words[p]!.s - words[i]!.s > t.restartWindowS) break;
					if (gramAt(p, i)) {
						chain.push(p);
						prev = p;
					}
				}
				const end = chain.reverse().find((p) => chainReSaid(i, p, 2 * (j - i)));
				if (end !== undefined) {
					[hit, j] = extend(i, end, floor);
					break;
				}
			}
			if (hit !== null) break;
		}
		if (hit !== null) {
			// …and starts at its own first word: one or two words without content after a pause, said into the restart
			// point, begin the retry ("… en un par | En el Jasper Engine": the n-gram matched "el Jasper Engine"); a word
			// apart from it is left of the attempt (run 4, fragment E: "de" 0.43 s before "¿Que puedo hacer…")
			let end = j;
			for (let p = j; p > Math.max(hit + 1, j - 3); p--)
				if (words[p]!.s - words[p - 1]!.e >= t.takeGapS) {
					const joined = span(p, j).every((q) => words[q + 1]!.s - words[q]!.e < LEAD_IN_JOIN_S);
					if (joined && !cw(ctx, content(ctx, span(p, j))).length) end = p;
					break;
				}
			const fs = end - hit <= 2;
			for (let q = hit; q < end; q++)
				claim(ctx, q, fs ? 'false-start' : 'restart', fs ? falseStart : restart);
			floor = j;
		}
		j = Math.max(j, at) + 1;
	}
}

/** A lead-in word of a retry is said into it: closer than this (seconds) to the next word. */
const LEAD_IN_JOIN_S = 0.15;

/** One retake hit of the take rule: unit `from` was said again as unit `to`. */
export type TakeHit = { from: number; to: number };

/**
 * Rule 1 of the prototype (takes): units split at pauses ≥ `takeGapS`; a unit whose content re-appears in a later
 * unit within `retakeWindowS` is a superseded take — one content word re-said within `falseStartGapS`, or ≥ 2 content
 * words of which ≥ `retakeSimilarity` (LCS) re-appear in a later unit that starts with the first of them (within its
 * first 3 content words), or ≤ 3 tokens the later unit starts with. Returns the units and the hits (for take groups);
 * labels the superseded units (≤ 2 content tokens: false start, else retake). Deliberate difference from the
 * prototype: the later unit must also re-say every number of the earlier one ("me quedan nueve días" is not a take of
 * "me quedan seis días y…", although 2 of its 3 content words re-appear).
 */
export function ruleTakes(ctx: RuleContext): { units: number[][]; hits: TakeHit[] } {
	const t = ctx.settings.thresholds;
	const units = phrases(ctx.words, t.takeGapS);
	const hits: TakeHit[] = [];
	const { retake, falseStart } = ctx.settings.rules;
	if (retake === 'off' && falseStart === 'off') return { units, hits };
	// what each unit says once its restarts are out (a unit that restarts inside says no more than its last attempt);
	// a unit a restart removes whole is still a take of what follows, but never the later take of a hit
	const contents = units.map((u) =>
		content(
			ctx,
			u.filter((k) => !ctx.labels[k] || ctx.labels[k]!.kind === 'filler-vocalic'),
		),
	);
	const fromContents = units.map((u, a) => (contents[a]!.length ? contents[a]! : content(ctx, u)));
	const eq = (x: string, y: string) => sameWord(x, y);
	for (let a = 0; a < units.length; a++) {
		const u = units[a]!;
		const c = fromContents[a]!;
		if (c.length < 1) continue;
		// the tail of an attempt whose start a restart removed need not start the later unit, only be said in it whole
		const tail =
			contents[a]!.length > 0 && !!ctx.labels[u[0]!] && ctx.labels[u[0]!]!.kind !== 'filler-vocalic';
		const uEnd = ctx.words[u[u.length - 1]!]!.e;
		for (let b = a + 1; b < units.length; b++) {
			const q = units[b]!;
			const qStart = ctx.words[q[0]!]!.s;
			if (qStart - uEnd > t.retakeWindowS) break;
			const cq = contents[b]!;
			if (!cq.length) continue;
			const ci = cw(ctx, c);
			const cj = cw(ctx, cq);
			let hit: boolean;
			if (c.length === 1) hit = cq[0] === c[0] && qStart - uEnd < t.falseStartGapS;
			else if (ci.length >= 2 && cj.length) {
				const l = lcs(ci, cj, eq);
				hit =
					l / ci.length >= t.retakeSimilarity &&
					(cj.slice(0, 3).some((y) => eq(ci[0]!, y)) || (tail && l === ci.length));
			} else hit = c.length <= 3 && c.every((x, k) => cq[k] === x);
			if (hit && numbersReSaid(ctx, c, cq)) {
				hits.push({ from: a, to: b });
				const fs = c.length <= 2;
				for (const k of u) claim(ctx, k, fs ? 'false-start' : 'retake', fs ? falseStart : retake, a);
				break;
			}
		}
	}
	return { units, hits };
}

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
 * allowed emphasis such as "no no"), or a cut-off word ("jue-") whose next word starts with it. The first copy goes.
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
			for (let q = j - k; q < j; q++) claim(ctx, q, 'stutter', a);
			break;
		}
	}
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

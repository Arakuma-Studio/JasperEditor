// Repeats — restarts, false starts and retakes — found by one mechanism: an attempt is the speech the speaker says
// again, so its words align, in order, onto the start of the speech that follows it (docs/wp-notes/transcript-cleanup.md
// "Repeats by alignment"). It replaces the prototype's restart and take rules and the special cases six rounds of
// real-model validation had piled onto them. Pure.
//
// For a retry start p (a word whose first words were said shortly before: a repeated 3-gram or content 2-gram, or two
// clause starts whose first content words match), each earlier attempt start q is tried, farthest first:
//   - the attempt [q, e) is aligned (LCS over content words, ASR variants match: `sameWord`) onto the retry R — from p
//     up to its next copy of the same opening, at most min(2 × |attempt| + 8, |attempt| + 24) words — or onto a later copy of R when R is
//     itself abandoned (a chain of takes);
//   - **remove** when every content word of the attempt is said again by R (numbers and alphanumerics such as "3D" only
//     as the same number / word), starting among R's first words: forgiven are a word R garbles in place (`soundsAlike`,
//     at most 15 %, at least one from three words, never two in a row), a cut-off last word R says whole, the last word
//     of an attempt the recogniser wrote broken off ("en lugar…" → "en vez de") after three re-said words, and in a long
//     attempt one word the speech after R says. The two must be adjacent — between them only fillers, other attempts
//     of the same retry, or one short aside after a strongly re-said attempt — R must be complete (it does not end
//     broken off, unless that ending is itself an attempt removed later), and an attempt that starts inside a sentence
//     never runs over that sentence's end;
//   - **review** when a whole clause shares ≥ `retakeSimilarity` of its content words with the clause after it, in order
//     and from its start, but is not re-said in full;
//   - deliberate repetition — 1–3 content words said again at once ("guiño, guiño", "boing, boing") — is never an
//     attempt.

import { sameWord, soundsAlike } from './lists.ts';
import { alignment, CUT_OFF, lcs, type RuleContext, reduplicated, SENTENCE_END } from './rules.ts';

/** One attempt the speaker said again (positions in `ctx.words`). */
export type RepeatLink = {
	/** The attempt `[from, to)`. */
	attempt: [number, number];
	/** An aside between the attempt and the retry `[from, to)` (from === to: none). */
	aside: [number, number];
	/** The first word of the retry. */
	retry: number;
	/** The last word of the retry's clause (inclusive): the take that stays unless it is itself an attempt. */
	retryEnd: number;
	kind: 'restart' | 'false-start' | 'retake';
	tier: 'remove' | 'review';
};

/** A lead-in word of a retry is said into it: closer than this (seconds) to the next word. */
const LEAD_IN_JOIN_S = 0.15;
/** An aside between an attempt and its retry: at most this many words and seconds of them (pauses aside). */
const ASIDE_MAX_WORDS = 16;
const ASIDE_MAX_S = 5;
/** Correction markers that open a self-correction aside ("No, de ellos"), normalised tokens. */
const CORRECTION_MARKERS: ReadonlyArray<readonly string[]> = [
	['mejor', 'dicho'],
	['quiero', 'decir'],
	['o', 'sea'],
	['i', 'mean'],
	['no'],
	['perdon'],
	['digo'],
	['sorry'],
];
/** Longest attempt (words) the mechanism tries. */
const MAX_ATTEMPT_WORDS = 80;
/** The retry an attempt of `len` words is compared with: at most this many words (it may add some). */
const retrySpan = (len: number) => Math.min(2 * len + 8, len + 24);
/** How many later copies of an abandoned retry an attempt is compared with. */
const MAX_CHAIN = 4;

/**
 * Finds the repeats of `ctx.words` (vocalic fillers already labelled are transparent) and labels the attempts
 * (`restart` / `false-start` / `retake`, the rule's action, or `review` for the weaker tier). Returns the links, for
 * take groups.
 */
export function ruleRepeats(ctx: RuleContext): RepeatLink[] {
	const { restart, falseStart, retake } = ctx.settings.rules;
	if (restart === 'off' && falseStart === 'off' && retake === 'off') return [];
	const t = ctx.settings.thresholds;
	const words = ctx.words;
	const S = words.flatMap((_, k) => (ctx.labels[k]?.kind === 'filler-vocalic' ? [] : [k]));
	const n = S.length;
	if (n < 2) return [];
	const W = (p: number) => words[S[p]!]!;
	// word comparisons are memoised: the same tokens meet again and again
	const memo = new Map<string, boolean>();
	const cached =
		(f: (a: string, b: string, c?: boolean) => boolean, tag: string) =>
		(a: string, b: string, c = false) => {
			const k = `${tag}${c ? 1 : 0}${a}\u0000${b}`;
			let v = memo.get(k);
			if (v === undefined) {
				v = f(a, b, c);
				memo.set(k, v);
			}
			return v;
		};
	const same = cached(sameWord, 's');
	// …and by position for the hot paths (alignment, anchors): tokens interned, pairs keyed by number
	const ids = new Map<string, number>();
	const idAt = S.map((k) => {
		const x = words[k]!.n;
		let v = ids.get(x);
		if (v === undefined) {
			v = ids.size;
			ids.set(x, v);
		}
		return v;
	});
	const pairMemo = new Map<number, boolean>();
	const sameAt = (p1: number, p2: number) => {
		const a = idAt[p1]!;
		const b = idAt[p2]!;
		if (a === b) return true;
		const k = a * 1048576 + b;
		let v = pairMemo.get(k);
		if (v === undefined) {
			v = sameWord(tok(p1), tok(p2));
			pairMemo.set(k, v);
		}
		return v;
	};
	const alike = cached((a, b) => soundsAlike(a, b), 'a');
	const tok = (p: number) => W(p).n;
	const text = (p: number) => W(p).text.trim();
	const numbers = new Set(ctx.lists.numbers);
	/** A content word: no stop word, three letters or a digit ("3D", "2"), or a number word. */
	const key = (x: string) => (!ctx.stop.has(x) && (x.length >= 3 || /\d/.test(x))) || numbers.has(x);
	/** Numbers and alphanumerics are said again only as themselves (never forgiven as a garble). */
	const exact = (x: string) => /\d/.test(x) || numbers.has(x);
	const cutAt = S.map((_, p) => CUT_OFF.test(text(p)));
	const endsAt = S.map((_, p) => SENTENCE_END.test(text(p)));
	const cut = (p: number) => cutAt[p]!;
	const ends = (p: number) => endsAt[p]!;
	const gapAfter = (p: number) => (p + 1 < n ? W(p + 1).s - W(p).e : Number.POSITIVE_INFINITY);
	const startAt = S.map((_, p) => p === 0 || ends(p - 1) || gapAfter(p - 1) >= t.phraseGapS);
	const clauseStart = (p: number) => startAt[p]!;
	const span = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, x) => a + x);
	const keyAt = S.map((_, p) => key(tok(p)));
	// markers as words, and as one word written together ("a ver" → "aver", "o sea" → "osea")
	const markerSet = new Set(ctx.lists.markers.flatMap((m) => [...m.split(' '), m.replace(/ /g, '')]));
	/** Whether `[a, b)` holds only discourse-marker words ("a ver", "bueno", "pues"). */
	const markersOnly = (a: number, b: number) => b > a && span(a, b).every((p) => markerSet.has(tok(p)));
	const keys = (a: number, b: number) => span(a, b).filter((p) => keyAt[p]);
	/**
	 * Where the words `[a, b)` are said again word for word at the start of the speech from `r` (after up to two lead
	 * words; a cut-off last word as a prefix), or -1.
	 */
	const verbatimAt = (a: number, b: number, r: number) => {
		for (let o = r; o <= r + 2 && o + (b - a) <= n; o++)
			if (span(a, b).every((x, i) => same(tok(x), tok(o + i), x === b - 1 && cut(x)))) return o;
		return -1;
	};
	/** The end of an attempt from `q` broken off within its first three words (before `r`), else `r`. */
	const brokenWithin = (q: number, r: number) => {
		for (let x = q; x < Math.min(r, q + 3); x++) if (cut(x)) return x + 1;
		return r;
	};

	/** One content word (or allowed emphasis) said again at once, the repetition ending its phrase: deliberate. */
	const deliberate = (q: number, len: number) => {
		return len === 1 && reduplicated(ctx, S[q]!);
	};

	/** Whether position `p` of attempt `[a0, a1)` lies in an attempt (starting after `a0`) removed by a link whose retry is
	 * inside it: a restart inside a take ("…estatua, hice que por fin lo pudiera mover él con el teclado. | Hice que…"). */
	const inner = (p: number, a0: number, a1: number) =>
		links.some(
			(c) =>
				c.link.tier === 'remove' &&
				c.link.retry > a0 &&
				c.link.retry < a1 &&
				c.link.attempt[0] > a0 &&
				c.link.attempt[0] <= p &&
				p < c.link.attempt[1],
		);
	type Cover = { full: boolean; share: number; prefix: boolean; last: number; other?: boolean };
	/**
	 * How attempt `[a0, a1)` is said again by retry `[r0, r1)`; `after` = the speech after the retry, `aside` = the words
	 * between them (a correction may name the word the retry changes).
	 */
	const cover = (
		a0: number,
		a1: number,
		r0: number,
		r1: number,
		after: () => readonly number[],
		aside?: readonly [number, number],
	): Cover => {
		const A = span(a0, a1);
		const R = span(r0, r1);
		// words of the attempt an inner restart already removes are said again inside it (a take with a restart)
		const ak = A.filter((p) => key(tok(p)) && !inner(p, a0, a1));
		const none: Cover = { full: false, share: 0, prefix: false, last: r0 };
		if (!A.length || !R.length) return none;
		if (!ak.length) {
			// no content word: the retry starts with the same words (a cut-off last word as its completion)
			if (A.length > R.length) return none;
			const ok = A.every((p, x) => same(tok(p), tok(R[x]!), x === A.length - 1 && cut(p)));
			return { full: ok, share: ok ? 1 : 0, prefix: ok, last: R[A.length - 1]! };
		}
		const rk = R.filter((p) => keyAt[p]);
		// cheap refusals before the alignment: the attempt's first content words open the retry, and it has no more
		// content words than the retry can say
		if (ak.length > 2 && !rk.slice(0, 3).some((p) => ak.slice(0, 2).some((x) => same(tok(x), tok(p)))))
			return none;
		if (ak.length > rk.length + 1 + (cut(a1 - 1) ? 1 : 0) + Math.floor(0.15 * ak.length) + 1) return none;
		const pairs = alignment(ak, rk, sameAt);
		let prefix = pairs.length > 0 && pairs[0]![0] <= (ak.length >= 6 ? 1 : 0) && pairs[0]![1] <= 2;
		if (ak.length <= 2) {
			// a short attempt: its words in order among the retry's first words (one function word may differ, two before a
			// break-off), its first word first or second
			const head = R.slice(0, A.length + 2).map(tok);
			prefix =
				lcs(A.map(tok), head, (x, y) => same(x, y)) >= A.length - (cut(a1 - 1) ? 2 : 1) &&
				(same(tok(a0), head[0]!) || (head.length > 1 && same(tok(a0), head[1]!)));
		}
		const matched = new Map(pairs.map(([x, y]) => [x, y]));
		const brokenOff = cut(a1 - 1);
		const garble = ak.length >= 6 ? Math.max(1, Math.floor(0.15 * ak.length)) : ak.length >= 3 ? 1 : 0;
		let forgiven = 0;
		let inPlace = 0;
		let corrected = 0;
		let dropped = false;
		let hard = 0;
		const matchedR = new Set(pairs.map(([, y]) => rk[y]!));
		/** The retry's words between the matches of the attempt's content words around `x` (its place in the retry). */
		const slot = (x: number) => {
			const before = pairs.filter(([p]) => p < x).at(-1);
			const next = pairs.find(([p]) => p > x);
			const lo = before ? R.indexOf(rk[before[1]]!) + 1 : 0;
			return R.slice(lo, next ? R.indexOf(rk[next[1]]!) : lo + 3);
		};
		// a number or alphanumeric the retry does not say: another statement ("Me quedan nueve días | … seis días")
		let other = false;
		let prev = false;
		for (let x = 0; x < ak.length; x++) {
			if (matched.has(x)) {
				prev = false;
				continue;
			}
			const tx = tok(ak[x]!);
			const last = x === ak.length - 1;
			// a cut-off last word said whole ("cual…" → "cualquier"), or abandoned after three re-said words
			if (last && (brokenOff || a1 === r0) && rk.some((p) => same(tx, tok(p), true))) continue;
			if (last && brokenOff && pairs.length >= 3 && !exact(tx)) continue;
			// …or cut off after three or more words said again word for word ("lo peor es que el tor… | Y lo peor es que el
			// motor…", run 9 AC)
			if (
				last &&
				brokenOff &&
				!exact(tx) &&
				ak[x] === a1 - 1 &&
				a1 - 1 - a0 >= 3 &&
				verbatimAt(a0, a1 - 1, r0) >= 0
			)
				continue;
			let ok = false;
			// a stock phrase the recogniser inserted into the attempt (round 7, U b: "para hacer un ¡Suscríbete! motor…" said
			// again as "para hacer un motor de videojuegos"): its matched neighbours are next to each other in the retry
			if (ctx.inserted?.has(S[ak[x]!]!)) {
				const before = pairs.filter(([p]) => p < x).at(-1);
				const next = pairs.find(([p]) => p > x);
				if (before && (!next || next[1] === before[1] + 1)) continue;
			}
			// an ASR doubling: the word right next to it (no pause between them) is matched to a retry word it also sounds
			// like — one word written twice ("crecieron crashean" for one "crashean", said again as "crecían"; round 7 W a)
			if (!exact(tx) && inPlace < Math.ceil(ak.length / 3))
				for (const nb of [x - 1, x + 1]) {
					const y = matched.get(nb);
					if (y === undefined || Math.abs(ak[nb]! - ak[x]!) !== 1) continue;
					const [p1, p2] = nb < x ? [ak[nb]!, ak[x]!] : [ak[x]!, ak[nb]!];
					if (W(p2).s - W(p1).e <= t.stutterGapS && alike(tx, tok(rk[y]!))) {
						ok = true;
						inPlace++;
						break;
					}
				}
			if (!ok && !exact(tx) && inPlace < Math.ceil(ak.length / 3)) {
				// garbled in place: the retry says a word that sounds like it between the re-said words around it ("La
				// tarjeta gráfica le lee da esa imagen | la tarjeta gráfica le ves a imagen": "lee" / "ves", "esa" / "a")
				const before = pairs.filter(([p]) => p < x).at(-1);
				const next = pairs.find(([p]) => p > x);
				const lo = before ? R.indexOf(rk[before[1]]!) + 1 : 0;
				const hi = next ? R.indexOf(rk[next[1]]!) : lo + 3;
				ok = R.slice(lo, hi).some((p) => alike(tx, tok(p)));
				if (ok) inPlace++;
			}
			// or, in a long attempt, a word the speech right after the retry says (15 %, never two in a row)
			if (!ok && !exact(tx) && !prev && forgiven < garble && ak.length >= 6 && x > 0) {
				ok = after().some((p) => same(tx, tok(p)));
				if (ok) {
					forgiven++;
					prev = true;
					continue;
				}
			}
			// a dropped word: an abandoned take (written broken off) of ≥ 6 content words whose retry leaves out one word
			// between two re-said neighbours with no content word between them ("…después de haber casi… | …después de casi
			// explotar…", run 9 AC)
			if (!ok && !exact(tx) && brokenOff && !dropped && ak.length >= 6 && x > 0 && !last) {
				const before = pairs.filter(([p]) => p < x).at(-1);
				const next = pairs.find(([p]) => p > x);
				if (before && next && next[1] === before[1] + 1) {
					dropped = true;
					prev = false;
					continue;
				}
			}
			// a corrected word: the retry says another content word in its place, and the aside between them opens with that
			// word (after a correction marker and the attempt's words before it: "…completamente de Unity. | No, de ellos, … |
			// …completamente de ellos." — round 7, W)
			if (!ok && aside && corrected < Math.max(1, Math.floor(ak.length / 4))) {
				ok = slot(x).some(
					(y) => keyAt[y] && !matchedR.has(y) && !same(tx, tok(y)) && announces(aside, ak[x]!, y),
				);
				if (ok) corrected++;
			}
			if (ok) prev = false;
			else {
				hard++;
				if (exact(tx)) other = true;
			}
		}
		const lastPair = pairs.at(-1);
		return {
			full: prefix && hard === 0,
			share: other ? 0 : pairs.length / ak.length,
			prefix,
			last: lastPair ? rk[lastPair[1]]! : r0,
		};
	};

	/** How many words of a correction marker ("No, …", "perdón", "digo") open `aside` (0: none). */
	const correction = (aside: readonly [number, number]) => {
		for (const m of CORRECTION_MARKERS)
			if (aside[0] + m.length <= aside[1] && m.every((x, i) => tok(aside[0] + i) === x)) return m.length;
		return 0;
	};
	/**
	 * Whether `aside` names `y` in place of the attempt word at `x`: after an optional correction marker it opens with
	 * `y`, or with the one or two attempt words before `x` and then `y` ("de Unity" → "No, de ellos"); one function word
	 * the recogniser inserted among them is skipped (run 9, AE b: "cada imagen" → "cada La frame, no imagen.").
	 */
	const announces = (aside: readonly [number, number], x: number, y: number) => {
		const a = aside[0] + correction(aside);
		for (let c = 0; c <= 2 && x - c >= 0; c++) {
			const want = [...span(x - c, x).map(tok), tok(y)];
			for (let skip = -1; skip <= c; skip++) {
				if (skip >= 0 && (a + skip >= aside[1] || !ctx.stop.has(tok(a + skip)))) continue;
				const at = (i: number) => a + i + (skip >= 0 && i >= skip ? 1 : 0);
				if (at(c) < aside[1] && want.every((v, i) => same(v, tok(at(i))))) return true;
			}
		}
		return false;
	};
	/** The next copy after `p` of the opening `tok(p) tok(p + 1)` (n: none). */
	const nextCopy = (p: number, limit: number) => {
		for (let x = p + 1; x + 1 < limit; x++)
			if (same(tok(x), tok(p)) && same(tok(x + 1), tok(p + 1))) return x;
		return limit;
	};
	/** The retry from `r` (lead words included) whose opening is at `p`: up to its next copy. */
	const retryEnd = (r: number, p: number, len: number) => {
		let r1 = r;
		const cap = Math.min(n, r + retrySpan(len));
		while (r1 < cap && W(r1).s - W(r).s <= t.restartWindowS) r1++;
		return Math.min(r1, nextCopy(p, r1));
	};
	/** The speech after a retry `[r, r1)`, within the restart window. */
	const after = (r1: number) => {
		const out: number[] = [];
		for (let x = r1; x < n && W(x).s - W(r1 - 1).e <= t.restartWindowS; x++) out.push(x);
		return out;
	};
	/** Lead words of the retry at `p`: one or two words without content (or one with) said into it after a boundary. */
	const leadStart = (q: number, p: number) => {
		for (let m = 1; m <= 2; m++) {
			const r = p - m;
			if (r <= q) break;
			// (one content word may lead the retry when it is the only one: "… cerradas | ahora diseñé las curvas …")
			if ((key(tok(r)) && m > 1) || W(r + 1).s - W(r).e >= LEAD_IN_JOIN_S) break;
			if (r === 0 || ends(r - 1) || cut(r - 1) || gapAfter(r - 1) >= t.phraseGapS) return r;
		}
		return p;
	};
	/** The retry starts where the words before both copies still match (one ASR substitution between two matches). */
	const extend = (q: number, p: number): [number, number] => {
		// a retry that begins a clause begins there (two identical takes would otherwise slide back onto each other)
		if (clauseStart(p)) return [q, p];
		const m = (d: number) =>
			q - d >= 0 && p - d > q && !clauseStart(p - d + 1) && same(tok(q - d), tok(p - d));
		for (;;) {
			if (m(1)) {
				q--;
				p--;
			} else if (m(2) && m(3)) {
				q -= 3;
				p -= 3;
			} else return [q, p];
		}
	};

	type Cand = { link: RepeatLink; share: number; last: number; via: number };
	/** The best link of attempt start `q` to the retry opening at `p`, or null. */
	const evaluated = new Map<number, Cand | null>();
	const evaluate = (q0: number, p0: number): Cand | null => {
		const [q, p] = extend(q0, p0);
		const id = q * (n + 1) + p;
		if (evaluated.has(id)) return evaluated.get(id)!;
		const c = evaluateAt(q, p);
		evaluated.set(id, c);
		return c;
	};
	const evaluateAt = (q: number, p: number): Cand | null => {
		const r = leadStart(q, p);
		if (r - q > MAX_ATTEMPT_WORDS || r <= q) return null;
		if (r - q <= 3 && deliberate(q, r - q)) return null;
		// every link needs the attempt's opening among the first words after it (cheap refusal before any alignment)
		{
			const first = keys(q, Math.min(brokenWithin(q, r), q + 8))
				.slice(0, 2)
				.map(tok);
			const opening = first.length ? first : [tok(q)];
			let seen = 0;
			let found = false;
			for (let x = r; x < n && seen < 3 && !found && W(x).s - W(q).s <= t.restartWindowS; x++) {
				if (first.length && !keyAt[x]) continue;
				seen++;
				found = opening.some((y) => same(y, tok(x)));
			}
			if (!found && !first.length) return null;
			if (!found) {
				// or among the first words of a later copy of the retry (a chain)
				const next = nextCopy(p, Math.min(n, p + retrySpan(r - q)));
				if (
					next >= n ||
					!keys(next, Math.min(n, next + 8))
						.slice(0, 3)
						.some((x) => opening.some((y) => same(y, tok(x))))
				)
					return null;
			}
		}
		// a retry starts an attempt of its own ("hacer un botón con brillito, | hacer un botón con brillito y efecto de
		// fuego. | Hacer un botón con brillito…")
		const inside = !clauseStart(q) && !retryStarts.has(q);
		// an attempt that starts inside a sentence never runs over its end ("… una plantilla 2D o 3D. | la imagen …"; a
		// cut-off "…" is no end)
		const crosses = (e: number) => inside && span(q, e - 1).some((x) => ends(x) && !cut(x));
		const len = r - q;
		// the retry, or a later copy of it when it is abandoned too (a chain of takes)
		let rp = r;
		let pp = p;
		let corrected: { b: number; share: number; last: number } | null = null;
		for (let c = 0; c < MAX_CHAIN && pp < n; c++) {
			const r1 = retryEnd(rp, pp, len);
			let laterList: number[] | null = null;
			const later = () => (laterList ??= after(r1));
			let e = r;
			let cv = crosses(r) ? null : cover(q, r, rp, r1, later);
			if (!cv?.full && r - q > 2 && (markersOnly(r - 2, r) || markersOnly(r - 1, r))) {
				// marker words between an attempt and its retry ("Si te gusta el video | a ver | Si te gusta el video…")
				const m = markersOnly(r - 2, r) ? r - 2 : r - 1;
				const c2 = crosses(m) ? null : cover(q, m, rp, r1, later);
				if (c2?.full) {
					e = m;
					cv = c2;
				}
			}
			if (!cv?.full && keys(q, r).length >= 3 && clauseStart(r)) {
				// one short aside between the attempt and a retry that starts a clause ("Uf, me quedé sin aire."); the
				// longest common subsequence of each attempt prefix with the retry (one pass) skips hopeless boundaries
				const ak = keys(q, r);
				const rk = keys(rp, r1);
				const row = new Array<number>(rk.length + 1).fill(0);
				const best = [0];
				for (const x of ak) {
					let prev = 0;
					for (let y = 0; y < rk.length; y++) {
						const cur = row[y + 1]!;
						row[y + 1] = sameAt(x, rk[y]!) ? prev + 1 : Math.max(row[y + 1]!, row[y]!);
						prev = cur;
					}
					best.push(row[rk.length]!);
				}
				let spoken = 0;
				for (let b = r - 1; b > q && r - b <= ASIDE_MAX_WORDS; b--) {
					spoken += W(b).e - W(b).s;
					// an aside is no take: it never holds the retry of another attempt ("Al final del mes… | y deben…")
					if (spoken > ASIDE_MAX_S || (retryStarts.get(b) ?? q) < q) break;
					if (!clauseStart(b) || crosses(b)) continue;
					const k = ak.filter((x) => x < b).length;
					if (k < 3 || best[k]! < k - 1 - Math.floor(0.15 * k)) continue;
					const c2 = cover(q, b, rp, r1, later, [b, r]);
					if (c2.full) {
						e = b;
						cv = c2;
						break;
					}
					// a self-correction ("No, …") between a clause and its corrected retry: reviewed at least
					if (c === 0 && !corrected && correction([b, r]) && c2.prefix && c2.share >= t.retakeSimilarity)
						corrected = { b, share: c2.share, last: c2.last };
				}
			}
			if (!cv?.full && clauseStart(r)) {
				// an attempt broken off and said again word for word at the retry's start, then an aside (run 9, AF: "Sí, ya sé
				// que Roblox usa… ¿Dónde está el enojado? | Sí, ya sé que Roblox usa el WoW"; AG: "es… Espera. | es
				// extremadamente rápido."): a whole clause, ≤ 3 words after an attempt of fewer than four
				let b = q + 1;
				while (b < r && !cut(b - 1)) b++;
				const o = b < r ? verbatimAt(q, b, rp) : -1;
				let spoken = 0;
				for (let x = b; x < r; x++) spoken += W(x).e - W(x).s;
				if (
					o >= 0 &&
					!crosses(b) &&
					r - b <= (b - q >= 4 ? ASIDE_MAX_WORDS : 3) &&
					spoken <= ASIDE_MAX_S &&
					span(b, r).every((x) => (retryStarts.get(x) ?? q) >= q)
				) {
					e = b;
					cv = { full: true, share: 1, prefix: true, last: o + (b - q) - 1 };
				}
			}
			// an attempt that starts inside a sentence and finishes it is re-said word for word (an ASR garble in seven
			// aside): "Bueno, no lo reescribí yo. | Lo reescribí a mis agentes…" is no restart
			if (cv?.full && inside && ends(e - 1) && !cut(e - 1)) {
				const own = span(q, e).filter((x) => !inner(x, q, e));
				const rt = span(rp, Math.min(n, rp + own.length + 3));
				if (lcs(own, rt, (x, y) => alike(tok(x), tok(y))) < own.length - Math.floor(own.length / 7))
					cv = null;
			}
			if (cv?.full) {
				const words = e - q;
				const kind =
					words <= 2
						? 'false-start'
						: clauseStart(q) && (ends(e - 1) || gapAfter(e - 1) >= t.takeGapS) && keys(q, e).length >= 3
							? 'retake'
							: 'restart';
				return {
					link: { attempt: [q, e], aside: [e, r], retry: rp, retryEnd: rp, kind, tier: 'remove' },
					share: 1,
					last: cv.last,
					via: r,
				};
			}
			if (!cv?.full && corrected)
				return {
					link: {
						attempt: [q, corrected.b],
						aside: [corrected.b, r],
						retry: rp,
						retryEnd: rp,
						kind: 'retake',
						tier: 'review',
					},
					share: corrected.share,
					last: corrected.last,
					via: r,
				};
			// review: one whole clause, most of it said again from the start of the clause after it
			const oneClause = span(q + 1, r).every((x) => !clauseStart(x)) && clauseStart(r);
			if (
				c === 0 &&
				cv &&
				!inside &&
				oneClause &&
				cv.prefix &&
				keys(q, r).length >= 2 &&
				cv.share >= t.retakeSimilarity
			)
				return {
					link: { attempt: [q, r], aside: [r, r], retry: r, retryEnd: r, kind: 'retake', tier: 'review' },
					share: cv.share,
					last: cv.last,
					via: r,
				};
			const next = nextCopy(pp, Math.min(n, pp + retrySpan(len)));
			if (next >= n || W(next).s - W(q).s > t.restartWindowS) break;
			pp = next;
			rp = leadStart(r, next);
		}
		return null;
	};

	const links: Array<Cand> = [];
	/** Retry starts of the links found so far, and where their attempt starts. */
	const retryStarts = new Map<number, number>();
	const weak = (x: string) => ctx.restartStop.has(x) || x.length < t.restartContentLetters;
	for (let p = 1; p < n; p++) {
		const qs = new Set<number>();
		for (const k of [3, 2]) {
			if (p + k > n) continue;
			if (k === 2 && weak(tok(p)) && weak(tok(p + 1))) continue;
			const win = k === 3 ? t.restartWindowWords : t.restartWindowWords2;
			for (let q = p - k; q >= Math.max(0, p - win); q--) {
				if (W(p).s - W(q).s > t.restartWindowS) break;
				// the n-gram said again, one word of a 3-gram after the first garbled in place ("que pueda ser" / "que
				// puedo hacer", fragment E)
				let garbled = 0;
				for (let x = 0; x < k && garbled < 2; x++)
					if (!sameAt(q + x, p + x)) garbled += k === 3 && x > 0 && alike(tok(q + x), tok(p + x)) ? 1 : 2;
				if (garbled < 2) qs.add(q);
			}
		}
		// two clause starts whose first words match: the retry may add a lead word ("Y bueno, …" after "bueno, …")
		if (clauseStart(p)) {
			const rk = keys(p, Math.min(n, p + 6))
				.slice(0, 2)
				.map(tok);
			// the retry's first word, or its first after one or two lead words without content
			const head: string[] = [];
			for (let x = p; x < Math.min(n, p + 3); x++) {
				head.push(tok(x));
				if (keyAt[x]) break;
			}
			for (let q = p - 1; q >= Math.max(0, p - MAX_ATTEMPT_WORDS); q--) {
				if (W(p).s - W(q).s > t.restartWindowS) break;
				if (!clauseStart(q)) continue;
				// a lead word without content said into the attempt ("Y es… | es extremadamente"): the attempt starts after it
				if (
					!head.some((y) => same(tok(q), y)) &&
					q + 1 < p &&
					!keyAt[q] &&
					W(q + 1).s - W(q).e < LEAD_IN_JOIN_S &&
					head.some((y) => same(tok(q + 1), y)) &&
					span(q + 1, Math.min(p, q + 4)).some(cut) &&
					brokenWithin(q + 1, p) - (q + 1) <= 2 &&
					!keys(q + 1, brokenWithin(q + 1, p)).length
				)
					qs.add(q + 1);
				if (!head.some((y) => same(tok(q), y))) continue;
				// (an attempt broken off within its first three words is judged by those: "es… Espera. | es extremadamente")
				const lim = brokenWithin(q, p);
				const first = keys(q, lim)[0];
				if (first === undefined ? lim - q <= 2 : rk.some((y) => same(tok(first), y))) qs.add(q);
			}
		}
		let best: Cand | null = null;
		const more: Cand[] = [];
		for (const q of [...qs].sort((a, b) => a - b)) {
			if (best?.link.tier === 'remove') {
				// attempts of the same retry after the farthest one's attempt (it may hold them as an aside)
				if (q < best.link.attempt[1]) continue;
				const c = evaluate(q, p);
				if (c?.link.tier === 'remove' && c.link.retry === best.link.retry) more.push(c);
				continue;
			}
			const c = evaluate(q, p);
			if (!c) continue;
			if (c.link.tier === 'remove' || !best || c.share > best.share) best = c;
		}
		for (const c of best ? [best, ...more] : [])
			if (!links.some((l) => sameLink(l.link, c.link))) {
				links.push(c);
				if (c.link.tier === 'remove')
					retryStarts.set(c.link.retry, Math.min(c.link.attempt[0], retryStarts.get(c.link.retry) ?? n));
			}
	}

	// the retry must be complete (its clause does not end broken off unless that ending goes too), and what lies between
	// attempt and retry must go: later links first
	const removed = new Set<number>();
	const clauseEnd = (from: number) => {
		let x = from;
		while (x < n - 1 && !ends(x) && gapAfter(x) < t.takeGapS) x++;
		return x;
	};
	const final: RepeatLink[] = [];
	const attemptStarts = new Set<number>();
	const inAttempt = new Set<number>();
	const inAside = new Set<number>();
	/** Whether a later accepted link's attempt holds the retry at `r` from its own start on. */
	const chained = (r: number) => {
		// the attempt starts at the retry's opening, or after lead words of the retry without content
		for (let x = r; x < n && x - r <= 2; x++) {
			if (attemptStarts.has(x)) return true;
			if (key(tok(x))) break;
		}
		let x = r;
		while (x > 0 && inAttempt.has(x) && inAttempt.has(x - 1) && !attemptStarts.has(x)) x--;
		return attemptStarts.has(x) && span(x, r).every((y) => !key(tok(y)));
	};
	for (const c of [...links].sort(
		(a, b) => b.link.retry - a.link.retry || b.link.attempt[0] - a.link.attempt[0],
	)) {
		const l = c.link;
		const ce = clauseEnd(Math.max(c.last, l.retry));
		l.retryEnd = ce;
		if (l.tier === 'remove') {
			// a retry said again later is complete only when that later copy removes it (the recogniser's "…" alone
			// often marks a pause, not a break-off: "… en mi motor…… y correr en todas las plataformas")
			const lim = Math.min(n, ce + retrySpan(ce - l.retry));
			const again = nextCopy(l.retry + (l.retry < n - 1 && !key(tok(l.retry)) ? 1 : 0), lim);
			const complete =
				again >= lim || W(again).s - W(ce).e > t.restartWindowS || !cut(ce) || chained(l.retry);

			// a retry removed by a later link must be that link's attempt, said again by its retry (a chain), or the same
			// restart seen from another opening (the later attempt goes on from this one); removed inside another attempt
			// or an aside, nothing says this attempt again
			const swallowed =
				removed.has(l.retry) &&
				!chained(l.retry) &&
				(inAside.has(l.retry) || !inAttempt.has(l.attempt[1] - 1));
			if (!complete || swallowed) l.tier = 'review';
		}
		if (l.tier === 'remove') {
			for (let x = l.attempt[0]; x < l.aside[1]; x++) removed.add(x);
			attemptStarts.add(l.attempt[0]);
			for (let x = l.attempt[0]; x < l.attempt[1]; x++) inAttempt.add(x);
			for (let x = l.aside[0]; x < l.aside[1]; x++) inAside.add(x);
		}
		final.push(l);
	}
	final.reverse();
	// what lies between an attempt and a later copy of its retry must go (other attempts of the chain): checked once
	// every link is resolved, until nothing changes
	for (let changed = true; changed; ) {
		changed = false;
		const gone = new Set<number>();
		for (const l of final) if (l.tier === 'remove') for (let x = l.attempt[0]; x < l.retry; x++) gone.add(x);
		for (const l of final)
			if (l.tier === 'remove' && !span(l.aside[1], l.retry).every((x) => gone.has(x))) {
				l.tier = 'review';
				changed = true;
			}
	}
	// an attempt opens with the lead words of its clause the retry does not repeat ("Y | el otro 1 % son…" said again as
	// "el otro 1 % son…"): one or two words without content after a boundary, joined to the attempt
	for (const l of final) {
		if (l.tier !== 'remove' || clauseStart(l.attempt[0])) continue;
		for (let m = 1; m <= 2; m++) {
			const x = l.attempt[0] - m;
			if (x < 0 || keyAt[x] || W(x + 1).s - W(x).e >= LEAD_IN_JOIN_S || same(tok(x), tok(l.retry))) break;
			if (clauseStart(x) && !final.some((o) => o !== l && o.attempt[0] <= x && x < o.retry)) {
				l.attempt = [x, l.attempt[1]];
				const e = l.attempt[1];
				if (l.kind === 'restart' && (ends(e - 1) || gapAfter(e - 1) >= t.takeGapS) && keys(x, e).length >= 3)
					l.kind = 'retake';
				break;
			}
		}
	}
	// labels: attempts and asides (positions → words)
	for (const l of final) {
		const action =
			l.tier === 'review'
				? 'review'
				: l.kind === 'retake'
					? retake
					: l.kind === 'false-start'
						? falseStart
						: restart;
		if (action === 'off') continue;
		for (let x = l.attempt[0]; x < l.aside[1]; x++) {
			const k = S[x]!;
			const cur = ctx.labels[k];
			if (cur && !(cur.action === 'review' && action !== 'review' && TAKE_KINDS.has(cur.kind))) continue;
			ctx.labels[k] = { kind: l.kind, action };
		}
	}
	// positions → word indices
	return final.map((l) => ({
		...l,
		attempt: [S[l.attempt[0]]!, S[l.attempt[1] - 1]! + 1],
		aside: l.aside[1] > l.aside[0] ? [S[l.aside[0]]!, S[l.aside[1] - 1]! + 1] : [S[l.retry]!, S[l.retry]!],
		retry: S[l.retry]!,
		retryEnd: S[l.retryEnd]!,
	}));
}

const TAKE_KINDS: ReadonlySet<string> = new Set(['restart', 'false-start', 'retake']);

const sameLink = (a: RepeatLink, b: RepeatLink) =>
	a.attempt[0] === b.attempt[0] && a.attempt[1] === b.attempt[1] && a.retry === b.retry;

// Spec 13 AS-002 / AS-042: subtitle text — the text transforms (case, trailing punctuation, glyph replacement,
// profanity mask) and line breaking with the language's "weak" words (articles, prepositions, conjunctions) kept
// with the words they introduce when avoidable (Spanish subtitling convention: a line should not end on "de", "la",
// "y"…; the same rule is applied to English function words).
import { normalizeWord } from '../words.ts';
import { GLYPH_REPLACEMENTS, type SubtitleText } from './rules.ts';

/**
 * Words a line (or a one-line subtitle) should not end on, per language (lower case, primary subtag). Spanish:
 * articles, contractions, prepositions, conjunctions and unstressed possessives / pronouns that open a phrase.
 */
export const WEAK_LINE_END_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
	es: new Set(
		(
			'el la los las un una unos unas lo al del a ante bajo con contra de desde durante en entre hacia hasta ' +
			'mediante para por según sin sobre tras y e ni o u pero que si porque como cuando mi mis tu tus su sus ' +
			'nuestro nuestra nuestros nuestras se me te le les nos muy más tan'
		).split(' '),
	),
	en: new Set(
		(
			'a an the of to in on at for with by from into onto upon about as and or nor but if than that so my your ' +
			'his her its our their this these those very'
		).split(' '),
	),
};

/** The weak-word set of a BCP-47 language tag (null when the language has none). */
export function weakWordsFor(language: string | null | undefined): ReadonlySet<string> | null {
	const primary = (language ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
	return WEAK_LINE_END_WORDS[primary] ?? null;
}

export function isWeakWord(word: string, weak: ReadonlySet<string> | null): boolean {
	return !!weak && weak.has(normalizeWord(word));
}

const SENTENCE_END = /[.?!…]["'”’)»\]]*$/u;
/** Ends a sentence (for Sentence case and punctuation breaks). */
export function endsSentence(word: string): boolean {
	return SENTENCE_END.test(word);
}
const CLAUSE_END = /[,;:]["'”’)»\]]*$/u;
/** Ends a clause (comma, semicolon, colon) — breaks with punctuation "always". */
export function endsClause(word: string): boolean {
	return CLAUSE_END.test(word);
}

const TRAILING_PUNCT = /[\s.,;:!?…"'”’»)\]¡¿-]+$/u;

function upperFirst(s: string, language: string): string {
	const m = /\p{L}/u.exec(s);
	if (!m) return s;
	return s.slice(0, m.index) + s[m.index]!.toLocaleUpperCase(language) + s.slice(m.index + 1);
}

function maskWord(w: string, mask: 'asterisks' | 'first-letter'): string {
	const chars = [...w];
	let firstKept = mask !== 'first-letter';
	return chars
		.map((ch) => {
			if (!/[\p{L}\p{N}]/u.test(ch)) return ch;
			if (!firstKept) {
				firstKept = true;
				return ch;
			}
			return '*';
		})
		.join('');
}

/**
 * Display text of each word of a run of words (the whole transcript slice, so Sentence case knows where sentences
 * start): case, glyph replacement and profanity mask. Trailing punctuation is stripped per subtitle
 * (`finishSubtitleText`).
 */
export function transformWords(words: readonly string[], opts: SubtitleText, language: string): string[] {
	const lang = language && language !== 'und' ? language : 'en';
	const profane = new Set((opts.profanity?.words ?? []).map((w) => normalizeWord(w)).filter(Boolean));
	const missing = opts.missingGlyphs ? new Set([...opts.missingGlyphs]) : null;
	let sentenceStart = true;
	return words.map((raw) => {
		let w = raw;
		if (opts.case === 'upper') w = w.toLocaleUpperCase(lang);
		else if (opts.case === 'lower') w = w.toLocaleLowerCase(lang);
		else if (opts.case === 'sentence') {
			w = w.toLocaleLowerCase(lang);
			if (sentenceStart) w = upperFirst(w, lang);
		}
		if (opts.replaceGlyphs)
			for (const [from, to] of GLYPH_REPLACEMENTS)
				if ((!missing || missing.has(from)) && w.includes(from)) w = w.split(from).join(to);
		if (profane.size && profane.has(normalizeWord(raw))) w = maskWord(w, opts.profanity?.mask ?? 'asterisks');
		if (/[\p{L}\p{N}]/u.test(raw)) sentenceStart = endsSentence(raw);
		else if (endsSentence(raw)) sentenceStart = true;
		return w;
	});
}

/** The last word of a subtitle without its trailing punctuation (when the option is on); never empties a word. */
export function stripTrailing(word: string): string {
	const s = word.replace(TRAILING_PUNCT, '');
	return s.length ? s : word;
}

const charCount = (s: string) => [...s].length;

/**
 * Lines of a subtitle: words fill lines of at most `maxChars` (a longer single word gets a line of its own), at most
 * `lines` lines (the last line takes the rest). With weak words, a line does not end on a weak word when the word
 * fits on the next line instead. `glued[i]` marks a piece of a split word (`wordPieces`) that continues the previous
 * one without a space when they share a line. Returns the index (within `words`) of the first word of each line
 * after the first.
 */
export function breakLines(
	words: readonly string[],
	maxChars: number,
	lines: number,
	weak: ReadonlySet<string> | null,
	glued?: readonly boolean[],
): number[] {
	const starts: number[] = [];
	const gap = (k: number) => (glued?.[k] ? 0 : 1);
	let len = 0;
	for (let i = 0; i < words.length; i++) {
		const n = charCount(words[i]!);
		if (i === 0 || starts.length + 1 >= lines) {
			len = len ? len + gap(i) + n : n;
			continue;
		}
		if (len + gap(i) + n <= maxChars) {
			len += gap(i) + n;
			continue;
		}
		// break before word i; keep a weak line end with it when the next line has room
		let at = i;
		const lineStart = starts.length ? starts[starts.length - 1]! : 0;
		if (weak && at - 1 > lineStart && !glued?.[at - 1] && isWeakWord(words[at - 1]!, weak)) {
			const moved = charCount(words[at - 1]!) + gap(i) + n;
			if (moved <= maxChars) at -= 1;
		}
		starts.push(at);
		len = 0;
		for (let k = at; k <= i; k++) len = len ? len + gap(k) + charCount(words[k]!) : charCount(words[k]!);
	}
	return starts;
}

/** Characters that end a piece of a long word (it is split after them): hyphens, slash, underscore. */
const PIECE_END = /[-\u2010\u2011\u2013\u2014/_]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;

/**
 * A word longer than `maxChars` split at its natural boundaries — CamelCase ("Entity|Component|System", "HTTP|Server"),
 * after a hyphen, slash or underscore ("pre-|production"), letter / digit transitions ("COVID|19") — into the fewest
 * pieces of at most `maxChars` characters (a stretch without a boundary stays whole, longer if it must). A word is
 * never cut anywhere else. Words that fit come back as they are.
 */
export function wordPieces(word: string, maxChars: number): string[] {
	const chars = [...word];
	const max = Math.max(1, Math.floor(maxChars));
	if (chars.length <= max) return [word];
	const cand: number[] = [];
	let seen = false;
	for (let k = 1; k < chars.length; k++) {
		const a = chars[k - 1]!;
		const b = chars[k]!;
		if (LETTER_OR_DIGIT.test(a)) seen = true;
		// a piece holds a letter or digit on each side of the boundary
		if (!seen || !LETTER_OR_DIGIT.test(b) || !chars.slice(k).some((c) => LETTER_OR_DIGIT.test(c))) continue;
		const c = chars[k + 1];
		if (
			PIECE_END.test(a) ||
			(LOWER.test(a) && UPPER.test(b)) ||
			(UPPER.test(a) && UPPER.test(b) && c !== undefined && LOWER.test(c)) ||
			(LETTER.test(a) && DIGIT.test(b)) ||
			(DIGIT.test(a) && LETTER.test(b))
		)
			cand.push(k);
	}
	const out: string[] = [];
	let s = 0;
	while (chars.length - s > max) {
		let at = -1;
		for (const k of cand) if (k > s && k - s <= max) at = k;
		if (at < 0) at = cand.find((k) => k > s) ?? -1;
		if (at < 0) break;
		out.push(chars.slice(s, at).join(''));
		s = at;
	}
	out.push(chars.slice(s).join(''));
	return out;
}

/** The text of a subtitle: its display words on lines (`\n`), the trailing punctuation stripped when asked. */
export function subtitleText(
	words: readonly string[],
	lineStarts: readonly number[],
	strip: boolean,
): string {
	if (!words.length) return '';
	const shown = [...words];
	if (strip) shown[shown.length - 1] = stripTrailing(shown[shown.length - 1]!);
	const out: string[] = [];
	let line: string[] = [];
	shown.forEach((w, i) => {
		if (lineStarts.includes(i) && line.length) {
			out.push(line.join(' '));
			line = [];
		}
		line.push(w);
	});
	if (line.length) out.push(line.join(' '));
	return out.join('\n');
}

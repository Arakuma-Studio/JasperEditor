// Script parsing (spec 17 SC-002). Ported from the scriptfix spike (`sfcore.py` `script_tokens`; FINDINGS §2.1):
// whitespace tokens with their line, `paren` tokens inside "(...)" (spoken asides and stage directions alike),
// `heading` lines, a section index that increments at headings, and "&" read as "y" / "and". Also the proper-noun
// evidence of SC-023 (capitalised mid-sentence, brand-like spellings). Pure; never throws; linear in the text.
//
// Differences from the spike, all deliberate: a heading is any line of ≤ 8 words ending in ":" (the spec's rule; the
// spike only accepted such lines without letters), heading keywords ignore accents ("guión short"), an unclosed
// "(" ends at the next blank line instead of running to the end of the script, and "&" is a word.
import { functionWords, normalizeWord, type ScriptFixLanguage, scriptFixLanguage } from './text.ts';

/** How a script token is read (SC-002). `paren` and `heading` tokens are directions: skipped for free, never fixed. */
export type ScriptTokenKind = 'word' | 'paren' | 'heading';

/** A token of a pasted script. */
export type ScriptToken = {
	/** The text as written, punctuation included ("¿Listos?", "(risas)"). */
	text: string;
	/** `normalizeWord` of the text ("&" reads "y" in Spanish, "and" otherwise). */
	norm: string;
	/** 0-based line index in the script text. */
	line: number;
	/** Section index: 0 before the first heading, +1 at every heading line (the heading belongs to its section). */
	section: number;
	kind: ScriptTokenKind;
	/** Not the first word of a sentence (an earlier word on the line does not end in . ! ? … : and no ¿ / ¡ opens it). */
	midSentence: boolean;
	/** Letter case as written (`none`: no letters). */
	letterCase: 'lower' | 'title' | 'upper' | 'mixed' | 'none';
	/** Brand-like spelling: a lower-case letter followed by an upper-case one ("iOS", "PlayStore") or digits inside letters. */
	brandLike: boolean;
};

/** A section of the script (SC-002 summary). */
export type ScriptSection = {
	index: number;
	/** The heading line that opens it (null for section 0). */
	heading: string | null;
	line: number;
	/** Spoken (`word`) tokens in the section. */
	words: number;
};

/** What the Script drawer shows (SC-002): sections found and how many directions / headings are skipped. */
export type ScriptSummary = {
	lines: number;
	tokens: number;
	/** Tokens that are read (kind `word`). */
	words: number;
	/** Tokens inside parentheses (kind `paren`). */
	directionTokens: number;
	/** Parenthesised groups ("(risas)", "(mostrar la pantalla de inicio)"). */
	directions: number;
	headingLines: number;
	headingTokens: number;
	sections: ScriptSection[];
};

/** A parsed script. */
export type ParsedScript = {
	language: ScriptFixLanguage;
	tokens: ScriptToken[];
	/**
	 * Normalised words that read as proper nouns (SC-023): brand-like spellings, and words capitalised in more of their
	 * mid-sentence occurrences than written in lower case (scripts also hold random all-caps words, which do not count).
	 */
	properNorms: string[];
	summary: ScriptSummary;
};

const HEADING_KEYWORDS = /^(short|guion short|video largo|largo|intro|outro)\b/;
const MAX_HEADING_WORDS = 8;
/** Glued words split apart ("algo/otro", "hola…que"); "3d", "x2" stay whole. */
const GLUE = /(?<=\p{L})[/…]+(?=\p{L})/u;
const SENTENCE_END = /[.!?…:]["”»)]*$/u;

function stripAccents(s: string): string {
	return s.normalize('NFD').replace(/\p{Mn}/gu, '');
}

/** Whether a trimmed line is a heading (SC-002): ≤ 8 words, a heading keyword (case/accents ignored) or a final ":". */
export function isHeadingLine(line: string): boolean {
	const s = line.trim();
	if (!s) return false;
	if (s.split(/\s+/).length > MAX_HEADING_WORDS) return false;
	return HEADING_KEYWORDS.test(stripAccents(s.toLowerCase())) || s.endsWith(':');
}

function letterCase(text: string): 'lower' | 'title' | 'upper' | 'mixed' | 'none' {
	const letters = [...text].filter((c) => /\p{L}/u.test(c));
	if (!letters.length) return 'none';
	const up = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
	for (let i = 1; i < letters.length; i++) if (!up(letters[i - 1]!) && up(letters[i]!)) return 'mixed';
	if (letters.every((c) => !up(c))) return 'lower';
	if (letters.length > 1 && letters.every(up)) return 'upper';
	return up(letters[0]!) ? 'title' : 'mixed';
}

/** Brand-like spelling (SC-023): mixed case or digits between letters. */
export function isBrandLike(text: string): boolean {
	return letterCase(text) === 'mixed' || /\p{L}\d+\p{L}|\p{L}\d+$/u.test(text);
}

/**
 * Parses a pasted script (SC-002). `language` decides how "&" reads ("y" for Spanish, "and" otherwise).
 */
export function parseScript(text: string, options: { language?: string | null } = {}): ParsedScript {
	const language = scriptFixLanguage(options.language);
	const amp = language === 'es' ? 'y' : 'and';
	const tokens: ScriptToken[] = [];
	const sections: ScriptSection[] = [{ index: 0, heading: null, line: 0, words: 0 }];
	let paren = 0;
	let section = 0;
	let lines = 0;
	let directions = 0;
	let headingLines = 0;
	const raw = typeof text === 'string' ? text : '';
	const allLines = raw.replace(/﻿/g, '').replace(/\r\n?/g, '\n').split('\n');
	for (let li = 0; li < allLines.length; li++) {
		const s = allLines[li]!.trim();
		if (!s) {
			paren = 0;
			continue;
		}
		lines++;
		const heading = isHeadingLine(s);
		if (heading) {
			section++;
			headingLines++;
			sections.push({ index: section, heading: s, line: li, words: 0 });
		}
		let sentenceStart = true;
		for (const word of s.split(/\s+/)) {
			if (!word) continue;
			for (const part of word.split(GLUE)) {
				if (!part) continue;
				const opens = (part.match(/\(/g) ?? []).length;
				const closes = (part.match(/\)/g) ?? []).length;
				const inside = paren > 0 || opens > 0;
				if (opens > 0 && paren === 0) directions++;
				const bare = part.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, '');
				const norm = bare === '&' ? amp : normalizeWord(part);
				if (norm) {
					const kind: ScriptTokenKind = heading ? 'heading' : inside ? 'paren' : 'word';
					tokens.push({
						text: part,
						norm,
						line: li,
						section,
						kind,
						midSentence: !sentenceStart && !/^[¿¡]/u.test(part),
						letterCase: letterCase(part),
						brandLike: isBrandLike(part),
					});
					if (kind === 'word') sections[section]!.words++;
					sentenceStart = SENTENCE_END.test(part);
				} else if (SENTENCE_END.test(part)) sentenceStart = true;
				paren = Math.max(0, paren + opens - closes);
			}
		}
	}
	return { language, tokens, properNorms: properNorms(tokens, language), summary: summarise() };

	function summarise(): ScriptSummary {
		let words = 0;
		let directionTokens = 0;
		let headingTokens = 0;
		for (const t of tokens) {
			if (t.kind === 'word') words++;
			else if (t.kind === 'paren') directionTokens++;
			else headingTokens++;
		}
		return {
			lines,
			tokens: tokens.length,
			words,
			directionTokens,
			directions,
			headingLines,
			headingTokens,
			sections,
		};
	}
}

function properNorms(tokens: readonly ScriptToken[], lang: ScriptFixLanguage): string[] {
	const stop = functionWords(lang);
	const votes = new Map<string, number>();
	const titleMid = new Map<string, number>();
	const lower = new Map<string, number>();
	const brand = new Set<string>();
	const bump = (m: Map<string, number>, n: string, d: number) => m.set(n, (m.get(n) ?? 0) + d);
	for (const t of tokens) {
		if (t.kind !== 'word' || stop.has(t.norm)) continue;
		if (t.brandLike) brand.add(t.norm);
		if (t.letterCase === 'lower') bump(lower, t.norm, 1);
		if (!t.midSentence) continue;
		if (t.letterCase === 'title' || t.letterCase === 'mixed') {
			bump(votes, t.norm, 1);
			bump(titleMid, t.norm, 1);
		} else if (t.letterCase === 'lower') bump(votes, t.norm, -1);
	}
	const out = new Set(brand);
	for (const [n, v] of votes) if (v > 0) out.add(n);
	// names written inconsistently ("Nova" twice mid-sentence, "nova" three times): capitalised mid-sentence in at
	// least a third of their occurrences (SC-105 harness: a channel name the script writes both ways)
	for (const [n, k] of titleMid) if (2 * k >= (lower.get(n) ?? 0)) out.add(n);
	return [...out].sort();
}

// Script-guided transcript correction (spec 17 SC-010, SC-011, SC-023): languages, normalisation, spoken numbers,
// function words and the English loanword list. Pure; ported from the scriptfix spike (`sfcore.py` `norm`, `num_es`,
// `spoken`, `STOP`; private research `.prproj-analysis/research/scriptfix`, FINDINGS §2.1) with English numbers and
// the "un/una/one = 1" alias added as SC-011 asks. See docs/wp-notes/script-correction.md "Model".
import { builtinLists, cleanupLanguageOf, cleanupNorm } from '../cleanup/lists.ts';

/** The rule set a transcript is corrected with: Spanish, English, or the language-neutral fallback (null). */
export type ScriptFixLanguage = 'es' | 'en' | null;

/** The rule set of a language tag (`es`, `es-MX`, `en-US`, `spa`…); anything else is the neutral fallback. */
export function scriptFixLanguage(tag: string | null | undefined): ScriptFixLanguage {
	return cleanupLanguageOf(tag);
}

/** SC-010: lower case, accents stripped, ñ → n, only [a-z0-9] kept (the cleanup's `cleanupNorm`). */
export const normalizeWord = cleanupNorm;

/**
 * Function words: the cleanup's stop words of the language plus the spike's few Spanish additions (`sfcore.STOP`:
 * ha, he, han, e, u, ni, nos). The neutral fallback uses the union of every language's stop words.
 */
const SPANISH_EXTRA_STOP = ['ha', 'he', 'han', 'e', 'u', 'ni', 'nos'];
const STOP_CACHE = new Map<string, ReadonlySet<string>>();
export function functionWords(lang: ScriptFixLanguage): ReadonlySet<string> {
	const key = lang ?? '*';
	let set = STOP_CACHE.get(key);
	if (!set) {
		const base = builtinLists(lang).stopWords;
		set = new Set(lang === 'es' ? [...base, ...SPANISH_EXTRA_STOP] : base);
		STOP_CACHE.set(key, set);
	}
	return set;
}

/** SC-013: a content word is not a function word and has at least 3 letters. */
export function isContentWord(norm: string, stop: ReadonlySet<string>): boolean {
	return norm.length >= 3 && !stop.has(norm);
}

// ---------------------------------------------------------------- numbers 0..999,999 (SC-011)
const ES_UNITS =
	'cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve veinte veintiuno veintidos veintitres veinticuatro veinticinco veintiseis veintisiete veintiocho veintinueve'.split(
		' ',
	);
const ES_TENS: Record<number, string> = {
	30: 'treinta',
	40: 'cuarenta',
	50: 'cincuenta',
	60: 'sesenta',
	70: 'setenta',
	80: 'ochenta',
	90: 'noventa',
};
const ES_HUNDREDS: Record<number, string> = {
	100: 'cien',
	200: 'doscientos',
	300: 'trescientos',
	400: 'cuatrocientos',
	500: 'quinientos',
	600: 'seiscientos',
	700: 'setecientos',
	800: 'ochocientos',
	900: 'novecientos',
};

/** Spanish words of 0 ≤ n < 1,000,000, space separated ("treinta y dos", "ciento uno", "veintiun mil"). */
export function spanishNumber(n: number): string {
	if (n < 30) return ES_UNITS[n]!;
	if (n < 100) {
		const u = n % 10;
		return ES_TENS[n - u]! + (u === 0 ? '' : ` y ${ES_UNITS[u]}`);
	}
	if (n < 1000) {
		const r = n % 100;
		const h = n - r;
		return (h === 100 && r ? 'ciento' : ES_HUNDREDS[h]!) + (r === 0 ? '' : ` ${spanishNumber(r)}`);
	}
	const k = Math.floor(n / 1000);
	const r = n % 1000;
	const kw = k === 1 ? 'mil' : `${spanishNumber(k).replace('uno', 'un')} mil`;
	return kw + (r === 0 ? '' : ` ${spanishNumber(r)}`);
}

const EN_UNITS =
	'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(
		' ',
	);
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** English words of 0 ≤ n < 1,000,000, space separated ("thirty two", "one hundred one", "two thousand"). */
export function englishNumber(n: number): string {
	if (n < 20) return EN_UNITS[n]!;
	if (n < 100) {
		const u = n % 10;
		return EN_TENS[Math.floor(n / 10)]! + (u === 0 ? '' : ` ${EN_UNITS[u]}`);
	}
	if (n < 1000) {
		const r = n % 100;
		return `${EN_UNITS[Math.floor(n / 100)]} hundred${r === 0 ? '' : ` ${englishNumber(r)}`}`;
	}
	const r = n % 1000;
	return `${englishNumber(Math.floor(n / 1000))} thousand${r === 0 ? '' : ` ${englishNumber(r)}`}`;
}

const NUMERIC = /^(\d{1,6})([a-z]*)$/;

/** Whether a normalised token is a number with an optional unit suffix ("24", "3d", "60s"). */
export function isNumericToken(norm: string): boolean {
	return NUMERIC.test(norm);
}

/**
 * The spoken form of a normalised token without spaces (`sfcore.spoken`): "24" → "veinticuatro" (es) /
 * "twentyfour" (en), "3d" → "tresd", "60s" → "sesentas". Non-numbers, and every token in the neutral fallback, are
 * returned unchanged.
 */
export function spokenForm(norm: string, lang: ScriptFixLanguage): string {
	if (lang === null) return norm;
	const m = NUMERIC.exec(norm);
	if (!m) return norm;
	const n = Number(m[1]);
	const words = lang === 'es' ? spanishNumber(n) : englishNumber(n);
	return words.replace(/ /g, '') + m[2];
}

/** Aliases of "1" (SC-011): the articles un / una and English "one" count as the digit. */
const ONE_ALIASES = new Set(['un', 'una', 'uno', 'one']);

/** Every spoken form a numeric token matches exactly (both languages, plus the "1" aliases). */
function numberForms(norm: string): string[] {
	const m = NUMERIC.exec(norm);
	if (!m) return [norm];
	const n = Number(m[1]);
	const suffix = m[2]!;
	const out = [spanishNumber(n).replace(/ /g, '') + suffix, englishNumber(n).replace(/ /g, '') + suffix];
	if (n === 1) for (const a of ONE_ALIASES) out.push(a + suffix);
	return out;
}

/**
 * SC-011 exact match of two normalised tokens: equal, or a number written with digits on one side whose spoken form
 * (Spanish or English, 0–999,999; un/una/one = 1) equals the other side ("24" = "veinticuatro", "3d" = "tresd",
 * "1" = "una"). Two words without digits are never number-equal ("un" ≠ "uno").
 */
export function numberEqual(a: string, b: string): boolean {
	const da = NUMERIC.test(a);
	const db = NUMERIC.test(b);
	if (!da && !db) return false;
	const fa = numberForms(a);
	const fb = numberForms(b);
	if (da && db) return fa.some((x) => fb.includes(x));
	return da ? fa.includes(b) : fb.includes(a);
}

/** SC-010/011: two normalised tokens are an exact match. */
export function exactMatch(a: string, b: string): boolean {
	return a === b || numberEqual(a, b);
}

// ---------------------------------------------------------------- English loanwords (SC-023)
/**
 * Common English words in Spanish speech about games, software and video making (SC-023 "English word list";
 * `cleanupNorm` form). Original list for JasperEditor (assumption: chosen by hand, not measured).
 */
export const ENGLISH_LOANWORDS: readonly string[] = (
	'app apps asset assets backup beta blog boss bosses bot bots bug bugs build builds bullet cache challenge chat ' +
	'cheat cheats check click clickbait clip clips cloud coach collider colliders combo coop crafting crash cringe ' +
	'crossplay custom deadline debug demo deploy dev devs developer download drift email engine feature features ' +
	'feedback follow followers frame frames free freelance gameplay gamer gamers gaming glitch hacker hackers ' +
	'hardware hashtag hitbox hitboxes hype indie influencer item items joystick keyboard lag laptop layout level ' +
	'levels like likes link links live login lobby loot mesh merch mouse multiplayer offline online pack packs ' +
	'password patch ping pixel pixelart plugin plugins podcast post power powerup powerups prefab prefabs premium ' +
	'prompt prompts random ranking ragdoll release render review reviews roguelike sandbox score script scripts ' +
	'server servers setup shader shaders shooter short shorts show singleplayer skin skins smartphone software ' +
	'spawn speedrun spoiler sponsor sprite sprites startup stream streamer streamers streaming tablet target ' +
	'tileset timing tip tips top trailer trending tutorial unboxing update updates upload vlog web website workflow ' +
	'youtuber youtubers'
).split(' ');
const ENGLISH_SET = new Set(ENGLISH_LOANWORDS);
/** English spelling hints in a Spanish text: digraphs and letters rare in Spanish, or a non-Spanish final letter. */
const ENGLISH_HINT = /(sh|th|ck|oo|ee|ph|w|k)|[^aeiounsdlrzy]$/;

/**
 * SC-023 `english`: in a Spanish transcript, a word of the list or a word with English spelling hints (sh, th, ck,
 * oo, ee, ph, w, k, or a final letter Spanish words do not end in). Never a function word or a word under 3 letters.
 * English and neutral transcripts have no loanword category.
 */
export function isEnglishWord(norm: string, lang: ScriptFixLanguage, stop: ReadonlySet<string>): boolean {
	if (lang !== 'es' || norm.length < 3 || stop.has(norm) || /\d/.test(norm)) return false;
	return ENGLISH_SET.has(norm) || ENGLISH_HINT.test(norm);
}

/** FNV-1a (32 bit) with a chosen offset basis, 8 hex digits. */
function fnv(s: string, basis: number): string {
	let h = basis >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** A 64-bit hash of a string (two FNV-1a passes with different bases), 16 hex digits. */
export function hash64(s: string): string {
	return fnv(s, 0x811c9dc5) + fnv(s, 0x1b873593);
}

// Per-language word lists of the transcript cleanup detector (spec 14 TC-011; docs/wp-notes/transcript-cleanup.md
// "Detector"). Sources: the research prototype that reproduced the user's cuts (private
// `.prproj-analysis/research/edits/mac/common.py` `STRICT_FILLERS` / `FILLERS`, `autocut.py` `STOPW`), the spec's
// lists, the filler census of the user's Premiere transcripts and the literature summarised in
// `research/cutsurvey/FINDINGS.md` §4 (Spanish filled pauses /e/ and /m/; "este" as a Latin American marker).
// English lists: JasperEditor's `DEFAULT_FILLERS` (kept verbatim for `transcript.removeFillers`) plus common English
// discourse markers (labelled an assumption: not measured on this user's data). Pure.
import { DEFAULT_FILLERS } from '../captions/sequence-transcript.ts';

/** Words of one language the detector uses. Every entry is in `cleanupNorm` form. */
export type CleanupLanguageLists = {
	/**
	 * Vocalic (filled-pause) fillers: always fillers, high confidence. Spanish follows the prototype's
	 * `STRICT_FILLERS` (it reproduced the user's cuts): the bare preposition "a" is not in it (drawn out it is caught by
	 * the drawn-out vowel rule), "e" / "ee" / "eee" / "aa" / "aah" and "m" are.
	 */
	fillers: readonly string[];
	/**
	 * Lexical markers (one or more words): removed only when a whole phrase between pauses consists of them,
	 * flagged for review at a clause start, never touched inside a sentence.
	 */
	markers: readonly string[];
	/** Repeats that are emphasis or onomatopoeia, never stutters ("no no", "sí sí", "ta ta ta"). Single words. */
	allow: readonly string[];
	/** Function words: not content words for restarts, retakes and off-script similarity. */
	stopWords: readonly string[];
	/** Single-vowel words a speaker draws out ("yyy", "queee"): fillers when held longer than the threshold. */
	vowels: readonly string[];
	/** Text the recogniser invents over non-speech (TC-003): flagged when it sits over non-speech. */
	hallucinations: readonly string[];
	/**
	 * Cardinal number words (digits count without a list): a restart or retake must re-say every number of the words
	 * it removes — "me quedan nueve días" is not a retake of "me quedan seis días". "uno" / "one" are left out (also
	 * pronouns).
	 */
	numbers: readonly string[];
};

const ES: CleanupLanguageLists = {
	fillers: [
		'eh',
		'em',
		'emm',
		'ehm',
		'mm',
		'mmm',
		'hmm',
		'mhm',
		'ah',
		'aah',
		'eeh',
		'ehh',
		'uh',
		'um',
		'eee',
		'ee',
		'aa',
		'm',
		'e',
	],
	// spec 14 TC-011 list + the prototype's standalone-phrase tokens (`autocut.py`: FILLERS ∪ a, ver, ok, okay, si, no)
	markers: [
		'este',
		'esto',
		'o sea',
		'osea',
		'pues',
		'bueno',
		'vale',
		'tipo',
		'en plan',
		'a ver',
		'es decir',
		'digamos',
		'sabes',
		'no',
		'si',
		'nada',
		'vamos',
		'ok',
		'okay',
		'ay',
		'oh',
		'a',
		'ver',
	],
	allow: [
		'no',
		'si',
		'ta',
		'ja',
		'je',
		'para',
		'tanto',
		'muy',
		'mas',
		'bien',
		'venga',
		'dale',
		'bum',
		'pum',
		'toc',
	],
	// prototype `autocut.py` STOPW (restarts use their own subset, `RESTART_STOP_ES`)
	stopWords: [
		'de',
		'la',
		'el',
		'que',
		'en',
		'y',
		'a',
		'los',
		'las',
		'un',
		'una',
		'es',
		'se',
		'lo',
		'con',
		'por',
		'para',
		'del',
		'al',
		'me',
		'te',
		'no',
		'si',
		'mi',
		'tu',
		'su',
		'o',
		'le',
		'les',
		'ya',
		'muy',
		'mas',
		'pero',
		'como',
		'esta',
		'este',
		'esto',
		'eso',
		'hay',
		'fue',
		'son',
	],
	vowels: ['a', 'e', 'i', 'o', 'u', 'y'],
	hallucinations: [
		'subtitulos realizados por la comunidad de amaraorg',
		'subtitulos por la comunidad de amaraorg',
		'gracias por ver el video',
		'gracias por ver',
		'gracias',
		'suscribete',
	],
	numbers: [
		'cero',
		'dos',
		'tres',
		'cuatro',
		'cinco',
		'seis',
		'siete',
		'ocho',
		'nueve',
		'diez',
		'once',
		'doce',
		'trece',
		'catorce',
		'quince',
		'dieciseis',
		'diecisiete',
		'dieciocho',
		'diecinueve',
		'veinte',
		'veintiun',
		'veintiuno',
		'veintidos',
		'veintitres',
		'veinticuatro',
		'veinticinco',
		'veintiseis',
		'veintisiete',
		'veintiocho',
		'veintinueve',
		'treinta',
		'cuarenta',
		'cincuenta',
		'sesenta',
		'setenta',
		'ochenta',
		'noventa',
		'cien',
		'ciento',
		'doscientos',
		'trescientos',
		'cuatrocientos',
		'quinientos',
		'seiscientos',
		'setecientos',
		'ochocientos',
		'novecientos',
		'mil',
		'millon',
		'millones',
	],
};

/** The restart rule's stop words (prototype `autocut.py` `detect`, rule 2): a subset of `ES.stopWords`. */
const RESTART_STOP_ES = [
	'de',
	'la',
	'el',
	'que',
	'en',
	'y',
	'a',
	'los',
	'las',
	'un',
	'una',
	'es',
	'se',
	'lo',
	'con',
	'por',
	'para',
	'del',
	'al',
	'me',
	'te',
	'no',
	'si',
	'mi',
	'tu',
	'su',
] as const;

const EN: CleanupLanguageLists = {
	fillers: [...DEFAULT_FILLERS, 'uhh', 'umm', 'hm', 'mmm', 'ahh', 'eh'],
	markers: [
		'you know',
		'i mean',
		'like',
		'so',
		'well',
		'okay',
		'ok',
		'right',
		'basically',
		'actually',
		'literally',
		'kind of',
		'sort of',
		'anyway',
		'yeah',
		'oh',
	],
	allow: ['no', 'yes', 'very', 'really', 'so', 'ha', 'bye', 'go', 'boom', 'knock', 'tick', 'tock', 'bang'],
	stopWords: [
		'the',
		'a',
		'an',
		'and',
		'or',
		'but',
		'of',
		'to',
		'in',
		'on',
		'at',
		'for',
		'with',
		'by',
		'from',
		'is',
		'are',
		'was',
		'were',
		'be',
		'it',
		'its',
		'this',
		'that',
		'these',
		'those',
		'i',
		'you',
		'he',
		'she',
		'we',
		'they',
		'me',
		'my',
		'your',
		'our',
		'their',
		'his',
		'her',
		'not',
		'no',
		'so',
		'as',
		'if',
		'then',
		'there',
		'here',
		'do',
		'does',
		'did',
		'have',
		'has',
		'had',
		'just',
		'very',
	],
	vowels: ['a', 'i', 'o', 'u', 'e'],
	hallucinations: ['thanks for watching', 'thank you for watching', 'please subscribe', 'thank you'],
	numbers: [
		'zero',
		'two',
		'three',
		'four',
		'five',
		'six',
		'seven',
		'eight',
		'nine',
		'ten',
		'eleven',
		'twelve',
		'thirteen',
		'fourteen',
		'fifteen',
		'sixteen',
		'seventeen',
		'eighteen',
		'nineteen',
		'twenty',
		'thirty',
		'forty',
		'fifty',
		'sixty',
		'seventy',
		'eighty',
		'ninety',
		'hundred',
		'thousand',
		'million',
		'billion',
	],
};

const LISTS: Readonly<Record<string, CleanupLanguageLists>> = { es: ES, en: EN };
const RESTART_STOP: Readonly<Record<string, readonly string[]>> = { es: RESTART_STOP_ES, en: EN.stopWords };

/** Languages with built-in lists. */
export const CLEANUP_LANGUAGES = ['es', 'en'] as const;
export type CleanupLanguage = (typeof CLEANUP_LANGUAGES)[number];

/**
 * The list language of a transcript language tag (`es`, `es-MX`, `en-US`, `spa`…): its primary subtag when there are
 * built-in lists for it, else null (unknown / `und`: the union of every language's vocalic fillers and stop words,
 * no lexical markers — see `builtinLists`).
 */
export function cleanupLanguageOf(tag: string | null | undefined): CleanupLanguage | null {
	const t = (tag ?? '').trim().toLowerCase();
	const primary = t.split(/[-_]/)[0] ?? '';
	if (primary === 'es' || primary === 'spa' || primary === 'spanish') return 'es';
	if (primary === 'en' || primary === 'eng' || primary === 'english') return 'en';
	return null;
}

const uniq = (xs: readonly string[]) => [...new Set(xs)];

/** Built-in lists of a language (null: the language-neutral union described at `cleanupLanguageOf`). */
export function builtinLists(lang: CleanupLanguage | null): CleanupLanguageLists {
	if (lang) return LISTS[lang]!;
	return {
		fillers: uniq([...ES.fillers.filter((f) => f.length > 1), ...EN.fillers]),
		markers: [],
		allow: uniq([...ES.allow, ...EN.allow]),
		stopWords: uniq([...ES.stopWords, ...EN.stopWords]),
		vowels: [],
		hallucinations: uniq([...ES.hallucinations, ...EN.hallucinations]),
		numbers: uniq([...ES.numbers, ...EN.numbers]),
	};
}

/** Stop words of the restart rule (the prototype used a smaller Spanish set there). */
export function restartStopWords(lang: CleanupLanguage | null): readonly string[] {
	return lang ? RESTART_STOP[lang]! : builtinLists(null).stopWords;
}

/**
 * Normalised word for matching (prototype `common.py norm`): lower case, NFD, combining marks removed, then every
 * character outside `a-z 0-9 ñ` removed — so "¿Sí?" → "si", "Está" → "esta", "jue-" → "jue" (ñ decomposes to n + a
 * combining tilde first, so it reads as n, as in the prototype).
 */
export function cleanupNorm(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{Mn}/gu, '')
		.replace(/[^a-z0-9ñ]+/g, '');
}

/** Number words (normalised) and their values, Spanish and English, so "9" and "nueve" match. */
const NUMBER_VALUES: Readonly<Record<string, number>> = Object.fromEntries(
	[
		'cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve veinte',
		'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty',
	].flatMap((l) => l.split(' ').map((w, v) => [w, v] as const)),
);

/**
 * Spanish-aware sound folding of a normalised word for matching ASR variants: silent h, b/v, c/z/s before e/i,
 * qu/k/c, ll/y, w/u, final y as i.
 */
function soundFold(t: string): string {
	return t
		.replace(/(^|[^c])h/g, '$1')
		.replace(/v/g, 'b')
		.replace(/w/g, 'u')
		.replace(/ll/g, 'y')
		.replace(/qu/g, 'k')
		.replace(/c([ei])/g, 's$1')
		.replace(/z/g, 's')
		.replace(/c/g, 'k')
		.replace(/y$/, 'i');
}

/** Levenshtein distance (words are short; capped at 64 characters each). */
function editDistance(a: string, b: string): number {
	const x = a.slice(0, 64);
	const y = b.slice(0, 64);
	let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
	for (let i = 1; i <= x.length; i++) {
		const cur = [i];
		for (let j = 1; j <= y.length; j++)
			cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[y.length]!;
}

/**
 * Whether two normalised words are the same word as two decodes may write it: equal, the same number ("9" /
 * "nueve"), equal after `soundFold`, within a third of their length in edits ("Inunity" / "Unity", "vivecoder" /
 * "wavecoder", "pueda" / "puedo"; words of 4+ letters), or — for a cut-off word (`cut`) — a prefix of it.
 */
export function sameWord(a: string, b: string, cut = false): boolean {
	if (a === b) return true;
	const na = /^\d+$/.test(a) ? Number(a) : NUMBER_VALUES[a];
	const nb = /^\d+$/.test(b) ? Number(b) : NUMBER_VALUES[b];
	if (na !== undefined && na === nb) return true;
	const fa = soundFold(a);
	const fb = soundFold(b);
	if (fa === fb) return true;
	if (cut && fa.length >= 3 && fb.startsWith(fa)) return true;
	if (Math.min(fa.length, fb.length) < 4) return false;
	return editDistance(fa, fb) <= Math.max(fa.length, fb.length) / 3;
}

/** A list entry ("o sea", "¿sabes?") as normalised tokens (empty entries vanish). */
export function phraseTokens(entry: string): string[] {
	return entry
		.split(/\s+/)
		.map(cleanupNorm)
		.filter((t) => t.length > 0);
}

// Phonetic key and similarity (spec 17 SC-012). Ported from the scriptfix spike (`sfcore.py` `pkey`, `wlev`, `psim`;
// FINDINGS §2.2): a Spanish key with English digraphs, a weighted Levenshtein distance between keys with cheap
// substitutions / insertions for typical recognition and accent confusions, and psim = 1 − distance / longest key.
// English uses the same key without the Spanish c / g / qu / gu / ll rules; other languages compare the normalised
// strings with the plain Levenshtein distance (no key, unit costs). Pure; symmetric; in [0, 1].
import { type ScriptFixLanguage, spokenForm } from './text.ts';

const EN_DIGRAPHS: ReadonlyArray<[string, string]> = [
	['sh', 'X'],
	['th', 't'],
	['ph', 'f'],
	['ee', 'i'],
	['oo', 'u'],
	['ck', 'k'],
	['tion', 'sion'],
];

function replaceAll(s: string, a: string, b: string): string {
	return s.split(a).join(b);
}

/**
 * The phonetic key of a normalised token (SC-012). Spanish: digits → words; sh→X, th→t, ph→f, ee→i, oo→u, ck→k,
 * tion→sion; ch→X, ll→y, rr→r; qu(e/i)→k (other qu→k), gu(e/i)→g, g(e/i)→j, c(e/i)→s, other c→k; z→s, v→b, w→u,
 * x→ks, h dropped; y not before a vowel → i; doubled letters collapsed. English: the same without ll→y, qu, gu,
 * g(e/i), c(e/i) (every c → k). The neutral fallback has no key (the token itself).
 */
export function phoneticKey(norm: string, lang: ScriptFixLanguage): string {
	if (lang === null) return norm;
	let w = spokenForm(norm, lang);
	for (const [a, b] of EN_DIGRAPHS) w = replaceAll(w, a, b);
	w = replaceAll(w, 'ch', 'X');
	if (lang === 'es') w = replaceAll(w, 'll', 'y');
	w = replaceAll(w, 'rr', 'r');
	if (lang === 'es') {
		w = w.replace(/qu([ei])/g, 'k$1');
		w = replaceAll(w, 'qu', 'k');
		w = w.replace(/gu([ei])/g, 'g$1');
		w = w.replace(/g([ei])/g, 'j$1');
		w = w.replace(/c([ei])/g, 's$1');
	}
	w = w.replace(/c/g, 'k').replace(/z/g, 's').replace(/v/g, 'b').replace(/w/g, 'u').replace(/x/g, 'ks');
	w = w.replace(/h/g, '');
	w = w.replace(/y(?![aeiou])/g, 'i');
	w = w.replace(/(.)\1+/g, '$1');
	return w;
}

/** Cheap substitutions between key letters (SC-012); every other substitution costs 1. Symmetric. */
export const PSIM_SUBSTITUTION_COSTS: ReadonlyArray<readonly [string, string, number]> = [
	['j', 'y', 0.3],
	['i', 'y', 0.3],
	['i', 'e', 0.5],
	['o', 'u', 0.5],
	['d', 't', 0.5],
	['g', 'k', 0.5],
	['b', 'p', 0.5],
	['n', 'm', 0.5],
	['s', 'X', 0.5],
	['j', 'X', 0.4],
	['y', 'X', 0.4],
	['r', 'l', 0.6],
	['k', 'j', 0.6],
	['f', 'j', 0.6],
];
/** Cheap insertions / deletions of key letters (SC-012); every other letter costs 1. */
export const PSIM_INDEL_COSTS: Readonly<Record<string, number>> = {
	s: 0.5,
	d: 0.5,
	n: 0.6,
	e: 0.6,
	i: 0.6,
	u: 0.6,
	a: 0.7,
	o: 0.7,
	r: 0.7,
};

// Costs are kept in integer tenths so the distance is exact (and exactly symmetric) in floating point, in tables by
// character code (keys are ASCII: a-z, 0-9 and X).
const SUB_TENTHS = new Uint8Array(128 * 128).fill(10);
for (let c = 0; c < 128; c++) SUB_TENTHS[c * 128 + c] = 0;
for (const [a, b, c] of PSIM_SUBSTITUTION_COSTS) {
	SUB_TENTHS[a.charCodeAt(0) * 128 + b.charCodeAt(0)] = Math.round(c * 10);
	SUB_TENTHS[b.charCodeAt(0) * 128 + a.charCodeAt(0)] = Math.round(c * 10);
}
const INDEL_TENTHS = new Uint8Array(128).fill(10);
for (const [k, v] of Object.entries(PSIM_INDEL_COSTS)) INDEL_TENTHS[k.charCodeAt(0)] = Math.round(v * 10);
const subCost = (a: number, b: number) => (a === b ? 0 : a < 128 && b < 128 ? SUB_TENTHS[a * 128 + b]! : 10);
const indelCost = (c: number) => (c < 128 ? INDEL_TENTHS[c]! : 10);

let rowA = new Float64Array(64);
let rowB = new Float64Array(64);
let codesB = new Int32Array(64);
let delB = new Float64Array(64);

/**
 * Weighted Levenshtein distance of two keys with the SC-012 cost tables, in tenths (`weighted: false`: unit costs,
 * still in tenths). Stops early with +Infinity once every entry of a row exceeds `limit` (the distance can only grow).
 */
function keyDistanceTenths(
	a: string,
	b: string,
	weighted: boolean,
	limit = Number.POSITIVE_INFINITY,
): number {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) {
		const r = n === 0 ? b : a;
		let s = 0;
		for (let k = 0; k < r.length; k++) s += weighted ? indelCost(r.charCodeAt(k)) : 10;
		return s;
	}
	if (rowA.length < m + 1) {
		rowA = new Float64Array(2 * (m + 1));
		rowB = new Float64Array(2 * (m + 1));
		codesB = new Int32Array(2 * (m + 1));
		delB = new Float64Array(2 * (m + 1));
	}
	let prev = rowA;
	let cur = rowB;
	prev[0] = 0;
	for (let j = 1; j <= m; j++) {
		const c = b.charCodeAt(j - 1);
		codesB[j] = c;
		delB[j] = weighted ? indelCost(c) : 10;
		prev[j] = prev[j - 1]! + delB[j]!;
	}
	for (let i = 1; i <= n; i++) {
		const ca = a.charCodeAt(i - 1);
		const da = weighted ? indelCost(ca) : 10;
		cur[0] = prev[0]! + da;
		let rowMin = cur[0]!;
		for (let j = 1; j <= m; j++) {
			const cb = codesB[j]!;
			const sub = ca === cb ? 0 : weighted ? subCost(ca, cb) : 10;
			const x = prev[j - 1]! + sub;
			const y = prev[j]! + da;
			const z = cur[j - 1]! + delB[j]!;
			const v = x < y ? (x < z ? x : z) : y < z ? y : z;
			cur[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > limit) return Number.POSITIVE_INFINITY;
		const t = prev;
		prev = cur;
		cur = t;
	}
	return prev[m]!;
}

/** Most cached keys / similarities before a cache is cleared (bounded memory on long inputs). */
const CACHE_LIMIT = 200_000;
const KEY_CACHE: Record<string, Map<string, string>> = { es: new Map(), en: new Map(), '*': new Map() };

/** `phoneticKey` with a bounded per-language cache. */
export function cachedKey(norm: string, lang: ScriptFixLanguage): string {
	const cache = KEY_CACHE[lang ?? '*']!;
	let k = cache.get(norm);
	if (k === undefined) {
		if (cache.size >= CACHE_LIMIT) cache.clear();
		k = phoneticKey(norm, lang);
		cache.set(norm, k);
	}
	return k;
}

/**
 * Phonetic similarity of two normalised strings (spaces removed by the caller; merges compare concatenations) in
 * [0, 1] (SC-012): 1 for equal strings, 0.95 for equal keys, else 1 − weighted distance / longest key. The neutral
 * fallback: 1 − Levenshtein distance / longest string.
 */
export function psim(a: string, b: string, lang: ScriptFixLanguage): number {
	if (a === b) return 1;
	const ka = cachedKey(a, lang);
	const kb = cachedKey(b, lang);
	if (lang !== null && ka === kb) return 0.95;
	const len = Math.max(ka.length, kb.length);
	if (len === 0) return 0;
	const s = 1 - keyDistanceTenths(ka, kb, lang !== null) / (10 * len);
	return s > 0 ? s : 0;
}

/** Cheapest insertion / deletion in the tables: a lower bound of the distance per letter of length difference. */
export const PSIM_MIN_INDEL = Math.min(1, ...Object.values(PSIM_INDEL_COSTS));

/**
 * `psim(a, b)` when it can reach `min`, else 0 without computing the distance: a key length difference d costs at
 * least d × the cheapest insertion, so psim ≤ 1 − d · PSIM_MIN_INDEL / longest key (exact pruning, same result as psim).
 */
export function psimAtLeast(a: string, b: string, lang: ScriptFixLanguage, min: number): number {
	if (a === b) return 1;
	const ka = cachedKey(a, lang);
	const kb = cachedKey(b, lang);
	if (lang !== null && ka === kb) return 0.95;
	const len = Math.max(ka.length, kb.length);
	if (len === 0) return 0;
	if (1 - (Math.abs(ka.length - kb.length) * PSIM_MIN_INDEL) / len < min) return 0;
	const d = keyDistanceTenths(ka, kb, lang !== null, (1 - min) * 10 * len + 1e-9);
	if (d === Number.POSITIVE_INFINITY) return 0;
	const s = 1 - d / (10 * len);
	return s > 0 ? s : 0;
}

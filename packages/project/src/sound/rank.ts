// Sound ranking (spec 12 §2.1 "Ranking"): one pure, deterministic function shared by the engine's search route, the
// Sound Library panel, placement rotation and the planner. Entries and descriptors are typed structurally here; the
// engine's `SoundEntry` (packages/api) conforms.
//
// Score (0…1, higher is better) = weighted mean of the parts that apply, minus a rotation penalty:
//   text match (weight 3, with a query) · type fit (2, with a visual kind or types) · duration fit (1) ·
//   judge score (1) · licence preference (0.75) · similarity (3, with `similarTo`).
// Real recordings (starter kit, packs, user folders) always rank above Jasper Synth sounds (spec 12 §0); with a query,
// sounds whose title names more of its words (exactly or by prefix) come next, so a title match always outranks a
// match through a type or synonym ("punch" finds "Punch" before "Crunchy impact", typed hit); then by score, then by
// id. Filters remove entries before scoring. Decisions and thresholds: wp-note "WP1.1a".
import { licensePreference, passesCommercialSafeFilter } from './license.ts';
import {
	isSoundTypeId,
	SOUND_TYPES,
	type SoundAlign,
	type SoundTypeId,
	synonymType,
	tokenizeSoundText,
	typeFitForVisualKind,
	typesInTokens,
	type VisualKind,
} from './taxonomy.ts';

/** The descriptors ranking reads (a subset of `@jasper/audio-fx` `SoundDescriptors`; absent = unknown). */
export interface RankDescriptors {
	durationSec: number;
	peakSec?: number;
	riseMs?: number;
	centroidHz?: number;
	below150Share?: number;
	above6kShare?: number;
	flatness?: number;
	/** 7 octave bands, 125 Hz … 8 kHz, dBFS. */
	octaveBandsDb?: readonly number[];
}

/** A library sound as ranking sees it (spec 12 §2.1 `SoundEntry`, structurally). */
export interface RankableSound {
	id: string;
	title: string;
	tags?: readonly string[];
	types: readonly string[];
	/** `starter`, `pack`, `folder` (real recordings) or `synth`. */
	source: { type: string };
	license: string;
	descriptors: RankDescriptors;
	judge?: { ok: boolean; score: number } | null;
}

export type LengthFilter = 'short' | 'medium' | 'long';
export type ToneFilter = 'dark' | 'bright';
export type AttackFilter = 'punchy' | 'soft';
export type WeightFilter = 'light' | 'heavy';
export type TextureFilter = 'clean' | 'noisy';
export type LicenseFilter = 'any' | 'commercial-safe';

export interface SoundRankRequest {
	/** Free text: matched against titles, tags and types, with type synonyms (`swoosh` finds whooshes). */
	query?: string;
	/** Keep only sounds of one of these types (ids or synonyms). */
	types?: readonly string[];
	/** The visual event the sound is for: types that suit it rank higher. */
	visualKind?: VisualKind;
	/** Length of the cue window (a transition, a build before a hero), seconds: windowed types should fit it. */
	windowSec?: number;
	/** Alignment used to measure a sound's lead into the window (default: the type's `defaultAlign`). */
	align?: SoundAlign;
	length?: LengthFilter;
	tone?: ToneFilter;
	attack?: AttackFilter;
	weight?: WeightFilter;
	texture?: TextureFilter;
	/** Default `commercial-safe` (the panel's default; spec 12 §2.7). */
	license?: LicenseFilter;
	/** Rank by descriptor similarity to this sound (its own id is left out). */
	similarTo?: { id?: string; descriptors: RankDescriptors };
	/** At most this many results (1…10 000; default all). */
	limit?: number;
}

export interface SoundRankContext {
	/** Sound ids already used near the target, nearest (or most recent) first: they rank lower (rotation). */
	usedNearby?: readonly string[];
}

/** Each part 0…1; null = did not apply to this request. `rotation` is the penalty subtracted. */
export interface RankParts {
	text: number | null;
	typeFit: number | null;
	durationFit: number;
	judge: number;
	license: number;
	/** 1 = real recording, 0 = Jasper Synth (a tier, not a weight). */
	source: number;
	similarity: number | null;
	rotation: number;
	/**
	 * Share of the query words a title word matches exactly or by prefix (0…1; null without a query): a tier, like
	 * `source`, ranked before the score.
	 */
	titleMatch: number | null;
}

export interface RankedSound<T extends RankableSound = RankableSound> {
	entry: T;
	score: number;
	parts: RankParts;
}

export const RANK_WEIGHTS = {
	text: 3,
	typeFit: 2,
	durationFit: 1,
	judge: 1,
	license: 0.75,
	similarity: 3,
} as const;
/** Penalty for a sound used right next to the target; halves, thirds… for later positions; capped at 0.6. */
export const ROTATION_PENALTY = 0.3;
const MAX_ROTATION_PENALTY = 0.6;

/**
 * Descriptor filter thresholds (the Refine pills). `short` < 0.3 s ≤ `medium` ≤ 1.5 s < `long` (spec 12); the others
 * are decisions (wp-note "WP1.1a"): a sound between the two limits of a pair matches neither.
 */
export const DESCRIPTOR_FILTERS = {
	length: { shortBelowSec: 0.3, longAboveSec: 1.5 },
	tone: { darkMaxHz: 1000, brightMinHz: 3000 },
	attack: { punchyMaxMs: 10, softMinMs: 50 },
	weight: { lightMaxBelow150: 0.05, heavyMinBelow150: 0.3 },
	texture: { cleanMaxFlatness: 0.1, noisyMinFlatness: 0.25 },
} as const;

const STOPWORDS: ReadonlySet<string> = new Set([
	'a',
	'an',
	'the',
	'of',
	'and',
	'or',
	'for',
	'with',
	'sound',
	'sounds',
	'sfx',
	'fx',
	'effect',
	'effects',
	'audio',
]);

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const REAL_SOURCES: ReadonlySet<string> = new Set(['starter', 'pack', 'folder']);

/** A sound passes the descriptor filters of the request (unknown descriptors fail a requested filter). */
export function passesDescriptorFilters(d: RankDescriptors, req: SoundRankRequest): boolean {
	const F = DESCRIPTOR_FILTERS;
	if (req.length) {
		const s = d.durationSec;
		if (!fin(s)) return false;
		if (req.length === 'short' && !(s < F.length.shortBelowSec)) return false;
		if (req.length === 'medium' && !(s >= F.length.shortBelowSec && s <= F.length.longAboveSec)) return false;
		if (req.length === 'long' && !(s > F.length.longAboveSec)) return false;
	}
	if (req.tone) {
		const c = d.centroidHz;
		if (!fin(c)) return false;
		if (req.tone === 'dark' && !(c <= F.tone.darkMaxHz)) return false;
		if (req.tone === 'bright' && !(c >= F.tone.brightMinHz)) return false;
	}
	if (req.attack) {
		const r = d.riseMs;
		if (!fin(r)) return false;
		if (req.attack === 'punchy' && !(r <= F.attack.punchyMaxMs)) return false;
		if (req.attack === 'soft' && !(r >= F.attack.softMinMs)) return false;
	}
	if (req.weight) {
		const b = d.below150Share;
		if (!fin(b)) return false;
		if (req.weight === 'light' && !(b <= F.weight.lightMaxBelow150)) return false;
		if (req.weight === 'heavy' && !(b >= F.weight.heavyMinBelow150)) return false;
	}
	if (req.texture) {
		const f = d.flatness;
		if (!fin(f)) return false;
		if (req.texture === 'clean' && !(f <= F.texture.cleanMaxFlatness)) return false;
		if (req.texture === 'noisy' && !(f >= F.texture.noisyMinFlatness)) return false;
	}
	return true;
}

/** Type ids named by a list of ids or synonyms (unknown words dropped). */
export function resolveTypeNames(names: readonly string[]): SoundTypeId[] {
	const out: SoundTypeId[] = [];
	for (const n of names) {
		if (typeof n !== 'string') continue;
		const k = n.trim().toLowerCase();
		const t: SoundTypeId | undefined = isSoundTypeId(k)
			? k
			: (synonymType(k) ?? typesInTokens(tokenizeSoundText(k))[0]);
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}

/**
 * Descriptor distance between two sounds (0 = identical), over the features both have: log duration (decades),
 * log centroid (per 2 octaves), log rise, the band shares and flatness (×2), and the octave-band shape (level
 * removed, per 12 dB). Pure; NaN-free.
 */
export function descriptorDistance(a: RankDescriptors, b: RankDescriptors): number {
	let sum = 0;
	let weight = 0;
	const add = (x: number | undefined, y: number | undefined, f: (v: number) => number, w: number) => {
		if (!fin(x) || !fin(y)) return;
		const d = f(x) - f(y);
		if (!Number.isFinite(d)) return;
		sum += w * d * d;
		weight += w;
	};
	add(a.durationSec, b.durationSec, (v) => Math.log10(Math.max(v, 1e-3)), 1);
	add(a.centroidHz, b.centroidHz, (v) => Math.log2(Math.max(v, 1)) / 2, 1);
	add(a.riseMs, b.riseMs, (v) => Math.log10(Math.max(v, 0) + 1), 0.5);
	add(a.below150Share, b.below150Share, (v) => 2 * v, 1);
	add(a.above6kShare, b.above6kShare, (v) => 2 * v, 1);
	add(a.flatness, b.flatness, (v) => 2 * v, 1);
	const sa = bandShape(a.octaveBandsDb);
	const sb = bandShape(b.octaveBandsDb);
	if (sa && sb) {
		let s = 0;
		for (let i = 0; i < 7; i++) s += ((sa[i]! - sb[i]!) / 12) ** 2;
		sum += s / 7;
		weight += 1;
	}
	return weight > 0 ? Math.sqrt(sum / weight) : Number.POSITIVE_INFINITY;
}

function bandShape(bands: readonly number[] | undefined): number[] | null {
	if (!Array.isArray(bands) || bands.length !== 7 || !bands.every(fin)) return null;
	const mean = bands.reduce((s, v) => s + v, 0) / 7;
	return bands.map((v) => v - mean);
}

const gauss = (x: number, sigma: number) => Math.exp(-(x * x) / (2 * sigma * sigma));

/** The type whose length rules apply: the first requested type it has, else its best type for the visual kind. */
function fitType(
	entryTypes: SoundTypeId[],
	req: SoundRankRequest,
	wanted: SoundTypeId[],
): SoundTypeId | null {
	for (const t of wanted) if (entryTypes.includes(t)) return t;
	if (req.visualKind) {
		let best: SoundTypeId | null = null;
		let bestFit = 0;
		for (const t of entryTypes) {
			const f = typeFitForVisualKind(t, req.visualKind);
			if (f > bestFit) {
				best = t;
				bestFit = f;
			}
		}
		if (best) return best;
	}
	return entryTypes[0] ?? null;
}

/** Duration fit 0…1 of a sound for a type (and a window, when the type has windowed lengths). Pure. */
export function durationFit(
	d: RankDescriptors,
	type: SoundTypeId | null,
	windowSec?: number,
	align?: SoundAlign,
): number {
	const dur = d.durationSec;
	if (!fin(dur) || dur <= 0) return 0;
	const info = isSoundTypeId(type) ? SOUND_TYPES[type] : null;
	const fit = info?.durationFit ?? { minSec: 0.05, idealSec: 1, maxSec: 10, window: null };
	if (fin(windowSec) && windowSec > 0 && fit.window) {
		const a = align ?? info?.defaultAlign ?? 'peak';
		// `lead` with peak alignment = the run-up to the peak; with end alignment the whole sound leads in.
		const lead = fit.window === 'lead' && a === 'peak' ? (d.peakSec ?? dur) : dur;
		const measured = Math.max(lead, 1e-3);
		return round6(gauss(Math.log(measured / windowSec), 0.4));
	}
	let s = gauss(Math.log(dur / fit.idealSec), 0.8);
	if (dur < fit.minSec || dur > fit.maxSec) s *= 0.5;
	return round6(s);
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** At most this many distinct query words are matched (a pasted paragraph must not cost a pass per word). */
export const MAX_QUERY_TOKENS = 16;

type QueryPlan = {
	/** Distinct tokens left after stopwords (first occurrence kept, at most MAX_QUERY_TOKENS), each with the type its synonym phrase names (if any). */
	tokens: { token: string; type: SoundTypeId | null }[];
	/**
	 * How each vocabulary word (by id) matches the tokens, computed on first use: 2 bits per token (2 = the same word,
	 * 1 = starts with a token of 3+ letters, 0 = no match); −1 = not computed yet. A library has far fewer distinct
	 * words than entries, so most words cost one array read.
	 */
	byWord: Int32Array;
};

/**
 * Word ids of every word ranking has seen (title and tag tokens). Bounded: past MAX_VOCABULARY words, new words get
 * no id and are matched as strings every time.
 */
const VOCABULARY = new Map<string, number>();
const VOCABULARY_WORDS: string[] = [];
const MAX_VOCABULARY = 200_000;

function wordIds(words: readonly string[]): Int32Array {
	const ids = new Int32Array(words.length);
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		let id = VOCABULARY.get(w);
		if (id === undefined) {
			if (VOCABULARY_WORDS.length >= MAX_VOCABULARY) id = -1;
			else {
				id = VOCABULARY_WORDS.length;
				VOCABULARY_WORDS.push(w);
				VOCABULARY.set(w, id);
			}
		}
		ids[i] = id;
	}
	return ids;
}

/** Plans of recent queries (the same query string gives the same plan object, so text scores can be reused). */
const PLAN_MEMO = new Map<string, QueryPlan | null>();
const PLAN_MEMO_SIZE = 32;

function planQuery(query: string | undefined): QueryPlan | null {
	if (typeof query !== 'string') return null;
	if (PLAN_MEMO.has(query)) return PLAN_MEMO.get(query)!;
	const plan = makePlan(query);
	if (PLAN_MEMO.size >= PLAN_MEMO_SIZE) PLAN_MEMO.delete(PLAN_MEMO.keys().next().value as string);
	PLAN_MEMO.set(query, plan);
	return plan;
}

function makePlan(query: string): QueryPlan | null {
	const raw = tokenizeSoundText(query).filter((t) => !STOPWORDS.has(t));
	if (raw.length === 0) return null;
	// The type each token names: synonym phrases (up to 3 words, longest first) claim their tokens.
	const typed = new Array<SoundTypeId | null>(raw.length).fill(null);
	for (let i = 0; i < raw.length; i++) {
		for (let len = Math.min(3, raw.length - i); len >= 1; len--) {
			const phrase = raw.slice(i, i + len).join(' ');
			const t = synonymType(phrase);
			if (t && typed.slice(i, i + len).every((x) => x === null)) {
				for (let j = i; j < i + len; j++) typed[j] = t;
				break;
			}
		}
	}
	const tokens: QueryPlan['tokens'] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length && tokens.length < MAX_QUERY_TOKENS; i++) {
		const token = raw[i]!;
		if (seen.has(token)) continue;
		seen.add(token);
		tokens.push({ token, type: typed[i]! });
	}
	return { tokens, byWord: new Int32Array(0) };
}

/**
 * What ranking reads of an entry's text, computed once per entry object (entries are treated as immutable; a changed
 * title, tags or types array is noticed and recomputed).
 */
type EntryText = {
	title: unknown;
	tagsRef: unknown;
	tagsLen: number;
	typesRef: unknown;
	typesLen: number;
	titleTokens: string[];
	tagTokens: string[];
	/** Vocabulary ids of the title and tag tokens (−1: no id). */
	titleIds: Int32Array;
	tagIds: Int32Array;
	/** Types its title and tags name (computed on first use). */
	namedTypes: SoundTypeId[] | null;
	/** Its known type ids. */
	entryTypes: SoundTypeId[];
	/** The text score of the last query plan it was scored against (one slot). */
	scoredPlan: QueryPlan | null;
	scored: { score: number; titleMatch: number } | null;
};
const ENTRY_TEXT = new WeakMap<object, EntryText>();

function entryText(e: RankableSound): EntryText {
	const tags = e.tags;
	const types = e.types;
	const tagsLen = Array.isArray(tags) ? tags.length : -1;
	const typesLen = Array.isArray(types) ? types.length : -1;
	const hit = ENTRY_TEXT.get(e);
	if (
		hit &&
		hit.title === e.title &&
		hit.tagsRef === tags &&
		hit.tagsLen === tagsLen &&
		hit.typesRef === types &&
		hit.typesLen === typesLen
	)
		return hit;
	const tagTokens: string[] = [];
	if (Array.isArray(tags))
		for (const t of tags) if (typeof t === 'string') tagTokens.push(...tokenizeSoundText(t));
	const titleTokens = tokenizeSoundText(e.title);
	const info: EntryText = {
		title: e.title,
		tagsRef: tags,
		tagsLen,
		typesRef: types,
		typesLen,
		titleTokens,
		tagTokens,
		titleIds: wordIds(titleTokens),
		tagIds: wordIds(tagTokens),
		namedTypes: null,
		entryTypes: (Array.isArray(types) ? types : []).filter(isSoundTypeId),
		scoredPlan: null,
		scored: null,
	};
	ENTRY_TEXT.set(e, info);
	return info;
}

function namedTypesOf(t: EntryText): SoundTypeId[] {
	if (!t.namedTypes) t.namedTypes = typesInTokens([...t.titleTokens, ...t.tagTokens]);
	return t.namedTypes;
}

/**
 * Licence class results by licence string (a library has a handful of distinct licences). `safe` = passes the
 * "Commercial-safe" filter (`passesCommercialSafeFilter`: the ShareAlike decision of spec 12 P6-E13 is its constant).
 */
const LICENSE_MEMO = new Map<string, { safe: boolean; preference: number }>();
function licenseInfo(license: unknown): { safe: boolean; preference: number } {
	if (typeof license !== 'string')
		return { safe: passesCommercialSafeFilter(license), preference: licensePreference(license) };
	let r = LICENSE_MEMO.get(license);
	if (!r) {
		if (LICENSE_MEMO.size >= 4096) LICENSE_MEMO.clear();
		r = { safe: passesCommercialSafeFilter(license), preference: licensePreference(license) };
		LICENSE_MEMO.set(license, r);
	}
	return r;
}

/**
 * Text match 0…1 (the mean over query tokens of their best field match) and the share of query tokens a title word
 * matches exactly or by prefix.
 */
function textScore(plan: QueryPlan, t: EntryText): { score: number; titleMatch: number } {
	if (t.scoredPlan === plan) return t.scored!;
	const r = computeTextScore(plan, t);
	t.scoredPlan = plan;
	t.scored = r;
	return r;
}

/** How a word matches the plan's tokens (2 bits per token). Never −1: no 2-bit group is ever 3. */
function matchWord(plan: QueryPlan, w: string): number {
	let m = 0;
	const tokens = plan.tokens;
	for (let k = 0; k < tokens.length; k++) {
		const token = tokens[k]!.token;
		if (w === token) m |= 2 << (2 * k);
		else if (token.length >= 3 && w.startsWith(token)) m |= 1 << (2 * k);
	}
	return m;
}

function wordMatch(plan: QueryPlan, id: number, w: string): number {
	if (id < 0) return matchWord(plan, w);
	let table = plan.byWord;
	if (id >= table.length) {
		const grown = new Int32Array(Math.max(1024, id + 1, Math.ceil(VOCABULARY_WORDS.length * 1.25)));
		grown.fill(-1);
		grown.set(table);
		plan.byWord = table = grown;
	}
	let m = table[id]!;
	if (m === -1) {
		m = matchWord(plan, w);
		table[id] = m;
	}
	return m;
}

/** Per-token scratch of computeTextScore (at most MAX_QUERY_TOKENS tokens; never re-entered). */
const BEST = new Float64Array(MAX_QUERY_TOKENS);
const TITLED = new Uint8Array(MAX_QUERY_TOKENS);

function computeTextScore(plan: QueryPlan, t: EntryText): { score: number; titleMatch: number } {
	const tokens = plan.tokens;
	const n = tokens.length;
	const entryTypes = t.entryTypes;
	for (let k = 0; k < n; k++) {
		const { token, type } = tokens[k]!;
		let best = 0;
		if (type) {
			if (entryTypes.includes(type)) best = 1;
			else if (namedTypesOf(t).includes(type)) best = 0.85;
		}
		if (entryTypes.includes(token as SoundTypeId)) best = Math.max(best, 1);
		BEST[k] = best;
		TITLED[k] = 0;
	}
	const titleIds = t.titleIds;
	const titleWords = t.titleTokens;
	for (let i = 0; i < titleIds.length; i++) {
		const m = wordMatch(plan, titleIds[i]!, titleWords[i]!);
		if (m === 0) continue;
		for (let k = 0; k < n; k++) {
			const v = (m >>> (2 * k)) & 3;
			if (v === 2) BEST[k] = Math.max(BEST[k]!, 1);
			else if (v === 1) BEST[k] = Math.max(BEST[k]!, 0.75);
			else continue;
			TITLED[k] = 1;
		}
	}
	const tagIds = t.tagIds;
	const tagWords = t.tagTokens;
	for (let i = 0; i < tagIds.length; i++) {
		const m = wordMatch(plan, tagIds[i]!, tagWords[i]!);
		if (m === 0) continue;
		for (let k = 0; k < n; k++) {
			const v = (m >>> (2 * k)) & 3;
			if (v === 2) BEST[k] = Math.max(BEST[k]!, 0.8);
			else if (v === 1) BEST[k] = Math.max(BEST[k]!, 0.6);
		}
	}
	let total = 0;
	let inTitle = 0;
	for (let k = 0; k < n; k++) {
		total += BEST[k]!;
		inTitle += TITLED[k]!;
	}
	return { score: round6(total / n), titleMatch: round6(inTitle / n) };
}

/** A request worked out once for many entries. */
type PreparedRequest = {
	wanted: SoundTypeId[];
	/** Types were asked for but none is known: nothing passes the type filter. */
	noKnownType: boolean;
	plan: QueryPlan | null;
	commercialSafeOnly: boolean;
	similarId: string | undefined;
};

function prepareRequest(request: SoundRankRequest): PreparedRequest {
	const wanted = request.types ? resolveTypeNames(request.types) : [];
	return {
		wanted,
		noKnownType: !!request.types && request.types.length > 0 && wanted.length === 0,
		plan: planQuery(request.query),
		commercialSafeOnly: (request.license ?? 'commercial-safe') === 'commercial-safe',
		similarId: request.similarTo?.id,
	};
}

/**
 * Which of rankSounds' filters an entry passes, as bits (one call per entry): `SOUND_FILTER_TYPES` (the type filter),
 * `SOUND_FILTER_LICENSE` (the licence filter), `SOUND_FILTER_REST` (descriptor pills, not the `similarTo` reference
 * itself and, with a query, a text match). `SOUND_FILTER_ALL` = in the ranking; `-1` = an entry rankSounds always skips.
 */
export const SOUND_FILTER_TYPES = 1;
export const SOUND_FILTER_LICENSE = 2;
export const SOUND_FILTER_REST = 4;
export const SOUND_FILTER_ALL = 7;

/**
 * The filters of {@link rankSounds}, split by dimension, for counting disjunctive facets in one pass: an entry is in
 * `rankSounds(entries, request)` exactly when all three bits are set; dropping a dimension from the request is the
 * same as ignoring its bit. Prepares the request once; the returned function never throws.
 */
export function soundFilterOf(request: SoundRankRequest = {}): (e: RankableSound) => number {
	const p = prepareRequest(request);
	return (e) => {
		if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.descriptors) return -1;
		return filterBits(e, entryText(e), licenseInfo(e.license), p, request);
	};
}

function filterBits(
	e: RankableSound,
	t: EntryText,
	lic: { safe: boolean },
	p: PreparedRequest,
	request: SoundRankRequest,
): number {
	let bits = 0;
	if (!p.noKnownType && (p.wanted.length === 0 || p.wanted.some((w) => t.entryTypes.includes(w))))
		bits |= SOUND_FILTER_TYPES;
	if (!p.commercialSafeOnly || lic.safe) bits |= SOUND_FILTER_LICENSE;
	if (
		passesDescriptorFilters(e.descriptors, request) &&
		!(p.similarId !== undefined && p.similarId === e.id) &&
		(!p.plan || textScore(p.plan, t).score > 0)
	)
		bits |= SOUND_FILTER_REST;
	return bits;
}

/** The context of one ranking call: the prepared request, rotation penalties and the reference. */
type RankRun = {
	request: SoundRankRequest;
	prep: PreparedRequest;
	used: Map<string, number>;
	sim: SoundRankRequest['similarTo'];
};

function rankRun(request: SoundRankRequest, ctx: SoundRankContext): RankRun {
	const used = new Map<string, number>();
	(ctx.usedNearby ?? []).forEach((id, i) => {
		if (typeof id !== 'string') return;
		used.set(id, Math.min(MAX_ROTATION_PENALTY, (used.get(id) ?? 0) + ROTATION_PENALTY / (1 + i)));
	});
	return { request, prep: prepareRequest(request), used, sim: request.similarTo };
}

const newParts = (): RankParts => ({
	text: null,
	typeFit: null,
	durationFit: 0,
	judge: 0,
	license: 0,
	source: 0,
	similarity: null,
	rotation: 0,
	titleMatch: null,
});

/** Scores an entry that passed every filter. */
function scoreEntry<T extends RankableSound>(
	e: T,
	info: EntryText,
	lic: { preference: number },
	run: RankRun,
): RankedSound<T> {
	const parts = newParts();
	const score = scoreInto(parts, e, info, lic, run);
	return { entry: e, score, parts };
}

/** Writes an entry's parts into `parts` (reusable) and returns its score. */
function scoreInto(
	parts: RankParts,
	e: RankableSound,
	info: EntryText,
	lic: { preference: number },
	run: RankRun,
): number {
	const { request, prep, used, sim } = run;
	const { wanted, plan } = prep;
	const entryTypes = info.entryTypes;
	const matched = plan ? textScore(plan, info) : null;
	const text = matched ? matched.score : null;
	let typeFit: number | null = null;
	if (request.visualKind || wanted.length) {
		let sum = 0;
		let n = 0;
		if (request.visualKind) {
			let best = 0;
			for (const t of entryTypes) best = Math.max(best, typeFitForVisualKind(t, request.visualKind));
			sum += best;
			n++;
		}
		if (wanted.length) {
			sum += entryTypes.includes(wanted[0]!) ? 1 : 0.9;
			n++;
		}
		typeFit = round6(sum / n);
	}
	const dFit = durationFit(
		e.descriptors,
		fitType(entryTypes, request, wanted),
		request.windowSec,
		request.align,
	);
	const judge = e.judge && fin(e.judge.score) ? Math.min(1, Math.max(0, e.judge.score)) : 0.5;
	const license = lic.preference;
	const similarity = sim ? round6(Math.exp(-descriptorDistance(sim.descriptors, e.descriptors))) : null;
	const rotation = round6(used.get(e.id) ?? 0);

	let num = RANK_WEIGHTS.durationFit * dFit + RANK_WEIGHTS.judge * judge + RANK_WEIGHTS.license * license;
	let den = RANK_WEIGHTS.durationFit + RANK_WEIGHTS.judge + RANK_WEIGHTS.license;
	if (text !== null) {
		num += RANK_WEIGHTS.text * text;
		den += RANK_WEIGHTS.text;
	}
	if (typeFit !== null) {
		num += RANK_WEIGHTS.typeFit * typeFit;
		den += RANK_WEIGHTS.typeFit;
	}
	if (similarity !== null) {
		num += RANK_WEIGHTS.similarity * similarity;
		den += RANK_WEIGHTS.similarity;
	}
	parts.text = text;
	parts.typeFit = typeFit;
	parts.durationFit = dFit;
	parts.judge = judge;
	parts.license = license;
	parts.source = REAL_SOURCES.has(e.source?.type) ? 1 : 0;
	parts.similarity = similarity;
	parts.rotation = rotation;
	parts.titleMatch = matched ? matched.titleMatch : null;
	return round6(num / den - rotation);
}

/** Sorts ranked sounds (real before synth, title words, score, id) and applies the request's limit. */
function finish<T extends RankableSound>(out: RankedSound<T>[], request: SoundRankRequest): RankedSound<T>[] {
	out.sort(
		(a, b) =>
			b.parts.source - a.parts.source ||
			(b.parts.titleMatch ?? 0) - (a.parts.titleMatch ?? 0) ||
			b.score - a.score ||
			(a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
	);
	const limit = fin(request.limit) ? Math.min(10_000, Math.max(1, Math.floor(request.limit))) : out.length;
	return out.length > limit ? out.slice(0, limit) : out;
}

/**
 * Ranks library sounds for a request (spec 12 §2.1). Filters first (types, licence, descriptor pills; with a query,
 * sounds that match no query word; with `similarTo`, the reference itself), then sorts: real recordings before
 * synth, more query words in the title (exact or prefix) first, score descending, id ascending. Deterministic for the same input; never throws.
 */
export function rankSounds<T extends RankableSound>(
	entries: readonly T[],
	request: SoundRankRequest = {},
	ctx: SoundRankContext = {},
): RankedSound<T>[] {
	const run = rankRun(request, ctx);
	const { prep } = run;
	if (prep.noKnownType) return [];
	const { wanted, plan } = prep;
	const sim = run.sim;
	const out: RankedSound<T>[] = [];
	for (const e of entries) {
		if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.descriptors) continue;
		const info = entryText(e);
		const entryTypes = info.entryTypes;
		if (wanted.length && !wanted.some((t) => entryTypes.includes(t))) continue;
		const lic = licenseInfo(e.license);
		if (prep.commercialSafeOnly && !lic.safe) continue;
		if (!passesDescriptorFilters(e.descriptors, request)) continue;
		if (sim?.id !== undefined && sim.id === e.id) continue;
		if (plan && !(textScore(plan, info).score > 0)) continue;
		out.push(scoreEntry(e, info, lic, run));
	}
	return finish(out, request);
}

/**
 * {@link rankSounds} and {@link soundFilterOf} in one pass, returning one page (the engine's search with its
 * disjunctive facets): `onFilter(e, bits)` is called for every well-formed entry with its filter bits; entries with
 * every bit set are ranked unless `inRanking(e)` says no. `total` and `results` equal
 * `rankSounds(entries.filter(inRanking), request, ctx)` and its slice `offset … offset + limit`; only the page's
 * results are built as objects (the rest is ranked by numeric keys).
 */
export function rankSoundsPage<T extends RankableSound>(
	entries: readonly T[],
	request: SoundRankRequest,
	ctx: SoundRankContext,
	opts: {
		onFilter?: (e: T, bits: number) => void;
		inRanking?: (e: T) => boolean;
		offset: number;
		limit: number;
	},
): { total: number; results: RankedSound<T>[] } {
	const run = rankRun(request, ctx);
	const { prep } = run;
	// Parallel arrays (no object per ranked entry).
	const es: T[] = [];
	const infos: EntryText[] = [];
	const lics: { safe: boolean; preference: number }[] = [];
	const keys: number[] = [];
	const scratch = newParts();
	// Fast order: when the ranked entries come in id order (the engine's list), the id tie-break is the index and
	// the whole order packs into one exact float per entry (sorted natively). Else the comparator below.
	const tokenCount = prep.plan?.tokens.length ?? 0;
	let packable = true;
	let lastId = '';
	for (const e of entries) {
		if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.descriptors) continue;
		const info = entryText(e);
		const lic = licenseInfo(e.license);
		const bits = filterBits(e, info, lic, prep, request);
		opts.onFilter?.(e, bits);
		if (bits !== SOUND_FILTER_ALL || (opts.inRanking && !opts.inRanking(e))) continue;
		const score = scoreInto(scratch, e, info, lic, run);
		if (packable) {
			const p = packedPrimary(scratch, score, tokenCount);
			if (p < 0 || (es.length > 0 && !(e.id > lastId))) packable = false;
			else keys.push(p);
			lastId = e.id;
		}
		es.push(e);
		infos.push(info);
		lics.push(lic);
	}
	let order: Uint32Array;
	if (packable && es.length < PACK_INDEX) {
		const packed = new Float64Array(es.length);
		for (let i = 0; i < packed.length; i++) packed[i] = (PACK_PRIMARY - 1 - keys[i]!) * PACK_INDEX + i;
		packed.sort();
		order = new Uint32Array(packed.length);
		for (let k = 0; k < packed.length; k++) order[k] = packed[k]! % PACK_INDEX;
	} else {
		const sortKeys = es.map((e, i) => sortKey(e, infos[i]!, lics[i]!, run, scratch));
		order = new Uint32Array(es.length);
		for (let i = 0; i < order.length; i++) order[i] = i;
		order.sort((i, j) => {
			const d = sortKeys[j]! - sortKeys[i]!;
			if (d !== 0 && !Number.isNaN(d)) return d;
			const a = es[i]!.id;
			const b = es[j]!.id;
			return a < b ? -1 : a > b ? 1 : 0;
		});
	}
	const cap = fin(request.limit) ? Math.min(10_000, Math.max(1, Math.floor(request.limit))) : order.length;
	const total = Math.min(order.length, cap);
	const from = Math.max(0, Math.floor(opts.offset));
	const to = Math.min(total, from + Math.max(0, Math.floor(opts.limit)));
	const results: RankedSound<T>[] = [];
	for (let k = from; k < to; k++) {
		const i = order[k]!;
		results.push(scoreEntry(es[i]!, infos[i]!, lics[i]!, run));
	}
	return { total, results };
}

/**
 * The ranking order as one number (descending): source tier, then title-word share, then score, all rounded to 6
 * decimals already, so the integers below are exact and order exactly like rankSounds' comparison.
 */
function sortKey<T extends RankableSound>(
	e: T,
	info: EntryText,
	lic: { preference: number },
	run: RankRun,
	scratch: RankParts,
): number {
	const score = scoreInto(scratch, e, info, lic, run);
	const tm = Math.round((scratch.titleMatch ?? 0) * 1e6); // 0 … 1e6
	const sc = Math.round(score * 1e6) + 2e6; // score ≥ −0.6 → 1.4e6 … 3e6
	return scratch.source * 8e12 + tm * 4e6 + sc;
}

/** Packed order: primary key below 2^27, index below 2^23 (2^50 in all: exact in a float). */
const PACK_PRIMARY = 2 ** 27;
const PACK_INDEX = 2 ** 23;

/**
 * The primary ranking key as an integer below 2^27 (larger ranks first): source tier (bit 26), the number of query
 * words a title word matches (titleMatch × tokens, 0 … 16, bits 21–25), then the 6-decimal score shifted by 0.6
 * (0 … 1.6·10^6 < 2^21). −1 when a value does not fit (then the comparator orders).
 */
function packedPrimary(parts: RankParts, score: number, tokenCount: number): number {
	const inTitle = tokenCount > 0 ? Math.round((parts.titleMatch ?? 0) * tokenCount) : 0;
	const sc = Math.round(score * 1e6) + 600_000;
	if (
		!(sc >= 0 && sc < 2 ** 21) ||
		!(inTitle >= 0 && inTitle < 32) ||
		(parts.source !== 0 && parts.source !== 1)
	)
		return -1;
	return parts.source * 2 ** 26 + inTitle * 2 ** 21 + sc;
}

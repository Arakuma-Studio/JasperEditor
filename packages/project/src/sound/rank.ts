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
import { isCommercialSafe, licensePreference } from './license.ts';
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
};

/** Plans of recent queries (the same query string gives the same plan object, so text scores can be reused). */
const PLAN_MEMO = new Map<string, QueryPlan | null>();
const PLAN_MEMO_SIZE = 64;

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
	return { tokens };
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
	const info: EntryText = {
		title: e.title,
		tagsRef: tags,
		tagsLen,
		typesRef: types,
		typesLen,
		titleTokens: tokenizeSoundText(e.title),
		tagTokens,
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

/** Licence class results by licence string (a library has a handful of distinct licences). */
const LICENSE_MEMO = new Map<string, { safe: boolean; preference: number }>();
function licenseInfo(license: unknown): { safe: boolean; preference: number } {
	if (typeof license !== 'string')
		return { safe: isCommercialSafe(license), preference: licensePreference(license) };
	let r = LICENSE_MEMO.get(license);
	if (!r) {
		if (LICENSE_MEMO.size >= 4096) LICENSE_MEMO.clear();
		r = { safe: isCommercialSafe(license), preference: licensePreference(license) };
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

function computeTextScore(plan: QueryPlan, t: EntryText): { score: number; titleMatch: number } {
	const title = t.titleTokens;
	const tags = t.tagTokens;
	const entryTypes = t.entryTypes;
	let total = 0;
	let inTitle = 0;
	for (const { token, type } of plan.tokens) {
		let best = 0;
		let titled = false;
		if (type) {
			if (entryTypes.includes(type)) best = 1;
			else if (namedTypesOf(t).includes(type)) best = 0.85;
		}
		if (entryTypes.includes(token as SoundTypeId)) best = Math.max(best, 1);
		for (const w of title) {
			if (w === token) best = Math.max(best, 1);
			else if (token.length >= 3 && w.startsWith(token)) best = Math.max(best, 0.75);
			else continue;
			titled = true;
		}
		if (titled) inTitle++;
		for (const w of tags) {
			if (w === token) best = Math.max(best, 0.8);
			else if (token.length >= 3 && w.startsWith(token)) best = Math.max(best, 0.6);
		}
		total += best;
	}
	return { score: round6(total / plan.tokens.length), titleMatch: round6(inTitle / plan.tokens.length) };
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
		const t = entryText(e);
		let bits = 0;
		if (!p.noKnownType && (p.wanted.length === 0 || p.wanted.some((w) => t.entryTypes.includes(w))))
			bits |= SOUND_FILTER_TYPES;
		if (!p.commercialSafeOnly || licenseInfo(e.license).safe) bits |= SOUND_FILTER_LICENSE;
		if (
			passesDescriptorFilters(e.descriptors, request) &&
			!(p.similarId !== undefined && p.similarId === e.id) &&
			(!p.plan || textScore(p.plan, t).score > 0)
		)
			bits |= SOUND_FILTER_REST;
		return bits;
	};
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
	const prep = prepareRequest(request);
	if (prep.noKnownType) return [];
	const { wanted, plan } = prep;
	const used = new Map<string, number>();
	(ctx.usedNearby ?? []).forEach((id, i) => {
		if (typeof id !== 'string') return;
		used.set(id, Math.min(MAX_ROTATION_PENALTY, (used.get(id) ?? 0) + ROTATION_PENALTY / (1 + i)));
	});
	const sim = request.similarTo;
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

		const matched = plan ? textScore(plan, info) : null;
		const text = matched ? matched.score : null;
		if (plan && !(text! > 0)) continue;
		let typeFit: number | null = null;
		if (request.visualKind || wanted.length) {
			const parts: number[] = [];
			if (request.visualKind) {
				let best = 0;
				for (const t of entryTypes) best = Math.max(best, typeFitForVisualKind(t, request.visualKind));
				parts.push(best);
			}
			if (wanted.length) parts.push(entryTypes.includes(wanted[0]!) ? 1 : 0.9);
			typeFit = round6(parts.reduce((s, v) => s + v, 0) / parts.length);
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
		const score = round6(num / den - rotation);
		const source = REAL_SOURCES.has(e.source?.type) ? 1 : 0;
		out.push({
			entry: e,
			score,
			parts: {
				text,
				typeFit,
				durationFit: dFit,
				judge,
				license,
				source,
				similarity,
				rotation,
				titleMatch: matched ? matched.titleMatch : null,
			},
		});
	}
	out.sort(
		(a, b) =>
			b.parts.source - a.parts.source ||
			(b.parts.titleMatch ?? 0) - (a.parts.titleMatch ?? 0) ||
			b.score - a.score ||
			(a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
	);
	const limit = fin(request.limit) ? Math.min(10_000, Math.max(1, Math.floor(request.limit))) : out.length;
	return out.slice(0, limit);
}

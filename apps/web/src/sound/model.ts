// Pure helpers of the Sound Library panel (spec 12 §2.7, P1-R7): the search request built from the panel's filters,
// local collections (Favourites, Recent, Used in this project) ranked with the same `rankSounds` the engine uses, licence
// badges, the descriptor words of the accessible names and tooltips, and the mini-waveform columns. No React, no I/O.
import type { SoundEntry, SoundFacets, SoundSearchRequest, SoundSourceType } from '@jasper/api';
import {
	DESCRIPTOR_FILTERS,
	isSoundTypeId,
	type LicenseClass,
	licenseClass,
	type ProjectDocument,
	rankSounds,
	readLibraryProvenance,
	SOUND_FAMILIES,
	SOUND_TYPE_IDS,
	SOUND_TYPES,
	type SoundFamily,
	type SoundRankRequest,
	type SoundTypeId,
} from '@jasper/project';
import { getLanguage, t, withoutContext } from '../i18n/runtime.ts';

// ---------------------------------------------------------------------------------------------------------------
// Labels (the `*_LABELS` maps are translated by the i18n transform)

export const SOUND_TYPE_LABELS: Record<SoundTypeId, string> = {
	hit: 'Hit',
	boom: 'Boom',
	riser: 'Riser',
	reverse: 'Reverse [sound type]',
	transition: 'Transition',
	whoosh: 'Whoosh',
	swish: 'Swish',
	glitch: 'Glitch',
	ui: 'UI',
	click: 'Click',
	key: 'Key [sound type]',
	tick: 'Tick',
	tap: 'Tap',
	pop: 'Pop [sound type]',
	thump: 'Thump',
	paper: 'Paper',
	chime: 'Chime',
	shimmer: 'Shimmer',
	zap: 'Zap',
	ambience: 'Ambience',
	roomtone: 'Room tone',
};

export const SOUND_FAMILY_LABELS: Record<SoundFamily, string> = {
	impacts: 'Impacts',
	movement: 'Movement',
	digital: 'Digital',
	tactile: 'Tactile',
	tonal: 'Tonal',
	beds: 'Beds',
};

export const SOUND_SOURCE_LABELS: Record<SoundSourceType, string> = {
	starter: 'Starter kit',
	pack: 'Packs',
	folder: 'Folders',
	synth: 'Jasper Synth',
};

/** A sound type's label (unknown ids of newer builds are shown as they are). */
export function typeLabel(type: string): string {
	// homonyms carry a "[sound type]" context in the catalogue ("Key" is a keyer elsewhere, "Pop" an animation)
	return isSoundTypeId(type) ? withoutContext(SOUND_TYPE_LABELS[type]) : type;
}

/** Families in panel order with their types (chips are grouped by family, spec 12 §2.7). */
export const TYPE_GROUPS: readonly { family: SoundFamily; types: SoundTypeId[] }[] = SOUND_FAMILIES.map(
	(family) => ({ family, types: SOUND_TYPE_IDS.filter((t) => SOUND_TYPES[t].family === family) }),
);

// ---------------------------------------------------------------------------------------------------------------
// Filters → request

export type RefineKey = 'length' | 'tone' | 'attack' | 'weight' | 'texture';
export type RefineState = {
	length?: 'short' | 'medium' | 'long';
	tone?: 'dark' | 'bright';
	attack?: 'punchy' | 'soft';
	weight?: 'light' | 'heavy';
	texture?: 'clean' | 'noisy';
};

/** The values of each Refine pill, in order (thresholds: `DESCRIPTOR_FILTERS`). */
export const REFINE_OPTIONS: { key: RefineKey; values: readonly string[] }[] = [
	{ key: 'length', values: ['short', 'medium', 'long'] },
	{ key: 'tone', values: ['dark', 'bright'] },
	{ key: 'attack', values: ['punchy', 'soft'] },
	{ key: 'weight', values: ['light', 'heavy'] },
	{ key: 'texture', values: ['clean', 'noisy'] },
];

export const REFINE_LABELS: Record<string, string> = {
	length: 'Length',
	tone: 'Tone',
	attack: 'Attack',
	weight: 'Weight',
	texture: 'Texture',
	short: 'Short',
	medium: 'Medium',
	long: 'Long',
	dark: 'Dark',
	bright: 'Bright',
	punchy: 'Punchy',
	soft: 'Soft',
	light: 'Light',
	heavy: 'Heavy',
	clean: 'Clean',
	noisy: 'Noisy',
};

/**
 * Collections (spec 12 §2.7): the whole library, the user's favourites and recents, the sounds this project uses,
 * or one source (starter kit, packs, all folders, one folder `root:<id>`, Jasper Synth).
 */
export type Collection =
	| 'all'
	| 'favourites'
	| 'recent'
	| 'used'
	| 'palette'
	| `source:${SoundSourceType}`
	| `root:${string}`;

export const LOCAL_COLLECTIONS: ReadonlySet<Collection> = new Set(['favourites', 'recent', 'used', 'palette']);

export type LibraryFilters = {
	query: string;
	collection: Collection;
	types: readonly SoundTypeId[];
	refine: RefineState;
	/** Commercial-safe licences only (default on). */
	commercialSafe: boolean;
	/** Find Similar: rank by similarity to this sound. */
	similarTo: { id: string; title: string } | null;
};

export const DEFAULT_FILTERS: LibraryFilters = {
	query: '',
	collection: 'all',
	types: [],
	refine: {},
	commercialSafe: true,
	similarTo: null,
};

const SOURCE_TYPES: readonly SoundSourceType[] = ['starter', 'pack', 'folder', 'synth'];

/** Lower case without accents ("Transición" → "transicion"). */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Spec 12 §2.7 "search matches type ids and translated labels": the engine knows the type ids (and English words);
 * in another UI language, words of the query equal to a type's translated label ("golpe", "transición", "golpe
 * sordo": lower case, accents ignored, whole words, longest label first) are sent as that type's id. English queries
 * are sent as typed.
 */
export function localizeSoundQuery(q: string): string {
	if (getLanguage() === 'en' || !q.trim()) return q;
	const labels: { label: string; id: SoundTypeId }[] = [];
	for (const id of SOUND_TYPE_IDS) {
		const label = fold(withoutContext(t(SOUND_TYPE_LABELS[id])).trim());
		if (label && label !== id) labels.push({ label, id });
	}
	labels.sort((a, b) => b.label.length - a.label.length);
	let out = fold(q);
	for (const { label, id } of labels)
		out = out.replace(
			new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(label)}(?=$|[^\\p{L}\\p{N}])`, 'gu'),
			`$1${id}`,
		);
	return out === fold(q) ? q : out;
}

/** The engine search for the filters (engine collections: all, a source, a folder). */
export function searchRequest(
	f: LibraryFilters,
	page: { limit: number; offset: number },
): SoundSearchRequest {
	const req: SoundSearchRequest = {
		limit: page.limit,
		offset: page.offset,
		license: f.commercialSafe ? 'commercial-safe' : 'any',
	};
	const q = localizeSoundQuery(f.query.trim());
	if (q) req.q = q.slice(0, 500);
	if (f.types.length) req.types = [...f.types];
	for (const { key } of REFINE_OPTIONS) {
		const v = f.refine[key];
		if (v) (req as Record<string, unknown>)[key] = v;
	}
	if (f.similarTo) req.similarTo = f.similarTo.id;
	if (f.collection.startsWith('source:')) {
		const s = f.collection.slice(7) as SoundSourceType;
		if (SOURCE_TYPES.includes(s)) req.sources = [s];
	} else if (f.collection.startsWith('root:')) req.rootId = f.collection.slice(5);
	return req;
}

/** The same request for `rankSounds` (local collections). */
export function rankRequest(f: LibraryFilters, similar: SoundEntry | null): SoundRankRequest {
	const req: SoundRankRequest = { license: f.commercialSafe ? 'commercial-safe' : 'any', ...f.refine };
	const q = localizeSoundQuery(f.query.trim());
	if (q) req.query = q.slice(0, 500);
	if (f.types.length) req.types = [...f.types];
	if (similar) req.similarTo = { id: similar.id, descriptors: similar.descriptors };
	return req;
}

export type LocalSearch = { results: SoundEntry[]; total: number; facets: SoundFacets };

/**
 * Filters and orders a local collection like the engine search does (same `rankSounds`, disjunctive facets). Without
 * a query or Find Similar, the collection keeps its own order (favourites: last starred first; recent: most recent).
 */
export function searchLocal(
	entries: readonly SoundEntry[],
	f: LibraryFilters,
	similar: SoundEntry | null,
): LocalSearch {
	const req = rankRequest(f, similar);
	const ranked = rankSounds(entries, req).map((r) => r.entry);
	const ordered = req.query || req.similarTo ? ranked : entries.filter((e) => ranked.includes(e));
	const facets: SoundFacets = { types: {}, families: {}, licenses: {}, sources: {} };
	const inc = (m: Record<string, number>, k: string) => {
		m[k] = (m[k] ?? 0) + 1;
	};
	for (const e of rankSounds(entries, { ...req, types: undefined }).map((r) => r.entry)) {
		const fams = new Set<string>();
		for (const t of e.types) {
			if (!isSoundTypeId(t)) continue;
			inc(facets.types, t);
			fams.add(SOUND_TYPES[t].family);
		}
		for (const fam of fams) inc(facets.families, fam);
	}
	for (const r of rankSounds(entries, { ...req, license: 'any' }))
		inc(facets.licenses, licenseClass(r.entry.license));
	for (const e of ranked) inc(facets.sources, e.source.type);
	return { results: ordered, total: ordered.length, facets };
}

/** Library sound ids the project's media came from (Used in this project), in media order, unique. */
export function usedSoundIds(doc: Pick<ProjectDocument, 'media'>): string[] {
	const out: string[] = [];
	for (const m of Object.values(doc.media)) {
		const lib = readLibraryProvenance((m as { library?: unknown }).library);
		if (lib && !out.includes(lib.soundId)) out.push(lib.soundId);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Badges, names, tooltips

export type LicenseBadge = { text: string; warn: boolean; title: string };

export const LICENSE_BADGE_TITLES: Record<LicenseClass, string> = {
	cc0: 'Public domain (CC0): no credit needed',
	jasper: 'Made for JasperEditor: free to use',
	'cc-by': 'Creative Commons Attribution: credit the author',
	'cc-by-sa': 'Creative Commons Attribution-ShareAlike: credit the author, share alike',
	permissive: 'Open licence: keep the notice',
	'royalty-free': 'Your folder, declared royalty-free',
	'user-provided': 'Your folder: no licence declared, make sure you may use it',
	nc: 'Non-commercial only: not safe for commercial work',
	nd: 'No derivatives: edits may break the licence',
	unknown: 'Unknown licence',
};

/** The licence badge of a row (CC0 / BY / BY-SA / Yours / Synth; NC, ND, undeclared and unknown flagged). */
export function licenseBadge(entry: { license: string; source?: { type: string; [k: string]: unknown } | null }): LicenseBadge {
	const cls = licenseClass(entry.license);
	// `t`: the map's getter translates in the build; the lookup also covers code that reads the English source.
	const title = `${t(LICENSE_BADGE_TITLES[cls])} · ${entry.license}`;
	switch (cls) {
		case 'cc0':
			return { text: 'CC0', warn: false, title };
		case 'jasper':
			return { text: entry.source?.type === 'synth' ? t('Synth') : t('Jasper'), warn: false, title };
		case 'cc-by':
			return { text: 'BY', warn: false, title };
		case 'cc-by-sa':
			return { text: 'BY-SA', warn: false, title };
		case 'permissive':
			return { text: withoutContext(t('Open [licence badge]')), warn: false, title };
		case 'royalty-free':
			return { text: t('Yours'), warn: false, title };
		case 'user-provided':
			return { text: t('Yours?'), warn: true, title };
		case 'nc':
			return { text: 'NC', warn: true, title };
		case 'nd':
			return { text: 'ND', warn: true, title };
		default:
			return { text: '?', warn: true, title };
	}
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Seconds as "0.42 s" / "2.4 s" / "1:05". */
export function formatSeconds(s: number): string {
	if (!fin(s) || s < 0) return '—';
	if (s < 1) return `${s.toFixed(2)} s`;
	if (s < 60) return `${s.toFixed(1)} s`;
	const m = Math.floor(s / 60);
	return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`;
}

/** A point in a sound (the peak): milliseconds under a second ("230 ms"), else seconds. */
export function formatOffset(s: number): string {
	if (!fin(s) || s < 0) return '—';
	return s < 1 ? `${Math.round(s * 1000)} ms` : formatSeconds(s);
}

export const DESCRIPTOR_WORD_LABELS: Record<string, string> = {
	punchy: 'punchy',
	soft: 'soft attack',
	dark: 'dark',
	bright: 'bright',
	heavy: 'heavy',
	light: 'light',
	clean: 'clean',
	noisy: 'noisy',
	tonal: 'tonal',
	loopable: 'loopable',
};

/** Words that describe a sound from its descriptors (the Refine pill thresholds), for names and tooltips. */
export function descriptorWords(d: SoundEntry['descriptors']): string[] {
	const F = DESCRIPTOR_FILTERS;
	const out: string[] = [];
	if (fin(d.riseMs) && d.riseMs <= F.attack.punchyMaxMs) out.push('punchy');
	else if (fin(d.riseMs) && d.riseMs >= F.attack.softMinMs) out.push('soft');
	if (fin(d.centroidHz) && d.centroidHz <= F.tone.darkMaxHz) out.push('dark');
	else if (fin(d.centroidHz) && d.centroidHz >= F.tone.brightMinHz) out.push('bright');
	if (fin(d.below150Share) && d.below150Share >= F.weight.heavyMinBelow150) out.push('heavy');
	else if (fin(d.below150Share) && d.below150Share <= F.weight.lightMaxBelow150) out.push('light');
	if (fin(d.flatness) && d.flatness >= F.texture.noisyMinFlatness) out.push('noisy');
	else if (fin(d.flatness) && d.flatness <= F.texture.cleanMaxFlatness) out.push('clean');
	if (d.pitchMidi !== null && fin(d.pitchConfidence) && d.pitchConfidence >= 0.8) out.push('tonal');
	if (d.loopable === true) out.push('loopable');
	return out.map((w) => DESCRIPTOR_WORD_LABELS[w] ?? w);
}

/**
 * The accessible name of a result row (listbox option, spec 12 §2.7 "descriptor-rich names"): title, types, length,
 * peak position, descriptor words and licence.
 */
export function soundAccessibleName(e: SoundEntry, favourite: boolean): string {
	const parts = [e.title || e.id];
	const types = e.types.map(typeLabel).join(', ');
	if (types) parts.push(types);
	parts.push(formatSeconds(e.format.durationSec));
	if (fin(e.descriptors.peakSec)) parts.push(t('peak at {0}', formatOffset(e.descriptors.peakSec)));
	parts.push(...descriptorWords(e.descriptors));
	parts.push(licenseBadge(e).title);
	if (favourite) parts.push(withoutContext(t('favourite [accessible name]')));
	return parts.join(', ');
}

/** Source line of a sound (tooltip, licence dialog). */
export function sourceLine(
	e: Pick<SoundEntry, 'source'>,
	rootLabel?: (rootId: string) => string | null,
): string {
	const s = e.source as SoundEntry['source'] | undefined;
	switch (s?.type) {
		case 'starter':
			return t('Starter kit');
		case 'pack':
			return t('Pack {0}', s.packId);
		case 'folder': {
			const label = rootLabel?.(s.rootId);
			return label ? `${label} › ${s.relPath}` : s.relPath;
		}
		case 'synth':
			return t('Jasper Synth ({0}, seed {1})', s.recipe, s.seed);
		default:
			return '';
	}
}

/** Multi-line tooltip of a row: name, types, descriptors, peak, source and licence. */
export function soundTooltip(e: SoundEntry, rootLabel?: (rootId: string) => string | null): string {
	const d = e.descriptors;
	const lines = [e.title || e.id];
	const types = e.types.map(typeLabel).join(', ');
	if (types) lines.push(types);
	const facts = [
		formatSeconds(e.format.durationSec),
		fin(d.peakSec) ? t('peak {0}', formatOffset(d.peakSec)) : null,
		fin(d.riseMs) ? t('rise {0} ms', Math.round(d.riseMs)) : null,
		fin(d.centroidHz) ? t('centroid {0} Hz', Math.round(d.centroidHz)) : null,
		fin(d.maxMomentaryLufs) ? t('{0} LUFS max', d.maxMomentaryLufs.toFixed(1)) : null,
	].filter(Boolean);
	lines.push(facts.join(' · '));
	const words = descriptorWords(d);
	if (words.length) lines.push(words.join(', '));
	lines.push(sourceLine(e, rootLabel));
	lines.push(`${e.license}${e.author ? ` · ${e.author}` : ''}`);
	return lines.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Mini waveform

/** Decodes base64 (the engine's u8 peaks). Invalid input gives an empty array. */
export function decodeBase64(b64: string): Uint8Array {
	try {
		const s = atob(b64);
		const out = new Uint8Array(s.length);
		for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
		return out;
	} catch {
		return new Uint8Array(0);
	}
}

/**
 * Column heights (0…1) of a `width`-column waveform from the engine's peaks (u8, `perSecond` per second covering
 * `coveredSec`), drawn over `durationSec`: each column is the largest peak in its time span; columns past the covered
 * part (the first 30 s of a long file) are 0.
 */
export function waveformColumns(
	peaks: Uint8Array,
	perSecond: number,
	durationSec: number,
	width: number,
): Float32Array {
	const w = Math.max(0, Math.min(4096, Math.floor(fin(width) ? width : 0)));
	const out = new Float32Array(w);
	if (!w || !peaks.length || !fin(perSecond) || perSecond <= 0 || !fin(durationSec) || durationSec <= 0)
		return out;
	const total = durationSec * perSecond;
	for (let c = 0; c < w; c++) {
		const a = Math.floor((c / w) * total);
		const b = Math.max(a + 1, Math.floor(((c + 1) / w) * total));
		let m = 0;
		for (let i = a; i < b && i < peaks.length; i++) m = Math.max(m, peaks[i]!);
		out[c] = m / 255;
	}
	return out;
}

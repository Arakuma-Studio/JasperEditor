// Sound library search (spec 12 §2.1, §2.8; wp-note "WP1.2"): `GET /api/sounds` over the index's entries. One
// `rankSounds` pass for the results; the disjunctive facets are counted in one more pass over the entries with
// `soundFilterOf` (each dimension counts with every filter but its own), without sorting anything. Pure apart from
// its inputs, so it can be measured on a synthetic library (test/sounds-search.test.ts: < 50 ms for 5 000 sounds).
import {
	SOUND_SEARCH_DEFAULT_LIMIT,
	type SoundEntry,
	type SoundFacets,
	type SoundSearchQuery,
	type SoundSearchResponse,
} from '@jasper/api';
import {
	isSoundTypeId,
	licenseClass,
	rankSounds,
	resolveTypeNames,
	SOUND_FILTER_ALL,
	SOUND_FILTER_LICENSE,
	SOUND_FILTER_REST,
	SOUND_FILTER_TYPES,
	SOUND_TYPES,
	type SoundRankRequest,
	soundFilterOf,
	typesOfFamily,
} from '@jasper/project';
import { HttpError } from '../tools/reply.ts';

const NOT_TYPES = SOUND_FILTER_LICENSE | SOUND_FILTER_REST;
const NOT_LICENSE = SOUND_FILTER_TYPES | SOUND_FILTER_REST;

/** `licenseClass` by licence string (a library has a handful of distinct licences). */
const LICENSE_CLASS = new Map<string, string>();
function licenseClassOf(license: string): string {
	let c = LICENSE_CLASS.get(license);
	if (c === undefined) {
		if (LICENSE_CLASS.size >= 1024) LICENSE_CLASS.clear();
		c = licenseClass(license);
		LICENSE_CLASS.set(license, c);
	}
	return c;
}

export type SoundSearchResult = Pick<SoundSearchResponse, 'total' | 'offset' | 'results' | 'facets'>;

/** The ranking request of a search query (family as types, `similarTo` by id); `none`: family and types share nothing. */
export function rankRequestOf(
	q: SoundSearchQuery,
	lookup: (id: string) => SoundEntry | undefined,
): { req: SoundRankRequest; none: boolean } {
	let types: string[] | undefined;
	// A family and types that share nothing match nothing.
	let none = false;
	if (q.family) {
		const fam: string[] = typesOfFamily(q.family);
		types = q.types?.length ? resolveTypeNames(q.types).filter((t) => fam.includes(t)) : fam;
		none = types.length === 0;
	} else if (q.types?.length) types = q.types;
	let similarTo: SoundRankRequest['similarTo'];
	if (q.similarTo) {
		const ref = lookup(q.similarTo);
		if (!ref)
			throw new HttpError(404, 'SOUND_NOT_FOUND', `Unknown sound: ${String(q.similarTo).slice(0, 80)}`);
		similarTo = { id: ref.id, descriptors: ref.descriptors };
	}
	const req: SoundRankRequest = {
		...(q.q !== undefined ? { query: q.q } : {}),
		...(types ? { types } : {}),
		...(q.visualKind ? { visualKind: q.visualKind } : {}),
		...(q.windowSec !== undefined ? { windowSec: q.windowSec } : {}),
		...(q.align ? { align: q.align } : {}),
		...(q.length ? { length: q.length } : {}),
		...(q.tone ? { tone: q.tone } : {}),
		...(q.attack ? { attack: q.attack } : {}),
		...(q.weight ? { weight: q.weight } : {}),
		...(q.texture ? { texture: q.texture } : {}),
		license: q.license ?? 'commercial-safe',
		...(similarTo ? { similarTo } : {}),
	};
	return { req, none };
}

/**
 * Searches entries (in id order). `includeFolders: false` (remote mode, D-47) leaves user-folder sounds out of the
 * results and the facets.
 */
export function searchSoundEntries(
	all: readonly SoundEntry[],
	q: SoundSearchQuery,
	opts: { lookup: (id: string) => SoundEntry | undefined; includeFolders: boolean },
): SoundSearchResult {
	const { req, none } = rankRequestOf(q, opts.lookup);
	const sources = q.sources?.length ? new Set<string>(q.sources) : null;
	const facets: SoundFacets = { types: {}, families: {}, licenses: {}, sources: {} };
	const bump = (rec: Record<string, number>, k: string) => {
		rec[k] = (rec[k] ?? 0) + 1;
	};
	const filter = soundFilterOf(req);
	const pool: SoundEntry[] = [];
	const fams = new Set<string>();
	for (const e of all) {
		const isFolder = e.source.type === 'folder';
		if (isFolder && !opts.includeFolders) continue;
		if (q.rootId && !(isFolder && e.source.type === 'folder' && e.source.rootId === q.rootId)) continue;
		const inPool = !sources || sources.has(e.source.type);
		if (inPool) pool.push(e);
		const f = filter(e);
		if (f < 0) continue;
		// Types and families: every filter but the type filter.
		if (inPool && (f & NOT_TYPES) === NOT_TYPES) {
			fams.clear();
			for (const t of e.types)
				if (isSoundTypeId(t)) {
					bump(facets.types, t);
					fams.add(SOUND_TYPES[t].family);
				}
			for (const fam of fams) bump(facets.families, fam);
		}
		if (none) continue;
		// Licences: every filter but the licence filter; sources: every filter but the source filter.
		if (inPool && (f & NOT_LICENSE) === NOT_LICENSE) bump(facets.licenses, licenseClassOf(e.license));
		if (f === SOUND_FILTER_ALL) bump(facets.sources, e.source.type);
	}
	const ctx = q.usedNearby?.length ? { usedNearby: q.usedNearby } : {};
	const ranked = none ? [] : rankSounds(pool, req, ctx);
	const offset = q.offset ?? 0;
	const limit = q.limit ?? SOUND_SEARCH_DEFAULT_LIMIT;
	return {
		total: ranked.length,
		offset,
		results: ranked
			.slice(offset, offset + limit)
			.map((r) => ({ sound: r.entry, score: r.score, parts: r.parts })),
		facets,
	};
}

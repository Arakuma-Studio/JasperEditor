// Sound library search (spec 12 §2.1, §2.8; wp-note "WP1.2"): `GET /api/sounds` over the index's entries. One pass
// (`rankSoundsPage`) ranks the results and gives every entry's filter bits, from which the disjunctive facets
// are counted (each dimension counts with every filter but its own) without sorting anything. Pure apart from
// its inputs, so it can be measured on a synthetic library (test/sounds-search.test.ts: < 50 ms for 5 000 sounds).
import {
	offeredTakes,
	SOUND_SEARCH_DEFAULT_LIMIT,
	type SoundEntry,
	type SoundFacets,
	type SoundMatch,
	type SoundSearchQuery,
	type SoundSearchResponse,
	withOfferedTakes,
} from '@jasper/api';
import {
	isSoundTypeId,
	licenseClass,
	paletteMaterials,
	rankSoundsPage,
	resolveTypeNames,
	SOUND_FAMILIES,
	SOUND_FILTER_ALL,
	SOUND_FILTER_LICENSE,
	SOUND_FILTER_REST,
	SOUND_FILTER_TYPES,
	SOUND_MATERIALS,
	SOUND_TYPE_IDS,
	SOUND_TYPES,
	type SoundRankRequest,
	typesOfFamily,
} from '@jasper/project';
import { HttpError } from '../tools/reply.ts';

const NOT_TYPES = SOUND_FILTER_LICENSE | SOUND_FILTER_REST;
const NOT_LICENSE = SOUND_FILTER_TYPES | SOUND_FILTER_REST;

const TYPE_INDEX = new Map<string, number>(SOUND_TYPE_IDS.map((t, i) => [t, i]));
const FAMILY_INDEX = new Map<string, number>(SOUND_FAMILIES.map((f, i) => [f, i]));
const MATERIAL_INDEX = new Map<string, number>(SOUND_MATERIALS.map((m, i) => [m, i]));

/** What the facets count of an entry: indices of its known types (repeats kept) and distinct families, its licence class. */
type FacetInfo = { types: number[]; families: number[]; licenseClass: string; of: SoundEntry['types'] };
const FACET_INFO = new WeakMap<SoundEntry, FacetInfo>();

function facetInfoOf(e: SoundEntry): FacetInfo {
	const hit = FACET_INFO.get(e);
	if (hit && hit.of === e.types) return hit;
	const types: number[] = [];
	const families: number[] = [];
	for (const t of e.types)
		if (isSoundTypeId(t)) {
			types.push(TYPE_INDEX.get(t)!);
			const fam = FAMILY_INDEX.get(SOUND_TYPES[t].family)!;
			if (!families.includes(fam)) families.push(fam);
		}
	const info = { types, families, licenseClass: licenseClassOf(e.license), of: e.types };
	FACET_INFO.set(e, info);
	return info;
}

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

/**
 * P6-E14 describe mode of a search: the model's 0…1 scores and matches per sound id (the engine's `SemanticService`),
 * or the description to search as words when the model is not usable.
 */
export type DescribeMode =
	| {
			semantic: {
				scores: ReadonlyMap<string, number>;
				text: string;
				matches: ReadonlyMap<string, SoundMatch>;
			};
	  }
	| { describeAsKeywords: string };

/** The ranking request of a search query (family as types, `similarTo` by id); `none`: family and types share nothing. */
export function rankRequestOf(
	q: SoundSearchQuery,
	lookup: (id: string) => SoundEntry | undefined,
	describe?: DescribeMode,
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
	// P6-E14: without the model, the description's words join the query (keyword fallback)
	const query =
		describe && 'describeAsKeywords' in describe
			? [q.q, describe.describeAsKeywords].filter((x) => x?.trim()).join(' ')
			: q.q;
	const req: SoundRankRequest = {
		...(query !== undefined ? { query } : {}),
		...(describe && 'semantic' in describe
			? { semantic: { scores: describe.semantic.scores, text: describe.semantic.text } }
			: {}),
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
		// P6-E10: the personality's preferences, and the palette materials of the placed sounds (unknown ids ignored)
		...(q.personality ? { personality: q.personality } : {}),
		...(q.placed?.length
			? {
					paletteMaterials: paletteMaterials(
						q.placed
							.map((id) => lookup(id))
							.filter((e): e is SoundEntry => !!e)
							.map((e) => ({ soundId: e.id, types: e.types, materials: e.materials ?? null })),
					),
				}
			: {}),
	};
	return { req, none };
}

/**
 * Searches entries (in id order). `includeFolders: false` (remote mode, D-47) leaves user-folder sounds out of the
 * results and the facets. `takes: true` adds the offered takes of multi-hit recordings as entries of their own (P6-E9);
 * `material` keeps sounds whose words name it (its facet counts ignore that filter). Result rows leave a recording's
 * `takes` out and say how many it offers (`takeCount`).
 */
export function searchSoundEntries(
	all: readonly SoundEntry[],
	q: SoundSearchQuery,
	opts: {
		lookup: (id: string) => SoundEntry | undefined;
		includeFolders: boolean;
		/** P6-E14: describe mode with the model's scores… */
		semantic?: Extract<DescribeMode, { semantic: unknown }>['semantic'];
		/** …or its description searched as words. */
		describeAsKeywords?: string;
	},
): SoundSearchResult {
	const describe: DescribeMode | undefined = opts.semantic
		? { semantic: opts.semantic }
		: opts.describeAsKeywords !== undefined
			? { describeAsKeywords: opts.describeAsKeywords }
			: undefined;
	const { req, none } = rankRequestOf(q, opts.lookup, describe);
	const sources = q.sources?.length ? new Set<string>(q.sources) : null;
	const facets: SoundFacets = { types: {}, families: {}, licenses: {}, sources: {} };
	const visible =
		opts.includeFolders && !q.rootId && !q.packId
			? all
			: all.filter(
					(e) =>
						(opts.includeFolders || e.source.type !== 'folder') &&
						(!q.rootId || (e.source.type === 'folder' && e.source.rootId === q.rootId)) &&
						(!q.packId || (e.source.type === 'pack' && e.source.packId === q.packId)),
				);
	const pool = q.takes ? withOfferedTakes(visible) : visible;
	const inPool = (e: SoundEntry) => !sources || sources.has(e.source.type);
	const material = q.material;
	const matOk = (e: SoundEntry) => !material || (e.materials?.includes(material) ?? false);
	const materialCounts = new Int32Array(SOUND_MATERIALS.length);
	// Counted in arrays by index, turned into the facet records at the end.
	const typeCounts = new Int32Array(SOUND_TYPE_IDS.length);
	const familyCounts = new Int32Array(SOUND_FAMILIES.length);
	const licenseCounts = new Map<string, number>();
	const sourceCounts = new Map<string, number>();
	const count = (e: SoundEntry, f: number) => {
		// Materials: every filter but the material filter.
		if (f === SOUND_FILTER_ALL && !none && inPool(e))
			for (const m of e.materials ?? []) {
				const i = MATERIAL_INDEX.get(m);
				if (i !== undefined) materialCounts[i]!++;
			}
		const pooled = inPool(e) && matOk(e);
		const info = facetInfoOf(e);
		// Types and families: every filter but the type filter.
		if (pooled && (f & NOT_TYPES) === NOT_TYPES) {
			for (const t of info.types) typeCounts[t]!++;
			for (const fam of info.families) familyCounts[fam]!++;
		}
		if (none) return;
		// Licences: every filter but the licence filter; sources: every filter but the source filter.
		if (pooled && (f & NOT_LICENSE) === NOT_LICENSE)
			licenseCounts.set(info.licenseClass, (licenseCounts.get(info.licenseClass) ?? 0) + 1);
		if (f === SOUND_FILTER_ALL && matOk(e))
			sourceCounts.set(e.source.type, (sourceCounts.get(e.source.type) ?? 0) + 1);
	};
	const ctx = q.usedNearby?.length ? { usedNearby: q.usedNearby } : {};
	// One pass: the filter bits of every entry count the facets; entries of the pool that pass every filter are ranked.
	const offset = q.offset ?? 0;
	const limit = q.limit ?? SOUND_SEARCH_DEFAULT_LIMIT;
	const page = rankSoundsPage(pool, req, ctx, {
		onFilter: count,
		inRanking: (e) => !none && inPool(e) && matOk(e),
		offset,
		limit,
	});
	SOUND_TYPE_IDS.forEach((t, i) => {
		if (typeCounts[i]) facets.types[t] = typeCounts[i]!;
	});
	SOUND_FAMILIES.forEach((fam, i) => {
		if (familyCounts[i]) facets.families[fam] = familyCounts[i]!;
	});
	for (const [k, v] of licenseCounts) facets.licenses[k] = v;
	for (const [k, v] of sourceCounts) facets.sources[k] = v;
	const materials: Record<string, number> = {};
	SOUND_MATERIALS.forEach((m, i) => {
		if (materialCounts[i]) materials[m] = materialCounts[i]!;
	});
	facets.materials = materials;
	return {
		total: page.total,
		offset,
		results: page.results.map((r) => {
			const row = searchRow(r.entry, r.score, r.parts);
			const match = opts.semantic?.matches.get(r.entry.id);
			return match ? { ...row, match } : row;
		}),
		facets,
	};
}

/** A result row: a recording's takes are left out (`takeCount` says how many it offers; get the sound for them). */
export function searchRow(
	entry: SoundEntry,
	score: number,
	parts: SoundSearchResponse['results'][number]['parts'],
): SoundSearchResponse['results'][number] {
	if (!entry.takes) return { sound: entry, score, parts };
	const { takes: _takes, ...sound } = entry;
	return { sound, score, parts, takeCount: offeredTakes(entry).length };
}

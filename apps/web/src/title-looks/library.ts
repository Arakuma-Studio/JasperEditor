// Spec 19 TL-086: what the Looks tab and `Graphics ▸ Apply Look…` show: one entry per look, from the factory library, the
// project's own looks and the user's own (TL-054: My Looks, kept by the engine). A project copy of a library or user look
// (TL-015) is that look, not a second card. Pure.
import {
	type Colorway,
	FACTORY_COLORWAYS,
	FACTORY_LOOKS,
	type FactoryLook,
	foldSearchText,
	type LookRecipe,
	lookCategory,
	type ProjectDocument,
	recipeFromAppearance,
	type TitleLook,
	titleLooksOf,
	type UserLook,
} from '@jasper/project';
import { getLanguage, t } from '../i18n/runtime.ts';

export type LookEntry = {
	/** Card key, recents and drag payloads: the id `look.apply` takes. */
	lookId: string;
	source: 'library' | 'project' | 'user';
	name: string;
	category: string;
	tags: readonly string[];
	/** Every colourway it can take: its own, then the library's. Any colourway fits any look (TL-051). */
	colorways: readonly Colorway[];
	/** The colourways its card shows first. */
	cardColorways: readonly Colorway[];
	recipe: LookRecipe;
	/** What its poster says when the selection has no text. */
	sampleText?: string;
	/** Everything search reads. */
	searchText: string;
	/**
	 * A user look is not in the project or the library: `look.apply` takes it whole and copies it into the project, with
	 * the user look's id as its `sourceId`, so applying it again reuses that copy (TL-015).
	 */
	given?: {
		name: string;
		recipe: LookRecipe;
		sourceId: string;
		tags?: string[];
		category?: string;
		colorways?: Colorway[];
	};
};

/** What the factory library may carry beyond the model's fields. */
type LibraryExtras = {
	nameEs?: string;
	description?: string;
	sampleText?: string;
	suggestedColorways?: readonly string[];
};

/** Search folds accents, width and kana as the library's own search does. */
const fold = foldSearchText;
const spanish = () => getLanguage().startsWith('es');
/** The library's category name; an id it does not know (a project's own category) stands as written. */
function categoryName(id: string): string {
	const c = lookCategory(id);
	return (spanish() ? c?.labelEs : c?.label) ?? id;
}

/** Category of looks made in this project. */
export const PROJECT_CATEGORY = 'This Project';
/** Category of the user's own looks (TL-054), in every project. */
export const MY_LOOKS_CATEGORY = 'My Looks';
/** The category as shown: `MY_LOOKS_CATEGORY` follows the language. */
export const myLooksLabel = () => t(MY_LOOKS_CATEGORY);
const UNSORTED_CATEGORY = 'Other';

function allColorways(own: readonly Colorway[] | undefined, shared: readonly Colorway[]): Colorway[] {
	const seen = new Set<string>();
	const out: Colorway[] = [];
	for (const c of [...(own ?? []), ...shared]) {
		if (seen.has(c.id)) continue;
		seen.add(c.id);
		out.push(c);
	}
	return out;
}

/** Every look on offer: the library first, then what only this project has, then the user's own looks. */
export function lookEntries(
	doc: ProjectDocument | null,
	library: readonly FactoryLook[] = FACTORY_LOOKS,
	colorways: readonly Colorway[] = FACTORY_COLORWAYS,
	userLooks: readonly UserLook[] = [],
): LookEntry[] {
	const out: LookEntry[] = library.map((l) => {
		const extra = l as FactoryLook & LibraryExtras;
		const all = allColorways(l.colorways, colorways);
		const category = categoryName(l.category ?? UNSORTED_CATEGORY);
		const tags = l.tags ?? [];
		const wanted = new Set(extra.suggestedColorways ?? []);
		return {
			lookId: l.libraryId,
			source: 'library' as const,
			// The project stores the English name; only what is shown follows the language.
			name: (spanish() ? extra.nameEs : l.name) ?? l.name,
			category,
			tags,
			colorways: all,
			cardColorways: wanted.size ? all.filter((c) => wanted.has(c.id)) : all,
			recipe: l.recipe,
			...(extra.sampleText ? { sampleText: extra.sampleText } : {}),
			searchText: fold([l.name, extra.nameEs ?? '', category, ...tags, extra.description ?? ''].join(' ')),
		};
	});
	const known = new Set([...library.map((l) => l.libraryId), ...userLooks.map((l) => l.id)]);
	for (const l of doc ? titleLooksOf(doc) : []) {
		if (l.sourceId !== undefined && known.has(l.sourceId)) continue;
		out.push(projectEntry(l, colorways));
	}
	for (const l of userLooks) out.push(userEntry(l, colorways));
	return out;
}

function userEntry(l: UserLook, colorways: readonly Colorway[]): LookEntry {
	const all = allColorways(l.colorways as Colorway[] | undefined, colorways);
	const category = myLooksLabel();
	const tags = l.tags ?? [];
	const own = (l.colorways ?? []) as Colorway[];
	return {
		lookId: l.id,
		source: 'user',
		name: l.name,
		category,
		tags,
		colorways: all,
		cardColorways: own.length ? all.filter((c) => own.some((o) => o.id === c.id)) : all,
		recipe: l.recipe,
		searchText: fold([l.name, category, l.category ?? '', ...tags].join(' ')),
		given: {
			name: l.name,
			recipe: l.recipe,
			sourceId: l.id,
			...(tags.length ? { tags: [...tags] } : {}),
			...(l.category ? { category: l.category } : {}),
			...(own.length ? { colorways: own } : {}),
		},
	};
}

function projectEntry(l: TitleLook, colorways: readonly Colorway[]): LookEntry {
	const all = allColorways(l.colorways, colorways);
	const category = l.category ?? PROJECT_CATEGORY;
	const tags = l.tags ?? [];
	return {
		lookId: l.id,
		source: 'project',
		name: l.name,
		category,
		tags,
		colorways: all,
		cardColorways: all,
		recipe: recipeFromAppearance(l.appearance),
		searchText: fold([l.name, category, ...tags].join(' ')),
	};
}

export type LookFilter = { query: string; category: string | null };

/** The looks matching a search (name, category, tags) and a category. */
export function filterLooks(entries: readonly LookEntry[], f: LookFilter): LookEntry[] {
	const words = fold(f.query.trim()).split(/\s+/).filter(Boolean);
	return entries.filter((e) => {
		if (f.category && e.category !== f.category) return false;
		return words.every((w) => e.searchText.includes(w));
	});
}

/** Categories in library order. */
export function lookCategories(entries: readonly LookEntry[]): string[] {
	return [...new Set(entries.map((e) => e.category))];
}

/** Recents in the order they were used; looks that are gone are left out. */
export function recentLooks(entries: readonly LookEntry[], ids: readonly string[]): LookEntry[] {
	const byId = new Map(entries.map((e) => [e.lookId, e]));
	return ids.map((id) => byId.get(id)).filter((e): e is LookEntry => !!e);
}

const RECENTS_KEY = 'jasper.titleLooks.recents';
const MAX_RECENTS = 12;

export function readRecents(): string[] {
	try {
		const raw = JSON.parse(globalThis.localStorage?.getItem(RECENTS_KEY) ?? '[]') as unknown;
		return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

export function rememberRecent(lookId: string): void {
	try {
		const next = [lookId, ...readRecents().filter((x) => x !== lookId)].slice(0, MAX_RECENTS);
		globalThis.localStorage?.setItem(RECENTS_KEY, JSON.stringify(next));
	} catch {
		// storage unavailable: recents last for the session of the panel only
	}
}

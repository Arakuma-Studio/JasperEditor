// Spec 19 TL-086: what the Looks tab and `Graphics ▸ Apply Look…` show: one entry per look, from the factory library and
// the project's own looks. A project copy of a library look (TL-015) is that look, not a second card. Pure.
import * as project from '@jasper/project';
import {
	type Colorway,
	FACTORY_COLORWAYS,
	FACTORY_LOOKS,
	type FactoryLook,
	type LookRecipe,
	type ProjectDocument,
	recipeOfAppearance,
	type TitleLook,
	titleLooksOf,
} from '@jasper/project';

export type LookEntry = {
	/** Card key, recents and drag payloads: the id `look.apply` takes. */
	lookId: string;
	source: 'library' | 'project';
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
};

/** What the factory library may carry beyond the model's fields. */
type LibraryExtras = {
	nameEs?: string;
	description?: string;
	sampleText?: string;
	suggestedColorways?: readonly string[];
};

/** The library's category names and its search folding (accents, width, kana), where the build has them. */
const libraryHelpers = project as unknown as {
	lookCategory?(id: string): { label: string; labelEs?: string } | undefined;
	foldSearchText?(s: string): string;
};
const fold = (s: string) => libraryHelpers.foldSearchText?.(s) ?? s.toLowerCase();
const categoryName = (id: string) => libraryHelpers.lookCategory?.(id)?.label ?? id;

/** Category of looks made in this project. */
export const PROJECT_CATEGORY = 'This Project';
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

/** Every look on offer: the library first, then what only this project has. */
export function lookEntries(
	doc: ProjectDocument | null,
	library: readonly FactoryLook[] = FACTORY_LOOKS,
	colorways: readonly Colorway[] = FACTORY_COLORWAYS,
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
			name: l.name,
			category,
			tags,
			colorways: all,
			cardColorways: wanted.size ? all.filter((c) => wanted.has(c.id)) : all,
			recipe: l.recipe,
			...(extra.sampleText ? { sampleText: extra.sampleText } : {}),
			searchText: fold(
				[l.name, extra.nameEs ?? '', category, ...tags, extra.description ?? ''].join(' '),
			),
		};
	});
	const known = new Set(library.map((l) => l.libraryId));
	for (const l of doc ? titleLooksOf(doc) : []) {
		if (l.sourceId !== undefined && known.has(l.sourceId)) continue;
		out.push(projectEntry(l, colorways));
	}
	return out;
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
		recipe: recipeOfAppearance(l.appearance),
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

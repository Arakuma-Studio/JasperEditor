// Style recipes in the editor (spec 15 EA-010): the user's library lives on the engine (`/api/style-recipes`,
// `<appdir>/style-recipes/`) so every project, window and agent shares it. This store mirrors it (built-ins
// included), refreshes on `styleRecipes.changed` and after its own writes, and keeps what loading the library repaired
// so the editor tells the user once. It also remembers, per project, the parameters each pass dialog last proposed
// with ("Save Current Settings as Recipe…" builds a recipe from them). Without an engine only the built-ins and the
// project's copies exist.
import type { AutomationPassId, StyleRecipeEntry } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	BUILTIN_STYLE_RECIPES,
	builtinStyleRecipe,
	type ProjectDocument,
	projectStyleRecipes,
	type StyleRecipe,
} from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { useEffect } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useEngineOrNull } from '../state/engine.tsx';

export type StyleLibraryState = {
	status: 'offline' | 'loading' | 'ready' | 'error';
	revision: number;
	entries: StyleRecipeEntry[];
	repairs: { action: string; entity: string; detail: string }[];
	readOnly: boolean;
	error: string | null;
};

type StyleEngine = Pick<
	EngineClient,
	'styleRecipes' | 'createStyleRecipe' | 'updateStyleRecipe' | 'duplicateStyleRecipe' | 'deleteStyleRecipe'
>;

const builtinEntries = (): StyleRecipeEntry[] =>
	BUILTIN_STYLE_RECIPES.map((r) => ({
		id: r.id,
		name: r.name,
		source: 'builtin',
		readOnly: true,
		recipe: r as unknown as Record<string, unknown>,
	}));

let store: StoreApi<StyleLibraryState> | null = null;
let client: StyleEngine | null = null;
let loading: Promise<void> | null = null;

export function styleLibrary(): StoreApi<StyleLibraryState> {
	store ??= createStore<StyleLibraryState>(() => ({
		status: 'offline',
		revision: 0,
		entries: builtinEntries(),
		repairs: [],
		readOnly: false,
		error: null,
	}));
	return store;
}

export function connectStyleLibrary(c: StyleEngine | null): void {
	if (c === client) return;
	client = c;
	if (c) void refreshStyleLibrary();
	else styleLibrary().setState({ status: 'offline', entries: builtinEntries(), error: null });
}

export function refreshStyleLibrary(): Promise<void> {
	const c = client;
	if (!c) return Promise.resolve();
	if (loading) return loading;
	const s = styleLibrary();
	if (s.getState().status !== 'ready') s.setState({ status: 'loading' });
	loading = c
		.styleRecipes()
		.then((lib) => {
			if (client !== c) return;
			s.setState({
				status: 'ready',
				revision: lib.revision,
				entries: lib.recipes,
				repairs: lib.repairs,
				readOnly: lib.readOnly,
				error: null,
			});
		})
		.catch((e: unknown) => {
			if (client !== c) return;
			s.setState({ status: 'error', error: (e as Error)?.message ?? String(e) });
		})
		.finally(() => {
			loading = null;
		});
	return loading;
}

function engine(): StyleEngine {
	if (!client) throw new Error('The recipe library is stored by the engine, which is not connected.');
	return client;
}

export async function createLibraryRecipe(
	recipe: StyleRecipe | Record<string, unknown>,
): Promise<StyleRecipeEntry> {
	const e = await engine().createStyleRecipe({ recipe: recipe as Record<string, unknown> });
	await refreshStyleLibrary();
	return e;
}
export async function renameLibraryRecipe(id: string, name: string): Promise<StyleRecipeEntry> {
	const e = await engine().updateStyleRecipe(id, { name });
	await refreshStyleLibrary();
	return e;
}
export async function duplicateLibraryRecipe(id: string): Promise<StyleRecipeEntry> {
	const e = await engine().duplicateStyleRecipe(id, {});
	await refreshStyleLibrary();
	return e;
}
export async function deleteLibraryRecipe(id: string): Promise<void> {
	await engine().deleteStyleRecipe(id);
	await refreshStyleLibrary();
}

/** Keeps the library connected to this window's engine and current with `styleRecipes.changed`. */
export function useStyleLibrary(): StyleLibraryState {
	const e = useEngineOrNull();
	const hosted = e !== null;
	const c = e?.status === 'connected' ? (e.client as StyleEngine) : null;
	useEffect(() => {
		if (hosted) connectStyleLibrary(c);
	}, [hosted, c]);
	const subscribe = e?.subscribe;
	useEffect(
		() =>
			subscribe?.((ev) => {
				if (ev?.type === 'styleRecipes.changed') void refreshStyleLibrary();
			}),
		[subscribe],
	);
	return useStoreSelector(styleLibrary(), (s) => s);
}

/** A recipe the editor can offer: where it lives and whether it can be changed. */
export type RecipeChoice = {
	id: string;
	name: string;
	source: 'builtin' | 'library' | 'project';
	readOnly: boolean;
	newer?: boolean;
	recipe: StyleRecipe | null;
	/** The project keeps another version of this library recipe (the one it last used). */
	projectRevision?: number;
};

/** Built-ins, the library, then the project's copies the library does not have (same id: the project's copy wins). */
export function recipeChoices(doc: ProjectDocument | null, lib: StyleLibraryState): RecipeChoice[] {
	const out: RecipeChoice[] = [];
	const project = doc ? projectStyleRecipes(doc) : { recipes: {}, newer: [] as string[], active: null };
	for (const e of lib.entries) {
		// the library's version is the user's latest; the project keeps the one it last used (offline, other machines)
		const copy = project.recipes[e.id];
		const own = (e.recipe as unknown as StyleRecipe | undefined) ?? null;
		out.push({
			id: e.id,
			name: own ? e.name : (copy?.name ?? e.name),
			source: e.source,
			readOnly: e.readOnly,
			...(e.newer ? { newer: true } : {}),
			recipe: own ?? copy ?? null,
			...(copy && own && copy.revision !== own.revision ? { projectRevision: copy.revision } : {}),
		});
	}
	for (const r of Object.values(project.recipes))
		if (!out.some((x) => x.id === r.id))
			out.push({ id: r.id, name: r.name, source: 'project', readOnly: false, recipe: r });
	for (const id of project.newer)
		if (!out.some((x) => x.id === id))
			out.push({ id, name: id, source: 'project', readOnly: true, newer: true, recipe: null });
	return out;
}

/** The recipe a sequence starts from: the project's active one, else the built-in for its aspect. */
export function defaultRecipeId(doc: ProjectDocument | null, vertical: boolean): string {
	const active = doc ? projectStyleRecipes(doc).active : null;
	if (active) return active;
	return vertical ? 'builtin:fast-shorts' : 'builtin:fast-long-form';
}

export const isBuiltin = (id: string) => builtinStyleRecipe(id) !== null;

// ---------------------------------------------------------------------------------------------------------------
// The pass dialogs' last parameters (per project, this window)

const lastParams = new Map<string, Partial<Record<AutomationPassId, Record<string, unknown>>>>();

/** Remembers what a pass dialog proposed with (the seed and range are run settings, not style). */
export function rememberPassParams(
	projectId: string,
	pass: AutomationPassId,
	params: Record<string, unknown>,
): void {
	const { range: _r, excludeClipIds: _x, ...kept } = params;
	const cur = lastParams.get(projectId) ?? {};
	cur[pass] = JSON.parse(JSON.stringify(kept)) as Record<string, unknown>;
	lastParams.set(projectId, cur);
}

export function lastPassParams(
	projectId: string,
): Partial<Record<AutomationPassId, Record<string, unknown>>> {
	return { ...(lastParams.get(projectId) ?? {}) };
}

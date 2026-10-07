// Effect preset library in the editor (S03:FX-030, S05:EFX-001): the read-only built-ins plus the user library,
// which lives on the engine (`/api/effect-presets`, ARCHITECTURE §4.3 `<appdir>/presets/effect-presets.json`) so it
// persists across projects and sessions and is shared with every window and with agents (jasper-mcp). This store
// mirrors it; it refreshes on `effectPresets.changed` events and after its own writes. Without an engine only the
// built-ins exist (writes fail with an explanation).
import type { EngineClient } from '@jasper/engine-client';
import {
	BUILTIN_EFFECT_PRESETS,
	type EffectPreset,
	type EffectPresetFolder,
	type EffectPresetType,
} from '@jasper/project';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type PresetLibraryState = {
	status: 'offline' | 'loading' | 'ready' | 'error';
	revision: number;
	folders: EffectPresetFolder[];
	presets: EffectPreset[];
	error: string | null;
};

let store: StoreApi<PresetLibraryState> | null = null;
let client: EngineClient | null = null;
let loading: Promise<void> | null = null;

export function presetLibrary(): StoreApi<PresetLibraryState> {
	store ??= createStore<PresetLibraryState>(() => ({
		status: 'offline',
		revision: 0,
		folders: [],
		presets: [],
		error: null,
	}));
	return store;
}

/** Points the library at an engine (the Effects panel / Effect Controls do it on mount) and loads it. */
export function connectPresetLibrary(c: EngineClient | null): void {
	if (c === client) return;
	client = c;
	if (c) void refreshPresets();
	else presetLibrary().setState({ status: 'offline', folders: [], presets: [], error: null });
}

export function refreshPresets(): Promise<void> {
	const c = client;
	if (!c) return Promise.resolve();
	if (loading) return loading;
	const s = presetLibrary();
	if (s.getState().status !== 'ready') s.setState({ status: 'loading' });
	loading = c
		.call('effectPresetsList')
		.then((lib) => {
			s.setState({
				status: 'ready',
				revision: lib.revision,
				folders: lib.folders as EffectPresetFolder[],
				presets: lib.presets as EffectPreset[],
				error: null,
			});
		})
		.catch((e: unknown) => {
			s.setState({ status: 'error', error: (e as Error)?.message ?? String(e) });
		})
		.finally(() => {
			loading = null;
		});
	return loading;
}

export function findPreset(id: string): EffectPreset | undefined {
	return [...BUILTIN_EFFECT_PRESETS, ...presetLibrary().getState().presets].find((p) => p.id === id);
}

function engine(): EngineClient {
	if (!client) throw new Error('Effect presets are stored by the engine, which is not connected.');
	return client;
}

async function write<T>(fn: (c: EngineClient) => Promise<T>): Promise<T> {
	const out = await fn(engine());
	await refreshPresets();
	return out;
}

export function savePreset(preset: EffectPreset, folderId?: string | null): Promise<EffectPreset> {
	return write(
		(c) =>
			c.call('effectPresetCreate', {
				body: { preset: preset as unknown as Record<string, unknown>, ...(folderId ? { folderId } : {}) },
			}) as Promise<EffectPreset>,
	);
}

export function updatePreset(
	id: string,
	patch: { name?: string; description?: string; type?: EffectPresetType; folderId?: string | null },
): Promise<EffectPreset> {
	return write(
		(c) => c.call('effectPresetUpdate', { params: { presetId: id }, body: patch }) as Promise<EffectPreset>,
	);
}

export function deletePreset(id: string): Promise<unknown> {
	return write((c) => c.call('effectPresetDelete', { params: { presetId: id } }));
}

export function createPresetBin(name: string, parentId?: string | null): Promise<EffectPresetFolder> {
	return write(
		(c) =>
			c.call('effectPresetFolderCreate', {
				body: { name, ...(parentId ? { parentId } : {}) },
			}) as Promise<EffectPresetFolder>,
	);
}

export function renamePresetBin(id: string, name: string): Promise<unknown> {
	return write((c) => c.call('effectPresetFolderUpdate', { params: { folderId: id }, body: { name } }));
}

export function deletePresetBin(id: string): Promise<unknown> {
	return write((c) => c.call('effectPresetFolderDelete', { params: { folderId: id } }));
}

export function importPresetFile(
	file: unknown,
	folderId?: string | null,
): Promise<{ presets: unknown[]; errors: { index: number; message: string }[] }> {
	return write((c) => c.call('effectPresetsImport', { body: { file, ...(folderId ? { folderId } : {}) } }));
}

/** Tests: forget the engine and the cached library. */
export function resetPresetLibrary(): void {
	client = null;
	loading = null;
	store?.setState({ status: 'offline', revision: 0, folders: [], presets: [], error: null }, true);
}

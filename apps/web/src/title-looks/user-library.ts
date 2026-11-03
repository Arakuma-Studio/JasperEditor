// Spec 19 TL-054: the user's own looks, kept by the engine (`/api/title-looks`, `<appdir>/presets/title-looks.json`) so
// they last across projects and windows and agents see them too. This store mirrors the engine's library, the way the
// effect preset store does: it refreshes on `titleLooks.changed` and after its own writes. Without an engine there are
// no user looks, and every action that needs one says why it is unavailable instead of failing.
import type { EngineClient } from '@jasper/engine-client';
import { type LookRecipe, MAX_TITLE_LOOK_NAME, type UserLook } from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { useEffect } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';
import { useEngineOrNull } from '../state/engine.tsx';

export type UserLookLibraryState = {
	status: 'offline' | 'loading' | 'ready' | 'error';
	revision: number;
	/** The engine's file was written by a newer build: shown, never changed. */
	readOnly: boolean;
	looks: UserLook[];
	error: string | null;
};

let store: StoreApi<UserLookLibraryState> | null = null;
let client: EngineClient | null = null;
let loading: Promise<void> | null = null;

export function userLookLibrary(): StoreApi<UserLookLibraryState> {
	store ??= createStore<UserLookLibraryState>(() => ({
		status: 'offline',
		revision: 0,
		readOnly: false,
		looks: [],
		error: null,
	}));
	return store;
}

/** Points the library at an engine and loads it; null forgets it (the engine went away). */
export function connectUserLooks(c: EngineClient | null): void {
	if (c === client) return;
	client = c;
	if (c) void refreshUserLooks();
	else userLookLibrary().setState({ status: 'offline', looks: [], readOnly: false, error: null });
}

export function refreshUserLooks(): Promise<void> {
	const c = client;
	if (!c) return Promise.resolve();
	if (loading) return loading;
	const s = userLookLibrary();
	if (s.getState().status !== 'ready') s.setState({ status: 'loading' });
	loading = c
		.call('titleLooksList')
		.then((lib) => {
			// A reply from an engine this store no longer points at is not this library.
			if (client !== c) return;
			s.setState({
				status: 'ready',
				revision: lib.revision,
				readOnly: lib.readOnly,
				looks: lib.looks as UserLook[],
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

/** Connects to `c` when nothing is connected yet (a menu command before the Looks tab was shown), and waits for it. */
export function ensureUserLooks(c: EngineClient): Promise<void> {
	if (!client) connectUserLooks(c);
	return refreshUserLooks();
}

/** The user looks as last read: the drag and palette paths, which run outside React. */
export const currentUserLooks = (): readonly UserLook[] => userLookLibrary().getState().looks;

/**
 * Why the library cannot be changed now, or null. Reading needs a connected engine that answered; writing also needs a
 * file this build may write.
 */
export function userLooksUnavailable(s: UserLookLibraryState = userLookLibrary().getState()): string | null {
	if (!client || s.status === 'offline') return t('My Looks are kept by the engine, which is not connected.');
	if (s.status === 'error') return t('The engine could not read My Looks: {0}', s.error ?? '');
	if (s.status === 'loading') return t('My Looks are still loading.');
	if (s.readOnly) return t('My Looks were saved by a newer JasperEditor and are read-only here.');
	return null;
}

function engine(): EngineClient {
	const why = userLooksUnavailable();
	if (why || !client) throw new Error(why ?? t('My Looks are kept by the engine, which is not connected.'));
	return client;
}

async function write<T>(fn: (c: EngineClient) => Promise<T>): Promise<T> {
	const out = await fn(engine());
	await refreshUserLooks();
	return out;
}

export type UserLookInit = {
	name: string;
	recipe: LookRecipe;
	tags?: string[];
	category?: string;
	colorways?: unknown[];
};

export function saveUserLook(init: UserLookInit): Promise<UserLook> {
	return write((c) => c.call('titleLookSave', { body: init })) as Promise<UserLook>;
}

/**
 * Several looks in one go (imported layer styles): each under a name free in the library and in the batch, then one
 * refresh. Stops at the first refusal and says how many were saved before it.
 */
export async function saveUserLooks(inits: readonly UserLookInit[]): Promise<UserLook[]> {
	const c = engine();
	const taken = new Set(
		userLookLibrary()
			.getState()
			.looks.map((l) => l.name.toLowerCase()),
	);
	const saved: UserLook[] = [];
	try {
		for (const init of inits) {
			const base = init.name.trim().slice(0, MAX_TITLE_LOOK_NAME);
			let name = base;
			for (let i = 2; taken.has(name.toLowerCase()); i++)
				name = `${base.slice(0, MAX_TITLE_LOOK_NAME - ` ${i}`.length)} ${i}`;
			taken.add(name.toLowerCase());
			saved.push((await c.call('titleLookSave', { body: { ...init, name } })) as UserLook);
		}
	} catch (e) {
		const why = (e as Error)?.message ?? String(e);
		throw new Error(saved.length ? t('{0} saved, then: {1}', saved.length, why) : why);
	} finally {
		await refreshUserLooks();
	}
	return saved;
}

export function renameUserLook(id: string, name: string): Promise<UserLook> {
	return write((c) =>
		c.call('titleLookUpdate', { params: { lookId: id }, body: { name } }),
	) as Promise<UserLook>;
}

export function deleteUserLook(id: string) {
	return write((c) => c.call('titleLookDelete', { params: { lookId: id } }));
}

/** A `.json` file of looks (a bundle, a library file, one look or a list): good entries are added, bad ones reported. */
export function importUserLookFile(file: unknown) {
	return write((c) => c.call('titleLooksImport', { body: { file } }));
}

/** The export bundle of these looks (all when `ids` is absent). Reading only: a read-only library still exports. */
export function exportUserLookBundle(ids?: readonly string[]) {
	if (!client)
		return Promise.reject(new Error(t('My Looks are kept by the engine, which is not connected.')));
	return client.call('titleLooksExport', { body: ids ? { ids: [...ids] } : {} });
}

/** Keeps the library connected to this window's engine and current with `titleLooks.changed`. */
export function useUserLooks(): UserLookLibraryState {
	const engineState = useEngineOrNull();
	const hosted = engineState !== null;
	const c = engineState?.status === 'connected' ? engineState.client : null;
	// Outside an EngineProvider (standalone mounts, tests) the library keeps whatever it was connected to.
	useEffect(() => {
		if (hosted) connectUserLooks(c);
	}, [hosted, c]);
	const subscribe = engineState?.subscribe;
	useEffect(
		() =>
			subscribe?.((e) => {
				if (e?.type === 'titleLooks.changed') void refreshUserLooks();
			}),
		[subscribe],
	);
	return useStoreSelector(userLookLibrary(), (s) => s);
}

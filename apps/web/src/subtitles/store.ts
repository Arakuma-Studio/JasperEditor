// spec 13 AS-020: the user's subtitle template library in the editor — it lives on the engine
// (`/api/subtitle-templates`, `<appdir>/presets/subtitle-templates.json`) so every project, window and agent shares it.
// This store mirrors it, refreshes on `subtitleTemplates.changed` and after its own writes. Without an engine only the
// built-ins and the project's templates exist (writes fail with an explanation).
import type { EngineClient } from '@jasper/engine-client';
import type { SubtitleTemplate } from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { useEffect } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useEngineOrNull } from '../state/engine.tsx';

export type SubtitleLibraryState = {
	status: 'offline' | 'loading' | 'ready' | 'error';
	revision: number;
	templates: SubtitleTemplate[];
	error: string | null;
};

let store: StoreApi<SubtitleLibraryState> | null = null;
let client: EngineClient | null = null;
let loading: Promise<void> | null = null;

export function subtitleLibrary(): StoreApi<SubtitleLibraryState> {
	store ??= createStore<SubtitleLibraryState>(() => ({
		status: 'offline',
		revision: 0,
		templates: [],
		error: null,
	}));
	return store;
}

export function connectSubtitleLibrary(c: EngineClient | null): void {
	if (c === client) return;
	client = c;
	if (c) void refreshSubtitleLibrary();
	else subtitleLibrary().setState({ status: 'offline', templates: [], error: null });
}

export function refreshSubtitleLibrary(): Promise<void> {
	const c = client;
	if (!c) return Promise.resolve();
	if (loading) return loading;
	const s = subtitleLibrary();
	if (s.getState().status !== 'ready') s.setState({ status: 'loading' });
	loading = c
		.call('subtitleTemplatesList')
		.then((lib) => {
			if (client !== c) return;
			s.setState({
				status: 'ready',
				revision: lib.revision,
				templates: lib.templates as unknown as SubtitleTemplate[],
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

function engine(): EngineClient {
	if (!client) throw new Error('The template library is stored by the engine, which is not connected.');
	return client;
}

/** Saves a template into the user library (create or replace by id). */
export async function saveToLibrary(t: SubtitleTemplate): Promise<SubtitleTemplate> {
	const saved = await engine().call('subtitleTemplateSave', {
		params: { templateId: t.id },
		body: { template: t as unknown as Record<string, unknown> },
	});
	await refreshSubtitleLibrary();
	return saved as unknown as SubtitleTemplate;
}

export async function deleteFromLibrary(id: string): Promise<void> {
	await engine().call('subtitleTemplateDelete', { params: { templateId: id } });
	await refreshSubtitleLibrary();
}

/** Keeps the library connected to this window's engine and current with `subtitleTemplates.changed`. */
export function useSubtitleLibrary(): SubtitleLibraryState {
	const e = useEngineOrNull();
	const hosted = e !== null;
	const c = e?.status === 'connected' ? e.client : null;
	useEffect(() => {
		if (hosted) connectSubtitleLibrary(c);
	}, [hosted, c]);
	const subscribe = e?.subscribe;
	useEffect(
		() =>
			subscribe?.((ev) => {
				if (ev?.type === 'subtitleTemplates.changed') void refreshSubtitleLibrary();
			}),
		[subscribe],
	);
	return useStoreSelector(subtitleLibrary(), (s) => s);
}

// wp fonts: the engine's font catalog (bundled families + the user font library) mirrored in the editor, shared by
// the Program monitor, the font menus, Preferences ▸ Fonts and Resolve Fonts. Refreshes on `fonts.changed` (another
// window or an agent installed or removed a font) and after its own writes. Installing checks every new face in this
// browser first (the Player and the headless renderer are Chromium): a face the browser refuses is removed again
// and reported, so the library never holds a font whose text would silently fall back.
import {
	type FontCatalog,
	type FontLibraryResponse,
	type FontUsageResponse,
	type LibraryFont,
	resolveCatalogFont,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';

export type FontsState = {
	status: 'offline' | 'loading' | 'ready' | 'error';
	catalog: FontCatalog | null;
	library: FontLibraryResponse | null;
	error: string | null;
};

let store: StoreApi<FontsState> | null = null;
let client: EngineClient | null = null;
let loading: Promise<void> | null = null;

export function fontsStore(): StoreApi<FontsState> {
	store ??= createStore<FontsState>(() => ({ status: 'offline', catalog: null, library: null, error: null }));
	return store;
}

/** Points the store at an engine (hooks do it on mount) and loads it. */
export function connectFonts(c: EngineClient | null): void {
	if (c === client) return;
	client = c;
	if (c) void refreshFonts();
	else fontsStore().setState({ status: 'offline', catalog: null, library: null, error: null });
}

export function refreshFonts(): Promise<void> {
	const c = client;
	if (!c) return Promise.resolve();
	if (loading) return loading;
	const s = fontsStore();
	if (s.getState().status !== 'ready') s.setState({ status: 'loading' });
	loading = Promise.all([c.listFonts(), c.fontLibrary().catch(() => null)])
		.then(([catalog, library]) => {
			if (client !== c) return;
			s.setState({ status: 'ready', catalog, library, error: null });
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
	if (!client) throw new Error(t('Fonts are installed on the engine, which is not connected.'));
	return client;
}

/** Extensions the font library accepts (the engine checks the bytes). */
export const FONT_FILE_ACCEPT =
	'.ttf,.otf,.ttc,.woff,.woff2,font/ttf,font/otf,font/collection,font/woff,font/woff2';
const FONT_EXT = /\.(ttf|otf|ttc|woff2?)$/i;

export function isFontFile(f: { name: string; type?: string }): boolean {
	return FONT_EXT.test(f.name) || /^font\//.test(f.type ?? '');
}

/** Picks font files with the browser's file dialog (resolves [] when cancelled). */
export function pickFontFiles(doc: Document = document): Promise<File[]> {
	return new Promise((resolve) => {
		const input = doc.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.accept = FONT_FILE_ACCEPT;
		input.style.display = 'none';
		const done = () => {
			resolve(Array.from(input.files ?? []));
			input.remove();
		};
		input.addEventListener('change', done, { once: true });
		input.addEventListener('cancel', () => {
			resolve([]);
			input.remove();
		});
		doc.body.appendChild(input);
		input.click();
	});
}

let probeSeq = 0;
/** True when this browser can load the face at `url` (its font sanitiser accepts it). */
async function browserAccepts(url: string): Promise<boolean> {
	if (typeof FontFace === 'undefined') return true; // nothing to check with (tests, workers)
	try {
		const face = new FontFace(`jasper-font-check-${++probeSeq}`, `url('${url}')`);
		await face.load();
		return true;
	} catch {
		return false;
	}
}

export type InstallReport = {
	installed: LibraryFont[];
	existing: LibraryFont[];
	errors: { file: string; message: string }[];
};

/** Installs font files into the user library; never throws (failures are listed per file). */
export async function installFontFiles(files: readonly File[]): Promise<InstallReport> {
	const report: InstallReport = { installed: [], existing: [], errors: [] };
	let c: EngineClient;
	try {
		c = engine();
	} catch (e) {
		report.errors.push({ file: files.map((f) => f.name).join(', '), message: (e as Error).message });
		return report;
	}
	for (const file of files) {
		if (!isFontFile(file)) {
			report.errors.push({ file: file.name, message: 'Not a font file (TTF, OTF, TTC, WOFF or WOFF2)' });
			continue;
		}
		try {
			const r = await c.installFont(file, file.name);
			report.existing.push(...r.existing);
			for (const face of r.installed) {
				if (await browserAccepts(c.url(`/fonts/library/${face.id}.${face.format}`)))
					report.installed.push(face);
				else {
					await c.removeFont(face.id).catch(() => undefined);
					report.errors.push({
						file: file.name,
						message: `"${face.fullName}" was not installed: the renderer cannot draw this font (its browser font check failed)`,
					});
				}
			}
		} catch (e) {
			report.errors.push({ file: file.name, message: (e as Error)?.message ?? String(e) });
		}
	}
	await refreshFonts();
	return report;
}

export async function removeLibraryFont(fontId: string): Promise<void> {
	await engine().removeFont(fontId);
	await refreshFonts();
}

export function libraryFontUsage(fontId: string): Promise<FontUsageResponse> {
	return engine().fontUsage(fontId);
}

/** True when text set in `family` renders with a catalog font (bundled or installed), not the fallback. */
export function isFontAvailable(catalog: FontCatalog | null, family: string): boolean {
	return resolveCatalogFont(catalog, family, 400, false) !== null;
}

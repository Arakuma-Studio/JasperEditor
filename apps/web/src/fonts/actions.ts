// wp fonts: shared actions of the font UI — Add Font… with feedback, the project's font status (Resolve Fonts, the
// font menus' "missing" marks), and the ids of the Fonts preferences page and the Resolve Fonts dialog.
import { type FontCatalog, resolveCatalogFont } from '@jasper/api';
import { documentFontUsage, type FontRef, type FontUse, type ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog, toast } from '@jasper/ui';
import { t } from '../i18n/runtime.ts';
import { PREFERENCES_DIALOG, registerPreferencesDialog } from '../shell/preferences/index.ts';
import { type InstallReport, installFontFiles, isFontFile, pickFontFiles } from './store.ts';

export const FONTS_PREFERENCES_PAGE = 'fonts';
export const RESOLVE_FONTS_DIALOG = 'fonts.resolve';

/** Edit ▸ Preferences ▸ Fonts (the font manager). */
export function openFontPreferences(session: EditorSession | null = null): void {
	registerPreferencesDialog();
	void openDialog(PREFERENCES_DIALOG, { page: FONTS_PREFERENCES_PAGE, session });
}

/** Graphics ▸ Resolve Fonts… for the session's project. */
export function openResolveFonts(session: EditorSession): void {
	void openDialog(RESOLVE_FONTS_DIALOG, { session });
}

/** Installs font files (asks with the file dialog when none are given) and reports the outcome in toasts. */
export async function addFontsWithFeedback(files?: readonly File[]): Promise<InstallReport | null> {
	const list = files ?? (await pickFontFiles());
	if (!list.length) return null;
	const fonts = list.filter(isFontFile);
	const skipped = list.filter((f) => !isFontFile(f));
	const report = fonts.length ? await installFontFiles(fonts) : { installed: [], existing: [], errors: [] };
	for (const f of skipped)
		report.errors.push({ file: f.name, message: 'Not a font file (TTF, OTF, TTC, WOFF or WOFF2)' });
	const n = report.installed.length;
	if (n > 0)
		toast({
			kind: 'success',
			title: n === 1 ? 'Font installed' : `${n} fonts installed`,
			detail: report.installed.map((f) => f.fullName).join(', '),
			dedupeKey: 'fonts.installed',
		});
	else if (report.existing.length > 0 && report.errors.length === 0)
		toast({
			kind: 'info',
			title: 'Already installed',
			detail: report.existing.map((f) => f.fullName).join(', '),
			dedupeKey: 'fonts.installed',
		});
	for (const e of report.errors)
		toast({
			kind: 'error',
			title: t('Could not install {0}', e.file.slice(0, 40)),
			detail: e.message,
			durationMs: 'sticky',
		});
	return report;
}

export type ProjectFontStatus = {
	font: FontRef;
	use: FontUse;
	/** Renders with a bundled or installed font (else the default family). */
	available: boolean;
	/** The catalog family it renders with, when available. */
	resolvedFamily: string | null;
	/** `custom` when it renders with a font of the user library. */
	source: string | null;
};

/** Every font the document registers, used or not, with whether it renders with a catalog font. */
export function projectFontStatus(doc: ProjectDocument, catalog: FontCatalog | null): ProjectFontStatus[] {
	const usage = documentFontUsage(doc);
	return Object.values(doc.fonts)
		.map((font) => {
			const r = resolveCatalogFont(catalog, font.family, 400, false);
			return {
				font,
				use: usage.get(font.id) ?? { clips: 0, tracks: 0 },
				available: r !== null,
				resolvedFamily: r?.family.family ?? null,
				source: r?.family.source ?? null,
			};
		})
		.sort((a, b) => a.font.family.localeCompare(b.font.family));
}

/** Fonts the document's layers use that are neither bundled nor installed (empty while the catalog is unknown). */
export function missingProjectFonts(doc: ProjectDocument, catalog: FontCatalog | null): ProjectFontStatus[] {
	if (!catalog) return [];
	return projectFontStatus(doc, catalog).filter((s) => !s.available && s.use.clips + s.use.tracks > 0);
}

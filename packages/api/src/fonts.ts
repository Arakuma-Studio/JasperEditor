import { z } from 'zod';

export const FontFileSchema = z.object({
	weight: z.number().int(),
	style: z.enum(['normal', 'italic']),
	url: z.string(),
	subset: z.string().optional(),
	/** wp fonts (user font library faces): the face's PostScript name (name ID 6), e.g. "CircularStd-Medium". */
	postscriptName: z.string().optional(),
	/** wp fonts: the face's full name (name ID 4), e.g. "Circular Std Medium". */
	fullName: z.string().optional(),
	/** wp fonts: the legacy family (name ID 1) when it differs from the family, e.g. "Montserrat Light". */
	legacyFamily: z.string().optional(),
	/** wp fonts: id of the library face (`DELETE /api/fonts/library/:fontId`). */
	fontId: z.string().optional(),
});
export type FontFile = z.infer<typeof FontFileSchema>;
export const FontFamilySchema = z.object({
	family: z.string(),
	category: z.string().optional(),
	/** `custom` = the user font library (wp fonts). */
	source: z.enum(['bundled', 'google', 'system', 'custom']),
	weights: z.array(z.number().int()),
	styles: z.array(z.enum(['normal', 'italic'])),
	files: z.array(FontFileSchema),
	/** Text-animators: variation axes of a variable family (tag → user-unit range), for Variable Font Axes. */
	axes: z.record(z.string(), z.object({ min: z.number(), max: z.number(), default: z.number() })).optional(),
});
export type FontFamily = z.infer<typeof FontFamilySchema>;
export const FontCatalogSchema = z.object({ fonts: z.array(FontFamilySchema) });
export type FontCatalog = z.infer<typeof FontCatalogSchema>;

// ── wp fonts: the user font library (app-level, shared by every project; `<appdir>/fonts/`) ──────────────────────

export const FONT_FILE_FORMATS = ['ttf', 'otf', 'woff', 'woff2'] as const;
export const FontAxisSchema = z.object({ min: z.number(), max: z.number(), default: z.number() });

/** One installed face (a collection installs one entry per face). */
export const LibraryFontSchema = z.looseObject({
	/** `f` + 24 hex digits of the SHA-256 of the stored file. */
	id: z.string().regex(/^f[0-9a-f]{24}$/),
	format: z.enum(FONT_FILE_FORMATS),
	family: z.string().min(1).max(128),
	legacyFamily: z.string().min(1).max(128).optional(),
	subfamily: z.string().max(128),
	fullName: z.string().max(128),
	postscriptName: z.string().max(63),
	weight: z.number().int().min(1).max(1000),
	italic: z.boolean(),
	axes: z.record(z.string(), FontAxisSchema).optional(),
	sizeBytes: z.number().int().min(1),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	/** File name it was installed from (a collection: the `.ttc` name). */
	originalName: z.string().max(255),
	/** Face index inside the collection it came from. */
	collectionIndex: z.number().int().min(0).optional(),
	addedAt: z.string(),
});
export type LibraryFont = z.infer<typeof LibraryFontSchema>;

export const FontLibraryLimitsSchema = z.object({
	maxFileBytes: z.number().int(),
	maxFonts: z.number().int(),
	maxTotalBytes: z.number().int(),
});

export const FontLibraryResponseSchema = z.object({
	/** Bumped on every change (the `fonts.changed` event carries it). */
	revision: z.number().int().min(0),
	/** A library index written by a newer build: listed, never rewritten (installs and removals are refused). */
	readOnly: z.boolean(),
	fonts: z.array(LibraryFontSchema),
	totalBytes: z.number().int().min(0),
	limits: FontLibraryLimitsSchema,
	/** What the engine repaired when it opened the library (damaged index, missing or stray files). */
	repairs: z.array(z.string()),
});
export type FontLibraryResponse = z.infer<typeof FontLibraryResponseSchema>;

export const FontInstallResponseSchema = z.object({
	revision: z.number().int().min(0),
	/** Faces added by this request. */
	installed: z.array(LibraryFontSchema),
	/** Faces of the file that were already installed (same bytes). */
	existing: z.array(LibraryFontSchema),
});
export type FontInstallResponse = z.infer<typeof FontInstallResponseSchema>;

/** Install from a file on the engine's machine (local mode: jasper-mcp, the CLI). */
export const FontInstallPathRequestSchema = z.strictObject({ path: z.string().min(1).max(4096) });

export const FontDeleteResponseSchema = z.object({
	ok: z.literal(true),
	removed: z.array(z.string()),
	revision: z.number().int().min(0),
});

/** Saved projects whose fonts resolve to the face (by family, legacy family, full or PostScript name). */
export const FontUsageResponseSchema = z.object({
	projects: z.array(z.object({ projectId: z.string(), name: z.string(), families: z.array(z.string()) })),
	/** Saved projects read; `truncated` when there were more than the engine reads for one answer. */
	scanned: z.number().int().min(0),
	truncated: z.boolean(),
});
export type FontUsageResponse = z.infer<typeof FontUsageResponseSchema>;

// ── Resolution (shared by the engine's exports and the web Player, so both pick the same file) ──────────────────

/** A name compared loosely: case, spaces, hyphens and underscores ignored ("CircularStd-Medium" = "Circular Std Medium"). */
export function normalizeFontName(name: string): string {
	return name.toLowerCase().replace(/[\s\-_]+/g, '');
}

type CatalogLike = {
	fonts: readonly {
		family: string;
		files: readonly Pick<
			FontFile,
			'weight' | 'style' | 'url' | 'subset' | 'postscriptName' | 'fullName' | 'legacyFamily'
		>[];
	}[];
};

export type ResolvedCatalogFont<C extends CatalogLike> = {
	family: C['fonts'][number];
	file: C['fonts'][number]['files'][number];
	/** How the name matched: the family, or one face's PostScript / full / legacy family name. */
	via: 'family' | 'face';
};

/**
 * The catalog file a text style uses (wp fonts, docs/wp-notes/fonts.md §Resolution):
 * 1. a family named exactly `name` (case-insensitive; bundled families come first in the catalog, so they win);
 * 2. a family whose name matches loosely (`normalizeFontName`);
 * 3. a face whose PostScript name, full name or legacy family matches loosely — that face, whatever the weight
 *    (Premiere and other apps store PostScript names such as "Pixel12x10" or "CircularStd-Medium").
 * Within a family: the `latin` subset (or files without one), italic faces for italic text when there are any, then
 * the nearest weight (the first on ties). Null when nothing matches.
 */
export function resolveCatalogFont<C extends CatalogLike>(
	catalog: C | null | undefined,
	name: string,
	weight: number,
	italic: boolean,
): ResolvedCatalogFont<C> | null {
	if (!catalog) return null;
	const exact = name.trim().toLowerCase();
	const loose = normalizeFontName(name);
	if (!loose) return null;
	const fam =
		catalog.fonts.find((f) => f.family.toLowerCase() === exact && f.files.length > 0) ??
		catalog.fonts.find((f) => normalizeFontName(f.family) === loose && f.files.length > 0);
	if (fam) {
		const pool = fam.files.filter((f) => f.subset === undefined || f.subset === 'latin');
		const files = pool.length ? pool : fam.files;
		const wantStyle = italic && files.some((f) => f.style === 'italic') ? 'italic' : 'normal';
		const styled = files.filter((f) => f.style === wantStyle);
		const candidates = styled.length ? styled : files;
		let best = candidates[0]!;
		const w = Number.isFinite(weight) ? weight : 400;
		for (const f of candidates) if (Math.abs(f.weight - w) < Math.abs(best.weight - w)) best = f;
		return { family: fam, file: best, via: 'family' };
	}
	for (const f of catalog.fonts)
		for (const file of f.files) {
			const names = [file.postscriptName, file.fullName, file.legacyFamily];
			if (names.some((n) => n !== undefined && normalizeFontName(n) === loose))
				return { family: f, file, via: 'face' };
		}
	return null;
}

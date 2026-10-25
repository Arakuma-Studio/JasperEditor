// wp fonts: the user font library for agents — the same app-level library as Edit ▸ Preferences ▸ Fonts (shared by
// every project and editor window). list_fonts shows the bundled families and the installed fonts, and with a
// projectId which of the project's fonts are missing; install_font adds a font file from this machine; remove_font
// deletes one (the user approves it in an open editor window). Documents name fonts by family or PostScript name, so
// installing a font makes existing projects render with it without editing them.
import { isAbsolute } from 'node:path';
import { type FontCatalog, type FontLibraryResponse, resolveCatalogFont } from '@jasper/api';
import { documentFontUsage } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT_IDEMPOTENT,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const FONTS_GUIDE = `Fonts (Edit ▸ Preferences ▸ Fonts, Graphics ▸ Resolve Fonts…):
- Text renders with a bundled family (Inter, Source Sans 3, Roboto, Montserrat, Open Sans, Lato, Poppins, Oswald, Playfair Display, JetBrains Mono, Inter Variable) or a font of the user's font library — installed once, available in every project, like fonts installed on the computer. A text style names its font by family; Premiere-style PostScript names ("CircularStd-Medium", "Pixel12x10") and full names reach the matching installed face. Anything else renders with the default family (Source Sans 3) and exports warn FONT_FALLBACK naming the missing fonts.
- list_fonts lists the bundled families and the installed fonts (fontId, family, style, weight, PostScript name, file); with projectId it also lists the project's fonts and which are missing (and how many layers use them).
- install_font {path} installs a TTF, OTF, TTC (one entry per face), WOFF or WOFF2 file from this machine (absolute path). The project's text set in that family or PostScript name renders with it at once — no project edit needed. Same bytes again = already installed; a different file with an installed face's PostScript name is refused (E_FONT_EXISTS: remove that one first).
- Set a text layer's font with add_text {font} or apply_commands [{type: "font.add", family, ref: "$f"}, {type: "clip.update", clipIds, patch: {content: {style: {fontId: "$f"}}}}] (one undo step).
- remove_font {fontId} deletes a font from the library (not undoable; only when the user asks): it needs the user's approval in an open editor window, whose card names the saved projects that use it.`;

type Face = FontLibraryResponse['fonts'][number];

function faceSummary(f: Face) {
	return {
		fontId: f.id,
		family: f.family,
		style: f.subfamily,
		weight: f.weight,
		italic: f.italic,
		postscriptName: f.postscriptName,
		fullName: f.fullName,
		format: f.format,
		...(f.axes ? { variableAxes: f.axes } : {}),
		sizeBytes: f.sizeBytes,
		file: f.originalName,
		...(f.collectionIndex !== undefined ? { collectionFace: f.collectionIndex } : {}),
	};
}

const matches = (q: string | undefined, ...names: (string | undefined)[]) =>
	!q || names.some((n) => n?.toLowerCase().includes(q.toLowerCase()));

function engineError(e: unknown): never {
	const err = e as { code?: string; message?: string };
	if (err?.code === 'FONT_EXISTS')
		throw new ToolError(
			'E_FONT_EXISTS',
			err.message ?? 'A different font with that PostScript name is installed',
			'Remove the installed one first (remove_font), only if the user wants it replaced.',
		);
	if (err?.code === 'FONT_INVALID' || err?.code === 'FONT_UNSUPPORTED' || err?.code === 'FONT_TOO_LARGE')
		throw new ToolError(
			'E_INVALID_PARAM',
			err.message ?? 'Not an installable font file',
			'Give a TTF, OTF, TTC, WOFF or WOFF2 file (at most 64 MB).',
		);
	if (err?.code === 'FONT_LIBRARY_FULL')
		throw new ToolError(
			'E_LIMIT',
			err.message ?? 'The font library is full',
			'Ask the user to remove fonts they no longer need.',
		);
	throw e;
}

export function registerFontTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_fonts',
		{
			title: 'List fonts',
			description:
				"The fonts text can use: bundled families and the user's installed fonts (fontId, family, style, weight, PostScript name, file). With projectId, also the project's fonts: which are available (and what they render with) and which are missing, with the number of layers using each. query filters by name.",
			input: {
				projectId: ProjectIdArg.optional(),
				query: z.string().max(200).optional().describe('Words of a family, full or PostScript name'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, query }) => {
			const [catalog, library] = (await ctx.engine((c) => Promise.all([c.listFonts(), c.fontLibrary()]))) as [
				FontCatalog,
				FontLibraryResponse,
			];
			const bundled = catalog.fonts
				.filter((f) => f.source !== 'custom' && matches(query, f.family))
				.map((f) => ({
					family: f.family,
					weights: f.weights,
					styles: f.styles,
					...(f.axes ? { variableAxes: f.axes } : {}),
				}));
			const installed = library.fonts
				.filter((f) => matches(query, f.family, f.fullName, f.postscriptName, f.legacyFamily))
				.map(faceSummary);
			let project: unknown;
			if (projectId) {
				const { doc } = await loadDoc(ctx, projectId);
				const usage = documentFontUsage(doc);
				project = Object.values(doc.fonts)
					.filter((f) => matches(query, f.family))
					.map((f) => {
						const r = resolveCatalogFont(catalog, f.family, 400, false);
						const u = usage.get(f.id) ?? { clips: 0, tracks: 0 };
						return {
							fontId: f.id,
							family: f.family,
							status: r ? 'available' : 'missing',
							...(r
								? {
										rendersWith: r.family.family,
										source: r.family.source === 'custom' ? 'installed' : 'bundled',
									}
								: {}),
							layers: u.clips,
							captionTracks: u.tracks,
						};
					});
			}
			return jsonResult({
				bundled,
				installed,
				library: {
					fonts: library.fonts.length,
					totalBytes: library.totalBytes,
					limits: library.limits,
					readOnly: library.readOnly,
					...(library.repairs.length ? { repairs: library.repairs } : {}),
				},
				...(project ? { projectFonts: project } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'install_font',
		{
			title: 'Install font',
			description:
				"Installs a font file from this machine into the user's font library (available in every project; TTF, OTF, TTC, WOFF, WOFF2, at most 64 MB). Text set in its family or PostScript name renders with it at once. Same bytes again report the face as already installed.",
			input: {
				path: z
					.string()
					.min(1)
					.max(4096)
					.refine((p) => isAbsolute(p), 'path must be absolute')
					.describe('Absolute path of the font file'),
			},
			annotations: { ...EDIT_IDEMPOTENT, openWorldHint: false },
		},
		async ({ path }) => {
			const r = await ctx.engine((c) => c.installFontPath(path)).catch(engineError);
			return jsonResult({
				installed: r.installed.map(faceSummary),
				alreadyInstalled: r.existing.map(faceSummary),
			});
		},
	);

	defineTool(
		ctx,
		'remove_font',
		{
			title: 'Remove font',
			description:
				"Removes a font from the user's font library (not undoable; text set in it falls back to the default family). Only when the user asks: it needs their approval in an open JasperEditor window (E_APPROVAL_DENIED without one).",
			input: {
				fontId: z
					.string()
					.regex(/^f[0-9a-f]{24}$/)
					.describe('fontId from list_fonts'),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ fontId }) => {
			const r = await ctx.engine((c) => c.removeFont(fontId)).catch(engineError);
			return jsonResult({ ok: true, removed: r.removed });
		},
	);
}

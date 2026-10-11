// Workstream polish: the Media Browser for agents. `browse_media_files` lists a folder on the engine host (the
// same listing as the Media Browser panel) so an agent can find footage before `import_media`; local engines only.
import { BROWSE_PREVIEWABLE, BrowseCategorySchema, type BrowseEntry } from '@jasper/api';
import { z } from 'zod';
import { defineTool, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult } from '../errors.ts';

export const POLISH_GUIDE = `Finding media: browse_media_files lists a folder on the engine's computer (sub-folders and only the files JasperEditor imports, with size and kind: video, audio, image, graphics, captions, timeline, lut, model); without a path it answers the places to start from (Home, media folders, volumes). probe:true adds duration, frame size, frame rate and codecs for up to 20 audio / video / image files. Pass the paths you choose to import_media. It only works with a local engine (the same rule as import by path).`;

const PROBE_MAX = 20;

export function registerPolishTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'browse_media_files',
		{
			title: 'Browse media files',
			description:
				'Lists a folder on the engine host: sub-folders and importable files (name, path, kind, size, modified). Without `path` it returns the places to start from (Home, media folders, volumes, file-system root). `kind` filters the files; `probe` adds duration / size / frame rate / codecs for up to 20 files. Read-only; local engines only. Import the chosen paths with import_media.',
			input: {
				path: z
					.string()
					.min(1)
					.optional()
					.describe('Absolute folder on the engine host; omit for the places'),
				kind: BrowseCategorySchema.optional().describe('Only files of this kind (folders are always listed)'),
				probe: z
					.boolean()
					.optional()
					.describe('Add the ffprobe summary of up to 20 audio / video / image files'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(2000)
					.optional()
					.describe('At most this many entries (default 200)'),
			},
			annotations: READ_ONLY,
		},
		async ({ path, kind, probe, limit }) => {
			if (!path) {
				const r = await ctx.engine((c) => c.browseRoots());
				return jsonResult({
					home: r.home,
					places: r.roots,
					next: 'Call browse_media_files with one of these paths.',
				});
			}
			// Importable media only: an agent never gets the listing of every file of a folder (docs/security-review.md).
			const list = await ctx.engine((c) => c.browseList(path));
			const max = limit ?? 200;
			const matching = list.entries.filter((e) => e.kind === 'folder' || !kind || e.category === kind);
			const shown = matching.slice(0, max);
			const info = new Map<string, unknown>();
			if (probe) {
				const files = shown
					.filter(
						(e): e is BrowseEntry => e.kind === 'file' && !!e.category && BROWSE_PREVIEWABLE.has(e.category),
					)
					.slice(0, PROBE_MAX);
				for (const f of files) {
					try {
						const i = await ctx.engine((c) => c.browseInfo(f.path));
						info.set(f.path, i.media ?? { error: i.error ?? 'not readable' });
					} catch (e) {
						info.set(f.path, { error: e instanceof Error ? e.message : String(e) });
					}
				}
			}
			return jsonResult({
				path: list.path,
				parent: list.parent,
				entries: shown.map((e) => ({
					name: e.name,
					path: e.path,
					kind: e.kind === 'folder' ? 'folder' : (e.category ?? 'other'),
					...(e.size !== null ? { sizeBytes: e.size } : {}),
					...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {}),
					...(info.has(e.path) ? { media: info.get(e.path) } : {}),
				})),
				total: matching.length,
				...(matching.length > shown.length || list.truncated ? { truncated: true } : {}),
			});
		},
	);
}

// Workstream `gaps` (docs/wp-notes/gaps.md): Edit Original, scratch disks, proxies, Project Manager, Export Frame,
// Warp Stabilizer and Auto Reframe analysis contracts.
import { z } from 'zod';

// ---------------------------------------------------------------- Edit Original (UI-5)

/** `GET /api/media/:mediaKey/location`: where the media's bytes are on the engine host. */
export const MediaLocationSchema = z.object({
	mediaKey: z.string(),
	/** Absolute path on the engine host; null when the media is offline. */
	path: z.string().nullable(),
	exists: z.boolean(),
	/** Whether the engine can open files with the host's applications (local engines only). */
	canOpen: z.boolean(),
});
export type MediaLocation = z.infer<typeof MediaLocationSchema>;

/** `POST /api/media/:mediaKey/open`: `reveal` = show it in the file browser, `open` = open it in its default app. */
export const MediaOpenRequestSchema = z.object({ action: z.enum(['reveal', 'open']).default('reveal') });
export type MediaOpenRequest = z.infer<typeof MediaOpenRequestSchema>;
export const MediaOpenResponseSchema = z.object({
	ok: z.literal(true),
	path: z.string(),
	action: z.enum(['reveal', 'open']),
});
export type MediaOpenResponse = z.infer<typeof MediaOpenResponseSchema>;

// ---------------------------------------------------------------- Project Settings ▸ Scratch Disks (PRJ-4)

/** One scratch location: where it is on the engine host and the space left there. */
export const ScratchLocationSchema = z.object({
	/** Absolute folder (null on a remote engine: paths are not exposed). */
	path: z.string().nullable(),
	exists: z.boolean(),
	writable: z.boolean(),
	freeBytes: z.number().nullable(),
});
export type ScratchLocation = z.infer<typeof ScratchLocationSchema>;

/** `GET /api/projects/:projectId/scratch`: the engine folders behind the Scratch Disks page. */
export const ScratchInfoSchema = z.object({
	local: z.boolean(),
	/** "Same as Project" for Captured and Generated Media (proxies, frames, Project Manager, ingest). */
	projectMedia: ScratchLocationSchema,
	/** Video and audio render previews (in the media cache). */
	previews: ScratchLocationSchema,
	mediaCache: ScratchLocationSchema,
	/** Saved versions (Project Auto Save). */
	autoSave: ScratchLocationSchema,
	/** The engine host's home folder (folder pickers start there). */
	home: z.string().nullable(),
});
export type ScratchInfo = z.infer<typeof ScratchInfoSchema>;

/** `POST /api/scratch/check`: whether a folder can take generated media (created when `create`). */
export const ScratchCheckRequestSchema = z.object({
	path: z.string().min(1).max(4096),
	create: z.boolean().optional(),
});
export const ScratchCheckSchema = ScratchLocationSchema.extend({
	ok: z.boolean(),
	message: z.string().optional(),
});
export type ScratchCheck = z.infer<typeof ScratchCheckSchema>;

// ---------------------------------------------------------------- Proxies and ingest (PRJ-8)

/**
 * Where Create Proxies / ingest writes: `next-to-media` = a `Proxies` (or `Ingested Media`) folder beside the source
 * (managed uploads fall back to the project), `project` = the project's scratch media folder (Project Settings ▸
 * Scratch Disks, default "Same as Project"), `folder` = `folder`.
 */
export const MediaJobDestinationSchema = z.object({
	mode: z.enum(['next-to-media', 'project', 'folder']),
	folder: z.string().min(1).max(4096).optional(),
});
export type MediaJobDestination = z.infer<typeof MediaJobDestinationSchema>;

/**
 * `POST /api/media-jobs` → 202 EngineJob kind `proxy-create`: one job over several media. `op`: `proxy` (Create
 * Proxies / ingest proxies, preset from `PROXY_PRESETS`), `transcode` (ingest Transcode, full size), `copy` (ingest
 * Copy: byte copy verified by fingerprint). The result lists each output as RegisteredMedia; the client attaches
 * proxies (`media.attachProxy`) or relinks copies / transcodes (`media.relink`).
 */
export const MediaJobRequestSchema = z.object({
	projectId: z.string().optional(),
	op: z.enum(['proxy', 'transcode', 'copy']),
	preset: z.string().max(64).optional(),
	destination: MediaJobDestinationSchema,
	items: z
		.array(
			z.object({
				mediaKey: z.string().min(1),
				mediaId: z.string().min(1),
				name: z.string().max(400).optional(),
			}),
		)
		.min(1)
		.max(2000),
});
export type MediaJobRequest = z.infer<typeof MediaJobRequestSchema>;

export const MediaJobResultSchema = z.object({
	op: z.enum(['proxy', 'transcode', 'copy']),
	preset: z.string().nullable(),
	outputs: z.array(z.object({ mediaId: z.string(), path: z.string(), registered: z.unknown() })),
	skipped: z.array(z.object({ mediaId: z.string(), reason: z.string() })),
});
export type MediaJobResult = z.infer<typeof MediaJobResultSchema>;

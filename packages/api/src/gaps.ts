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

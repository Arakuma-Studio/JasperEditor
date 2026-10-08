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

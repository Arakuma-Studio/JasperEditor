// spec 13 AS-020: the user's subtitle template library (shared by every project). Built-ins come from @jasper/project.
import { SubtitleTemplateSchema } from '@jasper/project';
import { z } from 'zod';

export const SubtitleTemplateLibraryResponseSchema = z.object({
	/** Bumped on every change (the `subtitleTemplates.changed` event carries it). */
	revision: z.number().int().min(0),
	templates: z.array(SubtitleTemplateSchema),
});
export type SubtitleTemplateLibraryResponse = z.infer<typeof SubtitleTemplateLibraryResponseSchema>;

/** Save as Template… / Save to Library: a template JSON (validated with `parseSubtitleTemplate`); upsert by id. */
export const SubtitleTemplateSaveRequestSchema = z.object({ template: z.record(z.string(), z.unknown()) });

export const SubtitleTemplateDeleteResponseSchema = z.object({ ok: z.literal(true), removed: z.string() });

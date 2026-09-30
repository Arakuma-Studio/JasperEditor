// Motion-graphics rendering contract (ARCHITECTURE §10.2, S04 §15): `jasper-mg` spec and engine routes.
import { z } from 'zod';
import { RationalSchema } from './common.ts';

/** Spec piped to `jasper-mg render --spec -` (ARCHITECTURE §10.2). */
export const MgRenderSpecSchema = z.object({
	template: z.object({ id: z.string().min(1), version: z.number().int() }),
	params: z.record(z.string(), z.unknown()),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	fps: RationalSchema,
	durationFrames: z.number().int().positive(),
	sourceInFrames: z.number().int().min(0).optional(),
});
export type MgRenderSpec = z.infer<typeof MgRenderSpecSchema>;

export const MgTemplateCatalogEntrySchema = z.object({
	id: z.string(),
	version: z.number().int(),
	name: z.string(),
	category: z.string(),
	/** JSON Schema of the params (from the TS twin or `jasper-mg schema`). */
	paramsSchema: z.record(z.string(), z.unknown()),
	defaults: z.record(z.string(), z.unknown()),
	introFrames: z.number().int().min(0).optional(),
	outroFrames: z.number().int().min(0).optional(),
	canvases: z.array(z.string()),
});
export type MgTemplateCatalogEntry = z.infer<typeof MgTemplateCatalogEntrySchema>;

export const MgTemplatesResponseSchema = z.object({
	templates: z.array(MgTemplateCatalogEntrySchema),
	renderer: z.object({
		status: z.enum(['ready', 'unavailable']),
		version: z.string().optional(),
		reason: z.string().optional(),
	}),
});
export type MgTemplatesResponse = z.infer<typeof MgTemplatesResponseSchema>;

export const MgRenderRequestSchema = z.object({
	spec: MgRenderSpecSchema,
	quality: z.enum(['preview', 'master']),
});
export type MgRenderRequest = z.infer<typeof MgRenderRequestSchema>;
/** `EngineJob.result` of an mg-render job. */
export const MgRenderResultSchema = z.object({ key: z.string(), url: z.string() });
export type MgRenderResult = z.infer<typeof MgRenderResultSchema>;

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

/** A named param preset of a template: `params` holds what it changes (the defaults fill the rest). */
export const MgTemplatePresetSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1),
	description: z.string().optional(),
	params: z.record(z.string(), z.unknown()),
});
export type MgTemplatePresetEntry = z.infer<typeof MgTemplatePresetSchema>;

/** UI hints of a template's params (groups, labels, tooltips, multi-line, visibility, custom controls). */
export const MgTemplateUiSchema = z.object({
	groups: z
		.array(z.object({ id: z.string().min(1), label: z.string().min(1), params: z.array(z.string()) }))
		.optional(),
	params: z
		.record(
			z.string(),
			z.object({
				label: z.string().optional(),
				description: z.string().optional(),
				multiline: z.boolean().optional(),
				visibleWhen: z.object({ param: z.string(), in: z.array(z.unknown()) }).optional(),
				control: z.string().optional(),
			}),
		)
		.optional(),
});

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
	/** Default clip length when inserted from the Motion Templates panel (S05:MGT-002). */
	defaultDurationSeconds: z.number().positive().optional(),
	description: z.string().optional(),
	canvases: z.array(z.string()),
	/** True = rendered by the `jasper-mg` binary; false = TS twin only (binary unavailable). */
	native: z.boolean().optional(),
	/** `anime` templates are drawn by `@jasper/motion` and baked by layer-bake; absent = fframes. */
	renderer: z.enum(['fframes', 'anime']).optional(),
	/** Named param presets (gallery cards; `"<id>:<preset>"` in add_motion_graphic). */
	presets: z.array(MgTemplatePresetSchema).optional(),
	/** UI hints of the params (Properties / Effect Controls). */
	ui: MgTemplateUiSchema.optional(),
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

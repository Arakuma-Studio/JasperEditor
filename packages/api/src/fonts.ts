// Font catalog served by the engine (ARCHITECTURE §9.2, S04 §18).
import { z } from 'zod';

export const FontFileSchema = z.object({
	weight: z.number().int(),
	style: z.enum(['normal', 'italic']),
	url: z.string(),
	subset: z.string().optional(),
});
export const FontFamilySchema = z.object({
	family: z.string(),
	category: z.string().optional(),
	source: z.enum(['bundled', 'google', 'system', 'custom']),
	weights: z.array(z.number().int()),
	styles: z.array(z.enum(['normal', 'italic'])),
	files: z.array(FontFileSchema),
	/** text-animators: variation axes of a variable family (tag → user-unit range), for Variable Font Axes. */
	axes: z.record(z.string(), z.object({ min: z.number(), max: z.number(), default: z.number() })).optional(),
});
export type FontFamily = z.infer<typeof FontFamilySchema>;
export const FontCatalogSchema = z.object({ fonts: z.array(FontFamilySchema) });
export type FontCatalog = z.infer<typeof FontCatalogSchema>;

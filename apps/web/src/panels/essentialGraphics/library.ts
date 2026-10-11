import { GraphicTemplateSchema } from '@jasper/project';
import { z } from 'zod';

const GraphicLibraryEntrySchema = z.object({
	id: z.string().min(1),
	template: GraphicTemplateSchema,
	savedAt: z.string(),
});
export type GraphicLibraryEntry = z.infer<typeof GraphicLibraryEntrySchema>;

export function parseGraphicLibrary(raw: unknown): GraphicLibraryEntry[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry: unknown) => {
		const parsed = GraphicLibraryEntrySchema.safeParse(entry);
		return parsed.success ? [parsed.data] : [];
	});
}

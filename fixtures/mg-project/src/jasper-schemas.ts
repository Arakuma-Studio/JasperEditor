// Props schemas of the fixture compositions, read by JasperEditor (package.json → "jasper.schemas", S08:MGC-011).
// A Record<compositionId, ZodType>; Badge has none on purpose (its form is inferred from defaultProps).
import { z } from 'zod';

export const titleSchema = z.object({
	title: z.string().min(1).max(80).describe('Headline text'),
	accent: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/)
		.describe('Accent colour (#rrggbb)'),
	delay: z.number().int().min(0).max(60).describe('Frames before the title enters'),
});

export type TitleProps = z.infer<typeof titleSchema>;

export default { Title: titleSchema };

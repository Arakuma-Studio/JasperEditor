// Props schemas of the fixture compositions, read by JasperEditor (package.json → "jasper.schemas", S08:MGC-011).
// A Record<compositionId, ZodType>; Badge has none on purpose (its form is inferred from defaultProps).
// LowerThird (wp-m3-mgtext) exercises the text layer conventions.
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

const hex = () => z.string().regex(/^#[0-9a-fA-F]{6}$/);

// Hybrid text layers (S08:MGC-036): `name` is a text object (its siblings style it), `role` has prefixed style
// props (roleColor, roleSize); jasper.mg.json adds labels, soft limits and the quote's safe box.
export const lowerThirdSchema = z.object({
	name: z.object({
		text: z.string().min(1).max(60).describe('Person name'),
		color: hex().describe('Name colour'),
		fontSize: z.number().int().min(24).max(160),
		fontFamily: z.string().min(1),
		fontWeight: z.number().int().min(100).max(900),
		align: z.enum(['left', 'center', 'right']),
	}),
	role: z.string().max(80).describe('Role or title under the name'),
	roleColor: hex(),
	roleSize: z.number().int().min(16).max(96),
	quote: z.string().max(200).describe('Quote above the panel'),
	accent: hex().describe('Panel accent colour'),
});

export type LowerThirdProps = z.infer<typeof lowerThirdSchema>;

export default { Title: titleSchema, LowerThird: lowerThirdSchema };

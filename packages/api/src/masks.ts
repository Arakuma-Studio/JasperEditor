import { Vec2Schema } from '@jasper/project';
import { z } from 'zod';

export const MaskTraceRequestSchema = z.object({
	mediaKey: z.string(),
	/** Source frame (0 for stills). */
	frame: z.number().int().min(0),
	/** Size the picture is traced at (the clip's layer box, display orientation). */
	width: z.number().int().min(1).max(8192),
	height: z.number().int().min(1).max(8192),
	/** Traced field: the alpha channel, Rec. 709 luminance or one colour channel (straight × alpha). */
	channel: z.enum(['alpha', 'luma', 'red', 'green', 'blue']).default('alpha'),
	/** Inside where the field ≥ threshold (0..1). */
	threshold: z.number().min(0).max(1).default(0.5),
	invert: z.boolean().default(false),
	/** Douglas–Peucker tolerance (px of the traced size). */
	tolerance: z.number().min(0.01).max(100).default(1),
	/** Outlines with a smaller area (px²) are dropped. */
	minArea: z.number().min(0).default(10),
	/** 0 = polygons, 1 = fully smooth Béziers. */
	cornerRoundness: z.number().min(0).max(1).default(0.5),
	/** At most this many outlines (largest first within a nesting depth). */
	maxPaths: z.number().int().min(1).max(500).default(50),
});
export type MaskTraceRequest = z.infer<typeof MaskTraceRequestSchema>;

export const TracedMaskPathSchema = z.object({
	path: z.object({
		closed: z.boolean(),
		vertices: z.array(z.object({ p: Vec2Schema, in: Vec2Schema, out: Vec2Schema })),
	}),
	depth: z.number().int().min(0),
	area: z.number(),
});

export const MaskTraceResponseSchema = z.object({
	/** Paths in normalised layer coordinates (0..1 over the traced size); depth odd = a hole. */
	paths: z.array(TracedMaskPathSchema),
	/** Outlines found before `maxPaths` was applied. */
	total: z.number().int().min(0),
});
export type MaskTraceResponse = z.infer<typeof MaskTraceResponseSchema>;

// Layer bake contracts (M2, S11 §6, ARCHITECTURE §20.5). Owner: wp-m2-layer-bake.
// DOM layers (text, shapes, anime templates) are exported natively through cached alpha masters; the preview of a
// colour-graded DOM layer is a VP9-alpha WebM requested by the web runtime (S11:LBK-010, S08:MGC-023 pattern).
import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

/**
 * `POST /api/layer-bake/preview` → EngineJob (kind `layer-bake`; `?wait=1` answers the finished job). The engine
 * plans the clip from the inline document like an export (`envelope` + `sequenceId`), bakes the layer if needed and
 * encodes its graded preview. The clip must be a DOM layer with colour effects.
 */
export const LayerBakePreviewRequestSchema = z.looseObject({
	projectId: z.string().optional(),
	sequenceId: z.string().min(1),
	clipId: z.string().min(1),
	/** The document (as for exports). */
	envelope: EnvelopeSchema,
});
export type LayerBakePreviewRequest = z.infer<typeof LayerBakePreviewRequestSchema>;

const RectSchema = z.object({
	x: z.number().int(),
	y: z.number().int(),
	w: z.number().int().positive(),
	h: z.number().int().positive(),
});

/** `EngineJob.result` of a preview job. */
export const LayerBakePreviewResultSchema = z.object({
	/** Key of the graded entry (`/mg/layers/<key>/preview.webm`). */
	key: z.string(),
	/** Key of the ungraded bake it was made from. */
	sourceKey: z.string(),
	previewUrl: z.string(),
	/** Preview frame 0 = the clip's first drawn frame (`start − headHandle`); this is always 0. */
	startFrame: z.number().int(),
	durationFrames: z.number().int().positive(),
	/** Region of the sequence frame the preview covers (null = the whole frame); the WebM is half its size. */
	rect: RectSchema.nullable(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});
export type LayerBakePreviewResult = z.infer<typeof LayerBakePreviewResultSchema>;

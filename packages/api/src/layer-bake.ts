// Layer bake contracts (M2, S11 §6, ARCHITECTURE §20.5). Owner: wp-m2-layer-bake.
// DOM layers (text, shapes, anime templates) are exported natively through cached alpha masters; the preview of a
// colour-graded DOM layer is a VP9-alpha WebM requested by the web runtime (S11:LBK-010, S08:MGC-023 pattern).
import { z } from 'zod';

/**
 * `POST /api/layer-bake/preview` → EngineJob (kind `layer-bake`). Contracts fix the envelope only (loose: the owner
 * adds the render inputs).
 */
export const LayerBakePreviewRequestSchema = z.looseObject({
	projectId: z.string().optional(),
	sequenceId: z.string().optional(),
	clipId: z.string().min(1),
});
export type LayerBakePreviewRequest = z.infer<typeof LayerBakePreviewRequestSchema>;

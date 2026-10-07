// imports workstream (docs/wp-notes/imports.md): interpreted media variants, image sequences, layered documents
// (PSD), vector pages and Lottie export.
import { LayeredInfoSchema, RationalSchema, VectorInfoSchema } from '@jasper/project';
import { z } from 'zod';
import { RegisteredMediaSchema } from './media.ts';

// ---------------------------------------------------------------- interpreted variants

/**
 * Pictures the engine makes for an interpretation the browser cannot apply (Interpret Footage ▸ field order / alpha,
 * and still formats a browser cannot decode): `display` = full-size straight-alpha PNG of a still (16-bit when the
 * source is deeper), `proxy` = 720p preview of a video (VP9 with alpha when it has one), `master` = full-size ProRes
 * of a video for the Remotion render path. `variant` = `pixelVariantKey(...)` ('' = no pixel interpretation).
 */
export const MEDIA_VARIANT_KINDS = ['display', 'proxy', 'master'] as const;
export const MediaVariantKindSchema = z.enum(MEDIA_VARIANT_KINDS);
export type MediaVariantKind = z.infer<typeof MediaVariantKindSchema>;

export const MediaVariantRequestSchema = z.object({
	kind: MediaVariantKindSchema,
	variant: z.string().max(80),
});
export type MediaVariantRequest = z.infer<typeof MediaVariantRequestSchema>;

export const MediaVariantStatusSchema = z.object({
	state: z.enum(['ready', 'queued', 'running', 'failed']),
	url: z.string().optional(),
	jobId: z.string().optional(),
	error: z.string().optional(),
});
export type MediaVariantStatus = z.infer<typeof MediaVariantStatusSchema>;

export const MediaVariantReadyEventSchema = z.object({
	mediaKey: z.string(),
	kind: MediaVariantKindSchema,
	variant: z.string(),
	url: z.string(),
});

// ---------------------------------------------------------------- image sequences

/**
 * `POST /api/imports/image-sequence`: numbered stills → one clip. Either `path` (engine host: one frame of the
 * sequence; its numbered siblings in the folder are found) or `paths` (the frames themselves), or `uploadIds`
 * (uploads created with purpose `sequence-frame`). The frames are conformed into a lossless intermediate at
 * `frameRate`; numbers missing inside the range hold the previous frame. Job kind `image-sequence`; result
 * `RegisteredMedia` (with `imageSequence`).
 */
export const ImageSequenceRequestSchema = z
	.object({
		projectId: z.string().optional(),
		path: z.string().min(1).optional(),
		paths: z.array(z.string().min(1)).min(1).max(100_000).optional(),
		uploadIds: z.array(z.string().min(1)).min(1).max(100_000).optional(),
		frameRate: RationalSchema,
		/** Name shown in the Project panel (default: the pattern, e.g. `shot_[0001-0120].exr`). */
		name: z.string().min(1).max(512).optional(),
	})
	.refine((r) => [r.path, r.paths, r.uploadIds].filter((x) => x !== undefined).length === 1, {
		message: 'give exactly one of path, paths or uploadIds',
	});
export type ImageSequenceRequest = z.infer<typeof ImageSequenceRequestSchema>;

/** `POST /api/imports/image-sequence/detect {path}`: the sequence a frame belongs to (engine host). */
export const ImageSequenceDetectRequestSchema = z.object({ path: z.string().min(1) });
export const ImageSequenceDetectResponseSchema = z.object({
	pattern: z.string(),
	directory: z.string(),
	first: z.number().int().min(0),
	last: z.number().int().min(0),
	count: z.number().int().min(1),
	missing: z.array(z.number().int().min(0)),
});
export type ImageSequenceDetectResponse = z.infer<typeof ImageSequenceDetectResponseSchema>;

// ---------------------------------------------------------------- layered documents (PSD)

export const PSD_BLEND_MODES = [
	'pass-through',
	'normal',
	'dissolve',
	'darken',
	'multiply',
	'color-burn',
	'linear-burn',
	'darker-color',
	'lighten',
	'screen',
	'color-dodge',
	'linear-dodge',
	'lighter-color',
	'overlay',
	'soft-light',
	'hard-light',
	'vivid-light',
	'linear-light',
	'pin-light',
	'hard-mix',
	'difference',
	'exclusion',
	'subtract',
	'divide',
	'hue',
	'saturation',
	'color',
	'luminosity',
] as const;

/** One layer of a layered document as the engine extracted it (bottom-most first; groups contain children). */
export type LayeredLayer = {
	/** Index in document order, bottom = 0 (groups too). */
	index: number;
	name: string;
	kind: 'pixel' | 'group' | 'text' | 'shape' | 'adjustment' | 'smart-object' | 'empty';
	visible: boolean;
	/** Layer opacity × fill opacity, 0…1. */
	opacity: number;
	blendMode: (typeof PSD_BLEND_MODES)[number];
	/** Clipped to the layer below (Photoshop clipping mask). */
	clipping: boolean;
	/** Bounds of the extracted picture in document pixels (its layer mask already applied to the alpha). */
	left: number;
	top: number;
	width: number;
	height: number;
	/** The extracted picture (null for groups, empty and adjustment layers). */
	media: z.infer<typeof RegisteredMediaSchema> | null;
	children?: LayeredLayer[];
	/** What could not be carried (adjustment layers, layer effects, vector masks…). */
	notes?: string[];
};
export const LayeredLayerSchema: z.ZodType<LayeredLayer> = z.lazy(() =>
	z.object({
		index: z.number().int().min(0),
		name: z.string(),
		kind: z.enum(['pixel', 'group', 'text', 'shape', 'adjustment', 'smart-object', 'empty']),
		visible: z.boolean(),
		opacity: z.number().min(0).max(1),
		blendMode: z.enum(PSD_BLEND_MODES),
		clipping: z.boolean(),
		left: z.number().int(),
		top: z.number().int(),
		width: z.number().int().min(0),
		height: z.number().int().min(0),
		media: RegisteredMediaSchema.nullable(),
		children: z.array(LayeredLayerSchema).optional(),
		notes: z.array(z.string()).optional(),
	}),
);

/** `POST /api/imports/layers {mediaKey}` (job `layers`): every layer of a PSD extracted as a PNG and registered. */
export const LayeredExtractRequestSchema = z.object({
	mediaKey: z.string(),
	projectId: z.string().optional(),
	/** Premiere's "Merged Layers": also composite these layers (indexes) into one picture (`merged`). */
	merge: z.array(z.number().int().min(0)).max(5000).optional(),
});
export const LayeredExtractResultSchema = z.object({
	mediaKey: z.string(),
	info: LayeredInfoSchema,
	layers: z.array(LayeredLayerSchema),
	warnings: z.array(z.string()),
	/** The merged picture of `merge` (document size). */
	merged: RegisteredMediaSchema.optional(),
});
export type LayeredExtractResult = z.infer<typeof LayeredExtractResultSchema>;

// ---------------------------------------------------------------- vector documents (PDF pages)

/** `GET /api/imports/vector/:mediaKey` — the pages of a PDF / Illustrator file (size in points). */
export const VectorPagesResponseSchema = z.object({
	mediaKey: z.string(),
	vector: VectorInfoSchema,
	pages: z.array(z.object({ page: z.number().int().min(1), width: z.number(), height: z.number() })),
});
export type VectorPagesResponse = z.infer<typeof VectorPagesResponseSchema>;

// ---------------------------------------------------------------- Lottie export

/**
 * `POST /api/imports/lottie/export`: a sequence (its graphics clips: shapes, text, solids, stills, nested sequences)
 * as a Lottie document. `format` `json` or `dotlottie`; `textAsShapes` is not offered (text layers keep their fonts).
 */
export const LottieExportRequestSchema = z.object({
	envelope: z.unknown(),
	sequenceId: z.string(),
	format: z.enum(['json', 'dotlottie']).optional(),
	/** Range in sequence frames (default: the whole sequence). */
	range: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }).optional(),
	/** Write to this engine-host path (local mode); else the result carries the bytes. */
	outputPath: z.string().optional(),
});
export type LottieExportRequest = z.infer<typeof LottieExportRequestSchema>;
export const LottieExportResultSchema = z.object({
	warnings: z.array(z.string()),
	layers: z.number().int().min(0),
	bytes: z.number().int().min(0),
	/** Base64 of the file when no `outputPath` was given. */
	contentBase64: z.string().optional(),
	outputPath: z.string().optional(),
	fileName: z.string(),
});
export type LottieExportResult = z.infer<typeof LottieExportResultSchema>;

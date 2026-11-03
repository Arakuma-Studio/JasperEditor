// Spec 19 §12 (TL-112…TL-116): layered PSD, layer-style import, alpha delivery, image split and the gamut overlay. Bodies
// are zod-validated at the routes; sizes and counts are capped here so a hostile body is refused before it costs anything.
import { MAX_SPLIT_CLIPS, OUTPUT_SPACE_IDS } from '@jasper/project';
import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

/** `<folder>/<name>` on the engine host (local engines; nothing is overwritten: " (2)" is appended). */
export const DeliveryDestinationSchema = z.object({
	folder: z.string().min(1).max(4096),
	name: z
		.string()
		.min(1)
		.max(200)
		.refine((n) => !/[\\/\0]/.test(n) && n !== '.' && n !== '..', 'A file name, not a path'),
});
export type DeliveryDestination = z.infer<typeof DeliveryDestinationSchema>;

// ---------------------------------------------------------------------------------------------------------------
// TL-112 Send to Photoshop

/** Most PSD records (groups count twice: their end marker too). Each picture is a render. */
export const MAX_PSD_LAYERS = 256;
/** Photoshop's PSD limits: 30 000 px per side, under 2 GiB (the writer refuses more). */
export const MAX_PSD_SIDE = 30_000;
/**
 * Most pixels of a PSD frame. One layer's RGBA, the composite and ag-psd's scratch buffer are in memory at the peak,
 * 16 bytes per pixel, so this caps the job at ≈ 1 GiB of RAM whatever the layer count.
 */
export const MAX_PSD_PIXELS = 67_000_000;

export const PsdRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string().min(1),
	frame: z.number().int().min(0),
	/** Split each title with a look into a group: rims and face (hidden) and the full look (`fx`, shown). */
	splitTitles: z.boolean().optional(),
	/** Also copy the file to `<folder>/<name>.psd` on the engine host (local engines). */
	destination: DeliveryDestinationSchema.optional(),
});
export type PsdRequest = z.infer<typeof PsdRequestSchema>;

export const PsdPlanLayerSchema = z.object({
	name: z.string(),
	/** `group`: holds the next `children` entries. */
	kind: z.enum(['pixels', 'group']),
	children: z.number().int().min(0).optional(),
	/** Photoshop blend mode key (ag-psd name). */
	blend: z.string(),
	opacity: z.number().min(0).max(1),
	hidden: z.boolean(),
	/** Why these pixels are not editable in Photoshop: empty for an ordinary raster layer. */
	baked: z.array(z.string()),
});
export type PsdPlanLayer = z.infer<typeof PsdPlanLayerSchema>;

export const PsdPlanSchema = z.object({
	width: z.number().int(),
	height: z.number().int(),
	frame: z.number().int(),
	/** Bottom → top, as Photoshop stores them. */
	layers: z.array(PsdPlanLayerSchema),
	/** One line per thing rasterised or flattened: "Title: text rasterised", "Adjustment: flattened with what is below". */
	baked: z.array(z.string()),
	/** Non-empty: the PSD is refused; nothing runs. */
	blockers: z.array(z.object({ code: z.string(), message: z.string() })),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
	/** Upper bound of the file, with every layer filling the frame. */
	estimate: z.object({ renders: z.number().int(), bytes: z.number() }),
});
export type PsdPlan = z.infer<typeof PsdPlanSchema>;

export const PsdResultSchema = z.object({
	url: z.string(),
	path: z.string().optional(),
	bytes: z.number().int(),
	width: z.number().int(),
	height: z.number().int(),
	layers: z.array(PsdPlanLayerSchema),
	baked: z.array(z.string()),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type PsdResult = z.infer<typeof PsdResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// TL-113 Layer-style import

/** Largest `.asl` / `.psd` read. A PSD is read without its pictures, but the file still has to be held. */
export const MAX_STYLE_FILE_BYTES = 256 * 1024 * 1024;
/** Most styles returned from one file. */
export const MAX_STYLES_PER_FILE = 500;

export const LayerStyleReadQuerySchema = z.object({
	/** Original file name, for messages. */
	name: z.string().min(1).max(255),
});

export const LayerStyleReportSchema = z.object({
	/** What became a layer, palette entry or light as Photoshop meant it. */
	mapped: z.array(z.string()),
	/** Kept, but changed: says how. */
	approximated: z.array(z.string()),
	/** Named and left out (TL-113: nothing is dropped silently). */
	unsupported: z.array(z.string()),
});
export type LayerStyleReport = z.infer<typeof LayerStyleReportSchema>;

export const LayerStyleSourceSchema = z.object({
	name: z.string(),
	origin: z.enum(['text layer', 'layer', 'style library']),
	/** Size the style's pixels are percentages of (the font size, else a suggestion to confirm). */
	refPx: z.number().positive(),
	/** Whether `refPx` was read from the file (a text layer's font). */
	refKnown: z.boolean(),
	refNote: z.string(),
	/** The parsed style, the mapper's input (`packages/project` `PsStyleSchema`). */
	style: z.unknown(),
});
export type LayerStyleSource = z.infer<typeof LayerStyleSourceSchema>;

export const LayerStyleFileSchema = z.object({
	fileName: z.string(),
	styles: z.array(LayerStyleSourceSchema),
	/** Styles that could not be read, one line each, with the reason. */
	skipped: z.array(z.string()),
});
export type LayerStyleFile = z.infer<typeof LayerStyleFileSchema>;

// ---------------------------------------------------------------------------------------------------------------
// TL-114 Alpha delivery

export const MAX_ALPHA_FRAMES = 36_000;
export const MAX_TRIM_MARGIN_PX = 4096;

/** Default margin of Export Title (px of the sequence): room for antialiasing and the faintest glow. */
export const DEFAULT_TRIM_MARGIN_PX = 16;

export const AlphaDeliveryRequestSchema = z
	.object({
		envelope: EnvelopeSchema,
		sequenceId: z.string().min(1),
		/** Sequence frames `[start, end)`. One frame writes one PNG; more write a numbered sequence. */
		range: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }),
		/** Only these clips (Export Title). Absent = every visible layer on a transparent background. */
		clipIds: z.array(z.string().min(1)).min(1).max(256).optional(),
		/**
		 * Trim every frame to the content of all of them plus `marginPx`, so the result does not jump. The render canvas
		 * grows past the sequence frame until nothing touches its edge, so glows do not clip at the frame.
		 */
		trim: z.object({ marginPx: z.number().int().min(0).max(MAX_TRIM_MARGIN_PX) }).optional(),
		/** Also write to `<folder>/<name>.png` or `<folder>/<name>/<name>_000000.png` on the engine host. */
		destination: DeliveryDestinationSchema.optional(),
	})
	.superRefine((r, ctx) => {
		if (r.range.end <= r.range.start)
			ctx.addIssue({ code: 'custom', message: 'The range is empty', path: ['range'] });
		else if (r.range.end - r.range.start > MAX_ALPHA_FRAMES)
			ctx.addIssue({ code: 'custom', message: `At most ${MAX_ALPHA_FRAMES} frames`, path: ['range'] });
	});
export type AlphaDeliveryRequest = z.infer<typeof AlphaDeliveryRequestSchema>;

export const AlphaDeliveryResultSchema = z.object({
	/** A PNG for one frame, a stored ZIP of PNGs for more. */
	url: z.string(),
	format: z.enum(['png', 'zip']),
	frames: z.number().int(),
	width: z.number().int(),
	height: z.number().int(),
	/** Where the picture's top-left corner sits in the sequence frame (negative past its edge): place it back with this. */
	origin: z.object({ x: z.number().int(), y: z.number().int() }),
	/** The file, or the folder of a sequence, written at the destination. */
	path: z.string().optional(),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type AlphaDeliveryResult = z.infer<typeof AlphaDeliveryResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// TL-115 Split image

/** Most parts one split makes: each is a media item and a clip on its own track. */
export const MAX_SPLIT_PARTS = MAX_SPLIT_CLIPS;
/** Largest picture the split decodes (RGBA held in memory). */
export const MAX_SPLIT_PIXELS = 268_435_456;

/** Stills are addressed by media key (`/api/media/:key/split-image…`), as derivations are. */
export const PxBoxSchema = z.object({
	x0: z.number().int(),
	y0: z.number().int(),
	x1: z.number().int(),
	y1: z.number().int(),
});

export const SplitImageAnalysisSchema = z.object({
	width: z.number().int(),
	height: z.number().int(),
	cell: z.number().int(),
	cols: z.number().int(),
	rows: z.number().int(),
	bitDepth: z.union([z.literal(8), z.literal(16)]),
	/** Alpha islands in label order: `groups` of the split request index this list. */
	islands: z.array(PxBoxSchema),
	/** Opaque PNG of `cols × rows`: R and G hold island index + 1 (little-endian), B the cell's alpha; 0 = none. */
	labelMapUrl: z.string(),
});
export type SplitImageAnalysis = z.infer<typeof SplitImageAnalysisSchema>;

export const SplitImageRequestSchema = z.object({
	/** Groups of island indices of the analysis; each group becomes one part. */
	groups: z
		.array(z.array(z.number().int().min(0)).min(1).max(100_000))
		.min(2)
		.max(MAX_SPLIT_PARTS),
	projectId: z.string().min(1).optional(),
});
export type SplitImageRequest = z.infer<typeof SplitImageRequestSchema>;

export const SplitImagePartSchema = z.object({
	/** A `RegisteredMedia`: `mediaRegisterCommand` adds it to the project. */
	media: z.unknown(),
	/** Pixel box of the part in the picture. */
	box: z.object({
		x: z.number().int(),
		y: z.number().int(),
		w: z.number().int(),
		h: z.number().int(),
	}),
});
export const SplitImageResultSchema = z.object({ parts: z.array(SplitImagePartSchema) });
export type SplitImageResult = z.infer<typeof SplitImageResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// TL-116 Gamut overlay

export const GamutCheckRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string().min(1),
	frame: z.number().int().min(0),
	/** Output space checked against; default: the working space. */
	output: z.enum(['working', ...OUTPUT_SPACE_IDS]).optional(),
});
export type GamutCheckRequest = z.infer<typeof GamutCheckRequestSchema>;

export const GamutCheckResultSchema = z.object({
	frame: z.number().int(),
	/** Output space checked (`rec709`, `rec2020`…) and its label. */
	output: z.string(),
	outputLabel: z.string(),
	width: z.number().int(),
	height: z.number().int(),
	/** Percentages of the frame's pixels, 0…100. */
	gamutPercent: z.number(),
	legalPercent: z.number(),
	anyPercent: z.number(),
	/** Transparent PNG of the frame: flagged pixels only. `/renders/<job>/output`. */
	maskUrl: z.string(),
	/** The export planner's warnings for the frame (what the render path changes). Absent from older engines. */
	warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
});
export type GamutCheckResult = z.infer<typeof GamutCheckResultSchema>;

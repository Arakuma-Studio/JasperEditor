// Analysis measures frames rendered through the export paths, so measurements describe exported pixels.
import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

const ScopeKindSchema = z.enum(['waveform', 'parade', 'histogram', 'vectorscopeYuv', 'vectorscopeHls']);

/** `POST /api/grading/scopes`: Lumetri Scopes of one Program frame (or of one clip alone). */
export const GradingScopesRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	frame: z.number().int().min(0),
	/** Measure this clip alone (its picture with every effect, nothing above or below it). */
	clipId: z.string().optional(),
	scopes: z.array(ScopeKindSchema).max(5).optional(),
	waveformType: z.enum(['rgb', 'luma', 'yc', 'ycNoChroma']).optional(),
	paradeType: z.enum(['rgb', 'yuv', 'rgbWhite', 'yuvWhite']).optional(),
	matrix: z.enum(['bt601', 'bt709', 'bt2020']).optional(),
	clamp: z.boolean().optional(),
	columns: z.number().int().min(1).max(512).optional(),
	peaks: z.number().int().min(1).max(64).optional(),
	bins: z.boolean().optional(),
	/** Render width (px, 64…3840; default 960 — the scopes decimate to 480 × 270 anyway). */
	width: z.number().int().min(64).max(3840).optional(),
});
export type GradingScopesRequest = z.infer<typeof GradingScopesRequestSchema>;

const LevelSchema = z.object({ min: z.number(), max: z.number(), mean: z.number() }).nullable();
const PeakSchema = z.object({
	x: z.number(),
	y: z.number(),
	cb: z.number(),
	cr: z.number(),
	angleDeg: z.number(),
	magnitude: z.number(),
	share: z.number(),
});
const VectorSchema = z.object({
	samples: z.number(),
	mean: z.tuple([z.number(), z.number()]),
	meanAngleDeg: z.number(),
	peaks: z.array(PeakSchema),
});
const LevelsSchema = z.object({
	lo: z.number(),
	hi: z.number(),
	columns: z.number(),
	traces: z.record(z.string(), z.array(LevelSchema)),
});

export const GradingScopesResponseSchema = z.object({
	sequenceId: z.string(),
	frame: z.number(),
	clipId: z.string().optional(),
	renderPath: z.string().optional(),
	samples: z.tuple([z.number(), z.number()]),
	matrix: z.string(),
	clamp: z.boolean(),
	unit: z.literal('%'),
	stats: z
		.object({
			r: LevelSchema,
			g: LevelSchema,
			b: LevelSchema,
			y: LevelSchema,
			chromaMean: z.tuple([z.number(), z.number()]),
			hueDeg: z.number(),
			saturation: z.number(),
			clipLow: z.array(z.number()),
			clipHigh: z.array(z.number()),
			samples: z.number(),
		})
		.nullable(),
	waveform: LevelsSchema.extend({ type: z.string() }).optional(),
	parade: LevelsSchema.extend({ type: z.string() }).optional(),
	histogram: z
		.object({
			samples: z.number(),
			below: z.array(z.number()),
			above: z.array(z.number()),
			peakBin: z.object({ r: z.number(), g: z.number(), b: z.number(), y: z.number() }),
			r: z.array(z.number()).optional(),
			g: z.array(z.number()).optional(),
			b: z.array(z.number()).optional(),
			y: z.array(z.number()).optional(),
		})
		.optional(),
	vectorscopeYuv: VectorSchema.optional(),
	vectorscopeHls: VectorSchema.optional(),
});
export type GradingScopesResponse = z.infer<typeof GradingScopesResponseSchema>;

/** `POST /api/grading/match`: Colour Match of a clip to a reference frame, solved into its Lumetri parameters. */
export const ColorMatchRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	clipId: z.string(),
	/** The Lumetri instance to solve (default: the clip's first). The picture before it is matched. */
	effectId: z.string().optional(),
	/** Sequence frame of the current picture (inside the clip). */
	frame: z.number().int().min(0),
	reference: z.object({ sequenceId: z.string(), frame: z.number().int().min(0) }),
	/** Face Detection: protect skin tones (default true); faces come from the face model when it is installed. */
	faceDetection: z.boolean().optional(),
});
export type ColorMatchRequest = z.infer<typeof ColorMatchRequestSchema>;

export const ColorMatchResponseSchema = z.object({
	clipId: z.string(),
	effectId: z.string().nullable(),
	/** Lumetri params to set (wheels [x, y], levels −100…100, saturation 0…200). */
	params: z.object({
		shadowsWheel: z.tuple([z.number(), z.number()]),
		midtonesWheel: z.tuple([z.number(), z.number()]),
		highlightsWheel: z.tuple([z.number(), z.number()]),
		shadowsLevel: z.number(),
		midtonesLevel: z.number(),
		highlightsLevel: z.number(),
		saturation: z.number(),
	}),
	before: z.number(),
	after: z.number(),
	/** Face Detection outcome: faces (face model), none (no face found), hue (no face model: skin-tone test), off. */
	skin: z.enum(['faces', 'none', 'hue', 'off']),
	skinShare: z.number(),
	skinHueShift: z.number().nullable(),
	faces: z.object({ current: z.number(), reference: z.number() }).nullable(),
	/** Why faces were not detected with the model (`FACE_MODEL_NOT_INSTALLED`…), when Face Detection is on. */
	faceNote: z.string().optional(),
});
export type ColorMatchResponse = z.infer<typeof ColorMatchResponseSchema>;

/** `POST /api/grading/auto-tone`: Basic Correction ▸ Auto for a clip. */
export const AutoToneRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	clipId: z.string(),
	effectId: z.string().optional(),
	frame: z.number().int().min(0),
});
export type AutoToneRequest = z.infer<typeof AutoToneRequestSchema>;

export const AutoToneResponseSchema = z.object({
	clipId: z.string(),
	effectId: z.string().nullable(),
	params: z.object({
		exposure: z.number(),
		contrast: z.number(),
		highlights: z.number(),
		shadows: z.number(),
		whites: z.number(),
		blacks: z.number(),
		saturation: z.number(),
	}),
	/** Luma quantiles (1, 10, 50, 90, 99 %) before and after, percent. */
	before: z.array(z.number()),
	after: z.array(z.number()),
});
export type AutoToneResponse = z.infer<typeof AutoToneResponseSchema>;

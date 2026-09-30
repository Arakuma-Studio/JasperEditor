// Export planning and rendering (ARCHITECTURE §9.5, S04 §10.2 subset, RP-010, EX-030).
import { z } from 'zod';
import { EncoderChoiceSchema, VideoCodecSchema } from './capabilities.ts';
import { RationalSchema } from './common.ts';
import { EnvelopeSchema } from './projects.ts';

/**
 * M1 subset of S04 `ExportSettings`: MP4 / H.264 / AAC 48 kHz stereo; enums widen additively later.
 * The engine may substitute the codec/container when the build cannot encode H.264 (D-13): the plan's
 * `encoder` says what will actually be written.
 */
export const ExportSettingsSchema = z.object({
	sequenceId: z.string(),
	range: z.discriminatedUnion('type', [
		z.object({ type: z.literal('entire') }),
		z.object({ type: z.literal('in-out') }),
		z.object({ type: z.literal('work-area') }),
		z.object({
			type: z.literal('custom'),
			startFrame: z.number().int().min(0),
			endFrame: z.number().int().min(1),
		}),
	]),
	presetId: z.string().optional(),
	container: z.enum(['mp4', 'webm']),
	video: z
		.object({
			codec: VideoCodecSchema,
			/** Explicit ffmpeg encoder (must be usable, see capabilities `media.encoding`); default = best. */
			encoder: z.string().optional(),
			width: z.number().int().positive(),
			height: z.number().int().positive(),
			frameRate: RationalSchema,
			scaling: z.enum(['fit', 'fill', 'stretch']).default('fit'),
			quality: z.object({ mode: z.literal('crf'), value: z.number().int().min(0).max(51) }),
			encoderSpeed: z.enum(['fast', 'balanced', 'best']),
			colorTags: z.literal('rec709').default('rec709'),
		})
		.optional(),
	audio: z
		.object({
			codec: z.enum(['aac', 'opus']),
			sampleRate: z.literal(48000),
			channels: z.union([z.literal(1), z.literal(2)]),
			bitrateKbps: z.number().int().positive().optional(),
		})
		.optional(),
	engine: z.enum(['auto', 'native', 'remotion']),
	draftUseProxies: z.boolean().optional(),
	destination: z
		.discriminatedUnion('type', [
			z.object({ type: z.literal('download') }),
			z.object({ type: z.literal('path'), path: z.string() }),
		])
		.default({ type: 'download' }),
});
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;

/** Render plan (S04:RP-010) plus the plan id and document revision it was computed for (RP-011). */
export const RenderPlanSchema = z.object({
	planId: z.string().optional(),
	documentRevision: z.number().int().optional(),
	path: z.union([z.enum(['copy', 'native', 'hybrid', 'remotion', 'browser']), z.string().regex(/^cloud:/)]),
	segments: z.array(
		z.object({
			startFrame: z.number().int(),
			endFrame: z.number().int(),
			mode: z.enum(['copy', 'native', 'mixed', 'remotion']),
			graphicsGroups: z.array(
				z.object({ id: z.string(), engine: z.enum(['remotion', 'fframes']), itemIds: z.array(z.string()) }),
			),
		}),
	),
	audio: z.object({
		mode: z.enum(['native-mix', 'remotion', 'browser']),
		normalize: z.object({ targetLufs: z.number() }).optional(),
	}),
	blockers: z.array(
		z.object({
			itemId: z.string().optional(),
			path: z.enum(['copy', 'native', 'hybrid']),
			reason: z.string(),
		}),
	),
	warnings: z.array(
		z.object({ code: z.string(), message: z.string(), itemIds: z.array(z.string()).optional() }),
	),
	estimate: z.object({ seconds: z.number().min(0), bytes: z.number().min(0) }),
	/** Encoder that will write the file (D-13); absent when the engine cannot encode at all. */
	encoder: EncoderChoiceSchema.optional(),
});
export type RenderPlan = z.infer<typeof RenderPlanSchema>;

export const ExportPlanRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	settings: ExportSettingsSchema,
});
export type ExportPlanRequest = z.infer<typeof ExportPlanRequestSchema>;
export const ExportStartRequestSchema = ExportPlanRequestSchema.extend({ planId: z.string().optional() });
export type ExportStartRequest = z.infer<typeof ExportStartRequestSchema>;
/** `EngineJob.result` of a finished export. */
export const ExportResultSchema = z.object({
	downloadUrl: z.string(),
	byteSize: z.number().int(),
	durationSec: z.number(),
	frames: z.number().int(),
	path: z.string().optional(),
	/** ffmpeg video encoder and container actually used (D-13). */
	encoder: z.string().optional(),
	container: z.enum(['mp4', 'webm']).optional(),
});
export type ExportResult = z.infer<typeof ExportResultSchema>;

export const StillRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	frame: z.number().int().min(0),
	width: z.number().int().positive().optional(),
});
export type StillRequest = z.infer<typeof StillRequestSchema>;
export const StillResultSchema = z.object({ url: z.string() });

// Media range view (spec 18 §2.3 AF-VIEW; docs/wp-notes/agent-footage-view.md): what the MCP tool `view_media_range`
// draws its picture from — frames of a registered media at given times (PNG, scaled during decode), and the 10 ms
// audio levels and voice classes of a media range or of a sequence's mix over a range.
import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

/** Most frames one request extracts (the tool's filmstrip holds 2…16). */
export const RANGE_VIEW_MAX_FRAMES = 16;
/** Largest frame box (pixels): frames are scaled to fit inside `width × height` while decoding. */
export const RANGE_VIEW_MAX_FRAME_WIDTH = 960;
export const RANGE_VIEW_MAX_FRAME_HEIGHT = 1080;
/** Longest range the tool views (seconds of media or sequence time). */
export const RANGE_VIEW_MAX_SECONDS = 600;
/**
 * Longest span of the file decoded for a media range's audio (seconds of file time): a frame-rate interpretation can
 * make 600 s of media time a longer span of the file.
 */
export const RANGE_AUDIO_MAX_FILE_SECONDS = 1800;
/** Audio level frames: 10 ms (the voice analysis grid, `VOICE_HOP` at 16 kHz). */
export const RANGE_AUDIO_FRAME_SEC = 0.01;
/** Level bytes: dB = MIN + q × STEP (the voice analysis quantisation, @jasper/audio-dsp `voiceLevelDb`). */
export const RANGE_AUDIO_LEVEL_MIN_DB = -120;
export const RANGE_AUDIO_LEVEL_STEP_DB = 0.5;
/** Class bytes (the voice analysis classes, @jasper/project `VOICE_CLASSES`). */
export const RANGE_AUDIO_CLASSES = { silence: 0, breath: 1, speech: 2 } as const;

const Seconds = z.number().finite().min(0).max(1e7);

export const MediaFramesRequestSchema = z.strictObject({
	/** File times (seconds); each is clamped to the media. */
	times: z.array(Seconds).min(1).max(RANGE_VIEW_MAX_FRAMES),
	/** The box each frame is scaled to fit (display aspect kept, never upscaled past the box). */
	width: z.number().int().min(16).max(RANGE_VIEW_MAX_FRAME_WIDTH),
	height: z.number().int().min(16).max(RANGE_VIEW_MAX_FRAME_HEIGHT).optional(),
});
export type MediaFramesRequest = z.infer<typeof MediaFramesRequestSchema>;

export const MediaFrameSchema = z.union([
	z.object({
		/** The time asked for, and the time decoded (clamped to the media; the last frame for times past its end). */
		time: z.number(),
		at: z.number(),
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		/** Base64 of an 8-bit RGB PNG. */
		png: z.string(),
	}),
	z.object({
		time: z.number(),
		error: z.object({ code: z.string(), message: z.string() }),
	}),
]);
export type MediaFrame = z.infer<typeof MediaFrameSchema>;

export const MediaFramesResponseSchema = z.object({
	mediaKey: z.string(),
	durationSec: z.number().nullable(),
	frames: z.array(MediaFrameSchema),
});
export type MediaFramesResponse = z.infer<typeof MediaFramesResponseSchema>;

export const MediaRangeAudioRequestSchema = z
	.strictObject({
		/** File seconds `[start, end)`; clamped to the media. */
		start: Seconds,
		end: Seconds,
		/** Container index of the audio stream (default: the first audio stream). */
		streamIndex: z.number().int().min(0).max(65_535).optional(),
	})
	.refine((r) => r.end > r.start, { message: 'end must be after start', path: ['end'] })
	.refine((r) => r.end - r.start <= RANGE_AUDIO_MAX_FILE_SECONDS, {
		message: `at most ${RANGE_AUDIO_MAX_FILE_SECONDS} s`,
		path: ['end'],
	});
export type MediaRangeAudioRequest = z.infer<typeof MediaRangeAudioRequestSchema>;

export const SequenceRangeAudioRequestSchema = z
	.strictObject({
		envelope: EnvelopeSchema,
		sequenceId: z.string().min(1).max(200),
		/** Sequence frames `[startFrame, endFrame)`, at most RANGE_VIEW_MAX_SECONDS long; clamped to the sequence. */
		startFrame: z.number().int().min(0),
		endFrame: z.number().int().min(1),
	})
	.refine((r) => r.endFrame > r.startFrame, {
		message: 'endFrame must be after startFrame',
		path: ['endFrame'],
	});
export type SequenceRangeAudioRequest = z.infer<typeof SequenceRangeAudioRequestSchema>;

const Db = z.number().finite();

/**
 * 10 ms frames of a range's audio. Frame `k` covers `[start + k · frameSec, start + (k + 1) · frameSec)`; `level` is the
 * RMS over 25 ms centred on the frame, quantised like the voice analysis (dB = −120 + q × 0.5); `classes` are the voice
 * analysis classes (0 silence, 1 breath-like, 2 speech). `source`: `voice-analysis` = the media's cached analysis
 * (classes against the whole stream), `range` = analysed now over this range only, `mix` = the sequence's mix over the
 * range (before the Mix's loudness normalisation), analysed now.
 */
export const RangeAudioResponseSchema = z.object({
	start: z.number(),
	end: z.number(),
	frameSec: z.number().positive(),
	frameCount: z.number().int().min(0),
	level: z.string(),
	classes: z.string(),
	source: z.enum(['voice-analysis', 'range', 'mix']),
	streamIndex: z.number().int().nullable(),
	levels: z.object({ floorDb: Db, speechDb: Db, speechThresholdDb: Db }).nullable(),
});
export type RangeAudioResponse = z.infer<typeof RangeAudioResponseSchema>;

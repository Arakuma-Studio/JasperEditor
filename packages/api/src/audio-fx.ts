import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

/** Longest music range the Remix analyses (seconds). */
export const MAX_REMIX_SOURCE_SECONDS = 30 * 60;

export const RemixPlanRequestSchema = z.strictObject({
	mediaKey: z.string().min(1),
	/** Audio stream of the media (default: the first audio stream). */
	streamIndex: z.number().int().min(0).optional(),
	/** The clip's content range (seconds of media time): its intro and outro are kept. */
	startSeconds: z.number().min(0),
	/**
	 * At most 30 min: the analysis holds the decoded range (22.05 kHz mono) and a beats² similarity matrix, which
	 * for hours of audio would exhaust the engine's memory (≈ 3 GB per hour at 200 BPM).
	 */
	durationSeconds: z.number().positive().max(MAX_REMIX_SOURCE_SECONDS),
	targetSeconds: z
		.number()
		.positive()
		.max(4 * 3600),
	segments: z.number().min(0).max(100).optional(),
	variations: z.number().min(0).max(100).optional(),
});
export type RemixPlanRequest = z.infer<typeof RemixPlanRequestSchema>;

export const RemixPlanResultSchema = z.object({
	bpm: z.number(),
	/** Beat positions (seconds from the range start). */
	beats: z.array(z.number()),
	/** Pieces in output order (seconds from the range start). */
	pieces: z.array(z.object({ srcSeconds: z.number(), lenSeconds: z.number() })),
	/** Output length of the plan (seconds). */
	lengthSeconds: z.number(),
	/** Crossfade at each joint (seconds). */
	crossfadeSeconds: z.number(),
	/** Source position of each joint: [end of the outgoing piece, start of the incoming one] (seconds). */
	cuts: z.array(z.tuple([z.number(), z.number()])),
});
export type RemixPlanResult = z.infer<typeof RemixPlanResultSchema>;

/** Longest music range `POST /api/audio/beats` analyses at once (seconds). */
export const MAX_BEATS_SOURCE_SECONDS = 30 * 60;

/**
 * `POST /api/audio/beats` (spec 12 §2.8; wp-note "Phase 6 → WP6.2"): tempo, beats and (when one beat in four is clearly
 * accented) downbeats of a media's audio over a range, with the Remix tool's beat tracker (`analyzeBeats`). Cached per
 * media file and range. Sound Design's beat cues come from it.
 */
export const BeatsRequestSchema = z.strictObject({
	mediaKey: z.string().min(1).max(256),
	/** Audio stream of the media (default: the first audio stream). */
	streamIndex: z.number().int().min(0).max(1000).optional(),
	/** Media seconds where the range starts. */
	startSeconds: z.number().min(0).max(864_000),
	/** At most 30 min (the analysis holds the decoded range, 22.05 kHz mono). */
	durationSeconds: z.number().positive().max(MAX_BEATS_SOURCE_SECONDS),
});
export type BeatsRequest = z.infer<typeof BeatsRequestSchema>;

export const BeatsResultSchema = z.object({
	/** Tempo; null when the audio has no usable pulse (`reason`). */
	bpm: z.number().nullable(),
	/** Attack of each beat, media seconds (ascending). */
	beats: z.array(z.number()),
	/** The accented beats (media seconds), or null when no beat in four is clearly accented. */
	downbeats: z.array(z.number()).nullable(),
	/** How clear the downbeat accent is (0…1). */
	downbeatConfidence: z.number(),
	startSeconds: z.number(),
	durationSeconds: z.number(),
	/** Seconds of audio decoded (shorter than asked when the media ends earlier). */
	analysedSeconds: z.number(),
	/** Why there are no beats: NO_BEAT (no pulse, or fewer than 4 beats). */
	reason: z.enum(['NO_BEAT']).optional(),
	/** Served from the cache. */
	cached: z.boolean(),
});
export type BeatsResult = z.infer<typeof BeatsResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// `POST /api/audio/classify` (spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): Essential Sound Auto Tag. Each clip's media
// (over the source range it plays) or each media is classified as dialogue, music, SFX or ambience by `classifyAudio`
// (@jasper/audio-fx). A job `audio-classify`; results cached by the file's fingerprint and the range.

export const AUDIO_CLASSIFY_CATEGORIES = ['dialogue', 'music', 'sfx', 'ambience'] as const;
/** Most clips / media per request. */
export const AUDIO_CLASSIFY_MAX_ITEMS = 500;

export const AudioClassifyRequestSchema = z
	.strictObject({
		/**
		 * The document of `clipIds`: inline (`envelope`, the editor's), else the project's live document (`projectId`;
		 * with an envelope it only names the job's project).
		 */
		projectId: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id')
			.optional(),
		envelope: EnvelopeSchema.optional(),
		sequenceId: z.string().min(1).max(200).optional(),
		/** Audio clips of the sequence (each classified over the media range it plays). */
		clipIds: z.array(z.string().min(1).max(200)).min(1).max(AUDIO_CLASSIFY_MAX_ITEMS).optional(),
		/** Registered media (whole files, first audio stream unless `streamIndex`). */
		mediaKeys: z.array(z.string().min(1).max(256)).min(1).max(AUDIO_CLASSIFY_MAX_ITEMS).optional(),
		streamIndex: z.number().int().min(0).max(1000).optional(),
	})
	.refine((r) => (r.clipIds === undefined) !== (r.mediaKeys === undefined), 'give clipIds or mediaKeys')
	.refine(
		(r) => r.clipIds === undefined || r.projectId !== undefined || r.envelope !== undefined,
		'clipIds need projectId or envelope',
	);
export type AudioClassifyRequest = z.infer<typeof AudioClassifyRequestSchema>;

const CategoryScoresSchema = z.object({
	dialogue: z.number(),
	music: z.number(),
	sfx: z.number(),
	ambience: z.number(),
});

/** One classification (the cached unit: a media range). */
export const AudioClassificationSchema = z.object({
	/** null = silent (nothing to tag). */
	category: z.enum(AUDIO_CLASSIFY_CATEGORIES).nullable(),
	/** 0…1; under `lowConfidence` (0.6) say so and let the user confirm. */
	confidence: z.number().min(0).max(1),
	scores: CategoryScoresSchema,
	reasons: z.array(z.string()),
	silent: z.boolean(),
	/** Seconds of the range and seconds analysed (long ranges are sampled: windows spread over them). */
	durationSec: z.number(),
	analysedSec: z.number(),
	/** The measured features (`audioCategoryFeatures`), for agents that want the evidence. */
	features: z.record(z.string(), z.union([z.number(), z.boolean()])),
});
export type AudioClassification = z.infer<typeof AudioClassificationSchema>;

export const AudioClassifyItemSchema = z.object({
	clipId: z.string().optional(),
	mediaKey: z.string().optional(),
	/** The clip's or the media's name. */
	name: z.string(),
	/** The clip's current audio type and whether Auto Tag set it (clips only). */
	currentType: z.enum(AUDIO_CLASSIFY_CATEGORIES).nullable().optional(),
	autoTagged: z.boolean().optional(),
	/** Media seconds classified. */
	startSeconds: z.number(),
	durationSeconds: z.number(),
	result: AudioClassificationSchema.nullable(),
	/** Why there is no result: NOT_AUDIO, NO_AUDIO_STREAM, MEDIA_OFFLINE, NOT_IN_ENGINE, DECODE_FAILED, CLIP_NOT_FOUND. */
	error: z.object({ code: z.string(), message: z.string() }).optional(),
	cached: z.boolean(),
});
export type AudioClassifyItem = z.infer<typeof AudioClassifyItemSchema>;

export const AudioClassifyResultSchema = z.object({
	projectId: z.string().nullable(),
	sequenceId: z.string().nullable(),
	items: z.array(AudioClassifyItemSchema),
	/** Results under this confidence are "low" (report them; the user should confirm). */
	lowConfidence: z.number(),
	counts: z.object({
		dialogue: z.number().int(),
		music: z.number().int(),
		sfx: z.number().int(),
		ambience: z.number().int(),
		silent: z.number().int(),
		failed: z.number().int(),
		low: z.number().int(),
	}),
	version: z.number().int(),
	ms: z.number(),
});
export type AudioClassifyResult = z.infer<typeof AudioClassifyResultSchema>;

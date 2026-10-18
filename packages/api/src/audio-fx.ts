import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

/** Longest music range the Remix analyses (seconds). */
export const MAX_REMIX_SOURCE_SECONDS = 30 * 60;

/**
 * Metre of the downbeats: `'auto'` (default) detects 3 or 4 beats per bar from which beats are accented; a number
 * 2…12 groups the beats by it (`3` for a waltz, `4` for 4/4, `6`, `7`…).
 */
export const TimeSignatureSchema = z.union([z.literal('auto'), z.number().int().min(2).max(12)]);
export type TimeSignature = z.infer<typeof TimeSignatureSchema>;

/** Spec 12 P6-E11: a source moment of the music (the drop) to land on an output time of the remix. */
export const RemixAnchorSchema = z.strictObject({
	/** Seconds from the analysed range's start (like `pieces[].srcSeconds`), e.g. a drop's `sourceSeconds`. */
	sourceSeconds: z.number().min(0).max(MAX_REMIX_SOURCE_SECONDS),
	/** Seconds from the remix's start (the clip's first frame): where that moment must play (within 1 ms). */
	outputSeconds: z
		.number()
		.min(0)
		.max(4 * 3600),
});
export type RemixAnchor = z.infer<typeof RemixAnchorSchema>;

/** A drop candidate of music (spec 12 P6-E11): a bar where the music lifts into a loud section, best first. */
export const MusicDropSchema = z.object({
	/** Where the drop's downbeat attack is: media seconds (`/api/audio/beats`) or seconds from the range start (remix plan). */
	sourceSeconds: z.number(),
	/** 1-based bar number from the start of the analysed range. */
	bar: z.number().int(),
	/** liftDb / 3 + 2 · novelty: the higher, the more of a drop. */
	score: z.number(),
	liftDb: z.number(),
	novelty: z.number(),
	/** The bar's level against the loud bars (dB). */
	levelDb: z.number(),
});
export type MusicDrop = z.infer<typeof MusicDropSchema>;

/** The key of music (spec 12 P6-E11: chroma + Krumhansl–Schmuckler, `@jasper/audio-fx` `estimateKey`). */
export const MusicKeySchema = z.object({
	/** Pitch class of the tonic, 0 = C … 11 = B. */
	tonic: z.number().int().min(0).max(11),
	mode: z.enum(['major', 'minor']),
	/** "A minor". */
	name: z.string(),
	/** 0…1; ≥ 0.6 is clear enough to tune to. */
	confidence: z.number(),
	correlation: z.number(),
	margin: z.number(),
	/** The key's scale as pitch classes from C. */
	scale: z.array(z.number().int()),
});
export type MusicKey = z.infer<typeof MusicKeySchema>;

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
	/**
	 * Spec 12 P6-E11: land these source moments on these output times within 1 ms (the drop on the hero), with joints
	 * at bar lines only; the plan's outro ends within half a beat of `targetSeconds` or the request is refused with
	 * E_INVALID_PARAM (`detail.nearestTargetSeconds`), unless `fit: 'nearest'` (plan the nearest length that works,
	 * not longer than `maxTargetSeconds`). Segments and Variations do not apply to an anchored plan.
	 */
	anchors: z.array(RemixAnchorSchema).min(1).max(4).optional(),
	fit: z.enum(['exact', 'nearest']).optional(),
	maxTargetSeconds: z
		.number()
		.positive()
		.max(4 * 3600)
		.optional(),
	/** Metre of the bar lines (default `'auto'`: 3 or 4 detected). */
	timeSignature: TimeSignatureSchema.optional(),
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
	/** P6-E11: the bar lines (seconds from the range start: each downbeat's joint position) and beats per bar. */
	downbeats: z.array(z.number()).optional(),
	beatsPerBar: z.number().int().optional(),
	/** The bar lines are a guess (no beat per bar clearly accented). */
	barsGuessed: z.boolean().optional(),
	/** P6-E11: drop candidates, best first (seconds from the range start). */
	drops: z.array(MusicDropSchema).optional(),
	/** P6-E11 (anchored plans): the target planned (the request's, or the nearest with `fit: 'nearest'`). */
	targetSeconds: z.number().optional(),
	/** Seconds of the intro left out before the first piece (a fade-in covers it). */
	headTrimSeconds: z.number().optional(),
	/** Each anchor: where it lands in the plan and the error (ms, ≤ 1). */
	anchors: z
		.array(
			z.object({
				sourceSeconds: z.number(),
				outputSeconds: z.number(),
				landedSeconds: z.number(),
				errorMs: z.number(),
			}),
		)
		.optional(),
});
export type RemixPlanResult = z.infer<typeof RemixPlanResultSchema>;

/** Longest music range `POST /api/audio/beats` analyses at once (seconds). */
export const MAX_BEATS_SOURCE_SECONDS = 30 * 60;

/**
 * `POST /api/audio/beats` (spec 12 §2.8; wp-note "Phase 6 → WP6.2", "WP6.5b"): tempo, beats and (when one beat per
 * bar is clearly accented) downbeats of a media's audio over a range, with the Remix tool's beat tracker
 * (`analyzeBeats`: tempo octave from the attacks, metre 3 or 4 detected or `timeSignature`). Cached per media file,
 * range and metre. Sound Design's beat cues come from it.
 */
export const BeatsRequestSchema = z.strictObject({
	mediaKey: z.string().min(1).max(256),
	/** Audio stream of the media (default: the first audio stream). */
	streamIndex: z.number().int().min(0).max(1000).optional(),
	/** Media seconds where the range starts. */
	startSeconds: z.number().min(0).max(864_000),
	/** At most 30 min (the analysis holds the decoded range, 22.05 kHz mono). */
	durationSeconds: z.number().positive().max(MAX_BEATS_SOURCE_SECONDS),
	/** Metre of the downbeats (default `'auto'`: 3 or 4 detected). */
	timeSignature: TimeSignatureSchema.optional(),
	/**
	 * Only an analysis already made (cached): 404 `BEATS_NOT_ANALYSED` instead of analysing. The cue menu's Stop Before
	 * Next and MCP `set_sound_cues {stopBefore}` put the stop on the bar line only when the music has analysed beats.
	 */
	cachedOnly: z.boolean().optional(),
});
export type BeatsRequest = z.infer<typeof BeatsRequestSchema>;

export const BeatsResultSchema = z.object({
	/** Tempo; null when the audio has no usable pulse (`reason`). */
	bpm: z.number().nullable(),
	/** Attack of each beat, media seconds (ascending). */
	beats: z.array(z.number()),
	/** The accented beats (media seconds, one per bar), or null when no beat per bar is clearly accented. */
	downbeats: z.array(z.number()).nullable(),
	/** Beats per bar of `downbeats` (detected 3 or 4, or the `timeSignature` asked); null without downbeats on 'auto'. */
	beatsPerBar: z.number().int().min(2).max(12).nullable(),
	/** How clear the downbeat accent is (0…1). */
	downbeatConfidence: z.number(),
	/** P6-E11: drop candidates, best first (media seconds; on the strongest phase in 4 when there are no downbeats). */
	drops: z.array(MusicDropSchema),
	/** The drops' bars are a guess (no downbeats). */
	dropBarsGuessed: z.boolean(),
	/** P6-E11: the key of the range (also without a beat); null for silence. */
	key: MusicKeySchema.nullable(),
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

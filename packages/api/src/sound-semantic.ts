// Describe-it search and Find Moment (spec 12 P6-E14, WP-E9; wp-note "Phase 6 → WP-E9"): an optional, user-installed
// audio-text model (LAION CLAP `larger_clap_general`, Apache-2.0) embeds library sounds and descriptions in one space,
// so `GET /api/sounds?describe=…` ranks sounds by what they sound like and `POST /api/sounds/:soundId/moments` finds the
// best window of a long recording for a description. Without the model everything works as before (keyword search).
import { SOUND_REF_RE } from '@jasper/project';
import { z } from 'zod';
import { EngineJobSchema } from './jobs.ts';

// sounds.ts imports this module (its search response carries the match): the sound id is spelled out here.
const SoundRefSchema = z.string().regex(SOUND_REF_RE);

const fin = () => z.number().finite();

/** Longest description accepted (characters; the text encoder reads at most 77 tokens of it). */
export const SOUND_DESCRIBE_MAX_CHARS = 300;
/** Window lengths a moment search accepts (seconds) and its default. */
export const SOUND_MOMENT_MIN_SEC = 0.25;
export const SOUND_MOMENT_MAX_SEC = 10;
export const SOUND_MOMENT_DEFAULT_SEC = 2;
/** Moments returned at most. */
export const SOUND_MOMENT_MAX_COUNT = 10;
/** Longest recording (or searched range) a moment search reads: 4 h. */
export const SOUND_MOMENT_MAX_RECORDING_SEC = 4 * 3600;

/**
 * Verdict bands of a calibrated match (z of the description among the vocabulary for that sound): measured on our
 * library (wp-note "Phase 6 → WP-E9", "Verdict bands"). `none` below `weak`.
 */
export const SOUND_MATCH_VERDICTS = ['strong', 'plausible', 'weak', 'none'] as const;
export type SoundMatchVerdict = (typeof SOUND_MATCH_VERDICTS)[number];

/** A calibrated match of a sound (or a window of it) to a description. */
export const SoundMatchSchema = z.object({
	/** z of the description's similarity among the vocabulary's similarities to this sound (hub phrases damped). */
	z: fin(),
	verdict: z.enum(SOUND_MATCH_VERDICTS),
	/** Raw cosine similarity of the embeddings (−1…1); for reference only, `z` is what ranks. */
	cosine: fin(),
});
export type SoundMatch = z.infer<typeof SoundMatchSchema>;

/** A Describe-it search model of the catalogue (`GET /api/sounds/semantic/models`). */
export const SoundSemanticModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	license: z.string(),
	licenseUrl: z.string(),
	attribution: z.string(),
	sourceUrl: z.string(),
	/** Pinned revision of the downloaded files. */
	revision: z.string(),
	sizeBytes: z.number().int().min(0),
	/** Bytes still to download (files already present are kept). */
	missingBytes: z.number().int().min(0),
	installed: z.boolean(),
	/** Every file has a download location; false: "Not available yet: the model download location is pending". */
	available: z.boolean(),
	unavailableReason: z.string().nullable(),
	/** Its queued or running `model-download` job. */
	job: EngineJobSchema.nullable(),
});
export type SoundSemanticModel = z.infer<typeof SoundSemanticModelSchema>;
export const SoundSemanticModelsResponseSchema = z.object({ models: z.array(SoundSemanticModelSchema) });
export type SoundSemanticModelsResponse = z.infer<typeof SoundSemanticModelsResponseSchema>;
export const SoundSemanticModelDeleteResponseSchema = z.object({
	modelId: z.string(),
	freedBytes: z.number().int().min(0),
	/** Cached embeddings of the model removed with it. */
	removedEmbeddings: z.number().int().min(0),
});
export type SoundSemanticModelDeleteResponse = z.infer<typeof SoundSemanticModelDeleteResponseSchema>;

/**
 * `GET /api/sounds/semantic`: whether Describe-it search works on this engine and how much of the library is embedded.
 * `ready`: installed and usable; `not-installed`: the model is not downloaded (keyword search is used);
 * `unavailable`: this engine cannot run it (`reason`).
 */
export const SoundSemanticStatusSchema = z.object({
	status: z.enum(['ready', 'not-installed', 'unavailable']),
	reason: z.string().nullable(),
	/** The model used (the catalogue's first installed one, else its first). */
	model: SoundSemanticModelSchema.nullable(),
	/** Sounds and offered takes the search ranks, and how many of them have an embedding of the model. */
	total: z.number().int().min(0),
	embedded: z.number().int().min(0),
	/** The queued or running `sound-embed` job. */
	job: EngineJobSchema.nullable(),
});
export type SoundSemanticStatus = z.infer<typeof SoundSemanticStatusSchema>;

/** `POST /api/sounds/semantic/embed`. */
export const SoundEmbedRequestSchema = z.strictObject({
	/** Compute every embedding again (the cache is kept for nothing else). */
	full: z.boolean().optional(),
});
export type SoundEmbedRequest = z.infer<typeof SoundEmbedRequestSchema>;

/** `EngineJob.result` of a `sound-embed` job. */
export const SoundEmbedResultSchema = z.object({
	model: z.string(),
	total: z.number().int().min(0),
	embedded: z.number().int().min(0),
	reused: z.number().int().min(0),
	failed: z.number().int().min(0),
	/** Sounds that could not be embedded (the first 50). */
	errors: z.array(z.object({ soundId: z.string(), code: z.string(), message: z.string() })),
});
export type SoundEmbedResult = z.infer<typeof SoundEmbedResultSchema>;

/** What a search says about its describe mode (`describe` given). */
export const SoundDescribeInfoSchema = z.object({
	/** `semantic`: ranked by the model; `keywords`: the model is not usable, the description's words were searched. */
	mode: z.enum(['semantic', 'keywords']),
	/** Why it fell back to keywords (model not installed, unavailable, failed). */
	reason: z.string().nullable(),
	model: z.string().nullable(),
	/** Ranked sounds with an embedding, and sounds still waiting for one (ranked by the description's words). */
	embedded: z.number().int().min(0),
	pending: z.number().int().min(0),
	/** The `sound-embed` job computing the missing embeddings. */
	jobId: z.string().nullable(),
});
export type SoundDescribeInfo = z.infer<typeof SoundDescribeInfoSchema>;

/** `POST /api/sounds/:soundId/moments` (a job; `?wait=1` waits). */
export const SoundMomentRequestSchema = z.strictObject({
	/** What to find: source + material + action + character ("a single clean key press on a mechanical keyboard"). */
	description: z.string().trim().min(1).max(SOUND_DESCRIBE_MAX_CHARS),
	/** Length of the windows compared (seconds, default 2). */
	lengthSec: z.number().min(SOUND_MOMENT_MIN_SEC).max(SOUND_MOMENT_MAX_SEC).optional(),
	/** Moments returned (1…10, default 3), best first, never overlapping. */
	count: z.number().int().min(1).max(SOUND_MOMENT_MAX_COUNT).optional(),
	/** Only this range of the sound (seconds from its start; a take's: from the start of the take). */
	startSec: z.number().min(0).max(SOUND_MOMENT_MAX_RECORDING_SEC).optional(),
	endSec: z.number().min(0).max(SOUND_MOMENT_MAX_RECORDING_SEC).optional(),
	/** Shrink each moment to where its sound is (within 40 dB of its loudest 10 ms), default true. */
	trim: z.boolean().optional(),
});
export type SoundMomentRequest = z.infer<typeof SoundMomentRequestSchema>;

export const SoundMomentSchema = z.object({
	/** Seconds from the start of the sound (a take's: from the start of the take). */
	startSec: fin().min(0),
	endSec: fin().min(0),
	match: SoundMatchSchema,
	/** Level of the window's first 5 ms and last 10 ms against its loudest 10 ms (dB): a cut-in or cut-off sound. */
	headDb: fin(),
	tailDb: fin(),
	/** The window was shrunk to its sound (`trim`). */
	trimmed: z.boolean(),
});
export type SoundMoment = z.infer<typeof SoundMomentSchema>;

/** `EngineJob.result` of a `sound-moment` job. */
export const SoundMomentResultSchema = z.object({
	soundId: SoundRefSchema,
	description: z.string(),
	model: z.string(),
	durationSec: fin().min(0),
	/** The searched range (seconds from the start of the sound). */
	startSec: fin().min(0),
	endSec: fin().min(0),
	lengthSec: fin().positive(),
	moments: z.array(SoundMomentSchema),
	/** Windows embedded for this search, and windows read from the cache. */
	computed: z.number().int().min(0),
	cached: z.number().int().min(0),
});
export type SoundMomentResult = z.infer<typeof SoundMomentResultSchema>;

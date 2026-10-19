// Essential Sound and Remix edit ordinary clip effects, gain, pan and transitions, so all render paths share them.
import { z } from 'zod';
import { AUDIO_TYPES } from '../../essential/model.ts';
import { cmd, IdListSchema, IdRefSchema, TimeInputSchema } from './common.ts';

const AudioTypeSchema = z.enum(AUDIO_TYPES);

/**
 * Assigns an audio type (resets the settings to the type's defaults unless the clip already has that type). On a clip
 * Auto Tag gave that type, it confirms the tag (the "auto" mark goes; the settings stay).
 */
export const EssentialSetTypeCmd = cmd('essentialSound.setType', {
	clipIds: IdListSchema,
	audioType: AudioTypeSchema,
});

/** Most clips one `essentialSound.autoTag` may tag. */
export const AUTO_TAG_MAX_CLIPS = 2000;

/** One clip's classification (`POST /api/audio/classify`: category, confidence 0…1, per-type scores, why). */
export const AutoTagResultSchema = z.strictObject({
	category: AudioTypeSchema,
	confidence: z.number().min(0).max(1),
	scores: z.partialRecord(AudioTypeSchema, z.number().min(0).max(1)).optional(),
	reasons: z.array(z.string().max(300)).max(6).optional(),
});

/**
 * Essential Sound ▸ Auto Tag (Premiere's "Auto Tag Audio Types"): gives each clip of `results` the classified audio
 * type, marked "auto" (`essential.tagged`) until the user confirms it (`essentialSound.setType` with the same type).
 * A type the user set (or confirmed) is never replaced unless `force`; a clip auto-tagged before is re-tagged. Clips
 * under `minConfidence` (default 0: every result) are skipped. One undo step. Result `{tagged: [{clipId, audioType,
 * confidence, from}], skipped: [{clipId, code: USER_TYPE | SAME | LOW_CONFIDENCE, reason}]}`.
 */
export const EssentialAutoTagCmd = cmd('essentialSound.autoTag', {
	results: z.record(z.string().min(1).max(200), AutoTagResultSchema).refine((r) => {
		const n = Object.keys(r).length;
		return n >= 1 && n <= AUTO_TAG_MAX_CLIPS;
	}, `1–${AUTO_TAG_MAX_CLIPS} clips`),
	force: z.boolean().optional(),
	minConfidence: z.number().min(0).max(1).optional(),
});

/** "Clear Audio Type": removes the settings and every effect, gain, Volume and pan change they made. */
export const EssentialClearTypeCmd = cmd('essentialSound.clearType', { clipIds: IdListSchema });

/**
 * Sets settings by dotted key, e.g. `{"repair.noise.on": true, "repair.noise.amount": 6, "clarity.eqPreset":
 * "Telephone"}` (keys of `essentialKeys()`). Changed parameters of keyframed effects get a keyframe at `at` (sequence
 * time; default: the clip's first frame).
 */
export const EssentialSetCmd = cmd('essentialSound.set', {
	clipIds: IdListSchema,
	values: z.record(z.string(), z.unknown()),
	at: TimeInputSchema.optional(),
});

/** Applies a built-in preset by name (for the clip's type or `audioType`), or explicit `settings` (a user preset). */
export const EssentialApplyPresetCmd = cmd('essentialSound.applyPreset', {
	clipIds: IdListSchema,
	preset: z.string().min(1).optional(),
	audioType: AudioTypeSchema.optional(),
	settings: z.record(z.string(), z.unknown()).optional(),
	at: TimeInputSchema.optional(),
});

/**
 * Loudness ▸ Auto-Match with measured values: `measuredLufs[clipId]` is the integrated loudness of the clip's own
 * signal (its effects, no gain/Volume/pan: `POST /api/audio/analyze` scope `clips`, levels `source`); the match gain
 * brings it to `targetLufs` (default −23 LUFS) on top of the user's own clip gain. null = silent (left unchanged).
 */
export const EssentialAutoMatchCmd = cmd('essentialSound.autoMatch', {
	measuredLufs: z.record(z.string(), z.number().nullable()),
	targetLufs: z.number().min(-60).max(0).optional(),
});

const RemixPieceSchema = z.strictObject({
	/** Source start of the piece in seconds from the clip's content start (`sourceIn`). */
	srcSeconds: z.number().min(0),
	lenSeconds: z.number().positive(),
});

/**
 * Remix (Essential Sound ▸ Duration ▸ Remix, the Remix tool): the music clip becomes the plan's pieces (grouped clips
 * with constant-power crossfades at the joints), `targetFrames` long. The plan comes from `POST /api/audio/remix`
 * (beat tracking + similarity). A clip that is already a remix piece is first restored to its original.
 */
export const ClipRemixCmd = cmd('clip.remix', {
	clipId: IdRefSchema,
	targetFrames: z.number().int().min(1),
	pieces: z.array(RemixPieceSchema).min(1).max(256),
	bpm: z.number().positive(),
	segments: z.number().min(0).max(100).optional(),
	variations: z.number().min(0).max(100).optional(),
	/**
	 * Crossfade at each joint (frames; default the frames of 30 ms, at least 1). The crossfade ends at the joint
	 * (`end-at-cut`): the joints sit just before a beat's attack, so neither side's attack is faded or doubled.
	 */
	crossfadeFrames: z.number().int().min(1).max(30).optional(),
	/**
	 * The crossfade of each joint (frames, one per joint, in order), when the plan measured joints that need longer
	 * than `crossfadeFrames` (music that would sound chopped there: `RemixPlanResult.jointCrossfadeSeconds`).
	 */
	jointCrossfadeFrames: z.array(z.number().int().min(1).max(30)).max(255).optional(),
	/**
	 * Spec 12 P6-E11: what the plan landed (`POST /api/audio/remix-plan {anchors}`): each source moment (seconds from the
	 * clip's content start) and the sequence frame it plays at. Recorded on the pieces so a later remix lands them again.
	 */
	anchors: z
		.array(z.strictObject({ sourceSeconds: z.number().min(0).max(864_000), frame: z.number().int().min(0) }))
		.max(4)
		.optional(),
	/** Spec 12 P6-E11: a fade-in over the first piece (frames), for a plan that trims the intro's head. */
	fadeInFrames: z.number().int().min(1).max(30).optional(),
});

/** Restores the original clip of a remix (any piece's id). */
export const ClipRemixRevertCmd = cmd('clip.remixRevert', { clipId: IdRefSchema });

export const ESSENTIAL_COMMANDS = [
	EssentialSetTypeCmd,
	EssentialAutoTagCmd,
	EssentialClearTypeCmd,
	EssentialSetCmd,
	EssentialApplyPresetCmd,
	EssentialAutoMatchCmd,
	ClipRemixCmd,
	ClipRemixRevertCmd,
] as const;

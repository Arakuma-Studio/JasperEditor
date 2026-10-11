// Essential Sound and Remix edit ordinary clip effects, gain, pan and transitions, so all render paths share them.
import { z } from 'zod';
import { AUDIO_TYPES } from '../../essential/model.ts';
import { cmd, IdListSchema, IdRefSchema, TimeInputSchema } from './common.ts';

const AudioTypeSchema = z.enum(AUDIO_TYPES);

/** Assigns an audio type (resets the settings to the type's defaults unless the clip already has that type). */
export const EssentialSetTypeCmd = cmd('essentialSound.setType', {
	clipIds: IdListSchema,
	audioType: AudioTypeSchema,
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
	/** Crossfade length at each joint (frames, default 1). */
	crossfadeFrames: z.number().int().min(1).max(30).optional(),
});

/** Restores the original clip of a remix (any piece's id). */
export const ClipRemixRevertCmd = cmd('clip.remixRevert', { clipId: IdRefSchema });

export const ESSENTIAL_COMMANDS = [
	EssentialSetTypeCmd,
	EssentialClearTypeCmd,
	EssentialSetCmd,
	EssentialApplyPresetCmd,
	EssentialAutoMatchCmd,
	ClipRemixCmd,
	ClipRemixRevertCmd,
] as const;

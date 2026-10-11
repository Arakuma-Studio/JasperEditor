// Speeds are percentages: 100 means normal speed.
import { z } from 'zod';
import { TimeInterpolationSchema } from '../../schema/sequence.ts';
import { cmd, IdListSchema, IdRefSchema, TimeInputSchema } from './common.ts';

/** Timeline speed of a remap segment in percent (Premiere Pro 14+: up to 20,000 %). */
const SpeedPercent = z.number().gt(0).max(20_000);
/** What happens to the linked audio of a clip whose picture is time-remapped (Premiere keeps it at 100 %). */
export const LinkedAudioPolicySchema = z.enum(['keep', 'mute', 'unlink']);

/**
 * Time Remapping on / off (the Speed stopwatch). On: the clip gets an (identity) remap; its linked audio keeps playing
 * at 100 % (`keep`, Premiere), is disabled (`mute`) or unlinked (`unlink`). Off: every speed keyframe is deleted and
 * the clip plays its content linearly again (trimmed to its media when it would run past it).
 */
export const TimeRemapEnableCmd = cmd('timeRemap.enable', {
	clipIds: IdListSchema,
	enabled: z.boolean(),
	linkedAudio: LinkedAudioPolicySchema.optional(),
});
/** A speed keyframe at a sequence frame of the clip (Ctrl/Cmd-click on the rubber band). Result `{keyframeId}`. */
export const TimeRemapAddKeyframeCmd = cmd('timeRemap.addKeyframe', {
	clipId: IdRefSchema,
	at: TimeInputSchema,
});
export const TimeRemapRemoveKeyframesCmd = cmd('timeRemap.removeKeyframes', {
	clipId: IdRefSchema,
	keyframeIds: z.array(IdRefSchema).min(1),
});
/**
 * Speed of the segment that contains sequence frame `at` (dragging the rubber band). The segment keeps its source
 * frames, so it gets longer or shorter and the clip's out point moves with it. Without `ripple` (Premiere) a longer
 * clip stops at the next clip and the rest goes into its tail; `ripple` moves the clips after it instead.
 */
export const TimeRemapSetSpeedCmd = cmd('timeRemap.setSpeed', {
	clipId: IdRefSchema,
	at: TimeInputSchema,
	speedPercent: SpeedPercent,
	ripple: z.boolean().optional(),
});
/** Moves a speed keyframe to sequence frame `to` (Alt-drag); segment speeds stay. */
export const TimeRemapMoveKeyframeCmd = cmd('timeRemap.moveKeyframe', {
	clipId: IdRefSchema,
	keyframeId: IdRefSchema,
	to: TimeInputSchema,
	ripple: z.boolean().optional(),
});
/**
 * Speed transition of a keyframe (dragging its halves apart): `frames` = the whole transition length in sequence
 * frames, centred on the keyframe (0 = instantaneous); `ease` 0 (linear speed change) … 1 (smooth S-curve).
 */
export const TimeRemapSetTransitionCmd = cmd('timeRemap.setTransition', {
	clipId: IdRefSchema,
	keyframeId: IdRefSchema,
	frames: z.number().min(0),
	ease: z.number().min(0).max(1).optional(),
});
/** A freeze frame of `duration` at sequence frame `at` (Ctrl+Alt-drag); what follows moves later. */
export const TimeRemapAddFreezeCmd = cmd('timeRemap.addFreeze', {
	clipId: IdRefSchema,
	at: TimeInputSchema,
	duration: TimeInputSchema,
	ripple: z.boolean().optional(),
});
/**
 * A palindrome reverse at sequence frame `at` (Ctrl/Cmd-drag): backward for `duration` at `speedPercent` (default
 * 100, Premiere's "full speed"), then forward over the same frames back to `at`.
 */
export const TimeRemapAddReverseCmd = cmd('timeRemap.addReverse', {
	clipId: IdRefSchema,
	at: TimeInputSchema,
	duration: TimeInputSchema,
	speedPercent: SpeedPercent.optional(),
	ripple: z.boolean().optional(),
});
/** Clip ▸ Video Options ▸ Time Interpolation (also in Speed/Duration). */
export const ClipSetTimeInterpolationCmd = cmd('clip.setTimeInterpolation', {
	clipIds: IdListSchema,
	mode: TimeInterpolationSchema,
});
/**
 * Applies the result of a Scene Edit Detection job to one clip in one step: `cuts` are the media times (flicks) where
 * a new shot starts. `applyCuts` adds an edit (linked clips too) at the first frame of each shot the clip shows;
 * `createSubclips` makes one media item per shot (marks = the shot's media range) in a new bin; `createMarkers` adds
 * a clip marker at each cut.
 */
export const ClipApplySceneEditsCmd = cmd('clip.applySceneEdits', {
	clipId: IdRefSchema,
	cuts: z.array(z.number().min(0)),
	applyCuts: z.boolean(),
	createSubclips: z.boolean(),
	createMarkers: z.boolean(),
	binName: z.string().min(1).optional(),
});

export const TIME_COMMANDS = [
	TimeRemapEnableCmd,
	TimeRemapAddKeyframeCmd,
	TimeRemapRemoveKeyframesCmd,
	TimeRemapSetSpeedCmd,
	TimeRemapMoveKeyframeCmd,
	TimeRemapSetTransitionCmd,
	TimeRemapAddFreezeCmd,
	TimeRemapAddReverseCmd,
	ClipSetTimeInterpolationCmd,
	ClipApplySceneEditsCmd,
] as const;

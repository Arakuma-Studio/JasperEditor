import { z } from 'zod';
import { MulticamAudioModeSchema, SyncMethodSchema } from '../../schema/sequence.ts';
import { cmd, IdListSchema, IdRefSchema, RefDeclSchema, TimeInputSchema, TrackRefSchema } from './common.ts';

/** The sync point shared by Synchronize, Merge Clips and Create Multi-Camera Source Sequence. */
const syncFields = {
	/** in = In points, out = Out points, timecode = matching timecode, marker = clip marker, audio = waveforms. */
	method: SyncMethodSchema,
	/** timecode: ignore the hours digits (cameras whose hour was set differently). */
	ignoreHours: z.boolean().optional(),
	/** marker: sync on the first clip marker with this name (default: each clip's first marker). */
	marker: z.string().optional(),
	/**
	 * audio: per clip/item id, its content time (flicks) on a common clock: `t_i = t_clock + audioOffsets[i]` —
	 * `results[].offsetFlicks` of `POST /api/sync/audio` as they are (its reference is 0; the reference may be left
	 * out). The MCP tools and the editor dialogs measure them for you.
	 */
	audioOffsets: z.record(z.string(), z.number()).optional(),
	/** Shift every clip but the reference later by this many frames (a known delay; Premiere's offset). */
	offsetFrames: z.number().int().optional(),
};

/** Clip ▸ Synchronize: move the selected timeline clips (with their linked clips) so their sync points line up. */
export const ClipSynchronizeCmd = cmd('clip.synchronize', {
	clipIds: IdListSchema,
	/** The clip that stays put (default: the selected clip on the lowest video track, else the lowest audio track). */
	referenceClipId: IdRefSchema.optional(),
	/** Or: the selected clip on this track is the reference ("Synchronize point on track"). */
	referenceTrack: TrackRefSchema.optional(),
	...syncFields,
});

/** Clip ▸ Merge Clips: one video clip plus 1–16 audio clips → a merged clip (a project item). */
export const ItemMergeClipsCmd = cmd('item.mergeClips', {
	/** Media items: at most one with video (the reference), the others audio. */
	itemIds: z.array(IdRefSchema).min(2),
	/** Default "<video clip name> - Merged". */
	name: z.string().min(1).optional(),
	binId: IdRefSchema.nullable().optional(),
	/** Leave the video file's own audio out of the merged clip ("Remove Audio From AV Clip"). */
	removeVideoAudio: z.boolean().optional(),
	...syncFields,
	ref: RefDeclSchema.optional(),
});

export const CAMERA_NAMES = ['enumerate', 'clip'] as const;
export const ANGLE_ORDERS = ['selection', 'name', 'timecode'] as const;

/** Clip ▸ Create Multi-Camera Source Sequence. */
export const MulticamCreateCmd = cmd('multicam.create', {
	/** Media items: each with video is a camera (angle); audio-only items are mixed in. */
	itemIds: z.array(IdRefSchema).min(1),
	/** Default "<first camera's clip name> Multicam". */
	name: z.string().min(1).optional(),
	binId: IdRefSchema.nullable().optional(),
	...syncFields,
	/** The camera the others sync to (default: the first camera). */
	referenceItemId: IdRefSchema.optional(),
	/** Sequence preset id; `automatic` (default) = the reference camera's frame size and rate. */
	preset: z.string().optional(),
	/** camera1 = Camera 1's audio, all = every camera mixed, switch = the shown angle's audio. Default camera1. */
	audio: MulticamAudioModeSchema.optional(),
	/** Camera names: `enumerate` (Camera 1, Camera 2…) or `clip` (the clip names). Default enumerate. */
	cameraNames: z.enum(CAMERA_NAMES).optional(),
	/** Explicit camera names in camera order (override `cameraNames`). */
	names: z.array(z.string().min(1)).optional(),
	/** Camera order: selection (itemIds order, default), name (clip name), timecode (start timecode), or item ids. */
	order: z.union([z.enum(ANGLE_ORDERS), z.array(IdRefSchema)]).optional(),
	/** Move the source clips into a "Processed Clips" bin. */
	moveToProcessedBin: z.boolean().optional(),
	ref: RefDeclSchema.optional(),
});

/** An angle: its id, a camera number (1-based among the shown angles) or its name. */
const AngleRefSchema = z.union([z.string().min(1), z.number().int().min(1)]);

/**
 * Switch the angle of existing multi-camera clips: the given clips, the clips under `at`, or (with `range`) only
 * the part of them inside the range (edits are added at its ends and through edits with the same angle healed).
 */
export const MulticamSwitchAngleCmd = cmd('multicam.switchAngle', {
	sequenceId: IdRefSchema.optional(),
	angle: AngleRefSchema,
	clipIds: IdListSchema.optional(),
	at: TimeInputSchema.optional(),
	range: z.strictObject({ from: TimeInputSchema, to: TimeInputSchema }).optional(),
	/** Track of the multi-camera clips for `at`/`range` (default: the topmost or lowest one per selectionTopDown). */
	track: TrackRefSchema.optional(),
	/** With `at`/`range`: Multi-Camera Selection Top Down (topmost multi-camera clip first). Default false. */
	topDown: z.boolean().optional(),
	/** Switch the picture (default true). */
	video: z.boolean().optional(),
	/** Switch the linked multi-camera audio clips too ("Multi-Camera Audio Follows Video", default true). */
	audio: z.boolean().optional(),
});

/** A live switching pass: from each cut's frame on, show its angle (the last one until `to`). One undo step. */
export const MulticamRecordCmd = cmd('multicam.record', {
	sequenceId: IdRefSchema.optional(),
	cuts: z.array(z.strictObject({ at: TimeInputSchema, angle: AngleRefSchema })).min(1),
	/** End of the pass (exclusive frame; default: the end of the multi-camera clips under the first cut). */
	to: TimeInputSchema.optional(),
	track: TrackRefSchema.optional(),
	topDown: z.boolean().optional(),
	video: z.boolean().optional(),
	audio: z.boolean().optional(),
});

/** Clip ▸ Multi-Camera ▸ Enable: multi-camera behaviour of nest clips on or off (on for a plain nest makes its
 * sequence a multi-camera source whose video tracks are the angles). */
export const MulticamSetEnabledCmd = cmd('multicam.setEnabled', {
	clipIds: IdListSchema,
	enabled: z.boolean(),
});

/** Clip ▸ Multi-Camera ▸ Flatten: replace multi-camera clips by the clips their angle shows. */
export const MulticamFlattenCmd = cmd('multicam.flatten', {
	clipIds: IdListSchema,
});

/** Edit Cameras: rename, show/hide and reorder the angles of a multi-camera source; change its audio mode. */
export const MulticamEditAnglesCmd = cmd('multicam.editAngles', {
	sequenceId: IdRefSchema,
	angles: z
		.array(
			z.strictObject({
				angle: AngleRefSchema,
				name: z.string().min(1).optional(),
				enabled: z.boolean().optional(),
			}),
		)
		.optional(),
	/** New camera order (angle ids; every angle exactly once). */
	order: z.array(z.string().min(1)).optional(),
	audio: MulticamAudioModeSchema.optional(),
});

export const MULTICAM_COMMANDS = [
	ClipSynchronizeCmd,
	ItemMergeClipsCmd,
	MulticamCreateCmd,
	MulticamSwitchAngleCmd,
	MulticamRecordCmd,
	MulticamSetEnabledCmd,
	MulticamFlattenCmd,
	MulticamEditAnglesCmd,
] as const;

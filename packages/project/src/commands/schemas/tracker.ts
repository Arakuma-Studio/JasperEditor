// Tracking commands (M2, ARCHITECTURE §19.5, S09:TRK-*). Handlers: handlers/tracker.ts (wp-m2-track).
import { z } from 'zod';
import { Vec2Schema } from '../../schema/common.ts';
import { TrackerSamplesSchema } from '../../schema/sequence.ts';
import { cmd, IdRefSchema, ParamAtSchema, RefDeclSchema } from './common.ts';

const Corners = z.array(Vec2Schema).length(4);

export const TrackerAddCmd = cmd('tracker.add', {
	/** The clip whose picture is tracked (a video clip). */
	clipId: IdRefSchema,
	kind: z.enum(['point', 'planar']),
	name: z.string().min(1).optional(),
	/** Reference frame (clip-relative frames, sequence frame or content flicks) and geometry in media pixels. */
	at: ParamAtSchema,
	corners: Corners.optional(),
	point: Vec2Schema.optional(),
	patch: z.number().int().positive().optional(),
	search: z.number().int().positive().optional(),
	ref: RefDeclSchema.optional(),
});
export const TrackerUpdateCmd = cmd('tracker.update', {
	trackerId: IdRefSchema,
	name: z.string().min(1).optional(),
	at: ParamAtSchema.optional(),
	corners: Corners.optional(),
	point: Vec2Schema.optional(),
	patch: z.number().int().positive().optional(),
	search: z.number().int().positive().optional(),
	smoothing: z.number().min(0).max(60).optional(),
});
export const TrackerRemoveCmd = cmd('tracker.remove', { trackerIds: z.array(IdRefSchema).min(1) });
/** Stores the result of a `track` engine job (whole range replaced, or merged over the samples' span). */
export const TrackerSetSamplesCmd = cmd('tracker.setSamples', {
	trackerId: IdRefSchema,
	samples: TrackerSamplesSchema,
	method: z.string().min(1),
	merge: z.enum(['replace', 'span']).optional(),
});
/** Bakes the tracker onto a target clip as keyframes (S09:TRK-040…046). */
export const TrackerApplyCmd = cmd('tracker.apply', {
	trackerId: IdRefSchema,
	targetClipId: IdRefSchema,
	mode: z.enum(['corner-pin', 'transform']),
	/** transform mode: which Motion properties follow (default all three). */
	components: z
		.array(z.enum(['position', 'scale', 'rotation']))
		.min(1)
		.optional(),
	/** Sequence frames to bake (default: the overlap of both clips). */
	range: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(1) }).optional(),
	/**
	 * wp-m3-trackui (additive, S09:TRK-023): simplify the baked keys in the same transaction, keeping the animation
	 * within `tolerance` sequence pixels of the per-frame track at every frame.
	 */
	simplify: z.strictObject({ tolerance: z.number().positive().max(10_000) }).optional(),
});

/** wp-m2-track (additive): drops the `trackedBy` link of target clips; their keyframes stay (S09:TRU-004 Unlink). */
export const TrackerUnlinkCmd = cmd('tracker.unlink', { clipIds: z.array(IdRefSchema).min(1) });

export const TRACKER_COMMANDS = [
	TrackerAddCmd,
	TrackerUpdateCmd,
	TrackerRemoveCmd,
	TrackerSetSamplesCmd,
	TrackerApplyCmd,
	TrackerUnlinkCmd,
] as const;

// Batch commands (spec 15 EA-031): a whole-video automation pass in a few commands. Each is ONE undoable command
// (one History entry with the rest of its transaction), validated whole: a refusal names the offending item / target
// and key (`items[3].effects[1].keyframes.amount[0]: …`) and nothing of the batch is applied.
import { z } from 'zod';
import { EaseSchema, InInterpolationSchema, InterpolationSchema } from '../../schema/common.ts';
import { cmd, IdRefSchema, ParamAtSchema, RefDeclSchema, TimeInputSchema, TrackRefSchema } from './common.ts';
import { SpatialInputSchema } from './param.ts';

/** Limits of one batch command (the transaction's own limits — 5 000 commands, 20 MB — still apply). */
export const BATCH_LIMITS = {
	/** Adjustment clips per `clip.addAdjustmentBatch` (a proposal holds at most 2 000 items). */
	maxItems: 2000,
	/** Effects per adjustment clip. */
	maxEffects: 32,
	/** Keys per animated parameter. */
	maxKeysPerParam: 1000,
	/** Targets per `keyframe.addBatch`. */
	maxTargets: 5000,
	/** Keys of a whole batch command. */
	maxKeys: 100_000,
} as const;

/** A key of an adjustment item's effect parameter: `frame` counts from the item's first frame (0 … length). */
export const BatchItemKeySchema = z.strictObject({
	frame: z.number().int().min(0),
	value: z.unknown(),
	interpolation: InterpolationSchema.optional(),
	inInterpolation: InInterpolationSchema.optional(),
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
});
export type BatchItemKey = z.infer<typeof BatchItemKeySchema>;

export const BatchEffectSchema = z.strictObject({
	effectId: z.string().min(1),
	/** Static values (like `effect.add`). */
	params: z.record(z.string(), z.unknown()).optional(),
	/** Animated parameters: name → keys relative to the item's start (the static value is the param's or key 0's). */
	keyframes: z
		.record(z.string(), z.array(BatchItemKeySchema).min(1).max(BATCH_LIMITS.maxKeysPerParam))
		.optional(),
});
export type BatchEffect = z.infer<typeof BatchEffectSchema>;

export const AdjustmentBatchItemSchema = z.strictObject({
	start: TimeInputSchema,
	length: TimeInputSchema,
	effects: z.array(BatchEffectSchema).max(BATCH_LIMITS.maxEffects).optional(),
	/** Clip name (default "Adjustment Layer"). */
	name: z.string().min(1).max(200).optional(),
	/** Binds the new clip's id (later commands of the transaction use it). */
	ref: RefDeclSchema.optional(),
});
export type AdjustmentBatchItem = z.infer<typeof AdjustmentBatchItemSchema>;

/**
 * Adjustment clips with their effects and keyframes on one video track (created when the label names the next free
 * one, like `clip.addAdjustment`). Items may not overlap each other; over existing clips the batch is refused
 * (E_OVERLAP naming the item and the clip) unless `overwrite: true` (then each item overwrites what is under it, like
 * `clip.addAdjustment`).
 */
export const ClipAddAdjustmentBatchCmd = cmd('clip.addAdjustmentBatch', {
	sequenceId: IdRefSchema.optional(),
	trackId: TrackRefSchema,
	items: z.array(AdjustmentBatchItemSchema).min(1).max(BATCH_LIMITS.maxItems),
	overwrite: z.boolean().optional(),
});

/** A key of `keyframe.addBatch` (as `keyframe.add`: `at` frames from the clip's start, a sequence frame, …). */
export const BatchKeySchema = z.strictObject({
	at: ParamAtSchema,
	value: z.unknown().optional(),
	interpolation: InterpolationSchema.optional(),
	inInterpolation: InInterpolationSchema.optional(),
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
	spatial: SpatialInputSchema.optional(),
});
export type BatchKey = z.infer<typeof BatchKeySchema>;

export const KeyframeBatchTargetSchema = z.strictObject({
	clipId: IdRefSchema,
	/**
	 * The property within the clip: its `clip.properties` key split on "." (`["transform", "scale"]`, `["opacity"]`,
	 * `["effects", effectInstanceId, param]`), i.e. the path of `keyframe.add` after `["clip", clipId]`; an effect of this
	 * clip may also be given as its param.set target `["effect", effectInstanceId, param]`.
	 */
	path: z.array(z.string().min(1)).min(1).max(8),
	keys: z.array(BatchKeySchema).min(1).max(BATCH_LIMITS.maxKeysPerParam),
});
export type KeyframeBatchTarget = z.infer<typeof KeyframeBatchTargetSchema>;

/** Keys on many clip properties at once (punch-ins, Ken Burns: Motion scale / position keys on every A-roll clip). */
export const KeyframeAddBatchCmd = cmd('keyframe.addBatch', {
	sequenceId: IdRefSchema.optional(),
	targets: z.array(KeyframeBatchTargetSchema).min(1).max(BATCH_LIMITS.maxTargets),
});

export const BATCH_COMMANDS = [ClipAddAdjustmentBatchCmd, KeyframeAddBatchCmd] as const;

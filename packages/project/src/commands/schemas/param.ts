import { z } from 'zod';
import {
	EaseSchema,
	InterpolationSchema,
	SpatialInterpolationSchema,
	Vec2Schema,
} from '../../schema/common.ts';
import { cmd, IdRefSchema, ParamAtSchema, ParamPathSchema, RefDeclSchema, TrackRefSchema } from './common.ts';

export const ParamSetCmd = cmd('param.set', {
	target: ParamPathSchema,
	value: z.unknown(),
	at: ParamAtSchema.optional(),
	sequenceId: IdRefSchema.optional(),
});
export const ParamSetAnimatedCmd = cmd('param.setAnimated', {
	target: ParamPathSchema,
	animated: z.boolean(),
	at: ParamAtSchema.optional(),
	sequenceId: IdRefSchema.optional(),
});

/**
 * Spatial interpolation of a vec2 point key (S03:KF-021/030, wave1 spatial-motion-path). Tangents are offsets
 * from the key's value in value units (sequence px for Motion position); omitted ones keep the key's current
 * effective tangents (Auto Bezier derives them from the neighbours and ignores given ones).
 */
export const SpatialInputSchema = z.strictObject({
	mode: SpatialInterpolationSchema,
	inTangent: Vec2Schema.optional(),
	outTangent: Vec2Schema.optional(),
});

export const KeyframeAddCmd = cmd('keyframe.add', {
	target: ParamPathSchema,
	at: ParamAtSchema,
	value: z.unknown().optional(),
	interpolation: InterpolationSchema.optional(),
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
	/** Additive (spatial-motion-path): point properties only; default = the property's (Auto Bezier for position). */
	spatial: SpatialInputSchema.optional(),
	sequenceId: IdRefSchema.optional(),
	ref: RefDeclSchema.optional(),
});
export const KeyframeUpdateCmd = cmd('keyframe.update', {
	keyframeId: IdRefSchema,
	value: z.unknown().optional(),
	interpolation: InterpolationSchema.optional(),
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
	/** Additive (spatial-motion-path): point properties only. */
	spatial: SpatialInputSchema.optional(),
});
export const KeyframeRemoveCmd = cmd('keyframe.remove', { keyframeIds: z.array(IdRefSchema).min(1) });
export const KeyframeMoveCmd = cmd('keyframe.move', {
	keyframeIds: z.array(IdRefSchema).min(1),
	delta: z.union([
		z.strictObject({ flicks: z.number().int() }),
		z.strictObject({ frames: z.number().int() }),
	]),
});
export const KeyframeSetInterpolationCmd = cmd('keyframe.setInterpolation', {
	keyframeIds: z.array(IdRefSchema).min(1),
	interpolation: InterpolationSchema,
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
});
export const KeyframesPruneCmd = cmd('keyframes.prune', { clipId: IdRefSchema });
/**
 * Right-click ▸ Spatial Interpolation (S03:KF-021) on keys of vec2 point properties. Switching a Linear key to
 * Bezier / Continuous Bezier starts from its Auto Bezier tangents; Continuous aligns the in tangent opposite the
 * out tangent (keeping its length); Linear zeroes them.
 */
export const KeyframeSetSpatialCmd = cmd('keyframe.setSpatialInterpolation', {
	keyframeIds: z.array(IdRefSchema).min(1),
	mode: SpatialInterpolationSchema,
});
/**
 * Edits the spatial tangents of one key (motion-path handle drag, S03:OVL-020). A key that is not Bezier becomes
 * Continuous Bezier and the side not given turns to stay opposite (keeping its length), unless
 * `breakContinuity` (Alt-drag) makes it Bezier with independent sides. Both sides given and not opposite → Bezier.
 */
export const KeyframeSetTangentsCmd = cmd('keyframe.setTangents', {
	keyframeId: IdRefSchema,
	inTangent: Vec2Schema.optional(),
	outTangent: Vec2Schema.optional(),
	breakContinuity: z.boolean().optional(),
});

const EffectTarget = z.union([
	z.strictObject({ clipId: IdRefSchema }),
	z.strictObject({ trackId: TrackRefSchema, sequenceId: IdRefSchema.optional() }),
	z.literal('master'),
]);
export const EffectAddCmd = cmd('effect.add', {
	target: EffectTarget,
	effectId: z.string().min(1),
	index: z.number().int().min(0).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	sequenceId: IdRefSchema.optional(),
	ref: RefDeclSchema.optional(),
});
export const EffectRemoveCmd = cmd('effect.remove', { effectInstanceId: IdRefSchema });
export const EffectReorderCmd = cmd('effect.reorder', {
	effectInstanceId: IdRefSchema,
	index: z.number().int().min(0),
});
export const EffectSetEnabledCmd = cmd('effect.setEnabled', {
	effectInstanceId: IdRefSchema,
	enabled: z.boolean(),
});

export const TransitionAddCmd = cmd('transition.add', {
	sequenceId: IdRefSchema.optional(),
	trackId: TrackRefSchema.optional(),
	at: z.number().int().min(0).optional(),
	clipId: IdRefSchema.optional(),
	edge: z.enum(['in', 'out']).optional(),
	effectId: z.string().min(1),
	duration: z.number().int().min(1).optional(),
	alignment: z.enum(['center', 'start-at-cut', 'end-at-cut']).optional(),
	handles: z.enum(['shorten', 'freeze']).optional(),
	/** Wave-2 transition framework: initial param values (static; keyframes via param.set / keyframe.add). */
	params: z.record(z.string(), z.unknown()).optional(),
	ref: RefDeclSchema.optional(),
});
export const TransitionUpdateCmd = cmd('transition.update', {
	transitionId: IdRefSchema,
	/** M2 (S10:TUI-040): change the type; a video transition stays video, an audio one audio. */
	effectId: z.string().min(1).optional(),
	duration: z.number().int().min(1).optional(),
	alignment: z.enum(['center', 'start-at-cut', 'end-at-cut']).optional(),
	/**
	 * edit-structure: `freeze` lets a video transition keep its duration with too few media frames (the edge frames
	 * repeat, `freezeHandles`); `shorten` fits it to the media. Default: what the transition has.
	 */
	handles: z.enum(['shorten', 'freeze']).optional(),
	/**
	 * Wave-2 transition framework: static param values (`TransitionSpec.params`; a param with keyframes is refused —
	 * use param.set with target ["transition", id, name]).
	 */
	params: z.record(z.string(), z.unknown()).optional(),
});
export const TransitionRemoveCmd = cmd('transition.remove', { transitionIds: z.array(IdRefSchema).min(1) });
export const TransitionApplyDefaultCmd = cmd('transition.applyDefault', {
	clipIds: z.union([z.array(IdRefSchema).min(1), z.literal('$selection')]),
	edges: z.enum(['both', 'in', 'out']),
	/** M2 (S10:TUI-030): which tracks' clips get one (default ['video']). */
	media: z
		.array(z.enum(['video', 'audio']))
		.min(1)
		.optional(),
	/** M2: the user's default transitions (defaults: cross dissolve / constant power). */
	videoEffectId: z.string().min(1).optional(),
	audioEffectId: z.string().min(1).optional(),
	/** M2: duration override (default: the project's default length of each medium, S10:TUI-032). */
	duration: z.number().int().min(1).optional(),
	/** M3 (S10:TUI-033): alignment of the two-sided ones (default center); fades keep their fixed alignment. */
	alignment: z.enum(['center', 'start-at-cut', 'end-at-cut']).optional(),
	/** edit-structure: `freeze` = video transitions keep their length with repeated frames (Premiere's default). */
	handles: z.enum(['shorten', 'freeze']).optional(),
});

export const PARAM_COMMANDS = [
	ParamSetCmd,
	ParamSetAnimatedCmd,
	KeyframeAddCmd,
	KeyframeUpdateCmd,
	KeyframeRemoveCmd,
	KeyframeMoveCmd,
	KeyframeSetInterpolationCmd,
	KeyframesPruneCmd,
	KeyframeSetSpatialCmd,
	KeyframeSetTangentsCmd,
	EffectAddCmd,
	EffectRemoveCmd,
	EffectReorderCmd,
	EffectSetEnabledCmd,
	TransitionAddCmd,
	TransitionUpdateCmd,
	TransitionRemoveCmd,
	TransitionApplyDefaultCmd,
] as const;

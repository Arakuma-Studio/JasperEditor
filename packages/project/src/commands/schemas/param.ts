import { z } from 'zod';
import { EaseSchema, InterpolationSchema } from '../../schema/common.ts';
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

export const KeyframeAddCmd = cmd('keyframe.add', {
	target: ParamPathSchema,
	at: ParamAtSchema,
	value: z.unknown().optional(),
	interpolation: InterpolationSchema.optional(),
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
	sequenceId: IdRefSchema.optional(),
	ref: RefDeclSchema.optional(),
});
export const KeyframeUpdateCmd = cmd('keyframe.update', {
	keyframeId: IdRefSchema,
	value: z.unknown().optional(),
	interpolation: InterpolationSchema.optional(),
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
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
	ref: RefDeclSchema.optional(),
});
export const TransitionUpdateCmd = cmd('transition.update', {
	transitionId: IdRefSchema,
	duration: z.number().int().min(1).optional(),
	alignment: z.enum(['center', 'start-at-cut', 'end-at-cut']).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});
export const TransitionRemoveCmd = cmd('transition.remove', { transitionIds: z.array(IdRefSchema).min(1) });
export const TransitionApplyDefaultCmd = cmd('transition.applyDefault', {
	clipIds: z.union([z.array(IdRefSchema).min(1), z.literal('$selection')]),
	edges: z.enum(['both', 'in', 'out']),
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
	EffectAddCmd,
	EffectRemoveCmd,
	EffectReorderCmd,
	EffectSetEnabledCmd,
	TransitionAddCmd,
	TransitionUpdateCmd,
	TransitionRemoveCmd,
	TransitionApplyDefaultCmd,
] as const;

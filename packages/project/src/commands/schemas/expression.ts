// Expressions resolve effect instances by name, so effect renaming is part of this command family.
import { z } from 'zod';
import { cmd, IdRefSchema, ParamPathSchema } from './common.ts';

/** Longest expression text accepted (characters). */
export const MAX_EXPRESSION_LENGTH = 65_536;

/**
 * Sets the expression of a property (`target` = a ParamPath as for `param.set`; a text clip's Source Text is
 * `["clip", id, "text", "content"]`). Empty text removes it. `enabled` defaults to true.
 */
export const ExpressionSetCmd = cmd('expression.set', {
	target: ParamPathSchema,
	text: z.string().max(MAX_EXPRESSION_LENGTH),
	enabled: z.boolean().optional(),
	sequenceId: IdRefSchema.optional(),
});
export const ExpressionClearCmd = cmd('expression.clear', {
	target: ParamPathSchema,
	sequenceId: IdRefSchema.optional(),
});
/** AE's "Enable Expression" switch: a disabled expression keeps its text and renders the keyframed value. */
export const ExpressionSetEnabledCmd = cmd('expression.setEnabled', {
	target: ParamPathSchema,
	enabled: z.boolean(),
	sequenceId: IdRefSchema.optional(),
});
/** Effect Controls ▸ Rename: the instance's own name (null / empty = back to the effect's label). */
export const EffectRenameCmd = cmd('effect.rename', {
	effectInstanceId: IdRefSchema,
	name: z.string().max(256).nullable(),
});

export const EXPRESSION_COMMANDS = [
	ExpressionSetCmd,
	ExpressionClearCmd,
	ExpressionSetEnabledCmd,
	EffectRenameCmd,
] as const;

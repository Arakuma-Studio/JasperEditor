// spec 13 SH-003 / AS-032: batch styling of many text clips, batch effect edits and linked project text styles.
// Every command is one undo step whatever the number of clips.
import { z } from 'zod';
import { EaseSchema, InInterpolationSchema, InterpolationSchema } from '../../schema/common.ts';
import { MAX_TEXT_STYLE_NAME, TextStylePatchSchema } from '../../text-styles/patch.ts';
import { cmd, IdRefSchema, RefDeclSchema } from './common.ts';

/** Most clips one batch command edits (bounds the work an untrusted command can ask for). */
export const MAX_BATCH_CLIPS = 20_000;

const ManyClipIds = z
	.union([z.array(IdRefSchema).min(1).max(MAX_BATCH_CLIPS), z.literal('$selection')])
	.describe('Clip ids, or "$selection" (the clips selected in the open editor)');

/** The text clips a style command edits: clip ids, or a subtitle group (`TextClip.caption.groupId`, spec 13 AS-003). */
const TextTargets = {
	clipIds: ManyClipIds.optional(),
	groupId: IdRefSchema.optional().describe('A subtitle group: every text clip whose caption belongs to it'),
};

export const TextSetStyleCmd = cmd('text.setStyle', {
	...TextTargets,
	/** Only the fields named change; shadow / background / OpenType merge field by field (see text-styles/patch.ts). */
	patch: TextStylePatchSchema,
	/** `clear-overridden`: styled runs and paragraph settings lose the fields the patch sets (default `keep`). */
	runs: z.enum(['keep', 'clear-overridden']).optional(),
});

/** A key time counted from each clip's first frame (`in`, default) or back from its last frame (`out`). */
export const RelativeKeySchema = z.strictObject({
	offset: z.union([
		z.strictObject({ frames: z.number().int().min(0).max(10_000_000) }),
		z.strictObject({ seconds: z.number().min(0).max(100_000) }),
	]),
	value: z.unknown(),
	interpolation: InterpolationSchema.optional(),
	inInterpolation: InInterpolationSchema.optional(),
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
});
export type RelativeKey = z.infer<typeof RelativeKeySchema>;
const RelativeKeys = z.array(RelativeKeySchema).min(1).max(1000);
const Anchor = z.enum(['in', 'out']);

/** Effect instances on many clips: explicit instances, or the n-th instance of an effect on each clip. */
const EffectSelector = {
	targets: z
		.array(
			z.strictObject({
				clipId: IdRefSchema,
				effectInstanceId: IdRefSchema,
				/** This instance's own value (setParamMany; wins over `value`). */
				value: z.unknown().optional(),
			}),
		)
		.min(1)
		.max(MAX_BATCH_CLIPS)
		.optional(),
	clipIds: ManyClipIds.optional(),
	effectId: z.string().min(1).optional(),
	/** Which instance of `effectId` on each clip (0 = the first in the stack; default 0). */
	occurrence: z.number().int().min(0).max(1000).optional(),
};

export const EffectSetParamManyCmd = cmd('effect.setParamMany', {
	...EffectSelector,
	param: z.string().min(1),
	/** The same value on every instance (a keyed param gets a key at `at`). */
	value: z.unknown().optional(),
	/** Added to each instance's current value (numbers, or points component by component). */
	delta: z.union([z.number(), z.array(z.number()).min(2).max(3)]).optional(),
	/** Replaces each instance's animation with these keys, timed from each clip's In (or Out). */
	keyframes: RelativeKeys.optional(),
	/** Stopwatch on (one key at `at`) or off (the value at `at` kept) on every instance. */
	animated: z.boolean().optional(),
	/** The key time for keyed params, in frames from each clip's In (or back from its Out with anchor "out"). */
	at: z.strictObject({ frames: z.number().int().min(0).max(10_000_000) }).optional(),
	anchor: Anchor.optional(),
});

export const EffectAddManyCmd = cmd('effect.addMany', {
	clipIds: ManyClipIds,
	effectId: z.string().min(1),
	/** Stack position on each clip (default: the end). */
	index: z.number().int().min(0).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	/** Keyframed params, timed from each clip's In (or Out with anchor "out"). */
	keyframes: z.record(z.string(), RelativeKeys).optional(),
	anchor: Anchor.optional(),
});

export const EffectRemoveManyCmd = cmd('effect.removeMany', { ...EffectSelector });

const StyleName = z.string().trim().min(1).max(MAX_TEXT_STYLE_NAME);

export const TextStyleCreateCmd = cmd('textStyle.create', {
	name: StyleName,
	/** Start from this text clip's style (default: the default text style). */
	fromClipId: IdRefSchema.optional(),
	/** Fields set over the starting style. */
	style: TextStylePatchSchema.optional(),
	id: z.string().optional(),
	ref: RefDeclSchema.optional(),
});
export const TextStyleUpdateCmd = cmd('textStyle.update', {
	styleId: IdRefSchema,
	/** Fields changed in the style; every linked clip follows (its own deviations kept). */
	patch: TextStylePatchSchema.optional(),
	/** Redefine the style as this text clip's style (Premiere "Push to style"); `patch` then applies over it. */
	fromClipId: IdRefSchema.optional(),
});
export const TextStyleRenameCmd = cmd('textStyle.rename', { styleId: IdRefSchema, name: StyleName });
export const TextStyleDeleteCmd = cmd('textStyle.delete', { styleId: IdRefSchema });
export const TextStyleApplyCmd = cmd('textStyle.apply', { styleId: IdRefSchema, ...TextTargets });
export const TextStyleDetachCmd = cmd('textStyle.detach', { ...TextTargets });
export const TextStyleResetCmd = cmd('textStyle.reset', {
	...TextTargets,
	/** Only these style fields go back to the style's values (default: every field). */
	fields: z.array(z.string().min(1).max(64)).min(1).max(64).optional(),
});

export const TEXT_STYLE_COMMANDS = [
	TextSetStyleCmd,
	EffectSetParamManyCmd,
	EffectAddManyCmd,
	EffectRemoveManyCmd,
	TextStyleCreateCmd,
	TextStyleUpdateCmd,
	TextStyleRenameCmd,
	TextStyleDeleteCmd,
	TextStyleApplyCmd,
	TextStyleDetachCmd,
	TextStyleResetCmd,
] as const;

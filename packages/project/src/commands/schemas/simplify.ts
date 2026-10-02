// Keyframe simplification command (M3, S09:TRK-023, S01:KF-010). Handler: handlers/simplify.ts (wp-m3-trackui).
import { z } from 'zod';
import { cmd, IdRefSchema, ParamPathSchema } from './common.ts';

/**
 * Reduces dense keyframes to a minimal subset whose animation stays within `tolerance` of the original at every
 * frame: sequence pixels for Motion and corner pins (largest displacement of the drawn layer's corners), the
 * parameter's own units otherwise. Exactly one of `keyframeIds` (only these keys may go; each parameter's span runs
 * from its first to its last selected key), `targets` (whole parameters) or `clipIds` (every keyframed parameter of
 * the clips, or with `trackedOnly` only those written by `tracker.apply`). The result reports the key counts and
 * the measured deviation; run it as a dry run to preview.
 */
export const KeyframesSimplifyCmd = cmd('keyframes.simplify', {
	tolerance: z.number().positive().max(10_000),
	keyframeIds: z.array(IdRefSchema).min(1).optional(),
	targets: z.array(ParamPathSchema).min(1).optional(),
	clipIds: z.array(IdRefSchema).min(1).optional(),
	trackedOnly: z.boolean().optional(),
	sequenceId: IdRefSchema.optional(),
	/** Include the per-sample deviation profile of every group in the result (previews). */
	details: z.boolean().optional(),
});

export const SIMPLIFY_COMMANDS = [KeyframesSimplifyCmd] as const;

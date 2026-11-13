import { z } from 'zod';

/** Temporary reference declared by a creating command (`"ref": "$title"`, S01:CMD-006). */
export const RefDeclSchema = z.string().regex(/^\$[A-Za-z_][\w.-]*$/, 'ref must look like "$name"');

/** An entity id, or a temp ref (`$name`) / `$selection.primary` resolved at execution time. */
export const IdRefSchema = z.string().min(1);

/** A list of ids, or the string `"$selection"` (clips selected in the session, S01:SEL-009). */
export const IdListSchema = z.union([z.array(IdRefSchema).min(1), z.literal('$selection')]);

/** Track id or label (`"V2"`, `"A1"`, S01:TRK-002). */
export const TrackRefSchema = z.string().min(1);

/** Sequence time: frames, `{frames}`, `{seconds}` (rounded) or a timecode string (S01:TIME-006). */
export const TimeInputSchema = z.union([
	z.number().int(),
	z.strictObject({ frames: z.number().int() }),
	z.strictObject({ seconds: z.number() }),
	z.string().regex(/^-?\d{1,3}[:;]\d{1,2}[:;]\d{1,2}[:;.]\d{1,3}$/, 'timecode HH:MM:SS:FF'),
]);
export type TimeInput = z.infer<typeof TimeInputSchema>;

/** Content time: `{flicks}`, `{seconds}` or `{sourceFrames}` at the source's nominal rate. */
export const ContentTimeInputSchema = z.union([
	z.strictObject({ flicks: z.number().int().min(0) }),
	z.strictObject({ seconds: z.number().min(0) }),
	z.strictObject({ sourceFrames: z.number().int().min(0) }),
]);
export type ContentTimeInput = z.infer<typeof ContentTimeInputSchema>;

/** `at` for parameter/keyframe commands (S01:CMD-013). */
export const ParamAtSchema = z.union([
	z.strictObject({ frames: z.number().int() }),
	z.strictObject({ sequenceFrame: z.number().int().min(0) }),
	z.strictObject({ flicks: z.number().int().min(0) }),
	z.string().regex(/^-?\d{1,3}[:;]\d{1,2}[:;]\d{1,2}[:;.]\d{1,3}$/, 'timecode HH:MM:SS:FF'),
]);
export type ParamAt = z.infer<typeof ParamAtSchema>;

/** Address of an animatable property (S01:CMD-010), e.g. `["clip", "clp_…", "transform", "position"]`. */
export const ParamPathSchema = z.array(z.string().min(1)).min(2);
export type ParamPath = z.infer<typeof ParamPathSchema>;

export const SyncConflictSchema = z.enum(['refuse', 'cut']);
export const EditModeSchema = z.enum(['overwrite', 'insert']);

export const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
	z.strictObject({ type: z.literal(type), ...shape });

/**
 * Join fades of a cut (default false: hard cuts): true gives the audio edges the cut makes Clean Up's equal-power 4 ms
 * `edgeFades`, in the same undo step.
 */
export const JoinFadesSchema = z.boolean();

// Interpret Footage (workstream `imports`, docs/wp-notes/imports.md). Handlers: handlers/interpret.ts.
import { z } from 'zod';
import { RationalSchema, RGBASchema } from '../../schema/common.ts';
import { cmd, IdRefSchema } from './common.ts';

/**
 * A patch of the Interpret Footage sections: an absent field is left as it is, `null` goes back to the file's own
 * value. Sections a later workstream adds (colour management) are separate fields of the same object.
 */
export const InterpretationPatchSchema = z.strictObject({
	/** Frame Rate ▸ Assume this frame rate (fps as a rational, e.g. {num: 24000, den: 1001}); null = from file. */
	frameRate: RationalSchema.nullable().optional(),
	/** Pixel Aspect Ratio ▸ Conform to (e.g. {num: 10, den: 11} for DV NTSC); null = from file. */
	pixelAspect: RationalSchema.nullable().optional(),
	/** Field Order ▸ Conform to; interlaced pictures are deinterlaced on every path. null = from file. */
	fieldOrder: z.enum(['progressive', 'upper', 'lower']).nullable().optional(),
	/**
	 * Alpha Channel: `straight`, `premultiplied` (matted with `matte`, default black) or `ignore`; `invert` inverts the
	 * alpha after the mode. null = from file (straight).
	 */
	alpha: z
		.strictObject({
			mode: z.enum(['straight', 'premultiplied', 'ignore']),
			matte: RGBASchema.optional(),
			invert: z.boolean().optional(),
		})
		.nullable()
		.optional(),
	/** Loop: the media plays this many times (1…1000); null or 1 = once. */
	loop: z.number().int().min(1).max(1000).nullable().optional(),
});
export type InterpretationPatch = z.infer<typeof InterpretationPatchSchema>;

/**
 * Modify ▸ Interpret Footage… on media items. Clips that would show time beyond the new media length (an assumed
 * frame rate that shortens it, fewer loops) end at the media's end; time-remapped clips that would leave the media are
 * refused (`E_OUT_OF_MEDIA`). Result `{mediaIds, trimmedClipIds}`.
 */
export const MediaInterpretCmd = cmd('media.interpret', {
	mediaIds: z.array(IdRefSchema).min(1),
	interpretation: InterpretationPatchSchema,
});

export const INTERPRET_COMMANDS = [MediaInterpretCmd] as const;

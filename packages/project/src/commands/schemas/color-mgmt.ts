// Colour management (workstream color-mgmt, docs/wp-notes/color-mgmt.md). Handlers: handlers/color-mgmt.ts. The
// working space and the sequence colour settings are part of `sequence.updateSettings` (`workingColorSpace`, `color`).
import { z } from 'zod';
import { ColorInterpretationPatchSchema } from '../../color/model.ts';
import { cmd, IdListSchema, IdRefSchema } from './common.ts';

/**
 * Modify ▸ Interpret Footage ▸ Colour on media items (video, stills, animated images): a colour space override (a
 * `COLOR_SPACES` id such as `slog3-sgamut3cine`, `rec2100-pq`; null = automatic from the file's tags), the range of
 * the file for log curves, tone mapping on/off for this source, the PQ content peak, an input LUT (a `lut` item; its
 * output is read as `space`, Rec. 709 when unset) or a space of a custom OCIO config (`{configId, space}`, a
 * `color-config` item and one of its colour spaces). `color: null` makes everything automatic again.
 */
export const MediaInterpretColorCmd = cmd('media.interpretColor', {
	mediaIds: z.array(IdRefSchema).min(1),
	color: ColorInterpretationPatchSchema.nullable(),
});

/**
 * The colour interpretation of single clips (Lumetri ▸ Settings ▸ clip colour space): the same fields as
 * `media.interpretColor`, overriding the media's per field. `color: null` removes the clip override.
 */
export const ClipSetColorInterpretationCmd = cmd('clip.setColorInterpretation', {
	clipIds: IdListSchema,
	color: ColorInterpretationPatchSchema.nullable(),
});

export const COLOR_MGMT_COMMANDS = [MediaInterpretColorCmd, ClipSetColorInterpretationCmd] as const;

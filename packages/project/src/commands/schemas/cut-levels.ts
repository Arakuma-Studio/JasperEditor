// Cut-edge levels carried by a cut command (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"): windows
// of a media's voice analysis around the edges the command will cut, so a pure command can move its edges off speech
// (`snapToSilence`). The caller slices them from the engine's voice analysis (`cutLevelWindows`).
import { z } from 'zod';
import { IdRefSchema } from './common.ts';

/** Most 10 ms frames one window holds (60 s). */
export const CUT_LEVELS_MAX_FRAMES = 6000;

export const CutLevelsSchema = z
	.array(
		z.strictObject({
			mediaId: IdRefSchema,
			/** Audio stream of the media (default: any clip of the media). */
			stream: z.number().int().min(0).optional(),
			/** First 10 ms frame of the window (media time / 10 ms). */
			from: z.number().int().min(0),
			/** Base64 of the window's quantised level bytes (the voice analysis level plane: dB = −120 + q / 2). */
			level: z
				.string()
				.min(1)
				.max(Math.ceil(CUT_LEVELS_MAX_FRAMES / 3) * 4),
			/** Base64 of the window's class bytes (0 silence, 1 breath-like, 2 speech), the same length. */
			classes: z
				.string()
				.max(Math.ceil(CUT_LEVELS_MAX_FRAMES / 3) * 4)
				.optional(),
			floorDb: z.number().min(-200).max(50).nullable(),
			speechDb: z.number().min(-200).max(50).nullable(),
		}),
	)
	.max(256);
export type CutLevels = z.infer<typeof CutLevelsSchema>;

/**
 * Move the cut's edges off speech (the nearest quiet frame boundary within 0.15 s, never across a word; a word's decay
 * kept at an out edge, its attack at an in edge, breaths left out). Needs `levels`; without them the cut stays exact
 * and a `W_NO_LEVELS` warning says so.
 */
export const SnapToSilenceSchema = z.boolean();

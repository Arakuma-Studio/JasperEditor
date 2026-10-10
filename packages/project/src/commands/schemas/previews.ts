// previews workstream (docs/wp-notes/previews.md): Sequence Settings ▸ Video Previews.
import { z } from 'zod';
import { PREVIEW_FORMATS } from '../../schema/sequence.ts';
import { cmd, IdRefSchema } from './common.ts';

/** Preview file format, size and quality of a sequence (changing them makes the other format's files unused). */
export const SequenceSetPreviewSettingsCmd = cmd('sequence.setPreviewSettings', {
	sequenceId: IdRefSchema.optional(),
	format: z.enum(PREVIEW_FORMATS).optional(),
	size: z.enum(['full', 'half']).optional(),
	quality: z.enum(['standard', 'high']).optional(),
});

export const PREVIEWS_COMMANDS = [SequenceSetPreviewSettingsCmd] as const;

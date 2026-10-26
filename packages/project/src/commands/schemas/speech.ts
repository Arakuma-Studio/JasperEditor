// Recognition jobs attach transcripts here; text corrections and caption edits use transcript.* commands.
import { z } from 'zod';
import { MAX_TRANSCRIPT_SEGMENTS, TranscriptSegmentSchema } from '../../schema/media.ts';
import { cmd, IdRefSchema, RefDeclSchema } from './common.ts';

export const TranscriptAttachWordSchema = z.object({
	text: z.string(),
	/** Flicks of media time. */
	start: z.number().int().min(0),
	end: z.number().int().min(0),
	confidence: z.number().min(0).max(1).nullable().optional(),
	/** A key of `speakers`. */
	speaker: z.string().nullable().optional(),
});

export const TranscriptAttachCmd = cmd('transcript.attach', {
	mediaId: IdRefSchema,
	language: z.string().min(1),
	origin: z.enum(['whisper-local', 'cloud-asr', 'subtitle-file', 'manual']).optional(),
	words: z.array(TranscriptAttachWordSchema),
	speakers: z.record(z.string(), z.object({ name: z.string() })).optional(),
	model: z.string().optional(),
	task: z.enum(['transcribe', 'translate']).optional(),
	sourceLanguage: z.string().optional(),
	/** Media ranges (flicks) the words cover when not the whole media (a sequence-mix transcription). */
	coverage: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).optional(),
	/** spec 14 TC-003: the recogniser's segments with decoder scores (media time, flicks). */
	segments: z.array(TranscriptSegmentSchema).max(MAX_TRANSCRIPT_SEGMENTS).optional(),
	/**
	 * `replace` (default): the media's transcript becomes this one (same id, so references keep working);
	 * `merge`: only the words inside `coverage` are replaced; `keep`: nothing happens when the media already has
	 * a transcript.
	 */
	mode: z.enum(['replace', 'merge', 'keep']).optional(),
	ref: RefDeclSchema.optional(),
});

export const SPEECH_COMMANDS = [TranscriptAttachCmd] as const;

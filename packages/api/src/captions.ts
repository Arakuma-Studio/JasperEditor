// wp captions: reading a caption / transcript file by path on a local engine (desktop File ▸ Import of caption files).
import { z } from 'zod';

export const CaptionFileReadRequestSchema = z.object({ path: z.string().min(1) });
export type CaptionFileReadRequest = z.infer<typeof CaptionFileReadRequestSchema>;

export const CaptionFileReadResponseSchema = z.object({
	name: z.string(),
	bytes: z.number().int().min(0),
	contentBase64: z.string(),
});
export type CaptionFileReadResponse = z.infer<typeof CaptionFileReadResponseSchema>;

/** Files the caption reader accepts (caption formats, plus JSON transcripts). */
export const CAPTION_FILE_EXTENSIONS = [
	'srt',
	'vtt',
	'scc',
	'mcc',
	'stl',
	'ttml',
	'dfxp',
	'xml',
	'json',
] as const;

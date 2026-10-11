// Word times are flicks (705,600,000 per second).
import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

/** A speech model of the catalogue (`GET /api/speech/models`). */
export const SpeechModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** Millions of parameters. */
	parameters: z.number(),
	/** Recognises 99 languages (detects the language, translates to English); `.en` models are English only. */
	multilingual: z.boolean(),
	default: z.boolean(),
	description: z.string(),
	license: z.string(),
	licenseUrl: z.string(),
	attribution: z.string(),
	sourceUrl: z.string(),
	/** Pinned Hugging Face revision of every file. */
	revision: z.string(),
	sizeBytes: z.number().int().min(0),
	installed: z.boolean(),
	/** Bytes still to download (files already present are kept). */
	missingBytes: z.number().int().min(0),
});
export type SpeechModel = z.infer<typeof SpeechModelSchema>;
export const SpeechModelsResponseSchema = z.object({ models: z.array(SpeechModelSchema) });
export const SpeechModelDeleteResponseSchema = z.object({
	modelId: z.string(),
	freedBytes: z.number().int().min(0),
});

/** Options shared by every transcription request. */
export const TranscribeOptionsSchema = z.object({
	/** Catalogue id (default: the catalogue default, `whisper-base`). */
	model: z.string().optional(),
	/** ISO 639-1 code, or `auto` (default) = detect from the first 30 s. English-only models always use `en`. */
	language: z.string().optional(),
	/** `translate` = English text of speech in another language (multilingual models). */
	task: z.enum(['transcribe', 'translate']).optional(),
	/** Label speakers (MFCC clustering). */
	speakerLabels: z.boolean().optional(),
	/** Exactly this many speakers (a hint for speaker labelling). */
	speakerCount: z.number().int().min(1).max(32).optional(),
	/** At most this many speakers (default 6). */
	maxSpeakers: z.number().int().min(1).max(32).optional(),
	/** Beam search width (default 5; 1 = greedy, about twice as fast, slightly less accurate). */
	beamSize: z.number().int().min(1).max(10).optional(),
});
export type TranscribeOptions = z.infer<typeof TranscribeOptionsSchema>;

/** `POST /api/media/:key/transcribe`. */
export const TranscribeMediaRequestSchema = TranscribeOptionsSchema.extend({
	projectId: z.string().optional(),
	/** Absolute ffmpeg stream index of the audio stream (default: the first audio stream). */
	streamIndex: z.number().int().min(0).optional(),
});
export type TranscribeMediaRequest = z.infer<typeof TranscribeMediaRequestSchema>;

/** `POST /api/speech/transcribe-sequence`: transcribe the mixed audio of a sequence (or its In/Out range). */
export const TranscribeSequenceRequestSchema = TranscribeOptionsSchema.extend({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	projectId: z.string().optional(),
	/** `entire` (default) or the sequence In/Out. */
	range: z.enum(['entire', 'in-out']).optional(),
});
export type TranscribeSequenceRequest = z.infer<typeof TranscribeSequenceRequestSchema>;

export const TranscriptResultWordSchema = z.object({
	text: z.string(),
	/** Flicks: media content time (media jobs) or sequence time (sequence jobs). */
	start: z.number().int().min(0),
	end: z.number().int().min(0),
	confidence: z.number().min(0).max(1),
	/** Speaker key (`S1`, `S2`…) when speakers were labelled, else null. */
	speaker: z.string().nullable(),
});
export type TranscriptResultWord = z.infer<typeof TranscriptResultWordSchema>;

/** `EngineJob.result` of a `transcription` job. */
export const TranscriptionResultSchema = z.object({
	target: z.discriminatedUnion('type', [
		z.object({ type: z.literal('media'), mediaKey: z.string(), streamIndex: z.number().int().nullable() }),
		z.object({
			type: z.literal('sequence'),
			sequenceId: z.string(),
			/** Sequence frames transcribed. */
			range: z.object({ startFrame: z.number().int(), endFrame: z.number().int() }),
			/** `mixFingerprint` of the sequence when it was mixed. */
			mixHash: z.string(),
		}),
	]),
	model: z.string(),
	language: z.string(),
	/** Probability of the detected language (null when the language was given). */
	languageProbability: z.number().nullable(),
	task: z.enum(['transcribe', 'translate']),
	/** Audio length transcribed (flicks). */
	duration: z.number().int().min(0),
	words: z.array(TranscriptResultWordSchema),
	speakers: z.record(z.string(), z.object({ name: z.string() })),
	segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
	/** Seconds of processing (decode, model load, recognition). */
	timings: z.object({ decodeMs: z.number(), loadMs: z.number(), transcribeMs: z.number() }),
});
export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;

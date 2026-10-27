// Spec 17 SC-050 / SC-055: applying script-guided transcript fixes — `transcript.replaceWords` (index-free word
// replacements that patch subtitles and caption tracks in place) and `scriptFix.configure` (the sequence's persisted
// Fix Transcript settings and rejected fixes). docs/wp-notes/script-correction.md "Applying fixes".
import { z } from 'zod';
import { REPLACE_WORDS_LIMITS } from '../../captions/replace-words.ts';
import {
	SCRIPT_FIX_MAX_REJECTED,
	ScriptFixFingerprintSchema,
	ScriptFixSettingsSchema,
} from '../../script-fix/sequence-state.ts';
import { cmd, IdRefSchema } from './common.ts';

const flicks = z.number().int().min(0);

/** A new word: media-time flicks and the measured confidence (null = unknown). */
export const ReplaceWordsWordSchema = z.strictObject({
	text: z
		.string()
		.min(1)
		.max(REPLACE_WORDS_LIMITS.maxWordText)
		.regex(/^\S+$/, 'a word has no spaces')
		.describe('The word as it should read (script spelling and casing; punctuation attached)'),
	start: flicks.describe('Start (media-time flicks)'),
	end: flicks.describe('End (media-time flicks)'),
	confidence: z.number().min(0).max(1).nullable().describe('Confidence 0…1 (null = unknown)'),
});

/** One edit: the old words in `[start, end)` and their exact texts, and the new words (inside the span). */
export const ReplaceWordsEditSchema = z.strictObject({
	start: flicks.describe('Span start (media-time flicks) of the old words'),
	end: flicks.describe(
		'Span end (media-time flicks, exclusive); for an insertion, the gap between the neighbours',
	),
	expect: z
		.array(z.string().max(2000))
		.max(REPLACE_WORDS_LIMITS.maxWordsPerEdit)
		.describe(
			'Exact texts of the transcript words in the span now ([] = an insertion); a mismatch refuses E_STALE',
		),
	words: z
		.array(ReplaceWordsWordSchema)
		.max(REPLACE_WORDS_LIMITS.maxWordsPerEdit)
		.describe('The new words, sorted, non-overlapping, inside [start, end] ([] = delete the old words)'),
});

export const TranscriptReplaceWordsCmd = cmd('transcript.replaceWords', {
	transcriptId: IdRefSchema,
	/** Sorted by start, spans not overlapping; all apply or none (one undo step with the subtitle patch). */
	edits: z.array(ReplaceWordsEditSchema).min(1).max(REPLACE_WORDS_LIMITS.maxEdits),
	/** Subtitle text clips showing the words are patched in place (default) or left alone. */
	subtitles: z.enum(['patch', 'none']).optional(),
	/** Older caption-track clips showing the words are patched in place (default) or left alone. */
	captionTracks: z.enum(['patch', 'none']).optional(),
});

export const ScriptFixConfigureCmd = cmd('scriptFix.configure', {
	sequenceId: IdRefSchema.optional(),
	/** Fix Transcript settings: the given fields replace the stored ones; null clears them (the defaults). */
	settings: ScriptFixSettingsSchema.nullable().optional(),
	/** Fix fingerprints to remember as rejected (not offered again unless "Show rejected")… */
	reject: z.array(ScriptFixFingerprintSchema).max(SCRIPT_FIX_MAX_REJECTED).optional(),
	/** …to forget… */
	unreject: z.array(ScriptFixFingerprintSchema).max(SCRIPT_FIX_MAX_REJECTED).optional(),
	/** …or forget them all (before `reject`). */
	clearRejected: z.boolean().optional(),
});

export const SCRIPT_FIX_COMMANDS = [TranscriptReplaceWordsCmd, ScriptFixConfigureCmd] as const;

// Caption moves, trims, ripple deletes and sync-lock edits use the ordinary clip commands.
import { z } from 'zod';
import { CaptionStandardSchema, CaptionStyleSchema } from '../../schema/sequence.ts';
import { cmd, IdListSchema, IdRefSchema, RefDeclSchema, TimeInputSchema, TrackRefSchema } from './common.ts';

export const CAPTION_IMPORT_FORMATS = ['srt', 'vtt', 'scc', 'mcc', 'stl', 'ttml', 'dfxp'] as const;
const CaptionFormatSchema = z.enum(CAPTION_IMPORT_FORMATS);

/** Caption rules of Create Captions (Premiere's dialog; FilmCraft `CaptionRules`). */
export const CaptionRulesSchema = z.strictObject({
	maxChars: z.number().int().min(1).max(200).optional().describe('Maximum characters per line (default 42)'),
	lines: z.number().int().min(1).max(4).optional().describe('Lines per caption (default 2)'),
	minSeconds: z.number().min(0).max(60).optional().describe('Minimum caption duration (default 1)'),
	maxSeconds: z.number().min(0.1).max(60).optional().describe('Maximum caption duration (default 7)'),
	gapFrames: z
		.number()
		.int()
		.min(0)
		.max(60)
		.optional()
		.describe('Frames left empty between captions (default 0)'),
	breakPauseSeconds: z
		.number()
		.min(0)
		.max(60)
		.optional()
		.describe('A pause at least this long starts a new caption (default 1)'),
});
export type CaptionRulesInput = z.infer<typeof CaptionRulesSchema>;

const CueInputSchema = z.strictObject({
	start: TimeInputSchema,
	end: TimeInputSchema,
	text: z.string(),
	speaker: z.string().nullable().optional(),
	id: z.string().nullable().optional(),
	settings: z.string().optional(),
});

/** Where new captions go: an existing caption track, or `"new"` (a track is added). */
const CaptionTrackTargetSchema = z.union([TrackRefSchema, z.literal('new')]);

export const CaptionAddTrackCmd = cmd('caption.addTrack', {
	sequenceId: IdRefSchema.optional(),
	name: z.string().nullable().optional(),
	language: z.string().optional(),
	standard: CaptionStandardSchema.optional(),
	/** Insert position among caption tracks (0 = C1). Default: after the last one. */
	index: z.number().int().min(0).optional(),
	/** Make it the active caption track (default true). */
	active: z.boolean().optional(),
	style: CaptionStyleSchema.partial().optional(),
	ref: RefDeclSchema.optional(),
});

export const CaptionSetActiveTrackCmd = cmd('caption.setActiveTrack', {
	sequenceId: IdRefSchema.optional(),
	trackId: TrackRefSchema.nullable(),
});

export const CaptionAddCmd = cmd('caption.add', {
	sequenceId: IdRefSchema.optional(),
	/** Caption track (default: the active one; one is created when the sequence has none). */
	track: TrackRefSchema.optional(),
	at: TimeInputSchema.optional().describe('Start (default 0)'),
	duration: TimeInputSchema.optional().describe('Length (default 3 s; cut short at the next caption)'),
	text: z.string(),
	speaker: z.string().nullable().optional(),
	style: CaptionStyleSchema.partial().optional(),
	ref: RefDeclSchema.optional(),
});

export const CaptionImportCmd = cmd('caption.import', {
	sequenceId: IdRefSchema.optional(),
	track: CaptionTrackTargetSchema.optional().describe('Caption track, or "new" (default)'),
	/** File content: text, or base64 for binary EBU STL (`contentBase64`), or parsed cues. */
	content: z.string().optional(),
	contentBase64: z.string().optional(),
	cues: z.array(CueInputSchema).optional(),
	format: CaptionFormatSchema.optional().describe('Default: detected from the content (and `fileName`)'),
	fileName: z.string().optional(),
	/** Sequence time of the file's 00:00:00:00 (default 0). */
	offset: TimeInputSchema.optional(),
	name: z.string().nullable().optional(),
	language: z.string().optional(),
	/** Remove the target track's captions first (default false: the import overwrites where cues fall). */
	replace: z.boolean().optional(),
	ref: RefDeclSchema.optional(),
});

export const CaptionSetTextCmd = cmd('caption.setText', {
	clipId: IdRefSchema,
	/** Lines separated by `\n`; a blank line starts a new page. Unchanged words keep their timing. */
	text: z.string().optional(),
	/** Speaker of every word of the caption (null = none). */
	speaker: z.string().nullable().optional(),
});

export const CaptionSplitCmd = cmd('caption.split', {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	/** Captions to split (default: every caption under `at` on unlocked caption tracks). */
	clipIds: IdListSchema.optional(),
});

export const CaptionMergeCmd = cmd('caption.merge', {
	clipIds: IdListSchema,
});

/**
 * Deletes captions. `ripple` closes each gap on the caption's own track only (later captions move left; other
 * tracks never move — FilmCraft / Premiere caption ripple). For a sync-locked ripple use `clip.extract`.
 */
export const CaptionDeleteCmd = cmd('caption.delete', {
	clipIds: IdListSchema,
	ripple: z.boolean().optional(),
});

export const CaptionSetTimesCmd = cmd('caption.setTimes', {
	clipId: IdRefSchema,
	start: TimeInputSchema.optional(),
	end: TimeInputSchema.optional(),
});

export const CaptionSetStyleCmd = cmd('caption.setStyle', {
	sequenceId: IdRefSchema.optional(),
	/** Track style (all its captions) … */
	trackId: TrackRefSchema.optional(),
	/** … or per-caption overrides. */
	clipIds: IdListSchema.optional(),
	style: CaptionStyleSchema.partial().optional(),
	/** Clear overrides: `true` = all, or the listed fields (clips), or back to the default style (track). */
	reset: z.union([z.boolean(), z.array(z.string())]).optional(),
});

export const CaptionApplyPresetCmd = cmd('caption.applyPreset', {
	sequenceId: IdRefSchema.optional(),
	presetId: z.string(),
	trackId: TrackRefSchema.optional(),
	clipIds: IdListSchema.optional(),
});

export const CaptionSavePresetCmd = cmd('caption.savePreset', {
	sequenceId: IdRefSchema.optional(),
	name: z.string().min(1),
	/** The style to save (default: the track style of `trackId`, else the active track). */
	style: CaptionStyleSchema.partial().optional(),
	trackId: TrackRefSchema.optional(),
	id: z.string().optional(),
});

export const CaptionDeletePresetCmd = cmd('caption.deletePreset', {
	presetId: z.string(),
});

const TextBasedRangeShape = {
	sequenceId: IdRefSchema.optional(),
	/** Sequence transcript word indices (inclusive), as listed by the Transcript panel / `transcript_inspect`. */
	fromWord: z.number().int().min(0),
	toWord: z.number().int().min(0),
};

export const TranscriptImportCmd = cmd('transcript.import', {
	/** Media the transcript belongs to (times are media time) … */
	mediaId: IdRefSchema.optional(),
	/** … or a clip: its media, with `timeBase: 'sequence'` mapping file times through the clip. */
	clipId: IdRefSchema.optional(),
	timeBase: z.enum(['media', 'sequence']).optional(),
	format: z.union([CaptionFormatSchema, z.literal('json')]).optional(),
	content: z.string().optional(),
	contentBase64: z.string().optional(),
	fileName: z.string().optional(),
	language: z.string().optional(),
	ref: RefDeclSchema.optional(),
});

export const TranscriptDeleteCmd = cmd('transcript.delete', {
	transcriptIds: z.array(IdRefSchema).min(1),
});

export const TranscriptRenameSpeakerCmd = cmd('transcript.renameSpeaker', {
	/** One transcript (default: every transcript that has the speaker). */
	transcriptId: IdRefSchema.optional(),
	/** Speaker key or current display name. */
	speaker: z.string(),
	name: z.string().min(1),
});

export const TranscriptSetSpeakerCmd = cmd('transcript.setSpeaker', {
	transcriptId: IdRefSchema,
	fromWord: z.number().int().min(0),
	toWord: z.number().int().min(0),
	/** Speaker key or display name (a new speaker is added); null clears. */
	speaker: z.string().nullable(),
});

export const TranscriptSelectCmd = cmd('transcript.select', { ...TextBasedRangeShape });
export const TranscriptExtractCmd = cmd('transcript.extract', { ...TextBasedRangeShape });
export const TranscriptLiftCmd = cmd('transcript.lift', { ...TextBasedRangeShape });

export const TranscriptInsertIntoCmd = cmd('transcript.insertInto', {
	...TextBasedRangeShape,
	targetSequenceId: IdRefSchema,
	at: TimeInputSchema.optional().describe('Target frame (default: the end of the target sequence)'),
	mode: z.enum(['overwrite', 'insert']).optional(),
});

export const TranscriptRemoveFillersCmd = cmd('transcript.removeFillers', {
	sequenceId: IdRefSchema.optional(),
	/**
	 * Words or phrases ("you know"). Default: per word, the vocalic fillers of its transcript's language — the
	 * sequence's edited list (`cleanup.configure lists`), else Spanish eh, em, emm, ehm, mm, mmm, hmm, mhm, ah, aah, eeh,
	 * ehh, uh, um, eee, ee, aa, m, e; English and other languages um, uh, umm, uhm, erm, er, ah, hmm, mm, mhm.
	 */
	fillers: z.array(z.string().min(1)).optional(),
	/** Use this language's list for every word (`es`, `en`…) instead of each transcript's language. */
	language: z.string().min(1).max(35).optional(),
	/** Equal-power micro-fade at every audio cut edge (ms, default 0 = none). */
	fadeMs: z.number().min(0).max(30).optional(),
	/** Only these sequence word index ranges (inclusive) — default the whole sequence. */
	fromWord: z.number().int().min(0).optional(),
	toWord: z.number().int().min(0).optional(),
});

export const TranscriptRemovePausesCmd = cmd('transcript.removePauses', {
	sequenceId: IdRefSchema.optional(),
	minSeconds: z.number().min(0.04).max(600).optional().describe('Pauses at least this long (default 1)'),
	keepSeconds: z.number().min(0).max(10).optional().describe('Air kept next to each word (default 0.1)'),
	fromWord: z.number().int().min(0).optional(),
	toWord: z.number().int().min(0).optional(),
	/**
	 * `transcript` (default): gaps between the words' timestamps. `level`: gaps in the voice analysis (spec 14), with
	 * edit points from the audio level — the out point where the word's decay falls below floor + `outDb`, the in point
	 * where the onset reaches floor + `inDb` — so no air is left and no word edge is clipped. Needs `voice`.
	 */
	mode: z.enum(['transcript', 'level']).optional(),
	/** Air kept after the previous word / before the next word (s). Default: `keepSeconds` (transcript), 0 (level). */
	padAfter: z.number().min(0).max(10).optional(),
	padBefore: z.number().min(0).max(10).optional(),
	/** Level mode: dB above the noise floor of the out / in points (default 20 / 25). */
	outDb: z.number().min(0).max(80).optional(),
	inDb: z.number().min(0).max(80).optional(),
	/** Level mode: the voice analyses (`voice-analysis` job files, base64) of the clips' media. */
	voice: z
		.array(z.strictObject({ mediaId: IdRefSchema, analysis: z.string().min(1).max(50_000_000) }))
		.max(64)
		.optional(),
	/** Equal-power micro-fade at every audio cut edge (ms, default 0 = none). */
	fadeMs: z.number().min(0).max(30).optional(),
});

export const TranscriptCreateCaptionsCmd = cmd('transcript.createCaptions', {
	sequenceId: IdRefSchema.optional(),
	track: CaptionTrackTargetSchema.optional().describe('Caption track, or "new" (default)'),
	rules: CaptionRulesSchema.optional(),
	fromWord: z.number().int().min(0).optional(),
	toWord: z.number().int().min(0).optional(),
	name: z.string().nullable().optional(),
	language: z.string().optional(),
	style: CaptionStyleSchema.partial().optional(),
	/** Temp ref to the caption track the captions went to. */
	ref: RefDeclSchema.optional(),
});

export const CAPTION_COMMANDS = [
	CaptionAddTrackCmd,
	CaptionSetActiveTrackCmd,
	CaptionAddCmd,
	CaptionImportCmd,
	CaptionSetTextCmd,
	CaptionSplitCmd,
	CaptionMergeCmd,
	CaptionDeleteCmd,
	CaptionSetTimesCmd,
	CaptionSetStyleCmd,
	CaptionApplyPresetCmd,
	CaptionSavePresetCmd,
	CaptionDeletePresetCmd,
	TranscriptImportCmd,
	TranscriptDeleteCmd,
	TranscriptRenameSpeakerCmd,
	TranscriptSetSpeakerCmd,
	TranscriptSelectCmd,
	TranscriptExtractCmd,
	TranscriptLiftCmd,
	TranscriptInsertIntoCmd,
	TranscriptRemoveFillersCmd,
	TranscriptRemovePausesCmd,
	TranscriptCreateCaptionsCmd,
] as const;

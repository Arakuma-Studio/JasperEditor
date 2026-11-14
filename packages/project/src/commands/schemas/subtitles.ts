// Spec 13 AS-001…AS-012 / AS-020: automatic subtitles — generation as ONE command, regeneration, alignment to cuts,
// conversion between text-clip groups and caption tracks, group upkeep and subtitle templates. Each command is one
// undo step whatever the number of subtitles.
import { z } from 'zod';
import { CutAwareSchema, SubtitleRulesSchema, SubtitleTextSchema } from '../../captions/subtitles/rules.ts';
import { cmd, IdRefSchema, RefDeclSchema, TimeInputSchema, TrackRefSchema } from './common.ts';

/** Most clips one subtitle command names. */
export const MAX_SUBTITLE_CLIPS = 20_000;

const ClipIds = z
	.union([z.array(IdRefSchema).min(1).max(MAX_SUBTITLE_CLIPS), z.literal('$selection')])
	.describe('Clip ids, or "$selection"');

export const SubtitleSourceSchema = z.union([
	z.literal('sequence-transcript'),
	z.strictObject({ mediaId: IdRefSchema }),
	z.strictObject({ clipIds: z.array(IdRefSchema).min(1).max(MAX_SUBTITLE_CLIPS) }),
]);

const RangeSchema = z.strictObject({ start: TimeInputSchema, end: TimeInputSchema });

/** A template by id (project copy or built-in, e.g. "builtin:pixel-pop"), or a whole template object. */
const TemplateRefSchema = z.union([z.string().min(1).max(80), z.record(z.string(), z.unknown())]);

const CutAwareArg = z.union([z.boolean(), CutAwareSchema]);

export const CaptionsGenerateCmd = cmd('captions.generate', {
	sequenceId: IdRefSchema.optional(),
	/** What to subtitle (default: the sequence transcript, i.e. every transcribed audio clip). */
	source: SubtitleSourceSchema.optional(),
	/** Only words inside this sequence range (default: the whole sequence). */
	range: RangeSchema.optional(),
	/** Text clips (default unless the template says otherwise) or a caption track. */
	output: z.enum(['text-clips', 'caption-track']).optional(),
	/** A video track (text clips) / caption track, or "new" (default: a new top track named `trackName`). */
	trackId: z.union([TrackRefSchema, z.literal('new')]).optional(),
	trackName: z.string().trim().min(1).max(120).optional(),
	template: TemplateRefSchema.optional(),
	rules: SubtitleRulesSchema.optional(),
	text: SubtitleTextSchema.optional(),
	cutAware: CutAwareArg.optional(),
	language: z.string().min(1).max(35).optional(),
	/** Subtitle group name (default: the template's name). */
	name: z.string().trim().min(1).max(120).optional(),
	/** Put the text clips in a nested sequence (off by default: nests do not follow later ripple edits). */
	nest: z.boolean().optional(),
	/** Only compute: returns the statistics and the first subtitles, changes nothing. */
	dryRun: z.boolean().optional(),
	/** Temp ref to the new group id. */
	ref: RefDeclSchema.optional(),
});

export const CaptionsRegenerateCmd = cmd('captions.regenerate', {
	groupId: IdRefSchema,
	/** Only this sequence range (default: the whole group). */
	range: RangeSchema.optional(),
	/** Changes to the group's stored rules / text transforms / cut awareness. */
	rules: SubtitleRulesSchema.optional(),
	text: SubtitleTextSchema.optional(),
	cutAware: CutAwareArg.optional(),
	/** Subtitle clips of the group to lock first (kept as they are, now and by later regenerations). */
	lock: z.array(IdRefSchema).min(1).max(MAX_SUBTITLE_CLIPS).optional(),
	/** Locked subtitle clips of the group to unlock first (rebuilt from the transcript). */
	unlock: z.array(IdRefSchema).min(1).max(MAX_SUBTITLE_CLIPS).optional(),
	dryRun: z.boolean().optional(),
});

/** Locks or unlocks subtitle text clips: `captions.regenerate` keeps locked ones as they are. */
export const CaptionsLockCmd = cmd('captions.lock', {
	clipIds: ClipIds,
	locked: z.boolean(),
});

export const CaptionsAlignToCutsCmd = cmd('captions.alignToCuts', {
	groupId: IdRefSchema.optional(),
	clipIds: ClipIds.optional(),
	/** Cut awareness options (default: the group's). */
	options: CutAwareSchema.optional(),
	dryRun: z.boolean().optional(),
});

export const CaptionsConvertCmd = cmd('captions.convert', {
	groupId: IdRefSchema.optional(),
	clipIds: ClipIds.optional(),
	captionTrackId: TrackRefSchema.optional(),
	to: z.enum(['text-clips', 'caption-track']),
	/** Keep the source subtitles (default false: they are replaced). */
	keepSource: z.boolean().optional(),
	/** Text clips from a caption track: style them with this template instead of the caption style. */
	template: TemplateRefSchema.optional(),
	trackName: z.string().trim().min(1).max(120).optional(),
	ref: RefDeclSchema.optional(),
});

export const CaptionsUpdateGroupCmd = cmd('captions.updateGroup', {
	groupId: IdRefSchema,
	name: z.string().trim().min(1).max(120).optional(),
	language: z.string().min(1).max(35).optional(),
});

export const CaptionsDeleteGroupCmd = cmd('captions.deleteGroup', {
	groupId: IdRefSchema,
	/** `delete` the group's clips (default) or `keep` them as ordinary text clips. */
	clips: z.enum(['delete', 'keep']).optional(),
});

export const SubtitleTemplateSaveCmd = cmd('subtitleTemplate.save', {
	clipId: IdRefSchema,
	name: z.string().trim().min(1).max(120),
	description: z.string().max(2000).optional(),
	/** Replace this project template (default: a new id). */
	id: z.string().min(1).max(80).optional(),
	/** The clip's effects and their keys (anchored to the In) travel with the template (default true). */
	effects: z.boolean().optional(),
});

export const SubtitleTemplateAddCmd = cmd('subtitleTemplate.add', {
	/** A template object (format "jasper-subtitle-template"), e.g. from the user library. */
	template: z.record(z.string(), z.unknown()),
});

export const SubtitleTemplateDeleteCmd = cmd('subtitleTemplate.delete', { templateId: IdRefSchema });

export const SubtitleTemplateApplyCmd = cmd('subtitleTemplate.apply', {
	template: TemplateRefSchema,
	groupId: IdRefSchema.optional(),
	clipIds: ClipIds.optional(),
	/** Which parts apply (default all): style, layout (box and position), animation, highlight. */
	parts: z
		.strictObject({
			style: z.boolean().optional(),
			layout: z.boolean().optional(),
			animation: z.boolean().optional(),
			highlight: z.boolean().optional(),
		})
		.optional(),
});

export const SUBTITLE_COMMANDS = [
	CaptionsGenerateCmd,
	CaptionsRegenerateCmd,
	CaptionsLockCmd,
	CaptionsAlignToCutsCmd,
	CaptionsConvertCmd,
	CaptionsUpdateGroupCmd,
	CaptionsDeleteGroupCmd,
	SubtitleTemplateSaveCmd,
	SubtitleTemplateAddCmd,
	SubtitleTemplateDeleteCmd,
	SubtitleTemplateApplyCmd,
] as const;

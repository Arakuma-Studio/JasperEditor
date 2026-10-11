import { z } from 'zod';
import {
	ContentTimeInputSchema,
	cmd,
	EditModeSchema,
	IdRefSchema,
	RefDeclSchema,
	TimeInputSchema,
	TrackRefSchema,
} from './common.ts';

/**
 * Premiere's Fit Clip dialog choices when four points disagree: Change Clip Speed (Fit to Fill), Ignore Source In
 * Point, Ignore Source Out Point, Ignore Sequence In Point, Ignore Sequence Out Point.
 */
export const FitClipSchema = z.enum([
	'change-speed',
	'ignore-source-in',
	'ignore-source-out',
	'ignore-sequence-in',
	'ignore-sequence-out',
]);
export type FitClip = z.infer<typeof FitClipSchema>;

const ChannelRangeSchema = z.strictObject({
	in: ContentTimeInputSchema.optional(),
	out: ContentTimeInputSchema.optional(),
});

/** Source patching: destination track (label or id) per source track, `null` = that source track is off. */
const PatchSchema = z.strictObject({
	video: z.array(TrackRefSchema.nullable()).optional(),
	audio: z.array(TrackRefSchema.nullable()).optional(),
});

export const ClipSourceEditCmd = cmd('clip.sourceEdit', {
	sequenceId: IdRefSchema.optional(),
	/** A project item (media, subclip, synthetic or sequence), or media / a sequence directly. */
	source: z.union([
		z.strictObject({ projectItemId: IdRefSchema }),
		z.strictObject({ mediaId: IdRefSchema }),
		z.strictObject({ sequenceId: IdRefSchema }),
	]),
	mode: EditModeSchema.optional(),
	/** Source In (content time). Absent = the item's In mark; null = ignore the mark. */
	sourceIn: ContentTimeInputSchema.nullable().optional(),
	/** Source Out, exclusive. Absent = the item's Out mark; null = ignore the mark. */
	sourceOut: ContentTimeInputSchema.nullable().optional(),
	/** Sequence In. Absent = the sequence In mark; null = ignore it. The sequence In wins over the playhead. */
	sequenceIn: TimeInputSchema.nullable().optional(),
	/** Sequence Out, exclusive. Absent = the sequence Out mark; null = ignore it (with only an Out: backtiming). */
	sequenceOut: TimeInputSchema.nullable().optional(),
	/** Where the edit goes when neither sequence mark is set (the playhead). Default frame 0. */
	playhead: TimeInputSchema.optional(),
	/** Required when all four points are set and the durations differ. */
	fit: FitClipSchema.optional(),
	/** Split edit: the video and audio source ranges (default: the item's split marks). */
	split: z
		.strictObject({ video: ChannelRangeSchema.optional(), audio: ChannelRangeSchema.optional() })
		.optional(),
	/** Source patching (default: source V1→V1, A1→A1, …). */
	patch: PatchSchema.optional(),
	/** A sequence source goes in as one nested clip (Premiere's default) or as its individual clips. */
	sequenceAs: z.enum(['nest', 'clips']).optional(),
	rippleMarkers: z.boolean().optional(),
	ref: RefDeclSchema.optional(),
});

export const ClipTrimEditsCmd = cmd('clip.trimEdits', {
	/** Selected edit points (one per track): a clip edge and the trim type at it. */
	edits: z
		.array(
			z.strictObject({
				clipId: IdRefSchema,
				edge: z.enum(['in', 'out']),
				mode: z.enum(['regular', 'ripple', 'roll']),
			}),
		)
		.min(1),
	/** Movement of every edit point (positive = later). */
	deltaFrames: z.number().int(),
	/** Link partners whose same edge coincides move too (default true). */
	linked: z.boolean().optional(),
	/** Stop at what sync-locked tracks allow instead of refusing (gesture / dynamic trimming). */
	clampToSyncLock: z.boolean().optional(),
	rippleMarkers: z.boolean().optional(),
});

export const ItemMakeSubclipCmd = cmd('item.makeSubclip', {
	/** A media item or a subclip (a subclip of a subclip keeps the media). */
	itemId: IdRefSchema,
	in: ContentTimeInputSchema,
	/** Exclusive. */
	out: ContentTimeInputSchema,
	name: z.string().min(1).optional(),
	/** "Restrict Trims to Subclip Boundaries" (default false, as in Premiere). */
	restrictTrims: z.boolean().optional(),
	/** Bin for the new item (default: the source item's bin). */
	binId: IdRefSchema.nullable().optional(),
	id: z.string().optional(),
	ref: RefDeclSchema.optional(),
});

export const ItemUpdateSubclipCmd = cmd('item.updateSubclip', {
	itemId: IdRefSchema,
	in: ContentTimeInputSchema.optional(),
	out: ContentTimeInputSchema.optional(),
	restrictTrims: z.boolean().optional(),
});

export const EDIT_UX_COMMANDS = [
	ClipSourceEditCmd,
	ClipTrimEditsCmd,
	ItemMakeSubclipCmd,
	ItemUpdateSubclipCmd,
] as const;

import { z } from 'zod';
import { AnimNumberSchema, AnimVec2Schema, LabelColorSchema, RGBASchema } from '../../schema/common.ts';
import { DefaultScalingSchema } from '../../schema/document.ts';
import {
	BlendModeSchema,
	CaptionStyleSchema,
	ChannelsSchema,
	TextBoxSchema,
	TextStyleSchema,
} from '../../schema/sequence.ts';
import {
	ContentTimeInputSchema,
	cmd,
	EditModeSchema,
	IdListSchema,
	IdRefSchema,
	RefDeclSchema,
	SyncConflictSchema,
	TimeInputSchema,
	TrackRefSchema,
} from './common.ts';

const canvas = z.union([
	z.literal('sequence'),
	z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
]);

const TransformPatch = z.strictObject({
	position: z.union([z.tuple([z.number(), z.number()]), AnimVec2Schema]).optional(),
	anchor: z.union([z.tuple([z.number(), z.number()]), AnimVec2Schema]).optional(),
	scale: z.union([z.number(), AnimNumberSchema]).optional(),
	scaleWidth: z.union([z.number(), AnimNumberSchema]).optional(),
	uniformScale: z.boolean().optional(),
	rotation: z.union([z.number(), AnimNumberSchema]).optional(),
	flipH: z.boolean().optional(),
	flipV: z.boolean().optional(),
});
export type TransformPatch = z.infer<typeof TransformPatch>;

const TextContentInput = z.strictObject({
	text: z.string(),
	style: TextStyleSchema.partial().optional(),
	runs: z
		.array(
			z.strictObject({
				from: z.number().int().min(0),
				to: z.number().int().min(0),
				style: TextStyleSchema.partial(),
			}),
		)
		.optional(),
});

const placementTarget = {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	duration: TimeInputSchema,
	track: TrackRefSchema,
	name: z.string().optional(),
	ref: RefDeclSchema.optional(),
	id: z.string().optional(),
};

export const ClipPlaceCmd = cmd('clip.place', {
	sequenceId: IdRefSchema.optional(),
	source: z.union([
		z.strictObject({ mediaId: IdRefSchema }),
		z.strictObject({ syntheticId: IdRefSchema }),
		z.strictObject({ sequenceId: IdRefSchema }),
		z.strictObject({ projectItemId: IdRefSchema }),
	]),
	sourceRange: z.strictObject({ in: ContentTimeInputSchema, out: ContentTimeInputSchema }).optional(),
	at: TimeInputSchema,
	tracks: z
		.strictObject({
			video: TrackRefSchema.optional(),
			audio: z.union([TrackRefSchema, z.array(TrackRefSchema).min(1)]).optional(),
		})
		.optional(),
	mode: EditModeSchema.optional(),
	video: z.boolean().optional(),
	audio: z.boolean().optional(),
	audioMapping: z.enum(['stereo', 'mono-per-channel', 'per-stream']).optional(),
	scaling: DefaultScalingSchema.optional(),
	matchSequence: z.enum(['ask-user', 'match', 'keep']).optional(),
	createTracks: z.boolean().optional(),
	syncConflict: SyncConflictSchema.optional(),
	rippleMarkers: z.boolean().optional(),
	ref: RefDeclSchema.optional(),
});
export const ClipAddTextCmd = cmd('clip.addText', {
	...placementTarget,
	content: TextContentInput,
	box: TextBoxSchema.partial().optional(),
	transform: TransformPatch.optional(),
});
export const ClipAddSolidCmd = cmd('clip.addSolid', { ...placementTarget, color: RGBASchema });
export const ClipAddMotionGraphicCmd = cmd('clip.addMotionGraphic', {
	...placementTarget,
	template: z.strictObject({ id: z.string().min(1), version: z.number().int() }),
	params: z.record(z.string(), z.unknown()).optional(),
	canvas: canvas.optional(),
});
export const ClipAddCompositionCmd = cmd('clip.addComposition', {
	...placementTarget,
	/** M2 (S08): `mediaId` = the mg-bundle asset, `id` = composition id in it; version 1. */
	composition: z.strictObject({
		mediaId: IdRefSchema,
		id: z.string().min(1),
		version: z.number().int().optional(),
	}),
	/** Props over the composition's defaultProps (validated against its propsSchema when known). */
	props: z.record(z.string(), z.unknown()).optional(),
	canvas: canvas.optional(),
});
export const ClipAddCaptionsCmd = cmd('clip.addCaptions', {
	sequenceId: IdRefSchema.optional(),
	transcriptId: IdRefSchema,
	track: TrackRefSchema,
	alignToClipId: IdRefSchema.optional(),
	range: z.strictObject({ from: TimeInputSchema, to: TimeInputSchema }).optional(),
	style: CaptionStyleSchema.partial().optional(),
	ref: RefDeclSchema.optional(),
});
export const ClipAddAdjustmentCmd = cmd('clip.addAdjustment', {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	duration: TimeInputSchema,
	track: TrackRefSchema,
	ref: RefDeclSchema.optional(),
});

export const ClipMoveCmd = cmd('clip.move', {
	clipIds: IdListSchema,
	deltaFrames: z.number().int(),
	/** Track offset within the same kind; a number applies to every kind. */
	deltaTracks: z
		.union([
			z.number().int(),
			z.strictObject({
				video: z.number().int().optional(),
				audio: z.number().int().optional(),
				caption: z.number().int().optional(),
			}),
		])
		.optional(),
	mode: EditModeSchema.optional(),
	createTracks: z.boolean().optional(),
	syncConflict: SyncConflictSchema.optional(),
	rippleMarkers: z.boolean().optional(),
});
export const ClipTrimCmd = cmd('clip.trim', {
	clipId: IdRefSchema,
	edge: z.enum(['in', 'out']),
	deltaFrames: z.number().int(),
	mode: z.enum(['regular', 'ripple', 'roll']).optional(),
	/** Trim link partners whose same edge coincides (S01:CLP-010). Default true. */
	linked: z.boolean().optional(),
	/** Ripple only: stop at the largest shift sync-locked tracks allow (gesture behaviour, S02:TL-543). */
	clampToSyncLock: z.boolean().optional(),
	rippleMarkers: z.boolean().optional(),
});
export const ClipSlipCmd = cmd('clip.slip', { clipIds: IdListSchema, deltaFrames: z.number().int() });
export const ClipSlideCmd = cmd('clip.slide', { clipId: IdRefSchema, deltaFrames: z.number().int() });
export const ClipSplitCmd = cmd('clip.split', {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	clipIds: IdListSchema.optional(),
	tracks: z.array(TrackRefSchema).min(1).optional(),
	scope: z.literal('all-unlocked').optional(),
	/** Split link partners too (default true; Alt = false). */
	linked: z.boolean().optional(),
});
export const ClipLiftCmd = cmd('clip.lift', { clipIds: IdListSchema });
export const ClipExtractCmd = cmd('clip.extract', {
	clipIds: IdListSchema,
	syncConflict: SyncConflictSchema.optional(),
	rippleMarkers: z.boolean().optional(),
});
export const RangeLiftCmd = cmd('range.lift', {
	sequenceId: IdRefSchema.optional(),
	from: TimeInputSchema,
	to: TimeInputSchema,
	tracks: z.array(TrackRefSchema).optional(),
});
export const RangeExtractCmd = cmd('range.extract', {
	sequenceId: IdRefSchema.optional(),
	from: TimeInputSchema,
	to: TimeInputSchema,
	tracks: z.array(TrackRefSchema).optional(),
	rippleMarkers: z.boolean().optional(),
});
export const GapCloseCmd = cmd('gap.close', {
	sequenceId: IdRefSchema.optional(),
	trackId: TrackRefSchema,
	at: TimeInputSchema,
});
export const ClipDuplicateCmd = cmd('clip.duplicate', {
	clipIds: IdListSchema,
	at: TimeInputSchema.optional(),
	deltaFrames: z.number().int().optional(),
	tracks: z.array(TrackRefSchema).optional(),
});

export const ClipPatchSchema = z.strictObject({
	name: z.string().optional(),
	label: LabelColorSchema.optional(),
	enabled: z.boolean().optional(),
	/** Text clips: new content; `style` is merged over the current style. */
	content: z
		.strictObject({
			text: z.string().optional(),
			style: TextStyleSchema.partial().optional(),
			runs: TextContentInput.shape.runs,
		})
		.optional(),
	box: TextBoxSchema.partial().optional(),
	/** Motion-graphic params merged over the current params and validated by the template. */
	params: z.record(z.string(), z.unknown()).optional(),
	canvas: canvas.optional(),
	blendMode: BlendModeSchema.optional(),
	uniformScale: z.boolean().optional(),
	flipH: z.boolean().optional(),
	flipV: z.boolean().optional(),
	gainDb: z.number().min(-96).max(96).optional(),
	channels: ChannelsSchema.optional(),
	loop: z.boolean().optional(),
	maintainPitch: z.boolean().optional(),
	style: CaptionStyleSchema.partial().optional(),
});
export type ClipPatch = z.infer<typeof ClipPatchSchema>;

export const ClipUpdateCmd = cmd('clip.update', {
	clipId: IdRefSchema.optional(),
	clipIds: IdListSchema.optional(),
	patch: ClipPatchSchema,
});
export const ClipSetSpeedCmd = cmd('clip.setSpeed', {
	clipIds: IdListSchema,
	rate: z.number().min(0.01).max(100).optional(),
	duration: TimeInputSchema.optional(),
	reverse: z.boolean().optional(),
	maintainPitch: z.boolean().optional(),
	ripple: z.boolean(),
});
export const ClipReplaceSourceCmd = cmd('clip.replaceSource', {
	clipId: IdRefSchema,
	mediaId: IdRefSchema,
	keepDuration: z.boolean().optional(),
});
export const ClipFitToFrameCmd = cmd('clip.fitToFrame', {
	clipIds: IdListSchema,
	mode: z.enum(['fit', 'fill', 'none']),
});
export const ClipLinkCmd = cmd('clip.link', { clipIds: IdListSchema });
export const ClipUnlinkCmd = cmd('clip.unlink', { clipIds: IdListSchema });
export const ClipGroupCmd = cmd('clip.group', { clipIds: IdListSchema, ref: RefDeclSchema.optional() });
export const ClipUngroupCmd = cmd('clip.ungroup', { clipIds: IdListSchema });
export const ClipNestCmd = cmd('clip.nest', {
	clipIds: IdListSchema,
	name: z.string().min(1),
	ref: RefDeclSchema.optional(),
});

export const CLIP_COMMANDS = [
	ClipPlaceCmd,
	ClipAddTextCmd,
	ClipAddSolidCmd,
	ClipAddMotionGraphicCmd,
	ClipAddCompositionCmd,
	ClipAddCaptionsCmd,
	ClipAddAdjustmentCmd,
	ClipMoveCmd,
	ClipTrimCmd,
	ClipSlipCmd,
	ClipSlideCmd,
	ClipSplitCmd,
	ClipLiftCmd,
	ClipExtractCmd,
	RangeLiftCmd,
	RangeExtractCmd,
	GapCloseCmd,
	ClipDuplicateCmd,
	ClipUpdateCmd,
	ClipSetSpeedCmd,
	ClipReplaceSourceCmd,
	ClipFitToFrameCmd,
	ClipLinkCmd,
	ClipUnlinkCmd,
	ClipGroupCmd,
	ClipUngroupCmd,
	ClipNestCmd,
] as const;

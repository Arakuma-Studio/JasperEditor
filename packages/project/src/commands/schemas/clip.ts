import { z } from 'zod';
import {
	AnimNumberSchema,
	AnimRGBASchema,
	AnimVec2Schema,
	LabelColorSchema,
	RGBASchema,
} from '../../schema/common.ts';
import { DefaultScalingSchema } from '../../schema/document.ts';
import {
	BlendModeSchema,
	CaptionStyleSchema,
	ChannelsSchema,
	SHAPE_STROKE_POSITIONS,
	ShapeTypeSchema,
	TextBoxSchema,
	TextStyleSchema,
} from '../../schema/sequence.ts';
import { ShapeItemInputSchema } from '../../vector/input.ts';
import { CaptionRulesSchema } from './captions.ts';
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
	/** per-paragraph overrides (`index` = paragraph number, 0-based). */
	paragraphs: z
		.array(z.strictObject({ index: z.number().int().min(0), style: TextStyleSchema.partial() }))
		.optional(),
});

/** A new animator side: `preset` (+ `version`, default the newest), window and params over the preset defaults. */
export const TextAnimatorInputSchema = z.strictObject({
	preset: z.string().min(1),
	version: z.number().int().optional(),
	/** Default: the preset's default scaled to the sequence fps. */
	durationFrames: z.number().int().min(1).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});
export type TextAnimatorInput = z.infer<typeof TextAnimatorInputSchema>;
/** clip.addText: `null`/absent side = none. */
export const TextAnimationInputSchema = z.strictObject({
	in: TextAnimatorInputSchema.nullable().optional(),
	out: TextAnimatorInputSchema.nullable().optional(),
});
export type TextAnimationInput = z.infer<typeof TextAnimationInputSchema>;
/**
 * clip.update side patch: `null` removes the side; with `preset` it replaces the side (params reset to the preset
 * defaults, then merged); without `preset` it merges into the current side.
 */
export const TextAnimatorPatchSchema = z.strictObject({
	preset: z.string().min(1).optional(),
	version: z.number().int().optional(),
	durationFrames: z.number().int().min(1).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});
export const TextAnimationPatchSchema = z.strictObject({
	in: TextAnimatorPatchSchema.nullable().optional(),
	out: TextAnimatorPatchSchema.nullable().optional(),
});
export type TextAnimationPatch = z.infer<typeof TextAnimationPatchSchema>;

const vec2 = z.tuple([z.number(), z.number()]);
/** clip.addShape geometry (static values; keyframes through the keyframe commands). */
export const ShapeInputSchema = z.strictObject({
	/** rect / ellipse: the parametric shapes below; vector (wp shapes): `contents` or a `preset`. */
	type: ShapeTypeSchema,
	/** Vector shapes: the items (groups, paths, paints, operators) in the relaxed input form. */
	contents: z.array(ShapeItemInputSchema).max(10000).optional(),
	/** Vector shapes: a shape preset id (SHAPE_PRESETS) instead of contents. */
	preset: z.string().optional(),
	/** Layer pixels; default 400×400. */
	size: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
	/** Default white; `null` = no fill. */
	fill: RGBASchema.nullable().optional(),
	/** Default none. */
	stroke: z
		.strictObject({
			color: RGBASchema,
			width: z.number().min(0),
			position: z.enum(SHAPE_STROKE_POSITIONS).optional(),
		})
		.nullable()
		.optional(),
	cornerRadius: z.number().min(0).optional(),
});
export type ShapeInput = z.infer<typeof ShapeInputSchema>;
/** clip.update `shape` (merged; values static or Animatable like TransformPatch). The type is fixed. */
export const ShapePatchSchema = z.strictObject({
	size: z.union([vec2, AnimVec2Schema]).optional(),
	fill: z.union([RGBASchema, AnimRGBASchema]).nullable().optional(),
	stroke: z
		.strictObject({
			color: z.union([RGBASchema, AnimRGBASchema]).optional(),
			width: z.union([z.number(), AnimNumberSchema]).optional(),
			position: z.enum(SHAPE_STROKE_POSITIONS).optional(),
		})
		.nullable()
		.optional(),
	cornerRadius: z.union([z.number(), AnimNumberSchema]).optional(),
});
export type ShapePatch = z.infer<typeof ShapePatchSchema>;

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
	/**
	 * a sequence source is placed as a nested sequence (`true`, the default: nest-video + nest-audio
	 * clips, Premiere's "Insert and overwrite sequences as nests") or as copies of its clips (`false`, "individual
	 * clips"). Ignored for other sources.
	 */
	nest: z.boolean().optional(),
	ref: RefDeclSchema.optional(),
});
export const ClipAddTextCmd = cmd('clip.addText', {
	...placementTarget,
	content: TextContentInput,
	box: TextBoxSchema.partial().optional(),
	transform: TransformPatch.optional(),
	/** in/out animators. */
	textAnimation: TextAnimationInputSchema.optional(),
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
	/** Default: the composition's length at the sequence rate (S08:MGC-004); longer values are clamped. */
	duration: TimeInputSchema.optional(),
	/** `mediaId` = the mg-bundle asset, `id` = composition id in it; version 1. */
	composition: z.strictObject({
		mediaId: IdRefSchema,
		id: z.string().min(1),
		version: z.number().int().optional(),
	}),
	/** Props over the composition's defaultProps (validated against its propsSchema when known). */
	props: z.record(z.string(), z.unknown()).optional(),
	canvas: canvas.optional(),
});
/** a rectangle or ellipse (default 400×400 at the sequence centre, 5 s). */
export const ClipAddShapeCmd = cmd('clip.addShape', {
	...placementTarget,
	/** Default 5 s. */
	duration: TimeInputSchema.optional(),
	shape: ShapeInputSchema,
	transform: TransformPatch.optional(),
});
export const ClipAddCaptionsCmd = cmd('clip.addCaptions', {
	sequenceId: IdRefSchema.optional(),
	transcriptId: IdRefSchema,
	track: TrackRefSchema,
	alignToClipId: IdRefSchema.optional(),
	range: z.strictObject({ from: TimeInputSchema, to: TimeInputSchema }).optional(),
	style: CaptionStyleSchema.partial().optional(),
	/**
	 * one caption clip per caption block (default), or one clip paging through the blocks (`false`).
	 * Blocks follow `rules` (Create Captions defaults: 42 characters × 2 lines, 1–7 s).
	 */
	split: z.boolean().optional(),
	rules: CaptionRulesSchema.optional(),
	ref: RefDeclSchema.optional(),
});
export const ClipAddAdjustmentCmd = cmd('clip.addAdjustment', {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	duration: TimeInputSchema,
	track: TrackRefSchema,
	/** clip name (default "Adjustment Layer"). */
	name: z.string().min(1).optional(),
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
	/** edit-structure (S01:CLP-012): members of the clips' clip groups move with them (default true). */
	groups: z.boolean().optional(),
});
export const ClipTrimCmd = cmd('clip.trim', {
	clipId: IdRefSchema,
	edge: z.enum(['in', 'out']),
	deltaFrames: z.number().int(),
	mode: z.enum(['regular', 'ripple', 'roll']).optional(),
	/** Trim link partners whose same edge coincides (S01:CLP-010). Default true. */
	linked: z.boolean().optional(),
	/**
	 * edit-structure (Premiere groups): trimming the outer edge of a clip group (the first In / the last Out) trims
	 * every member at that edge (default true); inner edges trim the clip alone.
	 */
	group: z.boolean().optional(),
	/** Ripple only: stop at the largest shift sync-locked tracks allow (gesture behaviour, S02:TL-543). */
	clampToSyncLock: z.boolean().optional(),
	rippleMarkers: z.boolean().optional(),
});
export const ClipSlipCmd = cmd('clip.slip', { clipIds: IdListSchema, deltaFrames: z.number().int() });
export const ClipSlideCmd = cmd('clip.slide', {
	clipId: IdRefSchema,
	deltaFrames: z.number().int(),
	/** linked partners that start with the clip slide too (default true; Alt-drag = false). */
	linked: z.boolean().optional(),
});
export const ClipSplitCmd = cmd('clip.split', {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	clipIds: IdListSchema.optional(),
	tracks: z.array(TrackRefSchema).min(1).optional(),
	scope: z.literal('all-unlocked').optional(),
	/** Split link partners too (default true; Alt = false). */
	linked: z.boolean().optional(),
});
export const ClipLiftCmd = cmd('clip.lift', {
	clipIds: IdListSchema,
	/** edit-structure (S01:CLP-012): grouped clips are deleted together (default true). */
	groups: z.boolean().optional(),
});
export const ClipExtractCmd = cmd('clip.extract', {
	clipIds: IdListSchema,
	/** edit-structure (S01:CLP-012): grouped clips are deleted together (default true). */
	groups: z.boolean().optional(),
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
			paragraphs: TextContentInput.shape.paragraphs,
		})
		.optional(),
	box: TextBoxSchema.partial().optional(),
	/** Motion-graphic params merged over the current params and validated by the template. */
	params: z.record(z.string(), z.unknown()).optional(),
	/**
	 * composition clips — the whole props override object (replaces the current overrides,
	 * validated against the composition's propsSchema; `{}` = reset to defaults).
	 */
	props: z.record(z.string(), z.unknown()).optional(),
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
	/** text clips — `null` removes both sides; see TextAnimationPatchSchema. */
	textAnimation: TextAnimationPatchSchema.nullable().optional(),
	/** shape clips — merged into the current shape. */
	shape: ShapePatchSchema.optional(),
	/** motion-graphic clips — upgrade the template to `version` (params migrated). */
	template: z.strictObject({ version: z.number().int() }).optional(),
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
/**
 * What a source swap does when the new media does not hold every source frame the clip shows (M3,
 * S07:PRC-017): `refuse` (default) fails with E_OUT_OF_MEDIA, `trim` trims the clip (and linked clips sharing
 * the trimmed edge) to the covered frames, `skip` leaves that clip unchanged with a warning.
 */
export const SourceFitSchema = z.enum(['refuse', 'trim', 'skip']);
export type SourceFit = z.infer<typeof SourceFitSchema>;
export const ClipReplaceSourceCmd = cmd('clip.replaceSource', {
	clipId: IdRefSchema,
	mediaId: IdRefSchema,
	keepDuration: z.boolean().optional(),
	/** behaviour when the new media does not cover the clip (default `refuse`). */
	fit: SourceFitSchema.optional(),
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
	/** Name of the new sequence (default "Nested Sequence NN"). */
	name: z.string().min(1).optional(),
	/** Binds the new sequence id. */
	ref: RefDeclSchema.optional(),
});

export const CLIP_COMMANDS = [
	ClipPlaceCmd,
	ClipAddTextCmd,
	ClipAddSolidCmd,
	ClipAddMotionGraphicCmd,
	ClipAddCompositionCmd,
	ClipAddShapeCmd,
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

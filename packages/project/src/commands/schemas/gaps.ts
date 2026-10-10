// Workstream gaps (docs/wp-notes/gaps.md): proxies (PRJ-8) and the other gaps commands added below.
import { z } from 'zod';
import { ALIGN_MODES, GraphicRollSchema, GraphicTemplateSchema, PIN_EDGES } from '../../gaps/graphics.ts';
import { WarpAnalysisDataSchema } from '../../gaps/warp/analysis.ts';
import { AttachedProxySchema } from '../../schema/media.ts';
import { cmd, IdListSchema, IdRefSchema, RefDeclSchema, TimeInputSchema, TrackRefSchema } from './common.ts';

/**
 * Clip ▸ Proxy ▸ Attach Proxies / Create Proxies (when the job finishes): attaches a registered file as the proxy of a
 * video asset, replacing the one attached. Refused (E_INVALID_PARAM) when its duration or frame rate do not match the
 * original's (`force` skips the check, Premiere's "attach anyway").
 */
export const MediaAttachProxyCmd = cmd('media.attachProxy', {
	mediaId: IdRefSchema,
	proxy: AttachedProxySchema.extend({ attachedAt: z.string().optional() }),
	force: z.boolean().optional(),
});
/** Clip ▸ Proxy ▸ Detach Proxies: the media plays its original again (the proxy file is left on disk). */
export const MediaDetachProxyCmd = cmd('media.detachProxy', { mediaIds: IdListSchema });

const ChannelRouting = z.strictObject({
	streamIndex: z.number().int().min(0),
	map: z.array(z.number().int().min(0)).min(1).max(6),
	mute: z.array(z.number().int().min(0)).max(6).optional(),
});

/**
 * Clip ▸ Modify ▸ Audio Channels on timeline clips: `channels[i]` becomes the routing of `clipIds[i]` (audio clips of
 * one media, typically a linked group). Each routing reads one stream with 1, 2 or 6 channels; refused when it does not
 * fit the media.
 */
export const ClipSetAudioChannelsCmd = cmd('clip.setAudioChannels', {
	sequenceId: IdRefSchema.optional(),
	clipIds: z.array(IdRefSchema).min(1).max(32),
	channels: z.array(ChannelRouting).min(1).max(32),
});
/** Modify ▸ Audio Channels on Project items: the audio clips future placements create (null = the default). */
export const ItemSetAudioChannelsCmd = cmd('item.setAudioChannels', {
	itemIds: IdListSchema,
	clips: z.array(ChannelRouting).min(1).max(32).nullable(),
});

/**
 * Effect Controls ▸ Warp Stabilizer ▸ Analyze (when the engine's background analysis finishes): stores the analysis
 * with the effect instance (null clears it, Premiere's re-analysis). Refused for other effects and malformed data.
 */
export const EffectSetWarpAnalysisCmd = cmd('effect.setWarpAnalysis', {
	effectInstanceId: IdRefSchema,
	analysis: WarpAnalysisDataSchema.nullable(),
});

const SubjectPath = z.strictObject({
	clipId: IdRefSchema,
	start: z.number().min(0),
	frameDuration: z.number().positive(),
	/** x, y (0..1 of the media's display), confidence per sample. */
	points: z
		.array(z.number().min(-1).max(2))
		.min(3)
		.max(3 * 54_000),
});

/**
 * Sequence ▸ Auto Reframe Sequence: duplicates `sequenceId` at `width × height` (named "<name> - (num:den)" unless
 * `name`), scales each video clip with a subject path to fill the new frame and keyframes its Position to follow the
 * subject (Motion Tracking `tracking`). Clips whose Position or Scale is already animated keep their Motion (reported).
 */
export const SequenceAutoReframeCmd = cmd('sequence.autoReframe', {
	sequenceId: IdRefSchema,
	width: z.number().int().min(16).max(16384),
	height: z.number().int().min(16).max(16384),
	tracking: z.enum(['slower', 'default', 'faster']).default('default'),
	name: z.string().min(1).max(255).optional(),
	subjects: z.array(SubjectPath).max(5000),
	ref: RefDeclSchema.optional(),
});

const GraphicPatch = z.strictObject({
	intro: z.number().int().min(0).max(1_000_000).optional(),
	outro: z.number().int().min(0).max(1_000_000).optional(),
	roll: GraphicRollSchema.nullable().optional(),
	/** The graphic's duration (frames): layers that reach its end are extended / shortened with it. */
	duration: z.number().int().min(1).max(10_000_000).optional(),
});

/**
 * Essential Graphics: makes `sequenceId` a graphic (its tracks are the layers) or edits its Responsive Design – Time
 * (Intro / Outro frames) and Roll / Crawl; `graphic: null` makes it a plain sequence again.
 */
export const GraphicUpdateCmd = cmd('graphic.update', {
	sequenceId: IdRefSchema,
	graphic: GraphicPatch.nullable(),
});
/** Essential Graphics ▸ New Layer: a text, rectangle or ellipse layer on a new top track, as long as the graphic. */
export const GraphicAddLayerCmd = cmd('graphic.addLayer', {
	sequenceId: IdRefSchema,
	kind: z.enum(['text', 'rectangle', 'ellipse']),
	text: z.string().max(10_000).optional(),
	name: z.string().max(255).optional(),
	ref: RefDeclSchema.optional(),
});
/** Essential Graphics ▸ Align and Transform: align or distribute layers to the video frame or the selection. */
export const GraphicAlignCmd = cmd('graphic.align', {
	sequenceId: IdRefSchema,
	clipIds: z.array(IdRefSchema).min(1).max(200),
	mode: z.enum(ALIGN_MODES),
	relativeTo: z.enum(['frame', 'selection']).default('frame'),
});
/**
 * Essential Graphics ▸ Responsive Design – Position: pins the layer's `edges` to the video frame (`target: "frame"`)
 * or to another layer of the graphic, keeping their current offsets; no edges = unpinned.
 */
export const GraphicSetPinsCmd = cmd('graphic.setPins', {
	sequenceId: IdRefSchema,
	clipId: IdRefSchema,
	target: z.string().min(1),
	edges: z.array(z.enum(PIN_EDGES)).max(4),
});
/** Essential Graphics ▸ Browse: a `.jgt` template placed at `at` on `track` of the sequence (its graphic is added). */
export const GraphicImportTemplateCmd = cmd('graphic.importTemplate', {
	template: GraphicTemplateSchema,
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	track: TrackRefSchema.optional(),
	binId: IdRefSchema.nullable().optional(),
});

export const GAPS_COMMANDS = [
	MediaAttachProxyCmd,
	MediaDetachProxyCmd,
	ClipSetAudioChannelsCmd,
	ItemSetAudioChannelsCmd,
	EffectSetWarpAnalysisCmd,
	SequenceAutoReframeCmd,
	GraphicUpdateCmd,
	GraphicAddLayerCmd,
	GraphicAlignCmd,
	GraphicSetPinsCmd,
	GraphicImportTemplateCmd,
] as const;

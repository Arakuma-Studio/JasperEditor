// Workstream gaps (docs/wp-notes/gaps.md): proxies (PRJ-8) and the other gaps commands added below.
import { z } from 'zod';
import { WarpAnalysisDataSchema } from '../../gaps/warp/analysis.ts';
import { AttachedProxySchema } from '../../schema/media.ts';
import { cmd, IdListSchema, IdRefSchema, RefDeclSchema } from './common.ts';

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
	points: z.array(z.number().min(-1).max(2)).min(3).max(3 * 54_000),
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

export const GAPS_COMMANDS = [
	MediaAttachProxyCmd,
	MediaDetachProxyCmd,
	ClipSetAudioChannelsCmd,
	ItemSetAudioChannelsCmd,
	EffectSetWarpAnalysisCmd,
	SequenceAutoReframeCmd,
] as const;

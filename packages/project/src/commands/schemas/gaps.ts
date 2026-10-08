// Workstream gaps (docs/wp-notes/gaps.md): proxies (PRJ-8) and the other gaps commands added below.
import { z } from 'zod';
import { AttachedProxySchema } from '../../schema/media.ts';
import { cmd, IdListSchema, IdRefSchema } from './common.ts';

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

export const GAPS_COMMANDS = [
	MediaAttachProxyCmd,
	MediaDetachProxyCmd,
	ClipSetAudioChannelsCmd,
	ItemSetAudioChannelsCmd,
] as const;

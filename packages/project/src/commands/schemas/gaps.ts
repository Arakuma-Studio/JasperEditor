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

export const GAPS_COMMANDS = [MediaAttachProxyCmd, MediaDetachProxyCmd] as const;

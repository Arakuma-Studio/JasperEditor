// Workstream gaps command handlers (docs/wp-notes/gaps.md).
import { proxyMismatch } from '../../gaps/proxies.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import { type HandlerMap, idList } from './util.ts';

export const GAPS_OWNER = 'gaps' as const;

function mediaOf(
	doc: { media: Record<string, MediaAsset>; items: Record<string, unknown> },
	id: string,
	h: HandlerContext,
): MediaAsset {
	const direct = doc.media[id];
	if (direct) return direct;
	const it = doc.items[id] as { kind?: string; mediaId?: string } | undefined;
	if (it && (it.kind === 'media' || it.kind === 'subclip') && it.mediaId && doc.media[it.mediaId])
		return doc.media[it.mediaId]!;
	return h.fail('E_NOT_FOUND', `Media not found: ${id}`);
}

export const gapsHandlers: HandlerMap = {
	'media.attachProxy': (doc, cmd: CommandOf<'media.attachProxy'>, h) => {
		const asset = mediaOf(doc as never, cmd.mediaId, h);
		if (asset.kind !== 'video')
			h.fail('E_INVALID_PARAM', `${asset.originalName} is not a video: only video media takes proxies`);
		if (!cmd.force) {
			const why = proxyMismatch(asset, cmd.proxy.probe as never);
			if (why) h.fail('E_INVALID_PARAM', why, { path: ['proxy'] });
		}
		if (cmd.proxy.fingerprint === asset.fingerprint)
			h.fail('E_INVALID_PARAM', 'That file is the original itself, not a proxy', {
				path: ['proxy', 'fingerprint'],
			});
		(asset as MediaAsset).proxy = { ...cmd.proxy, attachedAt: cmd.proxy.attachedAt ?? h.ctx.now() } as never;
		return { mediaId: asset.id };
	},
	'media.detachProxy': (doc, cmd: CommandOf<'media.detachProxy'>, h) => {
		const detached: string[] = [];
		for (const id of idList(cmd.mediaIds)) {
			const asset = mediaOf(doc as never, id, h);
			if (asset.proxy) {
				delete (asset as { proxy?: unknown }).proxy;
				detached.push(asset.id);
			}
		}
		return { detached };
	},
};

// Workstream gaps command handlers (docs/wp-notes/gaps.md).
import { channelsProblem } from '../../gaps/audio-channels.ts';
import { proxyMismatch } from '../../gaps/proxies.ts';
import { WARP_STABILIZER_EFFECT_ID, warpAnalysisProblem } from '../../gaps/warp/analysis.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import { locateEffect } from './param.ts';
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
	'effect.setWarpAnalysis': (doc, cmd: CommandOf<'effect.setWarpAnalysis'>, h) => {
		const loc = locateEffect(doc, cmd.effectInstanceId);
		if (!loc) return h.fail('E_NOT_FOUND', `Effect instance not found: ${cmd.effectInstanceId}`);
		if (loc.fx.effectId !== WARP_STABILIZER_EFFECT_ID)
			h.fail('E_INVALID_PARAM', `${cmd.effectInstanceId} is not a Warp Stabilizer`);
		if (!loc.clip) h.fail('E_INVALID_PARAM', 'The Warp Stabilizer analyses clips only');
		const fx = loc.fx as { warpAnalysis?: unknown };
		if (cmd.analysis === null) {
			delete fx.warpAnalysis;
			return { analysed: false };
		}
		const why = warpAnalysisProblem(cmd.analysis);
		if (why) h.fail('E_INVALID_PARAM', `The analysis is not usable: ${why}`, { path: ['analysis'] });
		fx.warpAnalysis = cmd.analysis;
		return { analysed: true, frames: Math.floor(cmd.analysis.frames.length / 14) };
	},
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
	'clip.setAudioChannels': (doc, cmd: CommandOf<'clip.setAudioChannels'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		if (cmd.channels.length !== cmd.clipIds.length)
			h.fail('E_INVALID_PARAM', 'One routing per clip: clipIds and channels differ in length');
		cmd.clipIds.forEach((ref, i) => {
			const clip = seq.clips[ref];
			if (!clip) h.fail('E_NOT_FOUND', `Clip not found: ${ref}`);
			if (clip.kind !== 'audio') h.fail('E_INVALID_PARAM', `${ref} is not an audio clip of media`);
			const media = doc.media[(clip as { mediaId: string }).mediaId];
			const ch = cmd.channels[i]!;
			const why = channelsProblem(media, ch);
			if (why) h.fail('E_INVALID_PARAM', `Clip ${i + 1}: ${why}`, { path: ['channels', String(i)] });
			const track = [...seq.audioTracks].find((t) => t.id === clip.trackId);
			if (track?.locked) h.fail('E_TRACK_LOCKED', `Track of ${ref} is locked`);
			(clip as { channels: unknown }).channels = {
				streamIndex: ch.streamIndex,
				map: [...ch.map],
				...(ch.mute?.length ? { mute: [...ch.mute] } : {}),
			};
		});
	},
	'item.setAudioChannels': (doc, cmd: CommandOf<'item.setAudioChannels'>, h) => {
		for (const id of idList(cmd.itemIds)) {
			const it = doc.items[id];
			if (!it) h.fail('E_NOT_FOUND', `Item not found: ${id}`);
			if (it.kind !== 'media') h.fail('E_INVALID_PARAM', `${it.name} is not a media item`);
			const r = it as { audioChannels?: unknown; mediaId: string };
			if (cmd.clips === null) {
				delete r.audioChannels;
				continue;
			}
			const media = doc.media[r.mediaId];
			cmd.clips.forEach((ch, i) => {
				const why = channelsProblem(media, ch);
				if (why) h.fail('E_INVALID_PARAM', `Clip ${i + 1}: ${why}`, { path: ['clips', String(i)] });
			});
			r.audioChannels = {
				clips: cmd.clips.map((c) => ({
					streamIndex: c.streamIndex,
					map: [...c.map],
					...(c.mute?.length ? { mute: [...c.mute] } : {}),
				})),
			};
		}
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

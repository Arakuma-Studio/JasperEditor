// Workstream gaps command handlers (docs/wp-notes/gaps.md).
import { channelsProblem } from '../../gaps/audio-channels.ts';
import { proxyMismatch } from '../../gaps/proxies.ts';
import { WARP_STABILIZER_EFFECT_ID, warpAnalysisProblem } from '../../gaps/warp/analysis.ts';
import {
	clipMediaSecondsAt,
	keyframeIndexes,
	reframePosition,
	smoothSubjectPath,
} from '../../gaps/auto-reframe.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import { FLICKS_PER_SECOND } from '../../time.ts';
import type { DDoc } from '../context.ts';
import { keyframeHandlers } from './keyframe.ts';
import { sequenceHandlers } from './sequence.ts';
import { structureHandlers } from './structure.ts';
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

type Run = (doc: DDoc, cmd: unknown, h: HandlerContext) => unknown;
const run = (map: HandlerMap, type: string) => (map as Record<string, unknown>)[type] as Run;

export const gapsHandlers: HandlerMap = {
	'sequence.autoReframe': (doc, cmd: CommandOf<'sequence.autoReframe'>, h) => {
		const src = doc.sequences[cmd.sequenceId] as Sequence | undefined;
		if (!src) return h.fail('E_NOT_FOUND', `Sequence not found: ${cmd.sequenceId}`);
		for (const s of cmd.subjects)
			if (!src.clips[s.clipId]) h.fail('E_NOT_FOUND', `Clip not found in the sequence: ${s.clipId}`);
		const item = Object.values(doc.items).find(
			(i) => i.kind === 'sequence' && (i as { sequenceId: string }).sequenceId === src.id,
		);
		const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
		const k = g(cmd.width, cmd.height);
		const name = cmd.name ?? `${item?.name ?? 'Sequence'} - (${cmd.width / k}:${cmd.height / k})`;
		const dup = run(structureHandlers, 'sequence.duplicate')(
			doc,
			{ type: 'sequence.duplicate', sequenceId: src.id, name, ...(cmd.ref ? { ref: cmd.ref } : {}) },
			h,
		) as { sequenceId: string; itemId: string };
		run(sequenceHandlers, 'sequence.updateSettings')(
			doc,
			{
				type: 'sequence.updateSettings',
				sequenceId: dup.sequenceId,
				settings: { width: cmd.width, height: cmd.height },
				reposition: 'keep-offset-from-center',
			},
			h,
		);
		const seq = doc.sequences[dup.sequenceId] as Sequence;
		const oldIds = Object.keys(src.clips);
		const newIds = Object.keys(seq.clips);
		const map = new Map(oldIds.map((id, i) => [id, newIds[i]!]));
		const frame = { width: cmd.width, height: cmd.height };
		const rate = seq.settings.frameRate;
		const reframed: string[] = [];
		const skipped: { clipId: string; reason: string }[] = [];
		for (const path of cmd.subjects) {
			const id = map.get(path.clipId);
			const clip = id ? (seq.clips[id] as Clip | undefined) : undefined;
			if (!clip || clip.kind !== 'video') {
				skipped.push({ clipId: path.clipId, reason: 'not a video clip' });
				continue;
			}
			const tr = (clip as { transform?: { position: { keyframes: unknown[]; value: [number, number] }; scale: { keyframes: unknown[]; value: number }; scaleWidth: { value: number }; anchor: { keyframes: unknown[]; value: [number, number] } } }).transform;
			if (!tr || tr.position.keyframes.length || tr.scale.keyframes.length || tr.anchor.keyframes.length) {
				skipped.push({ clipId: path.clipId, reason: 'Motion is already animated' });
				continue;
			}
			const box = intrinsicBoxOf({ clip, doc, seq } as never);
			const fill = Math.max(frame.width / box.width, frame.height / box.height) * 100;
			const scale = Math.max(tr.scale.value, fill);
			tr.scale.value = scale;
			tr.scaleWidth.value = scale;
			const smooth = smoothSubjectPath(path.points, path.frameDuration, cmd.tracking);
			const values: [number, number][] = [];
			for (let f = clip.start; f < clip.start + clip.duration; f++) {
				const t = clipMediaSecondsAt(clip as never, f, rate, FLICKS_PER_SECOND);
				const i = Math.max(0, Math.min(smooth.length - 1, Math.round((t - path.start) / path.frameDuration)));
				values.push(reframePosition(smooth[i] ?? [0.5, 0.5], box, frame, scale, tr.anchor.value));
			}
			const keys = keyframeIndexes(values, 1.5, Math.max(2, Math.round((2 * rate.num) / rate.den)));
			const first = values[0]!;
			if (keys.length <= 2 && values.every((v) => Math.hypot(v[0] - first[0], v[1] - first[1]) < 0.5)) {
				tr.position.value = [first[0], first[1]];
			} else
				for (const i of keys)
					run(keyframeHandlers, 'keyframe.add')(
						doc,
						{
							type: 'keyframe.add',
							target: ['clip', clip.id, 'transform', 'position'],
							at: { sequenceFrame: clip.start + i },
							value: values[i],
							sequenceId: seq.id,
						},
						h,
					);
			reframed.push(clip.id);
		}
		return { sequenceId: seq.id, itemId: dup.itemId, reframed, skipped };
	},
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

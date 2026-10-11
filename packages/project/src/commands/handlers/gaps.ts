import { channelsProblem } from '../../gaps/audio-channels.ts';
import {
	clipMediaSecondsAt,
	keyframeIndexes,
	reframePosition,
	smoothSubjectPath,
} from '../../gaps/auto-reframe.ts';
import { alignOffsets, graphicSettingsOf, isGraphic, layerBounds, pinOffsets } from '../../gaps/graphics.ts';
import { proxyMismatch } from '../../gaps/proxies.ts';
import { WARP_STABILIZER_EFFECT_ID, warpAnalysisProblem } from '../../gaps/warp/analysis.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import type { MediaAsset } from '../../schema/media.ts';
import { FLICKS_PER_SECOND } from '../../time.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import { clipCoreHandlers } from './clip-core.ts';
import { insertProjectItems, parseCommandClipboard } from './clipboard.ts';
import { keyframeHandlers } from './keyframe.ts';
import { locateEffect } from './param.ts';
import { sequenceHandlers } from './sequence.ts';
import { shapeHandlers } from './shape.ts';
import { structureHandlers } from './structure.ts';
import { type HandlerMap, idList } from './util.ts';

export const GAPS_OWNER = 'gaps' as const;

function mediaOf(doc: DDoc, id: string, h: HandlerContext): MediaAsset {
	const direct = doc.media[id];
	if (direct) return direct;
	const it = doc.items[id];
	if (it && (it.kind === 'media' || it.kind === 'subclip') && doc.media[it.mediaId])
		return doc.media[it.mediaId]!;
	return h.fail('E_NOT_FOUND', `Media not found: ${id}`);
}

export const gapsHandlers = {
	'graphic.update': (doc, cmd: CommandOf<'graphic.update'>, h) => {
		const seq = doc.sequences[cmd.sequenceId];
		if (!seq) return h.fail('E_NOT_FOUND', `Sequence not found: ${cmd.sequenceId}`);
		if (cmd.graphic === null) {
			delete seq.graphic;
			return { graphic: null };
		}
		const cur = graphicSettingsOf(seq) ?? { intro: 0, outro: 0, roll: null };
		const next = {
			intro: cmd.graphic.intro ?? cur.intro,
			outro: cmd.graphic.outro ?? cur.outro,
			roll: cmd.graphic.roll === undefined ? (cur.roll ?? null) : cmd.graphic.roll,
		};
		seq.graphic = next;
		if (cmd.graphic.duration !== undefined) {
			const end = Math.max(0, ...Object.values(seq.clips).map((c) => c.start + c.duration));
			for (const c of Object.values(seq.clips)) {
				if (c.start + c.duration !== end) continue;
				if (c.start >= cmd.graphic.duration)
					h.fail('E_INVALID_PARAM', `Layer ${c.id} starts after the new end`);
				c.duration = cmd.graphic.duration - c.start;
			}
		}
		return { graphic: next };
	},
	'graphic.addLayer': (doc, cmd: CommandOf<'graphic.addLayer'>, h) => {
		const seq = doc.sequences[cmd.sequenceId];
		if (!seq || !isGraphic(seq)) return h.fail('E_INVALID_PARAM', `${cmd.sequenceId} is not a graphic`);
		const end = Math.max(0, ...Object.values(seq.clips).map((c) => c.start + c.duration));
		const rate = seq.settings.frameRate;
		const duration = end > 0 ? end : Math.round((5 * rate.num) / rate.den);
		sequenceHandlers['track.add'](doc, { type: 'track.add', sequenceId: seq.id, kind: 'video' }, h);
		const track = seq.videoTracks[seq.videoTracks.length - 1]!.id;
		const base = {
			sequenceId: seq.id,
			at: { frames: 0 },
			duration: { frames: duration },
			track,
			...(cmd.name ? { name: cmd.name } : {}),
			...(cmd.ref ? { ref: cmd.ref } : {}),
		};
		const r =
			cmd.kind === 'text'
				? clipCoreHandlers['clip.addText'](
						doc,
						{ type: 'clip.addText', ...base, content: { text: cmd.text ?? 'New Text' } },
						h,
					)
				: shapeHandlers['clip.addShape'](
						doc,
						{
							type: 'clip.addShape',
							...base,
							shape: { type: cmd.kind === 'rectangle' ? 'rect' : 'ellipse', size: [400, 240] },
						},
						h,
					);
		return r;
	},
	'graphic.align': (doc, cmd: CommandOf<'graphic.align'>, h) => {
		const seq = doc.sequences[cmd.sequenceId];
		if (!seq) return h.fail('E_NOT_FOUND', `Sequence not found: ${cmd.sequenceId}`);
		const clips = cmd.clipIds.map((id) => {
			const c = seq.clips[id];
			if (!c) h.fail('E_NOT_FOUND', `Clip not found: ${id}`);
			const track = seq.videoTracks.find((t) => t.id === c.trackId);
			if (track?.locked) h.fail('E_TRACK_LOCKED', `Track of ${id} is locked`);
			return c;
		});
		const rects = clips.map((c) => {
			const r = layerBounds(c, intrinsicBoxOf({ clip: c, doc, seq }), c.sourceIn);
			if (!r) h.fail('E_INVALID_PARAM', `${c.id} has no Motion to align`);
			return r!;
		});
		const to =
			cmd.relativeTo === 'frame'
				? { x: 0, y: 0, width: seq.settings.width, height: seq.settings.height }
				: null;
		const offs = alignOffsets(rects, cmd.mode, to);
		clips.forEach((c, i) => {
			const [dx, dy] = offs[i]!;
			if (!dx && !dy) return;
			if (!('transform' in c)) h.fail('E_INVALID_PARAM', `${c.id} has no Motion to align`);
			const pos = c.transform.position;
			pos.value = [pos.value[0] + dx, pos.value[1] + dy];
			for (const k of pos.keyframes) k.value = [k.value[0] + dx, k.value[1] + dy];
		});
		return { moved: offs.filter(([x, y]) => x || y).length };
	},
	'graphic.setPins': (doc, cmd: CommandOf<'graphic.setPins'>, h) => {
		const seq = doc.sequences[cmd.sequenceId];
		if (!seq || !isGraphic(seq)) return h.fail('E_INVALID_PARAM', `${cmd.sequenceId} is not a graphic`);
		const c = seq.clips[cmd.clipId];
		if (!c) return h.fail('E_NOT_FOUND', `Clip not found: ${cmd.clipId}`);
		if (!cmd.edges.length) {
			delete c.pins;
			return { pinned: false };
		}
		if (cmd.target === cmd.clipId) h.fail('E_INVALID_PARAM', 'A layer cannot be pinned to itself');
		const tc = cmd.target === 'frame' ? null : seq.clips[cmd.target];
		if (cmd.target !== 'frame' && !tc) h.fail('E_NOT_FOUND', `Layer not found: ${cmd.target}`);
		if (tc && tc.pins?.target === cmd.clipId)
			h.fail('E_INVALID_PARAM', 'Two layers cannot be pinned to each other');
		const own = layerBounds(c, intrinsicBoxOf({ clip: c, doc, seq }), c.sourceIn);
		const target = tc
			? layerBounds(tc, intrinsicBoxOf({ clip: tc, doc, seq }), tc.sourceIn)
			: { x: 0, y: 0, width: seq.settings.width, height: seq.settings.height };
		if (!own || !target) return h.fail('E_INVALID_PARAM', 'Both layers need Motion to be pinned');
		const pins = { target: cmd.target, edges: pinOffsets(own, target, cmd.edges) };
		c.pins = pins;
		return { pinned: true, pins };
	},
	'graphic.importTemplate': (doc, cmd: CommandOf<'graphic.importTemplate'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const payload = parseCommandClipboard(cmd.template.payload, h, ['project-items']);
		const pasted = insertProjectItems(doc, payload, cmd.binId, undefined, h);
		const itemId = pasted.itemIds.find((id) => {
			const it = doc.items[id];
			return it?.kind === 'sequence' && isGraphic(doc.sequences[it.sequenceId]!);
		});
		if (!itemId) return h.fail('E_INVALID_PARAM', 'The template holds no graphic');
		const placed = clipCoreHandlers['clip.place'](
			doc,
			{
				type: 'clip.place',
				sequenceId: seq.id,
				source: { projectItemId: itemId },
				at: cmd.at,
				...(cmd.track ? { tracks: { video: cmd.track } } : {}),
				video: true,
				audio: false,
				matchSequence: 'keep',
			},
			h,
		);
		return { itemId, placed };
	},
	'sequence.autoReframe': (doc, cmd: CommandOf<'sequence.autoReframe'>, h) => {
		const src = doc.sequences[cmd.sequenceId];
		if (!src) return h.fail('E_NOT_FOUND', `Sequence not found: ${cmd.sequenceId}`);
		for (const s of cmd.subjects)
			if (!src.clips[s.clipId]) h.fail('E_NOT_FOUND', `Clip not found in the sequence: ${s.clipId}`);
		const item = Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === src.id);
		const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
		const k = g(cmd.width, cmd.height);
		const name = cmd.name ?? `${item?.name ?? 'Sequence'} - (${cmd.width / k}:${cmd.height / k})`;
		const dup = structureHandlers['sequence.duplicate'](
			doc,
			{ type: 'sequence.duplicate', sequenceId: src.id, name, ...(cmd.ref ? { ref: cmd.ref } : {}) },
			h,
		);
		sequenceHandlers['sequence.updateSettings'](
			doc,
			{
				type: 'sequence.updateSettings',
				sequenceId: dup.sequenceId,
				settings: { width: cmd.width, height: cmd.height },
				reposition: 'keep-offset-from-center',
			},
			h,
		);
		const seq = doc.sequences[dup.sequenceId];
		const oldIds = Object.keys(src.clips);
		const newIds = Object.keys(seq.clips);
		const map = new Map(oldIds.map((id, i) => [id, newIds[i]!]));
		const frame = { width: cmd.width, height: cmd.height };
		const rate = seq.settings.frameRate;
		const reframed: string[] = [];
		const skipped: { clipId: string; reason: string }[] = [];
		for (const path of cmd.subjects) {
			const id = map.get(path.clipId);
			const clip = id ? seq.clips[id] : undefined;
			if (clip?.kind !== 'video') {
				skipped.push({ clipId: path.clipId, reason: 'not a video clip' });
				continue;
			}
			const tr = clip.transform;
			if (!tr || tr.position.keyframes.length || tr.scale.keyframes.length || tr.anchor.keyframes.length) {
				skipped.push({ clipId: path.clipId, reason: 'Motion is already animated' });
				continue;
			}
			const box = intrinsicBoxOf({ clip, doc, seq });
			const fill = Math.max(frame.width / box.width, frame.height / box.height) * 100;
			const scale = Math.max(tr.scale.value, fill);
			tr.scale.value = scale;
			tr.scaleWidth.value = scale;
			const smooth = smoothSubjectPath(path.points, path.frameDuration, cmd.tracking);
			const values: [number, number][] = [];
			for (let f = clip.start; f < clip.start + clip.duration; f++) {
				const t = clipMediaSecondsAt(clip, f, rate, FLICKS_PER_SECOND);
				const i = Math.max(0, Math.min(smooth.length - 1, Math.round((t - path.start) / path.frameDuration)));
				values.push(reframePosition(smooth[i] ?? [0.5, 0.5], box, frame, scale, tr.anchor.value));
			}
			const keys = keyframeIndexes(values, 1.5, Math.max(2, Math.round((2 * rate.num) / rate.den)));
			const first = values[0]!;
			if (keys.length <= 2 && values.every((v) => Math.hypot(v[0] - first[0], v[1] - first[1]) < 0.5)) {
				tr.position.value = [first[0], first[1]];
			} else
				for (const i of keys)
					keyframeHandlers['keyframe.add'](
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
		const fx = loc.fx;
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
		const asset = mediaOf(doc, cmd.mediaId, h);
		if (asset.kind !== 'video')
			h.fail('E_INVALID_PARAM', `${asset.originalName} is not a video: only video media takes proxies`);
		if (!cmd.force) {
			const why = proxyMismatch(asset, cmd.proxy.probe);
			if (why) h.fail('E_INVALID_PARAM', why, { path: ['proxy'] });
		}
		if (cmd.proxy.fingerprint === asset.fingerprint)
			h.fail('E_INVALID_PARAM', 'That file is the original itself, not a proxy', {
				path: ['proxy', 'fingerprint'],
			});
		asset.proxy = { ...cmd.proxy, attachedAt: cmd.proxy.attachedAt ?? h.ctx.now() };
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
			const media = doc.media[clip.mediaId];
			const ch = cmd.channels[i]!;
			const why = channelsProblem(media, ch);
			if (why) h.fail('E_INVALID_PARAM', `Clip ${i + 1}: ${why}`, { path: ['channels', String(i)] });
			const track = [...seq.audioTracks].find((t) => t.id === clip.trackId);
			if (track?.locked) h.fail('E_TRACK_LOCKED', `Track of ${ref} is locked`);
			clip.channels = {
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
			const r = it;
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
			const asset = mediaOf(doc, id, h);
			if (asset.proxy) {
				delete asset.proxy;
				detached.push(asset.id);
			}
		}
		return { detached };
	},
} satisfies HandlerMap;

// sequence.*, marker.*, track.* (S01 §7, §8, SEQ-006/007/008).

import type { Draft } from 'immer';
import { anim, createSequence, createTrack } from '../../factories.ts';
import { mediaDurationFlicks } from '../../interpret/model.ts';
import { fixMulticamSelections, pruneMulticamAngles } from '../../multicam/model.ts';
import { kindCapabilities } from '../../registry/kinds.ts';
import type { Animatable, Vec2 } from '../../schema/common.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { ClipMarker, Marker, Sequence, SequenceSettings, Track } from '../../schema/sequence.ts';
import {
	isAllowedSequenceRate,
	mapFrameBetweenRates,
	nearestAllowedRate,
	type Rational,
	supportsDropFrame,
} from '../../time.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import {
	assertUnlocked,
	cleanupSequence,
	end,
	findTrackIn,
	removeClip,
	resolveTrackIn,
	tracksOfKind,
} from '../placement.ts';
import { placeSource } from './clip-core.ts';
import { assertBin, insertItem } from './project.ts';
import { remapTextAnimationFrames } from './text-animation.ts';
import type { HandlerMap } from './util.ts';

function validateSettings(s: SequenceSettings, h: HandlerContext): void {
	if (!isAllowedSequenceRate(s.frameRate))
		h.fail('E_INVALID_PARAM', `Frame rate ${s.frameRate.num}/${s.frameRate.den} is not allowed`);
	for (const [k, v] of [
		['width', s.width],
		['height', s.height],
	] as const) {
		if (!Number.isInteger(v) || v % 2 !== 0 || v < 16 || v > 8192)
			h.fail('E_INVALID_PARAM', `${k} must be an even integer 16..8192`);
	}
	if (s.dropFrame && !supportsDropFrame(s.frameRate)) s.dropFrame = false;
}

function videoInfo(asset: MediaAsset) {
	const vs = asset.probe.streams.find((s) => s.type === 'video');
	if (vs?.type !== 'video') return null;
	const swap = asset.probe.rotationDegrees === 90 || asset.probe.rotationDegrees === 270;
	const w = swap ? vs.height : vs.width;
	const hgt = swap ? vs.width : vs.height;
	const even = (n: number) => Math.max(16, Math.min(8192, n - (n % 2)));
	return { width: even(w), height: even(hgt), rate: nearestAllowedRate(vs.frameRate) };
}

function mapAnimVec(a: Draft<Animatable<Vec2>>, f: (v: Vec2) => Vec2) {
	a.value = f(a.value as Vec2);
	for (const k of a.keyframes) k.value = f(k.value as Vec2);
}
function mapAnimNum(a: Draft<Animatable<number>>, f: (v: number) => number) {
	a.value = f(a.value);
	for (const k of a.keyframes) k.value = f(k.value);
}

function changeFrameRate(seq: DSeq, to: Rational, h: HandlerContext): void {
	const from = seq.settings.frameRate as Rational;
	const map = (f: number) => mapFrameBetweenRates(f, from, to);
	for (const c of Object.values(seq.clips)) {
		const s = map(c.start);
		const e = map(end(c));
		if (e - s <= 0) {
			removeClip(seq, c.id, h);
			h.warn('W_CLIP_COLLAPSED', `Clip ${c.id} collapsed to 0 frames and was removed`);
		} else {
			c.start = s;
			c.duration = e - s;
			// M2 (S11:TXA-005): animator windows keep their length in time.
			remapTextAnimationFrames(c, from, to);
		}
	}
	for (const m of seq.markers) {
		const s = map(m.frame);
		m.duration = Math.max(0, map(m.frame + m.duration) - s);
		m.frame = s;
	}
	if (seq.inPoint !== null) seq.inPoint = map(seq.inPoint);
	if (seq.outPoint !== null) seq.outPoint = map(seq.outPoint);
	if (seq.workArea) seq.workArea = { start: map(seq.workArea.start), end: map(seq.workArea.end) };
	for (const t of Object.values(seq.transitions)) t.duration = Math.max(1, map(t.duration));
	seq.settings.frameRate = { num: to.num, den: to.den };
	if (!supportsDropFrame(to)) seq.settings.dropFrame = false;
	cleanupSequence(seq, h);
}

function isFrameSizedGenerator(c: { kind: string; canvas?: unknown }): boolean {
	return (
		c.kind === 'solid' || c.kind === 'adjustment' || (c.kind === 'motion-graphic' && c.canvas === 'sequence')
	);
}

function changeFrameSize(
	seq: DSeq,
	w2: number,
	h2: number,
	mode: 'keep-offset-from-center' | 'scale-proportionally' | 'keep-pixels',
): void {
	const w1 = seq.settings.width;
	const h1 = seq.settings.height;
	seq.settings.width = w2;
	seq.settings.height = h2;
	if (mode === 'keep-pixels') return;
	const dx = (w2 - w1) / 2;
	const dy = (h2 - h1) / 2;
	const s = Math.min(w2 / w1, h2 / h1);
	for (const c of Object.values(seq.clips)) {
		const tr = (c as { transform?: Draft<Record<string, unknown>> }).transform as
			| {
					position: Draft<Animatable<Vec2>>;
					anchor: Draft<Animatable<Vec2>>;
					scale: Draft<Animatable<number>>;
					scaleWidth: Draft<Animatable<number>>;
			  }
			| undefined;
		if (!tr || !kindCapabilities(c.kind)?.hasTransform) continue;
		if (isFrameSizedGenerator(c as { kind: string; canvas?: unknown })) {
			mapAnimVec(tr.position, ([x, y]) => [x + dx, y + dy]);
			mapAnimVec(tr.anchor, ([x, y]) => [x + dx, y + dy]);
		} else if (mode === 'keep-offset-from-center') {
			mapAnimVec(tr.position, ([x, y]) => [x + dx, y + dy]);
		} else {
			mapAnimVec(tr.position, ([x, y]) => [w2 / 2 + (x - w1 / 2) * s, h2 / 2 + (y - h1 / 2) * s]);
			mapAnimNum(tr.scale, (v) => v * s);
			mapAnimNum(tr.scaleWidth, (v) => v * s);
		}
	}
}

function findMarker(doc: DDoc, markerId: string, h: HandlerContext) {
	for (const seq of Object.values(doc.sequences)) {
		const i = seq.markers.findIndex((m) => m.id === markerId);
		if (i >= 0) return { seq, marker: seq.markers[i]! as Draft<Marker>, clip: null };
		for (const c of Object.values(seq.clips)) {
			const j = c.markers.findIndex((m) => m.id === markerId);
			if (j >= 0) return { seq, marker: c.markers[j]! as Draft<ClipMarker>, clip: c };
		}
	}
	return h.fail('E_NOT_FOUND', `Marker not found: ${markerId}`);
}

/** wp-multicam: a source clip marker of a media item. */
function findItemMarker(doc: DDoc, markerId: string) {
	for (const it of Object.values(doc.items)) {
		if (it.kind !== 'media') continue;
		const list = (it as { markers?: Draft<ClipMarker>[] }).markers;
		const marker = list?.find((m) => m.id === markerId);
		if (list && marker) return { item: it, list, marker };
	}
	return null;
}

export const sequenceHandlers: HandlerMap = {
	'sequence.create': (doc, cmd, h: HandlerContext) => {
		assertBin(doc, cmd.binId, h);
		const presetId = cmd.preset ?? doc.settings.defaultSequencePreset;
		const preset = h.registries.presets.get(presetId);
		if (!preset && !cmd.fromMediaId && !cmd.settings)
			h.fail('E_INVALID_PARAM', `Unknown preset: ${presetId}`);
		const base = preset ?? h.registries.presets.list()[0]!;
		const settings: SequenceSettings = JSON.parse(JSON.stringify(base.settings));
		let asset: MediaAsset | undefined;
		if (cmd.fromMediaId) {
			asset = doc.media[cmd.fromMediaId] as MediaAsset | undefined;
			if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${cmd.fromMediaId}`);
			const info = videoInfo(asset);
			if (info) {
				settings.width = info.width;
				settings.height = info.height;
				settings.frameRate = info.rate;
				settings.dropFrame = supportsDropFrame(info.rate);
			}
		}
		Object.assign(settings, cmd.settings ?? {});
		if (cmd.settings?.frameRate && cmd.settings.dropFrame === undefined)
			settings.dropFrame = supportsDropFrame(settings.frameRate);
		validateSettings(settings, h);
		const id = h.newId(doc, 'seq', cmd.id);
		const seq = createSequence(h.ids, settings, cmd.tracks ?? base.tracks, id);
		doc.sequences[id] = seq;
		const itemId = h.ids.next('itm');
		doc.items[itemId] = { id: itemId, kind: 'sequence', name: cmd.name, sequenceId: id, label: 'forest' };
		insertItem(doc, itemId, cmd.binId);
		h.defineRef(cmd.ref, id);
		let clipIds: string[] = [];
		if (asset) {
			clipIds = placeSource(doc, doc.sequences[id]!, h, {
				source: { mediaId: asset.id },
				at: 0,
				mode: 'overwrite',
				videoTrack: 'V1',
				audioTracks: undefined,
			}).clipIds;
		}
		return { sequenceId: id, itemId, clipIds };
	},
	'sequence.updateSettings': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const p = cmd.settings;
		const next: SequenceSettings = {
			...(JSON.parse(JSON.stringify(seq.settings)) as SequenceSettings),
			...p,
		};
		validateSettings(next, h);
		if (
			p.frameRate &&
			p.frameRate.num * seq.settings.frameRate.den !== seq.settings.frameRate.num * p.frameRate.den
		) {
			changeFrameRate(seq, next.frameRate, h);
		}
		if (
			(p.width !== undefined && p.width !== seq.settings.width) ||
			(p.height !== undefined && p.height !== seq.settings.height)
		) {
			changeFrameSize(seq, next.width, next.height, cmd.reposition ?? 'keep-offset-from-center');
		}
		if (p.dropFrame !== undefined)
			seq.settings.dropFrame = p.dropFrame && supportsDropFrame(seq.settings.frameRate as Rational);
		else if (p.frameRate) seq.settings.dropFrame = next.dropFrame;
		if (p.startTimecodeFrames !== undefined) seq.settings.startTimecodeFrames = p.startTimecodeFrames;
		if (p.backgroundColor) seq.settings.backgroundColor = [...p.backgroundColor];
		if (p.audioSampleRate !== undefined) seq.settings.audioSampleRate = p.audioSampleRate;
		if (p.masterLayout !== undefined) seq.settings.masterLayout = p.masterLayout;
	},
	'sequence.setInOut': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const i = cmd.in === null ? null : h.frame(seq, cmd.in);
		const o = cmd.out === null ? null : h.frame(seq, cmd.out);
		if ((i !== null && i < 0) || (o !== null && o < 0)) h.fail('E_INVALID_PARAM', 'In/Out must be >= 0');
		if (i !== null && o !== null && o <= i) h.fail('E_INVALID_PARAM', 'Out must be after In');
		seq.inPoint = i;
		seq.outPoint = o;
	},
	'sequence.setWorkArea': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		if (cmd.start === null || cmd.end === null) {
			if (cmd.start !== cmd.end) h.fail('E_INVALID_PARAM', 'Work area needs both start and end, or neither');
			seq.workArea = null;
			return;
		}
		const s = h.frame(seq, cmd.start);
		const e = h.frame(seq, cmd.end);
		if (s < 0 || e <= s) h.fail('E_INVALID_PARAM', 'Work area end must be after start');
		seq.workArea = { start: s, end: e };
	},
	'marker.add': (doc, cmd, h: HandlerContext) => {
		const id = h.newId(doc, 'mrk', cmd.id);
		const base = {
			id,
			name: cmd.name ?? '',
			comment: cmd.comment ?? '',
			color: cmd.color ?? 'green',
			type: cmd.markerType ?? 'comment',
			...(cmd.url !== undefined ? { url: cmd.url } : {}),
			author: h.agentAuthor(),
		} as const;
		if (cmd.itemId) {
			// wp-multicam: source clip markers live on the media item (media time).
			const it = doc.items[cmd.itemId];
			if (!it) h.fail('E_NOT_FOUND', `Project item not found: ${cmd.itemId}`);
			if (it.kind !== 'media') h.fail('E_INVALID_PARAM', 'Source clip markers go on media items');
			const asset = doc.media[it.mediaId] as MediaAsset | undefined;
			const fallback = { num: 30, den: 1 };
			const flicks = cmd.flicks ? h.flicks(cmd.flicks, asset, fallback) : (it.marks.in?.flicks ?? 0);
			if (flicks < 0) h.fail('E_INVALID_PARAM', 'Marker time must be >= 0');
			const dur = asset ? mediaDurationFlicks(asset) : undefined;
			if (dur !== null && dur !== undefined && flicks > dur)
				h.fail('E_OUT_OF_MEDIA', 'Marker is after the end of the media');
			const list = ((it as { markers?: ClipMarker[] }).markers ??= []) as Draft<ClipMarker>[];
			list.push({ ...base, flicks, duration: 0 });
			list.sort((a, b) => a.flicks - b.flicks);
		} else if (cmd.clipId) {
			const { seq, clip } = h.clip(doc, cmd.clipId);
			assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
			let flicks: number;
			if (cmd.flicks)
				flicks = h.flicks(
					cmd.flicks,
					doc.media[(clip as { mediaId?: string }).mediaId ?? ''] as MediaAsset,
					seq.settings.frameRate,
				);
			else if (cmd.frame !== undefined)
				flicks = h.clipContentTime(seq, clip, { sequenceFrame: h.frame(seq, cmd.frame) });
			else flicks = clip.sourceIn;
			const duration = cmd.duration !== undefined ? h.durationFrames(seq, cmd.duration) : 0;
			clip.markers.push({ ...base, flicks, duration });
			clip.markers.sort((a, b) => a.flicks - b.flicks);
		} else {
			const seq = h.sequence(doc, cmd.sequenceId);
			if (cmd.frame === undefined)
				h.fail('E_INVALID_PARAM', 'marker.add needs frame (sequence marker) or clipId');
			const frame = h.frame(seq, cmd.frame);
			if (frame < 0) h.fail('E_INVALID_PARAM', 'Marker frame must be >= 0');
			const duration = cmd.duration !== undefined ? h.durationFrames(seq, cmd.duration) : 0;
			seq.markers.push({ ...base, frame, duration });
			seq.markers.sort((a, b) => a.frame - b.frame);
		}
		h.defineRef(cmd.ref, id);
		return { markerId: id };
	},
	'marker.update': (doc, cmd, h: HandlerContext) => {
		const im = findItemMarker(doc, cmd.markerId);
		if (im) {
			const m = im.marker;
			if (cmd.name !== undefined) m.name = cmd.name;
			if (cmd.comment !== undefined) m.comment = cmd.comment;
			if (cmd.color !== undefined) m.color = cmd.color;
			if (cmd.markerType !== undefined) m.type = cmd.markerType;
			if (cmd.url !== undefined) m.url = cmd.url;
			if (cmd.flicks) {
				const asset = doc.media[im.item.mediaId] as MediaAsset | undefined;
				m.flicks = h.flicks(cmd.flicks, asset, { num: 30, den: 1 });
			}
			im.list.sort((a, b) => a.flicks - b.flicks);
			return;
		}
		const found = findMarker(doc, cmd.markerId, h);
		const m = found.marker as Draft<Marker & ClipMarker>;
		if (found.clip) assertUnlocked(findTrackIn(found.seq, found.clip.trackId)!.track, h);
		if (cmd.name !== undefined) m.name = cmd.name;
		if (cmd.comment !== undefined) m.comment = cmd.comment;
		if (cmd.color !== undefined) m.color = cmd.color;
		if (cmd.markerType !== undefined) m.type = cmd.markerType;
		if (cmd.url !== undefined) m.url = cmd.url;
		if (cmd.duration !== undefined) m.duration = h.durationFrames(found.seq, cmd.duration);
		if (found.clip) {
			if (cmd.flicks) m.flicks = h.flicks(cmd.flicks, null, found.seq.settings.frameRate);
			found.clip.markers.sort((a, b) => a.flicks - b.flicks);
		} else {
			if (cmd.frame !== undefined) m.frame = h.frame(found.seq, cmd.frame);
			if (m.frame < 0) h.fail('E_INVALID_PARAM', 'Marker frame must be >= 0');
			found.seq.markers.sort((a, b) => a.frame - b.frame);
		}
	},
	'marker.remove': (doc, cmd, h: HandlerContext) => {
		for (const id of cmd.markerIds) {
			const im = findItemMarker(doc, id);
			if (im) {
				im.list.splice(im.list.indexOf(im.marker), 1);
				continue;
			}
			const found = findMarker(doc, id, h);
			if (found.clip) {
				assertUnlocked(findTrackIn(found.seq, found.clip.trackId)!.track, h);
				found.clip.markers = found.clip.markers.filter((m) => m.id !== id);
			} else found.seq.markers = found.seq.markers.filter((m) => m.id !== id);
		}
	},
	'track.add': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const list = tracksOfKind(seq, cmd.kind);
		const index = Math.min(cmd.index ?? list.length, list.length);
		const created: Track[] = [];
		if ((cmd.language !== undefined || cmd.captionStandard !== undefined) && cmd.kind !== 'caption')
			h.fail('E_INVALID_PARAM', 'language and captionStandard apply to caption tracks only');
		for (let i = 0; i < (cmd.count ?? 1); i++) {
			const t = createTrack(h.ids, cmd.kind, cmd.name ?? null);
			// wp captions
			if (cmd.language !== undefined) t.language = cmd.language;
			if (cmd.captionStandard !== undefined) t.captionStandard = cmd.captionStandard;
			created.push(t);
		}
		list.splice(index, 0, ...(created as Draft<Track>[]));
		h.defineRef(cmd.ref, created[0]!.id);
		return { trackIds: created.map((t) => t.id) };
	},
	'track.remove': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const ids = cmd.trackIds.map((r) => {
			const id = resolveTrackIn(seq, r);
			if (!id) h.fail('E_NOT_FOUND', `Track not found: ${r}`);
			return id;
		});
		const clips = Object.values(seq.clips).filter((c) => ids.includes(c.trackId));
		if (clips.length > 0) {
			if (!cmd.force)
				h.fail('E_IN_USE', `The tracks contain ${clips.length} clips`, { blocking: clips.map((c) => c.id) });
			for (const id of ids) {
				const t = findTrackIn(seq, id)!.track;
				if (t.locked && clips.some((c) => c.trackId === id)) assertUnlocked(t, h);
			}
			for (const c of clips) removeClip(seq, c.id, h);
		}
		for (const t of Object.values(seq.transitions)) if (ids.includes(t.trackId)) delete seq.transitions[t.id];
		seq.videoTracks = seq.videoTracks.filter((t) => !ids.includes(t.id));
		seq.audioTracks = seq.audioTracks.filter((t) => !ids.includes(t.id));
		seq.captionTracks = seq.captionTracks.filter((t) => !ids.includes(t.id));
		if (seq.videoTracks.length === 0 || seq.audioTracks.length === 0) {
			h.fail('E_INVALID_PARAM', 'A sequence needs at least one video and one audio track');
		}
		// wp-multicam: angles of a multi-camera source lose the removed tracks; clips of a removed angle fall back.
		if ((seq as Sequence).multicam) {
			pruneMulticamAngles(seq as Sequence);
			fixMulticamSelections(doc as ProjectDocument);
		}
		cleanupSequence(seq, h);
	},
	'track.update': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const track = h.track(seq, cmd.trackId);
		const p = cmd.patch;
		const only = (kind: Track['kind'], field: string) => {
			if (track.kind !== kind) h.fail('E_INVALID_PARAM', `${field} applies to ${kind} tracks only`);
		};
		if (p.name !== undefined) track.name = p.name;
		if (p.locked !== undefined) track.locked = p.locked;
		if (p.syncLock !== undefined) track.syncLock = p.syncLock;
		if (p.output !== undefined) {
			only('video', 'output');
			track.output = p.output;
		}
		if (p.mute !== undefined) {
			only('audio', 'mute');
			track.mute = p.mute;
		}
		if (p.solo !== undefined) {
			only('audio', 'solo');
			track.solo = p.solo;
		}
		for (const key of ['volumeDb', 'pan'] as const) {
			const v = p[key];
			if (v === undefined) continue;
			only('audio', key);
			const range = key === 'volumeDb' ? [-96, 15] : [-100, 100];
			const val = typeof v === 'number' ? anim(v) : (v as Animatable<number>);
			const bad = [val.value, ...val.keyframes.map((k) => k.value)].some(
				(x) => x < range[0]! || x > range[1]!,
			);
			if (bad) h.fail('E_INVALID_PARAM', `${key} must be within ${range[0]}..${range[1]}`);
			track[key] = val;
		}
		if (p.channelFormat !== undefined) {
			only('audio', 'channelFormat');
			track.channelFormat = p.channelFormat;
		}
		if (p.visible !== undefined) {
			only('caption', 'visible');
			track.visible = p.visible;
		}
		if (p.styleDefaults !== undefined) {
			only('caption', 'styleDefaults');
			if (!doc.fonts[p.styleDefaults.fontId])
				h.fail('E_NOT_FOUND', `Font not found: ${p.styleDefaults.fontId}`);
			track.styleDefaults = p.styleDefaults;
		}
		// wp captions
		if (p.language !== undefined) {
			only('caption', 'language');
			track.language = p.language;
		}
		if (p.captionStandard !== undefined) {
			only('caption', 'captionStandard');
			track.captionStandard = p.captionStandard;
		}
	},
};

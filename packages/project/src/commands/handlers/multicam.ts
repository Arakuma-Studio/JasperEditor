// Placing a multi-camera source sequence (clip.place with its sequence) makes multi-camera clips; placing a merged
// clip edits the clips it holds (see placeSequenceSource).
import type { Draft } from 'immer';
import { createSequence } from '../../factories.ts';
import {
	angleById,
	firstVideoAngle,
	isMulticamClip,
	type MulticamClip,
	multicamSourceOf,
	resolveAngle,
	shownAngles,
} from '../../multicam/model.ts';
import { pieceAudioClip, pieceVideoClip, resolveMulticamClip } from '../../multicam/resolve.ts';
import {
	clipSyncSource,
	commonPlacements,
	itemSyncSource,
	SyncError,
	type SyncSource,
	type SyncSpec,
	synchronizeReference,
	synchronizeUnits,
	syncOffsets,
} from '../../multicam/sync.ts';
import { contentDurationFlicks, isBoundedContent } from '../../registry/kinds.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type {
	Clip,
	MulticamAngle,
	MulticamSource,
	Sequence,
	SequenceSettings,
	SyncMethod,
	Transition,
} from '../../schema/sequence.ts';
import {
	FRAME_EPS,
	flicksPerFrame,
	nearestAllowedRate,
	type Rational,
	supportsDropFrame,
} from '../../time.ts';
import type { DClip, DDoc, DSeq, DTrack, HandlerContext } from '../context.ts';
import {
	assertUnlocked,
	cleanupSequence,
	clearRange,
	end,
	ensureTrackAt,
	findTrackIn,
	reidentifyClipChildren,
	relinkSplits,
	removeClip,
	resolveTrackIn,
	type SplitRecord,
	splitClipAt,
	trackClips,
} from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { placeSource } from './clip-core.ts';
import { assertBin, insertItem } from './project-items.ts';
import { type HandlerMap, idList, clone as plain } from './util.ts';

function syncSpec(cmd: {
	method: SyncMethod;
	ignoreHours?: boolean;
	marker?: string;
	audioOffsets?: Record<string, number>;
}): SyncSpec {
	return {
		method: cmd.method,
		...(cmd.ignoreHours !== undefined ? { ignoreHours: cmd.ignoreHours } : {}),
		...(cmd.marker !== undefined ? { marker: cmd.marker } : {}),
		...(cmd.audioOffsets ? { audioOffsets: cmd.audioOffsets } : {}),
	};
}

function offsetsOrFail(sources: SyncSource[], ref: number, spec: SyncSpec, h: HandlerContext): number[] {
	try {
		return syncOffsets(sources, ref, spec);
	} catch (e) {
		if (e instanceof SyncError) return h.fail('E_INVALID_PARAM', e.message);
		throw e;
	}
}

/** Timeline flicks at which a clip shows content time `t` (continuous; reverse-aware). */
function timelineFlicksOf(c: Clip, t: number, F: number): number {
	const r = c.speed.rate;
	if (c.speed.reverse) return (c.start + c.duration - 1) * F - (t - c.sourceIn) / r;
	return c.start * F + (t - c.sourceIn) / r;
}

function synchronize(doc: DDoc, cmd: CommandOf<'clip.synchronize'>, h: HandlerContext) {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const F = flicksPerFrame(seq.settings.frameRate);
	// Units: a clip with its linked partners moves as one (the selection's links, plus partners not selected).
	let plainUnits: ReturnType<typeof synchronizeUnits>;
	try {
		plainUnits = synchronizeUnits(
			seq as Sequence,
			clips.map((c) => c.id),
			cmd.method,
		);
	} catch (e) {
		if (e instanceof SyncError) return h.fail('E_INVALID_PARAM', e.message);
		throw e;
	}
	const units = plainUnits.map((u) => ({
		members: u.memberIds.map((m) => seq.clips[m]!),
		rep: seq.clips[u.repId]!,
	}));
	if (units.length < 2)
		h.fail('E_INVALID_PARAM', 'Select clips from at least two different sources to synchronize');
	for (const u of units) for (const m of u.members) assertUnlocked(findTrackIn(seq, m.trackId)!.track, h);
	let referenceTrackId: string | undefined;
	if (cmd.referenceTrack) {
		const tid = resolveTrackIn(seq, cmd.referenceTrack);
		if (!tid) h.fail('E_NOT_FOUND', `Track not found: ${cmd.referenceTrack}`);
		referenceTrackId = tid;
	}
	const ref = synchronizeReference(seq as Sequence, plainUnits, {
		...(cmd.referenceClipId ? { referenceClipId: cmd.referenceClipId } : {}),
		...(referenceTrackId ? { referenceTrackId } : {}),
	});
	if (ref < 0)
		h.fail(
			'E_INVALID_PARAM',
			cmd.referenceClipId
				? '`referenceClipId` is not among the clips to synchronize'
				: `No clip to synchronize on ${cmd.referenceTrack}`,
		);
	const sources = units.map((u) => clipSyncSource(doc as never, seq as Sequence, u.rep as Clip));
	const offsets = offsetsOrFail(sources, ref, syncSpec(cmd), h);
	// The reference's content time t0 sits at timeline τ_ref; unit u's content t0 + offset_u must sit there too.
	const refRep = units[ref]!.rep as Clip;
	const t0 = refRep.sourceIn;
	const tauRef = timelineFlicksOf(refRep, t0, F);
	const extra = (cmd.offsetFrames ?? 0) * F;
	const exactStart = units.map((u, i) => {
		const rep = u.rep as Clip;
		const delta = i === ref ? 0 : tauRef - timelineFlicksOf(rep, t0 + offsets[i]!, F) + extra;
		return rep.start * F + delta;
	});
	// Frame-align each unit (sub-frame remainder into the source In), then keep everything at or after frame 0.
	const plan = units.map((u, i) => {
		const rep = u.rep as Clip;
		const exact = exactStart[i]!;
		const start = i === ref ? rep.start : Math.ceil(exact / F - 1e-9);
		const frac = i === ref ? 0 : start * F - exact;
		return { u, shift: start - rep.start, frac };
	});
	const minStart = Math.min(...plan.flatMap((p) => p.u.members.map((m) => m.start + p.shift)));
	if (minStart < 0) for (const p of plan) p.shift -= minStart;
	const moving = new Set(units.flatMap((u) => u.members.map((m) => m.id)));
	const moved: string[] = [];
	const report: { clipId: string; offsetFlicks: number; deltaFrames: number }[] = [];
	plan.forEach((p, i) => {
		report.push({ clipId: (p.u.rep as Clip).id, offsetFlicks: offsets[i]!, deltaFrames: p.shift });
		if (p.shift === 0 && p.frac === 0) return;
		for (const m of p.u.members) {
			const s = m.start + p.shift;
			relinkSplits(seq, clearRange(seq, m.trackId, s, s + m.duration, h, moving), h);
		}
		for (const m of p.u.members) {
			m.start += p.shift;
			if (p.frac > 0) {
				const d = Math.round(p.frac * m.speed.rate);
				m.sourceIn = Math.max(0, m.speed.reverse ? m.sourceIn - d : m.sourceIn + d);
				if (isBoundedContent(m as Clip)) {
					const dur = contentDurationFlicks(doc, m as Clip);
					const span = m.duration * F * m.speed.rate;
					if (dur !== null && m.sourceIn + span > dur + F * m.speed.rate * FRAME_EPS && m.duration > 1)
						m.duration -= 1;
				}
			}
			moved.push(m.id);
		}
	});
	cleanupSequence(seq, h);
	return { moved, referenceClipId: (units[ref]!.rep as Clip).id, clips: report };
}

type ItemSource = NonNullable<ReturnType<typeof itemSyncSource>> & {
	asset: MediaAsset;
	hasVideo: boolean;
	hasAudio: boolean;
};

function itemSources(
	doc: DDoc,
	ids: readonly string[],
	fallbackRate: Rational,
	h: HandlerContext,
): ItemSource[] {
	const out: ItemSource[] = [];
	for (const id of ids) {
		if (out.some((s) => s.key === id)) continue;
		const s = itemSyncSource(doc as never, id, fallbackRate);
		if (!s) {
			if (!doc.items[id]) h.fail('E_NOT_FOUND', `Project item not found: ${id}`);
			h.fail('E_INVALID_PARAM', `Item ${id} is not a video or audio clip`);
		}
		const asset = doc.media[s.mediaId] as MediaAsset;
		out.push({
			...s,
			asset,
			hasVideo: asset.kind === 'video' && asset.probe.streams.some((x) => x.type === 'video'),
			hasAudio: asset.probe.streams.some((x) => x.type === 'audio'),
		});
	}
	return out;
}

/** Bin that holds an item (null = root). */
function parentBinOf(doc: DDoc, itemId: string): string | null {
	for (const it of Object.values(doc.items))
		if (it.kind === 'bin' && it.children.includes(itemId)) return it.id;
	return null;
}

function settingsFromMedia(asset: MediaAsset | undefined, base: SequenceSettings): SequenceSettings {
	const settings = plain(base);
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	if (vs && vs.type === 'video') {
		const swap = asset!.probe.rotationDegrees === 90 || asset!.probe.rotationDegrees === 270;
		const even = (n: number) => Math.max(16, Math.min(8192, n - (n % 2)));
		settings.width = even(swap ? vs.height : vs.width);
		settings.height = even(swap ? vs.width : vs.height);
		settings.frameRate = nearestAllowedRate(vs.frameRate);
		settings.dropFrame = supportsDropFrame(settings.frameRate);
	}
	return settings;
}

function presetSettings(
	doc: DDoc,
	h: HandlerContext,
	presetId: string | undefined,
	ref: MediaAsset | undefined,
) {
	const fallback =
		h.registries.presets.get(doc.settings.defaultSequencePreset) ?? h.registries.presets.list()[0]!;
	if (presetId && presetId !== 'automatic') {
		const p = h.registries.presets.get(presetId);
		if (!p) h.fail('E_INVALID_PARAM', `Unknown sequence preset: ${presetId}`);
		return plain(p.settings);
	}
	return settingsFromMedia(ref, fallback.settings);
}

/** Places `src` (whole media from the placement's source In) on the given tracks of `seq`. */
function placeItem(
	doc: DDoc,
	seq: DSeq,
	h: HandlerContext,
	src: ItemSource,
	at: { start: number; sourceIn: number; frames: number },
	tracks: { video?: string; audio?: string },
): string[] {
	const F = flicksPerFrame(seq.settings.frameRate);
	return placeSource(doc, seq, h, {
		source: { mediaId: src.mediaId },
		sourceRange: { in: at.sourceIn, out: at.sourceIn + at.frames * F },
		at: at.start,
		mode: 'overwrite',
		...(tracks.video ? { videoTrack: tracks.video } : {}),
		...(tracks.audio ? { audioTracks: [tracks.audio] } : {}),
		video: !!tracks.video,
		audio: !!tracks.audio,
		createTracks: true,
	}).clipIds;
}

function linkAll(seq: DSeq, ids: readonly string[], h: HandlerContext): void {
	const alive = ids.filter((id) => seq.clips[id]);
	for (const id of alive) {
		const c = seq.clips[id]!;
		if (c.linkId && seq.links[c.linkId]) delete seq.links[c.linkId];
		c.linkId = null;
	}
	if (alive.length < 2) return;
	const linkId = h.ids.next('lnk');
	seq.links[linkId] = { id: linkId, members: [...alive] };
	for (const id of alive) seq.clips[id]!.linkId = linkId;
}

function newSequenceItem(
	doc: DDoc,
	h: HandlerContext,
	name: string,
	settings: SequenceSettings,
	tracks: { video: number; audio: number },
	binId: string | null,
): { seq: DSeq; itemId: string } {
	const seq = createSequence(h.ids, settings, tracks);
	doc.sequences[seq.id] = seq as DSeq;
	const itemId = h.ids.next('itm');
	doc.items[itemId] = { id: itemId, kind: 'sequence', name, sequenceId: seq.id, label: 'forest' };
	insertItem(doc, itemId, binId);
	return { seq: doc.sequences[seq.id]!, itemId };
}

function mergeClips(doc: DDoc, cmd: CommandOf<'item.mergeClips'>, h: HandlerContext) {
	assertBin(doc, cmd.binId, h);
	const fallback = (
		h.registries.presets.get(doc.settings.defaultSequencePreset) ?? h.registries.presets.list()[0]!
	).settings;
	const all = itemSources(doc, cmd.itemIds, fallback.frameRate, h);
	const videos = all.filter((s) => s.hasVideo);
	if (videos.length > 1) h.fail('E_INVALID_PARAM', 'Merge Clips takes one video clip plus audio clips');
	const audios = all.filter((s) => !s.hasVideo);
	if (audios.length === 0)
		h.fail('E_INVALID_PARAM', 'Merge Clips needs at least one audio clip besides the video');
	if (audios.length > 16) h.fail('E_LIMIT', 'Merge Clips takes at most 16 audio clips');
	for (const a of audios) if (!a.hasAudio) h.fail('E_INVALID_PARAM', `${a.name} has no audio`);
	const ordered = [...videos, ...audios];
	const settings = settingsFromMedia(videos[0]?.asset, fallback);
	const F = flicksPerFrame(settings.frameRate);
	const offsets = offsetsOrFail(ordered, 0, syncSpec(cmd), h);
	const extra = ordered.map((_, i) => (i === 0 ? 0 : (cmd.offsetFrames ?? 0) * F));
	const placements = commonPlacements(
		ordered.map((s) => ({ start: 0, end: s.duration })),
		offsets,
		settings.frameRate,
		extra,
	);
	const video = videos[0] ?? null;
	const videoAudio = !!video && video.hasAudio && !cmd.removeVideoAudio;
	const nAudio = audios.length + (videoAudio ? 1 : 0);
	const name = cmd.name ?? `${ordered[0]!.name} - Merged`;
	const binId = cmd.binId !== undefined ? cmd.binId : parentBinOf(doc, ordered[0]!.key);
	const { seq, itemId } = newSequenceItem(
		doc,
		h,
		name,
		settings,
		{ video: 1, audio: Math.max(1, nAudio) },
		binId,
	);
	const ids: string[] = [];
	let a = 1;
	if (video) {
		ids.push(
			...placeItem(doc, seq, h, video, placements[0]!, {
				video: 'V1',
				...(videoAudio ? { audio: `A${a++}` } : {}),
			}),
		);
	}
	ordered.forEach((s, i) => {
		if (s === video) return;
		ids.push(...placeItem(doc, seq, h, s, placements[i]!, { audio: `A${a++}` }));
	});
	linkAll(seq, ids, h);
	(seq as Draft<Sequence>).merged = {
		videoItemId: video?.key ?? null,
		audioItemIds: audios.map((s) => s.key),
		sync: cmd.method,
		removeVideoAudio: !!cmd.removeVideoAudio,
	};
	doc.items[itemId]!.label = 'iris';
	cleanupSequence(seq, h);
	h.defineRef(cmd.ref, itemId);
	return {
		itemId,
		sequenceId: seq.id,
		clips: ordered.map((s, i) => ({
			itemId: s.key,
			offsetFlicks: offsets[i]!,
			startFrame: placements[i]!.start,
			sourceIn: placements[i]!.sourceIn,
		})),
	};
}

function processedBin(doc: DDoc, h: HandlerContext): string {
	for (const id of doc.rootItems) {
		const it = doc.items[id];
		if (it?.kind === 'bin' && it.name === 'Processed Clips') return it.id;
	}
	const id = h.ids.next('bin');
	doc.items[id] = { id, kind: 'bin', name: 'Processed Clips', children: [], label: 'violet' };
	doc.rootItems.push(id);
	return id;
}

function detach(doc: DDoc, itemId: string): void {
	const ri = doc.rootItems.indexOf(itemId);
	if (ri >= 0) doc.rootItems.splice(ri, 1);
	for (const it of Object.values(doc.items)) {
		if (it.kind !== 'bin') continue;
		const i = it.children.indexOf(itemId);
		if (i >= 0) it.children.splice(i, 1);
	}
}

function createMulticam(doc: DDoc, cmd: CommandOf<'multicam.create'>, h: HandlerContext) {
	assertBin(doc, cmd.binId, h);
	const fallback = (
		h.registries.presets.get(doc.settings.defaultSequencePreset) ?? h.registries.presets.list()[0]!
	).settings;
	let all = itemSources(doc, cmd.itemIds, fallback.frameRate, h);
	if (!all.some((s) => s.hasVideo))
		h.fail('E_INVALID_PARAM', 'Select at least one clip with video (a camera)');
	// Camera order.
	const order = cmd.order ?? 'selection';
	if (Array.isArray(order)) {
		const pos = (k: string) => {
			const i = order.indexOf(k);
			return i < 0 ? order.length + all.findIndex((s) => s.key === k) : i;
		};
		all = [...all].sort((x, y) => pos(x.key) - pos(y.key));
	} else if (order === 'name') {
		all = [...all].sort((x, y) =>
			x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }),
		);
	} else if (order === 'timecode') {
		const tc = (s: ItemSource) => s.timecode?.flicks ?? Number.POSITIVE_INFINITY;
		all = [...all].sort((x, y) => tc(x) - tc(y));
	}
	// cameras (with video) first, audio-only sources after
	all = [...all.filter((s) => s.hasVideo), ...all.filter((s) => !s.hasVideo)];
	let ref = 0;
	if (cmd.referenceItemId) {
		ref = all.findIndex((s) => s.key === cmd.referenceItemId);
		if (ref < 0) h.fail('E_INVALID_PARAM', '`referenceItemId` is not among the items');
	}
	const settings = presetSettings(
		doc,
		h,
		cmd.preset,
		all[ref]!.asset.kind === 'video' ? all[ref]!.asset : all[0]!.asset,
	);
	const F = flicksPerFrame(settings.frameRate);
	const offsets = offsetsOrFail(all, ref, syncSpec(cmd), h);
	const extra = all.map((_, i) => (i === ref ? 0 : (cmd.offsetFrames ?? 0) * F));
	const placements = commonPlacements(
		all.map((s) => ({ start: 0, end: s.duration })),
		offsets,
		settings.frameRate,
		extra,
	);
	const cameras = all.filter((s) => s.hasVideo);
	const names = all.map((s, i) => {
		if (cmd.names?.[i]) return cmd.names[i]!;
		if (cmd.cameraNames === 'clip') return s.name;
		return s.hasVideo ? `Camera ${cameras.indexOf(s) + 1}` : `Audio ${i - cameras.length + 1}`;
	});
	const nAudio = all.filter((s) => s.hasAudio).length;
	const name = cmd.name ?? `${all[ref]!.name} Multicam`;
	const binId = cmd.binId !== undefined ? cmd.binId : parentBinOf(doc, all[ref]!.key);
	const { seq, itemId } = newSequenceItem(
		doc,
		h,
		name,
		settings,
		{ video: Math.max(1, cameras.length), audio: Math.max(1, nAudio) },
		binId,
	);
	const angles: MulticamAngle[] = [];
	let vi = 0;
	let ai = 0;
	all.forEach((s, i) => {
		const vTrack = s.hasVideo ? seq.videoTracks[vi++]! : null;
		const aTrack = s.hasAudio ? seq.audioTracks[ai++]! : null;
		const ids = placeItem(doc, seq, h, s, placements[i]!, {
			...(vTrack ? { video: vTrack.id } : {}),
			...(aTrack ? { audio: aTrack.id } : {}),
		});
		if (vTrack) vTrack.name = names[i]!;
		if (aTrack) aTrack.name = names[i]!;
		for (const id of ids) seq.clips[id]!.name = s.name;
		angles.push({
			id: (vTrack ?? aTrack)!.id,
			name: names[i]!,
			videoTrackId: vTrack?.id ?? null,
			audioTrackIds: aTrack ? [aTrack.id] : [],
			enabled: true,
			itemId: s.key,
		});
	});
	(seq as Draft<Sequence>).multicam = { angles, audio: cmd.audio ?? 'camera1', sync: cmd.method };
	if (cmd.moveToProcessedBin) {
		const bin = processedBin(doc, h);
		for (const s of all) {
			detach(doc, s.key);
			insertItem(doc, s.key, bin);
		}
	}
	cleanupSequence(seq, h);
	h.defineRef(cmd.ref, seq.id);
	return {
		sequenceId: seq.id,
		itemId,
		angles: angles.map((a, i) => ({
			angle: a.id,
			name: a.name,
			itemId: a.itemId,
			video: a.videoTrackId !== null,
			offsetFlicks: offsets[i]!,
			startFrame: placements[i]!.start,
		})),
	};
}

function sourceOfClip(doc: DDoc, c: Clip, h: HandlerContext): { src: DSeq; mc: MulticamSource } {
	const id = (c as { sequenceId?: string }).sequenceId;
	const src = id ? doc.sequences[id] : undefined;
	const mc = src ? multicamSourceOf(src as Sequence) : null;
	if (!src || !mc) return h.fail('E_INVALID_PARAM', `Clip ${c.id} is not a multi-camera clip`);
	return { src, mc };
}

function angleFor(doc: DDoc, c: Clip, ref: string | number, h: HandlerContext): MulticamAngle {
	const { mc } = sourceOfClip(doc, c, h);
	const a = resolveAngle(mc, ref);
	if (!a) {
		const shown = shownAngles(mc).length;
		return h.fail(
			'E_NOT_FOUND',
			typeof ref === 'number'
				? `There is no camera ${ref} (${shown} shown)`
				: `No angle “${ref}” in this multi-camera source`,
		);
	}
	if (c.kind === 'nest-video' && a.videoTrackId === null)
		h.fail('E_INVALID_PARAM', `Angle “${a.name}” has no video`);
	return a;
}

/** The multi-camera video track to edit at a frame: `track`, else the first (lowest, or topmost with topDown)
 * video track with an enabled multi-camera clip there. */
function multicamTrackAt(
	seq: DSeq,
	frame: number,
	h: HandlerContext,
	opts: { track?: string; topDown?: boolean },
): DTrack {
	if (opts.track) return h.track(seq, opts.track);
	const order = opts.topDown ? [...seq.videoTracks].reverse() : seq.videoTracks;
	for (const t of order) {
		const c = trackClips(seq, t.id).find((x) => x.start <= frame && frame < end(x));
		if (c && isMulticamClip(c as Clip) && (c as MulticamClip).multicam.enabled && !t.locked) return t;
	}
	return h.fail('E_NOT_FOUND', `No multi-camera clip at frame ${frame}`);
}

/** Linked multi-camera audio clips of a multi-camera video clip. */
function audioPartners(seq: DSeq, c: Clip): DClip[] {
	if (!c.linkId || !seq.links[c.linkId]) return [];
	return seq.links[c.linkId]!.members.map((m) => seq.clips[m]!).filter(
		(m) => m && m.id !== c.id && m.kind === 'nest-audio' && isMulticamClip(m as Clip),
	);
}

function setAngle(doc: DDoc, c: DClip, ref: string | number, h: HandlerContext): boolean {
	const mcClip = c as Draft<MulticamClip>;
	if (!isMulticamClip(c as Clip)) return false;
	const a = angleFor(doc, c as Clip, ref, h);
	if (mcClip.multicam.angle === a.id) return false;
	mcClip.multicam.angle = a.id;
	return true;
}

/** Deep-equal ignoring ids (keyframe/effect/marker ids differ between the halves of a split). */
function sameIgnoringIds(a: unknown, b: unknown): boolean {
	const strip = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(strip);
		if (!v || typeof v !== 'object') return v;
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'id') o[k] = strip(x);
		return o;
	};
	return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

const RANGE_KEYS = new Set(['id', 'start', 'duration', 'sourceIn', 'linkId', 'groupId', 'markers', 'name']);
function sameExceptRange(a: Clip, b: Clip): boolean {
	const pick = (c: Clip) => {
		const o: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(c)) if (!RANGE_KEYS.has(k)) o[k] = v;
		return o;
	};
	return sameIgnoringIds(pick(a), pick(b));
}

/**
 * Heal through edits between pieces of one multi-camera clip that show the same angle, for edit points inside
 * `[from, to]` on `trackIds` (a recording pass that presses the angle already shown adds no edit).
 */
function healTracks(
	seq: DSeq,
	trackIds: Iterable<string>,
	from: number,
	to: number,
	h: HandlerContext,
): void {
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	for (const tid of trackIds) {
		const list = trackClips(seq, tid);
		for (let i = 0; i + 1 < list.length; i++) {
			const a = list[i]!;
			const b = list[i + 1]!;
			if (end(a) !== b.start || b.start < from || b.start > to) continue;
			if (!isMulticamClip(a as Clip) || !isMulticamClip(b as Clip)) continue;
			if (a.speed.reverse || b.speed.reverse) continue;
			const tol = (F * a.speed.rate) / 2;
			if (Math.abs(a.sourceIn + a.duration * F * a.speed.rate - b.sourceIn) > tol) continue;
			if (!sameExceptRange(a as Clip, b as Clip)) continue;
			// transitions between the two pieces go; transitions out of b now leave a
			for (const t of Object.values(seq.transitions)) {
				if (t.outgoingClipId === a.id && t.incomingClipId === b.id) delete seq.transitions[t.id];
				else if (t.outgoingClipId === b.id) t.outgoingClipId = a.id;
			}
			a.duration += b.duration;
			a.markers.push(...b.markers);
			removeClip(seq, b.id, h);
			list.splice(i + 1, 1);
			i--;
		}
	}
}

/** Split `clips` at `frame` (where they straddle it); returns the split records. */
function splitAll(seq: DSeq, clips: DClip[], frame: number, h: HandlerContext): SplitRecord[] {
	const splits: SplitRecord[] = [];
	for (const c of clips) {
		if (!(c.start < frame && frame < end(c))) continue;
		splits.push({ originalLinkId: c.linkId, rightId: splitClipAt(seq, c, frame, h).id });
	}
	return splits;
}

/** End of the run of contiguous multi-camera clips (one source) on a track that contains `frame`. */
function runEnd(seq: DSeq, trackId: string, frame: number): number {
	const list = trackClips(seq, trackId);
	const i = list.findIndex((c) => c.start <= frame && frame < end(c));
	if (i < 0) return frame;
	const src = (list[i] as { sequenceId?: string }).sequenceId;
	let e = end(list[i]!);
	for (let k = i + 1; k < list.length; k++) {
		const c = list[k]!;
		if (c.start !== e || !isMulticamClip(c as Clip) || (c as { sequenceId?: string }).sequenceId !== src)
			break;
		e = end(c);
	}
	return e;
}

/**
 * Apply cuts to the multi-camera clips on `trackId` (and their linked audio when `audio`): split at every cut and
 * at `to`, then from each cut until the next (the last until `to`) show its angle; heal same-angle through edits.
 */
function recordPass(
	doc: DDoc,
	seq: DSeq,
	h: HandlerContext,
	trackId: string,
	cuts: { at: number; angle: string | number }[],
	to: number,
	opts: { video: boolean; audio: boolean },
): { editPoints: number; changed: string[] } {
	const sorted = [...cuts].sort((a, b) => a.at - b.at);
	const dedup: typeof sorted = [];
	for (const c of sorted) {
		if (c.at >= to) continue;
		if (dedup.length && dedup[dedup.length - 1]!.at === c.at) dedup[dedup.length - 1] = c;
		else dedup.push(c);
	}
	if (dedup.length === 0) return { editPoints: 0, changed: [] };
	const from = dedup[0]!.at;
	const videos = () =>
		trackClips(seq, trackId).filter((c) => isMulticamClip(c as Clip) && c.start < to && end(c) > from);
	const initial = videos();
	if (initial.length === 0) h.fail('E_NOT_FOUND', 'No multi-camera clip in the recorded range');
	assertUnlocked(findTrackIn(seq, trackId)!.track, h);
	const audioTracks = new Set<string>();
	if (opts.audio)
		for (const v of initial)
			for (const p of audioPartners(seq, v as Clip)) {
				const t = findTrackIn(seq, p.trackId)!.track;
				if (!t.locked) audioTracks.add(p.trackId);
			}
	const tracks = [...(opts.video ? [trackId] : []), ...audioTracks];
	const inRange = () =>
		tracks.flatMap((t) =>
			trackClips(seq, t).filter((c) => isMulticamClip(c as Clip) && c.start < to && end(c) > from),
		);
	for (const t of [...dedup.map((c) => c.at), to]) {
		const splits = splitAll(seq, inRange(), t, h);
		relinkSplits(seq, splits, h);
	}
	const changed: string[] = [];
	dedup.forEach((c, k) => {
		const until = dedup[k + 1]?.at ?? to;
		for (const p of inRange()) {
			if (p.start >= c.at && end(p) <= until && setAngle(doc, p, c.angle, h)) changed.push(p.id);
		}
	});
	healTracks(seq, tracks, from, to, h);
	cleanupSequence(seq, h);
	// edit points the pass leaves in [from, to] (the cut at `from` and the return at `to` included)
	const editPoints = trackClips(seq, opts.video ? trackId : (tracks[0] ?? trackId)).filter(
		(c) => c.start >= from && c.start <= to && isMulticamClip(c as Clip),
	).length;
	return { editPoints, changed };
}

function switchAngle(doc: DDoc, cmd: CommandOf<'multicam.switchAngle'>, h: HandlerContext) {
	const video = cmd.video !== false;
	const audio = cmd.audio !== false;
	if (cmd.clipIds !== undefined) {
		const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
		const targets = new Map<string, DClip>();
		for (const c of clips) {
			if (!isMulticamClip(c as Clip)) h.fail('E_INVALID_PARAM', `Clip ${c.id} is not a multi-camera clip`);
			if (c.kind === 'nest-video') {
				if (video) targets.set(c.id, c);
				if (audio) for (const p of audioPartners(seq, c as Clip)) targets.set(p.id, p);
			} else if (audio || !video) targets.set(c.id, c);
		}
		if (cmd.range) {
			const from = h.frame(seq, cmd.range.from);
			const to = h.frame(seq, cmd.range.to);
			if (to <= from) h.fail('E_INVALID_PARAM', 'range.to must be after range.from');
			const tracks = new Set([...targets.values()].map((c) => c.trackId));
			for (const t of tracks) assertUnlocked(findTrackIn(seq, t)!.track, h);
			const ids = new Set(targets.keys());
			for (const t of [from, to]) {
				const live = [...ids].map((id) => seq.clips[id]).filter((c): c is DClip => !!c);
				const splits = splitAll(seq, live, t, h);
				for (const sp of splits) ids.add(sp.rightId);
				relinkSplits(seq, splits, h);
			}
			const changed: string[] = [];
			for (const id of ids) {
				const c = seq.clips[id];
				if (c && c.start >= from && end(c) <= to && setAngle(doc, c, cmd.angle, h)) changed.push(id);
			}
			healTracks(seq, tracks, from, to, h);
			cleanupSequence(seq, h);
			return { changed };
		}
		const changed: string[] = [];
		for (const c of targets.values()) {
			assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
			if (setAngle(doc, c, cmd.angle, h)) changed.push(c.id);
		}
		return { changed };
	}
	const seq = h.sequence(doc, cmd.sequenceId);
	if (cmd.range) {
		const from = h.frame(seq, cmd.range.from);
		const to = h.frame(seq, cmd.range.to);
		if (to <= from) h.fail('E_INVALID_PARAM', 'range.to must be after range.from');
		const track = multicamTrackAt(seq, from, h, cmd);
		const r = recordPass(doc, seq, h, track.id, [{ at: from, angle: cmd.angle }], to, { video, audio });
		return { changed: r.changed, editPoints: r.editPoints };
	}
	if (cmd.at === undefined) h.fail('E_INVALID_PARAM', 'multicam.switchAngle needs clipIds, at or range');
	const at = h.frame(seq, cmd.at);
	const track = multicamTrackAt(seq, at, h, cmd);
	assertUnlocked(track, h);
	const clip = trackClips(seq, track.id).find((c) => c.start <= at && at < end(c))!;
	const changed: string[] = [];
	if (video && setAngle(doc, clip, cmd.angle, h)) changed.push(clip.id);
	if (audio)
		for (const p of audioPartners(seq, clip as Clip)) {
			if (findTrackIn(seq, p.trackId)!.track.locked) continue;
			if (setAngle(doc, p, cmd.angle, h)) changed.push(p.id);
		}
	return { changed, clipId: clip.id };
}

function record(doc: DDoc, cmd: CommandOf<'multicam.record'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const cuts = cmd.cuts.map((c) => ({ at: h.frame(seq, c.at), angle: c.angle }));
	const first = Math.min(...cuts.map((c) => c.at));
	const track = multicamTrackAt(seq, first, h, cmd);
	const to = cmd.to !== undefined ? h.frame(seq, cmd.to) : runEnd(seq, track.id, first);
	if (to <= first) h.fail('E_INVALID_PARAM', '`to` must be after the first cut');
	return recordPass(doc, seq, h, track.id, cuts, to, {
		video: cmd.video !== false,
		audio: cmd.audio !== false,
	});
}

function setEnabled(doc: DDoc, cmd: CommandOf<'multicam.setEnabled'>, h: HandlerContext) {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const targets = new Map<string, DClip>();
	for (const c of clips) {
		if (c.kind !== 'nest-video' && c.kind !== 'nest-audio') continue;
		targets.set(c.id, c);
		for (const m of c.linkId && seq.links[c.linkId] ? seq.links[c.linkId]!.members : []) {
			const p = seq.clips[m];
			if (p && (p.kind === 'nest-video' || p.kind === 'nest-audio')) targets.set(p.id, p);
		}
	}
	if (targets.size === 0) h.fail('E_INVALID_PARAM', 'Select nested sequence or multi-camera clips');
	const changed: string[] = [];
	for (const c of targets.values()) {
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		const src = doc.sequences[(c as { sequenceId: string }).sequenceId];
		if (!src) h.fail('E_NOT_FOUND', `Clip ${c.id} references a missing sequence`);
		let mc = multicamSourceOf(src as Sequence);
		if (!mc && cmd.enabled) {
			// A plain nest becomes a multi-camera source: one angle per video track (audio tracks paired by index).
			const angles: MulticamAngle[] = src.videoTracks.map((t, i) => ({
				id: t.id,
				name: t.name ?? `Camera ${i + 1}`,
				videoTrackId: t.id,
				audioTrackIds: src.audioTracks[i] ? [src.audioTracks[i]!.id] : [],
				enabled: true,
				itemId: null,
			}));
			for (let i = src.videoTracks.length; i < src.audioTracks.length; i++)
				angles.push({
					id: src.audioTracks[i]!.id,
					name: src.audioTracks[i]!.name ?? `Audio ${i + 1}`,
					videoTrackId: null,
					audioTrackIds: [src.audioTracks[i]!.id],
					enabled: true,
					itemId: null,
				});
			(src as Draft<Sequence>).multicam = { angles, audio: 'all' };
			mc = multicamSourceOf(src as Sequence);
		}
		if (!mc) continue;
		const sel = (c as Draft<{ multicam?: { enabled: boolean; angle: string } }>).multicam;
		if (!sel) {
			if (!cmd.enabled) continue;
			(c as Draft<{ multicam?: { enabled: boolean; angle: string } }>).multicam = {
				enabled: true,
				angle: (firstVideoAngle(mc) ?? mc.angles[0])?.id ?? '',
			};
			changed.push(c.id);
		} else if (sel.enabled !== cmd.enabled) {
			sel.enabled = cmd.enabled;
			if (!angleById(mc, sel.angle)) sel.angle = (firstVideoAngle(mc) ?? mc.angles[0])?.id ?? sel.angle;
			changed.push(c.id);
		}
	}
	return { changed, enabled: cmd.enabled };
}

function flatten(doc: DDoc, cmd: CommandOf<'multicam.flatten'>, h: HandlerContext) {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const targets = new Map<string, DClip>();
	for (const c of clips) {
		const all = [
			c,
			...(c.linkId && seq.links[c.linkId] ? seq.links[c.linkId]!.members.map((m) => seq.clips[m]!) : []),
		];
		for (const m of all) if (m && isMulticamClip(m as Clip)) targets.set(m.id, m);
	}
	const enabled = [...targets.values()].filter((c) => (c as Draft<MulticamClip>).multicam.enabled);
	if (enabled.length === 0) h.fail('E_INVALID_PARAM', 'Select enabled multi-camera clips to flatten');
	for (const c of targets.values())
		if (!(c as Draft<MulticamClip>).multicam.enabled)
			h.warn('W_CLIP_SKIPPED', `Clip ${c.id} has Multi-Camera disabled; it stays a nested sequence`);
	const rate = seq.settings.frameRate as Rational;
	const created: string[] = [];
	// new clip ids per (outer link, piece range): flattened video/audio of one camera stay linked
	const linkGroups = new Map<string, string[]>();
	for (const c of enabled) {
		const outer = plain(c) as Clip;
		if (outer.frameHold) {
			// A held multi-camera clip shows one frame of its angle: flatten it to that clip with the hold re-timed.
			h.warn('W_CLIP_SKIPPED', `Clip ${c.id} has a frame hold; remove it (Frame Hold Options) to flatten`);
			continue;
		}
		const r = resolveMulticamClip(doc as never, rate, outer);
		if (!r) {
			h.warn('W_CLIP_SKIPPED', `Clip ${c.id} has no multi-camera source; it was not flattened`);
			continue;
		}
		const track = findTrackIn(seq, c.trackId)!;
		assertUnlocked(track.track, h);
		const warn = (code: string, message: string) => h.warn(code, message);
		// transitions on the outer clip move to the pieces at its edges
		const trans = Object.values(seq.transitions)
			.filter((t) => t.outgoingClipId === c.id || t.incomingClipId === c.id)
			.map((t) => plain(t) as Transition);
		for (const t of trans) delete seq.transitions[t.id];
		removeClip(seq, c.id, h);
		const innerTracks = [...new Set(r.pieces.map((p) => p.innerTrackId))];
		const audioTracks = new Map(r.source.audioTracks.map((t) => [t.id, t]));
		const firstLast = { first: null as string | null, last: null as string | null };
		for (const p of r.pieces) {
			const id = h.ids.next('clp');
			const piece =
				outer.kind === 'nest-video'
					? pieceVideoClip(
							doc as never,
							r.source,
							outer as MulticamClip & { kind: 'nest-video' },
							p,
							id,
							warn,
						)
					: pieceAudioClip(
							r.source,
							outer as MulticamClip & { kind: 'nest-audio' },
							p,
							audioTracks.get(p.innerTrackId)!,
							id,
							warn,
						);
			const copy = plain(piece) as Clip;
			reidentifyClipChildren(copy, h);
			const k = innerTracks.indexOf(p.innerTrackId);
			const dest = k === 0 ? track.track : ensureTrackAt(seq, track.kind, track.index + k, h);
			assertUnlocked(dest, h);
			copy.trackId = dest.id;
			copy.linkId = null;
			copy.groupId = null;
			if (k > 0) relinkSplits(seq, clearRange(seq, dest.id, copy.start, end(copy), h), h);
			seq.clips[id] = copy as DClip;
			created.push(id);
			if (k === 0 && copy.start === outer.start) firstLast.first = id;
			if (k === 0 && end(copy) === end(outer)) firstLast.last = id;
			if (outer.linkId) {
				const key = `${outer.linkId}:${copy.start}:${copy.duration}`;
				linkGroups.set(key, [...(linkGroups.get(key) ?? []), id]);
			}
		}
		for (const t of trans) {
			const o = t.outgoingClipId === c.id ? firstLast.last : t.outgoingClipId;
			const i = t.incomingClipId === c.id ? firstLast.first : t.incomingClipId;
			if ((t.outgoingClipId && !o) || (t.incomingClipId && !i)) {
				h.warn(
					'W_TRANSITION_REMOVED',
					`Transition ${t.id} removed: the flattened angle has no clip at that edge`,
				);
				continue;
			}
			seq.transitions[t.id] = { ...t, outgoingClipId: o, incomingClipId: i } as Draft<Transition>;
		}
	}
	for (const ids of linkGroups.values()) if (ids.length >= 2) linkAll(seq, ids, h);
	cleanupSequence(seq, h);
	return { clipIds: created };
}

function editAngles(doc: DDoc, cmd: CommandOf<'multicam.editAngles'>, h: HandlerContext) {
	const src = doc.sequences[cmd.sequenceId];
	if (!src) h.fail('E_NOT_FOUND', `Sequence not found: ${cmd.sequenceId}`);
	const mc = (src as Draft<Sequence>).multicam;
	if (!mc) h.fail('E_INVALID_PARAM', 'Not a multi-camera source sequence');
	for (const e of cmd.angles ?? []) {
		const a = resolveAngle(mc as MulticamSource, e.angle);
		if (!a) h.fail('E_NOT_FOUND', `No angle ${e.angle}`);
		const da = mc.angles.find((x) => x.id === a.id)!;
		if (e.name !== undefined) da.name = e.name;
		if (e.enabled !== undefined) da.enabled = e.enabled;
	}
	if (cmd.order) {
		const ids = mc.angles.map((a) => a.id);
		if (
			cmd.order.length !== ids.length ||
			new Set(cmd.order).size !== ids.length ||
			cmd.order.some((id) => !ids.includes(id))
		)
			h.fail('E_INVALID_PARAM', '`order` must list every angle id exactly once');
		const by = new Map(mc.angles.map((a) => [a.id, plain(a)]));
		mc.angles = cmd.order.map((id) => by.get(id)!) as typeof mc.angles;
	}
	if (cmd.audio) mc.audio = cmd.audio;
	return { angles: plain(mc.angles) };
}

export const multicamHandlers = {
	'clip.synchronize': synchronize,
	'item.mergeClips': mergeClips,
	'multicam.create': createMulticam,
	'multicam.switchAngle': switchAngle,
	'multicam.record': record,
	'multicam.setEnabled': setEnabled,
	'multicam.flatten': flatten,
	'multicam.editAngles': editAngles,
} satisfies HandlerMap;

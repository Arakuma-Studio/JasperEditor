import type { Draft } from 'immer';
import { anim, defaultTextStyle, defaultTransform } from '../../factories.ts';
import { mediaDurationFlicks } from '../../interpret/model.ts';
import { mediaIntrinsicSize } from '../../process/rescale.ts';
import { defaultLabelForPlacedClip, kindCapabilities } from '../../registry/kinds.ts';
import type { MgTemplateInfo } from '../../registry/mg.ts';
import type { DefaultScaling, ProjectItem } from '../../schema/document.ts';
import type { MediaAsset, SyntheticSource } from '../../schema/media.ts';
import type { Clip, Sequence, TextBox, TextContent, TextStyle, Track } from '../../schema/sequence.ts';
import { SYNTHETIC_INFO, syntheticDefaultFlicks } from '../../structure/synthetic.ts';
import type { ProjectTextStyle } from '../../text-styles/model.ts';
import { diffStyle } from '../../text-styles/patch.ts';
import { newLayer3D } from '../../three-d/model.ts';
import { FRAME_EPS, flicksPerFrame, supportsDropFrame } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { valuesOf } from '../draft-read.ts';
import {
	allTracksIn,
	assertUnlocked,
	cleanupSequence,
	clearRange,
	end,
	ensureTrackAt,
	findTrackIn,
	insertShift,
	relinkSplits,
	removeClip,
	removeShift,
	resolveTrackIn,
	type SplitRecord,
	setClipRange,
	shiftMarkers,
	splitClipAt,
	syncFollowerTracks,
	trackCandidates,
	tracksOfKind,
} from '../placement.ts';
import { rippleDeleteSpans, rippleTrimGroup, tracksHolding, trimLimits } from '../ripple.ts';
import type { ClipPatch } from '../schemas/clip.ts';
import type { CommandOf } from '../schemas/index.ts';
import {
	applyTransformPatch,
	commonFields,
	ensureDefaultFont,
	frameBox,
	makeRoom,
	newGeneratorClip,
	prepareTrack,
	visualFields,
} from './clip-common.ts';
import { rollTrim } from './clip-edit.ts';
import { applyCompositionPatch } from './composition.ts';
import { applyTemplatePatch } from './mg-template.ts';
import { markMulticamClips } from './multicam-placement.ts';
import { applyShapePatch } from './shape-storage.ts';
import { expandGroups, placeSequence } from './structure.ts';
import { applyInitialTextAnimation, applyTextAnimationPatch } from './text-animation.ts';
import { type HandlerMap, idList, peek } from './util.ts';

type PlaceOptions = {
	source: { mediaId?: string; syntheticId?: string; sequenceId?: string; projectItemId?: string };
	sourceRange?: { in: number; out: number };
	at: number;
	mode: 'overwrite' | 'insert';
	videoTrack?: string;
	/** Destination per audio channel clip; `null` leaves that channel out (edit-ux source patching). */
	audioTracks?: (string | null)[];
	video?: boolean;
	audio?: boolean;
	audioMapping?: 'stereo' | 'mono-per-channel' | 'per-stream';
	scaling?: DefaultScaling;
	matchSequence?: 'ask-user' | 'match' | 'keep';
	createTracks?: boolean;
	rippleMarkers?: boolean;
	ref?: string;
	/**
	 * edit-ux (3/4-point editing, split edits, fit to fill): the resolved placement. `rate` is the clip speed;
	 * each channel (visual kinds use `video`, audio clips `audio`) starts `offset` frames after `at` with its own
	 * content In and length. A missing channel is not placed.
	 */
	fitted?: {
		rate: number;
		video?: { in: number; offset: number; frames: number };
		audio?: { in: number; offset: number; frames: number };
	};
	/** sequence sources as nests (default) or individual clips. */
	nest?: boolean;
};

/** Premiere Insert/Overwrite from a source (S01 `clip.place`, KND-003, FX-004, S02:TL-493). */
export function placeSource(
	doc: DDoc,
	seq: DSeq,
	h: HandlerContext,
	o: PlaceOptions,
): { clipIds: string[]; linkId: string | null } {
	const rate = seq.settings.frameRate;
	const F = flicksPerFrame(rate);
	let item: ProjectItem | undefined;
	let mediaId = o.source.mediaId;
	let syntheticId = o.source.syntheticId;
	if (o.source.projectItemId) {
		item = doc.items[o.source.projectItemId] as ProjectItem | undefined;
		if (!item) h.fail('E_NOT_FOUND', `Project item not found: ${o.source.projectItemId}`);
		if (item.kind === 'media' || item.kind === 'subclip') mediaId = item.mediaId;
		else if (item.kind === 'synthetic') syntheticId = item.syntheticId;
		else if (item.kind !== 'sequence') h.fail('E_INVALID_PARAM', `Cannot place a ${item.kind} item`);
	}
	// edit-structure (S01:SEQ-010, KND-011): a sequence is placed as nest clips or as its individual clips.
	const sequenceSource = o.source.sequenceId ?? (item?.kind === 'sequence' ? item.sequenceId : undefined);
	if (sequenceSource) {
		// A multi-camera source always places as linked multi-camera clips (camera 1); a merged clip
		// places as the clips it holds unless nesting is asked for explicitly.
		const placedSrc = doc.sequences[sequenceSource] as Sequence | undefined;
		const nest = placedSrc?.multicam ? true : placedSrc?.merged ? (o.nest ?? false) : o.nest;
		const placed = placeSequence(doc, seq, h, {
			sequenceId: sequenceSource,
			...(o.sourceRange ? { sourceRange: o.sourceRange } : {}),
			at: o.at,
			mode: o.mode,
			...(o.videoTrack ? { videoTrack: o.videoTrack } : {}),
			...(o.audioTracks ? { audioTracks: o.audioTracks.filter((t): t is string => t !== null) } : {}),
			...(o.video !== undefined ? { video: o.video } : {}),
			...(o.audio !== undefined ? { audio: o.audio } : {}),
			...(nest !== undefined ? { nest } : {}),
			...(o.createTracks !== undefined ? { createTracks: o.createTracks } : {}),
			...(o.rippleMarkers !== undefined ? { rippleMarkers: o.rippleMarkers } : {}),
			...(o.ref ? { ref: o.ref } : {}),
			...(item ? { name: item.name, label: item.label } : {}),
		});
		if (placedSrc?.multicam) markMulticamClips(seq, placed.clipIds, placedSrc.multicam);
		return placed;
	}
	const marks =
		item && (item.kind === 'media' || item.kind === 'synthetic' || item.kind === 'subclip')
			? item.marks
			: null;
	// a subclip's range is its default source range (its own marks narrow it).
	const subclip = item?.kind === 'subclip' ? item : null;
	const defaultIn = subclip ? subclip.range.in : 0;
	if (o.at < 0) h.fail('E_INVALID_PARAM', 'Placement frame must be >= 0');
	const scaling = o.scaling ?? doc.settings.defaultScaling;
	const stillFrames = Math.max(
		1,
		Math.round((doc.settings.defaultStillDurationFrames * rate.num) / (rate.den * 30)),
	);

	type Plan = {
		kind: Clip['kind'];
		trackRef: string;
		build(id: string, trackId: string, start: number, duration: number, sourceIn: number): Clip;
	};
	const plans: Plan[] = [];
	let frames: number;
	let sourceIn: number;

	if (mediaId) {
		const asset = doc.media[mediaId] as MediaAsset | undefined;
		if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${mediaId}`);
		if (asset.kind === 'font' || asset.kind === 'lut' || asset.kind === 'color-config')
			h.fail('E_INVALID_PARAM', `${asset.kind} assets cannot be placed on a timeline`);
		if (asset.kind === 'mg-bundle')
			h.fail(
				'E_INVALID_PARAM',
				'A Remotion bundle is placed one composition at a time: use clip.addComposition {composition: {mediaId, id}}',
			);
		const name = item?.name ?? asset.originalName;
		const label = (kind: Clip['kind']) => defaultLabelForPlacedClip(kind, asset, item?.label);
		const box = mediaIntrinsicSize(asset) ?? frameBox(seq);
		// a Lottie animation is placed with its length (and plays once), like a video.
		const bounded = asset.kind === 'video' || asset.kind === 'audio' || !!asset.lottie;
		const inF = o.sourceRange?.in ?? marks?.in?.flicks ?? defaultIn;
		if (bounded) {
			// the interpreted duration (Interpret Footage ▸ assumed frame rate, loop count).
			const dur = mediaDurationFlicks(asset);
			if (dur === null) h.fail('E_INVALID_PARAM', 'Media has no duration');
			const outF = o.sourceRange?.out ?? marks?.out?.flicks ?? subclip?.range.out ?? dur;
			if (outF <= inF) h.fail('E_INVALID_PARAM', 'Source out must be after source in');
			if (inF < 0 || outF > dur + F) h.fail('E_OUT_OF_MEDIA', 'Source range is outside the media');
			frames = Math.max(1, Math.floor(Math.min(outF, dur) / F - inF / F + FRAME_EPS));
		} else if (o.sourceRange) {
			frames = Math.max(1, Math.round((o.sourceRange.out - o.sourceRange.in) / F));
		} else frames = stillFrames;
		sourceIn = inF;
		// Mismatch handling (S01:SEQ-005): agents default to keep; "match" adopts the clip settings.
		if (o.matchSequence === 'match' && Object.keys(seq.clips).length === 0) {
			const vs = asset.probe.streams.find((s) => s.type === 'video');
			if (vs && vs.type === 'video') {
				const even = (n: number) => Math.max(16, Math.min(8192, n - (n % 2)));
				seq.settings.width = even(box.width);
				seq.settings.height = even(box.height);
				if (asset.kind === 'video') {
					const r = [
						{ num: 24000, den: 1001 },
						{ num: 24, den: 1 },
						{ num: 25, den: 1 },
						{ num: 30000, den: 1001 },
						{ num: 30, den: 1 },
						{ num: 50, den: 1 },
						{ num: 60000, den: 1001 },
						{ num: 60, den: 1 },
					].reduce((best, c) =>
						Math.abs(c.num / c.den - vs.frameRate.num / vs.frameRate.den) <
						Math.abs(best.num / best.den - vs.frameRate.num / vs.frameRate.den)
							? c
							: best,
					);
					seq.settings.frameRate = r;
					seq.settings.dropFrame = supportsDropFrame(r);
					return placeSource(doc, seq, h, { ...o, matchSequence: 'keep' });
				}
			}
		}
		const hasVideo = asset.probe.streams.some((s) => s.type === 'video');
		const audioStreams = asset.probe.streams.filter((s) => s.type === 'audio');
		const videoTrackRef = o.videoTrack ?? 'V1';
		if (asset.kind === 'video' && hasVideo && o.video !== false) {
			plans.push({
				kind: 'video',
				trackRef: videoTrackRef,
				build: (id, trackId, start, duration, si) => ({
					...commonFields(id, trackId, start, duration, si, name, label('video')),
					kind: 'video',
					mediaId: asset.id,
					videoStreamIndex: asset.probe.streams.find((s) => s.type === 'video')!.index,
					...visualFields(defaultTransform(box, frameBox(seq), scaling)),
				}),
			});
		} else if (asset.kind === 'image' || asset.kind === 'animated-image') {
			if (o.video === false) h.fail('E_INVALID_PARAM', 'Nothing to place (video: false on an image)');
			plans.push({
				kind: asset.kind === 'image' ? 'still' : 'animated-image',
				trackRef: videoTrackRef,
				build: (id, trackId, start, duration, si) =>
					({
						...commonFields(
							id,
							trackId,
							start,
							duration,
							si,
							name,
							label(asset.kind === 'image' ? 'still' : 'animated-image'),
						),
						kind: asset.kind === 'image' ? 'still' : 'animated-image',
						mediaId: asset.id,
						...(asset.kind === 'animated-image' ? { loop: !asset.lottie } : {}),
						...visualFields(defaultTransform(box, frameBox(seq), scaling)),
					}) as Clip,
			});
		} else if (asset.kind === 'model') {
			// three-d: a 3D model layer — always a 3D layer (Advanced 3D draws it).
			if (o.video === false) h.fail('E_INVALID_PARAM', 'Nothing to place (video: false on a 3D model)');
			plans.push({
				kind: 'model',
				trackRef: videoTrackRef,
				build: (id, trackId, start, duration, si) =>
					({
						...commonFields(id, trackId, start, duration, si, name, label('model')),
						kind: 'model',
						mediaId: asset.id,
						...visualFields(defaultTransform(frameBox(seq), frameBox(seq), 'none')),
						threeD: newLayer3D(true, 'model'),
					}) as Clip,
			});
		}
		if ((asset.kind === 'video' || asset.kind === 'audio') && audioStreams.length > 0 && o.audio !== false) {
			const channelSets: { streamIndex: number; map: number[]; mute?: number[] }[] = [];
			const mapping = o.audioMapping ?? 'stereo';
			// gaps (Modify ▸ Audio Channels on the Project item): the item's routing, unless a mapping was asked for.
			const routed = ((item?.kind === 'media' ? item : undefined) ??
				// read without drafting: drafting every Project item copies the record on each placement, and the
				// transaction's orphan check then scans every clip (the items look changed)
				(valuesOf(doc.items as Record<string, ProjectItem>).find(
					(x) => x.kind === 'media' && x.mediaId === asset.id && x.audioChannels,
				) as ProjectItem | undefined)) as
				| { audioChannels?: { clips?: { streamIndex: number; map: number[]; mute?: number[] }[] } }
				| undefined;
			if (!o.audioMapping && routed?.audioChannels?.clips?.length) {
				for (const c of routed.audioChannels.clips)
					channelSets.push({
						streamIndex: c.streamIndex,
						map: [...c.map],
						...(c.mute?.length ? { mute: [...c.mute] } : {}),
					});
			} else if (mapping === 'per-stream') {
				for (const s of audioStreams) {
					if (s.type === 'audio')
						channelSets.push({ streamIndex: s.index, map: [...Array(s.channels).keys()] });
				}
			} else {
				const s = audioStreams[0]!;
				if (s.type === 'audio') {
					if (mapping === 'mono-per-channel')
						for (let c = 0; c < s.channels; c++) channelSets.push({ streamIndex: s.index, map: [c] });
					else channelSets.push({ streamIndex: s.index, map: s.channels >= 2 ? [0, 1] : [0] });
				}
			}
			const videoIndex = (() => {
				const id = resolveTrackIn(seq, videoTrackRef);
				if (id) return findTrackIn(seq, id)?.index ?? 0;
				const m = /^V(\d+)$/i.exec(videoTrackRef);
				return m ? Number(m[1]) - 1 : 0;
			})();
			channelSets.forEach((channels, i) => {
				if (o.audioTracks?.[i] === null) return;
				const trackRef =
					o.audioTracks?.[i] ??
					(o.audioTracks && o.audioTracks.length > 0 ? `A${i + 1}` : `A${videoIndex + i + 1}`);
				plans.push({
					kind: 'audio',
					trackRef,
					build: (id, trackId, start, duration, si) => ({
						...commonFields(id, trackId, start, duration, si, name, label('audio')),
						kind: 'audio',
						mediaId: asset.id,
						channels,
						gainDb: 0,
						volumeDb: anim(0),
						pan: anim(0),
						effects: [],
					}),
				});
			});
		}
		if (plans.length === 0) h.fail('E_INVALID_PARAM', 'Nothing to place from this source');
	} else if (syntheticId) {
		const syn = doc.synthetics[syntheticId] as SyntheticSource | undefined;
		if (!syn) h.fail('E_NOT_FOUND', `Synthetic source not found: ${syntheticId}`);
		// the item's marks, else the generator's own length (bars 1 s, leader 11 s) or the still default.
		const inF = o.sourceRange?.in ?? marks?.in?.flicks ?? 0;
		const outF =
			o.sourceRange?.out ?? marks?.out?.flicks ?? inF + syntheticDefaultFlicks(syn.kind, stillFrames * F);
		if (outF <= inF) h.fail('E_INVALID_PARAM', 'Source out must be after source in');
		frames = Math.max(1, Math.round((outF - inF) / F));
		sourceIn = inF;
		const name = item?.name ?? SYNTHETIC_INFO[syn.kind].label;
		if (syn.kind === 'adjustment') {
			plans.push({
				kind: 'adjustment',
				trackRef: o.videoTrack ?? 'V1',
				build: (id, trackId, start, duration, si) => ({
					...commonFields(id, trackId, start, duration, si, name, item?.label ?? 'tan'),
					kind: 'adjustment',
					syntheticId: syn.id,
					opacity: anim(100),
					blendMode: 'normal',
					effects: [],
				}),
			});
		} else {
			// Mattes, black / transparent video, and the pictures of Bars and Tone and the counting leader.
			const info = SYNTHETIC_INFO[syn.kind];
			if (o.video !== false || !info.hasAudio)
				plans.push({
					kind: 'solid',
					trackRef: o.videoTrack ?? 'V1',
					build: (id, trackId, start, duration, si) => ({
						...commonFields(id, trackId, start, duration, si, name, item?.label ?? 'tan'),
						kind: 'solid',
						syntheticId: syn.id,
						...visualFields(defaultTransform(frameBox(seq), frameBox(seq), 'none')),
					}),
				});
			// their sound, linked like a media file's audio (Premiere's synthetics with tone/blips).
			if (info.hasAudio && o.audio !== false) {
				const videoIndex = (() => {
					const id = resolveTrackIn(seq, o.videoTrack ?? 'V1');
					if (id) return findTrackIn(seq, id)?.index ?? 0;
					const m = /^V(\d+)$/i.exec(o.videoTrack ?? 'V1');
					return m ? Number(m[1]) - 1 : 0;
				})();
				plans.push({
					kind: 'synthetic-audio',
					trackRef: o.audioTracks?.[0] ?? `A${videoIndex + 1}`,
					build: (id, trackId, start, duration, si) => ({
						...commonFields(id, trackId, start, duration, si, name, 'caribbean'),
						kind: 'synthetic-audio',
						syntheticId: syn.id,
						gainDb: 0,
						volumeDb: anim(0),
						pan: anim(0),
						effects: [],
					}),
				});
			}
			if (plans.length === 0) h.fail('E_INVALID_PARAM', 'Nothing to place from this source');
		}
	} else {
		return h.fail('E_INVALID_PARAM', 'clip.place needs a source');
	}

	// Where each planned clip goes: one range for all, or per channel (edit-ux `fitted`).
	type Slot = { plan: Plan; start: number; frames: number; sourceIn: number };
	const slots: Slot[] = [];
	for (const p of plans) {
		if (!o.fitted) {
			slots.push({ plan: p, start: o.at, frames: frames!, sourceIn: sourceIn! });
			continue;
		}
		const ch = p.kind === 'audio' ? o.fitted.audio : o.fitted.video;
		if (ch && ch.frames >= 1)
			slots.push({ plan: p, start: o.at + ch.offset, frames: ch.frames, sourceIn: ch.in });
	}
	if (slots.length === 0) h.fail('E_INVALID_PARAM', 'Nothing to place from this source');
	const create = o.createTracks !== false;
	const dest = slots.map((sl) => prepareTrack(seq, sl.plan.trackRef, sl.plan.kind, h, create));
	if (new Set(dest.map((t) => t.id)).size !== dest.length)
		h.fail('E_INVALID_PARAM', 'Two placed clips target the same track');
	if (o.mode === 'insert' || slots.every((sl) => sl.start === o.at && sl.frames === slots[0]!.frames)) {
		const a = Math.min(...slots.map((sl) => sl.start));
		const b = Math.max(...slots.map((sl) => sl.start + sl.frames));
		makeRoom(seq, h, dest, a, b - a, o.mode, o.rippleMarkers);
	} else
		slots.forEach((sl, i) => {
			makeRoom(seq, h, [dest[i]!], sl.start, sl.frames, 'overwrite');
		});
	const clipIds: string[] = [];
	slots.forEach((sl, i) => {
		const id = h.ids.next('clp');
		const clip = sl.plan.build(id, dest[i]!.id, sl.start, sl.frames, sl.sourceIn) as DClip;
		if (o.fitted && o.fitted.rate !== 1 && kindCapabilities(clip.kind)?.supportsSpeed)
			clip.speed.rate = o.fitted.rate;
		if (subclip) clip.subclipId = subclip.id;
		seq.clips[id] = clip;
		clipIds.push(id);
	});
	let linkId: string | null = null;
	if (clipIds.length >= 2) {
		linkId = h.ids.next('lnk');
		seq.links[linkId] = { id: linkId, members: [...clipIds] };
		for (const id of clipIds) seq.clips[id]!.linkId = linkId;
	}
	cleanupSequence(seq, h);
	h.defineRef(o.ref, clipIds[0]!);
	return { clipIds, linkId };
}

function estimateTextBox(content: TextContent, frameW: number): { width: number; height: number } {
	const s = content.style;
	const lines = content.text.split('\n');
	const longest = Math.max(1, ...lines.map((l) => l.length));
	const width = Math.min(frameW, Math.ceil(longest * s.sizePx * 0.55));
	return { width, height: Math.ceil(lines.length * s.sizePx * s.lineHeight) };
}

/** Applies measurement (browser) or marks layout pending (headless) (S01:KND-006). */
function layoutText(clip: Draft<Extract<Clip, { kind: 'text' }>>, h: HandlerContext, frameW: number): void {
	const content = clip.content as TextContent;
	const box = clip.box as TextBox;
	if (box.autoSize === 'none') {
		delete clip.layoutPending;
		return;
	}
	if (h.ctx.textMeasurer) {
		const m = h.ctx.textMeasurer.measure(content, box);
		if (box.autoSize === 'width') {
			clip.box.width = m.width;
			clip.box.height = m.height;
		} else clip.box.height = m.height;
		delete clip.layoutPending;
	} else {
		const e = estimateTextBox(content, frameW);
		if (box.autoSize === 'width') {
			clip.box.width = e.width;
			clip.box.height = e.height;
		}
		clip.layoutPending = true;
	}
}

function validateMgParams(
	info: MgTemplateInfo,
	params: Record<string, unknown>,
	h: HandlerContext,
): Record<string, unknown> {
	const parsed = info.paramsSchema.safeParse(params);
	if (!parsed.success) {
		const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
		h.fail('E_INVALID_PARAM', `Invalid params for ${info.id}@${info.version}: ${msg}`);
	}
	return parsed.data as Record<string, unknown>;
}

function trimHandler(doc: DDoc, cmd: CommandOf<'clip.trim'>, h: HandlerContext) {
	const mode = cmd.mode ?? 'regular';
	if (mode === 'roll') return rollTrim(doc, cmd, h);
	const { seq, clip } = h.clip(doc, cmd.clipId);
	assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
	const edgeFrame = (c: DClip) => (cmd.edge === 'in' ? c.start : end(c));
	const members: DClip[] = [clip];
	if (cmd.linked !== false && clip.linkId && seq.links[clip.linkId]) {
		for (const id of seq.links[clip.linkId]!.members) {
			const p = seq.clips[id];
			if (!p || p.id === clip.id || edgeFrame(p) !== edgeFrame(clip)) continue;
			if (findTrackIn(seq, p.trackId)?.track.locked) continue;
			if (members.some((m) => m.trackId === p.trackId)) continue;
			members.push(p);
		}
	}
	// edit-structure (Premiere groups): the outer edge of a clip group (its first In / last Out) trims every member
	// at that edge; inner edges trim the clip alone.
	if (cmd.group !== false && clip.groupId && seq.groups[clip.groupId]) {
		const group = seq.groups[clip.groupId]!.members.map((m) => seq.clips[m]).filter((c): c is DClip => !!c);
		const outer =
			cmd.edge === 'in' ? Math.min(...group.map((c) => c.start)) : Math.max(...group.map((c) => end(c)));
		if (edgeFrame(clip) === outer)
			for (const g of group) {
				if (members.some((m) => m.id === g.id) || edgeFrame(g) !== outer) continue;
				if (findTrackIn(seq, g.trackId)?.track.locked) continue;
				members.push(g);
			}
	}
	if (mode === 'ripple') {
		// one group edit that keeps split edits in sync (ripple.ts).
		const d = rippleTrimGroup(
			doc,
			seq,
			h,
			members.map((m) => ({ clip: m, edge: cmd.edge })),
			cmd.deltaFrames,
			{ clampToSyncLock: cmd.clampToSyncLock, rippleMarkers: cmd.rippleMarkers },
		);
		if (d !== 0) cleanupSequence(seq, h);
		return { deltaFrames: d };
	}
	const memberIds = new Set(members.map((m) => m.id));
	let d = cmd.deltaFrames;
	const lim = members.map((m) => trimLimits(doc, seq, m, cmd.edge, false, memberIds));
	const lo = Math.max(...lim.map((l) => l.min));
	const hi = Math.min(...lim.map((l) => l.max));
	const clamped = lo > hi ? 0 : Math.min(hi, Math.max(lo, d));
	if (clamped !== d) {
		h.warn('W_DURATION_CLAMPED', `Trim clamped from ${d} to ${clamped} frames`);
		d = clamped;
	}
	if (d === 0) return { deltaFrames: 0 };
	for (const m of members) {
		if (cmd.edge === 'in') setClipRange(seq, m, m.start + d, end(m));
		else setClipRange(seq, m, m.start, end(m) + d);
	}
	cleanupSequence(seq, h);
	return { deltaFrames: d };
}

export const clipCoreHandlers = {
	'clip.place': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const asset =
			'mediaId' in cmd.source ? (doc.media[cmd.source.mediaId] as MediaAsset | undefined) : undefined;
		const range = cmd.sourceRange
			? {
					in: h.flicks(cmd.sourceRange.in, asset, seq.settings.frameRate),
					out: h.flicks(cmd.sourceRange.out, asset, seq.settings.frameRate),
				}
			: undefined;
		const audio = cmd.tracks?.audio;
		return placeSource(doc, seq, h, {
			source: cmd.source,
			sourceRange: range,
			at: h.frame(seq, cmd.at),
			mode: cmd.mode ?? 'overwrite',
			videoTrack: cmd.tracks?.video,
			audioTracks: audio === undefined ? undefined : Array.isArray(audio) ? audio : [audio],
			video: cmd.video,
			audio: cmd.audio,
			audioMapping: cmd.audioMapping,
			scaling: cmd.scaling,
			matchSequence: cmd.matchSequence ?? 'keep',
			createTracks: cmd.createTracks,
			rippleMarkers: cmd.rippleMarkers,
			ref: cmd.ref,
			...(cmd.nest !== undefined ? { nest: cmd.nest } : {}),
		});
	},
	'clip.addText': (doc, cmd, h: HandlerContext) => {
		const fontId = cmd.content.style?.fontId ?? ensureDefaultFont(doc, h);
		if (!doc.fonts[fontId]) h.fail('E_NOT_FOUND', `Font not found: ${fontId}`);
		const style: TextStyle = {
			...defaultTextStyle(fontId),
			...(cmd.content.style ?? {}),
			fontId,
		} as TextStyle;
		const content: TextContent = {
			text: cmd.content.text,
			style,
			...(cmd.content.runs ? { runs: cmd.content.runs as TextContent['runs'] } : {}),
			...(cmd.content.paragraphs?.length
				? { paragraphs: cmd.content.paragraphs as TextContent['paragraphs'] }
				: {}),
		};
		const { seq, track, at, duration, id } = newGeneratorClip(doc, cmd, h, 'text');
		const est = estimateTextBox(content, seq.settings.width);
		const box: TextBox = {
			width: cmd.box?.width ?? est.width,
			height: cmd.box?.height ?? est.height,
			autoSize: cmd.box?.autoSize ?? 'width',
		};
		const transform = applyTransformPatch(defaultTransform(box, frameBox(seq), 'none'), cmd.transform);
		const name = cmd.name ?? (cmd.content.text.split('\n')[0]!.slice(0, 40) || 'Text');
		seq.clips[id] = {
			...commonFields(id, track.id, at, duration, 0, name, 'lavender'),
			kind: 'text',
			content,
			box,
			...visualFields(transform),
		} as DClip;
		const clip = seq.clips[id] as Draft<Extract<Clip, { kind: 'text' }>>;
		layoutText(clip, h, seq.settings.width);
		if (!cmd.transform?.anchor) clip.transform.anchor.value = [clip.box.width / 2, clip.box.height / 2];

		applyInitialTextAnimation(seq, clip as DClip, cmd.textAnimation, h);
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, id);
		return { clipId: id };
	},
	'clip.addSolid': (doc, cmd, h: HandlerContext) => {
		const { seq, track, at, duration, id } = newGeneratorClip(doc, cmd, h, 'solid');
		const synId = h.ids.next('syn');
		doc.synthetics[synId] = { id: synId, kind: 'color-matte', color: [...cmd.color] };
		seq.clips[id] = {
			...commonFields(id, track.id, at, duration, 0, cmd.name ?? 'Color Matte', 'tan'),
			kind: 'solid',
			syntheticId: synId,
			...visualFields(defaultTransform(frameBox(seq), frameBox(seq), 'none')),
		} as DClip;
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, id);
		return { clipId: id, syntheticId: synId };
	},
	'clip.addMotionGraphic': (doc, cmd, h: HandlerContext) => {
		const info = h.registries.mgTemplates.get(cmd.template.id, cmd.template.version);
		if (!info)
			h.fail('E_INVALID_PARAM', `Unknown motion-graphic template ${cmd.template.id}@${cmd.template.version}`);
		const params = validateMgParams(info, { ...info.defaults, ...(cmd.params ?? {}) }, h);
		const { seq, track, at, duration, id } = newGeneratorClip(doc, cmd, h, 'motion-graphic');
		const canvas = cmd.canvas ?? (info.canvasDefault === 'sequence' ? 'sequence' : { ...info.canvasDefault });
		const box = canvas === 'sequence' ? frameBox(seq) : canvas;
		seq.clips[id] = {
			...commonFields(id, track.id, at, duration, 0, cmd.name ?? info.name, 'purple'),
			kind: 'motion-graphic',
			// anime templates are stamped; absent = fframes.
			template: {
				id: info.id,
				version: info.version,
				...(info.renderer === 'anime' ? { renderer: 'anime' } : {}),
			},
			params,
			canvas,
			...visualFields(defaultTransform(box, frameBox(seq), canvas === 'sequence' ? 'none' : 'fit-if-larger')),
		} as DClip;
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, id);
		return { clipId: id };
	},
	'clip.move': (doc, cmd, h: HandlerContext) => {
		const ids = idList(cmd.clipIds);
		const found = h.clipsOf(doc, ids);
		const seq = found.seq;
		// edit-structure (S01:CLP-012): grouped clips move together.
		const clips = cmd.groups === false ? found.clips : expandGroups(seq, found.clips);
		const mode = cmd.mode ?? 'overwrite';
		const deltaFor = (kind: Track['kind']) =>
			typeof cmd.deltaTracks === 'number' ? cmd.deltaTracks : (cmd.deltaTracks?.[kind] ?? 0);
		const moving = new Set(clips.map((c) => c.id));
		const plan = clips.map((c) => {
			const src = findTrackIn(seq, c.trackId);
			if (!src) h.fail('E_NOT_FOUND', `Track not found: ${c.trackId}`);
			assertUnlocked(src.track, h);
			const idx = src.index + deltaFor(src.kind);
			if (idx < 0) h.fail('E_TRACK_KIND', `No ${src.kind} track at offset ${deltaFor(src.kind)}`);
			let dest = tracksOfKind(seq, src.kind)[idx];
			if (!dest) {
				if (!cmd.createTracks) h.fail('E_TRACK_KIND', `No ${src.kind} track ${idx + 1} (pass createTracks)`);
				dest = ensureTrackAt(seq, src.kind, idx, h);
			}
			assertUnlocked(dest, h);
			const start = c.start + cmd.deltaFrames;
			if (start < 0) h.fail('E_INVALID_PARAM', `Clip ${c.id} would start before frame 0`);
			return { clip: c, dest, start, end: start + c.duration };
		});
		if (mode === 'overwrite') {
			// one scan of the sequence for all destination tracks (the ranges and their order are unchanged).
			const hulls = new Map<string, { lo: number; hi: number }>();
			for (const p of plan) {
				const hull = hulls.get(p.dest.id);
				hulls.set(p.dest.id, {
					lo: Math.min(hull?.lo ?? p.start, p.start),
					hi: Math.max(hull?.hi ?? p.end, p.end),
				});
			}
			const pools = trackCandidates(seq, hulls, moving);
			for (const p of plan)
				relinkSplits(seq, clearRange(seq, p.dest.id, p.start, p.end, h, moving, pools.get(p.dest.id)), h);
		} else {
			const at = Math.min(...plan.map((p) => p.start));
			const n = Math.max(...plan.map((p) => p.end)) - at;
			const edited = new Set(plan.map((p) => p.dest.id));
			const tracks = [...edited, ...syncFollowerTracks(seq, edited).map((t) => t.id)];
			relinkSplits(seq, insertShift(seq, tracks, at, n, h, moving), h);
			if (cmd.rippleMarkers !== false) shiftMarkers(seq, at, n);
		}
		for (const p of plan) {
			p.clip.trackId = p.dest.id;
			p.clip.start = p.start;
		}
		cleanupSequence(seq, h);
		return { clipIds: plan.map((p) => p.clip.id) };
	},
	'clip.trim': trimHandler,
	'clip.split': (doc, cmd, h: HandlerContext) => {
		const given = [cmd.clipIds !== undefined, cmd.tracks !== undefined, cmd.scope !== undefined].filter(
			Boolean,
		).length;
		if (given !== 1) h.fail('E_INVALID_PARAM', 'clip.split needs exactly one of clipIds, tracks or scope');
		let seq: DSeq;
		let targets: DClip[];
		if (cmd.clipIds !== undefined) {
			const r = h.clipsOf(doc, idList(cmd.clipIds));
			seq = r.seq;
			targets = r.clips;
		} else seq = h.sequence(doc, cmd.sequenceId);
		const at = h.frame(seq, cmd.at);
		const crosses = (c: DClip) => c.start < at && at < end(c);
		if (cmd.clipIds !== undefined) {
			targets = targets!.filter(crosses);
			for (const c of targets) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		} else {
			const tracks =
				cmd.scope === 'all-unlocked'
					? allTracksIn(seq).filter((t) => !t.locked)
					: cmd.tracks!.map((r) => {
							const t = h.track(seq, r);
							assertUnlocked(t, h);
							return t;
						});
			const ids = new Set(tracks.map((t) => t.id));
			targets = Object.values(seq.clips).filter((c) => ids.has(c.trackId) && crosses(c));
		}
		const set = new Map(targets.map((c) => [c.id, c]));
		if (cmd.linked !== false) {
			for (const c of targets) {
				if (!c.linkId || !seq.links[c.linkId]) continue;
				for (const m of seq.links[c.linkId]!.members) {
					const p = seq.clips[m];
					if (p && crosses(p) && !findTrackIn(seq, p.trackId)?.track.locked) set.set(p.id, p);
				}
			}
		}
		const splits: SplitRecord[] = [];
		for (const c of set.values())
			splits.push({ originalLinkId: c.linkId, rightId: splitClipAt(seq, c, at, h).id });
		relinkSplits(seq, splits, h);
		cleanupSequence(seq, h);
		return { left: [...set.keys()], right: splits.map((s) => s.rightId) };
	},
	'clip.lift': (doc, cmd, h: HandlerContext) => {
		const found = h.clipsOf(doc, idList(cmd.clipIds));
		const seq = found.seq;
		const clips = cmd.groups === false ? found.clips : expandGroups(seq, found.clips);
		for (const c of clips) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		for (const c of clips) removeClip(seq, c.id, h);
		cleanupSequence(seq, h);
		return { removed: clips.map((c) => c.id) };
	},
	'clip.extract': (doc, cmd, h: HandlerContext) => {
		const found = h.clipsOf(doc, idList(cmd.clipIds));
		const seq = found.seq;
		const clips = cmd.groups === false ? found.clips : expandGroups(seq, found.clips);
		for (const c of clips) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		// close the time the clips free on every track that loses one, once (split edits, ripple.ts).
		const ids = new Set(clips.map((c) => c.id));
		const spans = rippleDeleteSpans(seq, ids);
		if (spans.length === 0)
			h.fail('E_INVALID_PARAM', 'No gap can close: other clips on these tracks cover the deleted time', {
				blocking: clips.map((c) => c.id),
			});
		const affected = tracksHolding(seq, ids);
		for (const c of clips) removeClip(seq, c.id, h);
		const tracks = new Set([
			...affected,
			...allTracksIn(seq)
				.filter((t) => t.syncLock && !t.locked)
				.map((t) => t.id),
		]);
		for (const r of [...spans].reverse()) {
			removeShift(seq, tracks, r.start, r.end - r.start, h, { syncConflict: cmd.syncConflict });
			if (cmd.rippleMarkers !== false) shiftMarkers(seq, r.start, -(r.end - r.start));
		}
		cleanupSequence(seq, h);
		return { removed: clips.map((c) => c.id), ranges: spans.map((r) => ({ start: r.start, end: r.end })) };
	},
	'clip.update': (doc, cmd, h: HandlerContext) => {
		const ids = cmd.clipId ? [cmd.clipId] : idList(cmd.clipIds);
		if (ids.length === 0) h.fail('E_INVALID_PARAM', 'clip.update needs clipId or clipIds');
		for (const id of ids) {
			const { seq, clip } = h.clip(doc, id);
			assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
			applyClipPatch(doc, seq, clip, cmd.patch, h);
		}
	},
} satisfies HandlerMap;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function writeTextStyle(
	clip: Draft<Extract<Clip, { kind: 'text' }>>,
	fields: Partial<TextStyle>,
	mode: StyleWriteMode,
): void {
	if (mode === 'whole') {
		clip.content.style = JSON.parse(JSON.stringify(fields)) as never;
		return;
	}
	const st = clip.content.style as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
		if (v === undefined) continue;
		if (mode === 'merge' && (k === 'shadow' || k === 'background') && isPlainObject(v) && isPlainObject(st[k]))
			Object.assign(st[k] as object, v);
		else st[k] = v;
	}
}

/**
 * spec 13 SH-002: a clip linked to a project text style records where its effective style now deviates from it
 * (whichever command wrote the style), so later edits of the style keep them.
 */
export function syncStyleOverrides(doc: DDoc, clip: DClip): void {
	if (clip.kind !== 'text') return;
	const r = clip as unknown as { styleId?: unknown; styleOverrides?: unknown };
	if (typeof r.styleId !== 'string') return;
	const styles = peek<Record<string, ProjectTextStyle>>(doc, 'textStyles');
	const style = styles && typeof styles === 'object' ? peek<ProjectTextStyle>(styles, r.styleId) : undefined;
	if (!style || !isPlainObject(style) || !isPlainObject(style.style)) return;
	const dev = diffStyle(style.style as TextStyle, clip.content.style as TextStyle);
	if (Object.keys(dev).length) r.styleOverrides = dev;
	else delete r.styleOverrides;
}

/**
 * How a patch's `content.style` is written: `merge` (clip.update): fields replace, a shadow / background object merges
 * into the existing one (fields it does not name, like `spreadPx`, survive); `objects`: every field given replaces
 * (Paste Attributes copies the source's objects exactly); `whole`: the patch is the complete new style (text.setStyle
 * and linked text styles, which also remove fields).
 */
export type StyleWriteMode = 'merge' | 'objects' | 'whole';

/** Applies one clip.update patch to a clip (also used by param.set on `clip.update`-written text properties). */
export function applyClipPatch(
	doc: DDoc,
	seq: DSeq,
	clip: DClip,
	p: ClipPatch,
	h: HandlerContext,
	styleMode: StyleWriteMode = 'merge',
): void {
	const caps = kindCapabilities(clip.kind);
	function refuse(field: string): never {
		return h.fail('E_INVALID_PARAM', `${field} does not apply to ${clip.kind} clips`);
	}
	if (p.name !== undefined) clip.name = p.name;
	if (p.label !== undefined) clip.label = p.label;
	if (p.enabled !== undefined) clip.enabled = p.enabled;
	if (p.maintainPitch !== undefined) clip.speed.maintainPitch = p.maintainPitch;
	if (p.content !== undefined || p.box !== undefined) {
		if (clip.kind !== 'text') refuse(p.content ? 'content' : 'box');
		if (p.content?.text !== undefined) clip.content.text = p.content.text;
		if (p.content?.style) writeTextStyle(clip, p.content.style as Partial<TextStyle>, styleMode);
		if (p.content?.runs !== undefined) clip.content.runs = p.content.runs;
		if (p.content?.paragraphs !== undefined) {
			if (p.content.paragraphs.length) clip.content.paragraphs = p.content.paragraphs;
			else delete clip.content.paragraphs;
		}
		if (p.content && clip.sourceTextKeyframes?.length)
			h.warn(
				'W_SOURCE_TEXT_ANIMATED',
				`${clip.id} has Source Text keyframes; they draw the text. Set text.sourceText at a time to change it there`,
				['content'],
			);
		if (!doc.fonts[clip.content.style.fontId])
			h.fail('E_NOT_FOUND', `Font not found: ${clip.content.style.fontId}`);
		if (p.box) Object.assign(clip.box, p.box);
		layoutText(clip, h, seq.settings.width);
		if (p.content?.style) syncStyleOverrides(doc, clip);
	}
	// Params in the same patch must target the upgraded template version.
	applyTemplatePatch(seq, clip, p, h);
	if (p.props !== undefined && clip.kind !== 'composition') refuse('props');
	if (!applyCompositionPatch(doc, clip, p, h) && (p.params !== undefined || p.canvas !== undefined)) {
		if (clip.kind !== 'motion-graphic') refuse(p.params ? 'params' : 'canvas');
		if (p.params !== undefined) {
			const info = h.registries.mgTemplates.get(clip.template.id, clip.template.version);
			if (!info)
				h.fail(
					'E_INVALID_PARAM',
					`Unknown motion-graphic template ${clip.template.id}@${clip.template.version}`,
				);
			clip.params = validateMgParams(info, { ...clip.params, ...p.params }, h);
		}
		if (p.canvas !== undefined) clip.canvas = p.canvas;
	}
	if (p.textAnimation !== undefined && clip.kind !== 'text') refuse('textAnimation');
	applyTextAnimationPatch(seq, clip, p, h);
	if (p.shape !== undefined) {
		if (clip.kind !== 'shape') refuse('shape');
		applyShapePatch(clip.shape, p.shape, h);
	}
	if (p.blendMode !== undefined) {
		if (!caps?.hasOpacity || !('blendMode' in clip)) refuse('blendMode');
		clip.blendMode = p.blendMode;
	}
	for (const field of ['uniformScale', 'flipH', 'flipV'] as const) {
		const value = p[field];
		if (value === undefined) continue;
		if (!caps?.hasTransform || !('transform' in clip)) refuse(field);
		clip.transform[field] = value;
	}
	if (p.gainDb !== undefined) {
		if (clip.kind !== 'audio' && clip.kind !== 'nest-audio' && clip.kind !== 'synthetic-audio')
			refuse('gainDb');
		clip.gainDb = p.gainDb;
	}
	if (p.channels !== undefined) {
		if (clip.kind !== 'audio') refuse('channels');
		clip.channels = p.channels;
	}
	if (p.loop !== undefined) {
		if (clip.kind !== 'animated-image') refuse('loop');
		clip.loop = p.loop;
	}
	if (p.style !== undefined) {
		if (clip.kind !== 'captions') refuse('style');
		clip.style = { ...clip.style, ...p.style };
	}
}

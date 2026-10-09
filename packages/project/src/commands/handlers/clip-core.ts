// Core clip handlers (ARCHITECTURE §5.3, WP-00): place, addText/addSolid/addMotionGraphic, move,
// trim (regular + ripple), split, lift, extract, update. S01 §9–§10, S02 §10–§13, Appendix A.

import type { Draft } from 'immer';
import {
	anim,
	type Box,
	createFontRef,
	DEFAULT_FONT_FAMILY,
	defaultSpeed,
	defaultTextStyle,
	defaultTransform,
} from '../../factories.ts';
import { mediaDurationFlicks } from '../../interpret/model.ts';
import { mediaIntrinsicSize } from '../../process/rescale.ts';
import { defaultLabelForPlacedClip, kindCapabilities } from '../../registry/kinds.ts';
import type { MgTemplateInfo } from '../../registry/mg.ts';
import type { Animatable, LabelColor, Vec2 } from '../../schema/common.ts';
import type { DefaultScaling, ProjectItem } from '../../schema/document.ts';
import type { MediaAsset, SyntheticSource } from '../../schema/media.ts';
import type {
	Clip,
	Sequence,
	TextBox,
	TextContent,
	TextStyle,
	Track,
	Transform,
} from '../../schema/sequence.ts';
import { SYNTHETIC_INFO, syntheticDefaultFlicks } from '../../structure/synthetic.ts';
import { newLayer3D } from '../../three-d/model.ts';
import { FRAME_EPS, flicksPerFrame, supportsDropFrame } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import {
	allTracksIn,
	assertKindFits,
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
	resolveOrCreateTrack,
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
import type { ClipPatch, TransformPatch } from '../schemas/clip.ts';
import type { CommandOf } from '../schemas/index.ts';
import { rollTrim } from './clip-edit.ts';
import { applyCompositionPatch } from './composition.ts';
import { applyTemplatePatch } from './mg-template.ts';
import { markMulticamClips } from './multicam.ts';
import { applyShapePatch } from './shape.ts';
import { expandGroups, placeSequence } from './structure.ts';
import { applyInitialTextAnimation, applyTextAnimationPatch } from './text-animation.ts';
import { type HandlerMap, idList } from './util.ts';

type DTrack = Draft<Track>;
export const frameBox = (seq: DSeq): Box => ({ width: seq.settings.width, height: seq.settings.height });

export function commonFields(
	id: string,
	trackId: string,
	start: number,
	duration: number,
	sourceIn: number,
	name: string,
	label: LabelColor,
) {
	return {
		id,
		trackId,
		start,
		duration,
		sourceIn,
		speed: defaultSpeed(),
		name,
		label,
		enabled: true,
		linkId: null,
		groupId: null,
		markers: [],
	};
}

export function visualFields(transform: Transform) {
	return { transform, opacity: anim(100), blendMode: 'normal' as const, effects: [] };
}

export function applyTransformPatch(t: Transform, p: TransformPatch | undefined): Transform {
	if (!p) return t;
	const vec = (v: Vec2 | Animatable<Vec2>) =>
		Array.isArray(v) ? anim<Vec2>([v[0], v[1]]) : (v as Animatable<Vec2>);
	const num = (v: number | Animatable<number>) => (typeof v === 'number' ? anim(v) : v);
	return {
		...t,
		...(p.position !== undefined ? { position: vec(p.position) } : {}),
		...(p.anchor !== undefined ? { anchor: vec(p.anchor) } : {}),
		...(p.scale !== undefined ? { scale: num(p.scale) } : {}),
		...(p.scaleWidth !== undefined ? { scaleWidth: num(p.scaleWidth) } : {}),
		...(p.rotation !== undefined ? { rotation: num(p.rotation) } : {}),
		...(p.uniformScale !== undefined ? { uniformScale: p.uniformScale } : {}),
		...(p.flipH !== undefined ? { flipH: p.flipH } : {}),
		...(p.flipV !== undefined ? { flipV: p.flipV } : {}),
	};
}

/** Overwrite `[at, at+n)` on the destination tracks, or insert-shift them plus sync-locked tracks. */
export function makeRoom(
	seq: DSeq,
	h: HandlerContext,
	dest: readonly DTrack[],
	at: number,
	n: number,
	mode: 'overwrite' | 'insert',
	rippleMarkers = true,
): void {
	let splits: SplitRecord[] = [];
	if (mode === 'overwrite') {
		for (const t of dest) splits.push(...clearRange(seq, t.id, at, at + n, h));
	} else {
		const edited = new Set(dest.map((t) => t.id));
		const tracks = [...edited, ...syncFollowerTracks(seq, edited).map((t) => t.id)];
		splits = insertShift(seq, tracks, at, n, h);
		if (rippleMarkers) shiftMarkers(seq, at, n);
	}
	relinkSplits(seq, splits, h);
}

function prepareTrack(seq: DSeq, ref: string, kind: string, h: HandlerContext, create: boolean): DTrack {
	const t = resolveOrCreateTrack(seq, ref, h, create);
	assertUnlocked(t, h);
	assertKindFits(kind, t, h);
	return t;
}

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
	/** edit-structure: sequence sources as nests (default) or individual clips. */
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
		// wp-multicam: a multi-camera source always places as linked multi-camera clips (camera 1); a merged clip
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
	// edit-ux: a subclip's range is its default source range (its own marks narrow it).
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
		// imports: a Lottie animation is placed with its length (and plays once), like a video.
		const bounded = asset.kind === 'video' || asset.kind === 'audio' || !!asset.lottie;
		const inF = o.sourceRange?.in ?? marks?.in?.flicks ?? defaultIn;
		if (bounded) {
			// imports: the interpreted duration (Interpret Footage ▸ assumed frame rate, loop count).
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
				(Object.values(doc.items).find(
					(x) =>
						x.kind === 'media' && x.mediaId === asset.id && (x as { audioChannels?: unknown }).audioChannels,
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
		// edit-structure: the item's marks, else the generator's own length (bars 1 s, leader 11 s) or the still default.
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
			// edit-structure: their sound, linked like a media file's audio (Premiere's synthetics with tone/blips).
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

// ---------------------------------------------------------------- generators

export function newGeneratorClip(
	doc: DDoc,
	cmd: {
		sequenceId?: string;
		at: CommandOf<'clip.addText'>['at'];
		duration: CommandOf<'clip.addText'>['duration'];
		track: string;
		id?: string;
	},
	h: HandlerContext,
	kind: 'text' | 'solid' | 'motion-graphic' | 'shape' | 'adjustment',
): { seq: DSeq; track: DTrack; at: number; duration: number; id: string } {
	const seq = h.sequence(doc, cmd.sequenceId);
	const at = h.frame(seq, cmd.at);
	const duration = h.durationFrames(seq, cmd.duration);
	if (at < 0) h.fail('E_INVALID_PARAM', 'Clip start must be >= 0');
	if (duration < 1) h.fail('E_INVALID_PARAM', 'Clip duration must be >= 1 frame');
	const track = prepareTrack(seq, cmd.track, kind, h, true);
	const id = h.newId(doc, 'clp', cmd.id);
	makeRoom(seq, h, [track], at, duration, 'overwrite');
	return { seq, track, at, duration, id };
}

function ensureDefaultFont(doc: DDoc, h: HandlerContext): string {
	const existing = Object.values(doc.fonts).find((f) => f.family === DEFAULT_FONT_FAMILY);
	if (existing) return existing.id;
	const font = createFontRef(h.ids);
	doc.fonts[font.id] = font;
	return font.id;
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

// ---------------------------------------------------------------- trim

function trimHandler(doc: DDoc, cmd: CommandOf<'clip.trim'>, h: HandlerContext): unknown {
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
		// edit-ux: one group edit that keeps split edits in sync (ripple.ts).
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

// ---------------------------------------------------------------- handlers

export const clipCoreHandlers: HandlerMap = {
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
		// M2 (S11:TXA-006, wp-m2-text-anim).
		applyInitialTextAnimation(doc, seq, clip as DClip, cmd.textAnimation, h);
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
			// M2 (S11:ATP-002): anime templates are stamped; absent = fframes.
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
			// perf-core: one scan of the sequence for all destination tracks (the ranges and their order are unchanged).
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
		// edit-ux: close the time the clips free on every track that loses one, once (split edits, ripple.ts).
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
};

/** Applies one clip.update patch to a clip (also used by param.set on `clip.update`-written text properties). */
export function applyClipPatch(doc: DDoc, seq: DSeq, clip: DClip, p: ClipPatch, h: HandlerContext): void {
	const c = clip as Draft<Record<string, unknown>> & DClip;
	const caps = kindCapabilities(clip.kind);
	const need = (ok: boolean, field: string) => {
		if (!ok) h.fail('E_INVALID_PARAM', `${field} does not apply to ${clip.kind} clips`);
	};
	if (p.name !== undefined) clip.name = p.name;
	if (p.label !== undefined) clip.label = p.label;
	if (p.enabled !== undefined) clip.enabled = p.enabled;
	if (p.maintainPitch !== undefined) clip.speed.maintainPitch = p.maintainPitch;
	if (p.content !== undefined || p.box !== undefined) {
		need(clip.kind === 'text', p.content ? 'content' : 'box');
		const t = clip as Draft<Extract<Clip, { kind: 'text' }>>;
		if (p.content?.text !== undefined) t.content.text = p.content.text;
		if (p.content?.style) Object.assign(t.content.style, p.content.style);
		if (p.content?.runs !== undefined) t.content.runs = p.content.runs as never;
		if (p.content?.paragraphs !== undefined) {
			if (p.content.paragraphs.length) t.content.paragraphs = p.content.paragraphs as never;
			else delete t.content.paragraphs;
		}
		// text-animators workstream: with Source Text keyframes the keys draw the text (content is their base).
		if (p.content && (t as { sourceTextKeyframes?: unknown[] }).sourceTextKeyframes?.length)
			h.warn(
				'W_SOURCE_TEXT_ANIMATED',
				`${clip.id} has Source Text keyframes; they draw the text. Set text.sourceText at a time to change it there`,
				['content'],
			);
		if (!doc.fonts[t.content.style.fontId])
			h.fail('E_NOT_FOUND', `Font not found: ${t.content.style.fontId}`);
		if (p.box) Object.assign(t.box, p.box);
		layoutText(t, h, seq.settings.width);
	}
	// M2 (S11:ATP-009): a template upgrade runs before `params`, so params in the same patch target the new version.
	if (p.template !== undefined) need(clip.kind === 'motion-graphic', 'template');
	applyTemplatePatch(doc, seq, clip, p, h);
	// M2 (S08:MGC-007): composition clips take `props` (whole override object) and `canvas`.
	if (p.props !== undefined) need(clip.kind === 'composition', 'props');
	if (!applyCompositionPatch(doc, clip, p, h) && (p.params !== undefined || p.canvas !== undefined)) {
		need(clip.kind === 'motion-graphic', p.params ? 'params' : 'canvas');
		const mg = clip as Draft<Extract<Clip, { kind: 'motion-graphic' }>>;
		if (p.params !== undefined) {
			const info = h.registries.mgTemplates.get(mg.template.id, mg.template.version);
			if (!info)
				h.fail('E_INVALID_PARAM', `Unknown motion-graphic template ${mg.template.id}@${mg.template.version}`);
			mg.params = validateMgParams(
				info,
				{ ...(mg.params as Record<string, unknown>), ...p.params },
				h,
			) as never;
		}
		if (p.canvas !== undefined) mg.canvas = p.canvas as never;
	}
	// M2 (S11, ARCHITECTURE §20.1): fields implemented by wp-m2-text-anim, wp-m2-shapes, wp-m2-anime-templates.
	if (p.textAnimation !== undefined) need(clip.kind === 'text', 'textAnimation');
	applyTextAnimationPatch(doc, seq, clip, p, h);
	if (p.shape !== undefined) need(clip.kind === 'shape', 'shape');
	applyShapePatch(doc, seq, clip, p, h);
	if (p.blendMode !== undefined) {
		need(!!caps?.hasOpacity && clip.kind !== 'captions', 'blendMode');
		c.blendMode = p.blendMode;
	}
	for (const f of ['uniformScale', 'flipH', 'flipV'] as const) {
		if (p[f] === undefined) continue;
		need(!!caps?.hasTransform, f);
		(c.transform as Record<string, unknown>)[f] = p[f];
	}
	if (p.gainDb !== undefined) {
		need(clip.kind === 'audio' || clip.kind === 'nest-audio' || clip.kind === 'synthetic-audio', 'gainDb');
		c.gainDb = p.gainDb;
	}
	if (p.channels !== undefined) {
		need(clip.kind === 'audio', 'channels');
		c.channels = p.channels;
	}
	if (p.loop !== undefined) {
		need(clip.kind === 'animated-image', 'loop');
		c.loop = p.loop;
	}
	if (p.style !== undefined) {
		need(clip.kind === 'captions', 'style');
		c.style = { ...(c.style as object), ...p.style };
	}
}

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
	scaleForMode,
} from '../../factories.ts';
import { defaultLabelForMedia, isBoundedContent, kindCapabilities } from '../../registry/kinds.ts';
import type { MgTemplateInfo } from '../../registry/mg.ts';
import type { Animatable, LabelColor, Vec2 } from '../../schema/common.ts';
import type { DefaultScaling, ProjectItem } from '../../schema/document.ts';
import type { MediaAsset, SyntheticSource } from '../../schema/media.ts';
import type { Clip, TextBox, TextContent, TextStyle, Track, Transform } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational, supportsDropFrame } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import {
	allTracksIn,
	assertKindFits,
	assertUnlocked,
	cleanupSequence,
	clearRange,
	contentInRange,
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
	trackClips,
	tracksOfKind,
} from '../placement.ts';
import type { ClipPatch, TransformPatch } from '../schemas/clip.ts';
import type { CommandOf } from '../schemas/index.ts';
import { rollTrim } from './clip-edit.ts';
import { type HandlerMap, idList } from './util.ts';

type DTrack = Draft<Track>;
const rateOf = (seq: DSeq) => seq.settings.frameRate as Rational;
const frameBox = (seq: DSeq): Box => ({ width: seq.settings.width, height: seq.settings.height });

function commonFields(h: HandlerContext, id: string, trackId: string, start: number, duration: number, sourceIn: number, name: string, label: LabelColor) {
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

function visualFields(transform: Transform) {
	return { transform, opacity: anim(100), blendMode: 'normal' as const, effects: [] };
}

/** Intrinsic box of a media asset: probed size with rotation applied (S01:KND-020, AST-002). */
export function mediaBox(asset: MediaAsset): Box | null {
	const vs = asset.probe.streams.find((s) => s.type === 'video');
	if (!vs || vs.type !== 'video') return null;
	const swap = asset.probe.rotationDegrees === 90 || asset.probe.rotationDegrees === 270;
	return swap ? { width: vs.height, height: vs.width } : { width: vs.width, height: vs.height };
}

function applyTransformPatch(t: Transform, p: TransformPatch | undefined): Transform {
	if (!p) return t;
	const vec = (v: Vec2 | Animatable<Vec2>) => (Array.isArray(v) ? anim<Vec2>([v[0], v[1]]) : (v as Animatable<Vec2>));
	const num = (v: number | Animatable<number>) => (typeof v === 'number' ? anim(v) : (v as Animatable<number>));
	return {
		...t,
		...(p.position !== undefined ? { position: vec(p.position as Vec2 | Animatable<Vec2>) } : {}),
		...(p.anchor !== undefined ? { anchor: vec(p.anchor as Vec2 | Animatable<Vec2>) } : {}),
		...(p.scale !== undefined ? { scale: num(p.scale as number | Animatable<number>) } : {}),
		...(p.scaleWidth !== undefined ? { scaleWidth: num(p.scaleWidth as number | Animatable<number>) } : {}),
		...(p.rotation !== undefined ? { rotation: num(p.rotation as number | Animatable<number>) } : {}),
		...(p.uniformScale !== undefined ? { uniformScale: p.uniformScale } : {}),
		...(p.flipH !== undefined ? { flipH: p.flipH } : {}),
		...(p.flipV !== undefined ? { flipV: p.flipV } : {}),
	};
}

/** Overwrite `[at, at+n)` on the destination tracks, or insert-shift them plus sync-locked tracks. */
function makeRoom(
	seq: DSeq,
	h: HandlerContext,
	dest: readonly DTrack[],
	at: number,
	n: number,
	mode: 'overwrite' | 'insert',
	opts: { rippleMarkers?: boolean; except?: ReadonlySet<string> } = {},
): void {
	let splits: SplitRecord[] = [];
	if (mode === 'overwrite') {
		for (const t of dest) splits.push(...clearRange(seq, t.id, at, at + n, h, opts.except));
	} else {
		const edited = new Set(dest.map((t) => t.id));
		const tracks = [...edited, ...syncFollowerTracks(seq, edited).map((t) => t.id)];
		splits = insertShiftExcept(seq, tracks, at, n, h, opts.except);
		if (opts.rippleMarkers !== false) shiftMarkers(seq, at, n);
	}
	relinkSplits(seq, splits, h);
}

/** insertShift that leaves `except` clips (being moved) where they are. */
function insertShiftExcept(
	seq: DSeq,
	trackIds: readonly string[],
	at: number,
	n: number,
	h: HandlerContext,
	except?: ReadonlySet<string>,
): SplitRecord[] {
	if (!except || except.size === 0) return insertShift(seq, trackIds, at, n, h);
	const splits: SplitRecord[] = [];
	for (const trackId of trackIds) {
		for (const c of trackClips(seq, trackId)) {
			if (except.has(c.id)) continue;
			if (c.start < at && end(c) > at) {
				const linkId = c.linkId;
				splits.push({ originalLinkId: linkId, rightId: splitClipAt(seq, c, at, h).id });
			}
		}
		for (const c of trackClips(seq, trackId)) if (!except.has(c.id) && c.start >= at) c.start += n;
	}
	return splits;
}

function prepareTrack(seq: DSeq, ref: string, kind: string, h: HandlerContext, create: boolean): DTrack {
	const t = resolveOrCreateTrack(seq, ref, h, create);
	assertUnlocked(t, h);
	assertKindFits(kind, t, h);
	return t;
}

export type PlaceOptions = {
	source: { mediaId?: string; syntheticId?: string; sequenceId?: string; projectItemId?: string };
	sourceRange?: { in: number; out: number };
	at: number;
	mode: 'overwrite' | 'insert';
	videoTrack?: string;
	audioTracks?: string[];
	video?: boolean;
	audio?: boolean;
	audioMapping?: 'stereo' | 'mono-per-channel' | 'per-stream';
	scaling?: DefaultScaling;
	matchSequence?: 'ask-user' | 'match' | 'keep';
	createTracks?: boolean;
	rippleMarkers?: boolean;
	ref?: string;
};

/** Premiere Insert/Overwrite from a source (S01 `clip.place`, KND-003, FX-004, S02:TL-493). */
export function placeSource(doc: DDoc, seq: DSeq, h: HandlerContext, o: PlaceOptions): { clipIds: string[]; linkId: string | null } {
	const rate = rateOf(seq);
	const F = flicksPerFrame(rate);
	let item: ProjectItem | undefined;
	let mediaId = o.source.mediaId;
	let syntheticId = o.source.syntheticId;
	if (o.source.projectItemId) {
		item = doc.items[o.source.projectItemId] as ProjectItem | undefined;
		if (!item) h.fail('E_NOT_FOUND', `Project item not found: ${o.source.projectItemId}`);
		if (item.kind === 'media') mediaId = item.mediaId;
		else if (item.kind === 'synthetic') syntheticId = item.syntheticId;
		else if (item.kind === 'sequence') h.fail('E_NOT_IMPLEMENTED', 'Placing sequences (nesting) arrives in M2');
		else h.fail('E_INVALID_PARAM', `Cannot place a ${item.kind} item`);
	}
	if (o.source.sequenceId) h.fail('E_NOT_IMPLEMENTED', 'Placing sequences (nesting) arrives in M2');
	const marks = item && (item.kind === 'media' || item.kind === 'synthetic') ? item.marks : null;
	if (o.at < 0) h.fail('E_INVALID_PARAM', 'Placement frame must be >= 0');
	const scaling = o.scaling ?? doc.settings.defaultScaling;
	const stillFrames = Math.max(1, Math.round((doc.settings.defaultStillDurationFrames * rate.num) / (rate.den * 30)));

	type Plan = { kind: Clip['kind']; trackRef: string; build(id: string, trackId: string, start: number, duration: number, sourceIn: number): Clip };
	const plans: Plan[] = [];
	let frames: number;
	let sourceIn: number;

	if (mediaId) {
		const asset = doc.media[mediaId] as MediaAsset | undefined;
		if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${mediaId}`);
		if (asset.kind === 'font' || asset.kind === 'lut') h.fail('E_INVALID_PARAM', `${asset.kind} assets cannot be placed on a timeline`);
		const name = item?.name ?? asset.originalName;
		const label = item?.label ?? defaultLabelForMedia(asset);
		const box = mediaBox(asset) ?? frameBox(seq);
		const bounded = asset.kind === 'video' || asset.kind === 'audio';
		const inF = o.sourceRange?.in ?? marks?.in?.flicks ?? 0;
		if (bounded) {
			const dur = asset.probe.durationFlicks;
			if (dur === null) h.fail('E_INVALID_PARAM', 'Media has no duration');
			const outF = o.sourceRange?.out ?? marks?.out?.flicks ?? dur;
			if (outF <= inF) h.fail('E_INVALID_PARAM', 'Source out must be after source in');
			if (inF < 0 || outF > dur + F) h.fail('E_OUT_OF_MEDIA', 'Source range is outside the media');
			frames = Math.max(1, Math.floor(Math.min(outF, dur) / F - inF / F + 1e-9));
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
						Math.abs(c.num / c.den - vs.frameRate.num / vs.frameRate.den) < Math.abs(best.num / best.den - vs.frameRate.num / vs.frameRate.den) ? c : best,
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
					...commonFields(h, id, trackId, start, duration, si, name, label),
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
						...commonFields(h, id, trackId, start, duration, si, name, label),
						kind: asset.kind === 'image' ? 'still' : 'animated-image',
						mediaId: asset.id,
						...(asset.kind === 'animated-image' ? { loop: true } : {}),
						...visualFields(defaultTransform(box, frameBox(seq), scaling)),
					}) as Clip,
			});
		}
		if ((asset.kind === 'video' || asset.kind === 'audio') && audioStreams.length > 0 && o.audio !== false) {
			const channelSets: { streamIndex: number; map: number[] }[] = [];
			const mapping = o.audioMapping ?? 'stereo';
			if (mapping === 'per-stream') {
				for (const s of audioStreams) {
					if (s.type === 'audio') channelSets.push({ streamIndex: s.index, map: [...Array(s.channels).keys()] });
				}
			} else {
				const s = audioStreams[0]!;
				if (s.type === 'audio') {
					if (mapping === 'mono-per-channel') for (let c = 0; c < s.channels; c++) channelSets.push({ streamIndex: s.index, map: [c] });
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
				const trackRef = o.audioTracks?.[i] ?? (o.audioTracks && o.audioTracks.length > 0 ? `A${i + 1}` : `A${videoIndex + i + 1}`);
				plans.push({
					kind: 'audio',
					trackRef,
					build: (id, trackId, start, duration, si) => ({
						...commonFields(h, id, trackId, start, duration, si, name, label),
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
		frames = o.sourceRange ? Math.max(1, Math.round((o.sourceRange.out - o.sourceRange.in) / F)) : stillFrames;
		sourceIn = o.sourceRange?.in ?? marks?.in?.flicks ?? 0;
		const name = item?.name ?? (syn.kind === 'color-matte' ? 'Color Matte' : syn.kind);
		if (syn.kind === 'adjustment') {
			plans.push({
				kind: 'adjustment',
				trackRef: o.videoTrack ?? 'V1',
				build: (id, trackId, start, duration, si) => ({
					...commonFields(h, id, trackId, start, duration, si, name, item?.label ?? 'tan'),
					kind: 'adjustment',
					syntheticId: syn.id,
					opacity: anim(100),
					blendMode: 'normal',
					effects: [],
				}),
			});
		} else if (syn.kind === 'color-matte' || syn.kind === 'black-video' || syn.kind === 'transparent') {
			plans.push({
				kind: 'solid',
				trackRef: o.videoTrack ?? 'V1',
				build: (id, trackId, start, duration, si) => ({
					...commonFields(h, id, trackId, start, duration, si, name, item?.label ?? 'tan'),
					kind: 'solid',
					syntheticId: syn.id,
					...visualFields(defaultTransform(frameBox(seq), frameBox(seq), 'none')),
				}),
			});
		} else h.fail('E_NOT_IMPLEMENTED', `Placing ${syn.kind} sources arrives later`);
	} else {
		return h.fail('E_INVALID_PARAM', 'clip.place needs a source');
	}

	const create = o.createTracks !== false;
	const dest = plans.map((p) => prepareTrack(seq, p.trackRef, p.kind, h, create));
	if (new Set(dest.map((t) => t.id)).size !== dest.length) h.fail('E_INVALID_PARAM', 'Two placed clips target the same track');
	makeRoom(seq, h, dest, o.at, frames!, o.mode, { rippleMarkers: o.rippleMarkers });
	const clipIds: string[] = [];
	plans.forEach((p, i) => {
		const id = h.ids.next('clp');
		seq.clips[id] = p.build(id, dest[i]!.id, o.at, frames!, sourceIn!) as DClip;
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

function newGeneratorClip(
	doc: DDoc,
	cmd: { sequenceId?: string; at: CommandOf<'clip.addText'>['at']; duration: CommandOf<'clip.addText'>['duration']; track: string; id?: string },
	h: HandlerContext,
	kind: 'text' | 'solid' | 'motion-graphic',
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

function validateMgParams(info: MgTemplateInfo, params: Record<string, unknown>, h: HandlerContext): Record<string, unknown> {
	const parsed = info.paramsSchema.safeParse(params);
	if (!parsed.success) {
		const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
		h.fail('E_INVALID_PARAM', `Invalid params for ${info.id}@${info.version}: ${msg}`);
	}
	return parsed.data as Record<string, unknown>;
}

// ---------------------------------------------------------------- trim

type TrimLimits = { min: number; max: number };

/** Allowed delta range for trimming one clip edge (S02:TL-534/541, S01:CLP-005). */
function trimLimits(doc: DDoc, seq: DSeq, c: DClip, edge: 'in' | 'out', ripple: boolean, members: ReadonlySet<string>): TrimLimits {
	const F = flicksPerFrame(rateOf(seq));
	const step = F * c.speed.rate;
	const eps = 1e-6;
	let min = Number.NEGATIVE_INFINITY;
	let max = Number.POSITIVE_INFINITY;
	const dur = (c as { mediaId?: string }).mediaId ? (doc.media[(c as { mediaId: string }).mediaId]?.probe.durationFlicks ?? null) : null;
	const bounded = isBoundedContent(c as Clip) && dur !== null;
	const others = trackClips(seq, c.trackId).filter((x) => x.id !== c.id && !members.has(x.id));
	if (edge === 'in') {
		max = Math.min(max, c.duration - 1);
		if (!ripple) {
			min = Math.max(min, -c.start);
			const prevEnd = Math.max(0, ...others.filter((x) => end(x) <= c.start).map(end));
			min = Math.max(min, prevEnd - c.start);
		}
		if (!c.speed.reverse) min = Math.max(min, -Math.floor(c.sourceIn / step + eps));
		else if (bounded) min = Math.max(min, -(Math.floor((dur! - c.sourceIn) / step + eps) - c.duration));
	} else {
		min = Math.max(min, 1 - c.duration);
		if (!ripple) {
			const nextStart = Math.min(Number.POSITIVE_INFINITY, ...others.filter((x) => x.start >= end(c)).map((x) => x.start));
			max = Math.min(max, nextStart - end(c));
		}
		if (!c.speed.reverse && bounded) max = Math.min(max, Math.floor((dur! - c.sourceIn) / step + eps) - c.duration);
		else if (c.speed.reverse) max = Math.min(max, Math.floor(c.sourceIn / step + eps));
	}
	return { min, max };
}

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
			members.push(p);
		}
	}
	const memberIds = new Set(members.map((m) => m.id));
	const ripple = mode === 'ripple';
	let d = cmd.deltaFrames;
	const lim = members.map((m) => trimLimits(doc, seq, m, cmd.edge, ripple, memberIds));
	const lo = Math.max(...lim.map((l) => l.min));
	const hi = Math.min(...lim.map((l) => l.max));
	const clamped = Math.min(hi, Math.max(lo, d));
	if (clamped !== d) {
		h.warn('W_DURATION_CLAMPED', `Trim clamped from ${d} to ${clamped} frames`);
		d = clamped;
	}
	if (d === 0) return { deltaFrames: 0 };

	if (!ripple) {
		for (const m of members) {
			if (cmd.edge === 'in') setClipRange(seq, m, m.start + d, end(m));
			else setClipRange(seq, m, m.start, end(m) + d);
		}
		cleanupSequence(seq, h);
		return { deltaFrames: d };
	}

	// Ripple: the edited clip's duration changes by `shift`; later material moves with it.
	const shift = cmd.edge === 'in' ? -d : d;
	const oldEnd = end(clip);
	const edited = new Set(members.map((m) => m.trackId));
	const followers = syncFollowerTracks(seq, edited).map((t) => t.id);
	let n = Math.abs(shift);
	const removalStart = () => (cmd.edge === 'in' ? clip.start : oldEnd - n);
	if (shift < 0) {
		const blocking = followers.flatMap((t) => contentInRange(seq, t, removalStart(), n).map((c) => c.id));
		if (blocking.length > 0) {
			if (!cmd.clampToSyncLock) {
				h.fail('E_SYNC_CONFLICT', 'Sync-locked tracks have content in the trimmed range', { blocking });
			}
			// Gesture behaviour: stop at the largest amount every sync-locked track allows (S02:TL-543).
			let allowed = n;
			for (const t of followers) {
				for (const c of trackClips(seq, t)) {
					if (cmd.edge === 'in') {
						if (end(c) > clip.start) allowed = Math.min(allowed, Math.max(0, c.start - clip.start));
					} else if (c.start < oldEnd) allowed = Math.min(allowed, Math.max(0, oldEnd - end(c)));
				}
			}
			h.warn('W_DURATION_CLAMPED', `Ripple trim stopped at ${allowed} of ${n} frames by sync-locked tracks`);
			n = allowed;
			d = cmd.edge === 'in' ? n : -n;
			if (n === 0) return { deltaFrames: 0 };
		}
	}
	const signed = shift < 0 ? -n : n;
	// Later clips on the edited tracks.
	for (const m of members) {
		const mEnd = end(m);
		for (const c of trackClips(seq, m.trackId)) if (!memberIds.has(c.id) && c.start >= mEnd) c.start += signed;
	}
	for (const m of members) {
		if (cmd.edge === 'in') {
			// Premiere keeps the clip's start; the head content changes (S02:TL-540).
			const s = m.start;
			setClipRange(seq, m, s + d, end(m));
			m.start = s;
		} else setClipRange(seq, m, m.start, end(m) + d);
	}
	if (signed > 0) {
		const at = cmd.edge === 'in' ? clip.start : oldEnd;
		relinkSplits(seq, insertShift(seq, followers, at, n, h), h);
		if (cmd.rippleMarkers !== false) shiftMarkers(seq, at, n);
	} else {
		const f = cmd.edge === 'in' ? clip.start : oldEnd - n;
		removeShift(seq, followers, f, n, h);
		if (cmd.rippleMarkers !== false) shiftMarkers(seq, f, -n);
	}
	cleanupSequence(seq, h);
	return { deltaFrames: d };
}

// ---------------------------------------------------------------- handlers

export const clipCoreHandlers: HandlerMap = {
	'clip.place': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const asset = 'mediaId' in cmd.source ? (doc.media[cmd.source.mediaId] as MediaAsset | undefined) : undefined;
		const range = cmd.sourceRange
			? { in: h.flicks(cmd.sourceRange.in, asset, rateOf(seq)), out: h.flicks(cmd.sourceRange.out, asset, rateOf(seq)) }
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
		});
	},
	'clip.addText': (doc, cmd, h: HandlerContext) => {
		const fontId = cmd.content.style?.fontId ?? ensureDefaultFont(doc, h);
		if (!doc.fonts[fontId]) h.fail('E_NOT_FOUND', `Font not found: ${fontId}`);
		const style: TextStyle = { ...defaultTextStyle(fontId), ...(cmd.content.style ?? {}), fontId } as TextStyle;
		const content: TextContent = { text: cmd.content.text, style, ...(cmd.content.runs ? { runs: cmd.content.runs as TextContent['runs'] } : {}) };
		const { seq, track, at, duration, id } = newGeneratorClip(doc, cmd, h, 'text');
		const est = estimateTextBox(content, seq.settings.width);
		const box: TextBox = { width: cmd.box?.width ?? est.width, height: cmd.box?.height ?? est.height, autoSize: cmd.box?.autoSize ?? 'width' };
		const transform = applyTransformPatch(defaultTransform(box, frameBox(seq), 'none'), cmd.transform);
		const name = cmd.name ?? (cmd.content.text.split('\n')[0]!.slice(0, 40) || 'Text');
		seq.clips[id] = {
			...commonFields(h, id, track.id, at, duration, 0, name, 'lavender'),
			kind: 'text',
			content,
			box,
			...visualFields(transform),
		} as DClip;
		const clip = seq.clips[id] as Draft<Extract<Clip, { kind: 'text' }>>;
		layoutText(clip, h, seq.settings.width);
		if (!cmd.transform?.anchor) clip.transform.anchor.value = [clip.box.width / 2, clip.box.height / 2];
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, id);
		return { clipId: id };
	},
	'clip.addSolid': (doc, cmd, h: HandlerContext) => {
		const { seq, track, at, duration, id } = newGeneratorClip(doc, cmd, h, 'solid');
		const synId = h.ids.next('syn');
		doc.synthetics[synId] = { id: synId, kind: 'color-matte', color: [...cmd.color] };
		seq.clips[id] = {
			...commonFields(h, id, track.id, at, duration, 0, cmd.name ?? 'Color Matte', 'tan'),
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
		if (!info) h.fail('E_INVALID_PARAM', `Unknown motion-graphic template ${cmd.template.id}@${cmd.template.version}`);
		const params = validateMgParams(info, { ...info.defaults, ...(cmd.params ?? {}) }, h);
		const { seq, track, at, duration, id } = newGeneratorClip(doc, cmd, h, 'motion-graphic');
		const canvas = cmd.canvas ?? (info.canvasDefault === 'sequence' ? 'sequence' : { ...info.canvasDefault });
		const box = canvas === 'sequence' ? frameBox(seq) : canvas;
		seq.clips[id] = {
			...commonFields(h, id, track.id, at, duration, 0, cmd.name ?? info.name, 'purple'),
			kind: 'motion-graphic',
			template: { id: info.id, version: info.version },
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
		const { seq, clips } = h.clipsOf(doc, ids);
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
			for (const p of plan) relinkSplits(seq, clearRange(seq, p.dest.id, p.start, p.end, h, moving), h);
		} else {
			const at = Math.min(...plan.map((p) => p.start));
			const n = Math.max(...plan.map((p) => p.end)) - at;
			const edited = new Set(plan.map((p) => p.dest.id));
			const tracks = [...edited, ...syncFollowerTracks(seq, edited).map((t) => t.id)];
			relinkSplits(seq, insertShiftExcept(seq, tracks, at, n, h, moving), h);
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
		const given = [cmd.clipIds !== undefined, cmd.tracks !== undefined, cmd.scope !== undefined].filter(Boolean).length;
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
		for (const c of set.values()) splits.push({ originalLinkId: c.linkId, rightId: splitClipAt(seq, c, at, h).id });
		relinkSplits(seq, splits, h);
		cleanupSequence(seq, h);
		return { left: [...set.keys()], right: splits.map((s) => s.rightId) };
	},
	'clip.lift': (doc, cmd, h: HandlerContext) => {
		const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
		for (const c of clips) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		for (const c of clips) removeClip(seq, c.id, h);
		cleanupSequence(seq, h);
		return { removed: clips.map((c) => c.id) };
	},
	'clip.extract': (doc, cmd, h: HandlerContext) => {
		const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
		for (const c of clips) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		const spans = clips.map((c) => ({ start: c.start, end: end(c), track: c.trackId })).sort((a, b) => a.start - b.start);
		const ranges: { start: number; end: number; tracks: Set<string> }[] = [];
		for (const s of spans) {
			const last = ranges[ranges.length - 1];
			if (last && s.start <= last.end) {
				last.end = Math.max(last.end, s.end);
				last.tracks.add(s.track);
			} else ranges.push({ start: s.start, end: s.end, tracks: new Set([s.track]) });
		}
		for (const c of clips) removeClip(seq, c.id, h);
		const followers = allTracksIn(seq).filter((t) => t.syncLock && !t.locked).map((t) => t.id);
		for (const r of [...ranges].reverse()) {
			const tracks = new Set([...r.tracks, ...followers]);
			removeShift(seq, tracks, r.start, r.end - r.start, h, { syncConflict: cmd.syncConflict });
			if (cmd.rippleMarkers !== false) shiftMarkers(seq, r.start, -(r.end - r.start));
		}
		cleanupSequence(seq, h);
		return { removed: clips.map((c) => c.id), ranges: ranges.map((r) => ({ start: r.start, end: r.end })) };
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

function applyClipPatch(doc: DDoc, seq: DSeq, clip: DClip, p: ClipPatch, h: HandlerContext): void {
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
		if (!doc.fonts[t.content.style.fontId]) h.fail('E_NOT_FOUND', `Font not found: ${t.content.style.fontId}`);
		if (p.box) Object.assign(t.box, p.box);
		layoutText(t, h, seq.settings.width);
	}
	if (p.params !== undefined || p.canvas !== undefined) {
		need(clip.kind === 'motion-graphic', p.params ? 'params' : 'canvas');
		const mg = clip as Draft<Extract<Clip, { kind: 'motion-graphic' }>>;
		if (p.params !== undefined) {
			const info = h.registries.mgTemplates.get(mg.template.id, mg.template.version);
			if (!info) h.fail('E_INVALID_PARAM', `Unknown motion-graphic template ${mg.template.id}@${mg.template.version}`);
			mg.params = validateMgParams(info, { ...(mg.params as Record<string, unknown>), ...p.params }, h) as never;
		}
		if (p.canvas !== undefined) mg.canvas = p.canvas as never;
	}
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
		need(clip.kind === 'audio' || clip.kind === 'nest-audio', 'gainDb');
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
	void scaleForMode;
}

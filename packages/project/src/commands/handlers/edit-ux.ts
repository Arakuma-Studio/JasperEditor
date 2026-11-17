// Three-point rules (Premiere Pro, "Three-point and four-point editing", helpx.adobe.com):
// - any three of source In, source Out, sequence In, sequence Out define the edit; the sequence In point wins
//   over the playhead; with no sequence marks the edit goes at the playhead;
// - with only a sequence Out (or a source Out and a sequence range), the edit is **backtimed**: it ends there;
// - with four points of different durations the Fit Clip choice decides: change the clip speed (fit to fill),
//   or ignore one of the four points.
// Split edits (Mark Split ▸ Video/Audio In/Out) give the picture and the sound different source ranges: each
// channel lands offset by the difference of its In from the earliest In (FilmCraft `split_source_ranges` /
// `edit_at_source`, MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors).

import type { Draft } from 'immer';
import { mediaDurationFlicks } from '../../interpret/model.ts';
import { kindCapabilities } from '../../registry/kinds.ts';
import type { ProjectDocument, ProjectItem, SourceMarks, SubclipItem } from '../../schema/document.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { Sequence } from '../../schema/sequence.ts';
import { wouldCreateNestCycle } from '../../structure/nest.ts';
import { syntheticDefaultFlicks } from '../../structure/synthetic.ts';
import { contentSpanFlicks, FRAME_EPS, flicksPerFrame, type Rational } from '../../time.ts';
import type { DClip, DDoc, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, end, findTrackIn, setClipRange } from '../placement.ts';
import { contentWindow, rippleTrimGroup, trimClampMessage, trimLimits } from '../ripple.ts';
import type { CommandOf } from '../schemas/index.ts';
import { holesBefore, warnNewHoles } from '../uncovered-guard.ts';
import { placeSource } from './clip-core.ts';
import { rollRange, rollTrim } from './clip-edit.ts';
import { insertItem, parentBinOf } from './project-items.ts';
import type { HandlerMap } from './util.ts';

const FALLBACK_RATE: Rational = { num: 30, den: 1 };

type Source =
	| {
			kind: 'media';
			item: ProjectItem | null;
			mediaId: string;
			asset: MediaAsset;
			subclip: SubclipItem | null;
			marks: SourceMarks | null;
			/** Content window in flicks (null end = unbounded, e.g. stills). */
			window: { start: number; end: number | null };
	  }
	| { kind: 'synthetic'; item: ProjectItem | null; syntheticId: string; marks: SourceMarks | null }
	| { kind: 'sequence'; item: ProjectItem | null; sequence: Draft<Sequence> };

function resolveSource(doc: DDoc, s: CommandOf<'clip.sourceEdit'>['source'], h: HandlerContext): Source {
	let item: ProjectItem | null = null;
	let mediaId: string | undefined;
	let syntheticId: string | undefined;
	let sequenceId: string | undefined;
	let subclip: SubclipItem | null = null;
	if ('projectItemId' in s) {
		item = (doc.items[s.projectItemId] as ProjectItem | undefined) ?? null;
		if (!item) h.fail('E_NOT_FOUND', `Project item not found: ${s.projectItemId}`);
		if (item.kind === 'media') mediaId = item.mediaId;
		else if (item.kind === 'subclip') {
			mediaId = item.mediaId;
			subclip = item;
		} else if (item.kind === 'synthetic') syntheticId = item.syntheticId;
		else if (item.kind === 'sequence') sequenceId = item.sequenceId;
		else h.fail('E_INVALID_PARAM', `A ${item.kind} item cannot be edited into a sequence`);
	} else if ('mediaId' in s) mediaId = s.mediaId;
	else sequenceId = s.sequenceId;
	if (mediaId) {
		const asset = doc.media[mediaId] as MediaAsset | undefined;
		if (!asset) return h.fail('E_NOT_FOUND', `Media not found: ${mediaId}`);
		const bounded = asset.kind === 'video' || asset.kind === 'audio' || !!asset.lottie;
		const dur = mediaDurationFlicks(asset);
		const window = {
			start: subclip ? subclip.range.in : 0,
			end: subclip ? subclip.range.out : bounded && dur !== null ? dur : null,
		};
		const marks =
			item && (item.kind === 'media' || item.kind === 'subclip') ? (item.marks as SourceMarks) : null;
		return { kind: 'media', item, mediaId, asset, subclip, marks, window };
	}
	if (syntheticId) {
		if (!doc.synthetics[syntheticId]) h.fail('E_NOT_FOUND', `Synthetic source not found: ${syntheticId}`);
		const marks = item?.kind === 'synthetic' ? (item.marks as SourceMarks) : null;
		return { kind: 'synthetic', item, syntheticId, marks };
	}
	const sequence = doc.sequences[sequenceId!];
	if (!sequence) return h.fail('E_NOT_FOUND', `Sequence not found: ${sequenceId}`);
	if (!item)
		item = (Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === sequenceId) ??
			null) as ProjectItem | null;
	return { kind: 'sequence', item, sequence };
}

/** Frames of a sequence's content (last clip end). */
function sequenceFrames(seq: Pick<Sequence, 'clips'>): number {
	let n = 0;
	for (const c of Object.values(seq.clips)) n = Math.max(n, c.start + c.duration);
	return n;
}

export type PointResolution = {
	/** Sequence frame where the edit starts. */
	at: number;
	/** Content In (flicks) of the union source range after resolution. */
	in: number;
	/** Sequence frames of the edit. */
	frames: number;
	/** Clip speed (1 unless fit to fill). */
	rate: number;
};

/**
 * Resolves the edit from source marks (`sIn`/`sOut`, content flicks, Out exclusive), sequence marks (frames, Out
 * exclusive) and the playhead. `F` = flicks per sequence frame; `defaultLen` = flicks used when a source with no
 * Out has no end (stills, generators).
 */
export function resolveThreePoint(
	p: {
		sIn: number | null;
		sOut: number | null;
		seqIn: number | null;
		seqOut: number | null;
		playhead: number;
		window: { start: number; end: number | null };
		defaultLen: number;
		F: number;
		fit?: CommandOf<'clip.sourceEdit'>['fit'];
		/** Unbounded sources (stills, generators) take whatever duration the sequence asks for. */
		elastic: boolean;
	},
	h: HandlerContext,
): PointResolution {
	const { F, window: w } = p;
	const frames = (a: number, b: number) => Math.max(0, Math.floor((b - a) / F + FRAME_EPS));
	const needEnd = (inF: number, n: number) => {
		if (w.end !== null && inF + n * F > w.end + 1)
			h.fail('E_OUT_OF_MEDIA', 'Not enough source media after the source In for this edit');
	};
	const needStart = (inF: number) => {
		if (inF < w.start - 1)
			h.fail('E_OUT_OF_MEDIA', 'Not enough source media before the source Out for this edit');
	};
	const srcIn = p.sIn ?? (p.sOut !== null ? null : w.start);
	const srcOut = p.sOut ?? (w.end !== null ? w.end : srcIn !== null ? srcIn + p.defaultLen : null);
	if (p.seqIn !== null && p.seqOut !== null) {
		const D = p.seqOut - p.seqIn;
		if (D < 1) h.fail('E_INVALID_PARAM', 'The sequence Out must be after the sequence In');
		if (p.elastic) return { at: p.seqIn, in: p.sIn ?? w.start, frames: D, rate: 1 };
		if (p.sIn !== null && p.sOut !== null) {
			const L = frames(p.sIn, p.sOut);
			if (L < 1) h.fail('E_INVALID_PARAM', 'The source Out must be after the source In');
			if (L === D) return { at: p.seqIn, in: p.sIn, frames: D, rate: 1 };
			switch (p.fit) {
				case 'change-speed': {
					const rate = (p.sOut - p.sIn) / (D * F);
					if (rate < 0.01 || rate > 100)
						h.fail(
							'E_INVALID_PARAM',
							`Fit to fill needs a speed of ${Math.round(rate * 10000) / 100}% (1%–10000%)`,
						);
					return { at: p.seqIn, in: p.sIn, frames: D, rate };
				}
				case 'ignore-source-in': {
					const inF = p.sOut - D * F;
					needStart(inF);
					return { at: p.seqIn, in: Math.max(w.start, Math.round(inF)), frames: D, rate: 1 };
				}
				case 'ignore-source-out':
					needEnd(p.sIn, D);
					return { at: p.seqIn, in: p.sIn, frames: D, rate: 1 };
				case 'ignore-sequence-in': {
					const at = p.seqOut - L;
					if (at < 0) h.fail('E_INVALID_PARAM', 'The backtimed edit would start before the sequence start');
					return { at, in: p.sIn, frames: L, rate: 1 };
				}
				case 'ignore-sequence-out':
					return { at: p.seqIn, in: p.sIn, frames: L, rate: 1 };
				default:
					return h.fail(
						'E_INVALID_PARAM',
						`Four-point edit: the source (${L} frames) and sequence (${D} frames) durations differ; pass fit: change-speed, ignore-source-in, ignore-source-out, ignore-sequence-in or ignore-sequence-out`,
						{ path: ['fit'] },
					);
			}
		}
		if (p.sOut !== null) {
			// Backtimed source: the source In is computed from the source Out.
			const inF = p.sOut - D * F;
			needStart(inF);
			return { at: p.seqIn, in: Math.max(w.start, Math.round(inF)), frames: D, rate: 1 };
		}
		const inF = p.sIn ?? w.start;
		needEnd(inF, D);
		return { at: p.seqIn, in: inF, frames: D, rate: 1 };
	}
	const inF = srcIn !== null ? srcIn : srcOut! - p.defaultLen;
	if (inF < w.start - 1) h.fail('E_OUT_OF_MEDIA', 'Source range starts before the media');
	const L = frames(Math.max(w.start, inF), srcOut!);
	if (L < 1) h.fail('E_INVALID_PARAM', 'The source Out must be after the source In');
	const startIn = Math.max(w.start, inF);
	if (p.seqIn !== null) return { at: p.seqIn, in: startIn, frames: L, rate: 1 };
	if (p.seqOut !== null) {
		// Backtiming: the edit ends at the sequence Out.
		const at = p.seqOut - L;
		if (at < 0) h.fail('E_INVALID_PARAM', 'The backtimed edit would start before the sequence start');
		return { at, in: startIn, frames: L, rate: 1 };
	}
	return { at: Math.max(0, p.playhead), in: startIn, frames: L, rate: 1 };
}

type Channel = { in: number; offset: number; frames: number };

/** Per-channel placement of a split edit inside the resolved union range. */
function channelOf(
	range: { in: number; out: number },
	union: { in: number },
	r: PointResolution,
	F: number,
): Channel {
	const step = F * r.rate;
	const shift = r.in - union.in;
	const len = r.frames * step;
	const a = Math.max(r.in, range.in + shift);
	const b = Math.min(r.in + len, range.out + shift);
	return {
		in: Math.round(a),
		offset: Math.round((a - r.in) / step),
		frames: Math.max(0, Math.floor((b - a) / step + FRAME_EPS)),
	};
}

function sourceEditHandler(doc: DDoc, cmd: CommandOf<'clip.sourceEdit'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const src = resolveSource(doc, cmd.source, h);
	const mode = cmd.mode ?? 'overwrite';
	const stillFrames = Math.max(
		1,
		Math.round((doc.settings.defaultStillDurationFrames * rate.num) / (rate.den * 30)),
	);
	// Source marks and window, in content flicks.
	const asset = src.kind === 'media' ? src.asset : null;
	// a still is placed in sequence frames: its source frames are too.
	const convRate = asset?.kind === 'image' ? rate : FALLBACK_RATE;
	const conv = (v: Parameters<typeof h.flicks>[0]) => h.flicks(v, asset, convRate);
	let marks: { in: number | null; out: number | null } = { in: null, out: null };
	let window: { start: number; end: number | null } = { start: 0, end: null };
	let splitMarks: SourceMarks['split'] | undefined;
	let srcRate = rate;
	if (src.kind === 'media' || src.kind === 'synthetic') {
		marks = { in: src.marks?.in?.flicks ?? null, out: src.marks?.out?.flicks ?? null };
		splitMarks = src.marks?.split;
		if (src.kind === 'media') window = src.window;
	} else {
		srcRate = src.sequence.settings.frameRate as Rational;
		const Fs = flicksPerFrame(srcRate);
		marks = {
			in: src.sequence.inPoint !== null ? src.sequence.inPoint * Fs : null,
			out: src.sequence.outPoint !== null ? src.sequence.outPoint * Fs : null,
		};
		window = { start: 0, end: sequenceFrames(src.sequence) * Fs };
		if (window.end === 0) h.fail('E_INVALID_PARAM', 'The source sequence is empty');
		if (wouldCreateNestCycle(doc as Pick<ProjectDocument, 'sequences'>, seq.id, src.sequence.id))
			h.fail('E_CYCLE', 'A sequence cannot contain itself (directly or through nested sequences)');
	}
	const sIn = cmd.sourceIn === null ? null : cmd.sourceIn !== undefined ? conv(cmd.sourceIn) : marks.in;
	const sOut = cmd.sourceOut === null ? null : cmd.sourceOut !== undefined ? conv(cmd.sourceOut) : marks.out;
	const seqIn =
		cmd.sequenceIn === null
			? null
			: cmd.sequenceIn !== undefined
				? h.frame(seq, cmd.sequenceIn)
				: seq.inPoint;
	const seqOut =
		cmd.sequenceOut === null
			? null
			: cmd.sequenceOut !== undefined
				? h.frame(seq, cmd.sequenceOut)
				: seq.outPoint;
	const playhead = cmd.playhead !== undefined ? h.frame(seq, cmd.playhead) : 0;
	// Split edit: channel ranges, their union drives the three-point resolution.
	const pick = (v: { flicks: number } | null | undefined) => (v ? v.flicks : null);
	const splitIn = {
		video:
			cmd.split?.video?.in !== undefined ? conv(cmd.split.video.in) : (pick(splitMarks?.videoIn) ?? null),
		audio:
			cmd.split?.audio?.in !== undefined ? conv(cmd.split.audio.in) : (pick(splitMarks?.audioIn) ?? null),
	};
	const splitOut = {
		video:
			cmd.split?.video?.out !== undefined ? conv(cmd.split.video.out) : (pick(splitMarks?.videoOut) ?? null),
		audio:
			cmd.split?.audio?.out !== undefined ? conv(cmd.split.audio.out) : (pick(splitMarks?.audioOut) ?? null),
	};
	const isSplit =
		src.kind !== 'synthetic' &&
		[splitIn.video, splitIn.audio, splitOut.video, splitOut.audio].some((v) => v !== null);
	const elastic = window.end === null;
	let unionIn = sIn;
	let unionOut = sOut;
	let channels: { video: { in: number; out: number }; audio: { in: number; out: number } } | null = null;
	if (isSplit) {
		const baseIn = sIn ?? window.start;
		const baseOut = sOut ?? window.end ?? baseIn + stillFrames * F;
		channels = {
			video: { in: splitIn.video ?? baseIn, out: splitOut.video ?? baseOut },
			audio: { in: splitIn.audio ?? baseIn, out: splitOut.audio ?? baseOut },
		};
		for (const c of [channels.video, channels.audio])
			if (c.out <= c.in) h.fail('E_INVALID_PARAM', 'A split mark Out must be after its In');
		unionIn = Math.min(channels.video.in, channels.audio.in);
		unionOut = Math.max(channels.video.out, channels.audio.out);
	}
	const r = resolveThreePoint(
		{
			sIn: unionIn,
			sOut: unionOut,
			seqIn,
			seqOut,
			playhead,
			window,
			defaultLen:
				src.kind === 'synthetic' && doc.synthetics[src.syntheticId]
					? syntheticDefaultFlicks(doc.synthetics[src.syntheticId]!.kind, stillFrames * F)
					: stillFrames * F,
			F,
			fit: cmd.fit,
			elastic,
		},
		h,
	);
	if (r.rate !== 1 && src.kind === 'sequence' && cmd.sequenceAs === 'clips')
		h.fail('E_INVALID_PARAM', 'Change Clip Speed does not apply to a sequence edited in as individual clips');
	const union = { in: unionIn ?? r.in };
	const full: Channel = { in: r.in, offset: 0, frames: r.frames };
	const ch = channels
		? { video: channelOf(channels.video, union, r, F), audio: channelOf(channels.audio, union, r, F) }
		: { video: full, audio: full };
	const patchV = cmd.patch?.video;
	const patchA = cmd.patch?.audio;
	let result: { clipIds: string[] };
	if (src.kind === 'media' || src.kind === 'synthetic') {
		const videoRef = patchV?.[0];
		const audioRefs = patchA;
		const out = placeSource(doc, seq, h, {
			source: src.item
				? { projectItemId: src.item.id }
				: src.kind === 'media'
					? { mediaId: src.mediaId }
					: { syntheticId: src.syntheticId },
			at: r.at,
			mode,
			videoTrack: videoRef ?? undefined,
			audioTracks: audioRefs,
			video: videoRef === null ? false : undefined,
			audio: audioRefs && audioRefs.length > 0 && audioRefs.every((x) => x === null) ? false : undefined,
			createTracks: true,
			rippleMarkers: cmd.rippleMarkers,
			ref: cmd.ref,
			fitted: { rate: r.rate, video: ch.video, audio: ch.audio },
		});
		result = out;
	} else {
		// Sequences go in through edit-structure's placement (nests, or individual clips; multi-camera sources as
		// multi-camera clips). Fit to fill sets the nest clips' speed over the resolved length.
		const videoRef = patchV?.[0];
		const audioRefs = patchA?.filter((x): x is string => x !== null);
		const out = placeSource(doc, seq, h, {
			source: src.item ? { projectItemId: src.item.id } : { sequenceId: src.sequence.id },
			sourceRange: { in: r.in, out: Math.round(r.in + r.frames * F) },
			at: r.at,
			mode,
			videoTrack: videoRef ?? undefined,
			...(audioRefs?.length ? { audioTracks: audioRefs } : {}),
			video: videoRef === null ? false : undefined,
			audio: patchA && patchA.length > 0 && patchA.every((x) => x === null) ? false : undefined,
			nest: (cmd.sequenceAs ?? 'nest') === 'nest',
			createTracks: true,
			rippleMarkers: cmd.rippleMarkers,
			ref: cmd.ref,
		});
		if (r.rate !== 1)
			for (const id of out.clipIds) {
				const c = seq.clips[id];
				if (c && kindCapabilities(c.kind)?.supportsSpeed) c.speed.rate = r.rate;
			}
		result = out;
	}
	cleanupSequence(seq, h);
	const placed = result.clipIds.map((id) => seq.clips[id]).filter((c): c is DClip => !!c);
	const endFrame = placed.length ? Math.max(...placed.map((c) => end(c))) : r.at + r.frames;
	return {
		clipIds: result.clipIds,
		at: r.at,
		frames: r.frames,
		rate: r.rate,
		sourceRange: { in: r.in, out: Math.round(r.in + contentSpanFlicks(r.frames, rate, r.rate)) },
		end: endFrame,
	};
}

function trimEditsHandler(doc: DDoc, cmd: CommandOf<'clip.trimEdits'>, h: HandlerContext) {
	const linked = cmd.linked !== false;
	const first = h.clip(doc, cmd.edits[0]!.clipId);
	const seq = first.seq;
	const edits = cmd.edits.map((e) => {
		const c = seq.clips[e.clipId];
		if (!c) return h.fail('E_NOT_FOUND', `Clip not found in this sequence: ${e.clipId}`);
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		return { ...e, clip: c };
	});
	const used = new Set<string>();
	for (const e of edits) {
		if (used.has(e.clip.trackId))
			h.fail('E_INVALID_PARAM', 'Select at most one edit point per track', { blocking: [e.clipId] });
		used.add(e.clip.trackId);
	}
	const holes = holesBefore(doc, seq);
	// Link partners of each edit point (Linked Selection), one per track: their same-side edge moves by the same delta
	// even when it is apart (a split edit keeps its offset), so no sound outgrows its picture.
	const ripple: { clip: DClip; edge: 'in' | 'out' }[] = [];
	const regular: { clip: DClip; edge: 'in' | 'out' }[] = [];
	const rolls: { clip: DClip; edge: 'in' | 'out' }[] = [];
	for (const e of edits) {
		const group = e.mode === 'ripple' ? ripple : e.mode === 'roll' ? rolls : regular;
		group.push({ clip: e.clip, edge: e.edge });
		if (!linked || e.mode === 'roll' || !e.clip.linkId) continue;
		for (const id of seq.links[e.clip.linkId]?.members ?? []) {
			const p = seq.clips[id];
			if (!p || p.id === e.clip.id || used.has(p.trackId)) continue;
			if (findTrackIn(seq, p.trackId)?.track.locked) continue;
			used.add(p.trackId);
			group.push({ clip: p, edge: e.edge });
		}
	}
	// Lockstep: every point moves by the most restrictive delta (S02:TL-536).
	const ids = new Set([...ripple, ...regular].map((m) => m.clip.id));
	let lo = Number.NEGATIVE_INFINITY;
	let hi = Number.POSITIVE_INFINITY;
	for (const m of regular) {
		const l = trimLimits(doc, seq, m.clip, m.edge, false, ids);
		lo = Math.max(lo, l.min);
		hi = Math.min(hi, l.max);
	}
	for (const m of ripple) {
		const l = trimLimits(doc, seq, m.clip, m.edge, true, ids);
		lo = Math.max(lo, l.min);
		hi = Math.min(hi, l.max);
	}
	// A roll's link partners roll with it, unless one of them is itself a selected edit point (it would roll twice).
	const selectedTracks = new Set(edits.map((e) => e.clip.trackId));
	const rollLinked = (m: { clip: DClip }) =>
		linked &&
		!(seq.links[m.clip.linkId ?? '']?.members ?? []).some(
			(id) => id !== m.clip.id && seq.clips[id] && selectedTracks.has(seq.clips[id]!.trackId),
		);
	for (const m of rolls) {
		const l = rollRange(doc, seq, m.clip, m.edge, rollLinked(m));
		lo = Math.max(lo, l.lo);
		hi = Math.min(hi, l.hi);
	}
	let d = lo > hi ? 0 : Math.min(hi, Math.max(lo, cmd.deltaFrames));
	if (d !== cmd.deltaFrames)
		h.warn('W_DURATION_CLAMPED', trimClampMessage(doc, seq, [...regular, ...ripple], cmd.deltaFrames, d));
	if (d === 0) return { deltaFrames: 0 };
	if (ripple.length)
		d = rippleTrimGroup(doc, seq, h, ripple, d, {
			clampToSyncLock: cmd.clampToSyncLock,
			rippleMarkers: cmd.rippleMarkers,
		});
	if (d !== 0) {
		for (const m of regular) {
			if (m.edge === 'in') setClipRange(seq, m.clip, m.clip.start + d, end(m.clip));
			else setClipRange(seq, m.clip, m.clip.start, end(m.clip) + d);
		}
		for (const m of rolls)
			rollTrim(
				doc,
				{
					type: 'clip.trim',
					clipId: m.clip.id,
					edge: m.edge,
					deltaFrames: d,
					mode: 'roll',
					linked: rollLinked(m),
				},
				h,
			);
	}
	cleanupSequence(seq, h);
	warnNewHoles(doc, seq, holes, h);
	return { deltaFrames: d };
}

function subclipSource(doc: DDoc, itemId: string, h: HandlerContext) {
	const it = doc.items[itemId] as ProjectItem | undefined;
	if (!it) return h.fail('E_NOT_FOUND', `Project item not found: ${itemId}`);
	if (it.kind !== 'media' && it.kind !== 'subclip')
		h.fail('E_INVALID_PARAM', 'Only media items and subclips can be subclipped');
	const asset = doc.media[it.mediaId] as MediaAsset | undefined;
	if (!asset) return h.fail('E_NOT_FOUND', `Media not found: ${it.mediaId}`);
	if (asset.kind !== 'video' && asset.kind !== 'audio' && asset.kind !== 'animated-image')
		h.fail('E_INVALID_PARAM', `A ${asset.kind} has no time range to subclip`);
	const dur = mediaDurationFlicks(asset);
	const bounds =
		it.kind === 'subclip'
			? { in: it.range.in, out: it.range.out }
			: { in: 0, out: dur ?? Number.POSITIVE_INFINITY };
	return { item: it, asset, bounds };
}

function checkRange(inF: number, outF: number, bounds: { in: number; out: number }, h: HandlerContext): void {
	if (outF <= inF) h.fail('E_INVALID_PARAM', "The subclip's end must be after its start");
	if (inF < bounds.in || outF > bounds.out + FALLBACK_TOL)
		h.fail('E_OUT_OF_MEDIA', 'The subclip range is outside its source');
}
const FALLBACK_TOL = flicksPerFrame(FALLBACK_RATE);

export const editUxHandlers = {
	'clip.sourceEdit': sourceEditHandler,
	'clip.trimEdits': trimEditsHandler,
	'item.makeSubclip': (doc, cmd, h: HandlerContext) => {
		const { item, asset, bounds } = subclipSource(doc, cmd.itemId, h);
		const inF = h.flicks(cmd.in, asset, FALLBACK_RATE);
		const outF = Math.min(h.flicks(cmd.out, asset, FALLBACK_RATE), bounds.out);
		checkRange(inF, outF, bounds, h);
		const id = h.newId(doc, 'itm', cmd.id);
		const parentItemId = item.kind === 'subclip' ? item.parentItemId : item.id;
		const base = item.kind === 'subclip' ? item.name : item.name.replace(/\.[^.]+$/, '');
		const sub: SubclipItem = {
			id,
			kind: 'subclip',
			name: cmd.name ?? `${base}.Subclip`,
			label: item.label,
			mediaId: item.mediaId,
			parentItemId,
			range: { in: inF, out: outF },
			restrictTrims: cmd.restrictTrims ?? false,
			marks: { in: null, out: null },
		};
		doc.items[id] = sub as Draft<ProjectItem>;
		const bin = cmd.binId !== undefined ? cmd.binId : parentBinOf(doc, item.id);
		if (bin && doc.items[bin]?.kind !== 'bin') h.fail('E_NOT_FOUND', `Bin not found: ${bin}`);
		insertItem(doc, id, bin, undefined);
		h.defineRef(cmd.ref, id);
		return { itemId: id, range: { in: inF, out: outF } };
	},
	'item.updateSubclip': (doc, cmd, h: HandlerContext) => {
		const it = doc.items[cmd.itemId] as Draft<ProjectItem> | undefined;
		if (!it) return h.fail('E_NOT_FOUND', `Project item not found: ${cmd.itemId}`);
		if (it.kind !== 'subclip') return h.fail('E_INVALID_PARAM', 'Not a subclip');
		const asset = doc.media[it.mediaId] as MediaAsset | undefined;
		if (!asset) return h.fail('E_NOT_FOUND', `Media not found: ${it.mediaId}`);
		const inF = cmd.in ? h.flicks(cmd.in, asset, FALLBACK_RATE) : it.range.in;
		const outF = cmd.out ? h.flicks(cmd.out, asset, FALLBACK_RATE) : it.range.out;
		checkRange(inF, outF, { in: 0, out: mediaDurationFlicks(asset) ?? Number.POSITIVE_INFINITY }, h);
		it.range = { in: inF, out: outF };
		if (cmd.restrictTrims !== undefined) it.restrictTrims = cmd.restrictTrims;
		// Marks outside the new range are dropped.
		const m = it.marks as SourceMarks;
		const inside = (v: { flicks: number } | null | undefined) => !!v && v.flicks >= inF && v.flicks <= outF;
		if (m.in && !inside(m.in)) m.in = null;
		if (m.out && !inside(m.out)) m.out = null;
		if (m.split)
			for (const k of ['videoIn', 'videoOut', 'audioIn', 'audioOut'] as const)
				if (m.split[k] && !inside(m.split[k])) m.split[k] = null;
		// Clips that restrict trims to it must still fit (Premiere refuses an edit that would cut them).
		if (it.restrictTrims)
			for (const seq of Object.values(doc.sequences))
				for (const c of Object.values(seq.clips)) {
					if (c.subclipId !== it.id) continue;
					const w = contentWindow(doc, c);
					const span = contentSpanFlicks(c.duration, seq.settings.frameRate as Rational, c.speed.rate);
					const lo = c.sourceIn;
					if (lo < w.start - 1 || (w.end !== null && lo + span > w.end + 1))
						h.fail('E_OUT_OF_MEDIA', `Clip ${c.id} uses frames outside the new subclip range`, {
							blocking: [c.id],
						});
				}
		return { itemId: it.id, range: { ...it.range } };
	},
} satisfies HandlerMap;

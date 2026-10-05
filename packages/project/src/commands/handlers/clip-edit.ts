// Advanced edit handlers owned by WP-2B (ARCHITECTURE §5.3): roll, slip, slide, speed, duplicate,
// link/unlink, fit to frame, range lift/extract and gap close (S01 §9, §16.2; S02 §11–§14).
//
// Conventions shared with the core handlers (clip-core.ts):
// - handlers are pure over Immer drafts and throw through `h.fail` (atomic transactions, S01:CMD-004);
// - content-time math goes through `contentSpanFlicks` / `setClipRange` so splits and trims stay exact;
// - keyframes live in content time, so none of these edits rewrite them (ARCHITECTURE §2.3);
// - locked tracks are never edited or shifted (ARCHITECTURE §2.3), sync-locked tracks follow ripples.

import { current, type Draft, isDraft } from 'immer';
import { type Box, scaleForMode } from '../../factories.ts';
import { mediaIntrinsicSize } from '../../process/rescale.ts';
import { contentDurationFlicks, isBoundedContent, kindCapabilities } from '../../registry/kinds.ts';
import type { Clip, Track } from '../../schema/sequence.ts';
import { contentSpanFlicks, FRAME_EPS, flicksPerFrame } from '../../time.ts';
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
	reidentifyClipChildren,
	relinkSplits,
	removeShift,
	resolveOrCreateTrack,
	type SplitRecord,
	setClipRange,
	setStatic,
	shiftMarkers,
	syncFollowerTracks,
	trackClips,
} from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { type HandlerMap, idList } from './util.ts';

type DTrack = Draft<Track>;

// ---------------------------------------------------------------- shared helpers

function trackOf(seq: DSeq, clip: DClip, h: HandlerContext): DTrack {
	const t = findTrackIn(seq, clip.trackId);
	if (!t) return h.fail('E_NOT_FOUND', `Track not found: ${clip.trackId}`);
	return t.track;
}

/**
 * Content handles of a clip in sequence frames (S01:CLP-005): `head` = how far the in edge can extend
 * to the left, `tail` = how far the out edge can extend to the right. Unbounded kinds have an infinite
 * tail but still cannot show content before content time 0.
 */
function contentRoom(doc: DDoc, seq: DSeq, c: DClip): { head: number; tail: number } {
	const step = flicksPerFrame(seq.settings.frameRate) * c.speed.rate;
	const dur = contentDurationFlicks(doc, c);
	const bounded = isBoundedContent(c as Clip) && dur !== null;
	const before = Math.max(0, Math.floor(c.sourceIn / step + FRAME_EPS));
	const after = bounded
		? Math.max(0, Math.floor((dur! - c.sourceIn) / step + FRAME_EPS) - c.duration)
		: Number.POSITIVE_INFINITY;
	return c.speed.reverse ? { head: after, tail: before } : { head: before, tail: after };
}

/** The clip on the same track ending exactly at `frame` (outgoing side of an edit point). */
function clipEndingAt(seq: DSeq, trackId: string, frame: number, except: string): DClip | undefined {
	return trackClips(seq, trackId).find((c) => c.id !== except && end(c) === frame);
}

/** The clip on the same track starting exactly at `frame` (incoming side of an edit point). */
function clipStartingAt(seq: DSeq, trackId: string, frame: number, except: string): DClip | undefined {
	return trackClips(seq, trackId).find((c) => c.id !== except && c.start === frame);
}

/** End of the last clip that ends at or before `frame` (0 when none): the left bound of a gap. */
function prevEnd(seq: DSeq, trackId: string, frame: number, except: ReadonlySet<string>): number {
	let best = 0;
	for (const c of trackClips(seq, trackId))
		if (!except.has(c.id) && end(c) <= frame) best = Math.max(best, end(c));
	return best;
}

/** Start of the first clip that starts at or after `frame` (Infinity when none). */
function nextStart(seq: DSeq, trackId: string, frame: number, except: ReadonlySet<string>): number {
	let best = Number.POSITIVE_INFINITY;
	for (const c of trackClips(seq, trackId))
		if (!except.has(c.id) && c.start >= frame) best = Math.min(best, c.start);
	return best;
}

/** Link partners of `clip` whose `pick` frame coincides and whose track is unlocked. */
function coincidentPartners(seq: DSeq, clip: DClip, pick: (c: DClip) => number): DClip[] {
	if (!clip.linkId || !seq.links[clip.linkId]) return [];
	const out: DClip[] = [];
	for (const id of seq.links[clip.linkId]!.members) {
		const p = seq.clips[id];
		if (!p || p.id === clip.id || pick(p) !== pick(clip) || findTrackIn(seq, p.trackId)?.track.locked)
			continue;
		out.push(p);
	}
	return out;
}

type Range = { lo: number; hi: number };
const OPEN: Range = { lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY };

function clampDelta(d: number, ranges: readonly Range[], h: HandlerContext, what: string): number {
	const lo = Math.max(...ranges.map((r) => r.lo));
	const hi = Math.min(...ranges.map((r) => r.hi));
	const clamped = lo > hi ? 0 : Math.min(hi, Math.max(lo, d));
	if (clamped !== d) h.warn('W_DURATION_CLAMPED', `${what} clamped from ${d} to ${clamped} frames`);
	return clamped;
}

function snapshotClip(c: DClip): Clip {
	const plain = isDraft(c) ? current(c) : c;
	return JSON.parse(JSON.stringify(plain)) as Clip;
}

// ---------------------------------------------------------------- roll (S02 §11.4, TL-545)

type RollPlan = { out: DClip | null; inc: DClip | null; edit: number; range: Range };

function planRoll(doc: DDoc, seq: DSeq, m: DClip, edge: 'in' | 'out'): RollPlan {
	const edit = edge === 'in' ? m.start : end(m);
	const out = edge === 'out' ? m : (clipEndingAt(seq, m.trackId, edit, m.id) ?? null);
	const inc = edge === 'in' ? m : (clipStartingAt(seq, m.trackId, edit, m.id) ?? null);
	const range = { ...OPEN };
	const self = new Set([m.id]);
	if (out) {
		range.lo = Math.max(range.lo, 1 - out.duration);
		range.hi = Math.min(range.hi, contentRoom(doc, seq, out).tail);
	} else {
		// Gap (or frame 0) on the outgoing side: the gap may shrink to nothing.
		range.lo = Math.max(range.lo, prevEnd(seq, m.trackId, edit, self) - edit);
	}
	if (inc) {
		range.hi = Math.min(range.hi, inc.duration - 1);
		range.lo = Math.max(range.lo, -contentRoom(doc, seq, inc).head);
	} else {
		const n = nextStart(seq, m.trackId, edit, self);
		if (Number.isFinite(n)) range.hi = Math.min(range.hi, n - edit);
	}
	return { out, inc, edit, range };
}

/** `clip.trim` with `mode: 'roll'` (S02:TL-545). Called by the core `clip.trim` handler. */
export function rollTrim(doc: DDoc, cmd: CommandOf<'clip.trim'>, h: HandlerContext): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	assertUnlocked(trackOf(seq, clip, h), h);
	const pick = (c: DClip) => (cmd.edge === 'in' ? c.start : end(c));
	const members = [clip, ...(cmd.linked === false ? [] : coincidentPartners(seq, clip, pick))];
	const plans = members.map((m) => planRoll(doc, seq, m, cmd.edge));
	const d = clampDelta(
		cmd.deltaFrames,
		plans.map((p) => p.range),
		h,
		'Roll',
	);
	if (d === 0) return { deltaFrames: 0 };
	for (const p of plans) {
		const next = p.edit + d;
		// Shrink first so the draft never needs both clips on the same frames.
		if (d > 0 && p.inc) setClipRange(seq, p.inc, next, end(p.inc));
		if (p.out) setClipRange(seq, p.out, p.out.start, next);
		if (d < 0 && p.inc) setClipRange(seq, p.inc, next, end(p.inc));
	}
	cleanupSequence(seq, h);
	return { deltaFrames: d };
}

// ---------------------------------------------------------------- slip (S02 §12.7, TL-625)

/** Kinds where slipping has a visible effect (media and time-based generators). */
function canSlip(c: DClip): boolean {
	const caps = kindCapabilities(c.kind);
	if (!caps) return false;
	return caps.bounded !== 'no' || c.kind === 'motion-graphic' || c.kind === 'composition';
}

function slipHandler(doc: DDoc, cmd: CommandOf<'clip.slip'>, h: HandlerContext): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	for (const c of clips) assertUnlocked(trackOf(seq, c, h), h);
	const movable = clips.filter(canSlip);
	for (const c of clips)
		if (!movable.includes(c)) h.warn('W_VALUE_CLAMPED', `Slip does not apply to ${c.kind} clip ${c.id}`);
	if (movable.length === 0) h.fail('E_INVALID_PARAM', 'None of the clips can be slipped');
	// Positive delta = drag right = earlier source material (Premiere, TL-625). Handles bound the delta.
	const d = clampDelta(
		cmd.deltaFrames,
		movable.map((c) => {
			const room = contentRoom(doc, seq, c);
			return { lo: -room.tail, hi: room.head };
		}),
		h,
		'Slip',
	);
	if (d === 0) return { deltaFrames: 0 };
	const r = seq.settings.frameRate;
	for (const c of movable) {
		const shift = contentSpanFlicks(d, r, c.speed.rate);
		c.sourceIn = Math.max(0, c.speed.reverse ? c.sourceIn + shift : c.sourceIn - shift);
	}
	return { deltaFrames: d, clipIds: movable.map((c) => c.id) };
}

// ---------------------------------------------------------------- slide (S02 §12.8, TL-630)

type SlidePlan = { clip: DClip; prev: DClip | null; next: DClip | null; range: Range };

function planSlide(doc: DDoc, seq: DSeq, b: DClip): SlidePlan {
	const self = new Set([b.id]);
	const prev = clipEndingAt(seq, b.trackId, b.start, b.id) ?? null;
	const next = clipStartingAt(seq, b.trackId, end(b), b.id) ?? null;
	const range = { ...OPEN };
	if (prev) {
		range.lo = Math.max(range.lo, 1 - prev.duration);
		range.hi = Math.min(range.hi, contentRoom(doc, seq, prev).tail);
	} else range.lo = Math.max(range.lo, prevEnd(seq, b.trackId, b.start, self) - b.start);
	if (next) {
		range.hi = Math.min(range.hi, next.duration - 1);
		range.lo = Math.max(range.lo, -contentRoom(doc, seq, next).head);
	} else {
		const n = nextStart(seq, b.trackId, end(b), self);
		if (Number.isFinite(n)) range.hi = Math.min(range.hi, n - end(b));
	}
	return { clip: b, prev, next, range };
}

function slideHandler(doc: DDoc, cmd: CommandOf<'clip.slide'>, h: HandlerContext): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	assertUnlocked(trackOf(seq, clip, h), h);
	// Linked partners that start with the clip slide with it (S02:TL-630).
	const members = [clip, ...coincidentPartners(seq, clip, (c) => c.start)];
	const plans = members.map((m) => planSlide(doc, seq, m));
	const d = clampDelta(
		cmd.deltaFrames,
		plans.map((p) => p.range),
		h,
		'Slide',
	);
	if (d === 0) return { deltaFrames: 0 };
	for (const p of plans) {
		const s = p.clip.start;
		if (p.next) setClipRange(seq, p.next, p.next.start + d, end(p.next));
		if (p.prev) setClipRange(seq, p.prev, p.prev.start, end(p.prev) + d);
		p.clip.start = s + d;
	}
	cleanupSequence(seq, h);
	return { deltaFrames: d, clipIds: members.map((m) => m.id) };
}

// ---------------------------------------------------------------- ripple helper (speed changes)

/**
 * Ripples the material after a clip whose end moved from `oldEnd` by `delta` frames: later clips on the
 * clip's track shift, and sync-locked unlocked tracks outside `edited` get the same insert/removal once
 * per (frame, delta) event (S01:TRK-006, S02:TL-543).
 */
function rippleAfterEnd(
	seq: DSeq,
	h: HandlerContext,
	clip: DClip,
	oldEnd: number,
	delta: number,
	edited: ReadonlySet<string>,
	done: Set<string>,
): void {
	if (delta === 0) return;
	for (const c of trackClips(seq, clip.trackId)) if (c.id !== clip.id && c.start >= oldEnd) c.start += delta;
	const key = `${oldEnd}:${delta}`;
	if (done.has(key)) return;
	done.add(key);
	const followers = syncFollowerTracks(seq, edited).map((t) => t.id);
	if (delta > 0) relinkSplits(seq, insertShift(seq, followers, oldEnd, delta, h), h);
	else removeShift(seq, followers, oldEnd + delta, -delta, h);
	shiftMarkers(seq, delta > 0 ? oldEnd : oldEnd + delta, delta);
}

// ---------------------------------------------------------------- speed (S01:CLP-008, S02:TL-615/685)

function setSpeedHandler(doc: DDoc, cmd: CommandOf<'clip.setSpeed'>, h: HandlerContext): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	if (
		cmd.rate === undefined &&
		cmd.duration === undefined &&
		cmd.reverse === undefined &&
		cmd.maintainPitch === undefined
	)
		h.fail('E_INVALID_PARAM', 'clip.setSpeed needs rate, duration, reverse or maintainPitch');
	const r = seq.settings.frameRate;
	const F = flicksPerFrame(r);
	const wantDuration = cmd.duration === undefined ? undefined : h.durationFrames(seq, cmd.duration);
	if (wantDuration !== undefined && wantDuration < 1)
		h.fail('E_INVALID_PARAM', 'Duration must be >= 1 frame');
	for (const c of clips) assertUnlocked(trackOf(seq, c, h), h);

	// Right to left per track, so a ripple never moves a clip that is processed later.
	const ordered = [...clips].sort((a, b) => b.start - a.start);
	const edited = new Set(clips.map((c) => c.trackId));
	const rippled = new Set<string>();
	const results: { clipId: string; rate: number; duration: number }[] = [];
	for (const c of ordered) {
		const caps = kindCapabilities(c.kind);
		const speedable = !!caps?.supportsSpeed;
		if (cmd.maintainPitch !== undefined) c.speed.maintainPitch = cmd.maintainPitch;
		if (cmd.reverse !== undefined) {
			if (speedable)
				c.speed.reverse = cmd.reverse; // flips the mapping only (S01:CLP-008)
			else if (cmd.reverse) h.warn('W_VALUE_CLAMPED', `${c.kind} clip ${c.id} cannot play reversed`);
		}
		const span = contentSpanFlicks(c.duration, r, c.speed.rate);
		let rate = c.speed.rate;
		let duration = c.duration;
		if (!speedable) {
			if (cmd.rate !== undefined && cmd.rate !== rate)
				h.warn('W_VALUE_CLAMPED', `${c.kind} clip ${c.id} has no speed; only its duration changes`);
			if (wantDuration !== undefined) duration = wantDuration;
		} else if (cmd.rate !== undefined && wantDuration !== undefined) {
			rate = cmd.rate;
			duration = wantDuration;
			const dur = contentDurationFlicks(doc, c);
			if (isBoundedContent(c as Clip) && dur !== null) {
				const need = c.sourceIn + contentSpanFlicks(duration, r, rate);
				if (need > dur + F * rate + 1)
					h.fail('E_OUT_OF_MEDIA', `Clip ${c.id} would run past the end of its media`, { blocking: [c.id] });
			}
		} else if (cmd.rate !== undefined) {
			rate = cmd.rate;
			duration = Math.max(1, Math.round(span / (F * rate)));
		} else if (wantDuration !== undefined) {
			duration = wantDuration;
			rate = span / (F * duration);
			if (rate < 0.01 || rate > 100) {
				rate = Math.min(100, Math.max(0.01, rate));
				duration = Math.max(1, Math.round(span / (F * rate)));
				h.warn('W_DURATION_CLAMPED', `Speed of clip ${c.id} clamped to ${Math.round(rate * 10000) / 100}%`);
			}
		}
		const oldEnd = end(c);
		if (!cmd.ripple && duration > c.duration) {
			// Premiere clamps to the free space and keeps the rate (S01:CLP-008, S02:TL-685).
			const n = nextStart(seq, c.trackId, oldEnd, new Set([c.id]));
			if (c.start + duration > n) {
				duration = n - c.start;
				h.warn('W_DURATION_CLAMPED', `Clip ${c.id} duration clamped to the next clip`);
			}
		}
		c.speed.rate = rate;
		c.duration = duration;
		if (cmd.ripple) rippleAfterEnd(seq, h, c, oldEnd, end(c) - oldEnd, edited, rippled);
		results.push({ clipId: c.id, rate, duration });
	}
	cleanupSequence(seq, h);
	return { clips: results.reverse() };
}

// ---------------------------------------------------------------- duplicate (S01 clip.duplicate, S02:TL-683)

function duplicateHandler(doc: DDoc, cmd: CommandOf<'clip.duplicate'>, h: HandlerContext): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	if (cmd.at !== undefined && cmd.deltaFrames !== undefined)
		h.fail('E_INVALID_PARAM', 'clip.duplicate takes `at` or `deltaFrames`, not both');
	const sources = clips.map((c) => {
		const t = findTrackIn(seq, c.trackId);
		if (!t) return h.fail('E_NOT_FOUND', `Track not found: ${c.trackId}`);
		return { copy: snapshotClip(c), kind: t.kind, index: t.index };
	});

	// Destination tracks: `tracks` names the destination of the lowest source track of each kind;
	// the other copies keep their relative track offsets (S02:TL-701 style).
	const minIndex = new Map<string, number>();
	for (const s of sources) minIndex.set(s.kind, Math.min(minIndex.get(s.kind) ?? s.index, s.index));
	const base = new Map<string, number>();
	for (const ref of cmd.tracks ?? []) {
		const t = resolveOrCreateTrack(seq, ref, h, true);
		const found = findTrackIn(seq, t.id)!;
		if (!base.has(found.kind)) base.set(found.kind, found.index);
	}
	const dest = sources.map((s) => {
		const b = base.get(s.kind);
		const idx = b === undefined ? s.index : b + (s.index - minIndex.get(s.kind)!);
		const t = ensureTrackAt(seq, s.kind, idx, h);
		assertUnlocked(t, h);
		assertKindFits(s.copy.kind, t, h);
		return t;
	});

	const minStart = Math.min(...sources.map((s) => s.copy.start));
	const maxEnd = Math.max(...sources.map((s) => end(s.copy)));
	let delta: number;
	if (cmd.deltaFrames !== undefined) delta = cmd.deltaFrames;
	else if (cmd.at !== undefined) delta = h.frame(seq, cmd.at) - minStart;
	else {
		// First position after the selection where the whole span is free on every destination track.
		let at = maxEnd;
		for (let guard = 0; guard < 10_000; guard++) {
			const d = at - minStart;
			let blockedUntil = -1;
			sources.forEach((s, i) => {
				const a = s.copy.start + d;
				const b = end(s.copy) + d;
				for (const c of trackClips(seq, dest[i]!.id))
					if (c.start < b && end(c) > a)
						blockedUntil = Math.max(blockedUntil, end(c) - (s.copy.start - minStart));
			});
			if (blockedUntil < 0) break;
			at = Math.max(at + 1, blockedUntil);
		}
		delta = at - minStart;
	}
	if (minStart + delta < 0) h.fail('E_INVALID_PARAM', 'Duplicates would start before frame 0');

	const splits: SplitRecord[] = [];
	sources.forEach((s, i) => {
		splits.push(...clearRange(seq, dest[i]!.id, s.copy.start + delta, end(s.copy) + delta, h));
	});
	relinkSplits(seq, splits, h);

	const map: Record<string, string> = {};
	const newLinks = new Map<string, string[]>();
	const newGroups = new Map<string, string[]>();
	sources.forEach((s, i) => {
		const copy = s.copy;
		const id = h.ids.next('clp');
		map[copy.id] = id;
		reidentifyClipChildren(copy, h);
		if (copy.linkId) newLinks.set(copy.linkId, [...(newLinks.get(copy.linkId) ?? []), id]);
		if (copy.groupId) newGroups.set(copy.groupId, [...(newGroups.get(copy.groupId) ?? []), id]);
		seq.clips[id] = {
			...copy,
			id,
			trackId: dest[i]!.id,
			start: copy.start + delta,
			linkId: null,
			groupId: null,
		} as DClip;
	});
	// Mirror link and clip groups among the copies (S01:CLB-012 remapping).
	for (const members of newLinks.values()) {
		if (members.length < 2) continue;
		const lid = h.ids.next('lnk');
		seq.links[lid] = { id: lid, members };
		for (const m of members) seq.clips[m]!.linkId = lid;
	}
	for (const members of newGroups.values()) {
		if (members.length < 2) continue;
		const gid = h.ids.next('grp');
		seq.groups[gid] = { id: gid, members };
		for (const m of members) seq.clips[m]!.groupId = gid;
	}
	cleanupSequence(seq, h);
	return { clipIds: Object.values(map), map, deltaFrames: delta };
}

// ---------------------------------------------------------------- link / unlink (S01:CLP-010, S02:TL-704)

function linkHandler(doc: DDoc, cmd: CommandOf<'clip.link'>, h: HandlerContext): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	if (clips.length < 2) h.fail('E_INVALID_PARAM', 'Link needs at least two clips');
	const tracks = new Set<string>();
	let videos = 0;
	for (const c of clips) {
		const t = trackOf(seq, c, h);
		assertUnlocked(t, h);
		if (tracks.has(t.id))
			h.fail('E_INVALID_PARAM', 'Link takes at most one clip per track', { blocking: [c.id] });
		tracks.add(t.id);
		if (t.kind === 'video') videos++;
	}
	if (videos > 1) h.fail('E_INVALID_PARAM', 'A link group can hold at most one video clip');
	for (const c of clips) {
		if (c.linkId && seq.links[c.linkId]) {
			const l = seq.links[c.linkId]!;
			l.members = l.members.filter((m) => m !== c.id);
		}
	}
	const linkId = h.ids.next('lnk');
	seq.links[linkId] = { id: linkId, members: clips.map((c) => c.id) };
	for (const c of clips) c.linkId = linkId;
	cleanupSequence(seq, h);
	return { linkId };
}

function unlinkHandler(doc: DDoc, cmd: CommandOf<'clip.unlink'>, h: HandlerContext): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	for (const c of clips) assertUnlocked(trackOf(seq, c, h), h);
	const dissolved: string[] = [];
	for (const c of clips) {
		const id = c.linkId;
		if (!id) continue;
		const l = seq.links[id];
		for (const m of l?.members ?? []) if (seq.clips[m]) seq.clips[m]!.linkId = null;
		c.linkId = null;
		if (l) {
			delete seq.links[id];
			dissolved.push(id);
		}
	}
	return { dissolved };
}

// ---------------------------------------------------------------- fit to frame (S01:FX-004)

function intrinsicBox(doc: DDoc, seq: DSeq, c: DClip): Box {
	const frame = { width: seq.settings.width, height: seq.settings.height };
	const r = c as Record<string, unknown>;
	if (typeof r.mediaId === 'string') {
		return mediaIntrinsicSize(doc.media[r.mediaId]) ?? frame;
	}
	if (c.kind === 'text') {
		const box = r.box as { width: number; height: number };
		return box.width > 0 && box.height > 0 ? { width: box.width, height: box.height } : frame;
	}
	const canvas = r.canvas as 'sequence' | { width: number; height: number } | undefined;
	if (canvas && canvas !== 'sequence') return { width: canvas.width, height: canvas.height };
	return frame;
}

function fitToFrameHandler(doc: DDoc, cmd: CommandOf<'clip.fitToFrame'>, h: HandlerContext): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const frame = { width: seq.settings.width, height: seq.settings.height };
	const changed: string[] = [];
	for (const c of clips) {
		if (!kindCapabilities(c.kind)?.hasTransform) continue;
		assertUnlocked(trackOf(seq, c, h), h);
		const t = (c as Draft<Extract<Clip, { kind: 'video' }>>).transform;
		const s = scaleForMode(intrinsicBox(doc, seq, c), frame, cmd.mode);
		if (t.scale.keyframes.length > 0 || t.scaleWidth.keyframes.length > 0)
			h.warn('W_VALUE_CLAMPED', `Scale keyframes of clip ${c.id} were replaced by a static value`);
		setStatic(t.scale, s);
		setStatic(t.scaleWidth, s);
		changed.push(c.id);
	}
	if (changed.length === 0) h.fail('E_INVALID_PARAM', 'None of the clips has a Motion transform');
	return { clipIds: changed };
}

// ---------------------------------------------------------------- range lift / extract (S02:TL-690)

function rangeTracks(seq: DSeq, refs: readonly string[] | undefined, h: HandlerContext): DTrack[] {
	if (!refs) return allTracksIn(seq).filter((t) => !t.locked);
	const tracks = refs.map((ref) => {
		const t = h.track(seq, ref);
		assertUnlocked(t, h);
		return t;
	});
	return [...new Map(tracks.map((t) => [t.id, t])).values()];
}

function rangeBounds(
	seq: DSeq,
	cmd: Pick<CommandOf<'range.lift'>, 'from' | 'to'>,
	h: HandlerContext,
): [number, number] {
	const from = h.frame(seq, cmd.from);
	const to = h.frame(seq, cmd.to);
	if (from < 0 || to <= from) h.fail('E_INVALID_PARAM', `Invalid range ${from}–${to}`);
	return [from, to];
}

function rangeLiftHandler(doc: DDoc, cmd: CommandOf<'range.lift'>, h: HandlerContext): unknown {
	const seq = h.sequence(doc, cmd.sequenceId);
	const [from, to] = rangeBounds(seq, cmd, h);
	const tracks = rangeTracks(seq, cmd.tracks, h);
	const splits: SplitRecord[] = [];
	for (const t of tracks) splits.push(...clearRange(seq, t.id, from, to, h));
	relinkSplits(seq, splits, h);
	cleanupSequence(seq, h);
	return { from, to, tracks: tracks.map((t) => t.id) };
}

function rangeExtractHandler(doc: DDoc, cmd: CommandOf<'range.extract'>, h: HandlerContext): unknown {
	const seq = h.sequence(doc, cmd.sequenceId);
	const [from, to] = rangeBounds(seq, cmd, h);
	const tracks = rangeTracks(seq, cmd.tracks, h);
	// Targeted tracks plus every sync-locked unlocked track lose the marked range, then it closes.
	const ids = new Set(tracks.map((t) => t.id));
	for (const t of syncFollowerTracks(seq, ids)) ids.add(t.id);
	const splits: SplitRecord[] = [];
	for (const id of ids) splits.push(...clearRange(seq, id, from, to, h));
	relinkSplits(seq, splits, h);
	removeShift(seq, ids, from, to - from, h);
	if (cmd.rippleMarkers !== false) shiftMarkers(seq, from, -(to - from));
	cleanupSequence(seq, h);
	return { from, to, tracks: [...ids] };
}

// ---------------------------------------------------------------- gap close (S02:TL-741)

function gapCloseHandler(doc: DDoc, cmd: CommandOf<'gap.close'>, h: HandlerContext): unknown {
	const seq = h.sequence(doc, cmd.sequenceId);
	const track = h.track(seq, cmd.trackId);
	assertUnlocked(track, h);
	const at = h.frame(seq, cmd.at);
	let cursor = 0;
	let gap: { start: number; end: number } | null = null;
	for (const c of trackClips(seq, track.id)) {
		if (c.start > cursor && at >= cursor && at < c.start) {
			gap = { start: cursor, end: c.start };
			break;
		}
		cursor = Math.max(cursor, end(c));
	}
	if (!gap) return h.fail('E_INVALID_PARAM', `No gap at frame ${at} on track ${cmd.trackId}`);
	const n = gap.end - gap.start;
	const edited = new Set([track.id]);
	const ids = [track.id, ...syncFollowerTracks(seq, edited).map((t) => t.id)];
	removeShift(seq, ids, gap.start, n, h);
	shiftMarkers(seq, gap.start, -n);
	cleanupSequence(seq, h);
	return { start: gap.start, end: gap.end, trackId: track.id };
}

// ---------------------------------------------------------------- catalog entries

export const clipEditHandlers: HandlerMap = {
	'clip.slip': slipHandler,
	'clip.slide': slideHandler,
	'clip.setSpeed': setSpeedHandler,
	'clip.duplicate': duplicateHandler,
	'clip.link': linkHandler,
	'clip.unlink': unlinkHandler,
	'clip.fitToFrame': fitToFrameHandler,
	'range.lift': rangeLiftHandler,
	'range.extract': rangeExtractHandler,
	'gap.close': gapCloseHandler,
};

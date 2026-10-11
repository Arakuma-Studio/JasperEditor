// ripple edits that keep split edits (J and L cuts) in sync. One ripple trim of a group of edges
// (a clip and its linked partners, or a multi-edit-point keyboard trim), ripple delete of clips whose sound and
// picture have different edges, and the shared content window (media handles, subclip limits) that bounds trims.
//
// Ported from FilmCraft crates/edit/src/lib.rs (`ripple_trim_group`, `ripple_delete_spans`,
// `ripple_delete_items`, `set_speed_group`), MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and the FilmCraft
// contributors — adapted to Jasper's sync-lock rules (S01:TRK-006, S02 Appendix A.5): sync-locked tracks get the
// same insert (splitting clips that straddle the edit) or removal (which must be empty) as the edited track.
//
// A **split-edit follower** is a clip on a rippling track that straddles the edit, linked to a later clip that
// shifts (its sound leads the cut, a J cut). It moves with its picture instead of being split or blocking the edit;
// the edit is refused when it has no room (E_SYNC_CONFLICT) unless the caller clamps (gesture behaviour).
import { contentDurationFlicks, isBoundedContent } from '../registry/kinds.ts';
import type { ProjectItem } from '../schema/document.ts';
import type { Clip } from '../schema/sequence.ts';
import { FRAME_EPS, flicksPerFrame, type Rational } from '../time.ts';
import { remapRoom } from '../time-remap/bounds.ts';
import { isRemapped } from '../time-remap/model.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from './context.ts';
import {
	allTracksIn,
	contentInRange,
	end,
	findTrackIn,
	relinkSplits,
	type SplitRecord,
	setClipRange,
	shiftMarkers,
	splitClipAt,
	trackClips,
} from './placement.ts';

/**
 * The content time a clip may show, in flicks: `[start, end)`. `end` is null for unbounded content. Media
 * clips are bounded by the media; clips placed from a subclip with "Restrict Trims to Subclip Boundaries" by the
 * subclip's range (FilmCraft `media_start`/`media_duration` for `ItemKind::Subclip { restrict_trims: true }`).
 */
export function contentWindow(doc: DDoc, c: DClip | Clip): { start: number; end: number | null } {
	let dur = contentDurationFlicks(doc, c as Clip);
	// a nested sequence is bounded by its content (last clip end).
	const nested = (c as { sequenceId?: string }).sequenceId;
	if ((c.kind === 'nest-video' || c.kind === 'nest-audio') && nested && doc.sequences[nested]) {
		const ns = doc.sequences[nested]!;
		let frames = 0;
		for (const x of Object.values(ns.clips)) frames = Math.max(frames, x.start + x.duration);
		dur = frames * flicksPerFrame(ns.settings.frameRate);
	}
	let start = 0;
	// edit-structure frame holds show one frame for the whole clip: only content time 0 bounds the edges.
	let stop = isBoundedContent(c as Clip) && dur !== null && !(c as Clip).frameHold ? dur : null;
	const subId = (c as { subclipId?: string }).subclipId;
	const sub = subId ? (doc.items[subId] as ProjectItem | undefined) : undefined;
	if (sub && sub.kind === 'subclip' && sub.restrictTrims) {
		start = Math.max(start, sub.range.in);
		stop = stop === null ? sub.range.out : Math.min(stop, sub.range.out);
	}
	return { start, end: stop };
}

/**
 * Content handles in sequence frames (S01:CLP-005): `head` = how far the In edge can extend left, `tail` = how far
 * the Out edge can extend right (Infinity for unbounded content). Reverse clips swap the two.
 */
export function contentHandles(doc: DDoc, seq: DSeq, c: DClip): { head: number; tail: number } {
	const step = flicksPerFrame(seq.settings.frameRate) * c.speed.rate;
	// Workstream `time`: a remapped clip's handles are the frames whose remapped media time is inside the media;
	// its content time (the keyframe axis) still never goes below 0.
	if (isRemapped(c as Clip) && !(c as Clip).frameHold) {
		const room = remapRoom(
			c as Clip,
			seq.settings.frameRate as Rational,
			contentDurationFlicks(doc, c as Clip),
		);
		return {
			head: Math.min(room.head, Math.max(0, Math.floor(c.sourceIn / step + FRAME_EPS))),
			tail: room.tail,
		};
	}
	const w = contentWindow(doc, c);
	const before = Math.max(0, Math.floor((c.sourceIn - w.start) / step + FRAME_EPS));
	const after =
		w.end === null
			? Number.POSITIVE_INFINITY
			: Math.max(0, Math.floor((w.end - c.sourceIn) / step + FRAME_EPS) - c.duration);
	return c.speed.reverse ? { head: after, tail: before } : { head: before, tail: after };
}

export type TrimLimits = { min: number; max: number };

/** Allowed delta range for trimming one clip edge (S02:TL-534/541, S01:CLP-005). */
export function trimLimits(
	doc: DDoc,
	seq: DSeq,
	c: DClip,
	edge: 'in' | 'out',
	ripple: boolean,
	members: ReadonlySet<string>,
): TrimLimits {
	let min = Number.NEGATIVE_INFINITY;
	let max = Number.POSITIVE_INFINITY;
	const room = contentHandles(doc, seq, c);
	const others = trackClips(seq, c.trackId).filter((x) => x.id !== c.id && !members.has(x.id));
	if (edge === 'in') {
		max = Math.min(max, c.duration - 1);
		if (!ripple) {
			min = Math.max(min, -c.start);
			const prevEnd = Math.max(0, ...others.filter((x) => end(x) <= c.start).map(end));
			min = Math.max(min, prevEnd - c.start);
		}
		min = Math.max(min, -room.head);
	} else {
		min = Math.max(min, 1 - c.duration);
		if (!ripple) {
			const nextStart = Math.min(
				Number.POSITIVE_INFINITY,
				...others.filter((x) => x.start >= end(c)).map((x) => x.start),
			);
			max = Math.min(max, nextStart - end(c));
		}
		max = Math.min(max, room.tail);
	}
	return { min, max };
}

export type RippleMember = { clip: DClip; edge: 'in' | 'out' };

type Plan = {
	/** New starts of moved (non-member) clips. */
	moves: Map<string, number>;
	/** Clips that must be split at `at` (insert, shift > 0) before moving. */
	splits: { trackId: string; at: number; except: Set<string> }[];
};

/**
 * Plans the moves of a ripple trim by `d` frames (members' edges are applied separately). Returns the blocking
 * clips when the removal would overwrite material on a sync-locked track or a follower has no room.
 */
function planRipple(
	seq: DSeq,
	members: readonly RippleMember[],
	d: number,
): { ok: true; plan: Plan } | { ok: false; blocking: string[] } {
	const memberIds = new Set(members.map((m) => m.clip.id));
	const memberTracks = new Map(members.map((m) => [m.clip.trackId, m]));
	const primary = members[0]!;
	const pShift = primary.edge === 'in' ? -d : d;
	const pn = Math.abs(d);
	const pStart = primary.clip.start;
	const pEnd = end(primary.clip);
	// Non-member tracks: insert at P, or remove R = [r0, r1).
	const P = primary.edge === 'in' ? pStart : pEnd;
	const r0 = primary.edge === 'in' ? pStart : pEnd - pn;
	const r1 = r0 + pn;
	const rippling = allTracksIn(seq).filter((t) => !t.locked && (memberTracks.has(t.id) || t.syncLock));
	const ownLinks = new Set(members.map((m) => m.clip.linkId).filter((l): l is string => !!l));
	const moves = new Map<string, number>();
	const splits: Plan['splits'] = [];

	// Which clips shift (and so which link groups pull their split-edit partners along).
	const shifting = new Map<string, number>();
	for (const t of rippling) {
		const m = memberTracks.get(t.id);
		for (const c of trackClips(seq, t.id)) {
			if (memberIds.has(c.id)) continue;
			if (m) {
				if (c.start >= end(m.clip)) shifting.set(c.id, m.edge === 'in' ? -d : d);
			} else if (pShift > 0 ? c.start >= P : c.start >= r1) shifting.set(c.id, pShift);
		}
	}
	const shiftingLinks = new Set<string>();
	for (const id of shifting.keys()) {
		const l = seq.clips[id]!.linkId;
		if (l && !ownLinks.has(l)) shiftingLinks.add(l);
	}
	const blocking: string[] = [];
	for (const t of rippling) {
		const clips = trackClips(seq, t.id);
		if (memberTracks.has(t.id)) {
			for (const c of clips) {
				const s = shifting.get(c.id);
				if (s !== undefined) moves.set(c.id, c.start + s);
			}
			continue;
		}
		const linkedToShift = (c: DClip) => !!c.linkId && shiftingLinks.has(c.linkId) && !memberIds.has(c.id);
		const follows = (c: DClip) =>
			linkedToShift(c) && (pShift > 0 ? c.start < P && end(c) > P : c.start < r1 && end(c) > r0);
		const followers = new Set(clips.filter(follows).map((c) => c.id));
		if (pShift > 0) {
			splits.push({ trackId: t.id, at: P, except: new Set([...followers, ...memberIds]) });
			for (const c of clips) if (c.start >= P || followers.has(c.id)) moves.set(c.id, c.start + pShift);
		} else if (pShift < 0) {
			for (const c of contentInRange(seq, t.id, r0, pn))
				if (!followers.has(c.id) && !memberIds.has(c.id)) blocking.push(c.id);
			for (const c of clips) if (c.start >= r1 || followers.has(c.id)) moves.set(c.id, c.start + pShift);
			// A follower needs room where it lands (no other clip, not before frame 0).
			for (const f of followers) {
				const c = seq.clips[f]!;
				const at = c.start + pShift;
				if (at < 0) {
					blocking.push(c.id);
					continue;
				}
				for (const o of clips) {
					if (o.id === c.id || moves.has(o.id) || memberIds.has(o.id)) continue;
					if (o.start < at + c.duration && end(o) > at) blocking.push(o.id);
				}
			}
		}
	}
	if (blocking.length) return { ok: false, blocking: [...new Set(blocking)] };
	return { ok: true, plan: { moves, splits } };
}

/** Applies the members' edge changes for a ripple trim by `d` (the clip keeps its start, S02:TL-540). */
function applyMemberEdges(seq: DSeq, members: readonly RippleMember[], d: number): void {
	for (const m of members) {
		const c = m.clip;
		if (m.edge === 'in') {
			const s = c.start;
			setClipRange(seq, c, s + d, end(c));
			c.start = s;
		} else setClipRange(seq, c, c.start, end(c) + d);
	}
}

/**
 * Ripple-trims a group of edges (at most one per track) by `delta` frames as one edit: every member's edge moves,
 * later material on the members' tracks shifts by that member's change, sync-locked tracks get the primary
 * (first) member's insert or removal, and split-edit followers move with their pictures. Returns the applied
 * delta (clamped to the members' handles; with `clampToSyncLock` also to what sync-locked tracks allow).
 */
export function rippleTrimGroup(
	doc: DDoc,
	seq: DSeq,
	h: HandlerContext,
	members: readonly RippleMember[],
	delta: number,
	opts: { clampToSyncLock?: boolean; rippleMarkers?: boolean } = {},
): number {
	if (members.length === 0 || delta === 0) return 0;
	const tracks = new Set<string>();
	for (const m of members) {
		if (tracks.has(m.clip.trackId))
			h.fail('E_INVALID_PARAM', 'A ripple trim takes one edit point per track', { blocking: [m.clip.id] });
		tracks.add(m.clip.trackId);
	}
	const memberIds = new Set(members.map((m) => m.clip.id));
	const lim = members.map((m) => trimLimits(doc, seq, m.clip, m.edge, true, memberIds));
	const lo = Math.max(...lim.map((l) => l.min));
	const hi = Math.min(...lim.map((l) => l.max));
	let d = lo > hi ? 0 : Math.min(hi, Math.max(lo, delta));
	if (d !== delta) h.warn('W_DURATION_CLAMPED', `Trim clamped from ${delta} to ${d} frames`);
	if (d === 0) return 0;
	let planned = planRipple(seq, members, d);
	if (!planned.ok) {
		if (!opts.clampToSyncLock)
			h.fail('E_SYNC_CONFLICT', 'Sync-locked tracks have content in the trimmed range', {
				blocking: planned.blocking,
			});
		// Gesture behaviour (S02:TL-543): the largest amount every sync-locked track allows. Feasibility is
		// monotone in the size of the removal, so a binary search finds it.
		const sign = Math.sign(d);
		let okN = 0;
		let badN = Math.abs(d);
		while (badN - okN > 1) {
			const mid = Math.floor((okN + badN) / 2);
			if (planRipple(seq, members, sign * mid).ok) okN = mid;
			else badN = mid;
		}
		h.warn(
			'W_DURATION_CLAMPED',
			`Ripple trim stopped at ${okN} of ${Math.abs(d)} frames by sync-locked tracks`,
		);
		d = sign * okN;
		if (d === 0) return 0;
		planned = planRipple(seq, members, d);
		if (!planned.ok) return h.fail('E_SYNC_CONFLICT', 'Sync-locked tracks block the ripple trim');
	}
	const { plan } = planned;
	const primary = members[0]!;
	const pShift = primary.edge === 'in' ? -d : d;
	const n = Math.abs(d);
	const P = primary.edge === 'in' ? primary.clip.start : end(primary.clip);
	const r0 = primary.edge === 'in' ? primary.clip.start : end(primary.clip) - n;
	// Inserts split the clips that straddle the edit on sync-locked tracks (followers excepted, S02 A.5); the
	// right parts start at the edit and shift with everything after it.
	for (const s of plan.splits) {
		const recs: SplitRecord[] = [];
		for (const c of trackClips(seq, s.trackId))
			if (!s.except.has(c.id) && c.start < s.at && end(c) > s.at)
				recs.push({ originalLinkId: c.linkId, rightId: splitClipAt(seq, c, s.at, h).id });
		relinkSplits(seq, recs, h);
		for (const c of trackClips(seq, s.trackId))
			if (!s.except.has(c.id) && c.start >= s.at && !plan.moves.has(c.id))
				plan.moves.set(c.id, c.start + pShift);
	}
	for (const [id, start] of plan.moves) seq.clips[id]!.start = start;
	applyMemberEdges(seq, members, d);
	if (opts.rippleMarkers !== false) {
		if (pShift > 0) shiftMarkers(seq, P, n);
		else shiftMarkers(seq, r0, -n);
	}
	return d;
}

type Span = { start: number; end: number };

function mergedSpans(list: Span[]): Span[] {
	const sorted = [...list].sort((a, b) => a.start - b.start);
	const out: Span[] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
		else out.push({ ...r });
	}
	return out;
}

/**
 * The stretches a ripple delete of `ids` closes, in time order: the time the deleted clips covered, less whatever
 * stays on the tracks that lose a clip. Every such track then moves up by the same amount into time that is free
 * on all of them, so later clips stay in sync (a clip and its sound with a split edit close one gap, not two).
 * Locked tracks lose nothing and do not count. (FilmCraft `ripple_delete_spans`.)
 */
export function rippleDeleteSpans(seq: DSeq, ids: ReadonlySet<string>): Span[] {
	const deleted: Span[] = [];
	const kept: Span[] = [];
	for (const t of allTracksIn(seq)) {
		if (t.locked) continue;
		const clips = trackClips(seq, t.id);
		if (!clips.some((c) => ids.has(c.id))) continue;
		for (const c of clips) (ids.has(c.id) ? deleted : kept).push({ start: c.start, end: end(c) });
	}
	const keptM = mergedSpans(kept);
	const spans: Span[] = [];
	for (const r of mergedSpans(deleted)) {
		let at = r.start;
		for (const k of keptM) {
			if (k.end <= r.start || k.start >= r.end) continue;
			if (k.start > at) spans.push({ start: at, end: k.start });
			at = Math.max(at, k.end);
		}
		if (at < r.end) spans.push({ start: at, end: r.end });
	}
	return spans;
}

/** Tracks that hold one of `ids`. */
export function tracksHolding(seq: DSeq, ids: ReadonlySet<string>): Set<string> {
	const out = new Set<string>();
	for (const id of ids) {
		const c = seq.clips[id];
		if (c && findTrackIn(seq, c.trackId)) out.add(c.trackId);
	}
	return out;
}

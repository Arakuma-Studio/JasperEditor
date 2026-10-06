// Editing primitives on draft sequences: overwrite, insert/ripple shifts with sync lock, splits,
// removals and link/transition cleanup (S01:CLP-003, CLP-007, TRK-006; S02 Appendix A.4–A.6;
// ARCHITECTURE §2.3 locked-track rule). Works on Immer drafts, so nothing here is memoized.
import { current, type Draft, isDraft } from 'immer';
import { createTrack } from '../factories.ts';
import { trackKindFor } from '../registry/kinds.ts';
import type { Animatable } from '../schema/common.ts';
import type { Clip, Sequence, Track, TrackKind } from '../schema/sequence.ts';
import { contentSpanFlicks } from '../time.ts';
import type { HandlerContext } from './context.ts';
import { splitTextAnimation } from './handlers/text-animation.ts';

type DSeq = Draft<Sequence>;
type DClip = Draft<Clip>;
type DTrack = Draft<Track>;

export const end = (c: { start: number; duration: number }) => c.start + c.duration;

// ---------------------------------------------------------------- tracks

export function tracksOfKind(seq: DSeq, kind: TrackKind): DTrack[] {
	return kind === 'video' ? seq.videoTracks : kind === 'audio' ? seq.audioTracks : seq.captionTracks;
}

export function allTracksIn(seq: DSeq): DTrack[] {
	return [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks];
}

export function findTrackIn(
	seq: DSeq | Sequence,
	trackId: string,
): { track: DTrack; index: number; kind: TrackKind } | null {
	for (const kind of ['video', 'audio', 'caption'] as const) {
		const list = tracksOfKind(seq as DSeq, kind);
		const index = list.findIndex((t) => t.id === trackId);
		if (index >= 0) return { track: list[index]!, index, kind };
	}
	return null;
}

/** Track id for an id or a `V2`/`A1`/`C1` label (S01:TRK-002). */
export function resolveTrackIn(seq: DSeq | Sequence, ref: string): string | null {
	const m = /^([VAC])(\d+)$/i.exec(ref);
	if (m) {
		const kind = m[1]!.toUpperCase() === 'V' ? 'video' : m[1]!.toUpperCase() === 'A' ? 'audio' : 'caption';
		return tracksOfKind(seq as DSeq, kind)[Number(m[2]) - 1]?.id ?? null;
	}
	return findTrackIn(seq, ref) ? ref : null;
}

/** Parses a label into kind + zero-based index (for auto-creating missing tracks). */
function parseTrackLabel(ref: string): { kind: TrackKind; index: number } | null {
	const m = /^([VAC])(\d+)$/i.exec(ref);
	if (!m || Number(m[2]) < 1) return null;
	const kind = m[1]!.toUpperCase() === 'V' ? 'video' : m[1]!.toUpperCase() === 'A' ? 'audio' : 'caption';
	return { kind, index: Number(m[2]) - 1 };
}

/** Appends tracks of `kind` until `index` exists (S01:TRK-005 auto-creation). Returns the track. */
export function ensureTrackAt(seq: DSeq, kind: TrackKind, index: number, h: HandlerContext): DTrack {
	const list = tracksOfKind(seq, kind);
	while (list.length <= index) list.push(createTrack(h.ids, kind) as DTrack);
	return list[index]!;
}

/** Resolves a track ref, creating missing labelled tracks when allowed. */
export function resolveOrCreateTrack(seq: DSeq, ref: string, h: HandlerContext, create: boolean): DTrack {
	const id = resolveTrackIn(seq, ref);
	if (id) return findTrackIn(seq, id)!.track;
	const parsed = parseTrackLabel(ref);
	if (parsed && create) return ensureTrackAt(seq, parsed.kind, parsed.index, h);
	return h.fail(parsed ? 'E_TRACK_KIND' : 'E_NOT_FOUND', `Track not found: ${ref}`);
}

export function assertUnlocked(track: { locked: boolean; id: string }, h: HandlerContext): void {
	if (track.locked) h.fail('E_TRACK_LOCKED', `Track ${track.id} is locked`, { blocking: [track.id] });
}

export function assertKindFits(
	clipKind: string,
	track: { kind: TrackKind; id: string },
	h: HandlerContext,
): void {
	const need = trackKindFor(clipKind);
	if (need && need !== track.kind) {
		h.fail('E_TRACK_KIND', `A ${clipKind} clip cannot go on a ${track.kind} track`, { blocking: [track.id] });
	}
}

/** Tracks shifted with an edit on `edited` tracks: sync-locked, unlocked, not edited (TRK-006, §2.3). */
export function syncFollowerTracks(seq: DSeq, edited: ReadonlySet<string>): DTrack[] {
	return allTracksIn(seq).filter((t) => !edited.has(t.id) && t.syncLock && !t.locked);
}

// ---------------------------------------------------------------- clips

export function trackClips(seq: DSeq, trackId: string): DClip[] {
	return Object.values(seq.clips)
		.filter((c) => c.trackId === trackId)
		.sort((a, b) => a.start - b.start);
}

/** Sets a clip's timeline range, keeping content glued to the picture (speed-aware, S02:TL-533). */
export function setClipRange(seq: DSeq, clip: DClip, newStart: number, newEnd: number): void {
	const r = seq.settings.frameRate;
	const oldStart = clip.start;
	const oldEnd = end(clip);
	if (clip.speed.reverse) clip.sourceIn += contentSpanFlicks(oldEnd - newEnd, r, clip.speed.rate);
	else clip.sourceIn += contentSpanFlicks(newStart - oldStart, r, clip.speed.rate);
	clip.start = newStart;
	clip.duration = newEnd - newStart;
}

function snapshot<T>(v: T): T {
	const plain = isDraft(v) ? current(v as Draft<T>) : v;
	return JSON.parse(JSON.stringify(plain)) as T;
}

/** Gives every nested entity (keyframes, effects, clip markers) a fresh id (S01:ID-005). */
export function reidentifyClipChildren(clip: Clip, h: HandlerContext): void {
	// M2 (S09:TRK-003): trackers travel with the copy under new ids; a target's `trackedBy` follows its own
	// corner-pin instance to the copy's new effect id.
	const c = clip as {
		trackers?: { id: string }[];
		effects?: { id: string }[];
		trackedBy?: { effectInstanceId?: string };
	};
	for (const t of c.trackers ?? []) t.id = h.ids.next('tkr');
	// Workstream `time`: speed keyframes of a time remap.
	for (const k of (clip as { timeRemap?: { keyframes?: { id: string }[] } }).timeRemap?.keyframes ?? [])
		k.id = h.ids.next('kf');
	const fxIndex = c.trackedBy?.effectInstanceId
		? (c.effects ?? []).findIndex((fx) => fx.id === c.trackedBy!.effectInstanceId)
		: -1;
	const visit = (v: unknown): void => {
		if (Array.isArray(v)) {
			v.forEach(visit);
			return;
		}
		if (!v || typeof v !== 'object') return;
		const o = v as Record<string, unknown>;
		if (Array.isArray(o.keyframes) && 'value' in o) {
			for (const kf of o.keyframes as { id: string }[]) kf.id = h.ids.next('kf');
		}
		for (const [k, x] of Object.entries(o)) {
			if (k === 'effects' && Array.isArray(x))
				for (const fx of x as { id: string }[]) fx.id = h.ids.next('fx');
			if (k === 'markers' && Array.isArray(x))
				for (const m of x as { id: string }[]) m.id = h.ids.next('mrk');
			// wp-m2-anime-templates (S11:ATP-006): template param keyframes are plain lists per param name.
			if (k === 'paramKeyframes' && x && typeof x === 'object')
				for (const list of Object.values(x as Record<string, { id: string }[]>))
					for (const kf of list) kf.id = h.ids.next('kf');
			visit(x);
		}
	};
	visit(clip);
	if (fxIndex >= 0 && c.trackedBy && c.effects?.[fxIndex])
		c.trackedBy.effectInstanceId = c.effects[fxIndex].id;
}

/**
 * Splits `clip` at frame `at` (S01:CLP-007). The left part keeps the id; the right part is a copy with
 * new ids for itself and its keyframes/effects/markers, the full effect stack and all keyframes. The
 * right part is not linked (callers relink right parts together). A tail transition moves right.
 */
export function splitClipAt(seq: DSeq, clip: DClip, at: number, h: HandlerContext): DClip {
	if (!(clip.start < at && at < end(clip)))
		h.fail('E_INVALID_PARAM', `Frame ${at} is not inside clip ${clip.id}`);
	const r = seq.settings.frameRate;
	const right = snapshot(clip) as Clip;
	right.id = h.ids.next('clp');
	reidentifyClipChildren(right, h);
	right.linkId = null;
	const oldEnd = end(clip);
	right.start = at;
	right.duration = oldEnd - at;
	if (clip.speed.reverse) {
		// The left part shows the later source; its sourceIn moves (S01:CLP-007).
		clip.sourceIn += contentSpanFlicks(oldEnd - at, r, clip.speed.rate);
	} else {
		right.sourceIn = clip.sourceIn + contentSpanFlicks(at - clip.start, r, clip.speed.rate);
	}
	clip.duration = at - clip.start;
	seq.clips[right.id] = right as DClip;
	// M2 (S11:TXA-005): the left part keeps the In animator, the right part the Out animator.
	splitTextAnimation(clip, seq.clips[right.id]!);
	if (clip.groupId && seq.groups[clip.groupId]) seq.groups[clip.groupId]!.members.push(right.id);
	for (const t of Object.values(seq.transitions)) {
		if (t.outgoingClipId === clip.id) t.outgoingClipId = right.id;
	}
	return seq.clips[right.id]!;
}

/** Deletes a clip and its memberships; transitions that reference it are removed with a warning. */
export function removeClip(seq: DSeq, clipId: string, h: HandlerContext): void {
	const clip = seq.clips[clipId];
	if (!clip) return;
	delete seq.clips[clipId];
	if (clip.linkId && seq.links[clip.linkId]) {
		const l = seq.links[clip.linkId]!;
		l.members = l.members.filter((m) => m !== clipId);
	}
	if (clip.groupId && seq.groups[clip.groupId]) {
		const g = seq.groups[clip.groupId]!;
		g.members = g.members.filter((m) => m !== clipId);
	}
	for (const t of Object.values(seq.transitions)) {
		if (t.outgoingClipId === clipId || t.incomingClipId === clipId) {
			delete seq.transitions[t.id];
			h.warn('W_TRANSITION_REMOVED', `Transition ${t.id} removed with clip ${clipId}`);
		}
	}
}

export type SplitRecord = { originalLinkId: string | null; rightId: string };

/**
 * Overwrite (S02 A.4): makes `[a, b)` on a track empty, trimming, splitting or removing clips.
 * Returns right parts produced by splits so callers can mirror link groups.
 */
export function clearRange(
	seq: DSeq,
	trackId: string,
	a: number,
	b: number,
	h: HandlerContext,
	except: ReadonlySet<string> = new Set(),
): SplitRecord[] {
	const splits: SplitRecord[] = [];
	if (b <= a) return splits;
	for (const c of trackClips(seq, trackId)) {
		if (except.has(c.id)) continue;
		const cs = c.start;
		const ce = end(c);
		if (ce <= a || cs >= b) continue;
		if (cs >= a && ce <= b) removeClip(seq, c.id, h);
		else if (cs < a && ce > b) {
			const linkId = c.linkId;
			const right = splitClipAt(seq, c, b, h);
			splits.push({ originalLinkId: linkId, rightId: right.id });
			setClipRange(seq, c, cs, a);
		} else if (cs < a) setClipRange(seq, c, cs, a);
		else setClipRange(seq, c, b, ce);
	}
	return splits;
}

/** Links right parts that came from the same link group into a new group (S02 A.4/A.6). */
export function relinkSplits(seq: DSeq, splits: readonly SplitRecord[], h: HandlerContext): void {
	const byLink = new Map<string, string[]>();
	for (const s of splits) {
		if (!s.originalLinkId) continue;
		const list = byLink.get(s.originalLinkId) ?? [];
		list.push(s.rightId);
		byLink.set(s.originalLinkId, list);
	}
	for (const ids of byLink.values()) {
		const alive = ids.filter((id) => seq.clips[id]);
		if (alive.length < 2) continue;
		const linkId = h.ids.next('lnk');
		seq.links[linkId] = { id: linkId, members: alive };
		for (const id of alive) seq.clips[id]!.linkId = linkId;
	}
}

/** Blocking clips inside `[f, f+n)` on a track. */
export function contentInRange(seq: DSeq, trackId: string, f: number, n: number): DClip[] {
	return trackClips(seq, trackId).filter((c) => c.start < f + n && end(c) > f);
}

/**
 * Insert shift (S02 A.5): on each track, split clips straddling `at`, then shift clips at/after `at`
 * by `n`, leaving `except` clips in place. Returns split records (right parts) for relinking.
 */
export function insertShift(
	seq: DSeq,
	trackIds: Iterable<string>,
	at: number,
	n: number,
	h: HandlerContext,
	except: ReadonlySet<string> = new Set(),
): SplitRecord[] {
	const splits: SplitRecord[] = [];
	if (n <= 0) return splits;
	for (const trackId of trackIds) {
		for (const c of trackClips(seq, trackId)) {
			if (except.has(c.id)) continue;
			if (c.start < at && end(c) > at) {
				const linkId = c.linkId;
				const right = splitClipAt(seq, c, at, h);
				splits.push({ originalLinkId: linkId, rightId: right.id });
			}
		}
		for (const c of trackClips(seq, trackId)) if (!except.has(c.id) && c.start >= at) c.start += n;
	}
	return splits;
}

/**
 * Ripple removal (S02 A.5): `[f, f+n)` must be empty on every track (else E_SYNC_CONFLICT with the
 * blocking clips, unless `cut`), then everything at/after `f+n` shifts left by `n`.
 */
export function removeShift(
	seq: DSeq,
	trackIds: Iterable<string>,
	f: number,
	n: number,
	h: HandlerContext,
	opts: { syncConflict?: 'refuse' | 'cut' } = {},
): void {
	if (n <= 0) return;
	const ids = [...trackIds];
	const blocking: string[] = [];
	for (const trackId of ids) for (const c of contentInRange(seq, trackId, f, n)) blocking.push(c.id);
	if (blocking.length > 0) {
		if (opts.syncConflict !== 'cut') {
			h.fail('E_SYNC_CONFLICT', `Frames ${f}–${f + n} are not empty on sync-locked tracks`, { blocking });
		}
		for (const trackId of ids) relinkSplits(seq, clearRange(seq, trackId, f, f + n, h), h);
	}
	for (const trackId of ids) for (const c of trackClips(seq, trackId)) if (c.start >= f + n) c.start -= n;
}

export function shiftMarkers(seq: DSeq, at: number, delta: number): void {
	if (delta === 0) return;
	for (const m of seq.markers) {
		if (delta > 0 && m.frame >= at) m.frame += delta;
		else if (delta < 0) {
			const n = -delta;
			if (m.frame >= at + n) m.frame -= n;
			else if (m.frame >= at) m.frame = at;
		}
	}
	seq.markers.sort((a, b) => a.frame - b.frame);
}

// ---------------------------------------------------------------- cleanup

/**
 * Normalizes memberships after edits: drops dangling link/group members, dissolves groups with fewer
 * than two members, clears dangling `linkId`/`groupId`, and removes transitions whose clips vanished or
 * are no longer adjacent (S01:TRN-005, INV-007, INV-010).
 */
export function cleanupSequence(seq: DSeq, h: HandlerContext): void {
	for (const kind of ['links', 'groups'] as const) {
		const field = kind === 'links' ? 'linkId' : 'groupId';
		const table = seq[kind];
		for (const g of Object.values(table)) {
			const members = g.members.filter((m, i, arr) => seq.clips[m]?.[field] === g.id && arr.indexOf(m) === i);
			if (members.length < 2) {
				for (const m of members) seq.clips[m]![field] = null;
				delete table[g.id];
			} else if (members.length !== g.members.length) g.members = members;
		}
		for (const c of Object.values(seq.clips)) {
			const id = c[field];
			if (id && !table[id]) c[field] = null;
		}
	}
	for (const t of Object.values(seq.transitions)) {
		const out = t.outgoingClipId ? seq.clips[t.outgoingClipId] : null;
		const inc = t.incomingClipId ? seq.clips[t.incomingClipId] : null;
		const missing = (t.outgoingClipId && !out) || (t.incomingClipId && !inc);
		const separated =
			out && inc && (out.trackId !== inc.trackId || end(out) !== inc.start || out.trackId !== t.trackId);
		const moved = (out && out.trackId !== t.trackId) || (inc && inc.trackId !== t.trackId);
		if (missing || separated || moved) {
			delete seq.transitions[t.id];
			h.warn('W_TRANSITION_REMOVED', `Transition ${t.id} removed because its clips were separated`);
		}
	}
}

export function setStatic<T>(anim: Draft<Animatable<T>>, value: T): void {
	(anim as Animatable<T>).value = value;
	(anim as Animatable<T>).keyframes = [];
}

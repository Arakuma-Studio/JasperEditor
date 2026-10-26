// Many range edits in one pass (spec 14 TC-031; docs/wp-notes/transcript-cleanup.md "Applying"). Extracting N ranges
// one `range.extract` at a time scans every track and shifts every later clip N times; `cutRanges` gives the same
// document (property-tested against right-to-left `range.extract`, ids aside) in one pass: each clip is cut by the
// ranges that overlap it (found by binary search, right to left, so the original keeps the leftmost piece), the
// pieces right after range k are relinked per original link group (as each `range.extract` relinks its splits),
// then every clip and marker moves left by the removed frames before it (prefix sums). Then the cut edges of audio
// clips get edge micro-fades and the sound's J / L offset. O((clips + ranges) · log ranges) plus the splits.

import type { DClip, DDoc, DSeq, HandlerContext } from './context.ts';
import {
	cleanupSequence,
	end,
	removeClip,
	setClipRange,
	splitClipAt,
	syncFollowerTracks,
	trackClipIds,
} from './placement.ts';
import { contentHandles } from './ripple.ts';

export type CutRangesOptions = {
	/** Sorted, disjoint, non-empty `[from, to)` sequence-frame ranges. */
	ranges: ReadonlyArray<readonly [number, number]>;
	/** Tracks edited (unlocked). With `ripple`, unlocked sync-locked tracks follow (they lose the ranges too). */
	trackIds: ReadonlySet<string>;
	/** Extract (true: close the gaps) or lift (false). */
	ripple: boolean;
	rippleMarkers?: boolean;
	/** Equal-power micro-fade on every cut edge of an audio clip (ms, 0 = none). */
	fadeMs?: number;
	/** J / L offset of the sound at every join of `ripple` (frames; > 0 the incoming sound leads). */
	jlFrames?: number;
};

export type CutRangesResult = {
	/** Frames removed (ripple) or cleared (lift) from the timeline. */
	frames: number;
	/** Joins made (ripple: one per range that had material on both sides; lift: 0). */
	joins: number;
	/** Tracks that were cut. */
	tracks: string[];
	/** Audio clip edges that got a micro-fade. */
	fades: number;
	/** Joins whose J / L offset was applied / skipped (no media handles or too short a piece). */
	jl: { applied: number; skipped: number };
};

/** Index of the first range whose end is after `x`. */
function firstEndingAfter(ranges: ReadonlyArray<readonly [number, number]>, x: number): number {
	let lo = 0;
	let hi = ranges.length;
	while (lo < hi) {
		const m = (lo + hi) >> 1;
		if (ranges[m]![1] <= x) lo = m + 1;
		else hi = m;
	}
	return lo;
}

/** Cuts `ranges` out of the given tracks in one pass (see the module comment). */
export function cutRanges(doc: DDoc, seq: DSeq, h: HandlerContext, o: CutRangesOptions): CutRangesResult {
	const ranges = o.ranges;
	const tracks = new Set(o.trackIds);
	if (o.ripple) for (const t of syncFollowerTracks(seq, tracks)) tracks.add(t.id);
	const result: CutRangesResult = {
		frames: 0,
		joins: 0,
		tracks: [...tracks],
		fades: 0,
		jl: { applied: 0, skipped: 0 },
	};
	if (!ranges.length) return result;
	// prefix sums: removed[k] = frames of ranges[0..k)
	const removedBefore = new Array<number>(ranges.length + 1).fill(0);
	for (let k = 0; k < ranges.length; k++)
		removedBefore[k + 1] = removedBefore[k]! + (ranges[k]![1] - ranges[k]![0]);
	result.frames = removedBefore[ranges.length]!;
	const shiftAt = (x: number) => removedBefore[firstEndingAfter(ranges, x)]!;

	const inCut = new Set<string>();
	const outCut = new Set<string>();
	// pieces created right after range k, by original link group → relinked per (link, k)
	const relink = new Map<string, string[]>();
	for (const trackId of tracks) {
		for (const id of trackClipIds(seq, trackId)) {
			const c0 = seq.clips[id];
			if (!c0) continue;
			const cs = c0.start;
			const ce = end(c0);
			let k = firstEndingAfter(ranges, cs);
			const hits: number[] = [];
			while (k < ranges.length && ranges[k]![0] < ce) hits.push(k++);
			if (!hits.length) continue;
			const linkId = c0.linkId;
			let cur: DClip | null = c0;
			// right to left, as successive `range.extract`s (clearRange): split, trim the end, trim the start, remove
			for (let q = hits.length - 1; q >= 0 && cur; q--) {
				const ki = hits[q]!;
				const [a, b] = ranges[ki]!;
				const s0 = cur.start;
				const e0 = end(cur);
				if (a <= s0 && b >= e0) {
					inCut.delete(cur.id);
					outCut.delete(cur.id);
					removeClip(seq, cur.id, h);
					cur = null;
				} else if (a > s0 && b < e0) {
					const right = splitClipAt(seq, cur, b, h);
					inCut.add(right.id);
					if (outCut.delete(cur.id)) outCut.add(right.id);
					if (linkId) {
						const key = `${linkId}\u0000${ki}`;
						const list = relink.get(key);
						if (list) list.push(right.id);
						else relink.set(key, [right.id]);
					}
					setClipRange(seq, cur, s0, a);
					outCut.add(cur.id);
				} else if (a <= s0) {
					setClipRange(seq, cur, b, e0);
					inCut.add(cur.id);
				} else {
					setClipRange(seq, cur, s0, a);
					outCut.add(cur.id);
				}
			}
		}
	}
	for (const ids of relink.values()) {
		const alive = ids.filter((x) => seq.clips[x]);
		if (alive.length < 2) continue;
		const lid = h.ids.next('lnk');
		seq.links[lid] = { id: lid, members: alive };
		for (const x of alive) seq.clips[x]!.linkId = lid;
	}

	if (o.ripple) {
		for (const trackId of tracks)
			for (const id of trackClipIds(seq, trackId)) {
				const c = seq.clips[id]!;
				const d = shiftAt(c.start);
				if (d) c.start -= d;
			}
		if (o.rippleMarkers !== false && seq.markers.length) {
			for (const m of seq.markers) {
				const k = firstEndingAfter(ranges, m.frame);
				const r = ranges[k];
				const at = r && m.frame >= r[0] ? r[0] : m.frame;
				const d = shiftAt(at);
				if (m.frame !== at - d) m.frame = at - d;
			}
			seq.markers.sort((a, b) => a.frame - b.frame);
		}
	}
	cleanupSequence(seq, h);

	// joins (ripple): where an out-cut piece meets an in-cut piece on an edited track
	const audio = new Set(seq.audioTracks.map((t) => t.id));
	const fadeMs = o.fadeMs ?? 0;
	const jl = o.ripple ? (o.jlFrames ?? 0) : 0;
	const joinsAt = new Set<number>();
	for (const trackId of tracks) {
		const ids = trackClipIds(seq, trackId);
		const pairs: Array<[DClip, DClip]> = [];
		if (o.ripple)
			for (let i = 0; i + 1 < ids.length; i++) {
				const a = seq.clips[ids[i]!]!;
				const b = seq.clips[ids[i + 1]!]!;
				if (end(a) === b.start && outCut.has(a.id) && inCut.has(b.id)) pairs.push([a, b]);
			}
		if (o.trackIds.has(trackId)) for (const [, b] of pairs) joinsAt.add(b.start);
		if (!audio.has(trackId)) continue;
		if (fadeMs > 0)
			for (const id of ids) {
				const c = seq.clips[id]!;
				if (c.kind !== 'audio') continue;
				const fin = inCut.has(id);
				const fout = outCut.has(id);
				if (!fin && !fout) continue;
				const r = c as unknown as { edgeFades?: { inMs?: number; outMs?: number } };
				r.edgeFades = {
					...(r.edgeFades ?? {}),
					...(fin ? { inMs: fadeMs } : {}),
					...(fout ? { outMs: fadeMs } : {}),
				};
				result.fades += (fin ? 1 : 0) + (fout ? 1 : 0);
			}
		if (jl !== 0 && o.trackIds.has(trackId))
			for (const [a, b] of pairs) {
				const n = Math.abs(jl);
				const ok =
					jl > 0
						? contentHandles(doc, seq, b).head >= n && a.duration > n
						: contentHandles(doc, seq, a).tail >= n && b.duration > n;
				if (!ok) {
					result.jl.skipped++;
					continue;
				}
				const at = jl > 0 ? b.start - n : b.start + n;
				const bEnd = end(b);
				setClipRange(seq, a, a.start, at);
				setClipRange(seq, b, at, bEnd);
				result.jl.applied++;
			}
	}
	result.joins = joinsAt.size;
	if (result.jl.skipped)
		h.warn(
			'W_DURATION_CLAMPED',
			`${result.jl.skipped} join(s) kept a straight cut: not enough media for a ${Math.abs(jl)}-frame ${jl > 0 ? 'J' : 'L'} cut`,
		);
	return result;
}

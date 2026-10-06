// Derived data (S01:SES-010): computed from the document, memoized by reference, never stored.
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence, Track } from '../schema/sequence.ts';
import { contentSpanFlicks, flicksPerFrame, type Rational } from '../time.ts';

export const clipEnd = (c: { start: number; duration: number }) => c.start + c.duration;

// ---------------------------------------------------------------- per-track index

export type TrackIndex = {
	/** Clips on each track sorted by start. Tracks with no clips map to an empty array. */
	byTrack: Map<string, Clip[]>;
};

const indexCache = new WeakMap<object, TrackIndex>();

/** Per-track sorted clip lists, memoized by the `clips` record identity (S01:SES-010). */
function sequenceIndex(
	seq: Pick<Sequence, 'clips' | 'videoTracks' | 'audioTracks' | 'captionTracks'>,
): TrackIndex {
	const cached = indexCache.get(seq.clips);
	if (cached) return cached;
	const byTrack = new Map<string, Clip[]>();
	for (const t of allTracks(seq)) byTrack.set(t.id, []);
	for (const c of Object.values(seq.clips)) {
		let list = byTrack.get(c.trackId);
		if (!list) {
			list = [];
			byTrack.set(c.trackId, list);
		}
		list.push(c);
	}
	for (const list of byTrack.values()) list.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
	const idx = { byTrack };
	indexCache.set(seq.clips, idx);
	return idx;
}

export function clipsOnTrack(seq: Sequence, trackId: string): Clip[] {
	return sequenceIndex(seq).byTrack.get(trackId) ?? [];
}

/** First index whose clip ends after `frame` (clips on a track never overlap, so ends are sorted). */
function firstEndingAfter(list: readonly Clip[], frame: number): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (clipEnd(list[mid]!) > frame) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** The clip covering `frame` on a track, if any (interval lookup, O(log n)). */
export function clipAt(seq: Sequence, trackId: string, frame: number): Clip | undefined {
	const list = clipsOnTrack(seq, trackId);
	const i = firstEndingAfter(list, frame);
	const c = list[i];
	return c && c.start <= frame ? c : undefined;
}

/** Clips intersecting `[from, to)` on a track, in start order. */
export function clipsInRange(seq: Sequence, trackId: string, from: number, to: number): Clip[] {
	const list = clipsOnTrack(seq, trackId);
	const out: Clip[] = [];
	for (let i = firstEndingAfter(list, from); i < list.length; i++) {
		const c = list[i]!;
		if (c.start >= to) break;
		out.push(c);
	}
	return out;
}

// ---------------------------------------------------------------- tracks

export function allTracks(seq: Pick<Sequence, 'videoTracks' | 'audioTracks' | 'captionTracks'>): Track[] {
	return [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks];
}

export function trackList(seq: Sequence, kind: Track['kind']): Track[] {
	return kind === 'video' ? seq.videoTracks : kind === 'audio' ? seq.audioTracks : seq.captionTracks;
}

export function findTrack(seq: Sequence, trackId: string): { track: Track; index: number } | null {
	for (const list of [seq.videoTracks, seq.audioTracks, seq.captionTracks]) {
		const index = list.findIndex((t) => t.id === trackId);
		if (index >= 0) return { track: list[index]!, index };
	}
	return null;
}

/** Display label derived from the index: V1, A2, C1 (S01:TRK-002). */
export function trackLabel(seq: Sequence, trackId: string): string | null {
	const f = findTrack(seq, trackId);
	if (!f) return null;
	const prefix = f.track.kind === 'video' ? 'V' : f.track.kind === 'audio' ? 'A' : 'C';
	return `${prefix}${f.index + 1}`;
}

/** Resolves an id or a `V2`/`A1`/`C1` label to a track id (null if missing). */
export function resolveTrackRef(seq: Sequence, ref: string): string | null {
	const m = /^([VAC])(\d+)$/i.exec(ref);
	if (m) {
		const list =
			m[1]!.toUpperCase() === 'V'
				? seq.videoTracks
				: m[1]!.toUpperCase() === 'A'
					? seq.audioTracks
					: seq.captionTracks;
		return list[Number(m[2]) - 1]?.id ?? null;
	}
	return findTrack(seq, ref) ? ref : null;
}

// ---------------------------------------------------------------- duration, gaps, edit points

const durationCache = new WeakMap<object, number>();

/** Sequence duration = max clip end, or 0 (S01:TIME-007). */
export function sequenceDuration(seq: Pick<Sequence, 'clips'>): number {
	const cached = durationCache.get(seq.clips);
	if (cached !== undefined) return cached;
	let end = 0;
	for (const c of Object.values(seq.clips)) end = Math.max(end, clipEnd(c));
	durationCache.set(seq.clips, end);
	return end;
}

export type Gap = { trackId: string; start: number; end: number };

/** Maximal empty ranges between frame 0 and the last clip of a track (S02:TL-019). */
function gapsOnTrack(seq: Sequence, trackId: string): Gap[] {
	const out: Gap[] = [];
	let cursor = 0;
	for (const c of clipsOnTrack(seq, trackId)) {
		if (c.start > cursor) out.push({ trackId, start: cursor, end: c.start });
		cursor = Math.max(cursor, clipEnd(c));
	}
	return out;
}

export function gapAt(seq: Sequence, trackId: string, frame: number): Gap | null {
	return gapsOnTrack(seq, trackId).find((g) => g.start <= frame && frame < g.end) ?? null;
}

/** Sorted unique clip boundaries on the given tracks (all tracks by default) (S02:TL-020, A.7). */
export function editPoints(seq: Sequence, trackIds?: readonly string[]): number[] {
	const ids = trackIds ?? allTracks(seq).map((t) => t.id);
	const set = new Set<number>();
	for (const id of ids) {
		for (const c of clipsOnTrack(seq, id)) {
			set.add(c.start);
			set.add(clipEnd(c));
		}
	}
	return [...set].sort((a, b) => a - b);
}

export function nextEditPoint(seq: Sequence, frame: number, trackIds?: readonly string[]): number | null {
	return editPoints(seq, trackIds).find((f) => f > frame) ?? null;
}

export function prevEditPoint(seq: Sequence, frame: number, trackIds?: readonly string[]): number | null {
	const pts = editPoints(seq, trackIds).filter((f) => f < frame);
	return pts.length ? pts[pts.length - 1]! : null;
}

// ---------------------------------------------------------------- links and groups

/** Link partners of a clip (excluding itself). */
export function linkedPartners(seq: Sequence, clipId: string): Clip[] {
	const c = seq.clips[clipId];
	if (!c?.linkId) return [];
	const link = seq.links[c.linkId];
	if (!link) return [];
	return link.members
		.filter((m) => m !== clipId)
		.map((m) => seq.clips[m]!)
		.filter(Boolean);
}

// ---------------------------------------------------------------- content time

/**
 * Content time (flicks) shown at timeline frame `f` (S01:CLP-004). May be fractional at non-unit speeds;
 * keyframe evaluation accepts fractional times.
 */
export function contentTimeAt(
	clip: Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'speed'>,
	frame: number,
	rate: Rational,
): number {
	const F = flicksPerFrame(rate);
	const i = frame - clip.start;
	if (clip.speed.reverse) return clip.sourceIn + (clip.duration - 1 - i) * F * clip.speed.rate;
	return clip.sourceIn + i * F * clip.speed.rate;
}

/** Source consumed by the clip, in flicks (S01:CLP-004 `contentSpan`, rounded to whole flicks). */
export function contentSpan(clip: Pick<Clip, 'duration' | 'speed'>, rate: Rational): number {
	return contentSpanFlicks(clip.duration, rate, clip.speed.rate);
}

/** Source out point (exclusive) in flicks. */
export function sourceOut(clip: Pick<Clip, 'duration' | 'speed' | 'sourceIn'>, rate: Rational): number {
	return clip.sourceIn + contentSpan(clip, rate);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether two clips show the same source (the identity a through edit continues): the same media stream, synthetic
 * source, nested sequence, transcript or composition; for generators drawn from inline data (text, shapes, motion
 * graphics) the same data. Unknown kinds never match.
 */
export function sameSource(a: Clip, b: Clip): boolean {
	if (a.kind !== b.kind) return false;
	const x = a as Record<string, unknown>;
	const y = b as Record<string, unknown>;
	switch (a.kind) {
		case 'video':
			return x.mediaId === y.mediaId && x.videoStreamIndex === y.videoStreamIndex;
		case 'audio':
			return x.mediaId === y.mediaId && same(x.channels, y.channels);
		case 'still':
		case 'animated-image':
			return x.mediaId === y.mediaId;
		case 'solid':
		case 'adjustment':
		case 'synthetic-audio':
			return x.syntheticId === y.syntheticId;
		case 'nest-video':
		case 'nest-audio':
			return x.sequenceId === y.sequenceId;
		case 'captions':
			return x.transcriptId === y.transcriptId;
		case 'composition':
			return same(x.composition, y.composition) && same(x.props, y.props) && same(x.canvas, y.canvas);
		case 'motion-graphic':
			return (
				same(x.template, y.template) &&
				same(x.params, y.params) &&
				same(x.paramKeyframes, y.paramKeyframes) &&
				same(x.canvas, y.canvas)
			);
		case 'text':
			return same(x.content, y.content) && same(x.box, y.box);
		case 'shape':
			return same(x.shape, y.shape);
		default:
			return false;
	}
}

/**
 * Through edit (S02:TL-021): `b` starts where `a` ends on the same track, shows the same source at the same speed and
 * direction (and the same frame hold), and continues `a`'s content. Content times are whole flicks while a frame at
 * non-unit speed spans a fractional number of flicks, so anything under half a source frame counts as continuous.
 */
export function isThroughEdit(a: Clip, b: Clip, rate: Rational): boolean {
	if (a.trackId !== b.trackId || clipEnd(a) !== b.start) return false;
	if (a.speed.rate !== b.speed.rate || a.speed.reverse !== b.speed.reverse) return false;
	if (!sameSource(a, b)) return false;
	const ha = (a as { frameHold?: unknown }).frameHold;
	const hb = (b as { frameHold?: unknown }).frameHold;
	if (ha || hb) return same(ha ?? null, hb ?? null);
	const tolerance = (flicksPerFrame(rate) * a.speed.rate) / 2;
	if (a.speed.reverse) return Math.abs(a.sourceIn - sourceOut(b, rate)) < tolerance;
	return Math.abs(b.sourceIn - sourceOut(a, rate)) < tolerance;
}


/**
 * Out-of-sync offsets (S01:CLP-011): for each linked clip from the same asset as its group's
 * reference member (the video member, else the first), the signed frame offset of its content origin.
 * Only non-zero offsets are returned.
 */
export function outOfSyncOffsets(seq: Sequence): Record<string, number> {
	const F = flicksPerFrame(seq.settings.frameRate);
	const origin = (c: Clip) => c.start - c.sourceIn / (F * c.speed.rate);
	const out: Record<string, number> = {};
	for (const link of Object.values(seq.links)) {
		const members = link.members.map((m) => seq.clips[m]).filter((c): c is Clip => !!c);
		const ref = members.find((c) => c.kind === 'video') ?? members[0];
		if (!ref) continue;
		const refMedia = (ref as { mediaId?: string }).mediaId;
		for (const c of members) {
			if (
				c === ref ||
				(c as { mediaId?: string }).mediaId !== refMedia ||
				c.speed.reverse !== ref.speed.reverse
			)
				continue;
			const off = Math.round(origin(c) - origin(ref));
			if (off !== 0) {
				out[c.id] = off;
				out[ref.id] = out[ref.id] ?? -off;
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------- usage

export type MediaUsage = { clips: number; sequences: string[] };

/** Clip usage per media asset across all sequences (S01:PRJ-008). */
export function mediaUsage(doc: ProjectDocument): Record<string, MediaUsage> {
	const out: Record<string, MediaUsage> = {};
	for (const seq of Object.values(doc.sequences)) {
		for (const c of Object.values(seq.clips)) {
			const m = (c as { mediaId?: string }).mediaId;
			if (!m) continue;
			const u = (out[m] ??= { clips: 0, sequences: [] });
			u.clips++;
			if (!u.sequences.includes(seq.id)) u.sequences.push(seq.id);
		}
	}
	return out;
}

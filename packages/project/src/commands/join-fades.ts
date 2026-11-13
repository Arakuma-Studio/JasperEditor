// Join micro-fades of cut audio (docs/wp-notes/transcript-cleanup.md "Join fades of range cuts"): when asked for, the
// faces a range cut leaves in an audio clip, and the hard audio joins of a track, get Clean Up's equal-power edge fades
// (`AudioClip.edgeFades`, spec 14 TC-024), which preview and every export path render as the same audio fades. Cuts are
// hard by default.

import { readEdgeFades } from '../audio-fade.ts';
import { JOIN_FADE_MS } from '../cleanup/schema.ts';
import { isThroughEdit } from '../derive/index.ts';
import type { Clip } from '../schema/sequence.ts';
import type { Rational } from '../time.ts';
import type { DClip, DSeq } from './context.ts';
import { end, type SplitRecord, trackClipIds } from './placement.ts';

export { JOIN_FADE_MS };

/** The sides of an audio clip that get a fade. */
export type FaceSides = { in?: true; out?: true };

const isAudio = (c: { kind: string } | undefined): c is DClip => c?.kind === 'audio';

/**
 * Before cutting `[from, to)` out of `trackIds`: the audio clips the cut will touch. The returned function, called
 * after the cut (before any shift) with the cut's split records, names the faces the cut made — the new out edge of a
 * piece ending at `from` and the new in edge of a piece starting at `to`. Clip edges the cut does not move are not
 * faces.
 */
export function audioCutFaces(
	seq: DSeq,
	trackIds: Iterable<string>,
	from: number,
	to: number,
): (splits: readonly SplitRecord[]) => Map<string, FaceSides> {
	const audio = new Set(seq.audioTracks.map((t) => t.id));
	const before = new Map<string, { start: number; end: number }>();
	for (const trackId of trackIds) {
		if (!audio.has(trackId)) continue;
		for (const id of trackClipIds(seq, trackId, (c) => c.kind === 'audio' && end(c) > from && c.start < to)) {
			const c = seq.clips[id]!;
			before.set(id, { start: c.start, end: end(c) });
		}
	}
	return (splits) => {
		const faces = new Map<string, FaceSides>();
		const mark = (id: string, side: 'in' | 'out') => faces.set(id, { ...faces.get(id), [side]: true });
		for (const [id, b] of before) {
			const c = seq.clips[id];
			if (!c) continue;
			if (b.start < from && end(c) === from) mark(id, 'out');
			if (b.end > to && c.start === to) mark(id, 'in');
		}
		for (const s of splits) if (before.size && isAudio(seq.clips[s.rightId])) mark(s.rightId, 'in');
		return faces;
	};
}

/**
 * Sets an `ms` edge fade on the given sides of audio clips (replacing a fade on that side unless `keep`, which only
 * fills sides without one). Returns the fades written.
 */
export function setJoinFades(
	seq: DSeq,
	faces: ReadonlyMap<string, FaceSides>,
	ms: number,
	keep = false,
): number {
	let n = 0;
	for (const [id, sides] of faces) {
		const c = seq.clips[id];
		if (!isAudio(c)) continue;
		const r = c as unknown as { edgeFades?: { inMs?: number; outMs?: number } };
		const cur = readEdgeFades(r.edgeFades);
		const fin = !!sides.in && !(keep && cur.inMs);
		const fout = !!sides.out && !(keep && cur.outMs);
		if (!fin && !fout) continue;
		r.edgeFades = { ...cur, ...(fin ? { inMs: ms } : {}), ...(fout ? { outMs: ms } : {}) };
		n += (fin ? 1 : 0) + (fout ? 1 : 0);
	}
	return n;
}

/** A hard audio join: `b` starts where `a` ends, both enabled audio clips, and `b` does not continue `a`'s sound. */
export function isHardAudioJoin(a: Clip, b: Clip, rate: Rational): boolean {
	return (
		a.kind === 'audio' &&
		b.kind === 'audio' &&
		a.enabled &&
		b.enabled &&
		end(a) === b.start &&
		!isThroughEdit(a, b, rate)
	);
}

/** Butt joins (`a` ends where `b` starts) of the clips on an audio track, in time order. */
export function trackJoins(seq: DSeq, trackId: string): Array<[DClip, DClip]> {
	const ids = trackClipIds(seq, trackId);
	const out: Array<[DClip, DClip]> = [];
	for (let i = 0; i + 1 < ids.length; i++) {
		const a = seq.clips[ids[i]!]!;
		const b = seq.clips[ids[i + 1]!]!;
		if (end(a) === b.start) out.push([a, b]);
	}
	return out;
}

/** Ids `a b` of a join. */
export const joinKey = (a: { id: string }, b: { id: string }) => `${a.id}\u0000${b.id}`;

/** Joins (`joinKey`) that a transition covers: an audio transition plays its own fades there. */
export function transitionJoins(seq: DSeq): Set<string> {
	const out = new Set<string>();
	for (const t of Object.values(seq.transitions))
		if (t.outgoingClipId && t.incomingClipId)
			out.add(joinKey({ id: t.outgoingClipId }, { id: t.incomingClipId }));
	return out;
}

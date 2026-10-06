// edit-ux: trim mode helpers shared by the Timeline, the Trim Monitor and agents. An edit point is one edge of a
// clip plus a trim type; Trim and Ripple act on that edge, Roll on the edge shared with the adjacent clip.
// Ported from FilmCraft crates/engine/src/trim.rs (`edit_time`, `roll_pair`, `select_nearest`, `sides`),
// MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors.
import type { Clip, Sequence } from '../schema/sequence.ts';

export type TrimType = 'regular' | 'ripple' | 'roll';
export type EditPoint = { clipId: string; edge: 'in' | 'out'; mode: TrimType };

/** Premiere's Toggle Trim Type order (FilmCraft `TrimKind::next`): Ripple → Roll → Trim → Ripple. */
export function nextTrimType(t: TrimType): TrimType {
	return t === 'ripple' ? 'roll' : t === 'roll' ? 'regular' : 'ripple';
}

const endOf = (c: Pick<Clip, 'start' | 'duration'>) => c.start + c.duration;

/** Sequence frame of an edit point, or null when its clip is gone. */
export function editPointFrame(seq: Sequence, p: Pick<EditPoint, 'clipId' | 'edge'>): number | null {
	const c = seq.clips[p.clipId];
	return c ? (p.edge === 'out' ? endOf(c) : c.start) : null;
}

/** The (outgoing, incoming) clips of a roll at this edit point, or null when nothing butts against it. */
export function rollPair(seq: Sequence, p: Pick<EditPoint, 'clipId' | 'edge'>): [string, string] | null {
	const c = seq.clips[p.clipId];
	if (!c) return null;
	for (const o of Object.values(seq.clips)) {
		if (o.trackId !== c.trackId || o.id === c.id) continue;
		if (p.edge === 'out' && o.start === endOf(c)) return [c.id, o.id];
		if (p.edge === 'in' && endOf(o) === c.start) return [o.id, c.id];
	}
	return null;
}

/** The outgoing and incoming clips around an edit point (one side may be a gap). */
export function trimSides(
	seq: Sequence,
	p: Pick<EditPoint, 'clipId' | 'edge'>,
): { outgoing: string | null; incoming: string | null } {
	const pair = rollPair(seq, p);
	if (pair) return { outgoing: pair[0], incoming: pair[1] };
	return p.edge === 'out' ? { outgoing: p.clipId, incoming: null } : { outgoing: null, incoming: p.clipId };
}

export type NearestKind = 'rippleIn' | 'rippleOut' | 'roll' | 'trimIn' | 'trimOut';

/**
 * Premiere's Select Nearest Edit Point as Ripple In / Ripple Out / Roll / Trim In / Trim Out (and Trim Edit, which
 * selects as Roll): the edit point nearest `frame` on each of `trackIds` (all tracks when empty), one per track;
 * a roll at a cut is selected once even when the cut shows on two tracks of one link group.
 */
export function nearestEditPoints(
	seq: Sequence,
	frame: number,
	kind: NearestKind,
	trackIds: readonly string[] = [],
): EditPoint[] {
	const mode: TrimType = kind === 'roll' ? 'roll' : kind.startsWith('ripple') ? 'ripple' : 'regular';
	const wantOut = kind === 'roll' ? null : kind.endsWith('Out');
	const tracks = [...seq.videoTracks, ...seq.audioTracks].filter(
		(t) => !t.locked && (trackIds.length === 0 || trackIds.includes(t.id)),
	);
	const points: EditPoint[] = [];
	for (const t of tracks) {
		let best: { d: number; p: EditPoint } | null = null;
		for (const c of Object.values(seq.clips)) {
			if (c.trackId !== t.id) continue;
			for (const edge of ['in', 'out'] as const) {
				if (wantOut !== null && wantOut !== (edge === 'out')) continue;
				const p: EditPoint = { clipId: c.id, edge, mode };
				if (mode === 'roll' && !rollPair(seq, p)) continue;
				const d = Math.abs((edge === 'out' ? endOf(c) : c.start) - frame);
				// Ties: the earlier edge, then the incoming side of a cut (a roll is stored on its outgoing clip).
				if (
					!best ||
					d < best.d ||
					(d === best.d && edge === 'out' && best.p.edge === 'in' && mode === 'roll')
				)
					best = { d, p };
			}
		}
		if (!best) continue;
		if (mode === 'roll') {
			const pair = rollPair(seq, best.p);
			const key = pair?.join('|');
			if (points.some((q) => rollPair(seq, q)?.join('|') === key)) continue;
			// Normalise a roll to the outgoing clip's Out edge.
			if (pair) best.p = { clipId: pair[0], edge: 'out', mode };
		}
		points.push(best.p);
	}
	return points;
}

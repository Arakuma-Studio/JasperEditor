// Pure gesture → command mapping (S02 §8, §10–§12). The controller feeds pointer state in; these
// functions compute deltas (rounding, snapping, clamping), selections and document commands.
import { type Clip, clipAt, clipsInRange, findTrack, type Sequence, trackList } from '@jasper/project';
import type { TrackAreaLayout } from './layout.ts';
import { findSnap, type SnapResult, type SnapTarget, thresholdFrames } from './snapping.ts';
import { deltaFramesFromPx, type Viewport, xToFrameExact } from './viewport.ts';

// ---------------------------------------------------------------- move (TL-480…491)

type MoveDeltaInput = {
	dxPx: number;
	pxPerFrame: number;
	starts: readonly number[];
	ends: readonly number[];
	targets: readonly SnapTarget[];
	snapping: boolean;
	pointerFrame?: number;
};

/** TL-482: delta per TL-101, then snapping (A.3), then clamping so nothing starts before frame 0. */
export function moveDelta(i: MoveDeltaInput): { delta: number; snap: SnapResult | null } {
	const raw = deltaFramesFromPx(i.dxPx, i.pxPerFrame);
	let delta = raw;
	let snap: SnapResult | null = null;
	if (i.snapping && i.targets.length) {
		const edges = [...i.starts.map((s) => s + raw), ...i.ends.map((e) => e + raw)];
		snap = findSnap(i.targets, edges, thresholdFrames(i.pxPerFrame), i.pointerFrame);
		if (snap) delta = raw + snap.offset;
	}
	const minStart = Math.min(...i.starts);
	if (minStart + delta < 0) {
		delta = -minStart;
		snap = null; // limits win over snapping (A.3 step 4)
	}
	return { delta, snap };
}

/** Snaps a single moving edge (trim, roll, slide, razor, scrub) (TL-453). */
export function snapEdge(
	edgeFrame: number,
	targets: readonly SnapTarget[],
	pxPerFrame: number,
	enabled: boolean,
): { frame: number; snap: SnapResult | null } {
	if (!enabled) return { frame: edgeFrame, snap: null };
	const snap = findSnap(targets, [edgeFrame], thresholdFrames(pxPerFrame));
	return snap ? { frame: edgeFrame + snap.offset, snap } : { frame: edgeFrame, snap: null };
}

/** TL-488: once Shift is held after the move started, keep only the larger axis so far. */
export function axisConstraint(dx: number, dy: number, shift: boolean): { dx: number; dy: number } {
	if (!shift) return { dx, dy };
	return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
}

type TrackKindKey = 'video' | 'audio';

function minimumTrackIndex(seq: Sequence, movingIds: readonly string[], kind: TrackKindKey): number {
	let minIdx = Number.POSITIVE_INFINITY;
	for (const id of movingIds) {
		const c = seq.clips[id];
		if (!c) continue;
		const f = findTrack(seq, c.trackId);
		if (f && f.track.kind === kind) minIdx = Math.min(minIdx, f.index);
	}
	return minIdx;
}

/**
 * TL-486/487: vertical offset for the grabbed side, clamped so no clip of that kind goes below index 0.
 * Moving beyond the top video / bottom audio track creates tracks on commit.
 */
export function clampTrackOffset(
	seq: Sequence,
	movingIds: readonly string[],
	kind: TrackKindKey,
	offset: number,
): number {
	const minIdx = minimumTrackIndex(seq, movingIds, kind);
	if (!Number.isFinite(minIdx)) return 0;
	return Math.max(-minIdx, Math.min(98, offset));
}

export type MoveMode = 'overwrite' | 'insert' | 'duplicate';

/** The document command for a move gesture (TL-483/484/485). */
export function moveCommand(
	seq: Sequence,
	movingIds: readonly string[],
	delta: number,
	kind: TrackKindKey,
	trackOffset: number,
	mode: MoveMode,
): Record<string, unknown> {
	if (mode === 'duplicate') {
		const cmd: Record<string, unknown> = {
			type: 'clip.duplicate',
			clipIds: [...movingIds],
			deltaFrames: delta,
		};
		if (trackOffset !== 0) {
			const minIdx = minimumTrackIndex(seq, movingIds, kind);
			if (Number.isFinite(minIdx))
				cmd.tracks = [`${kind === 'video' ? 'V' : 'A'}${minIdx + trackOffset + 1}`];
		}
		return cmd;
	}
	return {
		type: 'clip.move',
		clipIds: [...movingIds],
		deltaFrames: delta,
		deltaTracks: { [kind]: trackOffset },
		mode,
		createTracks: true,
		// edit-structure: the selection already holds whole groups (Alt-click picks one member).
		groups: false,
	};
}

export function moveLabel(mode: MoveMode, count: number): string {
	if (mode === 'insert') return 'Insert Move';
	if (mode === 'duplicate') return 'Duplicate';
	return count === 1 ? 'Move Clip' : `Move ${count} Clips`;
}

// ---------------------------------------------------------------- selection (TL-401…406)

export type MarqueeRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * TL-404: clips whose rectangle intersects the marquee (any overlap, 1 px clips included), excluding
 * locked tracks. Hit testing uses the per-track interval index, not the DOM.
 */
export function marqueeHits(seq: Sequence, layout: TrackAreaLayout, v: Viewport, r: MarqueeRect): string[] {
	const xa = Math.min(r.x0, r.x1);
	const xb = Math.max(r.x0, r.x1);
	const ya = Math.min(r.y0, r.y1);
	const yb = Math.max(r.y0, r.y1);
	const f0 = xToFrameExact(v, xa);
	const f1 = xToFrameExact(v, xb);
	const out: string[] = [];
	for (const row of [...layout.video.rows, ...layout.audio.rows]) {
		if (row.y >= yb || row.y + row.height <= ya) continue;
		const f = findTrack(seq, row.trackId);
		if (!f || f.track.locked) continue;
		for (const c of clipsInRange(seq, row.trackId, Math.floor(f0), Math.ceil(f1) + 1)) {
			if (c.start < f1 && c.start + c.duration > f0) out.push(c.id);
		}
	}
	return out;
}

/** Shift-marquee toggles relative to the selection at marquee start (TL-404). */
export function toggleAgainst(base: readonly string[], hits: readonly string[]): string[] {
	const set = new Set(base);
	for (const id of hits) {
		if (set.has(id)) set.delete(id);
		else set.add(id);
	}
	return [...set];
}

/** TL-605: track select forward/backward from frame `f` on the given (unlocked) tracks. */
export function trackSelectClips(
	seq: Sequence,
	frame: number,
	direction: 'forward' | 'backward',
	trackIds: readonly string[],
): string[] {
	const out: string[] = [];
	for (const id of trackIds) {
		for (const c of Object.values(seq.clips)) {
			if (c.trackId !== id) continue;
			if (direction === 'forward' ? c.start + c.duration > frame : c.start < frame) out.push(c.id);
		}
	}
	return out;
}

/** TL-406: topmost clip under the playhead on each targeted track (all tracks when none targeted). */
export function clipsAtPlayhead(seq: Sequence, frame: number, trackIds: readonly string[]): string[] {
	const out: string[] = [];
	for (const id of trackIds) {
		const c = clipAt(seq, id, frame);
		if (c) out.push(c.id);
	}
	return out;
}

export function unlockedTrackIds(
	seq: Sequence,
	kinds: readonly TrackKindKey[] = ['video', 'audio'],
): string[] {
	return kinds.flatMap((k) =>
		trackList(seq, k)
			.filter((t) => !t.locked)
			.map((t) => t.id),
	);
}

// ---------------------------------------------------------------- trim monitor payloads (TL-538, TL-626, TL-631)

export type TrimPreview =
	| {
			mode: 'trim';
			outgoingClipId: string | null;
			outgoingFrame: number | null;
			incomingClipId: string | null;
			incomingFrame: number | null;
	  }
	| {
			mode: 'slip' | 'slide';
			clipId: string;
			/** Four-up: previous clip's (new) out frame, next clip's (new) in frame, this clip's first and last. */
			prevClipId: string | null;
			prevFrame: number | null;
			nextClipId: string | null;
			nextFrame: number | null;
			firstFrame: number;
			lastFrame: number;
	  };

const endOf = (c: Clip) => c.start + c.duration;

/** Two-up payload for a trim/roll at `clip.edge` in the drawn (transient) sequence. */
export function trimPreview(seq: Sequence, clipId: string, edge: 'in' | 'out'): TrimPreview | null {
	const c = seq.clips[clipId];
	if (!c) return null;
	if (edge === 'out') {
		const end = endOf(c);
		const next = clipAt(seq, c.trackId, end);
		const touching = next && next.start === end;
		return {
			mode: 'trim',
			outgoingClipId: c.id,
			outgoingFrame: end - 1,
			incomingClipId: touching ? next.id : null,
			incomingFrame: touching ? next.start : null,
		};
	}
	const prev = c.start > 0 ? clipAt(seq, c.trackId, c.start - 1) : undefined;
	const touching = prev && endOf(prev) === c.start;
	return {
		mode: 'trim',
		outgoingClipId: touching ? prev.id : null,
		outgoingFrame: touching ? c.start - 1 : null,
		incomingClipId: c.id,
		incomingFrame: c.start,
	};
}

/** Four-up payload for slip/slide in the drawn sequence. */
export function fourUpPreview(seq: Sequence, clipId: string, mode: 'slip' | 'slide'): TrimPreview | null {
	const c = seq.clips[clipId];
	if (!c) return null;
	const prev = c.start > 0 ? clipAt(seq, c.trackId, c.start - 1) : undefined;
	const next = clipAt(seq, c.trackId, endOf(c));
	return {
		mode,
		clipId: c.id,
		prevClipId: prev?.id ?? null,
		prevFrame: prev ? endOf(prev) - 1 : null,
		nextClipId: next?.id ?? null,
		nextFrame: next ? next.start : null,
		firstFrame: c.start,
		lastFrame: endOf(c) - 1,
	};
}

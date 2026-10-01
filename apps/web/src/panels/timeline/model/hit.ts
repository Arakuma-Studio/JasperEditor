// Hit testing on the model (not the DOM): clip bodies, edge zones, gaps, new-track zones
// (S02:TL-154, TL-402, TL-531; hit-testing uses the interval index, TL-404).
import { type Clip, clipAt, type Gap, gapAt, type Sequence } from '@jasper/project';
import { hitY, type RegionKind, type TrackAreaLayout, type TrackRow } from './layout.ts';
import { hitTransition, type TransitionHit, type TransitionIndex } from './transitions.ts';
import { frameToX, type Viewport, xToFrameExact } from './viewport.ts';

/** TL-531: edge zone width measured inside the clip (also used by clip decorations, e.g. tracker strips). */
export function edgeZonePx(clipWidthPx: number): number {
	return Math.min(8, Math.max(3, clipWidthPx / 4));
}

type EdgeZone = 'body' | 'in' | 'out';

export type Hit =
	| { kind: 'clip'; clip: Clip; zone: EdgeZone; row: TrackRow; frame: number }
	| { kind: 'gap'; gap: Gap; row: TrackRow; frame: number }
	| { kind: 'empty'; row: TrackRow; frame: number }
	| { kind: 'new-track'; region: RegionKind; frame: number }
	| { kind: 'none'; frame: number }
	/** S10:TUI-010: a transition edge or body, over whatever lies underneath (`under`). */
	| { kind: 'transition'; transition: TransitionHit; row: TrackRow; frame: number; under: Hit };

/**
 * Hit test at clip-area x / track-area y. With a transition index, transition edges and bodies win over
 * clip edges and bodies (S10:TUI-010); the clip hit underneath is kept in `under` for the other tools.
 */
export function hitTest(
	seq: Sequence,
	layout: TrackAreaLayout,
	v: Viewport,
	x: number,
	y: number,
	transitions?: TransitionIndex,
): Hit {
	const frame = xToFrameExact(v, x);
	const yh = hitY(layout, y);
	if (yh.kind === 'above-video' || yh.kind === 'below-audio')
		return { kind: 'new-track', region: yh.region, frame };
	if (yh.kind !== 'track') return { kind: 'none', frame };
	const row = yh.row;
	const under = clipHit(seq, row, v, x, frame);
	if (transitions) {
		const t = hitTransition(transitions, row, v, x, y - row.y);
		if (t) return { kind: 'transition', transition: t, row, frame, under };
	}
	return under;
}

function clipHit(seq: Sequence, row: TrackRow, v: Viewport, x: number, frame: number): Hit {
	const clip = clipAt(seq, row.trackId, Math.floor(frame));
	if (clip) {
		const x0 = frameToX(v, clip.start);
		const x1 = frameToX(v, clip.start + clip.duration);
		const w = x1 - x0;
		// TL-154: clips under 2 px have no hit target of their own (marquee still selects them).
		if (w < 2) return { kind: 'empty', row, frame };
		const zone = edgeZonePx(w);
		const z: EdgeZone = x - x0 < zone ? 'in' : x1 - x < zone ? 'out' : 'body';
		return { kind: 'clip', clip, zone: z, row, frame };
	}
	// Edge zones only live inside clips, but a pointer just outside a clip edge at a gap still
	// targets nothing: the empty space is a gap or the area after the last clip.
	const gap = gapAt(seq, row.trackId, Math.floor(frame));
	if (gap) return { kind: 'gap', gap, row, frame };
	return { kind: 'empty', row, frame };
}

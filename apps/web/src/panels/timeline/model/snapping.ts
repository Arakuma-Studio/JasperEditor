// Snapping (S02 §9: TL-450…455, Appendix A.3).
import type { Sequence } from '@jasper/project';

export type SnapKind = 'playhead' | 'marker' | 'inout' | 'clip' | 'zero';
export type SnapTarget = { frame: number; kind: SnapKind; priority: number; sourceId?: string };

/** TL-453 tie-break priority: playhead > marker > In/Out > clip edge > frame 0. */
const SNAP_PRIORITY: Record<SnapKind, number> = { playhead: 5, marker: 4, inout: 3, clip: 2, zero: 1 };
const SNAP_THRESHOLD_PX = 8;

/** Collects targets at gesture begin, excluding the manipulated clips (and their partners) (TL-451). */
export function collectSnapTargets(
	seq: Sequence,
	opts: { exclude?: ReadonlySet<string>; playhead?: number | null; includeClips?: boolean } = {},
): SnapTarget[] {
	const out: SnapTarget[] = [{ frame: 0, kind: 'zero', priority: SNAP_PRIORITY.zero }];
	if (opts.playhead !== undefined && opts.playhead !== null)
		out.push({ frame: opts.playhead, kind: 'playhead', priority: SNAP_PRIORITY.playhead });
	if (opts.includeClips !== false) {
		for (const c of Object.values(seq.clips)) {
			if (opts.exclude?.has(c.id)) continue;
			out.push({ frame: c.start, kind: 'clip', priority: SNAP_PRIORITY.clip, sourceId: c.id });
			out.push({ frame: c.start + c.duration, kind: 'clip', priority: SNAP_PRIORITY.clip, sourceId: c.id });
		}
	}
	for (const m of seq.markers) {
		out.push({ frame: m.frame, kind: 'marker', priority: SNAP_PRIORITY.marker, sourceId: m.id });
		if (m.duration > 0)
			out.push({
				frame: m.frame + m.duration,
				kind: 'marker',
				priority: SNAP_PRIORITY.marker,
				sourceId: m.id,
			});
	}
	if (seq.inPoint !== null) out.push({ frame: seq.inPoint, kind: 'inout', priority: SNAP_PRIORITY.inout });
	if (seq.outPoint !== null) out.push({ frame: seq.outPoint, kind: 'inout', priority: SNAP_PRIORITY.inout });
	if (seq.workArea) {
		out.push({ frame: seq.workArea.start, kind: 'inout', priority: SNAP_PRIORITY.inout });
		out.push({ frame: seq.workArea.end, kind: 'inout', priority: SNAP_PRIORITY.inout });
	}
	out.sort((a, b) => a.frame - b.frame || b.priority - a.priority);
	// One target per frame (the highest priority), so the two neighbours of a binary search suffice.
	return out.filter((t, i) => i === 0 || out[i - 1]!.frame !== t.frame);
}

function lowerBound(targets: readonly SnapTarget[], frame: number): number {
	let lo = 0;
	let hi = targets.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (targets[mid]!.frame < frame) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export type SnapResult = { offset: number; target: SnapTarget; edge: number };

/**
 * A.3: for each moving edge frame (after the raw delta), find the nearest target by binary search; the
 * smallest distance within the threshold wins, then target priority, then the edge closest to the pointer.
 */
export function findSnap(
	targets: readonly SnapTarget[],
	edges: readonly number[],
	thresholdFrames: number,
	pointerFrame?: number,
): SnapResult | null {
	let best: SnapResult | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const e of edges) {
		const i = lowerBound(targets, e);
		for (let j = Math.max(0, i - 1); j < Math.min(targets.length, i + 1); j++) {
			const t = targets[j]!;
			const d = Math.abs(t.frame - e);
			if (d > thresholdFrames) continue;
			const better =
				!best ||
				d < bestDist ||
				(d === bestDist && t.priority > best.target.priority) ||
				(d === bestDist &&
					t.priority === best.target.priority &&
					pointerFrame !== undefined &&
					Math.abs(e - pointerFrame) < Math.abs(best.edge - pointerFrame));
			if (better) {
				best = { offset: t.frame - e, target: t, edge: e };
				bestDist = d;
			}
		}
	}
	return best;
}

export function thresholdFrames(pxPerFrame: number, px = SNAP_THRESHOLD_PX): number {
	return px / pxPerFrame;
}

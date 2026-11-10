// Parallel picture segments of a native / hybrid export (docs/wp-notes/export-performance.md). One ffmpeg filter graph
// runs its overlays one frame at a time on few threads, and every frame passes every overlay of the range (`enable=`
// skips drawing, not the traversal): a 15 min sequence with ≈ 2,000 layers encoded at ≈ 73 fps with more than half the
// CPU idle (measured on the user's PC, see the note). The range is split into frame-exact segments, each built as an
// export of its own sub-range (`buildNativeGraph` with `snapshot.range` = the segment: only the layers it shows, each
// started mid-layer exactly as a range export starts), encoded concurrently and joined by stream copy (concat
// demuxer: timestamps continue from each segment's duration; every segment starts with a key frame).
import type { RenderSnapshot } from '@jasper/project';

export type PictureSegment = { start: number; end: number };

/** Top-level visual layers (clips with their handles, mattes) of the busiest segment: the plan's overlay estimate. */
export function layersPerSegment(snap: RenderSnapshot, segments: readonly PictureSegment[]): number {
	let most = 0;
	for (const s of segments) {
		let n = 0;
		for (const t of snap.videoTracks) {
			for (const c of t.clips) {
				const f0 = c.start - (c.headHandle ?? 0);
				const f1 = c.start + c.duration + (c.tailHandle ?? 0);
				if (f1 > s.start && f0 < s.end) n++;
			}
			for (const m of t.mattes ?? []) if (m.start + m.duration > s.start && m.start < s.end) n++;
		}
		most = Math.max(most, n);
	}
	return most;
}

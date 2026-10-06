// Trackers of GPU transition sides (wave-4 transition polish; docs/wp-notes/fx-transition-framework.md §5): a side
// clip's planar / point tracker, evaluated for every frame of the transition span and mapped into SEQUENCE pixels the
// way the side's picture is placed (its layer map at that frame: Motion + corner pin). The snapshot attaches the
// result to the `RenderTransition` (`tracks`), so the stage, the Player, renders and the hybrid export's span bakes
// (whose cache key hashes the transition) all see the same geometry. Pure.
import type { TrSideTrack, TrTrackFrame } from '../registry/transitions/shader.ts';
import { applyMat3, type Quad } from '../render/homography.ts';
import { clipContentTime, layerMapOf, resolveLayerProps } from '../render/scene.ts';
import type { RenderVisualClip } from '../render/snapshot.ts';
import type { Vec2 } from '../schema/common.ts';
import type { ClipTracker } from '../schema/sequence.ts';
import type { Rational } from '../time.ts';
import { quadCentre } from './apply.ts';
import { sampleCount, trackerGeometryAt } from './samples.ts';

/**
 * The tracker a transition follows on a side clip: the first planar tracker with samples, else the first point
 * tracker with samples, else the first tracker (its reference geometry); null without trackers.
 */
export function transitionTrackerOf(trackers: readonly ClipTracker[] | undefined): ClipTracker | null {
	const list = trackers ?? [];
	const tracked = (t: ClipTracker) => !!t.samples && sampleCount(t.samples) > 0;
	return (
		list.find((t) => t.kind === 'planar' && tracked(t)) ??
		list.find((t) => tracked(t)) ??
		list.find((t) => (t.kind === 'planar' ? !!t.reference.corners : !!t.reference.point)) ??
		null
	);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/**
 * A side's tracker over the span `[start, start + duration)` (sequence frames) in sequence pixels. `layer` is the
 * side's render clip (timing, Motion, effects incl. corner pin, intrinsic box = media px of the tracked source).
 */
export function transitionSideTrack(
	layer: Pick<
		RenderVisualClip,
		'start' | 'duration' | 'sourceIn' | 'speed' | 'transform' | 'opacity' | 'effects' | 'intrinsicBox'
	>,
	tracker: ClipTracker,
	span: { start: number; duration: number },
	fps: Rational,
): TrSideTrack {
	const frames: TrTrackFrame[] = [];
	for (let i = 0; i < span.duration; i++) {
		const t = Math.round(clipContentTime(layer, span.start + i, fps));
		const g = trackerGeometryAt(tracker, t);
		const M = layerMapOf(resolveLayerProps(layer as RenderVisualClip, t));
		const map = (p: readonly number[]): [number, number] => {
			const q = applyMat3(M, [p[0]!, p[1]!]);
			return [r3(q[0]), r3(q[1])];
		};
		const corners = g.corners ? (g.corners.map(map) as [number, number][]) : null;
		const point: [number, number] = corners
			? (quadCentre(corners as unknown as Quad).map(r3) as [number, number])
			: map((g.point ?? [layer.intrinsicBox.width / 2, layer.intrinsicBox.height / 2]) as Vec2);
		frames.push({ kind: tracker.kind, corners, point, confidence: r3(g.confidence), tracked: g.tracked });
	}
	return { trackerId: tracker.id, name: tracker.name, kind: tracker.kind, frames };
}

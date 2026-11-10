// Compositing a downscaled export at its output size (docs/wp-notes/export-performance.md §7). A 1080p sequence
// exported at 720p used to be composited at 1920×1080 and scaled at the end; ≈ 1.8× the per-frame work of a 1280×720
// composite (measured). On the output-size canvas every layer keeps its picture in layer pixels — the source scaled to
// its box, effects, masks and crops in the box — and only its placement is scaled about the frame origin: Position,
// Scale and Scale Width × s (`RenderVisualClip.outputScale`, applied by `resolveLayerProps`), so the layer matrix is
// s × the sequence-space one and the Motion resample goes straight from the source to the output size. Pictures placed
// in sequence pixels (baked masters, transition spans) are scaled with their rectangles, which must land on whole
// output pixels (`native.ts` reports any that do not, and the export is composited at the sequence size then).
import type { RenderSnapshot } from '@jasper/project';
import type { OutputSpec } from './planner.ts';

export type CompositeSizePlan = {
	size: 'output' | 'sequence';
	/** Output size ÷ sequence size (1 at the sequence size). */
	scale: number;
	/** Why a downscaled export is composited at the sequence size (empty otherwise). */
	fallbackReasons: string[];
};

/** Whether the export composites at its output size, and why not. */
export function planCompositeSize(
	snap: RenderSnapshot,
	output: OutputSpec,
	opts: { still?: boolean; env?: Record<string, string | undefined> } = {},
): CompositeSizePlan {
	const W = snap.settings.width;
	const H = snap.settings.height;
	const seq = (fallbackReasons: string[] = []): CompositeSizePlan => ({
		size: 'sequence',
		scale: 1,
		fallbackReasons,
	});
	if (opts.still || output.alpha) return seq();
	if (output.width >= W && output.height >= H) return seq();
	const env = opts.env ?? process.env;
	if (env.JASPER_EXPORT_COMPOSITE_SIZE === 'sequence')
		return seq(['composited at the sequence size (JASPER_EXPORT_COMPOSITE_SIZE=sequence)']);
	const reasons: string[] = [];
	if (output.width * H !== output.height * W)
		reasons.push(
			'the output aspect ratio differs from the sequence (fitted or filled into the output frame)',
		);
	const adjustments = snap.videoTracks.flatMap((t) => t.clips).filter((c) => c.kind === 'adjustment');
	if (adjustments.length)
		reasons.push(
			`${adjustments.length} adjustment layer${adjustments.length === 1 ? '' : 's'} process the sequence-size composite`,
		);
	if (reasons.length) return seq(reasons);
	return { size: 'output', scale: output.width / W, fallbackReasons: [] };
}

/** The snapshot drawn on the output-size canvas: the frame size scaled, every top-level clip placed × `scale`. */
export function outputSizeSnapshot(snap: RenderSnapshot, plan: CompositeSizePlan): RenderSnapshot {
	if (plan.size !== 'output') return snap;
	const s = plan.scale;
	return {
		...snap,
		settings: {
			...snap.settings,
			width: Math.round(snap.settings.width * s),
			height: Math.round(snap.settings.height * s),
		},
		videoTracks: snap.videoTracks.map((t) => ({
			...t,
			clips: t.clips.map((c) => ({ ...c, outputScale: s })),
		})),
	};
}

/** A rectangle in sequence pixels on the output-size canvas: exact when it lands on whole output pixels, else null. */
export function scaledRect(
	r: { x: number; y: number; w: number; h: number },
	s: number,
): { x: number; y: number; w: number; h: number } | null {
	const v = [r.x * s, r.y * s, r.w * s, r.h * s];
	if (v.some((x) => Math.abs(x - Math.round(x)) > 1e-6)) return null;
	const [x, y, w, h] = v.map(Math.round) as [number, number, number, number];
	return { x, y, w, h };
}

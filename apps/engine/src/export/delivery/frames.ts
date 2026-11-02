// Spec 19 §12: render documents for delivery. A frame's snapshot narrowed to some clips (PSD layers, Export Title) or
// re-framed on a larger canvas, so a title's glow past the frame edge is rendered. Pure functions over the snapshot.
import { hasActiveExpression, type RenderSnapshot, type RenderVisualClip } from '@jasper/project';
import { shiftedClip } from '../../layer-bake/layer.ts';

type Tracks = RenderSnapshot['videoTracks'];

/** The clips of `ids` only; a transition stays when its sides do. Tracks left empty go. */
export function onlyClips(doc: RenderSnapshot, ids: ReadonlySet<string>): RenderSnapshot {
	const videoTracks: Tracks = [];
	for (const t of doc.videoTracks) {
		const clips = t.clips.filter((c) => ids.has(c.clipId));
		if (!clips.length) continue;
		const transitions = (t.transitions ?? []).filter(
			(tr) =>
				(!tr.outgoingClipId || ids.has(tr.outgoingClipId)) && (!tr.incomingClipId || ids.has(tr.incomingClipId)),
		);
		videoTracks.push({ ...t, clips, transitions, ...(t.mattes ? { mattes: [] } : {}) });
	}
	return { ...doc, videoTracks };
}

/** A copy of the clip drawn in Normal at full Opacity: the PSD layer carries both. */
export function neutralClip(c: RenderVisualClip): RenderVisualClip {
	return { ...c, blendMode: 'normal', opacity: { value: 100, keyframes: [] } };
}

/** Whether a clip's Opacity is a plain value or keys the PSD layer can take over (an expression stays in the pixels). */
export const opacityIsPortable = (c: Pick<RenderVisualClip, 'opacity'>) => !hasActiveExpression(c.opacity);

/**
 * The document on a canvas grown by `pad` px on each side: every clip moves by `pad`, so a pixel at (x, y) of the
 * sequence is at (x + pad, y + pad). Pre-rendered pictures in sequence space move with their clips.
 */
export function onLargerCanvas(doc: RenderSnapshot, pad: number): RenderSnapshot {
	if (pad <= 0) return doc;
	const { width, height } = doc.settings;
	const by = { x: -pad, y: -pad };
	const move = (c: RenderVisualClip): RenderVisualClip => {
		const moved = shiftedClip(c, by);
		if (!moved.baked) return moved;
		const rect = moved.baked.rect;
		return {
			...moved,
			baked: {
				...moved.baked,
				rect: rect ? { ...rect, x: rect.x + pad, y: rect.y + pad } : { x: pad, y: pad, w: width, h: height },
			},
		};
	};
	return {
		...doc,
		settings: { ...doc.settings, width: width + 2 * pad, height: height + 2 * pad },
		videoTracks: doc.videoTracks.map((t) => ({ ...t, clips: t.clips.map(move) })),
		...(doc.matteTracks
			? { matteTracks: doc.matteTracks.map((t) => ({ ...t, clips: t.clips.map(move) })) }
			: {}),
	};
}

/** Three-d scenes project through the canvas: a larger canvas would show another picture. */
export const drawsIn3d = (doc: RenderSnapshot) =>
	!!doc.scene3d || doc.videoTracks.some((t) => t.clips.some((c) => c.threeD));

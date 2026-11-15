import type { CalculateMetadataFunction } from 'remotion';
import type { RenderDoc, SequenceCompositionProps } from './types.ts';

/** Duration, fps and size of a document's render (S01:RND-002). Never zero frames. */
export function sequenceMetadata(doc: Pick<RenderDoc, 'settings' | 'durationFrames'>) {
	const { settings, durationFrames } = doc;
	return {
		durationInFrames: Math.max(1, durationFrames),
		fps: settings.fps.num / settings.fps.den,
		width: settings.width,
		height: settings.height,
	};
}

/** Duration, fps and size come from the document (S01:RND-002). Never zero frames. */
export const calculateSequenceMetadata: CalculateMetadataFunction<SequenceCompositionProps> = ({ props }) =>
	sequenceMetadata(props.doc);

/** CSS color for an RGBA float tuple (straight sRGB 0..1). */
export function rgbaCss([r, g, b, a]: readonly [number, number, number, number]): string {
	const c = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
	return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.min(1, Math.max(0, a))})`;
}

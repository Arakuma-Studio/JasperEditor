// Still and animated-image layers (S03:KND-030/040). Remotion <Img> waits for decode in renders.
// Animated images are shown with the browser's own animation in M1 (frame-accurate GIF/WebP playback
// honoring sourceIn/speed is KND-040, M2).
import { Img } from 'remotion';
import { mediaSrc } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

const MEDIA_STYLE = { width: '100%', height: '100%', display: 'block', objectFit: 'fill' } as const;

export function StillLayer(layer: LayerProps) {
	const { media, options } = layer;
	if (!media) return null;
	return (
		<LayerBox layer={layer}>
			<Img src={mediaSrc(media, options)} style={MEDIA_STYLE} alt="" />
		</LayerBox>
	);
}

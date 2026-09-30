// Video layer — stub from WP-00; WP-2C replaces the body with the real renderer.
import type { LayerProps } from '../types.ts';
import { StubLabel } from './LayerBox.tsx';

export function VideoLayer(layer: LayerProps) {
	return <StubLabel layer={layer} title="Video" tint="rgba(0, 75, 104, 0.85)" />;
}

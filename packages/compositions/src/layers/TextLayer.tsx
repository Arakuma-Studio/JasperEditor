// Text layer — stub from WP-00; WP-2C replaces the body with the real renderer.
import type { LayerProps } from '../types.ts';
import { StubLabel } from './LayerBox.tsx';

export function TextLayer(layer: LayerProps) {
	return <StubLabel layer={layer} title="Text" tint="rgba(116, 17, 134, 0.6)" />;
}

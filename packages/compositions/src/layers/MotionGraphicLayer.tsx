// Motion-graphic layer — stub from WP-00; WP-2G owns this file and renders the template's SVG twin.
import type { LayerProps } from '../types.ts';
import { StubLabel } from './LayerBox.tsx';

export function MotionGraphicLayer(layer: LayerProps) {
	const title =
		'mg' in layer.clip.source ? `Motion graphic: ${layer.clip.source.mg.template.id}` : 'Motion graphic';
	return <StubLabel layer={layer} title={title} tint="rgba(98, 0, 183, 0.6)" />;
}

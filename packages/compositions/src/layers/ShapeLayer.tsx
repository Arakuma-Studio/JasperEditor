// Shape layer (M2, S11:SHP-004) — owned by wp-m2-shapes, which draws the geometry as inline SVG
// (`@remotion/shapes` makeRect / makeEllipse) with keyframes evaluated per frame. Contracts: a grey placeholder
// box of the intrinsic box through LayerBox, so Motion, opacity, blend and effects already apply.
// Inline styles only (ARCHITECTURE D-14).
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

export function ShapeLayer(layer: LayerProps) {
	const type = 'shape' in layer.clip.source ? layer.clip.source.shape.type : 'shape';
	return (
		<LayerBox
			layer={layer}
			style={{
				background: 'rgba(128, 128, 128, 0.6)',
				borderRadius: type === 'ellipse' ? '50%' : 0,
			}}
		>
			<div data-shape-placeholder={type} style={{ position: 'absolute', inset: 0 }} />
		</LayerBox>
	);
}

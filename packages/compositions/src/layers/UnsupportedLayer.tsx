// Clip kinds this build cannot render yet (captions, nests, adjustment…; S01:KND-030).
// Drawn as a neutral hatched card so the layer's geometry stays visible.
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

export function UnsupportedLayer(layer: LayerProps) {
	const h = layer.props.box.height;
	return (
		<LayerBox
			layer={layer}
			style={{
				background:
					'repeating-linear-gradient(45deg, rgba(90,90,90,0.55) 0 12px, rgba(60,60,60,0.55) 12px 24px)',
			}}
		>
			<div
				data-unsupported={layer.clip.kind}
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					color: 'rgba(255,255,255,0.85)',
					fontFamily: '"Source Sans 3", Arial, sans-serif',
					fontSize: Math.max(12, Math.min(40, h / 14)),
				}}
			>
				Not supported in this version: {layer.clip.kind}
			</div>
		</LayerBox>
	);
}

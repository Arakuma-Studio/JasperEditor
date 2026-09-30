// Solid (color matte) layer: the matte color fills the intrinsic box (S01:KND-007).
import { rgbaCss } from '../metadata.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

export function SolidLayer(layer: LayerProps) {
	const color =
		'color' in layer.clip.source
			? layer.clip.source.color
			: ([0, 0, 0, 1] as [number, number, number, number]);
	return <LayerBox layer={layer} style={{ background: rgbaCss(color) }} />;
}

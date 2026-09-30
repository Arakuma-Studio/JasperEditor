// Solid (color matte) layer: the matte color fills the intrinsic box (S01:KND-007).
// M2 colour (S06): colour runs are applied to the matte colour itself (baked LUT, same maths as lut3d).
import { useGradedSolid } from '../color/chain.ts';
import { rgbaCss } from '../metadata.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

const BLACK: [number, number, number, number] = [0, 0, 0, 1];

export function SolidLayer(layer: LayerProps) {
	const color = 'color' in layer.clip.source ? layer.clip.source.color : BLACK;
	const graded = useGradedSolid(layer.clip.clipId, layer.props.effects, color);
	return <LayerBox layer={layer} effects={graded.cssEffects} style={{ background: rgbaCss(graded.rgba) }} />;
}

// Clip kinds this build cannot render yet (captions, compositions, nests…; S01:KND-030) — stub.
import type { LayerProps } from '../types.ts';
import { StubLabel } from './LayerBox.tsx';

export function UnsupportedLayer(layer: LayerProps) {
	return <StubLabel layer={layer} title={`Unsupported: ${layer.clip.kind}`} tint="rgba(90, 90, 90, 0.7)" />;
}

// Composition clip layer (M2, S08:MGC-040…046). Owner: wp-m2-mg.
// Preview: the pre-rendered VP9-alpha preview of the current props when cached, else the live frame host
// (the bundle's own Remotion page in an iframe, driven frame by frame). Renders (Remotion path): the ProRes
// 4444 master through <OffthreadVideo transparent>. Placeholder until the work package lands.
import type { LayerProps } from '../types.ts';
import { StubLabel } from './LayerBox.tsx';

export function CompositionLayer(layer: LayerProps) {
	const source = layer.clip.source;
	const title = 'composition' in source ? `Composition · ${source.composition.compositionId}` : 'Composition';
	return <StubLabel layer={layer} title={title} tint="rgba(90, 60, 160, 0.55)" />;
}

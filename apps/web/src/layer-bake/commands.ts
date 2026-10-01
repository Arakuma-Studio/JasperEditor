// Register the Program overlay that attaches the graded-preview runtime of DOM layers.
import { programOverlays } from '../extensions/index.ts';
import { LayerBakeRuntimeHost } from './RuntimeHost.tsx';

programOverlays.register({
	id: 'layer-bake-runtime',
	active: () => true,
	component: LayerBakeRuntimeHost,
	order: 0,
});

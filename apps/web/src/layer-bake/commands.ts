// Layer bake in the editor (M2, S11:LBK-010; owner wp-m2-layer-bake). No UI commands: this module is imported at
// start-up (commands/index.ts) to register the Program overlay that attaches the graded-preview runtime of DOM
// layers (text, shapes, anime templates with colour effects).
import type { UiCommand } from '../commands/types.ts';
import { programOverlays } from '../extensions/index.ts';
import { LayerBakeRuntimeHost } from './RuntimeHost.tsx';

export const layerBakeCommands: UiCommand[] = [];

programOverlays.register({
	id: 'layer-bake-runtime',
	active: () => true,
	component: LayerBakeRuntimeHost,
	order: 0,
});

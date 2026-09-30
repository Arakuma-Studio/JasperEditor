// Effects panel (WP-2D): the effect catalogue; drag onto clips or double-click to apply (S05:EFX).

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const definition: PanelDefinition = {
	kind: 'effects',
	title: () => 'Effects',
	icon: 'panel.effects',
	instance: 'single',
	minSize: { w: 200, h: 160 },
	keymapScope: 'effects',
	menu: [{ type: 'command', command: 'inspector.applyEffect', label: 'Apply to Selected Clips' }],
	touch: 'sheet',
	agentDescription: 'Catalog of video/audio effects and transitions to apply to clips.',
	component: lazyPanel(() => import('./EffectsPanel.tsx'), 'EffectsPanel'),
};

export default definition;

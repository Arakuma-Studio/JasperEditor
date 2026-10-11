import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const info: PanelDefinition = {
	kind: 'info',
	title: () => 'Info',
	icon: 'panel.info',
	instance: 'single',
	minSize: { w: 200, h: 120 },
	keymapScope: 'info',
	touch: 'hidden',
	agentDescription: 'Details of the selected clip or item.',
	component: lazyPanel(() => import('./InfoPanel.tsx'), 'InfoPanel'),
};
export default info;

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const lumetri: PanelDefinition = {
	kind: 'lumetri',
	title: () => 'Lumetri Color',
	icon: 'panel.lumetri',
	instance: 'single',
	minSize: { w: 280, h: 320 },
	keymapScope: 'lumetri',
	touch: 'hidden',
	agentDescription:
		'Lumetri-style colour grading of the selected clip (basic correction, creative LUT, curves, colour wheels).',
	component: lazyPanel(() => import('./LumetriPanel.tsx'), 'LumetriPanel'),
};
export default lumetri;

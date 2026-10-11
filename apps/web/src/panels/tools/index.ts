import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const tools: PanelDefinition = {
	kind: 'tools',
	title: () => 'Tools',
	icon: 'panel.tools',
	instance: 'single',
	minSize: { w: 40, h: 120 },
	fixedAxis: 'width',
	keymapScope: 'tools',
	touch: 'hidden',
	agentDescription: 'Editing tool palette (selection, ripple, razor, slip…).',
	component: lazyPanel(() => import('./ToolsPanel.tsx'), 'ToolsPanel'),
};

export default tools;

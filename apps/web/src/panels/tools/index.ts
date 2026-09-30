// Tools panel definition (ARCHITECTURE §7.2, S05 §16.6). Keeps the WP-00 contract fields.
import type { PanelDefinition } from '../types.ts';
import { ToolsPanel } from './ToolsPanel.tsx';

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
	component: ToolsPanel,
};

export default tools;

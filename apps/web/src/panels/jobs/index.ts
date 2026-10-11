import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const jobs: PanelDefinition = {
	kind: 'jobs',
	title: () => 'Jobs',
	icon: 'panel.jobs',
	instance: 'single',
	minSize: { w: 240, h: 120 },
	keymapScope: 'jobs',
	touch: 'sheet',
	requires: ['engine'],
	agentDescription: 'Engine jobs: imports, derivatives, exports and renders with progress.',
	component: lazyPanel(() => import('./JobsPanel.tsx'), 'JobsPanel'),
};

export default jobs;

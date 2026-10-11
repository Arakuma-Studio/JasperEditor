import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const definition: PanelDefinition = {
	kind: 'history',
	title: () => 'History',
	icon: 'panel.history',
	instance: 'single',
	minSize: { w: 200, h: 120 },
	keymapScope: 'history',
	menu: [
		{ type: 'command', command: 'history.stepBackward' },
		{ type: 'command', command: 'history.stepForward' },
		{ type: 'separator' },
		{ type: 'command', command: 'history.clear' },
	],
	touch: 'sheet',
	agentDescription: 'Undo history with labels and origins; click an entry to go back to it.',
	component: lazyPanel(() => import('./HistoryPanel.tsx'), 'HistoryPanel'),
};

export default definition;

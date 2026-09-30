// History panel (WP-2D): labelled undo steps, agent sparkle, click to jump, Clear History (S05:HIS).
import type { PanelDefinition } from '../types.ts';
import { HistoryPanel } from './HistoryPanel.tsx';

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
	component: HistoryPanel,
};

export default definition;

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const definition: PanelDefinition = {
	kind: 'properties',
	title: () => 'Properties',
	icon: 'panel.properties',
	instance: 'single',
	minSize: { w: 240, h: 200 },
	keymapScope: 'properties',
	menu: [
		{ type: 'command', command: 'inspector.toggleStopwatch' },
		{ type: 'command', command: 'inspector.addRemoveKeyframe' },
		{ type: 'command', command: 'inspector.resetProperty' },
	],
	touch: 'sheet',
	agentDescription: 'Context-sensitive inspector for the selection (text, motion graphics, clips).',
	component: lazyPanel(() => import('./PropertiesPanel.tsx'), 'PropertiesPanel'),
};

export default definition;

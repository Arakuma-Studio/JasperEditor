import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const definition: PanelDefinition = {
	kind: 'effectControls',
	title: () => 'Effect Controls',
	icon: 'panel.effectControls',
	instance: 'single',
	minSize: { w: 260, h: 160 },
	keymapScope: 'effectControls',
	menu: [
		{ type: 'command', command: 'effectControls.removeEffect', label: 'Remove Selected Effect' },
		{ type: 'command', command: 'inspector.toggleStopwatch' },
		{ type: 'command', command: 'inspector.toggleExpression' },
		{ type: 'command', command: 'inspector.prevKeyframe' },
		{ type: 'command', command: 'inspector.nextKeyframe' },
		{ type: 'command', command: 'inspector.resetProperty' },
	],
	touch: 'sheet',
	agentDescription: 'Keyframes and effect stack of the selected clip, with a mini-timeline of its keyframes.',
	component: lazyPanel(() => import('./EffectControlsPanel.tsx'), 'EffectControlsPanel'),
};

export default definition;

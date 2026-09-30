// Effect Controls panel (WP-2D): stopwatch/keyframes, mini-timeline and the effect stack (S03 §13, S05:ECP).
import type { PanelDefinition } from '../types.ts';
import { EffectControlsPanel } from './EffectControlsPanel.tsx';

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
		{ type: 'command', command: 'inspector.prevKeyframe' },
		{ type: 'command', command: 'inspector.nextKeyframe' },
		{ type: 'command', command: 'inspector.resetProperty' },
	],
	touch: 'sheet',
	agentDescription: 'Keyframes and effect stack of the selected clip, with a mini-timeline of its keyframes.',
	component: EffectControlsPanel,
};

export default definition;

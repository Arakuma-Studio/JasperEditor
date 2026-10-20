import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const definition: PanelDefinition = {
	kind: 'easing',
	title: () => 'Easing',
	icon: 'panel.easing',
	instance: 'single',
	minSize: { w: 240, h: 200 },
	keymapScope: 'easing',
	menu: [
		{ type: 'command', command: 'ease.apply' },
		{ type: 'command', command: 'ease.easyEase' },
		{ type: 'command', command: 'ease.easyEaseIn' },
		{ type: 'command', command: 'ease.easyEaseOut' },
		{ type: 'separator' },
		{ type: 'command', command: 'ease.copy' },
		{ type: 'command', command: 'ease.paste' },
		{ type: 'command', command: 'ease.pasteValues' },
		{ type: 'separator' },
		{ type: 'command', command: 'ease.duplicateAtPlayhead' },
		{ type: 'command', command: 'ease.mirrorAtPlayhead' },
	],
	touch: 'sheet',
	dockWith: 'effectControls',
	agentDescription:
		'Ease curve editor and curve library: shape a cubic or multi-point ease, apply it to the selected keyframes (in / middle / out), copy and paste eases and values.',
	component: lazyPanel(() => import('./EasingPanel.tsx'), 'EasingPanel'),
};

export default definition;

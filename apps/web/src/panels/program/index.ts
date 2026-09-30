// Program monitor panel (S03 §6, S05 §16.3) — WP-2C.

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const program: PanelDefinition = {
	kind: 'program',
	title: (ctx) => (ctx.sequenceName ? `Program: ${ctx.sequenceName}` : 'Program'),
	icon: 'panel.program',
	instance: 'single',
	keepAlive: true,
	minSize: { w: 240, h: 180 },
	keymapScope: 'program',
	menu: [
		{ type: 'command', command: 'monitor.fit' },
		{ type: 'command', command: 'monitor.toggleLoop' },
		{ type: 'command', command: 'program.snapInMonitor' },
	],
	touch: 'tab',
	agentDescription: 'Program monitor: plays the active sequence and edits layers on canvas.',
	component: lazyPanel(() => import('./ProgramMonitor.tsx'), 'ProgramMonitor'),
};

export default program;

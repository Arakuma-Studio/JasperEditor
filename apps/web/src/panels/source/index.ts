// Source monitor panel (S03 §7, S05:PGM-010) — WP-2C.

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const source: PanelDefinition = {
	kind: 'source',
	title: (ctx) => (ctx.sourceName ? `Source: ${ctx.sourceName}` : 'Source'),
	icon: 'panel.source',
	instance: 'single',
	minSize: { w: 240, h: 180 },
	keymapScope: 'source',
	menu: [
		{ type: 'command', command: 'monitor.fit' },
		{ type: 'command', command: 'monitor.toggleLoop' },
	],
	touch: 'sheet',
	agentDescription: 'Source monitor: previews a project item and sets its In/Out marks.',
	component: lazyPanel(() => import('./SourceMonitor.tsx'), 'SourceMonitor'),
};

export default source;

// Timeline panel definition (ARCHITECTURE §7.2, S05 §16.7). Keeps the WP-00 contract fields.

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const timeline: PanelDefinition = {
	kind: 'timeline',
	title: (ctx) => (ctx.sequenceName ? `Timeline: ${ctx.sequenceName}` : 'Timeline'),
	icon: 'panel.timeline',
	instance: 'multi',
	keepAlive: true,
	minSize: { w: 320, h: 160 },
	keymapScope: 'timeline',
	touch: 'tab',
	menu: [
		{ type: 'command', command: 'timeline.zoomToSequence', label: 'Zoom to Sequence' },
		{ type: 'command', command: 'timeline.toggleSnap', label: 'Snap in Timeline' },
		{ type: 'separator' },
		{ type: 'command', command: 'timeline.expandAllTracks', label: 'Expand All Tracks' },
		{ type: 'command', command: 'timeline.minimizeAllTracks', label: 'Minimize All Tracks' },
		{ type: 'separator' },
		{ type: 'command', command: 'timeline.renderInToOut', label: 'Render In to Out' },
	],
	agentDescription: 'Timeline of the active sequence: tracks, clips, edits, markers and In/Out.',
	component: lazyPanel(() => import('./TimelinePanel.tsx'), 'TimelinePanel'),
};

export default timeline;

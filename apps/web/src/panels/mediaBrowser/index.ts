import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

// polish: Premiere's Media Browser (Shift+8): browse the engine host's disks, preview, import in place.
const mediaBrowser: PanelDefinition = {
	kind: 'mediaBrowser',
	title: () => 'Media Browser',
	icon: 'panel.mediaBrowser',
	instance: 'single',
	minSize: { w: 260, h: 160 },
	keymapScope: 'mediaBrowser',
	touch: 'sheet',
	requires: ['engine'],
	agentDescription:
		'Media Browser: browse folders on the engine host, preview video / audio / stills and import files in place.',
	menu: [
		{ type: 'command', command: 'project.importFromMediaBrowser', label: 'Import' },
		{ type: 'command', command: 'mediaBrowser.up', label: 'Go Up' },
		{ type: 'command', command: 'mediaBrowser.refresh', label: 'Refresh' },
		{ type: 'command', command: 'mediaBrowser.toggleAllFiles', label: 'Show All Files' },
	],
	component: lazyPanel(() => import('./MediaBrowserPanel.tsx'), 'MediaBrowserPanel'),
};
export default mediaBrowser;

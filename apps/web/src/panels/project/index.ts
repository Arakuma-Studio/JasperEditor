import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const project: PanelDefinition = {
	kind: 'project',
	title: () => 'Project',
	icon: 'panel.project',
	instance: 'multi',
	minSize: { w: 200, h: 150 },
	keymapScope: 'project',
	touch: 'tab',
	menu: [
		{ type: 'command', command: 'project.import' },
		{ type: 'command', command: 'project.newBin' },
		{ type: 'command', command: 'project.newSequence' },
		{ type: 'separator' },
		{ type: 'command', command: 'project.listView' },
		{ type: 'command', command: 'project.iconView' },
		{ type: 'command', command: 'project.hoverScrub' },
	],
	agentDescription: 'Bins and imported media of the project; import, organize, open in Source.',
	component: lazyPanel(() => import('./ProjectPanel.tsx'), 'ProjectPanel'),
};

export default project;

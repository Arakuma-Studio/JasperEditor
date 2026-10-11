import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const motionTemplatesPanel: PanelDefinition = {
	kind: 'motionTemplates',
	title: () => 'Motion Templates',
	icon: 'panel.motionTemplates',
	instance: 'single',
	minSize: { w: 220, h: 160 },
	keymapScope: 'motionTemplates',
	touch: 'sheet',
	agentDescription:
		'Motion-graphic templates (fframes and anime · Remotion) to add to the timeline: double-click or drag a card to insert at the playhead.',
	menu: [{ type: 'command', command: 'mg.rerender', label: 'Re-render Selected Motion Graphics' }],
	component: lazyPanel(() => import('./MotionTemplatesPanel.tsx'), 'MotionTemplatesPanel'),
};

export default motionTemplatesPanel;

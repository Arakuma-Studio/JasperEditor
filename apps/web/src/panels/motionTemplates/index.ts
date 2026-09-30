// Motion Templates panel (S05 §16.14, MGT-001/002). Owner: WP-2G.
import type { PanelDefinition } from '../types.ts';
import { MotionTemplatesPanel } from './MotionTemplatesPanel.tsx';

export { insertMotionTemplate, MG_TEMPLATE_MIME, readMgTemplateDrag } from './insert.ts';

const motionTemplatesPanel: PanelDefinition = {
	kind: 'motionTemplates',
	title: () => 'Motion Templates',
	icon: 'panel.motionTemplates',
	instance: 'single',
	minSize: { w: 220, h: 160 },
	keymapScope: 'motionTemplates',
	touch: 'sheet',
	agentDescription:
		'Motion-graphic (fframes) templates to add to the timeline: double-click or drag a card to insert at the playhead.',
	menu: [{ type: 'command', command: 'mg.rerender', label: 'Re-render Selected Motion Graphics' }],
	component: MotionTemplatesPanel,
};

export default motionTemplatesPanel;

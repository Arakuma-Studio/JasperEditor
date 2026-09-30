// Motion Templates panel — placeholder from WP-00; WP-2G replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('motionTemplates', {
	title: 'Motion Templates',
	owner: 'WP-2G',
	icon: 'panel.motionTemplates',
	instance: 'single',
	minSize: { w: 220, h: 160 },
	keymapScope: 'motionTemplates',
	touch: 'sheet',
	agentDescription: 'Motion-graphic (fframes) templates to add to the timeline.',
});

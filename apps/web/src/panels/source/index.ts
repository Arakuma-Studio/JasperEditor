// Source panel — placeholder from WP-00; WP-2C replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('source', {
	title: 'Source',
	owner: 'WP-2C',
	icon: 'panel.source',
	instance: 'single',
	minSize: { w: 240, h: 180 },
	keymapScope: 'source',
	touch: 'sheet',
	agentDescription: 'Source monitor: previews a project item and sets its In/Out marks.',
});

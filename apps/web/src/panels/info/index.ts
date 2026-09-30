// Info panel — placeholder from WP-00; WP-2A replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('info', {
	title: 'Info',
	owner: 'WP-2A',
	icon: 'panel.info',
	instance: 'single',
	minSize: { w: 200, h: 120 },
	keymapScope: 'info',
	touch: 'hidden',
	agentDescription: 'Details of the selected clip or item.',
});

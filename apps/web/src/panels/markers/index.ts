// Markers panel — placeholder from WP-00; WP-2A replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('markers', {
	title: 'Markers',
	owner: 'WP-2A',
	icon: 'panel.markers',
	instance: 'single',
	minSize: { w: 200, h: 120 },
	keymapScope: 'markers',
	touch: 'sheet',
	agentDescription: 'List of sequence markers including agent notes.',
});

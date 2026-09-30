// Program panel — placeholder from WP-00; WP-2C replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('program', {
	title: 'Program',
	owner: 'WP-2C',
	icon: 'panel.program',
	instance: 'single',
	keepAlive: true,
	minSize: { w: 240, h: 180 },
	keymapScope: 'program',
	touch: 'tab',
	agentDescription: 'Program monitor: plays the active sequence and edits layers on canvas.',
});

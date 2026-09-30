// Tools panel — placeholder from WP-00; WP-2B replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('tools', {
	title: 'Tools',
	owner: 'WP-2B',
	icon: 'panel.tools',
	instance: 'single',
	minSize: { w: 40, h: 120 },
	fixedAxis: 'width',
	keymapScope: 'tools',
	touch: 'hidden',
	agentDescription: 'Editing tool palette (selection, ripple, razor, slip…).',
});

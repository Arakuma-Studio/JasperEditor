// Jobs panel — placeholder from WP-00; WP-2E replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('jobs', {
	title: 'Jobs',
	owner: 'WP-2E',
	icon: 'panel.jobs',
	instance: 'single',
	minSize: { w: 240, h: 120 },
	keymapScope: 'jobs',
	touch: 'sheet',
	requires: ['engine'],
	agentDescription: 'Engine jobs: imports, derivatives, exports and renders with progress.',
});

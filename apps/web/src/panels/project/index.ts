// Project panel — placeholder from WP-00; WP-2E replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('project', {
	title: 'Project',
	owner: 'WP-2E',
	icon: 'panel.project',
	instance: 'multi',
	minSize: { w: 200, h: 150 },
	keymapScope: 'project',
	touch: 'tab',
	agentDescription: 'Bins and imported media of the project; import, organize, open in Source.',
});

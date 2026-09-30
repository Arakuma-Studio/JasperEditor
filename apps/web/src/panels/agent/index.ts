// Agent panel — placeholder from WP-00; WP-2H replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('agent', {
	title: 'Agent',
	owner: 'WP-2H',
	icon: 'panel.agent',
	instance: 'single',
	minSize: { w: 260, h: 200 },
	keymapScope: 'agent',
	touch: 'tab',
	agentDescription: 'Agent activity, approvals and the JSON transaction console.',
});

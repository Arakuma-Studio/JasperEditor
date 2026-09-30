// Timeline panel — placeholder from WP-00; WP-2B replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('timeline', {
	title: 'Timeline',
	owner: 'WP-2B',
	icon: 'panel.timeline',
	instance: 'multi',
	keepAlive: true,
	minSize: { w: 320, h: 160 },
	keymapScope: 'timeline',
	touch: 'tab',
	agentDescription: 'Timeline of the active sequence: tracks, clips, edits, markers and In/Out.',
});

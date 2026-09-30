// Properties panel — placeholder from WP-00; WP-2D replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('properties', {
	title: 'Properties',
	owner: 'WP-2D',
	icon: 'panel.properties',
	instance: 'single',
	minSize: { w: 240, h: 200 },
	keymapScope: 'properties',
	touch: 'sheet',
	agentDescription: 'Context-sensitive inspector for the selection (text, motion graphics, clips).',
});

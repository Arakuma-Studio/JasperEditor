// Effects panel — placeholder from WP-00; WP-2D replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('effects', {
	title: 'Effects',
	owner: 'WP-2D',
	icon: 'panel.effects',
	instance: 'single',
	minSize: { w: 200, h: 160 },
	keymapScope: 'effects',
	touch: 'sheet',
	agentDescription: 'Catalog of video/audio effects and transitions to apply to clips.',
});

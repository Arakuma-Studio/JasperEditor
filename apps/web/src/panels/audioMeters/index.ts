// Audio Meters panel — placeholder from WP-00; WP-2A replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('audioMeters', {
	title: 'Audio Meters',
	owner: 'WP-2A',
	icon: 'panel.audioMeters',
	instance: 'single',
	minSize: { w: 52, h: 120 },
	fixedAxis: 'width',
	keymapScope: 'audioMeters',
	touch: 'hidden',
	agentDescription: 'Master output level meters.',
});

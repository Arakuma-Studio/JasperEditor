// Effect Controls panel — placeholder from WP-00; WP-2D replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('effectControls', {
	title: 'Effect Controls',
	owner: 'WP-2D',
	icon: 'panel.effectControls',
	instance: 'single',
	minSize: { w: 260, h: 160 },
	keymapScope: 'effectControls',
	touch: 'sheet',
	agentDescription: 'Motion, opacity, audio and effect parameters of the selected clip with keyframes.',
});

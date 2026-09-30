// History panel — placeholder from WP-00; WP-2D replaces the component (keep the definition's contract).
import { placeholderPanel } from '../placeholder.tsx';

export default placeholderPanel('history', {
	title: 'History',
	owner: 'WP-2D',
	icon: 'panel.history',
	instance: 'single',
	minSize: { w: 200, h: 120 },
	keymapScope: 'history',
	touch: 'sheet',
	agentDescription: 'Undo history with labels and origins; click an entry to go back to it.',
});

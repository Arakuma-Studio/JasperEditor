// Info panel (S05:INF-001, WP-2A): key–value readout of the selection and the active sequence.
import type { PanelDefinition } from '../types.ts';
import { InfoPanel } from './InfoPanel.tsx';

const info: PanelDefinition = {
	kind: 'info',
	title: () => 'Info',
	icon: 'panel.info',
	instance: 'single',
	minSize: { w: 200, h: 120 },
	keymapScope: 'info',
	touch: 'hidden',
	agentDescription: 'Details of the selected clip or item.',
	component: InfoPanel,
};
export default info;

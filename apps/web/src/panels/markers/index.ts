// Markers panel (S05:MRK-001, WP-2A placeholder with a working list): sequence markers of the active
// sequence; double-click goes to the marker.
import type { PanelDefinition } from '../types.ts';
import { MarkersPanel } from './MarkersPanel.tsx';

const markers: PanelDefinition = {
	kind: 'markers',
	title: () => 'Markers',
	icon: 'panel.markers',
	instance: 'single',
	minSize: { w: 200, h: 120 },
	keymapScope: 'markers',
	touch: 'sheet',
	agentDescription: 'List of sequence markers including agent notes.',
	menu: [{ type: 'command', command: 'timeline.addMarker', label: 'Add Marker' }],
	component: MarkersPanel,
};
export default markers;

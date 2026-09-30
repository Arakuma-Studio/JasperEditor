// Audio Meters panel (S05:MTR-001, WP-2A placeholder): a 52 px stereo meter strip with the dB scale.
// Live levels (Web Audio analyser / envelopes, MTR-002) arrive with the Program audio path.

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const audioMeters: PanelDefinition = {
	kind: 'audioMeters',
	title: () => 'Audio Meters',
	icon: 'panel.audioMeters',
	instance: 'single',
	minSize: { w: 52, h: 120 },
	fixedAxis: 'width',
	keymapScope: 'audioMeters',
	touch: 'hidden',
	agentDescription: 'Master output level meters.',
	component: lazyPanel(() => import('./AudioMetersPanel.tsx'), 'AudioMetersPanel'),
};
export default audioMeters;

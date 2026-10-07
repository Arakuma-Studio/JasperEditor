// Audio Meters panel (S05:MTR-001/002, audio-mix): live levels and the EBU R128 loudness readout of the Mix.

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const audioMeters: PanelDefinition = {
	kind: 'audioMeters',
	title: () => 'Audio Meters',
	icon: 'panel.audioMeters',
	instance: 'single',
	minSize: { w: 52, h: 200 },
	fixedAxis: 'width',
	keymapScope: 'audioMeters',
	touch: 'hidden',
	agentDescription:
		'Live levels of the Mix (peak, RMS, peak hold, clip LEDs per channel) and EBU R128 loudness (M, S, I, LRA, true peak) of the preview.',
	component: lazyPanel(() => import('./AudioMetersPanel.tsx'), 'AudioMetersPanel'),
};
export default audioMeters;

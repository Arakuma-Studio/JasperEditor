import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const audioClipMixer: PanelDefinition = {
	kind: 'audioClipMixer',
	title: () => 'Audio Clip Mixer',
	icon: 'panel.audioClipMixer',
	instance: 'single',
	minSize: { w: 160, h: 300 },
	keymapScope: 'audioClipMixer',
	touch: 'sheet',
	agentDescription:
		'Audio Clip Mixer: per audio track, the volume and balance of the clip under the playhead (writes clip keyframes), track mute / solo and meters.',
	component: lazyPanel(() => import('./AudioClipMixerPanel.tsx'), 'AudioClipMixerPanel'),
};
export default audioClipMixer;

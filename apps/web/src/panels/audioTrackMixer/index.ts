// Audio Track Mixer panel (audio-mix, Premiere Shift+6): track / submix / Mix strips, automation, sends, inserts.
import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const audioTrackMixer: PanelDefinition = {
	kind: 'audioTrackMixer',
	title: () => 'Audio Track Mixer',
	icon: 'panel.audioTrackMixer',
	instance: 'single',
	minSize: { w: 200, h: 320 },
	keymapScope: 'audioTrackMixer',
	touch: 'sheet',
	agentDescription:
		'Audio Track Mixer: one strip per audio track, submix and the Mix — fader, pan / 5.1 panner, mute, solo, record-arm, automation mode, effect slots, sends, output routing and meters.',
	component: lazyPanel(() => import('./AudioTrackMixerPanel.tsx'), 'AudioTrackMixerPanel'),
};
export default audioTrackMixer;

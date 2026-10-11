import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const essentialSound: PanelDefinition = {
	kind: 'essentialSound',
	title: () => 'Essential Sound',
	icon: 'panel.essentialSound',
	instance: 'single',
	minSize: { w: 260, h: 300 },
	keymapScope: 'essentialSound',
	touch: 'sheet',
	agentDescription:
		'Essential Sound: give selected audio clips a type (Dialogue, Music, SFX, Ambience) and drive ordinary clip effects from simple controls — Loudness Auto-Match, Repair, Clarity, Creative reverb, Duration (remix), Ducking, Pan, Clip Volume.',
	component: lazyPanel(() => import('./EssentialSoundPanel.tsx'), 'EssentialSoundPanel'),
};
export default essentialSound;

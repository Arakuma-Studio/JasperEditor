// audio-fx web registrations: the Effect Controls editors of the audio effects (editors.tsx) and the session runtime of
// Preferences ▸ Audio ▸ "Auto-tag audio types in the timeline" (auto-tag-on-add.tsx).
import { AUDIO_EFFECTS } from '@jasper/project';
import { effectEditors, programOverlays } from '../extensions/index.ts';
import { AutoTagOnAddHost } from './auto-tag-on-add.tsx';
import { editorComponentFor } from './editors.tsx';

for (const spec of AUDIO_EFFECTS) {
	const component = editorComponentFor(spec);
	if (component) effectEditors.register({ id: `audio-fx.${spec.id}`, effectId: spec.id, component });
}

programOverlays.register({
	id: 'audio-fx.auto-tag-on-add',
	active: () => true,
	component: AutoTagOnAddHost,
	order: 0,
});

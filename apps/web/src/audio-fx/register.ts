// audio-fx web registrations: the Effect Controls editors of the audio effects (editors.tsx).
import { AUDIO_EFFECTS } from '@jasper/project';
import { effectEditors } from '../extensions/index.ts';
import { editorComponentFor } from './editors.tsx';

for (const spec of AUDIO_EFFECTS) {
	const component = editorComponentFor(spec);
	if (component) effectEditors.register({ id: `audio-fx.${spec.id}`, effectId: spec.id, component });
}

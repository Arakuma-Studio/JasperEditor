// Session-level audio services (audio-mix), started by the Program monitor: the mixer controller (automation passes
// follow the transport even when no mixer panel is open) and the audio scrubber.
import type { EditorSession } from '@jasper/session';
import { useEffect } from 'react';
import { mixerControllerFor } from './automation.ts';
import { audioScrubberFor } from './scrub.ts';

export function useAudioSessionServices(session: EditorSession): void {
	useEffect(() => {
		mixerControllerFor(session);
		audioScrubberFor(session);
	}, [session]);
}

// audio-fx: gives the compositions the URL of the bundled AudioWorklet module that hosts clip chains in the preview
// (packages/compositions/src/audio/clip-fx.tsx). Vite bundles `fx-worklet.ts` with everything it imports.
import { setAudioFxWorkletUrl } from '@jasper/compositions';
import workletUrl from './fx-worklet.ts?worker&url';

export function registerAudioFxWorklet(): void {
	setAudioFxWorkletUrl(workletUrl);
}

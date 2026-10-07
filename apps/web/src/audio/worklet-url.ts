// The preview mix's AudioWorklet module (meters, loudness, the true-peak limiter, voice-over capture), bundled with
// @jasper/audio-dsp by Vite as a worker script and loaded with `audioWorklet.addModule(url)`.
// layers-allow: Vite's ?worker&url query on the exported ./audio-worklet subpath
import workletUrl from '@jasper/compositions/audio-worklet?worker&url';

export const MIX_WORKLET_URL: string = workletUrl;

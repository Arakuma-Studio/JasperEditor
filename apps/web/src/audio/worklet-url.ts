// The preview mix's AudioWorklet module (meters, loudness, the true-peak limiter, voice-over capture), bundled with
// @jasper/audio-dsp by Vite as a worker script and loaded with `audioWorklet.addModule(url)`.
import workletUrl from '@jasper/compositions/audio-worklet?worker&url';

export const MIX_WORKLET_URL: string = workletUrl;

// True-peak interpolation: the polyphase bank of @jasper/audio-dsp (32 taps per phase, Kaiser β 9 — matched to
// ffmpeg's true-peak upsampler by audio-mix; one implementation for meters, limiters and effects).
export { Interpolator, PolyphaseBank, TAPS_PER_PHASE, truePeakFactor } from '@jasper/audio-dsp';

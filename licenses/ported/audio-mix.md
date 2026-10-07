# Code ported by the `audio-mix` workstream (loudness, true peak, mixer, ducking, voice-over)

- **Upstream:** https://github.com/storytold/filmcraft
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** audio-mix workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/audio-dsp/src/loudness.rs` | `packages/audio-dsp/src/loudness.ts` | BS.1770-4 / EBU R128 meter: momentary, short-term, integrated (histogram two-stage gate), LRA (Tech 3342), sample / true peak, normalisation gain |
| `crates/audio-dsp/src/loudness.rs` (`k_prefilter`, `k_rlb`) | `packages/audio-dsp/src/kweight.ts` | K-weighting from the analog prototypes via the bilinear transform (any sample rate) |
| `crates/audio-dsp/src/oversample.rs` | `packages/audio-dsp/src/oversample.ts` | Polyphase true-peak interpolator (kernel changed to libswresample's upsampling kernel: 32 taps, Kaiser β 9, cut-off at Nyquist) |
| `crates/audio-dsp/src/biquad.rs` | `packages/audio-dsp/src/biquad.ts` | Biquads (TDF-II), RBJ designs, magnitude response |
| `crates/audio-dsp/src/smooth.rs` | `packages/audio-dsp/src/smooth.ts` | Per-sample parameter smoothing |
| `crates/audio-dsp/src/channels.rs` | `packages/audio-dsp/src/channels.ts`, `packages/project/src/audio/mixer.ts`, `packages/compositions/src/audio/graph.ts` | Channel layouts, ITU-R BS.775 up/downmix and 5.1 mixdown types, −3 dB pan law, balance, the 5.1 panner |
| `crates/audio-dsp/src/ducking.rs` | `packages/audio-dsp/src/ducking.ts`, `packages/project/src/audio/ducking.ts` | RMS envelope via prefix sums, activity detection with gap bridging and minimum length, sensitivity threshold, duck keyframes merged and clamped to the clip |
| `crates/audio-dsp/tests/loudness_oracle.rs` | `packages/audio-dsp/test/loudness-oracle.test.ts`, `packages/audio-dsp/test/oracle.ts` | Oracle tests against ffmpeg `ebur128` (extended with EBU Tech 3341/3342 cases, 44.1/48/96 kHz, 5.1) |
| `crates/project/src/mixer.rs` | `packages/project/src/schema/audio.ts`, `packages/project/src/audio/strip.ts` | Mixer strips, automation modes and lanes, sends, submix routing, input maps, gesture thinning (`thin_points`) and lane writing (`write_lane`) |
| `crates/render/src/mixer.rs` | `packages/project/src/audio/plan.ts`, `packages/project/src/audio/mixer.ts`, `packages/compositions/src/audio/graph.ts` | Mixer graph signal path, routing-aware solo, pre/post-fader sends and inserts, latency compensation |
| `crates/engine/src/mixer.rs` | `packages/project/src/commands/handlers/audio.ts`, `apps/web/src/audio/automation.ts` | Mixer commands, the automation recorder (Off/Read/Latch/Touch/Write, automatch), Audio Clip Mixer writes, Audio Gain |
| `crates/engine/src/voiceover.rs` | `apps/web/src/audio/voiceover.ts` | Voice-over record point / pre-roll / punch-in, countdown cue times and tone, file naming |
| `crates/ui-egui/src/panels/meters.rs`, `crates/ui-egui/src/panels/mixer.rs` | `apps/web/src/panels/audioMeters/`, `apps/web/src/panels/audioMixer/` | Meter layout (dB scale, peak hold, loudness readout) and mixer strip layout |

Notes: everything is TypeScript. The true-peak kernel, the look-ahead true-peak limiter, the level meter, the WAV
codec and the windowed-sinc resampler are new. The offline mixer evaluates every lane per sample in the browser and in
Node; the preview runs the same matrices in a Web Audio graph.

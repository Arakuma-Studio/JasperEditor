# Code ported by the `audio-fx` workstream (audio effects, Essential Sound, Music Remix)

- **Upstream:** https://github.com/storytold/filmcraft (commit `771b614ad4c3fbefda5d668ce4384504b8c13f6d`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** audio-fx workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/audio-dsp/src/lib.rs` (`AudioEffect`, dB helpers) | `packages/audio-fx/src/core/effect.ts`, `packages/audio-fx/src/core/math.ts` | The processor contract (planar in-place blocks, latency, reset) and numeric helpers |
| `crates/audio-dsp/src/fft.rs` | `packages/audio-fx/src/core/fft.ts` | Radix-2 complex FFT (f64 here) |
| `crates/audio-dsp/src/design.rs` | `packages/audio-fx/src/core/design.ts` | Bessel / Butterworth / Chebyshev I / elliptic prototypes → bilinear biquad cascades (Scientific Filter) |
| `crates/audio-dsp/src/effects/util.rs` | `packages/audio-fx/src/core/util.ts` | Delay lines, LFOs, one-pole / DC-block / all-pass, envelope follower, PRNG |
| `crates/audio-dsp/src/effects/stft.rs` | `packages/audio-fx/src/core/stft.ts` | Streaming √Hann STFT overlap-add |
| `crates/audio-dsp/src/effects/mod.rs` (registry and its tests) | `packages/audio-fx/src/registry.ts`, `packages/audio-fx/test/registry.test.ts` | Effect id → processor; the generic contract tests (block-size independence, extremes, reset) |
| `crates/audio-dsp/src/effects/eq.rs` | `packages/audio-fx/src/effects/filter-eq/bank.ts`, `packages/audio-fx/src/effects/filter-eq/eq.ts`, `packages/project/src/registry/audio/filter-eq.ts` | Band bank with glides, Parametric EQ, Simple Parametric / 3-band EQ, simple pass and shelving filters |
| `crates/audio-dsp/src/effects/filters.rs` | `packages/audio-fx/src/effects/filter-eq/eq.ts`, `packages/audio-fx/src/effects/filter-eq/fft-filter.ts`, `packages/audio-fx/src/effects/filter-eq/scientific.ts` | Graphic EQ (10/20/30 bands), Notch Filter, FFT Filter, Scientific Filter |
| `crates/audio-dsp/src/effects/dynamics.rs` | `packages/audio-fx/src/effects/dynamics/curves.ts`, `packages/audio-fx/src/effects/dynamics/single.ts`, `packages/audio-fx/src/effects/dynamics/limiter.ts`, `packages/audio-fx/src/effects/dynamics/rack.ts` | Soft-knee static curves, Single-band Compressor, Expander/Gate, Hard Limiter (sample-peak engine), Dynamics rack |
| `crates/audio-dsp/src/effects/multiband.rs` | `packages/audio-fx/src/effects/dynamics/rack.ts`, `packages/audio-fx/src/effects/dynamics/single.ts` | Multiband Compressor (LR4 crossovers), Tube-modeled Compressor |
| `crates/audio-dsp/src/effects/restoration.rs` | `packages/audio-fx/src/effects/restoration/dehum.ts`, `packages/audio-fx/src/effects/restoration/spectral.ts` | DeHummer, DeNoise (adaptive / learned noise print) |
| `crates/audio-dsp/src/effects/declick.rs` | `packages/audio-fx/src/effects/restoration/declick.ts` | Automatic Click Remover (LPC residual detection, AR interpolation) |
| `crates/audio-dsp/src/effects/essential.rs` | `packages/audio-fx/src/effects/restoration/spectral.ts`, `packages/audio-fx/src/effects/restoration/speech.ts`, `packages/audio-fx/src/effects/stereo-channel.ts` | DeReverb, DeEsser, Enhance Speech, Stereo Width |
| `crates/audio-dsp/src/effects/time.rs` | `packages/audio-fx/src/effects/delay-modulation.ts`, `packages/audio-fx/src/effects/reverb/fdn.ts` | Delay (tempo sync), Analog Delay, Multitap Delay; the FDN Studio Reverb |
| `crates/audio-dsp/src/effects/modulation.rs` | `packages/audio-fx/src/effects/delay-modulation.ts` | Chorus/Flanger, Flanger, Phaser |
| `crates/audio-dsp/src/effects/reverbs.rs` | `packages/audio-fx/src/effects/reverb/convolution.ts`, `packages/audio-fx/src/effects/reverb/surround.ts` | Partitioned convolution with procedural impulses (energy-compensated decay is ours), Surround Reverb |
| `crates/audio-dsp/src/effects/pitch.rs` | `packages/audio-fx/src/effects/pitch.ts` | Phase-vocoder Pitch Shifter with identity phase locking |
| `crates/audio-dsp/src/effects/special.rs` | `packages/audio-fx/src/effects/special/shaping.ts`, `packages/audio-fx/src/effects/special/mastering.ts`, `packages/audio-fx/src/effects/stereo-channel.ts` | Distortion, Guitar Suite, Mastering, Vocal Enhancer, Loudness Meter, Mute, Channel Mixer, Stereo Expander, Binauralizer, Ambisonics panner |
| `crates/audio-dsp/src/effects/channel.rs` | `packages/audio-fx/src/effects/stereo-channel.ts`, `packages/project/src/registry/audio/stereo-channel.ts` | Amplify, Channel Volume, Balance, Invert, Swap / Fill Left / Fill Right |
| `crates/audio-dsp/src/effects/premiere_tests.rs` | `packages/audio-fx/test/filter-eq.test.ts`, `packages/audio-fx/test/stereo-channel.test.ts` | Premiere-behaviour tests (extended with RBJ / analytic expectations) |
| `crates/audio-dsp/src/remix.rs` | `packages/audio-fx/src/analysis/remix.ts`, `packages/audio-fx/test/remix.test.ts`, `packages/audio-fx/test/music.ts` | Beat tracking, segment similarity graph, remix planning and test music (the steady-tone guard is ours) |
| `crates/render/src/remix.rs`, `crates/engine/src/remix.rs` | `apps/engine/src/audio/remix.ts`, `apps/engine/src/routes/audio-fx.ts`, `packages/project/src/commands/handlers/essential.ts` | Engine-side planning of a clip range; the remix edit (here: grouped pieces with constant-power crossfades instead of one remixed clip) |
| `crates/project/src/essential.rs` | `packages/project/src/essential/model.ts`, `packages/project/src/essential/reconcile.ts` | Essential Sound types, sections, presets and their mapping to ordinary keyframable clip effects (`essential::apply`) |
| `crates/engine/src/essential_sound.rs` | `packages/project/src/commands/handlers/essential.ts`, `apps/web/src/audio-fx/ops.ts` | Essential Sound commands, Auto-Match, ducking triggers |
| `crates/ui-egui/src/panels/essential_sound.rs`, `crates/ui-egui/src/panels/remix.rs` | `apps/web/src/panels/essentialSound/EssentialSoundPanel.tsx`, `apps/web/src/panels/timeline/state/controller.ts` | Used as a layout reference: type buttons, sections, presets, the Remix tool's drag feedback |

Notes: everything is TypeScript (f32 audio, f64 state where the reference used f64). Shared primitives come from
`@jasper/audio-dsp` (audio-mix's ports: RBJ biquad designs, smoothing, the true-peak interpolator and limiter, the
BS.1770 meter). New here: the AudioWorklet host (`packages/compositions/src/audio/fx-processor.ts`) and the offline
mixer host (`packages/audio-fx/src/host.ts`), Mono Maker, Loudness Auto Gain, the Effect Controls editors
(`apps/web/src/audio-fx/editors.tsx`), the MCP tools and the convolution decay energy compensation.

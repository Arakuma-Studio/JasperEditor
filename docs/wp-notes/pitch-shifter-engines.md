# Pitch Shifter engines: Signalsmith Stretch, Rubber Band R3, Preserve Formants

The Pitch Shifter (`jasper.audio.pitch-shifter`, [audio-fx.md](audio-fx.md)) has three engines, picked per instance.
Every engine keeps the duration: the output has the input's length and is aligned at 0 ms through `latency()`, which the
offline mixer (every export path) and the preview graph compensate like any effect latency.

| Param | Values | Default for stored instances (absent) | New instances (`effect.add`) |
|---|---|---|---|
| `semitones`, `cents` | −12…12, −100…100 (unchanged) | 0, 0 | 0, 0 |
| `engine` | `legacy` · `signalsmith` · `rubberband-r3` (not keyframable) | `legacy` | `signalsmith` |
| `quality` | `best` · `fast` (not keyframable; Signalsmith and Rubber Band) | `best` | `best` |
| `preserveFormants` | boolean (hold keyframes; Signalsmith and Rubber Band) | off | off |

Switching an existing instance in place (MCP `set_effect_param`, one param per call):
`{"effectInstanceId": "fx_…", "param": "engine", "value": "rubberband-r3"}` then
`{"effectInstanceId": "fx_…", "param": "preserveFormants", "value": true}`. Schema v18 records the params
([project-files.md](../project-files.md)).

## Engines

- **legacy** — the v1 phase vocoder (filmcraft port), byte-for-byte unchanged so stored projects sound the same.
  Latency = FFT size (2048 at 48 kHz).
- **signalsmith** — a TypeScript port of Signalsmith Stretch 1.3.2 (MIT) and the parts of Signalsmith Linear 0.6.6 it
  needs (`packages/audio-fx/src/effects/pitch/`, records `licenses/ported/signalsmith-*.md`). `best` = upstream
  `presetDefault` (120 ms blocks, 30 ms interval), `fast` = `presetCheaper` (100 ms / 40 ms); tonality limit 8 kHz
  (upstream CLI and web default); Preserve Formants = `setFormantFactor(1, compensatePitch = true)` with the
  fundamental estimated per block. Latency = block length (5760 / 4800 samples at 48 kHz). Port fidelity, measured:
  against the C++ upstream (`SignalsmithStretch<double>`, same 3 s stereo input, −1.5 st, formant compensation) the
  largest sample difference is 1.7e-5 at a 0.43 peak (harness: a 40-line C++ driver of `signalsmith-stretch.h` built
  with clang++, compared with the port in Node; not part of the suite).
- **rubberband-r3** — Rubber Band Library 4.0.0, R3 ("finer") engine in real-time mode (`PitchHighQuality`, channels
  together for stereo, `WindowShort` for `fast`, `FormantPreserved` for Preserve Formants), compiled from the pinned
  tag by `scripts/rubberband-wasm/build.sh` (wasi-sdk 34, the vid.stab pin) into `packages/audio-fx/wasm/rubberband.wasm`
  and driven through its C API (`pitch/rubberband.ts`). GPL-2.0-or-later, the one exception of AGENTS.md §2
  (owner's decision; separate module; FFmpeg stays LGPL, no `rubberband` filter). The library is fed in fixed
  256-sample calls counted from the reset (its preferred start pad first, its start delay dropped), so its output never
  depends on the host's blocks; a FIFO turns it into one output sample per input sample. Latency = max(Signalsmith's,
  110 ms / 70 ms + 256), so it is the same whether the module runs or the instance falls back. The lag bound was
  measured (largest gap between fed input and retrievable output over ±12 st, formants on/off, mono/stereo, a pitch
  change mid-stream): 4062 / 2556 samples at 44.1 and 48 kHz, 8100 / 5078 at 96 kHz (`best` / `fast`), ≈ 10 % under the
  bound; a shortfall would output silence and count `underruns` (never seen).
- **Fallback (never silent)**: where the module is missing or cannot start, `rubberband-r3` runs Signalsmith with the
  same latency. The export plan then carries `PITCH_ENGINE_FALLBACK` (planner warning naming the clips / strips); the
  preview shows the reason under the effect in Effect Controls and a `!` on the Audio Track Mixer insert.

## Where it runs

One implementation for preview and export (AGENTS §4): the same processor runs in the offline mixer (engine:
`apps/engine/src/audio/mixdown.ts` loads the module with `installRubberBand`; packaged next to `engine.mjs`) and in the
preview's AudioWorklet (`FxSlotCore`; the web app fetches and compiles the module once, `previewRubberBand`, and passes
it into the worklet with the slot's options or a `rubberband` message). Tested sample for sample for all five
engine/quality settings (`packages/compositions/test/pitch-shifter-engines.test.ts`: max difference 0).

Every path stays float: no clipping, wrapping or integer conversion inside the effect; true peaks above 0 dBFS reach the
delivery limiter / loudness normalisation (test: a clipped full-scale vowel at −1.5 st comes out above 1.02 on every
engine, `packages/audio-fx/test/pitch-engines.test.ts`).

**Butt cuts.** As a track effect (A1) the shifter processes the track's summed input continuously: edit points never
restart it. Tested through the offline mixer: a take cut into six butt-cut clips (every 7 frames) renders identically
(≤ 1e-6) to the uncut take, for legacy, Signalsmith and Rubber Band, and the largest sample step within ±8 samples of each
cut stays within the surrounding 20 ms. Clip effects still start each clip from a clean state (see Limits).

## Objective comparison with the Rubber Band R3 references (voice)

Rerun: `python3 scripts/pitch-compare/compare.py <dir>` (renders through `scripts/pitch-compare/render.ts`; needs ffmpeg,
numpy, scipy). Inputs: the video team's 15 s voice passages (calma, eses, grito; mono 48 kHz AAC) and their references
from the `rubberband-r3` CLI (offline mode) at −1 st with/without `--formant` and at −1.5 st with `--formant`. Measured
2026-11-16 on the 16-core shared host (load 24–87). Metrics per voiced 10 ms frame (YIN f0, aperiodicity < 0.15):

- *pitch* = median of 1200·log2(f0_out / f0_in) minus the requested shift, cents (IQR in brackets);
- *env* = LPC (order 18, 16 kHz) envelope distance to the **input**, dB RMS over 200–5000 Hz (formants preserved = small);
- *LSD* = log-spectral distance to the R3 `--formant` reference, dB, 60–8000 Hz, level-matched after aligning by
  amplitude envelopes. Floor of this metric: our legacy render vs the editor's own AAC export of the same legacy shift
  = 4.45 dB (AAC coding of the references, not artefacts); the original vs the R3 reference = 9.26 dB.

| −1 st, formants on (calma / eses / grito) | pitch, cents | env, dB | LSD to R3+formants, dB |
|---|---|---|---|
| R3 reference (`--formant`, AAC) | −0.14 [9.0] / 0.61 [9.6] / −0.63 [12.4] | 2.13 / 2.49 / 2.34 | — |
| rubberband-r3 best | −0.03 [5.0] / 0.40 [7.3] / 0.30 [7.9] | 1.91 / 1.80 / 1.71 | 5.68 / 6.09 / 5.83 |
| rubberband-r3 fast | −0.17 [4.4] / 0.15 [5.6] / 0.17 [6.9] | 2.03 / 1.87 / 1.86 | 5.87 / 6.25 / 6.05 |
| signalsmith best | 1.53 [6.1] / 1.92 [6.0] / 2.06 [6.5] | 2.17 / 2.18 / 2.14 | 6.62 / 6.94 / 6.74 |
| signalsmith fast | 2.72 [8.8] / 3.31 [10.2] / 1.87 [9.4] | 2.31 / 2.25 / 2.21 | 6.82 / 7.02 / 6.88 |
| legacy (formants shift) | 0.00 [1.5] / 0.17 [1.9] / −0.04 [2.0] | 3.08 / 3.04 / 3.03 | 7.20 / 7.58 / 7.41 |

| −1.5 st (calma) | pitch | env | LSD to R3+formants |
|---|---|---|---|
| R3 reference (`--formant`) | −0.31 [7.6] | 2.49 | — |
| rubberband-r3 best, formants | −0.11 [6.4] | 2.22 | 5.87 |
| signalsmith best, formants | 1.54 [6.0] | 2.71 | 7.13 |
| legacy | 0.20 [2.2] | 4.18 | 8.05 |

Without formants every engine's envelope distance is 3.0–3.1 dB at −1 st and 4.2 dB at −1.5 st (the envelope moves with
the pitch, as expected), and the LSD to the plain R3 reference is 5.4–6.4 dB for all of them (legacy 5.7–6.4).

Reading: our Rubber Band R3 integration is the closest to the CLI references (≈ 1.2–1.6 dB LSD above the AAC floor)
and preserves the input's envelope at least as well as the reference does (the reference was measured through AAC).
It is not identical to the CLI: the CLI renders in offline mode (whole-file study pass), we must stream in real-time
mode. Signalsmith preserves the envelope nearly as well (≈ 0.3–0.5 dB worse) but is ≈ 1 dB LSD further from R3 and its
formant compensation biases the measured f0 by +1.5…+3.3 cents (still well under audibility, ≈ 5 cents). All engines
hit the requested pitch within ±3.3 cents median. Sample-domain peaks: the decoded inputs peak at −0.4…−2 dBTP; the
renders reach +0.3…+4.9 dBTP (Rubber Band best + formants: +1.8…+4.5), left to the delivery limiter.

## CPU (realtime factor = audio seconds per CPU second, user + system time of the rendering process)

| Engine | mono 48 kHz (passages, load ≈ 70–87) | stereo 48 kHz (10 s, load ≈ 24) |
|---|---|---|
| legacy | 13.6–18.1× | 8.1× |
| signalsmith best | 13.9–16.7× | 8.1× |
| signalsmith fast | 26.7–30.5× | 12.9× |
| rubberband-r3 best | 6.6–8.1× | 3.5× |
| rubberband-r3 fast | 14.4–18.5× | 7.7× |

The same code runs in the preview worklet and the export, so these are both preview and export costs (export may run
several mixes in parallel; the preview runs one per slot in the audio thread). Host: shared 16-core Linux machine,
Node 24, measurements under the stated load averages, so absolute numbers are pessimistic; rerun with
`scripts/pitch-compare/render.ts` (prints the factor per config).

## Limits

- Clip effects (any latent effect, the Pitch Shifter included) start every clip from a clean state with zero history:
  no pre-roll from source handles before the in point or past the out point yet. On butt-cut dialogue put the Pitch
  Shifter on the track (A1), where it runs continuously. Recorded in [gaps.md](../gaps.md).
- Audio scrubbing (main thread) does not instantiate the Rubber Band module (synchronous instantiation is not allowed
  there): scrub audio of a `rubberband-r3` shifter uses Signalsmith.
- Rubber Band in the preview: `best` costs ≈ 3.5× realtime per stereo slot on this host and computes in bursts; on a slow
  machine use `fast` (it applies to the export too: preview and export stay identical).
- Our R3 is the real-time mode of the library; offline-mode (study pass) renders of the CLI differ slightly (table above).
- `engine` and `quality` are not keyframable; changing them restarts the shifter (a short gap of its latency).

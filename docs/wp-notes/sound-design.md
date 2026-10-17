# Sound Design / SFX layer (wp-note)

Spec: [`docs/specs/12-sound-design.md`](../specs/12-sound-design.md). Inspiration (ideas only, no code):
`github.com/Bodila51/opus-sound-layer` (MIT).

Each phase appends its design notes, usage, verified behaviour (with the commands that measured it), limits and
known bugs below.

## Phase 0: pre-existing audio bugs

### WP0.1 preview

Scope: `packages/compositions/src/audio/*`, `packages/compositions/src/layers/AudioLayer.tsx`, `apps/web/src/audio/*`
(preview mix graph, worklets, effect slots, scrubbing, voice-over, automation, browser decode, audio engine ops).

**Design: preview latency compensation = the export's plan.** `planMixLatency(mix, latencyOf, masterExtra)`
(`packages/compositions/src/audio/graph.ts`) is the `OfflineMixer` algorithm: strips in processing order; `inLat` =
latest arrival of the strip's inputs, `preLat` / `postLat` after the pre / post-fader inserts; every output and send
route gets `delay = inLat(target) − tap latency`; `total` = the Mix's `postLat` (+ the preview loudness limiter's
latency while normalisation is on). `MixGraph` applies it: each route into a bus is a `DelayRoute` (a DelayNode only
when the delay is > 0), the read-ahead is published (`graph.latency`, `onLatency`) and `AudioLayer` starts every clip's
media `graph.clipLead(clip)` early (read-ahead + its own clip-effect latency, the existing `compensate()`), so the
Mix output lines up with the picture. Each stage is evaluated at the time of the samples it processes
(`stripStageTimes`: pre inserts `t + total − inLat`, fader / mute / pre sends `t + total − preLat`, post inserts
`t + total − preLat`, pan / puck / post sends `t + total − postLat`; clip nodes and Remotion's per-clip volume
`t + total`), exactly the export's times. Preview slot latency comes from the processor itself
(`registerPreviewInsert(id, factory, latency)`; `installAudioFxPreview` passes `effectLatency(effect, ctx.sampleRate)`).
Alternatives rejected: per-track scheduling offsets cannot align a strip that reaches the Mix by two paths (output and
a send through a submix with an insert); delaying the picture is not possible with Remotion's player.

**Voice-over.** `takeRange` / `captureSampleAt` / `voiceoverLatencySeconds` / `assembleTake`
(`apps/web/src/audio/voiceover.ts`): the take starts at the capture sample of the record point plus the round trip =
Program monitor `baseLatency + outputLatency` (the capture context's only as a fallback) + input device latency
(`MediaTrackSettings.latency`, Chrome) + Preferences ▸ Audio ▸ Voice-Over Record ▸ **Latency Offset** (ms, −500…500,
default 0; `audioPrefs.voiceOver.latencyOffsetMs`). The frame → capture-sample mapping uses the lower envelope of the
frame-report / capture-clock pairs within ±1 s plus one capture-clock step (gcd of the readings, capped by the
offsets' 90th-percentile spread): reports are never early and the capture clock lags by less than one step, so this
undoes both jitters, and a stalled report cannot pull it.

#### Findings

| # | Finding | Verdict | Regression test (failed before → passes) |
|---|---|---|---|
| 1 | Track / submix / Mix insert latency not compensated in the preview (documented limit): a 256-sample Mix reverb put the whole preview 256 samples late; a 2048-sample track insert put that track 43 ms behind the others | **fixed** (plan + DelayNode routes + read-ahead + stage times) | `packages/compositions/test/audio-preview-oracle.test.ts` "identical to the export, sample for sample" (before: best lag 256, max \|Δ\| 1.17; after: lag 0, max \|Δ\| < 1e-4); `audio-preview-latency.test.ts` (plan = `OfflineMixer.latency` and every route aligned, 200 random topologies) |
| 2 | Preview loudness limiter (normalisation on) delayed the whole mix by its look-ahead, uncompensated | **fixed** (counted in the read-ahead while enabled) | oracle "loudness normalisation" (before: lag ≠ 0) |
| 3 | Re-enabling loudness normalisation replayed the limiter's stale look-ahead audio (a 5 ms burst of old audio) | **fixed** (fresh limiter on enable) | `audio-worklet-limiter.test.ts` "re-enabled after a bypass" (before: stale peak 0.5) |
| 4 | Sends into a 5.1 submix used a fixed front-centre puck in the preview; the export pans them with the strip's puck | **fixed** (preview uses the strip's puck, at the send's tap time) | oracle (A2 sends to a 5.1 submix with the puck at −80/−60; with the old puck max \|Δ\| 0.093) |
| 5 | Clip gain + Volume above +24 dB (Remotion's volume limit, `MAX_PREVIEW_GAIN`) was clamped in the preview; the export applies it all (Audio Gain goes to +96 dB, e.g. Normalize Max Peak of a quiet take) | **fixed** (`clipGainExcess`: the graph applies the rest, before the slots or after them for clips with effects) | oracle (+30 dB on A2 and on A3 with a clip effect; without the fix max \|Δ\| 0.34); `audio-preview-latency.test.ts` clip-gain case |
| 6 | Clip-effect latency was converted at a hard-coded 48 kHz | **fixed** (context rate) — no audible case measured (the Player's context is 48 kHz) | `audio-preview-latency.test.ts` "preview slot latency" (96 kHz) |
| 7 | Voice-over input latency not compensated (documented limit) | **fixed** | `apps/web/test/voiceover-latency.test.ts`: simulated 25 ms input + 40 ms output latency, report jitter, 480-sample capture buffer → clap within one buffer; without the input term it lands 1200 samples off; property over output 0–200 ms, input 0–100 ms, buffers 256–1024, 60/120 Hz reports (300 runs) |
| 8 | Voice-over located the record point from the single first frame report at/after it: one stalled report shifted the whole take by the stall | **fixed** (lower envelope of the pairs within ±1 s) | `voiceover-latency.test.ts` "a late frame report (stall)" |
| 9 | Voice-over used the capture context's output latency, not the Program monitor's (the context the talent hears) | **fixed** (playback context first) | `voiceover-latency.test.ts` "user offset and the capture-context fallback" |
| 10 | Reverse audio scrubbing near the sequence start played content after the playhead (window clamped to 0 but kept its length, then reversed) | **fixed** (`scrubWindow`) | `apps/web/test/audio-scrub-window.test.ts` (frame 1: old window [0, 1920) → [0, 1600); frame 0: none) |
| 11 | Sequence ▸ Loudness Normalization ▸ Analyze showed a result even when storing it was refused (read-only project) | **fixed** (refusal raised to the dialog) | `apps/web/test/audio-engine-ops.test.ts` |
| 12 | Strip edits made after the preview graph was built were never heard (it kept the strips of its last topology rebuild): adding a track / submix / Mix effect, a static fader, pan or send-level change, mute — silent until a routing change or reload. Found by the real-app run below (an added Hard Limiter and Amplify −20 dB did nothing) | **fixed** (`MixGraph.update` always takes the new strips) | oracle "edits after the graph is built are heard" (before: lag −256, the insert absent) |
| 13 | Preview effect slots glided from the catalogue defaults to the instance's values over the first 20–100 ms (Amplify −40 dB started at 0 dB); WP0.2 fixed the export's `EffectSlot`, the preview's `FxSlotCore` had the same flaw (reported by WP0.2) | **fixed** (the first instance snaps; later edits still glide) | `packages/compositions/test/audio-fx-slot-start.test.ts` (before: first quantum 0.499 instead of 0.005) |
| 14 | A new preview slot processed its first quanta with no effect at all (pass-through, no latency) until the instance arrived by message: a short unprocessed burst whenever a slot was created (and a flaky oracle) | **fixed** (the instance comes with the node in `processorOptions`) | `audio-fx-slot-start.test.ts` "processes its first quantum with the instance it was created with" (before: 0.5) |
| R1 | Non-finite limiter ceiling → NaN output | **rejected**: `TruePeakLimiter` stays finite (the test passed before); a finite fallback is kept as defence | `audio-worklet-limiter.test.ts` (regression only) |
| R2 | Reversed clip whose content reaches before the media start: `browserOpenClip` (and the engine's `decode.ts`, `adelay` after `areverse`) put the silence at the start | **rejected as unreachable**: audio transition handles are limited to available media (`clipHandles`) and `sourceIn ≥ 0`, so the content range never starts before 0; noted for the engine audit | — |
| R3 | `faderToDb(NaN)` returns +15 dB | **rejected**: needs a pointer-down on a zero-height fader | — |
| R4 | Automation is recorded at picture time while the talent hears the output later | **rejected**: Premiere records the same way; not a defect | — |
| R5 | `FxSlotCore` forces `enabled: true` | **rejected**: `buildAudioMix` and the slot chains pass enabled effects only | — |
| R6 | STFT inserts (FFT Filter, Click Remover…) differ from the export by up to ≈ −43 dB in the ≈ 0.2 s after an onset | **rejected as a latency bug**: their frame phase follows where processing started (two exports with different range starts differ the same way); aligned (lag 0) and identical (< 3e-4) after the onset | oracle "frame-based (STFT) inserts" |

#### Verified (measured)

- `pnpm vitest run packages/compositions/test/audio-preview-latency.test.ts packages/compositions/test/audio-worklet-limiter.test.ts apps/web/test/audio-scrub-window.test.ts apps/web/test/voiceover-latency.test.ts apps/web/test/audio-engine-ops.test.ts apps/web/test/audio-mix.test.ts --maxWorkers=2`: all pass.
- `pnpm vitest run packages/compositions/test/audio-preview-oracle.test.ts --maxWorkers=2` (headless Chrome,
  OfflineAudioContext with the real worklets vs `renderMixToBuffers`): 3 passed. Scene: 3 noise tracks, A1 → S1
  (−3 dB, post-fader Hard Limiter), A2 pre-fader send to S1 and post-fader send to a 5.1 submix, A3 panned, Mix
  Convolution Reverb, clip effect on A3, +30 dB clip gain on A2 / A3. Exact set (limiters + convolution, read-ahead 1004
  samples): max |preview − export| < 1e-4 over 0.6 s, lag 0. The same scene against the pre-fix graph: lag 256, max
  |Δ| 1.17 (STFT set: lag 534). Now 4 tests (with the "edits after the graph is built" case), run 3 times in a row:
  4 passed each time.
- Real app (built stack, `E2E_PORT=48100 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-p0-preview.spec.ts`,
  headless Chrome, the Program monitor's AudioContext tapped at its destination): a click every 0.5 s on A1 (Hard
  Limiter track insert, 374 samples) and on A2. Before fixes 1 and 12 the tap measured pairs of single clicks
  (0.354) 374 samples apart; after: one click of 0.707 (both tracks summed) every 24 000 samples. 2 passed (with the
  Preferences ▸ Audio Latency Offset row, screenshot `test-results/e2e-sound-p0/preferences-audio.png`).
  `e2e/audio-mix.spec.ts -g "Audio Meters|Voice-over"`: 2 passed (the fake-microphone take lands on A3 as
  "Voice-over 1" in one "Record Voice-over" step).
- Not run here: a real microphone (none on this machine); voice-over timing is verified by simulation only.

### WP0.2 audio core

Scope: `packages/project/src/audio/*`, `packages/project/src/essential/*`, the audio and essential command handlers,
the audio parts of `transitions.ts` / `audio-fade.ts`, `apps/engine/src/audio/*`, `packages/audio-fx/src/*` and
`packages/audio-dsp/src/*`. The preview side (`packages/compositions/src/audio`, `AudioLayer.tsx`, `apps/web/src/audio`)
belongs to the parallel preview package, so the two documented latency limits (track-insert preview latency,
voice-over input latency) are not handled here.

Method: the code was read for the bug classes that spec 12 §0 lists, plus the classes in P0-R1. Two read-only audit
passes (audio-fx effects; audio-dsp, Essential Sound and the mix fingerprint) ran scratch scripts, and every
candidate was reproduced numerically. Each confirmed bug got a regression test, which was run against the unfixed
code and failed, then against the fix and passed. For the fixes in `audio-fx`, `essential`, `audio-dsp`,
Scientific, Convolution and Delay this was done by checking out the old file, running the test, and restoring the
fix.

#### Findings

| # | Area | Finding | Status | Regression test |
|---|---|---|---|---|
| 1 | engine decode | **Reversed clips were exported 250 ms off.** `-t` reads 0.25 s past the span, and `areverse` played that extra first. Content past the media end, or a head handle reaching before 0, also came out on the wrong side. Fix: `atrim` + `apad` to the exact span before `areverse`; a reversed lead is no longer delayed in. | fixed | `apps/engine/test/audio-decode.test.ts` (4 tests, real ffmpeg ramp signal) |
| 2 | mixer | **Reversed clips: export volume, pan and clip-effect automation were one frame off the preview.** The export used `duration − local`; the preview and every keyframe writer (Clip Mixer, auto-duck) use `contentTimeAt`'s `duration − 1 − local`. | fixed | `audio-mix.test.ts` › "reversed clips: export volume and pan follow the preview content time" |
| 3 | mix plan | **Solo walk stopped at strips already kept by another seed.** With `A1 (solo) → S1 → S2 (solo)` and `A3 → S1`, A3 was silenced. Fix: one visited set per walk. | fixed | `audio-mix.test.ts` › "solo: a strip reached from one soloed strip…" |
| 4 | mixer | **Aliasing varispeed of synthetic tones.** A Bars and Tone / leader clip sped past Nyquist was generated at `sr / rate` and folded down (1 kHz × 30 → audible 18 kHz alias). It is now silent, like the band-limited resampling of media. | fixed | `audio-mix.test.ts` › "a synthetic tone sped up past Nyquist is silent" |
| 5 | fingerprint | **`mixFingerprint` ignored Interpret Footage** (assumed frame rate, loop), so a stale loudness analysis read as current. It is hashed only when set, so existing analyses stay current. | fixed | `audio-mix.test.ts` › "mixFingerprint changes when Interpret Footage changes…" |
| 6 | invariants | `repairAudioMix` let an invalid send shadow a valid send with the same id (`seen` updated before the validity check); truncation to 5 sends now leaves a note. `repairDocument` renames duplicate ids first, so this was latent through the public path. | fixed | `audio-mix.test.ts` › "repairDocument keeps a valid send whose id an invalid duplicate used first" |
| 7 | audio-dsp | **Whole-programme true peak missed the last 16 samples** (the interpolator lag), e.g. a transient at the end of a short SFX. `TruePeakDetector.flush()` / `LoudnessMeter.flush()` push the tail through; used by `blockTruePeak`, `measureLoudness`, the export mixdown and normalisation. Live meters don't flush. | fixed | `oversample.test.ts` › "true peak at the end of a programme" (2 tests) |
| 8 | engine service | Normalising media shorter than one 400 ms gating block failed as `SILENT`. It is now `TOO_SHORT` with the duration and true peak. | fixed | `apps/engine/test/audio-mix.test.ts` › "refuses to normalise audio shorter than one 400 ms gating block…" |
| 9 | essential | Auto-Match on an unmeasurable clip shorter than 400 ms said "silent"; it now says "shorter than 400 ms". | fixed | `essential.test.ts` › "Auto-Match skips an unmeasurable clip shorter than 400 ms…" |
| 10 | essential | **Setting the SFX type reset the clip's own pan to 0**, and Clear Audio Type / Pan off did too. Pan is now an offset like Clip Volume, as the module header always said. | fixed | `essential.test.ts` › "the SFX type keeps the clip's own pan…" |
| 11 | essential | **Clamp then undo.** Clip Volume +15 over a +10 level capped at +15; switching it off gave 0, not 10. A −96 dB (−∞) fade keyframe came back at −90. What the fader range clamps away is now kept per value (`EssentialSound.residual`) and given back. | fixed | `essential.test.ts` › "Clip Volume on/off restores levels the fader range clamped…" |
| 12 | essential | **One out-of-range stored field reset all Essential Sound settings to defaults** (gain, volume and effects were then reconciled from the wrong state). Now: clamp first, then fall back per section. | fixed | `essential.test.ts` › "one out-of-range stored field does not reset…" |
| 13 | essential | `applyPreset` with invalid explicit `settings` silently applied the defaults; it now refuses with `E_INVALID_PARAM` (out-of-range numbers are clamped like every other setting). | fixed | `essential.test.ts` › "applyPreset refuses invalid explicit settings…" |
| 14 | essential | `loudness.targetLufs` had no range: 500 was accepted and Auto-Match then set +96 dB. It is limited to −60…0 LUFS (schema and clamp). | fixed | `essential.test.ts` › "the loudness target is limited to −60…0 LUFS" |
| 15 | audio-fx host | **Every hosted effect glided from its spec defaults to its values over the first 20–100 ms of each clip and export** (Amplify −40 dB started at 0 dB; a keyframed Hard Limiter ceiling of −12 dB let −1.5 dBFS through). Fix: the slot snaps at construction and at its first control point after a reset. | fixed | `audio-fx/test/regressions-p0.test.ts` › "hosted effects start at their parameter values" (2 tests) |
| 16 | Dynamics | **Compressor make-up was applied after the limiter** (make-up +12 dB with the limiter at −6 dB gave −2 dBFS peaks). Make-up now belongs to the compressor stage, before the limiter. `transferDb` matches. | fixed | `regressions-p0` › "make-up gain cannot push the output over the limiter threshold" |
| 17 | Scientific Filter | **Steep or narrow designs were silent** (Butterworth LP order 12 at 20 Hz: −692 dB in the pass band). The whole cascade gain sat on section 0 (≈ 1e-35) under the 1e-30 state flush. Each section is now normalised at a pass-band reference frequency. | fixed | `regressions-p0` › "Scientific Filter › passes its pass band" (5 designs) |
| 18 | Scientific Filter | Raising `order` (keyframable) brought back stale state in sections that came back into use (a −23.7 dBFS burst on silence). Those sections now start from zero. | fixed | `regressions-p0` › "sections that come back after an order change start from silence" |
| 19 | 5.1 inserts | **Surround Reverb, Mastering, Loudness Meter and Auto Gain ignored channels 2–5** (no Dry/Wet or output gain on C/LFE/Ls/Rs, no maximiser there, a C-only signal metered −∞, the LFE counted for Auto Gain). They now process every channel; meters and Auto Gain use the BS.1770 weights; the centre feeds the Surround Reverb. | fixed | `regressions-p0` › "5.1 inserts process every channel" (4 tests) |
| 20 | Multiband | Crossovers stopped 1–16 ramp steps short of their target (1000 Hz settled at ≈ 990 Hz) because they were redesigned only while gliding. One more redesign now runs after the glide. | fixed | `regressions-p0` › "Multiband Compressor crossovers reach their target" |
| 21 | Convolution | Room Size changed the wet level non-monotonically (−1.4 dB at 33 %): linear-interpolation decimation loses a ratio-dependent part of the energy. The resampled impulse is now energy-matched. | fixed | `regressions-p0` › "Convolution Reverb Room Size keeps the wet energy" |
| 22 | Delay | Tempo mode silently clamped to 4 s (a whole note at 30 BPM = 8 s). The line now holds a whole note at 20 BPM (12 s). | fixed | `regressions-p0` › "Delay in tempo mode" |
| 23 | Remix | Unbounded allocation: the API accepted 4 h of music, which means a beats² similarity matrix (≈ 3 GB per hour at 200 BPM) plus the decoded range, enough to crash the engine. The analysed range is now capped at 30 min (`MAX_REMIX_SOURCE_SECONDS`). | fixed | `packages/api/test/api.test.ts` › "caps the analysed music range" |
| R1 | ducking | `audio.autoDuck` replaces every Volume keyframe of the target, not only those inside the regions. | rejected | Adobe documents this: Generate Keyframes removes the keyframes added before it and replaces them on every regeneration ([Adobe: automatic audio ducking](https://helpx.adobe.com/premiere-pro/how-to/automatic-audio-ducking.html)). The schema already says so. |
| R2 | ducking | Zero-length, overlapping or edge regions | rejected | `duckKeyframes` filters `b ≤ a`, merges ramps that touch, and clamps to the clip with edge keyframes; read and covered by the audio-dsp ducking tests. |
| R3 | fades | Fade longer than the clip, or 0-frame fades (NaN in `audioFadeGain`) | rejected | One-sided fades are `min(duration, clip)`. `Transition.duration` is an int ≥ 1 in the schema, and two-sided ones go through `fitTransitionDuration`. Unreachable. |
| R4 | export | Normalisation or limiter skipped on some outputs | rejected | Every export path takes its audio from one `renderMixdown` (loudness gain, then the true-peak limiter on the final mix). Analyses run `withoutLoudness` on purpose. There are no stems. |
| R5 | loudness | Short media gives NaN or passes trivially | rejected | Below 400 ms, integrated loudness is −∞ (null in the API), never NaN. Normalisation gain is 0 for a non-finite measure. Only the messages were wrong (#8, #9). |
| R6 | varispeed | Media clips | rejected | The rate change is `asetrate` followed by SoX / swr `aresample`, which low-pass filter. Pitch Shifter drops bins above Nyquist. |
| R7 | resampler | Off-by-one, aliasing | rejected | Measured −84 to −139 dB aliasing at 48→44.1, 192→8 and 96→22.05 kHz; impulses land within ±0.5 sample; lengths are `round()`. |
| R8 | effects | Block-size dependence, latency, reset | rejected | Swept 22.05/96/192 kHz, 1/2/6 channels, parameters at 0/5/95/100 %. Impulse delay equals the reported latency for every latent effect; `reset()` equals a fresh instance. |
| R9 | biquads, WAV, sync | Instability; hostile WAV; empty or NaN sync input | rejected | Max pole radius 0.99999999999 over every type × 4 rates × extreme f/Q/gain. 20 000 mutated WAVs only throw, with no hang or unbounded allocation (`decodeWav` has no app caller). Sync returns null or works. |
| R10 | thinning | `thinPoints` / `writeLaneKeyframes` | rejected | RDP keeps every dropped point within the tolerance, and `minInterval` is documented to override it except for the last point. Automation outside the pass is kept with ε-guard keyframes. |

#### Verified behaviour (measured, this branch)

The commands below, run on the shared host (load ≈ 110 on 16 cores):

- `pnpm vitest run apps/engine/test/audio-decode.test.ts apps/engine/test/audio-crossfade.test.ts apps/engine/test/gaps-audio-channels.test.ts apps/engine/test/audio-mix.test.ts --maxWorkers=2 --testTimeout=900000`
  passed 15 of 15. These are real ffmpeg exports: balance, sends, 5.1, normalisation within 0.15 LU, and the reversed decode
  alignment within 3 samples.
- The fail-before / pass-after evidence for every row above is the regression test named in it. The `audio-fx` rows
  were run with the old file checked out: 2 + 1 + 4 + 4 + 1 + 1 + 1 failures before, all passing after.
- `pnpm vitest run packages/project packages/audio-fx packages/audio-dsp packages/api --maxWorkers=2 --testTimeout=600000`
  ran 1953 tests in 165 files: 1953 passed, 3 failed. The 3 failures were the tests' own timeouts or perf budgets
  under load 110 (sync GCC-PHAT 60 s / 30 s timeouts, Pitch Shifter 8× realtime) in files this package does not touch.
  Rerun alone, `pnpm vitest run packages/audio-dsp/test/sync.test.ts …` passed 12 of 12 and
  `packages/audio-fx/test/reverb-pitch.test.ts` passed 13 of 13.
- `pnpm vitest run apps/mcp/test/audio-fx.test.ts apps/web/test/panel-input-validation.test.ts packages/compositions/test/audio-fx-preview.test.ts packages/audio-dsp/test/sync.test.ts --maxWorkers=1`
  passed 28 of 28 (dependants of the Essential Sound and effect-host changes).
- `pnpm lint` passed. `pnpm --filter <pkg> typecheck` passed for project, audio-dsp, audio-fx, api, engine, mcp and
  compositions. The workspace `pnpm typecheck` stops at a pre-existing error in
  `apps/web/test/clip-extensions.test.tsx` (`refs` on `TransactionResult`, from commit 48a90b6c on main), which this
  package does not touch.

#### Limits and notes for the next packages

- **Preview counterpart of #15.** `packages/compositions/src/audio/fx-processor.ts` (the preview AudioWorklet chain) uses
  the same `setEffects`-then-`automate` pattern, so the preview probably has the same start-of-clip glide. It is
  outside WP0.2's scope; the preview package should check it. Until then the export no longer glides and the preview may.
- #11 stores `residual` on `AudioClip.essential` (an optional field of the loose Essential Sound object; no schema bump).
  Only the commands manage it.
- #10 changes Pan to an offset: an SFX clip's pan is now `own pan + Essential Sound Pan` (clamped ±100, losslessly), not
  overwritten.
- #19: the Surround Reverb sends the 5.1 centre into the reverb, with its wet on L/R. Mastering's reverb and widener
  stay L/R. LFE gets the exciter, which does nothing there (it is a 3 kHz high-pass).
- #21: a mono Convolution instance still varies by ≈ 0.6 dB between 100 % and 10 % Room Size. That comes from the
  correlation of the decorrelated L/R impulses; the resampling is not band-limited.
- #23: music longer than 30 minutes can't be remixed (a validation error names the limit).
- `mixFingerprint` doesn't follow expressions that drive clip volume from other layers. Audio-effect parameters refuse
  expressions; clip Volume through an expression is the remaining (rare) gap.

### Phase 0 verification

Branch `feat/sd-p0-verify` (from `feat/sound-design` 3e79efd1). Three read-only review passes covered the WP0.1 and
WP0.2 diffs (preview graph and AudioLayer; project / essential / audio-fx / audio-dsp / api; web, engine, MCP and docs
consumers). Every confirmed defect below got a regression test that was run against the unfixed code (failed) and
the fix (passed).

#### Findings and fixes

| # | Finding | Fix | Regression test (before → after) |
|---|---|---|---|
| V1 | `pnpm typecheck` red: `apps/web/test/clip-extensions.test.tsx` read `refs` from a `TransactionResult` without narrowing (from main 48a90b6c). The type is right (a discriminated union; `refs` exists only when `ok`), the test was wrong | the test narrows with `if (!added.ok) throw …` like its siblings | `pnpm typecheck` passes; the file's 5 tests pass |
| V2 | **Introduced by WP0.1:** with any read-ahead (a latent track / submix / Mix insert, or loudness normalisation) every audio clip that starts during playback lost its first `read-ahead` samples, at every cut. Audio Sequences were not premounted, so a clip's source was created only when the picture reached it and could not start early (`compensate()` took its late branch) | audio Sequences are premounted by `max(2 s, lead)` (`lead` = `MixGraph.clipLead`), with an empty pointer-less layout so Remotion premounts them; the FrameWindow span includes it | `e2e/sound-p0-preview.spec.ts` "a clip that starts mid-playback is heard from its first sample": a 0.25 click on the first sample of a clip at frame 40 (A1 has a Hard Limiter, 374 samples). Before: no click anywhere near 64 064 samples. After: a click of 0.1768 (= 0.25 · −3 dB pan law) at exactly 64 064, in two runs |
| V3 | Essential Sound residual keyed by keyframe id was lost by split / duplicate / paste / remix / nest (`reidentifyClipChildren` renames keyframes) | residual keys follow the renamed Volume / Pan keyframes | `essential.test.ts` "a split keeps the clamp residual…" (before: right half `[0, 0]`, after `[10, 8]`) |
| V4 | A residual was given back after the user moved the level (Effect Controls, Clip Mixer): Volume 10, Clip Volume +15, user sets 0, Clip Volume off → −5 dB instead of −15 (pan: 50 instead of 80) | a residual applies only while its value still sits on the bound it was clamped to; residuals are capped at the range width | `essential.test.ts` "a level the user moved after the clamp…" (before −5, after −15 / 80); "a hostile stored residual is bounded" (defence: passed before too) |
| V5 | `residual` was writable and listed as a setting (`essentialSound.set {"residual.pan.value": …}` accepted, then overwritten; `get_essential_sound` returned it) | refused by `setEssentialValue`, left out of `essentialKeys` and of `get_essential_sound` | `essential.test.ts` "residual is not a setting" |
| V6 | Essential Sound ▸ Auto-Match on clips shorter than 400 ms still said "The clips are silent": the web op threw away the command's per-clip reasons, so WP0.2 #9 never reached the editor | `autoMatchLoudness` returns the command's per-clip result; `autoMatchMessage` words it (matched / silent / shorter than 400 ms); nothing matched is an error toast (panel and menu command) | `apps/web/test/essential-auto-match.test.ts` (new API; the old code returned only the measurements) |
| V7 | Clip Mixer (`clipLaneValue`) read reversed clips one frame off: `duration − local` while the preview, the export mixer (WP0.2 #2) and the keyframe writers use `duration − 1 − local` | uses `contentTimeAt` | `apps/web/test/audio-mix.test.ts` "Clip Mixer reads a reversed clip…" (before −13, after −14 dB) |
| V8 | A reversed decode window entirely before the media start (empty span): `atrim=duration=0` means "no limit", so 0.25 s of the file came out reversed instead of silence | trims and pads in input samples (`atrim=end_sample=n`, `apad=whole_len=n`), an empty span is cut to nothing | `apps/engine/test/audio-decode.test.ts` "a reversed window entirely before the media start is silence" (before: non-silent). Latent: WP0.1 R2 found no handle that reaches before 0 |
| V9 | TOO_SHORT "with the duration and true peak" (WP0.2 #8): the job queue keeps only code and message, so the true peak never reached a client | the message carries both and names Normalize Max Peak | `apps/engine/test/audio-mix.test.ts` TOO_SHORT case (message regexes) |
| V10 | MCP docs: `normalize_media_loudness` neither mentioned TOO_SHORT / SILENT nor hinted correctly (always "check the media is online"); `auto_match_loudness` said only "silent clips"; `set_essential_sound` and the guide did not say that Clip Volume and the SFX Pan are offsets; `remix_audio` did not mention the 30-minute cap and answered it with a "steady beat" hint; the web Remix showed a raw zod message | code-specific hints, descriptions and guide text; MCP and web check the 30-minute cap before calling the engine with a clear message; `wp-notes/audio-fx.md` and the `model.ts` header describe Pan as an offset | `apps/mcp/test/audio-fx.test.ts` 3/3 |
| V11 | `ClipNodes.connect` set a new clip's pan / trim / level at the picture time and at 30 fps, then glided to the read-ahead time's values | connects at the read-ahead time with the sequence rate | covered by the oracle and the e2e runs (no unit harness for Web Audio in Node) |

Rejected or recorded as limits (not fixed): losing the first `read-ahead` samples right after Play or a seek (a source
cannot start before the play press; documented in `wp-notes/audio-fx.md` §6); route DelayNodes may replay up to
`read-ahead` of pre-seek audio after a seek, and a read-ahead change during playback re-creates every clip's media
player (both suspected from the code, not measured; recorded in `wp-notes/audio-fx.md` §6); `Delay` allocates 12 s
per channel per instance (≈ 4.6 MB stereo 48 kHz; bounded, reset zero-fills it); `flush()` of the true-peak meters is
not idempotent, but every caller flushes once at the end; old projects with keyframed SFX pan saved before WP0.2 get
every keyframe shifted when Pan is switched off (the old code wrote one key; Phase 0 is unreleased, no migration).
The preview transport limits and the SFX Pan reading were taken up by the close-out below (C1–C4).

#### Gate (measured, this branch, shared host with 16 cores)

- `pnpm lint`: passed (Biome 2563 files, check-tokens / anime / layers / assets ok). `pnpm notices --check`: current
  (150 packages, 31 ported records).
- `pnpm typecheck`: passed after V1 (19 workspace projects).
- First full `pnpm test` (load 20–120 from other agents): 5 233 passed, 26 failed, 493 skipped in 578 files (31
  files failed). Every failing file was rerun alone (`pnpm vitest run <file> --maxWorkers=1`, load 7–72): all 31
  passed. The failures were timeouts and budgets under load (STACK_TRACE_ERROR timeouts, `beforeAll` hooks over
  120–300 s, Pitch Shifter 8× realtime, a 20 000-instance mesh refusal measured at 21.3 s for a 20 s budget,
  interchange fuzz inputs at 2.7–3.4 s for a 2 s limit, avc3 playback 24 / 33 of 45 frames), plus
  `apps/mcp/test/audio-fx.test.ts`, which ran while V10 was half-written and passed 3/3 afterwards.
- After the fixes, `pnpm verify` twice on the final code (lint and typecheck green both times; `pnpm test` then stopped
  the chain): run 1 (load 44–57) 5 363 passed, 4 failed in 3 files (Pitch Shifter 8× realtime budget, avc3 playback
  frame counts, a 5 s tracking timeout); run 2 (load 10 → 56) 5 363 passed, 4 failed in 4 files (timeouts of 120 s /
  180 s / 5 s in `audio-fx/registry`, `audio-fx-preview`, `camtrack-solve`, and the Pitch Shifter budget). All 7 files
  rerun alone afterwards (`pnpm vitest run <file> --maxWorkers=1`, load 12–34): all passed (13/13, 2/2, 8/8 + 1
  skipped, 5/5, 2/2, 12/12). No test was changed to get there. `pnpm notices --check`: current.
- `pnpm build` (the step after test in `verify`, run on its own on the final code): passed.

#### Real app (built stack, measured)

`pnpm build`, then `E2E_PORT=48301 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-p0-preview.spec.ts` (headless
Chrome; the tap now routes everything any node sends to the speakers through one bus per context; the old tap
recorded only the first node connected to the destination, which after V2 was not the whole mix): 5 passed.

- Preview, A1 (Hard Limiter insert, 374 samples) and A2 play the same click track: one click of 0.7071 every 24 000
  samples (both tracks summed, aligned to the sample). One run of the 5 under load 60–75 showed a Remotion resync (a
  4 885-sample jump); rerun alone twice it passed.
- Export of the same sequence (native path, MP4/AAC), audio decoded with
  `ffmpeg -i sound-p0-insert.mp4 -map 0:a:0 -ac 1 -af pan=mono|c0=c0 -ar 48000 -f f32le -`: six clicks at exactly
  0, 24 000, 48 000, 72 000, 96 000 and 120 000 samples, 0.699–0.702 (0.58 for the first, AAC's start), so the
  track insert's latency is compensated in the export and preview and export agree on timing to the sample.
- Clip head at a cut: see V2.
- Screenshots looked at: `test-results/e2e-sound-p0/essential-sound-sfx.png` (Essential Sound on an SFX clip:
  Loudness, Creative, Pan, Clip Volume, Mute) and `preferences-audio.png` (Preferences ▸ Audio ▸ Voice-Over Record ▸
  Latency Offset 0 ms with its explanation).

Phase 0 "Done when": every confirmed bug of WP0.1, WP0.2 and this verification has a regression test that failed
before and passes after (V5's and V4's hostile-residual tests are defence and passed before); the sample-level oracle
`packages/compositions/test/audio-preview-oracle.test.ts` (4 tests) passes; the voice-over alignment test
`apps/web/test/voiceover-latency.test.ts` (6 tests) lands within one buffer under simulated input latency.

### Phase 0 close-out

Branch `feat/sd-p0-closeout` (from `feat/sound-design` e9b8b01a). Scope: the preview limits the verification left
(`packages/compositions/src/audio/*`, `AudioLayer.tsx`, `SequenceComposition.tsx`, `previews.tsx`) and the SFX Pan
reading of older projects (`packages/project/src/essential/*`, `invariants.ts`, the essential handlers).

**Design: the graph follows Remotion's transport.** Remotion (4.0.499) suspends the AudioContext while paused,
anchors audio to the picture (`audioSyncAnchor`: context time of sequence time 0), dispatches `changed` on that anchor
at a seek (every media player then drops its queued buffers and reschedules), and on Play starts the picture once
the context's output timestamp passes the resume time (`waitUntilActuallyResumed`) with a 30 ms fade-in.
`MixGraph.attachSync` (wired by `MixGraphDriver` from the shared audio context and `usePlayingState`) uses exactly those:

- **Primed start** (C1). After a seek while paused (Remotion's `changed` with the context suspended), at load, and
  when the read-ahead changes while paused, the next Play is *primed*: the graph flushes (below), moves Remotion's
  anchor later by the wait `W` = read-ahead + the largest clip-effect latency (`primedAnchor`, ≤ 0.5 s), so every
  source starts at the play position instead of `W` before it, and reports the context's output timestamp `W` late
  until the program reaches the output (an instance shim of `getOutputTimestamp`, cleared as soon as it has), so the
  picture's first frame waits for the program's first sample. The program gets Remotion's own 30 ms fade-in at its
  start (`START_FADE`, a gain after the device fold). A plain pause and Play is not primed: the audio in flight is
  the continuation, and the context resumes it seamlessly. Rejected: delaying the sources (audio late for the whole
  play), pre-rendering the pre-roll (the media is decoded by Remotion's players, not reachable here), holding the
  picture with Remotion's buffering state (it suspends the audio too).
- **Flush at seeks** (C2). `MixGraph.flush()` gives every route delay a fresh delay line and every effect slot (track,
  submix, Mix, clip) and the loudness limiter a fresh processor, so nothing of the old position is in flight or rings
  on: paused, before the primed start; playing, after a 3 ms fade-out of the graph output (`FLUSH_FADE`).
- **Held read-ahead** (C3). The read-ahead follows the plan while paused and is held while playing: a latency change
  during playback (an insert added or removed, normalisation toggled) never re-creates the clips' media players
  (`AudioLayer` keys them on `MixGraph.epoch`, which only moves while paused). The audio in flight is kept: a longer
  route delay appends a segment (`liveDelaySegments`: that much silence, then the audio continues), a shorter one
  shortens the last segments, slots of unchanged effects keep their processors (`SlotChain.sync` reuses them by
  instance id), and a plan shorter than the held read-ahead is padded at the Mix (`pad`). Stage times use the held
  read-ahead (`stripStageTimes(…, readAhead)`). Until playback stops the Mix is late by an added latency (inter-track
  alignment stays exact); at the stop the read-ahead takes the plan's and the next Play is primed.
- **SFX Pan of older builds** (C4). Builds before WP0.2 #10 (on `main` since 2026-10-07, so projects exist) wrote the
  Pan value into the clip's pan: the static value, or one keyframe at the playhead. The offset reading shifted every
  keyframe by −value when Pan was switched off. Settings now carry `panOffset: true` (optional, written by every
  command, not a setting: refused by `essentialSound.set`, left out of `essentialKeys` and `get_essential_sound`).
  Settings without it whose Pan the offset would misread (`legacyPanApplied`: SFX, Pan on, value ≠ 0, and the pan is
  keyframed or not equal to the value) are an `INV-ESSENTIAL` issue; `repairDocument` (`migrate-essential-pan`) and
  every Essential Sound command (`audioClips`) switch the section off with its value kept, so the pan stays as saved
  and switching it on later is a plain offset. An untouched static pan (equal to the value) already reads the same as
  an offset and only gets the marker on the next write (Pan off gives 0, as the old build did). No schema bump: the
  marker is optional, `AudioClip.essential` is `unknown` and the settings schema loose, so older builds keep it.

#### Findings

| # | Item (from the verification) | Verdict | Regression test (before → after) |
|---|---|---|---|
| C1 | Right after Play the first read-ahead samples were lost | **fixed** (primed start) | `e2e/sound-p0-transport.spec.ts` "Play: the first samples…": a click 30 ms after the play position with 41.6 ms of read-ahead (Hard Limiters with 20 ms look-ahead on A1 and the Mix). Before: first click heard at +0.280 s (the 0.03 s one lost). After: at +0.0716 s = W 0.0416 + 0.03, 0.68–0.71; picture − audio equals the no-latency baseline within 7 ms (without the output-timestamp shim it was 40–42 ms off: measured with the shim disabled) |
| C2a | After a seek while paused, Play first played the graph's pre-seek audio (suspected) | **confirmed, fixed** (flush) | same spec, "Play after a seek while paused": pause inside a tone, seek to silence, Play. Before: max 0.352 within 1 ms of the start. After: 0 |
| C2b | After a seek while playing, the pre-seek audio went on for the read-ahead (suspected) | **confirmed, fixed** (fade + flush) | same spec, "seek during playback": before, the tone ran 44.2 ms past Remotion's stop of the old buffers; after, it ends at the stop (−0.02 ms). Offline: `packages/compositions/test/audio-preview-transport.test.ts` "a seek flushes…" (delay lines and a Convolution Reverb tail silent from the next quantum) |
| C3 | A latency change while playing re-created every clip's media player (suspected dropout) | **confirmed, fixed** (held read-ahead, live routes, slot reuse) | same spec, "a latency change during playback" (a 2nd Hard Limiter added to A1 while playing, Δ = 998 samples): before, one gap of 1996 samples (41.6 ms, three runs at low load; the players were re-created); after, 998 samples (Δ, the minimum for a longer latency). Offline: `audio-preview-transport.test.ts` add / remove cases: one gap ≤ Δ, then the new mix exact (< 1e-4) right after it (late by Δ when added, aligned when removed); both fail with fresh delay lines or re-created slots |
| C4 | SFX Pan saved before it was an offset: Pan off shifted every keyframe | **confirmed defect, fixed** (read-time migration) | `packages/project/test/essential.test.ts` "Essential Sound Pan saved by builds where it was not an offset" (6 tests, one a fast-check property over 60 old states). Before: keys `[-50, 20, 50]` became `[-70, 0, 30]`; 5 of 6 failed (the untouched static case already read the same). Real app: same e2e spec, a project file edited to the old form and reopened: keys unchanged, the Pan section shows off, on/off gives `[-30, 40, 70]` and back |

#### Limits (measured where stated)

- A seek *during playback* still loses the first read-ahead after it (plus Remotion's own decode time): the picture
  jumps at once, so the sources cannot start early. Most seeks pause first (TL-832: ruler, keyboard), so the primed
  start covers them; typed timecodes and marker clicks seek while playing.
- A primed start waits `W` (≤ 0.5 s; 41.6 ms in the tests) before the picture moves; above 0.5 s it is not primed
  (the read-ahead is lost as before).
- An insert added while playing leaves the Mix late by its latency until playback stops (inter-track alignment
  exact; 20.8 ms in the test). Removing one keeps alignment (padding).
- Seeks shorter than Remotion's anchor tolerance (0.1 s + output latency) while paused are not seeks for Remotion:
  it keeps its queued buffers, and so does the graph (the audio continues from where it was; Remotion's behaviour).
- The getOutputTimestamp shim relies on Remotion 4.0.499's `waitUntilActuallyResumed`; the e2e sync check fails if
  an upgrade stops using it.
- A buffering stall during the wait of a primed start: Remotion re-anchors to the (still unmoved) picture on suspend;
  the graph puts its primed anchor back and the shim waits only for what is left of the wait (`waitFrom`). This was
  added after the e2e sync check failed by ≈ the wait (39 ms) once at load ≈ 80; it has no dedicated regression test
  (a stall cannot be provoked deterministically in the e2e); the check passed in both full runs after it (load ≈ 100 and 68–150).
- Under heavy load (load average 80–125 on the 16-core host) Remotion re-anchors and reschedules every player during
  playback and its buffer scheduling falls behind; the e2e plays again (up to 3 times) when that happens around the
  measured moment. The pre-fix build showed the same reschedules under the same load.

#### Verified (commands and results)

Shared 16-core host, load average 50–150 from other agents during these runs (stated per run).

- Unit / offline (headless Chrome Web Audio):
  `pnpm vitest run packages/compositions/test/audio-preview-transport.test.ts packages/compositions/test/audio-preview-oracle.test.ts packages/compositions/test/audio-preview-latency.test.ts --maxWorkers=1`:
  18 passed (transport 3, oracle 4, latency 11). The transport add / remove cases were also run with the route delays
  forced non-live and with slot reuse disabled: both failed (2 of 3 each), so they test what they claim.
- `pnpm vitest run packages/project/test/essential.test.ts --maxWorkers=2`: 29 passed. With `model.ts`,
  `invariants.ts` and `handlers/essential.ts` checked out from before C4: 5 of the 6 new tests failed (keys
  `[-70, 0, 30]` instead of `[-50, 20, 50]`).
- `pnpm vitest run packages/compositions packages/project/test/essential.test.ts packages/project/test/invariants.test.ts packages/project/test/audio-mix.test.ts apps/mcp/test/audio-fx.test.ts apps/web/test/essential-auto-match.test.ts apps/web/test/audio-mix.test.ts apps/web/test/audio-mix-panels.test.tsx apps/web/test/audio-engine-ops.test.ts --maxWorkers=2`
  (load ≈ 125): 604 passed, 1 failed (`audio-fx-preview.test.ts`, its 5 s timeout; rerun alone: 2 passed).
  `packages/project/test/fuzz-parsers.test.ts apps/web/test/panel-input-validation.test.ts packages/project/test/gaps-graphics.test.ts apps/engine/test/audio-fx.test.ts`:
  58 passed, 1 failed (the `.3dl` LUT fuzz's 120 s limit under load; not touched here).
- `pnpm lint`: passed. `pnpm typecheck`: passed (after merging `feat/sound-design` d0827ab1). `pnpm notices --check`:
  current. `pnpm build`: passed.
- Real app, built stack, headless Chrome:
  `E2E_PORT=48401 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-p0-transport.spec.ts e2e/sound-p0-preview.spec.ts`
  (load 68 → 150): 9 passed, 1 failed ("seek during playback": every attempt disturbed at load 150; rerun alone 3
  times: 2 passed with the tone ending 0.02 ms before Remotion's stop, the first failed with all attempts
  disturbed). Values from the passing runs: first click at play + 71.6 ms (= 41.6 + 30), 0.707; picture − audio
  0.031 s primed vs 0.034 s without latency (earlier runs: 0.012 / 0.007, 0.016 / 0.020, 0.020 / 0.014); after a
  paused seek max 0; latency change gap 998 samples (four runs). `e2e/sound-p0-preview.spec.ts` 5 passed (clicks of
  0.7071 every 24 000 samples, export six clicks at 0…120 000, a clip at frame 40 heard from its first sample).
  Screenshot looked at: `test-results/e2e-sound-p0-transport/essential-sound-legacy-pan.png` (Essential Sound on the
  reopened clip: SFX, Pan section unchecked).
- Before the fixes (build of e9b8b01a, same specs, load ≈ 15–40): first click lost (first heard at +0.280 s), stale
  tone 0.352 after a paused seek, 44.2 ms of tone after a seek during playback, a 1996-sample gap at the latency change
  (three runs; at load ≈ 90 the same build gave 1996–4812).
- Observed under load (both builds): when the picture falls behind (main-thread stalls), Remotion re-anchors to it and
  reschedules every player; the new anchor is frame-based (1601.6 samples per frame at 29.97 fps), so the sources then
  start at a sub-sample phase and a one-sample click is interpolated over two samples (peaks 0.566 = 0.8 × 0.707 or
  0.283 instead of 0.707; traced with logged anchors in a debug build). The audio is not misaligned; it is the
  reason the e2e plays again when Remotion rescheduled, and why `sound-p0-preview` test 1 failed twice at load ≥ 80.

## Phase 1: sound library

### WP1.1a project model: taxonomy, ranking, provenance, credits, placement

Scope: `packages/project` (pure: zod, immer, `@jasper/audio-dsp`; layer rule unchanged). Spec 12 §2.1 (taxonomy, ranking,
register / `LibraryProvenance`, credits), §2.3 (placement), §2.9 (`media.setLibraryInfo`), P1-R1 and the pure part of
P1-R8. Files: `src/sound/{taxonomy,license,provenance,rank,credits,place,index}.ts`, `src/commands/schemas/sound.ts`,
`src/commands/handlers/sound.ts` (owner `sound-design`), `MediaAssetSchema.library` (`src/schema/media.ts`), INV-LIBRARY
and its repair (`src/invariants.ts`). Everything is exported from `@jasper/project` and from the light subpath
`@jasper/project/sound` (like `@jasper/project/audio`: no immer, no command catalogue; the web panel and audio-fx can
import it cheaply).

#### API (for the engine library, MCP and web)

```ts
// taxonomy.ts
const SOUND_EFFECT_TYPES /* 19 */, SOUND_BED_TYPES /* ambience, roomtone */, SOUND_TYPE_IDS /* 21, = audio-fx order */;
type SoundTypeId; function isSoundTypeId(v: unknown): v is SoundTypeId;
type SoundCategory = 'impact'|'movement'|'build'|'interface'|'texture'|'tonal'|'bed';
const SOUND_FAMILIES = ['impacts','movement','digital','tactile','tonal','beds']; type SoundFamily;
type SoundAlign = 'peak'|'start'|'end'; type SoundWeight = 'hero'|'support'|'ambient';
const VISUAL_KINDS = ['cut','transition','move','land','appear','exit','emphasis','reveal','beat']; type VisualKind;
interface SoundTypeProfile { minDurSec; maxDurSec; maxRiseMs: number|null; mustDecay; maxBelow150Share;
  maxAbove6kShare; maxFlatness: number|null; singleHit; minMaxMomentaryLufs }   // = audio-fx SoundTypeProfile
interface DurationFit { minSec; idealSec; maxSec; window: 'lead'|'span'|null }
interface SoundTypeInfo { id; category; family; defaultAlign; defaultWeight; visualKinds: readonly VisualKind[];
  durationFit: DurationFit; profile: SoundTypeProfile }
const SOUND_TYPES: Readonly<Record<SoundTypeId, SoundTypeInfo>>;
const SOUND_TYPE_PROFILES: Readonly<Record<SoundTypeId, SoundTypeProfile>>;   // pass to audio-fx judgeSound
function typesOfFamily(f: SoundFamily): SoundTypeId[];
function typeFitForVisualKind(type: string, kind: VisualKind): number;        // 1, −0.1 per position, floor 0.6, else 0
function typesForVisualKind(kind: VisualKind): SoundTypeId[];
const TYPE_SYNONYMS: Readonly<Record<string, SoundTypeId>>;                   // lower-case words / phrases
function tokenizeSoundText(text: string): string[];
function typesInTokens(tokens: readonly string[]): SoundTypeId[];
function inferTypesFromName(path: string): SoundTypeId[];                      // ≤ MAX_INFERRED_TYPES (4)

// license.ts
const USER_PROVIDED_LICENSE = 'LicenseRef-UserProvided', ROYALTY_FREE_LICENSE = 'LicenseRef-UserRoyaltyFree',
  JASPER_LICENSE = 'LicenseRef-JasperEditor', UNKNOWN_LICENSE = 'NOASSERTION';
type LicenseClass = 'cc0'|'jasper'|'cc-by'|'cc-by-sa'|'permissive'|'royalty-free'|'user-provided'|'nc'|'nd'|'unknown';
function licenseClass(l: unknown): LicenseClass; function isCommercialSafe(l: unknown): boolean;
function requiresAttribution(l: unknown): boolean; function licensePreference(l: unknown): number;  // 0…1
function licenseUrlOf(l: unknown): string | null;                              // CC deeds and CC0

// provenance.ts
const LibrarySourceSchema;      // {type:'starter', packId?} | {type:'pack', packId} | {type:'folder', rootId, relPath} | {type:'synth', recipe, seed}
const LibraryDescriptorsSchema; // {peakSec, onsetSec, headQuietSec, durationSec, octaveBandsDb[7], centroidHz, maxMomentaryLufs|null}
const LibraryProvenanceSchema;  // looseObject {soundId, title, types: string[] (lower-case ids, newer ones kept),
                                //   source?, license, licenseUrl?, author, sourceUrl?, attribution: string|null,
                                //   descriptors?, snapshotHash?}
type LibraryProvenance; type LibrarySource; type LibraryDescriptors; const LIBRARY_LIMITS;
function readLibraryProvenance(raw: unknown): LibraryProvenance | null;   // lenient field-by-field read
function libraryProvenanceIssue(raw: unknown): string | null;            // INV-LIBRARY message

// rank.ts
interface RankDescriptors { durationSec; peakSec?; riseMs?; centroidHz?; below150Share?; above6kShare?; flatness?;
  octaveBandsDb?: readonly number[] }                                   // a subset of audio-fx SoundDescriptors
interface RankableSound { id; title; tags?: readonly string[]; types: readonly string[]; source: {type: string};
  license: string; descriptors: RankDescriptors; judge?: {ok: boolean; score: number} | null }
interface SoundRankRequest { query?; types?: readonly string[]; visualKind?: VisualKind; windowSec?; align?: SoundAlign;
  length?: 'short'|'medium'|'long'; tone?: 'dark'|'bright'; attack?: 'punchy'|'soft'; weight?: 'light'|'heavy';
  texture?: 'clean'|'noisy'; license?: 'any'|'commercial-safe' /* default commercial-safe */;
  similarTo?: {id?: string; descriptors: RankDescriptors}; limit? }
interface SoundRankContext { usedNearby?: readonly string[] }            // nearest / most recent first
interface RankParts { text: number|null; typeFit: number|null; durationFit; judge; license; source: 0|1;
  similarity: number|null; rotation }
function rankSounds<T extends RankableSound>(entries: readonly T[], request?, ctx?): { entry: T; score: number; parts: RankParts }[];
function passesDescriptorFilters(d: RankDescriptors, req: SoundRankRequest): boolean;
function resolveTypeNames(names: readonly string[]): SoundTypeId[];      // ids or synonyms
function descriptorDistance(a: RankDescriptors, b: RankDescriptors): number;
function durationFit(d: RankDescriptors, type: SoundTypeId|null, windowSec?: number, align?: SoundAlign): number;
const RANK_WEIGHTS, ROTATION_PENALTY = 0.3, DESCRIPTOR_FILTERS;

// place.ts
interface PeakAlignInput { cueFrame; peakSec; onsetSec?; durationSec; headQuietSec?; rate? /* clip speed, default 1 */;
  fps: Rational; align: SoundAlign; subFrame? /* default true */; clampStart? /* default false */ }
function peakAlignedStart(i: PeakAlignInput):
  | { ok: true; start; sourceInFlicks; errorFlicks; alignFlicks; durationFrames; trimmedHeadSec }
  | { ok: false; code: 'E_INVALID_PARAM'; message };

// credits.ts
function soundCredits(doc, sequenceId?: string, opts?: {includeUnused?: boolean}): { rows: SoundCreditRow[]; text;
  markdown; csv; warnings: {code: 'W_LICENSE_NC'|'W_LICENSE_ND'|'W_LICENSE_UNKNOWN'|'W_USER_PROVIDED'
  |'W_CREDIT_INCOMPLETE'|'W_SEQUENCE_NOT_FOUND'; mediaId: string|null; message}[] };
interface SoundCreditRow { mediaId; soundId; title; author; license; licenseUrl: string|null; sourceUrl: string|null;
  attribution: string|null; requiresAttribution; usedIn: string[] /* clip ids */; sequenceIds: string[] }
function creditLine(row: SoundCreditRow): string;

// command
{ type: 'media.setLibraryInfo', mediaId, library: LibraryProvenance | null }  → { mediaId, library }   // History "Set Sound Library Info"
// media.register's asset also takes `library` (validated the same way); re-registering the same file fills a missing one.
```

#### Decisions

- **Profiles are duplicated, not imported.** The model may not import audio-fx (ARCHITECTURE §3.1: audio-fx depends on
  project). `packages/audio-fx/test/sound-taxonomy-profiles.test.ts` asserts the two copies are deep-equal (and the
  type ids identical, in order), so they cannot drift; tuning a profile means changing both.
- **Taxonomy fields** (no published reference; chosen from what each type is for): categories impact (hit, boom,
  thump, tap, pop), movement (whoosh, swish, transition), build (riser, reverse), interface (ui, click, key, tick,
  zap), texture (glitch, paper), tonal (chime, shimmer), bed. Families exactly as the panel chips (§2.7 plus Beds).
  Default weight: hit and boom are heroes, beds ambient, the rest support. `visualKinds` lists the cue kinds each type
  suits, best first (whoosh/swish: move first; hit: land; boom: reveal; riser: reveal; ui/pop/key: appear…).
  `durationFit` gives a comfortable length per type and what a cue window constrains: `lead` (riser, reverse, whoosh,
  swish: the run-up to the aligned point must fill the window), `span` (transition, glitch, paper, shimmer, beds) or
  nothing (one-shots).
- **Synonyms**: 205 words and phrases for folder/file indexing and search (`swoosh`, `sub drop`, `braam`, `door slam`,
  `page turn`, `room tone`…). Words too ambiguous in paths are left out (`build`, `app`, `select`, `error`, `drop`,
  `type`). Phrases claim their words before single words do. Inference reads the file name first, then the folders
  from the deepest, and stops at 4 types.
- **Ranking** (spec gives the factors, not the numbers): weighted mean of text (3), type fit (2), duration fit (1),
  judge score (1, 0.5 when unjudged), licence preference (0.75) and similarity (3), each only when it applies, minus
  the rotation penalty (0.3 for the nearest use, 0.3/(1+i) for later positions, summed, capped at 0.6). Text match per
  query word: the entry has the type the word (or its phrase) names = 1, its title/tags name it = 0.85, exact title
  word 1, title prefix (≥ 3 letters) 0.75, tag 0.8 / 0.6; the mean over words; stopwords (`sound`, `sfx`, `the`…)
  ignored; a query whose words match nothing drops the entry. Duration fit: with a window and a windowed type, a
  Gaussian of ln(lead or span ÷ window) (σ 0.4); else a Gaussian of ln(duration ÷ ideal) (σ 0.8), halved outside
  min…max. **Real recordings always sort before Jasper Synth** (spec §0: "always rank above"), then score, then id.
  The licence filter defaults to commercial-safe (the panel's default): CC0/PDDL/Unlicense, CC-BY and CC-BY-SA (no NC,
  ND), open-source licences, `LicenseRef-JasperEditor` and `LicenseRef-UserRoyaltyFree` (a user folder declared
  royalty-free). Preference: CC0 = Jasper 1 > CC-BY = permissive 0.8 > CC-BY-SA 0.7 > royalty-free 0.6 >
  user-provided 0.4 > NC/ND/unknown 0.
- **Refine pills**: short < 0.3 s ≤ medium ≤ 1.5 s < long (spec); dark centroid ≤ 1 kHz, bright ≥ 3 kHz; punchy rise
  ≤ 10 ms, soft ≥ 50 ms; light below-150 Hz share ≤ 0.05, heavy ≥ 0.3; clean flatness ≤ 0.1, noisy ≥ 0.25 (between
  the two limits a sound matches neither; an unknown descriptor fails a requested pill). Similarity: RMS over the
  features both sounds have of log10 duration, log2 centroid / 2, log10(rise + 1) (½ weight), 2 × each share and
  flatness, and the level-free octave-band shape per 12 dB; `exp(−distance)`.
- **Provenance storage.** `MediaAssetSchema.library` is `z.custom<LibraryProvenance>(() => true).optional()`: the
  document schema accepts any value, so a damaged value can never make `loadProject` throw (AGENTS.md §0); INV-LIBRARY
  checks it, and `repairDocument` repairs it field by field (`repair-library`) or drops it without a usable sound id
  (`drop-library`), keeping unknown newer fields. The TS type stays `LibraryProvenance` because every loaded or edited
  document passes the invariant (transactions that would break it fail with `E_INVARIANT`; the commands refuse first
  with `E_SCHEMA`). Pasted media from another project are read leniently (`readLibraryProvenance`). `source` is
  optional only so a repaired value can stay honest; registering always writes it. Type ids are stored as lower-case
  words (not an enum), so a newer build's type survives an older build's save. No schema bump (optional field, loose
  object; docs/project-files.md "Optional fields added since v6").
- **`media.setLibraryInfo`** refuses: missing media `E_NOT_FOUND`; media that is not audio or video, or descriptor
  points past the end of the sound (> durationSec + 1 ms) `E_INVALID_PARAM`; malformed provenance `E_SCHEMA`.
  `library: null` removes it. Re-registering the same file (`media.register` dedupe) adds the provenance when the
  existing media has none and never overwrites it.
- **Credits** walk the sequence and everything nested in it (`nestedClosure`, cycle-safe), or every sequence. Every
  clip with a media reference counts, enabled or not (a credit too many is harmless; a missing one is not). A processed
  version (`derivation`) credits its library original (bounded walk). Rows sort by title (case-insensitive, then code
  point, locale-free). `licenseUrl` falls back to the canonical CC deed. Text prefers the verbatim `attribution`;
  CSV is RFC 4180 with `'`-prefixed cells that could start a spreadsheet formula; Markdown escapes pipes and encodes
  the link URL.
- **Placement** implements §2.3 with the clip speed: `P = offset ÷ rate`, `k = floor(P / F)`, rest `r`; when
  `headQuietSec` ≥ `r·rate` (source time) the In point is `round(r·rate)` flicks and the aligned point lands on the cue
  to the flick (± 0.5/rate flick of rounding); otherwise In = 0 and it plays `r` late (< 1 frame; ITU-R BT.1359-1:
  late sound is far less noticeable). `start` aligns the onset (`onsetSec`, default 0), `end` the last sample. A start
  before frame 0 is refused (`E_INVALID_PARAM`) unless `clampStart`, which starts at 0 and trims the head so the
  aligned point stays exact (`trimmedHeadSec` reports the audible part cut). `subFrame: false` gives frame-accurate
  placement (P1-R7 wording); the web insert can use the sub-frame default since it is exact. Frame rates are the
  model's `Rational` (23.976 = 24000/1001; 29.97 DF is 30000/1001 — drop-frame is only a timecode display).
  `durationFrames` covers the rest of the sound (the last frame may overshoot by < 1 frame, inside INV-005's one-frame
  tolerance).

#### Verified (measured, this branch)

Shared host, 16 cores, load average 100–127 during the runs (other agents).

- `pnpm vitest run --project @jasper/project --maxWorkers=3`: 141 files, 1747 tests passed (the whole package, old
  and new). New files: `test/sound-taxonomy.test.ts` (9: the 19 + 2 types, aligns, families, field sanity, synonyms
  normalised and self-mapping, tokenizer, path inference cases, a 400-run fast-check property: never throws, ≤ 4
  valid unique types), `test/sound-rank.test.ts` (13: licence classes / commercial-safe / preference order, synonym
  text match and prefix scores, type filter and visual-kind fit, every Refine pill at its inclusive thresholds and
  unknown descriptors, default commercial-safe filter, synth always after real recordings even with a higher score,
  rotation penalties 0.3 / 0.15, window fit for risers and whoosh lead, similarity, id tie-break with 50 shuffles, a
  300-run property of hostile entries and requests: never throws, finite scores), `test/sound-place.test.ts` (7:
  known values at 30 fps, late-by-rest without quiet head, `subFrame:false`, end/onset alignment and rate, refusal
  and `clampStart`, 16 hostile inputs refused with `E_INVALID_PARAM`; property 3000 runs over the 8 sequence rates
  and random rationals 1–240 fps, rates 0.25–4, every alignment: In ≥ 0, 0 ≤ error < 1 frame, the aligned point lands
  at cue + error within 2 flicks, never trims beyond the quiet head, exact (≤ ⌈0.5/rate⌉ flick) when the head is quiet,
  `durationFrames` covers the rest with < 1 frame to spare, the only refusal is a start before 0; property 1000 runs
  at 23.976 / 29.97 / 59.94 with sample-position peaks: error 0 and `start·F + peak − In = cue·F` exactly),
  `test/sound-library.test.ts` (12: catalogue owner and label, set/remove with undo (the before-document untouched)
  and redo (same result), unknown fields and future type ids kept, refusals `E_NOT_FOUND` / `E_INVALID_PARAM` (still
  image, peak past the end) / `E_SCHEMA` (9 malformed values), `media.register` with provenance and dedupe fill,
  the document schema accepting anything, INV-LIBRARY + field-by-field repair (idempotent), drop without a sound id,
  save/load round trip without repairs, a damaged file loading repaired, a 300-run property of arbitrary values
  through `loadProject` (never throws, no issues left, valid values kept unchanged), paste of damaged provenance),
  `test/sound-credits.test.ts` (6: rows, sort, URLs, attribution flags, unused, warnings NC / user-provided / unknown /
  incomplete / missing sequence, nested sequences, a nesting cycle in a damaged file, processed versions credit
  their original, text / Markdown / CSV escaping and formula guard). `test/fuzz.test.ts` (AC-25 integrity property,
  2000 runs) now mixes `media.setLibraryInfo` (valid, null, impossible descriptors, malformed) into the random
  transactions.
- `pnpm vitest run packages/audio-fx/test/sound-taxonomy-profiles.test.ts`: 3 passed (type ids equal and in order,
  every profile deep-equal to `DEFAULT_TYPE_PROFILES` with the same keys, a project profile passed to `judgeSound`).
- `pnpm vitest run apps/mcp/test/sound-examples.test.ts`: 1 passed (the `describe_commands` example of
  `media.setLibraryInfo` resolves `{mediaByName}` and applies to a real project).
- `pnpm vitest run packages/audio-fx … --maxWorkers=3` (with the MCP, web i18n and session tests above): 262 passed,
  5 failed **by timeout only** (the 120 s `testTimeout`; they ran 141–196 s each at load 110–144): `registry.test.ts`
  "extreme settings…" and four `sound-synth.test.ts` "every variant of synth.<type> passes the judge" cases. This
  branch does not change `packages/audio-fx/src` (only adds the profile test); a rerun with a long timeout was killed
  by the 30-minute job limit at load ≈ 140, so they were **not re-measured here**. WP1.1b measured them green.
- `pnpm typecheck` (whole workspace) and `pnpm lint` (Biome, tokens, anime, layers, assets): pass.
  `node scripts/i18n.mjs --check`: es.json covers all strings (the new History label "Set Sound Library Info").

#### Limits and notes for the next packages

- Ranking weights and pill thresholds are reasoned defaults, checked only on synthetic entries; the starter-kit
  package should look at real search results and tune `RANK_WEIGHTS` / `DESCRIPTOR_FILTERS` if needed (tests pin the
  behaviour, not the exact weights, except where noted).
- `rankSounds` scores `judge` from the entry; the engine must store the judge result against the type the sound is
  indexed as (`SOUND_TYPE_PROFILES[type]`). Entries with several types are judged by whatever the engine chose.
- Credits count clips, not audibility: a muted track or a clip outside the In/Out still lists its sound. The export
  `credits` sidecar (§2.11) and `W_SOUND_CREDITS` are later packages; `requiresAttribution` is what they need.
- The engine's `SoundEntry` (packages/api) must conform to `RankableSound` structurally; `LibraryProvenance.descriptors`
  is the subset §2.1 lists (no riseMs etc.), so ranking project media (rather than library entries) has fewer
  features.
- `media.setLibraryInfo` does not check `descriptors.durationSec` against the media's probed duration (a processed or
  trimmed file may differ); placement should use the media's own duration where they disagree.

### WP1.1b descriptors, judge and Jasper Synth

Scope: `packages/audio-fx` only (pure; imports `@jasper/audio-dsp` and nothing else). Spec 12 §2.1, P1-R2, P1-R3.

Files: `src/analysis/sound-descriptors.ts` (`analyzeSound`), `src/analysis/sound-judge.ts` (`judgeSound`, the type
ids and `DEFAULT_TYPE_PROFILES`), `src/synth/kit.ts` (PRNG and DSP blocks), `src/synth/recipes.ts` (19 recipes),
`src/synth/render.ts` (`renderSynth`, catalogue); tests `test/sound-descriptors.test.ts`, `sound-judge.test.ts`,
`sound-synth.test.ts`, `sound-oracle.test.ts`. Everything is exported from `@jasper/audio-fx`.

#### API (for the engine library, the taxonomy and ranking)

```ts
const SOUND_DESCRIPTORS_VERSION = 1;          // bump = re-analyse indexed sounds
const MAX_ANALYSIS_SECONDS = 120, MAX_ONSET_SECONDS = 30, MAX_SPECTRAL_FRAMES = 1500, MAX_SOUND_CHANNELS = 32;
const MIN_SOUND_SAMPLE_RATE = 1000, MAX_SOUND_SAMPLE_RATE = 768_000, DESCRIPTOR_FLOOR_DB = -120;
const OCTAVE_BAND_CENTRES_HZ: readonly number[];   // [125, 250, 500, 1000, 2000, 4000, 8000]
function analyzeSound(channels: Float32Array[], sampleRate: number): SoundDescriptors;  // throws SoundAnalysisError
class SoundAnalysisError extends Error { readonly code: 'E_INVALID_PARAM' }
interface SoundDescriptors {
  durationSec: number; peakSec: number; onsetSec: number; riseMs: number; decayMs: number; decays: boolean;
  tailSec: number; centroidHz: number; rolloff85Hz: number; below150Share: number; above6kShare: number;
  flatness: number; octaveBandsDb: number[] /*7*/; pitchMidi: number | null; pitchConfidence: number;
  onsetCount: number; integratedLufs: number | null; maxMomentaryLufs: number | null; truePeakDb: number | null;
  stereoWidth: number; headQuietSec: number; loopable: boolean;
}

const SOUND_TYPE_IDS: readonly ['hit','boom','riser','reverse','transition','whoosh','swish','glitch','ui','click',
  'key','tick','tap','pop','thump','paper','chime','shimmer','zap','ambience','roomtone'];
type SoundTypeId = (typeof SOUND_TYPE_IDS)[number];
interface SoundTypeProfile { minDurSec: number; maxDurSec: number; maxRiseMs: number | null; mustDecay: boolean;
  maxBelow150Share: number; maxAbove6kShare: number; maxFlatness: number | null; singleHit: boolean;
  minMaxMomentaryLufs: number }
type JudgeReason = 'boomy'|'hissy'|'noisy'|'soft-attack'|'non-decaying'|'too-long'|'too-short'|'clipped'|'multi-hit'|'quiet';
const JUDGE_REASONS: readonly JudgeReason[];  const CLIPPED_TRUE_PEAK_DB = 0.3;
interface JudgeResult { ok: boolean; score: number; reasons: JudgeReason[] }
function judgeSound(d: SoundDescriptors, profile: SoundTypeProfile): JudgeResult;   // never throws
const DEFAULT_TYPE_PROFILES: Readonly<Record<SoundTypeId, SoundTypeProfile>>;

const SYNTH_SAMPLE_RATE = 48_000, SYNTH_VARIANTS = 8, SYNTH_VERSION = 1;
const SYNTH_RECIPES: readonly SynthRecipe[];   // {id: 'synth.<type>', type, title, render(rng, sr)}
function renderSynth(recipeId: string, seed: number): SynthSound;  // throws SynthError (E_INVALID_PARAM)
interface SynthSound { recipe: string; type: SoundTypeId; title: string; seed: number; sampleRate: number;
  channels: Float32Array[] /*stereo, peak −1 dBFS*/ }
function synthCatalogue(): { recipe: string; type: SoundTypeId; seed: number; title: string }[];  // 19 × 8
function synthRecipe(id: string): SynthRecipe | undefined;
class SplitMix32 { constructor(seed: number); nextU32(): number; unit(): number; bipolar(): number; … }
```

The library source of a synth sound is `{type: 'synth', recipe: 'synth.<type>', seed}`; render it with
`renderSynth(recipe, seed)` and encode with `@jasper/audio-dsp`'s `encodeWav`. The project taxonomy carries its own
`SoundTypeProfile` objects of the same shape and passes them to `judgeSound`.

#### Descriptor definitions (decisions)

| Field | Definition |
|---|---|
| envelope | mean power over channels in 2 ms windows (4 hops of `round(0.5 ms · sr)` samples), one per hop |
| `peakSec` | centre of the loudest window; when several windows tie (an impulse is in 4), the centre of the run |
| `onsetSec` | first point within 30 dB of the peak, interpolated in dB |
| `riseMs` | 10 → 90 % amplitude (−20 → −0.915 dB) of a reference level = the loudest 10 ms (20-point moving mean) of the envelope; t90 = first point reaching it, t10 = last point before it under −20 dB. The 10 ms reference keeps a fluctuating sustain (noise) from moving the 90 % point to its loudest 2 ms instant |
| `decayMs`, `decays` | peak → first point 20 dB under the peak; without one, `decays = false` and `decayMs` = peak → end |
| `tailSec` | peak → last point within 60 dB of the peak |
| active span | first … last envelope point within 60 dB of the peak; the spectrum, width and onsets use it |
| spectrum | Welch average of Hann frames (`2^k ≥ 40 ms`, 2048 at 48 kHz, 50 % overlap) over the active span; channels transformed in pairs with one complex FFT and summed; at most 1500 evenly spaced frames |
| `centroidHz`, `rolloff85Hz` | centroid and 85 % point of the average **power** spectrum (power, not magnitude: a step at the edge of a sound splatters low-level broadband magnitude that moved a sine's magnitude centroid 8 % off) |
| `below150Share`, `above6kShare` | power below 150 Hz / above 6 kHz ÷ all power |
| `flatness` | Wiener entropy (geometric ÷ arithmetic mean) of the average power spectrum over 50 Hz … min(16 kHz, 0.45·sr), bins floored 120 dB under the strongest. Long-term on purpose: P1-R2 wants white noise ≈ 1; a per-frame flatness of white noise is ≈ 0.56 (power) or ≈ 0.85 (magnitude) |
| `octaveBandsDb` | mean square in each octave (fc/√2 … fc·√2) over the active span, dBFS (a full-scale sine reads −3.01); each FFT bin counts with the share of its width inside the band (whole-bin edges gave white noise −0.28 dB steps); floor −120 |
| `pitchMidi`, `pitchConfidence` | YIN (de Cheveigné & Kawahara, JASA 111(4), 2002): mono mix box-decimated to ≤ 48 kHz, 50 Hz … 4.2 kHz, threshold 0.15, parabolic refinement, up to 16 frames over the first second of the active span (frames 40 dB under the peak skipped). Confidence = 1 − median aperiodicity; pitch = median f0 of voiced frames (aperiodicity < 0.2), null unless confidence ≥ 0.7 and at least half the frames are voiced. Confidence is always a number |
| `onsetCount` | SuperFlux-style (Böck & Widmer, DAFx 2013): third-octave band energies from 60 Hz (≥ 4 bins per band), 20 ms frames, 50 % hop; flux = Σ bands of the rise in dB over the max of the two previous frames, each band capped at 30 dB, floor 80 dB under the loudest band. A peak counts when it is a ±2-frame maximum, ≥ 12 dB and ≥ 25 % of the largest flux, the frame is within 40 dB of the loudest frame, the frame energy rises ≥ 3 dB over the two before it (an abrupt stop splatters into empty bands but loses energy; a sweep or tremolo moves energy between bands), and ≥ 50 ms after the previous onset. A swell with no attack has 0 |
| `integratedLufs`, `maxMomentaryLufs`, `truePeakDb` | `@jasper/audio-dsp` `LoudnessMeter` (BS.1770-4, 5.1 weights for 6 channels), the input padded with silence to whole 100 ms blocks and at least 400 ms, so the end of a sound and a sound shorter than 400 ms are measured; `null` for −∞ (silence, nothing through the gates) |
| `stereoWidth` | E(side) ÷ (E(mid) + E(side)) of channels 0 and 1 over the active span: 0 mono, 0.5 uncorrelated or one-sided, 1 anti-phase; 0 for mono |
| `headQuietSec` | first sample (any channel) ≥ 1 % (−40 dB) of the sample peak ÷ sr, **rounded down** to 0.1 ms, so placement (§2.3) never trims an audible sample |
| `loopable` | ≥ 1 s, no quiet head (< 5 ms), the first and last 100 ms within 3 dB of each other and neither more than 10 dB under the whole, and the wrap jump (last → first sample) ≤ 4 × the RMS sample step near both ends, per channel |

Quantisation: seconds 0.0001 (0.1 ms), ms 0.1, Hz 1, dB / LUFS / MIDI 0.01, shares, flatness, confidence and width
0.001; never −0.

Robustness: `channels` must be an array of `Float32Array` (≤ 32) and `sampleRate` a finite number in 1 kHz … 768 kHz,
else `SoundAnalysisError` (`E_INVALID_PARAM`). Samples are **sanitised**: NaN and ±Infinity count as 0 (copied only
when present); channels of different lengths are padded with silence; empty, silent, one-sample, mono, stereo, 5.1 and
huge finite values (±3.4e38) all give defined, finite, quantised results. Input longer than 120 s is analysed over its
first 120 s (`durationSec` is the real length); onsets over at most 30 s of the active span.

#### Judge

Reasons, each against a profile field: `too-short`/`too-long` (`durationSec`), `soft-attack` (`riseMs > maxRiseMs`),
`non-decaying` (`mustDecay && !decays`), `boomy` (`below150Share`), `hissy` (`above6kShare`), `noisy` (`flatness >
maxFlatness`), `multi-hit` (`singleHit && onsetCount > 1`), `quiet` (`maxMomentaryLufs` null or under the floor) and
`clipped` (`truePeakDb > +0.3 dBTP`: PCM samples never exceed 0 dBFS, so overs that large mean a waveform squared off
at full scale; a proxy, since descriptors carry no sample-run count). Values on a limit pass; non-finite limits are not
checked. `ok` = no reason; `score` = Π (1 − weight × severity) with severity = distance outside the limit ÷ a scale,
clamped to 0.25 … 1 (weights 0.4 … 0.6); reasons in the fixed `JUDGE_REASONS` order.

`DEFAULT_TYPE_PROFILES` (no published reference exists for these thresholds; they are chosen from what each type is,
and checked against the synth kit; the starter-kit package should check them on real recordings):

| Type | dur (s) | max rise (ms) | decays | max <150 | max >6k | max flat | single | min max-M (LUFS) | Why |
|---|---|---|---|---|---|---|---|---|---|
| hit | 0.05–6 | 25 | ✓ | 0.6 | 0.5 | — | ✓ | −40 | a strike: fast attack, one onset, body allowed but not sub-dominated |
| boom | 0.2–10 | 60 | ✓ | 1 | 0.25 | — | ✓ | −45 | low by definition (never "boomy"), long tail, no fizz |
| riser | 0.5–30 | — | — | 0.6 | 0.6 | — | — | −45 | swells: no attack or decay requirement |
| reverse | 0.3–12 | — | — | 0.6 | 0.6 | — | — | −45 | a reversed tail ends at its peak |
| transition | 0.2–12 | — | — | 0.7 | 0.6 | — | — | −45 | any sweep or composite |
| whoosh | 0.15–6 | — | — | 0.5 | 0.7 | — | — | −45 | filtered noise: noise allowed, sub not |
| swish | 0.05–3 | — | — | 0.3 | 0.85 | — | — | −45 | short and bright |
| glitch | 0.03–5 | — | — | 0.5 | 0.7 | — | — | −45 | stutters: several onsets expected |
| ui | 0.01–2 | 30 | ✓ | 0.3 | 0.6 | — | — | −50 | blips: crisp, short, may be two notes |
| click | 0.002–1 | 6 | ✓ | 0.3 | 0.85 | — | ✓ | −55 | a few ms transient; bright allowed; short sounds read low in 400 ms momentary |
| key | 0.005–1 | 10 | ✓ | 0.4 | 0.7 | — | ✓ | −55 | one key press (a press+release pair is two onsets) |
| tick | 0.002–1 | 6 | ✓ | 0.3 | 0.85 | — | ✓ | −55 | like click, often tonal |
| tap | 0.01–1.5 | 12 | ✓ | 0.5 | 0.6 | — | ✓ | −55 | finger/knuckle on a surface |
| pop | 0.01–1.5 | 15 | ✓ | 0.5 | 0.5 | — | ✓ | −50 | bubble/cork: tonal blip |
| thump | 0.05–3 | 25 | ✓ | 0.95 | 0.25 | — | ✓ | −45 | low and dull, but a pure sub (> 95 %) is a boom |
| paper | 0.05–6 | — | — | 0.3 | 0.85 | — | — | −50 | crackle trains: many onsets, noisy |
| chime | 0.2–10 | 40 | ✓ | 0.3 | 0.5 | 0.3 | — | −45 | tonal and ringing out: flatness limits noise |
| shimmer | 0.3–12 | — | — | 0.2 | 0.85 | 0.5 | — | −50 | high, tonal-ish texture |
| zap | 0.05–3 | 30 | — | 0.5 | 0.6 | — | — | −45 | electric sweep: attack yes, decay optional |
| ambience | 2–3600 | — | — | 0.8 | 0.6 | — | — | −60 | beds: long, low allowed, quiet allowed |
| roomtone | 2–3600 | — | — | 0.9 | 0.6 | — | — | −75 | very quiet by nature |

#### Jasper Synth

`SplitMix32` (Steele, Lea & Flood, OOPSLA 2014, 32-bit) seeded with FNV-1a(recipe id) ⊕ seed·0x9e3779b1; no
`Math.random`, no clock. Each recipe draws its parameters from the generator and renders stereo float64 work buffers
through `kit.ts` (white noise, phase-continuous sines, band-limited additive saw, RBJ biquads from
`@jasper/audio-dsp` with time-varying cutoff, envelopes, equal-power pan), then `finish`: 25 Hz high-pass, raised-cosine
fades, sample peak normalised to −1 dBFS, Float32. Recipes: hit (pitch-dropping body + ring + bandpassed noise
transient), boom (40–56 Hz drop + low rumble), riser (swept bandpass noise + rising tone, power-curve swell), reverse
(reversed noise/tone decay), transition (down-sweep + falling tone), whoosh / swish (bell-enveloped swept noise, panned
across), glitch (square, sample-and-hold and bit-crushed grains), ui (two blips), click, key (click + body + thock),
tick, tap (three modes), pop (upward glide), thump (sub drop + knock), paper (Poisson crackles over rustle), chime
(bell partials 1, 2, 2.76, 4.07, 5.4), shimmer (12–20 drifting, trembling high partials), zap (band-limited saw
sweep). Bit-exactness relies on V8's fdlibm `Math.sin/exp/pow/log`, identical on every platform for a given Node; the
pinned hashes tell when that (or a recipe) changes: then bump `SYNTH_VERSION` and repin.

#### Verified (measured, this branch, shared host, load 17–48 on 16 cores)

- `pnpm vitest run packages/audio-fx/test/sound-synth.test.ts packages/audio-fx/test/sound-judge.test.ts packages/audio-fx/test/sound-descriptors.test.ts --maxWorkers=3`:
  88 passed. Includes: impulses at 7 positions (48 kHz) and at 22.05/44.1/96 kHz → `peakSec` within 1 ms; exponential
  decays τ = 50/100/250 ms → `decayMs` = τ·ln 10 within 3 % (sine) / 20 % (noise) and the −60 dB tail; sines 110 Hz …
  2637 Hz → centroid within 2 %, MIDI within 0.05 (440 Hz → 69.00), confidence > 0.9; white noise → flatness > 0.95,
  centroid 12 kHz, above-6 kHz share 0.75, octave steps 3.01 ± 0.3 dB; pink noise (exact 1/f, 20 Hz–20 kHz) →
  below-150 share 0.292 and above-6 kHz share 0.174 within 0.015, octave bands equal within 0.5 dB; brown noise
  share; a 100 ms linear ramp → rise 80 ms ± 3; hit counting (1, 2, 4 hits; a swell ≤ 1; a tone that stops = 1);
  −20 dBFS stereo 1 kHz sine → −20.0 LUFS / dBTP; widths 0 / 0.5 / 1; loopable cases; 5.1; NaN/±Inf sanitised
  equals zeros; > 120 s input; invalid arguments refused; two fast-check properties (120 runs of structured random
  input over 0–6 channels, 0–12 000 samples, 6 rates, 4 amplitudes; 150 runs of arbitrary float32 arrays with NaN,
  ±Inf and extremes): never throws, every output finite and on its grid. Judge: every reason alone, limits inclusive,
  ordering and score monotonicity, odd profiles, the 21 profiles' sanity. Synth: 19 recipes = the 19 effect types,
  SplitMix32 reference sequence, pinned sha256 per recipe (8 seeds), refusals, and **all 152 variants accepted by the
  judge for their own type**.
- `JASPER_REQUIRE_ORACLES=1 pnpm vitest run packages/audio-fx/test/sound-oracle.test.ts`: 5 passed against
  `/usr/bin/ffmpeg` (ours / ffmpeg): white noise centroid 11965 / 11964.8 Hz, rolloff 20391 / 20364.2 Hz; 1 kHz sine
  1000 / 1000.5, 1008 / 1007.8; 500 Hz + 3 kHz 1750 / 1716.9, 3000 / 3000.0; flat band 1–4 kHz 2501 / 2491.5,
  3563 / 3547.9; `ebur128`: I −13.56 / −13.567 LUFS, max momentary −8.99 / −8.995 LUFS, TP −0.33 / −0.33 dBTP.
- Synth margins, all 8 seeds per type (measured by a scratch script rendering and analysing the catalogue; profile
  limit in brackets; every score 1):

| type | durationSec | riseMs max | below150 max | above6k max | flatness max | onsets | maxMomentary min | score min |
|---|---|---|---|---|---|---|---|---|
| hit | 0.7121–1.193 (0.05–6) | 0.8 (25) | 0.527 (0.6) | 0.029 (0.5) | 0.065 (—) | 1–1 (single) | -17.19 (-40) | 1 |
| boom | 1.9191–3.285 (0.2–10) | 5 (60) | 0.996 (1) | 0 (0.25) | 0 (—) | 1–1 (single) | -9.22 (-45) | 1 |
| riser | 1.5507–3.3863 (0.5–30) | 1360.9 (—) | 0 (0.6) | 0.071 (0.6) | 0.215 (—) | 0–0 | -9.16 (-45) | 1 |
| reverse | 1.277–2.4395 (0.3–12) | 1281.8 (—) | 0.007 (0.6) | 0.049 (0.6) | 0.135 (—) | 0–1 | -11.64 (-45) | 1 |
| transition | 0.9187–1.7061 (0.2–12) | 320.2 (—) | 0.119 (0.7) | 0.048 (0.6) | 0.155 (—) | 0–2 | -9.53 (-45) | 1 |
| whoosh | 0.5893–1.0339 (0.15–6) | 248.6 (—) | 0 (0.5) | 0.114 (0.7) | 0.301 (—) | 0–2 | -9.62 (-45) | 1 |
| swish | 0.1531–0.3646 (0.05–3) | 64.1 (—) | 0 (0.3) | 0.516 (0.85) | 0.426 (—) | 1–1 | -14.95 (-45) | 1 |
| glitch | 0.228–0.4869 (0.03–5) | 83.1 (—) | 0.055 (0.5) | 0.003 (0.7) | 0.003 (—) | 1–4 | -9.62 (-45) | 1 |
| ui | 0.2502–0.3494 (0.01–2) | 1.7 (30) | 0 (0.3) | 0 (0.6) | 0 (—) | 2–2 | -12.85 (-50) | 1 |
| click | 0.0522–0.073 (0.002–1) | 0 (6) | 0 (0.3) | 0.115 (0.85) | 0.081 (—) | 1–1 (single) | -25.44 (-55) | 1 |
| key | 0.0928–0.1402 (0.005–1) | 0 (10) | 0.026 (0.4) | 0.107 (0.7) | 0.177 (—) | 1–1 (single) | -24.68 (-55) | 1 |
| tick | 0.0375–0.0598 (0.002–1) | 0 (6) | 0 (0.3) | 0.028 (0.85) | 0.006 (—) | 1–1 (single) | -22.62 (-55) | 1 |
| tap | 0.1949–0.2871 (0.01–1.5) | 1.8 (12) | 0.011 (0.5) | 0 (0.6) | 0 (—) | 1–1 (single) | -21.56 (-55) | 1 |
| pop | 0.0837–0.1832 (0.01–1.5) | 1 (15) | 0.006 (0.5) | 0 (0.5) | 0 (—) | 1–1 (single) | -19.25 (-50) | 1 |
| thump | 0.4323–0.7377 (0.05–3) | 0.7 (25) | 0.853 (0.95) | 0 (0.25) | 0.001 (—) | 1–1 (single) | -15.98 (-45) | 1 |
| paper | 0.6525–1.2624 (0.05–6) | 125.2 (—) | 0 (0.3) | 0.145 (0.85) | 0.089 (—) | 6–11 | -16.95 (-50) | 1 |
| chime | 2.2456–3.7795 (0.2–10) | 1.6 (40) | 0 (0.3) | 0.004 (0.5) | 0 (0.3) | 1–1 | -10.06 (-45) | 1 |
| shimmer | 1.862–2.8312 (0.3–12) | 819 (—) | 0 (0.2) | 0.122 (0.85) | 0 (0.5) | 0–2 | -8.09 (-50) | 1 |
| zap | 0.2211–0.3985 (0.05–3) | 2.1 (30) | 0.02 (0.5) | 0.002 (0.6) | 0.002 (—) | 1–1 | -11.33 (-45) | 1 |

- Speed (measured, scratch script, load ≈ 47): `analyzeSound` on 60 s of stereo noise 1.5–5.2 s (load-dependent);
  render + analyse of one synth sound ≈ 100 ms at load 17.
- `JASPER_REQUIRE_ORACLES=1 pnpm vitest run packages/audio-fx --maxWorkers=2`: 16 files, 229 tests passed (the whole
  package, old and new). `pnpm typecheck` (whole workspace) and `pnpm lint` (Biome, tokens, anime, layers, assets) pass.
- Module-level tables (`SYNTH_RECIPES`, `DEFAULT_TYPE_PROFILES`, …) are `@__PURE__`-annotated so the preview worklet
  and web bundles, which import `@jasper/audio-fx` for the effect chain, can drop them.

#### Limits and notes for the next packages

- Noisy sounds: `peakSec`, `decayMs` and `tailSec` follow the spec's 2 ms window, so on noise the peak is the
  loudest 2 ms fluctuation (≈ +2 dB over the trend) and `decayMs` can be ≈ 15–20 % short. `riseMs` uses the 10 ms
  reference and is not affected.
- `onsetCount` is a heuristic: crackly or rattling tails count as several onsets (correct for paper and debris, a
  possible false `multi-hit` for a hit with a rattle). Swells and sweeps read 0–2.
- `clipped` is a true-peak proxy; flat-topped runs below +0.3 dBTP are not detected.
- `pitchMidi` looks only at the first second of the active span (sweeps report their start, if any).
- Analysis is capped at 120 s; a 2-minute stereo file takes a few seconds under load. The engine's `sound-index` job
  should run it off the request path.
- The judge profiles are reasoned defaults checked only against the synth kit; real recordings (the starter kit) may
  need tuning, which the taxonomy can do without touching this package.

### WP1.2 engine library

Scope: spec 12 §2.1 (library, sources, `SoundEntry`, register), §2.8 (sound routes, `sound-index` job, capabilities),
P1-R5 and the engine side of P1-R1. Files: `packages/config/src/index.ts` (appdir paths), `packages/api/src/sounds.ts`
(contracts), `routes.ts` / `jobs.ts` / `events.ts` / `m2-capabilities.ts` (declarations),
`packages/engine-client/src/client.ts` (calls), `apps/engine/src/sounds/{library,index-job,starter,synth,visual,decode,
roots,service,analysis,analysis-core,analysis-worker}.ts`, `apps/engine/src/routes/sounds.ts`, `apps/engine/scripts/build.mjs` and
`apps/desktop/scripts/package.mjs` (the starter kit ships next to the bundle), docs (ARCHITECTURE §4.3,
security-review AGT-3 table and §9). Tests: `apps/engine/test/sounds-unit.test.ts`, `sounds-routes.test.ts`
(fixtures: `sound-fixtures.ts`, generated WAVs, no network), `packages/config/test/config.test.ts`,
`packages/engine-client/test/client.test.ts`; the generic `fuzz-http.test.ts` picks the new routes up by itself.

#### API (for MCP and web agents)

Appdir (`appdirPaths`): `soundsDir`, `soundLibraryIndex` (`sounds/library.json`), `soundRootsFile`
(`sounds/roots.json`), `soundPacksDir` (`sounds/packs/<id>/pack.json`), `soundSynthDir` (`sounds/synth/`),
`soundCacheDir` (`sounds/cache/<fingerprintHex>/{analysis-v<n>,visual-v1}.json`), `projectProposalsDir(pid)`
(`projects/<pid>/proposals/`, for P3).

| Route (`ROUTES` name) | Engine-client call | Request | Response |
|---|---|---|---|
| `GET /api/sounds` (`soundsSearch`) | `searchSounds(req: SoundSearchRequest, signal?)` | query: `q`, `types` (csv ids or synonyms), `family`, `visualKind`, `windowSec`, `align`, `length`, `tone`, `attack`, `weight`, `texture`, `license` (`any` \| `commercial-safe`, default commercial-safe), `sources` (csv `starter,pack,folder,synth`), `rootId`, `similarTo` (sound id), `usedNearby` (csv ids, nearest first), `limit` (1…500, default 50), `offset` | `SoundSearchResponse {snapshotHash, librarySize, total, offset, results: [{sound: SoundEntry, score, parts: RankParts}], facets: {types, families, licenses, sources}: Record<string, count>, indexing}` |
| `GET /api/sounds/status` (`soundsStatus`) | `soundLibraryStatus()` | — | `SoundLibraryStatus {snapshotHash, sounds, bySource{starter,pack,folder,synth}, packs, roots, starter{status: ok\|absent\|invalid, sounds, errors[]}, indexedAt, needsIndex, recovered, indexing: EngineJob\|null, synth: true, local}` |
| `GET /api/sounds/:soundId` (`soundGet`) | `getSound(id)` | — | `SoundEntry` |
| `GET /api/sounds/:soundId/audio` (`soundAudio`, binary) | `soundAudioUrl(id)` | `Range` | the file: `audio/*` content type only, `nosniff`, `CSP: sandbox`, `Accept-Ranges`, 206 for ranges, ETag |
| `GET /api/sounds/:soundId/visual` (`soundVisual`) | `getSoundVisual(id)` | — | `SoundVisual {version, soundId, fingerprint, durationSec, coveredSec, peakSec, peaks{perSecond: 100, count, data: base64 u8}, spectrogram{bins: 64, frames, framesPerSecond, minHz: 20, maxHz, floorDb: −96, data: base64 u8 frame-major}}` |
| `POST /api/sounds/:soundId/register` (`soundRegister`) | `registerSound(id, projectId)` | `{projectId}` | `RegisteredMedia & {library: LibraryProvenance, existingMediaId: string \| null}` |
| `POST /api/sounds/index` (`soundIndex`, 202) | `indexSounds({full?})` | `{full?: boolean}` | `EngineJob` (kind `sound-index`, joins a queued/running one); result `SoundIndexResult {snapshotHash, sounds, files, analysed, reused, added, removed, errors[≤100]: {source, file, code, message}}` |
| `GET /api/sounds/roots` (`soundRootsGet`) | `getSoundRoots()` | — | `{roots: SoundRoot[], local}` |
| `PUT /api/sounds/roots` (`soundRootsPut`) | `putSoundRoots({roots})` | `{roots: [{id?, path, label?, license?, attributionTemplate?, author?, enabled?}] ≤ 32}` (the complete list; no `id` or an unknown one = new folder) | `{roots, local, job: EngineJob \| null, removedSounds}` |

```ts
SoundEntry = { id: 'snd_<16 hex of the content fingerprint>', fingerprint: 'q1:<sha256>', title, types: string[],
  tags: string[], source: {type:'starter', packId?, file} | {type:'pack', packId, file} | {type:'folder', rootId,
  relPath} | {type:'synth', recipe, seed}, license, licenseUrl?, author, sourceUrl?, attribution: string|null,
  format: {durationSec, sampleRate, channels, container}, descriptors: SoundDescriptors (all of audio-fx's),
  judge: {ok, score, reasons[], type} | null, indexedAt, analysisVersion }      // satisfies project RankableSound
SoundRoot = { id: 'root_<12 hex>', path, label, license: 'LicenseRef-UserProvided' | 'LicenseRef-UserRoyaltyFree' |
  'CC0-1.0' | 'CC-BY-3.0' | 'CC-BY-4.0' | 'CC-BY-SA-3.0' | 'CC-BY-SA-4.0', attributionTemplate?, author?, enabled, addedAt }
```

Also exported: `SOUND_ID_RE`, `SOUND_SOURCE_TYPES` (priority order), `SOUND_FILE_EXTENSIONS`, `SOUND_ANALYSIS_SECONDS`
(30), `soundSearchParams(req)`, `SOUND_EFFECTS_BIN` (`'Sound Effects'`), `SoundManifestSchema` (+ pack/sound),
`SoundCapabilitiesSchema`. Event `sounds.changed {snapshotHash, sounds}` (after every index write). Capabilities
`features.sound = {library: {sounds, packs}, synth: true}`. Job kind `sound-index`.

Registering, for clients: call `registerSound`, then commit `media.register` with the returned asset (minus
`mediaKey` / `browserPlayable` / `library` / `existingMediaId`, `derivation: null`) plus `library`, into the
`SOUND_EFFECTS_BIN` bin; when `existingMediaId` is set, reuse that media (the project's `media.register` dedupe also
fills a missing `library`).

**Starter kit manifest** (`apps/engine/sounds/starter/manifest.json`; the folder ships as `dist/sounds/starter` next
to `engine.mjs` and in the desktop app's `sounds/`; `JASPER_SOUND_STARTER_DIR` overrides it):

```json
{ "version": 1,
  "packs":  [{ "id": "kenney-impact", "title": "…", "url": "https://…zip", "sha256": "<64 hex of the archive>",
               "license": "CC0-1.0", "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/", "author": "Kenney" }],
  "sounds": [{ "file": "impact/hit_01.ogg", "title": "Heavy hit", "types": ["hit"], "tags": ["metal"],
               "author": "Kenney", "license": "CC0-1.0", "licenseUrl": "…", "sourceUrl": "https://kenney.nl/…",
               "packId": "kenney-impact", "attribution": "optional verbatim credit line" }] }
```

`file` is relative to the manifest (forward slashes, no `..`) and must have an audio extension; `types` may be empty
(then inferred from the file name with `inferTypesFromName`); `packId` must name a `packs` entry. Invalid entries are
skipped and reported (status `starter.errors`, job `errors` with code `MANIFEST_INVALID`); an absent manifest is an
empty kit (`status: 'absent'`), an unreadable one an empty kit with the reason (`'invalid'`). A changed manifest (its
sha256) makes `needsIndex` true. An installed pack is `<appdir>/sounds/packs/<id>/pack.json` in the same format with
exactly one `packs` entry whose id is the folder name (installer: P6). This package commits **no** audio files and
no manifest.

#### Decisions

- **Ids are content-addressed** (`snd_` + 16 hex of the media fingerprint, so a registered sound and its media share
  the fingerprint): the same bytes found in two sources are one sound, listed under the source of highest priority
  (starter > pack > folder > synth, then scan order). Editing a folder file makes a new sound.
- **Index** `library.json` = `{format: 'jasper-sound-library', version: 1, snapshotHash, indexedAt, starterHash, roots,
  packs (installed only), sounds{id→SoundEntry}, files{locationKey→{size, mtimeMs, fingerprint}}}`, written with the
  engine's `atomicWriteJson` (temp file, fsync, rename, fsync dir). `snapshotHash` = 16 hex of sha256 over each sound's
  id, fingerprint, licence, attribution, types, analysis version and title in id order (what provenance depends on;
  not `indexedAt`). Damaged (unparseable, wrong format/version, not objects): moved to `library.json.corrupt-<time>`,
  empty, `recovered: true`, `needsIndex: true`; invalid entries are dropped and also ask for a rebuild. A rebuild
  re-reads cached analyses, so recovery is cheap.
- **Every scan rebuilds the whole index** from the sources (starter, installed packs, enabled folders, synth); cost
  is kept low by the stat shortcut (same size and mtime → fingerprint reused without reading) and the per-fingerprint
  analysis cache. Nothing is committed until the scan completes; a cancelled scan leaves the old index, and the
  analyses it finished are reused next time (tested). If the folder list changes during a scan, or another index
  request joins the job, the scan repeats (≤ 3 scans per job); what is committed keeps only folders enabled, and
  declared the same way, at commit time, and a still-stale job queues a follow-up job (review fixes below). One index
  job at a time (`dedupeKey: 'sound-index'`; a joined `full` request makes the joined job scan once more, in full).
- **Analysis**: ffprobe for the format, then ffmpeg decodes the first `SOUND_ANALYSIS_SECONDS` = 30 s to f32 at the
  file's rate up to 48 kHz (higher rates resampled; descriptors are perceptual) with ≤ 6 channels (more folded to
  stereo): ≤ 35 MB per file. `analyzeSound` and the visual data run on a **worker thread** (`sounds/analysis.ts`,
  entry `analysis-worker.ts`, bundled by `scripts/build.mjs` to `dist/sound-worker.mjs` and shipped by the desktop
  packager; in a dev engine under tsx the worker registers tsx's hooks itself, since Node 20 does not pass the main
  thread's loader to workers). Measured on this host at load ≈ 160 with `tsx` (scratch script): 30 s of stereo noise
  took 13.4 s in `analyzeSound` and 4.4 s for the spectrogram, which would have held the engine's event loop. One
  worker per engine, started on first use (≤ 120 s start timeout), stopped after 30 s idle; the decoded buffers are
  copied (not transferred, so a request can move to a new worker); cancelling or timing out a running analysis
  terminates the worker and moves its other requests to a new one (review fixes below). Without
  a worker (vitest, `JASPER_SOUND_WORKER=off`, a missing file, a worker that does not start) it runs in-thread,
  between the job's per-file yields. For files longer than 30 s,
  `descriptors.durationSec` is the whole file's (from ffprobe); the other descriptors describe the first 30 s.
  `ANALYSIS_VERSION = SOUND_DESCRIPTORS_VERSION·1000 + 1` versions the cache.
- **Judge** with `SOUND_TYPE_PROFILES[first known type]` (project copy, test-pinned equal to audio-fx's);
  `judge: null` for untyped sounds (`rankSounds` then scores 0.5).
- **Metadata**: starter/pack from the manifest (licence URL falls back to the pack's when the licence is the same,
  then to the canonical CC deed); folder sounds: title from the file name (`_`/`-` → spaces), types
  `inferTypesFromName(relPath)` (synonyms), tags = words of the folders and name (no numbers, stopwords, one-letter
  words; ≤ 16), licence = the folder's declaration (default `LicenseRef-UserProvided`), author = the folder's `author`
  (an addition to the spec's `SoundRoot`), credit = the folder's `attributionTemplate` (`{title}`, `{file}`,
  `{folder}`, `{author}`, `{license}`) or, when the licence requires attribution, `"<title>" by <author> (<source>),
  licensed under <licence> (<licence URL>)`; CC0, Jasper and user-provided sounds get `null`. Synth: `Jasper Synth
  <type> <n>`, author `JasperEditor`, `LicenseRef-JasperEditor`, tags `jasper, synth, procedural`.
- **Jasper Synth** is indexed by the same job: each catalogue entry is rendered once to
  `sounds/synth/<recipe>-<seed>-v<SYNTH_VERSION>.wav` (16-bit stereo 48 kHz) and analysed through the same ffmpeg path.
  `JASPER_SOUND_SYNTH_VARIANTS` (0…8, default 8 = 152 sounds; 0 leaves synth out) bounds it; tests use 0 or 1. A
  render deleted from the cache is rendered again on demand (audio, visual, register) with the same bytes.
- **Search** = `rankSounds` over the library (real recordings always before synth, then score, then id), with
  `sources` and `rootId` as pre-filters, `family` as types (intersected with `types` when both are given; no overlap =
  no results), `similarTo` by id. **Facets are disjunctive**: types and families are counted without the request's
  type/family filter, licences (by `licenseClass`) without its licence filter, sources without its source filter, so
  a chip shows how many sounds selecting it gives. One ranking pass for the results plus one filter pass for all
  facets (`searchSoundEntries`, `sounds/search.ts`); < 50 ms for 5 000 sounds (review fixes below).
- **Visual data**: computed by the index job from the analysis decode and cached per fingerprint; computed again on
  request when the cache was cleaned (≤ 2 at once; refused with `SOUND_CHANGED` if the file's fingerprint changed).
  Peaks: max |sample| over channels per 10 ms, linear u8. Spectrogram: mono mix, Hann frames 2^k ≥ 40 ms (2048 at
  48 kHz), hop 10 ms (longer past 3000 frames), power summed over the FFT bins of 64 log bands 20 Hz…min(20 kHz, sr/2)
  (a band narrower than a bin takes the bin of its centre), dB re a full-scale sine, −96…0 dB → 0…255.
- **Files** are only ever found through the index: kit/pack files by manifest path, folder files by root id +
  relative path, then `realpath` must stay inside the kit/pack/folder and have an audio extension; served with an
  `audio/*` type only. Folder sounds (audio, visual, register) need local mode.
- **Register**: starter, pack and synth files are copied into managed media (`registerPath(…, {copyIntoProject:
  true})`: the project must not depend on the app's install folder); folder files are registered in place like a path
  import. The media registry dedupes by fingerprint; `existingMediaId` names the saved project's media with the same
  fingerprint (not derived). A file whose fingerprint no longer matches the index is refused (`409 SOUND_CHANGED`).
  The project must exist (`404 PROJECT_NOT_FOUND`).
- **Folders** (D-47): local mode only (`LOCAL_MODE_ONLY` otherwise, `local: false` in the responses); absolute, no
  NUL, resolved through links, an existing folder, not a file-system root, no duplicates, ≤ 32. Scans skip hidden
  names and symlinks (files and folders), stop at depth 12 and 20 000 audio files per folder, and the library at
  50 000 sounds (enforced while listing, with room kept for Jasper Synth). Removing or disabling a folder takes its
  sounds out of the index at once; adding, enabling, relicensing or changing its author or credit template (or its
  label, when the template uses `{folder}`) starts a rescan. A remote engine lists no folders, skips folder roots
  when indexing and keeps folder sounds out of search.
- **Agents** (security review AGT-3): `requireUserApproval` for adding, removing, relicensing **and re-crediting**
  a folder (a licence declaration decides commercial safety and the credit line is what projects print: both are the
  user's statements); renaming and enabling are open. The card starts with the counts of every kind ("This adds 1,
  removes 1, relicenses 0 and changes the credit line of 0 sound folder(s)"), then removals, licence and credit
  changes, then additions, each path or change cut to 120 characters; its label names every kind. A plan carries the
  folder list's revision: when the list changed while the card waited, the change is refused (`409
  SOUND_ROOTS_CHANGED`). The editor window is never asked.
- **Auto-indexing**: `GET /api/sounds` and `/status` (and engine start) start an index job when the library was never
  indexed, was recovered from damage, or the starter manifest changed; `JASPER_SOUND_AUTO_INDEX=0` turns it off
  (default off under vitest so the engine suites do not render synth sounds in the background). After the user
  cancels an automatic job it does not start again until the starter kit changes or an index is asked for; after a
  failure it waits 1 min, doubling per failure up to 1 h.

#### Verified (measured, this branch)

Shared host, 16 cores, load average 140–165 during every run below (other agents).

- `pnpm vitest run packages/config/test packages/api/test packages/engine-client/test apps/engine/test/sounds-unit.test.ts apps/engine/test/sounds-routes.test.ts apps/engine/test/security-hardening.test.ts --maxWorkers=2`:
  8 files, 110 tests passed. New:
  - `sounds-unit.test.ts` (19): manifest absent / unreadable / wrong version / empty; valid entries kept and
    non-audio, `..` and unknown-pack entries reported; installed-pack manifest rules; two fast-check properties
    (150 runs each) of hostile manifests (never throws, no escaping path survives); peaks known values (0.5 → 128,
    −1 → 255, NaN → 0); spectrogram of a full-scale 1 kHz sine: loudest band within ±1 of the band holding 1 kHz,
    within 3 dB of 0 dBFS, far bands near the floor; 3000-frame cap, silence, NaN, empty; base64 sizes; titles, tags
    and credit lines (CC0 none, CC-BY generated, folder template); index persistence (no temp file left, reload equal,
    `sounds.changed` payload), three kinds of damaged index moved aside and rebuilt, invalid entries dropped with the
    valid ones kept, removal by predicate; search-query and folder-body schemas under fast-check (500 / 300 runs) and
    their bounds; the worker thread: module resolution, **bundled with esbuild, results equal to in-thread
    analysis**, cancelling a 20 s analysis (`JOB_CANCELLED`) and the next one working, hostile input as a typed
    failure, fallback to in-thread when the worker cannot start.
  - `sounds-routes.test.ts` (14): starter kit indexed (4 sounds, 3 manifest errors reported), entry fields,
    peak of a hit after 20 ms of silence, quiet head, inferred types, CC-BY credit, `library.json` contents,
    capabilities `features.sound`; incremental rescans (second: 0 analysed / 4 reused; one changed file: 1 analysed,
    1 added, 1 removed; `full`: 4 analysed); a damaged index recovered by the automatic rebuild to the same
    `snapshotHash`; **cancellation** of a 16-file scan (job `cancelled`, no `library.json` written, the next scan
    reuses what was analysed); a folder indexed in place (hidden folders, other files and symlinks skipped; `Door
    Slam` → hit, `swoosh` → whoosh, found by the synonym query; tags; `LicenseRef-UserProvided` hidden by the default
    commercial-safe filter, royalty-free declaration re-indexes and shows them; disabling removes 3 sounds at once);
    path validation (relative, NUL, missing, a file, `/`, duplicates, NC licence); remote mode refused
    (`LOCAL_MODE_ONLY`); **agents** (token only): refused without an editor window, card with the path and licence,
    deny keeps nothing, approve adds; rename without a card; relicensing and removing asked; the editor never asked;
    search totals, disjunctive facets, type / family / query / synonym / length / source filters, paging,
    `similarTo` (the light hit nearest the heavy one), rotation penalty 0.3, six bad queries → 400, unknown
    `similarTo` → 404; audio headers (`audio/wav`, `nosniff`, `CSP: sandbox`, 206 with 12 bytes), unknown and
    traversal ids 404, a missing file `SOUND_FILE_MISSING`, a file swapped for a link to `/etc/hostname` 403; visual
    data from the cache and recomputed identically after the cache was deleted; register: provenance equal to the
    expected object (snapshot hash included), copy under `media/<key>/`, same media on repeat, `existingMediaId` once
    the saved project has the file, unknown sound / project / traversal id 404; folder sound registered in place
    (path locator, no copy), synth registered as a copy after its render was deleted (same fingerprint), a changed
    folder file `409 SOUND_CHANGED`; 24 sounds with `JASPER_SOUND_SYNTH_VARIANTS=1` (19 synth, **all 19 accepted by
    the judge for their own type** after 16-bit WAV and ffmpeg decoding) and synth last in a hit search; fast-check of
    hostile search queries (120), roots bodies (80) and root lists (40): never a 5xx.
- `pnpm vitest run apps/engine/test/fuzz-http.test.ts apps/engine/test/jobs.test.ts --maxWorkers=2`: 171 passed; the
  route fuzzing discovers the nine new routes by itself (`-t api/sounds --reporter=verbose`: 9 passed, never a 5xx
  `INTERNAL` or a hang).
- `pnpm lint` (Biome, tokens, anime, layers, assets): pass. `pnpm --filter @jasper/engine typecheck`,
  `@jasper/api`, `@jasper/engine-client`, `@jasper/config`, and `pnpm typecheck` (whole workspace): pass.
- Running engine (`tsx apps/engine/src/cli.ts --port 48701`, appdir `.stage`, generated kit, 1 synth seed), by HTTP
  with the token: the automatic index at start indexed 23 sounds (4 starter, 19 synth) in 45 s (first run, before the
  worker thread existed; load ≈ 150); `types=hit` returned the two starter hits before `Jasper Synth hit 1` although
  the synth scored higher (0.96 vs 0.90); facets as expected; capabilities `{library: {sounds: 23, packs: 0}, synth:
  true}`; `Range: bytes=0-99` → 206 with `audio/wav`, `nosniff` and the sandbox CSP; `register` of the CC-BY whoosh
  → managed copy and the generated credit line; `PUT /api/sounds/roots` with the token alone → `APPROVAL_DENIED`;
  with the dev editor cookie → added; a file that was a byte copy of a starter sound was listed once (under the
  starter kit); a distinct `Booms/sub drop 1.wav` → type `boom`, tags `booms, sub, drop`, found by `q=subdrop`.
  Visual data drawn to PNG (waveform over spectrogram, peak line) and looked at: the synth chime shows its partials as
  decaying horizontal lines with the peak at the start; the synth whoosh a bell-shaped broadband swell with the peak
  in the middle.
- Built engine (`pnpm --filter @jasper/engine build` with a generated kit temporarily in
  `apps/engine/sounds/starter`, removed afterwards): `dist/sounds/starter/manifest.json` and `dist/sound-worker.mjs`
  produced; `node dist/engine.mjs` with no override found the kit and indexed its 4 sounds (`starter.status: ok`);
  the bundled worker run on its own analysed a decaying 440 Hz sine (MIDI 69, 100 spectrogram frames).
- Dev worker under tsx (scratch script): `mode worker`; its first start took 22 s at load ≈ 160 (tsx transpiling the
  import graph in the worker), off the main thread.

#### Review fixes (P1 verification)

Fixes of the WP1.2 review findings, each with a regression test that fails on the code before it (checked by running
the new tests against the previous sources: all 19 tests of `sounds-review.test.ts` and all 5 of
`sound-rank-scale.test.ts` failed there; the analysis-worker tests needed the new `createWorker` seam, so before the
fix they could only fail by timing out). Files: `apps/engine/src/routes/sounds.ts`, `sounds/{roots,service,index-job,
analysis,search}.ts`, `packages/project/src/sound/{rank,taxonomy}.ts`, `apps/mcp/src/tools/sound.ts` (hints).
Tests: `apps/engine/test/sounds-review.test.ts`, `sounds-search.test.ts`, `packages/project/test/sound-rank-scale.test.ts`.

1. **Stale folder approvals.** `SoundRootStore.plan` returns the list's `revision`; `save(next, revision)` refuses
   with `409 SOUND_ROOTS_CHANGED` when another change landed while the card waited (the user's newer folder is kept,
   nothing is removed without a card about the current list). MCP hint added.
2. **Cards that hide a removal.** `rootsApprovalCard`: counts of every kind first, removals before additions, every
   path or change cut to 120 characters, the label names every kind (`Sound folders: remove, add`).
3. **Stale scans.** `SoundIndexer.run` re-scans when the folder list changed or a request joined (`requestPass`), at
   most `MAX_PASSES` = 3 scans (later passes reuse the previous pass's fingerprints and analyses), then commits only
   sounds and file records of folders enabled and declared identically *now* (`rootDeclaration`: path, licence,
   author, template, label) and, if the last scan was stale, queues a follow-up job after this one ends.
   `startIndex` joins an active job by asking it for another pass (full when asked): `POST /api/sounds/index {full:
   true}` during an incremental job ends with a full pass (tested: 14 analysed, 0 reused).
4. **Automatic indexing retries.** The service remembers its last automatic job: cancelled → no new automatic job
   until the starter manifest's hash changes or a user/agent asks for an index; failed or interrupted → backoff 1 min
   × 2^(failures−1), at most 1 h (a changed kit resets it).
5. **Analysis worker lifecycle.** Requests are kept per worker (`Slot`); events of a worker that is no longer
   current are ignored; stopping one request (cancel, timeout) ends its worker and re-posts that worker's other
   requests to a new one (at most 3 posts each); visual analyses time out after `VISUAL_TIMEOUT_MS` = 120 s
   (`503 ANALYSIS_TIMEOUT`). Samples are copied to the worker instead of transferred (≤ 35 MB more, transiently).
   Seam: `new SoundAnalyzer(url, log, {createWorker})`.
6. **Cache growth.** After every committed index, `pruneSoundCache` deletes `cache/<fp>/` folders of fingerprints
   the index has neither as a sound nor as a file record, analysis/visual files of older versions in kept folders,
   and `synth/*-<seed>-v<n>.wav` renders the index does not list (older `SYNTH_VERSION`s included). Other files are
   left alone. (Cached analyses of a cancelled scan's files survive when the next successful scan still lists them.)
7. **Library cap.** A running count replaces `Object.keys(sounds).length` per file; the cap applies while listing
   (`walkRoot({maxFiles})` stops a folder at the room left, `LIBRARY_FULL` reported) and room is reserved for every
   synth item. Test seam: `IndexDeps.maxSounds`.
8. **Credit changes.** A changed `author` or `attributionTemplate` (or `label` when the template uses `{folder}`) is
   `recredited` in the plan: it starts a rescan, and an agent doing it is asked (card "Change a sound folder’s credit
   line", naming the folder and the old → new value).
9. **Remote mode.** `GET /api/sounds/roots` lists no folders on a non-local engine; scans skip folder roots there
   (`LOCAL_MODE_ONLY` per root in the job errors) and search leaves folder sounds out even when an index from a
   local run still has them; `visual()` checks local mode before reading the cache; `fileOf` requires a regular
   file (a FIFO named `x.wav` is `403 NOT_A_SOUND`, never opened); a missing ffmpeg/ffprobe is `503 BINARY_MISSING`
   for visual data.
10. **Search speed.** `rankSounds` caches per entry object (WeakMap; recomputed when title, tags or types change) the
    title/tag tokens, the known types and the types they name, and the text score of the last query plan; plans are
    memoised per query string (32) and remember how each vocabulary word (ids ≤ 200 000) matches the query (2 bits per
    token, an `Int32Array` by word id), so most words cost one array read; `typesInTokens` only tries synonym phrases whose first word occurs (index by first
    word, same greedy order); query words are deduplicated (first occurrence) and capped at `MAX_QUERY_TOKENS` = 16
    (a behaviour change for repeated or very long queries only); licence classes are memoised. The engine caches the
    id-sorted entry list per snapshot and makes one pass (`rankSoundsPage`): every entry's filter bits
    (`soundFilterOf`'s, one per filter dimension) count the facets, matching entries are ordered by one packed float
    (source tier, title-word count, 6-decimal score, then the index, which is the id order of the engine's list; 2^50
    at most, so exact; a native typed-array sort), with the comparator as the fallback for lists not in id order, and
    only the returned page is built as objects. Facets equal the four-pass disjunctive counts (oracle test over 4 random libraries × 120 random queries
    with random offsets); `rankSoundsPage` equals `rankSounds` page by page (fast-check, 400 runs).
    Results for queries without repeated words are identical to the previous `rankSounds` (scratch comparison, 1 500
    fast-check cases against a copy of the old module; the existing `sound-rank.test.ts` passes unchanged).
11. **Prototype keys.** `synonymType` reads `TYPE_SYNONYMS` with `Object.hasOwn`; `resolveTypeNames(['constructor'])`
    returned `[Function Object]` before (measured in the scratch comparison: a `types: ['constructor']` filter matched
    every sound), now `[]`. `durationFit` guards its type with `isSoundTypeId`.

**Benchmark assertion**: min of 7 runs after a warm-up (up to 3 batches when a load spike hits) < 50 ms; when the
host's 1-minute load is above 2 per core, the budget grows to 50 ms × load / (2 × cores) (wall time then measures the
wait for a core: at load 135–144 on this host the same code measured 20–59 ms minimum). Decision recorded here
because the gate runs on a shared machine.

**Measured search speed** (16-core shared host; `pnpm vitest run apps/engine/test/sounds-search.test.ts
--reporter=verbose`, load average ≈ 28–43 during the runs; a synthetic library of 5 000 entries with realistic titles,
tags, 1–3 types, descriptors, four sources and six licences; min / median of 7 runs after one warm-up, each run a new
query string): `heavy punch` 11.1 / 14.6 ms, `door slam` 7.4 / 10.1 ms, empty query 14.6 / 15.0 ms, no query 13.4 /
14.3 ms, `heavy punch` + `types=hit` + `length=short` + `license=any` 5.8 / 6.9 ms, `whoosh` + `family=movement` +
`tone=dark` 4.2 / 5.3 ms. Before, on the same library and host (scratch script with the previous `rank.ts` and the
previous four-pass search, load ≈ 28): `heavy punch` 558 / 578 ms, `door slam` 416 / 461 ms, no query 38 / 48 ms;
`rankSounds` alone 84 / 109 ms for `heavy punch` (now `sound-rank-scale.test.ts`: 25 / 39 ms for 5 000 sounds, load ≈ 43).

#### Limits and notes for the next packages

- Where no worker thread can start (vitest; a packaged build missing `sound-worker.mjs`), analysis falls back to the
  main thread: a 30 s file then holds the event loop for seconds under heavy load (measured above). The engine test
  suites run in-thread; the worker itself is tested by bundling it with esbuild (`sounds-unit.test.ts`).
- Descriptors and visual data cover the first 30 s of longer files (beds); `durationSec` is the whole file.
- A folder on an unplugged disk drops out of the index at the next scan (`ROOT_OFFLINE` in the job errors) and comes
  back, without re-analysis, when it is there again.
- Symlinked files in folders are skipped (simplest safe rule); users who keep libraries behind links should add the
  real folder.
- Pack installation (`sound-pack-install`, catalogue, removal) is P6; the index already reads installed packs.
- Starter kit content and its sidecars come from the starter-kit package; with no manifest the library holds only
  synth sounds (and folders).
- MCP tools (`sound_library_status`, `search_sounds`, `get_sound`, `view_sounds`, `import_sounds`,
  `add_sound_folder`, `remove_sound_folder`, `rescan_sound_library`) are the MCP package's; the calls above are what
  they wrap. `view_sounds` can draw from `getSoundVisual` (peaks over spectrogram, `peakSec` line).

### WP1.2b starter kit

Scope: spec 12 §0 decision 1 (bundle a Kenney CC0 kit, ≈ 40–60 sounds, ≤ 8 MB, sidecars and `ATTRIBUTION.md` rows),
§2.1 (starter kit = source 1), P1-R4. Files: `apps/engine/sounds/starter/` (60 `.ogg`, 60 `.ogg.attribution`,
`manifest.json`), `scripts/sounds/curate-starter.ts` (fetch / scan / build), `scripts/sounds/lib.ts` (decode and measure
like the index job), `scripts/sounds/starter-selection.json` (the selection: source files, types, titles, tags,
derivations), `scripts/sounds/make-sidecars.mjs` (sidecars + the generated `ATTRIBUTION.md` section), tests
`apps/engine/test/sounds-starter-kit.test.ts` and `scripts/sounds/make-sidecars.test.mjs`. One fix outside the kit:
`packages/project/src/sound/provenance.ts` (see "Fix" below) with a regression test in
`packages/project/test/sound-library.test.ts`.

#### How to use and rebuild

```bash
pnpm exec tsx scripts/sounds/curate-starter.ts fetch /tmp/kenney   # downloads the 7 archives, checks the pinned sha256 (network)
pnpm exec tsx scripts/sounds/curate-starter.ts scan  /tmp/kenney   # every pack sound: descriptors, judge per type (the evidence)
pnpm exec tsx scripts/sounds/curate-starter.ts build /tmp/kenney   # converts the selection into apps/engine/sounds/starter, writes manifest.json
node scripts/sounds/make-sidecars.mjs                              # sidecars + ATTRIBUTION.md section (--check: verify only)
```

`build` refuses a GPL FFmpeg or one without libvorbis (it uses `JASPER_FFMPEG`, else the checkout's
`vendor/ffmpeg-lgpl/<platform>/ffmpeg`, searched upwards so worktrees find the main checkout's), a selection entry whose
judge rejects its first type, a kit over 8 MB, two outputs with the same audio, a file name that is not
`<type>-<desc>-NN.ogg` or does not start with its first type, and a filter without a derivation note. It deletes kit audio
and sidecars that are no longer selected. To change the kit, edit `starter-selection.json` and rerun `build` +
`make-sidecars`; the engine test then checks the result. The output is **byte-reproducible**: rebuilding into another
folder gave identical sha256 for all 60 files (measured, `diff` of `sha256sum` lists), thanks to `-fflags +bitexact
-flags:a +bitexact` (fixed Ogg serials, no encoder tag) and `-map_metadata -1`.

#### Packs and licence evidence

Downloaded 2026-10-15 from kenney.nl (the "Audio" category lists these seven sound-effect packs plus "Music Jingles"
and two voice-over packs, which are not sound effects and were left out). Every pack page has, in its details table,
"License: [Creative Commons CC0](https://creativecommons.org/publicdomain/zero/1.0/)" (checked with `curl` on each page),
and every archive holds `License.txt` stating "License: (Creative Commons Zero, CC0) http://creativecommons.org/publicdomain/zero/1.0/"
("Created/distributed by Kenney (www.kenney.nl)"; credit "would be nice but is not mandatory"). `build` re-checks the
sha256 and that `License.txt` says CC0 before using an archive. CC0 needs no licence file shipped, so the sidecars say
`license-file: none`.

| Pack id | Page | Archive | sha256 (archive) | Bytes |
|---|---|---|---|---|
| `kenney-casino-audio` | https://kenney.nl/assets/casino-audio | https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip | `f36250766ac5bc378c13708ddf12a23a8e54a3251f8d482c7536e51b5dbafa18` | 876 839 |
| `kenney-digital-audio` | https://kenney.nl/assets/digital-audio | https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip | `24e6ce28b76a6d8c89cff4d331e0965ff5c3de8a73c612028e9d363cc64e4f06` | 990 367 |
| `kenney-impact-sounds` | https://kenney.nl/assets/impact-sounds | https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip | `029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8` | 800 850 |
| `kenney-interface-sounds` | https://kenney.nl/assets/interface-sounds | https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip | `f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232` | 834 536 |
| `kenney-rpg-audio` | https://kenney.nl/assets/rpg-audio | https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip | `6dbeaf8544da958d8f2adcb4a4a4b76c1ade34a05f8ab9edccd327da7375f38b` | 964 837 |
| `kenney-sci-fi-sounds` | https://kenney.nl/assets/sci-fi-sounds | https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip | `119340f351a5098ad814f78719438c0da355a9ce8a4c8a3af6a8d48aa3d49e04` | 5 875 104 |
| `kenney-ui-audio` | https://kenney.nl/assets/ui-audio | https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip | `946fc23a63d535d693eb31b2eabb80c8c28d6351e2186b344ceb71b2cb1d5eb6` | 411 949 |

The manifest's `packs[]` carry `url` (archive), `sha256`, `license: CC0-1.0`, `licenseUrl` (the CC0 deed) and `author:
"Kenney (www.kenney.nl)"`; each sound's `sourceUrl` is its pack page. The archives are never committed.

#### Selection method (measured)

1. `scan` decoded every sound of the seven packs (521 files in their `Audio/` folders, 44.1 kHz except RPG Audio at 48 kHz) at 48 kHz with the
   LGPL FFmpeg and ran `analyzeSound` + `judgeSound` with `SOUND_TYPE_PROFILES` for all 19 effect types.
2. Candidates per type were picked from the names (Kenney's file names) and the measurements, preferring judge-ok,
   unclipped (true peak ≤ +0.3 dBTP), varied sounds and avoiding Kenney's duplicates (`footstep_carpet_001` and `_002`
   are the same file; `maximize_00n` are `minimize_00n` reversed, `open_00n` are `close_00n` reversed). A first build of
   91 candidates was judged (`build --out /tmp/…`); 10 were rejected (leather drop: soft attack 32 ms; a 0.8 s pitched
   whoosh and a thruster pass: hissy / boomy; a blade swish and the first whoosh-into-hit: clipped; Kenney's 20–27 ms
   "glitch" blips: too short; a card shuffle and a card slide: boomy at 0.302 / 0.305; the "back" blip: boomy 0.312);
   then the kit was thinned to 60 for variety (no two near-identical variants).
3. Kenney has no riser, no real air whoosh and no keyboard key. Risers, reverses, whooshes, a transition, a stutter and
   a shimmer were **derived from Kenney CC0 recordings** with LGPL FFmpeg filters only (reverse, varispeed pitch,
   concatenation, layering, fades, gain); nothing was synthesised. Each sidecar names the source files and the filter in
   words; the exact filter graph is in `starter-selection.json`.
4. Every output is measured again after encoding (the same path the index job uses) and must pass the judge for its first
   type; the engine test repeats that check on the committed files.

Format: OGG Vorbis, 48 kHz, libvorbis q5, channels as the source (mono or stereo; derived sounds stereo). Size:
**753 337 bytes of audio (0.72 MB, 9 % of the 8 MB budget)**; the folder with sidecars and manifest is 1.1 MB (`du -sh`).

Coverage: **18 of the 19 effect types** — hit 7, boom 3, riser 3 (derived), reverse 3, transition 3, whoosh 4 (derived),
swish 3, glitch 3, ui 7 (5 + 2 secondary), click 4, tick 2, tap 3, pop 3, thump 3, paper 3, chime 3, shimmer 2, zap 3.
**Uncovered: `key`** (no keyboard recording in any Kenney audio pack; the UI Audio "switch" clicks were not relabelled
as keys); Jasper Synth's `key` recipe covers it (measured: `GET /api/sounds?types=key` returns only `Jasper Synth key
press 1`).

The kit (values measured by `build`, the same descriptors the engine indexes; judge = ok and score for the first type):

| File | Types | Source (pack: file) | Derived | Dur (s) | Peak (s) | Max M (LUFS) | TP (dBTP) | Judge |
|---|---|---|---|---|---|---|---|---|
| `hit-metal-light-01.ogg` | hit | impact-sounds: impactMetal_light_003.ogg |  | 0.5027 | 0.001 | -14.38 | -1.49 | ok 1 (hit) |
| `hit-metal-01.ogg` | hit | impact-sounds: impactMetal_medium_000.ogg |  | 0.2691 | 0.001 | -20.1 | -1.12 | ok 1 (hit) |
| `hit-metal-heavy-01.ogg` | hit | sci-fi-sounds: impactMetal_003.ogg |  | 0.7741 | 0.0015 | -19.94 | -0.65 | ok 1 (hit) |
| `hit-punch-01.ogg` | hit | impact-sounds: impactPunch_medium_002.ogg |  | 0.5387 | 0.0405 | -16.07 | -0.66 | ok 1 (hit) |
| `hit-plate-01.ogg` | hit | impact-sounds: impactPlate_light_001.ogg |  | 0.676 | 0.001 | -22.21 | -1.23 | ok 1 (hit) |
| `hit-glass-01.ogg` | hit | impact-sounds: impactGlass_light_001.ogg |  | 0.2069 | 0.001 | -19.85 | -1.24 | ok 1 (hit) |
| `hit-crunch-01.ogg` | hit | sci-fi-sounds: explosionCrunch_002.ogg |  | 1.2558 | 0.2325 | -13.94 | -1.14 | ok 1 (hit) |
| `boom-explosion-01.ogg` | boom | sci-fi-sounds: explosionCrunch_001.ogg |  | 1.3568 | 0.0065 | -13.19 | -0.45 | ok 1 (boom) |
| `boom-low-01.ogg` | boom | sci-fi-sounds: lowFrequency_explosion_001.ogg |  | 0.9974 | 0.0825 | -11.27 | -0.94 | ok 1 (boom) |
| `boom-low-02.ogg` | boom | sci-fi-sounds: lowFrequency_explosion_001.ogg | yes | 1.2501 | 0.1035 | -10.94 | -0.8 | ok 1 (boom) |
| `thump-punch-01.ogg` | thump | impact-sounds: impactPunch_heavy_000.ogg |  | 0.6464 | 0.0245 | -15.34 | -0.87 | ok 1 (thump) |
| `thump-wood-01.ogg` | thump | impact-sounds: impactWood_heavy_003.ogg |  | 0.3104 | 0.0025 | -20.7 | -0.91 | ok 1 (thump) |
| `thump-plate-01.ogg` | thump | impact-sounds: impactPlate_heavy_001.ogg |  | 0.3497 | 0.0035 | -19.99 | -1.1 | ok 1 (thump) |
| `riser-engine-01.ogg` | riser | sci-fi-sounds: thrusterFire_000.ogg | yes | 3 | 2.9455 | -24.96 | -11.48 | ok 1 (riser) |
| `riser-hum-01.ogg` | riser | sci-fi-sounds: computerNoise_000.ogg | yes | 3 | 2.9665 | -12.28 | -7.29 | ok 1 (riser) |
| `riser-engine-03.ogg` | riser | sci-fi-sounds: spaceEngineSmall_004.ogg | yes | 3 | 2.9095 | -19.05 | -9.08 | ok 1 (riser) |
| `reverse-bell-01.ogg` | reverse | impact-sounds: impactBell_heavy_001.ogg | yes | 1.7409 | 1.7065 | -18 | -8.02 | ok 1 (reverse) |
| `reverse-crunch-01.ogg` | reverse | sci-fi-sounds: explosionCrunch_002.ogg | yes | 1.2558 | 0.9835 | -14.33 | -4.72 | ok 1 (reverse) |
| `reverse-air-01.ogg` | reverse | interface-sounds: maximize_005.ogg |  | 0.5237 | 0.478 | -12.27 | -0.07 | ok 1 (reverse) |
| `transition-crunch-01.ogg` | transition | sci-fi-sounds: explosionCrunch_002.ogg | yes | 2.5115 | 1.528 | -13.71 | -4.17 | ok 1 (transition) |
| `transition-sweep-01.ogg` | transition | sci-fi-sounds: forceField_002.ogg |  | 0.9524 | 0.145 | -8.62 | -0.85 | ok 1 (transition) |
| `transition-whoosh-hit-01.ogg` | transition | interface-sounds: open_002.ogg + close_002.ogg + bong_001.ogg | yes | 0.6249 | 0.3115 | -15.69 | -1.52 | ok 1 (transition) |
| `whoosh-air-01.ogg` | whoosh | interface-sounds: open_002.ogg + close_002.ogg | yes | 0.6249 | 0.3135 | -12 | -4.26 | ok 1 (whoosh) |
| `whoosh-air-02.ogg` | whoosh | interface-sounds: open_003.ogg + close_003.ogg | yes | 0.8939 | 0.449 | -10.14 | -1.98 | ok 1 (whoosh) |
| `whoosh-air-03.ogg` | whoosh | interface-sounds: maximize_005.ogg + minimize_005.ogg | yes | 1.0528 | 0.478 | -9.6 | -3.1 | ok 1 (whoosh) |
| `whoosh-hiss-01.ogg` | whoosh | sci-fi-sounds: doorClose_000.ogg + doorOpen_000.ogg | yes | 1.7721 | 0.8835 | -10.46 | -3.13 | ok 1 (whoosh) |
| `swish-blade-01.ogg` | swish | rpg-audio: knifeSlice.ogg |  | 0.5969 | 0.252 | -13.43 | -1.15 | ok 1 (swish) |
| `swish-card-01.ogg` | swish | casino-audio: card-shove-1.ogg |  | 0.7632 | 0.121 | -22.7 | -2.4 | ok 1 (swish) |
| `swish-air-01.ogg` | swish | interface-sounds: close_004.ogg |  | 0.3202 | 0.0015 | -15.53 | -0.38 | ok 1 (swish) |
| `glitch-digital-01.ogg` | glitch | digital-audio: spaceTrash1.ogg |  | 1.4513 | 0.0935 | -16.81 | -0.69 | ok 1 (glitch) |
| `glitch-stutter-01.ogg` | glitch | interface-sounds: glitch_004.ogg + glitch_003.ogg | yes | 0.1467 | 0.136 | -16.87 | -0.71 | ok 1 (glitch) |
| `glitch-error-01.ogg` | glitch, ui | interface-sounds: error_003.ogg |  | 0.5308 | 0.0155 | -14.42 | -0.1 | ok 1 (glitch) |
| `ui-confirm-01.ogg` | ui | interface-sounds: confirmation_001.ogg |  | 0.2872 | 0.0025 | -13.27 | -0.98 | ok 1 (ui) |
| `ui-confirm-02.ogg` | ui | interface-sounds: confirmation_002.ogg |  | 0.5587 | 0.0015 | -12.05 | -0.95 | ok 1 (ui) |
| `ui-toggle-01.ogg` | ui | interface-sounds: toggle_001.ogg |  | 0.1367 | 0.0015 | -16.84 | -0.79 | ok 1 (ui) |
| `ui-back-01.ogg` | ui | interface-sounds: back_004.ogg |  | 0.0946 | 0.001 | -24.7 | -0.76 | ok 1 (ui) |
| `ui-power-up-01.ogg` | ui | digital-audio: powerUp8.ogg |  | 0.5967 | 0.1525 | -12.1 | -0.65 | ok 1 (ui) |
| `click-ui-01.ogg` | click | ui-audio: click3.ogg |  | 0.0835 | 0.028 | -29.54 | -1.28 | ok 1 (click) |
| `click-ui-02.ogg` | click | ui-audio: click4.ogg |  | 0.038 | 0.009 | -23.42 | -0.44 | ok 1 (click) |
| `click-ui-03.ogg` | click | ui-audio: click5.ogg |  | 0.0351 | 0.011 | -24.63 | -2.14 | ok 1 (click) |
| `click-switch-01.ogg` | click | ui-audio: switch7.ogg |  | 0.2136 | 0.036 | -24.45 | -1.51 | ok 1 (click) |
| `tick-01.ogg` | tick | ui-audio: switch13.ogg |  | 0.025 | 0.006 | -24.86 | -1.11 | ok 1 (tick) |
| `tick-02.ogg` | tick | ui-audio: switch14.ogg |  | 0.0351 | 0.008 | -24.49 | -0.69 | ok 1 (tick) |
| `tap-wood-01.ogg` | tap | impact-sounds: impactWood_light_000.ogg |  | 0.2629 | 0.001 | -21.98 | -1.25 | ok 1 (tap) |
| `tap-card-01.ogg` | tap | casino-audio: card-place-1.ogg |  | 0.6865 | 0.176 | -22.14 | -1.42 | ok 1 (tap) |
| `tap-chip-01.ogg` | tap | casino-audio: chip-lay-1.ogg |  | 0.1698 | 0.0495 | -22.79 | -1.74 | ok 1 (tap) |
| `pop-drop-01.ogg` | pop | interface-sounds: drop_002.ogg |  | 0.1884 | 0.001 | -20.67 | -1.03 | ok 1 (pop) |
| `pop-drop-02.ogg` | pop | interface-sounds: drop_004.ogg |  | 0.284 | 0.001 | -19.71 | -0.67 | ok 1 (pop) |
| `pop-bong-01.ogg` | pop | interface-sounds: bong_001.ogg |  | 0.1202 | 0.0015 | -22.59 | -0.88 | ok 1 (pop) |
| `paper-page-01.ogg` | paper | rpg-audio: bookFlip2.ogg |  | 0.4493 | 0.0385 | -30.64 | -8.53 | ok 1 (paper) |
| `paper-pack-01.ogg` | paper | casino-audio: cards-pack-open-2.ogg |  | 0.7294 | 0.2205 | -20.52 | -2.25 | ok 1 (paper) |
| `paper-card-01.ogg` | paper | casino-audio: card-place-2.ogg |  | 0.4567 | 0.198 | -26.6 | -2.03 | ok 1 (paper) |
| `chime-bell-01.ogg` | chime | impact-sounds: impactBell_heavy_000.ogg |  | 1.4802 | 0.001 | -18.74 | -1.28 | ok 1 (chime) |
| `chime-glass-01.ogg` | chime | interface-sounds: glass_001.ogg |  | 0.2758 | 0.001 | -19.42 | -1.08 | ok 1 (chime) |
| `chime-three-tone-01.ogg` | chime, ui | digital-audio: threeTone1.ogg |  | 0.8492 | 0.207 | -9.59 | -0.9 | ok 1 (chime) |
| `shimmer-sparkle-01.ogg` | shimmer | digital-audio: powerUp3.ogg |  | 1.1494 | 0.689 | -12.96 | -2.21 | ok 1 (shimmer) |
| `shimmer-glass-01.ogg` | shimmer | interface-sounds: glass_001.ogg + glass_005.ogg + glass_002.ogg + glass_006.ogg | yes | 0.4023 | 0.091 | -15.53 | -3.39 | ok 1 (shimmer) |
| `zap-01.ogg` | zap | digital-audio: zap1.ogg |  | 1.0188 | 0.123 | -8.82 | 0.21 | ok 1 (zap) |
| `zap-laser-01.ogg` | zap | digital-audio: laser5.ogg |  | 1.0137 | 0.205 | -15.75 | -1.15 | ok 1 (zap) |
| `zap-phaser-01.ogg` | zap | digital-audio: phaserDown1.ogg |  | 0.4675 | 0.2175 | -11.34 | -0.95 | ok 1 (zap) |

The judge is a **defect check, not a classifier**: a clean sound passes many profiles (measured by `build`:
`hit-metal-light-01` is judge-ok for 19/19 types, `boom-low-02` for 1/19). Types come from the selection, never from
the judge.

#### Judge profiles on real recordings (decision: no change)

`scan` also judges each Kenney file against the type its own name implies (`inferTypesFromName`, camelCase split):
hit 68/110 accepted (42 boomy), click 24/61 (22 multi-hit, 17 clipped, 6 soft-attack, 5 boomy), zap 15/35 (9 boomy,
9 soft-attack, 5 clipped), swish 2/8 (6 boomy), boom 5/7 (2 multi-hit), ui 3/4 (1 soft-attack), glitch 0/4 (4 too
short, 2 boomy), tick 0/3 (2 clipped, 1 soft-attack). Looked at one by one, every rejection is the profile doing its job
on these recordings rather than a wrong threshold, so **neither `DEFAULT_TYPE_PROFILES` nor `SOUND_TYPE_PROFILES`
changed**:

- "boomy" hits are the `_heavy` impacts, punches, mining and soft impacts with 0.70–0.99 of their power under 150 Hz:
  the taxonomy files those under thump (≤ 0.95) and boom, and they pass there (`thump-punch-01` 0.697, `boom-low-01`
  0.948). Kenney's impact pack has almost nothing above 6 kHz (`above6kShare` ≈ 0, centroids 100–500 Hz), so the hit
  limit is never close on the high side.
- "multi-hit" clicks are Interface Sounds' `switch_00n` (press + release, two onsets 0.5–0.6 s apart): not one click.
- "clipped" ticks, clicks and zaps are true peaks of +0.4 … +3 dBTP (UI Audio switches, `tick_001/002`,
  `laserRetro_*`): sources normalised to full scale; avoided rather than trimmed, so the kit keeps Kenney's levels.
- "soft-attack" zaps are the slow laser/force-field swells (47–130 ms rise); the zap profile wants an attack (≤ 30 ms).
- Kenney's "glitch" files are 13–27 ms single blips, under the 30 ms floor; spec 12 means stutters by glitch (several
  onsets), which the kit gets from a four-step layered stutter of two of them (`glitch-stutter-01`, 147 ms, 3 onsets).
- Two boom files have a debris tail counted as extra onsets (the WP1.1b limit on rattling tails); borderline, left.
- Borderline (≤ 0.012 over a limit, not counted as "clearly wrong"): paper's 0.3 under-150 share vs a card shuffle
  (0.302) and a card slide (0.305) on a felt table; ui's 0.3 vs the "back" blip (0.312).

#### Fix: provenance of a registered starter/pack sound could not be committed by an agent

Found while registering a kit sound end to end. The engine's register route returns `library.source = {type:
'starter', packId, file}` (WP1.2 added `file`); `LibrarySourceSchema` (project) is a `looseObject` listing only `type`
and `packId`, and the agent transaction path refuses keys a schema does not list (`findUnknownKeys` treats loose objects
as closed), so `media.register` with the returned provenance failed with `E_SCHEMA: unknown key "file" in
asset.library.source` (measured on the running engine with `POST /api/agent/tx`). The user path (origin `user`) was not
affected. Fix: `file` (optional, 1…4096 chars) is now part of the `starter` and `pack` variants. No schema version bump:
the field was already stored by the loose schema; a malformed `file` (empty) now fails the variant, so repair drops
that `source` (as it does for any unreadable source). Regression test (failed before the fix): `sound-library.test.ts`
"accepts the provenance the engine returns from register (starter/pack `file`) on the strict agent path" (no unknown-key
issue, the command applies and keeps `source`, a misspelt key is still refused, an empty file is invalid).

#### Verified (measured, this branch; shared host, 16 cores, load average 125–140)

- `pnpm vitest run apps/engine/test/sounds-starter-kit.test.ts --maxWorkers=2`: 6 passed (56 s). The committed kit:
  manifest status ok with no errors, 60 sounds (40…60), packs CC0 with archive URL and sha256; tidy names starting with
  the first type, known type ids, Kenney author, CC0 deed, pack page as `sourceUrl`, no `attribution`; uncovered types
  exactly `['key']`, ≥ 3 variants of hit, whoosh, click, pop, ui; the folder holds only manifest files and their
  sidecars; total ≤ 8 MB; each sidecar's asset, author, source, licence, `license-file: none`, date line and pack
  sha256 match the manifest and `ATTRIBUTION.md` has its row; **every file decodes with the engine's `decodeSound`
  (ogg, 48 kHz, 1–2 channels, ≤ 5 s) and the judge accepts it for its first type** (`runAnalysis` + `SOUND_TYPE_PROFILES`).
- `pnpm vitest run scripts/sounds/make-sidecars.test.mjs`: 3 passed (committed sidecars and section up to date;
  sidecar keys parse with `check-assets`' parser; the section is replaced in place or appended once).
- `pnpm vitest run packages/project/test/sound-library.test.ts packages/project/test/sound-credits.test.ts packages/project/test/sound-rank.test.ts --maxWorkers=2`:
  32 passed (with the new regression test). `pnpm vitest run apps/engine/test/sounds-routes.test.ts apps/engine/test/sounds-unit.test.ts --maxWorkers=2`:
  33 passed (WP1.2's suites unchanged).
- `pnpm lint` (Biome, tokens, anime, layers, **check-assets: ok**); `pnpm --filter @jasper/engine typecheck`: pass.
- `node scripts/sounds/make-sidecars.mjs --check`: "60 sidecars and ATTRIBUTION.md up to date".
- Dev engine (`JASPER_APPDIR=.stage JASPER_DEV=1 JASPER_SOUND_SYNTH_VARIANTS=1 pnpm exec tsx apps/engine/src/cli.ts --port 48801`,
  fresh appdir): the automatic index at start found the kit (`starter: {status: ok, sounds: 60, errors: []}`) and indexed
  79 sounds (60 starter + 19 synth) in ≈ 110 s at load ≈ 135 (status polled every 6 s). `GET /api/sounds?license=any&sources=starter&limit=500`:
  60 results, every one `ogg` 48 kHz, `CC0-1.0`, `attribution: null`, `judge.ok: true` score 1 for its first type, peaks
  equal to the curation measurement. `types=hit`: the 7 kit hits, then `Jasper Synth hit 1` last although it scored 0.96
  (real recordings first); `types=whoosh` 4 + synth; `types=riser` 3 + synth; `types=key` synth only. Facets:
  `licenses {cc0: 60, jasper: 19}`, `sources {starter: 60, synth: 19}`.
- Register: a project (`POST /api/projects`, preset `hd-1080p-30`), `POST /api/sounds/snd_bb2cd55c193647c1/register`
  (`whoosh-air-03.ogg`): managed copy `.stage/media/mk_bb2cd…/whoosh-air-03.ogg` with the same sha256 as the kit file,
  provenance `{soundId, title "Air whoosh, bright", types [whoosh], source {type starter, packId kenney-interface-sounds,
  file whoosh-air-03.ogg}, license CC0-1.0, licenseUrl, author "Kenney (www.kenney.nl)", sourceUrl, attribution null,
  7 descriptors, snapshotHash}`. Committed by an agent (`POST /api/agent/tx`, `media.register` + `library`) — E_SCHEMA
  before the fix, ok after; then `clip.place` on A1 at 1 s; `soundCredits(doc)` on the saved `project.jasper`: one row
  (the whoosh, CC0, used in the placed clip, no warnings), text `"Air whoosh, bright" by Kenney (www.kenney.nl),
  CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Source: https://kenney.nl/assets/interface-sounds`.
  Audio route: `Range: bytes=0-99` → 206, `audio/ogg`, `nosniff`, sandbox CSP; visual: 106 peak / spectrogram frames.
- Packaging: `pnpm --filter @jasper/engine build` → `dist/sounds/starter/` holds the 121 files, byte-identical to the
  source folder (`sha256sum` diff). The desktop packager copies `dist/sounds` next to `engine.mjs` in
  `dist-deploy/` (→ `resources/engine/sounds/starter`); reproduced that layout (`engine.mjs`, `sound-worker.mjs`,
  `sounds/` copied into a scratch folder under `apps/engine`) and ran `node engine.mjs --port 48803` with no override and a
  fresh appdir: starter status ok, 60 sounds indexed, all 60 judge-ok in `library.json`. A full electron-builder run
  was not done here.
- Integration: the merge of `feat/sound-design` (P0 close-out: compositions audio graph, project essential sound) was
  fast-forwarded as `317cb4f8` before its checks had run (an ordering slip); they were run right after on that exact
  commit, all green: `pnpm typecheck` (whole workspace) exit 0; `pnpm vitest run packages/project apps/engine/test/sounds-starter-kit.test.ts apps/engine/test/sounds-routes.test.ts apps/engine/test/sounds-unit.test.ts scripts/sounds --maxWorkers=2`:
  145 files, 1796 tests passed; `pnpm lint` ok (check-assets ok). Earlier, under load ≈ 130, one timing test
  (`lumetri-grade.test.ts`, "33³ bake < 30 ms") failed once and passed alone; unrelated to this package.

#### Limits and notes for the next packages

- `key` has no recording (synth fallback). `tick` and `shimmer` have 2 sounds each; the rest 3–7.
- Risers are amplitude swells of engine/hum recordings (exponential fade-in), not pitch sweeps; whooshes are Kenney UI
  noise bursts joined swell-to-decay and slowed (0.6–1.8 s), not recorded air passes; the reverse air swell
  (`reverse-air-01`) is Kenney's own reversed `minimize_005`. Good enough as defaults; a pack (P6) should bring real
  risers, whooshes and keys.
- Kenney's impacts are dark (almost no energy above 6 kHz); there is no bright, crisp hit in the kit.
- Levels are Kenney's (max momentary −30.6 … −8.6 LUFS); loudness matching is the mixing phase's job (P4).
- The manifest has no `attribution` field: `SoundManifestSoundSchema.attribution` is an optional string (null would be
  invalid), and an absent one gives `attribution: null` in the index, which is what CC0 needs.
- Search finding (WP1.1a ranking, not changed here): `q=punch` puts "Crunchy impact" before "Punch", because "punch" is a
  synonym of `hit` and a type match gives the same text score (1) as a title match, so duration fit decides. Worth a
  tie-break on title tokens when the query names a title word.
- Kenney's site may move the archives (the URLs carry a content hash); `fetch` then fails on the sha256, and the pinned
  hashes in `starter-selection.json` / the manifest tell which archive the kit was made from.

### WP1.3 MCP tools

Scope: spec 12 §2.10 (Phase 1 tools only), P1-R6 and the MCP part of P1-R8. Files: `apps/mcp/src/tools/sound.ts`
(10 tools and `SOUND_GUIDE`, registered in `server.ts` and part of `FULL_GUIDE` = the server instructions, the
`edit-video` prompt and the `jasper://guide` resource), `apps/mcp/src/sound-sheet.ts` (the pictures),
`apps/mcp/src/pixel-font.ts` (a 5×7 label font, original work), README tool list (323 → 333; also `docs/gaps.md`,
`docs/parity.md`), tests `apps/mcp/test/sound.test.ts` (real engine) and `apps/mcp/test/sound-sheet.test.ts` (pure).
One ranking fix in `packages/project/src/sound/rank.ts` (+ `RankParts.titleMatch`, `SoundRankPartsSchema.titleMatch`
optional in `packages/api`), regression test in `packages/project/test/sound-rank.test.ts`.

#### Tools

| Tool | Annotations | What |
|---|---|---|
| `sound_library_status` | READ_ONLY | `soundLibraryStatus` + `getSoundRoots` + the facets of a `license: any` search: sounds, `bySource`, `byType`, `byFamily`, `byLicense` (licence classes), starter kit status, packs, folders (`rootId`, path, label, licence, enabled), `foldersAllowed`, synth, `indexedAt`, `needsIndex`, `recovered`, the running index job; a note when the library is empty. |
| `search_sounds` | READ_ONLY | `searchSounds` with `q`, `types`, `family`, `visualKind`, `windowSec`, `length`/`tone`/`attack`/`weight`/`texture`, `license` (default commercial-safe), `sources`, `similarTo`, `limit` 1…24 (default 12), `offset`. Rows: `rank, soundId, title, types, durationSec, peakSec, riseMs, decayMs` (null when it does not decay), `centroidHz, below150Share, flatness, pitchMidi, judge{ok,score,reasons}, license, author, credit` (the entry's attribution line), `creditRequired, source{type}, score`; `facets`, `total`, `librarySize`. `contactSheet: true` (+ `columns`, default 3) adds ONE PNG and `contactSheet.cells`. |
| `get_sound` | READ_ONLY | The full `SoundEntry` (every descriptor, judge, licence, provenance) + `defaultAlign` + `creditRequired`, and a PNG (`width` 320…1600, default 960; height 0.42 × width): waveform over spectrogram, time axis in ms (s past 2 s), 100 Hz / 1 kHz / 10 kHz labels, onset (green dashed), peak (red), decay end (yellow dashed), legend. |
| `view_sounds` | READ_ONLY | `soundIds` 1…24 (duplicates dropped, order kept) → the same contact sheet + cells JSON. |
| `import_sounds` | EDIT | `projectId`, `soundIds` 1…50: `registerSound` each (all or nothing: one failure fails the call before any transaction), then ONE transaction: `bin.create "Sound Effects"` when the project has no root bin of that name, one `media.register` per new file (name = the sound's title, `asset.library` = the returned provenance, `binId`), `media.setLibraryInfo` for a project copy that lacks provenance. Sounds the live document already has (the engine's `existingMediaId`, else the same fingerprint, not derived) are reused (`reused: true`); the same file twice in one call is registered once. Applied with `expectedRevision`. Returns `historyLabel` ("Import Sound <title>" / "Import N Sounds"), the transaction body and `sounds[{soundId,title,mediaId,reused}]`. |
| `insert_sound` | EDIT | See below. |
| `list_sound_credits` | READ_ONLY | `soundCredits(doc, sequenceId?)` on the live document (whole project by default; a sequence with its nests); `format` md (default) / txt / csv → `rows`, `text`, `warnings`, `count`, `attributionRequired`. Unknown `sequenceId` → `E_NOT_FOUND`. |
| `add_sound_folder` | EDIT | `PUT /api/sounds/roots` with the current list + `{path, label?, license?, author?, attributionTemplate?}`; `wait` waits for the index job. The engine route shows the approval card (WP1.2); the tool sends a progress notification every 5 s while it waits and passes `E_APPROVAL_DENIED` / `E_APPROVAL_TIMEOUT` through with their hints. |
| `remove_sound_folder` | DESTRUCTIVE_IDEMPOTENT | By `rootId` or `path`; unknown → `E_NOT_FOUND` listing the folders; approval card as above; returns `removedSounds`. |
| `rescan_sound_library` | EDIT_IDEMPOTENT | `indexSounds({full?})`; `wait` (+ `timeoutSeconds`, default 600) waits with progress. Cancelling the MCP request does **not** cancel the job (it is shared and deduplicated; `cancel_job` does). |

Sound-route errors (`SOUND_NOT_FOUND`, `SOUND_FILE_MISSING`, `SOUND_CHANGED`, `LOCAL_MODE_ONLY`, `BAD_PATH`,
`NOT_A_FOLDER`, `DUPLICATE_FOLDER`, `PERMISSION_DENIED`, …) come back with a hint saying what to do; arguments are strict
like every tool (unknown keys `E_UNKNOWN_ARGUMENT` with the accepted keys and a typo suggestion; sound ids must match
`snd_` + 16 hex digits before any engine call).

**`insert_sound`** (`projectId, soundId, at, align?, track?, gainDb?, sequenceId?`), the agent equivalent of the
panel's Insert (the same rules as the web package's `apps/web/src/sound/insert.ts`, written independently in parallel):

- `at`: a frame, `{seconds}`, `{frames}`, a timecode, or `"playhead"` (the open editor's, when it shows that sequence;
  else `E_NO_SESSION`).
- `align`: `auto` (default) = `SOUND_TYPES[first known type].defaultAlign` (hit/boom/whoosh… peak, riser/reverse end,
  ui start), or `peak` / `start` / `end`.
- Placement = `peakAlignedStart` with the sequence's rational rate, the sound's `peakSec` / `onsetSec` / `headQuietSec`
  and the **media's** duration (the probe of the registered file), `clampStart: true` (a sound that would start before
  frame 0 starts at 0 with its head trimmed; `trimmedHeadSec` and a warning say so), sub-frame on: the In point takes the
  rest when the quiet head allows, so the aligned point is exact to the flick; otherwise it plays `errorFlicks` (< 1 frame)
  late. The clip covers `[In, end of media)` as `clip.place` computes it.
- `track: "auto"` (default): the first free unlocked audio track named "SFX…" over the clip's span, else the first free
  unlocked audio track, else a new audio track "SFX n" (`track.add` in the same transaction). An explicit track (`"A3"`, id
  or name) must be a free unlocked audio track there: `E_OVERLAP` (with the blocking clips), `E_TRACK_LOCKED`,
  `E_TRACK_KIND` (a video track) or `E_NOT_FOUND`. It never overwrites: the free check is made on the document read with
  its revision, and the transaction carries `expectedRevision` (a concurrent edit → read again and retry once).
- ONE transaction "Add Sound <title>": [bin + `media.register` | `media.setLibraryInfo`] + [`track.add`] + `clip.place`
  (`video: false`, `mode: overwrite` on the verified-free span) + `essentialSound.setType sfx` + [`clip.update {gainDb}`].
- Returns `clipId, mediaId, track` (label), `trackCreated, start/end {frame, timecode}, align, alignedFrame` (+ `peakFrame`
  for peak), `sourceInFlicks, alignFlicks, errorFlicks, errorMs`, `historyLabel`, `credit` when the licence needs one, and
  notes for synth sounds (a fallback), credit-requiring and not-commercial-safe licences.

**Pictures** (`sound-sheet.ts`, pure, PNG via `png.ts`): each cell 360 px wide: header with `#n snd_…` and the title at
2× scale, then `types length pk <ms> dec <ms> <centroid>Hz` and the judge (green ok + score, orange reasons) at 1×; then a
120 px plot: the engine's 64-band log spectrogram (20 Hz at the bottom; −96…0 dBFS on a dark→violet→orange→pale-yellow
ramp) over the whole covered length, the waveform envelope (max |sample| per pixel column from the 10 ms peaks,
**normalised to the sound's own maximum**, mirrored, cyan), the peak as a 2 px red line at `peakSec`, and the end of the
decay (peak + `decayMs`, −20 dB) as a dashed yellow line (none when `decays` is false). Cells are laid out with
`composeGrid` (3 columns by default, ≤ 6), 6 px gaps. Long files: the visual data covers the first 30 s (`shownSec` in the
cell JSON; the detail picture prints "first 30s shown"). Damaged visual data is bounded and never throws (fast-check).
The label font is a 5×7 bitmap drawn for this file (printable ASCII; accents folded, other characters "?"): it is source
code, original work, so it needs no asset sidecar.

#### Ranking fix (requested by WP1.2b)

`q=punch` ranked "Crunchy impact" above "Punch": "punch" is a synonym of `hit`, and a type match scored the same text
score (1) as an exact title word, so the duration fit decided. Now `rankSounds` sorts **real recordings first, then the
share of query words a title word matches exactly or by prefix (≥ 3 letters) — `parts.titleMatch` — then the score, then
the id**. A title match therefore always outranks a match through a type or synonym (the title tier is a tier, like the
source tier, not a weight), while the score still orders sounds within a tier. Without a query `titleMatch` is null and
nothing changes. Regression test (failed before the fix: "Punch" came last): `sound-rank.test.ts` "a title word (exact or
prefix) outranks a match through a type synonym (starter-kit regression)" with the kit's measured descriptors of "Punch",
"Crunchy impact" and "Heavy punch thump"; it also checks a title prefix ("Whooshing drone", a riser with a bad judge and a
9 s length) beating a better-scoring whoosh-typed sound, and `titleMatch` 0.5 for a two-word query.

#### Decisions

- **Contact sheets are drawn by jasper-mcp** from `getSoundVisual` (engine-side drawing would need a PNG encoder and
  font in the engine; the MCP package already has `png.ts`). The waveform is normalised per sound so quiet sounds keep a
  readable shape; loudness is in the numbers (`get_sound`: integrated / max momentary LUFS, true peak), not the picture.
  Labels use a 5×7 bitmap font drawn for this purpose (`pixel-font.ts`) instead of a third-party font: no asset, no
  licence question. Three columns by default keep 2× ids readable; 24 cells max (`MAX_SHEET`) keep a sheet ≤ 6 × 8 cells
  (≈ 2.2 k × 1.5 k px at 6 columns).
- **search_sounds caps `limit` at 24** (the spec's contact-sheet budget), with `offset` for paging; facets still count
  the whole match.
- **insert_sound uses `clampStart: true`** (like the panel): near frame 0 the head is trimmed and reported rather than
  refused; the aligned point stays exact.
- **The default track rule** mirrors the panel's minus the editor-only parts (drop target, targeted tracks): SFX-named
  free track → first free audio track → new "SFX n". Free = unlocked and no clip overlapping the clip's span.
- **import_sounds is all or nothing** (every sound registered before the transaction). A failure after some
  registrations leaves their managed copies in the engine's media store unused by the project (the same as an
  abandoned import; the cache cleaner treats them like any unreferenced media).
- **rescan_sound_library does not cancel the job when the request is cancelled**: the index job is shared (deduplicated)
  with the editor and other agents.
- **Folder tools send the complete list** (`PUT /api/sounds/roots` semantics), reading it first; a concurrent change by
  the user between the read and the write is overwritten by this list (the window is one request; the engine has no
  revision on roots).
- **Approval waits** report progress every 5 s ("Waiting for the user to approve …") like `transact`.

#### Verified (measured, this branch; shared host, 16 cores, load average 55–80)

- `pnpm vitest run apps/mcp/test/sound.test.ts --maxWorkers=1`: **10 passed** (≈ 2 min). A real engine
  (`apps/engine/src/cli.ts`, temp appdir, token + editor key) indexes 12 files copied from the bundled starter kit (their
  manifest entries) + 19 Jasper Synth sounds, and jasper-mcp over stdio drives it:
  rescan with `wait` (progress notifications received; 31 sounds) and without (`wait_for_job`); status (bySource,
  byLicense cc0 12 / jasper 19, byType, folders, needsIndex false); search rows and their fields, **`q=punch` puts both
  title matches ("Punch", "Heavy punch thump") before "Crunchy impact"**, `types=hit` → 3 starter then the synth hit,
  strict arguments (`query` → `E_UNKNOWN_ARGUMENT` with the accepted keys; `limt` → "did you mean "limt" → "limit"";
  `limit: 25`, a malformed id → `E_INVALID_ARGUMENT`; an unknown id → `SOUND_NOT_FOUND`); the contact sheet of 5 results:
  cells JSON in result order, 3 columns × 2 rows, **the PNG decodes to 1104 × the reported height**; get_sound: every
  descriptor, `defaultAlign` peak (hit) / end (riser), PNG 800 × 336; view_sounds of 7 ids in 2 columns (order kept, cell
  3 at row 2 column 1, 4 rows, PNG 738 px wide), 25 ids refused; import_sounds of 2 sounds: provenance on both media
  (soundId, CC0, starter), the "Sound Effects" bin, **revision +1 (one transaction, `historyLabel` "Import 2
  Sounds")**, the same sound again `reused: true` with the same mediaId, an unknown id in a batch fails it (nothing
  imported), `soundIds: []` refused; insert_sound: **for every insert the aligned point plays at `start·F + (alignFlicks −
  In) = cue·F + errorFlicks` (± 2 flicks) with 0 ≤ errorFlicks < 1 frame**, `alignFlicks` = the entry's `peakSec`, the clip
  tagged sfx, the bin created; four inserts at the same frame go to A1, A2, A3 and a new "SFX 1" (A4), a fifth to a new
  "SFX 2" (A5), four clips start at the same frame (nothing overwritten); at 10 s the free "SFX 1" is preferred; an
  explicit busy track → `E_OVERLAP`, a video track → `E_TRACK_KIND`; a riser with `track: A2, gainDb: −6` aligns its end
  (`align: end`, the clip ends at frame 599–600) and has gain −6; at frame 2 a 0.23 s-peak sound starts at 0 with
  `trimmedHeadSec` > 0 and still lands exactly; `at: "playhead"` without an editor → `E_NO_SESSION`; one more insert moves
  the revision by exactly 1; credits: empty project 0 rows, then one row "Punch" CC0 used by one clip, md / txt (`"Punch"
  by Kenney…`) / csv (header), unknown sequence `E_NOT_FOUND`, `format: pdf` refused; folders: **no editor window →
  `E_APPROVAL_DENIED` with the "do not retry" hint; a stand-in editor window (the engine's `/agent` WebSocket with the
  editor cookie, a minimal RFC 6455 client in the test) gets the card "Add a sound folder" naming the path and
  CC-BY-4.0; denied → `E_APPROVAL_DENIED` and no folder; approved → the folder, its index job waited (1 added)**; the
  folder's WAV is found as a CC-BY hit with a generated credit naming the author; inserted into a project, the credits
  report 1 attribution-required row with CC-BY-4.0 in the text; remove: unknown id `E_NOT_FOUND`, the card "Remove a
  sound folder" approved → `removedSounds: 1`, no folder sounds left. No network.
- `pnpm vitest run apps/mcp/test/sound-sheet.test.ts`: **6 passed**: font folding and widths; a cell 360 × 182 with the red
  peak line exactly at x = 2 + round(0.25 × 356) and not 20 px before it, the dashed decay line on its column (absent when
  the sound does not decay); detail 960 × 403; grid size; **a 150-run fast-check of hostile visual data** (bad base64,
  counts up to 10 M, NaN/∞ durations, negative peaks): never throws, allocations capped (≤ 60 000 peaks, ≤ 6000 × 256
  cells).
- `pnpm vitest run packages/project/test/sound-rank.test.ts`: 14 passed; the new regression test failed before the fix
  ("expected 'snd_punch' to be 'snd_crunchy'": Punch was last) and passes after.
- `pnpm vitest run apps/mcp/test/readme-tools.test.ts apps/mcp/test/conventions.test.ts apps/mcp/test/sound-examples.test.ts`:
  13 passed (README lists exactly the 333 tools; every tool has the four hints set consistently and strict schemas).
- **Run for real** (dev engine `JASPER_APPDIR=.stage JASPER_DEV=1 JASPER_SOUND_SYNTH_VARIANTS=1 tsx apps/engine/src/cli.ts
  --port 49002`, the **full** 60-sound starter kit + 19 synth; a scratch MCP client script over stdio): status 79 sounds
  (60 starter, 19 synth; byType hit 8, riser 4, key 1…); a 24-cell contact sheet of hits, booms, thumps, risers, whooshes
  and UI sounds (1470 × 1134 px, 1.1 s) **looked at**: ids, titles and numbers are legible at 1:1; the red peak line sits on
  the transient of every one-shot (Heavy metal hit at 2 ms, Punch 41 ms, Deep low boom 104 ms on its first big spike,
  Low boom 83 ms, Toggle 2 ms) and at the end of the risers (Thruster riser 2946 ms, Computer hum riser 2967 ms); the
  whooshes peak in the middle of their swell; the dashed decay lines follow the measured decays. `get_sound` pictures of
  "Heavy punch thump" (peak 25 ms on the waveform maximum, onset 9 ms) and "Thruster riser" (peak at the end, onset 2.08 s)
  looked right. Then `insert_sound` "Heavy punch thump" at 2 s (A1, start 2 s, `errorMs` 24.5: its quiet head is 1.4 ms,
  shorter than its 24.5 ms peak offset, so it plays that late — WP1.1a's rule) and "Thruster riser" at 2 s (align end:
  clip 0–60 on A1, In = 1 s, error 0), `start_export` (native, 79 frames) → `/tmp/…mp4`, decoded with ffmpeg and searched
  with the descriptors' own 2 ms RMS / 0.5 ms hop: **the loudest point after 1.95 s is at 2.0245 s (= 2 s + the reported
  24.5 ms) and the riser's at 1.9455 s (= 2 s − its 54.5 ms tail after the peak)**: the export plays the sounds where
  insert_sound said.
- `pnpm --filter @jasper/mcp typecheck`, `pnpm lint` (Biome, tokens, anime, layers, assets): pass. Before integrating:
  `pnpm typecheck` (whole workspace) exit 0; `pnpm vitest run packages/project/test/sound-rank.test.ts
  packages/project/test/sound-library.test.ts packages/project/test/sound-credits.test.ts packages/api/test
  apps/engine/test/sounds-routes.test.ts apps/mcp/test/sound.test.ts apps/mcp/test/sound-sheet.test.ts
  apps/mcp/test/readme-tools.test.ts apps/mcp/test/conventions.test.ts apps/mcp/test/sound-examples.test.ts
  apps/mcp/test/unit.test.ts --maxWorkers=2`: 13 files, 108 tests passed.

#### Limits and notes for the next packages

- `insert_sound` is frame-based on the sequence and exact only when the sound's quiet head absorbs the sub-frame rest;
  otherwise the aligned point is late by `errorFlicks` (< 1 frame; measured 24.5 ms at 30 fps for "Heavy punch thump").
  Kenney's one-shots mostly start at once (quiet heads of 0–2 ms), so many land up to a frame late. Phase 2's
  `soundDesign.place` should decide whether to pad (e.g. a leading-silence render) or accept it.
- The clip covers `[In, end of media)` rounded down to whole frames (what `clip.place` makes), so up to one frame of the
  tail can be cut, and an end-aligned sound whose head is not quiet loses up to a frame of its end.
- `insert_sound` does not set `AudioClip.sfx` (that schema is Phase 2); it tags Essential Sound ▸ SFX only.
- Undo was verified as "one transaction" (revision +1, one History label); `history.undo` itself needs an editor
  session, which the headless test cannot open (the web package covers undo in the editor).
- Pictures cover what the engine's visual data covers (first 30 s); the 10 ms peaks make sounds under ≈ 50 ms blocky.
- No `list_sound_packs` / `install_sound_pack` / `remove_sound_pack` (P6), no cue / proposal tools (P2–P3);
  `SOUND_GUIDE` will grow with them.

### WP1.4 Sound Library panel

Scope: spec 12 §2.7 (Sound Library panel, Audition, Insert; minus cues, In Context and Replace, which are P2), P1-R7
and the UI part of P1-R8. Files: `apps/web/src/panels/soundLibrary/{index.ts,SoundLibraryPanel.tsx,MiniWaveform.tsx}`,
`apps/web/src/sound/{model,prefs,insert,audition,controller,dialogs.tsx,PreferencesPage.tsx}.ts(x)`,
`apps/web/src/audio/audition-meter.ts` (+ `audio/runtime.ts` `useMeterReading`), `apps/web/src/commands/sound.ts`
(+ `commands/index.ts`, `keymap-defaults.ts`, `app.ts` panel label), the timeline drop
(`panels/timeline/model/sound-drop.ts`, `components/SoundGhost.tsx`, `state/ui-store.ts` `soundGhost`,
`TimelinePanel.tsx` dragover/drop), `panels/types.ts` + `registry.ts` (kind `soundLibrary`), the Audio workspace
(`shell/workspaces/definitions.ts`: a tab next to Essential Sound), File ▸ Export ▸ Sound Credits… (`shell/menus/model.ts`),
icons `panel.soundLibrary`, `app.autoplay`, `app.volume`, `app.favourite`, `app.favouriteOn` (`packages/ui` registry:
lucide `LibraryBig`, `CirclePlay`, `Volume2`, `Star`; `favouriteOn` is our own glyph, a star with inner stars, so the
state differs by shape), es.json (173 new strings), and `soundCredits(…, {attributionOnly})` in `packages/project`
(`src/sound/credits.ts`). Tests: `apps/web/test/sound-{library-model,insert,audition}.test.ts`,
`sound-library-panel.test.tsx`, `sound-helpers.ts`, `packages/project/test/sound-credits.test.ts` (one new case),
`e2e/sound-library.spec.ts` (+ `e2e/serve.mjs` defaults `JASPER_SOUND_SYNTH_VARIANTS=1`).

#### What the panel does (usage)

- **Open it**: Window ▸ Sound Library, the Audio workspace (Alt+Shift+7, tab next to Essential Sound), or the command
  `panel.focus.soundLibrary`. It needs the engine (`requires: ['engine']`); with no engine it says so.
- **Toolbar**: search (debounced 150 ms; Ctrl/Cmd+F in the panel focuses it; Enter or ↓ moves to the results), Loop
  (L), Auto-play on select, audition volume (−40…+6 dB, default −6 dB).
- **Collection**: All sounds, Favourites (n), Recent, Used in this project, Sources › Starter kit / Packs / Folders /
  each folder / Jasper Synth (only sources that have sounds). All and Sources are engine searches (`searchSounds`
  with `sources` / `rootId`, paged 100 at a time as the list scrolls); Favourites, Recent and Used are fetched by id
  (`getSound`, cached) and filtered and ordered **with the same `rankSounds`** the engine uses (`sound/model.ts`
  `searchLocal`, disjunctive facets computed the same way); without a query they keep their own order (last starred
  / most recent first).
- **Type chips** grouped by family (Impacts, Movement, Digital, Tactile, Tonal, Beds) with the engine's disjunctive
  facet counts; chips with no sounds are hidden unless selected. Several chips = any of them (`types` csv). A selected
  chip shows ✓ (not colour alone).
- **Refine** (collapsible, remembered): Length short/medium/long, Tone dark/bright, Attack punchy/soft, Weight
  light/heavy, Texture clean/noisy (the `DESCRIPTOR_FILTERS` thresholds of WP1.1a). **Commercial-safe** is a pill that
  is on by default (`license=commercial-safe`); off = `any`. "Clear filters" resets everything.
- **Results**: a virtualised `listbox` (fixed rows of 36 px, 24 px with Compact Rows; only the rows in view ± 8 are
  rendered) with `aria-activedescendant`. A row: playing ▶ marker, the 120×24 waveform (engine peaks, column maxima;
  `--pr-accent` peak tick and a faint `--pr-accent` wash before it), name, types · duration, licence badge (CC0 / BY /
  BY-SA / Open / Yours / Synth; `Yours?`, NC, ND and `?` in `--pr-warning` with a border: the text differs too), the
  favourite star (outline / filled glyph). Accessible name: title, types, duration, "peak at 233 ms", descriptor words
  (punchy, soft attack, dark, bright, heavy, light, clean, noisy, tonal, loopable), licence and "favourite". Tooltip:
  the same plus rise, centroid, max momentary LUFS, source and author.
- **Keyboard** (scope `soundLibrary`, rebindable): ↑/↓/Home/End/PageUp/PageDown select (Auto-play auditions the new
  selection), **Space** audition / stop, **Enter** insert at the playhead, **F** favourite, **L** loop, **Esc** stop the audition, **Ctrl/Cmd+F**
  search. The dispatcher ignores keys inside `role="listbox"` (it treats them as an overlay), so the list resolves the
  chord itself along `scopeChain('soundLibrary')` with the active keymap and runs the bound command (the same way the
  monitors do), which keeps the bindings rebindable and global chords (Ctrl+S…) working from the list.
- **Mouse**: click selects, double-click inserts, right-click: Audition / Stop Audition, Insert at Playhead, Favourite,
  Find Similar (`similarTo`, shown as a removable "Similar to …" chip), Show Licence… (licence + class text, licence
  URL, author, source and source URL, credit line with Copy), Reveal in Folder (desktop only, folder sounds only:
  `jasperDesktop.revealInFolder(root.path/relPath)`).
- **Status line**: "4 of 79 sounds · Starter kit 60 · Jasper Synth 19", indexing progress, audition errors.
- **Empty library**: "No sounds yet" with **Install Starter Kit** (indexes the bundled kit: `indexSounds`; disabled
  with "This build has no starter kit" when the manifest is absent) and **Add a Folder…** (opens Preferences ▸ Sound
  Library). It refreshes on `sounds.changed` and polls status every 2 s while an index job runs.
- **Preferences ▸ Sound Library**: library counts, last indexed, Rescan / Full Rescan (a `sound-index` job, listed in
  the Jobs panel under Other; progress shown on the page), user folders (local engines only): add by path (Browse… on
  desktop: `pickFolder`), per-folder licence declaration (not declared / royalty-free / CC0 / CC BY 3.0, 4.0 / CC BY-SA
  3.0, 4.0 — the engine's `SOUND_ROOT_LICENSES`), author, credit template (shown for attribution licences), enable,
  remove; folder edits are saved with "Save Folders" (the engine validates them; errors shown). Audition: on hover
  (off), auto-play, loop, volume. Display: compact rows.
- **Credits**: File ▸ Export ▸ Sound Credits… (also in the panel menu): credits for the active sequence (with its
  nested sequences) or the whole project, all sounds used or only those whose licence asks for a credit, as Markdown,
  plain text or CSV (`soundCredits`), a preview, the licence warnings, Save… (the browser download, like captions).
- **Agents** (UI command catalogue, `agentExposed`): `soundLibrary.search {query}` (opens the panel and searches),
  `sound.insertAtPlayhead {soundId, at?, align?: 'peak'|'start'}`, `file.exportSoundCredits`; `panel.focus.soundLibrary`
  is generated. The panel's `agentDescription` lists what it does.

#### Insert (spec 12 §2.3 / §2.7)

`sound/insert.ts` `insertLibrarySound(session, engine, entry, {at?, align?, preferredTrackId?})`:

1. `registerSound(soundId, projectId)` (the engine copies kit/pack/synth files into managed media).
2. One transaction **"Add Sound <title>"** (one undo step): `bin.create "Sound Effects"` when the project has no root
   bin of that name, `media.register` with `library` into it (or reuse: the engine's `existingMediaId`, else media of
   the same fingerprint already in the document; a reused media without provenance gets `media.setLibraryInfo`),
   `track.add {kind: audio, name: "SFX n"}` when needed, `clip.place` (`sourceRange` In = `sourceInFlicks`, Out = the
   media's end, `video: false`, overwrite mode on a span that is free), `essentialSound.setType sfx`. The new clip is
   selected; the sound goes to Recent.
3. Toast "Added <title> to A4 · peak at <timecode>" (the project's timecode display) with **Undo** (`history.undo`); a
   detail line when the head had to be trimmed.

Placement: `peakAlignedStart({align: 'peak', clampStart: true})` with the default sub-frame trim (exact to the flick
when the head is quiet enough, otherwise ≤ 1 frame late, never early). Alt-drop / `align: 'start'` aligns the first
sample. A peak later than the playhead time would start the clip before 0: it starts at 0 with the head trimmed so the
peak still lands on the playhead (decision: the spec's `start < 0` refusal is for agents' explicit placements; for an
interactive insert at frame 12 a trimmed head is more useful than an error, and the toast says how much was cut).
Track (`chooseSoundTrack`): the drop track if it is a free audio track, else the first free **targeted** audio track,
else a free track whose name starts with "SFX", else the first free audio track, else a new "SFX n" (next unused n).
Free = unlocked and no clip over `[start, start + frames)`, so inserting never overwrites audio (property test).

**Drag**: rows are draggable with `application/x-jasper-sound` = `{type: 'jasper/sound', soundId}` (validated with zod
on drop), the id also as the type `application/x-jasper-sound-id.<id>` and the entry kept for this window's drag (types,
not data, are readable during dragover). Over the timeline (`resolveSoundDrop`): the pointer is the **peak** (Alt: the
start); with snapping on, the peak snaps first to the TL-453 targets (playhead > marker > In/Out > clip edge); only
when it finds nothing do the clip's start and end edges snap. The ghost (`SoundGhost.tsx`: `--pr-ghost-fill` with a
dashed `--pr-ghost-stroke`, a 2 px `--pr-accent` peak tick, the destination track or a dashed row below the last
audio track for a new "SFX n") and a tooltip "peak → 00;00;01;15 / <title> → A1" follow the pointer; the snap line
shows. A drag from another window has no entry: the drop frame is the peak and the sound is fetched on drop.

#### Audition (decision: own context, shown on the Mix meters)

`sound/audition.ts` `AuditionPlayer`: fetches `soundAudioUrl` (with the session cookie), decodes once (24 most recent
sounds kept, ≤ 32 MB of PCM each and ≤ 160 MB in total; longer sounds stream, see "Review fixes"), plays an `AudioBufferSourceNode` → gain (audition volume) → the output; Loop starts
the sound again 250 ms after it ends; a newer play or stop cancels a pending load (it never starts late). It runs on
**its own AudioContext**, not the Program monitor's: that context belongs to Remotion's transport (suspended while
paused, the Phase 0 primed-start logic keys off its state changes), and resuming it for an audition would break the
next primed start. "Plays through the Mix so meters move" is met by `audio/audition-meter.ts`: while an audition
plays, the player publishes per-channel peak/RMS (two `AnalyserNode`s, every animation frame) and `useMeterReading(…,
'master')` shows them on the Audio Meters and the Track Mixer's Mix strip instead of the Program mix (measured in the
e2e: `data-live` true while auditioning). The audition is not processed by the sequence's Mix (master fader, loudness
normalisation, limiter): a library sound is heard as it is, at the audition volume, as in Premiere's Essential Sound
browsing. It never writes the document or history (tested). Hover audition (off by default) waits 350 ms and stops on
leave. Auditioning or inserting adds the sound to Recent; favourites, recents, loop, auto-play, hover, volume, density
and the Refine state are UI preferences (`jasper:sound-library-prefs` in localStorage, validated on read; ≤ 500
favourites, ≤ 50 recents).

#### Verified

Measured on this branch after merging `feat/sound-design` (10a61d6e), shared host with 16 cores, load average 70–85.

- `pnpm vitest run --project @jasper/web --maxWorkers=3`: 108 files, 739 tests passed (the whole web project). The run
  before the last merge found one missing Spanish string (`{0} of {1} sounds`), fixed. New:
  - `sound-library-model.test.ts` (17): prefs defaults / hostile values / 300-run property / persistence / damaged
    storage; the engine request from the filters; local collections (rank order, collection order without a query,
    disjunctive type and licence facets, commercial-safe); every licence badge; accessible names ("peak at 23 ms",
    descriptor words, licence, favourite); "used in this project"; waveform columns (known values, 300-run hostile
    property, base64); drag payload round trip and 4 malformed payloads; placement: the peak lands in [cue, cue + 1
    frame) to 2 flicks, Alt / start alignment, a start before 0 trimmed from the head; track choice order (drop track,
    targeted, SFX-named, first free, new "SFX 1" → A4); a 60-run property (random clips on A1–A3, random cue and peak):
    the chosen track is always free over the span, a new track only when none is; drop snapping (peak to the playhead
    first, the start edge when the peak has no target, snapping off, Alt, an unknown sound).
  - `sound-insert.test.ts` (4): one transaction with bin, media + provenance, clip at start 39 for a 0.2325 s peak at
    frame 45 (30 fps), SFX type, selection, toast text "Added Crunch to A1 · peak at 00:00:01:15"; **undo restores the
    exact document, redo gives the same one**; second insert reuses media and bin and goes to A2, the fourth to a new
    "SFX 1" (A4), no overlaps on any track; a project media with the same file gets its provenance filled; refusals
    (engine failure leaves the document untouched, unknown sequence, zero length, read-only project).
  - `sound-audition.test.ts` (4, fake AudioContext and timers): play → meters published → end; toggle; one fetch for
    two plays (cache); loop restarts exactly 250 ms after the end and stops with Stop; volume −20 dB = gain 0.1; no Web
    Audio / failed fetch reported as `error`; a stale load never starts.
  - `sound-library-panel.test.tsx` (5): listbox and option names, chips with counts, status; keyboard: ↓/↑ move
    `aria-selected` and `aria-activedescendant`, Space → aria-live "Playing Crunch" and no history entry, F stars, L
    loops, Enter inserts (start 39, one history entry); chips, Refine and Commercial-safe reach the search; Ctrl+F
    focuses the search; the empty state; the credits dialog preview after two double-click inserts.
- `pnpm vitest run packages/project/test/sound-credits.test.ts`: 7 passed (new: `attributionOnly` lists only the
  sounds that need a credit, in text, Markdown and CSV, and keeps every warning).
- `pnpm vitest run --project @jasper/ui`: 39 passed (icon registry). `apps/web/test/keymap.test.ts` (no duplicate
  chords per scope on 6 platform/runtime pairs) and `polish-menu-wiring.test.ts` (every menu and key binding names a
  registered command) pass with the new bindings and menu entries.
- `pnpm typecheck` (workspace), `pnpm lint` (Biome, tokens, anime, layers, assets), `node scripts/i18n.mjs --check`
  (8792 strings), `pnpm notices --check`: pass.
- `pnpm build`, then `E2E_PORT=48905 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-library.spec.ts`: 1 passed
  (1.0 min; run twice, before and after the merge). In the built app with a fresh appdir (starter kit 60 + Jasper Synth
  19 indexed on first use): search "crunch"; Space → aria-live "Playing …" and the Audio Meters `data-live="true"`,
  Space again → "Audition stopped", history unchanged; Enter with the playhead at 45 → one clip whose peak (from its
  media's provenance) is in [45, 46) frames at 29.97 fps, tagged SFX, history "Add Sound …", "Sound Effects" bin in the
  Project panel; Ctrl+Z → no clip, no media; a mouse drag of the row onto A1 3 px right of the playhead → ghost, peak
  tick and snap line visible, drop → the peak in [45, 46) on A1; File ▸ Export ▸ Sound Credits… → Markdown preview,
  Save… downloads `…-sound-credits.md`.
- Looked at (screenshots in `test-results/e2e-sound-library/`, and with the dev stack on ports 48901/48902 and an
  empty-library engine on 48903/48904): the panel (chips by family with counts, waveforms with the peak tick and the
  pre-peak wash, CC0 badges, status "79 sounds · Starter kit 60 · Jasper Synth 19"), high contrast
  (`data-pr-contrast="high"`), the drag ghost with "peak → 00;00;01;15 / Reverse crunch → A1" and the insert toast with
  Undo, the credits dialog, the licence dialog (CC0, Kenney, source URL, credit line), the context menu, the empty state
  (Install Starter Kit disabled without a kit, Add a Folder…), Preferences ▸ Sound Library adding a folder (indexed:
  "door slam.wav" → Hit, Boom; hidden by Commercial-safe, shown with the `Yours?` warning badge when it is off).

#### Limits and notes for the next packages

- In Context audition (Shift+Space), Replace mode, cue filling, the Palette collection and the Program overlay chip are
  P2/P3 (spec 12 §2.7); the keymap scope already exists (`soundLibrary`), Shift+Space is free in it.
- Insert always aligns the peak (Enter, double-click, drag) or the start (Alt-drop); the taxonomy's `defaultAlign`
  (risers and reverses by their end) is not used yet: `soundDesign.place` (P2) should own that, and the panel should
  call it once it exists. *(Superseded by the Phase 1 verification: the panel and MCP share `resolveSoundAlign`.)*
- Packs: the Sources › Packs entry appears when the index has pack sounds; installing packs is P6.
- Reveal in Folder is offered only for folder sounds on desktop (starter/pack files live in the app's install folder).
- The credits Save uses the browser download (as captions export does); there is no "next to the export" sidecar yet
  (`ExportSettings.credits`, §2.11, is a later package).
- Facets of local collections (Favourites, Recent, Used) are computed in the browser over at most 500 / 50 / the
  project's sounds; the engine search pages by 100 and never loads more than the user scrolls to.
- The list is a single column: below the panel's minimum width (280 px) the name truncates first.

#### Review fixes (Phase 1 verification, branch `feat/sd-p1v-web`)

Review findings on the panel, fixed with a regression test each (every test below was run against the previous
sources and failed there, except the tooltip helper, which is new code extracted from `TimelinePanel.tsx`):

- **Long sounds stream** (`sound/audition.ts`). Decoding is allowed only when the decoded PCM (`durationSec × channels ×
  max(file rate, context rate) × 4`) fits `DECODE_MAX_BYTES` = 32 MB (≈ 87 s of stereo 48 kHz); longer sounds, and
  sounds whose format is unknown, play through an `<audio>` element (`crossOrigin = use-credentials`) →
  `MediaElementAudioSourceNode` → the same gain / analysers, so volume, Loop (250 ms gap, `currentTime = 0`) and the Mix
  meters behave the same; a 30 min folder WAV is never fetched whole nor decoded (before: ≈ 690 MB of float PCM plus
  the file). The decoded cache keeps ≤ 24 sounds **and** ≤ `CACHE_BUDGET_BYTES` = 160 MB in total (LRU); a buffer
  larger than the decode budget (format understated) plays but is not kept. Tests: `sound-audition.test.ts` "streams a
  long sound…", "keeps the decoded cache within its total byte budget…".
- **The audition plays alone and can always be stopped**: Esc in the `soundLibrary` scope runs
  `soundLibrary.stopAudition` (no longer hidden; rebindable; no chord conflict in the scope); closing the panel stops
  it (a looped audition could not be stopped before); `auditionPlaysAlone` (`sound/controller.ts`) pauses the Program
  transport when an audition starts and stops the audition when the transport starts playing. Tests:
  `sound-audition.test.ts` "plays alone…", `sound-library-review.test.tsx` "stops the audition on Esc…".
- **Recent keeps its order while you browse**: the collection is read when it is entered or the search changes, not on
  every audition (auditioning moves a sound to the front of Recent). Test: Recent [A, B, C, D] with Auto-play, ↓ ×3
  selects D.
- **Virtualised list**: a callback ref measures and observes each list element (the empty states unmount it); new
  filters scroll the list to the top; the selected row is always rendered (`aria-activedescendant` never names a
  missing element) and every row has `aria-setsize` (the result total) / `aria-posinset`. Tests: three in
  `sound-library-review.test.tsx`.
- **Paging**: results carry the search epoch and the filters they answer; `loadMore` pages only the results on screen
  with their own filters and an `AbortController`; a page from an older search is dropped; a page that adds nothing
  marks the results exhausted (no request loop). A failed page is asked again only when the list scrolls.
- **Search in another UI language** (spec §2.7 "type ids and translated labels"): `localizeSoundQuery` (`sound/model.ts`)
  replaces whole words equal to a translated type label (lower case, accents folded, longest label first: "golpe sordo"
  → `thump` before "golpe" → `hit`) with the type id, in the engine request and the local collections. English is sent
  as typed.
- **Smaller**: a failed `getSound` is not cached (the next search asks again); Install Starter Kit asks for the status
  at once, so "Indexing n %" shows and the 2 s polling starts (the panel's own command context now has the `engine`
  capability when the engine is connected); the cross-window drag tooltip names the track "A2", not its id
  (`panels/timeline/model/sound-drop-tooltip.ts`); `sound.insertAtPlayhead` fails with the insert's own message
  ("Could not add the sound: disk full", "The project is read-only"…) for agents; Preferences: every engine promise is
  caught (no unhandled rejection when the engine goes away), Add Folder keeps the typed path until the engine accepts it;
  the 501st favourite is **refused** with a toast ("Favourites are full (500 sounds)") instead of silently dropping the
  oldest one (`toggleFavourite` returns `'full'`).
- **i18n**: the strings these files build outside the transform's positions go through `t()` with Spanish entries: licence
  badges (Synth, Jasper, Yours, Yours?, and "Open [licence badge]" — `withoutContext` in `i18n/runtime.ts` strips a
  trailing "[context]" so a homonym gets its own key; es.json "Open" is the verb), "favourite" in names, audition errors,
  insert errors and the "Added … · peak|start|end at …" toast, the aria-live texts, the status count, the drop tooltip,
  Preferences messages, and the credits warnings (rebuilt in the dialog from each warning's code and row:
  `creditWarningText`). Test: the panel rendered in Spanish shows none of those English strings.

Decision recorded, not changed: the drop snapping uses the timeline's TL-453 rule (the nearest target wins, priority
breaks ties, In/Out above cuts), while spec 12 §2.7 lists playhead > cue > marker > cut > In/Out; the integrator keeps
TL-453 for consistency with every other timeline drag.

Known limits found on the way (not fixed here): the sound type labels share es.json keys with homonyms of other
features, so some Spanish chips read oddly ("Key" → "Incrustación", "Reverse" → "Invertir", "Pop" → "Aparecer"); they
need their own context keys (`withoutContext`) — done in the Phase 1 verification ("Key [sound type]" → "Tecla",
"Reverse [sound type]" → "Inverso", "Pop [sound type]" → "Pop", shown through `typeLabel`). The insert's history label "Add Sound <title>" and the placement
refusals that come from `@jasper/project` stay English.

### Phase 1 verification

Branch `feat/sd-p1-verify` (from `feat/sound-design` 7e15487f), with two helper branches merged into it:
`feat/sd-p1v-web` (panel review fixes: "Review fixes" under WP1.4) and `feat/sd-p1v-engine` (engine review fixes:
"Review fixes (P1 verification)" under WP1.2). Three read-only review passes (engine; web; project + audio-fx + MCP)
produced the findings; every confirmed defect got a regression test that was run against the code before the fix and
failed there (stated per item in the two "Review fixes" sections and below).

#### Requirements (spec 12 Phase 1) with evidence

| Req | What | Where | Evidence (tests; all pass on this branch) |
|---|---|---|---|
| P1-R1 | taxonomy, rank, credits (pure), `LibraryProvenance` on media, repair, `media.setLibraryInfo` | `packages/project/src/sound/*`, `commands/handlers/sound.ts`, INV-LIBRARY in `invariants.ts` | `packages/project/test/sound-{taxonomy,rank,rank-scale,library,credits,insert,place,review-fixes}.test.ts`, `fuzz.test.ts` (integrity property with `media.setLibraryInfo`), `apps/mcp/test/sound-examples.test.ts` |
| P1-R2 | descriptors + judge, known answers (impulse peak ≤ 1 ms, decay, sine centroid/MIDI, white flatness ≈ 1, pink band shares) | `packages/audio-fx/src/analysis/sound-{descriptors,judge}.ts` | `packages/audio-fx/test/sound-{descriptors,judge,oracle,review-fixes}.test.ts` (oracle against ffmpeg with `JASPER_REQUIRE_ORACLES=1`) |
| P1-R3 | Jasper Synth: deterministic (byte hash), every variant accepted by the judge for its type | `packages/audio-fx/src/synth/*` | `packages/audio-fx/test/sound-synth.test.ts` (152 variants) |
| P1-R4 | Kenney CC0 kit, 40–60 sounds, ≤ 8 MB, sidecars, ATTRIBUTION rows, manifest with pack URL + sha256 | `apps/engine/sounds/starter/` (60 sounds, 0.72 MB; 18 of 19 types, `key` only from Jasper Synth: Kenney has no keyboard recording) | `apps/engine/test/sounds-starter-kit.test.ts`, `scripts/sounds/make-sidecars.test.mjs`, `pnpm lint` (check-assets) |
| P1-R5 | engine library: appdir paths, atomic index, `sound-index` job, routes (search, get, audio, visual, register, roots, index), capabilities, folder roots with a licence declaration, path validation (D-47) | `apps/engine/src/sounds/*`, `routes/sounds.ts`, `packages/api/src/sounds.ts`, `packages/config` | `apps/engine/test/sounds-{unit,routes,review,search,provenance}.test.ts`, `fuzz-http.test.ts` (the sound routes), `packages/config/test`, `packages/engine-client/test` |
| P1-R6 | MCP: status, search, get, view (PNG), import, credits, add/remove folder (approval), rescan; `SOUND_GUIDE`, README, conventions | `apps/mcp/src/tools/sound.ts`, `sound-sheet.ts` | `apps/mcp/test/sound.test.ts` (real engine), `sound-sheet.test.ts`, `sound-guide.test.ts` (the spec §2.10 phrases), `readme-tools.test.ts`, `conventions.test.ts` |
| P1-R7 | Sound Library panel: search, chips, Refine, licence filter, waveform rows with peak tick, Space / Auto-play / Loop, insert peak-aligned at the playhead, drag with the new MIME and peak-edge snapping, favourites / recents / used, empty state, Preferences ▸ Sound Library (folders), i18n | `apps/web/src/sound/*`, `panels/soundLibrary/*`, `panels/timeline/model/sound-drop*.ts`, Sound Design workspace (`shell/workspaces/definitions.ts`) | `apps/web/test/sound-{library-model,insert,audition,library-panel,library-review,review-misc}.test.*`, `keymap.test.ts`, `polish-menu-wiring.test.ts`, `node scripts/i18n.mjs --check`, `e2e/sound-library.spec.ts` (3 tests) |
| P1-R8 | credits: `list_sound_credits`, File ▸ Export ▸ Sound Credits… (md / txt / csv) | `packages/project/src/sound/credits.ts`, `apps/web/src/sound/dialogs.tsx`, MCP | `sound-credits.test.ts`, `sound-library-panel.test.tsx`, `apps/mcp/test/sound.test.ts`, e2e (download of `…-sound-credits.md`) |
| Done when | offline, a user and an agent each search the kit, see descriptors and a contact sheet, audition, insert peak-aligned at the playhead as one undo step; provenance, credits, preview and export | — | e2e (user) and the MCP run below (agent), both measured on the export with ffmpeg |

Nothing in Phase 1 was missing. Added because the spec lists it with the panel: the **Sound Design workspace** (9th
built-in, Alt+Shift+9: Sound Library / Project / Media Browser / Markers / History / Jobs, Program + Timeline,
Essential Sound / Properties / mixers; Review and Sound Check join it in their phases). Not in Phase 1 by the spec's
own split: In Context audition, cues, Replace mode, the Palette collection, the Properties "Sound" section.

#### Cross-surface fixes and decisions

- **One set of insert rules** (`packages/project/src/sound/insert.ts`, used by the panel, the drop and MCP
  `insert_sound`): `resolveSoundAlign(types, request)` (`auto` → the first known type's `defaultAlign`: risers and
  reverses by their end, UI by its start = the onset, else the peak; Alt-drop forces `start`); `soundTimingOf` (the
  descriptors of the media actually placed, i.e. its provenance); `planSoundInsert` (`peakAlignedStart` with
  `clampStart`, the clip `[In, end of media)`); `chooseSoundTrack`. Before, the web always aligned the peak, read the
  library entry's timing, and its `start` meant the file's first sample; MCP aligned by type and `start` meant the onset.
- **Track choice follows spec §2.3 / §2.7**: the drop track (explicit) when free, else a targeted track, else a free
  **unmuted** "SFX…" track, else a new "SFX n". Both surfaces used to fall back to any free audio track (a sound could
  land on a dialogue or music track, or a muted one).
- **One clip, never other tracks** (found in review, high): both inserts sent `clip.place` without `audioMapping`, so a
  Project item with Modify ▸ Audio Channels routing made several clips and the extra ones went over other tracks in
  overwrite mode (reproduced: dialogue on A2 cut at the insert). Both now pass `audioMapping: 'stereo'`.
- **Sample-exact placement (lead silence).** `SoundService.register` copies a sound whose quiet head is shorter than
  `LIBRARY_LEAD_SILENCE_SEC` = 50 ms (≥ one frame at 23.976 fps, the lowest sequence rate; room for ±2 % varispeed) and
  which is at most `LIBRARY_PAD_MAX_SECONDS` = 120 s long into managed media as WAV with `ceil(0.05 · rate)` samples
  of digital silence in front (`apps/engine/src/sounds/pad.ts`: ffmpeg `adelay=<n>S`, `pcm_f32le` — every 16/24-bit and
  float decoder output exactly — or the source's own `pcm_s32le` / `pcm_f64le`, `-bitexact`, no metadata, so the same
  file always gives the same bytes and repeated registrations dedupe). The provenance's descriptors then describe the
  copy (time points + lead) and `leadSilenceSec` records it (schema field added to `LibraryProvenanceSchema`, repaired
  field by field). Placement takes the sub-frame rest from that silence, so `errorFlicks` is 0 for every library sound.
  Sounds with a quiet head ≥ 50 ms are registered as before (copy, or in place for folders). **Folder sounds** that
  need the lead are also copied into managed media (decision: exact placement over referencing in place; the
  provenance keeps `source {type: folder, rootId, relPath}`; SFX are small; the project no longer depends on the folder
  for them). Rejected: the media derivation mechanism (`derivation` is for processed versions of project media with a
  `NativeRecipe`; the library file is not project media), and a ≤ 1-frame tolerance.
- **Schema v7** (D-50, `docs/project-files.md`): `v6→v7` is a version bump only. Reason: a v6 build would keep the new
  fields, but editing Essential Sound Pan there writes an absolute pan under the `panOffset` marker, which v7 reads as
  an offset (keyframes would shift) — AGENTS.md §0.4 asks for a bump when an older build would misread new data. Older
  files keep being read by the C4 repair (`migrate-essential-pan`) and the Essential Sound commands; fixture
  `schema-v7.jasper` (generated through the commands: a library media with `leadSilenceSec`, an SFX clip with
  `panOffset`). Later sound-design phases add their optional fields to v7 until `feat/sound-design` merges to `main`.
- **Review fixes in the pure model** (`packages/project/test/sound-review-fixes.test.ts`, `packages/audio-fx/test/
  sound-review-fixes.test.ts`, `apps/engine/test/sounds-provenance.test.ts`; each failed before): licence ids must be
  whole SPDX ids (`"CC-BY-4.0 AND LicenseRef-Proprietary"` was commercial-safe CC BY); provenance repair dropped unknown
  fields named like `Object` members; Markdown credits linked any URL scheme (`javascript:`) and did not escape `[ ]`;
  `media.register` accepted provenance on an image or with descriptors past the end (now `E_INVALID_PARAM` like
  `media.setLibraryInfo`); a sub-normal signal measured −900 LUFS and ±3.4e38 samples +730 dBTP, out of the provenance
  schema, so registering such a sound was a 500 (loudness under −120 is now null, levels are capped at +200, and
  `provenanceOf` keeps old cached values inside the schema; register checks the provenance before copying anything);
  `judgeSound(null)` threw; `import_sounds` did not retry a revision conflict; `SOUND_GUIDE` lacked the hero density,
  alternates, "propose, don't apply", one family per type and "sync by structure" sentences of spec §2.10.
- **Spanish type chips**: "Key", "Reverse" and "Pop" shared catalogue keys with other features ("Incrustación"…); they
  now have `[sound type]` keys ("Tecla", "Inverso", "Pop").
- **Slow tests** (asked by the orchestrator): `sound-synth.test.ts` "every variant … passes the judge" made one
  `expect()` per sample (≈ 140 000 per variant): measured 7.0 s of the 7.6 s per boom variant were the expects
  (render 0.23 s, analysis 0.43 s; scratch test, load ≈ 30). Now one assertion per sound with the same checks (every
  sample finite, peak −1 dBFS): the 19 tests took 400 s in total (boom 87.6 s, shimmer 46.7 s; load 47) before and 46 s
  after (longest shimmer 20 s, its render is slow; load 34). `registry.test.ts` "extreme settings…" ran 12 s of tail × 2
  settings × every effect in one test (88.9 s at load 47, over the 120 s timeout at load 110–144): now one test per
  effect, same coverage (longest 18.7 s). Same command both times: `pnpm vitest run packages/audio-fx/test/sound-synth.test.ts
  packages/audio-fx/test/registry.test.ts --maxWorkers=2 --reporter=verbose` (6 min 50 s → 2 min 7 s wall).
- **Search over thousands of sounds**: see "Review fixes (P1 verification)" item 10 under WP1.2 (5 000 sounds: 7–15 ms
  min at load ≈ 28–43, was 416–558 ms). The benchmark asserts < 50 ms when the load per core is ≤ 2 and scales the limit
  with the load above that (a fixed 50 ms fails on this shared host at load 135–144, where the same code measured 20–59
  ms); the old code fails it at any load. Accepted by the integrator.
- **Snapping** keeps the timeline's TL-453 rule (nearest target wins, priority breaks ties) rather than spec §2.7's
  strict order; recorded under WP1.4's review fixes.

#### Real app (measured)

- Built stack (`pnpm build`, then `E2E_PORT=49101 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-library.spec.ts`,
  load 31–48): **3 passed**. (1) search, audition (aria-live, Mix meters live, no history entry), Enter at frame 45:
  the first "crunch" result is "Reverse crunch", aligned by its **end** on frame 45 to ≤ 2 flicks (the old test assumed
  the peak), one undo step, undo, drag onto A1 with the end snapping to the playhead (ghost "end → 00;00;01;15 /
  Reverse crunch → A1"), credits Markdown download. (2) In the Sound Design workspace, five kit sounds inserted from the
  panel at frames 30 / 75 / 120 / 170 / 290 (29.97 fps): Heavy metal hit, Punch, Air whoosh low (peak), Confirm blip
  (start), Computer hum riser (end); all on a new "SFX 1" (A4), A1–A3 untouched; native export (MP4/AAC); the export's
  left channel decoded with ffmpeg and each kit file located by normalised cross-correlation over 100 ms next to its
  aligned point: **error 0 samples for all five** (r ≥ 0.9999), lead 0.05 s on the four short sounds, 0 on the riser.
  (3) Preferences ▸ Sound Library: a folder added by path (not declared), indexed; its "door slam e2e" (a hit that
  starts at once) is hidden by Commercial-safe and found with it off ("Yours?" badge), inserted at frame 20 exactly
  (`leadSilenceSec` 0.05, a managed copy).
- Screenshots looked at (`test-results/e2e-sound-library/`): the Sound Design workspace with the five clips on SFX 1
  and the toasts "Added … to A4 · peak at …"; the drag ghost with the end tick on the playhead; the credits dialog; the
  Preferences page with the folder, its licence select and "Folders saved. Indexing them"; the panel listing the folder
  sound with the warning badge.
- Agent path: built engine (`node apps/engine/dist/engine.mjs --port 49103`, fresh appdir, one synth seed) and
  jasper-mcp from source over stdio (scratch client): `sound_library_status` 79 sounds (60 kit + 19 synth),
  `rescan_sound_library {wait}`, `search_sounds {types: [hit], contactSheet}` 8 hits (125–210 ms per call through MCP),
  `get_sound` and `view_sounds` PNGs looked at (waveform over spectrogram, red peak line on each transient, the riser's
  peak at its end, dashed decay lines), a 23.976 fps project, `insert_sound` of Heavy metal hit / Punch (peak),
  Confirm blip (start), Thruster riser (end) at frames 24 / 73 / 121 / 260 → `errorFlicks` 0 each, all on a new SFX 1;
  `list_sound_credits` 4 rows; `start_export {engine: native}`; measured on the export as above: **0 samples** for all
  four. (A first pass of the measurement used 20 ms windows and put the tonal UI blip one period, 245 samples, late:
  AAC smears its sharp attack, so a later period of the steady tone matched better; the whole-sound correlation and
  the 100 ms window both give 0.)

#### Gate

Shared host, 16 cores; other agents' load stated per run.

- `pnpm notices --check`: current (150 packages, 31 ported source records).
- `pnpm verify` on the merged branch (load 21 → 84): `pnpm lint` passed (Biome, tokens, anime, layers, assets);
  `pnpm typecheck` passed (every workspace project); `pnpm test`: 611 files, **5 757 passed, 5 failed**, 392 skipped.
  The five: four timeouts under load (`expressions` "recursion and memory limits" 5 s, `sound-library-model` waveform
  property 15 s, `audio-fx-preview` "every audio effect" 5 s, `check-layers` "the repository passes" 120 s) and
  `processing-steps` "dejudder" (encoder exited, out of resources). Rerun alone (`--maxWorkers=1`, load 50–82):
  waveform 17/17, processing-steps 16/16 (990 s), audio-fx-preview 2/2, check-layers 11/11 (108 s), expressions
  failed twice more (9.9 s, 7.9 s for its 5 s limit).
- `pnpm build` (the step `verify` did not reach): passed, twice (before and after the last code change).
- Second full `pnpm test` (load 7 → 80, 20 min): 611 files, **5 764 passed, 2 failed** (`audio-fx-preview` 5 s and
  `check-layers` 120 s timeouts again), 388 skipped.
- Fixed so the gate does not depend on the load (coverage unchanged, every assertion kept): the waveform property and
  the synth / registry tests (above) make one assertion per run instead of one per sample; `audio-fx-preview` is one
  test per effect (61 tests, 2.9 s in all alone); the expression memory-limit test (filling the sandbox to its limit
  takes 8–10 s under load) has a 60 s timeout; the repository layer check (108 s alone) has 600 s. Each rerun alone
  after the change: 17/17, 28/28, 61/61, 11/11.
- Phase 1 suites after the merges (`pnpm vitest run apps/engine/test/sounds-*.test.ts packages/project/test/sound-*.test.ts
  packages/audio-fx/test/sound-*.test.ts apps/mcp/test/sound*.test.ts packages/project/test/schema-history.test.ts
  --maxWorkers=2`, load 56–98): **25 files, 268 tests passed**. `pnpm vitest run --project @jasper/project`
  (before the helper merges, load 60–90): 1 771 / 1 772; the one failure is the pre-existing 20 s budget of
  `three-d-hostile.test.ts` (20 000 glTF instances: 20.7 s alone at load 92; it passed in both full runs above).
- `node scripts/i18n.mjs --check`: es.json covers all 8 836 strings.

#### Limits and notes for the next packages

- Lead-silence copies are WAV (f32 for lossy sources): a 3 s stereo kit sound is ≈ 1.2 MB of managed media instead of
  ≈ 40 kB of Ogg. Sounds over 120 s (beds) are not padded and keep the ≤ 1-frame rule for peak / end alignment.
- Registering the same library sound in a project that already holds its unpadded copy (registered before this
  change) adds the padded copy as a new media; the old clips keep working with their own provenance.
- `soundDesign.place` (Phase 2) should call `planSoundInsert` / `chooseSoundTrack` (or move them into its handler) so
  the command, the panel and MCP stay one implementation.
- ~~The history label "Add Sound <title>" and placement refusals from `@jasper/project` are English in the editor.~~
  Fixed in "Phase 2 verification: agent surfaces" below (model-string templates).
- Workspace names (all built-ins, not only Sound Design) are not in the i18n catalogue (pre-existing).

## Phase 2: cues and placement

### WP2.1 cue model and placement commands

Scope: spec 12 §2.2 (cue schema, `AudioClip.sfx`, repair), §2.3 (placement: layers, rotation, variation, pitch, pan,
auto tracks), §2.9 (commands), P2-R1, P2-R2, P2-R4, P2-R5 (model / command part). Files (all `packages/project` unless
said): `src/schema/sound.ts` (schemas, lenient readers), `src/sound/anchor.ts` (`resolveCueAnchor`, integrated first,
alone, at `9032437d` so the cue deriver could build on it), `src/sound/repair.ts` (INV-SOUND / INV-SFX helpers,
`repairSoundDesign`, `soundDesignNeedsRepair`, `remapSoundDesign`), `src/sound/variant.ts` (`pickVariant`),
`src/sound/insert.ts` (`planSoundInsert` gained `rate` and `clampStart`), `src/sound/text-events.ts` (typewriter
timing shared with the deriver), `src/sound/cue-input.ts` (`cueInputFromDerived`), `src/commands/schemas/sound.ts`,
`src/commands/handlers/sound.ts`, `catalog.ts` (labels), `invariants.ts` (INV-SOUND per sequence, INV-SFX per clip,
the repair hook), `migrations.ts` (`loadProject` repairs when only soft references dangle), `commands/diff.ts` (cues
are entities of the diff), `handlers/structure.ts` (`sequence.duplicate` remaps cues), `ids.ts` (prefix `cue`).
Rewired: `apps/web/src/sound/insert.ts` and MCP `insert_sound` (`apps/mcp/src/tools/sound.ts`) commit through
`soundDesign.place`; `apps/mcp/src/examples.ts` (describe_commands examples); `apps/web/src/i18n/{en,es,model-strings}.json`
(8 History labels). Docs: `docs/project-files.md` (v7 optional fields). Tests: `packages/project/test/sound-{anchor,
cue-commands,design-place}.test.ts`, `fuzz.test.ts` (sound commands in AC-25), `apps/web/test/sound-insert.test.ts` (one
assertion), `apps/mcp/test/sound-examples.test.ts`, `apps/engine/test/sound-placement-export.test.ts`.

#### API (exported from `@jasper/project`)

```ts
// schema/sound.ts (also re-exported by schema/index.ts)
const CUE_KINDS /* cut transition move land appear exit emphasis reveal beat manual silence */, CUE_WEIGHTS, CUE_SOURCES,
  CUE_ALIGNS, SFX_ROLES /* hero support layer */, SOUND_DENSITIES, SOUND_DELIVERIES, SOUND_DESIGN_LIMITS;
const CueAnchorSchema; type CueAnchor; const CUE_ANCHOR_TYPES;   // the 9 variants of spec 12 §2.2 (looseObjects)
//   edit {trackId, outgoingClipId, incomingClipId} | transition {transitionId}
//   | keyframe {clipId, property /* path in the clip: transform.position, opacity, effects.<fxId>.params.<name> */,
//              keyframeId?, event: peak-speed|settle|start|end}
//   | text {clipId, side: in|out, unit? /* 0-based typed unit of a typewriter */} | mg {clipId, event: intro-end|outro-start}
//   | clip {clipId, edge: start|end} | scene {mediaId, mediaSec} | beat {clipId, beatIndex, mediaSec?} | marker {markerId}
const soundCueFields;      // the caller's cue fields (= DerivedCue ⊂ SoundCue): frame, label?, kind, weight, types?,
                           // soundIds?, align?, pan? (−100…100 | 'auto'), pitchSt? (±12), stopBefore?, build?, anchor?,
                           // source, confidence?, reason?, muted?, window? {start, end}
const SoundCueSchema;      // {id: 'cue_…', ...soundCueFields, placedClipIds?}
const SoundDesignSettingsSchema; // {delivery, density, sfxTrackIds, roomBus, seed, agentsMayApply?, palette?}
const SoundCheckSummarySchema;   // {mixHash, verdict, counts, at}
const SoundDesignSchema;         // {cues: Record<id, SoundCue>, settings?, lastCheck?}
const SfxPlacementSchema, ClipSfxSchema; // {cueId|null, soundId|null, layer 0…5, role, alternatives? ≤16,
                                         //  placement {align, peakFlicks, errorFlicks}}
const DEFAULT_SOUND_DESIGN_SETTINGS;
function readSoundCue(raw, key?): SoundCue | null;   function readSoundDesign(raw): SoundDesign | null;
function readSoundDesignSettings(raw): SoundDesignSettings; function readClipSfx(raw): ClipSfx | null;
function soundDesignSettingsOf(seq): SoundDesignSettings;   // read-time defaults
function soundDesignIssue(raw): string | null; function clipSfxIssue(raw): string | null;

// sound/anchor.ts
function resolveCueAnchor(doc, seq, anchor, opts?: {mgTemplates?}): number | null;  // never throws
function cueAnchorTargetExists(doc, seq, anchor): boolean;  function cueAnchorRefs(anchor): string[];
function anchorAnimatable(clip, property): Animatable<unknown> | null;
function textUnitCount(text, 'char'|'word'): number;                        // sound/text-events.ts, re-exported
function typewriterScheduleMs(units, durationMs, params): {start, slot};   // = @jasper/motion typewriterSchedule
// sound/text-events.ts also: typewriterOffsets(units, windowFrames, fps, params, side) (the deriver's, exported by cues)
const MG_REFERENCE_FPS = 30;

// sound/cue-input.ts
function cueInputFromDerived(cue: DerivedCue, ref?: string): soundCue.add cue;  // stored fields only, within limits

// sound/repair.ts
function sequenceSoundDesignIssue(seq): string | null;   function clipSfxProblem(clip): string | null;
function soundCuesOf(seq): SoundCue[];   function soundDesignNeedsRepair(doc): boolean;
function repairSoundDesign(doc, ids, note): void;   function remapSoundDesign(seq, maps, newCueId): void;

// sound/variant.ts
const ROTATION_TOP_N = 4, VARIATION_RATE = 0.02, VARIATION_GAIN_DB = 1;
function pickVariant(candidates: string[] /* ranked */, ctx: {seed, cueId, sequenceId?, layer?, recentSoundIds?, topN?})
  : {soundId, index, rate /* 0.98…1.02 */, gainDb /* −1…+1 */, repeated} | null;
function variationOf({seed, cueId, sequenceId?, layer?}): {rate, gainDb};   function hash32(s): number;

// commands/handlers/sound.ts
function pitchPlan(pitchSt, rate): {rate, shifterSt};  const VARISPEED_PITCH_MAX_ST = 3, PITCH_SHIFTER_EFFECT_ID;
```

Commands (owner `sound-design`; History labels in brackets, Spanish in es.json):

| Command | Arguments | Result | Refusals |
|---|---|---|---|
| `soundCue.add` [Add Sound Cues] | `sequenceId?`, `cues[1…2000]` of `soundCueFields` + `id?` (unused `cue_…`) + `ref?` | `{sequenceId, cueIds}`, refs defined | unknown type `E_INVALID_PARAM`; anchor target missing `E_NOT_FOUND`; bad / used id `E_INVALID_PARAM`; > 20 000 cues in the sequence `E_LIMIT`; shapes `E_SCHEMA` |
| `soundCue.update` [Edit Sound Cue] | `cueId`, any cue field (optional ones take `null` to clear), `moveClips?` (default true: a new `frame` moves the filling clips by the same delta) | `{cueId, frame, movedClipIds}` | `E_NOT_FOUND`; `E_INVALID_PARAM` (type, before frame 0); `E_OVERLAP`, `E_TRACK_LOCKED` (moving clips) |
| `soundCue.remove` [Delete Sound Cues] | `cueIds[]`, `withClips?` | `{removed, liftedClipIds}`; kept clips get `sfx.cueId: null` | `E_NOT_FOUND`; `E_TRACK_LOCKED` (withClips) |
| `soundCue.resync` [Resync Sound Cues] | `sequenceId?`, `cueIds?` (default every anchored cue) | `{moved: [{cueId, from, to, clipIds}], unresolved, unanchored}` | whole transaction refused on `E_OVERLAP`, `E_TRACK_LOCKED`, before frame 0 `E_INVALID_PARAM`; unknown cue `E_NOT_FOUND` |
| `soundDesign.place` [Place Sound] | `sequenceId?`, `cueId` xor `frame`, `layers[1…6]` `{mediaId, track? ('auto' default \| A3 \| id \| $ref), align? (auto\|peak\|start\|end), gainDb?, rate? (0.25…4), pitchSt? (±12), pan? (number \| {keyframes[2…32] {offset (frames from the cue), value}}), role?, ref?}`, `group?` (default true), `alternatives?` (≤ 16 sound ids), `preferTrackIds?`, `clampStart?` | `{sequenceId, cueId, frame, groupId, clips: [{clipId, mediaId, soundId, trackId, trackCreated, layer, role, align, start, duration, sourceInFlicks, alignFlicks, errorFlicks, rate, pitchSt, trimmedHeadSec}]}` | neither or both of cueId / frame, start before 0 without `clampStart`, no peak descriptor with `align: peak`, media without sound, > 6 layers on a cue, bad pan keyframes: `E_INVALID_PARAM`; media / cue / track missing `E_NOT_FOUND`; explicit video track `E_TRACK_KIND`; locked `E_TRACK_LOCKED`; busy explicit track `E_OVERLAP` (with the blocking clips) |
| `soundDesign.swap` [Swap Sound] | `clipId`, `mediaId`, `align?` | `{clipId, mediaId, soundId, start, duration, sourceInFlicks, errorFlicks, alignedFrame, align}` | `E_NOT_FOUND`; not audio / reversed / no peak `E_INVALID_PARAM`; does not fit on its track `E_OVERLAP`; `E_TRACK_LOCKED` |
| `soundDesign.setPalette` [Sound Palette] | `sequenceId?`, `soundIds` (≤ 500, `snd_` + 16 hex), `mode?` replace\|add\|remove | `{sequenceId, palette}` | `E_SCHEMA`; > 500 `E_LIMIT`; `E_NOT_FOUND` (sequence) |
| `soundDesign.setSettings` [Sound Design Settings] | `sequenceId?`, `delivery?`, `density?`, `sfxTrackIds?` (A2 / ids), `roomBus?` (S1 / id / null), `seed?`, `agentsMayApply?` | `{sequenceId, settings}` | `E_NOT_FOUND`; non-audio SFX track `E_TRACK_KIND`; `E_SCHEMA` |

#### How placement works (`soundDesign.place`)

Per layer: the media's provenance (`MediaAsset.library`) gives its types and descriptors (the registered file's, lead
silence included); the alignment is the layer's, else the cue's `align`, else the type's `defaultAlign`
(`resolveSoundAlign`); the pitch is the layer's, else the cue's `pitchSt`: |st| ≤ 3 → clip speed `rate · 2^(st/12)`
with `maintainPitch: false` (the aligned point is placed in sequence time `offset ÷ rate`), larger → a
`jasper.audio.pitch-shifter` effect (semitones + cents) at speed `rate`. `planSoundInsert` (`peakAlignedStart`) gives
start, In point and length; the track is the explicit one (checked: audio, unlocked, free over the span) or `auto`:
the first free `preferTrackIds` track, then the settings' `sfxTrackIds`, then a free unmuted "SFX…" track, else
`track.add` "SFX n" (`chooseSoundTrack`). The clip is made by `placeSource` (the `clip.place` machinery, `fitted`
range, one stereo clip, overwrite mode on a span checked free, so nothing is ever overwritten), then
`essentialSound.setType sfx`, `gainDb`, pan (static value, or keyframes in content time at `cue + offset` frames),
the pitch shifter, and `sfx` = {cueId, soundId, layer, role, alternatives (first layer), placement {align, peakFlicks,
errorFlicks}}. Several clips of one cue (new and earlier layers) are grouped with `clip.group`; the cue's
`placedClipIds` and `soundIds` follow. Default roles: the first layer of a hero cue `hero`, of other cues `support`,
further layers `layer`. Rotation and variation are pure helpers the plan job (P3) calls before placing:
`pickVariant` gives the sound and a `rate` / `gainDb` the layer then carries.

#### Decisions

- **Storage**: `Sequence.soundDesign` and `AudioClip.sfx` are `z.custom(() => true)` in the document schema (like
  `MediaAsset.library`): a damaged value never fails a load; INV-SOUND / INV-SFX check them; repair reads them
  leniently. Enums for kind, weight, source, align, role (the spec's closed lists); sound types are lower-case words
  (a newer build's type survives), but commands accept only known taxonomy ids.
- **Soft references** (anchors, `placedClipIds`, `sfx.cueId`) are not invariants: a user deleting a clip or a
  transition must never get `E_INVARIANT` because a cue pointed at it. Readers skip dangling ids; `repairDocument`
  tidies them on load and `loadProject` runs the repair when only those dangle (`soundDesignNeedsRepair`), so the
  user sees a repair line ("the cut the cue followed is gone: it stays at frame 60").
- **Cue ids** use the new prefix `cue_` and are unique in the document (commands check every sequence;
  `sequence.duplicate` gives the copy new ids and maps anchors, placed clips and the clips' links; repair renames ids
  two sequences share). They are not claimed under INV-001 (that index is the per-entity incremental check's), so a
  transaction changing `soundDesign` takes the full invariant check (`sequence fields` fallback, ≈ 20 ms on 1 000 clips).
- **Diff**: cues are entities of `diffDocuments` (created / changed / deleted ids); settings or last-check changes
  mark the sequence changed — the fast-forward rule (S01:AGT-010) sees cue conflicts.
- **`sfx.soundId` is nullable** (deviation, additive): spec 12 §2.3 keeps `errorFlicks` for "media placed from other
  sources (project audio)", which has no sound id. Such media are placed by `start` / `end` (or with descriptors set
  by `media.setLibraryInfo`); `align: peak` without a peak descriptor is refused.
- **`clampStart`** (default false = the spec's `start < 0 → E_INVALID_PARAM`): the Sound Library insert and MCP
  `insert_sound` pass `true` (their Phase 1 behaviour: start at 0, head trimmed, aligned point exact).
- **Anchor resolution** (no published reference): `edit` = the incoming clip's first frame (else the outgoing
  clip's end: the cut moves with the clip after it); `transition` = `start + ⌊duration/2⌋` of its stored span
  (`transitionStartFrame`); `mg` intro/outro frames are at 30 fps and compressed like `animeTemplateTiming`; `scene` /
  `beat` map a media time through the clip (time remaps and holds by scanning frames, ≤ 50 000); markers include clip
  markers; a frame outside the clip (± half a frame) or the sequence is null. **Keyframe and text-unit anchors resolve
  through the deriver** (`derivedAnchorFrame`: the clip's keyframes / text cues derived again with `clipMotionCues` /
  `textClipCueCandidates`, cached per clip object, and the event whose anchor matches by clip, property, key and
  event, or side and unit): motion events then use the deriver's combined position + scale + rotation speed and its
  landing at the turnaround, Range Selector reveals its per-frame selection, so a derived cue always resolves to its own
  frame and follows its clip. Without a matching derived event (a cue the user anchored by hand, an edited motion) the
  property alone decides: `start` / `end` = the run's first / last key (or `keyframeId`), `peak-speed` = the middle of
  the run of frames with the largest per-frame change, `settle` = an overshoot's turnaround along the peak's direction
  (≥ 2 % of the peak speed backwards), else the first frame within 1 % of the travel from the rest value. Typewriter
  units use the deriver's `typewriterOffsets` (In `⌈t/frame⌉`, Out `N − ⌈t/frame⌉`), units = non-space graphemes or
  words (the renderer counts layout segments: exotic scripts could differ).
- **Review fixes from WP2.2** (each with a regression test in `sound-anchor.test.ts` "derived anchors resolve back to
  their frame", all four failing on the resolver integrated at `9032437d`): typewriter Out units were one frame late
  when `t/frame` was not whole (`⌈N − t/frame⌉` → `N − ⌈t/frame⌉`); Range Selector unit anchors resolved to null; a
  `peak-speed` of a position + scale + rotation move was taken on the named property alone; an overshoot without a key
  at its extreme settled at the first arrival instead of the turnaround. `DerivedCue.panSweep` is a stored cue field
  (`soundCue.add` / `update`, cleared with null) and placement writes it as two pan keyframes over the cue's window (±
  0.2 s around the cue without one; a key before the media start is held at the media start) unless the layer gives a
  pan. `cueInputFromDerived` maps a derived cue to `soundCue.add` input (the Phase 2 fixture's cues are all accepted and
  a resync right after moves none: `sound-cue-commands.test.ts`).
- **Rotation**: least recently used among the top 4 (ties by rank), skipping the last-used sound when another exists;
  variation from FNV-1a(sequence | cue | seed | layer) → mulberry32: rate 1 ± 0.02 (0.0001 steps), gain ± 1 dB
  (0.01 dB steps).
- **Swap** keeps the aligned frame (computed from the clip: start, In, speed, `placement`), track, speed, gain, pan,
  effects, group, link, role and cue; keyframes and clip markers keep their sequence times (content times shifted by
  the In / start change); the cue's `soundIds[layer]` follows. It refuses rather than moving to another track.
- **Resync / update move clips all-or-nothing** on their own tracks (never overwrite; a clip in two cues moves once).

#### Verified (measured, this branch)

Shared host, 16 cores, load average 31–58 during the runs (other agents).

- `pnpm vitest run packages/project/test/sound-design-place.test.ts packages/project/test/sound-cue-commands.test.ts
  packages/project/test/sound-anchor.test.ts --maxWorkers=2`: 13 + 15 + 13 passed. Placement: peak exact to ≤ 1 flick
  with `errorFlicks` 0 for padded sounds; a 150-run property over the 8 sequence rates, cue frames 60…5000, peaks at any
  sample position (48 kHz) and pitch −2 / 0 / +1 / +3 st (`errorFlicks` 0 at rate 1, ≤ 1 flick with varispeed);
  layers on separate SFX tracks, grouped, cue links both ways; auto / preferred / settings tracks; every refusal
  (`E_NOT_FOUND`, `E_INVALID_PARAM`, `E_TRACK_KIND`, `E_TRACK_LOCKED`, `E_OVERLAP`, `E_SCHEMA`, `E_LIMIT`) with the
  document unchanged; undo (the before document untouched) and redo (same document up to fresh ids) for place, swap,
  add, update, remove, resync, palette, settings; pitch shifter vs varispeed; pan static / keyframes / `panSweep`;
  `pickVariant` round robin and a 500-run determinism / range property; repair of unreadable data, dangling anchors,
  pruned clips, unlinked clips, shared cue ids, idempotence, and a 300-run property of arbitrary `soundDesign` / `sfx`
  values through `loadProject` (never throws, no issue left, nothing more to repair); the transaction diff; every cue
  `deriveCues` gives on the Phase 2 fixture accepted by `soundCue.add` through `cueInputFromDerived` and unmoved by a
  resync; the four review regressions (each failed on the previous resolver: run with `anchor.ts` of `9032437d`, 4
  failed / 9 passed).
- `pnpm vitest run packages/project/test/fuzz.test.ts`: AC-25 integrity property, 2 000 runs, now mixing `soundCue.add`
  (with clip / keyframe / null anchors), `soundDesign.place` (frame or cue, 1–3 layers, auto or A1–A4, pitch ±6,
  clampStart), `soundCue.update` / `remove` / `resync` and `soundDesign.swap` into the random edits: passed, with more
  than 200 accepted transactions carrying sound commands (asserted).
- `pnpm vitest run apps/engine/test/sound-placement-export.test.ts --maxWorkers=1` (**P2-R4, measured on exported
  audio**): for 23.976, 25, 29.97 DF, 30, 50, 59.94 and 60 fps, four clicks (single samples 37 / 611 / 1203 / 1999
  samples into 0.5 s files, padded by the engine's `writePaddedSound` with 2 400 samples) placed with `soundCue.add` +
  `soundDesign.place` at cue frames ≈ 0.7 s apart, exported on the native path as 24-bit PCM in MOV, decoded with
  ffmpeg: **measured − expected click sample = 0 for all 28 clicks** (expected = round(cue frame × 48 000 × den /
  num)); 7 passed. Mutation check: with frame-accurate placement (`subFrame: false`) the 29.97 fps case fails (both the
  `errorFlicks` and the measured samples).
- `pnpm vitest run --project @jasper/project --maxWorkers=4` (after merging WP2.2): 149 files, 1 855 tests passed.
- `pnpm vitest run apps/mcp/test/sound.test.ts apps/mcp/test/sound-examples.test.ts apps/web/test/sound-insert.test.ts
  apps/web/test/i18n.test.ts apps/web/test/sound-library-panel.test.tsx apps/engine/test/sound-placement-export.test.ts
  apps/engine/test/sounds-provenance.test.ts --maxWorkers=2`: 7 files, 43 passed (`insert_sound` over a real engine
  now commits through `soundDesign.place`; the panel's insert records `AudioClip.sfx`; every describe_commands example
  of the new commands applies to a real project).
- `pnpm typecheck` (whole workspace), `pnpm lint` (Biome, tokens, anime, layers, assets), `node scripts/i18n.mjs
  --check` (es.json covers all 8 844 strings): pass. `check-layers` first found a runtime import cycle
  (`handlers/project.ts` imported `libraryDescriptorIssue` from `handlers/sound.ts`, which now imports the clip
  handlers): the helper moved to `sound/provenance.ts`.
- Real app after the insert rewire (`pnpm build`, then `E2E_PORT=49201 E2E_SKIP_BUILD=1 pnpm exec playwright test
  e2e/sound-library.spec.ts`): 3 passed. The panel's inserts now go through `soundDesign.place`; the native export of
  five kit sounds measured **0 samples of error** for each (peak, peak, peak, start, end; r ≥ 0.9998). Screenshots looked
  at (`test-results/e2e-sound-library/peaks-timeline.png`: five clips on the new "SFX 1" (A4), Essential Sound showing
  type SFX, toasts "Added … to A4 · peak at …"). The cue UI itself (Cue Seam, Fill, peak handle, menus) is P2-R7, not
  in this package.

#### Limits and notes for the next packages

- `pickVariant` is pure and not called by `soundDesign.place` itself: the plan job (P3) / Fill (P2-R7) picks the
  sound and passes the variant's `rate` and `gainDb` on the layer. "Recent" sounds are the caller's to gather (e.g.
  the `sfx.soundId`s of the cues before this one).
- Varispeed pitch + variation can exceed what 50 ms of lead silence absorbs: at 23.976 fps a +3 st shift with +2 %
  variation needs 50.6 ms, so such a layer can play up to one frame late (`errorFlicks` says so). At rate ≤ 1.19 it
  is exact.
- `pan: 'auto'` on a cue is not resolved here (no picture position in the model): the deriver should write the
  number; a cue with `'auto'` places centred unless the layer gives a pan.
- `stopBefore`, `build`, `muted`, `settings.roomBus`, `delivery`, `lastCheck` are stored and validated only (P4 / P5
  use them). `muted` does not silence placed clips.
- MCP cue tools (`find_sound_cues`, `set_sound_cues`, `place_sound`, `swap_sound`, `align_peak`) are P2-R6; agents can
  already use the commands through `apply_commands` / `describe_commands` (examples added).
- `sequence.duplicate` re-identifies clip markers and keyframes, so anchors to a clip marker or a keyframe id in the
  copy dangle (repaired to null on the next load).
- `soundCue.resync` resolves `mg` anchors with the transaction's template registry; without a template the cue is
  reported unresolved.
- A text `unit` anchor on a Range Selector resolves only to units the deriver keeps after thinning (≤ 12/s, ≤ 40 per
  clip); a hand-made anchor to a thinned-out unit resolves to null (the cue stays where it is).
- Keyframe anchors resolve by deriving the clip again (sampling up to 20 000 frames with `resolveLayerProps`), cached
  per clip object; a resync of hundreds of motion cues on many clips costs one derivation per clip.

### WP2.2 cue derivation

Scope: spec 12 §2.2 "Derivation" and P2-R3. `packages/project/src/sound/cues/` (pure, project layer: no engine, no
template code, no DOM): `types.ts` (API types), `util.ts` (context, pan, names), one file per source (`edits.ts`,
`transitions.ts`, `motion.ts` (keyframes + 3D cameras), `text.ts`, `mg.ts`, `edges.ts`, `markers.ts`), `budget.ts`
(merge, score, budgets) and `derive.ts` (`deriveCues`). Exported from `@jasper/project` and from the subpath
`@jasper/project/sound/cues` (not from `@jasper/project/sound`, which stays light: derivation pulls in the render
resolver). Tests: `test/sound-cues.test.ts` (33), `test/sound-cues-property.test.ts` (2 properties + performance),
fixtures in `test/sound-cues-fixtures.ts`.

#### API

```ts
deriveCues(doc, sequenceId, opts?: {
  range?: {start, end};                       // sequence frames [start, end); default the whole sequence
  sources?: Set<CueDeriveSource> | CueDeriveSource[];   // default all
  density?: 'sparse'|'balanced'|'rich';       // default balanced (CUE_DENSITIES = SOUND_DENSITIES)
  minGapFrames?: number; maxCues?: number;    // maxCues counts every cue, pattern members one each
  respectDialogue?: boolean;                  // default true
  mgTemplates?: MgTemplateRegistry;           // intro/outro lengths (injected like CommandContext.registries)
  extraCues?: ExtraCue[];                     // engine sources (scene, beat, pixel; P6), validated, then merged/budgeted
}) → { cues: DerivedCue[]; curves: {clipId, start, speed: Float32Array}[]; stats; warnings }

CueDeriveSource = 'edits'|'transitions'|'keyframes'|'text'|'mg'|'clipEdges'|'camera3d'|'markers'   // PROJECT_CUE_SOURCES
                | 'scene'|'beat'|'pixel'                                                        // ENGINE_CUE_SOURCES
DerivedCue = { key /* stable: source + anchor (+ unit) */, frame, kind: VisualKind|'manual', weight, types: SoundTypeId[],
  align, pan?: −60…60, panSweep?: {from, to}, anchor: CueAnchor /* WP2.1 schema type */, also?: CueAnchor[] /* merged */,
  confidence, reason, window?: {start, end}, source: 'derived'|'marker', from: CueDeriveSource, group?, score }
stats = { bySource: Record<source, {found, kept, merged, droppedByBudget, suppressedByDialogue}>,
  dropped: {rate, gap, maxCues, confidence, range}, heroesDemoted, found, kept }
warnings: W_SEQUENCE_NOT_FOUND | W_SOURCE_FAILED | W_SAMPLING_TRUNCATED | W_MG_REGISTRY_MISSING | W_EXTRA_CUE_INVALID
```

Helpers also exported (tested, reusable by the engine and the web): `transitionClass`, `transitionTravel`,
`transitionWindow`, `speedSegments`, `keyframeNear`, `thinPattern`, `typewriterOffsets`, `mgPhases`, `parseSfxRequest`,
`dialogueRanges`, `mergeCandidates`, `applyBudgets`, `DENSITY_BUDGETS`, the thresholds below.

The Suggest Cues… dialog's per-source counts are `stats.bySource[s].found` (events) and `.kept` (after merge and budget);
deselecting a source is `sources`. The engine route (P2-R6) must pass `mgTemplates` (it has the template registry) and,
from P6, `extraCues` for scene / beat / pixel; `sources` defaults to every source so extra cues are not dropped silently.

#### Sources (decisions; spec 12 gives the events, not the numbers)

- **edits**: on every shown video track (track `output !== false`), two enabled content clips that touch (`end ===
  start`), are not a through edit (`isThroughEdit`) and are not the two sides of a transition → `cut` at the incoming
  clip's first frame, types hit, thump, transition, glitch, click (an explicit list: the taxonomy's `typesForVisualKind
  ('cut')` puts glitch first, which is wrong as a default for a plain cut), support, confidence 0.5 (0.35 when either
  shot is under 1 s: montages rarely want a sound per cut). **Dialogue** (`respectDialogue`, default on): frames covered
  by the sequence transcript's words (`sequenceWords`, padded 0.25 s, pauses under 0.75 s bridged) and by Essential Sound
  `dialogue` clips on unmuted tracks whose media has no transcript words get no cut cue (`suppressedByDialogue`). Only
  cuts are silenced (spec: "Edit points … no sound in dialogue-dominant ranges"); VAD-based detection is P6-R3.
- **transitions**: video transitions on shown tracks. Frame = the visual centre `start + ⌊duration/2⌋` of the span
  (`transitionSpan` for two-sided transitions; fades sit inside their clip), window = the span. Class from the registry
  bin and id (`transitionClass`): Slide / Animation / 3D Motion / Page Peel / Transformers bins and whip/push/swish/spin…
  ids → `move` (whoosh when the span is ≥ 0.3 s, else swish; confidence 0.85); `zoom` (whoosh/riser, 0.8); Wipe / Iris /
  Sapphire Wipes → `wipe` (swish, 0.6); Grunge & Distort and glitch/pixel-mosh/static ids → `glitch` (glitch, zap; 0.7);
  Lights & Blurs → `light` (ambient shimmer, 0.35); everything else, unknown ids included → `dissolve` (ambient shimmer,
  0.2: the density's minimum confidence drops it in sparse and balanced, so plain dissolves stay silent unless the
  user asks for `rich`). Pan sweep for move/wipe classes from `direction` (westToEast → −60 → 60, eastToWest the reverse,
  diagonals by their horizontal part, north/south none) or an `angle` param (cos·60, none when |cos| < 0.25).
- **keyframes**: every enabled content clip with animated Motion (position, scale, scale width, rotation, anchor),
  Opacity or 3D Z position / X/Y rotation / orientation is sampled **per frame with `resolveLayerProps`** (with only its
  crop and corner-pin effects, which change the on-screen box) over the content-time span of its keyframes ± 1 frame
  (the whole clip when an expression is active; at most 20 000 frames, `W_SAMPLING_TRUNCATED`), clipped to the range
  ± 2 s. Speed per frame (screen diagonals per second) = |Δposition|/diagonal + **K_SCALE 0.6**·|Δ ln scale| +
  **K_ROT 1/270 per degree**·|Δrotation| + |ΔZ|/diagonal: doubling the scale ≈ moving 0.42 of the diagonal, a quarter
  turn ≈ a third of it (chosen so a 100→120 % scale over 0.5 s, a 200 px slide over 0.5 s on 1080p and a 45° turn over
  0.5 s all count as moves). The per-frame speeds are returned as `curves` (for the Cue Seam). Segments: runs above
  **MOVE_OFF 0.03** that reach **MOVE_ON 0.12**, at least 2 frames (a 1-frame jump is a hold key, not a move), joined
  across pauses of ≤ max(2 frames, 0.1 s) so an overshoot's turnaround stays one segment. Per segment, by the dominant
  component (largest summed contribution):
  - scale growing from ≤ 20 % to ≥ 50 % → `appear` (pop/ui/swish when ≤ 0.25 s, else whoosh/reverse/shimmer) on the
    key the growth reaches (else the first frame at 95 % of the final size); shrinking to ≤ 20 % → `exit` on the key it
    starts from;
  - scale out and back (end within 5 % of the start, swing ≥ 8 %, ≤ 1.2 s, with a reversal) → `emphasis` at the
    extreme (pop, ui, thump, hit);
  - otherwise `move` (whoosh when the segment is ≥ 0.3 s, else swish) in the **middle of the fastest stretch** (frames
    within 10⁻⁴ of the peak speed; a linear move: its middle), confidence 0.4 + 0.45·min(1, peak), pan = on-screen x
    of the layer's bounds (`pan:'auto'`, x/width → ±60), pan sweep from the start to the end position (when it moves
    ≥ 10 pan units);
  - and `land`: at the first reversal of the dominant velocity after the peak (overshoot; "bounce" when it reverses
    again), or at the stop when the last moving frame still has ≥ **ABRUPT_STOP 35 %** of the peak speed; a gentle
    ease-out gets no land (a soft settle is not an impact). Impact = √(on-screen area) × the highest speed in the 0.2 s
    before it: ≥ 0.5 → hit (hero when the layer covers ≥ 20 % of the frame), ≥ 0.15 → thump, else tap.
  - Opacity ramps from ≤ 5 % to ≥ 50 % → `appear` on the key the fade reaches (pop/ui/swish ≤ 0.25 s, else
    shimmer/reverse/whoosh); back to ≤ 5 % → `exit` (ambient) on the key it starts from.
- **camera3d**: enabled camera clips; a frame counts only while the camera is the active one (the topmost camera
  covering it, as `activeCameraClipAt`). Speed = |Δeye|/diagonal + K_ROT·(angle between view directions, degrees) +
  K_SCALE·|Δ ln zoom| from `rigFrameAt`; segments as above → `move` (support) at the middle of the fastest stretch;
  no land (a camera does not hit anything).
- **text**: `resolveTextAnimationWindows`. In → `appear` at the window's first frame, Out → `exit` where the Out motion
  starts; types by preset category (Slide: swish/whoosh/ui; Pop: pop/ui; Fade: ui/shimmer, low confidence; Blur and
  Tracking: whoosh/shimmer; Reveal: swish/ui; Rotate: swish; Drop: swish/tap/thump; unknown presets: ui/swish).
  **Typewriter** (both versions): one `key` per typed unit, at the frames the renderer shows them
  (`typewriterScheduleMs`; In: ⌈t/frame⌉, Out: the In timeline mirrored, the first typed unit staying to the window's
  end), units counted like `textUnitCount` (non-space graphemes or words). **AE-style animators**: every enabled Range
  Selector with animated Start / End / Offset is evaluated per frame (`rangeParams` + `rangeValue`, units from the text:
  characters, characters without spaces, words or explicit lines) and every frame where a unit's selection crosses
  50 % is a reveal step; the steps are `appear` when the animator hides what it selects (Opacity < 50 % or Scale < 20 %)
  and leaving the selection dominates, else `exit`. Patterns are thinned (`thinPattern`): repeats and frames closer than
  fps/12 to the previous kept one dropped (≤ 12 per second in every 1 s window), then at most 40 evenly spread; members
  share `group` and anchor `{type:'text', clipId, side, unit}`.
- **mg**: motion-graphic clips whose template the registry knows: where the intro settles → `land` (thump/hit/pop),
  where the outro starts → `exit` (swish/whoosh/reverse), both from `mgCuePhases` (`sound/cues/mg-phases.ts`, shared with
  `resolveCueAnchor`). Measured when the registry exposes the template's picture speed (`MgTemplateInfo.motionSpeed`:
  the fframes templates, from their SVG twins; confidence 0.8 / 0.6), else the declared lengths written at 30 fps
  (`MG_REFERENCE_FPS`), converted and compressed like `animeTemplateTiming` (intro anchored at content frame 0, outro at
  the content end; confidence 0.5 / 0.4). Details: "Phase 2 verification B: mg land / exit from the rendered motion".
  No registry or an unknown template → nothing, with `W_MG_REGISTRY_MISSING`. The model never imports `@jasper/mg-templates` (layer rule);
  composition (mg-bundle) clips carry no intro/outro data, so they only get clip-edge cues.
- **clipEdges**: graphics (still, text, shape, solid, motion graphic, composition, animated image) on V2 and above:
  start → `appear` (support, pop/swish/ui; text pop/ui; motion graphics whoosh/swish), end → `exit` (ambient). Skipped
  where another source describes the edge better: a transition at that edge, an In/Out text animation, an adjacent
  clip on the track (an edit), and animated Motion/Opacity when the keyframes source runs.
- **markers**: sequence markers whose name starts `sfx:` (for agent-note markers the comment too):
  `sfx: <type>[+<type>…]` (also `,`), names resolved by `resolveTypeNames` (ids and synonyms: `swoosh`, `sub drop`),
  unknown names listed in the reason, `kind:'manual'`, weight and align of the first type, confidence 1, `source:
  'marker'`, window = the marker's duration. Explicit: exempt from the minimum confidence, rate and gap budgets (not
  from `maxCues` or the hero spacing).

#### Merge, score, budgets

- Candidates within **2 frames** merge (clusters anchored on the earliest frame; two members of one pattern group never
  merge with each other). The primary is the heavier (hero > support > ambient, then explicit, confidence, size,
  earlier frame, key); it keeps its frame and anchor, the others' anchors go to `also` and their reasons are appended
  ("…; also Cut on V1: 'A' → 'B'"). Confidence and size become the cluster's maxima.
- Score = confidence × weight (hero 1, support 0.7, ambient 0.4) × size (0.5 + 0.5·√area; 1 for full-frame events)
  × novelty (1 / (1 + 0.5·n), n = earlier cues of the same kind and first type within 2 s).
- Budgets (`DENSITY_BUDGETS`), applied greedily from the best score (ties: earlier frame, then key):

  | Density | Min confidence | Heroes | Cues in any 1 s window |
  |---|---|---|---|
  | sparse | 0.4 | ≥ 3 s apart | ≤ 1 |
  | balanced | 0.3 | ≥ 2 s apart | ≤ 2 |
  | rich | 0.15 | ≥ 1.5 s apart | ≤ 3 |

  A hero too close to a kept hero is **demoted to support** (counted in `heroesDemoted`) rather than dropped, so two
  heroes are never closer than the spacing and never within 0.5 s (`HERO_MIN_SEC`). A pattern group is one unit: its
  whole span counts once in every window it touches, and it is kept or dropped as a whole. `minGapFrames` and `maxCues`
  (every cue counts) apply after. The minimum confidence per density is our addition: it is what keeps dissolves and
  fade-outs quiet in sparse/balanced without a source-specific rule.
- Output sorted by frame, then key; scores rounded to 10⁻⁴. Clips are visited in (start, track, id) order, so the
  stored order of `seq.clips` does not change the result (tested).
- `deriveCues` never throws: each source runs in its own try/catch (`W_SOURCE_FAILED` with the message; the others
  still run), engine cues are validated (`W_EXTRA_CUE_INVALID`), frames are integers clamped to the range and the
  sequence, and the output is capped at `MAX_DERIVED_CUES` (10 000).

#### Anchors (reconciled with WP2.1)

Anchors are the stored `CueAnchor` (`schema/sound.ts`, `DerivedCueAnchor = CueAnchor`) and are chosen so
`resolveCueAnchor` (`sound/anchor.ts`) finds the same frame again: keyframe anchors name **property paths**
(`transform.position`, `transform.scale`, `transform.rotation`, `threeD.positionZ`, `opacity`,
`camera.transform.position`, `camera.zoom`…), `peak-speed` / `settle` name the key that ends the segment (the resolver
reads the run ending at `keyframeId`), `start` / `end` the key itself, and the derived frame is that key's frame where
the event sits on a key (appear, exit, emphasis, fades). `test/sound-cues.test.ts` "anchors resolve back to the derived
frame" asserts `resolveCueAnchor(cue.anchor) === cue.frame` for every cue of the Phase 2 fixture and of a document with
pops, pulses, fades, abrupt stops and shrinks.

#### Verified (measured, this branch; shared host, 16 cores)

- `pnpm vitest run test/sound-cues.test.ts test/sound-cues-property.test.ts test/sound-anchor.test.ts --maxWorkers=2`
  (packages/project): 45 passed (33 + 3 + WP2.1's 9). On the Phase 2 fixture (cuts, a 20-frame push, a logo keyframed
  200 → 1010 → 960 px, a typewriter title, a 15/12-frame motion graphic, an `sfx: boom+swoosh` marker) every event is
  found with its anchor and reason: cut at 90 (`Cut on V1: 'Shot A' → 'Shot B'`), push at 180 (whoosh, window 170–190,
  sweep −60 → 60), logo move at 46 and land at 52 (`Position (200, 540)→(960, 540) ends (ease-out overshoot) on V2
  'Logo'`), 8 typewriter keys from 200 (≤ 12/s), mg land 345 / exit 408, the marker as a hero boom + whoosh at 250.
- Property (fast-check, 60 generated documents per run: 8 sequence rates, 1–3 tracks of video / still / text / camera /
  motion-graphic clips with random keyframes, text presets, transitions from the whole registry and markers; random
  density, range, `maxCues`, `minGapFrames`): never throws, no `W_SOURCE_FAILED`, frames integer and inside the range and
  sequence, sorted, deterministic (two runs JSON-equal), every 1 s window holds ≤ the density's cues (groups once),
  heroes spaced, `maxCues` / `minGapFrames` / minimum confidence hold. Fuzz (testkit `mutateJson` of two sequences, 300
  cases, with hostile options: NaN / strings / inverted ranges, junk sources and engine cues; plus whole-document
  garbage): never throws, frames stay inside the sequence, deterministic. `FUZZ=1 FUZZ_SEED=1|777|4242` (20× cases,
  before the anchor reconciliation) and `FUZZ=1 FUZZ_SEED=2026` (final code): passed.
- Performance: a 10-minute 30 fps sequence with **200 clips** (120 shots with a push or dissolve on every 4th edit, 40
  stills keyframed in position, scale and opacity, 40 typewriter + slide-out titles, 20 markers): 669 events found,
  614 kept (balanced). `deriveCues` best of 3: **212 ms** at load average 41 (runs 673 / 289 / 212 ms, the first one
  cold) and **65 ms** at load average 27 (83 / 73 / 65 ms); the test asserts best < 1 s.
- `pnpm vitest run --maxWorkers=3` in packages/project (after merging WP2.1): 147 files, 1823 tests passed.
  `pnpm typecheck` (whole workspace) and `pnpm lint` (Biome, tokens, anime, layers, assets): pass.

#### Limits and notes for the next packages

- **Fixed in WP2.1 (`61a0aaee`, see WP2.1 "Review fixes from WP2.2")** — resolveCueAnchor disagreements found here: (1) the Out side of a
  typewriter: the renderer's Out window seeks `(N − 1 − k)` frames, so the i-th deleted unit goes at `N − ⌈t/frame⌉`
  (this deriver); the resolver computes `⌈N − t/frame⌉`, one frame late whenever `t/frame` is not an integer; (2) text
  anchors with `unit` resolve only for typewriter windows; per-unit reveals of Range Selectors (`side`, `unit`) resolve
  to null, so a resync would drop them; (3) `peak-speed` of a multi-property motion: the deriver's peak is on the
  combined speed (position + scale + rotation), the resolver's on the named property alone; (4) a bezier overshoot
  with no key at its extreme: the deriver lands at the turnaround, the resolver at the first arrival at the named key's
  value.
- Cuts hidden under a full-frame opaque layer on a higher track still give a cut cue (no occlusion test). Text units
  are counted from the text, not the layout: wrapped lines count as one line for `lines`-based selectors.
- Expressions: unbound documents evaluate keyframes only (`evaluate` falls back); the engine should bind expressions
  (`bindDocumentExpressions`) before deriving if it wants their motion.
- Hold-keyframe jumps (1 frame) are ignored; continuous wiggles (Wiggly selectors, expression jitter) produce many short
  segments only when they exceed MOVE_ON, and the budget thins them.
- Clip markers (on clips, in content time) are not read; only sequence markers.
- Thresholds (MOVE_ON/OFF, K_SCALE, K_ROT, ABRUPT_STOP, impact bands, confidences, minimum confidence per density) are
  reasoned defaults checked on synthetic documents; P2's real-app check and P5's Sound Check should tune them.

### WP2.3 cue route & MCP tools

Scope: spec 12 §2.8 (`POST /api/sound-design/cues`), §2.10 (MCP `find_sound_cues`, `set_sound_cues`, `place_sound`
apply mode, `swap_sound`, `align_peak`), P2-R6; plus the WP2.1 limit "`sequence.duplicate` leaves keyframe / clip-marker
anchors dangling". Files: `packages/api/src/sound-design.ts` (contracts), `routes.ts` (`soundDesignCues`),
`packages/engine-client/src/client.ts` (`soundDesignCues`), `apps/engine/src/routes/sound-design.ts` (registered last in
`routes/index.ts`), `apps/mcp/src/tools/sound-design.ts` (5 tools, registered in `server.ts`), `apps/mcp/src/tools/sound.ts`
(`SOUND_CUES_GUIDE`, part of `SOUND_GUIDE`; helpers exported), `apps/mcp/src/examples.ts`; `packages/project`:
`commands/schemas/sound.ts` + `handlers/sound.ts` (`soundDesign.swap` gains `frame`), `handlers/structure.ts` +
`sound/repair.ts` (duplicate remaps child ids), `sound/cues/edits.ts` (`sequenceDialogueRanges`); `packages/api/src/sounds.ts`
(a serialisation fix, below). Docs: README tool list (333 → 338), `docs/parity.md`, `docs/gaps.md`, `docs/security-review.md`
(the route). Tests: `apps/engine/test/sound-design-cues.test.ts`, `apps/mcp/test/sound-cues.test.ts` (+ `sound-cues-fixture.ts`),
`packages/project/test/sound-design-place.test.ts` (swap `frame`), `sound-cue-commands.test.ts` (duplicate),
`packages/engine-client/test/client.test.ts`, `apps/engine/test/sounds-unit.test.ts` (regression).

#### Route

`POST /api/sound-design/cues` (`ROUTES.soundDesignCues`, client `soundDesignCues(req, signal?)`), read-only:

```ts
SoundCuesRequest = { envelope? xor projectId?, sequenceId? /* default the first */, opts?: { range?: {start, end} /* frames */,
  sources?: CueDeriveSource[], density? /* default the sequence's setting */, respectDialogue? /* default true */,
  minGapFrames?, maxCues? /* ≤ 10 000 */, curves? } }                                         // strict objects
SoundCuesResponse = { projectId|null, sequenceId, revision|null, frameRate, durationFrames, density, respectDialogue,
  cues: [DerivedCue minus Float arrays + {timecode, seconds, storedCueId|null}], stats, warnings,
  dialogue: [{start, end}], storedCues, curves?: [{clipId, start, speed: number[] /* 0.001, ≤ 20 000 */}] }
```

- **One implementation path (decision):** derivation runs only on the engine, because the engine may import
  `@jasper/mg-templates` (check-layers: the engine's deps include it; MCP's and the model's do not) and so passes the real
  template registry (`mgTemplates`) — motion-graphic intro/outro cues exist only there. MCP `find_sound_cues` calls the route
  rather than deriving itself. The web's Suggest Cues… (WP2.4a, built in parallel) runs the same pure `deriveCues` in the
  browser with the same `mgRegistry` (the web may import it), so both surfaces give the same cues for the same document;
  `curves` is there for clients that want the Cue Seam's speed curves from the engine.
- `projectId` reads the live document through the agent service (`doc.get`: the editor's when one holds the project, else
  the saved one); `envelope` is loaded with `loadProject` (registries included). Active expressions are bound before deriving
  (the wp-note WP2.2 limit "the engine should bind expressions").
- `storedCueId`: a stored cue with the same anchor (canonical JSON, or one of the merged `also` anchors), else at the same
  frame with the same kind; a stored cue matches one suggestion at most. That is how `set_sound_cues` avoids adding twice.
- Errors: `400 VALIDATION_FAILED` (body, options, an invalid envelope), `404 PROJECT_NOT_FOUND`, `404 SEQUENCE_NOT_FOUND`.

#### MCP tools (all strict; one transaction each, retried once on a concurrent edit)

| Tool | Annotations | What |
|---|---|---|
| `find_sound_cues` | READ_ONLY | `projectId, sequenceId?, range? {start, end}` (any time input), `sources?, density?, respectDialogue?, maxCues?` (default 500), `minGapFrames?` → the route on the document MCP read (sent as an envelope, so the revision returned is the one derived from): cues as the route gives them **plus `anchorText`** (names from the document: "cut on V1: V1 'Shot A' → V1 'Shot B'", "settle of transform.position on V2 'Logo' (key kf_…)"), counts, heroes, `stats` (sources with events only), `dialogue` with timecodes, `revision`, `next` hint. |
| `set_sound_cues` | EDIT | `add[]` (a suggestion verbatim — `key, from, score, group, also, timecode, seconds, anchorText, storedCueId` are accepted and not stored; `storedCueId` set → skipped and reported — or a manual cue `{at|frame, kind=manual, weight=support, types (ids or synonyms), align, pan, panSweep, pitchSt, label, anchor, reason, window, muted}`, source `agent`; suggestions keep `derived`/`marker`), `update[]` (`{cueId, …}`, null clears, a new frame moves the cue's clips unless `moveClips:false`), `remove {cueIds, withClips?}`, `resync: true | {cueIds}`, `expectedRevision?` (refused with `E_REVISION_MISMATCH` before anything is sent). ONE transaction "Sound Cues (add n, edit n, remove n, resync)" in that order. |
| `place_sound` | EDIT | `cueId` xor `at` (time or "playhead"); `layers[1…6]` each exactly one of `soundId`, `mediaId`, `sound {type, query?}`, plus `track, align, gainDb, pitchSt, pan (number or keyframes), role`; `alternatives` (1–3 sound ids), `reason`, `kind`/`weight`/`createCue` (for `at`), `clampStart`. Registers the library sounds, then ONE transaction: imports (bin "Sound Effects", reuse), with `at` a `soundCue.add` (source agent, the layers' types, the reason) unless `createCue:false`, `soundDesign.place`, and on an existing cue a `soundCue.update` appending "· Sound: <reason>" to its reason. Returns each clip (track, role, align, aligned frame, **peakFrame** — where the media's loudest point plays, fractional — start/end, `sourceInFlicks`, `errorFlicks`/`errorMs`, rate, gain, `picked`), `placementWarnings` and notes (synth, credits). |
| `swap_sound` | EDIT | `clipId, to: soundId | "next" | "previous", align?` → register + `soundDesign.swap` in one transaction; returns from/to, `cycle {index, of, from: alternatives|family|similar|current}`, aligned frame and what was kept. |
| `align_peak` | EDIT | `clipId, to: time | "playhead" | "cue", align?, withLayers?` → one `soundDesign.swap {frame}` per clip (the clip and, by default, the other clips of its cue). Returns per clip the aligned frame, peakFrame, start, `movedFrames`, `errorFlicks`; a note when the clip's cue stays elsewhere. |

#### Decisions

- **Picking by type** (`sound: {type, query?}`, the "auto-pick" the orchestrator asked to decide): `search_sounds`' ranking
  (`types: [type]`, the cue's kind as `visualKind`, its window as `windowSec`, `usedNearby` = the sounds of the nearest
  placed clips, commercial-safe, 12 results), palette sounds moved first, then `pickVariant` (seed = the sequence's
  `soundDesign.settings.seed`, key = the cue id, or `frame:<n>` before the cue exists, layer = index; earlier picks of the
  same call count as recent) — the layer then carries the variant's rate (±2 %) and gain offset (±1 dB, added to `gainDb`).
  Deterministic for the same document, library snapshot and seed; it differs between cues and projects because cue ids
  are part of the hash. Explicit `soundId` layers get no variation.
- **`place_sound` with `at` creates a cue** by default (kind manual, weight from the first layer's role): every placed sound
  then has a cue with a reason in the Cue Seam, and `swap_sound` / `align_peak "cue"` work on it. `createCue:false` places
  by frame only.
- **Alternatives ring**: `sfx.alternatives` = [the placed sound, …alternatives], so cycling returns to the original.
  The cycle list = that ring, then `search {family of the original's first type, similarTo: original}`, then
  `search {similarTo: original}` (deduplicated, commercial-safe, 12 each); the anchor is the ring's first sound, so the list
  stays the same while cycling. A current sound not in the list is put first.
- **Re-aligning is `soundDesign.swap` with `frame`** (additive, optional field; no new command, so no new History label):
  the swap logic already lands an aligned point sample-exactly through the In point, checks the track, keeps track, speed,
  gain, pan, effects, group and cue link. With `frame`, keyframes and clip markers travel with the sound (their offset to
  the aligned point is kept); without it they keep their sequence times (unchanged behaviour). A clip whose cue stays at
  another frame is reported, not unlinked.
- **`mode: propose`** is omitted until P3 (no stub, as instructed).
- **Warnings, not refusals**: a hero (cue weight or a layer role) inside `sequenceDialogueRanges` → `W_HERO_UNDER_DIALOGUE`;
  another placed hero within 0.5 s → `W_HERO_TOO_CLOSE`, within 2 s → `W_HERO_DENSITY`. The agent asked for it; the guide
  says not to.
- **`sequence.duplicate`** now records, per clip, every nested id before and after `reidentifyClipChildren` (same walk,
  same order) and `remapSoundDesign` maps `keyframeId`, a clip marker's `markerId` and any path segment of a keyframe
  `property` naming an entity (`effects.<fxId>.params.<name>`). Regression test (failed before: the copy still named
  `kf_0000000000000KP2`): every cue of the copy resolves to the original's frame and loading repairs no anchor.

#### Bug found and fixed

`soundSearchParams` serialised numbers with `String(n)`, so a computed `windowSec` (a 20-frame transition at 30 fps =
0.666… s, 16 decimals) failed the route's `^\d{1,6}(\.\d{1,6})?$` and `place_sound {sound: {type}}` on a transition cue
answered `VALIDATION_FAILED windowSec: seconds` (found in the real run). Numbers now go with ≤ 6 decimals; regression in
`apps/engine/test/sounds-unit.test.ts` (failed before the fix with the same ZodError) and the MCP test places a pick on the push.

#### Verified (measured, this branch; shared host, 16 cores)

- `pnpm vitest run apps/engine/test/sound-design-cues.test.ts --maxWorkers=1`: 4 passed. On the Phase 2 fixture with the
  **engine's real template registry** (lower-third 30/15 frames): cuts 90 and 330 ("Cut on V1: 'Shot A' → 'Shot B'",
  `00:00:03:00`, 3 s), push at 180 (`transition`, window 170–190, sweep −60 → 60, whoosh first), logo move 46 / land 52
  (anchor `transform.position`, key P2), ≥ 5 typewriter keys from 200 in one group, mg land 360 / exit 405, the marker at 250
  as a hero boom + whoosh, no warnings; by `projectId` of a saved project: 2 stored cues matched (`storedCueId` at 90 and 180),
  curves of the logo (> 10 frames, max speed > 0.1), sources / density / range options, the sequence's own density as
  default; 11 bad bodies → typed 400/404, `maxCues` honoured; a fuzz target (testkit, 3 seeds, mutated structure, values,
  truncations and arbitrary JSON; 40 iterations + 10 properties): no 5xx, every 200 parses with the response schema.
  The generic `fuzz-http.test.ts` covers the route too (discovered from the server).
- `pnpm vitest run apps/mcp/test/sound-cues.test.ts --maxWorkers=1`: 5 passed (≈ 30 s; real engine on 49511, 9 kit files
  + 19 synth, jasper-mcp over stdio). find: every event above with `anchorText`, sparse < balanced, `sources`, a range in
  seconds/timecode, `densty` → `E_UNKNOWN_ARGUMENT`; set: all 17 suggestions stored verbatim in **one transaction (revision
  +1)**, then every suggestion has a `storedCueId`, the same list again → `E_INVALID_PARAM`, stale `expectedRevision` →
  `E_REVISION_MISMATCH`, add + update + remove + resync in **one transaction (revision +1)** ("swoosh" stored as whoosh),
  unknown type / key / cue refused; place: a hit with 2 alternates on the cut — **aligned point at 90·F ± 1 flick,
  `errorFlicks` 0, peakFrame 90**, pan −20 and gain −3 stored, `sfx.alternatives = [placed, alt1, alt2]`, the cue's reason
  appended; 3 layers on the marker cue (one picked by type): 3 tracks, one group, roles hero/layer/layer, each at 250·F ± 1;
  a whoosh picked for the push lands at 180·F ± 1 with pan keyframes −60 → 60; a riser `at` 12 s aligns its **end** and
  creates a `reveal` cue with the reason; a hero 5 frames from another → `W_HERO_TOO_CLOSE`; refusals (two sources in a
  layer, cueId + at, unknown type, a boom at frame 0, unknown cue, unknown key); swap: next → alt1, next → alt2, previous →
  alt1, previous → the original, previous again → a family/similar sound (cycle of > 3), explicit id; afterwards the clip
  still plays its aligned point at 90·F ± 1 with errorFlicks 0, same track, role hero, cue, pan −20, gain −3, alternatives;
  swapping to the playing sound / unknown clip / malformed id refused; align_peak: the 3 layers to 7 s → each at 210·F ± 1
  (revision +1, a note naming the cue), back with `to: "cue"` → 250·F ± 1, one layer alone by timecode, refusals (frame 0,
  "playhead" without an editor → `E_NO_SESSION`, a video clip).
- `pnpm vitest run packages/project/test/sound-design-place.test.ts packages/project/test/sound-cue-commands.test.ts
  --maxWorkers=2`: swap `frame` at all 8 rates (aligned point exact to 1 flick, errorFlicks 0, pan keyframes travel 47 frames,
  undo = untouched document, redo = same document up to ids, refusals before 0 / busy span); the duplicate regression above.
- `pnpm vitest run apps/mcp/test/readme-tools.test.ts apps/mcp/test/conventions.test.ts apps/mcp/test/sound-guide.test.ts
  apps/mcp/test/sound-examples.test.ts apps/mcp/test/fuzz.test.ts packages/engine-client/test/client.test.ts`: pass (README
  lists the 338 tools; the `soundDesign.swap` example with `frame` applies to a real project; the tool-argument fuzz covers
  the 5 new tools).
- **Run for real** (dev engine `JASPER_APPDIR=.stage JASPER_DEV=1 tsx apps/engine/src/cli.ts --port 49501`, the full 60-sound
  starter kit, a scratch MCP client over stdio, project built from `sound-cues-fixture.ts`): find_sound_cues → 17 cues
  (1 hero), all stored with set_sound_cues (revision 2); place_sound: "Crunchy impact" + 2 alternates on the cut (90),
  a picked whoosh on the push (180, "Pneumatic whoosh", rate 0.9876), a picked thump on the logo land (52), boom + whoosh
  on the marker (250), a picked "metal" hit on the lower-third land (360): every clip `errorFlicks` 0, peakFrame = cue;
  swap_sound next → "Heavy metal hit" (cycle 2 of 24, aligned 90); align_peak to cue (moved 0). **Native export**
  (`start_export`, 14 s MP4/AAC) decoded with ffmpeg (mono, 48 kHz) and searched with the descriptors' 2 ms RMS / 0.5 ms
  hop within ±0.25 s of each cue: logo land **+0.17 ms**, cut **0.00 ms**, push **0.00 ms**, mg land **0.00 ms**; the marker's
  combined maximum is +97.7 ms (the boom's later body plus the whoosh tail), so its two layers were measured alone
  (exports with A5, then A4 muted): boom **−0.33 ms**, whoosh **−0.83 ms** — all within the envelope's resolution.
  Frames **looked at** (`render_frames`): 89 red / 90 green (the cut on the cue); 170 / 180 / 189 the push half-way at 180,
  entering from the left (matches the −60 → 60 sweep); 49 / 52 / 55 the logo left of centre, at its overshoot, settled
  (the land cue is the turnaround). In the editor (Vite on 49502, the project open in a browser): `set_sound_cues` applied
  live (`appliedBy: session`), MCP `undo` removed exactly that cue ("Agent: Sound Cues (add 1)"); a two-layer
  `place_sound` at 300 was **one History entry**: one `undo` deleted both clips, the imported media and its item, and the
  created cue (storedCues back to 17).
- `pnpm typecheck`, `pnpm lint` (Biome, tokens, anime, layers, assets): pass (see the integration below).

#### Limits and notes for the next packages

- **Lower-third intro vs its cue (found by looking):** the `lower-third` template's picture settles at ≈ frame 345–350
  (`render_frames` 330…360), while its declared `introFrames` (30 at 30 fps) put the mg `land` cue at 360, ≈ 0.3 s after the
  visible settle. **Fixed in Phase 2 verification B**: the mg source measures the rendered motion; the fixture's land is
  now 350 (exit 408), see "Phase 2 verification B: mg land / exit from the rendered motion".
- **Loud mix:** kit sounds at 0 dB gain overlap to a decoded peak of 1.36 (mono, > 0 dBFS) in the real-run export. Level is
  Phase 4 (auto gain, masking, limits). **Since Phase 2 verification B (§3) placement gives each sound a default level by
  role** (the fixture filled through MCP exports at −5.0 dBTP).
- `place_sound` warnings use transcript words and Essential Sound dialogue clips only (no VAD: P6-R3) and the hero rule
  counts placed clips with `sfx.role: hero` (not unfilled hero cues).
- Undo was checked live in the editor through MCP `undo`; the headless tests prove "one transaction" (revision +1).
- `find_sound_cues` sends the document as an envelope (one read, a consistent revision); on very large projects the body is
  as large as `render_frame`'s.
- `swap_sound`'s family / similar lists depend on the library snapshot (a rescan can change the cycle after the alternates).
- The route does not return engine sources (scene, beat, pixel: P6 `extraCues`).

### WP2.4a Cue Seam

Scope: spec 12 §2.7 "Cue Seam", "Suggest Cues… dialog", "Peak handle", the cue / peak snapping and the menus and
shortcut of P2-R7 (the timeline parts). Fill / swap / variation cycling, Add Layer / Link, In Context audition, clip
audio-type badges, the clip context menu, the Essential Sound / Properties sections and Clip ▸ Audio Options are WP2.4b.

Files: `apps/web/src/sound/cues/{model.ts,seam.ts,suggest.ts,peak.ts,CueSeam.tsx,PeakHandle.tsx,SuggestCuesDialog.tsx}`,
`apps/web/src/commands/sound-cues.ts` (+ `commands/index.ts`, `keymap-defaults.ts`), `shell/menus/model.ts`
(Sequence ▸ Sound Design, Markers), the timeline (`model/layout.ts` divider height, `model/snapping.ts` `cue` /
`anchor` snap kinds, `model/gestures.ts` peak-first move snapping, `state/controller.ts` peaks of moving clips,
`components/TrackArea.tsx` / `TrackHeaders.tsx` divider, `TimelinePanel.tsx` wiring), `extensions/index.ts`
(`cueMenuExtensions`), `sound/controller.ts` (Fill mode) and the Sound Library's Fill chip, `packages/session`
(selection domain `cues`, view field `cueSeam`), `packages/ui` tokens (`--pr-cue`, `--pr-cue-hero`,
`--pr-cue-unfilled`, high-contrast values), `packages/project` `soundDesign.setPeak` (schema, handler, catalog label,
AC-25 fuzz), `apps/mcp` (`describe_commands` example, SOUND_GUIDE "Cues" paragraph), es.json (108 strings).
Tests: `apps/web/test/sound-cue-seam-model.test.ts` (21), `sound-cue-seam.test.tsx` (10), `sound-cue-commands.test.tsx`
(9), `packages/project/test/sound-set-peak.test.ts` (3), `apps/mcp/test/sound-examples.test.ts` (+1),
`e2e/sound-cues.spec.ts`.

#### What it does (usage)

- **The seam**: the video/audio divider widens from 4 px to an 18 px lane (`computeLayout({dividerPx})`; the lane does
  not scroll vertically; the audio region starts below it). The header column shows "Cues · n" and keeps the divider's
  row-resize drag; its context menu has Suggest Cues…, Add Sound Cue, Hide Cue Seam. **Visibility** (decision): the
  user's choice per sequence (`SequenceViewState.cueSeam: 'on'|'off'`, saved with the project's views) wins; without
  one the seam shows in the Sound Design workspace **and whenever the sequence has cues** (after Suggest Cues the cues
  must be visible in any workspace). Sequence ▸ Sound Design ▸ Show Cue Seam toggles it (checked = shown).
- **Glyphs** (one shape per kind, so no two kinds share one): cut ▮ bar, transition ◆, move ▸, land ▼, appear ○,
  exit ▲, emphasis ✦ (4-point star), reveal ■, beat +, manual ⬟ (pentagon), silence – . Size by weight: hero 12 px,
  support 8 px, ambient 6 px. **States** never by colour alone: unfilled = hollow with a dashed stroke
  (`--pr-cue-unfilled`); filled = solid stroke (`--pr-cue`; a hero is a filled shape in `--pr-cue-hero`) plus a 1 px
  connector from the glyph to the peak of each clip that fills it (an arrow ▾/▴ at the lane edge when that clip's row is
  scrolled out of view); agent-authored = dotted `--pr-agent` stroke plus a tick above the glyph; ghost (P3 proposals,
  a `ghosts` prop, not stored) = `--pr-ghost-stroke` over `--pr-ghost-fill`; conflict (two unmuted heroes < 0.5 s apart)
  = a 2 px `--pr-warning` underline; muted = 45 % opacity and a diagonal strike; selected = a box behind the glyph, the
  keyboard's active cue a focus-ring box. Windows (`window`, e.g. a push or a typed title) are a tail with end ticks
  along the bottom of the lane; `build` is a rising wedge before the cue, `stopBefore` a bar along the top ending in a
  stop tick. Glyphs in view are drawn (± a margin); above 1 500 in view the selected ones and heroes are kept first,
  and the tier that does not fit whole is thinned evenly over the view (Phase 2 verification: it used to keep only that
  tier's first cues, so a zoomed-out hour lost every support cue of its second half).
- **Editing**: click selects (Shift toggles; clicking empty lane deselects; selecting clips deselects cues, so Delete
  has one meaning). Drag moves the selected cues (`soundCue.update {frame}` per cue in one session gesture → one undo
  step "Move Cue(s)"; the filled clips follow, as WP2.1's update does). Snapping (when the timeline's snapping is on):
  first the dragged cue's own **anchor** (where `resolveCueAnchor` puts its picture event now, priority above the
  playhead), then the usual targets (playhead > marker = cue > In/Out > clip edges). A cue dropped off the frame its
  anchor resolves to **forgets the anchor** (`anchor: null`), so `soundCue.resync` does not pull an intentional offset
  back (decision; the tooltip says "Detached from its picture event" while dragging). Alt-drag duplicates (copies by the
  user, no clips, no anchor; the copies are selected). Double-click / Enter → `soundLibrary.fillCue`. Delete / Backspace
  removes (`soundCue.remove`; filled clips stay and forget the cue).
- **Cue menu**: Role ▸ Hero / Support / Ambient, Visual Tag ▸ (the cue kinds), Align ▸ Peak / Start / End, Stop Before
  Next (toggle; writes `stopBefore {seconds: 0.25, depthDb: −24}` — values chosen here, P4 renders them as a music dip),
  Mute Cue, the entries of `cueMenuExtensions` (WP2.4b: Fill With ▸, Fill from Library…, Add Layer…), Convert to
  Marker, Delete. Entries act on the selection when the right-clicked cue is in it.
- **Keyboard**: the lane is one tab stop (`role="toolbar"`, `aria-activedescendant`, `data-keymap-local` so its keys
  run before the keymap and the others fall through): Left / Right / Home / End move between cues (Shift extends) and
  scroll the timeline to them, Enter fills, Delete removes, the context-menu key or Shift+F10 opens the cue menu, Esc
  deselects. Each glyph is named, e.g. "Hero Land cue at 00:00:04:02, unfilled, Position (200, 540)→(960, 540) ends
  (ease-out overshoot) on V2 'Logo'" (filled: "filled with A4 Crunch"; "agent-authored", "muted", "conflicts with
  another hero cue"), and has a tooltip with the reason, the suggested types and how to fill it.
- **Suggest Cues…** (Sequence ▸ Sound Design, the seam menus): checkboxes for the eight project sources of `deriveCues`
  with live "n found · k kept" (found from a run with every source, kept from the run with the chosen ones: merging
  depends on the selection), range (whole sequence, In to Out, selected clips), density (default: the sequence's
  setting; a change is saved with `soundDesign.setSettings` in the same transaction), "Respect dialogue", "Replace
  earlier unfilled suggestions in the range" (default on: unfilled `derived` cues in the range are removed first; a
  derived cue of the same kind within 2 frames of a cue that stays is skipped, so running it twice does not double the
  cues). Suggest commits ONE transaction "Suggest Cues (n)" (`soundCue.add` with WP2.1's `cueInputFromDerived`: reason,
  anchor, confidence, pan / pan sweep, window, source `derived` or `marker`; split into commands of ≤ 2 000 cues), selects
  the new cues and toasts with Undo. Motion graphics use `mgRegistry` from `@jasper/mg-templates`.
- **Peak handle** (`clipDecorations` overlay on audio clips with `sfx` or library media): a 1 px `--pr-accent` line at
  the peak and a 7 px diamond at the top, hidden below 24 px of width or 32 px of height, on reversed and time-remapped
  clips, and when the peak is outside the used part of the media. Peak = `sfx.placement.peakFlicks` when the placement
  aligned the peak (or after an override), else the media's `library.descriptors.peakSec`. Tooltip "Peak <tc> · <s> s
  into <name>" (seconds into the sound, lead silence excluded). Dragging the diamond moves the clip and its group
  (`clip.move`, "Move Clip by Peak") snapping by the peak's frame only; Shift-drag moves the peak inside the clip and
  writes **`soundDesign.setPeak {clipId, peakFlicks}`** (new command: align `peak`, `errorFlicks` = how late the new peak
  plays after the cue the clip fills, 0 when early or without a cue; a library clip without `sfx` gets it with
  `cueId: null`; refusals E_NOT_FOUND, E_INVALID_PARAM (not audio, not a library sound, past the media end),
  E_TRACK_LOCKED, E_SCHEMA). The appliesTo test stays O(1): the timeline keeps the set of library media ids
  (`useLibraryMediaTracking`) and re-registers the decoration when it changes.
- **Snapping**: new `cue` snap kind at marker priority (clips, the playhead scrub and cue drags snap to cues) and
  `anchor` (only for a dragged cue). Moving any SFX clip with the Selection tool snaps its **peak first** (the peak's
  frame, so the sub-frame rest is kept), the start/end edges only when the peak finds no target.
- **Menus and shortcut**: Markers ▸ Add Sound Cue (**Alt+Shift+C**, scope `editing`; mac Opt+Shift+C; no other binding
  uses it in any preset — `keymap.test.ts` passes), Go to Next / Previous Sound Cue (unbound; seek and select), Convert
  Markers to Sound Cues (`sfx: …` markers and the selected markers become cues — kind `manual`, the first type's weight
  and align, the name as label otherwise — and are removed), Convert Sound Cue to Marker (`sfx: type+type`, read back by
  `parseSfxRequest`); Sequence ▸ Sound Design ▸ Suggest Cues…, Show Cue Seam, Clear Unfilled Cues.
- **Fill mode** (`soundLibrary.fillCue {cueId?}`, agent-exposed): selects the cue, remembers it as the Sound Library's
  fill target (`sound/controller.ts` `requestCueFill` / `cueFillTarget` / `subscribeCueFill`), presets the type chips
  to the cue's suggested types (now, or when the panel mounts) and focuses the panel, which shows a dashed "Fill: Hero
  Land cue at …" chip (✕ leaves Fill mode). Placing the chosen sound into the cue (Enter / drop in the panel) is WP2.4b.
- **Agents**: every edit is a `soundCue.*` / `marker.*` / `soundDesign.setPeak` command (`apply_commands`); the UI
  commands `sound.addCue {frame?}`, `sound.nextCue`, `sound.prevCue`, `sound.convertMarkersToCues`,
  `sound.convertCueToMarker`, `sound.toggleCueSeam`, `sound.clearUnfilledCues`, `soundLibrary.fillCue {cueId}` are in the
  UI command catalogue (`ui_command`). SOUND_GUIDE has a "Cues" paragraph.

#### Verified

Measured on this branch (merged with `feat/sound-design` 675ca903, shared host with 16 cores, load average 60–75).

- `pnpm vitest run apps/web/test/sound-cue-seam-model.test.ts` (21 passed): cue reading (sorted, hostile values skipped;
  300-run `fc.anything()` property), one shape per kind, glyph paths inside the box, paint per state (dashes, fill,
  underline, agent tick, strike), hero conflicts, layout (x at the frame, culling, window / build / stop spans, dangling
  placed ids are not "filled"), the render cap, hit testing (half size + 3 px slop, heroes win ties), keyboard order,
  accessible names, divider layout (4 px default, 18 px seam, audio region and `hitY` below it), visibility rule, clip
  peaks (placement over descriptors, sourceIn / speed, reversed / outside → none, content-time round trip, seconds into
  the sound, handle hidden below 24 × 32 px), conversions (marker ⇄ cue round trip through `parseSfxRequest`), `cue`
  snap targets and peak-first move snapping.
- `apps/web/test/sound-cue-seam.test.tsx` (10 passed; testing-library on a real session): glyph names and states,
  click / Shift-click / empty-lane deselect, drag (one "Move Cue" step, undo / redo, anchor detached and restored by
  undo), snapping to another cue and to the playhead, Alt-drag duplicate (+ undo), keyboard (arrows, Shift-extend,
  Enter → fill, context-menu key, Delete → "Delete Cues (2)", undo, Home, Esc), double-click → fill, the cue menu
  (Role, Visual Tag, Align, Stop Before Next with their history labels, undo, Convert to Marker + undo), a read-only
  project never edits; Suggest Cues… dialog: "2 found · 2 kept" (edits) / "1 found · 1 kept" (markers), unticking a
  source updates the kept count and the summary live, Suggest → 3 cues with reason and anchor in ONE history entry
  "Suggest Cues (3)", selected, undo removes all three.
- `apps/web/test/sound-cue-commands.test.tsx` (9 passed): Add Sound Cue at the playhead / at `frame`, undo / redo;
  Next / Previous Cue (disabled past the last); Convert Markers to Cues ("Convert Markers to Cues (2)") and back; Clear
  Unfilled Cues; Show Cue Seam toggling; Fill mode target and label, unknown cue refused; selection pruned when cues go;
  peak handle drawn at 0.25 s = frame 37.5 with tooltip "Peak 00:00:01:07 · 0.200 s into Crunch", hidden on a 20 px
  clip, diamond drag moves the clip so its peak lands on the cue at 50 ("Move Clip by Peak", undo), Shift-drag writes
  the override (`peakFlicks` 0.35 s, the clip stays, "Set Peak", undo removes `sfx`).
- `packages/project`: `pnpm vitest run --project @jasper/project --maxWorkers=4` → 150 files, 1858 tests passed
  (includes `sound-set-peak.test.ts` (3: override + error against the cue + redo, library clip gains `sfx`, every
  refusal) and AC-25 with `soundDesign.setPeak` in the random transactions). `apps/mcp/test/sound-examples.test.ts`
  10 passed (the setPeak example applies to a project).
- `pnpm vitest run --project @jasper/web --maxWorkers=4` → 113 files, 801 tests; one failure on the first run
  (`i18n.test.ts`: "Set Peak" missing from model-strings.json), fixed with `pnpm i18n`, rerun passed.
  `--project @jasper/session --project @jasper/ui --project @jasper/mcp` → 625 passed; `apps/mcp/test/integration.test.ts`
  timed out in its `beforeAll` (180 s) at load ≈ 70 and passed alone (10 tests).
- `pnpm typecheck` (workspace), `pnpm lint` (Biome, tokens, anime, layers, assets), `node scripts/i18n.mjs --check`
  (8 952 strings), `pnpm notices --check`: pass.
- `pnpm build`, then `E2E_PORT=49405 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-cues.spec.ts`: 1 passed
  (9.2 s). In the built app: a fixture of three solids with cuts at 90 and 180, a 20-frame push into the third, a text
  "LOGO" on V2 keyframed 200 → 1010 → 960 px, a typewriter title, a `sfx: boom+swoosh` marker; no seam before cues;
  Sequence ▸ Sound Design ▸ Suggest Cues… shows edits 1/1, transitions 1/1, keyframes 2/2, markers 1/1, text found;
  "Suggest 14 Cues" → history "Suggest Cues (14)", every cue has a reason; the seam appears (18 px) and the cut (90),
  push (180), move, land and marker (250, hero) glyph centres are within 1.5 px of their frames' x (measured against
  the clip edges); right-click → Role ▸ Hero changes that cue only ("Cue Role"); a 12-frame drag (snapping off) → frame
  102 ± 1, "Move Cue", Ctrl+Z → 90; Delete + Ctrl+Z; Alt+Shift+C at frame 120 → a manual support cue, "Add Sound Cue";
  `soundDesign.place {cueId: land}` of a library sound → the glyph turns filled, the connector exists, the peak line is
  within one frame of the cue's x, the name says "filled with A…".
- Looked at (dev stack on ports 49401/49402 and the e2e screenshots in `test-results/e2e-sound-cues/`): the dialog, the
  seam at sequence zoom and zoomed in (dashed ▸ / ▼ glyphs, window tails, the hero marker pentagon), high contrast
  (`data-pr-contrast="high"`: brighter cue and unfilled strokes), reduced motion (nothing animates on the seam), the cue
  menu, the filled land cue with its connector down to the SFX track. The first look found the window tail drawn
  through the glyphs and 8 px dashed glyphs too faint: the tail moved to the lane bottom and strokes went to 1.5 px /
  3-1.5 dashes.

#### Limits and notes for the next packages

- WP2.4b: register Fill With ▸ / Fill from Library… / Add Layer… through `cueMenuExtensions`; read the fill target with
  `cueFillTarget()` (cleared with `requestCueFill(null)`) and the selected cues from `session.getState().selection.cues`;
  Enter in the panel should place into the target cue with `soundDesign.place {cueId}`. The Properties "Cue" section
  can reuse `cueAriaLabel` / `cueTooltip`.
- Stop Before Next's values (0.25 s, −24 dB) are a decision of this package; P4 may tune them.
- The seam has no horizontal virtualisation beyond culling to the view and the 1 500-glyph cap; typewriter patterns at
  sequence zoom overlap into a row of glyphs (they are still hit-testable one by one when zoomed in).
- Dragging a cue whose filled clip cannot move (overlap, locked track) shows the refusal in the drag tooltip and the
  commit is refused with a toast (WP2.1's `soundCue.update` rule); there is no "move the cue only" modifier.
- Ghost cues are drawn when passed in (`ghosts`), but nothing passes them until P3.

### Phase 2 → WP2.4b fill, swap, layers, badges

Scope: spec 12 §2.7 Insert / Fill, Audition "In Context", Variation cycling, Layering, Clip badges, Essential Sound SFX
additions (Sound row, Role, Align, Pitch; Auto gain, Room send and Stop before next are Phase 4), Properties "Sound" and
"Cue", the clip context menu, the shortcuts and Clip ▸ Audio Options; the parts of P2-R7 WP2.4a did not do.

Files: `apps/web/src/sound/{library-media,design-model,fill,swap,in-context,detect-peak,analyze.worker,register,
EssentialSfx,SoundSection,AddToLibraryDialog}.ts(x)`, `apps/web/src/commands/sound-design.ts` (+ `commands/index.ts`,
`keymap-defaults.ts`), `sound/controller.ts` (Replace / layer modes), `sound/insert.ts` (uses `library-media`),
`sound/prefs.ts` + `PreferencesPage.tsx`, `sound/model.ts` (Palette collection), `panels/soundLibrary/SoundLibraryPanel.tsx`,
`sound/cues/CueSeam.tsx` (drop target), `panels/essentialSound/EssentialSoundPanel.tsx`, `panels/properties/
PropertiesPanel.tsx`, `extensions/index.ts` (`MenuItemSpec` highlight hooks and lazy submenus, `ClipMenuContext.runCommand`),
`panels/timeline/{components/Chrome.tsx,state/ui-store.ts,TimelinePanel.tsx}`, `audio/browser-decode.ts`
(`decodeMediaRange`), `shell/menus/model.ts`; `packages/session` (`coalesceWindowMs`, `coalesceRelabel`);
`packages/project` (`soundDesign.swap` `pitchSt`, `soundDesign.setRole`, `soundDesign.setPeak` on project audio, catalog
label, AC-25 fuzz), `apps/mcp/src/examples.ts` (setRole example); es.json (179 strings); `docs/gaps.md`.
Tests: `apps/web/test/sound-fill-swap.test.tsx` (14), `sound-fill-ui.test.tsx` (9), `packages/project/test/
sound-swap-role.test.ts` (6), `sound-set-peak.test.ts` (updated), `packages/session/test/session.test.ts` (+1),
`apps/mcp/test/sound-examples.test.ts` (+1), `e2e/sound-fill.spec.ts`.

#### What it does (usage)

- **Fill** (spec: "Enter or double-click: fill the selected cue, else swap, else insert"). The cue being filled is Fill
  mode's (`soundLibrary.fillCue`: double-click / Enter on a glyph, Fill from Library…) or else the last selected cue.
  Enter / double-click in the Sound Library then runs ONE transaction "Fill Cue <title>": the sound is registered
  (`sound/library-media.ts`, shared with Insert), `soundDesign.place {cueId}` puts it on the cue — role from the cue
  (hero / support), alignment from the cue or the sound type, pan / pan sweep from the cue, `alternatives` = the next
  3 results of the list (the ranking the user looked at), speed and gain from `variationOf` (seeded ±2 % / ±1 dB). The
  Fill chip goes away, the clip is selected, a toast says "Filled the Support Cut cue at 00;00;02;15 with … on A4" with
  Undo. A head that would start before frame 0 is trimmed (`clampStart`, as Insert decided in WP1.4).
- **Drop on a cue**: a Sound Library row dragged over the Cue Seam highlights the glyph under the pointer (a ring in
  `--pr-accent`, `data-drop-target`), dropping runs `sound.fillCue {cueId, soundId}`; elsewhere the timeline drop of
  WP1.4 is unchanged.
- **Cue menu** (`cueMenuExtensions`): **Fill With ▸** loads the 5 best sounds for the cue when it opens (engine search
  with the cue's types — else its visual kind's —, visual kind, window, align and the sounds used nearby for rotation:
  `cueSearchRequest`); resting on one for 350 ms auditions it in context when the Library's In Context toggle is on;
  choosing one fills the cue. **Fill from Library…**, **Add Layer…** (filled cues only).
- **Fill Unfilled Cues** (Sequence ▸ Sound Design): for every unfilled, unmuted cue in frame order the engine ranks
  sounds, `pickVariant` picks one (least recently used of the top 4, never the same file twice in a row; the recent
  list is this run's picks plus the sounds of nearby clips), the next 3 become alternatives; all in ONE transaction
  "Fill Unfilled Cues (n)". A dry run finds a cue that cannot be placed; it is skipped and reported, the others fill.
  Deterministic for the same library and seed (tested). Until Phase 3 it applies directly (no proposal).
- **Replace mode / Swap Sound…** (Alt+Shift+S, mac Opt+Shift+S; clip menu; Essential "Swap…"; Properties "Swap…"): the
  Library shows "Replacing <name> on A3 at <tc> · Enter to swap · Esc to cancel" and ranks by similarity to the clip's
  sound (the "Similar to" chip, cleared again when the mode ends). Enter → "Swap Sound <title>" (`soundDesign.swap`: peak
  frame, track, role, pan, gain, effects, group, link and cue kept).
- **Variation cycling** (Next / Previous Variation, Ctrl+Alt+. / Ctrl+Alt+, — mac Opt+Cmd+. / Opt+Cmd+, — repeat on,
  clip menu, Essential ◀ ▶): per selected SFX clip a list = its alternatives (or its cue's other layers'), then the
  same family (engine search by `typesOfFamily`), then the nearest descriptors (`similarTo`), the original at index 0
  (cycling past the end returns to it). Presses on the same clips coalesce into ONE history entry "Swap Sound ×4": the
  session commits each step with a run key, no time window and the new label (`coalesceWindowMs: Infinity`,
  `coalesceRelabel`, new in `packages/session`). The run closes on any other edit (the document revision moved),
  another selection or sequence; presses arriving while a step registers are summed into one step. "Audition on swap"
  (preference, default on) then plays the 2 s around the sound and returns the playhead.
- **In Context audition** (Shift+Space in the Library, the toolbar's In Context toggle for Space / Auto-play / hover,
  the row menu, the Fill With hover, agents: `soundLibrary.auditionInContext {soundId}`): the candidate is placed by
  `soundDesign.place {frame, align}` inside a session **gesture** — the transient document the timeline and the Program
  draw and play — on the anchor: the cue being filled or the last selected cue (its align), else the clip being replaced
  or the selected SFX clip's aligned point (that clip disabled in the transient document only, i.e. muted), else the
  playhead. The transport seeks to anchor − pre-roll (preference, default 2 s, 0.5 … 10 s), plays to 1 s after the
  candidate's end, pauses and returns to the anchor; the gesture is always cancelled, so the document, the revision and
  History never change (tests and e2e assert both). Any key or pointer press, the transport stopping, Esc or another
  audition ends it. A Program overlay chip "Auditioning: <name>" (`programOverlays`) and the Library's aria-live say
  what plays. It uses the Program's own transport and graph (a seek while paused, then Play: the Phase 0 primed start
  applies unchanged); the plain audition player is stopped first.
- **Layers** (Add Layer… on a filled cue or an SFX clip): the Library goes to Fill mode with layer intent ("Add layer:
  …" chip) or, for a clip that fills no cue, a clip-layer mode (banner). Enter → "Add Layer <title>": `soundDesign.place`
  with `role: 'layer'`, `group: false`, on the next free SFX track, aligned to the same point, then `clip.link` of the
  cue's clips (Premiere-style link, one clip per track: with Linked Selection on, selecting or moving one moves the
  others — e2e). **Link Layers / Unlink Layers** (`sound.toggleLinkLayers`). Essential Sound and Properties show
  "Layer 2 of 2"; the timeline shows a chain badge.
- **Clip badges** (`clipDecorations` `sound.badges`, audio clips with an Essential type or `sfx`): the audio-type glyph
  (dialogue mic, music note, SFX bolt, ambience wind: different shapes) — clicking it selects the clip and focuses
  Essential Sound —, "H" for a hero, a chain for layers, a `--pr-warning` dot for NC / ND / unknown / undeclared-folder
  licences; each with an aria-label and tooltip. The host shows badges from 40 px; H and chain need 80 px.
- **Essential Sound ▸ Sound Design** (type SFX, above the type's sections): the Sound row (name, types, author, licence
  badge, Swap…, ◀ ▶, Find Similar), Role (Hero / Support / Layer → `soundDesign.setRole`), Align (Peak / Start / End →
  `soundDesign.swap` with the same media: the chosen point lands on the frame the old one played at), Pitch − / + / Reset
  (→ `soundDesign.swap {pitchSt}`: |st| ≤ 3 by varispeed keeping the seeded variation, beyond by the Pitch Shifter
  effect; the aligned point stays; pan keyframes keep their sequence times), "Layer n of m". Header: **Browse sounds…**.
- **Properties**: **Sound** (selected audio clips; the first when several): title, types, descriptors (length, onset,
  peak into the sound without the lead silence, centroid, max momentary loudness), where the aligned point plays, role
  and layer, the cue (click selects it and seeks), the licence with its class, the credit line exactly as File ▸ Export
  ▸ Sound Credits prints it (`creditLine`; tested against `soundCredits`), Show Licence…, Swap…; project audio shows
  Detect Peak. **Cue** (a selected cue, no clip): timecode, frame, role, kind, align, pan (number or `auto`, the sweep
  shown), pitch, build, stop before, reason, the filling clips (click selects) — every edit one `soundCue.update`.
- **Clip context menu / Clip ▸ Audio Options**: library sounds — Swap Sound…, Next / Previous Variation, Align Peak to
  Playhead (Ctrl+Alt+P, mac Opt+Cmd+P; moves the clip and what moves with it), Align Peak to Nearest Cue (its own cue
  first), Set Peak at Playhead (`soundDesign.setPeak`), Find Similar Sounds, Reveal in Sound Library (searches the title
  and selects it), Add to Palette (toggle; `soundDesign.setPalette` add / remove), Role ▸, Add Layer…, Link / Unlink
  Layers, Show Licence… (the engine's entry, else the stored provenance); other audio — **Detect Peak**, **Add to Sound
  Library…** (and the peak entries once it has a peak). All are UI commands with a `clipId` argument, agent-exposed.
- **Palette**: the Library's "Palette (n)" collection and a strip above the status line with the sequence's palette
  sounds (click auditions / selects, × removes) and "Palette only"; the row menu has Add to Palette.
- **Detect Peak** (decision): no engine route exists for analysing project media and the engine is WP2.3's area, so the
  browser measures it: the part of the media the clip uses is decoded with mediabunny (`decodeMediaRange`, interpreted
  media through its time map), `@jasper/audio-fx` `analyzeSound` (the library's own descriptor: the centre of the loudest
  2 ms RMS window) runs in a module worker (`sound/analyze.worker.ts`; web may import audio-fx, ARCHITECTURE §3.1), and
  the result is written with `soundDesign.setPeak`. At most 120 s are analysed (≈ 46 MB of stereo 48 kHz; the toast says
  when the clip was longer). `setPeak` now accepts any audio clip (the clip's `sfx` gets `soundId: null`, which WP2.1
  made nullable for exactly this); the old "not a library sound" refusal is replaced by that behaviour.
- **Add to Sound Library…** (decision): the library indexes folders in place (WP1.2), so the clip's file is not copied;
  the dialog adds the folder of its `path` locator as a user folder with a declared licence (default undeclared =
  flagged, hidden by Commercial-safe) and author, through the user's own `PUT /api/sounds/roots` (approval-free for
  the editor; agents are asked by the engine); a folder already in the library (itself or a parent) is rescanned instead.
  Media without a local path (uploads, engine-store copies) cannot be added: the entry is disabled with the reason.
- **Preferences ▸ Sound Library ▸ Audition**: Audition in context, Audition on swap (on), In Context pre-roll (2 s).

#### Decisions

- `soundDesign.setRole` is new (no existing command wrote `sfx.role`); a library clip without `sfx` gets it.
- Align and Pitch reuse `soundDesign.swap` (same media) so re-alignment and re-pitching share the swap's sample-exact
  plan and keyframe handling. Pitch: the current varispeed is read as whole semitones (`round(12·log2 rate)`, ±3), the
  rest is the seeded variation and is kept. Merged with WP2.3's `frame` option: both can be combined (tested).
- Layers are linked, not grouped (the timeline has Premiere's A/V link; the spec says Link / Unlink).
- History: variation cycling uses the session's coalescing (S01:UND-006) with two new optional transaction fields
  instead of a long-lived gesture (a gesture would hold edits uncommitted — autosave and crash recovery would not see
  them — and block Undo).
- In Context uses a cancelled gesture (transient document) instead of mixing the candidate in the audition context:
  the Program's mix, effects, latency compensation and primed start apply unchanged and nothing has to be synchronised
  between two AudioContexts.
- Aligned frames within 1e-6 of a whole frame are that frame (`alignedFrameOf`): at 29.97 fps flicks rounding gave
  74.9999… for a sound placed on 75, so labels said 02;14 and Align Peak moved one frame (found by the e2e).
- The NaN-x guard in the seam's drop hit test (jsdom has no `DragEvent.clientX`; `hitCue(NaN)` matched the first cue).

#### Verified (measured, this branch, shared host with 16 cores, load average 10–65)

- `pnpm vitest run packages/session/test/session.test.ts`: 13 passed (new: a run coalesces across minutes with the new
  label, another key starts a new entry, a different label without relabel does not merge, undo restores the document).
- `pnpm vitest run packages/project/test/sound-swap-role.test.ts packages/project/test/sound-set-peak.test.ts
  packages/project/test/sound-design-place.test.ts packages/project/test/fuzz.test.ts`: all passed — swap align start /
  end on the old frame; pitch +2 st = rate × 2^(2/12) keeping 1.012 variation, +5.5 st = Pitch Shifter 5 st 50 cents,
  0 removes it, the aligned point within 1 flick each time; pan keys keep their sequence times (≤ 1 flick) through a
  pitch change and travel with `frame`; setRole on a placed and an unplaced library clip, undo / redo, every refusal
  (`E_NOT_FOUND`, `E_INVALID_PARAM` video / project audio, `E_SCHEMA`, `E_TRACK_LOCKED`); setPeak on project audio. AC-25
  draws setRole and swaps with align / pitch.
- After merging `feat/sound-design` (4d2fdd55, WP2.3): `pnpm vitest run --project @jasper/project --project
  @jasper/session --maxWorkers=4` → 166 files, 1942 tests passed; web sound / keymap / menu / i18n / properties + MCP
  sound tests → 20 files, 168 passed; `pnpm vitest run --project @jasper/web --maxWorkers=3` (before the merge) → 115
  files, 824 passed. `pnpm typecheck`, `pnpm lint` (Biome, tokens, anime, layers, assets), `node scripts/i18n.mjs --check`
  (9 130 strings), `pnpm notices --check`: pass.
- `apps/web/test/sound-fill-swap.test.tsx` (14): fill = one entry "Fill Cue Crunch", hero role, 3 alternatives without
  the chosen sound, rate within ±2 %, the peak in [90, 91) frames, undo = the document before; Add Layer on another
  track, linked, "Layer 2 of 2", selecting one selects both, Unlink / Link; Fill Unfilled Cues (4 cues) one entry, no
  sound twice in a row, the same titles on a second run, muted cues left out; variation ×3 = ONE entry "Swap Sound ×3",
  the alternatives in order, Previous goes back ("×4", still one entry), one undo restores the sequence; another edit
  closes the run; Audition on swap seeks to cue − 1 s, plays, returns, no history; Replace mode label and swap keeping
  track / gain / role / cue / peak frame; In Context: the transient holds the candidate on the cue, the committed
  document is the same object, transport at cue − 60 frames playing, at the window end it stops and returns to the cue;
  Replace mode mutes the replaced clip in the transient only; a key press ends it; Align Peak / Nearest Cue / Set Peak
  / Role / Palette add + remove; Add Layer… opens Fill mode with layer intent; Detect Peak finds a click at 0.75 s within
  3 ms; at 29.97 fps the point placed on 75 is 75 and Align Peak to an aligned clip is a no-op.
- `apps/web/test/sound-fill-ui.test.tsx` (9, testing-library): the Library fills with Enter in Fill mode (the chip goes);
  the Replace banner text, similarity ranking, Enter swaps, Esc leaves; the palette strip and Palette only; the In
  Context toggle and Shift+Space (aria-live "Playing Thud in context", transient set, no history); a sound dragged over a
  glyph marks it `data-drop-target` and the drop runs `sound.fillCue`; Fill With loads 3 sounds (the fixture has 3),
  hover auditions in context, unhover stops; the clip menu entries; badges (`clipBadges` and the rendered SFX button /
  Hero img); Essential Role / Align / Pitch with undo; Properties Sound credit line equals `soundCredits` text; Cue role
  and frame edits move the filling clip.
- `pnpm build`, then `E2E_PORT=49605 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-fill.spec.ts`: 1 passed
  (1.1–2.9 min; five runs while fixing the spec). In the built app with the starter kit: Suggest Cues on four solids and an
  `sfx: boom` marker → double-click the cut glyph at 75 → Enter fills it ("Fill Cue …", alternatives stored, point in
  [75, 76)); Essential Role ▸ Hero ("Sound Role"); Ctrl+Alt+. three times → ONE more History entry, last label "Swap Sound
  ×3", the sound changed, the point still on 75; Alt+Shift+S → banner "Replacing … on A4 at 00;00;02;15 · Enter to swap ·
  Esc to cancel", Enter swaps, the banner and the similarity chip go; Add Layer… from the clip menu → "Add Layer …" on
  A5, linked, point on 75; dragging the first layer 10 frames moves the other by the same amount, Ctrl+Z; Properties ▸
  Sound (credit line) and ▸ Cue (00;00;05;00); Shift+Space with the cue at 150 selected → the chip "Auditioning: …",
  then hidden, `doc.revision` and History unchanged, playhead back on 150; Fill With ▸ lists ranked sounds; Fill
  Unfilled Cues → one entry "Fill Unfilled Cues (n)", every cue filled; native export, decoded with ffmpeg: for the three
  single-layer peak-aligned fills (cues 150, 225, 270; speeds 0.985–1.011 from the variation) the registered media,
  varispeed by the clip's speed (`asetrate`), cross-correlated into the mix (r ≥ 0.996) puts the peak at **0 samples**
  from where the document puts it in every run (one run: −1 sample at cue 150), i.e. on the cue frame.
- Phase 0 / 1 / 2 sound e2e after the merge: see "Gate" below. `e2e/sound-p0-transport.spec.ts` "Play: the first samples…"
  is load-sensitive on this host on the integration branch too: interleaved runs (load 9–38) of the integration build
  (4d2fdd55, a temporary worktree) and this branch failed its 20 ms A/V check 2 of 3 times each; at load ≈ 10 both pass
  the whole Phase 0 spec set (10 passed each, run back to back). Not a regression of this package.
- Looked at (`test-results/e2e-sound-fill/`): the filled clip's close-up badges (name, "H", SFX bolt), Essential Sound ▸
  Sound Design (Hero / Peak selected, 0 st), the Replace banner over the Library, the clip context menu (the new block
  with shortcuts; Set Peak at Playhead disabled off the playhead), the cue menu with Fill With ▸ five sounds
  ("Crunchy impact · Hit · 1.3 s"…), the Program chip "Auditioning: Crunchy impact" with the candidate drawn in the
  transient timeline, Properties ▸ Sound and ▸ Cue, every cue filled. The first look found the "Similar to" chip left
  behind after a swap (now cleared with the mode) and the Sound section missing for a linked selection (now the first
  clip of up to 16).

#### Gate

After merging `feat/sound-design` (4d2fdd55) and `pnpm build`: `E2E_PORT=49605 E2E_SKIP_BUILD=1 pnpm exec playwright test
e2e/sound-fill.spec.ts e2e/sound-cues.spec.ts e2e/sound-library.spec.ts e2e/sound-p0-preview.spec.ts
e2e/sound-p0-transport.spec.ts` (load ≈ 39): 13 passed, 2 failed — `sound-p0-transport` "Play: the first samples…"
(its 20 ms picture − audio check) and "a latency change during playback". Reruns of `sound-p0-transport.spec.ts` alone:
4 passed / 1 failed ("first samples…") at load 37–38 twice and at load 14 once; before the merge the whole Phase 0
set (`sound-p0-preview` + `sound-p0-transport`, 10 tests) passed on this branch at load ≈ 10, as it did on the
integration build run right before it. Measured flake rate of "first samples…" with interleaved runs (load 9–38):
integration build 1 pass / 3, this branch 1 pass / 3, with the same failing signature (the primed offset 30–50 ms below
the unprimed baseline) on both: a timing-sensitive test on this shared host, not a regression of this package (whose
only Program-side addition is an overlay that renders nothing unless an audition plays; removing it did not change
the result, measured with a build that disabled it). `sound-fill` measured 0, −1 and 0 samples at cues 150, 225, 270 in
that run.

#### Limits and notes for the next packages

- Variation cycling, Align and Pitch act on the whole selection; with Linked Selection on, selecting a layer selects
  its linked layers too (Alt-click one to cycle it alone).
- Fill Unfilled Cues applies directly; Phase 3 should turn it into a proposal (`fillUnfilledCues` returns the picks and
  skipped cues, the planning part is separable).
- Detect Peak analyses ≤ 120 s of the clip in the browser; very long clips need an engine route (P5/P6).
- The In Context audition takes the gesture slot: while it plays, a timeline drag ends it first (any pointer press
  does), and an agent's transaction ends it (Phase 2 verification; before, agent transactions queued until it ended).
- Badges: "H" and the chain need 80 px of clip width; below that only the type glyph and the licence dot show.
- Swap does not rename a clip whose name the user changed; library clips are named after the registered file
  (`soundDesign.swap` renames when the name is the old file name).
- Auto gain with its reason, Room send and Stop before next in Essential Sound are Phase 4 (P4 owns the levels).

### Phase 2 verification

Branch `feat/sd-p2-verify` (from `feat/sound-design` 780670c4). Three review passes ran in parallel on their own
branches and were merged here: the model and history (`feat/sd-p2v-model`), the agent surfaces and model-string i18n
(`feat/sd-p2v-agent`) and the web UI (`feat/sd-p2v-web`); their findings are the three sections below. This section is
the requirements audit, the lead's own fixes, the real-app and agent runs and the gate. Every fix, here and below, has
a regression test that was run against the unfixed code and failed there (one exception, said where it is: the model
review's cue-id length bound, already refused before by another check). Shared host, 16 cores; the load is stated
per run.

#### Requirements (spec 12 Phase 2) with evidence

| Req | What | Where | Evidence (all pass on this branch) |
|---|---|---|---|
| P2-R1 | `soundDesign`, `SoundCue`, `CueAnchor`, `AudioClip.sfx`, repair (dangling anchors → null with a note, missing placed clips, `sfx.cueId` → null, frames clamped; idempotent; no schema bump) | `packages/project/src/schema/sound.ts`, `sound/repair.ts`, `invariants.ts` (INV-SOUND / INV-SFX), `migrations.ts` | `sound-cue-commands.test.ts` (repair of unreadable data, dangling anchors, pruned / unlinked clips, shared ids, 300-run `loadProject` property), `sound-p2v-model.test.ts` (repair twice = once over hostile values; ordinary edits never `E_INVARIANT`; the two-way cue link), `fuzz.test.ts` (AC-25 with the sound commands) |
| P2-R2 | `soundCue.add / update / remove / resync`, `soundDesign.place / swap / setPalette` (+ `setSettings`, `setPeak`, `setRole`), undo, redo, refusals | `commands/schemas/sound.ts`, `commands/handlers/sound.ts`, `catalog.ts`, `apps/mcp/src/examples.ts` | `sound-cue-commands`, `sound-design-place`, `sound-swap-role`, `sound-set-peak`, `sound-p2v-model` (undo / redo of all ten commands; every refusal code each can return: `E_NOT_FOUND`, `E_INVALID_PARAM`, `E_TRACK_KIND`, `E_TRACK_LOCKED`, `E_OVERLAP`, `E_SCHEMA`, `E_LIMIT`, the document unchanged), `apps/mcp/test/sound-examples.test.ts` (every example applies) |
| P2-R3 | `deriveCues` from every project source (edits, transitions, keyframes, text, mg, clip edges, 3D cameras, markers), merge within 2 frames, budgets; never throws, respects budgets on fuzzed documents | `packages/project/src/sound/cues/*` | `sound-cues.test.ts`, `sound-cues-property.test.ts` (generated documents: never throws, integer frames in range, sorted, deterministic, ≤ the density's cues per 1 s window, heroes spaced; testkit fuzz with hostile options), `sound-p2v-model.test.ts` (same cues whatever the storage order), the sampling budget test (agent review) |
| P2-R4 | placement math §2.3: `sourceIn ≥ 0`, error ≤ 1 frame, exact sample when the head is quiet; verified on exported audio at 23.976, 25, 29.97 DF, 30, 50, 59.94, 60 | `sound/place.ts`, `sound/insert.ts`, `apps/engine/src/sounds/pad.ts` | `sound-place.test.ts` (3 000-run property + 1 000 at the NTSC rates), `sound-design-place.test.ts` (150-run property through the command), `apps/engine/test/sound-placement-export.test.ts`: 28 clicks at the 7 rates exported (native, 24-bit PCM) and decoded: **0 samples** each; new here: the ±2 % variation and +3 st varispeed, **≤ 1 sample** (mutation: placing without dividing by the rate fails it by 262–3 439 samples) |
| P2-R5 | layers (separate SFX tracks, grouped / linked), rotation (`pickVariant`), ±2 % / ±1 dB variation, pitch (varispeed ≤ 3 st, else Pitch Shifter), pan (static, keyframed sweep), auto tracks, `soundCue.resync` | `handlers/sound.ts`, `sound/variant.ts`, `sound/anchor.ts` | `sound-design-place.test.ts` (layers, auto / preferred tracks, pitch, pan, `pickVariant` round robin + 500-run property), `sound-p2v-model.test.ts` (pitch at exactly ±3 st, resync after trims / speed changes, a clip in two cues moves once, split clips), `sound-placement-export.test.ts` (varispeed on export) |
| P2-R6 | `POST /api/sound-design/cues`; MCP `find_sound_cues`, `set_sound_cues`, `place_sound` (apply), `swap_sound`, `align_peak` | `apps/engine/src/routes/sound-design.ts`, `packages/api/src/sound-design.ts`, `apps/mcp/src/tools/sound-design.ts` | `apps/engine/test/sound-design-cues.test.ts` (fixture with the real template registry, typed 4xx, fuzz, auth, **the web planner and the route give the same cues** for four option sets), `apps/mcp/test/sound-cues.test.ts` (real engine, stdio; strict arguments; swap cycling across calls), `readme-tools`, `conventions`, `sound-guide`, `fuzz` (MCP) |
| P2-R7 | Cue Seam (glyphs, states, editing, keyboard), Suggest Cues…, Fill (Enter, drop on a cue), peak handle, peak snapping, variation cycling with coalesced history, Add Layer…, Link / Unlink, In Context audition, clip badges, clip context menu, menus, shortcuts, Properties "Cue" / "Sound" | `apps/web/src/sound/**`, `commands/sound-{cues,design}.ts`, `keymap-defaults.ts`, `shell/menus/model.ts`, timeline `layout` / `snapping` / `gestures` | `sound-cue-seam-model`, `sound-cue-seam`, `sound-cue-commands`, `sound-fill-swap`, `sound-fill-ui`, `sound-i18n`, `sound-p2v-{in-context,variation,seam,suggest}` (web), `packages/session/test/session.test.ts` (coalescing), `keymap.test.ts` (no conflicts in any preset), `e2e/sound-cues.spec.ts`, `e2e/sound-fill.spec.ts` |
| Done when | on a fixture with a push, a keyframed logo, a text animator and cuts: Suggest Cues finds each event with a reason; fills land on the cue frames in the exported audio; undo / redo everywhere; an agent can do the same | `e2e/sound-p2-done.spec.ts` (new), the MCP run below | measured below (user and agent paths, two export paths) |

Definition of Done items for this phase: model + schema + repair (P2-R1); undoable commands with refusal tests
(P2-R2); UI wired with menus (Sequence ▸ Sound Design, Markers, Clip ▸ Audio Options, cue and clip context menus) and
Premiere-style shortcuts without conflicts (`keymap.test.ts`; Alt+Shift+C, Alt+Shift+S, Ctrl+Alt+. / , and Ctrl+Alt+P,
explicit Opt+Cmd on mac; none of Alt+M, `[` / `]`, Alt+Shift+< / >); preview and every export path render it (placed
sounds are ordinary audio clips with speed, gain, pan keyframes and the Pitch Shifter: measured on the native and
the Remotion exports below; cue data are metadata only); MCP tools with README list (338 tools), `SOUND_GUIDE` and
examples; tests (unit, property / fuzz for untrusted input, oracle against ffmpeg-decoded exports); run in the real
app with screenshots looked at; no new assets; i18n (es.json complete, History labels and model refusals in
Spanish through the model-strings mechanism, agent review); design tokens (`check-tokens`); this wp-note.

#### Fixes made in this pass (lead)

- **Lossy library sounds played up to 2.7 ms late (found in the real MCP run).** A starter-kit Ogg Vorbis sound whose
  head is already quiet (≥ 50 ms) was registered as the Ogg itself. Its descriptors (the peak) are measured on the full
  decode, but every export path seeks into the file for a clip whose In point is not 0, and ffmpeg's seeked Vorbis
  decode is 128 samples off its full decode: "Blade swish" on the mg exit cue measured **+129 samples** in the Remotion
  export of the Phase 2 fixture (every other point ≤ 1). `SoundService.register` now writes a PCM WAV copy of any
  non-PCM sound of ≤ 120 s (no silence added when the head is quiet; `pad.ts` takes 0 samples). Regression:
  `sounds-routes.test.ts` "an Ogg Vorbis sound with a quiet head becomes a WAV copy whose samples are its full decode"
  (failed before: registered in place, same fingerprint); after the fix the same run measured 0–1 sample everywhere.
  Sounds over 120 s (beds) stay as they are (limit below).
- **A copy of a filled SFX clip acted as the cue's filler** (reported, left open by the model review; decided here):
  the cue link is two-way — a clip fills a cue only when the cue's `placedClipIds` lists it. Swap no longer rewrites the
  cue's sound list from a copy, `setPeak` does not measure a copy against the cue, web `cueOfClip` and the MCP tools
  (agent review) follow the rule, and loading clears the one-way id with a note. Regression: `sound-p2v-model.test.ts`
  "swap / setPeak on a copy leave the cue alone; loading clears the copy's cue id" (failed before: the cue's
  `soundIds` changed).
- **MCP `swap_sound` next / previous alternated between two sounds forever** for a sound placed without alternates
  (found in the real run; fixed by the agent review, and the same cross-run drift in the web by the web review).
- `e2e/sound-fill.spec.ts` did not typecheck (`pnpm e2e:typecheck`: `Sfx` lacked `alternatives`).
- **The first key pressed during an In Context audition only ended it** (web review's open item: Ctrl+Z did not undo).
  The keymap dispatcher gained a pre-key hook (`onBeforeKey`, `shell/keymap/dispatcher.ts`) and the audition ends
  itself there, before the key resolves. Regression: `sound-p2v-in-context.test.tsx` "Ctrl+Z ends the audition and
  undoes the last edit in the same press" (failed before: nothing undone).
- **A cue stored under the key `__proto__` loaded as an invalid project** (found by the model review's repair property in
  the gate run, seed −51879175): zod's record parser skips a `__proto__` key, so INV-SOUND passed the sound design
  without reading that cue; repair kept it (renamed) and the loaded document failed INV-SOUND (`frame` undefined).
  `soundDesignIssue` now flags a record whose parsed cues are fewer than its own keys, so the lenient reader drops or
  reads the cue. Regression: `sound-p2v-model.test.ts` 'a cue stored under the key "__proto__"' (failed before with the
  INV-SOUND issue); the property then passed 3 more full runs.
- **Variation runs and the selection** (decision): the web review made any selection change close a run, which broke
  the WP2.4b e2e (Esc to stop the audition on swap, a click on the clip, the next press: "Swap Sound" instead of "Swap
  Sound ×2"). Now a selection of *other* clips closes the run (even if the user comes back before pressing); an empty
  selection or the same clips again continue it. `sound-p2v-variation.test.tsx` was changed to that decision (failed
  before the change with 5 entries instead of 4).
- New coverage: `e2e/sound-p2-done.spec.ts` (the "Done when" end to end) and the varispeed export oracle.

#### Real app and agent runs (measured)

- **Built stack** (`pnpm build`; `E2E_PORT=49705 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-cues.spec.ts
  e2e/sound-library.spec.ts e2e/sound-fill.spec.ts e2e/sound-p2-done.spec.ts`; load 31–108): on the final code all
  **6 tests pass** — sound-cues 1 and sound-library 3 in one run, sound-fill 1 and sound-p2-done 1 in the run after the
  variation-run fix (the run before it failed both at "Swap Sound ×2", which is how that regression was found).
  `sound-fill` measured its three single-layer fills at 0, +1 and 0 samples from their cue frames (native export);
  `sound-library` its five inserts at 0 samples.
- **`e2e/sound-p2-done.spec.ts`** on the Phase 2 fixture (`apps/mcp/test/sound-cues-fixture.ts`: cuts at 90 / 330, a
  20-frame push at 180, a logo keyframed 200 → 1010 → 960 px, a typewriter title, a lower third, an `sfx: boom+swoosh`
  marker; 29.97 fps): Sequence ▸ Sound Design ▸ Suggest Cues… "17 cues: 1 hero, 15 support, 1 ambient" (edits 2,
  transitions 1, keyframes 2, text 8, motion graphics 2, edges 1, markers 1; every cue has a reason) → `POST
  /api/sound-design/cues` on the live document returns **the same 17 cues** (frame, kind, weight, anchor) and matches each
  to the stored one → Fill Unfilled Cues: ONE History entry, every cue filled, each aligned point in [cue, cue + 1 frame)
  → Next Variation ×2 = ONE entry "Swap Sound ×2"; one Ctrl+Z restores the sequence **exactly** (canonical JSON), redo
  the swapped one → Add Layer… (linked, another track, same point) → three undos give the sequence before the fill
  exactly, three redos the final one → export (the planner chose Remotion: the lower third needs the fframes renderer,
  which the e2e build lacks) decoded with ffmpeg; each fill's media, varispeed like its clip, located by normalised
  cross-correlation over 50 ms around its aligned point: **18 points, −0.8 … +1 sample** from where the document puts
  them, all on their cue frames (r 0.55–1.0 for sounds alone; 0.26 for a click under a louder layer, lag still 0).
- **Agent path** (built engine on 49703, fresh appdir, full kit + 19 synth; jasper-mcp from source over stdio; scratch
  client): `find_sound_cues` → **the same 17 cues as the editor's Suggest Cues** (frames, kinds, weights, types and
  reasons identical; the MCP project is 30 fps, the editor's 29.97); `set_sound_cues` all 17 in one transaction
  ("Sound Cues (add 17)"); `place_sound {cueId, layers: [{sound: {type}}]}` for each (the marker with boom + whoosh):
  every clip `errorFlicks` 0, `peakFrame` = cue; `swap_sound` next ×3 → three different sounds (index 2, 3, 4 of 24),
  previous ×3 → back to the original (before the fix: A, B, A, B and `E_OVERLAP`); `start_export` (Remotion) decoded:
  **18 points, −1 … +1 sample** (before the Ogg fix: one at +129). Mix peak 0.95 (true peak +3 dBTP in another run: levels
  are Phase 4).
- **Varispeed on both export paths** (scratch, same engine): a click 0.45 s into a sound placed at rates 0.98, 0.9817,
  1, 1.0123, 1.02, exported native and Remotion as 24-bit PCM: sub-sample peak 0, −0.65, 0, +0.18, 0 samples from the cue
  on **both** paths (identical). An earlier e2e run's +10 samples on a broadband whoosh was a correlation artefact (r 0.90;
  the click measurement shows the placement is exact).
- **Looked at** (`test-results/e2e-sound-p2-done/`, `e2e-sound-fill/`, `e2e-sound-cues/`): the Suggest Cues dialog with
  per-source counts; the final timeline (Cue Seam with 17 glyphs and connectors to the clips on A4, Essential Sound ▸
  Sound Design "Layer 1 of 2", toast "Added Heavy metal hit as a layer of the Support Cut cue at 00;00;03;00 on A5");
  the Program chip "Auditioning: Crunchy impact" with the candidate drawn in the transient timeline; the cue menu with
  Fill With ▸ five ranked sounds; the seam after Suggest Cues with the Properties "Cues · 14 cues selected".

#### Gate

Shared host, 16 cores; other agents' load stated per run.

- **Gate 1**, `pnpm verify` on `feat/sound-design` 780670c4 before any change (load 8 → 43): lint, typecheck, test (626
  files: 576 passed, 50 skipped; **6 006 tests passed, 0 failed**, 392 skipped; 970 s) and build passed; 21 min 41 s.
  `pnpm notices --check` current; `pnpm e2e:typecheck` failed (`e2e/sound-fill.spec.ts`), fixed.
- **Gate 2** (the merged branch): typecheck failed on the lead's own new test — its assertion read a field the History
  view does not have, so it passed vacuously; with a real assertion it failed, which is how the In Context key fix
  above was found.
- **Gate 3**, `pnpm verify` at ddefa773 (all reviews merged; load 82 → 124): lint and typecheck passed; test 633 files:
  579 passed, 5 failed, 49 skipped; **6 101 tests passed, 6 failed**, 388 skipped (55 min). One failure was real: the
  model review's repair property found the `__proto__` cue (fixed, 399482d9). Five were timeouts outside sound design:
  `tracking` "lands on the exact frames after an input seek" (5 s), `time-export` VFR (180 s), `gaps-avc3-playback`
  (36 of 45 frames seen in Electron), `camtrack-solve` ×2 (120 s / 180 s). Rerun alone (`--maxWorkers=1`, load 65–100):
  tracking, time-export and gaps-avc3-playback pass; camtrack-solve timed out again (140 s / 120 s, 366 s / 240 s), then
  passed alone at load 55–79 (**12 / 12**, 9 min). So every gate-3 failure is either fixed or passes alone. This branch changes no engine code outside `apps/engine/src/sounds/{pad,service}.ts` (`git diff
  780670c4..HEAD -- apps/engine/src`), and camtrack-solve passed in gate 1.
- **After the last fixes** (after gate 3 only `packages/project/src/schema/sound.ts` and `apps/web/src/sound/swap.ts`
  changed): `pnpm lint`, `pnpm typecheck`, `pnpm build` pass; `pnpm vitest run --project
  @jasper/project --project @jasper/session --project @jasper/web --project @jasper/mcp --maxWorkers=4` (load 58–80):
  **333 files passed (2 skipped), 3 392 tests passed, 0 failed**; the engine and MCP sound suites after the Ogg fix (`sounds-*`,
  `sound-design-cues`, `sound-placement-export`, `apps/mcp/test/sound*.test.ts`): 9 files, 87 passed; after the
  merges the sound set (project, session, MCP, engine route, web sound and i18n tests): 56 files, 804 of 805 passed, the
  one failure an MCP test precondition the two-way link changes (adjusted, rerun 6 / 6); the e2e above; `pnpm notices --check` current (150 packages, 31 ported
  records); `node scripts/i18n.mjs --check`: es.json covers all 9 177 strings; README lists 338 tools.

#### Limits (after this pass)

- Sounds over 120 s (beds) are registered as they are: a lossy one seeked by an In point can play up to 128 samples
  (Vorbis) late, and the ≤ 1-frame rule applies to their peak / end alignment.
- `pitchSt: 0` after a fractional varispeed shift keeps up to ±0.5 st (model review).
- Razoring inside a transition's span fails with `E_INVARIANT` for any clips (`clip.split`, edit-structure; not sound).
- Essential Sound Role / Align radio groups have no arrow-key navigation (web review).
- `set_sound_cues`' label counts skipped (already stored) suggestions in "add n"; "Undo <label>" in the Edit menu is
  composed in English for every feature (agent review).
- Levels: kit sounds at 0 dB overlap above 0 dBFS (true peak +3 to +5 dBTP measured in these runs): Phase 4. Since
  Phase 2 verification B (§3) placement gives each sound a default level by role (the filled fixture exports at −5 dBTP).

### Phase 2 verification: model review (`feat/sd-p2v-model`)

A review of the cue model, placement commands, repair and coalesced history for real bugs; each fix came with a
regression test that failed before it (run against the unfixed code first). Tests: `packages/project/test/
sound-p2v-model.test.ts`, `packages/session/test/session.test.ts`.

| Finding | Fix | Regression test (failed before) |
|---|---|---|
| `repairDocument` was not idempotent: the final transition pass ran after the sound-design repair, so a cue anchored to a transition that pass drops kept a dangling anchor until a second repair (`drop-cue-anchor`) | sound-design repair runs last | "a cue anchored to a transition the final transition repair drops is tidied in the same pass" |
| `soundDesign.swap` refused (`E_INVALID_PARAM`, "would start before frame 0") a sound placed near frame 0 with `clampStart` — even swapping it for itself (variation cycling at the sequence start) | an in-place swap of a clip at frame 0 clamps like the insert (head trimmed, aligned point exact; `trimmedHeadSec` in the result); onto a `frame` it stays refused | "a sound placed with clampStart … can be swapped, also for itself"; "a clip at frame 0 re-aligned onto an earlier frame … is refused" |
| `soundDesign.swap` to a shorter sound with a fade on the clip's edge failed with `E_INVARIANT` (INV-010, transition longer than the clip) | edge transitions are shortened to the new length (`W_TRANSITION_SHORTENED`); crossfades whose cut moved are removed by the cleanup as before | "a fade longer than the new sound is shortened to fit, never E_INVARIANT" |
| A razor / split of a filled SFX clip left the right part out of the cue's `placedClipIds`: `soundCue.resync` / `update` then moved only the left part into the right one (`E_OVERLAP`, resync impossible) and `remove withClips` left half the sound behind | `splitClipAt` → `followSfxSplit`: the right part joins the cue after the left one (when the cue is full it forgets the cue); `soundDesign.place` numbers new layers after the cue's highest layer (the two parts are one layer) | "both halves fill the cue: resync, update and remove withClips move or lift both"; "the two parts are one layer…" |
| History merged a coalesced commit into the entry below an undone one (or into a redone entry): one Undo then reverted edits from both sides of the undo (runs with `coalesceWindowMs: Infinity` and 750 ms nudges alike) | `History` merges only into the entry it pushed last; undo, redo and clear close the run | "never coalesces across an undo or redo, even with the same key and window" |
| `soundCue.add` accepted a cue `id` of any length (refused later, the message echoing it) | schema bound (128) | "non-finite numbers, oversized arrays and strings are refused…" |

Gaps filled (tests only): undo / redo of all ten Phase 2 commands; the refusal codes without a test (update anchor
`E_NOT_FOUND`, `E_SCHEMA` of update / remove / resync, resync before frame 0, every swap `E_INVALID_PARAM`, palette
`E_LIMIT`); a repair-idempotence property over two sequences with hostile cue / sfx values (prototype-named keys,
NaN / ±Infinity / negative / huge frames, 5 000-entry `placedClipIds`, ids of video clips, other sequences' clips and
cues); ordinary edits (delete clip / transition / marker / track, ripple delete, razor, duplicate, sequence.duplicate,
nest, trim, speed) never meet `E_INVARIANT` from soft references and load tidies them in one pass; swap keeps gain,
pan / volume / effect keyframes (sequence times), markers, group, link, role, cue, alternatives, enabled, name and
Essential type at speed ≠ 1; resync after trims and speed changes, a clip filling two cues moves once; pitch plan at
|st| = 3; agents' unknown keys at any depth; deriveCues independent of storage order (property); a 5-step coalesced
run undoes to the exact document before its first step, redoes to its last, and every step dirties and is announced.

Not fixed (reported): razoring inside a transition's span fails with `E_INVARIANT` (INV-010) for any clips, not only
sound (`clip.split`, edit-structure); a copied / duplicated / pasted SFX clip keeps its `sfx.cueId` without being one
of the cue's placed clips (resync does not move it, a swap of it rewrites the cue's `soundIds[layer]`) — decided and fixed by
the lead (the cue link is two-way, "Phase 2 verification" above); `soundDesign.swap {pitchSt: 0}` after a fractional varispeed shift
(e.g. 2.5 st) keeps up to ±0.5 st, because the seeded variation and a fractional shift cannot be told apart from the
clip speed alone (the pitch is not stored).

### Phase 2 verification: agent surfaces (branch `feat/sd-p2v-agent`)

Review of the cue route, the MCP cue tools and model-string i18n. Each fix has a regression that failed before it.

- **Same cues on both surfaces.** The route (and so `find_sound_cues`) bound active expressions before `deriveCues`, the
  editor's Suggest Cues… did not: an expression-driven graphic gave 19 cues on the engine, 17 in the dialog. Decision:
  binding is right (cues follow what the Program monitor shows). `planSuggestion` binds; the dialog waits for the
  expression engine (`useExpressionsFor`). `apps/engine/test/sound-design-cues.test.ts` runs the web planner and the
  route on the same envelope (defaults, In–Out range, sparse without dialogue, a source subset) and compares every cue.
- **Sampling budget.** `deriveCues` sampled every frame of every animated clip (20 000 per clip, no total): measured
  2.2 s for 20 clips × 20 000 frames on this shared host, so a 20 MB envelope could block the engine for minutes and
  `curves: true` return gigabytes; camera sampling also tested every camera per frame. The keyframes and camera3d
  sources now share `MAX_SAMPLES_PER_DERIVATION` (400 000 frames; a camera frame costs 1 + overlapping cameras) and warn
  once (`W_SAMPLING_TRUNCATED`); deterministic (clip order).
- **swap_sound cycling across calls.** Without `sfx.alternatives` the cycle was anchored on the current sound and
  `next` alternated between two sounds (lead's real run). `soundDesign.swap` gains optional `alternatives` (the ring);
  `swap_sound` stores `[the sound playing now]` on a clip without a ring in the same transaction. Decision: a cycle
  candidate that does not fit on the track (`E_OVERLAP`) is skipped for the next one in the same direction (≤ 4 tries,
  listed in `skipped`); the explicit `to: soundId` still fails. The web's Next/Previous Variation has the same
  cross-run re-anchoring (left to the web reviewer / lead).
- **Two-way cue link in MCP:** `align_peak` (own cue, `withLayers`, note) and `place_sound`'s hero check use a clip's
  cue only when its `placedClipIds` lists the clip (a duplicate fills nothing).
- **Arguments:** `set_sound_cues` refuses an inverted `window` (it was silently dropped), `storedCueId` ≤ 128;
  `find_sound_cues` refuses a range past `maxFrame` with the time hint (was the route's raw zod dump).
- **i18n (model strings, the existing mechanism):** `@jasper/project` exports `SOUND_LABELS` (MCP builds its History
  labels from them) and `SOUND_MESSAGES` (refusal templates; `test/sound-messages.test.ts` checks every refusal written
  in the sound handlers and planners has one, except `peakAlignedStart`'s developer input checks). `model-strings.ts`
  lists them plus "Agent"; `translateName` now also matches templated model names (whole text, or a part between
  separators, so "Agent: Sound Cues (add 2, edit 1)" → "Agente: Señales de sonido (añadir 2, editar 1)"); the filled
  values (ids, titles, numbers) are kept. The web's own labels (Fill Cue, Add Layer, Swap Sound ×n, Suggest Cues (n),
  Fill Unfilled Cues (n), Add Sound) were already translated by `t()` / the build transform at commit.
  Limits: labels are stored in the language they were committed in; "Undo <label>" (`commands/edit.ts`) is still
  composed in English (pre-existing, every feature).

### Phase 2 verification: web UI (fill, swap, In Context, Cue Seam)

Review of the WP2.4a/b web code against spec 12 §2.7 / P2-R7 (branch `feat/sd-p2v-web`). Every fix has a regression test
that failed before it (each run on the unfixed code first); the gap tests that passed are marked.

Fixed:

- **In Context audition exit paths** (`sound/in-context.ts`): in the Sound Library list (a `role="listbox"`, so its keys
  reach the panel after the audition's capture listener) Shift+Space and Space restarted the audition instead of
  stopping it, and Esc stopped it *and* left Fill / Replace mode — the key that ends it is now remembered for that
  event (`inContextEndedBy`) and the toggles honour it. An audition or swap window replacing another started from
  wherever the previous window had got to (coalesced variation presses returned the playhead mid-window; a second hover
  anchored on the moving playhead): the previous one now returns first. The project closing or another sequence becoming
  active ends it (also while it registers its sound). An agent's transaction ends it instead of queueing behind the
  gesture (`agent-bridge/hooks.ts`). A watchdog ends a window whose frames never move (no Program monitor attached), which
  held the gesture — and with it Undo, agents' edits and autosave — until the next key press. An error while starting
  (a Program player throwing on play) cancels the gesture and clears the chip instead of rejecting with the gesture held.
  A superseded audition is not reported as a failure; closing the panel stops it; hover with the In Context toggle on
  plays in context as documented (it played alone). Fill With ▸ hover auditions on the cue of the menu (it used Fill
  mode's cue or the last selected cue). Tests: `apps/web/test/sound-p2v-in-context.test.tsx`.
- **Variation cycling** (`sound/swap.ts`): a failed step (engine offline) advanced the cycle and the count (the next
  press skipped a variation, the label counted swaps that never happened); selecting other clips now closes a run (the
  lead narrowed the review's "any selection change": Esc and a click on the same clip between presses continue the run,
  as the WP2.4b e2e does; the gate's e2e failed with "Swap Sound" instead of "Swap Sound ×2" under the broader rule); Next /
  Previous Variation are disabled for project audio whose only `sfx` is a detected peak (every press failed). Tests:
  `apps/web/test/sound-p2v-variation.test.tsx`.
- **Variation cycling across runs** (`sound/swap.ts`, `sound/fill.ts`): each run rebuilt the list around the sound the
  clip played (index 0 = current, `similarTo` current), so after another edit the next press went backwards and the
  original was lost. The list is now anchored on the clip's ring (`sfx.alternatives`, original first — the convention of
  `soundDesign.swap {alternatives}` and MCP `place_sound` / `swap_sound`): Fill and Fill Unfilled Cues store
  [chosen, …up to 3 ranked], and the first variation step of a clip without a ring stores [the sound it plays] in the
  same coalesced step (undone with it); a run starts at the clip's current sound in that list. The three existing
  assertions on Fill's stored alternatives were updated to the ring format (same strength: exact contents).
- **One toast per failure**: Fill Sound Cue, Fill Unfilled Cues, Detect Peak and the variation commands toasted their own
  warning and rethrew, so the runner added a second "… failed" toast; they throw `ReportedCommandError`
  (`commands/registry.ts`): agents still get `ran: false`.
- **Suggest Cues…** derived on the raw document, the engine route on the document with expressions bound: an
  expression-driven slide-in gave move@14 + land@30 through MCP and nothing in the dialog. Found by this review and the
  agent-surface review at the same time; the merge keeps one implementation (the agent review's, which also disables
  Suggest until the expression engine has loaded) and both reviews' tests (`apps/web/test/sound-p2v-suggest.test.tsx`).
- **Cue Seam / peak handle** (`sound/cues/{CueSeam,PeakHandle,model}.tsx`): Esc cancels a cue drag and a peak drag (Esc
  deselected the cues mid-drag and the release committed); a seam or handle unmounting mid-drag cancels its gesture (it
  stayed held forever); Shift-click / Shift+Arrow on a cue with clips selected selects the cue, and cues selected by
  commands (Suggest Cues on the selected clips, Next Cue, agents) stay selected — the domain selected last wins; the
  render cap thins evenly; `hitCue(NaN)` hits nothing. Tests: `apps/web/test/sound-p2v-seam.test.tsx` (max zoom-in and
  End / Home / Right revealing the cue are gap tests).
- **Sound Library modes** end with their target (cue or clip deleted, undone, another project): Enter failed under a chip
  naming a target that was gone. **i18n**: the row menu's "Insert at Playhead" was English in Spanish (a variable label
  the transform does not wrap).

Checked and left as they are: the keymap (Alt+Shift+C, Alt+Shift+S, Ctrl+Alt+. / , and Ctrl+Alt+P, mac Opt+…, have no
conflict in any scope of any preset — Premiere, Avid, FCP7, FCPX — on any platform; Shift+Space shares its chord only
with `transport.playInToOutPreroll` in the wider editing scope, which the Sound Library scope overrides on purpose);
`node scripts/i18n.mjs --check`, `check-tokens`, `check-layers`.

Fixed by the lead after this review: a key that ended an In Context audition was not also run when its command
refused during the gesture (the first Ctrl+Z only stopped the audition: the keymap resolved and ran the key before the
audition's window listener ended it). The dispatcher has a pre-key hook (`onBeforeKey`) the audition ends itself in;
regression "Ctrl+Z ends the audition and undoes the last edit in the same press" (`sound-p2v-in-context.test.tsx`,
real dispatcher and commands; failed before). Known, not fixed: the Essential Sound
Role / Align segmented controls are `radiogroup`s without arrow-key navigation (each option is a Tab stop).

### Phase 2 verification B

Branch `feat/sd-p2-verify-b` (from `feat/sound-design` 780670c4). Three problems: the Phase 0 transport e2e failing ≈ 2 runs
of 3, the motion-graphic land cue ≈ 0.3 s late (own section below), and library sounds inserted at 0 dB. Shared 16-core
host; load averages are stated per run (other agents drove it to 20–117 during this work).

#### 1. Phase 0 transport: "Play: the first samples…" (and the other Phase 0 e2e)

**Verdict: (b), not a regression — a latent defect of the close-out's picture wait plus a test that compared the wrong
things, made visible by load.** Evidence:

- Bisect anchor first: the close-out merge itself (09e3b50c, its own build in a scratch worktree) fails the test too:
  `E2E_PORT=49802 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-p0-transport.spec.ts -g "Play: the first"
  --repeat-each=4`, twice: 0/4 and 1/4 passed (load 30–50); integration HEAD 780670c4: 1/4 (load 9–46). The browser did
  not change in between (Chrome 150.0.7871.181, installed 2026-10-12 per `/var/log/dpkg.log`, before the close-out of
  2026-10-15). So there is no good commit to bisect from: the failure is in the close-out's design or in its test.
  Phase 1/2 commits touch no `packages/compositions/src` file (`git diff --stat 09e3b50c..HEAD`); their web audio
  changes (audition meter, decodeMediaRange) do not touch the Program transport. A probe of main-thread stalls caused by
  an edit during playback (`effect.add` while playing, 6 edits, scratch spec, not committed) measured no regression:
  09e3b50c median transaction 48 ms / longest animation-frame gap 53 ms, HEAD 21 ms / 33 ms (load 35–43). The
  latency-change test, 5 runs each at load 26–41: 09e3b50c 5/5 passed (2 of 7 plays disturbed), HEAD 4/5 (9 of 14
  plays disturbed) — the disturbed plays are Remotion reschedules under load in both builds.
- **The defect (fixed).** A debug build logged every `getOutputTimestamp` call of the shim. Chrome starts the audio clock
  before the main thread sees `state === 'running'`: calls arrived with `currentTime` 21, 29, 64 and 85 ms past the
  resume time while `state` still read `suspended`. The shim took its offset from the *last* call made while
  "suspended" (`waitFrom = currentTime`), so such a call shortened the wait or removed it (85 ms > the 41.6 ms wait:
  no wait at all). Measured picture − audio of those plays: −17 ms and −48 ms (the picture led the program). The offset
  must come from Remotion's own start reading (`waitUntilActuallyResumed` reads `currentTime` and the timestamp once,
  then polls). `PrimedStartClock` (`packages/compositions/src/audio/primed-clock.ts`, used by `MixGraph.attachSync`)
  latches the offset at the first call after the start is armed (Remotion's start reading: it calls synchronously in
  its `resume`, before anything else can), re-arms only on a stall during the wait (the `suspended` handler), and ends
  the wait only on a real reading (Chrome briefly answers `{currentTime, performanceTime: 0}` after a resume).
  Regression test `packages/compositions/test/audio-primed-clock.test.ts` replays Remotion 4.0.499's algorithm against
  the clock (the e2e trace, a late start reading, the transient readings, a stall, a 300-run property over clock start,
  output latency, poll interval and stray callers): 6 passed; the same tests against the old shim logic (scratch copy
  with a state lag) 5 of 6 failed.
- **The assertion was wrong.** It required primed picture − audio to equal an unprimed play's within 20 ms. The
  unprimed value is Remotion's resume-detection lag (it polls once per animation frame and Chrome reports no valid
  output timestamp for 10–20 ms after a resume): measured 14–90 ms, varying with load. A primed start hides that lag
  inside its wait (logs: `primed` 0.0001, `base` 0.0205 in the same session), so a correct implementation failed
  whenever the lag exceeded ≈ 20 ms. The test now checks what the close-out promises: (1) the first click is heard
  exactly `wait + 30 ms` after the resume (one render quantum tolerance; was "< 0.2 s"), at both waits; (2) the picture
  never shows sequence time 0 before the program's sequence time 0 is at the output (picture − audio > −10 ms); (3) with
  a wait longer than the start lag (six Hard Limiters, 124.8 ms) the same lower bound, plus no second wait
  (< the wait). Measured with ten limiters (208 ms) while developing it: without the shim −0.18 / −0.20 s (fails);
  the old shim 4/4 runs failed (−13 … −32 ms); the fix 3/3 passed (0.0005–0.015 s, load ≈ 35). Ten limiters crashed
  Chrome's renderer now and then on the loaded host ("Target crashed" in 2 of 10 runs at load 40–78), so the test uses
  six: without the shim it would read ≈ lag − 125 ms (−35 … −110 ms for the 15–90 ms lags measured).
- **Measurement fixes (no assertion loosened).** The picture's anchor is sampled after the frame report (the old sample
  at the animation frame's start could undershoot by the Player callback's delay); the program context is the one
  Remotion schedules buffers on (the first "running" context was sometimes another one: an offset of 15.8 s was read);
  clicks are taken from the first 2 s only (a slow page played into the tone after them).
- **Flakes of the other Phase 0 e2e** (first 10× run of both specs, load 30–63: 19 of 76 failed): the preview spec's
  ScriptProcessor tap runs on the main thread and dropped or repeated 1024-sample buffers under load (clicks read 2048
  samples apart, a head click 128 samples off). Both specs now share `e2e/sound-tap.ts`: an AudioWorklet tap with exact
  context frames, plus a log of what disturbs Remotion's scheduling: a reschedule (a player's `stop()` of its queued
  buffers followed by new starts of the same player — players are told apart by the node their buffers connect to; a
  clip that ends stops its buffers and starts none), a buffer started after its time, and, for the A/V measurement, the
  audio clock slipping against the wall clock (medians of the first and last five output timestamps, > 10 ms). For the
  seek test also old-position tone that Remotion scheduled after the seek's stop (it comes back after a break, or lasts
  longer than the graph's read-ahead + 20 ms with buffers started after the stop; what the graph holds lasts at most
  the read-ahead and breaks nothing). A disturbed play is played again (up to 8 times, was 3; the assertions are
  unchanged); when every play is disturbed the test fails saying so, with the load average, instead of judging the
  graph on a lost play. At load ≥ 90 (100–117 for a while) Chrome's audio clock slipped 180–850 ms per second and
  every play was disturbed: no real-time audio check can measure on such a host.
- **Runs** (`/tmp`-logged, `E2E_PORT=49801 E2E_SKIP_BUILD=1 pnpm exec playwright test <spec> --repeat-each=10`, load
  sampled every 30 s), on the final build of this branch:
  - `e2e/sound-p0-transport.spec.ts` ×10 with the final spec: **50 passed, 0 failed** (load 17–67, 02:26–02:37). Primed
    picture − audio, pairs: 41.6 ms wait 0.020–0.094 s, 125 ms wait 0.011–0.061 s (never below 0); first click at
    exactly wait + 30 ms every time; latency change gap 998 samples (9 runs) and 358 (1); seek tail ≤ 2.6 ms; paused seek
    max 0 (10/10); 8 plays of 50 tests replayed as disturbed.
  - `e2e/sound-p0-preview.spec.ts` ×10 with the final tap: **50 passed, 0 failed** (load 38–83, 02:38–02:47): every
    play clicks of 0.7071 exactly 24 000 samples apart (both tracks summed through the compensated insert); the clip at
    frame 40 heard from its first sample (0.1768, 20 of 20 plays); the export six clicks at 0 … 120 000; 10 plays
    replayed as disturbed. (The older tap also passed 50/50 twice, load 35–80.)
  - Earlier runs while the detection was being completed (same build except the specs): 19 of 76 failed (old specs,
    load 30–63); 7 of 100 (load 10–80: "no reschedule at the seek" until a reschedule's restart could come later than
    0.5 s, a renderer crash, a 41.6 ms-wait pair at −19 ms whose clock slip the old two-reading estimate missed); 3 of 50
    (load 10–55: one seek tail of 60 ms — the same value once before at load ≈ 80: the failure message now carries the
    tone's envelope and the buffer starts after the stop to tell a graph fault from Remotion's —, one "every play
    disturbed" from the two-reading slip estimate, one latency test all-disturbed at load 52).
- **Open (seen once each, not explained, recorded for the next package):** at load ≈ 80 a primed play heard a click
  20.9 ms after the resume (one Hard Limiter's latency) before the expected one — old-position audio from the seek
  before (to 1 s), i.e. a queued buffer Remotion did not drop or a limiter state not flushed; at load ≈ 50 the first
  click of a play came 256 samples early while the following ones were on time (Remotion's first buffer against a
  re-anchored base). Neither reproduced in the 50-run pass above; the specs' messages now carry what tells them apart
  (stops, starts, late starts, peaks).

#### 2. Motion-graphic land / exit from the rendered motion

The mg cues sat on the template's declared `introFrames` / `outroFrames`; the lower third visibly settles ≈ 0.33 s before
its declared intro end (WP2.3 limits). Now the land / exit come from the picture.

##### Design

- `MgTemplateInfo.motionSpeed?(params, {fps, totalFrames})` (`@jasper/project` `registry/mg.ts`, optional): the picture
  speed per CONTENT frame `0 … totalFrames − 1` (`speed[i]` from frame i − 1 to i) in canvas diagonals per second — the
  units of the keyframed-clip sampler (`cues/motion.ts`).
- `@jasper/mg-templates` `motion.ts`: `svgTemplateSpeed` renders the fframes template's SVG twin (a pure function of
  params and frame: what jasper-mg rasterises, D-12) at every content frame on the 1920×1080 design canvas and pairs every
  number of consecutive frames in document order: pixel geometry (attributes, translate, rotate centres) ÷ the canvas
  diagonal, `scale()` as K_SCALE·|Δ ln s|, `rotate()` / `skew` as K_ROT·|Δ°|, opacities weighted by K_OPACITY = 0.25 (a
  fade moves while it changes by > 0.12 / s, ≈ one 8-bit code value per frame at 30 fps); the largest change wins (the
  keyframed sampler sums its components; one element's largest change is what reads as "still moving"). A frame whose
  markup equals the previous one is not parsed (held frames). Null when the params fail the schema, the render throws,
  the frames' structure differs, or the clip is longer than `MAX_SAMPLES_PER_CLIP` (20 000 frames).
- `toTemplateInfo` attaches `motionSpeed` to fframes templates, memoised per registry in a 32-entry LRU keyed by
  template@version, fps, totalFrames and the params JSON (copies handed out). **Anime templates get none**: they are
  drawn by `@jasper/motion` (anime.js), which neither the model nor `@jasper/mg-templates` may import (ARCHITECTURE §3.1,
  D-31) and the engine does not load at runtime; their cues use the declared timing.
- `mgCuePhases(info, clip, fps, flicksPerFrame)` (`cues/mg-phases.ts`, used by both `deriveMgCues` and `mgAnchorFrame`,
  so a derived anchor always resolves to its frame): `speedSegments(speed, bridge = round(0.25·fps))`; the intro is the
  first movement when it starts within `round(0.1·fps) + 1` frames, the land its last moving frame `b` (the picture is at
  rest from the next frame; the keyframes source's abrupt-stop land is also `b`); an intro still moving on the last content
  frame never lands. The exit is the start `a` of the last movement when it is not the intro and starts after the land. No
  movement at all → no cues (measured). Without `motionSpeed`, a null / wrong-length / throwing result, or a clip over the
  cap → the declared `mgPhases`. Non-finite speeds count as still. The existing in-clip checks stay (a land before the
  clip's first frame — sourceIn past it — gives no cue and a null anchor).
- Confidence: measured land 0.8 / exit 0.6; declared land 0.5 / exit 0.4 (were 0.7 / 0.55 for both). Reasons say which:
  `Lower Third settles after 0.67 s on V1 'Lower Third'`, `… starts leaving 0.4 s before its end …` vs `… intro (declared
  1.0 s) ends …`. The land window runs from the intro's first moving frame to the land.
- The engine route, MCP `find_sound_cues`, `soundCue.resync` (engine agent and web session) and the web Suggest Cues dialog
  and Cue Seam all pass the same `mgRegistry`, so they agree (read: `routes/sound-design.ts`, `agent/index.ts`,
  `web/src/sound/cues/suggest.ts`, `seam.ts`, `state/session-host.tsx`).

##### Verified (measured, this branch; shared host)

- `pnpm vitest run packages/mg-templates/test/motion-cues.test.ts --maxWorkers=2`: 24 passed. The oracle is independent of
  the code under test (no SVG parsing, no `speedSegments`): it differentiates the templates' own curves analytically
  (easeOut/easeIn/easeInOut cubic, the closed-form spring velocity) with the constants of `lower-third.ts` /
  `title-card.ts`, and calls a quantity moving above 0.03 diagonals/s (≈ 66 px/s) or 0.12 opacity/s, joining gaps
  ≤ 0.25 s. Land within ±1 frame of settle·fps, exit within −1 … +1.5 frames of leave·fps (an ease-in onset: a frame's
  change averages a rate growing like t²). Content frames (settle·fps → land; leave·fps → exit):

  | variant | settle → land | leave → exit |
  |---|---|---|
  | lower third, defaults, 30 fps, 90 f | 20.01 → 20 | 77.12 → 78 |
  | lower third, 25 fps, 125 f | 16.68 → 17 | 114.27 → 115 |
  | lower third, 29.97 fps, 150 f | 19.99 → 20 | 137.14 → 138 |
  | lower third, 60 fps, 300 f | 40.03 → 40 | 274.25 → 275 |
  | lower third, holdUntilFrames 40, 30 fps | 20.01 → 20 | 42.12 → 43 |
  | lower third, holdUntilFrames 100, 60 fps | 40.03 → 40 | 104.25 → 105 |
  | lower third, long name, sourceIn 6, 30 fps | 20.01 → 20 | 113.12 → 114 |
  | title card, defaults, 30 fps, 120 f | 17.33 → 17 | 106.06 → 107 |
  | title card, 25 fps, 100 f | 14.44 → 14 | 86.16 → 87 |
  | title card, 29.97 fps, 120 f | 17.31 → 17 | 106.06 → 107 |
  | title card, 60 fps, 240 f | 34.65 → 35 | 225.75 → 227 |
  | title card, fade in 45 / out 30, 30 fps | 39.49 → 40 | 123.00 → 124 |
  | title card, no fades, no subtitle | 17.33 → 17 | no outro → no exit |
  | title card, fade in 60, sourceIn 10, 25 fps | 50.71 → 51 | 96.16 → 97 |

  Declared timing for comparison: lower third land 30 / 25 / 30 / 60 (30, 25, 29.97, 60 fps), title card 15 at 30 fps.
  Also: the Phase 2 fixture's lower third (330, 90 frames, 30 fps) → land **350**, exit **408** (declared 360 / 405); an
  anime template (`lower-third-anim`) and a `createStaticMgRegistry` copy of `lower-third` without `motionSpeed` → the
  declared frames at 0.5 / 0.4; a 60 fps clip over the cap → declared; a property test (120 runs: lower third, title card
  and two anime templates × 7 rates × random start / duration / sourceIn / holdUntilFrames) → every derived mg cue inside
  its clip and `resolveCueAnchor` returns its frame; hostile timings / params → null, no throw; the LRU hands out copies.
- Performance (same test, two vitest workers on a loaded shared host): deriving the mg cues of a **10-minute lower third
  (18 000 frames) cold 704 ms** (every frame rendered and compared), **warm 0.6 ms** (memoised). A standalone `tsx` probe
  of `svgTemplateSpeed` alone measured 462 ms for the same 18 000 frames.
- `pnpm vitest run packages/project/test/sound-mg-phases.test.ts`: 10 passed (synthetic speed curves: land / exit rules,
  bridging, late start, never-resting and still templates, fallbacks for throw / null / short / over-cap — `motionSpeed`
  not called — NaN speeds, hostile clips; deriver confidences / reasons / windows; 150-run property derive ↔ resolve for
  measured and declared registries).
- `apps/engine/test/sound-design-cues.test.ts` (4 passed) and `apps/mcp/test/sound-cues.test.ts` (5 passed) now expect the
  measured 350 / 408 at 0.8 / 0.6 (they pinned the old declared 360 / 405).

##### Limits

- **Anime templates are unmeasured** (declared timing, confidence 0.5 / 0.4). Estimated from their timeline constants
  (`@jasper/motion/src/templates`, not run): every intro phase is a fraction of the declared intro ending at or before it,
  so their declared land is never early; for `lower-third-anim` the last role word's ease-out fade (0.65 → 1.0 of the
  intro) drops below 0.12 opacity/s at ≈ 0.9 of the intro, i.e. the declared land is ≈ 1–3 frames late at 30 fps.
- Measured on the 16:9 design canvas only (the 9:16 / 1:1 canvases scale the same motion; the timing is the same but the
  speed in diagonals differs slightly). The clip's own transform keyframes are the keyframes source's, not the mg's.
- Clips over 20 000 frames (≈ 11 min at 30 fps, 5.5 min at 60 fps) fall back to the declared timing.
- When an outro overlaps an unfinished intro (very short clips, `holdUntilFrames` inside the intro) the movements merge:
  the "intro" lands where the merged movement ends (or not at all when it reaches the last frame).

#### 3. Default insert level

**Problem (WP2.3):** kit sounds placed at 0 dB clip gain summed to a decoded export peak of 1.36. Until Phase 4's masking
solver sets gains against the bed, `soundDesign.place` gives every layer without `gainDb` a level from its own
descriptors (`defaultSfxLevel`, `packages/project/src/sound/level.ts`):

- gain = role target − the sound's `maxMomentaryLufs` (its loudest 400 ms, BS.1770 momentary), capped so its true peak
  stays under the role's ceiling, clamped to −30 … +12 dB (spec 12 §2.4 constraint 1, the solver's range), 0.1 dB steps;
  without a measured true peak it never boosts; without a loudness descriptor it stays at 0 dB (lowered only by the
  ceiling).
- Targets are relative to the sequence's delivery integrated target (spec 12 §2.4: web −14, podcast −16, R128 −23,
  A/85 −24): hero −2 LU, support −8, layer −10, beds (a sound typed ambience or room tone, whatever its role) −16. Web:
  hero −16, support −22, layer −24, ambience −30 LUFS momentary. True-peak ceilings: hero −6, support −12, layer −16,
  ambience −20 dBTP (a hero, a support and a layer peak-aligned on one cue sum to −0.8 dBTP even exactly in phase).
- Reasoning and sources (the numbers are a decision; no standard gives SFX insert levels): programme and dialogue sit
  at the delivery's integrated target — EBU R 128 (2020) −23 LUFS / −1 dBTP and EBU Tech 3343 (practical guidelines,
  momentary/short-term use in mixing), ATSC A/85 −24 LKFS / −2 dBTP, AES TD1008 (streaming: −18 LUFS for speech,
  −16 for music, −1 dBTP), streaming platforms' −14 LUFS normalisation, Netflix's dialogue-gated −27 LKFS / −2 dBTP
  delivery spec. A hit's loudest 400 ms just under the programme level reads as a strong accent without dominating
  speech; support sounds sit well under it; spec 12 §2.4 asks ambience ≥ 10 LU under voice, and a bed's momentary
  maximum exceeds its integrated level by a few LU, hence −16. Measured on the kit and Synth (below): true peak − max momentary is
  10–23 dB for hits, thumps, booms and key presses and 6–8 dB for whooshes, so for most hits the true-peak ceiling,
  not the loudness target, sets the gain.
- Recorded on the clip: `AudioClip.sfx.level = {by: 'default', gainDb, offsetDb?, targetLufs, limitedBy}` (optional
  field of the loose `ClipSfx`; invalid ones are dropped by `readClipSfx` / `repairDocument`, the gain kept). While
  `gainDb` equals the clip's gain it is still the default: `soundDesign.swap` and `soundDesign.setRole` recompute it for
  the new sound / role (keeping the variation offset); a gain the user set since is kept. Phase 4 replaces it.
- New layer field `gainOffsetDb` (−12 … 12, added to the default; ignored with `gainDb`): fills pass their seeded ±1 dB
  variation there (web `fill.ts` Fill / Fill Unfilled Cues, MCP `place_sound` picks); an explicit gain stays absolute
  (MCP `insert_sound` now passes an explicit 0 dB too). The engine's provenance now carries `truePeakDb` (optional
  descriptor; older registrations lack it and so never boost). MCP `place_sound` / `insert_sound` return each clip's
  `gainDb` and `level`; tool docs, SOUND_GUIDE ("Levels") and `describe_commands` say how the default is chosen.
- Verified: `pnpm vitest run packages/project/test/sound-level.test.ts` (10 passed: targets by role and delivery, peak
  cap, no boost without a peak, unmeasured, range, a 2 000-run property over hostile descriptors; place with three
  layers hero/layer/layer = −6 / +4 / −4 dB with limitedBy loudness/peak/peak, recorded, undo = the untouched document,
  redo the same levels; explicit gain wins, offsets add; broadcast delivery; swap and setRole refresh an untouched
  default and keep a user gain; refusal of an out-of-range offset; a bad stored level dropped on load, idempotent).
  `packages/project/test/sound-design-place.test.ts` and `apps/web/test/sound-fill-swap.test.tsx` updated to the
  default (they asserted 0 dB / jitter only).
- **Phase 2 fixture, filled as an agent fills it** (`pnpm vitest run apps/mcp/test/sound-levels.test.ts`, real engine
  with 9 kit recordings + Jasper Synth, jasper-mcp over stdio; load ≈ 80): find_sound_cues → set_sound_cues → place_sound
  with picks by type on all 17 cues (two layers on the hero marker cue): 18 clips, every gain equal to
  `defaultSfxLevel` of its provenance (+ its ≤ 1 dB offset) — e.g. "Air whoosh, bright" (−9.6 LUFS, −3.1 dBTP) support
  −11.7 dB (loudness), "Low boom" (−11.3, −0.9) hero −5.8 dB (peak), "Jasper Synth whoosh 1" layer −14.9 dB
  (loudness); 15 of 18 limited by the peak ceiling. Mix by the export mixer (`measure_loudness`, no normalisation):
  −4.9 dBTP, −23.8 LUFS integrated. A native export (MOV, 24-bit PCM, audio clips only) decoded and metered by ffmpeg
  `ebur128=peak=true+sample`: **−5.0 dBTP**, sample peak −5.0 dBFS; the same export with every clip at 0 dB: −0.4 dBTP
  (this run's picks did not reach the 1.36 of WP2.3's, which had other sounds layered on the same cues).

#### Gate and integration

Merged `feat/sound-design` 3e5f6f33 (Phase 2 verification A) into this branch: conflicts in the place / swap handler and
schema docs (kept both: A's fades / alternatives / `trimmedHeadSec` and B's default level / `gainDb`), `fill.ts` (A's
`alternatives.length > 1`, B's `gainOffsetDb`), gaps.md and this note (both sections kept). Then, on the merged code
(shared host, load 46–63):

- `pnpm typecheck`: passed (all workspaces); `pnpm exec tsc --noEmit -p e2e/tsconfig.json`: passed; `pnpm lint`:
  passed (Biome, tokens, anime, layers, assets); `pnpm notices --check`: current; `pnpm build`: passed.
- `pnpm vitest run packages/project/test/sound-*.test.ts packages/project/test/essential.test.ts
  packages/project/test/invariants.test.ts packages/mg-templates/test packages/compositions/test/audio-primed-clock.test.ts
  packages/compositions/test/audio-preview-transport.test.ts apps/web/test/sound-*.test.ts* --maxWorkers=2`: 44 files,
  468 passed, 2 skipped.
- `pnpm vitest run apps/engine/test/sound-design-cues.test.ts apps/engine/test/sound-placement-export.test.ts
  apps/engine/test/sounds-provenance.test.ts apps/engine/test/sounds-unit.test.ts apps/engine/test/sounds-routes.test.ts
  apps/mcp/test/sound-guide.test.ts apps/mcp/test/readme-tools.test.ts apps/mcp/test/conventions.test.ts
  apps/mcp/test/sound-examples.test.ts --maxWorkers=1`: 75 passed (after `sounds-routes` learnt the provenance's new
  `truePeakDb`); `apps/mcp/test/sound.test.ts apps/mcp/test/sound-cues.test.ts apps/mcp/test/sound-levels.test.ts`:
  17 passed.
- Real app, built stack: `e2e/sound-cues.spec.ts e2e/sound-fill.spec.ts e2e/sound-library.spec.ts
  e2e/sound-p2-done.spec.ts`: 6 passed. `sound-p2-done`'s export (filled through the UI, default levels): true peak
  **−7.5 dBTP**, −23.6 LUFS (verification A measured +3 dBTP with 0 dB inserts); every aligned point still within
  ±1 sample. The Phase 0 specs: see §1 (50 + 50 passed).
- The full `pnpm test` is verification A's gate; not rerun here.
- Then merged `feat/sound-design` e233d588 (WP3.1 proposals; no conflicts): `pnpm typecheck` and `pnpm lint` passed,
  notices current, `sound-level`, `sound-design-place`, `sound-mg-phases`, `proposals`, `audio-primed-clock` and the
  mg-templates tests: 108 passed, 2 skipped.

## Phase 3: proposals and review

### Phase 3 → WP3.1 proposal model, store and routes

Scope: spec 12 §2.5 (generic proposals), §2.8 (proposal routes), P3-R1, P3-R2; ARCHITECTURE §11.3 / D-18 "proposals
later". Files: `packages/project/src/proposals/{schema,structure,anchors,compose,validate,decisions,ghost,index}.ts`
(exported from `@jasper/project` and the subpath `@jasper/project/proposals`), `commands/context.ts`
(`substituteKnownRefs`, `isTempRef`), `agent/guard.ts` (agentsMayApply needs approval); `packages/api/src/proposals.ts`
(contracts), `routes.ts` (9 routes), `events.ts` (`proposal.changed`), `common.ts` (codes `APPROVAL_REQUIRED`,
`PROPOSAL_NOT_FOUND`, `PROPOSAL_LIMIT`, `PROPOSAL_STALE`); `packages/engine-client/src/client.ts` (9 methods);
`apps/engine/src/proposals/{store,service}.ts`, `routes/proposals.ts` (registered last), `agent/service.ts`
(`transact` options `preApproved`, `asUser`); `apps/web/src/agent-bridge/bridge.ts` (relay flag `asUser`). Tests:
`packages/project/test/proposals.test.ts`, `apps/engine/test/proposals{,-store,-fuzz}.test.ts`,
`apps/web/test/agent-bridge.test.ts` (1 new), `packages/engine-client/test/client.test.ts` (1 new). Docs: security
review (AGT-3 table rows and §9), gaps, README "HTTP API underneath", ARCHITECTURE §11.3.

#### Model (`@jasper/project`; pure, never throws — problems are typed `ProposalIssue {code, message, itemId?, path?}`)

```ts
PROPOSAL_LIMITS = { maxItems: 2000, maxCommands: 5000 /* items' own sets together = one tx */, maxAlternatives: 16,
  maxAlternativeCommands: 50_000, maxRequires: 64, maxBytes: 20 MB, maxMetaBytes: 64 KB, maxReportBytes: 1 MB,
  maxTitle: 200, maxSummary: 4000, maxLabel: 200, maxGroup: 64, maxNote: 4000, maxReason: 1000,
  maxPerProject: 50, expiryDays: 30 }
PROPOSAL_ITEM_STATES = pending | accepted | rejected | stale | invalid
PROPOSAL_ID_RE /^prp_[Crockford]{16}$/, PROPOSAL_ITEM_ID_RE /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/,
PROPOSAL_FEATURE_RE /^[a-z][a-z0-9-]{0,63}$/, SOUND_DESIGN_FEATURE = 'sound-design'

ProposalDraftSchema (what creators send; strict) = { sequenceId?: string|null, feature, title, summary?, report?,
  items: [{ id, label, group?, commands: Command[1..5000], requires?: earlier item ids, meta?,
            alternatives?: [{label, commands, meta?}] ≤16, selectedAlternative?: 0 (own set) | k (alternatives[k-1]) }] }
ProposalSchema (stored; strict) = { version: 1, id: 'prp_…', projectId, sequenceId|null, feature, title, summary,
  author: 'user'|{agent}, createdAt, updatedAt, baseRevision, docHash, report?,
  items: [{ …draft item, group, requires, state, reason?, note?, anchors?: {entityId: fingerprint},
            applied?: {revision, at, refs: {$ref: id}} }] }

createProposal(doc, draftUnknown, {id, projectId, author, now, revision}, ctx) → {ok, proposal} | {ok:false, errors}
validateProposal(doc, proposal, ctx) → proposal        // states + anchors; accepted/rejected/invalid untouched
revalidate(doc, proposal, ctx) → {proposal, changed, stale: [{itemId, reason}]}
planAccept(doc, proposal, itemIds|'all', origin, ctx, {partial?, expectedRevision?})
  → {ok:true, composed: ComposedAccept|null, proposal, stale} | {ok:false, errors, proposal, stale}
composeAcceptTx(proposal, itemIds|'all', origin, {expectedRevision?, exclude?, maxCommands?})
  → {ok:true, tx: {protocol, label: 'Accept <title> (n of m)', origin, sequenceId?, expectedRevision?, commands},
     itemIds /* closure, proposal order */, added, skipped /* already accepted */, ranges: [{itemId, start, end}]}
  | {ok:false, errors}
markAccepted(p, itemIds, {revision, refs, at}); rejectItems(p, ids|'all', now); reopenItems(p, ids|'all', now);
setItemNote(p, itemId, note|null, now); selectAlternative(p, itemId, k, now)      // → {ok, proposal, changed}
proposalGhost(before, after | applyTransaction result) → {created, changed, deleted}  // incl. effects etc. in clips
previewProposal(doc, p, itemIds|'undecided', ctx) → {document, ghost, items: {itemId → ghost}, failed, applied}
dependencyClosure(p, ids, stopAt?), dependents(p, id), appliedRefs(p), declaredRefs(commands),
proposalStructureIssues(items), proposalCounts(p), proposalDecided(p), selectedCommands(item), itemOfCommand(ranges, i),
documentHash(doc), anchorFingerprint(doc, id), itemAnchors(doc, commands), anchorsProblem(doc, anchors),
dryRunCommands(doc, commands, ctx, sequenceId?), issueReason(errors)
ProposalContext = { registries, revision?, ids? (default random), now?, invariants?, checkInvariants? }
```

How it works:

- **Creation** refuses (whole proposal, `E_SCHEMA` / `E_LIMIT` / `E_INVALID_PARAM` / `E_NOT_FOUND`) what is the
  creator's error: draft shape, unknown command keys at any depth (the agent strictness rule), unknown command types,
  command schemas, duplicate item ids, `requires` naming a later / unknown item or itself, a temp ref declared by two
  items (accepting items together is one transaction), an alternative that declares other refs than its item (later
  items use them), an unknown `sequenceId`, the limits. Agent addressing forms (`mediaByName`, `clipAt`, …) are resolved
  against the document and stored resolved; an address that fails makes its item `invalid`.
- **Validation** (document-dependent problems → item `invalid` + reason, and the items requiring it too): first ALL
  undecided items in one dry run with the invariant checker; then each item's dependency closure alone (without the
  checker when the whole set held — the handlers refuse what is missing, and `planAccept` re-checks the exact set with
  invariants before anything is applied); if the whole set fails, the item owning the failing command (or, for a
  transaction-level failure, the shortest failing prefix found by bisection) becomes `invalid` ("conflicts with the
  items before it: …") and the rest is tried again (≤ 50 passes). Each pending item records its **anchors**: every
  entity id its commands name, with a fingerprint (clips: track, start, length, In, speed; transitions: track, clips,
  length, alignment; sequence markers and sound cues: frame; others: presence).
- **Re-validation** (on GET `?revalidate=1`, accept, select): pending/stale items whose anchors are gone or moved become
  `stale` ("clp_… changed since the proposal was made (start 0 → 12)", "mrk_… (frame 100 → 120)", "… no longer exists");
  entities named by the proposal's own accepted items are not anchors any more; then one dry run of the rest together
  (fast path) or one per item, and items requiring a stale/invalid item are stale. Same content hash and nothing
  accepted → everything stale is pending again without dry runs. Stale is recomputed every time (undo or moving
  things back revives items); invalid is sticky (except `select` of a working alternative).
- **Accept** (`planAccept` → `composeAcceptTx`): `'all'` = every pending or stale item (invalid, rejected and accepted
  ones are not part of "all"); explicit ids may include rejected items (the user changed their mind). The closure is
  taken over `requires` (an accepted requirement is not re-applied: its recorded `applied.refs` are substituted into
  the later item's id positions with `substituteKnownRefs`); a rejected requirement is accepted with it. All-or-nothing:
  any stale/invalid item in the closure refuses (`E_STALE` / `E_INVALID_PARAM`). With `partial` those requested items
  drop out with whatever requires them, and an item that newly conflicts in the composed dry run becomes stale and
  drops out too (≤ 50 passes). One transaction, label `Accept <title> (n of m)` (title cut at 80 characters).
- **Decisions** never touch the document: reject (refused for accepted items: "undo it in History, then reopen it"),
  reopen (accepted/rejected → pending, clears `applied`, keeps notes and selections: the Review UI's "After Undo, the
  proposal reopens with its decisions intact"), note (≤ 4 000, null/"" clears), select (0 = own set).
- **Ghosts**: `proposalGhost` is `diffDocuments` plus, inside each changed clip, the id-bearing children (effects,
  keyframes, masks, clip markers; depth ≤ 8, ≤ 5 000). `previewProposal` applies items one transaction each on a copy
  with refs carried over, so every created id is attributed to its item — this is what the session preview (P3-R4)
  needs; what is committed is always `composeAcceptTx`'s single transaction.

#### Engine store (`apps/engine/src/proposals/store.ts`)

`<appdir>/projects/<pid>/proposals/<prp_id>.json` (inside the project folder: deleting the project deletes them),
written with `atomicWriteFile` (temp file, fsync, rename, fsync dir), serialized per project. ≤ 50 per project:
creating the 51st evicts the oldest **decided** proposal (no pending or stale item) by last change; when every stored
one is still under review, `409 PROPOSAL_LIMIT` (`detail: {code: 'E_PROPOSAL_LIMIT', limit, undecided}`), nothing
evicted. Expiry: 30 days after `updatedAt` (decisions refresh it); expired files are deleted on list/get and announced
(`proposal.changed` `expired`). A file that is not JSON, fails `ProposalSchema`, names another id or project, or is over
21 MB is renamed `<id>.json.corrupt-<ms>` and reported in the list's `warnings` and the log; never a crash. Creating
for a missing project is `404 PROJECT_NOT_FOUND` (no folder is created); writing a proposal deleted meanwhile is
`404 PROPOSAL_NOT_FOUND`.

#### Routes (exact API for the session, web and MCP agents)

All under `/api/projects/:projectId/proposals` (ids checked: `prj_…`, `prp_…`); client methods in brackets. Errors are
the usual `{code, message, detail?, retryable}`; `detail.code` carries the `E_*` code where there is one.

| Route | Body / query | Answer | Errors |
|---|---|---|---|
| `GET …` [`listProposals(pid)`] | | `{proposals: [{id, projectId, sequenceId, feature, title, summary, author, createdAt, updatedAt, expiresAt, baseRevision, itemCount, counts {pending, accepted, rejected, stale, invalid}, decided}], warnings}` newest first | 404 PROJECT_NOT_FOUND |
| `POST …` [`createProposal(pid, req)`] | `ProposalDraft` + `author?` (taken from the editor only; an agent is always `{agent: <x-jasper-agent>}`) | `{proposal, expiresAt, revision, evicted: [ids]}` | 400 VALIDATION_FAILED (`detail {code, errors[]}`), 404, 409 PROPOSAL_LIMIT |
| `GET …/:id` [`getProposal(pid, id, {revalidate?})`] | `?revalidate=1` re-validates on the live document (and stores/announces changed states) | `{proposal, expiresAt, revision /* null without revalidate */}` | 404 PROPOSAL_NOT_FOUND |
| `POST …/:id/accept` [`acceptProposal`] | `{itemIds: [ids] \| 'all', partial?, expectedRevision?}` | `{proposal, applied, added, skipped, stale: [{itemId, reason}], result: TransactionResult \| null, appliedBy: 'session' \| 'headless' \| null, revision}` | 403 APPROVAL_REQUIRED (agent, policy), 403 APPROVAL_DENIED / APPROVAL_TIMEOUT (destructive items, agent), 409 PROPOSAL_STALE (`detail {code: E_PROPOSAL_STALE, errors, stale}`), 409 REVISION_CONFLICT (`expectedRevision` ahead, or behind with a conflicting edit: fast-forward rule), 409 TRANSACTION_REJECTED, 409 NO_SESSION, 404 NOT_FOUND (unknown item) |
| `POST …/:id/reject` [`rejectProposal`] | `{itemIds \| 'all'}` | `{proposal, changed}` | 400 (accepted item), 404 |
| `POST …/:id/reopen` [`reopenProposal`] | `{itemIds \| 'all'}` | `{proposal, changed}` | 404 |
| `POST …/:id/note` [`noteProposalItem`] | `{itemId, note: string \| null}` | `{proposal, changed}` | 400, 404 |
| `POST …/:id/select` [`selectProposalAlternative`] | `{itemId, alternative: 0…16}` — the chosen set is dry-run with its closure on the live document first; its anchors are recorded anew; a working alternative revives an invalid item | `{proposal, changed}` | 400 (out of range, accepted, does not apply), 404 |
| `DELETE …/:id` [`deleteProposal`] | | `{proposalId, deleted: true}` | 404 |

Event `proposal.changed` (project-scoped): `{projectId, proposalId, change: created | accepted | rejected | reopened |
noted | selected | revalidated | deleted | expired | evicted, feature?, sequenceId?, counts?, itemIds?, revision?}`.
`ProposalService` is also `app.jasper.services.proposals` (the P3-R3 plan job creates through `service.create(pid,
draft, {editor, agent})`; `registerPolicy(feature, fn)` lets another feature allow agent accepts).

#### Decisions

- **Policy gate.** A request without the editor key (an agent, jasper-mcp, the CLI, the editor acting on an agent's
  live-UI input) may accept only where the feature's policy allows it: `sound-design` = the proposal's sequence has
  `soundDesign.settings.agentsMayApply === true` (read from the live document); any other feature refuses by default.
  `403 APPROVAL_REQUIRED` / `E_APPROVAL_REQUIRED` (new code; the agent cannot answer it, the user applies in the editor).
  An allowed agent's accept goes through the ordinary classification: `track.remove`, `item.delete`, `force: true` …
  inside the items still show the approval card (headless → `APPROVAL_DENIED`). **Closing a bypass:** an agent setting
  `agentsMayApply: true` with `soundDesign.setSettings` now needs the approval card too (`approvalReasons`), otherwise
  it could grant itself the right.
- **The editor's accept is the user's edit.** With the editor key the engine relays the composed transaction with
  `approved: true, asUser: true`; the bridge commits it with origin `user` (History "Accept Live pass (2 of 2)", no
  "Agent:" prefix, not in the agent activity feed) and honours `asUser` only together with `approved` (only the engine
  sets both, only for editor-key requests). Headless it is saved with origin `user`. An agent's accept is
  `{agent: <name>, runId: <proposalId>}` (so that agent may `history.undo` it).
- **Concurrency.** Accept, decisions and deletion of one proposal are serialized (per-proposal mutex held across the
  transaction): two simultaneous accepts of the same items apply once (the second reports them `skipped`). Accept
  re-validates on the live document and sends `expectedRevision` (the caller's, default the revision it validated at),
  so an edit landing in between is caught by the fast-forward rule (S01:AGT-010) or applies cleanly; never both lost.
- **Additions to the spec's route list** (generic and needed by P3-R6): `reopen` (Undo back into review) and `select`
  (alternate cycling on ghosts, stored so agents read the choice). Items carry `alternatives` (command sets) and
  `selectedAlternative`; `applied.refs` makes accepting A then B equal accepting A ∪ B.
- **Stale vs invalid.** Invalid = never applied on the document it was validated against (sticky); stale = was valid
  but the document changed (recomputed on every re-validation). The spec's "Ghosts follow their anchors" is served by
  the anchors' current frames (the session resolves them); moved anchors make items stale, never silently re-targeted.

#### Verified (measured, this branch; shared host, 16 cores, load average 20–78)

- `pnpm vitest run packages/project/test/proposals.test.ts --maxWorkers=2`: 21 passed. Includes the four properties
  (fast-check): accepting A then B ≡ accepting A ∪ B (40 runs, markers, tracks with refs and items using them across the
  two accepts; documents equal up to id renumbering, same item states); rejecting leaves the document identical (same
  reference and JSON) and `'all'` then composes exactly the closure of the rest (40 runs); compose deterministic and the
  closure contains the request, is closed under `requires`, equals the reachable set and keeps proposal order (200
  random DAGs); never throws on fuzzed drafts / `fc.anything()` (150 runs: create, compose, plan, revalidate, preview;
  every refusal code is `E_*`).
- `pnpm vitest run apps/engine/test/proposals.test.ts apps/engine/test/proposals-store.test.ts
  apps/engine/test/proposals-fuzz.test.ts --maxWorkers=2`: 13 + 6 + 3 passed. Store: round trip with no temp files,
  path-shaped ids refused, no folder for a missing project, eviction order and `E_PROPOSAL_LIMIT`, 30-day expiry
  (exact `expiresAt`), three kinds of corrupt files moved aside with warnings, 8 concurrent creates against a limit
  of 5 → exactly 5 stored. Routes: create/list/get/events; invalid items stored with reasons; 5 malformed bodies → 400;
  accept all = one transaction (saved revision 3 → 4, refs recorded, accepting again applies nothing); stale anchor →
  409 PROPOSAL_STALE with "frame 100 → 120", partial applies the rest, moving back revives; `expectedRevision` ahead /
  conflicting / fast-forward; reject (project file byte-identical), note, select (the solo alternative is what got
  applied), reopen with notes and selection intact, delete, the event sequence; the 50 limit then eviction; deletion
  with the project; concurrent accepts apply once; accept racing an edit keeps both. Policy (engine with token and
  editor key): agent → 403 APPROVAL_REQUIRED, agent cannot forge `author: 'user'` nor grant itself `agentsMayApply`
  (E_APPROVAL_DENIED), editor accepts; allowed agent accepts, a non-sound feature stays refused; destructive item:
  allowed agent headless → APPROVAL_DENIED, editor applies; live (fake editor session over WS /agent): editor accept
  relayed `approved + asUser`, agent accept relayed as the agent's, destructive card denied → 403 and approved → applied.
  Mutation check: with the policy check disabled, the two policy tests fail.
- `pnpm vitest run apps/engine/test/fuzz-http.test.ts --maxWorkers=2`: 165 passed (the generic route fuzzer discovers
  the 9 new routes). `apps/web/test/agent-bridge.test.ts` (5 passed, new: `asUser` + `approved` → History origin
  `user`, no activity entry; `asUser` without `approved` → an ordinary agent transaction), `packages/engine-client/test`
  (20 passed, new: every proposal method's path, query and body), and, before the bridge test was added, `packages/api/test`, `packages/project/test/agent*.test.ts`,
  `apps/engine/test/{agent,security-hardening,security-review,server,events}.test.ts` with the bridge file: 11 files, 128 passed.
- **Run for real** (dev engine `JASPER_APPDIR=.stage JASPER_DEV=1 tsx apps/engine/src/cli.ts --port 49901`, curl with
  the token / with the editor cookies): a 4-item proposal by `x-jasper-agent: curl-agent` → author `{agent:
  'curl-agent'}`, `bad` stored `invalid` "E_NOT_FOUND: Track not found: A9"; agent accept → 403 APPROVAL_REQUIRED; agent
  `soundDesign.setSettings {agentsMayApply: true}` → E_APPROVAL_DENIED; editor accept `["mute"]` → applied `trk, mute`
  (added `trk`), revision 1, saved track "SFX 1" muted; `'all'` → `cut` (invalid `bad` is not part of all), revision 2.
  Then **in the editor** (Vite on 49902, the project open in a browser): a 2-marker proposal accepted with the editor key
  → `appliedBy: session`, the History list showed ONE entry `Accept Live pass (2 of 2)`, origin `user`; both markers
  visible on the timeline ruler (screenshot looked at); **one Ctrl+Z removed both** (saved revision 4, no markers);
  `reopen all` → both pending; `?revalidate=1` → still pending at revision 4; accepting `m2` alone → applied, revision 5.
- Measured cost (vitest, `invariants: 'incremental'`, 2 000 `soundCue.add` items anchored to 200 clips on a 400-clip
  document, load ≈ 66): create 9.9–10.8 s (≈ 5 ms per item: one dry run each), revalidate after an unrelated edit
  1.1–2.1 s, planAccept of all 1.8 s. Before the whole-set-first change, create took 68 s (load ≈ 40); a quadratic
  closure scan in `planAccept` (6.3 s) was made linear.
- `pnpm typecheck` (all packages) and `pnpm lint` (Biome, tokens, anime, layers, assets): pass.

#### Limits and notes for the next packages

- **Creation and accept run on the engine's main thread**: a 2 000-item proposal blocks the engine for ≈ 10 s on this
  host (≈ 100 items ≈ 0.5 s). The P3-R3 plan job should create large proposals from its job (it can call
  `services.proposals.create`), and keep proposals near the hundreds; a worker for validation is not built.
- `'all'` never includes invalid, rejected or accepted items; accept of explicit rejected ids is allowed.
- Stale detection is by anchors (named entity ids) and dry runs: an item whose commands name no entity (a `frame`-only
  placement) goes stale only when it stops applying, not when the picture under it changed.
- The policy reads `agentsMayApply` of the proposal's `sequenceId`; a proposal with `sequenceId: null` can be accepted
  by an agent only through a feature policy that allows it (sound design does not).
- The editor's accept over the relay is `asUser`; if the editor window has no lease (read-only) the accept is applied
  headless when the lease expired, else `409 NO_SESSION` (like agent transactions).
- MCP tools (`list_proposals`, `get_proposal`, `wait_for_proposal`, `accept_proposal`, `reject_proposal`,
  `PROPOSALS_GUIDE`), the session slice / preview document (P3-R4, use `previewProposal` + `revalidate` on
  `doc.changed`), the Review UI (P3-R6, call `reopen` after Undo) and the plan job (P3-R3, feature `'sound-design'`,
  `SOUND_DESIGN_FEATURE`) are the next packages; none of them exists yet.

### Phase 3 → WP3.2 plan job & MCP proposal tools

Scope: spec 12 §2.5, §2.8 (`POST /api/sound-design/plan`, job `sound-design`), §2.10 (`plan_sound_design`, `place_sound`
propose mode, `list_proposals`, `get_proposal`, `wait_for_proposal`, `accept_proposal`, `reject_proposal`,
`PROPOSALS_GUIDE`), P3-R3, P3-R5. Files: `apps/engine/src/sound-design/plan.ts` (selection, draft, job runner),
`sound-design/match.ts` (`matchStoredCues`, moved out of the cue route), `routes/sound-design.ts` (route + runner),
`sounds/service.ts` (`rankingPool`), `proposals/service.ts` (settles setup items); `packages/project/src/sound/proposal-draft.ts`
(`soundProposalItems`, shared by the engine and MCP), `proposals/decisions.ts` (`isSetupItem`, `settleSetupItems`);
`packages/api/src/sound-design.ts` (plan request / report / result contracts), `jobs.ts` (kind `sound-design`),
`routes.ts` (`soundDesignPlan`), `media.ts` (`mediaRegisterCommand`, moved from jasper-mcp so the engine builds the same
`media.register`); `packages/engine-client` (`planSoundDesign`); `apps/mcp/src/tools/proposals.ts` (5 tools,
`PROPOSALS_GUIDE` in `FULL_GUIDE`), `tools/sound-design.ts` (`plan_sound_design`, `place_sound {mode}`), `tools/sound.ts`
(`SOUND_GUIDE` workflow), `errors.ts` (hints `E_APPROVAL_REQUIRED`, `E_PROPOSAL_STALE`, `E_PROPOSAL_LIMIT`). Docs: README
(344 tools, HTTP section), security review (AGT-3 row, route paragraph), gaps. Tests: `apps/engine/test/sound-design-plan.test.ts`,
`sound-design-fixture.ts` (the Phase 2 fixture, extracted from the cue route test), `packages/project/test/sound-proposal-draft.test.ts`,
`apps/mcp/test/proposals.test.ts`, `sound-guide.test.ts`, `packages/engine-client/test/client.test.ts`; `apps/mcp/test/sound-cues.test.ts`
and `sound-levels.test.ts` (Phase 2 verification B) now pass `mode: 'apply'` where they place directly.

#### Route and job

`POST /api/sound-design/plan` (strict body, 202 + an `EngineJob` of kind `sound-design`; client `planSoundDesign`):

```ts
SoundDesignPlanRequest = { projectId, sequenceId? /* default the first */, range?: {start, end} /* frames */,
  cues?: 'auto' /* default */ | cueIds[≤2000], maxCues?: 1…200 /* default 200 */, label? /* proposal title */,
  style?: { density? /* derived cues; default the sequence's */, palette?: 'project' /* default */ | soundIds[≤500],
            sources?: ('starter'|'pack'|'folder'|'synth')[] /* default all */, respectDialogue? /* default true */,
            seed? /* default the sequence's settings.seed */, alternatives?: 0…3 /* default 3 */ } }
job.result = SoundDesignPlanResult = { proposalId | null, projectId, sequenceId, revision, itemCount, counts, invalid[],
  report: { version, sequenceId, seed, density, respectDialogue, sources, cues: 'auto'|'ids', range, snapshotHash,
    librarySize, palette {size, used}, events[{itemId, cueId|null, cueKey|null, cueItemId|null, frame, timecode, seconds,
      kind, weight, role, align, cueReason, why, types, sound {soundId, title, license, source, score, palette}, parts
      (rankSounds score parts), rate, gainOffsetDb, alternatives[sound], extraLayers[sound], notes[]}],
    skipped[{cueId, cueKey, frame, timecode, kind, code, reason}] (≤ 500 listed), counts {cues, placed, newCues, skipped,
    sounds, items}, warnings[] } }
```

Refusals before a job starts: `400 VALIDATION_FAILED` (body), `404 PROJECT_NOT_FOUND`, `404 SEQUENCE_NOT_FOUND`,
`404 CUE_NOT_FOUND` (explicit ids). Skip codes: `FILLED` (explicit id already has a sound), `MUTED`, `SILENCE`, `DIALOGUE`
(a stored plain cut under words), `NO_TYPES`, `NO_SOUND` (no commercial-safe sound of its types in the allowed sources),
`REGISTER_FAILED`, `LIMIT`, `NEAR_STORED` (a derived cue within 2 frames of a stored one), `STORED` (a derived cue whose
stored cue already has a sound), `OUT_OF_RANGE`.

How it works (`plan.ts`; selection and draft are pure and tested without an engine):

1. **Cues.** The live document (`doc.get`: the editor's when open), expressions bound like the cue route. Stored cues of
   the sequence that are unfilled (no `placedClipIds` naming a clip that exists), in range, not muted, not `silence`, and
   (with `respectDialogue`) not a plain `cut` under words; with `cues: 'auto'` also `deriveCues` (the engine's template
   registry, the density, the range, `respectDialogue`), minus suggestions `matchStoredCues` pairs with a stored cue and
   those within 2 frames of one. Frame order, stored first at one frame.
2. **Rank.** Per cue `rankSounds` over the library snapshot (`SoundService.rankingPool`: the allowed sources; folder sounds
   only on a local engine) with the cue's types, its kind as `visualKind`, its window and alignment, commercial-safe only.
   **Decision:** the cue's types are best first (WP2.2: a cut lists hit before glitch), so ranked sounds are reordered by the
   first cue type they carry — after the real-recordings-before-synth tier (spec 12 §0) — keeping the ranking's order
   within a type (`byTypeOrder`; without it the fixture's second cut got "Error buzz", found in the real run; the unit test
   fails with the ordering removed). The top 24 are re-ranked with the cue's neighbourhood as `usedNearby` (earlier picks of
   this plan and placed clips, nearest first), palette sounds moved first, then `pickVariant` (seed, key = the cue id or
   `derived:<key>`, sequence, layer) picks among the top 4 and gives the ±2 % rate and ±1 dB gain offset. The next
   1–3 ranked sounds are the alternatives. **A marker naming several types** (`sfx: boom+whoosh`, `source: 'marker'`) gets
   one layer per type (≤ 6; extra layers role `layer`, their own variation); other cues get one sound.
3. **Roles.** Hero cue → `hero`, else `support` (ambient too); a hero under words (`respectDialogue`) or within 0.5 s of
   another hero (planned or placed) is placed as `support` with a note.
4. **Register.** Every chosen and alternative sound, in order of need, through `SoundService.register` (the WAV copy /
   lead silence rules of §2.1; registering media files is allowed at plan time, the `media.register` commands go into
   the proposal). A failing chosen sound falls back to its first alternative (noted); a failing extra layer is left out
   (noted); a cue with nothing registered is `REGISTER_FAILED`. Sounds no pick uses any more are not imported.
5. **Draft** (`soundProposalItems`, shared with MCP): setup items first — `bin` (`bin.create` "Sound Effects" when the
   project has none), `sound:<soundId>` (`media.register` with the provenance into the bin; a project media of the same
   file is reused, with `media.setLibraryInfo` when it lacks provenance; two library ids of one file share one media),
   `cue:<itemId>` (`soundCue.add` of a derived cue via `cueInputFromDerived`, ref `$cueN`) — all `group: 'setup'`,
   `meta.setup: true`; then one place item `sfx:NNN` per cue: `soundDesign.place {sequenceId, cueId (stored id or $cueN),
   layers [{mediaId, role, rate?, gainOffsetDb?}], alternatives (the ring: chosen + alternates)}`, group = role, `requires`
   = its cue item and the setup items of every sound it or an alternative uses, `alternatives` = command sets with layer
   0's media swapped, `meta` = {frame, timecode, kind, weight, role, align, cueId, cueKey, cueReason, why, soundId, title,
   license, score, rate, gainOffsetDb, layers?, notes?}. **No explicit gain**: placement's descriptor-based default level by
   role applies (Phase 2 verification B), plus the seeded `gainOffsetDb`; align, pan and pan sweep come from the cue.
   Why-line: `<sound(s)> on <cue reason> at <tc> · <role> · <align>`. Title "Sound design: <sequence name>" (or `label`).
6. **Proposal.** `services.proposals.create(projectId, draft, {editor, agent})` (validation by dry runs; author the editor's
   `user` or `{agent}`), from inside the job. Progress: reading, cues, ranking, "Registering sounds (i of n)", checking;
   cancellation is checked between steps and registrations, and a proposal stored just before a cancel is deleted (a
   cancelled plan leaves none). No cue with a sound → succeeded with `proposalId: null` and the report (nothing stored).
   The job's input is re-validated when read back.

**Setup items are settled (change to the WP3.1 model and service).** Found in the MCP test: after the user rejected some
place items and accepted the rest, the setup items only the rejected ones needed (their new cues, sounds nobody else
used) stayed pending for ever, so the proposal was never `decided` (never evictable: 50 of them would hit
`PROPOSAL_LIMIT`) and "Accept all" would have added unused cues and media. `settleSetupItems` (pure, in
`proposals/decisions.ts`): a pending or stale item with `meta.setup: true` whose dependents are all rejected or invalid
becomes rejected ("Not needed: …"), transitively; the service applies it after create, accept and reject. Accepting such a
dependent later still brings its rejected requirements (WP3.1 `planAccept`), so nothing is lost (test). MCP
`accept_proposal {itemIds: "all"}` sends the pending / stale **non-setup** items (their closure brings the setup).
**For the Review UI (P3-R6):** do the same for "Accept all" / "Apply n of m" (accept place items, not setup items), show
setup items folded under the items that require them, and call `reopen` after Undo as WP3.1 says.

#### MCP tools

| Tool | Annotations | What |
|---|---|---|
| `plan_sound_design` | EDIT | the route's arguments (`range` takes any time input); waits for the job (`timeoutSeconds` default 300, ≤ 900; progress notifications; a cancelled request cancels the job); returns `proposalId`, item counts, a text table (`item \| timecode \| cue \| sound \| role \| align \| alternates`), events (why-lines, alternates, layers, notes), skipped cues with codes, warnings, and `next`: ask the user to review it in the Review panel, then `wait_for_proposal`; never accept it yourself. On timeout: the job id for `wait_for_job`. |
| `place_sound` | EDIT | gains `mode: 'propose' \| 'apply'`, **default `propose`** (spec 12 §0 "agents propose"): the same layers, picks, alternates, reason and cue creation as apply mode become one proposal (setup items + one `place` item with the alternates as sets) and nothing changes; a placement that does not apply now (e.g. `track: 'V1'` → `E_TRACK_KIND`) is refused with the item's code and the proposal deleted. `mode: 'apply'` is the Phase 2 behaviour (one transaction). |
| `list_proposals` | READ_ONLY | summaries (counts, decided, expiry); `feature`, `undecided` filters. |
| `get_proposal` | READ_ONLY | revalidates by default; every item with state, reason, selected alternative (`swapped`), note, requires, `setup`, why-line; `ghosts`: a text table `item \| state \| ghost \| track \| start \| end \| what` from `previewProposal` on the live document (setup items one line each; clips with track and timecodes, cues, tracks; ≤ 300 rows, ≤ 400 undecided items previewed); `includeCommands`. |
| `wait_for_proposal` | READ_ONLY | polls every second until `updatedAt` differs from `since` (default: now) or, with `until: 'decided'`, nothing is left to review; ≤ 900 s (default 300); returns `changed \| decided \| applied \| deleted \| timeout`, counts and per non-setup item its state, `swapped {alternative, label}` and note, plus a `notes` list. |
| `accept_proposal` | EDIT | `itemIds: 'all' \| ids`, `partial`; the policy gate's 403 becomes `E_APPROVAL_REQUIRED` with the hint "ask the user to apply it in the Review panel, or to turn on 'Allow agents to apply sound proposals'; do not retry". |
| `reject_proposal` | EDIT_IDEMPOTENT | `itemIds: 'all' \| ids`; returns the changed items (settled setup items included). |

No `note` tool for agents (notes are the reviewer's). `PROPOSALS_GUIDE` (in `FULL_GUIDE`) teaches propose → tell the user
→ `wait_for_proposal` → read the notes → propose again; `SOUND_GUIDE` and its cue section say the same and that apply mode
is only for when the user asked.

#### Verified (measured, this branch; shared host, 16 cores, load average 45–80)

- `pnpm vitest run apps/engine/test/sound-design-plan.test.ts --maxWorkers=2`: 12 passed. Pure (Phase 2 fixture,
  synthetic 36-sound library): every fixture event planned (46, 52, 90, 180, 200…, 250, 330, 350, 408), the same seed gives
  the same picks, rates and offsets, another seed differs; push → 4 distinct whooshes, real recordings before synth, the
  NC sound never offered; typewriter keys never repeat the previous key; rates within ±2 %, offsets ±1 dB; the cut offers
  only hits (mutation: with the type ordering removed this test fails); palette ids (explicit or `'project'`) first;
  sources synth-only / starter-only, the marker as boom + whoosh layers, `NO_SOUND` with its reason; dialogue: no cut under
  words (derived or stored → `DIALOGUE`), a hero under words → support with a note, both back with
  `respectDialogue: false`; stored + derived planned once, `NEAR_STORED`, `MUTED`, `SILENCE`, `NO_TYPES`, explicit ids,
  range; `maxCues` 3 → `LIMIT` for the later cues, alternatives 1; the draft: setup before place items, every `requires`
  earlier, why-line text, title from the sequence name, `createProposal` → all pending, the push's closure = bin, its
  cue, its 4 sounds, itself; accepting all place items composes every item. Real engine (indexed generated kit + Jasper
  Synth, token + editor key): proposal stored with nothing applied (same revision), agent author, origin agent, the push
  a starter whoosh, the same seed again gives the same picks; agent accept → 403 `APPROVAL_REQUIRED`; the editor applies
  every place item in **one transaction (revision + 1)**, every clip's aligned point within 1 flick of its cue frame,
  role as planned, `sfx.level.by: 'default'` with `offsetDb` = the plan's `gainOffsetDb`; planning again → nothing to
  propose; an allowed agent (agentsMayApply) accepts; synth-only sources and explicit cue ids; cancellation during
  registration → job `cancelled`, no proposal (mutation: without the abort checks the proposal list is not empty); 9
  hostile bodies → typed 400 / 404 with no job; a fuzz target (testkit, 30 iterations + 8 properties of mutated bodies):
  no 5xx, every started job ends succeeded with a result of the schema or failed with a code.
- `pnpm vitest run packages/project/test/sound-proposal-draft.test.ts packages/project/test/proposals.test.ts --maxWorkers=2`:
  5 + 21 passed (builder: order, requires, alternatives, the selected alternative placed, reuse of project media with
  provenance added, twins sharing one media, missing sounds left out; settle: own cue settled first, sounds and bin when
  nothing needs them, idempotent, a later accept brings rejected requirements back).
- `pnpm vitest run apps/mcp/test/proposals.test.ts --maxWorkers=1`: 5 passed (real engine on 50011 with token + editor key, 8
  kit files + synth, jasper-mcp over stdio): plan (table, why-lines, marker layers, nothing applied, same seed same
  sounds, strict `style.densty` → `E_UNKNOWN_ARGUMENT`), `list_proposals {undecided}`, `get_proposal` ghosts (create clip
  rows with SFX tracks, cue rows), agent accept → `E_APPROVAL_REQUIRED` with the Review-panel hint, reject 2 items (their
  cues settled), `wait_for_proposal` answered by a note the "user" wrote 1.5 s into the wait, then select alternative 1 +
  editor accept of three items (headless, revision + 1) → `changed` with rejected / accepted / `swapped` / note, the
  swapped item placed the alternate on its cue to 1 flick, a 2 s wait → `timeout`; the user enables agentsMayApply (editor
  save), the agent's `accept_proposal "all"` → revision + 1, no pending or stale left, `wait_for_proposal {until:
  'decided'}` → `applied`, rejected items' cues absent; `place_sound` without mode → a proposal (`place` item with one
  alternate, nothing changed), `track: 'V1'` → `E_TRACK_KIND` and no proposal left.
- `pnpm vitest run apps/mcp/test/sound-cues.test.ts apps/engine/test/sound-design-cues.test.ts apps/engine/test/fuzz-http.test.ts
  apps/engine/test/proposals-fuzz.test.ts`: 181 passed (before merging the integration branch); `apps/mcp/test/{sound-guide,
  readme-tools,conventions,fuzz,sound-examples}.test.ts` + `packages/engine-client/test/client.test.ts`: 393 passed;
  `apps/engine/test/{proposals,proposals-store,security-review,security-hardening,server}.test.ts`: pass. After merging
  the integration branch (default levels, mg cue timing): the touched suites together — `apps/mcp/test/{proposals,
  sound-cues,sound-levels,sound-guide,readme-tools,conventions,fuzz,sound-examples}`, `apps/engine/test/{sound-design-plan,
  sound-design-cues,proposals,proposals-store,proposals-fuzz,fuzz-http}`, `packages/engine-client/test`, `packages/api/test`,
  `packages/project/test/{proposals,sound-proposal-draft}` — 650 of 654 passed in one run; the 4 failures were mine to
  update (the ghost table's setup rows in `proposals.test.ts`, cascading into two later steps; `sound-levels.test.ts`
  placing without `mode: 'apply'`) and pass on rerun of those two files (5 + 1). The plan test's mg frames were updated
  to the merged mg timing (350 / 408).
- **Run for real** (dev engine `JASPER_APPDIR=.stage JASPER_DEV=1 tsx apps/engine/src/cli.ts --port 50001`, Vite on 50002,
  the full 60-sound kit + 152 synth sounds, a scratch MCP client over stdio, the Phase 2 fixture from
  `sound-cues-fixture.ts`): `plan_sound_design {style: {seed: 2026}}` → 17 cues, 60 items (1 bin, 25 sounds, 17 new
  cues, 17 place items), all pending, nothing skipped, 6.9 s (registering 25 sounds as WAV copies; a later plan on the
  registered kit 2.9 s); the agent's accept → `E_APPROVAL_REQUIRED`. In the editor (project open in a browser): accept of
  the 17 place items with the editor key → `appliedBy: session`, History **one** entry "Accept Sound design: … (60 of
  60)", origin `user`, the Cue Seam showing 17 filled cues and the "Sound Effects" bin (screenshot looked at);
  **one Ctrl+Z removed everything** (no cues, no bin, screenshot); `reopen all` → 60 pending, `?revalidate=1` still
  pending; accepted again (revision 4). Document: 18 clips (the marker's two layers) on "SFX 1" / "SFX 2", every aligned
  point exactly on its cue frame, `errorFlicks` 0, rates 0.9835–1.0159. **Export** (`start_export`, Remotion path —
  the lower third needs it — 14 s H.264/AAC) decoded with ffmpeg (mono 48 kHz), loudest 2 ms-RMS point (0.5 ms hop)
  near each cue: 15 of 17 events at 0.00 / −1.00 ms (the clicks' −1 ms is the envelope's resolution); the logo-move whoosh
  (+99 ms) and the marker (+127.5 ms: boom + whoosh layers together, as in WP2.3) were measured again with "SFX 2" muted
  (one MCP transaction, exported, undone): marker boom **0.00 ms**; the whoosh still +99.5 ms — its own file's envelope peak
  is at the descriptor's 0.528 s, but it is flat within 5 % over 100 ms and the cue's pan sweep reweights it in the mono
  downmix, so the loudest point moves (placement exact by the document; not a timing error). Integrated loudness of
  that export −13.7 LUFS, true peak +3.5 dBTP before the merge brought default levels into this branch (gains were 0
  then): levels are Phase 4.
- `pnpm typecheck` (whole workspace) and `pnpm lint` (Biome, tokens, anime, layers, assets): pass (after the merge).

#### Limits and notes for the next packages

- Accepting a place item imports its alternates' sounds too (their setup items are its requirements, so switching to an
  alternate in review always applies): ≤ 4 media per cue, shared across cues by the rotation (25 for the fixture's 17 cues).
- The proposal is validated on the engine's main thread inside the job (≈ 5 ms per item, WP3.1): ≤ 200 cues keeps a plan
  under ≈ 600 items (≈ 3 s, estimated from WP3.1's measurement).
- Ranking is per cue over the whole snapshot once per distinct (types, kind, window, align) request, then the top 24 are
  re-ranked with the neighbourhood; a pack library of thousands of sounds was not measured here.
- `respectDialogue` uses transcript words and Essential Sound dialogue clips (no VAD: P6-R3); stored non-cut cues under
  words are planned (a hero there becomes support).
- `wait_for_proposal` polls (1 s); it reports changes by `updatedAt`, so a revalidation that changed states also counts as
  a change.
- The plan does not touch masking, stop-before, build or room glue (Phase 4); `pan: 'auto'` cues place centred unless the
  deriver wrote a number (WP2.1).
- The session preview (P3-R4) and the Review UI (P3-R6) are the next packages: use `isSetupItem` / `settleSetupItems` as
  above; the report's `events[].itemId` maps to items, `meta.why` is the why-line.

### Phase 3 → WP3.3a session slice, preview and ghosts

Scope: spec 12 §2.5 "Session", §2.7 "Review" (the ghost parts), P3-R4 and the ghost part of P3-R6. The Review panel,
review bar, proposal card and Auto Sound Pass… dialog are WP3.3b; this package is the foundation they use.

Files: `packages/session/src/proposals.ts` (the slice; exported from `@jasper/session`), `packages/project/src/ids.ts`
(`createSeededIdSource`), `proposals/ghost.ts` (`previewProposal(…, {idsFor})`), `packages/api` / `engine-client` /
`apps/engine/src/{proposals/service,routes/proposals}.ts` (route `applied`, below); web `apps/web/src/proposals/{state,
ghosts,GhostLayer,register}.ts(x)`, `commands/proposals.ts`, `panels/program/ProgramMonitor.tsx` (the heard document),
`panels/timeline/TimelinePanel.tsx` (ghost layer, ghost headers, ghost cues), `sound/cues/{CueSeam.tsx,seam.ts}` (ghost
cues clickable / keyboard-reachable; the seam shows for ghost cues), `home/ProjectLifecycle.tsx` (sync), es.json (36
strings). Tests: `packages/session/test/proposals.test.ts` (+ `fake-proposals-engine.ts`, shared with the web tests),
`packages/project/test/proposals-preview-ids.test.ts`, `apps/web/test/proposal-{ghosts-model,ghost-layer,program}.test.*`
(+ `proposal-helpers.ts`), `apps/engine/test/proposals.test.ts` (+1), `packages/engine-client/test/client.test.ts`,
`e2e/sound-proposal-ghosts.spec.ts`.

#### API for WP3.3b (`proposalsFor(session)` → `ProposalsController`; never throws, actions resolve `{ok, …}`)

```ts
proposalsFor(session, opts?: {engine?, debounceMs = 150, setTimer?, clearTimer?}) → ProposalsController  // one per session
c.store: StoreApi<ProposalsState>   // web: useProposals(session, selector, eq?) / useProposalsController(session)
ProposalsState = { status: idle|loading|ready|error|offline, error, list: ProposalSummary[], warnings,
  activeId, proposal: Proposal|null /* as last read from the engine */, items: ReviewItem[], accepted: {[pid]: itemIds},
  selection: itemIds, hear: boolean, preview: ProposalPreviewState|null, stale: {[itemId]: reason}, busy, lastError }
ReviewItem = { id, label, group, requires, setup /* meta.setup (WP3.2) */, state: pending|accepted|rejected|stale|invalid
  |applied, engineState, reason?, note?, alternatives /* sets incl. its own */, selectedAlternative, alternativeLabels, meta }
ProposalPreviewState = { proposalId, revision, base /* the committed doc it was built on */, document /* what Hear plays:
  pending + stale + locally accepted (rejected left out) */, result: ProposalPreview /* every reviewable item, rejected
  included: the ghost geometry */, ghost, heard: itemIds, owner: {entityId: itemId} }
c.connect(subscribe) / c.handleEvent(ProposalChangedEvent)   // web: useProposalsSync(session) (mounted in LifecycleBody)
c.load(); c.refresh(); c.setActive(id | null); c.exit()
c.select(itemIds, 'replace'|'add'|'toggle'|'remove')
c.setItemDecision(itemIds, 'accept'|'reject'|'clear')      // accept: local (+ its requires closure; reopens rejected ones)
c.selectAlternative(itemId, k); c.cycleAlternative(itemId, ±1); c.note(itemId, text|null)
c.apply({trusted: event.isTrusted, itemIds?}) → {ok, applied, stale, label, revision} | {ok:false, code: E_UNTRUSTED|…}
c.discard()   // rejects every undecided item, leaves review; c.remove(proposalId) deletes it
c.setHear(on); c.toggleHear(); c.acceptedIds(); c.flush(); c.previewProposal(id, itemIds|'undecided') → ProposalPreview
heardDocument(state, session)   // web: useHeardDocument(session); useGhostModel(session, seqId)
```

UI commands (agent-exposed, `ui_command`): `proposals.review {proposalId?}` (default: the newest undecided proposal of
the active sequence), `proposals.exitReview`, `proposals.toggleHear {on?}`. No keymap bindings were added (the Review
scope keys are WP3.3b's).

#### Design and decisions

- **Decisions.** The engine stores rejected and applied (`accepted`); "accepted, not applied yet" is local to this
  window (`accepted[proposalId]`, kept per proposal while switching reviews) until Apply. Accept takes the item's
  `requires` closure along (as `planAccept` will) and reopens rejected ones first; reject / clear go to the engine
  (`reject` / `reopen`), shown optimistically until it answers; an item the engine decided otherwise drops its local
  accept. Rejecting an applied item is refused ("undo it in History").
- **Apply path: the engine's accept route with the editor key** (WP3.1's design), not a local `session.apply`: the
  engine composes ONE transaction, relays it into this session as the user's edit (History "Accept <title> (n of m)",
  origin `user`) and records the items accepted with the transaction's revision and refs, atomically under its
  per-proposal lock — the stored states can never disagree with the document. `partial: true` (stale items are left
  out and returned: never silently dropped), `expectedRevision` = the session's. `apply` refuses without `trusted`
  (`event.isTrusted`): an agent's `ui_click` is synthetic, and its live-UI requests carry `x-jasper-agent-input`, so
  the engine would treat them as an agent's (403) anyway.
- **Undo / Redo.** The slice records the History entry of each Apply (by its `revisionAfter`). When that entry is undone
  (Ctrl+Z, History panel) it calls `reopen` and puts the items back as locally accepted — decisions intact, rejected
  ones still rejected, ready to Apply again. Redo would put the clips back while the engine says pending (accepting
  again would duplicate them), so a redo calls the new **editor-only route `POST …/:id/applied {itemIds, revision,
  refs}`** (records them accepted with the original refs; nothing is applied; agents get `403 APPROVAL_REQUIRED`;
  ids/refs checked; README, security review AGT-3 table). An entry dropped by a later edit ends the follow-up.
- **Preview.** `previewProposal` on the committed document, recomputed 150 ms after `doc.changed` or a decision, with a
  local `revalidate` (stale items flagged with the reason; an item that does not apply in the preview is stale too).
  Ids are **seeded per item and alternative** (`createSeededIdSource('<prp>:<item>:<k>')`, new `idsFor` option): a
  recomputed preview keeps its clips on the same ids whatever else changed, so the Program monitor's render document
  keeps them (`stabilizeRenderDoc`) and their players. Two previews when something is rejected: the ghost geometry
  (rejected included, drawn hatched) and the heard document (without them, but with any rejected item a heard one
  requires, as accepting would).
- **Hear proposal.** The Program monitor's document is `heard ?? drawn` (`useHeardDocument`): picture AND sound come
  from it (the mix graph lives in the composition), the session document and History are untouched (tests), a gesture
  (a drag, an In Context audition) shows its own transient instead, rendered previews are not used while hearing. A
  chip "Hearing proposal: <title>" says so. Switching swaps the Player's document in place: no seek, no restart.
- **Ghosts.** `buildGhostModel` (pure) from `preview.result.items` (one transaction per item, so every created / changed
  / deleted entity has its item): created clips → ghost clips; created tracks → ghost lanes (below the last audio row,
  above the top video row) and ghost headers "A4 · SFX 1 (new)"; changed clips → the ghost at the new place over a
  `--pr-ghost-remove` wash at the old one; deleted → the wash; created / changed cues → ghost cues on the Cue Seam
  (changed ones under `<id>~ghost`). Setup items (WP3.2 `meta.setup`) are folded into the first item that needs them
  (their cue ghosts belong to the placement). Paint (tokens only): pending 1 px dashed `--pr-ghost-stroke` over
  `--pr-ghost-fill`; accepted solid + ✓ `--pr-success`; rejected 35 % opacity, a hatch and ✕; stale / invalid
  `--pr-warning` + "!"; agent proposals a 3 px `--pr-agent` left bar; selected 2 px `--pr-focus-ring`; high contrast
  2 px solid everywhere and pending gets ○ (state by glyph); nothing animates.
- **Interaction.** Click: select the item, open its card (pinned); rest 350 ms: the card (transient). Card = why-line
  (`meta.why`, else `meta.reason`; WP3.2 writes `why`), facts computed from the preview (what lands where, length, gain;
  "New track A4 · SFX 1"; removals; cues) plus `meta.facts` (≤ 4 strings), the stale reason, the note; buttons Accept /
  Reject (toggles), ⇄ Alternate k/n (route `select`), ▶ Play (Hear on for the item's window: pre-roll from the Sound
  Library preference, 1 s after, then Hear as it was; WP2.4b's `playTimelineWindow`), ✎ Note, and **Apply n of m**
  (n = accepted non-setup items) for a trusted click. Keyboard: the review items are one tab stop (listbox,
  `aria-activedescendant`, names "Proposed: <label>, <state>, at <tc>. <why>"): ←/→/Home/End in time order, Enter
  accept, Delete/Backspace reject, U clear, A Hear, I / Shift+F10 / context-menu key open the card (focus moves in), Esc;
  on the Cue Seam ←/→ reach ghost cues too (their item is selected) and Enter / click opens the item's card.

#### Verified (measured, this branch; shared host, 16 cores)

- `pnpm vitest run packages/session/test/proposals.test.ts --maxWorkers=2`: 10 passed — list + `proposal.changed` sync
  (another client's reject re-reads the active proposal; deletion ends the review), typed failures, the preview document
  (heard items, ghosts attributed per item, the session document and History untouched, `heardDocument` off / during a
  gesture), the 150 ms debounce on `doc.changed` with stable ids, stale after a moved anchor ("frame 100 → 120") and
  revived when moved back, local accept (+ closure) vs stored reject / clear / reopen-then-accept, alternatives and
  notes, `previewProposal(id, itemIds)`, Apply refused untrusted, Apply = ONE History entry "Accept Sound pass (3 of 4)"
  (origin user), Undo → reopened with decisions intact, Redo → recorded through `applied`, Undo + Apply again, stale
  items reported by Apply. Mutation checks: without the Undo hook, or without the trust check, the apply test fails.
- `pnpm vitest run packages/project/test/proposals-preview-ids.test.ts`: 4 passed (seeded ids deterministic and
  well-formed, 300-run property; 20 000 ids without a repeat; an item keeps its ids whatever else is previewed).
- `pnpm vitest run apps/web/test/proposal-ghosts-model.test.ts apps/web/test/proposal-ghost-layer.test.tsx
  apps/web/test/proposal-program.test.tsx`: 8 + 7 + 2 passed — the model (ghost clips on a new track, wash + ghost for a
  moved clip, ghost cue for a moved cue, setup items folded, hostile input), geometry (new track rows, x at the frame,
  culling and scroll), keyboard order, paint per state and high contrast, glyphs, why-line (hostile `meta` too); the
  layer on a real session: styles, agent bar, ghost header, card actions (Accept / Alternate / Note / Reject), synthetic
  Apply refused, the keyboard composite (←/→, Enter, Delete, U, A, I, Home / End), high contrast, nothing animated, ghost
  cues on the Cue Seam (click, ←/→, Enter); the Program monitor: with Hear on its duration is the preview's (00:00:17:10
  vs 00:00:04:00), the chip shows, the session document and History are untouched, a gesture shows its transient; the
  render document carries the proposal's audio clips and keeps the unchanged clips' render objects across A → B → A.
  Mutation check: with the Program monitor reading the drawn document only, the first Program test fails.
- `apps/engine/test/proposals.test.ts` (+1: `applied` — agent 403, unknown item 404, bad ref 400, unknown key 400,
  recorded with revision and refs, nothing saved, event, idempotent), `packages/engine-client/test/client.test.ts`
  (+`markProposalApplied`), `fuzz-http.test.ts` (finds the new route).
- After merging `feat/sound-design` (WP3.2; load 30–37): `pnpm vitest run --project @jasper/session --project
  @jasper/web --maxWorkers=4` → 139 files, 982 tests passed; `apps/engine/test/{proposals,proposals-store,
  proposals-fuzz,fuzz-http,sound-design-plan,security-review}.test.ts apps/mcp/test/proposals.test.ts packages/engine-client
  packages/api packages/project/test/{proposals,proposals-preview-ids,sound-proposal-draft}.test.ts` → 14 files, 302
  passed; `pnpm vitest run --project @jasper/project --maxWorkers=4` → 158 files, 1 955 passed; `pnpm typecheck`, `tsc -p e2e/tsconfig.json`, `pnpm lint`, `pnpm notices --check`,
  `node scripts/i18n.mjs --check` (9 213 strings): pass.
- Then merged `feat/sound-design` 61f33b61 (WP4.1a, `packages/audio-fx` only; no conflicts): `pnpm typecheck` and
  `pnpm lint` passed.
- **Real app** (built stack): `E2E_PORT=50103 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-proposal-ghosts.spec.ts`.
  The Phase 2 fixture plus a click bed on A1 (0.25 every 0.5 s from 0.1 s) and hit.wav (0.6 at 0.25 s); an agent
  (token, `x-jasper-agent`, no editor key) creates a 4-item proposal (SFX track; hits on the cut 87, the push 177, the
  marker 247); its accept → 403 APPROVAL_REQUIRED. `proposals.review` → 3 ghost clips within 2 px of their frames'
  x, all pending, `1px dashed var(--pr-ghost-stroke)`, computed left border `3px solid` in the agent colour, inside the
  ghost lane; header "A4 · SFX 1 (new)". Program audio tapped (`e2e/sound-tap.ts`), samples after the bed's first click:
  Hear off → bed only, every gap 24 000; Hear on → the cut's hit at **146 539 = round(87 / 29.97 × 48 000) + 12 000 −
  4 800, exactly**; switched on 1.2 s into the play → the hit at the same 146 539, bed gaps exact; switched off → no hit.
  Runs: 1 (load ≈ 50) + 3 (`--repeat-each=3`, load 14–21) + 1 (merged build, load ≈ 30): 5 of 5 passed. The hit
  after a switch on was on its sample in 5 of 5; the bed stayed sample-exact across the switch in 4 of 5 switch-on and
  3 of 5 switch-off plays — in the others Remotion re-anchored every player (+8 000 … +9 024 samples, see Limits; both
  in the load ≈ 50 run, one at 14–21); playhead at the pause 109–124 frames (never restarted); longest main-thread task
  within 1 s after the switch 0–123 ms (long-task timing). Then on the cards: accept cut, accept push, reject boom
  (stored: rejected; ✓ / ✕ glyphs, 0.35 opacity), high contrast (2 px solid, header too), reduced motion (no ghost
  animates or transitions); Apply 3 of 4 (a real click) → History gains exactly "Accept E2E sound pass (3 of 4)",
  stored accepted / rejected, audio clips at 0, 87, 177, the rejected ghost stays; Ctrl+Z → History as before, the
  cut and push ghosts back **accepted**, boom rejected, the ghost header back, stored pending / rejected.
  Screenshots looked at (`test-results/e2e-sound-proposal-ghosts/`: ghosts, decided, high-contrast, reduced-motion,
  applied, undone), and earlier on the dev stack (ports 50101/50102): the card, the hatched rejected ghost, the applied
  clips on A4, ghosts back after Undo.
- **Every sound e2e on the merged build** (load ≈ 15–30): `e2e/sound-proposal-ghosts.spec.ts e2e/sound-p0-transport.spec.ts
  e2e/sound-p0-preview.spec.ts e2e/sound-cues.spec.ts e2e/sound-fill.spec.ts e2e/sound-library.spec.ts
  e2e/sound-p2-done.spec.ts`: **17 passed** (6.0 min) — the Phase 0 transport and preview checks (primed start, seeks,
  latency change) unaffected.
- Investigated (scratch, dev stack): Remotion's "reschedule" the tap reports ≈ 1.0 s into a play is the premount of a
  clip that starts later (≈ 2.9 s); it happens the same with the clip committed (not a preview effect) and leaves the
  audio exact. Adding a track by an agent transaction during playback (no proposal at all) makes Remotion re-anchor the
  bed by ≈ 185 ms in 3 of 3 plays on the dev build: the switch's occasional skip is the same transport behaviour.

#### Limits and notes for WP3.3b

- **Switching while playing** keeps the transport going (never a seek or restart) and the proposal's sounds land on
  their exact samples, but Remotion may re-anchor every player after a main-thread stall: then the audio skips ≈ 185 ms
  (8 000–9 100 samples) — in 1 of 5 switch-on and 2 of 5 switch-off plays (load 14–50), and in unswitched plays alike
  under load (7 of 8 Hear-off plays at load ≈ 50 were replayed for it). It happens the same when an agent adds a track
  during playback without any proposal. Static A and B are sample-exact. Not fixed here (Remotion's transport; Phase 0
  close-out limits).
- Ghost lanes of new tracks are drawn below the last audio track; the audio region's scroll range does not grow for
  them, so in a short Timeline they can be off-panel until the panel is taller.
- The preview and the re-validation run on the main thread (dry runs; ≈ 5 ms per item for the re-validation per WP3.1's
  measurement): several hundred items make each recompute (150 ms after an edit) noticeable.
- Entering review has no menu or card yet (`proposals.review` via the command catalogue): WP3.3b's proposal card / Review
  panel call `setActive`. Keymap Review scope, the review bar (◀ ▶, A/B, Accept all, Reject all, Apply, Discard, Exit),
  the "Undo / Reopen review" toast and grouping by role (fold setup items with `ReviewItem.setup`) are WP3.3b's.

### Phase 3 → WP3.3b Review panel, review bar, Auto Sound Pass

Scope: spec 12 §2.7 "Review" (proposal card, review bar, Review panel, A/B, alternates, notes, stale handling,
trusted-event Apply, Undo with Reopen review, Auto Sound Pass… dialog), the Review keymap scope, the Sound Design
workspace's Review group, the "Allow agents to apply sound proposals" preference, P3-R6 (the parts WP3.3a left) and the
Phase 3 "Done when". Built on WP3.3a's session slice (`proposalsFor`) and ghosts; nothing in it applies or decides
except through the WP3.1 routes.

Files: web `apps/web/src/proposals/{review.ts (pure model), actions.ts (shared actions + announcer), keys.ts,
ReviewBar.tsx, ProposalCards.tsx, GhostLayer.tsx (card Apply → shared Apply)}`, `panels/review/{index.ts, ReviewPanel.tsx,
badge.tsx}`, `panels/types.ts` (`review` kind, optional `badge`), `panels/registry.ts`, `shell/dock/DockHost.tsx` (tab
badge), `shell/AgentApprovals.tsx` (cards + live region in the stack), `shell/workspaces/definitions.ts`,
`commands/{proposals.ts, keymap-defaults.ts, app.ts, sound-design.ts}`, `shell/menus/model.ts`,
`sound/{AutoSoundPassDialog.tsx, plan-run.ts, PreferencesPage.tsx, fill.ts (direct Fill Unfilled removed)}`,
`agent-bridge/agent-input.ts` (`userGestureActive`), `panels/timeline/TimelinePanel.tsx` (bar, zoom to the proposal,
playhead offset), es.json (158 strings); `packages/ui` icon `panel.review`; `packages/session/src/proposals.ts`
(`read(proposalId)`; a `waiting` event does not re-read the proposal); `packages/api` (`ProposalSummary.waiting`,
`proposal.changed` `waiting`, plan `style.cueSources`); engine `apps/engine/src/proposals/waiting.ts`,
`routes/proposals.ts`, and two lines in `sound-design/plan.ts` (`cueSources` → `deriveCues({sources})`; see Decisions).
Tests: `apps/web/test/{review-model,review-ui,auto-sound-pass}.test.*` (+ `review-helpers.ts`),
`sound-fill-swap.test.tsx` / `sound-p2v-variation.test.tsx` / `proposal-ghost-layer.test.tsx` (updated),
`apps/engine/test/{proposals-waiting,sound-design-plan-cue-sources}.test.ts`, `proposals.test.ts` (+1),
`e2e/sound-review.spec.ts`, `e2e/sound-fill.spec.ts` (updated). Docs: README (HTTP: `waiting`, `cueSources`), security
review (the polling row), gaps.

#### What it does (usage)

- **Proposal card** (the agent notices stack, top centre; `ProposalCards.tsx`): one per agent-authored proposal with items
  to review that is not under review and not dismissed (newest three): "<agent> proposes <title>: <n> sounds on <k> new
  tracks" (counted from a preview of the undecided items: created audio clips and tracks; other features "n items"), the
  proposal's summary, and "<agent> is waiting for your review" while the agent polls it. No countdown, never takes focus.
  **Review** opens it (its sequence becomes active, ghosts appear, the Timeline zooms to it, the Review panel is
  focused); **Dismiss** hides the card in this window (sessionStorage; the proposal stays in the Review panel's list).
  The user's own proposals (Auto Sound Pass…, Fill Unfilled Cues) open review directly and never get a card.
- **Review panel** (`review`; Window ▸ Review; in the Sound Design workspace below the Library group, with Markers,
  History and Jobs): the proposal selector (the project's proposals with items to review, newest first); the title,
  author and counts (n items, ✓ accepted, ✕ rejected, · pending, ! stale or invalid, applied) and the waiting line; the
  item list — a listbox, one tab stop, `aria-activedescendant`, names like "Hit on the cut, Accepted, at 00:00:03:00.
  Cut, Heavy metal hit, support, −11.0 dB. alternate 2 of 4. cut cue. note: …" — grouped by role (Hero, Support, Bed,
  Layers, other groups, Tracks) in time order. A row: ✓ / ✕ / · decision buttons, timecode, the cue kind's glyph (the
  Cue Seam's shapes), the sound of the chosen set, ▶ (in context), ⇄ n/m (next alternate), ✎ (note), the state in
  glyph + word; a second line with role, gain (the ghost clip's, else the plan's offset) and the cue's reason, or the
  stale / invalid reason in `--pr-warning`; "▸ n setup items" folds the bin / sound / cue items under the first row that
  needs them (setup items nothing needs are listed apart, outside the listbox). Pressing a row selects its ghost, moves
  the playhead to its anchor (when not playing), scrolls the Timeline there and shows the **details**: why-line, facts
  (what lands where, new tracks, removals), the problem, ▶ Play in context, ◀ ⇄ Alternate k/n: <label> ▶, the note editor
  (Ctrl+Enter saves, Esc cancels; stored by the engine, read by agents), "Comes with: …". Footer: ✓ Accept all, ✕ Reject
  all, A/B (pressed state), **Apply n of m**. The tab shows a count (items left in the proposal under review, else
  proposals with items to review).
- **Review bar** (top of the Timeline while a proposal of its sequence is under review): ✦ "Reviewing: <author> ·
  <title> · n items" (the agent's 3 px bar), the waiting line, ◀ ▶ (time order), A/B, Accept all, Reject all, Apply n of
  m, Discard (confirmation "Discard “<title>”? The proposal is deleted; <agent> is told it was discarded. Nothing in
  your sequence changes." → the delete route), ✕ Exit. Entering review zooms the Timeline to the proposal's ghosts (at
  least 4 s, once per review).
- **Review keymap scope** (the Review panel): Enter / NumpadEnter accept (with what the item requires), Backspace /
  Delete reject, U clear, A A/B, Space ▶ the item in context (pre-roll from the Sound Library preference → its tail + 1 s,
  heard), Shift+Space the range (2 s before the first item to the end of the last, heard), Ctrl+Enter (mac Cmd+Enter)
  Apply, Esc exit, Up / Down the rows (Home / End in the list). Rebindable (Keyboard Shortcuts); the list resolves the
  scope itself because the dispatcher treats a listbox as an overlay (as the Sound Library does). Every `proposals.*`
  binding is in the `review` scope only (tested on win / linux / mac; the Timeline's Space is still Play).
- **Apply** (`actions.ts applyReview`, used by the panel, the bar, the ghost card and `proposals.apply`): only for a
  trusted gesture — a button's `event.isTrusted`, or for the shortcut / menu / palette `userGestureActive()` (a real key
  press or click within 1.5 s and no agent live-UI input running; an agent's `ui_key` / `ui_command` is agent input, so
  it is refused). Items that would remove the user's clips are named first ("Apply 1 of 1? Also removes 1 of your clips:
  “Shot B”"); confirming is the approval (the engine's editor-key accept is `approved`, no second card). Then the
  WP3.3a engine accept (ONE History entry "Accept <title> (n of m)", origin user, stale items left out and reported). The
  toast: "Applied <n> of <m> sounds from <author>" (15 s) with **Undo** (when it is still the top History entry) and
  **Reopen review** (undoes it if it is the top entry, then reviews the reopened proposal; after a Ctrl+Z it just
  reopens). The review stays open after Apply (rejected items stay visible, Ctrl+Z brings the applied ones back
  into it as accepted; WP3.3a's e2e relies on it); Exit / Esc ends it. Every decision, navigation and Apply is announced in
  one aria-live region (`ReviewAnnouncer`, mounted with the stack).
- **Auto Sound Pass…** (Sequence ▸ Sound Design, the Review panel's empty state and menu): Range (whole sequence, In to
  Out, selected clips), "Find cues from" (the eight Suggest Cues sources with "n found · k kept"), Density, Palette / kit
  (the sequence palette, no preference, or prefer the sounds of one source: up to 500 of its commercial-safe ids as the
  plan's palette), "Sounds from" (starter kit / packs / your folders / Jasper Synth with their library counts), Respect
  dialogue. The only button is **Propose**: it runs `POST /api/sound-design/plan` (the job shows in the Jobs panel and
  as a progress bar in the dialog; closing the dialog cancels the job, a cancelled plan stores nothing) and opens review
  on the proposal; "Nothing to propose. 1 cue skipped: …" keeps the dialog open.
- **Fill Unfilled Cues** now proposes: the plan route with the ids of the unfilled, unmuted, non-silence cues
  (`respectDialogue: false`: the user picked these cues), label "Fill Unfilled Cues"; a progress toast, then review opens
  (Review panel focused). The direct-apply path (`fillUnfilledCues`) is removed.
- **Preferences ▸ Sound Library ▸ Proposals**: "Allow agents to apply sound proposals in “<sequence>”" — the active
  sequence's `soundDesign.settings.agentsMayApply` written with `soundDesign.setSettings` as the user's undoable edit
  ("Allow Agents to Apply Sound Proposals"); off by default; an agent setting it is still the approval-card case (WP3.1).
- **Agents**: `proposals.review`, `exitReview`, `toggleHear`, `nextItem` / `prevItem {order}`, `acceptItem` /
  `rejectItem` / `clearItem {itemId?}`, `acceptAll`, `rejectAll`, `cycleAlternative {itemId?, dir?}`, `playItem`,
  `playRange` are in the UI command catalogue (`ui_command`); `proposals.apply` and `proposals.discard` are not exposed
  (Apply refuses agent input anyway). An agent waiting in `wait_for_proposal` is shown to the user without any MCP change.

#### Decisions

- **"Waiting" is inferred by the engine** (`proposals/waiting.ts`): jasper-mcp is not this package's to change, and
  `wait_for_proposal` reads the proposal every second without `?revalidate` while `get_proposal` revalidates. Two such
  agent reads within 2.5 s = waiting (since the first), none for 3.5 s = stopped; each flip is a `proposal.changed`
  `waiting` event, the list carries `waiting`. An agent that polls `get_proposal {revalidate: false}` in a loop would show
  as waiting too (it is, in effect).
- **`style.cueSources` in the plan** (API + `resolveStyle` + the `deriveCues` call, 5 lines in `sound-design/plan.ts`):
  the dialog's "Find cues from" cannot be honoured otherwise (`cues: 'auto'` derived from every source). The parallel
  WP4.1b works in that file; its hunks (imports, `PlanDeps`, `runPlan` gains) do not overlap these lines (checked against
  `feat/sd-p4-bed-rebalance` 60802a50). jasper-mcp's `plan_sound_design` does not expose `cueSources` yet (apps/mcp is
  WP4.1b's now): left for the next MCP change.
- **Accept all** = every pending or stale item (a rejected one stays rejected: "Accept all" after rejecting two keeps
  your two rejections); **Reject all** = everything not applied. Setup items never count in "n of m".
- **Discard deletes** the proposal (the delete route, after a confirmation), as the task asked; WP3.3a's `discard()`
  (reject everything) stays available for code but is not on any button. An agent waiting gets `deleted`.
- **Rows select on press**, not on click: the details pane appears under the list and moves the rows before the
  release, so a click could land on another row (found in the first e2e run: the click on the cut row chose the hero
  row). A click into the list never selects the first row (only keyboard focus does).
- The proposal selector shows "<title> · <author>" (the summary's counts include setup items; the panel's own counts
  are the reviewer's).
- The panel tab badge is an optional `PanelDefinition.badge` component (rendered in the dock tab next to the title,
  with a screen-reader sentence).
- One aria-live region for the review (in the notices stack) instead of one per surface (no double announcements).
- The Apply toast lasts 15 s (success toasts are 4 s by default) so Reopen review stays reachable.

#### Verified (measured, this branch; shared host, 16 cores, load average 10–56)

- `pnpm vitest run apps/web/test/review-model.test.ts`: 8 passed — grouping by role / time order / setup folding
  (bin needed through a sound folds under the first row needing it), frames and gains from the ghosts, counts without
  setup items, navigation ends, the range, the card sentence (singular / plural, other features), card counts and
  removals from a real preview (the fixture: 2 sounds on 1 new track), and a 300-run property over fuzzed items and
  `fc.anything()` meta (never throws, every non-setup item shown once).
- `apps/web/test/review-ui.test.tsx`: 12 passed (real session + the fake proposals engine): options and states, the tab
  badge, a row press selects / seeks to 30 / shows the why-line; keyboard in the list (↓, Enter accepts with its
  requirement, Backspace rejects through the engine, U, A twice) with nothing applied; Next alternate stored
  (`selectedAlternative` 1) and the note stored and in the row's name; Accept all keeps a rejection, "Apply 4 of 5",
  Reject all clears the badge; Apply refused for a synthetic click and for `proposals.apply` inside agent input (no
  accept call); Ctrl+Enter by the user → History "Accept Sound pass (2 of 5)", toast "Applied 2 of 5 sounds from
  sound-agent" with Undo / Reopen review, Reopen review → undone (index 1), back in review, hit / trk accepted, boom
  rejected, `reopen` called; the destructive confirmation text "Apply 1 of 1? Also removes 1 of your clips: “…”" —
  cancel applies nothing, confirm removes the clip; the bar (title, ◀ ▶, A/B, Exit), Discard's confirmation → deleted;
  the card (agent only — the user's own gets none —, "sound-agent proposes Sound pass: 2 sounds on 1 new track", the
  waiting line, Review opens it and hides the card, Dismiss); the review-scope bindings on win / linux / mac, all
  `proposals.*` bindings in `review` only, Timeline Space still Play; the preference writes `agentsMayApply` as
  "Allow Agents to Apply Sound Proposals" (origin user) and undo restores it. Mutation checks: with
  `proposals.apply` trusting every caller the untrusted test fails; with the card's agent filter removed the card test
  fails.
- `apps/web/test/auto-sound-pass.test.tsx`: 4 passed — "2 found · 2 kept" / "1 found · 1 kept", library counts, only
  Propose; unticking markers and synth and "Prefer Starter kit" → the request's `cueSources` (7), `sources` (3), the
  kit's ids as palette, no range; nothing applied, review on the stored proposal, toast "Proposed sounds for 3 cues";
  nothing to propose keeps the dialog open with "Nothing to propose. 1 cue skipped: …"; closing while the job runs
  cancels `job_1`; the request builder (defaults when every source is on, a range for In–Out).
- `apps/web/test/sound-fill-swap.test.tsx` (Fill Unfilled Cues: the plan request with the four unfilled cue ids, the
  muted one left out, `respectDialogue: false`, nothing applied, review on the stored proposal; nothing to propose →
  warning with the skip reason; disabled once filled), `sound-p2v-variation.test.tsx` (the plan route failing → one
  toast "Could not fill the cues"), `proposal-ghost-layer.test.tsx` (the card's Apply refusal through the shared Apply).
- Engine: `apps/engine/test/proposals-waiting.test.ts` (3: a 1 s poll is a wait from its first read, announced once,
  ends 3.5 s after the last read; far-apart reads, another agent, forget, separate proposals; bounded) and
  `proposals.test.ts` (+1: the editor's reads and an agent's revalidating reads are not a wait; two plain agent reads
  → listed `waiting` and one `waiting` event; deletion is silent), `sound-design-plan-cue-sources.test.ts` (2: only the
  chosen sources' derived cues, all of them in the full run; the schema refuses `[]` and unknown sources; mutation:
  without the `sources` pass-through the first test fails).
- Before merging the integration branch: `pnpm vitest run --project @jasper/web --project @jasper/session
  --maxWorkers=4` → 142 files, 1 006 passed; the engine / api / engine-client / MCP proposal suites (15 files) → 290
  passed. After merging `feat/sound-design` (WP4.1b): the touched suites (19 files, incl. the plan, plan-levels, MCP
  proposals, fuzz-http, the web review tests, i18n, keymap) → 299 passed; `pnpm typecheck`, `pnpm lint`, `tsc -p
  e2e/tsconfig.json`, `pnpm notices --check`, `node scripts/i18n.mjs --check` (9 369 strings): pass.
- **E2E** (built stack, `E2E_PORT=50405 E2E_SKIP_BUILD=1 pnpm exec playwright test …`): `e2e/sound-review.spec.ts`
  (2 tests) — the agent (token, `x-jasper-agent`, no editor key) runs the plan on four stored cues of the Phase 2
  fixture → nothing applied → the card "e2e-sound-agent proposes Sound design: Sequence 01: 4 sounds on 1 new track" and,
  while it polls, "… is waiting for your review" → Review: the bar, every ghost inside the zoomed track area → press
  rows + Enter / Enter / Backspace, Next alternate, a note (stored by the engine: rejected, alternative 1, the note) →
  Ctrl+Enter = ONE History entry "Accept Sound design: …", toast "Applied 2 of 4 sounds from e2e-sound-agent", the cut
  plays its alternate's sound → Exit, Ctrl+Z, toast ▸ Reopen review → rows accepted / accepted / rejected / pending,
  stored pending with the alternative and the note intact → `soundCue.update` 90 → 100 under the cut → the row stale
  "… (frame 90 → 100)" → Ctrl+Enter → "Applied 1 of 4 sounds", "1 stale items left in review", the push applied, no clip
  on the moved cue. Then Auto Sound Pass… on four solids ("3 found · 3 kept") → Propose → review (no card), Accept
  all → "Apply 3 of 3" → one entry, "Applied 3 of 3 sounds from you" → native export, each placement located by
  cross-correlation with its registered media, in samples from the cue frames: **0 / 0 / −1, 0 / 0 / +1 and 0 / 0 / 0**
  (three runs; equal to the offset from where the document puts them; r ≥ 0.99). Screenshots looked at (`test-results/e2e-sound-review/`: card, review,
  decided, decided-high-contrast, applied, reopened, stale, auto-pass-dialog, auto-pass-review, auto-pass-applied); the
  first looks found the row click selecting the wrong row (fixed: select on press), names truncated by the role / gain
  columns (moved to the second line), the details pane squeezing the list (capped at 40 %, one-line alternates) and "1
  proposals" (singular).
- Every sound e2e (before the merge; load 37–56): `sound-review`, `sound-fill`, `sound-cues`, `sound-library`,
  `sound-p0-preview`, `sound-p0-transport`, `sound-proposal-ghosts`, `sound-p2-done` → 17 of 19 passed in the first run;
  the two failures were this package's: `sound-p2-done` still expected Fill Unfilled Cues to apply (updated like
  `sound-fill`: review → Accept all → Apply, label "Accept Fill Unfilled Cues (n of m)") and `sound-proposal-ghosts`
  expected the review to stay open after Apply (the review no longer exits by itself). Rerun: both pass; `sound-p2-done`
  then found the cut's added layer 8 samples off (r 0.70) under the plan's (different) base sound on the same peak — a
  correlation artefact: re-measured in an export with the other clip disabled it is 0 samples (r 1.00). The spec now
  does that re-measurement for an overlapped clip outside ±2 samples, with the same ±2-sample bound.
- After the merge (WP4.1b's plan gains; `pnpm build`, load 49–69): `sound-fill`, `sound-p2-done`, `sound-review` (2) pass;
  `sound-proposal-ghosts` failed once on its "Hear off" bed spacing (a click 512 samples late after three plays
  retried for Remotion re-scheduling — the WP3.3a limit "switching / load", Hear off involves no proposal) and passed
  alone on the rerun (load 55–63).

#### Limits and notes for the next packages

- jasper-mcp `plan_sound_design` cannot pass `style.cueSources` yet (MCP strict args); the route takes it.
- The stale reason comes from the model ("cue_… changed since the proposal was made (frame 90 → 100)"): it names the
  cue by id, not by its timecode.
- With a proposal of several hundred items the panel renders every row (no virtualisation); measured only with ≤ 60
  items (the e2e fixture). The card's counts preview runs once per proposal change on the main thread (≈ 5 ms per item,
  WP3.1's measurement; estimated).
- "Waiting" disappears 3.5 s after the agent's last poll; an engine restart forgets it until the next poll.
- The Sound Design workspace layout changed (Review group below the Library); a stored workspace layout keeps its old
  shape until Window ▸ Workspaces ▸ Reset to Saved Layout (the panel opens next to Markers from Window ▸ Review).

### Phase 3 verification

Branch `feat/sd-p3-verify` (from `feat/sound-design` d932e86a; the helper branch `feat/sd-p3v-web` merged into it). Scope:
the whole of Phase 3 (P3-R1…R6, "Done when", the Definition of Done) after WP3.1–WP3.3b, the five follow-ups the
WP3.3b note left (cueSources in MCP, stale reasons, a large Review list, stored workspace layouts, ghost lanes and the
vertical scroll), and a review of the Phase 3 code for security, atomicity and the accept / undo / redo / reopen state
machine. Shared host, 16 cores; the load average was **36–187** for the whole pass (other projects' builds and agents),
so every timing below states its load and is a before/after on the same build and host.

#### Requirements (spec 12 Phase 3) with evidence

| Requirement | Status | Evidence (rerun) |
|---|---|---|
| P3-R1 model, `composeAcceptTx`, `proposalGhost`, validation; A then B ≡ A ∪ B; reject leaves the document identical | done | `packages/project/test/proposals.test.ts` (the four fast-check properties, WP3.1), `proposals-preview-ids.test.ts`, `sound-proposal-draft.test.ts`; new here: readable stale reasons and `StaleProblem` (moved / deleted clip, cue, marker; requirement; conflict) |
| P3-R2 engine store, routes, event, expiry, policy gate | done | `apps/engine/test/proposals.test.ts` (+2 here: reviewer-only routes, reopen while applied, redo record), `proposals-store.test.ts` (+1: no expiry / eviction under an accept), `proposals-fuzz.test.ts`, `proposals-waiting.test.ts`, `fuzz-http.test.ts` |
| P3-R3 plan job: cues → rank → register → place → proposal, deterministic by seed; style density, palette, sources, respect dialogue (+ `cueSources`) | done | `apps/engine/test/sound-design-plan.test.ts`, `sound-design-plan-cue-sources.test.ts`, `sound-design-plan-levels.test.ts` (Phase 4 gains) |
| P3-R4 session slice and preview document; the Program monitor plays a proposal's picture and sound | done | `packages/session/test/proposals.test.ts`, `proposals-perf.test.ts` (new), `apps/web/test/proposal-program.test.tsx`, `e2e/sound-proposal-ghosts.spec.ts` (Hear on: the hit on its exact sample) |
| P3-R5 MCP `plan_sound_design`, `place_sound` propose, `list_proposals`, `get_proposal`, `wait_for_proposal`, `accept_proposal`, `reject_proposal`, `PROPOSALS_GUIDE` | done | `apps/mcp/test/proposals.test.ts` (+ `style.cueSources` here), `sound-guide.test.ts`, `readme-tools.test.ts`; `e2e/sound-p3-mcp.spec.ts` (new: the whole loop through the built jasper-mcp) |
| P3-R6 card, ghosts, review bar, Review panel, A/B, alternates on ghosts, notes, stale handling, trusted Apply, Undo with Reopen review, Auto Sound Pass… | done | `apps/web/test/review-ui.test.tsx` (+2 here), `review-model.test.ts` (+1), `review-virtual.test.tsx` (new, 500 items), `review-stale-text.test.ts` (new), `proposal-ghost-layer.test.tsx`, `proposal-ghosts-model.test.ts`, `auto-sound-pass.test.tsx`, `workspace-migration.test.ts` (new); `e2e/sound-review.spec.ts` |
| "Done when": reviewed, partly accepted, applied as one undo step, undone back into review; accept on a changed document reports stale; E2E | done | `e2e/sound-review.spec.ts` (agent plan → card → review → Apply 2 of 4 = one entry → Ctrl+Z → Reopen review with decisions intact → a cue moves → stale with "Cut cue at 00;00;03;00 moved to 00;00;03;10" (a drop-frame sequence) → Apply reports it), `e2e/sound-p3-mcp.spec.ts`; results below |

Definition of Done: no schema change in this pass (proposals live outside the document; `soundDesign.settings.agentsMayApply`
already had its read-time default and repair); every document edit is an ordinary command (accept = one transaction, the
preference = `soundDesign.setSettings`); UI wired with menus, the Review keymap scope (keymap tests) and Window ▸ Review;
the Program monitor previews a proposal and every export path renders what is applied (ordinary clips, D-42); agents drive
all of it through MCP; tests are unit, property (state machine, fuzzed items) and fuzz (routes); ran in the real app
(below); no new assets or ported code.

#### Follow-ups closed

- **(a) `style.cueSources` in MCP.** `plan_sound_design` takes `style.cueSources` (the find_sound_cues sources, strict;
  `[]` and unknown names refused); README tool list and `SOUND_GUIDE` say so. `apps/mcp/test/proposals.test.ts`: a plan with
  `cueSources: ['markers']` plans only the marker's event (frame 250) with the same sound as the full plan.
- **(b) Stale reasons.** The model names what changed with timecodes and the cue's kind, never an id: "The cut cue at
  00:00:03:00 moved to 00:00:03:10", "The marker “Logo” at 00:00:04:00 moved to 00:00:05:00", "The clip “Shot B” at
  00:00:02:00 moved to another track", "The cut cue at 00:00:03:00 was deleted" (the kind of a deleted cue comes from the
  item's own `meta`), "Requires item sfx:003 (“Hit · cut”), which is stale". That English text is what agents read
  (`reason`); `revalidate` / `planAccept` also return it structured (`StaleItem.problem`: `anchor` with entity, change,
  frames, name, cue kind, sequence; `requires`; `conflict`), carried by the accept route's `stale[].problem` (API schema).
  The editor renders the structured problem with `t()` (`apps/web/src/proposals/stale-text.ts`: 36 strings, es.json),
  using the cue kind's own label; a stored reason without structure is translated when it matches a model template.
  Rows, their accessible names, the details pane, the ghost card, the announcer and the Apply toasts all use it.
- **(c) A large Review list; the preview's cost.**
  - *Virtualised list* (`panels/review/list-layout.ts`, pure): fixed row heights in rem (the UI scale: a 1.25 rem first
    line, 1.375 rem small-text lines, `py-0.5`, a 1 px border — 35.5 px at the editor's 12 px, +16.5 px for the folded
    setup line and per unfolded setup item; the row component draws the same heights), groups stacked with their headers, only the rows in view ± 480 px and the current row
    in the DOM, each group a WAI-ARIA group labelled "Support · 500", options with `aria-posinset` / `aria-setsize`, the
    group at the top pinned, the current row scrolled to by its computed place. `apps/web/test/review-virtual.test.tsx`
    (500 items): 36 of 500 options in the DOM, End → the last item current, rendered, named by `aria-activedescendant`
    and scrolled to; scrolling renders the middle rows; a decision there re-renders without rebuilding the preview.
    Measured (jsdom, the same 500-marker proposal, old vs new panel side by side, load 110–145): first render 39.2 /
    49.6 s → 2.1 / 3.4 s, a decision 27.3 / 37.5 s → 3.7 / 5.7 s (60 items: 6.1 / 10.8 s → 1.1 / 3.9 s).
  - *Preview recompute* — measured first (`packages/session/test/proposals-perf.test.ts`, `PROPOSALS_PERF_ITEMS=500`: 500
    place items + 526 setup items as the WP3.2 plan builds them, manual timers): **before**, at load ≈ 100, opening review
    62 397 ms of one main-thread task, after an edit 67 320 ms, after a local accept 62 416 ms, after a reject 567 293 ms.
    Far over the 50 ms bound: a 500-item review froze the editor for a minute per keystroke. Profile: 80 % in the
    per-item invariant check, which falls back to the full check for every item (a sound placement changes `media`,
    `items` and the sequence's `soundDesign`, outside what the incremental checker covers), the rest in the placement
    handler (O(document) per item).
  - What changed (`packages/session/src/proposals.ts`, `packages/project/src/proposals/ghost.ts`): items are previewed
    without the per-item invariant check (a small proposal's result is checked once, and only a failure re-runs it per
    item to find the culprit; a large one relies on the engine's check of the exact accepted set at Apply, which reports
    such an item stale — placements refuse overlaps themselves); the anchors' re-validation runs without dry runs (the
    preview applies every item anyway and flags the ones that fail) and is memoised per (document, proposal); the ghosts'
    preview and the heard one are memoised (a local accept or clear rebuilds nothing; a reject rebuilds only what Hear
    plays); `previewProposalSteps` (a generator) lets the session build a preview of more than 64 items in slices of
    8 ms, yielding between them — the previous preview stays shown, the Review panel says "Updating the preview…",
    and A/B on a large proposal starts the build instead of blocking. The proposal card's counts are built in slices
    too (`runInSlices`).
  - **After**, same test, same host: opening review 11 122 ms of work in 616 slices, after an edit 7 734 ms in 446, after a
    reject 9 426 ms in 461, after a local accept **74 ms, no rebuild** (load 77–93); longest single slices 209 / 213 / 114 ms
    (one item's placement plus a GC pause at that load). **Final run** (after merging WP4.2a, load 40–48, the same
    test): opening review 16.0 s of work in 734 slices — p50 16 ms, p95 52 ms, longest 107 ms; after an edit 13.4 s in 643
    (p50 15, p95 59, longest 106 ms); after a reject 12.5 s in 651 (p50 13, p95 44, longest 169 ms: the first slice, the
    anchors' re-validation of a new proposal object); after a local accept **43 ms, nothing rebuilt**. Before: one
    main-thread task of 62–567 s per recompute. The longest task the editor sees went from about a minute to ≤ 0.17 s;
    the total work is unchanged in kind (see Limits). The 120-item
    variant runs in the gate and checks the structure (sliced, equal to the one-shot preview, accept rebuilds nothing,
    reject reuses the ghosts' preview).
- **(d) Stored workspace layouts** (helper; `apps/web/src/shell/workspaces/migrations.ts`). No earlier panel addition had
  been migrated (the storage format was always version 1; Essential Graphics in Motion and the Sound Library in Audio
  never were): `WORKSPACES_VERSION` 1 → 2 wires the storage's existing `migrate` hook. Only the built-in Sound Design
  record changes (current and saved): Review is added as a background tab in the group that holds Markers (else History,
  Jobs, Sound Library, Media Browser, Project), before the first of Markers / History / Jobs — where Window ▸ Review would
  open it in an old layout; nothing split or resized, active tabs kept; layouts that already have a Review panel (any
  instance, docked or floating), `null` (factory) layouts and custom workspaces are left alone. Unknown versions still
  reset (`invalid` / `newer` / `corrupt`). `apps/web/test/workspace-migration.test.ts` (5, including a 300-run property;
  mutation: identity migration fails the first test). Real app: a stored v1 layout loads as v2 with Review in the left
  group (screenshot looked at).
- **(e) Ghost lanes and the vertical scroll** (helper). `computeLayout` takes `extraVideoPx` / `extraAudioPx`: during a review
  the ghost lanes of new tracks are part of each region's content (40 px per new audio track below the last audio row,
  pushing the Master row down; 32 px per new video track above the top one); tracks stay where they were, only the
  scroll range grows, and it shrinks back when the review ends (a stored scroll beyond it is clamped; the wheel starts
  from the clamped value). The current review item's row or lane is revealed vertically when it changes.
  `proposal-ghosts-model.test.ts` / `proposal-ghost-layer.test.tsx` (+4; mutations: `extraAudioPx: 0` and no wheel clamp
  each fail a test); real app with 6 + 7 tracks in a 221 px Timeline: the "A8 · SFX 1 (new)" lane scrolled into view,
  V7 "Titles (new)" likewise, gone after Exit (screenshots looked at). The Review tab badge reads "1 proposal / 1 item
  to review" in the singular.

#### Review findings and fixes (tests named; mutation-checked where stated)

1. **An applied item could be reopened and applied twice.** `reopen` reset accepted items to pending whatever the
   document held, and any token holder could call it: a stray reopen (another window, a script, an agent over HTTP)
   followed by Accept placed every sound again. Now an accepted item records the ids its transaction created
   (`applied.created`, ≤ 10 000) and `reopen` refuses while any of them is in the live document
   (`409 PROPOSAL_STILL_APPLIED`, pure `reopenRefusals`); `applied` (the Redo record) checks the document has them
   (`409 PROPOSAL_NOT_APPLIED`). Test: engine "reopen of an applied item…"; the state-machine property's `strayReopen`
   step (mutation: without the refusal the property fails with `[accept(trk), apply, strayReopen, accept(trk)]`).
2. **Reviewer actions open to agents.** An agent could reopen the user's rejections, overwrite their notes or swap the
   alternative they chose just before Apply. `reopen`, `note` and `select` are now editor-only (`403 APPROVAL_REQUIRED`,
   like `applied`); agents keep create, read, reject (withdraw), delete and the policy-gated accept. MCP never exposed
   them. Security review AGT-3 table updated.
3. **Undo / Redo follow-ups could reach the engine out of order**: an Undo and a quick Redo fired `reopen` and `applied`
   concurrently. They are now queued in History order per session (`settled()` for tests), and the benign answers of a
   race that resolved itself are not shown as errors. Test: "undo then redo before the engine answered…".
4. **An allowed agent's accept was not followed through Undo**: undoing it in the editor left the engine saying accepted
   while the document no longer had it. The session now learns every accept relayed into it from `proposal.changed`
   `accepted` (with its revision) and follows that History entry like its own. Test: "an allowed agent's accept…"
   (mutation: without it the property fails with `[agentAccept, undo]`).
5. **Expiry or eviction under an accept**: a proposal could expire (list) or be evicted (another create) between its
   accept's transaction and the write of its states. The store skips proposals whose lock is held (`inUse`); the lock
   holder still sees them expire. Test: "never expires or evicts a proposal an accept or decision is working on".
6. **Apply showed only clip removals**: an agent's proposal could carry destructive commands (`track.remove`), `force`,
   or `soundDesign.setSettings {agentsMayApply: true}` inside a harmless label; the editor's accept is the user's edit, so
   none of it asked. Apply's confirmation now also names what an agent could not run unasked (`approvalNeeds`: the
   approval rule over the accept closure's chosen commands). Tests: review-model `approvalNeeds`, review-ui "names what an
   agent could not do without asking…" (cancel applies nothing, the setting stays off).
7. **Failed-preview flags flickered**: a local decision republished the items without the preview's failures (stale for
   150 ms → pending → stale). They are kept until the next preview (no dedicated test).
8. Smaller: the Review panel's "Open a project…" line was not translated; its timecodes ignored drop-frame and the start
   timecode (now the sequence's `seqTimecode`).
9. Found by looking at the first e2e screenshots of this pass's own virtualised list: rows were laid out at fixed px
   heights while their lines are rem-based (`h-5` is 15 px at the editor's 12 px root), so a scrolled list showed blank
   bands where a row's lower part should be. The metrics are now rem-based (`reviewListMetrics(rootFontPx)`) and the
   row draws exactly those heights (checked in the browser: row children 15 / 17 / 17 px, no gap; e2e screenshots).
10. **A row's gain and why-line could be a setup item's** (reported by WP4.2b): the Review model took an item's gain from
   the first ghost clip shown under it, and a setup item's ghosts are folded under the first item that needs it — with
   the delivery preset that is the music clip it re-levels (a row read +14.6 dB). WP4.2b made the row text prefer the
   plan's solved gain, which a selected alternative cannot use. Root fix: ghost clips and removals carry the item whose
   own commands made them (`sourceItemId`); an item's gain is the first clip its own chosen set creates (else changes),
   its facts list only its own clips, and its why-line / short reason come from the selected alternative's `meta` when
   one is chosen (`ReviewItem.selectedMeta`). Test: review-model "the delivery setup re-levels the music…" (+14.6 dB
   music under the item → row −11 dB, facts without it; alternative → −7 dB and its own why-line; mutation: the old
   first-ghost rule fails it).

Checked and found sound (no change): the policy gate (engine `soundDesignPolicy` reads the live document; an agent's
`soundDesign.setSettings {agentsMayApply: true}` needs the approval card; the Preferences checkbox clicked through an
agent's live-UI input is refused by the session's `agentUiTxGuard` — new test; `proposals.apply` refuses agent input and
untrusted clicks; `x-jasper-agent-input` never counts as the editor; only the editor names a proposal's author);
accept's atomicity under its per-proposal lock (one transaction; states written after it; concurrent accepts apply
once — WP3.1 tests); the waiting heuristic (agent reads without `revalidate` only; bounded; forgotten on delete);
tokens, layers and the Review keymap scope (lint, keymap tests).

#### State machine (property test)

`packages/session/test/proposals-state-machine.test.ts`: the real session and the fake engine (the pure model behind every
route, with the engine's guards), a 6-item proposal (a track, a mute requiring it, four markers with alternatives); 60
random sequences of ≤ 24 steps from accept / reject / clear / select alternative / Apply / Undo / Redo / an unrelated
edit / a stray reopen / an allowed agent's accept; after each step (follow-ups settled) for every item: stored
`accepted` ⇔ what it adds is in the document, never twice, and the Review shows "applied" exactly for those. Plus two
directed tests (undo + redo before the engine answers, in both orders; an agent's accept undone and redone).

#### Verified (measured, this branch)

- **Targeted suites** (after the last change; `--maxWorkers=2`, long `--testTimeout` because of the load):
  `pnpm vitest run packages/project/test/proposals.test.ts packages/session/test/proposals.test.ts
  packages/session/test/proposals-state-machine.test.ts apps/engine/test/proposals.test.ts` → 4 files, 50 passed;
  `apps/engine/test/{proposals,proposals-store,sound-design-plan}.test.ts apps/web/test/{review-ui,review-model}.test.*`
  → 5 files, 57 passed; `apps/web/test/{review-virtual,review-ui}.test.tsx` → 2 files, 16 passed;
  `apps/web/test/{review-stale-text,review-model,proposal-ghosts-model,proposal-ghost-layer,proposal-program,auto-sound-pass}`
  → 41 passed; `packages/session/test/proposals-perf.test.ts` (N = 120) passed; `apps/mcp/test/proposals.test.ts`
  (`MCP_PROPOSALS_TEST_PORT=50611`) → 5 passed (with the `cueSources` case); the helper's 14 web files → 123 passed.
  Mutation checks: the reopen refusal off in the fake engine → the state-machine property fails
  (`[accept(trk), apply, strayReopen, accept(trk)]`); `learnAccept` off → it fails (`[agentAccept, undo]`) and so does
  the directed agent test.
- **Real app, built stack** (`E2E_PORT=50605 E2E_SKIP_BUILD=1 pnpm exec playwright test -c <config with a 600 s web-server
  start-up> …`; the stock 60 s start-up timed out twice at load ≈ 80–100, nothing else changed):
  - `e2e/sound-p3-mcp.spec.ts` (new) **passed** (10.4 min, load 76–99): jasper-mcp `plan_sound_design {style: {seed: 7,
    cueSources: ['markers']}}` → items at 90 / 180 / 250 (the marker) / 300, nothing applied; the card "e2e-p3-agent
    proposes Sound design: Sequence 01: 5 sounds on 2 new tracks" with "… is waiting for your review" while
    `wait_for_proposal` polls; the user rejects the marker's item → that wait returns `changed` with it; accepts two, an
    alternate on one, a note on the other, Ctrl+Enter → one History entry, "Applied 2 of 4 sounds from e2e-p3-agent";
    `wait_for_proposal {since}` → accepted / accepted / rejected / pending, `swapped.alternative` 1, the note;
    `accept_proposal "all"` → `E_APPROVAL_REQUIRED` (the hint names the Review panel and the preference), nothing
    applied; Preferences ▸ Sound Library ▸ Proposals ticked by a real click → History "Allow Agents to Apply Sound
    Proposals"; `accept_proposal "all"` → the remaining item applied (the rejection stands), History "Agent: Accept Sound
    design: Sequence 01 (1 of 18)"; `wait_for_proposal {until: 'decided'}` → `applied`; `start_export {wait: true}` →
    every placed sound located by cross-correlation with its media: **0 / 0 / 0 samples** from where the document puts it
    and from the cue frame (r 1.000 / 0.978 / 1.000). Screenshots looked at (`test-results/e2e-sound-p3-mcp/`: card,
    review with the A4 / A5 ghost lanes, decided, applied, the preference, the agent's apply).
  - `e2e/sound-review.spec.ts` **2 passed** (3.0 + 3.1 min): the stale row reads "Cut cue at 00;00;03;00 moved to
    00;00;03;10" (drop-frame sequence); Auto Sound Pass export peaks 0 / 0 / +1 samples (r ≥ 0.991). Screenshots looked
    at (card, review, decided, applied, reopened — decisions intact after Ctrl+Z and Reopen review, stale).
  - `e2e/sound-fill.spec.ts` **passed** (5.7 min; export peaks 0 / 0 / −1 samples), `e2e/sound-p2-done.spec.ts` **passed**
    (23.6 min).
  - First runs failed on the host, not the feature: sound-fill clicked a clip the timeline had scrolled out of view (the
    In Context audition's playback page-scrolls the timeline and leaves it there while the playhead returns) and then
    waited for one outside the rendered window — the spec now fits the sequence and never waits for an unrendered clip;
    sound-p2-done lost a kept-alive socket while polling its export job (`ECONNRESET`) — the shared `waitForJob` retries
    that up to 5 times; sound-review's Apply toast (15 s) expired during the undo at load 145 — the spec rests the pointer
    on it (hover pauses toasts, as for a user); the stale text expected colons (the sequence is drop-frame).
- `e2e/sound-proposal-ghosts.spec.ts` **passed** (3.6 min, load 36–47; at load 105–117 earlier it could not measure:
  "every one of 8 plays was disturbed by the host"): Hear on → the cut's hit at sample **146 539** (exact, as in WP3.3a),
  switched on while playing on the first attempt, Hear off and switched off after retries of plays Remotion re-scheduled
  (the WP3.3a limit); Apply = one entry, Ctrl+Z → back in review with ✓ / ✕ intact (screenshots looked at: ghosts,
  decided, high contrast, reduced motion, applied, undone).
- **Gate**: after merging `feat/sound-design` (WP4.2a: b1ccef8e; conflicts in README, gaps, es.json kept both sides) —
  `pnpm lint` pass, `pnpm typecheck` pass, `pnpm build` pass, `pnpm notices --check` current (150 packages, 31 ported
  records), `node scripts/i18n.mjs --check` 9 417 strings. `pnpm test`, run per project because one `pnpm verify` outlived
  the host's 2-hour limit at load ≈ 140 (its lint and typecheck had passed): packages 312 of 319 files (3 486 tests),
  engine 74 of 115, web / mcp / desktop / scripts 182 of 191 at load 80–140, every failure a timeout, a time budget or
  a realtime playback; rerun with fewer workers: the 16 non-engine files → 15 pass, left `packages/audio-fx`
  masking "solves 2000 events in under 50 ms" (min 73 ms at load 38–58: Phase 4's budget, also failing in this
  morning's baseline); the 41 engine files → 29 pass at 3 workers, then 6 of the 8 light ones one at a time (left:
  `gaps-avc3-playback`, Chrome saw 41 / 33 of ≥ 45 frames in realtime, and `browse`, a 5 s timeout — both in the
  baseline too), then the 4 heavy ones (2 workers, load 46–64): `export`, `camtrack-job`, `processing-steps` pass, `camtrack-solve` keeps 3 of 12 failing on its 600 s solve timeouts (baseline too). One Phase 3 test was the host's and is fixed: the Auto Sound Pass cancel test raced its
  fake job (it now runs until cancelled). The baseline run of `pnpm verify` on d932e86a this morning (load 36–100) had
  21 failing files of the same kinds and no Phase 3 file among them. Then merged WP4.2b (6ab79253; conflicts in `ReviewPanel.tsx` — its own-gain row text kept with the
  virtualised rows and readable stale text —, en.json, gaps) and fixed finding 10: `pnpm lint` pass, `pnpm typecheck` pass,
  the review / ghost / mix-model / session suites (12 files, 84 tests) pass. After the WP4.2a merge, on the fresh build (load 54–62): `e2e/sound-p3-mcp.spec.ts` and
  `e2e/sound-review.spec.ts` (2) → **3 passed** (10.1 min); MCP session peaks 0 / −1 / 0 samples (r ≥ 0.968), Auto Sound
  Pass peaks 0 / 0 / −1.

#### Limits (after this pass)

- **Large proposals.** The placement handler is O(document) per item, so a 1 000-item proposal (500 places) is 13–16 s of
  sliced work before its ghosts appear (load 40–48, after the WP4.2a merge; 8–11 s before it at load 77–93); the previous
  preview stays and the panel says "Updating the preview…"; with the host saturated by other builds it took minutes. A slice holds one item at least: on a
  loaded host one item's placement plus a GC pause made single slices of 100–200 ms (p95 44–59 ms, longest 107–169 ms at load 40–48 in the final run). Not moved to a worker:
  the preview document feeds the Program monitor, which keeps unchanged clips' render objects by identity
  (`stabilizeRenderDoc`), and a cloned document would lose that.
- An invariant conflict among the items of a proposal of more than 64 items shows at Apply (reported stale, never
  dropped), not before.
- An engine crash (or a lost relay answer) between an accept's transaction and the write of its states leaves the items
  pending although applied; the window is one atomic file write and is not journalled.
- An allowed agent's accept made headless and undone headless (no editor open) stays recorded as accepted.
- After an In Context audition the timeline stays scrolled where playback took it while the playhead returns (Phase 2
  behaviour, seen through `sound-fill`; not changed here).
- A Sound Design layout saved by a WP3.3b-era build in which the user closed Review gets Review back once.
- The rest of WP3.1–WP3.3b's limits stand (waiting is inferred from polling; `'all'` never includes invalid / rejected
  items; an item whose commands name no entity goes stale only when it stops applying).

## Phase 4: mixing

### Phase 4 → WP4.1a masking solver

Scope: `packages/audio-fx` only (pure; imports `@jasper/audio-dsp` only). Spec 12 §2.4 "Masking solver", P4-R1.

Files: `src/analysis/bands.ts` (octave bands and local loudness, shared with the descriptors), `src/analysis/masking.ts`
(`solveSfxGains`); `src/analysis/sound-descriptors.ts` now takes its Welch spectrum and octave integration from
`bands.ts` (same code moved, no behaviour change: the descriptor, synth and ffmpeg-oracle tests pass unchanged); tests
`test/bands.test.ts`, `test/masking.test.ts`, `test/masking-oracle.test.ts`; `test/util.ts` gained `powerLawNoise`.
Everything is exported from `@jasper/audio-fx`.

#### API (for the engine bed render, `soundDesign.applyGains`, `rebalance_sfx`, the plan job)

```ts
// bands.ts
const OCTAVE_BAND_CENTRES_HZ: readonly number[];   // [125, 250, 500, 1000, 2000, 4000, 8000] (moved here; same values)
const BAND_FLOOR_DB = -120, MAX_BAND_FRAMES = 1500, MOMENTARY_WINDOW_SEC = 0.4, LOCAL_PEAK_HOP_SEC = 0.01;
const BED_PEAK_MARGIN_SEC: { hero: 1, support: 0.15, ambient: 0.15 };
type TimeWindow = { start: number; end: number };                       // seconds
function bandLevels(channels: Float32Array[], sampleRate: number, window: TimeWindow): number[];   // 7 levels, dB
function shortTermPeakLu(channels: Float32Array[], sampleRate: number, window: TimeWindow, marginSec = 0): number;
function bedLocalPeakLu(channels: Float32Array[], sampleRate: number, window: TimeWindow,
  weight: 'hero' | 'support' | 'ambient'): number;          // shortTermPeakLu with the weight's margin
function sumBandsDb(levels: readonly number[]): number;     // 10·log10 Σ 10^(L/10)
// also exported for the descriptors: fftLength, FramePower, welchPower, octaveBandsFromPower

// masking.ts
type SolverWeight = 'hero' | 'support' | 'ambient';
interface SolverEvent {
  clipId: string; soundId: string; type: string; weight: SolverWeight;
  startSec: number; endSec: number;          // the sound's active window on the timeline
  soundBandsDb: number[];                    // bandLevels of the sound at 0 dB clip gain over its window
  soundPeakLu: number | null;                // its loudest momentary loudness at 0 dB (shortTermPeakLu or maxMomentaryLufs)
  truePeakDb: number | null;                 // its true peak at 0 dB (descriptor truePeakDb)
  bedBandsDb: number[];                      // bandLevels of the bed over the same window (−Infinity = silence)
  bedLocalPeakLu: number | null;             // bedLocalPeakLu(bed, sr, window, weight); null / −Infinity = silence
  speechOverlap: boolean;
  baseGainDb: number;                        // its current / default level (sfx.level.gainDb)
  userOffsetDb?: number;                     // e.g. the fill's ±1 dB variation (gainOffsetDb)
}
interface SolverOptions { truePeakCeilingDb?: number /* −1 */; programLufs?: number /* −14: the delivery target */ }
function solveSfxGains(events: SolverEvent[], opts?: SolverOptions): SolverResult;   // never throws
interface SolverResult {
  gains: Record<string, number>;             // clipId → gain dB (0.01 dB steps); duplicates: the last wins
  events: SolverEventResult[];               // input order
  warnings: { code: SolverWarningCode; clipId?: string; message: string }[];
}
interface SolverEventResult {
  clipId: string; gainDb: number; targetLiftDb: number;
  achievedLiftDb: number | null;             // null for a silent sound
  dominantBands: number[];                   // centres in Hz, strongest first
  limitedBy: SolverLimit[];                  // see below; empty = target reached (or the base level already exceeds it)
  reason: string;                            // "−11 dB, limited by dialogue", "−10.5 dB, target lift +5 dB reached", …
  peakOverBedLu: number | null; truePeakDb: number | null;   // at the solved gain
  speechBandLiftDb: number | null;           // max lift in 1/2/4 kHz at the solved gain, only with speechOverlap
}
type SolverLimit = 'clamp' | 'bed-cap' | 'hero-shadow' | 'consistency' | 'dialogue' | 'headroom'
  | 'user-offset' | 'silent-sound' | `conflict:${kept}/${lost}`;
type SolverWarningCode = 'W_INVALID_INPUT' | 'W_SANITISED' | 'W_DUPLICATE_CLIP' | 'W_SILENT_SOUND' | 'W_UNMEASURED'
  | 'W_CONFLICT' | 'W_DIALOGUE_BAND' | 'W_UNRESOLVED';
// constants: TARGET_LIFT_DB, SOLVER_GAIN_MIN_DB/MAX_DB, BED_CAP_LU, QUIET_BED_OFFSET_LU, DEFAULT_PROGRAM_LUFS,
// HERO_SHADOW_SEC, HERO_SHADOW_FACTOR, HERO_SHADOW_DB, CONSISTENCY_DB, DIALOGUE_LIFT_DB, DIALOGUE_BANDS_HZ,
// DEFAULT_TRUE_PEAK_CEILING_DB, DOMINANT_SHARE, SOLVER_STEP_DB, SOLVER_CONSTRAINTS, SOLVER_WEIGHTS
```

How the engine package (P4-R2) should feed it: render the bed (non-SFX tracks) per cue cluster; for each placed clip
`window = [clip start + headQuiet, clip start + active length]`; `soundBandsDb = bandLevels(sound decoded at 0 dB,
sr, {0, len})`, `bedBandsDb = bandLevels(bed, sr, window)` — **the same window length for both**, see limits;
`bedLocalPeakLu = bedLocalPeakLu(bed, sr, window, weight)`; `soundPeakLu` / `truePeakDb` from the descriptors (or
`shortTermPeakLu` for consistency with the bed). Role mapping is the caller's: hero → hero, support and layer →
support, ambience / room tone → ambient (decision for P4-R2 to confirm).

#### Algorithm

1. **Target.** Dominant bands D = the strongest octave band of the sound, plus the second strongest when it carries
   ≥ 10 % of the sound's band energy. Lift = level(sound in D) + gain − level(bed in D), levels as energy sums over D.
   Needed gain = bed(D) + target − sound(D); the starting gain is **max(base, needed) + userOffset** — the solver
   raises a masked sound and never lowers an unmasked one under its default level except for a constraint (a silent
   bed would otherwise ask for −100 dB). A silent sound (no band over the floor) keeps its base (`silent-sound`).
2. **Constraints, in this order.** Each of 1, 2, 3, 5, 6 narrows a per-event interval [lo, hi] and moves the gain into
   it; a bound that does not meet the interval left by the earlier steps loses: the earlier constraint is kept and
   `conflict:<earlier>/<later>` reported (W_CONFLICT).
   1. clamp [−30, +12] dB;
   2. bed cap: soundPeak + gain − ref ≤ +10 LU (hero) / +6 LU (support, ambient), ref = max(bedLocalPeak,
      programLufs − 12); no cap (W_UNMEASURED) without a peak loudness;
   3. hero shadow: a support whose window is within 0.15 s of a hero's window (gap ≤ 0.15 s, overlap included):
      bound = its gain − 4.437 dB (× 0.6);
   4. consistency: disjoint repeat groups (same soundId when it occurs ≥ 2 times; else same type and weight); every
      member within median ± 2 dB. Consistency is a relation, not a bound: the median is taken over the members
      that can reach the window (a member held under median − 2 by steps 1–3 leaves the median — it is raised to
      its steps 1–3 cap and reports `conflict:<cap>/consistency`), the others are clamped into the window;
   5. dialogue guard (speechOverlap): gain ≤ 1 + min over the 1, 2, 4 kHz bands of (bed − sound), i.e. the lift in
      each speech band ≤ +1 dB; when the sound's dominant band is in 1–4 kHz, W_DIALOGUE_BAND advises a type whose
      dominant band is outside 1–4 kHz and names those present in the input ("here: boom");
   6. headroom: truePeak + gain ≤ ceiling (default −1 dBTP); without a measured true peak the gain is ≤ 0 (never
      boosts, as the default level).
3. **Re-verify.** After step 6 each group is settled again around its current median (steps 5–6 only lower gains:
   a group lowered together stays consistent; a member above median + 2 comes down; one under median − 2 goes back
   up, over a step 5/6 bound only as `conflict:consistency/dialogue|headroom`, since consistency is earlier).
   Clamping into a window centred on the median keeps the median, so one settle suffices. Then every constraint is
   checked on the final gain (rounded to 0.01 dB): clamp, bed cap, shadow bound, |g − final median| ≤ 2 for group
   members, speech lift, headroom. A violation not named by a reported conflict is W_UNRESOLVED; the tests (and
   15 500 fast-check cases in a stress run) never see one.

Bug in the inspiration tool, avoided by construction: there, step 4 (repeat consistency) pulled a repeat over its bed
cap. Here step 4 cannot leave the steps 1–3 interval; the test "step 4 would break step 2" pins it.

#### Constants: sources and decisions

| Constant | Value | Source / reasoning |
|---|---|---|
| Target lift | hero +5, support +3.5, ambient +2 dB | spec 12 §2.4. A sound inside a critical band of noise is masked until it comes within a few dB of the noise level (Zwicker & Fastl, *Psychoacoustics: Facts and Models*, ch. 4, masking by noise); an octave spans several critical bands, so a positive lift over the whole octave leaves margin over the masked threshold |
| Dominant share | ≥ 10 % | task / spec; with 7 bands the strongest always has ≥ 1/7 |
| Clamp | −30 … +12 dB | spec 12 §2.4; the same range as the default insert level (`level.ts`) |
| Bed cap | +6 LU support, +10 LU hero; ambient = support | spec 12 gives support and hero; ambient is not named — an ambience is quieter by role, so it gets the tighter cap (decision) |
| Local bed peak | max BS.1770-4 momentary (400 ms) loudness with window centres in [start − m, end + m], 10 ms hop; m = 1 s hero, 0.15 s otherwise | ITU-R BS.1770-4 (K-weighting, channel weights) and EBU Tech 3341 (momentary = 400 ms); margins from the task; the 10 ms hop (vs the meter's 100 ms) so a short event's neighbourhood is sampled finely (decision) |
| Quiet-bed reference | programme − 12 LU | decision: with a silent bed the cap would mute the sound. At −12 LU the hero cap is programme − 2 LU = the default hero level (Phase 2 verification B), support programme − 6 LU just over its default − 8 LU |
| Hero shadow | gap ≤ 0.15 s, × 0.6 (−4.44 dB) | spec; "within 0.15 s" measured between the windows (a long support overlapping a hero is shadowed too; decision) |
| Consistency | median ± 2 dB; disjoint groups | spec gives ±2 dB and "same soundId, then same type". Disjoint groups (soundId when it repeats, else type + weight) avoid chains between overlapping groups; weight in the type key so a hero hit is not pulled to support hits (decision) |
| Dialogue | 1, 2, 4 kHz octaves (707 Hz … 5.66 kHz), lift ≤ +1 dB | spec; the region carrying most speech intelligibility (ANSI S3.5-1997 Speech Intelligibility Index band-importance functions peak around 1.5–3 kHz) |
| Headroom | −1 dBTP per event, pre-master | spec 12 delivery presets (−1 dBTP web / podcast / R128), EBU R 128 max true peak −1 dBTP; true peak per BS.1770-4 annex 2 (the descriptors' meter) |
| Rounding | 0.01 dB | decision (finer than the default level's 0.1 dB so bounds are met to ≤ 0.005 dB) |

#### Verified (measured, this branch; shared host, 16 cores, load average 16–58)

- `pnpm vitest run packages/audio-fx/test/bands.test.ts packages/audio-fx/test/masking.test.ts packages/audio-fx/test/masking-oracle.test.ts --maxWorkers=2`:
  10 + 27 + 1 passed. bands: equals the descriptors' `octaveBandsDb` within 0.01 dB over a fully active sound; a
  full-scale 1 kHz sine reads −3.01 ± 0.1 in its band; window restriction; pink noise flat within 0.5 dB;
  `shortTermPeakLu` = `LoudnessMeter.maxMomentary` within 0.05 LU on a −20 dBFS stereo sine (−20 LUFS); hero vs
  support margins; degenerate input → floor / −∞; fast-check (150 runs each) never throws, always finite.
  Solver: each weight's target, second dominant band at 36 % and not at 9.9 %, base floor, silent bed, user offset,
  silent sound, empty input; each constraint alone (clamp both ends; bed cap for the three weights, unmeasured peak,
  programme reference; hero shadow at gaps 0.1 / 0.15 / 0.16 s, before, overlapping, not ambient, not the hero;
  consistency by sound then type + weight, hero not grouped with supports; dialogue guard bound −11 dB with the
  advice naming `boom`; headroom −1 / custom ceiling / unmeasured → 0 dB); order: step 4 vs step 2
  (`conflict:bed-cap/consistency`, the cap holds), step 4 vs step 3, step 5 vs clamp, step 6 vs step 4; properties:
  caps hold or a conflict names the loser and nothing is unresolved (400 runs), monotone in the bed under a uniform
  bed raise with caps still holding (300), a lone event follows the bed dB for dB until a cap (+9 dB headroom),
  deterministic and independent of the input order (150); NaN / ±Infinity / wrong lengths / bad types sanitised
  with W_SANITISED, a hostile fast-check (300 runs) never throws and keeps gains finite in range; duplicate ids;
  **2000 events: min 7.1–11.2 ms, median 10.2–19.2 ms over 9 runs** (the test asserts the minimum < 50 ms: on this
  loaded host the median measures the load — an earlier version took a median of 196 ms before the allocation cuts).
- Stress (temporary copy with 6000 / 4000 / 1500 / 4000 runs of the property and hostile tests): 5 passed.
- **Oracle-ish integration** (`masking-oracle.test.ts`): an 8 s stereo bed (pink noise ≈ −30 dBFS RMS + a 1.5 kHz
  tone with a 4 Hz syllable envelope from 4 s, the "speech"), six Jasper Synth sounds (hit hero, whoosh support
  0.1 s before it, boom, two repeats of one click in the speech, chime ambient). Measured with `bandLevels` /
  `shortTermPeakLu` / `LoudnessMeter`, solved (programme −14, ceiling −1), mixed sample by sample at the solved gains
  and measured again. Lift (dB over the bed in the dominant bands; report / measured from mix energy − bed energy /
  exact from mix − bed):

| event | bands | gain | report | mix | exact | reason |
|---|---|---|---|---|---|---|
| hit (hero) | 125+250 | −10.46 | 5.00 | 5.07 | 5.00 | target reached |
| whoosh | 2k+4k | −21.22 | −0.94 | −0.91 | −0.94 | limited by hero-shadow |
| boom | 125 | −11.08 | 3.50 | 3.67 | 3.50 | target reached |
| click1 | 4k+2k | −19.09 | −3.64 | −3.43 | −3.64 | limited by dialogue |
| click2 | 4k+2k | −18.80 | −3.68 | −4.08 | −3.68 | limited by dialogue |
| chime (ambient) | 1k+2k | −22.83 | −11.54 | −11.44 | −11.54 | limited by dialogue |

  Asserted: the exact lift within 0.5 dB of the report for every event, the mix-energy estimate within 0.5 dB for
  lifts ≥ −3 dB (below that the bed/sound cross term dominates the energy difference); measured in this run, all six
  mix estimates are within 0.40 dB (worst click2, a 0.1 s window). True peak, peak over the bed and the speech-band
  lift are checked on the rendered, gained audio. This run found a design bug,
  fixed: with the consistency window fixed at step 4, the two clicks (both lowered by the dialogue guard) were
  pushed back over it as a "conflict"; consistency is now settled around the group's median after steps 5–6.
- `pnpm vitest run packages/audio-fx --maxWorkers=2`: 21 files, 332 passed; `JASPER_REQUIRE_ORACLES=1 pnpm vitest
  run packages/audio-fx/test/sound-oracle.test.ts`: 5 passed (descriptors vs ffmpeg after the spectrum moved to
  `bands.ts`). `pnpm --filter @jasper/audio-fx typecheck`, Biome and `check-layers` pass.

#### Limits and notes for the next packages

- **Each event is solved against the bed only.** SFX do not mask each other in the model, and the headroom ceiling is
  per event: overlapping events can sum over it (the master limiter / Sound Check's TP check catch that). The bed
  must not contain the SFX being solved.
- **Consistency beats the dialogue guard and headroom** (spec order): a repeat in speech whose group is mostly
  outside speech is raised back to median − 2 dB and reports `conflict:consistency/dialogue`; the reason text says
  so. The plan UI should surface these (or the user moves the cue).
- Repeat groups are disjoint: two repeats of sound A are not compared to a single B of the same type.
- `bandLevels` keeps the descriptors' Welch normalisation (frames centred from the window start to its end, signal
  outside = silence), which reads low on short windows — **measured** on a 1 kHz sine: −2.27 dB at 0.05 s, −1.13 at
  0.1 s, −0.68 at 0.2 s, −0.28 at 0.5 s, −0.11 at 1 s, −0.03 at 4 s. It cancels in the lift only when the sound and
  the bed are measured over windows of the same length (as above); do not mix descriptor `octaveBandsDb` (active span)
  with a bed window of another length.
- Monotonicity in the bed is property-tested for a uniform raise of every event's bed; for a single event inside a
  repeat group it holds through the median but is not separately property-tested.
- Gains are rounded to 0.01 dB; a bound can be missed by ≤ 0.005 dB when the allowed interval holds no 0.01 dB step.
- The Sound Check package can reuse `shortTermPeakLu` / `bandLevels` for "masked hit" detection with the same
  definitions.

### Phase 4 → WP4.1b bed render, applyGains, rebalance

Scope: spec 12 §2.4 (bed render, solver integration), §2.9 (`soundDesign.applyGains`), §2.10 (`rebalance_sfx`), P4-R2.
Files: `apps/engine/src/sound-design/bed.ts` (bed and sound measurements, caches), `levels.ts` (solver inputs, why-lines),
`rebalance.ts` (job), `plan-levels.ts` (plan integration), `plan.ts` (calls it), `routes/sound-design.ts` (route, one
`sound-design` runner for both jobs), `export/planner.ts` (`localHandle` exported); `packages/project/src/sound/sfx-clip.ts`
(`isSfxClip`, `sfxSolverWeight`), `sound/level.ts` (`DELIVERY_TRUE_PEAK_DBTP`, `sfxGainOwner`), `schema/sound.ts`
(solver level), `commands/schemas|handlers/sound.ts`, `catalog.ts`, `sound/messages.ts`; `packages/api/src/sound-design.ts`
(`SfxRebalance*`, `SfxSolvedLevel`, plan event `level` / `layerLevels` / `alternativeLevels`, report `conflicts` /
`levels`), `routes.ts` (`soundDesignRebalance`); `packages/engine-client` (`rebalanceSfx`); `apps/mcp/src/tools/sound-design.ts`
(`rebalance_sfx`, plan table "gain" column), `tools/sound.ts` (SOUND_GUIDE "Balance against the bed"), `examples.ts`;
i18n (label, six refusal templates); README (345 tools, HTTP section), security review (AGT-3 row, route paragraph), gaps.
Tests: `packages/project/test/sound-apply-gains.test.ts`, `fuzz.test.ts` (applyGains in AC-25),
`apps/engine/test/sound-design-bed.test.ts`, `sound-design-rebalance.test.ts`, `sound-design-plan-levels.test.ts`,
`sound-bed-fixture.ts` (generated music / speech / hit / click), `apps/mcp/test/sound-rebalance.test.ts`; updated
`sound-design-plan.test.ts` (placements take the solver's level), `apps/mcp/test/proposals.test.ts` (table column),
`sound-examples.test.ts`, `sound-level.test.ts` (type narrowing).

#### Definitions (decisions)

- **SFX clip** (`isSfxClip`): an audio clip of the sequence whose Essential Sound type is `sfx`, or that has no Essential
  Sound type and carries readable `sfx` metadata. Typed dialogue / music / ambience is bed even with `sfx` metadata
  (Detect Peak gives project audio a peak). Clips inside nested sequences play as part of the nest: bed.
- **Bed**: everything else the mix plays, rendered by the export mixer (`renderMixdown`, master output, `measureOnly`, the
  Mix's loudness normalisation left out, `onlyClips` = the non-SFX clips under the cluster) — so mute / solo, faders,
  inserts, sends and the master are as in the export. Spec 12 says `onlyTracks: non-SFX`; clips are used instead because
  SFX and bed may share a track (an Essential-SFX clip on a dialogue track).
- **Cue clusters**: each measured sound's active window widened by its local-peak margin (±1 s hero, ±0.15 s support /
  ambient, WP4.1a `BED_PEAK_MARGIN_SEC`), 0.7 s before (0.5 s K-weighting warm-up + half the 400 ms momentary window)
  and 0.2 s after; overlapping spans merged. Only clusters are rendered (a cluster with no bed clip is silence, no render).
- **Sound alone**: the same mixer over the clip's span + 0.5 s with only that clip audible and its snapshot clip gain set
  to 0 dB (In point, speed, channels, clip effects, volume keyframes, fades, pan, its track strip, sends, master: as in
  the mix). **Active window**: first to last 10 ms frame within 30 dB of its loudest (≥ 50 ms, ≤ 20 s; a silent sound uses
  its clip span). Sound and bed bands, the sound's peak loudness (`shortTermPeakLu`) and the bed's local peak
  (`bedLocalPeakLu`) are all measured over that same window, as WP4.1a requires; the true peak is the solo render's
  (BS.1770 meter of the mixdown).
- **Speech**: transcript words (`sequenceWords`) plus voice activity of Essential Sound dialogue clips without a transcript,
  rendered alone over the cluster: 10 ms frames ≥ max(`vadThreshold` of the speech module, −50 dBFS). An event overlaps
  speech when a word or voiced frame falls in its window; the tracks are named in the why-line.
- **Roles → solver weights**: a sound typed ambience / room tone → `ambient` (whatever its role); hero → `hero`; support
  and layer → `support` (confirming WP4.1a's proposal). Layers of a hero cue are therefore shadowed by their hero (× 0.6).
- **Base gain and offset**: base = the sound's default insert level for its role at the delivery (`defaultSfxLevel`), or for
  media without provenance its current gain less its offset; user offset = `sfx.level.offsetDb` (the fill's ±1 dB). So
  solving again gives the same gains (idempotent) and a solved gain never sits under the default without a constraint.
- **Gain ownership** (`sfxGainOwner`): `default` / `solver` while the clip gain equals `sfx.level.gainDb` (±0.005 dB),
  else `user`. Rebalance replaces default and solver gains, keeps user gains (`USER_GAIN`) unless `userGains: 'replace'` or
  the clip is named. A swap or a role change returns an untouched solver gain to the new default (the solve belonged to
  the old sound / role).
- **Delivery**: programme loudness and true-peak ceiling from the sequence's delivery (or the request's): web −14 / −1,
  podcast −16 / −1, R128 −23 / −1, A/85 −24 / −2 (spec 12 §2.4).
- **Caches** (per engine): bed PCM by `mixFingerprint` of the document without its SFX clips + cluster frames (≤ 96 MB,
  LRU); sound measurements by the clip at 0 dB + mixer topology hash + media fingerprint + span (≤ 4 000). A gain change
  re-renders nothing (test).

#### API

- Command `soundDesign.applyGains {sequenceId?, gains: Record<clipId | $ref, −30…+12 dB> (1–2 000), report?:
  Record<same keys, {targetLiftDb?, achievedLiftDb?, limitedBy?[≤16], reason?}>}` ("Rebalance SFX Levels"). Keys may be
  `$refs` bound earlier in the transaction (the plan's `$sfx_<n>_<layer>` placement refs; resolved by the handler since
  record keys are not id contexts). Records `sfx.level = {by: 'solver', gainDb, offsetDb (kept), targetLiftDb,
  achievedLiftDb, limitedBy, reason}`; an Essential-SFX clip without `sfx` only gets the gain. Result `{clips: [{clipId,
  fromDb, gainDb}]}`. Refusals: unknown clip / ref / sequence `E_NOT_FOUND`; not audio, not a sound effect, report key
  without a gain, a clip twice `E_INVALID_PARAM`; locked track `E_TRACK_LOCKED`; out of range, empty, malformed keys
  `E_SCHEMA`. **Deviation:** the task wrote `sfx.level.source: 'solver'`; the stored discriminator stays `by` (Phase 2 B's
  field), so one reader handles both levels. No schema bump: `level` is optional loose metadata (an older build drops an
  unreadable level and keeps the gain, as Phase 2 B).
- `POST /api/sound-design/rebalance {projectId, sequenceId?, clipIds?, range?, delivery?, mode?: 'propose' (default) |
  'apply', userGains?: 'keep' | 'replace', label?}` → 202 job `sound-design` ("Rebalance SFX levels"); typed refusals before
  the job: 400 `VALIDATION_FAILED`, 404 `PROJECT_NOT_FOUND` / `SEQUENCE_NOT_FOUND` / `CLIP_NOT_FOUND`, 400 `NOT_SFX`.
  Result `SfxRebalanceResult {projectId, sequenceId, mode, applied, revision, proposalId, report: {events[{clipId, itemId,
  title, soundId, track, frame, timecode, role, weight, fromDb, owner, changeDb, gainDb, targetLiftDb, achievedLiftDb,
  limitedBy, reason, dominantBandsHz, peakOverBedLu, truePeakDb, speech, speechTracks, bedTracks, window}], skipped[{clipId,
  code USER_GAIN|LOCKED|NOT_IN_MIX|OFFLINE|LIMIT, reason}], conflicts[{clipId, kept, lost, message}], warnings, counts,
  levels{delivery, programLufs, truePeakCeilingDb, clusters, clusterSeconds, renders{bed, sound, voice, cached}, ms}}}`.
  Apply: one agent-service transaction "Rebalance SFX Levels" with `expectedRevision` (a concurrent edit → job `CONFLICT`,
  retryable); the editor's call applies as the user's edit. Nothing to change → no transaction (`applied: false`).
  Propose: one item `gain:NNN` per changed clip (group = weight; meta: clipId, timecode, track, from / to, lifts, limitedBy,
  why), feature `sound-design` (the agent accept gate applies). Engine client `rebalanceSfx`.
- MCP `rebalance_sfx` (EDIT_IDEMPOTENT): the route's arguments (range takes any time input), `mode` default propose, waits
  (≤ 900 s), returns `table` (`clip | timecode | sound | role | gain dB (from → to) | target | achieved | limited by | why`),
  counts, skipped, conflicts, warnings, levels, next.
- **Plan job**: after drafting, `solvePlanGains` previews the proposal (`previewProposal` on the live document, once with
  the chosen sounds and once per alternative slot k), measures every layer of the chosen sounds and layer 0 of each
  alternative against the bed of the main preview (one call: the bed is the same for every slot), solves the chosen
  sounds together and each alternative in place of its item's layer 0 with the other chosen sounds, and appends
  `soundDesign.applyGains` (keys `$sfx_<n>_<layer>`, bound by `ref` on the place layers; every alternative set declares
  the same refs) to each place item and each alternative. `meta.why`, `meta.level`, `meta.gainDb` and the report's
  `events[].why / level / layerLevels / alternativeLevels`, `conflicts`, `levels` carry the result ("Pneumatic whoosh on
  Push at 00:00:06:00 · support · peak · −16.2 dB, limited by dialogue A2"). If the levels cannot be measured (no ffmpeg,
  a render error) the plan keeps placement's default levels and warns `W_LEVELS_UNMEASURED`; a sound the mix does not play
  warns `W_LEVEL_UNMEASURED`. MCP `plan_sound_design` adds a `gain` column and per-event `gainDb / targetLiftDb /
  achievedLiftDb / limitedBy`.

#### Verified (measured, this branch; shared host, 16 cores, load average 3–40)

- `pnpm vitest run packages/project/test/sound-apply-gains.test.ts packages/project/test/sound-messages.test.ts`: 7 + 2
  passed (solver level with the offset kept, rounding, dedup of limits; undo = untouched document, redo = same sequences;
  ownership default → solver → user; `$ref` keys; Essential-SFX clip without metadata; dialogue-typed clip with a peak is
  not an effect; swap / role back to the default; every refusal; a solver level survives load, a damaged one is dropped
  with the gain kept, repair idempotent). `fuzz.test.ts` (AC-25, 2 000 runs with applyGains mixed in, > 20 accepted):
  passed. Full `@jasper/project`: 159 files, 1 962 passed.
- `pnpm vitest run apps/engine/test/sound-design-bed.test.ts --maxWorkers=1`: 4 passed. Oracles on a real engine with
  generated media: the cluster bed equals a whole-sequence render of the document without SFX over every window
  (bands < 0.05 dB, local peak < 0.05 LU), 3 clusters < 6 s of a 10 s sequence; each sound alone at 0 dB plus its clip
  gain equals its contribution to the full mix (full − mix without it) within 0.1 dB per band, with rate 0.98 and pan −40;
  the click under the speech overlaps it (`A2`), the others not; a second measurement after a gain change is served from
  the caches with identical results; a disabled clip is reported `not in the mix`. **Mutations:** without the 0 dB
  override the solo test fails; with SFX left in the bed the bed and cache tests fail.
- `apps/engine/test/sound-design-rebalance.test.ts`: 4 passed (apply as the editor: revision + 1, every event reaches its
  target or names a limit, the click under speech `limited by dialogue A2`, the support 0.1 s after the hero
  `hero-shadow`, offset 0.6 kept in the solver level, 2 clusters < 5 s; again → nothing to change, same revision;
  `userGains: 'replace'` by an agent solves the hand-set click; propose with `broadcast-r128`: one item per changed clip,
  agent accept 403, editor accept revision + 1 with the reported gains; explicit ids and range; 7 typed refusals; a fuzz
  target (20 iterations + 6 properties): no 5xx, every job succeeded with a result of the schema or failed with a code).
- `apps/engine/test/sound-design-plan-levels.test.ts`: 2 passed (the Phase 2 fixture + music on A1 + dialogue 4–8 s on
  A2, indexed 8-sound kit + synth: every event has a level and reaches its target or reports `limitedBy`; under-speech
  events limited by dialogue name `A2`; every place item and alternative ends with applyGains on `$sfx_<n>_0…`; same seed →
  same gains and alternative levels; the editor selects alternative 2 on one item and accepts all: one transaction, every
  clip at its reported gain, the alternative at its own solved gain, `sfx.level.by: 'solver'`). **Plan time:** 3.6 s
  (levels 2.1 s, 67 sound renders) at load 3 / 16 cores; 10.4 s (levels 6.2 s) at load 40.
- `apps/engine/test/sound-design-plan.test.ts` 12, `proposals*`, `security-*`, `server`, `fuzz-http`, `audio-*`, `sounds-*`,
  `sound-placement-export`: 24 files, 384 passed. `apps/mcp/test/{sound*,proposals,conventions,readme-tools,fuzz}` +
  `apps/web/test/i18n.test.ts`: 12 files, 407 passed (`sound-rebalance.test.ts`: propose by default with nothing changed,
  the table naming `dialogue A2`, apply, idempotent, strict arguments, `NOT_SFX`). `@jasper/web`: 123 files, 894 passed.
  `pnpm typecheck`, `pnpm lint`, `node scripts/i18n.mjs --check`, `pnpm notices --check`: pass.
- **Real run** (dev engine `JASPER_APPDIR=.stage … --port 50301`, Vite 50302, the full 212-sound library, jasper-mcp over
  stdio; the Phase 2 fixture from `sound-cues-fixture.ts` + 14 s music on A1 + dialogue 4–8 s on A2):
  `plan_sound_design {seed: 2026}` → 17 cues, 18 clips, **10.2 s** (levels 5.0 s, 69 sound renders, 2 clusters; first plan
  of the project, registering 25 sounds; load ≈ 17). Opened in the editor (browser), the editor key accepted every place
  item: History one entry "Accept Sound design: Sequence 01 (60 of 60)". Export (ProRes + 24-bit PCM MOV, 14 s; frame
  6.9 s looked at: the typewriter mid-word): ffmpeg `ebur128` **true peak −4.8 dBTP**, −20.1 LUFS. Bed exported separately
  (the same document without SFX clips) and each SFX clip with the bed alone (video stripped, native): the lift of each
  clip's contribution over the bed in its dominant bands, over its reported window, against the report: **all 18 within
  0.14 dB** (Δ −0.10 … +0.14; e.g. the whoosh under speech 1.33 / 1.33 dB "limited by dialogue A2", the hero 14.22 /
  14.22). The first attempt exported AAC (the vendor LGPL ffmpeg's H.264 forces MP4 / AAC): its codec noise in the
  difference read up to +1.3 dB high — measure lifts on PCM. `rebalance_sfx {mode: 'apply'}` right after accept: "Nothing
  to change" (the plan's and the rebalance's solves agree). Music +6 dB, then `rebalance_sfx apply`: 16 of 18 gains raised
  (e.g. the whoosh under speech −16.2 → −10.2 dB, still at its +1.3 dB dialogue cap); History "Agent: Rebalance SFX
  Levels" one entry; one Ctrl+Z in the editor restored all 18 gains (and their solver levels).

#### Limits and notes for the next packages

- The solver's model: SFX do not mask each other, and the true-peak ceiling is per event and pre-master (overlapping
  events can sum higher; Sound Check's TP check and the master limiter are the net). The measurement assumes the mix is
  bed + sounds (additive): a non-linear master (a limiter or compressor on the Mix or on an SFX track) breaks that; a
  send's reverb tail is part of the sound's contribution, as in the mix.
- Windows over 20 s (beds placed as SFX) are measured on their first 20 s. Rebalance handles ≤ 2 000 clips per request.
- Existing SFX are not part of a plan's solve (the plan solves what it proposes); `rebalance_sfx` solves everything.
- Each alternative is solved with the other items' chosen sounds; choosing alternatives on two neighbouring items can
  leave their hero-shadow / consistency relation unsolved until a rebalance.
- `limitedBy` lists every constraint that moved the gain (WP4.1a semantics): "limited by the gain range" appears when the
  start gain was clamped before a later constraint lowered it; `user-offset` when the variation offset alone took it under
  the target.
- The Web menu item "Sequence ▸ Sound Design ▸ Rebalance SFX Levels" is WP4.2: call `engine.rebalanceSfx({…, mode:
  'apply'})` from the editor (the editor key makes it the user's own edit, History "Rebalance SFX Levels").

### Phase 4 → WP4.2a stop-before, build, room glue, delivery

Scope: spec 12 §2.4 ("Stop-before", "Build", "Room glue", "Delivery presets"), §2.9 (`audio.volumeDip`,
`soundDesign.ensureBus`), P4-R3, P4-R4 (model, engine, MCP; the web UI for these is WP4.2b). Files:
`packages/project/src/sound/{delivery,mix}.ts` (presets; pure dip / sweep / room-send math),
`commands/schemas/sound-mix.ts`, `commands/handlers/sound-mix.ts` (six commands), `handlers/sound-levels.ts` (default
levels moved out of `sound.ts` so both handler files share them), `handlers/sound.ts` (cue edits and placement follow the
mix records), `schema/sound.ts` (`SoundDesign.mix`), `sound/repair.ts`, `sound/proposal-draft.ts` (`requires`, `after`,
`setup`), `audio/fingerprint.ts` (keyframe ids left out), `handlers/structure.ts` (`sequence.duplicate` fix, below),
`catalog.ts`; `packages/audio-fx/src/effects/filter-eq/scientific.ts` (coefficient ramps, below); `packages/api`
(`SoundDeliveryRequest/Report/Result`, plan style + report fields, route `soundDesignDelivery`);
`packages/engine-client` (`applyDelivery`); `apps/engine/src/sound-design/{delivery,plan,bed}.ts`,
`routes/sound-design.ts`; `apps/mcp/src/tools/{sound-design,sound}.ts` (`apply_delivery`, `set_room_glue`,
`set_sound_cues` stopBefore / build, `plan_sound_design` style, SOUND_GUIDE "Mix"), `examples.ts`; README (347 tools),
security review (route row and paragraph), i18n (6 History labels in model-strings / en / es). Tests:
`packages/project/test/sound-mix.test.ts` (16), `fuzz.test.ts` (AC-25 with the six commands), `audio-mix.test.ts` (+1),
`packages/audio-fx/test/build-sweep.test.ts` (3), `apps/engine/test/sound-design-{mix,delivery,plan-mix}.test.ts`,
`apps/mcp/test/sound-mix.test.ts`, `sound-examples.test.ts` (+6).

#### Commands (owner `sound-design`; History labels in brackets, Spanish in es.json)

| Command | Arguments | Result | Refusals |
|---|---|---|---|
| `audio.volumeDip` [Volume Dip] | `clipIds`, `dips[1…64] {start, end (sequence flicks), depthDb −60…0, fadeMs 0…5000}` | `{clips: {id: {written, replaced} \| {skipped}}}` | not audio `E_INVALID_PARAM`; `E_NOT_FOUND`; locked `E_TRACK_LOCKED`; depth > 0, end < start `E_SCHEMA` |
| `soundDesign.applyStopBefore` [Stop Before Cue] | `cueId`, `sequenceId?`, `ambience?` (dip ambience too; remembered) | `{cueId, applied, removed, writes[{target, track, clipId?, keyframes}], reason?}` | `E_NOT_FOUND`; music track locked `E_TRACK_LOCKED`; `E_LIMIT` (automation too dense to record) |
| `soundDesign.applyBuild` [Build Into Cue] | `cueId`, `sequenceId?` | same | same |
| `soundDesign.ensureBus` [SFX Room Glue] | `sequenceId?`, `roomGlue? {sendDb −16, decay 0.6, mix 100, preDelayMs 8}`, `sfxTracks?` | `{busId, label, reverbId, created, sends[{trackId, track, sendId, added}], removed[], skipped[{trackId, track, reason}]}` | track `E_NOT_FOUND` / `E_TRACK_KIND`; bus locked `E_TRACK_LOCKED`; ranges `E_SCHEMA` |
| `soundDesign.removeBus` [Remove SFX Room Glue] | `sequenceId?` | `{busId, removedBus, removedSends}` | `E_NOT_FOUND` (sequence) |
| `soundDesign.applyDelivery` [Apply Delivery Preset] | `sequenceId?`, `delivery`, `loudness?` (default true), `analysis?`, `measuredLufs? {clipId: LUFS \| null}`, `ducking?[{clipIds, regions[[a, b] flicks]}]` | `{sequenceId, delivery, loudness, matched, ducked, redipped, levels}` | clip `E_NOT_FOUND`, not audio / ducking a non-music clip `E_INVALID_PARAM`, `E_TRACK_LOCKED`, `E_SCHEMA` |

Every command has undo / redo and refusal tests, a `describe_commands` example that applies to a real project, and is in
the AC-25 integrity fuzz (2 000 runs; more than RUNS / 50 accepted transactions carry one).

#### Design and decisions

- **Dips merge by the minimum** (spec: "merges by taking the minimum with existing keyframes"). Inside each dip window
  W = [start − fade, end + fade] the curve becomes min(E(t), D(t)) with D = ref + env, ref = the larger of E at W's two
  edges (the local level), env 0 at the edges and `depthDb` on the floor. At the edges D ≥ E, so the result is
  continuous and **outside W nothing changes** (keys outside W keep their ids and values). Breakpoints: W's edges, the
  dips' corners, the existing keys inside, the crossings of E and D, and the kinks where overlapping dips' ramps cross
  (found by the property test, below); values are taken at the times the keys are stored at (whole lane flicks), so the
  line outside W is the same line. Linear and hold curves are exact; a Bézier segment crossing an edge widens W to its
  key and is resampled every 5 ms (approximation within its sampling). A 0 ms fade is a 1 ms ramp (a step would click,
  and W's edges must be at rest). So a static −3 dB clip dips to −27 dB, a clip ducked to −15 dB dips to −39 dB inside
  the duck, and dipping twice is value-idempotent (the second min changes nothing).
- **Stop-before** (`cue.stopBefore {seconds, depthDb}`, a hero at T): one dip [T − seconds, T − 10 ms] with 30 ms fades
  (points T − s − 30 ms: 0, T − s: −depth, T − 10 ms: −depth, T + 20 ms: 0, relative to the local level). WP2.4a's "Stop
  Before Next" (0.25 s at −24 dB) is the same field and default (`STOP_BEFORE_DEFAULT`): nothing to reconcile, the
  values were already in the spec's units. On each audio track with music (Essential Sound type music; ambience with
  `ambience: true`) under the window: the **track's volume lane** through `mixer.writeAutomation` (no thinning) when only
  music plays on that track over the window and its automation mode is not Off; else **`audio.volumeDip` on the music
  clips** (clip Volume, content time; reversed and varispeed clips mapped like the mixer's `contentAt`). Decision: "shares
  its track" is judged over the dip window only (a dialogue clip elsewhere on the track does not matter).
- **Build** (`cue.build {seconds, fromHz, toHz}`): one `jasper.audio.scientific-filter` (Butterworth, High Pass, order 2,
  cutoff 20 Hz at rest) per music track, reused by every build on it (`mix.buildFilters`); keys: rest at T − s − 50 ms,
  fromHz at T − s, nine log-spaced keys to toHz at T − 1 frame (an exponential sweep: equal musical steps; a linear-Hz
  ramp would spend its time at the top), rest at T. Music sharing its track gets the filter as a clip effect on each music
  clip instead (a track insert would filter the dialogue). The rest value is the curve's own at the window's edges.
- **No clicks: coefficient ramps** (fix in the Scientific Filter). The oracle (`build-sweep.test.ts`: a sine through the
  sweep hosted by `EffectSlot` like the export mixer, third difference ≤ 4 × a clean sine's A·ω³, where a 0.1 % step is
  already over the limit) failed on the release at the hero: **3.2 × 10⁻³ at T + 1.4 ms (≈ −38 dB of the tone)** because
  the coefficients jumped every 32 samples while the cutoff fell 2 kHz → 20 Hz in a frame. The filter now interpolates the
  coefficients sample by sample from the design in use to the next (one 32-sample design interval of lag, 0.7 ms);
  prototype, band or section-count changes still switch at once. After: **4.0 × 10⁻⁶** (limit 4.8 × 10⁻⁵) on the
  rendered engine output (below). The filter's existing tests (filter-eq, 28) pass unchanged.
- **Recorded writes, exact removal.** Each realisation stores in `SoundDesign.mix.cues[cueId].{stopBefore|build}` the
  spec, the frame and per place written to (`trackVolume`, `clipVolume`, `trackFilter`, `clipFilter`) the key ids it added
  and the keys it replaced. Removal takes its keys out and, when all of them are still there (nothing rewrote the range),
  gives the replaced keys back — so clearing a stop-before gives the lane back exactly (deep-equal test with a recorded
  fader ride). When something rewrote the range (e.g. `audio.autoDuck` replaces a clip's Volume keys), only its own
  remaining keys go. A build filter left without keys and used by no other build is removed with its last build.
- **The cue drives the mix** (decision; makes "apply realization automatically when a cue is filled" true on every
  surface): `soundCue.update` / `resync` re-write a realised cue that moved or changed and remove it when the field is
  cleared (null) or the cue is muted; `soundCue.remove` removes it; a **filled** cue (a placed sound) with a stored
  `stopBefore` / `build` not written yet gets it written by `soundCue.update` and by `soundDesign.place` (skipping a
  locked music track instead of refusing the placement). Explicit `applyStopBefore` / `applyBuild` work on any cue.
  After unmuting, apply again (a muted cue's record is gone).
- **Room glue rule** (sends are per track): a track sends when it holds sound effects (`isSfxClip`) or is one of the
  settings' SFX tracks, unless all its sound effects are interface sounds (every library type in ui / click / key / tick:
  dry by design) or it also plays bed audio (dialogue, music, ambience, untyped). `sfxTracks` names tracks explicitly
  (they send even with bed audio; interface-only ones stay dry). Sends are post-fader at `sendDb`; the bus is a stereo
  submix "SFX Room" into the Mix with a Studio Reverb (decay 0.6 s, mix 100 %, pre-delay 8 ms; damping / size defaults).
  Idempotent: an existing glue (recorded, `settings.roomBus`, or a submix named "SFX Room" — adopted, `createdBus:
  false`) is reused; levels and reverb follow new settings; its own sends on tracks that stopped qualifying go; a track
  already sending to the room by hand is left alone. `soundDesign.place` adds the send to a track it places a
  qualifying sound on (only adds). `removeBus` removes its sends and the submix it made (an adopted one stays).
- **Room return is the sound's contribution** (WP4.1b's additivity): the bed is the mix with every SFX clip silent, so
  the room carries none of their energy there; each sound's solo render now runs until the reverbs on its way to the
  Mix die out (`soloTailSec`: max of `SOLO_TAIL_SEC` 0.5 s and decay + pre-delay of reverbs in its clip effects, track
  inserts and the submixes its track sends / outputs to, ≤ 6 s). The reverb is linear, so full − bed = Σ solos still
  holds (test below). The delivery's Mix normalisation is excluded from every measurement (as before: `withoutLoudness`).
- **Delivery presets** (`delivery.ts`): web −14 LUFS / −1 dBTP, podcast −16 / −1 (AES TD1008), broadcast-r128 −23 / −1
  (EBU R 128), atsc-a85 −24 / −2 (ATSC A/85); music ≥ 8 LU and ambience ≥ 10 LU under the voice (spec). `level.ts`'s
  `DELIVERY_INTEGRATED_LUFS` / `DELIVERY_TRUE_PEAK_DBTP` now derive from it. `applyDelivery` Auto-Matches by type:
  dialogue at the target, music target − 8 LU (the target itself when the sequence has no dialogue: the music is the
  programme), ambience target − 10 LU; sound effects are skipped ("balanced by the masking solver"), untyped clips too.
  Ducking uses each clip's own Essential Sound Ducking (music −15 dB, ambience −10 dB, 0.8 s fades by default), so
  during speech the music sits ≥ 8 + 15 LU under (measured 22.8 LU, below); stop-before dips written on a ducked clip are
  written again on the ducked curve (autoDuck replaces the clip's Volume keys); default-owned SFX levels move to the new
  preset (solver-owned ones are re-solved by the engine job). The settings' delivery is what Phase 2 B's default levels
  and the solver's programme loudness read, so they follow.
- **The engine job measures** (`POST /api/sound-design/delivery`, `delivery.ts`): each dialogue / music / ambience clip's
  own integrated loudness (Auto-Match's measure: effects without gain, Volume, fades or pan); with that match simulated
  on a copy (`applyTransaction`, fresh ids), the activity of each music / ambience clip's "Duck against" clips grouped by
  trigger set and sensitivity (the analysis job's envelope and `activeRegions`); then `applyDelivery` simulated, the
  sound effects measured against the new bed and solved (WP4.1b), and the result rendered three times (mix, voice,
  music / ambience) for the report: mix loudness and true peak before normalisation, the export's expected loudness and
  peak, speech seconds (dialogue momentary ≥ −60 LUFS and within 20 LU of its loudest), music / ambience under the voice
  during speech (energy mean of the 100 ms momentary values over the speech frames). The measured mix is stored as the
  Mix's loudness analysis (so the preview normalises too). Apply: ONE transaction "Apply Delivery Preset: <preset>"
  (`applyDelivery` + `applyGains` per changed sound effect) with `expectedRevision`; propose: items `delivery` and
  `gain:NNN` (each requiring `delivery`).
- **Fingerprint without keyframe ids** (`mixFingerprint`): the analysis is measured on the simulation, whose new keys
  (ducking, dips) have other ids than the real transaction's; ids do not change the sound, so they are no longer hashed
  and the stored analysis stays current (test: the delivered project's `analysis.mixHash` equals its fingerprint).
  Effect: analyses stored before this build read stale once (they are re-measured; exports always re-measure).
- **Plan style options** (`style.roomGlue: true | {sendDb}`, `stopBefore`, `build`, `delivery`): `room` (ensureBus) and
  `delivery` (`planDelivery` without the SFX re-solve: the plan solves its own) are setup items every place item
  requires, so the gains are solved against the glue and the preset (the preview applies them; `levels.delivery` is the
  style's); for each hero (after the dialogue demotion) with music under its dip window a `stop:NNN` item
  (`soundCue.update {stopBefore: 0.25 s / −24 dB}` + `applyStopBefore`), and for each hero after ≥ 2 s of music a
  `build:NNN` item (2 s, 150 → 2000 Hz), each requiring its place item; a stored cue's own `stopBefore` / `build` is
  proposed (without the update) even without the style. The report gains `mix {roomItemId, deliveryItemId, delivery,
  stopBefore, build}` and per event `stopBeforeItemId` / `buildItemId`. Decision: build defaults 150 → 2000 Hz over 2 s
  (a common riser sweep; undocumented in Adobe terms — Premiere has no "build"), stop-before 0.25 s / −24 dB (WP2.4a).
- **`sequence.duplicate` re-identifies submixes and sends** (pre-existing bug found here; regression test in
  `sound-mix.test.ts` "load and repair": duplicating a sequence with a submix that has an effect or a send failed INV-001
  "Duplicate id trk_ / fx_ / snd_"). Submix ids, their effects and every send get new ids; outputs and send targets
  follow; `settings.roomBus` maps to the copy's bus; the copy drops `soundDesign.mix` (its records name the original's
  keys; running a realisation again on the copy merges by the minimum, so nothing doubles).

#### API for WP4.2b (UI)

- Cue menu "Stop Before Next" / Properties "Cue" build fields: `soundCue.update {cueId, stopBefore | build}` — on a filled
  cue the mix follows in the same command; null removes exactly. Explicit re-apply: `soundDesign.applyStopBefore {cueId,
  ambience?}` / `applyBuild {cueId}`. What is written: `seq.soundDesign.mix.cues[cueId]` (`stopBefore|build: {…spec,
  frame, writes[]}`) — draw the Cue Seam's span bars from it (written) vs the cue fields (stored only).
- Room glue: `soundDesign.ensureBus {roomGlue?, sfxTracks?}` / `removeBus`; state `seq.soundDesign.mix.room {busId,
  reverbId, createdBus, sendDb, decay, mix, preDelayMs, sends[{trackId, sendId}]}` and `settings.roomBus`. Essential Sound
  "Room send" per track: the send `sends.find(s => s.trackId === track)` → `mixer.updateSend` for its level.
- Delivery: `engine.applyDelivery({projectId, sequenceId, delivery, mode: 'apply' | 'propose', loudness?, autoMatch?,
  ducking?, rebalance?})` → job `sound-design` → `SoundDeliveryResult {applied, proposalId, revision, report {preset,
  clips[{clipId, track, type, measuredLufs, targetLufs, gainDb, skipped?}], ducking[], sfx, measure {mixLufs,
  mixTruePeakDb, expectedLufs, expectedTruePeakDb, speechSeconds, musicUnderVoiceLu, ambienceUnderVoiceLu}, warnings}}`;
  the editor's call applies as the user's own edit. Presets for a select: `DELIVERY_PRESETS` (`@jasper/project`).
- Plan dialog (Auto Sound Pass…): `style.roomGlue | stopBefore | build | delivery`; review items `room`, `delivery`
  (setup, required by every placement), `stop:NNN`, `build:NNN` (group `mix`, `meta.kind`, `meta.why`).

#### Verified (measured, this branch; shared host, 16 cores, load average 60–100 during the runs)

- `pnpm vitest run packages/project/test/sound-mix.test.ts --maxWorkers=1`: 17 passed — volumeDip (relative floor −27 dB on
  a −3 dB clip, fades, outside untouched, undo = untouched document, redo = same document up to fresh ids, 6 refusals),
  minimum with a duck (−39 dB inside it, the ducked curve identical outside to 10⁻⁹), reversed 2× clips; the **property**
  (300 runs + 3 pinned counterexamples): inside each window the result is min(existing, dip) (≤ both everywhere), outside
  identical to 10⁻⁶ with the same keys, and unwriting gives the original keys back. It found two bugs, fixed: overlapping
  dips' ramps crossing between corners were not breakpoints (0.5 mdB error), and a key restored through a JSON copy lost
  its −0. Stop-before (track lane values at the four points, idempotent re-apply, clear = the lane exactly as before,
  a recorded fader ride kept outside the window and given back, shared track / automation Off → clip dips, follows a
  moved / muted / deleted cue, ambience remembered, no music → not applied, refusals), build (one filter for two heroes,
  exponential sweep at the geometric mean, removal keeps the filter for the other build then removes it; clip filter
  when the music shares its track), room glue (bus, reverb 0.6 / 100 / 8, −16 dB post-fader sends, interface-only and
  mixed tracks skipped with reasons, idempotent = identical document, settings follow, explicit tracks, removal,
  adoption, a placement on a new SFX track gets its send, an interface sound's new track stays dry, refusals), delivery
  (settings, Mix loudness + analysis, Auto-Match targets −23 / −31 / −33 LUFS for R128, SFX and untyped skipped,
  ducking by each clip's own amount, the music's stop-before written again on the ducked curve, the default SFX level
  −2 → −11 dB, undo / redo, no-dialogue rule, loudness false, refusals), filled cues realise (place, update), a locked
  music track never fails a cue edit, mix records through load / repair / duplicate.
- `pnpm vitest run packages/project/test/fuzz.test.ts`: AC-25 passed (2 000 runs; the six commands mixed in, more than
  RUNS / 50 accepted transactions carry one). `audio-mix.test.ts`: 27 passed (+ keyframe ids not in the fingerprint).
- `pnpm vitest run packages/audio-fx/test/build-sweep.test.ts packages/audio-fx/test/filter-eq.test.ts`: 3 + 28 passed.
  **Mutation:** with the filter as it was (coefficients switched every 32 samples) the build oracle fails at the release:
  third difference 3.2 × 10⁻³ at T + 1.4 ms (220 Hz), 2.8 × 10⁻³ (110 Hz), limit 5 × 10⁻⁵.
- `pnpm vitest run apps/engine/test/sound-design-mix.test.ts --maxWorkers=1` (real engine, export mixer): 5 passed.
  **Stop-before on a native export** (440 Hz music, hero at 5 s, 24-bit PCM MOV decoded by ffmpeg): floor **−23.99 dB**,
  −12 dB crossed at **−264.8 ms** going down (expected −265) and **+4.8 ms** coming back (expected +5), 0.05 dB outside.
  **Build** (pink-noise music, 2 s, 150 → 2000 Hz): spectral centroid 3 452 Hz before → 5 040, 5 512, 6 534, 7 690,
  8 502 Hz across the window (rising) → 3 575 Hz after the hero; a 220 Hz tone through it: third difference max
  **4.0 × 10⁻⁶** (limit 4.8 × 10⁻⁵; a 0.1 % step reads 8.4 × 10⁻⁴). **Room glue:** the hit's room tail −92.8 dBFS where
  the dry render is silent (−240), the interface click renders identically with or without the room (max difference 0);
  the bed with the room equals the bed without it (≤ 10⁻⁶), and full − bed equals the hit's solo measurement (with its
  tail, `soloTailSec` 0.608 s) within 0.1 dB per octave band.
- `apps/engine/test/sound-design-delivery.test.ts`: 3 passed. **Web delivery applied by the editor, then exported**
  (native, 24-bit PCM; ffmpeg `ebur128=peak=true`): **−14.1 LUFS integrated, −1.5 dBTP**; stems on the export mixer
  over the speech (4.2–7.8 s): voice −13.7 LUFS, music −37.0 LUFS (**23.3 LU under**); the report: mix −16.41 LUFS /
  −4.09 dBTP before normalisation, expected −14 / −1.68, speech 4.3 s, music 22.77 LU under the voice; the stored
  analysis' hash equals the delivered document's fingerprint; one transaction (revision + 1); applying again measures the
  same mix. Propose (R128): `delivery` + `gain:*` items, agent accept 403, editor accept revision + 1 at −23 / −1.
  Refusals: bad preset, unknown key, malformed / unknown project, unknown sequence.
- `apps/engine/test/sound-design-plan-mix.test.ts`: 2 passed (room + delivery setup items required by every placement,
  one stop-before and one build item for the fixture's hero, each requiring its placement; the same seed gives the same
  items and commands; the editor's accept: one transaction with the room bus and its sends, the delivery, the dip and
  the build recorded). First plan 59.5 s at load ≈ 80 (the delivery's measurement renders the whole sequence three times
  and every clip once; estimated ≈ 15 s at load ≈ 15 from WP4.1b's 3.6 s → 10.4 s scaling).
- Engine regressions: `sound-design-{plan,rebalance,bed,cues,plan-levels}`, `proposals`, `fuzz-http`, `security-review`,
  `server`: 9 files, 247 passed. MCP: `sound-mix` (stopBefore / build on a filled cue written and removed exactly, room glue
  on / again / off, apply_delivery propose then apply, strict arguments), `conventions`, `readme-tools`, `sound-guide`,
  `sound-examples` (18): pass.
- **Real run** (dev engine `JASPER_APPDIR=.stage JASPER_DEV=1 pnpm exec tsx apps/engine/src/cli.ts --port 50501`, the
  full 212-sound library, a scratch jasper-mcp client over stdio; the Phase 2 fixture `FIXTURE_COMMANDS` + the 10 s
  pink-noise music on A1 + dialogue 4–8 s on A2): `plan_sound_design {style: {seed: 2026, roomGlue: true, stopBefore:
  true, build: true, delivery: "web"}}` → 17 placements, `room`, `delivery`, `stop:013` and `build:013` on the hero (the
  "sfx: boom+swoosh" marker at 00:00:08:10), 78 s at load ≈ 95 (levels 48.4 s, 69 sound renders). Accepted with the
  editor key (one transaction). The document: "SFX Room" (S1) with a Studio Reverb 0.6 s / 100 % / 8 ms and sends from
  "SFX 1" and "SFX 2"; A1 (music) with 4 volume keys (the dip) and one Scientific Filter with 11 cutoff keys (the
  build); the Mix normalising to −14 / −1. **Export** (ProRes 422 HQ + PCM, 14 s): ffmpeg `ebur128` **−14.0 LUFS, −2.8
  dBTP** (LRA 17.2 LU). Looked at: waveform and spectrogram (ffmpeg `showwavespic` / `showspectrumpic`) of the export
  from 5.8 to 9.3 s — the speech syllables until 8.0 s over the ducked, thinning music, then the hit at 8.33 s — and of a
  music-only export of the same window (the other tracks and the room muted): the low end fades from 6.33 s (T − 2 s)
  with the cut edge climbing past 2 kHz by ≈ 8.05 s, the whole band drops ≈ 24 dB from ≈ 8.08 s to ≈ 8.35 s (the dip;
  times read off the picture, estimated ± 20 ms) and the full band is back at the hero. A first run with the dialogue
  clip spanning 0–10 s (silent outside 4–8 s) proposed neither a stop-before nor a build: the only hero cue was "under
  spoken words" (dialogue ranges are clip spans without a transcript, WP3.2) and placed as support — as designed; its
  export also measured −14.0 LUFS / −1.4 dBTP. The pictures, plan reports and logs are in
  `/var/lib/orquester/tmp/p4-dips-room-run/` (generated media: not committed).
- After merging the integration branch (WP3.3b): `pnpm lint` (Biome, tokens, anime, layers, assets) and `node
  scripts/i18n.mjs --check` (9 375 strings) pass; `pnpm typecheck` passed every package up to `apps/web`, whose check the
  workspace run's 50 min timeout cut at load ≈ 115 — `pnpm --filter @jasper/web typecheck` alone then passed.
  `pnpm vitest run packages/audio-fx packages/api packages/engine-client apps/web/test/i18n.test.ts`: 374 of 377 passed;
  the 3 failures are timing tests at load ≈ 110 (WP4.1a's "2000 events in under 50 ms": 131 ms; two Music Remix
  analyses over their 120 s timeout) in code this package does not touch (`masking.ts`, `remix.ts`).
  `pnpm vitest run --project @jasper/project --maxWorkers=3` at load 85–105: 1 975 of 1 980 passed; the 5 failures are
  tests over their own time limits (hostile parser fuzz MCC / .3dl / LUT, the glTF mesh budget's 20 s, and
  `sound-p2v-model`'s repair property at 120 s) — run alone the property passes (35 of 35) and so do the parser fuzz
  targets (47 of 48 with the glTF timing check failing again at 52 s); before the merge the whole suite passed (160 files,
  1 977 tests). Engine after the merge: `sound-design-{mix,delivery,bed,rebalance}` pass; `proposals` and
  `sound-design-plan` pass with `--testTimeout=900000` (their 5 s defaults time out at load ≈ 140);
  `sound-design-plan-mix` passes (its first plan took 966 s at load ≈ 100: its timeout now follows the load);
  `sound-design-plan-levels`' timing assertion (≤ 45 s) fails at load ≈ 140 (138 s). MCP after the merge: `sound-mix`,
  `conventions`, `readme-tools`, `sound-guide`, `sound-examples`, `sound-rebalance`, `sound-cues`, `fuzz` pass;
  `proposals.test.ts` (whose plan-table header this package extends with a `mix` column; `MCP_PROPOSALS_TEST_PORT=50511`)
  could not start its engine within its 120 s at load 70–100 three times, then passed (5 of 5) at load ≈ 75.

#### Limits and notes for the next packages

- **UI is WP4.2b**: Essential Sound "Room send" / "Stop before next", the delivery select, the plan dialog's options and
  the Cue Seam's written-vs-stored span bars (API above).
- The plan's `delivery` item is measured on the edit before the plan's own sounds, so its stored analysis (the real run:
  −16.9 LUFS) is not the final mix's: the preview's normalisation gain is off by the effects' share until the mix is
  analysed again; exports always re-measure (the real run's export: −14.0 LUFS). `apply_delivery` after a plan is exact.
- The default ducking (music −15 dB) puts the music far further under the voice than the 8 LU minimum (measured
  22.8–23.3 LU); lower the clip's Ducking amount for a fuller bed.
- Muting a cue removes its dip / build; after unmuting apply again (or edit the cue). A cue edit leaves a realisation on
  a locked music track as it is (it catches up after unlocking); explicit `applyStopBefore` / `applyBuild` refuse it.
- Sends are per track: an interface sound sharing a track with other sound effects gets the room; a sound effect on a
  dialogue track gets none (unless the track is named in `sfxTracks`).
- A Bézier volume segment crossing a dip edge is rebuilt from 5 ms samples; the build filter's cutoff lags its keys by
  one 32-sample design interval (0.7 ms) while gliding.
- `soloTailSec` caps a sound's reverb tail at 6 s; a room with a longer decay measures the first 6 s.
- `packages/audio-fx` timing tests (WP4.1a's "solves 2000 events in under 50 ms", the Remix analyses) fail on this host at
  load ≳ 90 (50.6 ms and 131 ms measured; timeouts); they are load-sensitive checks of code this package does not change.

### Phase 4 → WP4.2b mixing UI

Scope: spec 12 §2.7 "Essential Sound SFX additions" (Auto gain with its reason, Room send, Stop before next), the Cue
Seam's build / stop-before span bars, the Properties "Cue" section, Sequence ▸ Sound Design ▸ Rebalance SFX Levels,
P4-R4 (delivery presets reachable from the UI) and P4-R5; the Auto Sound Pass… mix options (WP4.2a's plan style).

Files: web `apps/web/src/sound/{mix-model.ts (pure: level views, review gain text, room view, written vs stored, field
validation, delivery labels), mix-jobs.ts (rebalance / delivery jobs for the user, Undo by History entry),
EssentialSfxMix.tsx, MixFields.tsx (NumberInput, StopBeforeEditor, BuildEditor), MixDialogs.tsx (Room Glue…, Delivery
Target…)}`, `commands/sound-mix.ts` (+ `commands/index.ts`), `sound/EssentialSfx.tsx` (mounts the rows),
`sound/SoundSection.tsx` (Properties ▸ Cue uses the editors), `sound/AutoSoundPassDialog.tsx` (Mix fieldset),
`sound/PreferencesPage.tsx` (Delivery group), `sound/cues/{model.ts, CueSeam.tsx, seam.ts}` (written vs stored spans,
Build Into Cue in the cue menu, the stored-only explanation), `panels/review/ReviewPanel.tsx` (the gain formatter only),
`shell/menus/model.ts`, `i18n/model-strings.ts` (delivery preset names and sources), es.json (156 strings); model
`packages/project` `soundDesign.setAutoGain` (schema, handler, catalog label "Auto Gain") and `sfx.level.manual`
(`schema/sound.ts`, `sfxGainOwner`); `apps/mcp/src/examples.ts` (setAutoGain example), SOUND_GUIDE (manual gains).
Tests: `packages/project/test/sound-auto-gain.test.ts` (5), `fuzz.test.ts` (AC-25 draws setAutoGain),
`apps/mcp/test/sound-examples.test.ts` (+1), `apps/web/test/sound-mix-model.test.ts` (10), `sound-mix-ui.test.tsx` (11),
`auto-sound-pass.test.tsx` (+2), `e2e/sound-mix.spec.ts`.

#### What it does (usage)

- **Essential Sound ▸ Sound Design ▸ Gain** (placed sounds): "Auto gain (masking-aware)" is on while placement's default
  level or the masking solver owns the clip gain (`sfxGainOwner`), mixed for a mixed selection. Under it the level record:
  a badge (Default / Solver / Manual, by text and outline, not colour alone) and "−3.0 dB · limited by dialogue A1" — the
  solver's `limitedBy` codes in words (translated; the track names come from the stored reason), "target lift +5.0 dB
  reached", "default level: its true-peak ceiling", "Auto gain off (last solve: −6.0 dB)", "set by you"; the lift line
  "Lift over the bed +1.5 dB of +5.0 dB". **Off** = `soundDesign.setAutoGain {auto: false}` ("Auto Gain Off"): the gain
  stays exactly where it is and becomes the user's (the record stays, marked `manual`), so Rebalance, a delivery preset, a
  swap or a role change leave it alone. **On** = `sound.setAutoGain {auto: true}`: the engine's rebalance names those
  clips (`POST /api/sound-design/rebalance {clipIds, mode: 'apply'}`: named clips are always solved), one undo step
  "Rebalance SFX Levels" with a toast (Undo); a clip the solve did not change, or with no engine, just gets its mark
  cleared ("Auto Gain On"). **Rebalance** solves the selection's automatic gains (disabled, with why, when none is on).
- **Room**: "Send A3 to the SFX Room" + the send level slider (−48…+6 dB, double-click −16) and "Applies to the whole
  track A3, not only this clip" (sends are per track). On without a room creates the glue (`soundDesign.ensureBus`: bus,
  Studio Reverb, sends from every qualifying track; "SFX Room Glue"); with a room, adds the track's send at the glue's
  level (`mixer.addSend`) or unmutes it; off mutes the send (`mixer.updateSend {mute}`: a re-run of the glue keeps it
  muted; "Room Send Off"); a slider drag is one gesture → one History entry "Room Send Level". Disabled with the reason
  for interface-only tracks ("… plays only interface sounds (UI, clicks, keys): they stay dry") and for tracks that also
  play dialogue / music / other bed audio; an automated send level says "automated in the Audio Track Mixer".
- **Stop / Build** (the cue the clip fills; disabled with "This sound fills no cue: …" otherwise) and **Properties ▸
  Cue**: the same editors — a toggle (Stop before next = 0.25 s / −24 dB, Build = 2 s, 150 → 2000 Hz: the model's
  `STOP_BEFORE_DEFAULT` / `BUILD_DEFAULT`, which replaced WP2.4b's 1 s / 200 Hz build default), Length / Depth or Length /
  From / To fields (Enter or blur commits, Esc reverts; "0,25" and "−24" accepted) validated before anything is written
  (length > 0 and ≤ 10 / 30 s, depth < 0 and ≥ −60 dB, 20–20000 Hz, To above From: `role="alert"` text,
  `aria-invalid`), each edit ONE `soundCue.update` (a filled cue's mix follows in the same command, WP4.2a), and where it
  stands: "● Written into the mix: A1 track volume" or "○ Stored on the cue: Written into the mix when the cue is
  filled / No music plays under it / The music track is locked / The cue is muted" with **Write Now**
  (`soundDesign.applyStopBefore` / `applyBuild`, which also writes an unfilled cue's; "Nothing was written" + the
  engine's reason when there is no music).
- **Cue Seam**: a stop-before bar / build wedge drawn from `soundDesign.mix.cues` where it was written (solid, `--pr-cue`)
  and from the cue's fields when only stored (dashed `--pr-cue-unfilled` outline; `data-written` on both). The cue menu's
  Stop Before Next keeps WP2.4a's toggle and gains **Build Into Cue**; turning either on for a filled cue whose music
  could not take it shows "Stored on the cue, not written into the mix: <why>".
- **Sequence ▸ Sound Design**: **Rebalance SFX Levels** (every sound effect of the sequence; user gains kept; progress
  toast with the job, then "Rebalanced n sound effects" · "n solved · n limited · n kept (your gains)" with Undo, or
  "Nothing to change …" without a History entry), **Room Glue…** (on / off, send level, decay, mix, pre-delay; "Sends
  from: A3, A4", "Dry: <reason>" per track, the bus and whether sound design made it; Apply = one `ensureBus` or
  `removeBus`), **Delivery Target…** (the four presets as "Web / streaming · −14 LUFS · −1 dBTP", the integrated / true
  peak / under-the-voice numbers and their source; what to apply: normalisation, Auto-Match, ducking, re-solving; Apply
  runs `POST /api/sound-design/delivery` in apply mode with a progress bar and Cancel, then shows what the engine
  measured — mix before normalisation, the export's LUFS / dBTP, music and ambience under the voice, speech seconds,
  matched clips, ducked groups, re-solved effects, warnings — and toasts "Applied <preset>" with Undo; the button becomes
  Close).
- **Preferences ▸ Sound Library ▸ Delivery**: the active sequence's target (`soundDesign.setSettings {delivery}`, "Sound
  Delivery Target": what default levels and Rebalance aim at) and a Delivery Target… button.
- **Auto Sound Pass… ▸ Mix**: Room glue (+ its send level), Stop before heroes, Build into heroes, Delivery (Keep the
  current mix or a preset) → the plan's `style.roomGlue {sendDb} | stopBefore | build | delivery` (absent when off).
- **Review rows** show the item's own solved gain and its limit ("−15.6 dB · limited by its repeats (±2 dB)"), from the
  plan's `meta.level` / the rebalance item's meta; for a chosen alternative the drawn gain alone (its level is not in the
  item's meta).
- **Agents** (MCP parity, checked): every UI action has an MCP path — Rebalance → `rebalance_sfx` (propose by default,
  `mode: 'apply'`, `clipIds`); Delivery Target… → `apply_delivery`; Room Glue… → `set_room_glue`; Essential's per-track
  send → `apply_commands` `mixer.addSend` / `mixer.updateSend` (or `add_send`); Stop before / Build → `set_sound_cues`
  `stopBefore` / `build` and `apply_commands` `soundDesign.applyStopBefore` / `applyBuild` (Write Now); Auto gain off /
  on → `apply_commands` `soundDesign.setAutoGain` (+ `rebalance_sfx {clipIds}`); Auto Sound Pass mix options →
  `plan_sound_design` `style`. The UI commands `sound.rebalanceSfx {clipIds?}` and `sound.setAutoGain {clipIds?, auto}`
  are also in the UI command catalogue (`ui_command`).

#### Decisions

- **Auto gain off keeps the record** (`sfx.level.manual: true`, optional, validated by the level schemas; `sfxGainOwner`
  answers `user`) instead of deleting `sfx.level`: the variation offset survives (turning it on solves with it, Phase 2 B
  / WP4.1b offset semantics) and Essential Sound can still say what the last solve was. An older build ignores the flag
  (loose object) and treats the gain as automatic again — it loses the preference, not data. No schema bump.
- **Auto gain on is a solve, not a flag flip**: a sound handed back to the solver should be solved now; the flag flip is
  the fallback for what the solve did not touch (unchanged gain, skipped, no engine).
- **Rebalance in Essential names only the automatic clips** of the selection: a named clip is always solved by the
  engine, so naming manual ones would override the user's choice.
- **Room off mutes the send** instead of removing it: an `ensureBus` re-run (Room Glue… Apply, a plan's room item) would
  add a removed send again; a muted one stays muted. Turning the room on for a track the glue skipped adds a plain send
  (not recorded in `mix.room.sends`: `removeBus` removes the submix and with it every send to it, but not this send's
  record — there is none).
- **Bed tracks are blocked**, not just interface-only ones (task: interface-only): a send on a track that also plays
  dialogue would put the dialogue in the room. The Audio Track Mixer still allows it by hand.
- Delivery numbers are labelled with real minus signs; the presets' names and sources are model strings (translated).
- Review: only the formatter changed (the verifier owns the Review panel); the misattributed ghost gain it works around
  is reported below.

#### Verified (measured, this branch; shared host, 16 cores, load average 35–140 during the runs)

- `pnpm vitest run packages/project/test/sound-auto-gain.test.ts packages/project/test/sound-apply-gains.test.ts
  --maxWorkers=2`: 5 + 7 passed — off keeps −6 dB and the whole solver record (offset 0.5, lifts, limits, reason) with
  `manual: true`, owner `user`; undo = the untouched document, redo = the same sequences; on gives it back to the
  solver; a manual gain survives `setRole`, `swap` and `applyDelivery` (R128) while an automatic neighbour follows them;
  `applyGains` naming the clip replaces the record (no `manual`); on does not take back a gain changed by hand; an
  Essential-SFX clip without metadata is left identical; refusals `E_NOT_FOUND` (clip, sequence), `E_INVALID_PARAM`
  (video, bed audio), `E_SCHEMA` (empty, bad `auto`, unknown key), `E_TRACK_LOCKED`; the flag through load, a damaged
  flag drops the level (gain kept), repair idempotent. `fuzz.test.ts` (AC-25, 2 000 runs, setAutoGain drawn) and
  `apps/mcp/test/sound-examples.test.ts` (20, the setAutoGain example applies): pass. Project sound suites
  (`sound-level`, `sound-mix`, `sound-swap-role`, `sound-apply-gains`, `sound-auto-gain`, `sound-design-place`): 60
  passed.
- `pnpm vitest run apps/web/test/sound-mix-model.test.ts`: 10 passed (dB format; solver / default / manual / user views
  with translated limits and track names; review gain text: the item's own gain wins over the ghost's, alternatives
  show the ghost's; a 300-run `fc.anything()` property never throws; written vs stored and why — filled → "A1 track
  volume" / "A1 track filter", the build written from frame 90 for 2 s before 150, unfilled / muted / no music; room
  view: none → can send, glue → its send at −12, a track that also plays dialogue → blocked with why; validation;
  delivery labels).
- `apps/web/test/sound-mix-ui.test.tsx`: 11 passed (testing-library, real session, a fake engine for the jobs):
  Essential shows "−6.0 dB · limited by dialogue A1", Solver, "Lift over the bed +1.5 dB of +5.0 dB"; unchecking →
  "Auto Gain Off", the gain unchanged, Manual, Rebalance disabled; checking → the rebalance request names the clip in
  apply mode, ONE entry "Rebalance SFX Levels", "Rebalanced 1 sound effect" whose Undo restores −6 dB; Rebalance with
  nothing to change adds no entry; Room: on creates the glue (send from A2 only), a keyboard step on the slider = ONE
  "Room Send Level" (−15.5 dB), off mutes ("Room Send Off"), undo unmutes; a track with dialogue is disabled with the
  reason; Stop before: on writes "A1 track volume", "0" is refused with the message and `aria-invalid`, "0,5" is
  written; Build: From 3000 refused ("A build rises: To must be above From"), To 4000 written into "A1 track filter";
  no cue → the reason; Properties ▸ Cue: an unfilled cue's dashed bar (`data-written="false"`), Write Now →
  "Stop Before Cue" and a solid bar, depth 5 refused, −30 written; the menu lists the three entries; the menu's
  Rebalance (no clip ids) with "1 solved · 1 limited · 1 kept (your gains)" and Undo; Room Glue… shows "Sends from: A2",
  applies −16.5 dB / 0.6 / 100 / 8, then off removes it; Delivery Target…: podcast selected by its label, the request
  (apply, all four options), the summary ("Export: −16.0 LUFS, −1.5 dBTP", "Music under the voice: 22.8 LU (at least
  8)"), ONE entry, Close, the toast's Undo.
- `apps/web/test/auto-sound-pass.test.tsx`: 6 passed (+2: Room glue with its slider, Stop before / Build into heroes, Web
  delivery → `style {roomGlue: {sendDb: −15.5}, stopBefore, build, delivery: 'web'}`; off → none of the keys).
- Regressions: `sound-cue-seam`, `sound-cue-seam-model`, `sound-fill-ui`, `sound-fill-swap`, `sound-cue-commands`,
  `sound-p2v-seam`, `sound-review-misc`, `sound-library-review`, `review-ui`, `review-model`, `keymap`,
  `polish-menu-wiring`, `polish-i18n`, `i18n`, `sound-i18n`: 16 files, 145 passed. `node scripts/i18n.mjs --check`:
  9 526 strings covered. `pnpm typecheck` (workspace), `pnpm lint` (Biome, tokens, anime, layers, assets), `tsc -p
  e2e/tsconfig.json`: pass.
- **E2E** (`pnpm build`, then `E2E_PORT=50705 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-mix.spec.ts`; 12.1 min
  at load ≈ 70–90): the Phase 2 fixture (without its fframes graphic, which the native export cannot render here) +
  14 s of pink-noise music on A1 + a 4 s syllabic 1.5 kHz "voice" on A2 at 4 s → Auto Sound Pass… with Room glue, Stop
  before heroes, Build into heroes and Web → 16 items in review → Accept all → Apply = ONE History entry; the document
  has the "SFX Room" bus and its sends, `settings.delivery: web`, and the hero (the `sfx: boom+swoosh` marker at
  00;00;08;10) with its dip and build recorded as written — the seam's bars carry `data-written="true"`; Essential Sound
  shows "Solver · −20.5 dB · limited by its repeats (±2 dB), dialogue A2; conflict: its repeats (±2 dB) kept over
  dialogue"; music +6 dB, then Sequence ▸ Sound Design ▸ Rebalance SFX Levels = ONE entry "Rebalance SFX Levels", gains
  changed; Ctrl+Z gives back every gain, Ctrl+Shift+Z re-applies; Room Glue… shows "Sends from: A4, A5", "Bus: SFX Room
  (made by sound design)"; Delivery Target… (Web) = ONE entry "Apply Delivery Preset: Web / streaming (−14 LUFS)",
  summary "Mix before normalisation: −17.5 LUFS, −6.2 dBTP · Export: −14.0 LUFS, −2.8 dBTP · Music under the voice: 23.1
  LU (at least 8) · Speech found: 4.3 s · Auto-Matched clips: 2; ducked groups: 1 · Sound effects re-solved: 12 changed,
  9 limited"; **native export (H.264 + AAC) measured by ffmpeg `ebur128=peak=true`: −14.1 LUFS integrated, −2.8 dBTP**
  (the two earlier runs that reached the export step measured the delivery's "Export" at −14.0 / −1.5 and −14.0 / −2.8
  dBTP; their export step failed for reasons in the spec: the fframes graphic, a reset socket). Screenshots looked at
  (`test-results/e2e-sound-mix/`): the dialog's Mix fieldset, review (rows "support −16.5 dB · limited by its repeats
  (±2 dB)"), the seam's span bars and the timeline, Essential Sound ▸ Sound Design (badge, wrapped reason, lift,
  Rebalance, Room A4 −16 dB, Stop / Build of a support cue off), Room Glue…, Delivery Target… with its summary, the
  exported frame at the hero. The looks found: the Room glue checkbox squeezed by its slider in the dialog (now on its
  own row), the review gain of an item that requires the delivery item showing the music's +14.6 dB (now the item's own
  solved gain), the Essential reason truncated (now wraps). The spec also adds an unfilled cue with a stop-before and a
  build and checks both are drawn stored-only (`data-written="false"`, dashed; `cue-span-bars-stored.png`).
- **Every sound e2e** (same build, one run of all nine spec files, 1.2 h at load 46–97): 16 passed, 4 failed —
  `sound-mix` passed (7.1 min, with the stored-only check); the failures are not from this package:
  `sound-p0-transport` "first samples…" and `sound-proposal-ghosts` ("Every one of 8 plays was disturbed by the host
  (load average 46–59) … nothing was measured": the documented load-sensitive real-time checks), `sound-fill` (the
  right-click on the filled clip landed off it: the timeline was scrolled to 3;20–4;20 with the clip at 2;15 — the
  case the Phase 3 verifier's `clipBodyClick` fix on `feat/sd-p3-verify` handles; its screenshot shows this package's
  Essential rows working: "Default · −6.6 dB · default level: its true-peak ceiling") and `sound-p2-done` (its export
  job still running when the 25 min test timeout hit, at load ≈ 90). `sound-cues`, `sound-library` (3), `sound-p0-preview`
  (5), the other four `sound-p0-transport` tests and `sound-review` (2) passed.

#### Limits and notes for the next packages

- **Review gain attribution (Phase 3 verifier's area):** `buildReviewModel` takes an item's gain from its first ghost
  clip; when the item requires a setup item that changes other clips (the delivery preset Auto-Matches the music), that
  first clip can be the music. The row now prefers the item's own `meta.level.gainDb`; a chosen **alternative** still
  shows the ghost's gain (its level is not in the item's meta). Fix in `review.ts` / `ghosts.ts`: prefer the clips the
  item creates.
- The Room row acts on the first selected clip's track; tracks that also play bed audio are blocked (the Audio Track
  Mixer still sends by hand); a send added there for a track the glue skipped is not recorded in `mix.room.sends` (the
  glue's removal removes it with the bus).
- The Phase 4 Essential rows show for placed sounds (`sfx` metadata); an Essential-SFX clip without it has no level
  record (Rebalance still solves it: `sound.rebalanceSfx` and the menu include it).
- Auto gain on when the solve does not change the gain (or skips the clip) adds a second History entry ("Auto Gain On")
  after "Rebalance SFX Levels" when both happen in one press (only for a mixed selection).
- Delivery Target… keeps the dialog's Cancel next to Close after a run (Cancel closes; it never undoes).
- No new keyboard shortcuts (none in spec 12 for these); `keymap.test.ts` passes unchanged.
- The e2e removes the fixture's fframes motion graphic: in this environment the native export refuses it (`PATH_NOT_ELIGIBLE`,
  "needs the fframes renderer, which is unavailable").

### Phase 4 verification

Branch `feat/sd-p4-verify` (from `feat/sound-design` 6ab79253), with three helper branches merged into it:
`feat/sd-p4v-model` (project model fixes), `feat/sd-p4v-engine` (engine fixes and performance), `feat/sd-p4v-web` (web
UI); then the integration branch again (Phase 3 verification, 1ab1256f). Scope: the whole of Phase 4 (P4-R1…R5, "Done
when", the Definition of Done) after WP4.1a–WP4.2b, the review list of the orchestrator (solver order, conflict
reporting, bed with room return, dips / builds / room glue exactness, delivery atomicity, `mixFingerprint`, auto gain,
mute / unmute, the plan's delivery measurement, ducking depth, multi-selection, the fframes refusal) and the slow plan
job. Shared host, 16 cores; load average 8–70 during the pass, stated with every timing.

#### Requirements (spec 12 Phase 4) with evidence

| Requirement | Status | Evidence (rerun) |
|---|---|---|
| P4-R1 masking solver, constraints in order (clamp, bed cap, hero shadow, consistency, dialogue, headroom), re-verified after the last step; earlier wins and the conflict is reported; unit + property (monotone in the bed until a cap, caps hold) | done | `packages/audio-fx/test/masking.test.ts` (29 tests; new here: the binding constraint named in a conflict instead of "clamp", +1 dialogue advice names only speech-octave bands, +1 silent bed wording), `masking-oracle.test.ts`; reviewed: no path to `W_UNRESOLVED` (rounding leaves ≤ 2.010 dB against 2.010 + 2·10⁻⁹) |
| P4-R2 engine bed render per cue cluster; `soundDesign.applyGains`; `rebalance_sfx`; plan job with `limitedBy` | done | `apps/engine/test/sound-design-bed.test.ts` (+ id-free cache, offline-media key), `sound-design-rebalance.test.ts` (+ CONFLICT on a concurrent bed edit), `sound-design-plan-levels.test.ts` (+ a second identical plan renders nothing), `packages/project/test/sound-apply-gains.test.ts`, `apps/mcp/test/sound-rebalance.test.ts` |
| P4-R3 stop-before, build, `audio.volumeDip`, `soundDesign.ensureBus` | done | `packages/project/test/sound-mix.test.ts`, `sound-p4v-mix.test.ts` (new: 12 regression tests + 2 properties: overlapping realisations removed in any order give the lanes back exactly; curved lanes), `packages/audio-fx/test/build-sweep.test.ts`, `apps/engine/test/sound-design-mix.test.ts` (exported dip, sweep, room tail) |
| P4-R4 delivery presets wired to `mixer.setLoudness`, Auto-Match and ducking | done | `apps/engine/test/sound-design-delivery.test.ts` (+ conflicts / solver warnings in the report, CONFLICT), `sound-mix.test.ts` (delivery, ducking depth), `apps/mcp/test/sound-mix.test.ts`; real run below: −14.0 LUFS / −1.3 dBTP, music 14.1 LU under the voice |
| P4-R5 Essential Sound SFX additions, Sequence ▸ Sound Design ▸ Rebalance SFX Levels | done | `apps/web/test/sound-mix-model.test.ts` (19), `sound-mix-ui.test.tsx` (15: multi-selection Room / Stop / Build, solver notes), `auto-sound-pass.test.tsx`; `e2e/sound-mix.spec.ts` |
| "Done when" (a): on the fixture every placed event reaches its target lift or reports `limitedBy` | done | `apps/engine/test/sound-design-plan-levels.test.ts` and `sound-design-plan-mix.test.ts` assert it per event; the real run's table below (17 items, each "target reached", "already clears the bed", "nothing plays under it" or "limited by …") |
| "Done when" (b): the export matches the preview mix (sample-level oracle) | **done here** (it did not exist for automation; it failed, the preview was fixed) | `packages/compositions/test/audio-preview-mix-oracle.test.ts` (new): the preview graph in headless Chrome driven as while playing vs the export mixer, for solver gain + room send + stop-before + build, max \|Δ\| **1.4·10⁻⁵** in both scenes (track lane / clip fallback); before the fix **0.19 / 0.15** |

Definition of Done: schema fields added here are optional with read-time defaults and repair (`sfx.level.manual` from
WP4.2b; `mix.cues[*].{stopBefore,build}.order | suspended`, `mix.orphans`, `essential.ducking.depthBy`); no schema
bump: Phase 4 is unreleased (`feat/sound-design` is not on `main`) and an older build of this branch only misreads a
suspended record as written (it keeps every key). Every edit is an undoable command with undo / redo and refusal
tests; the UI is wired (menus, Essential Sound, Properties, dialogs; no new shortcuts); the Program monitor previews
it (oracle above) and every export path renders it (ordinary clips, automation, inserts and sends, D-42; the planner
refuses an fframes graphic natively only without jasper-mg, below); agents drive it through MCP (`plan_sound_design`
style, `rebalance_sfx`, `apply_delivery`, `set_room_glue`, `set_sound_cues`, `apply_commands`); ran in the real app and
through MCP (below).

#### Findings and fixes

26 defects fixed, each with a regression test that failed before the fix: preview 2, project model 13, engine 8 (the
masking label included), lead 3 (fingerprint, two solver wordings).

Preview (lead, `packages/compositions`):

- **The preview did not follow automation between picture frames** — the "Done when" oracle did not exist for anything
  but static levels. Driven as while playing (one `graph.update` and one Remotion clip volume per frame), the preview of
  a Phase 4 mix was up to **0.19** (track lane dip) and **0.15** (clip Volume dip) off the export: strip lanes were set
  once per frame with an 8 ms glide, a clip's Volume keyframes were Remotion's per-frame steps (a 24 dB step in one
  frame on a stop-before ramp: a click), and effect slots evaluated keyframes once per frame (a build sweep 1·10⁻² off,
  its release 2·10⁻²). Fix: while playing, automated gains (strip fader / mute / send level, a clip's Volume, fades,
  nested gain) follow their curve sample by sample: each update schedules linear pieces through the lane's own values
  over the next 0.12 s, cut where it bends (keyframes as break points, ≤ 10⁻⁴ relative between pieces; `automation.ts`
  `followCurve`); clips whose level changes play at unity into the graph, which applies the levels (`graphAppliesLevels`);
  effect slots get a clock with each time message and evaluate keyframes every 32 samples on the export's grid
  (`SlotClock`, `FxSlotCore`); the level node closes on the sample at a clip's end like the export (an effect tail
  rang past it); the graph reads the time of the audio it renders from Remotion's sync anchor and the playback rate
  (`update(…, {compositionFlicks, rate})`), not the picture frame's time (which trails it by the output latency and the
  frame callback). Chrome's `cancelAndHoldAtTime` held wrong values after a few replaced ramps (a flat 1.0 read 0.27 a
  frame later), so the hold value is computed from the scheduled curve and set explicitly. Measured
  (`audio-preview-mix-oracle.test.ts`, the graph with the anchor): **1.4·10⁻⁵** for both scenes; with the picture
  frame's time instead of the anchor (≤ one render quantum early in the harness) 2.6·10⁻² / 6.4·10⁻³, which is why the
  anchor matters. `audio-fx-slot-clock.test.ts`: a slot with frame-rate time messages equals the export's `EffectSlot`
  to < 10⁻⁶ (without the clock > 10⁻³); `audio-automation.test.ts` (curve pieces within tolerance, corners on keys,
  hostile values). The Phase 0 preview / transport e2e still pass (10 of 10, `e2e/sound-p0-preview.spec.ts`,
  `sound-p0-transport.spec.ts`, load ≈ 45–55).

Project model (`feat/sd-p4v-model`; regression tests in `packages/project/test/sound-p4v-mix.test.ts`, each failed
before):

1. **Overlapping realisations** could not be removed one at a time: clearing cue A then B left A's floor at −27.39 dB
   with orphan keys (expected the original −4.22 dB ride); moving A then removing both left a −23.91 dB ghost dip; two
   overlapping builds left the filter with 6 keys. Each written lane is now a stack (records carry `order`): removing a
   record takes out the later ones, itself, and writes the later ones again. Property (40 runs): random overlapping
   stop-befores and builds on track and clip lanes, moved, removed in random order → every lane deep-equal to the
   original.
2. **Bézier volume keys**: a swell outside the dip was flattened (0.029 dB off → < 0.002 dB), edge keys lost their eases
   (−5.00 → −3.75 dB 0.5 s outside → exact), and widening cascaded into `E_LIMIT`, failing even `soundDesign.place` of a
   filled cue; curved parts are now rebuilt adaptively (≈ 0.001 dB, ≥ 1 ms apart), cue edits and placement skip a
   too-dense lane with `W_MIX_SKIPPED` (explicit apply still refuses `E_LIMIT`). Curved-lane property (300 runs).
3. **Splitting a music clip** orphaned its dip / filter on the right part (stayed at −24 dB after clearing): records
   follow `splitClipAt` (razor, ripple, multicam, caption and time-remap splits go through it).
4. **A duplicated sequence** dropped `soundDesign.mix` but kept the keys, so its dips could not be removed: records are
   remapped onto the copy; repair renames `mix.cues` with re-identified cues and prunes stale records.
5. **Locked music track**: moving a realised cue over it failed `soundCue.update` with `E_TRACK_LOCKED`; now skipped
   (`W_MIX_SKIPPED`); a cue deleted while its dip sits on a locked track leaves `mix.orphans`, removed exactly on unlock.
6. **Delivery changed default SFX gains on locked tracks** (−2 → −11 dB): skipped and reported (`levelsSkipped`).
7. **A build on music ending before the hero swept down** at the clip end (20 Hz forced): only rest points rest now
   (> 500 Hz at the end).
8. **Mute / unmute restores the mix exactly** (the WP4.2a limit is gone): muting keeps a suspended record (no writes);
   unmuting writes it again with its options (ambience kept; unfilled cues too). Test: mute → the lanes from before the
   realisation, unmute → the realised lanes (deep-equal up to fresh ids), undo / redo of both. The Cue Seam, Essential
   Sound and the delivery's re-dip read a suspended record as not written (`cueMixWritten`).
9. **Auto gain on** after a hand change did nothing (owner stayed `user`): the gain returns to the recorded level;
   clips without one are reported skipped.
10. **Track build keys at negative times** near the sequence start: clipped at 0.
11. **Room glue exactness**: `removeBus` leaves the document as it was before `ensureBus`; only sends that still target
    the bus are removed; running `ensureBus` again keeps hand-tuned send levels (−9 dB stayed −9, was reset to −16).
12. **Ducking depth vs the 8 LU rule** (decision): Auto-Match already puts music 8 LU and ambience 10 LU under the voice;
    the default Ducking amounts (−15 / −10 dB) then put the music ≈ 23 LU under it. A clip whose Ducking amount is still
    its type default is now ducked 6 dB by the delivery (written into its Ducking, `depthBy: 'delivery'`); an amount
    the user set is kept. Measured in the real run below: **14.13 LU** under the voice during speech (the engine's
    report and the exported stems agree to 0.01 LU). The 8 / 10 LU minimums are spec 12's; EBU R 128 and AES TD1008
    set programme loudness and give no music-under-voice ratio; 6 dB is our choice (undocumented in Adobe terms).
13. `soundDesign.applyGains` silently cleared Auto gain off (`manual`) when an agent named the clip: such clips are now
    skipped and listed unless `override: true` (the engine's rebalance passes it only for clips the user named or
    `userGains: 'replace'`). The setAutoGain refusal had no message template (`sound-messages.test.ts` failed on the
    integration branch): added, with Spanish.

Engine (`feat/sd-p4v-engine`):

- **CONFLICT could never be produced**: a stale revision failed rebalance / delivery with `E_REVISION_MISMATCH`, not
  retryable; and **bed edits during a job were fast-forwarded** (only the gain clips are diffed): gains solved against
  the old bed were applied. Now the job re-reads the edit before applying; if the mix fingerprint or the delivery
  changed it applies nothing and fails with a retryable `CONFLICT`; the transaction carries the checked revision
  (`apply-guard.ts`; tests raise the music during the measurement and edit the hero between check and apply; mutation:
  without the check the job succeeded). Limit: an edit landing in the milliseconds between the re-read and the
  transaction that touches no gain clip is still fast-forwarded.
- **Plan previews used random ids**: warnings and `conflicts[].clipId` named clips that never exist and every cache
  key missed. Previews are seeded; reports name the item / layer ref (`$sfx_<n>_<layer>`) and `itemId`; caches are keyed
  by content with ids renamed in order of appearance (a second identical plan renders nothing; a rebalance right after
  accept renders at most one sound).
- **A stale bed after relinking offline media** (the silent bed stayed cached): media online state is in the key.
- **Solver output now reaches users**: `apply_delivery` reports conflicts and the solver's warnings, gain items carry
  `limitedBy`; the plan keeps the alternatives' warnings and gives extra layers their levels; MCP descriptions and
  SOUND_GUIDE match; the web shows them (below).
- **The plan's delivery item was measured before the plan's own sounds** (its stored analysis read −16.9 LUFS for a mix
  that was not the final one): the plan now measures the final preview (chosen sounds at their solved gains, room,
  dips, build) and stores that. Test: the stored −16.995 LUFS equals a fresh measurement of the accepted document;
  and, with the fingerprint fix below, its `mixHash` equals the accepted document's (asserted).
- Solo tails cover every effect with a tail (reverbs, convolution, delays by their feedback, flanger) and the Mix's own
  inserts (`sound-design-tail.test.ts`).

Fingerprint (lead): `mixFingerprint` now ignores entity ids and names (ids renamed in order of first appearance, clips
ordered by track and position): the same mix built with other ids — an accepted plan measured on its seeded preview, a
re-applied realisation — is current (`audio-mix.test.ts`: two documents built with different id sources hash the same;
swapping which media plays where, or a send level, changes it). Consumers checked: the Loudness dialog's staleness
(web), MCP `analysisCurrent`, the engine analysis writer, the delivery analysis, the apply guard, speech transcription
(dedupe key and attach check), `SoundCheckSummary.mixHash` (unused yet); not the export planner (exports always
re-measure) nor proposal `docHash` nor any render cache (the engine's bed caches use their own keys). Effect: an
analysis stored by an earlier build of this branch reads stale once (re-measured on demand), and a transcription that
finished before the upgrade and is attached after it is refused with the existing message (transcribe again).

Solver wording (lead): a sound over a silent bed said "its default level already clears the bed by +86.7 dB" (a lift
over the measurement floor); it now says "nothing plays under it in the bed" (`SILENT_BED_LIFT_DB` = 60 dB); the
dialogue advice named non-speech octaves ("(8000 Hz, 4000 Hz) is in 1–4 kHz"): only the speech octaves are named.

Web (`feat/sd-p4v-web`): the Room / Stop / Build rows act on the whole selection — Room names every track that can
send ("Send A2, A3 to the SFX Room"), is indeterminate (`aria-checked="mixed"`) while their sends differ, lists each
track's state and the skipped ones with their reason, and one gesture is one History entry; Stop / Build act on the
cue when every selected sound fills the same cue, otherwise show the state across those cues, disabled, with the cue
timecodes (length and depth belong to each cue). The Auto gain line shows a range across the selection. Solver notes:
the Rebalance toast gives counts and the most important note with a **Solver Notes…** list (conflicts in words, e.g.
"Click at 00:00:04:10: its repeats (±2 dB) kept over dialogue", dialogue-band advice, `W_UNRESOLVED` first); Delivery
Target… translates its warnings; Auto Sound Pass… lists the plan's notes after Propose. Screenshots looked at:
`/var/lib/orquester/tmp/p4-verify/web/` (not committed).

fframes refusal (WP4.2b limit): not a bug. The native planner needs the jasper-mg master for an fframes graphic
(`apps/engine/src/export/planner.ts`; preview draws the TypeScript twin, Remotion / `auto` exports render it); the
worktrees had no `native/mg/target/release/jasper-mg` (`pnpm build` does not build it and `E2E_SKIP_BUILD=1` skips
`scripts/mg-build.mjs`). With `pnpm mg:build` (7 min here) the native export renders it: `e2e/sound-mix.spec.ts` now
keeps the fixture's graphic when `/api/capabilities` says fframes is ready, and annotates why when not.

#### Performance (the plan job)

Profiled by stage (`JASPER_SD_TIMING`): the first plan with every style option was dominated by solo renders (69, each
a decode + mixer run on the engine's main thread), registration (25 sounds, sequential, 75–100 ffmpeg spawns on every
run), the delivery's three whole-sequence renders (whose analysis was then wrong) and previews rebuilt from scratch.
Changes: content-keyed caches, deduplicated solo renders, `audibleClips` in the mixer (strips no audible clip reaches
are skipped; exact because every one of the 60 effects maps silence to silence, `silence-in-silence-out.test.ts`),
no loudness meter where unused, clip loudness three at a time and cached, registration three at a time with
probe / padded copy remembered, previews sharing the documents up to the first differing item, and the delivery
measured once on the final preview. Measured back to back on the same host (helper branch, before at load 24–51 /
after at load 19–37): `sound-design-plan-levels.test.ts` 104.7 → 67.3 s (plans 2 and 3: 15.3 / 12.2 → 2.8 / 3.0 s);
`sound-design-plan-mix.test.ts` 134.2 → 102.3 s (first plan 34.5 → 29.0 s, plans 2 / 3 16.6 / 13.8 → 5.3 / 2.6 s); at
load 57–77 / 60–70 (not back to back) the first plan 90.8 → 39.1 s. The real run below: the first plan with every style
option **13.4 s and 18.8 s at load ≈ 18–21** (WP4.2a: 78 s at load ≈ 95; WP4.2b noted 966 s at load ≈ 140). What
remains of a first plan (29 s at load ≈ 30): solo renders 14.3 s (≈ 69 distinct: alternatives differ in sound, rate,
pan), final-mix measurement 4.7 s, registration 2.9 s. Not done: moving the mixer into worker threads (a large change).
Budgets unchanged: plan-levels ≤ 45 s passed every run; the 2000-event solver's 50 ms minimum is unchanged and still
load-sensitive (64.6 ms once at load ≈ 50).

#### Real app and agent runs (measured)

- **MCP**, built from this branch (a scratch stdio client, `jasper-mcp` from source, dev engine on 50801 with
  `JASPER_APPDIR=.stage`, the 212-sound library; the Phase 2 fixture with its fframes graphic + 10 s pink-noise music
  on A1 + dialogue 4–8 s on A2): `plan_sound_design {style: {seed: 2026, roomGlue, stopBefore, build, delivery: 'web'}}`
  → 17 placements + `room` + `delivery` + `stop:013` / `build:013` on the hero (the "sfx: boom+swoosh" marker at
  00:00:08:10), 13.4 s; accepted with the editor key (200, one transaction); `rebalance_sfx {mode: 'apply'}` right
  after: 18 solved, **0 changed** (the plan's and the rebalance's solves agree), no transaction; `apply_delivery {web,
  apply}`: Auto-Match dialogue +2.9 dB, music +5.8 dB, one ducked group; report: mix −16.47 LUFS / −3.73 dBTP before
  normalisation, expected −14 / −1.25, speech 4.3 s, music 14.13 LU under the voice. **Exports** (ProRes 422 HQ + PCM,
  native, measured by ffmpeg / numpy, `p4v-measure.py`): the mix **−14.0 LUFS integrated, −1.3 dBTP** (LRA 16.7);
  stems with the Mix normalisation off — voice −14.34 LUFS and music −28.46 LUFS over the speech frames: **14.13 LU**;
  the stop-before floor **−23.3 dB** under the music 0.6 s before it (both inside the duck) and +6.6 dB after the hero
  (duck released); the build: spectral centroid 3 487 Hz before → 4 731, 5 188, 6 137, 6 535, 7 395, 7 804 Hz across
  the 2 s (rising), full band back at the hero; room return (mix − mix without the room) −47.5 dBFS RMS over 1.5 s
  after the hero, −49.9 dBFS from 0.8 to 1.5 s (the tail). Looked at: spectrograms and waveforms of the mix and the
  music stem from T − 3 s to T + 1.5 s — the syllables until 8.0 s over the ducked music, the low end fading from
  6.33 s with the cut edge climbing, the ≈ 24 dB band-wide dip from ≈ 8.06 s, the full band and the hit at 8.33 s.
  Files (generated media, not committed): `/var/lib/orquester/tmp/p4-verify/run/`.
- **E2E**, every sound spec (`pnpm build` + `pnpm mg:build`, then `E2E_PORT=50807 E2E_SKIP_BUILD=1 pnpm exec playwright test
  e2e/sound-*.spec.ts`; 21 tests, 50.6 min at load 23–45): 18 passed, 3 failed — `sound-mix`: the Auto Sound Pass
  dialog now stays open listing the plan's notes (new behaviour: the spec reads them and closes it), and a warning toast
  with solver notes stays until dismissed and covered the Export button (the spec dismisses every toast); `sound-p3-mcp`:
  a bright, varispeed pick correlated 0.86–0.92 with its source on the AAC export although its peak was exact (lag 0;
  measured residual within 1 dB of the signal above 16 kHz, 7 dB under it at 8–12 kHz: the codec), so the spec now
  exports PCM (ProRes master) — the same pick passes there; `sound-p0-transport` "first samples" (the documented
  real-time check, disturbed at load ≈ 43). On the final build: `sound-mix` + `sound-p3-mcp` in one engine **2 passed**
  (1.8 min, load 5–9): the fixture with its fframes graphic, plan notes named ("Pneumatic whoosh at 00;00;06;00: its
  energy is in the speech band (1–4 kHz) while someone speaks; move it or pick a sound whose energy is outside 1–4 kHz,
  e.g. boom, hit, thump"), Delivery Target… "Export: −14.0 LUFS, −1.2 dBTP · Music under the voice: 14.1 LU (at least
  8)", native export **−14.1 LUFS / −1.7 dBTP** (ffmpeg); `sound-p0-transport` + `sound-p0-preview` **10 passed** (load
  5–8). Screenshots looked at (`test-results/e2e-sound-mix/`): the plan-notes dialog, review, Essential Sound, Room Glue…,
  Delivery Target….

#### Gate (measured, this branch; shared host, 16 cores)

- Before (integration tip 6ab79253, `p4-baseline` worktree, load 60–70): `pnpm lint` and `pnpm typecheck` pass;
  `pnpm test` 32 failed / 6 324 passed in 86.8 min — 31 tests over their time limits or budgets (engine routes at their
  5 s default, plan-levels 92.8 s > 45 s, the 5 000-sound ranking, camera tracking…) and one real failure,
  `sound-messages.test.ts` (the setAutoGain refusal had no template; fixed here); `pnpm notices --check` current.
- After the helper branches (load 8 → 64): lint, typecheck pass; `pnpm test` 22 failed / 6 506 passed in 43.5 min: 21
  engine / interchange tests over their 5 s or hook limits — rerun with `--maxWorkers=2` at load ≈ 40: 14 files 109
  passed, the 7 video-heavy files 48 passed (4 skipped) — and one real: the new curved-lane property's own window model
  (dips sorted by start merged [1299, 1301] with [917, 1703] ms; fixed, its counterexample kept as an example).
- **Final** (after merging the integration branch with Phase 5 WP5.1, the e2e fixes; load 4 → 17 during the run):
  `pnpm verify`: lint pass, typecheck pass, **`pnpm test` 6 622 passed, 1 failed, 385 skipped (688 files, 22.8 min)** —
  the failure is `gaps-avc3-playback.test.ts` "plays in Electron with every frame" (44 of ≥ 45 frames seen in real-time
  playback); run alone at load ≈ 15: 2 passed. `pnpm build` pass; `pnpm notices --check`: current (150 packages, 31
  ported records). The plan-levels ≤ 45 s budget and the 2000-event solver budget passed inside both full runs.
- After merging the integration branch once more (the SFX tail fix, f86eb4a9; one conflict in sound registration: the
  padded-copy memo now keys on the trailing pad too): `pnpm lint`, `pnpm typecheck`, `pnpm build` pass; every sound test
  file (`apps/engine/test/sound*`, `packages/project/test/sound*`, `apps/mcp/test/sound*`, masking, the mix models, the
  Phase 4 oracle): 60 files, 559 passed; proposals, fuzz, audio-mix, i18n, Auto Sound Pass, README tools and every
  `packages/compositions/test/audio-*` file: 20 files, 174 passed (load 5–12); e2e `sound-mix`, `sound-p3-mcp`,
  `sound-review` on that build: 4 passed (2.9 min), export −14.1 LUFS / −2.0 dBTP, MCP peaks r ≥ 0.996 at 0 / −1 / +1
  sample.
- Not explained: `sound-mix.test.ts` "mergeDips (property)" (WP4.2a's, linear / hold keys) failed once in a targeted run
  after the Phase 5 merge; its seed was not captured, and 6 × 300 + 8 000 + 3 × 40 000 further runs did not reproduce it.

#### Limits (after this pass)

- The solver's model: SFX do not mask each other and headroom is the last (weakest) constraint, so overlapping events
  can sum over the ceiling before the master (Sound Check's true-peak check and the delivery limiter are the net).
- The preview follows gain and effect-parameter automation sample by sample; pan (clip pan, strip pan, the 5.1 puck)
  is still evaluated per frame with the 8 ms glide (the placement's keyframed whoosh pans, Phase 2). The oracle renders
  offline; in the live player the curve starts from the time the sync anchor gives, so a late frame callback no longer
  shifts it, and without the anchor (no Remotion sync) the picture time is used as before.
- Dips and builds follow cue edits, splits, sequence duplicates, mute / unmute and locks, not clips duplicated, pasted or
  nested by hand (their keys stay ordinary keyframes); a dip on a track lane stays where it was when the music moves.
- Rebalance / delivery: an edit landing in the milliseconds between the job's re-read and its transaction that touches
  no gain clip is fast-forwarded.
- The mixer renders on the engine's main thread: a first plan's ≈ 69 distinct solo renders are most of its time.
- `mixFingerprint` changed again (ids and names left out): analyses stored by earlier builds of this branch read stale
  once; a transcription finished before the upgrade and attached after it is refused (transcribe again).
- No schema bump (Phase 4 unreleased; new fields optional; an older build of this branch reads a muted cue's suspended
  record as written).
- A warning toast with solver notes stays until dismissed (as every warning toast).
- `e2e/sound-p0-transport.spec.ts` "first samples" and `gaps-avc3-playback` stay real-time checks that a loaded host can
  disturb.

Scratch scripts (not committed): `/var/lib/orquester/tmp/p4-verify/p4v-run.local.ts` (copy into `apps/mcp/` to run;
the MCP run above), `p4v-measure.py` (the measurements).

## Phase 5: Sound Check

### Phase 5 → WP5.1 Sound Check engine & MCP

Scope: spec 12 §2.6 (every check and code, report, listen[5], curves, staleness, visuals), §2.8 (`POST
/api/sound-design/check` job `sound-check`, `POST /api/sound-design/visual`), §2.10 (`sound_check`, `view_sound_timeline`),
P5-R1, P5-R2, P5-R4. The web panel is WP5.2 (API below).

Files: `packages/audio-fx/src/analysis/check-curves.ts` (`CurveMeter`, `loudnessCurve`, `maxPool`, `locateByCorrelation`),
`masking.ts` (+ `evaluateSfxGain`); `packages/project/src/sound/check.ts` (codes, severities, tolerances, thresholds,
verdict, counts, `soundCheckInputsHash`, `soundCheckStatus`, message templates), `schema/sound.ts` (summary fields,
`settings.credits`), `commands/schemas|handlers/sound.ts` (`soundDesign.setCheck`, `setSettings.credits`), `catalog.ts`
("Sound Check Result"), `sound/messages.ts` (the templates are model strings); `packages/api/src/sound-check.ts`,
`routes.ts` (`soundDesignCheck`, `soundDesignVisual`), `jobs.ts` (`sound-check`); `packages/engine-client` (`soundCheck`,
`soundVisual`); `apps/engine/src/sound-design/{check,stems,visual}.ts`, `routes/sound-design.ts`, `sounds/decode.ts`
(`readPlanar` exported); `apps/mcp/src/tools/sound-check.ts`, `sound-timeline.ts`, `server.ts`, `tools/sound.ts`
(SOUND_GUIDE "Check"), `examples.ts`; README (349 tools, HTTP section), security review (2 route rows, a paragraph),
i18n data (`apps/web/src/i18n/{model-strings,en,es}.json`: 48 strings). Tests: `packages/audio-fx/test/check-curves.test.ts`,
`packages/project/test/sound-check.test.ts`, `fuzz.test.ts` (AC-25 draws setCheck / credits), `apps/engine/test/
sound-check.test.ts`, `sound-check-stems.test.ts`, `sound-check-fixture.ts`, `apps/mcp/test/sound-check.test.ts`,
`sound-examples.test.ts` (+1).

#### How it works

1. **One pass, every stem** (`stems.ts`). One `OfflineMixer` per stem — the mix, sound effects (`isSfxClip`), dialogue,
   music, ambience (Essential Sound types) and the bed (everything that is not a sound effect) — rendered in lock-step
   over the range in 48 000-sample blocks. A clip several stems play is decoded ONCE: its ffmpeg reader is shared
   (`SharedDecoders`; each mixer gets a `TeeReader` over a buffer that keeps 3 blocks behind the newest sample and is
   swept after every block — a short clip read and closed within one mixer's block is still there for the next stem).
   Each stem plays only its clips like `renderMixdown({onlyClips})`; the output layout is the export's default (stereo,
   5.1 for a 5.1 Mix). Pre-roll 2 s (short-term window, K-weighting warm-up), post-roll 1.5 s.
2. **Delivered as the export does.** The mix over the range goes to the BS.1770 meter and, when the Mix normalises, to a
   scratch float file; a second pass applies `target − integrated` and the `TruePeakLimiter` with `renderMixdown`'s
   parameters (5 ms look-ahead, 100 ms release), recording its gain reduction per 10 ms. Stems are shown on the delivered
   scale (+ the normalisation gain).
3. **10 ms curves** (`CurveMeter`): per hop the K-weighted channel-weighted energy, the mean square (dBFS) and the sample
   peak; `loudnessCurve` gives momentary (400 ms) and short-term (3 s) loudness of windows CENTRED on each hop (where an
   event is, not 200 ms / 1.5 s after it).
4. **Speech**: transcript words (`sequenceWords`) ∪ voice activity of the dialogue stem (10 ms levels ≥ max(`vadThreshold`,
   −50 dBFS), the same rule as the bed render), gaps < 0.3 s bridged.
5. **Sound effects against the bed** with the solver's own measurements (`measureSfxEvents`: the bed per cue cluster, each
   sound alone at 0 dB; its caches are shared with rebalance / plan) and definitions: `evaluateSfxGain` (new, exported
   from `masking.ts`) computes the dominant-band lift, the peak over the bed reference (local bed peak, never under
   programme −12 LU) and the speech-band lift exactly as `solveSfxGains` does (property: equal at the solved gains).
6. **Sync**: each placed clip filling a cue (two-way link) — the sound file decoded around its aligned point
   (`placement.peakFlicks`; peak 50 ms before / 200 ms after, start 0 / 250 ms, end 250 / 0 ms) at the clip's speed
   (resampled to sr / rate), located in the SFX stem captured around the cue by normalised cross-correlation (FFT,
   parabolic sub-sample refinement), lags within ±3 frames (+10 ms) of the cue (spec). Offset = where the aligned point
   plays − the cue, in ms. Correlation < 0.3 = not found there.
7. Then the document checks, the per-event table, listen-here, verdict, curves (≤ 1 200 max-pooled points).

#### Checks (decisions where the spec gives no number)

| Code | Finding | Severity | Fix |
|---|---|---|---|
| LOUDNESS | integrated of the delivered mix outside preset ±1 LU; under 0.4 s audible (10 ms hops over −70 dBFS) → "cannot be measured"; silent → "silent" (never a pass) | error for R128 / A/85, warning for web / podcast; not measurable: warning | `mixer.setLoudness {enabled, preset target, ceiling}` (commands, safe) when the Mix does not already normalise there |
| TRUE_PEAK | delivered true peak > ceiling + 0.1 dB | error | same as LOUDNESS (safe) |
| OUT_OF_SYNC | the clip ends < 20 ms after its aligned point while its sound goes on ("is cut … the sound it is placed for does not play"; found by the real run, below); or the offset beyond the cue kind's tolerance: cut ±1, land ±2, move ±3, appear ±1 frame (spec); transition / emphasis / reveal ±2, exit / beat / manual ±1 (decision); +0.5 ms float slack | error | cut: `clip.trim {edge: out, deltaFrames}` (safe) only when the dry-run really lengthens the clip (it is clamped where the media ends inside the next frame: then no fix, `measured.cause` says why). Offset: the clip moved off its placement: `soundDesign.swap {clipId, mediaId, frame: cue}` = MCP `align_peak {to: 'cue', withLayers: false}` (safe, dry-run). Measured off although the document says aligned: no fix (a renderer problem, reported as such). Not found in the stem: judged by the document; not measurable (muted track, reversed, offline): info |
| MASKED | lift < 1.5 dB support / 3 dB hero (spec; ambient beds and the layers of a cue are not checked: decision — a layer thickens its cue's first layer) | warning | `soundDesign.applyGains` at the solver's gain (all events solved together), safe when that gain reaches the minimum and the gain is not the user's |
| OVERLOAD | a sound > bed cap + 0.5 LU (hero 10, support 6); the export limiter > 3 dB; normalisation off and sample peak ≥ 0 dBFS | warning / warning / error | the solver gain (safe if under the cap) / `rebalance_sfx` job (not safe: listen) / setLoudness (safe) |
| MUSIC_OVER_VOICE | per speech segment ≥ 0.5 s: energy mean of the dialogue and music momentary curves over voiced hops (delivery's measure) under < 8 LU; reports whether the music is ducked | warning | not ducked: the delivery job with `{loudness: false, autoMatch: false, rebalance: false}` (ducking only), safe when under + the clip's duck depth ≥ 8 LU; ducked already: the delivery with Auto-Match (not safe) |
| SILENCE | ≥ 0.5 s under −60 dBFS (10 ms mean square of the delivered mix), not covered by a silence cue's window (or within 0.5 s after an unwindowed one) | warning | `soundCue.add` a silence cue over it (not safe: only if intended) |
| DIP | the centred short-term loudness falls > 10 LU under its maximum of the previous 3 s and comes back ≥ 6 LU within 6 s, with no stop-before window, video cut (V-track clip edge) or silence cue in the drop, and not inside a SILENCE run (decision: a drop that never recovers is an ending) | warning | silence cue (not safe) |
| STALE_CUE | anchored cue: `resolveCueAnchor` ≠ cue frame; or the anchor no longer resolves | warning | `soundCue.resync {cueIds}` (safe, dry-run) / `soundCue.remove {withClips}` (not safe) |
| NO_PICTURE_EVENT | a `derived` cue (not beat / silence) without an anchor that resolves on it, no derived event (`deriveCues` all sources, rich, ±2 frames) and no motion speed change ≥ 0.05 diag/s within ±2 frames | warning | remove the cue and its sounds (not safe) |
| DENSITY | filled heroes closer than the density's hero spacing (1.5 / 2 / 3 s) or 0.5 s; more filled cues in 1 s than the budget (interface types ui/click/key/tick excluded: patterns) | warning / info | `soundCue.update {weight: support}` + `soundDesign.setRole {support}` on the later hero (safe) / none |
| REPEAT | consecutive sound events (first layer of each cue, unlinked SFX) with the same sound or media | warning (info for interface types) | the clip's alternatives first (a registered one: `soundDesign.swap` commands; else a `swap` fix = `swap_sound`), safe; else a library sound by similarity (not safe) |
| LICENSE | a clip of a library sound that is not commercial-safe: NC, ND, unknown → error; user-provided → warning | | a commercial-safe alternative (safe) or a similar commercial-safe library sound (not safe) |
| CREDITS | commercial-safe sounds needing attribution (CC-BY…) and `settings.credits` not set | warning | `soundDesign.setSettings {credits: 'md'}` (safe) |

Every command fix is dry-run on a copy of the document (`applyTransaction`) and only offered when it applies.
**`settings.credits`** is new (decision): the spec's "no credits export configured" needs something to configure before
Phase 6's `ExportSettings.credits`; P6 should default the export dialog's credits option from it.

#### API for WP5.2 (the panel)

- Run: `engine.soundCheck({projectId, sequenceId?, preset?, range?, store?})` → job `sound-check` (Jobs panel, progress
  stages); result `SoundCheckResult {projectId, sequenceId, stored, revision, report}` (`@jasper/api` schemas). The editor's
  call with `store: true` writes the summary as the user's own edit ("Sound Check Result", one undo step).
- `report`: `verdict`, `counts` (per code and severity), `issues[]` `{id, code, severity, category (loudness | sync |
  mix | cues | licence: group by it), frame?, timecode?, range?, clipIds?, cueId?, message {key, params, text}, measured,
  fix?}`; translate with `t(message.key)` filled with `params` (keys are model strings; es.json has them). `fix {kind,
  label (message), safe, why?, tool, args, commands? | job {route: rebalance | delivery, body} | swap {clipId, soundId}}`:
  commands → ONE transaction; job → `engine.rebalanceSfx(body)` / `engine.applyDelivery(body)`; swap → register the
  sound and `soundDesign.swap` (the panel's variation / Swap code path). "Fix all safe" = every `fix.safe`, then run again.
- `events[]`: the per-event table (offsetMs, toleranceFrames, located, correlation, liftDb / minLiftDb / targetLiftDb,
  peakOverBedLu, status, codes). Sync rows: `located`, `offsetMs`.
- `listen[]`: `{slot: worst | hero | loudest | densest | passing, frame, timecode, seconds, why (message), issueId?,
  clipId?, cueId?}` (≤ 5; absent slots when nothing qualifies, e.g. no failure → no "worst").
- `loudness` (delivered integrated / TP / LRA / max momentary / short-term, `measurable`, normalisation and its gain,
  limiter max GR, before normalisation), `curves` (momentary LUFS per stem + limiter GR, ≤ 1 200 points, `hopSec`,
  `startSec`), `speech`, `stems`, `warnings`, `timings`.
- Staleness: `soundCheckStatus(doc, sequenceId)` → `{state: none | current | stale, summary, reasons: mix | inputs |
  preset}`; summary in `seq.soundDesign.lastCheck` (`mixHash`, `inputsHash`, `verdict`, `counts`, `at`, `preset`, `jobId`,
  `range?`). Fetch the full report with `getJob(summary.jobId)` while the job is kept.
- Drawing: `engine.soundVisual({projectId, sequenceId?, range (≤ 120 s), checkJobId?})` → 10 ms `curves.{mix, bed, sfx,
  music, dialogue, ambience}.{momentary, shortTerm}`, `waveformPeakDb`, `motion {startFrame, speed[]}`, `cues`, `clips`
  (aligned frames), `speech`, `issues` (of the job), `normalization {applied, gainDb, reason?}`.

#### MCP

- `sound_check` (EDIT_IDEMPOTENT: it runs a job and, with `store: true`, writes the summary; decision — annotations are
  static, so the tool that may edit is not read-only): `{projectId, sequenceId?, preset?, range?, store?, images?
  (default true), timeoutSeconds?}` → `verdict`, `counts`, `loudness`, `listen` (lines "HH:MM:SS:FF — why", to give
  verbatim), `findings` (one line each with its fix and whether it is safe), `issues` (with fix tool + args), `table`,
  `speech`, `stems`, `stored`, `next`; one PNG of up to three worst moments (±2 s each, `view_sound_timeline` strips
  stacked).
- `view_sound_timeline` (READ_ONLY): `{projectId, sequenceId?, range (≤ 120 s), checkJobId?, width?}` → one PNG (curves on a
  −60…0 LUFS scale, speech shading, waveform, SFX clips with aligned points, cue ticks, motion, findings, timecode axis,
  legend) + `cells` (lane geometry, each cue's / finding's x pixel, each stem's loudest value).
- SOUND_GUIDE "Check": after applying, run sound_check, apply only fixes marked safe, give the listen-here timecodes
  verbatim, never claim it sounds good.

#### Verified (measured, this branch; shared host, 16 cores)

- `pnpm vitest run packages/audio-fx/test/check-curves.test.ts`: 9 passed — `CurveMeter` identical for blocks of 1, 7, 480,
  4096 samples; a −20 dBFS sine reads −20 dB; momentary / short-term curves equal `LoudnessMeter` (and `shortTermPeakLu`)
  within 0.05 LU in the steady state; `maxPool` keeps peaks; `locateByCorrelation` finds a decaying burst in noise at
  its exact offset (< 0.05 sample) at 4 positions, stays in its lag range, null for silence, a 300-run fast-check of
  hostile input never throws; `evaluateSfxGain` equals the solver's achieved lift, peak over bed, true peak, speech lift
  and dominant bands at the solved gains; 300 hostile runs never throw.
- `pnpm vitest run packages/project/test/sound-check.test.ts`: 8 passed (store / clear / undo = untouched document / redo;
  staleness by mix, cues, Mix loudness target, preset, credits, none without an inputs hash; 11 refusals; credits setting;
  load keeps both, repair drops a damaged summary and an unknown credits format, idempotent; verdict, counts, the spec's
  tolerances and codes, every template fills). `fuzz.test.ts` (AC-25, 2 000 runs with setCheck / credits drawn, > RUNS /
  100 accepted): passed. `sound-messages.test.ts` fails on the integration branch already (a `setAutoGain` refusal
  without a template; fixed on `feat/sd-p4v-model`, not merged yet): not from this package.
- `apps/engine/test/sound-check-stems.test.ts`: 2 passed — every stem of `renderStems` (mix, sfx, dialogue, music, bed;
  0.5 … 9.5 s, starts inside blocks) is **sample-identical** (max difference 0) to `renderMixdown` of the same clips, and
  5 clips need 5 decoders although the mix, their stem and the bed all play them (the first version decoded short clips
  twice and fed zeros to a stem: the test found it); the check's delivered loudness equals `renderMixdown({normalize})`
  (integrated, true peak, gain, before) within 0.01.
- `apps/engine/test/sound-check.test.ts` (real engine, generated media): 16 passed. The clean fixture passes (no
  warnings; −14 ±1 LUFS delivered, TP ≤ −0.95; three sounds found at < 2 ms from their cues; stems, speech 2.5–4.5 s,
  curves, four listen slots; `store` = revision + 1, `soundCheckStatus` current, a gain change → stale `mix`; the visual
  route's 400 points, motion, cues, aligned frames, the hit ≥ 20 LU over the SFX curve's floor). **Seeded defects (P5-R4)**
  each found with its code and resolved by applying its fix exactly as reported, then re-checked: a hit 2 frames late on
  a cut → OUT_OF_SYNC +66.7 ms (± 2 ms), safe align fix → pass; a click cut at its peak → OUT_OF_SYNC "cut", safe trim; a
  support under +14 dB music → MASKED, safe solver gain; 0.8 s of digital silence → SILENCE (0.7–0.9 s at frames 53–57),
  silence cue; music ≈ 3 LU under the voice (measured 1.5–4.5) → MUSIC_OVER_VOICE, safe ducking job; true peak −0.2 dBTP
  (normalisation off, calibrated) → TRUE_PEAK error, safe `mixer.setLoudness` → TP ≤ −0.95, no LOUDNESS; 0.2 s of media
  → "cannot be measured", verdict warn; an empty sequence → "silent", warn; a cue whose marker moved 6 frames →
  STALE_CUE, safe resync; the same hit back to back → REPEAT, safe swap to its registered alternative; heroes 1.5 s apart
  (balanced) → DENSITY, safe demotion; CC-BY-NC click → LICENSE error, safe swap to a CC0-class alternative; user-provided
  → LICENSE warning; CC-BY sound → CREDITS, safe credits setting; a derived cue with nothing on screen → NO_PICTURE_EVENT;
  typed refusals (9). **Time per check** (`sound check timings`, load 8): clean fixture (10 s, 3 sounds) **1.2 s**, the
  others 0.4–5.1 s; the same suite at load ≈ 50: clean 15.1–18.5 s, the others 2–19.5 s (all under 30 s).
- `apps/engine/test/{security-review,fuzz-http,server}.test.ts` with the check suite: 4 files, 222 passed.
- `apps/mcp/test/sound-check.test.ts` (jasper-mcp over stdio, real engine): a hit nudged 2 frames on a cut → `fail`,
  OUT_OF_SYNC at 00:00:01:00, +66.7 ms, fix `align_peak` safe; listen[0] "00:00:01:00 — Worst finding: …"; ONE PNG ≥ 900 px
  that decodes; the safe fixes applied as given (tool + args) → `pass`, stored, `soundCheckStatus` current;
  `view_sound_timeline` with the first job: cues [30, 90], the OUT_OF_SYNC flag, 6 lanes, a 1200 px PNG; strict arguments
  (`E_UNKNOWN_ARGUMENT`, bad preset), RANGE_TOO_LONG (130 s), RANGE_EMPTY. `readme-tools`, `conventions`, `sound-guide`,
  `sound-examples` (setCheck example applies), `apps/web/test/i18n.test.ts`, `node scripts/i18n.mjs --check` (9 618
  strings): pass.
- **Real run** (dev engine `JASPER_APPDIR=.stage … --port 50901`, the 212-sound library, a scratch jasper-mcp client over
  stdio — scripts and outputs in `/var/lib/orquester/tmp/p5-check-run/`, not committed): the Phase 4 fixture (Phase 2
  `FIXTURE_COMMANDS` + 14 s pink-noise music on A1 + dialogue 4–8 s on A2), `plan_sound_design {seed: 2026, delivery:
  web}` (17 cues) accepted as the editor, then the impact on the cut at 00:00:03:00 nudged 2 frames as a seeded defect.
  `sound_check`: **fail** in 28.8 s (load ≈ 24), MASKED 5, OUT_OF_SYNC 6 (5 errors, 1 info). The nudged impact: "+66.7 ms
  late on its cut cue", fix `align_peak` (safe) applied → gone on the re-check (16.1 s). Every other placed sound was
  located at **0 ms** from its cue. What remains is real and has no safe fix: (1) four typewriter ticks / clicks are
  **cut at their peak** — their clips are 1 frame long and end exactly on the aligned frame (a 85 ms padded sound peaking
  at 58 ms: whole-frame clips cannot reach past the media end, `clip.trim` clamps with W_DURATION_CLAMPED); verified by
  rendering one clip alone: it plays 7.121–7.133 s and stops at its peak (the first check version reported "−41.9 ms off"
  for it and offered a trim that changed nothing; both fixed: the cut is detected first and the trim is only offered when
  the dry-run lengthens the clip). (2) supports masked by the solver's own limits (consistency, hero-shadow, the dialogue
  guard under speech: −28 dB for clicks under the words) — what the solver reported when it placed them. The verdict
  stays **fail** honestly; re-check pass needs the registration fix below. Pictures looked at: `check-1.png` (two strips
  around 00:00:03:00 and 00:00:09:20: the nudged impact's flag, the hero tick, the masked swish), `timeline.png` / 
  `final-timeline.png` (14 s: music ducked under the speech, every SFX bump on its cue tick, motion around 1–2 s) and
  `final-zoom.png` (5.5–9 s: ticks ≈ 19 LU under the dialogue, "As delivered (normalisation +3.5 dB)" from the check
  job). The looks found two drawing faults, fixed: flag labels overlapped in dense passages (now skipped when they would
  touch) and speech drawn as syllable stripes (now bridged like the check).
- Gate on this branch (the integration branch had not moved): `pnpm typecheck` (every package) and `pnpm lint` (Biome,
  tokens, anime, layers, assets) pass; `pnpm notices --check` current; `node scripts/i18n.mjs --check` 9 618 strings.
  `pnpm vitest run packages/audio-fx packages/api packages/engine-client apps/web/test/i18n.test.ts
  apps/web/test/sound-i18n.test.tsx --maxWorkers=3`: 29 files, 390 passed. `pnpm vitest run --project @jasper/project
  --maxWorkers=3`: 1 992 of 1 993 passed — the one failure is the pre-existing `sound-messages` template gap above.
  `pnpm vitest run apps/mcp/test/sound* apps/mcp/test/{conventions,readme-tools,fuzz}.test.ts apps/engine/test/
  {sound-check,sound-check-stems,sound-design-cues,sound-design-rebalance,security-review,fuzz-http}.test.ts
  --maxWorkers=2` (load 35–60): 18 files, 638 passed.

#### Limits and notes for the next packages

- ~~**Upstream defect found (not fixed here; Phase 1/2 owners):** short library sounds whose peak lies in the last partial
  frame of the media are cut at their peak — registration pads the head (50 ms) but not the tail, and clips are whole
  frames inside the media. Padding the tail by one frame at the highest frame rate (or letting a clip's last frame run past
  the media end as silence) fixes it; Sound Check reports these clips as OUT_OF_SYNC "cut" without a fix.~~ Fixed: "Fix: SFX
  tail truncation" below (both remedies, and a safe Sound Check fix for older projects).
- Sync is searched within ±3 frames of the cue (spec); a larger offset is judged from the document (`measuredIn:
  'document'`). Two identical sounds within ±3 frames can be confused (the stronger correlation wins). A layer under
  another sound of its cue may be "not measurable" (info). Reversed clips are not measured. Maintain-pitch speed changes
  are decoded as varispeed for the reference (the timing is right; the correlation is lower).
- MASKED, OVERLOAD (bed) and their fixes use the solver's event model (each sound against the bed, not against other
  sound effects). The fix applies one clip's solved gain; consistency with its repeats follows on the next rebalance.
- DIP needs a recovery within 6 s (a drop that stays down is treated as an ending) and is explained by any video edit
  point in the drop. SILENCE / DIP use the delivered mix; a silence cue covers its window (or 0.5 s around an unwindowed one).
- NO_PICTURE_EVENT sees keyframed motion, edits, transitions, text, graphics and markers (`deriveCues`); footage motion
  needs P6's pixel analysis.
- LOUDNESS on a `range` is the loudness of that range (warning `W_RANGE`). The visual route adds the normalisation gain but
  not the limiter; its curves are 10 ms, the report's are max-pooled to 1 200 points.
- The summary's staleness ignores picture edits (a moved anchor shows on the next check as STALE_CUE).
- Messages carry the cue kind and the density as ids (`cut`, `balanced`) inside translated templates; WP5.2 may translate
  them with the cue-kind labels it already has.
- WP5.2 owns the panel, "Fix all safe", the listen-here markers and the Export dialog option; the API is above.


### Fix: SFX tail truncation

Branch `feat/sd-fix-sfx-tail`. The defect WP5.1's real run measured: short sounds placed by `soundDesign.place` were cut
at their peak.

#### Root cause (measured)

Registration padded 50 ms of silence in front of a sound only; `planSoundInsert` made the clip `⌊(media − sourceIn) /
rate / F⌋` whole frames. With the sub-frame rest taken out of the lead (`sourceIn = r`), the whole frames from the In
point end before the media does, and for a sound shorter than one frame after its peak they end exactly ON the peak: the
aligned frame is a frame boundary, so the clip covers `k` frames up to it plus `⌊(sound after the peak + rest) / F⌋ = 0`
more. Failing test first (`apps/engine/test/sound-tail.test.ts`, before any fix, commit `b9635b06`): at 23.976 / 29.97 /
30 / 60 fps, real folder sounds registered through `/api/sounds/:id/register`, placed on cues and rendered alone by the
engine's mixer — all four rate cases failed (and the registration case), e.g. "30 fps … worst difference 0.554 at source sample 51 of 960" (sample 51 =
the click's peak: everything after it was silence); at 60 fps the cut was later (sample 849 of 960) but still inside the
tail.

#### What changed

- **Registration pads the tail** (`apps/engine/src/sounds/pad.ts`, `service.ts`; `packages/project/src/sound/insert.ts`):
  `LIBRARY_TRAIL_SILENCE_SEC` = 50 ms (≥ one frame at 23.976 fps = 41.7 ms; room for +19 % speed), `ceil(0.05 · rate)`
  whole samples via `apad=pad_len=N` after the `adelay` lead, same bit-exact, deterministic `-bitexact` WAV (repeated
  registrations still dedupe; a copy made before the fix has another fingerprint). `libraryTrailSilenceSamples` pads a
  sound of ≤ 120 s whose quiet end — file length after its −60 dB tail (`peakSec + tailSec`) — is under 50 ms, or whose
  tail is unknown (the library analyses the first 30 s: a longer file is always padded). A sound that needs only the
  trail is now copied too (folder sounds included: before, a folder sound with a quiet head was registered in place even
  when it ended abruptly). Provenance: `trailSilenceSec` (new, optional), `descriptors.durationSec` = the copy's length
  (lead + sound + trail), `descriptors.tailSec` (new, optional; written only when the analysis covered the whole file).
  Schema stays v7 (optional fields; `readLibraryProvenance` repairs `trailSilenceSec` on its own, `libraryDescriptorIssue`
  refuses a tail past the end or a trail over the peak; `docs/project-files.md`).
- **Placement rounds up to the sound's end** (`planSoundInsert`, used by `soundDesign.place`, `soundDesign.swap`, the web
  insert / drag ghost and MCP `insert_sound`): `frames = max(⌊(end − sourceIn) / rate / F⌋, ⌈(faded − sourceIn) / rate /
  F⌉)`, `end` = the end of the sound in the file (before the trail), `faded` = its −60 dB point when the provenance knows
  it, else `end`. So no clip ends inside its sound, and none plays the trailing silence for its own sake (a riser aligned
  by its end still ends on its frame: MCP `insert_sound` test). `end` alignment uses the end of the sound, not of the
  trail (`peakAlignedStart` gained `endSec`). Media without room after the sound (copies registered before the fix,
  sounds over 120 s, project audio, a speed over +19 % at 23.976 fps) end less than one frame past their media — INV-005
  already allows one frame (`sourceIn + span ≤ media + F·rate`), both mixers play silence past the end (shared mixer
  "reads past the end return fewer frames", engine decode `apad`), and trim handles clamp at 0 (decision: that is the only
  way to never cut an unpadded sound; recorded in spec 12 §2.3). Placement results report `soundEndFlicks`.
- **Sound Check finds and fixes older clips** (`apps/engine/src/sound-design/check.ts`, `packages/project/src/sound/check.ts`):
  where a sound has faded is the provenance's tail, else the library entry's (moved by the copy's lead; copies made before
  the fix have no `tailSec`), else measured on the file (`measureTailEnd`: last sample within 60 dB of the file's sample
  peak, any channel, files ≤ 30 s). OUT_OF_SYNC "cut" (the clip ends < 20 ms after its aligned point) now uses that point
  instead of the end of the media; new code **TRUNCATED** (warning, category sync; spec 12 §2.6): the clip ends > 0.5 ms
  before the sound has faded while it runs to the last whole frame of its media — the frame grid cut it, not the user (a
  clip shortened with room left in its media is not reported). Fixes, the first that reaches the end in a dry run: (1)
  `clip.trim` out (as before); (2) **register the sound again and swap it in** — `fix {kind: 'swap', swap: {clipId,
  soundId: its own}, tool: 'swap_sound', args: {to: its own soundId}}`, safe; dry-run on a copy of the media as the engine
  will write it (media + trail, provenance with `trailSilenceSec`); the panel's swap path (`swapSounds`, which registers
  and swaps even for the same sound) and MCP `swap_sound` apply it; (3) `soundDesign.swap` on its own media (commands,
  safe): the clip is re-planned and runs to the end of its sound, past its media by under a frame. When none applies
  (`E_OVERLAP` with the next clip, a locked track) `measured.cause` says why. `libraryMedia` (REPEAT / LICENSE swaps)
  prefers a project copy with trailing silence over an older one of the same sound.
- **MCP `swap_sound` to the clip's own sound** re-registers it: allowed when the registered copy is another media (an
  old copy), refused `E_INVALID_PARAM` as before when the project's copy is current. Docs: `swap_sound`, `sound_check`
  (TRUNCATED), `insert_sound` / `import_sounds` (trailing silence), SOUND_GUIDE "Check" code list.
- **Fresh inserts use the padded copy**: every surface reuses project media by the engine's fingerprint match only
  (web `existingMediaFor`, MCP `importCommands`, plan job / proposal drafts), so registering the sound again gives the new
  copy as a new media; existing clips keep their old copy until swapped.
- Web: Properties ▸ Sound shows the sound's length without the trailing silence; the drag ghost's timing knows the
  library tail (`timingOf`), so the ghost is as long as the clip will be. i18n: 3 new model strings (en / es).

#### Placement paths checked

| Path | Goes through | Evidence |
|---|---|---|
| Sound Library insert / drag (web) | `soundDesign.place` (`planSoundInsert`) | `apps/web/test/sound-*` 188 passed; ghost timing |
| Fill, variation, Add Layer, Swap (web) | `soundDesign.place` / `soundDesign.swap` via `swapSounds` | same suites; swap of the same sound registers again |
| MCP `insert_sound`, `place_sound`, `swap_sound`, `align_peak` | `planSoundInsert` + `soundDesign.place` / `swap` | `apps/mcp/test/sound.test.ts` (riser end on its frame), `sound-cues.test.ts` (+ refresh test) |
| plan job → accept | proposal items of `soundDesign.place` | real run below: every click placed whole |
| rebalance (`soundDesign.applyGains`) | gain only | `packages/project/test/sound-tail.test.ts`: duration unchanged |
| resync (`soundCue.resync`) | moves by whole frames | same test: duration unchanged |

#### Verified (measured, this branch; shared host, 16 cores, load average 7–40)

- `pnpm vitest run apps/engine/test/sound-tail.test.ts --maxWorkers=2`: 8 passed. At 23.976 / 29.97 DF / 30 / 60 fps, four
  real folder sounds (20, 30, 40 ms clicks with no quiet end; one with an 80 ms quiet head and an abrupt end) registered by
  the route and placed by peak on cues, plus "tick 30" as a head-only copy (an existing project's media): the engine's
  mixer render equals each source **sample for sample over the whole sound** (worst difference < 1e-5 × peak, i.e. the
  float path; before the fix 0.554 at the peak). Registration: lead + trail 2 400 samples each, the abrupt-end sound copied
  (not in place) with the trail only, registering twice = same fingerprint. Sound Check on an existing project: the
  head-only copy cut by the old rule → OUT_OF_SYNC "cut" with the safe `swap` fix (`swap_sound` to its own sound); applied
  as the clients do (register → `media.register` → `soundDesign.swap`) → aligned frame 40 kept, track and gain kept, no
  cut / TRUNCATED finding, rendered whole; a 40 ms click at 60 fps cut after its peak → TRUNCATED (warning, 0 < missing <
  16.7 ms) with the `swap` fix; the same sound gone from the library → TRUNCATED measured on the file, fix = the commands
  `soundDesign.swap` on its own media, applied → clip past its media end, rendered whole, no finding; a clip the user
  trimmed with room left → not reported.
- `pnpm vitest run packages/project/test/sound-tail.test.ts`: 14 passed — `libraryTrailSilenceSamples` (padded / not /
  unknown tail / analysed span / > 120 s / hostile numbers), descriptor shift, provenance read / repair (`repairDocument`
  drops a bad `trailSilenceSec`, idempotent) and refusals; a **2 000-run property** over the 8 sequence rates, cue frames,
  peaks, sound lengths, speeds 0.84…1.19, padded or not, align peak / start / end: the clip always reaches the end of the
  sound, never more than INV-005's frame past the media, inside the media whenever the trail covers a frame at that speed,
  never past the frame holding the sound's end, `end` aligned on the sound's end; per rate a 30 ms click placed inside its
  padded media with invariants clean; the WP5.1 case (85 ms copy, peak at 58 ms) placed and a same-media swap of the
  old-rule clip; a swap to the padded copy keeping aligned frame, role, gain, pan; resync / applyGains keep the length.
- `pnpm vitest run apps/engine/test/sounds-*.test.ts apps/engine/test/sound-*.test.ts apps/mcp/test/sound*.test.ts
  apps/mcp/test/{readme-tools,conventions}.test.ts --maxWorkers=2`: 30 files, 200 passed after the updates
  (`sounds-routes`: the whoosh copy carries 2 400 samples of trail, bit-exact between the two silences; the "late punch"
  folder sound now has quiet at both ends to stay in place). `apps/engine/test/sound-check.test.ts` 16 passed unchanged
  (the seeded "cut" still gets its trim fix: the fixture click's fade is measured on the file).
- `pnpm vitest run --project @jasper/project --maxWorkers=3` (final code): 2 005 of 2 007, then `sound-check.test.ts` (its
  code-list contract now names TRUNCATED) 8 / 8 alone — the one failure left is the pre-existing `sound-messages` template
  gap (`setAutoGain`, WP5.1 notes it). Final apps run: `pnpm vitest run apps/engine/test/sounds-*.test.ts
  apps/engine/test/sound-*.test.ts apps/engine/test/{security-review,fuzz-http}.test.ts apps/mcp/test/sound*.test.ts
  apps/mcp/test/{readme-tools,conventions,fuzz}.test.ts apps/web/test/sound-* apps/web/test/i18n.test.ts --maxWorkers=3`:
  **52 files, 940 passed**.
- **Real run** (dev engine `JASPER_APPDIR=.stage … --port 51001`, starter kit + Jasper Synth, jasper-mcp over stdio; script
  and outputs in `/var/lib/orquester/tmp/sfx-tail-run/`, not committed): the Phase 4 fixture, `plan_sound_design {seed:
  2026, delivery: web}` accepted as the editor. (A) `sound_check`: warn, **no** cut / TRUNCATED finding (MASKED 6, one
  "not measurable" info); the 8 interface sounds (typewriter ticks and clicks, speeds 0.997…1.017) each exported alone
  (native, ProRes + 24-bit PCM in MOV, loudness and the room bus off) and compared with the clip's media decoded past the
  clip's end exactly as renderers decode a clip (`clipDecodeArgs`, i.e. the whole sound at its speed): per-channel gain
  fit, lag 0, **residual −94.7 … −106 dB over the whole sound** (24-bit quantisation), the export's −60 dB end = the
  sound's (52.3 … 227.5 ms). (B) the same 8 clips put on head-only copies (the registered copies minus their trail, bit for
  bit, with the provenance of before) and cut to whole frames inside them (the old rule: 7 of 8 got a frame shorter):
  `sound_check` **fail** — OUT_OF_SYNC "cut" ×4 (error) + TRUNCATED ×3, every one with the safe `swap_sound` fix; their
  solo exports end at 33.3 ms (the clip end) where the sound fades at 52–62 ms (residual ≈ 0 dB); the fixes applied as
  given → `sound_check` warn with **no** cut / TRUNCATED finding, solo exports residual **−105 … −114 dB**, faded end
  = the sound's. The one not reported ("Switch click", 233 ms, quiet end) was whole before and after. Check times 5–21 s
  (load 27–37). A first version of the comparison used an H.264 export, which fell back to MP4 + AAC on this LGPL build
  (residual −30 dB from the codec, not the clips): the script now refuses a non-PCM export.
- Gate: `pnpm typecheck` (every package), `pnpm lint` (Biome, tokens, anime, layers, assets), `pnpm notices --check`
  (current) and `node scripts/i18n.mjs --check` (es.json covers all 9 621 strings) pass. The full `pnpm verify` was not run
  (shared host; the targeted suites above cover every package touched).

#### Limits

- Clips of media without room after the sound end under one frame past their media (silence). A later `clip.trim`,
  speed change or Time Remapping off that clamps to the media end can cut that frame again (Sound Check reports it as
  TRUNCATED / "cut" and the same-media swap restores it).
- A clip faster than +19 % at 23.976 fps (+50 % at 60 fps) on a padded copy also needs that past-the-end frame (the trail
  is 50 ms); the lead has the same bound (Phase 2 limits).
- TRUNCATED only judges clips at their media's last whole frame; a clip shortened on purpose is the user's. Fades are
  judged at −60 dB of the peak (descriptor `tailSec`; on the file: of the sample peak); a quieter residue after that may
  be cut.
- `measureTailEnd` decodes files up to 30 s; a longer file without tail data is judged by its end (no TRUNCATED unless
  the clip ends before it within the last frame).
- The re-register fix makes a new media per sound; the old copy stays in the project (Remove Unused cleans it).

### Phase 5 → WP5.2 Sound Check panel

Scope: spec 12 §2.7 "Sound Check panel" (+ §2.6 UX), P5-R3, the Phase 5 "Done when" ("the panel and the MCP tool show the
same report"), the Export dialog option, Sequence ▸ Sound Design ▸ Run Sound Check. Built on WP5.1's job, report schema,
`soundDesign.setCheck` and `soundCheckStatus`.

Files: web `apps/web/src/panels/soundCheck/{index.ts, SoundCheckPanel.tsx}`, `sound/{check-model.ts (pure), check-run.ts
(store, run / cancel, fixes, jump, listen), SyncStrip.tsx}`, `export/SoundCheckGate.tsx` (+ `ExportMode.tsx` wiring),
`commands/sound-check.ts` (+ `commands/index.ts`, `commands/app.ts` panel label), `shell/menus/model.ts`,
`panels/{types,registry}.ts`, `shell/workspaces/{definitions,migrations,store}.ts` (workspace state v3),
`sound/in-context.ts` (`playTimelineWindow` `onEnd`), i18n (`en.json`, `es.json`: 120 strings, `model-strings.json`: 1);
`packages/ui` icon `panel.soundCheck`; model `packages/project/src/sound/check.ts` (custom target: `SoundCheckTarget`,
`SOUND_CHECK_TARGET_LIMITS`, `readSoundCheckTarget`, `SOUND_CHECK_CUSTOM_LABEL`, the target in `soundCheckInputsHash` /
`soundCheckStatus`; verdict markers: `SOUND_CHECK_VERDICT_MARKER`, `soundCheckHumanVerdicts`,
`soundCheckVerdictMarkerName`), `schema/sound.ts` (`lastCheck.target?`), `commands/schemas/sound.ts` (`setCheck`
`summary.target?`); `packages/api/src/sound-check.ts` (`request.target?`, `report.preset.custom?`); engine
`apps/engine/src/sound-design/check.ts` (the target replaces the preset's numbers; never judged as broadcast; stored);
MCP `apps/mcp/src/tools/sound-check.ts` (`target`, `humanVerdicts`), `tools/sound.ts` (SOUND_GUIDE "Check"); README.
Tests: `apps/web/test/{sound-check-panel.test.tsx, sound-check-model.test.ts, workspace-migration.test.ts (+3)}`,
`packages/project/test/sound-check-panel.test.ts`, `apps/engine/test/sound-check.test.ts` (+1), `apps/mcp/test/{
sound-check-verdicts.test.ts, sound-check-report-fixture.ts}`, `e2e/sound-check.spec.ts`.

#### What it does (usage)

- **Where**: Window ▸ Sound Check; in the Sound Design workspace a tab next to Review (left, below the Library group:
  Review, Sound Check, Markers, History, Jobs); Sequence ▸ Sound Design ▸ Run Sound Check opens it and runs the check.
- **Header**: Delivery target — the four presets ("Web / streaming · −14 LUFS · −1 dBTP" …) or **Custom…** (Integrated
  LUFS −40…−5 and True peak dBTP −12…0 fields; "−18,5" and real minus signs accepted; out of range → `role="alert"`
  text, `aria-invalid`, Run disabled). **Use as sequence target** (disabled with why when the sequence already delivers
  there): a preset → `soundDesign.applyDelivery {delivery}` (the delivery setting, Mix normalisation at the preset,
  default SFX levels moved to it), Custom → `mixer.setLoudness` at its numbers; ONE undo step "Use Delivery Target: …".
  **Run** → the `sound-check` job with `store: true` (the editor key: the engine writes the summary as the user's edit
  "Sound Check Result", WP5.1); the stage and percentage in the panel (`role="progressbar"`) and the job in the Jobs
  panel; **Cancel** cancels the job at once (also a poll in flight).
- **Summary**: the verdict chip (⊗ Fail / △ Warnings / ✓ Pass — icon shape + word + tone), Integrated, True peak, LRA,
  Errors, Warnings, Info and "vs <preset>" / "Custom · −18.5 LUFS · −2.0 dBTP"; **Stale: <the mix changed | cues, loudness
  or credits settings changed | the delivery target changed> since this check** + **Re-run** when `soundCheckStatus`
  says so. A reopened project shows the stored summary's report while the engine keeps its job (`getJob(jobId)`), else
  the summary's chips and "Run the check to see its findings…".
- **Findings** grouped Sync, Loudness, Mix, Cues, Licence (errors first, then by time), each row: severity icon + word,
  the timecode (a button: playhead there, the finding's clips selected — else its cue —, the Timeline scrolled; "whole
  mix" for findings over the whole range), the code and the translated message (template + params; cue kinds and
  densities translated), **Fix** (safe) / **Fix…** (needs judgement, the engine's `why` in the tooltip) and under it
  "✓ <fix> · safe" / "! <fix> · needs your judgement". A fixed row says "✓ Fixed — run again to confirm" until the next
  run. Fix = commands → ONE transaction "Sound Check Fix: <fix>" (`session.apply`, origin user); swap → the panel's swap
  path (register the library sound → `media.register` → `soundDesign.swap`, also for the same sound = the TRUNCATED
  re-pad); job → `runRebalance` / `runDelivery` (apply mode; the engine relays the user's edit).
- **Fix all safe (n)**: every safe fix not yet applied — command fixes and swaps in ONE transaction "Fix n Sound Check
  Findings" (media registrations, then the command fixes, then the swaps, so an align before a swap of the same clip
  keeps the aligned frame; a fix two findings share is applied once); when that transaction is refused (two fixes that
  cannot go together) each fix is applied on its own and the refused ones are reported; then the safe engine jobs one
  after another; then the check runs again.
- **Sync strip** (sync rows, chevron or →): the picture at the cue frame and ±1, ±2 frames (engine stills of the
  committed sequence, 224 px JPEG, cached per revision) above the mix waveform ±0.3 s around the cue
  (`/api/sound-design/visual` 10 ms peaks), a solid line at the picture event, a dashed "Sound +66.7 ms" line where the
  aligned point was measured, ticks at the five frames, and the sentence "Picture event at …; sound measured 66.7 ms late
  (2.0 frames)" (the SVG's accessible name too).
- **Listen here**: the report's ≤ 5 moments (worst, biggest hero, loudest, busiest, a passing cue) with ▶ (2 s before to
  2 s after through the Program transport: `playTimelineWindow`, the playhead returns), the timecode (jump), the reason,
  **✓ Sounds right** and **✕ Flag** (a note field: Enter saves, Esc cancels). A verdict is a user-authored `comment`
  marker at the moment's frame named "Sound Check: sounds right" / "Sound Check: flagged", the note as its comment
  (green / rose), one undo step ("Sounds Right at …" / "Flag Sound at …"); a new verdict at the same frame updates that
  marker. **Play all** chains the windows: the next starts when one has played to its end; a key, a click or Stop ends
  the chain.
- **Keyboard**: the findings list is one tab stop (`listbox`, `aria-activedescendant`, `data-keymap-local`): ↑ ↓ Home End
  move, Enter jumps, F fixes, → / ← open / close the sync strip, Space plays 4 s around the finding; the rest are buttons
  and fields. One `aria-live` region announces "Sound Check running", the verdict ("Sound Check Fail: 1 error, 4
  warnings"), fixes, verdicts and playback.
- **Export** (Export mode ▸ SOUND, shown when the sequence has sound effects): "Run Sound Check before export" (remembered
  per browser, off by default). On: Export runs the check first (stage, percentage and Cancel above the footer); a pass or
  warnings export at once and the verdict is said in a notice; a **fail** stops with the verdict, the counts and the
  integrated / true peak and two buttons, **Export anyway** and **Review issues** (Export mode closes, the checked
  sequence becomes active, the Sound Check panel opens with the report).
- **Agents**: MCP `sound_check` is the same job and report (the e2e asserts the same codes at the same frames); it
  gained `target {integratedLufs, truePeakDb}` and returns **`humanVerdicts`** — `{timecode, frame, verdict: "sounds
  right" | "flagged", note, markerId, slot?}` read from the verdict markers (only user-authored `comment` markers with
  those names: an agent cannot fake a verdict by naming a marker). UI commands `sound.runSoundCheck` and
  `sound.fixAllSafe` are in the catalogue; verdicts are deliberately not an agent action.

#### Decisions

- **Custom target end to end** (the task asked for "Custom… target LUFS/TP"; WP5.1 checked presets only): a check request
  takes `target`, the report's preset says `custom: true` with the target's numbers (label "Custom target", a model
  string), a custom target is never judged with broadcast severity, the stored summary keeps `target` (optional, loose
  schema; a damaged one drops the summary on repair as any damaged summary does) and `soundCheckInputsHash` includes it
  only when present, so summaries stored before stay current. The preset behind a custom check (default SFX levels,
  solver programme loudness) is the sequence's.
- **Verdict markers are named, not flagged**: `marker.add` takes no metadata and the marker schema is shared; fixed
  English names (data an agent parses, like History labels) and `author: 'user'` identify them. Shared parsing in
  `@jasper/project` (`soundCheckHumanVerdicts`) for the panel and MCP.
- **Summary storage follows WP5.1**: every editor run stores (`store: true`, one undo step "Sound Check Result"); read-only
  projects run without storing.
- **"Use as sequence target"** writes `soundDesign.applyDelivery` without measurements (normalisation at the preset and the
  setting; no Auto-Match or ducking: that is Delivery Target…'s job, which measures first).
- **The sync strip is SVG** (the spec says the web draws the visual data on canvas): the same data, drawn with design
  tokens so high contrast and themes follow, testable in jsdom. Stills come from the engine's `stills` route (a `still`
  job per frame, shown in the Jobs panel) — the Program render the export uses — not from the Program monitor's player.
- **Play all** needed `playTimelineWindow` to say how a window ended (`onEnd('window' | 'stopped')`); nothing else of
  the In Context audition changed.
- **Workspace state v3**: stored Sound Design layouts get the panel right after Review (else where Review went); the
  NaN-unsafe `out !== layout` in the v1→v2 property test (a pre-existing flake: `fc.anything()` draws NaN) is now
  `Object.is`.
- **Credits**: `ExportSettings` has no `credits` option yet; Phase 6 adds the sidecar and should default it from
  `soundDesign.settings.credits` (the Export dialog does not show a credits option in this package).

#### Verified (measured, this branch; shared host, 16 cores, load average 2–24 during the runs)

- `pnpm vitest run packages/project/test/sound-check-panel.test.ts packages/project/test/sound-check.test.ts`: 17 passed —
  the target in the inputs hash only when given (stored preset hashes unchanged), setCheck stores it, current with it and
  stale (`inputs`) against a preset hash, refusals (out of range, missing field, extra key), load keeps it, repair drops a
  damaged one (idempotent), `readSoundCheckTarget` 300 hostile runs; verdict markers read in frame order with the note,
  an agent-authored marker with a verdict name is not a human verdict, 2 × 300 hostile runs never throw.
- `apps/engine/test/sound-check.test.ts`: 17 passed (+1: the clean fixture checked at a custom −20 LUFS / −2 dBTP →
  LOUDNESS warning — not error — with the label "Custom target" and a safe `mixer.setLoudness` −20 / −2 fix; stored with the
  target and current; the fix applied → no LOUDNESS, −20 ±1 LUFS, TP ≤ −1.95; the inputs hash differs from the preset's; an
  out-of-range target → 400). With `security-review` and `fuzz-http`: 3 files, 215 passed.
- `apps/mcp/test/sound-check-verdicts.test.ts` (in-memory jasper-mcp, fake engine): 2 passed — `humanVerdicts` = the user's
  two markers with timecode, "flagged" + note on the worst slot, "sounds right" on the hero; an agent's marker named the
  same and an ordinary comment marker left out; `target` reaches the request, out of range is refused. `conventions`,
  `readme-tools`, `sound-guide`, `sound-examples`, `packages/api`: pass (8 files, 55 tests).
- `apps/web/test/sound-check-panel.test.tsx`: 11 passed (real session, fake engine): Run → progress (stage, 40 %), the
  stored summary "Sound Check Result" (current), chips, categories in order, the OUT_OF_SYNC row's accessible name, "whole
  mix", Fix… for an unsafe fix, five listen rows, the live verdict; Cancel cancels the job (no summary); stale after a gain
  change + Re-run, a stored summary without its job shows its chips; timecode → playhead 90 + clip selected; keyboard ↓ /
  Enter (playhead 150, clip B) / → (5 stills at 148…152, waveform over 141–160, picture line, no measured line for
  TRUNCATED) / ← / Home → (both lines, the late sound right of the picture, "66.7 ms late (2.0 frames)") / F (one entry
  "Sound Check Fix: Align its peak to the cue", clip 2 frames back); Fix = one entry, "Fixed", stale `inputs`, undo restores;
  **Fix all safe (4)** = `["Fix 3 Sound Check Findings", "Sound Check Result"]` (move + register/swap + setLoudness in one
  entry), then the delivery job `{loudness: false, autoMatch: false, rebalance: false}`, then the re-check (only SILENCE
  left), two undos restore the clips; listen ▶ = window centre 90 ±2 s; Sounds right / Flag + note → two user comment
  markers, `soundCheckHumanVerdicts` reads them, a new verdict at the same frame updates the marker; Play all chains 90 →
  91 → 120 on `window` ends and stops on `stopped`; Use as sequence target (preset → applyDelivery, then disabled; Custom…
  "−70" refused with the alert, "−18,5" / "−2" → the request's target, the stored summary's target, mixer.setLoudness
  −18.5 / −2); the menu entry and both UI commands; the Export gate (off → exports at once; on + fail → the alertdialog;
  Review issues → no export; Export anyway → export; pass → export + the verdict notice; not offered without SFX).
- `apps/web/test/sound-check-model.test.ts`: 12 passed (translated texts in English and Spanish — the cue kind "corte" —,
  hostile messages, chips, stale line, grouping, fix plan with a shared fix applied once + a 300-run property, delivery
  defaults and target, custom fields + property, verdict commands, listen rows, strip geometry, waveform path + property).
  `workspace-migration.test.ts`: 8 passed (+3 for v2 → v3).
- Full suites after merging `feat/sound-design` (Phase 4 verification, WP6.1 packs): `pnpm vitest run --project
  @jasper/web --maxWorkers=3` → 134 files, 1 010 passed; `--project @jasper/project` → 165 files, 2 041 passed. `pnpm
  typecheck` (every package), `pnpm lint` (Biome, tokens, anime, layers, assets), `pnpm e2e:typecheck`, `pnpm notices
  --check` (current), `node scripts/i18n.mjs --check` (es.json covers all 9 818 strings): pass.
- **E2E** (built stack, `E2E_PORT=51101 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-check.spec.ts`): passed (57.5 s
  at load ≈ 4; green in every run after the first fixes, also after the merge). The Phase 2 fixture + 14 s of pink-noise music → Auto Sound Pass →
  Accept all → Apply → the hit on the cut at frame 90 nudged 2 frames, frames 360–384 of the music lifted → Run Sound
  Check from the menu → **fail**: `OUT_OF_SYNC:<the hit>` at data-frame 90 ("Crunchy impact plays 66.7 ms late on its cut
  cue at 00;00;03;00"), SILENCE at 00;00;12;00 (0.79 s) → the timecode moved the playhead to 90 and selected the clip →
  the sync strip (5 stills, the cut between −1 and the cue, the dashed line "Sound +66.7 ms", "late (2.0 frames)") →
  Sounds right on the hero moment, Flag + "The hit lands after the cut" on the worst → the two user comment markers →
  **jasper-mcp `sound_check` on the same project: the same `CODE@frame` list as the panel's rows** and `humanVerdicts` =
  the two verdicts (the flag on slot `worst`) → Export (Ctrl+M) with "Run Sound Check before export": the fail prompt
  ("Sound Check: 1 error, 2 warnings. Integrated −23.2 LUFS, true peak −5.4 dBTP…") → Review issues → the panel → Fix on
  the late hit (one entry, the clip back on its cue, stale) → Fix all safe (one "Fix … Sound Check Findings" entry + the
  re-check: no OUT_OF_SYNC for the hit) → Fix… on the silence ("Mark it as intended silence") → Re-run: no SILENCE; MCP
  again lists the same findings as the panel. Screenshots looked at (`test-results/e2e-sound-check/`: panel, panel
  high contrast, sync strip, listen-here, export prompt, after fix all, final): the first looks found the sync strip wider
  than the panel (now measured, five columns), the "Listen here" title squeezed by its hint (hint on its own line), the
  listen rows repeating the slot name the reason already says (removed) and the export prompt saying "Fail" twice.
- **Every sound e2e** (same build, one worker, before merging the integration branch; 22 tests): 16 passed, 4 failed, 2
  did not run; none from this package's code. `sound-library` expected a riser's end at the end of its media, but since
  the tail fix `end` alignment ends the sound before its trailing silence (spec 12 §2.3) and placement takes that end from
  the provenance (`durationSec − trailSilenceSec`): both checks of the spec now compute it the same way. `sound-mix` hung
  for an hour on a toast that had gone (the integration branch fixed it at the same time; its fix taken in the merge).
  `sound-p0-transport` "seek during playback" (60 ms of old audio after a seek: the Phase 0 limit "seek-during-playback
  loses first read-ahead") and `sound-p3-mcp` (one export correlation 0.89 < 0.95 under an overlapping sound) passed on
  the rerun of those four files (7 passed). After merging `feat/sound-design` (Phase 4 verification, WP6.1 packs) and
  rebuilding: `sound-check` (its Auto Sound Pass now closes the plan's notes, which keep the dialog open since the
  Phase 4 verification) and `sound-library` (3 passed, the export oracle included) pass.

#### Limits and notes for the next packages

- A verdict belongs to a frame: it outlives the run and later edits, and two listen moments on the same frame share it
  (the e2e's hero and passing moments were both at 00;00;08;10). The panel shows the verdict at each moment's frame.
- Each opened sync strip renders five `still` jobs (they show in the Jobs panel; cached per document revision); the strip
  draws the mix waveform, not the sound-effects stem (the visual route gives the mix's peaks only).
- Play all stops on any key or click (the In Context window's rule), including a click on a verdict button.
- The findings list keys (↑ ↓ Home End Enter F → ← Space) are fixed, not in Keyboard Shortcuts.
- The full report lives in the engine's job; after the engine forgets it the panel shows the stored summary's chips until
  the next run.
- Fix… applies an unsafe fix in one click (it says "needs your judgement" and the engine's why in its tooltip); there is
  no confirmation.
- Phase 6: `ExportSettings.credits` (the sidecar) should default from `soundDesign.settings.credits`; this package adds no
  credits option to the Export dialog.
- Found for the tail-fix owner: an `end`-aligned padded sound's end comes from the provenance's quantised `durationSec −
  trailSilenceSec` (0.1 ms steps), not from the media's sample length (the `sound-library` e2e measured 0.03 ms).

### Phase 5 → Sound Check engine review

Branch `feat/sd-p5-review-engine` (from `feat/sd-p5-verify`): a correctness review of the check engine (`apps/engine/src/
sound-design/check.ts`, `stems.ts`, `packages/audio-fx/src/analysis/check-curves.ts`, `masking.ts`, `packages/project/src/
sound/check.ts`). Every fix has a regression test that failed before it (`apps/engine/test/sound-check-review.test.ts`: 8 of
its 9 tests failed on the code before, measured; the ninth pins the MASKED / solver equality).

#### Defects fixed

| Area | Defect (before) | Fix |
|---|---|---|
| Sync, sequence edges | The post-roll stopped at the end of the sequence and a capture could not start before sample 0: a click on the last frames or a hit on frame 1 was "not measurable (its cue is at the edge of the checked range)" | The post-roll always runs 1.5 s past the range (silence after the end); a capture may start before 0 (silence there) |
| Sync, identical sounds | Two copies of one sound within ±3 frames (a repeat, a doubled layer): the stronger correlation won, so the in-sync twin got a false error "plays 66.7 ms off its cue … though it is placed on it", or the nudged clip was measured at its twin (a missed 2-frame offset) | `locateByCorrelation({prefer, share, separation})`: among matches ≥ 75 % of the best one (maxima at least a frame apart, so a tonal sound's side lobes are not matches) the one nearest where the document plays the clip wins (decision: the document is right unless the renderer is; a renderer offset of a tonal sound is then harder to see) |
| Sync, reversed clips | The aligned point of a reversed clip was computed as if it played forwards: a correct reversed clip got a false OUT_OF_SYNC error judged from the document (−533 ms in the test) | `start + duration − (peak − sourceIn) / rate` frames (the mixer's reversed content time) |
| SILENCE | The level was the mean square over the channels: a left-only room tone at −58.5 dBFS read −61.5 (stereo) and a centre-only 5.1 dialogue 7.8 dB low — "silence" | `CurveMeter.loudestDb` (mean square of the loudest channel) for SILENCE (audible-for-loudness keeps the mean) |
| DIP | A music dip written on purpose (Volume keyframes: rides, auto-duck, `audio.volumeDip`, a stop-before whose cue has moved since) was a DIP warning | A drop overlapping a Volume keyframe segment (clips in content time, tracks, submixes, the Mix) that goes down by ≥ 6 dB is explained (decision); the same drop made by a clip gain (no level move) is still reported (control test) |
| REPEAT fix | The safe swap took any alternative: a CC-BY-NC alternative was offered as a **safe** fix (resolving a warning by creating a LICENSE error) | An alternative's licence may not rank worse than the clip's (commercial-safe < user-provided < NC / ND / unknown) |
| MUSIC_OVER_VOICE fix | "Safe" predicted the ducking with the clip's Essential Sound depth (−15 dB default), but the delivery job writes `DELIVERY_DUCK_DB` (6 dB) under dialogue unless the user set a depth: a fix that leaves the music 6 LU under was called safe | The prediction uses the depth the job writes (the user's, else 6 dB under dialogue), the weakest of the clips'; the test applies the job and shows the finding stays |
| Custom target | The engine hashed the raw target while `soundCheckStatus` re-hashes `readSoundCheckTarget` (0.1 steps): a stored check at −18.55 LUFS was stale at once (found by the verification agent; confirmed by the test) | The target is rounded once (`readSoundCheckTarget`) for the check, the report, the inputs hash and the stored summary |
| Staleness | `soundCheckInputsHash` ignored the cue density, which DENSITY judges by: a summary stayed current after Sparse ↔ Rich | The density is hashed when it is not the default (summaries stored at Balanced stay current); markers incl. verdict markers, `agentsMayApply`, `seed` keep it current (test) |

#### Checked and found right (evidence)

- Empty sequence, a range of 0.2 s, silent stretches: "silent" / "cannot be measured" warnings, never a pass (existing
  tests, rerun). Only dialogue: no SFX rows, no MUSIC_OVER_VOICE (no music stem). Muted tracks, offline media, reversed
  clips: sync "not measurable" (info) or judged from the document. Speed ≠ 1: aligned point and reference decode at
  `sr / rate` (trace, `check.ts` rows and `RefPlan.decodeRate`).
- 5.1: K-weighting weights `[1, 1, 1, 0, 1.41, 1.41]` (`defaultChannelWeights(6)`), stems and meters at the export's
  layout (6 channels for a 5.1 Mix), true peak over every channel; SILENCE now the loudest channel (unit test, 5.1 centre).
- MASKED = the solver: a 500-run fast-check property (`check-curves.test.ts`) — `evaluateSfxGain` equals `solveSfxGains`
  (gain, lift, peak over bed, true peak, speech lift, dominant bands, target) at the solved gains for any events (repeats,
  heroes, speech, silent beds, user offsets, 4 programme levels × 2 ceilings); the engine path: on the masked fixture the
  check's `solvedGainDb` / `solvedLiftDb` equal the rebalance job's `gainDb` / `achievedLiftDb` on the same document.
- Licences: every catalogue pack licence (`SOUND_PACK_LICENSES`: CC0-1.0 → cc0, CC-BY-3.0 / 4.0 → cc-by, CC-BY-SA-3.0 /
  4.0 → cc-by-sa) is commercial-safe and the CC BY ones need a credit (CREDITS); user folders: `LicenseRef-UserProvided`
  → LICENSE warning, `LicenseRef-UserRoyaltyFree` → safe without a credit; NC / ND / NOASSERTION / unknown / "CC-BY-4.0 AND
  …" → LICENSE error (`licenseClass`, existing tests `sound-rank`, `sound-review-fixes`, `sound-packs`).
- Fixes: every command fix is dry-run on the current document; the panel applies them in report order (sync before
  REPEAT / LICENSE swaps, swaps last), so an align and a swap of the same clip compose (the align's `soundDesign.swap`
  carries the old media: applied after a swap it would undo it — the order prevents that).

#### Long sequences (measured)

`SOUND_CHECK_BENCH_MIN=30 pnpm vitest run apps/engine/test/sound-check-bench.test.ts` (opt-in; 30 min of pink-noise
music + a gated 1.5 kHz voice, 40 hits on cues, normalisation on; 16-core shared host):

| Build | Load | Wall | Engine CPU (user) | Peak RSS (base) | heapUsed | arrayBuffers peak | Report |
|---|---|---|---|---|---|---|---|
| before (`8af31459`) | 3.4–5.5 | 126 s | 133 s | 524 MB (331) | 213 → 222 MB | 157 MB | 180 KB |
| before (`8af31459`) | 25–109 | 2 341 s | 993 s | 511 MB (333) | 212 → 224 MB | 153 MB | 178 KB |
| after | 2.9–6.3 | 120 s | 131 s | 528 MB (339) | 213 → 224 MB | 173 MB | 174 KB |
| after | 4.7–8.3 | 206 s | 214 s | 547 MB (331) | 212 → 221 MB | 172 MB | 168 KB |

Stems are one pass (`timings.decoders` 42 = 40 hits + music + voice: every clip decoded once); 40 of 40 hits located; the
report's curves 1 200 points; 90 speech segments. Memory grows with the duration but is bounded: ≈ 28 B per 10 ms hop per
meter (7 meters) plus the finished curves and the transient loudness curves — ≈ 150 MB of array buffers at 30 min
(measured), ≈ 1.2 GB at the 4-hour cap (estimated, linear). The heap stays flat. The normalisation pass writes the range
as 32-bit floats to the job's scratch directory: 691 MB for 30 min stereo (≈ 23 MB/min, 69 MB/min for 5.1; computed),
removed after the pass. Wall time is dominated by the six stem mixers (≈ 0.07 s of engine CPU per second of sequence at
low load). A first variant read the scratch file 1 s per await instead of 10 ms: no measurable difference (21 vs 25 s for
the pass at low load), so it was not kept.

#### Limits (not fixed)

- DENSITY's demotion and MASKED's gain on the same hero are both safe alone; together the hero's solved gain may exceed the
  support cap (OVERLOAD on the re-check). The panel re-runs the check after Fix all safe.
- With normalisation off, a safe MASKED gain can raise the mix's true peak (the solver's headroom is per sound).
- ~~DIP also fires on long dialogue pauses over a quiet, un-ducked music bed without a picture cut (the bench: ≈ 70 DIPs in
  30 min of 8 s pauses); a dialogue pause is not an explanation (spec).~~ Handled by the Phase 5 verification (below): a
  drop is explained when the bed without the dialogue holds its level (decision; the bench: 0 DIPs).
- `soundCheckInputsHash` still ignores media licences (`media.setLibraryInfo`), transcripts and picture edits (adding
  them would make every stored summary stale once).
- The sync preference trusts the document among near-equal matches: a renderer offset of a strongly periodic sound shows
  less clearly than before.

### Phase 5 verification

Branch `feat/sd-p5-verify` (from `8af31459`), with the engine review above merged in (`feat/sd-p5-review-engine`). Scope: spec
12 P5-R1…R4 and the Phase 5 "Done when", the CLAUDE.md Definition of Done, the WP5.2 follow-ups, a deep review of the
Phase 5 code and the real app (e2e, MCP). Every defect fixed here has a regression test that failed before the fix.

#### Requirements (evidence)

| Requirement | Status | Evidence (rerun) |
|---|---|---|
| P5-R1 `sound-check` job: every §2.6 check and code (+ TRUNCATED), report schema, `soundDesign.setCheck`, staleness | done | `apps/engine/test/sound-check.test.ts` (18: clean pass, 14 seeded defects each found and resolved by its fix, custom target, refusals), `sound-check-review.test.ts` (11: edges, identical sounds, reversed, SILENCE per channel, DIP vs level moves and dialogue pauses, REPEAT licence, ducking prediction, custom target rounding, MASKED = rebalance), `sound-check-stems.test.ts` (stems = `renderMixdown` sample for sample, each clip decoded once); `packages/project/test/sound-check.test.ts`, `sound-check-panel.test.ts`, `fuzz.test.ts` (AC-25 draws setCheck / setVerdict / credits); `packages/audio-fx/test/check-curves.test.ts` (500-run solver-equality property) |
| P5-R2 visual data routes; MCP `sound_check` and `view_sound_timeline` (PNG) | done | `sound-check.test.ts` (visual route: 400 points, curves, motion, cues, aligned frames), `sound-check-kept.test.ts` (sound-effects / bed peaks), `apps/mcp/test/sound-check.test.ts` (PNG decodes, findings, safe fixes applied as given → pass); real run below (PNGs looked at) |
| P5-R3 panel: fixes, Fix all safe, sync strip, listen-here verdict markers, Export dialog option | done | `apps/web/test/sound-check-panel.test.tsx` (14), `sound-check-model.test.ts` (15), `sound-check-listen-keep.test.ts` (3); `e2e/sound-check.spec.ts` (screenshots in `test-results/e2e-sound-check/`) |
| P5-R4 seeded defects found with the right code; a clean fixture passes | done | `sound-check.test.ts`: "2-frame offset → OUT_OF_SYNC", "masked hit under loud music → MASKED", "0.8 s digital silence → SILENCE", "music 3 LU under the voice → MUSIC_OVER_VOICE", "true peak −0.2 dBTP → TRUE_PEAK", "short media is never a trivial pass", "the clean fixture passes" |
| Done when: the panel and the MCP tool show the same report | done | `e2e/sound-check.spec.ts`: the panel's `CODE@frame` list equals `sound_check`'s, before and after the fixes; `humanVerdicts` = the panel's verdicts |
| DoD: model, schema, repair | done | `Marker.soundCheck` (verdict binding): INV-SOUND, `drop-verdict-meta`, idempotent (`packages/project/test/sound-check-verdicts.test.ts`); `docs/project-files.md` row |
| DoD: undoable commands with undo / redo / refusals | done | `soundDesign.setVerdict` (catalog "Sound Check Verdict", example in `apps/mcp/src/examples.ts`, `sound-examples.test.ts`): add / update / remove, undo = the document before, redo, 8 refusals (`sound-check-verdicts.test.ts`) |
| DoD: UI wired — panel, menu, shortcuts without conflicts | done | Sequence ▸ Sound Design ▸ Run Sound Check; the findings list keys are `soundCheck`-scope commands (Keyboard Shortcuts lists them, remapping works: panel test); `apps/web/test/keymap.test.ts`, `edit-ux-keyboard.test.tsx` pass |
| DoD: preview / export | n/a (metadata) | Sound Check renders nothing new; verdicts are comment markers; "Run Sound Check before export" in the Export dialog (panel test, e2e) |
| DoD: agents (MCP tools, README, guide) | done | `sound_check` (`humanVerdicts` with `stale`), `get_sound_check` (new), `view_sound_timeline`; README tool list (354 after the WP6.2 merge), SOUND_GUIDE "Check"; `readme-tools`, `conventions`, `sound-guide`, `sound-check-verdicts` tests |
| DoD: i18n (en / es), a11y, tokens | done | every Sound Check template, fix reason and unmeasured reason is a model string with a Spanish text and the same placeholders (`sound-check-model.test.ts`); `node scripts/i18n.mjs --check`; `check-tokens` |
| DoD: run in the real app and look | done | e2e (Chromium, built stack) and MCP real run below |

#### WP5.2 follow-ups closed

- **(a) Unsafe fixes are confirmed.** "Fix…" (and F on a finding whose fix is not safe) opens a confirmation that names
  what will change (`fixChangeSummary`: "Adds a silence cue from 00;00;12;00 to 00;00;12;24…", "Deletes the sound cue
  at … and the 2 sounds placed on it", "Sets the gain of “Air swish” from −9.5 dB to −4.0 dB", "Re-levels the sound
  effects… the gain of any of them may change", Auto-Match / ducking for delivery jobs…), why it needs judgement and that
  it is one undo step; Cancel applies nothing ("Fix not applied"). Safe fixes and Fix all safe do not ask.
- **(b) Play all keeps playing through verdicts.** `playTimelineWindow` takes `keepPlayingOn`; the Sound Check passes
  `keepsListening`: presses inside the listen controls (Sounds right, Flag, the note field and its buttons, ▶, Play all /
  Stop) do not end the window, Escape and everything else still do. Found while testing it: pressing Stop (or a playing
  row's ▶) stopped the window on pointer-down and the click then started it again — those buttons now act on their own
  click only (`sound-check-listen-keep.test.ts`, panel test, e2e: a verdict during Play all is recorded and Play all
  goes on).
- **(c) Verdicts are bound to the moment they judged.** Decision: keep the spec's `comment` markers and give them a
  structured, optional `soundCheck` field (markers are loose objects, so older builds keep it) written by a new command,
  `soundDesign.setVerdict {frame, verdict | null, note?, slot?, clipId? | cueId?, reportMixHash?}`: the slot, the clip
  (else cue) listened to and where it was, `mixFingerprint` at that time and `soundCheckMomentHash` (the mix fingerprint of
  the clips overlapping the ±2 s window the panel plays). `soundCheckHumanVerdicts(seq, {doc})` reports `stale` with
  `moment` (what plays there changed), `moved` / `gone` (its clip / cue) and `mixChanged`; a name-only marker of before is
  `bound: false`, `stale: null`. Two moments on one frame about different clips keep separate verdicts; a verdict about
  no clip / cue in particular (or an older one) covers every moment at its frame until a specific one replaces it. The
  author is whoever applies the command: an agent's (MCP, HTTP agent transactions — measured in the real run: author
  `{agent: 'external'}`) is never a human verdict. The panel shows "Out of date: the sound here changed since you
  listened"; MCP `humanVerdicts` gains `slot`, `clipId` / `cueId`, `stale`, `staleReasons`, `mixChangedSince`.
- **(d) The sync strip draws the sound effects over the bed.** The visual route returns `stemPeakDb {sfx, bed}` (10 ms
  peaks as delivered, from the same one-pass stem render); the strip draws the bed filled and the sound-effects stem as
  an outline with a legend (`sound-check-kept.test.ts`: the hit is in the sfx peaks, 20 dB over its quiet before; e2e
  screenshot `sync-strip.png` looked at). An engine without the field still gets the mix waveform.
- **(e) The last full report is kept.** `SoundCheckReportStore` (`apps/engine/src/sound-design/report-store.ts`):
  every finished `sound-check` job writes `<appdir>/projects/<pid>/sound-check/<sequenceId>.json` (atomic; the newest per
  sequence; ≤ 32 per project, least recently written evicted; ≤ 16 MB; a damaged or foreign file is moved aside);
  `POST /api/sound-design/check/last` returns it with `state: current | stale` and `reasons: mix | inputs` against the live
  document; the panel reloads it when the job is gone (and judges any shown report by its own hashes); MCP
  `get_sound_check` (READ_ONLY). Note: the job journal already restores the newest 500 finished jobs for 7 days, but a
  session's still jobs push a check out of it — the store does not depend on it (`sound-check-kept.test.ts` deletes the
  journal, restarts the engine on the same appdir, reads the report, edits, reads it stale).
- **(f) The findings list keys are commands** of the `soundCheck` scope — Next / Previous / First / Last Sound Check
  Finding (↓ ↑ Home End), Go to (Enter), Fix (F), Open / Close Sync Strip (→ ←), Play (Space) — listed in Keyboard
  Shortcuts and remappable (panel test: F rebound to X fixes with X, not F). The list's cursor and open strips moved to
  the Sound Check store so the commands act on them.
- **(g) End-aligned padded sounds end on the sample.** It was a real alignment error: `end` used `descriptors.durationSec −
  trailSilenceSec` (durationSec quantised to 0.1 ms). `planSoundInsert` now ends the sound at the placed media's own
  length minus `trailSilenceSec` (`SoundTiming.trailSec`; µs-exact from the probe) when the two agree within 2 ms. Test
  (`sound-tail.test.ts`): four sound lengths × the 8 sequence rates, within one flick of the last sample's end (before: 5 880
  flicks = 0.0083 ms off on the test's first case); the sound-library e2e now expects the exact end.

#### More defects found by this pass (each with a regression test)

| Defect | Fix |
|---|---|
| The foreground falling away was a DIP: a pause in the dialogue over a quiet, un-ducked music bed (≈ 70 in the 30-minute bench; 10 after the review's fixes) and a hit ringing out over quiet music ("drops 23.3 LU at 00:00:05:05") | Decision: DIP is a drop of the programme under the foreground — explained when the bed without the dialogue (bed − dialogue energies: music, ambience, other audio) does not itself drop > 10 LU over the drop; the music dropping is still a DIP (`sound-check-review.test.ts`: pause, hit tails and the control, the first two failed before — "drops 30.9 LU at 00:00:10:15", "drops 23.3 LU at 00:00:05:05"); the 30-minute bench now reports **0** DIPs (its music never drops) |
| Play all / ▶ pressed to stop restarted playback (stopped on pointer-down, started on click) | (b) above |
| The worst listen-here reason quoted its finding's English text inside the Spanish template | The panel says the finding itself in the UI language (`sound-check-model.test.ts`) |
| A fix's "why" (tooltip, confirmation) was English only | `fix.whyMessage` (template + params; 12 templates) beside `why`; the panel translates it |
| "its timing cannot be measured (…)" reasons were English inside Spanish text | `SOUND_CHECK_UNMEASURED` fragments are model strings; the panel translates that parameter |
| End-aligned padded sounds ended 0.03 ms early | (g) above |

The engine review (section above) fixed nine more: sync at the sequence's edges, identical sounds near a cue, reversed
clips, SILENCE per channel, DIP vs deliberate level moves, REPEAT to a worse licence, ducking predicted with the wrong
depth, custom-target rounding, density staleness.

#### Real app (measured)

- **E2E** (built stack, `E2E_PORT=51403 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-check.spec.ts --workers=1`):
  passed in 2.0 min. Every sound spec (`e2e/sound-*.spec.ts`, 23 tests, one worker): **23 passed** in 18.6 min (load 3–15).
  Screenshots looked at (`test-results/e2e-sound-check/`): `sync-strip.png` (5 stills, sound-effects outline over the
  filled bed, "Picture" line at the cut, dashed "Sound +66.7 ms"), `fix-confirm.png` ("Apply “Mark it as intended silence
  (a silence cue)”? This will change: Adds a silence cue from 00;00;12;00 to 00;00;12;24…"), `listen-here.png` (the flag
  with its note, the hero and the passing moment — same clip, same frame — sharing "Sounds right"), `final.png`.
- **MCP real run** (dev engine `JASPER_APPDIR=.stage … --port 51401`, starter kit + Jasper Synth = 212 sounds, jasper-mcp
  over stdio; scratch script and outputs in `/var/lib/orquester/tmp/p5-verify/mcp-run/`, not committed): the Phase 4
  fixture, `plan_sound_design {seed: 2026, delivery: web}` accepted as the editor, the impact on the 00:00:03:00 cut
  nudged 2 frames. `sound_check {store: true}`: **fail** in 29.6 s (load ≈ 4): OUT_OF_SYNC "Crunchy impact plays 66.7 ms
  late on its cut cue at 00:00:03:00" with the safe `align_peak` fix, 7 MASKED (solver-limited, no safe fix), one
  "not measurable" info; listen-here worst 00:00:03:00, hero 00:00:08:10, loudest 00:00:06:00, busiest 00:00:07:03,
  passing 00:00:08:10. The safe fix applied exactly as given → re-check **warn** in 27.1 s, no OUT_OF_SYNC error.
  `get_sound_check`: current; after an engine restart with the job journal removed: still there, current; after a gain
  edit: stale (`mix`), "run sound_check again before applying any fix". PNGs looked at: `check-1.png` (the nudged hit's
  aligned line right of its cue tick, the OUT OF SYNC flag), `zoom-2-4s.png` after the fix (aligned line on the cue tick).
- **30-minute sequence** (`SOUND_CHECK_BENCH_MIN=30 pnpm vitest run apps/engine/test/sound-check-bench.test.ts`, final code,
  load 3.0–4.3): **109 s** wall (stems 84 s, delivery pass 17 s, levels 6 s, sync 1.4 s), engine CPU 115 s, peak RSS
  **539 MB** (base 334), heap flat (212 → 219 MB), array buffers ≤ 178 MB, report 87 KB; one pass (42 decoders for 42
  clips), 40 / 40 hits located, verdict warn (REPEAT ×39: the bench repeats one hit), no DIP.

#### Gate

Shared host, 16 cores; other agents' jobs pushed the load to 13–68 during the full runs (measured with `uptime`).

- **Before merging the integration branch** (this branch with the engine review): `pnpm verify` — lint (Biome, tokens,
  anime, layers, assets) pass, typecheck (19 packages) pass, `pnpm test` 702 files / 7 149 tests: 6 734 passed, 389
  skipped, **26 failed in 21 files**, all timeouts or time budgets at load 26–54 (15 × "timed out in 5000ms", camtrack /
  masking / render budgets, an interchange fuzz input over its 2 s hang limit). Rerun alone (`pnpm vitest run <the 21
  files> --maxWorkers=2`, `FUZZ_SEED=24301`, load 5–10): **21 files, 208 passed, 4 skipped, 0 failed**. `pnpm build` pass
  (43 s). `pnpm notices --check`: current (150 packages, 31 ported records).
- **After merging `feat/sound-design`** (WP6.2 cue sources; conflicts in `check.ts` imports, `routes.ts`, es.json, docs —
  both sides kept): `pnpm verify` — lint pass (after one import-order fix), typecheck pass, `pnpm test` 707 files / 7 197
  tests: 6 793 passed, 390 skipped, **14 failed in 12 files** at load 13–68. One was real: the README tool count (both
  branches added a tool: 354, not 353) — fixed. The other 11 files rerun alone at load 11: **12 files (readme-tools
  included), 131 passed, 7 skipped, 0 failed**. `pnpm build` pass (62 s); `pnpm notices --check` current; `pnpm
  e2e:typecheck` pass; `node scripts/i18n.mjs --check`: es.json covers all 9 916 strings.
- **E2E on the merged build**: `e2e/sound-check.spec.ts` passed; `e2e/sound-cue-sources.spec.ts` (WP6.2) passed after
  `pnpm fixtures` (its new `box-move.mp4`). Before the merge every sound spec passed (23 / 23, 18.6 min).
- Targeted suites on the final code: `apps/engine/test/sound-check{,-review,-kept}.test.ts` + `apps/mcp/test/sound-check.test.ts`
  33 passed; `apps/web/test/sound-*` + review + workspace 27 files, 280 passed; project sound-check / verdicts / tail /
  messages / fuzz 6 files, 43 passed.

#### Limits

- Each opened sync strip renders 5 still jobs (cached per document revision).
- A verdict's staleness follows the audio of its ±2 s window and its clip / cue position, not picture edits; a name-only
  verdict marker written before cannot tell (`stale: null`).
- A kept report is not deleted with its sequence (ids are unique, so it is never shown for another; the 32-per-project
  bound evicts it).
- Engine review limits (above): demotion + gain on one hero can overload; with normalisation off a safe MASKED gain can
  raise the true peak; a repeated tonal sound's renderer offset shows less clearly; the inputs hash ignores media
  licences, transcripts and picture edits.
- A fix's `why` for "the solver's gain does not resolve it: {0}" carries the solver's English reason as its parameter.
- A mono Mix is checked as the export renders it by default — stereo (`audioOutputOf` in the planner), the same mono
  signal in both channels; an export set to one channel is normalised on its own output, but Sound Check's readings
  (integrated, true peak) are those of the stereo default.

## Phase 6: packs, cue sources, completion

### Phase 6 → WP6.1 sound packs

Scope: spec 12 §0 decisions 1, 2, 4, 5, §2.1 source 2, §2.8 pack routes, §2.10 pack tools, P6-R1. Files:
`apps/engine/src/sounds/packs.json` (the catalogue, generated), `apps/engine/src/sounds/packs.ts` (catalogue loading,
download, extraction, install, removal, licences), `sounds/service.ts` (the `sound-pack-install` job, list, remove),
`sounds/library.ts` (`remove` also drops packs), `sounds/index-job.ts` (`inferTypes: false`), `sounds/search.ts`
(`packId` filter), `routes/sounds.ts` (routes, approval card, licence provider), `packages/api/src/{sounds,routes,jobs}.ts`
(contracts), `packages/engine-client/src/client.ts` (`listSoundPacks`, `installSoundPack`, `removeSoundPack`),
`apps/mcp/src/tools/sound.ts` (three tools, `SOUND_GUIDE`, `search_sounds {packId}`), `apps/web/src/sound/PacksSection.tsx`
(Preferences ▸ Sound Library ▸ Packs), `PreferencesPage.tsx`, `model.ts` (`pack:<id>` collections),
`panels/soundLibrary/{SoundLibraryPanel.tsx,index.ts}` (empty state, panel menu, Sources › Packs › <pack>),
`commands/sound.ts` (`soundLibrary.installPacks`), `i18n/es.json`, `scripts/sounds/{curate-packs.ts,pack-sources.json}`
(reproducible curation), `e2e/serve.mjs` (e2e catalogue), docs (README tool list, ARCHITECTURE §4.3, security review
AGT-3 table and §9). Tests: `apps/engine/test/sound-packs.test.ts`, `apps/mcp/test/sound-packs.test.ts` (+ the shared
`editor-window.ts`), `packages/engine-client/test/client.test.ts`, `apps/web/test/sound-packs-ui.test.tsx`,
`e2e/sound-packs.spec.ts`.

#### What it does (usage)

- **Preferences ▸ Sound Library ▸ Packs** lists the engine's catalogue: name, author, licence badge (CC0, BY…) with
  "Licence text" and "Pack page" links, the credit line (or "No credit required"), sound count, download and on-disk size,
  state (Not installed, Installed · n in the library, Update available, Damaged) and the description. **Install…** shows a
  confirmation with the size, the site it downloads from, the SHA-256 check, the licence and its URL, the credit line and
  where the licence was checked, with **Accept Licence and Download**; the row then shows the job's stage and percent
  (also in the Jobs panel) and "Adding its sounds to the library…" while the index job runs. **Remove** asks first
  ("Projects that already use them keep their own copies"). A job an agent started shows its progress and disables the
  buttons. An outdated pack offers **Update…**, a damaged one **Repair…** (files that already match are kept).
- **Sound Library**: the empty state has **Install Sound Packs…**, so does the panel menu (command
  `soundLibrary.installPacks`: opens the Sound Library preferences scrolled to and focused on Packs). Installed packs are
  collections **Sources › Packs › <pack>** (search `packId`).
- **Agents (MCP)**: `list_sound_packs` (READ_ONLY: licence, evidence, credit, sizes in MB, state); `install_sound_pack
  {packId, wait?, timeoutSeconds?}` (EDIT, `openWorldHint: true`; its description and `SOUND_GUIDE` tell the agent to
  tell the user the pack's name, download size and licence first; waits for the install and the index job by default);
  `remove_sound_pack {packId}` (DESTRUCTIVE_IDEMPOTENT; approval card; not installed → `removed: false`, nothing asked);
  `search_sounds {packId}`.
- **HTTP**: `GET /api/sounds/packs` → `{packs: SoundPackInfo[], catalogErrors}`; `POST /api/sounds/packs/:packId/install`
  → 202 `EngineJob` (`sound-pack-install`, deduped per pack; result `SoundPackInstallResult {packId, alreadyInstalled,
  sounds, installedBytes, downloadedBytes, indexJobId}`); `DELETE /api/sounds/packs/:packId` → `SoundPackRemoveResponse
  {packId, removed, removedSounds, freedBytes, job}` (`404 SOUND_PACK_UNKNOWN`, `409 SOUND_PACK_BUSY`, agents
  `403 APPROVAL_DENIED`). Help ▸ About ▸ Licenses lists each installed pack (`sound-pack:<id>`, its `License.txt`).
  Capabilities `features.sound.library.packs` = installed packs in the index.
- **Rebuild the catalogue** (network for `fetch` only):
  ```bash
  pnpm exec tsx scripts/sounds/curate-packs.ts fetch /tmp/packs   # checks each page's licence statement live, downloads, checks sha256 / size / License.txt
  pnpm exec tsx scripts/sounds/curate-packs.ts build /tmp/packs --report /tmp/packs/report.md   # measures every file, writes packs.json
  ```

#### Catalogue (measured by `curate-packs.ts`, 2026-10-17)

The ten packs of kenney.nl's Audio category (the seven sound-effect packs the starter kit samples, in full, plus Music
Jingles and the two voice-over packs). Every page's details table says "License: Creative Commons CC0" (checked live by
`fetch`) and every archive's `License.txt` says "License (Creative Commons Zero, CC0)
http://creativecommons.org/publicdomain/zero/1.0/" (checked by `fetch` and recorded verbatim as the second
`licenseEvidence` entry, `<archive url>#License.txt`). Kenney's site has no robots.txt restrictions. CC0: no attribution
(`attribution: null`); the voice-over pack's `Credits.txt` names its voices, kept as the files' author ("Kenney
(www.kenney.nl); voice: Jeffrey M. Smith" / "…; voice: Giselle").

| Pack | Page | Archive | sha256 (archive) | Bytes | Files (typed) | Installed bytes | Skipped |
|---|---|---|---|---|---|---|---|
| `kenney-casino-audio` | https://kenney.nl/assets/casino-audio | https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip | `f36250766ac5bc378c13708ddf12a23a8e54a3251f8d482c7536e51b5dbafa18` | 876 839 | 49 (49) | 485 917 | 6 |
| `kenney-digital-audio` | https://kenney.nl/assets/digital-audio | https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip | `24e6ce28b76a6d8c89cff4d331e0965ff5c3de8a73c612028e9d363cc64e4f06` | 990 367 | 55 (55) | 418 227 | 8 |
| `kenney-impact-sounds` | https://kenney.nl/assets/impact-sounds | https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip | `029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8` | 800 850 | 118 (118) | 930 610 | 12 |
| `kenney-interface-sounds` | https://kenney.nl/assets/interface-sounds | https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip | `f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232` | 834 536 | 89 (89) | 849 733 | 11 |
| `kenney-music-jingles` | https://kenney.nl/assets/music-jingles | https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip | `b729ba57959bd58793d2c5cafa348aaf2655d354f3da35ec4729e03ec77197b8` | 1 239 525 | 85 (0) | 1 277 878 | 1 |
| `kenney-rpg-audio` | https://kenney.nl/assets/rpg-audio | https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip | `6dbeaf8544da958d8f2adcb4a4a4b76c1ade34a05f8ab9edccd327da7375f38b` | 964 837 | 49 (44) | 700 072 | 3 |
| `kenney-sci-fi-sounds` | https://kenney.nl/assets/sci-fi-sounds | https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip | `119340f351a5098ad814f78719438c0da355a9ce8a4c8a3af6a8d48aa3d49e04` | 5 875 104 | 68 (49) | 5 859 215 | 5 |
| `kenney-ui-audio` | https://kenney.nl/assets/ui-audio | https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip | `946fc23a63d535d693eb31b2eabb80c8c28d6351e2186b344ceb71b2cb1d5eb6` | 411 949 | 45 (45) | 287 528 | 7 |
| `kenney-voiceover-pack` | https://kenney.nl/assets/voiceover-pack | https://kenney.nl/media/pages/assets/voiceover-pack/3f7f168698-1677589897/kenney_voiceover-pack.zip | `a5194df2f05f7ec439a8d4c1a7c20ba12ffe700d363a0733ae6fa826846af458` | 1 851 632 | 94 (0) | 1 907 365 | 1 |
| `kenney-voiceover-pack-fighter` | https://kenney.nl/assets/voiceover-pack-fighter | https://kenney.nl/media/pages/assets/voiceover-pack-fighter/6ceb77c6f1-1677589837/kenney_voiceover-pack-fighter.zip | `368ac0711e59521aff965a833e22e2b5218c397cf8b059ce3cb72e8d13219ee2` | 1 265 449 | 46 (0) | 897 701 | 1 |

Total: 698 files, 13.6 MB installed, 15.1 MB of downloads (measured, sum of the catalogue). Each file carries its own
sha256 and size; `License.txt` is installed too (pinned). **Skipped** (55, documented per file in `skipped`): the 46 files the
starter kit already ships unchanged (re-encoded there; installing them again would list the same sound twice), Kenney's
byte-identical duplicates (2, e.g. `footstep_carpet_001` = `_002`) and the 7 `Preview.ogg` medleys.

**Types by measurement**: `pack-sources.json` gives each file-name rule candidate types; `build` decodes every file with
the LGPL FFmpeg and keeps the candidates the judge (`analyzeSound` + `judgeSound` + `SOUND_TYPE_PROFILES`) accepts; when
it accepts none, the first candidate is kept (191 files: multi-hit clicks and taps — Kenney's press + release — 17 + 12,
boomy swishes / thumps / hits 14 / 11 / 9, clipped clicks 13, …; the same profile findings as WP1.2b) unless the rule is
`strict` (the space-engine and thruster loops tried as ambience / whoosh stay untyped: 19 files). The engine judges again
when it indexes; the real install of Interface Sounds gave 48 of 89 judge-ok, exactly the curation's 89 − 41. Music and
voice lines are untyped on purpose (`inferTypes: false`: a jingle in "Hit jingles" is not a hit) and found by words or
`packId`. Coverage by the packs: 17 types; **no recording of `key`, `riser`, `whoosh` (air) or `roomtone`** in any Kenney
pack (test-pinned).

#### BigSoundBank (decision 5): none included — ask a human

- **Licence: verifiable per file.** https://bigsoundbank.com/licenses.html (fetched 2026-10-17) says "This is: Creative
  Commons CC0 1.0 Universal WTFPL license … Public Domain Dedication" and "All files whose download page mentions 'Free and
  Royalty Free' are made available free of charge and freely for all your projects". Each sound page states it per file,
  e.g. https://bigsoundbank.com/whoosh-1-s0572.html: "License CC0 (public domain): Free and royalty-free", FAQ "I
  intentionally release it under the CC0 license (public-domain equivalent)", and JSON-LD `license:
  https://bigsoundbank.com/licenses.html` with direct `contentUrl`s (`/UPLOAD/bwf-en/0572.wav`, 1 044 826 bytes). So the
  CC0 grant (not WTFPL) could be recorded per file.
- **Why none is in the catalogue: the site's access policy.** https://bigsoundbank.com/robots.txt (updated 2026-04-16)
  has `Disallow: /UPLOAD/` for every robot, and https://bigsoundbank.com/ai.txt (2026-09-19) says the audio files "sit
  under /UPLOAD/, which is disallowed for every crawler" and "Real-time fetching to answer a user's question is welcome
  across the whole site, except /UPLOAD/". Curating "by measurement" means an agent downloading audio from /UPLOAD/, and a
  catalogue entry means the engine (and `install_sound_pack`, which agents may call) fetching /UPLOAD/ programmatically.
  Both go against the owner's stated wishes, so this package did not download any BigSoundBank audio (it only fetched
  pages and sent three HEAD requests while finding the download URLs, before reading ai.txt) and lists no item. **Ask a
  human**: whether to ask Joseph Sardin (the site's contact) for permission to fetch the files of a curated list from the
  app; the code needs nothing more (a `files` pack: one URL, sha256, size and `sourceUrl` = the sound's page per file is
  supported and tested), only the curation (`curate-packs.ts` would need a `files` source kind).
- The gaps the kit leaves (real risers, air whooshes, keyboard keys, bright hits, room tone) therefore remain; Jasper
  Synth covers `key` and the derived risers / whooshes of the starter kit stay the defaults.

#### Decisions

- **Same rules as the model catalogue**: pinned upstream URL + sha256 + size per archive and per file, an allowlisted
  licence (`SOUND_PACK_LICENSES`: CC0, CC BY 3.0/4.0, CC BY-SA 3.0/4.0; a non-CC0 pack must have a credit line), at least
  one `licenseEvidence` {url, statement, checkedAt}; built-in entries https only; `JASPER_SOUND_CATALOG` names another
  catalogue (http, file: and paths relative to it allowed; read on every request). Invalid entries are skipped and listed
  (`catalogErrors`), never thrown. Installs are open to agents (like model installs: catalogue-pinned and size-bounded),
  removals are gated (AGT-3).
- **No hosting, no conversion**: the engine downloads from the author's URL and installs the files as published (Kenney:
  OGG Vorbis, which the engine decodes); only listed files are extracted.
- **Install pipeline**: `.downloads/<id>-<sha16>.partial` (resumed by a Range request — or a file read from the offset —
  only for the same pinned bytes; a server that ignores Range restarts from 0; kept after a network failure or stall,
  deleted on cancel, checksum mismatch or an oversize body; stale ones deleted at engine start), stall timeout 60 s and
  total 30 min (`JASPER_SOUND_PACK_STALL_MS` / `…_TIMEOUT_MS` for tests), free-space check (`DISK_FULL`), archive sha256,
  then per member: declared size = pinned size (before inflating), sha256 after, written `wx` to
  `safeJoin(staging, catalogue path)`; `pack.json` (one pack; per file title, types, tags, author, licence, licence URL,
  source URL = the page, `inferTypes`; plus an `install` record with the catalogue revision) is validated by the index's
  own loader before the staging folder replaces the pack folder in one rename. Files of an installed or damaged pack that
  already match are reused (an update that only changed metadata downloads nothing).
- **States**: `installed` = valid pack.json, every file present at its size, same catalogue revision (a hash of files and
  metadata); `outdated` = another revision; `damaged` = unreadable pack.json or missing files; an installed pack the
  catalogue no longer lists is shown with `inCatalog: false` and can only be removed.
- **Index**: after an install the job starts (or joins) an incremental `sound-index` job and returns its id; a removal
  takes the pack's sounds and its `packs` entry out of the index at once and starts an index job, so a sound that is also
  in another source comes back under it.
- **Projects keep working**: registering a library sound always copies it into managed media (lossy pack files become
  padded PCM copies), so a removed pack never takes a project's media with it (tested by export).

#### Verified (measured, this branch; shared host, 16 cores, load average 2–12)

- `pnpm vitest run apps/engine/test/sound-packs.test.ts --maxWorkers=2`: 19 passed — the built-in catalogue validates
  entirely (10 Kenney packs, CC0, evidence, https, pinned sha256/sizes, known types, untyped ⇒ `inferTypes: false`, no
  duplicate bytes, > 30 starter-kit sources skipped, uncovered types exactly key / riser / roomtone / whoosh); hostile
  entries refused (11 kinds: `../`, absolute, backslash, hidden, non-audio, WTFPL, NC, BY without credit, case
  duplicates, no evidence, duplicate id) and https-only for the built-in catalogue; `safeJoin` property (2 000 runs,
  never outside its folder); install from file:// (only listed files + licence + pack.json, the archive's
  `../escape.wav` and unlisted member never written, no leftovers, index provenance, `packId` search, capabilities,
  Help ▸ About entry with the licence text, second install `alreadyInstalled` without index pass); archive sha256
  mismatch, member sha256 / size mismatch, missing member, catalogue zip-slip, size cap — each refused with nothing left;
  resume from a half file (file://); stale staging and partials cleaned at start; a `files` pack; over a local HTTP
  server: Range resume (206) and restart (server ignoring Range), cancel deletes the partial, a stall fails
  `DOWNLOAD_TIMEOUT` retryable keeping 2 048 bytes, an oversize body `PACK_TOO_LARGE`, removal during an install
  `409 SOUND_PACK_BUSY`; agents: installs open (`origin: agent`), removal refused without a window, card "Remove a sound
  pack" with name and "3 sounds", deny keeps it, approve removes, idempotent second removal asks nothing, unknown id 404,
  the editor never asked; a project using a pack sound renders it (peak > 0.2) and exports (job succeeded) after the pack
  was removed. **Mutation checks** (run, then reverted): skipping the approval card fails the agent test ("expected 200 to
  be 403"); skipping the size check before inflating fails the member test (`PACK_INVALID` instead of `PACK_CHECKSUM`).
- `pnpm vitest run apps/engine/test/fuzz-http.test.ts -t api/sounds --maxWorkers=2`: 12 passed (the 3 new routes found by
  the route fuzzer; no 5xx).
- `pnpm vitest run apps/mcp/test/sound-packs.test.ts apps/mcp/test/readme-tools.test.ts apps/mcp/test/conventions.test.ts apps/mcp/test/sound-guide.test.ts apps/mcp/test/fuzz.test.ts --maxWorkers=2`:
  371 passed (real engine + jasper-mcp over stdio: annotations, list, install with wait (job + index succeeded), search
  by pack, removal denied then approved on the card, idempotent second removal; README lists 352 tools).
- `pnpm vitest run packages/engine-client/test --maxWorkers=2`: 22 passed.
- `pnpm vitest run apps/web/test/sound-packs-ui.test.tsx apps/web/test/sound-library-panel.test.tsx apps/web/test/sound-i18n.test.tsx apps/web/test/i18n.test.ts apps/web/test/sound-library-model.test.ts apps/web/test/keymap.test.ts apps/web/test/polish-menu-wiring.test.ts apps/web/test/registry.test.tsx apps/web/test/agent-ui.test.ts apps/web/test/sound-cue-commands.test.tsx apps/web/test/review-stale-text.test.ts --maxWorkers=2`:
  all passed (10 new: list, licence before download and Cancel downloads nothing, Accept → install → index → Installed,
  Remove asks, external job progress and disabled buttons, Repair / Update, engine errors shown, CC BY credit in the
  confirmation, the command opens and focuses Packs once, empty state and panel menu, Sources › Packs › <pack> sends
  `packId`). `node scripts/i18n.mjs --check`: es.json covers all 9 700 strings.
- `E2E_PORT=51210 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-packs.spec.ts` (after `pnpm --filter
  @jasper/engine build` and `@jasper/web build`): 1 passed (30 s) — install via Preferences after the licence dialog →
  "Installed", "2 in the library" → Sources › Packs › E2E Test Pack lists 2 → insert (media provenance `pack`) → remove →
  `/api/sounds?packId=` total 0 → native export of the project, audio peak > 0.05. Screenshots in
  `test-results/e2e-sound-packs/` (looked at: the collection with both waveforms and CC0 badges).
- **Real check (network, dev engine on 51201, web on 51202, appdir `.stage`)**: Preferences ▸ Sound Library ▸ Packs
  showed the 10 packs (looked at the screenshot); Install on Interface Sounds showed "815 KB download from kenney.nl,
  checked against its pinned SHA-256; 89 sounds, 830 KB on disk. Licence: CC0-1.0 …"; Accept → the archive downloaded from
  kenney.nl, matched its sha256, 89 files + License.txt + pack.json installed; the index added them (status 168 sounds:
  starter 60, pack 89, synth 19; facets cc0 89; types swish 24, ui 31, click 20, glitch 9, tick 8, chime 6, pop 4,
  reverse 1; 48 judge-ok); `/api/licenses` listed "Interface Sounds — sound pack (89 sounds)" with its License.txt; the
  Library's Sources › Packs › Interface Sounds showed "89 of 168 sounds" with waveforms; "Minimise 6" inserted on A4;
  Remove (confirmed) deleted the folder (status 79 sounds, packs 0); the saved project's media (engine-store copy
  `mk_9147b0f2…`, provenance `pack`) exported natively afterwards with the sound in it (ffmpeg volumedetect max −12.0 dB,
  the clip's −11 dB default level).

#### Limits and notes for the next packages

- BigSoundBank: see above — none, pending a human's decision; the kit's gaps (risers, air whooshes, keys, bright hits,
  room tone) stay.
- Kenney's archive URLs carry a content hash; if Kenney republishes a pack, its install fails with `PACK_CHECKSUM` (the
  message says the file changed upstream) until `pack-sources.json` is updated and the catalogue rebuilt.
- 191 pack files keep a type the judge rejects (ranked lower by their judge score); 249 files are untyped (225 music /
  voice files, 19 sci-fi loops the judge rejected as ambience / whoosh, 5 RPG creaks and door openings by rule).
- The install reads the archive into memory (≤ 256 MB by the schema; Kenney's largest is 5.9 MB).
- The e2e harness points `JASPER_SOUND_CATALOG` at an (empty) file in its throwaway appdir, so e2e runs never download;
  Preferences there shows "This engine offers no sound packs" unless a spec writes one.

### Phase 6 → WP6.2 picture motion, scene and beat cues

Branch `feat/sd-p6-cue-sources`. Scope: spec 12 §2.2 (engine-only sources: scene cuts, beats, pixel motion curve), §2.8
(`POST /api/sound-design/motion` job `motion-analysis`, `POST /api/audio/beats`), §2.10 (`analyze_picture_motion`),
P6-R2. Phase 5's limit "NO_PICTURE_EVENT sees keyframed motion only; footage needs P6" is closed here.

Files. Model (pure): `packages/project/src/sound/cues/pixel-motion.ts` (`measureFrameMotion`, `pixelAnalysisSize`),
`cues/curve.ts` (`pixelMotionEvents`, `pixelMotionCues`, `pixelCutIndices`), `cues/engine-sources.ts` (`footageClips`,
`musicClips`, `sceneCutCues`, `beatCues`, `sceneAnchorAt`, `snapCuesToBeats`, `BEAT_SNAP_KINDS`), `cues/derive.ts` (engine
cues: dialogue, pixel fallback, `snapToBeats`), `cues/budget.ts` (merge tie-break), `cues/types.ts` (`anchorOffset`,
options, `stats.snappedToBeat`), `sound/anchor.ts` (`cueAnchorFrame`, scene `clipId`, exact remap pass),
`schema/sound.ts` (scene anchor `clipId?`, `SoundCue.anchorOffset?`, repair), `commands/{schemas,handlers}/sound.ts`
(`anchorOffset` on add / update / resync), `sound/repair.ts` (duplicate remaps scene `clipId`), `sound/cue-input.ts`,
`sound/messages.ts`. Audio: `packages/audio-fx/src/analysis/remix.ts` (`analyzeBeats`, the remix tracker shared). API:
`packages/api/src/audio-fx.ts` (`BeatsRequest/Result`), `sound-design.ts` (`MotionAnalysis*`, `EngineCue`, cue-route
`snapToBeats` / `analyze` / `analysis` / `engineCues` / warning `jobIds`, plan style `snapToBeats`), `jobs.ts`
(`motion-analysis`), `routes.ts` (`soundDesignMotion`, `audioBeats`); client `analyzeMotion`, `audioBeats`. Engine:
`apps/engine/src/sound-design/motion.ts` (MotionService, job, plan, cache), `engine-cues.ts` (EngineCueSources: submit /
inline / cached), `analysis-cache.ts`, `audio/beats.ts` (BeatService, `decodeMono`), `time/scenes.ts` (result cache,
`cachedCovering`, `detectInline`), `routes/{sound-design,audio-fx,time}.ts`, `sound-design/{plan,check}.ts`. MCP:
`apps/mcp/src/tools/sound-motion.ts` (`analyze_picture_motion`), `motion-strip.ts` (the PNG), `tools/sound-design.ts`
(`find_sound_cues` engine sources, `snapToBeats`, waiting; `plan_sound_design` `style.snapToBeats`), `tools/sound.ts`
(guide). Web: `apps/web/src/sound/cues/EngineSources.tsx` (hook + rows), `suggest.ts`, `SuggestCuesDialog.tsx`,
`AutoSoundPassDialog.tsx`, `seam.ts`, `commands/sound-cues.ts`, i18n (17 strings, es.json complete). Fixture
`box-move.mp4` in `scripts/make-fixtures.mjs`. Docs: README (353 tools), security review (route row + paragraph),
ARCHITECTURE §4.3 (`sounds/analysis/`), gaps.

#### What it does (usage)

- **Picture motion** (`POST /api/sound-design/motion {projectId, sequenceId?, range?}` → 202 job `motion-analysis`;
  MCP `analyze_picture_motion`): the sequence's picture is rendered small through the export service and measured per
  frame. Result `MotionAnalysisResult`: `curve` (per frame: `speed` of what moves in screen diagonals per second — the
  keyframe source's unit —, signed `vx`/`vy`, moving `area`, its centre `cx`, `residual` = change motion does not explain,
  `diff`), `events` (move `{start, end, frame, peakSpeed, area, global, direction, pan, panSweep}`, land `{frame, how}`,
  cut `{frame, residual}`), `edits`, `fingerprint`, `cached`, `renderPath`, `timings`, `warnings`. At most 10 minutes per
  analysis (`RANGE_TOO_LONG`), `RANGE_EMPTY` under 2 frames.
- **Beats** (`POST /api/audio/beats {mediaKey, streamIndex?, startSeconds, durationSeconds ≤ 30 min}`, synchronous):
  `{bpm | null, beats[] (media seconds of each attack), downbeats[] | null, downbeatConfidence, analysedSeconds, reason?:
  NO_BEAT, cached}`.
- **Cue route** (`POST /api/sound-design/cues`): `opts.sources` may name `scene`, `beat`, `pixel` (never by default: the
  default stays the edit's own sources, so nothing expensive starts unasked); `opts.snapToBeats`; `opts.analyze: false`
  uses only what is measured. The answer adds `analysis[source] = {state: ready | pending | missing | none | failed,
  jobIds, found, message?}`, `engineCues` (the measured cues before merging) and, while a job runs,
  `W_ANALYSIS_PENDING {source, jobIds}` (never a silent omission); `W_ANALYSIS_FAILED`, `W_NO_BEAT`,
  `W_MEDIA_UNAVAILABLE`, `W_ANALYSIS_TRUNCATED`. Suggestions may carry `anchorOffset`.
- **Plan job**: `style.cueSources` with engine sources measures them inside the job (progress "Picture motion: …");
  `style.snapToBeats`.
- **MCP** `find_sound_cues {sources: ["pixel"|"scene"|"beat"…], snapToBeats?, waitForAnalysis? (default true),
  timeoutSeconds?}` waits for the jobs it started and derives again; `analyze_picture_motion {projectId, range?, images?,
  thumbnails?}` → events in words, pooled curve (≤ 400 points), ONE PNG (frames at the events above the speed / area /
  residual curves, every event marked, timecode axis, legend).
- **Editor**: Suggest Cues… and Auto Sound Pass… have "Measured in the media": Shot changes inside footage, Music beats,
  Picture motion in footage — counts "n found · k kept", "Not analysed yet" + Analyze… (starts the job, shows "Analysing…
  45 %", asks again when it ends), "No footage in the range" / "No music clip in the range"; "Snap moves and transitions to
  the beat (within 2 frames)" (analyses the beats on the spot when needed). Auto Sound Pass… measures unanalysed sources
  while proposing.
- **Sound Check**: NO_PICTURE_EVENT also counts measured picture events (cached motion and shot changes; Sound Check never
  starts an analysis) and the measured motion curve; STALE_CUE honours `anchorOffset`.

#### Design and decisions

- **The picture, not the media.** Motion is measured on the rendered sequence (`ExportService.renderToFile`: the export
  planner, its paths, fallbacks and blockers — what the Program monitor shows and an export writes), not on the source
  files: footage under graphics, scaled or cropped clips and nests are measured as seen. 128 px long side (16:9 →
  128×72; spec: "e.g. 64×36"; 128 gives 8 px blocks enough texture), H.264 intra at ≈ 3 bits per pixel (no GOP
  artefacts), picture only, smart rendering off; decoded to gray by ffmpeg in the job (cancel kills it). A refusal of the
  planner fails the job with its code.
- **Measurement** (`measureFrameMotion`): 8×8 blocks; still when the unmoved cost is ≤ 1.5 gray levels per pixel or the
  block has < 2 levels of mean gradient (flat areas are ambiguous); else a coarse search ±6 px on half-size frames, ±2 px
  refinement, then one Lucas–Kanade step (sub-pixel; the parabola fit when the gradients are degenerate). A block moves
  when its match costs < 50 % of staying put AND ≤ 10 gray levels per pixel (across a cut every block finds a "match", none
  that close) and |v| ≥ 0.3 px. Frame speed / direction = the MEDIAN over moving blocks (outliers at edges), 0 under 2
  moving blocks. `residual` adds the unmoved cost of blocks motion does not explain. Found by tests: the first version
  (mean vector, gain 0.7, no cost cap) read a cut between two textures as 10 px motion on 88 % of the frame with residual
  0.08; a 0.7 px/frame move was invisible without the LK step.
- **Events share the keyframe source's thresholds** (`speedSegments`, MOVE_ON 0.12 / MOVE_OFF 0.03, bridge
  max(2, 0.1 s), ≥ 2 frames, ABRUPT_STOP 0.35, the 0.3 s whoosh / swish split, impact bands 0.5 / 0.15). Measured speeds
  are noisy, so the move's frame is the middle of the stretch within 10 % of the peak (keyframes: 10⁻⁴). Land = the first
  reversal along the peak's direction (overshoot; a second = bounce) or the arrival when the last moving frame keeps
  ≥ 35 % of the peak. Cut = residual ≥ 0.08 and ≥ 3× the median of the surrounding second and a local maximum; the curve is
  split at cuts and edit points (motion never spans them), edit points are not reported again (the edits source has them).
  Pan: ≥ 50 % of the frame moving = a camera move → sweep ±40 the way the picture travels (when |vx| ≥ ¼ |v|); else pan at
  the moving parts' x (±60) with a sweep from where they start to where they end (≥ 10 units).
- **Pixel cues are a fallback**: confidence ≤ 0.5 (move 0.3 + 0.2·min(1, peak); land 0.45 / 0.5; cut 0.4), weight support
  (a measurement never makes a hero). Anchored only where footage is shown (`sceneAnchorAt`: the topmost enabled video
  clip of a media at the frame → `{type: 'scene', mediaId, mediaSec: the media time it shows there, clipId}`); events over
  graphics alone are left out (their sources describe them). In `deriveCues` a pixel cue gives way to a project source
  describing the same event (its frame within 3 frames of it, or inside its window ± 2: counted as `merged`), and at equal
  weight a merge keeps a project source's cue as primary (its exact anchor) before an engine one (new tie-break, after
  weight and explicit).
- **Scene anchors gained `clipId`** (optional; schema, repair of `sequence.duplicate`, refs): the same media used twice
  resolves each cue to its own clip; the earliest showing remains the fallback when that clip is gone. The resolver's
  time-remap / frame-hold branch first looks for a frame showing the media time exactly: in slow motion several frames lie
  within half a frame of it and the old rule returned an earlier one (found by the 40 % remap round-trip test).
- **Shot changes** (Scene Edit Detection, sensitivity 50, shots ≥ 2 frames, per media over the union of the ranges its
  clips show, ±(0.5 s + a frame), on a half-second grid): a change at media time c is a cue at the first frame whose shown
  media time crosses c, through speed, reverse, time remap and frame hold (`clipMediaTimeFn`; the rule of
  `clip.applySceneEdits`, with 1 ms of tolerance for frame timestamps written to the µs); reversed, that is the first frame
  of the old shot. Not on a clip's first frame (an edit point). `cut` (support, 0.45, hit / thump / transition / glitch /
  click) — or `move` (whoosh / swish, 0.4) when the detector's score stays ≥ 60 % of its threshold on both neighbouring
  frames (a smeared change). Results are cached by SceneService (file fingerprint + settings + range; a cached range
  covering the request is reused) — Scene Edit Detection itself benefits.
- **Beats** (`analyzeBeats`): the remix tracker (tempo by autocorrelation with the 120 BPM prior, DP beats, trimmed ends),
  each beat moved to the strongest 1 ms-RMS rise within 1.5 hops of the flux estimate (attack, not the remix's joint
  position). Downbeats: 4/4 assumed; the phase of four whose beats have the strongest onset is used when it is ≥ 15 %
  above the other phases' mean over ≥ 8 beats, else null. Beat cues: Essential Sound **music** clips on unmuted tracks
  only (`essential.type`), anchor `{type: 'beat', clipId, beatIndex, mediaSec}`, kind `beat`, downbeats support 0.35, other
  beats ambient 0.25 — so sparse (min 0.4) keeps none, balanced (0.3) the downbeats, rich (0.15) all; never heroes.
  Analysed inline (fast) and cached per file and range; ≤ 32 music clips per call.
- **Snap to the beat** (`deriveCues` `snapToBeats` + `beatFrames`; route / plan / dialogs): after budgets, cues of kinds
  that tolerate it — move, transition, emphasis, reveal (Sound Check tolerances ≥ 2 frames, not impacts) — move onto the
  nearest beat within 2 frames; never cuts, lands, appear / exit, markers or beats. The shift is kept as
  `SoundCue.anchorOffset` (new optional field, −10…10, schema + repair; `soundCue.add` refuses it without an anchor,
  `soundCue.update` drops it with the anchor, `soundCue.resync` and Sound Check's STALE_CUE resolve anchor + offset
  — `cueAnchorFrame`), so a snapped cue keeps following its picture event 2 frames off, and "never more than 2 frames from
  explicit motion" holds by construction. The reason says "…; on the beat (+2 frames)".
- **Never silently omitted**: the cue route starts missing analyses (scene-detect / motion-analysis jobs, deduplicated by
  fingerprint) and answers `pending` with the job ids; a failed job is reported (`failed`, `W_ANALYSIS_FAILED`) and not
  restarted for 5 minutes. Engine sources are opt-in everywhere (route, MCP, plan, dialogs): an unasked request derives
  exactly as before (the Phase 2 cue-route and web-equivalence tests are unchanged).
- **Inline in jobs**: the plan job runs scene detection and motion analysis inside itself (`detectInline`,
  `analyzeInline`, progress mapped with `subContext`) — a job waiting for another job's slot could deadlock the queue.
- **Caches**: `<appdir>/sounds/analysis/{motion,beats,scenes}/<sha>.json`, atomic writes, read through their zod schema,
  newest 300 / 2 000 / 2 000 kept; the motion key is the picture fingerprint = the render-preview segment hashes over the
  range + size + rate + version (any picture edit misses; audio edits do not). The motion job takes half the CPU slots
  (`max(2, ⌈slots / 2⌉)`, min 1) — its render is an export.

#### Verified (measured, this branch; shared host, 16 cores)

- `pnpm vitest run packages/project/test/sound-cues-engine.test.ts --maxWorkers=2`: 27 passed — frame motion (still → 0;
  a box 3 px right → vx 2.7–3.3, |vy| < 0.3, area 1–25 %; up-left; 9 px (coarse search); a 2 px camera pan → area > 0.8,
  vx −2.2…−1.8; half a pixel → 0.5 ± 0.15 (LK); 0.7 px box ± 0.25; a cut → residual > 0.1; hostile sizes / buffers →
  still; 40 random frames finite); curve events on synthetic curves (constant move with an abrupt stop: window 120–140,
  move 129, land 139; ease-out → no land; drift under MOVE_ON → nothing; overshoot → land at the turnaround 124; bounce;
  camera pan sweep +40 → −40 for leftward travel; a cut at 145 reported once and splitting the motion; an edit there not
  reported but still splitting); cues (confidence ≤ 0.5, support, whoosh, hit by impact, unanchored left out); 200
  fast-check hostile curves deterministic; footage / music listing; scene cuts at 100 % (60, 135), 200 % (30, 68), reverse
  (the frame showing 59/30 s), a 40 % time remap — every anchor resolves back to its frame, and follows a moved clip; a
  soft change → `move`; the same media twice → each cue to its own clip, the first showing after the clip is lifted;
  topmost footage anchors; beat cues (frames 8, 23, 38, 53; downbeats support; 50 % speed doubles spacing; resolve back;
  not music → none); snapping (only the move 2 frames off moves; offset 2 stored; `cueAnchorFrame`); deriveCues: scene cut
  under dialogue suppressed (`suppressedByDialogue` 1) and back with `respectDialogue: false`, a pixel move 2 frames from a
  keyframe move given way (`merged` 1), kept without the keyframe source; snapToBeats on a derived move (+2, resync keeps
  it on the beat and follows the clip, explicit `beatFrames`); `anchorOffset` add / undo (untouched document) / redo (same
  document) / dropped with the anchor / refusals (no anchor, 11) / repair; testkit fuzz of the mappers (mutateJson, 200
  cases; found `snapCuesToBeats` crashing on a non-array `beatFrames` — fixed). `FUZZ=1 FUZZ_SEED=777` (20×) then hung
  at case 2841: a music clip starting at frame 2⁵³ + 2 passed `Number.isInteger`, and the frame loop `f += 1` never
  advanced there — clips must now be safe integers ending before frame 10 368 000 (regression test "a clip starting at
  1e20 does not hang"); after the fix `FUZZ=1 FUZZ_SEED=777 pnpm vitest run packages/project/test/sound-cues-engine.test.ts`
  27 passed (32 s) and `FUZZ=1 FUZZ_SEED=2026 … -t hostile` 4 passed.
- `pnpm vitest run packages/audio-fx/test/beats.test.ts packages/audio-fx/test/remix.test.ts --maxWorkers=2`: 10 passed —
  click tracks at 90 / 100 / 120 / 128 BPM: tempo within 1 BPM, every beat within 5 ms of its click; accented every 4
  beats → downbeats on the accents within 5 ms, an even track → null; the generated test music (120 BPM, beats within 12 ms
  of the drums, deterministic); 48 kHz; noise / silence / 2 beats → NO_BEAT. The remix tests are unchanged (the tracker
  was only factored out).
- `pnpm vitest run apps/engine/test/sound-design-motion.test.ts --maxWorkers=1` (generated 1080p footage; system ffmpeg
  to make it, the engine's for the rest): 8 passed (+1 perf, opt-in) — the box rests, moves 20 px per frame (1.33 px at
  128 px) and stops: move start 31 ± 2, end 61 ± 2, direction right, not global, land 60 ± 2 "abrupt stop", still before
  and after (< 0.03), the median moving speed within 15 % of 0.272 screens/s, cached the second time; pixel cues on the
  clip moved to 10: first answer `pending` with the job id and no pixel cues, then a move whose window starts 39–43 and a
  land at 70 ± 2, anchors `scene` with the clip, resolving back, deterministic; scene cuts at 60 (and 30 at 200 %) after a
  pending job; `/api/audio/beats` on a 120 BPM click WAV (beats within 5 ms, downbeats, cached, 404 / 400s); beat cues
  within ±1 frame of the clicks and a keyframed move snapped onto a beat; the plan job measuring motion inline (its report
  has `pixel:` cues; the analysis is cached for the route); Sound Check after analysis: a derived cue at the landing
  passes NO_PICTURE_EVENT, one at frame 100 (still) does not — and on a picture never analysed both are flagged;
  cancellation → `cancelled`; refusals 400 / 404 / RANGE_EMPTY / RANGE_TOO_LONG.
- **Performance** (`SOUND_PERF=1 SOUND_PERF_OUT=… pnpm vitest run apps/engine/test/sound-design-motion.test.ts -t perf`):
  one minute of 1080p30 footage (1 800 frames), native path: **46.8 s** (render 46.1 s, measure 0.52 s) at load 11–12 with
  2 slots, **41.0 s** (render 40.4 s, measure 0.42 s) at load 7–13 with half the slots (8). The render composites at the
  sequence's 1920×1080 before scaling to 128 px (the job log's filter graph) — that is the cost, not the measurement.
- `pnpm vitest run apps/mcp/test/sound-motion.test.ts --maxWorkers=1` (real engine on 49571, jasper-mcp over stdio): 1
  passed — `find_sound_cues {sources: ["pixel"]}` waits for the job and returns the move (window 31 ± 2, anchorText
  "… s into box.mp4 in 'box.mp4'") and land (60 ± 2), `analysis.pixel` ready; `analyze_picture_motion` (cached) events
  with timecodes, "moves right", 120-point curve, ONE 1 200 px PNG with a thumbnail per event; strict arguments, RANGE_EMPTY,
  E_INVALID_PARAM. **Looked at the PNG** (`MOTION_STRIP_OUT`): the two thumbnails (box left at 01:08, further right at
  02:00), the speed curve above the dashed move threshold over the shaded move span 01:00–02:00, the landing line at
  02:00 — the look found stretched thumbnails (fixed: the picture's aspect, centred).
- `pnpm vitest run apps/web/test/sound-engine-sources.test.tsx --maxWorkers=1`: 3 passed — opening asks with `analyze:
  false` (nothing starts), "Not analysed yet" → Analyze… → `analyze: true` → the job followed → "2 found · 0 kept" → ticked
  "2 found · 2 kept" → Suggest adds move 45 / land 60 with `scene` anchors in one History entry; an engine error leaves
  the edit sources usable ("Analysis failed" ×3); `planSuggestion` snapping (+2, `anchorOffset` 2).
- `E2E_PORT=51303 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-cue-sources.spec.ts` (after `pnpm build`): 1
  passed (13 s) — `box-move.mp4` imported, Suggest Cues…: Picture motion "Not analysed yet", music "No music clip in the
  range" → Analyze… → "2 found · 0 kept" → ticked → Suggest 2 Cues → move window 31 ± 2, land 60 ± 2 (29.97 fps
  sequence), anchor `scene`, reason "Picture motion…", Cue Seam shown, one Ctrl+Z removes both. Screenshots looked at
  (`test-results/e2e-sound-cue-sources/`): the dialog before (three engine rows, two Analyze… buttons, beats greyed with
  its reason), after (Picture motion ticked, 2 found · 2 kept), the timeline with the two glyphs over the clip and the
  "Suggested 2 cues" toast.
- Regression suites: `apps/engine/test/{sound-design-cues,sound-design-plan,fuzz-http,server,security-review}.test.ts`
  230 passed (the fuzzers discover the two new routes); `apps/engine/test/{time-export,audio-fx,sound-check}.test.ts` 29
  passed; `packages/project/test/sound*` 320 passed after adding the refusal template; `packages/api`,
  `packages/engine-client` 39 passed; `apps/mcp/test/{readme-tools,conventions,sound-guide,fuzz}.test.ts` 370 passed;
  `apps/web/test/{auto-sound-pass,sound-cue-commands,sound-cue-seam,sound-p2v-suggest,sound-cue-seam-model,i18n}` +
  the engine cue-route test 61 passed; `node scripts/i18n.mjs --check`: es.json covers all 9 717 strings.
- **After merging the integration branch** (`8af31459`, WP5.2's panel): `pnpm typecheck` (every package) and `pnpm lint`
  (Biome, tokens, anime, layers, assets) pass; `node scripts/i18n.mjs --check` 9 835 strings; the engine and MCP suites
  above plus `sound-check`, `time-export`, `audio-fx` and the MCP fuzz: 14 files, 639 passed (1 opt-in perf skipped),
  `--testTimeout=900000` at load 40–70; `packages/project/test/sound*`, audio-fx beats + remix, api, engine-client and the
  web dialog tests: 429 tests, 424 passed in a run at load ≈ 60 — the 5 failures were timeouts (60 / 120 s limits, a < 1 s
  perf bound at 4 s) of files this package does not change the hot paths of; rerun at `--testTimeout=900000`
  (`sound-cues`, `sound-mix`, `sound-p2v-model`: 86 passed) and serially (`remix`, `sound-cues-property`: passed).

#### Limits and notes for the next packages

- The picture render dominates (≈ 0.7× real time for 1080p at moderate load, measured above): long sequences take
  minutes the first time (10-minute windows, each one job; cached after). Using existing render previews or rendering the
  composite at a reduced canvas would be faster but is not exact (a smaller canvas changes pixel-space layouts) — not done.
- Sensitivity: motion slower than ≈ 0.6 px per frame at 128 px (≈ 0.12 screen diagonals per second, MOVE_ON) is not a
  move; objects of ≤ 2 blocks (16 px of 128, ≈ 12 % of the width) are below `PIXEL_MIN_BLOCKS`; flat-coloured objects are
  measured by their textured edges only. Pixel events over graphics alone are not cues (the project sources cover them).
  Zooms and rotations read as motion of many blocks in different directions (median direction weak; no pan sweep).
- Beats: the tracker can lock to half the tempo of very regular fast material (a pure 150 BPM click track read as 75;
  generated music at 120 BPM is right); downbeats assume 4/4 and need an accent; music under 4 beats → `W_NO_BEAT`.
- Scene detection is per media range (union of what the clips show); trimming a clip outside its analysed range starts
  another analysis. The tolerance of `clip.applySceneEdits` (1 flick) is stricter than this source's (1 ms); not changed
  here (no failing case was built).
- `anchorOffset` is only written by snapping; dragging a cue on the Cue Seam detaches its anchor as before.
- The visual route (`/api/sound-design/visual`, `view_sound_timeline`) still draws the keyframe motion curve only.
- The web Suggest Cues… asks the engine with the project id (the live document), so engine counts follow the open editor;
  an edit while the dialog is open is measured on the next Analyze… / reopen.

### Phase 6 → WP6.3 Auto Tag and dialogue awareness

Branch `feat/sd-p6-autotag`. Scope: spec 12 P6-R3 — Essential Sound **Auto Tag** (classify a clip as dialogue, music,
SFX or ambience; command, MCP tool, UI action, badge) and transcript- and VAD-aware dialogue suppression with ONE
dialogue definition for cue derivation, the plan, the solver's dialogue guard and Sound Check.

Files. Audio (pure): `packages/audio-fx/src/analysis/audio-category.ts` (`audioCategoryFeatures`, `classifyAudio`,
constants). Model: `packages/project/src/essential/model.ts` (`AutoTagSchema`, `EssentialSound.tagged`,
`essentialAutoTag`, presets keep the mark), `commands/schemas|handlers/essential.ts` (`essentialSound.autoTag`; `setType`
confirms), `catalog.ts` ("Auto Tag Audio Types"), `sound/cues/dialogue.ts` (`dialogueSpans`, `dialogueFrameRanges`,
`dialogueVadClips`, `VoiceActivity`), `cues/edits.ts` (`dialogueRanges` / `sequenceDialogueRanges` delegate),
`cues/derive.ts` (`voiceActivity`, heroes under dialogue), `cues/types.ts`, `cues/util.ts`. API: `packages/api/src/
audio-fx.ts` (`AudioClassify*`), `sound-design.ts` (cue route `voiceActivity`, `voice`, `dialogue[].clipIds|trackIds|
sources`, `stats.heroesUnderDialogue`, `opts.voiceActivity`), `jobs.ts` (`audio-classify`), `routes.ts` (`audioClassify`);
client `classifyAudio`. Engine: `apps/engine/src/audio/classify.ts` (ClassifyService, job, cache), `routes/audio-fx.ts`
(route), `sound-design/voice.ts` (VoiceActivityService), `routes/sound-design.ts` (cue route), `sound-design/plan.ts`,
`bed.ts` (solver speech), `check.ts` (MUSIC_OVER_VOICE segments; a 12-line change). MCP: `apps/mcp/src/tools/
audio-fx.ts` (`auto_tag_audio`, guide), `tools/sound.ts` (SOUND_GUIDE), `tools/sound-design.ts` (`find_sound_cues`
`voice`). Web: `apps/web/src/audio-fx/{ops,commands}.ts` (`autoTagClips`, `audio.autoTag`, the clip menu entry),
`panels/essentialSound/EssentialSoundPanel.tsx` (Auto Tag button, auto banner), `sound/register.tsx` (dotted badge),
`shell/menus/model.ts`, `sound/cues/{EngineSources.tsx,suggest.ts,SuggestCuesDialog.tsx}` (voice activity into the
dialog's derivation), i18n (25 strings, es.json complete). Docs: README (355 tools after merging Phase 5 verification, HTTP section), ARCHITECTURE §4.3
(`sounds/analysis/{classify,voice}`), security review (route row + paragraph), gaps. Tests: listed under Verified.

#### Premiere's Auto Tag (research; sources)

helpx.adobe.com answers 403 to this host, so the behaviour comes from search-indexed excerpts of Adobe's page
"audio auto tagging" (https://helpx.adobe.com/premiere-pro/using/audio-auto-tagging.html, quoted by the search engine),
Adobe's beta announcement thread "Now in Beta: Auto Tag your audio clips with AI"
(https://community.adobe.com/t5/premiere-pro-beta-discussions/now-in-beta-auto-tag-your-audio-clips-with-ai/m-p/13897306),
the community threads on disabling it (https://community.adobe.com/t5/premiere-pro-discussions/disable-essential-sound-tagging/m-p/14660808)
and Adobe's media alert for the 24.x audio features (https://news.adobe.com/news/news-details/2024/media-alert-adobe-premiere-pro-innovations-make-audio-editing-faster-easier-and-more-intuitive).
What they document, and what we match:

| Premiere (documented) | JasperEditor |
|---|---|
| Four tags: Dialogue, Music, SFX, Ambience | the same four Essential Sound types |
| Select one or several clips and run **Auto Tag** in the Essential Sound panel | Essential Sound ▸ **Auto Tag** on the selection (untyped clips; "Auto Tag untyped clips" when some have a type; Shift-click also re-tags the types you set) |
| Right-click a clip, or the Clip menu: **Auto Tag Audio Types** | clip context menu and Clip ▸ Audio Options ▸ **Auto Tag Audio Types** (`audio.autoTag`, agent-exposed) |
| Each tagged clip gets an interactive badge; clicking it opens Essential Sound with that type's tools | the clip's audio-type glyph (WP2.4b); while the tag is Auto Tag's and unconfirmed it is drawn **dotted** with the confidence in its tooltip / aria-label (our addition: Premiere does not distinguish a guessed type from a chosen one); clicking selects the clip and focuses Essential Sound |
| A wrong tag: **Clear Audio Type** | Clear Audio Type as before, plus **Confirm** / **Change…** on the panel's "Auto-tagged as Music · 82 % confident" banner (our addition) |
| Uses an AI model | deterministic rules over measured features (below) — no model, no network; cached |
| Preferences ▸ Audio ▸ "Auto-tag audio types in the timeline" tags clips as they are added | **not done** (decision: tagging on every placement would start engine jobs behind the user's back in every edit and every e2e; left for a follow-up with the preference off by default) |
| The panel shows which tags were found; clicking a tag selects all clips of that category | not done |

Undocumented, chosen as most plausible: Premiere never replaces a type the user set (we refuse unless `force`, code
`USER_TYPE`); a silent clip is left untyped; re-running Auto Tag on an auto-tagged clip may change it.

#### How the classifier works (`classifyAudio(audioCategoryFeatures(windows, durationSec))`)

Input: up to 8 windows of planar audio (each ≤ 60 s) and the clip's real length; mono mix, NaN/±Inf as 0, resampled to
16 kHz (4th-order low-pass at 7.2 kHz + interpolation). The engine decodes ranges ≤ 60 s whole, longer ones as four 15 s
windows at the start, ⅓, ⅔ and end; each window is measured alone (no joins) and pooled by audible time.

Features (10 ms hops; `AudioCategoryFeatures`): activity over the speech module's VAD threshold (`vadThreshold` rule: 30 %
between the 10th and 95th percentile levels, ≥ 6 dB over the floor, ≥ −60 dBFS) and audibility (≥ −65 dBFS and within
40 dB of the 95th percentile); dynamic range (95th − 10th percentile); bursts; Scheirer & Slaney's low-energy frames
(< ½ the mean amplitude of the surrounding second); **syllabic modulation** = 2.5–8 Hz modulation energy of the 300–3400 Hz
envelope over Hann-windowed 2.56 s blocks ÷ its squared mean (Houtgast & Steeneken; Scheirer & Slaney's "4 Hz modulation
energy"); YIN pitch (de Cheveigné & Kawahara 2002) at ≤ 8 kHz every 20 ms over active frames: voiced ratio, f0 in
70–400 Hz, steadiness (consecutive voiced frames within 0.12 semitone), glide, voiced run length; **tonal persistence**
(64 ms frames, 48 ms hop: spectral peaks ≥ 10 dB over the spectrum 3–4 bins away and ≥ 15 dB over the frame median, still
there ±1 bin 192 ms later — noise maxima stand ≈ 5 dB over their neighbours, so low-passed noise has none); onsets (log band
flux, 20 bands 60 Hz–7 kHz, 20 ms) and their **periodicity** (best normalised autocorrelation over 0.24–1.5 s, ≥ 3
periods); stationarity (std of the 1 s levels; mean RMS change of the level-free 1 s band spectrum); long-term flatness
and centroid; active span and the drop of its last 10 %.

Rules (ramp(x, a, b) = 0 at a … 1 at b; constants in the code, chosen on the tuning set below):

| Score | Formula |
|---|---|
| dialogue | voice (voiced 0.15→0.4 × speech pitch 0.5→0.8) × modulation (0.1→0.3) × mean(glide: 1 − steady 0.3→0.55, short runs: 1 − 0.25→0.6 s, pauses: low-energy 0.1→0.25) × (1 − 0.8·beat) × length 0.4→1 s |
| music | length 3→6 s × max(beat × (0.6 + 0.4·max(tonal, steady)), tonal × (0.5 + 0.5·steady)) × (1 − 0.5·voice·modulation); beat = periodicity 0.3→0.55 × onset rate 0.5→1.2 /s × onsets 4→8; tonal = persistence 0.35→0.6 × tonal frames 0.25→0.55 |
| ambience | length 2.5→6 s × audible 0.6→0.9 × stationary ((1 − colour change 1.5→4 dB) × (1 − level std 3→8 dB)) × (1 − beat) × (1 − 0.7·tonal) × (1 − 0.8·voice·modulation) |
| sfx | max(short: 1 − length 1→6 s, 0.8 × evolving (max of tail drop 10→25 dB, level std 3→8 dB, range 15→30 dB) × (1 − stationary) × (1 − length 10→30 s)) × (1 − 0.6·max(other scores)) |

Category = the best score (ties: sfx); confidence = its share of the squared scores × min(1, best ÷ 0.5); "low" under
0.6 (`LOW_CATEGORY_CONFIDENCE`). Silent (peak < −70 dBFS) → `silent: true`, confidence 0, never tagged. Reasons name the
evidence ("voiced 57 % of the active time…", "a steady pulse (onset periodicity 0.94…)", "short (0.27 s)", "steady bed
over 20 s…").

#### Model, command, route, tool, UI

- `EssentialSound.tagged?: {by: 'auto', confidence, scores?, reasons?}` (optional loose field; an older build keeps the
  type and drops nothing it reads; an unreadable mark is dropped by `readEssentialSound` / `repairDocument`, INV-ESSENTIAL;
  no schema bump: nothing is lost by a build that ignores it).
- `essentialSound.autoTag {results: {clipId: {category, confidence, scores?, reasons?}} (1–2 000), force?, minConfidence?}`
  ("Auto Tag Audio Types", one undo step): untyped → the type's defaults + the mark; an auto clip of another type →
  re-tagged (defaults); the same type → the mark refreshed, settings kept; a type the user set → `USER_TYPE` (or `SAME`)
  unless `force`; under `minConfidence` → `LOW_CONFIDENCE`. Result `{tagged: [{clipId, audioType, confidence, from}],
  skipped: [{clipId, code, reason}]}`. Refusals: unknown clip `E_NOT_FOUND`, not audio `E_INVALID_PARAM`, locked track
  `E_TRACK_LOCKED`, empty / malformed / > 2 000 `E_SCHEMA`. **Confirm** = `essentialSound.setType` with the same type
  (removes the mark, keeps settings and effects; result `confirmed`); **Change** = `setType` with another type (no mark).
  A slider change does not confirm. Presets keep the clip's mark and never carry one.
- `POST /api/audio/classify {projectId | envelope, sequenceId?, clipIds} | {mediaKeys, streamIndex?}` (`?wait=1`) → job
  `audio-classify` ("Auto Tag audio (n items)", shown in the Jobs panel; two decodes at once) → `AudioClassifyResult
  {items: [{clipId?, mediaKey?, name, currentType?, autoTagged?, startSeconds, durationSeconds, result: {category | null,
  confidence, scores, reasons, silent, durationSec, analysedSec, features} | null, error?, cached}], counts, lowConfidence,
  version, ms}`. A clip is classified over the media range it plays (speed, reverse, time remap). Cached by file
  fingerprint + stream + range (ms) + `AUDIO_CATEGORY_VERSION` under `<appdir>/sounds/analysis/classify/`. Refusals 400
  (both or neither list, bad media key, > 500), 404 (project, sequence, no clip / media found); per-item errors
  `NOT_AUDIO`, `CLIP_NOT_FOUND`, `NO_AUDIO_STREAM`, `MEDIA_OFFLINE`, `NOT_IN_ENGINE`, `DECODE_FAILED`.
- MCP `auto_tag_audio {projectId, sequenceId?, clipIds? (default every untyped audio clip), mode?: apply (default) |
  propose, force?, minConfidence?}` (EDIT): classifies, applies ONE transaction, returns a table (clip | name | before |
  tag | confidence (low) | why), `low` and a `next` telling the agent to report low-confidence tags to the user.
- Editor: Essential Sound shows **Auto Tag** (primary) above the type buttons for untyped clips, in the mixed-types view,
  and an **auto banner** on typed clips ("Auto-tagged as Music · 82 % confident", why, "Low confidence" under 60 %,
  Confirm, Change… with the four types); Clip ▸ Audio Options ▸ Auto Tag Audio Types; the clip context menu (the
  selection with the clicked clip); toasts "Tagged 1 Dialogue, 1 Music · 1 with low confidence: confirm it · 1 silent".

#### One dialogue definition (`dialogueSpans(doc, seq, {voice})`)

Transcript words first (padded 0.25 s); else Essential Sound **dialogue** clips (typed by hand or by Auto Tag) on unmuted
tracks: their **voice activity** when measured — `VoiceActivityService` streams each clip's media range (±0.5 s on a
half-second grid) through ffmpeg at 16 kHz mono into 10 ms levels, voiced = ≥ `vadThreshold` and ≥ −50 dBFS, runs < 0.3 s
apart joined, < 30 ms dropped, cached under `sounds/analysis/voice/`; mapped through the clip's time map, padded 0.25 s —
else (no measurement) the whole clip; pauses < 0.75 s bridged. Spans carry the clip ids, track ids and sources
(`words` / `vad` / `clip`). Consumers, all with the same function:

- `deriveCues` (`voiceActivity` option): no `cut` (edit points, shot changes, pixel cuts) and — new — **no derived hero**
  in a span: it becomes support with "; support: under dialogue" (`stats.heroesUnderDialogue`); `sfx:` markers are the
  user's request and stay as asked. The cue route measures the voice (default; `opts.voiceActivity: false` = cached only)
  and answers `voiceActivity`, `voice {state, measured, missing}` and the spans; the editor's Suggest Cues… derives
  with the route's `voiceActivity`, so the dialog and the engine agree.
- The plan job measures the voice inline ("Listening for dialogue") for `collectPlanCues` (cut suppression) and
  `selectPlanSounds` (hero → support).
- The solver's bed measurement (`measureSfxEvents`): an event overlaps speech when its window meets a span; the span's
  tracks are named in the why-line. This replaces the per-cluster mixer render of untranscribed dialogue (decision:
  measuring the media is cached per file and range and agrees with the other consumers; clip Volume automation is no
  longer seen — a dialogue clip faded to silence still counts).
- Sound Check's MUSIC_OVER_VOICE segments are the spans (the levels are still compared over the voiced hops: words and
  the dialogue stem's VAD, as before).
- Not changed: MCP `place_sound`'s W_HERO_UNDER_DIALOGUE warning runs in the MCP process with the pure rule (no voice
  activity: whole dialogue clips).

#### Labelled set and accuracy (measured)

The set (all offline, nothing committed): **dialogue** — the 12 LJ Speech utterances of `fixtures/speech/lj-composite.flac`
(public domain) as clips of that media (±0.3 s), two 30 s stretches, a 60 s and a 14 s stretch (held out), six utterances
at 22.05 kHz mixed with air-conditioner noise at 20 / 10 dB SNR (held out); **SFX** — the 61 starter-kit recordings
(`apps/engine/sounds/starter`, 0.03–3 s), the 19 Jasper Synth recipes × seeds 0, 1 (tuning) and 5 (held out), six
generated long effects (explosion with a 6 s tail, car pass-by, door creak, power-down, 5 s riser, door slam) at 48 and
44.1 kHz; **music** — `packages/audio-fx/test/category-fixtures.ts`: the beat-test band (drums, bass, chords) at 90 / 120 /
140 BPM, chord pads, plucked arpeggios, a vibrato melody over a pad, drum loops, a piano-like progression (tuning: 20 s,
44.1 kHz; held out: other seeds and tempi, 8–45 s, 22.05–48 kHz, one at −24 dB); **ambience** — pink bed with sparse
knocks, traffic rumble with swells, rain, wind gusts, room tone with hum, air conditioner, forest with birds, office with
keyboard clicks (tuning: 20 s; held out: 40 s at −12 dB and 9 s at 22.05 kHz). The thresholds were chosen on the tuning
set; the held-out set was not looked at while choosing them (it was built after, once, and passed unchanged).

`AUTO_TAG_REPORT=/tmp/acc.json pnpm vitest run apps/engine/test/audio-classify.test.ts -t labelled --maxWorkers=1` (the
whole engine path: files registered, `POST /api/audio/classify`, decode, features, rules): **1 passed**; 192 items,
classified in 101.7 s (2 at once, shared host, load ≈ 40–50 on 16 cores):

| set | n | accuracy | dialogue → | music → | sfx → | ambience → |
|---|---|---|---|---|---|---|
| tuning | 139 | **100 %** | 14 dialogue | 13 music | 104 sfx | 8 ambience |
| held out | 53 | **100 %** | 8 dialogue | 8 music | 25 sfx | 12 ambience |

(no confusion: every off-diagonal cell is 0; the test asserts ≥ 90 % per set and prints both matrices.) Before tuning the
first rule set scored 95.0 % / 94.2 % on the tuning set (measured with a scratch script): risers and an explosion read
as music (low-passed noise looked "tonal": fixed by requiring spectral peaks to stand 10 dB over their neighbours),
synth transitions as dialogue (fixed by making syllabic modulation required for dialogue), traffic / wind as music.

Hard cases outside the set (scratch script `probe.mts`, measured, not asserted): LJ speech over the band 6 / 12 / 20 dB
under it → dialogue (confidence 0.93 / 0.99 / 0.98); six LJ voices overlapped (walla) → ambience; footsteps every 0.55 s
→ **music** (wrong: a regular untonal pulse is a drum loop to these rules); one 0.6 s word → sfx; 1.5 s of speech →
dialogue.

Speed (measured, `prof3.mts`, 60 s of stereo 48 kHz band music): 0.56–0.91 s at load ≈ 4–5; 2.2–4.6 s at load ≈ 47 (a
10⁸-addition loop took 0.19 s and 0.72 s respectively). Long clips cost at most 4 × 15 s of decode + analysis.

#### Verified (measured, this branch; shared host, 16 cores)

- `pnpm vitest run packages/audio-fx/test/audio-category.test.ts --maxWorkers=2`: 11 passed — generated music (12 s,
  44.1 kHz), ambience (12 s), every synth recipe × seeds 2, 3 and the long effects classified right; determinism; four
  10 s windows of a bed pooled to a 240 s clip (durationSec 240, analysedSec 40, ambience); silence / empty / one sample /
  −80 dBFS → silent, confidence 0; NaN / ±Inf = silence; 8 kHz mono, 96 kHz stereo, 5.1; refusals (`AudioCategoryError`
  E_INVALID_PARAM: no / > 8 windows, rates 0 / 999 / 10⁶ / NaN / ∞, non-array channels; `classifyAudio(null | {})` is
  silent); fast-check (60 runs, 0–3 channels, 0–30 000 samples, 5 rates, amplitudes 0 … 10⁴, NaN): never throws, finite
  features, scores and confidence in 0…1. Whole package: `pnpm vitest run --maxWorkers=2` (packages/audio-fx): 26 files,
  421 passed.
- `pnpm vitest run apps/engine/test/audio-classify.test.ts --maxWorkers=1`: 2 passed — the accuracy table above; the
  route: a silent file → `category: null, silent`, a 150 s bed → ambience with `analysedSec` 60 (four windows), a picture-
  only file → `NO_AUDIO_STREAM`, counts; a clip over media 10–25 s → `startSeconds` 10, `durationSeconds` 15, `currentType`
  sfx, `autoTagged` false; a video clip `NOT_AUDIO`, an unknown id `CLIP_NOT_FOUND`; `?wait=1` answers the finished job,
  served from the cache; refusals 400 (empty, both lists, clipIds without a document, a bad key, 501 keys), 404 (unknown
  key, project, sequence, no clip). A second classification of 20 media is all `cached`.
- `pnpm vitest run packages/project/test/essential-autotag.test.ts packages/project/test/sound-dialogue.test.ts`: 8 + 7
  passed — tagging (defaults + mark), undo (the document before is untouched) / redo (same sequences); a user's type kept
  (`USER_TYPE`, `SAME`) unless `force`; re-tag (another type resets, the same keeps a slider change; a slider change does
  not confirm); Confirm (mark gone, settings and effects identical) and Change; `minConfidence`; presets keep the mark and
  never carry one; Clear Audio Type; every refusal; an unreadable mark → INV-ESSENTIAL, repaired (type kept); auto-tagged
  dialogue in `dialogueSpans`; voice activity narrowing a clip to its voiced media (padded, bridged), empty = none;
  200 % speed and reverse mapping; words first; muted tracks / disabled clips silent; hostile voice data (strings, NaN,
  inverted, prototype keys, a clip at 2⁵³ + 2) never throws; `deriveCues`: a cut sounds where voice activity says nobody
  talks and is suppressed where they do, a derived hero under speech becomes support ("under dialogue",
  `heroesUnderDialogue`) and stays a hero in a pause or with `respectDialogue: false`, an `sfx:` marker stays a hero.
  AC-25 fuzz draws `essentialSound.autoTag` (force, minConfidence) and Confirm. Whole package (`pnpm vitest run
  --maxWorkers=2` in packages/project): 168 files, 2 083 passed.
- `pnpm vitest run apps/engine/test/sound-dialogue-consistency.test.ts --maxWorkers=1`: 1 passed — LJ speech at 2–6 s and
  9–11 s of a dialogue clip without transcript, music under it, cuts at 4 s / 7.5 s, effects at 4.2 s / 7.6 s: voice
  activity regions start 1.9–2.3 s, end 10.6–11.1 s, nothing in 6.6–7.5 s; two `vad` spans; the cue route returns the same
  spans and `voiceActivity`, suppresses the cut at 120 and keeps 225; `collectPlanCues` with the voice keeps only 225 (and
  none with the pure whole-clip rule); the solver marks the effect in speech `speechOverlap` (track A1) and the one in the
  pause not, and for both `speechOverlap` = "window meets a span"; Sound Check's `speech.segments` equal the spans within
  one 10 ms hop.
- `pnpm vitest run apps/engine/test/{sound-check,sound-check-stems,sound-design-cues,sound-design-plan,
  sound-design-plan-cue-sources,sound-design-plan-levels,sound-design-plan-mix,sound-design-rebalance,
  sound-design-delivery,sound-design-mix,sound-design-motion,fuzz-http,server,security-review,audio-fx}.test.ts
  --maxWorkers=2 --testTimeout=900000`: 15 files, 283 passed (1 opt-in perf skipped). `sound-design-bed.test.ts`: 7 passed
  (the voice measurement counted in `renders.voice` / `renders.cached` through the bed cache's memo).
- `pnpm vitest run apps/mcp/test/auto-tag.test.ts apps/mcp/test/readme-tools.test.ts apps/mcp/test/conventions.test.ts
  apps/mcp/test/audio-fx.test.ts --maxWorkers=2`: 18 passed — `auto_tag_audio` defaults to the untyped clips, sends the
  envelope and waits, applies one transaction with the mark, reports `low` and the table ("45 % (low)"), leaves a silent
  clip untyped, propose changes nothing, a user type is kept (USER_TYPE) unless force, `minConfidence`; engine failure,
  unknown argument, unknown clip and bad mode are tool errors; README lists 355 tools after the merge.
- `pnpm vitest run apps/web/test/essential-autotag.test.tsx apps/web/test/sound-fill-ui.test.tsx --maxWorkers=1`: 12
  passed — the panel's Auto Tag on two selected clips (one History entry "Auto Tag Audio Types", the engine asked with
  the envelope), the mixed-types banner, "Auto-tagged as Music · 81 % confident" with its reason, Confirm ("Confirm Audio
  Type", mark gone), Change… ▸ Ambience; low confidence shown, a silent clip untyped, the toast; the dotted badge
  (`data-auto-tag`, aria-label "… auto-tagged, 42 % confident …", dashed border); Clip ▸ Audio Options lists
  `audio.autoTag`, the clip menu entry runs it on the clicked clip; a failing engine → "Auto Tag failed" with the detail.
- `E2E_PORT=51503 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-autotag.spec.ts` (after `pnpm build`): 1 passed
  (16.7 s) — speech.wav (LJ), music.wav (generated), hit.ogg (starter kit) imported through the browser; three clips
  selected (Shift-click); Clip ▸ Audio Options ▸ Auto Tag Audio Types → dialogue / music / sfx, marked auto, History "Auto
  Tag Audio Types", dotted badges; the speech badge opens Essential Sound with "Auto-tagged as Dialogue · 91 % confident"
  and its reasons; Confirm → solid badge, mark gone, no clip moved; two full-frame solids slamming to a stop at frames
  ≈ 98 (in the speech) and ≈ 458 (after it) → Suggest Cues… → the land in the speech is support ("under dialogue"), the
  other a hero, no hero in 0–9 s. **Looked at** the screenshots (`test-results/e2e-sound-autotag/`): `tagged.png` (toast
  "Tagged 1 Dialogue, 1 Music, 1 SFX", three badges), `essential-banner.png` (the AUTO chip, the banner with Confirm /
  Change…, the dashed badge on the speech clip), `confirmed.png`, `cues.png` (the Cue Seam over the solid, "Suggested 4
  cues"). Found while writing it: Playwright clicking a badge outside the visible timeline scrolls the clip layer natively
  while the ruler stays (a test artefact — users cannot scroll that layer; the spec keeps the badge in view).
- `pnpm typecheck` (every package), `pnpm lint` (Biome, tokens, anime, layers, assets) and `node scripts/i18n.mjs --check`
  (es.json covers all 9 859 strings) pass.

#### Limits and notes for the next packages

- **Rules, not a model.** Checked on one real speaker (LJ), the starter kit and generated music / ambience: real
  productions (dense mixes, dialogue over loud music, crowds, foley sequences, sung vocals, sound design beds with a pulse)
  will be misread more often than the 100 % above suggests. Known wrong: regular untonal pulses (footsteps) read as music;
  walla reads as ambience (arguably right); a single word under 1 s reads as SFX; music clips under 3 s read as SFX (a
  stinger). The confidence and reasons are there so the user (and agents, told to report low confidence) can check.
- Not done from Premiere: the "Auto-tag audio types in the timeline" preference (tag on add) and "select all clips of a
  tag" from the panel.
- Voice activity is energy-based (the speech module's VAD on the clip's media), not a speech detector: in a dialogue clip
  loud non-speech counts as voice; clip Volume automation, mutes by keyframe and clip effects are not seen (the solver
  used to render the dialogue through the mixer; now it measures the media, like the cue route). A dialogue clip that
  cannot be measured (offline, not in the engine's store, > 4 h, > 64 clips or 8 h per call) falls back to its whole span
  (`voice.state` partial / failed with the reason).
- MCP `place_sound`'s W_HERO_UNDER_DIALOGUE uses the pure rule (whole dialogue clips), not voice activity.
- The cue route measures voice activity synchronously (first time per media range: one ffmpeg decode — estimated ≈ 50× faster than real time, not benchmarked —
  at 16 kHz; cached after).

### Phase 6 → WP6.4 credits sidecar, export warnings, interchange

Scope: spec 12 §2.11 (export credits sidecar, W_SOUND_CREDITS, W_SOUND_CHECK_STALE, interchange cues as markers, the
export oracle), P6-R4; the WP5.1 / WP5.2 notes ("default `ExportSettings.credits` from `soundDesign.settings.credits`").

Files: `packages/api/src/exports.ts` (`ExportCreditsSchema`, `ExportSettings.credits`, `RenderPlan.warnings[].level`,
`ExportResult.credits` / `warnings[].level`), `routes.ts` (`renderCreditsFile`), `packages/engine-client` (`renderCreditsFileUrl`);
`packages/project/src/sound/credits.ts` (`played`, `playedLibraryClips`, `soundCreditsFileText`, `SOUND_CREDITS_FILE`,
`defaultCreditsSidecar`), `schema/sound.ts` (`SOUND_CREDITS_FORMATS` + `csv`), `sound/cues/markers.ts` (`cueMarkers`,
`parseSfxRequest` reads `(hero|support|ambient)`), `commands/handlers/clipboard.ts` (`copySequence` fix, below);
`apps/engine/src/export/sound-credits.ts` (new), `planner.ts`, `service.ts`, `routes/exports.ts`;
`packages/interchange/src/{jasper-export,jasper-import,comp,edl}.ts`; `apps/mcp/src/tools/{render,interchange,sound}.ts`,
`context.ts`; web `export/{ExportMode.tsx,PlanSummary.tsx,settings.ts}`, `panels/jobs/JobsPanel.tsx`,
`home/ProjectLifecycle.tsx`, `sound/cues/model.ts`, i18n (4 strings). Tests: `packages/project/test/sound-export-credits.test.ts`,
`apps/engine/test/sound-export-credits.test.ts`, `packages/interchange/test/sound-design.test.ts`,
`apps/mcp/test/export-credits.test.ts`, `apps/web/test/export-credits.test.tsx`, `sound-cue-seam-model.test.ts` (+1),
`e2e/sound-credits-export.spec.ts`.

#### What it does (usage)

- **Export dialog** (Export mode ▸ SOUND, shown when the sequence uses library sounds, has sound effects or the plan has a
  sound warning): **Credits** Off / Text (.txt) / Markdown (.md) / CSV (.csv). Default: the last choice for this sequence
  (remembered with the other export choices), else `soundDesign.settings.credits` (null there = Off), else Markdown when
  a sound the sequence (or its nests) uses asks for a credit (`requiresAttribution`: CC BY, CC BY-SA, NC, ND, open-source
  licences), else Off. The plan's sound warnings are listed under it (⚠ warning, ⓘ information) and not repeated in the
  summary list. The finished-export notice says "Sound credits file written (n sounds)" plus the sound warnings; the Jobs
  panel row offers `credits.md` (etc.) next to Download.
- **Engine**: `ExportSettings.credits {sidecar: 'txt'|'md'|'csv'|null, scope?: 'all'|'attribution'}`. The export writes
  `credits/output.credits.<ext>` in its job folder (so `output.*` stays the job's only output file), served at
  `GET /renders/:jobId/credits/output.credits.<ext>` (name allow-list, only for succeeded jobs, `?download=1`); with a
  `destination.path` it is copied to `<stem>.credits.<ext>` next to the video with the same no-overwrite rule and partial
  cleanup as caption sidecars (`cut (2).mov` → `cut (2).credits.csv`). `result.credits {format, scope, count, name?, url?,
  path?}`; `count: 0` and no file when no library sound is heard in the range.
- **What is credited**: what the export's mixer PLAYS — `playedLibraryClips(planned.snapshot)`: the snapshot's audio clips
  (enabled clips intersecting the range, including crossfade handles; tracks the mixer never hears — muted throughout —
  left out; nested sequences flattened over the part of the nest in the range), processed versions credit their library
  original. File ▸ Export ▸ Sound Credits… and `list_sound_credits` still list every clip of the sequence (unchanged).
- **Warnings** (plan, Export dialog, job result, MCP): `W_SOUND_CREDITS` — sounds heard need a credit and no sidecar is
  written ("1 sound heard in this export needs a credit (CC-BY-4.0: "Credit Ding") and no credits file is written: choose
  a Credits format or credit it yourself"); `W_SOUND_LICENSE_NC` (addition: a non-commercial sound is heard);
  `W_SOUND_CHECK_STALE` with `level: 'info'` — the stored Sound Check is stale (with the reason: mix / delivery target /
  cues, loudness or credits settings) or current but failed (with the error count). None for stills, picture-only renders
  (`videoOnly`) and alpha masters. The job result repeats the plan's `W_SOUND_*` warnings (W_SOUND_CREDITS only when no
  file was written).
- **MCP** `start_export {credits: "md"|"txt"|"csv"|null|{sidecar, scope}}`: default as the dialog (setting, else Markdown for
  a sound needing a credit); returns `credits {sidecar, scope?, defaulted}` and `soundWarnings [{code, message, level?}]`;
  `wait: true` / `wait_for_job` return `result.credits` (absolute `url`) and `result.warnings`. SOUND_GUIDE and the
  start_export / wait_for_job descriptions say so; INTERCHANGE_GUIDE has a sound design bullet. No new tool (count unchanged).
- **Interchange**: every exporter's IR gets one sequence marker per cue, `SFX: <type>[+<type>] (<weight>)` at the cue frame
  (types: the cue's, else the library types of the sound placed on it, else its kind; comment: label · reason · "muted"),
  colour mango, no JasperEditor metadata (re-imports make plain markers). Cues made from a marker the sequence still has
  are skipped (that marker is exported already). FCP7, FCPXML, OTIO, EDL (with Markers on) and AAF write them; OMF has no
  sequence markers (its writer already reports markers) and ALE is a media log. The report has one info entry per sequence
  with a sound design: "the n sound design cue(s) of "…" are exported as "SFX: <type> (<weight>)" markers; proposals and the
  sound design's mix metadata (settings, mix records, the last Sound Check, the SFX placement data of clips) are not
  carried" (→ "markers (after importing, Sequence ▸ Sound Design ▸ Convert Markers to Cues makes them cues again)"), or
  "… are not carried (an ALE is a media log …)" / "(OMF has no sequence markers)".
- **Back to cues**: `parseSfxRequest` reads the trailing `(hero|support|ambient)`, so Convert Markers to Cues
  (`markerToCueInput`) and the `markers` cue source keep the weight and the types; kind becomes `manual` and the cue
  window is not carried (point markers).

#### Mixer data sound design produces, per exporter (AGENTS §4: nothing silently dropped)

Checked: the SFX Room (`soundDesign.ensureBus`: a submix with a reverb insert + sends), stop-before / ducking automation
(track Volume keyframes; clip Volume keyframes on clip fallback), build filters and pitch shifts (clip audio effects), pan
keyframes, the Mix's loudness normalisation (`mixer.setLoudness` / delivery presets).

| Exporter | Before | Now |
|---|---|---|
| OTIO | submixes **silently dropped** (not in the metadata; track `mixer` exported but never restored, sends dangling); master restored | submixes in the sequence metadata; import restores submixes (new ids) and each track's mixer strip (outputs, sends, lanes), validated with the schemas; unknown targets dropped and reported; invalid routing (`audioMixIssues`) drops all of it, reported |
| FCP7, FCPXML | submix / sends / lanes, master volume+effects, track volume/pan reported; **loudness normalisation not reported** | + "the loudness normalisation of … (−16 LUFS, −1 dBTP ceiling) is not carried" |
| EDL | clip levels and effects reported; **track volume/pan and loudness not reported**; markers off silently | + track volume/pan, + loudness, + "the n sequence marker(s) … are not written (Markers is off)" (info) |
| AAF, OMF | **audio clip effects and track volume/pan silently dropped**; loudness not reported | + "the audio effects (…) of … are not carried by AAF/OMF" (only for linked/embedded media essence, which is never rendered with effects), + track volume/pan, + loudness |
| ALE | media log; nothing of the mix applies | the sound design entry says the cues are not carried |

Also found and fixed: **pasting or importing a sequence with a submix failed** (`copySequence`, shared by
`project.pasteItems` and `project.importTimeline`, kept the submix, send and cue ids and did not remap cue anchors /
placed clips: a second paste, or a sequence with sends, broke INV-001 — the transaction was refused). It now re-identifies
submixes and sends and calls `remapSoundDesign` like `sequence.duplicate`. Regression test failed before (measured: "transaction failed"), passes after.

#### Decisions

- Header strings stay English ("Sound credits" / "## Sound credits", the CSV header): the sidecar is a deliverable for any
  audience and the engine has no user locale; credit lines are the licences' verbatim attribution lines. Same text as File
  ▸ Export ▸ Sound Credits… for the same sounds.
- No file for nothing heard (an empty credits file next to a video invites a wrong conclusion); `count: 0` says it.
- `SOUND_CREDITS_FORMATS` gained `csv` (the setting, the dialog and the sidecar share it). No schema bump: the field is new on
  this unreleased branch.
- `W_SOUND_CREDITS` uses `requiresAttribution` (broader than CC BY / BY-SA: a credit too many is harmless).
- No audio-only or image-sequence export destination exists in this build (Export mode lists "Audio Only" as disabled;
  image sequences are import-only), so the sidecar applies to every media export with sound; stills, picture-only previews
  and alpha masters get neither the file nor the warnings.
- Oracle: Phase 4 verification compared the preview graph with the export mixer; nothing compared an exported FILE with the
  offline render, so it is added here (below).

#### Verified (measured, this branch; shared host, 16 cores, load average 60–90 during the runs)

- `pnpm vitest run packages/project/test/sound-export-credits.test.ts`: 8 passed — played credits over range 90–240 = the
  CC0 sound and the nested CC BY one (`nest>inner` id), not the muted-track, disabled or out-of-range sounds; whole range;
  unmute / enable brings them in; sidecar text exact (TXT, MD, CSV, attribution-only, '' when nothing plays); hostile
  `played` lists (300-run property); the dialog default (setting csv / null, CC BY → md, CC0 → none); cue markers (types,
  placed-sound types, kind fallback, marker-made cue skipped, muted comment), `parseSfxRequest` weight, the marker cue
  source keeps weight + types, 500-run hostile `cueMarkers` property; **paste of a sequence with the SFX Room twice**:
  invariants clean, own submix / sends / cues. Mutation check: with `clipboard.ts` from `ca23a4c5` the paste test fails
  ("transaction failed").
- `pnpm vitest run apps/engine/test/sound-export-credits.test.ts --maxWorkers=1`: 6 passed (real engine + ffmpeg):
  W_SOUND_CREDITS (2 sounds: CC-BY-4.0, CC-BY-SA-4.0) / none with a sidecar / none for frames 60–200 / none for
  `videoOnly`; W_SOUND_CHECK_STALE info for a failed current check ("… failed (2 errors) …") and after a mix change ("out
  of date (the mix changed since)"), none for a current pass; Markdown sidecar with 3 heard sounds (muted-track and
  disabled-clip sounds absent; whole-project credits list 5), served, 4 hostile names → 404; TXT attribution-only next to a
  destination (`cut.credits.txt` exact text), CSV again → `cut (2).credits.csv`, nothing overwritten; `count: 0`, no file,
  404 and W_SOUND_CHECK_STALE in the result; W_SOUND_CREDITS in a result without sidecar. **Oracle**: ProRes MOV + 24-bit
  PCM export of frames 15–285 with SFX (hero hit + click), SFX Room (send + reverb), stop-before track automation and
  −16 LUFS normalisation vs `renderMixdown` of the same plan: same length (2 × 9 s × 48 000), max |Δ| ≤ 2⁻²³ (one 24-bit
  step), integrated −16 ±1 LU, the hit above the dip.
- `pnpm vitest run packages/interchange/test/sound-design.test.ts`: 17 passed — the report entry for all 7 formats; FCP7,
  FCPXML, OTIO, EDL, AAF re-import `SFX: whoosh+hit (hero)` at 30 and `SFX: hit (support)` at 90; re-imported FCPXML
  markers → cues (manual, hero / support, types) → `soundCue.add`; the mixer reports per format (submix, sends, loudness,
  track volume/pan; AAF/OMF pitch-shifter effect); OTIO restores submix + reverb, sends → the new submix id, the stop-before
  keyframes and the loudness, no warnings, a second import of the same file stays valid; hostile metadata (unreadable
  submix, unknown targets) reported; 150-run property of arbitrary submix / mixer metadata: import never fails, invariants
  clean. Whole `packages/interchange` before the merge: 16 files, 109 passed (+ this file).
- `apps/mcp/test/export-credits.test.ts`: 4 passed (default md + `defaulted`, csv / {txt, attribution} / null reach the
  engine, unknown format and extra key refused, setting wins, CC0 → none, `soundWarnings`, `result.credits.url` absolute
  in `wait: true` and `wait_for_job`); with `conventions`, `readme-tools`, `sound-guide`: 20 passed.
- `apps/web/test/export-credits.test.tsx`: 3 passed (default Markdown, the option labels, plan settings follow the select,
  the info / warning classes, the warning shown once, CSV reaches the export; setting txt / null / CC0; notice detail and
  the Jobs panel `credits.md` link); `sound-cue-seam-model.test.ts` 23 passed (+1: `SFX: … (support)` read back);
  `wp2e/ui.test.tsx` unchanged and passing.
- After merging `feat/sound-design` (WP6.3 Auto Tag): `pnpm lint` and `pnpm typecheck` pass, `pnpm build` passes,
  `node scripts/i18n.mjs --check` (9 944 strings). 32 touched test files: 288 passed, 2 failed — `packages/interchange/test/
  fuzz.test.ts` "omf → project" and "any document (sniffed)", both by the 2 s hang limit on two OMF seeds (FUZZ_SEED=24301);
  timed by hand on the same inputs at load ≈ 71: 2.6–3.6 s with this branch and 2.7–5.4 s with the integration branch's
  code (not caused by this package; load). `captions-export.test.ts` failed once to load at load ≈ 85 and passed alone
  (5 passed).
- **E2E** (built stack, `E2E_PORT=51603 E2E_SKIP_BUILD=1 playwright test e2e/sound-credits-export.spec.ts`): passed (5.4 min;
  a first attempt was SIGKILLed from outside before the test started). A folder declared CC BY 4.0 (author "Ada Tester",
  template `"{title}" by {author}, licensed under {license}`) → "Credit Ding" inserted from the Sound Library → Export
  mode: Credits = Markdown; Off → "⚠ 1 sound heard in this export needs a credit (CC-BY-4.0: "Credit Ding") and no credits
  file is written…"; Markdown → gone → export → `result.credits {md, count 1}`, the file has `| "Credit Ding" by Ada
  Tester, licensed under CC-BY-4.0 |`, the Jobs panel row shows Download + credits.md. Screenshots looked at
  (`test-results/e2e-sound-credits-export/`): the SOUND section with the warning in the warning tone under the Credits
  select; the Jobs row.

- **Final run on the build server** (`remote.sh`, 16 idle cores, after the last merge of `feat/sound-design`): `pnpm
  typecheck` exit 0; `pnpm lint`: Biome, tokens, anime, layers ok (`check-assets` cannot run there: the synced copy has no
  `.git`; this package adds no asset — the e2e generates its WAV in a temp folder); `i18n --check` 9 944 strings; `pnpm
  notices --check` current; 39 touched test files (interchange incl. fuzz, api, engine-client, project sound / clipboard /
  fuzz, web export / Sound Check / cue model, MCP, engine credits / captions / sound-check / security) **370 passed**, 7
  skipped; `pnpm build` ok; `e2e/sound-credits-export.spec.ts` passed (40.2 s).

#### Limits and notes for the next packages

- No audio-only / image-sequence export destination exists to carry a sidecar; when one is added it should call
  `writeCreditsSidecar` (the engine helper only needs `planned.snapshot`).
- Credits follow the mixer's track audibility: a track muted only part of the time, a clip at −∞ dB Volume or a muted
  channel map still counts (a credit too many is harmless). Solo is whatever the export mixer does.
- Interchange cue markers carry types and weight; the cue's kind, window, anchor, placed clips and alternates are not
  carried (`manual` cues after Convert Markers to Cues). OTIO carries no `soundDesign` either (anchors name clip ids the
  import regenerates).
- The finished-export notice detail and the warnings come from the engine in English (as the other export messages).
- Observed, not changed: an H.264 export requested with `audio.codec: 'pcm'` / `container: 'mov'` came out as MP4 with
  this host's OpenH264 encoder (the encoder decides the container); the oracle uses ProRes to keep 24-bit PCM in MOV.

### Phase 6 → WP6.5a carry-over polish (UI / editing)

Branch `feat/sd-p6-polish-ui`. Scope: the UI- and editing-side carry-overs of Phases 0–6 (CARRYOVER.md) — razor inside a
transition, i18n of Undo / Redo and workspace names, keyboard navigation of the Essential Sound segmented controls,
Premiere's "Auto-tag audio types in the timeline" preference and "select all clips of a tag", the export container /
audio codec that changed silently, and the UI leftovers in the Phase 2–6 limits. The engine / model carry-overs (solver,
jobs, proposals performance, media padding, beats, motion, mg cues, Sound Check fix interactions) are WP6.5b's.

#### Item table

| # | Item | Result | Evidence (failed before the fix, passes after) |
|---|---|---|---|
| 1 | Razoring inside a transition failed `E_INVARIANT` (INV-010 "longer than clip") for any clip | **Fixed.** `splitClipAt` (`packages/project/src/commands/placement.ts`) shortens a transition the split leaves longer than the part it still touches (`fitTransitionsAfterSplit`, `W_TRANSITION_SHORTENED`); it stays on its edit with its alignment. Covers Razor, Add Edit (one clip / all tracks), Alt-razor one side, insert edits through a span; video and audio, centre / start / end alignments, dip to black, single-sided fades. Found while checking it: trimming a clip (regular or ripple) or overwriting part of it so that it is shorter than its transition was refused the same way — `cleanupSequence` now shortens any transition longer than its clips (same rule, `W_TRANSITION_SHORTENED`) | `packages/project/test/transition-razor.test.ts` (7; all failed before, the first with `INV-010: Transition … is longer than clip …`); `e2e/sound-p65a-polish.spec.ts` "the Razor inside a video and an audio transition" (Razor tool, 30-frame cross dissolve + constant-power crossfade → both ≤ 8 frames, History "Razor") |
| 2 | "Undo / Redo <label>" built in English | **Fixed.** `apps/web/src/shell/history-labels.ts`: `t('Undo {0}', step)` / `t('Redo {0}', step)` — the step's label is translated as the History panel shows it (`translateName`: model names, sound-design templates, "Agent: …"); the crash-recovery list's journalled "Undo …" too. Found on the way: Edit ▸ Select All / Deselect All (commands that delegate to the Timeline) stayed English — their label is now a getter through `t` | `apps/web/test/wp65a-i18n.test.tsx` ("Deshacer Añadir marcador", "Rehacer …", "Deshacer Agente: Añadir marcador"; failed before with "Undo Add Marker"); e2e screenshot `es-edit-menu.png` |
| 3 | Built-in workspace names not translated | **Fixed.** `workspaceName(record)` (`shell/workspaces/definitions.ts`, explicit `t()` per built-in id) at every place a name is shown (header tabs and overflow, Window ▸ Workspaces, Edit Workspaces, the palette, the "Saved changes" toast); records keep the English name (name clashes, export) and the ids never change; custom names are the user's | `wp65a-i18n.test.tsx` (store ids / names unchanged, Edit Workspaces lists "Diseño de sonido", "Edición"); e2e `workspace-tab-sound-design` = "Diseño de sonido" |
| 4 | Essential Sound Role / Align without arrow keys | **Fixed.** `SegmentedControl` in `@jasper/ui` (`primitives/Segmented.tsx`): a WAI-ARIA radio group with roving tabindex (the checked option is the one Tab stop, else the first enabled), ← ↑ / → ↓ with wrap (RTL aware), Home / End, choosing follows focus, disabled options skipped, `data-keymap-local` so a consumed key runs no shortcut. Essential Sound Role / Align and the composition text alignment (a `radiogroup` of toggle buttons) use it | `packages/ui/test/primitives.test.tsx` (3), `apps/web/test/sound-fill-ui.test.tsx` "Role / Align are one Tab stop each…" (failed before: tabIndex `[0, 0, 0]`); e2e `role-keyboard.png` |
| 5 | Premiere's "Auto-tag audio types in the timeline" and "select all clips of a tag" | **Done.** Preferences ▸ Audio ▸ Essential Sound ▸ "Auto-tag audio types in the timeline" (`audioPrefs.autoTagInTimeline`, **off** by default — see research); `audio-fx/auto-tag-on-add.tsx` watches the user's transactions and tags the audio clips they add through the same route and command as Auto Tag (`autoTagClips` → `POST /api/audio/classify` + `essentialSound.autoTag`). Essential Sound shows "In this sequence: Dialogue 2 · Music 1 …"; a click selects that tag's clips (audio only, not their linked video); Clip ▸ Audio Options and the clip menu ▸ "Select All <Type> Clips" (`audio.selectAudioType {type?}`, agent-exposed; MCP guide: `ui_command`) | `apps/web/test/essential-autotag-on-add.test.tsx` (9); e2e "auto-tag in the timeline…" (a dropped `music.wav` becomes Music, auto, one "Auto Tag Audio Types" step; the tag strip selects it) — screenshots `auto-tagged-on-drop.png`, `essential-tags.png` |
| 6 | MOV + PCM requested, MP4 + AAC written on the LGPL OpenH264 build | **Fixed (honoured where it fits, reported where not).** The container followed the codec only (H.264 → MP4 + AAC, whatever was asked) — a silent change (AGENTS §4). `fitOutputFormat` (`apps/engine/src/tools/encoders.ts`) writes the requested container when the codec fits it (MP4: H.264, HEVC, AV1, VP9; MOV: H.264, HEVC, ProRes; WebM: VP9, AV1 with Opus) and the requested audio codec when the container carries it (MP4: AAC; MOV: PCM, AAC; WebM: Opus); ProRes masters keep PCM. What cannot be written as asked is a plan warning (`OUTPUT_CONTAINER_CHANGED`, `AUDIO_CODEC_CHANGED`, in words: "PCM audio was requested but MP4 does not carry PCM audio (PCM needs MOV): the audio is AAC") shown by the dialog's plan summary, carried into the job result (with the new `audioCodec`) and repeated by the finished-export notice. The Export dialog now asks for the codec's own format (ProRes: MOV + 24-bit PCM, VP9: WebM + Opus when the engine has Opus, else MP4 + AAC); MCP presets ask MOV presets for PCM; the dev-only Remotion GPL direct path is used only for MP4 + AAC | `apps/engine/test/export-container.test.ts` (5; the real-engine cases failed on the old code: plan encoder container `mp4` for a MOV request, no warning); measured: an H.264 export with `container: 'mov'`, `audio: pcm` on the vendored LGPL ffmpeg 7.1.5 (OpenH264) is `mov` with `h264` + `pcm_s24le` (ffprobe), job result `{container: 'mov', audioCodec: 'pcm_s24le'}`; `apps/web/test/export-format.test.ts` (3) |
| 7a | Room row multi-selection (P4) | Already fixed (P4 verification, web): acts on every selected track, mixed state | `sound-mix-ui.test.tsx` (passes) |
| 7b | Play all / verdict (P5) | Already fixed (P5 verification (b)) | `sound-check-listen-keep.test.ts` (passes) |
| 7c | Stale stored workspace layouts (P3) | Already fixed (P3 verification (d), `migrations.ts`) | `workspace-migration.test.ts` (passes) |
| 7d | Review list virtualisation (P3) | Already fixed (P3 verification (c)) | `review-virtual.test.tsx` (passes) |
| 7e | Review row gain attribution (P4 limit) | Already fixed (P3 verification finding 10) | review-model test (passes) |
| 7f | Ghost lanes not in the scroll range (P3) | Already fixed (P3 verification (e)) | `proposal-ghosts-model.test.ts` (passes) |
| 7g | After an In Context audition the Timeline stayed scrolled where playback took it (P3 verification limit) | **Fixed.** `onInContextView` (`sound/in-context.ts`) tells a Timeline when a session's first window starts and when the last ends (not between a window and its replacement); the Timeline puts back the view it had (`scrollAfterAudition`: the old view when the returned playhead is in it, else the playhead revealed) | `apps/web/test/wp65a-audition-view.test.ts` (3) |
| 7h | Delivery Target… kept Cancel next to Close after a run (P4 limit); Auto Sound Pass… the same | **Fixed.** `Dialog.hideCancel` (`@jasper/ui`); both dialogs show Close alone once their work is done | `sound-mix-ui.test.tsx`, `auto-sound-pass.test.tsx` (new assertions; the old footer always rendered Cancel) |
| 7i | A gain fix's why "The solver's gain does not resolve it: {0}" carried the solver's English reason (P5 limit) | **Fixed.** The panel says the reason from the fix's own `soundDesign.applyGains` report (`limitedBy`, lifts) with `solverReason` | `sound-check-model.test.ts` ("… no lo resuelve: limitado por diálogo A1") |
| 7j | `set_sound_cues` counted skipped (stored) suggestions in "add n" (P2 agent review) | **Fixed** (`apps/mcp/src/tools/sound-design.ts`) | `apps/mcp/test/sound-cues.test.ts` ("Sound Cues (add 1)", "Sound Cues (edit 1)") |
| 7k | Auto gain on for a mixed selection makes two History entries (P4 limit) | **Justified, not fixed here.** The engine's rebalance job makes the "Rebalance SFX Levels" transaction (relayed into the session); clips the solve leaves unchanged keep their manual mark, so the editor clears it in a second, local transaction. One entry needs the job's transaction to carry `soundDesign.setAutoGain` for the named clips (`apps/engine/src/sound-design/rebalance.ts`, the jobs area of WP6.5b in this phase). Repro: two placed SFX with Auto gain off, one whose solved gain equals its gain; Essential Sound ▸ Auto gain on → History "Rebalance SFX Levels", "Auto Gain On" | recorded in docs/gaps.md |
| 7l | Messages the engine composes (export warnings, the finished-export detail) are English (WP6.4) | **Justified.** Every engine-composed message (planner blockers and warnings, job errors) is English across the app; translating them needs structured messages from the engine (as Sound Check has) — a cross-cutting change outside this package. The new container / audio warnings are English like the rest | docs/gaps.md |

UI-side limits looked at and left as designed (documented decisions, not defects): Swap does not rename a clip the user
renamed; badges need 80 px; the Sound Library list is one column; Reveal in Folder only for folder sounds on desktop;
no "move the cue only" drag modifier; Suggest Cues… measures an edit made while it is open on the next Analyze….

#### Decisions and research

- **Razor inside a transition.** helpx.adobe.com answers 403 to this host. Adobe's "Transitions overview" text, as quoted
  by search engines: "If a transition contains trimmed frames, but not enough to fill the transition duration, Premiere
  Pro adjusts the duration to match the frames"; Premiere never lets a transition be longer than its clips. Undocumented
  for the razor itself; chosen as the most plausible: the edit is made, the transition stays on its edit point with its
  alignment and is shortened to the shorter of its clips (a shorter span around the same cut needs no more media handles,
  so it still fits). Removing the transition instead would lose the user's work.
- **"Auto-tag audio types in the timeline".** Adobe's "Auto tag audio categories in Premiere" page, as quoted by search
  engines: "To enable this feature, you can enable Auto-tag audio types in the timeline which can be found in Preferences
  > Audio. This setting allows auto tagging to happen anytime you add an audio clip to your sequence"; Adobe documents no
  default (community threads, e.g. "Disable Essential Sound Tagging", report it on in some builds). Off by default here:
  it starts an engine job on every add. Only the user's own edits count (not undo / redo, not agents — they call
  `auto_tag_audio` —, not the right part of a razor or an insert edit, not the clips of a new or duplicated sequence);
  each tagging is its own undo step ("Auto Tag Audio Types"); a clip the user typed, deleted or locked before the engine
  answered is left out; the transaction waits for a drag in progress; failures toast at most once a minute. Premiere's
  companion "Always override audio tags" is not added (it would replace types the user set).
- **Select all clips of a tag.** The strip lists the types in use in the active sequence with counts (clips auto-tagged
  count with their type); a click replaces the selection with those audio clips only (`linked: false`), so Essential
  Sound then edits them together.
- **Export container.** Honour first, report what cannot be honoured, never refuse a valid request: older API callers
  (and the web, which sent MP4 + AAC for every codec) keep working, now with an explicit warning. 24-bit PCM is what the
  schema documents for `pcm`; ProRes masters asked for AAC keep PCM (Premiere's QuickTime ProRes presets use uncompressed
  audio) and say so.
- **Roving tabindex.** WAI-ARIA APG "Radio Group" (selection follows focus); the existing ProcessDialog toggle groups
  are `aria-pressed` buttons (not radio groups) and stay as they are.

#### Verified (measured, this branch; build server, 16 cores)

Every command ran on the build server through `remote.sh`:

- Failing first (on the unfixed code, by swapping the old sources into the remote copy): `transition-razor.test.ts` 5 / 5
  failed (`E_INVARIANT` / INV-010); `wp65a-i18n.test.tsx` Undo / Redo 2 failed ("Undo Add Marker" in Spanish);
  `sound-fill-ui.test.tsx` keyboard test failed (`[0, 0, 0]` Tab stops); `export-container.test.ts` real-engine cases
  2 failed (plan encoder `container: 'mp4'` for a MOV request; no `AUDIO_CODEC_CHANGED`).
- `pnpm typecheck` exit 0; `pnpm lint` (Biome, check-tokens / anime / layers / assets) exit 0; `node scripts/i18n.mjs
  --check`: es.json covers all 9 961 strings; `pnpm notices --check`: current.
- `pnpm vitest run --project <p> --maxWorkers=8`: @jasper/project 2 108 passed (171 files), @jasper/ui 42, @jasper/web
  1 051 (142 files), @jasper/mcp 586 passed / 8 skipped, @jasper/api 17 — all passed. @jasper/engine: 1 447 passed,
  109 skipped, 2 failed in 4 files, none in code this package touches: `sound-design-motion` and
  `sound-dialogue-consistency` make their fixtures with the system ffmpeg's libx264, which the build server's ffmpeg does
  not have ("Unknown encoder 'libx264'", in `beforeAll`); `camtrack-solve` (120 s) and `tracking` "lands on the exact
  frames (system ffmpeg)" (5 s) timed out — known load-sensitive (earlier verifications above). The export-related files
  (`export`, `export-container`, `encoders`, `sound-export-credits`, `edit-structure-export`) passed again after the last
  change (5 / 5 files).
- `pnpm build` ok; `E2E_PORT=51801 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-p65a-polish.spec.ts`: 4 passed
  (30.6 s). Screenshots looked at (not committed): the dropped music clip tagged auto; Essential Sound "In this sequence:
  Music 1 · SFX 1" and the selection it makes; the Razor before / after (30-frame dissolve → 8 frames around the cut);
  Role chosen by ← → / Home with the focus ring on the checked option; the Spanish UI ("Deshacer Añadir marcador",
  "Diseño de sonido", "Esenciales", "En esta secuencia: Música 1").

#### Limits and notes for the next packages

- 7k / 7l above (two History entries for a mixed Auto gain on; engine-composed messages in English).
- Auto-tagging on add listens to the user's transactions in this editor window: clips an agent places, or that arrive in
  a new / duplicated sequence, are not tagged by it; a clip added while the engine is offline is not tagged later.
- The container rule is ffmpeg's muxers as used here: Opus in MP4 and AV1 / VP9 in MOV are not offered (reported as
  changed when asked).

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
  analyses it finished are reused next time (tested). If the folder list changes during a scan, the scan repeats (≤ 3
  times). One index job at a time (`dedupeKey: 'sound-index'`).
- **Analysis**: ffprobe for the format, then ffmpeg decodes the first `SOUND_ANALYSIS_SECONDS` = 30 s to f32 at the
  file's rate up to 48 kHz (higher rates resampled; descriptors are perceptual) with ≤ 6 channels (more folded to
  stereo): ≤ 35 MB per file. `analyzeSound` and the visual data run on a **worker thread** (`sounds/analysis.ts`,
  entry `analysis-worker.ts`, bundled by `scripts/build.mjs` to `dist/sound-worker.mjs` and shipped by the desktop
  packager; in a dev engine under tsx the worker registers tsx's hooks itself, since Node 20 does not pass the main
  thread's loader to workers). Measured on this host at load ≈ 160 with `tsx` (scratch script): 30 s of stereo noise
  took 13.4 s in `analyzeSound` and 4.4 s for the spectrogram, which would have held the engine's event loop. One
  worker per engine, started on first use (≤ 120 s start timeout), stopped after 30 s idle; the decoded buffers are
  transferred, not copied; cancelling a running analysis terminates the worker (a new one starts next time). Without
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
  a chip shows how many sounds selecting it gives. Four ranking passes per request (measured: fine for the test
  library; the 50 000-sound cap was not benchmarked).
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
  50 000 sounds. Removing or disabling a folder takes its sounds out of the index at once; adding, enabling or
  relicensing starts a rescan.
- **Agents** (security review AGT-3): `requireUserApproval` for adding, removing **and relicensing** a folder
  (a licence declaration decides commercial safety: it is the user's statement); renaming and enabling are open.
  The card names the paths and declared licences. The editor window is never asked.
- **Auto-indexing**: `GET /api/sounds` and `/status` (and engine start) start an index job when the library was never
  indexed, was recovered from damage, or the starter manifest changed; `JASPER_SOUND_AUTO_INDEX=0` turns it off
  (default off under vitest so the engine suites do not render synth sounds in the background).

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

## Phase 2: cues and placement

## Phase 3: proposals and review

## Phase 4: mixing

## Phase 5: Sound Check

## Phase 6: packs, cue sources, completion

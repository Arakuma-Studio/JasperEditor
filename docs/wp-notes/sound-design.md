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
- **mg**: motion-graphic clips whose template the registry knows: intro end → `land` (thump/hit/pop), outro start →
  `exit` (swish/whoosh/reverse); lengths written at 30 fps (`MG_REFERENCE_FPS` of `sound/anchor.ts`), converted and
  compressed like `animeTemplateTiming` (intro anchored at content frame 0, outro at the content end). No registry or an
  unknown template → nothing, with `W_MG_REGISTRY_MISSING`. The model never imports `@jasper/mg-templates` (layer rule);
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
  visible settle. The deriver follows the registry's `introFrames` (WP2.2); either the template metadata or the mg source
  should use the visible settle — a WP2.2/template decision, not changed here.
- **Loud mix:** kit sounds at 0 dB gain overlap to a decoded peak of 1.36 (mono, > 0 dBFS) in the real-run export. Level is
  Phase 4 (auto gain, masking, limits); placement does not touch it.
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
- Levels: kit sounds at 0 dB overlap above 0 dBFS (true peak +3 to +5 dBTP measured in these runs): Phase 4.

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

## Phase 3: proposals and review

## Phase 4: mixing

## Phase 5: Sound Check

## Phase 6: packs, cue sources, completion

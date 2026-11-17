# audio-mix — audio buses, loudness, meters, mixer, ducking, voice-over

Workstream of the parity program. Branch `feat/audio-mix`. Scope: everything after the clip — track / submix / Mix
processing, meters, the Audio Track Mixer and Audio Clip Mixer, loudness measurement and normalisation, auto-ducking
and voice-over recording. Per-clip effects, Essential Sound and remix belong to `audio-fx` (interface below);
timeline rubber bands and fade handles to `edit-ux`.

## 1. Design

### 1.1 One mixer, two runtimes

| piece | where | what |
|---|---|---|
| DSP | `packages/audio-dsp` (`@jasper/audio-dsp`, no deps, AudioWorklet-safe) | BS.1770-4 / R128 `LoudnessMeter`, `TruePeakDetector`, `TruePeakLimiter`, `LevelMeter` + `MeterBallistics`, biquads + K-weighting (bilinear transform, any rate), BS.775 matrices / pan laws / 5.1 panner, ducking analysis, WAV codec, windowed-sinc resampler |
| model | `packages/project/src/schema/audio.ts`, `audio/strip.ts`, `audio/plan.ts` | strips, lanes, automation modes, sends, submixes, channel formats, sample rates, `master.loudness`; `buildAudioMix(seq)` → `RenderSnapshot.audioMix` (routing-aware solo, pre/post sends, mute after pre-fader sends) |
| offline mixer | `packages/project/src/audio/mixer.ts` (`OfflineMixer`) | sample-accurate (every lane per sample, 5.1 matrices every 32 samples), latency-compensated (processor latency, route delays, graph read-ahead), block-size independent (tested). Clip readers are injected |
| engine | `apps/engine/src/audio/{decode,mixdown,service}.ts`, `routes/audio.ts` | one ffmpeg decoder per playing clip (channel map, `areverse`, `atempo` or rate change, SoX VHQ resampling) → `OfflineMixer` → float WAV; two-pass loudness normalisation with the true-peak limiter; analysis and normalise jobs |
| preview | `packages/compositions/src/audio/{graph,matrix-node,worklet}.ts` | `MixGraph`: a Web Audio graph between Remotion's per-clip gain nodes and its output gain (via an overridden `SharedAudioContext.gainNode` per clip): clip channel selection + Clip Mixer trim + clip effect slot + clip pan → track strip (input map, pre inserts, pre sends, mute, fader, meter worklet, post inserts, post sends, pan / balance / 5.1 panner, solo gate) → submixes → Mix → loudness gain → true-peak limiter worklet → Mix meter worklet (levels + R128) → device fold → Remotion. The same `@jasper/audio-dsp` matrices as the export |
| web | `apps/web/src/audio/*`, panels `audioMeters`, `audioTrackMixer`, `audioClipMixer` | runtime + hooks, automation recorder (`MixerController`), scrubber, voice-over recorder, dialogs, preferences, commands |
| MCP | `apps/mcp/src/tools/audio.ts` | `measure_loudness` `get_mixer` `set_mixer_strip` `add_submix` `add_send` `write_automation` `set_audio_gain` `auto_duck` `set_loudness_normalization` `normalize_media_loudness`; `start_export` gained `audioChannels`, `audioSampleRate`, `normalizeLufs`, `truePeakDb` |

**Every export path renders the mixer's audio.** The planner no longer blocks the native path for pan or effects:
the deliverable's audio is always the offline mixer's mixdown (native: an extra `-i mix.wav` input; Remotion: the
render is muted and the mixdown is muxed into the intermediate encode, or into the direct VP9 output with a video
stream copy). Audio effects without an export processor are refused on every path with `AUDIO_EFFECT_UNSUPPORTED`
naming them (never dropped).

### 1.2 Model (all optional, read-time defaults; no schema bump)

- `Track.channelFormat`: `mono | stereo | 5.1` (5.1 = L R C LFE Ls Rs). `Track.mixer`: `automation`
  (off/read/latch/touch/write, default read), `output` (later submix; absent = Mix), `sends[]` (`id`, `target`,
  `levelDb` Animatable, `pan`, `preFader`, `mute`), `recordArm`, `soloSafe`, `inputMap`
  (stereo/left/right/swap/mono), `lanes` (`mute`, `pan51.x|y|center|lfe`), `clipAutomation` (Clip Mixer mode).
  Volume and pan lanes stay in `Track.volumeDb` / `Track.pan`.
- `Sequence.submixTracks[]` (audio-kind tracks without clips, S1…), `master.mixer.automation`, `master.loudness`
  (`enabled`, `targetLufs`, `truePeakDb`, `analysis {integratedLufs, truePeakDbtp, lra, …, mixHash}`).
- `settings.audioSampleRate` 44100 | 48000 | 96000 and `settings.masterLayout` mono | stereo | 5.1 (were literals).
- `EffectInstance.postFader` for track / submix / Mix inserts. Id prefix `snd_` for sends.
- Invariants `INV-MIX` (routes only to later submixes, ≤ 5 sends, known lanes, no clips on submixes) and
  `repairDocument` (bad outputs → Mix, bad sends and lanes dropped).
- `mixFingerprint(doc, seqId)` hashes everything the mix depends on; a stored analysis with another `mixHash` is
  stale (shown in the Loudness dialog and `get_mixer`).

### 1.3 Commands (`schemas/audio.ts`, owner `audio-mix`)

`mixer.updateStrip` · `mixer.addSubmix` · `mixer.removeSubmix` (feeders re-route to where it went) ·
`mixer.addSend` / `updateSend` / `removeSend` · `mixer.setInsertPosition` · `mixer.setLane` (static, or a keyframe
when automated) · `mixer.clearLane` · `mixer.writeAutomation` (RDP thinning, keeps automation outside the pass) ·
`clipMixer.write` (clip keyframes in content time, reversed clips handled) · `clipMixer.set` · `audio.setGain`
(set / adjust / normalizeMax / normalizeAll with measured peaks) · `audio.autoDuck` (regions → duck keyframes) ·
`mixer.setLoudness`. `effect.add` accepts submixes (`S1`); `media.derive` accepts `loudness-normalize` for audio
and video media (an audio-kind version; `replaceInClips` switches audio clips and their stream index).

### 1.4 Signal path and laws (Premiere's documented order)

```
clip: decode → gain → clip effects (processors) → volume → fades → nested gain → clip pan (balance) → track width
strip: input map → pre-fader inserts → pre-fader sends → mute → fader → meter → post-fader inserts → post sends
       → pan / balance / 5.1 panner → solo gate → output bus
Mix:   bus sum → inserts → fader → loudness gain (target − measured) → true-peak limiter → meter → device / encoder
```

Mono strips pan with the −3 dB constant-power law (Premiere's default pan law); stereo strips and sends use balance
(centre = unity). A mono clip (one channel after Modify ▸ Audio Channels) on a stereo track pans with the sequence's
**mono clip pan law** (`settings.monoClipPanLaw`, Sequence Settings ▸ Audio ▸ Mono Clip Pan Law, schema v19):
`-3dB` (the default) = the same constant-power law, `[cos θ, sin θ]`, `θ = (pan + 1)·π/4`: 0.7071 (−3.01 dB) on both
sides at the centre, unity on one side panned hard; `0dB` = the clip at unity on both sides and its pan a balance
(the opposite side attenuated with a cosine): +3 dB of power at the centre, how every mono clip played before v19.
The v18→v19 migration stores `0dB` on every older sequence, so no saved project changes its sound; new sequences
get `-3dB`. The export mixer (`OfflineMixer.applyClip`) and the preview graph (`clipPanMatrix`) apply the same law
from the clip's `RenderAudioClip.monoPanLaw` (a flattened nested clip keeps its own sequence's law); it is part of
`mixFingerprint` only at `-3dB`, so loudness analyses stored before v19 stay current. Source for Premiere: Adobe's
community manager (mstegner, 5 June 2023): "In Premiere Pro, the Pan Law is engaged anytime a mono audio signal is
sent to a stereo audio buss. This means a mono clip on a stereo audio track, or a mono audio track into a stereo Mix
track. The Pan Law will attenuate the audio signal by -3 dB when the signal is panned to the center"
(<https://community.adobe.com/questions-729/bug-report-track-hard-limiter-issues-1410345>); it cannot be turned off
in Premiere (<https://community.adobe.com/t5/premiere-pro-discussions/3db-shift-when-importing-audio-to-adobe-premiere-pro/m-p/12169962>,
<https://community.adobe.com/questions-729/mono-and-stereo-panning-inconsistencies-1408120>). Adobe's own help pages
do not state the figure; the `0dB` choice is ours (projects made before v19, or a mix built for unity mono clips).
Tests: `packages/project/test/audio-mix.test.ts` (both laws, the setting's edit, refusal and repair),
`packages/compositions/test/audio-preview-oracle.test.ts` (preview = export for panned mono clips). 5.1 → stereo folds with ITU-R BS.775 (k = 1/√2, LFE omitted; Preferences ▸ Audio ▸ 5.1 Mixdown
Type selects front / +rear / +LFE for the monitor); a strip feeding a 5.1 bus uses the 5.1 panner (unit-power point
source, Center % sharing the front image, LFE send). Solo keeps soloed and solo-safe strips plus everything that
feeds them or that they feed.

### 1.5 Interface for audio-fx (also in `/tmp/jasper-parity/audio-mix-interface.md`)

- Export / analysis / scrubbing: `registerAudioProcessor(effectId, (effect, {sampleRate, channels, where}) =>
  AudioProcessor)` (`packages/project/src/audio/processors.ts`): `process(channels, frames, {sampleRate, time,
  flicksPerSample})` in place, `latency` in samples (compensated), `reset()`. Clip effects run after clip gain and
  before volume (time = content flicks); inserts on strips (time = sequence flicks).
- Preview: `registerPreviewInsert(effectId, (ctx, effect, channels) => {input, output, update(effect, t), dispose})`
  (`@jasper/compositions`), used for clip effect slots and strip inserts; `update` runs every rendered frame.
- Auto-ducking for Essential Sound: `autoDuck(session, engine, {sequenceId, targetClipIds, triggers: {clipIds} |
  {trackIds}, sensitivity, amountDb, fadeMs})` (`apps/web/src/audio/engine-ops.ts`; resolve roles to trigger clips
  first) or the pure `duckClipKeyframes` (`@jasper/project`) / `planDucking` (`@jasper/audio-dsp`).

## 2. Usage

- **Audio Meters** (Editing workspace, right of the timeline): peak + RMS bars per Mix channel (2, 1 or 6), peak
  hold, clip LEDs (click to clear), 0 … −60 dB scale, S buttons solo a channel on the monitor; M / S / I / LRA / TP
  readouts (BS.1770-4 / R128, true peak red above −1 dBTP) with Reset.
- **Audio Track Mixer** (Shift+6; Audio workspace): per strip channel format, input map, effect slots (5; ↓/↑ moves
  across the fader, click bypasses), sends (5; knob level, Pre/Post), pan knob or 5.1 panner pad (Center %, LFE),
  M / S / R, automation mode, fader + meter, output (Mix or later submix), + Submix / Delete Submix.
- **Automation**: press play; in Write every control is recorded from the start, Latch from the first touch and
  then held, Touch while held then ramps back over the automatch time (Preferences ▸ Audio, default 1 s). Stopping
  writes one "Write Automation" undo step (thinned keyframes); Write strips switch to Touch (preference). Off ignores
  automation; Read plays it (a static fader move on an un-automated lane is kept).
- **Audio Clip Mixer** (Shift+9): the clip under the playhead per track (volume, balance), same modes, writes clip
  keyframes.
- **Audio Gain** (G or clip context menu): Set / Adjust / Normalize Max Peak / Normalize All Peaks; the normalise
  modes measure source peaks on the engine (Peak Amplitude readout).
- **Audio Scrubbing** (Shift+S, View menu, Preferences): dragging the playhead, stepping frames and reverse / fast
  shuttle play short snippets of the full mix (offline mixer on WebCodecs-decoded audio, reversed when going back).
- **Auto Duck** (Clip ▸ Audio Options, clip menu): select music clips; choose trigger tracks, Sensitivity (0–10),
  Reduce By, Fades.
- **Loudness**: Sequence ▸ Loudness Normalization… (target presets −14 / −16 / −23 / −24, true-peak limit, Analyze);
  Clip ▸ Audio Options ▸ Measure Loudness; Normalize Loudness… on clips / Project items makes a normalised WAV version.
  Export mode: Audio Channels (match Mix / stereo mixdown / mono / 5.1), Sample Rate, Loudness (sequence / off /
  targets).
- **Voice-over**: the mic button on an audio track header (or Sequence ▸ Record Voice-over; the record-armed track
  by default). Pre-roll with countdown beeps, punch-in/out on In/Out, post-roll; Space or the button stops; the take
  is uploaded and placed (one "Record Voice-over" step). Preferences ▸ Audio ▸ Voice-Over Record: source device,
  input channel, name, cues, pre/post-roll, Latency Offset (ms, added to the measured round trip; positive moves takes
  earlier). Electron grants only audio media permission to the app origin (macOS:
  `askForMediaAccess`, `NSMicrophoneUsageDescription`, audio-input entitlement).
- **Sequence settings** (Properties with no selection ▸ Audio): sample rate 44.1 / 48 / 96 kHz and Mix format.

## 3. Verified behaviour (measured)

- Loudness oracle vs ffmpeg `ebur128` and EBU Tech 3341 / 3342 (`packages/audio-dsp/test/loudness-oracle*.test.ts`):
  frame-by-frame M and S, I, LRA, max M/S within ±0.1 LU, true / sample peak within ±0.1 dB (+ ffmpeg's metadata
  quantisation) on sines 20 Hz–15 kHz at 32 / 44.1 / 48 / 96 kHz, mono / stereo / 5.1, noise, gated programmes and
  the published cases. Worst frame Δ 0.000 LU, I 0.009 LU, TP 0.027 dB (after matching ffmpeg's libswresample
  upsampling kernel: 32 taps, Kaiser β 9; FilmCraft's 16-tap kernel was 0.9 dB low on noise).
- Limiter: output true peak ≤ ceiling + 0.05 dB on squares, fs/4 at 45°, clipped noise, transients, random input.
- Exports (`apps/engine/test/audio-mix.test.ts`, real ffmpeg): balance hard left → right < −40 dB; pre-fader send of
  a muted track to a −6 dB submix at −6 dB: −12.0 ± 0.3 dB, centred; 44.1 kHz delivered; 5.1 puck rear-left → only Ls
  (others < −40 dB), stereo export = BS.775 fold (−3.01 dB on L); normalisation to −16 LUFS lands within 0.15 LU
  (AAC) with TP < −0.8 dBTP, an over-loud target holds −2 dBTP; volume / track / Mix keyframes per sample within
  0.05 dB (PCM export, `native-animated.test.ts`).
- Real app (dev stack on 49081/49082, driven over MCP and the browser): a 10 s cut with A1 panned left, a submix, a
  send and −16 LUFS normalisation exported natively at exactly −16.0 LUFS integrated, TP −2.7 dBTP, L −14.6 / R −20.9
  dB RMS; 5.1 export `aac 5.1` with the tone only on Ls; 44.1 kHz stereo fold. The Program monitor played through the
  graph: Mix meter peaks L 0.146 / R 0.092 with the pan, A1 strip meter live, R128 readouts updating.

- Built app, `e2e/audio-mix.spec.ts` (Chrome headless, fake microphone; `E2E_PORT=49080 E2E_SKIP_BUILD=1 pnpm exec
  playwright test e2e/audio-mix.spec.ts`, 6 passed): Audio Meters show M/S/I/TP while playing tone.wav (TP −9.0 dBTP =
  the file's peak); the Track Mixer balance knob (keyboard) writes −100 and its M button mutes A1; + Submix adds S1;
  Audio Gain (G) ▸ Normalize Max Peak reads "−9.0 dB" from the engine and sets +9 dB; the native and the Remotion exports then have
  L ≈ −19 dB, R < L − 40 dB; a voice-over take ("Voice-over 1.wav") lands on A3 at the record point in one
  "Record Voice-over" step. This run found a real bug, now fixed: the Mix strip also created a second (silent) meter
  under the same id, and its readings raced the loudness meter's, so the Audio Meters panel sometimes showed nothing.

## 4. Comparison with FilmCraft (reference)

| area | FilmCraft | here |
|---|---|---|
| loudness meter | BS.1770-4, histogram gate, LRA, TP 16-tap | ported, TP kernel matched to ffmpeg (0.03 dB vs 0.9 dB on noise), oracle at 4 rates + 5.1 + Tech 3341/3342 |
| limiter | — (normalisation gain only) | look-ahead true-peak limiter with a tested guarantee; used in export, media versions and preview |
| mixer graph | strips, sends, submixes, solo, 5.1 panner, latency comp. | same, plus sample-accurate lanes in a block-size-independent mixer shared by export / analysis / scrubbing, and a Web Audio graph with the same matrices for the preview |
| automation | Off/Read/Latch/Touch/Write, thinning, Clip Mixer | same semantics (ported recorder), one undo step per pass |
| meters | stereo/5.1 peak + R128 readout | + RMS, peak hold, clip LEDs, channel solo, LRA, reset |
| ducking | envelope / activity / keyframes | ported; streaming 1 ms-bucket envelope on the engine for long programmes; dialog + MCP + function for Essential Sound |
| voice-over | cpal input, WAV, punch, cues | browser / Electron `getUserMedia` + worklet capture, playhead-paired timing, upload + place in one step |
| normalisation | export target | export two-pass + preview (analysis + limiter) + media versions |
| sample rates | any | 44.1 / 48 / 96 kHz sequences, SoX VHQ resampling of every clip and of the deliverable |

## 5. Decisions and sources

- Adobe behaviour researched from the Premiere Pro user guide on helpx.adobe.com: "Mixing audio tracks and clips"
  / "Audio Track Mixer" (strip layout, 5 effect and send slots, pre/post-fader, submixes, solo safe), "Automating
  audio mixing" (Off/Read/Latch/Touch/Write, automatch time, Switch to Touch after Write, keyframe thinning),
  "Adjust volume levels" / "Audio Gain" (Set, Adjust, Normalize Max Peak, Normalize All Peaks), "Essential Sound
  panel ▸ Ducking" (Duck against, Sensitivity, Reduce By, Fades, Generate Keyframes), "Record voice-over"
  (pre-roll/post-roll, countdown cues, input channel, punch with In/Out), "Loudness Normalization" export options
  (ITU BS.1770, target loudness, true peak limit), "Keyboard shortcuts" (G Audio Gain, Shift+S audio scrubbing,
  Shift+6 / Shift+9 mixers). Formulas: ITU-R BS.1770-4, EBU Tech 3341/3342, ITU-R BS.775.
- Premiere's Essential Sound ducking defaults (Sensitivity 6, Reduce By −18 dB, Fades 800 ms) follow FilmCraft;
  the sensitivity→threshold mapping (`−20 − 4·s` dBFS) is undocumented by Adobe — FilmCraft's choice kept.
- Exports always use the mixer's audio (one implementation, never approximated); Remotion renders muted video.
- Preview lanes update per rendered frame with 8 ms ramps; exports are per sample. The difference is below what the
  ear resolves; automation recorded in the preview is written sample-accurately.
- The preview AudioContext stays at 48 kHz (Remotion's); 44.1 / 96 kHz sequences are resampled by the browser in
  preview and by SoX in exports.
- `packages/audio-dsp` is a new dependency-free layer under `@jasper/project` (layer table and ARCHITECTURE §3.1 row
  added).
- Nested sequences reach the mix flattened (edit-structure's `nestGain`: nested track faders and Mix); the nested
  sequence's own pan, sends and submixes are not applied inside the nest.
- The `tracks` analysis scope measures the Mix with only those tracks playing (solo semantics, the Mix fader
  included, normalisation excluded), over the whole sequence or a range (`startFrame` / `endFrame` / `inOut`, like the
  `range` scope). `measure_loudness` sends `start` / `end` (or `scope: "inOut"`) with every scope but `clips`, of the
  soloed `tracks` when given; `scope: "tracks"` with a range used to measure the whole sequence (video team report,
  2026-11-17). The kept result's key holds the planned range, so a ranged request never gets a whole-sequence result.
- The `clips` scope measures each clip **pre-fader**: the sum of the track inputs (`tap: 'track-inputs'`) with only
  that clip playing — the same decode and source range, clip gain, clip effects, volume, fades and pan as the mix, but
  not the track's fader, pan, inserts, sends or the Mix; `levels: "source"` also skips the clip levels. The
  `measure_loudness` result says so (`clipLevels`). At that tap the mixer used to discard the graph's read-ahead (the
  latency of any track, submix or Mix insert, e.g. a Pitch Shifter on another track) although the track inputs carry
  none, so every clip was measured that many samples late and lost its start: a 0.52 s trim of an MP3 pop measured
  −23.9 dBFS against −11.7 dBFS in the mix (the reported project, A1's Rubber Band R3 Pitch Shifter). The track inputs
  are now read on time (`OfflineMixer`), which also corrects the sound-design renders at that tap. Test:
  `audio-analysis-job.test.ts` (a trimmed libmp3lame fixture, `pop-trim.mp3`, within 0.5 dB of the mix). MP3 encoder
  delay is not a factor: FFmpeg trims the LAME header's priming samples on every decode, and an input seek lands on
  the same sample position as a decode from the start (checked on `pop-trim.mp3` and the reported `197. pop.mp3`:
  best lag 0; the seek's samples differ only by the decoder's warm-up, far below −80 dB).
- Analyses (`POST /api/audio/analyze`) are `analysis` jobs: progress is the frames of the range mixed so far
  ("Mixing audio: frame n of N"), cancelling stops the mix. A finished result is kept per engine (64, most recently
  used) by the content of what the offline mixer plays (`AudioService.analysisKey`: the snapshot's mixer graph without
  the Mix normalisation, its audio clips with their media fingerprints, the range, scope, levels, activity and delivery
  target), so the same measurement of an unchanged mix answers at once — finished, `200` even without `wait` — and a
  request repeated while one runs joins it (dedupe key). The sound-design caches do not serve it: `MeasureCache` holds
  whole-mix summaries keyed by `audioWorld` (sound design's own delivery analysis), and the delivery cache is keyed by
  the mixed pass 1, so it needs the mix it would skip. The MCP tools (`measure_loudness`, `set_audio_gain` normalise
  modes, `auto_duck`, `set_loudness_normalization`, `auto_match_loudness`, `generate_essential_ducking`) start the job and
  poll it with progress for up to 300 s; they used to wait inside one engine request, which a mix through slow effects
  (Rubber Band R3 at "best": ≈ 3.5× real time on stereo, reported) outlived at the 180 s request deadline. Past the
  wait `measure_loudness` returns `{jobId, timedOut, running, next: wait_for_job}`; the others refuse with `E_TIMEOUT`
  and the same next step, then answer at once from the kept result. Tests: `apps/engine/test/audio-analysis-job.test.ts`,
  `apps/mcp/test/measure-loudness.test.ts`; eval case `loudness-slow-mix`.

## 6. Limits

- Voice-over takes are placed compensating the Program monitor's `baseLatency + outputLatency` and the input
  device's `MediaTrackSettings.latency` (Chrome reports it; other browsers count 0) plus Preferences ▸ Audio ▸ Latency
  Offset (spec 12 WP0.1, `apps/web/test/voiceover-latency.test.ts`). The frame / capture pairing assumes frame reports
  never come before the frame starts; when the display refresh and the timeline rate are phase-locked (30 fps on a
  60 Hz display) the residual is the constant report delay (< one display frame): set Latency Offset to correct it.
  Tested with simulations and Chrome's fake media stream only (no microphone here).
- macOS microphone entitlement / prompt are configured but untested (no macOS).
- Submix tracks appear in the mixers, MCP and the model but not as timeline rows (timeline layout is `edit-ux`'s).
- No insert effects ship here (they are audio-fx's); slots accept any registered audio effect.
- Kept analyses live in engine memory only: an engine restart measures again. The editor's own analyses (Loudness
  Normalization ▸ Analyze, Measure Loudness, Auto Duck) still wait on one request (`wait=1`; no client deadline) and
  show no progress, though repeats come back at once from the kept result.

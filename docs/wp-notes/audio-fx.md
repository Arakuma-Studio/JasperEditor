# audio-fx — audio effects, Essential Sound, Music Remix

Workstream `audio-fx` of the parity programme. It adds Premiere's audio effects (60 effects in the nine Audio Effects
folders), clip and track effect stacks that preview and export with one deterministic DSP, Effect Controls editors
(EQ curves, transfer curves, gain-reduction meters, graphic-EQ banks), the Essential Sound panel, Music Remix (panel
and tool) and the MCP tools. It builds on audio-mix (`docs/wp-notes/audio-mix.md`): its offline mixer, preview graph,
BS.1770 meter, true-peak limiter and `audio.autoDuck`.

## 1. Design

### 1.1 One DSP, three hosts

`packages/audio-fx` (`@jasper/audio-fx`; layer: depends on `@jasper/audio-dsp` and the light `@jasper/project/audio`
subpath) holds every processor. Conventions: planar `Float32Array` channels, `process(channels, start, end)` in place,
output independent of the block size, denormals flushed, `reset()` restores the initial state, optional `latency()`,
`responseDb(f)` (filters), `transferDb(band, inDb)` (dynamics) and `meters()`. Parameters arrive as numbers (enum →
option index, boolean → 0/1) through `applyParams`; the catalogue in `packages/project/src/registry/audio/*` is the
single source of names, ranges, defaults and units (a test checks that every catalogue entry has exactly one processor
with the same parameters).

Hosts:

| Host | Where | Keyframes |
|---|---|---|
| Export, loudness analysis, scrubbing | `EffectSlot` (`packages/audio-fx/src/host.ts`) registered with audio-mix's `registerAudioProcessor` for every effect id; the offline mixer runs it in every export path (native and Remotion get the same mixer audio) | evaluated every 32 samples (`CONTROL_BLOCK`) at `ctx.time + i·flicksPerSample` (clip effects: content time; track/Mix: sequence time) |
| Preview | AudioWorklet node `jasper-audio-fx` (`packages/compositions/src/audio/fx-processor.ts`, `FxSlotCore`) per effect, inserted by `registerPreviewInsert` in audio-mix's graph | the main thread posts the effect instance per frame; the processor smooths |
| Analysis (editors) | `createProcessor(id)` in the web app for `responseDb` / `transferDb` curves; meters come from the worklet (`audioFxMeters`) | — |

Signal order (both runtimes): decode → clip effects (stack order) → clip gain + Volume → fades → pan → track effects
(pre-fader slots) → fader → post-fader slots → Mix. Clip gain is applied after the effects, as in audio-mix's code and
FilmCraft; this is why Loudness Auto-Match measures with `levels: 'source'` (effects, no gain).

Latency: processors report `latency()` (look-ahead limiter, STFT effects, convolution, pitch, FFT filter). The export
mixer compensates clip and track latency (audio-mix's mixer). The preview applies the same plan (spec 12 WP0.1,
`planMixLatency` in `packages/compositions/src/audio/graph.ts`): every preview slot reports its latency
(`registerPreviewInsert(…, latency)`, the processor's own `latency()`), each route into a bus gets a DelayNode so all of
the bus's inputs arrive together, and every clip's media starts early by the graph's read-ahead (the Mix's latency, plus
the loudness limiter's while it runs) plus its own clip effects' latency (`compensate()` in `AudioLayer.tsx`). Lanes,
send levels, pucks and insert automation are evaluated at the time of the samples each stage is processing
(`stripStageTimes`), as the export does. The graph follows Remotion's transport (spec 12 Phase 0 close-out,
[sound-design.md](sound-design.md) §Phase 0 close-out): a seek flushes its delay lines and effect processors, a Play
after a paused seek is primed (the sources start at the play position and the picture waits for the program), and the
read-ahead is held while playing, so latency changes during playback keep the audio in flight instead of re-creating
the media players.

### 1.2 Model (optional fields, read-time defaults, no schema bump)

- `EffectInstance.essential?: string` — the Essential Sound slot that owns the instance (`noise`, `dehum`, `eq`, …).
- `AudioClip.essential?: unknown` — Essential Sound settings, read through `readEssentialSound` (zod, loose).
- `AudioClip.remix?: ClipRemix` — a remix piece: group id, index/count, the original `{start, duration, sourceIn}`,
  target, segments, variations, BPM.
- `EssentialSound.panOffset?: true` — the Pan section is an offset (written by every command; settings saved without
  it come from builds that wrote Pan into the clip's pan, `migrateLegacyPan`).
- Invariants `INV-ESSENTIAL` (unreadable settings, stray slot markers, wrong remix counts, a Pan saved by a build that
  wrote it into the pan) with `repairDocument` actions `normalize-essential`, `drop-essential-mark`, `recount-remix`,
  `migrate-essential-pan`.

### 1.3 Commands (`schemas/essential.ts`, owner `audio-fx`, milestone M3)

`essentialSound.setType`, `essentialSound.clearType`, `essentialSound.set` (dotted keys), `essentialSound.applyPreset`,
`essentialSound.autoMatch` (measured LUFS in, gain out), `clip.remix` (plan pieces in, grouped clips + crossfades out),
`clip.remixRevert`. Effects use the existing `effect.*` / `param.*` / `keyframe.*` commands.

### 1.4 Essential Sound = ordinary effects (FilmCraft `essential.rs` design)

The panel never processes audio. Each option reconciles into an ordinary, keyframable clip effect marked with its slot:

| Option | Effect |
|---|---|
| Repair ▸ Reduce Noise | DeNoise (reduction = 3 × amount dB) |
| Repair ▸ Reduce Rumble | Highpass (cutoff 30 + 12 × amount Hz) |
| Repair ▸ DeHum (50/60 Hz) | DeHummer |
| Repair ▸ DeEss | DeEsser |
| Repair ▸ Reduce Reverb | DeReverb |
| Clarity ▸ Dynamics | Single-band Compressor |
| Clarity ▸ EQ (preset + amount) | Simple 3-Band EQ |
| Clarity ▸ Enhance Speech | Enhance Speech |
| Creative ▸ Reverb (preset + amount) | Studio Reverb |
| Stereo Width (Ambience) | Stereo Width |
| Mute | Mute |

Loudness ▸ Auto-Match writes clip gain; Clip Volume offsets the Volume; Pan (SFX) offsets the clip's own pan (since
spec 12 Phase 0; before, it overwrote it: projects saved then open with the section switched off, value kept, so the
pan stays as saved, `migrateLegacyPan`), and what the ±100 / −∞…+15 dB ranges clamp away is given back when the
offset is switched off (`EssentialSound.residual`); Ducking writes Volume
keyframes through `audio.autoDuck` (triggers = clips of the "Duck against" types); Duration ▸ Remix runs `clip.remix`,
Duration ▸ Stretch `clip.setSpeed`. Reconciliation is by delta: only parameters whose derived value changed are
written (user keyframes and edits on other parameters survive), switched-off slots remove their effect, Clear Audio
Type removes every effect, gain, Volume and pan change the settings made. Copy/paste and effect presets drop the slot
marker when the target clip has no Essential Sound settings (tested).

### 1.5 Remix

`analyzeMusic` (streaming STFT, spectral-flux onset envelope, autocorrelation tempo 50–200 BPM with a prior at 120,
dynamic-programming beat tracking, per-beat chroma + mel cepstra, beat self-similarity), `planRemix` (joints at beat
boundaries where the context is most similar; intro and outro kept). The engine route `POST /api/audio/remix-plan`
decodes the clip's range to mono 22.05 kHz with ffmpeg and caches analyses (LRU 8) so the Remix tool can re-plan while dragging. The edit is `clip.remix`: the clip becomes grouped
pieces with 1-frame constant-power crossfades; each piece's frame-rounding shift is carried into the next piece's
`sourceIn` so jumps stay whole beats. A remixed clip is remixed again from its original; Revert Remix restores it.

## 2. Usage

- **Effects panel** ▸ Audio Effects ▸ folder ▸ effect: drag onto an audio clip or double-click to apply to the
  selection; track effects from the Audio Track Mixer slots. Audio Transitions bin: Constant Gain, Constant Power
  and (new here) Exponential Fade — dB-linear over 60 dB, (1000^x − 1)/999, the same function in preview, scrub and
  export (`fadeCurve`).
- **Effect Controls**: the EQs show a frequency-response curve with draggable band handles (wheel = Q); the graphic
  EQs a slider bank; compressors / expander / limiter / multiband their transfer curve with a live gain-reduction meter
  while playing; Loudness Meter its readout. Every number has a stopwatch (keyframes).
- **Essential Sound** (Window ▸ Essential Sound; first tab of the Audio workspace): type buttons, preset menu (built-in
  plus "Save" user presets in this browser), sections per type, Auto-Match, Generate Keyframes (ducking), Duration
  (Remix / Stretch), Clip Volume, Mute, Clear Audio Type.
- **Remix tool** (Tools panel, rate-stretch group flyout): drag a music clip's out edge; the tooltip shows the target and
  the remix happens on release (toast with the result length, segments and BPM).
- **Menus**: Clip ▸ Audio Options ▸ Remix… / Revert Remix / Auto-Match Loudness / Clear Audio Type; Revert Remix in the
  clip context menu of a remixed clip.
- **MCP** (`apps/mcp/src/tools/audio-fx.ts`): `list_audio_effects`, `get_audio_effects`, `add_audio_effect`,
  `set_audio_effect` (values or `{"keyframes": [{at, value}]}`, enable, reorder), `remove_audio_effect`,
  `get_essential_sound`, `set_essential_sound`, `clear_essential_sound`, `auto_match_loudness`,
  `generate_essential_ducking`, `remix_audio`, `revert_remix`.

## 3. Verified behaviour (measured)

Unit tests (`pnpm vitest run packages/audio-fx packages/project/test/essential.test.ts
packages/compositions/test/audio-fx-preview.test.ts apps/engine/test/audio-fx.test.ts apps/mcp/test/audio-fx.test.ts`):

- **Filters vs. RBJ cookbook**: peaking/shelving/pass/notch magnitudes match the analytic cookbook response; LP/HP are
  −3.01 dB at the cutoff with 12 dB/oct; pass filters of every slope are digital Butterworths (6·N dB/oct); Scientific
  Filter designs meet Chebyshev ripple and elliptic stop-band specs, all poles inside the unit circle; graphic EQ bands
  sit on ISO 266 centres.
- **Compressor static curve** equals the textbook soft-knee formula; steady-state sine output within 0.2 dB of
  `transferDb`; attack/release time constants within 15 %.
- **Hard Limiter** never exceeds Maximum Amplitude (sample peak) in random blocks; with True Peak the 4× interpolated
  peak stays within ceiling + 0.1 dB; below the ceiling it is a pure delay equal to `latency()`.
- **DeHummer** notches 50/60 Hz and every enabled harmonic by ≥ 30 dB while a 1 kHz tone stays within 0.5 dB.
- **Pitch Shifter** shifts 440 Hz by the requested semitones + cents within 0.5 %; zero shift is the input delayed by
  exactly `latency()`.
- **Latency compensation**: every effect's `latency()` equals its measured impulse delay (limiter, FFT filter, DeNoise,
  pitch, convolution = 256).
- **Determinism and block-size independence** for every processor (generic registry contract, parameter change
  mid-stream, extremes stay finite, tails without subnormals, reset).
- **Preview/export parity**: every effect gives bit-identical samples in the worklet core (128-sample quanta) and the
  export slot (irregular mixer blocks); with keyframed parameters the preview (per-frame updates) stays within 1.5 dB
  of the export (32-sample control rate).
- **Remix** on synthetic beat tracks: tempo within 1 BPM, beats within 10 ms; plans within half a beat of the target
  at default settings (always within one beat), cut at beat boundaries; silence, steady tones and noise are refused
  (`NO_BEAT`).
- **Engine**: Amplify/Invert/Channel Volume export natively with exact gains (relative to the same clip without
  effects); a limiter caps the exported peak; a reversed clip with pan and reverb exports natively (no
  `AUDIO_EFFECT_UNSUPPORTED`); remix route + `clip.remix` → a 30 s export; Auto-Match lands within 0.5 LU of −23 LUFS.
- **MCP**: tool tests through the protocol (in-memory engine), strict-argument and annotation convention tests, README
  tool list.

Real app (2026-10-07, dev stack on ports 49101/49102, synthetic voice with hum + 120 BPM music):

- Via MCP: Dialogue with Reduce Noise, DeHum (60 Hz), EQ preset; Music; Auto-Match (voice −9.6 → gain −13.4 dB);
  ducking (7 regions); Remix 40 s → 25 s (3 pieces, 120.07 BPM, 750 frames); a keyframed Lowpass (300 Hz → 12 kHz over
  10 s); Hard Limiter on the Mix. Native export: 25.000 s; spectrogram shows the music ducking under each voice burst,
  the 60 Hz hum gone and the low-passed start (2.4 kHz partial −46.6 dB at 0.3–1.5 s vs −35.2 dB after 3 s).
- In the editor: Essential Sound shows the MCP-made settings (Auto-Match readout "−9.6 LUFS → −23 LUFS (−13.4 dB)");
  Effect Controls shows the Simple 3-Band EQ curve and the Lowpass keyframes; during playback the Single-band
  Compressor's gain-reduction meter read −15.1 dB (threshold −30 dB, ratio 4, input peaks ≈ −10 dBFS: expected 15 dB).
- Playwright `e2e/audio-fx.spec.ts` (`E2E_PORT=49100`): Effects panel → Parametric Equalizer → EQ curve in Effect
  Controls; Essential Sound Dialogue + Reduce Noise + Auto-Match (gain = −23 − measured); Duration ▸ Remix to 20 s
  (within 0.6 s); Remix tool out-edge drag; native export length = sequence length. Screenshots in
  `test-results/e2e-audio-fx/`.

## 4. Comparison with FilmCraft (reference) and Premiere

- Effect list: every FilmCraft `audio-dsp/src/effects/*` effect is ported (`licenses/ported/audio-fx.md`), plus Mono
  Maker, Loudness Auto Gain and the Premiere simple filters (Bass, Treble, Highpass, Lowpass, Bandpass, Low/High
  Shelf, Simple Notch), the three graphic EQs and the channel utilities as separate effects (Premiere's names).
- Better than the reference: convolution impulses are energy-compensated (√(a/(2−a))) so the measured RT60 matches
  the parameter (the reference was 15–25 % short); remix refuses steady tones (`MAX_STEADY_FLUX`); the true-peak
  limiter is audio-mix's oversampled look-ahead limiter (ceiling guarantee tested); f64 analysis state.
- Remix is grouped pieces with crossfades (editable, revertible) instead of a single opaque clip.
- Not ported: FilmCraft's egui panels (used as layout reference only).

## 5. Decisions and sources

Sources (Adobe pages were researched through web search results; `helpx.adobe.com` answers 403 to direct fetches from
this machine (Akamai) and the Wayback Machine answered 429, so the pages themselves could not be read in full):

- Premiere Pro "Audio effects and transitions": https://helpx.adobe.com/premiere-pro/using/audio-effects-transitions.html
  (folders, effect names, Fill Left/Right, Swap, Invert, Channel Volume, Balance).
- Audition "Amplitude and compression effects": https://helpx.adobe.com/audition/using/amplitude-compression-effects.html
  (Dynamics, Hard Limiter, Multiband, Single-band, Tube-modeled parameters and ranges).
- Audition "Stereo imagery effects": https://helpx.adobe.com/audition/using/stereo-imagery-effects.html.
- Essential Sound panel: https://helpx.adobe.com/fi/audition/using/essential-sound-panel.html,
  https://www.adobe.com/learn/premiere-pro/web/essential-sound-panel (types; Loudness, Repair, Clarity, Creative;
  Auto-Match).
- Remix: https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/remix-tool-considerations-in-premiere.html
  (Target Duration, Segments, Variations; "within 5 seconds of the target, typically within 1 second").
- Community threads on Fill Left/Right behaviour (community.adobe.com) for channel routing.
- Formulas: R. Bristow-Johnson "Audio EQ Cookbook"; Giannoulis, Massberg & Reiss soft-knee compressor; Laroche &
  Dolson 1999 phase vocoder; Ellis 2007 beat tracking; Vaseghi & Rayner click removal; ITU-R BS.1770-4 (via
  audio-dsp).

Decisions (undocumented behaviour or our choice):

- Clip gain is post-effects (audio-mix and FilmCraft order); Auto-Match measures the signal after the effects.
- Remix accuracy: within one beat (Adobe documents ≤ 5 s, typically 1 s). **Variations** follows FilmCraft (how far a
  joint may move from its even position, ±(1 + 7·v/100) beats), not Adobe's documented "melodic vs. harmonic
  emphasis"; Segments matches Adobe (fewer vs. more cuts).
- Remix pieces are joined by 1-frame constant-power crossfades; ducking keyframes made before a remix must be
  regenerated afterwards (the panel and `generate_essential_ducking` do it over all pieces).
- DeNoise's learned noise print uses a keyframed Noise Model (Learn → Print); the state resets at the clip start.
- Not animatable (hold-only would click or need a re-design): Hard Limiter look-ahead, release, true-peak and link;
  Convolution impulse, size and damping.
- Preview keyframes are evaluated per video frame and smoothed; export every 32 samples (≤ 1.5 dB difference while a
  parameter moves, identical when static).
- Essential Sound EQ and reverb preset names and values are ours (Adobe's lists are not documented in full).
- User Essential Sound presets live in the browser (`localStorage`), not in the project.
- Expressions refuse audio-effect parameters (expressions workstream); unchanged.

## 6. Limits

- Preview latency compensation (spec 12 WP0.1) starts the media early by the read-ahead. Every Play is primed (spec 12
  Phase 0 close-out for Plays after a paused seek; since sound-design Phase 6 → preview transport carry-overs after a
  plain pause too): nothing at the play position is lost, the picture waits the read-ahead plus clip-effect latency plus
  two render quanta (up to 3 s, else unprimed; the Program monitor shows buffering from 0.2 s) and both start together
  (`e2e/sound-p0-transport.spec.ts`, `e2e/sound-p6-transport.spec.ts`). A seek *during* playback restarts playback
  (pause, seek, play: the picture holds as on Play) and its audio starts on its first sample. Frame-based (STFT) inserts start
  their frames where processing started, so the first ≈ 0.2 s after an onset can differ from an export started
  elsewhere by ≈ −40 dB (the same holds between two exports with different range starts); steady state is
  sample-identical. Clips that start later are premounted by their lead (≥ 2 s), so a cut is heard from its first
  sample (`e2e/sound-p0-preview.spec.ts`). A latency change during playback (normalisation on/off, an insert added or
  removed) keeps the audio in flight; when the latency grew, the Program monitor restarts playback primed with the new
  read-ahead (a brief picture hold) instead of leaving the Mix late until the stop; the media players are not re-created.
- 5.1 clips: processors run per channel; stereo-image effects act on L/R only and pass the other channels. Surround
  Reverb, Mastering, Loudness Meter and Loudness Auto Gain handle all six channels (Dry / output / maximiser on every
  channel, BS.1770 weights; sound-design Phase 0, `packages/audio-fx/test/regressions-p0.test.ts`).
- Remix analyses at most 30 min of music (`MAX_REMIX_SOURCE_SECONDS`: the beat similarity matrix grows with the square
  of the length).
- The Remix tool needs the engine (analysis on ffmpeg-decoded audio); offline browser-only sessions get a toast.
- No spectral display / noise-print capture UI beyond the keyframed Noise Model; no Audition-style multitrack effects.
- `ui_locate` (mcp-cli) centres timeline clip targets on the whole clip rectangle even when it is scrolled partly out
  of view; clicking at explicit coordinates works (observed during the real-app check; not changed here).

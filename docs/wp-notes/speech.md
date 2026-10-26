# wp speech: local speech-to-text (Whisper), VAD word bounds, speaker labels

Workstream `speech` of the parity program. Transcripts are made on the user's computer with OpenAI Whisper on ONNX
Runtime, with word timestamps, language detection or a chosen language, translation to English and speaker labels.
They are written into the existing `TranscriptSchema` (one transcript per media, reused by every clip of it), so the
captions workstream's Text panel, text-based editing and Create Captions work on them unchanged. Ported from
FilmCraft `crates/speech` and OpenAI Whisper (records: `licenses/ported/speech.md`,
`licenses/ported/speech-openai-whisper.md`).

## 1. Runtime decision

| Option | Verdict |
|---|---|
| **Whisper ONNX on `onnxruntime-node`** (chosen) | Already shipped for the processing models (D-24) and staged by desktop packaging on Linux, macOS and Windows; no extra native build. The onnx-community `whisper-*_timestamped` exports have an encoder, a merged decoder with key/value cache **and the cross-attention weights as outputs**, which word timing by DTW needs. Everything around the network (mel, decoding rules, beam search, alignment, VAD, speakers) is our TypeScript, so behaviour is identical on every OS and testable without a model. |
| whisper.cpp binary | MIT and fast, but a native binary per OS/arch to build, sign and ship (we cannot build macOS/Windows here), a second model format (GGML), and its DTW word timing is less complete than OpenAI's heuristics. |
| transformers.js | Pulls its own onnxruntime build (a second native runtime next to ours), a large dependency, and its pipeline hides the decoding loop (no voice-aware seek, no word-bound repair, no control of chunk stitching). |

Heavy work runs in a child process (`jasper-speech`, D-07), started like `jasper-proc`: the TypeScript source through
tsx in a checkout, `dist/jasper-speech.mjs` (esbuild, `onnxruntime-node` external) next to the engine bundle in
builds and the desktop app (`apps/engine/scripts/build.mjs`, `apps/desktop/scripts/package.mjs`).

## 2. Models (processing-model catalogue, `speech`)

`apps/engine/src/processing/models.json` gained a `speech` list (the same catalogue file, `JASPER_MODEL_CATALOG` in
tests). Spec 16 added `whisper-large-v3-turbo` (fp32, external data) and `whisper-large-v3-turbo-fp16` (§11); the
default follows the recommendation for the computer (§11.4). The original six models: `whisper-tiny`, `whisper-tiny.en`, `whisper-base`, `whisper-base.en`, `whisper-small`,
`whisper-small.en` — 147 MB, 147 MB, 280 MB, 280 MB, 926 MB, 926 MB. Each has five files (config, generation config
with the alignment heads, tokenizer, encoder, merged decoder), every one pinned to a Hugging Face revision of
`onnx-community/whisper-*_timestamped` and checked against its SHA-256. Licence: MIT (OpenAI Whisper code and weights;
the Hugging Face release is labelled Apache-2.0), shown before every download and in Help ▸ About ▸ Licenses.

- Store: `<appdir>/models/speech/<id>/` (`apps/engine/src/speech/models.ts`): `.partial` download while hashing,
  rename on a matching SHA-256 (a mismatch deletes the part file and fails `SPEECH_MODEL_CHECKSUM`), `install.json`
  records what was verified (size + mtime) so loading does not re-hash a gigabyte; a changed file is re-hashed.
- Install runs as the processing catalogue's `model-download` job (`POST /api/speech/models/:id/install`, also
  `POST /api/processing/models/:id/install`), with byte progress per file in the Jobs panel; `DELETE
  /api/speech/models/:id` removes one (refused while it downloads).
- Capability `features.speech` {status, reason, runtime, modelsInstalled, defaultModel} → the web `transcription`
  flag that gates the commands.

## 3. Recognition (`apps/engine/src/speech/`)

1. **Audio**: ffmpeg decodes the chosen audio stream to mono 16 kHz float (the media's content time from 0, like
   every other decoder of the engine), or the sequence mix (below).
2. **Front end** (`core/mel.ts`, FilmCraft port): Whisper's log-mel spectrogram, with a mixed-radix FFT (tested equal
   to a direct DFT).
3. **Windows and stitching** (`worker/whisper.ts`): 30 s windows from `seek`. The next window starts where the last
   complete segment ends — with word timing, at the end of the last word, moved forward through voiced 10 ms frames up
   to the segment's end timestamp (our *voice-aware seek*: DTW ends words early, and the plain OpenAI rule re-decoded
   the tail of the last word as a hallucinated word, e.g. "minutes. **bits,** A pair…"). The unfinished tail of a window
   is therefore decoded again in the next one (overlap), and words never repeat or leave gaps (stitching clamps each
   word between the previous word and the window end).
4. **Decoding** (`core/decode.ts`, OpenAI `decoding.py`): suppress blank/non-speech/special tokens, timestamp rules
   (first token a timestamp ≤ 1 s, pairs, monotonic, timestamps win when their total probability beats every text
   token), **greedy decoding by default** since spec 16 (Accuracy *Standard*; *Best* = beam search with 5 beams,
   batched, one decoder call per step), conditioning on
   the previous text (`<|startofprev|>`), **temperature fallback** 0 → 0.2 … 1.0 (compression ratio > 2.4 or mean
   log-probability < −1; no-speech > 0.6 skips the window); when every temperature fails, the most likely non-looping
   result is kept (OpenAI keeps the temperature-1.0 sample, which turned German → English translation into noise in
   our test), plus FilmCraft's repetition guard.
5. **Language**: detected on the first window over the language tokens (probability reported), or given. English-only
   models (vocabulary < 51865) take a bare `<|startoftranscript|>` prompt; they refuse translation or other
   languages at submit time (`INVALID_SPEC`).
6. **Word timestamps** (`core/align.ts`): the window's text runs again with `<|notimestamps|>`; the cross-attention of
   the model's alignment heads (`generation_config.json`) is renormalised over the window's frames, standardised,
   median-filtered (7) and aligned by DTW (FilmCraft/OpenAI). OpenAI's `add_word_timestamps` heuristics follow: word
   split (per character group for zh/ja/th/lo/my/yue), punctuation merging, median-duration capping at sentence ends,
   first-word-after-a-pause capping, segment-boundary corrections. Confidence = mean token probability.
7. **Word bounds against the audio** (`core/vad.ts`):
   - *splitAtPauses* (ours): a word containing ≥ 200 ms of silence keeps the side with more voice and hands the other
     to its neighbour; a word lying entirely in silence moves onto the nearest voiced run no word covers.
   - *extendWordsIntoSpeech* (ours): bounds grow ≤ 250 ms into voiced frames bordering a pause, never into a
     neighbour (attention ends the last word before a pause early and starts the first after it late).
   - *tightenWords* (FilmCraft port): bounds move inward past frames below the threshold 30 % of the way from the
     noise floor (10th percentile of frames above −100 dBFS) to the speech level (95th), at least 6 dB above the
     floor; a word keeps ≥ 60 ms.
8. **Speakers** (`core/diarize.ts`, FilmCraft port): chunks at 250 ms pauses (0.7–4 s), MFCC 1–19 mean and standard
   deviation over voiced frames, scaled by the file's spread, average-linkage clustering (RMS distance, threshold 0.4,
   at most `maxSpeakers` = 6), small clusters folded into the nearest — plus an **exact speaker-count hint** and folding
   of clusters with < 1.5 s of voiced speech (single readers were split into 2–3 speakers by a stressed word).
   Speakers become keys `S1`, `S2`… named "Speaker 1"… (renamable with the captions workstream's
   `transcript.renameSpeaker`).

## 4. Jobs, results, commands

- `POST /api/media/:key/transcribe` and `POST /api/speech/transcribe-sequence` (`?wait=1` waits) submit
  `transcription` jobs (Jobs panel group "Media analysis", progress and stage from the worker, cancellation kills the
  child process). Result (`TranscriptionResult`): words in **flicks** (media time, or sequence time for a mix),
  confidence, speaker key, language and its probability, task, model, duration, segments, timings.
- **Sequence mix**: the export planner and the audio-mix workstream's offline mixer (`renderMixdown`, mono) render the
  sequence (or its In/Out); the result carries `mixFingerprint` of the document that was sent. The client distributes
  the words to the media of the clips they are heard through (`distributeSequenceWords`: audio tracks top first, first
  enabled non-reversed clip covering the word's midpoint — the captions workstream's `sequenceWords` rule — mapped
  through offset and speed) with the media ranges the sequence plays (`coverage`); words heard through no clip are
  dropped and counted. A result whose fingerprint no longer matches (the sequence was edited meanwhile) is refused
  with "transcribe it again", never misplaced.
- **`transcript.attach`** (new, `packages/project/src/commands/handlers/speech.ts`; label "Generate Transcript"): sets
  the media's transcript in one undoable step. `mode: replace` (default) keeps the transcript id (references stay
  valid) and drops older duplicates nobody references; `merge` replaces only the words inside `coverage` (re-running a
  mix keeps the words of parts the sequence does not play) and unions the coverage; `keep` does nothing when one
  exists. `transcriptAttachPlan` (pure, `packages/project/src/speech`) builds the commands for web and MCP alike.
- **Schema** (all optional, no version bump): `Transcript.model`, `task`, `sourceLanguage` (translations store
  `language: 'en'`), `createdAt`, `coverage` (sorted disjoint flick ranges; absent = the whole media). INV-012 checks
  coverage; `repairDocument` sorts/merges it.

## 5. UI

- **Generate Transcript…** (Premiere's Text ▸ Transcript ▸ *Transcribe* / "Create transcription"): Text panel ▸
  Transcript (toolbar button and the empty state), Sequence ▸ Captions ▸ Generate Transcript…, Clip ▸ Generate
  Transcript… (selected clips' media), the timeline clip context menu, the Project panel context menu (Generate
  Transcript… / Generate Transcript Again…). UI commands `transcript.generate`, `transcript.generateForClips`,
  `transcript.generateForMedia`, `speech.preferences` (agent-exposed, gated by the `transcription` capability; no
  default shortcuts, as in Premiere).
- **Dialog**: Model (size, "download" when missing — the panel then shows the size, description, licence, source,
  pinned revision and an *Accept Licence and Download* button with progress), Language (Detect automatically + 99),
  Translate to English, Speaker labels ("No, don't separate speakers" / "Yes, separate speakers", Number of speakers
  Automatic/2–10), for sequences Audio analysis (Clip media / Sequence mix, "Transcribe only from In to Out"), and
  replace / re-transcribe. Options are remembered.
- **Watcher** (`apps/web/src/speech/jobs.ts`): follows the jobs at module level, commits one "Generate Transcript"
  transaction per job, toasts the summary (words, language, speakers) or the failure with Retry; the Text panel shows
  "Transcribing … %" lines for the sequence's media.
- **Edit ▸ Preferences ▸ Transcription**: the models (size, languages, default, licence, source, revision; Download
  after a confirmation that repeats size and licence; Delete) and *Transcribe on import* (model, language): media with
  sound added by the user are transcribed in the background when the model is downloaded (not on undo/redo or agent
  edits).

## 6. MCP (`apps/mcp/src/tools/speech.ts`)

`list_speech_models`, `install_speech_model`, `remove_speech_model`, `transcribe` (mediaId / clipId / sequenceId with
mode media|mix, inOutOnly, language, translate, speakerLabels, speakerCount, beamSize, replace; wait + commit, or
`wait: false` → `jobIds` commit later), `get_transcript` (a media's transcript in media time, or a sequence's as heard
through its clips with frames and timecode). Guide text `SPEECH_GUIDE`; README tool list.

## 7. Verified behaviour (measured here, 12-core shared Linux box, CPU only)

The measurements below are historical workstream results; current automated coverage is listed separately.

Fixture `fixtures/speech/lj-composite.flac` (public domain, LJ Speech; 12 sentences, 156 words, 71.6 s = 3 windows) with
measured sentence onsets/offsets; a 293 s / 644-word set of 40 LJ Speech sentences built by the same script for the
comparison (not committed). Commands: `apps/engine/test/speech-model.e2e.test.ts` (Vitest) and the evaluation scripts
described there; boundary error = |first word start − sentence onset| and |last word end − offset| over all sentences.

| Model | Ours: WER 71 s / 293 s | FilmCraft: WER 71 s / 293 s | Ours: boundary error mean / max (71 s) | FilmCraft: mean / max |
|---|---|---|---|---|
| tiny | 5.8 % / 4.1 % | 6.4 % / 4.9 % | 18 ms / 40 ms | 438 ms / 1400 ms |
| base | 3.8 % / 4.1 % | 3.2 % / 4.3 % | 33 ms / 260 ms (293 s: 28 ms / 260 ms) | 111 ms / 1210 ms (293 s: 135 ms / 1490 ms) |
| tiny.en | 1.9 % | — (no English-only models) | 18 ms / 40 ms | — |
| base.en | 3.2 % | — | 65 ms / 310 ms | — |
| small.en | 3.2 % | — | 38 ms / 240 ms | — |

Over both sets (800 words) tiny makes 36 errors vs FilmCraft's 42 and base 33 vs 33; words outside the speech
(±150 ms): 0 for ours, 9 (tiny) / 2 (base) of 158 for FilmCraft. FilmCraft was built from `/tmp/refrepos/filmcraft`
(`--features whisper`, its `transcribe` example) with its pinned safetensors models. Speed (loaded machine): tiny.en
72 s in ~6–11 s, base 17 s, small.en 40 s.

Also checked by hand: German LibriVox reading (Multilingual LibriSpeech) — language `de` detected (p 0.98), German
text correct but for rare words, translation to English sensible; a 103 s dialogue of LJ Speech (female) and
LibriSpeech speaker 6930 (male) alternating 10 turns — 2 speakers, every word of every turn labelled correctly; a
single German reader — 1 speaker.

Current automated coverage:

- `apps/engine/test/speech-core.test.ts` (19): Slaney filterbank values and tone location; the 400-point Whisper
  FFT against a direct DFT; VAD threshold rules, extension, pause repair, orphan words and endOfVoice; synthetic
  speaker separation and speaker-count hint; alignment on a synthetic attention map; OpenAI word timing and
  punctuation merging; tokenizer bytes and special tokens; timestamp rules; segment parsing; seeded sampling;
  repetition guard and compression ratio.
- `apps/engine/test/speech.test.ts` (7): catalogue listing, multi-file install via `model-download`, checksum
  failure without leftovers, delete, refusals (409 not installed, 404 unknown, 422 English-only + translate), a model
  that cannot load fails the job with the worker's message, licences, capability.
- `apps/engine/test/speech-model.e2e.test.ts` (5, **real models**; runs when the models are in
  `JASPER_SPEECH_MODELS_DIR` or `target/speech-models`, or with `SPEECH_E2E=1`, which downloads them): media
  transcription WER ≤ 4 % (tiny.en, historically measured 1.9 %), boundary mean ≤ 60 ms / max ≤ 250 ms
  (historically measured 18 / 40 ms), no word outside the speech; language detection + single speaker with tiny;
  a trimmed, offset sequence mix returns words in sequence time (WER ≤ 8 %, onset error < 150 ms against the
  measured source times shifted by the clip placement); cancellation reaches the cancelled job state. WER is
  scored against the separately authored fixture transcript by `apps/engine/test/speech-wer.ts`.
- `packages/project/test/speech.test.ts` (6) owns transcript storage and sequence-to-media distribution:
  `transcript.attach` create/replace(id kept)/merge/keep/refusals and undo; mix words mapped through clip offset
  and 2× speed, dropped words outside clips, played-media coverage and `sequenceWords` readback; merge property
  test (fast-check); coverage invariant and repair.
- `apps/web/test/speech.test.tsx` (6): dialog request (language, translate, speakers), licence + in-dialog download,
  English-only options, watcher commit + undo, mix-result attachment and refusal after an edit, transcribe on import.
- `apps/mcp/test/speech.test.ts` (4): transcribe media / sequence (skip transcribed) / wait:false + jobIds / mix,
  transcript commit and readback, sequence-to-media attachment with dropped words, refusals with hints.
- `e2e/captions.spec.ts` (Playwright, built app) covers the transcript editing workflow with an imported transcript:
  seek, search, Mark In/Out, Remove Fillers and Create Captions, with persisted caption text and timing checks.
  The suite writes `test-results/e2e-captions/final.png`; real speech inference is owned by the engine model suite.

## 8. Compared with FilmCraft — equal or better

| Area | FilmCraft | JasperEditor |
|---|---|---|
| Runtime | candle (Rust), safetensors | ONNX Runtime (already shipped), same algorithms in TypeScript |
| Models | tiny, base, small (multilingual) | + tiny.en, base.en, small.en; download as a job with progress, delete, licence shown in dialog and preferences |
| Decoding | greedy, repetition guard | beam search 5, temperature fallback with best-result keeping, previous-text conditioning, repetition guard |
| Word timing | DTW + VAD tightening | DTW + OpenAI duration heuristics + voice-aware seek + pause repair + growth into voice + VAD tightening: 18–33 ms mean boundary error vs 111–438 ms |
| Accuracy | see §7 | tiny better on both sets; base equal over 800 words |
| Speakers | MFCC clustering, max speakers | same + exact count hint + minimum speaking time |
| Translation | no | translate to English |
| Long audio / progress | synchronous command, no progress | background job, progress, cancellation, retry |
| Sequence | derived transcript only | derived (captions workstream) + transcription of the sequence mix mapped back to media |
| Auto-transcribe on import | no | yes (preference) |

## 9. Adobe fidelity (research, not measurement)

helpx.adobe.com refuses automated fetching here (HTTP 403, as the captions workstream found). Sources used: University
of Texas wiki "Adobe Premiere Pro – How to Auto Transcribe and Caption" (cloud.wikis.utexas.edu): Window ▸ Text ▸
Transcribe; options language, "Yes, Separate Speakers", "Mix" for the audio; Joseph Nilo, "Premiere Pro transcription:
the ultimate guide" (josephnilo.com): Text panel ▸ Transcript tab, source transcripts vs sequence transcripts,
automatic transcription and language in the transcription preferences; Adobe community threads
"transcribe clip speaker labelling selection is required to enable transcription" and "how can i transcribe only a
selected clip…" (community.adobe.com): speaker-labelling choice in the dialog, transcribing clips vs sequences;
Streaming Media "Tutorial: Speech to Text in Adobe Premiere Pro": Create transcription options (Audio analysis Mix /
Audio on track, Transcribe only from In to Out, merge with an existing transcript).

Matched: dialog fields and labels ("Yes, separate speakers" / "No, don't separate speakers", "Transcribe only from
In to Out", Audio analysis), Text panel entry point, clip (source) transcripts reused by sequences, auto-transcribe
preference, speakers named "Speaker 1…", Premiere has no default shortcuts for transcription.
Differences (decided):
- Audio analysis offers *Clip media* (a transcript per media — what Premiere's source transcripts are) and *Sequence
  mix*; Premiere's "Audio on track N" is not offered: clip-media mode transcribes each track's clips individually,
  which covers its purpose without a mix per track.
- Premiere downloads language packs; Whisper models are multilingual, so the choice is a model (size/speed) instead.
- Re-running a mix *merges* inside the played ranges (Premiere: "merge the output with the existing transcript").
- Where Premiere's behaviour is undocumented (minimum speaker duration, fallback), the most plausible behaviour was
  chosen and is described above.

## 10. Limits

- GPU paths (WebGPU, CUDA, the decoder calibration, device-resident decoding) are implemented and tested with a fake
  ONNX Runtime binding only: the build VM has no GPU (its WebGPU probe answers "Failed to get a WebGPU adapter: No
  supported adapters" — no Vulkan driver), so CPU-vs-GPU text parity was **not run** (SG-040; skipped, not passed).
  Verified on Linux x64 only; macOS/Windows use the same `onnxruntime-node` package and code but were not run here.
- Windows: DirectML is not used (licence, §11.2); the DirectX shader compiler DLLs are left out of the desktop
  package, so WebGPU's D3D12 backend must compile with the system's FXC — untested on Windows (the probe falls
  back to the CPU when WebGPU cannot start).
- fp16 models run on the CPU too, 2–4× slower (research); they are recommended only for CUDA with ≥ 6 GB.
- Diarization is classical (no model): overlapping speech, similar voices or music beds confuse it; speakers who say
  less than 1.5 s in total merge into a neighbour. With speaker labels on, the samples are kept in a scratch file and
  read back for the MFCCs (4 bytes per sample: ≈ 230 MB per hour of audio) — recognition itself is memory-bounded.
- A sequence-mix transcript covers only what the sequence plays (coverage) and drops words heard through nested
  sequences or non-audio clips (counted in the result); its word bounds use the energy VAD (no per-mix voice analysis).
- Word timing of translations aligns English words to foreign speech (as OpenAI); it is approximate.
- The known-phrase filter only removes phrases over frames the voice analysis (or, without it, the energy VAD)
  calls non-speech; an outro over music is kept when no voice analysis exists.

## 11. Spec 16: speech on the GPU, model catalogue, robustness

Spec: [docs/specs/16-speech-gpu-models.md](../specs/16-speech-gpu-models.md). Research behind it: the private
whisper evaluation (53 configurations; the numbers of spec 16 §0). This section records what was built and measured.

### 11.1 Execution providers (SG-001…SG-005, SG-008)

- **One probe** (`apps/engine/src/tools/ort.ts` `probeOrtProviders`): a session of the tiny test model
  (`processing/proc/tiny-onnx.ts`) is created with exactly one provider and run once; failures become the reason. It
  runs in the worker (`jasper-speech probe`), killed after 60 s, so a GPU driver crash or hang never touches the
  engine — the engine process no longer loads ONNX Runtime at all (the processing capabilities used to). The upscaler
  (jasper-proc `--version`, capabilities and local jobs) reads the same probe (SG-008); a downloaded CUDA provider is
  used by local upscales too.
- **Order** (`speech/providers.ts`): macOS WebGPU → CPU; Linux x64 CUDA → WebGPU → CPU; Windows WebGPU → CPU. Core ML
  is listed as unavailable ("recompiles at every load", research: 410–844 s; re-evaluate on ORT upgrades), DirectML
  as unavailable (licence, §11.2).
- **Cache**: `<appdir>/engine/speech.json` (zod-validated, atomic writes) keyed by ORT version, platform, arch, CUDA
  provider state and the NVIDIA setting; probed at the first speech use (model list, transcription), again on
  *Check the GPUs again* / `POST /api/speech/probe` (which also clears the decoder calibrations).
- **Per session** (`planDevices`): encoder on the best GPU provider; decoder on the CPU, except — greedy only — a
  GPU decoder that the calibration of that model measured ≥ 10 % faster per token. The calibration runs on the first
  window of the first greedy job of a model on a GPU (24 steps of each decoder, median of the last 20; ≈ 0.2–1 s) and
  is stored. Extension of the spec (decision): WebGPU decoders are calibrated as well (the spec names CUDA only);
  research measured them slower on the M4 Max (turbo 10.6 vs 7.5 ms/token), so there the calibration keeps the CPU.
- **Device-resident decoding (SG-004)**: a WebGPU decoder keeps its key/value cache on the GPU
  (`preferredOutputLocation: 'gpu-buffer'`); because onnxruntime-node 1.30.0 keeps such outputs bound, cached steps
  run on a second session and uncached passes (language detection, alignment) on the CPU decoder; replaced cache
  tensors are disposed. Beam search refuses a device-resident decoder (rows are gathered on the CPU).
- **Cached steps without the encoder output**: the merged decoder's cache branch ignores `encoder_hidden_states`, so
  cached steps pass a [B, 1, d_model] placeholder instead of the 1500-frame output. Measured on the build VM (turbo,
  LJ fixture, greedy, 8 threads, not under the bench lock): identical words and times for tiny and turbo, decoder time
  3.31 s vs 3.67 s for 189 runs; on a GPU decoder it saves a 7.7 MB host→device copy per step.
- **Fallbacks (SG-003)**: a session that cannot be created on the GPU is created on the CPU (`stage: session`, with the
  reason); a GPU error during recognition runs the job once more on the CPU inside the worker, and a worker that dies
  on the GPU (signal, crash) is run again on the CPU by the engine (`stage: job`); when the CPU run fails too, the job
  fails with the original error. Processor *GPU* without a usable GPU runs on the CPU with `stage: unavailable` and the
  probe's reasons. The result's `device` (`label`, providers, threads, fallbacks) shows in the Jobs panel ("Ran on: …
  (fell back: …)"), the job log and MCP.
- **Threads (SG-005)**: performance cores (macOS `hw.perflevel0.physicalcpu`, Linux hybrid `cpu_core/cpus`, else the
  logical CPUs), at most 8; the job asks for that many CPU slots.

### 11.2 Packaging and licences (SG-006, SG-007)

- **CUDA on Linux x64**: *Enable NVIDIA GPU* downloads `Microsoft.ML.OnnxRuntime.Gpu.Linux` 1.30.0 from NuGet (MIT;
  236,037,232 bytes, sha256 `77ca2368…a3d6`, the version onnxruntime-node's own install script pins) with the
  resumable downloader, extracts `libonnxruntime_providers_cuda.so` and `libonnxruntime_providers_shared.so` (and the
  package's LICENSE / ThirdPartyNotices) next to a copy of the installed onnxruntime-node package in
  `<appdir>/runtimes/onnxruntime-cuda/1.30.0/` (ONNX Runtime loads providers from its own library's directory), writes
  `install.json` atomically and deletes the package. Workers then load ONNX Runtime from there (`JASPER_ORT_DIR`) with
  `LD_LIBRARY_PATH` set to the directories where the NVIDIA libraries were found. Nothing is bundled or committed; pnpm
  settings are unchanged. Help ▸ About ▸ Licenses lists the provider when installed.
- **NVIDIA runtime detection** (`speech/cuda.ts`): `libcuda.so.1`, `libcudart.so.13`, `libcublas.so.13`,
  `libcublasLt.so.13`, `libcurand.so.10` (the provider's `readelf -d` NEEDED list) and `libcudnn.so.9` (loaded at run
  time), searched in `LD_LIBRARY_PATH`, `ldconfig -p`, `/usr/local/cuda*/…`, `/usr/lib/x86_64-linux-gnu`, `/usr/lib64`,
  WSL; driver ≥ 580 and the GPU from `nvidia-smi`. Missing pieces are listed with install guidance (Preferences, the
  probe reason). Not shipped: proprietary NVIDIA licences (AGENTS §2.5).
- **DirectML (SG-007)**: `DirectML.dll` in onnxruntime-node is the Microsoft.AI.DirectML redistributable under the
  "Microsoft Software License Terms — DirectML" (proprietary; redistribution only inside applications, no
  modification; source: nuget.org Microsoft.AI.DirectML 1.15.4 licence page) — outside the licence allowlist, so
  Windows uses WebGPU → CPU and the desktop package leaves `DirectML.dll` out. `dxcompiler.dll` (DirectX Shader
  Compiler, University of Illinois/NCSA) and `dxil.dll` (its validator; licence not established from the sources we
  could read) are left out too (`apps/desktop/scripts/package.mjs`, AGENTS §3.6). Assumption (unverified, no Windows
  machine): Dawn falls back to FXC without them. Nothing new is shipped, so `THIRD_PARTY_NOTICES.md` gains no entry.

### 11.3 Decoding and hallucination guards (SG-010…SG-012, spec 14 TC-003/TC-004)

- Default greedy with temperature fallback (OpenAI thresholds: compression 2.4, log-probability −1, no-speech 0.6);
  *Best (slower)* = beam 5 (Preferences, the dialog, `accuracy` in the API and MCP; `beamSize` still overrides).
- Guards, in order: a window with fewer than 3 voiced 10 ms frames is not decoded (`guard.skippedWindows`); the
  previous text is not carried over ≥ 2 s of silence before a window's first voice; runs of ≥ 4 identical text
  tokens are removed; OpenAI's `hallucination_silence_threshold` (2 s) heuristic drops anomalous segments surrounded by
  silence and resumes at them (port record `licenses/ported/speech-openai-whisper.md`); `splitAtPauses` snaps a word
  found in silence onto voice only when it is closer than a pause (200 ms) — it never moves a word across a silence
  (the measured failure: "Gracias por ver el vídeo" moved onto speech) — and the others are dropped; words with
  < 20 % speech/breath frames are dropped; known phrases (Spanish "Subtítulos realizados por la comunidad de
  Amara.org", "Gracias por ver el video/vídeo", "Gracias.", English "Thanks for watching!"…, `core/hallucination.ts`)
  are removed when they form a sentence of their own over < 50 % speech frames. The result lists what was removed.
- Verbatim prompts (TC-003): `verbatim` puts the language's filler prompt (Spanish `Eh... em, bueno, o sea, este...
  mmm, ¿vale? Ah, eh, pues...`, English `Um, uh, so, like, you know... hmm, okay? Ah, er, well...` — the English one is
  our assumption) and `initialPrompt` at the start of the running text, OpenAI semantics: it conditions the first
  window and the following ones through the previous text until a prompt reset. Encoding is byte-level BPE from the
  model's `tokenizer.json` (`core/tokenizer.ts encode`, round-trip tested on the real tokenizer). Observed: carrying
  the prompt into every window (our first version) derailed tiny.en into "Oh, oh, oh…" loops, hence OpenAI's
  semantics. `conditionOnPreviousText: false` is the OpenAI option.
- Segment scores (TC-003): `avgLogprob`, `noSpeechProb`, `compressionRatio` (and `temperature`) per segment in the
  result; stored as `Transcript.segments` (media-time flicks, project-files.md v9 table), merged inside a mix's coverage.
- Word bounds against speech frames (TC-004): bounds snap (split at pauses, grow ≤ 250 ms into voice, tighten) to the
  energy VAD; when the media's voice analysis (`voice-analysis` job, spec 14 TC-001) exists by the end of
  recognition — the engine starts it next to the transcription — its speech/breath frames decide which words lie in
  silence and which known phrases are over non-speech (`guard.frames: "voice-analysis"`). Decision from a
  measurement (LJ fixture, tiny.en, build VM): snapping to the voice analysis' speech class moved the end of
  "unchecked." 0.28 s early (boundary error max 280 ms vs 40 ms with the energy VAD) and split the single reader into
  2 speakers; with energy snapping and voice-analysis presence: max 40 ms, 1 speaker, WER unchanged.

### 11.4 Catalogue, recommendation, downloads (SG-020…SG-023)

- `whisper-large-v3-turbo`: `onnx-community/whisper-large-v3-turbo_timestamped` @ `b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a`,
  six files (3.24 GB incl. `encoder_model.onnx_data` 2.55 GB), MIT upstream (the card has no licence field);
  `whisper-large-v3-turbo-fp16`: the fp16 encoder/decoder of the same revision (1.62 GB), `gpuOnly`. Per-file sha256
  from the research manifest (LFS ids) and, for the JSON files, hashed from the downloaded files of that revision.
  No medium, no int8/q8 exports (research: broken or slower). fp16 tensors are converted at the session boundary
  (`worker/sessions.ts`).
- Validation (SG-023): `validateSpeechCatalog` (zod, strict) refuses entries with bad ids, hashes, sizes, file names
  (no paths), duplicate files or ids, or without config/encoder/decoder; the others load; refusals show in the
  capability reason (Preferences) — fuzzed with fast-check.
- Recommendation (SG-021, `recommendModel`): a usable GPU → turbo (fp16 only with CUDA and ≥ 6 GB VRAM — deviation:
  the spec also lists WebGPU, but with WebGPU the decoder stays on the CPU where fp16 is 2–4× slower); CPU only with
  ≥ 16 GB (≥ 15.5 GiB reported) and ≥ 8 cores → turbo fp32; else small. The engine default follows it.
- Downloads (SG-022, `tools/download.ts`, shared by the speech, vision and Describe-it stores and the CUDA provider):
  `.partial` files resumed with HTTP Range after a transient error (network, 408/425/429/5xx) with exponential
  backoff (1 s, 2 s, … 5 retries), a server that ignores Range restarts the file (the only restart), the sha256 covers
  the whole file, cancellation keeps the partial file for the next attempt, a checksum mismatch deletes it,
  `install.json` written atomically. Tested against a server that drops connections mid-body.

### 11.5 Streaming and JS hot spots (SG-013, SG-014)

- Audio streams from ffmpeg into the log-mel front end (`LogMelStream`, equal to the batch spectrogram — property
  test), the 10 ms levels and, with speaker labels, a scratch file. The raw spectrogram stays in memory up to 64 MB
  (≈ 21 min of 128-band frames) and then moves to a scratch file; windows are read back 1.5 MB at a time. No whole-file
  sample array or spectrogram is held for recognition.
- Hot spots: the timestamp rule compares log Σ exp over timestamps with the best text logit (no full log-softmax per
  step); the chosen token's log-probability from one log-sum-exp; beam top-k in one pass (`topK`); the FFT with
  precomputed per-level twiddles and no allocation per frame/call; `fill` instead of loops in the filters; identity
  beam gathers not copied. Each is tested equal to the previous implementation (property tests).

### 11.6 UI and MCP (SG-030…SG-032)

- Preferences ▸ Transcription: Processor (Automatic / CPU / GPU, with the GPU reasons), Accuracy (Standard / Best),
  *Check the GPUs again*, the providers with reasons, NVIDIA GPU (CUDA) on Linux (Enable NVIDIA GPU: licence +
  size confirmation, download progress, provider and runtime status, guidance, Remove — the engine asks the user to
  approve removals requested by agents), and per model "Runs on: <device> · N threads", "≈ x min per 10 min of audio
  (estimated)" / "(measured, last run)" and *Recommended for this computer*.
- Generate Transcript dialog: Accuracy, *Keep filler words (verbatim)*, the Runs-on/speed line.
- Jobs panel: "Ran on: … (fell back: …)" for transcriptions.
- MCP: `list_speech_models` (recommended, runsOn, speed), `transcribe {device, accuracy, verbatim, initialPrompt,
  conditionOnPreviousText}` (results carry device, accuracy, guard), `engine_status` (`speech`: providers, chosen,
  threads, recommended model, CUDA state). English + Spanish strings.

### 11.7 Measurements (SG-041)


Research numbers (before this work, spec 16 §0 — M4 Max, build VM, RTX 3060): turbo is the most accurate (Spanish
voice-over WER 3.4 % vs small 6.8 %), RTF 0.256 on the M4 Max CPU, 0.215 with the WebGPU encoder, 0.155 on the RTX
3060 with CUDA + greedy. Post-implementation reruns, all **measured** on the build VM (16 shared EPYC-Rome vCPU,
30 GB, Node 24.22.1, onnxruntime-node 1.30.0, CPU only — no GPU), the LJ fixture (71.6 s, English, language given),
8 threads, with the VM bench lock held; the VM was shared with other agents' test suites, so the load average is
given per run. Rerunnable: the private harness (`research/whisper/harness/bench.ts`, copied with paths to the two
checkouts) and `pnpm exec vitest run apps/engine/test/speech-model.e2e.test.ts` with
`JASPER_SPEECH_MODELS_DIR` / `JASPER_SPEECH_TURBO_DIR`.

| Run (load average) | Config | RTF before (85e1bc76) | RTF after | JS ms per decoder run before → after |
|---|---|---|---|---|
| round 1 (2.0 → 7.3) | tiny greedy | 0.046 | 0.045 | 6.96 → 5.87 |
| | tiny beam 5 | 0.096 | 0.090 | 19.27 → 13.11 |
| | turbo greedy | 0.238 | 0.241 | 8.26 → 6.66 |
| | turbo beam 5 | 0.317 | 0.328 | 25.58 → 17.09 |
| round 2 (11.6 → 12.1) | tiny greedy / beam 5 | 0.051 / 0.122 | 0.043 / 0.105 | 7.50 → 5.86 / 21.98 → 13.24 |
| | turbo greedy / beam 5 | 0.280 / 0.349 | 0.251 / 0.344 | 9.38 → 6.94 / 28.16 → 17.13 |

"JS per decoder run" = recognition time minus ONNX Runtime run time, divided by the decoder runs: it also contains
the log-mel front end, alignment (DTW), word timing and refinement, which do not scale with tokens. The per-token hot
spots alone (`micro.mts`: the same random 51,866-token logits through the old and the new functions, single thread,
interleaved, load ≈ 20): greedy step 1.39–1.59 → 0.52 ms (**2.7–3.0×**), beam-5 step (5 rows: filters,
normalisation, top-6) 8.36–8.38 → 3.06–3.36 ms (**2.5–2.7×**), log-mel of 30 s + 30 s padding (128 bands)
430–467 → 294–312 ms (1.45×) — SG-013's ≥ 2× per token is met for the per-token work; end to end the JS share falls
by 1.2–1.5×, and recognition time is dominated by ONNX Runtime (turbo's encoder: 12 s of 17 s). Greedy is now the
default: turbo 0.24 vs 0.32 RTF for beam 5 on this machine.

| Check (engine job, `speech-model.e2e.test.ts`) | Result |
|---|---|
| tiny.en greedy | WER 1.92 %, boundary error mean 18 ms / max 40 ms, no word outside the speech (historical beam 5: 1.9 %, 18 / 40 ms) |
| tiny (auto) + speaker labels | en p 0.999, WER 8.33 %, 1 speaker |
| sequence mix (trimmed, offset) | WER 6.15 % |
| silence gap (30 s of digital silence inserted at a pause) | 0 words in the gap; WER 5.56 % before it, 2.50 % after it |
| tiny.en without previous text | WER 1.92 % |
| turbo greedy / beam 5 / verbatim | WER 1.92 % / 1.92 % / 2.56 %; RTF 0.307 / 0.374 / 1.01 (4 threads, job slots; the verbatim prompt triggered temperature fallbacks on this English fixture) |

Memory (SG-014), one hour (LJ fixture × 50 = 59.7 min WAV), tiny greedy, 8 threads, `/usr/bin/time -v` of the
worker: before 1.81 GB peak RSS, 3 min 56 s; after **1.25 GB**, 2 min 40 s (the 71.6 s clip alone peaks at ≈ 1.1 GB
— model and runtime); 7,900 vs 7,882 words (the guard dropped 18 words lying in silence between the repeated clips).

CUDA delivery on the build VM (Linux x64, no NVIDIA driver; `SPEECH_CUDA_PACKAGE=… vitest run
apps/engine/test/speech-cuda.e2e.test.ts`): the pinned 236 MB package downloaded through a server that dropped the
first transfer at 20 MB, resumed with a Range request, verified, extracted and installed in 6.4 s (local server);
the worker loaded ONNX Runtime 1.30.0 from the app-directory copy; CUDA was reported unavailable ("Failed to load
shared library") with the missing NVIDIA libraries listed. **Not verified on real NVIDIA hardware** in this
workstream; WebGPU not verified either (no adapter on the VM). CPU-vs-GPU text parity: skipped (no GPU).

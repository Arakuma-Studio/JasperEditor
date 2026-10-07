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
tests). Six models: `whisper-tiny`, `whisper-tiny.en`, `whisper-base` (default), `whisper-base.en`, `whisper-small`,
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
   token), **beam search with 5 beams** (batched, one decoder call per step; `beamSize` 1 = greedy), conditioning on
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

Tests:
- `apps/engine/test/speech-core.test.ts` (22): FilmCraft's mel, VAD, diarization, DTW/median, repetition-guard and WER
  tests; FFT = DFT; threshold rules; extension, pause repair, orphan words, endOfVoice; speaker-count hint; alignment
  on a synthetic attention map; OpenAI word timing and punctuation merging; timestamp rules; segment parsing; seeded
  sampling; compression ratio.
- `apps/engine/test/speech.test.ts` (7): catalogue listing, multi-file install via `model-download`, checksum
  failure without leftovers, delete, refusals (409 not installed, 404 unknown, 422 English-only + translate), a model
  that cannot load fails the job with the worker's message, licences, capability.
- `apps/engine/test/speech-model.e2e.test.ts` (5, **real models**; runs when the models are in
  `target/speech-models` or with `SPEECH_E2E=1`, which downloads them): media transcription WER ≤ 4 % (tiny.en,
  measured 1.9 %), boundary mean ≤ 60 ms / max ≤ 250 ms (measured 18 / 40 ms), no word outside the speech; language
  detection + single speaker with tiny; a sequence mix of a trimmed, offset clip mapped back into media time with
  coverage; cancellation kills the job.
- `packages/project/test/speech.test.ts` (6): `transcript.attach` create/replace(id kept)/merge/keep/refusals, undo;
  mix words through offset + 2× speed read back by `sequenceWords`; merge property test (fast-check); coverage
  invariant and repair.
- `apps/web/test/speech.test.tsx` (8): dialog request (language, translate, speakers), licence + in-dialog download,
  English-only options, watcher commit + undo, mix distribution and refusal after an edit, Preferences, commands and
  menus, transcribe on import.
- `apps/mcp/test/speech.test.ts` (5): models, transcribe media / sequence (skip transcribed) / wait:false + jobIds /
  mix, refusals with hints, get_transcript.
- `e2e/speech.spec.ts` (Playwright, built app, real model): Sequence ▸ Captions ▸ Transcript → Generate Transcript…
  → Whisper job → words in the Text panel (screenshots `test-results/e2e-speech/`), with `SPEECH_E2E_DOWNLOAD=1` the
  model downloads through the dialog; undo/redo; Project panel menu; Preferences ▸ Transcription.

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

- CPU only (ONNX Runtime CPU provider); no GPU path. Verified on Linux x64 only; macOS/Windows use the same
  `onnxruntime-node` package and code but were not run here.
- Models are fp32; `small` is about 3× slower than `base` (measured 40 s for 72 s of audio on this loaded machine).
- Diarization is classical (no model): overlapping speech, similar voices or music beds confuse it; speakers who say
  less than 1.5 s in total merge into a neighbour.
- A sequence-mix transcript covers only what the sequence plays (coverage) and drops words heard through nested
  sequences or non-audio clips (counted in the result).
- Word timing of translations aligns English words to foreign speech (as OpenAI); it is approximate.

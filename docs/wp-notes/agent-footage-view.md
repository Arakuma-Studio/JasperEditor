# Agent footage editing — media range view (spec 18 §2.3 AF-VIEW)

`view_media_range {projectId, mediaId | sequenceId, start, end, frames? (2…16, default 8), width? (480…1920, default
1280)}` gives an agent one PNG of a media or sequence range plus the same facts as text.

## Behaviour

- **Range.** `start` / `end` are seconds (a number) or `"12.5s"`, `"250ms"`, `"1:02"`, `"1:02:03"`; media mode uses media
  content time (the transcript's timeline), sequence mode uses sequence time. `end` must be after `start`; the range is
  clamped to the media/sequence and must not be empty or longer than 600 s (`RANGE_VIEW_MAX_SECONDS`) after clamping.
  Media with a frame-rate or loop interpretation map their content time to file time (`mediaTimeMap` / `filePieces`)
  for frames and audio.
- **Picture** (`apps/mcp/src/range-view.ts`, pure): header (title, range), filmstrip of `frames` frames sampled at the
  centres of equal slots (each frame fitted into its slot, its time printed on it and ticked on the axis), the RMS
  waveform (mean power of the 10 ms frames per pixel column, drawn on a −60…0 dBFS scale), the words at their start
  times in up to three lanes (words that would overlap at this width are left out of the image but listed in the text),
  shaded bands for silences ≥ 0.4 s with their length, and a time ruler (1/2/5 × 10ᵏ s steps). Text is 2× from 960 px.
  Media without video draw only the audio rows; media without audio have no waveform and no silence bands; a frame that
  cannot be decoded is a marked slot.
- **Text** (`rangeSummary`, AF-VIEW-003): title and range with its timeline, image size, every frame time (with the
  reason when missing), the audio source and levels, the silence bands, and the words with their times (at most 1 000,
  then a count and a pointer to `get_transcript`).
- **Frames.** Media: the engine route `POST /api/media/:mediaKey/frames` (below). Sequence: the existing Program still
  path (`captureStill`, like `render_frame`) at `⌊t · fps⌋` of each slot centre, width = the slot box (≥ 64 px).
- **Audio.** Media: `POST /api/media/:mediaKey/range-audio` (the media's cached voice analysis when there is one, else
  analysed now). Sequence: `POST /api/sequence-range-audio` (only when an enabled audio clip plays in the range). Both
  return 10 ms levels and voice classes; the tool resamples them onto its own 10 ms grid.
- **Words.** Media: `transcriptForMedia`; sequence: `sequenceWords` (the words heard through the audio clips).
  "no transcript" when there is none.

## Engine routes (`apps/engine/src/routes/range-view.ts`, `apps/engine/src/media/range-view.ts`)

Authenticated like every `/api` route; bodies validated by `@jasper/api` `range-view.ts` schemas (strict); errors in
the engine error shape. All three stop when the client goes away (`clientGoneSignal`).

| Route | Body | Errors |
|---|---|---|
| `POST /api/media/:mediaKey/frames` | `times` (1…16 file seconds), `width` 16…960, `height?` 16…1080 | 404 `ASSET_NOT_FOUND`, 409 `MEDIA_OFFLINE`, 422 `NO_VIDEO`; per frame `NO_FRAME` / `DECODE_FAILED` / `FRAME_TIMEOUT` |
| `POST /api/media/:mediaKey/range-audio` | `start`, `end` (file seconds, ≤ 1 800 s), `streamIndex?` | 404, 409, 422 `NO_AUDIO` / `EMPTY_RANGE`, 400 `RANGE_TOO_LONG`, 504 `AUDIO_TIMEOUT` |
| `POST /api/sequence-range-audio` | `envelope`, `sequenceId`, `startFrame`, `endFrame` (≤ 600 s) | 404 `SEQUENCE_NOT_FOUND`, 422 `EMPTY_RANGE` / `MIX_FAILED`, 400 `RANGE_TOO_LONG`, 504 |

- **Frames**: one FFmpeg process per time, in order, `-protocol_whitelist file,crypto,data` (`LOCAL_PROTOCOLS`), input
  seek, `scale` to fit the box with the display aspect (`iw·sar`, after FFmpeg's automatic rotation; never enlarged;
  `area` filter), `setsar=1`, 8-bit RGB PNG on stdout (≤ 8 MB). FFmpeg's accurate seek returns the first frame starting
  at or after the seek time, so the route seeks to the start of the frame shown at `t` (`⌊t · fps⌋ / fps`, floored to
  the µs; measured: seeking to 10.5/30 s returned frame 11 before this fix, frame 10 after). Times are clamped to the
  media; when nothing decodes (past the last frame) the frame 0.5 s earlier is taken and `at` says so. Stills give their
  picture at every time. Budgets: 30 s per frame, 160 s per request (under the MCP's 180 s per engine request).
- **Range audio**: 16 kHz mono f32 decode of the range plus the 7.5 ms window lead-in and 15 ms tail, reduced while it
  streams by the voice analysis' own `VoiceFeatureExtractor` (`StreamingVoiceFeatures`: any split gives the same bytes)
  and classified with `classifyVoiceFrames` against the range's own levels. With a cached analysis the slice of its
  planes is returned instead (classes against the whole stream). The stdout reader pauses between chunks so the
  analysis yields the event loop. Budget 170 s.
- **Sequence audio**: the export's offline mixer (`renderMixdown`, `audioWorld`: clip effects, strips, Mix; mono; *not*
  the loudness normalisation) renders the range to a scratch WAV (removed afterwards), analysed like a media range from
  time 0.

## Thresholds and sources

| Value | Where | Source |
|---|---|---|
| Silence band ≥ 0.4 s | `SILENCE_MIN_SEC` | spec 18 §0 / §2.3, adapted from browser-use/video-use (MIT; no code ported) — the integrator records it in `licenses/ported/video-use.md` |
| Silence = not speech (silence or breath-like voice classes) | `silenceBands` | the transcript-cleanup pause mask (`packages/project/src/cleanup/plan.ts` treats `classes !== SPEECH` as pause) |
| Speech threshold: 30 % from floor (10th percentile) to speech level (95th), ≥ floor + 6 dB; voiced ≥ 0.45 or ≥ 10 dB over | voice analysis rules | spec 14 TC-001, `@jasper/audio-dsp` `voice.ts` (shared, not duplicated) |
| Waveform scale −60…0 dBFS | `WAVE_FLOOR_DB` | assumption (labelled): the range where speech and room tone are both visible |
| 10 ms frames, level byte dB = −120 + q/2 | `RANGE_AUDIO_*` | voice analysis grid; a test pins the constants to `@jasper/audio-dsp` / `VOICE_CLASSES` |

## Tests run

- `JASPER_FFMPEG_LGPL_ONLY=1 pnpm exec vitest run apps/engine/test/range-view.test.ts --maxWorkers=1` — exact frames read
  back from frame-code.mp4's burned-in code, box fitting / rotation / stills, clamping past the end, validation (count,
  size, negative, NaN, unknown keys), unknown / offline / picture-less media, authentication (401), range audio
  byte-identical to `voiceFeatures` of the same samples with lead-in, cached analysis slice, clamping, no-audio /
  reversed / over-long ranges, cancellation (direct abort, and over a real connection: the decoder process is gone
  within 2 s of the client hanging up — measured 0.3–0.9 s, ≈ 2 s before the reader yielded between chunks — while the
  whole range takes ≈ 12 s), streaming split invariance, sequence mix classes
  (silence before a clip at 1 s, speech in its first tone), clamping, missing sequence, `RANGE_TOO_LONG`.
- `pnpm exec vitest run apps/mcp/test/range-view.test.ts --maxWorkers=1` — slot times, silence bands (incl. breath runs
  and clipping), power-mean RMS, deterministic row layout and pixels at known positions, the rows media without video /
  audio leave out, 1920 px scaling and the strip cap, the summary, `fast-check` hostile input.
- `pnpm exec vitest run apps/mcp/test/footage-view.test.ts --maxWorkers=1` — real engine + jasper-mcp over stdio:
  video+audio with a transcript, video without audio, audio without video, a WAV with a 1 s pause (one band, its edge
  pixel), a sequence range (Program stills, mix, sequence words), and coded errors (both / no ids, reversed, outside,
  bad time, unknown media, still image, unknown sequence, 17 frames, offline media → `MEDIA_OFFLINE`).
- `pnpm --filter @jasper/{api,engine,mcp} typecheck`; `biome check` of the changed files.
- Visual inspection of the tool's real PNGs (clip-a 960 px, box-move 1280 px, tone.wav 480 px, sequence 480 px): frames
  in their slots and in time order (the box moves 1–2 s, then rests), waveform, words, ruler legible.

## Limits

- Frame seeking uses the stream's average rate: in VFR files the frame shown may differ from the editor's by a frame.
- Sequence audio is the mix before loudness normalisation; sequence frames are full Program renders (one still job
  each), so 16 frames of a heavy sequence are slow.
- Range analyses (no cached voice analysis) classify against the range's own levels, so a range that is all pause can
  read its quietest sounds as speech; the cached analysis (`analyze_voice`) uses the whole stream's levels.
- The engine analyses audio on its main thread (yielding between chunks): ≈ 5 s of CPU for 600 s of audio (≈ 12 s for
  1 500 s measured on the shared 4-core build host under load).

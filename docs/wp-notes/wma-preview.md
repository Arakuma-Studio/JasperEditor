# WMA and other browser-undecodable audio in the preview (pp-wma-preview)

## Problem

Registration and export of WMA (and AC-3, ALAC, MP2, AIFF…) worked through the LGPL FFmpeg, but the preview could not
play them: the probe's `BROWSER_AUDIO` regex (`apps/engine/src/media/probe.ts`) left `wmav2` out, audio-only media got
only a `peaks` derivative (`apps/engine/src/derivatives/service.ts`), and the preview's `<Audio>` (`@remotion/media`,
mediabunny + WebCodecs) failed on the original. The user's projects hold 12 WMA clips.

## How the preview plays audio (verified in code)

- Program monitor: `AudioLayer` (`packages/compositions/src/layers/AudioLayer.tsx`) plays each clip with `@remotion/media`
  `<Audio src trimBefore playbackRate>` into the preview mix graph. `@remotion/media` 4.0.499 `MediaPlayer` opens the
  URL with mediabunny `Input(ALL_FORMATS)` and returns `cannot-decode` when `audioTrack.canDecode()` is false
  (`dist/esm/index.mjs`, `_initialize`). Renders never play `AudioLayer` (audio comes from the offline mixer).
- Source monitor: `AssetComposition` plays `<Video>` (with its audio) or `<Audio>`.
- Scrubbing and Detect Peak: `apps/web/src/audio/browser-decode.ts` (mediabunny `AudioBufferSink`).
- `<Video>` defaults `audioStreamIndex` to 0, so a muted `<Video>` of a file whose first audio track cannot be decoded
  fails as a whole (`cannot-decode`) and falls back to `<OffthreadVideo>`.

## Which audio the browser decodes (one table)

`BROWSER_AUDIO_CODECS` in `packages/project/src/audio/browser-codecs.ts`, keyed by mediabunny's demuxer family of the
ffprobe `format_name`; read by the probe (`browserPlayable`), the derivatives (`needsPlaybackAudio`), the preview
(`MediaHandle.playbackAudio`), the export's clip decode (`needsSampleExactDecode`), the timeline badge and MCP.

Sources:
- mediabunny 1.50.8 (pinned in `packages/compositions/package.json`), read in its shipped source: `ALL_FORMATS = [HLS,
  MP4, QTFF, MATROSKA, WEBM, WAVE, OGG, FLAC, MP3, ADTS, MPEG_TS]`; ISOBMFF sample entries `mp4a` (AAC, MP3 via OTI
  0x69/0x6B, Vorbis 0xDD), `opus`, `flac`, `ac-3`, `ec-3`, PCM (`sowt`, `twos`, `lpcm`, `ipcm`, `fpcm`, `in24`, `in32`,
  `fl32`, `fl64`, `raw `, `ulaw`, `alaw`) — no ALAC; Matroska `A_AAC`, `A_MPEG`, `A_OPUS`, `A_VORBIS`, `A_FLAC`,
  `A_AC3`, `A_EAC3`, `A_PCM/INT/LIT|BIG`, `A_PCM/FLOAT/IEEE`; Ogg: Vorbis and Opus only; WAVE: PCM 8/16/24/32-bit,
  IEEE float 32/64, µ-law, A-law, WAVEFORMATEXTENSIBLE and RF64; MPEG-TS stream types 3/4 (MPEG audio), 15 (AAC),
  0x81/0x87 (AC-3/E-AC-3). PCM, µ-law and A-law are decoded by mediabunny itself (`PCM_AUDIO_CODECS`).
- WebCodecs codec registry (W3C, https://www.w3.org/TR/webcodecs-codec-registry/): `flac`, `mp3`, `mp4a.*`, `opus`,
  `vorbis`, `ulaw`, `alaw`, `pcm-*`. Chromium decodes AAC only in builds with proprietary codecs; Electron ships them
  (Electron FAQ / `proprietary_codecs=true`, `ffmpeg_branding="Chrome"`) — documented upstream, not re-verified here.
- AC-3 / E-AC-3: Chromium decodes them only with `enable_platform_ac3_eac3_audio` (platform decoders on macOS, Windows,
  ChromeOS; not on Linux) — `media/media_options.gni`. The engine classifies before any client asks, so they always get
  the playback copy (assumption: a copy is correct everywhere, a platform guess is not).
- Not listed, hence "needs playback audio": WMA v1/v2/Pro/Lossless (ASF), ALAC, MP2 (in MP3/TS files too: no WebCodecs
  codec), AMR, APE, WavPack, TTA, DTS, TrueHD, ADPCM, AIFF / CAF / AU containers, unknown codecs and containers.

## The playback copy: 32-bit float WAV per stream

`playback-audio` derivative: for every audio stream `ffmpeg -i <src> -map 0:<index> -vn -sn -dn -map_metadata -1
-c:a pcm_f32le -rf64 auto -f wav <index>.wav`, header `playback-audio.json` (`PlaybackAudioHeaderSchema`: index, rate,
channels, frames, url), content-addressed under `cache/<fp>/playback-audio-<hash>`, counted as `proxies` by the cache
registry, served by `/media/:key/playback-audio.json` and `/media/:key/playback-audio/:stream.wav` (ranges).

Why this format (compared with the LGPL build's `aac`, `libopus`, `flac`):
- Lossless and identical to the export's reading: the export pipes FFmpeg's decode of the original as `f32le`; the WAV
  holds the same floats, so preview loudness equals export loudness. Measured: bit-identical to `ffmpeg -i <src> -map
  0:a:0 -f f32le` for the WMA and the 5.1 AC-3 fixtures (`apps/engine/test/playback-audio.test.ts`).
- Float keeps decoder overshoots above 0 dBFS (WMA / AC-3 decoders output `fltp`); FLAC is integer (clips them or
  needs a gain), AAC / Opus are lossy, resample (Opus: 48 kHz only) and add encoder delay / priming that the preview
  would have to trim exactly.
- Sample-accurate in the browser at any seek: WAV positions are byte offsets; mediabunny decodes PCM without WebCodecs.
- Same sample rate and channel count as the source stream (clip channel maps keep their meaning).
- Cost: 4 bytes × channels × rate — ≈ 1.4 GB per hour of stereo 48 kHz (estimated from the format), RF64 past 4 GiB.
  It is a cache entry (`proxies`) the cache GC can remove; it is made again when asked for (S04:CA-004).

The job is an ordinary derivative: interactive priority, one CPU slot, progress per stream from FFmpeg's `-progress`,
partial directory removed on failure / cancel, failures kept (`status.error`) until asked again, re-queued after an
engine restart (`ARTIFACT_JOB_KINDS`), `UNSUPPORTED_MEDIA` when FFmpeg decodes no samples.

## Export: original file, sample-exact

Exports still decode the original with FFmpeg (no quality loss), but for streams that get a playback copy the clip
decode (`clipDecodeArgs` `sampleExact`, `apps/engine/src/audio/decode.ts`) reads from the file start and drops
`round(startSec × rate)` samples by count (`atrim=start_sample=N,asetpts=PTS-STARTPTS`) instead of an input `-ss`.

Measured on the VM (FFmpeg n7.1.5 LGPL build, `wmav2` 192 kb/s, 44.1 kHz, a click at exactly 1.000 s in the source):

| decode | click at |
|---|---|
| `-i x.wma` (full decode = the playback copy) | 0.95365 s |
| `-ss 0.5 -i x.wma` (seek), + 0.5 s | 0.98925 s |
| `aresample=first_pts=0` (timestamps) | 1.04565 s |

ASF timestamps are milliseconds and the WMA decoder's delay is not signalled exactly, so a seek lands tens of
milliseconds away from the decoded sample count. With the sample-exact decode the export of a clip with a 0.5 s In
point lines up with the playback copy at lag 0 (residual ≤ −50 dB after the export's own resampling); with the input
seek it was 11 samples off at 48 kHz (the test fails that way). `atrim=start_sample` counts samples (verified: output
equal to the full decode from sample 22050).

## Preview wiring

- `MediaRuntime.playbackAudio` / `playbackAudioUrl` (`packages/session`), fed by `GET /api/media/:key`,
  `derivative.ready` and `job.*` events (`apps/web/src/import/media-runtime.ts`).
- `resolveMediaHandle` sets `MediaHandle.playbackAudio`: stream index → WAV URL when ready, `null` while not.
- `audioSrc` (`packages/compositions/src/pipeline.ts`) is what `AudioLayer` plays: the clip's stream WAV; `null` is
  silence, never the undecodable original. `AssetComposition` plays the first stream; a video of such media plays its
  picture muted and without an audio track (`videoAudioTrackProps`), the sound from the copy. Scrubbing and Detect Peak
  read the WAV (`browserAudioSource`).
- Timeline: an audio clip of such media shows "Audio queued" / "Audio NN%" while the copy is made and a red "No playback
  audio" badge with the error when it failed; the waveform comes from the engine's peaks as before. The Project panel
  counts the job as analysis. The Jobs panel lists it under Media analysis.
- MCP: `get_media_info` returns `playbackAudio {needed, codecs, status}`; `import_media` notes it.

## Fixtures

`scripts/fixtures/legacy-audio.mjs` (generated, never committed): `legacy-wma.wma` (FFmpeg's native LGPL `wmav2`
encoder; the LGPL build has it) and `legacy-ac3.mkv` (H.264 + 5.1 AC-3, native `ac3` encoder).

## Limitations

- An audio stream that starts later than its container's start is aligned to its first decoded sample in both preview
  and export (consistent with each other, as the export already did for clips from 0 s); no start offset is applied.
- AC-3 / E-AC-3 use the copy even on platforms whose Chromium could decode them.
- Other analysis features (beat detection, classification, remix measurement) still seek with `-ss`; they do not play
  audio in the preview.
- The sample-exact export decode reads such files from their start for every clip: long files with a late In point
  decode more (audio decoders run at hundreds × real time; not benchmarked).

## Checked in the running app (VM dev stack, Chromium via agent-browser, 2026-10-25)

- Imported `legacy-wma.wma` and `legacy-ac3.mkv` from the Media Browser (which says the WMA cannot play in the browser
  until imported). The WMA clip on A1 shows its waveform; playing it the Program fetches
  `/media/<key>/playback-audio/0.wav?v=…` (never the original), the Audio Meters move (M −15 LUFS, TP −2.1 dBTP).
- The AC-3 MKV plays its picture (muted `<Video>` without audio track) and its sound from the playback copy.
- The Source monitor plays the WMA from the playback copy.
- A WMA with a valid header and garbage packets (FFmpeg exits 0 with no samples) shows the red "No playback audio"
  badge with the error in its tooltip; the editor stays usable.
- A 2-hour stereo WMA's playback copy (2.6 GB) took about 10 s on the VM (16 vCPU, shared with other agents; measured
  once, informally).

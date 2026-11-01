# Agent footage editing — safety (spec 18 §2.1, AF-SEC-001…004)

FFmpeg reads local media only, and engine-generated filtergraphs are checked against the GPL-only filter list
before FFmpeg starts.

## Behaviour

### Local inputs (AF-SEC-001)

- `apps/engine/src/tools/protocols.ts` owns `LOCAL_PROTOCOLS` (`-protocol_whitelist file,crypto,data`); the sound
  code and the Media Browser import it from there (their private copies are gone).
- `restrictInputs(args)` puts a whitelist in front of every `-i` whose option group has none:
  - `file,crypto,data` for files;
  - `pipe,fd` for `pipe:N` / `-` (FFmpeg 6.1 opens `-` with the `fd` protocol, measured);
  - nothing for `-f lavfi`, which opens no protocol.

  A caller's own whitelist is kept. `restrictProbeArgs(args, formats)` does the same for ffprobe and adds
  `-format_whitelist`.
- Applied at the choke points rather than at about 120 `-i` sites:
  - `Ffmpeg.run`, `Ffmpeg.spawnRaw`, `probeJson`, `probeText` and `countVideoFrames` (`tools/ffmpeg.ts`). Every runner
    that goes through the `Ffmpeg` class is covered, including runners added later (export, derivatives,
    proxies, media jobs, loudness, scenes, reframe, grading, layer bake, previews and audio decode/mixdown).
  - Code that starts the binaries itself: jasper-proc (`processing/proc/ffio.ts`, `proc/probe.ts`, which also cover
    remote processing because jasper-proc runs there), the roto/camtrack frame reader (`roto/worker/frames.ts`),
    the speech worker (`speech/worker/run.ts`, `audio.ts`), the CLAP worker (`sounds/semantic/worker/cli.ts`), the
    jasper-mg pipe and its frame count (`mg/render.ts`), the processing service's packet count, the hardware encoder
    test (`tools/encoders.ts`, lavfi input) and the de-judder validation CLI.
- `apps/engine/test/local-inputs.test.ts` scans `apps/engine/src` with a source scan. Every file that imports a
  `node:child_process` value or calls `runTool` / `spawnTool` must be either listed as an FFmpeg spawner that calls
  `restrictInputs` / `restrictProbeArgs`, or listed with the program it starts instead. An unclassified new spawn site
  fails the test. No source may name a protocol outside `file,crypto,data,pipe,fd` in a whitelist.
- **DASH bypass on FFmpeg 6.1 (measured).** On the system FFmpeg 6.1.1, a local `.mpd` whose `BaseURL` is
  `http://127.0.0.1:<port>/seg.ts` was fetched by `ffprobe` and by `ffmpeg -i` with and without
  `-protocol_whitelist file,crypto,data`. So was a manifest named by a local `ffconcat` list or used as a local HLS
  "segment". The vendor LGPL 7.1.5 build (`vendor/ffmpeg-lgpl/linux-x64`) refuses the same manifest under the
  protocol whitelist (`Protocol 'http' not on whitelist`). Its HLS demuxer also refuses a DASH "segment" by itself:
  `extension_picky` reports "detected format dash … mismatches allowed extensions". A dev or system build can still
  have the 6.1 behaviour, so probes also pass `-format_whitelist`. It holds every demuxer the binary lists
  (`ffprobe -demuxers`, cached per binary; a failed listing is retried at the next probe) except
  `NETWORK_DEMUXERS`: `dash`, plus `rtsp`, `rtp`, `sdp` and `sap`, which exist only to open network sessions.
  Nested demuxers inherit the format whitelist (`ff_copy_whiteblacklists`), so the nested cases are refused too
  (measured on both builds).
- HLS with an `http://` segment: FFmpeg 6.1 already refuses it when the playlist is opened through `file` (the
  `file` protocol's default whitelist is `file,crypto,data`). The explicit whitelist does not depend on that default
  or on how the input is named.
- Refusals become `REMOTE_REFERENCE_BLOCKED` (new engine error code in `packages/api/src/common.ts`, not retryable).
  The code is set by `Ffmpeg.run` and the probes from FFmpeg's `Protocol '<p>' not on whitelist` or
  `[<demuxer> @ …] Format not on whitelist` stderr lines. A run that logged a refusal fails even when FFmpeg exited 0,
  for example an HLS playlist that skipped the segment: the output would otherwise be missing media without notice.
  Media registration reports the code per file.

### GPL-only filters (AF-SEC-003, AF-SEC-004)

- `GPL_FILTERS` (`processing/proc/filters.ts`) follows FFmpeg's `configure`. The n6.1 and n7.1 lists agree:
  - every `<name>_filter_deps` containing `gpl`;
  - the filters of GPL-only external libraries (`EXTERNAL_LIBRARY_GPL_LIST`): `frei0r`, `frei0r_src`
    (frei0r), `rubberband` (librubberband), `vidstabdetect` and `vidstabtransform` (libvidstab).
- Added: `boxblur_opencl`, `cover_rect`, `find_rect`, `frei0r_src`, `nnedi`, `rubberband`, `signature` and
  `vaguedenoiser`. Removed: `ocr` (`ocr_filter_deps="libtesseract"`, which is Apache-2.0, not GPL).
- AGENTS.md §2 rule 2 names exactly this list. `apps/engine/test/lgpl-filters.test.ts` parses the rule and compares the
  two lists. The `vidstab*` exception sentence stays.
- `assertLgplFilters` throws `LgplFilterError` with code `GPL_FILTER_REFUSED` (new engine error code, not
  retryable). Its parser no longer splits on escaped commas (`\,`), which made `select=if(gt(t\,1)\,eq(n\,0)\,0)`
  look like an `eq` filter.
- The native export checks the composite graph and every blend-segment graph right after building them, before
  any process starts. The previews export checks its graph before writing it to its `-filter_complex_script` file. A
  long graph also goes to a script file, which an argument check cannot read.
- `Ffmpeg.run` and `spawnRaw` also check `-filter_complex`, `-lavfi`, `-vf`, `-af`, `-filter[:a|:v]` and `-f lavfi`
  sources in every argument list. This covers derivatives and every other runner.

## Tests run

The machine is a shared 4-core host. Commands ran under `flock`:

- `pnpm exec vitest run apps/engine/test/local-inputs.test.ts apps/engine/test/lgpl-filters.test.ts --maxWorkers=1`:
  all passed. Unit and property tests of the argument builders, the demuxer parsing for the 6.1 and 7.1 listing
  formats, the stderr classification, the source scan and the AGENTS.md comparison.
- `JASPER_FFMPEG_LGPL_ONLY=1 pnpm exec vitest run apps/engine/test/local-inputs-network.test.ts
  apps/engine/test/export-lgpl-guard.test.ts --maxWorkers=1`: 5 passed. The engine used the vendor LGPL 7.1.5
  build. The 6.1.1 refusals of the DASH cases were checked by hand with the same arguments.
  - AF-SEC-002: a local listener counts requests. Probe/registration of an HLS playlist with an http segment, of a
    DASH manifest and of a DASH manifest named by a local `ffconcat` list each return `REMOTE_REFERENCE_BLOCKED`.
  - A poster derivative and a native export of a playlist swapped to an http segment after registration (same size
    and mtime) also fail with `REMOTE_REFERENCE_BLOCKED`.
  - The listener got zero requests in every case.
  - AF-SEC-003: a native export whose graph builder appends `hqdn3d`, padded past the script-file threshold, fails
    with `GPL_FILTER_REFUSED` and never starts the composite.
- Regression tests failed before the fix:
  - before the change, probes returned `UNSUPPORTED_MEDIA` and the derivative and export returned `TOOL_FAILED`;
  - the lgpl-filters tests failed;
  - without the export's explicit check, the export guard test failed with `TOOL_FAILED`.
- Regression sweep, all passed under `JASPER_FFMPEG_LGPL_ONLY=1`, run in three batches:
  - media, imports, browse, encoders, processing-steps, processing-cli, audio-decode, sounds-unit, tracking-unit,
    color and unit;
  - export, processing, roto, mg, jobs, subtitle-taps-failure, audio-deliver, sound-copy-codec,
    sound-design-measure-worker, tracking, gaps-media-jobs, gaps-reframe, sync-audio, previews,
    sound-semantic-unit, speech-core, camtrack-job and sounds-index (136 passed, 4 skipped by their own gates);
  - processing-steps again after the `fd` fix.

  processing-steps first failed because FFmpeg opens `-i -` with the `fd` protocol; pipe inputs now get `pipe,fd`.
- `pnpm --filter @jasper/api typecheck` and `pnpm --filter @jasper/engine typecheck` passed.

## Limits

- `-format_whitelist` is passed to probes only. One input's list is about 2 KB, which would exceed Windows'
  32 K command line on exports with many inputs. Every file is probed when it is registered, browsed or added to the
  sound library, so a DASH manifest never becomes media. A registered file whose content is replaced by a DASH
  manifest while its size and modification time stay the same would still be fetched by a later export, derivative
  or worker run on a 6.1-style build, where the protocol whitelist does not stop DASH.
- The DASH bypass was measured on 6.1.1 only. The vendor 7.1.5 build refuses it through the protocol whitelist.
  Its `-demuxers` listing format is covered by a unit test from `fftools/opt_common.c` (n7.1).
- Errors of `spawnRaw` callers, jasper-proc and the workers stay generic: they read stderr themselves. The network
  access is refused all the same.
- Filters that open files themselves (`movie`, `amovie`, `subtitles`) are not covered by input whitelists. The engine
  generates none of them; their arguments would be engine-written paths.
- The Remotion path is unchanged. Media reaches Chrome over the engine's HTTP server, which the spec says starts no
  FFmpeg. The FFmpeg calls Remotion makes inside `@remotion/renderer` were not audited here.
- The filter check reads filter names from the graph text. A GPL filter name inside a quoted option value is not a
  filter and is not reported.

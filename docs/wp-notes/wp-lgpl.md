# wp-lgpl — Remotion renders with our LGPL FFmpeg (ARCHITECTURE D-13)

Branch `wp/wp-lgpl`. Decision: the Remotion render path uses **our LGPL FFmpeg** instead of the GPL/nonfree
FFmpeg bundled in `@remotion/compositor-*`. Nothing GPL/nonfree ships in packaged builds. This note records
how Remotion uses its binaries (A), the LGPL build (B), the wiring (C–F), what was verified (G) and what is
left. Not legal advice; see "Open points" for the items that need a license review.

## A. How `@remotion/renderer` 4.0.499 uses its compositor package

Checked against the installed sources (`node_modules/@remotion/renderer/dist`) and the binaries.

| Topic | Finding |
|---|---|
| Where binaries come from | `compositor/get-executable-path.js`: `getExecutablePath({type, binariesDirectory})` returns `<base>/remotion[.exe]`, `<base>/ffmpeg[.exe]`, `<base>/ffprobe[.exe]`. `base` is the `binariesDirectory` option, or `require('@remotion/compositor-<platform>').dir` when it is null. The compositor packages are **optionalDependencies** of `@remotion/renderer` and are only `require`d in that fallback, so the renderer works without any of them installed as long as `binariesDirectory` is passed. |
| Supported override | `binariesDirectory` on `renderMedia`, `renderStill`, `selectComposition`, `getCompositions`, `renderFrames`, `stitchFramesToVideo`, `getVideoMetadata`, `getSilentParts`, `extractAudio` (it is threaded to every internal ffmpeg call: `call-ffmpeg.js`, `prespawn-ffmpeg.js`, `offthread-video-server.js`, `prepare-server.js`, audio preprocessing/merging). The engine passes it to the three calls it makes (`selectComposition`, `renderMedia`, `renderStill`). |
| Compositor process | `compositor/compositor.js` spawns `<base>/remotion` (Rust) with `cwd = <base>`; on macOS it sets `DYLD_LIBRARY_PATH=<base>`. It serves `<OffthreadVideo>` frame extraction, video metadata, silence detection and audio extraction. `make-file-executable.js` `chmod`s a binary only when it is not executable. |
| ffmpeg / ffprobe | `call-ffmpeg.js` runs `<base>/ffmpeg` and `<base>/ffprobe` with `cwd = <base>` (macOS: `DYLD_LIBRARY_PATH=<base>`). Used for stitching frames, audio mixing (PCM intermediates, `amix`/`adelay`/`atrim`…), muxing and encoder probing. |
| Encoders Remotion asks for | `get-codec-name.js`: `h264` → **`libx264`** (or `h264_videotoolbox` / `h264_nvenc` with `hardwareAcceleration`), `h265` → `libx265`, `vp8` → `libvpx`, `vp9` → `libvpx-vp9`, `av1` → `libaom-av1`/`libsvtav1`, `prores` → `prores_ks`. `options/audio-codec.js`: `aac` → **`libfdk_aac`**, `opus` → `libopus`, `mp3` → `libmp3lame`, `pcm-16` → `pcm_s16le`. So `codec: 'h264'` and `audioCodec: 'aac'` cannot work on an LGPL build; ProRes + PCM and VP8/VP9 + Opus can. |
| Linux compositor (`compositor-linux-x64-gnu`) | ELF, `RPATH $ORIGIN`, `NEEDED` **unversioned** names `libavcodec.so libavdevice.so libavfilter.so libavformat.so libavutil.so libswscale.so` (+ libc/libm/libgcc_s), versioned symbols `LIBAVCODEC_61 LIBAVFORMAT_61 LIBAVUTIL_59 LIBAVFILTER_10 LIBAVDEVICE_61 LIBSWSCALE_8` → FFmpeg **7.1** ABI. The package ships `libav*.so` as plain files. |
| Windows compositor (`compositor-win32-x64-msvc`) | `remotion.exe` imports `avcodec-61.dll avdevice-61.dll avfilter-10.dll avformat-61.dll avutil-59.dll swscale-8.dll` (63 functions). The package also carries an FFmpeg 6.1 DLL set (`avcodec-60.dll` …, "nonfree and unredistributable") that `remotion.exe` does not import. |
| macOS compositor (`compositor-darwin-arm64`) | Mach-O, loads bare leaf names `libavcodec.dylib libavdevice.dylib libavfilter.dylib libavformat.dylib libavutil.dylib libswresample.dylib libswscale.dylib` with compatibility versions 61/61/10/61/59/5/8 (resolved through `DYLD_LIBRARY_PATH`/cwd). |
| FFmpeg features the compositor uses | Decoders by name `libvpx` / `libvpx-vp9` (transparent WebM), otherwise the default decoders; a `zscale` + `tonemap` filter chain for HDR sources (`toneMapped`). |
| What ships in the npm packages | Every `@remotion/compositor-*@4.0.499` is a GPL FFmpeg n7.1 (`--enable-gpl --enable-libx264 --enable-libx265 --enable-libfdk-aac`); see `wp-3l.md` for the table. |

## B. The LGPL FFmpeg (`pnpm ffmpeg:lgpl`)

`scripts/ffmpeg/manifest.json` pins everything by sha256; `scripts/ffmpeg/fetch-or-build-lgpl.mjs` produces
`vendor/ffmpeg-lgpl/<platform>-<arch>/` (gitignored):

```
ffmpeg, ffprobe                 LGPL FFmpeg 7.1.5 (n7.1.5-12-g1fdbca85aa), no --enable-gpl / --enable-nonfree
libavcodec.so.61 … (+ libavcodec.so symlinks; *.dll on Windows; lib*.61.dylib + lib*.dylib on macOS)
remotion[.exe]                  Remotion's compositor, copied unmodified from @remotion/compositor-*@4.0.499
LICENSE-FFmpeg.txt              LGPL 3 (BtbN builds, --enable-version3) or LGPL 2.1 (source builds)
COPYING.GPLv3.txt               only for LGPL 3 builds: the text LGPL 3 refers to (the build is not GPL)
NOTICE-FFmpeg.txt, BUILDINFO.json   source link, build origin, sha256 of every file, configure line
```

| Platform | Source | Status |
|---|---|---|
| linux-x64 | BtbN/FFmpeg-Builds `autobuild-2026-07-31-14-10`, `ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-lgpl-shared-7.1.tar.xz` | Downloaded, checksum verified, assembled and **run** here. Encoders: `libopenh264`, `h264_nvenc/qsv/amf/vaapi`, `libvpx`, `libvpx-vp9`, `libsvtav1`, `libaom-av1`, `prores_ks`, `aac`, `libopus`; filters incl. `zscale`, `tonemap`, `loudnorm`. |
| linux-arm64 | same release, `linuxarm64-lgpl-shared` | Pinned; not downloaded or run here. |
| win32-x64 | same release, `win64-lgpl-shared` (zip) | Downloaded and assembled here (`--platform win32-x64`); checked statically only: embedded configure line and license strings, and all 63 functions `remotion.exe` imports are exported by the LGPL DLLs. **Not run on Windows.** |
| darwin-arm64 / darwin-x64 | `scripts/ffmpeg/build-lgpl-from-source.sh` (no LGPL prebuilt exists): nasm, opus 1.5.2, libvpx 1.15.2, openh264 2.6.0, SVT-AV1 3.1.2, FFmpeg 7.1.5, all pinned; `--enable-videotoolbox --enable-audiotoolbox` | The same script was **built and run on Linux** (`--from-source`): LGPL 2.1 build, ABI-compatible with the compositor, Remotion e2e passes with it. **Not executed on macOS.** |

Steps per platform:

- Linux: `pnpm ffmpeg:lgpl` (downloads ~50 MB once, cached in `vendor/ffmpeg-lgpl/.cache`).
- Windows: `pnpm ffmpeg:lgpl` on Windows, or `node scripts/ffmpeg/fetch-or-build-lgpl.mjs --platform win32-x64`
  from any host (cross-assembly: the compositor is fetched with `npm pack`).
- macOS: `pnpm ffmpeg:lgpl` builds from source (Xcode command line tools, cmake, pkg-config, curl; ~5 min on
  12 cores on Linux). `--ffmpeg-prefix <dir>` assembles from any existing LGPL 7.1 install prefix instead.
- `--from-source` forces the source build on Linux; `--force` re-assembles; `--out <dir>` changes the target.

ABI compatibility (the point of pinning 7.1): the compositor needs libavcodec 61 / libavformat 61 /
libavutil 59 / libavfilter 10 / libavdevice 61 / libswscale 8 (+ libswresample 5 on macOS), which is exactly
the FFmpeg 7.1 release series the pinned builds come from. The assembly refuses a prefix with other majors,
and on Linux runs `ldd -r` on the compositor inside the assembled directory: every library must resolve to
that directory and no symbol may be undefined. `manifest.json` also pins the sha256 of the compositor binary
per platform, so a Remotion upgrade fails loudly until the ABI is re-checked.

License guard (`pnpm ffmpeg:check [dirs…]`, `scripts/ffmpeg/check-lgpl.mjs`): runs
`ffmpeg -hide_banner -buildconf`, `-encoders` and `-L` on every ffmpeg/ffprobe it can execute and reads the
embedded configure line and license string of everything else (libraries, binaries for another OS). Fails on
`--enable-gpl`, `--enable-nonfree`, x264/x265/fdk-aac and the other GPL/nonfree external libraries, a GPL or
nonfree license string, a stand-alone `libx264`/`libx265`/`libfdk-aac`/`xvidcore` library, any
`@remotion/compositor-*` package directory, a GPL FFmpeg embedded in an `.asar`, or when nothing is found.
`--packaged <appOutDir>` additionally requires the complete `ffmpeg-lgpl` directory and no FFmpeg outside it
(Electron's own `libffmpeg.so`/`ffmpeg.dll` is checked by its license string).

## C. Binaries directory resolution (`apps/engine/src/tools/lgpl.ts`)

One directory serves Remotion (`binariesDirectory`) and the engine's own ffmpeg:

1. `JASPER_REMOTION_BIN_DIR` (legacy `JASPER_REMOTION_BINARIES_DIR`); a set but incomplete directory is an
   error, never a silent switch to another FFmpeg;
2. packaged resources: `<resources>/ffmpeg-lgpl` (`JASPER_RESOURCES_DIR`, set by the Electron main; a
   utilityProcess also has `process.resourcesPath`);
3. dev checkout: `vendor/ffmpeg-lgpl/<platform>` found above the engine module (`JASPER_FFMPEG_VENDOR=0`
   skips it);
4. nothing: **dev engines** (`JASPER_DEV=1`) let Remotion use its bundled FFmpeg and report
   "Remotion is using its bundled GPL FFmpeg (dev only)" (capability `render.remotionBinaries.message`, engine
   startup log, About dialog, Export view); **every other engine** (packaged, built, server) reports
   `render.remotionLocal: 'unavailable'` and refuses Remotion renders with `BINARY_MISSING`.

At startup the engine probes the directory's ffmpeg (`-version` configuration). A directory whose ffmpeg is
not an LGPL build is refused outside dev and flagged in dev, so pointing the env var at Remotion's own
package does not bypass the rule.

## D. Remotion export plan (`apps/engine/src/remotion/export-plan.ts`)

- H.264 (and AV1, and VP9 in MP4): **two phases**. Remotion renders ProRes 422 HQ (`prores_ks`) + PCM into
  the job scratch dir; the engine's ffmpeg encodes it with the encoder the D-13 selector chose (hardware
  H.264 → OpenH264 → AV1/VP9). Progress: `Step 1/2 · Remotion → ProRes · Rendering frames` takes 60–85 % of
  the bar depending on the encoder, `Step 2/2 · <encoder> · Encoding` the rest; the result carries
  `remotionOutput: 'intermediate'`.
- VP9 in WebM with Opus: **direct**, Remotion encodes with `libvpx-vp9` + `libopus` (CRF mapped like the
  native path, speed/GOP through `ffmpegOverride`, BT.709 tagging only when the build has `zscale`);
  `remotionOutput: 'direct'`.
- H.264 directly in Remotion only when both FFmpegs are GPL dev builds and `libx264` was selected (unchanged
  dev behaviour); never with the LGPL directory, never in LGPL-only mode.
- OpenH264 output now carries BT.709 primaries/transfer (`h264_metadata` bitstream filter): FFmpeg 7.1's
  wrapper only writes the matrix.

## E. Native ffmpeg path

`resolveBinaries` order: `JASPER_FFMPEG`/`JASPER_FFPROBE` → `<resources>/bin` → `<resources>/ffmpeg-lgpl` →
`vendor/ffmpeg-lgpl/<platform>` → `PATH`. Reported as `media.ffmpegSource` (`env | resources | vendor | path |
missing`). With the vendor directory present a dev engine therefore already runs the shipped build
(OpenH264 instead of x264). `pnpm fixtures` still uses the `PATH` ffmpeg and falls back to OpenH264 when it
has no libx264.

## F. Packaging (`apps/desktop`)

`pnpm --filter @jasper/desktop dist:dir` (or `dist`) runs `scripts/package.mjs`:

1. `fetch-or-build-lgpl.mjs --platform <target>`; the directory is staged as
   `vendor/ffmpeg-lgpl/.package/<os>-<arch>` because electron-builder's `${platform}` macro is the *host*
   platform (found while cross-packaging: the Windows app first received the Linux directory).
2. `pnpm build` + `build:remotion`.
3. `apps/engine/dist-deploy`: `engine.mjs`, `remotion-bundle/`, `fonts/` and `node_modules` with the runtime
   closure of `@remotion/renderer` copied from the workspace (30 packages, locked versions) **without
   optional dependencies**, so no `@remotion/compositor-*` is ever staged (the script aborts if one appears).
4. `jasper-mg` → `native/bin/<os>-<arch>` when built for the host.
5. License guard over the staged directories, then electron-builder.

electron-builder config (`apps/desktop/package.json`): `extraResources` `ffmpeg-lgpl` ← the staged directory,
`engine/node_modules` as its own entry (electron-builder drops a root-level `node_modules` of an
extraResources source) with `!@remotion/compositor-*/**` filters, the same exclusion in `files`, and
`afterPack: scripts/after-pack.cjs`, which fails the build when the packed app has any GPL/nonfree FFmpeg, a
compositor package, a missing/incomplete/wrong-platform `ffmpeg-lgpl` directory or no engine runtime.
`main.ts` passes `JASPER_RESOURCES_DIR=process.resourcesPath` to the engine.

## G. Verification (this worktree, Linux x64, 2026-09-30)

See the final report of the work package for the exact command results. In short:

- `pnpm ffmpeg:lgpl` from an empty `vendor/` (download, sha256 `f5f0ad52…64b3ec` ok, assembly, `ldd -r`);
  `pnpm ffmpeg:check`: 9 artifacts LGPL. `ffmpeg -hide_banner -buildconf` has no `--enable-gpl` /
  `--enable-nonfree`; `ffmpeg -L` is the LGPL text.
- Unit tests: `scripts/ffmpeg/lib.test.mjs` (license evaluation, string scan, tree and packaged-app guard,
  manifest pins, ELF RPATH rewrite), `apps/engine/test/lgpl-binaries.test.ts` (resolution order, strict
  refusal, license probe of Remotion's own package, export plan, license entries),
  `apps/web/test/licenses.test.tsx`, `apps/desktop/test/security.test.ts`.
- Gated integration test `apps/engine/test/remotion-lgpl.e2e.test.ts` (`REMOTION_E2E=1`), non-dev engine with
  the LGPL directory: capabilities report it; H.264 export = Remotion ProRes intermediate (video clip + audio
  + text, so `<OffthreadVideo>` frame extraction runs on the LGPL libav*) → OpenH264, ffprobe `h264`/`aac`,
  24 frames, BT.709, no x264 SEI; VP9/Opus WebM direct; a still. Also run against the source-built LGPL 2.1
  directory (`JASPER_REMOTION_BIN_DIR=…`), and `remotion.e2e.test.ts` with `JASPER_FFMPEG_VENDOR=0` (dev
  fallback to the bundled build still works).
- Packaging: `dist:dir` for linux-x64 (packed app: 10 FFmpeg artifacts incl. Electron's `libffmpeg.so`, all
  LGPL) and cross-packed for win32-x64 (`--platform win32`; guard only). `pnpm e2e:packaged`
  (`e2e/packaged-lgpl-check.mjs`): the packed engine, copied outside the checkout, with poisoned
  `ffmpeg`/`ffprobe` first in `PATH`, reports ffmpeg and Remotion binaries from `resources` (LGPL), resolves
  no compositor package and exports H.264 through Remotion (30 frames, OpenH264). The packed Electron app
  starts under xvfb and shows Home with "Engine: connected". Negative checks: a compositor package placed in
  the staging directory is filtered out; a stray GPL `ffmpeg`/`libavcodec.so` fails the build in `afterPack`.

## H. Docs and About

ARCHITECTURE D-13, README (requirements, scripts, packaging), M1-STATUS (packaging blocker resolved).
`GET /api/licenses` returns the FFmpeg entry of the directory in use (SPDX id, exact source commit, BtbN
release, notice, license texts); Help ▸ About JasperEditor shows it (`apps/web/src/shell/licenses.tsx`), with
a static LGPL notice when no engine is connected.

## Open points / not done

- **macOS is unverified.** The source build ran on Linux only. On macOS the compositor finds the dylibs
  through `DYLD_LIBRARY_PATH`, which a hardened-runtime app strips unless the helper binaries are signed with
  `com.apple.security.cs.allow-dyld-environment-variables` (and library validation is relaxed for the
  third-party dylibs). That applies to Remotion's own package as well; it needs a signed test build.
- **Windows is unverified at run time** (static checks only). Unsigned `remotion.exe`/DLLs may need signing.
- **Source builds have no `zscale`** (zimg is not built): Remotion cannot tone-map HDR sources and VP9 direct
  output is not BT.709-tagged there. BtbN builds have it. Add zimg to `build-lgpl-from-source.sh` for macOS.
- **OpenH264 and patents.** The BtbN build links OpenH264 compiled from source. Cisco's royalty coverage
  applies only to Cisco's own binary downloaded by the end user, so shipping this build leaves H.264 patent
  licensing with the distributor (D-13 originally said "Cisco binary"). Hardware encoders are preferred by
  the selector; this needs a decision before distribution. Same kind of question for AAC.
- **LGPL 3 obligations** (BtbN builds use `--enable-version3`): the app ships the license texts, a notice and
  the source link, and the libraries are replaceable shared libraries next to the executables. Installers
  that prevent replacing them (e.g. sealed/signed bundles) need a review.
- **BtbN release retention.** The pinned month-end release exists today; mirror the three archives (the
  sha256 pins stay valid) before relying on them long term.
- **Server/Docker images** built with a plain `pnpm install` still contain `@remotion/compositor-*` in
  `node_modules` (the engine never uses them outside dev). Use the staged `dist-deploy` layout or
  `pnpm install --no-optional`, and run `pnpm ffmpeg:check <image root>`.
- linux-arm64 and musl are pinned/mapped but not run. `pnpm e2e:packaged` is not part of `pnpm e2e`.
- Remotion's own license (company license, D-19) is unchanged by this work.
- No hardware H.264 encode was run (no GPU on this host); OpenH264 now has run for real.

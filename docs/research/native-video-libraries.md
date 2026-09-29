# Native (CPU) video processing libraries for JasperEditor

Status: research, 2026-09-29. Author: research agent (topic `native-video-libs`).
Scope: which native/CPU media libraries and tools JasperEditor should use alongside FFmpeg, called from a
Node/Electron (TypeScript) app on Linux/macOS/Windows, plus what can run in the browser (web + PWA).
All commands under "Verified" were run on the dev box (Linux x64, 12 cores, AVX2, no GPU). Scratch
artifacts are in `/tmp/jasper-research/native-video-libs/`. The host had a load average of 9 to 11 while
I measured, so treat the timings as rough, conservative numbers.

---

## 0. TL;DR

- **The FFmpeg CLI is the workhorse.** Pin our own FFmpeg 8.1 or 9.0 build, ship it outside the asar, and
  drive it with `child_process.spawn` plus `-progress pipe:1`. Don't use `fluent-ffmpeg` (archived in
  May 2025 and deprecated on npm), `beamcoder` (GPL-3, no releases since 2023), or `ffmpeg-static`
  (GPL, pinned to 6.1.1, downloads at install time).
- **In-process libav: `node-av`** (MIT wrapper, v6.1.1, active, prebuilt for 8 platform/arch combos,
  works in Electron). Mediabunny's official Node polyfill `@mediabunny/server` is built on it, so the
  Mediabunny code the starter already runs in the browser (`extract-frames.ts`, `load-waveform-peaks.ts`)
  can also run natively. **License warning:** the prebuilt `node-av.node` is a static Jellyfin-FFmpeg
  build configured with `--enable-gpl --enable-version3 --enable-libx264 --enable-libx265 --enable-libfdk-aac`
  (I read this from the binary's strings). The binary is effectively **GPLv3**, and the GPL + fdk-aac mix
  is one FFmpeg itself calls "nonfree / unredistributable". The npm "MIT" label only covers the JS/C++ glue.
- **Remotion's bundled FFmpeg** (`@remotion/compositor-*`) is FFmpeg n7.1, cut down to about 50 filters,
  a few demuxers (no MXF), no DNxHD/CineForm decode, GPL, and also links fdk-aac. It's fine for Remotion
  renders. It is **not** our general-purpose media engine.
- **The system FFmpeg here (6.1.1, Ubuntu) is GPL.** It has lut3d, scdet, loudnorm, ebur128, rubberband,
  frei0r, ladspa, lv2, libplacebo, vidstab and all the useful encoders. It lacks `whisper` (added in 8.0)
  and `ocio` (added in 8.1). `melt`, `gst-launch-1.0`, `vips`, `sox`, `rubberband` CLI, `whisper-cli` and
  `vspipe` are **not installed**. The GStreamer 1.x, OpenCV 4.6 core, OCIO 2.1, OIIO 2.4, libplacebo,
  SoundTouch and rubberband shared libraries **are** installed (as dependencies of other packages).
- **Interchange means OpenTimelineIO.** I verified this: a JasperEditor-shaped `UndoableState` converts to
  `.otio`, then through the OTIO plugins to **FCP7 XML (`xmeml`, Premiere's native XML)**, **CMX3600 EDL**
  and **AAF** (write with `use_empty_mob_ids=True`), and each file reads back. The adapters are Python only.
  Plan: write `.otio` JSON natively in TS and use a Python sidecar (`otioconvert`) for the other formats.
- **Local transcription: whisper.cpp v1.9.4** (MIT). Built here in about 1.5 min. On this CPU, `base.en`
  transcribed 65 s of speech in about 3 to 6 s (10 to 20x realtime) with word-level timestamps in JSON.
  `@remotion/install-whisper-cpp` already turns its output into the `Caption[]` type that `CaptionAsset` uses.
- **Silence cutting and scene detection:** ffmpeg `silencedetect` and `scdet` / `select=gt(scene,…)` are
  enough and fast (0.2 to 0.4 s for a minute of media). Offer auto-editor (Unlicense, a single 41 MB
  binary, exports Premiere XML, FCPXML, Shotcut MLT, Kdenlive and a clean `v3` JSON) and PySceneDetect
  (BSD-3) as optional power tools.
- **Skip for v1:** MLT/melt, GStreamer/GES, VapourSynth/AviSynth, an OpenFX host, OpenCV (until we build
  tracking or reframing), and libvips/sharp (except for stills).

The full recommended stack is in section 8.

---

## 1. What's on this machine (verified)

```
ffmpeg 6.1.1-3ubuntu5  --enable-gpl --enable-shared ... (full config in /tmp/jasper-research/native-video-libs)
hwaccels: vdpau cuda vaapi qsv drm opencl vulkan (no GPU is present, so all are unusable)
```

| Category | Present in system ffmpeg 6.1.1 |
|---|---|
| Video encoders | libx264, libx265, libsvtav1, librav1e, libaom-av1, libvpx(-vp9), prores / prores_ks / prores_aw, dnxhd, cfhd, ffv1, utvideo, qtrle, mjpeg, png, libwebp, libjxl, gif, h264_vaapi/_qsv/_nvenc (no HW) |
| Audio encoders | aac, libopus, libmp3lame, flac, pcm_s16le/s24le |
| Decoders of note | h264, hevc, av1 + libdav1d, vp9, prores, dnxhd, cfhd, hap, dxv, exr, dpx |
| Muxers | mp4, mov, matroska, webm, mxf, mxf_opatom, hls, dash, segment, image2, wav, nut |
| Filters of note | trim/atrim/setpts/concat/overlay/xfade/acrossfade, **lut3d/lut1d/haldclut**, colorspace, **zscale**, tonemap, **libplacebo**, **scdet**, select(scene), thumbnail, tile, **showwavespic**/showwaves/showspectrumpic, **silencedetect**/silenceremove, **loudnorm**/**ebur128**/dynaudnorm/speechnorm, **rubberband**/atempo, afftdn/arnndn, acompressor/sidechaincompress/agate/equalizer, vidstabdetect/transform, deshake, blackdetect/freezedetect, minterpolate, drawtext/ass/subtitles, chromakey/colorkey, **frei0r**, **ladspa**, **lv2** |
| Missing | `whisper` filter (FFmpeg >= 8.0), `ocio` filter (FFmpeg >= 8.1) |

Other tools:

| Tool / lib | Status |
|---|---|
| melt (MLT), gst-launch-1.0 / ges-launch-1.0, vspipe, avs2yuv, vips, ImageMagick, sox, rubberband CLI, soundstretch, whisper-cli, otioconvert, auto-editor, scenedetect, frei0r plugins | **missing** |
| libgstreamer-1.0 + ~256 plugin .so files, libopencv_core/imgproc/videoio 4.6, libOpenColorIO 2.1, libOpenImageIO 2.4, libplacebo, librubberband 2, libSoundTouch 1, libSvtAv1Enc, librav1e, libdav1d, libx264, libx265 | shared libs present (package dependencies) |
| python3 3.12 + pip/venv, clang, cmake, blender | present |
| CPU | 12 vCPU AMD EPYC, AVX2/FMA/F16C, no AVX-512 |

For testing I installed these into `/tmp/jasper-research/native-video-libs/venv`: OpenTimelineIO 0.18.1 +
OpenTimelineIO-Plugins 0.18.1 (aaf 2.0.0, cmx3600 1.0.0, fcp 1.0.0, xges, ale, svg, burnins), scenedetect
0.7.1, opencv-python-headless 5.0.0.93, auto-editor 29.3.1. I built whisper.cpp v1.9.4 in
`/tmp/jasper-research/native-video-libs/whisper.cpp`.

Upstream versions (checked 2026-09-29): FFmpeg **9.0.2** "Lei" (current), 8.1.3, 8.0.3; MLT 7.40.0;
OCIO 2.5.2; libvips 8.18.7; VapourSynth R80; whisper.cpp 1.9.4; PySceneDetect 0.7.1; OTIO 0.18.1;
Remotion 4.0.530 (the repo pins 4.0.499); mediabunny 1.61.0 (the repo pins 1.50.8).

---

## 2. Licensing primer (read before choosing binaries)

Distributing an Electron app **is** distribution, so every native binary we ship brings its license
obligations with it.

| License | Examples | What it means for a closed-source Electron app |
|---|---|---|
| MIT / BSD / Apache / ISC / Unlicense | whisper.cpp, OTIO, OCIO, OpenCV >= 4.5, rav1e, SVT-AV1, dav1d, libvpx, PySceneDetect, auto-editor, node-av's JS glue, sharp's JS | Keep the notices. Nothing else. |
| MPL-2.0 | mediabunny, @soundtouchjs/audio-worklet | File-level copyleft. Only modified MPL files must be published. |
| LGPL-2.1/3 | FFmpeg core (default build), libvips, MLT core, GStreamer core + GES, libplacebo, SoundTouch, VapourSynth, soundtouchjs, waveform-data/peaks.js (LGPL-3) | OK when **dynamically linked or run as a separate process**. Ship the source (or an offer) of the exact version, allow relinking, and don't forbid reverse engineering in the EULA. |
| GPL-2/3 | FFmpeg with `--enable-gpl` (**libx264, libx265**, frei0r, rubberband, vidstab), rubberband, frei0r plugins, audiowaveform, beamcoder, ffmpeg-static binaries, Shotcut/Kdenlive | Running a GPL **CLI as a separate process** ("mere aggregation") is common practice (HandBrake-style GUIs, LosslessCut, many Electron apps do it) and keeps our app code out of scope. We still have to ship the GPL text plus the source or an offer. **Linking** GPL code into our process (a `.node` addon statically linking GPL FFmpeg, i.e. node-av's prebuilt) is a much stronger argument that the combined work is GPL. |
| "nonfree" | FFmpeg built with `--enable-gpl` **and** `libfdk_aac` | FFmpeg's configure refuses this combination without `--enable-nonfree`, and the result is "unredistributable". Both Remotion's compositor FFmpeg and node-av's prebuilt link fdk-aac next to x264/x265. Get legal review, or rebuild. |
| Remotion License | remotion, @remotion/* (compositor, media, web-renderer, lambda, whisper helpers) | Source-available. Free for individuals and small companies (<= 3 employees), otherwise a paid company license. Already a project dependency, but it matters for the product. |

**Patents are separate from copyright.** H.264, HEVC and AAC encoders carry patent-pool issues whatever
their code license is. OS-provided encoders (VideoToolbox, Media Foundation, VAAPI/NVENC/QSV) and Cisco's
OpenH264 *binary* (Cisco pays the royalties when the binary is downloaded from Cisco) are the usual
mitigations. AV1 (SVT-AV1, rav1e, dav1d), VP9 and Opus are royalty-free.

**Decision the team needs to make:**
- **Option A, the "GPL sidecar" (recommended for v1):** ship an FFmpeg **gpl** build (x264/x265, best
  quality/speed) as a separate executable run via `spawn`. Publish the FFmpeg source and build script.
  Our own code stays proprietary. Don't in-process-link GPL libav.
- **Option B, "LGPL everywhere":** ship an FFmpeg **lgpl** build and encode H.264/HEVC with platform HW
  encoders (`h264_videotoolbox`, `h264_mf`/`_nvenc`/`_qsv`/`_amf`, `h264_vaapi`), with OpenH264 (BSD
  source, weaker quality) as the CPU fallback, and AV1 via SVT-AV1. This also allows in-process libav
  (node-av built from source against LGPL FFmpeg).

[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) publishes both flavours for linux64 and
win64 (checked `latest` 2026-09-29): `ffmpeg-n9.0-latest-linux64-{gpl,lgpl}[-shared]-9.0.tar.xz`
(63 to 151 MB), plus win64 zips and n8.1 variants. These builds include `whisper`, `openh264`,
`libplacebo`, `rubberband`, `frei0r`, `svtav1`, `rav1e`, `dav1d`, `zimg` and `vvenc`. BtbN has no macOS
builds, so we'd build macOS ourselves in CI (Homebrew-free static script) or use evermeet.cx / osxexperts
static builds (GPL).

---

## 3. Where native code runs in JasperEditor

Today the starter does all media work **in the browser**:
- `src/editor/timeline/timeline-item/timeline-item-film-strip/extract-frames.ts` uses mediabunny `Input` +
  `VideoSampleSink` (WebCodecs) for filmstrips.
- `src/editor/timeline/timeline-item/timeline-item-waveform/load-waveform-peaks.ts` uses mediabunny
  `AudioSampleSink` and computes 100 peaks/s max-abs into a `QuickLRU` cache.
- `src/editor/rendering/render-state.ts` uses `renderMediaOnWeb` (`@remotion/web-renderer`) for
  client-side export (`h264` → mp4, `vp8` → webm).
- `src/routes/api/render.ts` uses `renderMediaOnLambda`. `src/routes/api/captions.ts` uses the OpenAI
  `whisper-1` API.
- `src/editor/items/video/video-layer.tsx` uses `<Video>` from `@remotion/media` (mediabunny-based) or
  `OffthreadVideo`.

Proposed layering (it mirrors orquester, where `apps/desktop` embeds `@orquester/daemon`, a Fastify
server, inside the Electron main process, and `apps/web` talks to the same daemon over HTTP/WS):

```
apps/web (browser/PWA) ──HTTP/WS──►  apps/daemon  (Node, "media engine")  ◄── apps/desktop (Electron main embeds it)
      │                                   │
      │ browser-only fallbacks:           ├─ packages/media-native: ffmpeg/ffprobe spawn wrapper, job queue,
      │  mediabunny/WebCodecs,            │    progress, cancellation, proxy/thumb/waveform cache
      │  ffmpeg.wasm (last resort)        ├─ whisper.cpp sidecar (whisper-cli / whisper-server)
      │                                   ├─ python sidecar (optional): otioconvert, scenedetect, auto-editor
      │                                   └─ fframes / Remotion renderer (motion-graphics layers → alpha video)
```

Rules:
1. **Heavy jobs never run in the Electron main process.** Use `utilityProcess.fork()` or the daemon's
   worker pool, and spawn ffmpeg from there. Otherwise a GC pause or synchronous parse freezes the UI.
2. **One media API, two backends.** Put a TS interface (`MediaEngine`) in `packages/media-engine`:
   - `NativeMediaEngine` (daemon, desktop): ffmpeg CLI + whisper.cpp + optional node-av/@mediabunny/server.
   - `BrowserMediaEngine` (web without a daemon): mediabunny/WebCodecs, the current code paths.
3. **Content-addressed cache.** Key proxies, thumbnails, peaks, transcripts and scene lists by
   `sha256(first+last 4 MiB + size + mtime)`, stored under `userData/media-cache/<hash>/…`.

---

## 4. Library-by-library evaluation

Each entry covers: what it's best at, license, Electron packaging burden, maturity, and a verdict.

### 4.1 FFmpeg CLI (`ffmpeg`, `ffprobe`)
- **Best at:** everything file-based. Probing, stream-copy cuts, transcodes, proxies, thumbnails,
  waveforms, loudness, scene/silence detection, LUTs, final EDL export via `-filter_complex`.
- **License:** LGPL-2.1+ by default. GPL with `--enable-gpl` (x264/x265/frei0r/rubberband/vidstab).
  "Nonfree" with fdk-aac (see section 2).
- **Packaging:** 2 static executables per platform (roughly 80 to 150 MB unpacked for a full static
  build; a custom build with only what we need can be 30 to 60 MB). Put them in electron-builder
  `extraResources` (not in the asar), resolve them via `process.resourcesPath`, and `chmod +x` on
  Linux/macOS. macOS needs them codesigned and notarized with the app (hardened runtime; spawning signed
  helpers is fine).
- **Maturity:** the industry standard. Releases: 8.0 (Aug 2025: whisper filter, Vulkan compute codecs),
  8.1 (Mar 2026: `ocio` filter, `drawvg`, Vulkan ProRes, D3D12), 9.0.x (current).
- **Verdict: ADOPT as the primary engine.** Pin one version across platforms (9.0.x, or 8.1.x if we want a
  release that has been out longer). Wrap it ourselves; we don't need fluent-ffmpeg.

Minimal typed runner with progress (put it in `packages/media-native/src/ffmpeg.ts`):

```ts
import {spawn} from 'node:child_process';

export type FfmpegProgress = {outTimeUs: number; speed: number | null; frame: number | null};

export function runFfmpeg(
  bin: string,
  args: string[],
  opts: {signal?: AbortSignal; onProgress?: (p: FfmpegProgress) => void; cwd?: string} = {},
): Promise<{stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
      cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    let buf = '';
    const cur: Record<string, string> = {};
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        const eq = line.indexOf('='); if (eq < 0) continue;
        cur[line.slice(0, eq)] = line.slice(eq + 1);
        if (line.startsWith('progress=')) {
          opts.onProgress?.({
            outTimeUs: Number(cur.out_time_us ?? cur.out_time_ms ?? 0),
            speed: cur.speed ? parseFloat(cur.speed) : null,
            frame: cur.frame ? Number(cur.frame) : null,
          });
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr = (stderr + c).slice(-64_000); });
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, {once: true});
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      code === 0 ? resolve({stderr}) : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
```

Detector filters (`silencedetect`, `scdet`, `ebur128`, `loudnorm` with `print_format=json`) print their
results to **stderr**. Parse stderr for those, or use `-f null -` with `-loglevel info`.

### 4.2 Node bindings to libav

| Package | Version / activity | License (wrapper / bundled FFmpeg) | Notes | Verdict |
|---|---|---|---|---|
| `fluent-ffmpeg` | 2.1.3. **GitHub archived** 2025-05-22, npm "no longer supported" | MIT / none (uses the system binary) | Command builder only. Stale option names. | **Avoid.** Write the ~100-line runner above. |
| `ffmpeg-static` | 5.3.0 → downloads FFmpeg **6.1.1** at `npm install` (`binary-release-tag: b6.1.1`) | GPL-3.0-or-later | The download at install time breaks offline/CI builds and cross-packaging. Old version. | **Avoid** for shipping. OK for dev scripts. |
| `@ffmpeg-installer/ffmpeg` | 1.1.0 (2022). The linux-x64 subpackage is FFmpeg **4.1** | LGPL label, but the binaries are GPLv3 (johnvansickle builds) | Ancient. | **Avoid.** |
| `beamcoder` | 0.7.1, last push 2023-12 | **GPL-3.0** | Needs system FFmpeg 5 dev libs. Dead. | **Avoid.** |
| `@mmomtchev/ffmpeg` | 2.0.1, active | ISC wrapper. Prebuilt FFmpeg via GitHub releases. | avcpp-based. Node Streams API (`Demuxer → Decoder → Filter → Encoder → Muxer`). Small community. | Watch. Alternative to node-av. |
| **`node-av`** | **6.1.1**, pushed 2026-09-29, ~380★ | MIT wrapper. **Prebuilt `@seydx/node-av-linux-x64` is a 175 MB `.node` statically linking Jellyfin-FFmpeg (libavcodec 62), `--enable-gpl --enable-version3`, x264, x265, fdk-aac, svtav1, dav1d, libplacebo, whisper, vaapi/nvenc/qsv/amf/vulkan.** | Full low-level API (`FormatContext`, `CodecContext`, `Packet`, `Frame`) plus high-level `Demuxer/Decoder/Encoder/FilterAPI`. Typed options generated from FFmpeg metadata. `node-av/ffmpeg` also downloads a matching CLI (`ffmpegPath()`). README claims Electron ABI compatibility with no rebuild, and has electron-builder/forge examples. HW accel needs libva 2.20, so Ubuntu 24.04+. | **Adopt selectively** for in-process frame access, e.g. frame-accurate scrubbing server, zero-copy thumbnails, `@mediabunny/server`. **Build from source against our own LGPL FFmpeg**, or accept GPLv3 for the process. |
| `@mediabunny/server` | 1.61.0. Depends on `node-av ^6` and `@mediabunny/prores` | MPL-2.0 (+ node-av as above) | `registerMediabunnyServer()` polyfills WebCodecs-like decoders/encoders (AVC, HEVC, VP8/9, AV1, ProRes, AAC, MP3, Opus, FLAC, AC-3) in Node/Bun/Deno. Lets the **same** mediabunny code from `extract-frames.ts` / `load-waveform-peaks.ts` run in the daemon. | **Adopt** for code sharing between web and desktop, with the same license caveat. |
| `@ffmpeg/ffmpeg` + `@ffmpeg/core(-mt)` (ffmpeg.wasm) | 0.12.15 / core 0.12.10. Wrapper repo active, **no core release since Jan 2025** | MIT wrapper. Core is **GPL-2.0+** (includes x264). | Core ~30 MB wasm. Single-thread by default. `core-mt` needs SharedArrayBuffer, so COOP/COEP headers (these conflict with some third-party embeds). Roughly 10 to 25x slower than native, and there is a 2 GB wasm memory ceiling. | **Last-resort browser fallback only** (e.g. stream-copy remux of a codec WebCodecs can't handle). Prefer mediabunny for web. |

### 4.3 Remotion's own media stack (already in the repo)
- **`@remotion/compositor-<platform>`** (pulled in by `@remotion/renderer`): a Rust `remotion` binary plus
  **FFmpeg n7.1 shared libs**. I checked `@remotion/compositor-linux-x64-gnu@4.0.499`, whose build is
  `--enable-gpl`, `--enable-libfdk-aac`, `--disable-filters` plus ~30 whitelisted filters (`atrim`,
  `concat`, `loudnorm`, `zscale`, `tonemap`, `silencedetect`, `palettegen`…), selected demuxers only (no
  MXF, no MPEG-TS demux), decoders limited to h264/hevc/vp8/vp9/av1(dav1d)/prores/mjpeg/png/gif/aac/mp3/
  opus/pcm. Encoders: libx264, libx265, libaom-av1, libvpx, prores_ks, h264/hevc_nvenc, aac/fdk_aac, opus,
  mp3. **It can't serve as our general engine** (no DNxHD/CineForm/XDCAM/MXF ingest, no lut3d, no scdet,
  no ebur128, no drawtext). Remotion uses it for `<OffthreadVideo>` frame extraction and final muxing.
- **`@remotion/media`** (`<Video>`/`<Audio>`, used in `video-layer.tsx` behind `FEATURE_NEW_MEDIA_TAGS`):
  mediabunny + WebCodecs playback in the Player and in `@remotion/web-renderer`.
- **`@remotion/web-renderer`** (`renderMediaOnWeb`, used in `render-state.ts`): in-browser export via
  WebCodecs. Good for "quick export" in the web/PWA without a daemon.
- **`@remotion/install-whisper-cpp`**: `installWhisperCpp()`, `downloadWhisperModel()`, `transcribe()`,
  `toCaptions()`. Produces `@remotion/captions` `Caption[]`, the type stored in `CaptionAsset.captions`
  (`src/editor/assets/assets.ts`).
- **Verdict:** keep Remotion for React motion graphics, the Player, and rendering *graphics layers*. Use
  our own FFmpeg for all media-engineering work.

### 4.4 Mediabunny + WebCodecs (browser-native)
- **Best at:** in-browser demux/mux (MP4, MOV, WebM, MKV, HLS, WAV, MP3, Ogg, ADTS, FLAC, MPEG-TS),
  decode/encode through WebCodecs (HW accelerated), the `Conversion` API (transmux, transcode, resize,
  crop, trim, resample), sample-accurate `VideoSampleSink`/`AudioSampleSink`. Pure TS, zero deps,
  tree-shakable.
- **License:** MPL-2.0. **Packaging:** none (JS). **Maturity:** very active (1.61.0, pushed today, ~7.2k★).
  Remotion has standardized on it.
- **Limits:** only what WebCodecs supports. Chromium can't do ProRes/DNxHD/CineForm (mediabunny has a
  `@mediabunny/prores` wasm decoder) or HEVC everywhere. No filter graph (no LUT/loudnorm/scdet). Heavy
  jobs compete with the UI thread unless run in a Worker.
- **Verdict: ADOPT** as the browser engine and as the shared API (via `@mediabunny/server` on desktop).
  Bump 1.50.8 → 1.6x together with the Remotion upgrade (Remotion pins mediabunny).

### 4.5 MLT Framework (`melt`)
- **Best at:** a complete timeline engine. MLT XML describes multitrack playlists, transitions (luma
  wipes, `composite`/`qtblend`, mix), filters (frei0r, LADSPA, movit GPU, `avfilter.*`, keyframeable
  properties), plus a producer/consumer model with real-time preview. It powers Shotcut and Kdenlive.
  `melt project.mlt -consumer avformat:out.mp4 vcodec=libx264` renders a whole edit.
- **License:** core `libmlt`/`libmlt++` LGPL-2.1. **Many modules are GPL** (`plusgpl`, `qt`, `kdenlive`,
  `vid.stab`, frei0r plugins), and it links FFmpeg (usually GPL).
- **Packaging:** heavy. `melt` + `libmlt` + ~20 module `.so`/`.dll`/`.dylib` + FFmpeg + frei0r +
  (optionally) Qt for text/image producers, with env vars `MLT_REPOSITORY`, `MLT_DATA`, `MLT_PROFILES_PATH`.
  Shotcut's portable bundles show this works, but it's around 150 to 300 MB and has platform quirks
  (macOS framework relocation). **Not installed here.**
- **Maturity:** high (v7.40.0, 2026-06). No maintained Node bindings, so it has to run as a CLI.
- **Verdict: DON'T ADOPT as the export engine for v1.** Our timeline model (Remotion items with arbitrary
  React layers) doesn't map onto MLT, and FFmpeg filtergraphs + Remotion overlays cover the export (see
  section 6). Keep it in mind as **an interchange target**: `otio-mlt-adapter` 0.3.0 and auto-editor's
  `--export shotcut` both produce `.mlt`.

### 4.6 GStreamer (+ GES, GStreamer Editing Services)
- **Best at:** real-time pipelines (capture, streaming, WebRTC, low-latency playback), plugin
  architecture, HW decode on embedded targets. **GES** adds timelines, layers, clips, transitions,
  effects, and `.xges` project files (Pitivi uses it). `gstreamer-rs` / `gstreamer-editing-services` Rust
  crates are 0.25.4 and well maintained.
- **License:** core, base, good, GES are LGPL-2.1+. **ugly** (x264enc) and some **bad** plugins are
  GPL/patent-encumbered.
- **Packaging:** the heaviest option. The runtime is 100 to 300 MB with a plugin registry cache
  (`GST_PLUGIN_PATH`, `GST_REGISTRY`), macOS/Windows use the official framework/MSI installers or
  relocatable bundles, and Node bindings are stale (`gstreamer-superficial` 1.7.4, 2022). Here the shared
  libs exist but there are no CLI tools and no GES.
- **Verdict: SKIP.** It overlaps with FFmpeg for our file-based work, and packaging costs a lot more.
  Reconsider only for live capture/streaming features (and even then FFmpeg/node-av handle v4l2,
  avfoundation and dshow).

### 4.7 OpenCV
- **Best at:** computer vision. Object tracking (CSRT/KCF/Nano/ViT trackers) for motion tracking and
  "stick text to object", face/person detection for **auto-reframe** (16:9 → 9:16), optical flow, feature
  matching for stabilization, DNN module (ONNX) for segmentation/background removal.
- **License:** Apache-2.0 (since 4.5). Core libs 4.6 are present on this machine. `opencv-python-headless`
  5.0.0.93 installs from pip.
- **Packaging:** native bindings for Node are unmaintained (`opencv4nodejs` 5.6.0 from 2022,
  `@u4/opencv4nodejs` 7.1.2 from 2024) and need a per-platform OpenCV build. Better routes: the Rust
  `opencv` crate 0.101 (active) inside a Rust sidecar/N-API module; `@techstark/opencv-js` 5.0.0 (wasm,
  Apache-2.0) in a worker; or the Python sidecar.
- **Verdict: LATER.** Adopt when we build tracking or reframing. Run it via a Rust sidecar (it can share
  the toolchain with fframes) or opencv.js in a worker. It doesn't belong in the core cut/export path.

### 4.8 libvips / sharp
- **Best at:** fast, low-memory still-image processing (resize, crop, composite, format conversion,
  sprite sheets), streaming and demand-driven.
- **License:** `sharp` is Apache-2.0. Its prebuilt `@img/sharp-libvips-*` is **LGPL-3.0-or-later**
  (dynamic, fine).
- **Packaging:** easy. Prebuilt per platform, Electron supported (`asarUnpack` `**/node_modules/@img/**`,
  `**/node_modules/sharp/**`).
- **Maturity:** very high (sharp 0.35.5, ~33k★).
- **Verdict: ADOPT for image assets only.** Use it for image-asset thumbnails, poster frames → WebP/AVIF,
  and assembling filmstrip sprites if we decode frames in-process. It isn't a video tool, and ffmpeg's
  `tile` filter already makes filmstrips.

### 4.9 frei0r, LADSPA, LV2 (effect plugin APIs)
- **frei0r:** a video effect plugin API. ~130 plugins, **GPL-2** (the API header is public domain, most
  plugins are GPL). Used through ffmpeg `-vf frei0r=filter_name:params` (needs `--enable-frei0r`, which is
  GPL). Plugins aren't installed on this box. Most effects (blur, glow, distort, color) are better as
  Remotion/WebGL layers or native ffmpeg filters.
- **LADSPA / LV2:** audio plugin APIs (LGPL/ISC APIs, mixed-license plugins: SWH, Calf, LSP, x42).
  ffmpeg's `ladspa`/`lv2` filters are enabled in the system build, and BtbN builds include `lilv`.
- **Verdict: OPTIONAL / LATER.** Implementing a "Premiere Effects panel" as a curated list of ffmpeg
  filters (and Remotion effects for the preview) is simpler than plugin hosting. If we want third-party
  audio plugins, **LV2 via ffmpeg `lv2`** is the path. VST3 hosting needs a real host
  implementation. Historically the VST3 SDK was GPLv3 or proprietary, and it was reportedly relicensed to
  MIT in late 2025, but verify that before relying on it.

### 4.10 OpenFX (OFX) host
- The OFX API (BSD) is what Resolve, Nuke, Vegas, Natron and Flame use for effect plugins (Boris FX,
  RE:Vision, Neat Video). A host means implementing image effect suites, parameter UI, tiling, render
  threads and GPU contexts. Natron's host plus openfx-misc/io (GPL) is the only open reference.
- **Verdict: SKIP.** Many months of work, and it conflicts with the Remotion/React effect model. Revisit
  only if pro-plugin support becomes a selling point.

### 4.11 VapourSynth / AviSynth+
- Frame-server scripting (Python for VapourSynth R80, LGPL-2.1; AVS script for AviSynth+, GPL-2 with a
  linking exception). Excellent for restoration (QTGMC deinterlace, denoise, IVTC), and ffmpeg can read
  them (`-f vapoursynth`, `-f avisynth`).
- **Packaging:** needs an embedded Python runtime plus plugins. Mostly Windows-centric community.
- **Verdict: SKIP.** The ffmpeg filters we need (`bwdif`/`yadif`, `nlmeans`, `hqdn3d`, `vidstab`,
  `minterpolate`) cover a consumer/prosumer editor.

### 4.12 OpenTimelineIO (OTIO), which matters most for "Premiere-like"
- **Best at:** an editorial interchange data model (Timeline → Stack → Track → Clip/Gap/Transition, media
  references, effects like `LinearTimeWarp`/`FreezeFrame`, markers, metadata) with adapters to other
  NLEs. Academy Software Foundation project, **Apache-2.0**, v0.18.1.
- **Adapters (0.17+ split them into plugins, `pip install OpenTimelineIO-Plugins`):**
  - `fcp_xml` (FCP7 XML / **xmeml**): Premiere Pro's main XML import/export, also Resolve/Avid.
    **Tested OK** (write + read back, 3 tracks / 4 clips).
  - `cmx_3600` (**EDL**): one video track per EDL. Handles reel names up to 8 chars (OTIO truncates and
    adds `* FROM CLIP NAME` / `* FROM CLIP` comments). **Tested OK.**
  - `AAF` (via `pyaaf2`, for Avid/Premiere/Resolve): the writer needs mob IDs.
    `write_to_file(tl, 'x.aaf', adapter_name='AAF', use_empty_mob_ids=True)` **worked** (487 KB) and read
    back 3 tracks / 4 clips. Without that option it fails with `Cannot find mob ID for clip`.
  - separate pip packages: `otio-fcpx-xml-adapter` 1.0.0 (FCPXML), `otio-kdenlive-adapter` 0.0.3,
    `otio-mlt-adapter` 0.3.0, `otio-xges-adapter` (GES), `otio-ale-adapter`.
  - DaVinci Resolve (18.5+) imports and exports `.otio` natively. For Premiere, **FCP7 XML is the reliable
    path**, so check current Premiere release notes before promising native OTIO.
- **JS/TS side:** `opentimelineio` on npm is deprecated and renamed to `otio.js` 0.1.0 (third-party,
  Apache-2.0, immature). Rust `opentimelineio` crate is a 2020 placeholder. The C++ core
  (`libopentimelineio`) exists, but **all file-format adapters are Python**.
- **Packaging:** we need Python. Options: (a) require a system Python and create a venv on first use,
  (b) bundle a relocatable CPython (python-build-standalone, ~30 MB) with a pre-installed site-packages,
  (c) freeze a small `jasper-otio` CLI with PyInstaller per platform (~25 to 40 MB).
- **Verdict: ADOPT.**
  1. Write `.otio` JSON **natively in TS** (the schema is simple, see section 7). It becomes our canonical
     interchange/export and agent-readable format.
  2. Ship a frozen `jasper-otio` sidecar (option c) that wraps `otioconvert` for FCP7 XML / EDL / AAF /
     FCPXML import and export.
  3. Later, if Python becomes a problem, port the FCP7 XML and EDL writers to TS. Both are
     small, well-specified text formats. AAF stays in Python.

### 4.13 OpenColorIO (OCIO) + LUTs
- **OCIO** (BSD-3, v2.5.2; lib 2.1 installed here): color management (ACES, camera log → Rec.709,
  display/view transforms). `ociobakelut` bakes any OCIO transform into a `.cube`.
- **FFmpeg:** `lut3d=file=x.cube:interp=tetrahedral` (also `.3dl`, `.dat`, `.m3d`, `.csp`), `lut1d`,
  `haldclut`. `zscale` (zimg) for accurate primaries/transfer/matrix conversion. `ocio` filter in
  **FFmpeg >= 8.1**. Verified: lut3d with a 17³ cube on 10 s of 1080p plus x264 veryfast took 5.8 s under
  load.
- **Preview:** the Remotion Player is DOM/WebGL, so apply the same `.cube` in a WebGL fragment shader
  (a 3D texture, or a 2D atlas for WebGL1) on the preview canvas for WYSIWYG. The browser can't use OCIO
  directly. Bake to `.cube` first.
- **Verdict: ADOPT the LUT workflow.** It's how Premiere's Lumetri "Input LUT / Creative Look" works. Use
  OCIO only offline (bake LUTs in CI, or via the `ocio` filter when we ship FFmpeg 8.1+). Full ACES color
  management can come later.

### 4.14 libplacebo
- GPU (Vulkan) renderer from the mpv author (LGPL-2.1): best-in-class scaling, **HDR→SDR tone mapping**,
  debanding, and color-space conversion. Available as ffmpeg `libplacebo` filter (system build has it).
- **Needs Vulkan.** No GPU here. It technically runs on lavapipe (Mesa CPU Vulkan) but slowly.
- **Verdict: OPTIONAL.** Use when a GPU is present (HDR iPhone/HLG footage tone mapping). CPU fallback:
  `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`.

### 4.15 Rust crates (for a native sidecar or N-API module, shared with fframes)

| Crate | Version | Use | Verdict |
|---|---|---|---|
| `ffmpeg-next` / `ffmpeg-sys-next` | 9.0.0 (supports FFmpeg up to 8.x/9.x) | Safe-ish libav wrapper, most used | Use if we build a Rust media sidecar |
| `ffmpeg-the-third` | 6.0.0+ffmpeg-9.0 | FFmpeg 5+ fork of ffmpeg-next | Alternative |
| `rsmpeg` | 0.18.0+ffmpeg.8.0 | Thin, close-to-C | Alternative |
| `ez-ffmpeg` / `video-rs` / `ffmpeg-sidecar` | 0.19 / 0.12 / 2.5.2 | High level / CLI wrapper | `ffmpeg-sidecar` is handy for Rust→CLI |
| `gstreamer`, `gstreamer-editing-services` | 0.25.4 | See 4.6 | Skip |
| `rav1e` | 0.8.1 (BSD-2) | AV1 encoder in Rust, slower than SVT-AV1 | Use SVT-AV1 via ffmpeg instead |
| `image`, `resvg`, `tiny-skia` | 0.25 / 0.48 / 0.12 | Image codecs, SVG raster (fframes' stack) | Via fframes |
| `opencv` | 0.101 | See 4.7 | Later |
| `whisper-rs` | 0.16 | whisper.cpp bindings | Only if we build a Rust sidecar |
| `symphonia`, `rubato`, `ebur128` | 0.6 / 5.0 / 0.1.10 | Pure-Rust audio decode, resample, R128 | Useful for a Rust audio-analysis worker |
| `napi` (napi-rs) | 3.13 | Rust → Node addon | For the fframes bridge |

**fframes** (MIT, crate 1.0.3, very active) **statically links FFmpeg's libav** (it downloads a prebuilt
FFmpeg or builds one with `FFMPEG_FORCE_BUILD=1`). Its effective license therefore follows that FFmpeg
config. Align its FFmpeg build with ours (same version, same LGPL/GPL choice) so we don't ship two
different libav stacks with different license postures. Its README says the Skia backend is GPU (Metal or
Vulkan) and `--backend cpu` is the slower CPU path. That is relevant on no-GPU machines like this one.

### 4.16 auto-editor (silence cutting)
- **Best at:** automatic jump cuts from audio loudness (`--edit audio:threshold=0.04`), motion, or
  combinations; margins; speed changes for silent parts. It exports **edit lists**, not just renders.
- **License:** Unlicense. Since v27 it's a **single native binary** (Nim). The pip wheel downloads
  `auto-editor-linux-x86_64` (41 MB) from GitHub releases on first run.
- **Verified exports** (v29.3.1): `--export premiere` (xmeml v5), `resolve`/`final-cut-pro` (FCPXML),
  `shotcut` (MLT), `kdenlive`, `v1`/`v3` (JSON). **`v3` JSON maps 1:1 to our items:**
  ```json
  {"version":"3","timebase":"30/1","resolution":[1920,1080],"samplerate":16000,
   "v":[],"a":[[{"name":"audio","src":"speech.wav","start":0,"dur":557,"offset":0,"stream":0},
                {"name":"audio","src":"speech.wav","start":557,"dur":557,"offset":648,"stream":0}]]}
  ```
  `start` = timeline frame (→ `item.from`), `dur` = frames (→ `durationInFrames`), `offset` = source frame
  (→ `videoStartFromInSeconds * fps`).
- **Verdict: OPTIONAL power tool.** Ship ffmpeg `silencedetect`-based cutting as the built-in feature
  (section 5.8). Offer auto-editor for motion-based edits or as an agent tool. It's easy to bundle (one
  binary per platform), but it adds 40 MB.

### 4.17 PySceneDetect / ffmpeg scene detection
- **ffmpeg `scdet`** (`lavfi.scd.score`, `lavfi.scd.time` in stderr), and
  `select='gt(scene,0.3)',showinfo` (the `pts_time:` lines). Verified: both found the cuts at 5 s and 10 s
  exactly; 0.4 s for 15 s of 720p.
- **PySceneDetect** 0.7.1 (BSD-3, OpenCV-based): `detect-adaptive` (best general), `detect-content`,
  `detect-threshold` (fades), `detect-hash`, plus `split-video` and `save-images`. Verified: same cut list
  in 1.6 s. Needs Python + OpenCV (~70 MB wheel).
- **Verdict:** use **ffmpeg `scdet`** built in (no Python). Offer PySceneDetect in the Python sidecar for
  higher-quality adaptive detection and fade detection. For both, merge with keyframe positions to
  suggest "cut here" markers.

### 4.18 whisper.cpp (local transcription)
- **Best at:** offline ASR with word-level timestamps. MIT. v1.9.4 (2026-09-11). It now also ships
  `parakeet-cli` (NVIDIA Parakeet TDT models) and Silero **VAD** (`--vad`). Models are ggml
  (`tiny` 75 MB … `large-v3-turbo` ~1.6 GB). Quantized `q5_0`/`q8_0` variants are smaller and faster.
- **Build:** `cmake -B build && cmake --build build -j` took about 90 s here and produced `whisper-cli`,
  `whisper-server` (HTTP), `whisper-bench`, `libwhisper.so`, and `libggml-*.so` (CPU AVX2, OpenMP).
- **Measured** (65 s of flite TTS speech, `ggml-base.en`, load avg ~9):

  | Flags | Wall |
  |---|---|
  | `-t 6` (beam 5 default) | 6.1 s |
  | `-t 8 -bs 1 -bo 1` (greedy) | 3.5 s |
  | `-t 12 -bs 1 -bo 1` | 3.0 s |
  | `-t 12 --vad --vad-model ggml-silero-v6.2.0.bin` | 5.2 s |
  | first cold run `-t 12` | 41 s (page cache / contention, ignore) |

  `-ojf` (full JSON) gives per-token `{text, timestamps:{from,to}, offsets:{from,to}(ms), p}`, which is
  enough to build `Caption[]` (`@remotion/captions`: `{text, startMs, endMs, timestampMs, confidence}`).
- **Integration options:**
  1. `@remotion/install-whisper-cpp`: downloads/builds whisper.cpp and models, `transcribe({inputPath,
     whisperPath, model, tokenLevelTimestamps: true})`, then `toCaptions()`. Fastest path, and it emits
     exactly the starter's caption type. Input must be **16 kHz mono WAV**
     (`ffmpeg -i in -vn -ac 1 -ar 16000 -c:a pcm_s16le out.wav`).
  2. Our own prebuilt `whisper-cli` per platform in `extraResources` (build in CI; avoids needing a
     compiler on user machines, which option 1 requires on Linux).
  3. FFmpeg 8.0+ `whisper` audio filter (BtbN and node-av builds include it) does transcription inside
     the ffmpeg graph and outputs SRT/JSON. Convenient, but gives less control (no word-level JSON).
  4. Browser/PWA: `@remotion/whisper-web` (whisper.cpp → wasm). Much slower. Keep the OpenAI API route
     (`src/routes/api/captions.ts`) as the cloud option.
- **Verdict: ADOPT** (option 2, with option 1's `toCaptions` logic). Default model `base.en` or
  `small`/`large-v3-turbo-q5_0` for quality. Always run the VAD for long files.

### 4.19 Rubber Band / SoundTouch (audio time-stretch, pitch)
- **Rubber Band** (GPL-2 **or commercial license** from Breakfast Quay): the best quality ("R3/finer"
  engine), formant preservation. ffmpeg filter `rubberband=tempo=…:pitch=…` needs `--enable-librubberband`
  (GPL). Browser: `rubberband-wasm` (GPLv2).
- **SoundTouch** (LGPL-2.1): WSOLA, lower quality, lightweight. `soundtouchjs` (LGPL) and
  `@soundtouchjs/audio-worklet` (MPL-2.0) for the browser. The system lib is installed.
- **ffmpeg `atempo`** (LGPL, built in): range 0.5 to 100 per instance (chain for <0.5). Decent quality for
  speech/music at moderate rates, no pitch control.
- **Verdict:** `atempo` for the default "Speed/Duration" (Premiere's Ctrl+R) with pitch preserved. Add
  `rubberband` for the "high-quality" toggle and pitch shift if we ship the GPL FFmpeg. Browser preview
  keeps using `playbackRate` on the media element (the Remotion Player already does this via
  `get-item-playback-rate.ts`).

### 4.20 Loudness: `loudnorm` / `ebur128`
- `ebur128=peak=true` gives integrated/short-term/momentary LUFS, LRA and true peak (stderr summary). Took
  2.2 s for 60 s here.
- `loudnorm` (EBU R128). **Always two-pass** for export: pass 1 prints JSON (`input_i`, `input_tp`,
  `input_lra`, `input_thresh`, `target_offset`), pass 2 applies it with `linear=true` (no pumping). Verified
  pass-1 JSON output (section 5.9).
- Targets: YouTube/streaming -14 LUFS, podcasts -16, broadcast EBU R128 -23, ATSC A/85 -24. TP -1 dBTP.
- **Verdict: ADOPT.** Put a loudness meter in the audio panel (ebur128 per clip, cached) and a
  "Normalize to…" export option (two-pass loudnorm on the final mix).

### 4.21 Waveform helpers
- `bbc/audiowaveform` (GPL-3, C++, produces `.dat`/`.json` peaks for peaks.js). GPL CLI, one more binary.
- `waveform-data` / `peaks.js` (LGPL-3): display side.
- **Verdict:** not needed. `ffmpeg -ac 1 -ar <rate> -f f32le pipe:1` plus a tiny TS reducer produces the
  same `Float32Array` peaks the starter already renders (section 5.5). Keep the mediabunny path in the
  browser.

---

## 5. Recipes (tested with system ffmpeg 6.1.1; timings are for 60 s 1080p30 H.264 `src.mp4` under load)

### 5.1 Probe
```bash
ffprobe -v error -print_format json -show_format -show_streams -show_chapters in.mov
# keyframe times (for snapping lossless cuts). Decodes only keyframes, so it's fast
ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 in.mp4
# (src.mp4: 0.000000, 2.000000, 4.000000, ...)
```
Probe on import. Store the codec, pix_fmt, color_primaries/transfer/space, rotation (side data), VFR
flag (`r_frame_rate` != `avg_frame_rate`), audio layout, and timecode tag on the asset (extend
`VideoAsset` in `src/editor/assets/assets.ts`).

### 5.2 Fast lossless cut (stream copy): 0.20 s for a 20 s cut
```bash
ffmpeg -ss 12.3 -i src.mp4 -t 20 -map 0 -c copy -avoid_negative_ts make_zero cut.mp4
```
- The cut starts at the **keyframe before 12.3** (the output then carries an edit list / negative-ts
  lead-in that some players ignore). For frame-exact starts, either snap the UI in-point to keyframes
  (from 5.1) or **smart-cut**: re-encode `[in, nextKeyframe)` with a matching codec config, stream-copy
  `[nextKeyframe, out]`, and join with the concat demuxer. This is fragile with x264 (SPS/PPS must match),
  so treat it as "experimental" the way LosslessCut does.
- Joining same-codec segments: `ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`.
- Good for: "Export selection (lossless)", splitting long recordings, trimming uploads before transcription.

### 5.3 Proxies (Premiere "Create Proxies")
Proxies must be decodable **in the browser** (the Player uses WebCodecs / `<video>`), so ProRes/DNxHR
proxies (Premiere's defaults) are the wrong fit. Use short-GOP H.264:
```bash
# 720p, GOP 15 (scrub-friendly), fast decode, moov at front: 6.7 s for 60 s
ffmpeg -i src.mp4 -vf "scale=-2:720" -c:v libx264 -preset veryfast \
  -x264-params keyint=15:min-keyint=15:scenecut=0 -crf 26 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart proxy720.mp4
# 540p ultrafast/fastdecode: ~9 s
ffmpeg -i src.mp4 -vf "scale=-2:540:flags=fast_bilinear" -c:v libx264 -preset ultrafast -tune fastdecode -g 15 -crf 28 -an proxy540.mp4
```
Comparison on the same input: ProRes Proxy 540p took 24 s (79 MB), MJPEG 7 s (47 MB), x264 ultrafast
13 s (16 MB, first run, heavier load). For the LGPL option, use `h264_videotoolbox`/`h264_mf`/`h264_vaapi`
or `libopenh264`. Keep the proxy fps equal to the source, preserve rotation metadata, and tonemap
HDR→SDR for proxies (section 4.14). Store a `proxyUrl` next to `remoteUrl` on the asset and let
`usePreferredLocalUrl` pick it.

### 5.4 Thumbnails / filmstrips
```bash
# keyframes only: 0.42 s for 60 s. One 20-tile strip, 160 px wide each
ffmpeg -skip_frame nokey -i src.mp4 -vf "scale=160:-2,tile=20x1" -fps_mode vfr -frames:v 1 strip.jpg
# evenly spaced (every 3 s): 1.7 s
ffmpeg -i src.mp4 -vf "fps=1/3,scale=160:-2,tile=20x1" -frames:v 1 strip.jpg
# single poster at t (input seek = fast)
ffmpeg -ss 12.5 -i src.mp4 -frames:v 1 -vf scale=320:-2 -q:v 3 poster.jpg
# "representative" frame
ffmpeg -i src.mp4 -vf "thumbnail=90,scale=320:-2" -frames:v 1 rep.jpg
```
Serve the sprite plus a JSON index `{tileWidth, tileHeight, timestamps[]}` to the timeline. The current
`timeline-item-film-strip` decodes per visible slot with mediabunny, which should remain the zoomed-in
path.

### 5.5 Waveform peaks
```bash
# raw mono f32 at 8 kHz straight to stdout: 0.24 s for 60 s (s16 variant verified; f32le equivalent)
ffmpeg -i src.mp4 -vn -ac 1 -ar 8000 -f f32le pipe:1
# or a quick PNG for previews (0.22 s)
ffmpeg -i src.mp4 -filter_complex "showwavespic=s=1920x120:split_channels=0" -frames:v 1 wave.png
```
TS reducer that matches `loadWaveformPeaks` (100 peaks/s, max-abs):
```ts
export function reducePeaks(pcm: Float32Array, sampleRate: number, peaksPerSecond = 100): Float32Array {
  const spp = Math.max(1, Math.floor(sampleRate / peaksPerSecond));
  const out = new Float32Array(Math.ceil(pcm.length / spp));
  for (let i = 0, p = 0; i < pcm.length; i += spp, p++) {
    let m = 0; const end = Math.min(pcm.length, i + spp);
    for (let j = i; j < end; j++) { const a = Math.abs(pcm[j]); if (a > m) m = a; }
    out[p] = m;
  }
  return out;
}
```
Cache the peaks as a binary `.f32` in the media cache and serve them to the web client (much cheaper than
decoding a whole file in the browser for hour-long media).

### 5.6 Scene detection
```bash
ffmpeg -i in.mp4 -vf "scdet=threshold=10" -f null -   # stderr: lavfi.scd.score: 27.593, lavfi.scd.time: 5
ffmpeg -i in.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep -oE 'pts_time:[0-9.]+'
# faster on big files: downscale first
ffmpeg -i in.mp4 -vf "scale=320:-2,scdet=threshold=10" -an -f null -
```

### 5.7 Transcription input
```bash
ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le /tmp/x.wav
whisper-cli -m ggml-base.en.bin -f /tmp/x.wav -t 8 -bs 1 -bo 1 -ojf -of /tmp/x \
  --vad --vad-model ggml-silero-v6.2.0.bin      # -> /tmp/x.json (tokens with ms offsets)
```

### 5.8 Silence detection → cut list (built-in "Remove silences")
```bash
ffmpeg -i speech.wav -af "silencedetect=noise=-35dB:d=0.5" -f null -
# [silencedetect] silence_start: 18.4254
# [silencedetect] silence_end: 21.8166 | silence_duration: 3.39125
```
Invert the silence intervals into keep-ranges, pad each keep-range by a margin (e.g. 0.15 s), merge
overlaps, then emit one `VideoItem` per range (same `assetId`, consecutive `from`,
`videoStartFromInSeconds = range.start`). Better thresholds come from `ebur128` short-term loudness,
relative to the clip's integrated loudness.

### 5.9 Loudness
```bash
# measure
ffmpeg -i mix.wav -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -
# -> {"input_i":"-21.75","input_tp":"-17.90","input_lra":"0.00","input_thresh":"-31.75","target_offset":"0.05",...}
# apply (pass 2, linear)
ffmpeg -i mix.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-21.75:measured_TP=-17.90:measured_LRA=0.00:measured_thresh=-31.75:offset=0.05:linear=true" -ar 48000 out.wav
```
Note: loudnorm resamples internally to 192 kHz, so always set `-ar 48000` on the output.

### 5.10 LUT / color
```bash
ffmpeg -i in.mp4 -vf "lut3d=file=look.cube:interp=tetrahedral" -c:v libx264 -crf 18 out.mp4
# log camera footage: input LUT first, then creative look (Lumetri order)
-vf "lut3d=file=slog3_to_709.cube,lut3d=file=teal_orange.cube"
# explicit color tagging on export (avoid washed-out results in browsers/QuickTime)
-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
```

### 5.11 Audio time-stretch
```bash
-af "atempo=1.5"                         # LGPL, 0.5..100 per instance
-af "atempo=0.5,atempo=0.8"              # 0.4x
-af "rubberband=tempo=0.4:pitchq=quality" # GPL builds only, better quality
```

---

## 6. Final export of an edit decision list (native path)

The editor state (`src/editor/state/types.ts` → `UndoableState {tracks, items, assets, fps,
compositionWidth, compositionHeight}`) contains two kinds of items:

- **Media items** (`video`, `audio`, `image`, `gif`): expressible as FFmpeg filtergraph ops (trim,
  setpts, scale/crop/rotate, overlay at `left/top/width/height`, opacity, fades, volume
  `decibelAdjustment`, `playbackRate`).
- **Graphics items** (`text`, `solid`, `captions`, plus anything React/Remotion/fframes renders).

Recommended **hybrid export**:
1. Render graphics layers with Remotion (`renderMedia` locally, or `renderMediaOnWeb`) or fframes into an
   **alpha intermediate**: ProRes 4444 (`prores_ks -profile:v 4 -pix_fmt yuva444p10le`), VP9 with alpha
   (`yuva420p` WebM), or a PNG sequence. Only render the time ranges that contain graphics.
2. Composite everything natively in one ffmpeg filtergraph: media items from the original sources (or
   proxies for drafts), graphics intermediates as overlays, audio mixed with `amix`, and optional two-pass
   loudnorm and LUTs.
3. If an export has no graphics, skip step 1. If it's "all graphics", use Remotion's renderer alone.

Z-order: `tracks[0]` is the **top** layer (`src/editor/canvas/layers.tsx` renders
`tracks.slice().reverse()`), so iterate tracks in reverse when chaining overlays.

Verified prototype (Python generator in `/tmp/jasper-research/native-video-libs/bench/edl_export.py`,
3 tracks: base clip, PiP overlay, gap, second clip at -6 dB, music bed at -12 dB). It rendered a correct
10 s 1080p file in 8.5 s, and the frames at 1/3/5/8 s show base / PiP / black gap / second clip as expected.
The generated graph looks like this:

```
color=c=black:s=1920x1080:r=30:d=10.0[base];
[1:v]trim=start=12.3:duration=5.0,setpts=PTS-STARTPTS+0.0/TB,fps=30,scale=1920:1080,format=yuva420p[v1];
[base][v1]overlay=x=0:y=0:eof_action=pass:enable='between(t,0.0,5.0)'[o1];
[1:a]atrim=start=12.3:duration=5.0,asetpts=PTS-STARTPTS,aresample=48000,volume=0dB,adelay=0:all=1[a1];
... (one block per item, bottom track first) ...
[a0][a1][a2]amix=inputs=3:normalize=0:duration=longest,atrim=duration=10.0[aout]
```

TS sketch for `packages/media-native/src/export-graph.ts`:

```ts
import type {UndoableState} from '../../editor/state/types'; // adjust path in the monorepo

type Built = {args: string[]};

export function buildExportArgs(s: UndoableState, out: string, opts: {crf?: number} = {}): Built {
  const {fps, compositionWidth: W, compositionHeight: H} = s;
  const totalFrames = Math.max(0, ...Object.values(s.items).map((i) => i.from + i.durationInFrames));
  const T = totalFrames / fps;
  const args: string[] = [];
  const fc: string[] = [`color=c=black:s=${W}x${H}:r=${fps}:d=${T}[base]`];
  const amix: string[] = [];
  let last = 'base';
  let n = 0;

  for (const track of s.tracks.slice().reverse()) {          // bottom → top
    if (track.hidden) continue;
    for (const id of track.items) {
      const it = s.items[id];
      if (it.type !== 'video' && it.type !== 'audio') continue; // graphics handled via alpha intermediates
      const asset = s.assets[it.assetId];
      const rate = it.playbackRate || 1;
      const srcStart = it.type === 'video' ? it.videoStartFromInSeconds : it.audioStartFromInSeconds;
      const t0 = it.from / fps;
      const d = it.durationInFrames / fps;                    // timeline duration
      // one input per item with input seeking: avoids decoding each file from 0
      args.push('-ss', String(srcStart), '-t', String(d * rate), '-i', localPath(asset));
      const i = n;
      if (it.type === 'video') {
        const fade = [
          it.fadeInDurationInSeconds > 0 ? `fade=t=in:st=0:d=${it.fadeInDurationInSeconds}:alpha=1` : '',
          it.fadeOutDurationInSeconds > 0 ? `fade=t=out:st=${d - it.fadeOutDurationInSeconds}:d=${it.fadeOutDurationInSeconds}:alpha=1` : '',
        ].filter(Boolean).join(',');
        fc.push(
          `[${i}:v]setpts=(PTS-STARTPTS)/${rate},fps=${fps},` +
          `scale=${Math.round(it.width)}:${Math.round(it.height)},format=yuva420p` +
          (it.opacity < 1 ? `,colorchannelmixer=aa=${it.opacity}` : '') +
          (fade ? `,${fade}` : '') +
          `,setpts=PTS+${t0}/TB[v${i}]`,
          `[${last}][v${i}]overlay=x=${Math.round(it.left)}:y=${Math.round(it.top)}:eof_action=pass:enable='between(t,${t0},${t0 + d})'[o${i}]`,
        );
        last = `o${i}`;
      }
      const hasAudio = it.type === 'audio' || (asset.type === 'video' && asset.hasAudioTrack);
      if (hasAudio && !track.muted) {
        fc.push(
          `[${i}:a]asetpts=PTS-STARTPTS,${atempoChain(rate)}aresample=48000,volume=${it.decibelAdjustment}dB,` +
          (it.audioFadeInDurationInSeconds > 0 ? `afade=t=in:d=${it.audioFadeInDurationInSeconds},` : '') +
          (it.audioFadeOutDurationInSeconds > 0 ? `afade=t=out:st=${d - it.audioFadeOutDurationInSeconds}:d=${it.audioFadeOutDurationInSeconds},` : '') +
          `adelay=${Math.round(t0 * 1000)}:all=1[a${i}]`,
        );
        amix.push(`[a${i}]`);
      }
      n++;
    }
  }
  fc.push(amix.length
    ? `${amix.join('')}amix=inputs=${amix.length}:normalize=0:duration=longest,apad,atrim=duration=${T}[aout]`
    : `anullsrc=r=48000:cl=stereo,atrim=duration=${T}[aout]`);

  args.push('-filter_complex', fc.join(';'), '-map', `[${last}]`, '-map', '[aout]', '-t', String(T),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(opts.crf ?? 18), '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', out);
  return {args};
}

function atempoChain(rate: number): string {
  if (rate === 1) return '';
  const parts: number[] = [];
  let r = rate;
  while (r < 0.5) { parts.push(0.5); r /= 0.5; }
  parts.push(r);
  return parts.map((p) => `atempo=${p}`).join(',') + ',';
}
declare function localPath(a: unknown): string; // asset → local file (proxy or original)
```

Caveats to implement: crop (`crop=` before scale, from `cropLeft/Top/Right/Bottom`), rotation
(`rotate=a=…:ow=rotw(a):oh=roth(a):c=none`), `borderRadius` (alpha mask via `geq` or a pre-rendered mask
PNG), `keepAspectRatio`, images (`-loop 1 -t d -i img`), GIFs (`-ignore_loop 0`), VFR sources
(`fps=` normalizes them), and very long timelines (hundreds of inputs). For those, **render per segment**
(split the timeline at points where the set of active items changes, or every N seconds), then
`-f concat -c copy`. That also parallelizes across the 12 cores. The Remotion Player preview uses CSS
transforms, so export parity needs golden-frame tests: render the same frame with Remotion and with
ffmpeg, then compare with `ffmpeg -lavfi ssim`.

---

## 7. OTIO mapping from the editor state (verified in Python, port to TS)

Script: `/tmp/jasper-research/native-video-libs/otio/state_to_otio.py`. Outputs: `seq.otio`, `seq.xml`
(xmeml v4), `seq.edl`, `seq.aaf`.

Mapping rules:
- `Timeline.global_start_time = RationalTime(0, fps)`. Store width/height in `timeline.metadata.jasper`.
- OTIO track order is bottom→top, so `tracks.slice().reverse()`. Track kind is `Audio` if all items are
  audio, otherwise `Video`. (Premiere expects separate audio tracks for a video clip's audio. When
  exporting FCP7 XML, emit a linked audio clip on an audio track for each `VideoItem` with
  `asset.hasAudioTrack`.)
- Gaps: insert `Gap(duration = item.from - cursor)`.
- `Clip.source_range = TimeRange(start = round(videoStartFromInSeconds*fps), duration = durationInFrames)`.
  `media_reference = ExternalReference(target_url = file URL of original (not proxy), available_range = asset duration)`.
- `playbackRate != 1` → `LinearTimeWarp(time_scalar = rate)` (source duration = timeline duration × rate).
- `decibelAdjustment`, fades, transforms, and Remotion-only items → `clip.metadata.jasper` (round-trip
  safe). Text/captions can additionally be exported as markers or subtitle side files (SRT/VTT) for NLEs.

`.otio` JSON (what TS must emit; this is from the test output):
```json
{"OTIO_SCHEMA":"Clip.2","name":"src.mp4","metadata":{"jasper":{"itemId":"v1"}},
 "source_range":{"OTIO_SCHEMA":"TimeRange.1",
   "start_time":{"OTIO_SCHEMA":"RationalTime.1","rate":30.0,"value":369.0},
   "duration":{"OTIO_SCHEMA":"RationalTime.1","rate":30.0,"value":150.0}},
 "effects":[],"markers":[],"enabled":true,"color":null,
 "media_references":{"DEFAULT_MEDIA":{"OTIO_SCHEMA":"ExternalReference.1","metadata":{},"name":"",
   "target_url":"file:///media/src.mp4","available_image_bounds":null,
   "available_range":{"OTIO_SCHEMA":"TimeRange.1",
     "start_time":{"OTIO_SCHEMA":"RationalTime.1","rate":30.0,"value":0.0},
     "duration":{"OTIO_SCHEMA":"RationalTime.1","rate":30.0,"value":1800.0}}}},
 "active_media_reference_key":"DEFAULT_MEDIA"}
```
Container schemas: `Timeline.1` → `tracks: Stack.1` → `children: Track.1 {kind: "Video"|"Audio",
children: [Clip.2 | Gap.1 | Transition.1]}`.

Conversions via the sidecar:
```bash
otioconvert -i seq.otio -o seq.xml  -O fcp_xml      # Premiere / Resolve / Avid (FCP7 XML)
otioconvert -i seq.otio -o seq.edl  -O cmx_3600     # needs single-track timeline (-T / pre-flatten)
python -c "import opentimelineio as o; o.adapters.write_to_file(o.adapters.read_from_file('seq.otio'),'seq.aaf',adapter_name='AAF',use_empty_mob_ids=True)"
otioconvert -i premiere_export.xml -o in.otio        # import: map back to items via metadata or heuristics
```
Import from Premiere (File → Export → Final Cut Pro XML) → `fcp_xml` adapter → `.otio` → our items. Media
relinking by filename, plus duration/timecode checks.

---

## 8. RECOMMENDED STACK

| Need | Desktop / daemon (native) | Web / PWA (no daemon) | Notes |
|---|---|---|---|
| **Engine binary** | Our pinned **FFmpeg 9.0.x (or 8.1.x)** `ffmpeg`+`ffprobe` per platform (BtbN linux64/win64, own macOS build), in `extraResources`, spawned from a worker/utilityProcess | mediabunny (+ WebCodecs) | Decide GPL-sidecar (A) vs LGPL (B), section 2. Don't rely on system ffmpeg, `ffmpeg-static`, or Remotion's compositor FFmpeg. |
| **Fast lossless cuts** | `ffmpeg -ss … -i … -t … -c copy -avoid_negative_ts make_zero` + keyframe snapping from `ffprobe -skip_frame nokey`. Concat demuxer for joins. Smart-cut later. | mediabunny `Conversion` with trim (stream copy when possible) | 0.2 s for a 20 s cut |
| **Proxy generation** | H.264 short-GOP 720p/540p MP4 (`keyint=15`, `-tune fastdecode`, `+faststart`), HDR→SDR tonemapped, per-asset job queue (1 to 2 concurrent jobs, `-threads` split) | mediabunny `Conversion` (WebCodecs HW encode) in a Worker | Browser-decodable proxies, not ProRes/DNxHR |
| **Thumbnails / filmstrips** | ffmpeg `-skip_frame nokey` + `tile` sprites (0.4 s/min), `thumbnail` filter for posters. sharp for image assets. | existing mediabunny `extract-frames.ts` | Cache sprites + JSON index |
| **Waveforms** | ffmpeg `-ac 1 -ar 8000 -f f32le pipe:1` → `reducePeaks()` → cached `.f32` | existing `load-waveform-peaks.ts` | Same `Float32Array` 100 peaks/s contract |
| **Final export of EDL** | Hybrid: Remotion/fframes render graphics-only alpha intermediates (ProRes 4444 / VP9-alpha), then one ffmpeg `filter_complex` composite (section 6), segment-parallel, x264/x265/SVT-AV1/ProRes/DNxHR outputs | `renderMediaOnWeb` (current) | Pure-graphics timelines: Remotion only. Golden-frame SSIM tests. |
| **Color / LUT** | `.cube` via ffmpeg `lut3d` (tetrahedral), `zscale`/`colorspace` for conversions, `ocio` filter (FFmpeg 8.1+) or `ociobakelut` for managed workflows, `libplacebo` when a GPU exists | WebGL LUT shader on the preview canvas | Lumetri-style Input LUT + Look |
| **Audio processing** | ffmpeg: `volume`, `afade`, `amix`, `atempo` (default) / `rubberband` (HQ, GPL), `afftdn`/`arnndn` denoise, `acompressor`, `equalizer`, `ebur128` meter, **two-pass `loudnorm`** on the master | Web Audio for preview only | Targets -14/-16/-23 LUFS presets |
| **Local transcription** | **whisper.cpp** `whisper-cli` prebuilt per platform + ggml models downloaded on demand + Silero VAD. Word timestamps `-ojf` → `Caption[]` (reuse `@remotion/install-whisper-cpp` `toCaptions`). | OpenAI API route (existing) or `@remotion/whisper-web` | base.en: ~10 to 20x realtime on this CPU |
| **Scene detection** | ffmpeg `scdet` (downscaled) built in. PySceneDetect `detect-adaptive` in the optional Python sidecar | none (or send to daemon) | Emit markers + "split at scenes" action |
| **Silence cutting** | ffmpeg `silencedetect` → keep-ranges → items. auto-editor binary as optional/agent tool (`--export v3`/`premiere`) | mediabunny `AudioSampleSink` RMS in a Worker | |
| **Interchange (OTIO)** | Native TS `.otio` writer/reader + frozen Python `jasper-otio` sidecar (OTIO 0.18 + plugins) for **FCP7 XML (Premiere)**, EDL, AAF, FCPXML | `.otio` JSON only (download) | Put Jasper-specific data in `metadata.jasper` |
| **In-process frame access** (optional) | `node-av` / `@mediabunny/server` in the daemon (build node-av against our FFmpeg for license control) | mediabunny | Enables sharing mediabunny code web↔desktop |
| **Later** | OpenCV (Rust `opencv` crate or opencv.js) for tracking/auto-reframe. LV2 audio plugins via ffmpeg. | | |
| **Skip** | MLT/melt, GStreamer/GES, VapourSynth/AviSynth, OpenFX host, beamcoder, fluent-ffmpeg, ffmpeg-static, @ffmpeg-installer, audiowaveform | ffmpeg.wasm except as last-resort fallback | |

### Packaging checklist (Electron, electron-builder as in orquester `apps/desktop/package.json`)
- `build.extraResources`: `{from: "vendor/ffmpeg/${os}-${arch}", to: "bin"}`, the same for `whisper`,
  `auto-editor` (optional), `jasper-otio` (optional). Resolve with
  `path.join(process.resourcesPath, 'bin', exe)` when packaged, otherwise `vendor/...` in dev.
- In orquester, `apps/desktop/scripts/build-main.ts` marks native modules `external` (`node-pty`,
  `better-sqlite3`). Do the same for `node-av` and `sharp`, and add `asarUnpack` for their `.node` files.
- A per-platform CI matrix downloads and verifies (sha256) pinned binaries, runs `ffmpeg -buildconf`
  assertions (required encoders/filters present), and on macOS codesigns plus notarizes every helper.
- Model files (whisper ggml, VAD) are downloaded on demand into `userData/models`, not bundled.
- Ship `THIRD_PARTY_NOTICES` plus FFmpeg/whisper/etc. licenses and a source-offer page for (L)GPL
  components.
- Web deployment: the daemon runs on a server (Docker image with the same pinned FFmpeg). The PWA falls
  back to mediabunny when no daemon is reachable.

---

## 9. Open questions / risks
1. **GPL vs LGPL FFmpeg** is a product and legal decision. It affects node-av usage, rubberband, and
   x264 quality. Both Remotion's and node-av's prebuilt FFmpeg link **fdk-aac with GPL**, which needs
   legal review before shipping those binaries.
2. **macOS FFmpeg builds** have no BtbN equivalent, so we need our own CI build (or a third-party static
   build) and notarization.
3. **Preview/export parity:** the Remotion Player (CSS/React) and the ffmpeg composite will differ in
   scaling filters, color (browser color management), text rendering, and border radius. Keep graphics in
   Remotion/fframes and verify with SSIM golden tests.
4. **Python sidecar** (OTIO adapters, PySceneDetect) adds 30 to 70 MB. Make it an optional download
   ("Pro interchange pack").
5. **whisper.cpp on low-end CPUs:** default to `base`/`small` q5, run VAD, and show the realtime factor.
   Offer the cloud API.
6. The Remotion version bump (4.0.499 → 4.0.53x) also moves mediabunny (1.50 → 1.6x). Coordinate with the
   Remotion upgrade.

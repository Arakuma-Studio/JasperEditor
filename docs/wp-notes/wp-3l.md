# wp-3l — LGPL-safe encoder selection (ARCHITECTURE D-13)

Branch `wp/wp-3l`. The engine now works with an LGPL FFmpeg that has no libx264/libx265: every encode
(native export, Remotion export, proxies) goes through one selector, and `/api/capabilities` reports what
the build can do.

## What exists

| Area | Where | Notes |
|---|---|---|
| Probe | `apps/engine/src/tools/ffmpeg.ts` (self-check) | Runs once per binary pair at startup (cached): `-version` (the `configuration:` line gives the license: `lgpl` / `gpl` / `nonfree`), `-encoders`, `-filters` and now `-hwaccels`. ffmpeg path resolution unchanged (D-13 order `JASPER_FFMPEG` → `<resources>/bin` → PATH). `REQUIRED_ENCODERS` no longer lists `libx264` (it is `aac`, `prores_ks`, `libvpx-vp9`). `nativeRender` needs any video export encoder (H.264, AV1 or VP9), not specifically H.264. |
| Hardware check | `tools/encoders.ts` `probeHardwareEncoders` | For every listed `h264_videotoolbox`, `h264_nvenc`, `h264_qsv`, `h264_amf`, `h264_vaapi`: a 3-frame 256×144 test encode to the null muxer (VAAPI with `-vaapi_device /dev/dri/renderD128` + `hwupload`, skipped when the device node is missing; encoders for another OS are skipped). Parallel, 10 s timeout, result cached per ffmpeg path for the process lifetime. `JASPER_HW_ENCODERS=0` skips the tests (all hardware counted unusable). On this host all three listed encoders fail in ~0.2 s (no GPU). |
| Selector | `tools/encoders.ts` `selectVideoEncoder` (pure) | H.264 preference: usable hardware (order above) → `libopenh264` → `libx264` (only when present, dev convenience). Without H.264: exports → `libsvtav1` (AV1/MP4) → `libvpx-vp9` (VP9/WebM + Opus, or MP4 + AAC when there is no `libopus`) → `libaom-av1`; proxies → `libvpx-vp9` → `libsvtav1` → `libaom-av1` (proxies stay MP4). Fallback choices carry a `message` ("H.264 is unavailable (…): exporting AV1 (MP4)"). An explicit `settings.video.encoder` is honoured only when usable, otherwise the best encoder is used and the message says why. `JASPER_FFMPEG_LGPL_ONLY=1` removes `libx264`, `libx264rgb`, `libx265`, `libxvid`, `libxavs*`, `libfdk_aac` from consideration. |
| Rate control | `tools/encoders.ts` `videoEncodeArgs` | The export quality stays an x264-style CRF. libx264: unchanged preset/CRF (proxies keep `keyint=15` params). libopenh264: no CRF → average bitrate from `0.15 bpp × 2^((18−crf)/6) × 1.3`, `-maxrate 1.5×`, `-bufsize 2×`, `-rc_mode bitrate -allow_skip_frames 0` (exact frame count). NVENC `-rc vbr -cq`, QSV `-global_quality` (nv12), AMF `-rc cqp`, VAAPI `-rc_mode CQP -qp` (+`hwupload`), VideoToolbox bitrate (×1.2). VP9 `-b:v 0 -crf` (18→32, 23→38, 26→42), SVT-AV1/libaom `-crf` (18→28, 23→35, 26→39); speed `fast/balanced/best` → presets/cpu-used. Audio: `aac` (MP4) or `libopus` (WebM). |
| Capabilities | `packages/api` `EncodingCapabilitiesSchema`, `tools/capabilities.ts` | Additive `media.encoding` = `{license, lgplOnly, hwaccels, hardware[{encoder, usable, reason}], codecs{h264,vp9,av1}, audio{aac,opus}, prores, export, proxy, message?}`. `render.native` is false when no export encoder is usable. |
| Contracts | `packages/api` | Additive: `EncoderChoiceSchema`, `VideoCodecSchema`; `ExportSettings.container` `mp4|webm`, `video.codec` `h264|vp9|av1`, `video.encoder?`, `audio.codec` `aac|opus`; `RenderPlan.encoder?`; `ExportResult.encoder?/container?`. Plan warning code `ENCODER_FALLBACK`. |
| Native export | `export/native.ts`, `export/planner.ts`, `export/service.ts` | Planner selects the encoder (part of the `planId`), blocks the native path when none is usable, and records it in `OutputSpec.encoder`. Output file `renders/<job>/output.<mp4|webm>`; a `destination.path` gets the matching extension (`x.mp4` → `x.webm` for a VP9/WebM export). |
| Remotion export | `export/service.ts`, `remotion/service.ts` | If the selected encoder is `libx264` (GPL dev build) or nothing is usable, Remotion encodes H.264 itself as before. Otherwise Remotion renders a ProRes 422 HQ + PCM `.mov` intermediate in the job scratch dir and our ffmpeg encodes it with the selected encoder (bt709 tags like the native path). In LGPL-only mode with no encoder the plan fails with `ENCODER_UNAVAILABLE` instead of using Remotion's x264. `JASPER_REMOTION_BINARIES_DIR` → Remotion `binariesDirectory` for every call (selectComposition, renderMedia, renderStill). Export frames are captured as PNG (`imageFormat: 'png'`): Remotion's default for videos is JPEG (quality 80), whose 4:2:0 chroma and ringing turned 255 into 216 / 246 at the edges of a 10 px stroke and put ±7 ringing beside it (measured in `trim-paths-export.e2e.test.ts`; regression `remotion-retry.test.ts`). |
| Proxies | `derivatives/service.ts` | Proxy encoder from the selector (`purpose: 'proxy'`, GOP 15, realtime presets), always MP4 + AAC. A non-libx264 proxy encoder is part of the params hash (new cache key); libx264 proxies keep the old key so existing caches stay valid. No usable encoder → job fails with `ENCODER_UNAVAILABLE`. |
| MG | `mg/service.ts`, `routes/mg.ts` | Masters are `prores_ks` 4444 (native, LGPL), previews `libvpx-vp9` with alpha (BSD) — no GPL encoder. The MG pipeline now uses the engine's resolved ffmpeg/ffprobe (it previously used `JASPER_FFMPEG` or bare `ffmpeg`, skipping packaged resources). |
| Stills | — | PNG only (native `png` encoder / Remotion `renderStill`); unaffected. |
| Web | `apps/web/src/export/{ExportMode.tsx,settings.ts,quick.ts}` | Export view: **Format** select (H.264 / AV1 / VP9, unavailable ones disabled with the reason), **Encoder** select ("Auto" + every encoder the build lists for the codec; failed hardware tests and GPL encoders in LGPL-only mode disabled with the reason), **Output** line with the plan's encoder ("AV1 · SVT-AV1 (software) → MP4") and the capability/fallback message. Codec/encoder are remembered per sequence and used by Quick Export; the tracked download name uses the real extension. |

## Remotion's bundled FFmpeg (finding)

Inspected `@remotion/compositor-*@4.0.499` (`ffmpeg -buildconf`, `ffmpeg -L`, `strings` of libavcodec):

| Package | FFmpeg | Configure flags of note | libavcodec license string |
|---|---|---|---|
| `compositor-linux-x64-gnu` (installed) | n7.1 | `--enable-gpl --enable-libx264 --enable-libx265 --enable-libfdk-aac`, encoders limited to `libx264 libx265 libaom_av1 libvpx_vp8/vp9 libopus opus aac libfdk_aac prores_ks png mjpeg gif h264_nvenc hevc_nvenc …` | "GPL version 2 or later" |
| `compositor-linux-x64-musl`, `linux-arm64-gnu` | n7.1 | same (`--enable-gpl`, x264, x265, fdk-aac) | "GPL version 2 or later" |
| `compositor-darwin-arm64`, `darwin-x64` | n7.1 | same + `h264_videotoolbox`, `hevc_videotoolbox` | "GPL version 2 or later" |
| `compositor-win32-x64-msvc` | n7.1 **and** n6.1 DLLs | same; the 6.1 set (`avcodec-60.dll`) is built with `--enable-nonfree` | 7.1: "GPL version 2 or later"; 6.1: **"nonfree and unredistributable"** |

Also: `--enable-gpl` together with `--enable-libfdk-aac` is a combination upstream FFmpeg's configure
normally refuses without `--enable-nonfree` (fdk-aac's license is GPL-incompatible), and the configuration
lines above show no `--enable-nonfree`, so even the builds that report "GPL" do not look cleanly
redistributable. The Rust `remotion` compositor binary dynamically links these `libav*` libraries
(checked with `ldd`), so it is not just the `ffmpeg` executable: frame extraction for `<OffthreadVideo>`
uses them too.

Consequences for packaging (not legal advice; needs a license review before shipping):

- Using the intermediate path means Remotion's x264/x265/fdk-aac are never used to produce our deliverables,
  but shipping the npm compositor package still distributes those binaries.
- Options: (a) build Remotion's compositor against our LGPL FFmpeg and point `JASPER_REMOTION_BINARIES_DIR`
  at it (the hook is in place; the directory must mirror the package layout: `remotion`, `ffmpeg`,
  `ffprobe` and the libs); (b) keep the Remotion path dev/optional in packaged builds (users install the
  Remotion add-on themselves); (c) replace the Remotion render path for graphics with the browser/fframes paths.
- Remotion's own company license is a separate question (already tracked under D-19 / licensing).

## Verification

- `apps/engine/test/encoders.test.ts` (13 tests): selector with mocked lists — LGPL-only build, OpenH264-only,
  hardware-only, full GPL (+LGPL-only mode), explicit encoder, nothing usable; argument mapping per encoder;
  license/hwaccel parsing; hardware test encodes against a fake `ffmpeg` shell script (usable/failed/other-OS,
  caching, disabled).
- `apps/engine/test/lgpl.test.ts` (3 tests, real system ffmpeg with `JASPER_FFMPEG_LGPL_ONLY=1`):
  capabilities contain no GPL encoder; a real native export (video + scaled still, 45 frames, 640×360) plans
  and renders with `libsvtav1` (AV1 in MP4 + AAC) on this host, frame count verified; a real 540p proxy is
  VP9 in MP4.
- `apps/engine/test/remotion.e2e.test.ts` new case (gated `REMOTION_E2E=1`, optional `JASPER_E2E_PORT`):
  LGPL-only Remotion export → ProRes intermediate → AV1, 20 frames verified. Ran with
  `REMOTION_E2E=1 JASPER_E2E_PORT=48210 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome`: both e2e tests pass.
- Manual: every software encoder's arguments encoded a real clip with the exact frame count (SVT-AV1 MP4,
  VP9 WebM+Opus, VP9 MP4 proxy, libaom AV1, libx264).
- `apps/web/test/wp2e/ui.test.tsx`: export view shows the plan's encoder + message, disables unavailable
  codecs, sends the effective codec/encoder to the planner, lists disabled hardware/GPL encoders with reasons.

- Manual: engine on port 48220 with `JASPER_FFMPEG_LGPL_ONLY=1` serving the built web app; the Export view of
  the demo project showed Format "AV1 (MP4)", Output "AV1 · SVT-AV1 (software) → MP4" and the fallback
  message (the PWA service worker kept serving the previous bundle after rebuilding, so the later preset-label
  tweak was only verified by the unit test).
- `pnpm verify` passes (661 tests, 7 skipped).

## Not done / follow-ups

- **No real OpenH264 or hardware encode was run**: the system ffmpeg has no `libopenh264` and the host has
  no GPU. Those argument sets are covered by unit tests only; first packaged build on macOS/Windows/NVIDIA
  should run `lgpl.test.ts` against the shipped sidecar (`JASPER_FFMPEG=…`). NVENC presets `p1…p7` need
  FFmpeg ≥ 4.4 (fine for a new sidecar).
- The LGPL FFmpeg sidecar itself (build + packaging under `<resources>/bin`) and the About/Licenses screen are
  not part of this WP.
- Remotion compositor: see above — an LGPL rebuild (or dropping the npm compositor from packaged builds) is
  still required before distribution.
- `scripts/make-fixtures.mjs` still uses `libx264` to generate H.264 test fixtures (dev-only tooling; it needs
  H.264 sources to mimic camera files). On an LGPL-only dev machine fixtures must be generated elsewhere.
- HEVC encoders (`hevc_*`) are not offered; AV1 hardware encoders (`av1_nvenc`, `av1_qsv`, …) are not used for
  the fallback (software SVT-AV1 only).
- Export presets in the UI remain "Match Sequence"; no bitrate-mode quality control is exposed (openh264 uses
  the CRF→bitrate mapping).
- The hardware test-encode cache is per process (not persisted); it costs ~0.2–0.5 s at startup when
  hardware encoders are listed.

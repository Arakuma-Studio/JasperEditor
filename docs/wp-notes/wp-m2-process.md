# wp-m2-process — clip processing (S07)

Processed versions of media: stabilise, de-judder, denoise, deblock and AI upscale run as engine jobs that write
a new managed media file; clips swap to it (and back) in one undoable step with exact Motion compensation. The
processors live in one CLI, `jasper-proc`, run locally or on a remote host over SSH.

Branch `wp/m2-process`. Spec `docs/specs/07-clip-processing.md`; ARCHITECTURE D-13 (+ M2 note), D-23…D-25, §19.4.

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| PRC-001…004 | `packages/project/src/commands/handlers/process.ts`, `src/process/{rescale,versions}.ts` | `media.derive` adds asset + item in an auto "Processed" bin next to the original's bin (`crudo [Stabilized · Upscaled 2×]`), idempotent by fingerprint / source+recipeHash. |
| PRC-005…007 | same | `clip.replaceSource`; `rescaleClipForSource(clip, oldSize, newSize)` exported for other packages. Anisotropic size changes (848×480 → 1920×1080) switch Uniform Scale off and use Scale Width; auto-bezier anchor keyframes are pinned to their exact eases; tracker samples scaled per axis. Linked audio keeps the original. |
| PRC-010 | `apps/engine/src/processing/service.ts`, `routes/processing.ts` | `process` job, dedupe `process:<fp>:<recipeHash>`, slots = `localSlots` (default half the cores). |
| PRC-011…014 | `apps/engine/src/processing/proc/` | `jasper-proc --version` / `run --spec`; NDJSON events on stderr; exit 0/1/2/3; rgb48le pipes between steps; FFV1 gbrp16le intermediates before two-pass steps; one ffmpeg process for filter-only recipes; ProRes 422 HQ (4444 for alpha sources, filter steps only) with BT.709 tags + `setparams`; audio copied (whole file) or PCM (ranges); frame-count verification; sidecar `<output>.json` (steps, info, timings, notes, models + sha256, output sha256); SIGTERM → cleanup → exit 3. |
| PRC-015 (P1) | proc runner + engine | `range` processing works end to end (accurate seek, `-t` audio); the model side does not remap `sourceIn` for ranged versions yet (refused with `E_OUT_OF_MEDIA` when too short). |
| PST-001…004 | `proc/vidstab/` (WASM), `proc/vidstab-native.ts`, `proc/filters.ts` | see "Stabilisation" below. |
| PST-010…014 | `proc/dejudder/` | port of the trailer's cadence.py / dejudder.py `flow` method; OpenCV.js 4.12 in worker threads. |
| PST-020/021 | `proc/filters.ts` | atadenoise / fftdnoiz / nlmeans with the S07 parameter mapping; deblock. |
| PST-030…034 | `proc/upscale.ts`, `processing/models.{json,ts}`, `apps/engine/models/` | onnxruntime-node 1.30.0; 256 px tiles, 16 px overlap, feathered normalised blending, batches of 4; bicubic resize to `size`; `mix` with a clamped Lanczos reference. Tests use a generated 1×1-conv + DepthToSpace model (`proc/tiny-onnx.ts`, raw protobuf, no Python). |
| PRM-001…009 | `processing/settings.ts`, `processing/remote.ts`, service | see "Remote execution". |
| PRU-001…004 | `apps/web/src/processing/`, `apps/web/src/shell/preferences/`, `apps/web/src/commands/process.ts` | Process Clip dialog, job completion → `media.derive` (one "Process Clip" entry), badges, Media Version section, Preferences dialog shell with a page registry + Processing page. |
| PRA-001/002 | `apps/mcp/src/tools/processing.ts`, `tools/projects.ts` (`get_media_info`) | `list_processing_models`, `install_processing_model`, `process_clip`, `use_media_version`, `get/set_processing_settings`, `test_remote_executor`, `PROCESSING_GUIDE`. |

## Stabilisation (producer decision 2026-10-01: cross-platform vid.stab)

- **Primary: vid.stab compiled to WebAssembly.** The pinned post-relicense commit (LGPL-2.1-or-later,
  `e2445c4081658318223762a696eb1c645c2d7168`, 2026-08-14, v1.4.0; `RELICENSE.md`, issue #165) is built by
  `scripts/vidstab-wasm/build.sh` (pinned toolchain + sha256 in `scripts/vidstab-wasm/manifest.json`) into
  `apps/engine/src/processing/proc/vidstab/vidstab.wasm`, committed as a separate, replaceable file with
  `VIDSTAB-WASM.json` (source commit, archive sha256, toolchain, flags, module sha256), `LICENSE-vidstab.txt`
  and `NOTICE-vidstab.txt` (how to relink: rebuild from the corresponding source and drop the file in, or point
  `JASPER_VIDSTAB_WASM` at it). One code path on Linux, Windows and macOS: ffmpeg (LGPL) decodes → WASM motion
  detection on downscaled luma → smoothed camera path → per-frame transform → ffmpeg encodes.
- **Optional fast path on Linux:** our LGPL FFmpeg source build with libvidstab (`scripts/ffmpeg/build-lgpl-from-source.sh`
  + `patches/configure-libvidstab-lgpl.patch`; BUILDINFO.json `libvidstab` record). The engine uses FFmpeg's
  `vidstabdetect/vidstabtransform` only with `JASPER_VIDSTAB_ENGINE=ffmpeg` and when its FFmpeg directory records
  exactly the pinned commit (`nativeVidstabAllowed`); the WASM path is the default (as fast or faster at 1080p,
  16-bit). The build was run in this worktree
  (FFmpeg 7.1.5 + vid.stab, `vendor/ffmpeg-lgpl-vidstab/linux-x64`, ~25 min on the shared host) and passes
  `pnpm ffmpeg:check`; switching the shipped linux-x64 build from BtbN to it is the integrator's/user's call
  (§19.12 item 3).
- **Licence guard:** `pnpm ffmpeg:check` accepts `--enable-libvidstab` only when the BUILDINFO.json next to the
  binaries records the pinned commit with licence LGPL-2.1-or-later (tests in `scripts/ffmpeg/lib.test.mjs`).
- **Last resort:** `deshake` (+ 4 % centre crop for `borders: 'crop'`), used by `method: 'auto'` only when the
  WASM module cannot be loaded.

## Remote execution (PRM)

`SshRemote` runs the system OpenSSH client with argument arrays and `-o BatchMode=yes -o ServerAliveInterval=30
-o StrictHostKeyChecking=<accept-new|yes> -o ControlMaster=auto -o ControlPath=<appdir>/tmp/ssh/ssh-%C
-o ControlPersist=60 -p <port> [-i <key> -o IdentitiesOnly=yes]`; remote command lines are built only from the
validated `remoteDir` and engine ids, every word single-quoted. Layout `<remoteDir>/{bin,models,jobs,cache,ffmpeg}`.
A job uploads the source to the content-addressed cache (`rsync --copy-links --partial --inplace` into `.part`, resumable;
scp fallback restarts), uploads missing models, writes the spec, runs `setsid -w sh -c 'echo $$ > pid; exec node
bin/jasper-proc.mjs run --spec spec.json'` streaming the NDJSON progress, downloads the output + sidecar, verifies
sha256 and frame count, deletes the job directory and LRU-trims the cache to 20 GB. Cancel kills the local ssh and
`kill -TERM -- -<pid>` remotely, then removes the job directory. Exit 255 → `REMOTE_CONNECTION_LOST` (retryable);
a remote failure never falls back to local. Setup uploads the bundle (`scripts/build-proc.mjs`, built on demand
from a checkout), runs `npm install --omit=dev` (`JASPER_REMOTE_NPM` overrides), uploads models by sha256 and the
LGPL linux-x64 FFmpeg when the remote has none, then probes. Probe reports node / ffmpeg / `nvidia-smi` GPU /
installed runtime / ONNX providers (CUDA only when the CUDA provider library exists and a CUDA session can be
created — never on this host).

Uploads transfer the bytes of a selected source symlink, matching SCP and the source size/hash checks. This is
required for LGPL library aliases such as `libavcodec.so → libavcodec.so.61`; omitting dereferencing lets rsync
skip the alias and leaves no `.part` to publish. The installed `rsync --help` documents `--copy-links` as transforming
a symlink into its referent file/directory; this single-file upload does not enable recursive traversal.
`processing-remote-upload.test.ts` isolates the regression with real rsync, a real relative link and the shared SSH
protocol fixture; expected destination bytes are authored independently of the transfer implementation.
The focused one-worker regression failed with the missing `.part` before the fix and passed afterward; full setup
and real-SSH verification remain separate integration checks.

Tests: `apps/engine/test/processing-remote.test.ts` with `JASPER_SSH`/`JASPER_SCP` shims (protocol, setup,
auto executor, input cache reuse, resumable upload, cancel kills the remote process group, connection loss);
with `JASPER_TEST_SSH=user@host[:port]` (+ `JASPER_TEST_SSH_KEY`) the same flow runs over real SSH. That variant
was not run here: a private sshd on 127.0.0.1 accepted the key but this account's login shell is `nologin`, and no
Docker image with Node + sshd was available offline.
**Manual GPU check (no GPU host now):** configure a Linux x64 host with an NVIDIA driver + CUDA 12 and Node ≥ 20
in Preferences ▸ Processing, *Set up*, then run onnxruntime-node's CUDA install on the remote
(`cd <remoteDir>/bin && ONNXRUNTIME_NODE_INSTALL_CUDA=v12 npm rebuild onnxruntime-node`); *Test connection*
must list `cuda`; process a clip with upscale and check the sidecar's `device: "cuda"`.

## Contract changes (additive)

- `apps/engine/src/tools/licenses.ts`: `registerLicenseProvider()`; `/api/licenses` lists vid.stab, ONNX Runtime,
  OpenCV.js and model weights.
- `apps/engine/src/media/service.ts`: `MediaService.registerDerived(file, {fromMediaKey, recipeHash, name, projectId})`.
- `PUT /api/settings/processing?approvalProjectId=&agent=`: optional query asking the user to approve in the editor
  (agent approval gate) before saving — used by MCP `set_processing_settings`.
- `apps/mcp/src/tools/projects.ts` `get_media_info`: additive `derivation` and `versions`.
- `scripts/ffmpeg/lib.mjs`: `--enable-libvidstab` moved out of `FORBIDDEN_FLAGS` into the record-checked rule
  (`vidstabRecordProblem`); `evaluateBuild` takes `vidstab`.
- `apps/desktop/scripts/package.mjs`: ships `jasper-proc.mjs`, the de-judder worker, the vid.stab WASM files,
  models, licence texts and `onnxruntime-node`.

## Licences (new dependencies / assets)

| Component | Licence | Where |
|---|---|---|
| vid.stab e2445c4 (WASM module, optional FFmpeg filters) | LGPL-2.1-or-later | `proc/vidstab/`, `scripts/vidstab-wasm/`, `scripts/ffmpeg/` |
| onnxruntime-node 1.30.0 | MIT (text vendored: `processing/third-party/LICENSE-onnxruntime.txt`, the npm package ships none) | engine dependency |
| @techstark/opencv-js 4.12.0-release.1 (same version as wp-m2-track) | Apache-2.0 | engine dependency; inlined into `dist/dejudder-worker.mjs` |
| 2xNomosUni_span_multijpg (ONNX, 1.66 MB, bundled) | CC-BY-4.0, attribution "2xNomosUni_span_multijpg by Philip Hofmann (CC BY 4.0)"; SPAN architecture Apache-2.0 | `apps/engine/models/` (+ provenance JSON, legal code) |

All are listed in Help ▸ About ▸ Licenses (`GET /api/licenses`).

## How to test

```bash
pnpm fixtures                                   # + shaky.mp4, judder.mp4, steady-pan.mp4, noisy.mkv, blocky.mp4
pnpm vitest run --project @jasper/engine apps/engine/test/processing*.test.ts apps/engine/test/dejudder.test.ts apps/engine/test/vidstab-wasm.test.ts
pnpm vitest run --project @jasper/project packages/project/test/process*.test.ts
pnpm vitest run --project @jasper/mcp apps/mcp/test/processing.test.ts
pnpm vitest run --project scripts scripts/ffmpeg
pnpm ffmpeg:check
E2E_PORT=48430 pnpm e2e -- e2e/processing.spec.ts
```

## Validation on real footage

Host: 12 cores, no GPU, shared with other agents (load average 15–30 during the runs) — times are pessimistic.

**Stabilise + de-judder + upscale, `raw/crudo.mp4` 37.0–40.0 s (frames 1110–1199, corridor follow, 848×480
H.264 30 fps)**, recipe `dejudder(auto) → stabilize(vid.stab WASM, smoothing 15, crop) → upscale(SPAN 2×)`,
jasper-proc `range` → ProRes 422 HQ 1696×960, 90 frames (verified), BT.709:

| | cadence.py: step by phase (frame mod 3) | short/long | consistency | jitter px@1080p |
|---|---|---|---|---|
| source | 1.18 / **0.62** / 1.19 | 0.52 | 100 % | 3.40 |
| stabilise → de-judder → SR (spec order before the fix) | 1.03 / 0.91 / 1.07 | 0.86 | 62 % — `auto` skipped the retiming | 3.17 |
| **de-judder → stabilise → SR (fixed order)** | **1.01 / 0.97 / 0.99** | **0.97** | 35 % (no phase dominates) | 3.24 |

Our analyser agrees with cadence.py (0.52 → 0.99). The corridor is a walking follow shot: the "medium" preset
removes little jitter there (the trailer measured 3.64 → 2.79 on 38.5–41.5 s and recommends not stabilising
walking shots); zoom 3.06 %, mean correction 3.9 px, max 13 px. On a handheld-static shot (desk 95–98 s) the WASM
vid.stab gives 2.37 → 0.93 px (system FFmpeg vid.stab 0.94; corridor 38.5–41.5: 3.64 → 2.89 vs 2.90), output
48 dB / 40.8 dB PSNR against FFmpeg's own vid.stab.

Time per frame (848×480 source): total **2.75 s/frame** (247.8 s for 90 frames); de-judder 0.047 s/frame
(analysis + warp, 6 workers); stabilise 0.035 s/frame (WASM detect + 16-bit warp 12 ms/frame); SPAN 2.55 s/frame
with 256 px tiles → 1.6–1.9 s/frame after the whole-frame change (≤ 1.1 MP). vid.stab WASM alone: detect
0.011 / 0.037 s/frame at 480p / 1080p (SIMD), transform 0.012 / 0.035 s/frame (6 workers) vs system FFmpeg
`vidstabtransform` 0.050 / 0.19.

Frames looked at (`/tmp/realval/frames/`: 3 consecutive output frames, a 100 % crop next to a Lanczos upscale of
the source): no ghosting or double edges from the de-judder warp, no border artefacts from the crop zoom, hair and
skin natural, no invented texture; compression blocking cleaned up by SPAN.

## Open issues / known gaps

- PRC-015: ranged versions are produced but `clip.replaceSource` does not remap `sourceIn` for them. *(Closed by
  wp-m3-inpoint: source ranges, `docs/wp-notes/wp-m3-inpoint.md`.)*
- PST-013: one frame of context before/after a processed *range* is not read: the first/last frame of a range is
  copied instead of retimed. *(Closed by wp-m3-inpoint.)*
- Alpha sources: only denoise/deblock (ProRes 4444 with the source alpha); geometric steps answer
  `ALPHA_UNSUPPORTED`.
- Model removal (installed downloads) has no route; bundled models cannot be removed anyway.
- The FFmpeg-native vid.stab path is 8-bit (yuv444p); the WASM path applies the transforms on 16-bit RGB.
- Processed-version badges (timeline clip, Project item) are drawn by a stylesheet/tooltip decorator mounted
  through `programOverlays` (no badge extension point exists in the timeline/Project panels): they show while a
  Program monitor is open. A `clipBadges`/`projectItemBadges` registry from the panel owners should replace it.
- The upscale "1920 × 1080" quick size resizes without cropping (848×480 sources get a 0.6 % aspect change);
  the trailer's fill-and-crop reframe is not offered.
- Remote: the real-SSH test path was not exercised on this host (see above); no real-GPU run (no host).
- Branch is based on dev before wp-m2-transitions was merged; not rebased (integrator merges in order).

## Post-integration fix (de-judder scene-cut guard)

On integrated `dev` the S07 §8 test 4 failed (step CV 0.283 → 0.175, limit 0.141). Root cause: not OpenCV.js or
the other packages, but the fixture encoder. `judder.mp4` here had been generated with the LGPL FFmpeg (OpenH264);
`pnpm fixtures` with the system FFmpeg encodes it with x264, and the fixture recipe did not include the encoder, so
each environment kept whichever file it made first. On the x264 file the scene-cut guard fired on 16 of 60 frames
(1 with OpenH264), which were then copied instead of retimed. The guard sampled single pixels on an 8-px grid
(as the trailer's `a[::8, ::8]`): for a 12 px/frame pan over fine texture that measures texture contrast,
0.09–0.10 — right at the 0.10 threshold. Fix: the guard compares 8×8-cell means (pan ≈ 0.06, real shot changes on
crudo.mp4 0.20–0.31, fast real motion ≤ 0.09; corridor validation unchanged: 0 cut guards); new unit test; the
`shaky`/`judder`/`steady-pan` fixture recipes now include the H.264 encoder arguments so they regenerate per
encoder. Test 4 passes with both encoders (CV 0.283 → 0.000).

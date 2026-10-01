# Spec 07: Clip processing — processed versions of media (upscale, stabilise, de-judder, denoise, deblock)

Status: functional spec, v1 (2026-10-01), milestone M2. Audience: the implementers of `wp-m2-process`.
Architecture contracts: `docs/ARCHITECTURE.md` §19.4 (processing), D-13 (LGPL FFmpeg), D-23…D-25.

This spec is original work. The trailer pipeline scripts in `MatsSmileTrailer/grade/` were read as a record of
what worked (algorithms, parameters, pitfalls); nothing is copied from them.

---

## 0. How to read this spec

Requirement ids: `PRC-NNN` (processing model and jobs), `PST-NNN` (steps), `PRM-NNN` (remote execution),
`PRU-NNN` (UI), `PRA-NNN` (agents). Priorities P0/P1/P2 as in S06.

## 1. Goals

1. Run heavy per-clip restoration as **engine jobs** that produce a new media file — a *processed version* of a
   media item — without touching the original.
2. Swap a clip between the original and a processed version in one undoable step; the timeline timing never
   changes (every step keeps frame count and frame rate).
3. The native export path simply reads the processed file: no render-time cost.
4. Optional execution on a remote GPU machine over SSH, configured in Preferences; everything also works locally
   on a CPU-only machine.
5. Everything shipped stays LGPL-compatible (D-13); model weights and runtimes carry recorded, permissive licences.

## 2. Model

- **PRC-001 (P0)** A processed version is a `MediaAsset` with `derivation = {fromMediaId, recipe, recipeVersion,
  recipeHash}` and `recipe = {op: 'process', steps: ProcessStep[]}` (`packages/project/src/schema/media.ts`).
  Steps: `stabilize`, `dejudder`, `denoise`, `deblock`, `upscale` (fields in the schema; §4 defines them).
- **PRC-002 (P0)** `recipeHash = sha256(canonicalJson({steps, recipeVersion}))`; `recipeVersion` is the engine's
  processor version (bumped when outputs change for the same steps). Source identity is the source fingerprint;
  the processed file is content-addressed by `(sourceFingerprint, recipeHash)` and reused when present (CA-001).
- **PRC-003 (P0)** Output: QuickTime `.mov`, ProRes 422 HQ `yuv422p10le` (ProRes 4444 `yuva444p12le` when the
  source has alpha), BT.709 tags on the frames (ARCHITECTURE D-13 `setparams`), audio streams copied from the
  source unchanged, same frame count and frame rate as the source (or the processed range). The file is registered
  as managed media (`MediaRecord.derivedFrom = {mediaKey, recipeHash}`); the usual derivatives follow (poster,
  sprite, peaks, `proxy-720` which is mandatory because browsers cannot decode ProRes).
- **PRC-004 (P0)** Processed versions live in the Project panel as items in an auto-created bin "Processed" next to
  the original's bin, named `<original> [<step labels>]` (e.g. `crudo [Stabilized · Upscaled 2×]`), with a
  "processed" badge and the recipe in the tooltip. Deleting the item follows the normal in-use rules.
- **PRC-005 (P0)** `media.derive {fromMediaId, recipe, asset, replaceInClips?, binId?, ref?}` (handler owned by
  this package) adds the asset and item in one transaction and, for `replaceInClips`, swaps each clip's source
  (PRC-006). `clip.replaceSource {clipId, mediaId, keepDuration?}` swaps a single clip (also used to go back to the
  original). Both are ordinary undoable commands.
- **PRC-006 (P0)** Swapping keeps `start`, `duration`, `sourceIn`, speed, effects, keyframes, links and markers.
  When the intrinsic size changes (upscale), Motion is compensated so the framing is identical: `scale ×= oldW/newW`
  (and `scaleWidth`), `anchor ×= newW/oldW` (per axis), including every keyframe; crop percentages are unchanged.
  Tracker samples (S09) are in media pixels and are scaled the same way.
- **PRC-007 (P0)** A processed version keeps the linked audio clip's source unchanged (audio is copied, not
  processed; the linked audio clip keeps pointing at the original).

## 3. Jobs and the processor runtime

- **PRC-010 (P0)** `POST /api/media/:key/process {steps, executor, range?, projectId?}` queues a `process` job
  (lane `user`, CPU slots = `localSlots`, default half the cores) and returns it. `result = ProcessResult`
  (`packages/api/src/processing.ts`): the `RegisteredMedia` of the output, `fromMediaKey`, `recipeVersion`,
  `recipeHash`, `executor`, notes. Dedupe key `process:<fingerprintHex>:<recipeHash>`.
- **PRC-011 (P0)** Processors are implemented once, in a standalone Node CLI **`jasper-proc`**
  (`apps/engine/src/processing/proc/`, bundled by esbuild to `apps/engine/dist/jasper-proc.mjs`, like `jasper-mcp`):
  ```
  jasper-proc --version                         → {"name":"jasper-proc","version","recipeVersion","onnx":{providers}}
  jasper-proc run --spec spec.json              spec = {input, output, steps, range?, ffmpeg, ffprobe, models,
                                                        threads, device: 'cpu'|'cuda', scratch}
  stderr NDJSON: {"event":"start","frames":N} {"event":"progress","step":i,"done":k,"total":N} {"event":"note",…}
                 {"event":"done","frames":N} | {"event":"error","code","message"}
  exit 0 ok, 2 invalid spec, 3 cancelled (SIGTERM), 1 other
  ```
  The engine runs it as a child process for local jobs and over SSH for remote jobs (§5): **one code path**.
- **PRC-012 (P0)** Between steps, frames travel as raw `rgb48le` through pipes (ffmpeg → JS/ONNX step → ffmpeg), or
  as a lossless FFV1 intermediate in `scratch` when a step needs two passes (vid.stab). The last step encodes
  ProRes (PRC-003). A pure-ffmpeg chain (deblock, denoise, deshake) runs in one ffmpeg process.
- **PRC-013 (P0)** Every job verifies the output frame count (`FRAME_COUNT_MISMATCH` otherwise) and writes a
  sidecar `<output>.json` (steps, versions, timings, notes, executor, model ids + sha256).
- **PRC-014 (P0)** Cancel kills the process tree (local) or the remote process group (§5), deletes partial
  outputs; retry re-runs from scratch (steps are deterministic apart from GPU fp16 rounding).
- **PRC-015 (P0, M3)** Range processing: `range = {startFrame, endFrame}` (source frames at the source's rate,
  end exclusive) processes a sub-range of the source — typically the frames the selected clips show plus N
  frames of handles — and registers a shorter processed file. `ProcessResult.range` reports it, the engine
  records it in `MediaRecord.derivedFrom.range`, and `media.derive {range}` stores it as the version's
  **`MediaAsset.sourceRange`** `{mediaId: <source>, sourceName, firstFrame, frames, frameRate, origin: 'process'}`
  (whole-source versions get `firstFrame: 0`; schema v5, the v4 → v5 migration adds it to M2 versions). Item
  and file names carry the range: `crudo [Denoised · frames 1088–1231]`.
- **PRC-016 (P0, M3)** Source-frame-exact swaps. File frame `i` of a media with a source range is frame
  `firstFrame + i` of its source (frames correspond by index: de-judder retimes the picture but keeps the frame
  count; the file, the source and the range's `frameRate` must share the rate, else the link is refused). The
  links compose up to the root original (versions of versions), so for any two versions of one original the
  content-time shift is `Δ = shift(from) − shift(to)` with `shift = firstFrame · F(rate)` per link.
  `clip.replaceSource` (and Media Version, the processing job's auto-swap, MCP `use_media_version`) moves
  everything the clip stores in content time by Δ — `sourceIn`, every keyframe (Motion, opacity, effect
  parameters), clip markers, tracker samples and reference times — and keeps `start`, `duration` and speed, so
  every timeline frame shows the same source frame (forward and reverse, any speed, sequence rate ≠ media
  rate). Swapping back applies −Δ and restores the clip exactly. Handles (TRN-003) follow from the new
  `sourceIn` and the new file's length: trims and transitions see what the file really holds; a transition
  that loses handles warns `W_TRANSITION_SHORTENED`. Markers / tracker samples that would fall before the new
  file's first frame are removed with a warning (content time cannot be negative there).
- **PRC-017 (P0, M3)** Coverage. A version that does not hold every source frame a clip shows is refused with
  `E_OUT_OF_MEDIA` naming the frames (`T02.mov holds frames 174–303 of crudo.mp4; clip … shows frames
  160–219 (14 before its first frame)`). `fit: 'trim'` trims the clip — and linked clips on unlocked tracks that
  share the trimmed edge — to the covered frames (transitions on a trimmed edge are removed); `fit: 'skip'`
  leaves that clip unchanged with `W_CLIP_SKIPPED` (used by the processing job's auto-swap when a clip changed
  while the job ran). The tolerance at the end of a file is 1/16 of a file frame (probe durations are rounded),
  never more than INV-005's.
- **PRC-018 (P0, M3)** Replace Footage (`media.relink {replace: true, locators, sourceRange?, keepSourceTiming?,
  fit?}`): replaces the file behind a media for every clip that uses it (a changed fingerprint is accepted
  without `force`; all locators are replaced). With `keepSourceTiming` every clip, project-item source mark and
  transcript of the media moves by the offset between the two files (`sourceTimingShift`): (1) both declare a
  source range of the same source → `old.firstFrame − new.firstFrame`; (2) only the new file declares one → the
  current file is taken to be that source (a warning when the names differ); (3) only the current file does →
  the new file is taken to be the source (back to the raw); (4) otherwise both start timecodes. Without a basis
  the command fails; without `keepSourceTiming` content time is kept. In both cases every clip is checked
  against the new file (PRC-017: `refuse` | `trim`). Processed versions are not replaced (process again).
- **PRC-019 (P0, M3)** Declared source ranges. `media.setSourceRange {mediaId, sourceRange | null}` records which
  source frames a file holds (origin `manual`), refusing self links, cycles and rate mismatches; a file whose
  range names a project media becomes one of its versions (`originalMediaId`, `mediaVersionsOf`). Source-range
  **sidecars** — `<file>.json` or `<stem>.json` next to the file — are read by the engine for files registered by
  path (`RegisteredMedia.sourceHint`) and by the web client for a `.json` picked/dropped with an uploaded video
  (`parseSourceSidecar`: `first_src_frame` | `firstFrame`, optional `frames`, `fps`, `handles` `[pre, post]` or
  `{pre, post}`, `source` / `src` / `spec.src`; jasper-proc's own sidecar). Imports record them as
  `sourceRange` (origin `sidecar`), resolving the source by file name among the project's media and the same
  import batch (never the same bytes).

## 4. Steps (PST)

### 4.1 Stabilise

- **PST-001 (P0)** `{op:'stabilize', method: 'auto'|'vidstab'|'deshake', smoothing (frames), borders:
  'crop'|'keep', shakiness?, rotation?}`. `vidstab` = libvidstab compiled to **WebAssembly** (PST-002a), the
  same code path on Linux, Windows and macOS; `auto` = vid.stab, falling back to `deshake` only when the WASM
  module cannot be loaded. *(Revised 2026-10-01, producer decision: vid.stab must work on all three OSes, not
  only through a Linux FFmpeg build.)*
- **PST-002 (P0)** vid.stab parameters (the trailer's proven "medium" preset): motion detection
  `shakiness=<s|5>:accuracy=15:stepsize=4:mincontrast=0.2` on the luma, downscaled to ≤ 960 px wide (the
  transforms are scaled back); camera path `smoothing=<n>:optalgo=gauss`, corrections capped at
  `maxshift = round(20 · width / 848)` px and `maxangle = 0.03` rad (`0` when `rotation` is false);
  `borders: 'crop'` = the smallest static zoom hiding the borders (vid.stab `optzoom=1`), `'keep'` = no zoom,
  black borders; bicubic interpolation.
  - **PST-002a (P0) WASM path (primary).** ffmpeg (LGPL) decodes the frames → vid.stab (WASM, SIMD) detects
    the local motions per frame and computes the smoothed per-frame corrections (x, y, angle, zoom) → jasper-proc
    applies them to the 16-bit RGB frames with vid.stab's geometry (rotation about the frame centre,
    translation, zoom) and bicubic kernel, in worker threads → ffmpeg encodes. No FFmpeg vid.stab filters
    needed. The module is built reproducibly by `scripts/vidstab-wasm/build.sh` (pinned wasi-sdk + vid.stab
    archive, sha256-checked) and committed as a separate, replaceable file
    (`apps/engine/src/processing/proc/vidstab/vidstab.wasm` + `VIDSTAB-WASM.json` with commit, archive sha256,
    toolchain, flags and module sha256, `LICENSE-vidstab.txt`, `NOTICE-vidstab.txt`); `JASPER_VIDSTAB_WASM`
    points at a user-rebuilt module (LGPL relinking).
  - **PST-002b (P1) FFmpeg path (optional, faster on Linux).** When the engine's FFmpeg is our LGPL source build
    with the pinned vid.stab (PST-003), `vidstabdetect`/`vidstabtransform` may be used instead (8-bit 4:4:4,
    same parameters), opted in with `JASPER_VIDSTAB_ENGINE=ffmpeg`; the engine checks `BUILDINFO.json` first.
    (Measured on 1080p: the WASM path is as fast or faster and keeps 16 bits, so it stays the default.)
- **PST-003 (P0)** **Licensing.** vid.stab was relicensed to LGPL-2.1-or-later in August 2026 (upstream master:
  `LICENSE`, `COPYING.LESSER`, `RELICENSE.md`, SPDX headers; issue #165). No release tag exists after the relicense
  (v1.1.2 and older are GPL). Therefore:
  1. `scripts/ffmpeg/manifest.json` pins a **post-relicense commit** of `georgmartius/vid.stab` (hash, commit date,
     links to `RELICENSE.md` and issue #165, sha256 of the source archive); the WASM build uses the same pin
     (`scripts/vidstab-wasm/manifest.json` must agree).
  2. The LGPL FFmpeg source build (`scripts/ffmpeg/build-lgpl-from-source.sh`, linux-x64 and macOS) builds
     libvidstab from that commit (builtin LP solver, never GLPK; no OpenMP) and applies a documented configure
     patch (`scripts/ffmpeg/patches/configure-libvidstab-lgpl.patch`) that moves `libvidstab` from
     `EXTERNAL_LIBRARY_GPL_LIST` to `EXTERNAL_LIBRARY_LIST` (FFmpeg 7.1 still lists it as GPL; FFmpeg's own
     `vf_vidstabdetect.c`, `vf_vidstabtransform.c`, `vidstabutils.c` are LGPL-2.1+). The build stays without
     `--enable-gpl`; `BUILDINFO.json` records `libvidstab: {commit, date, license: 'LGPL-2.1-or-later', …}`.
  3. The licence guard (`pnpm ffmpeg:check`) accepts `--enable-libvidstab` **only** when `BUILDINFO.json` records
     the pinned post-relicense commit; any other vid.stab build fails the guard.
  4. The About/Licenses screen lists libvidstab with its licence, commit and source link.
  5. Prebuilt LGPL builds without vid.stab (BtbN, Windows) stabilise with the WASM module
     (`features.processing.stabilize = 'vidstab'`); `deshake` only when the module is missing.
- **PST-004 (P0)** deshake (last resort): `deshake=edge=<clamp|blank>:rx=32:ry=32:blocksize=8:contrast=125`, then
  for `borders: 'crop'` a fixed centre crop + scale back of 4 % (deshake has no optimal zoom).

### 4.2 De-judder (frame cadence)

- **PST-010 (P0)** `{op:'dejudder', mode: 'auto'|'force', shift?}` corrects uneven frame cadence (e.g. 50 fps
  decimated to 30 fps: a 2-2-1 step pattern) **without changing the frame count** (cuts never move).
- **PST-011 (P0)** Cadence analysis: grey frames at ≤ 424 px wide; dense optical flow (Farnebäck) per frame pair;
  per-pair motion = 75th percentile of flow magnitude; steps normalised by a 3-tap moving mean; pairs valid when
  the local mean > 0.35 px; steps folded by `frameIndex mod 3`. Output: `shortPhase`, `shortToLongRatio`,
  `consistency` (share of aligned triples whose short step is in the same phase), mean motion (px at 1080p).
- **PST-012 (P0)** `auto` retimes only when consistency ≥ 0.8, short/long < 0.8, ≥ 30 % of pairs move and mean
  motion ≥ 4 px/frame; otherwise the step is a copy and the job note says why. `force` skips the thresholds but
  still needs a detected phase.
- **PST-013 (P0)** Retiming: in each 3-frame cycle the anchor frame is kept; the two others are moved by `shift`
  (default 1/6) of the inter-frame step towards their neighbours by **backward-warping the nearest real frame**
  along dense flow (flow at ≤ 960 px, upsampled; one fixed-point refinement of the flow lookup; cubic sampling,
  replicate borders). Frames are never blended (no ghosting). A scene-cut guard (mean absolute difference of the
  8×8-cell means > 0.10; cell means, not point samples, so fine texture in a fast pan is not taken for a cut) copies frames across cuts unchanged. One frame of context is read before and after.
- **PST-014 (P0)** Implementation: OpenCV.js (WASM, Apache-2.0, pinned) in worker threads inside `jasper-proc`.
  (A RIFE ONNX variant, MIT weights, is P2.)

### 4.3 Denoise and deblock

- **PST-020 (P0)** `{op:'denoise', method, strength 0…1}` with LGPL filters only (no `hqdn3d`, it is GPL):
  `atadenoise` (temporal, fast: thresholds `0a/1a/2a = 0.02 + 0.08·s`, `0b/1b/2b = 0.04 + 0.16·s`, `s=9`),
  `fftdnoiz` (medium: `sigma = 2 + 10·s`, `prev=1:next=1`), `nlmeans` (slow, strongest: `s = 1 + 7·s`, `p=7`, `r=15`).
- **PST-021 (P0)** `{op:'deblock', filter: 'weak'|'strong', block?}` → `deblock=filter=<f>:block=<b|8>`; placed
  before denoise when both are requested (the UI orders steps: deblock → denoise → de-judder → stabilise →
  upscale; agents may order freely). *(Revised 2026-10-01: de-judder before stabilise — vid.stab smooths the
  camera path per frame and hides most of a 2-2-1 cadence from the analysis: on crudo.mp4 37–40 s the short/long
  ratio went 0.52 → 0.86 and `auto` skipped the retiming; the trailer pipeline also de-juddered first.)*

### 4.4 Super-resolution upscale

- **PST-030 (P0)** Runtime: **ONNX Runtime** through `onnxruntime-node` (MIT), CPU execution provider locally;
  CUDA provider when available (remote GPU). Pinned version; the licence is recorded in the Licenses screen.
- **PST-031 (P0)** Model catalogue `apps/engine/src/processing/models.json`: id, name, architecture, scale,
  **weights licence** + attribution text, source URL, download URL, sha256, size. Models are **not** bundled; they
  install on demand (`POST /api/processing/models/:id/install` → `model-download` job) into `<appdir>/models/`
  and are verified by sha256. `GET /api/processing/models` lists them with `installed`.
- **PST-032 (P0)** Default catalogue entry (pending the user's decision, ARCHITECTURE §19.12): **SPAN 2×
  "2xNomosUni_span_multijpg"** (SPAN architecture, Apache-2.0 code; weights by Philip Hofmann, **CC BY 4.0 —
  attribution required**), converted by us to ONNX (opset 17, dynamic H/W). It was chosen in the trailer
  project because it does not invent text on UI screen recordings and is temporally stable; Real-ESRGAN-family
  models (BSD-3) were rejected there for hallucinated text and "boiling". The ONNX export script and its
  provenance live in `scripts/models/` (the weights are downloaded, never committed).
- **PST-033 (P0)** Inference: tiles of 256×256 input pixels with 16 px overlap and feathered blending (memory
  bound, any input size), fp32 on CPU, fp16 on CUDA when the model allows. After the model, optional resize to
  `size` (bicubic, antialiased) and optional `mix` with a Lanczos upscale (hybrid, reduces over-sharpening).
- **PST-034 (P0)** Tests never download weights: the test suite generates a tiny ONNX model (2× pixel-shuffle of
  a 1×1 conv, a few KB) and registers it through a test catalogue.

## 5. Remote execution over SSH (PRM)

- **PRM-001 (P0)** Settings (`GET/PUT /api/settings/processing`, stored in `<appdir>/engine/engine.json` →
  `processing`): `remote = {enabled, host, port, user, identityFile|null, remoteDir, useFor[],
  strictHostKeyChecking: 'accept-new'|'yes'}`. **Key-based auth only**; passwords are never stored or prompted.
- **PRM-002 (P0)** Transport: the system OpenSSH client (`ssh`, `scp`; `rsync` when present on both ends) run with
  argument arrays (never a shell string built from user input): `-o BatchMode=yes -o ServerAliveInterval=30
  -o StrictHostKeyChecking=<policy> -o ControlMaster=auto -o ControlPath=<appdir>/tmp/ssh-%C -o ControlPersist=60`
  `-p <port> [-i <identityFile>]`. Binaries are overridable (`JASPER_SSH`, `JASPER_SCP`, `JASPER_RSYNC`) — the
  tests use this to substitute local shims.
- **PRM-003 (P0)** Probe (`POST /api/processing/remote/probe`, also "Test connection"): runs one remote command that
  reports `node --version`, `ffmpeg -version`, `nvidia-smi --query-gpu=name --format=csv,noheader` (absent → no
  GPU), the installed `jasper-proc --version` (runtime ready / outdated) and the ONNX providers. Result
  `RemoteProbeResult`; stored as `features.processing.remote.lastProbe`.
- **PRM-004 (P0)** Setup (`POST /api/processing/remote/setup` → `remote-setup` job): creates
  `<remoteDir>/{bin,models,jobs}`, uploads `jasper-proc.mjs` (+ its `package.json` pinning `onnxruntime-node`),
  runs `npm install --omit=dev` there, uploads installed models the remote lacks (by sha256), and, when the remote
  has no ffmpeg, uploads the engine's LGPL linux-x64 FFmpeg directory. Requirements shown in the UI: Linux x64,
  Node ≥ 20, write access to `remoteDir`, optional NVIDIA driver + CUDA 12 for GPU.
- **PRM-005 (P0)** A remote job: (1) upload the input to `<remoteDir>/jobs/<jobId>/in.<ext>` (rsync `--partial
  --inplace` resumable; scp fallback restarts the file), skipping when the remote already has a file with the same
  fingerprint (content-addressed cache `<remoteDir>/cache/<fp>`); (2) write the spec; (3) run
  `jasper-proc run --spec …` with `setsid` and a pid file, streaming its stderr NDJSON back as job progress; (4)
  download the output (resumable), verify sha256 (from the sidecar) and frame count locally; (5) delete the remote
  job directory (the input cache is kept, LRU-trimmed at 20 GB).
- **PRM-006 (P0)** Cancel: `ssh … 'kill -TERM -$(cat pid)'` then local cleanup; a lost connection during run marks
  the job `failed` with `REMOTE_CONNECTION_LOST` (retryable; retry re-attaches if the remote process still runs —
  P1 — else restarts).
- **PRM-007 (P0)** `executor: 'auto'` runs remotely when remote is enabled, the last probe succeeded, and at least
  one step is in `useFor`; otherwise locally. A remote failure never silently falls back to local (the user
  retries with `executor: 'local'`).
- **PRM-008 (P0)** **Testing without a GPU** (the old rented GPU box no longer exists): the remote protocol is
  tested (a) always, with `JASPER_SSH`/`JASPER_SCP`/`JASPER_RSYNC` shims that execute locally in a temporary
  "remote" directory (protocol, resume, cancel, cleanup, error paths); (b) when `JASPER_TEST_SSH=user@host[:port]`
  is set (e.g. `127.0.0.1` with a local key, or a disposable Docker container running `sshd`), end-to-end over real
  SSH. In both, CUDA is reported unavailable and ONNX runs on CPU. A real-GPU run is a documented manual step
  (`docs/wp-notes/wp-m2-process.md`).
- **PRM-009 (P0)** Security: the host/user/identity come only from settings; paths on the remote are built from
  `remoteDir` + engine-generated ids; the identity file path is validated to exist locally; the engine never
  accepts a remote command string from clients or agents.

## 6. User interface (PRU)

- **PRU-001 (P0)** **Process Clip…** dialog, from the timeline clip menu (`clipMenuExtensions`), the Project item
  menu (`projectItemMenuExtensions`), the Clip menu and the command palette: step checkboxes in the fixed order of
  PST-021 with their options (presets Light/Medium/Strong for denoise; smoothing slider and borders for
  stabilise; model, scale and output size for upscale with the model's licence/attribution line and an Install
  button when missing), executor (Auto / This computer / Remote: <host>) with the probe status, estimated time,
  "Replace in timeline when done" (default on for clip entry points).
- **PRU-002 (P0)** Progress in the Jobs panel (stage per step, remote upload/download percentages). When done and
  "replace" was chosen, the client commits `media.derive` with `replaceInClips` (one undo entry "Process Clip").
- **PRU-003 (P0)** Clip-level switch: clips on a processed version show a small badge on the timeline clip
  (`clipMenuExtensions` + a clip section) and the Properties section **Media Version** (`clipSections`) with a
  dropdown "Original / <each processed version of the same original>" → `clip.replaceSource` (one undo entry).
- **PRU-005 (P0, M3)** Ranges in the UI. The Process Clip dialog opened for clips has *Frames: Clip range +
  handles* (default, 12 frames each side, editable) / *Whole media*, with the source frames it will process; the
  estimate uses that frame count. Media Version labels show the frames a version holds
  (`Denoised · frames 1088–1231`, `T02.mov · frames 174–303`) and the selected clip's handles; choosing a version
  that does not cover the clip asks to trim it (one undo entry). **Clip ▸ Replace Footage…** (and the Project
  item menu) opens a dialog: current file, *Choose File…* (desktop: native picker, registered in place; web:
  upload, a sidecar may be picked with it), the sidecar / timecode found, *Keep source timing* (on when a basis
  exists) with the in-point shift, the clips the new file does not hold with *Trim them*; **Replace** commits
  one undo entry "Replace Footage".
- **PRU-004 (P0)** **Preferences ▸ Processing** page: remote executor settings (PRM-001), Test connection
  (PRM-003 result rendered), Set up remote (PRM-004 job), local slots, installed models with sizes and licences
  (install/remove). This package also creates the Preferences dialog shell (`app.preferences`, currently
  unregistered) with a page registry so later pages can be added.

## 7. Agents (PRA)

- **PRA-001 (P0)** MCP tools (`apps/mcp/src/tools/processing.ts`):
  - `list_processing_models {}` / `install_processing_model {modelId}` (job);
  - `process_clip {projectId, clipId | mediaId, steps, executor?, replace?: boolean}` → job id; with
    `wait: true` it waits (bounded like `wait_for_job`) and, when `replace` is set, commits the swap;
  - `use_media_version {projectId, clipIds, mediaId}` (original or any processed version, PRC-006);
  - `get_processing_settings {}` / `set_processing_settings {remote}` (needs the user's approval in an open editor,
    like destructive commands, because it changes where media is sent);
  - `test_remote_executor {}`.
- **PRA-002 (P0)** `get_media_info` includes `derivation` and the list of processed versions of a media item.
- **PRA-003 (P0, M3)** Source ranges for agents: `process_clip {handles: N | range}` processes the clip's frames
  plus handles (or an explicit range) and reports `range` / `sourceFrames`; `process_clip` and
  `use_media_version` take `fit: refuse | trim | skip`; `replace_footage {mediaId, path, keepSourceTiming?
  (default true), fit?}`; `set_media_source_range {mediaId, sourceMediaId | null, firstFrame, frames?, clear?}`;
  `import_media` records sidecar ranges; `get_media_info` adds `sourceRange` and each version's `sourceFrames`.

## 8. Acceptance tests

1. **Model**: `media.derive` creates asset + item and swaps clips in one transaction; `clip.replaceSource` back to
   the original restores Motion exactly (property test over random scales/anchors/keyframes, PRC-006); invariants
   hold; undo/redo.
2. **Frame count** for every step on `fixtures/media/clip-b.mp4` (6 s 720p25): output frames = input frames,
   same rate, audio copied bit-exact (`-c:a copy` hash).
3. **Stabilise**: a synthetic shaky clip (`pnpm fixtures` gains `shaky.mp4`: a 1080p test chart panned with a
   seeded random walk of ±24 px) — the global inter-frame motion (phase correlation) variance drops ≥ 60 % with
   vid.stab and ≥ 40 % with deshake; `pnpm ffmpeg:check` passes with the vid.stab build and fails for a build
   recording any other libvidstab commit.
4. **De-judder**: a synthetic 50→30 fps decimated pan (`judder.mp4`) is detected (consistency ≥ 0.8) and after
   processing the per-pair motion steps' coefficient of variation drops ≥ 50 %; a steady 30 fps pan is left
   unchanged in `auto` mode (note "no cadence found").
5. **Denoise/deblock**: noise sigma of a noisy flat patch drops ≥ 40 % (medium); deblock reduces 8×8 blockiness of
   an over-compressed fixture (block-edge gradient metric) ≥ 25 %.
6. **Upscale** with the generated test model: 2× size exactly, tiles seamless (no seam > 1/255 on a gradient),
   `mix` blends linearly.
7. **Remote** with shims (always) and real SSH when `JASPER_TEST_SSH` is set: probe, setup, process, resume after
   an interrupted upload, cancel kills the remote process group and leaves no job directory; CUDA reported
   unavailable, ONNX on CPU.
8. **Export**: a sequence using a processed version exports on the native path reading the ProRes file; the
   planner shows no blocker.
9. **UI**: Process Clip dialog → job → swap is one history entry; Media Version dropdown swaps and undoes;
   Preferences ▸ Processing saves settings and renders a probe result.
10. **MCP**: `process_clip` (denoise, local, `replace: true`, `wait: true`) on the fixture project returns the
    processed media id and the clip now references it; `test_remote_executor` without settings returns a clear
    "not configured" error.
11. **Source ranges (M3)**: property tests over random sources, rates (24/25/29.97/30/60), clip speeds, reverse,
    handles and keyframes/markers: after a swap onto a range every timeline frame shows the same source frame,
    start/duration are unchanged, and swapping back restores the clip exactly; coverage refuse/trim/skip; Replace
    Footage by sidecar range, back to the raw, and by timecode; the v5 fixture loads. Engine: a ranged process of
    `frame-code.mp4` holds exactly frames 12…47; a clip swapped onto it (and back) exports the same frame codes
    on the native path; a sidecar next to a registered file is reported. MCP: `process_clip {handles}`,
    `use_media_version {fit}`, sidecar import, `set_media_source_range`, `replace_footage`. E2E: process a
    sub-range with handles from the UI, swap, `render_frame` shows the same frame codes at several frames, swap
    back; Replace Footage keeps source timing.

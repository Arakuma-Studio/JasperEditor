# Spec 04: Media ingest, render pipeline and engine backend

Status: functional spec, v1 (2026-09-30). Audience: engineers who implement `apps/engine`, the media/render parts
of `apps/web`, `packages/api` contracts, and the native helpers (`ffmpeg`, `whisper.cpp`, fframes).

This spec is **original work** written for JasperEditor. It describes behavior, data concepts and algorithms. It
does not reuse code, identifiers, file layouts or comments from any purchased template. Implementers work from
this document, `docs/research/*` and `docs/ARCHITECTURE.md` only.

Related documents (ours):

- `docs/research/native-video-libraries.md`: ffmpeg/whisper.cpp recipes, benchmarks, licensing of native binaries.
- `docs/research/fframes.md`: fframes engine, template library design, alpha pipeline, WASM preview.
- `docs/research/orquester-multiplatform-setup.md`: monorepo shape, engine process model, Electron shell, PWA.
- `docs/research/premiere-ui-design-spec.md`: Premiere-style panels (Project, Media Browser, Jobs, Text, Export mode).
- Sibling specs in `docs/specs/` own the timeline/document model, the editing UI and the canvas. Where this spec
  needs a document-model field it states the requirement; the data-model spec owns the final field names.

---

## 0. How to read this spec

- Requirements have IDs `<AREA>-<NNN>` and a priority:
  - **P0**: required for the first usable release (desktop offline editing + export).
  - **P1**: required for "Premiere parity" v1.
  - **P2**: planned, build after P1.
  - **P3**: exploratory.
- "**Must**" is mandatory, "**should**" is a strong default that may be changed with a written reason.
- "The engine" means `apps/engine`, our Node media server (Fastify). "The client" means the React app in
  `apps/web` running in a browser tab, an installed PWA, or an Electron window.
- "Beyond template" boxes mark places where JasperEditor deliberately exceeds what the reference template offered.

Area prefixes:

| Prefix | Area | Section |
|---|---|---|
| RT | Runtime profiles and capability discovery | 2 |
| ENG | Engine service (process, auth, config, binaries) | 3 |
| AS | Asset model and storage | 4 |
| IN | Ingest (import/upload) | 5 |
| PB | Probing | 6 |
| PX | Proxies | 7.1 |
| TH | Thumbnails, posters, filmstrips | 7.2 |
| WF | Waveform peaks | 7.3 |
| AN | Media analysis (keyframes, loudness, silence, scenes) | 7.4 |
| CA | Derived-artifact cache | 7.5 |
| MS | Media serving | 8 |
| TR | Transcription and captions | 9 |
| EX | Export settings and UX | 10 |
| RP | Render planner (engine selection) | 11 |
| RN | Native ffmpeg render paths | 12 |
| RR | Local Remotion render | 13 |
| RW | Browser (client-side) render | 14 |
| MG | fframes motion-graphics intermediates | 15 |
| RC | Optional cloud providers | 16 |
| JB | Job queue and progress | 17 |
| FT | Fonts for preview and render | 18 |
| API | HTTP routes and events | 19 |
| AG | Agent control | 20 |
| OF | Offline and credential-free operation | 21 |
| SC | Security | 22 |
| LC | Licensing and compliance | 23 |
| QA | Test corpus and acceptance matrix | 24 |

---

## 1. Goals and principles

1. **Local-first.** Every feature in this spec works on the desktop app with no network and no cloud credentials
   (except explicitly cloud-only providers, which are always optional). Cloud storage, cloud rendering and cloud
   speech-to-text are pluggable providers, never prerequisites.
2. **Three engines, one pipeline.** Remotion (React compositions, Player preview, graphics rendering), native
   ffmpeg (probing, proxies, thumbnails, waveforms, cuts, transcodes, final compositing and encoding) and fframes
   (CPU-rendered SVG motion graphics) are combined by a **render planner** that chooses the fastest path that is
   still frame-correct for a given export.
3. **Preview equals export.** Whatever path the planner picks, the exported frame must match what the Program
   monitor shows, within the tolerance defined in QA-004.
4. **Progressive readiness.** An imported clip is editable as soon as it is probed. Proxies, thumbnails, waveforms
   and transcripts arrive later and the UI upgrades in place. Nothing blocks saving the project.
5. **Everything is a job.** Every long-running operation (upload, probe, proxy, waveform, transcription, export,
   motion-graphic render, model download) is a job with the same state machine, progress events, cancel and retry,
   visible in one Jobs panel and controllable by agents.
6. **Same API for humans and agents.** Every action the UI can trigger in this area is an engine API call with a
   typed contract in `packages/api`. The agent tool layer calls the same contracts.
7. **One origin.** In every runtime the client talks to the engine over same-origin HTTP (`/api`, `/media`,
   `/events`). There is no byte-streaming IPC bridge.

> **Beyond template (summary).** The reference template required a cloud object store for every imported file
> (and refused to save a project when uploads failed), rendered in a cloud function by default (browser rendering
> was an opt-in flag, with no cancel and a fixed 30 fps), transcribed only through a cloud API with a ~13 minute
> cap after decoding the whole file inside the browser tab, computed filmstrips and waveforms in the browser only,
> had no proxies, loaded fonts only from an online CDN, and exposed unauthenticated routes. Section 25 lists every
> difference.

---

## 2. Runtime profiles and capability discovery (RT)

### 2.1 Profiles

| Profile | Client | Engine | Media lives in | Typical use |
|---|---|---|---|---|
| **D: Desktop** | Electron window loading the SPA from the local engine | local `apps/engine` child process, loopback, per-launch token | user's own files (referenced by path) + project folder | primary product; fully offline |
| **WE: Web + engine** | browser tab or installed PWA | remote engine (VPS or a home machine), password login | engine's project storage (uploaded) | team/server use, phones and tablets |
| **W: Web only** | browser tab or installed PWA | none reachable | browser storage (OPFS/IndexedDB) or file handles | quick edits, demo, no install |
| **M: Mobile PWA** | phone/tablet PWA | remote engine (same as WE) or none (same as W, reduced) | as WE or W | review, light edits, one-tap export |

- **RT-001 (P0)** The client must detect its profile at startup: desktop if the preload bridge object is present;
  otherwise probe `GET /health` on the same origin (or the configured engine URL). If it answers, the profile is WE,
  otherwise W.
- **RT-002 (P0)** The client must fetch `GET /api/capabilities` after authenticating and merge it with locally
  detected browser capabilities (section 2.2) into one **effective capability set** held in a non-undoable client
  store.
- **RT-003 (P0)** Every UI control in this spec that depends on a capability must be hidden or disabled when the
  capability is absent, and the disabled state must explain why in its tooltip (for example "Requires the
  JasperEditor engine", "Download a transcription model in Settings", "Add an OpenAI key in Settings ▸ Providers").
- **RT-004 (P1)** The engine must emit a `capabilities.changed` event when a capability changes at runtime (model
  downloaded, provider key added, headless browser installed). The client must re-fetch and update without reload.
- **RT-005 (P1)** In profile W the client must implement the browser-only fallback engine (section 2.3) behind the
  same TypeScript interface the engine client uses, so feature code does not branch on the profile.

### 2.2 Capability set (data concept)

```ts
// packages/api: our own contract (illustrative; exact names owned by packages/api)
type EffectiveCapabilities = {
  profile: 'desktop' | 'web-engine' | 'web-only';
  engine?: {
    version: string; apiVersion: number; mode: 'local' | 'remote';
    storage: {pathReferences: boolean; managedCopies: boolean; remoteProviders: string[]};
    media: {ffmpegVersion: string; videoEncoders: string[]; audioEncoders: string[]; filters: string[]};
    render: {
      native: boolean;                       // ffmpeg composite + stream-copy paths
      remotionLocal: 'ready' | 'needs-browser-download' | 'unavailable';
      fframes: 'ready' | 'unavailable';
      cloud: string[];                       // configured cloud render providers, usually []
    };
    transcription: Array<{provider: string; ready: boolean; models: string[]; defaultModel?: string}>;
    fonts: {bundledCatalog: boolean; systemFonts: boolean; customUpload: boolean};
    limits: {maxUploadBytes: number | null; freeDiskBytes: number; cpuCount: number};
  };
  browser: {
    webCodecs: boolean; encodableVideoCodecs: string[];   // from VideoEncoder.isConfigSupported probes
    opfs: boolean; fileSystemAccess: boolean; crossOriginIsolated: boolean;
    storageQuotaBytes: number | null;
  };
};
```

- **RT-006 (P0)** The browser section must be computed by actually probing WebCodecs encoder/decoder support for
  the codecs the export presets use (H.264 High/Main at 1080p, VP9, VP8, AV1, AAC, Opus), not by user-agent sniffing.

### 2.3 Browser-only fallback (profile W)

- **RT-010 (P1)** Import stores media either as a **file handle** (File System Access API, Chromium; no copy, the
  permission is re-requested when the project is reopened) or as a **copy in OPFS** (other browsers, or when the user
  picks "Copy into browser storage"). IndexedDB is used only for small items and handles, not for multi-GB blobs.
- **RT-011 (P1)** Probing, thumbnails and waveform peaks run in a Web Worker using mediabunny/WebCodecs and must
  produce the **same data contracts** as the engine (sections 6, 7.2, 7.3) so the timeline code is shared.
- **RT-012 (P1)** Export uses the browser render path (section 14). Transcription is unavailable unless the in-
  browser whisper provider is enabled (TR-042, P2). Native and fframes-master paths are unavailable. Motion graphics
  preview and export through the WASM SVG path (MG-020).
- **RT-013 (P1)** Before each import in W, the client must check `navigator.storage.estimate()` and warn when the
  copy would exceed 80% of the quota. It must call `navigator.storage.persist()` once per origin and show the result
  in Settings.

---

## 3. Engine service (ENG)

### 3.1 Process model

- **ENG-001 (P0)** The engine is a standalone Node process (`apps/engine`), started:
  - desktop: by the Electron main process via `utilityProcess.fork` with `--port 0` (random free port), reporting
    readiness and its port to the parent; in development the desktop attaches to a running dev engine on the fixed
    port 47900 instead;
  - server: by systemd on `127.0.0.1:47900` behind a TLS reverse proxy.
- **ENG-002 (P0)** Heavy work never runs in the engine's event loop thread. ffmpeg, ffprobe, whisper.cpp, the fframes
  renderer and the headless browser run as **child processes**. JavaScript-heavy work (peak reduction for long files,
  OTIO conversion, filtergraph generation for thousands of items) runs in `worker_threads`.
- **ENG-003 (P0)** The engine serves the built SPA (`apps/web` client build) with SPA fallback, so the Electron
  window and remote browsers load the app from the engine origin.
- **ENG-004 (P0)** Graceful shutdown: on SIGTERM or parent exit the engine stops accepting jobs, cancels running jobs
  (JB-020 semantics, but recorded as `interrupted`), flushes the job journal and exits within 5 s.

### 3.2 Configuration and directories

- **ENG-010 (P0)** The engine resolves an **appdir** from `--appdir`, else `JASPER_APPDIR`, else the platform
  default (desktop: Electron `userData/jasper`; server: `/var/lib/jasper`). Layout (conceptual):

  ```
  <appdir>/
    engine/engine.json          # engine config (zod-validated, unknown keys tolerated)
    engine/jobs.jsonl           # job journal (JB-030)
    engine/logs/YYYY-MM-DD.log
    projects/<projectId>/       # project documents + managed media (server profile, and desktop "copy media")
      media/<assetId>.<ext>
    cache/<fingerprint>/        # derived artifacts, content-addressed (CA-001)
    models/                     # whisper and VAD models (TR-020)
    browser/                    # headless browser for Remotion if not bundled (RR-010)
    fonts/                      # user-installed custom fonts (FT-020)
    tmp/                        # job scratch; wiped on start
  ```

- **ENG-011 (P0)** Native binaries (`ffmpeg`, `ffprobe`, `whisper-cli`, the fframes template renderer) are resolved
  in this order: explicit env var (`JASPER_FFMPEG`, `JASPER_FFPROBE`, `JASPER_WHISPER`, `JASPER_MG`), then the
  packaged resources folder, then `PATH` (development only). The engine must run a **self-check** at startup:
  version, required encoders and filters present (at least `libx264` or an allowed H.264 alternative, `aac`,
  `prores_ks`, `libvpx-vp9`, and the filters `trim`, `atrim`, `overlay`, `amix`, `scale`, `fps`, `tile`,
  `silencedetect`, `scdet`, `ebur128`, `loudnorm`). Missing items reduce capabilities; they must not crash the engine.
- **ENG-012 (P0)** Configuration changes (provider keys, concurrency, cache quota) apply **without restarting** the
  engine. Validation failures are reported per setting and never cached as a permanent failure.
  > **Beyond template:** the reference validated all cloud settings as one block, lazily, and remembered a failure
  > until the process restarted, so a missing storage bucket also disabled captions and rendering.

### 3.3 Auth, transport, errors

- **ENG-020 (P0)** Local mode (desktop): bind `127.0.0.1` only; require either `Authorization: Bearer <token>` or
  an HttpOnly, SameSite=Strict session cookie holding the per-launch 32-byte random token that the Electron main
  process sets before loading the window; reject requests whose `Host` is not `127.0.0.1:<port>` or
  `localhost:<port>` (DNS-rebinding defense).
- **ENG-021 (P0)** Remote mode (server): username/password login producing a bearer/session; escalating per-IP
  throttling on failures; only `/health` and the login-info route are public.
- **ENG-022 (P0)** All errors use one JSON shape: `{code: string, message: string, detail?: unknown, retryable:
  boolean}` with stable machine codes (for example `ASSET_NOT_FOUND`, `UNSUPPORTED_MEDIA`, `DISK_FULL`,
  `PROVIDER_NOT_CONFIGURED`, `JOB_CANCELLED`, `BINARY_MISSING`, `QUOTA_EXCEEDED`). The UI maps codes to messages;
  agents read codes.
- **ENG-023 (P0)** Real-time updates use `GET /events`, an NDJSON stream (section 19.3). The engine sends a
  heartbeat every 15 s; the client reconnects with exponential backoff (1 s → 30 s) and resumes with
  `?since=<lastEventId>`.
- **ENG-024 (P1)** API versioning: every response carries `x-jasper-api: <n>`. The client refuses to operate
  (with an "update the app" screen) when the engine's major API version differs from its own.

---

## 4. Asset model and storage (AS)

### 4.1 Concepts

An **asset** is a piece of source media known to a project. A **clip** (timeline item) references at most one asset;
many clips may reference the same asset. Assets are part of the undoable project document. Their **runtime status**
(upload progress, probe state, artifact readiness) is **not** undoable and not saved in the document.

```ts
// Conceptual shape (final names owned by the data-model spec)
type MediaAsset = {
  id: string;                          // uuid, issued by client (W) or engine (D/WE)
  kind: 'video' | 'audio' | 'image' | 'animated-image' | 'caption' | 'font' | 'motion-graphic-render';
  name: string;                        // display name, editable (Project panel rename)
  originalFileName: string;
  byteSize: number;
  mimeType: string;
  fingerprint: string;                 // CA-001 content fingerprint
  storage: AssetStorage;
  probe: ProbeSummary | null;          // section 6; null until probed
  labelColor?: string;                 // Premiere label (UI spec)
  importedAt: string;                  // ISO time
};

type AssetStorage =
  | {type: 'path-reference'; path: string; mtimeMs: number}         // desktop: user's file, never moved or deleted
  | {type: 'managed'; relativePath: string}                           // inside the project folder (upload or "copy media")
  | {type: 'remote'; provider: string; objectKey: string}             // optional cloud storage provider
  | {type: 'browser-handle'; handleKey: string}                       // W: FileSystemFileHandle stored in IndexedDB
  | {type: 'browser-copy'; opfsPath: string};                         // W: copy in OPFS
```

Runtime status (non-undoable, per asset):

```
registering ─► uploading(progress) ─► probing ─► ready
     │               │                   │         │
     └────────► failed(code, retryable) ◄┘         └─► offline (file missing/changed) ─► ready (after relink)
```

plus a per-artifact status map: `{proxy_720: 'queued'|'running'|'ready'|'failed', peaks: …, sprite: …, keyframes: …,
transcript: …}`.

### 4.2 Requirements

- **AS-001 (P0)** An asset is **editable** (can be placed and trimmed on the timeline, previewed) as soon as it is
  `ready` (probed). Artifacts are optional enhancements.
- **AS-002 (P0)** Saving a project must **never** be blocked by asset status. Assets in `uploading`, `failed` or
  `offline` are saved with their storage descriptor; on reopen, interrupted uploads resume (IN-012) and missing files
  show as offline (AS-010).
  > **Beyond template:** the reference refused to save whenever any asset upload had failed, which made saving
  > impossible without cloud credentials.
- **AS-003 (P0)** The desktop profile must **never modify, move or delete** files referenced by `path-reference`.
  The "Copy media into project" import option (IN-004) creates a `managed` copy instead.
- **AS-004 (P0)** The engine is the only authority that maps an asset id to bytes on disk. Clients and agents
  address assets by id only. The engine rejects any request that tries to read or delete by raw path or storage key
  (SC-003).

### 4.3 Offline media and relink (Premiere parity)

- **AS-010 (P1)** On project open and whenever a job touches a `path-reference` asset, the engine checks the file
  exists and that size and mtime match. If not, the asset becomes `offline`. Clips of offline assets render in
  preview and export as a Premiere-style "Media Offline" frame (solid dark red with centered white text; exact
  visuals in the UI spec) and silent audio. Export must warn before starting if any used asset is offline and let the
  user cancel or continue.
- **AS-011 (P1)** Relink: the user picks a replacement file (or a folder to search). The engine accepts it when its
  fingerprint matches, or, if it does not match, when the user confirms after seeing a diff of duration, resolution,
  frame rate and audio layout. Folder search matches by file name first, then by fingerprint, and relinks every
  offline asset it can in one batch ("Locate all").
- **AS-012 (P1)** If a relinked file's duration is shorter than a clip's used source range, the clip keeps its
  range but the missing tail is marked as offline frames; the UI shows a warning badge on the clip.

### 4.4 Deletion and garbage collection

- **AS-020 (P0)** Removing an asset from the project (or deleting all clips that use it) does not delete bytes
  immediately. The asset becomes a **tombstone** in the document so undo can restore it.
- **AS-021 (P1)** Garbage collection runs when a project is closed, and on demand ("Project ▸ Remove unused media
  files"). It deletes managed copies and remote objects of tombstoned assets that are unreachable from the current
  document **and** from the undo history. Path references are never deleted (AS-003). Derived artifacts are left
  to cache eviction (CA-003).
- **AS-022 (P1)** GC runs as a job, is idempotent and records what it deleted in the engine log.
  > **Beyond template:** the reference kept a list of deleted assets but never removed the uploaded objects.

---

## 5. Ingest (IN)

### 5.1 Entry points

All entry points converge on the same engine operations (register a path, or upload bytes) and the same UI
feedback.

| Entry point | Profiles | Notes |
|---|---|---|
| Drag and drop onto Project panel, timeline, or Program monitor | all | drop on timeline places a clip at the drop frame and track (timeline spec) |
| File ▸ Import (Ctrl/Cmd+I) native dialog | D | returns paths through the preload bridge; no bytes cross IPC |
| File picker / File System Access picker | WE, W, M | bytes are uploaded (WE) or stored locally (W) |
| **Import mode** (full-screen ingest view) and **Media Browser** panel | D (native FS), W (File System Access), WE (engine "media roots", IN-006) | multi-select with hover-scrub thumbnails |
| Paste (Ctrl/Cmd+V) of files or images from clipboard | all | images from clipboard are saved as PNG assets |
| Import from URL | WE, D (P2) | engine downloads; SC-010 applies |
| Agent tool `media.import` | all with engine | same validation as the UI |

### 5.2 Requirements

- **IN-001 (P0)** Supported inputs (P0): containers MP4/MOV/M4V, MKV/WebM, AVI, MPEG-TS/M2TS, MXF (engine only);
  video codecs decodable by the bundled ffmpeg; audio WAV/AIFF/MP3/AAC/M4A/FLAC/OGG/Opus; images PNG/JPEG/WebP/
  AVIF/HEIC (engine only for HEIC)/BMP/TIFF/SVG; animated GIF/WebP/APNG; caption files SRT/VTT (become caption
  assets, TR-060). Anything ffprobe can open with at least one video or audio stream is accepted by the engine even
  if not listed.
- **IN-002 (P0)** File type detection uses **magic bytes first**, then the probe result, and the extension only as a
  hint. A mismatched extension must not cause rejection. Unknown or unreadable files produce a per-file error in the
  import summary; other files in the same batch continue.
- **IN-003 (P0)** Desktop import registers the file **by path** (no copy). Registration returns within 200 ms for
  local disks; probing then runs as a high-priority job.
- **IN-004 (P1)** Import settings (Import mode right column, remembered per user): "Copy media into project folder"
  (desktop), "Create bin from folder", "Create sequence from selection", "Create proxies" (off / 720p / 540p /
  auto), "Generate thumbnails and waveforms" (on by default), "Transcribe speech" (off by default).
- **IN-005 (P0)** Web/PWA upload with an engine (WE) uses a **resumable chunked protocol** (section 19, uploads):
  create an upload session with name, size and client fingerprint, send chunks of 8 MiB with byte offsets, finalize.
  The engine checks free disk space before accepting a session (`DISK_FULL`), streams chunks straight to disk, and
  verifies the final size. Per-file progress, speed and remaining time are shown in the Jobs panel.
- **IN-006 (P2)** Server media roots: an operator can configure read-only folders on the server (NAS mounts) that
  remote users browse in the Media Browser and register by path, without uploading.
- **IN-007 (P0)** Duplicate detection: if an imported file's fingerprint equals an existing asset's, the user is
  asked "Use existing / Import again" (remembered for the batch). Agents get the existing id unless they pass
  `allowDuplicate`.
- **IN-008 (P0)** Sequence-settings match: when the first visual clip is added to an empty sequence, and its
  resolution or frame rate differ from the sequence, show Premiere's **Clip Mismatch** prompt: "Change sequence
  settings" (adopt the clip's display width, height and frame rate) or "Keep existing settings". Agents choose
  explicitly via a parameter; the default for agents is "keep".
  > **Beyond template:** the reference silently resized the composition to the first item, and had no frame-rate
  > concept beyond a fixed 30 fps.
- **IN-009 (P0)** Batch import is processed with bounded parallelism (probe up to 4 files at once) and shows one
  aggregated job ("Importing 37 files", with child jobs per file).
- **IN-010 (P1)** Image sequences: a folder or selection of numbered stills (`name_0001.png`, …) can be imported as
  one video asset at a user-chosen frame rate (default: sequence frame rate).
- **IN-011 (P0)** Automatic follow-up jobs after a successful probe, in this order and priority: keyframe index
  (video), poster frame, waveform peaks (if audio), thumbnail sprite, proxy (if IN-004 or PX-003 applies),
  transcription (if requested). Each is deduplicated by fingerprint (CA-001) so re-importing is free.
- **IN-012 (P1)** Interrupted uploads (tab closed, network loss) resume from the last acknowledged byte when the
  project is reopened in the same browser and the original file is still available (via stored file handle, or by
  asking the user to pick the file again; the fingerprint must match).
- **IN-013 (P0)** Web (WE/W): while an upload or other client-side job is running, closing the tab must trigger the
  browser's "leave page?" confirmation. Engine-side jobs do not need this because they continue on the server.

### 5.3 Acceptance criteria (ingest)

1. Desktop, offline: importing a 4 GB 4K H.264 MOV by drag and drop shows the clip in the Project panel in under
   1 s, is placeable on the timeline after probing (under 2 s), and a poster, waveform and filmstrip appear within
   10 s on the reference 12-core machine without further user action.
2. Importing a batch of 20 files where 2 are corrupt yields 18 assets and a summary listing the 2 failures with
   reasons; nothing else is blocked.
3. WE: uploading a 2 GB file over a link that drops mid-way resumes without restarting from zero.
4. Saving immediately after import (before artifacts or uploads finish) succeeds, and reopening resumes pending work.

---

## 6. Probing (PB)

- **PB-001 (P0)** The engine probes with `ffprobe` (JSON output of format, streams, chapters) and derives a
  normalized **ProbeSummary**. In profile W the worker derives the same summary with mediabunny.

```ts
type Rational = {num: number; den: number};            // e.g. 30000/1001
type ProbeSummary = {
  container: string; durationSec: number; bitRate?: number; startTimeSec: number;
  timecodeStart?: string;                               // from tmcd / tags, for Premiere-style source timecode
  creationTime?: string;
  video?: {
    codec: string; profile?: string; pixelFormat: string; bitDepth: number; hasAlpha: boolean;
    codedWidth: number; codedHeight: number;
    rotation: 0 | 90 | 180 | 270;                       // from display matrix side data
    displayWidth: number; displayHeight: number;       // after rotation and sample aspect ratio
    sampleAspect: Rational; frameRate: Rational; isVariableFrameRate: boolean; frameCount?: number;
    interlaced: 'progressive' | 'tff' | 'bff' | 'unknown';
    color: {primaries?: string; transfer?: string; matrix?: string; range?: 'tv' | 'pc'};
    isHdr: boolean;                                     // PQ or HLG transfer
  };
  audio: Array<{index: number; codec: string; sampleRate: number; channels: number; layout?: string;
                language?: string; durationSec: number}>;
  image?: {width: number; height: number; exifOrientation?: number; frames?: number /* animated */};
  browserPlayable: 'yes' | 'no' | 'unknown';           // PB-004
};
```

- **PB-002 (P0)** Variable frame rate is detected when the average and nominal rates differ by more than 0.1%, or
  when sampled frame intervals vary. VFR assets get a badge; export always normalizes them to the sequence frame rate.
- **PB-003 (P0)** Display dimensions account for rotation metadata and EXIF orientation (orientations 5–8 swap width
  and height). Every consumer (canvas, proxy, export) must see upright frames.
- **PB-004 (P0)** `browserPlayable`: the engine sets a first guess from a codec allow-list (H.264 8-bit 4:2:0, VP8,
  VP9, AV1, and HEVC only where the client reports support; AAC, MP3, Opus, FLAC, PCM). The client confirms by asking
  WebCodecs whether it can configure a decoder for the exact codec string, and reports the result to the engine.
  Assets that are not browser-playable (ProRes, DNxHR, 10-bit 4:2:2 H.264, MPEG-2, interlaced sources, MXF, most
  AVI) get a **mandatory proxy** (PX-003).
- **PB-005 (P0)** Audio-only files with cover art are audio assets (the cover image is ignored). Video files with
  several audio streams expose each stream; the default clip uses the first stream, and the Properties panel lets
  the user choose (P1).
- **PB-006 (P1)** Probing a 2-hour file must finish in under 2 s on the reference machine (no full decode). Frame
  counts come from container metadata only, never from counting frames at probe time.

---

## 7. Derived artifacts

### 7.1 Proxies (PX)

Premiere's proxy workflow: lightweight copies used for smooth preview, swapped for originals at export.

- **PX-001 (P0)** Proxy tiers: `720` (default) and `540` ("low"), H.264 8-bit 4:2:0, short GOP (keyframe every 15
  frames, no scene-cut keyframes) for fast scrubbing, frame rate equal to the source, `+faststart`, AAC 128 kb/s
  stereo audio. Rotation is **baked in** (pixels rotated, rotation metadata cleared). HDR sources are tone-mapped to
  SDR Rec.709. Interlaced sources are deinterlaced. Alpha sources (ProRes 4444, PNG MOV) get a VP9-with-alpha WebM
  proxy instead.
- **PX-002 (P0)** A global **Toggle Proxies** control (Program monitor button and Timeline wrench menu, as in
  Premiere) switches preview between proxies and originals. The playback-resolution selector (Full, 1/2, 1/4) maps
  Full to originals and lower settings to proxy tiers.
- **PX-003 (P0)** Mandatory proxies: assets with `browserPlayable = no` always preview from a proxy regardless of
  the toggle. Until the proxy exists, their clips show the poster frame with a progress overlay in the Program
  monitor instead of failing.
- **PX-004 (P0)** Preview source resolution order for a clip: (1) proxy of the selected tier when proxies are on or
  mandatory and ready; (2) the original when browser-playable; (3) the other proxy tier if ready; (4) poster frame
  placeholder. Export always uses originals (PX-006).
- **PX-005 (P1)** Proxy creation is available on demand from the Project panel context menu ("Proxy ▸ Create
  Proxies…", "Attach Proxies…" to link externally made proxies whose duration and frame rate match, "Reveal Proxy")
  and automatically per IN-004. Proxy jobs run in the background lane (JB-011) with at most 2 concurrent jobs.
- **PX-006 (P0)** Exports use original media unless the user picks the "Draft (use proxies)" export option (EX-012),
  which is labelled as low quality.
- **PX-007 (P1)** Clips whose preview source is a proxy show a proxy badge on the timeline when "Show Proxies badge"
  is enabled in the timeline display settings.
- **PX-008 (P2)** Browser-side proxies (profile W): mediabunny conversion in a Worker using hardware WebCodecs
  encoders, same tiers where possible.

Acceptance: a 60 s 1080p30 H.264 source produces a 720p proxy in under 10 s on the reference machine; toggling
proxies during playback switches source within one second without changing the playhead frame.

### 7.2 Thumbnails, posters and filmstrips (TH)

- **TH-001 (P0)** Poster frame per visual asset: JPEG 320 px wide from a representative frame (default: the frame at
  10% of duration, skipping black frames). The user can set the poster frame from the Source monitor (Premiere's
  "Set Poster Frame").
- **TH-002 (P0)** Filmstrip sprite: frames sampled at an adaptive interval (one per keyframe for short-GOP media; one
  every `max(1 s, duration / 200)` otherwise), each 160 px wide at the display aspect ratio, packed into JPEG sprite
  sheets of at most 100 tiles, plus a JSON index `{tileWidth, tileHeight, columns, tiles: [{sheet, index, timeSec}]}`.
- **TH-003 (P0)** Timeline filmstrips and Project-panel hover-scrub use the nearest tile at or before the requested
  time. When the timeline is zoomed in beyond the sprite's density, the client decodes exact frames in a Worker from
  the preview source (mediabunny) for visible slots only, with an LRU cache of decoded bitmaps (default 300 MB).
- **TH-004 (P1)** Animated images and image assets get a poster and, for animated images, a sprite of up to 20
  frames. Large still images (over 4096 px on the long edge) additionally get a 2048 px "display copy" used by the
  preview to save memory.

### 7.3 Waveform peaks (WF)

- **WF-001 (P0)** Contract (shared by engine and browser): per audio stream, per channel, a `Float32Array` of
  **max-absolute sample values at 100 peaks per second** of source time, stored as little-endian binary with a JSON
  header `{peaksPerSecond, channels, sampleCount, durationSec}`. Channels are stored separately so stereo clips can
  show two lanes (Premiere L/R) and mono views average them.
- **WF-002 (P0)** Engine generation decodes audio once to low-rate float PCM through ffmpeg and reduces it in a
  worker; a 60-minute file must complete in under 20 s on the reference machine.
- **WF-003 (P0)** The timeline draws waveforms from peaks at any zoom by taking the max over the peaks covered by
  each pixel column; beyond 100 px per second it may linearly upsample (no decode). Rectified vs centered drawing
  is a display setting (UI spec).
- **WF-004 (P1)** Peaks reflect the clip's own gain in drawing only (scaled by the linear gain), never re-generated
  for gain changes.

### 7.4 Media analysis (AN)

- **AN-001 (P0)** Keyframe index per video asset: the list of keyframe timestamps (decoded without full decode). It
  feeds the stream-copy fast path (RN-010) and optional keyframe snapping in the timeline.
- **AN-002 (P1)** Loudness analysis per audio stream: integrated loudness (LUFS), loudness range and true peak;
  displayed in the Project panel "Audio Info" column tooltip and used by "Normalize clip loudness" (sets clip gain
  to reach a target, default -16 LUFS).
- **AN-003 (P1)** Silence detection: parameters threshold (default -35 dB, or relative to the clip's integrated
  loudness when available: -20 LU below it), minimum silence duration (default 0.5 s). Output: list of silent
  intervals in source time. Consumers (the "Remove Silences" command and agents) invert them into keep-ranges, pad
  each keep-range by a margin (default 0.15 s), merge overlaps, and apply edits through the document mutation layer
  as **one undoable step** named "Remove silences".
- **AN-004 (P1)** Scene detection: downscaled analysis with a configurable threshold; output is a list of cut times
  with scores. Consumers can add markers ("Scene Edit Detection ▸ Create markers") or split clips at those points
  ("… ▸ Apply cuts"), again as one undoable step.
- **AN-005 (P2)** Black-frame and freeze-frame detection for QC before export (warnings in the export preflight).
- Analysis results are artifacts (CA) keyed by fingerprint and parameters, so re-running with the same parameters
  is instant.

### 7.5 Derived-artifact cache (CA)

- **CA-001 (P0)** Artifacts are **content-addressed**. The asset fingerprint is SHA-256 over (file size, first 4 MiB,
  last 4 MiB). The artifact key is `fingerprint + artifact kind + parameters hash + generator version`. The same file
  imported into several projects shares artifacts.
- **CA-002 (P0)** Artifact records hold `{key, kind, path, byteSize, createdAt, lastUsedAt, generatorVersion}`. A
  bump of a generator version (for example a new proxy recipe) invalidates only that artifact kind.
- **CA-003 (P1)** Cache eviction: least-recently-used eviction when the cache exceeds its quota (default: 25 GB or
  15% of free disk at start, whichever is smaller; configurable in Settings ▸ Media Cache). Artifacts used by the open
  project are pinned. Settings shows the size, a "Clean cache now" button and the cache location (desktop: movable).
- **CA-004 (P0)** Missing or corrupt artifacts are regenerated transparently on demand; the client treats an
  artifact 404 as "not ready" and subscribes to its readiness event.

---

## 8. Media serving (MS)

- **MS-001 (P0)** URLs (all same-origin, relative):
  - `/media/:assetId`: original bytes;
  - `/media/:assetId/proxy/:tier`: proxy;
  - `/media/:assetId/poster.jpg`, `/media/:assetId/sprite/:sheet.jpg`, `/media/:assetId/sprite.json`;
  - `/media/:assetId/peaks/:stream.bin` and `.json`;
  - `/media/:assetId/display.jpg`: image display copy;
  - `/renders/:jobId/output`: export output (WE download).
- **MS-002 (P0)** Byte serving must support `HEAD`, `Range` (single range, 206 with `Content-Range`), `Accept-Ranges:
  bytes`, `ETag` and `Last-Modified`, correct `Content-Type`, and streaming without buffering the file. Artifact URLs
  carry the artifact key as a query parameter and are served with `Cache-Control: private, max-age=31536000,
  immutable`; original media with `private, no-cache` plus ETag.
- **MS-003 (P0)** Authentication for media: the session cookie (ENG-020/021). For consumers that cannot send the
  cookie (the headless browser used by local Remotion renders, cloud renderers) the engine issues **short-lived
  signed URLs** (`?sig=<hmac>&exp=<unix>`) scoped to a single asset and artifact.
- **MS-004 (P0)** The PWA service worker must bypass `/media`, `/renders`, `/api`, `/events` and `/health` (Cache
  Storage cannot hold partial responses, and media is large).
- **MS-005 (P1)** In profile W, media is served to the Player through `blob:` URLs created from file handles or
  OPFS files. Blob URLs are revoked when no clip uses the asset, and re-created if the browser invalidates them.

---

## 9. Transcription and captions (TR)

### 9.1 Providers

| Provider id | Where it runs | Needs | Default |
|---|---|---|---|
| `whisper-local` | engine child process (`whisper-cli`), CPU | a downloaded or bundled model | **yes**, whenever an engine is available |
| `openai` (cloud) | engine calls the provider API | API key configured on the engine | no; opt-in |
| `browser-whisper` | Web Worker (wasm) | cross-origin isolation, a model in browser storage | no; P2, profile W only |

- **TR-001 (P0)** Provider choice: per-request parameter, defaulting to the user's Settings ▸ Transcription choice,
  defaulting to `whisper-local`. The client never holds cloud keys; cloud calls always go through the engine.
- **TR-002 (P0)** When a cloud provider is chosen, the UI must show, before the first request of a project, "Audio
  from this project will be sent to <provider>" with Continue/Cancel, and remember the choice per project.

### 9.2 Models (whisper-local)

- **TR-020 (P0)** Model catalog: `tiny`, `base`, `small`, `medium`, `large-v3-turbo`, with English-only variants of
  the smaller ones and quantized variants; each entry has size, languages, approximate speed factor on the current
  CPU (measured after first use), and SHA-256. Models live in `<appdir>/models`.
- **TR-021 (P0)** The desktop installer bundles the Silero VAD model and **one small multilingual model** (quantized
  `base`, about 60 MB) so transcription works offline on first launch. Other models download on demand as jobs with
  progress, resumable, SHA-256 verified, deletable from Settings.
- **TR-022 (P1)** Default model selection: the bundled model; "Higher accuracy" suggests `small` or
  `large-v3-turbo` quantized with a size and speed estimate.

### 9.3 Pipeline

- **TR-030 (P0)** Input: an asset (whole file, default) or a list of source ranges. Audio is extracted by ffmpeg as a
  **stream** to 16 kHz mono 16-bit PCM (the selected audio stream; stereo is downmixed), never fully decoded into
  memory, with no duration cap.
  > **Beyond template:** the reference decoded the entire file inside the browser, uploaded the WAV to cloud storage
  > and was capped at ~13.4 minutes by the provider's upload limit.
- **TR-031 (P0)** Long media: run VAD, then split into windows of at most 10 minutes cut at silence boundaries;
  transcribe windows sequentially with all allotted threads; offset each window's timestamps by its start; merge.
  Progress = transcribed audio seconds / total seconds, with ETA.
- **TR-032 (P0)** Output: **word-level** tokens and segments in **source time**:

  ```ts
  type Transcript = {
    language: string;                    // detected or forced
    provider: string; model: string;
    words: Caption[];                    // from @remotion/captions: text, startMs, endMs, timestampMs, confidence
    segments: Array<{startMs: number; endMs: number; text: string; wordRange: [number, number]}>;
  };
  ```

  We adopt the public `Caption` type from `@remotion/captions` as the word representation because the Remotion
  caption utilities consume it; word `text` keeps the leading space convention of that type so words can be joined
  without re-spacing.
- **TR-033 (P0)** Results are cached as artifacts keyed by fingerprint, audio stream, provider, model, language and
  range, so a second request (another clip of the same asset, or an agent) is instant.
- **TR-034 (P1)** Language: auto-detect (default) or forced; "Translate to English" option (whisper translate task).
- **TR-035 (P1)** Cloud provider path: the engine compresses the extracted audio (mono Opus or MP3 at 32–48 kb/s),
  splits it at silence boundaries to fit the provider's per-request limit, calls the provider with word timestamps
  enabled, shifts timestamps, and returns the same `Transcript` shape. No intermediate cloud storage is used.
- **TR-036 (P2)** Speaker labels (diarization) are out of scope for v1; the data shape reserves an optional
  `speaker` field on segments.

### 9.4 Captions on the timeline

- **TR-050 (P0)** "Generate captions" is available from the Properties panel of a video or audio clip, from
  the Text panel ▸ Captions tab ("Transcribe sequence"), and from agents. For a clip it creates a **caption asset**
  (a copy of the relevant words) and a **caption clip** on a caption track above the source clip's track (a new track
  if none is free), covering the source clip's timeline range.
- **TR-051 (P0)** Time mapping from source to timeline for a clip starting at timeline frame `S`, with source in-point
  `I` seconds, constant speed `r` and sequence rate `fps`:
  `timelineSec = S / fps + (sourceSec - I) / r`. Words whose interval lies entirely outside `[I, I + clipDuration × r]`
  are dropped; words crossing the boundary are clamped. Reversed clips are not captionable (P0) and show a reason.
- **TR-052 (P0)** Caption clips hold their own copy of the words in **clip-relative time**. Later edits of the source
  clip do not move captions (Premiere behavior); a "Re-sync captions to source clip" command re-runs the mapping.
- **TR-053 (P0)** Paging (grouping words into on-screen captions), our algorithm and defaults: start a new caption
  when adding the next word would exceed **42 characters per line × 2 lines**, when the caption would exceed **5 s**,
  after sentence-ending punctuation, or when the gap to the next word exceeds **0.6 s**. A caption lasts from its first
  word's start to the next caption's start or its last word's end + 0.5 s, whichever is sooner, with a minimum of
  0.7 s. Parameters are editable per caption clip. A karaoke-style "active word" highlight is a style option (canvas
  spec).
- **TR-054 (P1)** Caption editing in the Text ▸ Captions tab: split, merge, retime by dragging on the caption track,
  edit text (editing a caption's text re-distributes its word timings proportionally to character counts).
- **TR-055 (P2)** Text-based editing (Text ▸ Transcript tab): selecting words maps to source ranges using word
  timings; "Extract" and "Lift" apply ripple or lift edits to clips of that asset. The mapping utilities (text
  selection → source ranges → timeline ranges) are part of this spec's API (`transcripts.rangesForWords`).

### 9.5 Caption import and export

- **TR-060 (P0)** Import SRT and WebVTT files as caption assets (segment level; words are synthesized by splitting
  segment text and distributing time proportionally).
- **TR-061 (P0)** Export: sidecar SRT and WebVTT (for the export range, in output time), and burn-in (captions
  rendered as part of the picture, the default when the caption track is visible).
- **TR-062 (P1)** Embedded caption streams: `mov_text` in MP4/MOV and WebVTT in MKV/WebM through the native muxer.

### 9.6 Acceptance criteria (captions)

1. Desktop, offline, no keys: transcribing a 45-minute interview with the bundled model completes, shows progress
   and ETA, can be cancelled, and produces word timestamps within ±150 ms of the audio on the QA corpus.
2. Generating captions for a clip trimmed to 00:10–00:40 of its source, playing at 2× speed, places the first
   caption at the clip's timeline start and the last one before the clip ends.
3. With an OpenAI key configured and the cloud provider chosen, the same flow works without any object storage.
4. Exported SRT timecodes match on-screen captions frame-exactly in the exported file.

---

## 10. Export settings and UX (EX)

### 10.1 Export entry points

- Export mode (header tab "Export"): presets left, preview with range selector centre, settings right, "Export"
  button bottom-right (UI spec section 6).
- File ▸ Export ▸ Media… (Ctrl/Cmd+M): opens Export mode for the active sequence.
- **Quick Export** (header button): one-click export with the last used or default preset to the default location.
- "Queue" (Alt/Opt+Shift+M): adds the export to the background render queue instead of starting it now (Premiere's
  "Send to Media Encoder").
- File ▸ Export ▸ Frame (Ctrl/Cmd+Shift+E, Program monitor camera button): still export (EX-030).
- Agent tool `export.start`.

### 10.2 Export settings (data concept)

```ts
type ExportSettings = {
  sequenceId: string;
  range: {type: 'entire'} | {type: 'in-out'} | {type: 'work-area'} | {type: 'custom'; startFrame: number; endFrame: number};
  presetId?: string;                              // settings may deviate from the preset ("Custom")
  container: 'mp4' | 'mov' | 'webm' | 'mkv' | 'wav' | 'mp3' | 'm4a' | 'png-sequence' | 'gif';
  video?: {
    codec: 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores-422' | 'prores-422-hq' | 'prores-4444' | 'vp8';
    width: number; height: number; frameRate: Rational;       // default: sequence settings
    scaling: 'fit' | 'fill' | 'stretch';                       // when aspect differs from the sequence
    quality: {mode: 'crf'; value: number} | {mode: 'vbr'; targetKbps: number; maxKbps?: number};
    encoderSpeed: 'fast' | 'balanced' | 'best';
    alpha?: boolean;                                           // only for prores-4444, vp9, png
    colorTags: 'rec709';                                       // v1 exports SDR Rec.709 only
  };
  audio?: {codec: 'aac' | 'opus' | 'mp3' | 'pcm-s16' | 'pcm-s24' | 'flac'; sampleRate: 48000 | 44100;
           channels: 1 | 2; bitrateKbps?: number;
           loudness?: {targetLufs: number; truePeakDb: number}}; // two-pass normalization (RN-032)
  captions?: {burnIn: boolean; sidecar: Array<'srt' | 'vtt'>; embed: boolean};
  engine: 'auto' | 'native' | 'remotion' | 'browser' | `cloud:${string}`;  // 'auto' = planner decides (RP)
  draftUseProxies?: boolean;
  destination: {type: 'path'; path: string} | {type: 'download'} | {type: 'project-folder'};
};
```

- **EX-001 (P0)** Built-in presets (P0): "Match Source – H.264 High Quality" (default), "YouTube 1080p", "YouTube 4K",
  "Vertical 1080×1920 (Shorts/Reels/TikTok)", "Square 1080×1080", "Audio only – WAV", "Audio only – MP3".
  (P1): "Master – ProRes 422 HQ", "Graphics with alpha – ProRes 4444", "Web – VP9 WebM", "HEVC 4K".
  (P2): "AV1", "Animated GIF", "PNG sequence". User presets can be saved, renamed, imported and exported as JSON.
- **EX-002 (P0)** Presets or options that the current runtime cannot produce are shown disabled with a reason (for
  example ProRes in profile W, H.264 in a browser without an H.264 encoder).
- **EX-003 (P0)** Output frame-rate conversion: when the export rate differs from the sequence rate, frames are
  sampled by nearest-frame (no blending) in v1; the UI warns about judder.
- **EX-004 (P0)** Scaling mode `fit` letterboxes with black; `fill` crops centred; `stretch` distorts. The preview in
  Export mode shows the result.
- **EX-005 (P0)** Before starting, the export dialog shows the **render plan summary** from the planner (RP-010):
  chosen path with a short name ("Smart render (lossless copy)", "Native", "Hybrid: native + 3 graphics layers",
  "Remotion", "In browser"), estimated duration and file size, and warnings (offline media, VFR sources, missing
  fonts, clips that force a slower path with the reason).
- **EX-006 (P0)** Exports run as jobs (section 17). Several exports can be queued; the queue runs one export at a
  time by default (Settings: up to 2).
- **EX-007 (P0)** Desktop destination: native save dialog; default folder is the project folder's `Exports/`; file
  name defaults to `<sequence name>.<ext>` and never silently overwrites (appends ` (2)`, …, unless the user confirmed
  overwrite). On completion: toast with "Reveal in folder", "Open", and "Copy path".
- **EX-008 (P0)** WE destination: the output is stored in the project's `exports/` on the engine and offered for
  download (`/renders/:jobId/output`), retained until the user deletes it or for 7 days (configurable).
- **EX-009 (P0)** Profile W destination: download link to the browser output (Blob or OPFS file).
- **EX-010 (P1)** Metadata: title, creation date and chapter markers (from sequence chapter markers) are written into
  MP4/MOV/MKV outputs.
- **EX-012 (P1)** "Draft (use proxies)" option: fast, low-quality export using proxy media, labelled in the file name
  suffix `_draft`.
- **EX-020 (P0)** Hidden (eye off) tracks are excluded; muted tracks and muted clips are silent; solo is respected;
  disabled clips are excluded.
- **EX-030 (P1)** Still export: current frame of the Program monitor to PNG or JPEG at sequence resolution (or a
  chosen size). Uses the native path when the frame contains only media, otherwise a Remotion still render (engine)
  or browser still render (W). Option "Import into project".
- **EX-040 (P2)** Interchange export: `.otio` written natively; FCP7 XML (Premiere), CMX3600 EDL and AAF through the
  optional interchange sidecar (see `docs/research/native-video-libraries.md` section 7).

---

## 11. Render planner (RP)

The planner turns (sequence, export settings, capabilities) into a **render plan**. It runs in the engine
(`POST /api/exports/plan`) and, in profile W, in the client (browser path only).

### 11.1 Item classification

Every clip in the export range is classified as:

- **Native-capable media layer**: video, audio, still image, animated image or solid-colour clip whose properties
  are all in the native coverage set (RN-020).
- **Graphics layer**: text, captions (burn-in), shapes, Remotion composition items, and any media clip that uses a
  property or effect outside the native coverage set.
- **Motion-graphic layer**: fframes template items (section 15).
- **Audio-only**: audio clips and the audio of video clips; audio is always mixed natively when an engine is present.

### 11.2 Paths

| Path | When | Engines used | Output quality |
|---|---|---|---|
| **P-copy: Smart render (stream copy)** | RN-010 eligibility holds | ffmpeg (no re-encode, optional head re-encode) | lossless, seconds |
| **P-native: Native composite** | all visual layers native-capable, no graphics layers | ffmpeg filtergraph + encoder | full |
| **P-hybrid: Hybrid** | at least one graphics or motion-graphic layer and at least one native media layer, no blocking condition (RP-005) | Remotion and/or fframes → alpha intermediates, ffmpeg composite + encode | full |
| **P-remotion: Remotion full** | graphics dominate, or a blocking condition applies | Remotion local render for picture, ffmpeg for audio mix and final mux | full |
| **P-browser: In browser** | profile W, or the user forces it | Remotion web renderer (WebCodecs) | full within browser codec limits |
| **P-cloud** | user explicitly selects a configured cloud provider | provider | provider-dependent |

- **RP-001 (P0)** With `engine: 'auto'`, the planner picks the **first eligible path** in this order: P-copy (only if
  the export settings are "Match Source" compatible, RN-010), P-native, P-hybrid, P-remotion. P-browser is used only
  in profile W. P-cloud is never chosen automatically.
- **RP-002 (P0)** Segmentation: the planner splits the export range at every frame where the set of active visible
  layers changes (clip boundaries, fades start/end are not boundaries). Each segment is classified independently
  (pure-native segments, graphics-only segments, mixed segments). Adjacent segments with the same class and layer set
  are merged. This lets a mostly-footage edit with a 5 s title render only 5 s through Remotion.
- **RP-003 (P0)** Graphics grouping inside a mixed segment: walk visual tracks **bottom to top** (the data-model
  spec fixes which end of the track list is the top; Premiere V1 is the bottom). Group each maximal run of adjacent
  graphics/motion-graphic layers into one **graphics group**. Each group is rendered once as an alpha intermediate over
  a transparent background for the segment's time span, then overlaid in stack order between the native layers.
- **RP-004 (P0)** Motion-graphic layers become their own groups rendered by fframes (MG-010) when the fframes engine
  is available; otherwise they fall into Remotion groups using the WASM SVG layer (MG-020).
- **RP-005 (P0)** **Blocking conditions** that force P-remotion for a segment (all layers rendered by Remotion, full
  frames): a graphics layer uses a blend mode other than normal, an adjustment-layer style effect that applies to
  layers below it, a mask that references other layers, or any feature marked "Remotion-only compositing" in the
  effects catalog.
- **RP-006 (P0)** Audio is planned separately from picture, as one continuous mix over the whole range (never per
  segment), so segment boundaries cannot produce clicks.
- **RP-007 (P0)** Parallelism: independent segments and graphics groups run concurrently within the export's CPU
  budget (JB-012). Native segments are encoded with identical encoder settings and joined with the concat demuxer;
  the final audio is muxed at the end.
- **RP-008 (P1)** The planner records **why** each segment did not qualify for a faster path (clip id and reason,
  for example "clip 'Interview B' has rotation 12°, not native" or "text layer 'Title' requires graphics
  rendering"). This list is shown in the export dialog (EX-005) and returned to agents.
- **RP-009 (P1)** Estimates: duration from per-path throughput measured on this machine (rolling average of the last
  10 jobs per path and resolution; seeded with conservative defaults: native 1080p 1.5× realtime, Remotion 1080p
  8 fps, fframes 150 fps + intermediate encode). Size from bitrate or CRF heuristics.
- **RP-010 (P0)** Plan (data concept):

  ```ts
  type RenderPlan = {
    path: 'copy' | 'native' | 'hybrid' | 'remotion' | 'browser' | `cloud:${string}`;
    segments: Array<{startFrame: number; endFrame: number;
                     mode: 'copy' | 'native' | 'mixed' | 'remotion';
                     graphicsGroups: Array<{id: string; engine: 'remotion' | 'fframes'; itemIds: string[]}>}>;
    audio: {mode: 'native-mix' | 'remotion' | 'browser'; normalize?: {targetLufs: number}};
    blockers: Array<{itemId?: string; path: 'copy' | 'native' | 'hybrid'; reason: string}>;
    warnings: Array<{code: string; message: string; itemIds?: string[]}>;
    estimate: {seconds: number; bytes: number};
  };
  ```

- **RP-011 (P0)** Determinism: the same document revision, settings and capabilities produce the same plan. The plan
  embeds the document revision; starting an export with a stale plan re-plans.
- **RP-012 (P0)** The user (and agents) may force a path via `engine`; forcing a path that is ineligible returns
  `PATH_NOT_ELIGIBLE` with the blockers instead of producing a wrong render.

---

## 12. Native ffmpeg render paths (RN)

### 12.1 Smart render (stream copy)

- **RN-010 (P0)** Eligibility (all must hold):
  1. every visible video clip in the range comes from sources with identical codec, profile, resolution, pixel
     format, frame rate and time base; and the output container can hold that codec;
  2. each clip fills the frame exactly (no position/scale/crop/rotation/opacity changes), speed 1, no fades, no
     effects, no transitions;
  3. at any frame at most one video clip is visible (no overlaps, no graphics, no captions burn-in);
  4. audio consists only of the linked audio of those clips at unity gain, no fades, no other audio clips, and the
     source audio parameters are identical;
  5. export settings are "Match Source" (same codec, size, rate) and loudness normalization is off;
  6. gaps are allowed only if the user accepts that they are removed (P0: gaps block the copy path).
- **RN-011 (P0)** Cut accuracy: a cut whose source in-point is not on a keyframe (AN-001) is handled by **smart
  cut**: re-encode from the in-point to the next keyframe with encoder settings matched to the source stream, stream-
  copy the rest, join. If the matched re-encode is not possible (unknown encoder parameters, or codec not
  encodable), the copy path is ineligible and the planner falls back to P-native, reporting the reason. Smart cut is
  labelled "experimental" in P0 and must pass QA-006 before being on by default.
- **RN-012 (P1)** "Export selection (lossless)" from the Source monitor In/Out: the same mechanism for a single source.

### 12.2 Native composite

- **RN-020 (P0)** Native coverage set (properties the filtergraph must reproduce exactly as the preview does):
  position, size (scale), crop (per-edge), rotation in 90° steps (P0) and arbitrary angles (P1), opacity, fade in/out
  (as alpha ramps), constant speed (video by timestamp scaling; audio by pitch-preserving time-stretch), horizontal and
  vertical flip, still images (looped for the clip duration, EXIF-upright), animated images (looped as the preview
  loops them), solid colour clips, sequence background colour, audio gain, audio fades, pan (P1), track and clip mute.
  (P1) cross-dissolve and dip-to-black transitions between adjacent clips, LUT application (`.cube`), and keyframed
  position/scale/opacity with linear or bezier interpolation compiled to per-frame expressions or per-segment
  constant pieces. Anything else is a graphics layer.
- **RN-021 (P0)** Graph construction rules:
  - one input per clip with **input seeking** to the source in-point and a duration limit (never decode sources
    from zero);
  - reference inputs by index in the graph, never by file path (no path escaping issues);
  - normalize every visual input to the sequence frame rate and to an alpha-capable pixel format before overlay;
  - composite bottom to top onto a sequence-sized background of the sequence background colour;
  - convert to the output pixel format and tag colour as Rec.709 (primaries, transfer, matrix, TV range) at the end;
  - audio: per clip trim, time-stretch, resample to 48 kHz, gain, fades, delay to its timeline start; mix all with no
    automatic normalization; pad/trim to the exact range length.
- **RN-022 (P0)** Frame accuracy: timeline positions are integers in sequence frames. Every time value passed to
  ffmpeg is computed from rationals (`frames × den / num`) and formatted with enough precision (microseconds). The
  output must contain exactly `endFrame - startFrame` frames (verified after encode with a frame count probe; a
  mismatch fails the job with `FRAME_COUNT_MISMATCH`).
- **RN-023 (P0)** Long or complex timelines: when a segment has more than 32 inputs, or the whole export exceeds
  2 minutes, render per segment (RP-002) and concatenate; segments are additionally split every 60 s to parallelize
  across cores.
- **RN-024 (P0)** Encoders: H.264 via the bundled ffmpeg (x264 when the shipped build has it, see LC-003), HEVC,
  VP9, AV1 (SVT-AV1), ProRes (prores_ks, profiles 422/HQ/4444 with alpha), PCM/AAC/Opus/MP3/FLAC audio. Quality
  presets map `encoderSpeed` to encoder presets (for x264: fast → `veryfast`, balanced → `medium`, best → `slow`).
  MP4/MOV outputs use `+faststart`.
- **RN-030 (P0)** Progress: parse the encoder's machine progress output (output time, frame, speed) and map to 0–1
  over the export range; for multi-segment renders, progress is the frame-weighted sum over segments plus a final mux
  step weighted at 2%.
- **RN-031 (P0)** Graphics intermediates (from RR/MG) are overlaid with **straight alpha** semantics; the planner
  ensures intermediates are produced straight (MG-012, RR-013).
- **RN-032 (P1)** Loudness normalization: two-pass on the final mix: measure (integrated, true peak, LRA, threshold,
  offset), then apply linearly to the target (presets: -14 LUFS streaming, -16 podcast, -23 EBU R128, -24 ATSC) with a
  true-peak ceiling (default -1 dBTP), output resampled to 48 kHz.

---

## 13. Local Remotion render (RR)

- **RR-001 (P0)** The engine renders Remotion compositions with `@remotion/renderer` (`selectComposition`, then
  `renderMedia` for video or `renderStill` for stills). Compositions come from `packages/compositions` and are
  **bundled at build time** (the bundle folder ships with the engine; the engine never runs the bundler at runtime in
  packaged builds).
- **RR-002 (P0)** Input props are the serialized sequence (tracks, clips, assets with engine media URLs, fonts,
  sequence width/height/frame rate/background) and an optional **layer filter** (only render the listed clip ids,
  transparent background) used for graphics groups (RP-003). The composition's metadata calculation must take the
  frame rate and dimensions from the props (no hard-coded frame rate).
- **RR-003 (P0)** Media URLs in render props are engine-served signed URLs (MS-003) that the headless browser can
  fetch with Range support. The originals are used unless draft mode.
- **RR-004 (P0)** Concurrency default `max(1, floor(cores / 2))` for full renders, `max(1, floor(cores / 4))` when
  running concurrently with native segments; configurable in Settings ▸ Rendering.
- **RR-005 (P0)** Cancellation uses the renderer's cancel signal; progress maps rendered and encoded frames to 0–1.
  Errors report the failing frame number and the component error message.
- **RR-006 (P0)** Per-frame asset loading timeout (delay-render timeout) default 60 s, configurable; a timeout fails the
  job with `RENDER_TIMEOUT` and the frame number.
- **RR-010 (P0)** Headless browser provisioning: the desktop package **bundles** the Remotion-compatible headless
  browser so rendering works offline. Server installs download it at deploy time. If missing, the capability is
  `needs-browser-download` and the first render request starts a download job (with progress) after user consent.
- **RR-011 (P0)** The engine passes the configured Remotion license key (LC-001) to every render call.
- **RR-012 (P1)** Output of full Remotion renders: when the export codec is supported directly by the renderer it may
  encode directly; otherwise it renders a high-quality intermediate (ProRes 422 HQ or PNG sequence) that the native
  path encodes. Audio always comes from the native mix (RP-006) and is muxed natively.
- **RR-013 (P0)** Graphics-group intermediates: rendered with a transparent background as ProRes 4444 (default) or a
  PNG sequence, straight alpha, at sequence resolution and frame rate, for exactly the group's frame span.
- **RR-014 (P1)** Remotion renders run in their own child processes (as the renderer does) with a lower OS
  scheduling priority than the UI-facing engine (JB-013).

---

## 14. Browser render (RW)

- **RW-001 (P0)** In profile W (and when forced in other profiles), export uses the Remotion web renderer
  (`renderMediaOnWeb`) with the same composition package and input props as the Player.
- **RW-002 (P0)** Preflight: before enabling the Export button, call the web renderer's capability check for the
  chosen container/codec/size and fall back through: H.264 MP4 → VP9 WebM → VP8 WebM. Show the effective codec.
- **RW-003 (P0)** Output target: stream to OPFS for exports longer than 60 s or larger than 1080p, in-memory buffer
  otherwise. Offer the result as a download; delete the OPFS file when the user dismisses the job.
- **RW-004 (P0)** Cancellation via an abort signal, exposed as the job's Cancel button. Progress from the renderer's
  progress callback.
- **RW-005 (P0)** While a browser render runs: keep-the-tab-open banner, `beforeunload` guard (IN-013), and a
  screen wake lock where supported. Rendering continues when the tab is in the background only as far as the browser
  allows; the UI warns about this.
- **RW-006 (P0)** The web renderer sends usage telemetry to Remotion on every render; pass the license key (LC-001),
  and disclose the telemetry in Settings ▸ About and the privacy policy (LC-002).
- **RW-007 (P1)** Soft limits: warn (not block) for exports over 10 minutes or above 1080p in the browser, and
  suggest the desktop app or an engine.
- **RW-008 (P1)** Still export in the browser uses the web renderer's still API.

---

## 15. fframes motion-graphics intermediates (MG)

The item type, template catalog and inspector UI are specified in the graphics spec; this section covers rendering.

- **MG-001 (P1)** The engine ships a precompiled template renderer (one binary containing all templates) that reads a
  JSON spec at runtime (template id and version, parameters validated against the template's JSON Schema, canvas
  size, frame rate, duration) and writes **raw straight-alpha RGBA frames** to stdout plus NDJSON progress on stderr.
  No compilation happens for parameter edits.
- **MG-002 (P1)** `GET /api/motion-graphics/templates` returns the catalog with JSON Schemas so the inspector and
  agents can build and validate parameters.
- **MG-010 (P1)** Render outputs per motion-graphic clip, produced by piping the raw frames into ffmpeg:
  - **preview proxy**: VP9-with-alpha WebM at half sequence resolution (for Chromium-based preview, when the WASM
    path is not used);
  - **master**: ProRes 4444 (default) or PNG sequence at full sequence resolution for export compositing;
  - poster and filmstrip sprite for the timeline.
  Masters are produced lazily at export time if not cached.
- **MG-011 (P1)** Cache key: template id + template version + canonicalized parameters + canvas + frame rate +
  duration + scale + renderer version. Undo/redo never re-renders.
- **MG-012 (P1)** Straight alpha only: the renderer output must be un-premultiplied RGBA. The job must verify the
  frame count of each output equals the expected count and fail with `FRAME_COUNT_MISMATCH` otherwise.
- **MG-013 (P1)** Resource cap: fframes renders take at most the CPU slots the scheduler grants (thread count passed
  to the renderer).
- **MG-020 (P2)** WASM SVG path: the same templates compiled to WASM render SVG per frame inside the Remotion
  composition. This is the preview path on all platforms (including iOS) and the export path when the native
  renderer is unavailable (profile W, or export through Remotion). Shader-based templates show a placeholder in this
  path and are marked "native render required".
- **MG-030 (P3)** Agent-authored custom graphics (generated Rust compiled in a sandboxed, network-less build
  environment with a warm build cache) are out of scope for v1; the API reserves `templateId: "custom:<hash>"`.

---

## 16. Optional cloud providers (RC)

- **RC-001 (P1)** Provider interfaces in the engine: `StorageProvider` (put/get/delete/presign for S3-compatible
  stores), `CloudRenderProvider` (start/progress/cancel, e.g. Remotion Lambda), `TranscriptionProvider` (TR-035).
  Each is configured independently; one provider's missing configuration never disables another feature.
- **RC-002 (P2)** Cloud render: when configured, appears as an extra export engine choice with a cost warning. The
  render props must include the frame rate. Outputs are downloaded into the normal export destination.
- **RC-003 (P2)** Cloud storage: server deployments may keep managed media in an S3-compatible store; the engine
  still serves media to clients through `/media` (proxying or redirecting with short-lived presigned URLs). Uploaded
  objects are private (never public-read).
- **RC-004 (P0)** Credentials live only in the engine: server config or environment for WE; for desktop, entered in
  Settings ▸ Providers and stored with the OS keychain (Electron safe storage), handed to the engine at start and on
  change. Keys are never sent to the client after being saved (the UI shows only "configured" and the last 4 chars).

---

## 17. Job queue and progress (JB)

### 17.1 Job model

```ts
type EngineJob = {
  id: string;
  kind: 'upload' | 'probe' | 'keyframes' | 'poster' | 'sprite' | 'peaks' | 'proxy' | 'analysis'
      | 'transcription' | 'model-download' | 'export' | 'still' | 'mg-render' | 'browser-download' | 'gc' | 'relink-scan';
  title: string;                         // human readable: "Proxy 720p – Interview A.mov"
  origin: {type: 'user'} | {type: 'agent'; agentRunId: string} | {type: 'system'};
  projectId?: string; assetId?: string; parentId?: string;   // batch imports and exports have child jobs
  state: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  progress: number | null;               // 0..1, null = indeterminate
  stage?: string;                        // "Extracting audio", "Transcribing 12:30 / 45:00", "Encoding segment 3/8"
  speed?: number;                        // × realtime when meaningful
  etaSec?: number;
  createdAt: string; startedAt?: string; finishedAt?: string;
  priority: 'interactive' | 'user' | 'background';
  cpuSlots: number;                      // requested; granted by the scheduler
  dedupeKey?: string;                    // e.g. `proxy:720:<fingerprint>`
  result?: unknown;                      // kind-specific, typed in packages/api
  error?: {code: string; message: string; retryable: boolean; logRef?: string};
};
```

### 17.2 Scheduling

- **JB-010 (P0)** State machine: `queued → running → succeeded | failed`; `queued | running → cancelling →
  cancelled`; on engine restart, `running → interrupted`. `failed` (retryable), `cancelled` and `interrupted` jobs can
  be retried, which creates a new job linked to the old one.
- **JB-011 (P0)** Lanes: `interactive` (probe, keyframes, poster, peaks for clips visible on the timeline) preempts
  queue order; then `user` (exports, transcription, stills, explicit proxy requests); then `background` (automatic
  proxies, sprites, analysis, GC). Within a lane: FIFO.
- **JB-012 (P0)** CPU slots: total slots = logical cores. Each job requests slots (probe 1, peaks 1, proxy 4, export
  all remaining, transcription 6, fframes 4 + encode 2). A job starts when its slots are available; exports may start
  with fewer slots than requested (never fewer than half). The number of child threads passed to each tool follows
  the granted slots.
- **JB-013 (P0)** Background-lane processes run at lower OS priority. While an export runs, background jobs are paused
  by default (Settings: "Pause background tasks while exporting", on).
- **JB-014 (P0)** Dedupe: submitting a job whose `dedupeKey` matches a queued or running job returns that job instead
  of creating a new one. Artifact jobs whose artifact already exists complete immediately.

### 17.3 Cancellation, failure, persistence

- **JB-020 (P0)** Cancel terminates the job's whole process tree (graceful signal, then force after 3 s), deletes
  scratch and partial outputs, and reaches `cancelled` within 5 s. Cancelling a parent cancels its children.
- **JB-021 (P0)** Failures keep the last 64 KB of tool diagnostic output in the engine log, referenced by `logRef`
  and viewable from the Jobs panel ("Show log"), and set `retryable` according to the error code (disk full and
  missing binaries are not retryable until fixed; transient I/O is).
- **JB-022 (P1)** Automatic retry once for transient failures of background jobs (not exports).
- **JB-030 (P0)** The engine journals job state changes to disk. On restart, queued jobs are restored in order,
  running jobs become `interrupted` and are offered for retry (exports) or re-queued automatically (artifact jobs).
  Finished jobs are kept for 7 days or the last 500, whichever is more.

### 17.4 Events and UI

- **JB-040 (P0)** Events: `job.created`, `job.updated` (throttled to at most 4 per second per job, always sending the
  final state), `job.finished`. Each event carries the full job object (clients do not need to merge partial updates).
- **JB-041 (P0)** On (re)connect the client loads `GET /api/jobs?active=1&since=<time>` and then applies events.
- **JB-042 (P0)** Header **Background tasks** button: shows a ring with aggregate progress of running user-visible
  jobs and a badge with the count of running + queued jobs; red badge when there are unacknowledged failures. Click
  opens the **Jobs** panel.
- **JB-043 (P0)** Jobs panel: grouped list (Exports, Transcription, Media processing, Uploads), each row with title,
  stage, progress bar, speed, ETA, Cancel, Retry, Show log, Reveal/Download for outputs, Dismiss. Filters: Active,
  Failed, Completed. Agent-originated jobs show an agent badge.
- **JB-044 (P1)** Desktop: OS notification when an export or transcription finishes while the window is unfocused;
  taskbar/dock progress for the running export.
- **JB-045 (P0)** Browser-side jobs (uploads in WE, browser renders and browser analysis in W) use the same `EngineJob`
  shape in a client-side store and appear in the same UI; they are lost on reload (except resumable uploads, IN-012).

---

## 18. Fonts for preview and render (FT)

- **FT-001 (P0)** Font catalog: a curated set of open-licensed families (at least the 250 most popular Google Fonts
  families, OFL/Apache) is **bundled** with the engine (woff2 files, all weights and styles, latin + latin-ext
  subsets at minimum) and served at `/fonts/...`. Font metadata (`GET /api/fonts`) includes family, weights, styles,
  subsets and file URLs on the engine origin.
- **FT-002 (P0)** Preview and every render path load fonts from the same engine URLs, so the same files are used in
  the Player, headless Remotion renders and browser renders. In profile W, the SPA hosts a smaller bundled set (top
  30 families) precached by the service worker, and falls back to the online CDN only when online.
- **FT-003 (P0)** Renders never fail because a font is unknown: unknown families fall back to a bundled default
  family and the planner reports a `FONT_FALLBACK` warning listing the affected items.
- **FT-004 (P1)** System fonts: on desktop the engine enumerates installed fonts; in Chromium browsers the Local Font
  Access API is used with permission. Using a system font adds it to the project's font list; exports on another
  machine without the font produce `FONT_FALLBACK`.
- **FT-020 (P1)** Custom fonts: TTF/OTF/WOFF/WOFF2 files can be imported as `font` assets (stored in the project and
  in `<appdir>/fonts` for reuse). The user confirms they have the right to embed the font.
  > **Beyond template:** the reference loaded all fonts from an online CDN and failed renders for any font outside its
  > fixed list.

---

## 19. HTTP routes and events (API)

All JSON bodies are validated with zod schemas shared from `packages/api`. All routes except `/health` and the
login-info route require auth (ENG-020/021). Paths below are relative to the engine origin.

### 19.1 Routes

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /health` | liveness | public; `{ok, version}` |
| `GET /api/capabilities` | engine capability set | RT-002 |
| `GET /api/settings/providers`, `PUT /api/settings/providers/:id` | configure optional cloud providers | keys write-only (RC-004) |
| `POST /api/projects/:pid/assets/register` | desktop: register local paths `{paths[], copyIntoProject?}` | local mode only (SC-002) |
| `POST /api/uploads` | create resumable upload `{projectId, fileName, byteSize, mimeType, clientFingerprint?}` → `{uploadId, chunkSize, offset}` | checks quota and disk |
| `PUT /api/uploads/:uid?offset=<n>` | append a chunk (octet-stream) → `{offset}` | rejects wrong offset with the expected one |
| `POST /api/uploads/:uid/complete` | finalize → asset | starts probe |
| `DELETE /api/uploads/:uid` | abort | removes partial data |
| `POST /api/projects/:pid/assets/import-url` | download from URL (P2) | SC-010 |
| `GET /api/assets/:aid` | asset + runtime status + artifact map | |
| `POST /api/assets/:aid/relink` | `{path}` or `{uploadId}`, `{force?}` | AS-011 |
| `POST /api/projects/:pid/relink-scan` | `{folder}` → job; batch relink | AS-011 |
| `POST /api/assets/:aid/artifacts` | request artifacts `{kinds: ['proxy-720','sprite',…]}` → jobs | dedupe |
| `POST /api/assets/:aid/analyze` | `{type: 'silence'|'scenes'|'loudness'|'black', params}` → job; result in job | AN |
| `POST /api/transcriptions` | `{assetId, audioStream?, ranges?, provider?, model?, language?, translate?}` → job | TR |
| `GET /api/transcriptions/:id` | transcript | |
| `POST /api/transcripts/ranges-for-words` | `{transcriptId, wordRange}` → source ranges | TR-055 |
| `GET /api/models`, `POST /api/models/:id/download`, `DELETE /api/models/:id` | model management | TR-020 |
| `GET /api/export-presets`, `PUT /api/export-presets/:id`, `DELETE …` | presets | EX-001 |
| `POST /api/exports/plan` | `{document revision or inline document, settings}` → `RenderPlan` | RP-010 |
| `POST /api/exports` | start or queue `{settings, planId?, queueOnly?}` → job | EX-006 |
| `POST /api/stills` | still frame → job | EX-030 |
| `GET /renders/:jobId/output` | download export output (WE) | Range supported |
| `GET /api/motion-graphics/templates` | catalog + schemas | MG-002 |
| `POST /api/motion-graphics/render` | `{spec, quality: 'preview'|'master'}` → job | MG-010 |
| `GET /api/jobs` (`?active=1`, `?projectId=`, `?since=`) | list | JB-041 |
| `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/retry`, `DELETE /api/jobs/:id` | job control | |
| `GET /api/jobs/:id/log` | diagnostic tail | JB-021 |
| `GET /api/fonts`, `POST /api/fonts` (custom upload) | fonts | FT |
| `GET /fonts/*` | font files | immutable caching |
| `GET /media/...` | media and artifacts | section 8 |
| `GET /events` | NDJSON event stream | 19.3 |

Project document CRUD, autosave and versions are owned by the persistence spec and also live in the engine.

### 19.2 Desktop bridge (not HTTP)

The Electron preload exposes only: native open-file dialog returning paths, native save dialog returning a path,
reveal in folder, open file with the OS default app, OS keychain read/write for provider keys (brokered by main), OS
notifications and taskbar progress, window controls. No media bytes pass through IPC.

### 19.3 Events

Envelope: `{id: number /* monotonic */, type: string, createdAt: string, projectId?: string, payload: object}`.

| Type | Payload |
|---|---|
| `engine.heartbeat` | `{}` every 15 s |
| `capabilities.changed` | `{}` (client re-fetches) |
| `job.created`, `job.updated`, `job.finished` | `EngineJob` |
| `asset.updated` | asset runtime status (state, offline flag, probe summary when newly available) |
| `artifact.ready` | `{assetId, kind, url, key}` |
| `transcription.ready` | `{transcriptionId, assetId}` |
| `export.finished` | `{jobId, outputPath?, downloadUrl?, byteSize, durationSec}` |

---

## 20. Agent control (AG)

JasperEditor agents drive this area through typed tools that wrap the engine API. Document edits that result from
media operations (placing clips, captions, silence removal, scene cuts) go through the document mutation layer
defined in the data-model spec, as labelled undoable steps.

- **AG-001 (P0)** Tool set (names indicative): `media.import({paths|urls, options})`, `media.probe(assetId)`,
  `media.requestArtifacts(assetId, kinds)`, `media.analyze(assetId, type, params)`,
  `captions.transcribe({assetId|clipId, provider?, model?, language?})`,
  `captions.createFromTranscript({clipId, transcriptId, paging?})`, `export.plan(settings)`, `export.start(settings)`,
  `jobs.list/get/cancel/retry`, `motionGraphics.listTemplates()`, `motionGraphics.render(spec)`.
- **AG-002 (P0)** Tools return structured results including job ids; long operations are asynchronous and the agent
  waits via `jobs.get` or job events. Every job started by an agent carries `origin: agent` and is visible to the user
  with an agent badge; the user can cancel it.
- **AG-003 (P0)** Confirmation policy: agents may freely run analysis, artifacts, transcription with local providers
  and export **plans**. Starting an export that writes outside the project folder, using a cloud provider (cost or
  privacy), deleting media files (GC), or downloading models over 500 MB requires user confirmation in the Agent
  panel (Apply / Reject).
- **AG-004 (P0)** Agents receive the planner's `blockers` and `warnings` so they can explain or fix why an export is
  slow (for example suggest removing a rotation to enable smart render).
- **AG-005 (P1)** Agents can read transcripts (words with timings) and request `ranges-for-words` to perform
  text-based edits; resulting edits appear in History as "Agent: <description>".
- **AG-006 (P0)** Agents never pass file-system paths for reading except through `media.import` (which follows the
  same rules as the UI: local mode only, or configured media roots) and never pass raw storage keys.

---

## 21. Offline and credential-free operation (OF)

- **OF-001 (P0)** Desktop with no network and no credentials must support: import by path, probing, proxies,
  thumbnails, waveforms, analysis, transcription with the bundled model, captions, text with bundled fonts, motion
  graphics (fframes) and all export paths except cloud. This is an automated test (QA-010).
- **OF-002 (P0)** No feature may call the network implicitly. Network use is limited to: model downloads, headless
  browser download (only if not bundled), update checks, optional cloud providers, the online font CDN fallback in
  profile W, and Remotion web-render telemetry (RW-006). Each is visible in Settings ▸ Privacy & Network, and all but
  telemetry required by the license can be disabled.
- **OF-003 (P0)** Missing credentials disable only the features of that provider (RC-001) and never produce errors in
  unrelated features.

Capability matrix without any credentials:

| Feature | D | WE | W | M (with engine) |
|---|---|---|---|---|
| Import / probe | yes (by path) | yes (upload) | yes (handle/OPFS) | yes (upload) |
| Proxies / sprites / peaks | yes | yes | yes (browser, P1/P2) | yes |
| Transcription | yes (whisper-local) | yes (whisper-local on server) | P2 (browser-whisper) | yes |
| Native / hybrid export | yes | yes | no | yes (runs on server) |
| Remotion local render | yes (bundled browser) | yes | no | yes |
| Browser render | optional | optional | yes | not recommended |
| fframes master | yes | yes | no (WASM preview/export via browser render) | yes |
| Cloud render / storage / ASR | only when configured | only when configured | no | only when configured |

---

## 22. Security (SC)

- **SC-001 (P0)** Local mode: loopback bind, per-launch token, Host check, no CORS (same-origin only), cookie
  HttpOnly + SameSite=Strict. Remote mode: TLS via reverse proxy, login throttling, request body limits per route
  (JSON 5 MB; uploads only via the upload routes).
- **SC-002 (P0)** Path registration (`assets/register`, `relink` with a path, relink scans) is accepted only in local
  mode, or in remote mode for paths inside configured media roots after resolving symlinks. Paths are canonicalized;
  `..` escapes are rejected.
- **SC-003 (P0)** Read, serve and delete operations accept only engine-issued ids (asset, upload, job, transcription,
  artifact key); ids are validated as UUIDs or keys the engine created. The engine never deletes a storage object or
  file because a client named it.
  > **Beyond template:** the reference's caption route read and then deleted whatever storage key the client
  > supplied, letting any caller delete arbitrary objects.
- **SC-004 (P0)** Native tools are spawned with argument arrays (never a shell). User-provided strings never enter
  filtergraph text; inputs are referenced by index; text is drawn by graphics layers, not by ffmpeg text filters.
- **SC-005 (P0)** Upload sessions expire after 24 h of inactivity; partial files are removed.
- **SC-010 (P2)** URL import: http(s) only; resolve DNS and reject loopback, link-local and private ranges in remote
  mode; size limit; redirects re-checked.
- **SC-020 (P0)** Project documents loaded from files, drops or links are schema-validated before use; unknown asset
  storage types are rejected.
- **SC-030 (P0)** End users cannot upload or supply Remotion component code to be rendered. Remotion compositions
  are ours (and, later, AI-generated through our own reviewed pipeline, per LC-004).
- **SC-031 (P3)** Agent-authored fframes code (MG-030) builds and runs only in a sandbox with no network, CPU/memory
  limits, a locked dependency set and a read-only toolchain.

---

## 23. Licensing and compliance (LC)

- **LC-001 (P0)** One configuration value, `JASPER_REMOTION_LICENSE_KEY` (engine) and its public counterpart for the
  client, is passed to every Remotion render API call (local, browser, cloud). With a free-license eligible team the
  documented free-license value is used; otherwise the company key.
- **LC-002 (P0)** Remotion web-render telemetry (end-user IP and origin) is disclosed in the privacy policy and in
  Settings ▸ About.
- **LC-003 (P0)** ffmpeg is shipped as a **separate executable** (not linked into our processes) with its license
  text, build configuration and source offer. Whether the shipped build is GPL (x264/x265) or LGPL-only (platform
  H.264 encoders, OpenH264 fallback) is a product decision recorded in `docs/ARCHITECTURE.md`; the engine's
  self-check (ENG-011) must work with either and adapt the encoder list.
- **LC-004 (P0)** Exports produced only by the native or fframes paths are not Remotion renders; the engine counts
  Remotion render calls per month (local log) to support license reporting.
- **LC-005 (P0)** `THIRD_PARTY_NOTICES` covers ffmpeg, whisper.cpp and model weights, fframes (MIT, plus its libav
  build), mediabunny (MPL-2.0), Remotion packages, bundled fonts (OFL/Apache) and the headless browser.

---

## 24. Test corpus and acceptance matrix (QA)

- **QA-001 (P0)** Test media corpus (generated where possible, stored outside git in a fetchable bucket or produced
  by a script): H.264 1080p30 CFR, H.264 VFR phone clip with 90° rotation, HEVC 10-bit HDR (HLG and PQ), ProRes 422
  and 4444 with alpha, DNxHR MXF, 1080i MPEG-2 TS, 23.976 and 29.97 sources with timecode, audio-only WAV 48k/96k,
  MP3 with cover art, 5.1 AAC, PNG with EXIF orientation 6, animated GIF, SRT/VTT files, a 60-minute speech recording,
  a corrupt truncated MP4.
- **QA-002 (P0)** Probe snapshot tests: ProbeSummary for every corpus file.
- **QA-003 (P0)** Artifact tests: peaks contract equality between the engine and browser implementations (max
  absolute difference below 0.02 per peak) on the same file.
- **QA-004 (P0)** Preview/export parity: for a set of golden sequences (footage only; footage + text; picture-in-
  picture with crop and opacity; captions; motion graphic over footage), render selected frames through the Player
  (headless) and through each eligible export path, and require SSIM ≥ 0.98 per frame (≥ 0.95 for text edges
  rendered by different rasterizers).
- **QA-005 (P0)** Timing: exported frame count equals the range length for every path; audio/video offset below
  one audio frame (21 ms) measured with a clap/flash test clip at 23.976, 25, 29.97 and 60 fps.
- **QA-006 (P1)** Smart-cut test: cuts at non-keyframe in-points decode without artefacts in ffmpeg, Chromium and
  QuickTime-compatible decoders, frame-exact against the native-composite output.
- **QA-007 (P0)** Cancellation: cancel each job kind at 10%, 50% and 90%; the job reaches `cancelled` within 5 s, no
  child processes remain, no partial output remains.
- **QA-008 (P0)** Restart: kill the engine during an export and a proxy job; on restart the export is `interrupted`
  and retryable, the proxy job re-queues automatically.
- **QA-009 (P1)** Load: import 200 files at once on the reference machine; the UI stays responsive (timeline
  interaction under 50 ms per frame) and interactive-lane jobs finish before background jobs.
- **QA-010 (P0)** Offline: run the OF-001 feature list on a desktop build inside a network-isolated container with no
  environment credentials.
- **QA-011 (P1)** Security: path traversal, foreign ids, missing token, wrong Host header, oversized bodies, and
  upload-offset tampering tests for every route.

---

## 25. Where JasperEditor goes beyond the reference template

| Area | Reference template behavior (described, not reused) | JasperEditor |
|---|---|---|
| Media storage | every file uploaded to a public-read cloud bucket; local copies kept only as a browser cache | local-first: desktop references files by path; server stores managed copies privately; browser-only mode uses file handles/OPFS; cloud storage optional (AS, IN, RC) |
| Saving | blocked whenever any upload had failed | never blocked (AS-002) |
| Upload | single request per file, size cap, no resume | resumable chunked uploads, disk checks, per-file progress (IN-005, IN-012) |
| Probing | browser-side, basic duration/size | engine ffprobe + normalized summary with rotation, VFR, HDR, timecode, streams (PB) |
| Proxies | none | two tiers, toggle, mandatory proxies for non-browser codecs (PX) |
| Filmstrips / waveforms | decoded in the browser from the full media | engine sprites and peaks with shared contracts, browser fallback only when needed (TH, WF) |
| Analysis | none | keyframes, loudness, silence, scenes (AN) |
| Captions | cloud ASR only, via cloud storage, ~13 min cap, whole-file decode in the tab | local whisper.cpp by default, streaming extraction, unlimited length with VAD chunking, cached, cloud optional without storage, SRT/VTT import/export, embedded streams (TR) |
| Rendering | cloud function by default; optional browser render; no cancel; fixed 30 fps; two codecs | render planner over five local paths (smart copy, native, hybrid, Remotion, browser) + optional cloud; cancel; queue; rational frame rates; presets incl. ProRes, HEVC, AV1, audio-only; loudness normalization (RP, RN, RR, RW) |
| Motion graphics | none | fframes CPU renderer with alpha intermediates and WASM preview (MG) |
| Jobs | transient in-page task list | persistent engine job queue with lanes, CPU slots, dedupe, ETA, logs, retry, events (JB) |
| Fonts | online CDN only, fixed list, renders fail for unknown fonts | bundled offline catalog, system and custom fonts, never-fail fallback (FT) |
| Offline / credentials | nearly every backend feature required cloud credentials | complete offline desktop operation; per-provider optional credentials hot-reloaded (OF, ENG-012) |
| Security | unauthenticated routes; caption route could delete arbitrary storage objects | token/password auth, Host checks, server-issued ids only, no shell, signed media URLs (SC) |
| Agent control | none | full typed tool surface with confirmation policy and plan explanations (AG) |
| Premiere parity | n/a | Import/Export modes, Media Browser, proxies toggle, offline media + relink, Clip Mismatch prompt, render queue, Quick Export, Export Frame, Jobs panel (IN, PX, AS, EX, JB) |

---

## 26. Suggested work packages

| WP | Content | Requirements |
|---|---|---|
| WP-M1 | Engine skeleton: process model, appdir, auth, capabilities, events, binary self-check | ENG-*, RT-001..004, API 19.1 core |
| WP-M2 | Asset model, desktop path registration, probing, duplicate detection, clip-mismatch prompt | AS-001..004, IN-001..003, IN-007..009, PB-* |
| WP-M3 | Job queue, scheduler, journal, Jobs panel and header indicator | JB-* |
| WP-M4 | Artifacts: keyframes, posters, sprites, peaks, cache, media serving | TH-*, WF-*, AN-001, CA-*, MS-* |
| WP-M5 | Proxies and preview source resolution, proxy toggle | PX-* |
| WP-M6 | Transcription (whisper-local, models, chunking) and captions creation/paging/export | TR-* |
| WP-M7 | Render planner + native composite + audio mix + presets + Export mode | RP-*, RN-020..032, EX-* |
| WP-M8 | Local Remotion render (bundle, headless browser, graphics groups) | RR-* |
| WP-M9 | Browser-only profile: storage, worker artifacts, browser render | RT-010..013, RW-*, MS-005 |
| WP-M10 | Uploads (resumable) and remote mode hardening | IN-005, IN-012, SC-* |
| WP-M11 | fframes template renderer integration | MG-* |
| WP-M12 | Smart render (stream copy + smart cut) | RN-010..012, QA-006 |
| WP-M13 | Analysis features (silence, scenes, loudness) + agent tools | AN-002..005, AG-* |
| WP-M14 | Fonts (bundled, system, custom) | FT-* |
| WP-M15 | Optional cloud providers | RC-* |

---

## 27. Open questions

1. GPL vs LGPL ffmpeg build for distribution (LC-003); affects H.264 encoder quality and the node-level libav option.
2. Which small whisper model to bundle (TR-021): quantized multilingual `base` (default proposal) vs English-only
   `base.en` (better English accuracy, no other languages).
3. Whether the Remotion `<Video>` media tag decodes VP9-alpha proxies in the Player; if not, motion-graphic preview
   relies on the WASM SVG path (MG-020) earlier than planned.
4. Smart cut (RN-011) default-on criteria across encoders beyond x264.
5. Whether caption clips should optionally stay linked to their source clip (TR-052 chooses unlinked copies for v1).
6. Retention of exports on remote engines (EX-008) and per-user storage quotas for multi-user servers.

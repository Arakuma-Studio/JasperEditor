# JasperEditor Architecture (v1, milestones M1 and M2)

Status: authoritative architecture for the from-scratch JasperEditor codebase. Written 2026-09-30 by the lead architect;
§19 (M2: colour grading, clip processing, motion-graphics clips, tracking, transitions UI) added 2026-10-01.
Audience: the engineers and autonomous agents who implement JasperEditor. Read this first, then the specs it cites.

**Precedence.** When this document and a spec disagree, this document wins. When two specs disagree, §2.3 decides.
Specs and research this document is built on (all ours, all clean-room):

| Short name | File |
|---|---|
| S01 | `docs/specs/01-project-model-and-state.md` (document model, commands, undo, persistence, agents) |
| S02 | `docs/specs/02-timeline.md` (timeline panel, editing gestures, keymap) |
| S03 | `docs/specs/03-monitors-effect-controls-rendering-items.md` (monitors, render model, inspector, effects) |
| S04 | `docs/specs/04-media-render-and-backend.md` (engine, ingest, jobs, render planner) |
| S05 | `docs/specs/05-ui-shell-premiere-design.md` (shell, docking, design system, PWA, Electron; its Agent panel chapter §17 is superseded by D-18 / §11) |
| S06 | `docs/specs/06-color-grading.md` (M2: Lumetri-style grade, LUT assets, scopes) |
| S07 | `docs/specs/07-clip-processing.md` (M2: processed media versions, upscale/stabilise/de-judder/denoise, remote GPU) |
| S08 | `docs/specs/08-motion-graphics-clips.md` (M2: Remotion bundles as clips, props forms, pre-rendered masters) |
| S09 | `docs/specs/09-tracking.md` (M2: point/planar tracking, corner pin, warp stage) |
| S10 | `docs/specs/10-transitions-ui.md` (M2: transitions drawn and edited in the timeline) |
| R-OMS | `docs/research/orquester-multiplatform-setup.md` |
| R-NVL | `docs/research/native-video-libraries.md` |
| R-FF | `docs/research/fframes.md` |
| R-PUI | `docs/research/premiere-ui-design-spec.md` |

**Requirement ID collisions.** Several specs reuse the same prefixes (`KF`, `FX`, `KND`, `AGT`, `RND`, `ARC`, `PRJ`, `PGM`, `ENG`, `EX`, `AG`, `TXT`). Always cite requirements with the spec number: `S01:KF-003`, `S03:KF-020`, `S04:EX-001`, `S05:EX-020`. Work packages below follow this convention.

---

## 0. Clean-room rule (applies to every contributor, human or agent)

- The purchased Remotion "Editor Starter" lives, gitignored, under `.reference/` and as `editor-starter.zip` in the repo root. **Nobody who writes JasperEditor code may open, read, grep, unzip or copy anything under `.reference/` or `editor-starter.zip`.** Worktrees do not contain these files; do not go looking for them in the main checkout either.
- Work only from `docs/specs/*`, `docs/research/*`, this file, public npm/crate documentation, and your own knowledge.
- All code is original. Remotion's public npm packages (`remotion`, `@remotion/player`, `@remotion/renderer`, `@remotion/bundler`, `@remotion/media`, `@remotion/web-renderer`, `@remotion/captions`, `@remotion/google-fonts`, `@remotion/fonts`, `@remotion/shapes`, `@remotion/gif`, `@remotion/layout-utils`) are allowed dependencies (Remotion license: free for teams of up to 3; set `acknowledgeRemotionLicense` on the Player).
- fframes (MIT) is an allowed dependency of our Rust crates.

---

## 1. Product and milestone summary

JasperEditor is a Premiere-style non-linear editor driven by humans and AI agents. It combines three engines:

| Engine | Role | Where it runs |
|---|---|---|
| **Remotion** | The single render model for preview (Player) and for graphics/full renders (`@remotion/renderer`, later `@remotion/web-renderer`) | Browser (Player), engine (headless Chrome) |
| **Native** (ffmpeg/ffprobe, later whisper.cpp) | Probe, fingerprint, thumbnails, waveform peaks, proxies, fast native export (filtergraph composite + encode) | Engine child processes |
| **fframes** (Rust, SVG → CPU raster) | Motion-graphic templates rendered to straight-alpha frames, encoded to alpha masters for export | `jasper-mg` CLI spawned by the engine |

Platforms: web app (browser), installable PWA (desktop + mobile), Electron desktop. All three load the same SPA and talk to the same engine over same-origin HTTP.

**Milestone M1 = a working app** (full acceptance list in §15): Premiere-like docked shell; import media through the engine; multi-track timeline with linked A/V; Program monitor preview in the Remotion Player; move / trim (regular + ripple) / razor; undo/redo with a History panel; text and motion-graphic clips with editable parameters; export via the engine (native ffmpeg path for media-only sequences, Remotion path otherwise); one parameterized fframes template rendered by the `jasper-mg` CLI with a graceful fallback when cargo or the binary is missing; agent transactions over engine HTTP applied live to the open editor; Electron dev shell loads the app; PWA manifest + service worker; `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build` all pass.

---

## 2. Architecture decisions

### 2.1 Decision log

| # | Decision | Rationale |
|---|---|---|
| D-01 | **`apps/web` is a Vite 7 + React 19 SPA with `react-router` 7 in library (declarative) mode.** Not React Router framework mode. | The editor is essentially two screens (Home, Editor). Framework SPA mode adds route modules, `HydrateFallback`, `build/client` output quirks and SSR-oriented tooling for no benefit. A plain Vite build produces `dist/index.html` + hashed `assets/`, which the engine serves with an SPA fallback, which Electron loads over `http://127.0.0.1:<port>/` (so `BrowserRouter` works, no `file://`), and which a hand-written service worker precaches trivially. React Router 8 and its framework plugin require Node ≥ 22.22; our machines run Node 20.20. |
| D-02 | pnpm 10 monorepo mirroring Orquester: `apps/{web,engine,desktop}`, `packages/*`, `native/mg` (Rust), source-shared TS packages (`exports` point at `src/*.ts`, no per-package compile step). | R-OMS §2; keeps HMR across packages and removes build ordering. Only `apps/engine`, `apps/desktop` and `apps/web` produce build artifacts. |
| D-03 | **Document model follows S01.** S02/S03 behaviors are implemented on top of the S01 data model (see §2.3 for every conflict). | S01 is the model owner and the most internally consistent (flicks content time, S01 `Animatable`, transitions-as-fades, effect-based crop). |
| D-04 | **State:** one `EditorSession` per open project built on a **zustand vanilla store** (external store, `useSyncExternalStore` hooks) holding an immutable `ProjectDocument`; command handlers are written with **Immer** `produce` for structural sharing. The playhead lives in a separate **`TransportStore`** that is subscribed to imperatively (no React re-render per frame). | S01:SES-002/003, S02:TL-155, S03:ARC-010. Immer gives cheap structural sharing (undo snapshots cost only changed objects) and readable handlers; zustand vanilla is a tiny, well-known external-store primitive usable outside React (agents, autosave). |
| D-05 | **Undo = snapshot history** of committed document references (S01:UND-001), labeled, origin-aware, gesture-coalesced. | Exact, independent of handler reversibility, cheap with structural sharing. |
| D-06 | **Docking = `dockview-react` 8.x (MIT).** | Tabs, groups, edge/center drop zones, floating groups, popout windows, maximize, JSON (de)serialization, CSS-variable theming (R-PUI §5.3, S05 §5). `react-resizable-panels` (MIT) has no tabs or docking; `flexlayout-react` (MIT) is the fallback if a blocker appears; an in-house dock is months of work. |
| D-07 | **Engine = Fastify 5 on Node**, one process, TCP only. Port **47900** in dev/server, random port (`--port 0`) under Electron. Real-time: **NDJSON `GET /events`** for jobs/media/doc events; **WebSocket `/agent`** for the agent relay between engine and the open editor session. | S04 §3, §19; R-OMS §8.6. Heavy work always in child processes. |
| D-08 | **Persistence in M1 = engine-backed project store** (`<appdir>/projects/<projectId>/project.jasper` envelope + view file + versions). IndexedDB/OPFS browser-only store and desktop `.jasper`-anywhere files are M2. | M1 requires the engine for media anyway; one store implementation keeps M1 achievable while honoring the S01:PER-001 interface. |
| D-09 | **Media identity:** the document's `MediaAsset.id` is an S01 id (`med_…`). The engine issues its own **`mediaKey`** (`mk_…`) for every registered file; the document references it through an `engine-store` locator (plus a `path` locator on desktop). Clients and agents never send raw paths except to the desktop/local `media/register` route. | Reconciles S01:ID-001/AST-004 with S04:SC-003 (engine-issued ids only). |
| D-10 | **Waveform wire contract v1 = S04:WF-001** (float32 max-abs, 100 peaks/s, per channel). The S02:TL-332 min/max pyramid is computed client-side in a worker from that data (M2 may add a pyramid contract v2). Filmstrips = S04:TH-002 sprite sheets + JSON index. | One contract shared by engine and future browser fallback. |
| D-11 | **Export planner M1 = two paths:** `native` (ffmpeg filtergraph composite; fframes masters overlaid natively) and `remotion` (full `renderMedia`). `copy` (smart render), `hybrid` (Remotion alpha intermediates composited natively), `browser` and `cloud` are M2+. | S04 §11 staged; the M1 planner already emits the S04:RP-010 `RenderPlan` shape with `blockers`. |
| D-12 | **fframes integration = Design C first** (R-FF §7): one precompiled `jasper-mg` binary containing all templates, reading a JSON spec at runtime, piping straight RGBA to ffmpeg. **Preview in M1 uses a TypeScript SVG "twin"** of each template inside the Remotion composition; the WASM SVG bridge (Design B) replaces the twin in M2; agent-authored graphics (Design A) are M3. | Zero compile latency for edits; works on this CPU-only box; avoids WASM toolchain (`wasm-bindgen` not installed) in M1; the twin is also the no-cargo fallback. |
| D-13 | **FFmpeg: ship an LGPL build (decided).** Dev/CI may use `ffmpeg`/`ffprobe` from `PATH` (system 6.1.1). Resolution order `JASPER_FFMPEG`/`JASPER_FFPROBE` env → packaged resources (`<resources>/bin`, `<resources>/ffmpeg-lgpl`) → dev vendor directory (`vendor/ffmpeg-lgpl/<platform>`, `pnpm ffmpeg:lgpl`) → `PATH`. Distribution: an LGPL FFmpeg (no `--enable-gpl`, never `--enable-nonfree`) shipped as a sidecar executable run as a separate process, never linked into our code. Encoders: H.264/HEVC via hardware (VideoToolbox, NVENC, QSV, AMF, VAAPI) with OpenH264 (Cisco binary) as software fallback; AV1 via SVT-AV1/libaom; VP9 via libvpx; AAC native; Opus via libopus; ProRes 4444 (`prores_ks`) for alpha intermediates. The engine probes `ffmpeg -encoders` at startup, reports them in `/api/capabilities`, and export presets pick the best available encoder; when running against a GPL system build in dev, x264 may be used but must never be required. Ship FFmpeg's license + source link in an About/Licenses screen. x264/x265 only as an optional user-installed add-on or under x264's commercial license. **Implemented (wp-3l):** `apps/engine/src/tools/encoders.ts` — startup probe of `-encoders`/`-hwaccels`/`-version` (license), hardware H.264 encoders confirmed by a cached test encode, preference hardware → `libopenh264` → `libx264` (only if present) → AV1 (`libsvtav1`/`libaom-av1`, MP4) / VP9 (`libvpx-vp9`, WebM+Opus) with a capability message; `media.encoding` in `/api/capabilities` and `encoder` in the render plan; `JASPER_FFMPEG_LGPL_ONLY=1` ignores GPL/nonfree encoders; the Remotion path renders a ProRes 422 HQ intermediate that our ffmpeg encodes unless the selected encoder is libx264. **Remotion's compositor FFmpeg (checked for 4.0.499): every `@remotion/compositor-*` package ships a GPL build (`--enable-gpl --enable-libx264 --enable-libx265 --enable-libfdk-aac`, "GPL version 2 or later"; Windows also ships an FFmpeg 6.1 `avcodec-60.dll` reporting "nonfree and unredistributable"), and the `remotion` compositor binary links those libraries.** It is never shipped. **Final mechanism (wp-lgpl, decided: the Remotion path uses our LGPL FFmpeg):** `pnpm ffmpeg:lgpl` (`scripts/ffmpeg/`, inputs pinned by sha256 in `manifest.json`) assembles one *binaries directory* per platform under `vendor/ffmpeg-lgpl/<platform>-<arch>/`: an LGPL FFmpeg **7.1** shared build (the release series the 4.0.499 compositor links: libavcodec 61, libavformat 61, libavutil 59, libavfilter 10, libavdevice 61, libswscale 8, libswresample 5; BtbN `lgpl-shared` for Linux/Windows, `build-lgpl-from-source.sh` for macOS) with `libopenh264`, `libvpx`, `libsvtav1`, `libopus`, native `aac`, `prores_ks`, plus Remotion's own compositor executable copied unmodified, the license text, a notice and `BUILDINFO.json`. The engine passes it as Remotion `binariesDirectory` to every call and uses its ffmpeg for the native path; resolution `JASPER_REMOTION_BIN_DIR` → `<resources>/ffmpeg-lgpl` → `vendor/ffmpeg-lgpl/<platform>`. Without it a **dev** engine falls back to Remotion's bundled build with the capability warning "Remotion is using its bundled GPL FFmpeg (dev only)" (`render.remotionBinaries`); every other engine (packaged, built, server) reports `remotionLocal: 'unavailable'` and refuses Remotion renders, and a directory whose ffmpeg is not an LGPL build is refused too. Because Remotion's `h264`/`aac` ask for `libx264`/`libfdk_aac`, a Remotion export is planned in `apps/engine/src/remotion/export-plan.ts`: ProRes 422 HQ + PCM intermediate encoded by the selector's encoder (progress "Step 1/2 · Remotion → ProRes", "Step 2/2 · <encoder>"), or VP9/Opus WebM directly. Packaging (`apps/desktop/scripts/package.mjs`, `pnpm --filter @jasper/desktop dist`) stages the engine without optional dependencies (no `@remotion/compositor-*`), ships the directory as `<resources>/ffmpeg-lgpl`, and the license guard (`pnpm ffmpeg:check`, also electron-builder `afterPack`) fails on `--enable-gpl`, `--enable-nonfree`, x264/x265/fdk-aac, a compositor package or a missing LGPL directory. `GET /api/licenses` feeds the FFmpeg license text and source link in Help ▸ About. Details and open points (macOS/Windows not run, OpenH264 patent coverage, LGPL 3 terms of the BtbN build): `docs/wp-notes/wp-lgpl.md`, `docs/wp-notes/wp-3l.md`. **M2 additions (2026-10-01):** (a) GPL-only *filters* are absent from the shipped build and must never appear in generated filter text: `eq`, `hqdn3d`, `perspective`, `boxblur`, `smartblur`, `delogo`, `vidstab*` of a GPL vid.stab, `frei0r`, `spp/pp7/uspp/fspp`, `mpdecimate`, `pullup` (checked on the vendor build). The M1 `jasper.brightness-contrast` native mapping used `eq` (never reached: the planner blocked it) and is replaced by the colour-LUT path (§19.2). LGPL filters used in M2: `lut3d`, `format`, `deshake`, `deblock`, `atadenoise`, `fftdnoiz`, `nlmeans`, `minterpolate` (not used by default), `setparams`. (b) **vid.stab** was relicensed to LGPL-2.1-or-later in August 2026 (upstream `RELICENSE.md`, issue #165) but has no release tag since (v1.1.2 and older are GPL). **Primary (all OSes, decided 2026-10-01): the pinned post-relicense commit compiled to WebAssembly** (`scripts/vidstab-wasm/build.sh`, wasi-sdk pinned; `vidstab.wasm` shipped as a separate replaceable file with its source pin and LGPL notice) and driven by jasper-proc (ffmpeg decode → WASM detection + camera path → 16-bit warp → ffmpeg encode). Optional on Linux: FFmpeg 7.1's `configure` still lists `libvidstab` as GPL, so our LGPL source build pins the same commit and patches `configure` to move `libvidstab` to the non-GPL external libraries; the licence guard accepts `--enable-libvidstab` only with that recorded commit, and the engine uses those filters only then. `deshake` is the last resort (S07:PST-001…004). | |
| D-14 | **Styling:** Tailwind 4 (`@tailwindcss/vite`) + `--pr-*` CSS tokens (S05 §8) bridged with `@theme inline`. **`packages/compositions` uses inline styles only** (no Tailwind), so the Remotion webpack bundle needs no Tailwind config and preview == render. | |
| D-15 | **Lint/format = Biome 2** (`biome check`), plus `scripts/check-tokens.mjs` enforcing S05:DT-002 (no color literals / raw palette classes in `packages/ui/src/**` and `apps/web/src/**` outside theme files). | One fast tool; the token rule is a 50-line script. |
| D-16 | **Tests = Vitest 4.1** (Node 20 compatible; Vitest 5 needs Node 22) with root `projects`; property tests with `fast-check`; DOM tests with `happy-dom` + Testing Library. **E2E = Playwright** using the system Chrome (`channel: 'chrome'`, `/usr/bin/google-chrome`) to avoid browser downloads. | |
| D-17 | **Electron:** no second renderer app, no IPC byte bridge. Dev: window loads the Vite dev server (`http://127.0.0.1:5173`), engine runs separately. Packaged: main forks the bundled engine with `utilityProcess.fork` (ESM bundle, `--port 0`), sets a per-launch token cookie, and loads `http://127.0.0.1:<port>/`. | R-OMS §4.2, §8.5 (Orquester's in-process CJS daemon bundle is broken). |
| D-18 | **The agent API is an MCP server; there is no in-app agent.** External coding agents (Claude Code, Codex CLI, Cursor…) drive the editor through `jasper-mcp` (`apps/mcp`, official `@modelcontextprotocol/sdk`): stdio for local clients, and the same tools over Streamable HTTP at the engine's `/mcp`. Underneath sit the typed transactions/queries of S01 §21: engine HTTP, the `/agent` WebSocket relay into the open editor (live edits, `Agent:` undo entries), headless fallback and the approval gate. The Agent panel, its workspace, menu, tool and shortcuts were removed (wp-mcp); approvals are a shell-level card. Later: proposals/ghosts, vision checks, agent-authored fframes graphics, all as MCP tools. | User decision (wp-mcp). S01 §21; S05 §17 is superseded. |
| D-19 | **Remotion pinned to exactly `4.0.499`** for every `remotion`/`@remotion/*` package in the workspace (Remotion requires identical versions). Upgrading is a single dedicated change. | S02/S03/S04 verification notes target 4.0.499. |
| D-20 | **Runtime baseline Node ≥ 20.19** (machine: Node 20.20.2, pnpm 10.34). TypeScript **5.9.3** (not 7.x). Avoid dependencies that require Node 22 (React Router 8, Vitest 5). Electron's npm package may print an engines warning on Node 20; do not enable `engine-strict`. | |
| D-21 | **Colour = pointwise colour ops fused into one baked 3D LUT per run (M2).** Every colour effect implements `EffectSpec.color`; consecutive colour effects of a layer are baked (33³, tetrahedral) into one LUT that the WebGL preview samples and the native path applies with `lut3d`. No GLSL port of the grade maths. | One implementation of the maths (TS) → preview and export agree to LUT precision; the grade never forces the Remotion path; `lut3d` is LGPL and fast. |
| D-22 | **Native-first through export extensions (M2).** Features plug into the native planner/builder only through `NativeExtension` (§19.6): effect filters, extra native-capable kinds, claimed layers, pre-rendered layer overrides (`layer`/`sequence` space), prepare steps (also for the Remotion path). | Five packages extend the export in parallel without editing `planner.ts`/`native.ts`; everything that can be pre-rendered stays native. |
| D-23 | **Clip processing = derived media (M2).** Processing jobs write new managed media files registered as `MediaAsset`s with `derivation.recipe = {op:'process', steps}`; clips swap sources (`media.derive`, `clip.replaceSource`) with Motion compensation. Processors run in one CLI (`jasper-proc`) locally or on a remote host over SSH. | No render-time cost; the native path reads the processed file; one code path for local and remote. |
| D-24 | **Super-resolution runtime = ONNX Runtime (`onnxruntime-node`, MIT), models on demand (M2).** Catalogue with pinned sha256 and recorded weight licences; default SPAN 2× (CC BY 4.0, attribution) pending the user's decision (§19.12). | Permissive runtime with CPU and CUDA providers; weights not bundled. |
| D-25 | **Stabilisation = vid.stab (LGPL since the 2026 relicense, pinned commit) compiled to WebAssembly — one code path on Linux, Windows and macOS; FFmpeg's vid.stab filters from our LGPL source build as an optional faster Linux path; `deshake` last resort (M2).** | Best quality within D-13 on every OS without per-platform native builds; see the D-13 M2 note. |
| D-26 | **Motion-graphics clips = imported Remotion bundles (M2).** Pinned 4.0.499 (D-19); preview through the bundle's own page driven frame by frame in an iframe (adapter over the renderer-page protocol) or its cached VP9-alpha preview; export through cached ProRes 4444 masters (native `layer` override). | The user's own project code (Tailwind, staticFile, fonts) runs unchanged; exports stay native. |
| D-27 | **Tracking = OpenCV.js (Apache-2.0, WASM) in engine worker threads (M2)**; trackers stored on the plate clip in media pixels / content time; applied to targets as ordinary keyframes (corner pin or Motion). | No native build; manual correction = keyframe editing; undoable, agent-friendly. |
| D-28 | **Corner pin and keyframed Motion on the native path = warp stage (M2)**: layers are warped per frame in worker threads and cached as sequence-space ProRes 4444 intermediates. | `perspective` is GPL; ffmpeg cannot animate scale/rotation per frame reliably; the warp stage also lifts the M1 "keyframes force Remotion" limit. |
| D-29 | **Schema v3 (M2)**: additive fields only (mg-bundle kind, LUT/bundle headers, process recipes, trackers, trackedBy, curve params); v2→v3 is a version bump so M1 builds open M2 files read-only. | Honest forward-compatibility signal (S01:MIG-003). |
| D-30 | **Transitions UI keeps the model's three alignments (M2)**; default transitions are a user preference; audio crossfades between clips land in the same package. | No model change for the UI; Premiere-familiar behaviour. |

### 2.2 Pinned toolchain (M1)

| Area | Package | Version |
|---|---|---|
| Package manager | pnpm | `packageManager: "pnpm@10.34.5"` |
| Language | typescript | `5.9.3` |
| UI | react, react-dom | `^19.2.0` |
| Build | vite `^7.3.0`, @vitejs/plugin-react `^5.1.0`, @tailwindcss/vite + tailwindcss `^4.3.0` | |
| Routing | react-router | `^7.18.0` (library mode) |
| State | zustand `^5.0.0`, immer `^11.1.0`, zod `^4.1.0` | |
| Dock | dockview-react | `^8.3.0` |
| Primitives | radix-ui `^1.4.0` (unified package), lucide-react, @fontsource/source-sans-3, @fontsource/inter | latest |
| Remotion | remotion, @remotion/player, @remotion/renderer, @remotion/bundler, @remotion/media, @remotion/fonts, @remotion/google-fonts | `4.0.499` exact |
| Engine | fastify `^5.6`, @fastify/static (latest major whose `fastify-plugin` accepts fastify 5; 10.x at time of writing), @fastify/websocket `^11`, @fastify/cookie `^11` | |
| Desktop | electron `^44` (fallback `^39` if install fails on Node 20), electron-builder `^26.15`, esbuild | |
| Dev tools | tsx `^4.20`, concurrently, wait-on, cross-env, @biomejs/biome `^2.5` | |
| Tests | vitest `^4.1.0`, fast-check, happy-dom, @testing-library/react, @playwright/test `^1.55` | |
| Rust | rustc/cargo 1.96, `fframes = "=1.0.3"` (no `h264` feature), serde, serde_json, clap | |

Check exact semver ranges at install time (`pnpm view <pkg> version`) and commit `pnpm-lock.yaml`.

### 2.3 Spec reconciliation (normative)

| Topic | Conflict | Decision |
|---|---|---|
| Package names | S01 `project-model`, `editor-session`; S02 `timeline-core`; S03 `scene`, `color`; S05 `editor-ui` | `packages/project` (`@jasper/project`) = S01 project-model + S02 timeline-core + S03 scene core (pure). `packages/session` (`@jasper/session`) = S01 editor-session. `packages/ui` (`@jasper/ui`) = S05 design system primitives. Panels live in `apps/web/src/panels/*`. `packages/color` is M3. |
| Keyframe time base | S01: content time in flicks, `Animatable<T> = {value, keyframes}` inline on each property. S02 TL-348 / S03 §12: clip-local integer frames, `anim` map, boundary keyframes on split, retime table | **S01.** Consequences: head trims, slips, splits and constant-speed changes never rewrite keyframes (they are in content time). Split copies **all** keyframes to both halves with new ids (S01:CLP-007, matches S03:KF split row). S02 Appendix A.6 "boundary keyframes" and S03 §12.5 retime table rows for trim/slip/speed are **not** implemented. |
| Ease parameters | S01 `{influence, slope}` (normalized, 1 = constant speed); S03 `{influence, speed}` in value-units per frame | **S01** storage and evaluation (S01:KF-003/004). UI may *display* speed = slope × average segment velocity. |
| Property addressing | S01 `ParamPath` arrays; S03 dotted `motion.position` strings | Commands and agents use **`ParamPath`** (S01:CMD-010). The property registry keys properties by a dotted **property key** relative to the owner: `transform.position`, `transform.scale`, `transform.rotation`, `transform.anchor`, `opacity`, `volumeDb`, `pan`, `gainDb`, `effects.<fxId>.<param>`, `params.<name>` (motion-graphic). S03 `motion.*` ⇒ `transform.*`. Helpers convert both ways. |
| Crop | S01: effect `jasper.crop`; S03: intrinsic field | **Effect** `jasper.crop` (S01:FX-003). Properties/Effect Controls show a pinned "Crop" section that creates the effect at stack index 0 on first edit. |
| Fades | S01: one-sided transitions; S02 TL-340 / S03 RND-025: clip fields | **S01 transitions** (M2). Timeline fade handles create/resize one-sided transitions. No fade fields on clips. |
| Colors | S01 RGBA float tuple; S03 CSS strings | **S01** `[r,g,b,a]` straight sRGB floats 0..1. |
| Clip kind names | S03 `image`, `animatedImage`, `shape`, `motionGraphic`, `remotionGraphic` | **S01 names:** `video`, `audio`, `still`, `animated-image`, `text`, `solid`, `captions`, `motion-graphic`, `composition`, `nest-video`, `nest-audio`, `adjustment`. Shapes (rect/ellipse) are a future additive kind `shape` (M3). |
| Captions data | S01 transcript entity + captions clip (content time); S03 caption asset (ms tokens); S04 clip-owned word copies | **S01.** `@remotion/captions` `Caption[]` is an edge format (import/export, whisper output). M2. |
| Locked tracks during ripple/insert | S01:TRK-004 rejects with `E_SYNC_LOCKED_TRACK`; S02:TL-250/TL-543 leaves locked tracks untouched | **S02 (Premiere behavior):** locked tracks are treated as sync-lock off and never shift. `E_SYNC_LOCKED_TRACK` is reserved/unused. S01 AC-05 becomes "the locked track is untouched". |
| Refusal codes | S02:TL-953 names (`LOCKED_TRACK`, …) | **S01 `E_*` codes** (S01:CMD-007) plus `E_NOT_IMPLEMENTED`, `E_APPROVAL_DENIED`, `E_APPROVAL_TIMEOUT`, `E_NO_SESSION`. Mapping: LOCKED_TRACK→E_TRACK_LOCKED, MEDIA_LIMIT→E_OUT_OF_MEDIA, SYNC_LOCK_CONFLICT→E_SYNC_CONFLICT, WOULD_OVERLAP→E_OVERLAP, INVALID_RANGE→E_INVALID_PARAM, KIND_MISMATCH→E_TRACK_KIND, STALE→E_REVISION_MISMATCH. Engine HTTP errors use S04:ENG-022 (`{code, message, detail?, retryable}`) with their own codes (`ASSET_NOT_FOUND`, …). |
| Command vocabularies | S01 document commands (`clip.move`…); S02/S05 UI command ids (`timeline.addEdit`…) | **Both, layered.** *Document commands* are serializable JSON handled in `@jasper/project`. *UI commands* (keymap/menu/palette ids) live in `apps/web/src/commands`, read session context (playhead, targeting, selection) and emit document transactions. Agents use document transactions; UI commands are exposed to agents in Stage 2. |
| Asset ids | S04 UUIDs | S01 ids in the document; engine `mediaKey` separately (D-09). |
| Peaks format | S04 100/s max-abs vs S02 min/max pyramid | D-10. |
| Playhead store | S02 "transport store", S03 `playheadStore` | One `TransportStore` in `@jasper/session`. |
| Source marks | S05:PGM-010 "non-undoable UI state" vs S01:PRJ-005/S03:SRC-003 document | **Document, undoable** (`item.setMarks`). |
| Track targeting / patching | S02:TL-013 persisted with sequence vs S01:SES-004 view state | Per-sequence **view record** (persisted, not undoable, not in the document). |
| Speed limits | S01 `[0.01, 100]`; S02 rate-stretch UI `[0.1, 20]` | Document allows S01 range; UI tools clamp to the S02 preference range. |
| Track Select default | S02 vs R-PUI | **S02** (all tracks by default, Shift = one track). |
| Proxy tiers | S03 p1080/p720/p540/p360; S04 720/540 | **S04** (`proxy-720`, `proxy-540`). |
| Sequence background | S03 `'black'|'#color'|'transparent'` | S01 `backgroundColor: RGBA`; alpha 0 = transparent. |
| Guides, safe margins | S03:DM-021 document fields | Additive fields in M2 (`sequence.guides`, `sequence.safeMargins`), no schema bump needed (defaults via zod). |
| Blend modes | S01 lists 8, S03 lists 27 | Schema enum = S01's 8 in v1; widen additively later. |
| Composition input | S01:RND-002 snapshot; S03:ARC-003 `{doc: RenderDoc, options}` | `inputProps = {doc: RenderDoc, options: RenderOptions}` where `RenderDoc` = S01 `RenderSnapshot` with resolved media URLs and fonts (§8). |

---

## 3. Repository layout

```
JasperEditor/
├── package.json                  # root scripts (§14), packageManager, pnpm.onlyBuiltDependencies
├── pnpm-workspace.yaml           # apps/*, packages/*
├── tsconfig.base.json            # strict, ES2022, moduleResolution Bundler, noEmit, jsx react-jsx
├── biome.json
├── vitest.config.ts              # root projects: packages/*, apps/engine, apps/web
├── playwright.config.ts          # e2e (wave 3)
├── .gitignore                    # keeps .reference/ and editor-starter.zip ignored (never remove)
├── .stage/                       # committed dev appdir skeleton (runtime files gitignored)
├── docs/                         # specs, research, this file
├── scripts/
│   ├── check-tokens.mjs          # S05:DT-002 lint
│   ├── make-fixtures.mjs         # generates fixtures/media/* with ffmpeg (gitignored outputs)
│   └── mg-build.mjs              # builds native/mg if cargo exists, else prints a skip notice (exit 0)
├── fixtures/media/               # generated test media (gitignored)
├── e2e/                          # Playwright smoke tests (wave 3)
├── native/mg/                    # Rust workspace: jasper-mg CLI + templates (fframes)
│   ├── Cargo.toml
│   ├── crates/jasper-mg-core/
│   ├── crates/jasper-mg-templates/
│   ├── crates/jasper-mg-cli/     # binary "jasper-mg"
│   └── fixtures/*.json           # sample specs
├── apps/
│   ├── web/                      # @jasper/web — Vite SPA + PWA (the only UI)
│   │   ├── index.html, vite.config.ts, public/{manifest.webmanifest, sw.js, theme-boot.js, icons/}
│   │   └── src/
│   │       ├── main.tsx, App.tsx               # router: "/" Home, "/project/:projectId" Editor
│   │       ├── runtime/                        # platform detection, engine bootstrap, desktop bridge types
│   │       ├── state/                          # SessionProvider, engine hooks, app context
│   │       ├── shell/                          # header, menubar, dock host, workspaces, focus, keymap dispatcher,
│   │       │                                   #   command palette, toasts, dialogs, layout-mode switch
│   │       ├── commands/                       # UI command registry, keymap defaults, per-domain command modules
│   │       ├── panels/registry.ts              # panel registry (PanelDefinition list)
│   │       ├── panels/<kind>/                  # one folder per panel (owned by different work packages)
│   │       ├── home/                           # Home screen (project list/new/open)
│   │       ├── import/                         # import service (upload / register path), drop handling
│   │       ├── agent-bridge/                   # window.jasper bridge + /agent WS client (live relay for MCP agents)
│   │       └── pwa/                            # service worker registration
│   ├── engine/                   # @jasper/engine — Fastify media server ("jasperd")
│   │   └── src/{cli.ts, index.ts (startEngine), server.ts, auth/, events/, jobs/, media/, derivatives/,
│   │            projects/, uploads/, export/, remotion/, fonts/, mg/, agent/, routes/}
│   ├── mcp/                      # @jasper/mcp — jasper-mcp: the MCP server for external agents (§11)
│   │   ├── src/{cli.ts (stdio), server.ts, discovery.ts, link.ts, context.ts, errors.ts, format.ts, tools/}
│   │   └── dist/jasper-mcp.mjs   # `pnpm mcp:build`: one bundled executable file (gitignored)
│   └── desktop/                  # @jasper/desktop — Electron shell only
│       └── src/{main.ts, preload.cts, engine-process.ts}, scripts/build-main.ts, electron-builder config
└── packages/
    ├── project/                  # @jasper/project — schema, time, ids, commands, invariants, keyframes,
    │                             #   registries, render snapshot, scene resolver, migrations (pure, no DOM/Node)
    ├── session/                  # @jasper/session — EditorSession, history, gestures, selection, view state,
    │                             #   TransportStore, ProjectStore adapters, React hooks (subpath ./react)
    ├── api/                      # @jasper/api — zod contracts: engine routes, events, jobs, capabilities
    ├── engine-client/            # @jasper/engine-client — typed fetch client, NDJSON event stream, uploads
    ├── ui/                       # @jasper/ui — tokens, Tailwind bridge, dockview theme, primitives, icons, cursors
    ├── compositions/             # @jasper/compositions — SequenceComposition + layers (Player + renderer)
    ├── mg-templates/             # @jasper/mg-templates — template catalog, param schemas, TS SVG twins
    └── config/                   # @jasper/config — appdir layout, env parsing, ports (Node only)
```

### 3.1 Dependency rules (enforced in review; a Biome/TS path check may follow)

```
project        → zod, immer                      (no DOM, no Node built-ins, no React)
mg-templates   → zod, (type-only) project
api            → zod, project
engine-client  → api                             (fetch + ReadableStream; runs in browser and Node 20)
session        → project, api, engine-client, zustand; react only in ./react subpath
ui             → react, radix-ui, lucide-react, dockview-react (theme only); type-only project imports allowed
compositions   → remotion, @remotion/*, project, mg-templates   (NO session, ui, tailwind)
config         → node built-ins
web            → everything above except config
engine         → project, api, config, mg-templates, compositions (bundled via @remotion/bundler), fastify…
desktop        → electron, config (paths only)
```

Each TS package: `"type": "module"`, `"exports": {".": "./src/index.ts"}` (plus subpaths like `"./react"`), `"scripts": {"typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run"}`, `tsconfig.json` extending the base. Dependencies between workspace packages use `"workspace:*"`.

---

## 4. Runtime topology

### 4.1 Profiles (S04:RT)

| Profile | M1 | Client loads from | Engine |
|---|---|---|---|
| **Dev web** | yes | Vite `http://127.0.0.1:5173` (proxies `/api`, `/events`, `/agent` (ws), `/media`, `/mg`, `/renders`, `/fonts`, `/health` to the engine) | `tsx watch apps/engine/src/cli.ts` on `127.0.0.1:47900`, `JASPER_APPDIR=./.stage` |
| **Desktop (D)** | dev yes, packaged smoke | dev: Vite dev server; packaged: engine origin `http://127.0.0.1:<random>/` | dev: attach to 47900; packaged: `utilityProcess.fork(engine.mjs --port 0)` |
| **Web + remote engine (WE)** | served-build smoke only | engine origin (behind Caddy on a server) | systemd, password auth (M2) |
| **Web only (W)** | no (M2) | static host | none; browser fallback engine (mediabunny) |

The SPA always uses **relative URLs** (`/api/...`). On startup `apps/web/src/runtime/bootstrap.ts` calls `GET /health`; if it fails the app shows an "Engine not reachable" screen with the `pnpm dev:engine` hint (profile W arrives in M2).

### 4.2 Auth (S04:ENG-020, SC-001)

- Engine binds `127.0.0.1` only in M1.
- **Local token mode** (`JASPER_LOCAL_TOKEN` set, used by Electron packaged mode): every request except `/health` needs `Authorization: Bearer <token>` or cookie `jasper_session=<token>` (HttpOnly, SameSite=Strict). `Host` must be `127.0.0.1:<port>` or `localhost:<port>`.
- **Dev mode** (`JASPER_DEV=1`, no token): no auth. The Host check still applies; in dev the engine additionally accepts `127.0.0.1:5173` and `localhost:5173` (requests arriving through the Vite proxy, which keeps the original Host).
- Remote password mode: M2.

### 4.3 Appdir (dev: `./.stage`, packaged: `<Electron userData>/jasper`, server: `/var/lib/jasper`)

```
<appdir>/
  engine/engine.json            # optional config (zod, unknown keys tolerated)
  engine/runtime.json           # written while an engine runs (0600): url, port, pid, token, version; how
                                #   local tools (jasper-mcp, §11.2) find the engine; removed on stop
  engine/media-index.json       # mediaKey → {fingerprint, storage, probe, sizeBytes, mtimeMs}   (atomic writes)
  engine/jobs.jsonl             # job journal (S04:JB-030)
  engine/logs/YYYY-MM-DD.log
  projects/<projectId>/project.jasper        # S01:PER-002 envelope (atomic write: tmp + fsync + rename)
  projects/<projectId>/project.jasper-view   # view state (S01:SES-004)
  projects/<projectId>/versions/<savedAt>.jasper
  media/<mediaKey>/<originalName>            # managed copies (uploads)
  cache/<fingerprintHex>/<kind>-<paramsHash>.<ext>   # derivatives: poster, sprite, peaks, proxy, keyframes
  mg/<renderKey>/{master.mov, preview.webm, poster.png}
  renders/<jobId>/output.<ext>
  remotion/bundle/                           # cached Remotion serveUrl (dev); packaged builds ship a prebuilt bundle
  tmp/                                       # wiped on start
```

`@jasper/config` exposes `resolveAppdir({argv, env})`, `appdirPaths(appdir)`, `DEFAULT_ENGINE_PORT = 47900`, env names (`JASPER_APPDIR`, `JASPER_PORT`, `JASPER_DEV`, `JASPER_LOCAL_TOKEN`, `JASPER_WEB_DIR`, `JASPER_FFMPEG`, `JASPER_FFPROBE`, `JASPER_MG`, `JASPER_REMOTION_LICENSE_KEY`, `JASPER_BROWSER_EXECUTABLE`; for `jasper-mcp`: `JASPER_ENGINE_URL`, `JASPER_ENGINE_TOKEN`, `JASPER_ENGINE_ENTRY`, `JASPER_MCP_ENTRY`), `desktopAppdir()` and `parseEngineRuntime()`.

---

## 5. `@jasper/project` — the pure model

Everything here is deterministic, DOM-free and Node-free, and runs in the browser, workers, the Remotion bundle and the engine (S01:ARC-001).

### 5.1 Modules

```
packages/project/src/
  index.ts
  ids.ts            # Crockford base32 16-char ids with type prefixes (S01:ID-001); IdSource (injectable, deterministic in tests)
  time.ts           # FLICKS_PER_SECOND=705_600_000, Rational, flicksPerFrame, frames↔flicks (floor/round), seconds, fps number
  timecode.ts       # NDF/DF format+parse (S02 Appendix A.1), partial entry parsing (S02:TL-205, S05:TY-006)
  schema/           # zod schemas mirroring S01 types (document, items, media, sequences, tracks, clips, effects, keyframes,
                    #   transitions, markers, transcripts, fonts, envelope); passthrough for unknown fields (S01:DOC-005)
  presets.ts        # sequence presets (S01:SEQ-003) and default track layout V1–V3/A1–A3
  factories.ts      # createEmptyProject, defaultTransform(intrinsicBox, frame, scaling), default text style…
  derive/           # sequence index (per-track sorted clips, interval lookup), duration, link maps, usage, gaps, edit points
  keyframes.ts      # evaluate() per S01:KF-003/004 incl. auto-bezier, hold-only types, color lerp in straight sRGB
  commands/
    types.ts        # Command union, Transaction, TransactionResult, Issue, CommandContext, handler signature
    schemas/*.ts    # zod schema per command (ALL M1 command types, §5.3)
    handlers/*.ts   # one file per namespace (project, bin, item, media, sequence, track, marker, clip-core, clip-edit, param,
                    #   keyframe, effect, transition)
    catalog.ts      # type → {schema, handler, label}; the ONLY registration point
    apply.ts        # applyTransaction: resolve temp refs/labels/"$selection", run handlers with Immer, invariants, result
    placement.ts    # overwrite/insert/sync-lock algorithms (S02 Appendix A.4/A.5, S01:CLP-003, TRK-006)
  invariants.ts     # INV-001…INV-015 (with the §2.3 change to locked tracks)
  migrations.ts     # vN→vN+1 chain, fixtures in test/fixtures/v<N>/*.jasper
  registry/
    kinds.ts        # kind capabilities (S03:KND-001 idea, S01 kind table): track kind, bounded content, engines
    effects.ts      # effect registry: params, preview css/svg, native filter mapping, capabilities (S01:FX-021, S03 §15)
    properties.ts   # property registry: key, label, type, range, unit, animatable, default, read/write (S03 §11)
    mg.ts           # MgTemplateRegistry interface (implementations injected via CommandContext)
  render/
    snapshot.ts     # buildRenderSnapshot (S01:RND-001)
    scene.ts        # resolveSceneAt(snapshot, frame) → ResolvedLayer[] with matrices (S03:ARC-001, DM-010…012)
    transform.ts    # layer matrix M(q)=P+R·S·(q−A), quad, bounds, inverse
    plan.ts         # engineAffinity(snapshot) per range (native / remotion / fframes) (S01:SES-010)
  agent/
    schema-export.ts # JSON Schemas of all commands + registries for schema.get (S01:AGT-002) via z.toJSONSchema
```

### 5.2 Core types (abridged; full field lists in S01 §4–§13)

```ts
export type Rational = { num: number; den: number };
export type RGBA = [number, number, number, number];
export type Vec2 = [number, number];
export type Animatable<T> = { value: T; keyframes: Keyframe<T>[] };
export type Keyframe<T> = { id: string; time: number /*flicks*/; value: T;
  interpolation: 'linear' | 'bezier' | 'auto-bezier' | 'continuous-bezier' | 'hold';
  easeIn: { influence: number; slope: number }; easeOut: { influence: number; slope: number } };

export type ProjectDocument = { schemaVersion: 1; projectId: string; name: string; settings: ProjectSettings;
  rootItems: string[]; items: Record<string, ProjectItem>; media: Record<string, MediaAsset>;
  synthetics: Record<string, SyntheticSource>; transcripts: Record<string, Transcript>;
  fonts: Record<string, FontRef>; sequences: Record<string, Sequence>; extensions: Record<string, unknown> };
// Sequence, Track, ClipCommon, per-kind clip fields, Transform, EffectInstance, Transition, Marker: exactly S01 §7–§13.
// MediaLocator adds engine-store usage: { type: 'engine-store'; engineId: string; key: string /* mediaKey */ }.
```

M1 schema includes **every** S01 v1 entity (so no migration is needed when features land), but M1 handlers only cover §5.3.

### 5.3 Command API and M1 catalog

```ts
export type Transaction = { protocol: 'jasper.tx/1'; label: string;
  origin: 'user' | { agent: string; runId?: string } | 'system' | 'migration';
  expectedRevision?: number; dryRun?: boolean; sequenceId?: string; commands: Command[] };
export type TransactionResult =
  | { ok: true; revision: number; refs: Record<string, string>; created: string[]; changed: string[]; deleted: string[];
      warnings: Issue[]; results: unknown[] }
  | { ok: false; revision: number; errors: Issue[] };
export type Issue = { commandIndex: number; code: string; message: string; path?: string[]; blocking?: string[] };

export interface CommandContext {
  ids: IdSource; now(): string; revision: number;
  registries: { effects: EffectRegistry; mgTemplates: MgTemplateRegistry; presets: PresetRegistry };
  textMeasurer?: TextMeasurer;             // browser only; headless sets layoutPending (S01:KND-006)
  selection?: { clips: string[]; primaryClip: string | null };  // for "$selection" resolution only
}
export function applyTransaction(doc: ProjectDocument, tx: Transaction, ctx: CommandContext):
  { document: ProjectDocument; result: TransactionResult };   // document === input when !ok or dryRun
export function checkInvariants(doc: ProjectDocument, registries?: …): Issue[];
export function migrate(raw: unknown): { document: ProjectDocument; report: MigrationReport; readOnly: boolean };
```

Rules: handlers are pure (Immer drafts inside `applyTransaction` only), throw `CommandError(code, message, path?, blocking?)` to abort; the transaction is atomic (S01:CMD-004); temp refs `"$name"` (CMD-006); track labels `"V2"`/`"A1"` and time forms (TIME-006) are normalized before handlers run; handlers never read session state (CMD-011).

| Command(s) | Semantics source | Implemented by |
|---|---|---|
| `project.rename`, `project.updateSettings`, `bin.create`, `item.rename`, `item.setLabel`, `item.move`, `item.delete`, `item.setMarks` | S01 §16.2, PRJ-* | WP-00 |
| `media.register`, `media.relink` | S01:LIFE-010, AST-003/004 | WP-00 |
| `sequence.create`, `sequence.updateSettings` (frame-rate map SEQ-006; resize SEQ-007 keep-offset), `sequence.setInOut`, `sequence.setWorkArea` | S01 §7 | WP-00 |
| `marker.add`, `marker.update`, `marker.remove` | S01:SEQ-008 | WP-00 |
| `track.add`, `track.remove`, `track.update` | S01 §8 | WP-00 |
| `clip.place` (overwrite/insert, linked A/V, sync-lock, auto-create tracks, default scaling) | S01:CLP-003/010, KND-003, FX-004; S02:TL-483/484/493 | WP-00 |
| `clip.addText`, `clip.addSolid`, `clip.addMotionGraphic` | S01:KND-006/007/009 | WP-00 |
| `clip.move` (overwrite/insert, deltaTracks, kind-safe, createTracks) | S01; S02:TL-483…488 | WP-00 |
| `clip.trim` modes `regular` and `ripple` (speed-aware, media bounds, linked partners, sync-lock) | S01; S02:TL-533…543 | WP-00 |
| `clip.split` (clipIds / tracks / all-unlocked; links; keyframes copied; tail transition moved) | S01:CLP-007; S02:TL-621/680 | WP-00 |
| `clip.lift`, `clip.extract` (ripple delete, S02 Appendix A.5) | S01; S02:TL-681/682 | WP-00 |
| `clip.update` (non-animated fields incl. text content, template params, enabled, name, label) | S01 | WP-00 |
| `param.set`, `param.setAnimated` (stopwatch semantics) | S01:KF-005, CMD-010/013 | WP-00 |
| `clip.trim` mode `roll`, `clip.slip`, `clip.slide`, `clip.setSpeed`, `clip.duplicate`, `clip.link`, `clip.unlink`, `clip.fitToFrame`, `range.lift`, `range.extract`, `gap.close` | S01 §16.2; S02 §11–§14 | **WP-2B** (stubs from WP-00) |
| `keyframe.add`, `keyframe.update`, `keyframe.remove`, `keyframe.move`, `keyframe.setInterpolation`, `keyframes.prune`, `effect.add`, `effect.remove`, `effect.reorder`, `effect.setEnabled` | S01 §12, §11.3 | **WP-2D** (stubs from WP-00) |
| `transition.*`, `clip.nest`, `clip.addCaptions`, `clip.addComposition`, `clip.addAdjustment`, `clip.replaceSource`, `transcript.*`, `synthetic.*`, `media.derive`, `media.removeUnused`, `sequence.duplicate`, `sequence.delete` | S01 | M2 (schemas defined by WP-00, handlers return `E_NOT_IMPLEMENTED`) |

### 5.4 Registries

- **Effect registry** (`registry/effects.ts`): `EffectSpec = {id, version, label, category, appliesTo, params: ParamSpec[], preview: {css?(p): string; svgFilter?(p, uid): string} , native: {filter(p, ctx): string} | null, expensive?}`. M1 entries (WP-2D): `jasper.crop`, `jasper.gaussian-blur`, `jasper.brightness-contrast`, `jasper.hue-saturation`, `jasper.black-white`, `jasper.flip-horizontal`, `jasper.flip-vertical`. Unknown ids are preserved and bypassed (S01:FX-022).
- **Property registry** (`registry/properties.ts`): drives Properties/Effect Controls rows, agent schemas and range clamping (S03:PRP-002/003 adapted to S01 storage). WP-00 ships entries for transform, opacity, blend mode, audio `gainDb`/`volumeDb`/`pan`, text style fields, solid color, motion-graphic `params.*` (from the template schema); WP-2D extends it.
- **Kind capabilities** (`registry/kinds.ts`): track kind, bounded/unbounded content, visual/audio, supports effects/speed, engine for preview/export — used by the timeline (badges), planner and inspector (S02:TL-022, S03:KND-001).
- **MgTemplateRegistry** interface: `get(id, version) → {paramsSchema: ZodType; defaults; intro/outro frames; canvasDefault}`; implemented by `@jasper/mg-templates` and injected by session and engine.

### 5.5 Render snapshot and scene

```ts
export type MediaHandle = { url: string; proxyUrl: string | null; kind: MediaAsset['kind'];
  width: number | null; height: number | null; durationFlicks: number | null; hasAudio: boolean; rotation: 0|90|180|270 };
export type RenderSnapshot = {
  version: 1; sequenceId: string;
  settings: { width: number; height: number; fps: Rational; backgroundColor: RGBA; sampleRate: 48000 };
  range: { start: number; end: number };            // frames; export range or whole sequence
  durationFrames: number;
  videoTracks: { trackId: string; clips: RenderVisualClip[] }[];   // V1 (bottom) → top; output-disabled tracks omitted
  audioClips: RenderAudioClip[];                    // after mute/solo resolution
  media: Record<string /*mediaId*/, MediaHandle | null>;   // null = offline
  fonts: { fontId: string; family: string; weight: number; style: 'normal'|'italic'; url: string }[];
};
export function buildRenderSnapshot(doc, sequenceId, opts: { range?: {start: number; end: number};
  resolveMedia(asset: MediaAsset): MediaHandle | null; resolveFont(font: FontRef, weight: number, italic: boolean): string | null }): RenderSnapshot;
export function resolveSceneAt(snapshot: RenderSnapshot, frame: number): ResolvedLayer[];   // bottom→top, evaluated values + matrix
```

`RenderVisualClip` carries: `clipId, kind, start, duration, sourceIn (flicks), speed, source` (`{mediaId}` | `{text: TextContent, box}` | `{color: RGBA}` | `{mg: {template, params, canvas}}`), `transform/opacity` (Animatable, evaluated per frame by the consumer with `keyframes.evaluate` at `contentTimeAt(clip, frame)`), `blendMode`, `effects`, `intrinsicBox`, `engine`. Keyframes stay unevaluated in the snapshot (S01:RND-001) so the composition, overlay and native planner share one evaluator (S01:KF-009, S03:KF-010).

---

## 6. `@jasper/session` — editor session, history, persistence

```ts
export class EditorSession {
  static open(opts: { store: ProjectStore; projectId: string; ctx: Omit<CommandContext, 'revision'|'selection'>;
                      engine?: EngineClient }): Promise<EditorSession>;
  readonly store: StoreApi<SessionState>;       // zustand vanilla; only EditorSession methods call setState
  getCommitted(): ProjectDocument;              // autosave, agents, clipboard read this (S01:SES-007)
  getDrawn(): ProjectDocument;                  // transient gesture doc if any, else committed
  apply(tx: TxInput): TransactionResult;        // TxInput = Transaction without protocol; fills defaults
  beginGesture(label: string): Gesture;         // Gesture.update(commands) / commit() / cancel()  (S01:SES-006)
  undo(): void; redo(): void; readonly history: HistoryView;
  select(domain, ids, mode?): void;             // selection per S01:SEL-001…009
  on(event: SessionEvent, cb): Unsubscribe;     // 'doc.changed' {revision,label,origin,created,changed,deleted,isUndo}
  close(): Promise<void>;                       // flush autosave, release lease
}
export type SessionState = { document; revision; transient: ProjectDocument | null; selection: Selection;
  views: Record<string /*seqId*/, SequenceViewState>; tabs; activeSequenceId; toggles: SessionToggles;
  media: Record<string /*mediaId*/, MediaRuntime>; dirty: boolean; lease: LeaseState; readOnly: boolean };
```

- **History** (S01 §17): entries `{label, origin, time, revisionBefore/After, before, after, selectionBefore/After, created/changed/deleted}`; capacity 200; linear; agent entries labeled `Agent: …`; coalescing rules S01:UND-006 (gesture = 1 entry; same-label nudges within 750 ms; text edit sessions). System transactions (UND-012) bypass history and are rebased (M2; M1 has none except `media.relink` probe refresh).
- **Gestures:** `update()` re-applies the command list to the **base** document each time (dry, no invariant check in prod, invariants in dev) and sets `transient`; agent transactions arriving mid-gesture are queued (S01:SES-006, S02:TL-056).
- **TransportStore** (`transport.ts`): `{frame, playing, rate, loop}` with `subscribe(cb)` (plain listeners, called from rAF or Player events), `seek(frame)`, `play()`, `pause()`, `setRate(r)`, `attachPlayer(controller)`. React components that must re-render on frame changes use `useTransportFrame(throttleMs)`; the playhead line and timecode write to the DOM directly (S02:TL-155, S05:PERF-004).
- **View state** per sequence: playhead, `pxPerFrame`, `scrollFrame`, `scrollY{Video,Audio}`, `dividerRatio`, track heights, targeting, source patching, display settings (S01:SES-004, S02:TL-012/013). Saved with `saveView` (debounced 1 s).
- **Media runtime** (S01:LIFE-050): availability, playback URL, proxy/thumbs/peaks status — fed by engine events (`derivative.ready`, `job.*`).
- **Persistence:** `ProjectStore` interface exactly S01:PER-001. M1 adapters: `EngineProjectStore` (HTTP, `If-Match` revisions, 409 handling) and `MemoryProjectStore` (tests). Autosave: 1.5 s after last commit, ≤ every 10 s, never mid-gesture, versions every 5 min (S01:PER-020). Lease via `POST /api/projects/:id/lease` + 10 s heartbeat; a second opener is read-only with "Take over" (S01:PER-040).
- **React bindings** (`@jasper/session/react`): `SessionProvider`, `useSession()`, `useSessionState(selector, equality?)`, `useDocument(selector)`, `useSelection()`, `useSequenceView(seqId)`, `useTransport()`.

---

## 7. `apps/web` — shell, panels, commands, design system

### 7.1 Shell (S05 §2–§7, §12–§14)

- `EditorShell` = Row A title/menu bar (28 px; in-app menubar from the menu model) + Row B header (36 px; Home, Import/Edit/Export mode tabs, workspace tabs, engine chip, jobs button, Quick Export, command palette, full screen) + the dock area + the agent approval cards (`shell/AgentApprovals.tsx`, §11).
- Dock host wraps **dockview-react**; dockview CSS variables are mapped to `--pr-*` in `packages/ui/src/theme/dockview.css`. Panels are rendered through `PanelDefinition.component`; Program and Timeline are keep-alive (S05:SH-006: dockview `renderer: 'always'`).
- Focus model: capture-phase `pointerdown`/`focusin` → `focusStore.focusedPanel`; 1 px `--pr-focus-ring` outline on the focused group (S05:FO-001/002).
- Workspaces: M1 ships `editing` (default, S05 §4.2 layout with Properties as the full-height right column), `assembly`, `effects`, `motion`, `essentials`; layout JSON persisted in `localStorage` via a versioned adapter (S05:SH-020/021). State stored by builds that still had the Agent panel loads: the retired `agent` workspace is dropped and layouts lose only their agent tab (`RETIRED_BUILTIN_WORKSPACES`, `sanitizeLayout`). Maximize with `` ` `` (S05:DK-040).
- Toast host, dialog host, command palette (`Ctrl+Shift+P`, prefixes `>`, `@`, `:` in M1), tooltips.
- Layout-mode switch (`desktop | compact | tablet | phone`): M1 implements `desktop` and `compact` (compact = fixed Essentials-like dock preset); `tablet`/`phone` render a "Touch layout coming soon" notice with the compact shell (M2 implements S05 §19).

### 7.2 Panel registry contract (WP-00 creates; owners fill their folders)

```ts
// apps/web/src/panels/types.ts
export type PanelKind = 'project' | 'source' | 'program' | 'timeline' | 'tools' | 'effectControls' | 'effects'
  | 'properties' | 'motionTemplates' | 'audioMeters' | 'history' | 'info' | 'markers' | 'jobs';
export interface PanelProps { instanceId: string; visible: boolean; params?: Record<string, unknown> }
export interface PanelDefinition { kind: PanelKind; title(ctx: PanelTitleContext): string; icon: IconId;
  instance: 'single' | 'multi'; keepAlive?: boolean; minSize: { w: number; h: number }; fixedAxis?: 'width' | 'height';
  keymapScope: string; menu?: MenuModel; touch: 'tab' | 'sheet' | 'hidden'; requires?: Capability[];
  agentDescription: string; component: React.ComponentType<PanelProps> }
// apps/web/src/panels/registry.ts imports each panels/<kind>/index.ts default export (a PanelDefinition).
```

Cross-panel services (S05:SH-005): `apps/web/src/state/panel-services.ts` — a registry keyed by instance id (`programPlayer`, `timelineViewport`, …) with explicit "not mounted" handling.

### 7.3 UI commands and keymap (S02 §19, S05 §18)

```ts
// apps/web/src/commands/types.ts
export interface UiCommand { id: string; label: string; description?: string; icon?: IconId;
  scope: 'global' | 'editing' | PanelKind; when?(ctx: CommandCtx): boolean; checked?(ctx: CommandCtx): boolean;
  run(ctx: CommandCtx, args?: unknown): void | Promise<void>; argsSchema?: ZodType; agentExposed?: boolean;
  capability?: Capability; repeat?: boolean; onKeyUp?(ctx: CommandCtx): void }
export interface CommandCtx { session: EditorSession | null; transport: TransportStore; focus: FocusInfo;
  services: PanelServices; engine: EngineClient; ui: { toast(r: ToastRequest): void; openDialog(kind, props): void } }
```

- `commands/registry.ts` (WP-00): `registerCommands`, `getCommand`, `runCommand`, `listCommands`, enabled/checked evaluation.
- `commands/keymap-defaults.ts` (WP-00): the **complete** default map from S02:TL-903 + R-PUI §16 + S05:KB-010, keyed by command id, bound on `KeyboardEvent.code`, with web fallbacks (S05:KB-013). Unregistered ids are simply inert.
- Domain modules, each a separate file with a single owner, imported by `commands/index.ts` (WP-00): `app.ts` + `edit.ts` (WP-2A: undo/redo, workspace, panels, palette, save), `timeline.ts` (WP-2B), `transport.ts` (WP-2C), `inspector.ts` (WP-2D), `project.ts` + `export.ts` (WP-2E), `mg.ts` (WP-2G), `help.ts` (wp-mcp: Help ▸ Connect an AI Agent…).
- One capture-phase `keydown`/`keyup` listener per window (WP-2A), scope resolution focused panel → `editing` → `global`, suspended in editable elements.

### 7.4 Design system (`@jasper/ui`, S05 §8–§11)

- `src/theme/tokens.css`: every `--pr-*` token of S05 §8.2/8.3 (Darkest + Dark + high contrast + touch density), label colors (16 × 3 presets as CSS variables `--pr-label-<name>` and tint), engine and agent tokens, z-index scale variables (S05:DT-030).
- `src/theme/tailwind.css`: `@theme inline` bridge (`bg-pr-panel`, `text-pr-muted`, …). Apps import `@import "tailwindcss"; @import "@jasper/ui/theme.css"; @source "../../../packages/ui/src";`.
- `src/theme/fonts.css`: Source Sans 3 (400/600/400 italic) from `@fontsource/source-sans-3`, `font-display: swap`; tabular numerals utility.
- `src/labels.ts`: `LABEL_DEFAULTS: Record<MediaKindKey, LabelColor>` (S05:DT-021) and presets JSON.
- `src/z.ts`: z-index constants. `src/icons/`: icon registry keyed by semantic id (lucide + our glyphs, S05:IC-001…005). `src/cursors/`: SVG cursors (S05:IC-010).
- Primitives (WP-00 ships tokens + a minimal `Button`/`IconButton`/`Panel`/`Timecode`; WP-2A ships the full set): IconButton, TextButton, TextField, SearchField, Select, Checkbox, Toggle, ColorSwatch, **ScrubbyNumber** (S05:CT-020…025, one undo step per scrub via callbacks `onScrubStart/onScrub/onScrubEnd`), Slider, Menu/ContextMenu (Radix), Tooltip, Dialog, Toast, Tabs, ScrollArea, TreeList (virtualized), Timecode display/entry.
- `theme-boot.js` (external script, CSP-safe) applies `data-pr-theme`/`data-pr-contrast`/`data-pr-density` before first paint (S05:DT-003).

### 7.5 Routing and bootstrap

`/` → Home (project list from the engine, New Project dialog with presets, Open). `/project/:projectId` → opens `EditorSession` via `EngineProjectStore`, then mounts `EditorShell`. `runtime/bootstrap.ts` detects `window.jasperDesktop` (preload) vs web, pings `/health`, fetches `/api/capabilities`, creates `EngineClient`, opens `/events`.

---

## 8. Preview and rendering: `@jasper/compositions`

```ts
export const SEQUENCE_COMPOSITION_ID = 'JasperSequence';
export type RenderDoc = RenderSnapshot;            // media URLs + font URLs already resolved for this consumer
export type RenderOptions = { isPreview: boolean; useProxies: boolean; transparentBackground: boolean;
  layerFilter?: string[] /* clipIds; M2 hybrid */; showOffline: boolean };
export const SequenceComposition: React.FC<{ doc: RenderDoc; options: RenderOptions }>;
export const calculateSequenceMetadata: CalculateMetadataFunction<{doc: RenderDoc; options: RenderOptions}>;
export const AssetComposition: React.FC<{ asset: MediaHandle; fps: number }>;   // Source monitor (M2 if not done in M1)
// packages/compositions/src/remotion-entry.ts : registerRoot(Root) with <Composition id="JasperSequence" …>
```

Rules (S03 §2–§5, S01 §22):
- The composition is a pure function of its props; it never reads editor stores (S03:ARC-003). Overlays (selection handles, safe margins, snap lines) are drawn **outside** the Player by the Program monitor (S03:ARC-004).
- Each clip is a `<Sequence from={start} durationInFrames={duration} premountFor={…}>`; per-layer order: source → effects (registry `preview.css`/SVG) → transform (`translate(P) rotate(θ) scale(sx,sy) translate(−A)`, `transform-origin: 0 0`, S03:DM-012) → opacity → blend (S03 §4.2 with crop as the first effect).
- Media layers use `@remotion/media` `<Video>`/`<Audio>` in the Player and `OffthreadVideo`/`@remotion/media` in renders (verify 4.0.499 behavior; choose per `getRemotionEnvironment()`), `trimBefore` from `sourceIn`, `playbackRate = speed`, volume callback from evaluated `volumeDb` (S03:KND-010/011).
- Motion-graphic layers call the template's TS SVG twin `renderSvg(params, localFrame, fps, canvas)` and inject the SVG (WP-2G). Text layers use DOM text with fonts loaded through `@remotion/fonts` `loadFont({family, url})` + `delayRender` (S03:KND-050).
- Offline media renders the "Media Offline" card (S03:RND-032).
- Player (WP-2C): `inputProps = useMemo({doc, options})` rebuilt only when the drawn document reference or media runtime changes; `acknowledgeRemotionLicense`, `controls={false}`, clicks/space disabled; the Player drives `TransportStore` while playing, `seekTo` when paused (S03:PGM-001…003, ARC-010).

Media URL resolution (client): `mediaUrl(asset, {useProxies})` → `/media/<mediaKey>` or `/media/<mediaKey>/proxy/720` when the proxy is ready and proxies are on or mandatory (S04:PX-004). Engine renders resolve to absolute signed URLs `http://127.0.0.1:<port>/media/<key>?sig=…&exp=…` (S04:MS-003).

---

## 9. `apps/engine`

### 9.1 Process and modules

```
apps/engine/src/
  cli.ts                 # parse --appdir/--port/--host; startEngine(); SIGTERM graceful (S04:ENG-004); parentPort "ready" message
  index.ts               # startEngine(opts) → {port, stop()}
  server.ts              # Fastify factory: auth hook, error handler (S04:ENG-022), x-jasper-api header, static SPA + fallback
  auth/                  # token/cookie/Host checks; signed media URL HMAC
  events/broadcaster.ts  # NDJSON fan-out, 15 s heartbeat, ring buffer for ?since=
  jobs/                  # queue: lanes, CPU slots, dedupe, cancel (process tree kill), journal, restart recovery (S04 §17)
  tools/ffmpeg.ts        # spawn wrapper with -progress pipe:1 (R-NVL §4.1), binary resolution + self-check (S04:ENG-011)
  media/                 # fingerprint (S01:AST-003), registry (media-index.json), probe → MediaProbe (S01 shape, S04 PB rules)
  derivatives/           # poster, sprite+index, peaks, keyframe index, proxy-720/540 (R-NVL §5.1–§5.5)
  uploads/               # resumable chunked upload (S04:IN-005)
  projects/              # ProjectStore over the filesystem (envelope, atomic writes, versions, view, leases)
  export/                # planner (native | remotion), native filtergraph builder, output verification
  remotion/              # bundle cache, selectComposition/renderMedia/renderStill, license key
  fonts/                 # curated catalog from @fontsource packages, /api/fonts, /fonts/*
  mg/                    # (WP-2G) jasper-mg resolution, capability, render jobs, cache, /api/motion-graphics/*
  agent/                 # (WP-2H) /api/agent/*, WS /agent relay, headless apply, approvals
  routes/                # one plugin file per area; routes/index.ts registers all (WP-00)
```

### 9.2 HTTP contract (M1) — zod schemas in `@jasper/api`

All JSON bodies validated with zod; errors `{code, message, detail?, retryable}`; responses carry `x-jasper-api: 1`.

| Method & path | Request → Response | Owner |
|---|---|---|
| `GET /health` | → `{ok, version, apiVersion}` (public) | 2F |
| `GET /api/capabilities` | → `EngineCapabilities` (S04:RT-002 subset: `engine.version, apiVersion, mode, media.{ffmpegVersion, encoders, filters, encoding?, ffmpegSource?}, render.{native, remotionLocal, remotionBinaries?, fframes}, fonts, limits`; `media.encoding` = D-13 encoder inventory and default export/proxy encoder; `media.ffmpegSource` = where the ffmpeg came from; `render.remotionBinaries` = FFmpeg of the Remotion path: source, LGPL or not, warning) | 2F (+2G fills `render.fframes`, wp-3l `media.encoding`, wp-lgpl the FFmpeg source fields) |
| `GET /api/licenses` | → `{components: [{id, name, version, license, bundled, sourceUrl, buildUrl?, notice?, texts[]}]}`: third-party licenses for the About dialog (D-13; the FFmpeg entry of the LGPL directory in use, or a "system build, not distributed" note) | wp-lgpl |
| `GET /events?since=<id>&projectId=` | NDJSON `EventEnvelope` stream | 2F |
| `GET /api/projects` / `POST /api/projects {name, preset}` | `ProjectSummary[]` / `{projectId}` | 2F |
| `GET /api/projects/:pid` | → `{envelope, view, revision}` | 2F |
| `PUT /api/projects/:pid` (`If-Match: <baseRevision>`) | envelope → `{revision}` or 409 `{code:'REVISION_CONFLICT', detail:{revision}}` | 2F |
| `PUT /api/projects/:pid/view`, `GET /api/projects/:pid/versions`, `DELETE /api/projects/:pid` | | 2F |
| `POST /api/projects/:pid/lease` / `POST …/lease/:leaseId/heartbeat` / `DELETE …/lease/:leaseId` | `{sessionId}` → `Lease` (409 when held) | 2F |
| `POST /api/media/register` | `{projectId, paths[], copyIntoProject?}` → `{items: RegisteredMedia[], errors: {path, code, message}[]}` (local mode only, S04:SC-002) | 2F |
| `POST /api/uploads` / `PUT /api/uploads/:uid?offset=` / `POST /api/uploads/:uid/complete` / `DELETE /api/uploads/:uid` | S04:IN-005, 8 MiB chunks → complete returns `RegisteredMedia` | 2F |
| `GET /api/media/:key` | → `{mediaKey, status, derivatives: Record<kind, DerivativeStatus>}` | 2F |
| `POST /api/media/:key/derivatives` | `{kinds: DerivativeKind[]}` → `{jobs: EngineJob[]}` | 2F |
| `GET /media/:key`, `/media/:key/proxy/:tier`, `/media/:key/poster.jpg`, `/media/:key/sprite.json`, `/media/:key/sprite/:n.jpg`, `/media/:key/peaks.json`, `/media/:key/peaks/:stream.bin` | Range, ETag, immutable caching for derivatives (S04:MS-002) | 2F |
| `GET /api/jobs?active=1&projectId=`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/retry` | `EngineJob` (S04 §17.1) | 2F |
| `POST /api/exports/plan` | `{envelope, sequenceId, settings: ExportSettings}` → `RenderPlan` (S04:RP-010) | 2F |
| `POST /api/exports` | `{envelope, sequenceId, settings, planId?}` → `EngineJob` | 2F |
| `GET /renders/:jobId/output` | download (Range) | 2F |
| `POST /api/stills` | `{envelope, sequenceId, frame, width?}` → job; result `{url}` (PNG) | 2F |
| `GET /api/fonts`, `GET /fonts/*` | curated catalog + files | 2F |
| `GET /api/motion-graphics/templates` | → catalog with JSON Schemas | 2G |
| `POST /api/motion-graphics/render` | `{spec: MgRenderSpec, quality: 'preview' \| 'master'}` → job; result `{key, url}` | 2G |
| `GET /mg/:key/:file` | master/preview files | 2G |
| `GET /api/agent/schema` | → commands + queries JSON Schemas, registries, presets, error codes (S01:AGT-002) | 2H |
| `POST /api/agent/query` | `{projectId, query, args}` → result | 2H |
| `POST /api/agent/tx` | `{projectId, transaction}` → `TransactionResult` (relayed to lease holder, else headless) | 2H |
| `WS /agent` | session registration + request/response relay (§11) | 2H |
| `POST /api/agent/open-project` | `{projectId}` → `{projectId, path, editors, live}`; publishes `editor.openProject` so editor windows navigate to the project | wp-mcp |
| `GET /api/agent/mcp-info` | → `{stdioEntry, httpUrl, tokenRequired}` for Help ▸ Connect an AI Agent… (never the token) | wp-mcp |
| `POST`/`GET`/`DELETE /mcp` | MCP Streamable HTTP: the `jasper-mcp` tools, one server per MCP session (max 32, 30 min idle); same auth as every other route | wp-mcp |

`RegisteredMedia = {mediaKey, fingerprint, originalName, sizeBytes, container, kind, probe: MediaProbe, locators: MediaLocator[], browserPlayable: 'yes'|'no'|'unknown'}` — the client builds a `MediaAsset` (new `med_` id, `engine-store` locator with `key = mediaKey`) and commits `media.register` (+ `clip.place` for timeline drops) in one "Import N files" transaction (S01:LIFE-010).

Events (`{id, type, createdAt, projectId?, payload}`): `engine.heartbeat`, `capabilities.changed`, `job.created`, `job.updated` (≤ 4/s/job), `job.finished`, `media.updated`, `derivative.ready {mediaKey, kind, url}`, `export.finished`, `doc.changed` (relayed from the session for agent subscribers), `agent.approval.requested/resolved`, `editor.openProject {projectId}` (an agent asks editor windows to show a project).

### 9.3 Jobs (S04 §17)

`EngineJob` exactly S04 §17.1. M1 implements: lanes (`interactive`, `user`, `background`), CPU slots = cores (probe 1, peaks 1, sprite 1, poster 1, proxy 4, export all-remaining ≥ half, mg-render 4), dedupe keys (`proxy:720:<fp>`), cancel (SIGTERM then SIGKILL after 3 s, delete partials), retry, journal + `interrupted` on restart, events. Derivative jobs complete immediately when the artifact exists (content-addressed, S04:CA-001).

### 9.4 Derivatives (M1)

| Kind | Recipe | Output |
|---|---|---|
| `keyframes` | `ffprobe -skip_frame nokey … frame=pts_time` | JSON seconds list |
| `poster` | `-ss <10%> -frames:v 1 -vf scale=320:-2` | JPEG |
| `sprite` | adaptive interval (S04:TH-002), 160 px tiles, ≤100 per sheet | `sprite.json` + `sprite/<n>.jpg` |
| `peaks` | `ffmpeg -vn -ac <ch> -ar 8000 -f f32le pipe:1` → max-abs 100/s per channel in a worker thread | `peaks.json` header + `peaks/<stream>.bin` |
| `proxy-720` | H.264 GOP 15, `+faststart`, AAC 128k, rotation baked (S04:PX-001) | MP4; mandatory when `browserPlayable = no` |

After `media/register` / upload completion, the engine queues `keyframes`, `poster`, `peaks` (if audio), `sprite`, and `proxy-720` (if required) (S04:IN-011).

### 9.5 Export planner and paths (M1)

Input: inline envelope + sequenceId + `ExportSettings` (S04 §10.2 subset: `range` entire | in-out, container `mp4`, video `h264` crf, audio `aac` 48 kHz stereo, `engine: 'auto'|'native'|'remotion'`). The planner builds the `RenderSnapshot` with engine-local file paths, classifies layers and returns `RenderPlan {path, segments:[one], audio:{mode}, blockers, warnings, estimate}`.

- **Native eligible** when every enabled visual clip on output tracks is `video`, `still`, `solid` or `motion-graphic` (the latter only if `render.fframes === 'ready'`), transform/opacity are static (no keyframes), blend `normal`, no effects except `jasper.crop`/flips, constant forward speed, no transitions. Everything else → `remotion`, with blockers recorded per clip (S04:RP-008).
- **Native builder** (S03:ENG-030, S04:RN-021/022): one input per clip with input seeking; per layer `setpts` (speed) → `fps` → `crop` → `format=rgba` → `scale` → `rotate` (transparent, grown bounds) → alpha multiply → `overlay` at the offset derived from the layer matrix; bottom→top over a `color` background; audio `atrim/asetpts/atempo chain/aresample=48000/volume/adelay` + `amix normalize=0` + pad/trim; output libx264 yuv420p, AAC, `+faststart`, bt709 tags; frame-count verification (`FRAME_COUNT_MISMATCH`). Motion-graphic layers use the cached fframes **master** (`prores_ks` 4444) as an alpha input; the master is rendered first if missing (job stage "Rendering motion graphics").
- **Remotion path:** `@remotion/bundler` `bundle()` of `@jasper/compositions/remotion-entry` cached under `<appdir>/remotion/bundle` keyed by package versions + source hash (dev) or a prebuilt bundle (packaged); `selectComposition` + `renderMedia({codec:'h264', inputProps:{doc, options:{isPreview:false,…}}, concurrency, cancelSignal, onProgress})`. Audio is rendered by Remotion in M1 (S04:RP-006 continuous native mix is M2).
- Outputs to `<appdir>/renders/<jobId>/output.mp4`; `export.finished` event; download via `/renders/:jobId/output`.

### 9.6 Security (S04 §22)

Argument arrays only (no shell), inputs referenced by index in filtergraphs, no user strings in filter text, ids validated as engine-issued, path registration only in local/dev mode with canonicalized paths, body limits (JSON 20 MB for inline envelopes), upload sessions expire after 24 h.

---

## 10. The three engines, end to end

### 10.1 Native media path

Import → fingerprint (`q1:` sha256 of size + first/last 4 MiB) → dedupe → ffprobe → `RegisteredMedia` → client commits `media.register` → engine derivative jobs → `derivative.ready` events update `MediaRuntime` → timeline draws sprites/peaks, Program plays original or proxy → native export composites originals.

### 10.2 fframes motion graphics (Design C, S01:KND-009, S03:KND-060…062, S04 §15, R-FF §7)

```
native/mg/
  Cargo.toml                  # [workspace]; profile.release lto="thin"; profile.dev opt-level=1, deps opt-level=3, debug=0
  crates/jasper-mg-core/      # MgSpec (serde), Rational fps, canvas, param helpers, keyframe→animate_runtime adapter
  crates/jasper-mg-templates/ # templates: lower-third@1, title-card@1 (M1); enum AnyTemplate implementing fframes::Video
  crates/jasper-mg-cli/       # bin "jasper-mg"
```

CLI contract (all JSON on stdout, NDJSON progress on stderr):

```
jasper-mg --version                                   → {"name":"jasper-mg","version":"0.1.0","fframes":"1.0.3"}
jasper-mg schema                                      → {"templates":[{id, version, name, category, paramsSchema (JSON Schema),
                                                           defaults, introFrames?, outroFrames?, canvases:["1920x1080","1080x1920","1080x1080"]}]}
jasper-mg render --spec <file|-> --raw-rgba           → raw straight-alpha RGBA frames (width*height*4 bytes each, in order) on stdout
jasper-mg frame --spec <file|-> --frame N --out f.png → one straight-alpha PNG
MgRenderSpec = {template:{id, version}, params, width, height, fps:{num, den}, durationFrames, sourceInFrames?: 0}
stderr: {"event":"start","frames":N} {"event":"progress","done":k,"total":N} {"event":"done"} | {"event":"error","message":…}
exit codes: 0 ok, 2 invalid spec (message on stderr), 1 other
```

- fframes `=1.0.3` **without** the `h264` feature (x264 ABI mismatch on Ubuntu 24.04, GPL), frames produced through `fframes::Previewer` (straight RGBA, R-FF §5 alpha fix), multi-threaded with ordered output. Canvas sizes via const generics (1920×1080, 1080×1920, 1080×1080) plus scale for other sizes; fps via `override_fps` (verify API).
- Engine (`apps/engine/src/mg`): resolves the binary (`JASPER_MG` → `native/mg/target/release/jasper-mg` in dev → packaged `resources/bin/jasper-mg`); runs `--version` + `schema` at startup to set `render.fframes = 'ready' | 'unavailable'` (with reason); render job = `jasper-mg render --raw-rgba | ffmpeg -f rawvideo -pix_fmt rgba -s WxH -r fps -i - -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le master.mov` (+ optional `libvpx-vp9 yuva420p preview.webm`), verifies frame count; cache key `sha256(template id, version, canonical params, canvas, fps, durationFrames, sourceIn, rendererVersion)` (S01:KND-009, S04:MG-011).
- `@jasper/mg-templates`: TS catalog mirroring the Rust templates (id, version, zod params schema equal to the Rust serde struct, defaults, intro/outro) and `renderSvg(params, frame, fps, canvas): string` twins used by the Player and the Remotion path. Parity is approximate in M1; the parity harness and the WASM bridge (R-FF Design B) are M2.
- **Fallback:** no cargo or no binary → `pnpm mg:build` prints a skip notice and exits 0; capability `fframes: 'unavailable'`; preview is unaffected (twin); exports containing motion graphics are planned as `remotion` with blocker "fframes unavailable".

### 10.3 Remotion

One composition for Player preview, engine renders and stills (§8). Pinned `4.0.499`. `JASPER_REMOTION_LICENSE_KEY` passed when set (S04:LC-001). Headless browser: Remotion `ensureBrowser()` on first render (capability `remotionLocal: 'needs-browser-download'` until ready) or `JASPER_BROWSER_EXECUTABLE`.

### 10.4 Timeline engine attribution

`registry/kinds.ts` + `render/plan.ts` give each clip an engine badge (`R` for text/composition/captions, `F` for motion-graphic, none for native media) and per-range affinity; the render bar (S02:TL-214) is fed by a client-side function in M1 (yellow = live-previewable, red = motion graphic without ready master / heavy), green arrives with render caching in M2.

---

## 11. Agent API = MCP server (`jasper-mcp`)

**Decision (D-18, wp-mcp):** JasperEditor has no in-app agent. External coding agents (Claude Code, Codex CLI, Cursor, anything that speaks MCP) drive it through the MCP server in `apps/mcp` (`@jasper/mcp`, bin `jasper-mcp`, built on the MIT-licensed `@modelcontextprotocol/sdk`). The Agent panel, the Agent workspace and menu, the header button, the Agent Tool, the palette's "Ask the agent" row and the `Shift+0` / `Ctrl+.` shortcuts were removed. S05 §17 and the other Agent-panel requirements in the specs are superseded by this section.

```
MCP client ──stdio──▶ jasper-mcp ──HTTP (token)──▶ engine ──WS /agent──▶ open editor (live, "Agent: …" undo entry)
MCP client ──Streamable HTTP /mcp──▶ engine (same tools)      └─ no editor: headless apply + save
```

### 11.1 Layers underneath (unchanged from Stage 1)

- **Document surface:** transactions (`jasper.tx/1`, S01:CMD-005) + queries (`doc.get`, `doc.revision`, `sequence.summary`, `sequence.clipsInRange`, `sequence.at`, `media.list`, `selection.get`, `playhead.get`, `playhead.set`, `history.list`, `validate`; `frame.capture` via `POST /api/stills`) + events (`doc.changed`, `selection.changed`, `playhead.changed` ≤ 10 Hz, `job.*`). Schemas from `@jasper/project/agent/schema-export` (`GET /api/agent/schema`).
- **In-page bridge** (`apps/web/src/agent-bridge`, kept): `window.jasper = {schema(), query(name, args), transact(tx), on(event, cb)}` in dev and Electron builds; the session applies with `origin: {agent}`; `expectedRevision` optimistic concurrency with fast-forward (S01:AGT-010).
- **Engine relay:** when an editor opens a project it connects `WS /agent` and sends `{type:'hello', projectId, sessionId, leaseId}`. `POST /api/agent/tx|query` for that project is forwarded as `{type:'request', id, kind, payload}`; the session replies `{type:'response', id, result}` (timeout 30 s → `E_NO_SESSION` fallback to headless only if the lease expired). The session also forwards `doc.changed` to the engine for `/events` subscribers.
- **Headless:** no lease holder → the engine loads the project, applies the transaction with `@jasper/project` (text layout marked `layoutPending`), saves with a new revision (S01:AGT-020).
- **Guard rails (S01:AGT-011):** transactions containing `item.delete`, `sequence.delete`, `track.remove`, `media.removeUnused` or any `force: true` need the user's approval. The editor shell shows a sticky **approval card** at the top of the window (`apps/web/src/shell/AgentApprovals.tsx`: label, "<agent> wants to run N commands: <summary>", the reasons, a countdown, Show commands, **Approve** / **Deny**); 60 s without an answer → `E_APPROVAL_TIMEOUT`; headless mode rejects with `E_APPROVAL_DENIED`. Limits: 5 000 commands, 20 MB.
- **What the user sees:** each agent transaction is one `Agent: <label>` History entry (`history.undo` for agents only if the top entry is theirs, S01:UND-008), the changed clips flash (S01:AGT-012), and the shell shows a toast `Agent: <label>` with an Undo action for every change an external agent applied.

### 11.2 `jasper-mcp` (stdio) and `/mcp` (Streamable HTTP)

- **One definition, two transports.** `createJasperMcpServer({link})` (`apps/mcp/src/server.ts`) registers tools, resources and prompts. `apps/mcp/src/cli.ts` serves it over stdio; `apps/engine/src/routes/mcp.ts` serves the same definitions at `POST/GET/DELETE /mcp` (one server instance per MCP session, max 32 sessions, 30 min idle timeout), authenticated like every other engine route (loopback Host check, Bearer token in token mode).
- **Bundle:** `pnpm mcp:build` (esbuild) → `apps/mcp/dist/jasper-mcp.mjs`, one executable ESM file with everything inlined; runs with plain `node`, and with the packaged app binary under `ELECTRON_RUN_AS_NODE=1`. The desktop package ships it as `resources/mcp/jasper-mcp.mjs`.
- **Finding the engine** (`apps/mcp/src/discovery.ts`), in order: `--engine-url` / `--token`, then `JASPER_ENGINE_URL` / `JASPER_ENGINE_TOKEN`; then `<appdir>/engine/runtime.json` for `--appdir`, `JASPER_APPDIR`, the platform appdir and the desktop app's appdir (`<Electron userData>/jasper`); then `http://127.0.0.1:47900`. A running engine writes `runtime.json` (mode 0600: url, port, pid, token, version) on listen and removes it on stop; stale files (dead pid, no `/health`) are skipped. Discovery is lazy (first tool call) and repeats after a network failure, so the server survives editor restarts. `--start-engine` forks a headless engine (random port, per-launch token) when none is running and stops it on exit.
- **Rules of the process:** stdout carries JSON-RPC only (logs go to stderr; `console.log/info/debug` are redirected). Every engine request has a deadline (180 s, `--request-timeout`) → `ENGINE_TIMEOUT`. A write whose connection dropped after it was sent is never re-sent automatically → `ENGINE_CONNECTION_LOST` ("re-read the project first"); reads and never-sent writes are retried once after re-discovery. `wait_for_job` is bounded (default 120 s, max 900 s) and returns `timedOut: true`. The engine token never appears in tool results, resources or logs.
- **Tools (32):** `engine_status`; projects `list_projects`, `create_project`, `get_project`, `open_project_in_editor`; media `import_media`, `list_media`, `get_media_info`; editing `describe_commands`, `apply_commands` (transaction with `$refs`, `dryRun`, `expectedRevision`), `undo`, `redo`; timeline helpers over `apply_commands`: `add_clip`, `move_clip`, `trim_clip`, `split_at`, `delete_clips`, `add_text`, `add_marker`, `add_motion_graphic`, `add_transition`; inspection `get_timeline` (text table), `render_frame` (PNG image content), `get_playhead`, `set_playhead`; motion graphics `list_motion_templates`, `render_motion_graphic_preview`; export `list_export_presets`, `start_export`, `get_job`, `cancel_job`, `wait_for_job`. Inputs are zod schemas aligned with the `@jasper/project` command schemas (time arguments accept frames, `{seconds}` or timecode); results are concise JSON text; failures are MCP tool errors `{error: {code, message, hint}}` with the S01 `E_*` codes and a next step.
- **Resources and prompts:** `jasper://projects/{projectId}/document`, `jasper://projects/{projectId}/timeline`, `jasper://guide`; prompt `edit-video`. The server `instructions` carry the editing guide.
- **Opening the editor:** `open_project_in_editor` → `POST /api/agent/open-project` → the engine publishes `editor.openProject`; every editor window navigates to the project (`apps/web/src/shell/AgentOpenProject.tsx`) and the desktop window comes to the front.
- **Connecting a client:** Help ▸ **Connect an AI Agent…** (`apps/web/src/shell/connect-agent.tsx`) shows copyable configuration for Claude Code, Codex CLI and Cursor with real paths: from the desktop preload (`jasperDesktop.mcpInfo()`), else from the engine (`GET /api/agent/mcp-info`). The README has the same snippets.

### 11.3 Later

Agent proposals rendered as timeline ghosts (dry-run results), UI command tools generated from the command registry (`agentExposed`), vision self-checks beyond `render_frame`, agent-authored fframes graphics in a sandboxed compile service (R-FF Design A), macro tools (remove silences, scene cuts) using engine analyses. All of them are MCP tools; none needs an in-app chat.

---

## 12. Desktop (Electron) and PWA

**Electron (`apps/desktop`, S05 §21, R-OMS §8.5):**
- `src/main.ts` (bundled with esbuild as **ESM** `dist-electron/main.mjs`), `src/preload.cts` (CJS `dist-electron/preload.cjs`, `sandbox: true`, exposes only `window.jasperDesktop = {runtime:'desktop', pickMedia(), revealInFolder(path), windowControls, focusWindow(), mcpInfo(), onMenuCommand(cb)}`; `mcpInfo()` returns where the bundled `jasper-mcp` lives and how to launch it, for Help ▸ Connect an AI Agent…).
- Dev (`pnpm dev:desktop`): expects the dev engine on 47900 and Vite on 5173; `loadURL(JASPER_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173')`. Headless machines: `xvfb-run -a pnpm dev:desktop`.
- Packaged mode (M1: `pnpm --filter @jasper/desktop start:packaged-like` smoke, no installer signing): fork `apps/engine/dist/engine.mjs` via `utilityProcess.fork` with `--port 0`, env `JASPER_LOCAL_TOKEN`, `JASPER_WEB_DIR=apps/web/dist`, wait for `{type:'ready', port}`, set `jasper_session` cookie, `loadURL('http://127.0.0.1:<port>/')`. Frameless window (`titleBarStyle:'hidden'`, overlay `#1d1d1d`), `setWindowOpenHandler` deny + `shell.openExternal`, `will-navigate` guard, background `#1d1d1d`, `show` on ready-to-show.
- electron-builder config per R-OMS §8.5 (extraResources for web build, engine bundle, the `jasper-mcp` bundle as `resources/mcp/jasper-mcp.mjs`, native bin, `ffmpeg-lgpl`). Packaging runs through `apps/desktop/scripts/package.mjs` (`pnpm --filter @jasper/desktop dist:dir` / `dist`): it fetches the LGPL FFmpeg directory for the target (D-13), stages `apps/engine/dist-deploy` (engine bundle, prebuilt Remotion bundle, fonts, the runtime closure of `@remotion/renderer` without optional dependencies, so no `@remotion/compositor-*`), runs the license guard and then electron-builder, whose `afterPack` hook (`scripts/after-pack.cjs`) runs the guard again over the packed app. Packaged main passes `JASPER_RESOURCES_DIR=process.resourcesPath`; the engine finds `<resources>/ffmpeg-lgpl`. Unpacked builds (`--dir`) for Linux and (cross-packed) Windows were produced and checked (`pnpm e2e:packaged`); signed installers are M3.

**PWA (S05 §20, R-OMS §3/§8.3):** `public/manifest.webmanifest` (standalone, `display_override` WCO, `#000000`/`#1d1d1d`, 192/512 icons + separate padded maskable icons, `file_handlers` for `.jasper`), hand-written `public/sw.js` (versioned caches `jasper-shell-vN`, `jasper-assets-vN`; network-first navigations with `/index.html` fallback; cache-first `/assets/*`; **bypass** `/api`, `/events`, `/agent`, `/mcp`, `/ws`, `/health`, `/media`, `/mg`, `/renders`, `blob:`, cross-origin, and any request with a `Range` header (engine-served `/fonts/*` may be cache-first); `Response.error()` on misses), registration only when `import.meta.env.PROD && !window.jasperDesktop`. The route-classification function lives in `apps/web/src/pwa/sw-routes.ts` (unit-tested) and is inlined into `sw.js` at build by a tiny Vite plugin or duplicated with a test asserting equality.

---

## 13. Performance strategy

| Concern | Strategy |
|---|---|
| Document updates | Immer structural sharing; per-track sorted clip arrays and interval lookup memoized by track-clip identity (`WeakMap`); indexes rebuilt only for tracks in `changed` (S01:SES-010/011). |
| Gestures | Pointer moves coalesced to one `Gesture.update` per animation frame; updates re-apply to the base doc; only clips in `changed` re-render (S02:TL-052/053/156). Invariants in dev only during gestures. |
| Playhead | `TransportStore` + direct DOM writes (transform/text) from rAF; no React state per frame (S02:TL-155, S05:PERF-004). |
| Timeline drawing | Viewport model with virtualization (clips in visible frame window ± 50 %, visible tracks ± 1), DOM clip bodies with `translateX`, canvas tiles ≤ 512 px for ruler/thumbnails/waveforms (S02:TL-150…160). Peaks level reduction in a Web Worker. |
| Preview | `inputProps` memoized; static clips resolve to identical objects so memoized layers skip re-render (S03:ARC-011, NFR-003); premount media 2 s; proxies at reduced playback resolution. |
| Engine | All ffmpeg/ffprobe/jasper-mg/Chrome work in child processes; peak reduction in `worker_threads`; CPU-slot scheduler; background lane paused during exports (S04:JB-012/013). |
| Startup | Code-split panels (dynamic import per panel component), fonts `swap`, shell renders skeleton panels within 300 ms (S05:PERF-001). |

Budgets to verify in M2 CI (S01:SES-011, S02:TL-160, S03:NFR-002): single command + reindex on 1 000 clips < 4 ms; 50-clip gesture update < 8 ms; `resolveSceneAt` 50 layers < 1 ms.

---

## 14. Tooling, scripts, verification

Root `package.json` scripts (WP-00 creates; later packages must not rename them):

| Script | Does |
|---|---|
| `pnpm dev` | `concurrently -k -n engine,web "pnpm dev:engine" "pnpm dev:web"` |
| `pnpm dev:engine` | `cross-env JASPER_APPDIR=./.stage JASPER_DEV=1 tsx watch apps/engine/src/cli.ts --port 47900` |
| `pnpm dev:web` | `pnpm --filter @jasper/web dev` (Vite 5173 with proxy) |
| `pnpm dev:desktop` | `pnpm --filter @jasper/desktop dev` (build main/preload, launch Electron against 5173) |
| `pnpm typecheck` | `pnpm -r --if-present typecheck` |
| `pnpm test` | `vitest run` (root projects) |
| `pnpm lint` | `biome check . && node scripts/check-tokens.mjs` |
| `pnpm format` | `biome format --write .` |
| `pnpm build` | `pnpm -r --if-present build` (web: `vite build`; engine: esbuild ESM bundle `dist/engine.mjs` + remotion bundle; desktop: main/preload) |
| `pnpm mg:build` | `node scripts/mg-build.mjs` (cargo release build of `native/mg`, skip with exit 0 if cargo missing) |
| `pnpm fixtures` | `node scripts/make-fixtures.mjs` (ffmpeg `testsrc2`/`sine` clips: `clip-a.mp4` 10 s 1080p30 H.264+AAC stereo, `clip-b.mp4` 6 s 720p25, `tone.wav`, `still.png`, `vfr-phone.mp4` rotated 90°) |
| `pnpm e2e` | `playwright test` (wave 3) |
| `pnpm verify` | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` |

`pnpm.onlyBuiltDependencies`: `["electron", "esbuild", "@biomejs/biome"]` (+ anything else that needs install scripts; Remotion compositor binaries ship as optional deps without scripts).

Testing layers: unit/property tests in `packages/project` (all command handlers, invariants under 10 000 random transactions, timecode round-trips for 24 h at 29.97/59.94, keyframe math tables); engine route tests with `fastify.inject` + real ffmpeg on generated fixtures; component tests with happy-dom for panels with logic (scrubby number, keymap resolution, timeline math); Playwright smoke (wave 3).

Git workflow for work packages: each package works in its own worktree and branch created from the tip of `dev`:

```
git -C /var/lib/orquester/workspaces/jaspersito/JasperEditor worktree add ../JasperEditor-wt/<wp-id> -b wp/<wp-id> dev
```

Commit early and often with Conventional Commits (`feat(project): …`, `fix(engine): …`, `test(timeline): …`, `chore(repo): …`, `docs(arch): …`). Do not merge into `main`, do not push, do not rewrite other branches; the orchestrator merges `wp/*` branches into `main` in dependency order (there is no `dev` branch since 2026-10-01: all work lands on `main`). If `pnpm-lock.yaml` conflicts, resolve by re-running `pnpm install` on the merged tree (never hand-edit the lockfile).

---

## 15. M1 definition of done

1. `pnpm install && pnpm verify` passes on a clean clone (Node 20.20, pnpm 10.34, Linux x64, no GPU).
2. `pnpm fixtures && pnpm dev` → `http://127.0.0.1:5173`: Home lists projects; "New Project" (1080p 29.97 preset) opens the **Editing** workspace: title/menu bar, header with mode/workspace tabs and engine chip, docked Project, Program, Tools, Timeline, Audio Meters (placeholder), Properties, Effect Controls, History, Jobs; Darkest tokens, Source Sans 3, focus outline, `` ` `` maximize.
3. Import `fixtures/media/clip-a.mp4` (upload in web; native file dialog in Electron) → Project panel row/tile with poster; Jobs panel shows probe/poster/peaks/sprite jobs completing.
4. Drag the item to the timeline → linked V1/A1 clips with filmstrip and waveform; second clip placed with Ctrl (insert) ripples sync-locked tracks.
5. Space / J / K / L / ← / → drive the Program monitor (Remotion Player); timecode entry works; playhead moves without React re-renders per frame.
6. Move (overwrite), Ctrl-move (insert), edge trim (regular), Ctrl-edge / B tool trim (ripple), razor tool `C` and `Ctrl+K`, Delete / Shift+Delete, snapping `S` — each exactly one History entry; `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo with selection restore.
7. Add a text clip (Graphics menu / `T` tool click in Program) and a `lower-third@1` motion graphic (Motion Templates panel); edit their fields in Properties (scrub = one undo step); Program shows them; select + move/scale/rotate the text on the Program overlay.
8. Export (Export mode or `Ctrl+M`): media-only sequence with Auto → plan `native`, output mp4 with exact frame count; with the text clip → plan `remotion` (blocker explains why); progress in Jobs; download works.
9. `pnpm mg:build` builds `jasper-mg`; `jasper-mg render --spec native/mg/fixtures/lower-third.json --raw-rgba | ffmpeg …` yields 150 straight-alpha frames; engine reports `fframes: ready`; a sequence with footage + motion graphic exports via `native` using the ProRes 4444 master. With the binary removed, capability becomes `unavailable` and the same export plans `remotion`.
10. With the project open, an MCP client connected to `jasper-mcp` calls `apply_commands` with `marker.add` (equivalently `curl -X POST http://127.0.0.1:47900/api/agent/tx -d '{"projectId":…,"transaction":{…"marker.add"…}}'`): the marker appears live and History shows `Agent: …`; with the editor closed the same call applies headlessly and the change appears on reopen; a transaction with `track.remove` requires approval on the shell's approval card.
11. `xvfb-run -a pnpm dev:desktop` launches Electron showing the editor; the packaged-like start (engine forked on a random port with token cookie, web build served by the engine) loads Home.
12. `pnpm --filter @jasper/web build` emits `manifest.webmanifest`, `sw.js`, icons; the SW route classifier unit tests pass (media/API/Range bypass).
13. `pnpm e2e` smoke passes headless (create project, upload fixture, place, razor, undo, native export verified with ffprobe).

---

## 16. Work breakdown and ownership

### 16.1 Waves

| Wave | Packages | Notes |
|---|---|---|
| 1 | **WP-00 Foundation** | Sequential; everything depends on it. Defines every contract listed above, working skeletons, `@jasper/project` core with tests, `@jasper/ui` tokens. |
| 2 | **WP-2A** Shell, design system primitives · **WP-2B** Timeline · **WP-2C** Monitors + compositions · **WP-2D** Inspector, keyframes, effects, History · **WP-2E** Project/media, import, persistence, Home, Jobs & Export UI · **WP-2F** Engine core · **WP-2G** fframes / motion graphics · **WP-2H** Agent API + Electron + PWA | Parallel worktrees; disjoint `owns_paths`. |
| 3 | **WP-3I** Integration, E2E, M1 acceptance | Merges, wiring fixes, Playwright smoke, docs. |

### 16.2 Ownership map (abridged; the structured work-package list is authoritative)

| Path | Owner |
|---|---|
| root configs, `scripts/check-tokens.mjs`, `scripts/make-fixtures.mjs`, `.stage/`, `packages/config/**`, `packages/api/**`, `packages/engine-client/**`, `packages/session/src/**` (except `persistence/**`), `packages/project/**` (except files listed for 2B/2D), `apps/web/src/{main.tsx,App.tsx,state/**,commands/{types,registry,index,keymap-defaults,context}.ts,panels/{types,registry}.ts}`, `apps/engine/src/{cli,index,server}.ts`, `apps/engine/src/routes/index.ts` | WP-00 |
| `packages/ui/**` (after WP-00 tokens), `apps/web/src/shell/**`, `apps/web/src/runtime/**`, `apps/web/src/commands/{app,edit}.ts`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/public/{theme-boot.js,fonts/**}`, `apps/web/src/panels/{info,markers,audioMeters}` placeholder panels | WP-2A |
| `apps/web/src/panels/{timeline,tools}/**`, `apps/web/src/commands/timeline.ts`, `packages/project/src/commands/handlers/clip-edit.ts` | WP-2B |
| `packages/compositions/**` (except `src/layers/MotionGraphicLayer.tsx`), `apps/web/src/panels/{program,source}/**`, `apps/web/src/commands/transport.ts` | WP-2C |
| `apps/web/src/panels/{properties,effectControls,effects,history}/**`, `apps/web/src/commands/inspector.ts`, `packages/project/src/commands/handlers/{keyframe,effect}.ts`, `packages/project/src/registry/{effects,properties}.ts` | WP-2D |
| `apps/web/src/panels/{project,jobs}/**`, `apps/web/src/home/**`, `apps/web/src/import/**`, `apps/web/src/export/**`, `apps/web/src/commands/{project,export}.ts`, `packages/session/src/persistence/**` | WP-2E |
| `apps/engine/src/**` except `mg/**`, `agent/**`, `routes/{mg,agent}.ts` and the WP-00 entry files | WP-2F |
| `native/mg/**`, `packages/mg-templates/**`, `apps/engine/src/mg/**`, `apps/engine/src/routes/mg.ts`, `packages/compositions/src/layers/MotionGraphicLayer.tsx`, `apps/web/src/panels/motionTemplates/**`, `apps/web/src/commands/mg.ts`, `scripts/mg-build.mjs` | WP-2G |
| `apps/engine/src/agent/**`, `apps/engine/src/routes/agent.ts`, `apps/web/src/agent-bridge/**`, `apps/desktop/**`, `apps/web/public/{manifest.webmanifest,sw.js,icons/**}`, `apps/web/src/pwa/**` (the Agent panel and `commands/agent.ts` it also owned were removed by wp-mcp) | WP-2H |
| `apps/mcp/**`, `apps/engine/src/routes/mcp.ts`, `apps/web/src/shell/{AgentApprovals,AgentOpenProject,connect-agent}.tsx`, `apps/web/src/commands/help.ts` | wp-mcp |
| `e2e/**`, `playwright.config.ts`, cross-package fixes | WP-3I |

### 16.3 Shared-file protocol

- Contracts (`packages/project/src/schema/**`, `commands/schemas/**`, `packages/api/src/**`, `packages/session/src/*.ts` public API, `apps/web/src/panels/types.ts`, `apps/web/src/commands/types.ts`) are **frozen after wave 1** except for **additive** changes (new optional fields, new schemas, new exports). Any such change must be listed in the commit body under `Contract-Change:` and must not break other packages' compilation.
- Registries are data files with one-line registrations; if a wave-2 package must register something in a file it does not own, it adds exactly one line (import + entry) and mentions it in the commit body.
- New dependencies: add them to the owning package's `package.json` only; run `pnpm install`; commit the lockfile. Merge conflicts in `pnpm-lock.yaml` are resolved by the integrator re-running `pnpm install`.

---

## 17. Roadmap after M1 (non-binding)

Colour grading, clip processing, motion-graphics clips, tracking and the transitions UI were pulled into M2 (§19).

- **M2:** browser-only profile (IndexedDB/OPFS store, mediabunny probe/peaks/thumbnails, web renderer), desktop `.jasper` files + crash journal, clipboard (S01 §20), transitions & fades, hybrid export (graphics alpha intermediates), smart-render copy path, source monitor + three-point editing, markers panel, audio meters live, touch shells, fframes WASM preview + parity harness, whisper.cpp transcription + captions, agent proposals/ghosts as MCP tools (the MCP server itself shipped with wp-mcp; there is no in-app LLM chat), remote engine password auth + deploy scripts.
- **M3:** masks, nesting, adjustment layers, OTIO interchange, agent-authored fframes graphics, installers/auto-update/signing, ffmpeg distribution decision.

## 18. Open questions

1. ~~FFmpeg distribution license~~ — decided: LGPL sidecar (D-13), also for the Remotion path (wp-lgpl). Still open before distribution: H.264/AAC patent licensing of a self-built OpenH264 (Cisco's coverage is for its own binary), and the LGPL 3 terms of the BtbN build on sealed/signed installers (`docs/wp-notes/wp-lgpl.md`).
2. `@remotion/media` `<Video>` behavior in `renderMedia` and VP9-alpha decode in the Player for 4.0.499 (affects D-12 proxy use); WP-2C records findings in `docs/research/remotion-4.0.499-notes.md`.
3. Remotion Player playback-rate bounds (S02 open question 1) — WP-2C measures and records.
4. Whether to keep the TS SVG twins after the WASM bridge lands (likely drop them, keep for tests).
5. ~~Anthropic model/provider choice and key storage for Stage 2 agents.~~ Closed by D-18: JasperEditor embeds no LLM and stores no model keys; the user's own coding agent connects over MCP.

---

## 19. M2: colour, clip processing, motion-graphics clips, tracking, transitions UI

M2 adds five capabilities that the trailer project (`MatsSmileTrailer`) had to do with external scripts. They are
built by five work packages in parallel (`JasperEditor-worktrees/work-packages-m2.json`). The functional specs are
S06–S10; this section fixes the **shared contracts**, most of which already exist on `dev` (commits after
`443b7bc`) so the packages build on code, not on prose. Decisions D-21…D-30 (§2.1) and the D-13 M2 note apply.

| Package | Feature | Spec |
|---|---|---|
| `wp-m2-color` | Lumetri-style grade, LUT assets, Lumetri/Scopes panels, colour native extension | S06 |
| `wp-m2-process` | processed media versions, `jasper-proc`, remote SSH executor, vid.stab LGPL build | S07 |
| `wp-m2-mg` | Remotion bundles as composition clips, props forms, live host, pre-rendered masters | S08 |
| `wp-m2-track` | trackers, tracking jobs, apply, corner-pin UI, native warp stage | S09 |
| `wp-m2-transitions` | transitions drawn/edited on the timeline, Effects bin, Ctrl+D, audio crossfades | S10 |

### 19.1 Document model (schema v3, D-29) — on `dev`

All additions are additive (`packages/project/src/schema/*`); `CURRENT_SCHEMA_VERSION = 3`, v2→v3 is a no-op
migration; fixture `packages/project/test/fixtures/v3/basic.jasper` exercises them.

| Addition | Where | Used by |
|---|---|---|
| `MEDIA_KINDS += 'mg-bundle'`; `MediaAsset.lut?: LutInfo`, `MediaAsset.mgBundle?: MgBundleInfo`; `EMPTY_PROBE` | `schema/media.ts` | color, mg |
| `ProcessStepSchema` (stabilize, dejudder, denoise, deblock, upscale); `NativeRecipe` op `process` | `schema/media.ts` | process |
| `media.derive` gains `asset` (the engine-produced file) | `commands/schemas/project.ts` | process |
| `VideoClip.trackers?: ClipTracker[]` (`tkr_` ids), `TrackerSamples`; visual clips `trackedBy?` | `schema/sequence.ts`, `ids.ts` | track |
| `tracker.add/update/remove/setSamples/apply` | `commands/schemas/tracker.ts` | track |
| `CompositionClip.composition.mediaId` (the mg-bundle); `clip.addComposition.composition = {mediaId, id, version?}` | `schema/sequence.ts`, `commands/schemas/clip.ts` | mg |
| `ParamValue` curve `{curve: [x, y][]}`; `ParamSpec.type 'curve'`, `mediaKinds`, `group`, `ui.control 'wheel'|'curve'|'media'`; property `ValueKind` `curve`/`media`; `validateValue` for curves | `schema/common.ts`, `registry/effects.ts`, `registry/properties.ts`, `commands/handlers/param.ts` | color |
| `transition.update.effectId`; `transition.applyDefault.{media, videoEffectId, audioEffectId, duration}` | `commands/schemas/param.ts` | transitions |

Command handler ownership (stubs answer `E_NOT_IMPLEMENTED` until the package lands; the catalogue records the
owner and milestone): `handlers/process.ts` (`media.derive`, `clip.replaceSource`) → process;
`handlers/composition.ts` (`clip.addComposition`) → mg; `handlers/tracker.ts` (`tracker.*`) → track;
`handlers/transition.ts` → transitions. Any package that needs a new command adds its schema in its own schema
file (`commands/schemas/<area>.ts`) and registers it in `schemas/index.ts` + `catalog.ts` (one line each,
`Contract-Change:`).

### 19.2 Colour contract (D-21) — on `dev`

- `packages/project/src/color/lut.ts`: `Lut` (3D/1D, float32, `.cube` order), `parseCube`, `serializeCube`, `bakeLut`,
  `applyLut` (tetrahedral = FFmpeg `lut3d` default = what the WebGL shader must implement), `applyLutMix`,
  `identityLut`, `lutMaxDelta`.
- `EffectSpec.color?: ColorOp` with `build(params, {lut(mediaId)}) → ColorFn | null` (`registry/effects.ts`):
  pure RGB→RGB on display-referred values; alpha untouched.
- `packages/project/src/color/runs.ts`: `effectRuns` (colour runs vs other effects, stack order),
  `colorRunFn`, `bakeColorRun(effects, registry, ctx, size)`, `colorRunKey` (cache identity incl. LUT asset
  identities), `canonicalJson`, `PREVIEW_LUT_SIZE = EXPORT_LUT_SIZE = 33`.
- Consumers: the compositions' WebGL colour stage (color package, inside `LayerBox`), the engine colour extension
  (`lut3d=file=…` + per-frame `enable` windows via `sampleRuns`), the Scopes panel.
- `effectBadges().native` is true for colour-op effects. The `jasper.lumetri` spec and the colour ops of the M1
  colour effects are added by the color package in `registry/color-effects.ts` and included in
  `defaultEffectRegistry` (`M2_EFFECTS`).

### 19.3 Motion-graphics bundles contract (D-26)

- Asset: `mg-bundle` media with `mgBundle` header; engine storage `<appdir>/mg-bundles/<bundleHash>/`, served at
  `GET /mg/bundles/:key/*` (under the existing `/mg` prefix: no proxy, SW or path-prefix changes).
- Snapshot: `RenderVisualSource` variant `{composition: {mediaId, compositionId, props, canvas}}` (on `dev`); the
  mg package may add `prerender?: {masterUrl, previewUrl}` and a `resolveComposition` snapshot option (additive).
- Layer: `packages/compositions/src/layers/CompositionLayer.tsx` (registered for kind `composition`, placeholder on
  `dev`); `FRAME_DEPENDENT_KINDS` includes `composition`.
- Pre-render: `mg-prerender` jobs → `<appdir>/mg/<renderKey>/{master.mov, preview.webm, poster.png}` (the M1
  `/mg/:key/:file` route); render key = sha256 over bundle hash, composition id, canonical effective props, size,
  fps, frame range, renderer version (S08:MGC-031).
- Export: the `mg` native extension (`kinds: {'composition'}`, `prepare`, `override` space `layer`,
  `prepareForRemotion` + `adaptRemotionDoc` for the Remotion path).

### 19.4 Processing contract (D-23…D-25)

- API (`packages/api/src/processing.ts`): `ProcessRequest`, `ProcessResult`, `ProcessingModel(s)`,
  `RemoteExecutorSettings`, `ProcessingSettings`, `RemoteProbeResult`; routes `mediaProcess`,
  `processingModels`, `processingModelInstall`, `processingSettingsGet/Put`, `processingRemoteProbe`,
  `processingRemoteSetup` (stubs on `dev`).
- Jobs: `process`, `model-download` (existing kind), `remote-setup`.
- `jasper-proc` CLI (S07:PRC-011) is the only place processors live; the engine spawns it locally or over SSH.
- Media registry: `MediaRecord.derivedFrom = {mediaKey, recipeHash}` (on `dev`); the process package adds
  `MediaService.registerDerived(...)`.
- Settings persist in `<appdir>/engine/engine.json` → `processing` (zod, unknown keys tolerated).

### 19.5 Tracking and projective layers (D-27, D-28) — geometry on `dev`

- `packages/project/src/render/homography.ts`: `Mat3` (row-major), `unitSquareToQuad`, `quadToQuad`, `boxToQuad`,
  `invertMat3`, `multiplyMat3`, `applyMat3`, `mat3FromMat2D`, `isAffineMat3`, `isConvexQuad`, `mat3ToCss`
  (`matrix3d`, `transform-origin: 0 0`).
- `jasper.corner-pin` effect (registered, `native: null`): params `topLeft/topRight/bottomRight/bottomLeft`, vec2
  **normalised to the layer box**. `resolveLayerProps` returns `projective = Motion · H(box → pinned quad)` and the
  pinned `quad`; `LayerBox` draws `projective` with `matrix3d`. Until the warp stage lands, corner pins route to
  the Remotion path (planner blocker "uses effect jasper.corner-pin").
- Tracking API (`packages/api/src/tracking.ts`): `TrackRequest` / `TrackResult` (source frames, media px); route
  `trackingTrack`; job kind `track`. Results are committed by the client with `tracker.setSamples`.
- Warp stage: the `warp` native extension (`claimsLayer` for corner pins and keyframed Motion; `override` space
  `sequence`); the track package factors `layerSourceChain(...)` out of `export/native.ts` for it.

### 19.6 Export extensions (D-22) — on `dev`

`apps/engine/src/export/native-ext.ts`; registered with `core.registerNativeExtension(ext)` from the package's route
plugin; consulted in registration order.

```ts
type NativeExtension = {
  id: string;
  effectSupport?(effectId, spec): false | 'static' | 'animated';   // planner stops blocking these effects
  kinds?: ReadonlySet<string>;                                     // extra native-capable clip kinds
  claimsLayer?(clip): boolean;                                     // skip generic Motion/opacity/effect checks
  blockers?(clip): string[];                                       // own blockers for kinds/claimed layers
  prepare?(planned, ctx): Promise<unknown>;                        // before the composite (child jobs, caches)
  override?(clip, prepared): LayerOverride | null;                 // {path, space: 'layer'|'sequence', startFrame, includesFades?, decoder?}
  effectFilter?(fx, ctx): string | undefined;                      // filter text; '' = fused elsewhere; undefined = not mine
  prepareForRemotion?: boolean;                                    // also prepare for Remotion exports/stills
  adaptRemotionDoc?(doc, prepared, {signUrl}): RenderSnapshot;     // e.g. inject master URLs
};
```

- `layer` override: replaces the decoded source (box-sized); the builder applies effects, Motion, opacity, fades.
- `sequence` override: the fully placed layer (W×H, straight alpha, Motion/effects/opacity baked); the builder only
  seeks, applies transition fades (unless `includesFades`) and overlays at (0, 0).
- `sampleRuns(f0, f1, valueAt, key)` turns per-frame animated values into runs (per-frame LUT windows etc.).
- Generated filter text must only use filters present in the LGPL build (D-13 M2 note); each package's tests scan
  their builder output for the GPL list.
- Registration order at start-up (route plugin order in `routes/index.ts`): color, processing, mg-bundles, tracking.
  An effect may be supported by only one extension; the warp extension must not claim layers with composition
  sources (mg handles those as `layer` overrides, which then get warped only if they also carry a corner pin — in
  that case warp wins and sources the layer from the mg master: `prepare` receives `ctx.extensions` and
  `ctx.preparedSoFar`, so it can call `layerOverride(...)` for the `layer` override of an earlier extension).

### 19.7 Engine: routes, jobs, capabilities, assets — on `dev`

- Route plugins (one per package, registered in `ROUTE_PLUGINS`): `routes/color.ts` (no routes; registers the
  `.cube` prober, colour extension, capability), `routes/processing.ts`, `routes/mg-bundles.ts`,
  `routes/tracking.ts` (501 stubs from `routes/stub.ts`). The route table `ROUTES` in `@jasper/api` lists every M2
  route with its owner; the engine route-coverage test accepts implemented or stubbed `wp-m2-*` routes.
- Clients call M2 routes with the typed generic `engine.call('<routeName>', {params, body})` — **no new
  `EngineClient` methods** (avoids five packages editing `client.ts`).
- Job kinds (`@jasper/api` `JOB_KINDS`): `process`, `track`, `mg-bundle`, `mg-prerender`, `layer-bake`,
  `remote-setup`.
- Capabilities: `EngineCapabilities.features = {color?, processing?, mgBundles?, tracking?}`
  (`packages/api/src/m2-capabilities.ts`), each filled by its package through `registerCapabilityProvider`.
- Non-AV assets: `registerAssetProber({id, matches(file), probe(file)})` in `media/probe.ts` (the `.cube` prober
  returns kind `lut` + `lut` header); `MediaRecord.lut/mgBundle/derivedFrom` are copied into `RegisteredMedia`.
- Caches: `<appdir>/cache/luts/`, `<appdir>/cache/warp/`, `<appdir>/mg/<renderKey>/`, `<appdir>/mg-bundles/`,
  `<appdir>/models/`; all content-addressed; GC is each package's responsibility (a `gc` job pass).

### 19.8 Ownership of shared code (who may edit what)

- **Frozen contracts** (additive changes only, with `Contract-Change:` in the commit body, §16.3): everything listed
  in §19.1–§19.7 and §19.10.
- Hot files with a single M2 owner: `packages/project/src/registry/effects.ts` (color), `registry/kinds.ts` and
  `registry/properties.ts` (mg), `commands/handlers/param.ts` (mg: `props.*` targets), `commands/handlers/clip-core.ts`
  + `clip-edit.ts` (track: tracker id remap on split/duplicate), `transitions.ts` + `commands/handlers/transition.ts`
  (transitions), `render/snapshot.ts` (mg for composition prerender fields; transitions for audio handles — separate
  hunks), `export/native.ts` (track: `layerSourceChain` in the video section; transitions: audio section only),
  `compositions/src/layers/LayerBox.tsx`, `VideoLayer.tsx`, `StillLayer.tsx`, `pipeline.ts` (color),
  `remotion/service.ts` (color: `chromiumOptions.gl`; mg imports its helpers read-only), `panels/timeline/**`,
  `panels/effects/**`, `panels/effectControls/**` (transitions), `media/service.ts` (process),
  `scripts/ffmpeg/**` (process), `pnpm-workspace.yaml` (mg: the fixture Remotion project).
- Shared-by-protocol: `apps/engine/package.json` / `pnpm-lock.yaml` (dependencies; the integrator re-runs
  `pnpm install` on conflicts), `packages/ui/src/theme/tokens.css` (new tokens appended in a per-package block),
  `README.md` (one subsection per package), `docs/ARCHITECTURE.md` (packages write `docs/wp-notes/<wp>.md`; the
  integrator folds notes into this file).

### 19.9 MCP (D-18) — modules on `dev`

One tool module per package, wired in `apps/mcp/src/server.ts`: `tools/color.ts`, `tools/processing.ts`,
`tools/compositions.ts`, `tools/tracking.ts`, `tools/transitions.ts`, each exporting `register<X>Tools(ctx)` and a
`<X>_GUIDE` string appended to the server instructions/guide resource. Tools use `defineTool` and the existing
`apply_commands` machinery (transactions with `$refs`, one `Agent:` history entry per call). Tool names are fixed in
the specs (S06:CGA-002, S07:PRA-001, S08:MGA-001, S09:TRA-001, S10:TUI-060).

### 19.10 Web extension points — on `dev`

`apps/web/src/extensions/` (registries + `useRegistry`), hosted by the existing panels:

| Registry | Host | Used by |
|---|---|---|
| `effectEditors` (`{effectId, component, hideParams?}`) | Effect Controls section of that effect | color (Lumetri), track (corner pin) |
| `clipSections` (`{id, title, appliesTo(clips), component}`) | Properties panel, after the built-in sections | mg (Composition), track (Tracking), process (Media Version) |
| `programOverlays` (`{id, active(session), component}`) | Program monitor, above the transform overlay | track |
| `clipMenuExtensions` | timeline clip context menu | process, track, color (copy/paste grade) |
| `projectItemMenuExtensions` | Project panel item context menu | process, mg, color |

Registration happens at module load of the package's command module `apps/web/src/commands/<area>.ts`
(`color`, `process`, `composition`, `tracking`, `transitions`; all in `COMMAND_MODULES`). Panels: `lumetri` and
`scopes` exist as placeholders (color). Dialogs register with `registerDialog` from the same modules. Preferences
(`app.preferences`, currently unregistered) are created by the process package with a page registry.

### 19.11 Tests, fixtures, verification

- Every package keeps `pnpm lint && pnpm typecheck && pnpm test` green in its worktree and adds its tests next to
  its code (unit), engine route tests with real ffmpeg, component tests (happy-dom) and one Playwright spec
  (`e2e/<area>.spec.ts`).
- Fixtures: one plug-in per package in `scripts/fixtures/<area>.mjs` (loaded by `pnpm fixtures`).
- Downloads are never required by tests (test ONNX model generated; LUTs generated; Remotion fixture bundled from
  the workspace).

### 19.12 Decisions the user must make (open)

1. **Super-resolution model and hosting.** Default proposal: SPAN 2× `2xNomosUni_span_multijpg` (weights CC BY 4.0,
   attribution in About/Licenses; code Apache-2.0), converted by us to ONNX and hosted where? (GitHub release of our
   own repo, or first-run conversion from the upstream `.pth` on the user's machine — the latter needs PyTorch and
   is not recommended.) Alternatives: Real-ESRGAN compact (BSD-3; hallucinates text on UI footage).
2. **Remote GPU host.** The rented box used by the trailer is gone. Settings are generic (host/port/user/key/
   remote dir); tests run against shims and optionally `localhost` sshd or a Docker sshd. A real-GPU validation
   needs a host (Linux x64, NVIDIA driver + CUDA 12, Node ≥ 20) when the user wants it.
3. **vid.stab source build on Linux.** Adopting it switches the linux-x64 LGPL FFmpeg from the pinned BtbN prebuilt
   to our source build (longer build, same ABI); Windows keeps BtbN + `deshake` until a cross build exists.
4. **Host key policy** default `accept-new` (convenient) vs `yes` (strict).
5. **Composition fps mismatch** policy (S08:MGC-005: override fps and warn) — acceptable?

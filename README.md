# JasperEditor

A Premiere-style, agent-drivable video editor combining Remotion (preview and graphics renders), native
ffmpeg (probe, proxies, fast export) and fframes motion graphics. Web app, installable PWA and Electron
desktop all load the same SPA and talk to the same local engine. External coding agents (Claude Code, Codex
CLI, Cursor) drive it through its MCP server, `jasper-mcp` (see "Use JasperEditor from Claude Code / Codex /
Cursor" below).

Read `docs/ARCHITECTURE.md` first; functional specs live in `docs/specs/`, research in `docs/research/`.
The M1 acceptance run (every ARCHITECTURE §15 item, with evidence) is in `docs/M1-STATUS.md`; per-package
notes and known gaps are in `docs/wp-notes/`.

**Clean-room rule:** never open, read, grep or copy anything from `.reference/` or `editor-starter.zip`
(ARCHITECTURE §0). All code here is original.

## Requirements

- Node 20.19+ (tested on 20.20), pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)
- ffmpeg/ffprobe on `PATH` (system 6.x is fine) for fixtures, and for the engine until the LGPL build is
  fetched. The encoder selector (`apps/engine/src/tools/encoders.ts`, ARCHITECTURE D-13) picks usable
  hardware H.264, then libopenh264, then libx264 (only in GPL dev builds), and otherwise falls back to
  AV1/VP9. x264 is never required; `JASPER_FFMPEG_LGPL_ONLY=1` makes a GPL system build behave like the
  shipped one.
- The LGPL FFmpeg that ships with the app: `pnpm ffmpeg:lgpl` (see "FFmpeg (LGPL)" below). Dev works without
  it; `pnpm e2e`, packaged builds and any non-dev engine need it for the Remotion render path.
- Optional: cargo for the `jasper-mg` motion-graphics renderer (`pnpm mg:build`; without it motion graphics
  export through Remotion).
- E2E: Google Chrome at `/usr/bin/google-chrome` (Playwright `channel: 'chrome'`); desktop smoke: `xvfb-run`.

## Quick start

```bash
pnpm install
pnpm fixtures        # fixtures/media/{clip-a.mp4, clip-b.mp4, tone.wav, still.png, phone-rot90.mp4}
pnpm mg:build        # optional: native/mg → jasper-mg (fframes); the engine then reports fframes: ready
pnpm ffmpeg:lgpl     # optional in dev: the LGPL FFmpeg + Remotion binaries directory (vendor/ffmpeg-lgpl/)
pnpm dev             # engine on http://127.0.0.1:47900 + web on http://127.0.0.1:5173 (proxied, same origin)
```

Open http://127.0.0.1:5173: Home lists the engine's projects; **New Project** opens the Editing workspace.

Desktop (Electron):

```bash
pnpm dev                                   # in one terminal (the window loads http://127.0.0.1:5173)
pnpm dev:desktop                           # in another; headless: xvfb-run -a env ELECTRON_DISABLE_SANDBOX=1 pnpm dev:desktop
pnpm build && pnpm --filter @jasper/desktop start:packaged-like   # engine forked on a random port, token cookie
```

`ELECTRON_DISABLE_SANDBOX=1` is needed on hosts without the chrome-sandbox SUID helper. A fresh checkout may
need `node node_modules/.pnpm/electron@*/node_modules/electron/install.js` if the Electron binary is missing.

## FFmpeg (LGPL)

JasperEditor ships an **LGPL FFmpeg** and nothing GPL/nonfree (ARCHITECTURE D-13, `docs/wp-notes/wp-lgpl.md`).
Remotion's npm compositor packages bundle a GPL FFmpeg, so the Remotion render path uses our build instead:

```bash
pnpm ffmpeg:lgpl      # → vendor/ffmpeg-lgpl/<platform>-<arch>/  (gitignored; every download is sha256-pinned)
pnpm ffmpeg:check     # license guard: fails on --enable-gpl, --enable-nonfree, x264/x265/fdk-aac, …
```

- **Linux x64/arm64, Windows x64:** a pinned BtbN `lgpl-shared` FFmpeg 7.1 build is downloaded (~50 MB).
  `node scripts/ffmpeg/fetch-or-build-lgpl.mjs --platform win32-x64` assembles the Windows directory from
  any host.
- **macOS:** no LGPL prebuilt exists; `pnpm ffmpeg:lgpl` builds FFmpeg 7.1 and its codecs from pinned
  sources (`scripts/ffmpeg/build-lgpl-from-source.sh`; needs Xcode command line tools, cmake, pkg-config).
  `--from-source` does the same on Linux; `--ffmpeg-prefix <dir>` uses an existing LGPL 7.1 install.
- The directory holds `ffmpeg`, `ffprobe`, the `libav*` shared libraries, Remotion's own `remotion`
  compositor executable (FFmpeg 7.1 ABI, copied unmodified), the license text and a notice with the source
  link. The engine passes it to Remotion as `binariesDirectory` and uses its ffmpeg for everything else.
- Resolution: `JASPER_REMOTION_BIN_DIR` → packaged `<resources>/ffmpeg-lgpl` → `vendor/ffmpeg-lgpl/<platform>`;
  the engine's own ffmpeg: `JASPER_FFMPEG`/`JASPER_FFPROBE` → packaged resources → that vendor directory →
  `PATH` (`JASPER_FFMPEG_VENDOR=0` ignores the vendor directory).
- Without the directory a **dev** engine (`pnpm dev`) still renders through Remotion's bundled build and
  warns "Remotion is using its bundled GPL FFmpeg (dev only)" (startup log, `/api/capabilities`
  `render.remotionBinaries`, Export view, Help ▸ About). Every other engine refuses the Remotion path.
- H.264 exports on the Remotion path render a ProRes intermediate that the engine encodes (hardware H.264 or
  OpenH264); VP9/Opus WebM is written by Remotion directly.
- Help ▸ About JasperEditor shows FFmpeg's license text and the source of the build in use
  (`GET /api/licenses`).

Packaging the desktop app:

```bash
pnpm --filter @jasper/desktop dist:dir   # apps/desktop/release/<os>-unpacked (add `--platform win32` to cross-pack)
pnpm e2e:packaged                        # runs the packed engine outside the checkout; Remotion export on the LGPL build
```

`scripts/package.mjs` stages the engine without Remotion's compositor packages, ships the LGPL directory as
`<resources>/ffmpeg-lgpl`, and the build fails if any GPL/nonfree FFmpeg would be packed
(`pnpm ffmpeg:check --packaged <dir>` is the same check).

Running a second dev stack on other ports (another worktree, or 5173/47900 are taken):

```bash
JASPER_APPDIR=./.stage JASPER_DEV=1 JASPER_DEV_WEB_PORT=<vite port> pnpm exec tsx apps/engine/src/cli.ts --port <engine port>
cd apps/web && JASPER_ENGINE_URL=http://127.0.0.1:<engine port> pnpm exec vite --port <vite port> --strictPort
```

Electron then takes `JASPER_DESKTOP_DEV_URL=http://127.0.0.1:<vite port>`. Without `JASPER_APPDIR` the engine
uses the platform appdir (`~/.local/share/jasper` on Linux).

## Clip processing

Processed versions of media (S07, `docs/wp-notes/wp-m2-process.md`): **Clip ▸ Process Clip…** (also in the
timeline clip and Project item context menus) runs deblock → denoise → stabilise → de-judder → AI upscale as an
engine job and swaps the clip to the result in one undoable step; **Properties ▸ Media Version** switches back.
Every step keeps the frame count and rate, so timing never changes; the export reads the processed ProRes file.

- Runtime: `jasper-proc` (`apps/engine/src/processing/proc/`, bundled to `apps/engine/dist/jasper-proc.mjs` by
  `pnpm --filter @jasper/engine build`), run by the engine locally or on a remote host over SSH (Preferences ▸
  Processing: host, user, key file, remote dir; *Set up* installs the runtime there).
- Stabilise: vid.stab (LGPL-2.1+ since its 2026 relicense, pinned commit) compiled to WebAssembly
  (`apps/engine/src/processing/proc/vidstab/vidstab.wasm`, rebuilt with `scripts/vidstab-wasm/build.sh`), so it
  works on Linux, Windows and macOS; FFmpeg's own vid.stab filters are an optional faster path with our LGPL
  source build (`pnpm ffmpeg:lgpl --from-source`, accepted by `pnpm ffmpeg:check` only for the pinned commit);
  `deshake` is the last resort.
- De-judder: cadence analysis + flow warp with OpenCV.js (Apache-2.0) in worker threads.
- Denoise/deblock: LGPL FFmpeg filters only (`atadenoise`, `fftdnoiz`, `nlmeans`, `deblock`).
- Upscale: ONNX Runtime (`onnxruntime-node`, MIT) with the bundled SPAN 2× model
  (`apps/engine/models/`, *2xNomosUni_span_multijpg by Philip Hofmann, CC BY 4.0*; conversion:
  `scripts/models/export-span-onnx.py`). Help ▸ About ▸ Licenses lists all of them.
- MCP: `process_clip`, `use_media_version`, `list_processing_models`, `test_remote_executor`, …

## Motion graphics from Remotion projects

Remotion projects become media (S08, `docs/wp-notes/wp-m2-mg.md`): **File ▸ Import Remotion Project…** takes a
project folder (pinned to `remotion` / `@remotion/cli` **4.0.499**, dependencies installed — the engine bundles
it with the project's own CLI and can watch it for changes) or, on the web, a zip of a built bundle. Each
composition then appears in **Motion Templates ▸ Remotion**; double-click or drag one onto the timeline.

- Properties ▸ Composition shows a form built from the props schema: `jasper.mg.json` (per composition, or a
  `"*"` entry for every composition — useful for registry-style projects whose compositions have empty
  `defaultProps`), else a zod schema module named in `package.json` `"jasper": {"schemas": "./src/jasper-schemas.ts"}`,
  else inferred from `defaultProps`. Edits are validated and undoable.
- Preview: a live frame host (the bundle page in an iframe, driven frame by frame) while you edit; after 2 s
  without changes a VP9-alpha preview takes over for smooth playback.
- Export: the native path composites cached ProRes 4444 masters with straight alpha, rendered by Remotion on
  demand (child jobs) and keyed by bundle hash + props + size + fps + range, so a prop or code change renders a
  new one. The clip badge turns from "R" to "✓" when the master is cached.
- `fixtures/mg-project/` is a minimal example (Title with a zod schema, Badge inferred).
- MCP: `import_mg_bundle`, `list_compositions`, `add_composition`, `set_composition_props`,
  `prerender_composition`, `scaffold_mg_project`.

## In-video animation runtime (anime.js)

Animated titles and anime templates (S11, `docs/wp-notes/wp-m2-anime-core.md`) run on **anime.js 4.5.0** (pinned
exactly) as a seek-driven value engine in `@jasper/motion`: timelines are created paused, moved only with the
canonical seek (`seek(duration) → seek(0) → seek(frame·1000/fps)`) and animate plain objects that React renders
as inline styles, so the Player, `renderStill` and parallel `renderMedia` agree frame for frame.

- `node scripts/check-anime.mjs` (part of `pnpm lint`) rejects autoplay, timers, wall clock, unseeded randomness
  and the other S11:ANM-006 patterns in `packages/motion/src` and `packages/compositions/src`; a line may opt out
  with `// anime-allow: <reason>`. Biome mirrors the import bans.
- Text and anime-template layers wait for their font faces (per family/weight/style) before they mount, so they
  never measure or paint with a fallback font.
- The determinism suite (`packages/motion/test/determinism.test.tsx`) checks every registered text animator and
  anime template in order, reversed and shuffled against a fresh build per frame. Render parity (stills vs
  `renderFrames`/`renderMedia` at concurrency 1 and 4, reversed and shuffled visits, Player vs still) and the
  value-engine cost run with
  `REMOTION_E2E=1 pnpm exec vitest run packages/motion/test/determinism-render.e2e.test.ts`
  (Chrome at `/usr/bin/google-chrome` or `JASPER_BROWSER_EXECUTABLE`).
- `pnpm notices` regenerates `THIRD_PARTY_NOTICES.md` (the JavaScript packages shipped in the web app and the
  Remotion bundle, with their licence texts); `pnpm notices --check` fails when it is stale (a test runs it).
  The web build ships it as `/THIRD_PARTY_NOTICES.md`, linked from Help ▸ About. Build tools whose output
  ships (Tailwind's CSS, Vite's and webpack's runtimes, Remotion's bundle entry) are an explicit list in
  `scripts/third-party-notices.mjs`; after `pnpm --filter @jasper/web build` and
  `pnpm --filter @jasper/engine build:remotion`,
  `pnpm notices --audit apps/web/dist apps/engine/dist/remotion-bundle` reports shipped packages it misses.
- New composition projects (`POST /api/mg-bundles/scaffold`, MCP `scaffold_mg_project`) include an `AnimeTitle`
  example and a README section on driving anime.js from the frame in a Remotion composition.

## Text animations

Text clips can animate in and out (S11 §4, `docs/wp-notes/wp-m2-text-anim.md`): twelve presets — Fade, Slide
Up/Down/Left/Right, Pop, Blur, Typewriter, Tracking, Mask Reveal, Rotate In, Drop — per character, word or line,
with stagger, order (forward, backward, centre, edges, seeded random), ease and preset-specific params.
Typewriter types behind a caret that blinks while typing pauses, like an editor's (`caretBlink`, `blinkRate`,
`delay`, `typing`; Out blinks, then deletes backwards); the blink is a function of the frame, so renders agree.

- **Motion Templates ▸ Text Animations**: cards with a hover preview; double-click (or Enter) applies to the
  selected text clips (the In / Out chip picks the side), the card menu offers Apply as In / Apply as Out, and
  dragging a card onto a text clip in the Timeline, Program or Effect Controls applies it (first half of the clip
  = In, second half = Out).
- **Properties / Effect Controls ▸ Text Animation**: preset picker, duration in frames and the params; Effect
  Controls also draws the In/Out windows on its mini-timeline — drag a bar's inner edge to change the duration.
  The timeline shows head/tail wedges on animated text clips.
- **Graphics ▸ Text Animation ▸ Apply In… / Apply Out… / Remove** and the clip context menu.
- Windows are anchored to the clip's first and last visible frames (Out plays the In motion mirrored); when In +
  Out exceed the clip both are shortened proportionally (warning `W_ANIMATION_COMPRESSED`). The razor keeps In
  on the left part and Out on the right part.
- Rendering is a pure function of the frame (anime.js 4.5.0 as a seek-only value engine, `@jasper/motion`), so
  the Program, `renderStill` and parallel `renderMedia` agree.
- Commands / MCP: `clip.addText {textAnimation}`, `clip.update {textAnimation}`, `param.set
  textAnimation.<side>.…`; UI commands `text.applyAnimation` / `text.removeAnimation`; MCP
  `list_text_animations`, `set_text_animation`, `add_text {animateIn, animateOut}`, `render_frames` (contact
  sheet).

## Animated templates (anime.js)

**Motion Templates ▸ Templates** also lists animated templates drawn with anime.js (S11 §5,
`docs/wp-notes/wp-m2-anime-templates.md`): **Title Reveal**, **Lower Third (Animated)**, **Callout** and
**Counter**. Their cards carry the badge **R** and the label *anime · Remotion*; the engine filter has an `anime`
value; hovering any card (also the fframes ones) plays a preview. Insert them like the fframes templates
(double-click, Enter or drag onto the timeline / Program).

- Timing is responsive: the intro starts at the clip start, the outro ends at the clip end, the middle stretches
  when you trim the clip (frame-exact at any frame rate).
- Properties ▸ Parameters edits the params; numeric and colour params have stopwatches (Effect Controls and
  Properties) — keyframes are evaluated per frame by the same evaluator as Motion. Properties ▸ Template shows the
  engine and, when a newer version of the template is installed, **Update template to vN** (one undo step).
- Motion, opacity, every blend mode (incl. Add), effects and corner pins apply to both template kinds. Like the
  fframes templates, animated templates are clipped to their canvas (what a design draws outside it — e.g. a
  Callout label pushed past the edge — is hidden in preview and export alike).
- Preview and Remotion exports draw them in the browser (deterministic: every frame is a pure function of the
  frame number); native exports bake them through the layer-bake extension. They are never sent to `jasper-mg`.
- A clip whose template is not installed shows a placeholder card and blocks every export ("template id@vN is
  not installed").
- MCP: `list_motion_templates` (renderer + params summary), `add_motion_graphic`, `set_motion_graphic_params`,
  `render_motion_graphic_preview` (a Remotion still for anime templates).

## PWA (installable web app)

The Vite dev server does not register the service worker; install from a production build served by the
engine:

```bash
pnpm build
JASPER_WEB_DIR=apps/web/dist node apps/engine/dist/engine.mjs --port 47900 --appdir ./.stage
```

Open http://127.0.0.1:47900 in Chrome or Edge and use the address-bar **Install** icon (or the Install entry in the
browser menu). `127.0.0.1` counts as a secure context, so no TLS is needed locally. The
build emits `manifest.webmanifest` (standalone, window-controls-overlay, `.jasper` file handler), `sw.js` and
the icons under `apps/web/dist/icons/`; the service worker caches the app shell and bypasses engine routes (`/api/*` is never cached).

## Use JasperEditor from Claude Code / Codex / Cursor

JasperEditor has no built-in chat agent. Your own coding agent drives it through the **`jasper-mcp`** MCP
server (`apps/mcp`, ARCHITECTURE §11): it creates projects, imports media, edits the timeline, renders
frames to look at, and exports. When the project is open in an editor window the edits appear there live,
each as one undoable `Agent: …` History entry; deleting tracks or items asks for your approval on a card at
the top of the window. With the editor closed the same tools work headlessly on the saved project.

Build the server once (one bundled file, needs Node 20.19+), and start the editor:

```bash
pnpm install
pnpm mcp:build     # → apps/mcp/dist/jasper-mcp.mjs
pnpm dev           # or the desktop app; the server finds the running engine by itself
```

Then register it with your agent. Replace `/abs/path/to/JasperEditor` with the absolute path of this
checkout; in the app, **Help ▸ Connect an AI Agent…** shows the same snippets with the real path filled in.

**Claude Code**

```bash
claude mcp add jasper -- node /abs/path/to/JasperEditor/apps/mcp/dist/jasper-mcp.mjs
# every project instead of only the current one:  claude mcp add --scope user jasper -- node …
claude mcp list    # jasper: … - ✔ Connected
```

or a project-scoped `.mcp.json` next to your work (Claude Code asks once before using it):

```json
{
  "mcpServers": {
    "jasper": {
      "command": "node",
      "args": ["/abs/path/to/JasperEditor/apps/mcp/dist/jasper-mcp.mjs"]
    }
  }
}
```

**Codex CLI**

```bash
codex mcp add jasper -- node /abs/path/to/JasperEditor/apps/mcp/dist/jasper-mcp.mjs
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.jasper]
command = "node"
args = ["/abs/path/to/JasperEditor/apps/mcp/dist/jasper-mcp.mjs"]
```

**Cursor** — `.cursor/mcp.json` in a project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "jasper": {
      "command": "node",
      "args": ["/abs/path/to/JasperEditor/apps/mcp/dist/jasper-mcp.mjs"]
    }
  }
}
```

Then ask the agent, for example: *"Call engine_status, create a project called Teaser, import
/home/me/footage/a.mp4 and b.mp4, cut a 20 s teaser with a title, show me a frame, and export it to
/tmp/teaser.mp4."*

How the server finds the engine, in order: `--engine-url` / `--token` (or `JASPER_ENGINE_URL` /
`JASPER_ENGINE_TOKEN`); the `engine/runtime.json` a running engine writes into its appdir, looked up for
`--appdir`, `JASPER_APPDIR`, the platform appdir and the desktop app's appdir; then
`http://127.0.0.1:47900`. `pnpm dev` keeps its appdir in `./.stage`, which the last step covers; for an
engine on another port pass `--appdir /abs/path/to/JasperEditor/.stage` (or `--engine-url`) after the script
path. The desktop app's per-launch token is read from its `runtime.json` (mode 0600), so nothing has to be
copied and the token is never shown to the agent.

| Option (append after `jasper-mcp.mjs`) | Effect |
|---|---|
| `--start-engine` | start a headless engine when none is running, so agents can work with JasperEditor closed (needs `pnpm build`; stops with the server) |
| `--appdir <dir>` | look for `<dir>/engine/runtime.json` first (and use it for `--start-engine`) |
| `--engine-url <url>` `--token <t>` | skip discovery |
| `--agent-name <name>` | name shown in History and on approval cards (default: the MCP client's name) |
| `--request-timeout <s>` | deadline for one engine request (default 180) |

Tools (69; `apps/mcp/test/readme-tools.test.ts` keeps this list in sync with the server):
- Core: `engine_status` · `list_projects` `create_project` `get_project` `open_project_in_editor` ·
  `import_media` `list_media` `get_media_info` · `describe_commands` `apply_commands` `undo` `redo` ·
  `add_clip` `move_clip` `trim_clip` `split_at` `delete_clips` `add_text` `add_marker` `add_motion_graphic`
  `add_transition` · `get_timeline` `render_frame` `get_playhead` `set_playhead` · `list_motion_templates`
  `render_motion_graphic_preview` · `list_export_presets` `start_export` `get_job` `cancel_job` `wait_for_job`.
- Colour: `import_lut` `grade_clip` `get_grade` `copy_grade`.
- Clip processing: `list_processing_models` `install_processing_model` `process_clip` `use_media_version`
  `get_processing_settings` `set_processing_settings` `test_remote_executor`.
- Remotion projects: `import_mg_bundle` `list_compositions` `add_composition` `set_composition_props`
  `prerender_composition` `scaffold_mg_project`.
- Tracking: `add_tracker` `track` `apply_tracking` `get_tracker` `set_corner_pin`.
- Transitions: `list_transitions` `update_transition` `remove_transitions` `apply_default_transitions`.
- Animation and graphics: `list_text_animations` `set_text_animation` `render_frames` `set_motion_graphic_params`
  `add_shape`.
- Clipboard: `copy_clips` `paste_clips` `copy_items` `paste_items`.
- Media cache: `get_cache_usage` `clean_cache`.

Resources: `jasper://projects/{projectId}/document`, `jasper://projects/{projectId}/timeline`,
`jasper://guide`. Prompt: `edit-video`.

The engine also serves the same tools over MCP Streamable HTTP at `/mcp`, for clients that connect by URL.
With a dev or standalone engine (no token): `claude mcp add --transport http jasper http://127.0.0.1:47900/mcp`.
The desktop engine needs `Authorization: Bearer <token>` and issues a new token on every launch, so use the
stdio server there.

The packaged desktop app ships the server as `resources/mcp/jasper-mcp.mjs`. It has no `node`: Help ▸ Connect
an AI Agent… gives the command that runs the bundle with the app's own binary (`ELECTRON_RUN_AS_NODE=1`).

No repo-root `.mcp.json` is committed on purpose: it would switch the server on for everyone who opens this
checkout in an MCP client, and it would point at a bundle that may not be built yet.

### HTTP API underneath

The MCP tools are thin wrappers over the engine's agent API (protocol `jasper.tx/1`): the JSON Schema of every
command is at `GET /api/agent/schema`, read-only queries go to `POST /api/agent/query`, and transactions to
`POST /api/agent/tx`. It can be used directly for scripting:

```bash
# create a project (or take a projectId from GET /api/projects)
curl -s -X POST http://127.0.0.1:47900/api/projects -H 'content-type: application/json' \
  -d '{"name":"Curl demo","preset":"hd-1080p-30"}'
# → {"projectId":"prj_…"}

curl -s -X POST http://127.0.0.1:47900/api/agent/tx -H 'content-type: application/json' -d '{
  "projectId": "prj_…",
  "transaction": {
    "protocol": "jasper.tx/1",
    "label": "Mark the intro",
    "origin": { "agent": "curl", "runId": "demo" },
    "commands": [{ "type": "marker.add", "frame": 30, "name": "Intro" }]
  }
}'
# → {"result":{"ok":true,"revision":1,"created":["mrk_…"],…},"appliedBy":"headless"}
```

The engine binds loopback only. The packaged-like desktop engine requires its per-launch token
(`JASPER_LOCAL_TOKEN`), so plain curl calls are meant for the dev or standalone engine.

## Tracking and screen replacement

To replace a monitor's screen or a sign in the footage:

1. Put the footage (the plate) on V1 and the replacement (image, video or composition) on a track above it.
2. Select the plate. In **Properties ▸ Tracking**, click **Add Planar Tracker**.
3. Drag the quad's corners onto the screen's edges on the Program monitor. Corners may lie outside the frame.
4. Click **Track Both** (or Track Forward / Backward). Keep **Snap to edges** on for screens with a bezel.
5. Click **Apply to… ▸ Corner Pin** and pick the replacement.

The result is ordinary Corner Pin keyframes. To correct a frame, drag the pin's handles, or move the tracker corners and use **Track from Here**.

Point trackers drive Position (and planar ones optionally Scale and Rotation) for elements that follow something.

Corner pins and keyframed Motion export on the native ffmpeg path through the warp stage: an LGPL-safe per-frame warp, cached as ProRes 4444 under `<appdir>/cache/warp/`.

Agents use the `add_tracker`, `track`, `apply_tracking`, `get_tracker` and `set_corner_pin` MCP tools. Tracking runs OpenCV.js (Apache-2.0) in engine worker threads. Details: `docs/specs/09-tracking.md` and `docs/wp-notes/wp-m2-track.md`.

## Shapes

Rectangles and ellipses are `shape` clips (S11 §7, `docs/wp-notes/wp-m2-shapes.md`):

- **Graphics ▸ New Layer ▸ Rectangle / Ellipse** (Ctrl+Alt+R / Ctrl+Alt+E) adds a 400×400 white shape at the
  playhead on the targeted video track. The **Rectangle** and **Ellipse** tools (Tools panel, Pen flyout) draw one
  in the Program monitor: drag the box, **Shift** for a square/circle, **Alt** to draw from the centre, **Esc**
  cancels.
- **Properties ▸ Shape**: size (link toggle), fill or None, stroke on/off with colour, width and position
  (inside / center / outside — the visible width is always the width you set), corner radius for rectangles.
  **Effect Controls ▸ Shape** keyframes size, fill, stroke colour/width and radius.
- **Edit ▸ Preferences ▸ Graphics ▸ Resize shapes by size**: the transform handles change the shape's size instead
  of its Motion scale, so strokes keep their width (Alt keeps the opposite side in place, Shift the ratio).
- Shapes are drawn as inline SVG (`@remotion/shapes` geometry) in the preview and in Remotion renders; with the
  layer bake they export natively. Agents use `add_shape`, or `clip.update {shape}` / `param.set` on `shape.*`.
- Tests: `e2e/shapes.spec.ts`; pixel check against an analytic reference with
  `REMOTION_E2E=1 pnpm vitest run apps/engine/test/shapes-remotion.e2e.test.ts`.

## Clipboard

Copy and paste work like Premiere's (S01 §20, `docs/wp-notes/wp-clipboard.md`):

- **Edit ▸ Cut / Copy / Paste / Paste Insert / Paste Attributes… / Remove Attributes…** (Ctrl/Cmd+X / C / V,
  Ctrl/Cmd+Shift+V, Ctrl/Cmd+Alt+V) act on the focused panel. **Timeline** and **Program monitor** (right-click a
  layer): clips with their linked partners and the transitions between them; Paste lands at the playhead with the
  lowest copied track on the lowest targeted track (overwrite; Paste Insert ripples), selects the copies and moves
  the playhead to their end. Cut leaves a gap. **Effect Controls**: selected keyframes (pasted at the playhead,
  same property or the selected one of the same kind) or the selected effect (else every applied effect), pasted
  onto all selected clips. **Project panel**: items and bins, sequences deep-copied into the selected bin.
- **Paste Attributes…** lists Motion, Opacity, Volume, Panner, each copied effect, text In/Out animation and style,
  and shape style, with *Scale Attribute Times*; **Remove Attributes…** resets or removes them. Every paste is one
  undo step.
- The clipboard holds a versioned JSON payload (`jasper-clipboard` v1, validated, ≤ 20 MB) with every media,
  font, synthetic and transcript it uses, so pastes into another project or browser tab resolve: media by
  fingerprint, else added (offline until reachable). It travels as `text/html` (embedded) + `text/plain`, on
  desktop also as `application/x-jasper-clipboard`, and stays in memory for same-tab pastes. Text fields keep
  their own copy/paste.
- **Content from other apps** (S01:CLB-010): files are imported (and placed at the playhead on the lowest targeted
  tracks when the Timeline or Program monitor has the focus; desktop file-manager copies register in place, no
  upload), copied image data becomes an image asset named "Pasted image <date> <time>" (placed the same way), and
  plain text in the Timeline or Program monitor becomes a 5 s centred text clip on the lowest targeted video track.
  Each is one undo step. Browsers expose no files to Edit ▸ Paste, so paste files with Ctrl/Cmd+V on the web.
- **Program monitor right-click on a layer** (S03:XF-050) also has Reset Motion, Reset Crop, Fit to Frame, Fill
  Frame, Set to Native (100%), Anchor ▸ (centre, corners, edges; the image stays put), Arrange ▸ (Bring to Front /
  Forward, Send Backward / to Back: the clip moves to another video track at the same time, new tracks only above
  the top; Ctrl/Cmd+[ / ] with Shift in the monitor), Reveal in Timeline and Reveal in Project — also in
  Clip ▸ Transform, Graphics ▸ Arrange and (Reveal in Project) the Timeline clip menu.
- Agents: `copy_clips` / `paste_clips` / `copy_items` / `paste_items`, or the commands `clip.paste`,
  `clip.pasteAttributes`, `clip.removeAttributes`, `effect.paste`, `keyframe.paste`, `project.pasteItems` in
  `apply_commands`.
- Tests: `packages/project/test/clipboard.test.ts`, `apps/web/test/clipboard.test.tsx`,
  `apps/web/test/clipboard-external.test.tsx`, `apps/web/test/program-layer-menu.test.tsx`, `e2e/clipboard.spec.ts`;
  desktop: `pnpm e2e:desktop-clipboard` (two desktop apps + a helper "other app" under xvfb: copy in one, paste in
  the other through `application/x-jasper-clipboard`; external text, image data and file-manager files).

## Export: titles, shapes and animated templates (layer bake)

Text clips, shapes and anime motion templates are drawn by the browser (React/DOM), yet exports stay on the fast
native ffmpeg path: the engine **bakes** each of these layers through Remotion into a cached straight-alpha master
and overlays it (S11 §6, `docs/wp-notes/wp-m2-layer-bake.md`). The export plan then says **Hybrid (native +
graphics)** and lists one graphics group per baked layer.

- A layer without any animation (no keyframes, no text animator, not an anime template) bakes **one PNG**, looped
  for its span; animated layers bake a ProRes 4444 master of their drawn span (transition handles included). Small
  layers are rendered only in their region of the frame (union of their per-frame bounds plus a margin; a layer
  that draws past it is re-rendered full frame).
- Bakes run as child jobs of the export ("Baking graphics 1/3 · 40 %"), several at a time: they share the export's
  Remotion page budget (its Remotion concurrency, at most half the cores; a still takes one page, a long animated
  title more) and one render browser; two exports needing the same bake render it once.
  `JASPER_LAYER_BAKE_PARALLEL=1` bakes one after the other, `JASPER_LAYER_BAKE_SHARED_BROWSER=0` gives every bake
  its own browser. Bakes are cached under `<appdir>/cache/layers/<key>/`
  by a content key (clip, font files, media, compositions bundle, anime.js, Remotion, browser, GL back end);
  re-exports and moving a clip in time reuse them; entries unused for 14 days are removed.
- Colour effects (Lumetri, LUTs…) on these layers are applied by ffmpeg to the bake (`lut3d`); the Remotion path
  plays a graded copy; in the Program monitor the layer shows **Grade pending** until a graded preview arrives
  (about 2 s after the last change, then the bake time).
- Stills and the MCP `render_frame` tool take the same path. If a bake fails, an **Auto** export falls back to the
  Remotion path (warning `NATIVE_FALLBACK` in the job result); a forced **Native** export fails with the error.
- Without the Remotion renderer (no browser / no LGPL FFmpeg directory in a packaged engine) these layers block
  the native path and the plan explains why; `GET /api/capabilities` reports `features.layerBake`.
- Engine tests with real renders: `REMOTION_E2E=1 pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts
  test/layer-bake-parallel.e2e.test.ts` (the second compares parallel and sequential bakes byte for byte;
  `LAYER_BAKE_BENCH=1` adds the benchmark); Playwright: `e2e/layer-bake.spec.ts`.

## Tests

```bash
pnpm fixtures && pnpm mg:build   # optional first: some engine tests skip without jasper-mg
pnpm verify              # lint + typecheck + unit/integration tests + build
pnpm e2e                 # builds engine + web + jasper-mcp, then Playwright (headless Chrome) against the built engine
pnpm e2e:desktop         # Electron under xvfb: packaged-like and dev mode, screenshots in test-results/, then the clipboard check
pnpm e2e:desktop-clipboard  # two packaged-like desktop apps over CDP: cross-app copy/paste and external pastes
pnpm e2e:mg-fallback     # fframes ready → native plan; jasper-mg missing → Remotion plan with the reason
pnpm e2e:packaged        # after `pnpm --filter @jasper/desktop dist:dir`: packed engine + LGPL FFmpeg only

# Remotion render through the LGPL FFmpeg directory (needs `pnpm ffmpeg:lgpl` and a Chrome):
REMOTION_E2E=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  pnpm --filter @jasper/engine exec vitest run test/remotion-lgpl.e2e.test.ts
```

`pnpm e2e` starts `e2e/serve.mjs`: the built engine (`apps/engine/dist/engine.mjs`) serving the built web app
on `127.0.0.1:${E2E_PORT:-48110}` with a throwaway appdir. `E2E_SKIP_BUILD=1` reuses existing builds,
`E2E_KEEP_APPDIR=1` keeps the appdir for inspection. The pre-step also fetches the LGPL FFmpeg directory
where a pinned prebuilt exists (`E2E_SKIP_LGPL=1` skips it), so the exports in the specs are made by the
shipped build (H.264 by OpenH264).

`pnpm test` includes the MCP integration suite (`apps/mcp/test/integration.test.ts`): it boots a real engine
in token mode on `127.0.0.1:${MCP_TEST_PORT:-48551}` (and `--start-engine` on the next port) with a temp
appdir, connects an MCP SDK client to `jasper-mcp` over stdio, and goes from create project → import fixture
media → edit → `render_frame` (PNG) → `start_export` + `wait_for_job` → ffprobe of the output. Run it alone
with `pnpm exec vitest run --project @jasper/mcp`.

Playwright specs:

- `e2e/smoke.spec.ts` — Home → New Project → import `clip-a.mp4` (file chooser) → poster → drag to the
  timeline → play → move/trim/razor → undo/redo → native export (ffprobe frame count) → Motion Templates
  `lower-third@1` → native export with the fframes master → text clip → Remotion export → Program drops →
  fframes render badge.
- `e2e/editing.spec.ts` — workspace chrome, analysis jobs, filmstrip/waveform, Ctrl-drop insert, JKL and
  timecode entry, Ctrl+K, Delete / Shift+Delete, ripple trim, Ctrl-move, snapping, Graphics ▸ Text,
  Properties scrub, Program overlay move/scale.
- `e2e/agent.spec.ts` — an MCP SDK client connected to the built `jasper-mcp` over stdio: `apply_commands`
  while the editor is open (live, `Agent:` History entry and toast), helper tools / `set_playhead` / `undo`,
  an approval-gated `track.remove` denied and then approved on the shell's approval card, Help ▸ Connect an AI
  Agent…, a headless apply with the editor closed, and `open_project_in_editor` bringing the project back.
- `e2e/pwa.spec.ts` — manifest, icons and service worker of the production build.
- `e2e/layer-bake.spec.ts` — footage + static title + keyframed title, a Lumetri grade on a title ("Grade
  pending" → graded preview in the Program), Auto export planned `hybrid` with baked titles, output pixels.
- `e2e/mg-clips.spec.ts` — Remotion page-protocol contract (4.0.499), File ▸ Import Remotion Project… →
  Remotion tab → live host → props edit within 500 ms → preview WebM, and the MCP composition tools.

## Scripts

| Script | Does |
|---|---|
| `pnpm dev` | engine + web together (`concurrently`) |
| `pnpm dev:engine` | `tsx watch apps/engine/src/cli.ts --port 47900` with `JASPER_APPDIR=./.stage JASPER_DEV=1` |
| `pnpm dev:web` | Vite dev server on 5173 with the engine proxy |
| `pnpm dev:desktop` | builds the Electron main/preload and launches it against `JASPER_DESKTOP_DEV_URL` (default 5173) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest (all packages and apps as projects); `FUZZ=1 pnpm test` runs the long property sweeps |
| `pnpm lint` | Biome + design-token and anime.js checks (`scripts/check-tokens.mjs`, `scripts/check-anime.mjs`) |
| `pnpm format` | Biome formatter |
| `pnpm build` | web (`vite build`), engine (`dist/engine.mjs`), desktop (`dist-electron/`), MCP server (`apps/mcp/dist/jasper-mcp.mjs`) |
| `pnpm mcp:build` | only the MCP server: esbuild bundle `apps/mcp/dist/jasper-mcp.mjs` (one executable file) |
| `pnpm mg:build` | cargo release build of `native/mg` (`jasper-mg`); exits 0 without cargo |
| `pnpm fixtures` | generates test media with ffmpeg |
| `pnpm ffmpeg:lgpl` | fetches (Linux, Windows) or builds (macOS) the pinned LGPL FFmpeg 7.1 and assembles the Remotion binaries directory in `vendor/ffmpeg-lgpl/` |
| `pnpm ffmpeg:check [dirs]` | license guard over FFmpeg binaries (default: the vendor directory); `--packaged <dir>` checks a packed app |
| `pnpm --filter @jasper/desktop dist:dir` / `dist` | stages and packs the desktop app (unpacked directory / installers) with the LGPL FFmpeg |
| `pnpm e2e` | builds, then the Playwright suite (`e2e/`) |
| `pnpm e2e:desktop` / `e2e:mg-fallback` / `e2e:typecheck` | Electron smoke / fframes fallback check / `tsc` over `e2e/` |
| `pnpm e2e:desktop-clipboard` | desktop clipboard runtime check under xvfb (`playwright.desktop.config.ts`, `E2E_SKIP_BUILD=1` reuses builds) |
| `pnpm e2e:packaged` | packed-app check: license guard, packed engine with only the shipped LGPL FFmpeg, Remotion export |
| `pnpm verify` | lint + typecheck + test + build |

## Layout

```
apps/web          Vite + React 19 SPA (react-router 7 library mode), PWA
apps/engine       Fastify 5 media engine ("jasperd"), port 47900 in dev
apps/desktop      Electron shell (loads the SPA over HTTP)
apps/mcp          @jasper/mcp — jasper-mcp, the MCP server for external agents (stdio; also served at /mcp)
packages/project  @jasper/project — document schema, commands, invariants, keyframes, render snapshot
packages/session  @jasper/session — EditorSession, history, gestures, transport, persistence
packages/api      @jasper/api — zod contracts for engine routes and events
packages/engine-client, packages/ui, packages/compositions, packages/mg-templates, packages/config
native/mg         jasper-mg (Rust, fframes) motion-graphics renderer
e2e/              Playwright specs + desktop / fframes / packaged-app smoke scripts
scripts/ffmpeg/   LGPL FFmpeg: pinned manifest, fetch/build + assembly, license guard
vendor/           fetched LGPL FFmpeg binaries (gitignored)
.stage/           dev appdir (runtime files are gitignored)
```

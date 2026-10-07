# JasperEditor

A Premiere-style, agent-drivable video editor combining Remotion (preview and graphics renders), native
ffmpeg (probe, proxies, fast export) and fframes motion graphics. Web app, installable PWA and Electron
desktop all load the same SPA and talk to the same local engine. External coding agents (Claude Code, Codex
CLI, Cursor) drive it through its MCP server, `jasper-mcp` (see "Use JasperEditor from Claude Code / Codex /
Cursor" below).

Read `docs/ARCHITECTURE.md` first; functional specs live in `docs/specs/`, research in `docs/research/`.
The M1 acceptance run (every ARCHITECTURE §15 item, with evidence) is in `docs/M1-STATUS.md`; per-package
notes and known gaps are in `docs/wp-notes/`.

**Rules first:** [`AGENTS.md`](AGENTS.md) holds the rules every contributor and agent must follow, and
[`CLAUDE.md`](CLAUDE.md) the working instructions (gate, running the app headlessly, Definition of Done). Never
open, read, grep or copy anything from `.reference/` or `editor-starter.zip` (a paid licence; ARCHITECTURE §0,
D-36). Code ported from permissively licensed projects is welcome, recorded in [`licenses/ported/`](licenses/ported/)
and shipped in `THIRD_PARTY_NOTICES.md`. Where JasperEditor stands against Premiere Pro: [`docs/gaps.md`](docs/gaps.md)
and [`docs/parity.md`](docs/parity.md). Project files, migrations and crash recovery: [`docs/project-files.md`](docs/project-files.md).

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
- Stabilise ▸ **Smooth path (one even move)** (M3, `docs/wp-notes/wp-m3-stabpath.md`): for a shot from a fixed
  position with one sudden reframe / jerk or a slow uneven drift. It tracks the background (people moving
  through the shot are ignored), smooths the camera path (Smoothing = Gaussian sigma in frames, 30 is a good
  start), can lock the vertical path and the rotation to a straight line, and uses ONE fixed zoom for the whole
  shot, capped by *Max zoom* (default 112 %; when the smoothing needs more, the largest smoothing that fits is
  used and the finished-job message says so, with the zoom and the peak camera speed before → after). A clip
  containing a cut is stabilised shot by shot. vid.stab stays the default for handheld jitter.
- De-judder: cadence analysis + flow warp with OpenCV.js (Apache-2.0) in worker threads.
- Denoise/deblock: LGPL FFmpeg filters only (`atadenoise`, `fftdnoiz`, `nlmeans`, `deblock`).
- Upscale: ONNX Runtime (`onnxruntime-node`, MIT) with the bundled SPAN 2× model
  (`apps/engine/models/`, *2xNomosUni_span_multijpg by Philip Hofmann, CC BY 4.0*; conversion:
  `scripts/models/export-span-onnx.py`). Help ▸ About ▸ Licenses lists all of them.
- MCP: `process_clip`, `use_media_version`, `list_processing_models`, `test_remote_executor`, …

### Source ranges: versions that cover a different part of the source

A processed version or a graded render may hold a different source range than the clip's file — only the
part a clip uses plus handles, or a render made for another cut (S07 PRC-015…019,
`docs/wp-notes/wp-m3-inpoint.md`). Every such file records the source frames it holds (`sourceRange`), and
switching a clip between files keeps it on **exactly the same source frames**: the in-point (with keyframes,
clip markers and tracker data) is remapped, the timeline position and duration stay, and trims and transitions
see the handles the new file really has.

- **Process Clip…** from a clip offers *Clip range + handles* (default 12 frames each side): only those frames
  are processed (much faster), and the clip swaps onto the result frame-exactly. *Whole media* is the M2 behaviour.
- **Properties ▸ Media Version** (and the clip menu) lists the original, processed versions and renders that
  declare the same source, with the frames each holds (`Denoised · frames 1088–1231`) and the clip's handles.
  A version that does not hold every frame of the clip asks to trim the clip to the frames it holds.
- **Clip ▸ Replace Footage…** (also in the Project item menu) replaces a media's file for every clip that uses
  it. With a source-range sidecar or matching start timecodes, *Keep source timing* (on by default) moves the
  in-points so the clips keep showing the same source moments; clips the new file does not hold are listed and
  refused, or trimmed on request.
- **Sidecars**: a `<file>.json` or `<stem>.json` next to a rendered file (found by the engine for files imported
  by path; on the web pick it together with the video) with `{"first_src_frame": 174, "frames": 130,
  "source": "crudo.mp4"}` (also the trailer grade pipeline's format with `spec.src` and `handles`, and
  jasper-proc's own sidecar) records the range; when the named source is in the project the file becomes one of
  its versions.
- MCP: `process_clip {handles | range}`, `use_media_version {fit}`, `replace_footage`, `set_media_source_range`;
  `get_media_info` lists the source frames of every version.

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
- `fixtures/mg-project/` is a minimal example (Title with a zod schema, Badge inferred, LowerThird with an
  embedded font and text layers).
- MCP: `import_mg_bundle`, `list_compositions`, `add_composition`, `set_composition_props`,
  `prerender_composition`, `scaffold_mg_project`, `list_composition_texts`, `set_composition_text`.

### Texts inside compositions (hybrid text layers)

Every text a composition exposes gets its own editor in **Properties ▸ Composition ▸ Text** (S08:MGC-036…039,
`docs/wp-notes/wp-m3-mgtext.md`): a multi-line field that updates the Program monitor while you type and lands as
one History step ("Edit Text «…»") when you press Enter (Ctrl+Enter in multi-line texts) or leave the field
(Esc reverts), plus the props that style it — font (the fonts embedded in the bundle), weight, size, colour,
alignment — when the composition has them. **Double-click the text in the Program monitor** to edit it in place,
in the composition's own font (texts that declare the `*accent*` markup show it in the accent colour; a clip
without a live preview slot borrows one for the edit). Warnings tell you when a text is longer than designed, has too many lines, runs off
the frame, is cut off by its box or leaves its safe area (measured in the bundle's own page — and by the engine
for agents, so the MCP text tools return the same warnings). The edit changes the
clip's props, so the cached master is re-rendered and the native export shows the new text.

Which strings are texts: declare them in `jasper.mg.json`
(`"compositions": {"<id>": {"texts": {"<prop.path>": {"label", "multiline", "maxChars", "maxLines", "box": {x, y,
width, height}, "frame", "hint", "accent", "style": {"color": "<prop>", …}}}}}`; `false` hides one), annotate the schema
(`"x-jasper-text": true` — zod 4 `.meta({'x-jasper-text': true})`), hint `ui.<prop>.control: "text" | "textarea"`,
or just use plain string props. Style props are found by convention — a text object
`{headline: {text, color, fontSize, fontFamily, fontWeight, align}}` or prefixed siblings `title` + `titleColor`,
`titleSize`, `titleFont`, `titleAlign`… — or named in the manifest's `style`. Copy written in code becomes editable by
moving it into a prop with the old text as its default (see the wp-notes for the MatsSmile caption shots).

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
- The determinism suite (`packages/motion/test/determinism.test.tsx`) checks every registered text animator's
  values in order, reversed and shuffled against a fresh build per frame. The opt-in Chrome suite renders the
  real sequence with installed anime templates and checks parity (stills vs `renderFrames`/`renderMedia` at
  concurrency 1 and 4, reversed and shuffled visits, Player vs still) and the
  value-engine cost run with
  `REMOTION_E2E=1 pnpm exec vitest run packages/motion/test/determinism-render.e2e.test.ts`
  (Chrome at `/usr/bin/google-chrome` or `JASPER_BROWSER_EXECUTABLE`).
- `pnpm notices` regenerates `THIRD_PARTY_NOTICES.md` (the JavaScript packages shipped in the web app and the
  Remotion bundle, with their licence texts, and every ported-source record in `licenses/ported/`); `pnpm notices
  --check` fails when it is stale (a test runs it).
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

Tools (202; `apps/mcp/test/readme-tools.test.ts` keeps this list in sync with the server):
- Core: `engine_status` · `list_projects` `create_project` `get_project` `open_project_in_editor` ·
  `import_media` `list_media` `get_media_info` · `describe_commands` `apply_commands` `undo` `redo` ·
  `add_clip` `move_clip` `trim_clip` `split_at` `delete_clips` `add_text` `add_marker` `add_motion_graphic`
  `add_transition` · `get_timeline` `render_frame` `get_playhead` `set_playhead` · `list_motion_templates`
  `render_motion_graphic_preview` · `list_export_presets` `start_export` `get_job` `cancel_job` `wait_for_job`.
- Colour: `import_lut` `grade_clip` `get_grade` `copy_grade`.
- Clip processing: `list_processing_models` `install_processing_model` `process_clip` `use_media_version`
  `get_processing_settings` `set_processing_settings` `test_remote_executor` `replace_footage`
  `set_media_source_range`.
- Remotion projects: `import_mg_bundle` `list_compositions` `add_composition` `set_composition_props`
  `prerender_composition` `scaffold_mg_project` `list_composition_texts` `set_composition_text`.
- Tracking: `add_tracker` `track` `apply_tracking` `get_tracker` `set_corner_pin` `simplify_keyframes`.
- Masks and track mattes: `list_masks` `add_mask` `edit_mask` `remove_masks` `track_mask` `auto_trace_mask`
  `set_track_matte`.
- Transitions: `list_transitions` `list_transition_types` `update_transition` `remove_transitions` `apply_default_transitions`
  `set_transition_defaults`.
- Animation and graphics: `list_text_animations` `set_text_animation` `render_frames` `set_motion_graphic_params`
  `add_shape` `get_motion_path` `set_spatial_interpolation`.
- Vector shapes: `add_vector_shape` `svg_to_shape` `list_shape_presets` `get_shape` `add_shape_items`
  `update_shape_item` `remove_shape_items` `move_shape_item` `group_shape_items` `duplicate_shape_item`
  `edit_shape_path` `convert_shape_to_vector`.
- Effect presets: `list_effect_presets` `get_effect_preset` `apply_effect_preset` `save_effect_preset`
  `delete_effect_preset`.
- Clipboard: `copy_clips` `paste_clips` `copy_items` `paste_items`.
- Blend modes: `list_blend_modes` `set_blend_mode` (Premiere's 27 + After Effects' stencils, `docs/wp-notes/keyframes-blend.md`).
- Keyframes and presets: `get_motion_path` `set_spatial_interpolation` `set_roving` · `list_effect_presets` `get_effect_preset`
  `save_effect_preset` `apply_effect_preset` `delete_effect_preset`.
- Media cache: `get_cache_usage` `clean_cache` `set_cache_location`.
- Edit structure: `nest_clips` `unnest_clips` `place_sequence` `list_nests` `add_adjustment_layer` `group_clips`
  `ungroup_clips` `duplicate_sequence` `delete_sequence` `remove_unused_media` `create_synthetic` `update_synthetic`
  `list_through_edits` `join_through_edits` `find_gaps` `make_subsequence` `add_frame_hold`
  `insert_frame_hold_segment` `frame_hold_options` (`docs/wp-notes/edit-structure.md`).
- Synchronize, Merge Clips, multi-camera: `measure_audio_sync` `synchronize_clips` `merge_clips`
  `create_multicam_sequence` `switch_multicam_angle` `record_multicam_cuts` `set_multicam_enabled` `flatten_multicam`
  `edit_multicam_cameras` `get_multicam` (`docs/wp-notes/multicam.md`).
- Versions and recovery: `list_project_versions` `restore_project_version` `save_project_copy` `list_unsaved_changes`
  (docs/project-files.md).
- Audio buses and loudness: `measure_loudness` `get_mixer` `set_mixer_strip` `add_submix` `add_send` `write_automation`
  `set_audio_gain` `auto_duck` `set_loudness_normalization` `normalize_media_loudness` (`docs/wp-notes/audio-mix.md`).
- Audio effects, Essential Sound and Remix: `list_audio_effects` `get_audio_effects` `add_audio_effect` `set_audio_effect`
  `remove_audio_effect` · `get_essential_sound` `set_essential_sound` `clear_essential_sound` `auto_match_loudness`
  `generate_essential_ducking` · `remix_audio` `revert_remix` (`docs/wp-notes/audio-fx.md`).
- Captions and transcripts: `import_captions` `export_captions` `list_captions` `add_caption` `edit_caption`
  `split_captions` `merge_captions` `delete_captions` `style_captions` `caption_track` · `import_transcript`
  `transcript_inspect` `transcript_search` `transcript_select` `transcript_extract` `transcript_lift`
  `insert_transcript_selection` `remove_fillers` `remove_pauses` `rename_speaker` `captions_from_transcript`
  (`docs/wp-notes/captions.md`).
- Speech to text (local Whisper): `list_speech_models` `install_speech_model` `remove_speech_model` `transcribe`
  `get_transcript` (`docs/wp-notes/speech.md`).
- Timeline interchange (Final Cut Pro 7 XML, FCPXML, OpenTimelineIO, CMX 3600 EDL, AAF, OMF, Avid ALE) and Link Media:
  `import_timeline` `export_timeline` `list_offline_media` `link_media` (`docs/wp-notes/interchange.md`).
- Reading properties: `get_clip_properties` `get_param` (the keyframed value next to the value actually rendered).
- Live UI of the open editor window (web or desktop): `ui_state` `ui_elements` `ui_screenshot` `ui_click` `ui_drag`
  `ui_scroll` `ui_key` `ui_type` `ui_set` `ui_locate` `ui_hit` `ui_commands` `ui_command`
  (`docs/wp-notes/mcp-cli.md`).
- Expressions: `set_expression` `clear_expression` `enable_expression` `test_expression` `get_property_values`
  `list_expression_properties` `list_expression_presets` `add_expression_control` (`docs/expressions.md`,
  `docs/wp-notes/expressions.md`; the language reference is also the `jasper://guide` resource).

Resources: `jasper://projects/{projectId}/document`, `jasper://projects/{projectId}/timeline`,
`jasper://guide`. Prompt: `edit-video`.

The engine also serves the same tools over MCP Streamable HTTP at `/mcp`, for clients that connect by URL.
With a dev or standalone engine (no token): `claude mcp add --transport http jasper http://127.0.0.1:47900/mcp`.
The desktop engine needs `Authorization: Bearer <token>` and issues a new token on every launch, so use the
stdio server there.

The packaged desktop app ships the server as `resources/mcp/jasper-mcp.mjs`. It has no `node`: Help ▸ Connect
an AI Agent… gives the command that runs the bundle with the app's own binary (`ELECTRON_RUN_AS_NODE=1`).

**Developing JasperEditor itself:** this checkout's root [`.mcp.json`](.mcp.json) registers `jasper` for agents
working *on* the editor. It runs the server from source (`node --import tsx apps/mcp/src/cli.ts`, no build needed)
with `--start-engine --appdir .stage`: it uses the `pnpm dev` engine when one is running, and otherwise starts a
headless engine on the same dev appdir (that needs `pnpm --filter @jasper/engine build` once). Claude Code asks
once before enabling a project-scoped server; start it from the repository root so the relative paths resolve.

### Conventions every tool follows

- **Strict arguments.** An unknown argument key — at the top level or inside any nested object, and inside the
  commands of `apply_commands` — is an error that names the key, lists the accepted ones and suggests the likely
  typo (`E_UNKNOWN_ARGUMENT`: `"jobid" → "jobId"?`), never a silently dropped key. A temp ref used before it was
  declared names the refs declared so far.
- **Annotations.** Every tool has a title and all four hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`), so a client can run the read-only ones without asking (`apps/mcp/test/conventions.test.ts`).
- **Progress and cancellation.** Long calls (`start_export {wait: true}`, `wait_for_job`, `render_frame(s)`,
  processing, tracking, pre-renders) send `notifications/progress` at most every 100 ms when the request has a
  `progressToken`; `notifications/cancelled` cancels the engine job, and the engine deletes the job's partial
  output (including a half-copied file at the export destination).
- **Property reads.** `get_clip_properties` / `get_param` return `value` (the keyframed value at a time, as
  Effect Controls shows it) next to `evaluated` (what the renderer draws then), keyframes in sequence frames and
  the `param.set` target; `rendered: false` + `why` when that frame draws nothing.

### Live UI: look at and operate the editor window

With a project open in the web app or the desktop app, `ui_state`, `ui_elements`, `ui_screenshot`, `ui_click`,
`ui_drag`, `ui_scroll`, `ui_key`, `ui_type`, `ui_set`, `ui_locate`, `ui_hit`, `ui_commands` and `ui_command`
drive the window itself through the engine relay (`POST /api/agent/ui` → WS `/agent`). Elements have stable
automation ids (`timeline-toolbar/button[Snap in Timeline]`, `timeline.clip.<id>`, `effectControls.fx.<id>`…);
`ui_locate` / `ui_hit` map timeline frames ↔ x and tracks ↔ y, and Program monitor sequence pixels ↔ window
points, so `ui_drag {from: {timeline: {clipId}}, to: {x, y}}` moves a clip like a user. `ui_commands` lists every
UI command with `enabled` and, when disabled, `why`. `e2e/ui-audit.spec.ts` keeps every interactive element of
every panel in every workspace addressable. Details: `docs/wp-notes/mcp-cli.md`.

### Command line: `jasper`

Every tool is also one shell call away. `pnpm jasper <command>` from this checkout, or the bundled
`node apps/mcp/dist/jasper.mjs` after `pnpm mcp:build`. It finds the engine like `jasper-mcp` (`--engine-url`,
`--appdir`, `--start-engine`), and edits apply live when the project is open in an editor window.

```bash
jasper status                                    # engine and capabilities
jasper projects                                  # ids and names
jasper --project Teaser import a.mp4 b.mp4       # relative paths are fine
jasper exec marker.add frame=30 name=Intro       # one command, one undo step (k=v values are JSON when they parse)
jasper exec '{"type":"clip.addText","at":0,"duration":90,"track":"V2","content":{"text":"Hi"}}'
jasper run edit.jsonl                            # a command or {"commands": [...]} per line; JSON line per result
jasper describe clip.place                       # schema and an example
jasper props clp_123 --at 2s                     # value, evaluated, keyframes
jasper get clip/clp_123/opacity --at 45          # one parameter
jasper set clip/clp_123/transform.position '[640,200]'
jasper inspect                                   # the timeline table (--json: the sequence summary)
jasper render-frame --at 00:00:02:00 --out f.png --width 960
jasper export --out cut.mp4 --range 0..10s       # waits with progress; Ctrl+C cancels and deletes the file
jasper ui elements panel=timeline                # the live window (ui click id=…, ui screenshot --out w.png)
jasper call get_mixer --json                     # any MCP tool
```

`--json` prints one JSON document per line; exit status 0 = ok, 1 = the command failed (its error code, message
and hint on stderr), 2 = usage error. `jasper --help` is the reference.

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

On the timeline the plate shows a tracker badge and a confidence strip per tracker (green / amber / red, lost frames marked; hover a frame for its confidence), and the clip that follows shows a link glyph. Click either to jump to the tracker in Properties ▸ Tracking.

Tracking bakes one keyframe per frame. **Simplify…** (Properties ▸ Tracking, the Corner Pin editor, Clip ▸ Simplify Keyframes…, or right-click keyframes in Effect Controls — it works on any keyframed parameter) keeps only the keys needed to stay within a tolerance at every frame: in pixels of the picture for Motion and Corner Pin, in the parameter's units otherwise. The dialog previews the result live with the key count and the measured deviation; Apply is one undo step. The Apply Tracking dialog can simplify in the same step.

Corner pins and keyframed Motion export on the native ffmpeg path through the warp stage: an LGPL-safe per-frame warp, cached as ProRes 4444 under `<appdir>/cache/warp/`.

Agents use the `add_tracker`, `track`, `apply_tracking`, `get_tracker`, `set_corner_pin` and `simplify_keyframes` MCP tools. Tracking runs OpenCV.js (Apache-2.0) in engine worker threads. Details: `docs/specs/09-tracking.md`, `docs/wp-notes/wp-m2-track.md` and `docs/wp-notes/wp-m3-trackui.md`.

## Masks and track mattes

Premiere-style masks (`docs/wp-notes/masks.md`):

1. Select a clip. In **Effect Controls ▸ Opacity** (to cut the layer out) or under any video effect (to limit the
   effect to a region) click the **ellipse**, **4-point polygon** or **free draw bezier** (pen) tool. The pen draws in
   the Program monitor: click to add points, drag for curves, click the first point to close. The **trace** button
   creates masks from the picture's alpha or luminance (holes become Subtract masks).
2. Edit on the Program monitor: drag vertices (Shift adds to the selection), tangent handles (Alt breaks them), the
   inside of the mask (moves it), the corner squares (scale) or just outside them (rotate); click the path to add a
   vertex, **Alt**-click a vertex to convert it smooth ↔ corner, **Ctrl**-click to delete it; the square and circle
   handles set **Mask Expansion** and **Mask Feather**. **Delete** removes the selected vertices or the mask.
3. Each mask has **Mask Path**, **Mask Feather**, **Mask Opacity**, **Mask Expansion** (all keyframable), **Inverted**
   and a mode (Add, Subtract, Intersect, Lighten, Darken, Difference, None). Paths with different vertex counts
   interpolate through smart vertex matching.
4. **Track** (◀◀ ◀ ▶ ▶▶ in the mask's tracking row): follows the pixels inside the mask (Position; Position &
   Rotation; Position, Scale & Rotation; Perspective) and keys its path. Progress shows there and in the Jobs panel;
   ■ stops it.

**Track Matte Key** reads another video track (Matte = Video n; Composite Using: Matte Alpha / Matte Luma; Reverse).
Hide the matte track (its eye) and it still works as a matte.

Preview: a GPU mask rasteriser in the fx chain (analytic coverage and feather). Export: Opacity masks stay native (the
sub-pixel kernel multiplies the picture by the same coverage); effect masks and track mattes render the layer through
the layer bake (hybrid). Agents use `list_masks`, `add_mask`, `edit_mask`, `remove_masks`, `track_mask`,
`auto_trace_mask` and `set_track_matte`, or the `mask.*` commands.

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
- **Vector shapes** (After Effects-style shape layers, `docs/wp-notes/shapes.md`): nested groups with transforms;
  rectangle, ellipse, polystar and free Bézier paths; solid and gradient (linear / radial with highlight) fills and
  strokes with dashes, taper and wave; the path operators Trim Paths, Repeater, Offset Paths, Round Corners, Zig Zag,
  Twist, Wiggle Paths, Pucker & Bloat and Merge Paths (curve-preserving booleans); every blend mode. **Properties ▸
  Shape Contents** is the layer list (add, group, reorder by drag, enable, rename) with the selected item's
  properties and a gradient editor; **Effect Controls ▸ Contents** keyframes every property. Tools: Pen (draw, add /
  delete / convert vertices), Rectangle, Ellipse, Polygon, Star; vertices of path items are edited on the Program
  monitor. Presets, SVG → shape (`svgToShapeContents`), and Graphics ▸ Convert to Vector Shape.

## Transitions and their defaults

Drag a transition from Effects ▸ Video Transitions / Audio Transitions onto a cut, or use the default-transition
keys: **Ctrl+D** (video), **Ctrl+Shift+D** (audio), **Shift+D** (both, on the selected clips) — also in the
Sequence menu and the clip menu (Apply Default Transitions). **Sequence ▸ Transition Defaults…** (= Edit ▸
Preferences ▸ Timeline) sets what they create:

- *Default transitions — this computer* (a user preference, not in the project, not in History): the default
  video and audio transition (also "Set Selected as Default Transition" in the Effects panel and the transition
  context menu; the default has a blue outline in the Effects panel) and the alignment of transitions between two
  clips (Center / Start / End at Cut).
- *Default durations — this project* (saved with the project; each change is one History step): video
  transition, audio transition and still image default durations, in frames or seconds (seconds are converted at
  the active sequence's frame rate and rounded to whole frames).

Agents use the same defaults: `apply_default_transitions` takes the editor's default types and alignment when the
project is open in the editor (otherwise cross dissolve / constant power / center, or what the call passes), and
`set_transition_defaults` changes the project's durations.

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
  test/layer-bake-parallel.e2e.test.ts` (the second compares parallel and sequential bakes byte for byte);
  Playwright: `e2e/layer-bake.spec.ts`.

## Media cache

The engine keeps everything it can make again — waveforms, posters, filmstrips, keyframe indexes, proxies, baked
colour LUTs, warped layers (tracking / keyframed Motion), graphics bakes, motion-graphics renders, export outputs,
rendered frames, build caches — in one cache under the appdir. **Edit ▸ Preferences ▸ Media Cache…** shows how much
each kind uses, split into *in use* (running exports, projects open in an editor, files written in the last minutes),
*used by saved projects* and *unused*:

- **Clean Unused** removes what no project uses (like Premiere's *Delete Unused*).
- **Clean All (not in use)…** also removes what saved projects use; it is made again when needed (the first preview
  or export of such a project is slower). What open projects and running exports use is always kept.
- **Automatic cleaning** (at start-up, every hour and after renders): unused files older than 30 days (graphics bakes
  and motion-graphics renders 14, export outputs 7, rendered frames 1), then the least recently used unused files
  while the cache is over its size limit (automatic: 25 GB or 15 % of the free disk, whichever is smaller; or a custom
  limit; per-kind limits in the table). Files saved projects use are never removed automatically.

**Location** (Change…): the cache can live on another disk — pick a folder, Check it (writable, free space), then
*Move the existing cache there* (instant on the same disk, copied with progress otherwise) or *Start a new, empty
cache there*; Move Back to Default returns it to the data folder. The move waits for running jobs. Days per kind may
be `never`. Engine logs and the job history are not cache; they are kept 30 days / 256 MB by default (same table).

Keyframed grades write one LUT per distinct state; identical tables share one file (content-addressed). Removal is
crash-safe (rename to `.trash-*`, then delete; leftovers of interrupted writes are swept). Agents use
`get_cache_usage`, `clean_cache` and `set_cache_location`; scripts `GET /api/cache`, `POST /api/cache/clean
{"mode":"unused"|"all"}`, `GET/PUT /api/cache/settings` and `POST /api/cache/location[/check]`. Details:
`docs/specs/04-media-render-and-backend.md` §7.5 (CA-010…021),
`docs/wp-notes/wp-m3-cachegc.md`.

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

The MCP scenario QA suite (`pnpm qa:mcp`, also run with `REMOTION_E2E=1`; `apps/mcp/test/qa/`) builds real
edits only through `jasper-mcp` over MCP JSON-RPC against a real engine — a rough cut, a colour grade, titles, a
cross dissolve, keyframed opacity and position, an export re-imported into another project, and a cancelled
export — and asserts on rendered pixels (coverage, centroid, luma, mean difference) and on the written files.
`MCP_QA_PORT` picks the engine port (49025), `MCP_QA_KEEP=1` keeps the frames in `test-results/mcp-qa/`.
`apps/mcp/test/jasper-cli.test.ts` runs every `jasper` command against a real engine.

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
- `e2e/agent-ui.spec.ts` — the live-UI tools through the built `jasper-mcp`: `ui_state`, `ui_elements`, timeline and
  Program coordinate mapping, a clip dragged by `ui_drag` and undone with `ui_key Cmd+Z`, `ui_set` on a scrubby
  number, `ui_commands` / `ui_command` (workspaces), `ui_screenshot` of the window and of a panel.
- `e2e/ui-audit.spec.ts` — every interactive element of every panel in every workspace, the menu bar menus and the
  clip context menu has a stable automation id.
- `e2e/pwa.spec.ts` — manifest, icons and service worker of the production build.
- `e2e/layer-bake.spec.ts` — footage + static title + keyframed title, a Lumetri grade on a title ("Grade
  pending" → graded preview in the Program), Auto export planned `hybrid` with baked titles, output pixels.
- `e2e/mg-clips.spec.ts` — Remotion page-protocol contract (4.0.499), File ▸ Import Remotion Project… →
  Remotion tab → live host → props edit within 500 ms → preview WebM, and the MCP composition tools.

## Performance measurements

`pnpm perf` runs the synthetic hot-path benchmarks sequentially. Each benchmark also runs directly with
`pnpm exec tsx <path>`; its adjacent JSON records the original revision, workload, before/after results,
and methodology. Run `node scripts/measure-web-bundle.mjs [dist-directory]` after a production web build
to measure initial and total JavaScript bytes, including gzip sizes.

The October 2026 audit ranked these five opportunities by expected impact and implementation risk:

| Rank | Critical path and wasted work | Implemented change and measured evidence |
|---|---|---|
| 1 | Preview/export snapshot creation scanned all clips separately for each track | Group clips once per snapshot; 4,800 clips / 48 tracks: 107.557 → 9.262 ms CPU per full snapshot ([results](packages/project/bench/render-snapshot.results.json)) |
| 2 | Every edit and undo enumerated the whole document to validate a small selection | Probe selected IDs; retain bulk indexing for dense selections. One selected clip out of 10,000: 3.525 → 0.00987 ms CPU ([results](packages/session/bench/selection-results.json)) |
| 3 | Timeline viewport and pointer queries scanned every transition on a track | Indexed interval candidates; 10,000 transitions: viewport query 144.455 → 0.409 µs wall time ([results](apps/web/bench/timeline-transitions.measurements.json)) |
| 4 | Cache usage/cleanup classification checked every project for every cache entry | Build reference indexes once per scan; 30 projects / 3,000 entries: 76.732 → 3.160 ms CPU, including construction ([results](apps/engine/bench/cache-references.results.json)) |
| 5 | Home downloaded the docking workspace before any project opened | Load the editor alongside its project session; initial JavaScript 878,226 → 757,117 gzip bytes (13.79% reduction), measured with `scripts/measure-web-bundle.mjs` |

An additional playback improvement shares the existing immutable clip-props cache between scene resolution
and the compositor, avoiding repeated effect-parameter scans. The 32-layer fixture with one Lumetri grade
per layer measured 10.577 → 1.431 µs CPU per scene frame
([results](packages/project/bench/scene-props.results.json)). Snapshot outputs were compared with the
original implementation; scene props were compared with uncached evaluation.

These are isolated function/build measurements on Node 20.20.2, not whole-editor FPS or export throughput
claims. The shared host was busy, so process CPU medians accompany wall timings where available.
Dense selections across 100 sequences remained at parity. Transition indexing adds 8 bytes per transition
and some build work (the 10,000-transition cold build measured 35.087 → 52.463 ms wall time); the extra work
is amortized by repeated viewport/pointer queries. Cache reference indexes are temporary per scan.

The editor split defers its first download until a project opens. A previously visited editor still reloads
offline through the service worker; opening the editor offline after caching only Home now needs an initial
online visit. Failed editor downloads provide a reload action. Production browser tests cover both paths.

Audit validation: lint, workspace and E2E typechecks, all application builds plus the Remotion bundle,
and `pnpm perf` passed. The full Vitest run verified 1,283 tests with 33 skips after four default
five-second timeouts passed on targeted reruns using `--testTimeout=120000 --hookTimeout=120000`.
All 30 production Playwright checks in `smoke`, `editing`, `transitions`, `media-cache`, `pwa`, and
`bundle-loading` passed, including native/Remotion exports and offline reload.

## Scripts

| Script | Does |
|---|---|
| `pnpm dev` | engine + web together (`concurrently`) |
| `pnpm dev:engine` | `tsx watch apps/engine/src/cli.ts --port 47900` with `JASPER_APPDIR=./.stage JASPER_DEV=1` |
| `pnpm dev:web` | Vite dev server on 5173 with the engine proxy |
| `pnpm dev:desktop` | builds the Electron main/preload and launches it against `JASPER_DESKTOP_DEV_URL` (default 5173) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest (all packages and apps as projects); `FUZZ=1 pnpm test` runs the long property sweeps |
| `pnpm perf` | Sequential snapshot, scene, selection, timeline-transition, and cache-reference microbenchmarks |
| `pnpm lint` | Biome + design-token, anime.js, dependency-layer and asset-attribution checks (`scripts/check-tokens.mjs`, `scripts/check-anime.mjs`, `scripts/check-layers.mjs`, `scripts/check-assets.mjs`) |
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
| `pnpm notices` / `--check` | regenerates / verifies `THIRD_PARTY_NOTICES.md`: shipped npm packages plus every `licenses/ported/*.md` record and its licence text (Help ▸ About ▸ Licenses) |

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

# JasperEditor

A Premiere-style, agent-drivable video editor combining Remotion (preview and graphics renders), native
ffmpeg (probe, proxies, fast export) and fframes motion graphics. Web app, installable PWA and Electron
desktop all load the same SPA and talk to the same local engine. External coding agents (Claude Code, Codex
CLI, Cursor) drive it through its MCP server, `jasper-mcp` (see "Use JasperEditor from Claude Code / Codex /
Cursor" below).

Read `docs/ARCHITECTURE.md` first; functional specs live in `docs/specs/`, research in `docs/research/`.
The M1 acceptance run (every ARCHITECTURE §15 item, with evidence) is in `docs/M1-STATUS.md`; per-package
notes and known gaps are in `docs/wp-notes/`.

**Rules first:** [`AGENTS.md`](AGENTS.md) is the operating manual for contributors and coding agents. Never
open, read, grep or copy anything from `.reference/` or `editor-starter.zip` (a paid licence; ARCHITECTURE §0,
D-36). Code ported from other projects is welcome, recorded in [`licenses/ported/`](licenses/ported/)
and shipped in `THIRD_PARTY_NOTICES.md`. Where JasperEditor stands against Premiere Pro: [`docs/gaps.md`](docs/gaps.md)
and [`docs/parity.md`](docs/parity.md). Project files, migrations and crash recovery: [`docs/project-files.md`](docs/project-files.md).

## What it does

A summary of the product as it stands; the feature-by-feature checklist with evidence is
[`docs/parity.md`](docs/parity.md) (≈ 98% of our Premiere catalogue exists), and what that number does *not* say —
nobody outside has used it, only Linux was checked — is [`docs/gaps.md`](docs/gaps.md).

- **Editing.** Tracks with linked audio and video, targeting, sync lock; insert, overwrite, lift, extract, ripple,
  roll, slip, slide, razor; three- and four-point edits from the Source monitor; markers; nested sequences,
  adjustment layers, groups, subclips; multi-camera with live switching; speed, time remapping, frame blending and
  optical flow; undo history with a History panel; Premiere's default shortcuts and a shortcut editor.
- **Media.** Everything the LGPL FFmpeg decodes, image sequences, layered PSD, PDF / Illustrator, SVG, Lottie,
  EXR / DPX / HEIC / JPEG XL, glTF models, Remotion projects as clips. A Media Browser panel over the engine's disks
  with previews and in-place import; proxies; relinking; Project Manager (collect / consolidate); a managed media
  cache.
- **Effects and graphics.** 385 video effects and 172 video transitions on the GPU, 60 audio effects and 3 audio
  transitions; keyframes with value and velocity graphs and motion paths; masks with tracking, roto (SAM 2.1), point,
  planar and 3D camera tracking; text with After Effects-style animators, vector shapes with path operators, 3D
  layers, cameras and lights; expressions in a QuickJS sandbox; motion-graphics templates (fframes, anime.js);
  Essential Graphics with responsive design and rolls.
- **Colour.** Lumetri-style grading (curves, wheels, HSL secondary, vignette, Colour Match), scopes, LUTs, colour
  management with log inputs, Rec. 2100 PQ / HLG working spaces, OCIO configs and HDR export.
- **Audio.** Track and clip mixers with automation, submixes and sends, loudness metering and normalisation
  (BS.1770 / EBU R128), Essential Sound, ducking, remix; one DSP for preview and every export path.
- **Sound design.** A licensed, offline Sound Library (a bundled Kenney CC0 starter kit, downloadable CC0 packs, your own
  folders with a licence you declare) searched by measured descriptors, auditioned in context and inserted with its peak on
  the frame to the sample; cues derived from the edit (cuts, transitions, keyframed motion, text animators, measured
  picture motion, scene cuts, music beats) on a Cue Seam; Auto Sound Pass proposes a whole pass you review on the
  timeline and apply as one undo step; sound-effect levels solved against the bed, stop-before dips, builds, a shared
  room reverb, delivery presets (−14 / −16 / −23 / −24 LUFS); Sound Check measures the delivered mix (sync, loudness,
  masking, clicks, edges, harshness, coverage, endings…) with safe fixes; ambience beds and room tone; music drops
  landed on a frame; credits next to the export; an optional local describe-it search. Agents drive all of it and
  cannot hear: they get descriptors, pictures and a written listening log ([`docs/specs/12-sound-design.md`](docs/specs/12-sound-design.md),
  [`docs/wp-notes/sound-design.md`](docs/wp-notes/sound-design.md)).
- **Captions and speech.** Caption tracks (SRT, VTT, SCC, MCC, STL, TTML), burn-in, local speech to text with
  word timings and diarization, text-based editing, a personal glossary of names the recogniser gets wrong
  (Edit ▸ Preferences ▸ Transcription ▸ Glossary: search, edit, import and export JSON). Paste the video script once
  (Text ▸ Transcript ▸ Script…) and Fix Transcript… corrects recognition errors in the transcript and the subtitles
  made from it: the audio decides each fix, the fixes are reviewed as text diffs in the Review panel and applied as
  one undo step; after a manual word fix the editor offers "Replace all N" and "Remember"; Transcribe can carry the
  script's and the glossary's names into the recogniser ("Names from").
- **Export and interchange.** A planner routes each sequence to the native FFmpeg path, a hybrid layer bake or
  Remotion and refuses by name what a path cannot render; H.264, HEVC, VP9, AV1, ProRes, alpha, animated GIF and
  audio-only WAV / FLAC / M4A; platform delivery presets; render previews and smart rendering; FCP 7 XML, FCPXML,
  EDL, AAF, OMF, ALE and OTIO in both directions.
- **Agents.** `jasper-mcp` exposes 450 tools and the whole command catalogue, advertised as a 32-tool core with the
  rest in toolsets loaded on demand; every edit is an undoable transaction, destructive ones need the user's approval
  in the editor; a `jasper` CLI; tools that look at and operate the live window. Agents read footage as text (a packed
  phrase digest of every take, takes of the same line grouped across files) and look at any media or sequence range
  in one picture (filmstrip, waveform, words, silences); their rough cut arrives as a reviewable proposal whose edits
  carry beat, quote and reason; exports report measured verification and platform delivery checks
  ([spec 18](docs/specs/18-agent-footage-editing.md)). The user states the video's goal once (Home ▸ Describe your
  video, Sequence ▸ Brief…) and watches agents in the Agent Activity panel and the header status chip.
- **Safety net.** Atomic saves, single-writer leases (a reloaded tab keeps its own), crash-recovery journal, saved
  versions, schema migrations; golden frames, fuzzed loaders and a security review
  ([`docs/security-review.md`](docs/security-review.md)).
- **Interface.** Docked panels and workspaces, command palette, Preferences, English and Spanish (switched without
  a restart), high-contrast theme; web, installable PWA and Electron from one SPA.

Not there: native `.prproj`, Adobe services and plug-ins, VST / AU audio plug-ins, camera RAW, HDR display output,
macOS and Windows builds that have ever been run ([`docs/gaps.md`](docs/gaps.md)).

## Requirements

- Node 20.19+ (tested on 20.20), pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)
- ffmpeg/ffprobe on `PATH` (system 6.x is fine) for fixtures, and for the engine until the LGPL build is
  fetched. The encoder selector (`apps/engine/src/tools/encoders.ts`, ARCHITECTURE D-13) picks usable
  hardware H.264, then libopenh264, then libx264 (only in GPL dev builds), and otherwise falls back to
  AV1/VP9. x264 is never required; `JASPER_FFMPEG_LGPL_ONLY=1` makes a GPL system build behave like the
  shipped one.
- The LGPL FFmpeg that ships with the app: `pnpm ffmpeg:lgpl` (see "FFmpeg (LGPL)" below). Dev works without
  it; `pnpm e2e`, packaged builds and any non-dev engine need it for the Remotion render path.
- Optional: cargo for the `jasper-mg` motion-graphics renderer (`pnpm mg:build`, also run by `pnpm e2e` when
  cargo is installed; without it motion graphics export through Remotion and the native motion-graphic smoke
  test skips with that reason).
- E2E: Google Chrome at `/usr/bin/google-chrome` (Playwright `channel: 'chrome'`); desktop smoke: `xvfb-run`.
- GPU WebGL for the render browser: layer bakes (titles, shapes, animated text) and Remotion renders draw in a
  headless Chrome. At start-up the engine tries Chrome's default and then `angle-egl`, `angle`, `egl` and `vulkan`
  (on Linux only when a GPU device node exists). It keeps the first back end that reaches the GPU and falls back to
  SwiftShader (the CPU) only when none does. The engine log line `graphics render on the GPU (…)`,
  `render.remotionGraphics` in `/api/capabilities` (`engine_status`, `jasper status`) and Help ▸ About name the
  renderer. In software the export plan warns `GRAPHICS_SOFTWARE`: a bake can then take hours instead of minutes.
  On Linux, Chrome's default is SwiftShader in headless mode. Over SSH (no `DISPLAY`) `angle` (desktop GL) has no
  WebGL2, but `angle-egl` and `vulkan` can still reach an NVIDIA GPU (measured on an RTX 3080 Ti, driver 595.99.02).
  If the log still says software, start the engine from a terminal inside the desktop session, or give it the
  session's environment (`DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`; they can be read
  from `/proc/<pid of plasmashell or gnome-shell>/environ`). `JASPER_REMOTION_GL=angle-egl` (or `angle`, `vulkan`,
  `swangle`, `default`, `off`) forces one back end and skips the search.

## Quick start

```bash
pnpm install
pnpm fixtures        # fixtures/media/{clip-a.mp4, clip-b.mp4, tone.wav, still.png, phone-rot90.mp4}
pnpm mg:build        # optional: native/mg → jasper-mg (fframes); the engine then reports fframes: ready
pnpm ffmpeg:lgpl     # optional in dev: the LGPL FFmpeg + Remotion binaries directory (vendor/ffmpeg-lgpl/)
pnpm dev             # engine on http://127.0.0.1:47900 + web on http://127.0.0.1:5173 (proxied, same origin)
```

Updating a checkout that runs `pnpm dev`: stop it first (`tsx watch` would restart the engine halfway through the
file changes), fast-forward, `pnpm install --frozen-lockfile`, then rebuild what git does not track:
`pnpm mcp:build` when the `jasper` CLI or `jasper-mcp` runs from `apps/mcp/dist` (restart registered MCP servers
afterwards: a running one keeps the old client), and `pnpm --filter @jasper/engine build` only for remote processing
or packaged-like runs (the dev engine runs its workers from source; remote hosts receive the `apps/engine/dist`
bundles). Reload open editor windows after the restart.

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

Type in place on the Program monitor: the Type tool places a caret, double-clicking a text clip edits it, Esc or a click
away commits, and the whole entry is one undo step. IME composition works, and a look draws the letters as you type.
Selecting text in place shows a toolbar for per-word and per-letter styles. Properties sets a text vertical (right-to-left
columns, with short runs upright) and bends it with Warp Text: the 15 Photoshop styles, keyframable, after the look so its
rims bend with the letters (`docs/wp-notes/title-looks.md` "Text").

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

## Text animators (After Effects style)

Text clips also take AE-style **animators** (`docs/wp-notes/text-animators.md`): Effect Controls ▸ Text ▸
**Animate ▸** adds an animator with any of position, anchor, scale, skew, rotation (per-character 3D X/Y/Z),
opacity, fill / stroke colour (RGB, hue, saturation, brightness, opacity), stroke width, tracking, line anchor, line
spacing, character offset / value, blur and variable font axes; **Add ▸** adds Range, Wiggly and Expression
selectors (combine modes add / subtract / intersect / min / max / difference). Animator presets (typewriter,
fades by character / word, slides, pop, bounce, scramble / decoder, tracking, blur, 3D flip / fly, wave, jitter,
the In/Out presets re-expressed) apply from the same menu. Text follows a mask path (**Path**: a mask with mode
None; reverse, perpendicular, force alignment, first / last margin). Character and Paragraph settings (kerning
metrics / optical / manual, baseline shift, tsume, faux bold / italic, small caps, super / subscript, ligatures,
OpenType features, variable font axes, justification, indents, paragraph spacing, per-character runs, per-paragraph
overrides, Source Text hold keys) are in Properties. Preview and every export draw the same per-character DOM.
Commands `textAnimator.*`, `textSelector.*`, `text.setPathOptions`, `text.setPerCharacter3d`; MCP
`list_text_animator_presets`, `apply_text_animator_preset`, `add_text_animator`, `add_text_selector`,
`get_text_animators`, `remove_text_animators`, `set_text_path`, `convert_text_animation`.

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
- Inserting never overwrites: a double-click, Enter or a drop on the Program monitor puts the clip on the first
  free video track from the targeted one (else V1) up, adding a track on top when all are busy (one undo step); a
  drop onto a video track of the timeline still overwrites there.
- MCP: `list_motion_templates` (renderer + params summary), `add_motion_graphic` (one or many graphics per call,
  first-free placement, seeded fill, `dryRun` + `preview`), `set_motion_graphic_params`,
  `render_motion_graphic_preview` (a Remotion still for anime templates).
- **Store reviews** (`social-comment@1` presets Play Store · Review, App Store · Review and App Store · Review
  (iPhone app)): a Google Play, App Store web / Mac or iPhone App Store review card with star rating (Properties:
  click or arrow-key the stars), date (date picker; the card prints it the store's way, "11/6/18" / "09/24/2021"),
  title, "edited" and the iPhone age ("Sun" under a week as in the iOS 14-era App Store, else "1y ago"; **Recent
  Dates** switches to today's "2d ago"); long reviews are clamped like the store (Play's fade, the App Store's
  "more"; **Truncate Long Text** off shows all). **Likes Tick Up / Stars Fill** fills the stars one by one. Bulk import
  takes `Rating` / `Stars`, `Title`, `Date` (YYYY-MM-DD) and `Edited` columns (`docs/wp-notes/social-comments.md`
  "Store reviews").
- **Platform fonts and emoji** (social-comment templates, `docs/wp-notes/social-comments.md` "Remote fonts &
  emoji"): a template declares the faces and emoji it draws; bundled faces (TikTok Sans, Roboto, …) load from the
  catalogue, the others (Chirp, SF Pro, Apple / Twemoji / Noto emoji images) are downloaded by the engine on first
  need from the remote-asset manifest (`apps/engine/src/remote-assets/manifest.json`, fixed or overridden without a
  release in `<appdir>/assets/remote-manifest.override.json`) into `<appdir>/assets/remote/`, verified and served at
  `/fonts/remote/…` and `/fonts/emoji/…`; remote images of the manifest (X's and YouTube's default avatars) the same
  way at `/fonts/images/…`. Downloads are a named network use, **Preferences ▸ Privacy & Network ▸
  Platform fonts & emoji for social templates** (on by default; headless, MCP and CLI renders follow it too). A
  missing font or emoji shows a striped marker on the card and a warning in the Program monitor (**Retry
  download**), and blocks exports with `TEMPLATE_ASSETS_UNAVAILABLE`, naming the font, or the emoji and its pack —
  never a substitute.
- **Presets:** a template may declare named param presets (e.g. Counter ▸ Subscribers / Percentage / Money Raised).
  The gallery then shows one card per preset instead of one for the template (search matches preset names; insert,
  drag and the hover preview use the preset's params over the defaults). Agents pass `"<id>:<preset>"` or
  `"<id>@<version>:<preset>"` as `template` to `add_motion_graphic` / `render_motion_graphic_preview`;
  `list_motion_templates` lists each preset with its ref.
- **UI hints:** a template's `ui` groups its params into ordered sub-sections of Properties ▸ Parameters and Effect
  Controls ▸ Template, sets labels, tooltips and multi-line text, hides params that do not apply to the current value
  of another param (`visibleWhen`, e.g. per variant) and can name a custom control registered by the web app
  (`registerTemplateParamControl`). Template names, categories, descriptions, preset names, group labels and param
  labels are translated through the model-string catalogue (`pnpm i18n`, Spanish in `apps/web/src/i18n/es.json`).
  Details: `docs/wp-notes/social-comments.md` § Presets & UI hints.
- **Clip names:** social comments are named from their content ("X post · Luna Park", "Instagram post comment ·
  @luna.makes"), so the timeline, the asset chip and export messages tell the cards apart; the name follows edits of
  the variant and the name until you rename the clip yourself.
- **Add Another:** on a motion-graphic clip (timeline clip menu, Properties ▸ Template, Motion Templates, Graphics
  menu, palette `mg.addAnother`) adds a copy right after it — after the last consecutive copy already there, so
  pressing it again on the same clip builds a sequence — same length, on the first free video track, one undo
  step. The params the template re-randomizes (`ui.addAnother.reroll`; social comments: name, handle, avatar and
  stats) get fresh values; look, text and animation are kept.
- **Import from a spreadsheet:** Motion Templates ▸ Import Spreadsheet… (also File / Graphics menus, a card's
  context menu, Properties ▸ Template) takes rows pasted from a spreadsheet (TSV) or a `.csv` / `.tsv` file (header
  row = param names or labels, template aliases such as `User` / `Comment` / `Verified`, an age in one `Time` /
  `Age` / `Ago` / `Posted` cell such as `3h`, `2 weeks`, `1y` or `just now`, optional `start` / `duration`; at most
  500 rows and 2 MB). The preview shows each row as it will be inserted (random values marked,
  rows with errors left out); Insert adds the rows one after another from the playhead as one undo step. Details:
  `docs/wp-notes/social-comments.md` § Add another & bulk import.
- **Edit text on the Program monitor:** double-click a template's text (Title Reveal title and subtitle, Lower Third
  name and role, Callout label, Counter label, social comment name and text) to edit it in place. The clip shows
  its settled frame (entrance finished, exit not started) while you type; the playhead does not move. The double-
  clicked word is selected. **Enter** (or a click elsewhere) applies one undo step, **Shift+Enter** starts a new line
  in multi-line texts, **Esc** cancels. In texts with word marks (social comments) highlights, blurs and removals
  stay on their words as you type, and selecting words shows a **Highlight / Blur / Remove / Clear** toolbar (one
  undo step per button). Overlapping templates: the topmost text under the pointer is edited (a card selected in the
  Timeline wins). Locked tracks and read-only projects say so instead of opening the editor. Template authors opt
  in with `editableParamProps` (`docs/wp-notes/social-comments.md` § Program monitor editing).

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
the top of the window. With the editor closed the same tools work headlessly on the saved project, and `undo` /
`redo` step through the agent's own headless transactions: that history lives in the engine's memory (16 steps per
project, 32 in all, forgotten when the engine restarts) and is refused (`E_NOT_OWNER`) once anything else has changed the project
since, so nobody's later edit is discarded.

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
| `--toolsets <list>` | toolsets advertised from the start: `all` or a comma list (env `JASPER_MCP_TOOLSETS`; default `core`) |

Tools (`list_toolsets`, `describe_tool`, or MCP `listTools` with `--toolsets all`, give the current catalog and
schemas):

- Core: `engine_status` · `list_projects` `create_project` `get_project` `open_project_in_editor` ·
  `browse_media_files` (folders and importable files on the engine's computer) `import_media` `list_media` `get_media_info` · `describe_commands` `apply_commands` `undo` `redo` ·
  `add_clip` `move_clip` `trim_clip` `split_at` `delete_clips` `add_text` `add_marker` `add_motion_graphic`
  `add_transition` · `get_timeline` `render_frame` `get_playhead` `set_playhead` · `list_motion_templates`
  `render_motion_graphic_preview` · `list_export_presets` `start_export` `get_job` `cancel_job` `wait_for_job`.
- Colour: `import_lut` `grade_clip` `get_grade` `copy_grade`; grading analysis: `scopes_read` (scopes as numbers) `color_match` (Apply Match into Lumetri) `auto_tone` `list_looks`.
- Colour management, HDR, OCIO: `list_color_spaces` `get_color_settings` `set_working_color_space`
  `interpret_footage_color` `set_clip_color_space` `import_ocio_config`.
- Clip processing: `list_processing_models` `install_processing_model` `process_clip` `use_media_version`
  `get_processing_settings` `set_processing_settings` `test_remote_executor` `replace_footage`
  `set_media_source_range`.
- Remotion projects: `import_mg_bundle` `list_compositions` `add_composition` `set_composition_props`
  `prerender_composition` `scaffold_mg_project` `list_composition_texts` `set_composition_text`.
- Tracking: `add_tracker` `track` `apply_tracking` `get_tracker` `set_corner_pin` `simplify_keyframes`.
- Roto Brush, object mattes and faces: `list_roto_models` `install_roto_model` `remove_roto_model` `create_roto`
  `add_roto_strokes` `propagate_roto` `get_roto` `apply_object_matte` `convert_roto_to_masks` `freeze_roto`
  `remove_roto` `track_faces` `blur_faces` `face_to_keyframes`.
- Puppet, Liquify and Mesh Warp (the simulation and warp effects themselves are `apply_commands` effects):
  `get_puppet` `add_puppet_pins` `move_puppet_pins` `record_puppet_pins` `remove_puppet_pins` `liquify_stroke`
  `set_mesh_warp_vertex` (`docs/wp-notes/sim-warp.md`).
- Masks and track mattes: `list_masks` `add_mask` `edit_mask` `remove_masks` `track_mask` `auto_trace_mask`
  `set_track_matte`.
- Transitions: `list_transitions` `list_transition_types` `update_transition` `remove_transitions` `apply_default_transitions`
  `set_transition_defaults`.
- Animation and graphics: `list_text_animations` `set_text_animation` `render_frames` `set_motion_graphic_params`
  `add_shape` `get_motion_path` `set_spatial_interpolation`.
- Vector shapes: `add_vector_shape` `svg_to_shape` `list_shape_presets` `get_shape` `add_shape_items`
  `update_shape_item` `remove_shape_items` `move_shape_item` `group_shape_items` `duplicate_shape_item`
  `edit_shape_path` `convert_shape_to_vector`; Trim Paths animations: `animate_trim_paths` (with an optional tracer
  in the same undo step) `reverse_path_direction` `add_line` `add_trim_tracer`.
- Titles (`titles` toolset, guide `title-art`): `title_look_find` `title_propose` `title_check` `title_look_save`
  `title_generator_add` `title_light_set`; the resource `jasper://title-looks/{id}`.
  `title_look_find` searches the library, the user's looks (`/api/title-looks`) and, with `projectId`, the project's;
  with `lookId` it returns that look's recipe. The library's title templates are rows of `kind: "template"`, inserted with
  `apply_commands` `title.insertTemplate`.
  `title_propose` needs an open editor to propose, and stores the first option's check rows on the proposal item; with `mode: "apply"` on a headless engine it returns `revert`, because there is no
  Undo there. `render_frames` runs as one engine job and takes `proposalId`, `itemIds`, `overlay: "safe-area"`, `wait`,
  `timeoutSeconds` and `jobId`.
- Effects: `list_effects` `add_effect` `set_effect_param`.
- Text animators: `list_text_animator_presets` `apply_text_animator_preset` `add_text_animator` `add_text_selector`
  `get_text_animators` `remove_text_animators` `set_text_path` `convert_text_animation`.
- Effect presets: `list_effect_presets` `get_effect_preset` `apply_effect_preset` `save_effect_preset`
  `delete_effect_preset`.
- Fonts (the user font library, Edit ▸ Preferences ▸ Fonts): `list_fonts` `install_font` `remove_font`
  (`docs/wp-notes/fonts.md`).
- Clipboard: `copy_clips` `paste_clips` `copy_items` `paste_items`.
- Blend modes: `list_blend_modes` `set_blend_mode` (Premiere's 27 + After Effects' stencils, `docs/wp-notes/keyframes-blend.md`).
- 3D layers, cameras and lights: `set_3d_layer` `set_3d_transform` `set_material` `add_camera` `camera_settings` `move_camera` `add_light` `light_settings` `set_3d_renderer` `get_3d_scene`; 3D Camera Tracker: `track_camera` `get_camera_tracker` `create_tracked_camera` `set_tracker_ground` `delete_track_points` (After Effects' Classic 3D and 3D Camera Tracker, `docs/wp-notes/three-d.md`).
- Keyframes and presets: `get_motion_path` `set_spatial_interpolation` `set_roving` · `list_effect_presets` `get_effect_preset`
  `save_effect_preset` `apply_effect_preset` `delete_effect_preset`.
- Keyframe easing: `list_ease_presets` `get_keyframe_eases` `apply_ease` `transfer_ease` `transfer_keyframe_values`
  `set_keyframe_velocity` `create_path_controller` `cleanup_motion_path` (`docs/wp-notes/easing.md`,
  `docs/wp-notes/mcp-cli.md` § 7).
- Media cache: `get_cache_usage` `clean_cache` `set_cache_location`.
- Render previews and performance: `get_render_bar_state` `render_previews` `delete_render_files` `perf_stats`
  (`docs/wp-notes/previews.md`).
- Edit structure: `nest_clips` `unnest_clips` `place_sequence` `list_nests` `add_adjustment_layer` `group_clips`
  `ungroup_clips` `duplicate_sequence` `delete_sequence` `remove_unused_media` `create_synthetic` `update_synthetic`
  `list_through_edits` `join_through_edits` `list_cuts` `find_gaps` `make_subsequence` `add_frame_hold`
  `insert_frame_hold_segment` `frame_hold_options` (`docs/wp-notes/edit-structure.md`).
- Time remapping, time interpolation, Scene Edit Detection: `get_time_remap` `set_time_remap` `set_segment_speed`
  `add_speed_keyframe` `remove_speed_keyframes` `move_speed_keyframe` `set_speed_transition` `add_freeze_segment`
  `add_reverse_segment` `set_time_interpolation` `detect_scene_edits` (`docs/wp-notes/time.md`).
- Editing and trimming: `source_edit` (three/four-point Insert/Overwrite, backtiming, Fit Clip, split edits, source
  patching) `find_edit_points` `trim_edit_points` `match_frame` `reverse_match_frame` `make_subclip` `edit_subclip`
  `set_split_marks` (`docs/wp-notes/edit-ux.md`).
- Synchronize, Merge Clips, multi-camera: `measure_audio_sync` `synchronize_clips` `merge_clips`
  `create_multicam_sequence` `switch_multicam_angle` `record_multicam_cuts` `set_multicam_enabled` `flatten_multicam`
  `edit_multicam_cameras` `get_multicam` (`docs/wp-notes/multicam.md`).
- Versions and recovery: `list_project_versions` `restore_project_version` `save_project_copy` `list_unsaved_changes`
  (docs/project-files.md).
- Audio buses and loudness: `measure_loudness` `get_mixer` `set_mixer_strip` `add_submix` `add_send` `write_automation`
  `set_audio_gain` `auto_duck` `set_loudness_normalization` `normalize_media_loudness` (`docs/wp-notes/audio-mix.md`).
- Audio effects, Essential Sound and Remix: `list_audio_effects` `get_audio_effects` `add_audio_effect` `set_audio_effect`
  `remove_audio_effect` · `get_essential_sound` `set_essential_sound` `clear_essential_sound` `auto_match_loudness`
  `generate_essential_ducking` `auto_tag_audio` (Auto Tag: dialogue / music / sfx / ambience by listening, marked
  "auto" until confirmed; `docs/wp-notes/sound-design.md` "WP6.3") · `remix_audio` `revert_remix`
  (`docs/wp-notes/audio-fx.md`) · music to picture: `find_music_drops` (drops, key, tempo) `fit_music_to_picture`
  (land the drop on a frame within 1 ms, end on a bar line; `docs/wp-notes/sound-design.md` "WP-E7").
- Sound library (sound effects; agents judge them by descriptors and contact sheets): `sound_library_status`
  `search_sounds` (takes: true lists the single takes of multi-hit recordings — typing runs, clocks — as sounds of
  their own, ids snd_…~t&lt;n&gt;; a material filter; describe: ranks by what sounds sound like with the optional
  Describe-it search model, else searches its words) `get_sound` (a recording's takes) `view_sounds` · Describe-it
  search (LAION CLAP, Apache-2.0, ≈ 780 MB, user-installed, analysis only): `describe_search_status`
  `install_describe_search_model` (tell the user the size and licence first) `remove_describe_search_model` (approval
  card) `prepare_describe_search` (embeds the library, incremental) `match_sound` (one sound against a description and
  alternatives) `find_sound_moment` (the best moments of a long recording for a description) `insert_sound_moment`
  (places one, one undo step) · `import_sounds`
  `insert_sound` (peak-aligned, never overwrites; take ids too) ·
  `list_sound_credits` `export_sound_credits` (writes the credits file, md / txt / csv, never overwriting) ·
  `add_sound_folder` `remove_sound_folder` `rescan_sound_library` · packs: `list_sound_packs`
  `install_sound_pack` (downloads a catalogue pack from its upstream site, sha256-pinned; tell the user its size and
  licence first) `remove_sound_pack` (approval card) · cues: `find_sound_cues`
  (derived from the edit; the engine sources scene, beat and pixel measure footage and music when asked, and
  snapToBeats; `timeSignature` "auto" detects 3 or 4 beats per bar for the downbeats, or give it)
  `analyze_picture_motion` (the rendered picture's motion per frame: moves, landings and cuts in
  footage, with a PNG strip) `set_sound_cues` `place_sound` (peak-exact, layers, alternates; proposes unless mode
  "apply") `swap_sound` `align_peak` `detect_sound_peak` (the editor's Detect Peak for project audio: the engine measures the
  clip's peak and writes it, one undo step) · `plan_sound_design` (a whole pass as one proposal, gains solved against the
  bed; style options room glue, stop-before, build, delivery; `style.cueSources` picks where derived cues come from;
  the cue grammar — one click voice at one level, keys as takes at speed 1, climbing runs, one key per word for fast
  typing, music carries the cuts, palette materials — with `style.personality` / `style.runs` / `style.typing` /
  `style.musicCarriesCuts` / `style.duckUnderTyping`, defaulting to the sequence's `soundDesign.setSettings {style}`; find_sound_cues
  and place_sound picks follow it too; music to picture — chimes tuned to the music's key, stops on the bar line — with
  `style.tuneToMusic` / `style.stopOnBar`, on by default) ·
  `rebalance_sfx` (masking solver: each sound effect clears the bed by its target lift, with what limited it) ·
  `lay_ambience_bed` (an ambience per scene — V1 cuts to other footage, scene markers, measured shot changes — looped
  at the recording's measured clean window and loop points with 1.5 s crossfades, crossfaded between scenes, at the
  ambience level, optionally ducked; proposes unless mode "apply") `fill_room_tone` (the holes between dialogue clips
  filled with the room tone closest to the dialogue's measured noise floor, or its own quietest stretch, at the floor's
  level) ·
  `apply_delivery` (web / podcast / R128 / A/85: Mix loudness, Auto-Match by type, ducking, measured) `set_room_glue` (a
  shared "SFX Room" reverb) · `sound_check` (the delivered mix measured: findings with safe fixes judged together, in the
  order to apply them — sync, loudness, the mix, cues, licences (ShareAlike warned), and clicks at edits, cut edges,
  harshness, inaudible layers, partial coverage, endings and the loudness arc — five listen-here timecodes, a verdict, a
  PNG of the worst moments; a custom delivery target; delivered through the export encoding it is checked for —
  `exportPreset` / `exportAudio`, by default the delivery preset's typical one (Web AAC 256, Podcast AAC 128, broadcast
  PCM) — and the stored summary records which; humanVerdicts: what the user said after
  listening in the editor's Sound Check panel, each bound to the moment it judged and marked stale when that moment
  changed; `proposalId` checks a proposal before review — what it fixes and introduces, per item, on its preview,
  nothing applied) `get_sound_check` (the last full report the engine keeps per sequence, across restarts: current or
  stale) `acknowledge_sound_issue` (a deliberate exception with a reason: left out of the verdict until what it is about
  changes; warnings and infos only for an agent, errors are the user's)
  `view_sound_timeline` (the annotated sound sheet of ≤ 120 s: frames at the cuts and cues, loudness of the mix and its
  stems, spectrogram, sections, every cut / cue marked by whether a sound answers it, motion, findings)
  `listen_to_sequence` (a written log of the mix, ≤ 10 min: every sound named by the clip that plays it and the cue it
  fills, sections, silences, which cuts and cues have a sound — each share next to its chance level — and the cuts with
  none; the sound sheet with images; tags: what each sound sounds like, with the Describe-it search model) · reference profiles (the measured style of the user's own reference media or
  sequences, numbers only, no bundled profile): `list_sound_profiles` `get_sound_profile` `build_sound_profile` (a job)
  `rename_sound_profile` `delete_sound_profile` (approval card) `export_sound_profile` `import_sound_profile`
  `set_sound_profile` (the sequence's; `sound_check {profileId}` adds the Reference rows)
  (`docs/specs/12-sound-design.md`, `docs/wp-notes/sound-design.md`).
- Proposals (reviewed and applied by the user in the editor; one undo step): `list_proposal_features` (features, their
  Review groups and whether agents may apply them here) `list_proposals` `get_proposal` (with a ghost table and its last
  Sound Check: fixes · introduces) `wait_for_proposal` (decisions and notes) `accept_proposal` (policy-gated for agents)
  `reject_proposal` `refresh_proposal` (the producer re-plans stale items, or with `reroll` draws an item again with
  its next seed; nothing is applied).
- Editing automation (spec 15; each a proposal of feature `edit-automation`, `mode: "dryRun"` for counts, coverage and
  export cost): `decorate_cuts` (a cut kit centred on every picture cut + a whoosh of its length through sound design)
  `add_punch_ins` (Motion zooms from the clip midpoint, held to the cut) `add_ken_burns` (slow zooms over a share of the
  A-roll clips) `place_reactions` (your reaction pictures from a bin or folder at markers, calls to action and
  exclamations, on a cut, wobbling) `slide_overlays` (one-sided Smooth Slides at overlay heads and tails)
  `lay_music_bed` (your songs end to end at −33 dB, switching on cuts) `add_stingers` (generated TV static after
  shouted punchlines) · style recipes: `list_style_recipes` `get_style_recipe` `save_style_recipe` (the built-ins Fast
  Shorts / Fast Long-form / Clean and your library in `<appdir>/style-recipes/`) `apply_style` (a recipe's cleanup,
  subtitles and passes in order as ONE proposal, later passes planned on the cleaned-up timeline) `style_check` (the
  sequence against the recipe's targets, with look-here timecodes) (`docs/specs/15-edit-automation.md`,
  `docs/wp-notes/edit-automation.md`).
- Captions and transcripts: `import_captions` `export_captions` `list_captions` `add_caption` `edit_caption`
  `split_captions` `merge_captions` `delete_captions` `style_captions` `caption_track` · `import_transcript`
  `transcript_inspect` `transcript_search` `transcript_select` `transcript_extract` `transcript_lift`
  `insert_transcript_selection` `remove_fillers` `remove_pauses` `rename_speaker` `captions_from_transcript`
  (`docs/wp-notes/captions.md`).
- Automatic subtitles as text clips (spec 13): `captions_from_transcript` (output, template, rules, text, cutAware,
  dryRun: one undo step) `list_caption_groups` `align_captions_to_cuts` `regenerate_captions` `convert_captions`
  (subtitle group ↔ caption track) `export_captions {groupId}` (SRT / VTT of a group) · templates
  `list_subtitle_templates` `save_subtitle_template` `apply_subtitle_template` `delete_subtitle_template`
  (`docs/wp-notes/auto-subtitles.md`).
- Many text clips at once and linked text styles: `style_text` (a deep style patch and effects with keys timed from
  each clip's In, on clip ids, `"$selection"` or a subtitle group, one undo step) `list_text_styles`
  `create_text_style` `apply_text_style` (apply / detach / reset) `update_text_style` `delete_text_style`
  (`docs/wp-notes/text-styles.md`).
- Speech to text (local Whisper; GPU when it helps — `engine_status` shows the provider probe, `transcribe`
  takes `device`, `accuracy` and a names `glossary` carried into every window): `list_speech_models`
  `install_speech_model` `remove_speech_model` `transcribe` `get_transcript` (`docs/wp-notes/speech.md`) · personal
  glossary (names and words the recogniser gets wrong, the same list as Edit ▸ Preferences ▸ Transcription ▸ Glossary,
  shared by every project): `list_glossary` `save_glossary_entry` `remove_glossary_entry` (approval card)
  (`docs/wp-notes/script-correction.md`).
- Voice analysis (10 ms levels, voicing, speech / breath / silence frames of a media's audio stream; a cached engine
  job): `get_voice_analysis` (`docs/wp-notes/transcript-cleanup.md`).
- Clean Up Voice (retakes, restarts, fillers, off-script talk, pauses and breaths found in transcribed speech and cut
  at the audio level in one undo step; guide resource `jasper://guide/cleanup` "Cleaning up speech"): `analyze_voice`
  `plan_cleanup` `apply_cleanup` `set_cleanup_settings` `attach_script` (`docs/wp-notes/transcript-cleanup.md`).
- Fix Transcript from a script (recognition errors fixed from the sequence's script and the personal glossary, each
  checked against the audio, into one reviewable `transcript-correction` proposal whose accept also patches the
  subtitles in place; guide resource `jasper://guide/transcript-fix` "Fixing transcripts from a script"):
  `attach_script` (the script serves cleanup and fixing) `fix_transcript` (`dryRun` / `propose`)
  (`docs/wp-notes/script-correction.md`).
- Timeline interchange (Final Cut Pro 7 XML, FCPXML, OpenTimelineIO, CMX 3600 EDL, AAF, OMF, Avid ALE) and Link Media:
  `import_timeline` `export_timeline` `list_offline_media` `link_media` (`docs/wp-notes/interchange.md`).
- Imports and Interpret Footage (Lottie, SVG, PDF/AI, PSD, image sequences, EXR/TIFF/TGA/BMP/DPX/HEIC/JPEG XL through
  `import_media`): `get_media_interpretation` `interpret_footage` `detect_image_sequence` `import_image_sequence`
  `list_document_layers` `import_layered_document` `import_pdf_pages` `export_lottie` (`docs/wp-notes/imports.md`).
- Reading properties: `get_clip_properties` `get_param` (the keyframed value next to the value actually rendered).
- Live UI of the open editor window (web or desktop): `ui_state` `ui_elements` `ui_screenshot` `ui_click` `ui_drag`
  `ui_scroll` `ui_key` `ui_type` `ui_set` `ui_locate` `ui_hit` `ui_commands` `ui_command`
  (`docs/wp-notes/mcp-cli.md`).
- Expressions: `set_expression` `clear_expression` `enable_expression` `test_expression` `get_property_values`
  `list_expression_properties` `list_expression_presets` `add_expression_control` (`docs/expressions.md`,
  `docs/wp-notes/expressions.md`; the language reference is also the `jasper://guide` resource).
- Premiere parity gaps (`docs/wp-notes/gaps.md`): Find and Edit Original `find` `locate_media`; tracks `add_tracks`
  `delete_tracks`; Project and Sequence Settings `get_project_settings` `set_project_settings`
  `get_sequence_settings` `set_sequence_settings` `new_sequence_from_clip`; proxies `create_proxies` `attach_proxy`
  `detach_proxies` `reconnect_full_resolution`; Audio Channels `get_audio_channels` `set_audio_channels`; Export Frame
  `export_frame`; Project Manager `project_manager`; Warp Stabilizer `stabilize_clip`; Auto Reframe
  `auto_reframe_sequence`; Essential Graphics `create_graphic` `set_graphic` `export_graphic_template`
  `import_graphic_template`.
- Delivery and Photoshop (`docs/wp-notes/title-looks.md`): `export_psd`, `export_frame {alpha: true}`,
  `import_layer_styles`, `image_split`, `color_gamut_check`.

Resources: `jasper://projects/{projectId}/document`, `jasper://projects/{projectId}/timeline`,
`jasper://guide`, `jasper://guide/<topic>`, `jasper://guide/routing`. Prompt: `edit-video`.

The engine also serves the same tools over MCP Streamable HTTP at `/mcp`, for clients that connect by URL.
Every engine has a token (it is in `<appdir>/engine/runtime.json`, readable by you only, and changes on every
start), so a URL client must send `Authorization: Bearer <token>`; the stdio server reads the token by itself and
is the simpler choice.

The packaged desktop app ships the server as `resources/mcp/jasper-mcp.mjs`. It has no `node`: Help ▸ Connect
an AI Agent… gives the command that runs the bundle with the app's own binary (`ELECTRON_RUN_AS_NODE=1`).

**Developing JasperEditor itself:** this checkout's root [`.mcp.json`](.mcp.json) registers `jasper` for agents
working *on* the editor. It runs the server from source (`node --import tsx apps/mcp/src/cli.ts`, no build needed)
with `--start-engine --appdir .stage`: it uses the `pnpm dev` engine when one is running, and otherwise starts a
headless engine on the same dev appdir (that needs `pnpm --filter @jasper/engine build` once). Claude Code asks
once before enabling a project-scoped server; start it from the repository root so the relative paths resolve.

### Toolsets and the agent skill

The server has over 400 tools. To keep an agent's context small, a session advertises only the **`core`**
toolset (≤ 32 tools: projects, the timeline, `describe_commands` / `apply_commands`, the main edits, footage digest
and takes, range views, proposals, the brief, export and verification, guides) and short instructions (≤ 4 KB,
because Claude Code cuts them at 4096 characters: when to use which route, the rules, a one-line toolset map). Every
other tool belongs to one named toolset (`project`, `media`, `editing`, `color`, `audio`, `sound`, `captions`,
`transcript`, `ui`… — `list_toolsets` lists them, `list_toolsets {names}` their tools):

- `describe_tool {name}` + `call_tool {name, arguments}` run any tool with the same strict arguments, approvals,
  progress and errors as a direct call; this is the route the instructions teach, because it works in every client;
- `enable_toolsets {"names": ["color"]}` changes what `tools/list` shows and sends
  `notifications/tools/list_changed`; `disable_toolsets` (in the `project` toolset) reverses it;
- calling an unadvertised tool by name returns `E_TOOLSET_NOT_ENABLED`, whose hint names `call_tool`;
- `--toolsets all` (or `JASPER_MCP_TOOLSETS=all`) advertises everything, as before; the `jasper` CLI always
  reaches every tool;
- guides: `get_guide {topic}` or the resources `jasper://guide/<topic>` (one per domain guide);
  `jasper://guide/routing` maps over 80 requests, in English and Spanish, to their tool and toolset;
  `jasper://guide` is every guide in one text. The `edit-video` prompt walks through the workflow.

The agent skill [`skills/jasper-editor`](skills/jasper-editor/SKILL.md) teaches an agent the workflow (brief →
footage digest and takes → look at ranges → propose one reviewable cut → wait for the review → export and
verify), when to ask and when to assume, the Done / Checked / Not checked report, and the gotchas (it cannot
hear, inspect the output rather than the plan, at most three self-review passes). Install it next to the MCP
server:

```bash
# Claude Code: personal skills (all projects), or .claude/skills/ inside one project
mkdir -p ~/.claude/skills && ln -s /abs/path/to/JasperEditor/skills/jasper-editor ~/.claude/skills/jasper-editor
# Codex CLI: personal skills folder (Codex releases with Agent Skills support)
mkdir -p ~/.codex/skills && ln -s /abs/path/to/JasperEditor/skills/jasper-editor ~/.codex/skills/jasper-editor
```

**Cursor**: add a project rule `.cursor/rules/jasper-editor.mdc` that points at the skill (Cursor reads rules,
not skill folders):

```markdown
---
description: Editing video with JasperEditor (jasper MCP server)
alwaysApply: false
---
When editing video with the jasper MCP tools, follow /abs/path/to/JasperEditor/skills/jasper-editor/SKILL.md
and its references/ files.
```

Any other agent that reads `AGENTS.md` can get the same line there. Claude Code's skill format (a folder with
`SKILL.md` frontmatter `name` / `description`) is what the files follow; the Codex folder and the Cursor rule are
taken from those tools' documentation and were not run here (no Codex or Cursor on the build machine).

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
- **Times.** Every time argument of a tool takes frames, `{"frames": n}`, `{"seconds": x}`, `"3s"` / `"1.5s"`,
  `"250ms"`, a clock `"00:03"` (M:SS) or `"1:02:03"` (H:MM:SS), or timecode `"HH:MM:SS:FF"`. The shape decides:
  a unit suffix is seconds / milliseconds, one or two `:` a clock (whole seconds — use `"3.5s"` for fractions),
  three separators always timecode. Commands inside `apply_commands` / `POST /api/agent/tx` keep the command
  forms (frames, `{frames}`, `{seconds}`, timecode).
- **Graphics never overwrite.** `add_motion_graphic` places each clip on the first free unlocked video track from
  V2 up for its time range (a new top track when all are busy); one call adds one graphic or `items: [...]` (up to
  200) as one transaction (one undo step, all or nothing), fills omitted params with the template's fill hook from
  a `seed` (returned), and returns per item the clip id, track, start/end and the fully resolved params. An
  explicit `track` keeps the older behaviour (overwrite on exactly that track) unless `placement: "first-free"`.
  `dryRun: true` resolves the same without changing the project; `preview: true` adds a still per item (up to 10).
  Raw commands get the same placement with `placement: "first-free"` on `clip.addText` / `addSolid` / `addShape` /
  `addMotionGraphic` (`docs/wp-notes/social-comments.md` "Placement & agent API").
- **Add another / bulk import.** `duplicate_motion_graphic {clipId, count?}` copies a graphic right after itself
  or its last consecutive copy (`count` copies in a row, one undo step; re-randomized params from `seed`); `import_motion_graphics_csv
  {template, csv}` adds one graphic per CSV / TSV row through the same parser and column mapping as the editor's
  import dialog (row errors refuse the call unless `skipInvalid: true`). Raw command: `clip.duplicateMotionGraphic`.

### Live UI: look at and operate the editor window

With a project open in the web app or the desktop app, `ui_state`, `ui_elements`, `ui_screenshot`, `ui_click`,
`ui_drag`, `ui_scroll`, `ui_key`, `ui_type`, `ui_set`, `ui_locate`, `ui_hit`, `ui_commands` and `ui_command`
drive the window itself through the engine relay (`POST /api/agent/ui` → WS `/agent`). Elements have stable
automation ids (`timeline-toolbar/button[Snap in Timeline]`, `timeline.clip.<id>`, `effectControls.fx.<id>`…);
`ui_locate` / `ui_hit` map timeline frames ↔ x and tracks ↔ y, and Program monitor sequence pixels ↔ window
points, so `ui_drag {from: {timeline: {clipId}}, to: {x, y}}` moves a clip like a user. An element or clip target
aims at the middle of its visible part, and one with nothing on screen is scrolled into view first. `ui_commands` lists every
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
jasper export --out cut.mp4 --overwrite          # replace cut.mp4 (else an existing file is kept: "cut (2).mp4")
jasper --timeout 540 call transcribe mediaId=med_1  # wait at most 9 min; past that the error names the
                                                 # transcribe {projectId, jobIds} call that waits and commits
jasper ui elements panel=timeline                # the live window (ui click id=…, ui screenshot --out w.png)
jasper call get_mixer --json                     # any MCP tool
```

`--json` prints one JSON document per line; exit status 0 = ok, 1 = the command failed (its error code, message
and hint on stderr), 2 = usage error. `jasper --help` is the reference.

### HTTP API underneath

The MCP tools are thin wrappers over the engine's agent API (protocol `jasper.tx/1`): the JSON Schema of every
command is at `GET /api/agent/schema`, read-only queries go to `POST /api/agent/query`, and transactions to
`POST /api/agent/tx`. It can be used directly for scripting. The engine wants its token on every request (there is
no unauthenticated mode): it is in the runtime file the engine's `/health` names. A client with the token is an
agent: destructive commands and operations are asked about in the editor window, which only the user can answer
([docs/security-review.md](docs/security-review.md) §8).

```bash
# the token of the dev engine (pnpm dev); jq reads the runtime file that /health names
TOKEN=$(jq -r .token "$(curl -s http://127.0.0.1:47900/health | jq -r .runtimeFile)")

# create a project (or take a projectId from GET /api/projects)
curl -s -X POST http://127.0.0.1:47900/api/projects -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Curl demo","preset":"hd-1080p-30"}'
# → {"projectId":"prj_…"}

curl -s -X POST http://127.0.0.1:47900/api/agent/tx -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
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

**Proposals** (spec 12 §2.5) are reviewable sets of edits stored next to a project, outside its undo history:
`POST /api/projects/<id>/proposals` with `{feature, title, sequenceId, items: [{id, label, commands, requires?,
alternatives?, meta?}]}` validates every item by a dry run (failing ones are stored `invalid` with the reason);
`GET …/proposals[/<proposalId>]` reads them; `POST …/<proposalId>/accept {itemIds: [...] | "all", partial?}` applies
the items and what they require as one transaction ("Accept <title> (n of m)"); `reject`, `reopen`, `note`, `select`
and `DELETE` record the review. A client with only the token may accept sound-design proposals only where the user
allowed it ("Allow agents to apply sound proposals"), and edit-automation, subtitles and transcript-cleanup proposals
while Project Settings ▸ Agent Proposals allows them (on by default), otherwise `403 APPROVAL_REQUIRED`;
`GET /api/projects/<id>/proposal-features` says which; a draft too large for one accept transaction is refused with
`413 PROPOSAL_TOO_LARGE` (`detail.suggestedRange`); `POST …/<proposalId>/refresh {itemIds: "stale" | [...]}` asks the
feature's producer to re-plan stale items (`409 PROPOSAL_NOT_REFRESHABLE` when it cannot); it may withdraw items
(`reject`) or delete a proposal, while `reopen`, `note` and `select` are the reviewer's (editor key only). An accepted
item is reopened only once its accept is undone (`409 PROPOSAL_STILL_APPLIED` while what it created is in the
document). Every accept is journalled (an intent file next to the proposal, with the ids its transaction creates its
entities with): an engine that stopped between the transaction and recording it (or lost the editor's answer) settles
it when the proposal is next read — recorded accepted when the document has it, rolled back when it does not; while the
editor window that received it is away with its lease alive, accepting that proposal again answers `409 NO_SESSION`
(retryable). A stale item's `reason` names what changed with timecodes ("The cut cue at 00:00:03:00 moved to
00:00:03:10"); the accept's `stale[].problem` carries the same, structured. Reading a proposal again and
again without `?revalidate=1` (what `wait_for_proposal` does) marks the agent as waiting for the review: the list's
`waiting: {agent, since}` and the event `proposal.changed` with `change: "waiting"` tell the editor, which shows "<agent>
is waiting for your review" on the proposal card and the review bar. `POST …/<proposalId>/applied
{itemIds, revision, refs, created?}` is the editor window's own: a Redo of an undone accept records the items accepted
again (agents get `403 APPROVAL_REQUIRED`; `409 PROPOSAL_NOT_APPLIED` when the document does not have what the accept
created).
`POST /api/sound-design/plan {projectId, sequenceId?, range?, cues?: "auto" | [cueIds], style?: {density, palette,
sources, cueSources, respectDialogue, seed, alternatives, roomGlue, stopBefore, build, delivery}, maxCues?, label?}`
(`cueSources`: where derived cues come from, the Suggest Cues… sources; default all) starts a `sound-design` job (202);
its result names the proposal it stored (`proposalId`) with a per-cue report (sound, score parts, role, alignment,
alternates, skipped cues, each sound's gain solved against the bed with what limited it, and the room glue / delivery /
stop-before / build items the style asked for).
`POST /api/sound-design/rebalance {projectId, sequenceId?, clipIds?, range?, delivery?, mode?: "propose" | "apply",
userGains?: "keep" | "replace", label?, autoGain?: true}` starts a `sound-design` job (202) that measures every sound effect against the
bed (rendered per cue cluster) and solves its gain with the masking solver; the result reports per clip the gain, target
and achieved lift, `limitedBy` and the reason, and either names the proposal it stored (`propose`, the default) or applies
the gains as one undoable transaction "Rebalance SFX Levels" (`apply`). `autoGain: true` (with `mode: "apply"` and
`clipIds`; Essential Sound ▸ Auto gain on) also hands the named clips back to Auto gain in that same transaction
(`soundDesign.setAutoGain` first, then the solved gains), also the ones the solve leaves unchanged or cannot measure;
the result's `autoGain.clipIds` lists them.
`POST /api/sound-design/delivery {projectId, sequenceId?, delivery: "web" | "podcast" | "broadcast-r128" | "atsc-a85",
mode?: "propose" | "apply", loudness?, autoMatch?, ducking?, rebalance?, label?}` starts a `sound-design` job (202) that
measures the clips, the speech and the resulting mix and applies (one transaction "Apply Delivery Preset") or proposes the
preset's Mix loudness normalisation, Auto-Match by type, ducking and re-solved sound-effect gains; the report gives the
expected loudness and true peak and how far under the voice the music and ambience sit during speech.
`POST /api/sound-design/check {projectId, sequenceId?, preset?, target?: {integratedLufs, truePeakDb}, range?, store?}`
starts a `sound-check` job (202) against the preset (or a custom `target`): the mix
as the export delivers it and its stems (sound effects, dialogue, music, ambience, bed) are rendered in one pass and
measured; the result (`SoundCheckResult`) has a verdict (pass / warn / fail), every finding with its code, severity,
timecode, translatable message and fix (commands, an engine job or a sound swap; `safe` when it resolves the finding by
itself), the per-event table, five listen-here moments and loudness curves; `store: true` also writes the summary into
the sequence (`soundDesign.setCheck`, one undo step).
`POST /api/sound-design/visual {projectId, sequenceId?, range, checkJobId?, spectrogram?}` answers at once with 10 ms
loudness curves of the mix and each stem, the mix waveform, cue ticks, sound-effect clips, speech, the picture's motion
curve, a check job's findings and (asked) the mix's log-frequency spectrogram over a range of at most 120 s.
`POST /api/sound-design/listen {projectId, sequenceId?, range?, detail?: low | normal | high}` starts a `sound-listen`
job (202) over at most 10 minutes: the mix and every clip rendered once; the result (`SoundListenResult`) is the
listening transcript — its lines and text, the events of the mix (attack, peak, band, prominence over the bed, accent)
each with the clip that plays it and the cue it fills, sections by audio type, silences, every cut / transition / cue /
measured motion with the sound that answers it and the chance level of each sync share, the placed sounds heard or not,
loudness. Nothing is written.
Reference sound profiles (the per-user library under `<appdir>/sounds/profiles`, numbers only):
`GET /api/sound-design/profiles` lists them; `POST /api/sound-design/profiles {name, projectId?, mediaIds?,
sequenceIds?, paths? (local engine)}` starts a `sound-profile` job (202) that measures 1–20 references and stores the
profile (`SoundProfileBuildResult`, with the skipped ones and why); `GET /api/sound-design/profiles/:profileId` is the
profile file (what Export saves); `PUT …/:profileId/name {name}` renames; `DELETE …/:profileId` deletes (an agent waits
for the user's approval); `POST /api/sound-design/profiles/import {profile, name?}` validates a file and stores it under a
new id. `POST /api/sound-design/check {…, profileId?}` (default the sequence's `referenceProfile`, null: none) adds
`report.reference` (one row per metric) and REFERENCE findings.
`POST /api/audio/classify {projectId | envelope, sequenceId?, clipIds} | {mediaKeys, streamIndex?}` (`?wait=1` to answer
when done) starts an `audio-classify` job: Essential Sound Auto Tag classifies each clip (the media range it plays) or
media as dialogue, music, sfx or ambience with a confidence, per-type scores, reasons and the measured features; cached
per file and range. Apply the results with the `essentialSound.autoTag` command. The cue route
(`/api/sound-design/cues`) also answers `voiceActivity` (voiced media seconds of Essential Sound dialogue clips without a
transcript) and `dialogue` spans with their sources (`words`, `vad`, `clip`).
`POST /api/sound-design/peak {projectId, sequenceId?, clipId}` answers at once with the peak of an audio clip's sound
(the centre of its loudest 2 ms, within the part of its media the clip uses, ≤ 120 s: `peakFlicks` from the media start,
`peakSec`, `onsetSec`, `truncated`); MCP `detect_sound_peak` writes it with `soundDesign.setPeak`, as the editor's Detect Peak
(which measures in the browser) does.

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
- Tests: `apps/web/test/shapes.test.tsx` exercises drawing and editing; pixel check against an analytic reference with
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
- Text whose glyphs stay still but whose picture moves — keyframed Motion / Opacity, the **Transform** effect
  (Shutter Angle motion blur included) and **S_Shake** without motion blur, RGB split or wrap (the subtitle
  templates' pop-in and shake) — bakes **one PNG of its layer box** and the native kernel draws it frame by frame
  through Motion, the Transform and the shake (spec 13 AS-070/073). Every still of an export (static layers and these)
  is rendered in **sheets**: up to 128 stills per Remotion render, identical words sharing one; a native export
  starts its composite while they render (each segment once its stills are written; the earliest one follows them).
  The animated masters of text, shape and caption layers render beside the composite too: segments without one start
  right after planning, the others as soon as theirs are ready (`JASPER_EXPORT_BAKE_OVERLAP` caps the segments
  rendering while masters still render). Shaken text with S_Shake's motion blur, RGB split or wrap stays an animated
  master, one per run of such clips on a track.
- The constant pictures of a track (those stills, still images with sub-pixel Motion) are drawn into **one input of
  the composite per track**, so memory and speed follow what is on screen, not the clip count (thousands of subtitles
  export on a laptop). `JASPER_EXPORT_TRACK_STREAMS=0` draws one input per layer instead, and
  `JASPER_EXPORT_COVER_BASE=0` blends full-frame opaque video over the background instead of using it as the base
  for its frames (diagnostics).
- A long native export renders its picture in **parallel segments** (each with only the layers it shows, joined by
  stream copy with the sound): `JASPER_EXPORT_SEGMENTS` (`auto`, a number, `1` = one graph),
  `JASPER_EXPORT_SEGMENT_MIN_SEC` (20), `JASPER_EXPORT_HW_SESSIONS` (hardware encoder sessions, 4),
  `JASPER_EXPORT_SEGMENT_SLOTS` (CPU slots per segment, 3). With a working CUDA device, source video decodes through
  NVDEC (`JASPER_EXPORT_NVDEC=0` turns it off; `JASPER_EXPORT_NVDEC_MAX_INPUTS`, 16 per export, bounds video memory;
  the longest inputs of each segment get them).
  With an OpenCL GPU the per-track text and still pictures are drawn by an OpenCL program inside the composite
  instead of the engine's kernel threads (`pipeline.kernel` says where and why not; `JASPER_EXPORT_OPENCL=0` turns it
  off, `JASPER_EXPORT_OPENCL_DEVICE` = `any` or `<platform>.<device>` picks another device than the first GPU).
  Segments run a few at a time within the memory available (`JASPER_EXPORT_MAX_SEGMENTS`, 64;
  `JASPER_EXPORT_SEGMENT_MEMORY_MIN_SEC`, 2); a watchdog stops a composite that grows past the budget, and an export no
  segmentation fits is refused by name instead of running out of memory. A downscaled export (1080p sequence → 720p)
  composites at its output size: layer placement is scaled, pictures stay in layer pixels, baked masters render at the
  output size; `pipeline.composite` says the size and why a feature kept the sequence size
  (`JASPER_EXPORT_COMPOSITE_SIZE=sequence` forces it). The plan and the job result report
  `pipeline` and the result `timings` per phase; an export's log is kept in `engine/logs/jobs/` when it succeeds too
  (docs/wp-notes/export-performance.md).
- Before an export starts, the planner estimates the composite's memory; one that would not fit (60 % of the RAM or
  of the engine's cgroup limit, or `JASPER_EXPORT_MEMORY_BUDGET_MB`) is refused on the native path with the estimate
  and goes through the Remotion path (a forced **Native** export is not eligible). A compositor killed by the system
  fails the export with `OUT_OF_MEMORY`; on Linux, tool processes are the OOM killer's preferred victims, not the
  engine.
- Bakes run as child jobs of the export ("Baking graphics 1/3 · 40 %"), up to 12 at a time: they share the export's
  bake page budget (a native export: one page per granted CPU slot; the Remotion path: its Remotion concurrency, at
  most half the cores; a still takes one page, a long animated title more) and a few render browsers (two pages
  each, at most 8); a bake gives its pages to the next one once its frames are captured; two exports needing the
  same bake render it once. `JASPER_LAYER_BAKE_PARALLEL=1` bakes one after the other,
  `JASPER_LAYER_BAKE_SHARED_BROWSER=0` gives every bake its own browser, `JASPER_LAYER_BAKE_PAGES=<n>` sets the page
  budget and `JASPER_LAYER_BAKE_PAGES_PER_BROWSER=<n>` the pages per browser (docs/wp-notes/export-performance.md). Bakes are cached under `<appdir>/cache/layers/<key>/`
  by a content key (clip, font files, media, compositions bundle, anime.js, Remotion, browser, GL back end);
  re-exports and moving a clip in time reuse them; entries unused for 14 days are removed.
- Colour effects (Lumetri, LUTs…) on these layers are applied by ffmpeg to the bake (`lut3d`); the Remotion path
  plays a graded copy; in the Program monitor the layer shows **Grade pending** until a graded preview arrives
  (about 2 s after the last change, then the bake time).
- Stills and the MCP `render_frame` tool take the same path. If a bake fails, an **Auto** export falls back to the
  Remotion path (warning `NATIVE_FALLBACK` in the job result); a forced **Native** export fails with the error.
- Without the Remotion renderer (no browser / no LGPL FFmpeg directory in a packaged engine) these layers block
  the native path and the plan explains why; `GET /api/capabilities` reports `features.layerBake`.
- **Transparent background:** Export mode ▸ Format **ProRes 422 HQ** ▸ Background **Transparent** (MCP: `start_export
  {preset: "overlay-prores-4444-alpha"}`) writes straight-alpha ProRes 4444 in MOV without audio, rendered on the
  Remotion path — e.g. social comments to lay over footage in another editor. Disable the footage clips first.
  Opaque pixels decode with alpha 1020/1023 (10-bit), not 1023 (measured; the Remotion ProRes path's alpha scaling).
- Engine tests with real renders: `REMOTION_E2E=1 pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts
  test/layer-bake-parallel.e2e.test.ts test/subtitle-parity.e2e.test.ts` (the second compares parallel and sequential
  bakes byte for byte, the third the subtitle templates with the composition's own frames); subtitle-scale timing and
  memory: `node scripts/perf/subtitles.mjs --case short|long9m --variant pixelpop --warm`;
  preview request timing and stale-result handling: `apps/web/test/layer-bake-runtime.test.ts`.

## Titles: delivery and Photoshop

Alpha delivery, Photoshop interchange and a gamut check (`docs/wp-notes/title-looks.md`):

- **File ▸ Export ▸ PNG Sequence with Alpha…**: numbered PNGs on a transparent background, straight alpha, in a folder or a ZIP.
  **File ▸ Export ▸ Frame…** takes *Transparent background* for PNG, TIFF and Targa. ProRes 4444 stays in Export Media.
- **Graphics ▸ Export Title…**: the selected clips alone, trimmed across their whole range to what they paint plus a margin. It
  renders past the sequence frame, so a glow at the edge is not cut, and reports where the picture sits in the sequence.
- **Graphics ▸ Send to Photoshop…** (also File ▸ Export): the frame at the playhead as a layered, registered 8-bit PSD. The dialog
  lists the layers and everything baked, and blockers appear before anything is written. Text is rasterised. *Split titles* groups
  each title into rims, face and fx.
- **Graphics ▸ Import Layer Styles…**: the styles of a `.asl` or `.psd` as looks, with a report per style of what was mapped,
  approximated and not supported.
- **Graphics ▸ Split Image…**: a still into its connected parts as separate clips, grouped, one undo step, for logo animation.
- **Program ▸ wrench ▸ Gamut Warning** (also the View menu): marks the pixels of the paused frame outside an output gamut, or
  outside the EBU R 103 legal range after 4:2:0, with percentages.
- MCP: `export_psd`, `export_frame {alpha: true}` (export toolset), `import_layer_styles` `image_split` (graphics), `color_gamut_check` (color);
  guide topic `delivery`. Routes: `POST /api/psd/plan`, `/api/psd`, `/api/alpha-delivery`, `/api/gamut-check`,
  `/api/title-looks/layer-styles/read`, `/api/media/:key/split-image[/analyze]`.

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

The testing guide is [docs/testing.md](docs/testing.md): golden frames and fingerprints (`JASPER_BLESS=1`), the
fuzz harness for every parser, route and MCP tool (`FUZZ=1`), ffmpeg oracles (`JASPER_REQUIRE_ORACLES=1`), the scale
benchmark, and the CI workflow (`.github/workflows/ci.yml`: lint, typecheck, test, build on every push and pull
request). Shared helpers live in `@jasper/testkit`.

```bash
pnpm fixtures && pnpm mg:build   # optional first: some engine tests skip without jasper-mg
pnpm verify              # lint + typecheck + unit/integration tests + build
pnpm e2e                 # builds jasper-mg (if cargo), engine + web + jasper-mcp, then Playwright (headless Chrome) against the built engine
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
`E2E_KEEP_APPDIR=1` keeps the appdir for inspection. Playwright waits up to 180 s for that server to answer `/health`;
`E2E_SERVER_TIMEOUT_MS=<ms>` (1 000 … 3 600 000) changes it for one run, e.g. `E2E_SERVER_TIMEOUT_MS=600000` on a
heavily loaded shared host. The pre-step also fetches the LGPL FFmpeg directory
where a pinned prebuilt exists (`E2E_SKIP_LGPL=1` skips it), so the exports in the specs are made by the
shipped build (H.264 by OpenH264). The specs run in the system Chrome; `JASPER_BROWSER_EXECUTABLE=<chrome>` gives
the pages, the engine's renders and the GL unit tests one other Chrome instead (specs that need flags take them from
`browserLaunch` in `e2e/support.ts`, which keeps it). HTML-in-Canvas specs (GL blend modes, adjustment layers with GPU
effects, the HDR display transform, 3D) need Chrome 148+: the build server's gate runs with Chrome for Testing
150.0.7871.124 that way (its system Chrome is 142).

`pnpm test` includes the MCP integration suite (`apps/mcp/test/integration.test.ts`): it boots a real engine
in token mode on a free loopback port (`MCP_TEST_PORT` pins one; `--start-engine` on another) with a temp
appdir, connects an MCP SDK client to `jasper-mcp` over stdio, and goes from create project → import fixture
media → edit → `render_frame` (PNG) → `start_export` + `wait_for_job` → ffprobe of the output. Run it alone
with `pnpm exec vitest run --project @jasper/mcp`.

The MCP scenario QA suite (`pnpm qa:mcp`, also run with `REMOTION_E2E=1`; `apps/mcp/test/qa/`) builds real
edits only through `jasper-mcp` over MCP JSON-RPC against a real engine — a rough cut, a colour grade, titles, a
cross dissolve, keyframed opacity and position, an export re-imported into another project, and a cancelled
export — and asserts on rendered pixels (coverage, centroid, luma, mean difference) and on the written files.
`MCP_QA_PORT` picks the engine port (49025), `MCP_QA_KEEP=1` keeps the frames in `test-results/mcp-qa/`.
`apps/mcp/test/jasper-cli.test.ts` exercises CLI project resolution, editing, JSON-lines output and rendered files
against a real engine.

Playwright specs:

- `e2e/smoke.spec.ts` — create a project, import and edit linked footage, play, undo and export a native movie;
  insert a motion graphic and export it over footage; create a title with the Type tool and export through Remotion.
- `e2e/agent.spec.ts` — apply MCP commands to the open editor as one `Agent:` History entry, render the edited
  result and undo/redo it; apply commands headlessly and reopen the project in the editor.
- `e2e/agent-ui.spec.ts` — timeline and Program coordinate mapping through the built `jasper-mcp`, clip dragging,
  scrubby-number editing, window and panel screenshots, and revealing an offscreen clip before targeting it.
- `e2e/ui-audit.spec.ts` — every interactive element of every panel in every workspace, the menu bar menus and the
  clip context menu has a stable automation id.
- `e2e/pwa.spec.ts` — the production manifest, file association and icon responses with their declared dimensions.
- `e2e/polish.spec.ts` — Media Browser browse/preview/import, live language switching that preserves the document
  and undo history, and a failed editor download with a reload action.
- `e2e/project-files.spec.ts` — crash recovery, saved versions, Save As; a reloaded tab keeps its lease even when
  its release is lost, another tab stays read-only.
- `e2e/security-review.spec.ts` — agent requests require a trusted user approval; denial preserves the document;
  unauthenticated engine requests fail and editor cookies remain HttpOnly.
- `e2e/mg-clips.spec.ts` — Remotion page-protocol contract (4.0.499), opaque-origin sandbox isolation, and importing
  a composition into the live preview with a props edit visible within 500 ms. Writes protocol JSON and a preview
  screenshot.

## Performance measurements

`pnpm perf` runs the synthetic hot-path benchmarks sequentially. Each benchmark also runs directly with
`pnpm exec tsx <path>`; its adjacent JSON records the original revision, workload, before/after results,
and methodology. Run `node scripts/measure-web-bundle.mjs [dist-directory]` after a production web build
to measure initial and total JavaScript bytes, including gzip sizes.

Later work is measured in [`docs/performance.md`](docs/performance.md), which also lists every budget and how it
is enforced: the editing-core budgets on 1 000 clips (§4), the editor UI at 1 000 – 5 000 clips (§5) and project
open (§6: a 2 000-item project in 2.0–2.9 s at host load ≈ 18, from 8–14 s). `pnpm perf` runs them
(`--sections ui --ui open` for the open alone).

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
| `pnpm test` | Vitest (all packages and apps as projects); `FUZZ=1 pnpm test` runs the long property and fuzz sweeps; `JASPER_BLESS=1` re-blesses goldens (docs/testing.md) |
| `pnpm perf` | Sequential snapshot, scene, selection, timeline-transition, and cache-reference microbenchmarks |
| `pnpm lint` | Biome + design-token, anime.js and dependency-layer checks (`scripts/check-tokens.mjs`, `scripts/check-anime.mjs`, `scripts/check-layers.mjs`) |
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

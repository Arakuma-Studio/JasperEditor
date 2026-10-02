# E2E test cleanup ledger

Scope: every baseline test in `e2e/*.spec.ts` and `e2e/desktop/*.desktop.ts`, plus the executable E2E checks and their support. `K` means KEEP, `R` means REWRITE, and `D` means DELETE. A renamed test appears under its baseline name with the new name in parentheses. The new RTL test is listed separately.

## Retention standard used for every K and R below

Each file heading gives **S** (the independently written requirement or regression), **I** (the public interface or stable seam), **R** (why an internal refactor can preserve the assertion), **L** (why this E2E scenario owns the integration contract rather than repeating a lower layer), and the artifact. Each retained row gives **F/O**: the recognizable failure and its independently specified oracle. Together S, F, O, I, R, and L address all six retention bars for that row. `window.jasper.query` is the documented in-page agent protocol (ARCHITECTURE §11); where used to observe state, it is a caller-visible API rather than a private store import. The browser tests drive actions through the UI except where explicitly testing MCP or using agent setup.

Risk of these deletions: a removed presentation assertion might have noticed a purely cosmetic change; the kept user actions, state, pixels, exported files and lower-layer contracts continue to detect functional regressions. Validation: `pnpm e2e:typecheck`, `pnpm exec biome check e2e`, `git diff --check`, scoped Playwright commands below, desktop smoke and native fallback. The parent agent owns the full integrated `pnpm e2e` gate.

### `e2e/agent.spec.ts`

S: ARCHITECTURE §11 and §15 item 10, `docs/wp-notes/wp-mcp.md` (live/headless MCP, approval). I: built stdio MCP, browser UI, and documented agent queries. R: no assertion on MCP wrapper call count or private component tree. L: unit MCP/engine tests cannot prove an external process updates an open browser and approval card. Artifact: `test-results/e2e-agent-live.png` plus the project created by the running engine.

- K `the MCP server finds the running engine and sees the open editor` — F/O: an external MCP client cannot discover the live project; the open project ID and tool response must agree.
- K `apply_commands with the editor open places a clip and a marker live, as one "Agent:" History entry` — F/O: a successful MCP response with no visible clip/marker or separate undo entries fails; the requested clip and marker and one transaction are the oracle.
- K `helper tools, get_timeline, set_playhead and undo work against the live editor` — F/O: tool edits or queries disagree with the open timeline; requested frame/text and undo state are the oracle.
- K `a destructive transaction waits for the approval card; Deny rejects it, Approve applies it` — F/O: unauthorized track removal or approval that does not apply fails; the explicit deny/approve decisions and resulting track state are the security oracle.
- K `Help ▸ Connect an AI Agent… shows configuration with the real path of jasper-mcp` — F/O: copied launch configuration cannot identify the bundled MCP entry; filesystem path and launcher contract are independent of UI copy.
- K `with the editor closed the tools apply headlessly; open_project_in_editor brings the project back` — F/O: closed-editor changes disappear or reopen misses them; persisted marker/document state is the oracle.

### `e2e/anime-core.spec.ts`

S: S11 acceptance 8/FIX-010 and legal third-party disclosure. I: built About dialog and notices link. R: assertion concerns license identity/text and working link, not layout. L: browser disclosure is not proven by a notice generator unit test. Artifact: `test-results/e2e-anime-licenses.png`.

- D `the built web app serves THIRD_PARTY_NOTICES.md` — direct file fetch duplicates the retained About link and notice display, plus the notices build check; no separate user workflow.
- K `Help ▸ About lists anime.js (MIT, licence text) and opens the third-party notices` — F/O: missing/wrong MIT disclosure or broken notices navigation fails; the package's license and shipped notice content are independent sources. Removed the pinned animejs version string from the assertion.

### `e2e/anime-templates.spec.ts`

S: S11 §11 test 3, `docs/wp-notes/wp-m2-anime-templates.md` (including Review fix #1), S05:ECP-008. I: template gallery, Properties/Effect Controls, Program pixels, engine export/still APIs. R: decisive visual assertions use decoded pixels, not a template SVG/markup tree. L: lower-layer timing and property tests do not prove drag/edit/preview/export wiring or the documented browser clipping defect. Artifacts: `test-results/e2e-anime-templates/anime-effect-{before,blurred,pinned}.png`, `anime-templates.mov`, still PNG, `callout-clipped-program.png` and `callout-clipped.mov`.

- R `the gallery lists anime templates (badge R, hover preview) and title-reveal drags onto the timeline` → `dragging a title-reveal template onto the timeline shows it in the Program` — F/O: a visible gallery card cannot create a template clip or preview; the requested template identity and visible Program frame are the oracle. Badge, hover subtree, card count and derived default duration were removed.
- K `edit the title text and colour in Properties` — F/O: edited title/colour fails to appear in document and Program; user input is the independent oracle.
- R `keyframe a colour param with the stopwatch: the Program colour changes over time` — F/O: stopwatch fails to key or Program accent stays constant; blue first key, green second key, and intermediate decoded screenshot pixels are specified by user edits. Removed SVG `stroke` attribute assertions.
- D `stretching the clip keeps the intro and the outro frame-exact` — compared `innerHTML` snapshots of one implementation; `packages/mg-templates/test/anime-templates.test.ts` owns the anchor/hold timing contract.
- R `a Gaussian blur and a corner pin apply to the anime template in the Program` → `Gaussian blur and corner pin visibly change the template in the Program` — F/O: blur must reduce rendered edge energy; moving a corner must change more than 1,000 actual Program pixels. This replaced `data-effect`, SVG and `matrix3d` shape checks; exported media/still parity continues the same scenario.
- D `fframes templates are unaffected: twin SVG and F badge through LayerBox` — badge/twin markup inventory duplicates fframes insertion and native rendered export in `e2e/smoke.spec.ts`.
- K `export (native with layer-bake, else Remotion) matches renderStill` — F/O: planner selects the wrong path, export is blank, or export/still differ on an animated frame; capability, visible title and decoded frame agreement are independent observations.
- K (new regression) `an out-of-canvas callout is clipped in the Program and exported frame` — F/O: a callout label at `labelX: 0.95` and 50% scale leaks red pixels beyond its specified canvas in the Program, or export loses the visible portion; the documented canvas crop at x=75% of a centred half-scale layer, a visible red strip inside it, and absence of red outside it in both independently rendered outputs are the oracle. It uses the public agent transaction for fixture setup, browser screenshot and actual exported video frame. A DOM/CSS refactor preserving the rendered crop passes; no lower test observes the historical preview/export mismatch.
- D `no uncaught page errors` — broad console probe without a specific contract; all meaningful actions already have outcome assertions.

### `e2e/clipboard.spec.ts`

S: S01 §20, CLB-007/010, S03:XF-050/EC-023 and `docs/wp-notes/wp-clipboard.md`. I: keyboard/context menus, OS clipboard, document query and selection APIs. R: outcomes concern pasted data, timing, selection and navigation, not clipboard helper calls. L: the web unit suite owns payload transformation; these rows own UI routing and cross-tab transfer. Artifact: `test-results/e2e-cross-project-clipboard.png` and the second project's document.

- K `Ctrl+C / Ctrl+V on the timeline: new ids, every M2 field kept, copies selected, playhead at their end` — F/O: pasted clips lose fields/identity or focus; original clip values and new identity are the oracle.
- K `Undo removes the paste; Redo restores it with the copies selected` — F/O: undo/redo or selection recovery fails; the original and pasted clip sets are the oracle.
- K `Paste Insert (Ctrl+Shift+V) ripples later clips on the destination and sync-locked tracks` — F/O: insert overwrites or desynchronizes; later clip start and linked-track alignment are the oracle.
- K `Paste Attributes… (Ctrl+Alt+V): the dialog lists the copied attributes; only the checked ones paste` — F/O: unchecked properties change or checked ones do not; chosen checkbox set and target values are the oracle.
- K `Program monitor right-click on a layer: Copy, then Paste from the menu (XF-050)` — F/O: monitor action misses the layer or paste fails; resulting new clip is the oracle.
- K `Effect Controls: copied keyframes paste at the playhead keeping their spacing (EC-023)` — F/O: copied keys shift incorrectly; source spacing and requested playhead anchor are the oracle.
- K `Project panel: a copied sequence pastes as a deep copy with new ids (CLB-007)` — F/O: aliasing or missing sequence on paste; source content with independent IDs is the oracle.
- K `cross-project paste in another tab through the system clipboard (media resolved by fingerprint)` — F/O: second project cannot resolve the media or aliases first-project ID; matching media fingerprint and fresh ID are the oracle.
- K `Program monitor layer menu: Fit to Frame, Anchor ▸, Arrange ▸, Reveal in Timeline / Project (XF-050)` — F/O: each menu action fails its visible/document effect; centred fit, visually stationary anchor change, track order and selection/navigation are the independent outcomes.
- K `external text: Ctrl+V on the Timeline adds a 5 s centred text clip at the playhead, one undo step (CLB-010)` — F/O: external text is ignored/misplaced; clipboard text and playhead are the oracle.
- K `external image data: Edit ▸ Paste imports "Pasted image <time>" and places it at the playhead (CLB-010)` — F/O: image bytes are not imported/placed; the supplied image and playhead are the oracle.
- K `an OS file in a paste event is imported under its name and placed (CLB-010, LIFE-010)` — F/O: file paste loses path/media; supplied file and placement are the oracle.
- K `text fields keep their own paste (CLB-010 never hijacks inputs)` — F/O: global shortcut steals text input; entered text remains in the focused field.
- D `no page errors` — generic log probe with no independently specified outcome. Removed its watcher and the duplicate second-tab watcher.

### `e2e/color.spec.ts`

S: S06 §9 and the documented Lumetri/Scopes workflow. I: Color workspace controls, Program canvas pixels, chart/LUT fixture. R: assertions concern edits/undo, real scope pixels and CPU/WebGL output parity, not row component counts. L: UI wiring and browser shader are distinct from project command tests; `auto` and forced `webgl` exercise different rendering backends. Artifact: `test-results/e2e-color-scopes.png` and Playwright parity measurements.

- K `Color workspace with a graded clip: Lumetri edit = one history entry` — F/O: slider/look/curve edits fail, duplicate effects appear, or undo fails; user input and prior clip state are the oracle.
- D `Effect Controls shows the Lumetri editor and hides the curve/wheel rows` — asserted private row presence/absence; the Color workflow and `apps/web/test/color-lumetri.test.tsx` own the actual controls.
- K `Lumetri Scopes draws a trace of the selected clip` — F/O: scope canvas is empty for a nonblank clip; fixture pixels and a drawn trace are the oracle.
- K `the Program monitor layer canvas equals the TS reference within 1/255 on 99.5 % of the chart (${stage})` (two parameterized cases: `auto`, `webgl`) — F/O: browser backend diverges from the separate TypeScript colour reference; chart fixture and tolerance from S06 are the oracle.

### `e2e/editing.spec.ts`

S: ARCHITECTURE §15 items 2–7, S02 timeline/transport contracts. I: keyboard/mouse UI, public session query, rendered filmstrip/waveform. R: decisive assertions concern clip timing, history, visible pixels and transport state; font/theme/tab inventories were removed. L: browser gestures and keyboard focus cannot be proven by project command tests. Artifact: `test-results/e2e-editing-text-transform.png`.

- R ``Editing workspace chrome: panels, tabs, engine chip, font, ` maximize`` → `Backquote maximizes and restores the timeline` — F/O: Backquote does not toggle the visible timeline view; the documented shortcut's two states are the oracle. Deleted presentation inventories and exact font/theme checks.
- D `import two clips: probe/poster/sprite/peaks jobs complete (Jobs panel + /api/jobs)` — internal job-kind count inventory; import setup moved into the next retained filmstrip/waveform test. Poster/import and Jobs export outcomes remain elsewhere.
- K `drop clip-a on V1: filmstrip and waveform are drawn` — F/O: drop or derivative drawing fails; imported video/audio fixture and nonempty timeline pixels are the oracle.
- K `Ctrl-drop inserts clip-b at 5 s and ripples the sync-locked tracks (one History entry)` — F/O: wrong edit mode or lost A/V sync; fixture order and linked clip starts are the oracle.
- K `transport: timecode entry, ←/→ steps, L/K/J shuttle` — F/O: keyboard transport/frame entry fails; requested timecode and direction changes are the oracle.
- K `Ctrl+K adds an edit at the playhead on targeted tracks (one History entry)` — F/O: untargeted track cut or missing cut; target selection and playhead are the oracle.
- K `Delete lifts, Shift+Delete ripple-deletes; Ctrl+Z restores the clip and its selection` — F/O: wrong gap/ripple/undo state; pre-edit clip and selection are the oracle.
- K `B (ripple edit tool) trims the tail and ripples later clips; Ctrl-move inserts; S toggles snapping` — F/O: gesture modes produce wrong timing; neighboring clip boundaries and toggle state are the oracle.
- K `Graphics ▸ Text adds a text clip; Properties scrub is one undo step; Program overlay move/scale/rotate` — F/O: text creation or program transform gestures fail; user-entered transform and single-undo history are the oracle.

### `e2e/layer-bake.spec.ts`

S: S11 §6/§11 test 4 and FIX-002. I: UI, Program preview, engine jobs and decoded MP4. R: outputs are a visible graded title and actual exported pixels, independent of internal cache layout. L: built-app title editing and final hybrid media path need one E2E integration owner. Artifact: `test-results/e2e-exports/layer-bake.mp4`.

- K `footage, a static title after it and a keyframed title (Effect Controls stopwatch)` — F/O: UI cannot set keyframed opacity; the requested two key values and timeline clips are the oracle.
- K `a Lumetri grade on the static title: "Grade pending", then the graded preview in the Program (FIX-002)` — F/O: grade remains pending or preview is ungraded; nonblack but darkened Program pixels are the oracle.
- K ``Auto exports `hybrid`: one PNG for the static title, a master for the keyframed one; pixels show both`` — F/O: wrong export path or missing title/ramp; decoded video luma at specified times and child-job results are the oracle.

### `e2e/mg-clips.spec.ts`

S: S08 §8 test 4 and ARCHITECTURE D-19, including Remotion 4.0.499 page protocol. I: real imported bundle served to a browser iframe, UI, MCP, and rendered PNG. R: protocol globals are an external protocol contract; UI checks observe rendered text and preview state. L: unit mocks cannot verify the built bundle/page protocol or live preview. Artifact: `test-results/e2e-composition-preview.png` and MCP image response.

- K `renderer-page protocol contract (Remotion 4.0.499) drives the fixture bundle frame by frame` — F/O: upgraded Remotion page cannot configure/seek or shows wrong frame; fixture title/opacity and pinned protocol version are the oracle.
- R `import a Remotion project, insert a composition, live preview, props edit, preview WebM` — F/O: import/preview fails or the entered title misses S08's 500 ms live Program bound; fixture title, user-entered title and browser-visible iframe text are the oracle. The old Node wall clock included Playwright command/poll scheduling under host load; the rewritten test measures from Enter keydown to the rendered iframe title using browser `performance.now()` and animation-frame observation. It still drives the public Properties field, checks visible title and preview WebM, survives internal renderer changes, and is the sole browser owner of this latency contract.
- K `MCP: import_mg_bundle → add_composition → set_composition_props → render_frame, as Agent History entries` — F/O: MCP chain fails to alter the open editor or render; supplied props, History and returned PNG are the oracle.

### `e2e/processing.spec.ts`

S: S07 §6 and acceptance §8 item 9. I: timeline menu, engine job, media version UI/settings API. R: outcome is derived media/undo and saved settings, not job callback shape. L: built processing executable plus editor transaction is a distinct integration path. Artifact: `test-results/e2e-processed-clip.png` and project document.

- K `Process Clip… (denoise) swaps the clip to the processed version in one undo step` — F/O: job does not replace clip or one undo fails to restore source; original media ID and requested process operation are the oracle.
- K `Media Version dropdown swaps and undoes` — F/O: version switch or undo fails; original/processed IDs are the oracle.
- K `Preferences ▸ Processing saves the remote settings and renders a probe result` — F/O: settings do not persist or unavailable executor is reported ready; supplied host/port and closed port 1 are the oracle.

### `e2e/pwa.spec.ts`

S: ARCHITECTURE §12/§15 item 12 and S05 §20 (installability, engine route bypass). I: production manifest, icons, browser service worker/cache and HTTP. R: checks use web platform responses, not service worker function names. L: worker unit route tests cannot prove registration/control in the served production build. Artifacts: `test-results/e2e-pwa-{manifest,service-worker}.json` from observed responses.

- K `manifest.webmanifest is linked, valid and its icons exist with the declared sizes` — F/O: app becomes un-installable or icons/file handler break; PWA manifest contract and PNG dimensions are the oracle.
- K `the service worker registers, activates and bypasses engine routes` — F/O: worker fails to control the page or caches `/api/capabilities`; live HTTP status and absence from CacheStorage are the oracle.

### `e2e/shapes.spec.ts`

S: S11 shape/graphics acceptance, XF-061, SHP-005/008. I: Graphics menu/tools/Properties, public document query, MCP, Program and export pixels. R: decisive outcomes are geometry values and visible/exported shape, not internal helper calls. L: browser pointer modifiers and built export integration need a browser owner beyond command tests. Artifact: shape export and still under `test-results/e2e-exports/`.

- K `Graphics ▸ New Layer ▸ Rectangle / Ellipse are enabled and insert shapes at the playhead (FIX-007)` — F/O: menu action inserts wrong/no shape; selected tool, shape type and requested frame are the oracle.
- K `Rectangle / Ellipse tools: drag box, Shift = square, Alt = from the centre, Escape cancels (XF-061)` — F/O: pointer modifier geometry or cancellation fails; gesture endpoints and modifier rules in XF-061 are the oracle.
- K `Properties ▸ Shape edits fill, stroke and corner radius (one undo step each, SHP-005)` — F/O: entered style fails to update or undo; chosen colours/width/radius and prior state are the oracle.
- K `Effect Controls ▸ Shape keyframes the size; the Program follows; undo/redo` — F/O: keys or visible size do not track time or undo; two entered size values and frames are the oracle.
- K `MCP add_shape applies live as one "Agent:" History entry (SHP-008)` — F/O: external tool fails to create a visible shape or splits undo; MCP arguments and returned timeline are the oracle.
- K `export: native with baked layers when the layer bake is ready, else Remotion; the frame matches renderStill` — F/O: shape disappears or export/still diverge; visible red pixel and decoded image comparison are the oracle.

### `e2e/smoke.spec.ts`

S: ARCHITECTURE §15 items 2–8/13, M1 golden path. I: Home/editor UI, imported fixture, public document query, ffprobe and decoded exports. R: decisive outcomes are workflow state and media, not panel layout; the redundant panel inventory was trimmed. L: this is the single broad UI-to-native/Remotion export flow. Artifacts: `test-results/e2e-exports/smoke-{native,mg-native,remotion}.mp4`.

- R `Home → New Project opens the Editing workspace` — F/O: project creation fails or wrong default video preset is loaded; requested project and documented 1080p preset are the oracle. Removed panel-tree inventory.
- K `import clip-a.mp4 through the file chooser → Project panel row with a poster` — F/O: import/poster generation fails; supplied media file and decoded poster are the oracle.
- K `drag the item to the timeline → linked V1/A1 clips` — F/O: video/audio placement or linking fails; fixture's two streams, start and duration are the oracle.
- K `Space plays the Program monitor, Space stops it; the monitor shows the frame` — F/O: transport does not advance/stop or Program is blank; fixture motion/test pattern are the oracle.
- K `move, trim, razor: one History entry each; Ctrl+Z / Ctrl+Shift+Z` — F/O: linked clips desync or edit undo fails; pre-edit source bounds and requested pointer edits are the oracle.
- K `export a media-only sequence with Auto → native ffmpeg path; ffprobe frame count matches` — F/O: planner/export loses media, audio or frames; sequence bounds and fixture streams are the oracle.
- K `insert the lower-third@1 motion graphic from the Motion Templates panel (drag to V2)` — F/O: gallery drag fails to place a graphic on V2; selected card and drop target are the oracle.
- K `motion graphic + footage exports with Auto → native (fframes master)` — F/O: MG disappears or path falls back unexpectedly; decoded lower-third region and expected native path are the oracle.
- K `Type tool click in the Program monitor adds a text clip` — F/O: Program Type tool cannot create text; click and resulting text clip are the oracle.
- K `with the text clip, the forced Remotion export succeeds` — F/O: Remotion path cannot render mixed text/media; output stream/frame count are the oracle.
- K `Program monitor accepts effect drops (layer under the pointer) and motion-template drops` — F/O: drop target routing fails; requested effect history and added template clip are the oracle.
- K `Re-render Motion Graphics (command palette) → the Program badge reports the fframes render` — F/O: command cannot request a ready MG render; visible ready state after command is the oracle.
- D `no uncaught page errors so far` — log-only probe after the workflow has concrete assertions.

### `e2e/text-animation.spec.ts`

S: S11 §11 test 2, TXA-013 and the documented RTL/hidden-editor review defects in `docs/wp-notes/wp-m2-text-anim.md`. I: Graphics/animation UI, Program pixels, MCP and rendered media. R: glyph/caret checks use actual Chrome geometry for a recorded visual regression; export and Program checks use pixels, not DOM snapshots. L: timing unit tests cannot prove browser shaping, UI selection, hidden-editor recovery or media parity. Artifacts: `test-results/e2e-text-animation/` MP4, still PNG, Program screenshots, contact sheet, `rtl-caret.json/png`.

- D `setup: Graphics ▸ New Layer ▸ Text adds a selected text clip` — independent setup-only stage duplicated text insertion in smoke; setup moved into the following animation workflow.
- K `Motion Templates ▸ Text Animations: Slide Up (word) as In and Fade as Out` — F/O: UI cannot apply distinct In/Out presets; selected cards and saved animator sides are the oracle.
- K `the Program animates the title; revisiting a frame gives identical pixels` — F/O: animation is static or seek-order dependent; visible mid/rest/out pixel relationships and repeated frame are the oracle.
- K `razor: the left part keeps In only, the right part Out only; undo/redo` — F/O: split misassigns animators or undo fails; original In/Out sides and split boundary are the oracle.
- K `TXA-013: char units at the window boundary sit on the glyphs of the plain text (≤ 1 px)` — F/O: glyphs jump when animation ends; actual browser Range bounds at the adjacent frames are the independent oracle.
- R `export: the mid-In frame matches renderStill (≤ 3/255 on 99 % of the pixels)` — F/O: export/still diverge or returning from hidden Export mode shows rest text until another seek; rendered video/still pixels and the identical Program frame before/after hiding are the oracle.
- K `MCP: list_text_animations, set_text_animation and render_frames on the open editor` — F/O: MCP tools do not edit live state or return a PNG; requested preset/frames and History are the oracle.
- K (new regression) `RTL typewriter keeps the caret and neutral punctuation on the visual left` — F/O: caret or `!` appears on the wrong visual side; Chrome's caret/word/punctuation rectangles for `שלום! עולם` are the independent oracle.
- D `no uncaught page errors` — broad log probe, no contract-specific failure.

### `e2e/tracking.spec.ts`

S: S09 §8 item 6/TRU-001…004. I: Properties/Program gestures, engine job, document query. R: asserted tracker samples, keyframes and undo are caller-visible state, not OpenCV internals. L: browser pointer and async job-to-session integration are distinct from tracking math tests. Artifact: `test-results/e2e-tracking.png` plus stored tracker samples/keyframes.

- D `set up: plate on V1, still on V2` — agent-created fixtures only; moved into the first retained tracker action.
- K `add a planar tracker and drag a corner on the Program monitor (one History entry)` — F/O: tracker is absent or pointer adjustment misses its corner; requested drag and one undo entry are the oracle.
- K `Track Forward runs an engine job with a live overlay and commits one "Track" entry` — F/O: job fails/no samples/live overlay; plate fixture and nonempty tracked sample span are the oracle.
- K `Apply to… Corner Pin bakes keyframes onto the still (one "Apply Tracking" entry)` — F/O: tracked motion cannot be applied to still; generated corner-pin keys and one entry are the oracle.
- K `drag a corner-pin handle at a frame: the keyframe there changes (one entry)` — F/O: overlay drag misses a key; chosen frame and prior key position are the oracle.
- K `the undo chain restores each step` — F/O: transaction history does not restore tracker/pin state; recorded pre-action states are the oracle.

### `e2e/transitions.spec.ts`

S: S10 §8 test 5 and transition UI contracts. I: Effects/Effect Controls, Program pixels and decoded exported MP4. R: final output checks actual fade to black; source setup/tooltip markup alone is not the oracle. L: real pointer/keyboard-to-native-export flow is distinct from transition command math. Artifacts: `test-results/e2e-transitions-*.png` and `e2e-exports/transitions-native.mp4`.

- D `setup: project, two clips with media handles meeting at a cut` — agent fixture stage moved into first retained transition test.
- K `drag Cross Dissolve from the Effects panel onto the cut → drawn, Program shows the mix; Ctrl+Z removes it` — F/O: drop/mix/undo fails; known red/blue media around cut and purple mixed Program pixels are the oracle.
- K `Ctrl+D at the playhead near the cut adds the default transition (one entry)` — F/O: keyboard shortcut misses cut or duplicates history; chosen cut and default Cross Dissolve are the oracle.
- K `dragging its right edge lengthens it; the tooltip shows the new duration` — F/O: duration drag fails; old duration and pointer displacement are the oracle.
- K `Effect Controls Transition section changes the type to Dip to Black` — F/O: chosen transition type does not persist; user's selection and document effect ID are the oracle.
- R `native export of the sequence with the transition succeeds` → `native export contains the Dip to Black transition` — F/O: export succeeds but omits transition; decoded center luma at the cut must be less than half the red and blue sides, and frame count must match the sequence.
- D `no uncaught page errors` — generic log probe with no transition-specific assertion.

### `e2e/desktop/clipboard.desktop.ts`

S: CLB-002/010 OS clipboard rules. I: two separate Electron processes plus an independent clipboard helper, with real IPC and CDP-driven UI. R: checks resulting clips/media, not Electron handler names or source text. L: web clipboard tests cannot exercise the OS format or file-manager payload. Artifact: `test-results/e2e-desktop-clipboard.png` and B's project document.

- K `copy in app A, paste in app B through application/x-jasper-clipboard (CLB-002)` — F/O: OS custom format does not transfer or either UI paste path fails; A's supplied text and B's new clips are the oracle.
- K `external text from another app: Ctrl+V adds a text clip (CLB-010)` — F/O: text from a separate process is ignored; helper text and B's clip are the oracle.
- K `external image data: Ctrl+V and Edit ▸ Paste import "Pasted image <time>" (CLB-010)` — F/O: either route loses image bytes; helper images and resulting still clips are the oracle.
- K `files copied in a file manager: Edit ▸ Paste and Ctrl+V register them in place and place them (CLB-010)` — F/O: OS file lists are not imported in place; supplied paths, registered media and clips are the oracle.
- D `no renderer crashes` — a broad regex over process logs is a false-positive/false-negative change detector; the four actions assert actual results. Removed its `App.out`/`App.name` bookkeeping.

## Executable checks and support

- R `e2e/desktop-smoke.mjs` — ARCHITECTURE §15 item 11/D-17 desktop start/security contract. CDP observes actual Home, saves `test-results/desktop-{dev,packaged-like}.png`, then navigates the renderer to a hostile `data:` origin with preload still callable. The actual `jasper:mcp-info` and clipboard handlers must allow a seeded round trip on app origin and deny disclosure/write/read on hostile origin. `test-results/desktop-*-ipc.json` records observed booleans, not constants. This detects missing `fromApp` checks via the real IPC seam, survives identifier renames, and is the lowest integration check for Electron origin enforcement. Replaced test-only screenshot/exit environment flags; `apps/desktop/src/main.ts` hook removal is owned by the scripts/desktop audit.
- K `e2e/desktop-clipboard.mjs` — package command wrapper for the four OS clipboard tests; its build and xvfb launcher are used by `pnpm e2e:desktop-clipboard` (not an extra assertion scenario).
- K `e2e/desktop/clipboard-helper.cjs` — independently writes external OS clipboard text, images and file lists for the desktop tests; the real file/clipboard payloads, not a mock paste callback, are necessary.
- K `e2e/mg-fallback-check.mjs` — ARCHITECTURE §15 item 9. Two built engines with a real/missing jasper-mg binary must plan native/Remotion respectively and explain the blocker. HTTP capability/planner response is the stable config seam; neither a unit planner test nor source grep covers deployment discovery. Saves observed `test-results/e2e-mg-fallback.json`.
- K `e2e/packaged-lgpl-check.mjs` — ARCHITECTURE D-13 and LGPL packaging/security contract. Packed resources outside the checkout, poisoned PATH, real Remotion export and packaged ffprobe must prove LGPL-only operation; package output/API/video are independent oracles. Saves `test-results/e2e-packaged-lgpl.{mp4,json}`.
- K `e2e/serve.mjs` — Playwright web server called by `playwright.config.ts`; temp appdir prevents project state leakage, and `e2e-server.json` lets MCP suites connect to that same engine. It is harness support, not a test disposition.
- K `e2e/support.ts` — only helpers used by retained browser workflows remain. D `watchPage` and all error-only watcher state: no production caller, and no contract-specific oracle. Other exports have retained spec callers (`rg`/TypeScript check).
- K `e2e/tsconfig.json` — the package's `pnpm e2e:typecheck` gate.

## Validation performed in this area

- `E2E_PORT=48652 pnpm exec playwright test e2e/text-animation.spec.ts`: 7/7 passed, including hidden-editor and RTL regressions.
- `E2E_PORT=48674 pnpm exec playwright test e2e/anime-templates.spec.ts`: 5/5 passed with decoded Program effect pixels and export/still parity.
- `E2E_PORT=48111 pnpm exec playwright test e2e/anime-templates.spec.ts --grep 'out-of-canvas callout' --output /var/lib/orquester/tmp/jasper-clipping-e2e`: 1/1 passed with Program PNG and ProRes MOV artifact; isolated scope while the parent runs the other E2E files.
- `E2E_PORT=48656 pnpm exec playwright test e2e/transitions.spec.ts e2e/pwa.spec.ts e2e/editing.spec.ts e2e/anime-templates.spec.ts`: 19/19 passed before the final anime effect rewrite; the final anime suite is separately validated above.
- `DESKTOP_SMOKE_PORT=48630 node e2e/desktop-smoke.mjs packaged-like` and `DESKTOP_SMOKE_PORT=48634 node e2e/desktop-smoke.mjs dev`: passed after removal of the production screenshot hook; packaged-like was rerun with seeded clipboard and hostile IPC probes at port 48638 and passed.
- `E2E_SKIP_BUILD=1 pnpm e2e:desktop-clipboard`: 4/4 OS clipboard tests passed after support cleanup and screenshot artifact addition.
- `MG_CHECK_PORT=48670 node e2e/mg-fallback-check.mjs`: passed both capability states and plan paths.
- `pnpm e2e:typecheck`, `pnpm exec biome check e2e`, `git diff --check -- e2e`: passed after the E2E changes.

The full Playwright suite and packaged LGPL check remain integration gates for the parent agent because they require the final combined build and, for packaged LGPL, an unpacked desktop distribution.

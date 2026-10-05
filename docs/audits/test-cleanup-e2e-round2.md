# Completed E2E cleanup — round 2 disposition ledger

Recorded before edits against merged origin/main 87ebec9. This ledger re-evaluates current tests; historical deletions are not counted again.

Each retained row uses the file S/I/R/L below plus its F/O explanation: (1) S is independent requirement; (2) F is recognizable failure; (3) O is user input, fixture media, protocol bytes or cross-renderer agreement, never copied implementation logic; (4) I is stable public seam; (5) R survives internal refactors; (6) L identifies unique integration ownership and stronger lower coverage. UI selectors locate actions, not an asserted tree. Exact settings and output media dimensions are data contracts; browser glyph positions survive only explicit TXA-013/RTL regressions.

Risk: deletion gives up change detection for private layout, inventories, labels and vacuous probes, retaining public workflow failures. No production seam is invoked solely to retain these tests: in-page jasper API is the documented agent interface; API endpoints have web/MCP production callers. Export/still APIs are distinct caller interfaces whose frame agreement is specified independently. Support helpers serve remaining specs. Validation: pnpm e2e:typecheck; pnpm exec biome check e2e playwright.config.ts playwright.desktop.config.ts; root exclusively runs integrated pnpm e2e and desktop/packaged gates. Every retained serial scenario leaves a screenshot or decoded export artifact; new mg-text screenshots supplied.

## e2e/agent.spec.ts

S: ARCHITECTURE §11 and §15 item 10, `docs/wp-notes/wp-mcp.md` (live/headless MCP, approval). I: built stdio MCP, browser UI, and documented agent queries. R: no assertion on MCP wrapper call count or private component tree. L: unit MCP/engine tests cannot prove an external process updates an open browser and approval card. Artifact: `test-results/e2e-agent-live.png` plus the project created by the running engine.

- KEEP `the MCP server finds the running engine and sees the open editor` — F/O: an external MCP client cannot discover the live project; the open project ID and tool response must agree.
- REWRITE `apply_commands with the editor open places a clip and a marker live, as one "Agent:" History entry` — F/O: a successful MCP response with no visible clip/marker or separate undo entries fails; the requested clip and marker and one transaction are the oracle.
- REWRITE `helper tools, get_timeline, set_playhead and undo work against the live editor` — F/O: tool edits or queries disagree with the open timeline; requested frame/text and undo state are the oracle.
- REWRITE `a destructive transaction waits for the approval card; Deny rejects it, Approve applies it` — F/O: unauthorized track removal or approval that does not apply fails; the explicit deny/approve decisions and resulting track state are the security oracle.
- REWRITE `Help ▸ Connect an AI Agent… shows configuration with the real path of jasper-mcp` — F/O: copied launch configuration cannot identify the bundled MCP entry; filesystem path and launcher contract are independent of UI copy.
- KEEP `with the editor closed the tools apply headlessly; open_project_in_editor brings the project back` — F/O: closed-editor changes disappear or reopen misses them; persisted marker/document state is the oracle.

## e2e/anime-core.spec.ts

S: S11 acceptance 8/FIX-010 and legal third-party disclosure. I: built About dialog and notices link. R: assertion concerns license identity/text and working link, not layout. L: browser disclosure is not proven by a notice generator unit test. Artifact: `test-results/e2e-anime-licenses.png`.

- KEEP `Help ▸ About lists anime.js (MIT, licence text) and opens the third-party notices` — F/O: missing/wrong MIT disclosure or broken notices navigation fails; the package's license and shipped notice content are independent sources. Removed the pinned animejs version string from the assertion.

## e2e/anime-templates.spec.ts

S: S11 §11 test 3, `docs/wp-notes/wp-m2-anime-templates.md` (including Review fix #1), S05:ECP-008. I: template gallery, Properties/Effect Controls, Program pixels, engine export/still APIs. R: decisive visual assertions use decoded pixels, not a template SVG/markup tree. L: lower-layer timing and property tests do not prove drag/edit/preview/export wiring or the documented browser clipping defect. Artifacts: `test-results/e2e-anime-templates/anime-effect-{before,blurred,pinned}.png`, `anime-templates.mov`, still PNG, `callout-clipped-program.png` and `callout-clipped.mov`.

- KEEP `dragging a title-reveal template onto the timeline shows it in the Program` — F/O: a visible gallery card cannot create a template clip or preview; the requested template identity and visible Program frame are the oracle. Badge, hover subtree, card count and derived default duration were removed.
- KEEP `edit the title text and colour in Properties` — F/O: edited title/colour fails to appear in document and Program; user input is the independent oracle.
- KEEP `keyframe a colour param with the stopwatch: the Program colour changes over time` — F/O: stopwatch fails to key or Program accent stays constant; blue first key, green second key, and intermediate decoded screenshot pixels are specified by user edits. Removed SVG `stroke` attribute assertions.
- KEEP `Gaussian blur and corner pin visibly change the template in the Program` — F/O: blur must reduce rendered edge energy; moving a corner must change more than 1,000 actual Program pixels. This replaced `data-effect`, SVG and `matrix3d` shape checks; exported media/still parity continues the same scenario.
- KEEP `export (native with layer-bake, else Remotion) matches renderStill` — F/O: planner selects the wrong path, export is blank, or export/still differ on an animated frame; capability, visible title and decoded frame agreement are independent observations.
- KEEP `an out-of-canvas callout is clipped in the Program and exported frame` — F/O: a callout label at `labelX: 0.95` and 50% scale leaks red pixels beyond its specified canvas in the Program, or export loses the visible portion; the documented canvas crop at x=75% of a centred half-scale layer, a visible red strip inside it, and absence of red outside it in both independently rendered outputs are the oracle. It uses the public agent transaction for fixture setup, browser screenshot and actual exported video frame. A DOM/CSS refactor preserving the rendered crop passes; no lower test observes the historical preview/export mismatch.

## e2e/clipboard.spec.ts

S: S01 §20, CLB-007/010, S03:XF-050/EC-023 and `docs/wp-notes/wp-clipboard.md`. I: keyboard/context menus, OS clipboard, document query and selection APIs. R: outcomes concern pasted data, timing, selection and navigation, not clipboard helper calls. L: the web unit suite owns payload transformation; these rows own UI routing and cross-tab transfer. Artifact: `test-results/e2e-cross-project-clipboard.png` and the second project's document.

- REWRITE `Ctrl+C / Ctrl+V on the timeline: new ids, every M2 field kept, copies selected, playhead at their end` — F/O: pasted clips lose fields/identity or focus; original clip values and new identity are the oracle.
- KEEP `Undo removes the paste; Redo restores it with the copies selected` — F/O: undo/redo or selection recovery fails; the original and pasted clip sets are the oracle.
- KEEP `Paste Insert (Ctrl+Shift+V) ripples later clips on the destination and sync-locked tracks` — F/O: insert overwrites or desynchronizes; later clip start and linked-track alignment are the oracle.
- DELETE `Paste Attributes… (Ctrl+Alt+V): the dialog lists the copied attributes; only the checked ones paste` — Asserts inventory and changed opacity, never checks unchecked motion remains unchanged. Web dialog test already owns selected-attribute behavior.
- REWRITE `Program monitor right-click on a layer: Copy, then Paste from the menu (XF-050)` — F/O: monitor action misses the layer or paste fails; resulting new clip is the oracle.
- DELETE `Effect Controls: copied keyframes paste at the playhead keeping their spacing (EC-023)` — Only key count and label asserted, so wrong spacing/value passes. Lower web clipboard command tests verify actual key timing and source/target behavior.
- DELETE `Project panel: a copied sequence pastes as a deep copy with new ids (CLB-007)` — Only sequence count/history label checked, so shallow copy passes. Project clipboard command tests own deep identity preservation.
- KEEP `cross-project paste in another tab through the system clipboard (media resolved by fingerprint)` — F/O: second project cannot resolve the media or aliases first-project ID; matching media fingerprint and fresh ID are the oracle.
- KEEP `Program monitor layer menu: Fit to Frame, Anchor ▸, Arrange ▸, Reveal in Timeline / Project (XF-050)` — F/O: each menu action fails its visible/document effect; centred fit, visually stationary anchor change, track order and selection/navigation are the independent outcomes.
- KEEP `external text: Ctrl+V on the Timeline adds a 5 s centred text clip at the playhead, one undo step (CLB-010)` — F/O: external text is ignored/misplaced; clipboard text and playhead are the oracle.
- KEEP `external image data: Edit ▸ Paste imports "Pasted image <time>" and places it at the playhead (CLB-010)` — F/O: image bytes are not imported/placed; the supplied image and playhead are the oracle.
- KEEP `an OS file in a paste event is imported under its name and placed (CLB-010, LIFE-010)` — F/O: file paste loses path/media; supplied file and placement are the oracle.
- KEEP `text fields keep their own paste (CLB-010 never hijacks inputs)` — F/O: global shortcut steals text input; entered text remains in the focused field.

## e2e/color.spec.ts

S: S06 §9 and the documented Lumetri/Scopes workflow. I: Color workspace controls, Program canvas pixels, chart/LUT fixture. R: assertions concern edits/undo, real scope pixels and CPU/WebGL output parity, not row component counts. L: UI edit/undo wiring is distinct from project command tests. Artifact: `test-results/e2e-color.png`. The shader/CPU oracle and blank-trace probe were deleted.

- REWRITE `Color workspace with a graded clip: Lumetri edit = one history entry` — F/O: slider/look/curve edits fail, duplicate effects appear, or undo fails; user input and prior clip state are the oracle.
- DELETE `Lumetri Scopes draws a trace of the selected clip` — Static axis labels exceed the bright-pixel threshold even with no scope data; wrong-reason pass. Scope math tests own numerical traces.
- DELETE `the Program monitor layer canvas equals the TS reference within 1/255 on 99.5 % of the chart (${stage})` — Expected pixels are computed by production bakeColorRun/applyLut; auto can run the same color math. Violates independent oracle. Remove paired auto/webgl cases and now-unused LUT/FFmpeg test helpers. Engine export/CPU tests retain independent fixed-fixture color contracts.

## e2e/desktop/clipboard.desktop.ts

S: CLB-002/010 OS clipboard rules. I: two separate Electron processes plus an independent clipboard helper, with real IPC and CDP-driven UI. R: checks resulting clips/media, not Electron handler names or source text. L: web clipboard tests cannot exercise the OS format or file-manager payload. Artifact: `test-results/e2e-desktop-clipboard.png` and B's project document.

- KEEP `copy in app A, paste in app B through application/x-jasper-clipboard (CLB-002)` — F/O: OS custom format does not transfer or either UI paste path fails; A's supplied text and B's new clips are the oracle.
- KEEP `external text from another app: Ctrl+V adds a text clip (CLB-010)` — F/O: text from a separate process is ignored; helper text and B's clip are the oracle.
- KEEP `external image data: Ctrl+V and Edit ▸ Paste import "Pasted image <time>" (CLB-010)` — F/O: either route loses image bytes; helper images and resulting still clips are the oracle.
- KEEP `files copied in a file manager: Edit ▸ Paste and Ctrl+V register them in place and place them (CLB-010)` — F/O: OS file lists are not imported in place; supplied paths, registered media and clips are the oracle.

## e2e/editing.spec.ts

S: ARCHITECTURE §15 items 2–7, S02 timeline/transport contracts. I: keyboard/mouse UI, public session query, rendered filmstrip/waveform. R: decisive assertions concern clip timing, history, visible pixels and transport state; font/theme/tab inventories were removed. L: browser gestures and keyboard focus cannot be proven by project command tests. Artifact: `test-results/e2e-editing-text-transform.png`.

- KEEP `Backquote maximizes and restores the timeline` — F/O: Backquote does not toggle the visible timeline view; the documented shortcut's two states are the oracle. Deleted presentation inventories and exact font/theme checks.
- KEEP `drop clip-a on V1: filmstrip and waveform are drawn` — F/O: drop or derivative drawing fails; imported video/audio fixture and nonempty timeline pixels are the oracle.
- KEEP `Ctrl-drop inserts clip-b at 5 s and ripples the sync-locked tracks (one History entry)` — F/O: wrong edit mode or lost A/V sync; fixture order and linked clip starts are the oracle.
- KEEP `transport: timecode entry, ←/→ steps, L/K/J shuttle` — F/O: keyboard transport/frame entry fails; requested timecode and direction changes are the oracle.
- KEEP `Ctrl+K adds an edit at the playhead on targeted tracks (one History entry)` — F/O: untargeted track cut or missing cut; target selection and playhead are the oracle.
- KEEP `Delete lifts, Shift+Delete ripple-deletes; Ctrl+Z restores the clip and its selection` — F/O: wrong gap/ripple/undo state; pre-edit clip and selection are the oracle.
- KEEP `B (ripple edit tool) trims the tail and ripples later clips; Ctrl-move inserts; S toggles snapping` — F/O: gesture modes produce wrong timing; neighboring clip boundaries and toggle state are the oracle.
- DELETE `Graphics ▸ Text adds a text clip; Properties scrub is one undo step; Program overlay move/scale/rotate` — Only history labels/counts establish scrub/move/scale/rotate success; no changed transform is checked. Shape/tracker gestures and session transactions cover real edits. Deletes the implementation-shaped action probe and its setup.

## e2e/layer-bake.spec.ts

S: S11 §6/§11 test 4 and FIX-002. I: UI, Program preview, engine jobs and decoded MP4. R: outputs are a visible graded title and actual exported pixels, independent of internal cache layout. L: built-app title editing and final hybrid media path need one E2E integration owner. Artifact: `test-results/e2e-exports/layer-bake.mp4`.

- KEEP `footage, a static title after it and a keyframed title (Effect Controls stopwatch)` — F/O: UI cannot set keyframed opacity; the requested two key values and timeline clips are the oracle.
- REWRITE `a Lumetri grade on the static title: "Grade pending", then the graded preview in the Program (FIX-002)` — F/O: grade remains pending or preview is ungraded; nonblack but darkened Program pixels are the oracle.
- REWRITE `Auto exports `hybrid`: one PNG for the static title, a master for the keyframed one; pixels show both` — F/O: wrong export path or missing title/ramp; decoded video luma at specified times and child-job results are the oracle.

## e2e/media-cache.spec.ts

S: S04 CA-013/014/021 and docs/wp-notes/wp-m3-cachegc.md. I: UI preferences to actual engine cache API/filesystem. R: data/action outcomes remain valid after component, service or renderer refactors. L: Engine cache policy tests own GC classification, budget math and move crash recovery; deleted mocked web tests are weaker. F/O: Clean must preserve open project bytes; user-entered size/age/never limits must persist; location move must preserve cached data and restore default. Artifacts: test-results screenshots and rendered media.

- REWRITE `the Media Cache page shows the cache of the open project and cleaning keeps what it uses` — F/O: UI Clean Unused/confirmed Clean All must preserve bytes referenced by the open project. Imported clip cache files captured before action are the oracle. Remove table row count and incidental display copy.
- REWRITE `automatic cleaning settings: custom size limit and a per-kind limit are saved by the engine` — F/O: submitted 50 GiB total, 21 days, 12 GiB proxy maximum, never-expiring exports and 14-day logs must persist in API settings. Literal entered values are the oracle. Drop unrelated default logs/location snapshot.
- KEEP `Change… moves the cache to another folder and back (CA-021)` — F/O: requested directory must contain imported cache files, UI/API must report destination, restoring default must remove relocated cache. User path and real filesystem bytes are the oracle; engine lower tests own move crash recovery.

## e2e/mg-clips.spec.ts

S: S08 §8 test 4 and ARCHITECTURE D-19, including Remotion 4.0.499 page protocol. I: real imported bundle served to a browser iframe, UI, MCP, and rendered PNG. R: protocol globals are an external protocol contract; UI checks observe rendered text and preview state. L: unit mocks cannot verify the built bundle/page protocol or live preview. Artifact: `test-results/e2e-composition-preview.png` and `test-results/e2e-mg-host-protocol.json`.

- REWRITE `renderer-page protocol contract (Remotion 4.0.499) drives the fixture bundle frame by frame` — F/O: upgraded Remotion page cannot configure/seek or shows wrong frame; fixture title/opacity and pinned protocol version are the oracle.
- KEEP `import a Remotion project, insert a composition, live preview, props edit, preview WebM` — F/O: import/preview fails or the entered title misses S08's 500 ms live Program bound; fixture title, user-entered title and browser-visible iframe text are the oracle. The old Node wall clock included Playwright command/poll scheduling under host load; the rewritten test measures from Enter keydown to the rendered iframe title using browser `performance.now()` and animation-frame observation. It still drives the public Properties field, checks visible title and preview WebM, survives internal renderer changes, and is the sole browser owner of this latency contract.
- DELETE `MCP: import_mg_bundle → add_composition → set_composition_props → render_frame, as Agent History entries` — apps/mcp/test/compositions.test.ts owns real MG_E2E import/add/set/render_frame with PNG artifacts; agent.spec.ts owns external live bridge. Remove duplicate helper scenario/launcher.

## e2e/mg-texts.spec.ts

S: S08 MGU-005/§8.9, docs/wp-notes/wp-m3-mgtext.md. I: actual imported bundle in Chromium and canvas text editor. R: data/action outcomes remain valid after component, service or renderer refactors. L: Web unit owns simple commit/cancel; E2E owns real bundle measurement/font and browser contenteditable/iframe integration. F/O: typed text must preview/commit once, schema-invalid text must not commit, cancel must preserve value, actual embedded font must render. Artifacts: test-results screenshots and rendered media.

- REWRITE `Properties text editors: live preview while typing, one History step, layout warnings, embedded font` — F/O: fixture bundle must show typed text before commit, actual measured clipping must produce MG_TEXT_CLIPPED, schema-invalid text must not replace saved value, one Undo restores Ada Lovelace. Fixture manifest/text and supplied input are independent; real browser bundle measurement is unique ownership.
- REWRITE `double-click a text in the Program monitor edits it in place in the bundle font` — F/O: double-click must enter a focused editor with the loaded fixture Inter font; Escape must not commit; Ctrl+Enter commits literal multiline markup and bundle renders the unmarked words. User input plus fixture font are the oracle. Remove private visibility/markup span counts and font alias prefix.
- DELETE `more than 4 composition clips: editing on canvas takes a live host from the clip farthest from the playhead` — All clips have equal start, so cannot detect selecting the wrong farthest host. Private iframe/card counts and first-come implementation dominate. The earlier on-canvas workflow owns editability; rewritten runtime unit owns distinct-distance host eviction.

## e2e/processing.spec.ts

S: S07 §6 and acceptance §8 item 9. I: timeline menu, engine job, media version UI/settings API. R: outcome is derived media/undo and saved settings, not job callback shape. L: built processing executable plus editor transaction is a distinct integration path. Artifact: `test-results/e2e-processed-clip.png` and project document.

- REWRITE `Process Clip… (denoise) swaps the clip to the processed version in one undo step` — F/O: job does not replace clip or one undo fails to restore source; original media ID and requested process operation are the oracle.
- REWRITE `Media Version dropdown swaps and undoes` — F/O: version switch or undo fails; original/processed IDs are the oracle.
- REWRITE `Process Clip… with Smooth path (keyboard): explained options, job notes report the zoom and speeds` — F/O: Enter/arrow selection must leave dialog open and eventual media derivation must contain selected smoothpath plus vertical/rotation locks. PRC smoothpath documented defaults and checked inputs are the oracle. Remove help copy, default labels and job-note prose matching.
- REWRITE `Preferences ▸ Processing saves the remote settings and renders a probe result` — F/O: user-entered host, port, user and directory must be persisted by the engine. Remove the negative probe: unavailable runtime could make it fail for the wrong reason; poll API settings to observe completion.

## e2e/pwa.spec.ts

S: ARCHITECTURE §12/§15 item 12 and S05 §20 (installability, engine route bypass). I: production manifest, icons, browser service worker/cache and HTTP. R: checks use web platform responses, not service worker function names. L: worker unit route tests cannot prove registration/control in the served production build. Artifacts: `test-results/e2e-pwa-{manifest,service-worker}.json` from observed responses.

- REWRITE `manifest.webmanifest is linked, valid and its icons exist with the declared sizes` — F/O: app becomes un-installable or icons/file handler break; PWA manifest contract and PNG dimensions are the oracle.
- REWRITE `the service worker registers, activates and bypasses engine routes` — F/O: production worker fails to register/activate/control a reloaded browser tab; actual active script URL and browser controller are the independent web-platform oracle. Delete API-cache absence probe: asynchronous puts may occur after the check; the lower service-worker tests own route bypass.

## e2e/shapes.spec.ts

S: S11 shape/graphics acceptance, XF-061, SHP-005/008. I: Graphics menu/tools/Properties, public document query, MCP, Program and export pixels. R: decisive outcomes are geometry values and visible/exported shape, not internal helper calls. L: browser pointer modifiers and built export integration need a browser owner beyond command tests. Artifact: shape export and still under `test-results/e2e-exports/`.

- KEEP `Graphics ▸ New Layer ▸ Rectangle / Ellipse are enabled and insert shapes at the playhead (FIX-007)` — F/O: menu action inserts wrong/no shape; selected tool, shape type and requested frame are the oracle.
- KEEP `Rectangle / Ellipse tools: drag box, Shift = square, Alt = from the centre, Escape cancels (XF-061)` — F/O: pointer modifier geometry or cancellation fails; gesture endpoints and modifier rules in XF-061 are the oracle.
- KEEP `Properties ▸ Shape edits fill, stroke and corner radius (one undo step each, SHP-005)` — F/O: entered style fails to update or undo; chosen colours/width/radius and prior state are the oracle.
- REWRITE `Effect Controls ▸ Shape keyframes the size; the Program follows; undo/redo` — F/O: entered size keyframes or undo/redo are lost; explicit size values and frames are the oracle. Removed SVG path and CSS width checks; actual shape pixels are owned by the export workflow.
- DELETE `MCP add_shape applies live as one "Agent:" History entry (SHP-008)` — apps/mcp/test/integration.test.ts owns actual shape data/invalid input; agent.spec.ts owns live stdio bridge. Remove duplicate helper translation and its process launcher.
- KEEP `export: native with baked layers when the layer bake is ready, else Remotion; the frame matches renderStill` — F/O: shape disappears or export/still diverge; visible red pixel and decoded image comparison are the oracle.

## e2e/smoke.spec.ts

S: ARCHITECTURE §15 items 2–8/13, M1 golden path. I: Home/editor UI, imported fixture, public document query, ffprobe and decoded exports. R: decisive outcomes are workflow state and media, not panel layout; the redundant panel inventory was trimmed. L: this is the single broad UI-to-native/Remotion export flow. Artifacts: `test-results/e2e-exports/smoke-{native,mg-native,remotion}.mp4`.

- KEEP `Home → New Project opens the Editing workspace` — F/O: project creation fails or wrong default video preset is loaded; requested project and documented 1080p preset are the oracle. Removed panel-tree inventory.
- KEEP `import clip-a.mp4 through the file chooser → Project panel row with a poster` — F/O: import/poster generation fails; supplied media file and decoded poster are the oracle.
- KEEP `drag the item to the timeline → linked V1/A1 clips` — F/O: video/audio placement or linking fails; fixture's two streams, start and duration are the oracle.
- KEEP `Space plays the Program monitor, Space stops it; the monitor shows the frame` — F/O: transport does not advance/stop or Program is blank; fixture motion/test pattern are the oracle.
- KEEP `move, trim, razor: one History entry each; Ctrl+Z / Ctrl+Shift+Z` — F/O: linked clips desync or edit undo fails; pre-edit source bounds and requested pointer edits are the oracle.
- KEEP `export a media-only sequence with Auto → native ffmpeg path; ffprobe frame count matches` — F/O: planner/export loses media, audio or frames; sequence bounds and fixture streams are the oracle.
- KEEP `insert the lower-third@1 motion graphic from the Motion Templates panel (drag to V2)` — F/O: gallery drag fails to place a graphic on V2; selected card and drop target are the oracle.
- KEEP `motion graphic + footage exports with Auto → native (fframes master)` — F/O: MG disappears or path falls back unexpectedly; decoded lower-third region and expected native path are the oracle.
- KEEP `Type tool click in the Program monitor adds a text clip` — F/O: Program Type tool cannot create text; click and resulting text clip are the oracle.
- KEEP `with the text clip, the forced Remotion export succeeds` — F/O: Remotion path cannot render mixed text/media; output stream/frame count are the oracle.
- KEEP `Program monitor accepts effect drops (layer under the pointer) and motion-template drops` — F/O: drop target routing fails; requested effect history and added template clip are the oracle.
- DELETE `Re-render Motion Graphics (command palette) → the Program badge reports the fframes render` — Badge can already be ready before action; passes when command does nothing. Native MG export earlier proves actual rendering; palette dispatch is separately covered.

## e2e/source-range.spec.ts

S: S07 PRC-015…019, docs/wp-notes/wp-m3-inpoint.md. I: UI processing/version/relink to real decoded frame-code media. R: data/action outcomes remain valid after component, service or renderer refactors. L: Project source-range unit owns integer shifts; engine processing owns range metadata; neither proves chosen browser action displays original source frames. F/O: frame codes 20,25,30,39 must remain after processing/swap/relink; source offsets derive from fixed fixture frames. Artifacts: test-results screenshots and rendered media.

- KEEP `Process Clip… on the clip range + handles swaps onto the range with identical frames` — frame codes 20,25,30,39 must remain after processing/swap/relink; source offsets derive from fixed fixture frames
- KEEP `switching back to the original (and to the range again) keeps the frames` — frame codes 20,25,30,39 must remain after processing/swap/relink; source offsets derive from fixed fixture frames
- KEEP `Replace Footage with a render of frames 10…63 and its sidecar keeps source timing` — frame codes 20,25,30,39 must remain after processing/swap/relink; source offsets derive from fixed fixture frames

## e2e/text-animation.spec.ts

S: S11 §11 test 2, TXA-013 and the documented RTL/hidden-editor review defects in `docs/wp-notes/wp-m2-text-anim.md`. I: Graphics/animation UI, Program pixels, MCP and rendered media. R: glyph/caret checks use actual Chrome geometry for a recorded visual regression; export and Program checks use pixels, not DOM snapshots. L: timing unit tests cannot prove browser shaping, UI selection, hidden-editor recovery or media parity. Artifacts: `test-results/e2e-text-animation/` MP4, still PNG, Program screenshots, contact sheet, `rtl-caret.json/png`.

- REWRITE `Motion Templates ▸ Text Animations: Slide Up (word) as In and Fade as Out` — F/O: UI cannot apply distinct In/Out presets; selected cards and saved animator sides are the oracle.
- KEEP `the Program animates the title; revisiting a frame gives identical pixels` — F/O: animation is static or seek-order dependent; visible mid/rest/out pixel relationships and repeated frame are the oracle.
- DELETE `razor: the left part keeps In only, the right part Out only; undo/redo` — Duplicates project animation split command contracts and smoke real razor/undo workflow. Later animation tests can use the original clip; the split is unnecessary setup.
- KEEP `TXA-013: char units at the window boundary sit on the glyphs of the plain text (≤ 1 px)` — F/O: glyphs jump when animation ends; actual browser Range bounds at the adjacent frames are the independent oracle.
- KEEP `export: the mid-In frame matches renderStill (≤ 3/255 on 99 % of the pixels)` — F/O: export/still diverge or returning from hidden Export mode shows rest text until another seek; rendered video/still pixels and the identical Program frame before/after hiding are the oracle.
- DELETE `MCP: list_text_animations, set_text_animation and render_frames on the open editor` — apps/mcp/test/integration.test.ts owns actual animation values/50-fps conversion and contact-sheet PNG plus metadata/artifact; agent.spec.ts owns live bridge. Remove duplicate helper scenario/launcher.
- KEEP `RTL typewriter keeps the caret and neutral punctuation on the visual left` — F/O: caret or `!` appears on the wrong visual side; Chrome's caret/word/punctuation rectangles for `שלום! עולם` are the independent oracle.

## e2e/tracking.spec.ts

S: S09 §8 item 6/TRU-001…004. I: Properties/Program gestures, engine job, document query. R: asserted tracker samples, keyframes and undo are caller-visible state, not OpenCV internals. L: browser pointer and async job-to-session integration are distinct from tracking math tests. Artifact: `test-results/e2e-tracking.png` plus stored tracker samples/keyframes.

- KEEP `add a planar tracker and drag a corner on the Program monitor (one History entry)` — F/O: tracker is absent or pointer adjustment misses its corner; requested drag and one undo entry are the oracle.
- KEEP `Track Forward runs an engine job with a live overlay and commits one "Track" entry` — F/O: job fails/no samples/live overlay; plate fixture and nonempty tracked sample span are the oracle.
- KEEP `Apply to… Corner Pin bakes keyframes onto the still (one "Apply Tracking" entry)` — F/O: tracked motion cannot be applied to still; generated corner-pin keys and one entry are the oracle.
- KEEP `drag a corner-pin handle at a frame: the keyframe there changes (one entry)` — F/O: overlay drag misses a key; chosen frame and prior key position are the oracle.
- KEEP `timeline glyphs: tracker badge and confidence strip on the plate, link on the still (S09:TRU-005)` — User-selected state must become document/rendered state; actual action and original data are the independent oracle
- KEEP `Simplify… reduces the tracked keys within the tolerance as one entry (S09:TRK-023)` — User-selected state must become document/rendered state; actual action and original data are the independent oracle
- KEEP `the undo chain restores each step` — F/O: transaction history does not restore tracker/pin state; recorded pre-action states are the oracle.

## e2e/transition-defaults.spec.ts

S: S10 TUI-031…035, docs/wp-notes/wp-m3-transdefaults.md. I: preferences UI, keyboard Ctrl+D, reload and stored document. R: data/action outcomes remain valid after component, service or renderer refactors. L: Project defaults unit owns setting validity; actual browser preference persistence and shortcut wiring require this scenario. F/O: selected Dip to Black/end alignment/12-frame duration apply and persist; fractional frames rejected; audio seconds round to frames. Artifacts: test-results screenshots and rendered media.

- DELETE `setup: project, two clips with media handles meeting at a cut` — Assertion-free user workflow setup through agent API is not independent test. Move body into first defaults workflow.
- REWRITE `Sequence ▸ Transition Defaults… opens Preferences ▸ Timeline with both scopes` — selected Dip to Black/end alignment/12-frame duration apply and persist; fractional frames rejected; audio seconds round to frames
- REWRITE `change the default video transition, alignment and duration; only the duration is in History` — selected Dip to Black/end alignment/12-frame duration apply and persist; fractional frames rejected; audio seconds round to frames
- KEEP `Ctrl+D at the playhead applies Dip to Black, 12 frames, End at Cut (one entry)` — selected Dip to Black/end alignment/12-frame duration apply and persist; fractional frames rejected; audio seconds round to frames
- KEEP `after a reload the project duration and the preferences are still there` — selected Dip to Black/end alignment/12-frame duration apply and persist; fractional frames rejected; audio seconds round to frames

## e2e/transitions.spec.ts

S: S10 §8 test 5 and transition UI contracts. I: Effects/Effect Controls, Program pixels and decoded exported MP4. R: final output checks actual fade to black; source setup/tooltip markup alone is not the oracle. L: real pointer/keyboard-to-native-export flow is distinct from transition command math. Artifacts: `test-results/e2e-transitions-*.png` and `e2e-exports/transitions-native.mp4`.

- KEEP `drag Cross Dissolve from the Effects panel onto the cut → drawn, Program shows the mix; Ctrl+Z removes it` — F/O: drop/mix/undo fails; known red/blue media around cut and purple mixed Program pixels are the oracle.
- KEEP `Ctrl+D at the playhead near the cut adds the default transition (one entry)` — F/O: keyboard shortcut misses cut or duplicates history; chosen cut and default Cross Dissolve are the oracle.
- REWRITE `dragging its right edge lengthens it; the tooltip shows the new duration` — F/O: duration drag fails; old duration and pointer displacement are the oracle.
- REWRITE `Effect Controls Transition section changes the type to Dip to Black` — F/O: chosen transition type does not persist; user's selection and document effect ID are the oracle.
- KEEP `native export contains the Dip to Black transition` — F/O: export succeeds but omits transition; decoded center luma at the cut must be less than half the red and blue sides, and frame count must match the sequence.

## Executable E2E checks and support

Re-read runtime scripts and retained their prior contract disposition: desktop-smoke (actual hostile-origin IPC and home screenshot); desktop clipboard helper/launcher (real OS interchange); mg-fallback-check (two real deployment configurations and JSON artifact); packaged-lgpl-check (isolated package, poisoned PATH, real LGPL encoded MP4 and JSON). These are protocol/security/config retention exceptions, have independent OS/media outcomes, survive identifier-only refactors, and are the lowest runtime seam. Config/serve/support are runners, not asserted inventories. No replacement tests are added.

## Detailed rewrite/dead-support notes

Clipboard drops masked nested-ID/deep-content reconstruction (project clipboard owner), menu inventories and duplicate sequence/keyframe/attributes cases. Processing drops pseudo-element badge implementation and help-copy inventory. Cache drops row count, cache prefix inventory and unrelated defaults. Composition text drops generic form counts, alias-font prefix, CSS visibility/markup trees and false host-budget test. Transitions drops tooltip/diagram/default badge inventory and setup-only test. Layer bake drops child-job/cache shape. PWA drops theme values and internal cache naming. Text animations drops card inventory and duplicate razor; export/RTL still operate on unsplit text. Color deletes implementation-derived parity section. Agent drops absent-panel/menu inventory and approval prose; public security code and state remain. Shapes drops CSS width oracle; keyframe values/undo and exported pixels remain.

Additional pre-edit findings (after production-owner inspection):

- DELETE color `Lumetri Scopes draws a trace of the selected clip`: its >50 bright pixels include static scale labels (`ScopesPanel.drawScope` draws these even with null samples), so a missing trace can pass. Scope math contracts remain in web tests; this probe is not a valid integration oracle.
- DELETE feature MCP flows in shapes, text-animation and mg-clips: MCP owner confirmed retained real integration tests own add_shape data/invalid input, animation persistence/50-fps conversion/render_frames PNG metadata, and MG_E2E real import/add/set/render_frame. They now save PNG artifacts. `agent.spec.ts` owns one actual external stdio-to-open-editor/approval scenario. Replaying each helper through browser contributes no unique failure seam; remove per-spec client launcher helpers/imports/project ID state.
- REWRITE processing preferences to saved user settings only: the probe's `false` can result from an unavailable runtime, not its claimed closed SSH port. Remove that negative assertion instead of preserving a wrong-reason pass. This leaves the actual settings API persistence contract.

## Final verification and generated families

- DELETE both generated color cases: `the Program monitor layer canvas equals the TS reference within 1/255 on 99.5 % of the chart (auto)` and `(webgl)`. Both used production `bakeColorRun`/`applyLut` for expected pixels; no independent fixed oracle.
- No production behavior changed. Removed test-only strip/idsIn payload reconstruction, badge pseudo-element reader, color PARITY_GRADE/decoder/reference imports, per-feature MCP launchers and unused project ID bookkeeping. Shared support has retained callers; no dead fixture or snapshot was introduced. Color localStorage backend override removal is coordinated with the compositions owner.
- `pnpm e2e:typecheck` passed after initial pruning; `pnpm exec biome check --write e2e playwright.config.ts playwright.desktop.config.ts` and `git diff --check -- e2e` passed after final pruning. Final typecheck and full runtime E2E gates are coordinated by root after all shared production edits.

## Integrated validation, 2026-10-05

Root confirmed repository build, lint, typecheck and final `pnpm e2e:typecheck` passed. Desktop validation against those current builds:

- `pnpm e2e:desktop`: packaged-like and dev smoke stages passed. Both saved Home screenshots and real IPC reports proving app-origin MCP/clipboard access and hostile-origin denial (`test-results/desktop-{packaged-like,dev}.png` and `desktop-{packaged-like,dev}-ipc.json`). The desktop clipboard stage also passed all 4/4 actual OS clipboard scenarios in 55.1 s, saving `test-results/e2e-desktop-clipboard.png`. The complete command exited 0.
- Unpacked desktop resources initially dated October 2, older than the current build. Refreshing the package from the October 5 build before running the LGPL packaged check avoids validating stale code.
- `node apps/desktop/scripts/package.mjs --dir --skip-build` passed using current built assets. Staging notices were current; the packaged LGPL guard checked all 10 FFmpeg artifacts successfully. The packed `engine.mjs` hash matches the current engine build.

- Packaged runtime assertions initially passed (30 H.264 frames using libopenh264, poisoned PATH untouched), but exit cleanup raced the still-running engine journal and emitted ENOTEMPTY. Before fixing: disposition REWRITE harness cleanup only; risk is temporary-directory leakage/log noise, no product behavior or contract assertion changes. Await actual engine termination before deleting its appdir, retain bounded forced termination and retry transient deletion errors. Revalidate with `pnpm e2e:packaged`.
- Final `pnpm e2e:packaged` rerun passed cleanly, exit 0, after awaiting engine shutdown. It exported exactly 30 H.264 frames via bundled `libopenh264`, confirmed LGPL resource binaries, and proved poisoned PATH FFmpeg/ffprobe were never invoked. Artifacts: `test-results/e2e-packaged-lgpl.mp4` and `test-results/e2e-packaged-lgpl.json`. Harness Biome and diff checks passed; the temporary directory left by the initial cleanup race was removed.

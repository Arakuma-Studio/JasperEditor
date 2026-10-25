# Browser test cleanup evidence

Scope: every non-`sound-*` browser spec, desktop clipboard specs, browser/desktop runners and shared `e2e/support.ts`. Sound specs and `sound-tap.ts` belong to the separate browser-sound workstream; `server-timeout.ts` belongs to tooling. No production files change.

## Retention bar

Each row below records the exact test, its independent source (C), the recognizable regression and oracle (R/O), and the unique browser boundary (U). All surviving tests observe public UI, public agent/HTTP APIs, downloaded files or browser/OS security/clipboard behavior (S). They make no private-call assertions, source greps, export inventories, snapshots of DOM/classes or wrapper counts, so an identifier-only/internal implementation refactor retains their assertions (F). Browser interactions are intentionally retained only where the row identifies browser/process/OS integration that a lower model/DSP/HTTP test cannot exercise. Setup calls are not the oracle. Literal data/format requirements, independently specified vectors, undo identity, deterministic cross-realm equality and before/after preservation invariants can all disagree with production.

Panel automation and agent coordinate mapping are public APIs, rather than incidental geometry. Glyph-shift/clipping/RTL geometry have explicit visual requirements or documented regressions. Manifest icon dimensions are an installation/wire-format requirement. WCAG uses axe's independent rule engine. Exact caption/title strings are supplied user data, not UI wording. The entry-bundle and lazy-editor recovery tests deliberately protect different download boundaries. Text measurements follow S11 TXA-010/013's DOM-text/shaping requirements: TreeWalker/Range observes actual glyph boundaries without asserting a span hierarchy or class tree. The compositions owner confirmed its fixed golden and seek/render cases do not replace the glyph-shift or browser RTL-caret oracles.

## Test-by-test dispositions

Paths below are repository-relative. All KEEP/OPTIMIZE/CONSOLIDATE rows inherit S/F above and identify their nonduplicated failure/independent oracle explicitly.

### `e2e/agent-ui.spec.ts`

Independent source: docs/wp-notes/mcp-cli.md (live UI tools) and docs/wp-notes/fixups.md (visible targeting).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| timeline mapping, then a clip dragged by an agent moves by the frames asked | KEEP | A real MCP synthetic drag must move V1 exactly 30 frames and undo to frame 0; catches lost coordinate-to-pointer dispatch despite pure geometry/command tests. |
| Program monitor mapping: sequence pixels ↔ window points | KEEP | The public locate/hit mapping must round-trip the supplied 960,540 sequence point inside the actual Program viewport within 2 px; catches browser scaling/offset wiring that model-only geometry cannot observe. |
| ui_set types into a scrubby number and the document follows | KEEP | Setting opacity 40 through discovered spinbutton must persist/evaluate 40 in the project; catches contenteditable/scrubby input integration, not merely a mocked set response. |
| ui_screenshot returns the window and a cropped panel | KEEP | Actual window and cropped-panel screenshots must be PNGs with bounded positive dimensions; catches DOM rasterization/cropping transport failures that mocked MCP output cannot see. |
| a clip running off the visible timeline is aimed at its visible part; one scrolled away is revealed (wp fixups) | KEEP | Offscreen and partially clipped clips must remain selectable through public agent targets; selection IDs and viewport membership catch overflow clipping and reveal regressions (fixups). |

### `e2e/agent.spec.ts`

Independent source: docs/ARCHITECTURE.md §11 (live editor/headless relay and undo).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| apply_commands with the editor open places a clip and a marker live, as one "Agent:" History entry | KEEP | A multi-command MCP transaction must reach the open browser immediately as one agent History entry, creating the requested clip/marker; catches live relay bypass and per-command undo fragmentation. |
| MCP edits render from the live editor and can be undone and redone | KEEP | The live MCP transaction must feed rendered PNG output, preserve view-only playhead history, and undo/redo the text independently; catches process/browser integration missed by handler tests. |
| with the editor closed the tools apply headlessly; open_project_in_editor brings the project back | KEEP | With the editor closed, MCP must edit the saved project headlessly and reopen it with both markers intact; catches stale lease/session routing and lost headless edits. |

### `e2e/anime-templates.spec.ts`

Independent source: docs/ARCHITECTURE.md §20.9 (anime templates clipped to their canvas).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| an out-of-canvas callout is clipped in the Program and exported frame | KEEP | Independently specified canvas clipping forbids red callout pixels outside the 50% template canvas in preview and decoded export; catches CSS/export boundary divergence, beyond template-value tests. |

### `e2e/audio-mix.spec.ts`

Independent source: docs/wp-notes/audio-mix.md (preview meters and voice-over capture).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| Audio Meters follow the preview mix | KEEP | Real preview playback must drive live loudness meters above −40 LUFS for the supplied tone; catches WebAudio/Player/worklet wiring that DSP unit vectors cannot exercise. |
| Voice-over: the fake microphone is recorded into A3 at the playhead | OPTIMIZE | A real fake-device microphone take must be imported into A3 with positive duration; catches capture/worklet/upload/track-placement failures. Replace 4.5 s sleep with playhead progress past the record point, preserving actual capture. |

### `e2e/bundle-loading.spec.ts`

Independent source: docs/ARCHITECTURE.md D-48 and docs/wp-notes/code-audit-web-shell.md (download recovery/offline cache).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| a failed editor download offers a reload | KEEP | A failed lazy editor chunk must show an error and reload to the editor after network repair; request interception supplies a real missing resource and shell visibility is independent of loader internals. |
| visited editor reloads online and offline | KEEP | After first visit, editor chunks must reload offline and allow continuing without engine, without page errors; catches service-worker cache coverage and offline-entry integration, distinct from download-error recovery. |

### `e2e/captions.spec.ts`

Independent source: docs/specs/03-monitors-effect-controls-rendering-items.md (captions/transcript) and docs/wp-notes/captions.md.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| File ▸ Import puts an SRT on a caption track; the Timeline shows the captions | KEEP | Import the supplied SRT through a real chooser and expose its words on the timeline at frames 15…60; catches file-import-to-track/time conversion integration. |
| Text ▸ Captions: edit text, search and replace, add a caption at the playhead, style the track | KEEP | Caption edits, search/replace, insertion at playhead and style changes must persist in document data; catches UI command dispatch paths absent from parser/model tests. |
| the Program monitor draws the caption under the playhead | REWRITE | Caption content under frame 30 must be visible in the actual Program renderer. The old text-content assertion also passed for a hidden caption; require the supplied caption text to be visible. One public playhead query also replaces 30 unrelated keyboard nudges; attach the actual Program caption screenshot. |
| Text ▸ Transcript: import, seek, search, select → Mark In/Out, Remove Fillers, Create Captions | KEEP | Imported transcript words must seek/select ranges, remove the supplied filler and generate the two expected captions; fixed words/times provide independent oracles for the complete workflow. |
| export: burned-in captions, embedded mov_text streams and an SRT sidecar | KEEP | Downloaded output must contain timed burned-in pixels, mov_text language/default dispositions and matching SRT text; ffprobe/ffmpeg/sidecar bytes catch three export deliverables that UI state cannot prove. |

### `e2e/clipboard.spec.ts`

Independent source: docs/specs/01-project-model-and-state.md CLB-002/010.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| cross-project paste in another tab through the system clipboard resolves linked media by fingerprint | KEEP | A real cross-tab OS clipboard paste must recreate linked A/V using equal fingerprints but fresh project media IDs; catches clipboard serialization/permission/resolution integration absent from pure payload tests. |
| Edit Paste imports an image from the browser clipboard and places it at the playhead | KEEP | A supplied 64×48 PNG on the browser clipboard must become a still at frame 0 through Edit Paste and registered media; catches binary clipboard-import/menu wiring. |

### `e2e/color-mgmt.spec.ts`

Independent source: docs/wp-notes/color-mgmt.md (fixed PQ graphics-white/linear-blend vectors and HDR output).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| Properties ▸ Colour: a PQ working space is previewed through the display transform | KEEP | A user-selected PQ working space must display graphics-white near 230/255 rather than raw PQ 148; fixed independently documented vector catches actual GPU display-transform wiring. |
| Blend using 1.0 gamma composites in linear light | KEEP | The linear-light option must display the documented neutral mix near 190/255, distinct from encoded 69; catches option-to-compositor wiring beyond color transfer functions. |
| the export writes 10-bit PQ ProRes with HDR tags and mastering metadata | KEEP | The downloaded ProRes must have 10-bit PQ/BT2020 tags, mastering/MaxCLL203 metadata and neutral working signal near 130; external probe/decode catches mux/export configuration mistakes. |

### `e2e/expressions.spec.ts`

Independent source: docs/wp-notes/expressions.md and docs/ARCHITECTURE.md (shared preview/export expression evaluator).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| typing an expression changes evaluated rotation at the requested frames | KEEP | Typing time*90 in the UI must evaluate 90.09 and 45.045 at the supplied 29.97 fps frames; literal results catch editor-to-evaluator wiring independent of parser implementation. |
| errors show under the field; a preset from the language menu replaces the text; undo | KEEP | An undefined expression must visibly error and fall back to 0; selecting a valid preset must clear it and undo restore the error expression; catches error-boundary/preset/history integration. |
| browser (editor page) and Node evaluate expressions bit-identically | KEEP | The same expressions must agree across real Chrome and Node realms and vary across 5 frames; cross-realm bit identity is the contract, not correctness of any individual math implementation, and unit tests cannot create that realm boundary. |

### `e2e/gaps.spec.ts`

Independent source: docs/specs/05-ui-shell-premiere-design.md A11Y-001 and docs/wp-notes/gaps.md (WCAG 2.1 AA).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| accessibility: [default] editing has no serious or critical axe violations | OPTIMIZE | The editing workspace under default contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [default] color has no serious or critical axe violations | OPTIMIZE | The color workspace under default contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [default] audio has no serious or critical axe violations | OPTIMIZE | The audio workspace under default contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [default] effects has no serious or critical axe violations | OPTIMIZE | The effects workspace under default contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [default] motion has no serious or critical axe violations | OPTIMIZE | The motion workspace under default contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [default] captions has no serious or critical axe violations | OPTIMIZE | The captions workspace under default contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [high-contrast] editing has no serious or critical axe violations | OPTIMIZE | The editing workspace under high-contrast contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [high-contrast] color has no serious or critical axe violations | OPTIMIZE | The color workspace under high-contrast contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [high-contrast] audio has no serious or critical axe violations | OPTIMIZE | The audio workspace under high-contrast contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [high-contrast] effects has no serious or critical axe violations | OPTIMIZE | The effects workspace under high-contrast contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [high-contrast] motion has no serious or critical axe violations | OPTIMIZE | The motion workspace under high-contrast contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |
| accessibility: [high-contrast] captions has no serious or critical axe violations | OPTIMIZE | The captions workspace under high-contrast contrast must have no serious/critical WCAG 2.1 A/AA axe violation. Each panel/theme combination exposes different controls or computed contrast; static DOM/unit tests cannot inspect actual browser colors/roles. Replace 800 ms sleep with visible loading completion; retain independent axe result and screenshot. |

### `e2e/imports.spec.ts`

Independent source: docs/wp-notes/imports.md (layered PSD and image-sequence import).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| a PSD imports as a sequence of its layers | KEEP | A real PSD chooser/dialog import must create a multi-layer sequence retaining a nonnormal blend mode; catches UI layered-import mode and command integration. |
| numbered stills import as one image sequence clip | KEEP | The supplied numbered stills imported at 12 fps must form one sequence with 12 frames and missing frame 7; catches grouping/dialog/upload metadata integration. |

### `e2e/interchange.spec.ts`

Independent source: docs/specs/04-media-render-and-backend.md (interchange) and packages/interchange public wire formats.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| File ▸ Export ▸ Final Cut Pro XML: options, job, report and download | KEEP | File Export must produce downloadable xmeml 4 XML with source names and rendered title reference; literal XML wire markers and requested content catch dialog/job/download integration. |
| File ▸ Import of an EDL whose media moved, then Link Media by folder | KEEP | An imported moved-media EDL must initially expose 2 pending assets then relink by folder to 2 adjacent equal-duration events; catches missing-media workflow/command integration. |

### `e2e/masks.spec.ts`

Independent source: docs/specs/03-monitors-effect-controls-rendering-items.md (mask editing) and S01 UND gesture transaction contract.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| dragging a vertex on the monitor is one undo step | KEEP | A real vertex drag must change only that vertex and commit one History entry; catches monitor-to-document coordinate dispatch and gesture coalescing. |
| the feather handle sets Mask Feather (one undo step) | KEEP | Dragging the feather handle must increase persisted feather above 20 in one History entry; catches the separate feather gesture path, not vertex movement. |
| the pen draws a closed free-form mask (click, click, click, click the first vertex) | KEEP | Three clicks and closure on the first vertex must persist a closed 3-vertex mask and finish the pen mode; catches interactive pen construction/closure absent from command tests. |

### `e2e/mg-clips.spec.ts`

Independent source: docs/specs/08-motion-graphics-clips.md MGC-021/022/023, MGU-001/002/003 and docs/security-review.md.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| renderer-page protocol contract (Remotion 4.0.499) drives the fixture bundle frame by frame | KEEP | A real bundled opaque-origin iframe must negotiate the supported renderer protocol, seek opacity 0→1, retain supplied props and reject parent/API/storage escape; external fixture pixels/state and browser security origin checks catch actual protocol/sandbox failures. |
| import a Remotion project, insert a composition, live preview, props edit, preview WebM | KEEP | User import/insert/props edit must reach a real composition frame host and ready preview, with a 500 ms tolerance for the specified prompt live-title update; catches UI→sandbox message/preview integration beyond direct protocol test. |

### `e2e/multicam.spec.ts`

Independent source: docs/specs/02-timeline.md (multicam/merge workflows) and docs/wp-notes/multicam.md.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| Project panel ▸ Create Multi-Camera Source Sequence… builds the source; placing it makes multi-camera clips | KEEP | The project-panel multicam creation action must build 2 angles and place nest-video clips; catches selection/menu/source-sequence integration. |
| Multi-Camera view (Shift+0): the grid next to the program; clicking a cell switches the clip | KEEP | Shift+0 must reveal actual angle cells and selecting camera 2 must change the project and undo to 1; catches grid/input binding absent from multicam commands. |
| live switching: keys while playing record cuts, committed as one undo step on stop | KEEP | Real playback camera 1→2→1 switches must persist cuts as one undo entry on stop; catches transport-time gesture integration not covered by paused switching. |
| Merge Clips… with audio: an unrelated recording is flagged before merging anyway | KEEP | An ambiguous steady-tone sync must warn before Merge Anyway creates a merged sequence; catches analysis-to-review gate wiring and user override. |

### `e2e/polish.spec.ts`

Independent source: docs/wp-notes/polish.md and docs/wp-notes/code-audit-web-shell.md (live language and entry-bundle recovery).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| Media Browser: browse the fixtures folder, preview a clip, import it in place | KEEP | Browsing the actual fixtures folder must preview a decodable 1280 px video and import it alongside the existing clip; catches filesystem/browser/player/import integration. |
| live language switches preserve the page, document and undo history | KEEP | Switching English↔Spanish in Preferences must preserve performance.timeOrigin, history and undo/redo marker data; catches reload/remount/session-loss regression beyond string catalogs. |
| a bundle that cannot be downloaded says so and reloads, instead of a blank page | KEEP | Failure of the initial app-entry script must show a reloadable app-load-error and recover Home; this precedes editor loading and is not superseded by the lazy-chunk test. |

### `e2e/processing.spec.ts`

Independent source: docs/specs/07-clip-processing.md (stabilize recipe).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| Process Clip… with Smooth path: keyboard selection submits the chosen processing recipe | KEEP | Keyboard-only stabilize method selection must persist smoothpath with both locks, run one processing edit and undo the source swap; catches keyboard-select/global-shortcut and recipe-submit integration. |

### `e2e/project-files.spec.ts`

Independent source: docs/project-files.md, S01 PER-021, docs/ARCHITECTURE.md (writer leases and restore backups).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| unsaved changes of a dead session are offered on open and recovered as one undoable step | KEEP | A real dead-session journal must be offered, recovered to 3 markers, removed from candidates and undone in one step; catches browser recovery lifecycle and data-loss paths beyond storage unit tests. |
| a reloaded tab reclaims its own lease even when the pagehide release is lost; other tabs stay locked out | KEEP | When pagehide lease release is dropped, the reloaded/reopened tab must remain editable while a second tab is read-only; actual browser identity storage/navigation is not reproducible by lease-store unit calls. |
| reload keeps the project editable; versions restore in place; Save As opens the new project | KEEP | Reload must preserve editability, restoring a version must write before-restore backup, and Save As must navigate to the new saved project; catches UI/session/storage coordination and backup retention. |

### `e2e/pwa.spec.ts`

Independent source: docs/specs/05-ui-shell-premiere-design.md (PWA installation/file handling) and Web App Manifest wire contract.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| manifest.webmanifest is linked, valid and its icons exist with the declared sizes | KEEP | The served manifest must be linked, installable, register `.jasper` handling and serve icons whose PNG dimensions match their declared sizes; browser/resource bytes catch build/serving errors, not source inventory. |

### `e2e/security-review.spec.ts`

Independent source: docs/ARCHITECTURE.md D-47 and docs/security-review.md DEV-1/AGT-1.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| only a trusted user can approve a destructive agent request; denial preserves the track | OPTIMIZE | Synthetic MCP input must never approve its own destructive request; denial yields E_APPROVAL_DENIED and preserves track while trusted approval removes it. Real event.isTrusted plus MCP relay distinguishes this from mocked handlers. Remove the 500 ms grace sleep: the awaited synthetic click and final E_APPROVAL_DENIED result already synchronize the transaction; a synthetic approval makes that final denial assertion fail. |
| DEV-1: the engine refuses requests without its token; the page is the editor through HttpOnly cookies | DELETE | Fails real-production regression/unique protection: cookie flags come from Playwright storageState itself. The 401/200 assertions duplicate actual-engine startup/pairing cases in `apps/engine/test/security-hardening.test.ts`; those check production Set-Cookie HttpOnly/Strict flags and authenticated jar access. Both desktop-smoke modes additionally verify script-inaccessible cookies created by actual Electron startup. The engine owner confirmed these stronger tests survive. |

### `e2e/smoke.spec.ts`

Independent source: docs/ARCHITECTURE.md §15 acceptance workflows and S01 undo/linked-edit contracts.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| create, import, edit linked footage, play, undo and export a native movie | KEEP | Critical create/import/linked-move/trim/razor/undo/redo/play/export flow must produce H.264/AAC at 1920×1080/30000:1001 with exact frame count; real chooser/pointers/player/download/ffprobe integration is unique. |
| insert a motion graphic and export it over footage with the native renderer | KEEP | Dragging a native motion graphic to V2 must render actual bright lower-third pixels over black plus correct output streams; guards optional native renderer integration and preserves the explicit unavailable-tool skip. |
| create a title with the Type tool and export through Remotion | KEEP | The Type tool must create text and export accumulated edits through real Remotion with valid exact-frame H.264/AAC output; this protects the user interaction and render route separately from native export. |

### `e2e/source-range.spec.ts`

Independent source: docs/specs/07-clip-processing.md PRC-015/016/017.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| Process Clip… on the clip range + handles swaps onto the range with identical frames | KEEP | Processing source 20…39 with 6-frame handles must preserve decoded frame codes 20,25,30,39 and persist range 14/32 plus remapped in-point; fixed source imagery catches timing drift beyond metadata-only tests. |
| switching back to the original (and to the range again) keeps the frames | KEEP | Choosing original/derived media versions must keep the same independently known decoded codes through both UI swaps; catches version-picker-to-source-time mapping integration. |
| Replace Footage with a render of frames 10…63 and its sidecar keeps source timing | KEEP | Replacing footage with a real range 10…63 render+sidecar must remap sourceIn and preserve decoded codes, then undo to the original; catches replacement sidecar chooser/engine/model coordination. |

### `e2e/text-animation.spec.ts`

Independent source: docs/specs/11-animation.md TXA-013 and docs/wp-notes/wp-m 2-text-anim.md Review fixes.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| TXA-013: character glyphs stay within 1 px of plain text at the animation boundary | KEEP | TXA-013 explicitly requires≤1 px glyph shift between animated and plain text; real Chrome text ranges/screenshot artifacts catch shaping/layout differences unavailable in happy-dom. |
| returning from Export preserves the paused animated title without another seek | OPTIMIZE | After real export hides/restores the editor at frame 8, paused Program pixels must exactly match the nonblank pre-export image. Keep rendering/movie artifact; shrink shared fixture 90→46 frames, leaving the entire 45-frame longest animation+rest. |
| RTL typewriter keeps the caret and neutral punctuation on the visual left | KEEP | The historical RTL typewriter regression requires caret/punctuation on the visual left; actual bidi browser geometry and supplied Hebrew text independently detect wrong direction/neutral ordering. |

### `e2e/time.spec.ts`

Independent source: docs/specs/02-timeline.md (time remapping/scene detection) and docs/wp-notes/time.md.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| Show Clip Keyframes ▸ Time Remapping ▸ Speed; dragging the band slows the clip down | KEEP | The user-selected Time Remapping speed band must slow the clip and lengthen it, then undo duration; catches real context-menu and pointer-band wiring. |
| Scene Edit Detection… cuts at the four hard cuts in one undo step | KEEP | Scene detection must cut the supplied fixture at independently specified 45/75/120/198 source frames (±1) as one undoable edit; external signal/cut timings catch analysis/dialog integration. |

### `e2e/transitions.spec.ts`

Independent source: docs/specs/10-transitions-ui.md (Effects drop, dissolve preview and undo).

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| drag Cross Dissolve from the Effects panel onto the cut → drawn, Program shows the mix; Ctrl+Z removes it | KEEP | Dragging Cross Dissolve onto a real cut must create the default 30-frame centered transition, produce purple red+blue preview and undo; fixed-color fixture catches rendered behavior not merely registered transition metadata. |

### `e2e/ui-audit.spec.ts`

Independent source: docs/wp-notes/mcp-cli.md (stable ui_elements addresses), S05 agent-accessible controls.

| Exact test | Disposition | Regression, independent oracle, and unique surviving boundary |
|---|---|---|
| every panel and every workspace chrome has stable automation ids | CONSOLIDATE | Every panel, workspace chrome, menu and clip context menu must expose stable public automation addresses. Audit each maximized panel once instead of repeatedly per workspace; retain all workspace chrome. Wait for actual visible panel-loading completion; remove duplicate second video fixture and cache the created title ID for setup selection. |

### Desktop and packaged execution boundaries

Independent sources: S01 CLB-002/010, ARCHITECTURE D-13/D-47, and §15 native/render acceptance. These use the OS/process/public HTTP seams directly and tolerate internal refactors. Browser clipboard tests cannot replace real Electron OS custom formats, file-manager transport or preload-origin enforcement.

| Exact test/harness | Disposition | Unique regression and independent oracle |
|---|---|---|
| `e2e/desktop/clipboard.desktop.ts` — copy in app A, paste in app B through application/x-jasper-clipboard (CLB-002) | KEEP | Two independent Electron apps must transfer supplied text at the requested playhead through both menu/custom format and native paste event; fixed text/start and actual OS payload catch transport failures. |
| `e2e/desktop/clipboard.desktop.ts` — external text from another app: Ctrl+V adds a text clip (CLB-010) | KEEP | External helper owns real OS text clipboard; supplied text must become a clip at playhead. Browser-to-browser custom payload cannot cover arbitrary external text. |
| `e2e/desktop/clipboard.desktop.ts` — external image data: Ctrl+V and Edit ▸ Paste import a new still at the playhead (CLB-010) | KEEP | Real external PNG bytes must become fresh media and still clips through both OS image/menu and event paths. Guards native PNG read/import, distinct from custom text payload. |
| `e2e/desktop/clipboard.desktop.ts` — files copied in a file manager: Edit ▸ Paste and Ctrl+V register them in place and place them (CLB-010) | KEEP | Actual GNOME copied-files URI transport must retain supplied paths and register/place their audio/video media; URL/file-manager handling is distinct from text/image data. |
| `e2e/desktop-smoke.mjs dev` | KEEP | Actual Vite/Electron dev startup must render Home, authenticate with script-inaccessible cookies and deny hostile-origin preload IPC while allowing the app. The built route cannot cover the dev proxy origin. |
| `e2e/desktop-smoke.mjs packaged-like` | KEEP | Built Electron must fork/serve the engine, render Home and enforce origin-bound IPC/auth without the dev server. Direct mocked Electron unit tests cannot prove the real sender frame. |
| `e2e/mg-fallback-check.mjs` | KEEP | Two actual built engines with present/missing native renderer must respectively plan native/Remotion and explain fallback. It protects runtime capability wiring rather than a mocked planner registry. |
| `e2e/packaged-lgpl-check.mjs` | KEEP | A copied packaged engine outside the checkout with poisoned PATH must render 30 H.264 frames using shipped LGPL/OpenH.264, expose license bytes and never execute poisoned tools. Source/package inventory checks cannot establish runtime provenance. |

## Infrastructure disposition

`e2e/support.ts` remains shared by both browser workstreams and desktop clipboard tests. Every exported helper has actual test callers; no export is a production testing hook. `expectNotCoveredByToasts` retains the documented real Export-footer regression (`docs/wp-notes/sound-design.md`, toast placement review); clicking the center alone would miss partially covered actions. `pointerDrag` retains animation-paced pointer updates because timeline gestures coalesce at animation frames. The voice-over wait is replaced with observed playback past the record point, not virtual time, because real browser audio capture is the contract. The explicit browser contexts in `gaps` and `polish` are now closed at teardown; closing only their pages left service workers and context resources alive in the reused Playwright worker. No snapshots, dependencies, production seams or fixtures become orphaned. The redundant second video is no longer imported by the automation audit but remains a required fixture for other workflows.

## Cost and validation

Audited 67 baseline source declarations: 60 KEEP, 1 DELETE, 1 REWRITE, 4 OPTIMIZE, 1 CONSOLIDATE. The accessibility declaration expands to 12 cases, so the browser/desktop runtime-case disposition is 60 KEEP, 1 DELETE, 1 REWRITE, 15 OPTIMIZE, 1 CONSOLIDATE (78 baseline cases; 77 survive). The four standalone harness executions are separately KEEP and are not counted as framework test declarations. Test LOC changed by **−15** across seven specs. No production code, dependencies, snapshots, physical fixture files, helper exports or runner configuration changed.

Measurement configuration: baseline `8b4c8936add15075d719686f0ba1255fd635f10b`; AMD EPYC-Genoa VM, 8 vCPUs, 15 GiB RAM; Node 20.19.0; pnpm 10.34.5; Chrome 156.0.8078.47. `JASPER_REQUIRE_ORACLES=1`, `JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome`, `E2E_PORT=48210`, workers=1, retries=0. Each run starts a fresh authenticated engine/appdir and browser; immutable builds and generated fixtures were current in all measured runs. The coordinator held other GL/FFmpeg waves; one other slot ran model tests. This is a shared VM, not an isolated benchmark host.

### Measured seven-spec subset

| Run | Cases | Playwright duration | Whole command wall time | Result |
|---|---:|---:|---:|---|
| Baseline, original specs | 28 | 162.170 s | 163.93 s | 28 passed, no skips/flakes |
| Optimized candidate, before removing duplicate auth case | 28 | 109.423 s | 111.00 s | 28 passed, no skips/flakes |
| Final retained suite | 27 | 111.050 s | 112.41 s | 27 passed, no skips/flakes |

The comparable whole-command saving is **51.52 s (31.4%)**. The two optimized runs differ by 1.41 s (≈1.3%), with one redundant ≈50 ms authentication case removed before the final run. There is one original baseline sample; these measurements do not establish long-term flakiness rates. They cover the seven changed specs, not the entire Playwright suite or repository gate. Default CI does not run Playwright, so no default-CI saving is claimed.

Sum of reporter case durations by file (not total file wall time; engine/worker setup and teardown also contribute to the whole-command result):

| Spec | Baseline | Final |
|---|---:|---:|
| `audio-mix.spec.ts` | 8.031 s | 4.341 s |
| `captions.spec.ts` | 15.424 s | 14.985 s |
| `gaps.spec.ts` | 43.362 s | 36.009 s |
| `polish.spec.ts` | 6.025 s | 6.600 s |
| `security-review.spec.ts` | 1.127 s | 0.622 s |
| `text-animation.spec.ts` | 21.880 s | 20.163 s |
| `ui-audit.spec.ts` | 37.452 s | 7.246 s |

Largest individual changes: automation audit **37.452 → 7.246 s**, voice-over **4.990 → 1.381 s**, paused-title export **15.437 → 12.747 s**. Automation scans fell **89 → 46**, retaining the exact same **27 panel kinds and nine workspace chrome sets**, menus and clip context menu. The audit no longer imports a second identical-kind video or repeatedly queries the title ID. Explicit `gaps`/`polish` contexts are closed; no aggregate process-tree memory reduction is inferred from timing-tool RSS samples.

The longest remaining cases are the real title export (12.747 s), caption export (9.211 s), Effects-workspace WCAG high-contrast scan (7.764 s), stable-address audit (7.246 s), default Effects WCAG scan (7.170 s) and glyph-boundary measurement (5.450 s). Their independent render/wire/accessibility/layout oracles are listed above; none was replaced with mocked output or moved out of an existing gate.

### Oracle and artifact checks

The before/after-export PNGs from **all three runs** (six images) are byte-identical, SHA256 `51c5d57593dd6d4e3ee9effeb68b590aebaa5b76415c8519292f47ae4514b271`. Shortening the title fixture from 90 to 46 frames retains its entire 45-frame longest animation plus a rest frame and preserves the measured frame 8 pixels exactly.

A temporary hidden-caption mutation injected CSS hiding the actual caption while preserving its text. The first two caption workflow cases passed; the rewritten Program assertion failed specifically **Expected: visible / Received: hidden**. The mutation was removed, then all 27 final cases passed. No mutation or shortened failure-probe timeout remains. The new `program-caption` image attachment was inspected: the supplied caption is visibly drawn over the generated color-bar footage. Keyboard routing and exact frame stepping remain owned by retained `apps/web/test/shell.test.tsx` and `transport.test.ts` cases, confirmed by the web owner.

Raw runner JSON, GNU time records, logs, preserved baseline artifacts and the small measurement summary are under `/tmp/jasper-test-cleanup/browser/` for this run. Normal screenshots, generated movies and final attachments are in ignored `test-results/`; they are not committed as new goldens or fixtures.

### Commands and outcomes

The actual measured command, run on original and final specs with a phase-specific `PLAYWRIGHT_JSON_OUTPUT_FILE` and `/usr/bin/time -v -o <phase>.time`, was:

```sh
JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome E2E_PORT=48210 E2E_SKIP_BUILD=1 pnpm e2e e2e/audio-mix.spec.ts e2e/captions.spec.ts e2e/gaps.spec.ts e2e/polish.spec.ts e2e/security-review.spec.ts e2e/text-animation.spec.ts e2e/ui-audit.spec.ts --workers=1 --reporter=json
```

`E2E_SKIP_BUILD=1` was used only after current artifacts had been built. Setup ran the normal `node scripts/e2e-prepare.mjs`: fixture generation, pinned LGPL download, engine and Remotion builds succeeded; native build explicitly skipped because cargo is absent. The Node 20 Vite build then hit its default ≈2 GiB heap limit (exit 134, 91.43 s setup attempt). With 13 GiB available on the host, the web-only retry below passed in 55.74 s (3.81 GiB max RSS); MCP then passed in 1.05 s. This initial setup failure and recovery are excluded from the comparable test-run timings. No repository heap setting changed.

```sh
NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/web build
pnpm --filter @jasper/mcp build
pnpm ffmpeg:check
NODE_OPTIONS=--max-old-space-size=4096 pnpm e2e:typecheck
pnpm exec biome check e2e/audio-mix.spec.ts e2e/captions.spec.ts e2e/gaps.spec.ts e2e/polish.spec.ts e2e/security-review.spec.ts e2e/text-animation.spec.ts e2e/ui-audit.spec.ts
git diff --check
```

All listed recovery builds, LGPL guard, E2E typecheck and targeted Biome/diff checks passed. The intentional mutation probe used the same environment with:

```sh
pnpm e2e e2e/captions.spec.ts --grep 'File ▸ Import puts|Text ▸ Captions:|the Program monitor draws' --workers=1 --reporter=json
```

That probe exited 1 as intended (two pass, one visibility failure, 11.908 s Playwright duration); it is not a green validation gate. The restored final 27-case run is green.

Fresh vendor binaries, fixtures and engine/web/MCP/Remotion output were made available for the separate browser-sound worktree after byte-comparing **2,246 tracked non-test build inputs**: both SHA256 `7295a4685a3e2493302cadce88e07d1166dfa476366db7b84a565618588dc507`. Reuse shares immutable artifacts, not appdirs or browser contexts. Its validation results are reported by that workstream.

No unchanged browser, actual Electron, packaged-app or native-render suite is claimed as executed here. Cargo is unavailable and no packaged app was assembled. Retention evidence for those cases is the source/contract audit above; integration-wide lint/typecheck/test/build gates belong to the parent workstream.

# Supplemental web-core audit B

Read-only review of the 30 paths in `/tmp/web-core-supplement-b.txt`, using the web-core worktree's current tests and targeted production owners. Implementation belongs to the web-core agent; this document does not claim to have edited or executed web tests. Root's baseline is still running, so no Vitest/build/typecheck was started here.

This rescan challenges the earlier `web1.md`/`web2.md`/`web3.md` ledgers rather than treating their repeated six-bar paragraphs as proof. Sources and actual oracles are listed below. No filename/regex match was used as a deletion verdict. Geometry below is retained only where a cited editing/viewport rule independently specifies coordinates, hit priority, time mapping or snapping; ordinary DOM layout inventories are not contracts.

For each retained row: (1) its independent requirement is the section source; (2) the literal failure/oracle is its row; (3) values come from arranged inputs, mathematical laws, protocol bytes or state transitions, not copied production algorithms; (4) the section names its production-used boundary; (5) outputs survive helper/identifier/component-layout refactors, with proposed identity/copy removals called out; (6) the section and row explain its distinct ownership. Mocks isolate external browser/engine responses; real command/session/UI code decides the asserted outcome. No generic KEEP is inferred from passing status. `REWRITE` and `OPTIMIZE` below are concrete proposals accepted/implemented by the coordinator where noted, pending integrated tests.

Two duplicate scenarios identified: the direct silent-flush `saveBeforeLeaving` test is superseded by the version-restore failure case that also asserts no destructive action and exact document preservation; the fixed nonzero-latency voice-over simulation duplicates the stronger independent simulation property. Both have stronger surviving owners, not mere assumptions of coverage.

## `apps/web/test/program-layer-menu.test.tsx`

Independent source: S03 XF-038/050/051; S02 TL-266. Stable seam/non-test caller: layer-ops pure patches; registered motion/arrange/reveal commands → committed document. Unique ownership/refactor basis: Cropped/rotated fit, anchor compensation and command selection/undo are distinct from generic model edits.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| fits the visible rect inside the frame, centred | KEEP | 1280×720 input fits at 150%; left-half crop centres at[480,540]. Detects crop-blind fitting, beyond the command smoke. |
| uses the rotated bounds, fills by the larger ratio, and Set to Native only sets 100% | KEEP | 90° bounds give 56.25% fit/177.7778% fill; Native sets 100%; fully cropped geometry refuses. Detects rotated/empty bounds. |
| moves the anchor to each grid point of the visible rect without moving a pixel | KEEP | Nine literal 90°/flipped/cropped anchor vectors preserve pixels. Commands only cover un cropped top-left. |
| Fit to Frame / Fill Frame / Set to Native: one step each, keyed at the playhead when animated | KEEP | Commands produce 150→150→100%, three undo entries, then insert 100 between 50/80 keyed values. Protects dispatch and keyed editing. |
| Reset Motion and Reset Crop reuse Remove Attributes; Reset Crop needs a crop | KEEP | No crop disables Reset Crop; reset clears rotation and removes the added crop. Protects capability gating and actual edit. |
| Anchor ▸ Top Left keeps the layer where it is | KEEP | Top-left anchor command yields[0,0] anchor/position; invalid point is invalid-args. Protects argument validation plus routing. |
| Arrange ▸ Bring Forward moves the video to a new track and leaves its linked audio alone | KEEP | Bring Forward changes only video track/time; linked audio stays and send Back restores order. Protects selected-link handling. |
| Bring to Front above the top track creates a video track (S02:TL-266) | KEEP | Bring to Front above V3 adds V4; undo returns three tracks. Protects structural edit integration. |
| Reveal in Project selects the media item and is disabled for sequence-only text | KEEP | Reveal selects imported project item; sequence-only text disables. Protects source-item lookup and unsupported action gating. |

## `apps/web/test/program-math.test.ts`

Independent source: S03 PGM-010…014, XF-001/029…037, SNP-001…005 and acceptance vectors. Stable seam/non-test caller: viewport/transform/snapping math used by real monitor pointer handling. Unique ownership/refactor basis: These are explicitly specified editing-coordinate and hit-selection contracts, not incidental CSS geometry.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| zooms around the cursor keeping the sequence point fixed within 1 px (AC-PGM-3) | KEEP | Literal 1100/400 sequence point stays 1116/416 screen under 25/100/400% zoom. Detects cursor drift independently of round-trip internals. |
| clamps pan so at least 10 % / 48 px of the frame stays visible | KEEP | Extreme pan clamps to[1168,−732]/[448,−306] under documented 10%/48 px visibility. Detects un recover ably lost frame. |
| picks the topmost layer whose quad contains the point, skipping locked tracks (XF-001) | KEEP | Overlapping quads pick topmost b, locked V2 picks a, outside picks null. Detects wrong edit target. |
| maps all eight rotated, cropped handle drags to the requested scales (XF-029/030, AC-XF-1) | KEEP | Eight independent 37° cropped handle vectors yield 120/60% or preserve untouched axis. Detects transform inversion errors. |
| keeps the opposite handle fixed with Alt and writes position (XF-031) | KEEP | Eight 90° opposite-anchor vectors yield expected 200/100% and translated positions. Distinct Alt resize contract. |
| scales uniformly by projection on corners and clamps instead of flipping (XF-030/032) | KEEP | Perpendicular pointer offset still yields 200%; through-anchor clamps 0.1; invert Uniform changes mode. Detects projection/flip bugs. |
| rotates with unwrapping, Shift 15° steps and the 90° snap (XF-035) | KEEP | Two full turns yield 730°;170→−170 delta 20°; Shift 37→30°;91.5 snaps 90°. Distinct angle wrap/snap boundaries. |
| moves the anchor without moving the image (XF-037, AC-XF-2 logic) | KEEP | Drag[37,−12] yields literal anchor 334.885…/140.186… and position 937/488. Detects anchor-image drift. |
| engages within 6 ± 1 screen px at 50 % and 200 % (AC-SNP-1) | KEEP | 5.5 px engages/7 px misses at 0.5× and 2× display scale. Detects zoom-dependent snap sensitivity. |
| prefers the nearest target, then center-to-center (AC-SNP-2) | KEEP | Nearest 103 beats 96; tied center beats frame; moved rectangle snaps−3/−2. Detects wrong tie/axis decision. |

## `apps/web/test/program-monitor.test.tsx`

Independent source: S03 PGM-001, ARC-010, XF-053/060, AC-XF-3; S02 TL-834. Stable seam/non-test caller: mounted ProgramMonitor/TransformOverlay events and media resolution → transport/document/history. Unique ownership/refactor basis: Math tests cannot prove gesture event wiring; renderer tests cannot prove URL/proxy/offline selection.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| shows the active sequence timecode and duration | KEEP | Seek 45 at 30 fps displays 00:00:01:15 and 60-frame content duration 2 s. Protects monitor transport subscription. |
| makes one undo step per move / rotate drag and undo restores the exact values (AC-XF-3) | KEEP | Two pointer drags change position/rotation as arranged, each one undo step, and two und os restore 960/540 and 0°. Protects event→gesture wiring. |
| Esc cancels a drag without a history entry | KEEP | Esc during a changed transient restores original position/no history and clears transient. Protects cancel boundary. |
| Type tool click creates a text clip at the playhead and selects it (XF-060) | KEEP | Type click at 100/50 in 0.5× view creates text at 200/100/frame 20, selects it and returns Selection tool. Protects creation workflow. |
| uses /media/<key>, the proxy when ready, upright size, offline → null | KEEP | Container rotation 90° swaps 1080/1920, ready 540 proxy selects URL, offline resolves null. Protects render media protocol. |
| sizes the Player to end + 1 frame, or 10 s when empty | KEEP | 60-frame content yields 61 Player frames; empty 25 fps yields 250. Protects End-black valid frame and empty ruler. |

## `apps/web/test/project-files.test.tsx`

Independent source: S01 PER-020/021, recovery AC-18; AGENTS persistence/data-loss rules. Stable seam/non-test caller: createProjectFileActions, real EditorSession/MemoryProjectStore, mounted recovery dialog. Unique ownership/refactor basis: Storage owners protect disk protocol; these tests protect UI orchestration, navigation and save-before-destructive-action guards.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| Save As makes a new project with the current document and opens it; Save a Copy stays | KEEP | Copy and Save As preserve one unsaved clip and chosen names; only Save As navigates. Protects document/navigation orchestration. |
| Revert discards unsaved changes and reloads the saved state in a new session | KEEP | Revert replaces the session with saved zero-clip state. Protects deliberate discard versus accidental save. |
| keeps the current document when saving before a version restore fails | KEEP | Flush resolving still-dirty blocks version restore/replacement and preserves both clips. Strongest owner for silent flush data-loss regression. |
| restores a version in place (keeping the current state) or opens it as a copy | KEEP | Restore version yields zero clips and before-restore version; Copy opens a distinct project. Protects save-before-restore workflow. |
| offers the dead session’s changes; Recover applies them as one undoable step | KEEP | Dead journal offers Add Solid, Recover creates one clip in one undo step and then clears journal. Protects recovery orchestration. |
| preserves the original recovery journal when the recovered document cannot be saved | KEEP | Disk-full recovery retains original dead journal and recovered edit. Detects discarding the last recoverable copy. |
| shows damaged-journal warnings while allowing a healthy session to be recovered | KEEP | Damaged journal warning co exists with healthy recovery; only healthy session may be discarded after success. Protects mixed recovery. |
| keeps a warnings-only recovery dialog visible without offering to discard damaged files | KEEP | Warnings-only dialog remains accessible with no Recover/Discard actions; Close works and preserves damaged journal. Protects inaccessible recovery state. |
| Discard deletes the journal without touching the project | KEEP | Discard clears journal, leaves project zero clips. Protects explicit destructive-scope boundary. |
| refuses to leave when a flush resolves with unsaved changes (removed during rescan) | CONSOLIDATE (remove) | Same dirty session and mocked resolved flush as preceding restore-failure case. Restore owner additionally proves no revert/replacement and exact two-clip preservation; removing this loses no unique save guard. |

## `apps/web/test/proposal-program.test.tsx`

Independent source: spec12 §2.5 P3-R4, ARCHITECTURE D-51. Stable seam/non-test caller: ProgramMonitor and buildProgramDoc with real session proposal controller. Unique ownership/refactor basis: Session preview tests cannot prove the monitor/render document selects proposal audio or respects an active gesture.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| the Program monitor plays the preview document while it is on; the session document is untouched | REWRITE | Proposal toggles duration 4 s↔17:10, transient supersedes preview, committed doc/history unchanged. Remove exact chip/history copy assertions. |
| the render document carries proposal audio across A/B and rebuilds with stable proposed ids | REWRITE | A/B render documents contain bed alone or bed+hit+boom and revert correctly; preview IDs survive unrelated edit. Remove private solid-object identity. |

## `apps/web/test/pwa.test.ts`

Independent source: S05 PWA-004 and browser request/service-worker protocol. Stable seam/non-test caller: execute shipped sw.js in a VM; Request/Response and registerServiceWorker boundary. Unique ownership/refactor basis: This executes bytes rather than grepping source; browser E2E remains responsible for actual registration/install lifecycle.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| returns a network error for an uncached asset while offline | KEEP | Uncached failed GET asset returns Response.error, preserving network-failure semantics instead of a misleading cached success. |
| registers only in production web builds with service-worker support | KEEP | Dev, desktop and unsupported navigator do not register; production web registers /sw.js. Exact path is public browser protocol. |
| leaves Range seek outside its cache (it.each expansion) | KEEP | Literal request method/URL/header exercises a distinct browser cache exclusion; worker must not claim the request or invoke cache/network handlers. Public HTTP/browser protocol, not source greps. |
| leaves media proxy outside its cache (it.each expansion) | KEEP | Literal request method/URL/header exercises a distinct browser cache exclusion; worker must not claim the request or invoke cache/network handlers. Public HTTP/browser protocol, not source greps. |
| leaves render download outside its cache (it.each expansion) | KEEP | Literal request method/URL/header exercises a distinct browser cache exclusion; worker must not claim the request or invoke cache/network handlers. Public HTTP/browser protocol, not source greps. |
| leaves cross-origin font outside its cache (it.each expansion) | KEEP | Literal request method/URL/header exercises a distinct browser cache exclusion; worker must not claim the request or invoke cache/network handlers. Public HTTP/browser protocol, not source greps. |
| leaves non-GET request outside its cache (it.each expansion) | KEEP | Literal request method/URL/header exercises a distinct browser cache exclusion; worker must not claim the request or invoke cache/network handlers. Public HTTP/browser protocol, not source greps. |

## `apps/web/test/registry.test.tsx`

Independent source: ARCHITECTURE §7.3; S05 SH-005/031; AGENTS error/entry validation rules. Stable seam/non-test caller: registered UI commands → run result, dependent effect and visible toast; PanelServices public registry. Unique ownership/refactor basis: Exception sites before hooks, schema transforms and awaited browser calls are distinct crash boundaries.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| registers, evaluates and runs commands with capability gating and args validation | KEEP | Valid command executes; malformed args do not; missing capability disables; thrown run returns error/toast; unknown id returns unknown. Protects public runner policy. |
| reports a refused fullscreen request through the command error boundary | KEEP | Browser rejects fullscreen promise; runner resolves error result and error toast. Protects awaited async event failure. |
| reports a failing pre-command hook without running the command | KEEP | Pre-command hook throws; command never executes and error is visible. Protects failure before command body. |
| reports a throwing argument transform without running the command | KEEP | Zod transform throws; command never executes and error is visible. Distinct validation-boundary crash. |
| publishes services per instance and handles "not mounted" | KEEP | Unregistering/replacing per-instance player services returns correct active/null values. Protects instance ownership/lifecycle. |

## `apps/web/test/review-stale-text.test.ts`

Independent source: spec12 §2.7 stale handling and Phase3 verification no-entity-ID regression. Stable seam/non-test caller: real model revalidate → problemText/describeProblem localization. Unique ownership/refactor basis: Model owns structured stale detection; this module owns readable names/timecodes and language conversion.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| a moved cue: kind and timecodes, in English for agents and in the editor, in Spanish too | REWRITE | Moved cut 90→100 has readable kind/timecodes 03:00→03:10 and no cue ID in both locales; dependency label survives. Remove full sentence copies. |
| a deleted cue keeps its kind (from the item) and where it was; markers and clips by name | REWRITE | Deleted cue retains cut kind/old 03:00, marker Logo names 04:00→05:00, moved clip 00→01; never raw IDs. Remove incidental connective prose. |
| without a structured problem the stored reason is shown (translated when it is a model template) | REWRITE | Opaque stored reason passes through; pending has null reason. Keep fallback behavior, remove exact default English phrases. |

## `apps/web/test/review-ui.test.tsx`

Independent source: spec12 §2.5/§2.7 P3-R6; D-51; AGT-1 authorization. Stable seam/non-test caller: mounted Review panel/bar/cards/preference and registered command/keyboard actions → session/proposal state. Unique ownership/refactor basis: Engine/model owners cannot prove keyboard routing, visible review state or browser input authorization.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| lists every item as an option with its state; a row click selects the ghost, seeks to the anchor and shows the why-line | REWRITE | Click hit selects that proposal ghost and seeks frame 30; accessibility state reflects selection and explanatory data. Remove incidental row/text inventories. |
| keyboard in the list (Review scope): Down moves, Enter accepts (with what it requires), Backspace rejects, U clears, A toggles A/B | REWRITE | Down changes selection; Enter includes required track; Backspace rejects; U clears; A toggles preview; no document edit. Distinct key dispatch. |
| alternates and the note editor (stored by the engine for the agent) | REWRITE | Next alternate saves index 1; typed note persists and is announced. Protects editable proposal metadata controls. |
| Accept all / Reject all (rejected items stay rejected on Accept all) | REWRITE | Accept all preserves prior rejection; Reject all rejects remaining; badge disappears. Protects bulk decision routing. |
| is refused untrusted: a synthetic click and an agent’s Ctrl+Enter; nothing changes | REWRITE | Synthetic click/agent command apply nothing. Rewrite trust setup to production input tracker, remove test-only mark/reset hooks. |
| Ctrl+Enter by the user = ONE History entry; the toast says "Applied n of m sounds from <agent>"; Reopen review undoes it and keeps the decisions | REWRITE | User Ctrl+Enter creates one history edit; Reopen undoes apply while preserving accept/reject decisions. Rewrite trusted event seam; avoid incidental toast phrase checks. |
| names the user’s clips an item removes in a confirmation; Cancel applies nothing, confirming is the approval | REWRITE | Destructive clip removal asks first, cancellation preserves clip, approval removes it. Protects trusted action confirmation. |
| names what an agent could not do without asking (destructive commands, force, granting itself the right to apply) before Apply | REWRITE | Grant-agent-apply/forced track removal are disclosed and cancellation preserves setting/track with no accept. Protects privilege/destruction disclosure. |
| ◀ ▶ walk the items in time order (selection + playhead), A/B toggles, Exit leaves | REWRITE | Bar next/prev changes selected item, A/B enables hear, Exit clears review. Distinct toolbar routing. |
| Discard asks first, then deletes the proposal (nothing in the sequence changes) | REWRITE | Discard requires confirmation then removes proposal without session edit. Distinct proposal deletion workflow. |
| an agent’s proposal under no review gets a card with counts and the waiting line; Review opens it; Dismiss hides it; the user’s own get none | REWRITE | Only agent proposals create cards; Review activates, Dismiss hides but preserves proposal, active review hides card. Distinct navigation state. |
| binds Enter, Backspace / Delete, U, A, Space, Shift+Space, Ctrl+Enter, Esc, Up / Down in the review scope only | KEEP | Explicit review chords resolve on three platforms; Timeline Space remains transport. Public scoped shortcut configuration is independently specified. |
| "Allow agents to apply sound proposals" writes the sequence setting as the user’s undoable edit | REWRITE | User checkbox writes agents May Apply with user origin, updates checked state and undoes. Protects authorized preference edit. |
| an agent clicking the checkbox through the live UI (ui_click) cannot grant itself the right | KEEP | Agent checkbox through live UI cannot change agents May Apply/history/checked state. Protects GUI privilege escalation. |

## `apps/web/test/shell-render.test.tsx`

Independent source: S05 AC-SH-4, AC-DT-1/2; ARCHITECTURE shell mode contract. Stable seam/non-test caller: mounted editor route → workspace/theme attributes, stored prefs and command state. Unique ownership/refactor basis: Store-only cases cannot prove error notification and runtime shell subscriptions; real browser owns code loading.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| AC-SH-4: a corrupt stored layout opens the default layout with exactly one warning toast | KEEP | Corrupt persisted layout opens editing and issues one warning. Store recovery alone cannot prove visible single notification. |
| AC-DT-1/2: theme and contrast switch via data attributes without reload | KEEP | Theme/contrast DOM attributes change immediately and theme persists. Protects actual shell subscription without reload. |
| header: mode tabs, workspace tabs and the palette button work through commands | KEEP | Workspace tab selects Assembly, export/edit modes follow commands/store, palette opens. Distinct integrated shell controls. |

## `apps/web/test/shell.test.tsx`

Independent source: S05 SH-021/023, WS-010/014, KB-001…007/013, MN-004/010; XF-053. Stable seam/non-test caller: workspace storage/keyboard dispatcher/menu resolver public boundaries. Unique ownership/refactor basis: Storage byte compatibility, event consumption and platform chord semantics are independently specified.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| drops unknown panel kinds from a saved layout (SH-023) | KEEP | Unknown hologram panel is removed from panel map and grid while Project survives. Protects conservative compatibility repair. |
| a newer workspace storage version falls back without loading its data (SH-021) | KEEP | Future version 99 resets to editing and clears unreadable storage. Protects newer-config fallback. |
| ignores inherited object keys as workspace ids (storage and workspace.switch args) | KEEP | Inherited constructor/to String keys never become workspace IDs. Protects prototype-based hostile storage/arguments. |
| state saved by a build that had the Agent panel still loads (wp-mcp) | KEEP | Old removed Agent workspace loads without reset and preserves custom Mine. Protects supported historical data. |
| persists a saved workspace and imports a duplicate name with a suffix (WS-010, WS-014) | KEEP | Saved layout reloads; importing duplicate Editing gets suffix(2). Protects persistence/import collision policy. |
| AC-KB-1: = zooms thumbnails in Project and the timeline when Timeline is focused | KEEP | Equal key dispatches Project or Timeline zoom by focus. Public scoped dispatch, not model zoom math. |
| AC-KB-2: typing "j" in a search field does not shuttle; Ctrl+S still saves | KEEP | Text search ignores J/undo but Ctrl+S remains global. Protects typing from edits. |
| a widget that consumes a key wins; otherwise the command runs after it | KEEP | Widget-prevented Arrow Right wins; un consumed Arrow Right dispatches command. Protects consumed-event precedence. |
| repeat only for repeatable commands; keyup reaches hold-to-act commands (KB-006/007) | KEEP | Repeated S toggles once and L keyup reaches hold command. Protects repeat/release protocol. |
| Esc during a pointer drag is left to the drag; after the release it runs gesture.cancel (XF-053) | KEEP | Esc during pointer drag bypasses global cancel; after release/missing release/blur reaches it. Protects drag cancellation ownership. |
| disabled commands fall through to an enabled global binding (KB-002) | KEEP | Disabled local Ctrl+B falls through to enabled global binding. Protects contextual shortcut fallback. |
| keys in a modal dialog reach its controls: Enter / Space / ↓ open a focused Select, no shortcut runs | KEEP | Modal Select Enter/Space/Down opens control and does not run timeline transport. Protects keyboard isolation in modal. |
| formats shortcuts per platform (MN-004) | KEEP | Linux/mac shortcut labels use Ctrl/⇧⌘ and palette Ctrl+Shift+P. Platform key protocol formatting. |
| unregistered commands stay visible but disabled with a reason; undo shows the step name | KEEP | Undo/Redo dynamically include actual history step/agent origin; unavailable commands disable with reason. Protects menu state. |
| capability-gated commands explain what is missing; edit-only menus are disabled outside Edit (MN-010) | KEEP | Missing engine disables export with reason; outside Edit disables sequence actions. Protects menu capability/mode policy. |

## `apps/web/test/source.test.ts`

Independent source: S03 SRC-001…004, AC-SRC-1; ARCHITECTURE §2.3 marks. Stable seam/non-test caller: source monitor state and focused registered commands → source marks/timeline clips. Unique ownership/refactor basis: Model placement/marks tests do not protect selection of the Source transport instead of sequence transport.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| opens media items and keeps a recent list | KEEP | Unknown item refuses; opening valid media records recent; close clears active. Protects Source state selection. |
| Overwrite places the marked range at the sequence playhead (AC-SRC-1 logic) | KEEP | Source In 30/Out 90 overwrites at 15 with 60-frame linked A/V, source In 705600000, playhead 75. Protects source→sequence time conversion. |
| with the Source monitor focused, I/O and Shift+I act on the source item, not the sequence | KEEP | Source-focused I/O write media marks 705600000/2116800000, leave sequence marks null, Shift+I seeks Source 30. Protects focus routing. |

## `apps/web/test/speech.test.tsx`

Independent source: speech work note/options/transcription/import contracts; AGENTS licences/data integrity. Stable seam/non-test caller: GenerateTranscriptDialog, job watcher, mixAttach, AutoTranscribeHost → HTTP/document/undo. Unique ownership/refactor basis: Speech engine owns inference; web uniquely translates controls and completed media/mix jobs into editable transcripts.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| sends model, language, translate and speaker options for the media of a sequence | KEEP | Dialog German/translate/speaker controls emit model base/language de/task translate/count 2 and watch job. Protects HTTP option translation. |
| shows the licence of a missing model and downloads it before transcribing | KEEP | Missing model shows MIT, disables Transcribe, install POST enables it. Protects licence-first model download workflow. |
| English-only models fix the language and cannot translate | KEEP | English-only model forces language en and omits translation. Distinct model capability policy. |
| commit one "Generate Transcript" step the sequence transcript reads; undo removes it | KEEP | Finished job attaches actual words; trimmed clip maps media 6 s to sequence 2 s; one undo removes transcript. Protects watcher/document integration. |
| a sequence-mix result goes to the clip media in media time, and is refused after an edit | KEEP | Sequence-mix result at 1.5 s attaches media 5.5 s with 5–15 s coverage; subsequent move refuses stale result. Protects time mapping and stale data. |
| transcribes newly imported media with sound when enabled (not on undo/redo) | OPTIMIZE | Imported audio emits one transcription with chosen model/fr; undo/redo emits none. Replace arbitrary 50 ms waits with engine-ready/controlled scheduling. |

## `apps/web/test/test-timeout.test.ts`

Independent source: docs/performance.md test timeouts; root shared-host verification contract. Stable seam/non-test caller: Vitest project configuration under controlled host-load calibration and PERF flag. Unique ownership/refactor basis: Configuration is the actual runner boundary; it does not mock the timeout formula being asserted.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| exports load-scaled timeouts bounded between 15 and 60 seconds | KEEP | Documented factors 1/1.5/2/3/10 yield 15/15/20/45/60 s. Detects accidental floor/ceiling/scaling policy change. |
| exports the strict 5-second timeout when PERF mode is enabled | KEEP | PERF strict mode yields 5 s at both low/high load. Detects relaxed strict benchmark timeout. |

## `apps/web/test/third-party-notices.test.tsx`

Independent source: S11 FIX-010, ARCHITECTURE D-13/D-36; AGENTS third-party notice contract. Stable seam/non-test caller: mounted About notice and fetched notice-file content/URL. Unique ownership/refactor basis: Generator tests cannot prove users can access notices or that offline fallback attribution is present.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| without an engine, the About notice identifies anime.js and its MIT license | KEEP | Without engine, About still names anime.js and MIT. Required attribution content, not arbitrary UI copy. |
| links THIRD_PARTY_NOTICES.md and shows it when opened | KEEP | Link targets /THIRD_PARTY_NOTICES.md and opening displays returned notice. Protects public asset path and accessible licence delivery. |
| says so when the file is missing | REWRITE | 404 displays a missing-file explanation. Failure-surface contract remains; narrow wording to semantic failure, not exact phrase. |
| shows the ported source records on their own (licenses/ported, D-36) | KEEP | Ported marker section shows Blur kernels and excludes unrelated animejs package row. Protects provenance record extraction. |

## `apps/web/test/time.test.ts`

Independent source: time-remapping work note, S02 Show Clip Keyframes and Scene Edit Detection. Stable seam/non-test caller: registered time commands/keyframe menu → real sequence and view state. Unique ownership/refactor basis: Model retiming tests cannot protect active clip selection, dialog range routing or mutually exclusive UI lanes.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| shows the band, adds a speed keyframe at the playhead, sets interpolation, removes the remap | KEEP | Active selected video speed band opens, keyframe toggles 1→0, optical flow sets, remove undo restores remap. Protects UI routing. |
| Scene Edit Detection opens its dialog for the selected video clips with their media ranges | KEEP | Scene Detection opens correct dialog for selected video with media 0–4 s range. Model scene tests cannot select dialog targets. |
| shows the speed band and hides the property lane; another property hides the band | KEEP | Speed menu hides property lane; selecting Opacity hides Speed band. Protects mutually exclusive representations. |

## `apps/web/test/timeline-commands.test.ts`

Independent source: S02 TL-549/680…766/900 and cited AC-8/11/13/15/16 cases. Stable seam/non-test caller: registered timeline commands → real EditorSession document, history, playhead and refusals. Unique ownership/refactor basis: Model edits do not choose focused panel, targeted/selected tracks, playhead interval or reveal behavior.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| AC-13a: with V1 and A1 targeted, Ctrl+K at 240 splits only V1/A1 clips crossing 240 | KEEP | Targeted V1/A1 split at 240; V2 untouched. Protects targeting policy. |
| with a selection only the selected clips crossing the playhead split; Ctrl+Shift+K splits all | KEEP | Selected V2 only split at 100; all Tracks splits V1/V2 at 200. Protects selection override/all tracks variant. |
| AC-13b: ripple delete with content on a sync-locked track is refused with a message naming the track | KEEP | Sync-locked V2 refuses ripple delete with track identified; unlock allows it. Protects refusal routing. |
| AC-16b: ripple-deleting a 30-frame clip before a marker moves it 30 frames left | KEEP | Delete 30 frames shifts marker 90→60; disabling ripple Markers preserves 60. Protects marker toggle forwarding. |
| Delete with a gap selected closes the gap; Delete with clips leaves gaps | KEEP | Gap clear closes 50-frame gap; clip clear leaves gap. Protects contextual Delete selection. |
| edit.clear (global Delete / Edit ▸ Clear) routes to the focused panel | KEEP | Global edit.clear routes Timeline; info focused refuses. Protects shared Edit command focus routing. |
| AC-11d: Q removes the head, closes the gap, moves the playhead to the old start; undo restores exactly | KEEP | Q trims 130→100, shifts clip end 170 and playhead 100; undo exact. Protects playhead interval/undo integration. |
| W ripple-removes [playhead, end); Alt+Q / Alt+W leave gaps | KEEP | W ripple removes the tail interval; Alt Q/W leave gaps at 60/100. Protects non-ripple alternatives. |
| linked partners follow once; nothing under the playhead is a hinted no-op | KEEP | Linked A/V both trim once to 270; empty playhead makes no history/edit. Protects link dedup/no-op. |
| E extends the selected edit point to the playhead with its trim type | KEEP | E honors cycled roll edit point, moves joint 120 then 119. Protects trim-type selection dispatch. |
| AC-15a/b: I at 100 and O at 199 give a 100-frame range; undo after O restores the previous Out | KEEP | I100/O199 stores[100,200); undo Out returns 200; inverted marks policy. Protects inclusive UI/exclusive model conversion. |
| AC-13d: Extract with In=100 Out=199 removes exactly 100 frames and clears In/Out | KEEP | Extract[100,200) removes exact 100 frames and clears marks/seeks 100. Protects selected range routing. |
| Lift without In/Out is a hinted no-op | KEEP | Lift without marks leaves document/history unchanged. Protects no-op user command. |
| Mark Clip and Mark Selection | KEEP | Mark Clip gives 10–60; Mark Selection spans 10–120. Protects selection interval calculation. |
| AC-8c: Ctrl+A never selects clips on locked tracks | KEEP | Select All excludes locked V2. Protects lock-aware selection. |
| nudges coalesce into one history entry and clamp at frame 0 | KEEP | Nudge right+many changes 3→9, coalesces one undo, left clamps zero. Protects coalescing/clamp. |
| D selects the clip at the playhead on targeted tracks | KEEP | D selects clip at playhead only targeted V2. Protects target-aware selection. |
| markers: M adds at the playhead; Shift+M / Ctrl+Shift+M navigate | KEEP | M creates markers 30/90; next/previous/clear act at known frames. Protects navigation and clearing. |
| gesture.cancel with nothing active deselects | KEEP | Idle gesture.cancel clears selection. Active gesture cancellation isa different controller contract. |

## `apps/web/test/timeline-gestures.test.ts`

Independent source: S02 TL-400…406/480…491/530…549/605…632/740 and cited acceptance cases. Stable seam/non-test caller: TimelineController pointer/key/wheel entry points → document/history/selection/viewport. Unique ownership/refactor basis: Numeric model commands cannot prove pointer deltas, tool modifiers, snapping or transient-cancel routing.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| rounds the pointer delta to frames and commits exactly one history entry | KEEP | 73 px at 10 px/frame moves clip 10→17 with one history edit. Independent literal rounding. |
| AC-10d: Escape during a drag restores everything and creates no undo entry | KEEP | Cancelling live drag restores drawn doc/history and later pointer up does not commit. Distinct transient lifecycle. |
| AC-9a: a clip whose end comes within 8 px of the playhead snaps onto it and shows the indicator | KEEP | Raw end 198 within 8 px snaps 200; committed clip 150–200. Protects pointer snapping integration. |
| Ctrl at release performs an insert move (AC-10b through the gesture) | KEEP | Ctrl release inserts source at 300, splits/ripples other tracks. Protects release-time insert modifier. |
| Alt drag duplicates with overwrite; the originals stay | KEEP | Alt drag creates 100–150 clone and preserves 0–50. Protects duplicate mode. |
| vertical moves change tracks within the kind; linked audio keeps its track (TL-486) | KEEP | Vertical video move changes V1→V2 while linked audio stays on A1. Protects kind/linked track mapping. |
| Shift after the start constrains to the dominant axis (TL-488) | KEEP | Late Shift constrains dominant axis to horizontal 50 frames. Protects modifier update mid gesture. |
| clips on locked tracks cannot be grabbed (TL-481) | KEEP | Locked track refuses grab and selection. Protects pre gesture lock gate. |
| clicking selects the link group; Alt selects one side; clicking empty space deselects | KEEP | Click selects linked group; Alt selects only audio; empty click clears. Protects link-select policy. |
| AC-8a: marquee over the video clip selects its linked audio; linked selection off selects only video | KEEP | Marquee includes linked Audio unless linked Selection off. Distinct marquee extension. |
| AC-8b: Shift-marquee over a selected clip deselects it and keeps the rest | KEEP | Shift marquee sub tracts selected second clip and keeps first. Distinct toggled selection. |
| AC-8c and AC-7c: marquee selects 1 px clips but never clips on locked tracks | KEEP | One-pixel clip selected; locked track clip never selected by rectangle/click. Thin target access and lock policy. |
| Escape during a marquee restores the previous selection | KEEP | Esc marquee restores prior selection. Distinct selection transient cancel. |
| clicking a gap selects it (TL-740) | KEEP | Gap click selects 20–100 on correct track. Protects empty interval hit. |
| track select forward selects everything from the click on all unlocked tracks (TL-605) | KEEP | Forward track tool selects later clips on unlocked tracks. Distinct tool selection algorithm. |
| regular trim stops at the neighbour and shows the limit indicator (AC-11b) | KEEP | Normal out trim hits neighbour, show limits and commits no-op. Protects bounded gesture feedback. |
| regular trim of the in edge by 10 frames | KEEP | Normal in trim moves start 0→10, keeps end 100, one history. Protects In-edge time direction. |
| Ctrl-edge ripple trim and the Ripple tool (AC-11c path) create one entry | KEEP | Ctrl edge and Ripple tool both shift following clip and other track, each one entry. Distinct tool/modifier dispatch. |
| AC-11c: ripple trim stops at the largest amount a sync-locked track allows | KEEP | Sync-locked track limits desired 70 joint to 90. Protects cross-track gesture clamp. |
| rolling tool (N) moves the edit point | KEEP | Rolling tool joint 100→110 preserves end 150 and one entry. Distinct two-sided edit gesture. |
| slip (Y) changes source time in one history entry | KEEP | Slip 10 frames changes only source In to 50 frames in one entry. Protects source-time gesture. |
| razor (C) click splits once; Shift splits all unlocked tracks; Alt ignores links | KEEP | Razor click splits linked A/V; Shift all tracks; Alt breaks links. Distinct tool/modifiers. |
| razor snaps to the playhead even with snapping off (TL-620) | KEEP | Razor within playhead band snaps 50 even global Snap off. Protects razor-specific override. |
| rate stretch doubles the duration and halves the speed (AC-12d through the tool) | KEEP | Rate Stretch 120→240 frames changes rate 1→0.5. Protects time-stretch tool. |
| Escape cancels a trim with no entry | KEEP | Cancel trim restores 0–100 and history unchanged. Distinct trim transaction abort. |
| AC-3c: \\ then \\ returns to the exact prior zoom and scroll | KEEP | Two zoom-to-sequence toggles restore exact 7.3/123.4 saved view. Protects user viewport restoration. |
| Alt+wheel zooms around the pointer | KEEP | Wheel zoom retains known anchor frame at 500 px after mixed scrolls. Protects anchor stability in controller. |
| ruler scrubbing seeks with the floor rule and Shift snaps to markers (AC-9b) | KEEP | Ruler floor 100.975→100; Shift near 101 snaps marker 103 and seeks 103. Distinct seek rounding. |

## `apps/web/test/timeline-model.test.ts`

Independent source: S02 TL-100…113/1053/A.3/328/331/333; S04 TH-003/WF-001/003. Stable seam/non-test caller: production viewport/snapping/filmstrip/waveform functions → literal outputs. Unique ownership/refactor basis: These are navigation/time math, sprite protocol and waveform amplitude rules independently specified by those sources.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| AC-3a: a 3 h 29.97 sequence zooms to ≥ 40 px per frame anywhere and trims move 1 frame per 40 px | KEEP | Three-hour 29.97 fps supports 40 px/frame and symmetric±half-frame rounding. Protects precision/long timeline math. |
| wheel mapping follows TL-111 | KEEP | Documented platform wheel modifiers turn into horizontal scroll, vertical scroll, zoom or both axes. Protects input mapping. |
| nearest target within the threshold wins, then priority | KEEP | Nearest target wins, ties prefer playhead priority; out-of-threshold null. Protects exact snap selection. |
| uses the nearest tile at or before the requested time | KEEP | At 5.9 seconds select the four-second tile; at six seconds select six, out-of-range clamps 0/58. Protects sprite sampling protocol. |
| takes the max over the peaks covered by each column | KEEP | Known peak maxima over half-second columns yield 49/99/49/99. Protects alias-free waveform reduction. |
| AC-7b: -6 dB halves the drawn amplitude; clipping is flagged | KEEP | −6 d Bgain≈0.501,0.8 peak draws 40 px,positive gain flags/clamps clip. Explicit waveform amplitude requirement. |

## `apps/web/test/timeline-panel.test.tsx`

Independent source: S05 TOOL-001…005. Stable seam/non-test caller: mounted ToolsPanel pointer and context-menu actions → active tool. Unique ownership/refactor basis: Command registry/tool-controller tests do not prove toolbar/flyout dispatch.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| clicking a button selects the tool; right-click opens the group flyout | KEEP | Toolbar Razor selection and context flyout Rolling selection change real active tool. Remove final incidental DOM button inventory if desired. |

## `apps/web/test/timeline-peaks-stream.test.ts`

Independent source: S04 waveform container-stream-index protocol; historical movie audio stream1 regression. Stable seam/non-test caller: peaksFor issues real fetch Request URLs and decodes returned Float32 peaks. Unique ownership/refactor basis: Engine peak generation cannot protect the web selecting audio container stream1 instead of ordinal audio0.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| requests the peaks stream with the clip's container stream index (movie audio = stream 1) | KEEP | Movie audio container stream 1 requests 1.bin and decodes[0.5,0.25],not or din al 0. Public path/bytes independent oracle. |

## `apps/web/test/timeline-transition-index.test.ts`

Independent source: S10 transition spans; half-open interval query API; transient-move cache regression. Stable seam/non-test caller: transitionIndex/transitionsInRange consumed by timeline drawing/hit tests. Unique ownership/refactor basis: Exhaustive interval intersection is an independent mathematical oracle for indexed search; model geometry alone does not test index invalidation.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| matches exhaustive half-open range queries, including long overlaps and equal starts | KEEP | Hand arranged long overlaps/equal starts indexed queries match independent half-open intersections; missing track and caller unsorted maps work. Protects binary query logic. |
| queries the new range after a transient clip movement | KEEP | Transient move clip 9 from 900 to 5000 invalidates old index query. Protects cache key dependence on clips record. |

## `apps/web/test/transport.test.ts`

Independent source: S02 TL-872…877, AC-18a/b/c; S03 ARC-010/PGM-003/XF-023; WP3I watchdog regressions. Stable seam/non-test caller: Shuttle/PlaybackDriver adapter boundary + real TransportStore; registered navigation/nudge commands. Unique ownership/refactor basis: Controlled Player and audio callbacks isolate external clocks; production driver alone decides transport state, rates and synchronization.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| L L L yields 4×; J then yields −1×; K stops (AC-18a) | KEEP | JKL sequence 1→4→8, reverse −1, K stops. Explicit shuttle rate state machine. |
| hold K + tap L five times advances exactly five frames (AC-18c) | KEEP | K plus five L taps moves exactly five frames and stays paused. Distinct tap contract. |
| hold K + hold L plays at 0.25× until release; repeats are ignored | KEEP | K+held L at 250 ms plays 0.25 until release; repeat ignored. Distinct hold contract. |
| Space toggles 1× forward play; Shift+L/J steps the slow rate by 0.1 | KEEP | Space toggles 1×; slow commands increment 0.1 and cross zero/reverse. Distinct controls. |
| restarts at 1× after the transport stopped on its own | KEEP | Stopped transport resets next L from 2× to 1×. Historical external-stop regression. |
| plays natively at 1×: the Player is the clock and frames are reported | OPTIMIZE | Native Player clock reports frame 10, pause/stored seek 42 reflected in player. Public adapter state. |
| re-issues play() when the Player does not start or stalls while playing (no frameupdate, not buffering) — WP-3I | OPTIMIZE | No-frame-start/stall restarts from last frame; progressing/buffering/paused players are not kicked. Historical watchdog regression. |
| does not kick a Player that renders slowly; a real stall after slow frames is still kicked | OPTIMIZE | 700 ms frames are allowed but a real five-second stall recovers. Distinct adaptive watchdog policy. |
| a slow machine: the next play's slow first frame is not a stall; a real stall is still kicked | OPTIMIZE | Second play 900 ms first frame is allowed and later stall recovers. Distinct between-play history regression. |
| mutes audio below 1× (TL-874) | OPTIMIZE | 0.25× playback mutes audio. Explicit TL874 contract. |
| uses seek-stepping at 8×: timecode advances 8× real time, seeks ≤ 30/s (AC-18b) | OPTIMIZE | One virtual second at 8× advances about 240 frames with at most 31 seeks; pausing cancels rAF. Explicit AC-18b resource bound. |
| plays reverse by stepping and stops at 0 | OPTIMIZE | Reverse from 30 reaches zero and stops. Distinct stepping direction/end bound. |
| stops at the sequence end, or loops In→Out when loop is on (TL-875) | OPTIMIZE | Native end stops; loop[10,20)returns 10. Distinct end/loop behavior. |
| Play In to Out stops on the last marked frame (TL-877) | OPTIMIZE | Play Range 10–20 stops on 19. Protects exclusive end. |
| follows external seeks while playing | OPTIMIZE | External seek 80 while playing updates the Player. Protects bidirectional transport clock. |
| with an audio graph a seek while playing restarts: pause, seek once the graph is ready, play (sound-design Phase 6) | OPTIMIZE | Audio seek pauses until graph ready,seeks to 80 then plays; restart without target preserves frame. Explicit primed-start synchronization. |
| the stall watchdog leaves a Player alone while the audio holds the picture for a primed start | OPTIMIZE | While audio waits to start, two seconds without a frame is not a stall; after ready genuine stall recovers. Distinct false watchdog audio regression. |
| a seek during a restart plays from the latest target; a pause during it abandons it | OPTIMIZE | New seek 120 supersedes 80 during restart; pause abandons later 200 restart. Protects async latest-wins/cancellation. |
| steps, jumps to start/end and edit points | KEEP | Registered step/navigation commands reach 6/5/end 120/edits 60/90/zero. Protects command routing. |
| nudges the selected layer by 1 and 5 px with one coalesced undo step (XF-023) | KEEP | Program nudges 2 px right/5 px down yield 962/545 in one coalesced undo. Distinct on-canvas command routing. |

## `apps/web/test/vite-chunks.test.ts`

Independent source: S11 ANM-023 explicitly requires animejs manualChunks → vendor-anime. Stable seam/non-test caller: actual Vite output configuration manualChunks contract. Unique ownership/refactor basis: The exact name is an independent build configuration requirement, not an invented wrapper/export inventory.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| puts anime.js subpath modules in vendor-anime | KEEP | Literal animejs timeline/svg subpath IDs resolve vendor-anime via actual Vite config. Public ANM023 configuration name is independent. |

## `apps/web/test/voiceover-latency.test.ts`

Independent source: spec12 Phase0 WP0.1 input/output latency compensation; preference range contract. Stable seam/non-test caller: real takeRange/assembleTake/latency parser over independently simulated wall/capture clocks. Unique ownership/refactor basis: The simulator uses physical time and injected claps, not the implementation's clock-estimation algorithm.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| without jitter the clap lands on the record point (±1 sample) | KEEP | Zero clock jitter and one-sample buffer clap lands within one sample with a 0.065-second round trip. Property excludes raf 0 so this retains unique exact case. |
| simulated input latency: aligned within one capture buffer; uncompensated it is not | CONSOLIDATE (remove) | CONSOLIDATE: general 300-case simulation property already owns nonzero latency/jitter within-buffer. Omitted input Latency negative control is not required correct behavior. |
| any latency, buffer and report jitter: within one buffer (property) | KEEP | Physical simulator varies capture buffers/jitter/input/output latency; clap must land within one buffer. Oracle wall time independent of production lower-envelope estimator. |
| a late frame report (stall) does not shift the take (lower envelope of the pairs around the frame) | KEEP | Single 500 ms frame-report stall cannot shift take. Distinct adversarial capture-clock regression. |
| the user offset and the capture-context fallback; hostile values count as 0 | KEEP | A −5 ms offset with 20 ms output latency gives 15 ms; capture fallback gives 25 ms; hostile latency values are bounded. Distinct fallback/config inputs. |
| the Latency Offset preference parses tolerantly (−500 … 500 ms, default 0) | KEEP | Persisted latency offset default 0,12.4→12,−9999→−500,invalid→0. Independent preference bounds. |

## `apps/web/test/workspace-migration.test.ts`

Independent source: S05 SH-020/021, spec12 §2.7 WP3.3b/WP5.2; AGENTS immutable migrations. Stable seam/non-test caller: stored jasper:workspaces v1/v2 bytes → WorkspaceStore and migration outputs. Unique ownership/refactor basis: Persisted tab placement is a migration byte/compatibility contract; current unrelated/custom layouts must survive.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| adds Review as a background tab before Markers in the stored current and saved layouts; nothing else changes | REWRITE | v 1 stored current/saved gain Review and Sound Check at correct peer group while active/custom/other data unchanged; reload version 3. Remove panel State-derived expectations. |
| is idempotent and never duplicates the panel (Review already open, docked or floating) | REWRITE | Existing docked/floating/alternate ID Review must not duplicate; repeat migration deep content unchanged. Remove object identity constraint. |
| leaves factory (null) layouts and layouts without a host group alone | REWRITE | Null factory/no host layouts unchanged;library host gets background Review without input mutation. Replace identity with content assertions. |
| corrupt, unknown and newer stored data are still reset (SH-021) | REWRITE | Corrupt/unknown/future stored versions reset safely;an invalid v1 payload still refuses. Replace derived newer version setup with fixed future literal where possible. |
| never throws on hostile stored data, and adds at most one Review panel (property) | REWRITE | Hostile stored layouts must not throw/duplicate new Review. Remove weak data-defined probe;keep actual no-throw/count guarantees. |
| adds Sound Check right after Review in the stored layouts; nothing else changes | REWRITE | v 2 stored layouts insert Sound Check beside Review preserving active/custom data and reload. Remove panel State oracle/object identity. |
| without Review it goes where Review went (before Markers); the factory layout has it already | REWRITE | Without Review,new Sound Check joins Markers;missing host and factory already containing it remain content-equal. Remove identity only. |
| never throws on hostile stored data and adds at most one Sound Check panel (property) | REWRITE | Host il ev 2 input must not throw/duplicate new Sound Check. Independent robustness property at the persisted migration boundary. |

## `apps/web/test/wp2e/import.test.ts`

Independent source: S01 LIFE-010; S04 §5.3 AC2 and IN-007/013; S07 PRC-019. Stable seam/non-test caller: EngineImportService + real session and protocol fixture → locators/clips/jobs/unload events. Unique ownership/refactor basis: Engine upload tests cannot protect web batch transactions, source-range sidecar association, prompt policy or client unload guards.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| timeline drop imports two files in order in one undo step | KEEP | Two files of two and three seconds drop at frame 30 as A/V clips with start/duration pairs [30,60] and [90,90] in one undo step. Protects ordered batch timeline placement. |
| web: uploads files in client jobs and commits ONE transaction with engine-store locators | KEEP | Two Uploads produce chosen engine-store keys/success jobs in one undo. Protects web acquisition/commit protocol. |
| web: a source-range sidecar picked with a render makes it a version of its source (M3, S07:PRC-019) | KEEP | Render-before-source batch sidecar first 174/130 frames links to real source without uploading JSON. Distinct cross file association. |
| lists per-file failures and commits the rest (S04 §5.3 AC 2) | KEEP | Good file commits;corrupt file yields UNSUPPORTED_MEDIA/per-file failure without losing good result. Partial failure policy. |
| dedupes by fingerprint with one prompt per batch (S04:IN-007) | KEEP | Same fingerprint reuses old asset with one prompt,leaves new asset. Distinct dedupe use-existing. |
| "Import again" adds another project item referencing the same asset | KEEP | Import again reuses asset but adds second item. Distinct duplicate-choice branch. |
| timeline drop into an empty sequence asks about the clip mismatch and updates the settings | KEEP | Empty sequence accepts mismatch 1280×720/25 fps and 250-frame clip;later import does not prompt again. Distinct mismatch policy. |
| desktop: registers picked paths in place and adds a path locator | KEEP | Desktop registers paths in place,adds engine/path locators and reports broken name. Distinct no-upload desktop acquisition. |
| guards beforeunload while uploads run (S04:IN-013) | KEEP | During upload beforeunload prevents default;after completion allows it. Actual browser-event guard boundary. |
| placeItems: Project items dragged to the timeline become one Overwrite transaction | KEEP | Project item drop duplicates item at 10/40 in one additional undo. Distinct already-import edit emplacement. |
| reads DataTransfer payloads: in-app items first, then OS files | KEEP | Jasper mime wins over OS files;OS files fallback;plain external text null. Public drag payload precedence. |

## `apps/web/test/wp2e/ui.test.tsx`

Independent source: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S04 RP-011/012; D-13. Stable seam/non-test caller: mounted Home/Project/Jobs/Export controls → real document/HTTP requests/configuration. Unique ownership/refactor basis: Backend tests cannot protect confirmation before requests, selected presets, disconnected upload display or codec controls.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| requires confirmation before deleting a project | KEEP | Home Delete emits no DELETE until confirm then requests right project. Protects destructive action consent. |
| moves media into a bin and finds it from the project root | KEEP | New bin rename/drop moves actual item;root search finds nested item. Protects UI bin routing/navigation. |
| warns before deleting media that is used in a sequence and deletes with force on confirm | KEEP | Used media removal warns/preserves before confirm;confirm removes item and dependent clips. Protects force approval. |
| creates a sequence from the selected preset | KEEP | Selected vertical preset creates 1080×1920 active sequence. Protects UI preset choice. |
| keeps a ready 720 proxy when the 540 tier was never made (LIFE-050) | KEEP | Media updated 720 ready/540 none retains 720 proxy URL. Historical fallback event merge. |
| cancels a running export job through the engine (JOB-003) | KEEP | Jobs Cancel button POSTs to correct running export job. Protects UI job routing. |
| keeps client uploads running when the engine is disconnected (JOB-005) | KEEP | Engine 503 does not delete/client fail upload;row stays Running. Protects independent client job state. |
| sends the committed project envelope when requesting an export plan | KEEP | Plan request contains jasper-project envelope,current project/sequence and auto entire range. Public wire contract. |
| forcing Native with native blockers disables Export (S04:RP-012, S05:EX-022) | KEEP | Forcing Native with blockers disables Export. Protects prevention of unsupported export. |
| starts export without a stale plan ID and remembers settings (EX-013/014, RP-011) | KEEP | Export request omits stale plan Id and persisted auto engine choice. Protects revision-aware plan use. |
| uses an available codec when H.264 is unavailable (ARCHITECTURE D-13) | KEEP | No H264 available forces AV1,disables H264 and plans AV1. Protects capability UI fallback. |
| disables unusable hardware and GPL encoders in LGPL-only mode (ARCHITECTURE D-13) | KEEP | LGPL-only mode disables x264 and broken NVENC but allows OpenH264. Public licence/capability selection policy. |

## `apps/web/test/wp3i-integration.test.ts`

Independent source: export filename suffix and path safety contract. Stable seam/non-test caller: sanitizeFileName called by export settings. Unique ownership/refactor basis: Engine final output extension is a different boundary; this prevents user input from creating repeated suffixes/paths.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| drops a typed .mp4 extension (the export adds it) and keeps other names | KEEP | MP4 suffix removed case-in sensitively;slashes/co lons sanitized;empty stems Export;MOV retained. Literal filename byte contract. |

## `apps/web/test/wp65a-audition-view.test.ts`

Independent source: WP6.5a item7 audition view restoration; S02 TL-120. Stable seam/non-test caller: scrollAfterAudition and in-context start/end observer API → returned view/playhead. Unique ownership/refactor basis: Audition controller must preserve the first return point across replacements; static viewport math cannot emit lifecycle events.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| goes back to the view before playback when the returned playhead is in it, else reveals it | KEEP | Restore view zero when returned frame 40 fits; otherwise reveal frame 150 at the documented 25% inset. Drop a hostile NaN subcase if no real caller can produce it; the viewport restoration contract remains unique. |
| one start and one end with the frame the playhead returned to, also when a window replaces another | KEEP | Replacing window emits one start/one end and returns first frame 12. Public observer lifecycle protects view save/restore. |
| an audition ended without returning the playhead (the session closed, another sequence) says null | KEEP | Ending the session without returning the playhead emits null. Distinct abandoned window contract. |

## Concrete follow-through and limits

The coordinator reports implementing proposal-program copy/identity pruning, deleting the redundant direct save-before-leaving case, and replacing Review UI production mark/reset trust-test hooks with production input tracking driven through the event boundary. Speech fixed waits, driver lifecycle disposal and workspace assertion changes were sent as actionable findings; verify the final coordinator diff for their disposition.

PlaybackDriver setup currently constructs real watchdog timers/listeners without calling `dispose()`. Cases ending in native play or a pending audio restart can leave owned handles; dispose each created driver before restoring globals. This is resource cleanup, with no measured duration claim. Speech auto-import's two 50 ms sleeps should become EngineProvider readiness/controlled scheduler synchronization while preserving the no-second-request assertion after undo/redo.

Migration expected values constructed with `panelState` and exact `toBe` identity are not independent persisted-content oracles. Preserve historical literal tab names/order, active view, custom-layout bytes, no duplication, no mutation, reset states and actual stored version. Do not edit a shipped migration just to remove constant export visibility; document that immutable-migration exception if those exports remain.

Validation: source/contract and diff review only for this supplemental scope; no test, typecheck, build, browser or performance pass is claimed. Root/coordinator owns execution. The intentionally retained Vite anime chunk test has an explicit ANM-023 configuration contract; it must not be removed merely for resembling an implementation-pattern test. The potentially expensive voice-over property has an independent physical clock/clap oracle, so it remains the stronger owner after consolidating its fixed nonzero-latency duplicate.

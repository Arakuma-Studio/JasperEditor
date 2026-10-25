# Supplemental web-core audit B

Read-only review of the 30 paths in `/tmp/web-core-supplement-b.txt`, using the web-core worktree's current tests and targeted production owners. Implementation belongs to the web-core agent; this document does not claim to have edited or executed web tests. Root's baseline is still running, so no Vitest/build/typecheck was started here.

This rescan challenges the earlier `web1.md`/`web2.md`/`web3.md` ledgers rather than treating their repeated six-bar paragraphs as proof. Sources and actual oracles are listed below. No filename/regex match was used as a deletion verdict. Geometry below is retained only where a cited editing/viewport rule independently specifies coordinates, hit priority, time mapping or snapping; ordinary DOM layout inventories are not contracts.

For each retained row: (1) its independent requirement is the section source; (2) the literal failure/oracle is its row; (3) values come from arranged inputs, mathematical laws, protocol bytes or state transitions, not copied production algorithms; (4) the section names its production-used boundary; (5) outputs survive helper/identifier/component-layout refactors, with proposed identity/copy removals called out; (6) the section and row explain its distinct ownership. Mocks isolate external browser/engine responses; real command/session/UI code decides the asserted outcome. No generic KEEP is inferred from passing status. `REWRITE` and `OPTIMIZE` below are concrete proposals accepted/implemented by the coordinator where noted, pending integrated tests.

Two duplicate scenarios identified: the direct silent-flush `saveBeforeLeaving` test is superseded by the version-restore failure case that also asserts no destructive action and exact document preservation; the fixed nonzero-latency voice-over simulation duplicates the stronger independent simulation property. Both have stronger surviving owners, not mere assumptions of coverage.

## `apps/web/test/program-layer-menu.test.tsx`

Independent source: S03 XF-038/050/051; S02 TL-266. Stable seam/non-test caller: layer-ops pure patches; registered motion/arrange/reveal commands → committed document. Unique ownership/refactor basis: Cropped/rotated fit, anchor compensation and command selection/undo are distinct from generic model edits.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| fits the visible rect inside the frame, centred | KEEP | 1280×720 input fits at150%; left-half crop centres at[480,540]. Detects crop-blind fitting, beyond the command smoke. |
| uses the rotated bounds, fills by the larger ratio, and Set to Native only sets 100% | KEEP | 90° bounds give56.25% fit/177.7778% fill; Native sets100%; fully cropped geometry refuses. Detects rotated/empty bounds. |
| moves the anchor to each grid point of the visible rect without moving a pixel | KEEP | Nine literal 90°/flipped/cropped anchor vectors preserve pixels. Commands only cover uncropped top-left. |
| Fit to Frame / Fill Frame / Set to Native: one step each, keyed at the playhead when animated | KEEP | Commands produce150→150→100%, three undo entries, then insert100 between50/80 keyed values. Protects dispatch and keyed editing. |
| Reset Motion and Reset Crop reuse Remove Attributes; Reset Crop needs a crop | KEEP | No crop disables Reset Crop; reset clears rotation and removes the added crop. Protects capability gating and actual edit. |
| Anchor ▸ Top Left keeps the layer where it is | KEEP | Top-left anchor command yields[0,0] anchor/position; invalid point is invalid-args. Protects argument validation plus routing. |
| Arrange ▸ Bring Forward moves the video to a new track and leaves its linked audio alone | KEEP | Bring Forward changes only video track/time; linked audio stays and sendBack restores order. Protects selected-link handling. |
| Bring to Front above the top track creates a video track (S02:TL-266) | KEEP | Bring to Front above V3 adds V4; undo returns three tracks. Protects structural edit integration. |
| Reveal in Project selects the media item and is disabled for sequence-only text | KEEP | Reveal selects imported project item; sequence-only text disables. Protects source-item lookup and unsupported action gating. |

## `apps/web/test/program-math.test.ts`

Independent source: S03 PGM-010…014, XF-001/029…037, SNP-001…005 and acceptance vectors. Stable seam/non-test caller: viewport/transform/snapping math used by real monitor pointer handling. Unique ownership/refactor basis: These are explicitly specified editing-coordinate and hit-selection contracts, not incidental CSS geometry.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| zooms around the cursor keeping the sequence point fixed within 1 px (AC-PGM-3) | KEEP | Literal1100/400 sequence point stays1116/416 screen under25/100/400% zoom. Detects cursor drift independently of round-trip internals. |
| clamps pan so at least 10 % / 48 px of the frame stays visible | KEEP | Extreme pan clamps to[1168,−732]/[448,−306] under documented10%/48px visibility. Detects unrecoverably lost frame. |
| picks the topmost layer whose quad contains the point, skipping locked tracks (XF-001) | KEEP | Overlapping quads pick topmost b, lockedV2 picks a, outside picks null. Detects wrong edit target. |
| maps all eight rotated, cropped handle drags to the requested scales (XF-029/030, AC-XF-1) | KEEP | Eight independent37° cropped handle vectors yield120/60% or preserve untouched axis. Detects transform inversion errors. |
| keeps the opposite handle fixed with Alt and writes position (XF-031) | KEEP | Eight90° opposite-anchor vectors yield expected200/100% and translated positions. Distinct Alt resize contract. |
| scales uniformly by projection on corners and clamps instead of flipping (XF-030/032) | KEEP | Perpendicular pointer offset still yields200%; through-anchor clamps0.1; invertUniform changes mode. Detects projection/flip bugs. |
| rotates with unwrapping, Shift 15° steps and the 90° snap (XF-035) | KEEP | Two full turns yield730°;170→−170 delta20°; Shift37→30°;91.5 snaps90°. Distinct angle wrap/snap boundaries. |
| moves the anchor without moving the image (XF-037, AC-XF-2 logic) | KEEP | Drag[37,−12] yields literal anchor334.885…/140.186… and position937/488. Detects anchor-image drift. |
| engages within 6 ± 1 screen px at 50 % and 200 % (AC-SNP-1) | KEEP | 5.5px engages/7px misses at0.5× and2× display scale. Detects zoom-dependent snap sensitivity. |
| prefers the nearest target, then center-to-center (AC-SNP-2) | KEEP | Nearest103 beats96; tied center beatsframe; moved rectangle snaps−3/−2. Detects wrong tie/axis decision. |

## `apps/web/test/program-monitor.test.tsx`

Independent source: S03 PGM-001, ARC-010, XF-053/060, AC-XF-3; S02 TL-834. Stable seam/non-test caller: mounted ProgramMonitor/TransformOverlay events and media resolution → transport/document/history. Unique ownership/refactor basis: Math tests cannot prove gesture event wiring; renderer tests cannot prove URL/proxy/offline selection.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| shows the active sequence timecode and duration | KEEP | Seek45 at30fps displays00:00:01:15 and60-frame content duration2s. Protects monitor transport subscription. |
| makes one undo step per move / rotate drag and undo restores the exact values (AC-XF-3) | KEEP | Two pointer drags change position/rotation as arranged, each one undo step, and two undos restore960/540 and0°. Protects event→gesture wiring. |
| Esc cancels a drag without a history entry | KEEP | Esc during a changed transient restores original position/no history and clears transient. Protects cancel boundary. |
| Type tool click creates a text clip at the playhead and selects it (XF-060) | KEEP | Type click at100/50 in0.5× view creates text at200/100/frame20, selects it and returns Selection tool. Protects creation workflow. |
| uses /media/<key>, the proxy when ready, upright size, offline → null | KEEP | Container rotation90° swaps1080/1920, ready540 proxy selects URL, offline resolvesnull. Protects render media protocol. |
| sizes the Player to end + 1 frame, or 10 s when empty | KEEP | 60-frame content yields61 Player frames; empty25fps yields250. Protects End-black valid frame and empty ruler. |

## `apps/web/test/project-files.test.tsx`

Independent source: S01 PER-020/021, recovery AC-18; AGENTS persistence/data-loss rules. Stable seam/non-test caller: createProjectFileActions, real EditorSession/MemoryProjectStore, mounted recovery dialog. Unique ownership/refactor basis: Storage owners protect disk protocol; these tests protect UI orchestration, navigation and save-before-destructive-action guards.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| Save As makes a new project with the current document and opens it; Save a Copy stays | KEEP | Copy and Save As preserve one unsaved clip and chosen names; only Save As navigates. Protects document/navigation orchestration. |
| Revert discards unsaved changes and reloads the saved state in a new session | KEEP | Revert replaces the session with saved zero-clip state. Protects deliberate discard versus accidental save. |
| keeps the current document when saving before a version restore fails | KEEP | Flush resolving still-dirty blocks version restore/replacement and preserves both clips. Strongest owner for silent flush data-loss regression. |
| restores a version in place (keeping the current state) or opens it as a copy | KEEP | Restore version yieldszero clips and before-restore version; Copy opens a distinct project. Protects save-before-restore workflow. |
| offers the dead session’s changes; Recover applies them as one undoable step | KEEP | Dead journal offers Add Solid, Recover createsone clip inone undo step and then clears journal. Protects recovery orchestration. |
| preserves the original recovery journal when the recovered document cannot be saved | KEEP | Disk-full recovery retains original dead journal and recovered edit. Detects discarding the last recoverable copy. |
| shows damaged-journal warnings while allowing a healthy session to be recovered | KEEP | Damaged journal warning coexists with healthy recovery; only healthy session may be discarded after success. Protects mixed recovery. |
| keeps a warnings-only recovery dialog visible without offering to discard damaged files | KEEP | Warnings-only dialog remains accessible with no Recover/Discard actions; Close works and preserves damaged journal. Protects inaccessible recovery state. |
| Discard deletes the journal without touching the project | KEEP | Discard clears journal, leaves project zero clips. Protects explicit destructive-scope boundary. |
| refuses to leave when a flush resolves with unsaved changes (removed during rescan) | CONSOLIDATE (remove) | Same dirty session and mocked resolved flush as preceding restore-failure case. Restore owner additionally proves no revert/replacement and exact two-clip preservation; removing this loses no unique save guard. |

## `apps/web/test/proposal-program.test.tsx`

Independent source: spec12 §2.5 P3-R4, ARCHITECTURE D-51. Stable seam/non-test caller: ProgramMonitor and buildProgramDoc with real session proposal controller. Unique ownership/refactor basis: Session preview tests cannot prove the monitor/render document selects proposal audio or respects an active gesture.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| the Program monitor plays the preview document while it is on; the session document is untouched | REWRITE | Proposal toggles duration4s↔17:10, transient supersedes preview, committed doc/history unchanged. Remove exact chip/history copy assertions. |
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
| a moved cue: kind and timecodes, in English for agents and in the editor, in Spanish too | REWRITE | Moved cut90→100 has readable kind/timecodes03:00→03:10 and no cue ID in both locales; dependency label survives. Remove full sentence copies. |
| a deleted cue keeps its kind (from the item) and where it was; markers and clips by name | REWRITE | Deleted cue retains cut kind/old03:00, marker Logo names04:00→05:00, moved clip00→01; never raw IDs. Remove incidental connective prose. |
| without a structured problem the stored reason is shown (translated when it is a model template) | REWRITE | Opaque stored reason passes through; pending hasnull reason. Keep fallback behavior, remove exact default English phrases. |

## `apps/web/test/review-ui.test.tsx`

Independent source: spec12 §2.5/§2.7 P3-R6; D-51; AGT-1 authorization. Stable seam/non-test caller: mounted Review panel/bar/cards/preference and registered command/keyboard actions → session/proposal state. Unique ownership/refactor basis: Engine/model owners cannot prove keyboard routing, visible review state or browser input authorization.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| lists every item as an option with its state; a row click selects the ghost, seeks to the anchor and shows the why-line | REWRITE | Click hit selects that proposal ghost and seeksframe30; accessibility state reflects selection and explanatory data. Remove incidental row/text inventories. |
| keyboard in the list (Review scope): Down moves, Enter accepts (with what it requires), Backspace rejects, U clears, A toggles A/B | REWRITE | Down changes selection; Enter includes required track; Backspace rejects; U clears; A toggles preview; no document edit. Distinct key dispatch. |
| alternates and the note editor (stored by the engine for the agent) | REWRITE | Next alternate savesindex1; typed note persists and is announced. Protects editable proposal metadata controls. |
| Accept all / Reject all (rejected items stay rejected on Accept all) | REWRITE | Accept all preserves prior rejection; Reject all rejects remaining; badge disappears. Protects bulk decision routing. |
| is refused untrusted: a synthetic click and an agent’s Ctrl+Enter; nothing changes | REWRITE | Synthetic click/agent command apply nothing. Rewrite trust setup to production input tracker, remove test-only mark/reset hooks. |
| Ctrl+Enter by the user = ONE History entry; the toast says "Applied n of m sounds from <agent>"; Reopen review undoes it and keeps the decisions | REWRITE | User Ctrl+Enter createsone history edit; Reopen undoes apply while preserving accept/reject decisions. Rewrite trusted event seam; avoid incidental toast phrase checks. |
| names the user’s clips an item removes in a confirmation; Cancel applies nothing, confirming is the approval | REWRITE | Destructive clip removal asks first, cancellation preservesclip, approval removesit. Protects trusted action confirmation. |
| names what an agent could not do without asking (destructive commands, force, granting itself the right to apply) before Apply | REWRITE | Grant-agent-apply/forced track removal are disclosed and cancellation preserves setting/track with no accept. Protects privilege/destruction disclosure. |
| ◀ ▶ walk the items in time order (selection + playhead), A/B toggles, Exit leaves | REWRITE | Bar next/prev changes selected item, A/B enables hear, Exit clears review. Distinct toolbar routing. |
| Discard asks first, then deletes the proposal (nothing in the sequence changes) | REWRITE | Discard requiresconfirmation then removesproposal without sessionedit. Distinct proposal deletion workflow. |
| an agent’s proposal under no review gets a card with counts and the waiting line; Review opens it; Dismiss hides it; the user’s own get none | REWRITE | Only agent proposals create cards; Review activates, Dismiss hides but preservesproposal, active review hidescard. Distinct navigation state. |
| binds Enter, Backspace / Delete, U, A, Space, Shift+Space, Ctrl+Enter, Esc, Up / Down in the review scope only | KEEP | Explicit review chords resolve onthree platforms; Timeline Space remains transport. Public scoped shortcut configuration is independently specified. |
| "Allow agents to apply sound proposals" writes the sequence setting as the user’s undoable edit | REWRITE | User checkbox writes agentsMayApply with user origin, updateschecked state and undoes. Protects authorized preference edit. |
| an agent clicking the checkbox through the live UI (ui_click) cannot grant itself the right | KEEP | Agent checkbox through liveUI cannot change agentsMayApply/history/checked state. Protects GUI privilege escalation. |

## `apps/web/test/shell-render.test.tsx`

Independent source: S05 AC-SH-4, AC-DT-1/2; ARCHITECTURE shell mode contract. Stable seam/non-test caller: mounted editor route → workspace/theme attributes, stored prefs and command state. Unique ownership/refactor basis: Store-only cases cannot prove error notification and runtime shell subscriptions; real browser owns code loading.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| AC-SH-4: a corrupt stored layout opens the default layout with exactly one warning toast | KEEP | Corrupt persisted layout opensediting and issuesone warning. Store recovery alone cannot prove visible single notification. |
| AC-DT-1/2: theme and contrast switch via data attributes without reload | KEEP | Theme/contrast DOM attributes change immediately and theme persists. Protects actual shell subscription without reload. |
| header: mode tabs, workspace tabs and the palette button work through commands | KEEP | Workspace tab selectsAssembly, export/edit modes follow commands/store, palette opens. Distinct integrated shell controls. |

## `apps/web/test/shell.test.tsx`

Independent source: S05 SH-021/023, WS-010/014, KB-001…007/013, MN-004/010; XF-053. Stable seam/non-test caller: workspace storage/keyboard dispatcher/menu resolver public boundaries. Unique ownership/refactor basis: Storage byte compatibility, event consumption and platform chord semantics are independently specified.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| drops unknown panel kinds from a saved layout (SH-023) | KEEP | Unknown hologram panel is removed from panel map and grid while Project survives. Protects conservative compatibility repair. |
| a newer workspace storage version falls back without loading its data (SH-021) | KEEP | Futureversion99 resets toediting and clears unreadable storage. Protects newer-config fallback. |
| ignores inherited object keys as workspace ids (storage and workspace.switch args) | KEEP | Inherited constructor/toString keys never become workspace IDs. Protects prototype-based hostile storage/arguments. |
| state saved by a build that had the Agent panel still loads (wp-mcp) | KEEP | Old removed Agent workspace loads without reset and preserves custom Mine. Protects supported historical data. |
| persists a saved workspace and imports a duplicate name with a suffix (WS-010, WS-014) | KEEP | Saved layout reloads; importing duplicate Editing gets suffix(2). Protects persistence/import collision policy. |
| AC-KB-1: = zooms thumbnails in Project and the timeline when Timeline is focused | KEEP | Equal key dispatches Project or Timeline zoom byfocus. Public scoped dispatch, not model zoom math. |
| AC-KB-2: typing "j" in a search field does not shuttle; Ctrl+S still saves | KEEP | Text search ignoresJ/undo but Ctrl+S remainsglobal. Protects typing from edits. |
| a widget that consumes a key wins; otherwise the command runs after it | KEEP | Widget-prevented ArrowRight wins; unconsumed ArrowRight dispatchescommand. Protects consumed-event precedence. |
| repeat only for repeatable commands; keyup reaches hold-to-act commands (KB-006/007) | KEEP | Repeated S togglesonce and L keyup reacheshold command. Protects repeat/release protocol. |
| Esc during a pointer drag is left to the drag; after the release it runs gesture.cancel (XF-053) | KEEP | Esc duringpointerdrag bypassesglobal cancel; afterrelease/missingrelease/blur reachesit. Protects drag cancellation ownership. |
| disabled commands fall through to an enabled global binding (KB-002) | KEEP | Disabled local Ctrl+B falls through to enabledglobalbinding. Protects contextual shortcut fallback. |
| keys in a modal dialog reach its controls: Enter / Space / ↓ open a focused Select, no shortcut runs | KEEP | Modal Select Enter/Space/Down openscontrol and doesnotrun timeline transport. Protects keyboard isolation in modal. |
| formats shortcuts per platform (MN-004) | KEEP | Linux/mac shortcut labels use Ctrl/⇧⌘ and palette Ctrl+Shift+P. Platform key protocol formatting. |
| unregistered commands stay visible but disabled with a reason; undo shows the step name | KEEP | Undo/Redo dynamically include actual history step/agent origin; unavailable commands disable with reason. Protects menu state. |
| capability-gated commands explain what is missing; edit-only menus are disabled outside Edit (MN-010) | KEEP | Missingengine disables export with reason; outside Edit disables sequence actions. Protects menu capability/mode policy. |

## `apps/web/test/source.test.ts`

Independent source: S03 SRC-001…004, AC-SRC-1; ARCHITECTURE §2.3 marks. Stable seam/non-test caller: source monitor state and focused registered commands → source marks/timeline clips. Unique ownership/refactor basis: Model placement/marks tests do not protect selection of the Source transport instead of sequence transport.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| opens media items and keeps a recent list | KEEP | Unknown item refuses; opening valid media recordsrecent; close clearsactive. Protects Source state selection. |
| Overwrite places the marked range at the sequence playhead (AC-SRC-1 logic) | KEEP | Source In30/Out90 overwritesat15 with60-frame linkedA/V, sourceIn705600000, playhead75. Protects source→sequence time conversion. |
| with the Source monitor focused, I/O and Shift+I act on the source item, not the sequence | KEEP | Source-focused I/O write media marks705600000/2116800000, leave sequence marksnull, Shift+I seeksSource30. Protects focus routing. |

## `apps/web/test/speech.test.tsx`

Independent source: speech work note/options/transcription/import contracts; AGENTS licences/data integrity. Stable seam/non-test caller: GenerateTranscriptDialog, job watcher, mixAttach, AutoTranscribeHost → HTTP/document/undo. Unique ownership/refactor basis: Speech engine owns inference; web uniquely translates controls and completed media/mix jobs into editable transcripts.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| sends model, language, translate and speaker options for the media of a sequence | KEEP | Dialog German/translate/speaker controls emitmodelbase/language de/task translate/count2 and watchjob. Protects HTTP option translation. |
| shows the licence of a missing model and downloads it before transcribing | KEEP | Missingmodel showsMIT, disables Transcribe, installPOST enablesit. Protects licence-first model download workflow. |
| English-only models fix the language and cannot translate | KEEP | English-only model forceslanguage en and omits translation. Distinct model capability policy. |
| commit one "Generate Transcript" step the sequence transcript reads; undo removes it | KEEP | Finishedjob attaches actualwords; trimmedclip mapsmedia6s tosequence2s; one undo removestranscript. Protects watcher/document integration. |
| a sequence-mix result goes to the clip media in media time, and is refused after an edit | KEEP | Sequence-mix result at1.5s attachesmedia5.5s with5–15s coverage; subsequentmove refuses stale result. Protects time mapping and stale data. |
| transcribes newly imported media with sound when enabled (not on undo/redo) | OPTIMIZE | Imported audio emitsone transcription with chosenmodel/fr; undo/redo emitsnone. Replace arbitrary50ms waits with engine-ready/controlled scheduling. |

## `apps/web/test/test-timeout.test.ts`

Independent source: docs/performance.md test timeouts; root shared-host verification contract. Stable seam/non-test caller: Vitest project configuration under controlled host-load calibration and PERF flag. Unique ownership/refactor basis: Configuration is the actual runner boundary; it does not mock the timeout formula being asserted.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| exports load-scaled timeouts bounded between 15 and 60 seconds | KEEP | Documented factors1/1.5/2/3/10 yield15/15/20/45/60s. Detects accidental floor/ceiling/scaling policy change. |
| exports the strict 5-second timeout when PERF mode is enabled | KEEP | PERF strict mode yields5s atbothlow/highload. Detects relaxed strict benchmark timeout. |

## `apps/web/test/third-party-notices.test.tsx`

Independent source: S11 FIX-010, ARCHITECTURE D-13/D-36; AGENTS third-party notice contract. Stable seam/non-test caller: mounted About notice and fetched notice-file content/URL. Unique ownership/refactor basis: Generator tests cannot prove users can access notices or that offline fallback attribution is present.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| without an engine, the About notice identifies anime.js and its MIT license | KEEP | Withoutengine, About stillnamesanime.js and MIT. Required attribution content, not arbitrary UI copy. |
| links THIRD_PARTY_NOTICES.md and shows it when opened | KEEP | Linktargets /THIRD_PARTY_NOTICES.md and opening displays returnednotice. Protects public assetpath and accessible licence delivery. |
| says so when the file is missing | REWRITE | 404 displaysa missing-file explanation. Failure-surface contract remains; narrow wording tosemantic failure, not exact phrase. |
| shows the ported source records on their own (licenses/ported, D-36) | KEEP | Ported marker section showsBlur kernels and excludes unrelatedanimejs package row. Protects provenance record extraction. |

## `apps/web/test/time.test.ts`

Independent source: time-remapping work note, S02 Show Clip Keyframes and Scene Edit Detection. Stable seam/non-test caller: registered time commands/keyframe menu → real sequence and view state. Unique ownership/refactor basis: Model retiming tests cannot protect active clip selection, dialog range routing or mutually exclusive UI lanes.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| shows the band, adds a speed keyframe at the playhead, sets interpolation, removes the remap | KEEP | Active selectedvideo speedband opens, keyframe toggles1→0, opticalflow sets, remove undo restoresremap. Protects UI routing. |
| Scene Edit Detection opens its dialog for the selected video clips with their media ranges | KEEP | Scene Detection openscorrectdialog forselectedvideo withmedia0–4s range. Model scene tests cannot select dialog targets. |
| shows the speed band and hides the property lane; another property hides the band | KEEP | Speed menu hidespropertylane; selectingOpacity hidesSpeedband. Protects mutually exclusive representations. |

## `apps/web/test/timeline-commands.test.ts`

Independent source: S02 TL-549/680…766/900 and cited AC-8/11/13/15/16 cases. Stable seam/non-test caller: registered timeline commands → real EditorSession document, history, playhead and refusals. Unique ownership/refactor basis: Model edits do not choose focused panel, targeted/selected tracks, playhead interval or reveal behavior.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| AC-13a: with V1 and A1 targeted, Ctrl+K at 240 splits only V1/A1 clips crossing 240 | KEEP | TargetedV1/A1 splitat240; V2 untouched. Protects targeting policy. |
| with a selection only the selected clips crossing the playhead split; Ctrl+Shift+K splits all | KEEP | SelectedV2 only splitat100; allTracks splitsV1/V2 at200. Protects selection override/alltracks variant. |
| AC-13b: ripple delete with content on a sync-locked track is refused with a message naming the track | KEEP | Sync-lockedV2 refusesrippledelete withtrack identified; unlock allowsit. Protects refusal routing. |
| AC-16b: ripple-deleting a 30-frame clip before a marker moves it 30 frames left | KEEP | Delete30frames shiftsmarker90→60; disablingrippleMarkers preserves60. Protects marker toggle forwarding. |
| Delete with a gap selected closes the gap; Delete with clips leaves gaps | KEEP | Gapclear closes50-framegap; clipclear leavesgap. Protects contextual Delete selection. |
| edit.clear (global Delete / Edit ▸ Clear) routes to the focused panel | KEEP | Globaledit.clear routesTimeline; infofocused refuses. Protects sharedEdit command focus routing. |
| AC-11d: Q removes the head, closes the gap, moves the playhead to the old start; undo restores exactly | KEEP | Q trims130→100, shiftsclipend170 andplayhead100; undoexact. Protects playhead interval/undo integration. |
| W ripple-removes [playhead, end); Alt+Q / Alt+W leave gaps | KEEP | W ripplecloseshead interval; Alt Q/W leave gaps at60/100. Protects non-ripple alternatives. |
| linked partners follow once; nothing under the playhead is a hinted no-op | KEEP | LinkedA/V bothtrimonce to270; emptyplayhead makesnohitory/edit. Protects link dedup/no-op. |
| E extends the selected edit point to the playhead with its trim type | KEEP | E honorscycledroll editpoint, movesjoint120 then119. Protects trim-type selection dispatch. |
| AC-15a/b: I at 100 and O at 199 give a 100-frame range; undo after O restores the previous Out | KEEP | I100/O199 stores[100,200); undoOutreturns200; invertedmarks policy. Protects inclusiveUI/exclusivemodel conversion. |
| AC-13d: Extract with In=100 Out=199 removes exactly 100 frames and clears In/Out | KEEP | Extract[100,200) removesexact100frames andclearsmarks/seeks100. Protects selectedrange routing. |
| Lift without In/Out is a hinted no-op | KEEP | Liftwithoutmarks leavesdocument/historyunchanged. Protects no-op user command. |
| Mark Clip and Mark Selection | KEEP | MarkClip gives10–60; MarkSelection spans10–120. Protects selection interval calculation. |
| AC-8c: Ctrl+A never selects clips on locked tracks | KEEP | SelectAll excludeslockedV2. Protects lock-awareselection. |
| nudges coalesce into one history entry and clamp at frame 0 | KEEP | Nudgeright+many changes3→9, coalescesoneundo, leftclampszero. Protects coalescing/clamp. |
| D selects the clip at the playhead on targeted tracks | KEEP | D selectsclip atplayheadonlytargetedV2. Protects target-awareselection. |
| markers: M adds at the playhead; Shift+M / Ctrl+Shift+M navigate | KEEP | M createsmarkers30/90; next/previous/clear actatknownframes. Protects navigation andclearing. |
| gesture.cancel with nothing active deselects | KEEP | Idlegesture.cancel clearsselection. Activegesture cancellation isadifferent controllercontract. |

## `apps/web/test/timeline-gestures.test.ts`

Independent source: S02 TL-400…406/480…491/530…549/605…632/740 and cited acceptance cases. Stable seam/non-test caller: TimelineController pointer/key/wheel entry points → document/history/selection/viewport. Unique ownership/refactor basis: Numeric model commands cannot prove pointer deltas, tool modifiers, snapping or transient-cancel routing.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| rounds the pointer delta to frames and commits exactly one history entry | KEEP | 73px at10px/frame movesclip10→17 withonehistoryedit. Independentliteralrounding. |
| AC-10d: Escape during a drag restores everything and creates no undo entry | KEEP | Cancellinglive dragrestoresdrawndoc/history andlaterpointerupdoesnotcommit. Distinct transient lifecycle. |
| AC-9a: a clip whose end comes within 8 px of the playhead snaps onto it and shows the indicator | KEEP | Rawend198 within8px snaps200; committedclip150–200. Protects pointer snapping integration. |
| Ctrl at release performs an insert move (AC-10b through the gesture) | KEEP | Ctrlrelease insertssourceat300, splits/ripplesothertracks. Protects release-time insert modifier. |
| Alt drag duplicates with overwrite; the originals stay | KEEP | Altdragcreates100–150 cloneandpreserves0–50. Protects duplicate mode. |
| vertical moves change tracks within the kind; linked audio keeps its track (TL-486) | KEEP | Verticalvideomove changesV1→V2 whilelinkedaudiostaysonA1. Protects kind/linkedtrackmapping. |
| Shift after the start constrains to the dominant axis (TL-488) | KEEP | LateShift constrainsdominantaxis tohorizontal50frames. Protects modifier update midgesture. |
| clips on locked tracks cannot be grabbed (TL-481) | KEEP | Lockedtrack refusesgrabandselection. Protects pregesturelockgate. |
| clicking selects the link group; Alt selects one side; clicking empty space deselects | KEEP | Clickselectslinkedgroup; Altselectsonlyaudio; emptyclickclears. Protects link-select policy. |
| AC-8a: marquee over the video clip selects its linked audio; linked selection off selects only video | KEEP | MarqueeincludeslinkedAudio unlesslinkedSelectionoff. Distinct marquee extension. |
| AC-8b: Shift-marquee over a selected clip deselects it and keeps the rest | KEEP | Shiftmarquee subtractsselectedsecondclipandkeepsfirst. Distinct toggled selection. |
| AC-8c and AC-7c: marquee selects 1 px clips but never clips on locked tracks | KEEP | One-pixelclipselected; lockedtrackclipneverselectedbyrectangle/click. Thin target access and lockpolicy. |
| Escape during a marquee restores the previous selection | KEEP | Escmarquee restorespriorselection. Distinct selectiontransient cancel. |
| clicking a gap selects it (TL-740) | KEEP | Gapclickselects20–100 oncorrecttrack. Protects emptyintervalhit. |
| track select forward selects everything from the click on all unlocked tracks (TL-605) | KEEP | Forwardtracktool selectslaterclipsonunlockedtracks. Distinct tool selection algorithm. |
| regular trim stops at the neighbour and shows the limit indicator (AC-11b) | KEEP | Normalouttrimhitsneighbour, showlimitsandcommitsno-op. Protects boundedgesturefeedback. |
| regular trim of the in edge by 10 frames | KEEP | Normalintrim movesstart0→10, keepsend100, onehistory. Protects In-edge time direction. |
| Ctrl-edge ripple trim and the Ripple tool (AC-11c path) create one entry | KEEP | Ctrledge andRippletool bothshiftfollowingclipandothertrack, eachoneentry. Distinct tool/modifier dispatch. |
| AC-11c: ripple trim stops at the largest amount a sync-locked track allows | KEEP | Sync-lockedtrack limitsdesired70 jointto90. Protects cross-trackgestureclamp. |
| rolling tool (N) moves the edit point | KEEP | Rollingtooljoint100→110 preservesend150 andoneentry. Distinct two-sidededit gesture. |
| slip (Y) changes source time in one history entry | KEEP | Slip10frames changesonlysourceIn to50framesinoneentry. Protects source-timegesture. |
| razor (C) click splits once; Shift splits all unlocked tracks; Alt ignores links | KEEP | RazorclicksplitslinkedA/V; Shiftalltracks; Altbreakslinks. Distinct tool/modifiers. |
| razor snaps to the playhead even with snapping off (TL-620) | KEEP | Razorwithinplayheadband snaps50 evenglobalSnapoff. Protects razor-specific override. |
| rate stretch doubles the duration and halves the speed (AC-12d through the tool) | KEEP | RateStretch120→240frames changesrate1→0.5. Protects time-stretch tool. |
| Escape cancels a trim with no entry | KEEP | Canceltrimrestores0–100 andhistoryunchanged. Distinct trimtransaction abort. |
| AC-3c: \\ then \\ returns to the exact prior zoom and scroll | KEEP | Two zoom-to-sequence togglesrestoreexact7.3/123.4 savedview. Protects userviewport restoration. |
| Alt+wheel zooms around the pointer | KEEP | Wheelzoom retainsknownanchorframe at500px aftermixedscrolls. Protects anchor stability incontroller. |
| ruler scrubbing seeks with the floor rule and Shift snaps to markers (AC-9b) | KEEP | Rulerfloor100.975→100; Shiftnear101 snapsmarker103 andseeks103. Distinct seekrounding. |

## `apps/web/test/timeline-model.test.ts`

Independent source: S02 TL-100…113/1053/A.3/328/331/333; S04 TH-003/WF-001/003. Stable seam/non-test caller: production viewport/snapping/filmstrip/waveform functions → literal outputs. Unique ownership/refactor basis: These are navigation/time math, sprite protocol and waveform amplitude rules independently specified by those sources.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| AC-3a: a 3 h 29.97 sequence zooms to ≥ 40 px per frame anywhere and trims move 1 frame per 40 px | KEEP | Three-hour29.97fpssupports40px/frame andsymmetric±half-framerounding. Protects precision/longtimeline math. |
| wheel mapping follows TL-111 | KEEP | Documentedplatformwheelmodifiersturnintohscroll/vscroll/zoom/both. Protects inputmapping. |
| nearest target within the threshold wins, then priority | KEEP | Nearesttargetwins, tiespreferplayheadpriority; out-of-thresholdnull. Protects exactsnapselection. |
| uses the nearest tile at or before the requested time | KEEP | 5.9sselects4stile,6selects6, out-of-rangeclamps0/58. Protects spritesamplingprotocol. |
| takes the max over the peaks covered by each column | KEEP | Knownpeaksmaximaover0.5scolumnsyield49/99/49/99. Protects alias-freewaveform reduction. |
| AC-7b: -6 dB halves the drawn amplitude; clipping is flagged | KEEP | −6dBgain≈0.501,0.8peakdraws40px,positivegainflags/clampsclip. Explicitwaveform amplitude requirement. |

## `apps/web/test/timeline-panel.test.tsx`

Independent source: S05 TOOL-001…005. Stable seam/non-test caller: mounted ToolsPanel pointer and context-menu actions → active tool. Unique ownership/refactor basis: Command registry/tool-controller tests do not prove toolbar/flyout dispatch.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| clicking a button selects the tool; right-click opens the group flyout | KEEP | ToolbarRazorselectionandcontextflyoutRollingselection changerealactivetool. RemovefinalincidentalDOMbuttoninventoryifdesired. |

## `apps/web/test/timeline-peaks-stream.test.ts`

Independent source: S04 waveform container-stream-index protocol; historical movie audio stream1 regression. Stable seam/non-test caller: peaksFor issues real fetch Request URLs and decodes returned Float32 peaks. Unique ownership/refactor basis: Engine peak generation cannot protect the web selecting audio container stream1 instead of ordinal audio0.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| requests the peaks stream with the clip's container stream index (movie audio = stream 1) | KEEP | Movieaudio containerstream1 requests1.bin anddecodes[0.5,0.25],notordinal0. Publicpath/bytes independentoracle. |

## `apps/web/test/timeline-transition-index.test.ts`

Independent source: S10 transition spans; half-open interval query API; transient-move cache regression. Stable seam/non-test caller: transitionIndex/transitionsInRange consumed by timeline drawing/hit tests. Unique ownership/refactor basis: Exhaustive interval intersection is an independent mathematical oracle for indexed search; model geometry alone does not test index invalidation.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| matches exhaustive half-open range queries, including long overlaps and equal starts | KEEP | Handarrangedlongoverlaps/equalstarts indexedqueriesmatchindependenthalf-openintersections; missingtrackandcallerunsortedmapswork. Protects binaryquerylogic. |
| queries the new range after a transient clip movement | KEEP | Transientmoveclip9 from900to5000 invalidatesoldindexquery. Protects cachekey dependenceonclipsrecord. |

## `apps/web/test/transport.test.ts`

Independent source: S02 TL-872…877, AC-18a/b/c; S03 ARC-010/PGM-003/XF-023; WP3I watchdog regressions. Stable seam/non-test caller: Shuttle/PlaybackDriver adapter boundary + real TransportStore; registered navigation/nudge commands. Unique ownership/refactor basis: Controlled Player and audio callbacks isolate external clocks; production driver alone decides transport state, rates and synchronization.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| L L L yields 4×; J then yields −1×; K stops (AC-18a) | KEEP | JKLsequence1→4→8,reverse−1,Kstops. Explicitshuttleratestatemachine. |
| hold K + tap L five times advances exactly five frames (AC-18c) | KEEP | K+fiveLtapsmovesexactlyfiveframes/stayspaused. Distinct tapcontract. |
| hold K + hold L plays at 0.25× until release; repeats are ignored | KEEP | K+heldL at250msplays0.25untilrelease; repeatignored. Distinct holdcontract. |
| Space toggles 1× forward play; Shift+L/J steps the slow rate by 0.1 | KEEP | Spacetoggles1×; slowcommandsincrement0.1andcrosszero/reverse. Distinct controls. |
| restarts at 1× after the transport stopped on its own | KEEP | StoppedtransportresetsnextL from2×to1×. Historical external-stop regression. |
| plays natively at 1×: the Player is the clock and frames are reported | OPTIMIZE | NativePlayerclock reportsframe10, pause/storedseek42 reflectedinplayer. Publicadapterstate. |
| re-issues play() when the Player does not start or stalls while playing (no frameupdate, not buffering) — WP-3I | OPTIMIZE | No-frame-start/stall restartsfromlastframe; progressing/buffering/pausedplayersarenotkicked. Historicalwatchdogregression. |
| does not kick a Player that renders slowly; a real stall after slow frames is still kicked | OPTIMIZE | 700msframesareallowedbut5srealstallrecovers. Distinctadaptivewatchdogpolicy. |
| a slow machine: the next play's slow first frame is not a stall; a real stall is still kicked | OPTIMIZE | Secondplay900msfirstframeisallowedandlaterstallrecovers. Distinctbetween-playhistoryregression. |
| mutes audio below 1× (TL-874) | OPTIMIZE | 0.25×playbackmutesaudio. ExplicitTL874contract. |
| uses seek-stepping at 8×: timecode advances 8× real time, seeks ≤ 30/s (AC-18b) | OPTIMIZE | 8×virtualsecondadvances≈240frameswith≤31seeksandcancelsrAFonpause. ExplicitAC18bresourcebound. |
| plays reverse by stepping and stops at 0 | OPTIMIZE | Reversefrom30reacheszeroandstops. Distinct steppingdirection/endbound. |
| stops at the sequence end, or loops In→Out when loop is on (TL-875) | OPTIMIZE | Nativeendstops; loop[10,20)returns10. Distinctend/loopbehavior. |
| Play In to Out stops on the last marked frame (TL-877) | OPTIMIZE | PlayRange10–20stopson19. Protects exclusiveend. |
| follows external seeks while playing | OPTIMIZE | Externalseek80whileplayingupdatesPlayer. Protects bidirectionaltransportclock. |
| with an audio graph a seek while playing restarts: pause, seek once the graph is ready, play (sound-design Phase 6) | OPTIMIZE | Audioseekpausesuntilgraphready,seeks80thenplays; restartwithouttargetpreservesframe. Explicitprimed-startsynchronization. |
| the stall watchdog leaves a Player alone while the audio holds the picture for a primed start | OPTIMIZE | WhileaudiostartWaiting,2sno-frameisnotastall; afterreadygenuinestallrecovers. Distinctfalsewatchdogaudio regression. |
| a seek during a restart plays from the latest target; a pause during it abandons it | OPTIMIZE | Newseek120supersedes80duringrestart; pauseabandonslater200restart. Protects async latest-wins/cancellation. |
| steps, jumps to start/end and edit points | KEEP | Registeredstep/navigationcommandsreach6/5/end120/edits60/90/zero. Protects commandrouting. |
| nudges the selected layer by 1 and 5 px with one coalesced undo step (XF-023) | KEEP | Programnudges2pxright/5pxdownyield962/545 inonecoalescedundo. Distincton-canvas commandrouting. |

## `apps/web/test/vite-chunks.test.ts`

Independent source: S11 ANM-023 explicitly requires animejs manualChunks → vendor-anime. Stable seam/non-test caller: actual Vite output configuration manualChunks contract. Unique ownership/refactor basis: The exact name is an independent build configuration requirement, not an invented wrapper/export inventory.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| puts anime.js subpath modules in vendor-anime | KEEP | Literalanimejs timeline/svgsubpathIDsresolvevendor-anime viaactualViteconfig. PublicANM023configurationnameisindependent. |

## `apps/web/test/voiceover-latency.test.ts`

Independent source: spec12 Phase0 WP0.1 input/output latency compensation; preference range contract. Stable seam/non-test caller: real takeRange/assembleTake/latency parser over independently simulated wall/capture clocks. Unique ownership/refactor basis: The simulator uses physical time and injected claps, not the implementation's clock-estimation algorithm.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| without jitter the clap lands on the record point (±1 sample) | KEEP | Zeroclockjitterandone-samplebufferclaplandswithinonesamplewith0.065sroundtrip. Propertyexcludesraf0sothisretainsuniqueexactcase. |
| simulated input latency: aligned within one capture buffer; uncompensated it is not | CONSOLIDATE (remove) | CONSOLIDATE: general300-casesimulationpropertyalreadyownsnonzerolatency/jitterwithin-buffer. OmittedinputLatencynegativecontrolisnotrequiredcorrectbehavior. |
| any latency, buffer and report jitter: within one buffer (property) | KEEP | Physicalsimulatorvariescapturebuffers/jitter/input/outputlatency; clapmustlandwithinonebuffer. Oraclewalltimeindependentofproductionlower-envelope estimator. |
| a late frame report (stall) does not shift the take (lower envelope of the pairs around the frame) | KEEP | Single500msframe-reportstallcannotshifttake. Distinctadversarialcapture-clockregression. |
| the user offset and the capture-context fallback; hostile values count as 0 | KEEP | Offset−5ms/output20msgives15ms;fallbackcapture25ms;hostilelatencieszerobounded. Distinctfallback/configinputs. |
| the Latency Offset preference parses tolerantly (−500 … 500 ms, default 0) | KEEP | Persistedlatencyoffsetdefault0,12.4→12,−9999→−500,invalid→0. Independentpreferencebounds. |

## `apps/web/test/workspace-migration.test.ts`

Independent source: S05 SH-020/021, spec12 §2.7 WP3.3b/WP5.2; AGENTS immutable migrations. Stable seam/non-test caller: stored jasper:workspaces v1/v2 bytes → WorkspaceStore and migration outputs. Unique ownership/refactor basis: Persisted tab placement is a migration byte/compatibility contract; current unrelated/custom layouts must survive.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| adds Review as a background tab before Markers in the stored current and saved layouts; nothing else changes | REWRITE | v1storedcurrent/savedgainReviewandSoundCheckatcorrectpeergroupwhileactive/custom/otherdataunchanged; reloadversion3. RemovepanelState-derivedexpectations. |
| is idempotent and never duplicates the panel (Review already open, docked or floating) | REWRITE | Existingdocked/floating/alternateIDReviewmustnotduplicate; repeatmigrationdeepcontentunchanged. Removeobjectidentityconstraint. |
| leaves factory (null) layouts and layouts without a host group alone | REWRITE | Nullfactory/nohostlayoutsunchanged;libraryhostgetsbackgroundReviewwithoutinputmutation. Replaceidentitywithcontentassertions. |
| corrupt, unknown and newer stored data are still reset (SH-021) | REWRITE | Corrupt/unknown/futurestoredversionsresetsafely;invalidv1payloadstillrefuses. Replacederivednewerversionsetupwithfixedfutureliteralwherepossible. |
| never throws on hostile stored data, and adds at most one Review panel (property) | REWRITE | Hostilestoredlayoutsmustnotthrow/duplicatenewReview. Removeweakdata-definedprobe;keepactualno-throw/countguarantees. |
| adds Sound Check right after Review in the stored layouts; nothing else changes | REWRITE | v2storedlayoutsinsertSoundCheckbesideReviewpreservingactive/customdataandreload. RemovepanelStateoracle/objectidentity. |
| without Review it goes where Review went (before Markers); the factory layout has it already | REWRITE | WithoutReview,newSoundCheckjoinsMarkers;missinghostandfactoryalreadycontainingitremaincontent-equal. Removeidentityonly. |
| never throws on hostile stored data and adds at most one Sound Check panel (property) | REWRITE | Hostilev2inputmustnotthrow/duplicatenewSoundCheck. Independentrobustnesspropertyatthepersistedmigrationboundary. |

## `apps/web/test/wp2e/import.test.ts`

Independent source: S01 LIFE-010; S04 §5.3 AC2 and IN-007/013; S07 PRC-019. Stable seam/non-test caller: EngineImportService + real session and protocol fixture → locators/clips/jobs/unload events. Unique ownership/refactor basis: Engine upload tests cannot protect web batch transactions, source-range sidecar association, prompt policy or client unload guards.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| timeline drop imports two files in order in one undo step | KEEP | Twofiles2/3sdropatframe30as[30,60]/[90,90]A/Vwithoneundo. Protects orderedbatchtimelineplacement. |
| web: uploads files in client jobs and commits ONE transaction with engine-store locators | KEEP | TwoUploadsproducechosenengine-storekeys/successjobsinoneundo. Protects web acquisition/commit protocol. |
| web: a source-range sidecar picked with a render makes it a version of its source (M3, S07:PRC-019) | KEEP | Render-before-sourcebatchsidecarfirst174/130frameslinkstorealsourcewithoutuploadingJSON. Distinctcrossfileassociation. |
| lists per-file failures and commits the rest (S04 §5.3 AC 2) | KEEP | Goodfilecommits;corruptfileyieldsUNSUPPORTED_MEDIA/per-filefailurewithoutlosinggoodresult. Partialfailurepolicy. |
| dedupes by fingerprint with one prompt per batch (S04:IN-007) | KEEP | Samefingerprintreusesoldassetwithoneprompt,leavesnewasset. Distinctdedupeuse-existing. |
| "Import again" adds another project item referencing the same asset | KEEP | Importagainreusesassetbutaddsseconditem. Distinctduplicate-choicebranch. |
| timeline drop into an empty sequence asks about the clip mismatch and updates the settings | KEEP | Emptysequenceacceptsmismatch1280×720/25fpsand250-frameclip;laterimportdoesnotpromptagain. Distinctmismatchpolicy. |
| desktop: registers picked paths in place and adds a path locator | KEEP | Desktopregisterspathsinplace,addsengine/pathlocatorsandreportsbrokenname. Distinctno-uploaddesktopacquisition. |
| guards beforeunload while uploads run (S04:IN-013) | KEEP | Duringuploadbeforeunloadpreventsdefault;aftercompletionallowsit. Actualbrowser-eventguardboundary. |
| placeItems: Project items dragged to the timeline become one Overwrite transaction | KEEP | Projectitemdropduplicatesitemat10/40inoneadditionalundo. Distinctalready-importeditemplacement. |
| reads DataTransfer payloads: in-app items first, then OS files | KEEP | JaspermimewinsoverOSfiles;OSfilesfallback;plainexternaltextnull. Publicdragpayloadprecedence. |

## `apps/web/test/wp2e/ui.test.tsx`

Independent source: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S04 RP-011/012; D-13. Stable seam/non-test caller: mounted Home/Project/Jobs/Export controls → real document/HTTP requests/configuration. Unique ownership/refactor basis: Backend tests cannot protect confirmation before requests, selected presets, disconnected upload display or codec controls.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| requires confirmation before deleting a project | KEEP | HomeDeleteemitsnoDELETEuntilconfirmthenrequestsrightproject. Protectsdestructiveactionconsent. |
| moves media into a bin and finds it from the project root | KEEP | Newbinrename/dropmovesactualitem;rootsearchfindsnesteditem. ProtectsUIbinrouting/navigation. |
| warns before deleting media that is used in a sequence and deletes with force on confirm | KEEP | Usedmediaremovalwarns/preservesbeforeconfirm;confirmremovesitemanddependentclips. Protectsforceapproval. |
| creates a sequence from the selected preset | KEEP | Selectedverticalpresetcreates1080×1920activesequence. ProtectsUIpresetchoice. |
| keeps a ready 720 proxy when the 540 tier was never made (LIFE-050) | KEEP | Mediaupdated720ready/540noneretains720proxyURL. Historicalfallbackeventmerge. |
| cancels a running export job through the engine (JOB-003) | KEEP | JobsCancelbuttonPOSTstocorrectrunningexportjob. ProtectsUIjobrouting. |
| keeps client uploads running when the engine is disconnected (JOB-005) | KEEP | Engine503doesnotdelete/clientfailupload;rowstaysRunning. Protectsindependentclientjobstate. |
| sends the committed project envelope when requesting an export plan | KEEP | Planrequestcontainsjasper-projectenvelope,currentproject/sequenceandautoentirerange. Publicwirecontract. |
| forcing Native with native blockers disables Export (S04:RP-012, S05:EX-022) | KEEP | ForcingNativewithblockersdisablesExport. Protectspreventionofunsupportedexport. |
| starts export without a stale plan ID and remembers settings (EX-013/014, RP-011) | KEEP | ExportrequestomitsstaleplanIdandpersistedautoenginechoice. Protectsrevision-awareplanuse. |
| uses an available codec when H.264 is unavailable (ARCHITECTURE D-13) | KEEP | NoH264availableforcesAV1,disablesH264andplansAV1. ProtectscapabilityUIfallback. |
| disables unusable hardware and GPL encoders in LGPL-only mode (ARCHITECTURE D-13) | KEEP | LGPL-onlydisablesx264andbrokenNVENCbutallowsOpenH264. Publiclicence/capabilityselectionpolicy. |

## `apps/web/test/wp3i-integration.test.ts`

Independent source: export filename suffix and path safety contract. Stable seam/non-test caller: sanitizeFileName called by export settings. Unique ownership/refactor basis: Engine final output extension is a different boundary; this prevents user input from creating repeated suffixes/paths.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| drops a typed .mp4 extension (the export adds it) and keeps other names | KEEP | MP4suffixremovedcase-insensitively;slashes/colonssanitized;emptystemsExport;MOVretained. Literalfilenamebytecontract. |

## `apps/web/test/wp65a-audition-view.test.ts`

Independent source: WP6.5a item7 audition view restoration; S02 TL-120. Stable seam/non-test caller: scrollAfterAudition and in-context start/end observer API → returned view/playhead. Unique ownership/refactor basis: Audition controller must preserve the first return point across replacements; static viewport math cannot emit lifecycle events.

| Named case | Outcome | Concrete oracle / failure protection |
|---|---|---|
| goes back to the view before playback when the returned playhead is in it, else reveals it | KEEP | Restoreoldview0whenreturnframe40fits;otherwise reveal150at25%edge. RemovehostileNaNsubcaseifnocrediblecaller;coreviewportrestorationunique. |
| one start and one end with the frame the playhead returned to, also when a window replaces another | KEEP | Replacingwindowemitsonestart/oneendandreturnsfirstframe12. Publicobserverlifecycleprotectsviewsave/restore. |
| an audition ended without returning the playhead (the session closed, another sequence) says null | KEEP | Sessionendwithoutreturnemitssavedframe null. Distinctabandonedwindowcontract. |

## Concrete follow-through and limits

The coordinator reports implementing proposal-program copy/identity pruning, deleting the redundant direct save-before-leaving case, and replacing Review UI production mark/reset trust-test hooks with production input tracking driven through the event boundary. Speech fixed waits, driver lifecycle disposal and workspace assertion changes were sent as actionable findings; verify the final coordinator diff for their disposition.

PlaybackDriver setup currently constructs real watchdog timers/listeners without calling `dispose()`. Cases ending in native play or a pending audio restart can leave owned handles; dispose each created driver before restoring globals. This is resource cleanup, with no measured duration claim. Speech auto-import's two 50 ms sleeps should become EngineProvider readiness/controlled scheduler synchronization while preserving the no-second-request assertion after undo/redo.

Migration expected values constructed with `panelState` and exact `toBe` identity are not independent persisted-content oracles. Preserve historical literal tab names/order, active view, custom-layout bytes, no duplication, no mutation, reset states and actual stored version. Do not edit a shipped migration just to remove constant export visibility; document that immutable-migration exception if those exports remain.

Validation: source/contract and diff review only for this supplemental scope; no test, typecheck, build, browser or performance pass is claimed. Root/coordinator owns execution. The intentionally retained Vite anime chunk test has an explicit ANM-023 configuration contract; it must not be removed merely for resembling an implementation-pattern test. The potentially expensive voice-over property has an independent physical clock/clap oracle, so it remains the stronger owner after consolidating its fixed nonzero-latency duplicate.

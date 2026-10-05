# Web shell, clipboard and processing cleanup — round 2

Disposition recorded before edits against remote-merged baseline 87ebec9. Baseline command: `pnpm exec vitest run` followed by these ten paths. No repository AGENTS.md exists; host-wide AGENTS instruction supplied in conversation applies. Test commands are root `test`, `lint`, `typecheck`.

## Bar interpretation and pre-edit evidence

For each retained/reworked case below: **B1** names the independent specification; **B2** is the concrete failure in the reason; **B3** expectations are fixed examples/spec-required outcomes, never values computed by the owner; **B4** names its consumer-facing seam; **B5** checks outputs/state, tolerating identifier/module/private collaborator refactors; **B6** identifies the uniquely owned UI/platform contract. Shared model tests own model mutations; web tests own focus, user choices and platform inputs; E2E owns actual browser clipboard permissions and real bundle rendering. Rewrites remove assertions that violate this interpretation.

Risk is low for declaration/private-copy deletion; medium for orchestration rewrites. Focused validation is `pnpm exec vitest run <path>` for every row; final repository gates are run by root. Production callers read before editing: EditorShell/KeyboardHost uses dispatcher/menus/workspace store; commands/clipboard uses clipboard system and attribute helpers; SourceMonitor and timeline commands use source-state; ProcessDialog/actions/MediaVersionSection use jobs/model; CompositionTexts uses editor gesture/session API; gallery uses PreviewThumb.

Test-only seams found: memoryStorage (only shell tests), resetWorkspaceStore (only shell render), resetCommandRegistry (shared several test files; parent coordinates), processWatcher list/configure/reset (only processing tests), exported delay/History constants (only tests cross module). Remove unused seams; preserve production mechanisms and defaults.

## apps/web/test/shell.test.tsx

### KEEP: drops unknown panel kinds from a saved layout (SH-023)

Unknown persisted panel would crash layout restore; valid panel survives.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Unknown persisted panel would crash layout restore; valid panel survives. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: a newer workspace storage version falls back without loading its data (SH-021)

A future storage version must be discarded and defaults loaded.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: A future storage version must be discarded and defaults loaded. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: ignores inherited object keys as workspace ids (storage and workspace.switch args)

Inherited object names must never become active workspaces (prototype-key regression).

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Inherited object names must never become active workspaces (prototype-key regression). B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: state saved by a build that had the Agent panel still loads (wp-mcp)

Removed Agent workspace must migrate while preserving custom workspace data.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Removed Agent workspace must migrate while preserving custom workspace data. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: persists a saved workspace and imports a duplicate name with a suffix (WS-010, WS-014)

Saving/reloading and duplicate import names preserve user workspace data.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Saving/reloading and duplicate import names preserve user workspace data. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: AC-KB-1: = zooms thumbnails in Project and the timeline when Timeline is focused

Physical = must route to the focused panel action.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Physical = must route to the focused panel action. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: AC-KB-2: typing "j" in a search field does not shuttle; Ctrl+S still saves

Typing cannot shuttle/undo editor state, while modified Save remains usable.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Typing cannot shuttle/undo editor state, while modified Save remains usable. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: a widget that consumes a key wins; otherwise the command runs after it

A widget-consumed arrow must not also move the playhead; ordinary arrow must dispatch.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: A widget-consumed arrow must not also move the playhead; ordinary arrow must dispatch. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: repeat only for repeatable commands; keyup reaches hold-to-act commands (KB-006/007)

Repeated toggles and missing release callbacks cause stuck or toggled editing state.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Repeated toggles and missing release callbacks cause stuck or toggled editing state. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: disabled commands fall through to an enabled global binding (KB-002)

A disabled scoped command must allow the enabled global binding.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: A disabled scoped command must allow the enabled global binding. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: keys in a modal dialog reach its controls: Enter / Space / ↓ open a focused Select, no shortcut runs

Modal dialog Select keyboard controls must open without global shortcuts consuming Enter/Space/ArrowDown (S05 KB-005).

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Modal dialog Select keyboard controls must open without global shortcuts consuming Enter/Space/ArrowDown (S05 KB-005). B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: AC-KB-4: the default keymap has no duplicate bindings per scope (every platform/runtime)

Duplicate keymap collision check; keymap.test validates all normalized physical chords at owner seam.

### REWRITE: formats shortcuts per platform with web fallbacks (MN-004, KB-013)

Platform shortcut labels and browser-safe fallbacks have independent keyboard specifications.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Platform shortcut labels and browser-safe fallbacks have independent keyboard specifications. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: unregistered commands stay visible but disabled with a reason; undo shows the step name

Retain undo/redo step and agent labels (explicit MN-011 wording); drop uncontracted disabled-copy wording and collaborator call arguments.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Retain undo/redo step and agent labels (explicit MN-011 wording); drop uncontracted disabled-copy wording and collaborator call arguments. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: capability-gated commands explain what is missing; edit-only menus are disabled outside Edit (MN-010)

Retain disabled menu states and nonempty reason; remove exact supplied-reason echo assertion.

B1: S05 SH-021/023, WS-010/014, KB-002/005/006/007, MN-004/010/011. B2: Retain disabled menu states and nonempty reason; remove exact supplied-reason echo assertion. B3: fixed input/output example from that contract. B4: WorkspaceStore, DOM keyboard dispatcher and resolved menus. B5: no private call/tree/order requirement remains after cleanup. B6: WorkspaceStore, DOM keyboard dispatcher and resolved menus is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

## apps/web/test/shell-render.test.tsx

### REWRITE: AC-SH-4: a corrupt stored layout opens the default layout with exactly one warning toast

Retain corrupt-storage warning and usable default workspace; remove panel inventory.

B1: S05 SH-021, DT theme preferences, mode/workspace navigation. B2: Retain corrupt-storage warning and usable default workspace; remove panel inventory. B3: fixed input/output example from that contract. B4: rendered shell and persisted UI preferences. B5: no private call/tree/order requirement remains after cleanup. B6: rendered shell and persisted UI preferences is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: AC-DT-1/2: theme and contrast switch via data attributes without reload

Theme/contrast DOM attributes and persisted theme are external styling/storage contracts.

B1: S05 SH-021, DT theme preferences, mode/workspace navigation. B2: Theme/contrast DOM attributes and persisted theme are external styling/storage contracts. B3: fixed input/output example from that contract. B4: rendered shell and persisted UI preferences. B5: no private call/tree/order requirement remains after cleanup. B6: rendered shell and persisted UI preferences is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: header: mode tabs, workspace tabs and the palette button work through commands

Retain workspace/export/palette navigation and export-mode synchronization; remove negative Agent text grep.

B1: S05 SH-021, DT theme preferences, mode/workspace navigation. B2: Retain workspace/export/palette navigation and export-mode synchronization; remove negative Agent text grep. B3: fixed input/output example from that contract. B4: rendered shell and persisted UI preferences. B5: no private call/tree/order requirement remains after cleanup. B6: rendered shell and persisted UI preferences is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

## apps/web/test/keymap.test.ts

### DELETE: contains every TL-903 command id

Command export inventory does not show usable shortcuts; dispatcher and command tests own behavior.

### DELETE: contains the S05:KB-010 shell bindings

Declaration-value inventory; format/dispatcher tests and real shell workflows cover effective bindings.

### DELETE: has no Agent panel bindings: agents connect over MCP (wp-mcp)

Negative command-name grep is obsolete-feature change detection.

### DELETE: binds physical KeyboardEvent.code values only

Regex declaration validation cannot establish working dispatch; browser event tests own physical codes.

### KEEP: has no duplicate bindings within a scope (${platform}/${runtime}, KB-011)

Conflicting normalized chords make commands unreachable; independently specified no-collision rule, parameterized by platform/runtime.

B1: S05 KB-011/013 keyboard configuration. B2: Conflicting normalized chords make commands unreachable; independently specified no-collision rule, parameterized by platform/runtime. B3: fixed input/output example from that contract. B4: normalized keymap configuration. B5: no private call/tree/order requirement remains after cleanup. B6: normalized keymap configuration is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: uses web fallbacks for browser-reserved chords (KB-013)

Browser-reserved shortcuts require safe web/PWA alternatives.

B1: S05 KB-011/013 keyboard configuration. B2: Browser-reserved shortcuts require safe web/PWA alternatives. B3: fixed input/output example from that contract. B4: normalized keymap configuration. B5: no private call/tree/order requirement remains after cleanup. B6: normalized keymap configuration is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: resolves focused panel → editing → global

Private scope array and candidate-list shape duplicated by shell dispatcher routing and clipboard command tests.

## apps/web/test/registry.test.tsx

### REWRITE: registers, evaluates and runs commands with capability gating and args validation

Retain invalid args/capability rejection, error result/toast, and successful execution; delete list/checked stub echoes and get-after-registration probes.

B1: ARCHITECTURE 7.3 and S05 SH-005/031. B2: Retain invalid args/capability rejection, error result/toast, and successful execution; delete list/checked stub echoes and get-after-registration probes. B3: fixed input/output example from that contract. B4: runCommand registry API and panel service lifecycle API. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand registry API and panel service lifecycle API is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: publishes services per instance and handles "not mounted"

Retain missing-target and stale-unmount regression; remove calling a mocked play function through a stored object.

B1: ARCHITECTURE 7.3 and S05 SH-005/031. B2: Retain missing-target and stale-unmount regression; remove calling a mocked play function through a stored object. B3: fixed input/output example from that contract. B4: runCommand registry API and panel service lifecycle API. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand registry API and panel service lifecycle API is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

## apps/web/test/source.test.ts

### KEEP: opens media items and keeps a recent list

Open/close and recent source item state are visible to Source monitor consumers.

B1: S03 SRC-001/003/004. B2: Open/close and recent source item state are visible to Source monitor consumers. B3: fixed input/output example from that contract. B4: source state command facade and real EditorSession document. B5: no private call/tree/order requirement remains after cleanup. B6: source state command facade and real EditorSession document is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: stores marks on the item through item.setMarks (undoable)

Manually mirrors internal source state and duplicates mark persistence in retained focused-command case plus model item marks owner.

### REWRITE: Insert / Overwrite place the marked range at the sequence playhead (AC-SRC-1 logic)

Retain source marked-range handoff at sequence playhead; remove assertion-only second insert with no resulting-state check.

B1: S03 SRC-001/003/004. B2: Retain source marked-range handoff at sequence playhead; remove assertion-only second insert with no resulting-state check. B3: fixed input/output example from that contract. B4: source state command facade and real EditorSession document. B5: no private call/tree/order requirement remains after cleanup. B6: source state command facade and real EditorSession document is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: with the Source monitor focused, I/O and Shift+I act on the source item, not the sequence

Focused Source mark/go-to commands must change source marks/transport, never sequence marks.

B1: S03 SRC-001/003/004. B2: Focused Source mark/go-to commands must change source marks/transport, never sequence marks. B3: fixed input/output example from that contract. B4: source state command facade and real EditorSession document. B5: no private call/tree/order requirement remains after cleanup. B6: source state command facade and real EditorSession document is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: refuses when nothing is open

Bare false can pass for wrong refusal reason; successful handoff and command gating cover the owner.

## apps/web/test/clipboard.test.tsx

### KEEP: copies the selection and pastes it at the playhead on the targeted track, selecting the copies

Focus/target/playhead routing and selection restoration belong to web command orchestration; model clipboard does not choose UI context.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Focus/target/playhead routing and selection restoration belong to web command orchestration; model clipboard does not choose UI context. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: Paste Insert ripples, Cut leaves a gap, and read-only sessions only copy

Retain cut/insert outcome and read-only gating; remove exact reason prose.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Retain cut/insert outcome and read-only gating; remove exact reason prose. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: Duplicate selects the copies, and Redo restores that selection (defect fix, SEL-008)

Duplicate must record selection so redo restores copies (credible SEL-008 regression).

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Duplicate must record selection so redo restores copies (credible SEL-008 regression). B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: pastes into another project from the system clipboard data, resolving media (CLB-008)

Cross-project roundtrip duplicates model media-resolution tests and stronger real-system clipboard E2E owner.

### KEEP: prefers JasperEditor content on the system clipboard, rejects newer versions, detects foreign content

System/memory priority and unsupported-version rejection are transport contracts distinct from payload parser.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: System/memory priority and unsupported-version rejection are transport contracts distinct from payload parser. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: copies selected keyframes and pastes them at the playhead onto the primary clip

Effect Controls focus must paste selected keyframes onto primary clip at playhead.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Effect Controls focus must paste selected keyframes onto primary clip at playhead. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: copies an effect selected in Effect Controls and pastes it onto every selected clip (EC-032)

Focused effect selection must paste only that effect onto all target clips.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Focused effect selection must paste only that effect onto all target clips. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: copies project items and pastes them into the selected bin, selecting the copies

Retain selected-bin and selection routing plus rejected clip paste state; remove literal toast prose.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Retain selected-bin and selection routing plus rejected clip paste state; remove literal toast prose. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: lists the copied attributes, disables what no target takes, and pastes the checked ones

Retain checked-attribute outcome in rendered dialog; drop helper arrays/conversion and copy inventory assertions.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Retain checked-attribute outcome in rendered dialog; drop helper arrays/conversion and copy inventory assertions. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: Remove Attributes resets the checked attributes in one step

Remove Attributes dialog must reset selected property via real command; model reset alone misses UI wiring.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Remove Attributes dialog must reset selected property via real command; model reset alone misses UI wiring. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: runs the paste command with the data of the paste event that follows the chord

Direct awaitNativePaste private callback test duplicates stable dispatcher/browser clipboard workflow.

### KEEP: Ctrl+V on the timeline is left to the browser (no preventDefault); in a text field it is never taken

Native paste chord must preserve browser default and keep text-field editing; real dispatcher boundary.

B1: S01 CLB-002/003/004/005/006/007/008/009, SEL-008, S03 EC-032. B2: Native paste chord must preserve browser default and keep text-field editing; real dispatcher boundary. B3: fixed input/output example from that contract. B4: runCommand, real sessions, clipboard transport and rendered attribute dialogs. B5: no private call/tree/order requirement remains after cleanup. B6: runCommand, real sessions, clipboard transport and rendered attribute dialogs is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

## apps/web/test/clipboard-external.test.tsx

### KEEP: splits image data, named files, desktop paths and text

Distinguishes generic image data, named files and desktop paths before import; real browser APIs cannot cover all platform variants deterministically.

B1: S01 CLB-002/010 and LIFE-010. B2: Distinguishes generic image data, named files and desktop paths before import; real browser APIs cannot cover all platform variants deterministically. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: foreign files win over our in-memory copy; JasperEditor HTML is still a payload

Foreign files must beat stale in-memory copy, while explicit Jasper payload retains priority.

B1: S01 CLB-002/010 and LIFE-010. B2: Foreign files must beat stale in-memory copy, while explicit Jasper payload retains priority. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: reads the files of a paste event while it is dispatched (files, else file items)

DataTransfer.items fallback must recover real file data before event dispatch ends.

B1: S01 CLB-002/010 and LIFE-010. B2: DataTransfer.items fallback must recover real file data before event dispatch ends. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: Edit ▸ Paste reads image data through the async Clipboard API and file paths through the desktop

Async Clipboard image and desktop path adapters preserve both content channels.

B1: S01 CLB-002/010 and LIFE-010. B2: Async Clipboard image and desktop path adapters preserve both content channels. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: Timeline focus: a 5 s centred text clip at the playhead on the lowest targeted video track, one undo step

Retain newline/trimming/5000-character limit, target/duration and undo contract; remove geometry assertion (no visual-regression requirement here).

B1: S01 CLB-002/010 and LIFE-010. B2: Retain newline/trimming/5000-character limit, target/duration and undo contract; remove geometry assertion (no visual-regression requirement here). B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: Program focus pastes text too; the Project panel and Paste Insert explain instead of changing anything

Retain Program support, rejection in Project/Paste Insert and unchanged history; drop exact toast wording.

B1: S01 CLB-002/010 and LIFE-010. B2: Retain Program support, rejection in Project/Paste Insert and unchanged history; drop exact toast wording. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: image data becomes "Pasted image <time>", uploaded and placed at the playhead in one step

Retain timestamp filename protocol, import/place target and atomic undo; drop success-toast prose.

B1: S01 CLB-002/010 and LIFE-010. B2: Retain timestamp filename protocol, import/place target and atomic undo; drop success-toast prose. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: files keep their names; with the Project panel focused they are imported, not placed

Retain original filename and Project-vs-Timeline placement; drop success-toast prose.

B1: S01 CLB-002/010 and LIFE-010. B2: Retain original filename and Project-vs-Timeline placement; drop success-toast prose. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: reports a failed import instead of throwing

Retain error severity and original engine error detail; drop UI copy.

B1: S01 CLB-002/010 and LIFE-010. B2: Retain error severity and original engine error detail; drop UI copy. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: a paste event inside an input never runs Edit ▸ Paste; outside it does, with the files

Native paste events must remain native inside inputs and dispatch file data outside.

B1: S01 CLB-002/010 and LIFE-010. B2: Native paste events must remain native inside inputs and dispatch file data outside. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: writes all formats in one Electron write without a racing web write; falls back to the web when it fails

Atomic desktop format write prevents credible clipboard race; failed desktop write must fall back to browser.

B1: S01 CLB-002/010 and LIFE-010. B2: Atomic desktop format write prevents credible clipboard race; failed desktop write must fall back to browser. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: answers a native copy event at once and writes the Electron clipboard after it

Retain synchronous event payload then deferred desktop write; flush timers instead of deriving expectation from production delay constant.

B1: S01 CLB-002/010 and LIFE-010. B2: Retain synchronous event payload then deferred desktop write; flush timers instead of deriving expectation from production delay constant. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: completes a paste event without files with the file manager list, never JasperEditor content

Desktop file-manager fallback must not overwrite explicit Jasper payload or existing event files.

B1: S01 CLB-002/010 and LIFE-010. B2: Desktop file-manager fallback must not overwrite explicit Jasper payload or existing event files. B3: fixed input/output example from that contract. B4: clipboard platform adapter, native events and paste commands. B5: no private call/tree/order requirement remains after cleanup. B6: clipboard platform adapter, native events and paste commands is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

## apps/web/test/processing.test.tsx

### REWRITE: builds the ProcessRequest from the checked steps and queues the job with the projectId

Retain checked-step POST request and no-empty-step guard; remove display-copy and watcher-list internals.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain checked-step POST request and no-empty-step guard; remove display-copy and watcher-list internals. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: offers Smooth path with its own options and explains when to use each method

Retain Smooth path keep-borders POST parameters; remove help/default-label assertions.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain Smooth path keep-borders POST parameters; remove help/default-label assertions. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: Smooth path keeps the frame cropped by default and sends its zoom cap and locks (S07:PST-005)

Smooth path crop default/maxZoom/locks must reach engine ProcessRequest; differs from keep-borders case.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Smooth path crop default/maxZoom/locks must reach engine ProcessRequest; differs from keep-borders case. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: shows the model licence line for upscale and the remote option disabled without settings

Retain model license/attribution required by PRU-001; remove remote-status prose and unrelated missing-checkbox assertion.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain model license/attribution required by PRU-001; remove remote-status prose and unrelated missing-checkbox assertion. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: commits media.derive with replaceInClips as ONE "Process Clip" entry; one undo restores the original

Retain completed-job media derivation, linked audio safety and one-step undo; use literal specified History label and remove watcher-list/helper inventory.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain completed-job media derivation, linked audio safety and one-step undo; use literal specified History label and remove watcher-list/helper inventory. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: without replace it only adds the processed version (Processed bin)

No-replace derive is duplicated by model media.derive owner and setup of retained media-version switching test.

### KEEP: a failed remote job shows the error with Retry and Run on This Computer (no silent fallback)

Failed remote job must surface error and explicit local retry; never silently process locally or commit changes.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Failed remote job must surface error and explicit local retry; never silently process locally or commit changes. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: is registered for video clips and lists Original + processed versions; switching is one undo entry

Retain user version selection with document change and undo; remove display-copy and label/count redundancy.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain user version selection with document change and undo; remove display-copy and label/count redundancy. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: the dialog shell lists registered pages and opens the requested one

Registered page inventory/smoke navigation is redundant with substantive Preferences page contract.

### REWRITE: saves the remote settings, shows engine validation errors and renders a probe result

Retain remote settings POST and error/probe state; remove incidental copy/no-password negative/probe-call count/model badge.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain remote settings POST and error/probe state; remove incidental copy/no-password negative/probe-call count/model badge. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: Process Clip… defaults to the clip range + 12 handles and POSTs it; Whole media does not

Retain range handles in POST and whole-media omission; remove watcher private range echo.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain range handles in POST and whole-media omission; remove watcher private range echo. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: a finished ranged job swaps the clip onto the same source frames; a clip it does not cover stays

Retain ranged-job mapping and uncovered clip safety; remove helper label echoes and implementation constant.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain ranged-job mapping and uncovered clip safety; remove helper label echoes and implementation constant. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: the Media Version section shows the range and the handles; an uncovering version asks to trim

Retain version frame/handle data plus decline/accept trim outcome; remove precise confirmation prose.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain version frame/handle data plus decline/accept trim outcome; remove precise confirmation prose. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: Replace Footage: plan + command keep source timing from a sidecar and list clips the file does not hold

Private plan+command composition duplicates retained Replace Footage UI integration and model source-timing owner.

### REWRITE: Replace Footage dialog: desktop pick → sidecar and timing shown → Replace is one undo entry

Retain desktop registration request, trim-confirmed replacement and one-step History; use independently specified label and remove prose assertions.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Retain desktop registration request, trim-confirmed replacement and one-step History; use independently specified label and remove prose assertions. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: Replace Footage discards an uncommitted file (another pick, closing the dialog), never a committed one

Uncommitted registered files must be deleted on replace/cancel, committed files retained; credible storage leak/data-loss regression.

B1: S07 PRU-001…005, PRC-007/015/017, PRM-007 and PST-005. B2: Uncommitted registered files must be deleted on replace/cancel, committed files retained; credible storage leak/data-loss regression. B3: fixed input/output example from that contract. B4: rendered processing/preferences dialogs, job-to-document handoff and replacement actions. B5: no private call/tree/order requirement remains after cleanup. B6: rendered processing/preferences dialogs, job-to-document handoff and replacement actions is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

## apps/web/test/preview-thumb.test.tsx

### KEEP: shows the poster frame, then the shared hover Player after 200 ms

Poster-to-hover delayed playback and exclusive active preview are independent requirements; real frame output changes, no Player mock.

B1: ARCHITECTURE 20.6 and S05 MGT-001. B2: Poster-to-hover delayed playback and exclusive active preview are independent requirements; real frame output changes, no Player mock. B3: fixed input/output example from that contract. B4: PreviewThumb pointer events and actual Remotion frame output. B5: no private call/tree/order requirement remains after cleanup. B6: PreviewThumb pointer events and actual Remotion frame output is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: leaving before the delay never starts the Player

Leaving before delay must cancel autoplay; prevents background unexpected playback.

B1: ARCHITECTURE 20.6 and S05 MGT-001. B2: Leaving before delay must cancel autoplay; prevents background unexpected playback. B3: fixed input/output example from that contract. B4: PreviewThumb pointer events and actual Remotion frame output. B5: no private call/tree/order requirement remains after cleanup. B6: PreviewThumb pointer events and actual Remotion frame output is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### KEEP: touch and reduced motion keep the poster

Touch and reduced-motion accessibility inputs must suppress animation while preserving poster.

B1: ARCHITECTURE 20.6 and S05 MGT-001. B2: Touch and reduced-motion accessibility inputs must suppress animation while preserving poster. B3: fixed input/output example from that contract. B4: PreviewThumb pointer events and actual Remotion frame output. B5: no private call/tree/order requirement remains after cleanup. B6: PreviewThumb pointer events and actual Remotion frame output is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

## apps/web/test/composition-texts.test.tsx

### DELETE: lists the texts with counters and their style props; the generic form keeps the rest

Markup/control inventory and stubbed measure-call shape; real mg-texts E2E owns bundle font/measurement behavior.

### REWRITE: previews while typing (no History entry), applies one "Edit Text" step; Esc reverts

Retain transient preview, single commit, and Escape restore at UI seam; remove exact History prose and incidental warnings.

B1: S08 MGU-006. B2: Retain transient preview, single commit, and Escape restore at UI seam; remove exact History prose and incidental warnings. B3: fixed input/output example from that contract. B4: rendered Composition text editor and real session document/history. B5: no private call/tree/order requirement remains after cleanup. B6: rendered Composition text editor and real session document/history is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### REWRITE: refuses values the schema rejects and warns about soft limits while typing

Retain schema rejection/document preservation and soft-limit warning code; remove exact user-copy regex.

B1: S08 MGU-006. B2: Retain schema rejection/document preservation and soft-limit warning code; remove exact user-copy regex. B3: fixed input/output example from that contract. B4: rendered Composition text editor and real session document/history. B5: no private call/tree/order requirement remains after cleanup. B6: rendered Composition text editor and real session document/history is the lowest owner of the UI/platform handoff; remaining model tests cannot detect this routing failure, and E2E is restricted to the actual browser/rendering boundary.

### DELETE: style rows write their props; Edit on canvas opens the Program monitor editor for that text

Style command forwarding and canvas-edit store shape duplicate property model and real canvas-editor E2E.

## Implementation and ownership notes

The two additional keymap platform cases merely preserve all six existing configurations when removing shell's duplicate check; these are configuration contracts, not new implementation tests.

Removed production-only-for-tests support: `memoryStorage` moved to `test/shell-storage.ts`; `resetWorkspaceStore` removed and shell render tests provide a real WorkspaceStore at the module boundary; `ProcessWatcher.list/configure/reset` and configurable clock/poller/notifier removed (production stays at its existing 1000 ms polling, Date clock and real toast delivery). Processing tests clear jobs through the normal HTTP polling path and expire retry memory using the clock. Internalized exports `awaitNativePaste`, `HOVER_PREVIEW_DELAY_MS`, `DESKTOP_WRITE_AFTER_EVENT_MS`, `PROCESS_TX_LABEL`, `REPLACE_FOOTAGE_TX_LABEL` and notification shape. Removed stale TL_903 declaration fixture and mocked composition measurement geometry fixture.

Shared command registry reset cleanup is coordinated with transport/anime/motion owners. This shard's shell tests now unregister with production registration disposers; registry test uses its existing disposer.

E2E owner confirmed browser clipboard routing and cross-project workflows remain there; lower web tests own checked attribute selection, focused command routing and deterministic platform variants. Real bundle measurement/font/canvas behavior remains in `e2e/mg-texts.spec.ts`. Source marks model persistence stays in project item tests; source focus test retains the separate source-vs-sequence routing contract. Processing no-replace and replacement planning duplicates defer to model derive/replace-source contracts and retained UI cases.

Baseline on merged remote: 82 passed, one shell-render header timeout at 5 seconds during heavily contended parallel compilation. No baseline assertion failure. Focused serial rerun follows cleanup to establish whether a product defect exists.

The edit-only menu rewrite also registers a usable Sequence Settings command and verifies it is enabled before the mode override. This closes the original wrong-reason pass, where every Sequence command was already unregistered and disabled.

Removed the remaining shortcutFor binding inventory from shell format test: formatting keeps independently required Ctrl and Mac glyph notation, while web/PWA fallback behavior stays solely in keymap.test.ts. Removed `resetCommandRegistry` after all production/test references migrated to registration disposers. Job completion/failure tests now submit via `startProcessing` rather than directly populating the watcher.

Removed test-only `inspectorFocus.reset` after history-effects owner dropped its unused fixture reset; clipboard fixture uses the existing production `set` contract.

Final support inspection found WorkspaceStore's optional timer-injection constructor argument had zero callers (production and tests). Removed that option/type/wrapper and kept the existing global timers and 300 ms debounce.

## Validation handoff

Completed cleanup and final diff inspection. Scoped Biome checks passed after unused imports were removed. The first post-edit focused run encountered host-contention 5-second UI timeouts; its remote-failure assertion was corrected to account for the initial remote POST when exercising the public startProcessing entrypoint. A 60-second CLI retry was stopped at the root agent's request to release capacity for the repository-wide single-worker gate. The root agent owns final typecheck/test results in `/tmp/jasper-round2-test.log`; no passing final test claim is made by this shard.

Final inventory: 15 DELETE declarations, 65 retained declarations (70 cases including all six platform/runtime collision variants), versus 83 baseline cases.

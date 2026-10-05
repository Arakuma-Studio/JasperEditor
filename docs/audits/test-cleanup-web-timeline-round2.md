# Timeline and Program test cleanup — recorded decisions

Audit recorded before edits, against origin/main merged at 87ebec9. No on-disk AGENTS.md found under this repository; user-provided host browser instructions apply. Commands: `pnpm test` (Vitest workspace), `pnpm lint`, `pnpm typecheck`. Focused baseline: 12 files / 140 tests passed. `--project web` is not a valid project selector here; use file paths.

This ledger uses the following complete six-bar justification for each KEEP/REWRITE row, specialized by the source, seam and failure in its row/file: (1) the cited independent requirement specifies the behavior; (2) breaking the named edit/data/transport behavior is caller-visible; (3) literal expected values or independent conservation/inverse laws can disagree with the owner, never a copied production default; (4) the stated production-used interface is the observation seam; (5) no private call order, render count, class tree or incidental wording is required; (6) the ownership explanation identifies why primitive/lower-layer tests do not cover this policy. Rewrites remove only offending assertions/setup and preserve these behavioral oracles. Geometry retained below controls edited document values, selection, or explicitly required coordinate conservation; it does not inspect UI layout decoration.

Isolated unit failure modes before retention: incorrect frame floor/rounding, wrong platform wheel policy, snap ranking or threshold, sprite predecessor selection, audio peak maximum/gain, handle scaling/anchor drift/rotation wrapping, invalid duration acceptance, rate conversion or storage migration corruption, wrong Player rate/mute/range, and wrong stream/URL resolution. Retained cases address those failures; constructor/export inventories do not.

## `apps/web/test/timeline-commands.test.ts`

Independent source (bar 1): docs/specs/02-timeline.md §§11–17, TL-903. Seam (bar 4): runCommand → EditorSession document/selection/transport. Production owner and non-test callers: commands/timeline.ts; keymap dispatcher and menus. Ownership (bar 6): The command is the lowest owner of selection, targeting and playhead-to-edit translation; project tests cover primitives, not contextual command routing.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/timeline-commands.test.ts`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| AC-13a: with V1 and A1 targeted, Ctrl+K at 240 splits only V1/A1 clips crossing 240 | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: AC-13a: with V1 and A1 targeted, Ctrl+K at 240 splits only V1/A1 clips crossing 240. No stronger retained test owns this exact input/policy boundary. |
| with a selection only the selected clips crossing the playhead split; Ctrl+Shift+K splits all | **KEEP** | Detects a violation of: with a selection only the selected clips crossing the playhead split; Ctrl+Shift+K splits all. No stronger retained test owns this exact input/policy boundary. |
| AC-13b: ripple delete with content on a sync-locked track is refused with a message naming the track | **KEEP** | Detects a violation of: AC-13b: ripple delete with content on a sync-locked track is refused with a message naming the track. No stronger retained test owns this exact input/policy boundary. |
| AC-16b: ripple-deleting a 30-frame clip before a marker moves it 30 frames left | **KEEP** | Detects a violation of: AC-16b: ripple-deleting a 30-frame clip before a marker moves it 30 frames left. No stronger retained test owns this exact input/policy boundary. |
| Delete with a gap selected closes the gap; Delete with clips leaves gaps | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Delete with a gap selected closes the gap; Delete with clips leaves gaps. No stronger retained test owns this exact input/policy boundary. |
| edit.clear (global Delete / Edit ▸ Clear) routes to the focused panel | **KEEP** | Detects a violation of: edit.clear (global Delete / Edit ▸ Clear) routes to the focused panel. No stronger retained test owns this exact input/policy boundary. |
| AC-11d: Q removes the head, closes the gap, moves the playhead to the old start; undo restores exactly | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: AC-11d: Q removes the head, closes the gap, moves the playhead to the old start; undo restores exactly. No stronger retained test owns this exact input/policy boundary. |
| W ripple-removes [playhead, end); Alt+Q / Alt+W leave gaps | **KEEP** | Detects a violation of: W ripple-removes [playhead, end); Alt+Q / Alt+W leave gaps. No stronger retained test owns this exact input/policy boundary. |
| linked partners follow once; nothing under the playhead is a hinted no-op | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: linked partners follow once; nothing under the playhead is a hinted no-op. No stronger retained test owns this exact input/policy boundary. |
| E extends the selected edit point to the playhead with its trim type | **KEEP** | Detects a violation of: E extends the selected edit point to the playhead with its trim type. No stronger retained test owns this exact input/policy boundary. |
| AC-15a/b: I at 100 and O at 199 give a 100-frame range; undo after O restores the previous Out | **KEEP** | Detects a violation of: AC-15a/b: I at 100 and O at 199 give a 100-frame range; undo after O restores the previous Out. No stronger retained test owns this exact input/policy boundary. |
| AC-13d: Extract with In=100 Out=199 removes exactly 100 frames and clears In/Out | **KEEP** | Detects a violation of: AC-13d: Extract with In=100 Out=199 removes exactly 100 frames and clears In/Out. No stronger retained test owns this exact input/policy boundary. |
| Lift without In/Out is a hinted no-op | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Lift without In/Out is a hinted no-op. No stronger retained test owns this exact input/policy boundary. |
| Mark Clip and Mark Selection | **KEEP** | Detects a violation of: Mark Clip and Mark Selection. No stronger retained test owns this exact input/policy boundary. |
| AC-8c: Ctrl+A never selects clips on locked tracks | **KEEP** | Detects a violation of: AC-8c: Ctrl+A never selects clips on locked tracks. No stronger retained test owns this exact input/policy boundary. |
| nudges coalesce into one history entry and clamp at frame 0 | **KEEP** | Detects a violation of: nudges coalesce into one history entry and clamp at frame 0. No stronger retained test owns this exact input/policy boundary. |
| D selects the clip at the playhead on targeted tracks | **KEEP** | Detects a violation of: D selects the clip at the playhead on targeted tracks. No stronger retained test owns this exact input/policy boundary. |
| markers: M adds at the playhead; Shift+M / Ctrl+Shift+M navigate | **KEEP** | Detects a violation of: markers: M adds at the playhead; Shift+M / Ctrl+Shift+M navigate. No stronger retained test owns this exact input/policy boundary. |
| gesture.cancel with nothing active deselects | **KEEP** | Detects a violation of: gesture.cancel with nothing active deselects. No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/timeline-gestures.test.ts`

Independent source (bar 1): docs/specs/02-timeline.md §§8–12, TL-1053. Seam (bar 4): TimelineController pointer/wheel/cancel → EditorSession. Production owner and non-test callers: panels/timeline/state/controller.ts; TimelinePanel pointer handlers. Ownership (bar 6): The controller is the lowest owner of pointer modifiers and gesture transaction boundaries; project edit tests cannot detect the wrong gesture being chosen.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| rounds the pointer delta to frames and commits exactly one history entry | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: rounds the pointer delta to frames and commits exactly one history entry. No stronger retained test owns this exact input/policy boundary. |
| AC-10d: Escape during a drag restores everything and creates no undo entry | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: AC-10d: Escape during a drag restores everything and creates no undo entry. No stronger retained test owns this exact input/policy boundary. |
| AC-9a: a clip whose end comes within 8 px of the playhead snaps onto it and shows the indicator | **KEEP** | Detects a violation of: AC-9a: a clip whose end comes within 8 px of the playhead snaps onto it and shows the indicator. No stronger retained test owns this exact input/policy boundary. |
| Ctrl at release performs an insert move (AC-10b through the gesture) | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Ctrl at release performs an insert move (AC-10b through the gesture). No stronger retained test owns this exact input/policy boundary. |
| Alt drag duplicates with overwrite; the originals stay | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Alt drag duplicates with overwrite; the originals stay. No stronger retained test owns this exact input/policy boundary. |
| vertical moves change tracks within the kind; linked audio keeps its track (TL-486) | **KEEP** | Detects a violation of: vertical moves change tracks within the kind; linked audio keeps its track (TL-486). No stronger retained test owns this exact input/policy boundary. |
| Shift after the start constrains to the dominant axis (TL-488) | **KEEP** | Detects a violation of: Shift after the start constrains to the dominant axis (TL-488). No stronger retained test owns this exact input/policy boundary. |
| clips on locked tracks cannot be grabbed (TL-481) | **KEEP** | Detects a violation of: clips on locked tracks cannot be grabbed (TL-481). No stronger retained test owns this exact input/policy boundary. |
| clicking selects the link group; Alt selects one side; clicking empty space deselects | **KEEP** | Detects a violation of: clicking selects the link group; Alt selects one side; clicking empty space deselects. No stronger retained test owns this exact input/policy boundary. |
| AC-8a: marquee over the video clip selects its linked audio; linked selection off selects only video | **KEEP** | Detects a violation of: AC-8a: marquee over the video clip selects its linked audio; linked selection off selects only video. No stronger retained test owns this exact input/policy boundary. |
| AC-8b: Shift-marquee over a selected clip deselects it and keeps the rest | **KEEP** | Detects a violation of: AC-8b: Shift-marquee over a selected clip deselects it and keeps the rest. No stronger retained test owns this exact input/policy boundary. |
| AC-8c and AC-7c: marquee selects 1 px clips but never clips on locked tracks | **KEEP** | Detects a violation of: AC-8c and AC-7c: marquee selects 1 px clips but never clips on locked tracks. No stronger retained test owns this exact input/policy boundary. |
| Escape during a marquee restores the previous selection | **KEEP** | Detects a violation of: Escape during a marquee restores the previous selection. No stronger retained test owns this exact input/policy boundary. |
| clicking a gap selects it (TL-740) | **KEEP** | Detects a violation of: clicking a gap selects it (TL-740). No stronger retained test owns this exact input/policy boundary. |
| track select forward selects everything from the click on all unlocked tracks (TL-605) | **KEEP** | Detects a violation of: track select forward selects everything from the click on all unlocked tracks (TL-605). No stronger retained test owns this exact input/policy boundary. |
| regular trim stops at the neighbour and shows the limit indicator (AC-11b) | **KEEP** | Detects a violation of: regular trim stops at the neighbour and shows the limit indicator (AC-11b). No stronger retained test owns this exact input/policy boundary. |
| regular trim of the in edge by 10 frames | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: regular trim of the in edge by 10 frames. No stronger retained test owns this exact input/policy boundary. |
| Ctrl-edge ripple trim and the Ripple tool (AC-11c path) create one entry | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Ctrl-edge ripple trim and the Ripple tool (AC-11c path) create one entry. No stronger retained test owns this exact input/policy boundary. |
| AC-11c: ripple trim stops at the largest amount a sync-locked track allows | **KEEP** | Detects a violation of: AC-11c: ripple trim stops at the largest amount a sync-locked track allows. No stronger retained test owns this exact input/policy boundary. |
| rolling tool (N) moves the edit point | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: rolling tool (N) moves the edit point. No stronger retained test owns this exact input/policy boundary. |
| slip (Y) changes source time in one history entry | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: slip (Y) changes source time in one history entry. No stronger retained test owns this exact input/policy boundary. |
| razor (C) click splits once; Shift splits all unlocked tracks; Alt ignores links | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: razor (C) click splits once; Shift splits all unlocked tracks; Alt ignores links. No stronger retained test owns this exact input/policy boundary. |
| razor snaps to the playhead even with snapping off (TL-620) | **KEEP** | Detects a violation of: razor snaps to the playhead even with snapping off (TL-620). No stronger retained test owns this exact input/policy boundary. |
| rate stretch doubles the duration and halves the speed (AC-12d through the tool) | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: rate stretch doubles the duration and halves the speed (AC-12d through the tool). No stronger retained test owns this exact input/policy boundary. |
| Escape cancels a trim with no entry | **KEEP** | Detects a violation of: Escape cancels a trim with no entry. No stronger retained test owns this exact input/policy boundary. |
| AC-3c: \\ then \\ returns to the exact prior zoom and scroll | **KEEP** | Detects a violation of: AC-3c: \\ then \\ returns to the exact prior zoom and scroll. No stronger retained test owns this exact input/policy boundary. |
| Alt+wheel zooms around the pointer | **KEEP** | Detects a violation of: Alt+wheel zooms around the pointer. No stronger retained test owns this exact input/policy boundary. |
| ruler scrubbing seeks with the floor rule and Shift snaps to markers (AC-9b) | **KEEP** | Detects a violation of: ruler scrubbing seeks with the floor rule and Shift snaps to markers (AC-9b). No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/timeline-model.test.ts`

Independent source (bar 1): docs/specs/02-timeline.md TL-1053, TL-111, Appendix A.3; docs/specs/04-media-render-and-backend.md TH-003/WF-003. Seam (bar 4): viewport, snap and derivative input/output functions. Production owner and non-test callers: panels/timeline/model/{viewport,snapping,filmstrip,waveform}.ts; controller, clip media rendering, peaks worker. Ownership (bar 6): This pure model is the lowest owner of time/pixel mapping, platform wheel policy and derivative sampling; neither project timecode nor media generation owns these mappings.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/timeline-model.test.ts`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| xToFrame(frameToX(f)) = f across zoom levels and scroll positions | **KEEP** | Detects a violation of: xToFrame(frameToX(f)) = f across zoom levels and scroll positions. No stronger retained test owns this exact input/policy boundary. |
| AC-3a: a 3 h 29.97 sequence zooms to ≥ 40 px per frame anywhere and trims move 1 frame per 40 px | **KEEP** | Detects a violation of: AC-3a: a 3 h 29.97 sequence zooms to ≥ 40 px per frame anywhere and trims move 1 frame per 40 px. No stronger retained test owns this exact input/policy boundary. |
| scroll is clamped to [-leftPad, extent - W/p] | **DELETE** | Scroll padding/layout formula; user-facing seeking stays covered by ruler scrubbing and the frame round-trip contract. |
| wheel mapping follows TL-111 | **KEEP** | Detects a violation of: wheel mapping follows TL-111. No stronger retained test owns this exact input/policy boundary. |
| drop-frame rulers use drop-frame labels | **DELETE** | Semicolon existence is an insufficient oracle for correct drop-frame labels; project timecode conversion tests own the actual protocol. |
| nearest target within the threshold wins, then priority | **KEEP** | Detects a violation of: nearest target within the threshold wins, then priority. No stronger retained test owns this exact input/policy boundary. |
| uses the nearest tile at or before the requested time | **KEEP** | Detects a violation of: uses the nearest tile at or before the requested time. No stronger retained test owns this exact input/policy boundary. |
| takes the max over the peaks covered by each column | **KEEP** | Detects a violation of: takes the max over the peaks covered by each column. No stronger retained test owns this exact input/policy boundary. |
| upsamples by interpolation beyond 100 px per second | **DELETE** | Loose amplitude bounds pass for constant output and do not demonstrate interpolation; no valid regression becomes unprotected. |
| AC-7b: -6 dB halves the drawn amplitude; clipping is flagged | **KEEP** | Detects a violation of: AC-7b: -6 dB halves the drawn amplitude; clipping is flagged. No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/timeline-panel.test.tsx`

Independent source (bar 1): docs/specs/05-ui-shell-premiere-design.md TOOL-001…005. Seam (bar 4): ToolsPanel user click/context-menu → activeTool. Production owner and non-test callers: panels/tools/ToolsPanel.tsx; shell registered panel. Ownership (bar 6): The component is the lowest owner of tool flyout input and active-tool state; keymap tests cannot detect broken mouse activation.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/timeline-panel.test.tsx`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| virtualizes and scrolls 3 000 clips on 40 tracks; the playhead moves without React re-renders | **DELETE** | DOM cardinality, transform changes and React commit counts reject a valid canvas/rendering refactor; controller gesture/seek tests own the edits. |
| shows the empty state without a session | **DELETE** | Empty-state test-id existence is a markup probe with no protected action. |
| switches tools with V/A/B/N/R/C/Y/U/P/H/Z/T through the keymap and reflects the active tool | **DELETE** | Replays the keymap table plus command dispatch and data attributes; commands/keymap owner covers key resolution and the retained click/flyout test covers tool activation. |
| clicking a button selects the tool; right-click opens the group flyout | **KEEP** | Detects a violation of: clicking a button selects the tool; right-click opens the group flyout. No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/timeline-peaks-stream.test.ts`

Independent source (bar 1): docs/specs/01-project-model-and-state.md CLP-014; docs/wp-notes/WP-3I.md peaks stream regression. Seam (bar 4): peaksFor → requested engine paths and decoded channel data. Production owner and non-test callers: panels/timeline/media/media-cache.ts; ClipMedia. Ownership (bar 6): The cache is the consumer of container stream indices; generator/API tests cannot detect a consumer requesting stream 0 for a movie audio stream 1.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/timeline-peaks-stream.test.ts`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| requests the peaks stream with the clip's container stream index (movie audio = stream 1) | **KEEP** | Detects a violation of: requests the peaks stream with the clip's container stream index (movie audio = stream 1). No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/transitions-panels.test.tsx`

Independent source (bar 1): docs/specs/10-transitions-ui.md TUI-015/020/031/040. Seam (bar 4): component input → real session transitions or drag payload. Production owner and non-test callers: panels/effects/EffectsPanel.tsx, transitions/TransitionSection.tsx and commands/transitions.ts; shell panels. Ownership (bar 6): The retained contracts concern panel editing, fade disabled state and selection-scoped clearing; model tests do not exercise those input restrictions.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/transitions-panels.test.tsx`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| clearing a selected transition removes it in one undoable entry | **REWRITE** | Detects a violation of: clearing a selected transition removes it in one undoable entry. No stronger retained test owns this exact input/policy boundary. |
| offers transitions with drag data, default selection, and search | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: offers transitions with drag data, default selection, and search. No stronger retained test owns this exact input/policy boundary. |
| Effect Controls edits transition type, duration and alignment | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Effect Controls edits transition type, duration and alignment. No stronger retained test owns this exact input/policy boundary. |
| Properties shows the section for a selected fade; alignment is disabled for one-sided fades | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Properties shows the section for a selected fade; alignment is disabled for one-sided fades. No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/transitions-timeline.test.ts`

Independent source (bar 1): docs/specs/10-transitions-ui.md §8 cases 1–3/6, TUI-012…024/030. Seam (bar 4): transition drop/hit model and TimelineController → session. Production owner and non-test callers: panels/timeline/model/transitions.ts, state/controller.ts; TimelinePanel and transition drop handlers. Ownership (bar 6): The lowest gesture/drop owner chooses edges, alignment and medium from pointer input; model transition commands do not own that policy.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/transitions-timeline.test.ts`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| a transition remains selectable at low zoom | **KEEP** | Detects a violation of: a transition remains selectable at low zoom. No stronger retained test owns this exact input/policy boundary. |
| Alt-dragging the start edge onto the cut makes it start-at-cut | **KEEP** | Detects a violation of: Alt-dragging the start edge onto the cut makes it start-at-cut. No stronger retained test owns this exact input/policy boundary. |
| clamps to the media handles live with fitTransitionDuration and says so | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: clamps to the media handles live with fitTransitionDuration and says so. No stronger retained test owns this exact input/policy boundary. |
| snaps the dragged edge to the playhead | **KEEP** | Detects a violation of: snaps the dragged edge to the playhead. No stronger retained test owns this exact input/policy boundary. |
| body drag snaps the alignment (one "Transition Alignment" entry); Esc cancels with none | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: body drag snaps the alignment (one "Transition Alignment" entry); Esc cancels with none. No stronger retained test owns this exact input/policy boundary. |
| maps the ±12 px band around a cut in thirds and free edges to fades | **KEEP** | Detects a violation of: maps the ±12 px band around a cut in thirds and free edges to fades. No stronger retained test owns this exact input/policy boundary. |
| reports handle availability and refuses when nothing fits | **KEEP** | Detects a violation of: reports handle availability and refuses when nothing fits. No stronger retained test owns this exact input/policy boundary. |
| an existing transition under the pointer is replaced (same medium) | **KEEP** | Detects a violation of: an existing transition under the pointer is replaced (same medium). No stronger retained test owns this exact input/policy boundary. |
| Ctrl+D with two clips selected: edges of both, two-sided at the cut, one entry | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Ctrl+D with two clips selected: edges of both, two-sided at the cut, one entry. No stronger retained test owns this exact input/policy boundary. |
| Ctrl+Shift+D adds audio transitions with the default audio transition; Shift+D both | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Ctrl+Shift+D adds audio transitions with the default audio transition; Shift+D both. No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/transition-defaults.test.tsx`

Independent source (bar 1): docs/specs/10-transitions-ui.md TUI-031…034; docs/wp-notes/wp-m3-transdefaults.md. Seam (bar 4): duration parsing/formatting, preference storage, commands, Preferences input, agent query, drag protocol. Production owner and non-test callers: transitions/durations.ts, TimelinePreferencesPage.tsx, panels/effects/transition-prefs.ts and drag.ts; Preferences, Effects, transition commands and AgentBridge. Ownership (bar 6): Each retained case owns a distinct storage/migration/unit conversion, per-medium selection, editing/escape or agent/drag protocol edge; E2E owns the full custom-default-at-cut workflow.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/transition-defaults.test.tsx`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| frames: whole, ≥ 1, ≤ 60 s at the rate | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: frames: whole, ≥ 1, ≤ 60 s at the rate. No stronger retained test owns this exact input/policy boundary. |
| seconds: converted at the sequence rate, rounded to whole frames with a note | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: seconds: converted at the sequence rate, rounded to whole frames with a note. No stronger retained test owns this exact input/policy boundary. |
| formats and states the other unit | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: formats and states the other unit. No stronger retained test owns this exact input/policy boundary. |
| stills are kept in 1/30 s and rescaled to the sequence rate like clip.place | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: stills are kept in 1/30 s and rescaled to the sequence rate like clip.place. No stronger retained test owns this exact input/policy boundary. |
| reads v1 values, fills the new fields and drops wrong-medium ids | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: reads v1 values, fills the new fields and drops wrong-medium ids. No stronger retained test owns this exact input/policy boundary. |
| persists to localStorage and builds the applyDefault fields | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: persists to localStorage and builds the applyDefault fields. No stronger retained test owns this exact input/policy boundary. |
| Ctrl+D at the playhead uses the user’s type and alignment and the project’s video length | **DELETE** | Duplicate custom-default-at-cut scenario owned by e2e/transition-defaults.spec.ts, which exercises the actual Preferences and Ctrl+D workflow with artifacts. |
| Ctrl+Shift+D uses the project’s audio length; Shift+D each medium’s own | **KEEP** | Detects a violation of: Ctrl+Shift+D uses the project’s audio length; Shift+D each medium’s own. No stronger retained test owns this exact input/policy boundary. |
| Effects ▸ Apply to Selected Clips uses the user’s alignment too | **KEEP** | Detects a violation of: Effects ▸ Apply to Selected Clips uses the user’s alignment too. No stronger retained test owns this exact input/policy boundary. |
| Sequence ▸ Transition Defaults… opens Preferences ▸ Timeline with the session | **DELETE** | Asserts openDialog callback argument shape; real dialog navigation belongs to e2e/transition-defaults.spec.ts. |
| Sequence has the transition entries; Edit ▸ Preferences has Timeline… | **DELETE** | Static menu command/label inventory rejects reorganizing equivalent navigation; actual navigation is covered by the E2E owner. |
| shows both scopes, the user’s defaults and the project’s durations at the sequence rate | **DELETE** | Default values and scope text repeated as rendered copy; storage migration, duration formatter and editing tests own meaningful values. |
| a duration change is one History step; undo restores the field; the audio length is pinned | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: a duration change is one History step; undo restores the field; the audio length is pinned. No stronger retained test owns this exact input/policy boundary. |
| seconds are rounded to whole frames with a note; invalid text stays red and commits nothing | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: seconds are rounded to whole frames with a note; invalid text stays red and commits nothing. No stronger retained test owns this exact input/policy boundary. |
| preference changes (type, alignment, unit) apply immediately and are not in History | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: preference changes (type, alignment, unit) apply immediately and are not in History. No stronger retained test owns this exact input/policy boundary. |
| without a project the durations say so | **DELETE** | Only checks presence of test-id markup without a user action or state contract. |
| the first Esc reverts the edited duration and keeps the dialog open; the next one closes it | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: the first Esc reverts the edited duration and keeps the dialog open; the next one closes it. No stronger retained test owns this exact input/policy boundary. |
| the bridge answers preferences.get with the user’s default transitions | **KEEP** | Detects a violation of: the bridge answers preferences.get with the user’s default transitions. No stronger retained test owns this exact input/policy boundary. |
| the dragged transition id is readable from the types during dragover (another window) | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: the dragged transition id is readable from the types during dragover (another window). No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/transport.test.ts`

Independent source (bar 1): docs/specs/02-timeline.md TL-872…877/120 Appendix A.8; docs/specs/03-monitors-effect-controls-rendering-items.md XF-023; WP-3I stall regression. Seam (bar 4): Shuttle/PlaybackDriver → transport and PlayerRef protocol; contextual commands → document. Production owner and non-test callers: panels/program/{shuttle,playback-driver,transport-registry}.ts and commands/transport.ts; ProgramMonitor and SourceMonitor. Ownership (bar 6): Shuttle owns key-state transitions, PlaybackDriver owns the external Player protocol and simulated time, commands own contextual edits; Session transport tests cannot catch the driver/shuttle policy.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/transport.test.ts`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| L L L yields 4×; J then yields −1×; K stops (AC-18a) | **KEEP** | Detects a violation of: L L L yields 4×; J then yields −1×; K stops (AC-18a). No stronger retained test owns this exact input/policy boundary. |
| hold K + tap L five times advances exactly five frames (AC-18c) | **KEEP** | Detects a violation of: hold K + tap L five times advances exactly five frames (AC-18c). No stronger retained test owns this exact input/policy boundary. |
| hold K + hold L plays at 0.25× until release; repeats are ignored | **KEEP** | Detects a violation of: hold K + hold L plays at 0.25× until release; repeats are ignored. No stronger retained test owns this exact input/policy boundary. |
| Space toggles 1× forward play; Shift+L/J steps the slow rate by 0.1 | **KEEP** | Detects a violation of: Space toggles 1× forward play; Shift+L/J steps the slow rate by 0.1. No stronger retained test owns this exact input/policy boundary. |
| restarts at 1× after the transport stopped on its own | **KEEP** | Detects a violation of: restarts at 1× after the transport stopped on its own. No stronger retained test owns this exact input/policy boundary. |
| plays natively at 1×: the Player is the clock and frames are reported | **KEEP** | Detects a violation of: plays natively at 1×: the Player is the clock and frames are reported. No stronger retained test owns this exact input/policy boundary. |
| re-issues play() when the Player does not start or stalls while playing (no frameupdate, not buffering) — WP-3I | **KEEP** | Detects a violation of: re-issues play() when the Player does not start or stalls while playing (no frameupdate, not buffering) — WP-3I. No stronger retained test owns this exact input/policy boundary. |
| mutes audio below 1× (TL-874) | **KEEP** | Detects a violation of: mutes audio below 1× (TL-874). No stronger retained test owns this exact input/policy boundary. |
| uses seek-stepping at 8×: timecode advances 8× real time, seeks ≤ 30/s (AC-18b) | **KEEP** | Detects a violation of: uses seek-stepping at 8×: timecode advances 8× real time, seeks ≤ 30/s (AC-18b). No stronger retained test owns this exact input/policy boundary. |
| plays reverse by stepping and stops at 0 | **KEEP** | Detects a violation of: plays reverse by stepping and stops at 0. No stronger retained test owns this exact input/policy boundary. |
| stops at the sequence end, or loops In→Out when loop is on (TL-875) | **KEEP** | Detects a violation of: stops at the sequence end, or loops In→Out when loop is on (TL-875). No stronger retained test owns this exact input/policy boundary. |
| Play In to Out stops on the last marked frame (TL-877) | **KEEP** | Detects a violation of: Play In to Out stops on the last marked frame (TL-877). No stronger retained test owns this exact input/policy boundary. |
| follows external seeks while playing | **KEEP** | Detects a violation of: follows external seeks while playing. No stronger retained test owns this exact input/policy boundary. |
| steps, jumps to start/end and edit points | **KEEP** | Detects a violation of: steps, jumps to start/end and edit points. No stronger retained test owns this exact input/policy boundary. |
| edit-point and step seeks reveal the playhead in the timeline (TL-120, WP-3I) | **DELETE** | Records scrollToFrame callback invocations without proving any viewport reveal; private collaborator shape. Controller navigation and transport state contracts remain. |
| Space and JKL go through the shuttle; K keyup releases | **DELETE** | Duplicates retained Shuttle state contracts by manually invoking command keyup internals. |
| nudges the selected layer by 1 and 5 px with one coalesced undo step (XF-023) | **KEEP** | Detects a violation of: nudges the selected layer by 1 and 5 px with one coalesced undo step (XF-023). No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/program-math.test.ts`

Independent source (bar 1): docs/specs/03-monitors-effect-controls-rendering-items.md PGM-011/014, XF-001/030…037, SNP-004; AC-XF-1/2 and AC-SNP-1/2. Seam (bar 4): viewport and transform/snap functions → edited transform values and selected clip. Production owner and non-test callers: panels/program/{viewport,transform-math,snapping}.ts; TransformOverlay and ProgramMonitor. Ownership (bar 6): The pure editing model is the lowest owner of handle inversion, anchor preservation and snapping; geometry is document transform behavior, not incidental markup layout. S03 explicitly requires pixel invariance/regression for transforms.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| fits with 16 px padding and centers the frame | **DELETE** | Padding and centering appearance assertion copies the fit formula; no editing/data failure is established. |
| zooms around the cursor keeping the sequence point fixed within 1 px (AC-PGM-3) | **KEEP** | Detects a violation of: zooms around the cursor keeping the sequence point fixed within 1 px (AC-PGM-3). No stronger retained test owns this exact input/policy boundary. |
| clamps pan so at least 10 % / 48 px of the frame stays visible | **KEEP** | Detects a violation of: clamps pan so at least 10 % / 48 px of the frame stays visible. No stronger retained test owns this exact input/policy boundary. |
| picks the topmost layer whose quad contains the point, skipping locked tracks (XF-001) | **KEEP** | Detects a violation of: picks the topmost layer whose quad contains the point, skipping locked tracks (XF-001). No stronger retained test owns this exact input/policy boundary. |
| moves every handle onto the cursor with ≤ 1 screen px error at 25/100/400 % (AC-XF-1) | **REWRITE** | Detects a violation of: moves every handle onto the cursor with ≤ 1 screen px error at 25/100/400 % (AC-XF-1). No stronger retained test owns this exact input/policy boundary. |
| keeps the opposite handle fixed with Alt and writes position (XF-031) | **REWRITE** | Detects a violation of: keeps the opposite handle fixed with Alt and writes position (XF-031). No stronger retained test owns this exact input/policy boundary. |
| scales uniformly by projection on corners and clamps instead of flipping (XF-030/032) | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: scales uniformly by projection on corners and clamps instead of flipping (XF-030/032). No stronger retained test owns this exact input/policy boundary. |
| rotates with unwrapping, Shift 15° steps and the 90° snap (XF-035) | **KEEP** | Detects a violation of: rotates with unwrapping, Shift 15° steps and the 90° snap (XF-035). No stronger retained test owns this exact input/policy boundary. |
| moves the anchor without moving the image (XF-037, AC-XF-2 logic) | **KEEP** | Detects a violation of: moves the anchor without moving the image (XF-037, AC-XF-2 logic). No stronger retained test owns this exact input/policy boundary. |
| engages within 6 ± 1 screen px at 50 % and 200 % (AC-SNP-1) | **KEEP** | Detects a violation of: engages within 6 ± 1 screen px at 50 % and 200 % (AC-SNP-1). No stronger retained test owns this exact input/policy boundary. |
| prefers the nearest target, then center-to-center (AC-SNP-2) | **KEEP** | Detects a violation of: prefers the nearest target, then center-to-center (AC-SNP-2). No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/program-monitor.test.tsx`

Independent source (bar 1): docs/specs/03-monitors-effect-controls-rendering-items.md PGM-004, XF-053/060, RND-032; ARCHITECTURE.md §8. Seam (bar 4): monitor/overlay input → timecode/document; media resolver → Player URL contract. Production owner and non-test callers: panels/program/{ProgramMonitor,TransformOverlay,render-doc}.tsx/ts; mounted monitor and source monitor. Ownership (bar 6): Retained overlay gestures own event-to-edit/undo/cancel conversion; resolver owns engine URL/proxy/rotation mapping and Player seekable duration. Primitive project tests do not exercise those adapters.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/program-monitor.test.tsx`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| marks, navigates and edits a range through the registered timeline commands | **DELETE** | Replays marks, navigation, lift and extract already owned by timeline-commands tests through an extra button layer. |
| shows the active sequence timecode and duration | **KEEP** | Detects a violation of: shows the active sequence timecode and duration. No stronger retained test owns this exact input/policy boundary. |
| does not re-render React outside the Player per played frame (S03:ARC-010) | **DELETE** | React commit budget is a private rendering strategy and happy-dom is not a playback performance measurement. |
| makes one undo step per move / rotate drag and undo restores the exact values (AC-XF-3) | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: makes one undo step per move / rotate drag and undo restores the exact values (AC-XF-3). No stronger retained test owns this exact input/policy boundary. |
| Esc cancels a drag without a history entry | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Esc cancels a drag without a history entry. No stronger retained test owns this exact input/policy boundary. |
| Type tool click creates a text clip at the playhead and selects it (XF-060) | **KEEP** | Detects a violation of: Type tool click creates a text clip at the playhead and selects it (XF-060). No stronger retained test owns this exact input/policy boundary. |
| uses /media/<key>, the proxy when ready, upright size, offline → null | **KEEP** | Detects a violation of: uses /media/<key>, the proxy when ready, upright size, offline → null. No stronger retained test owns this exact input/policy boundary. |
| sizes the Player to end + 1 frame, or 10 s when empty | **KEEP** | Detects a violation of: sizes the Player to end + 1 frame, or 10 s when empty. No stronger retained test owns this exact input/policy boundary. |

## `apps/web/test/program-layer-menu.test.tsx`

Independent source (bar 1): docs/specs/03-monitors-effect-controls-rendering-items.md XF-038/050/051; docs/specs/02-timeline.md TL-266. Seam (bar 4): layer operation functions and runCommand → document/selection. Production owner and non-test callers: panels/program/layer-ops.ts and commands/layer.ts; layer menus and keymap command routing. Ownership (bar 6): Pure layer operations own cropped/rotated fitting and anchor preservation; command cases own animation writes, reset enablement, arrange track policy and reveal selection.

Risk: low for deletion; no production behavior change. Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx`. For every retained row, bars 2/3/5 are its named caller-visible failure, literal or law-based oracle, and preservation under internal refactoring as defined above.

| Test (original name) | Disposition | Failure/decision and remaining coverage |
| --- | --- | --- |
| fits the visible rect inside the frame, centred | **KEEP** | Detects a violation of: fits the visible rect inside the frame, centred. No stronger retained test owns this exact input/policy boundary. |
| uses the rotated bounds, fills by the larger ratio, and Set to Native only sets 100% | **KEEP** | Detects a violation of: uses the rotated bounds, fills by the larger ratio, and Set to Native only sets 100%. No stronger retained test owns this exact input/policy boundary. |
| moves the anchor to each grid point of the visible rect without moving a pixel | **KEEP** | Detects a violation of: moves the anchor to each grid point of the visible rect without moving a pixel. No stronger retained test owns this exact input/policy boundary. |
| Fit to Frame / Fill Frame / Set to Native: one step each, keyed at the playhead when animated | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Fit to Frame / Fill Frame / Set to Native: one step each, keyed at the playhead when animated. No stronger retained test owns this exact input/policy boundary. |
| Reset Motion and Reset Crop reuse Remove Attributes; Reset Crop needs a crop | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Reset Motion and Reset Crop reuse Remove Attributes; Reset Crop needs a crop. No stronger retained test owns this exact input/policy boundary. |
| Anchor ▸ Top Left keeps the layer where it is | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Anchor ▸ Top Left keeps the layer where it is. No stronger retained test owns this exact input/policy boundary. |
| Arrange ▸ Bring Forward moves the video to a new track and leaves its linked audio alone | **REWRITE** | Remove incidental copy/identity/shared-oracle assertions; retain the independently specified outcome: Arrange ▸ Bring Forward moves the video to a new track and leaves its linked audio alone. No stronger retained test owns this exact input/policy boundary. |
| Bring to Front above the top track creates a video track (S02:TL-266) | **KEEP** | Detects a violation of: Bring to Front above the top track creates a video track (S02:TL-266). No stronger retained test owns this exact input/policy boundary. |
| Reveal in Project selects the item, focuses the panel and reveals it; Reveal in Timeline focuses the Timeline | **REWRITE** | Detects a violation of: Reveal in Project selects the item, focuses the panel and reveals it; Reveal in Timeline focuses the Timeline. No stronger retained test owns this exact input/policy boundary. |

## Support and production seams planned for removal

- Remove the 3,000-clip component fixture, React Profiler imports, unused keymap imports, menu-flattening helper, and imports made dead by the deleted cases.
- Make `fitScale`, `isCorner`, `majorCandidates`, `chooseTicks`, `shortLabel`, and `builtInTransitionDefaults` module-private: repository caller search found only same-module production callers once direct/copied-oracle probes are removed. Other production interfaces remain used by the consumers listed above.
- Retain `timeline-helpers.ts`: multiple retained controller and command fixtures use its real-session setup; it does not emulate the behavior asserted.

Completion/validation will be appended after edits.

Follow-up recorded before edits: selected-transition clearing moves to the command/session seam and drops mounted rectangle checks; the command owns selection-scoped deletion and undo. Transport fixtures replace the test-only registry reset with the production registration disposer; no command behavior changes.

Follow-up recorded before edits: layer Reveal keeps the real project selection and unavailable-action outcome and removes focus/reveal callback spies and the dummy ProjectPanel registration. Production uses the optional panel registry; absence of a panel is supported and leaves selection observable.

Follow-up recorded before edits: scale-drag invariants use all eight independently listed handle points and opposite points from the specified 640×360 / 20%-left-crop fixture. Remove imported HANDLE_IDS/handlePoint/oppositeHandle from the expected geometry; a missing/misplaced production handle must fail. The matrix projection checks the independent rendered-pixel conservation law, not the scale solver implementation.

## Completed cleanup and validation

Disposition totals: {'DELETE': 16, 'REWRITE': 44, 'KEEP': 80}. All 140 original tests are recorded; 124 remain. Test changes are net-negative by approximately 430 lines. No product behavior was changed. Six non-API helper exports became module-private and unused fixtures/imports/spy registrations were removed.

Baseline: 12 files / 140 tests passed. First post-edit run: 116/124 passed; five failures were 5-second timeouts under host load around 190, two were strict parser assertions corrected to match the meaningful result, and one needed to await the existing asynchronous overlay preview. The four affected/changed files were rerun with `--maxWorkers 2 --testTimeout 30000`: 36/36 passed. The final explicit-handle fixture tightening passed Biome; its scoped run was stopped at the coordinating agent’s request because the root single-worker full Vitest gate owns final validation. No checked-in timeout was changed.

Scoped Biome checks passed. `git diff --check` passed. The redundant web typecheck was interrupted at the coordinator’s request; web typecheck and repository lint/typecheck/test gates are owned by the parent/root agent. Final diff inspection confirmed the removals and no production behavior changes.

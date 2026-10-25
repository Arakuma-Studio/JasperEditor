# Web feature test cleanup

Scope: 43 owned test files, 273 original test declarations (parameterized declarations listed once). Every listed declaration was read with its related production boundary and the cited contract. Disposition is about behavior, not statement coverage. Paths below are repository-relative.

Production-only test seams removed: StrokeAnimationAdapter override/global/getter and redundant style alias; EaseDispatchProvider context override; mutable docCommandSupport.has hook. StrokeAnimationBody, curve drag helpers, dock layout helpers and three adapter-only type exports are internal. No editing/rendering/persistence behavior is intentionally changed.

The six-bar evidence is factored per file below: the exact test title identifies the independently specified behavior and recognizable regression; Source supplies the independent contract; Oracle states the independent expected result type; Seam and Refactor describe the observed boundary; Ownership explains the distinct failure from model/engine tests. A row’s disposition/reason adds its unique delta or names the surviving stronger owner. Declarative test-name parameters represent every row of the unchanged parameter table.

## `apps/web/test/anime-templates.test.tsx`

- Source: `docs/specs/11-animation.md, ATP-006/008/009, TXA-020…024, LBK-010 and thumbnail hover/reduced-motion contract`.
- Stable seam / refactor resistance: real template/text UI commands/panels → session; LayerBakeRuntime request/job result → previewFor; PreviewThumb renders real frame probe; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal versions/selected IDs/durations, idle-time boundaries, actual cached preview URL, poster/current frame under controlled time.
- Unique protection / recognizable failure: UI selection/upgrade, stale preview caching, request scheduling, thumbnail contention/reduced-motion failures; engine/model/render tests do not exercise the editor orchestration. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| mg.rerender is disabled with only anime clips selected; anime clips have no jasper-mg spec | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| mg.updateTemplate upgrades the selected clips in one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| mg.updateTemplate honours its clipIds arg without a selection (review fix) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| mixed selections offer Re-render when any clip is fframes, in either order (review fix) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| numeric and colour params have stopwatches; toggling one keys the param; fframes params stay static | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/clip-extensions.test.tsx`

- Source: `AGENTS.md conservative compatibility/no-crash/no-data-loss rules; loose ClipSchema extension preservation`.
- Stable seam / refactor resistance: nudgeSelection command and real ClipView rendering from validated preserved future/camera extensions; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: known visual layer changes while preserved unsupported clip bytes remain equal, undo restoration, visible fixture name.
- Unique protection / recognizable failure: future-transform/null-effects crash or unwanted extension mutation; schema tests alone cannot exercise UI dispatch/render paths. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| nudges visual layers without interpreting $kind transform extension $transform | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| renders a %s clip with a null effects extension | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/color-grade.test.tsx`

- Source: `docs/specs/06-color-grading.md, CGU/LUT-005/SCP-002 and colour export metadata; docs/ARCHITECTURE.md D-32`.
- Stable seam / refactor resistance: actual Lumetri/Interpret/Sequence settings dialogs and commands → saved document/export request; pure readback sizing boundary; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal colour/curve/LUT metadata values, mathematical hue vectors, saved settings/undo; independently specified 256-pixel maximum.
- Unique protection / recognizable failure: UI grade edits/undo, interpretation/HDR mapping and bounded scope readback failures; shader/math tests do not exercise user controls or export settings assembly. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| section switches write the on/off params in one step (and add the instance) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the Looks browser applies a built-in look in one step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| hue/saturation curve tabs and the eyedropper add three points around the picked hue | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| HSL Secondary Set Color keys the picked colour; Add widens it (one step each) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Apply Match needs the Comparison View; the button opens it with a reference | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/color-lumetri.test.tsx`

- Source: `docs/specs/06-color-grading.md, CGU/LUT-005/SCP-002 and colour export metadata; docs/ARCHITECTURE.md D-32`.
- Stable seam / refactor resistance: actual Lumetri/Interpret/Sequence settings dialogs and commands → saved document/export request; pure readback sizing boundary; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal colour/curve/LUT metadata values, mathematical hue vectors, saved settings/undo; independently specified 256-pixel maximum.
- Unique protection / recognizable failure: UI grade edits/undo, interpretation/HDR mapping and bounded scope readback failures; shader/math tests do not exercise user controls or export settings assembly. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| the first edit adds jasper.lumetri in one history entry; a slider drag is one entry | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| scrubbing the exposure value (hot text) is one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| double-click on a slider resets it (one entry) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the curves editor adds, moves and removes points and writes a sorted curve | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| curve tabs edit the per-channel curves | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| a wheel drag writes the unit disc in one entry; double-click resets | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the LUT pickers list the project LUTs with their size, plus None and Browse… (LUT-005) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the before/after toggle marks the clip bypassed (preview only; the document is unchanged) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| edits the selected Lumetri curve in one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Copy Grade / Paste Grade replace the colour effects of the targets in one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Apply as Look sets `look` on the first Lumetri or adds one (one transaction) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/color-mgmt.test.tsx`

- Source: `docs/specs/06-color-grading.md, CGU/LUT-005/SCP-002 and colour export metadata; docs/ARCHITECTURE.md D-32`.
- Stable seam / refactor resistance: actual Lumetri/Interpret/Sequence settings dialogs and commands → saved document/export request; pure readback sizing boundary; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal colour/curve/LUT metadata values, mathematical hue vectors, saved settings/undo; independently specified 256-pixel maximum.
- Unique protection / recognizable failure: UI grade edits/undo, interpretation/HDR mapping and bounded scope readback failures; shader/math tests do not exercise user controls or export settings assembly. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| commits colour and Loop edits from the dialog in one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| patches only changed fields and resets with null | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| turns on Blend Using 1.0 Gamma and Auto Tone Map off in one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| carries the colour space, bit depth and HDR metadata | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/color-scopes.test.ts`

- Source: `docs/specs/06-color-grading.md, CGU/LUT-005/SCP-002 and colour export metadata; docs/ARCHITECTURE.md D-32`.
- Stable seam / refactor resistance: actual Lumetri/Interpret/Sequence settings dialogs and commands → saved document/export request; pure readback sizing boundary; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal colour/curve/LUT metadata values, mathematical hue vectors, saved settings/undo; independently specified 256-pixel maximum.
- Unique protection / recognizable failure: UI grade edits/undo, interpretation/HDR mapping and bounded scope readback failures; shader/math tests do not exercise user controls or export settings assembly. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| reads back at most 256 px wide, keeping the aspect | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/composition-texts.test.tsx`

- Source: `docs/specs/08-motion-graphics-clips.md, MGC-023/024, MGU-006; S05:MGT-002`.
- Stable seam / refactor resistance: actual template/composition UI and public engine HTTP/payload boundary, session host-budget allocation; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal wire bytes, inserted template version/start/duration, actual typed text/transient/undo state and documented four-host budget.
- Unique protection / recognizable failure: wrong template insertion, host starvation or text edit data loss; rendering/model suites do not exercise editor orchestration and text-edit validation. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| previews while typing (no History entry), applies one "Edit Text" step; Esc reverts | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| refuses values the schema rejects and warns about soft limits while typing | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/easing-commands.test.ts`

- Source: `docs/wp-notes/easing.md, Easing panel / Editor / Targeting / Library; CSS Easing Functions literal vectors`.
- Stable seam / refactor resistance: real EasingPanel controls and EditorSession document/preferences, or pure curve/persistence entry points with generated invalid input; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal curve control points, schema-valid mathematical identities, saved values, refusal state and undo history.
- Unique protection / recognizable failure: UI wiring/selection/persistence/parser failures; project math tests do not exercise panel dispatch or per-user library recovery. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| two neighbouring keys: one cubic segment, exactly the stored eases | REWRITE | Replaced expected result calculated by production easesToCubic with literal CSS control points (0.5,0,0.8,0.8). |
| three keys of a number: one multi-point curve through the middle key | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| keys of several properties; point properties are spatial | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| says why nothing can be eased | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Easy Ease / In / Out set {⅓, 0} on the chosen sides as one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Apply Ease is disabled with a reason when the model has no keyframe.applyEase command | DELETE | Fails real regression/stable seam: injects an unavailable bundled-model configuration through a test-only mutable override. Real no-selection/locked-track guards remain; direct isCommandType check retained. |
| Apply Ease shapes the segment exactly, as one undo step, and remembers the curve | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| a multi-point curve creates keys; the selection follows the result | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| a refusal of the model is shown as a toast | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Copy Ease → Paste Ease onto another property; Paste Values | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Keyframe Velocity sets a side’s speed and influence | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Duplicate Keys at Playhead pastes them with the earliest at the playhead | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Mirror Keys at Playhead pastes them reversed with mirrored eases | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Spatial ▸ Linear needs point keys; Temporal ▸ Continuous works on any | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Add Overshoot / Bounce set the preset expression on the selected properties | DELETE | Fails independent oracle/stable seam: searches generated expression source for elasticity/amount tokens. Evaluated overshoot/bounce behavior remains in packages/expressions/test/ease-assistant.test.ts. |
| Drive Along Path makes the point keys slider-driven; Clean Up Motion Path runs on point keys | REWRITE | Surviving test: Drive Along Path requires point keys and creates their controller. Uses actual persisted document/UI outcomes instead of mocked payload/source/call expectations. |
| lists every warning of a result once | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the gated commands say what is missing | DELETE | Fails real regression/stable seam: mutates test-only model-support override for commands always shipped in this model. Real path selection refusals/application remain. |
| F9, Shift+F9, Ctrl+Shift+F9 are the Easy Ease commands everywhere | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| every easing binding names a registered command | DELETE | Fails real regression/unique protection: registry inventory. Literal F9/chord resolution and real command application remain in this file. |

## `apps/web/test/easing-curve-edit.test.ts`

- Source: `docs/wp-notes/easing.md, Easing panel / Editor / Targeting / Library; CSS Easing Functions literal vectors`.
- Stable seam / refactor resistance: real EasingPanel controls and EditorSession document/preferences, or pure curve/persistence entry points with generated invalid input; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal curve control points, schema-valid mathematical identities, saved values, refusal state and undo history.
- Unique protection / recognizable failure: UI wiring/selection/persistence/parser failures; project math tests do not exercise panel dispatch or per-user library recovery. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| moves a cubic handle, clamping x to 0…1 and y to the schema limit | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Shift constrains the move to the axis that moved further | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: easing-panel: Shift constrains the drag to one axis; Escape cancels it. |
| a symmetric cubic stays symmetric; Alt moves one handle on its own | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: easing-panel: drags a handle; a symmetric curve stays symmetric, Alt breaks the link. |
| keeps a smooth multi-curve point smooth unless Alt is held | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| a point carries its handles and stays between its neighbours | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| arrow-key nudges move the handle by the step | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: easing-panel: keyboard arrows/add/Delete/undo/redo. |
| Ctrl-click on a cubic splits it at the time without changing the shape | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| refuses a point too close to another one | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| removing the only interior point gives back a cubic | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| handles list in tab order | DELETE | Fails stable seam/refactor resistance: private handle-reference list. Easing panel keyboard sliders, point editing and curve-validity fuzz remain. |
| Mirror makes a cubic symmetric from its first handle | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: easing-panel: Mirror makes the curve symmetric. |
| Mirror makes a multi curve point-symmetric from its first half | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| numeric fields clamp and ignore non-numbers | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| local undo / redo | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: easing-panel: keyboard arrows/add/Delete/undo/redo. |
| reads CSS syntax, bare lists and keywords; writes CSS syntax | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| refuses %j | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| never throws and round-trips what it writes (fuzz) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| add / remove / drag / mirror | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/easing-library.test.ts`

- Source: `docs/wp-notes/easing.md, Easing panel / Editor / Targeting / Library; CSS Easing Functions literal vectors`.
- Stable seam / refactor resistance: real EasingPanel controls and EditorSession document/preferences, or pure curve/persistence entry points with generated invalid input; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal curve control points, schema-valid mathematical identities, saved values, refusal state and undo history.
- Unique protection / recognizable failure: UI wiring/selection/persistence/parser failures; project math tests do not exercise panel dispatch or per-user library recovery. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| save, rename, colour, favourite, delete | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| refuses an invalid curve | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| groups: add, rename, move to, delete (curves go to the default group) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| reorders within a group only | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| duplicates a built-in into a user group | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| remembers recent curves newest first without duplicates | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| stores the library and settings and reads them back | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| drops damaged entries one by one and keeps the rest | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| does not read or overwrite a library written by a newer version | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| never throws on arbitrary stored values (fuzz) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| round-trips a group with new ids on clashes | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| refuses %s | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| skips invalid presets with a reason and keeps the valid ones | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| caps the file size | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| never throws and only adds schema-valid presets (fuzz) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/easing-panel.test.tsx`

- Source: `docs/wp-notes/easing.md, Easing panel / Editor / Targeting / Library; CSS Easing Functions literal vectors`.
- Stable seam / refactor resistance: real EasingPanel controls and EditorSession document/preferences, or pure curve/persistence entry points with generated invalid input; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal curve control points, schema-valid mathematical identities, saved values, refusal state and undo history.
- Unique protection / recognizable failure: UI wiring/selection/persistence/parser failures; project math tests do not exercise panel dispatch or per-user library recovery. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| drags a handle; a symmetric curve stays symmetric, Alt breaks the link | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Shift constrains the drag to one axis; Escape cancels it | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Ctrl-click on the curve adds a point, on the point removes it; double-click resets | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| keyboard: arrows nudge the focused handle, + adds a point, Delete removes it, Ctrl+Z undoes | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| numeric fields and the cubic-bezier text refuse invalid input | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Mirror makes the curve symmetric | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| remembers the edited curve | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Apply sends the curve; Shift / Alt / Ctrl pick in / out / middle and add up | REWRITE | Surviving test: Apply modifiers ease the arriving or leaving segment of the selected key. Uses actual persisted document/UI outcomes instead of mocked payload/source/call expectations. |
| disabled actions show the command’s reason | REWRITE | Surviving test: Apply stays disabled without a project. Uses actual persisted document/UI outcomes instead of mocked payload/source/call expectations. |
| the toolbar and its More menu run the easing commands | DELETE | Fails stable seam/independent oracle: private dispatch-call inventory with fabricated reasons. Actual modifier application, real commands and public shortcut resolution remain. |
| shows the selection’s curve and what an apply will reach | REWRITE | Assert numeric target data rather than incidental English wording; selection curve still has literal CSS oracle. |
| Auto-apply runs a drag as one live gesture | REWRITE | Surviving test: Auto-apply previews the edited ease and commits a drag as one undo step. Uses actual persisted document/UI outcomes instead of mocked payload/source/call expectations. |
| edits the speed and influence of a side, or both with Link | REWRITE | Replaced dispatch spy with real persisted keyframe slope 1.2 and clamped influence 1. |
| a flat segment has no speed to set | REWRITE | Assert disabled speed/enabled influence and nonempty reason rather than incidental wording. |
| plays the curve, or shows still frames with reduced motion | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| built-in tiles apply and load; the matching tile is highlighted; hover shows its values | REWRITE | Replaced dispatch spy with actual ShellRuntimeProvider, selected keyframes and persisted zero easing slopes. |
| built-ins are read-only: Duplicate copies one into My Curves | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| save, rename, reorder from the keyboard, delete with undo | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| imports a file, listing what it skipped; an oversized file is refused | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| new groups, tile size and columns are settings | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the view switch shows the editor, the library or both | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/effect-controls-graph-ui.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, KF-021/022 and OVL-020; docs/wp-notes/easing.md`.
- Stable seam / refactor resistance: real EffectControlsPanel/TransformOverlay controls → EditorSession saved values/transients/selection; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal content-time/key/transform/easing values, protected locked state, one History step and undo restoration.
- Unique protection / recognizable failure: UI field/drag/selection/coordinate conversion and guarded-edit failures; model commands do not exercise pointer/menu/control wiring. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| the twirl opens graphs and preserves the choice when the panel remounts | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| dragging a value-graph key vertically changes its value as one undo entry, previewed live | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| dragging a key horizontally moves it in time (whole frames, Shift = no snap); Esc cancels | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| velocity handles: vertical = speed, horizontal = influence; a Linear key becomes Bezier | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Continuous Bezier keeps in/out speeds linked; Alt-drag breaks the link into Bezier | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| value-graph Bezier handles edit the ease; graph keys share selection and the context menu | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/effect-controls-graph.test.ts`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, KF-022; S01 content-time keyframe units`.
- Stable seam / refactor resistance: graph sampling/time mapping numerical boundary consumed by real graphs; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: independent derivative vectors: 90 units/s, -180 units/s, 3-4-5 path speed 50, reverse -90, holds zero.
- Unique protection / recognizable failure: wrong chart units/sign/hold discontinuity; UI handle tests check edits, not independently calculated plotted derivatives. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| is the derivative of evaluate in units per second: constant on linear segments, zero outside | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| eases to zero speed at an Ease Out key and steps at keys with different in/out speeds | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| vec2 velocity is the speed along the path; reversed clips flip the sign of numbers | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| holds have zero velocity | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/effect-controls.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, KF-021/022 and OVL-020; docs/wp-notes/easing.md`.
- Stable seam / refactor resistance: real EffectControlsPanel/TransformOverlay controls → EditorSession saved values/transients/selection; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal content-time/key/transform/easing values, protected locked state, one History step and undo restoration.
- Unique protection / recognizable failure: UI field/drag/selection/coordinate conversion and guarded-edit failures; model commands do not exercise pointer/menu/control wiring. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| the stopwatch creates a key at the playhead content time; a later value makes a ramp resolved at the playhead | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| turning the stopwatch off asks first and keeps the value at the playhead | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| right-click interpolation menu eases a key and changes its glyph; drag moves keys by whole frames | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| shows applied effects with bypass/remove and accepts drops from the Effects panel | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| shows "Missing effect: <id>" and still allows removing it | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the footer Loop button reflects the transport loop state | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/effect-presets.test.tsx`

- Source: `docs/specs/05-ui-shell-premiere-design.md, HIS-001…003/EFX-001…003; S01:UND-009/FX-030`.
- Stable seam / refactor resistance: actual History/Effects/Effect Controls UI → session or public engine preset API; effect drag wire parser; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal effect IDs/keyframe vectors/wire bytes, chosen history state, confirmed deletion and saved preset sections.
- Unique protection / recognizable failure: history navigation/confirmation, selected-target application, protocol compatibility and preset save/load failures; model tests do not exercise UI/engine coordination. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| lists built-ins, searches, filters by badges and applies by double-click as one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| shows user bins from the engine library and deletes a preset after confirmation | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| a dragged preset is an effect ref; dropping it on Effect Controls applies it | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Save Preset… on selected headers opens the dialog and stores the sections in the library | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/expressions-ui.test.tsx`

- Source: `docs/wp-notes/expressions.md; S03 expression field/error fallback behavior`.
- Stable seam / refactor resistance: real EffectControlsPanel with loaded expression engine → saved expression and displayed result; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: time*90 at one second equals 90, disabled/error fallback value zero, undo restoration.
- Unique protection / recognizable failure: expression control binding/error-display failures; expression engine unit tests do not mount editor fields. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| Alt-click adds the default expression; the value shows post-expression; Alt-click removes; undo | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| errors show under the field and the property keeps its keyframed value; the switch disables | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/fx-panel.test.ts`

- Source: `docs/specs/05-ui-shell-premiere-design.md, EFX search/capability filtering`.
- Stable seam / refactor resistance: effectTree catalog filter used by real EffectsPanel; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: synthetic independent shader fixture is sole GPU/bin-name match.
- Unique protection / recognizable failure: wrong GPU/bin-name search filtering; actual EffectsPanel search test covers text aliases but not shader capability/bin semantics. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| the GPU filter keeps only shader effects; search matches the bin name | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/history-effects.test.tsx`

- Source: `docs/specs/05-ui-shell-premiere-design.md, HIS-001…003/EFX-001…003; S01:UND-009/FX-030`.
- Stable seam / refactor resistance: actual History/Effects/Effect Controls UI → session or public engine preset API; effect drag wire parser; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal effect IDs/keyframe vectors/wire bytes, chosen history state, confirmed deletion and saved preset sections.
- Unique protection / recognizable failure: history navigation/confirmation, selected-target application, protocol compatibility and preset save/load failures; model tests do not exercise UI/engine coordination. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| jumps to the chosen history entry and clears only after confirmation | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| filters by search and applies by double-click to the selected clips as one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| writes and reads the effect drag protocol | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/keyframes-blend-ui.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, KF-021/022 and OVL-020; docs/wp-notes/easing.md`.
- Stable seam / refactor resistance: real EffectControlsPanel/TransformOverlay controls → EditorSession saved values/transients/selection; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal content-time/key/transform/easing values, protected locked state, one History step and undo restoration.
- Unique protection / recognizable failure: UI field/drag/selection/coordinate conversion and guarded-edit failures; model commands do not exercise pointer/menu/control wiring. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| sets the selected blend mode in one undo entry | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| right-click a middle key toggles Rove Across Time | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| is not offered for the first or last key | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Ctrl-wheel disables auto-fit for one graph, survives remount, and Fit restores it | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| vec2 Bezier handles on the X and Y curves edit the shared ease (one undo entry) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/layer-bake-runtime.test.ts`

- Source: `docs/specs/11-animation.md, ATP-006/008/009, TXA-020…024, LBK-010 and thumbnail hover/reduced-motion contract`.
- Stable seam / refactor resistance: real template/text UI commands/panels → session; LayerBakeRuntime request/job result → previewFor; PreviewThumb renders real frame probe; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal versions/selected IDs/durations, idle-time boundaries, actual cached preview URL, poster/current frame under controlled time.
- Unique protection / recognizable failure: UI selection/upgrade, stale preview caching, request scheduling, thumbnail contention/reduced-motion failures; engine/model/render tests do not exercise the editor orchestration. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| asks for the graded preview of graded DOM layers only, after they stop changing | OPTIMIZE | Virtual time replaces both 2-second idle waits. Checks no submission at 1999 ms, submission at 2000 ms, cached preview after move, invalidation after actual text edit. |
| a layer edited just before its request fires is not stored under its old identity | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/masks-ui.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, Properties/masks/transform editing; docs/specs/11-animation.md SHP-005/007; docs/wp-notes/shapes.md`.
- Stable seam / refactor resistance: actual Properties/Effect Controls/shape/vector tools → session document; clipboard SVG-path classification; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal edit/keyframe/shape/path coordinates, aspect-ratio invariants, selection, one History entry and undo restoration.
- Unique protection / recognizable failure: UI gestures/tool selection, mask/shape control or wrong coordinate edits; project geometry tests do not mount user control/gesture paths. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| creates ellipse / polygon masks under Opacity, edits mode / inverted / feather, keys the path, deletes | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| every video effect gets mask tools; the pen arms the monitor | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/mg-runtime-budget.test.ts`

- Source: `docs/specs/08-motion-graphics-clips.md, MGC-023/024, MGU-006; S05:MGT-002`.
- Stable seam / refactor resistance: actual template/composition UI and public engine HTTP/payload boundary, session host-budget allocation; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal wire bytes, inserted template version/start/duration, actual typed text/transient/undo state and documented four-host budget.
- Unique protection / recognizable failure: wrong template insertion, host starvation or text edit data loss; rendering/model suites do not exercise editor orchestration and text-edit validation. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| gives 4 slots first-come; an edited clip takes the farthest holder’s slot until the edit ends | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/motion-path-keyframes-blend.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, KF-021/022 and OVL-020; docs/wp-notes/easing.md`.
- Stable seam / refactor resistance: real EffectControlsPanel/TransformOverlay controls → EditorSession saved values/transients/selection; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal content-time/key/transform/easing values, protected locked state, one History step and undo restoration.
- Unique protection / recognizable failure: UI field/drag/selection/coordinate conversion and guarded-edit failures; model commands do not exercise pointer/menu/control wiring. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| draws the Anchor Point path through the layer map and edits its keys in layer space | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| snaps a dragged key to the frame centre (snapping on) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| drags every selected key of the path by the same offset (one undo entry) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Ctrl-click converts a vertex (smooth ↔ corner); the Pen tool drags handles out of a corner | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/motion-path.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, KF-021/022 and OVL-020; docs/wp-notes/easing.md`.
- Stable seam / refactor resistance: real EffectControlsPanel/TransformOverlay controls → EditorSession saved values/transients/selection; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal content-time/key/transform/easing values, protected locked state, one History step and undo restoration.
- Unique protection / recognizable failure: UI field/drag/selection/coordinate conversion and guarded-edit failures; model commands do not exercise pointer/menu/control wiring. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| is not drawn below two position keys | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| dragging a key square edits that key (one undo entry) and selects it | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| dragging a tangent keeps it continuous; Alt-drag breaks continuity; one undo entry per drag | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| keys on a locked track are drawn but not draggable | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| sets the spatial interpolation of position keys from the key context menu | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| opens its submenu fixed beside its row, flipped left at the window edge, not clipped by the scrolling menu | DELETE | Fails stable seam/refactor resistance: exact CSS positioning/class after fabricated element rectangles. Actual menu editing and non-point eligibility tests remain. |
| is not offered for keys of non-point properties | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/motion-templates.test.tsx`

- Source: `docs/specs/08-motion-graphics-clips.md, MGC-023/024, MGU-006; S05:MGT-002`.
- Stable seam / refactor resistance: actual template/composition UI and public engine HTTP/payload boundary, session host-budget allocation; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal wire bytes, inserted template version/start/duration, actual typed text/transient/undo state and documented four-host budget.
- Unique protection / recognizable failure: wrong template insertion, host starvation or text edit data loss; rendering/model suites do not exercise editor orchestration and text-edit validation. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| round-trips the drag payload | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| shows the gallery with static previews and inserts on double-click via clip.addMotionGraphic | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| mg.rerender sends the selected clip spec to the engine when fframes is available | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/preview-thumb.test.tsx`

- Source: `docs/specs/11-animation.md, ATP-006/008/009, TXA-020…024, LBK-010 and thumbnail hover/reduced-motion contract`.
- Stable seam / refactor resistance: real template/text UI commands/panels → session; LayerBakeRuntime request/job result → previewFor; PreviewThumb renders real frame probe; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal versions/selected IDs/durations, idle-time boundaries, actual cached preview URL, poster/current frame under controlled time.
- Unique protection / recognizable failure: UI selection/upgrade, stale preview caching, request scheduling, thumbnail contention/reduced-motion failures; engine/model/render tests do not exercise the editor orchestration. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| shows the poster frame, then the shared hover Player after 200 ms | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| leaving before the delay never starts the Player | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| touch and reduced motion keep the poster | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/properties.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, Properties/masks/transform editing; docs/specs/11-animation.md SHP-005/007; docs/wp-notes/shapes.md`.
- Stable seam / refactor resistance: actual Properties/Effect Controls/shape/vector tools → session document; clipboard SVG-path classification; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal edit/keyframe/shape/path coordinates, aspect-ratio invariants, selection, one History entry and undo restoration.
- Unique protection / recognizable failure: UI gestures/tool selection, mask/shape control or wrong coordinate edits; project geometry tests do not mount user control/gesture paths. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| AC-INS-1: mixed scales show – and a +10 drag gives 60/90/110 as one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| typed relative entry changes each clip and an expression sets all clips | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the ◆ toggle creates a key at the playhead content time and removes it again | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| crop edits create the jasper.crop effect at index 0 on first edit | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/scene3d-overlay.test.tsx`

- Source: `docs/wp-notes/three-d.md and AGENTS.md visible error/no-blank-editor rule`.
- Stable seam / refactor resistance: Scene3DOverlay rendered from actual camera document; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: active-camera selector names the literal fixture camera.
- Unique protection / recognizable failure: camera selector/overlay failure from wrong snapshot/document access; model 3D tests cannot catch React binding failures. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| renders the active camera from the supplied 3D document | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/shapes.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, Properties/masks/transform editing; docs/specs/11-animation.md SHP-005/007; docs/wp-notes/shapes.md`.
- Stable seam / refactor resistance: actual Properties/Effect Controls/shape/vector tools → session document; clipboard SVG-path classification; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal edit/keyframe/shape/path coordinates, aspect-ratio invariants, selection, one History entry and undo restoration.
- Unique protection / recognizable failure: UI gestures/tool selection, mask/shape control or wrong coordinate edits; project geometry tests do not mount user control/gesture paths. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| shape commands require a sequence and add selected shapes at the playhead | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| a drag creates the shape with that box in one undo step, selects it and returns to Selection | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Shift draws a circle, Alt draws from the centre; Escape cancels; a click adds nothing | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| off (default): handles change Motion scale | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| on: handles change shape.size (stroke width unchanged), one undo step; Alt keeps the west side | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| shows type, size, fill and radius; None toggles remove/restore fill and add/remove the stroke | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the size link keeps the aspect ratio when one side is typed | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/stroke-animation-dock.test.ts`

- Source: `docs/wp-notes/shapes.md, Stroke Animation panel`.
- Stable seam / refactor resistance: real StrokeAnimationPanel/UI command dispatch → EditorSession document; DockController.open → external Dockview API; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal saved trim-key values/times and preference values, no History when disabled, undo restoration; Dockview documented position/floating fields.
- Unique protection / recognizable failure: UI modifier/selection/transaction/persistence failures; project trim math does not exercise panel routing and one-click atomicity. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| has an open neighbour in every built-in workspace and layout preset | DELETE | Fails stable seam/refactor resistance: private workspace-layout inventory. Actual DockController.open output to the external Dockview API remains for preferred-neighbour/fallback behavior. |
| opens as a tab beside the first open preferred neighbour | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| floats only when none of its neighbours is open | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| keeps single-neighbour definitions working | DELETE | Fails unique protection/stable seam: trivial private normalization helper. Actual open-as-tab and floating-fallback tests remain; helper exports internalized. |

## `apps/web/test/stroke-animation.test.tsx`

- Source: `docs/wp-notes/shapes.md, Stroke Animation panel`.
- Stable seam / refactor resistance: real StrokeAnimationPanel/UI command dispatch → EditorSession document; DockController.open → external Dockview API; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal saved trim-key values/times and preference values, no History when disabled, undo restoration; Dockview documented position/floating fields.
- Unique protection / recognizable failure: UI modifier/selection/transaction/persistence failures; project trim math does not exercise panel routing and one-click atomicity. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| maps every style × modifier to the contract payload | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: stroke-animation: real document modifier-key outcomes and Divide Out result; packages/project/test/vector/trim-animate.test.ts owns all style math. |
| Alt toggles Reverse and Shift toggles Animate offset relative to the checkboxes | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: stroke-animation: four literal actual button modifier outcomes without changing preferences. |
| starts at the playhead only inside the clip, and groups clips by start | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: stroke-animation: real Draw In checks one clip containing playhead and one later clip, in one undo step. |
| sends the settings and the curve | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: stroke-animation: real Divide Out consumes copies/curve/offset preferences; actual panel settings round-trip remains. |
| reads the master trim of each clip from the results and ignores anything else | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: stroke-animation: real Tracer on Next excludes skipped clip and follows actual generated master trim. |
| offers the cubic presets of the built-in catalogue only | DELETE | Fails independent oracle/unique protection: catalog/schema inventory over production declarations. Actual valid preset choice/application and parser rejection remain. |
| shows a stored curve as its preset, or the preset with the same shape | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| labels presets with their group outside Basic | DELETE | Fails independent oracle: expected label reassembled from the same BUILTIN_EASE_GROUPS production table. Actual panel preset selection/display remains. |
| parses CSS cubic-bezier and plain lists, refuses invalid curves | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| round-trips every valid cubic through its text (3 decimals) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| never throws on arbitrary text | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| parses any stored value into valid preferences | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| keeps valid fields and replaces only the invalid ones | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| round-trips through storage and ignores invalid updates | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| drops a preset id without its curve | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| every action has a registered command, and the menu lists each of them | DELETE | Fails stable seam/refactor resistance: command/menu inventory. Actual real-session UI command and panel outcomes remain. |
| is disabled with a reason without a project, a sequence, a shape selection or write access | REWRITE | Deleted stub-transaction half; retains actual selection/read-only/invalid-args refusals. |
| shows refusals and skipped-clip warnings as notifications | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: stroke-animation: real reports skipped clips/refuses without modifying document. |
| adds tracers to the next animation in the same transaction | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: stroke-animation: real Tracer on Next one History entry, undo and redo. |
| Add Tracer targets the selected trim item and an optional follower | REWRITE | Deleted stub collaborator-call half; retains actual trim-choice priority and ambiguous follower/trim refusals. |
| adds lines at the playhead on a free track and selects them | CONSOLIDATE | Fails unique protection: private helper/mock repetition of stronger owner. Surviving owner: stroke-animation: real Add Tracer/follower/line/reversal scenario. |
| disables the buttons with the reason until a shape is selected | REWRITE | Uses actual panel/session and asserts no History edit when disabled; no adapter override. |
| maps every animation button × Alt / Shift to its payload | REWRITE | Surviving test: click modifiers change the drawn trim without changing preferences: $altKey / $shiftKey. Uses actual persisted document/UI outcomes instead of mocked payload/source/call expectations. |
| edits and persists the settings; hides buttons | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Draw In keys Trim Paths at the playhead in one undo step; a re-run replaces it; undo restores | REWRITE | Consolidated start-at-playhead grouping into actual two-clip document results; atomic undo remains. |
| every style applies to a stroked shape and to a converted rectangle | REWRITE | Surviving test: Divide Out converts rectangles and exposes the divided animation’s master trim. Uses actual persisted document/UI outcomes instead of mocked payload/source/call expectations. |
| reports skipped clips and refuses when nothing applies, without changing the document | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Tracer on Next adds a tracer for each animated clip in the same History entry | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Add Tracer drives a selected follower; lines and path reversal apply | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/text-animation.test.tsx`

- Source: `docs/specs/11-animation.md, ATP-006/008/009, TXA-020…024, LBK-010 and thumbnail hover/reduced-motion contract`.
- Stable seam / refactor resistance: real template/text UI commands/panels → session; LayerBakeRuntime request/job result → previewFor; PreviewThumb renders real frame probe; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal versions/selected IDs/durations, idle-time boundaries, actual cached preview URL, poster/current frame under controlled time.
- Unique protection / recognizable failure: UI selection/upgrade, stale preview caching, request scheduling, thumbnail contention/reduced-motion failures; engine/model/render tests do not exercise the editor orchestration. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| chooses In or Out from the drop position | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| text.applyAnimation / text.removeAnimation are agent-exposed and act on the selection by default | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| filters presets and applies the selected animation by double-click or Enter | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| picks presets, edits duration and params for all selected text clips | KEEP | Title corrected to match actual asserted behavior; setup/action/assertions unchanged. |
| shows the Text Animation section after Opacity and In/Out bars whose edge drag is one undo step | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| a compressed bar edge follows the pointer (the drag inverts the compression) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/tracking-actions.test.tsx`

- Source: `docs/specs/09-tracking.md, TRK-010/023 and TRU-005/006; AGENTS.md compatibility/no-crash rules`.
- Stable seam / refactor resistance: tracking job/event boundary, actual dialogs/overlays/TimelinePanel → session document and transient state; sample-to-time mapping; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal source/sequence frame vectors, independent confidence minima, real committed keys, job failure state and undo restoration.
- Unique protection / recognizable failure: progress/poll/commit/cancel, lost-frame display, retiming, preserved extensions and UI navigation failures; engine tracker math does not protect UI lifecycle. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| runs Track Forward: request body, live progress, one "Track" entry with the samples | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| passes the planar options and quality | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| re-tracks from here and re-applies to the linked target inside the same "Track" entry | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| stops a job without committing | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| reports engine errors on the tracker | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| finishes by polling when no event arrives | OPTIMIZE | Virtual 900 ms replaces real polling wait; actual fake-engine completed-job result still creates exactly one Track entry. |
| drags an edge (two corners) and the body (all corners), one entry each | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/tracking-live.test.tsx`

- Source: `docs/specs/09-tracking.md, TRK-010/023 and TRU-005/006; AGENTS.md compatibility/no-crash rules`.
- Stable seam / refactor resistance: tracking job/event boundary, actual dialogs/overlays/TimelinePanel → session document and transient state; sample-to-time mapping; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal source/sequence frame vectors, independent confidence minima, real committed keys, job failure state and undo restoration.
- Unique protection / recognizable failure: progress/poll/commit/cancel, lost-frame display, retiming, preserved extensions and UI navigation failures; engine tracker math does not protect UI lifecycle. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| merges the received frames over the committed samples and fills gaps with the lower neighbour | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| grows with progress events, stays out of History, and is replaced by the committed result | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/tracking-section.test.tsx`

- Source: `docs/specs/09-tracking.md, TRK-010/023 and TRU-005/006; AGENTS.md compatibility/no-crash rules`.
- Stable seam / refactor resistance: tracking job/event boundary, actual dialogs/overlays/TimelinePanel → session document and transient state; sample-to-time mapping; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal source/sequence frame vectors, independent confidence minima, real committed keys, job failure state and undo restoration.
- Unique protection / recognizable failure: progress/poll/commit/cancel, lost-frame display, retiming, preserved extensions and UI navigation failures; engine tracker math does not protect UI lifecycle. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| offers only Position for point trackers | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Unlink preserves baked tracking keyframes and undo restores the link | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| toggles the Program-monitor handles and warns about a non-convex pin | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/tracking-simplify.test.tsx`

- Source: `docs/specs/09-tracking.md, TRK-010/023 and TRU-005/006; AGENTS.md compatibility/no-crash rules`.
- Stable seam / refactor resistance: tracking job/event boundary, actual dialogs/overlays/TimelinePanel → session document and transient state; sample-to-time mapping; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal source/sequence frame vectors, independent confidence minima, real committed keys, job failure state and undo restoration.
- Unique protection / recognizable failure: progress/poll/commit/cancel, lost-frame display, retiming, preserved extensions and UI navigation failures; engine tracker math does not protect UI lifecycle. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| previews live without a History entry, then applies as one entry | OPTIMIZE | Virtual 120 ms debounce/act microtask flushing replaces arbitrary 200/20 ms sleeps; actual transient/committed values, atomic undo and cancellation assertions remain. Removed unnecessary 60-second test-timeout override. |
| cancel leaves no trace; presets change the tolerance | OPTIMIZE | Virtual 120 ms debounce/act microtask flushing replaces arbitrary 200/20 ms sleeps; actual transient/committed values, atomic undo and cancellation assertions remain. Removed unnecessary 60-second test-timeout override. |
| reports when there is nothing to simplify | OPTIMIZE | Virtual 120 ms debounce/act microtask flushing replaces arbitrary 200/20 ms sleeps; actual transient/committed values, atomic undo and cancellation assertions remain. Removed unnecessary 60-second test-timeout override. |
| ignores preserved non-animation transform data %j when checking keyframe density | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| counts preserved animation fields alongside recognized transform parameters | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| ignores preserved unsupported animation data %j when simplifying unknown clips | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| counts preserved supported animation data %j on unknown clips | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Apply Tracking can simplify in the same entry | OPTIMIZE | Virtual 120 ms debounce/act microtask flushing replaces arbitrary 200/20 ms sleeps; actual transient/committed values, atomic undo and cancellation assertions remain. Removed unnecessary 60-second test-timeout override. |

## `apps/web/test/tracking-timeline.test.tsx`

- Source: `docs/specs/09-tracking.md, TRK-010/023 and TRU-005/006; AGENTS.md compatibility/no-crash rules`.
- Stable seam / refactor resistance: tracking job/event boundary, actual dialogs/overlays/TimelinePanel → session document and transient state; sample-to-time mapping; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal source/sequence frame vectors, independent confidence minima, real committed keys, job failure state and undo restoration.
- Unique protection / recognizable failure: progress/poll/commit/cancel, lost-frame display, retiming, preserved extensions and UI navigation failures; engine tracker math does not protect UI lifecycle. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| maps the tracked span through a sourceIn trim and clips it to the clip | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| respects speed and reverse | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| takes both neighbours of a fractional sample index (other media rates) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| keeps a single lost frame among 1000 visible at low zoom | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| removes the target link glyph when its tracker is removed | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| clicking the badge selects the plate and cycles its active tracker | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| clicking the link glyph or a strip selects the plate and activates the tracker | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| reveals closed sections immediately and when they mount after the request | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/transition-defaults.test.tsx`

- Source: `docs/specs/10-transitions-ui.md, TUI-012…041`.
- Stable seam / refactor resistance: actual timeline gestures, drop payload parser, preference/dialog/API/UI commands → session document; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal alignment/duration/frame/key values, wire bytes, migration defaults and atomic undo.
- Unique protection / recognizable failure: UI target/medium/drop, preference compatibility, gradient/custom-completion and keyframe wiring failures; model transition tests do not exercise these UI boundaries. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| frames: whole, ≥ 1, ≤ 60 s at the rate | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| seconds: converted at the sequence rate, rounded to whole frames with a note | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| stills are kept in 1/30 s and rescaled to the sequence rate like clip.place | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| reads v1 values, fills the new fields and drops wrong-medium ids | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| persists the default type and alignment to localStorage | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Shift+D uses each medium’s own duration and the user alignment | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Effects ▸ Apply to Selected Clips uses the user’s alignment too | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| a duration change is one History step; undo restores the field; the audio length is pinned | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| seconds round to frames; invalid text is marked invalid and commits nothing | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| preference changes (type, alignment, unit) apply immediately and are not in History | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the first Esc reverts the edited duration and keeps the dialog open; the next one closes it | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the bridge answers preferences.get with the user’s default transitions | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| the dragged transition id is readable from the types during dragover (another window) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/transitions-gpu-panels.test.tsx`

- Source: `docs/specs/10-transitions-ui.md, TUI-012…041`.
- Stable seam / refactor resistance: actual timeline gestures, drop payload parser, preference/dialog/API/UI commands → session document; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal alignment/duration/frame/key values, wire bytes, migration defaults and atomic undo.
- Unique protection / recognizable failure: UI target/medium/drop, preference compatibility, gradient/custom-completion and keyframe wiring failures; model transition tests do not exercise these UI boundaries. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| filters transitions by GPU capability | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| edits a GPU transition param in one entry and keyframes it at the playhead | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/transitions-panels.test.tsx`

- Source: `docs/specs/10-transitions-ui.md, TUI-012…041`.
- Stable seam / refactor resistance: actual timeline gestures, drop payload parser, preference/dialog/API/UI commands → session document; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal alignment/duration/frame/key values, wire bytes, migration defaults and atomic undo.
- Unique protection / recognizable failure: UI target/medium/drop, preference compatibility, gradient/custom-completion and keyframe wiring failures; model transition tests do not exercise these UI boundaries. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| clearing a selected transition removes it in one undoable entry | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| offers transitions with drag data, default selection, and search | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Effect Controls edits transition type, duration and alignment | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Properties shows the section for a selected fade; alignment is disabled for one-sided fades | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/transitions-polish.test.tsx`

- Source: `docs/specs/10-transitions-ui.md, TUI-012…041`.
- Stable seam / refactor resistance: actual timeline gestures, drop payload parser, preference/dialog/API/UI commands → session document; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal alignment/duration/frame/key values, wire bytes, migration defaults and atomic undo.
- Unique protection / recognizable failure: UI target/medium/drop, preference compatibility, gradient/custom-completion and keyframe wiring failures; model transition tests do not exercise these UI boundaries. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| picks a Custom Gradient image for Gradient Wipe (None = the built-in gradient) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| turning Custom Completion on seeds a 0 → 100 % curve over the span (one history entry) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| draws a crosshair for Center and drags it in one gesture | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/transitions-timeline.test.ts`

- Source: `docs/specs/10-transitions-ui.md, TUI-012…041`.
- Stable seam / refactor resistance: actual timeline gestures, drop payload parser, preference/dialog/API/UI commands → session document; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal alignment/duration/frame/key values, wire bytes, migration defaults and atomic undo.
- Unique protection / recognizable failure: UI target/medium/drop, preference compatibility, gradient/custom-completion and keyframe wiring failures; model transition tests do not exercise these UI boundaries. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| Alt-dragging the start edge onto the cut makes it start-at-cut | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| clamps to the media handles live with fitTransitionDuration and says so | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| snaps the dragged edge to the playhead | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| body drag snaps the alignment (one "Transition Alignment" entry); Esc cancels with none | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| maps the ±12 px band around a cut in thirds and free edges to fades | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| reports handle availability and refuses when nothing fits | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| an existing transition under the pointer is replaced (same medium) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Ctrl+D with two clips selected: edges of both, two-sided at the cut, one entry | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Ctrl+Shift+D adds audio transitions with the default audio transition; Shift+D both | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## `apps/web/test/vector-shapes.test.tsx`

- Source: `docs/specs/03-monitors-effect-controls-rendering-items.md, Properties/masks/transform editing; docs/specs/11-animation.md SHP-005/007; docs/wp-notes/shapes.md`.
- Stable seam / refactor resistance: actual Properties/Effect Controls/shape/vector tools → session document; clipboard SVG-path classification; assertions observe behavior/data rather than private collaborator counts, class trees or implementation source.
- Independent oracle: literal edit/keyframe/shape/path coordinates, aspect-ratio invariants, selection, one History entry and undo restoration.
- Unique protection / recognizable failure: UI gestures/tool selection, mask/shape control or wrong coordinate edits; project geometry tests do not mount user control/gesture paths. The behavior named by each retained row is its specific failure mode; surrounding tests use different actions, inputs, protocol or lifecycle state.

| Original test declaration | Disposition | Reason / surviving owner |
|---|---|---|
| recognises SVG path data | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| lists the tree; adds, groups, moves, renames, toggles and deletes items (one undo step each) | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| adds presets as groups; stroke options toggle dashes / taper / wave; the gradient editor writes stops | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Convert to Vector Shape keeps the clip and turns it into items | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Star tool: a new vector shape centred on the press; with a vector shape selected, a group in it | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |
| Pen tool: clicks draw a path in a new shape, a click on the first vertex closes it; vertices drag | KEEP | Named contract has the independent source/oracle, stable behavior boundary and unique failure described above; no justified cheaper equivalent found. |

## Validation and measurements

Coordinator baseline (`JASPER_REQUIRE_ORACLES=1`, Node 24.22.1, pnpm 10.34.5, Vitest 4.1.11, `--maxWorkers=2`): all **296 expanded cases in these 43 files passed**. The complete baseline has unrelated failures; those belong to the coordinator's repository-wide report. Measured case durations in this scope: layer-bake idle preview 4460 ms, tracker fallback polling 904 ms, simplify cancellation 490 ms. These are individual case durations from the full run, not isolated wall-clock measurements.

Static checks actually executed: changed-file Biome check/format (17 TypeScript files), `git diff --check`, exhaustive `rg` caller checks for removed seams, and matching all 273 original declaration identities against `/tmp/jasper-test-cleanup/baseline-declarations.json` (zero mismatches). Runtime/typecheck/mutation checks remain **pending under the coordinator's validation lock**. No speedup is claimed.

Pending commands after the coordinator releases the lock:

```sh
export PATH=/root/.local/share/mise/installs/node/24.22.1/bin:$PATH
pnpm install --frozen-lockfile --offline
# All 43 paths listed in this ledger, with --maxWorkers=2:
pnpm exec vitest run <owned-files> --maxWorkers=2
pnpm --filter @jasper/web typecheck
python3 /tmp/measure-web-features-cleanup.py
python3 /tmp/mutate-web-features-cleanup.py
```

The measurement helper alternates the original and optimized three debounce/polling files twice with the same runner/worker settings and restores the final files in `finally`; it records wall-clock times, exit codes and host load. The mutation helper temporarily changes the production idle delay from 2000 to 1000 ms and requires rejection by the no-early-submission assertion before restoring the original file. These helpers have been prepared, **not executed**. Root owns integrated lint/typecheck/test/build/E2E and final comparable full-suite timing.

Declaration dispositions: CONSOLIDATE 13, DELETE 12, KEEP 227, OPTIMIZE 6, REWRITE 15. Final runnable counts differ because one real modifier test expands to four cases.

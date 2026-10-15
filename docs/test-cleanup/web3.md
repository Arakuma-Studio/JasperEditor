# Web test cleanup: group web3

Pre-edit disposition ledger. Scope: the 34 paths assigned in `/tmp/jasper-test-prune2/web3.txt`. The entries below name every original test declaration; loop/it.each families share a row only for the same contract. No test was deleted on a failing result.

Baseline/validation commands: `pnpm exec vitest run <assigned paths> --maxWorkers=1`; after pruning, run the surviving assigned paths with the same worker cap, `pnpm --filter @jasper/web typecheck`, and targeted Biome. Root integration owns repository lint/typecheck/test/build gates. `pnpm install --frozen-lockfile --offline` prepares this isolated worktree.

For retained isolated tests, failure modes are the inverse of each named observable: wrong output value/target, rejected valid action, accepted forbidden action, dropped pending/recovery state, incorrect protocol bytes, stale cache or lost persistence. Tests that only detect formatting/declarations/geometry are deleted. In the bar below B1 is the independent source, B2 the observable failure, B3 the independent oracle, B4 the seam, B5 refactor tolerance, B6 lowest distinct owner.

## apps/web/test/agent-bridge.test.ts

Owner/non-test callers: bridge.ts: start/relay; AgentPanel and project lifecycle. Remaining coverage: Session ownership tests own transaction policy; this bridge owns forced origins, relay answer-key isolation and trailing event delivery.

### KEEP: `forces an agent origin even when the caller claims to be the user`

- B1 — Independent contract: S01 AGT-003/UND-007/008; ARCHITECTURE §11 agent relay.
- B2 — Recognizable failure: violating “forces an agent origin even when the caller claims to be the user” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: AgentBridge public API, emitted WebSocket envelopes and EditorSession history.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session ownership tests own transaction policy; this bridge owns forced origins, relay answer-key isolation and trailing event delivery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/agent-bridge.test.ts --maxWorkers=1` and web typecheck.

### DELETE: `refuses to undo another agent’s top entry`

Detectable failure: an intruder undoes another agent's entry. Independent source: S01 UND-008. Remaining stronger owner: `packages/session/test/session.test.ts` ownership refusal cases; bridge forced-origin case separately protects its trust boundary. This test invokes the same session policy and adds no bridge-specific failure. Non-test caller: AgentBridge dispatch invokes session history APIs. Risk: low; ownership security contract retains its lowest owner. Validation: agent-bridge and session ownership tests plus web typecheck.

### KEEP: `says hello, answers requests, forwards events and resolves engine approvals`

- B1 — Independent contract: S01 AGT-003/UND-007/008; ARCHITECTURE §11 agent relay.
- B2 — Recognizable failure: violating “says hello, answers requests, forwards events and resolves engine approvals” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: AgentBridge public API, emitted WebSocket envelopes and EditorSession history.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session ownership tests own transaction policy; this bridge owns forced origins, relay answer-key isolation and trailing event delivery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/agent-bridge.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `throttles playhead.changed to ≤ 10 Hz with a trailing update`

- B1 — Independent contract: S01 AGT-003/UND-007/008; ARCHITECTURE §11 agent relay.
- B2 — Recognizable failure: violating “throttles playhead.changed to ≤ 10 Hz with a trailing update” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: AgentBridge public API, emitted WebSocket envelopes and EditorSession history.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session ownership tests own transaction policy; this bridge owns forced origins, relay answer-key isolation and trailing event delivery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/agent-bridge.test.ts --maxWorkers=1` and web typecheck.

## apps/web/test/anime-templates.test.tsx

Owner/non-test callers: commands/mg.ts; Properties and Effect Controls hosts. Remaining coverage: Model template migration tests own migration math; web owns explicit/selected targets, mixed renderer gating and stopwatch routing.

### KEEP: `mg.rerender is disabled with only anime clips selected; anime clips have no jasper-mg spec`

- B1 — Independent contract: S11 ATP-006/008/009.
- B2 — Recognizable failure: violating “mg.rerender is disabled with only anime clips selected; anime clips have no jasper-mg spec” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered mg commands / TemplateSection / EffectControlsPanel, observing committed clips and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model template migration tests own migration math; web owns explicit/selected targets, mixed renderer gating and stopwatch routing.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/anime-templates.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `mg.updateTemplate upgrades the selected clips in one undo step`

- B1 — Independent contract: S11 ATP-006/008/009.
- B2 — Recognizable failure: violating “mg.updateTemplate upgrades the selected clips in one undo step” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered mg commands / TemplateSection / EffectControlsPanel, observing committed clips and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model template migration tests own migration math; web owns explicit/selected targets, mixed renderer gating and stopwatch routing.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/anime-templates.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `mg.updateTemplate honours its clipIds arg without a selection (review fix)`

- B1 — Independent contract: S11 ATP-006/008/009.
- B2 — Recognizable failure: violating “mg.updateTemplate honours its clipIds arg without a selection (review fix)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered mg commands / TemplateSection / EffectControlsPanel, observing committed clips and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model template migration tests own migration math; web owns explicit/selected targets, mixed renderer gating and stopwatch routing.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/anime-templates.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `mixed selections offer Re-render when any clip is fframes, in either order (review fix)`

- B1 — Independent contract: S11 ATP-006/008/009.
- B2 — Recognizable failure: violating “mixed selections offer Re-render when any clip is fframes, in either order (review fix)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered mg commands / TemplateSection / EffectControlsPanel, observing committed clips and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model template migration tests own migration math; web owns explicit/selected targets, mixed renderer gating and stopwatch routing.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/anime-templates.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `numeric and colour params have stopwatches; toggling one keys the param; fframes params stay static`

- B1 — Independent contract: S11 ATP-006/008/009.
- B2 — Recognizable failure: violating “numeric and colour params have stopwatches; toggling one keys the param; fframes params stay static” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered mg commands / TemplateSection / EffectControlsPanel, observing committed clips and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model template migration tests own migration math; web owns explicit/selected targets, mixed renderer gating and stopwatch routing.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/anime-templates.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/clipboard.test.tsx

Owner/non-test callers: clipboard/system.ts and commands/clipboard.ts; menus, keyboard and panel paste handlers. Remaining coverage: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.

### KEEP: `copies the selection and pastes it at the playhead on the targeted track, selecting the copies`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “copies the selection and pastes it at the playhead on the targeted track, selecting the copies” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Paste Insert ripples, Cut leaves a gap, and read-only sessions only copy`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “Paste Insert ripples, Cut leaves a gap, and read-only sessions only copy” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Duplicate selects the copies, and Redo restores that selection (defect fix, SEL-008)`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “Duplicate selects the copies, and Redo restores that selection (defect fix, SEL-008)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `prefers JasperEditor content on the system clipboard, rejects newer versions, detects foreign content`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “prefers JasperEditor content on the system clipboard, rejects newer versions, detects foreign content” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `copies selected keyframes and pastes them at the playhead onto the primary clip`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “copies selected keyframes and pastes them at the playhead onto the primary clip” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `copies an effect selected in Effect Controls and pastes it onto every selected clip (EC-032)`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “copies an effect selected in Effect Controls and pastes it onto every selected clip (EC-032)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `copies project items and pastes them into the selected bin, selecting the copies`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “copies project items and pastes them into the selected bin, selecting the copies” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `lists the copied attributes, disables what no target takes, and pastes the checked ones`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “lists the copied attributes, disables what no target takes, and pastes the checked ones” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Remove Attributes resets the checked attributes in one step`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “Remove Attributes resets the checked attributes in one step” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Ctrl+V on the timeline is left to the browser (no preventDefault); in a text field it is never taken`

- B1 — Independent contract: S01 CLB-002…009, SEL-006/008; S03 EC-032.
- B2 — Recognizable failure: violating “Ctrl+V on the timeline is left to the browser (no preventDefault); in a text field it is never taken” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered Edit commands, clipboard transport and dialog controls → committed session state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project clipboard tests own payload and paste arithmetic; these cases own focused-panel dispatch, target choice, selection restoration and native text-field handling.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/clipboard.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/color-grade.test.tsx

Owner/non-test callers: LumetriPanel and grade sections; Scopes worker computeScopes. Remaining coverage: packages/project/test/lumetri-grade.test.ts and scopes.test.ts own numerical math; panel cases own UI input dispatch.

### KEEP: `section switches write the on/off params in one step (and add the instance)`

- B1 — Independent contract: S06 CGU-001…005; docs/wp-notes/color-grade.md.
- B2 — Recognizable failure: violating “section switches write the on/off params in one step (and add the instance)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: LumetriPanel controls → committed grade / comparison state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: packages/project/test/lumetri-grade.test.ts and scopes.test.ts own numerical math; panel cases own UI input dispatch.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/color-grade.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `the Looks browser applies a built-in look and clears a look LUT, one step`

- B1 — Independent contract: S06 CGU-001…005; docs/wp-notes/color-grade.md.
- B2 — Recognizable failure: violating “the Looks browser applies a built-in look and clears a look LUT, one step” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: LumetriPanel controls → committed grade / comparison state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: packages/project/test/lumetri-grade.test.ts and scopes.test.ts own numerical math; panel cases own UI input dispatch.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/color-grade.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `hue/saturation curve tabs and the eyedropper add three points around the picked hue`

- B1 — Independent contract: S06 CGU-001…005; docs/wp-notes/color-grade.md.
- B2 — Recognizable failure: violating “hue/saturation curve tabs and the eyedropper add three points around the picked hue” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: LumetriPanel controls → committed grade / comparison state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: packages/project/test/lumetri-grade.test.ts and scopes.test.ts own numerical math; panel cases own UI input dispatch.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/color-grade.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `HSL Secondary Set Color keys the picked colour; Add widens it (one step each)`

- B1 — Independent contract: S06 CGU-001…005; docs/wp-notes/color-grade.md.
- B2 — Recognizable failure: violating “HSL Secondary Set Color keys the picked colour; Add widens it (one step each)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: LumetriPanel controls → committed grade / comparison state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: packages/project/test/lumetri-grade.test.ts and scopes.test.ts own numerical math; panel cases own UI input dispatch.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/color-grade.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `the vignette sliders and the 3-way correction wheels are in the panel`

Detectable failure: the vignette sliders and the 3-way correction wheels are in the panel. Reason: Control-presence inventory or wrapper result metadata delegated to project scope math; retained panel interactions and project scopes numerical tests provide meaningful coverage. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `Apply Match needs the Comparison View; the button opens it with a reference`

- B1 — Independent contract: S06 CGU-001…005; docs/wp-notes/color-grade.md.
- B2 — Recognizable failure: violating “Apply Match needs the Comparison View; the button opens it with a reference” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: LumetriPanel controls → committed grade / comparison state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: packages/project/test/lumetri-grade.test.ts and scopes.test.ts own numerical math; panel cases own UI input dispatch.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/color-grade.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `computes every scope of a four-up layout in one pass`

Detectable failure: computes every scope of a four-up layout in one pass. Reason: Control-presence inventory or wrapper result metadata delegated to project scope math; retained panel interactions and project scopes numerical tests provide meaningful coverage. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `unclamped waveforms span −10 … 110 %`

Detectable failure: unclamped waveforms span −10 … 110 %. Reason: Control-presence inventory or wrapper result metadata delegated to project scope math; retained panel interactions and project scopes numerical tests provide meaningful coverage. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

## apps/web/test/desktop-folder-picker.test.tsx

Owner/non-test callers: MediaCachePage.tsx and mg-bundles/ImportDialog.tsx; preferences/import dialog hosts. Remaining coverage: Desktop IPC tests own dialog transport; only these dialogs own pending controls, cancellation preservation and stale cache-check invalidation.

### REWRITE: `disables the form while choosing and writes the selected path`

- B1 — Independent contract: AGENTS §0 visible async errors and work preservation; desktop folder selection API.
- B2 — Recognizable failure: violating “disables the form while choosing and writes the selected path” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: cache/import dialog controls and input state after DesktopBridge outcomes.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Desktop IPC tests own dialog transport; only these dialogs own pending controls, cancellation preservation and stale cache-check invalidation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/desktop-folder-picker.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `preserves the typed path when the dialog is cancelled`

- B1 — Independent contract: AGENTS §0 visible async errors and work preservation; desktop folder selection API.
- B2 — Recognizable failure: violating “preserves the typed path when the dialog is cancelled” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: cache/import dialog controls and input state after DesktopBridge outcomes.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Desktop IPC tests own dialog transport; only these dialogs own pending controls, cancellation preservation and stale cache-check invalidation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/desktop-folder-picker.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `reports dialog errors, preserves the path, and allows retrying`

- B1 — Independent contract: AGENTS §0 visible async errors and work preservation; desktop folder selection API.
- B2 — Recognizable failure: violating “reports dialog errors, preserves the path, and allows retrying” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: cache/import dialog controls and input state after DesktopBridge outcomes.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Desktop IPC tests own dialog transport; only these dialogs own pending controls, cancellation preservation and stale cache-check invalidation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/desktop-folder-picker.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `keeps path entry available without a desktop bridge`

- B1 — Independent contract: AGENTS §0 visible async errors and work preservation; desktop folder selection API.
- B2 — Recognizable failure: violating “keeps path entry available without a desktop bridge” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: cache/import dialog controls and input state after DesktopBridge outcomes.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Desktop IPC tests own dialog transport; only these dialogs own pending controls, cancellation preservation and stale cache-check invalidation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/desktop-folder-picker.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `keeps a cache location check on cancellation and invalidates it after a selection`

- B1 — Independent contract: AGENTS §0 visible async errors and work preservation; desktop folder selection API.
- B2 — Recognizable failure: violating “keeps a cache location check on cancellation and invalidates it after a selection” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: cache/import dialog controls and input state after DesktopBridge outcomes.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Desktop IPC tests own dialog transport; only these dialogs own pending controls, cancellation preservation and stale cache-check invalidation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/desktop-folder-picker.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/edit-ux-keyboard.test.tsx

Owner/non-test callers: keymap/store.ts and dispatcher.ts; shell keyboard host and shortcut preferences. Remaining coverage: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.

### KEEP: `${l.label} has no conflicting chords (${platform}/${runtime})`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “${l.label} has no conflicting chords (${platform}/${runtime})” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `every layout binds only registered commands`

Detectable failure: every layout binds only registered commands. Reason: Registration inventory permits every default missing binding, or asserts preset declarations against themselves; actual preset resolution/persistence test and KB-011 config-conflict family remain. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `Final Cut Pro 7 puts Insert/Overwrite on F9/F10 and trims on [ ]`

Detectable failure: Final Cut Pro 7 puts Insert/Overwrite on F9/F10 and trims on [ ]. Reason: Registration inventory permits every default missing binding, or asserts preset declarations against themselves; actual preset resolution/persistence test and KB-011 config-conflict family remain. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `switching layouts changes resolution; edits make a "Custom" layout that persists`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “switching layouts changes resolution; edits make a "Custom" layout that persists” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `assigning a used chord takes it from the other command in that scope; shadows are reported`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “assigning a used chord takes it from the other command in that scope; shadows are reported” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `remove / clear / reset a command; custom layouts can be saved and deleted`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “remove / clear / reset a command; custom layouts can be saved and deleted” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `mac chords keep the exact chord; browser-reserved chords are refused in the web app`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “mac chords keep the exact chord; browser-reserved chords are refused in the web app” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `malformed stored prefs fall back safely`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “malformed stored prefs fall back safely” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `contextual chords: Ctrl+Alt+← slips without edit points (the trim binding is disabled)`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “contextual chords: Ctrl+Alt+← slips without edit points (the trim binding is disabled)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `spring-loaded tools: a held key returns to the previous tool on release, a tap switches`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “spring-loaded tools: a held key returns to the previous tool on release, a tap switches” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `searches, captures a new chord and reports the takeover`

- B1 — Independent contract: S05 KB-001/011; docs/wp-notes/edit-ux.md shortcut customization.
- B2 — Recognizable failure: violating “searches, captures a new chord and reports the takeover” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: keymap configuration/store and dispatcher public operations; KeyboardShortcutsDialog.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Other keyboard tests own basic chord dispatch; these cases own layout conflict checks, custom preference persistence, contextual conflicts and held-tool restoration.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/edit-ux-keyboard.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/effect-controls-graph-ui.test.tsx

Owner/non-test callers: EffectControlsPanel.tsx → GraphEditor.tsx. Remaining coverage: Model keyframe tests own ease evaluation; numeric velocity tests own graph values; UI owns gestures, cancellation, selection and persisted graph visibility.

### REWRITE: `the twirl opens the Value and Velocity graphs with min/max labels; the state persists`

- B1 — Independent contract: S03 KF-022/PRP-023; S05 ECP-006.
- B2 — Recognizable failure: violating “the twirl opens the Value and Velocity graphs with min/max labels; the state persists” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: EffectControlsPanel pointer/key controls → committed keyframes, transient state and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model keyframe tests own ease evaluation; numeric velocity tests own graph values; UI owns gestures, cancellation, selection and persisted graph visibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph-ui.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `dragging a value-graph key vertically changes its value as one undo entry, previewed live`

- B1 — Independent contract: S03 KF-022/PRP-023; S05 ECP-006.
- B2 — Recognizable failure: violating “dragging a value-graph key vertically changes its value as one undo entry, previewed live” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: EffectControlsPanel pointer/key controls → committed keyframes, transient state and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model keyframe tests own ease evaluation; numeric velocity tests own graph values; UI owns gestures, cancellation, selection and persisted graph visibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph-ui.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `dragging a key horizontally moves it in time (whole frames, Shift = no snap); Esc cancels`

- B1 — Independent contract: S03 KF-022/PRP-023; S05 ECP-006.
- B2 — Recognizable failure: violating “dragging a key horizontally moves it in time (whole frames, Shift = no snap); Esc cancels” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: EffectControlsPanel pointer/key controls → committed keyframes, transient state and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model keyframe tests own ease evaluation; numeric velocity tests own graph values; UI owns gestures, cancellation, selection and persisted graph visibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph-ui.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `velocity handles: vertical = speed, horizontal = influence; a Linear key becomes Bezier`

- B1 — Independent contract: S03 KF-022/PRP-023; S05 ECP-006.
- B2 — Recognizable failure: violating “velocity handles: vertical = speed, horizontal = influence; a Linear key becomes Bezier” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: EffectControlsPanel pointer/key controls → committed keyframes, transient state and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model keyframe tests own ease evaluation; numeric velocity tests own graph values; UI owns gestures, cancellation, selection and persisted graph visibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph-ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Continuous Bezier keeps in/out speeds linked; Alt-drag breaks the link into Bezier`

- B1 — Independent contract: S03 KF-022/PRP-023; S05 ECP-006.
- B2 — Recognizable failure: violating “Continuous Bezier keeps in/out speeds linked; Alt-drag breaks the link into Bezier” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: EffectControlsPanel pointer/key controls → committed keyframes, transient state and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model keyframe tests own ease evaluation; numeric velocity tests own graph values; UI owns gestures, cancellation, selection and persisted graph visibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph-ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `value-graph Bezier handles edit the ease; graph keys share selection and the context menu`

- B1 — Independent contract: S03 KF-022/PRP-023; S05 ECP-006.
- B2 — Recognizable failure: violating “value-graph Bezier handles edit the ease; graph keys share selection and the context menu” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: EffectControlsPanel pointer/key controls → committed keyframes, transient state and undo.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Model keyframe tests own ease evaluation; numeric velocity tests own graph values; UI owns gestures, cancellation, selection and persisted graph visibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph-ui.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `the graph height is resizable`

Detectable failure: the graph height is resizable. Reason: Exact resized graph height is appearance change detection; no document or caller-visible editing contract. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

## apps/web/test/effect-controls-graph.test.ts

Owner/non-test callers: graph.ts; GraphEditor.tsx samples graph values. Remaining coverage: Project keyframe/ease tests own evaluate(); UI graph tests own edits. Four retained tests alone check displayed velocity in units/s, signed reverse speed and hold-zero values.

### DELETE: `matches the lanes (exactFrameOf) on normal, sped-up and reversed clips, and inverts`

Detectable failure: matches the lanes (exactFrameOf) on normal, sped-up and reversed clips, and inverts. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `graphs only continuous numbers and vec2`

Detectable failure: graphs only continuous numbers and vec2. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `samples the shared evaluator (every point equals evaluate at its time), sorted by x`

Detectable failure: samples the shared evaluator (every point equals evaluate at its time), sorted by x. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `vec2 gives one curve per dimension; holds are vertical steps; clamp options apply`

Detectable failure: vec2 gives one curve per dimension; holds are vertical steps; clamp options apply. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### REWRITE: `is the derivative of evaluate in units per second: constant on linear segments, zero outside`

- B1 — Independent contract: S03 KF-022 velocity graph; docs/wp-notes/graph-editor.md Units and conversions.
- B2 — Recognizable failure: violating “is the derivative of evaluate in units per second: constant on linear segments, zero outside” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: sampleVelocityCurve input/output numeric boundary used by GraphEditor.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project keyframe/ease tests own evaluate(); UI graph tests own edits. Four retained tests alone check displayed velocity in units/s, signed reverse speed and hold-zero values.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph.test.ts --maxWorkers=1` and web typecheck.

### REWRITE: `eases to zero speed at an Ease Out key and steps at keys with different in/out speeds`

- B1 — Independent contract: S03 KF-022 velocity graph; docs/wp-notes/graph-editor.md Units and conversions.
- B2 — Recognizable failure: violating “eases to zero speed at an Ease Out key and steps at keys with different in/out speeds” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: sampleVelocityCurve input/output numeric boundary used by GraphEditor.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project keyframe/ease tests own evaluate(); UI graph tests own edits. Four retained tests alone check displayed velocity in units/s, signed reverse speed and hold-zero values.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `vec2 velocity is the speed along the path; reversed clips flip the sign of numbers`

- B1 — Independent contract: S03 KF-022 velocity graph; docs/wp-notes/graph-editor.md Units and conversions.
- B2 — Recognizable failure: violating “vec2 velocity is the speed along the path; reversed clips flip the sign of numbers” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: sampleVelocityCurve input/output numeric boundary used by GraphEditor.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project keyframe/ease tests own evaluate(); UI graph tests own edits. Four retained tests alone check displayed velocity in units/s, signed reverse speed and hold-zero values.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph.test.ts --maxWorkers=1` and web typecheck.

### REWRITE: `holds have zero velocity`

- B1 — Independent contract: S03 KF-022 velocity graph; docs/wp-notes/graph-editor.md Units and conversions.
- B2 — Recognizable failure: violating “holds have zero velocity” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: sampleVelocityCurve input/output numeric boundary used by GraphEditor.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project keyframe/ease tests own evaluate(); UI graph tests own edits. Four retained tests alone check displayed velocity in units/s, signed reverse speed and hold-zero values.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls-graph.test.ts --maxWorkers=1` and web typecheck.

### DELETE: `unit velocity is the linear-equivalent speed of the segment, measured from evaluate`

Detectable failure: unit velocity is the linear-equivalent speed of the segment, measured from evaluate. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `handles sit on the sampled velocity curve at the key and their tips mark the influence`

Detectable failure: handles sit on the sampled velocity curve at the key and their tips mark the influence. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `a segment leaving a Linear key reads as linear on the arriving side`

Detectable failure: a segment leaving a Linear key reads as linear on the arriving side. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `drag → ease inverts the handle and clamps influence to 0.01..1; the slope may go negative`

Detectable failure: drag → ease inverts the handle and clamps influence to 0.01..1; the slope may go negative. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `are the cubic control points in value space and invert on drag`

Detectable failure: are the cubic control points in value space and invert on drag. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `Linear and Auto Bezier keys convert to Bezier with the untouched side frozen`

Detectable failure: Linear and Auto Bezier keys convert to Bezier with the untouched side frozen. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `Continuous Bezier stays linked (one side sent) unless Alt breaks it into Bezier`

Detectable failure: Continuous Bezier stays linked (one side sent) unless Alt breaks it into Bezier. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `an arriving handle after a Linear key converts that key for non-Bezier targets; holds keep holding`

Detectable failure: an arriving handle after a Linear key converts that key for non-Bezier targets; holds keep holding. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `applied through the real handlers, the new speed is what the evaluator produces`

Detectable failure: applied through the real handlers, the new speed is what the evaluator produces. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `fits with headroom, can include zero, and widens flat curves`

Detectable failure: fits with headroom, can include zero, and widens flat curves. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `a negative slope makes the value move away first; a steep one passes the next key`

Detectable failure: a negative slope makes the value move away first; a steep one passes the next key. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `sit on each component curve, tangent at the key, and invert on drag`

Detectable failure: sit on each component curve, tangent at the key, and invert on drag. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `a component that does not change only edits the influence`

Detectable failure: a component that does not change only edits the influence. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `zooms about a value and pans`

Detectable failure: zooms about a value and pans. Reason: Private graph mapping/handle shape, redundant evaluator expectation, or plan-command shape. Real graph edits survive in effect-controls-graph-ui; independently computed velocity values survive in this file. Exact geometry is not a visual-regression oracle. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

## apps/web/test/effect-controls.test.tsx

Owner/non-test callers: EffectControlsPanel.tsx mounted by panel registry. Remaining coverage: Project commands own transactions; this seam owns stopwatch confirmation, playhead mapping, drop routing, unknown-effect removal and loop controls.

### KEEP: `the stopwatch creates a key at the playhead content time; a later value makes a ramp resolved at the playhead`

- B1 — Independent contract: S03 §13 KF/EC; S05 ECP; S01 FX-022.
- B2 — Recognizable failure: violating “the stopwatch creates a key at the playhead content time; a later value makes a ramp resolved at the playhead” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: EffectControlsPanel controls → session keyframes/effects/transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project commands own transactions; this seam owns stopwatch confirmation, playhead mapping, drop routing, unknown-effect removal and loop controls.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `turning the stopwatch off asks first and keeps the value at the playhead`

- B1 — Independent contract: S03 §13 KF/EC; S05 ECP; S01 FX-022.
- B2 — Recognizable failure: violating “turning the stopwatch off asks first and keeps the value at the playhead” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: EffectControlsPanel controls → session keyframes/effects/transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project commands own transactions; this seam owns stopwatch confirmation, playhead mapping, drop routing, unknown-effect removal and loop controls.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `right-click interpolation menu eases a key and changes its glyph; drag moves keys by whole frames`

- B1 — Independent contract: S03 §13 KF/EC; S05 ECP; S01 FX-022.
- B2 — Recognizable failure: violating “right-click interpolation menu eases a key and changes its glyph; drag moves keys by whole frames” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: EffectControlsPanel controls → session keyframes/effects/transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project commands own transactions; this seam owns stopwatch confirmation, playhead mapping, drop routing, unknown-effect removal and loop controls.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `shows applied effects with bypass/remove and accepts drops from the Effects panel`

- B1 — Independent contract: S03 §13 KF/EC; S05 ECP; S01 FX-022.
- B2 — Recognizable failure: violating “shows applied effects with bypass/remove and accepts drops from the Effects panel” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: EffectControlsPanel controls → session keyframes/effects/transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project commands own transactions; this seam owns stopwatch confirmation, playhead mapping, drop routing, unknown-effect removal and loop controls.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `shows "Missing effect: <id>" and still allows removing it`

- B1 — Independent contract: S03 §13 KF/EC; S05 ECP; S01 FX-022.
- B2 — Recognizable failure: violating “shows "Missing effect: <id>" and still allows removing it” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: EffectControlsPanel controls → session keyframes/effects/transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project commands own transactions; this seam owns stopwatch confirmation, playhead mapping, drop routing, unknown-effect removal and loop controls.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `the footer Loop button reflects the transport loop state`

- B1 — Independent contract: S03 §13 KF/EC; S05 ECP; S01 FX-022.
- B2 — Recognizable failure: violating “the footer Loop button reflects the transport loop state” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: EffectControlsPanel controls → session keyframes/effects/transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project commands own transactions; this seam owns stopwatch confirmation, playhead mapping, drop routing, unknown-effect removal and loop controls.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/effect-controls.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/fx-panel.test.ts

Owner/non-test callers: effects/drag.ts; EffectsPanel.tsx. Remaining coverage: history-effects.test.tsx owns rendered text search/application; retained GPU/bin-name filtering covers a distinct query mode. Overlay interactions and project transforms own coordinate behavior.

### DELETE: `shows an effect with a bin under Video Effects ▸ <bin>, categories otherwise`

Detectable failure: shows an effect with a bin under Video Effects ▸ <bin>, categories otherwise. Reason: Private tree shape or affine coordinate helper restatement; actual search/filter/apply and point-drag interactions remain. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `the GPU filter keeps only shader effects; search matches the bin name`

- B1 — Independent contract: S05 EFX-001 search/filter contract.
- B2 — Recognizable failure: violating “the GPU filter keeps only shader effects; search matches the bin name” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: effectTree registry/filter input → effect ids.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: history-effects.test.tsx owns rendered text search/application; retained GPU/bin-name filtering covers a distinct query mode. Overlay interactions and project transforms own coordinate behavior.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/fx-panel.test.ts --maxWorkers=1` and web typecheck.

### DELETE: `finds point params and maps them through the layer map and back`

Detectable failure: finds point params and maps them through the layer map and back. Reason: Private tree shape or affine coordinate helper restatement; actual search/filter/apply and point-drag interactions remain. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

## apps/web/test/gaps-preferences.test.tsx

Owner/non-test callers: gaps/app-prefs.ts and startup.ts; preference pages and runtime/save.ts. Remaining coverage: session persistence tests own autosaving; these cases own settings-to-consumer mapping and invalid stored-field repair.

### DELETE: `registers Premiere’s pages that apply here (no Collaboration, no Sync Settings)`

Detectable failure: registers Premiere’s pages that apply here (no Collaboration, no Sync Settings). Reason: Page-registration/render-presence inventory; preference editing, consumer mapping and corrupt storage remain covered. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `every page renders inside the Preferences dialog`

Detectable failure: every page renders inside the Preferences dialog. Reason: Page-registration/render-presence inventory; preference editing, consumer mapping and corrupt storage remain covered. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `Playback and Trim values drive the commands; Auto Save drives the policy`

- B1 — Independent contract: S05 Preferences; AGENTS §0 hostile preference validation.
- B2 — Recognizable failure: violating “Playback and Trim values drive the commands; Auto Save drives the policy” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: preferences dialog/store → trim/autosave policy, label lookup and reduced-motion state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: session persistence tests own autosaving; these cases own settings-to-consumer mapping and invalid stored-field repair.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/gaps-preferences.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `labels: names and defaults; reduced motion attribute`

- B1 — Independent contract: S05 Preferences; AGENTS §0 hostile preference validation.
- B2 — Recognizable failure: violating “labels: names and defaults; reduced motion attribute” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: preferences dialog/store → trim/autosave policy, label lookup and reduced-motion state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: session persistence tests own autosaving; these cases own settings-to-consumer mapping and invalid stored-field repair.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/gaps-preferences.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `parses hostile storage values to the defaults`

- B1 — Independent contract: S05 Preferences; AGENTS §0 hostile preference validation.
- B2 — Recognizable failure: violating “parses hostile storage values to the defaults” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: preferences dialog/store → trim/autosave policy, label lookup and reduced-motion state.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: session persistence tests own autosaving; these cases own settings-to-consumer mapping and invalid stored-field repair.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/gaps-preferences.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/history-effects.test.tsx

Owner/non-test callers: history/HistoryPanel.tsx; effects/EffectsPanel.tsx and drag.ts; timeline/monitor/EC drop targets. Remaining coverage: Session tests own undo mechanics; UI owns history navigation/confirmation and multi-selection effect application. Byte-level drag protocol has no lower transport owner.

### REWRITE: `lists labelled entries with agent sparkle, jumps on click and clears with confirmation`

- B1 — Independent contract: S05 HIS-001…003/EFX-001…003; S01 UND-009; effect drag MIME protocol.
- B2 — Recognizable failure: violating “lists labelled entries with agent sparkle, jumps on click and clears with confirmation” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: HistoryPanel / EffectsPanel controls → document; DataTransfer bytes.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session tests own undo mechanics; UI owns history navigation/confirmation and multi-selection effect application. Byte-level drag protocol has no lower transport owner.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/history-effects.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `filters by search and applies by double-click to the selected clips as one undo step`

- B1 — Independent contract: S05 HIS-001…003/EFX-001…003; S01 UND-009; effect drag MIME protocol.
- B2 — Recognizable failure: violating “filters by search and applies by double-click to the selected clips as one undo step” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: HistoryPanel / EffectsPanel controls → document; DataTransfer bytes.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session tests own undo mechanics; UI owns history navigation/confirmation and multi-selection effect application. Byte-level drag protocol has no lower transport owner.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/history-effects.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `writes and reads the effect drag protocol`

- B1 — Independent contract: S05 HIS-001…003/EFX-001…003; S01 UND-009; effect drag MIME protocol.
- B2 — Recognizable failure: violating “writes and reads the effect drag protocol” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: HistoryPanel / EffectsPanel controls → document; DataTransfer bytes.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session tests own undo mechanics; UI owns history navigation/confirmation and multi-selection effect application. Byte-level drag protocol has no lower transport owner.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/history-effects.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/i18n.test.ts

Owner/non-test callers: i18n/transform.mjs, runtime.ts and scripts/i18n.mjs. Remaining coverage: pnpm i18n:check owns missing strings/placeholders; polish-i18n.test.tsx owns evaluated transformation and live runtime translation.

### DELETE: `Spanish covers every UI string and model name (run `pnpm i18n` after adding strings)`

Detectable failure: Spanish covers every UI string and model name (run `pnpm i18n` after adding strings). Reason: Catalog enumeration duplicates pnpm i18n:check; emitted-source shape and plain placeholder examples duplicate evaluated transform/runtime contracts in polish-i18n.test.tsx. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `model-strings.json lists the names the model shows (effects, parameters, transitions, commands)`

Detectable failure: model-strings.json lists the names the model shows (effects, parameters, transitions, commands). Reason: Catalog enumeration duplicates pnpm i18n:check; emitted-source shape and plain placeholder examples duplicate evaluated transform/runtime contracts in polish-i18n.test.tsx. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `the transform wraps UI text and leaves ids, classes and data alone`

Detectable failure: the transform wraps UI text and leaves ids, classes and data alone. Reason: Catalog enumeration duplicates pnpm i18n:check; emitted-source shape and plain placeholder examples duplicate evaluated transform/runtime contracts in polish-i18n.test.tsx. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `the runtime fills placeholders (English source text)`

Detectable failure: the runtime fills placeholders (English source text). Reason: Catalog enumeration duplicates pnpm i18n:check; emitted-source shape and plain placeholder examples duplicate evaluated transform/runtime contracts in polish-i18n.test.tsx. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

## apps/web/test/imports.test.tsx

Owner/non-test callers: imports/interpret-dialog.tsx, dialogs.tsx, import-flow.ts, import/media-runtime.ts; import manager/project lifecycle. Remaining coverage: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.

### REWRITE: `applies frame rate, pixel aspect, alpha and loop in one undoable step`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “applies frame rate, pixel aspect, alpha and loop in one undoable step” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `shows only the sections that apply, and later sections plug in with their own commands`

Detectable failure: shows only the sections that apply, and later sections plug in with their own commands. Reason: Section/command inventory with a fake extension returning the arranged command, or menu substring/registration inventory; real import dialogs and committed interpretation remain tested. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `parses typed frame rates`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “parses typed frame rates” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `is in the Clip ▸ Modify menu and needs footage selected`

Detectable failure: is in the Clip ▸ Modify menu and needs footage selected. Reason: Section/command inventory with a fake extension returning the arranged command, or menu substring/registration inventory; real import dialogs and committed interpretation remain tested. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### REWRITE: `Image Sequence returns the frame rate typed`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “Image Sequence returns the frame rate typed” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `Import Layered File lists layers top first and returns the chosen ones`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “Import Layered File lists layers top first and returns the chosen ones” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `PDF pages returns the ticked pages in order`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “PDF pages returns the ticked pages in order” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `expands PDF pages and PSD layers into one transaction`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “expands PDF pages and PSD layers into one transaction” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `requests the interpreted picture of a media and follows it to ready`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “requests the interpreted picture of a media and follows it to ready” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `asks again until the picture is ready (a missed ready event cannot leave it pending)`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “asks again until the picture is ready (a missed ready event cannot leave it pending)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `exports and lists what was not carried`

- B1 — Independent contract: S04 media import/interpretation; docs/wp-notes/imports.md; AGENTS §0 pending-job recovery.
- B2 — Recognizable failure: violating “exports and lists what was not carried” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Import/Interpret/Lottie dialogs and media-runtime sync → user choices, document and engine protocol.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project import tests own model representation; web owns user selection, parsed rate, extraction composition, ready-event and missed-event recovery.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/imports.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/licenses.test.tsx

Owner/non-test callers: shell/licenses.tsx; About/licenses dialog. Remaining coverage: Engine license tests own provenance; UI alone ensures the mandatory shipped text/source links and fallback warning remain accessible.

### KEEP: `shows the bundled FFmpeg license, its text and the source and build links`

- B1 — Independent contract: AGENTS §2 FFmpeg license/source/notice distribution.
- B2 — Recognizable failure: violating “shows the bundled FFmpeg license, its text and the source and build links” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ThirdPartyLicenses rendered license text and links for engine response/fallback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine license tests own provenance; UI alone ensures the mandatory shipped text/source links and fallback warning remain accessible.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/licenses.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `falls back to the static LGPL notice and shows the bundled-GPL capability warning`

- B1 — Independent contract: AGENTS §2 FFmpeg license/source/notice distribution.
- B2 — Recognizable failure: violating “falls back to the static LGPL notice and shows the bundled-GPL capability warning” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ThirdPartyLicenses rendered license text and links for engine response/fallback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine license tests own provenance; UI alone ensures the mandatory shipped text/source links and fallback warning remain accessible.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/licenses.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/motion-path.test.tsx

Owner/non-test callers: program/TransformOverlay.tsx, effectControls/EffectControlsPanel.tsx; Program monitor. Remaining coverage: Project spatial-key tests own interpolation math; UI alone owns hit dispatch, Alt modifier, locked-track refusal and menu eligibility.

### DELETE: `draws one dot per clip frame, key squares and the Auto Bezier tangent handles, under zoom and pan`

Detectable failure: draws one dot per clip frame, key squares and the Auto Bezier tangent handles, under zoom and pan. Reason: Exact SVG count/coordinates/widths are appearance change detection, not pixel regression; key/tangent gestures and locked-track refusal remain. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `is not drawn below two position keys`

- B1 — Independent contract: S03 OVL-020/KF-021.
- B2 — Recognizable failure: violating “is not drawn below two position keys” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: TransformOverlay and EffectControls context-menu interactions → committed spatial keys.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project spatial-key tests own interpolation math; UI alone owns hit dispatch, Alt modifier, locked-track refusal and menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/motion-path.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `dragging a key square edits that key (one undo entry) and selects it`

- B1 — Independent contract: S03 OVL-020/KF-021.
- B2 — Recognizable failure: violating “dragging a key square edits that key (one undo entry) and selects it” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: TransformOverlay and EffectControls context-menu interactions → committed spatial keys.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project spatial-key tests own interpolation math; UI alone owns hit dispatch, Alt modifier, locked-track refusal and menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/motion-path.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `dragging a tangent keeps it continuous; Alt-drag breaks continuity; one undo entry per drag`

- B1 — Independent contract: S03 OVL-020/KF-021.
- B2 — Recognizable failure: violating “dragging a tangent keeps it continuous; Alt-drag breaks continuity; one undo entry per drag” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: TransformOverlay and EffectControls context-menu interactions → committed spatial keys.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project spatial-key tests own interpolation math; UI alone owns hit dispatch, Alt modifier, locked-track refusal and menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/motion-path.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `keys on a locked track are drawn but not draggable`

- B1 — Independent contract: S03 OVL-020/KF-021.
- B2 — Recognizable failure: violating “keys on a locked track are drawn but not draggable” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: TransformOverlay and EffectControls context-menu interactions → committed spatial keys.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project spatial-key tests own interpolation math; UI alone owns hit dispatch, Alt modifier, locked-track refusal and menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/motion-path.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `sets the spatial interpolation of position keys from the key context menu`

- B1 — Independent contract: S03 OVL-020/KF-021.
- B2 — Recognizable failure: violating “sets the spatial interpolation of position keys from the key context menu” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: TransformOverlay and EffectControls context-menu interactions → committed spatial keys.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project spatial-key tests own interpolation math; UI alone owns hit dispatch, Alt modifier, locked-track refusal and menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/motion-path.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `is not offered for keys of non-point properties`

- B1 — Independent contract: S03 OVL-020/KF-021.
- B2 — Recognizable failure: violating “is not offered for keys of non-point properties” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: TransformOverlay and EffectControls context-menu interactions → committed spatial keys.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project spatial-key tests own interpolation math; UI alone owns hit dispatch, Alt modifier, locked-track refusal and menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/motion-path.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/polish-menu-wiring.test.ts

Owner/non-test callers: shell/menus/model.ts; Menubar and palette; commands registry. Remaining coverage: timeline-commands.test.ts, registry.test.tsx and shell-render.test.tsx exercise actual dispatch; inventories alone cannot establish command behavior.

### DELETE: `every menubar entry resolves to a registered command`

Detectable failure: every menubar entry resolves to a registered command. Reason: Declaration-to-declaration inventory/count check. Registered does not mean actionable; actual command/interaction owners remain and test IDs survive identifier-only internal refactors. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `runtime-limited entries are wired too (hidden elsewhere, never dead)`

Detectable failure: runtime-limited entries are wired too (hidden elsewhere, never dead). Reason: Declaration-to-declaration inventory/count check. Registered does not mean actionable; actual command/interaction owners remain and test IDs survive identifier-only internal refactors. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `the Workspaces menu, panel menus and panel openers resolve to registered commands`

Detectable failure: the Workspaces menu, panel menus and panel openers resolve to registered commands. Reason: Declaration-to-declaration inventory/count check. Registered does not mean actionable; actual command/interaction owners remain and test IDs survive identifier-only internal refactors. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `every default key binding resolves to a registered command`

Detectable failure: every default key binding resolves to a registered command. Reason: Declaration-to-declaration inventory/count check. Registered does not mean actionable; actual command/interaction owners remain and test IDs survive identifier-only internal refactors. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

## apps/web/test/polish-open.test.tsx

Owner/non-test callers: editor-boot.ts used by vite.config.ts; media-runtime lifecycle; state/engine.tsx. Remaining coverage: Engine owns batch protocol; web owns fallback/status mapping. Built bundle loading and scripts/perf/ui-run.ts own actual preload/open performance; DOM boot tests own recovery branches without full app replay.

### REWRITE: `asks for every status in batches and updates the store once per answer`

- B1 — Independent contract: ARCHITECTURE §8; docs/wp-notes/polish.md §5/7 boot-recovery regression; AGENTS §0.
- B2 — Recognizable failure: violating “asks for every status in batches and updates the store once per answer” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: media-runtime state and emitted HTTP; generated boot script executed in a DOM; early fetch wrapper.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine owns batch protocol; web owns fallback/status mapping. Built bundle loading and scripts/perf/ui-run.ts own actual preload/open performance; DOM boot tests own recovery branches without full app replay.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/polish-open.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `falls back to one request per medium on an engine without the batch route`

- B1 — Independent contract: ARCHITECTURE §8; docs/wp-notes/polish.md §5/7 boot-recovery regression; AGENTS §0.
- B2 — Recognizable failure: violating “falls back to one request per medium on an engine without the batch route” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: media-runtime state and emitted HTTP; generated boot script executed in a DOM; early fetch wrapper.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine owns batch protocol; web owns fallback/status mapping. Built bundle loading and scripts/perf/ui-run.ts own actual preload/open performance; DOM boot tests own recovery branches without full app replay.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/polish-open.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `marks every medium as needing the engine when it cannot be reached`

- B1 — Independent contract: ARCHITECTURE §8; docs/wp-notes/polish.md §5/7 boot-recovery regression; AGENTS §0.
- B2 — Recognizable failure: violating “marks every medium as needing the engine when it cannot be reached” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: media-runtime state and emitted HTTP; generated boot script executed in a DOM; early fetch wrapper.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine owns batch protocol; web owns fallback/status mapping. Built bundle loading and scripts/perf/ui-run.ts own actual preload/open performance; DOM boot tests own recovery branches without full app replay.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/polish-open.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `lists the shell, the panel bodies and what they import — not the entry’s own chunks or other lazy code`

Detectable failure: lists the shell, the panel bodies and what they import — not the entry’s own chunks or other lazy code. Reason: Private build graph/component-name inventory; runtime script behavior and actual built bundle loading/performance remain owned by runtime/E2E tests. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `on an editor URL preloads the chunks and starts fetching the project; elsewhere it does nothing`

- B1 — Independent contract: ARCHITECTURE §8; docs/wp-notes/polish.md §5/7 boot-recovery regression; AGENTS §0.
- B2 — Recognizable failure: violating “on an editor URL preloads the chunks and starts fetching the project; elsewhere it does nothing” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: media-runtime state and emitted HTTP; generated boot script executed in a DOM; early fetch wrapper.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine owns batch protocol; web owns fallback/status mapping. Built bundle loading and scripts/perf/ui-run.ts own actual preload/open performance; DOM boot tests own recovery branches without full app replay.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/polish-open.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `says so when the bundle cannot be downloaded, instead of a blank page`

- B1 — Independent contract: ARCHITECTURE §8; docs/wp-notes/polish.md §5/7 boot-recovery regression; AGENTS §0.
- B2 — Recognizable failure: violating “says so when the bundle cannot be downloaded, instead of a blank page” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: media-runtime state and emitted HTTP; generated boot script executed in a DOM; early fetch wrapper.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine owns batch protocol; web owns fallback/status mapping. Built bundle loading and scripts/perf/ui-run.ts own actual preload/open performance; DOM boot tests own recovery branches without full app replay.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/polish-open.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `reloads by itself first: fast failures have a small budget, slow cut-off loads a larger one, a boot resets it`

- B1 — Independent contract: ARCHITECTURE §8; docs/wp-notes/polish.md §5/7 boot-recovery regression; AGENTS §0.
- B2 — Recognizable failure: violating “reloads by itself first: fast failures have a small budget, slow cut-off loads a larger one, a boot resets it” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: media-runtime state and emitted HTTP; generated boot script executed in a DOM; early fetch wrapper.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine owns batch protocol; web owns fallback/status mapping. Built bundle loading and scripts/perf/ui-run.ts own actual preload/open performance; DOM boot tests own recovery branches without full app replay.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/polish-open.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `the engine client takes the early answer once, for exactly that GET, and asks again when it failed`

- B1 — Independent contract: ARCHITECTURE §8; docs/wp-notes/polish.md §5/7 boot-recovery regression; AGENTS §0.
- B2 — Recognizable failure: violating “the engine client takes the early answer once, for exactly that GET, and asks again when it failed” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: media-runtime state and emitted HTTP; generated boot script executed in a DOM; early fetch wrapper.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine owns batch protocol; web owns fallback/status mapping. Built bundle loading and scripts/perf/ui-run.ts own actual preload/open performance; DOM boot tests own recovery branches without full app replay.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/polish-open.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/program-monitor.test.tsx

Owner/non-test callers: program/ProgramMonitor.tsx, TransformOverlay.tsx, render-doc.ts. Remaining coverage: timeline-commands.test.ts owns range edits; other retained tests own monitor input/undo/cancel and renderer media URL/rotation/last-frame contracts.

### DELETE: `marks, navigates and edits a range through the registered timeline commands`

Detectable failure: marks, navigates and edits a range through the registered timeline commands. Reason: Replays mark/lift/extract command arithmetic already proved at the lower command seam in timeline-commands.test.ts; monitor-specific transform and transport readout remain. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `shows the active sequence timecode and duration`

- B1 — Independent contract: S03 PGM-001/XF-060/AC-XF-3; ARCHITECTURE §8.
- B2 — Recognizable failure: violating “shows the active sequence timecode and duration” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProgramMonitor live readout / TransformOverlay gestures / render-doc media and duration boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: timeline-commands.test.ts owns range edits; other retained tests own monitor input/undo/cancel and renderer media URL/rotation/last-frame contracts.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/program-monitor.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `makes one undo step per move / rotate drag and undo restores the exact values (AC-XF-3)`

- B1 — Independent contract: S03 PGM-001/XF-060/AC-XF-3; ARCHITECTURE §8.
- B2 — Recognizable failure: violating “makes one undo step per move / rotate drag and undo restores the exact values (AC-XF-3)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProgramMonitor live readout / TransformOverlay gestures / render-doc media and duration boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: timeline-commands.test.ts owns range edits; other retained tests own monitor input/undo/cancel and renderer media URL/rotation/last-frame contracts.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/program-monitor.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Esc cancels a drag without a history entry`

- B1 — Independent contract: S03 PGM-001/XF-060/AC-XF-3; ARCHITECTURE §8.
- B2 — Recognizable failure: violating “Esc cancels a drag without a history entry” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProgramMonitor live readout / TransformOverlay gestures / render-doc media and duration boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: timeline-commands.test.ts owns range edits; other retained tests own monitor input/undo/cancel and renderer media URL/rotation/last-frame contracts.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/program-monitor.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Type tool click creates a text clip at the playhead and selects it (XF-060)`

- B1 — Independent contract: S03 PGM-001/XF-060/AC-XF-3; ARCHITECTURE §8.
- B2 — Recognizable failure: violating “Type tool click creates a text clip at the playhead and selects it (XF-060)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProgramMonitor live readout / TransformOverlay gestures / render-doc media and duration boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: timeline-commands.test.ts owns range edits; other retained tests own monitor input/undo/cancel and renderer media URL/rotation/last-frame contracts.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/program-monitor.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `uses /media/<key>, the proxy when ready, upright size, offline → null`

- B1 — Independent contract: S03 PGM-001/XF-060/AC-XF-3; ARCHITECTURE §8.
- B2 — Recognizable failure: violating “uses /media/<key>, the proxy when ready, upright size, offline → null” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProgramMonitor live readout / TransformOverlay gestures / render-doc media and duration boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: timeline-commands.test.ts owns range edits; other retained tests own monitor input/undo/cancel and renderer media URL/rotation/last-frame contracts.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/program-monitor.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `sizes the Player to end + 1 frame, or 10 s when empty`

- B1 — Independent contract: S03 PGM-001/XF-060/AC-XF-3; ARCHITECTURE §8.
- B2 — Recognizable failure: violating “sizes the Player to end + 1 frame, or 10 s when empty” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProgramMonitor live readout / TransformOverlay gestures / render-doc media and duration boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: timeline-commands.test.ts owns range edits; other retained tests own monitor input/undo/cancel and renderer media URL/rotation/last-frame contracts.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/program-monitor.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/project-files.test.tsx

Owner/non-test callers: home/project-files.tsx, runtime/save.ts; ProjectLifecycle and File menu. Remaining coverage: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.

### KEEP: `Save As makes a new project with the current document and opens it; Save a Copy stays`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “Save As makes a new project with the current document and opens it; Save a Copy stays” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Revert discards unsaved changes and reloads the saved state in a new session`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “Revert discards unsaved changes and reloads the saved state in a new session” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `keeps the current document when saving before a version restore fails`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “keeps the current document when saving before a version restore fails” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `refuses to leave when a flush resolves with unsaved changes`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “refuses to leave when a flush resolves with unsaved changes” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `restores a version in place (keeping the current state) or opens it as a copy`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “restores a version in place (keeping the current state) or opens it as a copy” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `offers the dead session’s changes; Recover applies them as one undoable step`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “offers the dead session’s changes; Recover applies them as one undoable step” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `preserves the original recovery journal when the recovered document cannot be saved`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “preserves the original recovery journal when the recovered document cannot be saved” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `shows damaged-journal warnings while allowing a healthy session to be recovered`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “shows damaged-journal warnings while allowing a healthy session to be recovered” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `keeps a warnings-only recovery dialog visible without offering to discard damaged files`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “keeps a warnings-only recovery dialog visible without offering to discard damaged files” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Discard deletes the journal without touching the project`

- B1 — Independent contract: S01 PER-020/021 AC-18; AGENTS §0 preserve unsaved edits/journals.
- B2 — Recognizable failure: violating “Discard deletes the journal without touching the project” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: ProjectFileActions + recovery dialog → real MemoryProjectStore, session and navigation callback.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Session store tests own atomic persistence; web owns leave/restore sequencing, user recovery choice and retaining old journals until save succeeds.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/project-files.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/project-windowing.test.tsx

Owner/non-test callers: project/virtual.ts; ProjectPanel list/grid views. Remaining coverage: scripts/perf/ui-run.ts owns the large-project openMediaMs budget through pnpm perf --sections ui --ui open, with measureOpen trace/JSON artifacts; e2e1 confirmed the duplicate polish E2E row-count case is also removed. These unit copies use implementation thresholds and do not test eventual item accessibility.

### DELETE: `renders every row below the threshold`

Detectable failure: renders every row below the threshold. Reason: Pins implementation row thresholds/initial hook state and duplicates the real-browser large-project performance owner in scripts/perf/ui-run.ts. Does not establish that a user can reach all items; no such accessibility assertion is removed. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `renders a window of a large bin`

Detectable failure: renders a window of a large bin. Reason: Pins implementation row thresholds/initial hook state and duplicates the real-browser large-project performance owner in scripts/perf/ui-run.ts. Does not establish that a user can reach all items; no such accessibility assertion is removed. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `a large bin is windowed from its first render (no render of every row first)`

Detectable failure: a large bin is windowed from its first render (no render of every row first). Reason: Pins implementation row thresholds/initial hook state and duplicates the real-browser large-project performance owner in scripts/perf/ui-run.ts. Does not establish that a user can reach all items; no such accessibility assertion is removed. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

## apps/web/test/registry.test.tsx

Owner/non-test callers: commands/registry.ts used by menus/keymap/agents; state/panel-services.ts used by monitor/timeline. Remaining coverage: Concrete UI command suites cannot cover arbitrary throws/transforms/capabilities. Registry is lowest command-boundary seam; panel service tests own stale-unregister preservation.

### KEEP: `registers, evaluates and runs commands with capability gating and args validation`

- B1 — Independent contract: ARCHITECTURE §7.3; S05 SH-005; AGENTS §0 command error boundary.
- B2 — Recognizable failure: violating “registers, evaluates and runs commands with capability gating and args validation” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand results + error notification; PanelServices registration/lookup lifecycle.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Concrete UI command suites cannot cover arbitrary throws/transforms/capabilities. Registry is lowest command-boundary seam; panel service tests own stale-unregister preservation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/registry.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `reports a refused fullscreen request through the command error boundary`

- B1 — Independent contract: ARCHITECTURE §7.3; S05 SH-005; AGENTS §0 command error boundary.
- B2 — Recognizable failure: violating “reports a refused fullscreen request through the command error boundary” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: runCommand results + error notification; PanelServices registration/lookup lifecycle.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Concrete UI command suites cannot cover arbitrary throws/transforms/capabilities. Registry is lowest command-boundary seam; panel service tests own stale-unregister preservation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/registry.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `reports a failing pre-command hook without running the command`

- B1 — Independent contract: ARCHITECTURE §7.3; S05 SH-005; AGENTS §0 command error boundary.
- B2 — Recognizable failure: violating “reports a failing pre-command hook without running the command” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: runCommand results + error notification; PanelServices registration/lookup lifecycle.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Concrete UI command suites cannot cover arbitrary throws/transforms/capabilities. Registry is lowest command-boundary seam; panel service tests own stale-unregister preservation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/registry.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `reports a throwing argument transform without running the command`

- B1 — Independent contract: ARCHITECTURE §7.3; S05 SH-005; AGENTS §0 command error boundary.
- B2 — Recognizable failure: violating “reports a throwing argument transform without running the command” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: runCommand results + error notification; PanelServices registration/lookup lifecycle.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Concrete UI command suites cannot cover arbitrary throws/transforms/capabilities. Registry is lowest command-boundary seam; panel service tests own stale-unregister preservation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/registry.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `publishes services per instance and handles "not mounted"`

- B1 — Independent contract: ARCHITECTURE §7.3; S05 SH-005; AGENTS §0 command error boundary.
- B2 — Recognizable failure: violating “publishes services per instance and handles "not mounted"” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand results + error notification; PanelServices registration/lookup lifecycle.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Concrete UI command suites cannot cover arbitrary throws/transforms/capabilities. Registry is lowest command-boundary seam; panel service tests own stale-unregister preservation.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/registry.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/scene3d-overlay.test.tsx

Owner/non-test callers: three-d/Scene3DOverlay.tsx; ProgramMonitor extension host. Remaining coverage: Project 3D tests own camera scene math; this catches using the wrong/missing supplied document before user can select the actual camera.

### KEEP: `renders the active camera from the supplied 3D document`

- B1 — Independent contract: S03 3D active-camera selection; supplied render snapshot contract.
- B2 — Recognizable failure: violating “renders the active camera from the supplied 3D document” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Scene3DOverlay camera option computed from document.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project 3D tests own camera scene math; this catches using the wrong/missing supplied document before user can select the actual camera.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/scene3d-overlay.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/shell-render.test.tsx

Owner/non-test callers: App.tsx, EditorShell.tsx, prefs.ts, workspaces/store.ts; application root. Remaining coverage: Workspace store tests own parser; shell owns recovery toast hookup and live preference attributes. Mode/tab test owns header dispatch rather than command inventory.

### REWRITE: `AC-SH-4: a corrupt stored layout opens the default layout with exactly one warning toast`

- B1 — Independent contract: S05 AC-SH-4/AC-DT-1/2; mode/workspace/palette shell contracts.
- B2 — Recognizable failure: violating “AC-SH-4: a corrupt stored layout opens the default layout with exactly one warning toast” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: mounted AppRoutes → workspace, theme preferences, mode and palette UI.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Workspace store tests own parser; shell owns recovery toast hookup and live preference attributes. Mode/tab test owns header dispatch rather than command inventory.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/shell-render.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `AC-DT-1/2: theme and contrast switch via data attributes without reload`

- B1 — Independent contract: S05 AC-SH-4/AC-DT-1/2; mode/workspace/palette shell contracts.
- B2 — Recognizable failure: violating “AC-DT-1/2: theme and contrast switch via data attributes without reload” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: mounted AppRoutes → workspace, theme preferences, mode and palette UI.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Workspace store tests own parser; shell owns recovery toast hookup and live preference attributes. Mode/tab test owns header dispatch rather than command inventory.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/shell-render.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `header: mode tabs, workspace tabs and the palette button work through commands`

- B1 — Independent contract: S05 AC-SH-4/AC-DT-1/2; mode/workspace/palette shell contracts.
- B2 — Recognizable failure: violating “header: mode tabs, workspace tabs and the palette button work through commands” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: mounted AppRoutes → workspace, theme preferences, mode and palette UI.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Workspace store tests own parser; shell owns recovery toast hookup and live preference attributes. Mode/tab test owns header dispatch rather than command inventory.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/shell-render.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/text-animation.test.tsx

Owner/non-test callers: text-animation/actions.ts, TextAnimationsTab.tsx, TextAnimationSection.tsx; timeline/program drops and EC host. Remaining coverage: Project text-animation tests own windows/evaluator; web owns selection defaults/explicit targets, panel input and compressed-edge pointer conversion.

### KEEP: `chooses In or Out from the drop position`

- B1 — Independent contract: S11 TXA-020…024.
- B2 — Recognizable failure: violating “chooses In or Out from the drop position” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: animation commands and tabs/sections → persisted textAnimation; drop side policy.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project text-animation tests own windows/evaluator; web owns selection defaults/explicit targets, panel input and compressed-edge pointer conversion.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/text-animation.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `text.applyAnimation / text.removeAnimation are agent-exposed and act on the selection by default`

- B1 — Independent contract: S11 TXA-020…024.
- B2 — Recognizable failure: violating “text.applyAnimation / text.removeAnimation are agent-exposed and act on the selection by default” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: animation commands and tabs/sections → persisted textAnimation; drop side policy.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project text-animation tests own windows/evaluator; web owns selection defaults/explicit targets, panel input and compressed-edge pointer conversion.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/text-animation.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `filters presets and applies the selected animation by double-click or Enter`

- B1 — Independent contract: S11 TXA-020…024.
- B2 — Recognizable failure: violating “filters presets and applies the selected animation by double-click or Enter” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: animation commands and tabs/sections → persisted textAnimation; drop side policy.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project text-animation tests own windows/evaluator; web owns selection defaults/explicit targets, panel input and compressed-edge pointer conversion.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/text-animation.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `picks presets, edits duration and params for all selected text clips`

- B1 — Independent contract: S11 TXA-020…024.
- B2 — Recognizable failure: violating “picks presets, edits duration and params for all selected text clips” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: animation commands and tabs/sections → persisted textAnimation; drop side policy.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project text-animation tests own windows/evaluator; web owns selection defaults/explicit targets, panel input and compressed-edge pointer conversion.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/text-animation.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `shows the Text Animation section after Opacity and In/Out bars whose edge drag is one undo step`

- B1 — Independent contract: S11 TXA-020…024.
- B2 — Recognizable failure: violating “shows the Text Animation section after Opacity and In/Out bars whose edge drag is one undo step” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: animation commands and tabs/sections → persisted textAnimation; drop side policy.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project text-animation tests own windows/evaluator; web owns selection defaults/explicit targets, panel input and compressed-edge pointer conversion.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/text-animation.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `a compressed bar edge follows the pointer (the drag inverts the compression)`

- B1 — Independent contract: S11 TXA-020…024.
- B2 — Recognizable failure: violating “a compressed bar edge follows the pointer (the drag inverts the compression)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: animation commands and tabs/sections → persisted textAnimation; drop side policy.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project text-animation tests own windows/evaluator; web owns selection defaults/explicit targets, panel input and compressed-edge pointer conversion.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/text-animation.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/time.test.ts

Owner/non-test callers: commands/time.ts, edit-ux/menus.ts and time/scenes.ts; timeline menu/commands. Remaining coverage: Project time-commands.test.ts owns model remapping; UI commands own playhead/selection and menu mode. Geometry helpers are private visual mapping, covered by real speed-band interactions.

### DELETE: `maps 100 % to the middle, log scale, freeze at the bottom`

Detectable failure: maps 100 % to the middle, log scale, freeze at the bottom. Reason: Band y/segment geometry and percentage formatting mirror private display helpers; time commands and actual band gestures remain. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### DELETE: `segments and keys of a remapped clip in body px`

Detectable failure: segments and keys of a remapped clip in body px. Reason: Band y/segment geometry and percentage formatting mirror private display helpers; time commands and actual band gestures remain. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### KEEP: `shows the band, adds a speed keyframe at the playhead, sets interpolation, removes the remap`

- B1 — Independent contract: S02 time-remapping commands; docs/wp-notes/edit-ux.md keyframe menu; scene-edit dialog API.
- B2 — Recognizable failure: violating “shows the band, adds a speed keyframe at the playhead, sets interpolation, removes the remap” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered time commands / keyframe menu → remap, visible lanes and dialog request.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project time-commands.test.ts owns model remapping; UI commands own playhead/selection and menu mode. Geometry helpers are private visual mapping, covered by real speed-band interactions.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/time.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `Scene Edit Detection opens its dialog for the selected video clips with their media ranges`

- B1 — Independent contract: S02 time-remapping commands; docs/wp-notes/edit-ux.md keyframe menu; scene-edit dialog API.
- B2 — Recognizable failure: violating “Scene Edit Detection opens its dialog for the selected video clips with their media ranges” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: registered time commands / keyframe menu → remap, visible lanes and dialog request.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project time-commands.test.ts owns model remapping; UI commands own playhead/selection and menu mode. Geometry helpers are private visual mapping, covered by real speed-band interactions.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/time.test.ts --maxWorkers=1` and web typecheck.

### REWRITE: `sits after Opacity, shows the band and hides the property lane; another property hides the band`

- B1 — Independent contract: S02 time-remapping commands; docs/wp-notes/edit-ux.md keyframe menu; scene-edit dialog API.
- B2 — Recognizable failure: violating “sits after Opacity, shows the band and hides the property lane; another property hides the band” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: registered time commands / keyframe menu → remap, visible lanes and dialog request.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project time-commands.test.ts owns model remapping; UI commands own playhead/selection and menu mode. Geometry helpers are private visual mapping, covered by real speed-band interactions.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/time.test.ts --maxWorkers=1` and web typecheck.

## apps/web/test/timeline-commands.test.ts

Owner/non-test callers: commands/timeline.ts; menu/keymap/agent command dispatch. Remaining coverage: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.

### KEEP: `AC-13a: with V1 and A1 targeted, Ctrl+K at 240 splits only V1/A1 clips crossing 240`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “AC-13a: with V1 and A1 targeted, Ctrl+K at 240 splits only V1/A1 clips crossing 240” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `with a selection only the selected clips crossing the playhead split; Ctrl+Shift+K splits all`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “with a selection only the selected clips crossing the playhead split; Ctrl+Shift+K splits all” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `AC-13b: ripple delete with content on a sync-locked track is refused with a message naming the track`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “AC-13b: ripple delete with content on a sync-locked track is refused with a message naming the track” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `AC-16b: ripple-deleting a 30-frame clip before a marker moves it 30 frames left`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “AC-16b: ripple-deleting a 30-frame clip before a marker moves it 30 frames left” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `Delete with a gap selected closes the gap; Delete with clips leaves gaps`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “Delete with a gap selected closes the gap; Delete with clips leaves gaps” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `edit.clear (global Delete / Edit ▸ Clear) routes to the focused panel`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “edit.clear (global Delete / Edit ▸ Clear) routes to the focused panel” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `AC-11d: Q removes the head, closes the gap, moves the playhead to the old start; undo restores exactly`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “AC-11d: Q removes the head, closes the gap, moves the playhead to the old start; undo restores exactly” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `W ripple-removes [playhead, end); Alt+Q / Alt+W leave gaps`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “W ripple-removes [playhead, end); Alt+Q / Alt+W leave gaps” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `linked partners follow once; nothing under the playhead is a hinted no-op`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “linked partners follow once; nothing under the playhead is a hinted no-op” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `E extends the selected edit point to the playhead with its trim type`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “E extends the selected edit point to the playhead with its trim type” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `AC-15a/b: I at 100 and O at 199 give a 100-frame range; undo after O restores the previous Out`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “AC-15a/b: I at 100 and O at 199 give a 100-frame range; undo after O restores the previous Out” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `AC-13d: Extract with In=100 Out=199 removes exactly 100 frames and clears In/Out`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “AC-13d: Extract with In=100 Out=199 removes exactly 100 frames and clears In/Out” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `Lift without In/Out is a hinted no-op`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “Lift without In/Out is a hinted no-op” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `Mark Clip and Mark Selection`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “Mark Clip and Mark Selection” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `AC-8c: Ctrl+A never selects clips on locked tracks`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “AC-8c: Ctrl+A never selects clips on locked tracks” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `nudges coalesce into one history entry and clamp at frame 0`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “nudges coalesce into one history entry and clamp at frame 0” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `D selects the clip at the playhead on targeted tracks`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “D selects the clip at the playhead on targeted tracks” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `markers: M adds at the playhead; Shift+M / Ctrl+Shift+M navigate`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “markers: M adds at the playhead; Shift+M / Ctrl+Shift+M navigate” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

### KEEP: `gesture.cancel with nothing active deselects`

- B1 — Independent contract: S02 cited TL/AC requirements for targeting, trim, In/Out and navigation.
- B2 — Recognizable failure: violating “gesture.cancel with nothing active deselects” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: runCommand with real session + timeline controller → spans, selection, history and transport.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project edit tests own explicit transactions; these cases uniquely derive model arguments from targeting, selection, playhead, sync-lock and UI trim mode.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-commands.test.ts --maxWorkers=1` and web typecheck.

## apps/web/test/timeline-transition-index.test.ts

Owner/non-test callers: timeline/model/transitions.ts; TimelinePanel and controller hit testing. Remaining coverage: transitions-timeline.test.ts owns editing interactions. Range oracle tests indexing against independently specified interval overlap; movement case protects stale cache. Same-function hit comparison lacks independent hit oracle.

### KEEP: `matches exhaustive half-open range queries, including long overlaps and equal starts`

- B1 — Independent contract: half-open transition-range lookup and transient-movement cache correctness.
- B2 — Recognizable failure: violating “matches exhaustive half-open range queries, including long overlaps and equal starts” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: transitionIndex/transitionsInRange → transition ids in requested range.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: transitions-timeline.test.ts owns editing interactions. Range oracle tests indexing against independently specified interval overlap; movement case protects stale cache. Same-function hit comparison lacks independent hit oracle.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-transition-index.test.ts --maxWorkers=1` and web typecheck.

### DELETE: `matches exhaustive hits at body/edge boundaries across zoom and row heights`

Detectable failure: matches exhaustive hits at body/edge boundaries across zoom and row heights. Reason: Uses hitTransition on both indexed and exhaustive inputs as its own oracle; a shared wrong hit rule passes both. Actual transition interactions own selection/edge behavior. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### REWRITE: `reuses unchanged indexes and rebuilds after a transient clip movement`

- B1 — Independent contract: half-open transition-range lookup and transient-movement cache correctness.
- B2 — Recognizable failure: violating “reuses unchanged indexes and rebuilds after a transient clip movement” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: transitionIndex/transitionsInRange → transition ids in requested range.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: transitions-timeline.test.ts owns editing interactions. Range oracle tests indexing against independently specified interval overlap; movement case protects stale cache. Same-function hit comparison lacks independent hit oracle.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/timeline-transition-index.test.ts --maxWorkers=1` and web typecheck.

## apps/web/test/tracking-simplify.test.tsx

Owner/non-test callers: tracking/SimplifyKeyframesDialog.tsx, ApplyTrackingDialog.tsx, simplify-actions.ts; clip menus/Tracking section. Remaining coverage: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.

### KEEP: `previews live without a History entry, then applies as one entry`

- B1 — Independent contract: S09 TRK-023/TRU-006; AGENTS §0 unknown-field compatibility.
- B2 — Recognizable failure: violating “previews live without a History entry, then applies as one entry” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Simplify/ApplyTracking dialog → transient/committed document; density eligibility input boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/tracking-simplify.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `cancel leaves no trace; presets change the tolerance`

- B1 — Independent contract: S09 TRK-023/TRU-006; AGENTS §0 unknown-field compatibility.
- B2 — Recognizable failure: violating “cancel leaves no trace; presets change the tolerance” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Simplify/ApplyTracking dialog → transient/committed document; density eligibility input boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/tracking-simplify.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `reports when there is nothing to simplify`

- B1 — Independent contract: S09 TRK-023/TRU-006; AGENTS §0 unknown-field compatibility.
- B2 — Recognizable failure: violating “reports when there is nothing to simplify” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Simplify/ApplyTracking dialog → transient/committed document; density eligibility input boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/tracking-simplify.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `counts preserved animation fields alongside recognized transform parameters`

- B1 — Independent contract: S09 TRK-023/TRU-006; AGENTS §0 unknown-field compatibility.
- B2 — Recognizable failure: violating “counts preserved animation fields alongside recognized transform parameters” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Simplify/ApplyTracking dialog → transient/committed document; density eligibility input boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/tracking-simplify.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `Apply Tracking can simplify in the same entry`

- B1 — Independent contract: S09 TRK-023/TRU-006; AGENTS §0 unknown-field compatibility.
- B2 — Recognizable failure: violating “Apply Tracking can simplify in the same entry” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Simplify/ApplyTracking dialog → transient/committed document; density eligibility input boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/tracking-simplify.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `ignores preserved non-animation transform data %j when checking keyframe density [null, {}, null keyframes, string keyframes]`

- B1 — Independent contract: S09 TRK-023/TRU-006; AGENTS §0 unknown-field compatibility.
- B2 — Recognizable failure: violating “ignores preserved non-animation transform data %j when checking keyframe density [null, {}, null keyframes, string keyframes]” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Simplify/ApplyTracking dialog → transient/committed document; density eligibility input boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/tracking-simplify.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `ignores preserved unsupported animation data %j when simplifying unknown clips [six malformed extensions]`

- B1 — Independent contract: S09 TRK-023/TRU-006; AGENTS §0 unknown-field compatibility.
- B2 — Recognizable failure: violating “ignores preserved unsupported animation data %j when simplifying unknown clips [six malformed extensions]” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Simplify/ApplyTracking dialog → transient/committed document; density eligibility input boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/tracking-simplify.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `counts preserved supported animation data %j on unknown clips [effect params, template paramKeyframes]`

- B1 — Independent contract: S09 TRK-023/TRU-006; AGENTS §0 unknown-field compatibility.
- B2 — Recognizable failure: violating “counts preserved supported animation data %j on unknown clips [effect params, template paramKeyframes]” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Simplify/ApplyTracking dialog → transient/committed document; density eligibility input boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project simplify.test.ts owns simplification algorithm; UI owns preview/cancel/undo/persistence. Density guards uniquely prevent malformed preserved fields crashing menu eligibility.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/tracking-simplify.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/transitions-gpu-panels.test.tsx

Owner/non-test callers: effects/EffectsPanel.tsx, effects/transitions.ts, effectControls/TransitionSection.tsx. Remaining coverage: Project transition tests own parameter validity; UI owns filter controls and playhead-relative stopwatch dispatch. Bin/parameter inventories do not prove those behaviors.

### DELETE: `groups transitions by bin and sub-bin, Sapphire after Premiere`

Detectable failure: groups transitions by bin and sub-bin, Sapphire after Premiere. Reason: Folder names/order and catalog membership inventory, duplicated by actual EffectsPanel filter/apply behavior. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### REWRITE: `shows the GPU badge and filters by GPU`

- B1 — Independent contract: S10 TUI-020; GPU filtering; transition parameter editing/keyframe mapping.
- B2 — Recognizable failure: violating “shows the GPU badge and filters by GPU” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: EffectsPanel / EffectControlsPanel input → visible choices and committed transition params.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project transition tests own parameter validity; UI owns filter controls and playhead-relative stopwatch dispatch. Bin/parameter inventories do not prove those behaviors.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/transitions-gpu-panels.test.tsx --maxWorkers=1` and web typecheck.

### REWRITE: `edits a GPU transition param in one entry and keyframes it at the playhead`

- B1 — Independent contract: S10 TUI-020; GPU filtering; transition parameter editing/keyframe mapping.
- B2 — Recognizable failure: violating “edits a GPU transition param in one entry and keyframes it at the playhead” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: EffectsPanel / EffectControlsPanel input → visible choices and committed transition params.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project transition tests own parameter validity; UI owns filter controls and playhead-relative stopwatch dispatch. Bin/parameter inventories do not prove those behaviors.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/transitions-gpu-panels.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/transitions-polish.test.tsx

Owner/non-test callers: fx/TransitionPointOverlay.tsx and effectControls/TransitionSection.tsx; ProgramMonitor/EC hosts. Remaining coverage: Project transition-polish.test.ts owns evaluation; UI tests own custom image selection, completion seeding and point-drag transaction. Decorations/mapping helpers add no independent behavior.

### DELETE: `marks expensive transitions with the expensive-effect dot`

Detectable failure: marks expensive transitions with the expensive-effect dot. Reason: Expensive dot/title decoration, helper coordinate round-trip, or negative test claiming no selection while setting a selected transition without points. Real parameter/drag tests survive. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### REWRITE: `picks a Custom Gradient image for Gradient Wipe (None = the built-in gradient)`

- B1 — Independent contract: S10 transition parameter/point interaction; docs/specs/10-transitions-ui.md.
- B2 — Recognizable failure: violating “picks a Custom Gradient image for Gradient Wipe (None = the built-in gradient)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: TransitionSection and TransitionPointOverlay input → committed transition params/history.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project transition-polish.test.ts owns evaluation; UI tests own custom image selection, completion seeding and point-drag transaction. Decorations/mapping helpers add no independent behavior.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/transitions-polish.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `turning Custom Completion on seeds a 0 → 100 % curve over the span (one history entry)`

- B1 — Independent contract: S10 transition parameter/point interaction; docs/specs/10-transitions-ui.md.
- B2 — Recognizable failure: violating “turning Custom Completion on seeds a 0 → 100 % curve over the span (one history entry)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: TransitionSection and TransitionPointOverlay input → committed transition params/history.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project transition-polish.test.ts owns evaluation; UI tests own custom image selection, completion seeding and point-drag transaction. Decorations/mapping helpers add no independent behavior.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/transitions-polish.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `maps frame-normalised points to sequence px and back`

Detectable failure: maps frame-normalised points to sequence px and back. Reason: Expensive dot/title decoration, helper coordinate round-trip, or negative test claiming no selection while setting a selected transition without points. Real parameter/drag tests survive. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

### REWRITE: `draws a crosshair for Center and drags it in one gesture`

- B1 — Independent contract: S10 transition parameter/point interaction; docs/specs/10-transitions-ui.md.
- B2 — Recognizable failure: violating “draws a crosshair for Center and drags it in one gesture” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner; remove incidental copy, geometry, count/identity or collaborator-shape assertions while retaining the action/result contract.
- B4 — Stable seam: TransitionSection and TransitionPointOverlay input → committed transition params/history.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project transition-polish.test.ts owns evaluation; UI tests own custom image selection, completion seeding and point-drag transaction. Decorations/mapping helpers add no independent behavior.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/transitions-polish.test.tsx --maxWorkers=1` and web typecheck.

### DELETE: `shows nothing without a selected transition, or for a type without point params`

Detectable failure: shows nothing without a selected transition, or for a type without point params. Reason: Expensive dot/title decoration, helper coordinate round-trip, or negative test claiming no selection while setting a selected transition without points. Real parameter/drag tests survive. Risk: low; removed assertion targets private representation or a duplicate. Validation: surviving tests in this path, or the remaining owner named above, then web typecheck.

## apps/web/test/vite-chunks.test.ts

Owner/non-test callers: vite.config.ts used by Vite build. Remaining coverage: Config retention exception: exact chunk name is specified independently; no other unit owner tests anime subpath matching.

### KEEP: `puts anime.js subpath modules in vendor-anime`

- B1 — Independent contract: S11 ANM-023 explicitly requires animejs subpaths in vendor-anime.
- B2 — Recognizable failure: violating “puts anime.js subpath modules in vendor-anime” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Vite public build configuration manualChunks callback → required output chunk name.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Config retention exception: exact chunk name is specified independently; no other unit owner tests anime subpath matching.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/vite-chunks.test.ts --maxWorkers=1` and web typecheck.

## apps/web/test/wp2e/ui.test.tsx

Owner/non-test callers: Home.tsx, ProjectPanel.tsx, JobsPanel.tsx, ExportMode.tsx and export/settings.ts; application panels. Remaining coverage: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.

### KEEP: `requires confirmation before deleting a project`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “requires confirmation before deleting a project” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `moves media into a bin and finds it from the project root`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “moves media into a bin and finds it from the project root” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `warns before deleting media that is used in a sequence and deletes with force on confirm`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “warns before deleting media that is used in a sequence and deletes with force on confirm” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `creates a sequence from the selected preset`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “creates a sequence from the selected preset” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `keeps a ready 720 proxy when the 540 tier was never made (LIFE-050)`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “keeps a ready 720 proxy when the 540 tier was never made (LIFE-050)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `cancels a running export job through the engine (JOB-003)`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “cancels a running export job through the engine (JOB-003)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `keeps client uploads running when the engine is disconnected (JOB-005)`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “keeps client uploads running when the engine is disconnected (JOB-005)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `sends the committed project envelope when requesting an export plan`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “sends the committed project envelope when requesting an export plan” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `forcing Native with native blockers disables Export (S04:RP-012, S05:EX-022)`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “forcing Native with native blockers disables Export (S04:RP-012, S05:EX-022)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `starts export without a stale plan ID and remembers settings (EX-013/014, RP-011)`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “starts export without a stale plan ID and remembers settings (EX-013/014, RP-011)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `uses an available codec when H.264 is unavailable (ARCHITECTURE D-13)`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “uses an available codec when H.264 is unavailable (ARCHITECTURE D-13)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

### KEEP: `disables unusable hardware and GPL encoders in LGPL-only mode (ARCHITECTURE D-13)`

- B1 — Independent contract: S05 HD-020/PRJ-001…010/JOB-003/005/EX-013/014/022; S01 LIFE-050; ARCHITECTURE D-13.
- B2 — Recognizable failure: violating “disables unusable hardware and GPL encoders in LGPL-only mode (ARCHITECTURE D-13)” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: Home/Project/Jobs/Export controls → document or HTTP; encoderOptions availability boundary.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Project/engine suites own storage, jobs and rendering; web uniquely owns confirmation before HTTP, selected preset, client-upload disconnect, export capability gating and stale plan omission.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp2e/ui.test.tsx --maxWorkers=1` and web typecheck.

## apps/web/test/wp3i-integration.test.ts

Owner/non-test callers: export/settings.ts; ExportMode filename entry. Remaining coverage: Engine output naming owns final extension; this boundary owns user-entered suffix normalization and path separator removal.

### KEEP: `drops a typed .mp4 extension (the export adds it) and keeps other names`

- B1 — Independent contract: export caller filename/path safety contract.
- B2 — Recognizable failure: violating “drops a typed .mp4 extension (the export adds it) and keeps other names” changes the named document, state, choice, error, or protocol result.
- B3 — Oracle: literal expected values/outcomes or pre-action state in this case, not a recomputation from its production owner.
- B4 — Stable seam: sanitizeFileName input/output consumed by export settings.
- B5 — Refactor tolerance: assertions concern the named outcome at that seam; private function names, component nesting, helper call order and implementation layout are not the contract.
- B6 — Lowest distinct owner: Engine output naming owns final extension; this boundary owns user-entered suffix normalization and path separator removal.
- Risk/validation: retain this case because its input condition can uniquely produce the named failure; run `pnpm exec vitest run apps/web/test/wp3i-integration.test.ts --maxWorkers=1` and web typecheck.

## Applied cleanup and validation status

Cleanup implemented in this worktree; integration validation remains pending. The ledger records 52 DELETE, 31 REWRITE and 135 KEEP declarations/families (same-contract parameterization is grouped). Removed three whole inventory/row-count suites. Graph numerical rewrites also reject empty sampling output, so their universal assertions cannot pass vacuously. No new test declarations were added.

Production behavior is unchanged. Removed test-only exports from `INITIAL_ROWS`, `effectiveEase`, `unitVelocity`, `framePointToSequence`, `sequenceToFramePoint`, and `BOOT_FAILURE_TEXT`; their internal production uses remain. `pointToSequence`/`sequenceToPoint` stay exported because WarpOverlay imports them. `useRowWindow.measure` stays because ProjectPanel's list/grid implementations require it. The shared inspector/timeline/transition fixture helpers remain in use. Removed orphan local scope-image data, build-chunk graph fixture, inventory traversal helpers, graph unit helpers, and imports with the discarded tests; no snapshot or asset file became orphaned.

Validation actually run: offline frozen pnpm installation succeeded (unbuilt MCP binary-link warnings; ignored onnxruntime build script). Targeted Biome import cleanup/format checks and `git diff --check` ran. The assigned-path baseline Vitest command was started with one worker; it produced only the RUN banner under shared-host contention and was interrupted with exit 130 at the integration owner's instruction. This is **not a passing baseline**. Focused Vitest, web typecheck and repository gates are explicitly pending root integrated validation; no failures were hidden, suppressed or used to choose deletions. No UI production behavior changed, so browser/GL/render suites were not launched by this group.

Final diff review: all production hunks only remove export visibility or obsolete test-oriented commentary. Test removals and retained behavior assertions were inspected; targeted Biome reported “Checked 24 files”, with no remaining diagnostics. `git diff --check` passed. No dependencies, generated catalogs, fixtures, screenshots or other assets were changed.

## Final shared-oracle rescan: pre-edit record

Reviewed all 31 retained assigned files against the integrated checkout. Seven cases need narrower or independent oracles; this record is written before changing tests or production exports. Every affected test currently matches integration. No behavioral production change is planned.

### REWRITE — `apps/web/test/polish-open.test.tsx`: `resolves every requested media status across bounded batches`

- B1: ARCHITECTURE D-48 and §9 specify POST `/api/media/status` with at most 1,000 keys; S01:LIFE-050 requires per-asset availability. Exactly two requests and 1,000/200 partition sizes are measurements, not the contract.
- B2: An oversized request, a never-requested medium, wrong online/offline state, or a lost poster URL is a caller-visible failure at project open.
- B3: Use 1,200 fixture keys independent of the production batch constant, the documented literal maximum 1,000, exact set equality of requested input keys, and fixture online/offline/poster results for every medium. Do not derive the cap or fixture size from `MEDIA_STATUS_BATCH_MAX`.
- B4: Observe emitted HTTP bodies and the public session media store after `createMediaRuntimeSync`.
- B5: Smaller batches, different request order and different numbers of requests remain valid. Remove exact-two and exact-partition assertions.
- B6: Engine tests own server rejection limits; this web case proves the producer respects the API cap and resolves a multi-batch project. `scripts/perf/ui-run.ts` owns open-time performance.
- Production callers: project/import lifecycle uses `createMediaRuntimeSync`; API/engine code also uses `MEDIA_STATUS_BATCH_MAX`, which remains exported. `DERIVATIVE_KINDS` builds fixture response data, not expected results.
- Risk/validation: low, assertion-only; comparing every result prevents losing coverage when dropping call shape. Focused `polish-open`, web typecheck and integration gates are pending root; static checks here.

### REWRITE — `apps/web/test/polish-open.test.tsx`: `says so when the bundle cannot be downloaded, instead of a blank page`; `reloads by itself first: fast failures have a small budget, slow cut-off loads a larger one, a boot resets it`

- B1: `docs/verification.md` §8 explicitly records three quick reloads, an eight-second slow-load boundary, eight total reloads per tab, and reset when the app renders. AGENTS §0 and the polish regression require a visible failure instead of a blank page.
- B2: A wrong retry cap/threshold can leave the user reloading forever or abandon a recoverable load. The DOM case also detects a missing focused recovery action and misclassified script errors.
- B3: Use documented literals 3, 8, 8,001 ms and 16,000 ms instead of importing the same `BOOT_RETRIES`, `BOOT_MAX_RELOADS`, and `BOOT_SLOW_MS` values that generate the script. Seed/read persisted `jasper:boot-retries` independently. Preserve DOM/reset/error observations.
- B4: Execute the generated script in a DOM, dispatch module errors, observe reload requests, alert state and session storage.
- B5: Internal constant names, formatting, control-flow arrangement and backoff implementation may change without changing these contracts.
- B6: Lowest seam for quick/slow retry branches and malformed saved counters; browser workflow owns built-app script delivery/recovery.
- Production callers: `vite.config.ts` uses `editorBootScript`. Census shows all four `BOOT_*` exports have only local production uses and this test import. Make `BOOT_RETRIES`, `BOOT_MAX_RELOADS`, `BOOT_SLOW_MS`, `BOOT_RETRY_KEY` private; generated bytes remain unchanged.
- Risk/validation: low, same actions with independent oracles. Focused `polish-open` and web typecheck pending root; static checks here.

### REWRITE — `apps/web/test/gaps-preferences.test.tsx`: `parses hostile storage values to the defaults`

- B1: AGENTS §0 requires preference entry-point validation; corrupt stored labels/language and out-of-range trim settings must not break the editor.
- B2: Invalid label defaults, invalid locale or an unbounded trim offset remain visible in the retained parsed configuration.
- B3: Delete only `parseGapsPrefs(null) === DEFAULT_GAPS_PREFS`: both sides use production defaults, so simultaneous wrong defaults pass. Preserve existing literal hostile-input assertions. Do not replace the whole defaults object with a copied inventory.
- B4: `parseGapsPrefs` is the storage/config entry seam.
- B5: Accepted safe configuration survives default-object identity and private-field refactors.
- B6: This case owns hostile stored preferences; separate UI cases own settings affecting trim/autosave/reduced motion.
- Production callers: parser is used by preference load/set; `DEFAULT_GAPS_PREFS` has only module-local production uses. Remove its export after removing the test import.
- Risk/validation: low; delete only a tautological subassertion. Focused preferences test and web typecheck pending root; static checks here.

### REWRITE — `apps/web/test/edit-ux-keyboard.test.tsx`: `spring-loaded tools: a held key returns to the previous tool on release, a tap switches`

- B1: `docs/wp-notes/edit-ux.md` specifies a hold of at least 250 ms, explicitly the project's chosen threshold, and distinguishes a tap.
- B2: A held tool staying selected or a tap reverting changes the active editing tool.
- B3: Drive a deterministic clock from 0 to literal 250 ms. Remove the wait computed from imported `SPRING_HOLD_MS`, which let a wrong threshold move setup and production together.
- B4: Registered tool commands and keyboard-release entry point, observed through session active-tool state.
- B5: No dependency on a private identifier, scheduler speed or wall-clock load; command internals can change.
- B6: Command owns spring-state transitions; browser tours add no distinct contract at this threshold.
- Production callers: keyboard dispatcher invokes command/key-up handlers. `SPRING_HOLD_MS` has only local uses and this test import; make it private.
- Risk/validation: low, deterministic test timing and export visibility only. Focused keyboard test and web typecheck pending root; static checks here.

### REWRITE — `apps/web/test/effect-controls-graph.test.ts`: `is the derivative of evaluate in units per second: constant on linear segments, zero outside`; `eases to zero speed at an Ease Out key and steps at keys with different in/out speeds`

- B1: S01:KF-002/KF-009 and `docs/wp-notes/graph-editor.md` define mapping to sequence frames and velocity in units per second of sequence time.
- B2: A misplaced boundary or wrong one-sided speed displays the wrong graph value at a known keyframe.
- B3: Fixture starts at frame 10, source offset 0, speed 1×; content keys at 0 and 30 frames therefore occur at literal sequence frames 10 and 40. Replace expected-sample `map.toX` calls with these independent coordinates. Existing 90 and −180 units/s oracles remain analytical.
- B4: Graph sampler output consumed by GraphEditor.
- B5: Sampling density and interpolation internals may change while preserving the coordinates/velocities.
- B6: Project interpolation owns values; sampler owns graph velocities and one-sided boundary samples; UI tests own handle interactions.
- Production callers: GraphEditor uses `timeMapOf` and `sampleVelocityCurve`; keep both exports. `EASE_PRESETS.linear` supplies fixture input only, not expected velocity.
- Risk/validation: low, independent coordinates strengthen the same assertions. Focused graph test and web typecheck pending root; static checks here.

### Coordinated seam removal — `apps/web/test/shell-render.test.tsx`

`WORKSPACES_KEY` is fixture setup, not a derived expected value. Web2 is replacing its `shell.test.tsx` import independently. This test will use the persisted `jasper:workspaces` key documented in `docs/wp-notes/WP-2A.md`; census confirms all production uses are local to `shell/workspaces/store.ts`, so remove only its export after both test imports disappear. Existing retained-test disposition is unchanged. Risk low; no storage bytes change; focused shell tests and web typecheck pending root.

Other helper uses inspected were setup or observed output: `resolveTextAnimationWindows`/`activeRemap` are observed against literals; `buildRenderSnapshot` supplies rendered input; keymap normalization checks the independent no-conflict invariant; transition-index lookup is compared with an exhaustive half-open interval predicate. No change is required for those uses. No fixture/snapshot/helper becomes orphaned beyond the seven test-only constant exports identified above.

Rescan validation: targeted Biome passed for all nine changed TypeScript files; the first pass reported one formatting change in the boot test, corrected before the passing rerun. `git diff --check` passed. Tests/typecheck were not run under root's static-only instruction; root owns the integrated verdict. `shell.test.tsx` still imports `WORKSPACES_KEY` in this isolated older branch; web2's coordinated commit removes that import and must accompany this commit before integrated typecheck. Production diff contains only seven `export` removals, with all values unchanged. Three former KEEP declarations are now REWRITE, leaving 52 DELETE / 34 REWRITE / 132 KEEP original declarations/families.

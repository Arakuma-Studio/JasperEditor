# Compositions test cleanup: partition 1

Pre-edit audit recorded before changing tests or production support. Scope: all 42 assigned files; each generated test declaration below covers every row of its named data table/loop. Decisions are per test, not regex matches. Existing visual regression is explicitly required by AGENTS.md §4 and docs/testing.md §2. The public shader authoring protocol remains supported; test fixture entrypoints are adapters to real rendering, not mocks of asserted pixels.

All commands below run from this worktree. Run each surviving changed file with `pnpm exec vitest run <path> --maxWorkers=1`; GL requires Chrome, and Remotion suites additionally require `REMOTION_E2E=1`. Package check: `pnpm --filter @jasper/compositions typecheck`. Root owns repository gates. Resource scheduling is coordinated with root; no missing oracle or opt-in skip is a pass.

## packages/compositions/test/captions.test.tsx

### REWRITE: draws caption tracks above the video tracks, one page at a time

- Baseline case: `packages/compositions/test/captions.test.tsx:53`. Detected failure: draws caption tracks above the video tracks, one page at a time. Production owner/non-test callers: `layers/CaptionsLayer.tsx and @jasper/project buildRenderSnapshot`.
- Decision: Keep page-time text output; remove snapshot track ordering, line counts and inline style assertions.
- Bar 1 (independent source): docs/wp-notes/captions.md §4; S01:KND-008; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through caption text/state at a selected frame.
- Bar 3 (independent expectation): fixed source text and independently chosen caption/word timings. These expectations can disagree with the owner.
- Bar 4 (stable seam): caption text/state at a selected frame; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): page/hidden/highlight contract beyond the single golden caption frame. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/captions.test.tsx --maxWorkers=1`; package typecheck.

### KEEP: hidden caption tracks are not drawn

- Baseline case: `packages/compositions/test/captions.test.tsx:72`. Detected failure: hidden caption tracks are not drawn. Production owner/non-test callers: `layers/CaptionsLayer.tsx and @jasper/project buildRenderSnapshot`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/captions.md §4; S01:KND-008; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through caption text/state at a selected frame.
- Bar 3 (independent expectation): fixed source text and independently chosen caption/word timings. These expectations can disagree with the owner.
- Bar 4 (stable seam): caption text/state at a selected frame; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): page/hidden/highlight contract beyond the single golden caption frame. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/captions.test.tsx --maxWorkers=1`; package typecheck.

### KEEP: karaoke highlight colours the words spoken so far

- Baseline case: `packages/compositions/test/captions.test.tsx:81`. Detected failure: karaoke highlight colours the words spoken so far. Production owner/non-test callers: `layers/CaptionsLayer.tsx and @jasper/project buildRenderSnapshot`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/captions.md §4; S01:KND-008; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through caption text/state at a selected frame.
- Bar 3 (independent expectation): fixed source text and independently chosen caption/word timings. These expectations can disagree with the owner.
- Bar 4 (stable seam): caption text/state at a selected frame; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): page/hidden/highlight contract beyond the single golden caption frame. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/captions.test.tsx --maxWorkers=1`; package typecheck.

### DELETE: places the block inside title-safe, honouring VTT line and position overrides

- Baseline case: `packages/compositions/test/captions.test.tsx:93`. Detected failure: places the block inside title-safe, honouring VTT line and position overrides. Production owner/non-test callers: `layers/CaptionsLayer.tsx and @jasper/project buildRenderSnapshot`.
- Decision: Private CSS-coordinate helper; rendered caption golden owns appearance, and this inspects a layout object rather than visible placement.
- Remaining stronger coverage / risk: Private CSS-coordinate helper; rendered caption golden owns appearance, and this inspects a layout object rather than visible placement. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/captions.test.tsx --maxWorkers=1`; package typecheck.

## packages/compositions/test/compositor.e2e.test.ts

### DELETE: an adjustment layer with GPU effects over a GL blend-mode track

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:140`. Detected failure: an adjustment layer with GPU effects over a GL blend-mode track. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Exact combo-adjust-over-gl-blend is independently referenced and golden-compared in golden-scenes.e2e.test.ts.
- Remaining stronger coverage / risk: Exact combo-adjust-over-gl-blend is independently referenced and golden-compared in golden-scenes.e2e.test.ts. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a GL blend-mode track over an adjustment layer with GPU effects

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:154`. Detected failure: a GL blend-mode track over an adjustment layer with GPU effects. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### DELETE: two GL blend-mode tracks separated by an adjustment layer (and a small Normal layer)

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:168`. Detected failure: two GL blend-mode tracks separated by an adjustment layer (and a small Normal layer). Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Exact combo-blend-adjust-blend is independently referenced and golden-compared in golden-scenes.e2e.test.ts.
- Remaining stronger coverage / risk: Exact combo-blend-adjust-blend is independently referenced and golden-compared in golden-scenes.e2e.test.ts. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: an adjustment layer limited by its crop and opacity over a GL blend (the scope mix, padded layout)

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:186`. Detected failure: an adjustment layer limited by its crop and opacity over a GL blend (the scope mix, padded layout). Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a DOM layer with GPU effects under a GL blend-mode track

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:211`. Detected failure: a DOM layer with GPU effects under a GL blend-mode track. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a DOM layer with GPU effects under an adjustment layer with GPU effects

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:225`. Detected failure: a DOM layer with GPU effects under an adjustment layer with GPU effects. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a GPU transition between DOM layers under an adjustment layer

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:239`. Detected failure: a GPU transition between DOM layers under an adjustment layer. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a visible DOM track read as a Track Matte under an adjustment layer

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:258`. Detected failure: a visible DOM track read as a Track Matte under an adjustment layer. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### DELETE: linear-light blending with an adjustment layer with GPU effects between the blended tracks

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:297`. Detected failure: linear-light blending with an adjustment layer with GPU effects between the blended tracks. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Exact combo-linear-adjust-between is independently referenced and golden-compared in golden-scenes.e2e.test.ts.
- Remaining stronger coverage / risk: Exact combo-linear-adjust-between is independently referenced and golden-compared in golden-scenes.e2e.test.ts. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: linear-light blending with a DOM layer with GPU effects between the blended tracks

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:321`. Detected failure: linear-light blending with a DOM layer with GPU effects between the blended tracks. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a 3D run over a GL blend-mode track = the CPU reference

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:339`. Detected failure: a 3D run over a GL blend-mode track = the CPU reference. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a GL blend-mode track over a 3D run = the CPU reference

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:346`. Detected failure: a GL blend-mode track over a 3D run = the CPU reference. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: an adjustment layer with GPU effects over a 3D run = the CPU reference

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:353`. Detected failure: an adjustment layer with GPU effects over a 3D run = the CPU reference. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a 3D run over an adjustment layer with GPU effects = the CPU reference

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:366`. Detected failure: a 3D run over an adjustment layer with GPU effects = the CPU reference. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: two GL blend-mode tracks separated by a 3D run = the CPU reference

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:379`. Detected failure: two GL blend-mode tracks separated by a 3D run = the CPU reference. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a nest with GPU effects whose nested sequence nests scopes, under a GL blend (canvas source)

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:422`. Detected failure: a nest with GPU effects whose nested sequence nests scopes, under a GL blend (canvas source). Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a nest whose nested sequence holds a GL blend, under an adjustment layer with GPU effects

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:443`. Detected failure: a nest whose nested sequence holds a GL blend, under an adjustment layer with GPU effects. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: parity: an adjustment layer whose GPU blur pads its layout (soft borders) over video

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:487`. Detected failure: parity: an adjustment layer whose GPU blur pads its layout (soft borders) over video. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: parity: a GL blend mode over video and a rotated DOM text layer

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:501`. Detected failure: parity: a GL blend mode over video and a rotated DOM text layer. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: parity: Stencil Alpha over video reveals the background

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:524`. Detected failure: parity: Stencil Alpha over video reveals the background. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: parity: a 3D run over video

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:538`. Detected failure: parity: a 3D run over video. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: parity: linear-light blending of video, text and a translucent solid

- Baseline case: `packages/compositions/test/compositor.e2e.test.ts:542`. Detected failure: parity: linear-light blending of video, text and a translucent solid. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/compositor.md §1–§3; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through complete Remotion still pixels.
- Bar 3 (independent expectation): separate CPU compositor, analytic BT.1886 arithmetic, fixed colors or invariant pixel parity under inactive off-frame clips. These expectations can disagree with the owner.
- Bar 4 (stable seam): complete Remotion still pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific ordering/nested/media/3D composition here; duplicated golden combinations are separately deleted. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/docs-gallery.e2e.test.ts

### DELETE: s.id

- Baseline case: `packages/compositions/test/docs-gallery.e2e.test.ts:381`. Detected failure: s.id. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Documentation generator checks counts, file sizes and nonempty raw bytes, not any independently expected scene. Real fx/transition fingerprints own the pixels; existing published screenshots remain assets.
- Remaining stronger coverage / risk: Documentation generator checks counts, file sizes and nonempty raw bytes, not any independently expected scene. Real fx/transition fingerprints own the pixels; existing published screenshots remain assets. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/docs-gallery.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/fonts-ready.test.tsx

### KEEP: a text layer is not mounted (no fallback-font paint, no measuring) until its face loads

- Baseline case: `packages/compositions/test/fonts-ready.test.tsx:99`. Detected failure: a text layer is not mounted (no fallback-font paint, no measuring) until its face loads. Production owner/non-test callers: `fonts.ts, used by SequenceComposition and text/caption layers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:FIX-003; docs/wp-notes/wp-m2-text-anim.md; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered text or per-face loading state.
- Bar 3 (independent expectation): externally controlled FontFace completion/rejection, not production cache data. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered text or per-face loading state; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): loading/rejection/weight lifecycle not exercised by preloaded-font goldens. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fonts-ready.test.tsx --maxWorkers=1`; package typecheck.

### KEEP: a face that fails to load counts as settled: the text renders with the fallback stack

- Baseline case: `packages/compositions/test/fonts-ready.test.tsx:109`. Detected failure: a face that fails to load counts as settled: the text renders with the fallback stack. Production owner/non-test callers: `fonts.ts, used by SequenceComposition and text/caption layers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:FIX-003; docs/wp-notes/wp-m2-text-anim.md; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered text or per-face loading state.
- Bar 3 (independent expectation): externally controlled FontFace completion/rejection, not production cache data. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered text or per-face loading state; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): loading/rejection/weight lifecycle not exercised by preloaded-font goldens. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fonts-ready.test.tsx --maxWorkers=1`; package typecheck.

### KEEP: faces already loaded on the page never hide the layer again (no blink on a new document)

- Baseline case: `packages/compositions/test/fonts-ready.test.tsx:118`. Detected failure: faces already loaded on the page never hide the layer again (no blink on a new document). Production owner/non-test callers: `fonts.ts, used by SequenceComposition and text/caption layers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:FIX-003; docs/wp-notes/wp-m2-text-anim.md; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered text or per-face loading state.
- Bar 3 (independent expectation): externally controlled FontFace completion/rejection, not production cache data. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered text or per-face loading state; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): loading/rejection/weight lifecycle not exercised by preloaded-font goldens. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fonts-ready.test.tsx --maxWorkers=1`; package typecheck.

### REWRITE: keeps a pending weight unready after another weight of the same family loads

- Baseline case: `packages/compositions/test/fonts-ready.test.tsx:142`. Detected failure: keeps a pending weight unready after another weight of the same family loads. Production owner/non-test callers: `fonts.ts, used by SequenceComposition and text/caption layers`.
- Decision: Keep independent per-weight readiness; remove private Remotion delay-handle counts.
- Bar 1 (independent source): S11:FIX-003; docs/wp-notes/wp-m2-text-anim.md; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered text or per-face loading state.
- Bar 3 (independent expectation): externally controlled FontFace completion/rejection, not production cache data. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered text or per-face loading state; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): loading/rejection/weight lifecycle not exercised by preloaded-font goldens. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fonts-ready.test.tsx --maxWorkers=1`; package typecheck.

### DELETE: releases the render hold when unmounted before its font loads

- Baseline case: `packages/compositions/test/fonts-ready.test.tsx:160`. Detected failure: releases the render hold when unmounted before its font loads. Production owner/non-test callers: `fonts.ts, used by SequenceComposition and text/caption layers`.
- Decision: Only reads Remotion private global handle counts around unmount; a bookkeeping change can fail with unchanged rendering. Real full-render lifecycle suites own completion.
- Remaining stronger coverage / risk: Only reads Remotion private global handle counts around unmount; a bookkeeping change can fail with unchanged rendering. Real full-render lifecycle suites own completion. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fonts-ready.test.tsx --maxWorkers=1`; package typecheck.

## packages/compositions/test/frame-window.test.ts

### DELETE: keeps every item whose span holds the frame (and the next page of frames)

- Baseline case: `packages/compositions/test/frame-window.test.ts:6`. Detected failure: keeps every item whose span holds the frame (and the next page of frames). Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Exposes private page granularity and window arithmetic; observable sequence rendering is covered by real render/player workflows. No user-facing contract requires this paging strategy.
- Remaining stronger coverage / risk: Exposes private page granularity and window arithmetic; observable sequence rendering is covered by real render/player workflows. No user-facing contract requires this paging strategy. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/frame-window.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

### DELETE: leaves out items far from the frame

- Baseline case: `packages/compositions/test/frame-window.test.ts:27`. Detected failure: leaves out items far from the frame. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Exposes private page granularity and window arithmetic; observable sequence rendering is covered by real render/player workflows. No user-facing contract requires this paging strategy.
- Remaining stronger coverage / risk: Exposes private page granularity and window arithmetic; observable sequence rendering is covered by real render/player workflows. No user-facing contract requires this paging strategy. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/frame-window.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/fx-gl.test.ts

### DELETE: has WebGL2

- Baseline case: `packages/compositions/test/fx-gl.test.ts:39`. Detected failure: has WebGL2. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Environment-capability probe; every retained pixel render necessarily requires working WebGL.
- Remaining stronger coverage / risk: Environment-capability probe; every retained pixel render necessarily requires working WebGL. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### DELETE: compiles the whole GLSL library

- Baseline case: `packages/compositions/test/fx-gl.test.ts:44`. Detected failure: compiles the whole GLSL library. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Compile-only coverage probe; retained family fingerprints execute the shaders and compare visible output.
- Remaining stronger coverage / risk: Compile-only coverage probe; retained family fingerprints execute the shaders and compare visible output. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: compiles and runs every registered GPU effect outside the families and the test effects

- Baseline case: `packages/compositions/test/fx-gl.test.ts:48`. Detected failure: compiles and runs every registered GPU effect outside the families and the test effects. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Keep independent golden comparison and rendering failures; remove registry count and duplicate compilation sweep.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: compiles and runs every GPU effect of ${family}

- Baseline case: `packages/compositions/test/fx-gl.test.ts:57`. Detected failure: compiles and runs every GPU effect of ${family}. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Keep independent default/perturbed pixel fingerprints; let rendering failures propagate and remove the redundant compile-only run.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: keeps the picture upright and premultiplied alpha intact

- Baseline case: `packages/compositions/test/fx-gl.test.ts:67`. Detected failure: keeps the picture upright and premultiplied alpha intact. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: glow: threshold → half-res blur → light, drawn into the padding

- Baseline case: `packages/compositions/test/fx-gl.test.ts:75`. Detected failure: glow: threshold → half-res blur → light, drawn into the padding. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Keep halo/alpha pixels; remove private pass list, padded-canvas and box dimensions.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: generator: a gradient over the layer box

- Baseline case: `packages/compositions/test/fx-gl.test.ts:98`. Detected failure: generator: a gradient over the layer box. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: drop shadow: offset into the padding, under the layer

- Baseline case: `packages/compositions/test/fx-gl.test.ts:106`. Detected failure: drop shadow: offset into the padding, under the layer. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Keep shadow/outside/source pixels; remove exact canvas allocation.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: time samples: the source over earlier frames

- Baseline case: `packages/compositions/test/fx-gl.test.ts:114`. Detected failure: time samples: the source over earlier frames. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: media params are bound with their size; missing media read as size 0

- Baseline case: `packages/compositions/test/fx-gl.test.ts:120`. Detected failure: media params are bound with their size; missing media read as size 0. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: colour runs on the shared host match the LUT (tetrahedral, the colour stage shader)

- Baseline case: `packages/compositions/test/fx-gl.test.ts:126`. Detected failure: colour runs on the shared host match the LUT (tetrahedral, the colour stage shader). Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: half-float intermediates keep values above 1

- Baseline case: `packages/compositions/test/fx-gl.test.ts:131`. Detected failure: half-float intermediates keep values above 1. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### DELETE: the faster library helpers return bit-identical values to the wave-1 sources

- Baseline case: `packages/compositions/test/fx-gl.test.ts:137`. Detected failure: the faster library helpers return bit-identical values to the wave-1 sources. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Compares optimized helpers with a copied prior implementation, enforcing implementation identity; fingerprints protect the required visible noise patterns.
- Remaining stronger coverage / risk: Compares optimized helpers with a copied prior implementation, enforcing implementation identity; fingerprints protect the required visible noise patterns. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: ping-pong outputs: update passes read the previous contents under the same name

- Baseline case: `packages/compositions/test/fx-gl.test.ts:145`. Detected failure: ping-pong outputs: update passes read the previous contents under the same name. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: absolute pass sizes (a 1×1 lookup pass)

- Baseline case: `packages/compositions/test/fx-gl.test.ts:150`. Detected failure: absolute pass sizes (a 1×1 lookup pass). Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Keep lookup-pass output pixels; remove pass-plan size readback.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: mipmapped outputs and source: textureLod at a coarse level averages

- Baseline case: `packages/compositions/test/fx-gl.test.ts:157`. Detected failure: mipmapped outputs and source: textureLod at a coarse level averages. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: ivec2 uniforms

- Baseline case: `packages/compositions/test/fx-gl.test.ts:163`. Detected failure: ivec2 uniforms. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: lut media params bind .cube LUTs as 3D textures (identity when none)

- Baseline case: `packages/compositions/test/fx-gl.test.ts:167`. Detected failure: lut media params bind .cube LUTs as 3D textures (identity when none). Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: u_sampleCount / u_sampleOffsets / u_sampleValid are bound in passes that do not sample

- Baseline case: `packages/compositions/test/fx-gl.test.ts:173`. Detected failure: u_sampleCount / u_sampleOffsets / u_sampleValid are bound in passes that do not sample. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### DELETE: time samples are uploaded once per key

- Baseline case: `packages/compositions/test/fx-gl.test.ts:178`. Detected failure: time samples are uploaded once per key. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Same cache key with different source bytes asserts internal upload caching, not valid caller behavior; time-sample pixel and real-video tests own correct pictures.
- Remaining stronger coverage / risk: Same cache key with different source bytes asserts internal upload caching, not valid caller behavior; time-sample pixel and real-video tests own correct pictures. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: one-direction Gaussian Blur runs as a GPU stand-in in the chain (vertical only)

- Baseline case: `packages/compositions/test/fx-gl.test.ts:185`. Detected failure: one-direction Gaussian Blur runs as a GPU stand-in in the chain (vertical only). Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Keep Gaussian line/spread analytic pixels; remove padding and alternate-backend identity assertions.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Transform: Shutter Angle motion blur from the params at sub-frame times

- Baseline case: `packages/compositions/test/fx-gl.test.ts:195`. Detected failure: Transform: Shutter Angle motion blur from the params at sub-frame times. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a shader that does not compile throws FxShaderError with the driver log

- Baseline case: `packages/compositions/test/fx-gl.test.ts:204`. Detected failure: a shader that does not compile throws FxShaderError with the driver log. Production owner/non-test callers: `fx/host.ts, effects.ts, builtins.ts; production FxPicture/effect chains`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3–9/§17; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through published shader authoring inputs to actual GPU pixel output/error.
- Bar 3 (independent expectation): committed fingerprints or analytic fixed colors/alpha/mipmap/blur formulas, not runtime plans. These expectations can disagree with the owner.
- Bar 4 (stable seam): published shader authoring inputs to actual GPU pixel output/error; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): specific host protocol feature or golden family; pure project planner tests never render shaders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-layers.test.tsx

### DELETE: draws a solid through the chain on a canvas grown by the padding (S03:FX-041)

- Baseline case: `packages/compositions/test/fx-layers.test.tsx:122`. Detected failure: draws a solid through the chain on a canvas grown by the padding (S03:FX-041). Production owner/non-test callers: `SequenceComposition/FxPicture fallback UI; all preview consumers`.
- Decision: Canvas sizing and mocked private run calls; actual padding pixels are protected by fx-render/fx-player.
- Remaining stronger coverage / risk: Canvas sizing and mocked private run calls; actual padding pixels are protected by fx-render/fx-player. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-layers.test.tsx --maxWorkers=1`; package typecheck.

### DELETE: keeps stack order: colour run and shader in the chain, a trailing SVG effect as a CSS stage

- Baseline case: `packages/compositions/test/fx-layers.test.tsx:136`. Detected failure: keeps stack order: colour run and shader in the chain, a trailing SVG effect as a CSS stage. Production owner/non-test callers: `SequenceComposition/FxPicture fallback UI; all preview consumers`.
- Decision: Mocked call sequence and data-effect wrappers; compositor and golden scenes check actual order-sensitive pixels.
- Remaining stronger coverage / risk: Mocked call sequence and data-effect wrappers; compositor and golden scenes check actual order-sensitive pixels. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-layers.test.tsx --maxWorkers=1`; package typecheck.

### REWRITE: without WebGL2 the preview bypasses shader effects visibly (chip), never silently

- Baseline case: `packages/compositions/test/fx-layers.test.tsx:150`. Detected failure: without WebGL2 the preview bypasses shader effects visibly (chip), never silently. Production owner/non-test callers: `SequenceComposition/FxPicture fallback UI; all preview consumers`.
- Decision: Keep visible WebGL-unavailable status; remove exact copy and canvas structure, dead fake renderer/call recorder.
- Bar 1 (independent source): AGENTS.md §0/§4; docs/wp-notes/fx-shader-framework.md §11; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through visible backend-unavailable status after capability absence.
- Bar 3 (independent expectation): external unavailable capability with required visible diagnostic. These expectations can disagree with the owner.
- Bar 4 (stable seam): visible backend-unavailable status after capability absence; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): no-WebGL fallback (distinct from no-HTML-in-Canvas browser fallback). No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-layers.test.tsx --maxWorkers=1`; package typecheck.

### DELETE: a DOM layer without HTML-in-Canvas shows a chip instead of a wrong picture

- Baseline case: `packages/compositions/test/fx-layers.test.tsx:160`. Detected failure: a DOM layer without HTML-in-Canvas shows a chip instead of a wrong picture. Production owner/non-test callers: `SequenceComposition/FxPicture fallback UI; all preview consumers`.
- Decision: Duplicates real unsupported-browser warning in fx-player.e2e.test.ts.
- Remaining stronger coverage / risk: Duplicates real unsupported-browser warning in fx-player.e2e.test.ts. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-layers.test.tsx --maxWorkers=1`; package typecheck.

### DELETE: a shader that fails to compile is bypassed alone with a chip (preview)

- Baseline case: `packages/compositions/test/fx-layers.test.tsx:177`. Detected failure: a shader that fails to compile is bypassed alone with a chip (preview). Production owner/non-test callers: `SequenceComposition/FxPicture fallback UI; all preview consumers`.
- Decision: Injects private fxStatus failure state and asserts mocked invocation inventory; real shader error is covered in fx-gl and visible backend absence remains here.
- Remaining stronger coverage / risk: Injects private fxStatus failure state and asserts mocked invocation inventory; real shader error is covered in fx-gl and visible backend absence remains here. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-layers.test.tsx --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-player.e2e.test.ts

### KEEP: a paused video frame goes through the shader chain (headless <Video> → FxPicture)

- Baseline case: `packages/compositions/test/fx-player.e2e.test.ts:114`. Detected failure: a paused video frame goes through the shader chain (headless <Video> → FxPicture). Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a freeze frame shows the frozen source frame

- Baseline case: `packages/compositions/test/fx-player.e2e.test.ts:132`. Detected failure: a freeze frame shows the frozen source frame. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a still with a padded drop shadow, and a paused param edit redraws it

- Baseline case: `packages/compositions/test/fx-player.e2e.test.ts:148`. Detected failure: a still with a padded drop shadow, and a paused param edit redraws it. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Transform Shutter Angle motion blur from the keyframes, as in renders

- Baseline case: `packages/compositions/test/fx-player.e2e.test.ts:168`. Detected failure: Transform Shutter Angle motion blur from the keyframes, as in renders. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a shape (DOM layer) runs its shader effects through HTML-in-Canvas

- Baseline case: `packages/compositions/test/fx-player.e2e.test.ts:175`. Detected failure: a shape (DOM layer) runs its shader effects through HTML-in-Canvas. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: without HTML-in-Canvas the DOM layer shows a chip and draws unprocessed

- Baseline case: `packages/compositions/test/fx-player.e2e.test.ts:181`. Detected failure: without HTML-in-Canvas the DOM layer shows a chip and draws unprocessed. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-player.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts

### DELETE: identity at the Premiere defaults

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:28`. Detected failure: identity at the Premiere defaults. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Default-only identity sweep duplicated by the default/perturbed fingerprint owner; retain parameter-specific analytic pixels.
- Remaining stronger coverage / risk: Default-only identity sweep duplicated by the default/perturbed fingerprint owner; retain parameter-specific analytic pixels. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Auto Levels / Auto Contrast / Auto Color stretch a low-contrast ramp to black and white

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:67`. Detected failure: Auto Levels / Auto Contrast / Auto Color stretch a low-contrast ramp to black and white. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Convolution Kernel, Extract, Levels, Lighting Effects, ProcAmp

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:96`. Detected failure: Convolution Kernel, Extract, Levels, Lighting Effects, ProcAmp. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: blurs: camera, channel (alpha pads), compound (map), directional (one axis), interlace (vertical only)

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:127`. Detected failure: blurs: camera, channel (alpha pads), compound (map), directional (one axis), interlace (vertical only). Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Keep channel-alpha padding pixels; remove canvas allocation size assertion.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Sharpen and Unsharp Mask overshoot at an edge; Unsharp Mask respects its threshold

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:168`. Detected failure: Sharpen and Unsharp Mask overshoot at an edge; Unsharp Mask respects its threshold. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Invert channels and Blend With Original

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:177`. Detected failure: Invert channels and Blend With Original. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Arithmetic, Calculations, Compound Arithmetic, Blend, Set Matte, Solid Composite

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:186`. Detected failure: Arithmetic, Calculations, Compound Arithmetic, Blend, Set Matte, Solid Composite. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: colour corrections change what they should

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:258`. Detected failure: colour corrections change what they should. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Image Control: Color Balance (RGB), Color Pass, Color Replace, Gamma Correction

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:331`. Detected failure: Image Control: Color Balance (RGB), Color Pass, Color Replace, Gamma Correction. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Ultra Key removes the key colour, keeps other colours, and shows its matte

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:349`. Detected failure: Ultra Key removes the key colour, keeps other colours, and shows its matte. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Color Key, Luma Key, Non Red Key, Alpha Adjust, Remove Matte

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:369`. Detected failure: Color Key, Luma Key, Non Red Key, Alpha Adjust, Remove Matte. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Difference Matte, Image Matte Key and Track Matte Key use their media layers

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:395`. Detected failure: Difference Matte, Image Matte Key and Track Matte Key use their media layers. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: Drop Shadow and Radial Shadow draw into the padding

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:436`. Detected failure: Drop Shadow and Radial Shadow draw into the padding. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Keep independently specified shadow pixels; remove allocation width assertions.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Bevel Alpha / Bevel Edges light the upper-left and shade the lower-right; Basic 3D; Transform; Edge Feather

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:480`. Detected failure: Bevel Alpha / Bevel Edges light the upper-left and shade the lower-right; Basic 3D; Transform; Edge Feather. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Cineon Converter maps the 10-bit black/white points to black/white

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts:533`. Detected failure: Cineon Converter maps the 10-bit black/white points to black/white. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts

### DELETE: Drop Shadow: Premiere direction 90° casts to the right, into the padding

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts:72`. Detected failure: Drop Shadow: Premiere direction 90° casts to the right, into the padding. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free.
- Remaining stronger coverage / risk: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

### DELETE: Ultra Key removes a green solid; a red one stays

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts:92`. Detected failure: Ultra Key removes a green solid; a red one stays. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free.
- Remaining stronger coverage / risk: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

### DELETE: Auto Levels restores a darkened frame (analysis passes); Basic 3D turns it

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts:108`. Detected failure: Auto Levels restores a darkened frame (analysis passes); Basic 3D turns it. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free.
- Remaining stronger coverage / risk: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

### DELETE: Track Matte Key: an opaque matte keeps the frame, reversed it hides it

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts:127`. Detected failure: Track Matte Key: an opaque matte keeps the frame, reversed it hides it. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free.
- Remaining stronger coverage / risk: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

### DELETE: photo stills for a visual check (PACG_PHOTOS)

- Baseline case: `packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts:143`. Detected failure: photo stills for a visual check (PACG_PHOTOS). Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free.
- Remaining stronger coverage / risk: Replays individual shader behavior already protected more precisely by fx-premiere-adjust-color-keying-gl; actual source decoding, padding and matte integration remain in fx-render and masks-render. Photo case is assertion-free. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-premiere-adjust-color-keying.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/fx-psdg-render.e2e.test.ts

### DELETE: renders every effect of the family over the picture

- Baseline case: `packages/compositions/test/fx-psdg-render.e2e.test.ts:163`. Detected failure: renders every effect of the family over the picture. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: An arbitrary visible change is sufficient, including wrong output; GL default/perturbed fingerprints are the stronger owner. Contact-sheet support has no regression contract.
- Remaining stronger coverage / risk: An arbitrary visible change is sufficient, including wrong output; GL default/perturbed fingerprints are the stronger owner. Contact-sheet support has no regression contract. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-psdg-render.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/fx-render.e2e.test.ts

### KEEP: solid + generator: the gradient fills the layer

- Baseline case: `packages/compositions/test/fx-render.e2e.test.ts:66`. Detected failure: solid + generator: the gradient fills the layer. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: still + drop shadow: the shadow is drawn outside the layer box (padding)

- Baseline case: `packages/compositions/test/fx-render.e2e.test.ts:77`. Detected failure: still + drop shadow: the shadow is drawn outside the layer box (padding). Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: video + half-opacity generator: the decoded frame goes through the chain upright

- Baseline case: `packages/compositions/test/fx-render.e2e.test.ts:90`. Detected failure: video + half-opacity generator: the decoded frame goes through the chain upright. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: time remap: a freeze frame shows the source at the frozen frame

- Baseline case: `packages/compositions/test/fx-render.e2e.test.ts:109`. Detected failure: time remap: a freeze frame shows the source at the frozen frame. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: time samples: an earlier frame is decoded for its own frame (deterministic)

- Baseline case: `packages/compositions/test/fx-render.e2e.test.ts:126`. Detected failure: time samples: an earlier frame is decoded for its own frame (deterministic). Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: time samples compose with remaps: an echo below a freeze shows the frozen picture

- Baseline case: `packages/compositions/test/fx-render.e2e.test.ts:138`. Detected failure: time samples compose with remaps: an echo below a freeze shows the frozen picture. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: params at sub-frame times: Transform Shutter Angle motion-blurs keyframed motion

- Baseline case: `packages/compositions/test/fx-render.e2e.test.ts:159`. Detected failure: params at sub-frame times: Transform Shutter Angle motion-blurs keyframed motion. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: shape (DOM layer, HTML-in-Canvas) + drop shadow

- Baseline case: `packages/compositions/test/fx-render.e2e.test.ts:177`. Detected failure: shape (DOM layer, HTML-in-Canvas) + drop shadow. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-render.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sapphire-adjust-composite.e2e.test.ts

### REWRITE: renders every effect of the family

- Baseline case: `packages/compositions/test/fx-sapphire-adjust-composite.e2e.test.ts:283`. Detected failure: renders every effect of the family. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Keep real media-mask inside/outside pixel behavior and background outside alpha foreground; remove catalogue diff sweep and unused scene fixtures.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-adjust-composite.e2e.test.ts --maxWorkers=1`; package typecheck.

### DELETE: writes the contact sheet

- Baseline case: `packages/compositions/test/fx-sapphire-adjust-composite.e2e.test.ts:312`. Detected failure: writes the contact sheet. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Assertion-free image generation plus existence check; no editor contract.
- Remaining stronger coverage / risk: Assertion-free image generation plus existence check; no editor contract. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-adjust-composite.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts

### REWRITE: runs all 24 effects with their defaults; transparent input stays transparent

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:53`. Detected failure: runs all 24 effects with their defaults; transparent input stays transparent. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Keep transparent input preservation; remove family cardinality.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: identity settings give the source back

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:62`. Detected failure: identity settings give the source back. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: magnifiers enlarge the centre disc; a pinch shrinks it

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:92`. Detected failure: magnifiers enlarge the centre disc; a pinch shrinks it. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: S_WarpTransform moves the picture and pads the layer to keep it

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:102`. Detected failure: S_WarpTransform moves the picture and pads the layer to keep it. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Keep moved and newly transparent pixels plus wrap; remove exact canvas growth.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_WarpCornerPin: inside the quad the picture, outside transparent

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:124`. Detected failure: S_WarpCornerPin: inside the quad the picture, outside transparent. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_WarpPolar draws a disk: transparent outside the outer radius, the picture inside

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:144`. Detected failure: S_WarpPolar draws a disk: transparent outside the outer radius, the picture inside. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: S_Shake: deterministic per seed, different seeds differ, moves over time, pads small layers

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:156`. Detected failure: S_Shake: deterministic per seed, different seeds differ, moves over time, pads small layers. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Keep deterministic/time/seed output; remove canvas allocation.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: random and animated warps: seeds and time change the picture deterministically

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:174`. Detected failure: random and animated warps: seeds and time change the picture deterministically. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: S_WarpDrops ripples around the bright spots of the Centers map only

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:194`. Detected failure: S_WarpDrops ripples around the bright spots of the Centers map only. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Keep localized distortion/output; remove unused probe/nonempty check.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_Distort follows the Lens: a flat lens changes nothing, the dots lens warps

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:230`. Detected failure: S_Distort follows the Lens: a flat lens changes nothing, the dots lens warps. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_DistortRGB separates the channels at lens edges

- Baseline case: `packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts:238`. Detected failure: S_DistortRGB separates the channels at lens edges. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts

### DELETE: S_FilmDamage: animated per frame, identical when a frame is rendered again

- Baseline case: `packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts:85`. Detected failure: S_FilmDamage: animated per frame, identical when a frame is rendered again. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Duplicates retained family GL FilmDamage determinism/seed/time checks; decoded-time DigitalDamage contract remains.
- Remaining stronger coverage / risk: Duplicates retained family GL FilmDamage determinism/seed/time checks; decoded-time DigitalDamage contract remains. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_DigitalDamage freeze shows the held frame (time sample)

- Baseline case: `packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts:96`. Detected failure: S_DigitalDamage freeze shows the held frame (time sample). Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts --maxWorkers=1`; package typecheck.

### DELETE: every effect of the family renders (frame 10)

- Baseline case: `packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts:119`. Detected failure: every effect of the family renders (frame 10). Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Decoded byte length permits black or wrong output; fx-gl fingerprints and family GL behavior own this.
- Remaining stronger coverage / risk: Decoded byte length permits black or wrong output; fx-gl fingerprints and family GL behavior own this. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts --maxWorkers=1`; package typecheck.

### DELETE: writes stills of every effect on a picture (FX_FILM_STILLS)

- Baseline case: `packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts:128`. Detected failure: writes stills of every effect on a picture (FX_FILM_STILLS). Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Assertion-free manual still generator, not a regression; no behavioral coverage removed.
- Remaining stronger coverage / risk: Assertion-free manual still generator, not a regression; no behavioral coverage removed. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts

### DELETE: compiles and runs %s with default params (opaque and transparent input)

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:60`. Detected failure: compiles and runs %s with default params (opaque and transparent input). Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Compilation/no-throw-only sweep duplicated by fx-gl default and perturbed fingerprints.
- Remaining stronger coverage / risk: Compilation/no-throw-only sweep duplicated by fx-gl default and perturbed fingerprints. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: %s adds light next to a bright source and leaves far black alone

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:67`. Detected failure: %s adds light next to a bright source and leaves far black alone. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_Glow: Width X stretches the glow horizontally; Show Threshold shows the threshold image

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:77`. Detected failure: S_Glow: Width X stretches the glow horizontally; Show Threshold shows the threshold image. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: S_Glow pads the canvas and lights transparent pixels outside the layer box (Expand Borders)

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:87`. Detected failure: S_Glow pads the canvas and lights transparent pixels outside the layer box (Expand Borders). Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Observe halo alpha outside the source and zero alpha with Expand Borders disabled; remove canvas-size stand-in.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_GlowDarks and S_GlowOrthicon darken (around) their sources

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:101`. Detected failure: S_GlowDarks and S_GlowOrthicon darken (around) their sources. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_Rays casts light away from Center; S_Streaks smears the brights

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:110`. Detected failure: S_Rays casts light away from Center; S_Streaks smears the brights. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_LensFlare draws its hotspot at the Hotspot point; S_LensFlareAutoTrack finds the bright dot

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:128`. Detected failure: S_LensFlare draws its hotspot at the Hotspot point; S_LensFlareAutoTrack finds the bright dot. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_DropShadow draws the shifted shadow outside the layer box, under the layer

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:143`. Detected failure: S_DropShadow draws the shifted shadow outside the layer box, under the layer. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_SpotLight lights the aim point and leaves the rest at the ambient level

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:158`. Detected failure: S_SpotLight lights the aim point and leaves the rest at the ambient level. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_Light3D relights the relief of the image (no Normals clip)

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:172`. Detected failure: S_Light3D relights the relief of the image (no Normals clip). Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_BokehLights is deterministic and changes with the seed

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:178`. Detected failure: S_BokehLights is deterministic and changes with the seed. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_Flashbulbs is deterministic per frame and changes between frames

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:184`. Detected failure: S_Flashbulbs is deterministic per frame and changes between frames. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_LightLeak drifts over time

- Baseline case: `packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts:192`. Detected failure: S_LightLeak drifts over time. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts

### REWRITE: runs all 30 effects, and Mix with Orig = 1 gives the input back

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:33`. Detected failure: runs all 30 effects, and Mix with Orig = 1 gives the input back. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Keep exact Mix With Original endpoint; remove registry inventory and generic default-change sweep.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: kaleidoscopes and tiles are the identity at Kaleido Amount 0 / unit zoom

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:43`. Detected failure: kaleidoscopes and tiles are the identity at Kaleido Amount 0 / unit zoom. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_Kaleido:Squares mirrors the picture around the centre

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:56`. Detected failure: S_Kaleido:Squares mirrors the picture around the centre. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: edges: a black|white step lights up only at the edge; direction and colour follow the edge side

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:71`. Detected failure: edges: a black|white step lights up only at the edge; direction and colour follow the edge side. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: halftones: black where the picture is black, paper where it is white

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:108`. Detected failure: halftones: black where the picture is black, paper where it is white. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: posterize quantises a ramp into a few levels

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:127`. Detected failure: posterize quantises a ramp into a few levels. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: emboss keeps a flat picture and shades a relief from the light side

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:140`. Detected failure: emboss keeps a flat picture and shades a relief from the light side. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: transparent input stays transparent

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:156`. Detected failure: transparent input stays transparent. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: seeded strokes: deterministic, different per seed, stable over time unless jittered

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:172`. Detected failure: seeded strokes: deterministic, different per seed, stable over time unless jittered. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

### DELETE: S_Brush Soft Borders paints into the padding; otherwise nothing leaves the layer box

- Baseline case: `packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts:199`. Detected failure: S_Brush Soft Borders paints into the padding; otherwise nothing leaves the layer box. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Only canvas dimensions are asserted; the claimed painted pixels are never checked. Perturbed brush fingerprint covers visible borders.
- Remaining stronger coverage / risk: Only canvas dimensions are asserted; the claimed painted pixels are never checked. Perturbed brush fingerprint covers visible borders. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sapphire-stylize-other.e2e.test.ts

### DELETE: every effect renders and changes the picture

- Baseline case: `packages/compositions/test/fx-sapphire-stylize-other.e2e.test.ts:151`. Detected failure: every effect renders and changes the picture. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Any changed picture passes, including corruption; default/perturbed GL fingerprints are stronger and the temporal PixelMosh integration remains.
- Remaining stronger coverage / risk: Any changed picture passes, including corruption; default/perturbed GL fingerprints are stronger and the temporal PixelMosh integration remains. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-stylize-other.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_PixelMosh: the held frame moshed by the zoom, deterministic across renders

- Baseline case: `packages/compositions/test/fx-sapphire-stylize-other.e2e.test.ts:163`. Detected failure: S_PixelMosh: the held frame moshed by the zoom, deterministic across renders. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-stylize-other.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts

### DELETE: compiles and runs all 21 generators at several frames

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:55`. Detected failure: compiles and runs all 21 generators at several frames. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Count and compile probe duplicated by family fingerprints; no independent output oracle.
- Remaining stronger coverage / risk: Count and compile probe duplicated by family fingerprints; no independent output oracle. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: draws a non-flat, opaque texture with default params

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:60`. Detected failure: draws a non-flat, opaque texture with default params. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: animates continuously: small change per frame, more over seconds (still textures stay still)

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:70`. Detected failure: animates continuously: small change per frame, more over seconds (still textures stay still). Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: is deterministic; the Seed param and the instance seed change the pattern

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:88`. Detected failure: is deterministic; the Seed param and the instance seed change the pattern. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: combine, background brightness, output opacity and mix with original

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:100`. Detected failure: combine, background brightness, output opacity and mix with original. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: tiles: a tile sits on the layer centre; Invert swaps it

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:121`. Detected failure: tiles: a tile sits on the layer centre; Invert swaps it. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: spots: without warp, spots on the cell centres and gaps on the corners

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:131`. Detected failure: spots: without warp, spots on the cell centres and gaps on the corners. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: moire: the rings are centred on A Center (bright crest at phase 0)

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:139`. Detected failure: moire: the rings are centred on A Center (bright crest at phase 0). Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: clouds perspective: past the horizon the clouds fade to their mean

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:154`. Detected failure: clouds perspective: past the horizon the clouds fade to their mean. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: plasma and neurons: the glow adds light around the lines

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:160`. Detected failure: plasma and neurons: the glow adds light around the lines. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: noise paint: Jitter Frames re-randomises the strokes only every N frames

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts:171`. Detected failure: noise paint: Jitter Frames re-randomises the strokes only every N frames. Production owner/non-test callers: `project registry/fx family shaders + fx/host.ts; FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): effect parameter semantics and alpha/determinism contracts; docs/wp-notes/fx-shader-framework.md §§3–9; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU pixel output at explicit effect settings.
- Bar 3 (independent expectation): fixed fixture colors, analytic endpoint/direction relations or repeat/seed/frame comparisons. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU pixel output at explicit effect settings; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named parameter endpoint/alpha/temporal interaction beyond one default and one jointly perturbed fingerprint. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sapphire-textures-clouds.e2e.test.ts

### DELETE: every generator renders a textured frame

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds.e2e.test.ts:80`. Detected failure: every generator renders a textured frame. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Repeats the retained generator variance/alpha and temporal GL contracts through an extra layer; fx-render already owns generic sequence shader integration.
- Remaining stronger coverage / risk: Repeats the retained generator variance/alpha and temporal GL contracts through an extra layer; fx-render already owns generic sequence shader integration. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

### DELETE: animated clouds move between frames; a time-invariant texture does not

- Baseline case: `packages/compositions/test/fx-sapphire-textures-clouds.e2e.test.ts:91`. Detected failure: animated clouds move between frames; a time-invariant texture does not. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Repeats the retained generator variance/alpha and temporal GL contracts through an extra layer; fx-render already owns generic sequence shader integration.
- Remaining stronger coverage / risk: Repeats the retained generator variance/alpha and temporal GL contracts through an extra layer; fx-render already owns generic sequence shader integration. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-textures-clouds.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts

### KEEP: S_FreezeFrame holds the first frame of each group; S_ReverseClip plays backwards

- Baseline case: `packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts:174`. Detected failure: S_FreezeFrame holds the first frame of each group; S_ReverseClip plays backwards. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_Trails is deterministic under out-of-order renders

- Baseline case: `packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts:189`. Detected failure: S_Trails is deterministic under out-of-order renders. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_FlickerRemove flattens the frame-to-frame brightness of a flickering clip

- Baseline case: `packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts:199`. Detected failure: S_FlickerRemove flattens the frame-to-frame brightness of a flickering clip. Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-shader-framework.md §§3/§9/§17; AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real decoded-video/DOM capture or Player pixel output.
- Bar 3 (independent expectation): fixed source-frame controls, temporal/seed invariants and independent color expectations. These expectations can disagree with the owner.
- Bar 4 (stable seam): real decoded-video/DOM capture or Player pixel output; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): real source capture/seek/media loading case that synthetic-texture shader tests cannot exercise. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts --maxWorkers=1`; package typecheck.

### DELETE: renders every effect of the family (contact sheet with FX_CONTACT_SHEET)

- Baseline case: `packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts:212`. Detected failure: renders every effect of the family (contact sheet with FX_CONTACT_SHEET). Production owner/non-test callers: `fx/FxPicture.tsx, time.ts, sources.tsx; SequenceComposition preview/export consumers`.
- Decision: Byte-length assertions and contact-sheet generation; temporal contracts have three focused real-video cases and GL fingerprints.
- Remaining stronger coverage / risk: Byte-length assertions and contact-sheet generation; temporal contracts have three focused real-video cases and GL fingerprints. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-sim-warp-gl.test.ts

### DELETE: gallery (SIM_GALLERY)

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:138`. Detected failure: gallery (SIM_GALLERY). Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Assertion-free gallery generator; parameter/alpha/temporal pixel contracts remain.
- Remaining stronger coverage / risk: Assertion-free gallery generator; parameter/alpha/temporal pixel contracts remain. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: compiles and runs every effect of the family

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:148`. Detected failure: compiles and runs every effect of the family. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Keep the independent premultiplied-alpha invariant checked by the harness; remove family count.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: weather: rain, snow, bubbles, drizzle, star burst

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:155`. Detected failure: weather: rain, snow, bubbles, drizzle, star burst. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: particles: types, seek = play, gravity, floor, guides, 2D direction, mercury

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:171`. Detected failure: particles: types, seek = play, gravity, floor, guides, 2D direction, mercury. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: cards: Card Dance, Card Wipe, Pixel Polly

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:186`. Detected failure: cards: Card Dance, Card Wipe, Pixel Polly. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: shatter: intact at rest for every pattern, breaks, render modes, wireframes

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:200`. Detected failure: shatter: intact at rest for every pattern, breaks, render modes, wireframes. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: pixel effects: Ball Action, Scatterize, Hair

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:213`. Detected failure: pixel effects: Ball Action, Scatterize, Hair. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: surfaces: Foam, Wave World, Caustics

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:226`. Detected failure: surfaces: Foam, Wave World, Caustics. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Particle Playground: cannon seek, gravity, wall, repel, text, layer exploder

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:242`. Detected failure: Particle Playground: cannon seek, gravity, wall, repel, text, layer exploder. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: distort: Displacement Map, Optics Compensation, Polar, Bezier Warp, Reshape, Smear

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:256`. Detected failure: distort: Displacement Map, Optics Compensation, Polar, Bezier Warp, Reshape, Smear. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: warps: Mesh Warp, Liquify, Puppet

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:270`. Detected failure: warps: Mesh Warp, Liquify, Puppet. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Keep warp pixels and disabled/rest behavior; remove padded-canvas dimension assertion.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: ${c.id}: deterministic${c.seeded === false ? '' : ', seeded'}${c.animated === false ? '' : ', animated'}

- Baseline case: `packages/compositions/test/fx-sim-warp-gl.test.ts:321`. Detected failure: ${c.id}: deterministic${c.seeded === false ? '' : ', seeded'}${c.animated === false ? '' : ', animated'}. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-sim-warp-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/fx-warp-stabilizer-gl.test.ts

### KEEP: No Motion locks the frame (${method})

- Baseline case: `packages/compositions/test/fx-warp-stabilizer-gl.test.ts:18`. Detected failure: No Motion locks the frame (${method}). Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-warp-stabilizer-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Subspace Warp renders through its mesh

- Baseline case: `packages/compositions/test/fx-warp-stabilizer-gl.test.ts:26`. Detected failure: Subspace Warp renders through its mesh. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-warp-stabilizer-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: Stabilize Only leaves the uncovered edge transparent; no analysis passes through

- Baseline case: `packages/compositions/test/fx-warp-stabilizer-gl.test.ts:34`. Detected failure: Stabilize Only leaves the uncovered edge transparent; no analysis passes through. Production owner/non-test callers: `project registry/fx/simulation-warp + fx/host.ts; real effect-chain consumers`.
- Decision: Retain the independent outcome; remove shared-unit cancellation or collaborator/fixture self-assertions as detailed in the final retained-test rescan ledger.
- Bar 1 (independent source): docs/wp-notes/sim-warp.md and documented camera-path/particle physics; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real GPU image statistics/displacement.
- Bar 3 (independent expectation): synthetic known camera path, rest/disabled identities, gravity direction, alpha conservation and seed/frame invariants. These expectations can disagree with the owner.
- Bar 4 (stable seam): real GPU image statistics/displacement; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): dynamic/state/structured-input case absent from one-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/fx-warp-stabilizer-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/imports-layers.test.tsx

### REWRITE: samples the Lottie frame at the clip time

- Baseline case: `packages/compositions/test/imports-layers.test.tsx:61`. Detected failure: samples the Lottie frame at the clip time. Production owner/non-test callers: `layers/LottieLayer.tsx, called by SequenceComposition`.
- Decision: Retain the independent outcome; remove shared-unit cancellation or collaborator/fixture self-assertions as detailed in the final retained-test rescan ledger.
- Bar 1 (independent source): docs/wp-notes/imports.md §1/§4; interpreted file-time/Lottie frame protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through pure Lottie media-time to frame boundary.
- Bar 3 (independent expectation): 25 fps, first frame 5, last 54, doubled rate and two-second loop as fixed fixture facts. These expectations can disagree with the owner.
- Bar 4 (stable seam): pure Lottie media-time to frame boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): combination of Lottie in-frame offset with interpretation/loop beyond parser/model sampling alone. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/imports-layers.test.tsx --maxWorkers=1`; package typecheck.

### REWRITE: follows an assumed frame rate and a loop (Interpret Footage)

- Baseline case: `packages/compositions/test/imports-layers.test.tsx:68`. Detected failure: follows an assumed frame rate and a loop (Interpret Footage). Production owner/non-test callers: `layers/LottieLayer.tsx, called by SequenceComposition`.
- Decision: Retain the independent outcome; remove shared-unit cancellation or collaborator/fixture self-assertions as detailed in the final retained-test rescan ledger.
- Bar 1 (independent source): docs/wp-notes/imports.md §1/§4; interpreted file-time/Lottie frame protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through pure Lottie media-time to frame boundary.
- Bar 3 (independent expectation): 25 fps, first frame 5, last 54, doubled rate and two-second loop as fixed fixture facts. These expectations can disagree with the owner.
- Bar 4 (stable seam): pure Lottie media-time to frame boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): combination of Lottie in-frame offset with interpretation/loop beyond parser/model sampling alone. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/imports-layers.test.tsx --maxWorkers=1`; package typecheck.

### DELETE: is the largest Motion scale rounded up to a power of two

- Baseline case: `packages/compositions/test/imports-layers.test.tsx:102`. Detected failure: is the largest Motion scale rounded up to a power of two. Production owner/non-test callers: `layers/LottieLayer.tsx, called by SequenceComposition`.
- Decision: Exact power-of-two allocation strategy is an internal implementation policy; import render verification owns image fidelity.
- Remaining stronger coverage / risk: Exact power-of-two allocation strategy is an internal implementation policy; import render verification owns image fidelity. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/imports-layers.test.tsx --maxWorkers=1`; package typecheck.

### DELETE: never makes a picture larger than the cap

- Baseline case: `packages/compositions/test/imports-layers.test.tsx:109`. Detected failure: never makes a picture larger than the cap. Production owner/non-test callers: `layers/LottieLayer.tsx, called by SequenceComposition`.
- Decision: Cap assertion compares against implementation constant and explicitly blesses oversized inputs at scale 1; it does not prove its claimed allocation safety.
- Remaining stronger coverage / risk: Cap assertion compares against implementation constant and explicitly blesses oversized inputs at scale 1; it does not prove its claimed allocation safety. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/imports-layers.test.tsx --maxWorkers=1`; package typecheck.

## packages/compositions/test/lottie-assets.test.ts

### DELETE: shares one validated document between simultaneous consumers

- Baseline case: `packages/compositions/test/lottie-assets.test.ts:51`. Detected failure: shares one validated document between simultaneous consumers. Production owner/non-test callers: `layers/lottie.ts and thumbnails.ts; LottieLayer, Project/Source thumbnails`.
- Decision: Promise identity and fetch count enforce cache mechanics; retry/error validation remains.
- Remaining stronger coverage / risk: Promise identity and fetch count enforce cache mechanics; retry/error validation remains. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/lottie-assets.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: evicts failed reads so a repaired document can load

- Baseline case: `packages/compositions/test/lottie-assets.test.ts:59`. Detected failure: evicts failed reads so a repaired document can load. Production owner/non-test callers: `layers/lottie.ts and thumbnails.ts; LottieLayer, Project/Source thumbnails`.
- Decision: Keep repaired-document success following INVALID_LOTTIE, without asserting HTTP call count.
- Bar 1 (independent source): AGENTS.md §0 typed input failures and bounded jobs; docs/wp-notes/imports.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through document-load promise or thumbnail success/error resource lifecycle.
- Bar 3 (independent expectation): malformed JSON, explicit missing SVG and deliberately stalled external player. These expectations can disagree with the owner.
- Bar 4 (stable seam): document-load promise or thumbnail success/error resource lifecycle; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): failure/retry/resource lifecycle not covered by successful Lottie renders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/lottie-assets.test.ts --maxWorkers=1`; package typecheck.

### KEEP: rejects non-object JSON instead of passing it to the player

- Baseline case: `packages/compositions/test/lottie-assets.test.ts:67`. Detected failure: rejects non-object JSON instead of passing it to the player. Production owner/non-test callers: `layers/lottie.ts and thumbnails.ts; LottieLayer, Project/Source thumbnails`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): AGENTS.md §0 typed input failures and bounded jobs; docs/wp-notes/imports.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through document-load promise or thumbnail success/error resource lifecycle.
- Bar 3 (independent expectation): malformed JSON, explicit missing SVG and deliberately stalled external player. These expectations can disagree with the owner.
- Bar 4 (stable seam): document-load promise or thumbnail success/error resource lifecycle; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): failure/retry/resource lifecycle not covered by successful Lottie renders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/lottie-assets.test.ts --maxWorkers=1`; package typecheck.

### DELETE: seeks the validated frame range and releases the player and host

- Baseline case: `packages/compositions/test/lottie-assets.test.ts:79`. Detected failure: seeks the validated frame range and releases the player and host. Production owner/non-test callers: `layers/lottie.ts and thumbnails.ts; LottieLayer, Project/Source thumbnails`.
- Decision: Mock inserts the only SVG; success/data URL assertions merely serialize that stub and inspect seek/destroy calls. Real imported Lottie workflow owns the picture.
- Remaining stronger coverage / risk: Mock inserts the only SVG; success/data URL assertions merely serialize that stub and inspect seek/destroy calls. Real imported Lottie workflow owns the picture. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/lottie-assets.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: rejects a missing picture instead of returning an empty SVG

- Baseline case: `packages/compositions/test/lottie-assets.test.ts:87`. Detected failure: rejects a missing picture instead of returning an empty SVG. Production owner/non-test callers: `layers/lottie.ts and thumbnails.ts; LottieLayer, Project/Source thumbnails`.
- Decision: Retain the independent outcome; remove shared-unit cancellation or collaborator/fixture self-assertions as detailed in the final retained-test rescan ledger.
- Bar 1 (independent source): AGENTS.md §0 typed input failures and bounded jobs; docs/wp-notes/imports.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through document-load promise or thumbnail success/error resource lifecycle.
- Bar 3 (independent expectation): malformed JSON, explicit missing SVG and deliberately stalled external player. These expectations can disagree with the owner.
- Bar 4 (stable seam): document-load promise or thumbnail success/error resource lifecycle; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): failure/retry/resource lifecycle not covered by successful Lottie renders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/lottie-assets.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: rejects a stalled renderer and releases its listeners and player

- Baseline case: `packages/compositions/test/lottie-assets.test.ts:95`. Detected failure: rejects a stalled renderer and releases its listeners and player. Production owner/non-test callers: `layers/lottie.ts and thumbnails.ts; LottieLayer, Project/Source thumbnails`.
- Decision: Retain the independent outcome; remove shared-unit cancellation or collaborator/fixture self-assertions as detailed in the final retained-test rescan ledger.
- Bar 1 (independent source): AGENTS.md §0 typed input failures and bounded jobs; docs/wp-notes/imports.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through document-load promise or thumbnail success/error resource lifecycle.
- Bar 3 (independent expectation): malformed JSON, explicit missing SVG and deliberately stalled external player. These expectations can disagree with the owner.
- Bar 4 (stable seam): document-load promise or thumbnail success/error resource lifecycle; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): failure/retry/resource lifecycle not covered by successful Lottie renders. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/lottie-assets.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/masks-gl.test.ts

### DELETE: has WebGL2

- Baseline case: `packages/compositions/test/masks-gl.test.ts:46`. Detected failure: has WebGL2. Production owner/non-test callers: `fx/mask.ts, effects.ts, matte.ts; layer chains and SequenceComposition`.
- Decision: Environment probe duplicated by all real pixel cases.
- Remaining stronger coverage / risk: Environment probe duplicated by all real pixel cases. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/masks-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: GL coverage equals the CPU rasteriser: ${name}

- Baseline case: `packages/compositions/test/masks-gl.test.ts:103`. Detected failure: GL coverage equals the CPU rasteriser: ${name}. Production owner/non-test callers: `fx/mask.ts, effects.ts, matte.ts; layer chains and SequenceComposition`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): mask modes/coverage contract; docs/testing.md §2 and AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through coverage/image bytes through actual GL or render integration.
- Bar 3 (independent expectation): independent CPU mask rasterizer or hard-coded inside/outside colored regions. These expectations can disagree with the owner.
- Bar 4 (stable seam): coverage/image bytes through actual GL or render integration; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): mode/feather/hidden-track/source-capture combination here not sampled by default FX fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/masks-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Opacity masks and a masked effect inside the effect chain

- Baseline case: `packages/compositions/test/masks-gl.test.ts:123`. Detected failure: Opacity masks and a masked effect inside the effect chain. Production owner/non-test callers: `fx/mask.ts, effects.ts, matte.ts; layer chains and SequenceComposition`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): mask modes/coverage contract; docs/testing.md §2 and AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through coverage/image bytes through actual GL or render integration.
- Bar 3 (independent expectation): independent CPU mask rasterizer or hard-coded inside/outside colored regions. These expectations can disagree with the owner.
- Bar 4 (stable seam): coverage/image bytes through actual GL or render integration; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): mode/feather/hidden-track/source-capture combination here not sampled by default FX fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/masks-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/masks-render.e2e.test.ts

### KEEP: Opacity masks: every pixel equals the CPU coverage (the native kernel’s) within 2/255

- Baseline case: `packages/compositions/test/masks-render.e2e.test.ts:67`. Detected failure: Opacity masks: every pixel equals the CPU coverage (the native kernel’s) within 2/255. Production owner/non-test callers: `fx/mask.ts, effects.ts, matte.ts; layer chains and SequenceComposition`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): mask modes/coverage contract; docs/testing.md §2 and AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through coverage/image bytes through actual GL or render integration.
- Bar 3 (independent expectation): independent CPU mask rasterizer or hard-coded inside/outside colored regions. These expectations can disagree with the owner.
- Bar 4 (stable seam): coverage/image bytes through actual GL or render integration; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): mode/feather/hidden-track/source-capture combination here not sampled by default FX fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/masks-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a masked effect applies inside its mask only

- Baseline case: `packages/compositions/test/masks-render.e2e.test.ts:107`. Detected failure: a masked effect applies inside its mask only. Production owner/non-test callers: `fx/mask.ts, effects.ts, matte.ts; layer chains and SequenceComposition`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): mask modes/coverage contract; docs/testing.md §2 and AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through coverage/image bytes through actual GL or render integration.
- Bar 3 (independent expectation): independent CPU mask rasterizer or hard-coded inside/outside colored regions. These expectations can disagree with the owner.
- Bar 4 (stable seam): coverage/image bytes through actual GL or render integration; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): mode/feather/hidden-track/source-capture combination here not sampled by default FX fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/masks-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Track Matte Key reads a hidden track: alpha, luma and reverse

- Baseline case: `packages/compositions/test/masks-render.e2e.test.ts:129`. Detected failure: Track Matte Key reads a hidden track: alpha, luma and reverse. Production owner/non-test callers: `fx/mask.ts, effects.ts, matte.ts; layer chains and SequenceComposition`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): mask modes/coverage contract; docs/testing.md §2 and AGENTS.md §4; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through coverage/image bytes through actual GL or render integration.
- Bar 3 (independent expectation): independent CPU mask rasterizer or hard-coded inside/outside colored regions. These expectations can disagree with the owner.
- Bar 4 (stable seam): coverage/image bytes through actual GL or render integration; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): mode/feather/hidden-track/source-capture combination here not sampled by default FX fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/masks-render.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/mg-host-remote.test.ts

### DELETE: the host iframe is sandboxed to scripts only, and the bootstrap installs the agent

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:101`. Detected failure: the host iframe is sandboxed to scripts only, and the bootstrap installs the agent. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Asserts an exported sandbox string against itself and greps private bootstrap identifiers; real sandbox integration owns isolation and remaining MessagePort tests execute the agent.
- Remaining stronger coverage / risk: Asserts an exported sandbox string against itself and greps private bootstrap identifiers; real sandbox integration owns isolation and remaining MessagePort tests execute the agent. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: drives the renderer-page protocol: evaluate, calculate, mount with overrides, seek (clamped), re-seek on new props

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:110`. Detected failure: drives the renderer-page protocol: evaluate, calculate, mount with overrides, seek (clamped), re-seek on new props. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independent outcome; remove shared-unit cancellation or collaborator/fixture self-assertions as detailed in the final retained-test rescan ledger.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: reports page failures as typed errors, one line, never a stack

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:142`. Detected failure: reports page failures as typed errors, one line, never a stack. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: reaches the text probe through the port: locate, hide, restore, fonts

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:156`. Detected failure: reaches the text probe through the port: locate, hide, restore, fonts. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: the agent takes its port only from the embedding window, and knows no other operation

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:177`. Detected failure: the agent takes its port only from the embedding window, and knows no other operation. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: replaces localStorage, sessionStorage and document.cookie only where the real ones throw

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:219`. Detected failure: replaces localStorage, sessionStorage and document.cookie only where the real ones throw. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: refuses metadata that would size layers and buffers by the page’s word

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:274`. Detected failure: refuses metadata that would size layers and buffers by the page’s word. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a page that answers configure with garbage is a protocol error, not a crash

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:293`. Detected failure: a page that answers configure with garbage is a protocol error, not a crash. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: error codes and messages from the page are bounded and mapped to known codes

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:302`. Detected failure: error codes and messages from the page are bounded and mapped to known codes. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a page that never answers times out; replies to unknown or reused ids are ignored

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:315`. Detected failure: a page that never answers times out; replies to unknown or reused ids are ignored. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: measurements are matched to what was asked and scrubbed

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:350`. Detected failure: measurements are matched to what was asked and scrubbed. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: font sources may only point at bundle files of the editor’s origin, data: or https:

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:399`. Detected failure: font sources may only point at bundle files of the editor’s origin, data: or https:. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

### KEEP: fonts are bounded in count and bytes, and unsafe faces are dropped

- Baseline case: `packages/compositions/test/mg-host-remote.test.ts:432`. Detected failure: fonts are bounded in count and bytes, and unsafe faces are dropped. Production owner/non-test callers: `mg-host/remote.ts, agent.ts, protocol.ts; MgHostLayer and engine host consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/security-review.md MG-1; S08:MGC-003; renderer-page MessagePort protocol; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through MessagePort requests/replies and untrusted-input validation boundary.
- Bar 3 (independent expectation): hostile payloads, allowed origins, protocol codes, bounded limits fixed independently of sanitizer code. These expectations can disagree with the owner.
- Bar 4 (stable seam): MessagePort requests/replies and untrusted-input validation boundary; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): the particular hostile payload or protocol operation named here, absent from normal bundle-render tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/mg-host-remote.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/retime-frames.test.ts

### KEEP: CFR: forward, backward and random access show the right frame

- Baseline case: `packages/compositions/test/retime-frames.test.ts:79`. Detected failure: CFR: forward, backward and random access show the right frame. Production owner/non-test callers: `retime/frames.ts or flow-gl.ts; RetimedVideo/FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/time.md; CFR/VFR timestamp and frame-interpolation contracts; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through decoded frame codes or GPU output image.
- Bar 3 (independent expectation): fixture-authored timestamps/frame codes and independent CPU/translated-image oracle. These expectations can disagree with the owner.
- Bar 4 (stable seam): decoded frame codes or GPU output image; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): timestamp/priming/reverse/flow case here; shader fingerprints do not decode videos or interpolate motion. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/retime-frames.test.ts --maxWorkers=1`; package typecheck.

### KEEP: full-size decode, reverse across GOPs

- Baseline case: `packages/compositions/test/retime-frames.test.ts:111`. Detected failure: full-size decode, reverse across GOPs. Production owner/non-test callers: `retime/frames.ts or flow-gl.ts; RetimedVideo/FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/time.md; CFR/VFR timestamp and frame-interpolation contracts; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through decoded frame codes or GPU output image.
- Bar 3 (independent expectation): fixture-authored timestamps/frame codes and independent CPU/translated-image oracle. These expectations can disagree with the owner.
- Bar 4 (stable seam): decoded frame codes or GPU output image; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): timestamp/priming/reverse/flow case here; shader fingerprints do not decode videos or interpolate motion. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/retime-frames.test.ts --maxWorkers=1`; package typecheck.

### KEEP: an AAC track with encoder priming does not shift the frames (media time 0 = ffmpeg start_time)

- Baseline case: `packages/compositions/test/retime-frames.test.ts:123`. Detected failure: an AAC track with encoder priming does not shift the frames (media time 0 = ffmpeg start_time). Production owner/non-test callers: `retime/frames.ts or flow-gl.ts; RetimedVideo/FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/time.md; CFR/VFR timestamp and frame-interpolation contracts; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through decoded frame codes or GPU output image.
- Bar 3 (independent expectation): fixture-authored timestamps/frame codes and independent CPU/translated-image oracle. These expectations can disagree with the owner.
- Bar 4 (stable seam): decoded frame codes or GPU output image; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): timestamp/priming/reverse/flow case here; shader fingerprints do not decode videos or interpolate motion. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/retime-frames.test.ts --maxWorkers=1`; package typecheck.

### KEEP: VFR: frames by their real timestamps

- Baseline case: `packages/compositions/test/retime-frames.test.ts:138`. Detected failure: VFR: frames by their real timestamps. Production owner/non-test callers: `retime/frames.ts or flow-gl.ts; RetimedVideo/FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/time.md; CFR/VFR timestamp and frame-interpolation contracts; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through decoded frame codes or GPU output image.
- Bar 3 (independent expectation): fixture-authored timestamps/frame codes and independent CPU/translated-image oracle. These expectations can disagree with the owner.
- Bar 4 (stable seam): decoded frame codes or GPU output image; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): timestamp/priming/reverse/flow case here; shader fingerprints do not decode videos or interpolate motion. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/retime-frames.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/retime-gl.test.ts

### DELETE: has WebGL2 with float render targets

- Baseline case: `packages/compositions/test/retime-gl.test.ts:33`. Detected failure: has WebGL2 with float render targets. Production owner/non-test callers: `retime/frames.ts or flow-gl.ts; RetimedVideo/FxPicture consumers`.
- Decision: Environment-capability probe; real sampling/flow pixel comparisons already require the backend.
- Remaining stronger coverage / risk: Environment-capability probe; real sampling/flow pixel comparisons already require the backend. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/retime-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Frame Sampling and Frame Blending match the CPU exactly (±1 rounding)

- Baseline case: `packages/compositions/test/retime-gl.test.ts:37`. Detected failure: Frame Sampling and Frame Blending match the CPU exactly (±1 rounding). Production owner/non-test callers: `retime/frames.ts or flow-gl.ts; RetimedVideo/FxPicture consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/time.md; CFR/VFR timestamp and frame-interpolation contracts; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through decoded frame codes or GPU output image.
- Bar 3 (independent expectation): fixture-authored timestamps/frame codes and independent CPU/translated-image oracle. These expectations can disagree with the owner.
- Bar 4 (stable seam): decoded frame codes or GPU output image; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): timestamp/priming/reverse/flow case here; shader fingerprints do not decode videos or interpolate motion. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/retime-gl.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: Optical Flow at w = ${w}: same vectors and picture as the CPU reference

- Baseline case: `packages/compositions/test/retime-gl.test.ts:44`. Detected failure: Optical Flow at w = ${w}: same vectors and picture as the CPU reference. Production owner/non-test callers: `retime/frames.ts or flow-gl.ts; RetimedVideo/FxPicture consumers`.
- Decision: Keep GPU picture versus CPU and independently translated texture truth; remove raw private flow-vector readback.
- Bar 1 (independent source): docs/wp-notes/time.md; CFR/VFR timestamp and frame-interpolation contracts; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through decoded frame codes or GPU output image.
- Bar 3 (independent expectation): fixture-authored timestamps/frame codes and independent CPU/translated-image oracle. These expectations can disagree with the owner.
- Bar 4 (stable seam): decoded frame codes or GPU output image; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): timestamp/priming/reverse/flow case here; shader fingerprints do not decode videos or interpolate motion. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/retime-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/scope-nesting.e2e.test.ts

### DELETE: two tracks with GL blend modes (and a Normal track between them) render in one scope

- Baseline case: `packages/compositions/test/scope-nesting.e2e.test.ts:62`. Detected failure: two tracks with GL blend modes (and a Normal track between them) render in one scope. Production owner/non-test callers: `fx/flat.tsx, composite.tsx, SequenceComposition.tsx; preview/export consumers`.
- Decision: Same stacked GL/normal scene is retained as combo-gl-blends-stacked with independent reference plus golden in golden-scenes.e2e.test.ts.
- Remaining stronger coverage / risk: Same stacked GL/normal scene is retained as combo-gl-blends-stacked with independent reference plus golden in golden-scenes.e2e.test.ts. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/scope-nesting.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/serial-audio-context.test.ts

### REWRITE: a suspend right after a resume leaves the resume pending without the shim; with it every resume settles and the clock moves

- Baseline case: `packages/compositions/test/serial-audio-context.test.ts:57`. Detected failure: a suspend right after a resume leaves the resume pending without the shim; with it every resume settles and the clock moves. Production owner/non-test callers: `audio/serial-audio-context.ts; Player setup consumer`.
- Decision: Keep overlapping resume/suspend settlement and moving audio clock after installing shim; remove requirement that upstream Chrome must remain buggy.
- Bar 1 (independent source): credible Chrome AudioContext resume/suspend race regression; docs/wp-notes/code-audit-compositions.md; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real browser AudioContext resume/suspend promises and audio clock.
- Bar 3 (independent expectation): all requested resumes settle and time advances; no expected value from shim. These expectations can disagree with the owner.
- Bar 4 (stable seam): real browser AudioContext resume/suspend promises and audio clock; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): overlapping real native audio calls absent from deterministic DSP and static frame tests. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/serial-audio-context.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/text-animators.e2e.test.ts

### KEEP: a typewriter reveals left to right; the rest state equals plain text glyph extents

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:138`. Detected failure: a typewriter reveals left to right; the rest state equals plain text glyph extents. Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: position / rotation / fill colour / blur animators move and paint each character

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:166`. Detected failure: position / rotation / fill colour / blur animators move and paint each character. Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: a range selector on the first half selects only those characters

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:189`. Detected failure: a range selector on the first half selects only those characters. Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Keep half-range glyph output and require nonempty ink so total disappearance cannot pass.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Path Options: characters follow a mask path (perpendicular)

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:216`. Detected failure: Path Options: characters follow a mask path (perpendicular). Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: per-character 3D flip and a wiggly selector render deterministically

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:234`. Detected failure: per-character 3D flip and a wiggly selector render deterministically. Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### DELETE: typography: small caps, superscript, tracking and faux italic draw

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:246`. Detected failure: typography: small caps, superscript, tracking and faux italic draw. Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Only asserts some ink exists, so every named typography feature can be missing; retained glyph/axis/stroke tests and text goldens supply meaningful pixel checks.
- Remaining stronger coverage / risk: Only asserts some ink exists, so every named typography feature can be missing; retained glyph/axis/stroke tests and text goldens supply meaningful pixel checks. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: variable font axes: style wght and an animated wght offset change the stroke weight

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:273`. Detected failure: variable font axes: style wght and an animated wght offset change the stroke weight. Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: stroke, fill & stroke order, blur and inter-character blending render

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:296`. Detected failure: stroke, fill & stroke order, blur and inter-character blending render. Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Expression Selector: textIndex selects every other character (QuickJS in the renderer)

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:327`. Detected failure: Expression Selector: textIndex selects every other character (QuickJS in the renderer). Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

### REWRITE: an expression on an animator property drives it (bound in the snapshot)

- Baseline case: `packages/compositions/test/text-animators.e2e.test.ts:364`. Detected failure: an expression on an animator property drives it (bound in the snapshot). Production owner/non-test callers: `layers/text/ AnimatedText renderer; TextLayer/SequenceComposition consumers`.
- Decision: Keep expression-driven glyph position and require nonempty ink so blank output cannot pass.
- Bar 1 (independent source): S11:TXA/ANA; docs/wp-notes/text-animators.md §1.4–§1.6; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered glyph pixels after document commands.
- Bar 3 (independent expectation): known input strings, independently specified selector range, axis weight and expression constants. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered glyph pixels after document commands; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): named text feature at actual glyph rasterization beyond pure model selectors or one generic text golden. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/text-animators.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/three-d-advanced.test.ts

### KEEP: unlit %s = Classic 3D (CPU reference)

- Baseline case: `packages/compositions/test/three-d-advanced.test.ts:52`. Detected failure: unlit %s = Classic 3D (CPU reference). Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-advanced.test.ts --maxWorkers=1`; package typecheck.

### KEEP: shadow maps: the caster darkens the floor where Classic 3D puts its shadow

- Baseline case: `packages/compositions/test/three-d-advanced.test.ts:75`. Detected failure: shadow maps: the caster darkens the floor where Classic 3D puts its shadow. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-advanced.test.ts --maxWorkers=1`; package typecheck.

### KEEP: extruded text: walls widen the silhouette, the hole stays open, walls take the fill colour

- Baseline case: `packages/compositions/test/three-d-advanced.test.ts:89`. Detected failure: extruded text: walls widen the silhouette, the hole stays open, walls take the fill colour. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-advanced.test.ts --maxWorkers=1`; package typecheck.

### KEEP: environment light: the background is the environment ahead, the mirror reflects the one behind

- Baseline case: `packages/compositions/test/three-d-advanced.test.ts:109`. Detected failure: environment light: the background is the environment ahead, the mirror reflects the one behind. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-advanced.test.ts --maxWorkers=1`; package typecheck.

### KEEP: depth of field: the layer in focus stays sharp, the far one is blurred

- Baseline case: `packages/compositions/test/three-d-advanced.test.ts:119`. Detected failure: depth of field: the layer in focus stays sharp, the far one is blurred. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-advanced.test.ts --maxWorkers=1`; package typecheck.

### KEEP: 3D model layer: a lit cube shows three differently shaded faces in its base colour

- Baseline case: `packages/compositions/test/three-d-advanced.test.ts:137`. Detected failure: 3D model layer: a lit cube shows three differently shaded faces in its base colour. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-advanced.test.ts --maxWorkers=1`; package typecheck.

### KEEP: GGX: a shiny surface shows a highlight under a point light

- Baseline case: `packages/compositions/test/three-d-advanced.test.ts:153`. Detected failure: GGX: a shiny surface shows a highlight under a point light. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-advanced.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/three-d-gl.test.ts

### DELETE: has WebGL2

- Baseline case: `packages/compositions/test/three-d-gl.test.ts:32`. Detected failure: has WebGL2. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Environment probe duplicated by real scene/CPU comparisons.
- Remaining stronger coverage / risk: Environment probe duplicated by real scene/CPU comparisons. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: %s

- Baseline case: `packages/compositions/test/three-d-gl.test.ts:36`. Detected failure: %s. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/three-d-gl.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/three-d-render.e2e.test.ts

### KEEP: %s = the CPU reference

- Baseline case: `packages/compositions/test/three-d-render.e2e.test.ts:130`. Detected failure: %s = the CPU reference. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/three-d-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a two-layer run: camera, spot light, shadow = the CPU reference

- Baseline case: `packages/compositions/test/three-d-render.e2e.test.ts:146`. Detected failure: a two-layer run: camera, spot light, shadow = the CPU reference. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/three-d-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a 2D video below a 3D run is the run's backdrop (the camera tracker case)

- Baseline case: `packages/compositions/test/three-d-render.e2e.test.ts:154`. Detected failure: a 2D video below a 3D run is the run's backdrop (the camera tracker case). Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/three-d-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Advanced 3D: the run renders lit with a shadow map, and extruded text shows its walls

- Baseline case: `packages/compositions/test/three-d-render.e2e.test.ts:183`. Detected failure: Advanced 3D: the run renders lit with a shadow map, and extruded text shows its walls. Production owner/non-test callers: `three-d/gl.ts, advanced.ts, scope.tsx; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/three-d.md §2; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through rendered 3D pixels.
- Bar 3 (independent expectation): separate CPU renderer or fixed face/shadow/environment/ink relationships. These expectations can disagree with the owner.
- Bar 4 (stable seam): rendered 3D pixels; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): 3D camera/light/extrusion or scope-input combination named here, not general 2D fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/three-d-render.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/transition-gallery.e2e.test.ts

### DELETE: effectId

- Baseline case: `packages/compositions/test/transition-gallery.e2e.test.ts:75`. Detected failure: effectId. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Weak different-frame gallery: moving source footage alone can satisfy it with transition missing. Transition GL fingerprints and exact Player/Remotion tests own correctness.
- Remaining stronger coverage / risk: Weak different-frame gallery: moving source footage alone can satisfy it with transition missing. Transition GL fingerprints and exact Player/Remotion tests own correctness. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-gallery.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/transition-player.e2e.test.ts

### KEEP: Push follows the playhead while scrubbing

- Baseline case: `packages/compositions/test/transition-player.e2e.test.ts:187`. Detected failure: Push follows the playhead while scrubbing. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Iris Round over a video side: B in the circle, the decoded video outside

- Baseline case: `packages/compositions/test/transition-player.e2e.test.ts:201`. Detected failure: Iris Round over a video side: B in the circle, the decoded video outside. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_DissolveLuma: the white half of A already shows B

- Baseline case: `packages/compositions/test/transition-player.e2e.test.ts:211`. Detected failure: S_DissolveLuma: the white half of A already shows B. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a shape side is captured through HTML-in-Canvas

- Baseline case: `packages/compositions/test/transition-player.e2e.test.ts:221`. Detected failure: a shape side is captured through HTML-in-Canvas. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-player.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: without HTML-in-Canvas a DOM side falls back to a dissolve with a chip

- Baseline case: `packages/compositions/test/transition-player.e2e.test.ts:228`. Detected failure: without HTML-in-Canvas a DOM side falls back to a dissolve with a chip. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-player.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/transition-render.e2e.test.ts

### KEEP: Push: B enters from the left and pushes A out to the right

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:88`. Detected failure: Push: B enters from the left and pushes A out to the right. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Push: at progress 1 (the last frame of a fade at a tail) the border has left the far edge

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:113`. Detected failure: Push: at progress 1 (the last frame of a fade at a tail) the border has left the far edge. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Gradient Wipe: a Custom Gradient image replaces the built-in ramp (dark areas first)

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:134`. Detected failure: Gradient Wipe: a Custom Gradient image replaces the built-in ramp (dark areas first). Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Iris Round: B inside a growing circle; Reverse closes A instead

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:153`. Detected failure: Iris Round: B inside a growing circle; Reverse closes A instead. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: one-sided: an iris at the tail of the last clip opens onto transparency (the black background)

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:167`. Detected failure: one-sided: an iris at the tail of the last clip opens onto transparency (the black background). Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_DissolveLuma: the bright half of A switches to B first

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:183`. Detected failure: S_DissolveLuma: the bright half of A switches to B first. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Cross Zoom: mostly A early, B at the end

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:212`. Detected failure: Cross Zoom: mostly A early, B at the end. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: a video side goes through its chain (upright decoded frames), a shape side through HTML-in-Canvas

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:219`. Detected failure: a video side goes through its chain (upright decoded frames), a shape side through HTML-in-Canvas. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

### KEEP: the built-in Cross Dissolve keeps its ramps (no stage)

- Baseline case: `packages/compositions/test/transition-render.e2e.test.ts:271`. Detected failure: the built-in Cross Dissolve keeps its ramps (no stage). Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-render.e2e.test.ts --maxWorkers=1`; package typecheck.

## packages/compositions/test/transition-sapphire-dissolves-gallery.e2e.test.ts

### DELETE: spec.label

- Baseline case: `packages/compositions/test/transition-sapphire-dissolves-gallery.e2e.test.ts:99`. Detected failure: spec.label. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Weak different-frame gallery: source motion can satisfy it without a dissolve. GL transition fingerprints and family dissolve tests are stronger.
- Remaining stronger coverage / risk: Weak different-frame gallery: source motion can satisfy it without a dissolve. GL transition fingerprints and family dissolve tests are stronger. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-sapphire-dissolves-gallery.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/transition-sapphire-swish-other-gallery.e2e.test.ts

### DELETE: name

- Baseline case: `packages/compositions/test/transition-sapphire-swish-other-gallery.e2e.test.ts:146`. Detected failure: name. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Weak different-frame gallery: source motion alone passes. GL transition fingerprints and family swish behavioral cases are stronger.
- Remaining stronger coverage / risk: Weak different-frame gallery: source motion alone passes. GL transition fingerprints and family swish behavioral cases are stronger. Risk: removes only the failing-bar check described here; no production behavior changes.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/transition-sapphire-swish-other-gallery.e2e.test.ts --maxWorkers=1` (collection deletion checked via package suite and typecheck).

## packages/compositions/test/transition-sapphire-wipes-gl.test.ts

### REWRITE: runs all 24 wipes, each moving monotonically from A to B

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:42`. Detected failure: runs all 24 wipes, each moving monotonically from A to B. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Keep independent monotonically increasing revealed-B pixel fractions; remove environment and registry count.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required after the stated rewrite.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_WipeLine: B enters along Angle, with a centred border and a glow

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:53`. Detected failure: S_WipeLine: B enters along Angle, with a centred border and a glow. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: shape wipes: In shrinks the outgoing clip, Out grows the incoming clip

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:69`. Detected failure: shape wipes: In shrinks the outgoing clip, Out grows the incoming clip. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: S_WipeClock sweeps from Angle Open clockwise or counter-clockwise

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:91`. Detected failure: S_WipeClock sweeps from Angle Open clockwise or counter-clockwise. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: wedges: one from the side, two meeting in the middle, four merging into an X

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:102`. Detected failure: wedges: one from the side, two meeting in the middle, four merging into an X. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Reverse plays the wipe backwards (B enters from the other side)

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:118`. Detected failure: Reverse plays the wipe backwards (B enters from the other side). Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: is transparent where a missing side shows (one-sided fade)

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:124`. Detected failure: is transparent where a missing side shows (one-sided fade). Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Grad Add makes a pattern travel across the frame along Grad Angle

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:131`. Detected failure: Grad Add makes a pattern travel across the frame along Grad Angle. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: Grow and Shrink differ; every tile shape draws its own pattern

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:141`. Detected failure: Grow and Shrink differ; every tile shape draws its own pattern. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

### KEEP: random wipes are deterministic per seed and change with Seed

- Baseline case: `packages/compositions/test/transition-sapphire-wipes-gl.test.ts:168`. Detected failure: random wipes are deterministic per seed and change with Seed. Production owner/non-test callers: `fx/transition.tsx + project registry/transitions; SequenceComposition consumer`.
- Decision: Retain the independently observable contract named below.
- Bar 1 (independent source): docs/wp-notes/fx-transition-framework.md §§3–6; docs/testing.md §2; the contract is the behavior in this case name.
- Bar 2 (observable failure): violating that behavior changes the consumed pixels, text/state, or typed result; it is observed through real transition pixels at specified progress or live seek.
- Bar 3 (independent expectation): fixed A/B colors, independently chosen edge locations, monotonicity or deterministic seed relation. These expectations can disagree with the owner.
- Bar 4 (stable seam): real transition pixels at specified progress or live seek; no private call sequence is required.
- Bar 5 (refactor survival): a replacement owner preserving this input/output behavior still satisfies these assertions; renderer internals and identifiers are not asserted.
- Bar 6 (lowest distinct owner): parameter-specific transition or asynchronous player/source integration not covered by quarter-frame family fingerprints. No retained stronger test covers this exact contract/input combination.
- Risk: removal/rewrite preserves the independently specified contract above; rendering checks still require Chrome/Remotion validation, and changed expectations are not blessed.
- Validation: `pnpm exec vitest run packages/compositions/test/transition-sapphire-wipes-gl.test.ts --maxWorkers=1`; package typecheck.

## Support/seam plan

- Remove private `RetimeCompositor.readFlow` and its flow-vector probe; output-image checks remain.
- Remove host scratch-poison flag/helper and `test/gl-poison.ts`; surviving pixel comparisons exercise the production renderer. Coordinate other partition imports with compositions2; root updates docs/testing.md.
- Remove orphan copied `fx-gl/glsl-reference.ts`, deleted API harness methods and generator-only scene lists/imports.
- Internalize unused FrameWindow paging exports, caption placement/page/title-safe exports, vector allocation exports; retain Lottie frame helper because it implements the stable media-time boundary.
- Preserve published screenshot assets/provenance; report historical generator references instead of pretending screenshots disappeared.
- Preserve `setFxEffectRegistry`: documented shader-authoring extension API used by separate render bundles, not an undocumented test-only injection hook.

## Execution evidence

Cleanup completed in this partition (validation pending integration): **179 KEEP, 48 DELETE, 32 REWRITE** test declarations across all 42 assigned paths. Parameterized declarations cover every existing row; no new test declarations were added. Nine suites were deleted in full. Review uses original names/line positions so deleted and renamed cases remain identifiable.

Validation actually run:

- `pnpm install --frozen-lockfile --offline`: passed; expected missing app build-bin links and ignored onnxruntime build-script warning reported.
- `pnpm exec biome check --write --unsafe <42 modified .ts/.tsx files>`: passed. Limited to this partition's modified files; removed newly unused imports and formatted edited blocks.
- TypeScript syntax parse of all 42 modified TS/TSX files: 0 parse errors; remaining original test declarations: 211.
- `git diff --check`: passed. Final source/test/support diff inspected; original per-file Vitest environment directives preserved.
- Focused Vitest, package typecheck, GL/Remotion, and repository gates: **pending integrated validation**, intentionally not launched under root's shared-host resource schedule. No skipped suite is recorded as passing. Root owns reruns and any retained-test failures.

Actual support removed: `test/gl-poison.ts`; `test/fx-gl/glsl-reference.ts`; `fx/host.ts` scratch-poison global flag, shader and helper; `RetimeCompositor.readFlow`; unused exports of frame paging, caption placement/page/title-safe and vector raster allocation; deleted harness compile/environment/private-cache methods and unused paint/texture gallery image-loading and PNG methods; gallery generators/scene lists, media depth-map fixtures and mock-only canvas/GPU recording infrastructure. The real renderer's normal production behavior is unchanged. Default and perturbed effect fingerprints now propagate rendering failures directly, removing a second compile-only rendering sweep.

The surviving media-mask/composite integration test compares decoded pixels against an independently rendered source/background. The clipping rewrite requires actual halo alpha outside the source, preventing an empty enlarged canvas from passing. Text range and expression tests require visible ink before checking bounds, preventing blank frames from passing.

Cross-partition integration: compositions2 removes remaining `gl-poison.ts` imports in its entries. Root must scan all imports after cherry-picking both branches and update docs/testing.md §3. Published screenshot assets and attribution records remain because documentation still consumes them. Stale generator/test references were reported for docs/wp-notes/fx-transition-framework.md, sim-warp.md, imports.md, captions.md and scripts/docs/gallery-scenes.mjs.

## Motion-blur runtime follow-up: pre-edit record

Root's integrated default run retained `packages/compositions/test/fx-motion-blur-gl.test.ts` and reported a timeout, not a numeric pixel mismatch: `deterministic: same pixels on re-render and in any frame order (no frame-random jitter)` reached **240,007 ms** against its existing **240,000 ms** limit. The other cases passed in 58,936 and 100,934 ms; the file took 424,942 ms. Reported host load was approximately 100 on 16 cores. These are observed loaded-host durations, not a product benchmark or proof that any individual render exceeds the budget.

Disposition: **REWRITE the aggregation boundary**, preserving every render and assertion. Before editing, separate the two independently specified contracts currently inside this one test:

| Original operations, in order | Resulting case | Preserved observation |
| --- | --- | --- |
| Shake frame 29; corner-pin frame 2; travel frame 4; shake frame 11; corner-pin frame 3; travel frame 7; shake frame 29 again; corner-pin frame 2 again; travel frame 4 again | Existing `deterministic: same pixels on re-render and in any frame order (no frame-random jitter)` | Three original checksum equalities after the exact same cross-effect interleaving |
| Twitchy shake amplitude 10 at seed 0.7, then the same shake at the default seed 0.25 | New `a different seed changes the grain of a capped smear` | Original checksum inequality |

Each retains the original 320×180 layer, full preview scale, paint pattern, keys, frame, shutter settings, shader output padding, checksums and 240-second limit. One browser and the same production GPU host remain shared across the file. The former nine-render sequence stays intact: splitting each effect into an isolated three-render test would lose its exact cross-effect contamination exposure. The two seed renders still run immediately after that sequence in the full suite. No render is cached, removed or approximated, and no production code changes.

Independent source: [adaptive shutter specification, §19](../wp-notes/fx-shader-framework.md#19-adaptive-shutter-motion-blur-wave-5-wave5adaptive-motion-blur), specifically the per-pixel/seed jitter and reproducibility in any frame order. Owners inspected: `packages/project/src/registry/fx/glsl/motion-blur.ts` (`fx_mbJitter`), `sapphire-distort-warp.ts` (`shakeUniforms`, `SHAKE_RENDER_GLSL`, `S_SHAKE`), and `packages/compositions/src/fx/host.ts`. Non-test callers are the effect and transition render stages used by Program preview/export. The harness calls the same `planGpuEffect`/`planGpuTransition` and `runShaderPlan` owners, then reads actual output pixels.

Full retention bar for both resulting cases:

1. The specification requires frame-order reproducibility and seed-dependent jitter; these are separate contracts, so each can have a test boundary.
2. Frame history changing the final image or ignoring a requested seed is a visible preview/export defect; the existing pixel checksums expose it.
3. Equality under unchanged inputs and inequality after changing the seed are input-defined relations. Neither expected checksum is calculated by production shader logic.
4. Assertions observe rendered pixels through the real GPU host, without inspecting uniforms, pass counts or intermediate scratch targets.
5. Changing shader internals, algorithms, pass decomposition or identifiers while preserving output relations leaves the assertions valid.
6. This is the lowest seam that exercises the shared GPU host and rendered seed/history behavior. Stored default fingerprints do not exercise out-of-order repeated renders, and full-render duplicates were already removed by the composition-2 audit.

Risk: this split improves failure attribution and prevents independent contracts from consuming one combined deadline; it does not prove that either independent case finishes within 240 seconds on the loaded host. A runtime timeout or pixel failure remains actionable. No timeout is raised and no oracle is loosened.

Validation plan: scoped Biome, TypeScript syntax parsing and diff inspection now; then `pnpm exec vitest run packages/compositions/test/fx-motion-blur-gl.test.ts --maxWorkers=1` when root grants the shared-host runtime slot. The runtime result is pending, and no skipped execution counts as a pass.

Scoped follow-up checks completed: Biome passed; TypeScript syntax parsing passed; the nine-render block and its three equality assertions are byte-for-byte unchanged against the integrated baseline; `git diff --check` passed. Full runtime execution remains pending root scheduling.

## Final retained-test rescan: pre-edit ledger

Re-read retained assertions, their browser helpers and production owners after integration. Most CPU comparisons are intentional cross-implementation contracts: `docs/wp-notes/three-d.md` explicitly names `compositeClassicCPU` as the GL oracle; `docs/wp-notes/masks.md` requires GPU/native/fallback coverage parity; blend and retime CPU kernels run in native export while the GL implementations run in preview. These comparisons can catch disagreement between independently executed rendering paths. Their limits are now explicit: shared path preparation, transforms and definitions are not independently validated by parity alone. Existing analytic pixel/known-frame cases and project-owner tests cover those definitions. Static pixel goldens and native/preview parity were not removed merely for importing production fixture constructors.

Narrow REWRITE candidates recorded before editing:

| Test path and original case | Miss and actual retained failure | Stronger or complementary owner; callers/seams | Risk and validation |
| --- | --- | --- | --- |
| `packages/compositions/test/mg-host-remote.test.ts` — `drives the renderer-page protocol: evaluate, calculate, mount with overrides, seek (clamped), re-seek on new props` | Exact log ordering, duplicate-call suppression and log length inspect caching/collaborator structure. Keep returned metadata overrides and the external renderer's selected frame (45, clamped 89, re-clamped 74 after metadata changes). Also remove the shared-constant handshake equality from `connect()` setup; communication still must succeed over a real MessageChannel. | Real-bundle mode sequencing belongs to `e2e/mg-clips.spec.ts`; this port test owns override/clamp cases not exercised there. Agent/remote callers: CompositionLayer and web bundle text measuring. No production export becomes unused. | No render/protocol change; a different caching strategy should pass. Run this file with one Vitest worker; static checks now. |
| `packages/compositions/test/imports-layers.test.tsx` — `samples the Lottie frame at the clip time` | Fixture input used the same `FLICKS_PER_SECOND` that the owner divides by, hiding a wrong shared unit. Use the documented serialized second, 705,600,000 ticks; retain expected frames 5/30/54 and missing-media null. | `docs/ARCHITECTURE.md` time contract; LottieLayer calls `lottieFrameForLayer`. Model time tests complement, but do not own the layer's combined media-time mapping. | Existing numerical inputs are unchanged today. Same focused Vitest command; syntax/Biome now. |
| Same path — `follows an assumed frame rate and a loop (Interpret Footage)` | The same shared-unit cancellation; pin fixture tick units independently and keep the existing 30/5/6 frame expectations. | `docs/wp-notes/imports.md` interpreted footage/Lottie frame sampling; same production caller. | Existing current inputs/assertions unchanged; no helper export removed. Same validation. |
| `packages/compositions/test/fx-warp-stabilizer-gl.test.ts` — `Stabilize Only leaves the uncovered edge transparent; no analysis passes through` | `s.expected[0] < 0` only asserts the fixture's camera-path delta against itself, never GPU output. Delete that assertion and its unused render; keep uncovered output alpha 0 and the exact no-analysis pixel [10,200,30,255]. | `docs/wp-notes/sim-warp.md` stabilization framing; actual GPU effect chain. Other cases retain independently known synthetic-path displacement at every tested frame. | One pure fixture assertion/render removed; no production/harness seam becomes unused. Focused GL remains deferred to root. |
| `packages/compositions/test/lottie-assets.test.ts` — `rejects a missing picture instead of returning an empty SVG` | Mock `destroy` call count is collaborator shape. Keep public `LOTTIE_RENDER_FAILED` and removal of the temporary DOM host. | Browser thumbnail contract in `docs/wp-notes/imports.md`; lottieThumbnail is called by web Project and Source panels. Source owner `layers/thumbnails.ts` read; no production changes. | A refactor using another legitimate disposal path should not fail a mock counter. Same focused Vitest command. |
| Same path — `rejects a stalled renderer and releases its listeners and player` | Mock listener-map size and exact `destroy` count assert disposal mechanics. Keep timeout rejection as `LOTTIE_RENDER_FAILED`, the caller-visible hang-prevention contract; rename accordingly. Remove now-unused listener-map/call-spy support. Keep the valid SVG in the stalled fixture so skipping the wait cannot pass by failing for a missing picture. | Same thumbnail caller and source; tests do not claim to validate lottie-web's own teardown implementation. | Timeout/error behavior retained; static and focused commands as above. |

Full six-item justification for each rewritten retained contract:

1. MG metadata/frame bounds are the documented renderer-page protocol and AGENTS.md clamping requirement; Lottie sampling is the documented interpreted-footage timing contract in a persisted fixed tick unit; stabilization preserves no-analysis pixels and transparent uncovered edges; thumbnails must surface missing/stalled output as a failure instead of hanging or returning an empty picture.
2. Wrong configured dimensions or selected frame, wrong Lottie animation frame, opaque uncovered stabilization pixels, or a resolved/never-settling broken thumbnail are observable by real callers. Each retained assertion fails for one of these defects.
3. Expected metadata overrides, frame numbers, serialized tick count, literal pixel/alpha and error code come from input fixtures/contracts. Removed expectations came from private call logs, shared implementation constants or fixtures checking themselves.
4. Stable seams are MessagePort results plus the renderer's selected frame, the layer time-to-frame mapping, actual GPU pixels, and thumbnail result/rejection with DOM resource cleanup. No assertion requires private cache operations or collaborator invocation counts.
5. Internal caching, teardown, pass decomposition and function identifiers can change without changing these retained results; the tests continue to pass under those behavior-preserving refactors.
6. Each kept case observes its lowest distinct owner: port mapping/bounds, Lottie layer timing composition, stabilized shader pixels, or thumbnail failure handling. Higher-level bundle/visual tests are complementary and do not repeat these exact boundary conditions.

Caller census: no production seam is introduced or deleted by this follow-up. The unused imports/mocks removed are confined to test setup. The integrated motion-blur split is preserved unchanged. Static-only validation is authorized now; runtime reruns are root's responsibility after integration.

Final rescan static validation: scoped Biome passed for all four changed test files; TypeScript syntax parsing passed; final diff inspected and `git diff --check` passed. No runtime command was launched. The stalled-thumbnail fixture deliberately retains a valid SVG so removing the readiness wait cannot produce the same error for a different reason.


## Per-effect fingerprint declarations — before-edit record

Reviewed integration `56f3ed72` before modifying these files. **REWRITE** the existing
`matches golden pixels for GPU effects outside the families and test effects` and
`matches golden pixels for every GPU effect of ${family}` declarations in
`packages/compositions/test/fx-gl.test.ts`, with their browser adapter
`packages/compositions/test/fx-gl/entry.ts`. Both original declarations were already
REWRITE above; this supplement does not add original declarations to the census.

The independent contract is per effect, not a family's elapsed time:
[testing §2](../testing.md#2-golden-frames) names every GPU effect's
default and perturbed fingerprint, and
[the transition framework's golden-fuzz contract](../wp-notes/fx-transition-framework.md)
requires exactly those two cases. Family-wide watchdog failures under shared-host
contention prompted inspection, but no timing result establishes a product defect.
Retain each effect's two renders together, in the existing effect/family order, on
the same browser/page/context. Preserve 64×36 source, frame 12, test card, parameter
perturbation, 4×4 mean-RGB fingerprints, committed JSON and ±4 tolerance. Preserve
60,000 ms for outside-family/test effects and 240,000 ms for family members.

- **B1:** the documentation explicitly requires each registered GPU effect's default
  and perturbed image; family membership is only catalogue organization.
- **B2:** a shader compilation/render failure or wrong displayed effect colors/alpha
  produces a rejection or fingerprint mismatch for that named effect.
- **B3:** expected pixels remain committed JSON, never computed from the current
  shader, planner or a shared numerical helper. Registry data selects stimuli only.
- **B4:** the adapter calls the documented shader planning/host interface and reads
  real output pixels; no pass names, allocation counts or private order is asserted.
- **B5:** implementation renames, shader decomposition and host caching may change
  while these pixel results remain valid. No family performance limit is asserted.
- **B6:** this real shader seam owns the complete default/perturbed image matrix;
  representative Remotion scenes and analytic pixel cases do not cover that matrix.

Caller census: only this test calls `window.__fx.fingerprints`; it is test support,
not a production hook. Production `fx/stage.ts` calls `planGpuEffect` and
`fx/effects.ts` calls `runShaderPlan`; neither owner changes. Risk is accidentally
omitting/reordering a case when moving enumeration into the node test; compare
case IDs and render sequence with the pre-edit source. No goldens, tolerance,
production behavior, fixture, or production seam will change. Validation planned:
format/syntax and static retained-case accounting now; scheduled Chrome run
`pnpm exec vitest run packages/compositions/test/fx-gl.test.ts --maxWorkers=1`
and package typecheck remain integration responsibilities. No full GL success is
claimed by this record.

Pre-edit static registry/fixture census at `56f3ed72`: **374 effects / 748 existing
fingerprint renders**, including eight outside-family/test effects. All 748 committed
golden keys map to those 374 IDs; no missing or duplicate current ID was found.
Expected-case discovery will also include every ID in the committed golden record,
so removal from the runtime registry cannot silently remove a test. Current IDs
without a golden remain included and fail the missing-golden check. Preserve current
catalogue order; append any absent pinned ID as an explicit failing lookup case.
The per-case watchdog values stay unchanged; their cumulative possible wall-time
budget necessarily increases. This is contract attribution, not a host-load fix.


Implemented outcome: one named default/perturbed pixel declaration for each of the
374 current effects; **748 renders retained**, no golden changes. Static evaluation
of the actual declaration data against the pre-edit catalogue confirmed identical
ID/render order and category watchdogs. Removing a fixture ID from the discovery
input still leaves its golden-pinned failing case declared. Targeted Biome passed
all four changed TS files; TypeScript transpilation reported no syntax diagnostics;
`git diff --check` passed. These are static/adapter checks, not GL results. No full
package typecheck or browser render was started in this worktree.

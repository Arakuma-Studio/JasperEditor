# MCP test cleanup

Status before edits: complete audit of all 42 assigned files. Dispositions below were recorded before changing tests. Validation is recorded at the end after editing. Test names are the original names; shared parameterized cases share one disposition.

Scope: MCP/CLI behavior only. No production behavior changes are planned. Failures of retained tests must be investigated, not deleted. `AGENTS.md`, root/package commands, README, architecture/testing guidance, relevant work notes and each affected implementation were read.

Validation command for each retained/rewritten file: `pnpm exec vitest run <path> --maxWorkers=1`; package check: `pnpm --filter @jasper/mcp typecheck`. Rendering files require fixtures/builds and isolated ports/appdirs. Root coordinates the shared-host gate. Deletions are validated by remaining-owner suites, package typecheck and the integrated repository gate.

For isolated units, the failure classes are: PNG channel/filter reconstruction, malformed/truncated input, dimension caps and scanline-length validation; discovery precedence/stale runtime/spawn failure; network timeout/retry/data-loss and credential disclosure; public error mapping, explicit preset override and CLI launch/version. Only tests observing these concrete failures remain.

## `apps/mcp/test/animation.test.ts`

Independent source: PNG specification frozen FFmpeg-decoded vectors; AGENTS §0 allocation/validation rules. Owner inspected: `apps/mcp/src/png.ts`. Oracle: Frozen RGBA bytes, malformed headers and bounded invalid sizes. Non-test callers / other coverage: decodePng/encodePng/composeGrid called by tools/animation.ts; png-limits owns overlapping resource guards.

### KEEP — `decodes RGB and RGBA rows of every filter type`

1. Independent contract: PNG specification frozen FFmpeg-decoded vectors; AGENTS §0 allocation/validation rules; the exact case is “decodes RGB and RGBA rows of every filter type”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes frozen rgba bytes, malformed headers and bounded invalid sizes.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: decodePng/encodePng/composeGrid called by tools/animation.ts; png-limits owns overlapping resource guards. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `decodes greyscale with alpha and rejects unsupported input`

1. Independent contract: PNG specification frozen FFmpeg-decoded vectors; AGENTS §0 allocation/validation rules; the exact case is “decodes greyscale with alpha and rejects unsupported input”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes frozen rgba bytes, malformed headers and bounded invalid sizes.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: decodePng/encodePng/composeGrid called by tools/animation.ts; png-limits owns overlapping resource guards. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `rejects dimensions before allocating the raster`

Duplicate allocation guard; png-limits asserts the structured E_LIMIT refusal and varied hostile dimensions. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### DELETE — `limits inflation to the declared raster size`

The generic thrown error cannot prove bounded inflation: an unbounded decode still throws at the later scanline-length check. The retained property owns malformed scanline rejection without claiming an allocation guarantee. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `requires complete headers, chunks and an end marker`

1. Independent contract: PNG specification frozen FFmpeg-decoded vectors; AGENTS §0 allocation/validation rules; the exact case is “requires complete headers, chunks and an end marker”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes frozen rgba bytes, malformed headers and bounded invalid sizes.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: decodePng/encodePng/composeGrid called by tools/animation.ts; png-limits owns overlapping resource guards. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `rejects invalid raster and grid sizes before allocating`

1. Independent contract: PNG specification frozen FFmpeg-decoded vectors; AGENTS §0 allocation/validation rules; the exact case is “rejects invalid raster and grid sizes before allocating”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes frozen rgba bytes, malformed headers and bounded invalid sizes.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: decodePng/encodePng/composeGrid called by tools/animation.ts; png-limits owns overlapping resource guards. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/audio-fx.test.ts`

Independent source: docs/wp-notes/audio-fx.md and published audio tool arguments. Owner inspected: `apps/mcp/src/tools/audio-fx.ts`. Oracle: Real command application, authored effect values, LUFS differences and audio activity offsets. Non-test callers / other coverage: Tool handlers registered by server; project audio commands own DSP/edit algebra.

### REWRITE — `lists the catalogue, adds with keyframes, edits, reorders, bypasses and removes`

1. Independent contract: docs/wp-notes/audio-fx.md and published audio tool arguments; the exact case is “lists the catalogue, adds with keyframes, edits, reorders, bypasses and removes”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real command application, authored effect values, lufs differences and audio activity offsets.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Tool handlers registered by server; project audio commands own DSP/edit algebra. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `type, preset, options, Auto-Match, ducking, clear`

1. Independent contract: docs/wp-notes/audio-fx.md and published audio tool arguments; the exact case is “type, preset, options, Auto-Match, ducking, clear”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real command application, authored effect values, lufs differences and audio activity offsets.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Tool handlers registered by server; project audio commands own DSP/edit algebra. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `remix to a duration and revert`

1. Independent contract: docs/wp-notes/audio-fx.md and published audio tool arguments; the exact case is “remix to a duration and revert”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real command application, authored effect values, lufs differences and audio activity offsets.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Tool handlers registered by server; project audio commands own DSP/edit algebra. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/bundle.test.ts`

Independent source: README MCP stdio launch contract; docs/ARCHITECTURE.md §11. Owner inspected: `apps/mcp/scripts/build.mjs and src/cli.ts`. Oracle: Actual bundled Node process must answer SDK initialize. Non-test callers / other coverage: Distributed jasper-mcp executable; no weaker helper proves bundle loading.

### KEEP — `the jasper-mcp bundle loads and answers initialize`

1. Independent contract: README MCP stdio launch contract; docs/ARCHITECTURE.md §11; the exact case is “the jasper-mcp bundle loads and answers initialize”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual bundled node process must answer sdk initialize.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Distributed jasper-mcp executable; no weaker helper proves bundle loading. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/cache.test.ts`

Independent source: docs/wp-notes/wp-m3-cachegc.md S04:CA-019 public usage units. Owner inspected: `apps/mcp/src/tools/cache.ts`. Oracle: Known byte inputs must become 300/100/150/50 MB and 25600 MB budget. Non-test callers / other coverage: Public get_cache_usage; conventions owns annotations.

### REWRITE — `get_cache_usage reports MB and safe tool annotations`

Remove annotation checks duplicated by conventions; retain byte-to-MB API conversion.

1. Independent contract: docs/wp-notes/wp-m3-cachegc.md S04:CA-019 public usage units; the exact case is “get_cache_usage reports MB and safe tool annotations”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes known byte inputs must become 300/100/150/50 mb and 25600 mb budget.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public get_cache_usage; conventions owns annotations. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/captions.test.ts`

Independent source: docs/wp-notes/captions.md; SRT/VTT/SCC file contracts. Owner inspected: `apps/mcp/src/tools/captions.ts`. Oracle: Files on disk and independently authored word/cue ranges applied by real commands. Non-test callers / other coverage: Public caption/transcript tools; project caption algorithms do not own MCP import/export orchestration.

### KEEP — `imports, lists, edits and exports captions (files on disk)`

1. Independent contract: docs/wp-notes/captions.md; SRT/VTT/SCC file contracts; the exact case is “imports, lists, edits and exports captions (files on disk)”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes files on disk and independently authored word/cue ranges applied by real commands.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public caption/transcript tools; project caption algorithms do not own MCP import/export orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `transcript tools: inspect, search, select, fillers, pauses, captions`

1. Independent contract: docs/wp-notes/captions.md; SRT/VTT/SCC file contracts; the exact case is “transcript tools: inspect, search, select, fillers, pauses, captions”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes files on disk and independently authored word/cue ranges applied by real commands.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public caption/transcript tools; project caption algorithms do not own MCP import/export orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `extract, lift and insert a text selection`

1. Independent contract: docs/wp-notes/captions.md; SRT/VTT/SCC file contracts; the exact case is “extract, lift and insert a text selection”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes files on disk and independently authored word/cue ranges applied by real commands.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public caption/transcript tools; project caption algorithms do not own MCP import/export orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/color-mgmt.test.ts`

Independent source: docs/wp-notes/color-mgmt.md public working/footage/clip color spaces. Owner inspected: `apps/mcp/src/tools/color-mgmt.ts`. Oracle: Real persisted color-space overrides and absolute import path rules. Non-test callers / other coverage: Public color management tools; project validation owns color data schemas.

### KEEP — `lists spaces, sets the working space, interprets footage and overrides a clip`

1. Independent contract: docs/wp-notes/color-mgmt.md public working/footage/clip color spaces; the exact case is “lists spaces, sets the working space, interprets footage and overrides a clip”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real persisted color-space overrides and absolute import path rules.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public color management tools; project validation owns color data schemas. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `imports an OCIO config and refuses relative paths`

1. Independent contract: docs/wp-notes/color-mgmt.md public working/footage/clip color spaces; the exact case is “imports an OCIO config and refuses relative paths”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real persisted color-space overrides and absolute import path rules.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public color management tools; project validation owns color data schemas. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/color.test.ts`

Independent source: docs/wp-notes/wp-m2-color.md; docs/specs/06-color-grading.md MCP/render requirements. Owner inspected: `apps/mcp/src/tools/color.ts`. Oracle: Actual engine documents, independently known LUT errors and rendered frames. Non-test callers / other coverage: Public MCP color editing, real engine; unit color tests do not own transport/persistence/render orchestration.

### KEEP — `imports a .cube LUT and reports the broken one with its line number`

1. Independent contract: docs/wp-notes/wp-m2-color.md; docs/specs/06-color-grading.md MCP/render requirements; the exact case is “imports a .cube LUT and reports the broken one with its line number”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine documents, independently known lut errors and rendered frames.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP color editing, real engine; unit color tests do not own transport/persistence/render orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `grade_clip grades in one Agent change and render_frame shows it`

1. Independent contract: docs/wp-notes/wp-m2-color.md; docs/specs/06-color-grading.md MCP/render requirements; the exact case is “grade_clip grades in one Agent change and render_frame shows it”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine documents, independently known lut errors and rendered frames.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP color editing, real engine; unit color tests do not own transport/persistence/render orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `get_grade returns the evaluated values and LUT names`

1. Independent contract: docs/wp-notes/wp-m2-color.md; docs/specs/06-color-grading.md MCP/render requirements; the exact case is “get_grade returns the evaluated values and LUT names”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine documents, independently known lut errors and rendered frames.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP color editing, real engine; unit color tests do not own transport/persistence/render orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `keyframed params need a time: rejected without one, keyed at `at``

1. Independent contract: docs/wp-notes/wp-m2-color.md; docs/specs/06-color-grading.md MCP/render requirements; the exact case is “keyframed params need a time: rejected without one, keyed at `at`”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine documents, independently known lut errors and rendered frames.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP color editing, real engine; unit color tests do not own transport/persistence/render orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `instance "new" stacks a second Lumetri; copy_grade replaces the target grade in one change`

1. Independent contract: docs/wp-notes/wp-m2-color.md; docs/specs/06-color-grading.md MCP/render requirements; the exact case is “instance "new" stacks a second Lumetri; copy_grade replaces the target grade in one change”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine documents, independently known lut errors and rendered frames.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP color editing, real engine; unit color tests do not own transport/persistence/render orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/compositions.test.ts`

Independent source: docs/wp-notes/wp-m3-mgtext.md public composition import/update/render contract. Owner inspected: `apps/mcp/src/tools/compositions.ts`. Oracle: Real compiler/imported composition, metadata duration and rendered artifact. Non-test callers / other coverage: Public composition pipeline; compiler units do not own import-to-render workflow.

### KEEP — `imports, places, edits and renders a composition; errors carry hints`

1. Independent contract: docs/wp-notes/wp-m3-mgtext.md public composition import/update/render contract; the exact case is “imports, places, edits and renders a composition; errors carry hints”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real compiler/imported composition, metadata duration and rendered artifact.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public composition pipeline; compiler units do not own import-to-render workflow. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/conventions.test.ts`

Independent source: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation. Owner inspected: `apps/mcp/src/context.ts and src/strict.ts`. Oracle: Protocol metadata, explicit argument keys/codes, clock times and cancellation notification. Non-test callers / other coverage: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation.

### REWRITE — `every tool has a title and all four annotation hints, set consistently`

Remove arbitrary minimum tool count; retain documented protocol metadata/security hints.

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “every tool has a title and all four annotation hints, set consistently”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `every fixed-shape object of every input schema forbids additional properties`

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “every fixed-shape object of every input schema forbids additional properties”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `rejects an unknown top-level key, naming it and the accepted keys`

Replace exact prose with structured unknown/accepted argument data.

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “rejects an unknown top-level key, naming it and the accepted keys”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `rejects unknown keys inside nested objects and union members`

Remove exact error prose; retain nested path/key error data.

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “rejects unknown keys inside nested objects and union members”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `applies to tools registered directly on the server`

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “applies to tools registered directly on the server”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `reports schema mismatches with the accepted and required keys`

Remove exact sentence fragment; retain error code and required public argument key.

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “reports schema mismatches with the accepted and required keys”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `suggests close keys only when plausible`

Duplicated @jasper/project suggestKey owner coverage; this imports a test-only MCP re-export. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `throttles progress to one notification per 100 ms, increasing, latest value wins`

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “throttles progress to one notification per 100 ms, increasing, latest value wins”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `sends nothing without a progress token`

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “sends nothing without a progress token”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `waitJob cancels the engine job when the request is aborted`

Private waitJob helper cancellation duplicates the following SDK notifications/cancelled protocol test. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `notifications/cancelled on wait_for_job cancels the engine job`

1. Independent contract: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation; the exact case is “notifications/cancelled on wait_for_job cancels the engine job”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes protocol metadata, explicit argument keys/codes, clock times and cancellation notification.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/default-sequence.test.ts`

Independent source: Published SequenceIdArg default-first behavior; docs/wp-notes/code-audit-mcp.md multi-sequence regression. Owner inspected: `apps/mcp/src/context.ts`. Oracle: Two distinct sequences, explicit expected destination and E_TRACK_KIND. Non-test callers / other coverage: transact used by all editing tools; project intentionally requires sequence selection rather than choosing MCP defaults.

### KEEP — `add_text and add_marker without sequenceId edit the first sequence`

1. Independent contract: Published SequenceIdArg default-first behavior; docs/wp-notes/code-audit-mcp.md multi-sequence regression; the exact case is “add_text and add_marker without sequenceId edit the first sequence”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes two distinct sequences, explicit expected destination and e_track_kind.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: transact used by all editing tools; project intentionally requires sequence selection rather than choosing MCP defaults. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `an explicit sequenceId is sent as given and not second-guessed`

Remove private transaction-call count; observe only the selected sequence.

1. Independent contract: Published SequenceIdArg default-first behavior; docs/wp-notes/code-audit-mcp.md multi-sequence regression; the exact case is “an explicit sequenceId is sent as given and not second-guessed”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes two distinct sequences, explicit expected destination and e_track_kind.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: transact used by all editing tools; project intentionally requires sequence selection rather than choosing MCP defaults. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `other refusals are returned unchanged: no retry with a sequenceId, one retry without`

Remove retry counts and prose; assert E_TRACK_KIND and unchanged document state.

1. Independent contract: Published SequenceIdArg default-first behavior; docs/wp-notes/code-audit-mcp.md multi-sequence regression; the exact case is “other refusals are returned unchanged: no retry with a sequenceId, one retry without”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes two distinct sequences, explicit expected destination and e_track_kind.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: transact used by all editing tools; project intentionally requires sequence selection rather than choosing MCP defaults. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/discovery-start.test.ts`

Independent source: AGENTS §0 child-process failure propagation; engine autostart public config. Owner inspected: `apps/mcp/src/discovery.ts`. Oracle: Actual ChildProcess error event must reject rather than emit unhandled error. Non-test callers / other coverage: startHeadlessEngine used by EngineLink autostart; real integration owns normal lifecycle.

### KEEP — `rejects engine spawn errors without emitting an unhandled child error`

1. Independent contract: AGENTS §0 child-process failure propagation; engine autostart public config; the exact case is “rejects engine spawn errors without emitting an unhandled child error”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual childprocess error event must reject rather than emit unhandled error.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: startHeadlessEngine used by EngineLink autostart; real integration owns normal lifecycle. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/edit-ux.test.ts`

Independent source: docs/wp-notes/edit-ux.md public source edits, match frame and split marks. Owner inspected: `apps/mcp/src/tools/edit-ux.ts`. Oracle: Authored frame/time examples evaluated through real transactions. Non-test callers / other coverage: Public edit tools; pure edit commands do not own MCP seconds/timecode conversion.

### KEEP — `source_edit: three-point at `at`, backtiming, four-point needs fit, fit to fill`

1. Independent contract: docs/wp-notes/edit-ux.md public source edits, match frame and split marks; the exact case is “source_edit: three-point at `at`, backtiming, four-point needs fit, fit to fill”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored frame/time examples evaluated through real transactions.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public edit tools; pure edit commands do not own MCP seconds/timecode conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `find_edit_points + trim_edit_points roll a cut; match_frame and reverse_match_frame agree`

1. Independent contract: docs/wp-notes/edit-ux.md public source edits, match frame and split marks; the exact case is “find_edit_points + trim_edit_points roll a cut; match_frame and reverse_match_frame agree”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored frame/time examples evaluated through real transactions.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public edit tools; pure edit commands do not own MCP seconds/timecode conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `make_subclip / edit_subclip / set_split_marks`

1. Independent contract: docs/wp-notes/edit-ux.md public source edits, match frame and split marks; the exact case is “make_subclip / edit_subclip / set_split_marks”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored frame/time examples evaluated through real transactions.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public edit tools; pure edit commands do not own MCP seconds/timecode conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/format.test.ts`

Independent source: Public timeline source-range display; docs/wp-notes/time.md time remapping. Owner inspected: `apps/mcp/src/format.ts`. Oracle: Six seconds source media at half speed must still display six source seconds. Non-test callers / other coverage: timelineTable is used by public timeline tools; no render checks the text data representation.

### KEEP — `a time-remapped clip shows the media its frames show, not sourceIn + duration`

1. Independent contract: Public timeline source-range display; docs/wp-notes/time.md time remapping; the exact case is “a time-remapped clip shows the media its frames show, not sourceIn + duration”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes six seconds source media at half speed must still display six source seconds.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: timelineTable is used by public timeline tools; no render checks the text data representation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/fuzz.test.ts`

### DELETE — `the in-memory engine reaches the tool handlers`

The fake engine supplies the NOT_FOUND error that the test expects; no product behavior is observed. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### DELETE — generated `@jasper/mcp tool arguments: <tool name>` seed/truncation/mutation/property families

Every dynamically discovered tool shares this disposition. Seeds are manufactured from its own JSON schema; most values fail outer validation; any MCP error (including internal errors) or any nonempty content passes. The canned fake provides NOT_FOUND for unimplemented methods. This cannot distinguish the required argument behavior from failures in a handler. The retained strict top-level/nested/direct-registration tests assert specific error codes/paths, and project/engine parser fuzz suites own meaningful parser outcomes. Risk: low; no independent contract is lost. Remove the entire fake, schema seed generator imports and test-only fuzz fixtures with the file.

## `apps/mcp/test/grading.test.ts`

Independent source: docs/specs/06-color-grading.md and docs/wp-notes/color-grade.md. Owner inspected: `apps/mcp/src/tools/color.ts`. Oracle: Real applied grading state, numeric scopes and independently compared rendered pixels. Non-test callers / other coverage: Public grading pipeline; engine owns numerical auto-tone and look catalogues.

### KEEP — `sets every new Lumetri section in one change; get_grade reads them back`

1. Independent contract: docs/specs/06-color-grading.md and docs/wp-notes/color-grade.md; the exact case is “sets every new Lumetri section in one change; get_grade reads them back”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real applied grading state, numeric scopes and independently compared rendered pixels.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public grading pipeline; engine owns numerical auto-tone and look catalogues. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `the spatial stage (vignette, HSL Secondary) renders: render_frame changes when the vignette is switched off`

1. Independent contract: docs/specs/06-color-grading.md and docs/wp-notes/color-grade.md; the exact case is “the spatial stage (vignette, HSL Secondary) renders: render_frame changes when the vignette is switched off”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real applied grading state, numeric scopes and independently compared rendered pixels.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public grading pipeline; engine owns numerical auto-tone and look catalogues. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `list_looks lists the built-in looks`

Built-in catalogue count and identifier inventory are change detectors. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `scopes_read measures a frame as numbers (and one clip alone)`

1. Independent contract: docs/specs/06-color-grading.md and docs/wp-notes/color-grade.md; the exact case is “scopes_read measures a frame as numbers (and one clip alone)”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real applied grading state, numeric scopes and independently compared rendered pixels.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public grading pipeline; engine owns numerical auto-tone and look catalogues. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `color_match solves clip A towards a frame of clip B in one Apply Match change`

1. Independent contract: docs/specs/06-color-grading.md and docs/wp-notes/color-grade.md; the exact case is “color_match solves clip A towards a frame of clip B in one Apply Match change”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real applied grading state, numeric scopes and independently compared rendered pixels.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public grading pipeline; engine owns numerical auto-tone and look catalogues. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `auto_tone writes the tone sliders (one change)`

Only event count, parameter-key inventory and quantile length are observed; no applied tone value or rendered correction is checked. Engine tone solver tests own numerical behavior and grade_clip owns MCP transaction application. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

## `apps/mcp/test/imports.test.ts`

Independent source: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports. Owner inspected: `apps/mcp/src/tools/imports.ts`. Oracle: Real documents, explicit 29.97→23.976 rate/loop example and distinct PDF pages. Non-test callers / other coverage: Public import tools; engines decode source formats, MCP owns document registration/conversion.

### KEEP — `interprets footage and reports file vs effective values`

1. Independent contract: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports; the exact case is “interprets footage and reports file vs effective values”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real documents, explicit 29.97→23.976 rate/loop example and distinct pdf pages.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public import tools; engines decode source formats, MCP owns document registration/conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `refuses empty, unknown and strictly-invalid interpretations`

1. Independent contract: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports; the exact case is “refuses empty, unknown and strictly-invalid interpretations”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real documents, explicit 29.97→23.976 rate/loop example and distinct pdf pages.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public import tools; engines decode source formats, MCP owns document registration/conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `imports an image sequence from one frame`

1. Independent contract: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports; the exact case is “imports an image sequence from one frame”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real documents, explicit 29.97→23.976 rate/loop example and distinct pdf pages.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public import tools; engines decode source formats, MCP owns document registration/conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `lists PSD layers and imports them as a sequence`

1. Independent contract: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports; the exact case is “lists PSD layers and imports them as a sequence”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real documents, explicit 29.97→23.976 rate/loop example and distinct pdf pages.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public import tools; engines decode source formats, MCP owns document registration/conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `imports chosen PSD layers individually or merged, and the flattened picture`

1. Independent contract: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports; the exact case is “imports chosen PSD layers individually or merged, and the flattened picture”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real documents, explicit 29.97→23.976 rate/loop example and distinct pdf pages.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public import tools; engines decode source formats, MCP owns document registration/conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `imports PDF pages, one item per page`

1. Independent contract: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports; the exact case is “imports PDF pages, one item per page”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real documents, explicit 29.97→23.976 rate/loop example and distinct pdf pages.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public import tools; engines decode source formats, MCP owns document registration/conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `exports a sequence as Lottie with warnings`

1. Independent contract: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports; the exact case is “exports a sequence as Lottie with warnings”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real documents, explicit 29.97→23.976 rate/loop example and distinct pdf pages.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public import tools; engines decode source formats, MCP owns document registration/conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/integration.test.ts`

Independent source: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021. Owner inspected: `apps/mcp/src/server.ts and registered tool owners`. Oracle: Actual engine persisted state, independent frame/value expectations, files and authentication refusals. Non-test callers / other coverage: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together.

### KEEP — `discovers the engine, edits media, renders a frame, and exports a playable video`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “discovers the engine, edits media, renders a frame, and exports a playable video”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `clipboard tools preserve destination time, track, insertion mode and bin`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “clipboard tools preserve destination time, track, insertion mode and bin”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `keeps the engine token out of MCP responses and stderr`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “keeps the engine token out of MCP responses and stderr”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `serves project resources and the edit-video prompt through MCP`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “serves project resources and the edit-video prompt through MCP”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `dry runs leave the project unchanged and destructive edits require approval`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “dry runs leave the project unchanged and destructive edits require approval”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `creates, edits, applies defaults, and removes transitions through MCP`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “creates, edits, applies defaults, and removes transitions through MCP”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `persists text animation changes and returns a PNG contact sheet`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “persists text animation changes and returns a PNG contact sheet”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `stores a shape with the requested geometry and rejects invalid ellipse corners`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “stores a shape with the requested geometry and rejects invalid ellipse corners”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `reads a curved motion path and sets its spatial interpolation (S03:KF-021)`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “reads a curved motion path and sets its spatial interpolation (S03:KF-021)”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `starts an engine and stops it when the MCP client closes`

1. Independent contract: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021; the exact case is “starts an engine and stops it when the MCP client closes”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual engine persisted state, independent frame/value expectations, files and authentication refusals.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/interchange.test.ts`

Independent source: docs/wp-notes/interchange.md public timeline import/export/relink contracts. Owner inspected: `apps/mcp/src/tools/interchange.ts`. Oracle: Authored engine fragments applied by real commands, explicit options/URLs and force-only mismatched relink. Non-test callers / other coverage: Public interchange tools; codec parsers do not own MCP transaction and safety orchestration.

### KEEP — `import_timeline applies the fragment and reports offline media and what was not carried`

1. Independent contract: docs/wp-notes/interchange.md public timeline import/export/relink contracts; the exact case is “import_timeline applies the fragment and reports offline media and what was not carried”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored engine fragments applied by real commands, explicit options/urls and force-only mismatched relink.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public interchange tools; codec parsers do not own MCP transaction and safety orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `export_timeline maps the options, waits for the job and lists files and losses`

1. Independent contract: docs/wp-notes/interchange.md public timeline import/export/relink contracts; the exact case is “export_timeline maps the options, waits for the job and lists files and losses”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored engine fragments applied by real commands, explicit options/urls and force-only mismatched relink.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public interchange tools; codec parsers do not own MCP transaction and safety orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `list_offline_media and link_media (folder search; differences need force)`

1. Independent contract: docs/wp-notes/interchange.md public timeline import/export/relink contracts; the exact case is “list_offline_media and link_media (folder search; differences need force)”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored engine fragments applied by real commands, explicit options/urls and force-only mismatched relink.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public interchange tools; codec parsers do not own MCP transaction and safety orchestration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/jasper-cli.test.ts`

Independent source: docs/wp-notes/mcp-cli.md §5 CLI commands/options/exit statuses; README CLI usage. Owner inspected: `apps/mcp/src/jasper-cli.ts and src/jasper.ts`. Oracle: Actual CLI statuses, document values, JSON-lines and output media files. Non-test callers / other coverage: jasper executable invokes runCli; helpers have no external production callers or package exports.

### DELETE — `parses flags, k=v pairs, JSON objects and times`

Private parser representation, duplicated by real CLI exec/JSON-lines/get/set/render invocations; no exported SDK contract. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### REWRITE — `usage errors exit 2, --help 0, --version 0`

Remove exact usage prose; retain exit status and help command key.

1. Independent contract: docs/wp-notes/mcp-cli.md §5 CLI commands/options/exit statuses; README CLI usage; the exact case is “usage errors exit 2, --help 0, --version 0”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual cli statuses, document values, json-lines and output media files.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: jasper executable invokes runCli; helpers have no external production callers or package exports. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `status, project creation through call, and project resolution`

1. Independent contract: docs/wp-notes/mcp-cli.md §5 CLI commands/options/exit statuses; README CLI usage; the exact case is “status, project creation through call, and project resolution”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual cli statuses, document values, json-lines and output media files.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: jasper executable invokes runCli; helpers have no external production callers or package exports. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `import, exec with k=v and JSON, describe, run with JSON-lines output`

1. Independent contract: docs/wp-notes/mcp-cli.md §5 CLI commands/options/exit statuses; README CLI usage; the exact case is “import, exec with k=v and JSON, describe, run with JSON-lines output”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual cli statuses, document values, json-lines and output media files.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: jasper executable invokes runCli; helpers have no external production callers or package exports. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `get / set / props report value and evaluated`

Remove nonempty output probe and human wording assertion; retain actual JSON parameter value and evaluated-value data.

1. Independent contract: docs/wp-notes/mcp-cli.md §5 CLI commands/options/exit statuses; README CLI usage; the exact case is “get / set / props report value and evaluated”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual cli statuses, document values, json-lines and output media files.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: jasper executable invokes runCli; helpers have no external production callers or package exports. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `render-frame writes a PNG, export writes a video`

1. Independent contract: docs/wp-notes/mcp-cli.md §5 CLI commands/options/exit statuses; README CLI usage; the exact case is “render-frame writes a PNG, export writes a video”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual cli statuses, document values, json-lines and output media files.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: jasper executable invokes runCli; helpers have no external production callers or package exports. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `the bin entry runs and returns the exit status`

1. Independent contract: docs/wp-notes/mcp-cli.md §5 CLI commands/options/exit statuses; README CLI usage; the exact case is “the bin entry runs and returns the exit status”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes actual cli statuses, document values, json-lines and output media files.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: jasper executable invokes runCli; helpers have no external production callers or package exports. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/masks.test.ts`

Independent source: docs/wp-notes/masks.md public pixel/normalized masks, trace holes and track mattes. Owner inspected: `apps/mcp/src/tools/masks.ts`. Oracle: Explicit 0.5/0.1 normalized coordinates, add/subtract holes and 50-pixel translation. Non-test callers / other coverage: Public mask tools; project owns mask data algebra but not MCP unit conversion/job application.

### KEEP — `add (px units), list, edit, remove`

1. Independent contract: docs/wp-notes/masks.md public pixel/normalized masks, trace holes and track mattes; the exact case is “add (px units), list, edit, remove”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 0.5/0.1 normalized coordinates, add/subtract holes and 50-pixel translation.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public mask tools; project owns mask data algebra but not MCP unit conversion/job application. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `auto-trace creates add / subtract masks; track_mask writes path keys`

1. Independent contract: docs/wp-notes/masks.md public pixel/normalized masks, trace holes and track mattes; the exact case is “auto-trace creates add / subtract masks; track_mask writes path keys”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 0.5/0.1 normalized coordinates, add/subtract holes and 50-pixel translation.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public mask tools; project owns mask data algebra but not MCP unit conversion/job application. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `set_track_matte adds a Track Matte Key reading V1 and hides it`

1. Independent contract: docs/wp-notes/masks.md public pixel/normalized masks, trace holes and track mattes; the exact case is “set_track_matte adds a Track Matte Key reading V1 and hides it”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 0.5/0.1 normalized coordinates, add/subtract holes and 50-pixel translation.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public mask tools; project owns mask data algebra but not MCP unit conversion/job application. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/multicam.test.ts`

Independent source: docs/wp-notes/multicam.md signed offsets, sync confidence and angle selection. Owner inspected: `apps/mcp/src/tools/multicam.ts`. Oracle: Explicit 60/30-frame offsets, actual switched/flattened document and unreliable-sync refusal. Non-test callers / other coverage: Public multicam tools; project commands do not interpret engine audio alignment samples.

### REWRITE — `creates a multicam by audio, places it, switches, records, lists and flattens`

Remove tool inventory; retain signed audio-offset conversion, angle selection and real document flattening.

1. Independent contract: docs/wp-notes/multicam.md signed offsets, sync confidence and angle selection; the exact case is “creates a multicam by audio, places it, switches, records, lists and flattens”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 60/30-frame offsets, actual switched/flattened document and unreliable-sync refusal.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public multicam tools; project commands do not interpret engine audio alignment samples. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `refuses unreliable audio unless asked, and merges clips`

1. Independent contract: docs/wp-notes/multicam.md signed offsets, sync confidence and angle selection; the exact case is “refuses unreliable audio unless asked, and merges clips”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 60/30-frame offsets, actual switched/flattened document and unreliable-sync refusal.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public multicam tools; project commands do not interpret engine audio alignment samples. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `synchronizes timeline clips by audio against the reference the command uses`

1. Independent contract: docs/wp-notes/multicam.md signed offsets, sync confidence and angle selection; the exact case is “synchronizes timeline clips by audio against the reference the command uses”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 60/30-frame offsets, actual switched/flattened document and unreliable-sync refusal.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public multicam tools; project commands do not interpret engine audio alignment samples. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/png-limits.test.ts`

Independent sources: PNG scanline encoding; AGENTS §0 untrusted dimensions; `docs/wp-notes/mcp-cli.md` explicitly records preserving 8K support and refusing surplus inflated data. Production owner: `apps/mcp/src/png.ts`, used by contact-sheet tools. These tests do not prove an upper bound on inflation allocation.

### KEEP — `refuses oversized dimensions before expanding the compressed data`

1. Contract: untrusted dimensions above the supported pixel ceiling must return E_LIMIT.
2. Failure: a hostile header crashes, proceeds to codec errors, or loses the caller-visible limit refusal.
3. Oracle: explicit UINT32_MAX dimensions and E_LIMIT are independently specified; no production limit constant supplies the expectation.
4. Seam: production decodePng input/error boundary.
5. Refactor tolerance: no zlib call, helper order, source text or private object shape is asserted.
6. Lowest owner: the codec owns validation; render/contact-sheet integration never submits this hostile header. This fixed case uniquely checks the E_LIMIT error rather than merely a thrown ToolError.
Risk/check: low; run this file and MCP typecheck in the integrated gate.

### REWRITE — `allows an 8K source header through the dimension guard`

Replace the malformed-header surrogate with `decodes an 8K source image`: a valid grayscale PNG must actually decode successfully. This correction was recorded before editing the follow-up.

1. Contract: `docs/wp-notes/mcp-cli.md` records the compatibility decision to allow 8K and preserve supported image decoding; this is independent of the codec source comment.
2. Failure: an accidentally lowered dimension ceiling or broken large-image decode refuses a valid 7680×4320 source.
3. Oracle: explicit 8K dimensions, PNG grayscale scanlines and opaque black RGBA pixels; no production helper supplies expected pixels or sizes.
4. Seam: decodePng receives encoded bytes and returns the actual image.
5. Refactor tolerance: successful image data survives replacing zlib, reorganizing guards or decoder internals.
6. Lowest owner: decodePng owns source-image compatibility; tiny protocol vectors and small-dimension properties cannot detect rejecting 8K. Rendering an 8K editor workflow adds unrelated layers.
Risk/check: test allocates approximately 33 MB grayscale scanlines and 133 MB decoded RGBA data; root owns scheduled execution. No resource-usage limit is asserted or claimed.

### DELETE — `refuses compressed data that expands beyond its declared scanlines`

The error-only bomb assertion passes if maxOutputLength is removed, because the later raw-length check still throws ToolError. It proves malformed length rejection already covered by the retained property, not bounded allocation. No independent resource regression is lost by deletion. Removed the compressed-byte-count assertion too: it describes the test fixture. Non-test callers of decodePng remain unchanged. Risk low; validate the remaining file at integration.

### REWRITE — `bounds inflation for varied dimensions and rejects oversized hostile dimensions`

Rename to `validates dimensions and scanline lengths across varied PNG inputs` and correct its coverage claim; retain the existing assertions.

1. Contract: valid small PNG dimensions/scanlines decode; surplus scanline data and hostile dimensions must be rejected (PNG protocol and AGENTS entry validation).
2. Failure: valid files fail, returned raster dimensions/length disagree with the authored header, or malformed files are accepted.
3. Oracle: generated widths/heights and the PNG-specified four channels plus one filter byte per row, independent of implementation helpers.
4. Seam: encoded PNG bytes into the production decoder, observing decoded data/errors.
5. Refactor tolerance: no private zlib options or implementation sequence are asserted; the name no longer claims them.
6. Lowest owner: codec-level seeded parser properties vary valid and malformed sizes; fixed protocol vectors cover channel/filter bytes, while the fixed oversized case owns the exact E_LIMIT code.
Risk/check: unchanged small-input assertions; execute the file and MCP typecheck at integration. This property does not detect an unbounded inflate followed by a correct length refusal.

## `apps/mcp/test/polish.test.ts`

Independent source: Public browse_media arguments and local file privacy contract; README MCP media browsing. Owner inspected: `apps/mcp/src/tools/polish.ts`. Oracle: Requested video filtering retains folders, excludes audio/captions and enforces limit/probe options. Non-test callers / other coverage: Public browse_media; engine tests own actual disk enumeration.

### DELETE — `answers the places without a path`

Mock root entries are simply echoed; engine file-browse tests own directory enumeration. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### REWRITE — `lists a folder, filters by kind, limits and probes`

1. Independent contract: Public browse_media arguments and local file privacy contract; README MCP media browsing; the exact case is “lists a folder, filters by kind, limits and probes”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes requested video filtering retains folders, excludes audio/captions and enforces limit/probe options.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public browse_media; engine tests own actual disk enumeration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `is read-only and reports a remote engine as an error result`

Mock supplies LOCAL_MODE_ONLY; generic engine-to-MCP errors and catalogue annotation contracts have stronger retained owners. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

## `apps/mcp/test/presets.test.ts`

Independent source: docs/wp-notes/effect-presets.md public search, anchor-to-out and built-in immutability. Owner inspected: `apps/mcp/src/tools/presets.ts`. Oracle: Explicit 20/29→80/89 keyframe placement and real applied effect values. Non-test callers / other coverage: Public preset tools; model owns serialized preset schema, MCP owns selection/anchor request mapping.

### REWRITE — `lists built-ins and the user library, with search and annotations`

Remove minimum built-in count and duplicate annotations; retain query filtering.

1. Independent contract: docs/wp-notes/effect-presets.md public search, anchor-to-out and built-in immutability; the exact case is “lists built-ins and the user library, with search and annotations”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 20/29→80/89 keyframe placement and real applied effect values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public preset tools; model owns serialized preset schema, MCP owns selection/anchor request mapping. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `saves from a clip, applies by id with Anchor to Out, and deletes`

Remove transaction label copy and fake-library deletion echo; retain anchor-to-out keyframe mapping and built-in delete refusal.

1. Independent contract: docs/wp-notes/effect-presets.md public search, anchor-to-out and built-in immutability; the exact case is “saves from a clip, applies by id with Anchor to Out, and deletes”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 20/29→80/89 keyframe placement and real applied effect values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public preset tools; model owns serialized preset schema, MCP owns selection/anchor request mapping. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `applies inline JSON and a built-in to several clips in one transaction; validates authored presets`

1. Independent contract: docs/wp-notes/effect-presets.md public search, anchor-to-out and built-in immutability; the exact case is “applies inline JSON and a built-in to several clips in one transaction; validates authored presets”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 20/29→80/89 keyframe placement and real applied effect values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public preset tools; model owns serialized preset schema, MCP owns selection/anchor request mapping. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/previews.test.ts`

Independent source: docs/wp-notes/previews.md public render-bar ranges and render request modes. Owner inspected: `apps/mcp/src/tools/previews.ts`. Oracle: Independently placed clips at 0,10,20,30,60 and public HTTP job request/result. Non-test callers / other coverage: Public preview tools; project owns segmentation/hash arithmetic; engine owns cache file deletion/perf counters.

### REWRITE — `get_render_bar_state reports the segments with their state, cost and reasons`

Use independently specified timeline boundaries instead of previewSegments output as the expected range; remove duplicate annotations.

1. Independent contract: docs/wp-notes/previews.md public render-bar ranges and render request modes; the exact case is “get_render_bar_state reports the segments with their state, cost and reasons”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes independently placed clips at 0,10,20,30,60 and public http job request/result.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public preview tools; project owns segmentation/hash arithmetic; engine owns cache file deletion/perf counters. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `render_previews sends the document and waits for the job; delete_render_files computes the range hashes`

Remove deletion/hash self-comparison and fake deletion echo; retain range/mode HTTP request and job completion contract.

1. Independent contract: docs/wp-notes/previews.md public render-bar ranges and render request modes; the exact case is “render_previews sends the document and waits for the job; delete_render_files computes the range hashes”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes independently placed clips at 0,10,20,30,60 and public http job request/result.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public preview tools; project owns segmentation/hash arithmetic; engine owns cache file deletion/perf counters. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `perf_stats joins the engine counters and the editor window`

Mock counters are echoed; no playback or performance collection is exercised. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

## `apps/mcp/test/processing.test.ts`

Independent source: docs/specs/07-clip-processing.md safety, media-version coverage and sidecars. Owner inspected: `apps/mcp/src/tools/processing.ts`. Oracle: Real processed files/document versions, explicit handle ranges, fit refusal/trim and destructive metadata. Non-test callers / other coverage: Public processing workflow; pure model tests do not exercise actual processing/sidecars.

### KEEP — `marks processing settings as destructive in the MCP tool schema`

1. Independent contract: docs/specs/07-clip-processing.md safety, media-version coverage and sidecars; the exact case is “marks processing settings as destructive in the MCP tool schema”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real processed files/document versions, explicit handle ranges, fit refusal/trim and destructive metadata.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public processing workflow; pure model tests do not exercise actual processing/sidecars. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `set_processing_settings needs the user in an open editor`

1. Independent contract: docs/specs/07-clip-processing.md safety, media-version coverage and sidecars; the exact case is “set_processing_settings needs the user in an open editor”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real processed files/document versions, explicit handle ranges, fit refusal/trim and destructive metadata.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public processing workflow; pure model tests do not exercise actual processing/sidecars. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `process_clip (denoise, local, replace, wait) swaps the clip to the processed version`

1. Independent contract: docs/specs/07-clip-processing.md safety, media-version coverage and sidecars; the exact case is “process_clip (denoise, local, replace, wait) swaps the clip to the processed version”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real processed files/document versions, explicit handle ranges, fit refusal/trim and destructive metadata.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public processing workflow; pure model tests do not exercise actual processing/sidecars. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `process_clip with handles processes only the clip range (+ handles) and keeps the source frames`

1. Independent contract: docs/specs/07-clip-processing.md safety, media-version coverage and sidecars; the exact case is “process_clip with handles processes only the clip range (+ handles) and keeps the source frames”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real processed files/document versions, explicit handle ranges, fit refusal/trim and destructive metadata.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public processing workflow; pure model tests do not exercise actual processing/sidecars. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `use_media_version refuses a version that does not cover a clip, or trims with fit: "trim"`

1. Independent contract: docs/specs/07-clip-processing.md safety, media-version coverage and sidecars; the exact case is “use_media_version refuses a version that does not cover a clip, or trims with fit: "trim"”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real processed files/document versions, explicit handle ranges, fit refusal/trim and destructive metadata.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public processing workflow; pure model tests do not exercise actual processing/sidecars. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `import_media links a render with a sidecar to its source; set_media_source_range; replace_footage keeps timing`

1. Independent contract: docs/specs/07-clip-processing.md safety, media-version coverage and sidecars; the exact case is “import_media links a render with a sidecar to its source; set_media_source_range; replace_footage keeps timing”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real processed files/document versions, explicit handle ranges, fit refusal/trim and destructive metadata.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public processing workflow; pure model tests do not exercise actual processing/sidecars. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/qa/scenarios.test.ts`

Independent source: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows. Owner inspected: `apps/mcp/src/server.ts, real engine and render pipeline`. Oracle: Generated fixture truth, measured pixel/color/frame results and recorded QA artifacts. Non-test callers / other coverage: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes.

### KEEP — `rough cut: place, split, ripple-delete and stack shots; every cut shows the right picture`

1. Independent contract: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows; the exact case is “rough cut: place, split, ripple-delete and stack shots; every cut shows the right picture”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes generated fixture truth, measured pixel/color/frame results and recorded qa artifacts.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `colour grade: exposure brightens, saturation 0 makes grey, get_grade reads it back`

1. Independent contract: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows; the exact case is “colour grade: exposure brightens, saturation 0 makes grey, get_grade reads it back”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes generated fixture truth, measured pixel/color/frame results and recorded qa artifacts.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `titles: a white title is drawn where it is placed and follows its position`

1. Independent contract: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows; the exact case is “titles: a white title is drawn where it is placed and follows its position”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes generated fixture truth, measured pixel/color/frame results and recorded qa artifacts.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `transitions: a cross dissolve mixes red into blue across the cut`

1. Independent contract: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows; the exact case is “transitions: a cross dissolve mixes red into blue across the cut”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes generated fixture truth, measured pixel/color/frame results and recorded qa artifacts.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `keyframes: opacity fades the title in, position keys move it, evaluated matches the render`

1. Independent contract: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows; the exact case is “keyframes: opacity fades the title in, position keys move it, evaluated matches the render”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes generated fixture truth, measured pixel/color/frame results and recorded qa artifacts.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `export and re-import: the file has every frame and plays back like the timeline`

1. Independent contract: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows; the exact case is “export and re-import: the file has every frame and plays back like the timeline”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes generated fixture truth, measured pixel/color/frame results and recorded qa artifacts.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `cancelling a waiting export over MCP cancels the engine job and leaves no file`

1. Independent contract: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows; the exact case is “cancelling a waiting export over MCP cancels the engine job and leaves no file”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes generated fixture truth, measured pixel/color/frame results and recorded qa artifacts.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/readme-tools.test.ts`

### DELETE — `README lists every MCP tool, and only those`

Source/README tool inventory is a change detector, not execution of a public behavior. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

## `apps/mcp/test/roto.test.ts`

Independent source: Public roto propagation/render/export contract; AGENTS §4 preview/export fidelity. Owner inspected: `apps/mcp/src/tools/roto.ts`. Oracle: Generated known object mask, independent IoU ≥0.93 and exported frames. Non-test callers / other coverage: Actual roto workflow with retained artifact; lower mask tests cannot prove pipeline fidelity.

### KEEP — `create_roto → propagate → render_frame / export cut the object out (IoU ≥ 0.93), masks, refusals`

1. Independent contract: Public roto propagation/render/export contract; AGENTS §4 preview/export fidelity; the exact case is “create_roto → propagate → render_frame / export cut the object out (IoU ≥ 0.93), masks, refusals”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes generated known object mask, independent iou ≥0.93 and exported frames.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Actual roto workflow with retained artifact; lower mask tests cannot prove pipeline fidelity. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/sim-warp.test.ts`

Independent source: docs/wp-notes/sim-warp.md public Puppet pin animation. Owner inspected: `apps/mcp/src/tools/sim-warp.ts`. Oracle: Known pin coordinates and independently evaluated keyframe positions after real commands. Non-test callers / other coverage: Public Puppet tools; project deformation tests own packed mesh representation.

### KEEP — `Puppet: add, move, record, get, remove pins`

1. Independent contract: docs/wp-notes/sim-warp.md public Puppet pin animation; the exact case is “Puppet: add, move, record, get, remove pins”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes known pin coordinates and independently evaluated keyframe positions after real commands.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public Puppet tools; project deformation tests own packed mesh representation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `Liquify stroke and reset; Mesh Warp vertex; refusals`

Packed mesh slices and nonzero/length probes inspect implementation representation without an independent geometric result; project deformation commands own that behavior. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

## `apps/mcp/test/speech.test.ts`

Independent source: docs/wp-notes/speech.md transcribe/translate/media/mix timeline contracts. Owner inspected: `apps/mcp/src/tools/speech.ts`. Oracle: Known engine word times mapped into actual transcript documents and clip coverage. Non-test callers / other coverage: Public speech tools; engine owns speech model installation; project owns transcript model.

### DELETE — `lists and installs models`

Fake model installer implements the entire asserted result; no real installation, persistence or model bytes are observed. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `transcribes a media, commits one step, and reads it back`

1. Independent contract: docs/wp-notes/speech.md transcribe/translate/media/mix timeline contracts; the exact case is “transcribes a media, commits one step, and reads it back”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes known engine word times mapped into actual transcript documents and clip coverage.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public speech tools; engine owns speech model installation; project owns transcript model. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `a sequence in media mode transcribes only untranscribed clip media; wait: false then jobIds commits`

1. Independent contract: docs/wp-notes/speech.md transcribe/translate/media/mix timeline contracts; the exact case is “a sequence in media mode transcribes only untranscribed clip media; wait: false then jobIds commits”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes known engine word times mapped into actual transcript documents and clip coverage.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public speech tools; engine owns speech model installation; project owns transcript model. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `a sequence mix gives the words to the clip media (media time, coverage) and drops words outside the clips`

1. Independent contract: docs/wp-notes/speech.md transcribe/translate/media/mix timeline contracts; the exact case is “a sequence mix gives the words to the clip media (media time, coverage) and drops words outside the clips”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes known engine word times mapped into actual transcript documents and clip coverage.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public speech tools; engine owns speech model installation; project owns transcript model. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `refuses bad targets and an uninstalled model with a hint`

1. Independent contract: docs/wp-notes/speech.md transcribe/translate/media/mix timeline contracts; the exact case is “refuses bad targets and an uninstalled model with a hint”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes known engine word times mapped into actual transcript documents and clip coverage.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public speech tools; engine owns speech model installation; project owns transcript model. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/structure.test.ts`

Independent source: docs/wp-notes/edit-structure.md nesting and unnesting public sequence behavior. Owner inspected: `apps/mcp/src/tools/structure.ts`. Oracle: Real nested sequence and placed/unnested document state. Non-test callers / other coverage: Public structure tools; project owns adjustment/groups/synthetic command semantics.

### DELETE — `lists the tools`

Tool-name inventory. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `nests, lists, places and unnests`

1. Independent contract: docs/wp-notes/edit-structure.md nesting and unnesting public sequence behavior; the exact case is “nests, lists, places and unnests”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes real nested sequence and placed/unnested document state.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public structure tools; project owns adjustment/groups/synthetic command semantics. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `adjustment layers, groups, synthetics, through edits, gaps, subsequences and frame holds`

Broad success-only command smoke plus weak counts; structure command owners cover actual edits and nest/unnest remains at the MCP boundary. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

## `apps/mcp/test/templates.test.ts`

Independent source: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006. Owner inspected: `apps/mcp/src/tools/templates.ts and src/tools/render.ts`. Oracle: Public keyframable types, real parameter changes, exact error codes and actionable environment key. Non-test callers / other coverage: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers.

### KEEP — `reports renderer, native and a compact params summary with keyframable flags`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “reports renderer, native and a compact params summary with keyframable flags”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `rejects invalid parameter values and names with E_INVALID_PARAM`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “rejects invalid parameter values and names with E_INVALID_PARAM”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `keeps RENDERER_UNAVAILABLE for fframes templates`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “keeps RENDERER_UNAVAILABLE for fframes templates”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `explains a failed still (Remotion unavailable) with the Remotion hint`

Duplicate failed-still hint path: retained render_frame test observes both thrown and failed-job render errors through the same owner. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `sets static params and preserves template defaults`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “sets static params and preserves template defaults”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `keyframes numeric and colour params of anime templates (setAnimated + set at the frame)`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “keyframes numeric and colour params of anime templates (setAnimated + set at the frame)”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `validates the clip, the param names, values, times and the renderer`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “validates the clip, the param names, values, times and the renderer”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `render_frame: TEMPLATE_NOT_INSTALLED and a missing browser`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “render_frame: TEMPLATE_NOT_INSTALLED and a missing browser”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `start_export preserves plan errors and explains unavailable rendering`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “start_export preserves plan errors and explains unavailable rendering”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `wait_for_job: a failed export explains Remotion; cancelled jobs get no hint`

1. Independent contract: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006; the exact case is “wait_for_job: a failed export explains Remotion; cancelled jobs get no hint”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes public keyframable types, real parameter changes, exact error codes and actionable environment key.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/text-animators.test.ts`

Independent source: docs/wp-notes/text-animators.md public selectors and path options. Owner inspected: `apps/mcp/src/tools/text-animators.ts`. Oracle: Explicit animator values/keyframes/ranges and created guide path. Non-test callers / other coverage: Public animator tools; project owns preset contents and path-clear commands.

### DELETE — `lists presets and applies one`

Catalogue length derived from production plus preset name/key count; project animator preset tests own authored values. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `add_text_animator with values, keys and a range; add_text_selector; get; remove`

1. Independent contract: docs/wp-notes/text-animators.md public selectors and path options; the exact case is “add_text_animator with values, keys and a range; add_text_selector; get; remove”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit animator values/keyframes/ranges and created guide path.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public animator tools; project owns preset contents and path-clear commands. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### REWRITE — `set_text_path creates a guide mask and Path Options; null removes`

Remove success-only null-clear probe; retain created guide geometry and path options.

1. Independent contract: docs/wp-notes/text-animators.md public selectors and path options; the exact case is “set_text_path creates a guide mask and Path Options; null removes”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit animator values/keyframes/ranges and created guide path.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public animator tools; project owns preset contents and path-clear commands. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/three-d.test.ts`

Independent source: docs/wp-notes/three-d.md public camera/light/layer scene data. Owner inspected: `apps/mcp/src/tools/three-d.ts`. Oracle: Explicit 50mm camera, depth-of-field, spot light and persisted 3D layers. Non-test callers / other coverage: Public 3D tools; project owns command refusals and schema validation.

### REWRITE — `builds a 3D scene and reads it back`

Remove tool inventory; retain persisted camera/light/layer properties.

1. Independent contract: docs/wp-notes/three-d.md public camera/light/layer scene data; the exact case is “builds a 3D scene and reads it back”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit 50mm camera, depth-of-field, spot light and persisted 3d layers.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public 3D tools; project owns command refusals and schema validation. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `refusals are tool errors`

Generic isError checks with invalid IDs/arguments can pass for unrelated validation failures; model refusals and strict MCP schema tests retain the actual contracts. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

## `apps/mcp/test/time.test.ts`

Independent source: docs/wp-notes/time.md speed remapping and scene-edit application. Owner inspected: `apps/mcp/src/tools/time.ts`. Oracle: Half-speed duration and explicitly supplied scene cuts converted to linked real edits. Non-test callers / other coverage: Public time tools; project owns pure remap command algebra, engine owns scene detection.

### KEEP — `remaps a clip: half speed, ramp, freeze, reverse, then removes it`

1. Independent contract: docs/wp-notes/time.md speed remapping and scene-edit application; the exact case is “remaps a clip: half speed, ramp, freeze, reverse, then removes it”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes half-speed duration and explicitly supplied scene cuts converted to linked real edits.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public time tools; project owns pure remap command algebra, engine owns scene detection. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `Scene Edit Detection runs the engine job and applies cuts, markers and scene items in one step`

1. Independent contract: docs/wp-notes/time.md speed remapping and scene-edit application; the exact case is “Scene Edit Detection runs the engine job and applies cuts, markers and scene items in one step”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes half-speed duration and explicitly supplied scene cuts converted to linked real edits.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public time tools; project owns pure remap command algebra, engine owns scene detection. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/tool-response.test.ts`

### DELETE — `preserves error details for assertions about rejected input`

Test of a test-only JSON helper, no independent product contract. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### DELETE — `rejects a non-object response: %s`

Parameterized tests of a test-only helper, no independent product contract. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### DELETE — `refuses absent text and malformed nested fields instead of asserting their types`

Test of a test-only helper, no independent product contract. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

## `apps/mcp/test/tracking.test.ts`

Independent source: Public corner-pin pixel coordinates and tracker application; AGENTS §4 fidelity. Owner inspected: `apps/mcp/src/tools/tracking.ts`. Oracle: Explicit requested pixels and independently generated tracking truth within 3px. Non-test callers / other coverage: Actual tracking render workflow retains artifact; project tests cannot prove tracker-to-render integration.

### KEEP — `set_corner_pin stores the requested sequence-pixel corners on the clip`

1. Independent contract: Public corner-pin pixel coordinates and tracker application; AGENTS §4 fidelity; the exact case is “set_corner_pin stores the requested sequence-pixel corners on the clip”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit requested pixels and independently generated tracking truth within 3px.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Actual tracking render workflow retains artifact; project tests cannot prove tracker-to-render integration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `add_tracker + track + apply_tracking + render_frame pins the overlay within 3 px of the ground truth`

1. Independent contract: Public corner-pin pixel coordinates and tracker application; AGENTS §4 fidelity; the exact case is “add_tracker + track + apply_tracking + render_frame pins the overlay within 3 px of the ground truth”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit requested pixels and independently generated tracking truth within 3px.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Actual tracking render workflow retains artifact; project tests cannot prove tracker-to-render integration. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/transitions.test.ts`

Independent source: S10:TUI-034 default preferences; published transition label/parameter contract. Owner inspected: `apps/mcp/src/tools/transitions.ts`. Oracle: Authored editor preference overrides/fallbacks and canonical GPU transition data. Non-test callers / other coverage: Public transition tools; project owns interpolation rendering, MCP owns preferences/label resolution.

### KEEP — `uses the open editor’s default types and alignment`

1. Independent contract: S10:TUI-034 default preferences; published transition label/parameter contract; the exact case is “uses the open editor’s default types and alignment”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored editor preference overrides/fallbacks and canonical gpu transition data.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public transition tools; project owns interpolation rendering, MCP owns preferences/label resolution. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `lets call arguments override the editor value by value`

1. Independent contract: S10:TUI-034 default preferences; published transition label/parameter contract; the exact case is “lets call arguments override the editor value by value”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored editor preference overrides/fallbacks and canonical gpu transition data.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public transition tools; project owns interpolation rendering, MCP owns preferences/label resolution. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `falls back to the built-ins for invalid editor values`

1. Independent contract: S10:TUI-034 default preferences; published transition label/parameter contract; the exact case is “falls back to the built-ins for invalid editor values”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored editor preference overrides/fallbacks and canonical gpu transition data.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public transition tools; project owns interpolation rendering, MCP owns preferences/label resolution. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### DELETE — `lists the catalogue with bins and params`

Catalogue category/identifier inventory; actual transition normalization and preference behavior remain. Observable failure removed: implementation/test-fixture changes or the duplicate behavior identified above. No unique independently specified behavior is lost. Risk: low; remaining owners identified above and the integrated gate validate the deletion. No production caller requires this test.

### KEEP — `adds a GPU transition by label with params and updates its params`

1. Independent contract: S10:TUI-034 default preferences; published transition label/parameter contract; the exact case is “adds a GPU transition by label with params and updates its params”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored editor preference overrides/fallbacks and canonical gpu transition data.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public transition tools; project owns interpolation rendering, MCP owns preferences/label resolution. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/unit.test.ts`

Independent source: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version. Owner inspected: `apps/mcp/src/discovery.ts, src/link.ts, src/errors.ts and src/export-presets.ts`. Oracle: Explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values. Non-test callers / other coverage: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes.

### KEEP — `reports a non-Error health rejection: %s`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “reports a non-Error health rejection: %s”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `prefers explicit URL/token (flags over env)`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “prefers explicit URL/token (flags over env)”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `reads <appdir>/engine/runtime.json (token included) and skips stale or dead entries`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “reads <appdir>/engine/runtime.json (token included) and skips stale or dead entries”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `falls back to the default dev port`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “falls back to the default dev port”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `discovery rejects non-engine answers`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “discovery rejects non-engine answers”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `EngineLink reports an actionable error when nothing runs`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “EngineLink reports an actionable error when nothing runs”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `re-discovers after a refused read and returns the project list`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “re-discovers after a refused read and returns the project list”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `a request that never answers ends with ENGINE_TIMEOUT instead of hanging`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “a request that never answers ends with ENGINE_TIMEOUT instead of hanging”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `a write cut off mid-flight is reported, not retried (it may have been applied)`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “a write cut off mid-flight is reported, not retried (it may have been applied)”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `a write that never reached the engine, and any read, stay retryable NETWORK errors`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “a write that never reached the engine, and any read, stay retryable NETWORK errors”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `maps tool, engine and transaction errors to isError results with hints`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “maps tool, engine and transaction errors to isError results with hints”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `caller quality overrides take precedence over export preset defaults`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “caller quality overrides take precedence over export preset defaults”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `the --version CLI reports the package version`

1. Independent contract: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version; the exact case is “the --version CLI reports the package version”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the production PNG, discovery, network, timeline-format or executable boundary appropriate to this case; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/vector-shapes.test.ts`

Independent source: Published vector shape/SVG tools; serialized shape path and dry-run contracts. Owner inspected: `apps/mcp/src/tools/shapes.ts`. Oracle: Authored taper/transform/path values and unchanged document on SVG dry-run. Non-test callers / other coverage: Public vector tools; project SVG parser does not own MCP dry-run/document conversion.

### REWRITE — `presets, add, get, update (nested taper / transform), path edits, remove`

Remove preset-name inventory; retain nested shape changes and path edits.

1. Independent contract: Published vector shape/SVG tools; serialized shape path and dry-run contracts; the exact case is “presets, add, get, update (nested taper / transform), path edits, remove”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored taper/transform/path values and unchanged document on svg dry-run.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public vector tools; project SVG parser does not own MCP dry-run/document conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `svg_to_shape: dry run reports warnings, apply adds a clip; convert_shape_to_vector`

1. Independent contract: Published vector shape/SVG tools; serialized shape path and dry-run contracts; the exact case is “svg_to_shape: dry run reports warnings, apply adds a clip; convert_shape_to_vector”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes authored taper/transform/path values and unchanged document on svg dry-run.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public vector tools; project SVG parser does not own MCP dry-run/document conversion. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## `apps/mcp/test/versions.test.ts`

Independent source: docs/project-files.md restore-copy/lease/journal safety; public version tools. Owner inspected: `apps/mcp/src/tools/versions.ts`. Oracle: Explicit safe restore mode, version sizes/kinds and read-only recoverable journal summary. Non-test callers / other coverage: Public version tools; storage owner handles files, MCP owns safe default and compact response mapping.

### REWRITE — `lists versions with their kind and restores as a copy or in place`

Remove tool inventory and exact UI wording; retain restore-copy safety default and lease refusal.

1. Independent contract: docs/project-files.md restore-copy/lease/journal safety; public version tools; the exact case is “lists versions with their kind and restores as a copy or in place”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit safe restore mode, version sizes/kinds and read-only recoverable journal summary.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public version tools; storage owner handles files, MCP owns safe default and compact response mapping. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

### KEEP — `reports recoverable unsaved changes without acting on them`

1. Independent contract: docs/project-files.md restore-copy/lease/journal safety; public version tools; the exact case is “reports recoverable unsaved changes without acting on them”.
2. Detectable failure: the caller receives incorrect data/state, a wrong refusal, an omitted required result or a failed workflow for this case; the assertion observes explicit safe restore mode, version sizes/kinds and read-only recoverable journal summary.
3. Independent expectation: authored request/fixture values, specified error/config rules or external artifact truth supply the expected result; the expected result is not obtained by calling the implementation under test.
4. Stable seam: the public MCP/CLI request/result boundary; no private collaborator order/count is required.
5. Refactor tolerance: moving handlers/helpers or changing internal decomposition preserves these input/output/state assertions; no source, markup, export-list or private call-shape snapshot is used.
6. Lowest owner / uniqueness: Public version tools; storage owner handles files, MCP owns safe default and compact response mapping. This case protects the boundary conversion, error class or required complete workflow in its name; lower-layer algorithm tests cannot detect that boundary failure. Its remaining sibling cases use different inputs/contracts rather than replaying this same outcome.
Risk: retained behavior unchanged; any new failure requires owner investigation. Validation: the file command above and package typecheck.

## Completed support/seam cleanup

- Removed orphan PNG chunk helper, unused fake endpoints/call logs, response schema fixtures and imports associated with deleted cases.
- Removed MCP suggestKey re-export: @jasper/project owns suggestions and tests it; MCP has no production caller of that re-export.
- Made describeInterpretation private; its only external use is a test type assertion. Its local production callers remain.
- Made CLI parser/type/error helpers private; package exports exposes src/index.ts (server/EngineLink), not these helpers. runCli and actual executables remain. Root approved these source de-exports.
- Kept tool-response.ts: retained caption/speech tests consume it. Deleted only its self-tests.

## Validation and completion

Audit inventory: 42 files; 163 named test declarations ({'KEEP': 115, 'DELETE': 24, 'REWRITE': 24}), plus the generated fuzz families. Parameter expansions are not counted as separate declarations.

Cleanup implemented for all 42 audited files. Three test files were removed entirely (`fuzz`, `readme-tools`, `tool-response`); retained/rewritten named tests remain in the other 39 files. The test source diff is net negative. No production behavior changed.

Removed dead support: PNG `pngChunk` and zlib imports; auto-tone/model-list response schemas; canned speech installer, preview deletion/perf/UI and browse roots/remote responses; copied color-management scene-detection stub/call log; transaction retry logs; library-delete mock; catalogue-only client return values; production-derived animator preset count import; the response type coupling that kept `describeInterpretation` exported. `tool-response.ts` and real render/QA fixture harnesses remain in use.

Removed unused MCP `@jasper/testkit` devDependency after confirming no source/test imports remain. Root explicitly owns the lockfile regeneration after package changes are integrated; no hand-edited lockfile is included here.

Checks actually run: `git diff --check` passed; Biome checked every modified surviving source/test/package file, with its sole speech import-format finding corrected and rechecked. Final diff reviewed. Focused Vitest, MCP typecheck, rendering/QA and full repository gates were not run in this worktree: root requested no new workers on the overloaded shared host and owns the integrated validation. No baseline behavioral failure was observed because these suites were not executed here. This is completed pruning with integration validation pending, not a claim that tests passed.

Specific remaining stronger owners for deleted overlaps: `apps/mcp/test/png-limits.test.ts`; SDK cancellation in `conventions.test.ts`; `packages/project/test/agent-mcp-cli.test.ts`; `packages/project/test/edit-structure.test.ts`; `packages/project/test/sim-warp-commands.test.ts`; `packages/project/test/text-animators.test.ts`; `packages/project/test/color-match.test.ts`; `apps/engine/test/browse.test.ts`; `apps/engine/test/effect-presets.test.ts`; `apps/engine/test/previews.test.ts`; and real CLI tests in `jasper-cli.test.ts`. Other agents may also prune these owners only under the same independent-contract rule.

Documentation follow-up for integration: `docs/wp-notes/code-audit-mcp.md` describes the now-deleted response-reader self-tests, exported interpretation return-type coupling, auto-tone key inventory and README coverage. Those historical validation claims are not current suite requirements; the root report should use this disposition inventory instead.

## PNG cross-review correction

Before this follow-up edit, cross-review established that a generic ToolError cannot distinguish bounded inflation from an unbounded inflate followed by a length error. The bomb duplicate is deleted and the seeded property is described solely as input/length validation. Actual 8K decoding replaces the deleted malformed-header surrogate because the independent work note preserves 8K compatibility. Production code is unchanged. Follow-up Biome and git diff --check passed. Vitest/MCP typecheck remain subject to root scheduling.

## Final shared-oracle / private-call rescan (before edit)

Base inspected: integrated `cf890a2977b8ab07ecde699417db7c5a755abdd3`; follow-up edits are isolated in `prune2-mcp-final`. All retained MCP files were rescanned for imported production computations in expectations and recorded collaborator calls. These are the genuine remaining candidates; disposition supplements the corresponding original-name entry above.

### REWRITE — `apps/mcp/test/presets.test.ts`: `saves from a clip, applies by id with Anchor to Out, and refuses built-in deletion`

The expected frame positions divide stored times by production `flicksPerFrame`, also used by the preset time mapper. A wrong frame conversion could cancel itself between output and assertion. Replace only that test constant with independently calculated 23,520,000 flicks/frame (705,600,000 / 30, architecture's persisted unit). The expected anchor offsets stay authored 20/29 and 80/89.

1. Contract: documented preset offsets in flicks and Anchor to Out preserving distance to the last frame (`docs/wp-notes/effect-presets.md`, Time mapping; architecture time unit).
2. Failure: saved/applied key times drift or use the wrong unit.
3. Oracle: authored frame offsets and the fixed document unit, independent of production conversion functions.
4. Seam: public MCP save/apply and actual serialized preset/document data.
5. Refactor tolerance: converter implementation, effect creation and preset helper decomposition may change without changing expected data.
6. Lowest owner: this verifies MCP save/library-id resolution/application; pure time-mapper tests cannot prove that boundary. It does not add another pure converter test.
Callers: `flicksPerFrame` is used throughout project preset/time/command code; it is retained in production. Only its test import is removed. Risk low; run the preset file and package typecheck in integration.

### REWRITE — `apps/mcp/test/presets.test.ts`: `applies inline JSON and a built-in to several clips in one transaction; validates authored presets`

Use the same independent frame unit. Replace the fixture's private `txs.length` assertion with the revision returned by public `get_project` before and after application. Remove the now-unused transaction log.

1. Contract: FX-010/FX-030 and the preset guide require one undoable change for N clips.
2. Failure: the multi-clip operation creates more than one document revision or applies wrong per-clip key times/values.
3. Oracle: one revision increment and explicit authored fade positions/values, not a count copied from handler calls.
4. Seam: MCP apply/get_project and actual document state.
5. Refactor tolerance: retries, helper calls and internal transaction construction can change while preserving the public committed revision.
6. Lowest owner: the protocol boundary owns batching N selected clips into the documented one change; project preset tests own the pure command.
Callers/support: `txs` exists only in this test fake and has no non-test callers; delete its declaration/push/returned field. Production revision/query functions have real MCP callers and remain. Risk low; no new production seam.

### REWRITE — `apps/mcp/test/audio-fx.test.ts`: `lists the catalogue, adds with keyframes, edits, reorders, bypasses and removes`

Delete the leftover hard-limiter/amplify catalogue-membership probe and rename the case to its actual edit contract. It did not prove folder filtering and was not necessary setup for either effect.

1. Contract: published audio tools add caller-authored keys/values, change stack order/state and remove the chosen effect.
2. Failure: requested values are lost, the wrong effect moves/is disabled or removal leaves the effect behind.
3. Oracle: explicit -6/3/-3 gain values and requested effect identity; no catalogue derives expectations.
4. Seam: MCP and real document commands.
5. Refactor tolerance: effect registry enumeration/order can change without failing this editing contract.
6. Lowest owner: MCP units/time/selection mapping is unique to this boundary; registry membership has no separate protection claim.
Callers: removed local `list`/`ids` have no callers outside the case. Production listing remains used by users. Risk low; run audio-fx in integration.

### REWRITE — `apps/mcp/test/audio-fx.test.ts`: `type, preset, options, Auto-Match, ducking, clear`

The assertions normalize stored settings with production `readEssentialSound`, which merges defaults and is also used by the owner. Assert only the explicitly required persisted fields directly. Remove the preset-list default-copy assertion and the unused dynamically selected preset; later explicit noise options, loudness matching, ducking and clearing are the observed contract.

1. Contract: `docs/wp-notes/audio-fx.md` §1.2–1.4 and the public MCP guide require authored noise options, dialogue assignment for untyped Auto-Match, enabled music ducking and clear behavior.
2. Failure: values/type/ducking state are missing from the document despite a success response, or gains differ from the authored -31/-15 LUFS examples targeting -23.
3. Oracle: raw persisted fields must match the explicit request/semantic state; no defaulting parser can fill in an omitted write for the assertion.
4. Seam: MCP actions followed by serializable document state; effect/gain assertions remain.
5. Refactor tolerance: storage field contracts survive moving command helpers or changing parsing internals; the test does not pin unused defaults.
6. Lowest owner: verifies MCP option forwarding and engine-analysis-to-edit orchestration; the model owns preset contents and read-time default compatibility.
Callers: `readEssentialSound` remains needed by `apps/mcp/src/tools/audio-fx.ts`, web audio controls and project essential handlers. Remove only its test import; do not privatize or alter it. Risk low; the removed preset choice was not independently asserted.

### REWRITE — `apps/mcp/test/polish.test.ts`: `lists a folder, filters by kind, limits and probes`

Delete the exact count of one `/api/browse/info` request. Keep returned video metadata/filter/limit assertions and the independent security check that `all=1` is never requested.

1. Contract: published browse tool returns folders plus matching media and optional metadata, limited as requested; engine-host file disclosure stays restricted.
2. Failure: wrong files/metadata escape or truncation disappears; these still fail response assertions.
3. Oracle: authored folder/video/audio/caption entries, requested limit and known width/fps.
4. Seam: MCP response and documented HTTP privacy option; no private request count.
5. Refactor tolerance: batching/caching/deduplicating probe work is permitted.
6. Lowest owner: MCP filtering/compact response remains covered; the engine owns physical ffprobe execution.
Callers: request log remains required for the privacy check; no production helper or hook is removed. Risk low; run polish in integration.

### Leads retained without changes

- `previewSegments` in preview setup supplies a cache key, not expected boundaries: expectations remain authored `[0, 10, 20, 30]`. Hash correctness belongs to the project owner.
- `mixFingerprint` and `ellipsePath` supply fake engine inputs. Assertions independently check word placement, mask modes and a 50-pixel translation; they do not compare those helpers' output against itself.
- Imported fixed flick units used to author media fixtures, protocol schemas used only to parse responses, package version metadata and documented 100 ms progress limits remain legitimate inputs/contracts.
- Motion-path expected Auto Bezier tangent follows independent S03:KF-021 and the documented outgoing-chord rule; it does not invoke the production evaluator.
- Network request counts preventing write replay, no engine effects on strict argument rejection, and read-only recovery HTTP verbs protect security/data-loss contracts. These differ from the deleted private probe/transaction-log assertions.

No production behavior/source changes are planned in this pass. Validation is static only as instructed: changed-file Biome and diff review; runtime/typecheck remain with the root integrated gate.

Final rescan completion: all five candidate cases were narrowed as recorded. Removed only test imports/logs and probes; production callers remain intact. Changed-file Biome and git diff --check passed, and the final diff was reviewed. No runtime tests or typecheck were started under the static-only instruction. Test source change in this follow-up: +10/-27 lines (net -17).

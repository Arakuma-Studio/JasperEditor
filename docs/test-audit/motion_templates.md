# Motion and template test cleanup

Scope: all 34 assigned test files, 290 named test declarations (parameterized declarations represent every row). The
per-test contract, source, failure, oracle, seam, refactor resistance, uniqueness and disposition are recorded in
[motion_templates.json](motion_templates.json): 241 KEEP, 29 DELETE, 11 REWRITE, 9 OPTIMIZE. Test code changes are
169 additions/1302 removals, net −1133 lines. No snapshot, dependency or configuration was removed; shared fixtures
remain consumed. Embedded manual-calibration matrices, their environment hooks and an unused generated avatar
fixture were removed. Actual parity, clamp and painted-bounds checks remain.

Removed production support: obsolete glyph aggregate/colour/gradient-scoping helpers and SVG scope prop/idScope
plumbing; an availability helper; unused builder re-exports; test-only visibility of X width helpers, zoom, easing,
value types and INK_RING. Public package exports and the explicitly specified ANIMEJS_VERSION contract remain.

## Validated behavior and failures

- `JASPER_BROWSER_EXECUTABLE=/usr/bin/chromium-browser JASPER_REQUIRE_ORACLES=1 pnpm exec vitest run
  packages/mg-templates packages/motion --maxWorkers=2`: 418 passed, 15 existing opt-in skips, 84.371s wall. The 15
  skips are native MG parity and the pre-existing Remotion opt-in suites; no required case moved to another gate.
- Both `pnpm --filter @jasper/motion typecheck` and `pnpm --filter @jasper/mg-templates typecheck`: passed. After
  the final cache-version/browser-discovery edits, 57 affected cases and both typechecks passed again.
- `env -u JASPER_BROWSER_EXECUTABLE pnpm exec vitest run packages/motion/test/social-x-fit.test.tsx
  --maxWorkers=2`: the real-browser case passed without an environment override.
- `REMOTION_E2E=1 pnpm exec vitest run packages/motion/test/determinism-render.e2e.test.ts --maxWorkers=2
  -t "the Player frame matches renderStill"`: 1 passed alone, 5 filtered cases; all 7 sampled frames pixel-identical.
  Lazy reference generation removes its former dependency on a preceding test. A fresh injected Player document
  also removes file:// access to host /tmp, which fails under Snap Chromium isolation.
- `REMOTION_E2E=1 pnpm exec vitest run packages/motion/test/social-comment-render.e2e.test.ts
  packages/motion/test/social-review-render.e2e.test.ts --maxWorkers=2
  -t "card fits every canvas|clamps a long review"`: 3 passed, 2 filtered parity cases. Full social paint-parity,
  encoded-media concurrency and native SVG parity were retained but were not rerun in this task scope.
- Mutation probes: zero replies violate count ratios; changing 5-star weight 56→156 passes the former
  production-derived oracle and fails the rewritten independently documented percentages; reducing the count gap
  to 0 fails actual Chrome layout. All changes were restored and the 4 affected files passed 43 cases.

Initial browser setup used the absent /usr/bin/chromium path; those runs are invalid performance evidence. Working
Chromium then exposed a real baseline regression: DejaVu Sans advances exceeded the private X estimate, leaving
5.346073px before the next icon for 999.9B replies. The actual required ≥6px gap (0.5px tolerance) remains enforced.
The owner now conservatively bounds the measured fallback glyph widths; the gap is 6.462882px, unclipped. A real
paused Player and Remotion export still at frame 100 were bit-identical before and after. The frames/action crops
were inspected visually; ignored artifacts are in `test-results/test-audit/x-count-gap/`.
`social-comment.renderVersion` 2 invalidates cached bakes; bundle source hashing also includes the changed sources.

The original root baseline skipped both Chrome X tests because its Chrome-only discovery found no usable path.
The surviving test now discovers installed Chromium too, without a new dependency. Old private checks also reject
valid 11.96px allocation or subpixel budget rounding; their unsupported internal expectations were deleted, while
real clipping, minimum 10px readability and measured inter-icon space remain asserted.

## Comparable performance observations

Machine: 8vCPU AMD EPYC-Genoa, Linux 6.8.0-138-generic, Node 20.19.0, pnpm 10.34.5, Vitest 4.1.11, two workers;
Chromium 156.0.8078.47 with DejaVu Sans fallback. This is a shared host with other validation lanes active. Per-run
load was not captured, so these are local paired observations, not an isolated benchmark or a measured CI claim.

For the same 4 meaningful contracts (count ratios, rating distribution, all 61 star-fill frames, 27 X layout rows),
old/new test bodies ran twice against the same corrected production layout owner. The old temporary test exports
were restored for baseline execution. The name filter was `likes distribution|J-shaped distribution|longest counts
in each column|the stars fill one by one`; every selected run passed 4 cases. All final tests remain in their gates.

| Measurement | Before | After |
|---|---:|---:|
| Whole 4-contract invocation wall samples |26.290s,25.460s|19.827s,20.890s|
| Mean wall |25.875s|20.3585s|
| Count-ratio case mean |1819.29ms|144.60ms|
| Rating case mean |215.85ms|29.94ms|
| Star-fill case mean |2155.08ms|589.33ms|
| X layout case mean |4419.66ms|429.82ms|

The measured invocation reduction is 5.5165s (21.32%). Statistical seed corpora and all frame/layout inputs are
unchanged. Savings come from batched assertions, mounted-card seeks and one clean browser document per layout
batch. There is no comparable clean full-scope baseline: the unmodified real X case fails; a preliminary comparison
of all old tests also hits obsolete private geometry assertions after the owner fix. No whole-repository speedup
is inferred from this subset. Browser motion-cue measurement and real rendering/preset determinism remain the
largest justified costs because cheaper model checks cannot observe their paint, seek or timing failures.

Full repository lint/typecheck/test/build and remote integration are the parent integration agent's gates.

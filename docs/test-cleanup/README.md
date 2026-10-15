# Test cleanup audit

This audit starts at `6c2baa39`. It covers the repository's unit, property, protocol,
rendering, browser, desktop, native and tooling tests. Individual dispositions were
recorded before edits. Regex searches identified candidates; decisions followed
inspection of the tests, their production owners, independent requirements and
remaining coverage.

Status: cleanup is implemented and integrated; repository validation is in progress.
This is not yet a completed-cleanup claim.

## Disposition records

Each record names the original tests, including deleted cases, and explains their
DELETE, REWRITE or KEEP disposition. Retained cases identify the independent
contract, observable failure, oracle, stable seam, refactor tolerance and unique
owner. Parameterized cases sharing one contract are recorded as a family.

| Area | Records |
| --- | --- |
| Project model, editing, effects and transitions | [1](project1.md), [2](project2.md), [3](project3.md), [4](project4.md) |
| Engine, media, persistence and export | [1](engine1.md), [2](engine2.md), [3](engine3.md), [follow-up](engine3-followup.md) |
| Web editor | [1](web1.md), [2](web2.md), [3](web3.md) |
| Shared rendering | [1](compositions1.md), [2](compositions2.md) |
| Browser workflows | [1](e2e1.md), [2](e2e2.md) |
| MCP and CLI | [MCP](mcp.md) |
| Audio, motion and motion-graphics templates | [Audio and motion](audio.md) |
| Interchange and expressions | [Formats](formats.md) |
| Session, API, client, configuration, UI and testkit | [Shared packages](shared.md) |
| Tooling, Electron, standalone checks and Rust | [Tooling](tooling.md) |

The review explicitly checks cross-area deletion dependencies: a model test does
not establish UI wiring, a valid rendered frame does not establish an export
refusal, and two areas cannot delete a contract while citing each other's removed
tests. Documented API/configuration values survive even when an inventory-like
assertion initially looks redundant. Visual regressions have an independent
repository requirement in [testing.md](../testing.md).

The independent [cross-review](cross-review.md) records the reconciled inventory
and 15 resolved findings, including retained regressions and false-positive tests.
The final [oracle review](oracle-review.md) records the follow-up source audit,
cross-owner transfers and resolved provenance/counting corrections.
The [GL integration review](gl-review.md) independently checks the later fingerprint
and named shader contracts, including preserved inputs, render order and tolerances.

The inventory covers 4,451 original named TypeScript/JavaScript declarations in
627 assigned paths, plus native/desktop families and 22 executable performance
budget rows. Parameterized families are not inflated into individual runtime cases.

## Removed support and product correction

The area ledgers record removed private exports, duplicate shader/CPU mirrors,
injected clocks and file-system wrappers, cache/invariant inspection hooks,
GL-poison instrumentation, scene-distinctness guards, unused canonicalizers,
local fixtures and gallery-only test entries. Browser helper branches and four
unused audio-fixture recipes were removed after an integrated caller census.
Published documentation pictures still have consumers and retain their provenance.

An additional integrated caller search found no remaining imports of
`scripts/docs/gallery-scenes.mjs`. Its executable recipe remains the reproducible
source of published pictures, but its `sceneA`/`sceneB` test-only exports and the
orphan `gallery-scenes.d.mts` declaration file were removed. The remaining caller
is the same-file CLI entry point; executable statements are unchanged. Validation:
repository lint/typecheck and `node --check scripts/docs/gallery-scenes.mjs`.

The strengthened public audio block contract exposed a real product bug: multiple
processors modified channels beyond their configured count. The original and
expanded mono/stereo cases failed before the owner fix; the expanded case then
passed. Processing loops and stereo branches now respect the configured count,
including the Studio Reverb delay network. The full evidence is in [audio.md](audio.md).

The unused MCP testkit dependency was removed. The lockfile and third-party notices
were regenerated with the owning tools. Lockfile generation also normalized
existing Remotion/webpack peer resolutions; it added no package version.

## Verification

Validation remains in progress. Confirmed results so far:

- `pnpm lint`: passed Biome, tokens, anime, layer/cycle and asset checks.
- Config/localization focused tests: 2 files, 9 tests passed.
- Public Remotion retry tests: 5 tests passed in the owning worktree.
- `cargo test --workspace --manifest-path native/mg/Cargo.toml --locked -j 1`:
  13 tests passed, no failures.
- `pnpm ffmpeg:check`: all inspected FFmpeg artifacts passed LGPL checks.
- `pnpm notices --check`: generated notices are current.
- `pnpm i18n:check`: Spanish covers all 8,615 generated strings.
- `pnpm build` and `pnpm --filter @jasper/engine build:remotion`: passed. The browser
  E2E preparation is rebuilding its required outputs after later source changes.
- Final sync/remix/registry recheck: 3 files and 149 tests passed with required
  oracles and two workers. Earlier aggregate audio watchdog failures are not passes;
  this result verifies the final per-contract cases.
- `pnpm perf --sections micro --label test-cleanup-integration`: passed all six
  scripts, including the scale benchmark. AMD Ryzen 7 7700, 16 logical CPUs,
  Node 20.20.2; starting load averages 154.9/147.2/145.5. Reports are in
  `test-results/performance/`; no comparable before/after speedup is claimed.

The existing [baseline CI run](https://github.com/JasperRaccoon/JasperEditor/actions/runs/38635051386)
never started a step: its annotation says an Actions budget prevents further use.
Local verification remains necessary; this infrastructure refusal is not a test pass.

Full validation results and integrated change measurements will be recorded here
after the remaining gates. Per-area formatting checks and interrupted baseline
attempts are distinguished from runtime passes in the records above.

# Browser and tooling audit

The [per-test ledger](browser_scripts.json) covers 198 original declarations in 74 files: 129 browser declarations and 69 script declarations. The accessibility declaration expands into twelve workspace/theme cases. Counts describe declarations, rather than assertions or generated runtime cases.

| Disposition | Original declarations |
|---|---:|
| DELETE | 1 |
| REWRITE | 1 |
| OPTIMIZE | 8 |
| CONSOLIDATE | 4 |
| KEEP | 184 |

The result has 195 declarations and 65 fewer test lines. No production behavior, dependency, fixture, snapshot, shared helper, runner or required gate changed.

- `sound-describe`: removed the no-model browser tour, which checked licence/author copy and a keyword mode flag without verifying actual search results. The web component owner retains keyword fallback and licence consent; the engine owner retains actual keyword result IDs and typed unavailable-model errors. Both owners confirmed retention. The real-model scenario retains its existing opt-in condition and every inference/placement assertion, creates its own project, and uses Playwright's isolated page fixture. Shared page/project state and serial lifecycle hooks are gone.
- `subtitles`: combined fixture import, cut-aligned subtitle creation and decoded export checks into one workflow. The previous stages depended on earlier tests, so filtering to creation/export could fail before exercising their contracts. All meaningful assertions and artifacts remain; a literal History label became an actual before-plus-one entry assertion.
- `smoke`: the Type Tool still creates a real title through a Program click, now checks its rendered text block, and attaches a screenshot. Removed a second full 1080p forced-Remotion encode whose assertions only checked stream metadata and frame count. The required Sound Library browser scenario explicitly forces Remotion and verifies source-to-export audio correlation; automation scenarios verify rendered Remotion kit pixels. The first smoke retains native codec/duration checks.
- Removed ten fixed waits immediately before diagnostic screenshots in seven other specs. Existing document/visibility assertions establish completion. Audio recordings, required geometry synchronization and all behavioral assertions remain.
- Removed the Sound Mix Room Glue open/read-copy/Cancel tour. Its lower UI owner applies settings and removes the actual sends; the retained browser scenario verifies the Auto Pass bus/sends and exported mix.

The expensive sound-design walkthrough remains because spec 12 P6-R6 independently requires the combined partial-review, undo, Sound Check and measured export workflow. It checks final decoded AAC loudness/peak and source correlation after music/beds/mix interactions. Focused scenarios protect different gestures, waveform defects or storage boundaries. Existing real-time audio sampling remains where elapsed playback is part of the contract.

No new speedup measurement is claimed here. The coordinator owns comparable baseline/final profiling and execution of the ten affected browser specs through `pnpm e2e`. The prior audit reports were used as contract evidence, not as current timing measurements.

Local validation: Node 20.19.0 and pinned pnpm; `pnpm install --frozen-lockfile --offline --ignore-scripts`; `pnpm e2e:typecheck` passed. An initial scoped Biome run found an empty fixture destructure in the new smoke callback; it was corrected to use `test.info()`. Final scoped checks and browser execution are recorded by the integrated coordinator. No execution of the optional real CLAP model is claimed without its local catalogue.

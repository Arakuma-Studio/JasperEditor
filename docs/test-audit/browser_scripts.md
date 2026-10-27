# Browser and tooling audit

The [per-test ledger](browser_scripts.json) covers 198 original declarations in 74 files: 129 browser declarations and 69 script declarations. The accessibility declaration expands into twelve workspace/theme cases. Counts describe declarations, rather than assertions or generated runtime cases.

| Disposition | Original declarations |
|---|---:|
| DELETE | 1 |
| REWRITE | 1 |
| OPTIMIZE | 11 |
| CONSOLIDATE | 4 |
| KEEP | 181 |

The result has 195 declarations and 63 fewer test lines. No production behavior, dependency, generated media fixture, snapshot, shared helper, runner or required gate changed.

- `sound-describe`: removed the no-model browser tour, which checked licence/author copy and a keyword mode flag without verifying actual search results. The web component owner retains keyword fallback and licence consent; the engine owner retains actual keyword result IDs and typed unavailable-model errors. Both owners confirmed retention. The real-model scenario retains its existing opt-in condition and every inference/placement assertion, creates its own project, and uses Playwright's isolated page fixture. Shared page/project state and serial lifecycle hooks are gone.
- `subtitles`: combined fixture import, cut-aligned subtitle creation and decoded export checks into one workflow. The previous stages depended on earlier tests, so filtering to creation/export could fail before exercising their contracts. All meaningful assertions and artifacts remain; a literal History label became an actual before-plus-one entry assertion.
- `smoke`: the Type Tool still creates a real title through a Program click, now checks its rendered text block, and attaches a screenshot. Removed a second full 1080p forced-Remotion encode whose assertions only checked stream metadata and frame count. The required Sound Library browser scenario explicitly forces Remotion and verifies source-to-export audio correlation; automation scenarios verify rendered Remotion kit pixels. The first smoke retains native codec/duration checks.
- Removed ten fixed waits immediately before diagnostic screenshots in seven other specs. Existing document/visibility assertions establish completion. Audio recordings, required geometry synchronization and all behavioral assertions remain.
- Removed the Sound Mix Room Glue open/read-copy/Cancel tour. Its lower UI owner applies settings and removes the actual sends; the retained browser scenario verifies the Auto Pass bus/sends and exported mix.

The expensive sound-design walkthrough remains because spec 12 P6-R6 independently requires the combined partial-review, undo, Sound Check and measured export workflow. It checks final decoded AAC loudness/peak and source correlation after music/beds/mix interactions. Focused scenarios protect different gestures, waveform defects or storage boundaries. Existing real-time audio sampling remains where elapsed playback is part of the contract.

The coordinator owns full-suite baseline/final profiling and execution of the affected browser specs through `pnpm e2e`. The isolated three-workflow measurements below cover the additional raster optimization; they are not an extrapolated CI or full-suite speedup.

Local validation: Node 20.19.0 and pinned pnpm; `pnpm install --frozen-lockfile --offline --ignore-scripts`; `pnpm e2e:typecheck` passed. An initial scoped Biome run found an empty fixture destructure in the new smoke callback; it was corrected to use `test.info()`. Final scoped checks and browser execution are recorded by the integrated coordinator. No execution of the optional real CLAP model is claimed without its local catalogue.

## Validated automation raster optimization

The three automation workflows retain their complete input media, frame rate and exported duration, transcript/audio, proposal/review/timing assertions, original sample frame numbers and pixel thresholds, and screenshot/movie/frame artifacts. Only sequence raster changes from 1920×1080 to 640×360. No independent EA-012/023/050 contract requires 1080p here; the native smoke format contract remains 1920×1080.

- Apply Style uses the existing 640×360 cleanup test pattern at its natural 100% scale, replacing unnecessary 300% enlargement. Its top-half comparison remains 32×9 RGB samples away from the subtitles.
- Decorate Cuts preserves the square's normalized position, changing [700,400] to [700/3,400/3], with its 20% scale unchanged. The comparison remains 32×18 RGB.
- Reactions keeps the existing 1920×1080 still. The planner's 45%-of-frame height cap produces exactly 45% Motion scale at 1080p and 15% at 360p, so normalized size, slot geometry, flip rule and wobble parameters remain the same. Each fresh marker identity seeds a potentially different allowed slot; identical random placement across projects is not a contract. The comparison remains 32×18 RGB.

Independent sources: spec 15 EA-012, EA-020/023 and EA-050; the editing-automation work note's kit scaling contract; spec 13's proportional subtitle templates. Production owners inspected: `automation/common.ts` / `decorate-cuts.ts` (pixel parameters scale with short side), `reactions.ts` / `overlay-items.ts` (asset cap and normalized slots), subtitle `templates.ts` (font/stroke/shadow scaling), and export `settings.ts` (uses sequence dimensions). Existing kit export fidelity tests also use 640×360.

The [measurement record](performance/browser-automation.json) contains all four alternating normal runs. They used copied current c62e2bb5 production outputs, Node 20.19.0/pnpm 10.34.5, Chrome for Testing 153 with SwiftShader, pinned vendor FFmpeg, one worker, distinct ports/fresh appdirs, and no competing agent test/build/browser work on the 8-vCPU AMD EPYC-Genoa KVM host. Existing builds were reused identically in both legs; every assertion, timeout and retry setting remained unchanged.

| Warm measurement | Original 1920×1080 | Candidate 640×360 |
|---|---:|---:|
| Complete three-spec `pnpm e2e` command | 336.288 s | 101.671 s |
| Apply Style test | 222.691 s | 43.178 s |
| Decorate Cuts test | 68.964 s | 18.736 s |
| Reactions test | 33.563 s | 28.721 s |

The warm whole-command saving is 234.617 seconds (69.77%). The first pair was 385.215/103.976 seconds; its baseline regenerated unrelated copied fixture stamps, so it does not support the whole-command headline. Individual original test repeats were 221.378/222.691, 70.651/68.964 and 34.793/33.563 seconds, versus candidate 43.158/43.178, 19.438/18.736 and 30.054/28.721 seconds. Both candidate repetitions passed; Reactions retains more hybrid setup cost. These results do not measure CI or the whole repository suite. Recorded launcher-child CPU is incomplete for detached browser/server descendants; no total CPU or peak-memory reduction is claimed.

Vendor `ffprobe -count_frames` verified all 24 preserved movies. Both Apply Style outputs remain 229 frames/7.641 seconds; Decorate Cuts 180 frames/6.006 seconds; Reactions 240 frames/8.008 seconds, all at 30000/1001 fps with matching stream kinds across all four legs. Raster alone changed. Original and candidate extracted kit/reaction frames were inspected visually.

For regression proof, temporary public `track.update` transactions disabled actual FX/Reactions output after review and timing assertions. Kit fault exports explicitly used real Remotion to preserve their route prerequisite. All three tests reached and failed their original pixel assertion: Apply Style >4 received 0.84375; Decorate >6 received 0.027199; Reactions >8 received 0. Candidate source hashes match the saved pre-probe versions after restoration. The 4 normal runs passed 12 workflow executions; the 3 intentional fault failures are evidence, not unresolved suite failures. Logs, Playwright JSON, movies, frames, screenshots and fault traces remain under `/tmp/jasper-test-audit/browser-automation/`. `pnpm e2e:typecheck`, scoped Biome and `git diff --check` passed. No production code or shared harness/configuration changed.

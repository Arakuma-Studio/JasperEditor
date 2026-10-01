# Script, desktop, and native test cleanup (2026-10-01)

## Scope and pre-edit record

The host `AGENTS.md` note supplied in the task is the only applicable agent note; no repository `AGENTS.md` exists. The commands are `pnpm test` (Vitest), `pnpm lint` (Biome plus the token and anime guards), `pnpm typecheck`, and `cargo test --workspace` in `native/mg`. The scoped fast check is `pnpm exec vitest run scripts/check-tokens.test.mjs scripts/check-anime.test.mjs scripts/third-party-notices.test.mjs scripts/ffmpeg/lib.test.mjs apps/desktop/test/security.test.ts`.

Before editing I read the tests, their owners (`scripts/check-{tokens,anime}.mjs`, `scripts/third-party-notices.mjs`, `scripts/ffmpeg/{lib,check-lgpl}.mjs`, `apps/desktop/src/{security,main,preload.cts}`, and the native renderer), and the independent rules in `docs/specs/01-project-model-and-state.md` (CLB), `04-media-render-and-backend.md` (MG), `07-clip-processing.md` (PST), `11-animation.md` (ANM/FIX), and `docs/ARCHITECTURE.md` (D-13). The change risk is accidental loss of a lint, licensing, IPC, or renderer protocol guard. The stronger owners below are retained tests or the actual `pnpm lint`, `pnpm notices --check`, packaged LGPL check, and native CLI paths. Removed exports had no non-test import; `rg` checked callers before changing them.

## Retention bar for the rows below

Each retained or rewritten row names one of these proof sets. The numbered clauses explicitly correspond to the six conditions in the request.

| Set | 1. Independent rule | 2. Observable failure | 3. Independent oracle | 4. Stable seam | 5. Refactor tolerance | 6. Lowest owner |
|---|---|---|---|---|---|---|
| L | DT-002 or ANM-001/006/007/012/022/023 in the specs | Forbidden source passes lint or permitted source fails | Planted examples from the policy, not the scanner's pattern tables | `checkRepo` or `findViolations` result used by the lint command | Parser or regex internals can change while diagnostics remain | Lint scanner; no end-user rendering test can validate forbidden source detection |
| N | FIX-010 and LC-005 third-party notice requirements | Stale, omitted, or unlicensed shipped package | Miniature package graph or the checked-in notice file; package names and paths originate in input fixtures | Notice CLI or its data collection/audit entry points | Dependency-walk and rendering implementation can change | Notice generator and audit, rather than app UI displaying the generated file |
| F | D-13 LGPL distribution and PST-003 vid.stab pin | GPL/nonfree binary ships, required notice absent, wrong vid.stab accepted, or executable cannot load | Planted binary strings, fixed legal pin/provenance, required package paths | Tree/package guard, manifest, or vendored ELF artifact | Scanner and packaging internals can change while results remain | Guard over the actual distribution layout; focused manifest/ELF checks have no equivalent artifact fixture |
| D | CLB-002/009/010, desktop origin/IPC security, and packaged MCP/FFmpeg rules | Host opens unsafe URL, untrusted IPC is accepted, paste loses local paths, or packaged app launches wrong program/ships disallowed codecs | Literal protocol, path, size, URI, and package requirements from specs | Security helpers called by Electron main or package config consumed by electron-builder | Electron handler organization may change without changing helper outcomes/config keys | Desktop boundary; web payload tests cannot verify native formats or paths |
| M | MG-001/012, renderer JSON/NDJSON/PNG/RGBA protocol, source-in rational timing, and XML serialization | Wrong frame count, alpha, error exit, timestamp, catalog, or malformed XML/color in exported graphics | Literal protocol fields, fixture JSON, rational rate, PNG signature, and XML escape rules | `jasper-mg` CLI or public core parsing/time/XML helper | Rendering internals may change while those bytes/values remain | Native binary boundary; core parser/time/XML helpers cover input and escaping not exercised by retained CLI frames |

## Completed dispositions

### Design token lint

| Path/test before edit | Disposition | Failure detected or reason; stronger owner |
|---|---|---|
| `scripts/check-tokens.test.mjs` accepts token-only code | DELETE | Matcher-only positive cases; rewritten repository scan covers false positives for theme and exception lines. |
| same: catches hex literals | DELETE | Exact match/line detail duplicated by rewritten repository scan. |
| same: catches rgb/hsl functions | DELETE | One regex branch implementation probe; `pnpm lint` scans real UI and the rewritten scan proves the policy boundary. |
| same: catches raw Tailwind palette classes | DELETE | Rewritten scan contains a forbidden palette class at the repository seam. |
| same: honours the per-line opt-out marker | DELETE | Rewritten scan includes a documented exception. |
| same: exempts theme dirs and `*.tokens.ts` | DELETE | Rewritten scan includes both exempt inputs. |
| same: scans a planted literal in a fake repo → reports raw UI colors while allowing theme tokens and documented exceptions | REWRITE (L) | A UI raw color or class passing lint, or an exempt token source being rejected, fails. Two violations, one theme file, one token file, and one documented exception use a single repository scan. Risk: token policy coverage depends on the scanner result; validate with scoped Vitest and `pnpm lint`. |

### Animation lint

All rows in this table are in `scripts/check-anime.test.mjs`. They use proof set **L**. There is no stronger owner for the distinct ANM rule in a retained row; the repository lint run is stronger only for the current source tree and cannot prove a planted forbidden input would be caught.

| Test before edit | Disposition | Specific failure or reason |
|---|---|---|
| only motion imports animejs; only compositions imports `@jasper/motion` | KEEP | Dependency escape or false positive under ANM-001/022. |
| motion uses anime.js subpaths; root value imports only in the runtime index | KEEP | Web bundle root import under ANM-023. |
| bans wall-clock / DOM-rewriting modules everywhere, scope and engine outside runtime | KEEP | Autoplay/DOM rewriting import becomes allowed. |
| bans names whatever alias or module; runtime-only names outside runtime | REWRITE | Retains forbidden alias, runtime-only, and namespace behavior; deletes the copied `BANNED_NAMES`/`RUNTIME_ONLY_NAMES` declaration inventories. |
| bans Timeline class and autoplaying utils | KEEP | A direct wall-clock constructor or unsafe util is accepted. |
| bans wall-clock time and Math.random in motion/compositions | KEEP | Nondeterministic time/randomness leaks into rendering. |
| bans playback, unseeded randomness and risky timeline APIs | KEEP | Non-seek playback or loop/blend/set/call passes guard. |
| tells timelines from Maps, arrays and functions | KEEP | Either a forbidden timeline call passes or ordinary collection/function code is falsely rejected. |
| treats values from factories, annotated and renamed timelines as timelines | REWRITE | Keeps caller-visible lint examples; deletes `timelineIdentifiers` private set assertion. |
| wall clock through optional chaining/computed access; shorthand loop/autoplay | KEEP | Syntax variation bypasses the determinism guard. |
| stagger seed must be an expression | REWRITE | Keeps rejected constant seeds and accepted expression seeds; deletes direct `hasSeed` helper assertions. |
| bans animate(), engine.update, timers, plain seeks outside runtime | KEEP | Runtime can become history-dependent or wall-clock-driven. |
| bans unseeded random staggers and jitter | KEEP | Unseeded stagger passes the ANM-007 guard. |
| ignores comments and honours anime-allow with a reason | KEEP | A comment trips lint or a reasonless exemption bypasses it. |
| helpers: imports, template blanking, chains and comment stripping keep line numbers | DELETE | Private parser representation; dependency and timeline examples above own the behavior. |
| Biome noRestrictedImports mirrors import bans: motion outside runtime | DELETE | Reads config implementation tables and copies linter declarations; `pnpm lint` and ANM scanner examples own the policy. |
| Biome mirror: runtime may use scope/timelines/seeded generator | DELETE | Config source inventory; runtime import behavior is exercised above. |
| Biome mirror: other sources never import anime.js | DELETE | Config source inventory; dependency rule example above owns it. |
| over a tree: finds problems with file and line | KEEP | Real scan misses files or reports unusable source locations. |
| over a tree: repository is clean | DELETE | Duplicate of `pnpm lint`, no planted failure. |

### Third-party notices

All rows are in `scripts/third-party-notices.test.mjs`; retained/reworked rows use proof set **N**.

| Test before edit | Disposition | Specific failure or reason; stronger owner |
|---|---|---|
| `THIRD_PARTY_NOTICES.md` is current (`pnpm notices --check`) | REWRITE | Stale committed legal notice fails the actual CLI check. Removed a duplicate direct equality against the generator and incidental stdout count. |
| lists shipped closure of web app and Remotion bundle with licence texts → identifies licence of every shipped JavaScript package | REWRITE | Any current shipped package without a licence identifier or text fails; removed hard-coded dependency/version inventory. |
| excludes workspace packages, dev-only tools and platform binaries | DELETE | Hard-coded package blacklist; miniature closure test checks dependency selection, and `--audit`/package check own the built output. |
| lists build-time packages whose output ships | DELETE | Expected names copied from `SHIPPED_BUILD_OUTPUT`; notice `--check` and sourcemap audit own omissions. |
| `packagesInSourcemaps`: reads name@version from Vite/webpack maps | KEEP | Built bundle package can be omitted from the legal audit. |
| miniature workspace: follows dependencies and required peers; renders deterministically → follows dependencies and required peers | REWRITE | Missing transitive/required peer, accidentally shipped optional/dev dependency, wrong license files/texts. Removed self-comparison and exact Markdown fragments. |
| miniature workspace: adds shipped build output without dependencies | KEEP | Bundler runtime absent, or unrelated dependencies unnecessarily listed. |
| `licenseOf` reads license/legacy fields | DELETE | Private helper shape; the miniature graph contains string, object, and legacy license fields and checks collected notice data. |

### LGPL FFmpeg guard

All rows are in `scripts/ffmpeg/lib.test.mjs`; retained/reworked rows use proof set **F**.

| Test before edit | Disposition | Specific failure or reason; stronger owner |
|---|---|---|
| evaluateBuild: accepts LGPL build despite disabled libx264 | DELETE | Direct flag parser test; positive tree/package guard owns false rejection. |
| evaluateBuild: rejects Remotion bundled build | DELETE | Direct evaluator test; tree and packaged app rejection own GPL detection. |
| evaluateBuild: rejects nonfree builds/GPL strings | DELETE | Reworked tree test plants a nonfree binary; packaged test plants GPL license. |
| scanBinaryStrings: finds embedded configuration/license | DELETE | Private scanner test; the reworked tree test reads planted binary files. |
| isFfmpegArtifact filename matrix | DELETE | Classifier shape; reworked tree test checks Linux, macOS, and Windows library names through the guard. |
| checkTree: fails on GPL libraries/Remotion, passes LGPL ones | REWRITE | Guards three platform library names and an embedded nonfree build in addition to LGPL/GPL and Remotion package detection. |
| vid.stab: pins post-relicense commit/provenance | KEEP | Wrong source/relicense metadata would authorize GPL vid.stab. |
| vid.stab: accepts `--enable-libvidstab` only with pinned commit recorded | DELETE | Direct evaluator repetition; BUILDINFO tree test owns acceptance/rejection. |
| vid.stab: `ffmpeg:check` reads BUILDINFO next to binaries | KEEP | Wrong/missing BUILDINFO record allows GPL vid.stab or blocks licensed build. |
| checkPackagedApp: passes complete LGPL directory | KEEP | Valid distribution falsely blocked. |
| checkPackagedApp: fails absent directory/notice | KEEP | Application ships without codec or legal notice. |
| checkPackagedApp: rejects compositor/x264/GPL asar | KEEP | GPL codec can ship via dependency, side library, or archive. |
| checkPackagedApp: checks Electron FFmpeg anywhere | KEEP | Electron's own codec is silently excluded from licence validation. |
| checkPackagedApp: disallows stray LGPL FFmpeg | KEEP | A second ungoverned binary ships outside the required directory. |
| isForbiddenLibrary filename matrix | DELETE | Helper inventory; packaged x264 case owns the dangerous distribution path. |
| manifest: every prebuilt/source tarball has SHA-256 | KEEP | Download pin loses an integrity digest. |
| rewriteElfRpath: updates vendored ELF in place | KEEP | Packaged Linux codec fails to load or ELF is corrupted. Runs when the vendored binary exists. |

### Desktop

All rows are in `apps/desktop/test/security.test.ts`; retained/reworked rows use proof set **D**.

| Test before edit | Disposition | Specific failure or reason; stronger owner |
|---|---|---|
| writes only sane JasperEditor payloads under custom format | REWRITE | Custom OS type or untrusted/oversize write accepted. Uses the spec's 20 MiB literal instead of a production cap constant. |
| reads back only format JSON within cap | REWRITE | Foreign or oversize clipboard data passes. Adds an independently specified 20 MiB boundary. |
| preload exposes clipboard read/write over invoke only | DELETE | Source-grep of handler call shape; write/read validation tests and desktop clipboard E2E own behavior. |
| parses URI lists/GNOME copies into local absolute paths only | REWRITE | Remote/malformed URI leaks, path lost, duplicates or >500 paths accepted. Uses 500 from CLB-010 rather than product constant. |
| preload exposes file paths/list read; main answers only app origin | DELETE | Source-grep of IPC implementation shape; file-list validation and desktop clipboard E2E are stronger. |
| only hands http(s)/mailto links to OS | KEEP | Dangerous external protocol is opened. |
| keeps navigation on app origin | KEEP | Window escapes to another origin. |
| validates IPC arguments | KEEP | Relative/NUL reveal path or arbitrary window action reaches Electron. |
| packaged apps run MCP with own binary as Node; checkouts use node | KEEP | Packaged Help connection command fails or launches wrong executable. |
| builds ESM main/CJS preload/electron-builder config | DELETE | Export/config inventory and file-path snapshot; build/typecheck/package smoke owns executable shape. |
| packages LGPL directory, excludes compositor, guards after packing | REWRITE | Required resource path, exclusion, or afterPack guard missing; deleted incidental scripts/package substring assertions. The exact resource path and exclusion patterns are packaging/legal keys. |

### Native motion-graphics renderer

Retained/reworked rows use proof set **M**. For isolated core tests, concrete failures are: invalid JSON acceptance and bad bounds (`spec`), rational time truncation (`frame_time`), invalid XML escaping or color channel conversion (`svg`). Each has a caller-visible effect in JSON acceptance, render timing, or SVG output, without a stronger retained core test for that input.

| Path/test before edit | Disposition | Specific failure or reason; stronger owner |
|---|---|---|
| `native/mg/crates/jasper-mg-cli/tests/cli.rs`: version_and_schema_are_json | KEEP | Binary startup/catalog JSON protocol wrong; engine consumes it. |
| same: lower_third_fixture_renders_every_frame_in_order | KEEP | CLI writes wrong frame bytes/count/progress, or graphic stays blank; output bytes and NDJSON are checked. |
| same: straight_alpha_probe_pixel_stays_white | KEEP | Premultiplied RGBA corrupts export compositing; fixed 50% white pixel is an independent oracle. |
| same: invalid_specs_exit_with_code_2 | KEEP | CLI accepts unsupported template/params/frame/mode or reports wrong exit/error protocol. |
| same: frame_writes_a_png | KEEP | `frame` command fails to produce a PNG artifact. |
| `native/mg/crates/jasper-mg-core/src/spec.rs`: parses_a_spec_with_defaults | DELETE | Serde field echo and default snapshot; CLI JSON protocol and retained parser rejections are stronger. |
| same: rejects_unknown_fields_and_bad_values | KEEP | Strict input bounds/top-level field validation breaks; CLI negative cases do not cover zero dimensions/denominator. |
| same: frame_time_uses_the_rational_rate | KEEP | 30000/1001 fps or source-in offsets render at wrong time; rational arithmetic expected from spec. |
| `native/mg/crates/jasper-mg-core/src/canvas.rs`: exact_canvases_are_identity | DELETE | Geometry assertion against selected canvas table; CLI render artifact owns output shape. |
| same: other_sizes_scale_and_center | DELETE | Coordinate/appearance snapshots; no visual regression contract at this level. |
| `native/mg/crates/jasper-mg-core/src/anim.rs`: easings_hit_their_endpoints | DELETE | Restates implementation math without an independently fixed curve; native render artifact is stronger. |
| same: springs_start_at_zero_and_settle_at_one | DELETE | Shape/appearance approximation of private spring parameters; no independent pixel/timing oracle. |
| `native/mg/crates/jasper-mg-core/src/svg.rs`: formats_numbers_like_the_ts_twin | DELETE | Three-decimal/private number-format snapshot; valid SVG output can be formatted differently. |
| same: colors_and_escaping → color_conversion_and_xml_escaping | REWRITE | Unsafe XML text or wrong color bytes. Removed incidental `fill` attribute ordering and alpha spelling. |
| `native/mg/crates/jasper-mg-core/src/text.rs`: estimates_are_additive_and_weight_aware | DELETE | Text-width implementation/geometry restatement; renderer artifact is stronger. |
| `native/mg/crates/jasper-mg-templates/src/lib.rs`: params_default_and_reject_unknown_fields | DELETE | Duplicates CLI rejection and compares default to itself. |
| same: schema_lists_both_templates_with_matching_defaults | DELETE | Schema/default self-consistency derived from the same implementation; CLI catalog is stronger. |
| same: svg_is_deterministic_and_well_formed | DELETE | Self-comparison, markup prefix/suffix, and canvas geometry; CLI output is stronger. |

## Removed support and validation

Removed `isExempt`/`findViolations` exports from the token linter; animation-linter declaration/parser/helper exports, its unused `importsOf` and `SCAN_ROOTS`; notice-generator exports used only by deleted direct helper/config tests; the FFmpeg `configureFlags` export; desktop exports of `CLIPBOARD_MAX_BYTES`, `CLIPBOARD_MAX_FILES`, and `isJasperClipboardJson`; and the native test-only template fixture helper/modules. After the E2E desktop smoke harness moved to CDP capture, removed the production-only `JASPER_DESKTOP_SCREENSHOT`, delay, and `JASPER_DESKTOP_EXIT` hook (`maybeScreenshot`) and its file-write import from `apps/desktop/src/main.ts`. Production callers of surviving functions remain. Normal desktop runtime behavior is unchanged.

The desktop CDP smoke now visits an untrusted `data:` page with the actual preload bridge and verifies the `jasper:mcp-info` handler denies that origin. This exercises the common `fromApp` guard. The deleted clipboard handler source-regex tests have no handler-specific hostile-frame equivalent; the normal desktop clipboard workflow remains covered by its E2E test. A direct hostile clipboard IPC assertion in the smoke harness would close that residual gap.

Validation: scoped Vitest passed **39 tests in five files** after cleanup; `cargo test --workspace` in `native/mg` passed **5 CLI + 3 core tests**; `cargo fmt --all -- --check` passed; Biome on the 11 touched JS/TS files passed; `pnpm --filter @jasper/desktop typecheck` passed; and `git diff --check` passed for this scope. The hook-free CDP smoke rebuilt Electron main and passed in both `dev` and `packaged-like` modes, leaving PNG and IPC JSON artifacts. Parent owns repository-wide lint, typecheck, test, build, merge, and push gates.

## Exact-title reconciliation

The repository-wide title scanner compared literal strings; the table below supplies exact original path/title pairs for this scope. Retention classes L/N/F/D refer to the six-bar proof sets above. The TSV entry `apps/desktop/test/security.test.ts` / `text/plain` is a regex false positive from `CLIPBOARD_FILE_LIST_TYPE.test('text/plain')`, not a test declaration.

| Original path | Original test title | Disposition / class | Reason |
|---|---|---|---|
| `apps/desktop/test/security.test.ts` | writes only sane JasperEditor payloads under the custom format | REWRITE · D | 20 MiB and JasperEditor-format validation now use the specified cap, not the owner constant. |
| `apps/desktop/test/security.test.ts` | reads back only the format JSON within the cap | REWRITE · D | Adds the specified size boundary; foreign or oversized JSON is refused. |
| `apps/desktop/test/security.test.ts` | the preload exposes clipboard read/write over invoke only | DELETE | Preload/main source shape; desktop clipboard workflow and hostile-origin IPC E2E own behavior. |
| `apps/desktop/test/security.test.ts` | parses uri-lists and GNOME copies into local absolute paths only | REWRITE · D | Specified 500-file cap replaces an expected value copied from production. |
| `apps/desktop/test/security.test.ts` | the preload exposes file paths and the file list read; main answers only the app origin | DELETE | Handler source regex; desktop clipboard and hostile-origin IPC E2E own behavior. |
| `apps/desktop/test/security.test.ts` | only hands http(s)/mailto links to the OS | KEEP · D | Unsafe URL scheme must never reach the OS. |
| `apps/desktop/test/security.test.ts` | keeps navigation on the app origin | KEEP · D | Cross-origin navigation must be denied. |
| `apps/desktop/test/security.test.ts` | packaged apps run the bundle with their own binary as Node; checkouts use node | KEEP · D | Packaged MCP launch command differs from checkout launch. |
| `apps/desktop/test/security.test.ts` | builds an ESM main and a CJS preload and ships an electron-builder config | DELETE | Build/config inventory; actual build, typecheck and desktop smoke are stronger. |
| `apps/desktop/test/security.test.ts` | packages the LGPL FFmpeg directory, excludes the Remotion compositor packages, guards after packing | REWRITE · D | Preserves exact legal distribution paths and guard; drops incidental script text. |
| `scripts/check-anime.test.mjs` | only motion imports animejs; only compositions imports @jasper/motion | KEEP · L | Forbidden cross-package imports must fail lint. |
| `scripts/check-anime.test.mjs` | motion uses anime.js subpaths; root value imports only in the runtime index (ANM-023) | KEEP · L | Root value import would break the specified bundle boundary. |
| `scripts/check-anime.test.mjs` | bans the wall-clock / DOM-rewriting modules everywhere, scope and engine outside the runtime | KEEP · L | Nondeterministic or DOM-rewriting imports must fail lint. |
| `scripts/check-anime.test.mjs` | bans names whatever their alias or module; runtime-only names outside the runtime | REWRITE · L | Keeps banned alias/namespace examples; removes constant inventory assertions. |
| `scripts/check-anime.test.mjs` | bans the Timeline class and the autoplaying utils (review fixes) | KEEP · L | Autoplaying constructor and utility calls must fail lint. |
| `scripts/check-anime.test.mjs` | bans wall-clock time and Math.random in motion and compositions sources | KEEP · L | Wall-clock and unseeded randomness must fail lint. |
| `scripts/check-anime.test.mjs` | bans playback, unseeded randomness and the risky timeline APIs where anime.js is used | KEEP · L | Playback and unsafe timeline mutations must fail lint. |
| `scripts/check-anime.test.mjs` | tells timelines from Maps, arrays and functions (.set / .call / .reverse) | KEEP · L | Forbidden timeline calls must fail without rejecting ordinary collections. |
| `scripts/check-anime.test.mjs` | treats values from timeline factories, annotated and renamed timelines as timelines (review fixes) | REWRITE · L | Keeps renamed-timeline violations; removes private identifier-set assertion. |
| `scripts/check-anime.test.mjs` | wall clock through optional chaining and computed access; shorthand loop / autoplay (review fixes) | KEEP · L | Alternate syntax must not bypass the determinism guard. |
| `scripts/check-anime.test.mjs` | a stagger seed must be an expression, not a literal false / 0 / undefined (review fixes) | REWRITE · L | Keeps invalid/valid seed examples; removes direct hasSeed helper checks. |
| `scripts/check-anime.test.mjs` | bans animate() (also WAAPI el.animate), engine.update, timers, plain seeks outside the runtime | KEEP · L | Wall-clock driving and noncanonical seeks must fail lint. |
| `scripts/check-anime.test.mjs` | bans unseeded random staggers and jitter (ANM-007) | KEEP · L | Random stagger without a usable seed must fail lint. |
| `scripts/check-anime.test.mjs` | motion outside the runtime: every banned module, banned and runtime-only names | DELETE | Biome config inventory mirrors scanner declarations; behavior examples and lint own it. |
| `scripts/check-anime.test.mjs` | the runtime may use scope, engine-free timelines and the seeded generator | DELETE | Biome override shape; runtime import examples and lint own it. |
| `scripts/check-anime.test.mjs` | the repository is clean | DELETE | Duplicates pnpm lint over current sources; no planted failure. |
| `scripts/check-tokens.test.mjs` | exempts theme dirs and *.tokens.ts | DELETE | Rewritten planted repository test includes both exemptions. |
| `scripts/ffmpeg/lib.test.mjs` | accepts an LGPL build even though it lists --disable-libx264 | DELETE | Direct flag-parser check; positive tree/package guard owns acceptance. |
| `scripts/ffmpeg/lib.test.mjs` | rejects nonfree builds and GPL license strings | DELETE | Direct evaluator check; rewritten tree test plants nonfree binary. |
| `scripts/ffmpeg/lib.test.mjs` | finds the embedded configuration and license string | DELETE | Private scanner check; tree/package guard reads planted binary strings. |
| `scripts/ffmpeg/lib.test.mjs` | fails on GPL libraries and Remotion compositor packages, passes LGPL ones | REWRITE · F | Tree now checks LGPL/GPL/nonfree and Linux/macOS/Windows artifact names. |
| `scripts/ffmpeg/lib.test.mjs` | pins a post-relicense vid.stab commit with its provenance | KEEP · F | Pin metadata is the legal basis for enabling vid.stab. |
| `scripts/ffmpeg/lib.test.mjs` | accepts --enable-libvidstab only with the pinned commit recorded | DELETE | Direct evaluator repetition; BUILDINFO tree test owns acceptance and rejection. |
| `scripts/ffmpeg/lib.test.mjs` | pnpm ffmpeg:check reads the record from BUILDINFO.json next to the binaries | KEEP · F | Wrong or missing record must block a vid.stab-enabled binary. |
| `scripts/ffmpeg/lib.test.mjs` | passes an app that ships only the complete LGPL directory | KEEP · F | A valid packaged application must pass the legal guard. |
| `scripts/ffmpeg/lib.test.mjs` | fails without the LGPL directory, or when it lacks the notice | KEEP · F | Missing codec or legal notice must block distribution. |
| `scripts/ffmpeg/lib.test.mjs` | even an LGPL FFmpeg must not sit in a stray location | KEEP · F | An ungoverned second codec location must block distribution. |
| `scripts/ffmpeg/lib.test.mjs` | pins every prebuilt download and source tarball with a sha256 | KEEP · F | Integrity digest is required for every downloaded artifact. |
| `scripts/ffmpeg/lib.test.mjs` | rewrites the RPATH of the vendored ffmpeg in place | KEEP · F | ELF rewrite must preserve the runnable binary and length constraint. |
| `scripts/third-party-notices.test.mjs` | is current (pnpm notices --check) | REWRITE · N | Actual --check result owns stale notice failure; duplicate generator equality removed. |
| `scripts/third-party-notices.test.mjs` | lists the shipped closure of the web app and the Remotion bundle with licence texts | REWRITE · N | Live shipped packages must each have licence identifier or text; package inventory removed. |
| `scripts/third-party-notices.test.mjs` | excludes our workspace packages, dev-only tools and platform binaries | DELETE | Hard-coded blacklist; miniature closure test checks selection. |
| `scripts/third-party-notices.test.mjs` | lists the build-time packages whose output ships (review fixes): CSS, bundler runtimes, Remotion entry | DELETE | Expected set copied from SHIPPED_BUILD_OUTPUT; --check/audit own omission. |
| `scripts/third-party-notices.test.mjs` | reads name@version of node_modules sources from Vite and webpack sourcemaps | KEEP · N | Sourcemap audit must identify shipped package/version pairs. |
| `scripts/third-party-notices.test.mjs` | follows dependencies and required peers through workspace packages; renders deterministically | REWRITE · N | Keeps graph and licence-file behavior; removes self-comparison and Markdown fragments. |
| `scripts/third-party-notices.test.mjs` | adds shipped build output without its dependencies, resolved from a directory or an earlier entry | KEEP · N | Shipped bundler output must be listed without unrelated dependencies. |
| `scripts/third-party-notices.test.mjs` | licenseOf reads license, license.type and legacy licenses | DELETE | Private helper representation; miniature graph checks collected licence values. |

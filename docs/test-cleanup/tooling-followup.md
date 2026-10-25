# Tooling follow-up: behavioral seams and redundant work

This follow-up audits the nine currently present script test files after the earlier [tooling audit](tooling.md). It supersedes that report only for the decisions below; it does not claim its desktop/native work as new cleanup. All 69 original declarations were read with their implementation and independent requirements. The result has 66 declarations: DELETE 2; CONSOLIDATE 2 original declarations into 1 survivor; REWRITE 6; KEEP 59. These are declaration counts, not parameterized runtime counts. Fixture-lifetime improvements are infrastructure changes, not measured speedups.

Every retained row uses the six-part bar as follows. **1** The group's independent source specifies its policy/configuration/artifact behavior. **2** The row names its caller-visible failure. **3** The row names an authored/literal/independent oracle; diagnostic codes and legal/protocol bytes are contracts, while production expressions are not expected values. **4** The group names the stable seam used by real runner/packaging/lint callers. **5** The row still applies after implementation functions, variables, helper organization or algorithms are renamed/refactored without changing that seam. **6** The row names the distinct input policy/failure class; whole-repository lint proves current compliance but cannot prove the checker rejects a deliberately invalid fixture, and UI/export suites do not own lint, licensing or runner configuration. The independent cycle parser is the stronger owner for syntax recognition, removed from the layer suite below.

Tables give each test's exact name, disposition and unique failure/oracle. All paths are repository-relative. Low-risk pruning removes only duplicate or implementation-coupled observations; policies, security/distribution guarantees and actual artifact checks remain.

## `scripts/check-anime.test.mjs`

Source (bar 1): S11 ANM-001/002/006/007/012/022/023 (`docs/specs/11-animation.md`); architecture D-31.

Seam/callers (bars 4–5): `findViolations(path, authored source)` and `checkRepo(authored workspace)` diagnostics, consumed by `pnpm lint`. No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `only motion imports animejs; only compositions imports @jasper/motion` | KEEP | Wrong package may import anime.js/motion; literal allowed/refused package paths. |
| `motion uses anime.js subpaths; root value imports only in the runtime index (ANM-023)` | KEEP | Root imports escape the runtime allowance or valid type-only imports fail; literal rule outcomes. |
| `bans the wall-clock / DOM-rewriting modules everywhere, scope and engine outside the runtime` | KEEP | Wall-clock/DOM modules become permitted, or runtime scope/engine imports fail; explicit forbidden module examples. |
| `bans names whatever their alias or module; runtime-only names outside the runtime` | KEEP | An alias bypasses a prohibited import or valid runtime import fails; authored aliases and explicit rule IDs. |
| `bans the Timeline class and the autoplaying utils (review fixes)` | KEEP | Autoplaying Timeline/util APIs bypass lint; authored prohibited calls versus allowed type/runtime imports. |
| `bans wall-clock time and Math.random in motion and compositions sources` | KEEP | Wall-clock randomness escapes motion/composition lint or unrelated UI code is rejected; explicit calls and scopes. |
| `bans playback, unseeded randomness and the risky timeline APIs where anime.js is used` | KEEP | Playback, loop/blend, random and DOM rewriting pass lint; explicit prohibited source examples. |
| `tells timelines from Maps, arrays and functions (.set / .call / .reverse)` | KEEP | Normal Map/Array/function operations falsely fail, or real timeline calls pass; authored mixed legal/illegal source. |
| `treats values from timeline factories, annotated and renamed timelines as timelines (review fixes)` | KEEP | Renamed/annotated/factory-returned timelines bypass the same prohibition; authored valid TypeScript bindings. |
| `wall clock through optional chaining and computed access; shorthand loop / autoplay (review fixes)` | KEEP | Optional/computed wall-clock calls or shorthand autoplay/loop bypass lint; literal variants and permitted controls. |
| `a stagger seed must be an expression, not a literal false / 0 / undefined (review fixes)` | KEEP | False/zero/null seeds falsely count as seeded randomness; explicit invalid constants and valid expressions. |
| `bans animate() (also WAAPI el.animate), engine.update, timers, plain seeks outside the runtime` | KEEP | Animation timers/engine writes/plain seeks bypass canonical seeking; explicit prohibited/allowed source examples. |
| `bans unseeded random staggers and jitter (ANM-007)` | KEEP | Unseeded random stagger/jitter becomes permitted; independently authored seeded/unseeded examples and diagnostics. |
| `ignores comments and honours anime-allow with a reason` | KEEP | Comment text causes false lint failures or an empty allowance bypasses lint; explicit allowed and refused inputs. |
| `finds problems with file and line` | KEEP | Tree walking loses source diagnostics or scans test fixtures; authored path/line/rule expectations. |

## `scripts/check-cycles.test.mjs`

Source (bar 1): Architecture D-37 and AGENTS §6 dependency boundaries; TypeScript runtime import/erasure semantics.

Seam/callers (bars 4–5): `moduleReferences`, dependency graph/cycle diagnostics and CLI-used `cyclicComponents` over authored inputs. No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `reads imports, exports, dynamic imports and require calls from syntax, excluding comments and strings` | KEEP | Import/export/require forms or type-only annotations are misclassified; authored source and literal refs/locations. |
| `ignores import-like text inside JSX children` | KEEP | JSX text causes a false dependency; an authored JSX child must yield no imports. |
| `detects relative .js imports resolving to TypeScript source and emits actionable locations` | KEEP | .js runtime imports fail to resolve TypeScript source, hiding cycles; literal two-file cycle and actionable location. |
| `excludes explicit and inferred type-only imports erased by the compiler` | KEEP | Erased type dependencies produce false runtime cycles; authored type-only pair must have none. |
| `retains the side effect of inline type imports under verbatimModuleSyntax` | KEEP | Inline type import runtime side effects disappear under verbatimModuleSyntax; authored cycle must remain. |
| `includes literal dynamic imports and CommonJS import assignments` | KEEP | Dynamic imports/CommonJS assignments are omitted; authored two-module runtime cycle must be found. |
| `excludes tests, fixture directories, declarations and benchmarks from production cycles` | KEEP | Non-production files create false runtime cycles; authored self-loops in each excluded category must not report. |
| `resolves package subpaths across the workspace and aliases in inherited tsconfig files` | KEEP | Workspace exports/tsconfig aliases hide cross-package cycles; authored alias chain must report literal source pair. |
| `follows import and require export conditions instead of declaration entries` | KEEP | Declaration export entries hide actual import/require cycles; authored conditional exports must report runtime files. |
| `follows workspace source dependencies outside the initial src directories` | KEEP | Imported source outside src directories hides a cycle; authored src/helper pair must be found. |
| `reports invalid project configuration instead of silently inspecting a different graph` | KEEP | Bad inherited configuration silently scans a different graph; missing-config fixture must report its path. |
| `matches mutual reachability for generated directed graphs` | KEEP | General cycle membership is wrong; independent directed mutual-reachability oracle disagrees with SCC output. |
| `finds every independent component and self-loop without overflowing on long graphs` | KEEP | Long dependency chains overflow or lose separate cycles/self-loops; authored 20,000-node graph expects sizes 1/10. |

## `scripts/check-layers.test.mjs`

Source (bar 1): Architecture §3.1 and AGENTS §6 package, pure-model and declared-export rules.

Seam/callers (bars 4–5): `checkRepo(authored miniature workspace)` diagnostics, consumed by `pnpm lint`. No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `allows the edges of the table` | KEEP | A documented valid package edge is falsely refused; valid API→project manifest/source expects no diagnostics. |
| `fails on a forbidden edge in package.json and in source` | KEEP | A forbidden package edge is accepted in a manifest or source; authored project→API expects both violations. |
| `fails on an undeclared workspace import and on a subpath the target does not export` | KEEP | Undeclared imports or non-exported subpaths become permitted; literal public/nonpublic import examples. |
| `fails on deep relative imports across package roots, and packages importing apps` | KEEP | Deep cross-package or package→app imports bypass boundaries; literal prohibited relative and package paths. |
| `keeps platform, UI and rendering dependencies out of the pure model` | CONSOLIDATE — surviving owner | Pure-model platform/UI/render dependencies become permitted; literal Node, React, Remotion, anime, Radix/Fastify inputs with explicit rejection list, plus valid immer/allowance controls. |
| `allows React in @jasper/session only under src/react` | REWRITE | React leaks outside session/react or is refused inside it; authored allowed/refused paths require only session.ts diagnostic. |
| `fails on an unknown workspace package` | KEEP | A new workspace package bypasses architectural ownership; unknown package fixture requires unknown-package diagnostic. |
| `allows only type imports of the desktop API bridge contract` | KEEP | Desktop API type-only allowance admits runtime imports; authored identical type/value specifiers require one value violation. |

## `scripts/check-tokens.test.mjs`

Source (bar 1): S05 DT-002, architecture D-15 and AGENTS §6 design tokens; AGENTS §0 failure surfacing.

Seam/callers (bars 4–5): `checkRepo(authored UI tree)` diagnostics or surfaced filesystem error. No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `reports raw UI colors while allowing theme tokens and documented exceptions` | KEEP | Raw palette/hex colors pass lint or theme/declared data exceptions fail; literal tree expects two offending diagnostics. |
| `does not silently pass when a source directory cannot be scanned` | KEEP | An unreadable source path makes lint falsely pass; a file at the directory path must surface ENOTDIR. |

## `scripts/e2e-server-timeout.test.mjs`

Source (bar 1): README browser-test startup timeout contract; sound-design work note WP6.5b item 19 historical hard-coded 60 s regression.

Seam/callers (bars 4–5): `e2eServerTimeoutMs(env)` and exported Playwright `webServer.timeout`, consumed by the browser runner. No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `defaults to 180 s when unset or empty` | REWRITE | Absent/empty configuration loses the documented 180 s default; literal expected 180000, without a declaration self-check. |
| `takes a whole number of milliseconds inside 1 s … 1 h` | REWRITE | Documented integer overrides/boundaries fail; literal 1000/3600000 input/output pairs, independent of implementation constants. |
| `refuses values that are not whole milliseconds or out of range, naming the variable` | KEEP | Malformed/out-of-range values silently fall back; authored invalid strings must throw naming the public environment key. |
| `applies the environment override to Playwright web-server startup` | REWRITE | Playwright ignores a valid 600 s override, reproducing the fixed-60 s startup bug; actual exported config must expose 600000. |

## `scripts/ffmpeg/lib.test.mjs`

Source (bar 1): AGENTS §2 and architecture D-13 licensing/distribution policy; S07 PST-003 vid.stab exception; `docs/wp-notes/wp-lgpl.md`.

Seam/callers (bars 4–5): `checkTree`, `checkPackagedApp`, pinned manifest and actual ELF artifact, consumed by license-check CLI/packaging/assembly. No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `fails on GPL libraries and Remotion compositor packages, passes LGPL ones` | KEEP | GPL/nonfree/compositor artifacts pass or valid platform libraries fail; authored cross-platform binary bytes and literal offending paths/reasons. |
| `pins a post-relicense vid.stab commit with its provenance` | KEEP | vid.stab pin loses post-relicense provenance; independent required license, SHA syntax, issue/record path and chronological licensing constraints. |
| `pnpm ffmpeg:check reads the record from BUILDINFO.json next to the binaries` | KEEP | Allowed vid.stab source is accepted without or with wrong provenance; authored matching/wrong/missing BUILDINFO cases. |
| `passes an app that ships only the complete LGPL directory` | KEEP | A complete LGPL distribution is falsely rejected; independently assembled required-file fixture expects no violations. |
| `fails without the LGPL directory, or when it lacks the notice` | KEEP | Missing/incomplete LGPL distribution or notice is accepted; separate missing-directory, incomplete and missing-notice fixtures. |
| `fails when Remotion's compositor package, an x264 library or a GPL FFmpeg in the asar ships` | KEEP | Compositor packages, x264 libraries or GPL bytes embedded in asar ship; authored prohibited bytes/paths require specific policy diagnostics. |
| `checks Electron's own FFmpeg library by its license string, wherever Electron puts it` | KEEP | Electron LGPL playback library is rejected or GPL library accepted; authored platform filenames and independent license strings. |
| `even an LGPL FFmpeg must not sit in a stray location` | KEEP | LGPL FFmpeg ships outside its replaceable distribution directory; authored stray executable must produce location diagnostic. |
| `pins every prebuilt download and source tarball with a sha256` | KEEP | A download/source input lacks its required pin; every configured source/platform needs a literal 64-hex SHA syntax obligation. |
| `rewrites the RPATH of the vendored ffmpeg in place` | KEEP | ELF RPATH bytes are not rewritten or an overlong rewrite corrupts them; independent readelf observes lib, then failed patch must preserve bytes. |

## `scripts/fixture-encoding.test.mjs`

Source (bar 1): AGENTS §2 LGPL-only fixture compatibility; README FFmpeg fixture setup.

Seam/callers (bars 4–5): `fixtureH264Args(encoder listing, lgplOnly)` argument/error result, consumed by fixture generators. No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `uses OpenH264 in LGPL-only mode even when x264 is available` | KEEP | LGPL-only fixtures choose prohibited x264 despite available OpenH264; explicit listing/mode requires OpenH264. |
| `uses either supported encoder in development` | KEEP | Development fixtures cannot use either documented software encoder; distinct available-encoder listings require usable choices. |
| `refuses missing or disallowed encoders before generating any media` | KEEP | Fixture setup silently chooses unsupported/disallowed or prefix-only encoder names; explicit lists require actionable refusal. |

## `scripts/fixture-gpl-encoders.test.mjs`

Source (bar 1): AGENTS §2 prohibited encoder/filter bytes and LGPL-only fixture compatibility.

Seam/callers (bars 4–5): Actual test/spec/fixture source bytes, retained source-policy exception (identifier renames do not matter). No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `no test, spec or fixture script hard-codes a GPL encoder or a GPL-only filter` | KEEP | A fixture hard-codes prohibited FFmpeg encoder/filter bytes and fails shipped LGPL-only setup; literal prohibition policy requires zero offending bytes. |

## `scripts/third-party-notices.test.mjs`

Source (bar 1): AGENTS §2/§3/§8, S11 FIX-010, architecture D-36 and `licenses/ported/README.md` notice/attribution format.

Seam/callers (bars 4–5): Notice CLI exit status, authored workspace/record input and rendered legal artifact; consumed by notices CLI and packaging. No mock supplies the behavior being checked. Each independent authored case below is the lowest owner for its stated failure (bars 2–3/6).

| Test | Outcome | Unique failure and independent oracle |
|---|---|---|
| `is current (pnpm notices --check)` | KEEP | Committed shipped notice bytes drift from generated production closure/records; CLI --check compares to the committed independent artifact. |
| `identifies the licence of every shipped JavaScript package` | KEEP | Shipped JavaScript package licensing becomes unknown without a license text; dependency metadata must meet this independent license obligation. |
| `reads name@version of node_modules sources from Vite and webpack sourcemaps` | KEEP | Sourcemap audit misses Vite/webpack package paths, including scoped packages; authored maps have literal package@version results. |
| `follows dependencies and required peers through workspace packages` | KEEP | Production/required-peer closure is wrong or optional/dev dependencies leak; authored workspace has independent alpha/beta/gamma license/text outcomes. |
| `adds shipped build output without its dependencies, resolved from a directory or an earlier entry` | KEEP | Shipped build output is omitted or all devtool dependencies are incorrectly shipped; authored output list expects only named runtime entries and specific missing-package failure. |
| `reads every record except the README, and renders them with the licence texts` | REWRITE | Ported attribution/paths/license texts disappear, README leaks, or public section markers change; authored legal strings and literal marker bytes are independent of implementation constants. |
| `accepts the plain forms other records use` | KEEP | Existing plain-form upstream/license/copyright records stop parsing; authored representative record has literal attribution expectations. |
| `reads a licence line with extra words and emphasis` | KEEP | Existing emphasized license lines stop parsing; authored representative record expects literal license expression/upstream URL. |
| `refuses an incomplete record or a licence without its text, naming the file and the fix` | KEEP | Incomplete source attribution or missing named license text is accepted; authored invalid records require actionable file/license diagnostics. |
| `names each copyright line once, with the records it covers (wp fixups)` | REWRITE | Copyright attribution groups are lost/misnormalized across records/licenses; authored holder sets and legal text must survive generation (no incidental record-format pin). |

The surviving layer owner was originally named `keeps Node built-ins, React, Remotion and anime.js out of the pure model`; it is now `keeps platform, UI and rendering dependencies out of the pure model` after consolidation. The Playwright wiring REWRITE was originally `is what playwright.config.ts uses for its webServer`; the new name describes the observed startup behavior.

## Removed executions and infrastructure

| Original path / test | Outcome | Failed bar and surviving protection |
|---|---|---|
| `scripts/check-layers.test.mjs` — `rejects scoped UI and server packages in browser model layers` | CONSOLIDATE | Private injected `LAYERS`/`fileViolations` context failed stable-seam/refactor bars 4–5 and repeated the model-dependency policy owner (bar 6). Its three unique scoped examples now run with the other platform/render examples through public `checkRepo` in `keeps platform, UI and rendering dependencies out of the pure model`. |
| `scripts/check-layers.test.mjs` — `inspects import types and ignores imports quoted inside source strings and comments` | DELETE | Duplicates the lower shared parser owner (bar 6) and observes private context (bar 4). `scripts/check-cycles.test.mjs` — `reads imports, exports, dynamic imports and require calls from syntax, excluding comments and strings` independently checks import-type and comment/string behavior; layer tests continue to prove policy enforcement on type/value imports. |
| `scripts/fixture-gpl-encoders.test.mjs` — `the scan sees the places fixtures are made` | DELETE | Existing filename inventory and a test-local regular expression's self-examples fail independently specified behavior/stable-seam/refactor bars 1/4/5. Renaming a fixture should not fail the suite. The surviving repository policy test checks the prohibited bytes themselves. |

- Layer policy tests use miniature workspace inputs instead of copying an internal context shape and importing its policy table. Remove `LAYERS` and `fileViolations` exports plus `checkRepo`'s unused injected-policy argument; all have only test callers outside the defining script. The CLI still consumes `checkRepo` and internal policy/functions unchanged.
- Timeout tests use literal documented boundary inputs instead of values imported from implementation constants. Remove the three unused constant exports; `e2eServerTimeoutMs` stays used by Playwright.
- Timeout wiring now observes the exported configuration under `E2E_SERVER_TIMEOUT_MS=600000`. This catches the historical fixed-60-second bug while surviving a helper rename. Environment stubs restore the original timeout/token/editor-key state, including keys generated when the config module evaluates.
- Notice-section tests now find the public `<!-- ported-source:start -->`/`<!-- ported-source:end -->` byte markers independently. Remove the two test-only marker exports. Their internal values and the Help/About consumer remain unchanged.
- Register per-test temporary-directory removal in layer, anime, notice and binary fixtures. No shared mutable fixture or order dependence is introduced. Real license checks, parser inputs, generated files and oracle observations remain intact until each test ends.
- No dependencies, snapshots or committed fixtures became unused. Root `maxWorkers=4` with shared-host override `--maxWorkers=2` already bounds contention. Fast-check setup remains because it owns seed/path replay; no measured evidence justified changing it.
- Root `lint` now runs `node scripts/i18n.mjs --check`, the same checker as `pnpm i18n:check`. This makes the central UI-source/model-key and Spanish-placeholder validator mandatory in local verification and CI, preserving the independently specified localization contract after the web-sound owner removes duplicate catalogue-inventory tests. Runtime translation behavior stays in the web suite. No keys, placeholders, dependency or lockfile changed here.

## Validation and measurements

Validation used Node 20.19.0, pnpm 10.34.5, `JASPER_REQUIRE_ORACLES=1` and `JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome` on the shared 8-vCPU AMD EPYC-Genoa/15 GiB Linux host. A browser build/preparation was active in the other validation slot; these isolated timings are not a comparable full-suite speed measurement.

- `pnpm exec vitest run scripts/check-anime.test.mjs scripts/check-cycles.test.mjs scripts/check-layers.test.mjs scripts/e2e-server-timeout.test.mjs scripts/ffmpeg/lib.test.mjs scripts/fixture-gpl-encoders.test.mjs scripts/third-party-notices.test.mjs --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-test-cleanup/tooling-final.json`: **60 passed, 1 skipped**, GNU-time wall **3.11 s**, peak RSS 174,876 KiB. The skipped real RPATH rewrite requires a vendored FFmpeg in this worktree; synthetic distribution/license cases ran. Unchanged token/encoder-choice suites are left to the root full gate.
- `node scripts/i18n.mjs --check`: passed, all **10,854** strings covered.
- `pnpm e2e:typecheck`: passed.
- Scoped `pnpm exec biome check` of the ten changed code/configuration files and `git diff --check`: passed.
- Four restoring mutation experiments passed: hard-code Playwright startup to 60,000 ms; allow React in the pure-model policy; delete the `Proposal review: {0} items` Spanish translation; change its `{0}` placeholder to `{1}`. The first two make the intended rewritten behavioral tests fail; the latter two make the newly mandatory localization checker fail for exactly the missing-key/placeholder reason. Every mutated file was restored byte-for-byte. Commands/results are in `/tmp/jasper-test-cleanup/tooling-mutations.json` and the corresponding `tooling-mutant-*.log` files.

The functional configuration test took 328 ms in this run because it imports actual Playwright configuration instead of inspecting source text; that cost buys regression protection through the stable configuration seam. No tooling speedup is claimed from non-comparable file times. The root's quiet full-suite before/after and final lint/typecheck/build evidence are authoritative. The new localization lint scan must be included when discussing CI/full-gate cost; moving duplicate checks between mandatory gate stages alone is not a CI speed improvement.

# Desktop, native and tooling test cleanup

Status: cleanup implemented; pre-edit dispositions below were recorded after reading tests, production owners and independent contracts. Integrated runtime validation remains pending as described at the end. This report distinguishes test declarations from parameterized runtime cases.

The six numbered checks in each retained row are the user's retention bar. Group metadata supplies the exact source, stable seam, non-test callers, stronger-owner comparison, risk and validation command for every row in that group. Diagnostic rule IDs, MIME/cookie bytes, package paths, legal copyright text and native protocol fields are contracts; prose, formatting and collaborator bookkeeping are not. Source text supplied as analyzer input tests the lint tool itself and does not grep implementation source.

## `apps/desktop/test/engine-process.test.ts`

- Independent source: AGENTS §0; docs/wp-notes/code-audit-desktop-native.md readiness/exit findings.
- Stable seam / non-test callers: startEngineProcess promise and Electron utility-process messages/signals; apps/desktop/src/main.ts startPackagedLike/before-quit.
- Remaining stronger coverage: desktop smoke covers successful launch, not malformed IPC, early death or timeouts.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run apps/desktop/test/engine-process.test.ts --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### REWRITE — `waits for a validated port before declaring the engine ready`

- Detectable failure: invalid port readiness resolves an unusable app origin before the later valid message.
- Change: Assert promise remains pending until valid port, without listener/timer counts.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `releases the shutdown timeout when the process exits`

- Detectable failure: stop resolves before the child exits or kills an already-exited process again.
- Change: Assert pending stop until child exit and idempotence after exit; remove timer-count implementation pin.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `rejects early process exits and stops listening for readiness`

- Detectable failure: early engine death leaves startup unresolved instead of rejecting.
- Change: Assert rejection and no later timeout kill; remove listener/timer counts and exact prose.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `kills an unresponsive engine and removes its readiness listener`

- Detectable failure: an unresponsive engine leaves startup unresolved and the child running.
- Change: Use production timeout with fake clock, assert rejection/child termination; remove injected timeout option and listener count.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `apps/desktop/test/main.test.ts`

- Independent source: AGENTS §0; code-audit-desktop-native.md; security-review.md MG-1.
- Stable seam / non-test callers: registered Electron IPC handlers and native window/dialog boundary; Electron main bootstrap and renderer DesktopBridge consumers.
- Remaining stronger coverage: security helpers cannot prove handlers enforce their policy; successful desktop smoke cannot inject native dialog/Blob failures.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run apps/desktop/test/main.test.ts --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### REWRITE — `reports invalid development URLs and exits through the normal shutdown path`

- Detectable failure: invalid dev URL escapes startup without visible error and orderly quit.
- Change: Observe visible error and shutdown, not dialog title/prefix wording.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `reports failed editor loads instead of leaving an invisible window`

- Detectable failure: rejected window load leaves an invisible editor and unhandled rejection.
- Change: Observe error detail and visible window without exact dialog prose.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `opens a single-directory dialog owned by the requesting window`

- Detectable failure: folder picker selects files/multiple items or loses requesting-window ownership.
- Change: Assert directory-only native capability and returned path without title text.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `returns null on cancellation`

- Detectable failure: cancellation overwrites a caller path with a nonexistent selection.
- Change: Assert cancellation result without duplicate native options shape.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `propagates native dialog failures instead of reporting cancellation`

- Detectable failure: native dialog failure is disguised as a user cancellation.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `refuses callers outside the app document: %j [null, foreign-origin, same-origin subframe]`

- Detectable failure: foreign, missing or child frame can open native folder dialog.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `%s keeps later valid entries when %s rejects [clipboard-read/read-files × getType/text]`

- Detectable failure: one unreadable clipboard entry hides a later valid payload or file.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `apps/desktop/test/preload.test.ts`

- Independent source: DesktopBridge in packages/api; code-audit-desktop-native.md folder-picker finding.
- Stable seam / non-test callers: exposed jasperDesktop bridge and Electron IPC channel; web cache preferences and Remotion import dialog.
- Remaining stronger coverage: main.test.ts owns cancellation and failure semantics; preload only owns IPC routing.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run apps/desktop/test/preload.test.ts --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### REWRITE — `invokes the folder channel without renderer-controlled dialog options`

- Detectable failure: folder-picker bridge invokes wrong IPC capability or forwards renderer-controlled options.
- Change: supply hostile extra options from untyped renderer JavaScript; assert they do not cross the IPC protocol. Remove arranged-value identity assertion.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### DELETE — `preserves cancellation as null`

- Detectable failure: identity wrapper does not return arranged null (already owned by main IPC test).
- Reason / remaining owner: Mocked ipcRenderer returns arranged null through an identity wrapper; main IPC cancellation test is stronger owner (fails bar 3/6).
- Seam/support caller audit: production owner remains used by the callers listed above; remove only now-unused imports/exports. No fixture/snapshot is exclusive to this declaration.

### DELETE — `preserves failures for the renderer error boundary`

- Detectable failure: identity wrapper does not return arranged rejection (already owned by main IPC test).
- Reason / remaining owner: Mocked ipcRenderer returns arranged error through identity wrapper; main IPC failure and web error-boundary tests own caller behavior (fails bar 3/6).
- Seam/support caller audit: production owner remains used by the callers listed above; remove only now-unused imports/exports. No fixture/snapshot is exclusive to this declaration.

## `apps/desktop/test/security.test.ts`

- Independent source: AGENTS §§0/2; ARCHITECTURE D-13/§4.3; security-review.md ENG-5/ELE-1/AGT-2/MG-1/RUN-1; S01 CLB-002/009/010.
- Stable seam / non-test callers: IPC input policy functions and shipped electron-builder configuration; apps/desktop/src/main.ts IPC, navigation, permissions, cookie and MCP handlers; desktop packager.
- Remaining stronger coverage: runtime desktop smoke proves wiring, while these input matrices and target-platform configurations cannot be exercised by its one valid Linux app.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run apps/desktop/test/security.test.ts --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `writes only sane JasperEditor payloads under the custom format`

- Detectable failure: malformed/oversized custom payload reaches OS clipboard or uses incompatible custom MIME bytes.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `reads back only the format JSON within the cap`

- Detectable failure: malformed/oversized custom clipboard JSON reaches renderer.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `parses uri-lists and GNOME copies into local absolute paths only`

- Detectable failure: remote URI, malformed escape or NUL becomes a local file; duplicate or excessive file list passes.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `only hands http(s)/mailto links to the OS`

- Detectable failure: OS opens javascript/file/custom scheme supplied by a renderer.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `keeps navigation on the app origin`

- Detectable failure: navigation crosses port/host origin boundary.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `validates IPC arguments`

- Detectable failure: relative/NUL paths or unrecognized window actions reach native APIs.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `packaged apps run the bundle with their own binary as Node; checkouts use node`

- Detectable failure: packaged MCP launch tries absent system Node or does not use Electron Node mode.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `a packaged app with a bundled Node runtime launches jasper-mcp with it, without ELECTRON_RUN_AS_NODE`

- Detectable failure: shipped Node runtime is ignored or Electron environment contaminates its invocation.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `names the session and editor cookies by the engine port and keeps the two secrets apart`

- Detectable failure: cookies collide across engine ports or conflate editor and agent credentials.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `packages the LGPL FFmpeg directory, excludes the Remotion compositor packages, guards after packing`

- Detectable failure: shipping config omits LGPL directory or includes prohibited compositor packages.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `flips the Electron fuses`

- Detectable failure: shipping config permits NODE_OPTIONS/inspect injection, file privilege or unverified asar.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `accepts a finite, positive CSS-pixel rectangle only`

- Detectable failure: invalid/nonfinite/oversized capture rectangle reaches native allocation.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `grants audio-only media requests from the app origin`

- Detectable failure: app-origin camera or empty media request gains permission while microphone is refused.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `denies other origins and other permissions`

- Detectable failure: foreign origin or unrelated permission is granted.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `opens media paths but never programs or launchers`

- Detectable failure: OS-open adapter admits launcher/executable/extensionless path.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `native/mg/crates/jasper-mg-cli/src/main.rs`

- Independent source: AGENTS §0; docs/wp-notes/code-audit-desktop-native.md native stream/worker/thread defects; ARCHITECTURE §10.2.
- Stable seam / non-test callers: fframes::Video failure boundary; rewritten cases use actual CLI stdin/stdout/exit/status; CLI render/schema/version/svg commands and engine apps/engine/src/mg.
- Remaining stronger coverage: successful CLI rendering does not exercise poisoned worker, failed output or oversized stdin; thread environmental single case is merged with flag/input matrix.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `cargo test --workspace --manifest-path native/mg/Cargo.toml -j 1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `worker_panics_are_reported_as_render_errors`

- Detectable failure: a panicking Video worker unwinds/hangs rendering instead of returning render failure.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `output_errors_return_render_failures`

- Detectable failure: closed output pipe crashes or reports success instead of RENDER_FAILED/exit 1.
- Change: Move to CLI SVG output over closed pipe; remove generic writer injection seam.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `spec_reads_are_bounded_even_for_endless_input`

- Detectable failure: stdin beyond documented 1 MiB cap is allocated/parsed instead of refused as INVALID_SPEC.
- Change: Move to CLI valid spec padded beyond 1 MiB on stdin, preserving open-input cap refusal.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `invalid_thread_settings_are_refused`

- Detectable failure: explicit invalid thread values are silently clamped/defaulted.
- Change: Move invalid explicit settings to CLI flags and environment matrix; valid limits tested at CLI.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `native/mg/crates/jasper-mg-cli/tests/cli.rs`

- Independent source: ARCHITECTURE §10.2 CLI protocol and straight-alpha contract; code-audit-desktop-native.md thread validation.
- Stable seam / non-test callers: actual jasper-mg executable stdout/stderr, exit status and PNG bytes; engine apps/engine/src/mg process adapter.
- Remaining stronger coverage: Rust parser/SVG tests cannot prove command dispatch, NDJSON, pipe encoding or parallel worker output; engine tests cannot replace the CLI owner.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `cargo test --workspace --manifest-path native/mg/Cargo.toml -j 1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `version_is_json`

- Detectable failure: --version emits non-JSON or incompatible native engine identification.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `lower_third_fixture_renders_every_frame_in_order`

- Detectable failure: raw render emits missing/extra/out-of-order frames, missing NDJSON terminal event or no visual frame.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `straight_alpha_probe_pixel_stays_white`

- Detectable failure: premultiplication darkens RGB of half-transparent white pixels.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `invalid_specs_exit_with_code_2`

- Detectable failure: invalid specs/options/frame indices produce media or wrong status/error protocol.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `frame_writes_a_png`

- Detectable failure: frame command fails to write PNG with requested dimensions.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `invalid_thread_environment_is_reported_as_a_spec_error`

- Detectable failure: invalid thread environment is silently ignored instead of INVALID_SPEC.
- Change: Merge environment rejection with rewritten thread-setting CLI matrix; also assert positive limits.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `parallel_output_matches_sequential_frame_order`

- Detectable failure: parallel workers reorder/alter frame bytes relative to deterministic sequential output.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from the independent requirement that worker count cannot change the same render, checked as complete output bytes, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `native/mg/crates/jasper-mg-core/src/spec.rs`

- Independent source: ARCHITECTURE §10.2 MgRenderSpec; S01 KND-009 timing; AGENTS §0 bounded validation.
- Stable seam / non-test callers: MgSpec parser and frame_time content-time API; CLI Prepared spec loader and template renderer.
- Remaining stronger coverage: CLI tests reject template/command failures, not these low-level spec grammar and rational-rate cases.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `cargo test --workspace --manifest-path native/mg/Cargo.toml -j 1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `rejects_unknown_fields_and_bad_values`

- Detectable failure: invalid JSON/unknown fields/zero duration/zero denominator/too-small dimensions enter renderer.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `frame_time_uses_the_rational_rate`

- Detectable failure: fractional fps or source trim shifts content time/outro duration.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `native/mg/crates/jasper-mg-templates/tests/svg.rs`

- Independent source: security-review.md imported text/input boundary; AGENTS §0; SVG/XML text escaping contract.
- Stable seam / non-test callers: Prepared.svg output parsed by independent roxmltree XML parser; CLI SVG output and AnyTemplate render_frame.
- Remaining stronger coverage: straight-alpha/CLI frame tests do not contain hostile user text or inspect XML text nodes.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `cargo test --workspace --manifest-path native/mg/Cargo.toml -j 1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `user_text_remains_text_in_svg`

- Detectable failure: user text injects a script XML element or changes literal text instead of escaping it.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `scripts/check-anime.test.mjs`

- Independent source: S11 ANM-001/002/003/006/007/012/022/023; ARCHITECTURE D-31.
- Stable seam / non-test callers: lint source-input/diagnostic API, not a grep of implementation source; checkRepo and pnpm lint CLI.
- Remaining stronger coverage: motion determinism only covers current templates; lint must reject future forbidden inputs without rejecting valid syntax.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run scripts/check-anime.test.mjs --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `only motion imports animejs; only compositions imports @jasper/motion`

- Detectable failure: animejs or motion imports escape their designated architectural layers.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `motion uses anime.js subpaths; root value imports only in the runtime index (ANM-023)`

- Detectable failure: root value imports bypass prescribed subpaths while type-only imports are incorrectly rejected.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `bans the wall-clock / DOM-rewriting modules everywhere, scope and engine outside the runtime`

- Detectable failure: wall-clock/DOM mutation modules pass lint or runtime scope allowance disappears.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `bans names whatever their alias or module; runtime-only names outside the runtime`

- Detectable failure: aliases or namespace/dynamic import bypass forbidden API guards.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `bans the Timeline class and the autoplaying utils (review fixes)`

- Detectable failure: autoplaying Timeline/set/sync utility constructs pass lint.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `bans wall-clock time and Math.random in motion and compositions sources`

- Detectable failure: wall clock or unseeded Math.random passes render-source lint.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `bans playback, unseeded randomness and the risky timeline APIs where anime.js is used`

- Detectable failure: playback/callback/loop/blend/unseeded random or engine writes pass lint.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `tells timelines from Maps, arrays and functions (.set / .call / .reverse)`

- Detectable failure: timeline mutation is missed on a chain, or harmless Map/array/function operation is rejected.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `treats values from timeline factories, annotated and renamed timelines as timelines (review fixes)`

- Detectable failure: factory/annotation/destructuring aliases bypass timeline restrictions.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `wall clock through optional chaining and computed access; shorthand loop / autoplay (review fixes)`

- Detectable failure: optional/computed property access or shorthand options bypass deterministic lint rules.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `a stagger seed must be an expression, not a literal false / 0 / undefined (review fixes)`

- Detectable failure: falsy/literal seed bypasses required deterministic seed expression.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `bans animate() (also WAAPI el.animate), engine.update, timers, plain seeks outside the runtime`

- Detectable failure: animate/WAAPI/timers/direct seek bypass seek-only rendering.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `bans unseeded random staggers and jitter (ANM-007)`

- Detectable failure: random-order/jitter stagger without seed is allowed, or deterministic stagger is rejected.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `ignores comments and honours anime-allow with a reason`

- Detectable failure: comment/allow marker breaks allowed-line escape hatch or blank reason bypasses lint.
- Change: Remove string-literal false-positive pin; retain documented comment/allow semantics.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `finds problems with file and line`

- Detectable failure: filesystem scanner misses a source violation or reports wrong file/line while inspecting tests.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `scripts/check-assets.test.mjs`

- Independent source: AGENTS §3; ARCHITECTURE D-38 asset attribution contract.
- Stable seam / non-test callers: asset-lint file/sidecar input and diagnostic result; sidecar grammar parser; checkRepo and pnpm lint CLI.
- Remaining stronger coverage: pnpm lint guards actual committed assets but cannot prove rejection of missing or invalid metadata.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run scripts/check-assets.test.mjs --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### REWRITE — `recognises assets by extension, not code or data`

- Detectable failure: non-image asset categories evade required attribution; code/data falsely require artwork sidecars.
- Change: Exercise attribution diagnostics for each asset extension through findProblems, remove classifier-only export.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `accepts an asset with a complete sidecar and an index row`

- Detectable failure: complete original-work attribution is refused.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### DELETE — `fails without a sidecar, and the fix is the exact template to write`

- Detectable failure: missing-sidecar refusal was duplicated; the remaining assertions pinned diagnostic prose, spacing and a private template helper.
- Remaining owner: rewritten asset-category test now checks actual missing-sidecar diagnostics for every required asset category, including PNG. No real behavior loses coverage (bar 6 fails).
- Non-test callers: template remains private inside findProblems; no external caller imports it. Risk low; validation uses the group command.

### REWRITE — `fails on a missing index row, missing keys, a wrong asset name, a bad licence or date`

- Detectable failure: missing index/required keys, wrong basename, NC license or invalid attribution date passes lint.
- Change: Check malformed fields independently using file/field tokens, without diagnostic sentence snapshots.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `checks that a named licence file exists, and accepts SPDX expressions`

- Detectable failure: missing license text passes lint or allowed SPDX expression is refused.
- Change: Use named missing license path, without exact diagnostic prose.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `fails on orphan sidecars and on committed generated media`

- Detectable failure: orphan metadata or generated fixture media is accepted into repository.
- Change: Assert offending file results, without prose snapshots.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `parses continuation lines`

- Detectable failure: indented metadata continuation loses required attribution content.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### DELETE — `the repository passes`

- Detectable failure: duplicates current pnpm lint check without independently exercising rejection behavior.
- Reason / remaining owner: Duplicate pnpm lint check, which is already a mandatory gate (fails bar 6).
- Seam/support caller audit: production owner remains used by the callers listed above; remove only now-unused imports/exports. No fixture/snapshot is exclusive to this declaration.

## `scripts/check-cycles.test.mjs`

- Independent source: AGENTS §6; ARCHITECTURE §3.1; docs/wp-notes/dependency-cycles.md; TypeScript runtime import semantics.
- Stable seam / non-test callers: module-reference parser, filesystem dependency graph and mathematical SCC result; scripts/check-layers.mjs imports parser/graph/cycleViolations; cycle CLI.
- Remaining stronger coverage: checked-out graph being acyclic cannot prove cycle detection or TypeScript resolution and erasure rules.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run scripts/check-cycles.test.mjs --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `reads imports, exports, dynamic imports and require calls from syntax, excluding comments and strings`

- Detectable failure: parser confuses code/comments/strings, loses type-only information or import/export/require forms.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `ignores import-like text inside JSX children`

- Detectable failure: JSX content is mistaken for runtime import.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `detects relative .js imports resolving to TypeScript source and emits actionable locations`

- Detectable failure: .js-to-.ts edge resolution misses cycle or diagnostic lacks actionable source location.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `excludes explicit and inferred type-only imports erased by the compiler`

- Detectable failure: type-only imports erased by TypeScript cause false runtime cycles.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `retains the side effect of inline type imports under verbatimModuleSyntax`

- Detectable failure: verbatimModuleSyntax side-effect import is incorrectly erased from runtime graph.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `includes literal dynamic imports and CommonJS import assignments`

- Detectable failure: dynamic import/CommonJS assignment cycle is missed.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `excludes tests, fixture directories, declarations and benchmarks from production cycles`

- Detectable failure: nonproduction files/declarations cause false production cycle errors.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `resolves package subpaths across the workspace and aliases in inherited tsconfig files`

- Detectable failure: workspace exports or inherited TS aliases hide cross-package cycles.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `follows import and require export conditions instead of declaration entries`

- Detectable failure: conditional exports follow declarations/wrong runtime mode instead of import/require entries.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `follows workspace source dependencies outside the initial src directories`

- Detectable failure: out-of-src helper dependencies hide a real workspace cycle.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `reports invalid project configuration instead of silently inspecting a different graph`

- Detectable failure: invalid tsconfig silently changes analyzed graph instead of reporting configuration error.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `matches mutual reachability for generated directed graphs`

- Detectable failure: SCC algorithm omits or merges mutually reachable graph components.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from mathematical mutual reachability using a separate graph walk, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `finds every independent component and self-loop without overflowing on long graphs`

- Detectable failure: long dependency graph overflows stack or loses independent/self-loop components.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `scripts/check-layers.test.mjs`

- Independent source: AGENTS §6; ARCHITECTURE §3.1 dependency table; desktop type-only API boundary.
- Stable seam / non-test callers: workspace/package manifest and source-input lint diagnostics; pnpm lint; checkRepo invokes fileViolations with actual package metadata.
- Remaining stronger coverage: pnpm lint checks current repository, while synthetic illegal edges prove the guard rejects future violations.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run scripts/check-layers.test.mjs --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `allows the edges of the table`

- Detectable failure: allowed API-to-model dependency is rejected.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `fails on a forbidden edge in package.json and in source`

- Detectable failure: forbidden model-to-API edge passes manifest/source lint.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `fails on an undeclared workspace import and on a subpath the target does not export`

- Detectable failure: undeclared workspace dependencies or unexported subpaths pass lint.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `fails on deep relative imports across package roots, and packages importing apps`

- Detectable failure: deep relative imports bypass package roots or packages import apps.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `keeps Node built-ins, React, Remotion and anime.js out of the pure model`

- Detectable failure: pure model imports Node/UI/renderer runtime dependencies.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `allows React in @jasper/session only under src/react`

- Detectable failure: React leaks into session core or permitted React adapter is rejected.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `fails on an unknown workspace package`

- Detectable failure: new unregistered package bypasses architecture table.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `rejects scoped UI and server packages in browser model layers`

- Detectable failure: scoped UI/server/renderer packages bypass browser-layer dependency guard.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `allows only type imports of the desktop API bridge contract`

- Detectable failure: desktop runtime-imports browser API package or type-only bridge dependency is refused.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `inspects import types and ignores imports quoted inside source strings and comments`

- Detectable failure: import-type violations are missed or quoted sample/comment imports are rejected.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### DELETE — `the repository passes`

- Detectable failure: duplicates current pnpm lint check without independently exercising rejection behavior.
- Reason / remaining owner: Duplicate pnpm lint check, which is already a mandatory gate (fails bar 6).
- Seam/support caller audit: production owner remains used by the callers listed above; remove only now-unused imports/exports. No fixture/snapshot is exclusive to this declaration.

## `scripts/check-tokens.test.mjs`

- Independent source: AGENTS §6; S05 DT-002; ARCHITECTURE D-15.
- Stable seam / non-test callers: source tree lint diagnostics and filesystem scan failures; pnpm lint CLI.
- Remaining stronger coverage: running lint on compliant files cannot prove detection or refusal of an unreadable tree.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run scripts/check-tokens.test.mjs --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `reports raw UI colors while allowing theme tokens and documented exceptions`

- Detectable failure: raw UI palette/hex colors pass lint or theme exceptions are refused.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `does not silently pass when a source directory cannot be scanned`

- Detectable failure: source scan failure silently reports compliant repository.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `scripts/ffmpeg/lib.test.mjs`

- Independent source: AGENTS §2; ARCHITECTURE D-13; S07 PST-003 pinned vid.stab exception.
- Stable seam / non-test callers: binary/package scan, shipping manifest and real ELF bytes read independently by readelf; ffmpeg packaging/check scripts; apps/desktop/scripts/after-pack.cjs.
- Remaining stronger coverage: packaged E2E proves one valid build; invalid synthetic artifacts and manifest constraints uniquely protect rejection paths.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run scripts/ffmpeg/lib.test.mjs --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `fails on GPL libraries and Remotion compositor packages, passes LGPL ones`

- Detectable failure: GPL/nonfree libraries or bundled Remotion compositor pass distribution guard.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `pins a post-relicense vid.stab commit with its provenance`

- Detectable failure: vid.stab shipping pin loses relicense provenance or source digest.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `pnpm ffmpeg:check reads the record from BUILDINFO.json next to the binaries`

- Detectable failure: BUILDINFO missing/wrong vid.stab commit is accepted.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `passes an app that ships only the complete LGPL directory`

- Detectable failure: complete valid LGPL package is incorrectly rejected.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `fails without the LGPL directory, or when it lacks the notice`

- Detectable failure: absent/incomplete LGPL directory or absent license notice passes packaging guard.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `fails when Remotion's compositor package, an x264 library or a GPL FFmpeg in the asar ships`

- Detectable failure: compositor package, standalone GPL codec or GPL bytes hidden in asar ship.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `checks Electron's own FFmpeg library by its license string, wherever Electron puts it`

- Detectable failure: Electron playback FFmpeg GPL license passes or legitimate LGPL playback library is refused.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `even an LGPL FFmpeg must not sit in a stray location`

- Detectable failure: stray executable bypasses replaceable LGPL directory packaging contract.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `pins every prebuilt download and source tarball with a sha256`

- Detectable failure: download/source/compositor artifact lacks SHA-256 integrity pin.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `rewrites the RPATH of the vendored ffmpeg in place`

- Detectable failure: ELF rewrite leaves loader path unchanged or corrupts binary when replacement exceeds string capacity.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from independent readelf output and unchanged binary bytes on refusal, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `scripts/fixture-encoding.test.mjs`

- Independent source: AGENTS §2.1; ARCHITECTURE D-13 development and LGPL encoding rules.
- Stable seam / non-test callers: fixture encoder selection/refusal API; scripts/make-fixtures.mjs.
- Remaining stronger coverage: real fixture generation only sees installed encoders, not all supported/disallowed availability combinations.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run scripts/fixture-encoding.test.mjs --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `uses OpenH264 in LGPL-only mode even when x264 is available`

- Detectable failure: LGPL-only fixture generation chooses forbidden x264 despite OpenH264 availability.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `uses either supported encoder in development`

- Detectable failure: development fixture generation fails without one of the two allowed available software encoders.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `refuses missing or disallowed encoders before generating any media`

- Detectable failure: missing/disallowed/similarly-named encoder is selected instead of actionable refusal.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## `scripts/third-party-notices.test.mjs`

- Independent source: AGENTS §§2/3/8; S11 FIX-010; licenses/ported/README.md record format.
- Stable seam / non-test callers: dependency closure, attribution record parser and notices artifact/CLI; third-party-notices CLI; desktop packaging and engine license display.
- Remaining stronger coverage: packaging alone cannot prove dependency traversal and multiple accepted attribution syntaxes; --check owns current-artifact completeness.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm exec vitest run scripts/third-party-notices.test.mjs --maxWorkers=1`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### KEEP — `is current (pnpm notices --check)`

- Detectable failure: shipped generated notices diverge from dependencies or port records.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `identifies the licence of every shipped JavaScript package`

- Detectable failure: shipped dependency has neither known license nor supplied license text.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `reads name@version of node_modules sources from Vite and webpack sourcemaps`

- Detectable failure: sourcemap audit overlooks scoped/transitive pnpm package name/version.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `follows dependencies and required peers through workspace packages`

- Detectable failure: production dependency/required peer notice or exact legal text is omitted while dev/optional-only packages leak in.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `adds shipped build output without its dependencies, resolved from a directory or an earlier entry`

- Detectable failure: explicit shipped build output is omitted or unresolved output is silently accepted.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `reads every record except the README, and renders them with the licence texts`

- Detectable failure: ported record legal content/source/path mapping/license text disappears or README ships as a record.
- Change: Keep legal source/path/text contents, remove Markdown table/heading formatting pin.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `accepts the plain forms other records use`

- Detectable failure: documented plain record form loses upstream/license/copyright.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `reads a licence line with extra words and emphasis`

- Detectable failure: legacy emphasized license form loses SPDX expression or upstream URL.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### KEEP — `refuses an incomplete record or a licence without its text, naming the file and the fix`

- Detectable failure: incomplete attribution or missing legal license text silently ships.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `names each copyright line once, with the records it covers (wp fixups)`

- Detectable failure: multiple copyright holders are lost or duplicated in generated license attribution.
- Change: Keep holder preservation/deduplication through parsed legal records and rendered contents; remove exact table/index formatting counts.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### DELETE — `the checked-in notices contain every record of the repository`

- Detectable failure: duplicates --check current-artifact completeness and derives expected records from generator itself.
- Reason / remaining owner: The retained real --check test proves full artifact equality and fails on omitted records (fails bar 3/6).
- Seam/support caller audit: production owner remains used by the callers listed above; remove only now-unused imports/exports. No fixture/snapshot is exclusive to this declaration.

## `e2e/desktop/clipboard.desktop.ts`

- Independent source: S01 CLB-002/010; README clipboard behavior; code-audit-desktop-native.md.
- Stable seam / non-test callers: real OS clipboard between Electron apps, UI paste and public document query; main/preload clipboard IPC and web clipboard paste import handlers.
- Remaining stronger coverage: browser clipboard tests use web DataTransfer; unit guards do not cover X11 clipboard ownership/custom MIME/cross-engine transfers.
- Risk: low for removed bookkeeping/copy assertions; retained security, distribution and process failures remain mandatory. Check: `pnpm e2e:desktop-clipboard`. Desktop TypeScript changes also use `pnpm --filter @jasper/desktop typecheck`; E2E edits use `pnpm e2e:typecheck` and root-scheduled runtime execution.

### REWRITE — `copy in app A, paste in app B through application/x-jasper-clipboard (CLB-002)`

- Detectable failure: custom OS MIME transfer between separate apps or native-menu/browser-keyboard paste loses clip data.
- Change: Remove exact History label and generated filename checks; attach public document JSON as a verifiable per-scenario artifact.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `external text from another app: Ctrl+V adds a text clip (CLB-010)`

- Detectable failure: external OS clipboard text does not become a text clip at playhead.
- Change: Remove exact History label and generated filename checks; attach public document JSON as a verifiable per-scenario artifact.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `external image data: Ctrl+V and Edit ▸ Paste import "Pasted image <time>" (CLB-010)`

- Detectable failure: external OS image bytes do not import/place a still through menu and keyboard.
- Change: Remove exact History label and generated filename checks; attach public document JSON as a verifiable per-scenario artifact.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

### REWRITE — `files copied in a file manager: Edit ▸ Paste and Ctrl+V register them in place and place them (CLB-010)`

- Detectable failure: file-manager OS clipboard paths upload/copy instead of registering in place or do not place clips.
- Change: Remove exact History label and generated filename checks; attach public document JSON as a verifiable per-scenario artifact.
- Bar: **1** the independent group source specifies this input policy/behavior; **2** the failure above is visible in the returned result, diagnostic, native side effect or produced artifact; **3** expected values come from literal authored examples and required protocol/policy outcome, not copied production expressions; **4** observations use the group seam, with external providers only supplying inputs/failures; **5** implementation identifiers, helper structure and scheduling can change while these outcomes remain; **6** this case uniquely exercises the stated failure category at its owning seam; the stronger-coverage comparison above explains why another layer cannot replace it.

## Executable scenarios and support

### REWRITE — `e2e/desktop-smoke.mjs`: desktop launch/Home artifact

- Failure/source: ARCHITECTURE §4.3 requires desktop dev and packaged-like shell to load the shared SPA. Keep rendered Home and project-load completion plus screenshot artifact. Delete compressed-PNG-size >20,000 heuristic and width/height logging dependency: bytes vary with harmless screenshot compression/layout and do not establish a blank editor. Bar 1: desktop requirement; 2: absent rendered Home fails; 3: known ready state, not implementation-derived pixels; 4: actual Electron document; 5: no size/class-tree pin; 6: browser-only tests cannot prove shell/bootstrap wiring. Callers: normal desktop startup. Risk low; check root-scheduled `pnpm e2e:desktop`.

### KEEP — `e2e/desktop-smoke.mjs`: cookie/editor authentication and hostile IPC

- Failure/source: security-review.md AGT-2/MG-1 requires app requests/editor connection to authenticate while scripts cannot read secrets and foreign documents cannot invoke IPC. Bar 1: those security rules; 2: wrong HTTP status/editor flag/IPC result fails; 3: explicit 200/401/true/false/null protocol expectations; 4: real desktop cookies, WebSocket and IPC; 5: no main helper identifier assertion; 6: helper-policy tests do not prove production handler registration/cookie flags. Artifacts: desktop-<mode>-auth.json and -ipc.json. Risk security-sensitive; check root-scheduled `pnpm e2e:desktop`.

### KEEP — `e2e/mg-fallback-check.mjs`: native availability versus missing-binary fallback

- Failure/source: ARCHITECTURE §10.2 fallback requires actual startup discovery to select native for available binary and explain Remotion fallback when missing. Bar 1: stated fallback; 2: wrong capability/plan or missing reason fails; 3: fixed route expectations, never recomputed planner algorithm; 4: built engine HTTP calls with real native discovery; 5: implementation names free to change; 6: synthetic planner capabilities cannot prove discovery-to-planner composition in built artifact. Artifact: e2e-mg-fallback.json. Production callers: capabilities/export-plan routes. Check root-scheduled `pnpm e2e:mg-fallback`.

### KEEP — `e2e/packaged-lgpl-check.mjs`: packaged license, isolation and Remotion export

- Failure/source: AGENTS §2 and ARCHITECTURE D-13 prohibit GPL/nonfree distribution and require replaceable shipped LGPL tools. Bar 1: explicit distribution contract; 2: prohibited artifact, missing legal notice, PATH fallback or unplayable/wrong-length H.264 export fails; 3: fixed licensing/protocol expectations plus independent packaged ffprobe; 4: copied package outside checkout, poisoned PATH, real HTTP and output bytes; 5: no private algorithm pin; 6: synthetic guards and repository runtime cannot prove installer independence. Artifacts: e2e-packaged-lgpl.mp4/.json. Callers: shipped engine tool discovery/Remotion export. Check root-scheduled `pnpm e2e:packaged` after package build.

### KEEP support — launcher and shared helpers

- `e2e/desktop-clipboard.mjs` prepares current builds, fixtures and Xvfb then invokes actual `e2e/desktop/clipboard.desktop.ts` scenarios; it contains no independent test declaration.
- `e2e/desktop/clipboard-helper.cjs` supplies real OS clipboard text/image/file-list input and retains X11 ownership; all three modes remain used by retained scenarios.
- `e2e/support.ts` inspected in full. Every exported helper currently has E2E consumers: ROOT, FIXTURES, serverInfo, enableAgentBridge, query, transact, expectTransaction, clips, appliedLabels, playheadFrame, sequenceSummary, createProject, importFiles, mediaIdForFile, timelineArea, trackRow, clipElement, clipBox, pointerDrag, focusTimeline, programPixels, ffprobe, waitForJob, exportViaUi, regionLuma. Root will repeat caller census after other E2E deletions integrate. No support-only test seam is kept merely for coverage.

## Production seams and dead support removed

- `apps/desktop/src/engine-process.ts` `readyTimeoutMs`: repository search finds only `main.ts` production call (does not pass it) and timeout test use. Replace with same existing 30,000 ms production timeout; tests advance fake clock.
- `scripts/check-assets.mjs` exported `template`, `isAsset` and `checkRepo`: no non-test external import; template/classifier remain internally needed by `findProblems`, and checkRepo by the CLI, so make these private after tests observe actual diagnostics.
- `native/mg/crates/jasper-mg-cli/src/main.rs` writer parameter to `write_output`: all production calls pass stdout().lock(); rewrite output regression at executable pipe and let helper own stdout. Stream reader generic remains needed for both file and stdin in production.
- Removed deleted declarations' imports, the single-use preload bridge test helper/setup, clipboard generated-name helper, and screenshot header/size reading. No committed fixtures, snapshots or attribution assets become unused.

Pre-edit declaration dispositions: {'REWRITE': 24, 'KEEP': 90, 'DELETE': 6}. Parameterized IPC rows cover 3 and 4 runtime cases respectively. Executable scenario/support entries above are separate from that declaration count.

## Validation and final diff

- Completed: `pnpm install --frozen-lockfile --offline` (no dependency changes); `cargo fmt --manifest-path native/mg/Cargo.toml --all`; scoped Biome formatting; `git diff --check`; final source/test diff review.
- Initial attempted focused Vitest command did not run: fresh worktree lacked dependencies (`vitest` not found). This is not a passed or failed test result. No retained assertion has failed in this worktree.
- The root coordinator paused new tests/typechecks/rendering while its full unchanged baseline and lint ran on the shared host (16 cores, reported load 110). Per that instruction, focused Vitest, desktop typecheck, E2E typecheck, cargo tests and desktop/packaged runtime checks are explicitly **pending integrated validation**, not claimed as passed.
- Required focused command: `pnpm exec vitest run scripts/check-anime.test.mjs scripts/check-assets.test.mjs scripts/check-cycles.test.mjs scripts/check-layers.test.mjs scripts/check-tokens.test.mjs scripts/ffmpeg/lib.test.mjs scripts/fixture-encoding.test.mjs scripts/third-party-notices.test.mjs apps/desktop/test --maxWorkers=1`.
- Required native command: `cargo test --workspace --manifest-path native/mg/Cargo.toml -j 1`; limit Rust test threads as needed on the shared host. Native checks are outside the default pnpm test gate.
- Browser/desktop scenarios require fresh engine/web/native/package build outputs and are scheduled by root. No browser, desktop or engine process was started by this worktree.
- Six original declarations deleted; three private Rust declarations moved/merged into two new executable-level declarations plus the existing thread-environment declaration. Final declaration count decreases by seven. All 120 original declarations have dispositions above; helpers and standalone executable scenarios are accounted separately.
- No coverage/test-count gate conflict observed. No stale path to a deleted test file was introduced (files remain). The code-audit native/desktop note remains historical evidence, while this report records the changed verification seams.

## Follow-up: executable performance gates outside named-test discovery

This inventory was recorded before the five benchmark assertion removals below. It covers all six micro targets launched by `scripts/performance.mjs`, its editor/export/UI gates, `scripts/perf/ui-run.ts`, and the `scripts/mcp-qa.mjs` launcher. These are separate from the 120 original test declarations above. No benchmark was executed during this follow-up; shared-host validation remains coordinated by root.

### DELETE — benchmark correctness assertions; preserve measurements

| Path and executable assertion | Failure it could detect / why DELETE | Remaining stronger behavior coverage | Production seam and non-test callers | Risk / validation |
|---|---|---|---|---|
| `packages/project/bench/render-snapshot.ts`: optional baseline/current `deepStrictEqual` | Any difference from a manually supplied old implementation, including an intended behavior change; expected snapshot comes from production code. Fails bars 1/3/6. | `packages/project/test/render.test.ts` authored track ordering, muted output, timed opacity and export-range cases; feature-specific snapshot contracts. | `buildRenderSnapshot` is the package API consumed by Program preview, engine export and agent queries; neither the benchmark's optional baseline import nor its equality assertion is a production caller. | Low; keep both timing variants and hash/checksum measurements. Check project typecheck and diff; no benchmark needed for an assertion deletion. |
| `packages/project/bench/scene-props.ts`: every resolved layer equals `resolveLayerProps(clip, clipContentTime(...))` | Disagreement between production functions, with the expected result calculated using the same production property/time implementation. Fails bar 3 and duplicates the semantic owner. | `packages/project/test/render.test.ts` independently expects 50% opacity halfway through an authored 0→100 animation, 100% afterward, and correct visible-layer order; keyframe/feature suites own the other property semantics. | `resolveSceneAt` is consumed by `packages/project/src/agent/{queries,properties-query}.ts` and `apps/web/src/mg-bundles/CanvasTextEditor.tsx`; property/time helpers remain production-used. | Low; remove only equality and now-unused imports. Preserve fixture variants, all sampled frames, hash and timing loop. Check project typecheck and diff. |
| `packages/session/bench/selection.ts`: each timed call must return the identical selection object | Pins an allocation choice at every benchmark iteration; the underlying requirement is preserving selected entities and avoiding unnecessary work, not this helper object's identity. Fails bars 1/5/6. | `packages/session/test/session.test.ts` SEL-002/004 observes surviving/deleted selection through the session; selection pruning cases own missing IDs. The documented command/gesture budgets own caller latency. | `filterSelection` is called by `EditorSession.apply`, replacement and history restoration; `session.ts` currently uses identity to avoid a `selection.changed` event, but callers can preserve event semantics through another implementation. | Low; keep every filtering invocation and alternating baseline/current timing. Check session typecheck and diff. |
| `apps/web/bench/timeline-transitions.ts`: aggregate baseline/current checksum equality | An optional old implementation is the oracle; a sum can also conceal different incorrect hits. Fails bars 1/3/6. With no baseline the comparison is tautological. | `apps/web/test/transitions-timeline.test.ts` authored selection, snap, alignment, cancellation and drop contracts; indexed-query regression cases own overlap/movement behavior. | `transitionIndex`/`transitionsInRange`/`hitTransition` serve `TimelinePanel.tsx` drawing and input. Optional baseline modules are measurement inputs only. | Low; preserve checksum output, sampled viewport/hit operations and baseline comparison measurements. Check web typecheck and diff. |
| `apps/engine/bench/cache-references.ts`: aggregate reference count equals entry count | Coarse fixture cardinality duplicates cache ownership checks and can pass if references are assigned to the wrong project. Fails bars 2/6 for ownership safety. | `apps/engine/test/cache.test.ts` CA-013 usage and CA-014 cleaning explicitly protect saved/open project entries; reference-index namespace/mutation cases check actual project IDs. | `indexProjectCacheRefs` is used by `apps/engine/src/cache/service.ts` to classify saved/live/recorded references. Its benchmark baseline remains an optional before/after measurement. | Low; keep all lookups and report the observed count, remove assertion/import. Check engine typecheck and diff. |

No production seam, shared fixture or helper becomes dead from these removals. Optional baseline imports remain useful measurement features; they no longer impose an implementation-derived correctness oracle.

### KEEP — `scripts/performance.mjs` documented runtime budgets

Independent sources are `docs/performance.md` §1/§3, `docs/wp-notes/previews.md` §7, `docs/wp-notes/ui-perf.md` and `docs/wp-notes/polish.md` §5. `package.json` exposes this runner as `pnpm perf`. Reports are `test-results/performance/<label>.json` and `.md`, including machine, load, measurements and budget outcomes. `scripts/perf/ui-run.ts` emits measurements and budget metadata; the outer runner enforces them. Running `ui-run.ts` alone does not enforce thresholds.

The following six-bar justification applies to each distinct row, with its exact behavior, failure and observation identified in that row: **1** the cited performance documentation independently names the workload and target; **2** the row's slow or stalled user operation produces a missed budget; **3** its authored threshold is not calculated from the implementation result (strict mode uses the literal documented target); **4** measurements observe the built application's playback/HTTP/Chrome-trace seam; **5** helper names, component structure and algorithms can change without changing the workload and elapsed-time contract; **6** no model/unit test can observe this combined browser/decoder/engine cost, and each row targets a distinct operation or cost. The E2E owner confirmed `e2e/ui-perf.spec.ts` and the duplicate `e2e/polish.spec.ts` open-budget case are deleted; they therefore do not retain an extra owner for these UI budgets. The retained previews seek/play-cycle regression covers a different stall trigger from the sustained playback workloads here.

| Disposition / executable scenario | Independent target / recognizable failure | Stable observation and production caller |
|---|---|---|
| KEEP — single 1080p H.264 playback | `docs/performance.md` §1: ≥90% of 30fps (27fps); normal single-clip playback becomes visibly too slow. | Program playback counters over elapsed real playback; normal Program monitor. |
| KEEP — GPU effects after requesting render previews | Same source: ≥27fps; rendered-effect playback remains too slow for editing. | Program counters after the real preview-render request; Program preview playback. See the prerequisite limitation below. |
| KEEP — watchdog recoveries across the six playback workloads | Same source: zero; sustained single, layered, blended, adjustment or effect playback requires freeze recovery. | Public performance counter delta during actual playback; playback driver watchdog and `perf_stats` surface. |
| KEEP — native H.264 export throughput | Same source: ≥30fps at 1080p30; export falls below real time. | `/api/exports` terminal job frame/time report; normal Export workflow. |
| KEEP — smart-copy H.264 throughput, when copy is selected | Same source: ≥120fps (4×30fps); an actual copy export becomes slower than its stated target. | Terminal export job report with `renderPath: copy`; smart export. This conditional gate does not assert planner selection. |
| KEEP — drag 11 clips among 1,000: mean frame work | `docs/performance.md` §1 / `ui-perf.md`: ≤16ms; moving a selected group blocks main-thread frames. | Chrome trace during actual pointer drag; timeline gesture UI. |
| KEEP — same 30-move drag: elapsed wall time | Same source: ≤1,500ms; the whole gesture is delayed even if per-frame work stays below its limit. | Actual drag start/end elapsed time; timeline input processing. |
| KEEP — scroll a 5,000-clip timeline | Same source: ≥50fps; scrolling stalls on the large timeline. | Chrome frame trace during wheel input; timeline viewport. |
| KEEP — zoom a 5,000-clip timeline | Same source: ≥50fps; zooming stalls independently of scrolling. | Chrome frame trace during zoom input; timeline viewport. |
| KEEP — open a 2,000-item project | `docs/performance.md` §1 / `polish.md` §5: ≤2,000ms to interactive editor with media resolved; large projects open too slowly. | Median of three real cold opens through `measureOpen`; project loading/status resolution. |
| KEEP — scroll a 2,000-item Project panel | `docs/performance.md` §1 / `ui-perf.md`: ≥50fps; bin navigation stalls. | Chrome frame trace during panel scroll; Project panel. |

Risk is environment sensitivity, already explicit in the documented policy: `PERF=1` enforces literal targets; otherwise the outer runner records load-scaled misses without failing for its own budget rows. UI load scaling is squared because it involves another process. Required runtime commands, when root schedules a quiet machine and current builds, are `PERF=1 pnpm perf --sections editor`, `PERF=1 pnpm perf --sections export`, and `PERF=1 pnpm perf --sections ui`. No pass is claimed here.

Limits of this retained performance evidence: the GPU scenario records `previewsRendered: false` if its ready-state wait times out and still measures playback; it therefore proves only throughput after requesting previews, not successful preview generation/use. Smart-copy throughput is checked only when the job reports `copy`. Export throughput uses reported job frames/time and does not independently decode output. UI subset runs only evaluate budgets for emitted metrics. Functional preview, planner, export/fidelity and editing tests remain the correctness owners; none of these performance measurements is cited as a substitute for them.

### KEEP — `packages/session/bench/scale.ts` operation budgets

Independent source: `docs/testing.md` §6 expressly requires load, migration, invariants, small/large edits, undo/redo, snapshots, scene and autosave budgets on a 200-sequence, approximately 5,000-clip mixed-feature project; `docs/ARCHITECTURE.md` §13 establishes responsive editing as the product contract. The benchmark's explicit reference-machine thresholds configure that documented gate. Its real commands create footage, titles, solids, shapes, effects, keyframes, transitions and markers. Production consumers use these APIs for project open, session transactions/history, preview/export inputs and saves.

For every row: **1** the independently documented scale workload and budget policy names the operation; **2** exceeding its configured time limit represents the slow user operation in the row; **3** elapsed time is compared with an authored threshold, never an expected value generated by the operation; **4** the operation is invoked through its owning package/session API; **5** timing does not pin a helper, call count, object identity or algorithm; **6** smaller command/scene budget tests do not exercise this mixed-feature, many-sequence document, and no browser layer is needed to measure these synchronous costs. The one-sequence and all-sequences snapshot rows protect distinct interactive versus aggregate costs. Each row retains its own failure signal below.

| Disposition / operation | Configured reference-machine budget | Failure visible to a caller / observed owning seam |
|---|---|---|
| KEEP — load | 2,500ms | Slow open of the scale project; `JSON.parse` plus `loadProject`. |
| KEEP — migrate v1→current | 1,500ms | Slow opening of an older-schema large project; `migrate`. |
| KEEP — invariants | 600ms | Validation delays transactions on the large document; `checkInvariants`. |
| KEEP — small edit | 250ms | Changing one clip's opacity stalls despite a small edit; `EditorSession.apply`. |
| KEEP — large edit | 2,000ms | One 300-clip edit stalls; `EditorSession.apply`. |
| KEEP — undo | 50ms | Undo responds slowly after an edit; `EditorSession.undo`. |
| KEEP — redo | 50ms | Redo responds slowly after undo; `EditorSession.redo`. |
| KEEP — render snapshot | 40ms | Preparing the visible sequence delays preview; `buildRenderSnapshot`. |
| KEEP — render snapshots ×200 | 3,000ms | Preparing all sequences scales excessively; repeated public snapshot API. |
| KEEP — scene at a frame | 5ms | Resolving one frame delays playback; `resolveSceneAt`. |
| KEEP — autosave serialise | 1,200ms | Saving blocks the editor thread; `makeEnvelope` plus JSON serialization. |

The script records warm-run medians, p95, CPU times, workload, revision, machine and load in `packages/session/bench/scale.results.json` for the full fixture; smaller `SCALE_SEQUENCES` runs do not write that artifact. It fails on missed load-scaled budgets unless `JASPER_PERF_NO_BUDGET=1`; `PERF=1` uses literal limits. Unlike the outer runner's non-strict rows, this micro target normally exits nonzero on misses. Risk is host/load sensitivity, not a reason to alter thresholds. Validation when scheduled: `PERF=1 pnpm exec tsx packages/session/bench/scale.ts`. No execution or result update occurred here. These are latency checks, not validation of returned documents/commands; functional persistence, migration and session suites own those outcomes.

### Measurement-only exclusions and launch/support inventory

- `render-snapshot.ts`: full/range builds at 40, 1,600 and 4,800 clips; `scene-props.ts`: five layer/grade/animation workloads; `selection.ts`: three document sizes/distributions × empty/one/all selections; `timeline-transitions.ts`: 100/1,000/10,000 transition build/range/hit measurements; `cache-references.ts`: 30/300 projects ×100 entries. After the five assertion removals above they collect time/CPU/hash/checksum/count measurements without a pass/fail threshold. These are measurement tools, not surviving assertion-free tests and not correctness owners.
- Editor three-layer, blend, adjustment and live-effect fps, dropped frames, UI fps, render-bar state and preview-render time are telemetry, not separate assertions. All six editor workloads still feed the single watchdog gate listed above. Native ProRes export and preview-render throughput have no budget gate.
- `ui-run.ts` trim, playhead scrub, selection and Effect Controls scrub publish trace metrics without thresholds; drag/open bookkeeping and status-request counts are telemetry. `ui-scenarios.ts`, `ui-fixtures.ts`, `open-phases.ts` and `budget.ts` provide input generation, real UI actions, phase/trace measurement and host calibration. Missing fixture/trace/input failures abort measurement rather than assert a private collaborator shape. Their real benchmark consumers remain.
- `scripts/mcp-qa.mjs` only launches `apps/mcp/test/qa` with `MCP_QA=1` and forwards its exit code; the MCP owner's named-test ledger accounts for its assertions. No extra scenario is hidden in this launcher.

Follow-up completion: five assertion families removed across the five measurement-only microbenchmarks; their loops, fixtures, timing variants and reported measurements remain. Snapshot hashes now describe each measured variant instead of reusing the current implementation's hash for both; cache lookup count is telemetry. No production code changed. Scoped Biome formatting and `git diff --check` passed, and the final code/report diff was reviewed. Benchmark execution and affected package typechecks remain pending root's integrated validation schedule.

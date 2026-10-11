# Web commands, shell, runtime and agent bridge audit

## Assessment

The audited area is `apps/web/src` application entry points, commands, shell, state, runtime, home, agent bridge, PWA and internationalization, plus web build tooling. Feature panels and domain implementations are reviewed separately.

The project and session packages already expose the authoritative `Command`, `TransactionResult`, `SessionTxInput` and clip union types. Several UI command modules discard those types with `unknown[]`, `never[]` and structural assertions. These assertions prevent the compiler from finding invalid command fields and duplicate the model's type definitions. Internally constructed transactions should use those exported types. Untrusted command arguments, JSON, persisted settings, WebSocket messages and caught exceptions must remain unknown until validated; replacing those boundaries with assertions would reduce safety.

Caption, multicamera, time, structure and timeline commands independently resolve the same selected sequence and transport context. They also repeat clip selection and transaction error reporting. A shared sequence context can remove repetition without coupling these modules to the much larger timeline command registry. Feature-specific selection, warning and empty-transaction behavior must remain explicit.

The shell save indicator casts a typed session store through an untyped surrogate. The panel-service registry similarly erases the relationship between a service name and its service value. Build configuration casts both Vite proxy objects and Rollup bundles despite their structural compatibility with the helper interfaces. These internal type erasures are unnecessary.

Most catches are meaningful boundaries: browser storage can reject reads and writes; fetches, fullscreen, clipboard and native APIs can reject; malformed saved layouts and keymaps require conservative recovery; command and panel extension callbacks must not crash the application. Removing these indiscriminately would violate the no-crash rule. Silent failure after a user action deserves separate scrutiny, especially save/leave operations and background bundle rebuilds. Recovery and schema compatibility are supported behavior, not dead code.

Comments frequently carry workstream names, specification IDs, changelog prose and section banners. Remove comments that merely describe declarations or historical ownership; retain security invariants, browser constraints, transaction semantics and protocol details. Existing licensing and attribution comments remain untouched.

## High-confidence changes

- Consolidate repeated sequence command context and clip selection.
- Use model/session command types for internal transactions and replace avoidable clip/store assertions with narrowing.
- Preserve validation at all external boundaries and actionable failure reporting.
- Remove unnecessary casts in application/build wiring and redundant checks already established by types.
- Delete no-op and historical comments in the audited modules while keeping rationale and invariants.

## Verification

Focused command, shell, persistence, agent security, internationalization and build-helper tests will run with one worker. The web TypeScript check and targeted Biome checks cover integration with domain types. Measured commands and results are recorded below after implementation.

## Implemented findings

- Sequence context and selection now have a shared leaf module. Structure, multicamera and time commands also share typed transaction reporting; caption and timeline retain their different warning and sync-conflict behavior.
- Internal command arrays use the project command union or `SessionTxInput['commands']`. Clip narrowing replaces ad hoc media, volume, remap and 3D interfaces. The panel service registry preserves service-name/value relationships; the save indicator subscribes directly to the session store.
- Web runtime declarations now reuse the desktop preload contract from `@jasper/api`. The unused native-menu subscription was removed after confirming no IPC sender exists. Native screenshot refusal returns an actionable automation error. The in-page agent API is a type-only leaf shared with E2E consumers.
- Motion-template upgrade functions moved into `panels/motionTemplates/upgrades.ts`, removing the command-registration/component import cycle. Existing command exports remain available to callers.
- Vite proxy configuration and bundle metadata retain their structural types. Internationalization preset extraction accesses typed project exports instead of a fabricated dictionary.
- Command pre-run hooks and argument transforms now execute inside the command error boundary. Regression tests cover both exception paths.
- Connecting to another engine refuses navigation when saving fails or leaves the document dirty. Restoring a version likewise refuses to replace unsaved work. Recovery retains the original journal until the recovered document is saved. Regression tests cover rejected saves and flushes that resolve while changes remain unsaved.
- The composition context menu reports rebuild failures instead of swallowing them. Redundant catches around static, supported media-query calls were removed. Storage, network, native API, migration and extension boundaries remain guarded.
- Historical command inventories, ownership notes, section banners and redundant declarations were removed. No migrations, persisted formats, assets, approvals or project compatibility paths were removed.

## Validation record

- Targeted Biome checks pass, including the new shared modules and regression tests.
- `node scripts/i18n.mjs --check`: passes; Spanish covers all 8,614 extracted strings.
- The first focused test run encountered host-load timeouts and was stopped before completion. A second run uses one worker and a 60-second test/hook timeout; assertions and Testing Library deadlines are unchanged. Results are recorded in the follow-up verification update.
- The web typecheck was stopped at the integrator's request to reduce concurrent compiler load. The integrator runs the final serialized typecheck against all audit changes together.

## Recovery listing follow-up

The recovery store now returns healthy candidates together with individual journal warnings. The previous web adapter assumed an array and would fail before presenting any recovery options. Both automatic and manual recovery entry points now preserve the shared response, display warnings, and continue offering healthy candidates. A warnings-only response opens the dialog without recover/discard actions, so damaged files remain available for repair. Regression tests cover both mixed and warnings-only responses.

The follow-up also removes the remaining internal `as never` assertions in agent capture and coordinate lookup. Coordinate lookup uses overloads for its two declared locator kinds. The WebSocket close call uses a valid constant code and a short constant reason, so its empty catch served no error-handling role. Additional historical ownership notes and redundant section comments were removed.

- Follow-up Biome check: 72 files, no fixes needed.
- Translation coverage check: Spanish covers all 8,615 extracted strings.
- The second broad focused test run was stopped after 16 minutes without advancing beyond three files under severe host load. Its two Escape failures used the pre-fix import cache; `activeTimeline` is imported in the committed code. A six-file focused rerun covers recovery, command boundaries, UI automation, timeline commands, trim mode, and template upgrades. Final results follow separately.

A final boundary review found that fullscreen entry failures were swallowed and fullscreen exit failures escaped the command runner. Both promises are now awaited by the existing command boundary, which reports browser refusal through its error toast. The registry regression asserts that refusal is observable. Model-backed shape commands and bundled JSON catalogues no longer use unnecessary assertions.

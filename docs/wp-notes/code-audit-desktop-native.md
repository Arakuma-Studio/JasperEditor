# Code audit: desktop, native motion graphics, shared configuration

Scope: `apps/desktop`, `native/mg`, and `packages/config`. Reviewed all source and build scripts, package boundaries, the desktop bridge consumers, engine runtime writer/discovery readers, and existing tests. The assessment follows AGENTS.md, architecture §§3.1/4.3/10.2/12, and the installed Electron 44 declarations. No reference assets or third-party implementation code were used.

## Findings and implemented recommendations

| Finding | Assessment and implementation |
| --- | --- |
| Desktop and engine duplicated their OS-open extension allowlist and matcher. | Security-sensitive copies could drift. Desktop now calls `@jasper/config.isOpenableFile`; the existing absolute-path guard remains at IPC entry. Desktop also uses shared host, development port, and product-name constants. |
| Preload and browser maintained separate bridge types. | `@jasper/api` now owns the platform-neutral contract, coordinated with the API/browser audit. Preload uses it directly. Nullable capture/MCP replies match the main-process handlers. Desktop imports these types only; no browser code imports Node configuration. |
| `onMenuCommand` was an inert bridge subscription. | A repository-wide search found no emitter. The preload listener and browser subscription are removed together. Native application-menu roles and in-app commands remain separate working paths. |
| Electron callbacks asserted types already described by installed declarations. | Permission requests narrow their actual union; permission checks read the declared media type; clipboard data uses Electron's conditional return type and a Blob discriminator. Clipboard and capture input guards narrow fields without record/number assertions. |
| Clipboard iteration caught every entry exception, silently. | Entries are checked for the requested format before reading. Genuine OS-read failures reach the existing operation-level logger; file-list reads retain successfully read entries. Microphone permission failures are logged before denial. |
| Engine-ready messages asserted an unchecked port, and shutdown retained a five-second timer after exit. | A shared schema validates the message before constructing an origin. Readiness listeners are detached on success/failure; shutdown clears the timer after either outcome. |
| Runtime discovery asserted a partial structure and admitted invalid URLs, fractional/nonfinite ports, and invalid PIDs. | Schema validation produces the shared runtime type. Invalid field types are refused. Missing informational fields retain explicit defaults because sparse runtime files are supported by existing discovery consumers/tests. |
| Startup outside the engine-launch block and window-load promises could reject without an error boundary. | Startup has one error-reporting boundary that uses ordinary shutdown, so an engine already started is stopped. Load failures produce a dialog and reveal the window. Closed windows are excluded from that reporting path. External-link failures are logged. |
| Native template validators duplicated RGBA and text-length rules. | Both templates use private shared validators; messages, Unicode character counting, ranges, and rendered markup remain unchanged. |
| Native spec reads allocated until EOF. | Both file and stdin reads stop at 1 MiB plus one byte and return `INVALID_SPEC` when oversized. The accepted templates have tightly bounded fields, substantially below this cap. |
| Malformed native thread settings silently selected/clamped another count. | Explicit thread counts and `JASPER_MG_THREADS` must be integers in 1–64. Invalid settings return `INVALID_SPEC`. CPU-count discovery remains the default only when no setting exists. |
| A bounded renderer channel fed an unbounded frame-reordering map. | Each worker now has a rendezvous channel consumed in frame order. A slow frame blocks ahead-of-time production instead of retaining the rest of the video. Worker creation errors and joined worker panics become `RENDER_FAILED`; all workers are joined after receivers are dropped. |
| Textual native stdout used panic-on-error macros. | Version/schema/SVG writes now return an ordinary CLI error on output failure, matching the raw-frame path. |
| Historical comments and obvious section labels obscured code. | Removed work-package narration, dead-list synchronization comments, obvious packaging section labels, and duplicated bridge annotations. Retained licensing, sandboxing, file-format, rendering parity, units, and lifecycle constraints. |

## Deliberately retained boundaries

`unknown` remains only where values cross JSON/IPC/native boundaries; replacing it with an assertion would weaken safety. Rust's `serde_json::Value` remains appropriate for JSON Schema documents and template parameters before typed deserialization. Template defaults, CPU-count fallback, URL/URI parsing catches, preload file-path refusal, and clipboard operation catches have concrete compatibility or external-input roles.

Rust and TypeScript render templates remain distinct language implementations. Sharing their mathematical concepts through a generated renderer would be a larger design change; existing native parity tests guard their wire formats and SVG output. Rust compile-time media staging failures stop the build intentionally. Constant template-default serialization assertions are not controlled by input.

The reviewed module dependencies are acyclic: desktop → config plus API types; Rust CLI → templates → core. No migration, project schema, rendering formula, FFmpeg policy, or licensed asset changed.

## Verification

- Measured: desktop/config Vitest suites passed, 27 tests across four files (`pnpm exec vitest run apps/desktop/test packages/config/test --maxWorkers=1`). Includes arbitrary-JSON runtime parsing, malformed ports/PIDs/URLs, subprocess readiness/exit/timeouts, invalid startup URLs, and rejected window loads.
- Measured: desktop main/preload bundle build passed (`node apps/desktop/scripts/build-main.mjs`).
- Measured: Biome for edited TypeScript/scripts and `node scripts/check-assets.mjs` passed.
- Pending at this commit: native workspace tests (cargo compilation running with one build job) and native/TypeScript parity checks.

Typechecking is delegated to the serialized integration gate to avoid competing whole-workspace TypeScript processes. macOS/Windows system clipboard/permission dialogs and installer signing were inspected through their contracts, not exercised on this Linux host.

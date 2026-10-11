# MCP code-quality audit

## Scope and evidence

Reviewed `apps/mcp`: the stdio and command-line entry points, discovery and HTTP request safety,
strict SDK registration, document/transaction/job helpers, PNG contact sheets, every tool module's
imports and shared argument declarations, and the corresponding tests. Research used the current
`@modelcontextprotocol/sdk` declaration files (`server/mcp.d.ts`), Zod's installed clone API,
`packages/api` schemas, the project command/model types and existing MCP work notes. No dependency
or tool name changed.

The local static import graph contained two cycles: editing → animation → templates → editing,
and editing → transitions → editing. Both came from argument constants owned by the editing tool
module. A traversal of all 58 resulting MCP source modules reports zero local import cycles.

## Assessment and changes

- **Shared ownership:** project ids, the ordinary optional sequence id, and time arguments belonged
  below tool registration modules. `arguments.ts` now owns them. Tool-specific sequence semantics
  remain local, including grading's preference for a clip's sequence. This removes both cycles and
  repeated schemas without changing the advertised argument contracts.
- **Document envelopes:** tools repeatedly assembled the same platform, revision and timestamp
  metadata, often casting the result to `never`. `toolEnvelope` provides the shared API
  `EnvelopeJson` return type; audio, grading, exports, previews, interchange, speech, copies and
  capture use it. Revision defaults and copy revision increments are preserved.
- **Sequence failures:** several tool modules wrapped the same selector in identical catches merely
  to attach `E_NOT_FOUND`. `pickSequence` now produces that actionable `ToolError` itself. Its
  callers share one implementation and no longer need those catches.
- **Types:** strict input construction retains the raw shape generic through SDK registration,
  removing casts that disabled callback checking. Zod schema copies use its declared `clone`
  method. Progress parameters derive from the SDK notification type; transaction success views
  derive from the API result type. Audio callbacks use `Extra`, processing uses `ProcessStep` and
  `VideoClip`, and composition measurements use the engine response type. Media registration
  preserves its command discriminant. CLI query names are checked against the shared query enum.
- **Measurement contracts:** the engine response previously checked only a text measurement's id
  and found flag, leaving layout consumers to trust unknown fields. The project measurement type
  now derives from a shared schema used by the API response. It validates the complete probe
  output, including finite rectangle and style values, while preserving nullable layout for
  missing or invisible text. SDK registration explicitly names its schema input generic; Zod
  clone definitions retain the installed library's discriminator union.
- **Error transparency:** processing can finish its transaction and then fail to reload the updated
  document. It now returns the committed transaction together with an explicit `refreshError`
  instead of silently omitting the source range. The message tells callers the edit was applied
  and to reread before retrying, avoiding an ambiguous failed edit response.
- **Input/resource safety:** PNG input previously trusted chunk sizes and dimensions and inflated
  compressed data without an output bound. Header/chunk/end validation and a 16,777,216-pixel
  ceiling now bound decoding, encoding and grid allocations. Inflation is limited to exactly the
  declared raster byte count. The limit leaves room above the 2048-pixel contact-sheet target.
  Engine discovery also handles promises rejected with a non-`Error` value; a rejected health
  probe cannot throw again while attempting to read `.name` from null or undefined. Engine
  subprocess spawn errors reject startup instead of escaping as unhandled events.
- **Comments:** removed workstream/history headers, section dividers and guide comments that simply
  repeated names or registration structure. Protocol, annotation, retry, licensing and format
  constraints remain documented.

## Deliberately retained boundaries

`unknown` remains appropriate for MCP arguments before validation, thrown values, JSON Schema
metadata, heterogeneous job results and command payloads validated by the engine. Replacing these
with unchecked concrete assertions would weaken safety. The SDK's private validation hook still
requires one explicit structural adaptation; its existence is checked at startup and strictness is
covered by protocol tests.

Discovery alternatives are supported installation modes, not dead implementations. Transaction
sequence retry follows an explicit refusal that applied nothing; HTTP retries remain restricted
so a disconnected write cannot be applied twice. Shutdown/cancellation catches protect cleanup
when transports or jobs have already disappeared. Optional render diagnostics report their status.
These paths have specific roles and were retained. No unimplemented feature was presented as
complete and no project migration or compatibility format was removed.

The relink result casts were removed in coordination with the contracts audit, which validates
`RegisteredMediaSchema` in both relink response contracts. Integrate that contracts change with this
branch.

## Verification

- Biome and `git diff --check` passed for the edited source and tests.
- The focused run covered unit/discovery, conventions, PNG, default-sequence, audio effects,
  templates, formatting and README tool coverage: 50 of 51 tests passed initially. Its only
  failure was the pre-existing progress test's wall-clock scheduling assumption. The virtual-time
  replacement and the PNG/child-spawn suites then passed all 19 tests. Across those runs, all
  52 distinct tests in nine files passed. Runs used `pnpm vitest run <files> --maxWorkers=1`.
- PNG regressions cover malformed/truncated chunks, decompression beyond the declared raster,
  oversized dimensions and invalid grids; fast-check supplies 200 arbitrary byte inputs. Existing
  independent PNG protocol vectors remain in place. Discovery regressions exercise non-Error
  promise rejections and subprocess startup failures.
- The progress throttle test now asserts exact notification times and values using virtual timers.
  CLI argument parsing also passed both tests (`pnpm vitest run apps/mcp/test/jasper-cli.test.ts
  --maxWorkers=1 -t "argument parsing"`); an unknown query produces a usage error before engine
  discovery. The five real-engine CLI cases were excluded from this focused run.
- Full typechecking and the integration gate are delegated to the integrator's serialized run;
  parallel local typechecks were stopped to relieve host contention. Real-engine processing,
  render/export and CLI integration suites are part of that final gate.
- Measurement contract regressions cover complete probe output, absent/invisible text, malformed
  layouts and styles, non-finite numbers, and 200 generated finite rectangles. All 11 passed with
  `pnpm exec vitest run test/mg-measurement-contract.test.ts --maxWorkers=1` from `packages/api`.

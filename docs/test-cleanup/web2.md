# Web shard 2 test cleanup

Pre-edit audit of all 34 assigned files. Every named test below was classified before changing tests or source. Parameterized names represent all their rows; the platform/runtime keymap family represents all six combinations. No assertion-count or coverage threshold is used to retain a test.

The numerical Program/timeline tests retained below cover explicitly specified editing transformations and buffer/media protocols, not incidental CSS geometry. Stubbed HTTP/Player ports supply external events; assertions concern real adapter/session outputs. Their isolated failure modes are missing/wrong request bytes, wrong frame/time mapping, premature/duplicate mutation, failed cancellation, bad bounds, stale results, wrong selection, or lost error state, as identified by each test name.

For each retained row, B1 is the independent requirement; B2 is the concrete failure named by the scenario; B3 describes the independent oracle; B4 names the production seam; B5 explains refactor stability; B6 identifies the lower owner boundary and why other coverage does not replace it.

## 1. REWRITE: `apps/web/test/agent-ui-guard.test.tsx` — are marked as the agent’s; the editor’s own housekeeping never is

- Failure detected / B2: A renamed or missing wire header can bypass the engine approval gate even when client and test share the same wrong constant.
- Independent contract / B1: docs/security-review.md AGT-3 explicitly specifies the x-jasper-agent-input HTTP header.
- Independent oracle / B3 and rewrite: Read the literal 'x-jasper-agent-input' header and require its literal value '1'; do not import the shared API header constant.
- Stable seam / B4: createEditorEngineClient HTTP requests. Non-test callers: state/engine.tsx and the engine request authentication boundary.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: Engine security tests own handling the header; this adapter test uniquely owns adding it only to agent-origin non-housekeeping requests.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/agent-ui-guard.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 2. KEEP: `apps/web/test/agent-ui-guard.test.tsx` — refuses destructive user-origin transactions while agent input is handled

- Failure detected: refuses destructive user-origin transactions while agent input is handled. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md (AGT-1/3), S01 AGT-011.
- Remaining stronger coverage / B6: engine authorization tests do not cover synthetic UI input.
- Non-test callers / B4: agent-bridge/index.ts, ui-automation.ts, state/engine.tsx, AgentApprovals.tsx; observed seam: agent input/session guard, request headers, approval DOM.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving agent input/session guard, request headers, approval DOM outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/agent-ui-guard.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 3. REWRITE: `apps/web/test/agent-ui-guard.test.tsx` — covers asynchronous aftermath, ends after the grace period or a real user input

- Failure detected / B2: A shortened grace period permits delayed destructive edits; a lengthened one blocks legitimate user edits.
- Independent contract / B1: docs/security-review.md AGT-1 specifies 1.5 seconds of asynchronous protection and immediate release on trusted input.
- Independent oracle / B3 and rewrite: Control the browser clock from an observed start; require protection at 1,499 ms and expiry at 1,500 ms, independently of the private constant.
- Stable seam / B4: runAgentInput plus the session transaction guard. Non-test callers: agent bridge actions and session guard installation.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: Approval and engine tests do not exercise delayed frontend transaction provenance.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/agent-ui-guard.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 4. REWRITE: `apps/web/test/agent-ui-guard.test.tsx` — history.clear {confirmed: true} is refused for agent input and runs for the user

- Failure detected: history.clear {confirmed: true} is refused for agent input and runs for the user. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md (AGT-1/3), S01 AGT-011.
- Remaining stronger coverage / B6: engine authorization tests do not cover synthetic UI input.
- Non-test callers / B4: agent-bridge/index.ts, ui-automation.ts, state/engine.tsx, AgentApprovals.tsx; observed seam: agent input/session guard, request headers, approval DOM.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving agent input/session guard, request headers, approval DOM outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Replace test-only reset hook with trusted input; same approval result and forbidden side effects.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/agent-ui-guard.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 5. KEEP: `apps/web/test/agent-ui-guard.test.tsx` — synthetic (agent) clicks cannot approve; they may deny

- Failure detected: synthetic (agent) clicks cannot approve; they may deny. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md (AGT-1/3), S01 AGT-011.
- Remaining stronger coverage / B6: engine authorization tests do not cover synthetic UI input.
- Non-test callers / B4: agent-bridge/index.ts, ui-automation.ts, state/engine.tsx, AgentApprovals.tsx; observed seam: agent input/session guard, request headers, approval DOM.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving agent input/session guard, request headers, approval DOM outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/agent-ui-guard.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 6. REWRITE: `apps/web/test/agent-ui.test.ts` — parses modifiers and keys like the keymap (KeyboardEvent.code)

- Failure detected: parses modifiers and keys like the keymap (KeyboardEvent.code). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/wp-notes/mcp-cli.md ui_key; browser KeyboardEvent key/code/modifier protocol.
- Remaining stronger coverage / B6: e2e Cmd+Z does not cover printable shifted keys or invalid chord errors.
- Non-test callers / B4: agent-bridge bridge UI relay; observed seam: runUiAction key events and E_INVALID_PARAM result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runUiAction key events and E_INVALID_PARAM result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Replace internal chord/key record assertions with public runUiAction key events for Space, ?, Alt++ and E_INVALID_PARAM on unknown keys/modifiers; keyboard dispatch mapping has no lower public owner.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/agent-ui.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 7. DELETE: `apps/web/test/agent-ui.test.ts` — treats native controls, interactive roles and focusable elements as interactive

- Failure detected: treats native controls, interactive roles and focusable elements as interactive. Private interactive-element classification inventory; ui_elements browser workflow in e2e/agent-ui.spec.ts observes the actual protocol. Internal classification choices are not independently fixed.
- Independent contract / B1: ui_elements protocol does not specify helper function classifications.
- Remaining stronger coverage / B6: e2e/agent-ui.spec.ts observes actual ui_elements output; helper inventories do not prove the emitted snapshot.
- Non-test callers / B4: ui-elements.ts snapshotElements; ui-automation.ts uses accessibleName; observed seam: private DOM classification helpers.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/agent-ui.test.ts --maxWorkers=1` (remaining owner files if this file is deleted).

## 8. KEEP: `apps/web/test/agent-ui.test.ts` — reports a refused native capture as unavailable

- Failure detected: reports a refused native capture as unavailable. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/wp-notes/mcp-cli.md (ui_screenshot protocol).
- Remaining stronger coverage / B6: native capture refusal is not covered by key/element browser workflows.
- Non-test callers / B4: agent-bridge/bridge.ts; observed seam: runUiAction screenshot result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runUiAction screenshot result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/agent-ui.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 9. KEEP: `apps/web/test/audit-web-features.test.tsx` — stops on %s

- Failure detected: stops on %s. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 10. KEEP: `apps/web/test/audit-web-features.test.tsx` — bounds consecutive network failures

- Failure detected: bounds consecutive network failures. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 11. KEEP: `apps/web/test/audit-web-features.test.tsx` — resets the retry budget after a response and treats interrupted as terminal

- Failure detected: resets the retry budget after a response and treats interrupted as terminal. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 12. KEEP: `apps/web/test/audit-web-features.test.tsx` — retries explicitly retryable server errors within the same budget

- Failure detected: retries explicitly retryable server errors within the same budget. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 13. KEEP: `apps/web/test/audit-web-features.test.tsx` — does not publish an obsolete job response

- Failure detected: does not publish an obsolete job response. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 14. KEEP: `apps/web/test/audit-web-features.test.tsx` — clears a running tracker and exposes polling failure

- Failure detected: clears a running tracker and exposes polling failure. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 15. REWRITE: `apps/web/test/audit-web-features.test.tsx` — rejects unsafe types without discarding valid independent choices

- Failure detected: rejects unsafe types without discarding valid independent choices. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Remove expected object computed by defaultOptions; assert only preserved mix choice, safe fallback model, boolean replace and bounded speaker count.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 16. KEEP: `apps/web/test/audit-web-features.test.tsx` — parses arbitrary stored JSON into usable UI values

- Failure detected: parses arbitrary stored JSON into usable UI values. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Arbitrary external JSON must obey fixed type/range/refusal invariants; the parser cannot supply its own expected result.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 17. KEEP: `apps/web/test/audit-web-features.test.tsx` — closes a hosted dialog only once before React flushes state

- Failure detected: closes a hosted dialog only once before React flushes state. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 18. KEEP: `apps/web/test/audit-web-features.test.tsx` — marks media status HTTP %s failures as errors

- Failure detected: marks media status HTTP %s failures as errors. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 19. KEEP: `apps/web/test/audit-web-features.test.tsx` — refuses malformed layer results before opening the layer picker

- Failure detected: refuses malformed layer results before opening the layer picker. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0; docs/wp-notes/code-audit-web-features.md documented failures.
- Remaining stronger coverage / B6: other feature tests do not exercise these corrupt/error/stale inputs.
- Non-test callers / B4: tracking/roto/mask actions, speech/multicam UI, import host; observed seam: job poller, preference loaders, hosted-dialog hook, import HTTP boundary.
- B2/B3: The named failure is user/caller-visible at that seam. Arbitrary external JSON must obey fixed type/range/refusal invariants; the parser cannot supply its own expected result.
- B5: Refactoring internals while preserving job poller, preference loaders, hosted-dialog hook, import HTTP boundary outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/audit-web-features.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 20. KEEP: `apps/web/test/clip-extensions.test.tsx` — nudges visual layers without interpreting $kind transform extension $transform

- Failure detected: nudges visual layers without interpreting $kind transform extension $transform. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0 conservative newer-kind handling; project extension schema.
- Remaining stronger coverage / B6: project schema tests cannot detect UI transform/effects crashes.
- Non-test callers / B4: program commands and timeline rendering; observed seam: nudgeSelection and ClipView with parsed extension clips.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving nudgeSelection and ClipView with parsed extension clips outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/clip-extensions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 21. KEEP: `apps/web/test/clip-extensions.test.tsx` — renders a %s clip with a null effects extension

- Failure detected: renders a %s clip with a null effects extension. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0 conservative newer-kind handling; project extension schema.
- Remaining stronger coverage / B6: project schema tests cannot detect UI transform/effects crashes.
- Non-test callers / B4: program commands and timeline rendering; observed seam: nudgeSelection and ClipView with parsed extension clips.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving nudgeSelection and ClipView with parsed extension clips outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/clip-extensions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 22. KEEP: `apps/web/test/color-scopes.test.ts` — reads back at most 256 px wide, keeping the aspect

- Failure detected: reads back at most 256 px wide, keeping the aspect. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S06 SCP-002 bounded aspect-preserving scope readback.
- Remaining stronger coverage / B6: color-grade.test.tsx does not bound capture allocation.
- Non-test callers / B4: readFrame in color/scopes/capture.ts; observed seam: readbackSize input/output buffer contract.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving readbackSize input/output buffer contract outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/color-scopes.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 23. KEEP: `apps/web/test/dev-auth.test.ts` — finds the token through /health and the runtime file, and follows an engine restart

- Failure detected: finds the token through /health and the runtime file, and follows an engine restart. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md DEV-1; README development authentication.
- Remaining stronger coverage / B6: engine token checks do not test dev proxy credential selection.
- Non-test callers / B4: apps/web/vite.config.ts; observed seam: runtime file, proxy events and Set-Cookie HTTP header.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runtime file, proxy events and Set-Cookie HTTP header outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/dev-auth.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 24. KEEP: `apps/web/test/dev-auth.test.ts` — ignores a runtime file that describes another engine

- Failure detected: ignores a runtime file that describes another engine. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md DEV-1; README development authentication.
- Remaining stronger coverage / B6: engine token checks do not test dev proxy credential selection.
- Non-test callers / B4: apps/web/vite.config.ts; observed seam: runtime file, proxy events and Set-Cookie HTTP header.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runtime file, proxy events and Set-Cookie HTTP header outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/dev-auth.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 25. KEEP: `apps/web/test/dev-auth.test.ts` — without an engine yet: no token, and it is found once the engine is up

- Failure detected: without an engine yet: no token, and it is found once the engine is up. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md DEV-1; README development authentication.
- Remaining stronger coverage / B6: engine token checks do not test dev proxy credential selection.
- Non-test callers / B4: apps/web/vite.config.ts; observed seam: runtime file, proxy events and Set-Cookie HTTP header.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runtime file, proxy events and Set-Cookie HTTP header outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/dev-auth.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 26. KEEP: `apps/web/test/dev-auth.test.ts` — falls back to JASPER_APPDIR when /health is not answering

- Failure detected: falls back to JASPER_APPDIR when /health is not answering. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md DEV-1; README development authentication.
- Remaining stronger coverage / B6: engine token checks do not test dev proxy credential selection.
- Non-test callers / B4: apps/web/vite.config.ts; observed seam: runtime file, proxy events and Set-Cookie HTTP header.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runtime file, proxy events and Set-Cookie HTTP header outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/dev-auth.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 27. KEEP: `apps/web/test/dev-auth.test.ts` — adds the token to proxied HTTP and WebSocket requests, and keeps a client’s own credentials

- Failure detected: adds the token to proxied HTTP and WebSocket requests, and keeps a client’s own credentials. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md DEV-1; README development authentication.
- Remaining stronger coverage / B6: engine token checks do not test dev proxy credential selection.
- Non-test callers / B4: apps/web/vite.config.ts; observed seam: runtime file, proxy events and Set-Cookie HTTP header.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runtime file, proxy events and Set-Cookie HTTP header outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/dev-auth.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 28. KEEP: `apps/web/test/dev-auth.test.ts` — page loads and the /health poll receive the dev editor key as an HttpOnly, SameSite=Strict cookie

- Failure detected: page loads and the /health poll receive the dev editor key as an HttpOnly, SameSite=Strict cookie. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md DEV-1; README development authentication.
- Remaining stronger coverage / B6: engine token checks do not test dev proxy credential selection.
- Non-test callers / B4: apps/web/vite.config.ts; observed seam: runtime file, proxy events and Set-Cookie HTTP header.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runtime file, proxy events and Set-Cookie HTTP header outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/dev-auth.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 29. KEEP: `apps/web/test/dev-auth.test.ts` — an engine that is not a dev engine has no key file: no cookie is made up

- Failure detected: an engine that is not a dev engine has no key file: no cookie is made up. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: docs/security-review.md DEV-1; README development authentication.
- Remaining stronger coverage / B6: engine token checks do not test dev proxy credential selection.
- Non-test callers / B4: apps/web/vite.config.ts; observed seam: runtime file, proxy events and Set-Cookie HTTP header.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving runtime file, proxy events and Set-Cookie HTTP header outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/dev-auth.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 30. DELETE: `apps/web/test/edit-structure.test.ts` — groups the selection, selects groups together and Alt-selects one member

- Failure detected: groups the selection, selects groups together and Alt-selects one member. Repeats project clip.group/ungroup and session selection expansion; stronger owners packages/project/test/edit-structure.test.ts and packages/session/test/selection.test.ts remain.
- Independent contract / B1: S02 structure editing; S03 Source monitor source-time behavior.
- Remaining stronger coverage / B6: project tests lack UI selection/playhead/nest-toggle context.
- Non-test callers / B4: commands/registry.ts and source monitor; observed seam: registered commands, active sequence and document output.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/edit-structure.test.ts --maxWorkers=1` (remaining owner files if this file is deleted).

## 31. KEEP: `apps/web/test/edit-structure.test.ts` — adds a frame hold at the playhead and inserts a hold segment

- Failure detected: adds a frame hold at the playhead and inserts a hold segment. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 structure editing; S03 Source monitor source-time behavior.
- Remaining stronger coverage / B6: project tests lack UI selection/playhead/nest-toggle context.
- Non-test callers / B4: commands/registry.ts and source monitor; observed seam: registered commands, active sequence and document output.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving registered commands, active sequence and document output outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-structure.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 32. DELETE: `apps/web/test/edit-structure.test.ts` — joins through edits, goes to gaps and makes a subsequence

- Failure detected: joins through edits, goes to gaps and makes a subsequence. Combined pass-through command smoke repeats through-edit/gap/subsequence model behavior; packages/project/test/edit-structure.test.ts and edit-ux-match-trim.test.ts own exact results. Sequence count alone misses content loss.
- Independent contract / B1: S02 structure editing; S03 Source monitor source-time behavior.
- Remaining stronger coverage / B6: project tests lack UI selection/playhead/nest-toggle context.
- Non-test callers / B4: commands/registry.ts and source monitor; observed seam: registered commands, active sequence and document output.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/edit-structure.test.ts --maxWorkers=1` (remaining owner files if this file is deleted).

## 33. REWRITE: `apps/web/test/edit-structure.test.ts` — unnests, reveals the nested sequence and matches frames through it

- Failure detected: unnests, reveals the nested sequence and matches frames through it. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 structure editing; S03 Source monitor source-time behavior.
- Remaining stronger coverage / B6: project tests lack UI selection/playhead/nest-toggle context.
- Non-test callers / B4: commands/registry.ts and source monitor; observed seam: registered commands, active sequence and document output.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving registered commands, active sequence and document output outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Remove duplicated project resolveMatchFrame assertions and web re-export; keep nested navigation source-time and unnest command context.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-structure.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 34. KEEP: `apps/web/test/edit-structure.test.ts` — places a sequence from the Source monitor as a nest or as individual clips

- Failure detected: places a sequence from the Source monitor as a nest or as individual clips. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 structure editing; S03 Source monitor source-time behavior.
- Remaining stronger coverage / B6: project tests lack UI selection/playhead/nest-toggle context.
- Non-test callers / B4: commands/registry.ts and source monitor; observed seam: registered commands, active sequence and document output.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving registered commands, active sequence and document output outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-structure.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 35. REWRITE: `apps/web/test/edit-structure.test.ts` — creates New Items, previews them and removes unused ones

- Failure detected: creates New Items, previews them and removes unused ones. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 structure editing; S03 Source monitor source-time behavior.
- Remaining stronger coverage / B6: project tests lack UI selection/playhead/nest-toggle context.
- Non-test callers / B4: commands/registry.ts and source monitor; observed seam: registered commands, active sequence and document output.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving registered commands, active sequence and document output outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Keep bars-and-tone synthetic preview content; remove new-item kind inventory and remove-unused pass-through checks.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-structure.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 36. DELETE: `apps/web/test/edit-structure.test.ts` — duplicates a sequence item

- Failure detected: duplicates a sequence item. Only checks sequence count after a pass-through duplicate command; packages/project/test/edit-structure.test.ts verifies copied document behavior.
- Independent contract / B1: S02 structure editing; S03 Source monitor source-time behavior.
- Remaining stronger coverage / B6: project tests lack UI selection/playhead/nest-toggle context.
- Non-test callers / B4: commands/registry.ts and source monitor; observed seam: registered commands, active sequence and document output.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/edit-structure.test.ts --maxWorkers=1` (remaining owner files if this file is deleted).

## 37. REWRITE: `apps/web/test/edit-ux-dialogs.test.tsx` — speed and duration stay linked; ripple, reverse and pitch apply in one entry

- Failure detected: speed and duration stay linked; ripple, reverse and pitch apply in one entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 source edits/speed/subclip contracts; docs/wp-notes/edit-ux.md.
- Remaining stronger coverage / B6: project source-edit tests do not map UI choices to editing inputs.
- Non-test callers / B4: command/dialog hosts and Source monitor; observed seam: rendered dialog interaction and committed session document.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving rendered dialog interaction and committed session document outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Rename to the behavior actually exercised: 50% speed ripples linked clips. Do not claim untested reverse/pitch.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-dialogs.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 38. KEEP: `apps/web/test/edit-ux-dialogs.test.tsx` — Insert with four mismatched points opens Fit Clip; Change Clip Speed fits; Always remembers

- Failure detected: Insert with four mismatched points opens Fit Clip; Change Clip Speed fits; Always remembers. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 source edits/speed/subclip contracts; docs/wp-notes/edit-ux.md.
- Remaining stronger coverage / B6: project source-edit tests do not map UI choices to editing inputs.
- Non-test callers / B4: command/dialog hosts and Source monitor; observed seam: rendered dialog interaction and committed session document.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving rendered dialog interaction and committed session document outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-dialogs.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 39. DELETE: `apps/web/test/edit-ux-dialogs.test.tsx` — performSourceEdit reports needsFit without a choice

- Failure detected: performSourceEdit reports needsFit without a choice. Same four-point needsFit refusal is exercised by the retained Fit Clip dialog workflow and packages/project/test/edit-ux-source-edit.test.ts.
- Independent contract / B1: S02 source edits/speed/subclip contracts; docs/wp-notes/edit-ux.md.
- Remaining stronger coverage / B6: project source-edit tests do not map UI choices to editing inputs.
- Non-test callers / B4: command/dialog hosts and Source monitor; observed seam: rendered dialog interaction and committed session document.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-dialogs.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 40. REWRITE: `apps/web/test/edit-ux-dialogs.test.tsx` — Make Subclip from the Source monitor marks; Edit Subclip renames and restricts

- Failure detected / B2: The UI converts two/four-second marks to the wrong persisted subclip range.
- Independent contract / B1: S01 TIME-002/006 and S04 subclip marks require content-time flicks at 705,600,000 per second.
- Independent oracle / B3 and rewrite: Require literal range 1,411,200,000 through 2,822,400,000 flicks; remove the imported time constant from expected values.
- Stable seam / B4: SubclipDialog and committed session document. Non-test callers: edit-ux command/dialog registration.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: Core time conversion tests do not exercise this Source marks-to-dialog-to-subclip mapping.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-dialogs.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 41. REWRITE: `apps/web/test/edit-ux-dialogs.test.tsx` — Mark Split sets the audio In at the Source playhead and is used by Insert

- Failure detected / B2: The Source split command persists the wrong content time or Insert loses the half-second audio lead.
- Independent contract / B1: S01 TIME-002/006 and S02 split-edit contracts preserve the Source audio In independently of video In.
- Independent oracle / B3 and rewrite: Require literal 1,058,400,000 flicks at frame 45/30fps, plus existing independent resulting audio/video spans.
- Stable seam / B4: source.markSplitAudioIn and timeline.insertFromSource command outputs. Non-test callers: Source monitor and timeline command dispatch.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: Core command tests do not own Source transport mapping and UI dispatch.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-dialogs.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 42. DELETE: `apps/web/test/edit-ux-dialogs.test.tsx` — Linked Selection toggles

- Failure detected: Linked Selection toggles. Single toggle forwarding duplicates linked-selection state behavior exercised by timeline-gestures.test.ts.
- Independent contract / B1: S02 source edits/speed/subclip contracts; docs/wp-notes/edit-ux.md.
- Remaining stronger coverage / B6: project source-edit tests do not map UI choices to editing inputs.
- Non-test callers / B4: command/dialog hosts and Source monitor; observed seam: rendered dialog interaction and committed session document.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-dialogs.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 43. KEEP: `apps/web/test/edit-ux-trim-mode.test.ts` — Shift+T selects the nearest cut as a roll; Ctrl+T cycles Ripple → Roll → Trim

- Failure detected: Shift+T selects the nearest cut as a roll; Ctrl+T cycles Ripple → Roll → Trim. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 44. KEEP: `apps/web/test/edit-ux-trim-mode.test.ts` — trim keys move the edit, count the shift and coalesce into one History entry

- Failure detected: trim keys move the edit, count the shift and coalesce into one History entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 45. KEEP: `apps/web/test/edit-ux-trim-mode.test.ts` — numeric entry via keypad +/− arms the Trim Monitor field; E extends the edit to the playhead

- Failure detected: numeric entry via keypad +/− arms the Trim Monitor field; E extends the edit to the playhead. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 46. KEEP: `apps/web/test/edit-ux-trim-mode.test.ts` — without edit points the contextual trim keys fall through (disabled)

- Failure detected: without edit points the contextual trim keys fall through (disabled). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 47. KEEP: `apps/web/test/edit-ux-trim-mode.test.ts` — Shift+D at the edit points applies the default transition at the cut

- Failure detected: Shift+D at the edit points applies the default transition at the cut. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 48. REWRITE: `apps/web/test/edit-ux-trim-mode.test.ts` — L rolls the edit live, K commits ONE undo step "Dynamic Rolling Edit"; undo restores

- Failure detected: L rolls the edit live, K commits ONE undo step "Dynamic Rolling Edit"; undo restores. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop class-instance assertion; retain live document, history and undo observations. Remove test-only clock/RAF injection using browser API spies.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 49. REWRITE: `apps/web/test/edit-ux-trim-mode.test.ts` — J reverses; a ripple stops at a limit and holds; Esc cancels with nothing recorded

- Failure detected: J reverses; a ripple stops at a limit and holds; Esc cancels with nothing recorded. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Remove test-only clock/RAF injection; supply controlled browser performance/animation APIs while retaining cancellation and limit observations.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 50. REWRITE: `apps/web/test/edit-ux-trim-mode.test.ts` — another command commits the dynamic trim first; slow (Shift+L) is quarter speed; K with no movement records nothing

- Failure detected: another command commits the dynamic trim first; slow (Shift+L) is quarter speed; K with no movement records nothing. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Remove test-only clock/RAF injection; retain command ordering, quarter-speed and no-op commit behavior.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 51. KEEP: `apps/web/test/edit-ux-trim-mode.test.ts` — J/K/L keys in trim mode drive the dynamic trim instead of the shuttle

- Failure detected: J/K/L keys in trim mode drive the dynamic trim instead of the shuttle. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 52. KEEP: `apps/web/test/edit-ux-trim-mode.test.ts` — a ripple trim of the clip before a J cut keeps the early sound with its picture

- Failure detected: a ripple trim of the clip before a J cut keeps the early sound with its picture. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 trim-mode/JKL/linked split-edit contracts.
- Remaining stronger coverage / B6: project trim commands do not own key gesture coalescing or trim-mode state.
- Non-test callers / B4: commands/edit-ux.ts and commands/transport.ts; observed seam: command dispatcher and dynamic session gesture.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving command dispatcher and dynamic session gesture outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-mode.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 53. KEEP: `apps/web/test/edit-ux-trim-monitor.test.tsx` — shows both sides with counters; buttons, numeric entry and the roll strip trim

- Failure detected: shows both sides with counters; buttons, numeric entry and the roll strip trim. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 Trim Monitor; S02 source patching.
- Remaining stronger coverage / B6: model trim tests do not cover monitor controls; routing belongs to web patch owner.
- Non-test callers / B4: ProgramPanel and source edit commands; observed seam: TrimMonitor DOM controls and source-track routing.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TrimMonitor DOM controls and source-track routing outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-monitor.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 54. REWRITE: `apps/web/test/edit-ux-trim-monitor.test.tsx` — defaults to the same tracks; patches and switches off; the header label follows

- Failure detected: defaults to the same tracks; patches and switches off; the header label follows. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 Trim Monitor; S02 source patching.
- Remaining stronger coverage / B6: model trim tests do not cover monitor controls; routing belongs to web patch owner.
- Non-test callers / B4: ProgramPanel and source edit commands; observed seam: TrimMonitor DOM controls and source-track routing.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TrimMonitor DOM controls and source-track routing outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop header-label object shape; retain resolved source-track patch routing contract.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/edit-ux-trim-monitor.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 55. REWRITE: `apps/web/test/expressions-ui.test.tsx` — Alt-click adds the default expression; the value shows post-expression; Alt-click removes; undo

- Failure detected: Alt-click adds the default expression; the value shows post-expression; Alt-click removes; undo. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S10 expression editing and error fallback; AGENTS §0.
- Remaining stronger coverage / B6: expression evaluator tests cannot detect disconnected inspector controls.
- Non-test callers / B4: EffectControlsPanel inspector rows; observed seam: Effect Controls user events and session expression data.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Effect Controls user events and session expression data outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop data-expression styling marker; retain evaluated visible value, expression editing and undo.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/expressions-ui.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 56. REWRITE: `apps/web/test/expressions-ui.test.tsx` — errors show under the field and the property keeps its keyframed value; the switch disables

- Failure detected: errors show under the field and the property keeps its keyframed value; the switch disables. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S10 expression editing and error fallback; AGENTS §0.
- Remaining stronger coverage / B6: expression evaluator tests cannot detect disconnected inspector controls.
- Non-test callers / B4: EffectControlsPanel inspector rows; observed seam: Effect Controls user events and session expression data.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Effect Controls user events and session expression data outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Assert nonempty expression failure instead of exact diagnostic wording; keep fallback value and disable interaction.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/expressions-ui.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 57. DELETE: `apps/web/test/expressions-ui.test.tsx` — Expression Controls show their editors (dropdown items, layer picker, 3D point)

- Failure detected: Expression Controls show their editors (dropdown items, layer picker, 3D point). Only counts/selects rendered editor elements; no edits or evaluated expression outputs. Other expression interaction tests and project expression contracts remain.
- Independent contract / B1: S10 expression editing and error fallback; AGENTS §0.
- Remaining stronger coverage / B6: expression evaluator tests cannot detect disconnected inspector controls.
- Non-test callers / B4: EffectControlsPanel inspector rows; observed seam: Effect Controls user events and session expression data.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/expressions-ui.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 58. DELETE: `apps/web/test/gaps-ui5-tracks.test.tsx` — registers every gaps menu entry (no longer disabled as unregistered)

- Failure detected: registers every gaps menu entry (no longer disabled as unregistered). Registration inventory can pass with broken command bodies; retained actual command interactions and keyboard tests protect behavior.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 59. KEEP: `apps/web/test/gaps-ui5-tracks.test.tsx` — shows File ▸ Exit only in the desktop app

- Failure detected: shows File ▸ Exit only in the desktop app. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving menu runtime, Find controls, track planning and preset persistence outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 60. DELETE: `apps/web/test/gaps-ui5-tracks.test.tsx` — picks the scope from the focused panel

- Failure detected: picks the scope from the focused panel. Private scope mapper restates a switch; Find dialog execution and project query owners remain.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 61. REWRITE: `apps/web/test/gaps-ui5-tracks.test.tsx` — Find steps through timeline hits and moves the playhead; Find All selects every clip

- Failure detected: Find steps through timeline hits and moves the playhead; Find All selects every clip. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving menu runtime, Find controls, track planning and preset persistence outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Observe playhead and selected clips instead of status-copy strings or a passthrough seek spy.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 62. REWRITE: `apps/web/test/gaps-ui5-tracks.test.tsx` — the dialog runs Find from its fields

- Failure detected: the dialog runs Find from its fields. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving menu runtime, Find controls, track planning and preset persistence outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Observe selected project item after Find rather than status-copy count.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 63. DELETE: `apps/web/test/gaps-ui5-tracks.test.tsx` — renames the selected clips (one undo step)

- Failure detected: renames the selected clips (one undo step). Rename forwarding duplicates clip.update undo in project command tests; no DOM interaction here.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 64. REWRITE: `apps/web/test/gaps-ui5-tracks.test.tsx` — placement options and add commands

- Failure detected: placement options and add commands. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving menu runtime, Find controls, track planning and preset persistence outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop placement label inventory; retain committed insertion positions, audio channel format and undo.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 65. KEEP: `apps/web/test/gaps-ui5-tracks.test.tsx` — delete plans: empty tracks keep one track, named tracks report their clips, last track refused

- Failure detected: delete plans: empty tracks keep one track, named tracks report their clips, last track refused. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving menu runtime, Find controls, track planning and preset persistence outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 66. KEEP: `apps/web/test/gaps-ui5-tracks.test.tsx` — saves, applies by position, survives bad storage

- Failure detected: saves, applies by position, survives bad storage. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving menu runtime, Find controls, track planning and preset persistence outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 67. DELETE: `apps/web/test/gaps-ui5-tracks.test.tsx` — Track Height Preset N applies to the active sequence

- Failure detected: Track Height Preset N applies to the active sequence. Pass-through preset command applies values already covered by retained save/apply/storage test; does not exercise keyboard dispatch.
- Independent contract / B1: S05 menu/Find/track/preset behavior; AGENTS §0 storage validation.
- Remaining stronger coverage / B6: project query/track commands lack UI plan/selection and stored-preset responsibilities.
- Non-test callers / B4: commands/gaps.ts, TrackDialogs.tsx and timeline header; observed seam: menu runtime, Find controls, track planning and preset persistence.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 68. KEEP: `apps/web/test/keymap.test.ts` — has no duplicate bindings within a scope (${platform}/${runtime}, KB-011)

- Failure detected: has no duplicate bindings within a scope (${platform}/${runtime}, KB-011). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 KB-011 conflict rule and KB-013 browser fallbacks.
- Remaining stronger coverage / B6: config uniqueness covers unused bindings not reached by interaction samples.
- Non-test callers / B4: shell/keymap dispatcher and editor; observed seam: default keymap configuration across platform/runtime variants.
- B2/B3: The named failure is user/caller-visible at that seam. Independent uniqueness/conflict rule over shipped configuration, not a snapshot of binding rows.
- B5: Refactoring internals while preserving default keymap configuration across platform/runtime variants outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/keymap.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 69. KEEP: `apps/web/test/keymap.test.ts` — uses web fallbacks for browser-reserved chords (KB-013)

- Failure detected: uses web fallbacks for browser-reserved chords (KB-013). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 KB-011 conflict rule and KB-013 browser fallbacks.
- Remaining stronger coverage / B6: config uniqueness covers unused bindings not reached by interaction samples.
- Non-test callers / B4: shell/keymap dispatcher and editor; observed seam: default keymap configuration across platform/runtime variants.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving default keymap configuration across platform/runtime variants outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/keymap.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 70. REWRITE: `apps/web/test/motion-path-keyframes-blend.test.tsx` — draws the Anchor Point path through the layer map and edits its keys in layer space

- Failure detected: draws the Anchor Point path through the layer map and edits its keys in layer space. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 motion path editing, snapping and Bezier vertex contracts.
- Remaining stronger coverage / B6: pure keyframe math does not cover selecting/dragging path keys.
- Non-test callers / B4: ProgramPanel/TransformOverlay; observed seam: TransformOverlay pointer interactions and persisted keyframes.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TransformOverlay pointer interactions and persisted keyframes outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop SVG data-property/dot-count assertions; retain pointer edit in layer coordinates and one undo step.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/motion-path-keyframes-blend.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 71. KEEP: `apps/web/test/motion-path-keyframes-blend.test.tsx` — snaps a dragged key to the frame centre (snapping on)

- Failure detected: snaps a dragged key to the frame centre (snapping on). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 motion path editing, snapping and Bezier vertex contracts.
- Remaining stronger coverage / B6: pure keyframe math does not cover selecting/dragging path keys.
- Non-test callers / B4: ProgramPanel/TransformOverlay; observed seam: TransformOverlay pointer interactions and persisted keyframes.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TransformOverlay pointer interactions and persisted keyframes outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/motion-path-keyframes-blend.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 72. KEEP: `apps/web/test/motion-path-keyframes-blend.test.tsx` — drags every selected key of the path by the same offset (one undo entry)

- Failure detected: drags every selected key of the path by the same offset (one undo entry). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 motion path editing, snapping and Bezier vertex contracts.
- Remaining stronger coverage / B6: pure keyframe math does not cover selecting/dragging path keys.
- Non-test callers / B4: ProgramPanel/TransformOverlay; observed seam: TransformOverlay pointer interactions and persisted keyframes.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TransformOverlay pointer interactions and persisted keyframes outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/motion-path-keyframes-blend.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 73. KEEP: `apps/web/test/motion-path-keyframes-blend.test.tsx` — Ctrl-click converts a vertex (smooth ↔ corner); the Pen tool drags handles out of a corner

- Failure detected: Ctrl-click converts a vertex (smooth ↔ corner); the Pen tool drags handles out of a corner. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 motion path editing, snapping and Bezier vertex contracts.
- Remaining stronger coverage / B6: pure keyframe math does not cover selecting/dragging path keys.
- Non-test callers / B4: ProgramPanel/TransformOverlay; observed seam: TransformOverlay pointer interactions and persisted keyframes.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TransformOverlay pointer interactions and persisted keyframes outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/motion-path-keyframes-blend.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 74. KEEP: `apps/web/test/motion-templates.test.tsx` — round-trips the drag payload

- Failure detected: round-trips the drag payload. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: ARCHITECTURE motion templates; S11 ATP gallery insertion; drag MIME protocol.
- Remaining stronger coverage / B6: project clip creation does not cover drag bytes or gallery-to-engine options.
- Non-test callers / B4: MotionTemplatesPanel and commands/mg.ts; observed seam: gallery DOM, DataTransfer bytes and engine render HTTP request.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving gallery DOM, DataTransfer bytes and engine render HTTP request outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/motion-templates.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 75. KEEP: `apps/web/test/motion-templates.test.tsx` — shows the gallery with static previews and inserts on double-click via clip.addMotionGraphic

- Failure detected: shows the gallery with static previews and inserts on double-click via clip.addMotionGraphic. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: ARCHITECTURE motion templates; S11 ATP gallery insertion; drag MIME protocol.
- Remaining stronger coverage / B6: project clip creation does not cover drag bytes or gallery-to-engine options.
- Non-test callers / B4: MotionTemplatesPanel and commands/mg.ts; observed seam: gallery DOM, DataTransfer bytes and engine render HTTP request.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving gallery DOM, DataTransfer bytes and engine render HTTP request outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/motion-templates.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 76. KEEP: `apps/web/test/motion-templates.test.tsx` — mg.rerender sends the selected clip spec to the engine when fframes is available

- Failure detected: mg.rerender sends the selected clip spec to the engine when fframes is available. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: ARCHITECTURE motion templates; S11 ATP gallery insertion; drag MIME protocol.
- Remaining stronger coverage / B6: project clip creation does not cover drag bytes or gallery-to-engine options.
- Non-test callers / B4: MotionTemplatesPanel and commands/mg.ts; observed seam: gallery DOM, DataTransfer bytes and engine render HTTP request.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving gallery DOM, DataTransfer bytes and engine render HTTP request outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/motion-templates.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 77. DELETE: `apps/web/test/polish-media-browser.test.tsx` — filters by type and search, keeping folders

- Failure detected: filters by type and search, keeping folders. Private filter helper repeats implementation branch choices; no UI action. Retained Media Browser navigation/import workflow owns usable file selections.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 78. DELETE: `apps/web/test/polish-media-browser.test.tsx` — formats sizes

- Failure detected: formats sizes. Exact byte-format strings are presentation choices with no independent wording contract.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 79. REWRITE: `apps/web/test/polish-media-browser.test.tsx` — a Media Browser drag reads as host paths

- Failure detected / B2: A shared renamed MIME type makes producer and parser agree while breaking the documented drag protocol.
- Independent contract / B1: docs/wp-notes/polish.md specifies application/x-jasper-host-paths for Media Browser drag/drop.
- Independent oracle / B3 and rewrite: Require literal MIME and serialized paths bytes; separately parse a literal external payload instead of feeding the writer output to the reader.
- Stable seam / B4: writeHostPathsDrag and readDataTransfer browser payloads. Non-test callers: MediaBrowserPanel, ProjectPanel and TimelinePanel.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: Panel workflows own import interactions; this lowest protocol seam owns drag bytes and malformed-payload refusal.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 80. REWRITE: `apps/web/test/polish-media-browser.test.tsx` — lists the start folder, navigates into folders and back up, and previews the selected file

- Failure detected: lists the start folder, navigates into folders and back up, and previews the selected file. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving browser DOM, import service, HTTP engine snapshot and connection dialog outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop count/status metadata copy; keep actual preview URL, path navigation and persisted folder.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 81. REWRITE: `apps/web/test/polish-media-browser.test.tsx` — imports the selected files in place through the import service (button, command and double-click)

- Failure detected: imports the selected files in place through the import service (button, command and double-click). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving browser DOM, import service, HTTP engine snapshot and connection dialog outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop import button copy and private selection helper assertion; keep public import-service payload and action routes.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 82. REWRITE: `apps/web/test/polish-media-browser.test.tsx` — says why it cannot browse on a remote engine

- Failure detected: says why it cannot browse on a remote engine. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving browser DOM, import service, HTTP engine snapshot and connection dialog outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Assert the semantic local-engine requirement without freezing the complete sentence; there is no alert role in the existing EmptyState.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 83. KEEP: `apps/web/test/polish-media-browser.test.tsx` — Import from Media Browser opens the panel when nothing is selected

- Failure detected: Import from Media Browser opens the panel when nothing is selected. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving browser DOM, import service, HTTP engine snapshot and connection dialog outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 84. REWRITE: `apps/web/test/polish-media-browser.test.tsx` — Edit Parameters needs a motion-graphic clip and reveals Properties ▸ Parameters

- Failure detected / B2: The command targets a nonexistent section, leaving parameter controls hidden despite its own matching storage-key assertion.
- Independent contract / B1: docs/wp-notes/polish.md requires Edit Parameters to focus Properties and reveal the selected motion-graphic parameter controls.
- Independent oracle / B3 and rewrite: Mount the real Properties panel, collapse its Parameters section through the UI, invoke the command and require the existing textbox to become available again.
- Stable seam / B4: mg.editParameters command and rendered Properties control state. Non-test callers: commands/polish.ts and PropertiesPanel.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: The old E2E that merely opened this section was deleted; parameter editing E2E does not own this command reveal regression.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 85. DELETE: `apps/web/test/polish-media-browser.test.tsx` — Engine Status, Connect and Third-Party Notices open their dialogs

- Failure detected: Engine Status, Connect and Third-Party Notices open their dialogs. Dialog id inventory only verifies wrapper collaborator names; retained actual Connect dialog tests protect useful behavior.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 86. KEEP: `apps/web/test/polish-media-browser.test.tsx` — normalises engine addresses

- Failure detected: normalises engine addresses. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving browser DOM, import service, HTTP engine snapshot and connection dialog outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 87. DELETE: `apps/web/test/polish-media-browser.test.tsx` — summarises feature blocks

- Failure detected: summarises feature blocks. Exact string rendering of arbitrary feature blocks is copy/implementation detection, not an independently specified contract.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 88. KEEP: `apps/web/test/polish-media-browser.test.tsx` — reads a snapshot and reports an unreachable engine without throwing

- Failure detected: reads a snapshot and reports an unreachable engine without throwing. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving browser DOM, import service, HTTP engine snapshot and connection dialog outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 89. KEEP: `apps/web/test/polish-media-browser.test.tsx` — keeps the Connect dialog open when saving before navigation fails

- Failure detected: keeps the Connect dialog open when saving before navigation fails. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving browser DOM, import service, HTTP engine snapshot and connection dialog outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 90. REWRITE: `apps/web/test/polish-media-browser.test.tsx` — Engine Status shows the live engine facts; Connect reconnects to this engine

- Failure detected: Engine Status shows the live engine facts; Connect reconnects to this engine. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 Media Browser/import; AGENTS §0 preserve unsaved work; security agent navigation rule.
- Remaining stronger coverage / B6: import service tests lack browser selection; engine tests lack UI navigation/save gate.
- Non-test callers / B4: MediaBrowserPanel, commands/polish.ts and shell engine dialogs; observed seam: browser DOM, import service, HTTP engine snapshot and connection dialog.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving browser DOM, import service, HTTP engine snapshot and connection dialog outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Retain reconnect, invalid address and agent refusal behavior; remove snapshot-style engine-fact copy assertions.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-media-browser.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 91. KEEP: `apps/web/test/polish-panel-loading.test.tsx` — a panel loaded through state appears although updates keep arriving

- Failure detected: a panel loaded through state appears although updates keep arriving. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0 visible load errors; documented Suspense starvation regression.
- Remaining stronger coverage / B6: ordinary panel tests do not reproduce updates during deferred import/failure retry.
- Non-test callers / B4: panels/lazy.ts and shell DockPanel mounting; observed seam: loadable/useLoaded importer lifecycle and rendered content.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving loadable/useLoaded importer lifecycle and rendered content outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-panel-loading.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 92. REWRITE: `apps/web/test/polish-panel-loading.test.tsx` — shares one download, remembers the component, and asks again after a failure

- Failure detected: shares one download, remembers the component, and asks again after a failure. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0 visible load errors; documented Suspense starvation regression.
- Remaining stronger coverage / B6: ordinary panel tests do not reproduce updates during deferred import/failure retry.
- Non-test callers / B4: panels/lazy.ts and shell DockPanel mounting; observed seam: loadable/useLoaded importer lifecycle and rendered content.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving loadable/useLoaded importer lifecycle and rendered content outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Remove promise identity assertion; retain single in-flight import, retry after rejection and remembered component.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-panel-loading.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 93. KEEP: `apps/web/test/polish-panel-loading.test.tsx` — useLoaded reports a failed download and renders at once what is already loaded

- Failure detected: useLoaded reports a failed download and renders at once what is already loaded. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: AGENTS §0 visible load errors; documented Suspense starvation regression.
- Remaining stronger coverage / B6: ordinary panel tests do not reproduce updates during deferred import/failure retry.
- Non-test callers / B4: panels/lazy.ts and shell DockPanel mounting; observed seam: loadable/useLoaded importer lifecycle and rendered content.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving loadable/useLoaded importer lifecycle and rendered content outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/polish-panel-loading.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 94. DELETE: `apps/web/test/polish-panel-loading.test.tsx` — every panel of the registry is loadable (the dock mounts them through state)

- Failure detected: every panel of the registry is loadable (the dock mounts them through state). Registry export-shape inventory plus contrived missing-export branch; neither proves a panel mounts. Retained loading/retry regressions protect lifecycle.
- Independent contract / B1: AGENTS §0 visible load errors; documented Suspense starvation regression.
- Remaining stronger coverage / B6: ordinary panel tests do not reproduce updates during deferred import/failure retry.
- Non-test callers / B4: panels/lazy.ts and shell DockPanel mounting; observed seam: loadable/useLoaded importer lifecycle and rendered content.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/polish-panel-loading.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 95. KEEP: `apps/web/test/preview-thumb.test.tsx` — shows the poster frame, then the shared hover Player after 200 ms

- Failure detected: shows the poster frame, then the shared hover Player after 200 ms. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: ARCHITECTURE §20.6; S11 TXA-020/ATP-007 hover/reduced-motion rule.
- Remaining stronger coverage / B6: gallery insertion tests do not exercise hover arbitration or reduced motion.
- Non-test callers / B4: MotionTemplatesPanel and text-animation gallery; observed seam: PreviewThumb pointer interaction and composition frame output.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving PreviewThumb pointer interaction and composition frame output outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/preview-thumb.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 96. KEEP: `apps/web/test/preview-thumb.test.tsx` — leaving before the delay never starts the Player

- Failure detected: leaving before the delay never starts the Player. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: ARCHITECTURE §20.6; S11 TXA-020/ATP-007 hover/reduced-motion rule.
- Remaining stronger coverage / B6: gallery insertion tests do not exercise hover arbitration or reduced motion.
- Non-test callers / B4: MotionTemplatesPanel and text-animation gallery; observed seam: PreviewThumb pointer interaction and composition frame output.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving PreviewThumb pointer interaction and composition frame output outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/preview-thumb.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 97. KEEP: `apps/web/test/preview-thumb.test.tsx` — touch and reduced motion keep the poster

- Failure detected: touch and reduced motion keep the poster. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: ARCHITECTURE §20.6; S11 TXA-020/ATP-007 hover/reduced-motion rule.
- Remaining stronger coverage / B6: gallery insertion tests do not exercise hover arbitration or reduced motion.
- Non-test callers / B4: MotionTemplatesPanel and text-animation gallery; observed seam: PreviewThumb pointer interaction and composition frame output.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving PreviewThumb pointer interaction and composition frame output outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/preview-thumb.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 98. REWRITE: `apps/web/test/program-layer-menu.test.tsx` — fits the visible rect inside the frame, centred

- Failure detected / B2: A wrong crop or matrix shared by test and owner yields a shifted image but both sides agree.
- Independent contract / B1: S03 XF-051 requires fitting the cropped visible rectangle and centering it in the frame.
- Independent oracle / B3 and rewrite: For 50% left crop on 1280x720, require literal scale 150 and position [480,540], without visibleRect/layerMatrix/layerQuad.
- Stable seam / B4: fitPatch returned Motion values. Non-test callers: commands/layer.ts motion.fit/motion.fill.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: Command integration retains history/keying; this lower operation seam uniquely covers crop-aware centering.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 99. KEEP: `apps/web/test/program-layer-menu.test.tsx` — uses the rotated bounds, fills by the larger ratio, and Set to Native only sets 100%

- Failure detected: uses the rotated bounds, fills by the larger ratio, and Set to Native only sets 100%. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 XF-038/051 and S02 TL-266 editing requirements.
- Remaining stronger coverage / B6: project param edits do not own fit/crop/anchor decisions or UI selection context.
- Non-test callers / B4: commands/motion.ts and program menu; observed seam: layer patch math and registered layer-edit commands.
- B2/B3: The named failure is user/caller-visible at that seam. Specified geometric invariant/tolerance, literal fixture dimensions and independent shared layer-matrix evaluation; never a second call to the edited transform solver for its expected answer.
- B5: Refactoring internals while preserving layer patch math and registered layer-edit commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 100. REWRITE: `apps/web/test/program-layer-menu.test.tsx` — moves the anchor to each grid point of the visible rect without moving a pixel

- Failure detected / B2: A missing/wrong grid entry or wrong flip/rotation compensation silently moves the image.
- Independent contract / B1: S03 XF-038 defines the nine visible-rectangle anchor grid points and preservation of image position.
- Independent oracle / B3 and rewrite: Use an independent literal nine-point table on a cropped, 90-degree rotated and horizontally flipped fixture; require literal anchor and compensated position values.
- Stable seam / B4: anchorPatch returned Motion values. Non-test callers: commands/layer.ts plus shell and Program context menus.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: The command test covers selection/dispatch; this lower owner covers every grid location and transform compensation without enumerating production ANCHOR_POINTS.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 101. KEEP: `apps/web/test/program-layer-menu.test.tsx` — Fit to Frame / Fill Frame / Set to Native: one step each, keyed at the playhead when animated

- Failure detected: Fit to Frame / Fill Frame / Set to Native: one step each, keyed at the playhead when animated. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 XF-038/051 and S02 TL-266 editing requirements.
- Remaining stronger coverage / B6: project param edits do not own fit/crop/anchor decisions or UI selection context.
- Non-test callers / B4: commands/motion.ts and program menu; observed seam: layer patch math and registered layer-edit commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving layer patch math and registered layer-edit commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 102. KEEP: `apps/web/test/program-layer-menu.test.tsx` — Reset Motion and Reset Crop reuse Remove Attributes; Reset Crop needs a crop

- Failure detected: Reset Motion and Reset Crop reuse Remove Attributes; Reset Crop needs a crop. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 XF-038/051 and S02 TL-266 editing requirements.
- Remaining stronger coverage / B6: project param edits do not own fit/crop/anchor decisions or UI selection context.
- Non-test callers / B4: commands/motion.ts and program menu; observed seam: layer patch math and registered layer-edit commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving layer patch math and registered layer-edit commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 103. KEEP: `apps/web/test/program-layer-menu.test.tsx` — Anchor ▸ Top Left keeps the layer where it is

- Failure detected: Anchor ▸ Top Left keeps the layer where it is. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 XF-038/051 and S02 TL-266 editing requirements.
- Remaining stronger coverage / B6: project param edits do not own fit/crop/anchor decisions or UI selection context.
- Non-test callers / B4: commands/motion.ts and program menu; observed seam: layer patch math and registered layer-edit commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving layer patch math and registered layer-edit commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 104. KEEP: `apps/web/test/program-layer-menu.test.tsx` — Arrange ▸ Bring Forward moves the video to a new track and leaves its linked audio alone

- Failure detected: Arrange ▸ Bring Forward moves the video to a new track and leaves its linked audio alone. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 XF-038/051 and S02 TL-266 editing requirements.
- Remaining stronger coverage / B6: project param edits do not own fit/crop/anchor decisions or UI selection context.
- Non-test callers / B4: commands/motion.ts and program menu; observed seam: layer patch math and registered layer-edit commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving layer patch math and registered layer-edit commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 105. KEEP: `apps/web/test/program-layer-menu.test.tsx` — Bring to Front above the top track creates a video track (S02:TL-266)

- Failure detected: Bring to Front above the top track creates a video track (S02:TL-266). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 XF-038/051 and S02 TL-266 editing requirements.
- Remaining stronger coverage / B6: project param edits do not own fit/crop/anchor decisions or UI selection context.
- Non-test callers / B4: commands/motion.ts and program menu; observed seam: layer patch math and registered layer-edit commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving layer patch math and registered layer-edit commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 106. KEEP: `apps/web/test/program-layer-menu.test.tsx` — Reveal in Project selects the media item and is disabled for sequence-only text

- Failure detected: Reveal in Project selects the media item and is disabled for sequence-only text. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 XF-038/051 and S02 TL-266 editing requirements.
- Remaining stronger coverage / B6: project param edits do not own fit/crop/anchor decisions or UI selection context.
- Non-test callers / B4: commands/motion.ts and program menu; observed seam: layer patch math and registered layer-edit commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving layer patch math and registered layer-edit commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-layer-menu.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 107. REWRITE: `apps/web/test/program-math.test.ts` — zooms around the cursor keeping the sequence point fixed within 1 px (AC-PGM-3)

- Failure detected / B2: Matching errors in computeView/toSequence/toScreen can conceal a viewport jump.
- Independent contract / B1: S03 PGM-011/012/020 and AC-PGM-3 specify 16px fit padding and cursor-fixed zoom.
- Independent oracle / B3 and rewrite: Use a 1952x1112 viewport around a 1920x1080 frame: the fit origin is [16,16], pointer [1116,416] maps to [1100,400], and 25/100/400% zoom pans are fixed literals.
- Stable seam / B4: viewport public mapping and zoomAround return values. Non-test callers: Program viewport and overlay.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: DOM interaction tests own input dispatch; this lowest mathematical seam owns pixel-to-sequence conversion and cursor compensation.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 108. REWRITE: `apps/web/test/program-math.test.ts` — clamps pan so at least 10 % / 48 px of the frame stays visible

- Failure detected / B2: Wrong clamp/centering shared by clampPan and computeView could leave the whole frame offscreen.
- Independent contract / B1: S03 PGM-014 requires retaining at least 10% or 48 screen pixels of the frame.
- Independent oracle / B3 and rewrite: Check literal clamped pan values [1168,-732] at scale 1 and [448,-306] at scale 0.1, independently of computeView.
- Stable seam / B4: clampPan return value. Non-test callers: Program viewport zoom/pan handler.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This is the lowest owner of the explicit visibility bound; higher interaction tests do not cover both percentage and minimum-pixel branches.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 109. KEEP: `apps/web/test/program-math.test.ts` — picks the topmost layer whose quad contains the point, skipping locked tracks (XF-001)

- Failure detected: picks the topmost layer whose quad contains the point, skipping locked tracks (XF-001). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 PGM-010..014, XF-001/030..037 and AC-PGM-3/AC-XF-1/AC-SNP-1/2.
- Remaining stronger coverage / B6: these numerical editing tolerances are specified acceptance cases; DOM smoke lacks rotated/scaled boundary matrix.
- Non-test callers / B4: TransformOverlay and ProgramPanel; observed seam: coordinate transforms/hit tests/snap calculations used by Program gestures.
- B2/B3: The named failure is user/caller-visible at that seam. Specified geometric invariant/tolerance, literal fixture dimensions and independent shared layer-matrix evaluation; never a second call to the edited transform solver for its expected answer.
- B5: Refactoring internals while preserving coordinate transforms/hit tests/snap calculations used by Program gestures outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 110. REWRITE: `apps/web/test/program-math.test.ts` — moves every handle onto the cursor with ≤ 1 screen px error at 25/100/400 % (AC-XF-1)

- Failure detected / B2: Wrong axis, inverse rotation or scale factors can pass when expected pointer and resulting image both use the same matrix helper.
- Independent contract / B1: S03 XF-029/030 and AC-XF-1 specify all eight handle drags on the rotated 37-degree, 150%/80%, left-cropped fixture.
- Independent oracle / B3 and rewrite: Use eight literal sequence-space cursor positions derived from the documented transform equation and require independently chosen 120%/60% targets (unchanged axis on edge handles); remove ineffective post-hoc zoom multiplication.
- Stable seam / B4: scaleFromHandle returned Motion values. Non-test callers: TransformOverlay scaling gesture.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This is the lowest owner for gesture-to-parameter math; renderer matrix tests own drawing and UI tests own screen-to-sequence conversion.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 111. REWRITE: `apps/web/test/program-math.test.ts` — keeps the opposite handle fixed with Alt and writes position (XF-031)

- Failure detected / B2: A wrong opposite-handle mapping or shared matrix error moves the supposedly fixed point.
- Independent contract / B1: S03 XF-031 requires Alt scaling about the opposite handle and writing compensated position.
- Independent oracle / B3 and rewrite: Use eight literal 90-degree fixture pointer/position pairs with independently prescribed 200%/100% scales and unchanged edge axes.
- Stable seam / B4: scaleFromHandle aboutOpposite result. Non-test callers: TransformOverlay Alt scaling gesture.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This lower owner distinguishes all opposite mappings; package matrix tests and generic scale UI tests do not exercise them.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 112. REWRITE: `apps/web/test/program-math.test.ts` — scales uniformly by projection on corners and clamps instead of flipping (XF-030/032)

- Failure detected / B2: A wrong matrix-generated target can conceal projection errors or an axis mismatch.
- Independent contract / B1: S03 XF-030/032 specify uniform scaling, Shift inversion and the 0.1% non-flipping clamp.
- Independent oracle / B3 and rewrite: Use independent literal corner coordinates plus a perpendicular cursor offset that projects onto uniform 200%; require both scales to be 200% and retain literal clamp and inverted-mode outcomes.
- Stable seam / B4: scaleFromHandle result. Non-test callers: TransformOverlay scaling gesture.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This lower owner covers uniform projection/refusal of negative scaling; other cases cover free scaling.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 113. REWRITE: `apps/web/test/program-math.test.ts` — rotates with unwrapping, Shift 15° steps and the 90° snap (XF-035)

- Failure detected / B2: Generating pointer positions with the owner rotate helper can conceal a wrong orientation convention.
- Independent contract / B1: S03 XF-035 requires continuous rotation unwrapping, Shift 15-degree steps and the 90-degree snap.
- Independent oracle / B3 and rewrite: Feed two literal cardinal-point circuits and retain independently specified 730-degree final rotation and 15/90-degree snap outcomes.
- Stable seam / B4: RotationTracker and snapRotation. Non-test callers: TransformOverlay rotation gesture.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This lower owner uniquely covers multiple complete turns and snap thresholds.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 114. REWRITE: `apps/web/test/program-math.test.ts` — moves the anchor without moving the image (XF-037, AC-XF-2 logic)

- Failure detected / B2: A wrong matrix shared by expected and actual image mapping can hide wrong anchor/position values.
- Independent contract / B1: S03 XF-037 explicitly specifies anchor compensation without image movement.
- Independent oracle / B3 and rewrite: For the documented 37-degree nonuniform fixture and [37,-12] drag, require literal anchor [334.8851557292835,140.18652252850836] and position [937,488], from the independent S03 transform equation.
- Stable seam / B4: moveAnchor returned Motion values. Non-test callers: TransformOverlay anchor gesture.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This lowest operation owner covers inverse rotation/scale compensation; rendering tests own matrix application.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 115. KEEP: `apps/web/test/program-math.test.ts` — engages within 6 ± 1 screen px at 50 % and 200 % (AC-SNP-1)

- Failure detected: engages within 6 ± 1 screen px at 50 % and 200 % (AC-SNP-1). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 PGM-010..014, XF-001/030..037 and AC-PGM-3/AC-XF-1/AC-SNP-1/2.
- Remaining stronger coverage / B6: these numerical editing tolerances are specified acceptance cases; DOM smoke lacks rotated/scaled boundary matrix.
- Non-test callers / B4: TransformOverlay and ProgramPanel; observed seam: coordinate transforms/hit tests/snap calculations used by Program gestures.
- B2/B3: The named failure is user/caller-visible at that seam. Specified geometric invariant/tolerance, literal fixture dimensions and independent shared layer-matrix evaluation; never a second call to the edited transform solver for its expected answer.
- B5: Refactoring internals while preserving coordinate transforms/hit tests/snap calculations used by Program gestures outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 116. KEEP: `apps/web/test/program-math.test.ts` — prefers the nearest target, then center-to-center (AC-SNP-2)

- Failure detected: prefers the nearest target, then center-to-center (AC-SNP-2). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 PGM-010..014, XF-001/030..037 and AC-PGM-3/AC-XF-1/AC-SNP-1/2.
- Remaining stronger coverage / B6: these numerical editing tolerances are specified acceptance cases; DOM smoke lacks rotated/scaled boundary matrix.
- Non-test callers / B4: TransformOverlay and ProgramPanel; observed seam: coordinate transforms/hit tests/snap calculations used by Program gestures.
- B2/B3: The named failure is user/caller-visible at that seam. Specified geometric invariant/tolerance, literal fixture dimensions and independent shared layer-matrix evaluation; never a second call to the edited transform solver for its expected answer.
- B5: Refactoring internals while preserving coordinate transforms/hit tests/snap calculations used by Program gestures outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/program-math.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 117. REWRITE: `apps/web/test/properties.test.tsx` — AC-INS-1: mixed scales show – and a +10 drag gives 60/90/110 as one undo step

- Failure detected: AC-INS-1: mixed scales show – and a +10 drag gives 60/90/110 as one undo step. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 §14 AC-INS-1; S05 PRP inspector editing.
- Remaining stronger coverage / B6: param command tests cannot detect wrong relative-edit/UI binding or content-time conversion.
- Non-test callers / B4: PropertiesPanel inspector controls; observed seam: PropertiesPanel events and committed parameters/history.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving PropertiesPanel events and committed parameters/history outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop mixed-value glyph wording; keep multi-selection values and undo.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/properties.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 118. KEEP: `apps/web/test/properties.test.tsx` — typed relative entry changes each clip and an expression sets all clips

- Failure detected: typed relative entry changes each clip and an expression sets all clips. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 §14 AC-INS-1; S05 PRP inspector editing.
- Remaining stronger coverage / B6: param command tests cannot detect wrong relative-edit/UI binding or content-time conversion.
- Non-test callers / B4: PropertiesPanel inspector controls; observed seam: PropertiesPanel events and committed parameters/history.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving PropertiesPanel events and committed parameters/history outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/properties.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 119. KEEP: `apps/web/test/properties.test.tsx` — the ◆ toggle creates a key at the playhead content time and removes it again

- Failure detected: the ◆ toggle creates a key at the playhead content time and removes it again. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 §14 AC-INS-1; S05 PRP inspector editing.
- Remaining stronger coverage / B6: param command tests cannot detect wrong relative-edit/UI binding or content-time conversion.
- Non-test callers / B4: PropertiesPanel inspector controls; observed seam: PropertiesPanel events and committed parameters/history.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving PropertiesPanel events and committed parameters/history outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/properties.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 120. KEEP: `apps/web/test/properties.test.tsx` — crop edits create the jasper.crop effect at index 0 on first edit

- Failure detected: crop edits create the jasper.crop effect at index 0 on first edit. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 §14 AC-INS-1; S05 PRP inspector editing.
- Remaining stronger coverage / B6: param command tests cannot detect wrong relative-edit/UI binding or content-time conversion.
- Non-test callers / B4: PropertiesPanel inspector controls; observed seam: PropertiesPanel events and committed parameters/history.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving PropertiesPanel events and committed parameters/history outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/properties.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 121. KEEP: `apps/web/test/pwa.test.ts` — leaves %s outside its cache

- Failure detected: leaves %s outside its cache. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 PWA-004 and Fetch/ServiceWorker protocol.
- Remaining stronger coverage / B6: engine HTTP tests do not own browser interception/cache bypass.
- Non-test callers / B4: main.tsx registration and browser service worker; observed seam: executed worker fetch events and service-worker registration.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving executed worker fetch events and service-worker registration outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/pwa.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 122. KEEP: `apps/web/test/pwa.test.ts` — returns a network error for an uncached asset while offline

- Failure detected: returns a network error for an uncached asset while offline. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 PWA-004 and Fetch/ServiceWorker protocol.
- Remaining stronger coverage / B6: engine HTTP tests do not own browser interception/cache bypass.
- Non-test callers / B4: main.tsx registration and browser service worker; observed seam: executed worker fetch events and service-worker registration.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving executed worker fetch events and service-worker registration outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/pwa.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 123. KEEP: `apps/web/test/pwa.test.ts` — registers only in production web builds with service-worker support

- Failure detected: registers only in production web builds with service-worker support. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 PWA-004 and Fetch/ServiceWorker protocol.
- Remaining stronger coverage / B6: engine HTTP tests do not own browser interception/cache bypass.
- Non-test callers / B4: main.tsx registration and browser service worker; observed seam: executed worker fetch events and service-worker registration.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving executed worker fetch events and service-worker registration outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/pwa.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 124. KEEP: `apps/web/test/shell.test.tsx` — drops unknown panel kinds from a saved layout (SH-023)

- Failure detected: drops unknown panel kinds from a saved layout (SH-023). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 125. REWRITE: `apps/web/test/shell.test.tsx` — a newer workspace storage version falls back without loading its data (SH-021)

- Failure detected / B2: Changing the storage key alongside the imported test key can hide loss of existing workspace preferences.
- Independent contract / B1: S05 SH-021 and docs/wp-notes/WP-2A.md specify versioned jasper:workspaces storage compatibility.
- Independent oracle / B3 and rewrite: Seed and inspect the literal 'jasper:workspaces' key, while retaining the independent newer-version reset expectations.
- Stable seam / B4: WorkspaceStore loading persisted ShellStorage bytes. Non-test callers: WorkspaceStore in the application shell.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: Other stores do not own this historical storage path; shell rendering does not verify its version fallback.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 126. REWRITE: `apps/web/test/shell.test.tsx` — ignores inherited object keys as workspace ids (storage and workspace.switch args)

- Failure detected / B2: A wrong storage key causes a malformed fixture to be skipped rather than exercising prototype-key rejection.
- Independent contract / B1: S05 SH-020/024 and AGENTS entry validation require ignoring prototype keys in stored workspace ids.
- Independent oracle / B3 and rewrite: Seed the documented literal 'jasper:workspaces' key so the negative fixture reaches the owner; preserve constructor/toString rejection and default state assertions.
- Stable seam / B4: WorkspaceStore persisted input and setActive. Non-test callers: application shell workspace commands.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This lowest storage seam uniquely guards inherited-key rejection; rendering has no equivalent malformed-id case.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 127. REWRITE: `apps/web/test/shell.test.tsx` — state saved by a build that had the Agent panel still loads (wp-mcp)

- Failure detected / B2: A renamed shared key can discard all old data while fallback defaults make most assertions pass.
- Independent contract / B1: docs/wp-notes/wp-mcp.md retired Agent workspace compatibility and WP-2A persisted path.
- Independent oracle / B3 and rewrite: Seed historical bytes under literal 'jasper:workspaces'; require retained custom workspace plus retired Agent fallback.
- Stable seam / B4: WorkspaceStore historical persisted input. Non-test callers: application shell workspace initialization.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This lowest compatibility seam uniquely verifies preserving custom data while removing a retired built-in.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## 128. KEEP: `apps/web/test/shell.test.tsx` — persists a saved workspace and imports a duplicate name with a suffix (WS-010, WS-014)

- Failure detected: persists a saved workspace and imports a duplicate name with a suffix (WS-010, WS-014). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 129. KEEP: `apps/web/test/shell.test.tsx` — AC-KB-1: = zooms thumbnails in Project and the timeline when Timeline is focused

- Failure detected: AC-KB-1: = zooms thumbnails in Project and the timeline when Timeline is focused. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 130. KEEP: `apps/web/test/shell.test.tsx` — AC-KB-2: typing "j" in a search field does not shuttle; Ctrl+S still saves

- Failure detected: AC-KB-2: typing "j" in a search field does not shuttle; Ctrl+S still saves. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 131. KEEP: `apps/web/test/shell.test.tsx` — a widget that consumes a key wins; otherwise the command runs after it

- Failure detected: a widget that consumes a key wins; otherwise the command runs after it. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 132. KEEP: `apps/web/test/shell.test.tsx` — repeat only for repeatable commands; keyup reaches hold-to-act commands (KB-006/007)

- Failure detected: repeat only for repeatable commands; keyup reaches hold-to-act commands (KB-006/007). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 133. KEEP: `apps/web/test/shell.test.tsx` — Esc during a pointer drag is left to the drag; after the release it runs gesture.cancel (XF-053)

- Failure detected: Esc during a pointer drag is left to the drag; after the release it runs gesture.cancel (XF-053). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 134. KEEP: `apps/web/test/shell.test.tsx` — disabled commands fall through to an enabled global binding (KB-002)

- Failure detected: disabled commands fall through to an enabled global binding (KB-002). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 135. KEEP: `apps/web/test/shell.test.tsx` — keys in a modal dialog reach its controls: Enter / Space / ↓ open a focused Select, no shortcut runs

- Failure detected: keys in a modal dialog reach its controls: Enter / Space / ↓ open a focused Select, no shortcut runs. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 136. KEEP: `apps/web/test/shell.test.tsx` — formats shortcuts per platform (MN-004)

- Failure detected: formats shortcuts per platform (MN-004). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 137. KEEP: `apps/web/test/shell.test.tsx` — unregistered commands stay visible but disabled with a reason; undo shows the step name

- Failure detected: unregistered commands stay visible but disabled with a reason; undo shows the step name. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 138. KEEP: `apps/web/test/shell.test.tsx` — capability-gated commands explain what is missing; edit-only menus are disabled outside Edit (MN-010)

- Failure detected: capability-gated commands explain what is missing; edit-only menus are disabled outside Edit (MN-010). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 SH-020..023/WS-010/014, KB-002/006/007, MN-004/010/011.
- Remaining stronger coverage / B6: project persistence/command tests do not own browser layout, focus or shortcut precedence.
- Non-test callers / B4: shell workspace store, key dispatcher and MenuBar; observed seam: versioned workspace storage, keyboard DOM events and resolved menus.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving versioned workspace storage, keyboard DOM events and resolved menus outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/shell.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 139. REWRITE: `apps/web/test/speech.test.tsx` — sends model, language, translate and speaker options for the media of a sequence

- Failure detected: sends model, language, translate and speaker options for the media of a sequence. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 speech/transcription; docs/wp-notes/speech.md; AGENTS §0.
- Remaining stronger coverage / B6: engine/model tests do not map user options/import events or finished jobs to session changes.
- Non-test callers / B4: speech UI and commands/speech.ts; observed seam: GenerateTranscriptDialog/auto host, request options and finished-job attachment.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving GenerateTranscriptDialog/auto host, request options and finished-job attachment outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop transcription summary wording; retain exact HTTP request option mapping.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/speech.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 140. KEEP: `apps/web/test/speech.test.tsx` — shows the licence of a missing model and downloads it before transcribing

- Failure detected: shows the licence of a missing model and downloads it before transcribing. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 speech/transcription; docs/wp-notes/speech.md; AGENTS §0.
- Remaining stronger coverage / B6: engine/model tests do not map user options/import events or finished jobs to session changes.
- Non-test callers / B4: speech UI and commands/speech.ts; observed seam: GenerateTranscriptDialog/auto host, request options and finished-job attachment.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving GenerateTranscriptDialog/auto host, request options and finished-job attachment outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/speech.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 141. KEEP: `apps/web/test/speech.test.tsx` — English-only models fix the language and cannot translate

- Failure detected: English-only models fix the language and cannot translate. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 speech/transcription; docs/wp-notes/speech.md; AGENTS §0.
- Remaining stronger coverage / B6: engine/model tests do not map user options/import events or finished jobs to session changes.
- Non-test callers / B4: speech UI and commands/speech.ts; observed seam: GenerateTranscriptDialog/auto host, request options and finished-job attachment.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving GenerateTranscriptDialog/auto host, request options and finished-job attachment outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/speech.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 142. REWRITE: `apps/web/test/speech.test.tsx` — commit one "Generate Transcript" step the sequence transcript reads; undo removes it

- Failure detected: commit one "Generate Transcript" step the sequence transcript reads; undo removes it. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 speech/transcription; docs/wp-notes/speech.md; AGENTS §0.
- Remaining stronger coverage / B6: engine/model tests do not map user options/import events or finished jobs to session changes.
- Non-test callers / B4: speech UI and commands/speech.ts; observed seam: GenerateTranscriptDialog/auto host, request options and finished-job attachment.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving GenerateTranscriptDialog/auto host, request options and finished-job attachment outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop toast title wording; retain attached transcript timeline mapping and undo.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/speech.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 143. KEEP: `apps/web/test/speech.test.tsx` — a sequence-mix result goes to the clip media in media time, and is refused after an edit

- Failure detected: a sequence-mix result goes to the clip media in media time, and is refused after an edit. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 speech/transcription; docs/wp-notes/speech.md; AGENTS §0.
- Remaining stronger coverage / B6: engine/model tests do not map user options/import events or finished jobs to session changes.
- Non-test callers / B4: speech UI and commands/speech.ts; observed seam: GenerateTranscriptDialog/auto host, request options and finished-job attachment.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving GenerateTranscriptDialog/auto host, request options and finished-job attachment outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/speech.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 144. DELETE: `apps/web/test/speech.test.tsx` — lists models with licence and size; deletes a downloaded one after confirmation

- Failure detected: lists models with licence and size; deletes a downloaded one after confirmation. Name claims deletion/confirmation but body never performs either; only checks fixture-driven model text and initial HTTP call. Download-license behavior is already covered by retained Generate Transcript tests.
- Independent contract / B1: S04 speech/transcription; docs/wp-notes/speech.md; AGENTS §0.
- Remaining stronger coverage / B6: engine/model tests do not map user options/import events or finished jobs to session changes.
- Non-test callers / B4: speech UI and commands/speech.ts; observed seam: GenerateTranscriptDialog/auto host, request options and finished-job attachment.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/speech.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 145. DELETE: `apps/web/test/speech.test.tsx` — registers the commands and menu entries

- Failure detected: registers the commands and menu entries. Command/menu registration inventory duplicates declarative production tables and misses broken actions.
- Independent contract / B1: S04 speech/transcription; docs/wp-notes/speech.md; AGENTS §0.
- Remaining stronger coverage / B6: engine/model tests do not map user options/import events or finished jobs to session changes.
- Non-test callers / B4: speech UI and commands/speech.ts; observed seam: GenerateTranscriptDialog/auto host, request options and finished-job attachment.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/speech.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 146. KEEP: `apps/web/test/speech.test.tsx` — transcribes newly imported media with sound when enabled (not on undo/redo)

- Failure detected: transcribes newly imported media with sound when enabled (not on undo/redo). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 speech/transcription; docs/wp-notes/speech.md; AGENTS §0.
- Remaining stronger coverage / B6: engine/model tests do not map user options/import events or finished jobs to session changes.
- Non-test callers / B4: speech UI and commands/speech.ts; observed seam: GenerateTranscriptDialog/auto host, request options and finished-job attachment.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving GenerateTranscriptDialog/auto host, request options and finished-job attachment outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/speech.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 147. REWRITE: `apps/web/test/test-timeout.test.ts` — is 15 s on a quiet host, grows with the square of the load factor, and is capped at a minute

- Failure detected / B2: An incorrect exported timeout can cause false failures on a busy host or leave a hung test running beyond one minute; a missing configuration value silently restores Vitest's too-short default.
- Independent contract / B1: `docs/performance.md`, “Test timeouts of the web project,” specifies 5 s × loadFactor² with a 15 s floor and 60 s ceiling, following observed false failures in project-windowing, shell-render and speech.
- Independent oracle / B3: Fixed outputs 15,000, 20,000, 45,000 and 60,000 ms for explicit calibration inputs; expected values are literals, never computed by the implementation under test. The calibration input is controlled; the exported timeout is real.
- Stable seam / B4 and non-test callers: The default exported `apps/web/vitest.config.ts` project configuration is consumed by Vitest. The private timeout helper has no outside production caller and stays unexported.
- Refactor stability / B5: Read only the exported `test.testTimeout` configuration property; renaming, moving or inlining the private arithmetic does not affect the assertion.
- Lowest owner / B6 and remaining stronger coverage: The project configuration is the lowest public seam that owns these web-specific bounds. Running the suite does not reliably detect wrong limits on a quiet host, and performance-budget tests do not own this configuration.
- Rewrite: Replace direct private-helper calls with importing the public configuration under controlled load/PERF inputs. Keep the helper's export removed.
- Risk: No production change. Module isolation must re-evaluate configuration for each controlled environment; runtime validation remains pending the coordinated integration run.
- Validation: `pnpm exec vitest run apps/web/test/test-timeout.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 148. REWRITE: `apps/web/test/test-timeout.test.ts` — PERF=1 keeps the strict 5 s whatever the load

- Failure detected / B2: Applying relaxed shared-host timeouts in strict PERF mode masks slow tests that the documented strict run must reject.
- Independent contract / B1: `docs/performance.md`, “Test timeouts of the web project,” explicitly requires PERF=1 to retain Vitest's 5 s limit regardless of host load.
- Independent oracle / B3: The specified 5,000 ms literal is checked with both quiet and high calibration inputs; expected output does not invoke the implementation or reproduce its branching.
- Stable seam / B4 and non-test callers: Read the default Vitest project configuration consumed by the runner. Mock only the external calibration module's load and strict-mode inputs, not the asserted configuration.
- Refactor stability / B5: The assertion survives replacement, inlining or renaming of the timeout helper because only the runner's public `test.testTimeout` property is observed.
- Lowest owner / B6 and remaining stronger coverage: The web project configuration owns the strict override. Budget-calibration tests cannot protect this use of it, and the ordinary suite does not exercise PERF mode deterministically.
- Rewrite: Import the default configuration with strict calibration inputs instead of exporting and calling its private helper.
- Risk: No production change. The strict branch needs focused runtime validation after integration; no passing result is claimed yet.
- Validation: `pnpm exec vitest run apps/web/test/test-timeout.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 149. DELETE: `apps/web/test/test-timeout.test.ts` — this run is configured with it: never unlimited, never above the ceiling

- Failure detected: A timeout outside the documented bounds in the current test's own Vitest task metadata.
- Independent contract / B1: `docs/performance.md` specifies finite bounded timeouts, but this case observes only the current host/mode and duplicates the configuration output contract.
- Remaining stronger coverage / B6: Rewritten cases 147–148 read the actual exported configuration under deterministic floor, scaling, ceiling and strict inputs. They also catch omitted configuration properties, with broader boundary coverage than this current-run assertion.
- Non-test callers / B4: Vitest consumes the default project configuration; task metadata belongs to the runner's execution layer.
- Risk: Low: the configuration bounds and strict override remain protected at their public owner seam. This duplicate adds no distinct credible failure.
- Validation: `pnpm exec vitest run apps/web/test/test-timeout.test.ts --maxWorkers=1`.

## 150. KEEP: `apps/web/test/timeline-gestures.test.ts` — rounds the pointer delta to frames and commits exactly one history entry

- Failure detected: rounds the pointer delta to frames and commits exactly one history entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 151. KEEP: `apps/web/test/timeline-gestures.test.ts` — AC-10d: Escape during a drag restores everything and creates no undo entry

- Failure detected: AC-10d: Escape during a drag restores everything and creates no undo entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 152. KEEP: `apps/web/test/timeline-gestures.test.ts` — AC-9a: a clip whose end comes within 8 px of the playhead snaps onto it and shows the indicator

- Failure detected: AC-9a: a clip whose end comes within 8 px of the playhead snaps onto it and shows the indicator. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 153. KEEP: `apps/web/test/timeline-gestures.test.ts` — Ctrl at release performs an insert move (AC-10b through the gesture)

- Failure detected: Ctrl at release performs an insert move (AC-10b through the gesture). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 154. KEEP: `apps/web/test/timeline-gestures.test.ts` — Alt drag duplicates with overwrite; the originals stay

- Failure detected: Alt drag duplicates with overwrite; the originals stay. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 155. KEEP: `apps/web/test/timeline-gestures.test.ts` — vertical moves change tracks within the kind; linked audio keeps its track (TL-486)

- Failure detected: vertical moves change tracks within the kind; linked audio keeps its track (TL-486). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 156. KEEP: `apps/web/test/timeline-gestures.test.ts` — Shift after the start constrains to the dominant axis (TL-488)

- Failure detected: Shift after the start constrains to the dominant axis (TL-488). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 157. KEEP: `apps/web/test/timeline-gestures.test.ts` — clips on locked tracks cannot be grabbed (TL-481)

- Failure detected: clips on locked tracks cannot be grabbed (TL-481). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 158. KEEP: `apps/web/test/timeline-gestures.test.ts` — clicking selects the link group; Alt selects one side; clicking empty space deselects

- Failure detected: clicking selects the link group; Alt selects one side; clicking empty space deselects. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 159. KEEP: `apps/web/test/timeline-gestures.test.ts` — AC-8a: marquee over the video clip selects its linked audio; linked selection off selects only video

- Failure detected: AC-8a: marquee over the video clip selects its linked audio; linked selection off selects only video. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 160. KEEP: `apps/web/test/timeline-gestures.test.ts` — AC-8b: Shift-marquee over a selected clip deselects it and keeps the rest

- Failure detected: AC-8b: Shift-marquee over a selected clip deselects it and keeps the rest. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 161. KEEP: `apps/web/test/timeline-gestures.test.ts` — AC-8c and AC-7c: marquee selects 1 px clips but never clips on locked tracks

- Failure detected: AC-8c and AC-7c: marquee selects 1 px clips but never clips on locked tracks. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 162. KEEP: `apps/web/test/timeline-gestures.test.ts` — Escape during a marquee restores the previous selection

- Failure detected: Escape during a marquee restores the previous selection. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 163. KEEP: `apps/web/test/timeline-gestures.test.ts` — clicking a gap selects it (TL-740)

- Failure detected: clicking a gap selects it (TL-740). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 164. KEEP: `apps/web/test/timeline-gestures.test.ts` — track select forward selects everything from the click on all unlocked tracks (TL-605)

- Failure detected: track select forward selects everything from the click on all unlocked tracks (TL-605). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 165. KEEP: `apps/web/test/timeline-gestures.test.ts` — regular trim stops at the neighbour and shows the limit indicator (AC-11b)

- Failure detected: regular trim stops at the neighbour and shows the limit indicator (AC-11b). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 166. KEEP: `apps/web/test/timeline-gestures.test.ts` — regular trim of the in edge by 10 frames

- Failure detected: regular trim of the in edge by 10 frames. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 167. KEEP: `apps/web/test/timeline-gestures.test.ts` — Ctrl-edge ripple trim and the Ripple tool (AC-11c path) create one entry

- Failure detected: Ctrl-edge ripple trim and the Ripple tool (AC-11c path) create one entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 168. KEEP: `apps/web/test/timeline-gestures.test.ts` — AC-11c: ripple trim stops at the largest amount a sync-locked track allows

- Failure detected: AC-11c: ripple trim stops at the largest amount a sync-locked track allows. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 169. KEEP: `apps/web/test/timeline-gestures.test.ts` — rolling tool (N) moves the edit point

- Failure detected: rolling tool (N) moves the edit point. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 170. KEEP: `apps/web/test/timeline-gestures.test.ts` — slip (Y) changes source time in one history entry

- Failure detected: slip (Y) changes source time in one history entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 171. KEEP: `apps/web/test/timeline-gestures.test.ts` — razor (C) click splits once; Shift splits all unlocked tracks; Alt ignores links

- Failure detected: razor (C) click splits once; Shift splits all unlocked tracks; Alt ignores links. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 172. KEEP: `apps/web/test/timeline-gestures.test.ts` — razor snaps to the playhead even with snapping off (TL-620)

- Failure detected: razor snaps to the playhead even with snapping off (TL-620). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 173. KEEP: `apps/web/test/timeline-gestures.test.ts` — rate stretch doubles the duration and halves the speed (AC-12d through the tool)

- Failure detected: rate stretch doubles the duration and halves the speed (AC-12d through the tool). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 174. KEEP: `apps/web/test/timeline-gestures.test.ts` — Escape cancels a trim with no entry

- Failure detected: Escape cancels a trim with no entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 175. KEEP: `apps/web/test/timeline-gestures.test.ts` — AC-3c: \\ then \\ returns to the exact prior zoom and scroll

- Failure detected: AC-3c: \\ then \\ returns to the exact prior zoom and scroll. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 176. KEEP: `apps/web/test/timeline-gestures.test.ts` — Alt+wheel zooms around the pointer

- Failure detected: Alt+wheel zooms around the pointer. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 177. KEEP: `apps/web/test/timeline-gestures.test.ts` — ruler scrubbing seeks with the floor rule and Shift snaps to markers (AC-9b)

- Failure detected: ruler scrubbing seeks with the floor rule and Shift snaps to markers (AC-9b). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-400..406/480..491/530..549/610..632/740, AC-3/8/9/10/11/12.
- Remaining stronger coverage / B6: project commands do not own pointer hit targets, modifiers, cancellation or gesture history.
- Non-test callers / B4: TimelinePanel via timeline env/controller; observed seam: TimelineController pointer/key/wheel inputs and session document/selection.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving TimelineController pointer/key/wheel inputs and session document/selection outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-gestures.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 178. DELETE: `apps/web/test/timeline-model.test.ts` — xToFrame(frameToX(f)) = f across zoom levels and scroll positions

- Failure detected: xToFrame(frameToX(f)) = f across zoom levels and scroll positions. Converts with production frameToX then inverts with production xToFrame; reciprocal bugs may cancel. Retained fixed-delta and actual gesture/ruler tests own frame targeting.
- Independent contract / B1: S02 TL-100..113; S04 TH-003/WF-001/003; AC-7b.
- Remaining stronger coverage / B6: gesture samples do not cover exact rounding ties, cache tile protocol or peak reduction.
- Non-test callers / B4: timeline controller, filmstrip and waveform painters; observed seam: viewport input mapping, thumbnail index and waveform values.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/timeline-model.test.ts --maxWorkers=1` (remaining owner files if this file is deleted).

## 179. KEEP: `apps/web/test/timeline-model.test.ts` — AC-3a: a 3 h 29.97 sequence zooms to ≥ 40 px per frame anywhere and trims move 1 frame per 40 px

- Failure detected: AC-3a: a 3 h 29.97 sequence zooms to ≥ 40 px per frame anywhere and trims move 1 frame per 40 px. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-100..113; S04 TH-003/WF-001/003; AC-7b.
- Remaining stronger coverage / B6: gesture samples do not cover exact rounding ties, cache tile protocol or peak reduction.
- Non-test callers / B4: timeline controller, filmstrip and waveform painters; observed seam: viewport input mapping, thumbnail index and waveform values.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving viewport input mapping, thumbnail index and waveform values outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-model.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 180. KEEP: `apps/web/test/timeline-model.test.ts` — wheel mapping follows TL-111

- Failure detected: wheel mapping follows TL-111. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-100..113; S04 TH-003/WF-001/003; AC-7b.
- Remaining stronger coverage / B6: gesture samples do not cover exact rounding ties, cache tile protocol or peak reduction.
- Non-test callers / B4: timeline controller, filmstrip and waveform painters; observed seam: viewport input mapping, thumbnail index and waveform values.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving viewport input mapping, thumbnail index and waveform values outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-model.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 181. KEEP: `apps/web/test/timeline-model.test.ts` — nearest target within the threshold wins, then priority

- Failure detected: nearest target within the threshold wins, then priority. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-100..113; S04 TH-003/WF-001/003; AC-7b.
- Remaining stronger coverage / B6: gesture samples do not cover exact rounding ties, cache tile protocol or peak reduction.
- Non-test callers / B4: timeline controller, filmstrip and waveform painters; observed seam: viewport input mapping, thumbnail index and waveform values.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving viewport input mapping, thumbnail index and waveform values outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-model.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 182. KEEP: `apps/web/test/timeline-model.test.ts` — uses the nearest tile at or before the requested time

- Failure detected: uses the nearest tile at or before the requested time. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-100..113; S04 TH-003/WF-001/003; AC-7b.
- Remaining stronger coverage / B6: gesture samples do not cover exact rounding ties, cache tile protocol or peak reduction.
- Non-test callers / B4: timeline controller, filmstrip and waveform painters; observed seam: viewport input mapping, thumbnail index and waveform values.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving viewport input mapping, thumbnail index and waveform values outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-model.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 183. KEEP: `apps/web/test/timeline-model.test.ts` — takes the max over the peaks covered by each column

- Failure detected: takes the max over the peaks covered by each column. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-100..113; S04 TH-003/WF-001/003; AC-7b.
- Remaining stronger coverage / B6: gesture samples do not cover exact rounding ties, cache tile protocol or peak reduction.
- Non-test callers / B4: timeline controller, filmstrip and waveform painters; observed seam: viewport input mapping, thumbnail index and waveform values.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving viewport input mapping, thumbnail index and waveform values outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-model.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 184. KEEP: `apps/web/test/timeline-model.test.ts` — AC-7b: -6 dB halves the drawn amplitude; clipping is flagged

- Failure detected: AC-7b: -6 dB halves the drawn amplitude; clipping is flagged. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-100..113; S04 TH-003/WF-001/003; AC-7b.
- Remaining stronger coverage / B6: gesture samples do not cover exact rounding ties, cache tile protocol or peak reduction.
- Non-test callers / B4: timeline controller, filmstrip and waveform painters; observed seam: viewport input mapping, thumbnail index and waveform values.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving viewport input mapping, thumbnail index and waveform values outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-model.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 185. DELETE: `apps/web/test/timeline-panel.test.tsx` — virtualizes and scrolls 3 000 clips on 40 tracks; the playhead moves without React re-renders

- Failure detected: virtualizes and scrolls 3 000 clips on 40 tracks; the playhead moves without React re-renders. Asserts internal React render counts, mounted node counts and transform style. Behavior-preserving virtualization/render refactors fail it; actual editing workflows and performance suites remain.
- Independent contract / B1: S05 TOOL-001..005.
- Remaining stronger coverage / B6: pure toggle setters do not test tool button/flyout selection.
- Non-test callers / B4: shell tools panel; observed seam: ToolsPanel DOM action to shared active tool.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/timeline-panel.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 186. KEEP: `apps/web/test/timeline-panel.test.tsx` — clicking a button selects the tool; right-click opens the group flyout

- Failure detected: clicking a button selects the tool; right-click opens the group flyout. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S05 TOOL-001..005.
- Remaining stronger coverage / B6: pure toggle setters do not test tool button/flyout selection.
- Non-test callers / B4: shell tools panel; observed seam: ToolsPanel DOM action to shared active tool.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving ToolsPanel DOM action to shared active tool outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-panel.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 187. KEEP: `apps/web/test/timeline-peaks-stream.test.ts` — requests the peaks stream with the clip's container stream index (movie audio = stream 1)

- Failure detected: requests the peaks stream with the clip's container stream index (movie audio = stream 1). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S04 peak header container stream-index protocol; documented movie stream-1 regression.
- Remaining stronger coverage / B6: engine tests cannot detect browser confusing container index with audio-array index.
- Non-test callers / B4: timeline waveform renderer; observed seam: peaksFor HTTP URLs and decoded channel data.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving peaksFor HTTP URLs and decoded channel data outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/timeline-peaks-stream.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 188. KEEP: `apps/web/test/tracking-actions.test.tsx` — runs Track Forward: request body, live progress, one "Track" entry with the samples

- Failure detected: runs Track Forward: request body, live progress, one "Track" entry with the samples. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRK/TRU job/progress/retrack/cancel/overlay contracts.
- Remaining stronger coverage / B6: engine trackers/model application do not own UI lifecycle, duplicate events or linked reapply transaction.
- Non-test callers / B4: tracking section, command bindings and TrackingOverlay; observed seam: tracking job API/events and session document; overlay pointer edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving tracking job API/events and session document; overlay pointer edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-actions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 189. KEEP: `apps/web/test/tracking-actions.test.tsx` — passes the planar options and quality

- Failure detected: passes the planar options and quality. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRK/TRU job/progress/retrack/cancel/overlay contracts.
- Remaining stronger coverage / B6: engine trackers/model application do not own UI lifecycle, duplicate events or linked reapply transaction.
- Non-test callers / B4: tracking section, command bindings and TrackingOverlay; observed seam: tracking job API/events and session document; overlay pointer edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving tracking job API/events and session document; overlay pointer edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-actions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 190. KEEP: `apps/web/test/tracking-actions.test.tsx` — re-tracks from here and re-applies to the linked target inside the same "Track" entry

- Failure detected: re-tracks from here and re-applies to the linked target inside the same "Track" entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRK/TRU job/progress/retrack/cancel/overlay contracts.
- Remaining stronger coverage / B6: engine trackers/model application do not own UI lifecycle, duplicate events or linked reapply transaction.
- Non-test callers / B4: tracking section, command bindings and TrackingOverlay; observed seam: tracking job API/events and session document; overlay pointer edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving tracking job API/events and session document; overlay pointer edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-actions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 191. KEEP: `apps/web/test/tracking-actions.test.tsx` — stops a job without committing

- Failure detected: stops a job without committing. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRK/TRU job/progress/retrack/cancel/overlay contracts.
- Remaining stronger coverage / B6: engine trackers/model application do not own UI lifecycle, duplicate events or linked reapply transaction.
- Non-test callers / B4: tracking section, command bindings and TrackingOverlay; observed seam: tracking job API/events and session document; overlay pointer edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving tracking job API/events and session document; overlay pointer edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-actions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 192. KEEP: `apps/web/test/tracking-actions.test.tsx` — reports engine errors on the tracker

- Failure detected: reports engine errors on the tracker. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRK/TRU job/progress/retrack/cancel/overlay contracts.
- Remaining stronger coverage / B6: engine trackers/model application do not own UI lifecycle, duplicate events or linked reapply transaction.
- Non-test callers / B4: tracking section, command bindings and TrackingOverlay; observed seam: tracking job API/events and session document; overlay pointer edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving tracking job API/events and session document; overlay pointer edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-actions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 193. KEEP: `apps/web/test/tracking-actions.test.tsx` — finishes by polling when no event arrives

- Failure detected: finishes by polling when no event arrives. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRK/TRU job/progress/retrack/cancel/overlay contracts.
- Remaining stronger coverage / B6: engine trackers/model application do not own UI lifecycle, duplicate events or linked reapply transaction.
- Non-test callers / B4: tracking section, command bindings and TrackingOverlay; observed seam: tracking job API/events and session document; overlay pointer edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving tracking job API/events and session document; overlay pointer edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-actions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 194. KEEP: `apps/web/test/tracking-actions.test.tsx` — drags an edge (two corners) and the body (all corners), one entry each

- Failure detected: drags an edge (two corners) and the body (all corners), one entry each. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRK/TRU job/progress/retrack/cancel/overlay contracts.
- Remaining stronger coverage / B6: engine trackers/model application do not own UI lifecycle, duplicate events or linked reapply transaction.
- Non-test callers / B4: tracking section, command bindings and TrackingOverlay; observed seam: tracking job API/events and session document; overlay pointer edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving tracking job API/events and session document; overlay pointer edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-actions.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 195. KEEP: `apps/web/test/tracking-timeline.test.tsx` — maps the tracked span through a sourceIn trim and clips it to the clip

- Failure detected: maps the tracked span through a sourceIn trim and clips it to the clip. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving sample-to-frame boundary plus timeline DOM navigation outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 196. KEEP: `apps/web/test/tracking-timeline.test.tsx` — respects speed and reverse

- Failure detected: respects speed and reverse. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving sample-to-frame boundary plus timeline DOM navigation outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 197. KEEP: `apps/web/test/tracking-timeline.test.tsx` — takes both neighbours of a fractional sample index (other media rates)

- Failure detected: takes both neighbours of a fractional sample index (other media rates). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving sample-to-frame boundary plus timeline DOM navigation outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 198. REWRITE: `apps/web/test/tracking-timeline.test.tsx` — keeps a single lost frame among 1000 visible at low zoom

- Failure detected: keeps a single lost frame among 1000 visible at low zoom. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving sample-to-frame boundary plus timeline DOM navigation outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Rewrite: Drop exact strip x coordinates/run count; retain lost confidence and pointer identifying the isolated lost frame.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 199. DELETE: `apps/web/test/tracking-timeline.test.tsx` — classifies confidence

- Failure detected: classifies confidence. Private confidence-to-class thresholds mirror source branches; retained lost-frame aggregation protects the warning that matters.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 200. KEEP: `apps/web/test/tracking-timeline.test.tsx` — removes the target link glyph when its tracker is removed

- Failure detected: removes the target link glyph when its tracker is removed. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving sample-to-frame boundary plus timeline DOM navigation outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 201. KEEP: `apps/web/test/tracking-timeline.test.tsx` — clicking the badge selects the plate and cycles its active tracker

- Failure detected: clicking the badge selects the plate and cycles its active tracker. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving sample-to-frame boundary plus timeline DOM navigation outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 202. KEEP: `apps/web/test/tracking-timeline.test.tsx` — clicking the link glyph or a strip selects the plate and activates the tracker

- Failure detected: clicking the link glyph or a strip selects the plate and activates the tracker. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving sample-to-frame boundary plus timeline DOM navigation outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 203. DELETE: `apps/web/test/tracking-timeline.test.tsx` — stops the press from reaching the timeline with the Selection tool only

- Failure detected: stops the press from reaching the timeline with the Selection tool only. Checks pointer propagation to an arbitrary outer spy instead of an editing result. Badge selection/activation interaction tests remain.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- Risk: Low: deleting incidental/duplicated assertions only; owning behavior coverage cited above remains.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1` (remaining owner files if this file is deleted).

## 204. KEEP: `apps/web/test/tracking-timeline.test.tsx` — reveals closed sections immediately and when they mount after the request

- Failure detected: reveals closed sections immediately and when they mount after the request. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S09 TRU-005 content-time confidence strip and navigation.
- Remaining stronger coverage / B6: project trackers lack timeline source-time display and badge navigation responsibilities.
- Non-test callers / B4: timeline tracking glyphs/strips and Properties section; observed seam: sample-to-frame boundary plus timeline DOM navigation.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving sample-to-frame boundary plus timeline DOM navigation outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/tracking-timeline.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 205. KEEP: `apps/web/test/transitions-panels.test.tsx` — clearing a selected transition removes it in one undoable entry

- Failure detected: clearing a selected transition removes it in one undoable entry. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 TUI-015/020/031/040/041.
- Remaining stronger coverage / B6: project transition commands do not own UI selection dispatch and disabled controls.
- Non-test callers / B4: EffectsPanel/EffectControlsPanel/PropertiesPanel; observed seam: transition selection command, drag MIME and inspector DOM edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving transition selection command, drag MIME and inspector DOM edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transitions-panels.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 206. KEEP: `apps/web/test/transitions-panels.test.tsx` — offers transitions with drag data, default selection, and search

- Failure detected: offers transitions with drag data, default selection, and search. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 TUI-015/020/031/040/041.
- Remaining stronger coverage / B6: project transition commands do not own UI selection dispatch and disabled controls.
- Non-test callers / B4: EffectsPanel/EffectControlsPanel/PropertiesPanel; observed seam: transition selection command, drag MIME and inspector DOM edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving transition selection command, drag MIME and inspector DOM edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transitions-panels.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 207. KEEP: `apps/web/test/transitions-panels.test.tsx` — Effect Controls edits transition type, duration and alignment

- Failure detected: Effect Controls edits transition type, duration and alignment. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 TUI-015/020/031/040/041.
- Remaining stronger coverage / B6: project transition commands do not own UI selection dispatch and disabled controls.
- Non-test callers / B4: EffectsPanel/EffectControlsPanel/PropertiesPanel; observed seam: transition selection command, drag MIME and inspector DOM edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving transition selection command, drag MIME and inspector DOM edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transitions-panels.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 208. KEEP: `apps/web/test/transitions-panels.test.tsx` — Properties shows the section for a selected fade; alignment is disabled for one-sided fades

- Failure detected: Properties shows the section for a selected fade; alignment is disabled for one-sided fades. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S03 TUI-015/020/031/040/041.
- Remaining stronger coverage / B6: project transition commands do not own UI selection dispatch and disabled controls.
- Non-test callers / B4: EffectsPanel/EffectControlsPanel/PropertiesPanel; observed seam: transition selection command, drag MIME and inspector DOM edits.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving transition selection command, drag MIME and inspector DOM edits outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transitions-panels.test.tsx --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 209. KEEP: `apps/web/test/transport.test.ts` — L L L yields 4×; J then yields −1×; K stops (AC-18a)

- Failure detected: L L L yields 4×; J then yields −1×; K stops (AC-18a). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 210. KEEP: `apps/web/test/transport.test.ts` — hold K + tap L five times advances exactly five frames (AC-18c)

- Failure detected: hold K + tap L five times advances exactly five frames (AC-18c). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 211. KEEP: `apps/web/test/transport.test.ts` — hold K + hold L plays at 0.25× until release; repeats are ignored

- Failure detected: hold K + hold L plays at 0.25× until release; repeats are ignored. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 212. KEEP: `apps/web/test/transport.test.ts` — Space toggles 1× forward play; Shift+L/J steps the slow rate by 0.1

- Failure detected: Space toggles 1× forward play; Shift+L/J steps the slow rate by 0.1. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 213. KEEP: `apps/web/test/transport.test.ts` — restarts at 1× after the transport stopped on its own

- Failure detected: restarts at 1× after the transport stopped on its own. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 214. KEEP: `apps/web/test/transport.test.ts` — plays natively at 1×: the Player is the clock and frames are reported

- Failure detected: plays natively at 1×: the Player is the clock and frames are reported. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 215. KEEP: `apps/web/test/transport.test.ts` — re-issues play() when the Player does not start or stalls while playing (no frameupdate, not buffering) — WP-3I

- Failure detected: re-issues play() when the Player does not start or stalls while playing (no frameupdate, not buffering) — WP-3I. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 216. KEEP: `apps/web/test/transport.test.ts` — does not kick a Player that renders slowly; a real stall after slow frames is still kicked

- Failure detected: does not kick a Player that renders slowly; a real stall after slow frames is still kicked. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 217. KEEP: `apps/web/test/transport.test.ts` — a slow machine: the next play's slow first frame is not a stall; a real stall is still kicked

- Failure detected: a slow machine: the next play's slow first frame is not a stall; a real stall is still kicked. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 218. KEEP: `apps/web/test/transport.test.ts` — mutes audio below 1× (TL-874)

- Failure detected: mutes audio below 1× (TL-874). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 219. KEEP: `apps/web/test/transport.test.ts` — uses seek-stepping at 8×: timecode advances 8× real time, seeks ≤ 30/s (AC-18b)

- Failure detected: uses seek-stepping at 8×: timecode advances 8× real time, seeks ≤ 30/s (AC-18b). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 220. KEEP: `apps/web/test/transport.test.ts` — plays reverse by stepping and stops at 0

- Failure detected: plays reverse by stepping and stops at 0. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 221. KEEP: `apps/web/test/transport.test.ts` — stops at the sequence end, or loops In→Out when loop is on (TL-875)

- Failure detected: stops at the sequence end, or loops In→Out when loop is on (TL-875). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 222. KEEP: `apps/web/test/transport.test.ts` — Play In to Out stops on the last marked frame (TL-877)

- Failure detected: Play In to Out stops on the last marked frame (TL-877). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 223. KEEP: `apps/web/test/transport.test.ts` — follows external seeks while playing

- Failure detected: follows external seeks while playing. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 224. KEEP: `apps/web/test/transport.test.ts` — steps, jumps to start/end and edit points

- Failure detected: steps, jumps to start/end and edit points. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 225. KEEP: `apps/web/test/transport.test.ts` — nudges the selected layer by 1 and 5 px with one coalesced undo step (XF-023)

- Failure detected: nudges the selected layer by 1 and 5 px with one coalesced undo step (XF-023). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S02 TL-873..877; S03 ARC-010/AC-18; WP-3I stall regression; XF-023.
- Remaining stronger coverage / B6: TransportStore/model tests do not own JKL timing, Player events/watchdog, or selected-layer nudge mapping.
- Non-test callers / B4: Program/Source monitors and transport command dispatcher; observed seam: Shuttle/PlaybackDriver adapter protocol and UI commands.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving Shuttle/PlaybackDriver adapter protocol and UI commands outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/transport.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 226. KEEP: `apps/web/test/wp2e/import.test.ts` — timeline drop imports two files in order in one undo step

- Failure detected: timeline drop imports two files in order in one undo step. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 227. KEEP: `apps/web/test/wp2e/import.test.ts` — web: uploads files in client jobs and commits ONE transaction with engine-store locators

- Failure detected: web: uploads files in client jobs and commits ONE transaction with engine-store locators. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 228. KEEP: `apps/web/test/wp2e/import.test.ts` — web: a source-range sidecar picked with a render makes it a version of its source (M3, S07:PRC-019)

- Failure detected: web: a source-range sidecar picked with a render makes it a version of its source (M3, S07:PRC-019). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 229. KEEP: `apps/web/test/wp2e/import.test.ts` — lists per-file failures and commits the rest (S04 §5.3 AC 2)

- Failure detected: lists per-file failures and commits the rest (S04 §5.3 AC 2). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 230. KEEP: `apps/web/test/wp2e/import.test.ts` — dedupes by fingerprint with one prompt per batch (S04:IN-007)

- Failure detected: dedupes by fingerprint with one prompt per batch (S04:IN-007). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 231. KEEP: `apps/web/test/wp2e/import.test.ts` — "Import again" adds another project item referencing the same asset

- Failure detected: "Import again" adds another project item referencing the same asset. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 232. KEEP: `apps/web/test/wp2e/import.test.ts` — timeline drop into an empty sequence asks about the clip mismatch and updates the settings

- Failure detected: timeline drop into an empty sequence asks about the clip mismatch and updates the settings. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 233. KEEP: `apps/web/test/wp2e/import.test.ts` — desktop: registers picked paths in place and adds a path locator

- Failure detected: desktop: registers picked paths in place and adds a path locator. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 234. KEEP: `apps/web/test/wp2e/import.test.ts` — guards beforeunload while uploads run (S04:IN-013)

- Failure detected: guards beforeunload while uploads run (S04:IN-013). A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 235. KEEP: `apps/web/test/wp2e/import.test.ts` — placeItems: Project items dragged to the timeline become one Overwrite transaction

- Failure detected: placeItems: Project items dragged to the timeline become one Overwrite transaction. A wrong result, missing effect or changed externally observable state in this scenario fails the assertion.
- Independent contract / B1: S01 LIFE-010; S04 IN-003/007/013; S07 PRC-019.
- Remaining stronger coverage / B6: engine registration and project commands cannot test frontend batch prompting/transaction boundaries.
- Non-test callers / B4: ProjectPanel/TimelinePanel import services; observed seam: EngineImportService HTTP, DataTransfer and session commit result.
- B2/B3: The named failure is user/caller-visible at that seam. Fixed fixture values, failure codes/state, and before/after document invariants specified by the scenario; expected outcomes are not obtained by invoking the owner under test.
- B5: Refactoring internals while preserving EngineImportService HTTP, DataTransfer and session commit result outputs leaves this scenario valid; no source text, wrapper identity or CSS tree is required.
- Risk: Retains behavior at the listed boundary; other layers still own rendering fidelity, engine integration and model invariants.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`.

## 236. REWRITE: `apps/web/test/wp2e/import.test.ts` — reads DataTransfer payloads: in-app items first, then OS files

- Failure detected / B2: A shared MIME rename can bypass the old drag protocol while the test arranges the new wrong key.
- Independent contract / B1: docs/wp-notes/WP-2B.md specifies application/x-jasper-project-items payloads and S04 import precedence.
- Independent oracle / B3 and rewrite: Provide the literal 'application/x-jasper-project-items' payload with competing Files; retain exact item selection and OS fallback assertions.
- Stable seam / B4: readDataTransfer browser payload parser. Non-test callers: ProjectPanel and TimelinePanel drop handling.
- Refactor stability / B5: The assertion observes documented protocol bytes, user-visible control state or semantic operation outputs; it does not import the owner's expected-value helper or depend on private call shape. Identifier-only implementation changes preserve these outcomes.
- Lowest owner / B6 and remaining stronger coverage: This lowest parser owns precedence/protocol compatibility; UI import workflows own commits and prompts.
- Risk: No production behavior change; independent literals can now expose correlated baseline defects that previously passed. Any such failure requires fixing its owner, not deleting the assertion.
- Validation: `pnpm exec vitest run apps/web/test/wp2e/import.test.ts --maxWorkers=1`; `pnpm --filter @jasper/web typecheck`. Follow-up runtime validation is pending the integration owner's slot; static checks only in this shard.

## Independent-oracle rescan

All 34 assigned files were rescanned against the integrated retained versions. The rows above record the narrow follow-ups before editing. Inputs created with a valid project/schema factory, dynamic IDs, unchanged state captured for undo, and session outputs used to verify relationships were not mistaken for expected-value generation. In particular, the speech mix fingerprint is a valid-job precondition; rejection after a changed mix has an independent expected outcome. Keymap duplicate checks have an independent empty-collision invariant; the imported configuration is the subject, not the expected answer. FLICKS_PER_SECOND used only to construct tracking source-time fixtures remains setup; split-mark expected values now use the documented unit directly.

## Production/support cleanup completed

- Remove app-internal test-only exports for key/chord parsing, interactive role classification, media-browser formatting/filtering, feature summaries, placement labels, Find scope mapping, confidence classes and timeout calculation. Functions remain local for production callers.
- Remove the web re-export of the project match-frame query after eliminating duplicated assertions; the package public export remains.
- Remove the agent-input reset hook and optional test clock argument; retained security tests use trusted input events and the browser clock.
- Remove the agent grace-period constant and Motion Graphic parameter-section constant exports after replacing their only external test callers; production consumers are local. The public API header export and menu/MIME constants with real callers remain.
- Remove DynamicTrim class export and clock/RAF constructor/entry-point injection; only tests supplied the overrides. Default performance clock and RAF behavior stay unchanged; tests control browser APIs.
- Delete the large timeline rendering fixture with its implementation-count test. Shared inspector/timeline/tracking/import helpers still have real retained consumers; no orphan assets or snapshots identified.

## Validation results

- Cleanup implemented: 23 deleted, 46 rewritten and 167 retained test declarations/families; the ledger lists the original names so every prior test is traceable.
- `pnpm install --frozen-lockfile --offline` completed. It reported expected missing MCP executable links because ignored MCP build outputs are absent.
- Targeted Biome check of edited TypeScript files and `git diff --check` passed; final staged diff reviewed.
- During the independent-oracle follow-up, a pnpm launcher run crashed in Node/V8 cached-bytecode deserialization before Biome ran. Running the installed native Biome binary bypassed the launcher; its precision warning on one analytic literal was corrected to the representable value, then the full changed-file static check passed. No runtime test result is inferred from this check.
- The 34-file baseline attempt was stopped before any verdict, to reduce shared-host load and avoid concurrent edits. It is not counted as passing.
- Focused tests and `pnpm --filter @jasper/web typecheck` are pending the integration owner's coordinated run, as explicitly directed by the root agent. Repository lint/typecheck/test/build and specialized suites have not been claimed as passing here.
- No product behavior change or runtime bug fix is claimed. The UI/browser/GL/export suites were not run in this shard; user interactions remain covered by retained tests, whose final results must be reported by integration.

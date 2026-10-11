# Web panels code audit

## Scope and evidence

The audit covers `apps/web/src/panels` (158 source files at baseline `12049d8e`) and directly related web tests.
It follows `AGENTS.md`, the architecture's panel/session boundaries, the inspector notes (`WP-2D.md`),
`audio-mix.md`, `edit-ux.md`, `effect-presets.md`, and the transition framework notes. Types were checked against
project command schemas, clip and parameter schemas, API route response schemas, session transactions, and the
installed React/browser declarations. No external assets or code were imported.

The principal issue is loss of information between a typed domain model and its UI: command arrays became
`unknown[]`, patches became unrestricted records, and callers used `as never` to bypass the session contract.
These are internal values assembled by the editor, so treating them as untrusted parser input obscures mistakes.
In contrast, persisted preferences, JSON drag payloads, rejected promises, arbitrary registry property values,
and hosted panel/dialog parameters really do cross dynamic boundaries. Replacing those `unknown` types with
assertions would remove checks rather than improve safety.

## Implemented recommendations

- Command collections and builders in the timeline, captions/transcript panels, Essential Graphics, Essential
  Sound, and mixers use the existing `Command`/`CommandOf` types. Sequence settings, transition updates, track
  patches, mixer patches, placement tracks and keyframe updates derive their shapes from their command schemas.
  No duplicate command protocol types were introduced.
- All 42 baseline source lines containing `as never` in panels were eliminated. This includes document writes,
  clip narrowing, SVG pointer handlers, transition handle inputs, CSS properties, and default transition fields.
  The count is textual, measured with `git grep -n 'as never' 12049d8e -- apps/web/src/panels`; the corresponding
  `rg -n 'as never' apps/web/src/panels` has no matches after the change.
- Eight identical empty session stores share one stable store. This preserves hook ordering when a panel has no
  open project. Mixer labels live in a small shared module, so the Clip Mixer no longer imports the complete
  Track Mixer panel body just to obtain labels. Shared `Vec2` and `RGBA` definitions come from the project model.
- Waveform workers and their callers share request/response types. DOM-compatible worker message options replace
  the double assertion of the worker global; worker failure still settles outstanding reductions synchronously.
- Preset operations infer their already validated API responses instead of widening them to `Promise<unknown>`
  or asserting them back to the known response. Composition thumbnail props retain their component types.
- Essential Graphics library entries are independently validated. A malformed entry such as `null` previously
  caused the loader to discard every valid neighbor; invalid metadata could also reach rendering and actions.
  The parser retains valid entries and validates each entry's id, template and saved-at string.
- Motion-template drag payloads validate template version and the optional composition reference with Zod before
  insertion. Previously only the tag and template id were checked, despite a stronger asserted return type.
- Removed an unnecessary catch around a fixed `matchMedia` query; the existing feature check handles missing
  browser support. Removed section-label comments, redundant panel registration headers, historical workstream
  labels, and the stale M1 qualifier from the Rate Stretch help text. The lazy-panel comment now explains the
  scheduling constraint without narrating an earlier implementation.

## Critical findings retained intentionally

A scan of relative runtime imports inside the panel tree found no cycles. The mixer label import was unnecessary
coupling across lazy panel bodies, rather than a cycle. Cross-directory application cycles belong to the broader
integration audit; this local scan is not a claim that the entire application graph is acyclic.

Most remaining catches protect actual edges: storage access/quota failures, malformed persisted JSON and drag
payloads, engine requests, clipboard access, unavailable canvas/worker APIs, and user-triggered insert/export
operations. Removing these would violate the project's no-crash rule. Missing-media and unavailable-worker
rendering alternatives are required behavior and remain. Legacy document fields, text-animation compatibility,
and missing-effect preservation remain because deleting them in a UI cleanup would lose access to saved work.

`ResolvedProperty` deliberately supports registry-defined JSON and non-parameter properties, so its `unknown`
value cannot safely become only `ParamValue`. Runtime panel/dialog registries and rejected JavaScript promises
also retain honest dynamic types. No new `any` aliases or replacement escape hatches were introduced to reduce a
textual count. Existing API/preset folder-tree validation remains owned by its domain/API boundaries.

Font-catalog requests and optional derivative requests still tolerate engine/asset unavailability. Designing a
single application-wide availability notice would span state and shell ownership and needs consistent retry and
notification behavior; this audit does not turn a missing optional thumbnail into a fatal panel error.

## Verification

- `pnpm exec biome check --write apps/web/src/panels apps/web/test/panel-input-validation.test.ts` passes over
  163 files. `git diff --check` passes.
- `panel-input-validation.test.ts` adds the malformed-neighbor regression plus property tests over arbitrary
  JSON and explicit malformed version/composition drag cases.
- A focused Vitest run with `--maxWorkers=1` covers the input tests, motion templates, mixer panels, timeline
  gestures/transitions/trim mode, the timeline panel and effect presets. Its result will be recorded after the
  running check completes.
- The web typecheck was started but stopped at the integration agent's request because concurrent compilers
  saturated the shared host; it had not emitted diagnostics. The serialized integration typecheck remains
  required before merge.
- No layout or styling was changed. No browser screenshot was taken in this isolated worktree; the integration
  smoke check should open the affected panels and exercise the motion-template drag and graphic-template library.

This is a scoped, evidence-based cleanup, not a claim that all runtime error cases or all cross-feature interactions
have been exhaustively proven.

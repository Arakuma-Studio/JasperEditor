# Guide-lock retention correction

The failing assertion and its proposed disposition were recorded before editing in an isolated worktree based on `c9d52bc8`; the final disposition incorporates independent review.

The integrated run reported `edit-ux-monitors.test.tsx` → “rulers, guides, lock and dropped-frame toggles”: Clear Guides returned `ran: true` after a guide was seeded and locked. The earlier cleanup seeded a guide to prevent a false positive, but incorrectly assumed lock forbids Clear. This is a retention/audit mistake, not an established product regression. Changing production to preserve that assumption would violate the cleanup instructions.

Independent contract: S03 `OVL-003` explicitly says “Lock Guides disables dragging.” `PGM-040` and `docs/wp-notes/edit-ux.md` §5 list Clear Guides separately; neither specifies that lock disables it. The [upstream guide documentation](https://helpx.adobe.com/ca/premiere/desktop/get-started/source-and-program-monitor-adjustments/add-or-remove-guides.html) describes unlocking before dragging guides and a separate Clear Guides action; it supplies no broader prohibition to add here.

Disposition of the existing case: **REWRITE**. Remove only the unsupported Clear assertion and its seeded guide. Retain the three documented preference toggles through registered commands, explicitly starting from false values rather than assuming unspecified defaults. Do not add a separate test of current Clear availability logic. Repo-wide search found no other surviving assertion for these commands/preferences in `apps/web/test` or `e2e`.

A proposed direct `fireEvent` guide-drag rewrite was rejected during independent review: synthetic events bypass the existing CSS pointer blocking, so the test would pin a redundant JavaScript guard and fail a behavior-preserving refactor. It is absent from the final change. This retained case does **not** prove browser guide-lock dragging, which remains an interaction-coverage gap; adding a browser scenario is outside this narrow correction.

Full retention bar for “toggles ruler, guide-lock and dropped-frame preferences”:

1. S03 PGM-040 and `docs/wp-notes/edit-ux.md` §5 independently require the ruler, guide-lock and dropped-frame preference controls.
2. A missing/inert command or failure to enable its preference leaves a documented user option disabled and fails the test.
3. The starting preferences are explicitly false and the expected enabled preferences are literal true values. Neither expectation uses production defaults or a toggle helper.
4. Dispatch uses the registered command IDs consumed by production menus/shortcuts and observes the resulting shared monitor preferences consumed by UI rendering.
5. No DOM tree, CSS guard, collaborator call or internal predicate is asserted. A refactor preserving the command's preference change still passes.
6. No other surviving test asserts these commands or the three preference changes. Parser tests do not dispatch commands, and dropped-frame counting tests do not exercise indicator visibility. This is the lowest public command-dispatch seam for the retained contract.

Non-test callers: shell menus and key bindings dispatch the commands. `ProgramMonitor` consumes the display preferences and renders `GuidesOverlay`, which consumes the lock preference; Program Monitor's settings menu also toggles the stored preferences directly. No production seam or shared fixture becomes unused. Risk: narrow test correction only; the retained test's scope explicitly excludes hit-tested pointer behavior. Production source remains unchanged.

Validation plan: reproduce the existing assertion failure before edits; run the final `edit-ux-monitors.test.tsx` suite with one worker, `pnpm --filter @jasper/web typecheck`, targeted Biome and diff checks. Root handles the integrated gate. No browser/build run is needed for this test-only correction.

Validation evidence:

- Before the test edit, `pnpm exec vitest run apps/web/test/edit-ux-monitors.test.tsx --maxWorkers=1 -t 'rulers, guides, lock and dropped-frame toggles'` reproduced the unsupported assertion failure: expected `false`, received `true`, line 165. One failed, six skipped; 254.17 s, of which 246.70 s was module import time on the shared host.
- On the final source, `pnpm exec vitest run apps/web/test/edit-ux-monitors.test.tsx --maxWorkers=1` passed all seven tests (154.11 s; 141.98 s importing modules).
- `pnpm --filter @jasper/web typecheck` passed on the final source. Its command shell used normal process priority; no other process priorities changed.
- Targeted Biome and `git diff --check` passed.
- Independent review cleared the final test and both audit records; it confirmed that the retained assertions cover preference toggles only.
- Seven test declarations remain in this file. No production code or support seam changed.

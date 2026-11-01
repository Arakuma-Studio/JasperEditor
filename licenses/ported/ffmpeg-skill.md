# Export verification row shape and tolerances (adapted from ffmpeg-skill)

- **Upstream:** https://github.com/kajisho5/ffmpeg-skill (studied 2026-10-31)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2026 kajisho5
- **Ported by:** spec 18 AF-VER (agent footage editing: export verification), 2026-10-31

| Upstream path | Our path | What |
|---|---|---|
| `scripts/check.py`, `docs/contract.md` | `packages/api/src/exports.ts` (`VerifyRowSchema`) | verification row shape: id, kind, status, measured, expected, tolerance, message |
| `scripts/check.py`, `SKILL.md` | `apps/engine/src/export/verify.ts` (`judgeExport`) | the split of delivery checks into **format** rows (an agent may fix them unasked) and **judgement** rows (ask the user) |
| `SKILL.md`, `references/gotchas.md` | `apps/engine/src/export/verify.ts` (`VERIFY_THRESHOLDS`) | tolerance values: loudness 1.0 LU, true peak +0.1 dB over the ceiling, 0.25 s A/V end skew |
| `tests/test_contract.py` | `apps/engine/test/export-verify.test.ts`, `packages/project/test/delivery-targets.test.ts` | the idea of a test pinning documented thresholds to code constants |

Notes: no code was copied. Only the ideas above (row shape, format / judgement split, three tolerance values and
pinning docs to constants by a test) were adapted and reimplemented in TypeScript; every check, detector, threshold
table and platform limit in JasperEditor is its own (spec 18 §2.5, docs/wp-notes/agent-footage-verify.md).

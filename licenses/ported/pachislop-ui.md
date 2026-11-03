# Pachislop: numeric control tracks

- **Upstream:** https://github.com/SafEight/pachislop
- **Commit:** `dd952d0`
- **Licence:** `LicenseRef-Pachislop`
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** title-looks ui-core, 2026-11-02

| Upstream path | Local path | What |
|---|---|---|
| `src/ui/controls.tsx` (`TrackMapping`, `trackOf`, `toTrack`, `fromTrack`) | `apps/web/src/panels/properties/controls/ScrubbyNumber.tsx` (`TrackMapping`, `trackMappingOf`, `toTrack`, `fromTrack`) | Log and quadratic slider tracks for wide ranges |

Notes: the mappings and the 50× rule for a log track are ported. The rule for a quadratic track is ours and reads the parameter's
step. Positions are clamped, and a log track on a range that does not start above zero reads linear instead of `NaN`.

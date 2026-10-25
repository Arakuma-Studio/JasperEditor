# Ledgers

Running logbooks of multi-session programmes: what was asked, the goals and requirements derived from it, decisions,
the task board (done / in progress / left), who is doing what, verification results and open questions. They are
updated as work progresses so nothing is lost between sessions or context resets.

| Ledger | Programme | State |
|---|---|---|
| [premiere-port.md](premiere-port.md) | Port the user's Premiere projects: Premiere feature gaps (fonts, Smooth Slide, pitch mapping, spatial effect points, per-side ease, Crop order/feather, Link Media, crossfades, WMA preview) | Done, merged and pushed |
| [premiere-workflow.md](premiere-workflow.md) | Automate the user's Premiere workflow: GPU Whisper + model evaluation, Premiere-like auto-subtitles as editable text clips with templates and cut-aware timing, multi-clip styling, transcript "probably wrong" detector + configurable auto-cut, editing-pattern automation | In progress |

Rules for these files:
- Committed ledgers hold no private material of the user (no raw transcript text, private folder or video names,
  machine addresses). Private details live in the git-excluded `.prproj-analysis/LEDGER-private.md`.
- Mark every figure measured (with how to rerun it) or estimated (≈, with its basis), as AGENTS.md §5 requires.
- Update the task board and the log section whenever a task starts, finishes, fails or changes scope.

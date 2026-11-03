# Verifying an export

Claims about the result come from measurements of the exported file, never from the plan.

## Run it

1. `start_export` with `wait: true` (or `wait_for_job` on its job). Exports finished through MCP already return
   the output's container, duration, streams and size with the fast rows (`streams`, `duration`, `av-skew`).
2. `verify_export` {projectId, exportId, target?} runs the full set. Pass the brief's platform as `target` to
   add the platform rows.

## Read the rows

Each row: `{id, kind, status, measured, expected, tolerance, at?, message}`; `verified` is true when no row
fails and no format row is unverified.

- `kind: "format"` rows are objective (decode errors, stream codec / size / rate / pixel format / audio layout,
  duration within one frame or 50 ms of the range, true peak above the ceiling, a platform's hard limits). Fix
  them without asking: change the export settings or the sequence and export again.
- `kind: "judgement"` rows need the user's taste or intent (black or flash frames at a cut, clicks at a cut,
  integrated loudness off target, long digital silences, target aspect / duration / resolution suggestions).
  Look first, then ask with the evidence.
- `at` is a sequence time: look at it with `view_media_range` on the sequence (or `render_frame`) before you
  call it a problem or not.
- `unverified` means the check could not run: say so in Not checked; do not count it as a pass.

## The loop

- At most three passes of verify → fix → verify. After the third, stop and report what is left.
- Fix the cause in the edit, not the symptom in the file (a flash frame is a one-frame gap or a stray clip).
- A vertical target on a horizontal sequence is refused with a hint: reframe the sequence first
  (`auto_reframe_sequence`), never crop silently.
- Report the numbers: "-14.1 LUFS integrated (target -14 ± 1), true peak -1.3 dBTP, duration 29.97 s (range
  30.00 s, within 1 frame), no black or flash frames at 12 cuts, 1 click at 00:00:18:04 (fixed with a 2-frame
  audio fade)".

## Checking a title

`title_check` {projectId, clipId | proposalId, target?} measures rendered frames before the export exists. Its rows have
the same shape as `verify_export`'s: `{id, kind, status, measured, expected, at, message, fix?}`, and `verified` means the
same. `propose_title` returns the same rows as `check`.

| Row | Measured from |
|---|---|
| `safe-area` | the title's real alpha bounds against the Program monitor's action-safe and title-safe margins |
| `off-frame` | ink on the frame edge fails; a glow or shadow reaching it warns |
| `contrast` | each part of the title against the picture rendered behind it, at the frames it is at rest |
| `min-size` | text size with Motion's scale, against one thirtieth of the shorter frame side |
| `read-time` | characters against the time on screen |
| `font-available` | the engine's fonts |
| `export-path` | the planner: the path, or the refusal with its blocker |
| `lint-*` | every style lint issue |
| `target-safe-area` | where a vertical platform draws its interface: an estimate that only warns |

- `kind: "format"` rows you may fix unasked: `fix.commands` go to `apply_commands`, then check again. On a proposal
  `fix` has only a label, because its clip has no id yet.
- `kind: "judgement"` rows: say what was measured, with the timecode, and ask.
- Rows hold for the returned `revision` only. After any edit, run it again; `stale: true` means the project changed
  during the check.
- `notChecked` lists what no row measures, taste first. Put it under Not checked in your report. Never say a title
  looks good.

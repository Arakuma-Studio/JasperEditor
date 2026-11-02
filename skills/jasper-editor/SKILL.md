---
name: jasper-editor
description: Edit videos in JasperEditor through its MCP server (jasper-mcp): read the footage as text, look at chosen ranges, propose a reviewable cut, export and verify the file with measurements. Use when the user wants to edit, cut, trim, subtitle, clean up, grade, mix or export a video or a JasperEditor project, or says "make a rough cut", "cut a teaser", "edit my footage", "find the best takes", "remove the ums", "add subtitles", "export for TikTok / Reels / YouTube", "haz un primer montaje", "monta el vídeo", "edita mi vídeo", "quita las muletillas", "añade subtítulos".
---

# Editing video with JasperEditor

JasperEditor is a Premiere-style editor. You drive it through the `jasper-mcp` tools; the user watches in the
editor window, where each change is one undoable "Agent: …" History entry and your proposals appear as ghosts in
the Review panel. You never watch the video: you read it, look at a few chosen ranges, and measure the result.

## When to use

- The user asks for an edit of footage they have (interview, talk, vlog, tutorial, ad) or of a JasperEditor project.
- The user asks for a deliverable: a cut for a platform, subtitles, a cleaned-up voice track, a checked export.
- Not for raw FFmpeg work: there is no "run this ffmpeg command" tool by design. Use `derive_media` for file
  operations (extract audio, conform frame rate, reverse, denoise, time-stretch, trim) and the export tools.

If the `jasper` tools are missing, the server is not connected: see [setup](references/setup.md).

## Workflow

The core toolset covers the whole loop. Tools of other toolsets: `list_toolsets` names them, `describe_tool` shows
the arguments, `call_tool` runs them. `get_guide` (topic "routing") maps requests to tools.

1. **Brief.** `get_brief` for the sequence and `list_agent_notes`. If goal, platform, length or aspect is
   missing, propose one bundle of defaults (see below) and store the agreed brief with `set_brief`.
2. **Read the footage as text.** `get_footage_digest`: every take as timed phrases
   (`[002.52-005.36] S0 text`, `~` marks unsure words). `find_takes` groups the same line said several times and
   marks a suggested take. Media without transcript: `transcribe`, then `wait_for_job`. New files:
   `import_media` with transcription.
3. **Look only at decision points.** `view_media_range` gives one image of a media or sequence range: filmstrip,
   waveform, word labels, shaded silences, ruler, plus a text summary. `render_frame` shows the Program output.
   Look at the openings and endings you are unsure of, not at everything.
4. **Propose the cut.** `propose_edits` with a strategy (1–8 sentences) and items, each with `group`
   (`selects`, `removed`, `retakes`, `reorder`, `b-roll`, `other`), a `reason`, a `beat` and the `quote` it keeps or
   cuts, and the commands. Everything is dry-run first; a failure lists the failing items and stores nothing. Details:
   [proposals](references/proposals.md).
5. **Wait.** Tell the user what you proposed in two or three lines, then `wait_for_proposal`. Rework what was
   rejected; never re-propose applied items.
6. **Verify.** `start_export` (wait: true), then `verify_export` with the brief's platform as target. Fix
   format rows yourself; ask about judgement rows. Details: [verification](references/verification.md).

Small direct fixes the user asked for by name (one trim, one marker, a title) can go straight through `add_clip`,
`trim_clip`, `split_at`, `delete_clips` or one `apply_commands` transaction (`describe_commands` has every schema
and an example; `dryRun: true` tests it). A multi-step cut always goes through `propose_edits`.

## Ask or assume

- Propose **one bundle of defaults** instead of a list of questions: "30 s for Reels (9:16), best take of each
  line, ums and long pauses out, music ducked under speech, burned-in subtitles. OK, or change any of these?"
- Never ask what a tool can measure: duration, loudness, frame rate, resolution, silences, which take is complete.
- Ask before anything destructive or irreversible outside a proposal (deleting tracks or media, restoring a
  version, overwriting a file). Approval-gated operations show a card in the editor; after `E_APPROVAL_DENIED`
  do not retry without asking.
- When the user is away, keep going on defaults that fit the brief and record each assumption with
  `add_agent_note`.

## Report

End every task with three short lists:

- **Done**: what changed (proposal id and what it does, applied or waiting; export path).
- **Checked**: measured evidence: `verify_export` rows with values (duration, loudness, true peak, A/V skew,
  flagged cuts), the frames or ranges you looked at.
- **Not checked**: what you could not measure or did not look at (taste, music fit, a cut you did not view,
  unverified rows), so the user knows where to look.

## Gotchas

- You **cannot hear**. Report numbers (LUFS, dBTP, silence spans, clicks at cuts), never "sounds good".
- Inspect the **output, not the plan**: verify the exported file, and view the cuts it flags with
  `view_media_range` on the sequence or `render_frame`.
- At most **three** self-review passes (verify → fix → verify). After the third, report what is left.
- Times: tool arguments take frames, `{"seconds": x}`, `"3s"`, `"00:03"` or timecode; results give frames and
  timecode. Commands in `apply_commands` take frames, `{"frames"}`, `{"seconds"}` or timecode.
- Arguments are strict: an unknown key is an error naming it. Errors carry a code and a hint; follow the hint
  instead of guessing.
- A tool "not enabled" error means run it with `call_tool`.
- `undo` only touches your own History entries; the user's edits are theirs.
- Keep decisions for the next agent (and for yourself after a context reset) in `add_agent_note`.

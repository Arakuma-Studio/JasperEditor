# Spec 18: Agent footage editing — read footage, propose a cut, verify the result

Status: specified 2026-10-31. Owner wp-note: `docs/wp-notes/agent-footage.md` (created by the implementation).
[`ARCHITECTURE.md`](../ARCHITECTURE.md) and [`AGENTS.md`](../../AGENTS.md) win over this spec. Proposals and the
Review panel are spec 15 §2.1; voice cleanup is spec 14; speech is spec 16.

## 0. Background

Two MIT-licensed agent skills were studied (2026-10-31) for what they do well when an AI agent edits video:

- [`browser-use/video-use`](https://github.com/browser-use/video-use): the agent never watches the video, it *reads*
  it — a packed phrase transcript of every take (`[002.52-005.36] S0 text`, phrases split on ≥ 0.5 s silence or a
  speaker change), plus one composite image (filmstrip, waveform, word labels, shaded silences, ruler) only at decision
  points. Cuts are an edit list whose ranges carry `beat`, `quote` and `reason`; the user confirms the strategy before
  anything is rendered; the agent then inspects the *rendered output* at every cut, measures loudness instead of
  claiming to hear, and caps self-review at three passes.
- [`kajisho5/ffmpeg-skill`](https://github.com/kajisho5/ffmpeg-skill): every writing tool returns the output's probe and
  a `verification[]` list with tolerances; delivery checks split **format** rows (an agent may fix them unasked) from
  **judgement** rows (ask the user); a request → tool routing table; a small advertised core tool set with the rest on
  demand; thresholds pinned to code constants by a test; "never guess a raw ffmpeg invocation".

JasperEditor already exceeds both on editing (local Whisper with word timings, text-based editing, voice cleanup with
review, captions, scene detection, auto reframe, proposals with timeline ghosts). The gaps are on the agent side:

1. An agent cannot look at raw footage: `render_frame(s)` render the sequence only; derivative filmstrips are not
   exposed over MCP.
2. There is no compact, cross-take text view of all footage; transcripts come back per media as word JSON.
3. Nothing groups takes of the same line across files.
4. An agent's own multi-step cut cannot be reviewed: no MCP tool creates a generic proposal, so it lands directly as
   `apply_commands` History entries instead of Review-panel ghosts.
5. Exports are never verified after the fact (duration, A/V skew, black/flash frames and clicks at cuts, loudness).
6. Every agent pays for all 431 tool schemas and the whole guide text (`FULL_GUIDE` as server `instructions`) on
   connect.
7. File operations declared in the schema (`NativeRecipeSchema`: conform-cfr, reverse, denoise-audio, extract-audio,
   time-stretch, range) have no runner; there is no GIF or audio-only export and no platform delivery presets.
8. The human cannot state the goal of a video in the app for an agent to read, and cannot see what agents are doing
   beyond one toast per transaction (the bridge's activity log is never rendered).
9. ffprobe and export inputs of registered media do not restrict FFmpeg protocols (`LOCAL_PROTOCOLS` is used only by
   the sound code), so a registered playlist file could make FFmpeg open network or other local resources.

No code is ported from either project. Adapted thresholds (phrase split 0.5 s, silence band 0.4 s; verification
tolerances) are recorded in `licenses/ported/video-use.md` and `licenses/ported/ffmpeg-skill.md`.

## 1. Goals and non-goals

Goals:

- **G1 Read.** An agent understands all footage from text first (digest, takes) and looks at any media or sequence
  range in one image when it must.
- **G2 Propose.** An agent's rough cut arrives as one reviewable proposal whose items explain themselves
  (beat / quote / reason), reviewed and applied by the human with the existing Review panel, ghosts and one undo step.
- **G3 Verify.** Exports report measured evidence; agents and humans can run a verification and a platform delivery
  check whose rows say what may be fixed unasked.
- **G4 Cheap context.** An agent connects to a short index and a core tool set and loads the rest on demand; a routing
  guide and an agent skill teach the read → propose → verify workflow.
- **G5 Media operations.** Every schema-declared derivation op runs; GIF and audio-only deliverables and platform
  presets exist; all LGPL-safe.
- **G6 Brief and visibility.** The human states the video's goal once (Home or Sequence ▸ Brief…) where agents read it;
  agents keep project notes; the human sees agent activity and status at a glance.
- **G7 Safety.** Every FFmpeg input of registered media is restricted to local protocols; native export filtergraphs are
  checked against the GPL filter list at run time.

Non-goals:

- An in-app LLM or agent (ARCHITECTURE D-18 stands: agents are external, over MCP).
- Visual or semantic search over footage, vision-language models or image embeddings.
- A raw "run this ffmpeg command / filter string" tool (it would bypass typed inputs, undo and the LGPL guard).
- Shipping either studied skill or porting their code.

## 2. Requirements

IDs are `AF-<area>-<nnn>`. Every MCP tool below follows the existing conventions: strict zod input, the four hints,
errors as `{code, message, hint, details}` error results, progress and cancellation for long work, and an entry in the
toolset map (AF-CTX-001). Every engine route validates its body with zod and returns `{code, message, detail?,
retryable}` errors. Every user-visible string is translated (`es.json`).

### 2.1 Safety (AF-SEC)

- **AF-SEC-001** Every ffprobe/ffmpeg invocation that reads a registered or browsed media file passes
  `LOCAL_PROTOCOLS` (`-protocol_whitelist file,crypto,data`) before its input: media probe (`probeWithFfprobe` and any
  prober fallback), export inputs (native, hybrid, smart render, Remotion asset serving does not spawn FFmpeg),
  derivatives, proxies/transcodes, processing (`jasper-proc` inputs), audio decode/mixdown, loudness, scenes, reframe,
  roto/mg frame readers, and every new runner in this spec. `LOCAL_PROTOCOLS` moves to a shared engine tools module.
- **AF-SEC-002** A regression test registers an HLS playlist (`.m3u8`) whose segment is an `http://` URL served by a
  local test listener and proves that probe, a derivative and a native export refuse it with a coded error and that
  the listener received zero requests.
- **AF-SEC-003** The native export path calls `assertLgplFilters` on its generated filtergraph before spawning; a test
  proves a forbidden filter name in a graph is refused with a coded error.
- **AF-SEC-004** AGENTS.md §2 rule 2's GPL-only filter list equals `processing/proc/filters.ts`'s list (a test reads
  both and compares, so they cannot drift); `docs/wp-notes/wp-mcp.md` no longer claims proposals and ghosts are
  unimplemented.

### 2.2 Footage digest and takes (AF-DIG, AF-TAK)

- **AF-DIG-001** Pure `packFootageDigest(doc, opts)` in `packages/project` renders all transcribed media (or
  `mediaIds`, or one sequence in sequence time) as text:

  ```
  # Footage digest: <project name>
  ## <mediaId> "<name>" (43.0 s, 1920×1080 29.97 fps, 8 phrases, speakers S0 S1)
    [002.52-005.36] S0 Ninety percent of what a web agent does is ~completely wasted.
    [005.90-009.12] S1 …
  ## <mediaId> "<name>" (12.0 s, audio only) — no transcript: transcribe it with `transcribe`
  ```

  Phrases split on a gap ≥ 0.5 s between words, a speaker change, a caption break (`breakBefore`) or 12 s of length.
  Times are seconds with two decimals, zero-padded to the widest time in the digest. Words with confidence < 0.6 are
  prefixed `~`. Media are ordered by project bin order then name. `maxChars` (default 40 000, 1 000…200 000) truncates
  only at whole-media boundaries and ends with `… N more media not shown: pass mediaIds` (never cuts a media in half;
  a single media larger than `maxChars` is cut at a phrase boundary with the same notice). Nonfinite or reversed word
  times are skipped, never thrown.
- **AF-DIG-002** MCP tool `get_footage_digest {projectId, mediaIds?, sequenceId?, maxChars?}` and resource
  `jasper://projects/{id}/footage` return the digest.
- **AF-DIG-003** Agent imports can transcribe: the MCP import tool(s) accept `transcribe?: boolean | {model?, language?}`;
  when set, a transcription job is queued per imported media with audio and the result lists the job ids. The editor's
  "Transcribe on import" preference also applies to media an agent imports while the editor is open.
- **AF-TAK-001** Pure `findTakes(doc, opts)` groups phrases (AF-DIG-001 phrasing) across all transcribed media whose
  normalised text (case, punctuation, fillers from the cleanup lists removed) has token-sequence similarity ≥
  `minSimilarity` (default 0.6, LCS-based ratio over word tokens), each group ≥ 2 members. Each member reports media,
  range, text, mean confidence, `complete` (ends a sentence and contains no restart detected by the cleanup detector's
  rules) and the group marks one `suggested` member (the last complete take, matching spec 14's default). Bounded:
  at most 5 000 phrases compared (error `E_TOO_LARGE` beyond, naming `mediaIds` to narrow).
- **AF-TAK-002** MCP tool `find_takes {projectId, mediaIds?, minSimilarity?}`.
- **AF-DIG-004** `fast-check` property tests for both pure functions: never throw on arbitrary transcripts, output
  times are ordered and inside media bounds, `maxChars` is respected, grouping is symmetric and deterministic.

### 2.3 Media range view (AF-VIEW)

- **AF-VIEW-001** MCP tool `view_media_range {projectId, mediaId | sequenceId, start, end, frames? (2…16, default
  8), width? (480…1920, default 1280)}` returns one PNG and a short text summary. The image stacks: a filmstrip of
  `frames` frames sampled at the centres of equal slots; an RMS waveform of the audio; word labels at their
  timestamps (from the transcript, if any); shaded bands for silences ≥ 0.4 s; a time ruler with labels. Media without
  video draw only the audio rows; media without audio omit the waveform and silence rows.
- **AF-VIEW-002** Source frames come from a new engine route that extracts frames of a registered media at given
  times (LOCAL_PROTOCOLS, scaled on decode, bounded count and size, cancellable); sequence mode renders Program frames
  through the existing render path. Range is clamped to the media/sequence; `end - start` must be > 0 and ≤ 600 s.
- **AF-VIEW-003** The text summary lists frame times, the words shown and the silence bands, so an agent that cannot
  read images still gets the facts.

### 2.4 Reviewable agent edits (AF-PROP)

- **AF-PROP-001** New proposal feature `rough-cut` in `PROPOSAL_FEATURES`: name "Rough cut", groups Selects, Removed,
  Retakes, Reorder, B-roll, Other; item noun "1 edit" / "{0} edits"; `agentAccept: {setting: 'project', default:
  false}` (the human reviews an agent's own cut; Project Settings ▸ Agent Proposals can allow it).
- **AF-PROP-002** MCP tool `propose_edits {projectId, sequenceId, title, strategy, expectedRevision?, items}` where
  `strategy` is the plan in 1–8 sentences (≤ 2 000 chars) and each item is `{group, reason (1–280 chars), beat?
  (≤ 40), quote? (≤ 280), commands (1…100 command objects as `apply_commands` takes), alternatives?}`; at most 200
  items and 2 000 commands. Every item is dry-run against the current document before the proposal is stored; any
  failure returns one error result listing each failing item index with its command error and stores nothing. The
  result returns the proposal id, the ghost summary and a hint to `wait_for_proposal`.
- **AF-PROP-003** The Review panel shows a rough-cut proposal's strategy above its items, and each row shows the beat
  chip, the quote and the reason; ghosts, A/B, Apply n of m, stale handling and one-undo apply work unchanged.
- **AF-PROP-004** The rough-cut feature appears in Project Settings ▸ Agent Proposals and in
  `list_proposal_features`; tests cover policy refusal of an agent accept by default, human apply as one undo step,
  stale detection after a conflicting edit, and validation refusals.

### 2.5 Verification and delivery (AF-VER)

- **AF-VER-001** Engine job `export-verify` and MCP tool `verify_export {projectId, exportId, target?}` measure a
  finished export against the sequence range it rendered and return rows `{id, kind: 'format' | 'judgement', status:
  'pass' | 'warn' | 'fail' | 'unverified', measured, expected, tolerance, at?, message}` plus `verified` (no `fail`
  rows and no `unverified` format rows). Checks:
  - `decode`: the whole file decodes without errors.
  - `streams`: codec, frame size, frame rate, pixel format, sample rate and channels match the export settings.
  - `duration`: |file − range| ≤ max(1 frame, 50 ms).
  - `av-skew`: video and audio stream ends differ ≤ 250 ms.
  - `cut-black` / `cut-flash`: at every cut of the sequence inside the range, frames ±2 around the cut: a black run
    (mean luma < 16/255 for ≥ 100 ms) where the timeline has no intended black, or a single-frame luma jump > 0.25
    against both neighbours (judgement).
  - `cut-click`: an audio sample discontinuity within ±10 ms of a cut whose step exceeds 12 dB over the local RMS
    (judgement).
  - `loudness`: integrated loudness and true peak (BS.1770) against the target or the export's normalisation setting:
    within 1.0 LU (judgement), true peak ≤ ceiling + 0.1 dB (format).
  - `silence`: digital-silence spans > 2 s are listed (judgement, `warn`).
  Thresholds are exported constants; a test pins the wp-note's threshold table to them.
- **AF-VER-002** Exports finished through MCP return `output` (container, duration, streams, size) and the fast rows
  (`streams`, `duration`, `av-skew`) with `verified`; `verify_export` runs the full set.
- **AF-VER-003** `DELIVERY_TARGETS` (`packages/project/src/delivery/targets.ts`) gains each platform's limits
  (maximum duration, recommended resolution and frame rates, maximum file size, loudness the platform normalises to),
  each cited with source and access date in the wp-note or labelled as an assumption. `verify_export {target}` adds
  `target-*` judgement rows (aspect, duration, resolution, frame rate, size, loudness) and format rows where the
  platform rejects the file outright.
- **AF-VER-004** Export presets per delivery target (MCP export presets and the Export dialog's preset list), using
  the LGPL encoder selector; a vertical target on a horizontal sequence is refused with a hint to
  `auto_reframe_sequence`, never silently cropped.
- **AF-VER-005** The editor offers Verify on a finished export (Jobs panel / export completion toast); the result
  dialog lists the rows grouped Fail / Warn / Pass with "Go to" seeking the Program monitor to `at`.

### 2.6 Agent context (AF-CTX)

- **AF-CTX-001** Every MCP tool belongs to exactly one named toolset (a test fails on an unmapped or doubly mapped
  tool). The server advertises the `core` toolset (≤ 32 tools: project/sequence reading, `describe_commands`,
  `apply_commands`, the main edit tools, digest, view, takes, proposals, verify, brief, guide and toolset tools) by
  default; `JASPER_MCP_TOOLSETS` / `--toolsets` (`all` or a comma list) choose others.
- **AF-CTX-002** Core tools `list_toolsets` (name, description, tool count, enabled) and `enable_toolsets {names}` /
  `disable_toolsets {names}` change the advertised set and emit `notifications/tools/list_changed`. For clients that
  ignore that notification, core `call_tool {name, arguments}` runs any registered tool with the same strict
  validation, approvals and hints semantics, and `describe_tool {name}` returns its input schema. Calling a tool that
  is registered but not advertised by name returns an error naming its toolset. The `jasper` CLI reaches every tool.
- **AF-CTX-003** Server `instructions` ≤ 8 KB: workflow (brief → digest/takes → view → propose → wait → verify),
  core rules, the toolset index and pointers to guides. Every existing domain guide stays available as
  `jasper://guide/<topic>` and through core `get_guide {topic}`; `jasper://guide` keeps the full text. The `edit-video`
  prompt teaches the workflow instead of embedding the full guide.
- **AF-CTX-004** Resource `jasper://guide/routing`: a request → tool table (≥ 60 rows, English and Spanish phrasings);
  a test asserts every referenced tool exists and names its toolset.
- **AF-CTX-005** Agent skill `skills/jasper-editor/SKILL.md` (with `references/`): when to use, the workflow, the
  ask-vs-assume policy (propose one bundle of defaults instead of a list of questions; never ask what a tool can
  measure), the report format (Done / Checked / Not checked), and the gotchas (cannot hear: report numbers; inspect the
  output, not the plan; at most three self-review passes). A test asserts every tool it names exists. README documents
  installing it for Claude Code, Codex and Cursor.

### 2.7 Media operations and deliverables (AF-OPS, AF-EXP)

- **AF-OPS-001** Runners for every `NativeRecipeSchema` op without one: `conform-cfr` (constant-frame-rate output at
  `frameRate`), `reverse` (picture and sound; long media reversed in bounded segments so memory stays capped),
  `denoise-audio` (`afftdn`, strength 0…1 mapped and documented), `extract-audio` (`streamIndex`, wav or flac),
  `time-stretch` (`rate`; `preservePitch` → `atempo` chain, otherwise resample), `range` (frame-accurate trim of
  `[inFlicks, outFlicks)`). Each runs as an engine job with progress, cancellation, LOCAL_PROTOCOLS,
  `assertLgplFilters`, content-addressed reuse, and registers its output through `media.derive` (undoable).
- **AF-OPS-002** MCP tool `derive_media {projectId, mediaId, recipe}` and the editor's Project panel context menu
  "Derive Media ▸ …" with one dialog per op; refusals (no audio stream, unsupported rate, range outside media) are coded
  errors shown in the dialog.
- **AF-EXP-001** GIF export: palette generation and use over the rendered picture, frame rate (default 15, max 50),
  width (default sequence width capped at 1080), loop count, dithering choice; available from every export path by
  converting that path's rendered output, so nothing the timeline shows is dropped; audio is omitted and the plan says
  so as a warning.
- **AF-EXP-002** Audio-only export: wav (16/24-bit PCM), flac and m4a (AAC) of the sequence mix through the same DSP as
  preview and every other export path.
- **AF-EXP-003** Both appear in the Export dialog and the MCP export tool; golden/ffprobe tests cover them, and a GIF
  frame is compared with the Program frame (SSIM tolerance documented).

### 2.8 Brief and agent notes (AF-BRF) — schema v11

- **AF-BRF-001** `Sequence.brief?: {text (≤ 8 000 chars), platform?: DeliveryTargetId | null, targetDurationSec?:
  number (1…36 000) | null, aspect?: DeliveryAspect | null}`. Undoable command `sequence.setBrief`.
- **AF-BRF-002** `ProjectDocument.agentNotes?: {entries: {id, at (ISO time), author (1…64 chars), text (1…4 000)}[] ≤
  500}`. Undoable commands `project.addAgentNote` and `project.removeAgentNote`.
- **AF-BRF-003** Schema v11 (`v10→v11` version bump only, so v10 builds open v11 files read-only), fixture
  `schema-v11.jasper`, history row in `docs/project-files.md`, invariants, and conservative repair of unreadable brief
  or notes (reported to the user).
- **AF-BRF-004** MCP tools `get_brief {projectId, sequenceId}`, `set_brief`, `list_agent_notes`, `add_agent_note`.
- **AF-BRF-005** Home: a "Describe your video" entry beside New Project opens a dialog (description, platform, target
  length, files by drop or picker) that creates the project with a sequence preset inferred from the platform's aspect,
  imports the files, sets the brief and opens the editor; if no agent is connected it shows Help ▸ Connect an AI
  Agent…'s instructions.
- **AF-BRF-006** Sequence ▸ Brief… edits the brief and lists agent notes (remove with undo).

### 2.9 Agent activity (AF-ACT)

- **AF-ACT-001** An Agent Activity panel renders the bridge's activity log (time, agent, action, outcome; Undo where
  the entry is an undoable transaction still on the stack; filter by agent and outcome).
- **AF-ACT-002** A header status chip shows connected agents and their state (idle, working, waiting for review,
  approval pending, error); clicking it opens the panel.
- **AF-ACT-003** Bursts of agent transactions within 2 s collapse into one toast "Agent: N edits" whose Undo undoes
  that burst.

## 3. Validation

- Unit, property and integration tests per requirement; regression tests for AF-SEC fail before the fix.
- `pnpm lint && pnpm typecheck && pnpm test --maxWorkers=2 && pnpm build` on the integrated branch; `pnpm i18n:check`;
  `pnpm notices --check`; `JASPER_FFMPEG_LGPL_ONLY=1` for FFmpeg tests.
- UI changes exercised in the running app; GIF/audio exports inspected with ffprobe and extracted frames.
- The wp-note records behaviour, thresholds with sources, measured results and remaining limits; `docs/gaps.md` and
  README tool counts are updated with evidence.

## 4. Placement and ownership

| Area | Pure / model | Engine | MCP | Web |
|---|---|---|---|---|
| AF-SEC | — | tools, media, export, derivatives, processing | — | — |
| AF-DIG, AF-TAK | `packages/project/src/footage/` | transcribe-on-import | `tools/footage.ts` | transcribe-on-import |
| AF-VIEW | — | media frames route | `tools/footage-view.ts` | — |
| AF-PROP | `proposals/features.ts` | policy | `tools/proposals.ts` | Review panel rows |
| AF-VER | `delivery/targets.ts` | `export/verify*` | export tools | Jobs / export toast |
| AF-CTX | — | — | server, toolsets, guides | — |
| AF-OPS | — | processing / media jobs | `tools/derive.ts` | Project panel |
| AF-EXP | export settings schema | export | export tools | Export dialog |
| AF-BRF | schema, commands, migration | — | `tools/brief.ts` | Home, Sequence ▸ Brief… |
| AF-ACT | — | — | — | panel, header chip, toasts |

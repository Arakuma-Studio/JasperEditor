# Ledger — Premiere workflow automation (in progress)

Started 2026-10-25. Owner: coordinator session (Claude) with parallel subagents. Private details (machine addresses,
footage paths, agent ids, project names) are in the git-excluded `.prproj-analysis/LEDGER-private.md`.

## 1. What the user asked (2026-10-25)
1. Fast-forward local `main` to `origin/main`.
2. Rent machines for the work (the shared host must stay unloaded).
3. Whisper uses the GPU when the machine has one.
4. Evaluate Whisper small and medium (speed and quality) and decide which to use on CPU and on GPU.
5. Improve automatic subtitles like Premiere: choose lines, maximum characters, minimum duration per subtitle;
   subtitles are normal, fully editable text components so the user's Premiere subtitle style can be recreated
   (font Pixel12x10 supplied; S_Shake, pop-up animation, shadow…); edit the style of many selected text clips at
   once (Premiere can't); cut-aware timing as an automatic option — a subtitle starts exactly on a cut that falls just
   before it, and a phrase is split at a cut instead of running across it.
6. Transcript-based editing: detect and flag "probably wrong" segments (ums, breathing, wrong takes, repeated takes…)
   learned from how the user edited their own videos (projects + raw footage on the Mac + the user's written scripts
   in a shared Drive folder), with an option to auto-cut them; cuts must not leave empty sound — configurable timing /
   silence thresholds suitable for fast-paced "MrBeast-style" videos, usable by humans and AI agents; compare the
   user's real cuts vs raw footage vs the current transcript tool.
7. Using the same analysis, automate other editing patterns (zooms, transitions, etc.).
Process: research, spikes, analysis of footage/frames, online research, codebase analysis → detailed specs with clear
goals and requirements → implement everything 100 % complete and correct with parallel subagents in worktrees
(≤ 6 concurrent, used as a queue) → commit progress → merge to `main` when fully done. Product decisions: coordinator's
judgement for both human users and AI agents.

Later instructions:
- Keep raw footage on the user's Mac and run any footage analysis there; the Mac's internet is slow and flaky —
  expect disconnects (resumable detached jobs, no bulk transfers).
- GPU box: rent an NVIDIA box with no footage on it (only ≤ 20 MB of short audio clips); Mac stays plugged in and
  long jobs run under `caffeinate`.
- The user sometimes kept their original voice cuts in another Premiere sequence (cut in Premiere, then exported to
  FL Studio) — use those as ground truth; main-timeline video cuts also help reconstruct voice cuts.
- Keep these ledgers in the repo and update them as work progresses.

## 2. Constraints and working rules
- AGENTS.md is binding (crash safety, zod at entry points, undoable commands with tests, schema procedure,
  licences, preview/export fidelity, verification gate, worktrees per agent, no shared stash, no force push).
- Machines: shared host = editing, git and light scripts only. Build/test VM (Hetzner cpx51, 16 shared vCPU) = all
  tests, typechecks, builds, dev stacks, e2e. NVIDIA box (vast.ai RTX 3060 12 GB, driver 580 / CUDA 13) = Whisper
  CUDA work only. User's Mac (M4 Max, 36 GB) = all raw-footage analysis, Mac GPU (CoreML) benchmarks.
- Locks: one heavy job at a time on the Mac (`~/JasperAnalysis/locks/heavy`); one benchmark at a time on the VM
  (`/home/builder/locks/bench`); a waiting agent touches `locks/want-<name>` and a releasing agent doesn't re-acquire while
  another agent's want file exists (strict alternation).
- No raw footage leaves the Mac; the user's fonts (Pixel12x10, unknown licence) and the user's assets (emotes, SFX,
  music) are never committed or bundled — user-installed only.
- Git: `main` fast-forwarded to `origin/main` 71c86ba2 at start. Pushing requires the user's go-ahead (last
  programme's push authorisation was for that integration).

## 3. Research findings (summary; full reports in the private research folder)
- Codebase map: schema v8; 5,000-command transaction cap; Whisper CPU-only (`whisper.ts:151`), catalogue tiny/base/
  small (+`.en`), fp32 only; English-only fillers, pauses default 1 s / keep 0.1 s, transcript-only gaps; text-based
  cuts ripple every unlocked track; two separate text systems (caption clips vs text clips); `createCaptions` ignores
  picture cuts; only `strokes[0]` rendered, single CSS shadow, no text measurer; every text clip is its own Remotion
  bake (≤ 6 in flight); Properties multi-edit exists for intrinsics, Effect Controls primary clip only; no "list cuts"
  API; proposals generic but only sound design produces them and no agent accept policy for new features.
- Subtitles (measured on the user's 29 caption projects, 10,816 captions, 59.94 fps): 1–3 words (99.6 %), one line,
  median 8 chars (limit ≈ 13), median 25–29 frames, gap 0 (99.7 %); style Pixel12x10 white, #AE00FF stroke, #221D58
  shadow 80 %; pop-in scale 75 → 108 → 100 % over 10 frames + opacity 0 → 100 % in 3 frames; S_Shake on every caption;
  61 % (shorts) / 35 % (long) of cuts have a caption starting on the cut frame (hand-aligned), 1.8–4.2 % of captions run
  across a cut. Netflix rule: start on a shot change if speech begins within 0.5 s after it. No competitor snaps
  captions to cuts.
- Editing patterns (30 projects): shorts 23.8 cuts/min, long 17.9; 86–95 % of cuts get a 10+10-frame shake kit
  (shorts) or one of five transition families (long: jolt 49 %, whip 17 %, zoom-blur 17 %, zoom-through 9 %, spin 8 %)
  plus a whoosh; long-form punch-ins 9/min, 100 → 180 % in 7 frames, typically at clip midpoint (rule F1 0.78); Ken
  Burns on 13–16 % of clips; emote overlays (shorts ≈ 7/min); one-sided 30-frame slides on overlays; music beds at
  −33 dB switching on cuts.
- Cut-tool survey: transcript-only silence detection is the most complained-about failure (dead air, clipped word
  edges); waveform tools use −30…−45 dBFS thresholds, 0.3–0.75 s minimum silence, asymmetric padding (≈0.01–0.06 s
  before speech, ≥0.15 s after); keep-last-take is the universal retake default; no tool ships Spanish fillers; Whisper
  drops fillers by design (Spanish verbatim prompting raises filled-pause F1 to 0.88 in one study).
- Voice cutting (measured, 17 frame-exact projects): 17–22 cuts/min, no pause > ≈100 ms survives, joins 0 ms,
  out point ≈ floor + 21–25 dB inside the decay, in point at onset, breaths never kept, no crossfades; removed
  words mostly retakes (keep last 79–97 %); current tools leave 7 s/min of dead air and 200 ms per join.
- Voice workflow discovery: the user records in OBS, cuts and processes the voice in FL Studio, and Premiere plays the
  export nearly unedited; ground truth for cuts comes from aligning exports to raw recordings and from Premiere
  sequences that keep the original voice cuts.

## 4. Task board
Legend: ✅ done · 🔄 in progress · ⏳ queued · ⛔ blocked

### Phase 0 — setup
- ✅ Fast-forward local `main` to `origin/main` (71c86ba2).
- ✅ Build/test VM rented and provisioned (Node 24, pnpm 10.34.5, LGPL FFmpeg, fixtures, Chromium, `builder` user,
  `pp-sync`/`pp-run` helpers).
- ✅ Mac workspace `~/JasperAnalysis` (standalone ffmpeg 9.0.2, decoded project data, scripts).
- ✅ User's Drive scripts exported (24 Google Docs as text; the "premiere projects" subfolder is empty or private).
- ✅ NVIDIA box rented (first offer was a 4 GB GTX 1650 → destroyed; RTX 3060 12 GB rented instead).
- ✅ User fonts stored privately for test installs (Pixel12x10, Pixel12x10Mono).

### Phase 1 — research (outputs: private `research/<name>/FINDINGS.md`)
- ✅ codemap — code map of everything the features touch.
- ✅ subs — the user's caption recipe, cut alignment, Premiere/competitor options, proposal.
- ✅ auto — editing-pattern statistics and automation proposal.
- ✅ cutsurvey — survey of auto-cut tools, Spanish fillers, papers, licences.
- ✅ edits — how the user cuts voice (ground truth = Premiere picture edit in 17 projects + export↔raw alignment);
  detector + level-referenced auto-cut prototype reproduces the user's cuts (precision 0.90, recall 0.78, 72 % of
  edit points within 50 ms).
- ✅ whisper — decision: default **large-v3-turbo** (Spanish WER 3.4 % vs medium 4.7 %, small 6.8 %; faster than small
  on the M4 Max CPU); don't add medium or int8; GPU for the encoder (CUDA Linux, WebGPU Mac/Windows/Linux), decoder on
  CPU except CUDA + greedy (RTX 3060 RTF 0.155, WER 3.3 %); greedy default, beam 5 "Best"; fix hallucinations in
  silence and non-resumable downloads.
- 🔄 textperf — export/preview cost of 100 and ~1,000 animated text clips; architecture for fast subtitle export.

### Phase 2 — specs (to write in `docs/specs/`)
- 🔄 13 — Automatic subtitles (draft written: `docs/specs/13-auto-subtitles.md`; §4 export architecture waits for
  textperf): options, text-clip output, templates (user style + generic), cut-aware timing,
  multi-clip styling, text rendering upgrades (strokes, shadow spread, measurer), conversion to/from caption tracks,
  export performance architecture.
- 🔄 14 — Transcript cleanup (draft written: `docs/specs/14-transcript-cleanup.md`): typed findings detector, audio-confirmed pauses, Spanish fillers, repeats/retakes,
  script alignment, configurable auto-cut (padding, gaps, crossfades, guidance tracks, presets), review UI, agents.
- 🔄 15 — Editing-pattern automation (draft written: `docs/specs/15-edit-automation.md`): shared `pictureCuts`, Decorate Cuts kits, punch-ins, Ken Burns, overlays,
  overlay slides, music beds, style recipes and Style Check, proposals for new features + agent accept policies.
- 🔄 16 — Speech on GPU and model catalogue (draft written: `docs/specs/16-speech-gpu-models.md`): provider selection (CUDA/CoreML/DirectML/CPU), packaging, catalogue
  (medium/turbo/quantised), defaults per device class, measured evaluation table.

### Phase 3 — implementation (queue ≤ 6 agents, worktrees `.claude/worktrees/<name>`, VM-only testing)
- ⏳ Foundation (coordinator): integration branch, schema v9 bump shared by all features.
- ⏳ Work packages: defined when the specs land (listed here with branch, owner, status).

### Phase 4 — integration
- ⏳ Merge branches, fetch/merge `origin/main`, full gate + e2e + render suites on the VM, merge to `main`, ask the
  user before pushing.

## 5. Decisions
- D1 (2026-10-25) Footage analysis on the user's Mac only; results back as small derived files.
- D2 One shared schema bump (v9) for all persisted additions, done by the coordinator before feature agents start.
- D3 Subtitles default to normal text clips (not a nest) with linked templates; caption tracks remain for sidecar
  export, with conversion both ways (from subs research; to confirm in spec 13).
- D4 Every automation (subtitles generation, cleanup cuts, editing passes) is reviewable and one undo step; editing
  passes are proposals with agent accept policies.

## 6. Costs (estimated from provider rates)
| Machine | Rate | Since | Note |
|---|---|---|---|
| Build VM (Hetzner cpx51) | $0.44/h | 2026-10-25 17:44 UTC | lifetime 24 h |
| GTX 1650 (vast.ai) | $0.056/h | minutes | destroyed (insufficient VRAM) |
| RTX 3060 (vast.ai) | $0.084/h | 2026-10-25 18:23 UTC | destroyed after the CUDA eval (≈ $0.17 total) |

## 7. Open questions / risks
- DirectML DLL licence terms (Windows GPU path); CoreML unusable until the Node binding can cache compiled models.
- Export cost of ~900–1,200 animated text clips per long video (textperf research) — decides the subtitle export
  architecture.
- S_Shake unit conversion from Premiere values (calibration needed).
- 6 pre-existing test failures on `main` (Jasper Synth hashes, ZIP memory test) remain out of scope unless the user asks.

## 8. Log
- 2026-10-25 — ff main; VM provisioned; Mac workspace; scripts exported; research agents launched (codemap, subs,
  auto, whisper, edits, textperf, cutsurvey); NVIDIA box rented; codemap, auto, subs, cutsurvey finished; lock
  fairness rules set on the Mac and the VM; ledgers created; edits research finished; specs 13–16 drafted (13 §4 pending textperf); VM lock switched to a want-file queue
  after starvation in both directions.

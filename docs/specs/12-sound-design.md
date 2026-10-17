# Spec 12: Sound Design / SFX layer

Status: in progress on `feat/sound-design`. Owner wp-note: [`docs/wp-notes/sound-design.md`](../wp-notes/sound-design.md).
This spec wins over older specs for everything it covers; [`ARCHITECTURE.md`](../ARCHITECTURE.md) and
[`AGENTS.md`](../../AGENTS.md) still win over this spec.

## 0. Background and human decisions

The idea comes from `github.com/Bodila51/opus-sound-layer` (MIT, Python CLIs plus a Claude Code prompt).
We borrow **ideas only, no code**, so no `licenses/ported/` record is needed. Credit the inspiration in the wp-note.
The ideas we take:

- peak-aligned placement;
- per-sound descriptors and a rule-based "judge";
- masking-aware gain set against the bed, with a recorded reason per event;
- music dip before a hero, a high-pass build, a shared room reverb;
- waveform/spectrogram contact sheets for agents that cannot hear;
- a QA pass that checks sync against the picture, audibility and loudness, and hands the human five
  "listen here" timecodes.

Bugs found in that tool must **not** be reproduced here:

- unlimited stems that don't sum to the mix;
- a consistency clamp applied after the peak cap;
- negative fade slices;
- clicks from zero-state filter segments;
- aliasing varispeed;
- unvalidated cue input;
- QA that passes trivially on short media.

Human decisions (2026-10-14):

1. **Bundle** a Kenney CC0 starter kit (≈ 40–60 sounds, ≤ 8 MB). Each file gets a `.attribution` sidecar and an
   `ATTRIBUTION.md` row.
2. **No Freesound integration.** No Freesound or Openverse code, connector, tool or UI.
3. Credentials: if any secret ever had to be stored, use a 0600 file under the appdir. With 2 and 4 decided,
   **no credential store is built.**
4. **No AI generation** (no MOSS, no ElevenLabs, no generated-sound tier).
5. **BigSoundBank** may be offered as a downloadable pack, *after* an agent confirms per-file that its licence is
   CC0. WTFPL alone is not on our allowlist, so we use only the CC0 grant. Record the evidence in the wp-note.

Decisions taken by the orchestrator:

- Agents **propose** by default. Only a trusted user gesture applies a proposal in the editor. A per-project
  preference "Allow agents to apply sound proposals" (default **off**) lets `accept_proposal` work for agents.
- Procedural "Jasper Synth" sounds exist only as a deterministic **test fixture and offline fallback**.
  Real recordings (starter kit, packs, user folders) always rank above them.
- Proposals are stored by the engine per project (`<appdir>/projects/<pid>/proposals/`). They are not part of
  the document or of undo history.
- Cues live in `Sequence.soundDesign` (a `looseObject`), not in markers.
- No new DSP processor. Every mixing decision is an ordinary undoable command.

## 1. Principles

- **Ordinary edits only.** Every result is a normal `AudioClip`, gain, volume or pan keyframes, effect, submix,
  send or automation lane. Preview and every export path render it with nothing new (D-42). New schema fields
  are metadata, never render inputs.
- **Local-first, deterministic.** No network is needed except an explicit pack download. The same project, the
  same library snapshot and the same seed give the same proposal. Descriptors are quantised (ms to 0.1, Hz to 1,
  dB to 0.01), and ranking ties break by id.
- **Agent and human parity.** Every UI action is a command or route that MCP also exposes, and the reverse.
- **Review before commit.** Bulk sound design writes a proposal. Applying is one undo step.
- **Less is more.** Density budgets apply, and plain dialogue cuts get no sound.
- **Licence first.** The licence is carried from the moment a sound is indexed. Credits are generated.
  User-folder sounds are `LicenseRef-UserProvided` and are flagged.
- **Agents can't hear.** Every audible property has a measured or visual proxy.

## 2. Architecture

### 2.1 Library (engine, shared across projects)

```
<appdir>/sounds/library.json     index {version, snapshotHash, roots[], packs{}, sounds{id→SoundEntry}} (atomic writes)
<appdir>/sounds/roots.json       user folders indexed in place (local mode only)
<appdir>/sounds/synth/           Jasper Synth renders (cache)
<appdir>/sounds/packs/<packId>/  installed packs + pack.json
<appdir>/sounds/cache/<fp>/      visual data (peaks + spectrogram u8)
apps/engine/sounds/starter/      bundled Kenney CC0 starter kit (repo asset, sidecars)
```

`appdirPaths()` (`packages/config/src/index.ts`) gains `soundsDir`, `soundLibraryIndex`, `soundPacksDir`,
`soundSynthDir`, `soundCacheDir` and `projectProposalsDir(pid)`. Update ARCHITECTURE §4.3.

Sources, in priority order:

1. starter kit (bundled);
2. installed packs (catalogue `apps/engine/src/sounds/packs.json`, the same shape and rules as
   `processing/models.json`: pinned sha256, SPDX licence, attribution, size cap, `JASPER_SOUND_CATALOG` override
   for tests);
3. user folders;
4. Jasper Synth (fallback).

`SoundEntry` (`packages/api/src/sounds.ts`):

```ts
{ id: 'snd_<sha256-16>', fingerprint, title, types: SoundType[], tags: string[],
  source: {type:'starter'|'pack', packId} | {type:'folder', rootId, relPath} | {type:'synth', recipe, seed},
  license /*SPDX or LicenseRef-UserProvided/LicenseRef-JasperEditor*/, licenseUrl?, author, sourceUrl?,
  attribution: string|null, format:{durationSec, sampleRate, channels, container},
  descriptors: SoundDescriptors, judge:{ok, score, reasons[]}, indexedAt }
```

**Descriptors** (`packages/audio-fx/src/analysis/sound-descriptors.ts`, pure):

| Field | Definition |
|---|---|
| `durationSec` | |
| `peakSec` | max of a 2 ms-RMS envelope, 0.5 ms hop |
| `onsetSec` | first −30 dB re peak |
| `riseMs` | 10→90 % |
| `decayMs`, `decays` | peak → −20 dB |
| `tailSec` | → −60 dB |
| `centroidHz`, `rolloff85Hz` | |
| `below150Share`, `above6kShare` | |
| `flatness` | |
| `octaveBandsDb[7]` | 125 Hz … 8 kHz |
| `pitchMidi`, `pitchConfidence` | YIN; `null` when aperiodic |
| `onsetCount` | spectral flux |
| `integratedLufs`, `maxMomentaryLufs`, `truePeakDb` | via `@jasper/audio-dsp` |
| `stereoWidth` | |
| `headQuietSec` | head below −40 dB re peak |
| `loopable` | |

**Judge** (`sound-judge.ts`): boomy, hissy, noisy, soft-attack, non-decaying, too-long, too-short, clipped,
multi-hit and quiet, checked against plain numeric `TypeProfile`s that are passed in.

**Taxonomy** (`packages/project/src/sound/taxonomy.ts`): 19 types (hit, boom, riser, reverse, transition, whoosh,
swish, glitch, ui, click, key, tick, tap, pop, thump, paper, chime, shimmer, zap), plus ambience and roomtone.
Each type carries:

- `category`;
- `defaultAlign` (riser and reverse = end, whoosh = peak, ui = start);
- `defaultWeight`;
- judge `profile`;
- `visualKinds`;
- `durationFit`.

`TYPE_SYNONYMS` covers folder indexing.

**Ranking** (`packages/project/src/sound/rank.ts`, pure, shared): the score is

- field-weighted token match;
- type fit for the visual kind;
- duration fit;
- judge score;
- licence preference (CC0 > CC-BY > user-provided);
- source preference (real recordings > synth);
- a rotation penalty for sounds already used nearby;

with ties broken by id.

**Register into a project.** `POST /api/sounds/:soundId/register {projectId}` returns `RegisteredMedia` plus
`library: LibraryProvenance`. Starter, pack and synth files are copied into managed media; folder sounds follow
the local-path import rules. A sound whose quiet head is shorter than 50 ms (and which is at most 120 s long), from
any source, is registered as a managed WAV copy with 50 ms (whole samples) of digital silence in front, so placement
(§2.3) is always sample-exact; its provenance's descriptors describe that copy and `leadSilenceSec` records the
padding (decision of the Phase 1 verification; schema v7). A sound of at most 120 s whose −60 dB tail ends less than
50 ms before the end of its file (or whose tail the analysis did not reach) also gets 50 ms of digital silence after it
(`trailSilenceSec`; a folder sound that needs it is copied, like one that needs the lead), so a placed clip, rounded up to
the end of the sound, stays inside its media (fix "SFX tail truncation"). The copy is bit-exact and deterministic, so
repeated registrations dedupe; a copy made before the fix has another fingerprint, so registering the sound again gives
the padded copy as a new media (existing clips keep theirs until swapped). The client commits `media.register` into a
"Sound Effects" bin. `MediaAssetSchema.library?` carries `soundId`, `title`, `types`, `source`, `license`, `licenseUrl`,
`author`, `sourceUrl`, `attribution`, `descriptors{peakSec, onsetSec, headQuietSec, durationSec, octaveBandsDb,
centroidHz, maxMomentaryLufs, truePeakDb?, tailSec?}`, `leadSilenceSec?`, `trailSilenceSec?` and `snapshotHash`
(`tailSec` only when the library analysed the whole file). Command `media.setLibraryInfo` sets it.

**Credits** (`packages/project/src/sound/credits.ts`): `soundCredits(doc, sequenceId?)` returns rows, text and
warnings, walking nested sequences.

### 2.2 Cues (`packages/project/src/schema/sound.ts`; `SequenceSchema.soundDesign?`)

```ts
SoundCue = { id, frame, label?, kind: 'cut'|'transition'|'move'|'land'|'appear'|'exit'|'emphasis'|'reveal'|'beat'|'manual'|'silence',
  weight: 'hero'|'support'|'ambient', types?: string[], soundIds?: string[] /*layers*/, align?: 'peak'|'start'|'end',
  pan?: number(-100..100)|'auto', pitchSt?: -12..12, stopBefore?: {seconds, depthDb}, build?: {seconds, fromHz, toHz},
  anchor?: CueAnchor|null, source: 'derived'|'user'|'agent'|'marker', confidence?: 0..1, reason?: string,
  placedClipIds?: string[], muted?: boolean, window?: {start, end} }
CueAnchor = {type:'edit', trackId, outgoingClipId, incomingClipId} | {type:'transition', transitionId}
  | {type:'keyframe', clipId, property, keyframeId?, event:'peak-speed'|'settle'|'start'|'end'}
  | {type:'text', clipId, side:'in'|'out', unit?} | {type:'mg', clipId, event:'intro-end'|'outro-start'}
  | {type:'clip', clipId, edge:'start'|'end'} | {type:'scene', mediaId, mediaSec} | {type:'beat', clipId, beatIndex}
  | {type:'marker', markerId}
SoundDesign = { cues: Record<id, SoundCue>, settings?: {delivery, density:'sparse'|'balanced'|'rich', sfxTrackIds,
  roomBus: string|null, seed, agentsMayApply?: boolean}, lastCheck?: {mixHash, verdict, counts, at} }
AudioClip.sfx? = { cueId: string|null, soundId, layer, role: 'hero'|'support'|'layer', alternatives?: string[] (≤16),
  placement: {align, peakFlicks, errorFlicks} }
```

`repairDocument` handles cues with dangling anchors (anchor → null, plus a warning), missing `placedClipIds`,
missing `sfx.cueId` (→ null) and clamps frames. It must be idempotent. No schema-version bump: all new fields are
optional or loose, with read-time defaults.

**Derivation** (`packages/project/src/sound/cues/`, pure): `deriveCues(doc, sequenceId, opts)`. Sources:

| Source | Cue |
|---|---|
| Edit points (through edits skipped) | `cut`. No sound in dialogue-dominant ranges. |
| Transitions | Visual centre. Push/slide/zoom → whoosh with a window and a pan sweep. |
| Keyframed transform/opacity, sampled per frame via `resolveLayerProps` | Peak speed → `move`; settle/overshoot → `land`; opacity or scale-up from small → `appear`; scale pulse → `emphasis`. |
| Text animators (`resolveTextAnimationWindows`) | In → `appear`; typewriter → `key`/`tick` patterns capped at 12/s and 40 per clip; out → `exit`. |
| Motion-graphic intro/outro | |
| V2+ clip edges | |
| 3D camera moves | |
| Markers named `sfx: <type>[+<type>]` | |
| Scene cuts (engine), beats (engine), pixel motion curve (engine, P6) | |

- Cues within 2 frames merge.
- Density budgets:

  | Density | Heroes | Cues/s |
  |---|---|---|
  | sparse | ≤ 1 per 3 s | ≤ 1 |
  | balanced | ≤ 1 per 2 s | ≤ 2 |
  | rich | ≤ 1 per 1.5 s | ≤ 3 |

- Score = confidence × weight × size × novelty.
- `pan:'auto'` = x/width mapped to ±60.
- Every cue has a human-readable `reason`.

### 2.3 Placement (`packages/project/src/sound/place.ts`, pure)

- `P` = peak, onset or end offset ÷ rate; `k = floor(P·fps)`; `start = cue − k`.
- Residue `r = P − k/fps`. If `headQuietSec ≥ r`, set `sourceIn = round(r·FLICKS_PER_SECOND)`, which is
  sample-exact. Otherwise `sourceIn = 0`, and the error is ≤ 1 frame late (audio lag is less noticeable; cite
  ITU-R BT.1359). Library sounds never take this branch: registering pads their head (§2.1), so `errorFlicks` is 0;
  it remains for media placed from other sources (the longest library files, project audio).
- Record `errorFlicks`. Refuse `start < 0` with `E_INVALID_PARAM`.
- **Length: the whole sound always plays.** The clip is `[sourceIn, end of the sound)` in whole frames (the end of the
  sound in the file is `durationSec − trailSilenceSec`), rounded **up** to the frame that holds where the sound has
  faded — its −60 dB tail (`peakSec + descriptors.tailSec`) when the provenance records it, else that end: `frames =
  max(⌊(end − sourceIn) / rate / F⌋, ⌈(faded − sourceIn) / rate / F⌉)`. No clip ends inside its sound, and none plays
  the trailing silence for its own sake (a riser aligned by its end ends on its frame). Registering pads short
  library sounds that do not end in ≥ 50 ms of quiet with `LIBRARY_TRAIL_SILENCE_SEC` = 50 ms of silence after them
  (§2.1; ≥ one frame at 23.976 fps, room for +19 % speed), so that frame is inside the media; media without that
  room (copies registered before, sounds over 120 s, project audio, faster speeds) end less than one frame past their
  media — INV-005's one-frame tolerance, played as silence by every renderer. `end` alignment uses the end of the sound,
  not of the trailing silence. (Fix "SFX tail truncation": a click shorter than a frame after its peak was cut at its
  peak.)
- Layers: one clip each, peaks aligned, on different SFX tracks, grouped (`clip.group`).
- Rotation: round-robin over the top-N ranked candidates, never the same file twice in a row. Seeded ±2 %
  varispeed (`clip.setSpeed`, `maintainPitch:false`) and ±1 dB jitter.
- Pitch: |st| ≤ 3 → varispeed; otherwise `jasper.audio.pitch-shifter`.
- Pan: static, or keyframed for whooshes.
- Track `'auto'` picks the first free SFX track, otherwise adds "SFX n".
- **Inserting never overwrites existing audio.**

### 2.4 Mixing (P4)

**Masking solver** (`packages/audio-fx/src/analysis/masking.ts`). Sound bands are compared with the bed bands
over the event window. The bed is rendered by the engine with `renderMixdown({onlyTracks: non-SFX, measureOnly})`,
per cue cluster only. Target lift in the dominant band:

| Weight | Lift |
|---|---|
| support | +3.5 dB |
| hero | +5 dB |
| ambient | +2 dB |

Constraints, **in this order**:

1. clamp to [−30, +12];
2. peak over local bed ≤ +6 LU (support) / +10 LU (hero);
3. support within 0.15 s of a hero × 0.6;
4. repeats within median ±2 dB;
5. dialogue guard (1–4 kHz lift ≤ +1 dB during speech);
6. headroom.

Then **re-verify every constraint after the last step**. A later step may never silently break an earlier one;
if two conflict, the earlier (safety) constraint wins and the conflict is reported.

Output: `{clipId → gainDb, limitedBy[], achievedLiftDb}`.

**Stop-before.** Use `mixer.writeAutomation` on the music track volume lane. When the music shares a track, fall
back to `audio.volumeDip` (merges by taking the minimum with existing keyframes).

**Build.** One `jasper.audio.scientific-filter` highPass insert on the music track, with keyframed cutoff
(20 Hz → fromHz → toHz → 20 Hz).

**Room glue.** `soundDesign.ensureBus`: a "SFX Room" submix plus `jasper.audio.studio-reverb` (decay 0.6, mix
100 %, pre-delay 8 ms), and sends at −16 dB post-fader. Interface types (ui, click, key, tick) get no send.
Idempotent.

**Delivery presets** (`packages/project/src/sound/delivery.ts`):

| Preset | Integrated | True peak |
|---|---|---|
| web | −14 LUFS | −1 dBTP |
| podcast | −16 | −1 |
| broadcast-r128 | −23 | −1 |
| atsc-a85 | −24 | −2 |

Relative targets: music ≥ 8 LU under voice, ambience ≥ 10 LU under voice. Applied through existing commands.

### 2.5 Proposals (P3): a generic mechanism

**Model** (`packages/project/src/proposals/`): `Proposal {id 'prp_…', projectId, sequenceId|null, feature, title,
summary, author, createdAt, baseRevision, docHash, items[{id, label, group, commands[], requires[], meta,
state: pending|accepted|rejected|stale|invalid, reason?, note?}], report?}`.

- `composeAcceptTx(proposal, itemIds, origin)` takes the dependency closure and returns **one transaction**.
- `proposalGhost(before, result)` classifies items as created / deleted / changed.
- Validation at creation dry-runs every item; items that fail become `invalid`.

**Engine store** (`apps/engine/src/proposals/`): atomic JSON, ≤ 50 per project, 30-day expiry. Routes under
`/api/projects/:pid/proposals` (list, get, create, accept, reject, note, delete) and event `proposal.changed`.

Accept re-validates on the current document. With `partial`, stale items are reported and the rest applied;
otherwise it is all-or-nothing. Agent accept is refused with `E_APPROVAL_REQUIRED` unless
`soundDesign.settings.agentsMayApply` is on.

**Session** (`packages/session/src/proposals.ts`): a proposals slice and `previewProposal(id, itemIds)`, which
builds a non-committed preview document, recomputed debounced on `doc.changed`. The Program monitor renders
picture **and sound** from it while "Hear proposal" is on.

### 2.6 Sound Check (P5)

Job `sound-check`, `POST /api/sound-design/check`. It renders the mix and stems (sfx, dialogue, music, ambience,
bed) through `renderMixdown` (`measureOnly`), runs VAD, and computes 10 ms curves.

| Code | Check |
|---|---|
| `LOUDNESS`, `TRUE_PEAK` | integrated and TP vs preset (±1 LU) |
| `OUT_OF_SYNC` | peak vs cue, located by cross-correlation in the SFX stem: cut ±1 frame, land ±2, move ±3, appear (start) ±1; or "cut": the clip ends < 20 ms after its aligned point while its sound goes on (error) |
| `TRUNCATED` | a placed sound's clip ends before the sound has faded to −60 dB (provenance tail, library tail, or measured on the file) while it runs to the last whole frame of its media — the frame grid cut it, not the user (warning). Fix (also for OUT_OF_SYNC "cut"), first that reaches the end: `clip.trim` out; `swap_sound` to the same sound (re-registers it with trailing silence, `soundDesign.swap` keeps the aligned frame, track, role, pan, gain); `soundDesign.swap` on its own media (rounds the clip up past the media end, silence there). All safe, dry-run |
| `MASKED` | dominant-band lift: support ≥ 1.5 dB, hero ≥ 3 dB |
| `OVERLOAD` | |
| `MUSIC_OVER_VOICE` | music not ≥ 8 LU under voice during speech |
| `SILENCE` | < −60 dBFS for ≥ 0.5 s outside `silence` cues |
| `DIP` | short-term drop > 10 LU not explained by stop-before, a cut or a silence cue |
| `STALE_CUE`, `NO_PICTURE_EVENT` | cue no longer matches its anchor / no picture event at the cue |
| `DENSITY`, `REPEAT` | |
| `LICENSE`, `CREDITS` | |

Every issue has `{code, severity, frame?, range?, message, fix?{tool|command,args}}`.

The report also carries:

- `listen[5]`: worst event, biggest hero, loudest moment, densest moment, one passing cue, each with a reason;
- `curves`;
- the per-event table.

The check must work on media of any length (no trivial pass on short input). The summary is stored in
`soundDesign.lastCheck`; it is stale when `mixFingerprint` differs. Visual data comes from the engine; MCP
composes PNGs with `apps/mcp/src/png.ts`; the web draws the same data on canvas.

### 2.7 UX

**Panels**

- **Sound Library** (`soundLibrary`, own keymap scope, `dockWith: 'essentialSound'`):
  - toolbar: search, In Context toggle, Loop, Auto-play, audition volume;
  - collection selector (All, Favourites, Recent, Used in project, Palette, Sources);
  - type chips grouped into families (Impacts, Movement, Digital, Tactile, Tonal);
  - Refine pills: length, tone, attack, weight, texture, licence; "Commercial-safe" is on by default;
  - virtualised result rows: 120×24 waveform with a peak tick, duration, licence badge, favourite;
  - palette strip and status line;
  - empty state: Install starter kit / Add a folder.
- **Review** (`review`): §2.5 UX.
- **Sound Check** (`soundCheck`): §2.6 UX.
- **Sound Design workspace** (9th built-in, Alt+Shift+9): Library / Project / Media Browser + Review / Sound Check /
  Markers / History / Jobs on the left; Program and Timeline in the centre; Essential Sound / Properties / mixers
  on the right.

**Audition**

- Space plays alone through the Mix.
- Shift+Space plays **in context**: the timeline plays with the candidate's peak aligned to the anchor (selected
  cue, else the selected SFX clip's peak in Replace mode, else the playhead). The window is 2 s pre-roll to 1 s
  after.
- In Replace mode the clip being replaced is muted.
- A Program overlay chip shows what is auditioning.
- Auditioning never writes to the document.

**Insert**

- Drag MIME `application/x-jasper-sound`. The ghost shows a peak tick, and the **peak is the primary snap edge**.
  Snap order: playhead > cue > marker > cut > In/Out. Alt drops by the start.
- Enter or double-click: fill the selected cue, else swap (Replace mode), else insert at the playhead.
- Tracks: targeted if free, else a free SFX track, else a new "SFX n".
- Toast with Undo.

**Cue Seam**

- An 18 px non-scrolling lane at the video/audio divider (`layout.ts` `DIVIDER_PX`), toggled from
  Sequence ▸ Sound Design.
- Glyphs: cut ▮, move ▸, land ▼, appear ○. Hero is filled; support is outlined.

  | State | Drawing |
  |---|---|
  | unfilled | hollow, dashed |
  | filled | solid, with a connector to the clip's peak |
  | agent | dashed `--pr-agent` |
  | ghost | `--pr-ghost-stroke` |
  | conflict | `--pr-warning` |

- Build and stop-before are drawn as span bars.
- Editing: click, Shift-click, drag (snaps to the source event), Alt-drag duplicates, Delete. Double-click opens
  the Library in Fill mode.
- Context menu: Fill With ▸ top 5, Fill from Library…, Role, Visual Tag, Align, Stop Before Next, Add Layer…,
  Convert to Marker, Delete.
- Properties "Cue" section.
- Keyboard: Tab focuses the seam, Left/Right move between cues.

**Suggest Cues…** dialog: sources (with counts), range, density, respect dialogue. One undo step.

**Peak handle** (`clipDecorations`): a peak line plus a diamond. Drag moves the clip by its peak; Shift-drag
writes a peak override.

**Variation cycling** (next/previous): the agent's alternatives, then the same family, then the nearest
descriptors. It keeps the peak frame, role, pan and user gain offset. Repeated presses coalesce into one history
entry, and an "Audition on swap" preference applies.

**Layering**: Add Layer… aligns to the same peak and links the layers (Link/Unlink).

**Clip badges** (`clipDecorations`): an audio-type badge for all Essential types (click focuses Essential
Sound), an "H" for hero, a chain icon for layers, and a warning dot for NC or unknown licences.

**Essential Sound SFX additions**: a Sound row (name, source, licence, Swap…, ◀ ▶ variation, Find Similar),
Role, Align, Auto gain with its reason, Room send, Pitch, Stop before next. The header gets "Browse sounds…".

**Properties**: a "Sound" section (descriptors, peak, cue link, licence, credit line).

**Clip context menu** (`apps/web/src/sound/register.ts` via `clipMenuExtensions`):

- library sounds: Swap Sound…, Next/Previous Variation, Align Peak to Playhead, Align Peak to Nearest Cue, Set Peak
  at Playhead, Find Similar Sounds, Reveal in Sound Library, Add to Palette, Role ▸, Show Licence…;
- other audio: Detect Peak, Add to Sound Library…

**Review**

- The proposal card goes into the AgentApprovals stack: no countdown, Review / Dismiss.
- Ghosts: `--pr-ghost-fill` with a dashed `--pr-ghost-stroke`, plus a 3 px `--pr-agent` bar for agent proposals.
  Ghost track headers. Removals get a `--pr-ghost-remove` wash.

  | Item state | Drawing |
  |---|---|
  | accepted | ✓ |
  | rejected | hatched, 35 % opacity |
  | stale | warning "!" |

  Items are never silently dropped. Ghosts follow their anchors.
- A why-line tooltip per item.
- Review bar: ◀ ▶, A/B (bypass while playing), Accept all, Reject all, "Apply n of m", Discard, Exit.
- The Review panel lists items grouped by role, each with ✓ / ✕, ▶ in context, ⇄ alternates and ✎ note.
- **Apply needs a trusted event**, produces one undo step, and its toast offers Undo and Reopen review. After
  Undo, the proposal reopens with its decisions intact. Notes are returned to agents.
- Auto Sound Pass… dialog: its only button is "Propose".

**Sound Check panel**

- Delivery target select, "Use as sequence target", Run (as a job).
- Summary chips; issues grouped by category with jump-to-timecode and a Fix button; "Fix all safe".
- Sync rows expand into a strip of 5 frames plus the waveform.
- Listen-here list: ▶, Sounds right / Flag + note, stored as `comment` markers. Play all.
  (Phase 5 verification: the markers carry the moment they judged — slot, clip / cue, mix and window hashes — and are
  reported stale when it changes; verdicts can be given during Play all; a fix that is not safe is confirmed first.)
- Optional "Run Sound Check before export" in the Export dialog.

**Shortcuts** (verify against `keymap-defaults.ts` and the presets; the keymap tests must pass):

| Command | Win/Linux | mac |
|---|---|---|
| `sound.addCue` | Alt+Shift+C | |
| next / prev variation | Ctrl+Alt+. / Ctrl+Alt+, | explicit Opt+Cmd |
| `sound.alignPeakToPlayhead` | Ctrl+Alt+P | |
| `sound.swap` | Alt+Shift+S | |

- Library scope: Space, Shift+Space, Enter, F, L, Ctrl+F.
- Review scope: Enter accept, Backspace/Delete reject, U clear, A A/B, Space, Shift+Space, Ctrl+Enter apply,
  Esc exit.
- Never use Alt+M, `[` / `]`, or Alt+Shift+< / >.

**Menus**

- Sequence ▸ Sound Design: Suggest Cues…, Auto Sound Pass…, Fill Unfilled Cues, Run Sound Check, Show Cue Seam,
  Rebalance SFX Levels, Clear Unfilled Cues.
- Clip ▸ Audio Options: the additions above.
- Markers: Add Sound Cue, Next/Previous Cue, Convert Markers to Cues.
- File ▸ Export ▸ Sound Credits…
- Preferences page "Sound Library": folders with a licence declaration per folder, packs, "Audition on hover"
  (off), pre-roll, the agent-apply policy.

**Rules for all UI**: design tokens only (new tokens `--pr-cue`, `--pr-cue-hero`, `--pr-cue-unfilled` in
`tokens.css`); every string i18n'd (`es.json` kept complete; search matches type ids and translated labels);
listbox ARIA with descriptor-rich names; aria-live audition announcements; keyboard-only operable;
reduced-motion variants; state never shown by colour alone.

### 2.8 Engine routes and jobs

New job kinds: `sound-index`, `sound-pack-install`, `sound-design`, `sound-check`, `motion-analysis`.

Routes, declared in `packages/api/src/routes.ts` with schemas in `packages/api/src/sounds.ts` and
`proposals.ts`:

| Route | Notes |
|---|---|
| `GET /api/sounds` (search + facets) | |
| `GET /api/sounds/:id` | |
| `GET /api/sounds/:id/audio` | nosniff, audio MIME only |
| `GET /api/sounds/:id/visual` | |
| `POST /api/sounds/:id/register` | |
| `POST /api/sounds/index` | job |
| `GET`/`PUT /api/sounds/roots` | local mode only, validated paths; adding a root from an agent → `requireUserApproval` |
| `GET /api/sounds/packs` | |
| `POST /api/sounds/packs/:id/install` | job |
| `DELETE /api/sounds/packs/:id` | `requireUserApproval` |
| `POST /api/sound-design/cues` | |
| `POST /api/sound-design/motion` | job |
| `POST /api/sound-design/plan` | job → proposal |
| `POST /api/sound-design/check` | job |
| `POST /api/sound-design/check/last` | the sequence's last full report, kept across restarts, current / stale (Phase 5 verification) |
| `POST /api/sound-design/visual` | |
| `POST /api/audio/beats` | `{mediaKey, streamIndex?, startSeconds, durationSeconds, timeSignature?: 'auto' \| 2…12}` → bpm, beats, downbeats, beatsPerBar |
| proposal routes | §2.5 |

Capabilities gain `sound: {library:{sounds, packs}, synth: true}`.

### 2.9 Commands (`packages/project/src/commands/schemas/sound.ts`, `handlers/sound.ts`, owner `'sound-design'`)

| Command | Notes |
|---|---|
| `soundCue.add`, `soundCue.update`, `soundCue.remove {withClips?}`, `soundCue.resync` | |
| `soundDesign.place` | `{cueId?|frame?, layers[{mediaId, track?|'auto', align?, gainDb?, rate?, pitchSt?, pan?, role?}] 1..6, group?, alternatives?}` |
| `soundDesign.swap` | `{clipId, mediaId}` |
| `soundDesign.ensureBus`, `soundDesign.applyGains`, `soundDesign.setSettings`, `soundDesign.setCheck` | |
| `soundDesign.setVerdict` | a listen-here verdict marker bound to its moment (Phase 5 verification) |
| `audio.volumeDip` | |
| `media.setLibraryInfo` | |
| palette commands (`soundDesign.setPalette`) | |

Every command has undo/redo tests, tests for each refusal (`E_NOT_FOUND`, `E_INVALID_PARAM`, `E_TRACK_KIND`,
`E_TRACK_LOCKED`, `E_OVERLAP`), `describe_commands` examples (`examples.ts`) and registration in `catalog.ts`.
Add them to the integrity property test.

### 2.10 MCP (`apps/mcp/src/tools/sound.ts`, `proposals.ts`; `SOUND_GUIDE`, `PROPOSALS_GUIDE` in `FULL_GUIDE`; README tool list)

| Tool(s) | Annotations / notes |
|---|---|
| `sound_library_status`, `search_sounds`, `get_sound`, `list_sound_packs`, `list_sound_credits` | READ_ONLY |
| `view_sounds` | READ_ONLY; PNG contact sheet of waveform over spectrogram with a peak line, plus `cells` JSON |
| `import_sounds` | EDIT |
| `install_sound_pack` | EDIT, openWorld |
| `remove_sound_pack` | DESTRUCTIVE_IDEMPOTENT; approval card |
| `add_sound_folder` | approval card |
| `remove_sound_folder`, `rescan_sound_library` | |
| `find_sound_cues` | READ_ONLY |
| `set_sound_cues` | EDIT |
| `analyze_picture_motion` | job |
| `place_sound` | `apply` or `propose` |
| `swap_sound`, `align_peak` | |
| `plan_sound_design` | propose by default; returns a proposalId and a per-event report with `limitedBy` |
| `rebalance_sfx` | |
| `list_proposals`, `get_proposal`, `wait_for_proposal` | return decisions and notes |
| `accept_proposal` | policy-gated |
| `reject_proposal` | |
| `sound_check` | report, listen timecodes, optional PNG |
| `get_sound_check` | READ_ONLY; the last kept report, current / stale (Phase 5 verification) |
| `view_sound_timeline` | PNG |
| `export_sound_credits` | |

`SOUND_GUIDE` must say:

> You cannot hear. Judge sounds by descriptors and contact sheets, and sync by structure and sound_check.
> Align hits and lands by peak, and risers by end. Use auto gain. Prefer the palette and one family per type.
> At most one hero per ~2 s, never two heroes within 0.5 s, and no heroes under words. Propose, don't apply,
> unless asked. Give a reason and 1–3 alternates per item. Wait for the review and read the notes. Run
> sound_check, apply safe fixes, give the user the listen-here timecodes verbatim, and never claim something
> "sounds good". Use commercial-safe licences, and export credits when CC-BY sounds are used.

### 2.11 Export

- Rendering: nothing new.
- Optional `ExportSettings.credits?: {sidecar: 'txt'|'md'|null}`, written next to the output.
- Warning `W_SOUND_CREDITS` when CC-BY sounds are used without a credits sidecar; `W_SOUND_CHECK_STALE` is
  informational.
- Interchange: cues export as `SFX: <type>` markers, and the report notes that `soundDesign` is not carried.
- Oracle test: an exported mix with SFX matches the offline render at sample level.

## 3. Phases

The Definition of Done in `CLAUDE.md` applies to every phase. A phase is done only when:

- every requirement below is implemented and tested;
- the phase verification agent has run `pnpm verify` green on the integration branch;
- the feature has been run in the real app (preview and export) and its frames and screenshots looked at;
- the wp-note records the design, usage, verified behaviour, limits and evidence.

No stubs. Nothing partly wired may be counted as done.

### Phase 0: Pre-existing audio bugs

**Goal.** Fix real defects in the existing audio stack before building on it.

**Requirements**

- P0-R1. Audit `packages/project/src/audio/*`, `packages/project/src/essential/*`,
  `packages/compositions/src/audio/*`, `apps/web/src/audio/*`, `apps/engine/src/audio/*` and
  `packages/audio-fx/src/*`.
  - Look for real bugs: wrong results, preview/export mismatches, crashes on edge input, clamp-ordering mistakes,
    unvalidated input, NaN or Infinity propagation, filter-state clicks, aliasing, short-media edge cases.
  - Include the documented limits, where they are fixable defects:
    - "preview latency of track inserts is not compensated" (`docs/gaps.md` audio-fx; `wp-notes/audio-fx.md` §6);
    - "voice-over input latency is not compensated" (`wp-notes/audio-mix.md` §6).
  - Each candidate needs a failing regression test before it is fixed.
- P0-R2. Fix every confirmed bug with a regression test.
- P0-R3. Record every finding (fixed or rejected, with its reason) in `docs/wp-notes/sound-design.md` §Phase 0,
  and update `docs/gaps.md` and the area wp-notes where a limit is removed.

**Done when** every confirmed bug has a regression test that failed before and passes after; preview and export
mixes of track inserts match (sample-level oracle); and voice-over recordings land aligned, within one buffer, by
a test with a simulated input latency.

### Phase 1: Sound library foundations

**Goal.** Users and agents can find, look at, audition and import licensed sounds, fully offline, with
provenance and credits.

**Requirements**

- P1-R1. Taxonomy, rank and credits (pure, in project) and `LibraryProvenance` on `MediaAsset`, with
  `repairDocument` and `media.setLibraryInfo`.
- P1-R2. Descriptors and judge (pure, in audio-fx), with known-answer tests:
  - an impulse gives `peakSec` within 1 ms;
  - an exponential decay gives `decayMs`;
  - a sine gives centroid and MIDI;
  - white noise gives flatness ≈ 1;
  - pink noise gives the band shares.
- P1-R3. Jasper Synth kit (pure, deterministic, byte-hash test). The judge accepts every synth sound of its own
  type.
- P1-R4. The bundled **Kenney CC0 starter kit**: ≈ 40–60 sounds covering all 19 types where Kenney has them,
  ≤ 8 MB, in `apps/engine/sounds/starter/`. Each file has a sidecar, and `ATTRIBUTION.md` has rows.
  `pnpm lint` (`check-assets`) passes. The manifest records the source pack URL and its sha256.
- P1-R5. Engine library:
  - appdir paths, index (atomic), `sound-index` job (descriptors, judge, folder indexing via `TYPE_SYNONYMS`);
  - routes: search, get, audio, visual, register, roots, index;
  - capabilities;
  - user-folder roots with a per-folder licence declaration;
  - path validation (D-47).
- P1-R6. MCP: `sound_library_status`, `search_sounds`, `get_sound`, `view_sounds` (PNG), `import_sounds`,
  `list_sound_credits`, `add_sound_folder` (approval), `remove_sound_folder`, `rescan_sound_library`.
  `SOUND_GUIDE`, README, and the conventions tests must pass.
- P1-R7. Web:
  - the Sound Library panel (§2.7 minus cues and In Context), registered with its icon, `agentDescription` and
    keymap scope;
  - search, type chips, Refine pills, licence filter, results with mini waveform and peak tick;
  - Space audition, Auto-play, Loop;
  - insert at the playhead with the **peak aligned to the playhead** (pure helper from §2.3, frame-accurate in
    P1, sub-frame in P2), drag to the timeline with the new MIME and peak-edge snapping;
  - favourites, recents, used-in-project;
  - the empty state;
  - a "Sound Library" preferences page (folders);
  - i18n.
- P1-R8. Credits: `list_sound_credits` and File ▸ Export ▸ Sound Credits… (md/txt/csv).

**Done when**, offline, a user and an agent can each search the starter kit, see descriptors and a contact sheet,
audition, and insert a sound peak-aligned at the playhead as one undo step. The media carries its provenance,
credits list it, and the preview and an export both play it.

### Phase 2: Cues and placement

**Goal.** Cue points derived from the edit itself; sounds placed on them, peak-aligned to the sample.

**Requirements**

- P2-R1. `soundDesign` schema, `SoundCue`, `AudioClip.sfx` and repair (§2.2).
- P2-R2. `soundCue.*`, `soundDesign.place`, `soundDesign.swap` and `soundDesign.setPalette`, with undo, redo and
  refusal tests.
- P2-R3. `deriveCues` from every source in §2.2 except engine-only sources, with merge and budgets. Property test:
  it never throws and respects budgets on fuzzed documents.
- P2-R4. Placement math (§2.3). Property test: `sourceIn ≥ 0`, error ≤ 1 frame, and an exact sample when the head
  is quiet. **Verified on exported audio** at 23.976, 25, 29.97 DF, 30, 50, 59.94 and 60 fps.
- P2-R5. Layers, rotation, ±2 % variation, pitch, pan and auto tracks. `soundCue.resync`.
- P2-R6. Engine route `/api/sound-design/cues`. MCP `find_sound_cues`, `set_sound_cues`, `place_sound`
  (apply mode), `swap_sound`, `align_peak`.
- P2-R7. Web: the Cue Seam (glyphs, states, editing, keyboard), the Suggest Cues… dialog, Fill (Enter or drop on
  a cue), the peak handle, peak snapping, variation cycling with coalesced history, Add Layer…, Link/Unlink, the
  In Context audition, clip audio-type badges, clip context menu, menus, shortcuts and the Properties "Cue" and
  "Sound" sections.

**Done when**, on a fixture with a push transition, a keyframed logo, a text animator and cuts:

- Suggest Cues finds each event with a reason;
- filling places sounds whose peaks land on the cue frames, measured in the exported audio;
- undo and redo work everywhere;
- an agent can do the same through MCP.

### Phase 3: Proposals and review

**Goal.** A generic proposal mechanism, with sound design as its first user. Review on the timeline as ghosts;
apply as one undo step.

**Requirements**

- P3-R1. Model, `composeAcceptTx`, `proposalGhost` and validation (pure, tested). Properties: accepting A then B
  equals accepting A∪B; rejecting leaves the document identical.
- P3-R2. Engine store, routes, event, expiry and the policy gate on agent accept.
- P3-R3. `sound-design` plan job: cues → rank → register → place → **proposal**, deterministic by seed. Gains are
  descriptor-based until P4. Style options: density, palette, sources, respect dialogue.
- P3-R4. Session proposals slice and preview document. The Program monitor plays a proposal's picture and sound.
- P3-R5. MCP: `plan_sound_design`, `place_sound` (propose mode), `list_proposals`, `get_proposal`,
  `wait_for_proposal`, `accept_proposal`, `reject_proposal`, with `PROPOSALS_GUIDE`.
- P3-R6. Web: proposal card, ghosts, review bar, Review panel, A/B, alternates cycling on ghosts, notes, stale
  handling, trusted-event Apply, Undo with Reopen review, and the Auto Sound Pass… dialog.

**Done when** an agent's or the dialog's proposal can be reviewed, partly accepted, applied as one undo step and
undone back into review; accept on a changed document reports stale items; and E2E covers it.

### Phase 4: Mixing

**Goal.** Placed sounds are audible but not too loud, and glued together.

**Requirements**

- P4-R1. Masking solver with ordered constraints and post-verification (§2.4). Unit and property tests: monotone
  in the bed until a cap, and caps always hold.
- P4-R2. Engine bed render per cue cluster. `soundDesign.applyGains`, `rebalance_sfx` and integration into the plan
  job with `limitedBy` reasons.
- P4-R3. Stop-before, build, `audio.volumeDip` and `soundDesign.ensureBus` (room glue).
- P4-R4. Delivery presets, wired to `mixer.setLoudness`, Essential auto-match and ducking.
- P4-R5. Essential Sound SFX additions (§2.7) and the "Rebalance SFX Levels" menu item.

**Done when**, on the fixture project, every placed event reaches its target lift or reports a `limitedBy`
reason, and the export matches the preview mix (sample-level oracle).

### Phase 5: Sound Check

**Goal.** Measured QA that both the user and the agent can act on.

**Requirements**

- P5-R1. The `sound-check` job with every check and code in §2.6, plus the report schema, `soundDesign.setCheck`
  and staleness.
- P5-R2. Visual data routes. MCP `sound_check` and `view_sound_timeline` (PNG).
- P5-R3. Web Sound Check panel: fixes, Fix all safe, sync strip, the listen-here list with verdict markers, and
  the Export dialog option.
- P5-R4. Seeded-defect tests, each detected with the right code:
  - 2-frame offset;
  - masked hit;
  - 0.8 s silence;
  - music 3 LU under voice;
  - TP −0.2;
  - short media.

  A clean fixture must pass.

**Done when** P5-R4 holds, and the panel and the MCP tool show the same report.

### Phase 6: Packs, more cue sources, completion

**Goal.** The feature is complete and documented, and the integration branch is merged.

**Requirements**

- P6-R1. Pack catalogue: the remaining Kenney audio packs, plus BigSoundBank items with a verified CC0 licence.
  Pinned sha256, licence shown before install, `sound-pack-install` job, removal behind approval, Help ▸ About
  licence entries, `list_sound_packs`, `install_sound_pack`, `remove_sound_pack`, and the preferences UI. Tests use
  `JASPER_SOUND_CATALOG` with `file://` URLs and no network.
- P6-R2. `motion-analysis` pixel fallback for footage, scene and beat cue sources, `/api/audio/beats`, and
  `analyze_picture_motion`.
- P6-R3. Transcript- and VAD-aware dialogue suppression, and Essential Sound **Auto Tag**: classify a clip as
  dialogue, music, sfx or ambience from descriptors plus VAD, with a command, MCP tool, UI action and badge.
- P6-R4. Credits sidecar in export and `W_SOUND_CREDITS`; interchange cues exported as markers.
- P6-R5. Sound Design workspace; docs (ARCHITECTURE decisions D-50 sound library and provenance, D-51 proposals,
  D-52 sound design as ordinary commands, §4.3, §11.3), `docs/gaps.md` and `docs/parity.md` entries with
  evidence, README, and a complete wp-note.
- P6-R6. `e2e/sound-design.spec.ts`: fixture → Suggest Cues → Auto Sound Pass → review → accept part → one undo →
  Sound Check → export → frames and audio timing checked.
- P6-R7. `pnpm verify` and `pnpm notices --check` green; then merge `feat/sound-design` into `main`.

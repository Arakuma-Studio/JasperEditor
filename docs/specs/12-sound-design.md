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

A second source, `github.com/Leonxlnx/earshot` (MIT), was analysed on 2026-10-17. What we took from it is in §4
(requirements P6-E1…P6-E14 and their work packages). The analysis and the rejected ideas are in the wp-note, "Phase 6
→ earshot analysis".

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
the local-path import rules. A sound whose quiet head is shorter than 50 ms (and which is at most 1 h long; 120 s before WP6.5b),
from any source, is registered as a managed WAV copy with 50 ms (whole samples) of digital silence in front, so placement
(§2.3) is always sample-exact; its provenance's descriptors describe that copy and `leadSilenceSec` records the
padding (decision of the Phase 1 verification; schema v7). A sound of at most 1 h whose −60 dB tail ends less than
50 ms before the end of its file (or whose tail the analysis did not reach) also gets 50 ms of digital silence after it
(`trailSilenceSec`; a folder sound that needs it is copied, like one that needs the lead), so a placed clip, rounded up to
the end of the sound, stays inside its media (fix "SFX tail truncation"). The copy is bit-exact and deterministic, so
repeated registrations dedupe. Copies (lossy sources too) are written by ffmpeg file to file in the narrowest PCM WAV
that holds the decoded samples exactly (16-bit for 8/16-bit sources, 24-bit for ≤ 24-bit ones, float for float
decoders: every lossy codec), WAV rather than FLAC because browsers decode PCM WAV in their own JS on every platform
(WP6.5b measured Google Chrome's FLAC decode not bit-exact for 16-bit). A copy over 2 GiB, or one that would leave less
than 512 MiB free on the media volume, is not written: the sound is registered as it is and the response's `inexact
{reason: too-long | too-large | disk-space, message}` says so (also for sounds over 1 h). A copy made by an earlier
build has another fingerprint: the next insert or import replaces it in place (`media.upgradeLibraryCopy`: same media
and Project item, every clip moved in content time by the lead difference, the same samples at the same times), so a
project never holds two copies of one sound. The client commits `media.register` (or that upgrade) into a
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
  placement: {align, peakFlicks, errorFlicks}, pitch?: {st, baseRate} }   // pitch: WP6.5b, the applied shift and the
  // speed under it (the seeded variation), so a pitch reset is exact; absent or not matching the speed: whole semitones
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
  room (copies registered before, sounds over 1 h, project audio, faster speeds) end less than one frame past their
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

**Overlapping sound effects (WP6.5b).** A sound effect of a lower weight playing under an event is part of that
event's bed for the lift (ambient → support → hero), counted by its energy under the event's window (its energy
profile); peers (the same weight) and the layers of one cue do not mask each other, and a hero does not mask its supports
(constraint 3 keeps them under it on purpose). The gains depend on each other through that masking, so the solve repeats
with the lower sounds at the previous pass's gains until no gain moves more than 10⁻⁴ dB (at most 32 more passes,
deterministic; `W_UNCONVERGED` otherwise). Headroom (6) then also holds for the **summed** true peak of the measured
sounds playing at once, moment by moment from their peak profiles (Σ of amplitudes, an upper bound of their sum's true
peak): the sounds of a moment over the ceiling are lowered together (`limitedBy: overlap-headroom`). The bed cap and the
dialogue guard stay against the bed. **Speech** for the dialogue guard is the dialogue the mix lets through
(`dialogueSpans`): a section a clip gain, clip Volume keyframes, a track mute or Volume automation, solo, a submix or the
Mix fader take to −40 dB or below is not speech for any consumer (solver, cue suppression, `place_sound`'s hero
warning, Sound Check).

**Race with edits (WP6.5b).** The rebalance and delivery jobs put `soundDesign.expectMix {mixHash, delivery}` first in
their transaction: an edit of the mix that lands after their last check refuses the transaction (`CONFLICT`,
retryable) instead of being fast-forwarded over.

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
`soundDesign.settings.agentsMayApply` is on. Every accept is **journalled** (WP6.5b): an intent file next to the proposal,
written atomically before the transaction with the id bodies the transaction creates its entities with, removed after
the item states are written; an intent found later (a crash, a lost relay answer) is settled from the document when the
proposal is next read — recorded accepted when the document has what it created, rolled back when it does not — so an
item is never left pending while applied, nor applied twice.

**Session** (`packages/session/src/proposals.ts`): a proposals slice and `previewProposal(id, itemIds)`, which
builds a non-committed preview document, recomputed debounced on `doc.changed`. The Program monitor renders
picture **and sound** from it while "Hear proposal" is on. The preview applies items in batches (up to 32 per
transaction, sized to the editor's time slice) with every ghost attributed to its item exactly (else the batch is applied
one item at a time), reuses the documents of an earlier preview that started the same way, and checks the invariants on
the result as Apply would at any size: an item that breaks one only together with the items before it is found by
bisection and shown stale in the preview ("conflicts with the items before it"), not only at Apply (WP6.5b).

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

**Safe fixes are judged together** (WP6.5b, `planSoundCheckFixes`): Fix all safe, a single Fix, MCP `sound_check`'s
`safeFixes` and the report's `safe` flags apply the candidates in order on a dry-run document (commands, then swaps,
then engine jobs) and re-validate each after the ones before it, with the report's level model (`levelGuard`: each
sound effect's lift, peak over the bed and true peak, linear in its gain, and the overlapping sound effects in its bed);
a fix that leaves any measured sound worse (further under its minimum lift, over its bed cap, its own true peak over the
ceiling, or — normalisation off — the bound on the mix's true peak where it plays over the ceiling), no longer resolves
its finding or no longer applies is left for the next check with why. A mono Mix is checked in mono. A kept report goes
with its sequence (deleted once no editing session could bring the sequence back) and its project.

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
| `soundDesign.swap` | `{clipId, mediaId, align?, frame?, pitchSt?, alternatives?}`; `pitchSt` is applied over `sfx.pitch.baseRate` (exact reset to 0) |
| `soundDesign.ensureBus`, `soundDesign.applyGains`, `soundDesign.setSettings`, `soundDesign.setCheck` | |
| `soundDesign.setVerdict` | a listen-here verdict marker bound to its moment (Phase 5 verification) |
| `audio.volumeDip` | |
| `media.setLibraryInfo` | |
| `media.upgradeLibraryCopy` | `{mediaId, asset, ifPossible?, binId?, name?, label?, ref?, itemRef?}`: an older copy of a library sound gets the new copy in place, its clips moved by the lead difference (WP6.5b) |
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

## 4. Earshot-inspired additions (Phase 6 extension, P6-E)

Source: `github.com/Leonxlnx/earshot` ("ears for coding agents"), **MIT**, `Copyright (c) 2026 Leon Lin`, analysed at
commit `9721326` (v0.2.0, 2026-10-17). The full analysis, the comparison with what we have and every rejected idea with
its reason are in the wp-note, "Phase 6 → earshot analysis". This section lists only what we accepted.

### 4.0 Rules for this section

- **Ideas, numbers and named algorithms; no code.** earshot is Python; nothing is copied. Where a requirement says
  *adapted from earshot*, it reimplements a specific algorithm or threshold set described there. AGENTS.md §3.4 covers
  algorithms too, so the first work package that adapts one creates `licenses/ported/earshot.md` (upstream URL, MIT,
  the copyright line above, upstream path → our path per algorithm). Each later package adds its rows and runs
  `pnpm notices`.
- **Human decisions still hold.** There is no Freesound or online sound source, no AI or generated audio (earshot's
  `forge` / `fit` are out), only CC0 or permissive assets, local-first, no paid services and LGPL-only ffmpeg
  (earshot's music stretch uses the GPL `rubberband` filter; we never do). The ML models earshot depends on (CLAP,
  AST) are not adopted. The only exception is P6-E14, which is gated on a human decision.
- **Our §1 principles apply to every item.** Results are ordinary undoable edits. Analyses are deterministic and
  quantised. Every UI action has an MCP / route twin and the reverse. Bulk changes go through proposals. Every
  audible property has a measured or visual proxy.
- **earshot's measured norms are defaults, not truths.** Some come from 7–8 third-party films measured by one
  person. Wherever a number below is such a norm, the wp-note cites it as "earshot norm (n = …)" and the user can
  change it.
- Each requirement's "Done when" is in addition to the CLAUDE.md Definition of Done. That includes: i18n with es.json
  complete, design tokens, keyboard operation, README tool list and guide, undo/redo/refusal tests, fuzz where input
  is untrusted, a real-app run with frames looked at, and the wp-note.

Priority: **P1** = build now (highest value per effort); **P2** = next; **P3** = gated.

### 4.1 Requirements

**P6-E1 (P1). Sound Check: clicks and cut edges (`CLICK`, `EDGE`).** Today's checks look at placed library sounds.
Pops at edits come from user trims, music splices and remix joints, and nothing finds them yet.

- `CLICK`: a burst detector on the delivered mix and on each stem. A burst is a sample of the signal high-passed at
  14 kHz that is > 9× its 20 ms RMS and > 6× its 4 ms RMS, with ≥ 80 % of the burst's energy inside 1 ms (adapted
  from earshot `qa.py`).
  - A burst within 2 ms of an audio clip's start or end, a remix joint or a transition edge is an **error** ("click
    at an edit"), naming the clip and the edge.
  - A burst inside a clip's body is **info** (a transient in the recording).
  - Fix: the shortest fade the model expresses at that edge (a 1-frame constant-power audio transition, or volume
    keyframes when the edge allows sub-frame keys). Dry-run; safe.
- `EDGE`, on every audio clip edge that is not library padding:
  - *abrupt entry*: the source in the 20 ms before the in point is within 20 dB of the clip's peak, there is no
    fade-in ≥ 5 ms, and no attack within 10 ms covers it;
  - *chopped decay*: at the out point the level is > −35 dB re the clip's peak, the source after it continues above
    −35 dB, and the fade-out is < 30 ms;
  - *chopped music*: a music piece (remix piece, or a cut music clip followed by another) keeps sounding within 6 dB
    after its out point, over 6 dB above what enters, with a crossfade < 100 ms.
  - Severity warning. Fix: lengthen the fade or crossfade (safe when the dry-run applies), or trim to the decay (not
    safe).
- Edges at the sequence's own start and end belong to P6-E3, not here.

*Done when* seeded fixtures are each reported with the right code, clip and frame (± 1 ms), and applying the reported
fix clears them on the re-check: a clip whose head starts mid-sound, a click sample at an edit, a music clip cut
mid-note, a remix piece joined on a sustained chord. The Phase 5 clean fixture still passes. The detectors survive
fast-check fuzz (NaN, DC, silence, one-sample and 30-minute inputs) and never throw. The panel and `sound_check` show
the same findings.

**P6-E2 (P1). Sound Check: harshness and dead layers (`HARSH`, `LAYER_INAUDIBLE`).**

- `HARSH`: a placed sound's 2–6 kHz 5 ms-RMS peak on the delivered scale is more than 6 dB above the loudest 2–6 kHz
  5 ms RMS of the music stem anywhere in the range. With no music the dialogue stem is used; with neither the check
  is not judged. Severity warning. A sound whose centroid is > 6.5 kHz gets an info. (2–6 kHz is the band phone and
  laptop speakers make painful first; adapted from earshot `qa.py`.)
  - Fix: −excess dB of gain, safe only when the MASKED minimum still holds after it. Otherwise a parametric dip at
    the sound's 2–6 kHz peak with the existing EQ effect (not safe).
- `LAYER_INAUDIBLE`: a layer of a multi-layer cue that adds < 1 dB in every 1/3-octave band (100 Hz–12.6 kHz) over
  the bed plus the cue's other layers, measured over the layer's loudest 60 ms. Severity info. Fix: remove the layer
  (not safe), or apply the gain that would make it add 3 dB in its dominant band (not safe).
  - This also closes the Phase 4 limit "SFX do not mask each other" for layers.

*Done when* a hot 4 kHz click over quiet music is reported as `HARSH` and its safe fix clears it; a layer
50 dB under its partner is reported as `LAYER_INAUDIBLE`; the clean fixture passes; the measurements are
property-tested (monotone in gain, never throw).

**P6-E3 (P1). Sound Check: coverage, ending and arc (`COVERAGE`, `ENDING`, `ARC`); riser sync window.**

- `COVERAGE` ("once a class of action is sounded, every instance is"). A class is the cues sharing kind and anchor
  source. Within that, text and keyframe cues group by clip or pattern group, and cuts by track. When ≥ 2 cues of a
  class are filled and ≥ 1 is not, the check warns and lists the unfilled ones. Muted cues, `ambient` cues and cues
  silenced by dialogue are excluded.
  - Fix: fill them with the sound the class already uses (a proposal; not safe), or mute them (which makes the
    silence deliberate).
- `ENDING`: the delivered mix's last 50 ms RMS is > −45 dBFS, or its last 10 ms peak is > −60 dBFS, at the end of
  the sequence. Severity warning ("ends mid-sound"). The same check runs on the range end when the range reaches the
  sequence end.
  - Fix: a fade on the Mix volume lane (`mixer.writeAutomation`, 0.5 s by default; not safe).
  - `HEAD` (info): the first 5 ms peak is > −40 dBFS, so the file starts with a click at sample 0. Fix: a 3 ms fade
    on the same lane.
- `ARC` (info): the loudest 3 s short-term window of the delivered mix holds no hero cue while hero cues exist, or it
  lies in the last 15 % of the sequence with no hero there. The message names the loudest moment and the biggest
  hero.
- Sync of end-aligned sounds (risers, reverses): `OUT_OF_SYNC` accepts an end from −250 ms to +30 ms of the cue. A
  riser ending just before its hit leaves "a beat of air", which is deliberate (earshot norm). Other kinds keep their
  frame tolerances.

*Done when* seeded fixtures fail and pass as described, with fixes: 3 of 4 staggered cards filled; a mix cut at a loud
frame; a 2 s fade-out passes; a riser ending 120 ms early passes and one ending 400 ms early fails.

**P6-E4 (P1). Acknowledged findings.** Deliberate exceptions should stop coming back, and agents should stop "fixing"
them (earshot's `qa_ok`).

- Model: `SoundDesign.acknowledged?: Record<key, {code, reason (1–300 chars), by: 'user'|'agent', at, target:
  {clipIds?, cueId?, frame?}, inputsHash}>`, at most 500 entries.
  - `key` is a stable fingerprint of the finding: its code, its target ids, and its frame rounded to the frame when
    there are no ids.
  - `inputsHash` covers the target clips' and cue's relevant fields.
  - `repairDocument` drops malformed entries and is idempotent.
- Commands: `soundDesign.acknowledgeIssue {key, code, reason, target}` and `soundDesign.unacknowledgeIssue {key}`.
  Both are undoable. Agents may acknowledge `info` and `warning` findings only; an `error` needs the user
  (`E_APPROVAL_REQUIRED` otherwise).
- Sound Check marks matching findings `acknowledged: {reason, by}`. They are left out of the verdict and counted in
  `counts.acknowledged`. When the target's `inputsHash` changed, the finding is reported again, as "acknowledged
  before the change".
- MCP `acknowledge_sound_issue` (EDIT). The panel gets "Acknowledge…" (reason field), a collapsed "Acknowledged (n)"
  group, and Unacknowledge.

*Done when* there are undo/redo/refusal tests (including an agent acknowledging an error). A re-check after
acknowledging improves the verdict and lists the finding as acknowledged. Editing the clip brings the finding back.
The panel and MCP agree.

**P6-E5 (P1). Check a proposal before review (what-if).** This is earshot's "variants" idea: critics test their fixes
in a copy before one writer applies them. Ours is the proposal.

- `POST /api/sound-design/check {…, proposalId, itemIds?}` runs the `sound-check` job on the proposal's preview
  document: `composeAcceptTx` on the current document, never committed. Stale and invalid items are skipped and
  listed.
  - The result adds `delta` against the current document's kept report, or against a fresh base run when there is
    none or it is stale (`base: 'kept'|'run'`). `delta` holds:
    - per-code counts before and after;
    - `fixed[]` (finding keys present before and absent after);
    - `introduced[]`, each with the `itemId` whose clips it names.
  - It never writes `lastCheck` and never changes the document revision.
- The engine stores the summary on the proposal (`report.check`). The Review panel shows "Sound Check of this
  proposal: fixes 3 · introduces 1" with each introduced finding linked to its item.
- MCP: `sound_check {proposalId, itemIds?}`; `plan_sound_design {check: true}` checks the new proposal and returns the
  delta.
- `SOUND_GUIDE` and `PROPOSALS_GUIDE` gain a **review-lenses** section, each lens mapped to our tools:
  - sync: sync rows and the listening transcript;
  - edges: CLICK / EDGE;
  - masking: MASKED / LAYER_INAUDIBLE;
  - tonal: HARSH and the reference bands;
  - director: ARC / ENDING, the reference profile and the transcript.
- The guide also states these rules:
  - **one writer**: one proposal per pass, alternatives merged into it, checked with `sound_check {proposalId}`
    before handing it over;
  - never hand over a proposal that introduces errors without saying so;
  - acknowledge deliberate exceptions with a reason (P6-E4);
  - write search queries as "source + material + action + character", not the use.

*Done when* a proposal that fixes a seeded MASKED and introduces a REPEAT reports exactly that, with the item id;
the document revision is unchanged; the result is deterministic; the Review panel and MCP show the same delta; an
e2e step covers it.

**P6-E6 (P1). Listening transcript: an agent's ears for the whole mix.** Sound Check lists defects. Agents also need a
chronological account of what is audible and why. We can attribute every sound to its clip, which earshot cannot.

- Pure `packages/audio-fx/src/analysis/events.ts` (adapted from earshot `timeline.py`):
  - onsets from spectral flux (5 ms hop, robust z ≥ 3), refined to the attack on a 1 ms band envelope: the first
    millisecond within 20 dB of the event's peak above its bed;
  - per event:
    - prominence over the K-weighted bed: 10 ms windows; the bed is the median of the 20–300 ms before;
    - the band it stands out in: low < 200 Hz, high > 2 kHz, or full;
    - length to −20 dB;
  - swells: rises ≥ 8 dB over 0.25–2 s, mostly monotone, timed at their peak;
  - silences and drops: fast loudness 20 LU under integrated for ≥ 0.25 s;
  - accents: the top 20 % by prominence and ≥ 6 dB over the bed.
- Engine job `sound-listen` (`POST /api/sound-design/listen {projectId, sequenceId?, range ≤ 10 min, detail}`):
  - renders the stems with `stems.ts`;
  - detects events on the mix and attributes each to the stem and clip whose own event explains it, and to the cue
    it fills;
  - attributes sections to the Auto Tag classes per stem (dialogue, music with its ducking depth, ambience,
    silence);
  - matches picture events (edits, transitions, cues, cached measured motion) to the event that answers them: OK
    within 1 frame, near ≤ 100 ms, swell ≤ 300 ms, else none;
  - reports **chance levels** next to every sync share: the share random times would score with the same event
    density (adapted from earshot), so "60 % of cuts have a sound" means something;
  - adds on-beat stats when beats are known.
- Output: `lines[]` (text, frame, timecode), `events[]` (frame, ms, shape, band, prominenceDb, bedDb, stem, clipId,
  cueId, answers), `sections[]`, `sync {…, chance…}`, `unanswered[]` (picture events with no sound), `loudness`.
  - Example line: `00:00:03:00 hit, high band, +18 dB over the bed · SFX A3 "Impact 2" (hero, cue cut) · answers Cut
    V1 "A"→"B", 0 ms`.
  - Events not explained by any placed sound are named by their clip, for example "production audio, A1
    'Interview'". Agents see existing hits before stacking new ones.
- MCP `listen_to_sequence {projectId, sequenceId?, range?, detail?, images?}`: READ_ONLY, waits for the job, returns
  the text first, then compact JSON, and the P6-E7 sheet when `images`. Web: a "Log" tab in the Sound Check panel
  lists the same lines; clicking a line jumps the playhead there.

*Done when*, on the Phase 4 fixture plus a production-audio hit inside the dialogue: every placed sound's event is
found within 1 ms of its aligned point and attributed to its clip; the dialogue hit is attributed to the dialogue clip;
≥ 90 % of placed sounds are found in a mix where they sit 6 dB under the music (measured and recorded). The chance
numbers equal a brute-force computation; fuzz never throws; the time for a 10-minute sequence is measured and
recorded; the panel and MCP lines are identical.

**P6-E7 (P1). Annotated sound sheet.** `/api/sound-design/visual` and `view_sound_timeline` gain new lanes (as
earshot's `sheet`):

- a **picture lane**: thumbnails at the cut, cue and event frames, rendered through the export path, at most 12 per
  strip, like `analyze_picture_motion`'s PNG;
- a **spectrogram lane** of the mix: log frequency, u8, 10 ms × 96 bands;
- a **sections band** from P6-E6;
- **cue markers drawn by answer status** (OK / near / none, by shape and colour, never colour alone).

`cells` gives each lane's geometry. `listen_to_sequence {images: true}` returns this sheet. The web Log tab can show
the spectrogram lane.

*Done when* the PNG decodes and `cells` locates every lane, cue and thumbnail in tests on the fixture, and the sheet
of a real run has been looked at (recorded in the wp-note).

**P6-E8 (P2). Reference sound profile ("compare with a reference").** "Make it sound like the films I like",
measured and without models (adapted from earshot `profile.py` / `critique.py`).

- Build a profile from 1–20 reference media the user owns: project media, or absolute paths in local mode with the
  usual path rules. Metrics per reference:
  - loudness: integrated, true peak, LRA, crest (loudest 3 s minus integrated);
  - arc: 11 points; intro and end 10 % level; peak position; first sound; longest gap; end silence; fade length;
    final-hit level and tail;
  - density: onsets per second (P6-E6); salient hits per second (100 ms loudness jumps ≥ 6 dB within 80 ms to
    within 8 LU of integrated); stop-downs per minute;
  - sync: picture events per second, from our scene detector on the reference picture, and the share with an onset
    within ±100 ms and within 1 frame, each with its chance level;
  - spectrum: energy share in sub 20–60, low 60–250, low-mid 250–1k, mid 1–4k, presence 4–8k and air 8–16k Hz;
    brightness;
  - stereo: side/mid dB, correlation;
  - speech share (VAD).
- A profile holds, per metric, the median, p10–p90, min–max and n. It stores numbers only, never audio:
  `<appdir>/sounds/profiles/<id>.json` (atomic), with each reference's title and fingerprint.
- Sound Check `profileId?` adds a "Reference" category with one row per metric:
  - value; range (min–max widened by a per-metric measurement tolerance); status ok / low / high; weight;
  - what to do, with timecodes from P6-E6 (the cuts with no sound, the gaps, the dead end).
  - Rows are info or warning, never error: they describe a style, not a defect. LOUDNESS / TRUE_PEAK keep following
    the delivery preset. A reference checked against its own profile is scored leave-one-out.
- MCP: `build_sound_profile {name, mediaIds | paths}` (job), `list_sound_profiles`, `delete_sound_profile` (approval
  card: user data), `sound_check {profileId}`. Web: "Compare with reference…" in the Sound Check panel, a "New
  reference profile…" dialog that picks media from the bins, and the list in Preferences ▸ Sound Library.
- **No bundled profile.** earshot's 7-film launch profile describes one style, so we reject it; the reason is in the
  wp-note.

*Done when*:
- every metric passes known-answer tests: −20 LUFS pink noise; a 1 s gap; a hard end vs a 2 s fade; clicks at 2/s
  give 2 onsets/s; a generated 0.5 cut/s picture;
- a profile of three generated "films" gives the expected ranges;
- a matching sequence passes every row;
- a seeded mismatch (air −6 dB, 2 s dead end, no sound on 5 of 6 cuts) is flagged by the right rows with timecodes;
- leave-one-out works;
- the panel and MCP show the same rows.

**P6-E9 (P1). Takes: multi-hit recordings become variation pools.** The judge marks multi-hit files down today, but a
recording of ten key presses is the best variation pool there is ("vary the take, not the pitch").

- The library analysis splits a file of several hits into **takes** (`onsetCount ≥ 2`, ≤ 120 s; adapted from earshot
  `search.find` candidates):
  - a take runs from one onset until the sound has decayed 35 dB, never into the next onset;
  - onsets < 0.25 s apart join into one event (a key's down- and up-stroke);
  - never across ≥ 10 ms of digital silence (separate takes in a pack);
  - each take starts 5 ms before its attack and ends 20 ms after the decay.
- Each take records `headDb` / `tailDb` (its first 5 ms / last 10 ms against its peak). Clean means tail ≤ −30 dB
  and head ≤ −15 dB. A `head cut` or `tail cut` take is recorded but never offered.
- At most 64 takes per file. Each take gets its own descriptors and judge; a take is never `multi-hit`.
  `SoundEntry.takes?: SoundTake[]` is optional, so old index files load. Take ids are `snd_<16 hex>~t<n>`, and the
  snapshot hash covers them.
- Registering a take makes a managed WAV copy of its range with the existing lead and trail padding (sample-exact
  placement). The provenance gets `take {soundId, index, sourceStartSec, sourceEndSec}`; licence and credit are the
  parent's. Rotation, swap, variation cycling and REPEAT treat the takes of one file as its first variation pool.
- Search rows say "12 takes"; `takes: true` returns takes as rows. The Library panel has a disclosure under the row
  listing the takes (mini waveform, audition, insert, drag). MCP: `search_sounds {takes}`; `get_sound` lists the
  takes; `view_sounds` and `import_sounds` accept take ids.
- New judge flags in the same pass, from the sourcing rules of earshot's real-sound skill:
  - `lowpassed`: 95 % rolloff < 12 kHz in a ≥ 44.1 kHz file of a type that needs air (a lossy cliff);
  - `noisy-floor`: the floor between events is > −55 dBFS;
  - `dc-offset`: |mean| > −40 dBFS.

*Done when*:
- a generated file of 10 clicks separated by digital silence gives 10 clean takes;
- a typing file with down/up pairs gives joined pairs;
- a take cut at a boundary is flagged and not offered;
- a registered take placed on a cue peaks on the cue frame in the exported audio (measured);
- rotation over takes never repeats consecutively;
- the index stays deterministic and old indexes load;
- fuzz (hostile files, 1-sample, all-silence) never throws.

**P6-E10 (P1). Cue grammar and variation policy.** These rules make a pass sound designed rather than random. They
come from earshot's launch-film grammar and study; the norms are cited in the wp-note.

- **Variation policy per type**, in the taxonomy (`variation`):
  - `ui` and `click` keep **one voice per sequence**: the palette sound or the first one placed, with no varispeed
    and no gain jitter ("one click voice, same level every time");
  - `key`, `tick` and `tap` rotate takes and sounds with ±1 dB gain jitter and **no varispeed** (random pitch on
    typing is a cheap tell);
  - other types keep §2.3 (±2 % varispeed, ±1 dB);
  - explicit user or agent rates and pitches are never overridden.
- **Runs climb.** A run is ≥ 3 consecutive `appear` / `emphasis` cues ≤ 0.6 s apart, filled with pop, ui, chime or
  tick (staggered cards, successive notifications). Each step is pitched +1 semitone (varispeed, `maintainPitch:
  false`), capped at +4 st. Run members share `group`; the reason reads "run 3 of 5: +2 st". `style.runs:
  'climb'|'flat'`, default climb.
- **Typing.** Above 25 typed units per second, place one key per word start instead of thinning to 12/s.
  `style.typing: 'auto'|'keys'|'words'|'silent'`. When music is present, an optional 6 dB `audio.volumeDip` sits
  under typing runs (`style.duckUnderTyping`, default off).
- **Music carries the cuts.** A cut inside an unmuted music clip (Essential or Auto Tag type music), outside
  dialogue, has its confidence halved; the reason reads "music carries the cut". `style.musicCarriesCuts`, default
  on. (earshot norm: most cuts in the measured films have no sound of their own.)
- **Personality** (`style.personality: 'calm'|'energetic'|'bright'|'precise'|'mechanical'|'warm'`). Each personality
  maps to Refine preferences (tone, attack, weight, texture), type boosts and exclusions, preferred materials and a
  default density. The table is a decision recorded in the wp-note; for example, calm means no boom or hit heroes,
  soft attacks and a dark tone. It is a select with a one-line description in Auto Sound Pass… and Suggest Cues…, and
  an option of `plan_sound_design`.
- **Palette coherence.** The ranking bonus for sounds that share the dominant material of the sequence's placed
  sounds of the same family uses `materials` from P6-E9's index ("one material family per film"). The index
  extracts materials from title, tag and folder words (`MATERIAL_SYNONYMS`: wood, glass, metal, plastic, paper,
  cloth, stone, water, air, electronic, rubber, ceramic). There is a Refine pill "Material" and `search_sounds
  {material}`. The bonus applies only when the field is present.

*Done when*:
- each rule has unit and property tests (deterministic, budgets hold, never throws);
- on the fixture a 4-card stagger climbs 0 / +1 / +2 / +3 st, measured in the export;
- clicks share one sound and one level;
- key sounds play at rate 1;
- a cut under music is dropped in balanced, with its reason;
- each personality moves the ranking in its documented direction;
- the material counts of the starter kit and packs are recorded.

**P6-E11 (P2). Music to picture: land the drop, stop on the bar, tune to the key.**

- Beat-grid phase: the remix analysis puts joints ≥ 3 ms before the measured attack of the downbeat. Beat trackers
  lag attacks by 20–50 ms, and a joint on a lagging grid chops the downbeat (adapted from earshot `arrange.py`).
  Verify the current `remix.ts` and fix it if it lags.
- Drop candidates: `analyzeBeats` returns `drops[] {sourceSec, bar, score}`. A drop is a bar within 3 dB of the loud
  bars that stays loud for 4 bars, scored by its lift over the 4 bars before it plus its novelty (adapted from
  earshot).
- `planRemix` gains `anchors[] {sourceSec, sequenceFrame}`: the drop, or any downbeat, lands on the frame within
  1 ms, with joints at bar lines, together with the duration target. It refuses with `E_INVALID_PARAM` (and says why)
  when no plan exists within half a beat.
  - Route: `/api/audio/remix-plan {anchors?}`.
  - MCP: `remix_audio {landDropAt: frame | {cueId} | 'hero', dropSec?}` and `find_music_drops {clipId}`.
  - The Remix dialog gets "Land the drop on: playhead / marker / hero cue", with the candidates listed with ▶.
- Stop-before on the bar: when the music clip's beats are known, the stop's ramp ends on the downbeat (else the
  beat) before the hero, inside the cue's `stopBefore.seconds` window. The reason reads "on the bar line".
  `style.stopOnBar`, default on.
- Tune to the key: `estimateKey(chroma)` uses the Krumhansl–Schmuckler profiles and returns a confidence.
  - Tonal types (chime, shimmer), and any sound with `pitchConfidence ≥ 0.8`, placed over a music clip with key
    confidence ≥ 0.6 are pitched to the nearest in-key note within ±2 st by varispeed. Reason: "tuned +1 st to A
    minor".
  - `style.tuneToMusic`, default on.

*Done when*:
- a synthetic track with a known drop at bar 17 gives that drop as the top candidate;
- the anchored plan lands it on the hero frame within 1 ms in the export (cross-correlation, measured);
- the remix joints of the Phase 4 music cause no P6-E1 finding;
- a chime of MIDI 70 over a C-major track is pitched to an in-key note within ±1 st;
- the stop ramp ends on the downbeat;
- hostile inputs (no beats, steady tone, 1 s clip) are refused with typed errors.

**P6-E12 (P2). Ambience and room-tone beds.** We place one-shots but cannot lay a bed: one ambience per location, cut
with the picture, looped without an audible seam.

- Pure `packages/audio-fx/src/analysis/loop-window.ts` finds the **clean window** of a bed recording: the stretch with
  the lowest onset activity and level variance, with no spike ≥ 10 dB over its 1 s neighbourhood.
- Command `soundDesign.layBed {range | shots, mediaId, gainDb?, fadeSec?, crossfadeSec?, duckUnder?: 'dialogue' |
  'heroes' | null, track?}` lays ordinary clips on an "Ambience" track:
  - one bed per scene or shot run (from scene cuts, V1 edits or a user range);
  - the clean window, looped with equal-power crossfades (≥ 1.5 s);
  - 1 s fades in and out by default, and a short crossfade at scene changes;
  - optional ducking through `audio.volumeDip`;
  - one undo step, and a proposal mode through the generic mechanism.
- Room tone: a `SILENCE` finding inside a dialogue region (a gap of < 10 s between dialogue) gets the fix "Fill with
  room tone" (not safe, dry-run). The tone is a `roomtone` sound from the palette or library, else the quietest 0.5–3 s
  stretch without speech (VAD) in the dialogue clip's own media, looped.
- MCP: `lay_ambience_bed {mode: 'propose'|'apply'}` and `fill_room_tone`. UI: Sequence ▸ Sound Design ▸ Lay Ambience
  Bed…, and the Sound Check SILENCE row's fix.

*Done when* a 3-scene sequence with a 4 s ambience over 20 s gets looped pieces with crossfades, and the Sound Check
of the result has no CLICK, EDGE, DIP or SILENCE there; the room-tone fix removes a seeded SILENCE in a dialogue gap;
undo is one step; an agent can propose it and the user can apply it.

**P6-E13 (P1). ShareAlike sounds.** Under CC BY-SA 4.0 §1(a), a sound recording synced in timed relation with a
moving image always produces Adapted Material. Under §3(b), the video must then be shared under BY-SA 4.0 or a
compatible licence. earshot forbids SA for this reason. We currently count BY-SA as commercial-safe with no warning.

- `licenseObligations(license)` returns `{attribution, shareAlike}`.
- BY-SA sounds get an "SA" badge in the Library and in clip badges. The credits text adds the ShareAlike notice.
- Sound Check `LICENSE` warns (variant `shareAlike`) when a BY-SA sound is placed. The ranking already puts BY-SA
  below CC-BY.
- **Human decision:** should the default "Commercial-safe" filter exclude BY-SA? Proposed: yes. BY-SA stays allowed
  when chosen explicitly.

*Done when* the obligations, badge, credits notice and check warning are tested and match between panel and MCP; the
default follows the human's answer.

**P6-E14 (P3, GATED: human decision). Describe-it search and "find the moment" with a local audio-text model.**
This is the one model-based idea worth having: folder sounds named `SFX_0023.wav` cannot be found by words, and a long
recording cannot be searched for "a single clean key press".

- An optional downloadable analysis model (`laion/larger_clap_general`, Apache-2.0; ONNX exports exist at about
  205 MB int8 text + audio and 783 MB fp32). It is installed through the processing-model catalogue pattern: pinned
  revision, sha256, licence shown before install, never bundled, never required.
- Embeddings are computed in `sound-index`: one repeat-padded 10 s window per sound or take, cached by fingerprint.
- Scores are calibrated as a z of the query among ≈ 300 descriptions **we write** from the taxonomy, materials and
  actions, with hub-phrase damping (the idea is earshot's; the vocabulary is ours). Verdict bands are re-validated on
  our library before any claim.
- Uses: `search_sounds {describe}`, `match_sound {soundId, description, alts?}`, take ranking by description, and
  event tags in P6-E6.
- Without the model everything works as it does now.
- **Not to be built until a human approves.** The open questions:
  1. whether this model's weights, and the licence of the ONNX export (the community conversion declares none; we
     would export from the Apache-2.0 base ourselves), are acceptable;
  2. whether a ≈ 200–800 MB optional download is acceptable.

*Done when* (after approval): install, index and search work offline; the verdict bands are measured on a held-out
labelled set from our packs (method and numbers in the wp-note); removing the model leaves search as before.

### 4.2 Work packages (P6-E WP list)

Lanes can run in parallel. Inside a lane, packages run in order. "Shared registries" are the files almost every
package appends to: `packages/api/src/routes.ts`, `jobs.ts`, `apps/mcp/src/server.ts`, `README.md` tool list,
`SOUND_GUIDE` in `apps/mcp/src/tools/sound.ts`, `apps/web/src/i18n/{en,es,model-strings}.json`,
`licenses/ported/earshot.md`, `THIRD_PARTY_NOTICES.md` and `docs/security-review.md`. Conflicts there are append-only;
resolve them by keeping both sides.

| WP | Requirements | Lane | Size | Depends on | Main files (owned) |
|---|---|---|---|---|---|
| **WP-E1** Sound Check: new findings | P6-E1, P6-E2, P6-E3, P6-E13 | A | L | — | `packages/audio-fx/src/analysis/{clicks,edges,harshness}.ts` (new), `check-curves.ts`; `packages/project/src/sound/{check,messages,license,credits}.ts`; `apps/engine/src/sound-design/{check,stems}.ts`; `apps/web/src/sound/check-model.ts`, `apps/web/src/panels/soundCheck/*`; `apps/mcp/src/tools/sound-check.ts`; creates `licenses/ported/earshot.md` |
| **WP-E2** Acknowledge + check a proposal + review lenses | P6-E4, P6-E5 | A | M | WP-E1 merged | `packages/project/src/schema/sound.ts`, `commands/{schemas,handlers}/sound.ts`, `catalog.ts`, `examples.ts`, `sound/repair.ts`; `apps/engine/src/sound-design/check.ts`, `apps/engine/src/proposals/*`, `routes/sound-design.ts`; `packages/api/src/sound-check.ts`; Review panel and Sound Check panel; `apps/mcp/src/tools/{sound-check,proposals,sound}.ts` (guides) |
| **WP-E3** Listen: events, transcript, sheet | P6-E6, P6-E7 | B | L | — | `packages/audio-fx/src/analysis/events.ts` (new); `apps/engine/src/sound-design/{listen.ts (new), visual.ts}`; `packages/api/src/sound-design.ts` (listen schemas); `packages/engine-client`; `apps/mcp/src/tools/{sound-listen.ts (new), sound-timeline.ts}`; `apps/web/src/panels/soundCheck/LogTab.tsx` (new, registered in the panel only) |
| **WP-E4** Reference profiles | P6-E8 | B | M | WP-E3 (`events.ts`), WP-E1 (check.ts categories) | `packages/audio-fx/src/analysis/profile-metrics.ts` (new); `packages/project/src/sound/profile.ts` (new); `apps/engine/src/sound-design/profile.ts` (new), profile store, `check.ts` (Reference category); `apps/mcp/src/tools/sound-profile.ts` (new); web dialog and panel section |
| **WP-E5** Takes, judge flags, materials | P6-E9 (+ the `materials` index field of P6-E10) | C | L | — | `packages/audio-fx/src/analysis/{takes.ts (new), sound-judge.ts}`; `packages/api/src/sounds.ts`; `apps/engine/src/sounds/{analysis*,index-job,library,search,pad,service,visual}.ts`; `packages/project/src/sound/{provenance,materials (new)}.ts`, `schema` media library field; `apps/web/src/panels/soundLibrary/*`; `apps/mcp/src/tools/sound.ts` (search / get / view / import) |
| **WP-E6** Cue grammar, variation policy, personality, palette coherence | P6-E10 (without the index field) | D | M | none to start; palette coherence reads `materials` when WP-E5 has merged; takes as the rotation pool once WP-E5 has merged | `packages/project/src/sound/{taxonomy,variant,rank}.ts`, `sound/cues/{derive,budget,text-*}.ts`; `apps/engine/src/sound-design/plan.ts`; plan `style` schema in `packages/api/src/sound-design.ts`; `apps/web/src/sound/{AutoSoundPassDialog.tsx, cues/SuggestCuesDialog.tsx}`; `apps/mcp/src/tools/sound-design.ts` |
| **WP-E7** Music to picture | P6-E11 | E | M | its `plan.ts` integration (tune to key, stop on bar) after WP-E6 merges | `packages/audio-fx/src/analysis/{remix.ts, key.ts (new)}`; `apps/engine/src/audio/beats.ts`, remix-plan route; `packages/api/src/audio-fx.ts`; `packages/project/src/sound/{tuning.ts (new), mix.ts}`; `apps/mcp/src/tools/audio-fx.ts`; web Remix dialog |
| **WP-E8** Ambience and room-tone beds | P6-E12 | F | M | WP-E1 (SILENCE fix in `check.ts`), WP-E2 (`commands/*/sound.ts`) merged | `packages/audio-fx/src/analysis/loop-window.ts` (new); `packages/project/src/sound/ambience-bed.ts` (new), the `soundDesign.layBed` command; an engine route; `apps/mcp/src/tools/sound-beds.ts` (new); web menu and dialog |
| **WP-E9** Describe-it search (CLAP) | P6-E14 | G | L | **human approval**; WP-E5 (takes) | processing-model catalogue, `apps/engine/src/sounds/semantic.ts` (new), search route, `apps/mcp/src/tools/sound.ts` |

Start now in parallel: **WP-E1, WP-E3, WP-E5, WP-E6, WP-E7** (lanes A–E; their owned files do not overlap, apart from
the shared registries). Next: **WP-E2** after WP-E1, **WP-E4** after WP-E3 (and WP-E1), **WP-E8** after WP-E2.
**WP-E9** waits for the human.

Each package appends a wp-note section "Phase 6 → WP-E<n> …" (what was built, usage, the commands it ran and their
results, limits). It must not raise any number in `docs/gaps.md` or `docs/parity.md` without rerunnable evidence.

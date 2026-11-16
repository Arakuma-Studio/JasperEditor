# Spec 01: Project model and editor state

Status: functional spec, v1 (2026-09-30). Clean-room document: written from product requirements, Premiere Pro behavior and our own research docs. It contains no code, identifiers, paths or comments from any purchased template. Implementers work from this spec, the other files in `docs/specs/`, `docs/research/` and `docs/ARCHITECTURE.md`.

Scope:
- the **project document** (the persisted, undoable data);
- the **editor session state** around it (selection, view state, jobs, runtime media status);
- the **command layer** that humans and AI agents use to change the document;
- undo/redo, persistence, clipboard, and the asset lifecycle (import, proxies, derived media, cleanup).

Other specs own timeline gestures (trim tools, snapping UX), panel layout, rendering and export pipelines. This spec owns the data they operate on, and the command semantics they call.

Related research (ours): `docs/research/premiere-ui-design-spec.md` (Premiere concepts, panels, keymap), `docs/research/native-video-libraries.md` (ffmpeg engine, proxies, OTIO), `docs/research/fframes.md` (motion-graphics engine), `docs/research/orquester-multiplatform-setup.md` (web / PWA / Electron / engine daemon topology).

---

## 0. Conventions

### 0.1 Requirement IDs and priority

Each requirement has an ID `<AREA>-<NNN>` and a priority:

| Priority | Meaning |
|---|---|
| **P0** | Needed for the first usable editor (MVP). |
| **P1** | Needed for "Premiere-parity v1". Model it now even if the UI comes later: the schema must already carry the fields. |
| **P2** | Later. Reserve the concept; do not build it yet. |

Area prefixes:

| Prefix | Area | Section |
|---|---|---|
| ARC | Architecture and package boundaries | 1 |
| TIME | Time model | 2 |
| ID | Identifiers | 3 |
| DOC | Document root and JSON rules | 4 |
| PRJ | Project and bins | 5 |
| AST | Media assets, synthetic sources, derived media, transcripts | 6 |
| SEQ | Sequences | 7 |
| TRK | Tracks | 8 |
| CLP | Clips (common behavior) | 9 |
| KND | Clip kinds | 10 |
| FX | Intrinsic properties and effects | 11 |
| KF | Keyframes and animation | 12 |
| TRN | Transitions and fades | 13 |
| SES | Editor session state | 14 |
| SEL | Selection | 15 |
| CMD | Commands and transactions | 16 |
| INV | Document invariants | 16.3 |
| UND | Undo, redo, history | 17 |
| PER | Persistence | 18 |
| MIG | Schema versions and migrations | 18.7 |
| LIFE | Asset lifecycle | 19 |
| CLB | Clipboard | 20 |
| AGT | Agent control | 21 |
| RND | Render snapshot contract | 22 |

"MUST", "SHOULD" and "MAY" follow RFC 2119. Type sketches below are **our own** TypeScript notation for the schema. The normative schema lives in `packages/project-model` as zod schemas that mirror these sketches.

### 0.2 Glossary

| Term | Meaning |
|---|---|
| Project | One editable unit the user opens and saves. It holds bins, media, sequences and the other entities below. |
| Document | The serializable, undoable data of a project (section 4). |
| Session | The in-memory editing context of one open project: document + history + selection + view + jobs (section 14). |
| Bin | A folder in the Project panel. |
| Project item | An entry in the bin tree: a bin, a media reference, a sequence, or a synthetic source. |
| Media asset | Metadata about one media file (video, audio, image, font, LUT). The bytes are never inside the document. |
| Synthetic source | A generated source defined only by parameters (color matte, adjustment layer, bars and tone, transparent video, black video). |
| Derived asset | A media asset whose file is produced by the native engine from another asset and a recipe (stabilized, denoised, reversed, conformed, and so on). |
| Derivative | A regenerable cache file tied to an asset (proxy, thumbnails, waveform peaks, keyframe index). Not part of the document. |
| Sequence | A timeline with its own frame rate, frame size, tracks, clips, markers. Several per project. |
| Track | A lane in a sequence: video (V1..Vn), audio (A1..An) or caption. |
| Clip | An occurrence of content on a track over a time range. Each clip has a kind (section 10). |
| Link group | Clips that move and trim together (typically one video clip + its audio clip(s) from the same file). |
| Content time | The time axis inside a clip's source (media time for files, virtual time for generators). |
| Engine | One of the three render engines: **Remotion** (React compositions and the preview Player), **native** (ffmpeg-based CPU processing in `apps/engine`), **fframes** (Rust SVG motion graphics). |
| Command | A serializable JSON object that describes one document change (section 16). |
| Transaction | An ordered list of commands applied atomically, recorded as one undo step. |

---

## 1. Architecture and package boundaries

- **ARC-001 (P0)** The document schema, the command handlers, the invariant checker, the migrations and the time math live in one **DOM-free, React-free** package, `packages/project-model`. It MUST run unchanged in the browser, in a Web Worker, in the Electron renderer and in Node (`apps/engine`). Nothing in it may import React, Remotion, the DOM, IndexedDB or Node built-ins.
- **ARC-002 (P0)** Anything that needs the DOM or platform APIs is injected through small interfaces (`TextMeasurer`, `Clock`, `IdSource`, `MediaProber`). Command handlers that need text measurement receive it as a dependency. In Node, measurement MAY be deferred ("layout pending") and resolved by the next browser session.
- **ARC-003 (P0)** `packages/editor-session` (browser side) holds the session store (section 14), subscriptions for React, the gesture layer and the agent bridge. It depends on `project-model`.
- **ARC-004 (P0)** Persistence is behind a `ProjectStore` interface with three adapters (section 18): browser (IndexedDB + OPFS), desktop (filesystem through the engine), remote (engine over HTTP).
- **ARC-005 (P0)** **Authority.** While a project is open in an editor session, that session is the single writer of the document. Other writers (agents, the engine, a second tab) send commands to it. When no session has the project open, the engine MAY apply commands headlessly with the same `project-model` package (section 21.5).
- **ARC-006 (P0)** The document never contains executable code, binary data, blob URLs, absolute URLs to a specific engine instance, or anything tied to one machine's runtime. It contains references (ids, fingerprints, locators) that each runtime resolves.

Beyond the template: the template's state was a React-owned object mutated by in-tree functions, with no command vocabulary and no headless path. Our model is a standalone package that the browser, the engine and agents share.

---

## 2. Time model

Premiere counts time in a very fine tick unit and snaps edits to the sequence frame grid. We do the same, with two units.

- **TIME-001 (P0)** **Sequence time** is an integer **frame index** at the sequence frame rate. Every timeline position and duration in a sequence (clip start and duration, marker positions, in/out points, work area, transition durations) is an integer number of sequence frames. Frame 0 is the first frame. A range `[start, start + duration)` is half-open.
- **TIME-002 (P0)** **Content time** (source in-points, keyframe times, transcript word times, media durations) is an integer number of **flicks**. 1 second = 705,600,000 flicks. Flicks divide evenly into every common frame rate (23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120) and every common audio rate (44.1 kHz, 48 kHz, 96 kHz), so they are exact where it matters. JSON numbers hold them exactly up to about 147 days.
- **TIME-003 (P0)** Frame rates are rationals `{num, den}` with positive integers: 30 fps is `{num: 30, den: 1}` and 29.97 is `{num: 30000, den: 1001}`. Floats MUST NOT be stored as frame rates. Allowed sequence rates in v1: 23.976, 24, 25, 29.97, 30, 50, 59.94, 60. Media assets may have any rate, including variable (VFR, see AST-007).
- **TIME-004 (P0)** Conversions (all in `project-model`, with exact integer or rational arithmetic, rounding only at the end):
  - flicks per frame at rate r: `F(r) = 705,600,000 × den / num`. This is an integer for all allowed sequence rates.
  - frame n → flicks: `n × F(r)`.
  - flicks t → frame: `floor(t / F(r))` when you need "the frame containing t"; `round(t / F(r))` when you snap an arbitrary time to the grid. Every function must state which one it uses.
  - seconds → flicks: `round(s × 705,600,000)`.
  - Remotion needs a number: `fps = num / den`.
- **TIME-005 (P0)** Timecode: `HH:MM:SS:FF` for non-drop rates and `HH;MM;SS;FF` (drop-frame) for 29.97 and 59.94 when the sequence says `dropFrame: true`. The sequence start timecode (SEQ-004) is added for display. Timecode strings are a display/input format only. The document stores frames.
- **TIME-006 (P0)** Time inputs from commands (section 16) accept four forms and normalize to frames of the target sequence: an integer (frames), `{frames: n}`, `{seconds: x}` (snapped with `round`), or a timecode string (drop-frame aware). Content-time inputs accept `{flicks: n}`, `{seconds: x}` or `{sourceFrames: n}` (source frames at the asset's nominal rate; a still image has none: commands on a sequence count its source frames at the sequence rate, Project-item commands (marks, markers, subclips) at 30 fps).
- **TIME-007 (P0)** The **sequence duration** is derived, never stored: the maximum clip end across all tracks, or 0 for an empty sequence.

Beyond the template: the template used one fixed frame rate for everything and stored source offsets as floating-point seconds. We support multiple rational sequence rates, including NTSC rates, and store content time as exact integers.

---

## 3. Identifiers

- **ID-001 (P0)** Every entity has a string id: a type prefix, an underscore, and 16 random characters from the Crockford base32 alphabet (80 bits, generated with a cryptographic RNG). Prefixes:

  | Prefix | Entity | Prefix | Entity |
  |---|---|---|---|
  | `prj_` | project | `clp_` | clip |
  | `bin_` | bin | `trn_` | transition |
  | `itm_` | project item | `fx_` | effect instance |
  | `med_` | media asset | `kf_` | keyframe |
  | `syn_` | synthetic source | `mrk_` | marker |
  | `seq_` | sequence | `lnk_` | link group |
  | `trk_` | track | `grp_` | clip group |
  | `trs_` | transcript | `fnt_` | font reference |

- **ID-002 (P0)** Ids are unique across the whole document, not just per entity type. The invariant checker enforces this (INV-001).
- **ID-003 (P0)** Ids are opaque. Nothing may parse meaning out of them except the prefix, which is only a debugging and validation aid.
- **ID-004 (P0)** Command submitters (agents especially) MAY supply their own ids if they are well-formed and unused. They MAY also use **temporary references** such as `"$title"` inside one transaction. The transaction result maps each temporary reference to its real id (CMD-006).
- **ID-005 (P0)** When content is pasted, duplicated or imported from another project, every entity gets a new id. References inside the copied set are remapped consistently.

Beyond the template: its ids were short and collision-prone, and callers could not supply them. Ours are collision-safe, typed and agent-addressable.

---

## 4. Document root and JSON rules

- **DOC-001 (P0)** The document is one JSON-serializable tree. Allowed values: objects, arrays, strings, finite numbers, booleans, `null`. There are no Dates (timestamps are ISO strings in the persistence envelope, not in the document), no `undefined`, no NaN or Infinity, no class instances, no Maps.
- **DOC-002 (P0)** Root shape:

```ts
type ProjectDocument = {
  schemaVersion: number;                  // integer, see MIG
  projectId: string;                      // prj_…
  name: string;
  settings: ProjectSettings;
  rootItems: string[];                    // ordered ids of top-level project items
  items: Record<string, ProjectItem>;     // bin tree entries (section 5)
  media: Record<string, MediaAsset>;      // file-backed assets (section 6)
  synthetics: Record<string, SyntheticSource>;
  transcripts: Record<string, Transcript>;
  fonts: Record<string, FontRef>;
  sequences: Record<string, Sequence>;    // each owns its tracks, clips, transitions, markers
  extensions: Record<string, unknown>;    // namespaced data from future versions or plugins, preserved verbatim
};

type ProjectSettings = {
  defaultSequencePreset: string;          // preset id, e.g. "hd-1080p-30"
  mediaPolicy: { copyOnImport: boolean }; // desktop: copy imported files into the project media folder
  proxyPolicy: ProxyPolicy;               // LIFE-020
  defaultStillDurationFrames: number;     // default 150 (5 s at 30 fps), rescaled per sequence rate
  defaultTransitionFrames: number;        // default 30 (video transitions)
  defaultAudioTransitionFrames?: number;  // M3 (S10:TUI-032): audio transitions; absent = defaultTransitionFrames
  defaultScaling: 'none' | 'fit-if-larger' | 'fit' | 'fill'; // on placement, FX-004
};
```

- **DOC-003 (P0)** **What is in the document and what is not.** The dividing rule: the document holds everything that describes *the edit*. It holds nothing that describes *how this machine is currently handling the edit*.

  | In the document (persisted, undoable) | Not in the document |
  |---|---|
  | Bins, project items, labels, source In/Out marks | Selection, focused panel, active tool |
  | Media asset metadata (probe results, locators, fingerprint) | Import/upload/copy progress, "offline" status, resolved URLs |
  | Derived asset recipes | Whether the derived file has been produced yet |
  | Proxy *policy* | Proxy files, thumbnails, waveform peaks, keyframe indexes |
  | Sequences, tracks, clips, effects, keyframes, transitions, markers | Playhead, zoom, scroll, track heights, track targeting, source patching |
  | Track lock, sync lock, output toggle, mute, solo, volume, pan | "Use proxies" toggle, preview resolution |
  | Transcripts (words and timings), caption styles | Transcription jobs, render jobs, fframes render jobs |
  | Motion-graphic template ids and params | Rendered motion-graphic proxies and masters |
  | Text content and declared text boxes | Measured glyph layout (cache) |

  Persisted-but-not-undoable view state is described in SES-004.

- **DOC-004 (P0)** No field in the document may exist only for a transient UI gesture (such as "being dragged"). Gesture state lives in the session (SES-006).
- **DOC-005 (P0)** Unknown fields: when a document written by a newer app version is opened, unknown fields inside known objects are preserved on save (the zod schemas use passthrough for this). Unknown clip kinds and unknown effects are preserved and rendered as placeholders (KND-030, FX-022).
- **DOC-006 (P1)** Size targets: a project with 20 sequences, 2,000 media assets, 10,000 clips and 50,000 keyframes MUST serialize to under 25 MB of JSON. Loading and validating it MUST take under 1.5 s on the reference machine (12-core x64, no GPU).

---

## 5. Project and bins (Premiere "Project panel")

- **PRJ-001 (P0)** A project item is one of:

```ts
type ProjectItem =
  | { id: string; kind: 'bin';       name: string; children: string[]; label: LabelColor }
  | { id: string; kind: 'media';     name: string; mediaId: string;    label: LabelColor; marks: SourceMarks; poster?: { flicks: number } }
  | { id: string; kind: 'sequence';  name: string; sequenceId: string; label: LabelColor }
  | { id: string; kind: 'synthetic'; name: string; syntheticId: string; label: LabelColor; marks: SourceMarks }
  | { id: string; kind: 'search-bin'; name: string; query: BinQuery; label: LabelColor }; // P2

type SourceMarks = { in: { flicks: number } | null; out: { flicks: number } | null };
type LabelColor = 'violet' | 'iris' | 'caribbean' | 'lavender' | 'cerulean' | 'forest' | 'rose' | 'mango'
  | 'purple' | 'blue' | 'teal' | 'magenta' | 'tan' | 'green' | 'brown' | 'yellow';
```

  Label color names follow the Premiere label set. The mapping to hex values lives in the UI theme, never in the document.

- **PRJ-002 (P0)** A project item's parent is either the root (it appears in `rootItems`) or exactly one bin (it appears in that bin's `children`). Order in these arrays is the user order for icon view.
- **PRJ-003 (P0)** Several project items MAY reference the same media asset (like Premiere duplicate master clips). Each item has its own name, label and source marks. A media asset MAY exist with no project item only transiently inside a transaction. The invariant checker requires every media asset and synthetic source to be referenced by at least one project item or clip (INV-014), so that assets never silently leak.
- **PRJ-004 (P0)** A sequence always has exactly one project item. Deleting that project item deletes the sequence (with confirmation if it is nested elsewhere, which also removes those nest clips).
- **PRJ-005 (P0)** **Source marks** (In/Out set in the Source Monitor) are document data and undoable, as in Premiere where marks belong to the master clip. Placing a source into a sequence uses its marks when present (CMD catalog `clip.place`).
- **PRJ-006 (P0)** Removing a media project item when clips in sequences still reference its asset through no other project item: the UI MUST warn ("N clips in M sequences use this media") and, on confirmation, remove those clips in the same transaction. Commands from agents must pass `force: true` for this, otherwise the command fails with `E_IN_USE`.
- **PRJ-007 (P1)** Bin operations: create, rename, move items (drag onto bin), delete bin (moves nothing: deleting a bin deletes its contents, with the same in-use warning as PRJ-006), sort (a view setting, not document order).
- **PRJ-008 (P1)** Derived columns shown in the Project panel (Video Usage, Audio Usage, Media Duration, Video Info, Audio Info, Frame Rate, Status) are computed from the document plus runtime status. They are never stored.
- **PRJ-009 (P2)** Search bins store a query (name contains, label, kind, usage count, offline) and show matching items live.

Beyond the template: the template had no bins and no project panel, and it dropped any asset not used on the timeline when saving. We keep imported media in bins whether or not it is used, like Premiere.

---

## 6. Media assets, synthetic sources, derived media, transcripts, fonts

### 6.1 Media assets

- **AST-001 (P0)** A media asset describes one media file:

```ts
type MediaAsset = {
  id: string;                         // med_…
  kind: 'video' | 'audio' | 'image' | 'animated-image' | 'font' | 'lut';
  fingerprint: string;                // AST-003
  originalName: string;               // file name at import time
  sizeBytes: number;
  container: string;                  // e.g. "mov,mp4", "matroska,webm", "png", "gif"
  probe: MediaProbe;
  locators: MediaLocator[];           // ordered; AST-004
  derivation: Derivation | null;      // non-null for derived assets (6.3)
  importedAt: string;                 // ISO time; informational
};

type MediaProbe = {
  durationFlicks: number | null;      // null for stills, fonts, LUTs
  startTimecode: string | null;       // embedded source timecode, if any
  streams: MediaStream[];
  rotationDegrees: 0 | 90 | 180 | 270;// display matrix rotation; applied to the intrinsic box
  hasAlpha: boolean;
  variableFrameRate: boolean;
};

type MediaStream =
  | { index: number; type: 'video'; codec: string; width: number; height: number;
      pixelAspect: { num: number; den: number }; frameRate: { num: number; den: number };
      pixelFormat: string; bitDepth: number;
      color: { primaries: string; transfer: string; matrix: string; range: 'tv' | 'pc' };
      browserDecodable: boolean | null; }   // filled by the prober of the importing runtime; null if unknown
  | { index: number; type: 'audio'; codec: string; sampleRate: number; channels: number;
      channelLayout: string; }
  | { index: number; type: 'subtitle'; codec: string; language: string | null };
```

- **AST-002 (P0)** The probe stores the **true source dimensions and rate**. It never stores "fitted to the canvas" sizes. How a clip is scaled is clip data (FX-004).
- **AST-003 (P0)** **Fingerprint.** `fingerprint = "q1:" + hex(sha256(sizeBytes as 8-byte big-endian || first 4 MiB || last 4 MiB))`. For files of 8 MiB or less, hash the whole file. The `q1:` prefix versions the scheme. The fingerprint identifies content across machines, across projects and after renames. It is how relinking, clipboard transfer between projects, deduplication and the derivative cache find the same media. The modification time is **not** part of the fingerprint (it differs between machines). The derivative cache MAY add mtime to its own keys for invalidation.
- **AST-004 (P0)** **Locators** tell each runtime where the bytes might be. They are tried in order (LIFE-030):

```ts
type MediaLocator =
  | { type: 'path'; path: string; relativeToProject: string | null } // desktop / engine filesystem
  | { type: 'browser-store'; key: string }                          // web: OPFS or IndexedDB, key = fingerprint
  | { type: 'engine-store'; engineId: string; key: string }         // remote engine storage (VPS/PWA)
  | { type: 'url'; url: string }                                     // http(s) source; engine downloads it
  | { type: 'cloud'; provider: string; key: string };                // P2: optional S3-compatible provider
```

  Relative paths (relative to the project file's folder) are recorded next to absolute ones so that moving a project folder with its media keeps working.

- **AST-005 (P0)** Font assets (`kind: 'font'`) hold a user-supplied font file. LUT assets (`kind: 'lut'`) hold `.cube` files used by color effects. Neither can be placed on a timeline.
- **AST-006 (P0)** Kinds a clip can use: `video` → video clip and/or audio clip (one per audio stream group, KND-003); `audio` → audio clip; `image` → still clip; `animated-image` → animated-image clip (GIF, APNG, animated WebP).
- **AST-007 (P1)** VFR sources are flagged. The import pipeline offers (and agents may request) a **conformed derived asset** (constant frame rate) produced by the native engine (6.3). Until conformed, VFR clips play, but frame-accurate trims are not guaranteed and the clip shows a warning badge.

### 6.2 Synthetic sources

- **AST-010 (P0)** A synthetic source is a parameterized generator that behaves like a bin item (Premiere "New Item"):

```ts
type SyntheticSource =
  | { id: string; kind: 'color-matte'; color: RGBA; }
  | { id: string; kind: 'adjustment'; }                            // P1, see KND-012
  | { id: string; kind: 'transparent'; }
  | { id: string; kind: 'black-video'; }
  | { id: string; kind: 'bars-and-tone'; toneHz: number; toneDb: number; }  // P1
  | { id: string; kind: 'counting-leader'; style: object; };        // P2
```

  Synthetic sources have no fixed duration and have the frame size of the sequence they are placed in. Editing a synthetic source (for example changing the matte color) changes **every clip** that references it, as in Premiere. To get a differently colored matte, the user creates another synthetic source (the UI's "New color matte" and the agent command `clip.addSolid` do this in one step).

### 6.3 Derived (native-processed) media

This is the model for "native-processed media". A processed file is a new asset with a recipe, and clips reference it like any other media. We do **not** add a separate clip kind for processed media: every video and audio feature (trim, speed, effects, waveform, filmstrip) keeps working unchanged.

- **AST-020 (P1)** A derived asset has `derivation` set:

```ts
type Derivation = {
  fromMediaId: string;          // the source asset (may itself be derived)
  recipe: NativeRecipe;         // what the native engine does
  recipeVersion: number;        // bump when the engine's implementation of an op changes output
  recipeHash: string;           // sha256 of canonical JSON of {fromFingerprint, recipe, recipeVersion}
};

type NativeRecipe =
  | { op: 'conform-cfr'; frameRate: { num: number; den: number } }
  | { op: 'reverse' }
  | { op: 'stabilize'; smoothing: number; crop: 'keep' | 'black' }
  | { op: 'denoise-audio'; strength: number }
  | { op: 'loudness-normalize'; targetLufs: number; truePeakDb: number }
  | { op: 'extract-audio'; streamIndex: number; format: 'wav' | 'flac' }
  | { op: 'transcode'; preset: string }                     // mastering-quality intermediate, e.g. "prores-422"
  | { op: 'time-stretch'; rate: number; preservePitch: boolean }
  | { op: 'range'; inFlicks: number; outFlicks: number };  // lossless subclip (stream copy with keyframe snapping)
```

- **AST-021 (P1)** Creating a derived asset is a document change (undoable) that happens **immediately**, before the file exists. Producing the file is a background job (runtime state, LIFE-040). Clips that reference a derived asset whose file is not yet produced show a "Processing…" placeholder with progress, then switch to the real file without any further document change.
- **AST-022 (P1)** Derived files are reproducible. If a derived file is missing (new machine, cache cleared), the engine regenerates it from the recipe when the source is available. The fingerprint of a derived asset is computed when its file is first produced and recorded with a system-origin transaction that is not an undo step (UND-012). Until then, `fingerprint` is `"pending:" + recipeHash`.
- **AST-023 (P1)** The browser-only runtime (no engine reachable) cannot produce derived files. It shows them as "Needs engine" and still lets the user edit around them.

### 6.4 Transcripts

- **AST-030 (P0)** A transcript holds timed words for one media asset. It is document data because users and agents edit it (caption text corrections are transcript edits):

```ts
type Transcript = {
  id: string;                        // trs_…
  mediaId: string | null;            // the audio source it was made from; null for imported subtitle files
  language: string;                  // BCP 47, e.g. "en"
  origin: 'whisper-local' | 'cloud-asr' | 'subtitle-file' | 'manual';
  words: TranscriptWord[];           // sorted by start, non-overlapping
  speakers: Record<string, { name: string }>;
};
type TranscriptWord = {
  text: string;                      // includes attached punctuation; leading space rules in AST-032
  start: number; end: number;        // flicks, in the media's content time
  confidence: number | null;         // 0..1
  speaker: string | null;            // key into speakers
  breakBefore: 'none' | 'line' | 'segment'; // manual caption line/segment breaks
};
```

- **AST-031 (P0)** Imported SRT/VTT subtitle files become transcripts with `origin: 'subtitle-file'`. Each cue becomes one "word" whose text is the full cue text and whose `breakBefore` is `'segment'`.
- **AST-032 (P0)** Words are concatenated with a single space unless the next word starts with punctuation that attaches to the previous word. Tokenizers that emit leading spaces must be normalized at import.
- **AST-033 (P1)** Transcripts are stored in a separate persistence record (PER-012) because they can be large, but they are part of the document and of undo history.

### 6.5 Fonts

- **AST-040 (P0)** Text-bearing clips reference fonts by `FontRef` id:

```ts
type FontRef = {
  id: string; family: string;
  source: { type: 'bundled' } | { type: 'google'; family: string } | { type: 'system' } | { type: 'asset'; mediaId: string };
};
```

  Renderers resolve each font for their platform (bundled woff2 files for offline use, Google Fonts through the engine cache, user font assets). A missing font renders with the fallback family and a "missing font" warning. The document still keeps the original reference.

Beyond the template: no bins, no source dimensions, no fingerprints or relinking, no transcripts as editable data, no user fonts, no LUTs, no synthetic sources, no derived media.

---

## 7. Sequences

- **SEQ-001 (P0)** Shape:

```ts
type Sequence = {
  id: string;                               // seq_…
  settings: SequenceSettings;
  videoTracks: Track[];                     // index 0 = V1 = bottom layer; last = top layer
  audioTracks: Track[];                     // index 0 = A1
  captionTracks: Track[];                   // rendered above all video tracks; index 0 is the lowest
  master: { volumeDb: Animatable<number>; effects: EffectInstance[] };
  clips: Record<string, Clip>;              // every clip in this sequence (section 9)
  transitions: Record<string, Transition>;
  links: Record<string, LinkGroup>;         // lnk_… → members
  groups: Record<string, ClipGroup>;        // grp_… → members
  markers: Marker[];                        // sequence markers, sorted by frame
  inPoint: number | null;                   // frames
  outPoint: number | null;                  // frames, exclusive
  workArea: { start: number; end: number } | null;
};

type SequenceSettings = {
  frameRate: { num: number; den: number };
  width: number; height: number;            // even integers, 16..8192
  pixelAspect: { num: 1; den: 1 };          // square pixels only in v1
  dropFrame: boolean;                        // only meaningful for 29.97 / 59.94
  startTimecodeFrames: number;               // display offset, default 0
  audioSampleRate: 48000;                    // v1 fixed
  masterLayout: 'stereo';                    // v1; '5.1' is P2
  backgroundColor: RGBA;                     // shown where no clip covers; default opaque black
  workingColorSpace: 'rec709';               // P2: 'rec2020-pq', 'rec2020-hlg'
};
```

- **SEQ-002 (P0)** A project can hold any number of sequences. Each is opened in its own Timeline tab (tab list, active tab and per-sequence view state are session state).
- **SEQ-003 (P0)** New sequences come from presets (id, name, settings, default track counts). Built-ins at minimum: 1080p at 23.976, 24, 25, 29.97, 30, 50, 59.94 and 60; 2160p at 24, 25, 30 and 60; vertical 1080×1920 at 30 and 60; square 1080×1080 at 30; 720p at 30. Default track layout: V1–V3, A1–A3 (stereo), no caption track.
- **SEQ-004 (P0)** **Sequence from clip.** Creating a sequence from a media asset copies the asset's frame size, frame rate (rounded to the nearest allowed rate) and places it (Premiere "New Sequence From Clip").
- **SEQ-005 (P0)** **Mismatch prompt.** When the first clip is placed into an empty sequence whose settings differ from the clip, the UI asks "Change sequence settings to match / Keep existing settings", as Premiere does. Agent commands decide with a `matchSequence: 'ask-user' | 'match' | 'keep'` option (default `'keep'` for agents).
- **SEQ-006 (P0)** **Changing the frame rate** of a sequence that has content. Let `r1` be the old and `r2` the new rate and `map(f) = round(f × r2 / r1)` (computed with rationals):
  1. Every clip boundary is mapped: `start' = map(start)`, `end' = map(start + duration)`, `duration' = end' - start'`. Adjacent clips share a boundary value, so they stay adjacent. The mapping is monotonic, so no overlaps are created.
  2. A clip whose `duration'` would be 0 is removed. The command result lists it in `warnings` (`W_CLIP_COLLAPSED`).
  3. Markers, in/out, work area and transition durations are mapped with the same function. Transition durations are clamped to at least 1 frame.
  4. Content-time data (source in-points, keyframes, transcripts) does **not** change, because it is in flicks. Keyframes stay attached to the same picture.
  5. The whole change is one transaction.
- **SEQ-007 (P0)** **Changing the frame size.** The command takes `reposition: 'keep-offset-from-center' | 'scale-proportionally' | 'keep-pixels'`. Default `keep-offset-from-center`: each visual clip's position (and position keyframes) keeps its offset from the frame center. `scale-proportionally` scales positions and scale values by `min(w2/w1, h2/h1)`. `keep-pixels` changes nothing. Generator clips whose intrinsic box is the frame size (solids, adjustment layers, motion graphics set to "sequence canvas") follow the new frame size automatically.
- **SEQ-008 (P0)** **Markers:**

```ts
type Marker = {
  id: string; frame: number; duration: number;         // duration 0 = point marker
  name: string; comment: string; color: LabelColor;
  type: 'comment' | 'chapter' | 'segmentation' | 'web-link' | 'agent-note';
  url?: string;                                        // for web-link
  author: 'user' | { agent: string };                  // who created it
};
```

  `agent-note` is ours: agents leave review notes and suggestions ("possible jump cut here") that the user can accept, jump to, or dismiss. Clip markers use the same shape but live on the clip, in content time (`frame` is replaced by `flicks`), so they move with the media.

- **SEQ-009 (P0)** In/Out and work area are document data (Premiere persists them with the sequence). Changing them is undoable. Consecutive changes from dragging are coalesced into one step (UND-006).
- **SEQ-010 (P1)** **Nesting.** A sequence may be placed in another sequence as nest clips (KND-011). The nesting graph MUST be acyclic (INV-009). "Nest" on selected clips creates a new sequence with the parent's settings, moves the selected clips into it at the same relative times and on the same track indices, and replaces them in the parent with a nest clip (plus a linked audio nest clip if any audio moved).
- **SEQ-011 (P1)** Duplicating a sequence deep-copies it with new ids for every contained entity. Media and synthetic references are shared.

Beyond the template: one fixed composition per editor, a fixed frame rate, no markers, no In/Out, no work area, no nesting, no preset or mismatch handling.

---

## 8. Tracks

- **TRK-001 (P0)** Shape:

```ts
type Track = {
  id: string;                               // trk_…
  kind: 'video' | 'audio' | 'caption';
  name: string | null;                      // null = default display name ("Video 1"); header shows V1/A1/C1 by index
  locked: boolean;                          // no edits may change clips on this track (TRK-004)
  syncLock: boolean;                        // default true; section TRK-006
  // video tracks
  output?: boolean;                         // "eye": false = excluded from preview and export
  // audio tracks
  mute?: boolean;
  solo?: boolean;
  volumeDb?: Animatable<number>;            // track fader, default 0
  pan?: Animatable<number>;                 // -100 (L) .. +100 (R), default 0
  channelFormat?: 'mono' | 'stereo';        // default 'stereo'
  effects?: EffectInstance[];               // audio track effects (P1), video track effects (P2)
  // caption tracks
  captionFormat?: 'open';                   // burned into the picture; 'subtitle' sidecar export is P1
  visible?: boolean;
  styleDefaults?: CaptionStyle;             // track style inherited by caption clips (KND-008)
};
```

- **TRK-002 (P0)** **Tracks exist independently of clips.** Empty tracks stay until the user deletes them. The display label is derived from the index: `V{index+1}`, `A{index+1}`, `C{index+1}`. Agents and commands may address tracks by id **or** by this label (for example `"V2"`), resolved at submission time.
- **TRK-003 (P0)** **Kind compatibility:** video tracks accept visual clip kinds (video, still, animated-image, text, solid, motion-graphic, composition, nest-video, adjustment). Audio tracks accept audio and nest-audio clips. Caption tracks accept captions clips. A command that puts a clip on an incompatible track fails with `E_TRACK_KIND`.
- **TRK-004 (P0)** **Lock.** No command may create, remove, move, trim or modify a clip on a locked track, and no ripple may shift clips on it. The command fails with `E_TRACK_LOCKED`, unless it is a sync-lock ripple where the locked track would need to shift: then the whole edit fails with `E_SYNC_LOCKED_TRACK` and names the track (Premiere refuses such edits too). Locked tracks cannot be targeted.
- **TRK-005 (P0)** **Add/delete tracks.** Adding inserts new tracks at a given index for a kind, with a count. Deleting a track deletes its clips (with confirmation in the UI if it has clips, and `force: true` for agents). There must always be at least one video track and one audio track. Dropping or placing a clip above the top video track (or below the last audio track) automatically adds a track, as in Premiere.
- **TRK-006 (P1)** **Sync lock** (default on for every track). When an insert, ripple delete, ripple trim or extract shifts content on the edited tracks by `Δ` frames starting at frame `t`, every other track with sync lock on is shifted the same way at `t`. On those tracks, a clip that spans `t` is split at `t` for an insert (a gap of `Δ` opens) or has the range `[t, t+|Δ|)` removed for a removal. If that range contains clip content on a sync-locked track, the edit fails with `E_SYNC_CONFLICT` unless the command passes `syncConflict: 'cut'`. Tracks with sync lock off are left alone.
- **TRK-007 (P0)** **Solo:** if any audio track is soloed, only soloed tracks are audible. Mute always wins over solo.
- **TRK-008 (P1)** The master track (on the sequence, not in `audioTracks`) has volume and effects only. It cannot be targeted, locked or deleted.
- **TRK-009 (P0)** Not stored on tracks (session view state, SES-004): height, collapsed/expanded, targeting, source patching, keyframe display mode.

Beyond the template: the template had untyped tracks that vanished when empty and allowed any item type on any track, and it had no lock, sync lock, solo, track volume or pan.

---

## 9. Clips: common behavior

### 9.1 Common fields

- **CLP-001 (P0)** Every clip, whatever its kind, has:

```ts
type ClipCommon = {
  id: string;                         // clp_…
  kind: ClipKind;                     // section 10
  trackId: string;                    // single source of truth for track membership
  start: number;                      // sequence frames, >= 0
  duration: number;                   // sequence frames, >= 1
  sourceIn: number;                   // flicks of content time shown at the clip's first frame
  speed: { rate: number; reverse: boolean; maintainPitch: boolean }; // rate in [0.01, 100]
  name: string;                       // defaults to the project item name
  label: LabelColor;
  enabled: boolean;                   // Premiere "Enable" (Shift+E); disabled clips are not rendered or heard
  linkId: string | null;              // link group
  groupId: string | null;             // clip group
  markers: ClipMarker[];              // content time (SEQ-008)
};
```

- **CLP-002 (P0)** **Track membership is stored only on the clip** (`trackId`). Tracks do not keep clip lists. The session builds a per-track index sorted by `start` (SES-010). This avoids two sources of truth.
- **CLP-003 (P0)** **No overlaps.** On one track, clip ranges `[start, start + duration)` never intersect (INV-003). Placing or moving a clip onto occupied frames uses **overwrite** semantics unless the command asks for **insert**:
  - *Overwrite:* clips under the incoming range are trimmed, split or removed so that the incoming clip replaces exactly the covered frames.
  - *Insert:* everything on the target track at or after the insertion frame shifts right by the incoming duration. A clip that spans the insertion frame is split there first. Sync-locked tracks shift too (TRK-006).
  The editor never falls back to "find a free spot on another track" automatically. That is a UI convenience for drag-and-drop onto empty areas only (the timeline spec decides).
- **CLP-004 (P0)** **Content-time mapping.** A clip shows content time `sourceIn` at frame `start`. For a timeline frame `f` inside the clip, with `i = f - start` and `F` = flicks per sequence frame:
  - forward: `content(f) = sourceIn + i × F × rate`
  - reverse: `content(f) = sourceIn + (duration - 1 - i) × F × rate`
  - `contentSpan = duration × F × rate` (the amount of source consumed).
  Picture: the displayed source frame is the source frame that contains `content(f)` (nearest-earlier sampling, P2 adds frame blending). Audio: sample-accurate, resampled for rate ≠ 1, pitch-corrected when `maintainPitch` is true.
- **CLP-005 (P0)** **Media bounds.** For time-bounded content (video, audio, animated images that do not loop, nests): `0 ≤ sourceIn` and `sourceIn + contentSpan ≤ mediaDuration` (INV-005). Trims and speed changes are clamped to these bounds. Stills, text, solids, synthetic sources, motion graphics and compositions have unbounded content time: their `sourceIn` starts at 0 and trims move it freely, but never below 0.
- **CLP-006 (P0)** **Generators have content time too.** Trimming the head of a text clip by 10 frames increases its `sourceIn` by 10 frames' worth of flicks. Its keyframes and its animation therefore stay where they were on the timeline, as with media. This one rule gives every kind the same trim, slip and split behavior.
- **CLP-007 (P0)** **Split** ("Add Edit") at frame `s` with `start < s < start + duration`: the left part keeps the id and gets `duration = s - start`. The right part is a new clip with `start = s`, `duration = old end - s` and `sourceIn = content(s)` for forward clips (for reverse clips the left part's `sourceIn` changes instead). Both parts keep the full effect stack and **all** keyframes (keyframes outside a part's visible range stay stored and still shape interpolation). Link groups: if the clip is linked, every linked partner that spans `s` is split too, and the right parts form a new link group. Clip markers are copied to both parts.
- **CLP-008 (P0)** **Speed changes** (Premiere Speed/Duration): the command takes a new rate and/or a new duration, and `ripple: boolean`. The two are tied by `duration = contentSpan / (F × rate)`, rounded to whole frames. If the new duration would overlap the next clip and `ripple` is false, the rate is kept but the duration is clamped to the gap, and a warning says so. Reverse flips the mapping in CLP-004 without changing `sourceIn` or `duration`.
- **CLP-009 (P2)** Time remapping (variable speed with keyframes) is reserved: it will be an animatable `speed.remap` property. v1 has constant speed only.

### 9.2 Link groups and clip groups

- **CLP-010 (P0)** A **link group** ties clips that come from the same source placement: one video clip and its audio clip(s). Placing a video asset that has audio creates a video clip and one audio clip per used audio stream (CLP-014), all in one new link group. Rules:
  - With **Linked Selection** on (a session toggle, default on), selecting one member selects all members (SEL-004), so moves and trims apply to all of them.
  - Trimming a linked edge trims the partners' same edge by the same amount, when their edges coincide.
  - Unlinking (Ctrl+L) removes the link group. Linking selected clips creates one (a clip may only be in one link group).
  - A link group has at most one video-kind member.
- **CLP-011 (P1)** **Out of sync.** Two linked clips from the same asset are in sync when `start - content(start)/(F × rate)` is equal (their content origins align on the timeline). When they are not, each shows a red badge with the offset in frames (for example `-12`). The UI offers "Move into sync" and "Slip into sync". Out-of-sync state is computed, never stored.
- **CLP-012 (P1)** A **clip group** (Ctrl+G) is a looser set: members are selected, moved and deleted together, but trims are independent. A clip can be in one link group and one clip group at the same time.
- **CLP-013 (P0)** Deleting a linked clip deletes only that clip unless linked selection expanded the selection. Deleting the last-but-one member of a link group dissolves the group.
- **CLP-014 (P1)** Multi-stream audio: an audio clip picks its source channels with `channels: { streamIndex: number; map: number[] }`. The default for stereo sources is one stereo clip. For sources with more than two channels, the import dialog (and the `clip.place` option `audioMapping`) chooses "one stereo clip", "one mono clip per channel", or "one clip per stream".

---

## 10. Clip kinds

```ts
type ClipKind =
  | 'video' | 'audio' | 'still' | 'animated-image'      // media-backed
  | 'text' | 'solid' | 'captions'                        // built-in generators
  | 'motion-graphic'                                     // fframes (new)
  | 'composition'                                        // registered Remotion composition (new)
  | 'nest-video' | 'nest-audio'                          // nested sequence (P1)
  | 'adjustment';                                        // adjustment layer (P1)
```

### 10.1 Kind table

| Kind | Track | Source reference | Content time | Visual props (FX-001) | Audio props (FX-010) | Engines (preview / export) | Priority |
|---|---|---|---|---|---|---|---|
| `video` | video | `mediaId` (kind video) | bounded | yes | no (audio is a linked `audio` clip) | Remotion Player / native ffmpeg | P0 |
| `audio` | audio | `mediaId` (video or audio) + channels | bounded | no | yes | Remotion Player / native ffmpeg | P0 |
| `still` | video | `mediaId` (image) | unbounded | yes | no | Remotion / native | P0 |
| `animated-image` | video | `mediaId` (animated-image) + `loop` | bounded if `loop: false` | yes | no | Remotion / native | P0 |
| `text` | video | none (inline content) | unbounded | yes | no | Remotion / Remotion alpha intermediate | P0 |
| `solid` | video | `syntheticId` (color-matte, black-video, transparent) | unbounded | yes | no | Remotion / native color source | P0 |
| `captions` | caption | `transcriptId` | bounded by transcript's media duration | yes (placement) | no | Remotion / Remotion alpha intermediate; SRT/VTT sidecar | P0 |
| `motion-graphic` | video | template ref + params | unbounded | yes | no | fframes WASM SVG in Player or alpha proxy / fframes master (ProRes 4444 or PNG) | P0 (templates), P2 (custom code) |
| `composition` | video | registered composition ref + props | unbounded | yes | no (P2: comp audio) | Remotion / Remotion alpha intermediate | P1 |
| `nest-video` / `nest-audio` | video / audio | `sequenceId` | bounded by nested sequence duration | yes / no | no / yes | recursive | P1 |
| `adjustment` | video | `syntheticId` (adjustment) | unbounded | opacity + blend only | no | per effect capability | P1 |

### 10.2 Kind-specific fields

- **KND-001 (P0) `video`**: `{ mediaId: string; videoStreamIndex: number; transform; opacity; blendMode; effects; }`. The clip never produces sound. Its audio is always a separate, linked `audio` clip (Premiere model). This keeps audio mixing, waveforms, audio transitions and audio keyframes on audio tracks only.
- **KND-002 (P0) `audio`**: `{ mediaId: string; channels: {streamIndex, map}; gainDb: number; volumeDb: Animatable<number>; pan: Animatable<number>; effects; }`. `gainDb` is Premiere's static clip gain (applied first). `volumeDb` is the keyframable "Volume > Level" (rubber band). -96 dB means silence, and it is the minimum value.
- **KND-003 (P0) Placement of video assets** creates `video` + `audio` clips in a link group (CLP-010), unless the placement targets only the video or only the audio side (source patching, SES-004, or the command options `video: false` / `audio: false`).
- **KND-004 (P0) `still`**: `{ mediaId; transform; opacity; blendMode; effects; }`. Default duration is `settings.defaultStillDurationFrames`, rescaled from 30 fps to the sequence rate.
- **KND-005 (P0) `animated-image`**: like `still` plus `loop: boolean` (default true). When looping, content time wraps modulo the animation duration and the clip is unbounded.
- **KND-006 (P0) `text`**:

```ts
type TextClipFields = {
  content: TextContent;          // v1: one paragraph block with uniform style; P1: styled runs
  box: { width: number; height: number; autoSize: 'none' | 'width' | 'height' }; // layer pixels
  transform; opacity; blendMode; effects;
};
type TextContent = {
  text: string;                  // newlines allowed
  style: TextStyle;
  runs?: { from: number; to: number; style: Partial<TextStyle> }[]; // P1, UTF-16 offsets
};
type TextStyle = {
  fontId: string; weight: number; italic: boolean;
  sizePx: number; lineHeight: number; trackingEm: number;    // tracking in 1/1000 em units
  align: 'left' | 'center' | 'right' | 'justify';
  direction: 'ltr' | 'rtl' | 'auto';
  fill: RGBA;
  strokes: { color: RGBA; widthPx: number; position: 'outside' | 'center' | 'inside' }[]; // Premiere allows several
  background: { color: RGBA; paddingPx: number; radiusPx: number } | null;
  shadow: { color: RGBA; angleDeg: number; distancePx: number; blurPx: number } | null;
  allCaps: boolean;
};
```

  `autoSize: 'width'` grows the box to fit one line; `'height'` wraps at `box.width` and grows the height. The browser measures text and writes the resulting box as part of the same commit that changed the text (`TextMeasurer`, ARC-002). Headless edits in the engine set a flag `layoutPending: true` that the next browser session resolves with a system transaction (UND-012).
- **KND-007 (P0) `solid`**: `{ syntheticId; transform; opacity; blendMode; effects; }`. The intrinsic box is the sequence frame size. The color comes from the synthetic source (AST-010).
- **KND-008 (P0) `captions`**:

```ts
type CaptionsClipFields = {
  transcriptId: string;
  style: Partial<CaptionStyle>;       // overrides of the track's styleDefaults
  transform; opacity;                 // placement of the caption block (default: bottom-center safe area)
};
type CaptionStyle = TextStyle & {
  highlight: { mode: 'none' | 'word' | 'karaoke'; color: RGBA };
  maxLines: number;                   // default 2
  maxCharsPerLine: number;            // default 42
  maxSegmentMs: number;               // default 5000
  minGapMs: number;                   // default 80; gaps shorter than this are closed
  boxWidthPct: number;                // of frame width, default 80
};
```

  The clip's content time is the transcript's media time, so a captions clip aligns with its audio exactly as a linked audio clip would (placing captions for a clip computes `start` and `sourceIn` from that audio clip). **Segmentation** (which words form each on-screen caption) is computed deterministically from the words in range and the style: start a new segment on `breakBefore: 'segment'`, on a gap longer than 700 ms, when `maxSegmentMs` would be exceeded, or when the text no longer fits `maxLines × maxCharsPerLine`. Lines break at `breakBefore: 'line'` or at the last space that fits. The same function runs in preview, export and SRT/VTT sidecar export, so all three agree.
- **KND-009 (P0) `motion-graphic`** (fframes):

```ts
type MotionGraphicFields = {
  template: { id: string; version: number };  // e.g. {id: "lower-third", version: 1}
  params: Record<string, unknown>;            // validated against the template's JSON Schema (FX-020)
  canvas: 'sequence' | { width: number; height: number }; // render size; 'sequence' follows SEQ-007
  transform; opacity; blendMode; effects;
};
```

  - The template library ships with the app. Each template publishes a JSON Schema for its params and a default param set. The inspector is generated from that schema. Agents fill the params as JSON.
  - The template's animation runs in content time. With `sourceIn = 0` and duration `d`, the template is asked to render `d` frames at the sequence rate. Templates declare `intro` and `outro` lengths. When the clip's duration changes, the middle part stretches and the intro and outro keep their length (Premiere "Responsive Design – Time").
  - Rendered artifacts (preview proxy, export master) are **derivatives** keyed by `sha256(template id, version, canonical params, canvas size, frame rate, duration, sourceIn)`. They are never stored in the document (LIFE-045).
  - **P2 custom graphics:** an agent-authored fframes program is stored as a document entity `extensions["jasper.customGraphics"][id] = {language: 'fframes-rust', source, sourceHash}`, referenced as `template: {id: 'custom:<hash>', version: 0}`. It is compiled only by the engine, in a sandbox, and never in the browser. See `docs/research/fframes.md` §7 design A.
- **KND-010 (P1) `composition`** (Remotion): `{ composition: { id: string; version: number }; props: Record<string, unknown>; canvas; transform; opacity; blendMode; effects; }`. Only compositions **registered in the app bundle** can be referenced (the registry validates props with its own schema). The document never carries component code. This also keeps us inside the Remotion license terms that forbid end users supplying their own Remotion code.
- **KND-011 (P1) `nest-video` / `nest-audio`**: `{ sequenceId; transform (video only); opacity; blendMode; effects; }` and, for audio, `{ gainDb; volumeDb; pan; effects }`. Content time = the nested sequence's time (`content(f)` converted to frames of the nested sequence's rate). The nested sequence's In/Out are ignored; its full duration is the bound.
- **KND-012 (P1) `adjustment`**: `{ syntheticId; opacity; blendMode; effects; }`. During its range, its effect stack applies to the composite of all video tracks below it, and the result is mixed back with its opacity. It has no transform.
- **KND-020 (P0) Every visual kind declares an intrinsic box** (the layer's own pixel size before Motion): media = probed width×height with rotation metadata applied (and pixel aspect, P2); still/animated image = image size; text = `box`; solid/adjustment = sequence frame; motion-graphic/composition = `canvas`; nest = the nested sequence's frame; captions = `boxWidthPct` × frame width by the computed text height.
- **KND-030 (P0)** **Unknown kinds** (from newer versions) are preserved, drawn on the timeline as grey "Unsupported clip" blocks, excluded from rendering with a warning, and kept on save. They occupy their range (no overlap), and they can be moved or deleted but not edited.

Beyond the template: the template had no linked A/V (one item carried both picture and sound), no nesting, no adjustment layers, no motion-graphic or registered-composition clips, no multiple strokes, shadows or styled runs in text, captions stored as an opaque blob instead of editable word timings, and no track kinds.

---

## 11. Intrinsic properties and effects

### 11.1 Visual intrinsic properties (Premiere "Motion" and "Opacity")

- **FX-001 (P0)** Every visual clip (except `adjustment`) has:

```ts
type Transform = {
  position: Animatable<Vec2>;     // sequence pixels, origin top-left of the frame; where the anchor lands
  anchor: Animatable<Vec2>;       // layer pixels, origin top-left of the intrinsic box; default = box center
  scale: Animatable<number>;      // percent, default 100
  scaleWidth: Animatable<number>; // percent; used only when uniformScale is false
  uniformScale: boolean;          // default true
  rotation: Animatable<number>;   // degrees, clockwise, may exceed ±360 (multiple turns)
  flipH: boolean; flipV: boolean; // P1
};
opacity: Animatable<number>;      // percent 0..100, default 100
blendMode: 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'add' | 'difference'; // P1 beyond normal
```

  Mapping from layer pixel `p` to frame pixel: `position + R(rotation) · S(scaleX, scaleY) · (p - anchor)`, with `scaleX = uniformScale ? scale : scaleWidth` and `scaleY = scale` (as in Premiere, "Scale" is the vertical factor and "Scale Width" the horizontal one when uniform scale is off). Percentages are divided by 100. Flips are applied as negative scale factors around the anchor.

- **FX-002 (P0)** **Render order per visual clip** (Premiere order): source frame → standard effects in stack order (crop is a standard effect) → Motion (transform) → Opacity and blend → composite onto the tracks below. Adjustment clips apply at their track position in the stack (KND-012).
- **FX-003 (P0)** **Crop** is the standard effect `jasper.crop` with animatable `left`, `top`, `right`, `bottom` in percent of the intrinsic box (0..100) and `feather` in pixels. `left + right < 100` and `top + bottom < 100` (at least one pixel remains). The Properties panel shows it as a first-class section even though it is stored in `effects`. The crop tool on the Program monitor edits it.
- **FX-004 (P0)** **Default scaling on placement** (project setting `defaultScaling`, overridable per command): `none` = scale 100; `fit-if-larger` (default) = scale down to fit the frame when the intrinsic box is larger, never up; `fit` = scale so that the box fits the frame; `fill` = scale so that the box covers the frame. The result is written into `scale`. It is not a live mode: later frame-size changes follow SEQ-007. Premiere's "Set to Frame Size" and "Scale to Frame Size" are commands (`clip.fitToFrame {mode}`).

### 11.2 Audio properties (Premiere "Volume", "Channel Volume", "Panner")

- **FX-010 (P0)** Audio signal chain, in order, per audio clip: source channels (CLP-014) → resample for speed (pitch-preserving if `maintainPitch`) → `gainDb` → clip effects in stack order → `volumeDb` (keyframable) → `pan` (keyframable, constant-power law, -3 dB at center) → track effects → track `volumeDb` and `pan` → mute/solo (TRK-007) → master effects → master `volumeDb`.
- **FX-011 (P0)** Audio clip fades are audio transitions (TRN-004). Volume keyframes are the other way to shape level.

### 11.3 Effect instances and the registry

- **FX-020 (P0)** An effect instance:

```ts
type EffectInstance = {
  id: string;                               // fx_…
  effectId: string;                         // registry key, e.g. "jasper.gaussian-blur"
  effectVersion: number;
  enabled: boolean;                         // the fx toggle (bypass)
  params: Record<string, Animatable<ParamValue>>;
};
type ParamValue = number | boolean | string | Vec2 | RGBA | { mediaId: string } /* LUT or image refs */;
```

- **FX-021 (P0)** The **effect registry** is app code, not document data. Each entry declares:
  - id, version, display name, category (Premiere effect bins: Adjust, Blur & Sharpen, Color Correction, Distort, Generate, Keying, Stylize, Time, Transform, Utility; Audio: Amplitude, Filter, Noise Reduction, Time and Pitch);
  - `appliesTo: 'video' | 'audio'`;
  - a typed parameter list: type, default, range, unit, whether it is animatable (enums, booleans and strings are hold-only, KF-007);
  - **engine capability flags**: `preview: 'css' | 'webgl' | 'webaudio' | 'none'` and `export: ('remotion' | 'native')[]`. The Effects panel filter badges ("Real-time", "Native") and the render bar colors are computed from these flags;
  - a migration function from older versions of itself.
- **FX-022 (P0)** An effect whose id or version is unknown to the running app is kept as-is, shown in Effect Controls as "Missing effect: <id>", and bypassed when rendering (with a warning on export).
- **FX-023 (P0)** Effect stacks are ordered arrays. Commands can add at an index, remove, reorder, toggle and set params. Deleting a clip deletes its effects.
- **FX-024 (P1)** Minimum v1 registry: crop, Lumetri-style basic color (exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, input LUT, look LUT with intensity), gaussian blur, sharpen, drop shadow, chroma key, horizontal/vertical flip, mirror; audio: parametric EQ (3 bands), compressor, noise reduction, pitch shift, hard limiter. The native engine maps each of these to ffmpeg filters (see `docs/research/native-video-libraries.md` §5 and §8). Their browser preview uses CSS filters or WebGL.
- **FX-025 (P2)** Masks on effects and on Opacity (ellipse, rectangle, bezier path with feather, expansion and tracking).
- **FX-026 (P2)** Source (master clip) effects that apply to every use of a media asset.

Beyond the template: the template had no effect stack, no registry, no Premiere-style transform model (it stored boxes as left/top/width/height with no anchor or scale), no blend modes, no audio chain beyond one volume value, and no track or master audio.

---

## 12. Keyframes and animation

- **KF-001 (P0)** Every animatable property uses one shape:

```ts
type Animatable<T> = {
  value: T;                          // used when keyframes is empty (stopwatch off)
  keyframes: Keyframe<T>[];          // non-empty = stopwatch on; sorted by time, unique times
};
type Keyframe<T> = {
  id: string;                        // kf_…
  time: number;                      // flicks, content time of the owning clip (TIME-002)
  value: T;
  interpolation: 'linear' | 'bezier' | 'auto-bezier' | 'continuous-bezier' | 'hold'; // the segment leaving this keyframe
  inInterpolation?: 'linear' | 'bezier' | 'auto-bezier' | 'continuous-bezier'; // keyframe-sides: the incoming side
  easeIn: Ease;                      // shape of the curve arriving here
  easeOut: Ease;                     // shape of the curve leaving here
};
type Ease = { influence: number; slope: number }; // influence in (0, 1]; slope >= 0, 1 = constant speed
```

- **KF-002 (P0)** **Why content time:** keyframes stick to the picture and sound. Trimming a clip's head, splitting it or changing the sequence frame rate does not move animation relative to the content. For track-level properties (track volume, pan, master volume), "content time" is the sequence time converted to flicks.
- **KF-003 (P0)** **Evaluation** at content time `t`:
  1. No keyframes → `value`.
  2. `t` before the first keyframe → the first keyframe's value. After the last → the last one's value.
  3. Otherwise find the segment `[K_i, K_{i+1}]` with `K_i.time ≤ t < K_{i+1}.time` (binary search).
  4. If `K_i.interpolation` is `'hold'`, or the type is hold-only → `K_i.value`.
     *keyframe-sides (Premiere port):* when `K_{i+1}.inInterpolation` is set, the segment is read per side
     (After Effects): linear only when `K_i.interpolation` and `K_{i+1}.inInterpolation` are both `linear`; otherwise
     step 5, where a Linear side contributes `a = 1/6, s = 1`. Without it, steps 5–6 as written (a Linear `K_i`
     gives `p = u`). See `docs/wp-notes/keyframe-sides.md`.
  5. Otherwise let `u = (t - K_i.time) / (K_{i+1}.time - K_i.time)`. Build the cubic Bézier through `(0,0)`, `P1 = (a₁, a₁ × s₁)`, `P2 = (1 - a₂, 1 - a₂ × s₂)`, `(1,1)` with `a₁, s₁` from `K_i.easeOut` and `a₂, s₂` from `K_{i+1}.easeIn`. Solve `x(τ) = u` for `τ` (Newton iterations with bisection fallback, tolerance 1e-6), and take `p = y(τ)`.
  6. Result = `K_i.value + p × (K_{i+1}.value - K_i.value)`, per component for `Vec2` and `RGBA`. Colors interpolate in straight (non-premultiplied) sRGB in v1. `p` may leave `[0, 1]` (overshoot). The result is then clamped to the parameter's range (for example opacity 0..100).
- **KF-004 (P0)** **Interpolation presets:**
  - `linear`: ignores eases and uses `a = 1/3, s = 1` on both sides, which gives `p = u`.
  - `bezier`: uses the stored eases. "Ease In" in the UI sets `easeIn = {influence: 1/3, slope: 0}`. "Ease Out" sets `easeOut` the same way. "Easy Ease" does both. *keyframe-sides:* Ease In sets only the incoming side (`side: 'in'`, `inInterpolation = 'bezier'`), Ease Out only the outgoing side, as in Premiere.
  - `auto-bezier`: the slope on both sides of an interior keyframe is computed from its neighbors, `s = (|v_{i+1} - v_{i-1}| / (t_{i+1} - t_{i-1})) / (|v_{i+1} - v_i| / (t_{i+1} - t_i))` for the outgoing side (and the matching formula for the incoming side), clamped to `[0, 3]`. It is 0 at a local minimum or maximum, which prevents overshoot. The first and last keyframes get slope 0 on their inner side. Influence is 1/3. `|·|` is the absolute value for numbers and the Euclidean distance for vectors.
  - `continuous-bezier`: like `bezier`, but editing one side's slope sets the other side to the same velocity, so the curve has no corner.
  - `hold`: step.
- **KF-005 (P0)** **Editing semantics** (the Effect Controls stopwatch model):
  - Turning the stopwatch on creates one keyframe at the playhead's content time with the current value.
  - Turning it off removes all keyframes and keeps the value at the playhead as the static `value` (the UI confirms first, as Premiere does).
  - Setting a value while animated creates or updates the keyframe at the playhead time (snapped to the sequence frame grid). Setting a value while not animated sets `value`.
  - Moving keyframes keeps them sorted. Moving one onto another keyframe's time replaces that keyframe.
  - Keyframe times are snapped to the sequence frame grid when created through the UI. Agents may pass any content time. It is snapped to the grid of the sequence that owns the clip.
- **KF-006 (P0)** Keyframes outside the clip's visible range are kept (they still shape interpolation). Effect Controls shows them past the clip edge, as Premiere does. A command `keyframes.prune {clipId}` removes keyframes that do not affect the visible range.
- **KF-010 (P1, M3)** `keyframes.simplify {tolerance, keyframeIds | targets | clipIds [, trackedOnly], details?}`
  reduces keyframes to the fewest whose animation stays within `tolerance` of the original at every frame of the
  owner (and every original key time): sequence pixels for Motion and corner pins (displacement of the drawn
  picture), the parameter's own units otherwise. Kept keys keep id, time and value; segments become `linear` or a
  fitted `bezier` ease; keys outside the selected span are untouched; hold-only parameters are skipped. One
  transaction; the result reports counts and the measured deviation (S09:TRK-023).
- **KF-007 (P0)** Hold-only types (booleans, enums, strings, font ids, media refs) always behave as `hold` whatever `interpolation` says.
- **KF-008 (P1)** Spatial interpolation of `position` (curved motion paths with spatial tangents) is reserved: v1 moves position along straight lines, with temporal easing only.
- **KF-009 (P0)** Remotion evaluates keyframes per frame in the composition (with the same `project-model` evaluator, not a separate one). The native engine compiles keyframed parameters into per-segment filter expressions or renders those clips through the hybrid path. See `docs/research/native-video-libraries.md` §6.

Beyond the template: the template had no keyframes at all. Its only time-varying properties were fixed fade lengths.

---

## 13. Transitions and fades

- **TRN-001 (P0)** A transition sits on one track at one edit point:

```ts
type Transition = {
  id: string;                          // trn_…
  trackId: string;
  effectId: string;                    // registry transition, e.g. "jasper.cross-dissolve", "jasper.dip-to-black",
                                       // "jasper.constant-power" (audio), "jasper.wipe"
  effectVersion: number;
  outgoingClipId: string | null;       // clip ending at the edit point (null = transition at a clip's head only)
  incomingClipId: string | null;       // clip starting at the edit point (null = transition at a clip's tail only)
  duration: number;                    // frames, >= 1
  alignment: 'center' | 'start-at-cut' | 'end-at-cut';
  params: Record<string, Animatable<ParamValue>>;
};
```

- **TRN-002 (P0)** At least one of `outgoingClipId`/`incomingClipId` is set. If both are set, the two clips are adjacent on the same track (`outgoing.start + outgoing.duration === incoming.start`, INV-010).
- **TRN-003 (P0)** **Handles.** A centered transition of duration `d` needs `ceil(d/2)` frames of extra content after the outgoing clip's out-point and `floor(d/2)` frames before the incoming clip's in-point. For media clips these come from the media (CLP-005 bounds). If there is not enough media, the command either shortens the transition to what is available (`handles: 'shorten'`, the default for agents) or repeats the edge frames (`handles: 'freeze'`, which Premiere does with a warning stripe). The UI uses `freeze` and shows the stripe. Generators always have handles.
- **TRN-004 (P0)** **Fades are one-sided transitions.** A video fade-in is a cross-dissolve (or dip-to-black) with only `incomingClipId`, at the clip's head. A video fade-out is one with only `outgoingClipId`, at the tail. Audio fades are one-sided "constant power" or "constant gain" transitions on audio tracks. The model has no separate fade fields. The UI offers fade handles on clip corners that create or resize these transitions.
- **TRN-005 (P0)** Transitions follow their clips. When a move separates the two clips of a two-sided transition, the transition is deleted in the same transaction and the result carries a warning (`W_TRANSITION_REMOVED`), which the UI shows as a toast. The user can undo the move to get it back. Deleting a clip deletes transitions that reference it. Splitting a clip moves a tail transition to the right part.
- **TRN-006 (P1)** Default transition (Premiere Ctrl+D / Ctrl+Shift+D) is a user preference: effect id per medium and the alignment of two-sided ones (S10:TUI-031/033); the default durations are project settings, one per medium (`settings.defaultTransitionFrames` for video, `settings.defaultAudioTransitionFrames` for audio, falling back to the video one; S10:TUI-032). `transition.add` without `duration` and `transition.applyDefault` use the length of the track's medium; `transition.applyDefault` takes an optional `alignment` for two-sided transitions (default `center`).

Beyond the template: the template had fixed per-item fade lengths and no transitions.

---

## 14. Editor session state

### 14.1 Session structure

- **SES-001 (P0)** One `EditorSession` object per open project, created by opening a project and destroyed on close. It holds:

| Slice | Contents | Persisted? | Undoable? |
|---|---|---|---|
| `document` | the `ProjectDocument` (immutable value, structural sharing) | yes (PER) | yes |
| `revision` | integer, +1 per committed transaction | with the document | n/a |
| `history` | undo/redo stacks (section 17) | no | n/a |
| `gesture` | the in-progress transient document for a live drag, if any (SES-006) | no | no |
| `view` | per-sequence view state (SES-004) | yes, per project and per device | no |
| `selection` | section 15 | no | no (restored by undo, SEL-008) |
| `tabs` | open sequence tabs, active sequence, Source Monitor content | yes, view file | no |
| `media` | runtime media status per asset: availability, resolved playback URL, proxy readiness, derivative readiness (LIFE-050) | no | no |
| `jobs` | import, probe, proxy, thumbnail, waveform, derived-asset, transcription, fframes and export jobs with progress | no (the engine keeps its own job table) | no |
| `toggles` | linked selection, snapping, use proxies, preview quality, active tool | yes, as user preferences | no |

- **SES-002 (P0)** The store is a plain external store (not React component state): `getSnapshot()`, `subscribe(listener)`, and selector hooks built on `useSyncExternalStore`. React components, the agent bridge, keyboard handlers and the autosaver all use the same store. Selectors compare by reference. Every update replaces only the changed parts of the document (structural sharing), so memoized selectors stay cheap.
- **SES-003 (P0)** Document updates only happen through `session.apply(transaction)` (committed) or through the gesture API (SES-006). Nothing else may replace `document`. This single entry point is what makes undo, autosave, agent events and invariants reliable.
- **SES-004 (P0)** **Per-sequence view state** (persisted per project in a separate "view" record, not undoable): playhead frame, horizontal zoom and scroll, per-track height and collapsed state, track targeting, source patching (which source track goes to which sequence track), keyframe display mode per track, Timeline display settings (thumbnails, waveforms, names). Persisting it means reopening a project restores where the user was, as Premiere does.
- **SES-005 (P0)** **Preferences** (per user and device, not per project): keymap, autosave interval, default scaling, default transition, audio scrub, playback auto-scroll mode, cache limits. Stored in `localStorage` on web and in the engine config on desktop.
- **SES-006 (P0)** **Gestures** (continuous interactions: dragging clips, trimming, scrubbing a value, dragging a keyframe, drawing a crop):
  1. `beginGesture(label)` stores the current committed document as the base.
  2. Each pointer move calls `updateGesture(commands)`. The commands are applied to the **base** document (not cumulatively to the previous transient result), giving a transient document that preview and UI render. Transient updates skip history and autosave. The invariant check runs in dev builds only.
  3. `commitGesture()` applies the last command list to the base as one transaction (validated, recorded as one undo step with the label).
  4. `cancelGesture()` (Esc, or pointer-cancel) drops the transient document. Nothing is recorded.
  An agent transaction that arrives during a gesture is queued until the gesture ends, then applied on top of the result.
- **SES-007 (P0)** While a transient document exists, readers that must see committed data (autosave, agent queries, clipboard) read the committed document. Readers that draw (timeline, monitors) read the transient one.

### 14.2 Derived indexes

- **SES-010 (P0)** Derived data is computed from the document and memoized by document reference, never stored:
  - per track: clips sorted by `start`, plus an interval index for "clips at frame f";
  - sequence duration (TIME-007);
  - link group and clip group membership maps;
  - asset usage counts per sequence (Project panel usage columns, PRJ-008);
  - "what references this" maps for media, synthetics, transcripts, sequences (used by delete warnings and GC);
  - out-of-sync offsets (CLP-011);
  - per-frame "engine affinity" (which engines are needed at each frame range) for the render bar and the export planner.
- **SES-011 (P0)** Performance targets on the reference machine: applying a typical single-clip command and re-deriving indexes for a 1,000-clip sequence in under 4 ms. A 50-clip gesture update in under 8 ms (to hold 60 fps drags). Rebuilding everything for a 10,000-clip project in under 100 ms.

Beyond the template: its runtime state lived in one React state object together with the document, gesture flags sat inside document data, and the view state (zoom, playhead, track heights) was not saved per project.

---

## 15. Selection

- **SEL-001 (P0)** Selection is per domain, and all domains coexist. Which domain a command (Delete, Copy, arrow keys) acts on is decided by the focused panel:

```ts
type Selection = {
  timeline: { clips: string[]; transitions: string[]; gaps: GapRef[]; primaryClip: string | null };
  keyframes: { clipOrTrackId: string; keyframeIds: string[] } | null;  // Effect Controls or timeline rubber bands
  markers: string[];                                                     // sequence markers of the active sequence
  project: { items: string[]; primary: string | null };                  // Project panel
  tracks: string[];                                                      // track headers (for delete tracks)
};
type GapRef = { trackId: string; start: number; end: number };           // computed on click, validated on use
```

- **SEL-002 (P0)** Selection holds ids only. After every document change, ids that no longer exist are dropped (and a gap that is no longer empty is dropped).
- **SEL-003 (P0)** The **primary clip** (the last one clicked) drives the Properties and Effect Controls panels. With several clips selected, Properties shows the shared properties and edits apply to all of them (a relative change for numbers when values differ, as in Premiere).
- **SEL-004 (P0)** **Linked selection** (session toggle, default on): selecting a clip also selects its link group members. The Alt modifier selects only the clicked clip. Clip group members are always selected together.
- **SEL-005 (P0)** Selecting a clip on a locked track is allowed (for inspection). Editing it fails (TRK-004).
- **SEL-006 (P0)** After an operation, the selection follows the result: split → both parts selected if the original was; paste/duplicate → the new clips; delete → empty; nest → the nest clip.
- **SEL-007 (P0)** Selection changes are not undo steps (Premiere behaves this way too).
- **SEL-008 (P0)** Each history entry stores the timeline and project selection **before** and **after** its transaction. Undo restores the "before" selection and redo the "after" selection, each filtered to existing ids. This keeps focus on what just changed.
- **SEL-009 (P0)** Agents can read the selection (`selection.get`) and may target it: commands accept the target `"$selection"` (clips) or `"$selection.primary"`, resolved when the transaction is submitted. Agents MAY set selection (`selection.set`) to show the user what they did. That is not an undo step.

Beyond the template: the template had one flat list of selected items, no linked selection, no gap, keyframe, marker or project-item selection, and it did not restore selection meaningfully on undo.

---

## 16. Commands and transactions

### 16.1 Principles

- **CMD-001 (P0)** Every document change, from the UI, the keyboard, the clipboard, an agent, the engine or a migration, is expressed as **commands** inside a **transaction**. UI components never build new documents by hand.
- **CMD-002 (P0)** A command is a JSON object `{ "type": "<namespace.verb>", ...args }`. Each type has a zod schema in `project-model`, and JSON Schemas are generated from it for agents (AGT-002).
- **CMD-003 (P0)** Command handlers are **pure**: `(document, command, context) → { document, result, warnings }`. `context` provides the injected services (id source, text measurer, registries). A handler that changes nothing returns the same document reference.
- **CMD-004 (P0)** A transaction is applied **atomically**: its commands run in order, each seeing the previous one's result. After the last command the invariants run (16.3). If any command fails or any invariant is violated, the whole transaction is rejected and the document is unchanged.
- **CMD-005 (P0)** Transaction envelope:

```ts
type Transaction = {
  protocol: 'jasper.tx/1';
  label: string;                       // shown in History, e.g. "Ripple delete 3 clips"
  origin: 'user' | { agent: string; runId?: string } | 'system' | 'migration';
  expectedRevision?: number;           // optimistic concurrency (AGT-010)
  dryRun?: boolean;                    // validate and return the result without committing
  sequenceId?: string;                 // default sequence for commands that omit it
  commands: Command[];
};
type TransactionResult =
  | { ok: true; revision: number; refs: Record<string, string>; created: string[]; changed: string[];
      deleted: string[]; warnings: Issue[]; results: unknown[] }
  | { ok: false; revision: number; errors: Issue[] };
type Issue = { commandIndex: number; code: string; message: string; path?: string[] };
```

- **CMD-006 (P0)** Temporary references (`"$name"`) can be declared by a creating command (`"ref": "$title"`) and used by later commands in the same transaction. `refs` in the result maps them to real ids.
- **CMD-007 (P0)** Error codes are stable strings (`E_NOT_FOUND`, `E_TRACK_LOCKED`, `E_TRACK_KIND`, `E_OVERLAP`, `E_OUT_OF_MEDIA`, `E_IN_USE`, `E_SYNC_CONFLICT`, `E_SYNC_LOCKED_TRACK`, `E_INVALID_PARAM`, `E_UNKNOWN_EFFECT`, `E_CYCLE`, `E_REVISION_MISMATCH`, `E_SCHEMA`, `E_LIMIT`, `E_AMBIGUOUS`, `E_NOT_OWNER`). Warnings use `W_…` codes (`W_CLIP_COLLAPSED`, `W_TRANSITION_SHORTENED`, `W_TRANSITION_REMOVED`, `W_DURATION_CLAMPED`, `W_OFFLINE_MEDIA`).

### 16.2 Command catalog (v1)

Arguments in brackets are optional. "Target tracks" accept ids or labels (`"V2"`). Times follow TIME-006. The detailed gesture UX (how the Ripple tool maps a drag to `clip.trim`) is in the timeline spec. The model semantics are here.

**Project and bins**

| Command | Arguments | Semantics |
|---|---|---|
| `project.rename` | `name` | |
| `project.updateSettings` | partial `ProjectSettings` | |
| `bin.create` | `name`, [`parentBinId`], [`ref`] | |
| `item.rename` / `item.setLabel` | `itemIds`, `name` / `label` | |
| `item.move` | `itemIds`, `toBinId \| null`, [`index`] | |
| `item.delete` | `itemIds`, [`force`] | PRJ-004, PRJ-006 |
| `item.setMarks` | `itemId`, `in`, `out` | PRJ-005 |
| `media.register` | `asset: MediaAsset` (already probed), [`binId`], [`ref`] | Adds an asset + project item. The import pipeline (LIFE-010) calls this after probing. If an asset with the same fingerprint exists, it only adds a project item. |
| `media.relink` | `mediaId`, `locator`, [`probe`], M3: [`replace`, `locators`, `container`, `sourceRange`, `keepSourceTiming`, `fit`] | Replaces locators after a fingerprint check (LIFE-032). M3 Replace Footage (S07:PRC-018): `replace` accepts a different file; `keepSourceTiming` moves every clip of the media so it shows the same source frames. |
| `media.derive` | `fromMediaId`, `recipe`, [`binId`], [`replaceInClips: clipIds`], M3: [`range`, `fit`] | Creates a derived asset (AST-021). Optionally swaps the source of the given clips, mapping content time 1:1 (or through the recipe for `reverse`, `range` and `time-stretch`); for processed versions through their source ranges (S07:PRC-015/016). |
| `media.setSourceRange` | `mediaId`, `sourceRange \| null` | M3 (S07:PRC-019): declares the source frames a file holds; a range naming a project media makes the file a version of it. Moves no clip. |
| `media.removeUnused` | [`kinds`] | Deletes project items and assets not used by any clip (Premiere "Remove Unused"). |
| `synthetic.create` / `synthetic.update` | kind + params / id + params | AST-010 |
| `transcript.create` | `mediaId`, `language`, `origin`, `words` | Produced by transcription jobs or subtitle import. |
| `transcript.editText` | `transcriptId`, `fromWord`, `toWord`, `text` | Replaces a word range. New words share the replaced range's timing, spread in proportion to their character counts. |
| `transcript.setBreak` | `transcriptId`, `wordIndex`, `breakBefore` | |

**Sequences, tracks, markers**

| Command | Arguments | Semantics |
|---|---|---|
| `sequence.create` | `name`, `preset \| settings`, [`fromMediaId`], [`binId`], [`ref`] | SEQ-003, SEQ-004 |
| `sequence.updateSettings` | `sequenceId`, partial settings, [`reposition`] | SEQ-006, SEQ-007 |
| `sequence.duplicate` / `sequence.delete` | `sequenceId`, [`force`] | SEQ-011, PRJ-004 |
| `sequence.setInOut` / `sequence.setWorkArea` | frames or null | |
| `marker.add` / `marker.update` / `marker.remove` | sequence scope (`frame`) or clip scope (`clipId`, `flicks`), `name`, `markerType`, [`duration`], [`color`], [`comment`] | SEQ-008, CMD-014 |
| `track.add` | `kind`, `index`, [`count`], [`name`] | TRK-005 |
| `track.remove` | `trackIds`, [`force`] | |
| `track.update` | `trackId`, partial (`name`, `locked`, `syncLock`, `output`, `mute`, `solo`, `volumeDb`, `pan`, `channelFormat`, `styleDefaults`) | |

**Clips (placement and editing)**

| Command | Arguments | Semantics |
|---|---|---|
| `clip.place` | `source: {mediaId \| syntheticId \| sequenceId \| projectItemId}`, [`sourceRange: {in, out}`] (default: item marks, else full), `at` (frame), `tracks: {video?: track, audio?: track[]}`, `mode: 'overwrite' \| 'insert'`, [`video`], [`audio`], [`audioMapping`], [`scaling`], [`matchSequence`], [`ref`] | Premiere Insert/Overwrite from source. Creates linked clips (KND-003). Insert ripples with sync lock (TRK-006). |
| `clip.addText` | `at`, `duration`, `track`, `content`, [`box`], [`transform`], [`ref`] | Places a text clip (overwrite). |
| `clip.addSolid` | `at`, `duration`, `track`, `color` | Creates a color-matte synthetic source + solid clip in one step (AST-010). |
| `clip.addMotionGraphic` | `at`, `duration`, `track`, `template`, `params`, [`canvas`] | Params validated against the template schema. |
| `clip.addComposition` | `at`, `duration`, `track`, `composition`, `props` | P1 |
| `clip.addCaptions` | `transcriptId`, `track` (caption), [`alignToClipId`], [`range`], [`style`] | KND-008. `alignToClipId` (an audio clip) derives `start` and `sourceIn`. |
| `clip.addAdjustment` | `at`, `duration`, `track` | P1 |
| `clip.move` | `clipIds`, `deltaFrames`, [`deltaTracks`], `mode: 'overwrite' \| 'insert'` | Moves as a block. Track deltas count within the same kind (video clips move among video tracks). Fails with `E_TRACK_KIND` if a target track does not exist and `createTracks` is false. |
| `clip.trim` | `clipId`, `edge: 'in' \| 'out'`, `deltaFrames`, `mode: 'regular' \| 'ripple' \| 'roll'` | Regular: changes this edge only and cannot overlap a neighbor. Ripple: shifts later clips on the track (and sync-locked tracks). Roll: moves the edit point between this clip and its neighbor. Clamped to media bounds (`W_DURATION_CLAMPED`). Linked partners with coincident edges follow (CLP-010). |
| `clip.slip` | `clipIds`, `deltaFrames` | Changes `sourceIn` only (by `delta × F × rate`), within media bounds. |
| `clip.slide` | `clipId`, `deltaFrames` | Moves the clip; the neighbors' adjoining edges roll to keep the track gapless around it. |
| `clip.split` | `at` (frame), `clipIds \| tracks \| 'all-unlocked'` | CLP-007 ("Add Edit" / "Add Edit to All Tracks"). |
| `clip.lift` | `clipIds` | Removes clips and leaves gaps. |
| `clip.extract` | `clipIds` | Ripple delete: removes clips and closes the gaps on their tracks and sync-locked tracks. |
| `range.lift` / `range.extract` | `from`, `to`, `tracks` (default: targeted) | Premiere Lift/Extract of the In/Out range on targeted tracks. |
| `gap.close` | `trackId`, `at` | Ripple-deletes the gap containing `at`. |
| `clip.duplicate` | `clipIds`, `at` \| `deltaFrames`, [`tracks`] | Copies with new ids (includes their link groups), overwrite mode. |
| `clip.update` | `clipId(s)`, `patch` | Patch of non-animated fields (name, label, enabled, text content and box, style, template params, crop-independent props). For animated props use `param.set`. |
| `clip.setSpeed` | `clipIds`, [`rate`], [`duration`], [`reverse`], [`maintainPitch`] (absent: the clip's own), [`ripple`] (default false) | CLP-008 |
| `clip.replaceSource` | `clipId`, `mediaId`, [`keepDuration`], M3: [`fit`] | Replaces the media with another version of the same original, keeping effects and keyframes and the source frames shown (S07:PRC-016/017: in-point remapped from the versions' source ranges; `fit: refuse \| trim \| skip` when the version does not cover the clip). |
| `clip.fitToFrame` | `clipIds`, `mode: 'fit' \| 'fill' \| 'none'` | FX-004 |
| `clip.link` / `clip.unlink` | `clipIds` | CLP-010 |
| `clip.group` / `clip.ungroup` | `clipIds` | CLP-012 |
| `clip.nest` | `clipIds`, `name` | SEQ-010 (P1) |

**Effects, parameters, keyframes, transitions**

| Command | Arguments | Semantics |
|---|---|---|
| `effect.add` | `target: {clipId} \| {trackId} \| 'master'`, `effectId`, [`index`], [`params`], [`ref`] | |
| `effect.remove` / `effect.reorder` / `effect.setEnabled` | `effectInstanceId`, … | |
| `param.set` | `target: ParamPath`, `value`, [`at`: content time or sequence frame] | Stopwatch semantics (KF-005): sets or creates a keyframe when animated, otherwise sets `value`. |
| `param.setAnimated` | `target`, `animated: boolean`, [`at`] | KF-005 |
| `keyframe.add` / `keyframe.update` / `keyframe.remove` / `keyframe.move` | `target`, keyframe fields | KF-001, KF-005 |
| `keyframe.setInterpolation` | `keyframeIds`, `interpolation`, [`easeIn`], [`easeOut`], [`side`: both / in / out] | KF-004 |
| `keyframes.prune` | `clipId` | KF-006 |
| `keyframes.simplify` | `tolerance`, one of `keyframeIds` / `targets` / `clipIds` (+ `trackedOnly`), [`details`] | KF-010 |
| `transition.add` | `trackId`, `at` (edit point frame) \| `{clipId, edge}`, `effectId`, [`duration`], [`alignment`], [`handles`] | TRN-001–TRN-004 |
| `transition.update` / `transition.remove` | | |
| `transition.applyDefault` | `clipIds`, `edges: 'both' \| 'in' \| 'out'` | Premiere Shift+D |

- **CMD-010 (P0)** `ParamPath` addresses any animatable property with JSON-pointer-like segments, for example `["clip", "clp_…", "transform", "position"]`, `["clip", "clp_…", "opacity"]`, `["effect", "fx_…", "radius"]`, `["track", "trk_…", "volumeDb"]`, `["master", "volumeDb"]`.
- **CMD-013 (P0)** The `at` argument of parameter and keyframe commands accepts `{frames: n}` or a bare integer `n` (frames relative to the clip's first frame, converted to content time with CLP-004), `{sequenceFrame: n}` (absolute timeline frame inside the clip), `{flicks: n}` (content time directly), or a timecode string (absolute timeline). For track and master parameters, all forms are converted to sequence time.
- **CMD-014 (P0)** Command arguments never use the key `type` for entity data, because `type` names the command. Entity fields called `type` elsewhere (marker type, locator type) are passed as `markerType`, `locatorType` and so on.
- **CMD-011 (P0)** Commands that act on "targeted tracks" or "the playhead" take those values as **explicit arguments**. The UI fills them from session state. Handlers never read session state, so agents and tests get deterministic results.
- **CMD-012 (P1)** **Macro commands** (for example "remove silences", "cut at scene changes", "auto-duck music under dialogue") are not part of `project-model`. They are agent tools or UI actions that query the engine for analysis results (silence ranges, scene cuts, loudness) and then submit **one** transaction of primitive commands. That keeps undo, validation and history uniform.

### 16.3 Invariants

The invariant checker runs after every transaction (all builds) and after every gesture update (dev builds). Each violation is an error with a code and a path.

| ID | Invariant |
|---|---|
| **INV-001** | All ids are unique across the document and carry the right prefix. |
| **INV-002** | Every clip's `trackId` names a track in the same sequence, and the clip kind is compatible with the track kind (TRK-003). |
| **INV-003** | No two clips on the same track overlap. |
| **INV-004** | `start ≥ 0`, `duration ≥ 1`, all integers. `sourceIn ≥ 0`, integer. `speed.rate` in `[0.01, 100]`. |
| **INV-005** | For bounded content, `sourceIn + contentSpan ≤ content duration` (CLP-005). A one-frame tolerance is allowed for rounding. |
| **INV-006** | Every reference resolves: `mediaId`, `syntheticId`, `sequenceId`, `transcriptId`, `fontId`, `linkId`, `groupId`, transition clip ids, LUT param media ids, project item targets. |
| **INV-007** | Link groups: members are in the same sequence, count ≥ 2, at most one video-kind member. Clip groups: members in the same sequence, count ≥ 2. |
| **INV-008** | Bin tree: every project item appears exactly once (in `rootItems` or one bin's `children`). There are no cycles. Every sequence has exactly one project item. |
| **INV-009** | The nesting graph of sequences is acyclic. |
| **INV-010** | Transitions: two-sided transitions join adjacent clips on their track. One-sided ones sit at a clip edge with no transition already there. Duration fits the clips (the transition is no longer than the shorter clip). |
| **INV-011** | Keyframes: sorted by strictly increasing `time`, unique ids, value types match the parameter type. |
| **INV-012** | Parameters are valid for their registry schema (unknown effects are exempt, FX-022). All numbers are finite. Opacity 0..100, crop sums < 100, and so on. |
| **INV-013** | Sequence settings: allowed frame rate, even dimensions within limits. |
| **INV-014** | Every media asset, synthetic source and transcript is referenced by at least one project item, clip or other entity (no silent leaks). Transcripts may be referenced by their media's project item instead of a clip. |
| **INV-015** | Every track list has at least one video and one audio track. |

Beyond the template: the template called plain functions directly, had no serializable command vocabulary, no transactions, no validation (pasted data was trusted), no error codes, no dry-run, no insert/overwrite/ripple/roll/slip/slide semantics, and only "front/back/directly above" placement.

---

## 17. Undo, redo and history

- **UND-001 (P0)** **Mechanism:** snapshot-based. Each history entry keeps a reference to the committed document before and after its transaction. Thanks to structural sharing, an entry costs only the changed objects. Undo sets the document back to the entry's "before" and redo to its "after". This is simple, exact and independent of every handler being reversible.
- **UND-002 (P0)** Each entry also records: label, origin (user or agent name), time, revision numbers, the ids created, changed and deleted (for the History panel and events), and the selection before and after (SEL-008).
- **UND-003 (P0)** **What is undoable:** every committed transaction with origin `user` or agent. **Not undoable:** selection, view state (zoom, playhead, track heights, targeting), toggles, runtime media status, jobs, preferences, and system transactions (UND-012).
- **UND-004 (P0)** Capacity: default 200 entries, configurable from 32 to 1,000 (Premiere's History panel is limited to 100). The oldest entries are dropped first. A memory guard also drops old entries when the retained unique objects exceed 256 MB (estimated from serialized size on commit).
- **UND-005 (P0)** A new commit after one or more undos discards the redo stack (linear history, as in Premiere).
- **UND-006 (P0)** **Coalescing:**
  - A gesture always produces one entry (SES-006).
  - Typing in a text clip produces one entry per edit session (from focus until blur or Enter or Esc, or after 2 s of no typing).
  - Scrubbing a numeric field produces one entry per scrub.
  - Repeated keyboard nudges of the same selection with the same command type within 750 ms merge into one entry.
  - Coalescing happens only between consecutive user entries with the same label and targets.
- **UND-007 (P0)** **Agent transactions are single entries** labeled `Agent: <label>` (for example "Agent: Remove silences (14 cuts)"), whatever the number of commands. The user undoes a whole agent step with one Ctrl+Z.
- **UND-008 (P0)** Undo and redo are themselves allowed for agents (`history.undo`, `history.redo`). Agents may only undo their own most recent entry unless the user allowed more. The bridge refuses with `E_NOT_OWNER` if the top entry has another origin.
- **UND-009 (P1)** **History panel** (Premiere): lists entries with labels and origin icons. Clicking an entry moves to that state (repeated undo/redo). "Clear history" drops all entries.
- **UND-010 (P0)** The first committed change after opening a project can be undone back to the opened state: the opened document is the implicit base of the history.
- **UND-011 (P0)** History is per session and is not persisted. Reopening a project starts with an empty history (Premiere does the same). Autosave versions (PER-020) provide the long-term safety net.
- **UND-012 (P0)** **System transactions** (origin `system`) record facts the user did not author: a derived asset's fingerprint after its first materialization (AST-022), a resolved text layout for a headless edit (KND-006), refreshed probe data after relinking the same fingerprint. They are applied to the current document **and rebased into every history snapshot** that contains the same entity (a patch applied to each snapshot's copy of that entity), so that undo never brings stale facts back. Only these narrowly defined "fact" fields may be changed by system transactions. They never change edit decisions.
- **UND-013 (P0)** Asset storage is never deleted while any history snapshot still references the asset (LIFE-060).

Beyond the template: the template kept 50 snapshots, could not undo the first change after loading, had background status updates that silently diverged from snapshots, had no coalescing rules for text typing, no labels, no history panel and no notion of who made a change.

---

## 18. Persistence

### 18.1 Store interface

- **PER-001 (P0)** Persistence is behind one async interface in `packages/editor-session` (implemented by three adapters):

```ts
interface ProjectStore {
  list(): Promise<ProjectSummary[]>;                          // id, name, modifiedAt, thumbnail, schemaVersion, sizeBytes
  create(init: { name: string; preset: string }): Promise<string>;
  open(projectId: string, opts?: { readOnly?: boolean }): Promise<OpenedProject>; // document + view + lease
  save(projectId: string, doc: ProjectDocument, meta: { revision: number; baseRevision: number }): Promise<SaveResult>;
  saveView(projectId: string, view: ProjectViewState): Promise<void>;
  listVersions(projectId: string): Promise<VersionInfo[]>;    // autosave history (PER-020)
  restoreVersion(projectId: string, versionId: string): Promise<string>; // restores as a new project copy
  duplicate(projectId: string, name: string): Promise<string>;
  delete(projectId: string): Promise<void>;
  exportFile(projectId: string): Promise<Blob | { path: string }>;  // PER-030
  importFile(file: Blob | { path: string }): Promise<string>;
  acquireLease(projectId: string): Promise<Lease>;            // PER-040
}
```

- **PER-002 (P0)** **On-disk envelope** (all adapters):

```json
{
  "format": "jasper-project",
  "schemaVersion": 1,
  "savedAt": "2026-09-30T10:12:00.000Z",
  "savedBy": { "app": "JasperEditor", "version": "0.1.0", "platform": "web" },
  "revision": 412,
  "document": { "…": "ProjectDocument" }
}
```

  Transcripts MAY be split out into separate records or files (PER-012). The loader reassembles them before validation.

- **PER-003 (P0)** **Save is always allowed.** Pending imports, running jobs, offline media or failed uploads never block saving: they are runtime states, and the document is valid without them.
- **PER-004 (P0)** **Load pipeline:** read envelope → check `format` → migrate (MIG) → zod-validate → invariant check → build session. Invariant violations in a loaded file do not throw away the project: the loader applies conservative **repairs** (drop dangling references, split overlapping clips by moving the later one to a new track, remove empty link groups), records a repair report, opens the project, and shows "This project was repaired" with the details.

### 18.2 Web (browser-only and PWA)

- **PER-010 (P0)** IndexedDB database `jasper-editor` with object stores:

  | Store | Key | Value |
  |---|---|---|
  | `projects` | projectId | summary (name, modifiedAt, thumbnail data URL at 320 px, schemaVersion, sizeBytes) |
  | `documents` | projectId | envelope minus transcripts |
  | `transcripts` | [projectId, transcriptId] | transcript JSON |
  | `views` | projectId | view state (SES-004) |
  | `versions` | [projectId, savedAt] | autosave versions (PER-020) |
  | `media-index` | fingerprint | {storage: 'opfs' \| 'idb', sizeBytes, mime, projects: projectId[]} |
  | `media-blobs` | fingerprint | Blob (only when OPFS is not available) |
  | `derivatives` | [fingerprint, kind, paramsHash] | Blob + {createdAt, lastUsedAt, sizeBytes} |

- **PER-011 (P0)** **Media bytes** go to the Origin Private File System (`/media/<fingerprint>`) when available (supports large files and random access), otherwise to the `media-blobs` store. They are keyed by fingerprint, so importing the same file into two projects stores it once. `media-index.projects` is the cross-project reference list used by GC (LIFE-061).
- **PER-012 (P1)** Large transcripts (over 256 KB) are saved as separate records so small edits elsewhere do not rewrite them. They are rewritten only when they change (reference comparison).
- **PER-013 (P0)** On first import the app calls `navigator.storage.persist()` and shows the result. Before storing media it checks `navigator.storage.estimate()`: if the import would leave less than 10% free quota, the user is warned, and above the quota the import fails with a clear message that suggests connecting an engine.
- **PER-014 (P0)** Save serializes the document to a string once and writes it in one IndexedDB transaction together with the summary. On web, serialization of documents over 2 MB runs in a Worker (structured clone of the document to the worker, then `JSON.stringify` there) to avoid jank.

### 18.3 Desktop (Electron, through the engine)

- **PER-015 (P0)** A project is a file `<Name>.jasper` (the envelope, UTF-8 JSON). The desktop app registers the `.jasper` file association. File system access happens in the engine process, never in the renderer.
- **PER-016 (P0)** **Atomic writes:** write `<Name>.jasper.tmp`, fsync, rename over the original, fsync the directory. A crash therefore leaves either the old or the new file, never a torn one.
- **PER-017 (P0)** Media stays where it is by default (Premiere behavior). Locators record the absolute path and the path relative to the project file. With `mediaPolicy.copyOnImport`, imported files are copied to `<project folder>/<Name> Media/` and located relative to the project.
- **PER-018 (P0)** Derivatives live in the engine cache `<appdir>/cache/derivatives/<fingerprint>/<kind>-<paramsHash>.<ext>`, shared by all projects, with an LRU size cap (default 50 GB, preference).
- **PER-019 (P0)** The view state is saved next to the project as `<Name>.jasper-view` (JSON), so sharing the `.jasper` file does not carry personal view state.

### 18.4 Remote engine (VPS or home server used by web/PWA)

- **PER-025 (P1)** The engine exposes the same `ProjectStore` operations over HTTP (`/api/projects…`). `save` sends `If-Match: <baseRevision>`. The engine answers `409` with its current revision if another writer saved in between. Media is uploaded with a streaming upload to the engine and referenced with `engine-store` locators.
- **PER-026 (P1)** Mobile PWA clients work against a remote engine by default (their local storage is small and evictable). They keep a local cache of the current document for offline viewing and queue edits made while offline for replay as transactions with `expectedRevision` (conflicts go through AGT-010 rules).

### 18.5 Autosave and recovery

- **PER-020 (P0)** **Autosave:**
  - The project is saved automatically 1.5 s after the last committed transaction, and at most every 10 s during continuous editing. It is never saved while a gesture is in progress (the committed document is what gets saved anyway, SES-007).
  - Every 5 minutes of editing (and before any migration or restore), the previous saved state is also kept as a **version**. The newest 20 versions are kept per project (preference), plus one per day for 7 days. Desktop keeps them in `<project folder>/Jasper Auto-Save/`, web in the `versions` store.
  - The title bar and the project tab show a dirty dot while there are unsaved changes. Ctrl/Cmd+S forces a save immediately.
- **PER-021 (P0)** **Crash recovery:** on desktop the engine writes a small journal `<Name>.jasper.journal` (the list of transactions committed since the last save, as JSON lines, fsynced every second at most). On open, if a journal exists that is newer than the file, the app offers to replay it. On web, autosave latency (1.5 s) is the recovery window. The `versions` store covers the rest.
- **PER-022 (P0)** Close and quit: if the document is dirty, save first (desktop) or flush autosave (web, on `visibilitychange` to hidden and on `pagehide`).

### 18.6 Leases, export and interchange

- **PER-030 (P0)** **Export project** writes the envelope with transcripts inlined, as a single `.jasper` file (web: download; desktop: Save As). **Import project** reads such a file, migrates it, and creates a new project. Media referenced only by `browser-store` locators is offline after import on another machine until relinked (LIFE-030).
- **PER-031 (P1)** Interchange with other NLEs goes through OpenTimelineIO (`docs/research/native-video-libraries.md` §7): export a sequence to `.otio` natively in TypeScript, and to FCP7 XML, EDL or AAF through the engine's optional Python sidecar. JasperEditor-only data (motion-graphic params, effect stacks, keyframes) goes into `metadata.jasper` so a round trip through OTIO restores it. Import maps clips back through the same metadata, or relinks by file name and duration.
- **PER-040 (P0)** **Single writer:** opening a project takes a lease. Web: the Web Locks API (`navigator.locks.request("jasper-project:" + id, {ifAvailable: true})`) plus a `BroadcastChannel` to tell other tabs. Desktop: a lock file `<Name>.jasper.lock` with process id, host name and time. Engine: an in-memory lease per session with a heartbeat. A second opener gets a read-only session with a "Take over editing" action that asks the current holder to save and release.

### 18.7 Schema versions and migrations

- **MIG-001 (P0)** `schemaVersion` is an integer that starts at 1. Every change to the persisted shape that is not purely additive-with-defaults increments it.
- **MIG-002 (P0)** Migrations are pure functions `vN → vN+1` in `project-model`, applied in sequence on load, each with fixture tests (a stored example file per version that must load forever).
- **MIG-003 (P0)** Opening a document with a **newer** `schemaVersion` than the app knows opens it read-only with a banner "Created with a newer JasperEditor". It is never silently downgraded.
- **MIG-004 (P0)** Before a migration writes back, the original is kept as a version (PER-020).
- **MIG-005 (P0)** Additive fields get defaults through the zod schema on load, so older files without them stay valid without a version bump.

Beyond the template: the template saved one project in a single `localStorage` slot, with no autosave, no schema version or migrations, no project list, no crash recovery, no multi-tab protection, and it refused to save while uploads were pending or had failed.

---

## 19. Asset lifecycle

### 19.1 Import

- **LIFE-010 (P0)** **Import pipeline** (one job per file, several in parallel, max 4 concurrent probes):
  1. **Acquire.**
     - Desktop: the user picks files (or drops them), or an agent passes paths. The engine reads them in place (or copies them with `copyOnImport`).
     - Web without engine: the File is written to OPFS/IndexedDB under a temporary key while the fingerprint is computed.
     - Web with a remote engine: the file is streamed to the engine.
     - URL: the engine downloads it (desktop and remote only).
  2. **Fingerprint** (AST-003), streamed, in a worker or the engine.
  3. **Deduplicate:** if the project already has an asset with this fingerprint, reuse it and only create a new project item (the dialog says "Already in project; added another reference"). Web storage is keyed by fingerprint, so bytes are never stored twice.
  4. **Probe:** the engine uses ffprobe. The browser-only runtime uses mediabunny (WebCodecs) and marks `browserDecodable` per stream.
  5. **Decide support:** unsupported (no decodable stream on any available engine) → the job fails with the reason, and nothing is committed. Decodable only by the engine (for example ProRes, DNxHR or HEVC in some browsers) → accepted, with proxy generation forced (LIFE-021).
  6. **Commit:** one transaction "Import N files" with `media.register` for every successful file (plus `clip.place` if the import was a drop onto the timeline). Files that failed are listed in a result dialog and are not in the transaction.
  7. **Schedule derivatives** (LIFE-020): thumbnails, waveform, keyframe index, and a proxy if the policy says so.
- **LIFE-011 (P0)** Supported inputs in v1:
  - Video containers: mp4/mov/m4v, mkv/webm; mxf and avi with an engine only.
  - Images: png, jpg, webp, avif, svg (rasterized at import size), heic with an engine only.
  - Animated images: gif, apng, animated webp.
  - Audio: wav, mp3, aac/m4a, flac, ogg/opus.
  - Subtitles: srt, vtt (become transcripts, AST-031).
  - Fonts: ttf, otf, woff2.
  - LUTs: .cube.
- **LIFE-012 (P0)** Drag-and-drop from the OS onto the Project panel imports into the target bin. Onto the timeline, it imports and places (overwrite at the drop frame, on the drop track). Onto the Program monitor, it imports and overwrites at the playhead on targeted tracks.
- **LIFE-013 (P0)** Import never blocks editing. Clips placed from assets that are still producing derivatives play from the original (or show "Preparing…" when the original is not browser-decodable and the proxy is not ready yet).

### 19.2 Derivatives and proxies

- **LIFE-020 (P0)** Derivative kinds (runtime cache, never document data):

  | Kind | Produced by (engine / browser fallback) | Used for |
  |---|---|---|
  | `thumbs` | ffmpeg keyframe tiles / mediabunny frame extraction | filmstrips, Project panel icons, hover scrub |
  | `peaks` | ffmpeg mono PCM at 8 kHz reduced to peaks / mediabunny audio samples | waveforms (100 peaks per second, float32 max-abs) |
  | `keyframe-index` | ffprobe keyframes only | lossless-cut snapping, seek planning |
  | `proxy` | ffmpeg H.264 short-GOP 720p (or 540p) with faststart / mediabunny conversion | smooth preview of heavy or non-browser media |
  | `loudness` | ffmpeg ebur128 | normalization, auto-duck |
  | `scenes` | ffmpeg scene detection | cut detection tools |
  | `silences` | ffmpeg silencedetect | silence-removal tools |
  | `mg-proxy` / `mg-master` | fframes pipe → VP9-alpha WebM / ProRes 4444 or PNG sequence | motion-graphic preview and export (LIFE-045) |
  | `render-cache` (P2) | Remotion or native prerender of a range | green render bar |

  Keys: `(fingerprint, kind, paramsHash)`. Commands never reference derivatives.
- **LIFE-021 (P0)** **Proxy policy** (document, `settings.proxyPolicy`):

```ts
type ProxyPolicy = {
  mode: 'off' | 'auto' | 'always';
  preset: 'h264-720p' | 'h264-540p';
  autoWhen: { minHeight: number; codecs: string[]; bitDepthAbove: number }; // default: >= 2160, ["prores","dnxhd","hevc"], > 8
};
```

  In `auto`, a proxy is made when any condition matches or when the video stream is not browser-decodable (always forced then). Proxies keep the source's frame rate and timing exactly, so any content time maps one to one.
- **LIFE-022 (P0)** **Use proxies** is a session toggle (Premiere "Toggle Proxies" button). When on, playback uses the proxy if ready, otherwise the original. Export always uses originals unless the export dialog explicitly chooses proxies (draft export).
- **LIFE-023 (P1)** Proxy jobs run at most 2 at a time, with ffmpeg threads split so the UI and preview stay responsive. They pause during export.

### 19.3 Derived media and motion-graphic renders

- **LIFE-040 (P1)** Derived asset jobs (AST-021): queued on the engine with progress events. On success the file is stored as `<appdir>/media/derived/<recipeHash>.<ext>` (desktop/engine) or in engine storage (remote), and a system transaction sets the fingerprint (UND-012). On failure the clips show "Processing failed" with the error and a Retry action. The document is not changed.
- **LIFE-045 (P0)** Motion-graphic renders: when a motion-graphic clip is created or its params, duration or canvas change, the session computes its render key (KND-009). If no `mg-proxy` exists for that key, it requests one from the engine (debounced 500 ms after the last param change). Meanwhile the Player shows the WASM SVG preview if the template has one, otherwise the last proxy with a "Rendering…" badge. Export requests `mg-master`. Keys are content-addressed, so undo and redo reuse earlier renders without re-rendering.

### 19.4 Availability, offline media, relinking

- **LIFE-030 (P0)** **Resolution order** at open and when locators change:
  - Desktop: `path` absolute → `path` relative to the project → search the project folder and the last 5 relink folders by file name + size, confirmed by fingerprint.
  - Web: `browser-store` by fingerprint → `engine-store` if an engine is connected → `url` through the engine.
  - First hit wins. No hit → **offline**.
- **LIFE-031 (P0)** Offline clips stay in the document unchanged. They draw on the timeline in the offline style and render as a "Media Offline" frame (red, as in Premiere) in preview. Export warns and lists the offline media before starting.
- **LIFE-032 (P0)** **Relink** (Premiere "Link Media"): the user or an agent points to a file. The fingerprint must match. If it does not, the UI shows a warning with a comparison (duration, resolution, rate) and allows "Relink anyway" (which creates a system probe refresh and warns on clips whose ranges now exceed the media). Relinking one file offers to relink others found in the same folder.
- **LIFE-033 (P1)** Missing fonts and missing effects/templates are reported in the same "Missing items" dialog as offline media.

### 19.5 Runtime media status

- **LIFE-050 (P0)** Per asset, the session keeps (not in the document):

```ts
type MediaRuntime = {
  availability: 'resolving' | 'online' | 'offline' | 'needs-engine' | 'error';
  playbackUrl: string | null;       // blob:, /media/<id>, /media/<id>/proxy ... for this runtime only
  proxy: DerivativeStatus; thumbs: DerivativeStatus; peaks: DerivativeStatus;
  derived: DerivativeStatus | null;  // for derived assets (AST-021)
  ingest: { phase: 'copying' | 'uploading' | 'fingerprinting' | 'probing'; progress: number } | null;
};
type DerivativeStatus = { state: 'none' | 'queued' | 'running' | 'ready' | 'failed'; progress: number; error?: string };
```

  Blob URLs for web media are created on demand and revoked when no longer used. Components ask for a playback URL through a hook, never store it.

### 19.6 Removal and cleanup

- **LIFE-060 (P0)** Removing media from a project (item delete, `media.removeUnused`) removes the document records. The bytes and derivatives are **not** deleted at that moment: they may still be needed by undo, by other projects, or by the clipboard.
- **LIFE-061 (P0)** **Garbage collection** runs on project close, on app start, and on demand ("Clean up media storage" in preferences):
  - Web: for each fingerprint in `media-index`, remove the project from its `projects` list if the saved document of that project no longer references it. Delete the bytes when the list becomes empty and no open session (any tab, checked through `BroadcastChannel`) holds it in history.
  - Desktop: files the app copied (`copyOnImport` or derived files) are deleted when no project in the app's recent-projects list references them, and only after 7 days in a "pending deletion" list. User media referenced in place is **never** deleted by the app.
  - Derivatives: LRU eviction by size cap (web default: 20% of quota; desktop default 50 GB). They can always be regenerated.
- **LIFE-062 (P1)** The Project panel's "Remove Unused" shows the list and the reclaimable storage before confirming.

Beyond the template: the template uploaded everything to a cloud bucket (or failed without credentials), kept blobs only as a browser cache, computed filmstrips and waveforms in the page for full-length media, recorded deleted assets without ever cleaning them up, and had no proxies, no fingerprint dedupe, no relinking, no offline state and no derived media.

---

## 20. Clipboard

- **CLB-001 (P0)** **Payload.** Copy writes a versioned JSON payload:

```ts
type ClipboardPayload = {
  format: 'jasper-clipboard'; version: 1;
  sourceProjectId: string; sourceSequenceId: string | null;
  kind: 'clips' | 'effects' | 'keyframes' | 'project-items';
  // clips: the clips, their transitions between copied clips, link/group membership within the set,
  // and the time/track layout relative to the earliest clip and lowest track of each kind
  clips?: { clips: Clip[]; transitions: Transition[]; originFrame: number; trackOffsets: Record<string, number> };
  effects?: { effects: EffectInstance[]; intrinsic?: Partial<{ transform: Transform; opacity: Animatable<number>; volumeDb: Animatable<number> }> };
  keyframes?: { paramType: string; keyframes: Keyframe<unknown>[]; originFlicks: number };
  items?: { items: ProjectItem[]; sequences: Sequence[] };
  // every entity referenced by the above, so the payload is self-contained:
  media: MediaAsset[]; synthetics: SyntheticSource[]; transcripts: Transcript[]; fonts: FontRef[];
};
```

- **CLB-002 (P0)** **Transport.** The system clipboard gets:
  - a `text/html` entry with the JSON embedded in a marked element (the web clipboard only allows a few MIME types; this is the common technique used by design tools);
  - `text/plain` with a human-readable form (the text of text and captions clips, or clip names);
  - on desktop, additionally a custom format `application/x-jasper-clipboard` through the Electron clipboard.
  An in-memory copy is kept too, so paste inside the same tab never depends on clipboard permissions.
- **CLB-003 (P0)** **Paste (Ctrl/Cmd+V) in the Timeline** — Premiere semantics:
  - Clips are pasted at the playhead in **overwrite** mode.
  - The lowest copied video track goes to the **lowest targeted** video track, and the lowest copied audio track to the lowest targeted audio track. Relative track offsets are kept.
  - Missing tracks are added (TRK-005).
  - The playhead moves to the end of the pasted content.
- **CLB-004 (P0)** **Paste Insert (Ctrl/Cmd+Shift+V)**: same placement, in insert mode (ripples, TRK-006).
- **CLB-005 (P1)** **Paste Attributes (Ctrl/Cmd+Alt+V)** opens a dialog with checkboxes: Motion, Opacity, Time Remapping (P2), Volume, Channel Volume, Panner, each effect by name, and "Scale attribute times" (stretch keyframes to the target clip's duration). It applies to all selected target clips as one transaction. **Remove Attributes** is the inverse.
- **CLB-006 (P0)** **Paste in Effect Controls:** effects are appended to the primary clip's stack. Keyframes are pasted at the playhead and must match the parameter type.
- **CLB-007 (P0)** **Paste in the Project panel:** project items are added to the selected bin. Sequences are deep-copied with new ids.
- **CLB-008 (P0)** **Resolution of referenced entities** on paste:
  - Media: find an asset in the target project with the same fingerprint → use it. Otherwise add the payload's asset record (new id), then resolve its locators (LIFE-030). On the same machine or browser origin this nearly always succeeds, because web storage is keyed by fingerprint. Otherwise the pasted clips are offline until relinked.
  - Synthetics, transcripts, fonts: same project and same id → reuse. Otherwise add copies with new ids.
  - All pasted entities get new ids (ID-005). Link and group membership is recreated inside the pasted set only.
- **CLB-009 (P0)** **Validation:** payloads are parsed with the zod schemas and size-capped at 20 MB. Unknown versions are rejected with a message. Nothing from the clipboard is trusted without validation.
- **CLB-010 (P0)** **External content:**
  - Files → import (LIFE-010), and place at the playhead if the Timeline is focused.
  - Image data (`image/png`) → imported as an image asset named "Pasted image <time>".
  - Plain text with the Timeline or Program monitor focused → a text clip at the playhead on the lowest targeted video track, 5 s long, centered.
- **CLB-011 (P0)** Cut = copy + `clip.lift` (Premiere's cut leaves a gap). Media assets stay in the project, so the paste resolves.
- **CLB-012 (P0)** Duplicate (Alt-drag, or the `clip.duplicate` command) uses the same remapping logic without the system clipboard.

Implementation decisions (wp-clipboard, `docs/wp-notes/wp-clipboard.md`):
- Pastes are the document commands `clip.paste`, `clip.pasteAttributes`, `clip.removeAttributes`, `effect.paste`, `keyframe.paste` and `project.pasteItems` (payload validated in the handler, one transaction each).
- Additive payload fields: `clips.{trackKinds, frameRate, primaryClipId}` (starts/durations convert to the target frame rate), `effects.source`, `keyframes.{tracks, speed}`, `items.rootItems`, `mediaItems`.
- A media record added by a paste gets a project item (root, or the target bin), except pure derivation sources and font files; a font with the same family and source in the target is reused.
- Ctrl/Cmd+V lets the browser fire its paste event (permission-free read of other tabs' copies); Edit ▸ Paste uses the async Clipboard API, then the in-memory copy. JasperEditor content on the system clipboard wins; the in-memory copy wins only when the last copy never reached the system clipboard.
- Paste Attributes adds M2 rows (text In/Out animation, text style, shape style); Time Remapping and Channel Volume are P2 (S03:DM-002) and have no row.
- Nested-sequence clips whose sequence is not in the target project are skipped (`W_CLIP_SKIPPED`); a pasted tracker target follows the pasted copy of its plate, else the original plate in the same sequence, else it loses the link.
- CLB-010 (wp-clipboard-2): foreign content goes through the same Paste commands (Ctrl/Cmd+V paste event, Edit ▸ Paste async Clipboard API; text fields keep their native paste). Files and image data are imported with the import pipeline (LIFE-010, one "Import N files" step; the duplicate and clip-mismatch prompts apply) into the selected/current bin, and placed at the playhead on the lowest targeted video/audio tracks (overwrite; Paste Insert inserts) when the Timeline **or the Program monitor** has the focus. A pasted File is image data (→ "Pasted image YYYY-MM-DD HH.MM.SS", uploaded as `.png`/`.jpg`…) when it is an image with the browser's generic name (`image.png`) and no file path; other files keep their names. Plain text (only when there are no files) becomes a `clip.addText` of the text (line ends unified, trailing blanks dropped, capped at 5,000 characters) on the lowest targeted unlocked video track, 5 s, default centred placement, one "Paste Text" step; Paste Insert of text and text pasted into other panels only explain. Desktop: pasted Files with a path (`webUtils.getPathForFile`) and the file manager's list (`text/uri-list`, `public.file-url`, `x-special/gnome-copied-files`, read and validated in main, also when the paste event carried no files) register in place (S04:IN-003, no upload). The web async Clipboard API exposes no files, so Edit ▸ Paste of files works on desktop only.
- Desktop copies write text/plain, text/html and the custom format in one Electron write (no parallel web write, which raced it); a native copy/cut event is answered with its own data and the Electron write follows it.

Beyond the template: the template copied only raw item objects without their assets (pasting into another project produced broken references), did not validate pasted data, always pasted onto new top layers, and had no paste-insert, paste-attributes, effect or keyframe clipboard, or project-item clipboard.

---

## 21. Agent control

### 21.1 Surfaces

- **AGT-001 (P0)** Agents drive the editor only through **commands, transactions and queries**. There is no other write path. Three surfaces share one implementation:
  1. **In-page bridge**: an object on the session, exposed as `window.jasper` in dev and Electron builds, and over `postMessage` for embedded agent panels. (wp-mcp: there is no embedded Agent panel; see ARCHITECTURE D-18 / §11.)
  2. **Engine relay**: the engine's WebSocket `/agent` endpoint forwards transactions and queries to the open session that holds the project lease, and relays results and events back. This is how external agents (MCP servers, CLI tools, the orquester daemon) reach a running editor. The shipped MCP server is `jasper-mcp` (`apps/mcp`, ARCHITECTURE §11.2); it is the supported agent entry point.
  3. **Headless**: when no session holds the lease, the engine loads the project and applies transactions itself with `project-model` (AGT-020).
- **AGT-002 (P0)** **Self-description:** `schema.get` returns the JSON Schemas of all commands and queries, the effect registry (ids, params, ranges, engine capabilities), the motion-graphic template library (ids, versions, param schemas, preview thumbnails), the registered compositions, the sequence presets, and the error codes. Agents never need to guess shapes.

### 21.2 Queries (read-only, no history)

| Query | Returns |
|---|---|
| `doc.get` | The whole document, or a subtree by path (`["sequences", "seq_…"]`). Supports `fields` projection. |
| `doc.revision` | The current revision. |
| `sequence.summary` | Settings, duration, tracks (label, kind, lock, mute…), clip counts, markers, In/Out. |
| `sequence.clipsInRange` | Clips intersecting `[from, to)` on given tracks, with resolved timing: start, end, source range in seconds, speed, link partners. |
| `sequence.at` | What is visible and audible at a frame: the clip stack bottom to top, evaluated property values (keyframes applied). |
| `clip.resolve` | One clip with every animatable property evaluated at given times, plus effect list and warnings (offline, out of sync, missing effect). |
| `media.list` / `media.get` | Assets with probe summaries and runtime status (availability, proxy, derived state). |
| `media.analysis` | Engine analyses for an asset (silences, scenes, loudness, transcript ids), starting the job if needed and returning a job id. |
| `selection.get` / `playhead.get` | Session state (read-only, SEL-009). |
| `history.list` | Entries with labels, origins and revisions. |
| `frame.capture` | A still of the Program output at a frame (PNG, max 1280 px) so vision-capable agents can check their work. |
| `validate` | The invariant report for the current document or for a dry-run transaction. |

### 21.3 Writes and events

- **AGT-003 (P0)** Writes are transactions (CMD-005) with `origin: {agent, runId}`. One agent step = one transaction = one undo entry (UND-007). Agents SHOULD use `dryRun: true` first for large edits, and `expectedRevision` always.
- **AGT-004 (P0)** **Events:** subscribers receive `{type: 'doc.changed', revision, label, origin, created, changed, deleted}` for every commit (including undo/redo, flagged as such), plus `selection.changed`, `playhead.changed` (throttled to 10 Hz), `media.status`, `job.progress`, `job.done`. Agents use these to stay in sync without polling.
- **AGT-005 (P0)** **Addressing helpers** so agents do not need to compute ids: track labels (`"V2"`), `"$selection"`, time forms (TIME-006), media by project item name when unique (`{ "mediaByName": "interview_A.mov" }`, which fails with `E_AMBIGUOUS` if not unique).
- **AGT-006 (P0)** **Media for agents:** `media.import` takes `{path}` (engine-side file), `{url}` or `{uploadToken}` (a file the user dropped into the chat panel) and runs LIFE-010. It is a job: the result arrives as an event with the new asset ids, and agents then place clips with a normal transaction.

### 21.4 Concurrency, safety and UX

- **AGT-010 (P0)** **Optimistic concurrency:** a transaction whose `expectedRevision` is older than the current revision is rejected with `E_REVISION_MISMATCH` and the list of entities changed since, **unless** none of the entities the transaction touches (read or write) changed. In that case it is applied (a fast-forward). The user always wins: user gestures are never rejected because of an agent.
- **AGT-011 (P0)** **Guard rails:**
  - Agents cannot delete a project or a sequence, remove media, or run `force` commands without the user's approval. The bridge asks the user with a confirmation dialog that summarizes the transaction, unless the user granted that capability for the session.
  - Limits per transaction: 5,000 commands, 20 MB payload.
  - Agents cannot inject code: composition clips only reference registered compositions (KND-010). Custom fframes source (KND-009, P2) is compiled only in the engine sandbox, never in the browser.
- **AGT-012 (P0)** **Visibility:** agent commits flash the changed clips on the timeline, appear in History with the agent's name, and can leave `agent-note` markers (SEQ-008) as explanations. The user can undo any agent step with one Ctrl+Z.
- **AGT-013 (P1)** **Agent lock:** while an agent run is marked "exclusive" (for example, a long auto-edit), the UI shows a banner and user edits queue until the run releases or the user cancels it (cancelling rolls back nothing: every agent step already committed stays undoable).

### 21.5 Headless mode

- **AGT-020 (P1)** Headless edits in the engine use the same command handlers. Things that need a browser are deferred: text layout (`layoutPending`, KND-006) and browser-decodability probing. Headless sessions write through `ProjectStore` with normal revisions and leases, so an editor opened later sees the changes as a newer revision.

Beyond the template: the template had no programmatic API. Nothing outside the React tree could change the document, there were no events, no schemas for agents, no concurrency control and no notion of agent-authored history.

---

## 22. Render snapshot contract (interface to the three engines)

The rendering and export specs define the pipelines. This section defines what the model hands them.

- **RND-001 (P0)** `buildRenderSnapshot(document, sequenceId, options) → RenderSnapshot` is a pure function in `project-model`. The snapshot is a self-contained, immutable JSON value:
  - the sequence settings;
  - only the tracks that contribute (video tracks with output on, audio tracks after solo/mute resolution; locked tracks are included since locking does not affect output);
  - enabled clips only, resolved into render-ready form: timeline range, content range, speed, the source reference resolved to a **runtime media handle** (supplied by the caller from `MediaRuntime`, choosing proxy or original per `options.useProxies`);
  - keyframe tracks (evaluated per frame by the renderers with the shared evaluator, KF-009);
  - the effect stack with registry version checks;
  - transitions with computed handle behavior;
  - captions with **precomputed segmentation** (KND-008);
  - text with its declared box and style;
  - nested sequences as embedded sub-snapshots;
  - per-range engine affinity (SES-010).
- **RND-002 (P0)** The Remotion composition receives the snapshot as input props (the Player in the browser and `@remotion/renderer` in the engine use the same composition package). `fps = num/den`, and the composition duration is the sequence duration (or In/Out range for exports).
- **RND-003 (P0)** The native exporter consumes the same snapshot and plans segments: ranges with only media, cuts and native-capable effects go through one ffmpeg graph. Ranges with text, captions, compositions or motion graphics get alpha intermediates from Remotion or fframes (masters, LIFE-045) and are composited natively (`docs/research/native-video-libraries.md` §6).
- **RND-004 (P0)** A snapshot never contains machine paths for web clients or blob URLs for engine renders: media handles are supplied per consumer by the caller.
- **RND-005 (P0)** Z-order: video tracks composite from V1 (bottom) upward; within the same frame a track has at most one clip; adjustment clips apply at their track level; caption tracks composite above all video tracks.

---

## 23. Where we go beyond the template (summary)

| Area | Template behavior | JasperEditor |
|---|---|---|
| Project structure | One implicit project, one composition, no bins | Many projects, bins, many sequences, nesting (P1) |
| Tracks | Untyped, auto-deleted when empty, any item anywhere | Premiere V1..Vn / A1..An / caption tracks, persistent, lock, sync lock, output, mute, solo, volume, pan |
| A/V | One item carries picture and sound | Linked video + audio clips, out-of-sync detection, multi-channel mapping |
| Time | One fixed frame rate; float seconds for offsets | Rational rates incl. NTSC and drop-frame timecode; integer frames and flicks |
| Editing semantics | No overlaps; auto-place on new tracks | Overwrite/insert, ripple, roll, slip, slide, lift/extract, sync-lock rippling |
| Clip kinds | 7 fixed kinds | Adds fframes motion graphics, registered Remotion compositions, nests, adjustment layers, synthetic sources, derived (native-processed) media |
| Properties | Static box, opacity, fades | Premiere Motion (position/anchor/scale/rotation), opacity, blend modes, effect stacks with engine capability flags, full keyframing with easing |
| Transitions | None (fixed fades) | Transitions at edit points and one-sided fades, handle rules |
| Audio | Per-item volume, track mute | Clip gain + keyframed volume + pan, clip/track/master effects, solo, master bus |
| Captions | Opaque caption list | Editable transcripts with word timings, deterministic segmentation shared by preview/export/SRT |
| Commands | Direct function calls | Serializable, validated, atomic transactions with error codes, dry-run, temp refs |
| Undo | 50 snapshots, first change not undoable, background drift | Labeled, coalesced, origin-aware history with selection restore and system-fact rebasing |
| Persistence | One localStorage slot, manual save, blocked by uploads | Multi-project store (IndexedDB+OPFS / `.jasper` files / remote engine), autosave, versions, crash journal, leases, migrations |
| Media | Cloud upload + browser cache | Local-first, fingerprinted, deduplicated, relinkable, offline-tolerant; native proxies, thumbnails, waveforms, analyses |
| Clipboard | Items only, unvalidated | Self-contained validated payloads, Premiere paste/paste-insert/paste-attributes, cross-project resolution |
| Agents | None | Bridge + engine relay + headless, schemas, queries, events, concurrency control, guard rails |

## 24. Deferred and non-goals for v1

- Time remapping (CLP-009), spatial motion paths (KF-008), masks (FX-025), source effects (FX-026): reserved, P2.
- Multicam, interlaced footage, non-square pixels, 5.1 audio, HDR working color spaces: P2.
- Real-time collaboration (multi-writer): not planned. The revision/lease model allows single-writer plus agents. A future CRDT would replace the snapshot history.
- Persisting undo history across sessions: not planned (UND-011).
- Letting users upload their own Remotion component code: forbidden by license (KND-010).

## 25. Acceptance criteria

Each item is an automated test in `packages/project-model` (unit or property tests) unless marked UI or E2E.

| # | Scenario | Expected |
|---|---|---|
| AC-01 | New project from the "1080p 29.97" preset (NTSC presets default to drop-frame) | Sequence with `{30000,1001}`, `dropFrame: true`, V1–V3, A1–A3, empty. Timecode of frame 1800 is `00;01;00;02`. |
| AC-02 | Place a 10 s 1080p video with stereo audio at frame 0, overwrite, V1/A1 | One video clip on V1 and one audio clip on A1, same link group, `sourceIn` 0, duration 300 at 30 fps. One undo entry. |
| AC-03 | Overwrite a 2 s clip into the middle of AC-02's clips | Existing clips are split around it. No overlaps. Linked audio is split the same way. |
| AC-04 | Insert the same clip at frame 60 with sync lock on for all tracks | Everything at/after frame 60 on all tracks shifts by the inserted duration. A clip on V2 spanning frame 60 is split. |
| AC-05 | Ripple trim with a locked, sync-locked track that would need to shift | Transaction rejected with `E_SYNC_LOCKED_TRACK`. Document unchanged. |
| AC-06 | Split a keyframed clip, then trim the right part's head by 10 frames | Both parts keep all keyframes. On-screen values at every frame are identical to before the split. |
| AC-07 | Change a 30 fps sequence to 25 fps | Adjacent clips stay adjacent. Keyframe animation still aligns with the same picture. A 1-frame clip that collapses is removed with `W_CLIP_COLLAPSED`. |
| AC-08 | Keyframe evaluation | Linear at u = 0.5 gives the midpoint. "Easy Ease" gives p(0.5) = 0.5 and p'(0) = 0. Hold gives a step. Auto-bezier on a local maximum gives no overshoot. |
| AC-09 | Agent transaction of 3 commands where the 3rd fails | Nothing applied. Error names `commandIndex: 2`. Revision unchanged. |
| AC-10 | Agent transaction with temp refs creating a text clip and adding a blur to it | Succeeds. `refs` maps the temp ref to the new `clp_` id. One undo entry labeled `Agent: …`. |
| AC-11 | Agent submits with a stale `expectedRevision` touching a clip the user just moved | `E_REVISION_MISMATCH` listing that clip. With an untouched clip, it fast-forwards. |
| AC-12 | Undo right after opening and making one change | Returns to the opened state. Redo reapplies. Selection restored both ways. |
| AC-13 | Drag a clip across 120 pointer moves, then release | Exactly one undo entry. Autosave did not run during the drag. Esc during a drag leaves no entry. |
| AC-14 | Copy two linked clips + a text clip, paste into another project in the same browser | Media resolves by fingerprint (online). New ids everywhere. Link group recreated. Text clip keeps its font reference. |
| AC-15 | Paste a payload whose referenced media is missing on this machine | Clips pasted as offline. The Project panel shows the media as offline. Relinking a file with the same fingerprint brings them online without a new undo entry for the clips. |
| AC-16 | Import the same file twice into one project (web) | One media asset, two project items, bytes stored once. |
| AC-17 | Import a ProRes file in the browser with an engine connected | Accepted; proxy forced; clips play the proxy when ready; export uses the original. |
| AC-18 | Kill the desktop app during autosave | On restart, the project file is either the old or the new version (never torn). The journal offers to replay any later commits. |
| AC-19 | Open the same project in two tabs | Second tab is read-only with "Take over editing". |
| AC-20 | Load a file with overlapping clips (corrupted) | Opens with a repair report. The later clip is moved to a new track. |
| AC-21 | Delete a media item used in 2 sequences (UI) | Confirmation lists 2 sequences. On confirm, clips are removed in one undo entry. Bytes are kept until GC after close. |
| AC-22 | Create a motion-graphic clip, change a param, undo, redo | The render key after redo equals the one before undo. No new render job (cache hit). |
| AC-23 | Captions from a transcript, then edit a word | Preview, export and SRT show the same segmentation and the corrected word. |
| AC-24 | Document with an unknown effect id and an unknown clip kind (future version) | Opens. Effect bypassed with "Missing effect". Clip shown as unsupported. Saving keeps both unchanged. |
| AC-25 | Invariants hold under random command fuzzing (property test: 10,000 random valid transactions) | Every committed document passes INV-001–INV-015. Every rejected transaction leaves the document reference unchanged. |
| AC-26 | Performance (SES-011, DOC-006) on the reference machine | Within the stated budgets. Benchmarked in CI. |

---

## Appendix A: Example document (abridged)

```json
{
  "schemaVersion": 1,
  "projectId": "prj_7K2M9Q4TZ8W1RJ5N",
  "name": "Launch video",
  "settings": {
    "defaultSequencePreset": "hd-1080p-30",
    "mediaPolicy": { "copyOnImport": false },
    "proxyPolicy": { "mode": "auto", "preset": "h264-720p",
                     "autoWhen": { "minHeight": 2160, "codecs": ["prores", "dnxhd", "hevc"], "bitDepthAbove": 8 } },
    "defaultStillDurationFrames": 150,
    "defaultTransitionFrames": 30,
    "defaultScaling": "fit-if-larger"
  },
  "rootItems": ["itm_0A1B2C3D4E5F6G7H", "itm_1H2J3K4M5N6P7Q8R"],
  "items": {
    "itm_0A1B2C3D4E5F6G7H": { "id": "itm_0A1B2C3D4E5F6G7H", "kind": "media", "name": "interview_A.mov",
      "mediaId": "med_9X8W7V6T5S4R3Q2P", "label": "iris", "marks": { "in": null, "out": null } },
    "itm_1H2J3K4M5N6P7Q8R": { "id": "itm_1H2J3K4M5N6P7Q8R", "kind": "sequence", "name": "Main",
      "sequenceId": "seq_4D5E6F7G8H9J0K1M", "label": "forest" }
  },
  "media": {
    "med_9X8W7V6T5S4R3Q2P": {
      "id": "med_9X8W7V6T5S4R3Q2P", "kind": "video",
      "fingerprint": "q1:3f1c…e9", "originalName": "interview_A.mov", "sizeBytes": 734003200,
      "container": "mov,mp4",
      "probe": { "durationFlicks": 42336000000, "startTimecode": "10:00:00:00", "rotationDegrees": 0,
                 "hasAlpha": false, "variableFrameRate": false,
                 "streams": [
                   { "index": 0, "type": "video", "codec": "h264", "width": 1920, "height": 1080,
                     "pixelAspect": { "num": 1, "den": 1 }, "frameRate": { "num": 30, "den": 1 },
                     "pixelFormat": "yuv420p", "bitDepth": 8,
                     "color": { "primaries": "bt709", "transfer": "bt709", "matrix": "bt709", "range": "tv" },
                     "browserDecodable": true },
                   { "index": 1, "type": "audio", "codec": "aac", "sampleRate": 48000, "channels": 2,
                     "channelLayout": "stereo" } ] },
      "locators": [ { "type": "path", "path": "/home/jasper/footage/interview_A.mov",
                      "relativeToProject": "../footage/interview_A.mov" } ],
      "derivation": null, "importedAt": "2026-09-30T09:58:12.000Z"
    }
  },
  "synthetics": {}, "transcripts": {}, "fonts": {
    "fnt_2B3C4D5E6F7G8H9J": { "id": "fnt_2B3C4D5E6F7G8H9J", "family": "Inter", "source": { "type": "bundled" } } },
  "sequences": {
    "seq_4D5E6F7G8H9J0K1M": {
      "id": "seq_4D5E6F7G8H9J0K1M",
      "settings": { "frameRate": { "num": 30, "den": 1 }, "width": 1920, "height": 1080,
                    "pixelAspect": { "num": 1, "den": 1 }, "dropFrame": false, "startTimecodeFrames": 0,
                    "audioSampleRate": 48000, "masterLayout": "stereo",
                    "backgroundColor": [0, 0, 0, 1], "workingColorSpace": "rec709" },
      "videoTracks": [
        { "id": "trk_V1AAAAAAAAAAAAAA", "kind": "video", "name": null, "locked": false, "syncLock": true, "output": true },
        { "id": "trk_V2AAAAAAAAAAAAAA", "kind": "video", "name": null, "locked": false, "syncLock": true, "output": true }
      ],
      "audioTracks": [
        { "id": "trk_A1AAAAAAAAAAAAAA", "kind": "audio", "name": null, "locked": false, "syncLock": true,
          "mute": false, "solo": false, "volumeDb": { "value": 0, "keyframes": [] },
          "pan": { "value": 0, "keyframes": [] }, "channelFormat": "stereo", "effects": [] }
      ],
      "captionTracks": [],
      "master": { "volumeDb": { "value": 0, "keyframes": [] }, "effects": [] },
      "clips": {
        "clp_VID0000000000001": {
          "id": "clp_VID0000000000001", "kind": "video", "trackId": "trk_V1AAAAAAAAAAAAAA",
          "start": 0, "duration": 300, "sourceIn": 1411200000,
          "speed": { "rate": 1, "reverse": false, "maintainPitch": true },
          "name": "interview_A.mov", "label": "iris", "enabled": true,
          "linkId": "lnk_0000000000000001", "groupId": null, "markers": [],
          "mediaId": "med_9X8W7V6T5S4R3Q2P", "videoStreamIndex": 0,
          "transform": {
            "position": { "value": [960, 540], "keyframes": [] },
            "anchor": { "value": [960, 540], "keyframes": [] },
            "scale": { "value": 100, "keyframes": [
              { "id": "kf_0000000000000001", "time": 1411200000, "value": 100, "interpolation": "bezier",
                "easeIn": { "influence": 0.3333, "slope": 1 }, "easeOut": { "influence": 0.3333, "slope": 0 } },
              { "id": "kf_0000000000000002", "time": 5644800000, "value": 115, "interpolation": "bezier",
                "easeIn": { "influence": 0.3333, "slope": 0 }, "easeOut": { "influence": 0.3333, "slope": 1 } } ] },
            "scaleWidth": { "value": 100, "keyframes": [] }, "uniformScale": true,
            "rotation": { "value": 0, "keyframes": [] }, "flipH": false, "flipV": false
          },
          "opacity": { "value": 100, "keyframes": [] }, "blendMode": "normal", "effects": []
        },
        "clp_AUD0000000000001": {
          "id": "clp_AUD0000000000001", "kind": "audio", "trackId": "trk_A1AAAAAAAAAAAAAA",
          "start": 0, "duration": 300, "sourceIn": 1411200000,
          "speed": { "rate": 1, "reverse": false, "maintainPitch": true },
          "name": "interview_A.mov", "label": "iris", "enabled": true,
          "linkId": "lnk_0000000000000001", "groupId": null, "markers": [],
          "mediaId": "med_9X8W7V6T5S4R3Q2P", "channels": { "streamIndex": 1, "map": [0, 1] },
          "gainDb": 0, "volumeDb": { "value": 0, "keyframes": [] }, "pan": { "value": 0, "keyframes": [] },
          "effects": []
        },
        "clp_MG00000000000001": {
          "id": "clp_MG00000000000001", "kind": "motion-graphic", "trackId": "trk_V2AAAAAAAAAAAAAA",
          "start": 30, "duration": 150, "sourceIn": 0,
          "speed": { "rate": 1, "reverse": false, "maintainPitch": false },
          "name": "Lower third", "label": "mango", "enabled": true, "linkId": null, "groupId": null, "markers": [],
          "template": { "id": "lower-third", "version": 1 },
          "params": { "title": "Ana Ruiz", "subtitle": "Head of Product", "accent": [0.27, 0.6, 1, 1] },
          "canvas": "sequence",
          "transform": { "position": { "value": [960, 540], "keyframes": [] }, "anchor": { "value": [960, 540], "keyframes": [] },
                         "scale": { "value": 100, "keyframes": [] }, "scaleWidth": { "value": 100, "keyframes": [] },
                         "uniformScale": true, "rotation": { "value": 0, "keyframes": [] }, "flipH": false, "flipV": false },
          "opacity": { "value": 100, "keyframes": [] }, "blendMode": "normal", "effects": []
        }
      },
      "transitions": {
        "trn_0000000000000001": { "id": "trn_0000000000000001", "trackId": "trk_V1AAAAAAAAAAAAAA",
          "effectId": "jasper.dip-to-black", "effectVersion": 1, "outgoingClipId": null,
          "incomingClipId": "clp_VID0000000000001", "duration": 15, "alignment": "start-at-cut", "params": {} }
      },
      "links": { "lnk_0000000000000001": { "id": "lnk_0000000000000001",
                 "members": ["clp_VID0000000000001", "clp_AUD0000000000001"] } },
      "groups": {},
      "markers": [ { "id": "mrk_0000000000000001", "frame": 120, "duration": 0, "name": "Jump cut?",
                     "comment": "Consider a B-roll here.", "color": "yellow", "type": "agent-note",
                     "author": { "agent": "editor-assistant" } } ],
      "inPoint": null, "outPoint": null, "workArea": null
    }
  },
  "extensions": {}
}
```

(`sourceIn: 1411200000` flicks = 2.0 s into the file. The two scale keyframes sit at content times 2 s and 8 s, which are timeline frames 0 and 180. `RGBA` values are straight sRGB floats 0..1 in the order R, G, B, A. `LinkGroup = {id, members}` and `ClipGroup = {id, members}`.)

## Appendix B: Example agent transaction

```json
{
  "protocol": "jasper.tx/1",
  "label": "Add title and fade in",
  "origin": { "agent": "editor-assistant", "runId": "run_42" },
  "expectedRevision": 412,
  "sequenceId": "seq_4D5E6F7G8H9J0K1M",
  "commands": [
    { "type": "clip.addText", "ref": "$title", "at": "00:00:01:00", "duration": { "seconds": 4 }, "track": "V2",
      "content": { "text": "Launch Day", "style": { "fontId": "fnt_2B3C4D5E6F7G8H9J", "weight": 700, "italic": false,
        "sizePx": 120, "lineHeight": 1.1, "trackingEm": 0, "align": "center", "direction": "auto",
        "fill": [1, 1, 1, 1], "strokes": [], "background": null, "shadow": null, "allCaps": false } },
      "box": { "width": 1400, "height": 160, "autoSize": "height" } },
    { "type": "param.setAnimated", "target": ["clip", "$title", "opacity"], "animated": true, "at": { "frames": 0 } },
    { "type": "param.set", "target": ["clip", "$title", "opacity"], "value": 0, "at": { "frames": 0 } },
    { "type": "param.set", "target": ["clip", "$title", "opacity"], "value": 100, "at": { "frames": 15 } },
    { "type": "marker.add", "frame": 30, "name": "Title added", "markerType": "agent-note", "comment": "Fades in over 0.5 s." }
  ]
}
```

(`at` in `param.set` / `param.setAnimated` is clip-relative when given as frames (CMD-013). Commands name the marker's type `markerType` so it does not clash with the command's own `type` field.)
